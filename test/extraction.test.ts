import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readConfig } from '../src/config.js';
import { candidate, resolveExtraction } from '../src/extraction.js';
import { GmailExtraction } from '../src/gmail-extraction.js';
import { localIntent } from '../src/history.js';
import { gmailBankSenders, readGmailModel, resolveGmailExtraction } from '../src/mail-rules.js';

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
    transactionTime: null, cardType: null, cardLast4: null, reportedInstitution: null,
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

test('uses rules for authenticated Bancolombia formats and sends only a protected fragment to OpenAI with consent', async t => {
  const service = new GmailExtraction(readConfig({
    PUBLIC_URL: 'http://localhost:3105', DATABASE_URL: 'postgres://test@localhost/mailgasto_test',
    ENCRYPTION_KEY: 'ab'.repeat(32), N8N_AGENT_KEY: 'test-agent-key-for-local-testing',
    N8N_INGEST_KEY: 'test-ingest-key-for-local-testing', SMTP_URL: 'smtp://localhost:1026',
    SMTP_FROM: 'test@example.test', OPENAI_API_KEY: 'synthetic-key-used-only-by-mock',
  }));
  const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
      classification: 'completed', amountMinor: '2500000', currency: 'COP', date: '2026-11-13',
      description: null, category: 'ingresos', categoryEvidence: null, direction: 'income', confidence: 0.98,
    }) }] }],
  }));
  const sender = Object.keys(gmailBankSenders)[0];
  const labels = ['INBOX'];
  const subject = 'Alertas y Notificaciones';
  const formats = [
    ['Recibiste un pago de nómina por $1,257,483.12 en el producto *1234, el 13/11/2026 a las 10:08.',
      '125748312', 'income', null, '10:08', 'Pago de nómina'],
    ['Transferiste $218,700.00 por Boton Bancolombia a TELEFONIA DEMO S.A. desde producto *1234. 13/11/2026 10:46:22 ¿Dudas? 018000555555. Este es una notificación automática.',
      '21870000', 'expense', 'Botón Bancolombia', '10:46:22', 'TELEFONIA DEMO S.A.'],
    ['Pagaste $25,000.00 por QR el 13/11/2026 a las 11:21.', '2500000', 'expense', 'QR', '11:21', 'Salida de dinero · QR'],
    ['Compraste $270,779.00 en TIENDA DEMO con tu T.Deb *1234, el 13/11/2026 a las 11:46.',
      '27077900', 'expense', 'Tarjeta', '11:46', 'TIENDA DEMO'],
  ] as const;
  for (const [index, [notice, amount, direction, method, time, description]] of formats.entries()) {
    const text = 'Bancolombia: ' + notice + '\nPor tu seguridad, no compartas códigos de verificación.';
    const from = index === 1 ? sender : 'alertasynotificaciones@ayn.notificacionesbancolombia.com';
    const result = await service.classify({ labels, from, subject, text }, true, true);
    assert.equal(result.status, 'registered');
    if (result.status === 'registered') {
      const m = result.movement;
      assert.deepEqual([m.amountMinor, m.direction, m.paymentMethod, m.transactionTime, m.description], [amount, direction, method, time, description]);
      assert.equal(m.reportedInstitution, 'bancolombia');
      assert.equal(m.cardLast4, method === 'Tarjeta' ? '1234' : null);
    }
  }
  const payment = {
    labels, from: 'tienda@ejemplo.test', subject: 'Aviso de transferencia',
    text: 'Hola Persona Destinataria\nRecibiste una transferencia de $25.000 de Persona Sintética en tu cuenta el 13 de noviembre de 2026. ' +
      'Producto 123456789012; teléfono 3215555555; https://example.test; titular@example.test',
  };
  assert.equal((await service.classify({ ...payment, from: sender }, false, false)).status, 'pending');
  assert.equal((await service.classify(payment, false, true)).status, 'pending');
  assert.equal(mock.mock.callCount(), 0);
  assert.equal((await service.classify(payment, true, true)).status, 'registered');
  assert.equal(mock.mock.callCount(), 1);
  const [url, init] = mock.mock.calls[0].arguments as unknown as [string, RequestInit];
  assert.equal(url, 'https://api.openai.com/v1/responses');
  const sent = JSON.parse(init.body as string);
  assert.equal(sent.model, 'gpt-5.4-mini-2026-03-17');
  assert.equal(sent.store, false);
  assert.equal(sent.text.format.strict, true);
  assert.match(sent.input, /\$25\.000/);
  assert.match(sent.input, /13 de noviembre de 2026/);
  assert.doesNotMatch(sent.input, /Persona (?:Sintética|Destinataria)|123456789012|3215555555|example\.test/);
  mock.mock.mockImplementationOnce(async () => Response.json({
    status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }],
  }));
  assert.equal((await service.classify(payment, true, true)).status, 'pending');
});
