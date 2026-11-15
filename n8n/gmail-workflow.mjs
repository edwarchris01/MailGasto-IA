import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';
import { gmailClassifierPrompt } from '../src/gmail-prompt.ts';
import { categories, gmailModelSchema, gmailRuleExcerptLimit, paymentMethods, providers } from '../src/mail-rules.ts';

const messagePattern = /^[A-Za-z0-9_-]{1,200}$/;
const header = { name: 'MailGasto Agent Header' };
const callback = { name: 'MailGasto Ingest Header' };
const gmail = { id: 'Pv4g3lHVL76hD7a3', name: 'Gmail account' };
const ollama = { id: '84doF8LS0JZLF1T4', name: 'Ollama account 2' };
export const legacyTableName = 'MailGasto Gmail pendientes';
export const legacyColumns = { messageId: 'string', receivedAt: 'string', startedAt: 'string', retryAt: 'date', attempts: 'number' };
const inboxCode = readFileSync(new URL('../src/mail-rules.ts', import.meta.url), 'utf8').replace(/^export /gm, '');
const rules = ts.transpileModule(inboxCode, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const codeType = 'n8n-nodes-base.code';
const httpType = 'n8n-nodes-base.httpRequest';
const asItem = 'const output = (json, item) => ({ json, pairedItem: { item } });\n';
const ruleToolName = 'consultar_reglas_aviso';
const legacyMaxAttempts = 5;

function sendersFrom(value) {
  const parsed = JSON.parse(value ?? '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('BANK_SENDERS_JSON must be an object');
  const entries = Object.entries(parsed);
  if (entries.some(([address, provider]) => !/^(?:[a-z0-9._%+-]+)?@[a-z0-9.-]+\.[a-z]{2,}$/i.test(address) ||
      !['nequi', 'bancolombia'].includes(provider))) throw Error('BANK_SENDERS_JSON has an invalid sender or provider');
  return Object.fromEntries(entries.map(([address, provider]) => [address.toLowerCase(), provider]));
}

function serviceUrl(value, label) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw Error(label + ' must be a fixed HTTP(S) URL without credentials or query parameters');
  }
  return url.href.replace(/\/$/, '');
}

export function buildGmailWorkflow({
  tableId, agentCredential = header, resultCredential = callback, gmailCredential = gmail, modelCredential = ollama,
  senderJson = process.env.BANK_SENDERS_JSON, stage = process.env.MAILGASTO_STAGE === '1',
  resultUrl = process.env.MAILGASTO_RESULTS_URL || 'http://mailgasto-api:3105/v1/internal/gmail/results',
  classifier = process.env.MAILGASTO_GMAIL_CLASSIFIER || 'chain', legacyEnabled = false,
} = {}) {
  if (!['agent', 'chain'].includes(classifier)) throw Error('Unknown Gmail classifier: ' + classifier);
  const usesTool = classifier === 'agent';
  const prompt = gmailClassifierPrompt(categories, paymentMethods, usesTool ? ruleToolName : undefined);
  const senderMap = sendersFrom(senderJson);
  const table = { __rl: true, mode: tableId ? 'id' : 'name', value: tableId || legacyTableName };
  const node = (type, typeVersion, name, position, parameters, config = {}) => ({ type, typeVersion, name, position, parameters, ...config });
  const code = (name, position, jsCode) => node(codeType, 2, name, position, { mode: 'runOnceForAllItems', jsCode });
  const row = (name, position, operation, parameters, config) =>
    node('n8n-nodes-base.dataTable', 1, name, position, { resource: 'row', operation, dataTableId: table, ...parameters }, config);
  const condition = (keyName, keyValue, operator = 'eq') => ({ keyName, keyValue, condition: operator });
  const matching = (...conditions) => ({ matchType: 'allConditions', filters: { conditions } });
  const columns = value => ({ columns: {
    mappingMode: 'defineBelow', value, schema: Object.entries(legacyColumns).filter(([id]) => Object.hasOwn(value, id))
      .map(([id, type]) => ({ id, displayName: id, type, required: false, defaultMatch: false, display: true, canBeUsedToMatch: true })),
  } });
  const decision = (name, position, leftValue, rightValue) => node('n8n-nodes-base.if', 2.2, name, position, {
    conditions: {
      options: { version: 2, caseSensitive: true, typeValidation: 'strict', leftValue: '' },
      conditions: [{ leftValue, rightValue, operator: { type: 'string', operation: 'equals' } }],
      combinator: 'and',
    },
  });
  const noRedirect = { redirect: { redirect: { followRedirects: false } } };
  const gmailTrigger = node('n8n-nodes-base.gmailTrigger', 1.4, 'Gmail Trigger', [0, 0], {
    pollTimes: { item: [{ mode: 'everyMinute' }] }, simple: true, maxResults: 10, filters: { readStatus: 'both' },
  }, { credentials: { gmailOAuth2: gmailCredential }, disabled: stage || !legacyEnabled });
  const ids = code('Preparar IDs de Gmail', [240, 0], asItem + String.raw`
const now = Date.now();
return $input.all().flatMap((item, index) => {
  const { id, internalDate, sizeEstimate } = item.json;
  const time = new Date(/^\d+$/.test(String(internalDate)) ? Number(internalDate) : NaN);
  if (typeof id !== 'string' || !${messagePattern}.test(id) || !Number.isFinite(+time) ||
      Number(sizeEstimate) > 1125000) return [];
  return [output({
    messageId: id, receivedAt: time.toISOString(), startedAt: new Date(now).toISOString(),
    retryAt: new Date(now + 180000).toISOString(), attempts: 1
  }, index)];
});
`);
  const queue = row('Guardar ID para reintento', [480, 0], 'upsert', {
    ...matching(condition('messageId', '={{ $json.messageId }}')),
    ...columns(Object.fromEntries(Object.keys(legacyColumns).map(key => [key, '={{ $json.' + key + ' }}']))),
  }, { retryOnFail: true, maxTries: 3, waitBetweenTries: 1000 });
  const retry = node('n8n-nodes-base.scheduleTrigger', 1.2, 'Revisar entregas pendientes', [0, -240], {
    rule: { interval: [{ field: 'minutes', minutesInterval: 2 }] },
  }, { disabled: stage || !legacyEnabled });
  const now = '={{ $now.toISO() }}';
  const due = row('Buscar IDs pendientes', [240, -240], 'get', {
    ...matching(condition('retryAt', now, 'lt'), condition('attempts', legacyMaxAttempts, 'lt')),
    limit: 1, orderBy: true, orderByColumn: 'retryAt', orderByDirection: 'ASC',
  });
  const lease = row('Reservar reintentos', [480, -240], 'update', {
    ...matching(condition('id', '={{ $json.id }}'), condition('retryAt', now, 'lt'),
      condition('attempts', legacyMaxAttempts, 'lt')),
    ...columns({
      retryAt: '={{ $now.plus({ minutes: Math.min(15, 3 * 2 ** Math.min(3, $json.attempts - 1)) }).toISO() }}',
      attempts: '={{ $json.attempts + 1 }}',
    }),
  });
  const loop = node('n8n-nodes-base.splitInBatches', 3, 'Procesar avisos uno a uno', [720, 0], { batchSize: 1 });
  const prepareRead = code('Preparar lectura de Gmail', [960, 0], asItem + `
return $input.all().map(({json}, i) => output(json, i));
`);
  const read = node('n8n-nodes-base.gmail', 2.2, 'Leer cuerpo de Gmail', [960, 0], {
    resource: 'message', operation: 'get', messageId: '={{ $json.messageId }}',
    simple: false, options: { downloadAttachments: false },
  }, { credentials: { gmailOAuth2: gmailCredential }, onError: 'continueRegularOutput', alwaysOutputData: true });
  const readHeaders = node(httpType, 4.5, 'Leer cabeceras Gmail directo', [1080, 0], {
    method: 'GET',
    url: '={{ "https://gmail.googleapis.com/gmail/v1/users/me/messages/" + encodeURIComponent($("Preparar lectura de Gmail").item.json.messageId) }}',
    authentication: 'predefinedCredentialType', nodeCredentialType: 'gmailOAuth2',
    sendQuery: true, queryParameters: { parameters: [
      { name: 'format', value: 'metadata' }, { name: 'metadataHeaders', value: 'Authentication-Results' },
    ] },
    options: { ...noRedirect, timeout: 8000 },
  }, { credentials: { gmailOAuth2: gmailCredential }, onError: 'continueRegularOutput', alwaysOutputData: true });
  const legacy = code('Normalizar Gmail directo', [1200, 0], asItem + rules + `
return $input.all().map(({json: metadata}, i) => {
  const { id: retryId, messageId, receivedAt, startedAt, attempts } = $('Preparar lectura de Gmail').itemMatching(i).json;
  const mail = $('Leer cuerpo de Gmail').itemMatching(i).json;
  const identity = { source: 'legacy', messageId, receivedAt, startedAt };
  if (mail.id !== messageId) {
    const status = mail.error?.httpCode ?? mail.error?.statusCode ?? mail.error?.status ?? mail.statusCode;
    return output({ identity, retryId, attempts, legacyReadFailed: Number(status) !== 404,
      labels: [], from: '', subject: '', text: '' }, i);
  }
  if (metadata.id !== messageId) return output({ identity, retryId, attempts, legacyReadFailed: true }, i);
  const from = mail.from?.value?.length === 1 ? String(mail.from.value[0].address ?? '').slice(0, 320) : '';
  // The Gmail node's flattened headers keep only the last duplicate key. Use Gmail's ordered header array.
  const received = (Array.isArray(metadata.payload?.headers) ? metadata.payload.headers : [])
    .find(header => typeof header?.name === 'string' && header.name.toLowerCase() === 'authentication-results' &&
      typeof header.value === 'string' && /^\s*mx\.google\.com\s*;/i.test(header.value));
  return output({
    identity, retryId, attempts, labels: mail.labelIds ?? [],
    from, authenticated: hasGmailSenderAuthentication(received && 'Authentication-Results: ' + received.value.trimStart(), from),
    subject: String(mail.subject ?? '').slice(0, 1000), text: String(mail.text ?? '').slice(0, 30000)
  }, i);
});
`);
  const webhook = node('n8n-nodes-base.webhook', 2.1, 'Recibir Gmail vinculado', [960, 300], {
    httpMethod: 'POST', path: 'mailgasto-private-gmail', authentication: 'headerAuth', responseMode: 'responseNode',
    options: {},
  }, { webhookId: randomUUID(), ...(stage ? { disabled: true } : { credentials: { httpHeaderAuth: agentCredential } }) });
  const oauth = code('Normalizar Gmail OAuth', [1200, 300], asItem + String.raw`
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const items = $input.all();
const body = items[0]?.json.body;
const fits = (value, max) => typeof value === 'string' && value.length <= max;
const reject = () => {
  console.warn(JSON.stringify({ event: 'gmail_intake', source: 'oauth', status: 'rejected', reason: 'invalid_contract' }));
  return [output({ accepted: false }, 0)];
};
if (items.length !== 1 || !body || typeof body !== 'object' || Array.isArray(body)) return reject();
const { deliveryId, attemptId, messageId, receivedAt, labels, from, subject, text, authenticated, forwarded } = body;
if (!fits(deliveryId, 36) || !uuid.test(deliveryId) || !fits(attemptId, 36) || !uuid.test(attemptId) ||
    !fits(messageId, 200) || !${messagePattern}.test(messageId) || !fits(receivedAt, 24) || !iso.test(receivedAt) ||
    !Number.isFinite(Date.parse(receivedAt)) || new Date(receivedAt).toISOString().slice(0, 19) !== receivedAt.slice(0, 19) ||
    !Array.isArray(labels) || !labels.every(label => fits(label, 320)) ||
    !fits(from, 320) || !fits(subject, 1000) || !fits(text, 30000) || typeof authenticated !== 'boolean' ||
    (forwarded !== undefined && typeof forwarded !== 'boolean')) return reject();
return [output({ accepted: true, identity: { source: 'oauth', deliveryId, attemptId, messageId, receivedAt },
  labels, from, subject, text, authenticated, forwarded: forwarded === true }, 0)];
`);
  const respond = node('n8n-nodes-base.respondToWebhook', 1.4, 'Responder recepción Gmail', [1440, 300], {
    respondWith: 'noData', options: { responseCode: '={{ $json.accepted ? 202 : 400 }}' },
  });
  const accepted = decision('¿Entrega OAuth válida?', [1680, 300], '={{ $json.accepted ? "sí" : "no" }}', 'sí');
  const filter = code('Filtrar y proteger aviso', [1920, 80], asItem + rules + `
const senders = ${JSON.stringify(senderMap)};
const recognized = { ...gmailBankSenders, ...senders };
const ignored = new Set(gmailIgnoredLabels);
return $input.all().map(({json}, i) => {
  const { identity, retryId, attempts, legacyReadFailed, labels, from, subject, text, authenticated, forwarded } = json;
  const validIdentity = identity && typeof identity.messageId === 'string' && ${messagePattern}.test(identity.messageId) &&
    typeof identity.receivedAt === 'string' && Number.isFinite(Date.parse(identity.receivedAt));
  const filtered = validIdentity && !legacyReadFailed && Array.isArray(labels) && !labels.some(label => ignored.has(label)) &&
    typeof from === 'string' && typeof subject === 'string' && typeof text === 'string'
      ? candidate(from.slice(0, 320), subject.slice(0, 1000), text, recognized, authenticated === true && !forwarded,
        gmailReceivedDay(identity.receivedAt)) : null;
  const notice = filtered && forwarded ? { ...filtered, forwarded: true } : filtered;
  const verified = notice && inspectGmailNotice(notice);
  const reviewLocally = notice && (notice.unauthenticated || notice.format === 'avalpay' && notice.references?.length ||
    verified?.ownTransfer || verified?.walletPayout ||
    verified?.needsCreditReview || verified?.needsPurposeReview || verified?.refundPending);
  const localResult = reviewLocally || verified?.knownReceipt
    ? resolveGmailExtraction(notice, null, true, verified) : null;
  const local = reviewLocally || (localResult?.status === 'registered' && localResult.movement.category !== 'otros')
    ? localResult : null;
  const modelInput = notice && !local ? gmailModelInput(notice, verified) : null;
  return output({ identity, retryId, attempts, legacyReadFailed: legacyReadFailed || !validIdentity,
    authenticated: authenticated === true, notice, modelInput, local, startedProcessing: Date.now() }, i);
});
`);
  const isCandidate = decision('¿Es aviso de movimiento?', [2160, 80], '={{ $json.modelInput ? "aviso" : "ignorar" }}', 'aviso');
  const modelText = '={{ JSON.stringify($json.modelInput) }}';
  const classifierSettings = { onError: 'continueRegularOutput' };
  const ask = usesTool ? node('@n8n/n8n-nodes-langchain.agent', 3.1, 'Clasificar aviso con AI Agent', [2400, -80], {
    promptType: 'define',
    text: modelText,
    options: {
      systemMessage: prompt, maxIterations: 2, returnIntermediateSteps: false,
      enableStreaming: false, autoSaveHighlightedData: false, passthroughBinaryImages: false, passthroughBinaryPdfs: false,
    },
  }, classifierSettings) : node('@n8n/n8n-nodes-langchain.chainLlm', 1.9, 'Clasificar aviso con Basic LLM Chain', [2400, -80], {
    promptType: 'define', text: modelText, hasOutputParser: true,
    messages: { messageValues: [{ type: 'SystemMessagePromptTemplate', message: prompt.replaceAll('{', '{{').replaceAll('}', '}}') }] },
    batching: { batchSize: 1 },
  }, classifierSettings);
  const model = node('@n8n/n8n-nodes-langchain.lmChatOllama', 1, 'Ollama Chat Model', [2340, 135], {
    model: 'qwen3.5:4b',
    options: { temperature: 0, format: 'json', think: false, numPredict: 900, numCtx: 4096, keepAlive: '30m' },
  }, { credentials: { ollamaApi: modelCredential }, onError: 'continueRegularOutput' });
  const modelAccessory = usesTool ? node('@n8n/n8n-nodes-langchain.toolCode', 1.3, ruleToolName, [2490, 135], {
    description: 'Consulta las reglas locales con el proveedor y un fragmento literal del aviso para verificar importe, moneda, fecha y categoría.',
    language: 'javaScript', specifyInputSchema: true, schemaType: 'manual',
    inputSchema: JSON.stringify({
      type: 'object',
      properties: {
        provider: { type: 'string', enum: providers },
        excerpt: { type: 'string', minLength: 1, maxLength: gmailRuleExcerptLimit },
      },
      required: ['provider', 'excerpt'],
    }),
    jsCode: rules + `
const { provider, excerpt } = query ?? {};
return JSON.stringify(checkGmailExcerpt(provider, excerpt));
`,
  }) : node('@n8n/n8n-nodes-langchain.outputParserStructured', 1.3, 'Analizar salida estructurada', [2490, 135], {
    schemaType: 'manual', inputSchema: JSON.stringify(gmailModelSchema),
  });
  const result = code('Preparar resultado para NestJS', [2640, -80], asItem + rules + String.raw`
const validModel = raw => {
  if (Array.isArray(raw)) {
    raw = raw.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('');
  }
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  return readGmailModel(raw);
};
return $input.all().map(({json}, i) => {
  const { identity, retryId, attempts, legacyReadFailed, authenticated, notice, local, modelInput, startedProcessing } =
    $('Filtrar y proteger aviso').itemMatching(i).json;
  const legacy = identity?.source === 'legacy';
  const modelAttempted = Boolean(modelInput);
  const model = modelAttempted && !json.error ? validModel(json.output ?? json.text ?? json) : null;
  let outcome;
  if (legacyReadFailed || !notice) outcome = { status: 'ignored' };
  else if (local) outcome = local;
  else if (model) outcome = resolveGmailExtraction(notice, model);
  else {
    const error = typeof json.error === 'string' ? json.error : json.error?.message;
    const invalidOutput = !json.error || /model output|output pars(?:er|ing)|failed to parse|invalid json|output format/i.test(error ?? '');
    const reason = invalidOutput ? 'invalid_model_output' : 'ollama_unavailable';
    outcome = legacy && attempts >= ${legacyMaxAttempts}
      ? { status: 'error', confidence: 0, reason: 'extractor_unavailable' }
      : { status: 'retry', reason };
  }
  const result = outcome.status === 'ignored' ? { ...identity, status: 'ignored' } : {
    ...identity, provider: notice.provider, forwarded: notice.forwarded, ...outcome,
    ...(legacy && authenticated ? { authenticated: true } : {}),
  };
  const legacyAction = !legacy ? null : legacyReadFailed || outcome.status === 'retry' ? 'retain'
    : outcome.status === 'ignored' ? 'clear' : 'callback';
  console.log(JSON.stringify({ event: 'gmail_classification', source: identity?.source, status: outcome.status,
    reason: legacyReadFailed ? 'gmail_read_failed' : outcome.reason, attempts, modelAttempted,
    modelOutputValid: Boolean(model), durationMs: Date.now() - startedProcessing }));
  return output({ retryId, attempts, legacyAction, modelAttempted, agentOutputValid: Boolean(model), result,
    callbackStartedAt: Date.now() }, i);
});
`);
  const discardLegacy = decision('¿Descartado del Gmail directo?', [2880, -80],
    '={{ $json.legacyAction ?? "enviar" }}', 'clear');
  const retainLegacy = decision('¿Conservar pendiente directo?', [3120, -80],
    '={{ $json.legacyAction ?? "enviar" }}', 'retain');
  const postResult = (name, position, jsonBody) => node(httpType, 4.5, name, position, {
    method: 'POST', url: serviceUrl(resultUrl, 'MAILGASTO_RESULTS_URL'),
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json', jsonBody,
    options: { ...noRedirect, timeout: 8000, response: { response: {
      fullResponse: true, neverError: true, responseFormat: 'text', outputPropertyName: 'body',
    } } },
  }, { onError: 'continueRegularOutput', alwaysOutputData: true,
    ...(stage ? { disabled: true } : { credentials: { httpHeaderAuth: resultCredential } }) });
  const post = postResult('Entregar resultado a NestJS', [3360, -80], '={{ JSON.stringify($json.result) }}');
  const needsRetry = decision('¿Reintentar callback temporal?', [3600, -80],
    '={{ $json.error || !$json.statusCode || $json.statusCode === 408 || $json.statusCode === 429 || $json.statusCode >= 500 ? "reintentar" : "resolver" }}',
    'reintentar');
  const retryPost = postResult('Reintentar resultado a NestJS', [3840, -200],
    '={{ JSON.stringify($("Preparar resultado para NestJS").item.json.result) }}');
  const confirm = code('Confirmar entrega del Gmail directo', [4080, -80], asItem + String.raw`
const failureReason = response => {
  const status = Number(response.statusCode);
  const error = typeof response.error === 'string' ? response.error : response.error?.message;
  if (status === 408 || !status && /timeout|timed out|ETIMEDOUT/i.test(error ?? '')) return 'callback_timeout';
  if (!status || status === 429 || status >= 500) return 'callback_unavailable';
  return 'callback_rejected';
};
return $input.all().flatMap(({json}, i) => {
  const { retryId, result, callbackStartedAt } = $('Preparar resultado para NestJS').itemMatching(i).json;
  const status = Number(json.statusCode);
  let body = json.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const terminal = status === 200 && (['stored', 'duplicate', 'discarded'].includes(body?.outcome) ||
    result.source === 'oauth' && result.status === 'ignored' && body?.outcome === 'ignored');
  const scheduled = status === 200 && body?.outcome === 'retry_scheduled';
  const first = $('¿Reintentar callback temporal?').itemMatching(i).json;
  const retried = Boolean(first.error || !first.statusCode || first.statusCode === 408 || first.statusCode === 429 || first.statusCode >= 500);
  console.log(JSON.stringify({ event: 'gmail_callback', source: result.source, status: terminal || scheduled ? body.outcome : 'failed',
    reason: terminal || scheduled ? null : failureReason(json), retried, retryReason: retried ? failureReason(first) : null,
    durationMs: Date.now() - callbackStartedAt }));
  return result.source === 'legacy' ? [output({ retryId, clear: terminal && Number.isInteger(retryId) }, i)] : [];
});
`);
  const confirmed = decision('¿Se confirmó la entrega directa?', [4320, -80], '={{ $json.clear ? "sí" : "no" }}', 'sí');
  const clear = row('Quitar ID resuelto', [4560, 80], 'deleteRows', matching(condition('id', '={{ $json.retryId }}')),
    { onError: 'continueRegularOutput', alwaysOutputData: true, retryOnFail: true, maxTries: 2, waitBetweenTries: 1000 });
  const next = code('Continuar lote', [4560, 300], asItem + `
return $input.all().map((_, i) => output({ processed: true }, i));
`);

  const edges = [];
  function chain(start, ...next) {
    let [source, outputIndex] = Array.isArray(start) ? start : [start, 0];
    for (const target of next) { edges.push([source, target, outputIndex]); source = target; outputIndex = 0; }
  }
  chain(gmailTrigger, ids, queue, loop);
  chain(retry, due, lease, loop);
  chain([loop, 1], prepareRead, read, readHeaders, legacy, filter);
  chain(webhook, oauth, respond, accepted, filter);
  chain(filter, isCandidate, ask, result, discardLegacy, clear, next, loop);
  chain([isCandidate, 1], result);
  chain([discardLegacy, 1], retainLegacy, next);
  chain([retainLegacy, 1], post, needsRetry, retryPost, confirm, confirmed, clear);
  chain([needsRetry, 1], confirm);
  chain([confirmed, 1], next);
  const connections = {};
  for (const [source, target, index] of edges) {
    const main = (connections[source.name] ??= { main: [] }).main;
    while (main.length <= index) main.push([]);
    main[index].push({ node: target.name, type: 'main', index: 0 });
  }
  connections[model.name] = { ai_languageModel: [[{ node: ask.name, type: 'ai_languageModel', index: 0 }]] };
  const accessoryConnection = usesTool ? 'ai_tool' : 'ai_outputParser';
  connections[modelAccessory.name] = { [accessoryConnection]: [[{ node: ask.name, type: accessoryConnection, index: 0 }]] };
  return {
    name: 'MailGasto IA',
    nodes: [...new Set(edges.flatMap(([source, target]) => [source, target])), model, modelAccessory],
    connections,
    settings: {
      executionOrder: 'v1', executionTimeout: 150, saveDataErrorExecution: 'none', saveDataSuccessExecution: 'none',
      saveManualExecutions: false, saveExecutionProgress: false, availableInMCP: false,
    },
    active: false,
  };
}

function workflowLinks(flow) {
  return Object.entries(flow.connections).flatMap(([source, outputs]) =>
    Object.entries(outputs).flatMap(([connectionType, branches]) =>
      branches.flatMap((targets, sourceIndex) => (targets ?? []).map(({node: target, index: targetIndex}) =>
        ({ source, target, sourceIndex, targetIndex, connectionType })))));
}

export function gmailSdk(flow, id = 'mailgasto-gmail') {
  const index = new Map(flow.nodes.map((node, i) => [node.name, 'n' + i]));
  const links = workflowLinks(flow);
  const subnodes = links.filter(link => link.connectionType !== 'main');
  const factoriesByType = { ai_languageModel: 'languageModel', ai_tool: 'tool', ai_outputParser: 'outputParser' };
  const subnodeFactories = new Map(subnodes.map(link => [link.source, factoriesByType[link.connectionType]]));
  const ordered = [...flow.nodes.filter(node => subnodeFactories.has(node.name)), ...flow.nodes.filter(node => !subnodeFactories.has(node.name))];
  const factories = ordered.map(({type, typeVersion, webhookId, ...config}) => {
    const factory = subnodeFactories.get(config.name) ?? (/(?:gmailTrigger|scheduleTrigger|manualTrigger|webhook)$/.test(type) ? 'trigger' : 'node');
    const attached = subnodes.filter(link => link.target === config.name);
    const model = attached.find(link => link.connectionType === 'ai_languageModel');
    const tools = attached.filter(link => link.connectionType === 'ai_tool');
    const outputParser = attached.find(link => link.connectionType === 'ai_outputParser');
    let sdkConfig = JSON.stringify(config);
    if (model) {
      const attachedNodes = ['model:' + index.get(model.source)];
      if (tools.length) attachedNodes.push('tools:[' + tools.map(link => index.get(link.source)).join(',') + ']');
      if (outputParser) attachedNodes.push('outputParser:' + index.get(outputParser.source));
      sdkConfig = sdkConfig.slice(0, -1) + ',subnodes:{' + attachedNodes.join(',') + '}}';
    }
    return 'const ' + index.get(config.name) + ' = ' + factory + '({type:' + JSON.stringify(type) +
      ',version:' + typeVersion + ',config:' + sdkConfig + '});';
  });
  const chains = links.filter(link => link.connectionType === 'main').map(({source, target, sourceIndex}) => sourceIndex
    ? '.add(' + index.get(source) + '.output(' + sourceIndex + ').to(' + index.get(target) + '))'
    : '.add(' + index.get(source) + ').to(' + index.get(target) + ')');
  return factories.join('\n') + '\nexport default workflow(' + JSON.stringify(id) + ', ' + JSON.stringify(flow.name) + ')' + chains.join('') + ';';
}

const renamed = new Map([
  ['¿Es aviso bancario?', '¿Es aviso de movimiento?'],
  ['¿Llegó por webhook?', '¿Descartado del Gmail directo?'],
]);
const updatedName = name => renamed.get(name) ?? name;

function currentGmailNodes(flow, current) {
  const owned = new Set([...flow.nodes.map(n => n.name), 'Leer MIME original de Gmail',
    'Preparar aviso de Gmail', 'Entregar aviso a MailGasto', 'Clasificar con Ollama',
    'Clasificar aviso con AI Agent', ruleToolName, 'Clasificar aviso con Basic LLM Chain', 'Analizar salida estructurada',
    ...renamed.keys(), '¿Remitente sin verificar?']);
  if (!current.nodes.some(n => n.name === 'Gmail Trigger' && n.type === 'n8n-nodes-base.gmailTrigger') ||
      current.nodes.some(n => !owned.has(n.name))) throw Error('The export is not the MailGasto intake workflow');
  return new Map(current.nodes.map(node => [updatedName(node.name), node]));
}

export function gmailUpdateDefinition(flow, current) {
  const existing = currentGmailNodes(flow, current);
  const credentialSources = new Map([
    ['Leer cabeceras Gmail directo', 'Leer cuerpo de Gmail'],
    ['Reintentar resultado a NestJS', 'Entregar resultado a NestJS'],
  ]);
  return {
    name: current.name || flow.name,
    nodes: flow.nodes.map(node => {
      const previous = existing.get(node.name);
      const credentialNode = previous ?? existing.get(credentialSources.get(node.name));
      return {
        ...node, id: previous?.id ?? randomUUID(),
        ...(previous?.webhookId ? { webhookId: previous.webhookId } : {}),
        ...(node.credentials && credentialNode?.credentials ? { credentials: credentialNode.credentials } : {}),
        ...(node.name === 'Gmail Trigger' && previous ? { parameters: previous.parameters } : {}),
      };
    }),
    connections: flow.connections,
    settings: { ...current.settings, ...flow.settings },
  };
}

export function gmailOperations(flow, current) {
  const existing = currentGmailNodes(flow, current);
  flow = gmailUpdateDefinition(flow, current);
  const desired = new Map(flow.nodes.map(node => [node.name, node]));
  const currentLinks = workflowLinks(current);
  const desiredLinks = workflowLinks(flow);
  const remap = link => ({ ...link, source: updatedName(link.source), target: updatedName(link.target) });
  const remappedLinks = currentLinks.map(remap);
  const contains = (links, link) => links.some(other => isDeepStrictEqual(other, link));
  // Update nodes in place to preserve credentials and the trigger and webhook IDs.
  return [
    ...currentLinks.filter(link => desired.has(updatedName(link.source)) && desired.has(updatedName(link.target)) &&
      !contains(desiredLinks, remap(link))).map(link => ({ type: 'removeConnection', ...link })),
    ...current.nodes.filter(n => !desired.has(updatedName(n.name))).map(n => ({ type: 'removeNode', nodeName: n.name })),
    ...flow.nodes.flatMap(({onError, webhookId, alwaysOutputData, retryOnFail, maxTries, waitBetweenTries, ...node}) => {
      const previous = existing.get(node.name);
      if (previous && (previous.type !== node.type || previous.typeVersion !== node.typeVersion)) {
        throw Error('Unexpected node type or version: ' + previous.name);
      }
      const operations = [];
      if (!previous) operations.push({ type: 'addNode', node });
      else {
        if (previous.name !== node.name) operations.push({ type: 'renameNode', oldName: previous.name, newName: node.name });
        if (!isDeepStrictEqual(previous.parameters, node.parameters)) {
          operations.push({ type: 'updateNodeParameters', nodeName: node.name, parameters: node.parameters, replace: true });
        }
        if (Boolean(node.disabled) !== Boolean(previous.disabled)) {
          operations.push({ type: 'setNodeDisabled', nodeName: node.name, disabled: Boolean(node.disabled) });
        }
      }
      const settings = Object.fromEntries(Object.entries({ onError, alwaysOutputData, retryOnFail, maxTries, waitBetweenTries })
        .filter(([key, value]) => value !== undefined && previous?.[key] !== value));
      if (Object.keys(settings).length) operations.push({ type: 'setNodeSettings', nodeName: node.name, settings });
      return operations;
    }),
    ...desiredLinks.filter(link => !contains(remappedLinks, link)).map(link => ({ type: 'addConnection', ...link })),
    { type: 'setWorkflowSettings', settings: Object.fromEntries(Object.entries(flow.settings).filter(([key]) => key !== 'availableInMCP')) },
  ];
}
