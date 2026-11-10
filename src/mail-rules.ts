// Pure rules shared by the n8n Code nodes and the drain for pre-existing notices.
// This module must not have runtime imports: workflows.mjs embeds it in n8n.
export const categories = ['alimentacion', 'transporte', 'vivienda', 'ocio', 'salud', 'educacion', 'compras', 'ingresos', 'otros'] as const;
export type Category = typeof categories[number];
export const bankProviders = ['nequi', 'bancolombia'] as const;
export const providers = [...bankProviders, 'other'] as const;
export type Provider = typeof providers[number];
export type NoticeText = { provider: Provider; forwarded: boolean; text: string };
export type GmailNotice = Omit<NoticeText, 'text'> & { subject: string; body: string };
export type SenderMap = Readonly<Record<string, typeof bankProviders[number]>>;
export const normalize = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const bareAddress = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const forwardedHeader = /(?:^|\n)[ \t]*(?:-+\s*(?:forwarded message|mensaje reenviado|original message|mensaje original)\s*-+|begin forwarded message:)[ \t]*\n/i;
const transactionWords = /\b(?:compra|compraste|pago|pagaste|transferencia|transferiste|enviaste|recibiste|consignacion|retiro|retiraste|transaccion|movimiento|debitaron|debito|abono|abonaron|deposito|acreditaron|cargo|cobraron|reembolso|desembolso)\b/;
const excluded = /\b(?:codigo (?:de (?:seguridad|verificacion)|otp)|verifica tu identidad|intento (?:de inicio|de compra)|transaccion (?:rechazada|declinada|fallida)|compra (?:rechazada|declinada|fallida)|promocion(?:es)?|oferta exclusiva|estado de cuenta|extracto mensual|confirma si (?:hiciste|realizaste))\b/i;
const notCompleted = /\b(?:(?:pago|compra|transferencia|transaccion|abono) (?:(?:fue|esta|ha sido|quedo) )?(?:pendiente|rechazad[oa]|declinad[oa]|fallid[oa]|cancelad[oa]|programad[oa]|en proceso|no (?:aprobad[oa]|procesad[oa]))|pendiente de pago|solicitud de pago|paga antes de|no (?:pagaste|compraste|recibiste|se (?:proceso|realizo|completo)|fue (?:procesad[oa]|aprobad[oa]))|no (?:se )?pudo (?:procesar|realizar|completar|ser procesad[oa]))\b/;
const expenseEvidence = /\b(?:pagaste|compraste|enviaste|transferiste|retiraste|recibimos tu pago|realizaste un (?:pago|retiro)|te (?:debitaron|cobraron|descontaron)|se (?:te )?(?:debito|cobro)|compra (?:fue )?(?:confirmada|aprobada|realizada|exitosa|procesada|completada)|tu pago (?:fue )?(?:confirmado|aprobado|realizado|exitoso|procesado|completado))\b/;
const incomeEvidence = /\b(?:recibiste|te (?:enviaron|transfirieron|abonaron|acreditaron|consignaron|reembolsaron)|se (?:te )?(?:abono|acredito|consigno)|(?:transferencia|consignacion|deposito|abono|reembolso|desembolso) (?:fue )?(?:recibid[oa]|acreditad[oa]|abonad[oa])|pago recibido en tu cuenta)\b/;
const conditional = /\bsi (?:ya )?(?:pagaste|compraste|recibiste|transferiste|enviaste)\b/g;

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

export function candidate(from: string, subject: string, body: string, senders: SenderMap): GmailNotice | null {
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
  if (!sender || /^\s*\[MailGasto IA\]/i.test(subject)) return null;
  const domain = '@' + sender.split('@')[1];
  const provider = Object.hasOwn(senders, sender) ? senders[sender] : Object.hasOwn(senders, domain) ? senders[domain] : null;
  subject = redact(subject.slice(0, 1000)).trim();
  body = redact(body.split(/\n(?:--\s*$|aviso de confidencialidad|este correo es confidencial)/im, 1)[0].trim())
    .slice(0, 5000 - subject.length - 1);
  const head = normalize(subject + '\n' + body.slice(0, 600));
  if (excluded.test(head) || notCompleted.test(head) || !transactionWords.test(normalize(subject + '\n' + body))) return null;
  return { provider: provider ?? 'other', forwarded, subject, body };
}

const moneyPattern = /(?:\b(?:valor(?: de la (?:compra|transacci[oó]n))?|monto|importe|pagaste|compraste|recibiste|enviaste|transferiste|retiraste|por(?: valor de)?)\s*[:=]?\s*)((?:COP|USD|EUR|US\$|[$€])\s*\d[\d.,]*|\d[\d.,]*\s*(?:COP|USD|EUR)\b)/giu;
const moneyAny = /(?:COP|USD|EUR|US\$|[$€])\s*\d[\d.,]*|\d[\d.,]*\s*(?:COP|USD|EUR)\b/giu;
const numberToken = /\d+(?:[.,]\d+)*/.source;
const currencySuffix = /(?:COP|USD|EUR|pesos(?: colombianos)?|d[oó]lares(?: estadounidenses)?|euros)\b/.source;
const explicitAmount = '(?:(?:US\\$|COP|USD|EUR|[$€])\\s*' + numberToken +
  '(?:\\s*' + currencySuffix + ')?|' + numberToken + '\\s*' + currencySuffix + ')';
const amountBoundary = /(?![\p{L}\d:/%+-]|[.,]\d)/u.source;
const amountContext = /\b(?:pagaste|compraste|recibiste|enviaste|transferiste|retiraste|te (?:abonaron|acreditaron|consignaron|reembolsaron)|se (?:te )?(?:abon[oó]|acredit[oó]|debit[oó]|cobr[oó])|monto(?: (?:pagado|recibido))?|importe|valor(?: (?:de (?:la|el|tu) (?:compra|transacci[oó]n|pago|transferencia)|pagado|recibido))?|total (?:pagado|cobrado)|por valor de)\s*[:=]?\s*/u.source;
const gmailAnchoredMoney = new RegExp(amountContext + '(' + explicitAmount + '|' + numberToken + ')' + amountBoundary, 'giu');
const gmailExplicitMoney = new RegExp('(?<![\\p{L}\\d.,:/+\\-])' + explicitAmount + amountBoundary, 'giu');
const unsupportedCurrency = /\b(?:MXN|ARS|CLP|PEN|BRL|GBP|CHF|CAD|AUD|JPY|CNY|VES|CRC|DOP|UYU)\b|[£¥₹]|\b(?:pesos (?:mexicanos|argentinos|chilenos)|d[oó]lares (?:canadienses|australianos))\b/i;
const balanceLabel = /\b(?:saldo|cupo|comisi[oó]n|impuestos?|iva)\b[^.!?\n;]{0,30}$/i;

function parseMoney(value: string, defaultCurrency: typeof currencies[number] = 'COP') {
  const upper = value.toUpperCase().trim();
  const isUsd = /USD|US\$|D[ÓO]LARES/.test(upper);
  const isEur = /EUR|€/.test(upper);
  const isCop = /COP|PESOS/.test(upper);
  if (Number(isUsd) + Number(isEur) + Number(isCop) > 1) return null;
  const currency = isUsd ? 'USD' : isEur ? 'EUR' : isCop ? 'COP' : defaultCurrency;
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

function singleAmount(tokens: string[], defaultCurrency?: typeof currencies[number]) {
  const parsed = tokens.map(token => parseMoney(token, defaultCurrency));
  if (!parsed.length || parsed.some(item => !item)) return null;
  const first = parsed[0]!;
  return parsed.every(item => item?.currency === first.currency && item.amountMinor === first.amountMinor) ? first : null;
}

function extractMoney(text: string) {
  const anchored = [...text.matchAll(moneyPattern)].map(match => match[1]);
  return singleAmount(anchored.length ? anchored : [...text.matchAll(moneyAny)].map(match => match[0]));
}

function extractGmailMoney(text: string) {
  if (unsupportedCurrency.test(text)) return null;
  const declared = [...new Set([...text.toUpperCase().matchAll(/\bMONEDA\s*[:=]\s*(COP|USD|EUR)\b/g)].map(match => match[1]))];
  if (declared.length > 1) return null;
  const currency = currencies.find(value => value === declared[0]);
  const anchored = [...text.matchAll(gmailAnchoredMoney)].map(match => match[1]);
  const explicit = [...text.matchAll(gmailExplicitMoney)]
    .filter(match => !balanceLabel.test(text.slice(Math.max(0, match.index - 40), match.index)))
    .map(match => match[0]);
  const money = singleAmount([...anchored, ...explicit], currency);
  return currency && money?.currency !== currency ? null : money;
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
  ['alimentacion', /\b(?:restaurante|cafeteria|supermercado|almuerzo|comida)\b/],
  ['transporte', /\b(?:transporte|gasolina|parqueadero|uber|peaje|metro)\b/],
  ['vivienda', /\b(?:arriendo|vivienda|acueducto|energia|servicios publicos)\b/],
  ['ocio', /\b(?:cine|netflix|teatro|entretenimiento|concierto)\b/],
  ['salud', /\b(?:farmacia|clinica|drogueria|hospital|consulta medica|medicamentos?)\b/],
  ['educacion', /\b(?:universidad|colegio|matricula|educacion|cursos?)\b/],
  ['compras', /\b(?:ropa|calzado|prendas de vestir|zapatos|vestuario|camisetas|pantalones)\b/],
];

function matchingCategories(text: string) {
  return categoryHints.filter(([, pattern]) => pattern.test(normalize(text))).map(([category]) => category);
}

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

const classifications = ['completed', 'not_transaction', 'uncertain'] as const;
function shortText(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 160 ? value.trim() : null;
}

export function readGmailModel(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const fields = raw as Record<string, unknown>;
  const { classification, category, categoryEvidence, description, paymentMethod } = fields;
  if (classification === null || !enumOrNull(classifications, classification)) return null;
  const model = readModel({
    ...fields, category: enumOrNull(categories, category) ? category : null, description: shortText(description),
    paymentMethod: enumOrNull(paymentMethods, paymentMethod) ? paymentMethod : null,
  });
  return model && { ...model, classification, categoryEvidence: shortText(categoryEvidence) };
}

function movementDirection(expense: boolean, income: boolean) {
  return expense === income ? null : expense ? 'expense' as const : 'income' as const;
}

function bankMethod(provider: Provider, text: string): typeof paymentMethods[number] | null {
  if (provider === 'other') return null;
  return /\btarjeta\b/.test(text) ? 'Tarjeta' : provider === 'nequi' ? 'Nequi' : 'Bancolombia';
}

export function inspectNotice(notice: Pick<NoticeText, 'provider' | 'text'>) {
  const text = normalize(notice.text);
  const money = extractMoney(notice.text);
  const date = extractDate(text);
  const out = /\b(compra|compraste|pagaste|pago de|realizaste un pago|enviaste|transferiste|retiro|retiraste|debitaron|debito)\b/.test(text);
  const inc = /\b(recibiste|recibida|te enviaron|abonaron|abono|consignacion recibida|deposito recibido)\b/.test(text);
  const direction = movementDirection(out, inc);
  const paymentMethod = bankMethod(notice.provider, text);
  const categoryHint = matchingCategories(text)[0] ?? null;
  return { text, money, date, direction, paymentMethod, categoryHint };
}

export function inspectGmailNotice(notice: Pick<GmailNotice, 'provider' | 'subject' | 'body'>) {
  const excerpt = notice.subject + '\n' + notice.body;
  const text = normalize(excerpt);
  const completionText = text.replace(conditional, '');
  const direction = movementDirection(expenseEvidence.test(completionText), incomeEvidence.test(completionText));
  const methodMentions = [...text.matchAll(/\b(?:(?:con|mediante|via|usando|a traves de) (?:tu |una |la )?|(?:medio|metodo|forma) de pago\s*:\s*)(nequi|bancolombia|tarjeta)\b/g)];
  const methods = new Set(methodMentions.map(match => match[1]));
  const statedMethod = methods.size === 1 ? paymentMethods.find(method => methods.has(normalize(method))) ?? null : null;
  return {
    text, money: extractGmailMoney(excerpt), date: extractDate(text), direction,
    paymentMethod: notice.provider === 'other' ? statedMethod : bankMethod(notice.provider, text),
  };
}

function asEvidence(value: string) {
  return normalize(value).replace(/\s+/g, ' ').trim();
}

function chooseGmailCategory(notice: GmailNotice, model: ReturnType<typeof readGmailModel>): Category {
  const bodyCategories = matchingCategories(notice.body);
  if (bodyCategories.length === 1) return bodyCategories[0];
  if (bodyCategories.length > 1) return 'otros';
  const subjectCategories = matchingCategories(notice.subject);
  if (model?.category && model.category !== 'ingresos' && model.category !== 'otros' && model.categoryEvidence) {
    const evidence = asEvidence(model.categoryEvidence);
    const body = asEvidence(notice.body);
    const subject = asEvidence(notice.subject);
    const hints = matchingCategories(evidence);
    const bareName = evidence === asEvidence(model.description ?? '') || !evidence.includes(' ');
    const consistent = hints.length === 1 && hints[0] === model.category;
    if (consistent || hints.length === 0 && !bareName) {
      if (body.includes(evidence)) return model.category;
      if (subject.includes(evidence) && subjectCategories.length <= 1) return model.category;
    }
  }
  return subjectCategories.length === 1 ? subjectCategories[0] : 'otros';
}

function resolveChecked(
  { text, money, date, direction, paymentMethod }: ReturnType<typeof inspectGmailNotice>,
  model: ReturnType<typeof readModel>,
  category: Category,
  { technicalFailure = false, requireMethod = true, uncertain = false } = {},
) {
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
    if (requireMethod && model.paymentMethod !== paymentMethod) fields.push('payment_method');
  }
  if (uncertain || confidence < 0.7 || fields.length) {
    return { status: 'pending' as const, reason: 'unconfirmed_extraction' as const, confidence, unconfirmedFields: fields };
  }
  const description = model?.description && asEvidence(text).includes(asEvidence(model.description))
    ? redact(model.description)
    : (direction === 'expense' ? 'Salida de dinero' : 'Ingreso') + (paymentMethod ? ' · ' + paymentMethod : '');
  return {
    status: 'registered' as const, confidence,
    movement: {
      ...money, date, paymentMethod, description, direction,
      category: direction === 'income' ? 'ingresos' as const : category,
    },
  };
}

export function resolveExtraction(notice: NoticeText, raw: unknown, technicalFailure = false) {
  if (notice.provider === 'other') {
    return { status: 'pending' as const, reason: 'unverified_sender' as const, confidence: 0, unconfirmedFields: [] };
  }
  const checked = inspectNotice(notice);
  const model = readModel(raw);
  const category = checked.categoryHint ?? (model?.category !== 'ingresos' ? model?.category : null) ?? 'otros';
  return resolveChecked(checked, model, category, { technicalFailure });
}

export function resolveGmailExtraction(notice: GmailNotice, model: ReturnType<typeof readGmailModel>) {
  const checked = inspectGmailNotice(notice);
  if (model?.classification === 'not_transaction' || notCompleted.test(checked.text)) return { status: 'ignored' as const };
  const requireMethod = notice.provider !== 'other';
  if (!model && !requireMethod) return { status: 'error' as const, reason: 'extractor_unavailable' as const, confidence: 0 };
  return resolveChecked(checked, model, chooseGmailCategory(notice, model), {
    technicalFailure: !model, requireMethod, uncertain: model?.classification === 'uncertain',
  });
}
