import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { convert } from 'html-to-text';
import { DateTime } from 'luxon';
import { simpleParser } from 'mailparser';
import { CONFIG, Config, decrypt, encrypt, hash, token } from './config.js';
import { Database } from './db.js';
import { timezone } from './extraction.js';
import { GmailExtraction } from './gmail-extraction.js';
import { finishGmailDelivery, GmailResults, messageIdPattern } from './gmail-results.js';

const gmailScope = 'https://www.googleapis.com/auth/gmail.readonly';
const gmailRoot = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const tokenUrl = 'https://oauth2.googleapis.com/token';
const maxRawSize = 1_500_000;
const maxReprocessAttempts = 5;

class GoogleError extends Error {
  constructor(readonly status: number, readonly code?: string) {
    super('Google request failed');
  }
}

async function google<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(8000), redirect: 'error' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new GoogleError(response.status, typeof body.error === 'string' ? body.error : body.error?.status);
  return body as T;
}

type Profile = { emailAddress: string; historyId: string };
type RawMessage = { id: string; raw: string; internalDate: string; labelIds?: string[]; snippet?: string };
type Tokens = { access_token: string; refresh_token?: string; scope?: string; expires_in?: number };
type History = { historyId: string; nextPageToken?: string; history?: { messagesAdded?: { message: { id: string } }[] }[] };
type Messages = { messages?: { id: string }[]; nextPageToken?: string };
type OAuthState = { verifier: string; expected_mailbox: string | null };
type Mailbox = {
  id: string; account_id: string; email: string; source: 'n8n' | 'oauth';
  state: 'active' | 'reconnect' | 'disconnected'; secret: string | null;
  history_id: string | null; linked_at: Date; last_synced_at: Date | null; sync_lease: string | null;
  generation: string;
  openai_consented_at: Date | null;
};
type Job = Mailbox & { delivery_id: string; message_id: string; attempts: number; reprocess_id: string | null;
  from_at: Date | null; to_at: Date | null };
type Scan = Mailbox & { run_id: string; from_at: Date; to_at: Date; page_token: string | null; scan_attempts: number };
type Access = { token: string; expiresAt: number };
const isRevoked = (error: unknown) => error instanceof GoogleError && (error.code === 'invalid_grant' || error.status === 401);
const messageIds = (ids: string[]) => [...new Set(ids.filter(id => typeof id === 'string' && messageIdPattern.test(id)))];

@Injectable()
export class Gmail {
  private readonly accessTokens = new Map<string, { generation: string; access: Promise<Access> }>();

  constructor(
    @Inject(Database) private readonly db: Database, @Inject(CONFIG) private readonly config: Config,
    @Inject(GmailExtraction) private readonly extraction: GmailExtraction,
    @Inject(GmailResults) private readonly results: GmailResults,
  ) {}

  async list(accountId: string) {
    const { rows } = await this.db.query(
      'SELECT m.id,m.email,m.source,m.state,m.linked_at,m.last_synced_at,m.openai_consented_at IS NOT NULL AS openai_enabled,' +
      "($2::boolean AND m.source='oauth') AS openai_available," +
      'CASE WHEN r.id IS NOT NULL THEN jsonb_build_object(' +
      "'from',r.from_at,'to',r.to_at,'finishedAt',r.finished_at,'failure',r.failure,'summary',COALESCE(r.summary,s.summary)," +
      "'scanning',r.scan_finished_at IS NULL,'queued',q.total,'retrying',q.attempted) END AS reprocess " +
      'FROM mailboxes m LEFT JOIN LATERAL (SELECT * FROM gmail_reprocess_runs ' +
      'WHERE mailbox_id=m.id ORDER BY started_at DESC LIMIT 1) r ON true ' +
      'LEFT JOIN LATERAL (SELECT jsonb_object_agg(outcome,total) AS summary FROM (' +
      'SELECT outcome,count(*)::int AS total FROM gmail_reprocess_results WHERE run_id=r.id GROUP BY outcome) totals) s ON r.finished_at IS NULL ' +
      'LEFT JOIN LATERAL (SELECT count(*)::int AS total,count(*) FILTER (WHERE attempts>0)::int AS attempted ' +
      'FROM gmail_deliveries WHERE reprocess_id=r.id AND completed_at IS NULL) q ON r.finished_at IS NULL ' +
      'WHERE m.account_id=$1 ORDER BY m.linked_at DESC',
      [accountId, Boolean(this.config.OPENAI_API_KEY)],
    );
    return rows;
  }

  async setOpenAi(accountId: string, mailboxId: string, enabled: boolean) {
    if (enabled && !this.config.OPENAI_API_KEY) {
      throw new ServiceUnavailableException('OpenAI aún no está configurado en el servidor.');
    }
    const changed = await this.db.query(
      "UPDATE mailboxes SET openai_consented_at=CASE WHEN $3 THEN COALESCE(openai_consented_at,now()) END " +
      "WHERE id=$1 AND account_id=$2 AND source='oauth' AND (NOT $3 OR state='active')",
      [mailboxId, accountId, enabled],
    );
    if (!changed.rowCount) throw new NotFoundException('Buzón de Gmail activo no encontrado.');
  }

  async reprocessMonth(accountId: string, mailboxId: string) {
    this.requireOAuth();
    return this.db.transaction(async client => {
      const { rows: [mailbox] } = await client.query<Pick<Mailbox, 'source' | 'state'>>(
        'SELECT source,state FROM mailboxes WHERE id=$1 AND account_id=$2 FOR UPDATE', [mailboxId, accountId],
      );
      if (!mailbox) throw new NotFoundException('Buzón no encontrado.');
      if (mailbox.source !== 'oauth' || mailbox.state !== 'active') {
        throw new ConflictException('Vincula el buzón con Google para revisar correos anteriores.');
      }
      const { rows: [running] } = await client.query<{ id: string }>(
        'SELECT id FROM gmail_reprocess_runs WHERE mailbox_id=$1 AND finished_at IS NULL', [mailboxId],
      );
      if (running) return running;
      const now = DateTime.now().setZone(timezone);
      const from = now.startOf('month');
      const { rows: [run] } = await client.query<{ id: string }>(
        'INSERT INTO gmail_reprocess_runs (mailbox_id,from_at,to_at) VALUES ($1,$2,$3) RETURNING id',
        [mailboxId, from.toJSDate(), now.toMillis() === from.toMillis() ? now.plus({ milliseconds: 1 }).toJSDate() : now.toJSDate()],
      );
      return run!;
    });
  }

  async connectLegacy(accountId: string, accountEmail: string) {
    const address = this.config.LEGACY_GMAIL_ADDRESS?.toLowerCase();
    if (!address || address !== accountEmail) throw new NotFoundException('Buzón no disponible para esta cuenta.');
    const result = await this.db.query(
      "INSERT INTO mailboxes (account_id,email,source,state) VALUES ($1,$2,'n8n','active') " +
      "ON CONFLICT (email) DO UPDATE SET state='active',linked_at=CASE WHEN mailboxes.state='active' THEN mailboxes.linked_at ELSE now() END, " +
      "generation=CASE WHEN mailboxes.state='active' THEN mailboxes.generation ELSE gen_random_uuid() END " +
      "WHERE mailboxes.account_id=excluded.account_id AND mailboxes.source='n8n' RETURNING id,email,source,state",
      [accountId, address],
    );
    if (!result.rowCount) throw new ConflictException('Ese buzón ya tiene una vinculación OAuth.');
    return result.rows[0];
  }

  async authorize(accountId: string, session: string, mailboxId?: string, mobile = false) {
    this.requireOAuth();
    if (mobile && !this.config.secure) {
      throw new ServiceUnavailableException('La vinculación móvil de Gmail requiere HTTPS.');
    }
    if (mailboxId) {
      const mailbox = await this.find(accountId, mailboxId);
      if (mailbox.source !== 'oauth') throw new BadRequestException('Este buzón se administra desde n8n.');
    }
    const state = token();
    const verifier = token();
    const encryptedVerifier = encrypt(verifier, this.config.encryptionKey);
    if (mobile) {
      await this.db.query(
        'INSERT INTO mobile_gmail_oauth (state_hash,session_hash,verifier,expected_mailbox,expires_at) ' +
        "VALUES ($1,$2,$3,$4,now()+interval '10 minutes')",
        [hash(state), session, encryptedVerifier, mailboxId ?? null],
      );
    } else {
      await this.db.query(
        "INSERT INTO oauth_states VALUES ($1,$2,$3,$4,$5,now()+interval '10 minutes')",
        [hash(state), accountId, session, encryptedVerifier, mailboxId ?? null],
      );
    }
    const params = new URLSearchParams({
      client_id: this.config.GOOGLE_CLIENT_ID!, redirect_uri: this.redirectUri(mobile),
      response_type: 'code', access_type: 'offline', prompt: 'consent select_account',
      state, scope: gmailScope, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    });
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + params;
  }

  async callback(accountId: string, session: string, state: string, code: string) {
    this.requireOAuth();
    const result = await this.db.query<OAuthState>(
      'DELETE FROM oauth_states WHERE token_hash=$1 AND account_id=$2 AND session_hash=$3 AND expires_at>now() ' +
      'RETURNING verifier,expected_mailbox', [hash(state), accountId, session],
    );
    const authorization = result.rows[0];
    if (!authorization) throw new BadRequestException('La solicitud OAuth expiró o es inválida.');
    await this.link(accountId, session, authorization, code, false);
  }

  async mobileCallback(state: string, code?: string) {
    this.requireOAuth();
    const active = 'state_hash=$1 AND expires_at>now() AND receipt_hash IS NULL ' +
      'AND EXISTS (SELECT 1 FROM sessions s WHERE s.token_hash=session_hash AND s.expires_at>now())';
    if (!code) {
      const cancelled = await this.db.query('DELETE FROM mobile_gmail_oauth WHERE ' + active, [hash(state)]);
      if (!cancelled.rowCount) throw new BadRequestException('La solicitud OAuth expiró o es inválida.');
      return null;
    }
    const receipt = token();
    const updated = await this.db.query(
      "UPDATE mobile_gmail_oauth SET receipt_hash=$2,encrypted_code=$3,expires_at=LEAST(expires_at,now()+interval '2 minutes') WHERE " + active,
      [hash(state), hash(receipt), encrypt(code, this.config.encryptionKey)],
    );
    if (!updated.rowCount) throw new BadRequestException('La solicitud OAuth expiró o es inválida.');
    return receipt;
  }

  async completeMobile(accountId: string, session: string, receipt: string) {
    this.requireOAuth();
    const { rows: [authorization] } = await this.db.query<OAuthState & { encrypted_code: string }>(
      'DELETE FROM mobile_gmail_oauth WHERE receipt_hash=$1 AND session_hash=$2 AND expires_at>now() ' +
      'RETURNING verifier,expected_mailbox,encrypted_code', [hash(receipt), session],
    );
    if (!authorization) throw new BadRequestException('El comprobante de vinculación expiró o es inválido.');
    await this.link(accountId, session, authorization, decrypt(authorization.encrypted_code, this.config.encryptionKey), true);
  }

  private async link(accountId: string, session: string, authorization: OAuthState, code: string, mobile: boolean) {
    const started = new Date();
    let tokens: Tokens;
    let profile: Profile;
    try {
      tokens = await this.exchange({
        grant_type: 'authorization_code', code, redirect_uri: this.redirectUri(mobile),
        code_verifier: decrypt(authorization.verifier, this.config.encryptionKey),
      });
      if (!tokens.refresh_token || !tokens.scope?.split(' ').includes(gmailScope)) {
        throw new BadRequestException('Google debe conceder permiso de lectura y acceso sin conexión.');
      }
      profile = await this.request<Profile>('profile', tokens.access_token);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('Google no pudo completar la vinculación. Inicia el proceso de nuevo.');
    }
    const address = profile.emailAddress.toLowerCase();
    if (address === this.config.LEGACY_GMAIL_ADDRESS?.toLowerCase()) {
      throw new ConflictException('El buzón actual se vincula mediante su conexión existente en n8n.');
    }
    if (authorization.expected_mailbox && (await this.find(accountId, authorization.expected_mailbox)).email !== address) {
      throw new ConflictException('Selecciona el mismo buzón al reconectar.');
    }
    await this.db.transaction(async client => {
      const valid = await client.query(
        'SELECT 1 FROM sessions WHERE token_hash=$1 AND account_id=$2 AND expires_at>now() FOR SHARE',
        [session, accountId],
      );
      if (!valid.rowCount) throw new UnauthorizedException('Inicia sesión para continuar.');
      const { rows: [saved] } = await client.query<{ id: string; generation: string }>(
        "INSERT INTO mailboxes (account_id,email,source,state,secret,history_id,linked_at,last_synced_at) " +
        "VALUES ($1,$2,'oauth','active',$3,$4,$5,$5) " +
        "ON CONFLICT (email) DO UPDATE SET state='active',secret=excluded.secret, " +
        "history_id=CASE WHEN mailboxes.state='disconnected' THEN excluded.history_id ELSE COALESCE(mailboxes.history_id,excluded.history_id) END, " +
        "linked_at=CASE WHEN mailboxes.state='disconnected' THEN excluded.linked_at ELSE mailboxes.linked_at END, " +
        "last_synced_at=CASE WHEN mailboxes.state='disconnected' THEN excluded.last_synced_at ELSE mailboxes.last_synced_at END, " +
        "sync_due_at=now(),sync_lease=null,generation=gen_random_uuid() " +
        "WHERE mailboxes.account_id=excluded.account_id AND mailboxes.source='oauth' RETURNING id,generation",
        [accountId, address, encrypt(tokens.refresh_token!, this.config.encryptionKey), profile.historyId, started],
      );
      if (!saved) throw new ConflictException('El buzón ya está asociado a otra cuenta.');
      await client.query(
        'UPDATE gmail_deliveries SET generation=$2,attempt_id=NULL,received_at=NULL,attempts=0,due_at=now() ' +
        'WHERE mailbox_id=$1 AND generation<>$2 AND completed_at IS NULL', [saved.id, saved.generation],
      );
    });
  }

  async disconnect(accountId: string, id: string) {
    const mailbox = await this.db.transaction(async client => {
      const result = await client.query<Mailbox>('SELECT * FROM mailboxes WHERE id=$1 AND account_id=$2 FOR UPDATE', [id, accountId]);
      const row = result.rows[0];
      if (!row) throw new NotFoundException('Buzón no encontrado.');
      await client.query(
        "UPDATE mailboxes SET state='disconnected',secret=NULL,sync_lease=NULL,openai_consented_at=NULL,generation=gen_random_uuid() WHERE id=$1", [id],
      );
      await client.query('UPDATE gmail_deliveries SET completed_at=now(),attempt_id=NULL ' +
        'WHERE mailbox_id=$1 AND completed_at IS NULL', [id]);
      await client.query(
        "UPDATE gmail_reprocess_runs SET failure='mailbox_unavailable',scan_finished_at=now(),scan_lease=NULL " +
        'WHERE mailbox_id=$1 AND finished_at IS NULL', [id],
      );
      await client.query(
        "UPDATE notices SET status='error',reason='mailbox_disconnected',payload=NULL,lease=NULL,completed_at=now() " +
        "WHERE mailbox_id=$1 AND status='processing'", [id],
      );
      return row;
    });
    this.accessTokens.delete(id);
    if (mailbox.secret) {
      const params = new URLSearchParams({ token: decrypt(mailbox.secret, this.config.encryptionKey) });
      const result = await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST', body: params, redirect: 'error', signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      if (!result || (!result.ok && result.status !== 400)) return { state: 'disconnected', providerRevoked: false };
    }
    return { state: 'disconnected', providerRevoked: true };
  }

  async pollOne() {
    if (!this.config.GOOGLE_CLIENT_ID || !this.config.GOOGLE_CLIENT_SECRET) return false;
    const lease = randomUUID();
    const { rows: [mailbox] } = await this.db.query<Mailbox>(
      "UPDATE mailboxes SET sync_due_at=now()+interval '2 minutes',sync_lease=$1 " +
      "WHERE id=(SELECT id FROM mailboxes WHERE source='oauth' AND state='active' AND sync_due_at<=now() " +
      'ORDER BY sync_due_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *', [lease],
    );
    if (!mailbox) return false;
    try {
      const access = await this.accessToken(mailbox);
      const watermark = new Date();
      const cursor = await this.sync(mailbox, access);
      await this.db.query(
        "UPDATE mailboxes SET history_id=$3,last_synced_at=$4,sync_due_at=now()+interval '1 minute',sync_lease=NULL " +
        "WHERE id=$1 AND sync_lease=$2 AND state='active'", [mailbox.id, lease, cursor, watermark],
      );
    } catch (error) {
      const revoked = isRevoked(error);
      if (revoked) this.accessTokens.delete(mailbox.id);
      await this.db.query(
        "UPDATE mailboxes SET state=CASE WHEN $3 THEN 'reconnect' ELSE state END,sync_due_at=now()+interval '1 minute'," +
        'sync_lease=NULL WHERE id=$1 AND sync_lease=$2', [mailbox.id, lease, revoked],
      );
      if (!revoked) console.warn('Gmail sync will retry');
    }
    return true;
  }

  private async sync(mailbox: Mailbox, access: string) {
    if (mailbox.history_id) {
      try {
        let pageToken = '';
        let cursor = mailbox.history_id;
        do {
          const params = new URLSearchParams({ startHistoryId: mailbox.history_id, historyTypes: 'messageAdded', maxResults: '100' });
          if (pageToken) params.set('pageToken', pageToken);
          const result = await this.request<History>('history?' + params, access);
          await this.enqueue(mailbox, result.history?.flatMap(item => item.messagesAdded?.map(value => value.message.id) ?? []) ?? []);
          cursor = result.historyId;
          pageToken = result.nextPageToken ?? '';
        } while (pageToken);
        return cursor;
      } catch (error) {
        if (!(error instanceof GoogleError) || error.status !== 404) throw error;
      }
    }
    const baseline = await this.request<Profile>('profile', access);
    const boundary = Math.max(mailbox.linked_at.getTime(), (mailbox.last_synced_at?.getTime() ?? 0) - 86_400_000);
    let pageToken = '';
    do {
      const params = new URLSearchParams({ q: 'after:' + (Math.floor(boundary / 1000) - 1), maxResults: '100' });
      if (pageToken) params.set('pageToken', pageToken);
      const result = await this.request<Messages>('messages?' + params, access);
      await this.enqueue(mailbox, (result.messages ?? []).map(item => item.id));
      pageToken = result.nextPageToken ?? '';
    } while (pageToken);
    return baseline.historyId;
  }

  private async enqueue(mailbox: Mailbox, ids: string[]) {
    const distinct = messageIds(ids);
    if (!distinct.length) return;
    await this.db.transaction(async client => {
      const active = await client.query("SELECT 1 FROM mailboxes WHERE id=$1 AND generation=$2 AND sync_lease=$3 AND state='active' FOR UPDATE",
        [mailbox.id, mailbox.generation, mailbox.sync_lease]);
      if (!active.rowCount) return;
      await client.query(
        'INSERT INTO gmail_deliveries (mailbox_id,generation,message_id) ' +
        'SELECT $1,$2,ids.message_id FROM unnest($3::text[]) AS ids(message_id) ' +
        'WHERE NOT EXISTS (SELECT 1 FROM notices n WHERE n.mailbox_id=$1 AND n.message_id=ids.message_id) ' +
        'ON CONFLICT (mailbox_id,generation,message_id) DO NOTHING', [mailbox.id, mailbox.generation, distinct],
      );
    });
  }

  async scanReprocessPage() {
    await this.db.query(
      "UPDATE gmail_reprocess_runs r SET failure='mailbox_unavailable',scan_finished_at=now(),scan_lease=NULL " +
      "FROM mailboxes m WHERE m.id=r.mailbox_id AND m.state<>'active' AND r.finished_at IS NULL AND r.failure IS NULL",
    );
    await this.db.query(
      'WITH finished AS (UPDATE gmail_reprocess_runs r SET finished_at=clock_timestamp(),summary=COALESCE((' +
      'SELECT jsonb_object_agg(outcome,total) FROM (SELECT outcome,count(*)::int AS total FROM gmail_reprocess_results ' +
      "WHERE run_id=r.id GROUP BY outcome) counts),'{}'::jsonb) " +
      'WHERE r.finished_at IS NULL AND r.scan_finished_at IS NOT NULL AND ' +
      "(r.failure='mailbox_unavailable' OR NOT EXISTS (SELECT 1 FROM gmail_deliveries d WHERE d.reprocess_id=r.id AND d.completed_at IS NULL)) " +
      'RETURNING r.id) DELETE FROM gmail_reprocess_results x USING finished f WHERE x.run_id=f.id',
    );
    if (!this.config.GOOGLE_CLIENT_ID || !this.config.GOOGLE_CLIENT_SECRET) return false;
    const lease = randomUUID();
    const { rows: [scan] } = await this.db.query<Scan>(
      'WITH claimed AS (UPDATE gmail_reprocess_runs SET scan_lease=$1,scan_attempts=scan_attempts+1,' +
      "scan_due_at=now()+interval '1 minute' WHERE id=(" +
      'SELECT r.id FROM gmail_reprocess_runs r JOIN mailboxes m ON m.id=r.mailbox_id ' +
      "WHERE r.scan_finished_at IS NULL AND r.scan_due_at<=now() AND m.state='active' " +
      'ORDER BY r.scan_due_at FOR UPDATE OF r SKIP LOCKED LIMIT 1) RETURNING *) ' +
      'SELECT m.*,r.id AS run_id,r.from_at,r.to_at,r.page_token,r.scan_attempts FROM claimed r JOIN mailboxes m ON m.id=r.mailbox_id',
      [lease],
    );
    if (!scan) return false;
    try {
      const access = await this.accessToken(scan);
      const from = Math.floor(scan.from_at.getTime() / 1000) - 1;
      const to = Math.ceil(scan.to_at.getTime() / 1000);
      const query = new URLSearchParams({ q: 'after:' + from + ' before:' + to + ' -in:sent -in:drafts', maxResults: '100' });
      if (scan.page_token) query.set('pageToken', scan.page_token);
      const page = await this.request<Messages>('messages?' + query, access);
      await this.enqueueReprocessPage(scan, lease, messageIds((page.messages ?? []).map(message => message.id)), page.nextPageToken);
    } catch (error) {
      const revoked = isRevoked(error);
      if (revoked) {
        this.accessTokens.delete(scan.id);
        await this.db.query("UPDATE mailboxes SET state='reconnect',sync_lease=NULL WHERE id=$1 AND generation=$2 AND state='active'",
          [scan.id, scan.generation]);
      }
      const failure = revoked ? 'mailbox_unavailable' : scan.scan_attempts >= maxReprocessAttempts ? 'gmail_list_failed' : null;
      await this.db.query(
        "UPDATE gmail_reprocess_runs SET scan_lease=NULL,scan_due_at=now()+interval '30 seconds'," +
        'failure=$3,scan_finished_at=CASE WHEN $3::text IS NOT NULL THEN now() END WHERE id=$1 AND scan_lease=$2',
        [scan.run_id, lease, failure],
      );
    }
    return true;
  }

  private async enqueueReprocessPage(scan: Scan, lease: string, ids: string[], next?: string) {
    await this.db.transaction(async client => {
      const active = await client.query(
        "SELECT 1 FROM mailboxes WHERE id=$1 AND generation=$2 AND state='active' FOR UPDATE", [scan.id, scan.generation],
      );
      if (!active.rowCount) return;
      const saved = await client.query(
        'UPDATE gmail_reprocess_runs SET page_token=$3,scan_lease=NULL,scan_attempts=0,scan_due_at=now(),' +
        'scan_finished_at=CASE WHEN $3::text IS NULL THEN now() END WHERE id=$1 AND scan_lease=$2 AND finished_at IS NULL',
        [scan.run_id, lease, next ?? null],
      );
      if (!saved.rowCount || !ids.length) return;
      await client.query(
        "WITH candidates AS (SELECT ids.message_id, (n.status NOT IN ('pending','error') OR t.id IS NOT NULL OR d.received_at>=$5) AS skip " +
        'FROM unnest($4::text[]) AS ids(message_id) LEFT JOIN notices n ON n.mailbox_id=$1 AND n.message_id=ids.message_id ' +
        'LEFT JOIN transactions t ON t.notice_id=n.id ' +
        'LEFT JOIN gmail_deliveries d ON d.mailbox_id=$1 AND d.generation=$2 AND d.message_id=ids.message_id ' +
        'WHERE NOT EXISTS (SELECT 1 FROM gmail_reprocess_results r WHERE r.run_id=$3 AND r.message_id=ids.message_id)),' +
        "skipped AS (INSERT INTO gmail_reprocess_results (run_id,message_id,outcome) SELECT $3,message_id,'skipped' " +
        'FROM candidates WHERE skip ON CONFLICT DO NOTHING) ' +
        'INSERT INTO gmail_deliveries (mailbox_id,generation,message_id,reprocess_id) ' +
        'SELECT $1,$2,message_id,$3 FROM candidates WHERE skip IS NOT TRUE ' +
        'ON CONFLICT (mailbox_id,generation,message_id) DO UPDATE SET reprocess_id=excluded.reprocess_id,' +
        'accepted_at=CASE WHEN gmail_deliveries.completed_at IS NOT NULL THEN excluded.accepted_at ELSE gmail_deliveries.accepted_at END,' +
        'attempts=0,attempt_id=NULL,due_at=now(),completed_at=NULL ' +
        'WHERE gmail_deliveries.reprocess_id IS DISTINCT FROM excluded.reprocess_id',
        [scan.id, scan.generation, scan.run_id, ids, scan.to_at],
      );
    });
  }

  async dispatchOne() {
    if (!this.config.GOOGLE_CLIENT_ID || !this.config.GOOGLE_CLIENT_SECRET) return false;
    const attemptId = randomUUID();
    const { rows: [job] } = await this.db.query<Job>(
      'WITH claim AS (UPDATE gmail_deliveries SET attempt_id=$1,attempts=attempts+1,received_at=NULL,' +
      "due_at=now()+interval '3 minutes' WHERE id=(SELECT d.id FROM gmail_deliveries d JOIN mailboxes m ON m.id=d.mailbox_id " +
      "WHERE d.completed_at IS NULL AND d.due_at<=now() AND m.state='active' AND m.source='oauth' AND m.generation=d.generation " +
      'ORDER BY d.due_at FOR UPDATE OF d SKIP LOCKED LIMIT 1) RETURNING *) ' +
      'SELECT m.*,claim.id AS delivery_id,claim.message_id,claim.attempts,claim.reprocess_id,r.from_at,r.to_at ' +
      'FROM claim JOIN mailboxes m ON m.id=claim.mailbox_id LEFT JOIN gmail_reprocess_runs r ON r.id=claim.reprocess_id',
      [attemptId],
    );
    if (!job) return false;
    try {
      if (job.reprocess_id && job.attempts > maxReprocessAttempts) {
        await this.closeDelivery(job, attemptId, 'error');
        return true;
      }
      const access = await this.accessToken(job);
      const message = await this.request<RawMessage>('messages/' + encodeURIComponent(job.message_id) + '?format=raw', access);
      const received = new Date(/^\d+$/.test(message.internalDate) ? Number(message.internalDate) : NaN);
      const from = job.from_at ?? job.linked_at;
      if (!Number.isFinite(+received) || received < from || (job.to_at && received >= job.to_at)) {
        await this.closeDelivery(job, attemptId, 'skipped');
        return true;
      }
      if (message.id !== job.message_id ||
          typeof message.raw !== 'string' || !message.raw.length || message.raw.length > maxRawSize ||
          !/^[A-Za-z0-9_-]+={0,2}$/.test(message.raw)) {
        await this.closeDelivery(job, attemptId, 'error');
        return true;
      }
      const mime = await simpleParser(Buffer.from(message.raw, 'base64url'), {
        skipImageLinks: true, skipTextToHtml: true, skipHtmlToText: true,
      });
      const bound = await this.db.query<{ openai_enabled: boolean }>(
        'UPDATE gmail_deliveries d SET received_at=$3 FROM mailboxes m WHERE d.id=$1 AND d.attempt_id=$2 ' +
        "AND d.completed_at IS NULL AND m.id=d.mailbox_id AND m.generation=d.generation AND m.state='active' " +
        'RETURNING m.openai_consented_at IS NOT NULL AS openai_enabled',
        [job.delivery_id, attemptId, received],
      );
      if (!bound.rowCount) return true;
      const identity = { deliveryId: job.delivery_id, attemptId, messageId: job.message_id, receivedAt: received.toISOString() };
      const fromAddress = mime.from?.value.length === 1 ? (mime.from.value[0].address ?? '').slice(0, 320) : '';
      const email = {
        labels: Array.isArray(message.labelIds) ? message.labelIds : [],
        from: fromAddress,
        subject: (mime.subject ?? '').slice(0, 1000), text: (mime.text ?? '').replace(/\r\n?/g, '\n').slice(0, 30_000),
      };
      const useOpenAi = bound.rows[0].openai_enabled && Boolean(this.config.OPENAI_API_KEY);
      const authenticated = gmailAuthenticatedSender(mime.headerLines, fromAddress);
      // Some messages include a plain-text alternative that contains only a notice to view the HTML.
      // Parse both versions independently so dates, amounts and cards are not mixed across versions.
      const html = mime.html ? convert(mime.html, {
        wordwrap: false, limits: { maxInputLength: maxRawSize, maxDepth: 100 },
        selectors: [{ selector: 'img', format: 'skip' }, { selector: 'a', options: { ignoreHref: true } }],
      }).slice(0, 30_000) : '';
      const parts = [email.text, html].filter(value => value.trim().length);
      if (!parts.length && typeof message.snippet === 'string') parts.push(message.snippet.slice(0, 500));
      let selected = { ...email, text: parts[0] ?? '' };
      let classification = await this.extraction.classify(selected, false, authenticated);
      if (parts[1] && parts[1] !== parts[0]) {
        const alternate = { ...email, text: parts[1] };
        const alternateResult = await this.extraction.classify(alternate, false, authenticated);
        if (classification.status === 'ignored' ||
            (classification.status !== 'registered' && alternateResult.status === 'registered') ||
            (classification.status === 'pending' && alternateResult.status === 'pending' &&
              (classification.unconfirmedFields?.length ?? 0) > (alternateResult.unconfirmedFields?.length ?? 0))) {
          selected = alternate;
          classification = alternateResult;
        } else if (classification.status === 'registered' && alternateResult.status === 'registered' &&
            (['amountMinor', 'currency', 'date', 'direction'] as const).some(key =>
              classification.status === 'registered' && classification.movement[key] !== alternateResult.movement[key])) {
          const { movement: _, ...conflicting } = classification;
          await this.results.save({ source: 'oauth', ...identity, ...conflicting,
            status: 'pending', reason: 'unconfirmed_extraction', confidence: 0 });
          return true;
        }
      }
      if (useOpenAi && classification.status === 'pending') classification = await this.extraction.classify(selected, true, authenticated);
      if (useOpenAi || !this.config.N8N_GMAIL_WEBHOOK_URL || classification.status === 'registered' ||
          job.reprocess_id || classification.status === 'ignored') {
        await this.results.save({ source: 'oauth', ...identity, ...classification });
      } else {
        await this.deliverToN8n(this.config.N8N_GMAIL_WEBHOOK_URL, { ...identity, ...selected });
      }
    } catch (error) {
      if (isRevoked(error)) {
        this.accessTokens.delete(job.id);
        await this.db.query("UPDATE mailboxes SET state='reconnect',sync_lease=NULL WHERE id=$1 AND generation=$2 AND state='active'",
          [job.id, job.generation]);
      } else if (error instanceof GoogleError && error.status === 404) {
        await this.closeDelivery(job, attemptId, 'skipped');
      } else if (job.reprocess_id && job.attempts >= maxReprocessAttempts) {
        await this.closeDelivery(job, attemptId, 'error');
      } else {
        const delay = job.reprocess_id ? Math.min(120, 20 * 2 ** Math.min(job.attempts - 1, 3)) :
          Math.min(900, 180 * 2 ** Math.min(job.attempts - 1, 3));
        await this.db.query('UPDATE gmail_deliveries SET due_at=now()+make_interval(secs=>$3::double precision) ' +
          'WHERE id=$1 AND attempt_id=$2 AND completed_at IS NULL', [job.delivery_id, attemptId, delay]);
        if (job.attempts === 1 || job.attempts % 10 === 0) console.warn('Gmail delivery will retry');
      }
    }
    return true;
  }

  private async deliverToN8n(url: string, body: object) {
    const response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json', 'X-MailGasto-Agent': this.config.N8N_AGENT_KEY },
      body: JSON.stringify(body),
    });
    await response.body?.cancel();
    if (response.status !== 202) throw new Error('Webhook did not accept delivery');
  }

  private closeDelivery(job: Job, attemptId: string, outcome: 'error' | 'skipped') {
    return this.db.transaction(client => finishGmailDelivery(client, job.delivery_id, attemptId, outcome));
  }

  private async accessToken(mailbox: Mailbox): Promise<string> {
    const cached = this.accessTokens.get(mailbox.id);
    if (cached?.generation === mailbox.generation) {
      const access = await cached.access;
      if (access.expiresAt > Date.now()) return access.token;
      if (this.accessTokens.get(mailbox.id) !== cached) return this.accessToken(mailbox);
    }
    const access = this.exchange({
      grant_type: 'refresh_token', refresh_token: decrypt(mailbox.secret!, this.config.encryptionKey),
    }).then(tokens => ({
      token: tokens.access_token,
      expiresAt: Date.now() + Math.max(0, (tokens.expires_in ?? 0) - 60) * 1000,
    })).catch(error => {
      if (this.accessTokens.get(mailbox.id)?.access === access) this.accessTokens.delete(mailbox.id);
      throw error;
    });
    this.accessTokens.set(mailbox.id, { generation: mailbox.generation, access });
    return (await access).token;
  }

  private async find(accountId: string, id: string) {
    const { rows: [mailbox] } = await this.db.query<Mailbox>('SELECT * FROM mailboxes WHERE id=$1 AND account_id=$2', [id, accountId]);
    if (!mailbox) throw new NotFoundException('Buzón no encontrado.');
    return mailbox;
  }

  private request<T>(path: string, access: string) {
    return google<T>(gmailRoot + path, { headers: { Authorization: 'Bearer ' + access } });
  }

  private exchange(values: Record<string, string>) {
    return google<Tokens>(tokenUrl, {
      method: 'POST',
      body: new URLSearchParams({ ...values, client_id: this.config.GOOGLE_CLIENT_ID!, client_secret: this.config.GOOGLE_CLIENT_SECRET! }),
    });
  }

  private redirectUri(mobile: boolean) {
    return this.config.origin + '/v1/' + (mobile ? 'mobile/' : '') + 'mailboxes/gmail/callback';
  }

  private requireOAuth() {
    if (!this.config.GOOGLE_CLIENT_ID || !this.config.GOOGLE_CLIENT_SECRET) {
      throw new ServiceUnavailableException('La conexión OAuth de Gmail aún no está configurada.');
    }
  }
}

function gmailAuthenticatedSender(headers: readonly { key: string; line: string }[], address: string) {
  const domain = address.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  const gmail = headers.find(({ key, line }) => key === 'authentication-results' &&
    /^authentication-results:\s*mx\.google\.com\s*;/i.test(line));
  if (!gmail) return false;
  const from = /\bdmarc=pass\b[^;]*\bheader\.from=([a-z\d.-]+)/i.exec(gmail.line)?.[1]?.toLowerCase();
  if (from === domain || (from && from.includes('.') && domain.endsWith('.' + from) &&
      /(?:^|\.)notificacionesbancolombia\.com$/.test(from))) return true;
  return gmail.line.split(';').some(part => {
    if (!/\bdkim=pass\b/i.test(part)) return false;
    const signer = (/\bheader\.i=(?:[a-z0-9._%+-]+)?@([a-z\d.-]+)/i.exec(part)?.[1] ??
      /\bheader\.d=([a-z\d.-]+)/i.exec(part)?.[1])?.toLowerCase();
    return signer === domain || (signer === 'notificacionesbancolombia.com' && domain.endsWith('.' + signer));
  });
}
