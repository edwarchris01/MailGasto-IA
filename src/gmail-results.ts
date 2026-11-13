import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { queueMail } from './accounts.js';
import { CONFIG, Config } from './config.js';
import { Database } from './db.js';
import { amountPattern, bankProviders, cardLast4Pattern, cardTypes, categories, currencies, directions,
  paymentMethods, providers, redact, transactionTimePattern, unconfirmedFields } from './mail-rules.js';

export const messageIdPattern = /^[A-Za-z0-9_-]{1,200}$/;
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
  ...identity, provider: z.enum(providers), forwarded: z.boolean(),
};
export const gmailResult = z.discriminatedUnion('status', [
  z.strictObject({ ...identity, status: z.literal('ignored') }),
  z.strictObject({ ...notice, status: z.literal('registered'), confidence: z.number().min(0.7).max(1), movement }),
  z.strictObject({ ...notice, status: z.literal('pending'), confidence: z.number().min(0).max(1),
    reason: z.enum(['missing_or_ambiguous_fields', 'unconfirmed_extraction', 'unverified_sender', 'possible_duplicate']),
    unconfirmedFields: z.array(z.enum(unconfirmedFields)).max(unconfirmedFields.length).optional(),
    evidence: pendingEvidence.optional() }),
  z.strictObject({ ...notice, status: z.literal('error'), confidence: z.literal(0), reason: z.literal('extractor_unavailable') }),
]).refine(value => (value.source === 'oauth'
  ? value.deliveryId !== undefined && value.attemptId !== undefined && value.startedAt === undefined
  : value.deliveryId === undefined && value.attemptId === undefined && value.startedAt !== undefined && value.status !== 'ignored') &&
  (value.status !== 'pending' || value.reason !== 'unverified_sender' || value.provider === 'other'));

type Result = z.infer<typeof gmailResult>;
type Mailbox = { id: string; account_id: string; state: string; generation: string; linked_at: Date; source: string };
type Delivery = { mailbox_id: string; generation: string; message_id: string; attempt_id: string | null;
  received_at: Date | null; accepted_at: Date; completed_at: Date | null;
  reprocess_id: string | null; from_at: Date | null; to_at: Date | null };

type ReprocessOutcome = 'registered' | 'pending' | 'ignored' | 'error' | 'skipped';

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

  async save(result: Result) {
    return this.db.transaction(async client => {
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
      if (oauth) {
        const { rows: [delivery] } = await client.query<Delivery>(
          'SELECT d.mailbox_id,d.generation,d.message_id,d.attempt_id,d.received_at,d.accepted_at,d.completed_at,' +
          'd.reprocess_id,r.from_at,r.to_at FROM gmail_deliveries d LEFT JOIN gmail_reprocess_runs r ON r.id=d.reprocess_id ' +
          'WHERE d.id=$1 FOR UPDATE OF d', [result.deliveryId],
        );
        if (!delivery || delivery.mailbox_id !== mailbox.id || delivery.generation !== mailbox.generation ||
            delivery.message_id !== result.messageId || delivery.attempt_id !== result.attemptId ||
            delivery.received_at?.getTime() !== received.getTime()) return { outcome: 'discarded' };
        if (delivery.completed_at) return { outcome: 'duplicate' };
        if (delivery.reprocess_id && (!delivery.from_at || !delivery.to_at ||
            received < delivery.from_at || received >= delivery.to_at)) return { outcome: 'discarded' };
        reprocessId = delivery.reprocess_id;
        accepted = delivery.accepted_at;
      }
      if (!reprocessId && received < mailbox.linked_at) return { outcome: 'discarded' };
      if (result.status === 'registered') {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1))', [mailbox.account_id]);
        if (reprocessId) {
          const { movement: value, ...notice } = result;
          const matched = await client.query(
            'SELECT 1 FROM confirmed_movements m WHERE m.account_id=$1 AND m.currency=$2 AND m.direction=$3 ' +
            'AND ((m.amount_minor=$4 AND m.transaction_date=$5) OR ' +
            '(m.original_amount_minor=$4 AND m.original_transaction_date=$5)) ' +
            'AND NOT EXISTS (SELECT 1 FROM notices n WHERE n.id=m.notice_id AND n.mailbox_id=$6 AND n.message_id=$7) LIMIT 1',
            [mailbox.account_id, value.currency, value.direction, value.amountMinor, value.date, mailbox.id, result.messageId],
          );
          if (matched.rowCount) {
            const { date, paymentMethod, transactionTime, cardType, cardLast4, reportedInstitution, amountMinor, currency, direction } = value;
            result = { ...notice, status: 'pending', reason: 'possible_duplicate',
              evidence: { date, paymentMethod, transactionTime, cardType, cardLast4, reportedInstitution, amountMinor, currency, direction } };
          }
        }
      }
      let outcome = 'ignored';
      let reprocessOutcome: ReprocessOutcome = result.status;
      if (result.status !== 'ignored') {
        const evidence = result.status === 'registered' ? result.movement : result.status === 'pending' ? result.evidence : undefined;
        const suggested = result.status === 'pending' ? result.evidence : undefined;
        const { rows: [saved] } = await client.query<{ id: string }>(
          'INSERT INTO notices (mailbox_id,message_id,received_at,provider,forwarded,status,reason,confidence,accepted_at,completed_at,unconfirmed_fields,' +
          'reported_transaction_date,transaction_time,reported_payment_method,card_type,card_last4,reported_institution,' +
          'reported_amount_minor,reported_currency,reported_direction) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,LEAST($9,clock_timestamp()),clock_timestamp(),$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ' +
          'ON CONFLICT (mailbox_id,message_id) DO UPDATE SET ' +
          '(provider,forwarded,status,reason,confidence,accepted_at,completed_at,unconfirmed_fields,' +
          'reported_transaction_date,transaction_time,reported_payment_method,card_type,card_last4,reported_institution,' +
          'reported_amount_minor,reported_currency,reported_direction)=' +
          '(excluded.provider,excluded.forwarded,excluded.status,excluded.reason,excluded.confidence,excluded.accepted_at,' +
          'excluded.completed_at,excluded.unconfirmed_fields,excluded.reported_transaction_date,excluded.transaction_time,' +
          'excluded.reported_payment_method,excluded.card_type,excluded.card_last4,excluded.reported_institution,' +
          'excluded.reported_amount_minor,excluded.reported_currency,excluded.reported_direction) ' +
          "WHERE $20::uuid IS NOT NULL AND notices.status IN ('pending','error') " +
          "AND (notices.status<>'pending' OR excluded.status<>'error') " +
          'AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.notice_id=notices.id) RETURNING id',
          [mailbox.id, result.messageId, received, result.provider, result.forwarded, result.status,
            'reason' in result ? result.reason : null, result.confidence, accepted,
            result.status === 'pending' ? result.unconfirmedFields ?? null : null,
            evidence?.date ?? null, evidence?.transactionTime ?? null, evidence?.paymentMethod ?? null,
            evidence?.cardType ?? null, evidence?.cardLast4 ?? null, evidence?.reportedInstitution ?? null,
            suggested?.amountMinor ?? null, suggested?.currency ?? null, suggested?.direction ?? null, reprocessId],
        );
        if (saved) await saveNoticeEffects(client, this.config, mailbox.account_id, saved.id, result, result.provider, !reprocessId);
        outcome = saved ? 'stored' : 'duplicate';
        if (!saved) reprocessOutcome = 'skipped';
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
      'No pudimos confirmar todos los datos. Reenvía el aviso bancario completo y original al buzón vinculado.');
  }
}
