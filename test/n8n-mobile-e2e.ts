import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { DateTime } from 'luxon';
import { Agent } from '../src/agent.js';
import { readConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { Gmail } from '../src/gmail.js';
import { createApp } from '../src/main.js';
import { Worker } from '../src/worker.js';
import { agaval, agavalSubject, bankPurchase, bankPurchaseSubject, shopSender } from './pipeline.fixture.mjs';
import { installWorkflows, localModel, n8nContainer, n8nWebhook, oauthTestWorkflow, testCredentials,
  waitFor, waitForProtectedHook } from './n8n-isolated.mjs';

const apiOrigin = 'http://localhost:3116';
const webhookPath = 'mailgasto-private-gmail';
const gmailWebhook = n8nWebhook + '/' + webhookPath;
const relayPort = 3118;
const mailpit = 'http://127.0.0.1:8026';
const gmailScope = 'https://www.googleapis.com/auth/gmail.readonly';
const sender = 'avisos@banco.example';
const password = 'synthetic-gmail-e2e-password';
const credentials = testCredentials('mailgastoe2e');
const { agentKey, ingestKey } = credentials;
const run = randomBytes(5).toString('hex');
const email = `gmail-e2e-${run}@example.test`;
const today = DateTime.now().setZone('America/Bogota');
const date = today.toISODate();
const classifier = process.env.MAILGASTO_E2E_CLASSIFIER;
const ollamaHost = process.env.MAILGASTO_E2E_OLLAMA_HOST ?? 'ollama';
assert(/^(?:ollama|ollama-qa-[a-z]+)$/.test(ollamaHost), 'Usa un Ollama local en la red aislada');
const deterministic = process.env.MAILGASTO_E2E_DETERMINISTIC === '1';
const invalidModelId = 'invalid-model-' + run;
const failedCallbackId = 'callback-retry-' + run;
const secondEqualPaymentId = 'same-amount-' + run;
const ignoredCallbackId = 'callback-ignored-' + run;
const modelSubject = 'RECUPERACION QA ' + run;
const noChargeSubject = 'QA NOTICE WITHOUT CHARGE';
const restaurant = 'Restaurante Vista';
const secondRestaurant = 'Restaurante Valle';
const paid = (name: string) => `Pagaste COP 21.500 en ${name} el ${date}.`;
const nequiReceipt = `Pagaste COP 25 en Restaurante QA el ${date} con Nequi.`;
const callback = { faultInjected: false, duplicateObserved: false, ignoredObserved: false,
  writes: 0, retries: [] as string[], modelRetryScheduled: false };
let sentInvalidOllamaJson = false;
let structuredOutput = false;

function relayOllama(path: string, method: string, body: Buffer) {
  const script = `
    const [host, path, method] = process.argv.slice(1);
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const response = await fetch('http://' + host + ':11434' + path, {
      method, ...(method === 'POST' ? {headers:{'Content-Type':'application/json'},body:Buffer.concat(chunks)} : {}),
      signal:AbortSignal.timeout(145000),
    });
    process.stdout.write(JSON.stringify([response.status, response.headers.get('content-type'), await response.text()]));
  `;
  return new Promise<[number, string, string]>((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', n8nContainer, 'node', '--input-type=module', '-e', script, ollamaHost, path, method],
      { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error('Falló Ollama de pruebas'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
    });
    child.stdin.end(body);
  });
}

function sampleModel(description?: string) {
  const nequi = description === 'Restaurante QA';
  const quote = nequi ? nequiReceipt : description ? paid(description) : null;
  return {
    classification: quote ? 'completed' : 'uncertain', amountMinor: nequi ? '2500' : quote ? '2150000' : null,
    currency: quote ? 'COP' : null, date: quote ? date : null, direction: quote ? 'expense' : null,
    description: description ?? null, category: quote ? 'alimentacion' : null, paymentMethod: nequi ? 'Nequi' : null,
    counterpartyRole: quote ? 'merchant' : null, movementKind: quote ? 'payment' : null,
    evidence: { classification: quote, amountMinor: quote, currency: quote, date: quote, direction: quote,
      description: description ?? null, category: description ?? null, movementKind: quote },
  };
}

const relay = createServer(async (request, response) => {
  const path = request.url ?? '';
  const method = request.method ?? '';
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (path === '/result' && method === 'POST' && request.headers['x-mailgasto-ingest'] === ingestKey) {
      const result = JSON.parse(body.toString('utf8'));
      const stored = await fetch(apiOrigin + '/v1/internal/gmail/results', {
        method, headers: { 'Content-Type': 'application/json', 'X-MailGasto-Ingest': ingestKey }, body,
      });
      const text = await stored.text();
      if (stored.ok) {
        const { outcome } = JSON.parse(text);
        if (result.messageId === ignoredCallbackId && result.status === 'ignored' && outcome === 'ignored') callback.ignoredObserved = true;
        if (outcome === 'retry_scheduled') {
          if (!callback.retries.includes(result.messageId)) callback.retries.push(result.messageId);
          if (result.messageId === invalidModelId) {
            assert.equal(result.reason, 'invalid_model_output');
            callback.modelRetryScheduled = true;
          }
        }
        if (result.messageId === failedCallbackId && result.status === 'registered') {
          if (outcome === 'stored') callback.writes += 1;
          if (outcome === 'duplicate') callback.duplicateObserved = true;
          if (!callback.faultInjected && outcome === 'stored') {
            // Simulate a response lost after NestJS committed the movement.
            callback.faultInjected = true;
            response.writeHead(503, { 'Content-Type': 'application/json' }).end('{"error":"synthetic_callback_failure"}');
            return;
          }
        }
      }
      response.writeHead(stored.status, { 'Content-Type': 'application/json' }).end(text);
      return;
    }
    if (method === 'POST' && path === '/api/chat') {
      const raw = body.toString('utf8');
      const message = raw.includes('RECUPERACION QA') ? modelSubject :
        [restaurant, secondRestaurant, 'Restaurante QA'].find(name => raw.includes(name));
      const reviewFixture = deterministic && (raw.includes('en almacenes Agaval') ||
        raw.includes('Pagaste COP 13.000 y transferiste COP 14.000'));
      const ignored = raw.includes(noChargeSubject);
      if (message || reviewFixture || ignored) {
        const invalid = message === modelSubject && !callback.modelRetryScheduled;
        sentInvalidOllamaJson ||= invalid;
        const sample = sampleModel(message === modelSubject ? undefined : message);
        if (ignored) {
          sample.classification = 'not_transaction';
          sample.evidence.classification = 'Payment requested.';
        }
        // The real Structured Output Parser v1.3 asks Ollama for an output wrapper.
        const reply = invalid ? '{"classification":' : JSON.stringify(structuredOutput ? { output: sample } : sample);
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson' }).end(JSON.stringify({
          model: localModel, created_at: new Date().toISOString(), done: true, done_reason: 'stop',
          message: { role: 'assistant', content: reply },
        }) + '\n');
        return;
      }
    }
    if (path === '/api/tags' && method === 'GET' || path === '/api/chat' && method === 'POST') {
      const [status, type, text] = await relayOllama(path, method, body);
      response.writeHead(status, { 'Content-Type': type ?? 'application/json' }).end(text);
      return;
    }
    response.writeHead(404).end();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Falló el relay aislado');
    response.writeHead(502).end();
  }
});

function provisionN8n() {
  const flow = oauthTestWorkflow({
    credentials, classifier, path: webhookPath, resultUrl: 'http://host.docker.internal:' + relayPort + '/result',
    senderJson: JSON.stringify({ [sender]: 'nequi' }),
  });
  structuredOutput = flow.nodes.some(node => node.type.endsWith('.outputParserStructured'));
  const chat = JSON.parse(execFileSync(process.execPath, ['n8n/workflows.mjs', 'agent'], { encoding: 'utf8' }));
  chat.settings.executionTimeout = 70;
  for (const node of chat.nodes) {
    if (node.type === 'n8n-nodes-base.webhook') node.credentials.httpHeaderAuth = credentials.agent;
    if (node.type.endsWith('.ollama')) {
      node.credentials.ollamaApi = credentials.model;
      node.parameters.modelId.value = localModel;
    }
  }
  const workflowIds = ['mailgastoe2egmail', 'mailgastoe2echat'];
  installWorkflows([flow, chat].map((workflow, index) => ({
    ...workflow, id: workflowIds[index], name: `${workflow.name} · E2E local`,
  })), credentials, { ollamaUrl: 'http://host.docker.internal:' + relayPort });
}

async function main() {
  const database = new URL(process.env.DATABASE_URL ?? '');
  assert(['localhost', '127.0.0.1'].includes(database.hostname), 'Usa un PostgreSQL local de pruebas');
  database.pathname = '/mailgasto_mobile_e2e';
  const config = readConfig({
    PUBLIC_URL: apiOrigin, PORT: '3116', DATABASE_URL: database.href,
    ENCRYPTION_KEY: randomBytes(32).toString('hex'), N8N_INGEST_KEY: ingestKey, N8N_AGENT_KEY: agentKey,
    N8N_GMAIL_WEBHOOK_URL: gmailWebhook, N8N_AGENT_URL: n8nWebhook, N8N_AGENT_TIMEOUT_MS: '30000',
    GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret',
    BANK_SENDERS_JSON: JSON.stringify({ [sender]: 'nequi' }),
    SMTP_URL: 'smtp://127.0.0.1:1026', SMTP_FROM: 'MailGasto QA <mailgasto@example.test>',
  });
  provisionN8n();
  const networkFetch = globalThis.fetch;
  const messages = {
    ['card-' + run]: bankPurchase.replace('10/11/2026', today.toFormat('dd/MM/yyyy')),
    [`registered-${run}`]: nequiReceipt + ' Cuenta 12345678901.',
    [`other-${run}`]: agaval.replace('10/11/2026', today.toFormat('dd/MM/yyyy')).replace(' a las 12:00pm', ''),
    [`movistar-${run}`]: `Su pago por $ 60.000 del ${today.toFormat('dd/MM/yyyy')} se aplicó correctamente a la cuenta 1234567891.\nServicio: Internet residencial.`,
    [`play-${run}`]: 'No pudimos usar la forma de pago Visa-4321.\nSe realizó un cargo en Mastercard-5678.\n' +
      'Fecha del pedido: ' + today.setLocale('es').toFormat("d LLL yyyy").replace('.', '') + ' 12:26:50 p.m. EDT\n' +
      'YouTube Premium (YouTube)\t$ 13.300 por mes\nTotal: $ 13.300 por mes\nForma de pago:\nMastercard-5678',
    [`pending-${run}`]: `Pagaste COP 13.000 y transferiste COP 14.000 el ${date}.`,
    [`ignored-${run}`]: 'Hola, mensaje personal de prueba.',
    [invalidModelId]: `Pagaste COP 13.000 o COP 14.000 el ${date}; la factura actual no distingue el importe cobrado.`,
    [failedCallbackId]: paid(restaurant),
    [secondEqualPaymentId]: paid(secondRestaurant),
    [ignoredCallbackId]: 'Details about the merchant statement. '.repeat(19) + '\nPayment requested. No money has been charged.',
  };
  let oauthChallenge: string | null = null;
  let receivedAt = 0;
  globalThis.fetch = async (resource, options) => {
    const url = new URL(String(resource));
    if (url.origin === 'https://oauth2.googleapis.com') {
      assert.equal(url.pathname, '/token');
      const form = options?.body as URLSearchParams;
      if (form.get('grant_type') === 'authorization_code') {
        const verifier = createHash('sha256').update(form.get('code_verifier')!).digest('base64url');
        assert.equal(verifier, oauthChallenge);
        assert.equal(form.get('code'), 'synthetic-grant');
      } else assert.equal(form.get('refresh_token'), 'synthetic-refresh');
      return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', scope: gmailScope });
    }
    if (url.origin === 'https://gmail.googleapis.com') {
      assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer synthetic-access');
      const operation = url.pathname.replace('/gmail/v1/users/me/', '');
      if (operation === 'profile') return Response.json({ emailAddress: email, historyId: '100' });
      if (operation === 'history') {
        const ids = url.searchParams.get('startHistoryId') === '100' ? Object.keys(messages) : [];
        receivedAt ||= Date.now();
        return Response.json({ historyId: '101', history: [{ messagesAdded: [...ids, ...ids].map(id => ({ message: { id } })) }] });
      }
      const id = operation.replace(/^messages\//, '');
      assert.equal(url.searchParams.get('format'), 'raw');
      assert(Object.hasOwn(messages, id));
      const isIgnored = id.startsWith('ignored-');
      const isShop = id.startsWith('other-');
      const isCard = id.startsWith('card-');
      const isMovistar = id.startsWith('movistar-');
      const isPlay = id.startsWith('play-');
      const isControl = [invalidModelId, failedCallbackId, secondEqualPaymentId, ignoredCallbackId].includes(id);
      const from = isCard ? 'alertasynotificaciones@an.notificacionesbancolombia.com' :
        isIgnored ? 'persona@example.test' : isShop ? shopSender : isMovistar ? 'movistar@movistar.com.co' :
          isPlay ? 'googleplay-noreply@google.com' : isControl ? shopSender : sender;
      const subject = isIgnored ? 'Saludos' : isShop ? agavalSubject : isCard ? bankPurchaseSubject :
        id === invalidModelId ? modelSubject : id === ignoredCallbackId ? noChargeSubject : isMovistar ? 'Hemos recibido tu pago' :
          isPlay ? 'Se usó una forma de pago alternativa para YouTube | Tu recibo de pedido de Google Play' : 'Aviso de pago';
      const raw = `From: ${from}\r\nTo: ${email}\r\n` +
        'Authentication-Results: mx.google.com; dmarc=pass header.from=' + from.split('@')[1] + '\r\n' +
        `Subject: ${subject}\r\nMIME-Version: 1.0\r\n` +
        `Content-Type: text/plain; charset=UTF-8\r\n\r\n${messages[id]}`;
      return Response.json({ id, raw: Buffer.from(raw).toString('base64url'), internalDate: String(receivedAt), labelIds: ['INBOX'] });
    }
    return networkFetch(resource, options);
  };
  const app = await createApp(config, false);
  const db = app.get(Database);
  const gmail = app.get(Gmail);
  const worker = new Worker(db, config, gmail, app.get(Agent));
  try {
    relay.listen(relayPort, '127.0.0.1');
    await once(relay, 'listening');
    app.enableShutdownHooks();
    await app.listen(config.PORT, '127.0.0.1');
    // Keep another run's synthetic work from consuming this run's first SMTP, poll or delivery job.
    await db.query("UPDATE outbox o SET due_at='infinity' FROM accounts a " +
      "WHERE o.account_id=a.id AND a.email<>$1 AND a.email LIKE 'gmail-e2e-%@example.test' AND o.status='queued'", [email]);
    await db.query("UPDATE mailboxes SET sync_due_at='infinity' WHERE email<>$1 AND email LIKE 'gmail-e2e-%@example.test'", [email]);
    await db.query("UPDATE gmail_deliveries d SET due_at='infinity' FROM mailboxes m " +
      "WHERE d.mailbox_id=m.id AND m.email<>$1 AND m.email LIKE 'gmail-e2e-%@example.test' AND d.completed_at IS NULL", [email]);
    const request = (path: string, data?: object, cookie?: string) => fetch(apiOrigin + '/v1/' + path, {
      method: data === undefined ? 'GET' : 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
      headers: { Origin: apiOrigin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    await Promise.all([waitForProtectedHook(webhookPath), waitForProtectedHook('mailgasto-private-intent')]);
    const malformed = await fetch(gmailWebhook, { method: 'POST',
      headers: { 'X-MailGasto-Agent': agentKey, 'Content-Type': 'application/json' },
      body: '{"messageId":"malformed"}', signal: AbortSignal.timeout(8000),
    });
    assert.equal(malformed.status, 400, 'Una entrega inválida se rechaza antes del 202');
    assert.equal((await request('auth/register', { name: 'Gmail QA', email, password })).status, 202);
    assert.equal(await worker.sendOne(), true);
    const verification = await waitFor('correo de verificación en Mailpit', async () => {
      const response = await fetch(mailpit + '/api/v1/search?query=' + encodeURIComponent(`to:${email}`));
      const search = await response.json();
      const id = search.messages?.[0]?.ID;
      if (!id) return;
      const mail = await (await fetch(mailpit + '/api/v1/message/' + id)).json();
      return /#verify=([\w-]{43})/.exec(mail.Text)?.[1];
    });
    assert.equal((await request('auth/verify', { token: verification, password })).status, 204);
    const login = await request('auth/login', { email, password });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const authorized = await request('mailboxes/gmail/authorize', {}, cookie);
    assert.equal(authorized.status, 200);
    const link = new URL((await authorized.json()).url);
    oauthChallenge = link.searchParams.get('code_challenge');
    assert.equal((await request(`mailboxes/gmail/callback?code=synthetic-grant&state=${link.searchParams.get('state')}`, undefined, cookie)).status, 303);
    assert.equal(await gmail.pollOne(), true);
    // Give each webhook its own time with the local Ollama runner.
    for (let expected = 1; expected <= Object.keys(messages).length; expected++) {
      assert.equal(await gmail.dispatchOne(), true);
      for (;;) {
        const progress = await waitFor('entrega ' + expected + ' resuelta por n8n o NestJS', async () => {
          const { rows: [row] } = await db.query<{ count: number }>(
            'SELECT count(*)::int FROM gmail_deliveries d JOIN mailboxes m ON m.id=d.mailbox_id ' +
            'WHERE m.email=$1 AND d.completed_at IS NOT NULL', [email],
          );
          if (row.count === expected) return { complete: true, retry: null };
          if (callback.retries.length) return { complete: false, retry: callback.retries.shift()! };
        }, 160);
        if (progress.complete) break;
        // Expedite the existing retry policy only for our synthetic delivery.
        const expedited = await db.query(
          "UPDATE gmail_deliveries d SET due_at='epoch' FROM mailboxes m " +
          'WHERE d.mailbox_id=m.id AND m.email=$1 AND d.message_id=$2 AND d.completed_at IS NULL AND d.due_at>now()',
          [email, progress.retry],
        );
        assert.equal(expedited.rowCount, 1, 'El primer error de Ollama conserva una entrega por reintentar');
        assert.equal(await gmail.dispatchOne(), true);
      }
    }
    const { rows: deliveries } = await db.query(
      'SELECT d.message_id,n.status,n.provider,n.reason,t.id,t.amount_minor,t.currency,t.category,' +
      'n.transaction_time,n.card_type,n.card_last4,n.reported_institution,' +
      't.payment_method,t.direction,t.description,d.attempts FROM gmail_deliveries d ' +
      'JOIN mailboxes m ON m.id=d.mailbox_id LEFT JOIN notices n ON n.mailbox_id=m.id AND n.message_id=d.message_id ' +
      'LEFT JOIN transactions t ON t.notice_id=n.id WHERE m.email=$1 AND d.completed_at IS NOT NULL ORDER BY d.message_id', [email],
    );
    const byId = (id: string) => deliveries.find(row => row.message_id === id)!;
    const [card, ignored, movistar, other, ambiguous, play, registered] =
      ['card', 'ignored', 'movistar', 'other', 'pending', 'play', 'registered'].map(prefix => byId(prefix + '-' + run));
    const modelRetry = byId(invalidModelId);
    const callbackRetry = byId(failedCallbackId);
    const equalPayment = byId(secondEqualPaymentId);
    assert(callback.ignoredObserved, 'El descarte OAuth de n8n debe cerrar la entrega mediante callback');
    assert.equal(byId(ignoredCallbackId).status, null, 'El descarte del webhook no crea un aviso');
    assert(sentInvalidOllamaJson && callback.modelRetryScheduled, 'La respuesta inválida de Ollama debe programar otro intento');
    assert.deepEqual([modelRetry.status, modelRetry.amount_minor, modelRetry.attempts], ['pending', null, 2]);
    assert.deepEqual([callbackRetry.status, equalPayment.status, callbackRetry.amount_minor, equalPayment.amount_minor],
      ['registered', 'registered', '2150000', '2150000']);
    assert.notEqual(callbackRetry.id, equalPayment.id, 'Dos pagos del mismo importe deben crear dos movimientos');
    await waitFor('repetición idempotente del callback', () => Promise.resolve(callback.duplicateObserved || undefined));
    assert(callback.faultInjected);
    assert.equal(callback.writes, 1);
    assert.deepEqual(
      [card.status, card.provider, card.amount_minor, card.currency, card.category, card.payment_method, card.description,
        card.transaction_time, card.card_type, card.card_last4, card.reported_institution],
      ['registered', 'bancolombia', '3075000', 'COP', 'otros', 'Tarjeta', 'MERCADO DEL BUENO', '14:42', 'debit', '1234', 'bancolombia'],
    );
    const cardDetail = await (await request('movements/' + card.id, undefined, cookie)).json();
    assert.deepEqual(
      [cardDetail.transaction_date, cardDetail.reported_transaction_date, cardDetail.transaction_time, cardDetail.card_type,
        cardDetail.card_last4, cardDetail.reported_institution],
      [date, date, '14:42', 'debit', '1234', 'bancolombia'],
    );
    assert.equal(ignored.status, null);
    assert.deepEqual(
      [movistar.status, movistar.provider, movistar.amount_minor, movistar.currency, movistar.category,
        movistar.payment_method, movistar.description, movistar.direction],
      ['registered', 'other', '6000000', 'COP', 'vivienda', null, 'Movistar', 'expense'],
    );
    assert.deepEqual([play.status, play.amount_minor, play.category, play.payment_method, play.card_last4, play.transaction_time],
      ['registered', '1330000', 'ocio', 'Tarjeta', '5678', '11:26:50']);
    // The synthetic Agaval fixture has no configured issuer profile: an unconfirmed model answer
    // must leave it reviewable. The mobile fixture below uses the confirmed path when available.
    if (other.status === 'registered') {
      assert.deepEqual([other.provider, other.amount_minor, other.currency, other.category, other.payment_method, other.direction],
        ['other', '5000000', 'COP', 'compras', null, 'expense']);
      assert.match(other.description, /agaval/i);
      assert.equal(other.transaction_time, null);
    } else {
      assert(['pending', 'error'].includes(other.status as string), 'Una respuesta del modelo no corroborada debe ir a revisión');
      assert.equal(other.amount_minor, null);
    }
    assert(['pending', 'error'].includes(ambiguous.status), 'Un aviso ambiguo no debe registrarse');
    assert.equal(ambiguous.amount_minor, null);
    assert.deepEqual([registered.status, registered.amount_minor, registered.currency], ['registered', '2500', 'COP']);
    while (await worker.sendOne()) {
      // Flush the synthetic outbox before checking the SMTP deliveries.
    }
    const notified = deliveries.filter(row => row.status === 'registered' ||
      row.status === 'pending' && row.provider !== 'other' && row.reason !== 'unverified_sender');
    const mailCount = await waitFor('notificaciones SMTP para aviso registrado y pendiente', async () => {
      const { rows } = await db.query("SELECT o.subject FROM outbox o JOIN accounts a ON a.id=o.account_id " +
        "WHERE a.email=$1 AND o.status='sent' ORDER BY o.subject", [email]);
      if (rows.length === 1 + notified.length) {
        return rows.map(row => row.subject);
      }
    });
    assert(mailCount.some(subject => subject.includes('Movimiento registrado')));
    if (ambiguous.status === 'pending') assert(mailCount.some(subject => subject.includes('Aviso pendiente')));
    const response = await fetch(n8nWebhook + '/mailgasto-private-intent', {
      method: 'POST', signal: AbortSignal.timeout(80_000),
      headers: { 'Content-Type': 'application/json', 'X-MailGasto-Agent': agentKey },
      body: JSON.stringify({ text: '¿Cuánto gasté hoy en alimentación?', hasContext: false }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.result?.action, 'summary', 'Ollama debe responder a través del webhook real de n8n');
    console.info('NestJS, n8n, Ollama, PostgreSQL y SMTP verificados. El 400 rechaza el sobre inválido. ' +
      'Ollama pudo recuperarse de JSON inválido y al repetir el callback no se duplicó el movimiento.');
    if (process.env.MAILGASTO_E2E_ANDROID === '1' && other.status === 'registered') {
      console.info(`API Android: ${apiOrigin} · TEST_GMAIL_E2E_EMAIL=${email}`);
    } else await app.close();
  } catch (error) {
    await app.close();
    throw error;
  } finally {
    relay.close();
    await worker.onApplicationShutdown();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
