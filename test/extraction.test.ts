import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidate, resolveExtraction } from '../src/extraction.js';
import { localIntent } from '../src/history.js';
import { readGmailModel, resolveGmailExtraction } from '../src/mail-rules.js';

const senders = { 'alertas@nequi.example': 'nequi', '@bancolombia.example': 'bancolombia' } as const;
const sample = 'Pagaste COP 25.000 en Restaurante Demo el 10/11/2026.';
const valid = {
  amountMinor: '2500000', currency: 'COP', date: '2026-11-10', paymentMethod: 'Nequi',
  description: 'Restaurante Demo', category: 'alimentacion', direction: 'expense', confidence: 0.95,
};
const notice = { provider: 'nequi', forwarded: false, text: sample } as const;

test('recognizes notices and identifiable forwards and removes sensitive material', () => {
  const secret = ' cuenta 12345678901, cliente@demo.example, https://demo.example/historial';
  assert.equal(candidate('bad@evil.example', 'Compra', sample, senders)?.provider, 'other');
  assert.equal(candidate('alertas@nequi.example', 'Promoción de pagos', sample, senders), null);
  assert.equal(candidate('alertas@nequi.example', 'Aviso',
    'Tu código de seguridad para la transacción es 123456.', senders), null);
  assert.equal(candidate('alertas@nequi.example', '[MailGasto IA] Aviso pendiente', sample, senders), null);
  assert.equal(candidate('owner@example.test', 'Fwd: Aviso de compra',
    '---------- Mensaje reenviado ---------\nDe: alertas@nequi.example <other@evil.example>\n\n' + sample, senders)?.provider, 'other');
  const forwarded = candidate('owner@example.test', 'Fwd: Aviso de compra',
    'Nota personal\n---------- Mensaje reenviado ---------\nDe: Nequi <alertas@nequi.example>\nAsunto: Compra\n\n' +
    sample + secret, senders);
  assert.equal(forwarded?.forwarded, true);
  assert.equal(forwarded?.subject, 'Compra');
  assert.match(forwarded?.body ?? '', /25\.000/);
  assert.doesNotMatch(forwarded?.body ?? '', /Nota personal|12345678901|@demo|https:/);
});

test('registers confirmed income from a commerce and discards payment requests and failures', () => {
  const from = 'avisos@comercio.example';
  const incoming = candidate(from, 'Transferencia recibida', 'Te abonaron 1.200 el 10/11/2026 con Nequi.', senders);
  assert.equal(incoming?.provider, 'other');
  const model = readGmailModel({ ...valid, classification: 'completed', amountMinor: '120000', direction: 'income' });
  const result = resolveGmailExtraction(incoming!, model);
  assert.equal(result.status, 'registered');
  assert.deepEqual(result.movement, {
    amountMinor: '120000', currency: 'COP', date: '2026-11-10', paymentMethod: 'Nequi',
    description: 'Ingreso · Nequi', category: 'ingresos', direction: 'income',
  });
  assert.equal(resolveGmailExtraction(incoming!, null).status, 'error');
  assert.equal(candidate(from, 'Solicitud de pago', 'Paga antes de mañana el saldo de COP 1.200.', senders), null);
  assert.equal(candidate(from, 'Pago cancelado', 'La compra aprobada por COP 1.200 fue cancelada.', senders), null);
  assert.equal(candidate(from, 'Pago de ropa', 'Tu pago no pudo ser procesado.', senders), null);
  const incomplete = candidate(from, 'Compra aprobada', 'Compraste un plan.', senders);
  assert.equal(resolveGmailExtraction(incomplete!, model).status, 'pending');
});

test('requires grounded amount, date, currency, direction, method and threshold', () => {
  const result = resolveExtraction(notice, valid);
  assert.equal(result.status, 'registered');
  assert.equal(result.movement?.amountMinor, '2500000');
  for (const changed of [
    { amountMinor: '2500' }, { date: '2026-11-09' }, { confidence: 0.69 }, { direction: 'income' },
    { currency: 'USD' }, { paymentMethod: 'Tarjeta' },
  ]) assert.equal(resolveExtraction(notice, { ...valid, ...changed }).status, 'pending');
  assert.equal(resolveExtraction({ ...notice, text: 'Pagaste el 10/11/2026' }, valid).status, 'pending');
  assert.equal(resolveExtraction({ ...notice, text: sample + ' Monto COP 50.000' }, valid).status, 'pending');
  assert.equal(resolveExtraction({ ...notice, text: 'Pagaste COP 250 el 10/11/2026' }, null, true).movement?.amountMinor, '25000');
  assert.equal(resolveExtraction({ ...notice, text: 'Pagaste en Restaurante Demo' }, null, true).status, 'error');
});

test('extracts diverse synthetic notices with explicit evidence', () => {
  const formats = [
    { currency: 'COP', token: '$ 25.000', minor: '2500000' },
    { currency: 'COP', token: 'COP 950', minor: '95000' },
    { currency: 'USD', token: 'USD 12.50', minor: '1250' },
    { currency: 'EUR', token: '€ 25,40', minor: '2540' },
    { currency: 'COP', token: '25.000,25 COP', minor: '2500025' },
  ];
  const dates = ['10/11/2026', '2026-11-10', '10 de noviembre de 2026'];
  let exact = 0;
  for (const format of formats) for (const date of dates) for (const direction of ['expense', 'income']) {
    const income = direction === 'income';
    const out = resolveExtraction({
      provider: income ? 'nequi' : 'bancolombia', forwarded: false,
      text: (income ? 'Recibiste ' : 'Compraste ') + format.token + ' el ' + date + (income ? '' : ' con tarjeta.'),
    }, null, true);
    if (out.movement?.amountMinor === format.minor && out.movement.currency === format.currency &&
        out.movement.direction === direction && out.movement.date === '2026-11-10' &&
        out.movement.paymentMethod === (income ? 'Nequi' : 'Tarjeta')) exact++;
  }
  assert.equal(exact, 30);
  console.info('Synthetic rule extraction: ' + exact + '/30 exact');
});

test('detects intent and inherited period without allowing chat to create transactions', () => {
  assert.equal(localIntent('Lo de ayer').period, 'yesterday');
  assert.equal(localIntent('¿Y transporte?').category, 'transporte');
  assert.equal(localIntent('¿Cuánto gasté en ropa este mes?').category, 'compras');
  assert.equal(localIntent('Registra un gasto de 25000').action, 'register');
  assert.equal(localIntent('¿Cuánto gasté el 2026-11-10?').action, 'summary');
});
