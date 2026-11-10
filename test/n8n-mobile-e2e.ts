import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DateTime } from 'luxon';
import { buildGmailWorkflow } from '../n8n/gmail-workflow.mjs';
import { readConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { createApp } from '../src/main.js';

const apiOrigin = 'http://localhost:3116';
const n8n = 'http://127.0.0.1:5679/webhook';
const gmailWebhook = n8n + '/mailgasto-private-gmail';
const mailpit = 'http://127.0.0.1:8026';
const gmailScope = 'https://www.googleapis.com/auth/gmail.readonly';
const sender = 'avisos@banco.example';
const password = 'synthetic-gmail-e2e-password';
const agentKey = randomBytes(32).toString('hex');
const ingestKey = randomBytes(32).toString('hex');
const run = randomBytes(5).toString('hex');
const email = `gmail-e2e-${run}@example.test`;
const today = DateTime.now().setZone('America/Bogota');
const date = today.toISODate();
const model = process.env.MAILGASTO_E2E_MODEL ?? 'qwen3.5:4b';
const credentials = {
  agent: { id: 'mailgastoe2eagnt', name: 'MailGasto E2E Agent' },
  ingest: { id: 'mailgastoe2eingst', name: 'MailGasto E2E Ingest' },
  model: { id: 'mailgastoe2emodel', name: 'MailGasto E2E Ollama' },
};

async function waitFor<T>(name: string, check: () => Promise<T | undefined>, seconds = 30): Promise<T> {
  const until = Date.now() + seconds * 1000;
  do {
    const result = await check();
    if (result !== undefined) return result;
    await delay(350);
  } while (Date.now() < until);
  throw new Error(`No se pudo comprobar: ${name}`);
}

function provisionN8n() {
  const container = 'mailgasto-e2e-n8n';
  const docker = (...args: string[]) => execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'inherit'] });
  const temp = mkdtempSync(join(tmpdir(), 'mailgasto-e2e-'));
  const flow = buildGmailWorkflow({
    agentCredential: credentials.agent, resultCredential: credentials.ingest, modelCredential: credentials.model,
    resultUrl: 'http://host.docker.internal:3116/v1/internal/gmail/results',
    senderJson: JSON.stringify({ [sender]: 'nequi' }), stage: false,
  });
  // The isolated instance has no Gmail credential. Keep the production OAuth branch and its AI subnodes.
  const legacy = new Set(['Gmail Trigger', 'Preparar IDs de Gmail', 'Guardar ID para reintento',
    'Revisar entregas pendientes', 'Buscar IDs pendientes', 'Reservar reintentos', 'Preparar lectura de Gmail',
    'Leer cuerpo de Gmail', 'Normalizar Gmail directo', 'Confirmar entrega del Gmail directo', 'Quitar ID resuelto']);
  flow.nodes = flow.nodes.filter(node => !legacy.has(node.name));
  flow.nodes.find(node => node.name === 'Ollama Chat Model')!.parameters.model = model;
  for (const [source, connections] of Object.entries(flow.connections)) {
    if (legacy.has(source)) delete flow.connections[source];
    else for (const branches of Object.values(connections)) {
      for (const branch of branches) {
        for (let i = branch.length - 1; i >= 0; i--) if (legacy.has(branch[i].node)) branch.splice(i, 1);
      }
    }
  }
  const chat = JSON.parse(execFileSync(process.execPath, ['n8n/workflows.mjs', 'agent'], { encoding: 'utf8' }));
  for (const node of chat.nodes) {
    if (node.type === 'n8n-nodes-base.webhook') node.credentials.httpHeaderAuth = credentials.agent;
    if (node.type.endsWith('.ollama')) {
      node.credentials.ollamaApi = credentials.model;
      node.parameters.modelId.value = model;
    }
  }
  const workflowIds = ['mailgastoe2egmail', 'mailgastoe2echat'];
  try {
    writeFileSync(join(temp, 'credentials.json'), JSON.stringify([
      { ...credentials.agent, type: 'httpHeaderAuth', data: { name: 'X-MailGasto-Agent', value: agentKey } },
      { ...credentials.ingest, type: 'httpHeaderAuth', data: { name: 'X-MailGasto-Ingest', value: ingestKey } },
      { ...credentials.model, type: 'ollamaApi', data: { baseUrl: 'http://ollama:11434' } },
    ]));
    writeFileSync(join(temp, 'workflows.json'), JSON.stringify([flow, chat].map((workflow, index) => ({
      ...workflow, id: workflowIds[index], name: `${workflow.name} · E2E local`,
    }))));
    for (const kind of ['credentials', 'workflows']) docker('cp', join(temp, `${kind}.json`), `${container}:/tmp/mailgasto-${kind}.json`);
    try {
      docker('exec', container, 'n8n', 'import:credentials', '--input=/tmp/mailgasto-credentials.json');
    } finally {
      docker('exec', '--user', 'root', container, 'rm', '-f', '/tmp/mailgasto-credentials.json');
    }
    docker('exec', container, 'n8n', 'import:workflow', '--input=/tmp/mailgasto-workflows.json');
    for (const id of workflowIds) docker('exec', container, 'n8n', 'publish:workflow', `--id=${id}`);
    docker('restart', container);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function main() {
  const database = new URL(process.env.DATABASE_URL ?? '');
  assert(['localhost', '127.0.0.1'].includes(database.hostname), 'Usa un PostgreSQL local de pruebas');
  database.pathname = '/mailgasto_mobile_e2e';
  const config = readConfig({
    PUBLIC_URL: apiOrigin, PORT: '3116', DATABASE_URL: database.href,
    ENCRYPTION_KEY: randomBytes(32).toString('hex'), N8N_INGEST_KEY: ingestKey, N8N_AGENT_KEY: agentKey,
    N8N_GMAIL_WEBHOOK_URL: gmailWebhook, N8N_AGENT_URL: n8n, N8N_AGENT_TIMEOUT_MS: '30000',
    GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret',
    SMTP_URL: 'smtp://127.0.0.1:1026', SMTP_FROM: 'MailGasto QA <mailgasto@example.test>',
  });
  provisionN8n();
  const networkFetch = globalThis.fetch;
  const messages = {
    [`registered-${run}`]: `Pagaste COP 25 en Restaurante QA el ${date} con Nequi. Cuenta 12345678901.`,
    [`other-${run}`]: `Confirmación de pago. Pagaste COP 3200 en Comercio QA el ${date}.`,
    [`pending-${run}`]: `Pagaste COP 13.000 y transferiste COP 14.000 el ${date}.`,
    [`ignored-${run}`]: 'Hola, mensaje personal de prueba.',
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
      const from = isIgnored ? 'persona@example.test' : id.startsWith('other-') ? 'avisos@comercio.example' : sender;
      const raw = `From: ${from}\r\nTo: ${email}\r\n` +
        `Subject: ${isIgnored ? 'Saludos' : 'Aviso de pago'}\r\nMIME-Version: 1.0\r\n` +
        `Content-Type: text/plain; charset=UTF-8\r\n\r\n${messages[id]}`;
      return Response.json({ id, raw: Buffer.from(raw).toString('base64url'), internalDate: String(receivedAt), labelIds: ['INBOX'] });
    }
    return networkFetch(resource, options);
  };
  const app = await createApp(config);
  try {
    app.enableShutdownHooks();
    await app.listen(config.PORT, '127.0.0.1');
    const db = app.get(Database);
    const request = (path: string, data?: object, cookie?: string) => fetch(apiOrigin + '/v1/' + path, {
      method: data === undefined ? 'GET' : 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
      headers: { Origin: apiOrigin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const hook = () => fetch(gmailWebhook, { method: 'POST', signal: AbortSignal.timeout(3500) });
    await waitFor('webhook de n8n activo y protegido', async () => {
      const response = await hook().catch(() => undefined);
      if (response && [401, 403].includes(response.status)) return true;
    });
    assert.equal((await request('auth/register', { name: 'Gmail QA', email, password })).status, 202);
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
    const deliveries = await waitFor('cuatro entregas cerradas por el webhook de n8n', async () => {
      const { rows } = await db.query(
        'SELECT d.message_id, n.status, n.provider, n.reason, t.amount_minor, t.currency, d.attempts FROM gmail_deliveries d ' +
        'JOIN mailboxes m ON m.id=d.mailbox_id LEFT JOIN notices n ON n.mailbox_id=m.id AND n.message_id=d.message_id ' +
        'LEFT JOIN transactions t ON t.notice_id=n.id WHERE m.email=$1 AND d.completed_at IS NOT NULL ORDER BY d.message_id', [email],
      );
      return rows.length === 4 ? rows : undefined;
    }, 180);
    const [ignored, other, ambiguous, registered] = deliveries;
    assert.equal(ignored.status, null);
    assert.deepEqual([other.status, other.provider, other.reason, other.amount_minor], ['pending', 'other', 'unverified_sender', null]);
    assert(['pending', 'error'].includes(ambiguous.status), 'Un aviso ambiguo no debe registrarse');
    assert.equal(ambiguous.amount_minor, null);
    assert.deepEqual([registered.status, registered.amount_minor, registered.currency], ['registered', '2500', 'COP']);
    assert(deliveries.every(row => row.attempts === 1), 'Cada mensaje debe cerrarse en un solo intento');
    const mailCount = await waitFor('notificaciones SMTP para aviso registrado y pendiente', async () => {
      const { rows } = await db.query("SELECT o.subject FROM outbox o JOIN accounts a ON a.id=o.account_id " +
        "WHERE a.email=$1 AND o.status='sent' ORDER BY o.subject", [email]);
      if (rows.length === (ambiguous.status === 'pending' ? 3 : 2)) return rows.map(row => row.subject);
    });
    assert(mailCount.some(subject => subject.includes('Movimiento registrado')));
    if (ambiguous.status === 'pending') assert(mailCount.some(subject => subject.includes('Aviso pendiente')));
    const response = await fetch(n8n + '/mailgasto-private-intent', {
      method: 'POST', signal: AbortSignal.timeout(40000),
      headers: { 'Content-Type': 'application/json', 'X-MailGasto-Agent': agentKey },
      body: JSON.stringify({ text: '¿Cuánto gasté hoy en alimentación?', hasContext: false }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.result?.action, 'summary', 'Ollama debe responder a través del webhook real de n8n');
    console.info(`PostgreSQL: 1 movimiento por COP 25, 1 remitente sin verificar, 1 aviso ${ambiguous.status}, 1 descartado, sin duplicados. SMTP y Ollama verificados.`);
    console.info(`API Android: ${apiOrigin} · TEST_GMAIL_E2E_EMAIL=${email}`);
  } catch (error) {
    await app.close();
    throw error;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
