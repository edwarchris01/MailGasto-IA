// Pure rules shared by the n8n Code nodes and the drain for pre-existing notices.
// This module must not have runtime imports: workflows.mjs embeds it in n8n.
export const categories = ['alimentacion', 'transporte', 'vivienda', 'ocio', 'salud', 'educacion', 'ingresos', 'otros'] as const;
export type Category = typeof categories[number];
export type Provider = 'nequi' | 'bancolombia';
export type NoticeText = { provider: Provider; forwarded: boolean; text: string };
export type SenderMap = Readonly<Record<string, Provider>>;
export const normalize = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const bareAddress = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const forwardedHeader = /(?:^|\n)[ \t]*(?:-+\s*(?:forwarded message|mensaje reenviado|original message|mensaje original)\s*-+|begin forwarded message:)[ \t]*\n/i;
const transactionWords = /\b(?:compra|compraste|pago|pagaste|pag[oó]|transferencia|transferiste|enviaste|recibiste|consignaci[oó]n|retiro|retiraste|transacci[oó]n|movimiento|debitaron|abonaron)\b/i;
const excluded = /\b(?:codigo (?:de (?:seguridad|verificacion)|otp)|verifica tu identidad|intento (?:de inicio|de compra)|transaccion (?:rechazada|declinada|fallida)|compra (?:rechazada|declinada|fallida)|promocion(?:es)?|oferta exclusiva|estado de cuenta|extracto mensual|confirma si (?:hiciste|realizaste))\b/i;

export function redact(text: string) {
  return text
    .replace(/https?:\/\/[^\s<>]+|www\.[^\s<>]+/gi, '[enlace]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[correo]')
    .replace(/\b(?:cuenta|tarjeta|documento|referencia|autorizaci[oó]n|c[eé]dula|tel[eé]fono|celular|identificaci[oó]n|terminad[ao] en|c[oó]digo (?:de seguridad|de verificaci[oó]n|OTP))\s*(?:(?:n[uú]mero|no\.?|nro\.?|de|es)\s*)?[:#*xX -]*\d[\d* xX-]*/gi, match => match.replace(/[:#*xX -]*\d[\d* xX-]*$/, ' [identificador] '))
    .replace(/(?<![\d.,])\b(?:\d[ -]?){8,19}\d\b(?![\d.,])/g, '[identificador]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function address(value: string) {
  const mailbox = (value.match(/<([^<>]+)>\s*$/)?.[1] ?? value).trim().toLowerCase();
  return bareAddress.test(mailbox) ? mailbox : undefined;
}

export function candidate(from: string, subject: string, body: string, senders: SenderMap): NoticeText | null {
  if (/^\s*\[MailGasto IA\]/i.test(subject)) return null;
  let sender = address(from);
  let forwarded = false;
  body = body.replace(/\r\n?/g, '\n').slice(0, 30_000);
  const marker = forwardedHeader.exec(body);
  if (marker) {
    const original = body.slice(marker.index + marker[0].length);
    const end = /\n[ \t]*\n/.exec(original);
    if (!end || end.index > 2000) return null;
    const header = original.slice(0, end.index);
    sender = address(header.match(/^(?:From|De):([^\n]*)$/mi)?.[1] ?? '');
    subject = header.match(/^(?:Subject|Asunto):([^\n]*)$/mi)?.[1]?.trim() ?? '';
    body = original.slice(end.index + end[0].length).trim();
    forwarded = true;
  }
  if (!sender) return null;
  const domain = '@' + sender.split('@')[1];
  const provider = Object.hasOwn(senders, sender) ? senders[sender] : Object.hasOwn(senders, domain) ? senders[domain] : null;
  const text = normalize(subject + '\n' + body);
  if ((provider !== 'nequi' && provider !== 'bancolombia') || !transactionWords.test(text) ||
      excluded.test(normalize(subject)) || excluded.test(normalize(body.slice(0, 500)))) return null;
  return {
    provider, forwarded,
    text: redact((subject + '\n' + body).split(/\n(?:--\s*$|aviso de confidencialidad|este correo es confidencial)/im, 1)[0]
      .trim().slice(0, 5000)),
  };
}

const moneyPattern = /(?:\b(?:valor(?: de la (?:compra|transacci[oó]n))?|monto|importe|pagaste|compraste|recibiste|enviaste|transferiste|retiraste|por(?: valor de)?)\s*[:=]?\s*)((?:COP|USD|EUR|US\$|[$€])\s*\d[\d.,]*|\d[\d.,]*\s*(?:COP|USD|EUR)\b)/giu;
const moneyAny = /(?:COP|USD|EUR|US\$|[$€])\s*\d[\d.,]*|\d[\d.,]*\s*(?:COP|USD|EUR)\b/giu;

function parseMoney(value: string) {
  const upper = value.toUpperCase().trim();
  const currency = upper.includes('USD') || upper.includes('US$') ? 'USD' :
    upper.includes('EUR') || upper.includes('€') ? 'EUR' : 'COP';
  const number = upper.match(/\d[\d.,]*/)?.[0].replace(/[.,]+$/, '');
  if (!number) return null;
  let decimal = number;
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(number)) decimal = number.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(number)) decimal = number.replace(/,/g, '');
  else if (/^\d+,\d{1,2}$/.test(number)) decimal = number.replace(',', '.');
  if (!/^\d{1,14}(?:\.\d{1,2})?$/.test(decimal)) return null;
  const [whole, cents = ''] = decimal.split('.');
  const amount = BigInt(whole) * 100n + BigInt(cents.padEnd(2, '0'));
  return amount > 0n ? { currency, amountMinor: amount.toString() } : null;
}

function extractMoney(text: string) {
  const anchored = [...text.matchAll(moneyPattern)].map(match => match[1]);
  const tokens = anchored.length ? anchored : [...text.matchAll(moneyAny)].map(match => match[0]);
  const parsed = tokens.map(parseMoney);
  if (!parsed.length || parsed.some(item => !item)) return null;
  const first = parsed[0]!;
  return parsed.every(item => item?.currency === first.currency && item.amountMinor === first.amountMinor) ? first : null;
}

const months = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export function validDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function extractDate(text: string) {
  const dates = new Set<string>();
  for (const match of text.matchAll(/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{4})\b/g)) {
    const [d, m, y] = match[0].split(/[/-]/);
    const date = d.length === 4 ? match[0] : y + '-' + m.padStart(2, '0') + '-' + d.padStart(2, '0');
    if (validDay(date)) dates.add(date);
  }
  for (const [, d, name, y] of normalize(text).matchAll(/\b(\d{1,2}) de ([a-z]+) de (\d{4})\b/g)) {
    const month = months.indexOf(name === 'setiembre' ? 'septiembre' : name) + 1;
    const date = y + '-' + String(month).padStart(2, '0') + '-' + d.padStart(2, '0');
    if (validDay(date)) dates.add(date);
  }
  return dates.size === 1 ? [...dates][0] : null;
}

export const currencies = ['COP', 'USD', 'EUR'] as const;
export const paymentMethods = ['Nequi', 'Bancolombia', 'Tarjeta'] as const;
export const directions = ['expense', 'income'] as const;
export const unconfirmedFields = ['amount', 'currency', 'date', 'direction', 'payment_method'] as const;
type UnconfirmedField = typeof unconfirmedFields[number];
export const amountPattern = /^[1-9]\d{0,15}$/;
const categoryHints: [Category, RegExp][] = [
  ['alimentacion', /restaurante|cafeteria|supermercado|almuerzo|comida|domicilio/],
  ['transporte', /transporte|gasolina|parqueadero|uber|peaje|metro/],
  ['vivienda', /arriendo|vivienda|acueducto|energia|servicios publicos/],
  ['ocio', /cine|netflix|teatro|entretenimiento|concierto/],
  ['salud', /farmacia|clinica|drogueria|hospital|consulta medica/],
  ['educacion', /universidad|colegio|matricula|educacion|curso/],
];

function enumOrNull<T extends string>(values: readonly T[], value: unknown): value is T | null {
  return value === null || values.some(x => x === value);
}

export function readModel(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { amountMinor, currency, date, paymentMethod, description, category, direction, confidence } = raw as Record<string, unknown>;
  if (!(amountMinor === null || typeof amountMinor === 'string' && amountPattern.test(amountMinor)) ||
      !enumOrNull(currencies, currency) || !(date === null || validDay(date)) || !enumOrNull(paymentMethods, paymentMethod) ||
      !(description === null || typeof description === 'string' && description.trim().length >= 1 && description.trim().length <= 160) ||
      !enumOrNull(categories, category) || !enumOrNull(directions, direction) ||
      typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return { amountMinor, currency, date, paymentMethod, description: description?.trim() ?? null, category, direction, confidence };
}

export function inspectNotice(notice: Pick<NoticeText, 'provider' | 'text'>) {
  const text = normalize(notice.text);
  const money = extractMoney(notice.text);
  const date = extractDate(text);
  const out = /\b(compra|compraste|pagaste|pago de|realizaste un pago|enviaste|transferiste|retiro|retiraste|debitaron|debito)\b/.test(text);
  const inc = /\b(recibiste|recibida|te enviaron|abonaron|abono|consignacion recibida|deposito recibido)\b/.test(text);
  const direction = out === inc ? null : out ? 'expense' as const : 'income' as const;
  const paymentMethod = /\btarjeta\b/.test(text) ? 'Tarjeta' : notice.provider === 'nequi' ? 'Nequi' : 'Bancolombia';
  const categoryHint = categoryHints.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
  return { text, money, date, direction, paymentMethod, categoryHint };
}

export function resolveExtraction(notice: NoticeText, raw: unknown, technicalFailure = false) {
  const { text, money, date, direction, paymentMethod, categoryHint } = inspectNotice(notice);
  const model = readModel(raw);
  const confidence = model?.confidence ?? (technicalFailure && money && date && direction ? 0.75 : 0);
  const fields: UnconfirmedField[] = [];
  if (!money || !date || !direction) {
    if (!money) fields.push('amount');
    if (!date) fields.push('date');
    if (!direction) fields.push('direction');
    return technicalFailure
      ? { status: 'error' as const, reason: 'extractor_unavailable' as const, confidence: 0 }
      : { status: 'pending' as const, reason: 'missing_or_ambiguous_fields' as const, confidence, unconfirmedFields: fields };
  }
  if (model) {
    if (model.amountMinor !== money.amountMinor) fields.push('amount');
    if (model.currency !== money.currency) fields.push('currency');
    if (model.date !== date) fields.push('date');
    if (model.direction !== direction) fields.push('direction');
    if (model.paymentMethod !== paymentMethod) fields.push('payment_method');
  }
  if (confidence < 0.7 || fields.length) {
    return { status: 'pending' as const, reason: 'unconfirmed_extraction' as const, confidence, unconfirmedFields: fields };
  }
  const description = model?.description && text.includes(normalize(model.description))
    ? redact(model.description)
    : (direction === 'expense' ? 'Salida de dinero' : 'Ingreso') + ' · ' + paymentMethod;
  return {
    status: 'registered' as const, confidence,
    movement: {
      ...money, date, paymentMethod, description, direction,
      category: direction === 'income' ? 'ingresos' : categoryHint ?? (model?.category !== 'ingresos' ? model?.category : null) ?? 'otros',
    },
  };
}
