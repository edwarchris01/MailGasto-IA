import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { gmailResult } from '../src/gmail-results.js';
import { gmailModelInput, readGmailModel, resolveGmailExtraction } from '../src/mail-rules.js';
import { agaval, agavalModel, agavalMovement, agavalSubject, bank, bankPurchase, bankPurchaseSubject, bankSender, filterAndResolve, flow, goodModel,
  legacyInput, oauthInput, runCode, shopSender, uncertainModel, wrap } from './pipeline.fixture.mjs';

test('both Gmail triggers use the same filter and the model receives only a sanitized fragment', () => {
  const receivedAt = '2026-11-10T13:00:00.000Z';
  const text = bank + ' https://example.test/link cliente@example.test';
  const oauth = oauthInput({ deliveryId: randomUUID(), attemptId: randomUUID(), messageId: 'oauth-fixture', receivedAt,
    labels: ['INBOX'], from: bankSender, subject: 'Aviso de pago', text, source: 'legacy' });
  const direct = legacyInput('legacy-fixture', receivedAt, text);
  const filtered = runCode('Filtrar y proteger aviso', [...direct, ...oauth]);
  assert.deepEqual(filtered[0].json.notice, filtered[1].json.notice);
  assert.equal(filtered[1].json.identity.source, 'oauth');
  const agent = flow.nodes.find(n => n.name === 'Clasificar aviso con AI Agent')!;
  const model = flow.nodes.find(n => n.name === 'Ollama Chat Model')!;
  const expression = agent.parameters.text.slice(3, -2).trim();
  assert.equal(filtered[1].json.modelInput, null);
  assert.equal(filtered[1].json.local.status, 'registered');
  const sanitized = gmailModelInput(filtered[1].json.notice);
  const modelInput = new Function('$json', 'return ' + expression)({ ...filtered[1].json, modelInput: sanitized });
  assert.equal(agent.type, '@n8n/n8n-nodes-langchain.agent');
  assert.equal(agent.parameters.options.maxIterations, 2);
  assert.equal(model.parameters.model, 'qwen3.5:4b');
  assert.deepEqual(JSON.parse(modelInput), {
    provider: 'nequi', subject: 'Aviso de pago', body: sanitized.body,
    verified: { amountMinor: '2500000', currency: 'COP', date: '2026-11-10', direction: 'expense', paymentMethod: null,
      movementKind: 'payment', counterpartyRole: 'merchant' },
    evidenceHints: { amountMinor: 'COP 25.000', currency: 'COP', date: '10/11/2026', direction: 'Pagaste',
      classification: 'Pagaste' },
  });
  assert.doesNotMatch(modelInput, /12345678901|https:|@example|oauth-fixture|deliveryId/);
  const ambiguous = runCode('Filtrar y proteger aviso', legacyInput('ambiguous', receivedAt,
    text + '\nFecha del pago: 11/11/2026.'))[0].json;
  assert.equal(ambiguous.local, null);
  assert.ok(ambiguous.modelInput);
  assert.doesNotMatch(JSON.stringify(ambiguous.modelInput), /12345678901|https:|@example|deliveryId|receivedAt|authenticated/);
  assert.ok(gmailResult.safeParse(filterAndResolve(direct)).success);
  assert.ok(gmailResult.safeParse(filterAndResolve(oauth)).success);
  assert.equal(filterAndResolve(legacyInput('spam', receivedAt, bank, bankSender, 'Aviso de pago', ['SPAM'])), undefined);
  const unknown = legacyInput('unknown', receivedAt, bank, shopSender, 'Aviso de pago');
  const badModel = filterAndResolve(unknown, { ...goodModel, amountMinor: '5000000' });
  assert.equal(badModel.status, 'registered');
  assert.equal(badModel.movement.amountMinor, '2500000');
  assert.equal(filterAndResolve(direct, { ...goodModel, amountMinor: '5000000' }).movement?.amountMinor, '2500000');
  const card = filterAndResolve(legacyInput('card', receivedAt, 'Compraste USD 12.50 con tarjeta 1234 el 10/11/2026.',
    'tarjeta@bancolombia.example', 'Compra con tarjeta'), uncertainModel);
  assert.equal(card.movement.paymentMethod, 'Tarjeta');
  assert.equal(card.movement.cardLast4, null);
  assert.equal(card.movement.currency, 'USD');
});

test('keeps a Movistar applied payment when the model misclassifies its state', () => {
  const receivedAt = '2026-09-29T00:30:00.000Z';
  const from = 'movistar@movistar.com.co';
  const subject = 'Hemos recibido tu pago';
  const text = 'Estimado usuario, su pago por $ 60.000 del 28/09/2026 se aplico correctamente a la cuenta 1234567891.\n' +
    'Próxima factura disponible el 04/10/2026. Saldo de tu cuenta: COP 78.000.';
  const legacy = legacyInput('movistar-receipt', receivedAt, text, from, subject);
  const oauth = oauthInput({ deliveryId: randomUUID(), attemptId: randomUUID(), messageId: 'movistar-receipt',
    receivedAt, labels: ['INBOX'], from, subject, text });
  const modelError = { ...uncertainModel, classification: 'not_transaction' };
  for (const input of [legacy, oauth]) {
    const outcome = filterAndResolve(input, modelError);
    assert.equal(outcome.status, 'registered');
    assert.deepEqual(outcome.movement, { amountMinor: '6000000', currency: 'COP', date: '2026-09-28',
      direction: 'expense', description: 'Movistar', category: 'otros', paymentMethod: null,
      cardType: null, cardLast4: null, transactionTime: null, reportedInstitution: null, dateSource: 'reported' });
  }
  const contradictory = legacyInput('movistar-conflict', receivedAt, text +
    '\nSu pago por $ 75.000 del 29/09/2026 se aplicó correctamente a la cuenta 1234567891.', from, subject);
  const pending = filterAndResolve(contradictory, modelError);
  assert.equal(pending.status, 'pending');
  assert.deepEqual(pending.unconfirmedFields, ['amount', 'date']);
  const due = legacyInput('movistar-due', receivedAt, 'Total a pagar: COP 60.000.\nFecha de vencimiento: 28/09/2026.', from, subject);
  assert.equal(filterAndResolve(due, goodModel), undefined);
  const unauthenticated = legacyInput('movistar-unverified', receivedAt, text, from, subject, ['INBOX'], false);
  assert.notEqual(filterAndResolve(unauthenticated, goodModel)?.status, 'registered');
  const home = legacyInput('movistar-home', receivedAt, text + '\nServicio: Internet residencial.', from, subject);
  const filteredHome = runCode('Filtrar y proteger aviso', home)[0].json;
  assert.equal(filteredHome.modelInput, null);
  assert.equal(filteredHome.local.movement.category, 'vivienda');
});

test('both Gmail paths save the purchase time and masked debit card for the supplied format', () => {
  const receivedAt = '2026-11-11T16:20:00.000Z';
  const from = 'alertasynotificaciones@an.notificacionesbancolombia.com';
  const direct = legacyInput('banco-direct', receivedAt, bankPurchase, 'tarjeta@bancolombia.example', bankPurchaseSubject);
  const oauth = oauthInput({
    deliveryId: randomUUID(), attemptId: randomUUID(), messageId: 'banco-oauth', receivedAt,
    labels: ['INBOX'], from, subject: bankPurchaseSubject, text: bankPurchase,
  });
  const model = { ...goodModel, amountMinor: '3075000', description: 'MERCADO DEL BUENO', paymentMethod: 'Bancolombia',
    category: 'alimentacion', evidence: { ...goodModel.evidence, category: 'MERCADO DEL' } };
  for (const [input, provider] of [[direct, 'bancolombia'], [oauth, 'bancolombia']] as const) {
    const result = filterAndResolve(input, model);
    assert.equal(result.status, 'registered');
    assert.equal(result.provider, provider);
    assert.deepEqual(result.movement, {
      amountMinor: '3075000', currency: 'COP', date: '2026-11-10', dateSource: 'reported', transactionTime: '14:42',
      paymentMethod: 'Tarjeta', cardType: 'debit', cardLast4: '1234', reportedInstitution: 'bancolombia',
      description: 'MERCADO DEL BUENO', category: 'otros', direction: 'expense',
    });
    assert.ok(gmailResult.safeParse(result).success);
    const { transactionTime, cardType, cardLast4, reportedInstitution, ...legacyMovement } = result.movement;
    assert.ok(gmailResult.safeParse({ ...result, movement: legacyMovement }).success);
    assert.ok(!gmailResult.safeParse({ ...result, movement: { ...result.movement, cardLast4: '4111111111111111' } }).success);
    const [{ json }] = runCode('Filtrar y proteger aviso', input);
    assert.match(json.notice.body, /T\.Deb \[identificador\]/);
    assert.doesNotMatch(json.notice.body, /1234/);
  }
});

test('optional Gmail details use literal payment and time evidence', () => {
  const receivedAt = '2026-11-11T16:20:00.000Z';
  const model = { ...goodModel, amountMinor: '3075000', description: 'MERCADO DEL BUENO', category: 'otros',
    evidence: { ...goodModel.evidence, category: null } };
  const cases = [
    ['con tu T.Créd. •••• 0068, el 10/11/2026 a las 2:42:08 p. m.', 'Tarjeta', 'credit', '0068', '14:42:08'],
    ['con tarjeta de débito XXXX-4455, el 10/11/2026 a las 12:04am', 'Tarjeta', 'debit', '4455', '00:04'],
    ['con tarjeta de crédito 4111 1111 1111 1111, el 10/11/2026 a las 25:01', 'Tarjeta', 'credit', null, null],
    ['con T.Cred 4111.1111.1111.1111, el 10/11/2026', 'Tarjeta', 'credit', null, null],
    ['con tu T.Deb **** 1234 5678, el 10/11/2026', 'Tarjeta', 'debit', null, null],
    ['con PSE, el 10/11/2026. Hora de la transacción: 8:05. Recibido a las 11:20.', 'PSE', null, null, '08:05'],
    ['mediante transferencia a las 14:42 del 10/11/2026', 'Transferencia', null, null, '14:42'],
    ['vía Nequi, el 10/11/2026', 'Nequi', null, null, null],
    ['por PSE o Nequi el 10/11/2026 a las 14:42. Hora de la compra: 15:01.', null, null, null, null],
    ['con PSE el 10/11/2026 a las 14:42 o a las 14:43', 'PSE', null, null, null],
    ['con tarjeta débito *1234 o tarjeta crédito *9876, el 10/11/2026', 'Tarjeta', null, null, null],
    ['el 10/11/2026. Recibido el 11/11/2026 a las 11:20. Cuenta *9999.', null, null, null, null],
  ] as const;
  for (const [tail, method, subtype, suffix, time] of cases) {
    const input = legacyInput('bank-variant', receivedAt, 'Compraste $30.750,00 en MERCADO DEL BUENO ' + tail,
      'tarjeta@bancolombia.example', bankPurchaseSubject);
    const result = filterAndResolve(input, model);
    assert.equal(result.status, 'registered', tail);
    assert.deepEqual(
      [result.movement.paymentMethod, result.movement.cardType, result.movement.cardLast4, result.movement.transactionTime],
      [method, subtype, suffix, time], tail,
    );
    assert.ok(gmailResult.safeParse(result).success, tail);
    const [{ json }] = runCode('Filtrar y proteger aviso', input);
    assert.doesNotMatch(json.notice.body, /0068|4455|4111|1111|1234|5678|9876|9999/, tail);
  }
});

test('Gmail direct retains its retry ID until NestJS confirms, including HTTP failures', () => {
  const references = { 'Preparar resultado para NestJS': [
    wrap({ retryId: 4, result: { status: 'registered', source: 'legacy' } }), wrap({ retryId: 5, result: { status: 'registered', source: 'legacy' } }),
    wrap({ retryId: 6, result: { status: 'registered', source: 'legacy' } }),
  ], '¿Reintentar callback temporal?': [
    wrap({ statusCode: 500 }), wrap({ error: 'timed out' }), wrap({ statusCode: 200 }),
  ] };
  const responses = [
    wrap({ statusCode: 500, body: { outcome: 'stored' } }), wrap({ error: 'timed out' }),
    wrap({ statusCode: 200, body: { outcome: 'duplicate' } }),
  ];
  const confirmed = runCode('Confirmar entrega del Gmail directo', responses, references);
  assert.deepEqual(confirmed.map(item => [item.json.retryId, item.json.clear]), [[4, false], [5, false], [6, true]]);
  const next = runCode('Continuar lote', responses);
  assert.deepEqual(next.map(item => item.pairedItem.item), [0, 1, 2]);
  // An ignored direct notice has no callback. It must still advance the next message in the batch.
  const discard = flow.connections['¿Descartado del Gmail directo?'].main;
  assert.ok(discard[0].some(edge => edge.node === 'Quitar ID resuelto'));
  assert.deepEqual(flow.connections['Quitar ID resuelto'].main[0].map(edge => edge.node), ['Continuar lote']);
  assert.ok(flow.connections['Continuar lote'].main[0].some(edge => edge.node === 'Procesar avisos uno a uno'));
});

test('registers Agaval as Compras through Gmail direct and OAuth with no invented payment method', () => {
  const receivedAt = '2026-11-10T17:01:00.000Z';
  const direct = legacyInput('agaval-legacy', receivedAt, agaval, shopSender, agavalSubject);
  const oauth = oauthInput({
    deliveryId: randomUUID(), attemptId: randomUUID(), messageId: 'agaval-oauth', receivedAt,
    labels: ['INBOX'], from: shopSender, subject: agavalSubject, text: agaval,
  });
  for (const input of [direct, oauth]) {
    const result = filterAndResolve(input, agavalModel);
    assert.equal(result.status, 'registered');
    assert.equal(result.provider, 'other');
    assert.deepEqual(result.movement, { ...agavalMovement, dateSource: 'reported' });
    assert.ok(gmailResult.safeParse(result).success);
  }
  const receiptWithoutTime = legacyInput('agaval-without-time', receivedAt, agaval.replace(' a las 12:00pm', ''), shopSender, agavalSubject);
  assert.deepEqual(filterAndResolve(receiptWithoutTime, { ...agavalModel, description: 'Pago de ropa en Agaval' }).movement,
    { ...agavalMovement, dateSource: 'reported', description: 'almacenes Agaval', transactionTime: null });
  assert.equal(filterAndResolve(direct, null).status, 'registered');
  const subjectOnly = legacyInput('subject-only', receivedAt, '', shopSender, agavalSubject);
  assert.equal(filterAndResolve(subjectOnly, agavalModel).status, 'pending');
  const canceled = legacyInput('canceled', receivedAt, agaval + ' Tu pago fue cancelado.', shopSender, agavalSubject);
  assert.equal(filterAndResolve(canceled, agavalModel), undefined);
  const notTransaction = {
    ...uncertainModel, classification: 'not_transaction',
  };
  assert.equal(filterAndResolve(direct, notTransaction).status, 'registered');
  const contradictory = legacyInput('contradictory', receivedAt,
    'Pagaste COP 50.000 y transferiste COP 60.000 el 10/11/2026.', shopSender, agavalSubject);
  assert.ok(filterAndResolve(contradictory, notTransaction).unconfirmedFields.includes('amount'));
  assert.equal(filterAndResolve(subjectOnly, notTransaction).status, 'pending');
  const discarded = filterAndResolve(oauthInput({
    ...oauth[0].json.identity, labels: ['TRASH'], from: shopSender, subject: agavalSubject, text: '',
  }), notTransaction);
  assert.equal(discarded.status, 'ignored');
  assert.ok(gmailResult.safeParse(discarded).success);
});

test('uses literal evidence for categories and gives the purchase concept in the body priority', () => {
  const receivedAt = '2026-11-10T17:01:00.000Z';
  const extract = (body: string, subject: string, model = agavalModel) =>
    filterAndResolve(legacyInput('category', receivedAt, body, shopSender, subject), model).movement;
  assert.equal(extract(agaval, 'Confirmación de pago', agavalModel).category, 'otros');
  assert.equal(extract(agaval, 'Confirmación de pago', {
    ...agavalModel, evidence: { ...agavalModel.evidence, category: 'almacenes Agaval' },
  }).category, 'otros');
  assert.equal(extract(agaval + ' Concepto: medicamentos.', agavalSubject).category, 'salud');
  assert.equal(extract(agaval + '\nDescripción\tmedicamentos', agavalSubject).category, 'salud');
  assert.equal(extract(agaval + ' Producto: botas de senderismo.', 'Pago confirmado', {
    ...agavalModel, evidence: { ...agavalModel.evidence, category: 'botas de senderismo' },
  }).category, 'otros');
  assert.equal(extract(agaval + ' Conceptos: calzado y medicamentos.', agavalSubject).category, 'otros');
  for (const [text, currency] of [['EUR 50.000', 'EUR'], ['50.000 USD', 'USD'], ['50.000. Moneda: USD.', 'USD']]) {
    assert.equal(extract(agaval.replace('COP 50.000', text), agavalSubject, { ...agavalModel, currency,
      evidence: { ...agavalModel.evidence, amountMinor: text.split('. Moneda')[0], currency } }).currency, currency);
  }
});

test('the agent tool applies the local rules and leaves conflicting amounts unresolved', () => {
  const tool = flow.nodes.find(n => n.name === 'consultar_reglas_aviso')!;
  const runTool = new Function('query', tool.parameters.jsCode);
  const excerpt = 'Compraste USD 12.50 el 10/11/2026 en Farmacia Demo con tarjeta.';
  const checked = JSON.parse(runTool({ provider: 'bancolombia', excerpt, toolCallId: 'synthetic-context' }));
  assert.deepEqual(checked, {
    amountMinor: '1250', currency: 'USD', date: '2026-11-10', direction: 'expense', paymentMethod: 'Tarjeta', categoryHint: 'salud',
  });
  const conflicting = JSON.parse(runTool({ provider: 'bancolombia', excerpt: excerpt + ' Valor de la compra USD 20.00.' }));
  assert.equal(conflicting.amountMinor, null);
  assert.deepEqual(JSON.parse(runTool({ provider: 'bancolombia', excerpt: 'x'.repeat(321) })), { error: 'invalid_excerpt' });
});

test('checks repeated fields before the model and preserves conflicts in the final result', () => {
  const receivedAt = '2026-11-10T17:01:00.000Z';
  const body = 'Pagaste COP 25.000 en Restaurante Demo el 10/11/2026.\nValor de la compra: COP 30.000. ' +
    'Fecha del pago: 11/11/2026.';
  const input = legacyInput('conflicting-operation', receivedAt, body);
  const checked = runCode('Filtrar y proteger aviso', input)[0].json.modelInput;
  assert.ok(Object.hasOwn(checked, 'ruleCheck'));
  assert.deepEqual([checked.ruleCheck.amountMinor, checked.ruleCheck.date, checked.ruleCheck.direction], [null, null, 'expense']);
  const resolved = filterAndResolve(input, goodModel);
  assert.equal(resolved.status, 'pending');
  assert.deepEqual(resolved.unconfirmedFields, ['amount', 'date']);
  const distant = legacyInput('distant-date', receivedAt,
    'Pagaste COP 25.000 en Restaurante Demo el 10/11/2026.\n' + 'Texto informativo '.repeat(24) + '\nFecha del pago: 11/11/2026.');
  const distantInput = runCode('Filtrar y proteger aviso', distant)[0].json.modelInput;
  assert.equal(distantInput.ruleCheck, null);
  assert.equal(distantInput.verified.date, null);
});

test('agent JSON stays paired, literal movements survive model failure and unresolved notices reject malformed output', () => {
  const receivedAt = '2026-11-10T13:00:00.000Z';
  const direct = legacyInput('first', receivedAt);
  const usd = legacyInput('second', receivedAt, 'Compraste USD 12.50 el 10/11/2026 en Farmacia Demo con tarjeta.',
    'tarjeta@bancolombia.example', 'Compra con tarjeta');
  const unresolved = legacyInput('third', receivedAt,
    'Pagaste COP 25.000 o COP 30.000 el 10/11/2026.');
  const filtered = runCode('Filtrar y proteger aviso', [...direct, ...usd, ...unresolved]);
  assert.equal(filtered[2].json.local, null);
  const outputs = [wrap({ output: JSON.stringify(goodModel) }), wrap({ output: 'invalid JSON' }), wrap({ output: 'invalid JSON' })];
  const results = runCode('Preparar resultado para NestJS', outputs, { 'Filtrar y proteger aviso': filtered });
  assert.deepEqual(results.map(({json}) => [json.result.messageId, json.result.movement?.amountMinor ?? json.result.reason]), [
    ['first', '2500000'], ['second', '1250'], ['third', 'invalid_model_output'],
  ]);
  assert.equal(readGmailModel({ ...goodModel, amountMinor: 2500000 }), null);
});

test('requires quotes that prove the current English payment and the role of each value', () => {
  const receivedAt = '2026-11-10T14:00:00.000Z';
  const input = legacyInput('new-english-receipt', receivedAt,
    'Your payment was completed.\nItem: hiking boots\n' +
    'Subtotal: USD 20.00\nFee: USD 2.00\nTotal paid: USD 22.00\n' +
    'Issue date: 2026-11-07\nPayment date: 2026-11-10\nDue date: 2026-11-28\n' +
    'Previous attempt: payment declined\nContact the hospital office for accessibility assistance.',
    shopSender, 'Receipt');
  const model = { ...uncertainModel, classification: 'completed', amountMinor: '2200',
    currency: 'USD', date: '2026-11-10', direction: 'expense', category: 'compras', description: 'hiking boots',
    evidence: { ...uncertainModel.evidence, classification: 'Your payment was completed', amountMinor: 'Total paid: USD 22.00',
      currency: 'USD', date: 'Payment date: 2026-11-10', direction: 'Your payment was completed',
      category: 'hiking boots', description: 'Item: hiking boots' },
  };
  const result = filterAndResolve(input, model);
  assert.equal(result.status, 'registered');
  assert.equal(result.movement.category, 'otros');
  assert.equal(result.movement.amountMinor, '2200');
  assert.equal(result.movement.date, '2026-11-10');
  const notice = runCode('Filtrar y proteger aviso', input)[0].json.notice;
  const modelOnly = (value: unknown) => resolveGmailExtraction(notice, readGmailModel(value), false, undefined, receivedAt);
  const quoted = modelOnly(model);
  assert.equal(quoted.status, 'registered');
  assert.ok('movement' in quoted);
  assert.equal(quoted.movement.category, 'compras');
  for (const evidence of [
    { amountMinor: 'Subtotal: USD 20.00' }, { date: 'Issue date: 2026-11-07' },
    { direction: 'Previous attempt: payment declined' }, { currency: 'EUR' },
  ]) {
    const pending = modelOnly({ ...model, evidence: { ...model.evidence, ...evidence } });
    assert.equal(pending.status, 'pending');
    assert.ok('evidence' in pending);
    assert.equal(pending.evidence.amountMinor, '2200');
    assert.equal(filterAndResolve(input, { ...model, evidence: { ...model.evidence, ...evidence } }).status, 'registered');
  }
  const incidental = modelOnly({ ...model, category: 'salud',
    evidence: { ...model.evidence, category: 'hospital' } },
  );
  assert.ok('movement' in incidental);
  assert.equal(incidental.movement.category, 'otros');
});

