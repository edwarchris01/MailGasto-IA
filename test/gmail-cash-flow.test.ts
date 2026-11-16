import assert from 'node:assert/strict';
import test from 'node:test';
import { GmailExtraction } from '../src/gmail-extraction.js';
import { readConfig } from '../src/config.js';
import { gmailClassifierCases } from './gmail-classifier-cases.mjs';
import {
  candidate, gmailBankSenders, gmailReceivedDateTime, isGmailExplicitNonMovement,
  resolveGmailExtraction, type GmailNotice,
} from '../src/mail-rules.js';

const bank = 'alertasynotificaciones@an.notificacionesbancolombia.com';
const receivedAt = '2026-11-16T03:20:12.000Z';

function classify(subject: string, body: string, from = bank, reception: string | undefined = receivedAt) {
  const notice = candidate(from, subject, body, gmailBankSenders, true, '2026-11-15');
  return notice ? resolveGmailExtraction(notice, null, true, undefined, reception) : { status: 'ignored' as const };
}

test('records real transfers, withdrawals, refunds and loan cash flows without a known purpose', () => {
  const cases = [
    ['Transferencia recibida', 'Recibiste una transferencia por COP 25.000 el 15/11/2026.', bank, 'income', '2500000'],
    ['Transferencia realizada', 'Transferiste COP 25.000 a tu otra cuenta el 15/11/2026.', bank, 'expense', '2500000'],
    ['Transferencia realizada', 'Enviaste COP 25.000 el 15/11/2026.', bank, 'expense', '2500000'],
    ['Retiro realizado', 'Retiraste COP 25.000 el 15/11/2026.', bank, 'expense', '2500000'],
    ['Reembolso acreditado', 'Te reembolsaron COP 25.000 el 15/11/2026.', bank, 'income', '2500000'],
    ['Reverso acreditado', 'Se acreditó COP 25.000 por el reverso el 15/11/2026.', bank, 'income', '2500000'],
    ['Pago realizado', 'Pagaste tu tarjeta de credito por COP 25.000 el 15/11/2026.', bank, 'expense', '2500000'],
    ['Tu crédito ha sido desembolsado', 'Ya recibiste tu dinero. Monto desembolsado: COP 500.000.\nFecha de desembolso: 15/11/2026.',
      'micredito@rapicredit.com', 'income', '50000000'],
    ['Recibimos tu pago', 'Te agradecemos por el pago. Has completado el pago por COP 25.000 el 15/11/2026.',
      'micredito@rapicredit.com', 'expense', '2500000'],
  ];
  for (const [subject, body, from, direction, amount] of cases) {
    const result = classify(subject, body, from);
    assert.equal(result.status, 'registered', subject);
    assert.ok('movement' in result);
    assert.deepEqual([result.movement.amountMinor, result.movement.currency, result.movement.direction,
      result.movement.date, result.movement.dateSource],
    [amount, 'COP', direction, '2026-11-15', 'reported'], subject);
    assert.equal(result.movement.category, direction === 'income' ? 'ingresos' : 'otros', subject);
  }
});

test('synthetic Nequi incoming amounts are recorded with receipt time only when the operation date is unavailable', () => {
  for (const [amount, minor] of [['300.000', '30000000'], ['50.000', '5000000']]) {
    const result = classify('¡Recibiste plata por Bre-B!', 'Recibiste ' + amount + ' de PERSONA SINTETICA por Bre-B.',
      'notificaciones@nequi.com.co');
    assert.equal(result.status, 'registered');
    assert.ok('movement' in result);
    assert.deepEqual([result.movement.amountMinor, result.movement.direction, result.movement.category,
      result.movement.date, result.movement.transactionTime, result.movement.dateSource],
    [minor, 'income', 'ingresos', '2026-11-15', '22:20:12', 'received_at']);
  }
});

test('reported dates keep their literal time and never borrow a receipt clock', () => {
  for (const [body, clock] of [
    ['Compraste COP 25.000 el 14/11/2026.', null],
    ['Compraste COP 25.000 el 14/11/2026 a las 10:15.', '10:15'],
  ] as const) {
    const result = classify('Compra realizada', body);
    assert.equal(result.status, 'registered');
    assert.ok('movement' in result);
    assert.equal(result.movement.date, '2026-11-14');
    assert.equal(result.movement.dateSource, 'reported');
    assert.equal(result.movement.transactionTime, clock);
  }
  assert.deepEqual(gmailReceivedDateTime('2026-11-16T05:00:00.000Z'),
    { date: '2026-11-16', transactionTime: '00:00:00' });
  assert.equal(gmailReceivedDateTime('invalid'), undefined);
});

test('conflicting operation dates stay unresolved instead of being replaced by receipt time', () => {
  const result = classify('Compra realizada',
    'Compraste COP 25.000 el 14/11/2026. Fecha de la compra: 15/11/2026.');
  assert.equal(result.status, 'pending');
  assert.ok('unconfirmedFields' in result);
  assert.deepEqual(result.unconfirmedFields, ['date']);
  assert.ok('evidence' in result);
  assert.equal(result.evidence.date, null);
  assert.equal(result.evidence.dateSource, undefined);
  assert.equal(result.evidence.transactionTime, null);
});

test('a rejected, canceled or pending operation is ignored even when the email repeats approval wording', () => {
  for (const [subject, body] of [
    ['Pago cancelado', 'La compra aprobada por COP 25.000 fue cancelada.'],
    ['Aviso de compra', 'Compraste COP 25.000 el 15/11/2026. Estado: Rechazado.'],
    ['Aviso de compra', 'Compraste COP 25.000 el 15/11/2026. Estado: Pendiente.'],
    ['Transferencia programada', 'Transferencia programada por COP 25.000 para el 15/11/2026.'],
    ['Reembolso pendiente', 'Tu reembolso de COP 25.000 está en proceso.'],
  ]) {
    assert.equal(isGmailExplicitNonMovement(subject, body), true, subject + ': ' + body);
    assert.equal(classify(subject, body).status, 'ignored', subject + ': ' + body);
    const raw: GmailNotice = { provider: 'bancolombia', forwarded: false, subject, body };
    assert.equal(resolveGmailExtraction(raw, null, true, undefined, receivedAt).status, 'ignored');
  }
  assert.equal(classify('Reembolso acreditado',
    'La compra fue cancelada. Te reembolsaron COP 25.000 el 15/11/2026.').status, 'registered');
});

test('operation states separated by an amount are ignored without treating conditional or historical prose as the current state', () => {
  for (const [subject, body] of [
    ['Aviso de pago', 'Tu pago por COP 80.000 fue rechazado.'],
    ['Aviso de compra', 'Tu compra por COP 80.000 fue cancelada.'],
    ['Aviso de transferencia', 'Tu transferencia por COP 80.000 está pendiente.'],
  ]) {
    assert.equal(isGmailExplicitNonMovement(subject, body), true, body);
    assert.equal(classify(subject, body).status, 'ignored', body);
  }
  for (const note of [
    'Si tu pago por COP 80.000 fue rechazado, comunícate con nosotros.',
    'En caso de que tu compra por COP 80.000 fuera cancelada, comunícate con nosotros.',
    'Tu pago anterior por COP 80.000 fue rechazado.',
  ]) {
    const body = 'Pagaste COP 80.000 el 15/11/2026.\n' + note;
    assert.equal(isGmailExplicitNonMovement('Pago realizado', body), false, note);
    assert.equal(classify('Pago realizado', body).status, 'registered', note);
  }
  assert.equal(classify('Reembolso acreditado',
    'Tu compra por COP 80.000 fue cancelada. Te reembolsaron COP 80.000 el 15/11/2026.').status, 'registered');
});

test('DigitalOcean failed charges and nonpayment notices are explicit non-movements', () => {
  for (const [subject, body] of [
    ['DigitalOcean - Failed to process card payment', 'Failed Card Payment. We attempted to charge the card ending in 1234 but the charge failed.'],
    ["We couldn't process your DigitalOcean payment", 'Action Required: Please Complete Payment. We encountered an issue while attempting to automatically charge your card.'],
    ['Account suspended for nonpayment', 'Your past due balance of USD 4.64 is still unpaid.'],
    ['Account Suspension Warning', 'Payment of $4.64 required. You have a past due balance.'],
  ]) {
    assert.equal(isGmailExplicitNonMovement(subject, body), true, subject);
    assert.equal(classify(subject, body, 'support@digitalocean.com').status, 'ignored', subject);
  }
});

test('receipt fallback cannot invent amount, direction or sender authenticity', () => {
  for (const [body, missing] of [
    ['Recibiste una transferencia.', 'amount'],
    ['Aviso de transferencia. Valor COP 25.000.', 'direction'],
  ]) {
    const result = classify('Aviso de transferencia', body);
    assert.equal(result.status, 'pending');
    assert.ok('unconfirmedFields' in result && result.unconfirmedFields.includes(missing));
  }
  const source = candidate(bank, 'Transferencia recibida', 'Recibiste COP 25.000.', gmailBankSenders, true)!;
  assert.equal(resolveGmailExtraction({ ...source, unauthenticated: true }, null, true, undefined, receivedAt).status, 'pending');
  assert.equal(resolveGmailExtraction({ ...source, forwarded: true }, null, true, undefined, receivedAt).status, 'pending');
  assert.equal(resolveGmailExtraction(source, null, true).status, 'pending');
});

test('an authenticated generic sender with literal cash flow does not need the model or a known purpose', () => {
  const raw = { subject: 'Transferencia recibida', body: 'Te abonaron COP 25.000.' };
  const from = 'pagos@comercio-sintetico.example';
  const trusted = candidate(from, raw.subject, raw.body, gmailBankSenders, true)!;
  const result = resolveGmailExtraction(trusted, null, true, undefined, receivedAt);
  assert.equal(result.status, 'registered');
  assert.ok('movement' in result);
  assert.equal(result.movement.category, 'ingresos');
  const unverified = candidate(from, raw.subject, raw.body, gmailBankSenders)!;
  assert.equal(resolveGmailExtraction(unverified, null, true, undefined, receivedAt).status, 'pending');
  const spoofed = candidate(from, raw.subject, 'Bancolombia: ' + raw.body, gmailBankSenders, true)!;
  assert.equal(resolveGmailExtraction(spoofed, null, true, undefined, receivedAt).status, 'pending');
});

test('the synthetic classifier corpus resolves locally under the cash-flow policy', () => {
  for (const row of gmailClassifierCases) {
    const notice = candidate(row.from, row.subject, row.text, gmailBankSenders, row.authenticated);
    const result = notice ? resolveGmailExtraction(notice, null, true, undefined, row.receivedAt) : { status: 'ignored' };
    assert.equal(result.status, row.expected.status, row.id);
    if (row.expected.fields) {
      assert.ok('movement' in result, row.id);
      for (const [field, expected] of Object.entries(row.expected.fields)) {
        assert.equal(result.movement[field as keyof typeof result.movement], expected, row.id + ':' + field);
      }
    }
  }
});

test('Gmail extraction passes the trusted receipt timestamp to the local cash-flow decision', async () => {
  const extraction = new GmailExtraction(readConfig({
    DATABASE_URL: 'postgres://test@localhost/mailgasto_test', ENCRYPTION_KEY: 'ab'.repeat(32),
    N8N_AGENT_KEY: 'synthetic-cash-flow-agent-key-for-testing', N8N_INGEST_KEY: 'synthetic-cash-flow-ingest-key-for-testing',
    SMTP_URL: 'smtp://localhost:1026', SMTP_FROM: 'test@example.test',
  }));
  const result = await extraction.classify({ labels: ['INBOX'], from: bank, subject: 'Transferencia recibida',
    text: 'Recibiste una transferencia por COP 25.000.' }, false, true, receivedAt);
  assert.equal(result.status, 'registered');
  assert.ok('movement' in result);
  assert.deepEqual([result.movement.date, result.movement.transactionTime, result.movement.dateSource],
    ['2026-11-15', '22:20:12', 'received_at']);
});
