import { buildGmailWorkflow } from '../n8n/gmail-workflow.mjs';

export const bank = 'Pagaste COP 25.000 en Restaurante Demo el 10/11/2026. Cuenta 12345678901.';
export const bankSender = 'alertas@nequi.example';
export const shopSender = 'avisos@comercio.example';
export const agavalSubject = 'Pago de ropa';
export const agaval = 'Tu pago fue procesado, pagaste COP 50.000 en almacenes Agaval, el 10/11/2026 a las 12:00pm, gracias por tu compra.';
export const bankPurchaseSubject = 'Alertas y Notificaciones – Compra';
export const bankPurchase = 'Bancolombia: Compraste $30.750,00 en MERCADO DEL BUENO con tu T.Deb *1234, el 10/11/2026 a las 14:42.';
export const flow = buildGmailWorkflow({ classifier: 'agent',
  senderJson: JSON.stringify({ [bankSender]: 'nequi', 'tarjeta@bancolombia.example': 'bancolombia' }) });
export const blankEvidence = {
  classification: null, amountMinor: null, currency: null, date: null, direction: null,
  description: null, category: null, movementKind: null,
};
export const uncertainModel = {
  classification: 'uncertain', amountMinor: null, currency: null, date: null, direction: null,
  description: null, category: null, paymentMethod: null, movementKind: null, counterpartyRole: null, evidence: blankEvidence,
};
export const goodModel = {
  ...uncertainModel, amountMinor: '2500000', currency: 'COP', date: '2026-11-10', paymentMethod: 'Nequi',
  description: 'Restaurante Demo', category: 'alimentacion', direction: 'expense', classification: 'completed',
  movementKind: 'payment', counterpartyRole: 'merchant', evidence: {
    classification: 'Pagaste', amountMinor: 'COP 25.000', currency: 'COP', date: 'el 10/11/2026',
    direction: 'Pagaste', description: 'Restaurante Demo', category: 'Restaurante Demo', movementKind: 'Pagaste',
  },
};
export const agavalMovement = {
  amountMinor: '5000000', currency: 'COP', date: '2026-11-10', paymentMethod: null,
  description: 'almacenes Agaval', category: 'compras', direction: 'expense',
  transactionTime: '12:00', cardType: null, cardLast4: null, reportedInstitution: null,
};
export const agavalModel = {
  ...goodModel, amountMinor: agavalMovement.amountMinor, paymentMethod: null, description: 'almacenes Agaval', category: 'compras',
  evidence: { ...goodModel.evidence, classification: 'Tu pago fue procesado', amountMinor: 'COP 50.000',
    direction: 'pagaste', description: 'almacenes Agaval', category: agavalSubject, movementKind: 'pagaste' },
};
export const wrap = json => ({ json });

export function runCode(name, items, references = {}) {
  const node = flow.nodes.find(node => node.name === name);
  const code = new Function('$input', '$', node.parameters.jsCode);
  return code({ all: () => items }, key => ({ itemMatching: index => references[key][index] }));
}

export function legacyInput(messageId, receivedAt, text = bank, from = bankSender, subject = 'Aviso de pago', labels = ['INBOX'], authenticated = true, attempts = 1) {
  const staging = runCode('Preparar IDs de Gmail', [wrap({ id: messageId, internalDate: String(Date.parse(receivedAt)) })]);
  const read = runCode('Preparar lectura de Gmail', [wrap({ ...staging[0].json, id: 1, attempts })]);
  const domain = from.split('@')[1];
  const headers = typeof authenticated === 'string' ? [
    { name: 'Authentication-Results', value: 'mx.google.com; dmarc=fail header.from=' + domain },
    { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=' + domain },
  ] : authenticated ? [{ name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=' + domain }] : [];
  const mail = wrap({ id: messageId, from: { value: [{ address: from }] }, subject, text, labelIds: labels });
  return runCode('Normalizar Gmail directo', [wrap({ id: messageId, payload: { headers } })],
    { 'Preparar lectura de Gmail': read, 'Leer cuerpo de Gmail': [mail] });
}

export function filterAndResolve(input, model = goodModel) {
  const filtered = runCode('Filtrar y proteger aviso', input);
  if (!filtered.length || !filtered[0].json.notice && filtered[0].json.identity.source === 'legacy') return undefined;
  const output = model ? { output: JSON.stringify(model) } : { error: 'Synthetic Ollama failure' };
  const { result } = runCode('Preparar resultado para NestJS', [wrap(output)], { 'Filtrar y proteger aviso': filtered })[0].json;
  return result.status === 'ignored' && result.source === 'legacy' ? undefined : result;
}

export function oauthInput(body) {
  return runCode('Normalizar Gmail OAuth', [wrap({ body: { authenticated: true, ...body } })]);
}
