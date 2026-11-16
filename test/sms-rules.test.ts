import assert from 'node:assert/strict';
import test from 'node:test';
import { isNequiSmsCandidate, parseNequiSms } from '../src/sms-rules.js';

// Synthetic templates except the explicitly labeled anonymized reversal format below.
// Tests never import a real movement or retain personal sender/account identifiers.
const sender = 'NEQUI-SYNTHETIC';
const receivedAt = '2026-11-16T03:20:12.000Z';
const parse = (body: string, timestamp = receivedAt) => parseNequiSms({ sender, body, receivedAt: timestamp });

test('explicit sender compatibility stays exact when autodetection is disabled and never claims bank authentication', () => {
  const body = 'Nequi: Recibiste COP 25.000 de PERSONA SINTETICA.';
  for (const source of ['NEQUI', sender.toLowerCase(), ' ' + sender, sender + '-FAKE']) {
    assert.deepEqual(parseNequiSms({ sender: source, body, receivedAt }, [sender], false),
      { status: 'ignored', reason: 'sender_not_allowed' });
  }
  assert.equal(parseNequiSms({ sender, body, receivedAt }, [], false).status, 'ignored');
  assert.equal(parseNequiSms({ sender, body, receivedAt }, [sender], false).status, 'registered');
  const result = parse(body);
  assert.equal(result.status, 'registered');
  assert.equal('authenticated' in result, false);
  assert.equal('body' in result, false);
  assert.doesNotMatch(JSON.stringify(result), /PERSONA SINTETICA/);
});

test('SMS autodetects a declared Nequi source from sender, heading or the user account without manual configuration', () => {
  for (const [source, body, direction] of [
    ['890001', 'Nequi: te enviaron COP 25.000.', 'income'],
    ['890001', 'Nequi: recibiste 25.000 de PERSONA SINTETICA.', 'income'],
    ['890001', 'Nequi te informa que recibiste COP 25.000.', 'income'],
    ['Nequi', 'Recibiste COP 25.000.', 'income'],
    ['NEQUI', 'Enviaste COP 25.000.', 'expense'],
    ['890001', 'Recibiste COP 25.000 en tu Nequi.', 'income'],
    ['890001', 'Enviaste COP 25.000 desde tu Nequi.', 'expense'],
    ['890001', 'Nequi: Recibiste COP 25.000 desde el banco Davivienda.', 'income'],
  ]) {
    const input = { sender: source, body, receivedAt };
    assert.equal(isNequiSmsCandidate(input), true, body);
    const result = parseNequiSms(input);
    assert.equal(result.status, 'registered', body);
    assert.ok(result.status === 'registered');
    assert.equal(result.movement.direction, direction, body);
    assert.equal(result.movement.amountMinor, '2500000', body);
  }
});

test('a destination mention or arbitrary numeric sender does not identify a Nequi source', () => {
  for (const [source, body] of [
    ['890002', 'Recibiste COP 25.000.'],
    ['890002', 'Enviaste COP 25.000 a Nequi.'],
    ['890002', 'Bancolombia: Enviaste COP 25.000 a Nequi.'],
    ['Bancolombia', 'Recibiste COP 25.000 en tu Nequi.'],
    ['Davivienda', 'Nequi: Recibiste COP 25.000.'],
    ['890002', 'Banco de Bogota: Pagaste COP 25.000 desde tu Nequi.'],
    ['890002', 'Tu compra por COP 25.000 está disponible. Puedes pagar en Nequi.'],
  ]) {
    const input = { sender: source, body, receivedAt };
    assert.equal(isNequiSmsCandidate(input), false, body);
    assert.deepEqual(parseNequiSms(input), { status: 'ignored', reason: 'sender_not_allowed' }, body);
  }
  assert.equal(parseNequiSms({ sender: 'Bancolombia', body: 'Enviaste COP 25.000 a Nequi.', receivedAt },
    ['Bancolombia'], false).status, 'ignored');
});

test('synthetic equivalent incoming-money verbs register while promises, requests and negations do not', () => {
  for (const [body, minor] of [
    ['Nequi: Ana te envió $300.000.', '30000000'],
    ['Nequi: Te llegó plata por $50.000.', '5000000'],
    ['Nequi: Has recibido $50.000.', '5000000'],
    ['Has recibido COP 50.000 en tu Nequi.', '5000000'],
    ['Ana te envió $50.000 en tu Nequi.', '5000000'],
  ]) {
    assert.equal(isNequiSmsCandidate({ sender, body }), true, body);
    const result = parse(body);
    assert.equal(result.status, 'registered', body);
    assert.ok(result.status === 'registered');
    assert.deepEqual([result.movement.amountMinor, result.movement.direction, result.movement.category], [minor, 'income', 'ingresos']);
    assert.doesNotMatch(JSON.stringify(result), /Ana/);
  }
  for (const body of [
    'Nequi: Ana te enviará $300.000.',
    'Nequi: Ana te va a enviar $300.000.',
    'Nequi: Te llegará plata por $50.000.',
    'Nequi: No has recibido $50.000.',
    'Nequi: No te llegó plata por $50.000.',
    'Nequi: Has recibido una solicitud de pago por $50.000.',
    'Nequi: Ana te envió una solicitud de pago por $50.000.',
    'Nequi: Si Ana te envió $50.000, revisa los movimientos.',
    'Nequi: Tal vez Ana te envió $50.000.',
    'Nequi: No te reembolsaron COP 50.000.',
    'Nequi: No te enviaron COP 50.000.',
    'Nequi: No te debitaron COP 50.000.',
    'Nequi: Si no te reembolsaron COP 50.000, revisa los movimientos.',
  ]) {
    assert.equal(isNequiSmsCandidate({ sender, body }), false, body);
    assert.equal(parse(body).status, 'ignored', body);
  }
});

test('synthetic incoming SMS uses the full Bogota receipt clock when no operation date exists', () => {
  for (const [amount, minor] of [['300.000', '30000000'], ['50.000', '5000000']]) {
    const result = parse('Nequi: Recibiste ' + amount + ' de PERSONA SINTETICA por Bre-B.');
    assert.equal(result.status, 'registered');
    assert.ok(result.status === 'registered');
    assert.deepEqual([result.movement.amountMinor, result.movement.currency, result.movement.direction,
      result.movement.category, result.movement.date, result.movement.transactionTime, result.movement.dateSource],
    [minor, 'COP', 'income', 'ingresos', '2026-11-15', '22:20:12', 'received_at']);
  }
});

test('SMS records actual outgoing money and preserves declared operation date and clock', () => {
  for (const [body, category, clock] of [
    ['Nequi: Enviaste $80.000 a la llave 3001234567 de PERSONA SINTETICA el 15/11/2026 a las 4:13 p.m.', 'otros', '16:13'],
    ['Nequi: Compraste COP 80.000 en Farmacia Sintetica el 15/11/2026.', 'salud', null],
    ['Nequi: Transferiste COP 80.000 a tu otra cuenta el 15/11/2026.', 'otros', null],
  ] as const) {
    const result = parse(body);
    assert.equal(result.status, 'registered', body);
    assert.ok(result.status === 'registered');
    assert.deepEqual([result.movement.amountMinor, result.movement.direction, result.movement.category,
      result.movement.date, result.movement.transactionTime, result.movement.dateSource],
    ['8000000', 'expense', category, '2026-11-15', clock, 'reported']);
  }
});

test('SMS rejects OTPs and access or withdrawal codes before considering monetary wording', () => {
  for (const body of [
    'Nequi: Tu codigo de seguridad es 123456.',
    'Nequi: Tu clave dinamica es 300000. No la compartas.',
    'Nequi: Recibiste tu codigo OTP 123456.',
    'Nequi: Codigo para retirar 654321 por COP 80.000.',
    'Nequi: Tu codigo es 123456. Pagaste COP 80.000.',
    'Nequi: Recibiste 123456, este es tu codigo.',
    'Nequi: Tu PIN 1234 autoriza una compra de COP 80.000.',
  ]) {
    assert.deepEqual(parse(body), { status: 'ignored', reason: 'security_message' }, body);
    assert.equal(isNequiSmsCandidate({ sender, body }), false, body);
  }
});

test('SMS canceled, rejected and pending operations never become effective movements', () => {
  for (const body of [
    'Nequi: Tu pago por COP 80.000 fue rechazado.',
    'Nequi: Compraste COP 80.000. Estado: Pendiente.',
    'Nequi: Transferencia cancelada por COP 80.000.',
    'Nequi: Reembolso pendiente por COP 80.000.',
    'Nequi: Solicitud de pago por COP 80.000.',
  ]) {
    assert.deepEqual(parse(body), { status: 'ignored', reason: 'non_movement' }, body);
    assert.equal(isNequiSmsCandidate({ sender, body }), false, body);
  }
  for (const body of [
    'Nequi: Tu compra por COP 80.000 fue cancelada. Te reembolsaron COP 80.000 el 15/11/2026.',
    'Nequi: Pagaste COP 80.000 el 15/11/2026. Si tu pago por COP 80.000 fue rechazado, comunicate con nosotros.',
    'Nequi: Pagaste COP 80.000 el 15/11/2026. Si no te reembolsaron COP 80.000, comunicate con nosotros.',
  ]) assert.equal(parse(body).status, 'registered', body);
});

test('observed Nequi Reversamos format records the credited return while preserving both purchase amounts', () => {
  // Observed structure with the merchant anonymized; the receipt timestamp is the operation-date fallback.
  const timestamp = '2026-11-04T08:22:36.834Z';
  const body = 'NEQUI: Reversamos 300,00 de tu compra en COMERCIO SINTETICO a tu Tarjeta';
  assert.equal(isNequiSmsCandidate({ sender, body }), true);
  const result = parse(body, timestamp);
  assert.equal(result.status, 'registered');
  assert.ok(result.status === 'registered');
  assert.deepEqual([result.movement.amountMinor, result.movement.currency, result.movement.direction,
    result.movement.category, result.movement.date, result.movement.transactionTime, result.movement.dateSource],
  ['30000', 'COP', 'income', 'ingresos', '2026-11-04', '03:22:36', 'received_at']);
  assert.equal('references' in result, false);
  for (const [amount, minor] of [['300,00', '30000'], ['30.000,00', '3000000']]) {
    const payment = parse('NEQUI: Pagaste ' + amount + ' en COMERCIO SINTETICO con tu Tarjeta', timestamp);
    assert.equal(payment.status, 'registered');
    assert.ok(payment.status === 'registered');
    assert.deepEqual([payment.movement.amountMinor, payment.movement.currency, payment.movement.direction], [minor, 'COP', 'expense']);
  }
});

test('SMS reversal negations, promises, requests and pending states never imply credited money', () => {
  for (const body of [
    'NEQUI: No reversamos 300,00 de tu compra a tu Tarjeta.',
    'NEQUI: Nunca reversamos 300,00 de tu compra a tu Tarjeta.',
    'NEQUI: Reversaremos 300,00 de tu compra a tu Tarjeta.',
    'NEQUI: Vamos a reversar 300,00 de tu compra a tu Tarjeta.',
    'NEQUI: Si reversamos 300,00 de tu compra, te avisaremos.',
    'NEQUI: Solicitud de reversión de tu compra por COP 300,00.',
    'NEQUI: Reversión pendiente de tu compra por COP 300,00.',
    'NEQUI: Reversamos 300,00 de tu compra a tu Tarjeta. Estado: Pendiente.',
    'NEQUI: Reversamos 300,00 de tu compra a tu Tarjeta. Estado: Rechazado.',
  ]) {
    assert.equal(isNequiSmsCandidate({ sender, body }), false, body);
    assert.equal(parse(body).status, 'ignored', body);
  }
});

test('SMS incomplete or conflicting evidence remains unconfirmed without a Gmail pending notice', () => {
  for (const [body, missing] of [
    ['Nequi: Recibiste una transferencia. Cuenta 3001234567.', 'amount'],
    ['Nequi: Recibiste 3001234567.', 'amount'],
    ['Nequi: Aviso de transferencia. Monto COP 80.000.', 'direction'],
    ['Nequi: Pagaste COP 80.000 o COP 90.000.', 'amount'],
    ['Nequi: Pagaste COP 80.000 el 14/11/2026. Fecha del pago: 15/11/2026.', 'date'],
  ]) {
    const result = parse(body);
    assert.equal(result.status, 'unconfirmed', body);
    assert.ok(result.status === 'unconfirmed');
    assert.ok(result.insufficientFields?.includes(missing), body);
    assert.equal('evidence' in result, false);
  }
  assert.deepEqual(parse('Nequi: Tu saldo disponible es COP 80.000.'), { status: 'ignored', reason: 'non_movement' });
});

test('SMS keeps only explicit PSE operation references shared with email and never deduplicates by amount', () => {
  const result = parse('Nequi: Pagaste COP 80.000 mediante PSE el 15/11/2026. CUS: 123456789012.');
  assert.equal(result.status, 'registered');
  assert.ok(result.status === 'registered');
  assert.deepEqual(result.references, ['pse:123456789012']);
  assert.equal(parse('Nequi: Pagaste COP 80.000 mediante PSE. Tu codigo unico de seguimiento: 123456789012.').status, 'registered');
  for (const body of [
    'Nequi: Pagaste COP 80.000 el 15/11/2026. Referencia: 123456789012.',
    'Nequi: Pagaste COP 80.000 mediante PSE el 15/11/2026. CUS: 123456789012. CUS: 123456789013.',
  ]) {
    const other = parse(body);
    assert.equal(other.status, 'registered');
    assert.equal('references' in other, false);
  }
});

test('SMS rejects invalid receipt timestamps and oversized bodies without truncating contrary evidence', () => {
  for (const timestamp of ['invalid', '2026-02-30T12:00:00Z', '2026-11-16', '2026-11-16T25:00:00Z']) {
    assert.deepEqual(parse('Nequi: Recibiste COP 25.000.', timestamp), { status: 'unconfirmed', reason: 'invalid_received_at' });
  }
  assert.deepEqual(parse('Nequi: Recibiste COP 25.000. ' + 'x'.repeat(5000) + ' Estado: Rechazado.'),
    { status: 'unconfirmed', reason: 'message_too_long' });
  assert.deepEqual(parse(''), { status: 'ignored', reason: 'empty_message' });
});
