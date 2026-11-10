import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { queueMail } from './accounts.js';
import { CONFIG, Config } from './config.js';
import { Database } from './db.js';
import { amountPattern, bankProviders, categories, currencies, directions, paymentMethods, providers, redact, unconfirmedFields } from './mail-rules.js';

export const messageIdPattern = /^[A-Za-z0-9_-]{1,200}$/;
const timestamp = z.iso.datetime({ offset: true });
const movement = z.strictObject({
  amountMinor: z.string().regex(amountPattern),
  currency: z.enum(currencies),
  date: z.iso.date().refine(value => !value.startsWith('0000')),
  paymentMethod: z.enum(paymentMethods),
  description: z.string().trim().min(1).max(160),
  category: z.enum(categories),
  direction: z.enum(directions),
}).refine(value => (value.direction === 'income') === (value.category === 'ingresos'));
const identity = {
  source: z.enum(['legacy', 'oauth']),
  messageId: z.string().regex(messageIdPattern),
  receivedAt: timestamp,
  startedAt: timestamp.optional(),
  deliveryId: z.uuid().optional(),
  attemptId: z.uuid().optional(),
};
const notice = {
  ...identity, provider: z.enum(bankProviders), forwarded: z.boolean(),
};
export const gmailResult = z.discriminatedUnion('status', [
  z.strictObject({ ...identity, status: z.literal('ignored') }),
  z.strictObject({ ...notice, status: z.literal('registered'), confidence: z.number().min(0.7).max(1), movement }),
  z.strictObject({ ...notice, provider: z.enum(providers), status: z.literal('pending'), confidence: z.number().min(0).max(1),
    reason: z.enum(['missing_or_ambiguous_fields', 'unconfirmed_extraction', 'unverified_sender']),
    unconfirmedFields: z.array(z.enum(unconfirmedFields)).max(unconfirmedFields.length).optional() }),
  z.strictObject({ ...notice, status: z.literal('error'), confidence: z.literal(0), reason: z.literal('extractor_unavailable') }),
]).refine(value => (value.source === 'oauth'
  ? value.deliveryId !== undefined && value.attemptId !== undefined && value.startedAt === undefined
  : value.deliveryId === undefined && value.attemptId === undefined && value.startedAt !== undefined && value.status !== 'ignored') &&
  (value.status !== 'pending' || (value.provider === 'other') === (value.reason === 'unverified_sender')));

type Result = z.infer<typeof gmailResult>;
type Mailbox = { id: string; account_id: string; state: string; generation: string; linked_at: Date; source: string };
type Delivery = { mailbox_id: string; generation: string; message_id: string; attempt_id: string | null;
  received_at: Date | null; accepted_at: Date; completed_at: Date | null };

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
      if (!mailbox || mailbox.state !== 'active' || received < mailbox.linked_at) return { outcome: 'discarded' };
      let accepted = new Date(Math.min(Date.now(), Math.max(+received, Date.parse(result.startedAt ?? result.receivedAt))));
      if (oauth) {
        const { rows: [delivery] } = await client.query<Delivery>(
          'SELECT mailbox_id,generation,message_id,attempt_id,received_at,accepted_at,completed_at ' +
          'FROM gmail_deliveries WHERE id=$1 FOR UPDATE', [result.deliveryId],
        );
        if (!delivery || delivery.mailbox_id !== mailbox.id || delivery.generation !== mailbox.generation ||
            delivery.message_id !== result.messageId || delivery.attempt_id !== result.attemptId ||
            delivery.received_at?.getTime() !== received.getTime()) return { outcome: 'discarded' };
        if (delivery.completed_at) return { outcome: 'duplicate' };
        accepted = delivery.accepted_at;
      }
      let outcome = 'ignored';
      if (result.status !== 'ignored') {
        const { rows: [saved] } = await client.query<{ id: string }>(
          'INSERT INTO notices (mailbox_id,message_id,received_at,provider,forwarded,status,reason,confidence,accepted_at,completed_at,unconfirmed_fields) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,LEAST($9,clock_timestamp()),clock_timestamp(),$10) ' +
          'ON CONFLICT (mailbox_id,message_id) DO NOTHING RETURNING id',
          [mailbox.id, result.messageId, received, result.provider, result.forwarded, result.status,
            'reason' in result ? result.reason : null, result.confidence, accepted,
            result.status === 'pending' ? result.unconfirmedFields ?? null : null],
        );
        if (saved) await saveNoticeEffects(client, this.config, mailbox.account_id, saved.id, result);
        outcome = saved ? 'stored' : 'duplicate';
      }
      if (oauth) await client.query('UPDATE gmail_deliveries SET completed_at=clock_timestamp() WHERE id=$1', [result.deliveryId]);
      return { outcome };
    });
  }
}

type NoticeEffect = { status: 'registered'; movement: Record<keyof z.infer<typeof movement>, string> } |
  { status: 'pending'; reason: string } | { status: 'error' };

export async function saveNoticeEffects(client: PoolClient, config: Config, owner: string, noticeId: string, result: NoticeEffect) {
  if (result.status === 'registered') {
    const m = result.movement;
    await client.query(
      'INSERT INTO transactions (notice_id,amount_minor,currency,transaction_date,payment_method,description,category,direction) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (notice_id) DO NOTHING',
      [noticeId, m.amountMinor, m.currency, m.date, m.paymentMethod, redact(m.description), m.category, m.direction],
    );
    await queueMail(client, config, owner, 'registered:' + noticeId, 'Movimiento registrado',
      'Registramos un movimiento de tu buzón vinculado. Consulta el detalle en ' + config.origin);
  } else if (result.status === 'pending' && result.reason !== 'unverified_sender') {
    await queueMail(client, config, owner, 'pending:' + noticeId, 'Aviso pendiente',
      'No pudimos confirmar todos los datos. Reenvía el aviso bancario completo y original al buzón vinculado.');
  }
}
