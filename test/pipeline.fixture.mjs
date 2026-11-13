import { buildGmailWorkflow } from '../n8n/gmail-workflow.mjs';

export const bank = 'Pagaste COP 25.000 en Restaurante Demo el 10/11/2026. Cuenta 12345678901.';
export const bankSender = 'alertas@nequi.example';
export const shopSender = 'avisos@comercio.example';
export const agavalSubject = 'Pago de ropa';
export const agaval = 'Tu pago fue procesado, pagaste 50.000 en almacenes Agaval, el 10/11/2026 a las 12:00pm, gracias por tu compra.';
export const bankPurchaseSubject = 'Alertas y Notificaciones – Compra';
export const bankPurchase = 'Bancolombia: Compraste $30.750,00 en MERCADO DEL BUENO con tu T.Deb *1234, el 10/11/2026 a las 14:42.';
export const flow = buildGmailWorkflow({ senderJson: JSON.stringify({ [bankSender]: 'nequi', 'tarjeta@bancolombia.example': 'bancolombia' }) });
export const goodModel = {
  amountMinor: '2500000', currency: 'COP', date: '2026-11-10', paymentMethod: 'Nequi', description: 'Restaurante Demo',
  category: 'alimentacion', direction: 'expense', confidence: 0.95, classification: 'completed',
  categoryEvidence: 'Restaurante Demo',
};
export const agavalMovement = {
  amountMinor: '5000000', currency: 'COP', date: '2026-11-10', paymentMethod: null,
  description: 'Almacenes Agaval', category: 'compras', direction: 'expense',
  transactionTime: '12:00', cardType: null, cardLast4: null, reportedInstitution: null,
};
export const agavalModel = {
  ...agavalMovement, classification: 'completed', categoryEvidence: agavalSubject, confidence: 0.95,
};
export const wrap = json => ({ json });

export function runCode(name, items, references = {}) {
  const node = flow.nodes.find(node => node.name === name);
  const code = new Function('$input', '$', node.parameters.jsCode);
  return code({ all: () => items }, key => ({ itemMatching: index => references[key][index] }));
}

export function legacyInput(messageId, receivedAt, text = bank, from = bankSender, subject = 'Aviso de pago', labels = ['INBOX']) {
  const staging = runCode('Preparar IDs de Gmail', [wrap({ id: messageId, internalDate: String(Date.parse(receivedAt)) })]);
  const read = runCode('Preparar lectura de Gmail', [wrap({ ...staging[0].json, id: 1 })]);
  return runCode('Normalizar Gmail directo', [wrap({ id: messageId, from: { value: [{ address: from }] }, subject, text, labelIds: labels })],
    { 'Preparar lectura de Gmail': read });
}

export function filterAndResolve(input, model = goodModel) {
  const filtered = runCode('Filtrar y proteger aviso', input);
  if (!filtered.length || !filtered[0].json.notice && filtered[0].json.identity.source === 'legacy') return undefined;
  const output = model ? { output: JSON.stringify(model) } : { error: 'Synthetic Ollama failure' };
  const { result } = runCode('Preparar resultado para NestJS', [wrap(output)], { 'Filtrar y proteger aviso': filtered })[0].json;
  return result.status === 'ignored' && result.source === 'legacy' ? undefined : result;
}

export function oauthInput(body) {
  return runCode('Normalizar Gmail OAuth', [wrap({ body })]);
}
