import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DateTime } from 'luxon';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Database } from './db.js';
import { category, day, timezone } from './extraction.js';
import { currencies, directions } from './mail-rules.js';

const direction = z.enum(directions);
const currency = z.enum(currencies);
const movementAmount = z.string().regex(/^[1-9]\d{0,17}$/);
const maxRevision = 2_147_483_647;
const correctionPageSize = 25;
export const financeFilters = z.object({
  from: day.optional(), to: day.optional(), currency: currency.optional(), category: category.optional(),
});
export const movementFilters = financeFilters.extend({
  direction: direction.optional(),
  source: z.enum(['email', 'manual']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const analyticsInput = financeFilters.extend({ from: day, to: day, currency });
export const manualInput = z.object({
  amountMinor: movementAmount,
  currency, date: day, direction,
  category: category.optional(),
  paymentMethod: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().min(1).max(200).optional(),
}).refine(data => data.direction === 'income' ? !data.category || data.category === 'ingresos' :
  data.category != null && data.category !== 'ingresos');
export const emailDetailsInput = z.strictObject({
  category: category.optional(),
  note: z.string().trim().refine(value => value.length <= 400 && [...value].length <= 200 && !value.includes('\0'))
    .transform(value => value || null).nullable().optional(),
}).refine(data => data.category !== undefined || data.note !== undefined);
export const correctionInput = z.strictObject({
  revision: z.number().int().min(0).max(maxRevision),
  amountMinor: movementAmount.nullable().optional(),
  date: day.nullable().optional(),
}).refine(data => data.amountMinor !== undefined || data.date !== undefined);
export const correctionsQuery = z.object({
  beforeRevision: z.coerce.number().int().min(1).max(maxRevision).optional(),
});

type Filters = z.infer<typeof financeFilters>;
type Manual = z.infer<typeof manualInput>;
type Totals = { income: bigint; expense: bigint };
type AmountRow = {
  currency: string; date: string; category: string; direction: keyof Totals; source: string; amount: string;
};
type Movement = {
  id: string; source: string; amount_minor: string; currency: string; transaction_date: string; direction: string;
  note: string | null; original_amount_minor: string | null; original_transaction_date: string | null;
  correction_revision: number | null;
};
type EmailOriginal = { amount_minor: string; transaction_date: string; category: string; direction: string };
type EmailAdjustment = { amount_minor: string | null; transaction_date: string | null; revision: number };
const fields = 'm.id,m.source,m.notice_id,m.provider,m.amount_minor::text,m.currency,m.transaction_date::text,' +
  'm.payment_method,m.description,m.category,m.direction';
const where = 'account_id=$1 AND ($2::date IS NULL OR transaction_date >= $2) ' +
  'AND ($3::date IS NULL OR transaction_date <= $3) AND ($4::text IS NULL OR currency=$4) ' +
  'AND ($5::text IS NULL OR category=$5)';
const totals = (): Totals => ({ income: 0n, expense: 0n });
const amounts = (t: Totals) => ({
  incomeMinor: t.income.toString(), expenseMinor: t.expense.toString(), balanceMinor: (t.income - t.expense).toString(),
});
const iso = (value: DateTime) => value.toISODate()!;
const localDay = (value: string) => DateTime.fromISO(value, { zone: timezone });

function filterValues(account: string, filter: Filters) {
  if (filter.from && filter.to && filter.from > filter.to) throw new BadRequestException('El periodo es inválido.');
  return [account, filter.from ?? null, filter.to ?? null, filter.currency ?? null, filter.category ?? null];
}

export function manualValues(data: Manual) {
  if (data.date.startsWith('0000-')) throw new BadRequestException('Selecciona una fecha válida.');
  if (data.date > iso(DateTime.now().setZone(timezone))) throw new BadRequestException('Selecciona la fecha de hoy o una anterior.');
  return [data.amountMinor, data.currency, data.date, data.paymentMethod ?? null, data.description ?? null,
    data.direction === 'income' ? 'ingresos' : data.category, data.direction];
}

async function lockEmailMovement(client: PoolClient, account: string, id: string) {
  const { rows: [original] } = await client.query<EmailOriginal>(
    'SELECT t.amount_minor::text,t.transaction_date::text,t.category,t.direction FROM transactions t ' +
    'JOIN notices n ON n.id=t.notice_id JOIN mailboxes m ON m.id=n.mailbox_id ' +
    "WHERE m.account_id=$1 AND t.id=$2 AND n.status='registered' FOR UPDATE OF t", [account, id],
  );
  if (!original) throw new NotFoundException('Movimiento de correo no encontrado.');
  return original;
}

@Injectable()
export class Finance {
  constructor(@Inject(Database) private readonly db: Database) {}

  async list(account: string, filter: z.infer<typeof movementFilters>) {
    const { rows } = await this.db.query(
      'SELECT ' + fields + ' FROM confirmed_movements m WHERE ' + where +
      ' AND ($6::text IS NULL OR direction=$6) AND ($7::text IS NULL OR source=$7)' +
      ' ORDER BY transaction_date DESC,id DESC LIMIT $8 OFFSET $9',
      [...filterValues(account, filter), filter.direction ?? null, filter.source ?? null, filter.limit + 1,
        (filter.page - 1) * filter.limit],
    );
    return { items: rows.slice(0, filter.limit), hasMore: rows.length > filter.limit, page: filter.page };
  }

  async detail(account: string, id: string) {
    const { rows: [movement] } = await this.db.query<Movement>(
      'SELECT ' + fields + ',m.note,m.original_amount_minor::text,m.original_transaction_date::text,m.correction_revision,' +
      'n.reported_transaction_date::text,n.transaction_time,n.reported_institution,' +
      "CASE WHEN lower(m.payment_method)='tarjeta' THEN n.card_type END AS card_type," +
      "CASE WHEN lower(m.payment_method)='tarjeta' THEN n.card_last4 END AS card_last4 " +
      'FROM confirmed_movements m LEFT JOIN notices n ON n.id=m.notice_id WHERE m.account_id=$1 AND m.id=$2', [account, id],
    );
    if (!movement) throw new NotFoundException('Movimiento no encontrado.');
    const { rows: matches } = await this.db.query(
      'SELECT ' + fields + ' FROM confirmed_movements m WHERE account_id=$1 AND source<>$2 AND amount_minor=$3 ' +
      'AND currency=$4 AND transaction_date=$5 AND direction=$6 ORDER BY id LIMIT 25',
      [account, movement.source, movement.amount_minor, movement.currency, movement.transaction_date, movement.direction],
    );
    const { note, original_amount_minor, original_transaction_date, correction_revision, ...details } = movement;
    return movement.source === 'email'
      ? { ...details, note, original_amount_minor, original_transaction_date, correction_revision, matches }
      : { ...details, matches };
  }

  async editEmailDetails(account: string, id: string, data: z.infer<typeof emailDetailsInput>) {
    await this.db.transaction(async client => {
      const original = await lockEmailMovement(client, account, id);
      if (data.category !== undefined && (original.direction === 'income') !== (data.category === 'ingresos')) {
        throw new BadRequestException('Selecciona una categoría válida para este movimiento.');
      }
      await client.query(
        'INSERT INTO email_movement_adjustments (movement_id,category,note) VALUES ($1,$2,$3) ' +
        'ON CONFLICT (movement_id) DO UPDATE SET ' +
        'category=CASE WHEN $4 THEN excluded.category ELSE email_movement_adjustments.category END,' +
        'note=CASE WHEN $5 THEN excluded.note ELSE email_movement_adjustments.note END',
        [id, data.category === original.category ? null : data.category ?? null, data.note ?? null,
          data.category !== undefined, data.note !== undefined],
      );
    });
  }

  async correctEmailMovement(account: string, id: string, data: z.infer<typeof correctionInput>) {
    if (data.date && (data.date < '1900-01-01' || data.date > iso(DateTime.now().setZone(timezone)))) {
      throw new BadRequestException('Selecciona una fecha entre 1900 y hoy.');
    }
    await this.db.transaction(async client => {
      const original = await lockEmailMovement(client, account, id);
      const { rows: [adjustment] } = await client.query<EmailAdjustment>(
        'SELECT amount_minor::text,transaction_date::text,revision FROM email_movement_adjustments WHERE movement_id=$1', [id],
      );
      const amount = adjustment?.amount_minor ?? original.amount_minor;
      const date = adjustment?.transaction_date ?? original.transaction_date;
      const nextAmount = data.amountMinor === undefined ? amount : data.amountMinor ?? original.amount_minor;
      const nextDate = data.date === undefined ? date : data.date ?? original.transaction_date;
      if (nextAmount === amount && nextDate === date) return;

      const revision = adjustment?.revision ?? 0;
      if (data.revision !== revision) {
        throw new ConflictException('El movimiento cambió en otra sesión. Recarga los datos para continuar.');
      }
      await client.query(
        'INSERT INTO email_movement_adjustments (movement_id,amount_minor,transaction_date,revision) VALUES ($1,$2,$3,$4) ' +
        'ON CONFLICT (movement_id) DO UPDATE SET ' +
        '(amount_minor,transaction_date,revision)=(excluded.amount_minor,excluded.transaction_date,excluded.revision)',
        [id, nextAmount === original.amount_minor ? null : nextAmount,
          nextDate === original.transaction_date ? null : nextDate, revision + 1],
      );
      await client.query(
        'INSERT INTO email_movement_corrections ' +
        '(movement_id,revision,previous_amount_minor,amount_minor,previous_transaction_date,transaction_date) ' +
        'VALUES ($1,$2,$3,$4,$5,$6)', [id, revision + 1, amount, nextAmount, date, nextDate],
      );
    });
  }

  async emailCorrections(account: string, id: string, beforeRevision?: number) {
    const { rows } = await this.db.query<{ revision: number | null }>(
      'SELECT c.revision,c.corrected_at,c.previous_amount_minor::text,c.amount_minor::text,' +
      'c.previous_transaction_date::text,c.transaction_date::text FROM confirmed_movements m ' +
      'LEFT JOIN email_movement_corrections c ON c.movement_id=m.id AND ($3::int IS NULL OR c.revision<$3) ' +
      "WHERE m.account_id=$1 AND m.id=$2 AND m.source='email' ORDER BY c.revision DESC LIMIT $4",
      [account, id, beforeRevision ?? null, correctionPageSize + 1],
    );
    if (!rows.length) throw new NotFoundException('Movimiento de correo no encontrado.');
    const items = rows[0].revision === null ? [] : rows.slice(0, correctionPageSize);
    return { items, nextBeforeRevision: rows.length > correctionPageSize ? items.at(-1)!.revision : null };
  }

  async add(account: string, requestId: string, data: Manual) {
    const { rows: [created] } = await this.db.query<{ id: string }>(
      'INSERT INTO manual_movements (account_id,request_id,amount_minor,currency,transaction_date,payment_method,description,category,direction) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (account_id,request_id) DO NOTHING RETURNING id',
      [account, requestId, ...manualValues(data)],
    );
    if (created) return created;
    const { rows: [existing] } = await this.db.query<{ id: string }>(
      'SELECT id FROM manual_movements WHERE account_id=$1 AND request_id=$2', [account, requestId],
    );
    if (!existing) throw new NotFoundException('El movimiento ya no está disponible.');
    return existing;
  }

  async edit(account: string, id: string, data: Manual) {
    const result = await this.db.query(
      'UPDATE manual_movements SET (amount_minor,currency,transaction_date,payment_method,description,category,direction)=' +
      '($3,$4,$5,$6,$7,$8,$9) WHERE account_id=$1 AND id=$2',
      [account, id, ...manualValues(data)],
    );
    if (!result.rowCount) throw new NotFoundException('Movimiento manual no encontrado.');
  }

  async remove(account: string, id: string) {
    const result = await this.db.query('DELETE FROM manual_movements WHERE account_id=$1 AND id=$2', [account, id]);
    if (!result.rowCount) throw new NotFoundException('Movimiento manual no encontrado.');
  }

  private async grouped(account: string, filter: Filters) {
    const { rows } = await this.db.query<AmountRow>(
      'SELECT currency,transaction_date::text AS date,category,direction,source,sum(amount_minor)::text AS amount ' +
      'FROM confirmed_movements WHERE ' + where + ' GROUP BY currency,transaction_date,category,direction,source',
      filterValues(account, filter),
    );
    return rows;
  }

  async byCurrency(account: string, filter: Filters) {
    const groups = new Map<string, { totals: Totals; expenses: Map<string, bigint> }>();
    for (const row of await this.grouped(account, filter)) {
      const group = groups.get(row.currency) ?? { totals: totals(), expenses: new Map<string, bigint>() };
      const amount = BigInt(row.amount);
      group.totals[row.direction] += amount;
      if (row.direction === 'expense') addAmount(group.expenses, row.category, amount);
      groups.set(row.currency, group);
    }
    return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([code, group]) => ({
      currency: code, ...amounts(group.totals), categories: breakdown(group.expenses),
    }));
  }

  async analytics(account: string, filter: z.infer<typeof analyticsInput>) {
    const start = localDay(filter.from);
    const end = localDay(filter.to);
    const days = end.diff(start, 'days').days + 1;
    if (days < 1 || days > 36600) throw new BadRequestException('Selecciona un periodo válido de hasta 100 años.');
    const interval = days <= 14 ? 'day' : days <= 90 ? 'week' : 'month';
    const all = totals();
    const buckets = new Map<string, Totals>();
    const expenses = new Map<string, bigint>();
    const incomes = new Map<string, bigint>();
    for (const row of await this.grouped(account, filter)) {
      const key = iso(localDay(row.date).startOf(interval));
      const bucket = buckets.get(key) ?? totals();
      const amount = BigInt(row.amount);
      bucket[row.direction] += amount;
      all[row.direction] += amount;
      buckets.set(key, bucket);
      if (row.direction === 'expense') addAmount(expenses, row.category, amount);
      else addAmount(incomes, row.source, amount);
    }
    const series = [];
    for (let cursor = start.startOf(interval); cursor <= end; cursor = cursor.plus({ [interval]: 1 })) {
      const bucketEnd = cursor.endOf(interval).startOf('day');
      series.push({
        from: iso(cursor < start ? start : cursor), to: iso(bucketEnd > end ? end : bucketEnd),
        ...amounts(buckets.get(iso(cursor)) ?? totals()),
      });
    }
    return { from: filter.from, to: filter.to, currency: filter.currency, interval, ...amounts(all),
      series, expenseCategories: breakdown(expenses), incomeSources: breakdown(incomes) };
  }
}

function addAmount(group: Map<string, bigint>, key: string, amount: bigint) {
  group.set(key, (group.get(key) ?? 0n) + amount);
}

function breakdown(group: Map<string, bigint>) {
  return [...group].sort(([a, left], [b, right]) => left === right ? a.localeCompare(b) : left > right ? -1 : 1)
    .map(([key, amount]) => ({ key, amountMinor: amount.toString() }));
}
