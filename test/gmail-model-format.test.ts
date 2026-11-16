import assert from 'node:assert/strict';
import test from 'node:test';
import { gmailChainModelFormat } from '../n8n/gmail-model-format.mjs';
import { buildGmailWorkflow } from '../n8n/gmail-workflow.mjs';
import { gmailClassifierPrompt } from '../src/gmail-prompt.js';
import {
  candidate, categories, gmailBankSenders, gmailModelInput, gmailModelSchema, paymentMethods,
  readGmailModel, resolveGmailExtraction, type GmailNotice,
} from '../src/mail-rules.js';

const emptyEvidence = {
  classification: null, amountMinor: null, currency: null, date: null,
  direction: null, description: null, category: null, movementKind: null,
};
// Recorded outputs of the isolated three-item Ollama test, 2026-11-16. All inputs were synthetic.
// The ambiguous/negative answers are imperfect; the source guards must not trust their labels.
const recordedOutputs = [
  {
    classification: 'completed', amountMinor: '2500000', currency: 'COP', date: '2026-11-16',
    direction: 'expense', description: 'almuerzo', category: 'alimentacion', paymentMethod: 'Tarjeta',
    movementKind: 'payment', counterpartyRole: 'merchant',
    evidence: { classification: 'Pagaste', amountMinor: 'COP 25.000', currency: 'COP', date: '16/11/2026',
      direction: 'Pagaste', description: 'almuerzo.', category: 'almuerzo.', movementKind: null },
  },
  {
    classification: 'not_transaction', amountMinor: null, currency: null, date: null, direction: null,
    description: null, category: null, paymentMethod: null, movementKind: null, counterpartyRole: null,
    evidence: { ...emptyEvidence },
  },
  {
    classification: 'not_transaction', amountMinor: '1990000', currency: 'COP', date: null, direction: null,
    description: 'Google/Crunchyroll', category: 'ocio', paymentMethod: null, movementKind: 'declined',
    counterpartyRole: 'merchant',
    evidence: { ...emptyEvidence, amountMinor: '$19.900,00', currency: '$19.900,00' },
  },
];

function notice(body: string) {
  const parsed = candidate('pagos@tienda-demo.example', 'Recibo de pago', body, gmailBankSenders, true, '2026-11-16');
  assert.ok(parsed);
  return parsed;
}
const positive = notice('Pagaste COP 25.000 con tarjeta el 16/11/2026.\nConcepto: almuerzo.');
const ambiguous = notice('Pagaste COP 25.000 con tarjeta el 16/11/2026.\n' +
  'Valor de la compra: COP 30.000. Fecha del pago: 17/11/2026.');
const negative: GmailNotice = {
  provider: 'other', forwarded: false,
  subject: 'Faltan fondos para pagar en GOOGLE *Crunchyroll An',
  body: 'Tu compra por $19.900,00 se rechazó por falta de fondos en tu Cuenta.',
};

test('compact transport schema preserves the canonical contract and reduces prompt overhead', () => {
  const original = structuredClone(gmailModelSchema);
  const compact = gmailChainModelFormat();
  assert.deepEqual(compact.schema.required, original.required);
  assert.equal(compact.schema.additionalProperties, false);
  assert.deepEqual(Object.keys(compact.schema.properties), Object.keys(original.properties));
  for (const [name, property] of Object.entries(original.properties)) {
    const { enum: _enum, ...withoutEnum } = property as Record<string, unknown>;
    assert.deepEqual(compact.schema.properties[name], withoutEnum, name);
  }
  assert.deepEqual(compact.schema.properties.evidence, original.properties.evidence);
  const originalLength = gmailClassifierPrompt(categories, paymentMethods).length + JSON.stringify(original).length;
  assert.ok(compact.prompt.length + JSON.stringify(compact.schema).length < originalLength * 0.7);
  compact.schema.properties.classification.type = 'number';
  assert.deepEqual(gmailModelSchema, original);
  assert.equal(gmailChainModelFormat().schema.properties.classification.type, 'string');
});

test('only the OAuth Basic LLM Chain uses the compact format', () => {
  const compact = gmailChainModelFormat();
  assert.equal(gmailChainModelFormat({ source: 'legacy', classifier: 'chain' }), null);
  assert.equal(gmailChainModelFormat({ source: 'oauth', classifier: 'agent' }), null);
  assert.equal(gmailChainModelFormat({ source: 'oauth', classifier: 'chain', legacyEnabled: true }), null);
  for (const source of ['oauth', 'legacy']) {
    for (const classifier of ['chain', 'agent']) {
      const flow = buildGmailWorkflow({ source, classifier });
      const chain = flow.nodes.find(node => node.type === '@n8n/n8n-nodes-langchain.chainLlm');
      const agent = flow.nodes.find(node => node.type === '@n8n/n8n-nodes-langchain.agent');
      if (classifier === 'agent') {
        assert.equal(chain, undefined);
        assert.equal(agent.parameters.options.systemMessage,
          gmailClassifierPrompt(categories, paymentMethods, 'consultar_reglas_aviso'));
        continue;
      }
      assert.equal(agent, undefined);
      const expectedPrompt = source === 'oauth' ? compact.prompt : gmailClassifierPrompt(categories, paymentMethods);
      assert.equal(chain.parameters.messages.messageValues[0].message,
        expectedPrompt.replaceAll('{', '{{').replaceAll('}', '}}'));
      assert.equal(chain.parameters.text, '={{ JSON.stringify($json.modelInput) }}');
      assert.deepEqual(chain.parameters.batching, { batchSize: 1 });
      const parser = flow.nodes.find(node => node.type === '@n8n/n8n-nodes-langchain.outputParserStructured');
      assert.deepEqual(JSON.parse(parser.parameters.inputSchema), source === 'oauth' ? compact.schema : gmailModelSchema);
      if (source === 'oauth') assert.equal(parser.parameters.autoFix, false);
      else assert.equal(Object.hasOwn(parser.parameters, 'autoFix'), false);
      assert.ok(flow.nodes.some(node => node.type === 'n8n-nodes-base.code' &&
        node.parameters.jsCode.includes('return readGmailModel(raw)')));
    }
  }
});

test('a combined workflow with an active direct Gmail input retains its original shared format', () => {
  const flow = buildGmailWorkflow({ source: 'oauth', classifier: 'chain', legacyEnabled: true });
  // This compatibility input exists in the committed generator; the separate OAuth generator
  // no longer emits a Gmail trigger, so there is no direct source sharing its classifier there.
  if (!flow.nodes.some(node => node.type === 'n8n-nodes-base.gmailTrigger' && !node.disabled)) return;
  const chain = flow.nodes.find(node => node.type === '@n8n/n8n-nodes-langchain.chainLlm');
  assert.equal(chain.parameters.messages.messageValues[0].message,
    gmailClassifierPrompt(categories, paymentMethods).replaceAll('{', '{{').replaceAll('}', '}}'));
  const parser = flow.nodes.find(node => node.type === '@n8n/n8n-nodes-langchain.outputParserStructured');
  assert.deepEqual(JSON.parse(parser.parameters.inputSchema), gmailModelSchema);
});

test('recorded synthetic Ollama outputs resolve to registered, pending and ignored using real hints', () => {
  const input = gmailModelInput(positive);
  assert.equal(input.evidenceHints?.classification, 'Pagaste');
  assert.equal(input.evidenceHints?.amountMinor, 'COP 25.000');
  assert.equal(input.evidenceHints?.date, '16/11/2026');
  const ambiguousInput = gmailModelInput(ambiguous);
  assert.equal(ambiguousInput.verified.amountMinor, null);
  assert.equal(ambiguousInput.verified.date, null);
  assert.ok('ruleCheck' in ambiguousInput);
  const results = [positive, ambiguous, negative].map((source, index) => {
    const model = readGmailModel(recordedOutputs[index]);
    assert.ok(model);
    return resolveGmailExtraction(source, model);
  });
  assert.deepEqual(results.map(result => result.status), ['registered', 'pending', 'ignored']);
  const movement = results[0].status === 'registered' ? results[0].movement : null;
  assert.ok(movement);
  assert.deepEqual([movement.amountMinor, movement.currency, movement.date, movement.direction, movement.category],
    ['2500000', 'COP', '2026-11-16', 'expense', 'alimentacion']);
  // The model's unsupported negative label must not silently discard the ambiguous payment.
  assert.equal(results[1].status === 'pending' && results[1].reason, 'missing_or_ambiguous_fields');
  assert.equal(candidate('avisos@nu-demo.example', negative.subject, negative.body, gmailBankSenders, true, '2026-11-16'), null);
});

test('valid JSON without source evidence cannot register the unrecognized merchant', () => {
  for (const evidence of [
    { ...emptyEvidence },
    { ...recordedOutputs[0].evidence, amountMinor: 'COP 99.999' },
    { ...recordedOutputs[0].evidence, date: '17/11/2026' },
  ]) {
    const parsed = readGmailModel({ ...recordedOutputs[0], evidence });
    assert.ok(parsed);
    assert.equal(resolveGmailExtraction(positive, parsed).status, 'pending');
  }
  const parsed = readGmailModel(recordedOutputs[0]);
  assert.equal(resolveGmailExtraction({ ...positive, forwarded: true }, parsed, true).status, 'pending');
  assert.equal(resolveGmailExtraction({ ...positive, unauthenticated: true }, parsed, true).status, 'pending');
});

test('backend still rejects enum, type and exact-key violations omitted from transport guidance', () => {
  for (const key of ['classification', 'currency', 'direction', 'category', 'paymentMethod', 'movementKind', 'counterpartyRole']) {
    assert.equal(readGmailModel({ ...recordedOutputs[0], [key]: 'INVALID_ENUM' }), null, key);
  }
  assert.equal(readGmailModel({ ...recordedOutputs[0], amountMinor: 2500000 }), null);
  assert.equal(readGmailModel({ ...recordedOutputs[0], date: '2026-02-30' }), null);
  assert.equal(readGmailModel({ ...recordedOutputs[0], extra: true }), null);
  assert.equal(readGmailModel({ ...recordedOutputs[0], evidence: { ...recordedOutputs[0].evidence, extra: 'text' } }), null);
  assert.equal(readGmailModel({ ...recordedOutputs[0], evidence: { ...recordedOutputs[0].evidence, amountMinor: 'x'.repeat(161) } }), null);
});
