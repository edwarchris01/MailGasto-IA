import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { gmailModelSchema } from '../src/mail-rules.ts';
import { gmailClassifierCases } from './gmail-classifier-cases.mjs';
import { installWorkflows, localModel, n8nWebhook, oauthTestWorkflow, testCredentials,
  waitFor, waitForProtectedHook } from './n8n-isolated.mjs';

const { values: options } = parseArgs({ options: { corpus: { type: 'string' }, case: { type: 'string', multiple: true } } });
const corpus = options.corpus ? JSON.parse(readFileSync(options.corpus, 'utf8')) : gmailClassifierCases;
const cases = options.case ? corpus.filter(row => options.case.includes(row.id)) : corpus;
assert(Array.isArray(cases) && cases.length > 0, 'Se requiere un corpus etiquetado');
assert.equal(new Set(cases.map(row => row.id)).size, cases.length, 'Los IDs de casos deben ser únicos');
if (options.case) assert.equal(cases.length, new Set(options.case).size, 'Todos los IDs solicitados deben existir en el corpus');

const callbackPort = 3117;
const credentials = testCredentials('mailgastocmp');
const classifiers = ['agent', 'chain'];
const callbacks = new Map();
const server = createServer(async (request, response) => {
  if (request.url !== '/result' || request.method !== 'POST' ||
      request.headers['x-mailgasto-ingest'] !== credentials.ingestKey) {
    response.writeHead(403).end();
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { result, attempted, validJson, toolCalls, modelCheck } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!callbacks.has(result.messageId)) callbacks.set(result.messageId, {
      result, attempted, validJson, toolCalls, modelCheck, received: performance.now(),
    });
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"outcome":"stored"}');
  } catch {
    response.writeHead(400).end();
  }
});

function pathFor(classifier) {
  return 'mailgasto-private-gmail-compare-' + classifier;
}

function checkModelOutput(item, input, schema) {
  if (!item || item.error) return { parsed: false, nodeError: true };
  let value = item.output ?? item.text ?? item;
  if (Array.isArray(value)) value = value.filter(part => part?.type === 'text').map(part => part.text).join('');
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return { parsed: false }; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { parsed: false };
  const keys = schema.required;
  const evidenceKeys = schema.properties.evidence.required;
  const evidence = value.evidence ?? {};
  const invalid = (entry, field) => {
    const types = Array.isArray(field.type) ? field.type : [field.type];
    const type = entry === null ? 'null' : typeof entry;
    return !types.includes(type) || field.enum && !field.enum.includes(entry) ||
      typeof entry === 'string' && (field.pattern && !new RegExp(field.pattern).test(entry) ||
        field.maxLength && entry.length > field.maxLength || field.minLength && entry.trim().length < field.minLength);
  };
  return { parsed: true,
    missing: keys.filter(key => !Object.hasOwn(value, key)),
    extraKeys: Object.keys(value).filter(key => !keys.includes(key)).length,
    invalidValues: keys.filter(key => key !== 'evidence' && Object.hasOwn(value, key) && invalid(value[key], schema.properties[key])),
    missingCitations: evidenceKeys.filter(key => !Object.hasOwn(evidence, key)),
    invalidCitationValues: evidenceKeys.filter(key => Object.hasOwn(evidence, key) &&
      (invalid(evidence[key], schema.properties.evidence.properties[key]) || value[key] === null && evidence[key] !== null)),
    nonliteralCitations: evidenceKeys.filter(key => typeof evidence[key] === 'string' &&
      ![input?.subject, input?.body].some(text => typeof text === 'string' && text.includes(evidence[key]))),
    numericalAmount: typeof value.amountMinor === 'number',
  };
}

function benchmarkFlow(classifier) {
  const flow = oauthTestWorkflow({ classifier, path: pathFor(classifier), credentials, senderJson: '{}',
    resultUrl: 'http://host.docker.internal:' + callbackPort + '/result' });
  const agent = flow.nodes.find(node => node.name === 'Clasificar aviso con AI Agent');
  if (agent) agent.parameters.options.returnIntermediateSteps = true;
  const prepare = flow.nodes.find(node => node.name === 'Preparar resultado para NestJS');
  prepare.parameters.jsCode = 'const checkModelOutput = ' + checkModelOutput.toString() + ';\n' +
    'const schema = ' + JSON.stringify(gmailModelSchema) + ';\n' +
    'const outcomes = (() => {\n' + prepare.parameters.jsCode + '\n})();\n' +
    'return outcomes.map((row, index) => { ' +
    "const { modelInput } = $('Filtrar y proteger aviso').itemMatching(index).json; " +
    'const raw = $input.all()[index]?.json; ' +
    'return { ...row, json: { ...row.json, toolCalls: raw?.intermediateSteps?.length ?? 0, ' +
    'modelCheck: modelInput ? checkModelOutput(raw, modelInput, schema) : null } }; });';
  for (const node of flow.nodes.filter(node => node.type === 'n8n-nodes-base.httpRequest' &&
      node.parameters.jsonBody === '={{ JSON.stringify($json.result) }}')) {
    node.parameters.jsonBody = '={{ JSON.stringify({result: $json.result, attempted: $json.modelAttempted, ' +
      'validJson: $json.agentOutputValid, toolCalls: $json.toolCalls, modelCheck: $json.modelCheck}) }}';
  }
  return { ...flow, id: 'mailgastocmp-' + classifier, name: 'MailGasto benchmark local · ' + classifier };
}

async function measure(row, classifier) {
  const messageId = 'bench-' + randomUUID();
  const headers = { 'X-MailGasto-Agent': credentials.agentKey, 'Content-Type': 'application/json' };
  const notice = { deliveryId: randomUUID(), attemptId: randomUUID(), messageId,
    receivedAt: row.receivedAt, labels: row.labels ?? ['INBOX'], from: row.from, subject: row.subject,
    text: row.text, authenticated: row.authenticated ?? true };
  const started = performance.now();
  const response = await fetch(n8nWebhook + '/' + pathFor(classifier), {
    method: 'POST', headers, body: JSON.stringify(notice), signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 202, row.id + ' · ' + classifier);
  let outcome;
  try {
    outcome = await waitFor(row.id + ' · ' + classifier, () => callbacks.get(messageId), 165);
  } catch {
    return { id: row.id, expected: row.expected.status, status: 'timeout', attempted: null, validJson: null,
      toolCalls: null, elapsedMs: Math.round(performance.now() - started),
      mismatches: Object.keys(row.expected.fields ?? {}), fields: Object.keys(row.expected.fields ?? {}).length };
  } finally {
    callbacks.delete(messageId);
  }
  const { result, attempted, validJson, toolCalls, modelCheck, received } = outcome;
  assert.deepEqual([result.deliveryId, result.attemptId, result.messageId, result.receivedAt],
    [notice.deliveryId, notice.attemptId, notice.messageId, notice.receivedAt]);
  const expectedFields = Object.entries(row.expected.fields ?? {});
  const extracted = result.movement ?? result.evidence;
  return { id: row.id, expected: row.expected.status, status: result.status,
    ...(result.reason ? { reason: result.reason } : {}),
    attempted: Boolean(attempted), validJson: Boolean(validJson), toolCalls, modelCheck,
    elapsedMs: Math.round(received - started),
    mismatches: expectedFields.filter(([field, expected]) => extracted?.[field] !== expected).map(([field]) => field),
    fields: expectedFields.length };
}

function summarize(results) {
  const count = predicate => results.filter(predicate).length;
  const registered = count(row => row.status === 'registered');
  const correctlyRegistered = count(row => row.expected === 'registered' && row.status === 'registered' && row.mismatches.length === 0);
  const attempted = count(row => row.attempted);
  const fields = results.reduce((total, row) => total + row.fields, 0);
  const durations = results.map(row => row.elapsedMs).sort((a, b) => a - b);
  return {
    cases: results.length,
    autoSavePrecision: [correctlyRegistered, registered],
    autoSaveCoverage: [correctlyRegistered, count(row => row.expected === 'registered')],
    falseDiscards: count(row => row.expected !== 'ignored' && row.status === 'ignored'),
    correctFields: [fields - results.reduce((total, row) => total + row.mismatches.length, 0), fields],
    validJson: [count(row => row.attempted && row.validJson), attempted],
    parsedJson: [count(row => row.attempted && row.modelCheck?.parsed), attempted],
    correctStatus: [count(row => row.status === row.expected), results.length],
    toolCalls: results.reduce((total, row) => total + (row.toolCalls ?? 0), 0),
    p95Ms: durations[Math.ceil(0.95 * durations.length) - 1],
  };
}

server.listen(callbackPort, '127.0.0.1');
await once(server, 'listening');
try {
  installWorkflows(classifiers.map(benchmarkFlow), credentials);
  for (const classifier of classifiers) await waitForProtectedHook(pathFor(classifier));
  const outcomes = Object.fromEntries(classifiers.map(classifier => [classifier, []]));
  // Keep the prompt prefix stable within a variant so Ollama can reuse its local cache.
  for (const classifier of classifiers) {
    for (const row of cases) {
      const result = await measure(row, classifier);
      outcomes[classifier].push(result);
      console.log(JSON.stringify({ classifier, ...result }));
    }
  }
  console.log(JSON.stringify({ model: localModel, corpus: options.corpus ? 'reserved' : 'synthetic',
    metrics: Object.fromEntries(classifiers.map(classifier => [classifier, summarize(outcomes[classifier])])) }));
} finally {
  server.close();
}
