import { Inject, Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { queueMail } from './accounts.js';
import { CONFIG, Config } from './config.js';
import { Database } from './db.js';
import { amountPattern, bankProviders, cardLast4Pattern, cardTypes, categories, currencies, directions, gmailReferencePattern,
  paymentMethods, providers, redact, transactionTimePattern, unconfirmedFields } from './mail-rules.js';

export const messageIdPattern = /^[A-Za-z0-9_-]{1,200}$/;
export const maxGmailDeliveryAttempts = 5;
export function gmailDeliveryRetryDelay(attempt: number, reprocess = false) {
  return reprocess ? Math.min(120, 20 * 2 ** Math.min(attempt - 1, 3)) :
    Math.min(900, 180 * 2 ** Math.min(attempt - 1, 3));
}

export function logGmailDelivery(status: string, reason: string | undefined, attempts: number | undefined, startedAt: Date) {
  console.info(JSON.stringify({ event: 'gmail_delivery', status, reason, attempts, durationMs: Date.now() - +startedAt }));
}

const timestamp = z.iso.datetime({ offset: true });
const day = z.iso.date().refine(value => !value.startsWith('0000'));
const paymentMethod = z.enum(paymentMethods).nullable();
const optionalDetails = {
  transactionTime: z.string().regex(transactionTimePattern).nullish(),
  cardType: z.enum(cardTypes).nullish(),
  cardLast4: z.string().regex(cardLast4Pattern).nullish(),
  reportedInstitution: z.enum(bankProviders).nullish(),
};
type PaymentDetails = { paymentMethod: z.infer<typeof paymentMethod> } & {
  cardType?: string | null; cardLast4?: string | null;
};
const consistentCard = (details: PaymentDetails) =>
  details.paymentMethod === 'Tarjeta' || (details.cardType == null && details.cardLast4 == null);
const pendingEvidence = z.strictObject({
  date: day.nullable(), paymentMethod, ...optionalDetails,
  amountMinor: z.string().regex(amountPattern).nullish(),
  currency: z.enum(currencies).nullish(),
  direction: z.enum(directions).nullish(),
}).refine(consistentCard);
const movement = z.strictObject({
  amountMinor: z.string().regex(amountPattern),
  currency: z.enum(currencies),
  date: day,
  paymentMethod,
  description: z.string().trim().min(1).max(160),
  category: z.enum(categories),
  direction: z.enum(directions),
  ...optionalDetails,
}).refine(consistentCard).refine(value => (value.direction === 'income') === (value.category === 'ingresos'));
const identity = {
  source: z.enum(['legacy', 'oauth']),
  messageId: z.string().regex(messageIdPattern),
  receivedAt: timestamp,
  startedAt: timestamp.optional(),
  deliveryId: z.uuid().optional(),
  attemptId: z.uuid().optional(),
};
const notice = {
  ...identity, provider: z.enum(providers), forwarded: z.boolean(), authenticated: z.boolean().optional(),
};
const references = z.array(z.string().regex(gmailReferencePattern)).min(1).max(2).optional();
export const gmailResult = z.discriminatedUnion('status', [
  z.strictObject({ ...identity, status: z.literal('ignored') }),
  z.strictObject({ ...notice, status: z.literal('registered'), confidence: z.number().min(0.7).max(1), movement, references,
    categoryFromPseConcept: z.literal(true).optional() }),
  z.strictObject({ ...notice, status: z.literal('pending'), confidence: z.number().min(0).max(1),
    reason: z.enum(['missing_or_ambiguous_fields', 'unconfirmed_extraction', 'unverified_sender', 'possible_duplicate']),
    unconfirmedFields: z.array(z.enum(unconfirmedFields)).max(unconfirmedFields.length).optional(),
    evidence: pendingEvidence.optional(), references, avalCopy: z.literal(true).optional() }),
  z.strictObject({ ...notice, status: z.literal('error'), confidence: z.literal(0), reason: z.literal('extractor_unavailable') }),
  z.strictObject({ ...notice, status: z.literal('retry'), reason: z.enum(['invalid_model_output', 'ollama_unavailable']) }),
]).refine(value => (value.source === 'oauth'
  ? value.deliveryId !== undefined && value.attemptId !== undefined && value.startedAt === undefined &&
    (!('authenticated' in value) || value.authenticated === undefined)
  : value.deliveryId === undefined && value.attemptId === undefined && value.startedAt !== undefined && value.status !== 'ignored') &&
  (value.status !== 'pending' || value.reason !== 'unverified_sender' || value.provider === 'other'))
  .refine(value => !('references' in value) || !value.references || !value.forwarded &&
    (value.status === 'registered' ? value.movement.direction === 'expense' :
      value.evidence?.direction === 'expense' || value.avalCopy === true))
  .refine(value => value.status !== 'pending' || !value.avalCopy ||
    value.provider === 'other' && value.evidence?.paymentMethod === 'Bre-B' && !!value.evidence.amountMinor &&
    !!value.evidence.currency && value.evidence.direction !== 'income' &&
    !!value.references?.some(ref => ref.startsWith('aval-bre-b:')))
  .refine(value => value.status !== 'registered' || !value.categoryFromPseConcept ||
    value.provider === 'other' && value.movement.paymentMethod === 'PSE' &&
    !!value.references?.some(ref => ref.startsWith('pse:')));

type Result = z.infer<typeof gmailResult>;
type TerminalResult = Exclude<Result, { status: 'retry' }>;
type Mailbox = { id: string; account_id: string; state: string; generation: string; linked_at: Date; source: string };
type Delivery = { mailbox_id: string; generation: string; message_id: string; attempt_id: string | null;
  received_at: Date | null; accepted_at: Date; completed_at: Date | null;
  reprocess_id: string | null; from_at: Date | null; to_at: Date | null; attempts: number;
  authenticated: boolean | null; forwarded: boolean | null; retry_requested_at: Date | null };

type ReprocessOutcome = 'registered' | 'pending' | 'ignored' | 'error' | 'skipped';
type ReferencedMovement = {
  id: string; amount_minor: string; currency: string; transaction_date: string; direction: 'expense' | 'income';
};
type RegisteredResult = Extract<Result, { status: 'registered' }>;

function duplicateForReview(result: RegisteredResult): Extract<Result, { status: 'pending' }> {
  const { movement: { description: _description, category: _category, ...evidence }, categoryFromPseConcept: _, ...notice } = result;
  return { ...notice, status: 'pending', reason: 'possible_duplicate', evidence };
}

function requireGmailAuthentication(result: TerminalResult, authenticated: boolean, forwarded: boolean): TerminalResult {
  if (result.status === 'ignored' || result.status === 'error') return result;
  if (authenticated && !forwarded && !result.forwarded) return result;
  if (result.status === 'registered') {
    const { movement: { description: _description, category: _category, ...evidence },
      categoryFromPseConcept: _categoryProof, references: _references, ...notice } = result;
    return { ...notice, forwarded: forwarded || result.forwarded, status: 'pending', reason: 'unconfirmed_extraction',
      confidence: 0, evidence };
  }
  const { references: _references, avalCopy: _avalCopy, ...pending } = result;
  return { ...pending, forwarded: forwarded || pending.forwarded };
}

function operationFingerprints(result: Result, account: string, key: Buffer) {
  if (!('references' in result) || result.forwarded || !result.references) return [];
  return [...new Set(result.references)].map(reference =>
    createHmac('sha256', key).update('gmail-operation\0' + account + '\0' + reference).digest('hex'));
}

async function saveFingerprints(client: PoolClient, id: string, fingerprints: string[]) {
  if (!fingerprints.length) return;
  await client.query('INSERT INTO gmail_operation_references (notice_id,fingerprint) ' +
    'SELECT $1,fingerprint FROM unnest($2::text[]) AS refs(fingerprint) ON CONFLICT DO NOTHING', [id, fingerprints]);
}

const discardNotice = "UPDATE notices n SET status='discarded',reason=$1,confidence=0,unconfirmed_fields=NULL," +
  'reported_transaction_date=NULL,transaction_time=NULL,reported_payment_method=NULL,card_type=NULL,card_last4=NULL,' +
  'reported_institution=NULL,reported_amount_minor=NULL,reported_currency=NULL,reported_direction=NULL,avalpay_partial=false ' +
  "WHERE n.status='pending' AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.notice_id=n.id) ";

async function discardUnregisteredNotices(client: PoolClient, filter: string, values: unknown[]) {
  const { rows } = await client.query<{ id: string }>(discardNotice + filter + ' RETURNING n.id', values);
  if (rows.length) await client.query("DELETE FROM outbox WHERE dedupe_key=ANY($1::text[]) AND status='queued'",
    [rows.map(row => 'pending:' + row.id)]);
  return rows.length;
}

async function discardAvalCopies(client: PoolClient, account: string, id: string, movement: RegisteredResult['movement'],
  fingerprints: string[], references: RegisteredResult['references']) {
  if (movement.direction !== 'expense' || !references?.some(ref => ref.startsWith('aval-bre-b:'))) return;
  await discardUnregisteredNotices(client,
    'AND n.avalpay_partial AND n.reported_amount_minor=$2 AND n.reported_currency=$3 ' +
    'AND (n.reported_transaction_date IS NULL OR n.reported_transaction_date=$4) ' +
    'AND EXISTS (SELECT 1 FROM gmail_operation_references s JOIN mailboxes m ON m.id=n.mailbox_id ' +
    'WHERE s.notice_id=n.id AND s.fingerprint=ANY($5::text[]) AND m.account_id=$6) AND n.id<>$7',
    ['verified_duplicate', movement.amountMinor, movement.currency, movement.date, fingerprints, account, id]);
}

export async function finishGmailDelivery(client: PoolClient, id: string, attemptId: string,
  outcome: ReprocessOutcome,
) {
  await client.query(
    'WITH closed AS (UPDATE gmail_deliveries SET completed_at=clock_timestamp() ' +
    'WHERE id=$1 AND attempt_id=$2 AND completed_at IS NULL RETURNING message_id,reprocess_id) ' +
    'INSERT INTO gmail_reprocess_results (run_id,message_id,outcome) ' +
    'SELECT reprocess_id,message_id,$3 FROM closed WHERE reprocess_id IS NOT NULL ON CONFLICT DO NOTHING',
    [id, attemptId, outcome],
  );
}

@Injectable()
export class GmailResults {
  constructor(@Inject(Database) private readonly db: Database, @Inject(CONFIG) private readonly config: Config) {}

  async save(result: Result, { verifiedBank = false, explicitNonMovement = false } = {}) {
    const startedAt = new Date();
    let attempts: number | undefined;
    let retryReplayed = false;
    const response = await this.db.transaction(async client => {
      const oauth = result.source === 'oauth';
      // Keep the same lock order as disconnect: mailbox, then its deliveries.
      const { rows: [mailbox] } = await client.query<Mailbox>(
        'SELECT m.id,m.account_id,m.state,m.generation,m.linked_at,m.source FROM mailboxes m ' +
        'JOIN accounts a ON a.id=m.account_id AND a.verified_at IS NOT NULL ' +
        (oauth
          ? "WHERE m.id=(SELECT mailbox_id FROM gmail_deliveries WHERE id=$1) AND m.source='oauth' "
          : "WHERE m.email=$1 AND m.source='n8n' AND a.email=m.email ") +
        'FOR UPDATE OF m', [oauth ? result.deliveryId : this.config.LEGACY_GMAIL_ADDRESS?.toLowerCase() ?? null],
      );
      const received = new Date(result.receivedAt);
      if (!mailbox || mailbox.state !== 'active') return { outcome: 'discarded' };
      let accepted = new Date(Math.min(Date.now(), Math.max(+received, Date.parse(result.startedAt ?? result.receivedAt))));
      let reprocessId: string | null = null;
      let authenticated = 'authenticated' in result && result.authenticated === true;
      let forwarded = 'forwarded' in result && result.forwarded;
      if (oauth) {
        const { rows: [delivery] } = await client.query<Delivery>(
          'SELECT d.mailbox_id,d.generation,d.message_id,d.attempt_id,d.received_at,d.accepted_at,d.completed_at,' +
          'd.reprocess_id,d.attempts,d.authenticated,d.forwarded,d.retry_requested_at,r.from_at,r.to_at ' +
          'FROM gmail_deliveries d LEFT JOIN gmail_reprocess_runs r ON r.id=d.reprocess_id ' +
          'WHERE d.id=$1 FOR UPDATE OF d', [result.deliveryId],
        );
        if (!delivery || delivery.mailbox_id !== mailbox.id || delivery.generation !== mailbox.generation ||
            delivery.message_id !== result.messageId || delivery.attempt_id !== result.attemptId ||
            delivery.received_at?.getTime() !== received.getTime()) return { outcome: 'discarded' };
        attempts = delivery.attempts;
        if (delivery.completed_at) return { outcome: 'duplicate' };
        if (delivery.reprocess_id && (!delivery.from_at || !delivery.to_at ||
            received < delivery.from_at || received >= delivery.to_at)) return { outcome: 'discarded' };
        reprocessId = delivery.reprocess_id;
        accepted = delivery.accepted_at;
        authenticated = delivery.authenticated === true;
        forwarded ||= delivery.forwarded !== false;
        if (delivery.retry_requested_at) {
          retryReplayed = true;
          return { outcome: 'retry_scheduled' };
        }
      }
      if (!reprocessId && received < mailbox.linked_at) return { outcome: 'discarded' };
      if (result.status === 'retry') {
        if (!oauth || attempts === undefined) return { outcome: 'retry_scheduled' };
        if (attempts < maxGmailDeliveryAttempts) {
          await client.query('UPDATE gmail_deliveries SET retry_requested_at=clock_timestamp(), ' +
            'due_at=now()+make_interval(secs=>$3::double precision) WHERE id=$1 AND attempt_id=$2 AND completed_at IS NULL',
            [result.deliveryId, result.attemptId, gmailDeliveryRetryDelay(attempts, true)]);
          return { outcome: 'retry_scheduled' };
        }
        logGmailDelivery('retry_exhausted', result.reason, attempts, startedAt);
        result = { ...result, status: 'error', reason: 'extractor_unavailable', confidence: 0 };
      }
      result = requireGmailAuthentication(result, authenticated, forwarded);
      verifiedBank &&= authenticated && !forwarded;
      explicitNonMovement &&= authenticated && !forwarded;
      const fingerprints = operationFingerprints(result, mailbox.account_id, this.config.encryptionKey);
      if (result.status === 'registered' || fingerprints.length) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1))', [mailbox.account_id]);
      }
      if (result.status === 'registered' && reprocessId) {
        const value = result.movement;
        const { rows: [prior] } = await client.query<ReferencedMovement & { movement_id: string }>(
          'SELECT n.id,t.id AS movement_id,t.amount_minor::text,t.currency,t.transaction_date::text,t.direction ' +
          'FROM notices n JOIN transactions t ON t.notice_id=n.id ' +
          "WHERE n.mailbox_id=$1 AND n.message_id=$2 AND n.status='registered' FOR UPDATE OF n,t",
          [mailbox.id, result.messageId],
        );
        if (prior) {
          const same = prior.amount_minor === value.amountMinor && prior.currency === value.currency &&
            prior.transaction_date === value.date && prior.direction === value.direction;
          if (same) {
            await saveFingerprints(client, prior.id, fingerprints);
            await discardAvalCopies(client, mailbox.account_id, prior.id, value, fingerprints, result.references);
          }
          if (verifiedBank && same) {
            await client.query(
              'UPDATE notices SET reported_transaction_date=COALESCE(reported_transaction_date,$2),' +
              'transaction_time=COALESCE(transaction_time,$3),reported_payment_method=COALESCE(reported_payment_method,$4),' +
              'card_type=CASE WHEN COALESCE(reported_payment_method,$4)=' + "'Tarjeta' THEN COALESCE(card_type,$5) ELSE card_type END," +
              'card_last4=CASE WHEN COALESCE(reported_payment_method,$4)=' + "'Tarjeta' THEN COALESCE(card_last4,$6) ELSE card_last4 END," +
              'reported_institution=COALESCE(reported_institution,$7) WHERE id=$1',
              [prior.id, value.date, value.transactionTime ?? null, value.paymentMethod, value.cardType ?? null,
                value.cardLast4 ?? null, value.reportedInstitution ?? null],
            );
            if (value.paymentMethod) await client.query(
              'UPDATE transactions SET payment_method=$2 WHERE id=$1 AND payment_method IS NULL', [prior.movement_id, value.paymentMethod],
            );
          }
          await finishGmailDelivery(client, result.deliveryId!, result.attemptId!, 'skipped');
          return { outcome: 'duplicate' };
        }
      }
      if (fingerprints.length && (result.status === 'registered' || result.status === 'pending' && result.avalCopy)) {
        const value = result.status === 'registered' ? result.movement : result.evidence;
        const { rows: matches } = await client.query<ReferencedMovement>(
          'SELECT DISTINCT n.id,t.amount_minor::text,t.currency,t.transaction_date::text,t.direction ' +
          'FROM gmail_operation_references s JOIN notices n ON n.id=s.notice_id JOIN mailboxes m ON m.id=n.mailbox_id ' +
          'JOIN transactions t ON t.notice_id=n.id ' +
          "WHERE s.fingerprint=ANY($1::text[]) AND m.account_id=$2 AND n.status='registered' " +
          'AND (n.mailbox_id<>$3 OR n.message_id<>$4) LIMIT 2',
          [fingerprints, mailbox.account_id, mailbox.id, result.messageId],
        );
        const matched = matches[0];
        if (matched && matches.length === 1 && value && matched.amount_minor === value.amountMinor && matched.currency === value.currency &&
            matched.direction === (value.direction ?? (result.status === 'pending' && result.avalCopy ? 'expense' : null)) &&
            (matched.transaction_date === value.date || value.date === null && result.status === 'pending' && result.avalCopy)) {
          await saveFingerprints(client, matched.id, fingerprints);
          if (result.status === 'registered' && result.categoryFromPseConcept) {
            await client.query('UPDATE transactions t SET category=$2 FROM notices n WHERE n.id=$1 ' +
              "AND t.notice_id=n.id AND n.reason IS DISTINCT FROM 'user_confirmed' AND t.category IS DISTINCT FROM $2 " +
              'AND NOT EXISTS (SELECT 1 FROM email_movement_adjustments a WHERE a.movement_id=t.id)',
              [matched.id, result.movement.category]);
          }
          await discardUnregisteredNotices(client, 'AND n.mailbox_id=$2 AND n.message_id=$3',
            ['verified_duplicate', mailbox.id, result.messageId]);
          if (oauth) await finishGmailDelivery(client, result.deliveryId!, result.attemptId!, 'skipped');
          return { outcome: 'duplicate' };
        }
        if (matched && result.status === 'registered') result = duplicateForReview(result);
      }
      if (reprocessId && result.status === 'registered') {
          const value = result.movement;
          const matched = await client.query(
            'SELECT 1 FROM confirmed_movements m WHERE m.account_id=$1 AND m.currency=$2 AND m.direction=$3 ' +
            'AND ((m.amount_minor=$4 AND m.transaction_date=$5) OR ' +
            '(m.original_amount_minor=$4 AND m.original_transaction_date=$5)) ' +
            'AND NOT EXISTS (SELECT 1 FROM notices n WHERE n.id=m.notice_id AND n.mailbox_id=$6 AND n.message_id=$7) LIMIT 1',
            [mailbox.account_id, value.currency, value.direction, value.amountMinor, value.date, mailbox.id, result.messageId],
          );
          if (matched.rowCount) result = duplicateForReview(result);
      }
      let outcome = 'ignored';
      let reprocessOutcome: ReprocessOutcome = result.status;
      if (result.status !== 'ignored') {
        const evidence = result.status === 'registered' ? result.movement : result.status === 'pending' ? result.evidence : undefined;
        const suggested = result.status === 'pending' ? result.evidence : undefined;
        const { rows: [saved] } = await client.query<{ id: string }>(
          'INSERT INTO notices (mailbox_id,message_id,received_at,provider,forwarded,status,reason,confidence,accepted_at,completed_at,unconfirmed_fields,' +
          'reported_transaction_date,transaction_time,reported_payment_method,card_type,card_last4,reported_institution,' +
          'reported_amount_minor,reported_currency,reported_direction,avalpay_partial) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,LEAST($9,clock_timestamp()),clock_timestamp(),$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$21) ' +
          'ON CONFLICT (mailbox_id,message_id) DO UPDATE SET ' +
          '(provider,forwarded,status,reason,confidence,accepted_at,completed_at,unconfirmed_fields,' +
          'reported_transaction_date,transaction_time,reported_payment_method,card_type,card_last4,reported_institution,' +
          'reported_amount_minor,reported_currency,reported_direction,avalpay_partial)=' +
          '(excluded.provider,excluded.forwarded,excluded.status,excluded.reason,excluded.confidence,excluded.accepted_at,' +
          'excluded.completed_at,excluded.unconfirmed_fields,excluded.reported_transaction_date,excluded.transaction_time,' +
          'excluded.reported_payment_method,excluded.card_type,excluded.card_last4,excluded.reported_institution,' +
          'excluded.reported_amount_minor,excluded.reported_currency,excluded.reported_direction,excluded.avalpay_partial) ' +
          "WHERE $20::uuid IS NOT NULL AND notices.status IN ('pending','error') " +
          "AND (notices.status<>'pending' OR excluded.status<>'error') " +
          'AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.notice_id=notices.id) RETURNING id',
          [mailbox.id, result.messageId, received, result.provider, result.forwarded, result.status,
            'reason' in result ? result.reason : null, result.confidence, accepted,
            result.status === 'pending' ? result.unconfirmedFields ?? null : null,
            evidence?.date ?? null, evidence?.transactionTime ?? null, evidence?.paymentMethod ?? null,
            evidence?.cardType ?? null, evidence?.cardLast4 ?? null, evidence?.reportedInstitution ?? null,
            suggested?.amountMinor ?? null, suggested?.currency ?? null, suggested?.direction ?? null, reprocessId,
            result.status === 'pending' && result.avalCopy === true],
        );
        if (saved) {
          if (reprocessId && result.status !== 'error') {
            await client.query('DELETE FROM gmail_operation_references WHERE notice_id=$1', [saved.id]);
          }
          await saveFingerprints(client, saved.id, fingerprints);
          await saveNoticeEffects(client, this.config, mailbox.account_id, saved.id, result, result.provider, !reprocessId);
          if (result.status === 'registered') await discardAvalCopies(client, mailbox.account_id, saved.id, result.movement,
            fingerprints, result.references);
        }
        outcome = saved ? 'stored' : 'duplicate';
        if (!saved) reprocessOutcome = 'skipped';
      }
      if (reprocessId && result.status === 'ignored' && explicitNonMovement) {
        if (await discardUnregisteredNotices(client, 'AND n.mailbox_id=$2 AND n.message_id=$3',
          ['not_transaction', mailbox.id, result.messageId])) outcome = 'stored';
      }
      if (reprocessId && (reprocessOutcome === 'skipped' || reprocessOutcome === 'ignored')) {
        const existing = await client.query(
          "SELECT 1 FROM notices WHERE mailbox_id=$1 AND message_id=$2 AND status='pending'", [mailbox.id, result.messageId],
        );
        if (existing.rowCount) reprocessOutcome = 'pending';
      }
      if (oauth) await finishGmailDelivery(client, result.deliveryId!, result.attemptId!, reprocessOutcome);
      return { outcome };
    });
    logGmailDelivery(response.outcome === 'stored' ? result.status : retryReplayed ? 'retry_replayed' : response.outcome,
      'reason' in result ? result.reason : undefined, attempts, startedAt);
    return response;
  }
}

type NoticeEffect = { status: 'registered'; movement: z.infer<typeof movement> } |
  { status: 'pending'; reason: string } | { status: 'error' };

export async function saveNoticeEffects(client: PoolClient, config: Config, owner: string, noticeId: string,
  result: NoticeEffect, provider: typeof providers[number], notify = true) {
  if (result.status === 'registered') {
    const m = result.movement;
    await client.query(
      'INSERT INTO transactions (notice_id,amount_minor,currency,transaction_date,payment_method,description,category,direction) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (notice_id) DO NOTHING',
      [noticeId, m.amountMinor, m.currency, m.date, m.paymentMethod, redact(m.description), m.category, m.direction],
    );
    if (notify) await queueMail(client, config, owner, 'registered:' + noticeId, 'Movimiento registrado',
      'Registramos un movimiento de tu buzón vinculado. Consulta el detalle en ' + config.origin);
  } else if (notify && result.status === 'pending' && provider !== 'other' && result.reason !== 'unverified_sender') {
    await queueMail(client, config, owner, 'pending:' + noticeId, 'Aviso pendiente',
      'No pudimos confirmar todos los datos. Compara el aviso con el movimiento en tu entidad y revísalo en ' + config.origin);
  }
}
