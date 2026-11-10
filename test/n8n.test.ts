import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { gmailResult } from '../src/gmail-results.js';
import { agaval, agavalModel, agavalMovement, agavalSubject, bank, bankSender, filterAndResolve, flow, goodModel,
  legacyInput, oauthInput, runCode, shopSender, wrap } from './pipeline.fixture.mjs';

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
  const modelInput = new Function('$json', 'return ' + expression)(filtered[1].json);
  assert.equal(agent.type, '@n8n/n8n-nodes-langchain.agent');
  assert.equal(agent.parameters.options.maxIterations, 2);
  assert.equal(model.parameters.model, 'qwen3.5:4b');
  assert.deepEqual(JSON.parse(modelInput), {
    provider: 'nequi', subject: 'Aviso de pago', body: filtered[1].json.notice.body,
  });
  assert.doesNotMatch(modelInput, /12345678901|https:|@example|oauth-fixture|deliveryId/);
  assert.ok(gmailResult.safeParse(filterAndResolve(direct)).success);
  assert.ok(gmailResult.safeParse(filterAndResolve(oauth)).success);
  assert.equal(filterAndResolve(legacyInput('spam', receivedAt, bank, bankSender, 'Aviso de pago', ['SPAM'])), undefined);
  const badModel = filterAndResolve(direct, { ...goodModel, amountMinor: '5000000' });
  assert.equal(badModel.status, 'pending');
  const card = filterAndResolve(legacyInput('card', receivedAt, 'Compraste USD 12.50 con tarjeta 1234 el 10/11/2026.',
    'tarjeta@bancolombia.example', 'Compra con tarjeta'), null);
  assert.equal(card.movement.paymentMethod, 'Tarjeta');
  assert.equal(card.movement.currency, 'USD');
});

test('Gmail direct retains its retry ID until NestJS confirms, including HTTP failures', () => {
  const references = { 'Preparar resultado para NestJS': [
    wrap({ retryId: 4, result: { status: 'registered' } }), wrap({ result: { status: 'ignored' } }),
    wrap({ retryId: 6, result: { status: 'registered' } }),
  ] };
  const responses = [
    wrap({ statusCode: 500, body: { outcome: 'stored' } }), wrap({ error: 'timed out' }),
    wrap({ statusCode: 200, body: { outcome: 'duplicate' } }),
  ];
  const confirmed = runCode('Confirmar entrega del Gmail directo', responses, references);
  assert.deepEqual(confirmed, [{ json: { retryId: 6 }, pairedItem: { item: 2 } }]);
  const next = runCode('Continuar lote', responses);
  assert.deepEqual(next.map(item => item.pairedItem.item), [0, 1, 2]);
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
    assert.deepEqual(result.movement, agavalMovement);
    assert.ok(gmailResult.safeParse(result).success);
  }
  assert.equal(filterAndResolve(direct, null).status, 'error');
  const subjectOnly = legacyInput('subject-only', receivedAt, '', shopSender, agavalSubject);
  assert.equal(filterAndResolve(subjectOnly, agavalModel).status, 'pending');
  const canceled = legacyInput('canceled', receivedAt, agaval + ' Tu pago fue cancelado.', shopSender, agavalSubject);
  assert.equal(filterAndResolve(canceled, agavalModel), undefined);
  const notTransaction = {
    ...agavalModel, classification: 'not_transaction', amountMinor: null, currency: null, date: null, direction: null,
  };
  assert.equal(filterAndResolve(direct, notTransaction).status, 'pending');
  const contradictory = legacyInput('contradictory', receivedAt,
    'Pagaste COP 50.000 y transferiste COP 60.000 el 10/11/2026.', shopSender, agavalSubject);
  assert.deepEqual(filterAndResolve(contradictory, notTransaction).unconfirmedFields, ['amount']);
  assert.equal(filterAndResolve(subjectOnly, notTransaction), undefined);
  const discarded = filterAndResolve(oauthInput({
    ...oauth[0].json.identity, labels: ['INBOX'], from: shopSender, subject: agavalSubject, text: '',
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
    ...agavalModel, categoryEvidence: 'almacenes Agaval',
  }).category, 'otros');
  assert.equal(extract(agaval + ' Concepto: medicamentos.', agavalSubject).category, 'salud');
  assert.equal(extract(agaval + ' Producto: botas de senderismo.', 'Pago confirmado', {
    ...agavalModel, categoryEvidence: 'botas de senderismo',
  }).category, 'compras');
  assert.equal(extract(agaval + ' Conceptos: calzado y medicamentos.', agavalSubject).category, 'otros');
  for (const [text, currency] of [['EUR 50.000', 'EUR'], ['50.000 USD', 'USD'], ['50.000. Moneda: USD.', 'USD']]) {
    assert.equal(extract(agaval.replace('50.000', text), agavalSubject, { ...agavalModel, currency }).currency, currency);
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

test('agent JSON stays paired with each notice and a malformed answer uses the rule fallback', () => {
  const receivedAt = '2026-11-10T13:00:00.000Z';
  const direct = legacyInput('first', receivedAt);
  const usd = legacyInput('second', receivedAt, 'Compraste USD 12.50 el 10/11/2026 en Farmacia Demo con tarjeta.',
    'tarjeta@bancolombia.example', 'Compra con tarjeta');
  const filtered = runCode('Filtrar y proteger aviso', [...direct, ...usd]);
  const fence = '`'.repeat(3);
  const outputs = [wrap({ output: fence + 'json\n' + JSON.stringify(goodModel) + '\n' + fence }), wrap({ output: 'invalid JSON' })];
  const results = runCode('Preparar resultado para NestJS', outputs, { 'Filtrar y proteger aviso': filtered });
  assert.deepEqual(results.map(({json}) => [json.result.messageId, json.result.movement.amountMinor, json.agentOutputValid]), [
    ['first', '2500000', true], ['second', '1250', false],
  ]);
});
