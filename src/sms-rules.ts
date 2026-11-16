import {
  gmailReferencePattern, gmailReceivedDateTime, inspectGmailNotice, isGmailExplicitNonMovement,
  normalize, redact, resolveGmailExtraction, validDay, type GmailNotice,
} from './mail-rules.js';

export type NequiSmsInput = { sender: string; body: string; receivedAt: string };
export type SmsMovement = Extract<ReturnType<typeof resolveGmailExtraction>, { status: 'registered' }>['movement'];
export type SmsParseResult =
  | { status: 'ignored'; reason: 'sender_not_allowed' | 'security_message' | 'non_movement' | 'empty_message' }
  | { status: 'unconfirmed'; reason: 'invalid_received_at' | 'message_too_long' | 'missing_or_ambiguous_fields';
    insufficientFields?: string[] }
  | { status: 'registered'; movement: SmsMovement; references?: string[] };

const securityMessage = /\b(?:otp|pin|nip|clave(?: dinamica| temporal| de seguridad| de acceso)?|codigo (?:de (?:seguridad|verificacion|acceso|ingreso|autenticacion|confirmacion|retiro)|para (?:ingresar|entrar|retirar|verificar|confirmar)|dinamico|temporal|otp)|tu codigo(?! (?:unico de seguimiento|(?:de )?(?:transaccion|operacion|referencia))\b)|no compartas (?:este|tu|el) codigo)\b/;
const possibleMovement = /\b(?:pagaste|compraste|enviaste|transferiste|retiraste|recibiste|te (?:enviaron|transfirieron|abonaron|acreditaron)|transferencia|transaccion|pago|compra|retiro|abono|abonaron|acreditaron|reembolso|reembolsaron|desembolso|payment|paid|transfer|credited|charged|refund)\b/;
const receiptTimestamp = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const otherFinancialIssuer = /^(?:bancolombia|davivienda|daviplata|bbva|(?:banco (?:de |del )?)?bogota|banco ?popular|banco (?:de )?occidente|banco caja social|av ?villas|scotiabank|colpatria|itau|lulo(?: bank)?|nu(?:bank)?|movii|rappipay|dale)(?=[\s:：-]|$)/;
const nequiHeading = /^\s*nequi(?:\s*[:：-]|\s+te\s+(?:informa|cuenta)\b)/;
const nequiIncomingAccount = /\b(?:recibiste|te (?:enviaron|transfirieron|abonaron|acreditaron))\b(?:[^.!?\n;]|\.(?=\d)){0,220}\ben tu nequi\b/;
const nequiOutgoingAccount = /\b(?:enviaste|transferiste|pagaste|compraste|retiraste)\b(?:[^.!?\n;]|\.(?=\d)){0,220}\bdesde tu nequi\b/;
const equivalentIncomingVerb = /\b(?:te envi[oó]|te lleg[oó](?: (?:plata|dinero))?(?: por)?|has recibido)[ \t]+(?=(?:COP[ \t]*|USD[ \t]*|EUR[ \t]*|US\$[ \t]*|[$€][ \t]*)?\d)/giu;
const futureOrNegatedIncome = /\b(?:te (?:enviara|enviaran|va a enviar|van a enviar|llegara|llegaran)|recibiras|no (?:has recibido|te (?:llego|envio)))\b/;
const negatedMoneyFlow = /\bno (?:se )?te (?:enviaron|transfirieron|abonaron|acreditaron|consignaron|reembolsaron|devolvieron|debitaron|cobraron|descontaron)\b/;

function smsOperationText(body: string) {
  const principal = body.split(/(?:[.!?]\s+|\n)(?:si|en caso de que)\s+/i, 1)[0];
  if (/^(?:\s*nequi\s*[:：-])?\s*(?:si|cuando|en caso|quizas?|tal vez|podria|habria)\b/.test(normalize(principal))) return '';
  // Equivalent completed-money verbs only. Amounts, dates and source labels are unchanged.
  return principal.replace(equivalentIncomingVerb, (verb: string, offset: number) => {
    const prefix = normalize(principal.slice(Math.max(0, offset - 220), offset)).split(/[!?;\n]|\.(?!\d)/).at(-1) ?? '';
    return /\b(?:no|nunca)[ \t]+$|\b(?:si|cuando|en caso|quizas?|tal vez|podria|habria)\b/.test(prefix) ? verb : 'Te abonaron ';
  });
}

function smsNonMovement(body: string, operation: string) {
  return negatedMoneyFlow.test(normalize(operation)) || isGmailExplicitNonMovement('', operation) || futureOrNegatedIncome.test(normalize(body)) &&
    !inspectGmailNotice({ subject: '', body: operation }).hasCompletion;
}

function isNequiSource(input: Pick<NequiSmsInput, 'sender' | 'body'>, allowedSenders: readonly string[], autoDetect: boolean) {
  if (typeof input.sender !== 'string' || typeof input.body !== 'string') return false;
  const sender = normalize(input.sender.trim());
  const body = normalize(input.body.trim());
  // Nequi as the destination of a payment from another issuer is not a Nequi source.
  if (otherFinancialIssuer.test(sender) || otherFinancialIssuer.test(body)) return false;
  if (allowedSenders.includes(input.sender)) return true;
  const operation = normalize(smsOperationText(input.body));
  return autoDetect && (sender === 'nequi' || nequiHeading.test(body) ||
    nequiIncomingAccount.test(operation) || nequiOutgoingAccount.test(operation));
}

/** Cheap local-candidate policy mirrored by the Android SMS filter; not bank authentication. */
export function isNequiSmsCandidate(input: Pick<NequiSmsInput, 'sender' | 'body'>,
  allowedSenders: readonly string[] = [], autoDetect = true) {
  if (!isNequiSource(input, allowedSenders, autoDetect) || !input.body.trim() || input.body.length > 5000) return false;
  const text = normalize(input.body);
  const operation = smsOperationText(input.body);
  return possibleMovement.test(normalize(operation)) && !securityMessage.test(text) && !smsNonMovement(input.body, operation);
}

function redactSmsIdentifiers(body: string) {
  const withoutBareIdentifiers = body.replace(/(?<![\d.,])(?:\d[ \t-]?){8,18}\d(?=[^\d.,]|[.,](?!\d)|$)/g,
    (value: string, offset: number) => {
      const prefix = body.slice(Math.max(0, offset - 8), offset);
      const suffix = body.slice(offset + value.length);
      return /(?:COP|USD|EUR|US\$|[$€])[ \t]*$/i.test(prefix) || /^[ \t]*(?:COP|USD|EUR|pesos)\b/i.test(suffix)
        ? value : '[identificador]';
    });
  return redact(withoutBareIdentifiers);
}

function smsReferences(body: string, movement: SmsMovement) {
  // Only this explicit cross-channel identifier is currently shared by Gmail.
  // A sender label, amount, phone number or date is never an operation reference.
  if (movement.paymentMethod !== 'PSE') return [];
  const values = new Set([...normalize(body).matchAll(/\b(?:cus|codigo unico de seguimiento)\s*[:#=]?\s*(\d{6,20})\b/g)]
    .map(match => 'pse:' + match[1]).filter(value => gmailReferencePattern.test(value)));
  return values.size === 1 ? [...values] : [];
}

/**
 * Parses an SMS supplied by the opted-in device. Brand/own-account text identifies
 * the declared source; it does not prove bank authenticity. Exact allowed senders
 * remain available for older explicitly configured devices. The caller stores
 * source=sms and does not persist or log the body.
 */
export function parseNequiSms(input: NequiSmsInput, allowedSenders: readonly string[] = [], autoDetect = true): SmsParseResult {
  if (typeof input.body !== 'string' || !input.body.trim()) return { status: 'ignored', reason: 'empty_message' };
  if (!isNequiSource(input, allowedSenders, autoDetect)) {
    return { status: 'ignored', reason: 'sender_not_allowed' };
  }
  // Never truncate: a rejected state or a second conflicting operation can appear at the end.
  if (input.body.length > 5000) return { status: 'unconfirmed', reason: 'message_too_long' };
  const original = normalize(input.body);
  const operation = smsOperationText(input.body);
  if (securityMessage.test(original)) return { status: 'ignored', reason: 'security_message' };
  if (smsNonMovement(input.body, operation)) {
    return { status: 'ignored', reason: 'non_movement' };
  }
  if (!possibleMovement.test(normalize(operation))) return { status: 'ignored', reason: 'non_movement' };
  if (typeof input.receivedAt !== 'string' || !receiptTimestamp.test(input.receivedAt) ||
      !validDay(input.receivedAt.slice(0, 10)) || !gmailReceivedDateTime(input.receivedAt)) {
    return { status: 'unconfirmed', reason: 'invalid_received_at' };
  }
  // Phone, account and reference digits must not become bare monetary values.
  const notice: GmailNotice = { provider: 'nequi', forwarded: false, subject: '', body: redactSmsIdentifiers(operation) };
  const checked = inspectGmailNotice(notice);
  const result = resolveGmailExtraction(notice, null, true, checked, input.receivedAt);
  if (result.status === 'ignored') return { status: 'ignored', reason: 'non_movement' };
  if (result.status !== 'registered') return {
    status: 'unconfirmed', reason: 'missing_or_ambiguous_fields', insufficientFields: result.unconfirmedFields,
  };
  const references = smsReferences(operation, result.movement);
  return { status: 'registered', movement: result.movement, ...(references.length ? { references } : {}) };
}
