import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DateTime } from 'luxon';
import { Agent } from '../src/agent.js';
import { readConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { Gmail } from '../src/gmail.js';
import { createApp } from '../src/main.js';
import { Worker } from '../src/worker.js';
import { agaval, agavalModel, agavalSubject, bank, bankPurchase, bankPurchaseSubject, bankSender, filterAndResolve, goodModel, legacyInput,
  oauthInput, runCode, shopSender, uncertainModel } from './pipeline.fixture.mjs';

const connection = process.env.MAILGASTO_TEST_DATABASE_URL;
const origin = 'http://localhost:3105';
const ingestKey = 'test-ingest-key-for-local-integration-only';
const password = 'synthetic-test-password';
const rawMessage = (subject: string, body: string, sender = 'alertas@nequi.example', authenticated: boolean | string = false) => Buffer.from(
  'From: <' + sender + '>\r\nTo: owner@example.test\r\nSubject: ' + subject +
  (authenticated ? '\r\nAuthentication-Results: mx.google.com;\r\n  dmarc=pass header.from=' +
    (typeof authenticated === 'string' ? authenticated : 'notificacionesbancolombia.com') : '') +
  '\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n' + body,
).toString('base64url');

test('Gmail direct and OAuth use n8n results, durable delivery, PostgreSQL and owner isolation', { skip: !connection }, async t => {
  assert.match(new URL(connection!).pathname, /^\/mailgasto(?:_test)?$/);
  const agentKey = 'test-agent-key-for-local-integration-only';
  const deliveries: Array<{ messageId: string; deliveryId: string; attemptId: string; receivedAt: string; text: string }> = [];
  let webhookStatus = 202;
  const model = createServer(async (req, res) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/webhook/mailgasto-private-gmail') {
      if (req.headers['x-mailgasto-agent'] !== agentKey) { res.writeHead(401).end('{}'); return; }
      deliveries.push(data);
      res.writeHead(webhookStatus).end('{}');
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

  const usd = filterAndResolve(legacyInput('usd', simulatedArrival,
    'Pagaste USD 12.50 en Restaurante Demo el 10/11/2026.'),
  { ...goodModel, amountMinor: '1250', currency: 'USD', evidence: { ...goodModel.evidence, amountMinor: 'USD 12.50', currency: 'USD' } });
  assert.equal(usd.status, 'registered');
  assert.equal((await (await post(usd)).json()).outcome, 'stored');
  assert.equal(filterAndResolve(legacyInput('ignored', simulatedArrival, 'Hola', otherEmail, 'Feliz cumpleaños')), undefined);
  const pending = filterAndResolve(legacyInput('pending', simulatedArrival, bankPurchase + ' Monto COP 50.000.',
    bankSender, bankPurchaseSubject), { ...goodModel, amountMinor: '3075000', evidence: {
    ...goodModel.evidence, amountMinor: '$30.750,00', currency: '$', classification: 'Compraste', direction: 'Compraste',
  } });
  assert.equal(pending.status, 'pending');
  assert.equal((await (await post(pending)).json()).outcome, 'stored');
  const unavailable = filterAndResolve(legacyInput('technical', simulatedArrival, 'Pagaste en Restaurante Demo.',
    bankSender, 'Aviso de pago', ['INBOX'], true, 5), null);
  assert.equal(unavailable.status, 'error');
  assert.equal((await (await post(unavailable)).json()).outcome, 'stored');
  const technical = await (await request('notices?status=error', 'GET', undefined, owner)).json();
  assert.equal(technical.items[0].reason, 'extractor_unavailable');
  for (let i = 0; i < 12; i++) {
    const start = performance.now();
    const backup = filterAndResolve(legacyInput('fixture-' + i, simulatedArrival));
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
  assert.deepEqual(
    [pendingDetail.reported_transaction_date, pendingDetail.transaction_time, pendingDetail.reported_payment_method,
      pendingDetail.card_type, pendingDetail.card_last4, pendingDetail.reported_institution],
    ['2026-11-10', '14:42', 'Tarjeta', 'debit', '1234', 'bancolombia'],
  );
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
  const bre = filterAndResolve(legacyInput('bre-b', simulatedArrival,
    'Enviaste de manera exitosa 41.500 a la llave 1000000000 de PERSONA DEMO el 11 de noviembre de 2026 a las 4:13 a.m.',
    'notificaciones@nequi.com.co', '¡Enviaste plata por Bre-B!'), uncertainModel);
  assert.equal(bre.status, 'pending');
  assert.equal((await (await post(bre)).json()).outcome, 'stored');
  const { rows: [breSaved] } = await db.query(
    'SELECT n.id,t.id AS movement,n.reported_payment_method FROM notices n LEFT JOIN transactions t ON t.notice_id=n.id ' +
    'WHERE n.message_id=$1', ['bre-b']);
  assert.equal(breSaved.movement, null);
  assert.equal(breSaved.reported_payment_method, 'Bre-B');

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
  assert.equal(queued.rows.length, 17);

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
  assert.equal((await discard('notices/' + breSaved.id)).status, 204);
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
  assert.deepEqual(
    [reviewed.transaction_date, reviewed.reported_transaction_date, reviewed.transaction_time, reviewed.card_type, reviewed.card_last4],
    [review.date, '2026-11-10', '14:42', null, null],
  );
  const reviewReport = await (await request(
    'analytics?from=' + review.date + '&to=' + review.date + '&currency=COP', 'GET', undefined, owner,
  )).json();
  assert.equal(reviewReport.incomeMinor, review.amountMinor);
  const confirmedPath = 'movements/' + movement.id;
  assert.equal((await request(confirmedPath + '/email-details', 'PATCH', { category: 'compras' }, owner)).status, 400);
  assert.equal((await request(confirmedPath + '/email-details', 'PATCH', { note: 'Abono verificado' }, owner)).status, 204);
  assert.equal((await request(confirmedPath + '/correction', 'PATCH', { revision: 0, amountMinor: '4300000' }, owner)).status, 204);
  assert.deepEqual(await (await confirm(pendingPath)).json(), movement);
  const corrected = await (await request(confirmedPath, 'GET', undefined, owner)).json();
  assert.deepEqual([corrected.amount_minor, corrected.original_amount_minor, corrected.category, corrected.note],
    ['4300000', review.amountMinor, 'ingresos', 'Abono verificado']);

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
  const bankAddress = 'alertasynotificaciones@an.notificacionesbancolombia.com';
  const month = DateTime.now().setZone('America/Bogota').startOf('month');
  const operationDay = month.toFormat('dd/MM/yyyy');
  const earlier = month.plus({ milliseconds: 2 });
  const deposits = 'Bancolombia: Recibiste un pago de nómina por $1,123,450.01 en el producto *7321, el ' + operationDay + ' a las 10:08.';
  const historical: Record<string, string> = {
    'past-qr': rawMessage('Alertas y Notificaciones', 'Bancolombia: Pagaste $35,100.00 por QR el ' + operationDay + ' a las 11:21.', bankAddress, true),
    'past-payroll': Buffer.from([
      'From: <' + bankAddress + '>', 'Subject: Alertas y Notificaciones',
      'Authentication-Results: mx.google.com; dkim=pass header.d=notificacionesbancolombia.com',
      'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary=alternative', '',
      '--alternative', 'Content-Type: text/plain; charset=UTF-8', '', 'Consulta la versión HTML del correo.',
      '--alternative', 'Content-Type: text/html; charset=UTF-8', '', '<table><tr><td><p>' + deposits + '</p></td></tr></table>',
      '--alternative--', '',
    ].join('\r\n')).toString('base64url'),
    'past-copy': rawMessage('Alertas y Notificaciones', deposits, bankAddress, true),
    'past-personal': rawMessage('Faltan fondos para pagar en Google', 'Faltan fondos para pagar $19.900 en Google.', 'nu@nu.com.co', 'nu.com.co'),
    'past-not-authenticated': rawMessage('Faltan fondos para pagar en Google', 'Faltan fondos para pagar $9.900 en Google.', 'nu@nu.com.co'),
    'past-uncertain': rawMessage('Pago recibido', 'Recibimos tu pago de $37.200 el ' + operationDay + '.', shopSender),
    'outside-month': rawMessage('Alertas y Notificaciones', deposits, bankAddress, true),
    'contradictory-mime': Buffer.from([
      'From: <' + bankAddress + '>', 'Subject: Alertas y Notificaciones',
      'Authentication-Results: mx.google.com; dkim=pass header.d=notificacionesbancolombia.com', 'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary=testboundary', '',
      '--testboundary', 'Content-Type: text/plain; charset=UTF-8', '', deposits,
      '--testboundary', 'Content-Type: text/html; charset=UTF-8', '', '<p>Transacción rechazada. Faltan fondos para pagar.</p>',
      '--testboundary--', '',
    ].join('\r\n')).toString('base64url'),
  };
  const scanPages: (string | null)[] = [];
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
    if (url.startsWith('https://gmail.googleapis.com/') && new URL(url).pathname.endsWith('/messages')) {
      const params = new URL(url).searchParams;
      const page = params.get('pageToken');
      scanPages.push(page);
      assert.match(params.get('q') ?? '', new RegExp('^after:' + (Math.floor(month.toSeconds()) - 1) + ' before:\\d+ -in:sent -in:drafts$'));
      return Response.json(page ? { messages: ['past-copy', 'past-personal', 'past-not-authenticated', 'past-uncertain', 'outside-month'].map(id => ({ id })) } :
        { messages: ['direct', 'past-qr', 'past-payroll'].map(id => ({ id })), nextPageToken: 'second' });
    }
    if (url.includes('gmail.googleapis.com') && url.includes('/messages/')) {
      const id = new URL(url).pathname.split('/').at(-1)!;
      const raw = historical[id] ?? (id === 'personal' ? rawMessage('Feliz cumpleaños', 'Hola', otherEmail) :
        rawMessage('Aviso de pago', bank, bankSender, 'nequi.example'));
      const internalDate = id === 'outside-month' ? month.toMillis() - 1000 :
        historical[id] && id !== 'contradictory-mime' ? earlier.toMillis() : Date.now() + 50;
      return Response.json({ id, raw, internalDate: String(internalDate), labelIds: ['INBOX'] });
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
    webhookStatus = 503;
    assert.equal(await gmail.dispatchOne(), true);
    assert.equal(await gmail.dispatchOne(), false);
    webhookStatus = 202;
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
    assert.equal(deliveries.at(-1)?.messageId, 'direct');
    assert.equal((await (await request('notices', 'GET', undefined, other)).json()).items.length, 1);
    await t.test('reprocesses before linkage, preserves the confirmed notice and flags a second copy', async () => {
      const path = 'mailboxes/' + linked + '/reprocess';
      assert.equal((await request(path, 'POST')).status, 401);
      assert.equal((await request(path, 'POST', undefined, owner)).status, 404);
      assert.equal((await request('mailboxes/' + linked + '/openai', 'PATCH', { enabled: true }, other)).status, 503);
      const existing = await db.query(
        "INSERT INTO notices (mailbox_id,message_id,received_at,provider,forwarded,status,reason) " +
        "VALUES ($1,'past-qr',$2,'bancolombia',false,'error','extractor_unavailable') RETURNING id", [linked, earlier.toJSDate()],
      );
      const outdated = await db.query(
        "INSERT INTO notices (mailbox_id,message_id,received_at,provider,forwarded,status,reason,reported_amount_minor) " +
        "VALUES ($1,'past-personal',$2,'other',false,'pending','unconfirmed_extraction',1990000)," +
        "($1,'past-not-authenticated',$2,'other',false,'pending','unconfirmed_extraction',990000) RETURNING id,message_id", [linked, earlier.toJSDate()],
      );
      const messagesBefore = (await db.query('SELECT count(*)::int AS count FROM outbox')).rows[0].count;
      const launch = await request(path, 'POST', undefined, other);
      assert.equal(launch.status, 202);
      const activeRun = await launch.json();
      assert.deepEqual(await (await request(path, 'POST', undefined, other)).json(), activeRun);
      assert.equal(await gmail.scanReprocessPage(), true);
      const pendingScan = (await (await request('mailboxes', 'GET', undefined, other)).json())[0].reprocess;
      assert.equal(pendingScan.scanning, true);
      assert.equal(pendingScan.queued, 3);
      const firstPageWebhooksBefore = deliveries.length;
      assert.equal(await gmail.dispatchOne(), true);
      assert.equal(await gmail.dispatchOne(), true);
      assert.equal(await gmail.dispatchOne(), true);
      assert.equal(deliveries.length, firstPageWebhooksBefore + 1);
      const existingCallback = filterAndResolve(oauthInput(deliveries.at(-1)!));
      assert.equal(existingCallback.messageId, 'direct');
      assert.equal((await (await post(existingCallback)).json()).outcome, 'duplicate');
      assert.equal(await gmail.scanReprocessPage(), true);
      const webhooksBefore = deliveries.length;
      for (let index = 0; index < 5; index++) assert.equal(await gmail.dispatchOne(), true);
      assert.equal(await gmail.dispatchOne(), false);
      assert.equal(deliveries.length, webhooksBefore + 1);
      const historicalCallback = filterAndResolve(oauthInput(deliveries.at(-1)!), uncertainModel);
      assert.equal(historicalCallback.messageId, 'past-uncertain');
      assert.equal((await (await post(historicalCallback)).json()).outcome, 'stored');
      assert.equal(await gmail.scanReprocessPage(), false);
      assert.deepEqual(scanPages, [null, 'second']);
      const { reprocess } = (await (await request('mailboxes', 'GET', undefined, other)).json())[0];
      assert.ok(reprocess.finishedAt);
      assert.equal(reprocess.failure, null);
      assert.deepEqual(reprocess.summary, { registered: 2, pending: 3, ignored: 1, skipped: 2 });
      const notices = await db.query('SELECT n.id,message_id,status,reason,amount_minor,payment_method,transaction_time,direction ' +
        'FROM notices n LEFT JOIN transactions t ON t.notice_id=n.id WHERE n.mailbox_id=$1 ORDER BY message_id', [linked]);
      assert.deepEqual(notices.rows.map(row => [row.message_id, row.status, row.amount_minor, row.payment_method, row.direction]), [
        ['direct', 'registered', '2500000', null, 'expense'],
        ['past-copy', 'pending', null, null, null],
        ['past-not-authenticated', 'pending', null, null, null],
        ['past-payroll', 'registered', '112345001', null, 'income'],
        ['past-personal', 'discarded', null, null, null],
        ['past-qr', 'registered', '3510000', 'QR', 'expense'],
        ['past-uncertain', 'pending', null, null, null],
      ]);
      assert.equal(notices.rows[0].id, list.items[0].id);
      assert.equal(notices.rows[1].reason, 'possible_duplicate');
      assert.equal(notices.rows[3].transaction_time, '10:08');
      assert.equal(notices.rows[4].reason, 'not_transaction');
      const dismissedId = outdated.rows.find(row => row.message_id === 'past-personal')!.id;
      assert.equal((await request('notices/' + dismissedId, 'GET', undefined, other)).status, 404);
      assert.equal((await db.query('SELECT reported_amount_minor FROM notices WHERE id=$1', [dismissedId])).rows[0].reported_amount_minor, null);
      assert.equal(notices.rows[5].id, existing.rows[0].id);
      assert.equal((await db.query('SELECT count(*)::int AS count FROM outbox')).rows[0].count, messagesBefore);
      // A movement saved by the older workflow can be missing the time and method.
      const confirmedId = notices.rows[5].id;
      const original = await db.query('UPDATE transactions SET payment_method=NULL WHERE notice_id=$1 RETURNING id', [confirmedId]);
      await db.query('UPDATE notices SET transaction_time=NULL,reported_payment_method=NULL WHERE id=$1', [confirmedId]);
      const second = await request(path, 'POST', undefined, other);
      assert.equal(second.status, 202);
      assert.notDeepEqual(await second.json(), activeRun);
      assert.equal(await gmail.scanReprocessPage(), true);
      assert.equal(await gmail.scanReprocessPage(), true);
      const repeatedWebhooksBefore = deliveries.length;
      for (let index = 0; index < 6; index++) assert.equal(await gmail.dispatchOne(), true);
      assert.equal(await gmail.dispatchOne(), false);
      assert.equal(deliveries.length, repeatedWebhooksBefore + 2);
      for (const delivery of deliveries.slice(repeatedWebhooksBefore)) {
        const repeated = filterAndResolve(oauthInput(delivery), delivery.messageId === 'direct' ? goodModel : uncertainModel);
        assert.equal((await (await post(repeated)).json()).outcome, delivery.messageId === 'direct' ? 'duplicate' : 'stored');
      }
      assert.equal(await gmail.scanReprocessPage(), false);
      const enriched = await db.query(
        'SELECT t.id,t.payment_method,n.transaction_time,t.amount_minor::text FROM transactions t JOIN notices n ON n.id=t.notice_id WHERE n.id=$1',
        [confirmedId],
      );
      assert.deepEqual(enriched.rows, [{ id: original.rows[0].id, payment_method: 'QR', transaction_time: '11:21', amount_minor: '3510000' }]);
      assert.equal((await db.query('SELECT count(*)::int AS count FROM outbox')).rows[0].count, messagesBefore);
    });
    const tokenRow = await db.query('SELECT secret FROM mailboxes WHERE id=$1', [linked]);
    assert.notEqual(tokenRow.rows[0].secret, 'refresh');
    await poll('contradictory-mime');
    assert.equal(await gmail.dispatchOne(), true);
    const contradictory = await db.query(
      'SELECT n.status,n.reason,t.id AS transaction_id FROM notices n LEFT JOIN transactions t ON t.notice_id=n.id ' +
      "WHERE n.mailbox_id=$1 AND n.message_id='contradictory-mime'", [linked],
    );
    assert.deepEqual(contradictory.rows, [{ status: 'pending', reason: 'unconfirmed_extraction', transaction_id: null }]);
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
    assert.equal((await (await request('notices', 'GET', undefined, other)).json()).items.length, 7);

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
    await t.test('closes a rejected webhook payload without repeating the POST', async () => {
      webhookStatus = 400;
      const before = deliveries.length;
      try {
        await poll('invalid-contract');
        assert.equal(await gmail.dispatchOne(), true);
        assert.equal(await gmail.dispatchOne(), false);
        assert.equal(deliveries.length, before + 1);
        const { rows: [rejected] } = await db.query(
          "SELECT completed_at IS NOT NULL AS complete,attempts FROM gmail_deliveries WHERE message_id='invalid-contract' AND mailbox_id=$1",
          [linked],
        );
        assert.deepEqual(rejected, { complete: true, attempts: 1 });
      } finally {
        webhookStatus = 202;
      }
    });
  } finally {
    globalThis.fetch = fetchReal;
  }

  await t.test('conciliates authenticated receipt copies before saving either one as a second movement', async () => {
    const aval = 'info@pasarelapagosaval.com';
    const avalpay = 'no-responder@avalpaycenter.com.co';
    const confirmedBody = (reference: string, amount = '$690,512.00') => 'Tu transacción ha sido aprobada\n' +
      `Empresa\tComercio de prueba\nValor de transacción\t${amount}\nMedio de pago\tBre-B\n` +
      `ID Transacción\t${reference}\nFecha y hora\t${operationDay} 09:52:24 AM`;
    const partialBody = (reference: string) => `La transacción con ID número ${reference}, por valor de $690.512, realizada en el sitio https://example.test.\nSe encuentra en estado`;
    const result = (id: string, body: string, from: string, title: string) => {
      const input = legacyInput(id, simulatedArrival, body, from, title);
      const [filtered] = runCode('Filtrar y proteger aviso', input);
      assert.doesNotMatch(JSON.stringify(filtered.json.modelInput), /202601010000000TEST\d+|1432568724/i);
      return filterAndResolve(input, uncertainModel);
    };
    const confirmed = (name: string, ref: string, amount?: string) =>
      result(name, confirmedBody(ref, amount), aval, 'Pasarela de Pagos - APROBADA');
    const partial = (name: string, ref: string) =>
      result(name, partialBody(ref), avalpay, 'AvalPay Center: Comprobante de pago transacción Bre-B');
    const first = '202601010000000TEST000000000000001';
    const second = '202601010000000TEST000000000000002';
    const copy = partial('references-before-partial', first);
    assert.equal(copy.status, 'pending');
    assert.equal(copy.avalCopy, true);
    assert.equal((await (await post(copy)).json()).outcome, 'stored');
    assert.equal((await (await post(confirmed('references-before-paid', first))).json()).outcome, 'stored');
    assert.equal((await (await post(confirmed('references-after-paid', second))).json()).outcome, 'stored');
    assert.equal((await (await post(partial('references-after-partial', second))).json()).outcome, 'duplicate');
    const copyWithAnotherValue = confirmed('references-conflict', second, '$680,512.00');
    assert.equal((await (await post(copyWithAnotherValue)).json()).outcome, 'stored');
    const ach = 'serviciopse@achcolombia.com.co';
    const cus = '1432568724';
    const pay = result('references-pse', `Valor: COP $8.450\nEmpresa: Farmacia Demo\nDescripción: Toallas higiénicas\nFecha de la transacción: ${operationDay}\nCUS: ${cus}`,
      ach, 'PSE - Transacción Aprobada');
    const payCopy = result('references-nequi', `Hiciste un pago en Farmacia Demo por $8.450\nFecha: ${operationDay}\nCUS: ${cus}`,
      'somos@nequi.com.co', '¡Pago exitoso!');
    const concurrent = await Promise.all([post(pay), post(payCopy)]);
    const saved = await Promise.all(concurrent.map(response => response.json()));
    assert.deepEqual(saved.map(body => body.outcome).sort(), ['duplicate', 'stored']);

    const database = await db.query("SELECT n.message_id,n.status,n.reason,t.amount_minor::text,t.category,s.fingerprint FROM notices n " +
      'LEFT JOIN transactions t ON t.notice_id=n.id LEFT JOIN gmail_operation_references s ON s.notice_id=n.id ' +
      "WHERE n.message_id LIKE 'references-%' ORDER BY n.message_id");
    assert.deepEqual(database.rows.filter(row => !['references-nequi', 'references-pse'].includes(row.message_id))
      .map(row => [row.message_id, row.status, row.reason, row.amount_minor]), [
      ['references-after-paid', 'registered', null, '69051200'],
      ['references-before-paid', 'registered', null, '69051200'],
      ['references-before-partial', 'discarded', 'verified_duplicate', null],
      ['references-conflict', 'pending', 'possible_duplicate', null],
    ]);
    assert.equal(database.rows.filter(row => ['references-nequi', 'references-pse'].includes(row.message_id)).length, 1);
    assert.equal(database.rows.find(row => ['references-nequi', 'references-pse'].includes(row.message_id))?.category, 'compras');
    assert(database.rows.every(row => /^[0-9a-f]{64}$/.test(row.fingerprint)));
    const [{ id: otherAccount }] = (await db.query('SELECT id FROM accounts WHERE email=$1', [otherEmail])).rows;
    const [{ id: otherMailbox, generation }] = (await db.query("SELECT id,generation FROM mailboxes WHERE account_id=$1 AND source='oauth'", [otherAccount])).rows;
    const attemptId = randomUUID();
    const messageId = 'references-other-owner';
    const [{ id: deliveryId }] = (await db.query(
      'INSERT INTO gmail_deliveries (mailbox_id,generation,message_id,attempt_id,received_at,authenticated,forwarded) ' +
      'VALUES ($1,$2,$3,$4,$5,true,false) RETURNING id',
      [otherMailbox, generation, messageId, attemptId, new Date()],
    )).rows;
    const [{ received_at: otherReceived }] = (await db.query('SELECT received_at FROM gmail_deliveries WHERE id=$1', [deliveryId])).rows;
    const duplicateAtOtherOwner = filterAndResolve(oauthInput({ deliveryId, attemptId, messageId, receivedAt: otherReceived.toISOString(),
      labels: ['INBOX'], from: ach, subject: 'PSE - Transacción Aprobada',
      text: `Valor: COP $8.450\nEmpresa: Farmacia Demo\nFecha de la transacción: ${operationDay}\nCUS: ${cus}`,
    }), uncertainModel);
    assert.equal((await (await post(duplicateAtOtherOwner)).json()).outcome, 'stored');
    const [{ fingerprint: otherFingerprint }] = (await db.query('SELECT s.fingerprint FROM gmail_operation_references s ' +
      'JOIN notices n ON n.id=s.notice_id WHERE n.mailbox_id=$1 AND n.message_id=$2', [otherMailbox, messageId])).rows;
    assert.notEqual(otherFingerprint, database.rows.find(row => ['references-nequi', 'references-pse'].includes(row.message_id))?.fingerprint);
    const visible = (await (await request('notices?unregistered=true', 'GET', undefined, owner)).json()).items;
    assert(visible.some((row: { reason: string }) => row.reason === 'possible_duplicate'));
    assert(!visible.some((row: { reason: string }) => row.reason === 'verified_duplicate'));
  });

});

test('Gmail callback enforces authenticity and idempotent bounded retries', { skip: !connection }, async t => {
  assert.match(new URL(connection!).pathname, /^\/mailgasto(?:_test)?$/);
  const config = readConfig({
    PUBLIC_URL: origin, DATABASE_URL: connection, ENCRYPTION_KEY: 'ab'.repeat(32),
    N8N_AGENT_KEY: 'test-agent-key-for-local-integration-only', N8N_INGEST_KEY: ingestKey,
    SMTP_URL: process.env.MAILGASTO_TEST_SMTP_URL ?? 'smtp://localhost:1026',
    SMTP_FROM: 'MailGasto IA <mailgasto@example.test>',
  });
  const app = await createApp(config, false);
  const db = app.get(Database);
  const email = 'callbacks-' + randomUUID() + '@example.test';
  t.after(async () => {
    try { await db.query('DELETE FROM accounts WHERE email=$1', [email]); }
    finally { await app.close(); }
  });
  await app.listen(0, '127.0.0.1');
  const callbackUrl = (await app.getUrl()) + '/v1/internal/gmail/results';
  const post = (body: unknown) => fetch(callbackUrl, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MailGasto-Ingest': ingestKey }, body: JSON.stringify(body) });
  const [{ id: mailbox, generation }] = (await db.query(
    'WITH account AS (INSERT INTO accounts (email,name,password_hash,verified_at) VALUES ($1,$2,$3,now()) RETURNING id,email) ' +
    "INSERT INTO mailboxes (account_id,email,source,state) SELECT id,email,'oauth','active' FROM account RETURNING id,generation",
    [email, 'Synthetic callback test', password],
  )).rows;
  async function seed(messageId: string, authenticated: boolean, forwarded: boolean, attempts = 1) {
    const attemptId = randomUUID();
    const [{ id: deliveryId, received_at: received }] = (await db.query(
      'INSERT INTO gmail_deliveries (mailbox_id,generation,message_id,attempt_id,received_at,authenticated,forwarded,attempts,due_at) ' +
      "VALUES ($1,$2,$3,$4,now()+interval '1 second',$5,$6,$7,now()+interval '3 minutes') RETURNING id,received_at",
      [mailbox, generation, messageId, attemptId, authenticated, forwarded, attempts],
    )).rows;
    return { source: 'oauth', messageId, attemptId, deliveryId, receivedAt: received.toISOString() };
  }
  const registered = { status: 'registered', confidence: 1, provider: 'other', forwarded: false,
    movement: { amountMinor: '2500000', currency: 'COP', date: '2026-11-10', direction: 'expense',
      description: 'Restaurante Demo', category: 'alimentacion', paymentMethod: null } };

  const unauthenticated = await seed('forged-authentication', false, false);
  assert.equal((await post({ ...unauthenticated, ...registered, authenticated: true })).status, 400);
  assert.deepEqual(await (await post({ ...unauthenticated, ...registered, references: ['pse:1234567'] })).json(), { outcome: 'stored' });
  const forwarded = await seed('forged-forwarded', true, true);
  assert.deepEqual(await (await post({ ...forwarded, ...registered })).json(), { outcome: 'stored' });
  const { rows: untrusted } = await db.query(
    'SELECT n.status,n.forwarded,n.reported_amount_minor::text,t.id AS movement,s.fingerprint FROM notices n ' +
    'LEFT JOIN transactions t ON t.notice_id=n.id LEFT JOIN gmail_operation_references s ON s.notice_id=n.id ' +
    'WHERE n.mailbox_id=$1 AND n.message_id=ANY($2) ORDER BY n.message_id', [mailbox, ['forged-authentication', 'forged-forwarded']],
  );
  assert.deepEqual(untrusted, [false, true].map(forwarded => ({ status: 'pending', forwarded,
    reported_amount_minor: '2500000', movement: null, fingerprint: null })));

  const retry = await seed('retry-model-json', true, false);
  const retryResult = { ...retry, status: 'retry', reason: 'invalid_model_output', provider: 'other', forwarded: false };
  assert.deepEqual(await (await post(retryResult)).json(), { outcome: 'retry_scheduled' });
  const retryState = () => db.query('SELECT retry_requested_at,due_at,completed_at FROM gmail_deliveries WHERE id=$1', [retry.deliveryId]);
  const retryBefore = (await retryState()).rows;
  assert.ok(retryBefore[0].retry_requested_at);
  assert.equal(retryBefore[0].completed_at, null);
  assert.deepEqual(await (await post(retryResult)).json(), { outcome: 'retry_scheduled' });
  assert.deepEqual((await retryState()).rows, retryBefore);
  assert.equal((await db.query('SELECT 1 FROM notices WHERE mailbox_id=$1 AND message_id=$2', [mailbox, retry.messageId])).rowCount, 0);

  const exhausted = await seed('retry-model-exhausted', true, false, 5);
  const finalResult = { ...retryResult, ...exhausted, reason: 'ollama_unavailable' };
  assert.deepEqual(await (await post(finalResult)).json(), { outcome: 'stored' });
  assert.deepEqual(await (await post(finalResult)).json(), { outcome: 'duplicate' });
  const { rows: terminal } = await db.query(
    'SELECT n.status,n.reason,d.completed_at IS NOT NULL AS complete FROM notices n JOIN gmail_deliveries d ' +
    'ON d.mailbox_id=n.mailbox_id AND d.message_id=n.message_id WHERE d.id=$1', [exhausted.deliveryId],
  );
  assert.deepEqual(terminal, [{ status: 'error', reason: 'extractor_unavailable', complete: true }]);

  for (const messageId of ['separate-payment-a', 'separate-payment-b']) {
    const identity = await seed(messageId, true, false);
    assert.deepEqual(await (await post({ ...identity, ...registered })).json(), { outcome: 'stored' });
    assert.deepEqual(await (await post({ ...identity, ...registered })).json(), { outcome: 'duplicate' });
  }
  assert.equal((await db.query('SELECT 1 FROM transactions t JOIN notices n ON n.id=t.notice_id ' +
    "WHERE n.mailbox_id=$1 AND n.message_id LIKE 'separate-payment-%'", [mailbox])).rowCount, 2);
});
