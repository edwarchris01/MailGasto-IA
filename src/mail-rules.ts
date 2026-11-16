// Pure rules shared by the n8n Code nodes and the drain for pre-existing notices.
// This module must not have runtime imports: workflows.mjs embeds it in n8n.
export const categories = ['alimentacion', 'transporte', 'vivienda', 'ocio', 'salud', 'educacion', 'compras', 'ingresos', 'otros'] as const;
export type Category = typeof categories[number];
export const bankProviders = ['nequi', 'bancolombia'] as const;
export const providers = [...bankProviders, 'other'] as const;
export const gmailIgnoredLabels = ['SPAM', 'TRASH', 'SENT', 'DRAFT'] as const;
export type Provider = typeof providers[number];
export type NoticeText = { provider: Provider; forwarded: boolean; text: string };
export type GmailNotice = Omit<NoticeText, 'text'> & {
  subject: string; body: string; payment?: GmailPayment; format?: GmailFormat; unauthenticated?: boolean; references?: string[];
};
export type SenderMap = Readonly<Record<string, typeof bankProviders[number]>>;
export const gmailBankSenders: SenderMap = {
  'alertasynotificaciones@an.notificacionesbancolombia.com': 'bancolombia',
  'alertasynotificaciones@ayn.notificacionesbancolombia.com': 'bancolombia',
  'notificaciones@nequi.com.co': 'nequi',
  'somos@nequi.com.co': 'nequi',
};
const gmailReceiptSenders = {
  'serviciopse@achcolombia.com.co': 'pse',
  'info@pasarelapagosaval.com': 'aval',
  'no-responder@avalpaycenter.com.co': 'avalpay',
  'no-reply@wompi.co': 'wompi',
  'micredito@rapicredit.com': 'rapicredit',
  'payments@ebanx.com': 'ebanx',
  'support@digitalocean.com': 'digitalocean',
  'googleplay-noreply@google.com': 'google_play',
  'informacion.pagos@claro.com.co': 'claro',
  'team@info.hostinger.com': 'hostinger',
  'no-reply@starlink.com': 'starlink',
  'info@payulatam.com': 'payu',
  'notificaciones@famicredito.com': 'famicredito',
  'info@mercadopago.com': 'mercado_pago',
  'servicios@agaval.com.co': 'agaval_credit',
  'noreply@github.com': 'github',
  'no-reply@whoosh.bike': 'whoosh',
  'movistar@movistar.com.co': 'movistar',
} as const;
type GmailFormat = typeof gmailReceiptSenders[keyof typeof gmailReceiptSenders];
export const normalize = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const bareAddress = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const forwardedHeader = /(?:^|\n)[ \t]*(?:-+\s*(?:forwarded message|mensaje reenviado|original message|mensaje original)\s*-+|begin forwarded message:)[ \t]*\n/i;
const transactionWords = /\b(?:compra|compraste|pago|pagaste|transferencia|transferiste|enviaste|recibiste|consignacion|retiro|retiraste|transaccion|movimiento|debitaron|debito|abono|abonaron|deposito|acreditaron|cargos?|cobraron|reembolso|reembolsaron|desembolso|desembolsado|payment|paid|charged|debited|credited|refund|purchase|transfer|transaction|receipt|invoice|settled)\b/;
const englishExpense = /\b(?:amount paid|total paid|we(?:'ve| have)? received (?:your )?payment|(?:your )?payment (?:was |has been )?(?:received|completed|successful|processed|confirmed|applied|settled)|you (?:paid|purchased)|(?:your (?:card|account) (?:was |has been )?|you (?:were |have been ))(?:charged|debited)|purchase (?:was )?(?:completed|confirmed)|transaction (?:was )?(?:charged|completed))\b/;
const englishIncome = /\b(?:(?:your account (?:was |has been )?)credited|funds (?:were |have been )?credited|(?:you |your account )received (?:a )?(?:deposit|transfer|payment))\b/;
const englishRequest = /\b(?:payment (?:request(?:ed)?|still due)|pending approval|no (?:charges?|money has been charged)|not a receipt)\b/;
const historicalSection = /(?:^|\n)[ \t]*(?:historial(?: (?:de intentos|del pago|de pagos))?|attempt history|previous attempts?|related activity)[ \t]*:[^\n]*(?:\n[ \t]*(?=(?:[-*]\s*)?(?:intento|attempt|pago rechazado|payment failed|payment declined)\b)[^\n]*)*/gi;
const historicLine = /(?:^|\n)[ \t]*(?:intento (?:anterior|previo)|(?:en )?(?:el )?(?:primer|anterior) intento|(?:previous|earlier|initial) (?:payment |charge )?attempt|(?:for |as )?reference only)[^\n]*/gi;
const excluded = /\b(?:codigo (?:(?:de )?(?:seguridad|verificacion)|otp)|verifica tu identidad|intento (?:de inicio|de compra)|transaccion (?:rechazada|declinada|fallida)|compra (?:rechazada|declinada|fallida)|confirma si (?:hiciste|realizaste))\b/i;
const excludedSubject = /^\s*\[mailgasto ia\]|\b(?:promocion(?:es)?|oferta exclusiva|estado de cuenta|extracto|codigo de acceso|nuevo inicio de sesion|alerta de seguridad|reporte en centrales de riesgo|traslado (?:de (?:la |tu )?)?obligacion)\b/;
const electronicInvoice = /^(?:\d{5,14}[\d-]*|nit[ :]*\d{5,14}[\d-]*)\s*;[^;\r\n]+;[^;\r\n]+;\d{2}\s*;/;
const informationalOnly = /\b(?:llego tu factura|aqui te llego tu factura|tu factura.{0,30}esta disponible|factura electronica de venta|valor a pagar|total a pagar|saldo (?:en mora|pendiente)|cuenta (?:en|con) mora|pon(?:te|gase) al dia|formalizar un acuerdo de pago|cuota (?:vence|proxima)|actualizaste tu informacion personal|actualizacion de datos|pagare digital|no tiene cambios en tu saldo|orden recibida|pedido (?:se |fue )?cancelado)\b/;
const notCompleted = /\b(?:(?:pago|compra|transferencia|transaccion|abono) (?:(?:fue|esta|ha sido|quedo) )?(?:pendiente|rechazad[oa]|declinad[oa]|fallid[oa]|cancelad[oa]|programad[oa]|en proceso|no (?:aprobad[oa]|procesad[oa]))|pendiente de pago|solicitud de pago|paga antes de|no (?:pagaste|compraste|recibiste|se (?:proceso|realizo|completo)|fue (?:procesad[oa]|aprobad[oa]))|no (?:se )?pudo (?:procesar|realizar|completar|ser procesad[oa]))\b/;
const gmailRejected = /\b(?:faltan fondos para pagar|se rechaz[oó] (?:tu |su |el |la )?(?:pago|compra|transacci[oó]n)|(?:compra|pago|transacci[oó]n)\b(?:[^.!?\n]|\.(?=\d)){0,110}?\bse rechaz[oó]|(?:pago|cargo|cobro) no realizado|pago (?:no recibido|por realizar)|solicitud de (?:cr[eé]dito|financiaci[oó]n)\b[^.!?\n]{0,35}\baprobad[ao]|charge failed|failed (?:to process|card payment)|(?:couldn['’]t|unable to) (?:process|charge)|payment (?:failed|required|declined|due))\b/i;
const googlePlayFallbackSubject = /^se uso una forma de pago alternativa\b[^\n]{0,150}\|\s*tu recibo de pedido de google play\b/;
const googlePlayFallbackReceipt = /\bse realizo un (?:cargo|cobro) en (?:tu )?(?:visa|mastercard|amex|tarjeta)\b/;
const googlePlayCardField = /(?:^|\n)[ \t]*forma de pago[ \t]*:[ \t]*(?:\n[ \t]*)?(visa|mastercard|amex)[ \t]*[-‐‑–][ \t]*(\d{4})(?!\d)/g;
const cancelledPurchase = /\b(?:pago|compra|transaccion) (?:(?:fue|esta|ha sido|quedo) )?cancelad[oa]\b/g;
const processingError = /\b(?:transacci(?:o|\?|�)n (?:con |resulto en (?:un )?)error|se produjo un error en el pago|no pudimos (?:procesar|realizar|completar) (?:tu |su |el )?(?:pago|cobro)|no hemos recibido (?:tu|su) pago)\b|(?:^|\n)[ \t]*estado(?:[ \t]*:[ \t]*|[ \t]{2,}|\t+)[ \t]*(?:error|declined|failed|rejected)\b/i;
const unsuccessfulPayment = /\bno se pudo hacer (?:tu|su|el) pago\b/;
const qaSubject = /\b(?:aviso qa|mailgasto.{0,12}\bqa|(?:aviso|pago|transaccion|compra|comprobante|confirmacion) de prueba|sandbox)\b/;
const expenseEvidence = /\b(?:pagaste|compraste|enviaste|transferiste|retiraste|(?:recibimos|hemos recibido) (?:tu|su) pago|(?:realizaste|hiciste) un (?:pago|retiro)|te (?:debitaron|cobraron|descontaron)|se (?:te )?(?:debito|cobro)|se realizaron los cargos|se proceso su pago|compra (?:fue )?(?:confirmada|aprobada|realizada|exitosa|procesada|completada)|(?:tu|su) pago (?:(?:fue|ha sido) )?(?:confirmado|aprobado|realizado|exitoso|procesado|completado|aplicado)|el pago de tu pedido\b[^.!?\n]{0,120}\bfue confirmado|el pago de tu pedido\b[^.!?\n]{0,120}\bha sido confirmado)\b/;
const incomeEvidence = /\b(?:recibiste\s+(?=un(?:a)? (?:pago|transferencia|consignacion|devolucion)\b|(?:plata|dinero|tu dinero|cop|usd|eur)\b|[$€\d])|(?:te (?:enviaron|transfirieron|abonaron|acreditaron|consignaron|reembolsaron)|se (?:te )?(?:abono|acredito|consigno)|(?:transferencia|consignacion|deposito|abono|reembolso|desembolso) (?:fue )?(?:recibid[oa]|acreditad[oa]|abonad[oa])|pago recibido en tu cuenta)\b)/;
const conditional = /\bsi (?:(?:ya|aun|todavia) )?(?:pagaste|compro|compraste|recibiste|recibio|transferiste|transfirio|enviaste|envio|hiciste|hizo|realizaste|realizo|efectuaste|efectuo|pago)\b(?:[^.!?\n]|\.(?=\d))*/g;
const invoicePayment = /\b(?:total pagado|(?:pago|cargo) (?:(?:fue|ha sido) )?(?:efectivamente )?(?:aplicado|confirmado|efectuado|realizado|recibido|exitoso))\b/;
const futurePayment = /\b(?:el|tu|su) pago (?:de (?:tu|su|la) factura )?(?:quedara registrado|se (?:podra procesar|procesara|hara|registrara)|sera (?:procesado|aplicado))\b/;
const paymentReminder = /\bpayment of[ \t]+(?:(?:cop|usd|eur)[ \t]+)?[$€]?[ \t]*\d[\d.,]*[ \t]+required\b/;
const creditPurchase = /\bacabas de pagar por medio de tu credito agaval una compra realizada\b/;
const gmailSecurityFooter = /(?:\bpor tu seguridad\b|\bprotege tus datos\b|\b(?:si tienes dudas[, \t\n]+(?:ll[aá]manos|hablemos|encu[eé]ntranos)|estos consejos de seguridad|si no fuiste t[uú]|recuerda que tambi[eé]n puedes usar la llave)\b|\b(?:esto|este) es un (?:correo|mensaje) autom[aá]tico\b|\best[ea] es una notificaci[oó]n autom[aá]tica\b|\b(?:bancolombia|nequi) nunca (?:te|le) solicitar[aá]\b|\baviso (?:de confidencialidad|legal)\b)/i;
const issuerClaim = /^\s*(?:(?:banco|entidad)\s*:\s*)?(?:bancolombia|nequi)\s*:/im;
const personalSender = /@(?:gmail\.com|googlemail\.com|outlook\.com|hotmail\.com|live\.com|msn\.com|yahoo\.[a-z.]+|icloud\.com|proton(?:mail)?\.com)$/;
const noChargeTrial = /\b(?:suscripcion de prueba|prueba gratuita|free trial)\b/;
const confirmedAmountPaid = /\b(?:se realizaron los cargos|total pagado|amount paid)\b/;
const receiptSubject = /\b(?:comprobante de (?:compra|pago|transferencia)|confirmacion de pago|pago (?:recibido|exitoso|aprobado|procesado|confirmado)|transaccion (?:aprobada|exitosa)|recibo de (?:pago|pedido|compra)|recibo de tu pedido|payment receipt|devolvio el dinero)\b/;
const receiptEvidence = /\b(?:we(?:'ve)? received (?:your )?payment|pago exitoso|estado\s*:\s*(?:exitoso|aprobado|pagado)|monto desembolsado)\b/;
const mailingListDelivery = /\b(?:recibiste|recibes) este (?:mail|correo(?: electronico)?|mensaje) porque\b/;
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
    .replace(/\biv_[a-z\d_-]{8,}\b/gi, '[identificador]')
    .replace(/(\b(?:ref\.|referencia|id (?:n[uú]mero|transacci[oó]n)|cus|c[oó]digo [uú]nico de seguimiento)[ \t]*[:#=]?[ \t]+)(?=[\w-]*\d)[\w-]{6,80}(?![\w-])/gi,
      '$1[identificador]')
    .replace(cardIdentifier, '$1 [identificador]')
    .replace(/\b(visa|mastercard|amex)[ \t]*(?:[-‐‑–*xX][ \t]*)+\d{4,}\b/gi, '$1 [identificador]')
    .replace(maskedIdentifier, '[identificador]')
    .replace(/\b(?:cuenta|documento|referencia|autorizaci[oó]n|c[eé]dula|tel[eé]fono|celular|identificaci[oó]n|terminad[ao] en|c[oó]digo (?:de seguridad|de verificaci[oó]n|OTP))\s*(?:(?:n[uú]mero|no\.?|nro\.?|de|es)\s*)?[:#*xX -]*\d[\d* xX-]*/gi, match => match.replace(/[:#*xX -]*\d[\d* xX-]*$/, ' [identificador] '))
    .replace(/(\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?\b(?!-\d))|(?<![\d.,])\b(?:\d[ -]?){8,19}\d\b(?![\d.,])/g,
      (_, date: string | undefined) => date ?? '[identificador]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

export function hasGmailSenderAuthentication(line: unknown, from: string) {
  const domain = address(from)?.split('@')[1];
  if (!domain || typeof line !== 'string' || !/^authentication-results:\s*mx\.google\.com\s*;/i.test(line)) return false;
  const aligns = (signer: string | undefined) => signer === domain ||
    signer === 'notificacionesbancolombia.com' && domain.endsWith('.' + signer);
  return line.split(';').some(part => {
    if (/^\s*dmarc=pass\b/i.test(part)) return aligns(/\bheader\.from=([a-z\d.-]+)/i.exec(part)?.[1]?.toLowerCase());
    if (!/^\s*dkim=pass\b/i.test(part)) return false;
    return aligns((/\bheader\.i=(?:[a-z0-9._%+-]+)?@([a-z\d.-]+)/i.exec(part)?.[1] ??
      /\bheader\.d=([a-z\d.-]+)/i.exec(part)?.[1])?.toLowerCase());
  });
}

function address(value: string) {
  const mailbox = (value.match(/<([^<>]+)>\s*$/)?.[1] ?? value).trim().toLowerCase();
  return bareAddress.test(mailbox) ? mailbox : undefined;
}

function rejectedGmailNotice(subject: string, head: string, completion: string, invoice: boolean) {
  const unpaidInvoice = invoice && !(invoicePayment.test(completion) ||
    (expenseEvidence.test(completion) && !informationalOnly.test(head) && !futurePayment.test(completion)));
  const unprocessedPayment = futurePayment.test(completion) && !expenseEvidence.test(completion) &&
    !invoicePayment.test(completion);
  const unpaidReminder = paymentReminder.test(subject) && /\bpast due balance\b/.test(head) &&
    !confirmedAmountPaid.test(completion) && !expenseEvidence.test(completion) && !receiptEvidence.test(completion);
  return excludedSubject.test(subject) || unpaidInvoice || unprocessedPayment || unpaidReminder || excluded.test(head) || blocksGmailCompletion(head) ||
    mailingListDelivery.test(completion) ||
    qaSubject.test(subject) || (noChargeTrial.test(head) && !confirmedAmountPaid.test(head));
}

function blocksGmailCompletion(text: string) {
  const status = completedRefund.test(text) && !futureRefund.test(text) ? text.replace(cancelledPurchase, '') : text;
  return notCompleted.test(status) || gmailRejected.test(status) || processingError.test(status) || unsuccessfulPayment.test(status);
}

function gmailPrimaryText(body: string) {
  return normalize(body).replace(historicalSection, '\n').replace(historicLine, '\n').replace(conditional, '');
}

function gmailHasExpense(text: string) {
  return expenseEvidence.test(text) || englishExpense.test(text);
}

function gmailHasIncome(text: string) {
  return incomeEvidence.test(text) || englishIncome.test(text);
}

export function isGmailExplicitNonMovement(subject: string, body: string) {
  const subjectText = normalize(subject.slice(0, 1000));
  const bodyText = gmailPrimaryText(body.slice(0, 5000));
  const head = subjectText + '\n' + bodyText.slice(0, 600);
  const invoice = electronicInvoice.test(subjectText) || /\bfactura electronica de venta\b/.test(head);
  if (/^\s*\[mailgasto ia\]|\b(?:aviso|pago|transaccion|compra|comprobante|confirmacion) de prueba\b/.test(subjectText)) return true;
  if ((gmailHasExpense(bodyText) || gmailHasIncome(bodyText)) && !qaSubject.test(subjectText)) return false;
  return rejectedGmailNotice(subjectText, head, bodyText, invoice) || englishRequest.test(head) ||
    (futureRefund.test(head) && !completedRefund.test(head));
}

const nequiCusPayment = /(?:^|\n)[ \t]*cus[ \t]*:[ \t]*\d{6,20}\b/;

export function gmailForwarded(subject: string, body: string) {
  return /^\s*(?:fw|fwd|rv|reenviado)\s*:/i.test(subject) || forwardedHeader.test(body.replace(/\r\n?/g, '\n'));
}

export function candidate(from: string, subject: string, body: string, senders: SenderMap,
  authenticated?: boolean, receivedDay?: string): GmailNotice | null {
  if (/^\s*\[MailGasto IA\]/i.test(subject)) return null;
  let sender = address(from);
  const forwarded = gmailForwarded(subject, body);
  body = body.replace(/\r\n?/g, '\n').slice(0, 30_000);
  const marker = forwardedHeader.exec(body);
  if (marker) {
    const original = body.slice(marker.index + marker[0].length);
    const end = /\n[ \t]*\n/.exec(original);
    if (end && end.index <= 2000) {
      const header = original.slice(0, end.index);
      sender = address(header.match(/^(?:From|De):([^\n]*)$/mi)?.[1] ?? '') ?? sender;
      subject = header.match(/^(?:Subject|Asunto):([^\n]*)$/mi)?.[1]?.trim() ?? subject;
      body = original.slice(end.index + end[0].length).trim();
    }
  }
  if (/^\s*\[MailGasto IA\]/i.test(subject)) return null;
  const domain = sender && '@' + sender.split('@')[1];
  const provider = sender && Object.hasOwn(senders, sender) ? senders[sender] :
    domain && Object.hasOwn(senders, domain) ? senders[domain] : null;
  subject = subject.slice(0, 1000).replace(/[\u00a0\u202f]/g, ' ').trim();
  body = body.replace(/[\u00a0\u202f]/g, ' ')
    .split(/\n[ \t]*(?:--\s*$|aviso (?:de confidencialidad|legal)|este correo (?:es confidencial|y cualquier archivo anexo)|on [^\n]{4,140} wrote:|el [^\n]{4,140} escribi[oó]:|>)/im, 1)[0].trim();
  const footer = body.search(gmailSecurityFooter);
  if (footer > 0) {
    const beforeFooter = normalize(body.slice(0, footer));
    if (gmailHasExpense(beforeFooter) || gmailHasIncome(beforeFooter)) body = body.slice(0, footer).trim();
  }
  // Look at the mask before redaction, without cutting a longer identifier into a four-digit suffix.
  const format = !forwarded && sender && Object.hasOwn(gmailReceiptSenders, sender)
    ? gmailReceiptSenders[sender as keyof typeof gmailReceiptSenders] : undefined;
  const unauthenticated = forwarded || !sender || authenticated === false || personalSender.test(sender) ||
    (!provider && issuerClaim.test(body));
  if (provider === 'bancolombia' && authenticated === true && !unauthenticated && validDay(receivedDay)) {
    body = expandBancolombiaDate(body, receivedDay);
  }
  const knownNequiPse = !unauthenticated && authenticated === true && provider === 'nequi' && sender === 'somos@nequi.com.co' &&
    /^¡?pago exitoso!?$/i.test(subject.trim()) && /\bhiciste un pago en\b/i.test(body) && nequiCusPayment.test(normalize(body));
  const payment = extractGmailPayment(subject, body, unauthenticated ? undefined : format, knownNequiPse);
  const references = sender && authenticated === true && !unauthenticated
    ? gmailReceiptReferences(sender, subject, body, payment.paymentMethod) : [];
  const invoiceTitle = electronicInvoice.test(normalize(subject));
  subject = redact(subject).trim();
  body = redact(body).slice(0, 5000 - subject.length - 1);
  const head = normalize(subject + '\n' + body.slice(0, 600));
  const subjectText = normalize(subject);
  const core = gmailPrimaryText(body);
  const meaningful = (normalize(subject) + '\n' + core).trim();
  const monetaryNotice = /(?:\b(?:COP|USD|EUR)\s*|[$€]\s*)\d/i.test(meaningful) && findDates(meaningful).length > 0;
  if (!transactionWords.test(meaningful) && !receiptSubject.test(meaningful) && !monetaryNotice) return null;
  if (/\b(?:aviso|pago|transaccion|compra|comprobante|confirmacion) de prueba\b/.test(subjectText)) return null;
  const hasOperation = gmailHasExpense(core) || gmailHasIncome(core) || Boolean(receiptDirection(format, subjectText, core));
  const invoice = invoiceTitle || /\bfactura electronica de venta\b/.test(head);
  if (!hasOperation && (rejectedGmailNotice(subjectText, head, core, invoice) || informationalOnly.test(head) || englishRequest.test(head) ||
    futureRefund.test(head) && !completedRefund.test(head))) return null;
  // Forwarded headers and the apparent From do not authenticate an original.
  return { provider: authenticated === false ? 'other' : provider ?? 'other', forwarded, subject, body, payment,
    ...(format && !unauthenticated ? { format } : {}), ...(unauthenticated ? { unauthenticated } : {}),
    ...(references.length ? { references } : {}) };
}

export const gmailReferencePattern = /^(?:pse:\d{6,20}|pse-wompi-famicredito:[a-zA-Z\d_-]{12,80}|aval-bre-b:\d[a-z\d]{11,59})$/;
const avalCopyTitle = /\bcomprobante de pago transaccion bre[‐‑–-]b\b/;

export function gmailReceiptReferences(from: string, subject: string, body: string, payment: GmailPayment['paymentMethod']) {
  const issuer = address(from);
  const refs: string[] = [];
  const text = normalize(subject + '\n' + body);
  const add = (namespace: string, matches: Iterable<RegExpMatchArray>) => {
    const reference = singleValue(Array.from(matches, match => match[1]));
    if (reference) refs.push(namespace + ':' + reference);
  };
  if (issuer === 'serviciopse@achcolombia.com.co' || issuer === 'somos@nequi.com.co' ||
      issuer === 'informacion.pagos@claro.com.co' && payment === 'PSE') {
    add('pse', text.matchAll(/\b(?:cus|codigo unico de seguimiento)\s*[:#=]?\s*(\d{6,20})\b/g));
  }
  if (payment === 'PSE' && (issuer === 'serviciopse@achcolombia.com.co' || issuer === 'no-reply@wompi.co')) {
    const lines = issuer === 'no-reply@wompi.co' ? [subject] : body.split('\n').filter(line =>
      /^[ \t]*descripcion[ \t]*:/.test(normalize(line)));
    const merchantLines = lines.filter(line => /\bfami\s*credito\b/.test(normalize(line)));
    add('pse-wompi-famicredito', merchantLines.flatMap(line =>
      [...line.matchAll(/\bref(?:\.|erencia)?\s*[:=]?\s+([a-z\d_-]{12,80})(?![\w-])/gi)]));
  }
  if (payment === 'Bre-B' && (issuer === 'info@pasarelapagosaval.com' ||
      issuer === 'no-responder@avalpaycenter.com.co' && avalCopyTitle.test(normalize(subject)))) {
    add('aval-bre-b', text.matchAll(/\bid (?:numero|transaccion)\s*[:#=]?\s*(\d[a-z\d]{11,59})\b/g));
  }
  return refs.filter(key => gmailReferencePattern.test(key));
}

const moneyPattern = /(?:\b(?:valor(?: de la (?:compra|transacci[oó]n))?|monto|importe|pagaste|compraste|recibiste|enviaste|transferiste|retiraste|por(?: valor de)?)\s*[:=]?\s*)((?:COP|USD|EUR|US\$|[$€])\s*\d[\d.,]*|\d[\d.,]*\s*(?:COP|USD|EUR)\b)/giu;
const moneyAny = /(?:COP|USD|EUR|US\$|[$€])\s*\d[\d.,]*|\d[\d.,]*\s*(?:COP|USD|EUR)\b/giu;
const numberToken = /\d+(?:[.,]\d+)*/.source;
const currencySuffix = /(?:COP|USD|EUR|pesos(?: colombianos)?|d[oó]lares(?: estadounidenses)?|euros)\b/.source;
const explicitAmount = '(?:(?:US\\$|(?:COP|USD|EUR)\\s*[$€]?|[$€])\\s*' + numberToken +
  '(?:\\s*' + currencySuffix + ')?|' + numberToken + '\\s*' + currencySuffix + ')';
const amountBoundary = /(?![\p{L}\d:/%+-]|[.,]\d)/u.source;
const amountContext = /\b(?:pagaste|compraste|recibiste|enviaste(?: de manera exitosa)?|transferiste|retiraste|te (?:abonaron|acreditaron|consignaron|reembolsaron)|se (?:te )?(?:abon[oó]|acredit[oó]|debit[oó]|cobr[oó])|monto(?: (?:pagado|recibido|desembolsado|del pago))?|importe|valor(?: (?:de (?:(?:la|el|tu) )?(?:compra|transacci[oó]n|pago|transferencia)|pagado|recibido))?|total (?:pagado|cobrado)|amount paid|por valor de)[ \t]*[:=]?\s*/u.source;
const gmailAnchoredMoney = new RegExp(amountContext + '(' + explicitAmount + '|' + numberToken + ')' + amountBoundary, 'giu');
const gmailExplicitMoney = new RegExp('(?<![\\p{L}\\d.,:/+\\-])' + explicitAmount + amountBoundary, 'giu');
const movistarReceipt = new RegExp('\\bsu pago por[ \\t]+(' + explicitAmount + ') del[ \\t]+' +
  '(\\d{2}/\\d{2}/\\d{4})[ \\t]+se aplico correctamente a la cuenta\\b', 'gu');
const paidLabels = { hostinger: 'total pagado', digitalocean: 'amount paid', google_play: 'total', github: 'total', famicredito: 'total pagado',
  agaval_credit: 'valor total de los bienes' } as const;
const ebanxFinal = new RegExp('(?:^|\\n)[ \\t]*valor final en[ \\t]+(cop|usd|eur)[ \\t]*[:=]?[ \\t]*(?:\\n[ \\t]*)?' +
  '((?:[$€][ \\t]*)?' + numberToken + ')' + amountBoundary, 'giu');
const unsupportedCurrency = /\b(?:MXN|ARS|CLP|PEN|BRL|GBP|CHF|CAD|AUD|JPY|CNY|VES|CRC|DOP|UYU)\b|[£¥₹]|\b(?:pesos (?:mexicanos|argentinos|chilenos)|d[oó]lares (?:canadienses|australianos))\b/i;
const balanceLabel = /\b(?:saldo|cupo|comisi[oó]n|impuestos?|iva|subtotal|descuento|intereses?|total a pagar|saldo en mora|cobro futuro|balance|fee|tax|discount|amount due|total due|amount payable)\b[^.!?\n;\d$€]{0,30}$/i;
const operatedTotalLabel = /\b(?:total (?:pagado|abonado|cobrado|de la transacci[oó]n)|monto (?:pagado|abonado|cobrado)|importe (?:pagado|cobrado)|(?:amount|total) (?:paid|charged|credited)|transaction (?:total|amount)|payment (?:total|amount))\b[ \t]*[:=]?[ \t]*(?:\n[ \t]*)?/.source;
const operatedTotal = new RegExp(operatedTotalLabel + '(' + explicitAmount + '|' + numberToken + ')' + amountBoundary, 'giu');
const monetaryCurrency = /\b(?:COP|USD|EUR|pesos|d[oó]lares|euros)\b|US\$|€/i;

export function parseMoney(value: string, defaultCurrency: typeof currencies[number] = 'COP') {
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

function extractGmailMoney(text: string, format?: GmailFormat) {
  if (unsupportedCurrency.test(text)) return null;
  const declared = [...new Set([...text.toUpperCase().matchAll(/\b(?:MONEDA|CURRENCY)(?:\s*[:=]\s*|\t+|[ \t]{2,}|\n[ \t]*)(COP|USD|EUR)\b/g)].map(match => match[1]))];
  if (declared.length > 1) return null;
  const currency = currencies.find(value => value === declared[0]) ?? (format === 'digitalocean' ? 'USD' : undefined);
  if (format === 'movistar') {
    const amounts = [...normalize(text).matchAll(movistarReceipt)].map(match => match[1]);
    const paid = singleAmount(amounts, currency);
    return currency && paid?.currency !== currency ? null : paid;
  }
  if (format === 'ebanx') {
    const finals = [...text.matchAll(ebanxFinal)].map(match => match[1] + ' ' + match[2]);
    if (finals.length) {
      const final = singleAmount(finals);
      return currency && final?.currency !== currency ? null : final;
    }
  }
  if (format && Object.hasOwn(paidLabels, format)) {
    const label = paidLabels[format as keyof typeof paidLabels];
    const receiptTotal = new RegExp('(?:^|\\n)[ \\t]*' + label + '[ \\t]*[:=]?\\s*(' + explicitAmount + ')' + amountBoundary, 'giu');
    const totals = [...text.matchAll(receiptTotal)].map(match => match[1]);
    if (totals.length) {
      if (format === 'github' && totals.some(token => !/\b(?:USD|COP|EUR)\b|US\$|€/i.test(token))) return null;
      if (format === 'digitalocean' || format === 'hostinger') {
        const firstLine = text.indexOf('\n');
        const firstLineAmounts = firstLine !== -1 ? [...text.slice(0, firstLine).matchAll(gmailExplicitMoney)].map(match => match[0]) : [];
        totals.push(...firstLineAmounts);
      }
      const total = singleAmount(totals, currency);
      return currency && total?.currency !== currency ? null : total;
    }
    if (format === 'google_play') return null;
  }
  const totals = [...text.matchAll(operatedTotal)].map(match => match[1]);
  const anchored = [...text.matchAll(gmailAnchoredMoney)]
    .filter(match => !balanceLabel.test(text.slice(Math.max(0, match.index - 40), match.index)))
    .map(match => match[1]);
  const explicit = [...text.matchAll(gmailExplicitMoney)]
    .filter(match => {
      const preceding = text.slice(Math.max(0, match.index - 55), match.index);
      return !balanceLabel.test(preceding) && !/\b(?:saldo|cupo|comisi[oó]n|impuestos?|iva|subtotal|descuento|intereses?)\s*[:=]?\s*$/i.test(preceding);
    })
    .map(match => match[0]);
  const tokens = [...totals, ...anchored, ...explicit];
  const markedCurrency = singleValue(tokens.filter(token => monetaryCurrency.test(token)).map(token => parseMoney(token)?.currency));
  if (!currency && englishExpense.test(normalize(text)) && !expenseEvidence.test(normalize(text)) && !markedCurrency) return null;
  const money = singleAmount(tokens, currency ?? markedCurrency ?? undefined);
  return currency && money?.currency !== currency ? null : money;
}

const months = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const monthAbbreviations = ['ene jan', 'feb', 'mar', 'abr apr', 'may', 'jun', 'jul', 'ago aug', 'sep sept set', 'oct', 'nov', 'dic dec'];
const dateText = /(?:\d{4}(?:-\d{2}-\d{2}|\/\d{2}\/\d{2})|\d{1,2}[/-](?:\d{1,2}|[a-z]{3,4})[/-]\d{4}|\d{1,2}(?: de [a-z]+ de | [a-z]{3,4}\.? )\d{4})/.source;
const dateMention = new RegExp('\\b' + dateText + '\\b', 'g');
export function validDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function expandBancolombiaDate(body: string, received: string) {
  const dayMonthYear = /\b((?:compraste|pagaste|transferiste|enviaste|retiraste|recibiste)\b(?:[^\n.!?]|\.(?=\d)){0,300}\bel(?: d[ií]a)?[ \t]+)(\d{1,2})\/(\d{1,2})\/(\d{2})\b(?=[ \t]+(?:a las?[ \t]+)?\d{1,2}:\d{2})/gi;
  const receiptYear = Number(received.slice(0, 4));
  return body.replace(dayMonthYear, (literal, prefix: string, day: string, month: string, shortYear: string) => {
    const century = Math.floor(receiptYear / 100) * 100;
    const year = [century + Number(shortYear), century - 100 + Number(shortYear)].find(value =>
      value <= receiptYear && value >= receiptYear - 1);
    if (!year) return literal;
    const expanded = year + '-' + month.padStart(2, '0') + '-' + day.padStart(2, '0');
    return validDay(expanded) && expanded <= received ? prefix + day + '/' + month + '/' + year : literal;
  });
}

export function gmailReceivedDay(receivedAt: string) {
  const instant = Date.parse(receivedAt);
  if (!Number.isFinite(instant)) return undefined;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value ?? '').join('-');
}

function singleValue<T>(values: Iterable<T>) {
  const unique = new Set(values);
  return unique.size === 1 ? [...unique][0] : null;
}

function findDates(text: string) {
  const dates = [];
  for (const match of text.matchAll(dateMention)) {
    const [day, month, year] = match[0].split(/ de |[/-]|\.? /);
    const monthIndex = months.indexOf(month === 'setiembre' ? 'septiembre' : month);
    const monthNumber = /^\d+$/.test(month) ? month : String(1 + (monthIndex >= 0 ? monthIndex :
      monthAbbreviations.findIndex(aliases => aliases.split(' ').includes(month))));
    const date = day.length === 4 ? match[0].replaceAll('/', '-') : year + '-' + monthNumber.padStart(2, '0') + '-' + day.padStart(2, '0');
    if (validDay(date)) dates.push({ date, start: match.index, end: match.index + match[0].length });
  }
  return dates;
}

export const transactionTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const clock = /(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[ \t\u00a0\u202f]*([ap])\.?[ \t\u00a0\u202f]*m\.?)?(?![\w:])/.source;
const clockAfterDate = new RegExp('^\\s*(?:[,;]\\s*)?(?:(?:a\\s+las?|hora)\\s*:?\\s*)?' + clock);
const clockBeforeDate = new RegExp('\\ba las?[ \\t]+' + clock + '[ \\t]*(?:(?:,|del|el|de)[ \\t]*)?$');
const alternativeClock = new RegExp('^[ \\t]+[oy][ \\t]+a las?[ \\t]+' + clock);
const clockInField = new RegExp('(?:^|[.;\\n])[ \\t]*hora(?:[ \\t]+(?:de[ \\t]+(?:(?:la|el)[ \\t]+)?|del[ \\t]+)' +
  '(?:compra|operacion|transaccion|pago|movimiento))?[ \\t]*[:=][ \\t]*' + clock, 'g');
const nonOperationDate = /\b(?:(?:correo[ \t]+)?(?:recibid[oa]|enviad[oa])|(?:fecha[ \t]+(?:de[ \t]+)?)?(?:recepcion|envio|emision|expedicion|generacion|notificacion|facturacion|vencimiento|limite(?: de pago)?|proximo cobro|proximo pago|proxima renovacion)(?: del correo)?|paga (?:antes de|hasta)|periodo facturado|(?:issue|invoice|due|billing|receipt|email|statement|renewal) date|issued|sent on|due(?: on)?|service period)[ \t]*[:=,]?[ \t]*(?:el[ \t]+)?$/;
const loanDateField = /\b(?:fecha (?:de(?:l)? )?(?:desembolso|giro|abono)[ \t]*[:=]?|(?:fue|ha sido) desembolsado el)\s*$/;
const operationDate = /\b(?:fecha (?:de(?:l| la)? )?(?:pago|transacci(?:o|\?|�)n|cargo|operacion)[ \t]*[:=]?|(?:pago|cargo) (?:realizado|confirmado|procesado) el|(?:transaction|payment|purchase|charge) date[ \t]*[:=]?|(?:paid|charged|settled) on)\s*$/;
const orderDateField = /(?:^|\n)[ \t]*fecha (?:del|de tu) pedido[ \t]*[:=]?[ \t]*/;
const receiptDateField = /\bfecha(?: y hora)?[ \t]*[:=]?\s*$/;
const githubDateField = /(?:^|\n)[ \t]*date[ \t]*:[ \t]*$/;
const ebanxTimeField = new RegExp('^[ \\t]*\\|[ \\t]*' + clock + '[ \\t]*(?:\\n|$)');
const travelPeriod = /\b(?:fechas? de (?:tu |el )?viaje|check[- ]?(?:in|out))\b/;

function readClock(match: RegExpMatchArray) {
  const [, hour, minute, second, period] = match;
  const value = Number(hour);
  if (period && (value < 1 || value > 12)) return null;
  const hours = period ? value % 12 + (period === 'p' ? 12 : 0) : value;
  const time = String(hours).padStart(2, '0') + ':' + minute + (second ? ':' + second : '');
  return transactionTimePattern.test(time) ? time : null;
}

function googlePlayOperationDate(text: string, dates: ReturnType<typeof findDates>, subjectLength: number) {
  const subjectDate = singleValue(dates.filter(match => match.start < subjectLength).map(match => match.date));
  const orderDates = dates.filter(match => match.start > subjectLength);
  if (!orderDates.length) return { date: subjectDate, transactionTime: null };
  const times = orderDates.map(({ date, end }) => {
    const tail = text.slice(end, end + 90);
    const match = tail.match(clockAfterDate);
    const time = match && readClock(match);
    if (!time) return { date, time: null };
    const remaining = tail.slice(match[0].length);
    const zone = /^[ \t]*(?:(?:gmt|utc)[ \t]*([+-])(\d{1,2})(?::?([0-5]\d))?|((?:e[ds]t|c[ds]t|m[ds]t|p[ds]t|utc|gmt)))(?=[ \t,.\n]|$)/i.exec(remaining);
    if (!zone) return { date, time };
    const [, sign, hours, minutes, name] = zone;
    const offsets = { utc: 0, gmt: 0, est: -300, edt: -240, cst: -360, cdt: -300, mst: -420, mdt: -360, pst: -480, pdt: -420 };
    const offset = sign ? (sign === '-' ? -1 : 1) * (Number(hours) * 60 + Number(minutes ?? 0)) : offsets[name as keyof typeof offsets];
    if (!Number.isFinite(offset) || Math.abs(offset) > 840) return { date, time: null };
    const clock = time.length === 5 ? time + ':00' : time;
    const local = new Date(Date.parse(date + 'T' + clock + 'Z') - (offset + 300) * 60_000).toISOString();
    if (!validDay(local.slice(0, 10))) return { date, time: null };
    return { date: local.slice(0, 10), time: local.slice(11, time.length === 5 ? 16 : 19) };
  });
  const date = singleValue(times.map(receipt => receipt.date));
  if (!date || subjectDate && subjectDate !== date && orderDates.some(order => order.date !== subjectDate)) {
    return { date: null, transactionTime: null };
  }
  return { date, transactionTime: singleValue(times.map(receipt => receipt.time)) };
}

function extractGmailTime(text: string, dates: ReturnType<typeof findDates>, date: string | null, format?: GmailFormat) {
  const matches: RegExpMatchArray[] = [...text.matchAll(clockInField)];
  if (date) {
    for (const { start, end } of dates) {
      const tail = text.slice(end, end + 90);
      const after = tail.match(format === 'ebanx' ? ebanxTimeField : clockAfterDate);
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
export const paymentMethods = ['Nequi', 'Bancolombia', 'Tarjeta', 'PSE', 'Transferencia', 'QR', 'Botón Bancolombia', 'Bre-B'] as const;
export const cardTypes = ['debit', 'credit'] as const;
export const cardLast4Pattern = /^\d{4}$/;
type GmailPayment = {
  paymentMethod: typeof paymentMethods[number] | null;
  cardType: typeof cardTypes[number] | null;
  cardLast4: string | null;
};

const paymentToken = '(?:' + cardLabel + '|nequi\\b|(?:d[e?�]bito bancario(?: por)?\\s+)?pse\\b|bre[‐‑–-]b\\b|(?:codigo\\s+)?qr\\b|boton\\s+bancolombia\\b|transferencia\\b|(?:visa|mastercard|amex)(?=[-‐‑– *]|$))';
const paymentContext = /\b(?:(?:con|mediante|por|via|usando|a traves de)\s+(?:(?:tu|su|una|la|el)\s+)?|(?:medio|metodo|forma)s? de pago(?:\/franquicia)?(?:[ \t]*[:=][ \t]*(?:\n[ \t]*)?|\t+|[ \t]{2,}|\n[ \t]*))/.source;
const paymentMention = new RegExp('(?:' + paymentContext + '|^[ \\t]*(?=' + cardLabel + '[ \\t]*[:=]))(' + paymentToken + ')', 'gm');
const nextPayment = new RegExp('^[ \\t]*(?:[,/]|\\b[oy]\\b)[ \\t]*(?:(?:tu|su|una|la|el)[ \\t]+)?(' + paymentToken + ')');
const cardToken = new RegExp('^' + cardLabel + '$');
const maskedCardSuffix = new RegExp('^' + cardNumberPrefix + cardMask + '(\\d{4})(?![\\w:/]|[.,]\\d|[ .\\t-]+[\\d*x×•●])');
const purchaseMerchant = new RegExp('\\b(?:compraste|pagaste)\\s+(?:' + explicitAmount + '|' + numberToken + ')\\s+en\\s+' +
  '([^\\n]{1,160}?)(?=,?\\s+(?:' + paymentContext + paymentToken + '|el\\s+(?:d[ií]a\\s+)?' + dateText + '\\b))', 'giu');
const transferRecipient = new RegExp('\\b(?:pagaste|transferiste)\\s+(?:' + explicitAmount + '|' + numberToken +
  ')(?:\\s+(?:con|por|mediante)\\s+(?:el\\s+)?bot[oó]n\\s+bancolombia)?' +
  '\\s+a\\s+([^\\n]{1,160}?)(?=\\s+(?:desde (?:tu |el |la )?(?:cuenta|producto)|con (?:el )?bot[oó]n|el\\s+' + dateText + '\\b))', 'giu');

const billMerchant = /\b(?:hiciste un pago|listo tu pago|tu pago)\s+en\s+([^\n]{1,160}?)(?=\s+(?:por\s+[$€\d]|con\s+nequi|fue\s+exitoso|pagaste\b)|\s*$)/gim;
const fieldMerchant = /(?:^|\n)[ \t]*(?:empresa|comercio)(?:[ \t]*[:=][ \t]*|[ \t]{2,}|\t+|\r?\n[ \t]*)([^\n]{1,160})/gi;
const storeProduct = new RegExp(/(?:^|\n)[ \t]*([\p{L}\d][^\n\t]{1,150}?)(?:\t+| {2,})(?=[$€]|(?:COP|USD|EUR)\b)/u.source, 'giu');
const labelledProduct = /(?:^|\n)[ \t]*producto[ \t]*:[ \t]*([^\n\t]{1,150})/giu;

function googlePlayProduct(body: string) {
  const names = [...body.matchAll(labelledProduct), ...body.matchAll(storeProduct)].map(([, name]) => name.trim());
  return singleValue(names.filter(name => !/\b(?:total|impuesto|precio|subtotal|incluye iva|saldo|descuento)\b/i.test(name) &&
    !/\[\w+\]/.test(name) && /\p{L}/u.test(name)));
}

function extractPurchaseMerchant(body: string, format?: GmailFormat) {
  const buttonNames = /\b(?:con|por|mediante) (?:el )?bot[oó]n bancolombia\b/i.test(body)
    ? [...body.matchAll(transferRecipient)].filter(([, name]) =>
      /\b(?:s\.?\s*a\.?(?:\s*s\.?)?|ltda\.?|e\.?\s*s\.?\s*p\.?)(?:\s+[a-záéíóúñ]{2,20})?$/i.test(name) ||
      matchingCategories(name).length === 1) : [];
  const names = [...body.matchAll(purchaseMerchant), ...buttonNames, ...body.matchAll(billMerchant),
    ...(['pse', 'aval', 'wompi', 'claro'].includes(format ?? '') ? body.matchAll(fieldMerchant) : [])]
    .map(match => match[1].trim().replace(/,$/, '').trim());
  const merchant = singleValue(names.filter(name => /\p{L}/u.test(name) && !/\[\w+\]|^(?:la llave|la cuenta|una cuenta)\b/i.test(name) &&
    !/[.!?]\s/.test(name.replace(/\b(?:[\p{L}]\.){2,}/gu, '')) && !findDates(normalize(name)).length));
  if (merchant) return merchant;
  if (format === 'ebanx') return singleValue([...body.matchAll(ebanxReceipt)].map(match => match[1].trim()));
  if (format === 'digitalocean' && /\bDigitalOcean Receipt\b/i.test(body)) return 'DigitalOcean';
  if (format === 'github') return body.match(/(?:^|\n)[ \t]*(GitHub) Receipt\b/im)?.[1] ?? null;
  if (format === 'hostinger') return body.match(/\bHostinger International Ltd\./i)?.[0] ?? null;
  if (format === 'claro') return body.match(/\bClaro\b/i)?.[0] ??
    body.match(/(?:^|\n)[ \t]*(Pago factura (?:de )?hogar[^\n]{0,120})/im)?.[1]?.trim() ?? null;
  if (format === 'starlink' && /\bstarlink\b/i.test(body)) return 'Starlink';
  if (format === 'movistar' && [...normalize(body).matchAll(movistarReceipt)].length) return 'Movistar';
  if (format === 'whoosh' && /\bacabamos de debitar dinero por tu viaje\b/i.test(body)) {
    return body.match(/\bscooter\s+(Whoosh)\b/i)?.[1] ?? null;
  }
  if (format === 'famicredito') return body.match(/\bFamicr[eé]dito Colombia SAS\b/i)?.[0] ?? null;
  if (format === 'payu') return body.match(/\brealizada en ([^\n,]{1,150}?),?[ \t]*fue aprobada\b/i)?.[1]?.trim() ?? null;
  if (format === 'avalpay') return body.match(/\bdel servicio ([^\n,]{1,150}),?[ \t]*por valor de\b/i)?.[1]?.trim() ?? null;
  if (format === 'google_play') return googlePlayProduct(body);
  return null;
}


function extractGmailPayment(subject: string, body: string, format?: GmailFormat, knownNequiPse = false): GmailPayment {
  const text = normalize(subject + '\n' + body);
  if (format === 'google_play' && googlePlayFallbackSubject.test(normalize(subject))) {
    if (!googlePlayFallbackReceipt.test(text)) return { paymentMethod: null, cardType: null, cardLast4: null };
    const reported = [...text.matchAll(/\bse realizo un (?:cargo|cobro) en (?:tu )?(visa|mastercard|amex)[ \t]*[-‐‑–][ \t]*(\d{4})(?!\d)/g)];
    const fields = [...text.matchAll(googlePlayCardField)];
    const card = singleValue([...reported, ...fields].map(([, brand, last4]) => brand + ':' + last4));
    return { paymentMethod: 'Tarjeta',
      cardType: null, cardLast4: card?.split(':')[1] ?? null };
  }
  const methods: NonNullable<GmailPayment['paymentMethod']>[] = [];
  const types: NonNullable<GmailPayment['cardType']>[] = [];
  const suffixes: string[] = [];
  const addMethod = (token: string, tail: string) => {
    if (!cardToken.test(token) && !/^(?:visa|mastercard|amex)$/.test(token)) {
      methods.push(token === 'nequi' ? 'Nequi' : token.endsWith('pse') ? 'PSE' :
        token.endsWith('qr') ? 'QR' : token.startsWith('bre') ? 'Bre-B' :
        token.startsWith('boton') ? 'Botón Bancolombia' : 'Transferencia');
      return 0;
    }
    methods.push('Tarjeta');
    if (/\bdeb/.test(token)) types.push('debit');
    if (/\bcred/.test(token)) types.push('credit');
    const mask = maskedCardSuffix.exec(tail) ??
      (format === 'google_play' && /^(?:visa|mastercard|amex)$/.test(token) ? /^[ \t]*[-‐‑–][ \t]*(\d{4})(?!\d)/.exec(tail) : null);
    if (mask) suffixes.push(mask[1]);
    return mask?.[0].length ?? 0;
  };
  for (const match of text.matchAll(paymentMention)) {
    const tail = text.slice(match.index + match[0].length);
    const following = tail.slice(addMethod(match[1], tail));
    const second = nextPayment.exec(following);
    if (second) addMethod(second[1], following.slice(second[0].length));
  }
  if (knownNequiPse || format === 'pse' && /^pse\s*[-–:]\s*transaccion\b/.test(normalize(subject))) methods.push('PSE');
  if (format === 'avalpay' && /\btransaccion bre[‐‑–-]b\b/.test(normalize(subject))) methods.push('Bre-B');
  if (format === 'github' && /(?:^|\n)[ \t]*charged to[ \t]*:[ \t]*(?:visa|mastercard|amex)\b/.test(text)) methods.push('Tarjeta');
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

const payrollConcept = /\b(?:recibiste un pago de n[oó]mina|abono de n[oó]mina)\b/i;
const loanPaidOut = /\bya recibiste tu dinero\b|\bmonto desembolsado\b/;
const ownAccounts = /\b(?:entre tus (?:propias )?cuentas|entre cuentas propias|a tu (?:otra cuenta|cuenta propia)|a otra cuenta (?:propia|a tu nombre)|traslado entre tus cuentas|between your (?:own )?accounts|to your (?:own|other) account)\b/;
const ownAccountDeposit = /(?:^|\n)[ \t]*descripcion[ \t]*:[ \t]*deposito a tu cuenta nu\b/;
const unsettledPseConcept = /(?:^|\n)[ \t]*descripcion[ \t]*:[ \t]*(?:payin\b|pago a traves de pse\b)/;
const financialAggregator = /\b(?:kushki|mercado\s*pago|coink|nu compania de financiamiento)\b/;
const futureRefund = /\b(?:recibiras (?:el|tu) (?:dinero|reembolso)|(?:reembolso|devolucion) (?:pendiente|en proceso|solicitad[oa])|(?:reembolso|devolucion)[^.\n]{0,90}\bse tramitara|(?:te )?devolveremos|te devolvera (?:el|tu) dinero|refund (?:pending|requested|will be processed))\b/;
const completedRefund = /\b(?:te reembolsaron|reembolso (?:fue )?(?:recibido|acreditado|abonado)|(?:reembolso|devolucion) (?:ya )?(?:acreditad[ao]|abonad[ao]))\b/;
const creditedRefund = /\b(?:refund (?:was |has been )?(?:credited|applied|completed)|(?:refunded|returned) to your (?:account|card))\b/;
const reversedMovement = /\b(?:reverso|(?:pago|cargo|compra|transaccion) (?:fue |ha sido )?reversad[oa]|(?:charge|payment|transaction) (?:was |has been )?reversed|chargeback)\b/;
const transferMovement = /\b(?:enviaste|transferiste|transferencia|consignacion|abono|abonaron|acreditaron|deposito|te (?:enviaron|transfirieron)|(?:transfer|deposit) (?:was )?(?:received|sent)|funds (?:were )?credited)\b/;
const paidPurpose = /\b(?:conceptos?|productos?|servicios?|descripci[oó]n|items?|product|service|description|purchase of|payment for|paid for|compraste|compra de|pagaste|pago de|pago factura)\b/i;
const partyName = /([\p{L}][\p{L}\p{M} .’'-]{1,110}?)/u.source;
const partyEnd = /(?=,?[ \t]+(?:el (?:d[ií]a )?\d|desde\b|en (?:tu |la )?cuenta\b|a las\b|por (?:[$€\d]|COP\b|USD\b|EUR\b|valor))|[;\n]|[!?](?:\s|$)|$)/.source;
const payrollPayer = new RegExp(/\brecibiste un pago de n[oó]mina\s+de\s+/.source + partyName + partyEnd, 'giu');
const transferPayer = new RegExp(
  /\b(?:recibiste(?: una (?:transferencia|consignaci[oó]n)| plata| dinero)?|te (?:enviaron|transfirieron|abonaron))\s+(?:(?:por|de)\s+)?/.source +
  '(?:' + explicitAmount + '|' + numberToken + ')' + /\s+(?:de|enviad[oa] por)\s+/.source + partyName + partyEnd, 'giu');
const keyedPayee = new RegExp(
  /\b(?:enviaste|transferiste|pagaste)\b[^\n;]{0,160}?\ba la (?:llave|cuenta)\s+(?:\[(?:identificador|correo)\]|[\d.*xX-]+)\s+de\s+/.source +
  partyName + partyEnd, 'giu');
const creditMerchant = /\b(?:fami\s*credito|compa(?:n|ñ)ia de creditos rapidos)\b/;
const fragranceStore = /^\S+(?:\s+\S+){0,4}\s+(?:fragancias|perfumeria)(?:\s+s\.?\s*a\.?\s*s\.?)?$/;
const ebanxReceipt = /\bel pago de tu pedido en ([^\n!?]{1,125}?) ha sido confirmado\b/gi;

function receiptDirection(format: GmailFormat | undefined, subject: string, body: string) {
  if (format === 'pse' && /^pse\s*[-–:]\s*transaccion aprobada\b/.test(subject) &&
      /\bvalor[ \t]*:/.test(body) && /\bfecha de la transaccion\b/.test(body)) return 'expense';
  if (format === 'aval' && /\btu transaccion ha sido aprobada\b/.test(body) &&
      /\bvalor de transaccion\b/.test(body) && /\bmedio de pago\b/.test(body)) return 'expense';
  if (format === 'wompi' && /\btransaccion aprobada en\b/.test(subject) &&
      /\bpago exitoso\b/.test(body)) return 'expense';
  if (format === 'ebanx' && /\bpago confirmado del pedido\b/.test(subject) && [...body.matchAll(ebanxReceipt)].length) return 'expense';
  if (format === 'digitalocean' && /\bdigitalocean receipt\b/.test(body) && /\bamount paid\s*:/.test(body)) return 'expense';
  if (format === 'github' && /^\[github\] payment receipt\b/.test(subject) &&
      /\bwe received payment for your github\.com subscription\b/.test(body) && /\bgithub receipt\b/.test(body)) return 'expense';
  if (format === 'google_play') {
    if (googlePlayFallbackSubject.test(subject) && googlePlayFallbackReceipt.test(body) &&
        orderDateField.test(body) && /\btotal\s*:/.test(body)) return 'expense';
    if (/\bel recibo de tu pedido de google play\b/.test(subject) &&
        (/\bse realizaron los cargos\b/.test(body) ||
          (/\b(?:compraste una suscripcion|se renovo tu suscripcion [^\n]{0,100} en google play)\b/.test(body) &&
           orderDateField.test(body) && /\btotal\s*:/.test(body)))) return 'expense';
  }
  if (format === 'claro' && /\bcomprobante de pago\b/.test(subject) &&
      /\bnotificaci(?:o|\?|�)n de pago en linea\b/.test(body) &&
      /\btransacci(?:o|\?|�)n aprobada\b/.test(body) && /\bcorresponden a la transacci(?:o|\?|�)n\b/.test(body)) return 'expense';
  if (format === 'hostinger' && /\bresumen (?:del|de tu) pedido\b/.test(body) && /\btotal pagado\b/.test(body) &&
      /\b(?:hemos recibido tu pago|gracias por tu compra)\b/.test(body)) return 'expense';
  if (format === 'starlink' && (/^se proceso su pago$/.test(subject) &&
      /\bse proceso su pago\b/.test(body) && /\bmonto\b/.test(body) && /\brecibo\b/.test(body) ||
      /^(?:su pago ha sido procesado|hemos procesado su pago)$/.test(subject) &&
      /\bse proceso el siguiente pago\b/.test(body) && /\bmonto del pago\b/.test(body))) return 'expense';
  if (format === 'payu' && /\btransaccion aprobada\b/.test(subject) &&
      /\btu transaccion ha sido aprobada\b/.test(body) && /\bdatos de la transaccion\b/.test(body) &&
      /\ben tu extracto la compra puede aparecer\b/.test(body)) return 'expense';
  if (format === 'avalpay' && /\bcomprobante de pago\b/.test(subject) &&
      /\bfue aprobada en el sistema\b/.test(body) && /\bpor valor de\b/.test(body)) return 'expense';
  if (format === 'famicredito' && subject === 'nuevo pago' &&
      /\bdiscriminacion del pago\b/.test(body) && /\btotal pagado\b/.test(body) && /\bfecha y hora\b/.test(body)) return 'expense';
  if (format === 'agaval_credit' && /\bpago realizado con tu credito agaval\b/.test(subject) && creditPurchase.test(body)) return 'expense';
  if (format === 'mercado_pago' && /\benviamos tu dinero al banco\b/.test(subject) &&
      /\b(?:titular de la cuenta|importe del retiro)\b/.test(body)) return 'expense';
  if (format === 'rapicredit' && /\bha sido desembolsado\b/.test(subject) && /\bya recibiste tu dinero\b/.test(body)) return 'income';
  if (format === 'rapicredit' && /\brecibimos tu pago\b/.test(subject) &&
      /\b(?:te agradecemos por el pago|has completado el pago)\b/.test(body)) return 'expense';
  if (format === 'whoosh' && subject === 'deuda cancelada' &&
      /\bacabamos de debitar dinero por tu viaje\b/.test(body) && /\bsaldamos la deuda\b/.test(body)) return 'expense';
  if (format === 'movistar' && subject === 'hemos recibido tu pago' && [...body.matchAll(movistarReceipt)].length) return 'expense';
  return null;
}

export function openAiNoticeText(notice: Pick<GmailNotice, 'subject' | 'body'>) {
  const minimize = (text: string) => redact(text)
    .replace(/(^|\n)[ \t]*[¡¿]?(?:hola|estimad[oa]|apreciad[oa]|señor(?:a)?|cliente)\b[ \t,:]+[^\n!?]{1,100}?(?:[!?](?=\s|$)|(?=\s*,?\s*¡|\n|$))/giu,
      '$1[titular]')
    .replace(/(\b(?:bancolombia|nequi):)[ \t]+[^:\n]{2,100}?(?=\s+(?:pagaste|compraste|recibiste|enviaste|transferiste|retiraste)\b)/giu, '$1 [titular]')
    .replace(/(\b(?:llave(?: de pago)?|producto|cuenta|id de (?:operador|transacci[oó]n)|n[uú]mero de transacci[oó]n|cus|tu c[oó]digo|c[oó]digo de autorizaci[oó]n))\s*[:#*xX -]*(?:[a-z]*\d)[a-z\d.*xX-]*/gi,
      '$1 [identificador]')
    .replace(/(\b(?:n[uú]mero de pedido|c[oó]digo [uú]nico de seguimiento|id n[uú]mero|referencia transacci(?:[oó]|\?|�)n)[ \t]*[:#]?[ \t]+)[\w.:-]{5,}\b/gi,
      '$1 [identificador]')
    .replace(/(\bfactura[ \t]*[:#]?[ \t]+)[a-z]{1,12}[-_]\d{5,}\b/gi, '$1 [identificador]')
    .replace(/\b[a-z\d-]+\.hstgr\.cloud\b/gi, '[identificador]')
    .replace(/(\b(?:a la llave|a la cuenta)\s+\[identificador\] de)\s+[\p{L}][\p{L} .'-]{2,100}?(?=\s+(?:el \d|a las \d|desde)|[;\n]|$)/giu,
      '$1 [contraparte]')
    .replace(/(\b(?:recibiste(?: una transferencia)?|transferiste|enviaste|pagaste por (?:c[oó]digo )?qr)[^\n]{0,95}?\s+(?:de|a))\s+[\p{L}][\p{L} .'-]{2,100}?(?=\s+(?:en (?:tu |la )?cuenta|el \d|a las \d|desde|por valor)|[.;\n]|$)/giu,
      (part, prefix: string) => /\b(?:bot[oó]n bancolombia|pago de n[oó]mina)\b/i.test(prefix) ? part : prefix + ' [contraparte]')
    .replace(/\b(\d{1,2}[/-](?:\d{1,2}|\p{L}{3,4})[/-]\d{4}|\d{4}(?:-\d{2}-\d{2}|\/\d{2}\/\d{2})|\d{1,2}(?: de \p{L}+ de | \p{L}{3,4}\.? )\d{4})\b|\b(\d{1,2}:\d{2}(?::\d{2})?)\b|(?:COP|USD|EUR|US\$|[$€])\s*\d[\d.,]*|\b\d[\d.,]*\s*(?:COP|USD|EUR)\b|\b\d{4,}\b/giu,
      (value, date: string | undefined, time: string | undefined, offset: number, input: string) =>
        date || time || /[$€]|\b(?:COP|USD|EUR)\b/i.test(value) ||
        new RegExp(amountContext + '$', 'iu').test(input.slice(Math.max(0, offset - 35), offset))
          ? value : '[identificador]')
    .replace(/(^|[;\n])([ \t]*(?:titular|destinatario|beneficiario|ordenante|nombre del (?:cliente|titular))\s*[:=])[^\n;]+/gim,
      '$1$2 [contraparte]');
  // Keep transaction lines and their neighbors so most greetings and signatures can be dropped.
  const lines = minimize(notice.body).split('\n');
  const relevant = lines.map(line => transactionWords.test(normalize(line)) ||
    /[$€]|\b(?:COP|USD|EUR|fecha|date|hora|time|comercio|merchant|concepto|subtotal|total|fee|balance|medio de pago)\b/i.test(line));
  return { subject: minimize(notice.subject).slice(0, 240),
    body: lines.filter((_, index) => relevant[index] || relevant[index - 1] || relevant[index + 1]).join('\n').slice(0, 2200) };
}

export const directions = ['expense', 'income'] as const;
export const movementKinds = [
  'payment', 'transfer', 'payroll', 'loan_disbursement', 'loan_repayment', 'refund', 'cash_withdrawal', 'card_bill', 'internal_transfer',
  'reversal', 'payment_request', 'declined',
] as const;
export const counterpartyRoles = ['merchant', 'payer', 'payee'] as const;
export const unconfirmedFields = ['amount', 'currency', 'date', 'direction', 'payment_method'] as const;
type UnconfirmedField = typeof unconfirmedFields[number];
export const amountPattern = /^[1-9]\d{0,15}$/;
const categoryHints: [Category, RegExp][] = [
  ['alimentacion', /\b(?:restaurantes?|cafeteria|panaderia|supermercado|almuerzo|comida|alimentos|tiendas ara)\b/],
  ['transporte', /\b(?:transporte|gasolina|parqueadero|peaje|viaje (?:en|con) (?:didi|uber)|uber trip|scooter whoosh|estacion de servicio)\b/],
  ['vivienda', /\b(?:arriendo|vivienda|acueducto|energia|servicios publicos|empresas publicas de medellin|epm|internet (?:de hogar|hogar|residencial)|claro hogar|factura (?:de )?hogar)\b/],
  ['ocio', /\b(?:cine|netflix|crunchyroll|youtube premium|teatro|entretenimiento|concierto)\b/],
  ['salud', /\b(?:farmacia|clinica|drogueria|hospital|consulta medica|medicamentos?|optica|optometria)\b/],
  ['educacion', /\b(?:universidad|colegio|matricula|educacion|cursos?)\b/],
  ['compras', /\b(?:ropa|calzado|prendas de vestir|zapatos|vestuario|camisetas|pantalones|auriculares|audifonos|electronica|toallas (?:higienicas|nosotras)|higiene personal)\b/],
];
const digitalServiceProduct = /\b(?:google one|chatgpt pro|alojamiento web|hosting web|web hosting|almacenamiento en la nube|cloud storage|licencia de software|suscripcion de software)\b/;
const hostingerVps = /^[ \t]*(?:(?:producto|servicio)[ \t]*:[ \t]*)?kvm[ \t]+(?:1|2|4|8)\b(?=[ \t]*(?:\(|se ha renovado\b|$))/m;

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
const citationFields = ['classification', 'amountMinor', 'currency', 'date', 'direction', 'description', 'category', 'movementKind'] as const;
const nullableEnum = (values: readonly string[]) => ({ type: ['string', 'null'], enum: [...values, null] });
const nullableText = { type: ['string', 'null'] };
const gmailModelProperties = {
  classification: { type: 'string', enum: classifications },
  amountMinor: nullableText,
  currency: nullableEnum(currencies),
  date: nullableText,
  direction: nullableEnum(directions),
  description: nullableText,
  category: nullableEnum(categories),
  paymentMethod: nullableEnum(paymentMethods),
  movementKind: nullableEnum(movementKinds),
  counterpartyRole: nullableEnum(counterpartyRoles),
  evidence: { type: 'object', additionalProperties: false, required: citationFields,
    properties: Object.fromEntries(citationFields.map(key => [key, nullableText])) },
};
export const gmailModelSchema = {
  type: 'object', additionalProperties: false, required: Object.keys(gmailModelProperties), properties: gmailModelProperties,
};

type GmailCitation = typeof citationFields[number];
type GmailCitations = Record<GmailCitation, string | null>;

function sameKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function nullableShortText(value: unknown): value is string | null {
  return value === null || typeof value === 'string' && value.trim().length > 0 && value.length <= 160;
}

export function readGmailModel(raw: unknown) {
  if (!sameKeys(raw, gmailModelSchema.required)) return null;
  const { classification, amountMinor, currency, date, direction, category, description,
    paymentMethod, movementKind, counterpartyRole, evidence } = raw;
  if (classification === null || !enumOrNull(classifications, classification) ||
      !nullableShortText(description) || !enumOrNull(movementKinds, movementKind) ||
      !enumOrNull(counterpartyRoles, counterpartyRole) || !sameKeys(evidence, citationFields) ||
      !citationFields.every(key => nullableShortText(evidence[key]) && (raw[key] !== null || evidence[key] === null))) return null;
  const model = readModel({ amountMinor, currency, date, direction, category, description, paymentMethod, confidence: 1 });
  return model && { ...model, classification, movementKind, counterpartyRole, evidence: evidence as GmailCitations };
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

export function inspectGmailNotice(notice: Pick<GmailNotice, 'subject' | 'body' | 'payment' | 'format'>) {
  const completionText = gmailPrimaryText(notice.body);
  const text = normalize(notice.subject) + '\n' + completionText;
  const formatDirection = receiptDirection(notice.format, normalize(notice.subject), completionText);
  const expense = gmailHasExpense(completionText) || formatDirection === 'expense';
  const income = gmailHasIncome(completionText) || formatDirection === 'income';
  const direction = movementDirection(expense, income);
  const loan = direction === 'income' && loanPaidOut.test(completionText);
  const needsCreditReview = notice.format === 'agaval_credit' ||
    notice.format === 'famicredito' && /\b(?:cxc alianzas|descuento amnistia)\b/.test(completionText);
  const explicitOperationRequired = notice.format === 'hostinger' || notice.format === 'agaval_credit' || notice.format === 'whoosh' ||
    travelPeriod.test(completionText);
  const dates = findDates(text).filter(({ start, end }) => {
    const preceding = text.slice(Math.max(0, start - 100), start);
    if (loan) return loanDateField.test(preceding);
    if (explicitOperationRequired) return operationDate.test(preceding);
    if (notice.format === 'famicredito') return /\bfecha y hora[ \t]*[:=]?\s*$/.test(preceding);
    if (notice.format === 'payu' && formatDirection) return receiptDateField.test(preceding);
    if (notice.format === 'github') return githubDateField.test(preceding);
    if (notice.format === 'movistar' && formatDirection) return /\bsu pago por[^\n]{1,54}\bdel[ \t]+$/.test(preceding) &&
      /^[ \t]+se aplico correctamente a la cuenta\b/.test(text.slice(end));
    if (notice.format === 'google_play' && formatDirection === 'expense') {
      const title = normalize(notice.subject);
      return start < title.length ? /^el recibo de tu pedido de google play (?:del|de) $/.test(title.slice(0, start)) :
        /\bfecha (?:del|de tu) pedido[ \t]*[:=]?[ \t]*$/.test(preceding);
    }
    return !nonOperationDate.test(preceding);
  });
  const paymentDates = notice.format === 'ebanx' ? dates.filter(({ start, end }) =>
    /(?:^|\n)[ \t]*$/.test(text.slice(Math.max(0, start - 30), start)) && ebanxTimeField.test(text.slice(end))) : [];
  const relevantDates = paymentDates.length ? paymentDates : dates;
  const date = singleValue(relevantDates.map(match => match.date));
  const playDate = notice.format === 'google_play' && formatDirection
    ? googlePlayOperationDate(text, relevantDates, normalize(notice.subject).length) : null;
  const reportedInstitution = extractReportedInstitution(text);
  const details = notice.payment ?? extractGmailPayment(notice.subject, notice.body, notice.format);
  const counterparty = direction === 'expense' ? extractPurchaseMerchant(notice.body, notice.format) : null;
  return {
    text, money: extractGmailMoney(text, notice.format), date: playDate ? playDate.date : date, direction,
    ...details,
    transactionTime: playDate ? playDate.transactionTime : notice.format === 'github' || notice.format === 'whoosh' && !date ? null :
      extractGmailTime(text, relevantDates.filter(match => match.date === date), date, notice.format),
    reportedInstitution,
    ownTransfer: ownAccounts.test(completionText) || notice.format === 'pse' && ownAccountDeposit.test(completionText),
    walletPayout: notice.format === 'mercado_pago' && Boolean(formatDirection),
    needsPurposeReview: direction === 'expense' && Boolean(counterparty && financialAggregator.test(normalize(counterparty))) &&
      (notice.format === 'pse' && unsettledPseConcept.test(completionText) ||
        /^¡?pago exitoso!?$/.test(normalize(notice.subject.trim())) && /\bhiciste un pago en\b/.test(completionText)),
    needsCreditReview,
    refundPending: futureRefund.test(completionText) && !completedRefund.test(completionText),
    refundOrReversal: completedRefund.test(completionText) || creditedRefund.test(completionText) || reversedMovement.test(completionText),
    cashFlowWithoutPurpose: (transferMovement.test(completionText) || details.paymentMethod === 'Bre-B') &&
      !payrollConcept.test(completionText) && !counterparty && !/\b(?:compraste|pago factura|pagaste|paid for|purchase of)\b/.test(completionText) &&
      !purchaseConcepts(completionText).some(concept => matchingCategories(concept).length === 1),
    contradictoryStatus: (blocksGmailCompletion(text) || excludedSubject.test(normalize(notice.subject))) && (expense || income),
    hasCompletion: expense || income,
    knownReceipt: Boolean(formatDirection),
  };
}

export function gmailModelInput(notice: GmailNotice, checked = inspectGmailNotice(notice)) {
  const { kind, counterparty } = inspectGmailMovementContext(notice, checked);
  // The role is sufficient for the model. Keep named senders and recipients in local processing.
  const name = counterparty?.role !== 'merchant' ? counterparty?.name : undefined;
  const fragment = name ? new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu') : null;
  const modelNotice = fragment ? {
    subject: notice.subject.replace(fragment, '[contraparte]'), body: notice.body.replace(fragment, '[contraparte]'),
  } : notice;
  const safe = openAiNoticeText(modelNotice);
  const excerpt = gmailRuleExcerpt(safe);
  const evidenceHints = gmailEvidenceHints(safe, checked);
  return {
    provider: notice.provider,
    ...(notice.format === 'digitalocean' ? { currencyHint: 'USD' } : {}),
    verified: {
      amountMinor: checked.money?.amountMinor ?? null, currency: checked.money?.currency ?? null,
      date: checked.date, direction: checked.direction, paymentMethod: checked.paymentMethod,
      movementKind: kind, counterpartyRole: counterparty?.role ?? null,
    },
    ...safe,
    ...(Object.keys(evidenceHints).length ? { evidenceHints } : {}),
    ...(excerpt === null ? {} : { ruleCheck: excerpt ? checkGmailExcerpt(notice.provider, excerpt) : null }),
  };
}

function gmailEvidenceHints(safe: Pick<GmailNotice, 'subject' | 'body'>, checked: ReturnType<typeof inspectGmailNotice>) {
  const body = safe.body;
  const evidence: Partial<GmailCitations> = {};
  const clauses = body.split(/\n|(?<=[.!?])\s+(?=\p{Lu})/u).map(line => line.trim());
  const directionPattern = checked.direction === 'expense' ? [expenseEvidence, englishExpense] :
    checked.direction === 'income' ? [incomeEvidence, englishIncome] : [];
  for (const clause of clauses) {
    const primary = gmailPrimaryText(clause);
    if (primary !== normalize(clause) || blocksGmailCompletion(primary)) continue;
    const proof = directionPattern.map(pattern => pattern.exec(primary)).find(match => match !== null);
    if (proof) {
      evidence.classification = evidence.direction = clause.slice(proof.index, proof.index + proof[0].length);
      break;
    }
  }
  if (checked.money) {
    const { amountMinor, currency } = checked.money;
    const amounts = [...body.matchAll(gmailExplicitMoney)].map(match => match[0]);
    for (const match of body.matchAll(gmailAnchoredMoney)) amounts.push(match[1]);
    evidence.amountMinor = amounts.find(value => {
      const amount = parseMoney(value, currency);
      return amount?.amountMinor === amountMinor && amount.currency === currency && gmailEvidenceRole(safe, value, balanceLabel);
    }) ?? null;
    evidence.currency = evidence.amountMinor?.match(monetaryCurrency)?.[0] ??
      clauses.find(line => /^(?:moneda|currency)\s*[:=]/i.test(line) && line.match(monetaryCurrency)?.[0].toUpperCase() === currency) ??
      (evidence.amountMinor?.includes('$') ? evidence.amountMinor : null);
  }
  if (checked.date) {
    for (const part of [safe.body, safe.subject]) {
      const candidate = findDates(normalize(part)).find(item => item.date === checked.date &&
        !nonOperationDate.test(normalize(part.slice(Math.max(0, item.start - 72), item.start))));
      if (candidate) {
        evidence.date = part.slice(candidate.start, candidate.end);
        break;
      }
    }
  }
  const concept = singleValue(purchaseConcepts(body).map(text => text.trim()).filter(text => text && text.length <= 100));
  if (concept) evidence.description = evidence.category = concept;
  return Object.fromEntries(Object.entries(evidence).filter(([, quote]) => quote));
}

export const gmailRuleExcerptLimit = 320;

function gmailRuleExcerpt({ subject, body }: Pick<GmailNotice, 'subject' | 'body'>) {
  const text = subject + '\n' + body;
  const hits = [...text.matchAll(gmailExplicitMoney)].map(match => ({ value: match[0], start: match.index }));
  for (const match of text.matchAll(gmailAnchoredMoney)) {
    hits.push({ value: match[1], start: match.index + match[0].length - match[1].length });
  }
  hits.sort((a, b) => a.start - b.start);
  const amounts = new Map<string, { start: number; end: number }>();
  for (const hit of hits) {
    const money = parseMoney(hit.value);
    if (!money) continue;
    const key = money.currency + ':' + money.amountMinor;
    if (!amounts.has(key)) amounts.set(key, { start: hit.start, end: hit.start + hit.value.length });
  }
  const dates = new Map<string, { start: number; end: number }>();
  for (const date of findDates(normalize(text))) {
    if (!dates.has(date.date)) dates.set(date.date, date);
  }
  const conflicting = [...(amounts.size > 1 ? amounts.values() : []), ...(dates.size > 1 ? dates.values() : [])];
  if (!conflicting.length) return null;
  const first = Math.min(...conflicting.map(hit => hit.start));
  const last = Math.max(...conflicting.map(hit => hit.end));
  if (last - first > gmailRuleExcerptLimit) return '';
  const start = Math.max(0, first - 60, last - gmailRuleExcerptLimit);
  return text.slice(start, start + gmailRuleExcerptLimit);
}

export function checkGmailExcerpt(provider: unknown, excerpt: unknown) {
  if (!providers.some(value => value === provider) || typeof excerpt !== 'string' ||
      !excerpt.trim() || excerpt.length > gmailRuleExcerptLimit) return { error: 'invalid_excerpt' } as const;
  const body = redact(excerpt);
  const format = provider === 'other' && /\bdigitalocean receipt\b/i.test(body) && /\bamount paid\s*:/i.test(body)
    ? 'digitalocean' : undefined;
  const { money, date, direction, paymentMethod } = inspectGmailNotice({ subject: '', body, format });
  const hints = matchingCategories(body);
  return {
    amountMinor: money?.amountMinor ?? null, currency: money?.currency ?? null, date, direction, paymentMethod,
    categoryHint: direction === 'income' ? 'ingresos' as const : hints.length === 1 ? hints[0] : null,
  };
}

export function inspectGmailMovementContext(notice: GmailNotice, checked = inspectGmailNotice(notice)) {
  const body = notice.body;
  const text = normalize(body);
  const merchant = extractPurchaseMerchant(body, notice.format);
  let kind: typeof movementKinds[number] | null = null;
  if (checked.ownTransfer) kind = 'internal_transfer';
  else if (checked.direction === 'income' && payrollConcept.test(body)) kind = 'payroll';
  else if (checked.direction === 'income' && loanPaidOut.test(text)) kind = 'loan_disbursement';
  else if (checked.direction === 'expense' && (
    notice.format === 'rapicredit' || notice.format === 'famicredito' ||
    notice.format === 'avalpay' && /\b(?:libre destino|acuerdos? de pago)\b/.test(text) ||
    (notice.format === 'wompi' || notice.format === 'pse') && Boolean(merchant && creditMerchant.test(normalize(merchant)) &&
      /\b(?:pago a famicredito|pago de (?:tu |la )?(?:cuota|obligacion)|compa(?:n|ñ)ia de creditos rapidos)\b/.test(text))
  )) kind = 'loan_repayment';
  else if (checked.direction === 'income' && completedRefund.test(text)) kind = 'refund';
  else if (checked.direction === 'expense' && /\b(?:retiraste|realizaste un retiro|hiciste un retiro)\b/.test(text)) kind = 'cash_withdrawal';
  else if (checked.direction === 'expense' && /\b(?:pago de (?:tu |la )?tarjeta de credito|pagaste (?:tu |la )?tarjeta de credito)\b/.test(text)) kind = 'card_bill';
  else if (checked.walletPayout) kind = 'transfer';
  else if (merchant && (checked.direction === 'expense' || checked.knownReceipt)) kind = 'payment';
  else if (/\b(?:enviaste|transferiste|transferencia|consignacion)\b/.test(text) || checked.paymentMethod === 'Bre-B') kind = 'transfer';
  else if (checked.direction === 'expense' && (checked.knownReceipt || /\b(?:compraste|compra (?:confirmada|aprobada|realizada|exitosa|procesada|completada))\b/.test(text))) kind = 'payment';

  const people = checked.direction === 'income'
    ? [...body.matchAll(payrollPayer), ...body.matchAll(transferPayer)]
    : checked.direction === 'expense' ? [...body.matchAll(keyedPayee)] : [];
  const parties = people.map(match => match[1].trim()).filter(name =>
    !/^(?:n[oó]mina|tu cuenta|ahorros|transferencia|pago)\b/i.test(name));
  const name = singleValue(parties) ?? (!people.length && !merchant && checked.direction === 'expense'
    ? singleValue([...body.matchAll(transferRecipient)].map(([, name]) => name.trim())
      .filter(name => /^[\p{L}][\p{L}\p{M} .’'-]{1,110}$/u.test(name) && !/^(?:[mt]u|la|el|otra)\s+cuenta\b/i.test(name))) : null);
  const role = checked.direction === 'income' ? 'payer' as const : 'payee' as const;
  const counterparty = name ? { role, name } : merchant ? { role: 'merchant' as const, name: merchant } : null;
  return { kind, counterparty };
}

function asEvidence(value: string) {
  return normalize(value).replace(/\s+/g, ' ').trim();
}

function purchaseConcepts(body: string) {
  return [...body.matchAll(/(?:^|[.;\n])[ \t]*(?:conceptos?|productos?|servicios?|descripci[oó]n|items?|products?|services?|description)(?:[ \t]*[:=][ \t]*|\t+|[ \t]{2,}|\n[ \t]*)([^\n;]+)/gi)]
    .map(match => match[1]);
}

function chooseGmailCategory(notice: GmailNotice, model: ReturnType<typeof readGmailModel>, merchant: string | null,
  safe: Pick<GmailNotice, 'subject' | 'body'>): Category {
  const concepts = purchaseConcepts(notice.body);
  const product = notice.format === 'google_play' ? googlePlayProduct(notice.body) : null;
  if (product && !concepts.includes(product)) concepts.push(product);
  const purposeLines = notice.body.split(/\n|[;!?]|\.(?!\d)/).filter(line => paidPurpose.test(line));
  const bodyCategories = matchingCategories((concepts.length ? concepts : purposeLines).join('\n'));
  const isDigitalProduct = concepts.some(concept => digitalServiceProduct.test(normalize(concept))) ||
    (notice.format === 'hostinger' && hostingerVps.test(normalize(notice.body)));
  if (isDigitalProduct && !bodyCategories.includes('compras')) bodyCategories.push('compras');
  if (bodyCategories.length === 1) return bodyCategories[0];
  if (bodyCategories.length > 1) return 'otros';
  const subjectCategories = matchingCategories(notice.subject);
  const isDigitalReceipt = notice.format === 'digitalocean' && merchant === 'DigitalOcean' ||
    notice.format === 'github' && normalize(merchant ?? '') === 'github';
  const merchantCategories = isDigitalReceipt || fragranceStore.test(normalize(merchant ?? ''))
    ? ['compras' as const] : matchingCategories(merchant ?? '');
  const citation = model?.evidence.category;
  if (model?.category && model.category !== 'ingresos' && model.category !== 'otros' && citation && gmailLiteral(safe, citation)) {
    const evidence = asEvidence(citation);
    const hints = matchingCategories(evidence);
    const purpose = [...(concepts.length ? concepts : purposeLines), ...(paidPurpose.test(notice.subject) ? [notice.subject] : [])];
    if (purpose.some(concept => asEvidence(concept).includes(evidence)) &&
        (hints.length === 1 && hints[0] === model.category ||
          !hints.length && evidence.includes(' ') && !asEvidence(merchant ?? '').includes(evidence))) {
      return model.category;
    }
  }
  return subjectCategories.length === 1 ? subjectCategories[0] :
    merchantCategories.length === 1 ? merchantCategories[0] : 'otros';
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

function gmailLiteral(safe: Pick<GmailNotice, 'subject' | 'body'>, phrase: string | null) {
  return !!phrase && (safe.subject.includes(phrase) || safe.body.includes(phrase));
}

function gmailEvidenceRole(safe: Pick<GmailNotice, 'subject' | 'body'>, phrase: string, otherRole: RegExp,
  tokenIndex = 0) {
  for (const part of [safe.subject, safe.body]) {
    for (let start = part.indexOf(phrase); start !== -1; start = part.indexOf(phrase, start + phrase.length)) {
      const index = start + tokenIndex;
      const prefix = normalize(part.slice(Math.max(0, index - 72), index));
      if (!otherRole.test(prefix)) return true;
    }
  }
  return false;
}

function gmailModelProof(safe: Pick<GmailNotice, 'subject' | 'body'>, model: NonNullable<ReturnType<typeof readGmailModel>>,
  checked: ReturnType<typeof inspectGmailNotice>) {
  const e = model.evidence;
  const amountToken = e.amountMinor?.match(gmailExplicitMoney)?.[0] ?? e.amountMinor?.match(new RegExp(numberToken))?.[0];
  const dateToken = e.date && findDates(normalize(e.date)).find(item => item.date === model.date);
  const currencyToken = e.currency?.match(monetaryCurrency)?.[0];
  const classification = e.classification && gmailLiteral(safe, e.classification) ? normalize(e.classification) : '';
  const direction = e.direction && gmailLiteral(safe, e.direction) ? normalize(e.direction) : '';
  return {
    completed: Boolean(classification && !blocksGmailCompletion(classification) &&
      (gmailHasExpense(classification) || gmailHasIncome(classification) || receiptEvidence.test(classification) ||
        checked.knownReceipt && /\b(?:aprobada|pagado|confirmad[oa]|recibido|exitoso)\b/.test(classification))),
    negative: Boolean(classification && (blocksGmailCompletion(classification) || futurePayment.test(classification) ||
      futureRefund.test(classification) || informationalOnly.test(classification) || englishRequest.test(classification))),
    amount: Boolean(e.amountMinor && amountToken && model.amountMinor && model.amountMinor === checked.money?.amountMinor &&
      parseMoney(amountToken, checked.money.currency)?.amountMinor === model.amountMinor &&
      gmailEvidenceRole(safe, e.amountMinor, balanceLabel, e.amountMinor.indexOf(amountToken))),
    currency: Boolean(e.currency && model.currency && checked.money?.currency === model.currency && gmailLiteral(safe, e.currency) &&
      (currencyToken ? parseMoney(currencyToken + ' 1')?.currency === model.currency :
        /\$/.test(e.currency) && (model.currency === 'COP' || model.currency === 'USD' && checked.knownReceipt))),
    date: Boolean(e.date && dateToken && checked.date === model.date &&
      gmailEvidenceRole(safe, e.date, nonOperationDate, dateToken.start)),
    direction: Boolean(direction && model.direction === checked.direction && (model.direction === 'expense' ?
      gmailHasExpense(direction) || checked.knownReceipt && receiptEvidence.test(direction) : gmailHasIncome(direction))),
  };
}

const nonEconomicModelKinds = new Set(['internal_transfer', 'reversal', 'refund', 'loan_disbursement', 'cash_withdrawal', 'card_bill']);

export function resolveGmailExtraction(notice: GmailNotice, model: ReturnType<typeof readGmailModel>,
  allowLocalReview = false, checked = inspectGmailNotice(notice)) {
  const safe = gmailModelInput(notice, checked);
  const proof = model && gmailModelProof(safe, model, checked);
  if (!checked.hasCompletion && (isGmailExplicitNonMovement(notice.subject, notice.body) || checked.refundPending)) {
    return { status: 'ignored' as const };
  }
  const avalCopy = !notice.unauthenticated && !notice.forwarded && notice.format === 'avalpay' &&
    checked.direction !== 'income' && checked.money && notice.references?.some(key => key.startsWith('aval-bre-b:')) && !checked.hasCompletion;
  if (model?.classification === 'not_transaction' && proof?.negative && !checked.hasCompletion && !avalCopy) {
    return { status: 'ignored' as const };
  }
  const payee = checked.direction === 'expense' && checked.paymentMethod === 'Bre-B' && notice.provider === 'nequi' &&
    !notice.unauthenticated && !notice.forwarded ? inspectGmailMovementContext(notice, checked).counterparty : null;
  const merchant = extractPurchaseMerchant(notice.body, notice.format) ?? (payrollConcept.test(notice.body) ? 'Pago de nómina' : null) ??
    (payee?.role === 'payee' && fragranceStore.test(normalize(payee.name)) ? payee.name : null);
  const operatedAmount = checked.hasCompletion ? extractGmailMoney(gmailPrimaryText(notice.body), notice.format) : null;
  const playDateVerified = notice.format === 'google_play' && checked.knownReceipt;
  const verifiedReceipt = Boolean(notice.format && checked.knownReceipt || notice.provider !== 'other' && checked.hasCompletion);
  const literal = Boolean((allowLocalReview || verifiedReceipt) && checked.date && checked.direction && checked.money &&
    (notice.provider !== 'other' || checked.knownReceipt) && !notice.unauthenticated && !notice.forwarded &&
    (playDateVerified || findDates(normalize(notice.body)).some(item => item.date === checked.date)) &&
    operatedAmount?.currency === checked.money.currency &&
    operatedAmount.amountMinor === checked.money.amountMinor);
  const { date, paymentMethod, cardType, cardLast4, transactionTime, reportedInstitution } = checked;
  const details = { cardType, cardLast4, transactionTime, reportedInstitution };
  const evidence = {
    date, paymentMethod, ...details,
    amountMinor: checked.money?.amountMinor, currency: checked.money?.currency, direction: checked.direction ?? undefined,
  };
  const references = (checked.date && checked.direction === 'expense' && checked.money || avalCopy) && notice.references?.length
    ? { references: notice.references } : {};
  if (avalCopy) return {
    status: 'pending' as const, reason: 'missing_or_ambiguous_fields' as const, confidence: 0, evidence, ...references,
    avalCopy: true as const, unconfirmedFields: [...(!checked.date ? ['date' as const] : []),
      ...(!checked.direction ? ['direction' as const] : [])],
  };
  const kind = inspectGmailMovementContext(notice, checked).kind;
  const modelKind = model?.movementKind && gmailLiteral(safe, model.evidence.movementKind) ? model.movementKind : null;
  if (notice.unauthenticated || notice.forwarded || checked.ownTransfer || checked.walletPayout || checked.needsCreditReview ||
      checked.needsPurposeReview || checked.refundOrReversal || checked.contradictoryStatus ||
      checked.cashFlowWithoutPurpose && !merchant ||
      kind && nonEconomicModelKinds.has(kind) || modelKind && nonEconomicModelKinds.has(modelKind)) return {
    status: 'pending' as const, reason: 'unconfirmed_extraction' as const, confidence: 0, unconfirmedFields: [], evidence, ...references,
  };
  const independentlyVerified = literal && (verifiedReceipt || !model && allowLocalReview);
  const modelVerified = model?.classification === 'completed' && proof?.completed && proof.amount && proof.currency && proof.date && proof.direction;
  if ((independentlyVerified || modelVerified) && checked.money && date && checked.direction) {
    const citedDescription = model?.description && gmailLiteral(safe, model.evidence.description) &&
      model.evidence.description?.includes(model.description) && (merchant || paidPurpose.test(model.evidence.description))
      ? redact(model.description) : null;
    const category = checked.direction === 'income' ? 'ingresos' : chooseGmailCategory(notice, model, merchant, safe);
    const description = merchant ?? citedDescription ??
      (checked.direction === 'expense' ? 'Salida de dinero' : 'Ingreso') + (paymentMethod ? ' · ' + paymentMethod : '');
    const provenCategory = notice.format === 'pse' && checked.knownReceipt && references.references?.some(key => key.startsWith('pse:'))
      ? singleValue(matchingCategories(purchaseConcepts(notice.body).join('\n'))) : null;
    return { status: 'registered' as const, confidence: 1, movement: {
      ...checked.money, date, direction: checked.direction, paymentMethod, description, category, ...details,
    }, ...references, ...(provenCategory === category ? { categoryFromPseConcept: true as const } : {}) };
  }
  const unconfirmedFields: UnconfirmedField[] = [];
  if (!checked.money) unconfirmedFields.push('amount');
  if (!date) unconfirmedFields.push('date');
  if (!checked.direction) unconfirmedFields.push('direction');
  return { status: 'pending' as const, reason: 'missing_or_ambiguous_fields' as const, confidence: 0,
    unconfirmedFields, evidence, ...references };
}
