import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent } from '../src/agent.js';
import { readConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { Gmail } from '../src/gmail.js';
import { createApp } from '../src/main.js';
import { Worker } from '../src/worker.js';
import { agaval, agavalModel, agavalSubject, bank, bankSender, filterAndResolve, goodModel, legacyInput,
  oauthInput, shopSender } from './pipeline.fixture.mjs';

const connection = process.env.MAILGASTO_TEST_DATABASE_URL;
const origin = 'http://localhost:3105';
const ingestKey = 'test-ingest-key-for-local-integration-only';
const password = 'synthetic-test-password';
const rawMessage = (subject: string, body: string, sender = 'alertas@nequi.example') => Buffer.from(
  'From: <' + sender + '>\r\nTo: owner@example.test\r\nSubject: ' + subject +
  '\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n' + body,
).toString('base64url');

test('Gmail direct and OAuth use n8n results, durable delivery, PostgreSQL and owner isolation', { skip: !connection }, async t => {
  assert.match(new URL(connection!).pathname, /^\/mailgasto(?:_test)?$/);
  const agentKey = 'test-agent-key-for-local-integration-only';
  const deliveries: Array<{ messageId: string; deliveryId: string; attemptId: string; receivedAt: string; text: string }> = [];
  let webhookOffline = false;
  const model = createServer(async (req, res) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/webhook/mailgasto-private-gmail') {
      if (req.headers['x-mailgasto-agent'] !== agentKey) { res.writeHead(401).end('{}'); return; }
      deliveries.push(data);
      res.writeHead(webhookOffline ? 503 : 202).end('{}');
      return;
    }
    if (req.url?.includes('intent')) {
      res.end(JSON.stringify({ result: { action: 'summary', period: 'all', category: null, date: null } }));
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  t.after(() => { model.close(); });
  const ownerEmail = 'owner-' + randomUUID().slice(0, 8) + '@example.test';
  const otherEmail = 'second-' + randomUUID().slice(0, 8) + '@example.test';
  const mockHost = 'http://127.0.0.1:' + (model.address() as AddressInfo).port;
  const config = readConfig({
    PUBLIC_URL: origin, DATABASE_URL: connection, ENCRYPTION_KEY: 'ab'.repeat(32),
    N8N_AGENT_KEY: agentKey, N8N_INGEST_KEY: ingestKey,
    N8N_AGENT_URL: mockHost + '/webhook', N8N_GMAIL_WEBHOOK_URL: mockHost + '/webhook/mailgasto-private-gmail',
    LEGACY_GMAIL_ADDRESS: ownerEmail, GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret',
    SMTP_URL: process.env.MAILGASTO_TEST_SMTP_URL ?? 'smtp://localhost:1026',
    SMTP_FROM: 'MailGasto IA <mailgasto@example.test>',
  });
  const app = await createApp(config, false);
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const db = app.get(Database);
  const gmail = app.get(Gmail);
  const worker = new Worker(db, config, gmail, app.get(Agent));
  t.after(() => worker.onApplicationShutdown());
  t.after(async () => {
    const cleanup = new Database(config);
    try { await cleanup.query('DELETE FROM accounts WHERE email=ANY($1)', [[ownerEmail, otherEmail]]); }
    finally { await cleanup.onApplicationShutdown(); }
  });
  const request = (path: string, method = 'GET', body?: unknown, cookie = '', secret?: string) =>
    fetch(base + '/v1/' + path, {
      method, redirect: 'manual',
      headers: {
        Origin: origin, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(secret ? { 'X-MailGasto-Ingest': secret } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function createOwner(email: string) {
    assert.equal((await request('auth/register', 'POST', { name: 'Persona de prueba', email, password })).status, 202);
    assert.equal((await request('auth/login', 'POST', { email, password })).status, 403);
    for (let count = 0; count < 5; count++) if (!await worker.sendOne()) break;
    const inbox = (process.env.MAILGASTO_TEST_MAILPIT_URL ?? 'http://localhost:8026') + '/api/v1/';
    let summary;
    for (let attempt = 0; attempt < 12 && !summary; attempt++) {
      const response = await fetch(inbox + 'search?query=' + encodeURIComponent('to:' + email));
      summary = (await response.json()).messages[0];
      if (!summary) await delay(100);
    }
    assert.ok(summary);
    const mail = await (await fetch(inbox + 'message/' + summary.ID)).json();
    const code = mail.Text.match(/#verify=([A-Za-z0-9_-]+)/)?.[1];
    assert.ok(code);
    assert.equal((await request('auth/verify', 'POST', { token: code, password })).status, 204);
    const session = await request('auth/login', 'POST', { email, password });
    assert.equal(session.status, 200);
    assert.match(session.headers.get('set-cookie')!, /HttpOnly/);
    return session.headers.get('set-cookie')!.split(';', 1)[0];
  }

  assert.equal((await request('health')).status, 200);
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await request('notices')).status, 401);
  const owner = await createOwner(ownerEmail);
  const other = await createOwner(otherEmail);
  assert.equal((await request('mailboxes/gmail/existing', 'POST', undefined, other)).status, 404);
  assert.equal((await request('mailboxes/gmail/existing', 'POST', undefined, owner)).status, 201);
  const { rows: [linkedAt] } = await db.query<{ now: Date }>('SELECT now()');
  const simulatedArrival = new Date(linkedAt.now.getTime() + 2000).toISOString();

  const post = (body: unknown, key = ingestKey) => request('internal/gmail/results', 'POST', body, '', key);
  const direct = (id: string, receivedAt = simulatedArrival) => filterAndResolve(legacyInput(id, receivedAt));
  const prior = await post(direct('older', '2020-11-10T00:00:00.000Z'));
  assert.equal((await prior.json()).outcome, 'discarded');
  assert.equal((await post(direct('denied'), 'wrong')).status, 401);
  assert.equal((await post({ ...direct('bad'), raw: 'not-allowed' })).status, 400);
  assert.equal((await post({ ...direct('bad'), confidence: 0.69 })).status, 400);
  const started = performance.now();
  const fixture = direct('direct');
  const retries = await Promise.all(Array.from({ length: 8 }, () => post(fixture)));
  const attempts = await Promise.all(retries.map(async response => [response.status, await response.json()] as const));
  assert.equal(attempts.filter(([code, body]) => code === 200 && body.outcome === 'stored').length, 1, JSON.stringify(attempts));
  assert.equal(attempts.filter(([code, body]) => code === 200 && body.outcome === 'duplicate').length, 7);
  const durations = [performance.now() - started];

  const forwarded = filterAndResolve(legacyInput('forwarded', simulatedArrival,
    '---------- Mensaje reenviado ---------\r\nDe: alertas@nequi.example\r\n\r\nPagaste USD 12.50 en Restaurante Demo el 10/11/2026.',
    ownerEmail), { ...goodModel, amountMinor: '1250', currency: 'USD' });
  assert.equal(forwarded.forwarded, true);
  assert.equal((await (await post(forwarded)).json()).outcome, 'stored');
  assert.equal(filterAndResolve(legacyInput('ignored', simulatedArrival, 'Hola', otherEmail, 'Feliz cumpleaños')), undefined);
  const pending = filterAndResolve(legacyInput('pending', simulatedArrival, bank + ' Monto COP 50.000.'));
  assert.equal(pending.status, 'pending');
  assert.equal((await (await post(pending)).json()).outcome, 'stored');
  const unavailable = filterAndResolve(legacyInput('technical', simulatedArrival, 'Pagaste en Restaurante Demo.'), null);
  assert.equal(unavailable.status, 'error');
  assert.equal((await (await post(unavailable)).json()).outcome, 'stored');
  const technical = await (await request('notices?status=error', 'GET', undefined, owner)).json();
  assert.equal(technical.items[0].reason, 'extractor_unavailable');
  for (let i = 0; i < 12; i++) {
    const start = performance.now();
    const backup = filterAndResolve(legacyInput('fixture-' + i, simulatedArrival), null);
    assert.equal((await (await post(backup)).json()).outcome, 'stored');
    durations.push(performance.now() - start);
  }
  const p95 = durations.sort((a, b) => a - b)[Math.ceil(durations.length * 0.95) - 1];
  console.info('Local result POST + PostgreSQL p95, synthetic: ' + Math.round(p95) + ' ms');
  const pendingList = (await (await request('notices?status=pending', 'GET', undefined, owner)).json()).items;
  assert.equal(pendingList.length, 1);
  const pendingDetail = await (await request('notices/' + pendingList[0].id, 'GET', undefined, owner)).json();
  assert.deepEqual(pendingDetail.unconfirmed_fields, ['amount']);
  assert.equal(pendingDetail.reason, 'missing_or_ambiguous_fields');
  const registered = (await (await request('notices?status=registered&limit=1', 'GET', undefined, owner)).json()).items;
  assert.equal(registered.length, 1);
  assert.equal((await request('notices/' + registered[0].id, 'GET', undefined, other)).status, 404);
  const report = await (await request('summary?from=2026-11-10&to=2026-11-10&category=alimentacion', 'GET', undefined, owner)).json();
  assert.deepEqual(report.totals.map((row: { currency: string; amount_minor: string }) => [row.currency, row.amount_minor]),
    [['COP', '32500000'], ['USD', '1250']]);
  const receipt = filterAndResolve(legacyInput('agaval', simulatedArrival, agaval, shopSender, agavalSubject), agavalModel);
  assert.equal((await (await post(receipt)).json()).outcome, 'stored');
  assert.equal((await (await post(receipt)).json()).outcome, 'duplicate');
  const purchases = (await (await request('movements?category=compras', 'GET', undefined, owner)).json()).items;
  assert.equal(purchases.length, 1);
  assert.deepEqual(
    [purchases[0].amount_minor, purchases[0].payment_method, purchases[0].category, purchases[0].direction],
    ['5000000', null, 'compras', 'expense'],
  );
  const purchaseReport = await (await request('summary?category=compras', 'GET', undefined, owner)).json();
  assert.deepEqual(purchaseReport.totals, [{ currency: 'COP', category: null, amount_minor: '5000000', count: 1 }]);

  const session = (await (await request('chat/sessions', 'POST', undefined, owner)).json()).id;
  const chatPath = 'chat/sessions/' + session + '/messages';
  assert.equal((await request(chatPath, 'GET', undefined, other)).status, 404);
  assert.match((await (await request(chatPath, 'POST', { message: 'Total 2026-11-10' }, owner)).json()).answer, /COP.*USD/);
  const emptyChat = await (await request(chatPath, 'POST', { message: 'Total de ocio el 2026-11-09' }, owner)).json();
  assert.match(emptyChat.answer, /2026-11-09 a 2026-11-09.*No hay gastos registrados/);
  const clothesChat = await (await request(chatPath, 'POST', { message: '¿Cuánto gasté en ropa el 2026-11-10?' }, owner)).json();
  assert.match(clothesChat.answer, /COP 50\.000,00/);
  const allChat = await (await request(chatPath, 'POST', { message: 'Todo el historial' }, owner)).json();
  assert.match(allChat.answer, /Todo el historial/);
  assert.match((await (await request(chatPath, 'POST', { message: 'Registra un gasto de 5.000' }, owner)).json()).answer, /Reenvía/);
  assert.equal((await (await request(chatPath, 'GET', undefined, owner)).json()).length, 5);
  const queued = await db.query("SELECT dedupe_key FROM outbox o JOIN accounts a ON a.id=o.account_id WHERE a.email=$1 AND o.status='queued'", [ownerEmail]);
  assert.equal(queued.rows.length, 16);

  // Fail PostgreSQL during the movement insert and verify the notice and outbox roll back together.
  const failed = direct('pg-failure');
  const suffix = randomUUID().replace(/-/g, '');
  const failFunction = 'test_fail_' + suffix;
  await db.query("CREATE FUNCTION " + failFunction + "() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN " +
    "IF EXISTS (SELECT 1 FROM notices WHERE id=NEW.notice_id AND message_id='pg-failure') " +
    "THEN RAISE EXCEPTION 'synthetic storage fault'; END IF; RETURN NEW; END; $$");
  await db.query('CREATE TRIGGER ' + failFunction + ' BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION ' + failFunction + '()');
  try {
    assert.equal((await post(failed)).status, 500);
    assert.equal((await db.query("SELECT 1 FROM notices WHERE message_id='pg-failure'")).rowCount, 0);
    assert.equal((await db.query("SELECT 1 FROM outbox o JOIN accounts a ON a.id=o.account_id WHERE a.email=$1 AND o.status='queued'", [ownerEmail])).rowCount, queued.rows.length);
  } finally {
    await db.query('DROP TRIGGER ' + failFunction + ' ON transactions');
    await db.query('DROP FUNCTION ' + failFunction + '()');
  }
  assert.equal((await (await post(failed)).json()).outcome, 'stored');
  const { rows: [dbJob] } = await db.query<{ id: string }>("SELECT id FROM notices WHERE message_id='pg-failure'");
  assert.equal((await db.query('SELECT 1 FROM transactions WHERE notice_id=$1', [dbJob.id])).rowCount, 1);
  assert.equal((await db.query('SELECT 1 FROM outbox WHERE dedupe_key=$1', ['registered:' + dbJob.id])).rowCount, 1);

  const pendingPath = 'notices/' + pendingDetail.id;
  const review = { amountMinor: '4200000', currency: 'COP', date: '2020-01-02', direction: 'income' };
  const confirm = (path: string, data = review, cookie = owner) => request(path + '/confirm', 'POST', data, cookie);
  const discard = (path: string, cookie = owner) => request(path, 'DELETE', undefined, cookie);
  assert.equal((await confirm(pendingPath, review, other)).status, 404);
  assert.equal((await discard(pendingPath, other)).status, 404);
  assert.equal((await confirm(pendingPath, { ...review, amountMinor: '0' })).status, 400);
  const confirmations = await Promise.all([confirm(pendingPath), confirm(pendingPath)]);
  assert.deepEqual(confirmations.map(response => response.status), [200, 200]);
  const [movement, retry] = await Promise.all(confirmations.map(response => response.json()));
  assert.deepEqual(retry, movement);
  assert.equal((await confirm(pendingPath, { ...review, amountMinor: '1' })).status, 409);
  assert.equal((await discard(pendingPath)).status, 409);
  const reviewed = await (await request('movements/' + movement.id, 'GET', undefined, owner)).json();
  assert.deepEqual([reviewed.source, reviewed.notice_id, reviewed.amount_minor], ['email', pendingDetail.id, review.amountMinor]);
  const reviewReport = await (await request(
    'analytics?from=' + review.date + '&to=' + review.date + '&currency=COP', 'GET', undefined, owner,
  )).json();
  assert.equal(reviewReport.incomeMinor, review.amountMinor);

  const addPending = async (messageId: string) => {
    assert.equal((await (await post({ ...pending, messageId })).json()).outcome, 'stored');
    const { items } = await (await request('notices?status=pending', 'GET', undefined, owner)).json();
    assert.equal(items.length, 1);
    return 'notices/' + items[0].id;
  };
  const discardPath = await addPending('discard-me');
  assert.equal((await discard(discardPath)).status, 204);
  assert.equal((await discard(discardPath)).status, 204);
  assert.equal((await confirm(discardPath)).status, 409);
  assert.equal((await (await post(direct('discard-me'))).json()).outcome, 'duplicate');
  assert.equal((await request(discardPath, 'GET', undefined, owner)).status, 404);
  const openNotices = await (await request('notices?unregistered=true', 'GET', undefined, owner)).json();
  assert.deepEqual(openNotices.items.map((item: { status: string }) => item.status), ['error']);

  const racePath = await addPending('review-race');
  const [confirmResponse, discardResponse] = await Promise.all([confirm(racePath), discard(racePath)]);
  assert.deepEqual([confirmResponse.status, discardResponse.status], confirmResponse.ok ? [200, 409] : [409, 204]);

  const authorize = await request('mailboxes/gmail/authorize', 'POST', {}, other);
  const location = new URL((await authorize.json()).url);
  assert.equal(location.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
  const state = location.searchParams.get('state');
  const callback = 'mailboxes/gmail/callback?code=synthetic&state=' + state;
  const fetchReal = globalThis.fetch;
  let revoked = false;
  let cursor = '';
  let messageIds = ['direct'];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      return revoked ? Response.json({ error: 'invalid_grant' }, { status: 400 }) :
        Response.json({ access_token: 'access', refresh_token: 'refresh', scope: location.searchParams.get('scope') });
    }
    if (url === 'https://oauth2.googleapis.com/revoke') return new Response(null, { status: 200 });
    if (url.endsWith('/profile')) return Response.json({ emailAddress: 'linked-' + otherEmail, historyId: '100' });
    if (url.includes('/history?')) {
      cursor = new URL(url).searchParams.get('startHistoryId')!;
      return Response.json({ historyId: '101', history: [{ messagesAdded: messageIds.map(id => ({ message: { id } })) }] });
    }
    if (url.includes('gmail.googleapis.com') && url.includes('/messages/')) {
      const id = new URL(url).pathname.split('/').at(-1)!;
      const raw = id === 'personal' ? rawMessage('Feliz cumpleaños', 'Hola', otherEmail) : rawMessage('Aviso de pago', bank, bankSender);
      return Response.json({ id, raw, internalDate: String(Date.now() + 50), labelIds: ['INBOX'] });
    }
    return fetchReal(input, init);
  }) as typeof fetch;
  try {
    assert.equal((await request(callback, 'GET', undefined, owner)).status, 400);
    assert.equal((await request(callback, 'GET', undefined, other)).status, 303);
    assert.equal((await request(callback, 'GET', undefined, other)).status, 400);
    await gmail.pollOne();
    assert.equal(cursor, '100');
    assert.equal(deliveries.length, 0);
    assert.equal((await db.query("SELECT 1 FROM gmail_deliveries WHERE message_id='direct' AND completed_at IS NULL")).rowCount, 1);
    const mailboxList = await (await request('mailboxes', 'GET', undefined, other)).json();
    const linked = mailboxList[0].id;
    const reschedule = () => db.query('UPDATE gmail_deliveries SET due_at=now() WHERE mailbox_id=$1 AND completed_at IS NULL', [linked]);
    const poll = async (id: string) => {
      messageIds = [id];
      await db.query('UPDATE mailboxes SET sync_due_at=now() WHERE id=$1', [linked]);
      await gmail.pollOne();
    };
    webhookOffline = true;
    assert.equal(await gmail.dispatchOne(), true);
    assert.equal(await gmail.dispatchOne(), false);
    webhookOffline = false;
    await reschedule();
    await gmail.dispatchOne();
    const first = deliveries.at(-1)!;
    assert.equal('raw' in first || 'attachments' in first || 'accountId' in first, false);
    assert.match(first.text, /25\.000/);
    await reschedule(); // n8n returned 202 but the result was lost.
    await gmail.dispatchOne();
    const current = deliveries.at(-1)!;
    assert.equal(current.deliveryId, first.deliveryId);
    assert.notEqual(current.attemptId, first.attemptId);
    assert.equal((await (await post(filterAndResolve(oauthInput(first)))).json()).outcome, 'discarded');
    const currentResult = filterAndResolve(oauthInput(current));
    assert.equal((await (await post({ ...currentResult, messageId: 'other-id' })).json()).outcome, 'discarded');
    assert.equal((await (await post(currentResult)).json()).outcome, 'stored');
    assert.equal((await (await post(currentResult)).json()).outcome, 'duplicate');
    const list = await (await request('notices', 'GET', undefined, other)).json();
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].status, 'registered');
    assert.equal((await request('notices/' + list.items[0].id, 'GET', undefined, owner)).status, 404);
    await poll('personal');
    await gmail.dispatchOne();
    const ignored = filterAndResolve(oauthInput(deliveries.at(-1)!));
    assert.equal(ignored.status, 'ignored');
    assert.equal((await (await post(ignored)).json()).outcome, 'ignored');
    assert.equal((await (await request('notices', 'GET', undefined, other)).json()).items.length, 1);
    const tokenRow = await db.query('SELECT secret FROM mailboxes WHERE id=$1', [linked]);
    assert.notEqual(tokenRow.rows[0].secret, 'refresh');
    await poll('in-flight');
    await gmail.dispatchOne();
    const late = filterAndResolve(oauthInput(deliveries.at(-1)!));
    assert.equal(late.messageId, 'in-flight');
    await db.query('UPDATE mailboxes SET sync_due_at=now() WHERE id=$1', [linked]);
    revoked = true;
    await gmail.pollOne();
    assert.equal((await (await request('mailboxes', 'GET', undefined, other)).json())[0].state, 'reconnect');
    assert.equal(await gmail.dispatchOne(), false);
    assert.equal((await (await post(late)).json()).outcome, 'discarded');
    revoked = false;
    const reauth = await request('mailboxes/gmail/authorize', 'POST', { mailboxId: linked }, other);
    const reconnectState = new URL((await reauth.json()).url).searchParams.get('state');
    assert.equal((await request('mailboxes/gmail/callback?code=synthetic&state=' + reconnectState, 'GET', undefined, other)).status, 303);
    assert.equal((await db.query('SELECT history_id FROM mailboxes WHERE id=$1', [linked])).rows[0].history_id, '101');
    assert.equal((await (await post(late)).json()).outcome, 'discarded');
    assert.equal(await gmail.dispatchOne(), true);
    const renewed = filterAndResolve(oauthInput(deliveries.at(-1)!));
    assert.equal(renewed.deliveryId, late.deliveryId);
    assert.notEqual(renewed.attemptId, late.attemptId);
    assert.equal((await request('mailboxes/' + linked, 'DELETE', undefined, owner)).status, 404);
    assert.deepEqual(await (await request('mailboxes/' + linked, 'DELETE', undefined, other)).json(),
      { state: 'disconnected', providerRevoked: true });
    assert.equal((await (await post(renewed)).json()).outcome, 'discarded');
    assert.equal((await db.query('SELECT 1 FROM gmail_deliveries WHERE mailbox_id=$1 AND completed_at IS NULL', [linked])).rowCount, 0);
    assert.equal((await (await request('notices', 'GET', undefined, other)).json()).items.length, 1);

    const mobileOrigin = 'https://mailgasto.example.test';
    const fingerprint = Array(32).fill('AA').join(':');
    const mobileApp = await createApp({
      ...config, secure: true, origin: mobileOrigin, ANDROID_APP_LINK_SHA256: fingerprint,
    }, false);
    try {
      await mobileApp.listen(0, '127.0.0.1');
      const mobileBase = await mobileApp.getUrl();
      const mobile = (path: string, cookie = '', body?: object) =>
        fetch(mobileBase + '/v1/mobile/' + path, {
          method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
          headers: { Origin: mobileOrigin, Cookie: cookie, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      const gmailFlow = (path: string, cookie = '', body?: object) => mobile('mailboxes/gmail/' + path, cookie, body);
      const association = await (await fetch(mobileBase + '/.well-known/assetlinks.json')).json();
      assert.equal(association[0].target.sha256_cert_fingerprints[0], fingerprint);
      const authorization = await gmailFlow('authorize', other, { mailboxId: linked });
      assert.equal(authorization.status, 200);
      const googleUrl = new URL((await authorization.json()).url);
      assert.equal(googleUrl.searchParams.get('redirect_uri'), mobileOrigin + '/v1/mobile/mailboxes/gmail/callback');
      const callbackPath = 'callback?code=synthetic&state=' + googleUrl.searchParams.get('state');
      const returned = await gmailFlow(callbackPath);
      assert.equal(returned.status, 303);
      assert.equal(returned.headers.get('cache-control'), 'no-store');
      assert.equal(returned.headers.get('referrer-policy'), 'no-referrer');
      const link = new URL(returned.headers.get('location')!);
      assert.equal(link.origin + link.pathname, mobileOrigin + '/mobile/gmail/return');
      assert.equal(link.search, '');
      const receipt = link.hash.match(/^#receipt=([A-Za-z0-9_-]{43})$/)?.[1];
      assert.ok(receipt);
      assert.equal(await returned.text(), '');
      const replay = await gmailFlow(callbackPath);
      assert.equal(replay.status, 303);
      assert.equal(replay.headers.get('location'), mobileOrigin + '/mobile/gmail/return#status=failed');
      assert.equal((await gmailFlow('complete', owner, { receipt })).status, 400);
      assert.equal((await gmailFlow('complete', other, { receipt })).status, 204);
      assert.equal((await gmailFlow('complete', other, { receipt })).status, 400);
      assert.equal((await (await request('mailboxes', 'GET', undefined, other)).json())[0].state, 'active');
      const cancelAuth = await gmailFlow('authorize', other, {});
      const cancelState = new URL((await cancelAuth.json()).url).searchParams.get('state');
      const cancelled = await gmailFlow('callback?error=access_denied&state=' + cancelState);
      assert.equal(cancelled.status, 303);
      assert.equal(cancelled.headers.get('location'), mobileOrigin + '/mobile/gmail/return#status=cancelled');

      const signin = await mobile('auth/google/authorize', '', { challenge: 'a'.repeat(43) });
      assert.equal(signin.status, 200);
      const signinState = new URL((await signin.json()).url).searchParams.get('state');
      const cancelSignin = await mobile('auth/google/callback?error=access_denied&state=' + signinState);
      assert.equal(cancelSignin.status, 303);
      assert.equal(cancelSignin.headers.get('location'), mobileOrigin + '/mobile/auth/google/return#status=cancelled');
      const replaySignin = await mobile('auth/google/callback?code=synthetic&state=' + signinState);
      assert.equal(replaySignin.status, 303);
      assert.equal(replaySignin.headers.get('location'), mobileOrigin + '/mobile/auth/google/return#status=failed');
    } finally {
      await mobileApp.close();
    }
  } finally {
    globalThis.fetch = fetchReal;
  }
});
