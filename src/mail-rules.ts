// Pure rules shared by the n8n Code nodes and the drain for pre-existing notices.
// This module must not have runtime imports: workflows.mjs embeds it in n8n.
export const categories = ['alimentacion', 'transporte', 'vivienda', 'ocio', 'salud', 'educacion', 'compras', 'ingresos', 'otros'] as const;
export type Category = typeof categories[number];
export const bankProviders = ['nequi', 'bancolombia'] as const;
export const providers = [...bankProviders, 'other'] as const;
export type Provider = typeof providers[number];
export type NoticeText = { provider: Provider; forwarded: boolean; text: string };
export type GmailNotice = Omit<NoticeText, 'text'> & { subject: string; body: string; payment?: GmailPayment };
export type SenderMap = Readonly<Record<string, typeof bankProviders[number]>>;
export const gmailBankSenders: SenderMap = {
  'alertasynotificaciones@an.notificacionesbancolombia.com': 'bancolombia',
  'alertasynotificaciones@ayn.notificacionesbancolombia.com': 'bancolombia',
};
export const normalize = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const bareAddress = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const forwardedHeader = /(?:^|\n)[ \t]*(?:-+\s*(?:forwarded message|mensaje reenviado|original message|mensaje original)\s*-+|begin forwarded message:)[ \t]*\n/i;
const transactionWords = /\b(?:compra|compraste|pago|pagaste|transferencia|transferiste|enviaste|recibiste|consignacion|retiro|retiraste|transaccion|movimiento|debitaron|debito|abono|abonaron|deposito|acreditaron|cargo|cobraron|reembolso|desembolso)\b/;
const excluded = /\b(?:codigo (?:de (?:seguridad|verificacion)|otp)|verifica tu identidad|intento (?:de inicio|de compra)|transaccion (?:rechazada|declinada|fallida)|compra (?:rechazada|declinada|fallida)|promocion(?:es)?|oferta exclusiva|estado de cuenta|extracto mensual|confirma si (?:hiciste|realizaste))\b/i;
const notCompleted = /\b(?:(?:pago|compra|transferencia|transaccion|abono) (?:(?:fue|esta|ha sido|quedo) )?(?:pendiente|rechazad[oa]|declinad[oa]|fallid[oa]|cancelad[oa]|programad[oa]|en proceso|no (?:aprobad[oa]|procesad[oa]))|pendiente de pago|solicitud de pago|paga antes de|no (?:pagaste|compraste|recibiste|se (?:proceso|realizo|completo)|fue (?:procesad[oa]|aprobad[oa]))|no (?:se )?pudo (?:procesar|realizar|completar|ser procesad[oa]))\b/;
const expenseEvidence = /\b(?:pagaste|compraste|enviaste|transferiste|retiraste|recibimos tu pago|realizaste un (?:pago|retiro)|te (?:debitaron|cobraron|descontaron)|se (?:te )?(?:debito|cobro)|compra (?:fue )?(?:confirmada|aprobada|realizada|exitosa|procesada|completada)|tu pago (?:fue )?(?:confirmado|aprobado|realizado|exitoso|procesado|completado))\b/;
const incomeEvidence = /\b(?:recibiste|te (?:enviaron|transfirieron|abonaron|acreditaron|consignaron|reembolsaron)|se (?:te )?(?:abono|acredito|consigno)|(?:transferencia|consignacion|deposito|abono|reembolso|desembolso) (?:fue )?(?:recibid[oa]|acreditad[oa]|abonad[oa])|pago recibido en tu cuenta)\b/;
const conditional = /\bsi (?:ya )?(?:pagaste|compraste|recibiste|transferiste|enviaste)\b/g;
const gmailSecurityFooter = /(?:\bpor tu seguridad\b|\bprotege tus datos\b|\b(?:si tienes dudas[, \t\n]+(?:ll[aá]manos|hablemos|encu[eé]ntranos)|estos consejos de seguridad)\b|\beste es un (?:correo|mensaje) autom[aá]tico\b|\best[ea] es una notificaci[oó]n autom[aá]tica\b|\b(?:bancolombia|nequi) nunca (?:te|le) solicitar[aá]\b|\baviso de confidencialidad\b)/i;
const cardLabel = /(?:tarjeta(?:[ \t]+(?:de[ \t]+)?(?:d[eé]bito|cr[eé]dito))?|t[ \t]*\.[ \t]*(?:d[eé]b(?:ito)?|cr[eé]d(?:ito)?))\b/.source;
const cardNumberPrefix = /[ \t]*\.?[ \t]*(?:(?:terminad[ao][ \t]+en|n[uú]mero|nro\.?|no\.?|de|es)[ \t]+)?[:# \t-]*/.source;
const cardMask = /[*x×•●](?:[ .\t-]{0,3}[*x×•●]){0,18}[ .\t-]{0,3}/.source;
const cardDigits = /(?:\d{4}(?:\.\d{4}){2,3}|\d+(?:[ \t-]+\d+)*)(?![\d/:]|[.,]\d)/.source;
const cardIdentifier = new RegExp('\\b(' + cardLabel + ')' + cardNumberPrefix + '(?:' + cardMask + ')?' + cardDigits, 'gi');
const maskedIdentifier = new RegExp('(?<![\\p{L}\\d])' + cardMask + cardDigits, 'giu');

export function redact(text: string) {
  return text
    .replace(/https?:\/\/[^\s<>]+|www\.[^\s<>]+/gi, '[enlace]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[correo]')
    .replace(cardIdentifier, '$1 [identificador]')
    .replace(maskedIdentifier, '[identificador]')
    .replace(/\b(?:cuenta|documento|referencia|autorizaci[oó]n|c[eé]dula|tel[eé]fono|celular|identificaci[oó]n|terminad[ao] en|c[oó]digo (?:de seguridad|de verificaci[oó]n|OTP))\s*(?:(?:n[uú]mero|no\.?|nro\.?|de|es)\s*)?[:#*xX -]*\d[\d* xX-]*/gi, match => match.replace(/[:#*xX -]*\d[\d* xX-]*$/, ' [identificador] '))
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
  subject = subject.slice(0, 1000).trim();
  body = body.split(/\n(?:--\s*$|aviso de confidencialidad|este correo es confidencial)/im, 1)[0].trim();
  const footer = body.search(gmailSecurityFooter);
  if (footer > 0) {
    const beforeFooter = normalize(body.slice(0, footer));
    if (expenseEvidence.test(beforeFooter) || incomeEvidence.test(beforeFooter)) body = body.slice(0, footer).trim();
  }
  // Look at the mask before redaction, without cutting a longer identifier into a four-digit suffix.
  const payment = extractGmailPayment(subject, body);
  subject = redact(subject).trim();
  body = redact(body).slice(0, 5000 - subject.length - 1);
  const head = normalize(subject + '\n' + body.slice(0, 600));
  if (excluded.test(head) || notCompleted.test(head) || !transactionWords.test(normalize(subject + '\n' + body))) return null;
  return { provider: provider ?? 'other', forwarded, subject, body, payment };
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
const dateText = /(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{4}|\d{1,2} de [a-z]+ de \d{4})/.source;
const dateMention = new RegExp('\\b' + dateText + '\\b', 'g');
export function validDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function singleValue<T>(values: Iterable<T>) {
  const unique = new Set(values);
  return unique.size === 1 ? [...unique][0] : null;
}

function findDates(text: string) {
  const dates = [];
  for (const match of text.matchAll(dateMention)) {
    const [day, month, year] = match[0].split(/ de |[/-]/);
    const monthNumber = /^\d+$/.test(month) ? month : String(months.indexOf(month === 'setiembre' ? 'septiembre' : month) + 1);
    const date = day.length === 4 ? match[0] : year + '-' + monthNumber.padStart(2, '0') + '-' + day.padStart(2, '0');
    if (validDay(date)) dates.push({ date, start: match.index, end: match.index + match[0].length });
  }
  return dates;
}

export const transactionTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const clock = /(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[ \t]*([ap])\.?[ \t]*m\.?)?(?![\w:])/.source;
const clockAfterDate = new RegExp('^\\s*(?:[,;]\\s*)?(?:(?:a\\s+las?|hora)\\s*:?\\s*)?' + clock);
const clockBeforeDate = new RegExp('\\ba las?[ \\t]+' + clock + '[ \\t]*(?:(?:,|del|el|de)[ \\t]*)?$');
const alternativeClock = new RegExp('^[ \\t]+[oy][ \\t]+a las?[ \\t]+' + clock);
const clockInField = new RegExp('\\bhora[ \\t]+(?:de[ \\t]+(?:(?:la|el)[ \\t]+)?|del[ \\t]+)' +
  '(?:compra|operacion|transaccion|pago|movimiento)[ \\t]*[:=][ \\t]*' + clock, 'g');
const receiptDateContext = /(?:^|[.;\n])[ \t]*(?:(?:correo[ \t]+)?(?:recibid[oa]|enviad[oa])|fecha[ \t]+(?:de[ \t]+)?(?:recepcion|envio|notificacion)(?: del correo)?)[ \t]*[:=,]?[ \t]*(?:el[ \t]+)?$/;

function readClock(match: RegExpMatchArray) {
  const [, hour, minute, second, period] = match;
  const value = Number(hour);
  if (period && (value < 1 || value > 12)) return null;
  const hours = period ? value % 12 + (period === 'p' ? 12 : 0) : value;
  const time = String(hours).padStart(2, '0') + ':' + minute + (second ? ':' + second : '');
  return transactionTimePattern.test(time) ? time : null;
}

function extractGmailTime(text: string, dates: ReturnType<typeof findDates>, date: string | null) {
  const matches: RegExpMatchArray[] = [...text.matchAll(clockInField)];
  if (date) {
    for (const { start, end } of dates) {
      const tail = text.slice(end, end + 90);
      const after = tail.match(clockAfterDate);
      const before = text.slice(Math.max(0, start - 60), start).match(clockBeforeDate);
      if (after) {
        matches.push(after);
        const alternative = tail.slice(after[0].length).match(alternativeClock);
        if (alternative) matches.push(alternative);
      }
      if (before) matches.push(before);
    }
  }
  const times = matches.map(readClock).filter(time => time !== null);
  if (!singleValue(times.map(time => time.slice(0, 5)))) return null;
  const precise = times.filter(time => time.length === 8);
  return singleValue(precise.length ? precise : times);
}

export const currencies = ['COP', 'USD', 'EUR'] as const;
export const paymentMethods = ['Nequi', 'Bancolombia', 'Tarjeta', 'PSE', 'Transferencia', 'QR', 'Botón Bancolombia'] as const;
export const cardTypes = ['debit', 'credit'] as const;
export const cardLast4Pattern = /^\d{4}$/;
type GmailPayment = {
  paymentMethod: typeof paymentMethods[number] | null;
  cardType: typeof cardTypes[number] | null;
  cardLast4: string | null;
};

const paymentToken = '(?:' + cardLabel + '|nequi\\b|pse\\b|(?:codigo\\s+)?qr\\b|boton\\s+bancolombia\\b|transferencia\\b)';
const paymentContext = /\b(?:(?:con|mediante|por|via|usando|a traves de)\s+(?:(?:tu|su|una|la|el)\s+)?|(?:medio|metodo|forma) de pago[ \t]*[:=][ \t]*)/.source;
const paymentMention = new RegExp('(?:' + paymentContext + '|^[ \\t]*(?=' + cardLabel + '[ \\t]*[:=]))(' + paymentToken + ')', 'gm');
const nextPayment = new RegExp('^[ \\t]*(?:[,/]|\\b[oy]\\b)[ \\t]*(?:(?:tu|su|una|la|el)[ \\t]+)?(' + paymentToken + ')');
const cardToken = new RegExp('^' + cardLabel + '$');
const maskedCardSuffix = new RegExp('^' + cardNumberPrefix + cardMask + '(\\d{4})(?![\\w:/]|[.,]\\d|[ .\\t-]+[\\d*x×•●])');
const purchaseMerchant = new RegExp('\\b(?:compraste|pagaste)\\s+(?:' + explicitAmount + '|' + numberToken + ')\\s+en\\s+' +
  '([^\\n]{1,160}?)(?=,?\\s+(?:' + paymentContext + paymentToken + '|el\\s+(?:d[ií]a\\s+)?' + dateText + '\\b))', 'giu');
const buttonMerchant = new RegExp('\\b(?:pagaste|transferiste)\\s+(?:' + explicitAmount + '|' + numberToken +
  ')(?:\\s+(?:con|por|mediante)\\s+(?:el\\s+)?bot[oó]n\\s+bancolombia)?' +
  '\\s+a\\s+([^\\n]{1,160}?)(?=\\s+(?:desde (?:tu |el |la )?(?:cuenta|producto)|con (?:el )?bot[oó]n|el\\s+' + dateText + '\\b))', 'giu');

function extractPurchaseMerchant(body: string) {
  const names = [...body.matchAll(purchaseMerchant), ...body.matchAll(buttonMerchant)]
    .map(match => match[1].trim().replace(/,$/, '').trim());
  return singleValue(names.filter(name => /\p{L}/u.test(name) &&
    !/[.!?]\s/.test(name.replace(/\b(?:[\p{L}]\.){2,}/gu, '')) && !findDates(normalize(name)).length));
}

function extractGmailPayment(subject: string, body: string): GmailPayment {
  const text = normalize(subject + '\n' + body);
  const methods: NonNullable<GmailPayment['paymentMethod']>[] = [];
  const types: NonNullable<GmailPayment['cardType']>[] = [];
  const suffixes: string[] = [];
  const addMethod = (token: string, tail: string) => {
    if (!cardToken.test(token)) {
      methods.push(token === 'nequi' ? 'Nequi' : token === 'pse' ? 'PSE' :
        token.endsWith('qr') ? 'QR' : token.startsWith('boton') ? 'Botón Bancolombia' : 'Transferencia');
      return 0;
    }
    methods.push('Tarjeta');
    if (/\bdeb/.test(token)) types.push('debit');
    if (/\bcred/.test(token)) types.push('credit');
    const mask = maskedCardSuffix.exec(tail);
    if (mask) suffixes.push(mask[1]);
    return mask?.[0].length ?? 0;
  };
  for (const match of text.matchAll(paymentMention)) {
    const tail = text.slice(match.index + match[0].length);
    const following = tail.slice(addMethod(match[1], tail));
    const second = nextPayment.exec(following);
    if (second) addMethod(second[1], following.slice(second[0].length));
  }
  const paymentMethod = singleValue(methods) ?? (methods.length === 0 &&
    /\b(?:recibiste una transferencia|transferencia recibida)\b/.test(text) ? 'Transferencia' : null);
  return {
    paymentMethod,
    cardType: paymentMethod === 'Tarjeta' ? singleValue(types) : null,
    cardLast4: paymentMethod === 'Tarjeta' ? singleValue(suffixes) : null,
  };
}

function extractReportedInstitution(text: string) {
  const mentions = [...text.matchAll(/^[ \t]*(?:(?:banco|entidad)(?: emisora)?[ \t]*:[ \t]*)?(nequi|bancolombia)\b[ \t]*(?=:|$|te informa\b)/gm)];
  return singleValue(mentions.flatMap(match => bankProviders.filter(bank => bank === match[1])));
}

const gmailOperation = /\b(?:recibiste(?: un pago de nomina| una transferencia)?|compraste|pagaste|transferiste|enviaste|retiraste|te (?:enviaron|transfirieron|abonaron|acreditaron|consignaron|reembolsaron)|se (?:te )?(?:abono|acredito|consigno|debito|cobro))\b/i;
const payrollConcept = /\b(?:recibiste un pago de n[oó]mina|abono de n[oó]mina)\b/i;

export function openAiNoticeText(notice: Pick<GmailNotice, 'subject' | 'body'>) {
  const body = notice.body.replace(/^[ \t]*(?:hola|estimad[oa]|apreciad[oa]|señor(?:a)?|cliente)\b[^\n]*(?:\n|$)/gim,
    line => transactionWords.test(normalize(line)) ? line : '');
  const minimize = (text: string) => redact(text)
    .replace(/(\b(?:bancolombia|nequi):)[ \t]+[^:\n]{2,100}?(?=\s+(?:pagaste|compraste|recibiste|enviaste|transferiste|retiraste)\b)/giu, '$1 [titular]')
    .replace(/\b(?:llave(?: de pago)?|producto|cuenta|id de transacci[oó]n|n[uú]mero de transacci[oó]n)\s*[:#*xX -]*\d[\d* xX-]*/gi,
      '[identificador]')
    .replace(/\b(\d{1,2}[/-]\d{1,2}[/-]\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2} de \p{L}+ de \d{4})\b|\b(\d{1,2}:\d{2}(?::\d{2})?)\b|(?:COP|USD|EUR|US\$|[$€])\s*\d[\d.,]*|\b\d[\d.,]*\s*(?:COP|USD|EUR)\b|\b\d{4,}\b/giu,
      (value, date: string | undefined, time: string | undefined) =>
        date || time || /[$€]|\b(?:COP|USD|EUR)\b/i.test(value) ? value : '[identificador]')
    .replace(/(\b(?:recibiste(?: una transferencia)?|transferiste|enviaste|pagaste por (?:c[oó]digo )?qr)[^\n]{0,95}?\s+(?:de|a))\s+[\p{L}][\p{L} .'-]{2,100}?(?=\s+(?:en (?:tu |la )?cuenta|el \d|a las \d|desde|por valor)|[.;\n]|$)/giu,
      '$1 [contraparte]')
    .replace(/(^|[;\n])([ \t]*(?:titular|destinatario|beneficiario|ordenante|nombre del (?:cliente|titular))\s*[:=])[^\n;]+/gim,
      '$1$2 [contraparte]');
  // Keep transaction lines and their neighbors so most greetings and signatures can be dropped.
  const lines = minimize(body).split('\n');
  const relevant = lines.map(line => transactionWords.test(normalize(line)) ||
    /[$€]|\b(?:COP|USD|EUR|fecha|hora|comercio|concepto|medio de pago)\b/i.test(line));
  return { subject: minimize(notice.subject).slice(0, 240),
    body: lines.filter((_, index) => relevant[index] || relevant[index - 1] || relevant[index + 1]).join('\n').slice(0, 2200) };
}

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
  const date = singleValue(findDates(text).map(match => match.date));
  const out = /\b(compra|compraste|pagaste|pago de|realizaste un pago|enviaste|transferiste|retiro|retiraste|debitaron|debito)\b/.test(text);
  const inc = /\b(recibiste|recibida|te enviaron|abonaron|abono|consignacion recibida|deposito recibido)\b/.test(text);
  const direction = movementDirection(out, inc);
  const paymentMethod = bankMethod(notice.provider, text);
  const categoryHint = matchingCategories(text)[0] ?? null;
  return { text, money, date, direction, paymentMethod, categoryHint };
}

export function inspectGmailNotice(notice: Pick<GmailNotice, 'subject' | 'body' | 'payment'>) {
  const excerpt = notice.subject + '\n' + notice.body;
  const text = normalize(excerpt);
  const completionText = text.replace(conditional, '');
  const direction = movementDirection(expenseEvidence.test(completionText), incomeEvidence.test(completionText));
  const dates = findDates(text).filter(({ start }) => !receiptDateContext.test(text.slice(Math.max(0, start - 100), start)));
  const date = singleValue(dates.map(match => match.date));
  return {
    text, money: extractGmailMoney(excerpt), date, direction,
    ...(notice.payment ?? extractGmailPayment(notice.subject, notice.body)),
    transactionTime: extractGmailTime(text, dates, date),
    reportedInstitution: extractReportedInstitution(text),
  };
}

function asEvidence(value: string) {
  return normalize(value).replace(/\s+/g, ' ').trim();
}

function chooseGmailCategory(notice: GmailNotice, model: ReturnType<typeof readGmailModel>, merchant: string | null): Category {
  const bodyCategories = matchingCategories(notice.body);
  if (bodyCategories.length === 1) return bodyCategories[0];
  if (bodyCategories.length > 1) return 'otros';
  const subjectCategories = matchingCategories(notice.subject);
  if (model?.category && model.category !== 'ingresos' && model.category !== 'otros' && model.categoryEvidence) {
    const evidence = asEvidence(model.categoryEvidence);
    const body = asEvidence(notice.body);
    const subject = asEvidence(notice.subject);
    const hints = matchingCategories(evidence);
    const bareName = asEvidence(merchant ?? model.description ?? '').includes(evidence) || !evidence.includes(' ');
    const consistent = hints.length === 1 && hints[0] === model.category;
    if (consistent || hints.length === 0 && !bareName) {
      if (body.includes(evidence)) return model.category;
      if (subject.includes(evidence) && subjectCategories.length <= 1) return model.category;
    }
  }
  return subjectCategories.length === 1 ? subjectCategories[0] : 'otros';
}

function resolveChecked(
  { text, money, date, direction, paymentMethod }: Omit<ReturnType<typeof inspectNotice>, 'categoryHint'>,
  model: ReturnType<typeof readModel>,
  category: Category,
  { technicalFailure = false, requireMethod = true, uncertain = false, merchant = null as string | null } = {},
) {
  const confidence = model?.confidence ?? (technicalFailure && money && date && direction ? 0.75 : 0);
  const fields: UnconfirmedField[] = [];
  if (!money || !date || !direction) {
    if (!money) fields.push('amount');
    if (!date) fields.push('date');
    if (!direction) fields.push('direction');
    return technicalFailure
      ? { status: 'error' as const, reason: 'extractor_unavailable' as const, confidence: 0 as const }
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
  const description = model?.description && asEvidence(text).includes(asEvidence(model.description)) &&
    (!merchant || asEvidence(model.description) === asEvidence(merchant))
    ? redact(model.description)
    : merchant ?? (direction === 'expense' ? 'Salida de dinero' : 'Ingreso') + (paymentMethod ? ' · ' + paymentMethod : '');
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

export function resolveGmailExtraction(notice: GmailNotice, model: ReturnType<typeof readGmailModel>, allowLocalReview = false) {
  const checked = inspectGmailNotice(notice);
  const evidence = checked.text.replace(conditional, '');
  if (model?.classification === 'not_transaction' && (expenseEvidence.test(evidence) || incomeEvidence.test(evidence))) {
    model = { ...model, classification: 'uncertain' };
  }
  if (model?.classification === 'not_transaction' || notCompleted.test(checked.text)) return { status: 'ignored' as const };
  const merchant = extractPurchaseMerchant(notice.body) ?? (payrollConcept.test(notice.body) ? 'Pago de nómina' : null);
  const operation = gmailOperation.exec(normalize(notice.body));
  const operatedAmount = operation ? extractGmailMoney(notice.body.slice(operation.index)) : null;
  const literal = Boolean(allowLocalReview && operation && checked.date && checked.direction && checked.money &&
    notice.provider !== 'other' && !notice.forwarded && operatedAmount?.currency === checked.money.currency &&
    operatedAmount.amountMinor === checked.money.amountMinor);
  if (literal) model = null;
  if (!model && notice.provider === 'other' && !allowLocalReview) {
    return { status: 'error' as const, reason: 'extractor_unavailable' as const, confidence: 0 as const };
  }
  const result = resolveChecked(checked, model, chooseGmailCategory(notice, model, merchant), {
    technicalFailure: !model && (Boolean(literal) || !allowLocalReview), requireMethod: false,
    uncertain: model?.classification === 'uncertain', merchant,
  });
  const { date, paymentMethod, cardType, cardLast4, transactionTime, reportedInstitution } = checked;
  const details = { cardType, cardLast4, transactionTime, reportedInstitution };
  if (result.status === 'registered') return { ...result, movement: { ...result.movement, ...details } };
  if (result.status === 'pending') return { ...result, evidence: {
    date, paymentMethod, ...details,
    ...(allowLocalReview ? {
      amountMinor: checked.money?.amountMinor, currency: checked.money?.currency, direction: checked.direction,
    } : {}),
  } };
  return result;
}
