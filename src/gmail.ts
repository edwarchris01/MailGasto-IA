import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { simpleParser } from 'mailparser';
import { CONFIG, Config, decrypt, encrypt, hash, token } from './config.js';
import { Database } from './db.js';
import { messageIdPattern } from './gmail-results.js';

const gmailScope = 'https://www.googleapis.com/auth/gmail.readonly';
const gmailRoot = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const tokenUrl = 'https://oauth2.googleapis.com/token';
const maxRawSize = 1_500_000;

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
type RawMessage = { id: string; raw: string; internalDate: string; labelIds?: string[] };
type Tokens = { access_token: string; refresh_token?: string; scope?: string };
type History = { historyId: string; nextPageToken?: string; history?: { messagesAdded?: { message: { id: string } }[] }[] };
type OAuthState = { verifier: string; expected_mailbox: string | null };
type Mailbox = {
  id: string; account_id: string; email: string; source: 'n8n' | 'oauth';
  state: 'active' | 'reconnect' | 'disconnected'; secret: string | null;
  history_id: string | null; linked_at: Date; last_synced_at: Date | null; sync_lease: string | null;
  generation: string;
};
type Job = Mailbox & { delivery_id: string; message_id: string; attempts: number };
const isRevoked = (error: unknown) => error instanceof GoogleError && (error.code === 'invalid_grant' || error.status === 401);

@Injectable()
export class Gmail {
  constructor(@Inject(Database) private readonly db: Database, @Inject(CONFIG) private readonly config: Config) {}

  async list(accountId: string) {
    const { rows } = await this.db.query(
      'SELECT id,email,source,state,linked_at,last_synced_at FROM mailboxes WHERE account_id=$1 ORDER BY linked_at DESC',
      [accountId],
    );
    return rows;
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
        "UPDATE mailboxes SET state='disconnected',secret=NULL,sync_lease=NULL,generation=gen_random_uuid() WHERE id=$1", [id],
      );
      await client.query('UPDATE gmail_deliveries SET completed_at=now(),attempt_id=NULL ' +
        'WHERE mailbox_id=$1 AND completed_at IS NULL', [id]);
      await client.query(
        "UPDATE notices SET status='error',reason='mailbox_disconnected',payload=NULL,lease=NULL,completed_at=now() " +
        "WHERE mailbox_id=$1 AND status='processing'", [id],
      );
      return row;
    });
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
    if (!this.config.GOOGLE_CLIENT_ID || !this.config.GOOGLE_CLIENT_SECRET || !this.config.N8N_GMAIL_WEBHOOK_URL) return false;
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
      const result = await this.request<{ messages?: { id: string }[]; nextPageToken?: string }>('messages?' + params, access);
      await this.enqueue(mailbox, (result.messages ?? []).map(item => item.id));
      pageToken = result.nextPageToken ?? '';
    } while (pageToken);
    return baseline.historyId;
  }

  private async enqueue(mailbox: Mailbox, ids: string[]) {
    const distinct = [...new Set(ids.filter(id => typeof id === 'string' && messageIdPattern.test(id)))];
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

  async dispatchOne() {
    const url = this.config.N8N_GMAIL_WEBHOOK_URL;
    if (!url || !this.config.GOOGLE_CLIENT_ID || !this.config.GOOGLE_CLIENT_SECRET) return false;
    const attemptId = randomUUID();
    const { rows: [job] } = await this.db.query<Job>(
      'WITH claim AS (UPDATE gmail_deliveries SET attempt_id=$1,attempts=attempts+1,received_at=NULL,' +
      "due_at=now()+interval '3 minutes' WHERE id=(SELECT d.id FROM gmail_deliveries d JOIN mailboxes m ON m.id=d.mailbox_id " +
      "WHERE d.completed_at IS NULL AND d.due_at<=now() AND m.state='active' AND m.source='oauth' AND m.generation=d.generation " +
      'ORDER BY d.due_at FOR UPDATE OF d SKIP LOCKED LIMIT 1) RETURNING *) ' +
      'SELECT m.*,claim.id AS delivery_id,claim.message_id,claim.attempts FROM claim JOIN mailboxes m ON m.id=claim.mailbox_id', [attemptId],
    );
    if (!job) return false;
    try {
      const access = await this.accessToken(job);
      const message = await this.request<RawMessage>('messages/' + encodeURIComponent(job.message_id) + '?format=raw', access);
      const received = new Date(/^\d+$/.test(message.internalDate) ? Number(message.internalDate) : NaN);
      if (message.id !== job.message_id || !Number.isFinite(+received) || received < job.linked_at ||
          typeof message.raw !== 'string' || !message.raw.length || message.raw.length > maxRawSize ||
          !/^[A-Za-z0-9_-]+={0,2}$/.test(message.raw)) {
        await this.closeDelivery(job.delivery_id, attemptId);
        return true;
      }
      const mime = await simpleParser(Buffer.from(message.raw, 'base64url'), {
        skipImageLinks: true, skipTextToHtml: true, skipHtmlToText: false,
      });
      const bound = await this.db.query(
        'UPDATE gmail_deliveries d SET received_at=$3 FROM mailboxes m WHERE d.id=$1 AND d.attempt_id=$2 ' +
        "AND d.completed_at IS NULL AND m.id=d.mailbox_id AND m.generation=d.generation AND m.state='active'",
        [job.delivery_id, attemptId, received],
      );
      if (!bound.rowCount) return true;
      const response = await fetch(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json', 'X-MailGasto-Agent': this.config.N8N_AGENT_KEY },
        body: JSON.stringify({
          deliveryId: job.delivery_id, attemptId, messageId: job.message_id, receivedAt: received.toISOString(),
          labels: Array.isArray(message.labelIds) ? message.labelIds : [],
          from: mime.from?.value.length === 1 ? (mime.from.value[0].address ?? '').slice(0, 320) : '',
          subject: (mime.subject ?? '').slice(0, 1000), text: (mime.text ?? '').replace(/\r\n?/g, '\n').slice(0, 30_000),
        }),
      });
      await response.body?.cancel();
      if (response.status !== 202) throw new Error('Webhook did not accept delivery');
    } catch (error) {
      if (isRevoked(error)) {
        await this.db.query("UPDATE mailboxes SET state='reconnect',sync_lease=NULL WHERE id=$1 AND generation=$2 AND state='active'",
          [job.id, job.generation]);
      } else if (error instanceof GoogleError && error.status === 404) {
        await this.closeDelivery(job.delivery_id, attemptId);
      } else {
        const delay = Math.min(900, 180 * 2 ** Math.min(job.attempts - 1, 3));
        await this.db.query('UPDATE gmail_deliveries SET due_at=now()+make_interval(secs=>$3::double precision) ' +
          'WHERE id=$1 AND attempt_id=$2 AND completed_at IS NULL', [job.delivery_id, attemptId, delay]);
        if (job.attempts === 1 || job.attempts % 10 === 0) console.warn('Gmail delivery will retry');
      }
    }
    return true;
  }

  private closeDelivery(id: string, attemptId: string) {
    return this.db.query('UPDATE gmail_deliveries SET completed_at=now() WHERE id=$1 AND attempt_id=$2 AND completed_at IS NULL', [id, attemptId]);
  }

  private async accessToken(mailbox: Mailbox) {
    const tokens = await this.exchange({
      grant_type: 'refresh_token', refresh_token: decrypt(mailbox.secret!, this.config.encryptionKey),
    });
    return tokens.access_token;
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
