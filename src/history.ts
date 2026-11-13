import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DateTime } from 'luxon';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Agent, intent } from './agent.js';
import { Database } from './db.js';
import { categories, category, day, normalize, redact, statuses, timezone } from './extraction.js';
import { Finance, manualInput, manualValues } from './finance.js';

export const filtersSchema = z.object({ from: day.optional(), to: day.optional(), category: category.optional() });
export const historySchema = filtersSchema.extend({
  status: statuses.optional(),
  unregistered: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const chatInput = z.object({ message: z.string().trim().min(1).max(1000) });
type Filters = z.infer<typeof filtersSchema>;
type ChatFilters = Filters & { kind?: 'income' | 'expense' | 'comparison'; currency?: 'COP' | 'USD' | 'EUR' };
const noticeCategory = 'coalesce(a.category,t.category)';
const noticePeriodDate = "coalesce(a.transaction_date,t.transaction_date,(n.received_at AT TIME ZONE 'America/Bogota')::date)";
const selection = 'n.id,n.provider,n.forwarded,n.received_at,n.status,n.reason,n.confidence,' +
  'coalesce(a.amount_minor,t.amount_minor)::text AS amount_minor,t.currency,' +
  'coalesce(a.transaction_date,t.transaction_date)::text AS transaction_date,t.payment_method,t.description,' +
  noticeCategory + ' AS category,t.direction';
const noticeSource = 'FROM notices n JOIN mailboxes m ON m.id=n.mailbox_id LEFT JOIN transactions t ON t.notice_id=n.id ' +
  "LEFT JOIN email_movement_adjustments a ON a.movement_id=t.id AND n.status='registered' ";
const reviewFields = ['amount_minor', 'currency', 'transaction_date', 'payment_method', 'description', 'category', 'direction'];

function range(filters: Filters) {
  if (filters.from && filters.to && filters.from > filters.to) throw new BadRequestException('El periodo es inválido.');
}

async function lockNotice(client: PoolClient, account: string, id: string) {
  const { rows: [notice] } = await client.query<{ status: string; reason: string | null }>(
    'SELECT n.status,n.reason FROM notices n JOIN mailboxes m ON m.id=n.mailbox_id ' +
    'WHERE m.account_id=$1 AND n.id=$2 FOR UPDATE OF n', [account, id],
  );
  if (!notice) throw new NotFoundException('Aviso no encontrado.');
  return notice;
}

@Injectable()
export class History {
  constructor(
    @Inject(Database) private readonly db: Database, @Inject(Agent) private readonly agent: Agent,
    @Inject(Finance) private readonly finance: Finance,
  ) {}

  async list(account: string, filters: z.infer<typeof historySchema>) {
    range(filters);
    const values = [
      account, filters.from ?? null, filters.to ?? null, filters.category ?? null, filters.status ?? null,
      filters.limit + 1, (filters.page - 1) * filters.limit, filters.unregistered === 'true',
    ];
    const { rows } = await this.db.query(
      'SELECT ' + selection + ' ' + noticeSource + "WHERE m.account_id=$1 AND n.status<>'discarded' " +
      'AND ($2::date IS NULL OR ' + noticePeriodDate + '>=$2) AND ($3::date IS NULL OR ' + noticePeriodDate + '<=$3) ' +
      'AND ($4::text IS NULL OR ' + noticeCategory + "=$4) AND ($5::text IS NULL OR n.status=$5) AND (NOT $8::boolean OR n.status<>'registered') " +
      'ORDER BY n.received_at DESC,n.id DESC LIMIT $6 OFFSET $7', values,
    );
    return { items: rows.slice(0, filters.limit), page: filters.page, hasMore: rows.length > filters.limit };
  }

  async detail(account: string, id: string) {
    const { rows: [record] } = await this.db.query(
      'SELECT ' + selection + ',n.unconfirmed_fields,n.reported_transaction_date::text,n.transaction_time,' +
      'n.reported_payment_method,n.card_type,n.card_last4,n.reported_institution ' + noticeSource +
      "WHERE m.account_id=$1 AND n.id=$2 AND n.status<>'discarded'", [account, id],
    );
    if (!record) throw new NotFoundException('Aviso no encontrado.');
    return record;
  }

  async confirm(account: string, id: string, data: z.infer<typeof manualInput>) {
    const values = manualValues({ ...data,
      description: data.description ?? (data.direction === 'income' ? 'Ingreso por correo' : 'Gasto por correo'),
    });
    return this.db.transaction(async client => {
      const notice = await lockNotice(client, account, id);
      if (notice.status === 'pending') {
        const { rows: [movement] } = await client.query<{ id: string }>(
          'INSERT INTO transactions (notice_id,' + reviewFields.join(',') + ') VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ' +
          'ON CONFLICT (notice_id) DO UPDATE SET (' + reviewFields.join(',') + ')=(' +
          reviewFields.map(field => 'excluded.' + field).join(',') + ') RETURNING id', [id, ...values],
        );
        await client.query(
          "UPDATE notices SET status='registered',reason='user_confirmed',unconfirmed_fields=NULL WHERE id=$1", [id],
        );
        return movement;
      }
      if (notice.status === 'registered' && notice.reason === 'user_confirmed') {
        const { rows: [movement] } = await client.query<{ id: string }>(
          'SELECT id FROM transactions WHERE notice_id=$1 AND (' + reviewFields.join(',') + ') IS NOT DISTINCT FROM ' +
          '($2::bigint,$3::char(3),$4::date,$5::text,$6::text,$7::text,$8::text)', [id, ...values],
        );
        if (movement) return movement;
      }
      throw new ConflictException('El aviso ya no está pendiente.');
    });
  }

  async discard(account: string, id: string) {
    await this.db.transaction(async client => {
      const notice = await lockNotice(client, account, id);
      if (notice.status === 'discarded') return;
      if (notice.status !== 'pending') throw new ConflictException('El aviso ya no está pendiente.');
      await client.query(
        "UPDATE notices SET status='discarded',reason='user_discarded',unconfirmed_fields=NULL WHERE id=$1", [id],
      );
    });
  }

  async summary(account: string, filters: Filters) {
    range(filters);
    const { rows } = await this.db.query<{ currency: string; category: string | null; amount_minor: string; count: number }>(
      'SELECT currency,category,sum(amount_minor)::text AS amount_minor,count(*)::int AS count FROM confirmed_movements ' +
      "WHERE account_id=$1 AND source='email' AND direction='expense' " +
      'AND ($2::date IS NULL OR transaction_date>=$2) AND ($3::date IS NULL OR transaction_date<=$3) ' +
      'AND ($4::text IS NULL OR category=$4) GROUP BY GROUPING SETS ((currency),(currency,category)) ' +
      'ORDER BY currency,category NULLS FIRST', [account, filters.from ?? null, filters.to ?? null, filters.category ?? null],
    );
    return { totals: rows.filter(row => !row.category), categories: rows.filter(row => row.category) };
  }

  async newChat(account: string) {
    const { rows } = await this.db.query(
      'INSERT INTO chat_sessions (account_id) VALUES ($1) RETURNING id,created_at', [account],
    );
    return rows[0];
  }

  async chats(account: string) {
    return (await this.db.query(
      'SELECT id,created_at FROM chat_sessions WHERE account_id=$1 ORDER BY created_at DESC LIMIT 50', [account],
    )).rows;
  }

  async turns(account: string, session: string) {
    await this.assertChat(account, session);
    const { rows } = await this.db.query(
      "SELECT question,answer,created_at,ui_action AS action,CASE WHEN filters->>'from' IS NOT NULL AND " +
      "filters->>'to' IS NOT NULL THEN jsonb_build_object('from',filters->>'from','to',filters->>'to'," +
      "'currency',filters->>'currency') END AS range FROM chat_turns WHERE session_id=$1 ORDER BY id DESC LIMIT 100", [session],
    );
    return rows.reverse();
  }

  async chat(account: string, session: string, question: string) {
    await this.assertChat(account, session);
    const { rows: [last] } = await this.db.query<{ filters: ChatFilters }>(
      'SELECT filters FROM chat_turns WHERE session_id=$1 AND filters IS NOT NULL ORDER BY id DESC LIMIT 1', [session],
    );
    const previous = last?.filters;
    let parsed: z.infer<typeof intent>;
    const message = redact(question);
    const rule = localIntent(message);
    const finance = chatKind(question);
    try {
      parsed = intent.parse(await this.agent.understand(message, !!previous));
      if (rule.action === 'register' || parsed.action === 'unknown' ||
          (rule.action === 'summary' && (finance || rule.category || rule.date || rule.period !== 'inherit'))) parsed = rule;
      parsed.date = rule.date;
    } catch {
      parsed = rule;
    }
    let response: string;
    let filters: ChatFilters | undefined;
    if (parsed.action === 'register') {
      response = 'Abre «Registrar movimiento» para añadir un ingreso o gasto manual. Reenvía el aviso bancario original al Gmail vinculado para registrarlo por correo.';
    } else if (parsed.action === 'summary') {
      filters = chatFilters(parsed, previous);
      filters.kind = finance ?? (parsed.category === 'ingresos' ? 'income' :
        parsed.category ? 'expense' : previous?.kind ?? 'expense');
      const currency = normalize(question).match(/\b(cop|usd|eur|dolares|euros)\b/)?.[1];
      filters.currency = currency === 'cop' ? 'COP' : currency === 'usd' || currency === 'dolares' ? 'USD' :
        currency ? 'EUR' : previous?.currency;
      if (filters.kind !== 'expense') delete filters.category;
      const report = (await this.finance.byCurrency(account, filters)).filter(row =>
        filters?.kind === 'comparison' || (filters?.kind === 'income' ? row.incomeMinor !== '0' : row.expenseMinor !== '0'));
      const period = filters.from ? filters.from + ' a ' + filters.to : 'Todo el historial';
      const kind = filters.kind === 'comparison' ? 'ingresos y gastos' : filters.kind === 'income' ? 'ingresos' : 'gastos';
      if (!report.length) {
        response = period + (filters.currency ? ' · ' + filters.currency : '') + '. No hay ' + kind + ' registrados para la consulta.';
      } else {
        const totals = report.map(row => filters?.kind === 'comparison' ?
          row.currency + ' — Ingresos ' + formatMinor(row.incomeMinor) + ', gastos ' + formatMinor(row.expenseMinor) +
          ', balance ' + formatMinor(row.balanceMinor) :
          row.currency + ' ' + formatMinor(filters?.kind === 'income' ? row.incomeMinor : row.expenseMinor));
        const parts = filters.kind === 'expense' ? report.flatMap(row => row.categories.map(part =>
          part.key + ' · ' + row.currency + ' ' + formatMinor(part.amountMinor))) : [];
        response = 'Total de ' + kind + ' (' + period + '): ' + totals.join(' · ') + '.' +
          (parts.length ? ' Por categoría: ' + parts.join(' · ') + '.' : '');
      }
    } else {
      response = 'Puedo resumir tus ingresos y gastos. Prueba «¿cuánto ingresó este mes?» o «compara mis ingresos y gastos».';
    }
    const action = parsed.action === 'register' ? 'register' : filters ? 'analysis' : null;
    await this.db.query(
      'INSERT INTO chat_turns (session_id,question,answer,filters,ui_action) ' +
      'SELECT id,$3,$4,$5,$6 FROM chat_sessions WHERE id=$1 AND account_id=$2',
      [session, account, message, response, filters ? JSON.stringify(filters) : null, action],
    );
    return { answer: response, action,
      range: filters?.from && filters.to ? { from: filters.from, to: filters.to, currency: filters.currency } : null };
  }

  private async assertChat(account: string, session: string) {
    if (!(await this.db.query('SELECT 1 FROM chat_sessions WHERE account_id=$1 AND id=$2', [account, session])).rowCount) {
      throw new NotFoundException('Conversación no encontrada.');
    }
  }
}

export function localIntent(question: string): z.infer<typeof intent> {
  const text = normalize(question);
  const categoryName = categories.find(value => new RegExp('\\b' + value + '\\b').test(text)) ??
    (/\b(?:ropa|calzado|vestuario|zapatos)\b/.test(text) ? 'compras' : null);
  const date = text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ?? null;
  const period = text.includes('ayer') ? 'yesterday' : text.includes('hoy') ? 'today' :
    /mes (pasado|anterior)/.test(text) ? 'last_month' : text.includes('semana') ? 'week' :
    text.includes('mes') ? 'month' : /historico|todo el historial|todos los gastos/.test(text) ? 'all' : 'inherit';
  const action = /\b(?:registra|registrar|anota|agrega|agregar|pague|compre|gaste)\b.*\d/.test(text) && !text.includes('cuanto') ||
    /\b(?:registra|registrar|anota|agrega|agregar)\b.*\b(?:gasto|pago|compra|ingreso|movimiento)\b/.test(text)
    ? 'register' : categoryName || date || period !== 'inherit' || chatKind(text) || /cuanto|total|resumen/.test(text) ? 'summary' : 'unknown';
  return { action, period, category: categoryName, date: date && day.safeParse(date).success ? date : null };
}

function chatFilters(parsed: z.infer<typeof intent>, previous?: Filters): Filters {
  const today = DateTime.now().setZone(timezone);
  const iso = (d: DateTime) => d.toISODate()!;
  const resolved: Filters = {};
  const period = parsed.period ?? 'inherit';
  if (parsed.date) Object.assign(resolved, { from: parsed.date, to: parsed.date });
  else if (period === 'today' || period === 'yesterday') {
    const date = iso(today.minus({ days: period === 'yesterday' ? 1 : 0 }));
    Object.assign(resolved, { from: date, to: date });
  } else if (period === 'week' || period === 'month') {
    Object.assign(resolved, { from: iso(today.startOf(period)), to: iso(today) });
  } else if (period === 'last_month') {
    const last = today.minus({ months: 1 });
    Object.assign(resolved, { from: iso(last.startOf('month')), to: iso(last.endOf('month')) });
  } else if (period === 'inherit') {
    Object.assign(resolved, previous ? { from: previous.from, to: previous.to } : { from: iso(today.startOf('month')), to: iso(today) });
  }
  resolved.category = parsed.category ?? (period === 'inherit' && !parsed.date ? previous?.category : undefined);
  return resolved;
}

function formatMinor(amount: string) {
  const value = BigInt(amount);
  const cents = value < 0n ? -value : value;
  return (value < 0n ? '−' : '') + new Intl.NumberFormat('es-CO').format(cents / 100n) + ',' +
    (cents % 100n).toString().padStart(2, '0');
}

function chatKind(question: string): ChatFilters['kind'] {
  const text = normalize(question);
  const income = /\b(?:ingres\w*|recibi\w*|entradas|abonos)\b/.test(text);
  const expense = /\b(?:gast\w*|egres\w*|salidas|pague)\b/.test(text);
  if ((income && expense) || /\bbalance\b/.test(text) || (!income && !expense && /\bcompara\w*\b/.test(text))) return 'comparison';
  return income ? 'income' : expense ? 'expense' : undefined;
}
