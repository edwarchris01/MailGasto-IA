import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { Database } from './db.js';
import { category, day, timezone } from './extraction.js';
import { currencies, directions } from './mail-rules.js';

const direction = z.enum(directions);
const currency = z.enum(currencies);
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
  amountMinor: z.string().regex(/^[1-9]\d{0,17}$/),
  currency, date: day, direction,
  category: category.optional(),
  paymentMethod: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().min(1).max(200).optional(),
}).refine(data => data.direction === 'income' ? !data.category || data.category === 'ingresos' :
  data.category != null && data.category !== 'ingresos');

type Filters = z.infer<typeof financeFilters>;
type Manual = z.infer<typeof manualInput>;
type Totals = { income: bigint; expense: bigint };
type AmountRow = {
  currency: string; date: string; category: string; direction: keyof Totals; source: string; amount: string;
};
type Movement = {
  id: string; source: string; amount_minor: string; currency: string; transaction_date: string; direction: string;
};
const fields = 'id,source,notice_id,provider,amount_minor::text, currency, transaction_date::text, payment_method, description, category, direction';
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

@Injectable()
export class Finance {
  constructor(@Inject(Database) private readonly db: Database) {}

  async list(account: string, filter: z.infer<typeof movementFilters>) {
    const { rows } = await this.db.query(
      'SELECT ' + fields + ' FROM confirmed_movements WHERE ' + where +
      ' AND ($6::text IS NULL OR direction=$6) AND ($7::text IS NULL OR source=$7)' +
      ' ORDER BY transaction_date DESC,id DESC LIMIT $8 OFFSET $9',
      [...filterValues(account, filter), filter.direction ?? null, filter.source ?? null, filter.limit + 1,
        (filter.page - 1) * filter.limit],
    );
    return { items: rows.slice(0, filter.limit), hasMore: rows.length > filter.limit, page: filter.page };
  }

  async detail(account: string, id: string) {
    const { rows: [movement] } = await this.db.query<Movement>(
      'SELECT ' + fields + ' FROM confirmed_movements WHERE account_id=$1 AND id=$2', [account, id],
    );
    if (!movement) throw new NotFoundException('Movimiento no encontrado.');
    const { rows: matches } = await this.db.query(
      'SELECT ' + fields + ' FROM confirmed_movements WHERE account_id=$1 AND source<>$2 AND amount_minor=$3 ' +
      'AND currency=$4 AND transaction_date=$5 AND direction=$6 ORDER BY id LIMIT 25',
      [account, movement.source, movement.amount_minor, movement.currency, movement.transaction_date, movement.direction],
    );
    return { ...movement, matches };
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
