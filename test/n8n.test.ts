import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { gmailResult } from '../src/gmail-results.js';
import { bank, bankSender, filterAndResolve, flow, goodModel, legacyInput, oauthInput, runCode, wrap } from './pipeline.fixture.mjs';

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
  assert.deepEqual(JSON.parse(modelInput), { provider: 'nequi', text: filtered[1].json.notice.text });
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
  const next = runCode('Continuar lote', responses, references);
  assert.deepEqual(next.map(item => item.pairedItem.item), [0, 2]);
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
