import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { DateTime } from 'luxon';
import { encrypt, readConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { Gmail, gmailClassifierVersion, gmailFailureDiagnostic } from '../src/gmail.js';
import { GmailExtraction } from '../src/gmail-extraction.js';
import { readGmailMime } from '../src/gmail-mime.js';
import { GmailResults } from '../src/gmail-results.js';

const connection = process.env.MAILGASTO_TEST_DATABASE_URL;

test('delivery diagnostics retain SQLSTATE without logging email contents or database values', () => {
  const error = Object.assign(new Error('private email body and row values'), {
    code: '23514', detail: 'private financial record', constraint: 'private-name',
  });
  assert.deepEqual(gmailFailureDiagnostic(error), { errorType: 'database', sqlState: '23514' });
  assert.deepEqual(gmailFailureDiagnostic(new TypeError('secret payload')), { errorType: 'processing' });
});

test('Gmail reconciles a bounded month, exposes failures and recovers without repeating completed work', { skip: !connection }, async t => {
  const base = new URL(connection!);
  assert(['localhost', '127.0.0.1'].includes(base.hostname), 'Reliability tests require a local database');
  assert.match(base.pathname, /^\/mailgasto(?:_test)?$/);
  const schema = 'gmail_reliability_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: base.href });
  await admin.query('CREATE SCHEMA ' + schema);
  base.searchParams.set('options', '-c search_path=' + schema);
  const config = readConfig({
    PUBLIC_URL: 'http://localhost:3105', DATABASE_URL: base.href, ENCRYPTION_KEY: 'ab'.repeat(32),
    N8N_AGENT_KEY: 'local-reliability-agent-key-only-12345', N8N_INGEST_KEY: 'local-reliability-ingest-key-only-1234',
    N8N_GMAIL_WEBHOOK_URL: 'http://127.0.0.1:5679/webhook/reliability',
    GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret',
    SMTP_URL: 'smtp://localhost:1026', SMTP_FROM: 'Reliability <fixture@example.test>',
  });
  const db = new Database(config);
  t.after(async () => {
    await db.onApplicationShutdown();
    assert.match(schema, /^gmail_reliability_[a-f0-9]{32}$/);
    await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
    await admin.end();
  });
  await db.migrate();
  const results = new GmailResults(db, config);
  const gmail = new Gmail(db, config, new GmailExtraction(config), results);
  const { rows: [owner] } = await db.query<{ id: string }>(
    "INSERT INTO accounts (email,name,verified_at) VALUES ('reliability@example.test','Fixture',now()) RETURNING id",
  );
  const { rows: [mailbox] } = await db.query<{ id: string; generation: string }>(
    "INSERT INTO mailboxes (account_id,email,source,state,secret,linked_at) VALUES ($1,'fixture@example.test','oauth','active',$2,now()) " +
    'RETURNING id,generation', [owner.id, encrypt('synthetic-refresh-token', config.encryptionKey)],
  );
  const now = DateTime.now().setZone('America/Bogota');
  const received = now.minus({ seconds: 30 });
  // This mail precedes the mailbox link; only the bounded reconciliation may read it.
  const raw = Buffer.from('From: Store <receipts@fixture.example>\r\nSubject: Payment receipt\r\n' +
    'Authentication-Results: mx.google.com; dmarc=pass header.from=fixture.example\r\n' +
    'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n' +
    'Your payment was completed on ' + received.toISODate() + '. Amount paid: USD 49.95. Product: web hosting.').toString('base64url');
  let ids = ['missing-receipt'];
  let webhookStatus = 202;
  const posted: Record<string, unknown>[] = [];
  const rawById = new Map<string, string>();
  const readIds: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    const address = String(url);
    if (address === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'synthetic-access', expires_in: 3600 });
    if (address.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages?')) {
      const query = new URL(address).searchParams.get('q')!;
      assert.match(query, new RegExp('after:' + (Math.floor(now.startOf('month').toMillis() / 1000) - 1)));
      return Response.json({ messages: ids.map(id => ({ id })) });
    }
    if (address.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages/')) {
      const id = new URL(address).pathname.split('/').at(-1)!;
      readIds.push(id);
      return Response.json({ id, raw: rawById.get(id) ?? raw, internalDate: String(received.toMillis()), labelIds: ['INBOX'] });
    }
    if (address === config.N8N_GMAIL_WEBHOOK_URL) {
      posted.push(JSON.parse(options!.body as string));
      return new Response('', { status: webhookStatus });
    }
    throw Error('Unexpected external request: ' + address);
  });
  const row = async (id: string) => (await db.query('SELECT * FROM gmail_deliveries WHERE message_id=$1', [id])).rows[0];
  const makeDue = async () => db.query("UPDATE mailboxes SET reconciliation_due_at=now()-interval '1 second' WHERE id=$1", [mailbox.id]);
  const finishScan = async () => { await gmail.scanReprocessPage(); };

  await t.test('initial reconciliation invokes n8n for incomplete rules and honors the callback', async () => {
    assert.equal(await gmail.reconcileOne(), true);
    assert.equal(await gmail.reconcileOne(), false, 'Only one active scan per mailbox');
    await gmail.scanReprocessPage();
    await gmail.dispatchOne();
    assert.equal(posted.length, 1, 'Monthly reprocessing must use n8n when local rules cannot register');
    const identity = posted[0];
    assert.equal(identity.messageId, 'missing-receipt');
    await results.save({ source: 'oauth', deliveryId: identity.deliveryId as string, attemptId: identity.attemptId as string,
      messageId: identity.messageId as string, receivedAt: identity.receivedAt as string, provider: 'other', forwarded: false,
      status: 'pending', reason: 'missing_or_ambiguous_fields', confidence: 0 });
    assert.equal((await row('missing-receipt')).outcome, 'pending');
    await finishScan();
  });

  await t.test('daily scan preserves confirmed/discarded/ignored and does not repeat same-version pending', async () => {
    for (const status of ['registered', 'discarded']) await db.query(
      'INSERT INTO notices (mailbox_id,message_id,received_at,provider,forwarded,status) VALUES ($1,$2,$3,\'other\',false,$4)',
      [mailbox.id, 'preserve-' + status, received.toJSDate(), status],
    );
    await db.query('INSERT INTO gmail_deliveries (mailbox_id,generation,message_id,completed_at,outcome,classifier_version) ' +
      "VALUES ($1,$2,'already-ignored',now(),'ignored',$3)", [mailbox.id, mailbox.generation, gmailClassifierVersion]);
    ids = ['missing-receipt', 'preserve-registered', 'preserve-discarded', 'already-ignored'];
    await makeDue();
    await gmail.reconcileOne();
    await gmail.scanReprocessPage();
    assert.equal(await gmail.dispatchOne(), false);
    assert.equal(posted.length, 1);
    await finishScan();
    const latestRun = (await gmail.list(owner.id))[0].reprocess as { summary: Record<string, number> };
    assert.deepEqual(latestRun.summary, {}, 'Daily scans report new work, not the already processed mailbox');
    assert.equal((await row('missing-receipt')).outcome, 'pending');
    assert.equal((await db.query('SELECT count(*)::int AS total FROM transactions')).rows[0].total, 0);
  });

  await t.test('a rules revision rechecks pending once while preserving ignored messages', async () => {
    await db.query("UPDATE gmail_deliveries SET classifier_version='previous-rules' WHERE message_id='missing-receipt'");
    await db.query("UPDATE mailboxes SET reconciliation_version='previous-rules' WHERE id=$1", [mailbox.id]);
    assert.equal(await gmail.reconcileOne(), true, 'A new classifier version need not wait one day');
    await gmail.scanReprocessPage();
    await gmail.dispatchOne();
    assert.equal(posted.length, 2);
    const identity = posted.at(-1)!;
    await results.save({ source: 'oauth', deliveryId: identity.deliveryId as string, attemptId: identity.attemptId as string,
      messageId: identity.messageId as string, receivedAt: identity.receivedAt as string, status: 'ignored' });
    await finishScan();
  });

  await t.test('temporary failures remain visible and have bounded automatic recovery', async () => {
    ids = ['temporary-failure'];
    webhookStatus = 503;
    await makeDue();
    await gmail.reconcileOne();
    await gmail.scanReprocessPage();
    for (let attempt = 0; attempt < 5; attempt++) {
      await db.query("UPDATE gmail_deliveries SET due_at=now() WHERE message_id='temporary-failure'");
      await gmail.dispatchOne();
    }
    let failed = await row('temporary-failure');
    assert.equal(failed.outcome, 'error');
    assert.equal(failed.last_error, 'webhook_unavailable');
    assert(failed.completed_at);
    assert(failed.due_at > new Date(), 'Recovery waits at least six hours');
    const mailboxes = await gmail.list(owner.id);
    assert.deepEqual(mailboxes[0].delivery, { queued: 0, retrying: 0, failed: 1, lastError: 'webhook_unavailable' });
    await finishScan();
    for (let cycle = 1; cycle <= 2; cycle++) {
      await makeDue();
      await db.query("UPDATE gmail_deliveries SET due_at=now()-interval '1 second' WHERE message_id='temporary-failure'");
      await gmail.reconcileOne();
      await gmail.scanReprocessPage();
      failed = await row('temporary-failure');
      assert.equal(failed.completed_at, null);
      assert.equal(failed.recovery_count, cycle);
      await db.query("UPDATE gmail_deliveries SET attempts=5,due_at=now() WHERE message_id='temporary-failure'");
      await gmail.dispatchOne();
      await finishScan();
    }
    await makeDue();
    await db.query("UPDATE gmail_deliveries SET due_at=now()-interval '1 second' WHERE message_id='temporary-failure'");
    await gmail.reconcileOne();
    await gmail.scanReprocessPage();
    assert.equal(await gmail.dispatchOne(), false, 'Automatic recovery stops after two additional cycles');
    assert.equal((await row('temporary-failure')).outcome, 'error');
    await finishScan();
  });

  await t.test('explicit retry can recover a terminal delivery without duplicating a movement', async () => {
    webhookStatus = 202;
    await gmail.reprocessMonth(owner.id, mailbox.id);
    await gmail.scanReprocessPage();
    await gmail.dispatchOne();
    const identity = posted.at(-1)!;
    const result = { source: 'oauth' as const, deliveryId: identity.deliveryId as string, attemptId: identity.attemptId as string,
      messageId: identity.messageId as string, receivedAt: identity.receivedAt as string, status: 'ignored' as const };
    await results.save(result);
    assert.deepEqual(await results.save(result), { outcome: 'duplicate' });
    const recovered = await row('temporary-failure');
    assert.equal(recovered.outcome, 'ignored');
    assert.equal(recovered.last_error, null);
    assert.equal(((await gmail.list(owner.id))[0].delivery as { failed: number }).failed, 0);
    await finishScan();
  });

  await t.test('registered bank metadata is reviewed once per version without changing user values', async () => {
    const sender = 'alertasynotificaciones@an.notificacionesbancolombia.com';
    const text = 'Bancolombia: Compraste $12.500 en TIENDA DEMO con tu T.Deb *1234, el ' + received.toFormat('dd/MM/yyyy') + ' a las 14:42.';
    const bankRaw = Buffer.from('From: <' + sender + '>\r\nSubject: Alertas y Notificaciones\r\n' +
      'Authentication-Results: mx.google.com; dmarc=pass header.from=notificacionesbancolombia.com\r\n' +
      'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n' + text).toString('base64url');
    for (const [id, reason] of [['registered-details', null], ['user-confirmed', 'user_confirmed']] as const) {
      const { rows: [notice] } = await db.query<{ id: string }>(
        "INSERT INTO notices (mailbox_id,message_id,received_at,provider,forwarded,status,reason) VALUES ($1,$2,$3,'other',false,'registered',$4) RETURNING id",
        [mailbox.id, id, received.toJSDate(), reason],
      );
      await db.query('INSERT INTO transactions (notice_id,amount_minor,currency,transaction_date,description,category,direction) ' +
        "VALUES ($1,1250000,'COP',$2,'Descripción conservada del usuario','otros','expense')", [notice.id, received.toISODate()]);
      rawById.set(id, bankRaw);
    }
    ids = ['registered-details', 'user-confirmed'];
    await makeDue();
    await gmail.reconcileOne();
    await gmail.scanReprocessPage();
    assert.equal(await gmail.dispatchOne(), true);
    assert.equal(await gmail.dispatchOne(), false);
    const { rows: [enriched] } = await db.query(
      'SELECT n.provider,n.reported_institution,n.transaction_time,n.card_last4,t.amount_minor::text,t.description,t.category ' +
      "FROM notices n JOIN transactions t ON t.notice_id=n.id WHERE n.message_id='registered-details'",
    );
    assert.deepEqual(enriched, { provider: 'bancolombia', reported_institution: 'bancolombia', transaction_time: '14:42',
      card_last4: '1234', amount_minor: '1250000', description: 'Descripción conservada del usuario', category: 'otros' });
    assert.equal(readIds.filter(id => id === 'user-confirmed').length, 0);
    assert.equal(readIds.filter(id => id === 'registered-details').length, 1);
    await finishScan();
    // A bank receipt can legitimately lack a time. Do not reread it every day for the same rules version.
    await db.query("UPDATE notices SET transaction_time=NULL WHERE message_id='registered-details'");
    await makeDue();
    await gmail.reconcileOne();
    await gmail.scanReprocessPage();
    assert.equal(await gmail.dispatchOne(), false);
    assert.equal(readIds.filter(id => id === 'registered-details').length, 1);
    await finishScan();
  });

  await t.test('concurrent workers share one durable classifier slot without consuming deferred attempts', async () => {
    ids = ['queued-model-a', 'queued-model-b'];
    await makeDue();
    await gmail.reconcileOne();
    await gmail.scanReprocessPage();
    const otherWorker = new Gmail(db, config, new GmailExtraction(config), results);
    const postedBefore = posted.length;
    await Promise.all([gmail.dispatchOne(), otherWorker.dispatchOne()]);
    assert.equal(posted.length, postedBefore + 1, 'Only one worker may submit to the local model');
    const claimed = (await db.query('SELECT message_id,attempts,attempt_id,webhook_accepted_at,completed_at FROM gmail_deliveries ' +
      'WHERE message_id=ANY($1) ORDER BY attempts', [ids])).rows;
    assert.equal(claimed[0].attempts, 0, 'Waiting for model capacity is not a failed delivery attempt');
    assert.equal(claimed[0].attempt_id, null);
    assert.equal(claimed[0].webhook_accepted_at, null);
    assert.equal(claimed[0].completed_at, null);
    assert.equal(claimed[1].attempts, 1);
    assert(claimed[1].webhook_accepted_at);
    const complete = async (identity: Record<string, unknown>) => results.save({ source: 'oauth',
      deliveryId: identity.deliveryId as string, attemptId: identity.attemptId as string,
      messageId: identity.messageId as string, receivedAt: identity.receivedAt as string, status: 'ignored' });
    await complete(posted.at(-1)!);
    await db.query('UPDATE gmail_deliveries SET due_at=now() WHERE message_id=$1', [claimed[0].message_id]);
    await new Gmail(db, config, new GmailExtraction(config), results).dispatchOne();
    assert.equal(posted.length, postedBefore + 2, 'A new worker continues after the persisted slot is released');
    const second = posted.at(-1)!;
    // A missing callback records an actionable cause and still obeys the delivery attempt bound.
    await db.query('UPDATE gmail_deliveries SET due_at=now() WHERE message_id=$1', [second.messageId]);
    await otherWorker.dispatchOne();
    assert.equal((await row(second.messageId as string)).last_error, 'callback_timeout');
    await complete(posted.at(-1)!);
    assert.equal((await row(second.messageId as string)).last_error, null);
    await finishScan();
  });

  await t.test('deterministic reviews refresh exact transfer evidence without waiting for an unavailable model', async () => {
    const day = received.setLocale('es').toFormat("d 'de' LLLL 'de' yyyy");
    const bankDay = received.toFormat('dd/MM/yy');
    const nequi = 'notificaciones@nequi.com.co';
    const bank = 'alertasynotificaciones@an.notificacionesbancolombia.com';
    const cases = [
      { id: 'review-income', sender: nequi, subject: '¡Recibiste plata por Bre-B!',
        body: `Recibiste 615.000 de PERSONA PRUEBA el ${day} a las 10:29 p.m, desde el banco Davivienda.`,
        amount: '61500000', direction: 'income', time: '22:29', method: 'Bre-B', provider: 'nequi' },
      { id: 'review-send-small', sender: nequi, subject: '¡Enviaste plata por Bre-B!',
        body: `Enviaste de manera exitosa 80.000 a la llave 0090465666 de JUAN PRUEBA el ${day} a la 1:12 a.m.`,
        amount: '8000000', direction: 'expense', time: '01:12', method: 'Bre-B', provider: 'nequi' },
      { id: 'review-send-large', sender: nequi, subject: '¡Enviaste plata por Bre-B!',
        body: `Enviaste de manera exitosa 440.000 a la llave 0090465666 de JUAN PRUEBA el ${day} a las 4:13 a.m.`,
        amount: '44000000', direction: 'expense', time: '04:13', method: 'Bre-B', provider: 'nequi' },
      { id: 'review-short-date-breb', sender: bank, subject: 'Transferencia Bre-B',
        body: `Bancolombia: Transferiste $68.000 por Bre-B el ${bankDay} a las 22:14.`,
        amount: '6800000', direction: 'expense', time: '22:14', method: 'Bre-B', provider: 'bancolombia' },
      { id: 'review-short-date-transfer', sender: bank, subject: 'Alertas y Notificaciones',
        body: `Bancolombia: Transferiste $5.000 a PERSONA PRUEBA el ${bankDay} a las 15:23.`,
        amount: '500000', direction: 'expense', time: '15:23', method: null, provider: 'bancolombia' },
    ];
    const encode = (sender: string, subject: string, body: string, authenticated = true) => Buffer.from(
      'From: <' + sender + '>\r\nSubject: ' + subject + '\r\n' +
      (authenticated ? 'Authentication-Results: mx.google.com; dmarc=pass header.from=' + sender.split('@')[1] + '\r\n' : '') +
      'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n' + body,
    ).toString('base64url');
    for (const item of cases) {
      await db.query('INSERT INTO notices (mailbox_id,message_id,received_at,provider,forwarded,status,reason) ' +
        "VALUES ($1,$2,$3,'other',false,'pending','missing_or_ambiguous_fields')", [mailbox.id, item.id, received.toJSDate()]);
      rawById.set(item.id, encode(item.sender, item.subject, item.body));
    }
    const guards = [
      { id: 'review-own-transfer', sender: bank, subject: 'Transferencia realizada',
        body: `Bancolombia: Transferiste $20.000 entre tus cuentas propias el ${bankDay} a las 10:00.` },
      { id: 'review-untrusted', sender: bank, subject: 'Compra realizada', authenticated: false,
        body: `Bancolombia: Compraste $30.000 en TIENDA DEMO con tu T.Deb *1234, el ${bankDay} a las 11:00.` },
      { id: 'review-credit', sender: 'servicios@agaval.com.co', subject: 'Pago realizado con tu crédito Agaval',
        body: `Acabas de pagar por medio de tu crédito Agaval una compra realizada el ${received.toFormat('dd/MM/yyyy')}. Valor total de los bienes: $50.000.` },
    ];
    for (const item of guards) rawById.set(item.id, encode(item.sender, item.subject, item.body, item.authenticated));
    ids = [...cases, ...guards].map(item => item.id);
    webhookStatus = 503;
    const postedBefore = posted.length;
    const movementsBefore = (await db.query('SELECT count(*)::int AS total FROM transactions')).rows[0].total;
    await gmail.reprocessMonth(owner.id, mailbox.id);
    await gmail.scanReprocessPage();
    for (const _ of ids) assert.equal(await gmail.dispatchOne(), true);
    assert.equal(await gmail.dispatchOne(), false);
    assert.equal(posted.length, postedBefore, 'A model cannot override these review guards and must not block their evidence');
    for (const item of cases) {
      const saved = (await db.query('SELECT provider,status,reason,reported_amount_minor::text,reported_currency,' +
        'reported_transaction_date::text,reported_direction,transaction_time,reported_payment_method FROM notices WHERE message_id=$1', [item.id])).rows[0];
      assert.deepEqual(saved, {
        provider: item.provider, status: 'pending', reason: 'unconfirmed_extraction', reported_amount_minor: item.amount,
        reported_currency: 'COP', reported_transaction_date: received.toISODate(), reported_direction: item.direction,
        transaction_time: item.time, reported_payment_method: item.method,
      }, item.id);
      assert.equal((await row(item.id)).outcome, 'pending');
    }
    for (const item of guards) {
      const saved = (await db.query('SELECT status,reason FROM notices WHERE message_id=$1', [item.id])).rows[0];
      assert.deepEqual(saved, { status: 'pending', reason: 'unconfirmed_extraction' }, item.id);
    }
    assert.equal((await db.query('SELECT count(*)::int AS total FROM transactions')).rows[0].total, movementsBefore,
      'Review evidence never invents or mutates an economic movement');
    await finishScan();
    webhookStatus = 202;
  });

  await t.test('a registered transfer is enriched locally while preserving its financial values', async () => {
    for (const mode of ['plain', 'alternative', 'alternative-reversed']) {
      const id = 'registered-transfer-review-' + mode;
      const sender = 'alertasynotificaciones@an.notificacionesbancolombia.com';
      const body = 'Bancolombia: Recibiste una transferencia por $35.000 el ' + received.toFormat('dd/MM/yy') + ' a las 21:11.';
      const header = 'From: <' + sender + '>\r\nSubject: Alertas y Notificaciones\r\n' +
        'Authentication-Results: mx.google.com; dmarc=pass header.from=notificacionesbancolombia.com\r\nMIME-Version: 1.0\r\n';
      const incompleteBody = 'Bancolombia: Recibiste una transferencia. Consulta el detalle en la versión HTML.';
      const message = Buffer.from(header + (mode === 'plain' ? 'Content-Type: text/plain; charset=UTF-8\r\n\r\n' + body :
        'Content-Type: multipart/alternative; boundary=banknotice\r\n\r\n' +
        '--banknotice\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n' + (mode === 'alternative' ? incompleteBody : body) + '\r\n' +
        '--banknotice\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n<p>' + (mode === 'alternative' ? body : incompleteBody) + '</p>\r\n--banknotice--\r\n'));
      rawById.set(id, message.toString('base64url'));
      if (mode === 'alternative') {
        const parsed = await readGmailMime(message, ['INBOX']);
        const extractor = new GmailExtraction(config);
        const plain = await extractor.classify(parsed.email, false, parsed.authenticated, received.toISO()!);
        const html = await extractor.classify({ ...parsed.email, text: parsed.alternative! }, false, parsed.authenticated, received.toISO()!);
        assert.equal(plain.status, 'pending');
        assert.equal(html.status, 'pending');
        if (plain.status === 'pending' && html.status === 'pending') {
          assert.deepEqual(plain.unconfirmedFields, []);
          assert.deepEqual(html.unconfirmedFields, []);
          assert.equal(plain.evidence?.amountMinor, undefined);
          assert.equal(html.evidence?.amountMinor, '3500000');
        }
      }
      const { rows: [notice] } = await db.query<{ id: string }>(
        'INSERT INTO notices (mailbox_id,message_id,received_at,provider,forwarded,status,transaction_time,reported_payment_method) ' +
        "VALUES ($1,$2,$3,'other',false,'registered','21:11','Transferencia') RETURNING id", [mailbox.id, id, received.toJSDate()]);
      await db.query('INSERT INTO transactions (notice_id,amount_minor,currency,transaction_date,payment_method,description,category,direction) ' +
        "VALUES ($1,3500000,'COP',$2,'Transferencia','Descripción conservada','ingresos','income')", [notice.id, received.toISODate()]);
      const postedBefore = posted.length;
      const finances = () => db.query('SELECT amount_minor::text,currency,transaction_date::text,payment_method,description,category,direction ' +
        'FROM transactions WHERE notice_id=$1', [notice.id]);
      const original = (await finances()).rows[0];
      ids = [id];
      await gmail.reprocessMonth(owner.id, mailbox.id);
      await gmail.scanReprocessPage();
      assert.equal(await gmail.dispatchOne(), true);
      assert.equal((await row(id)).outcome, 'skipped');
      assert.equal(posted.length, postedBefore);
      assert.deepEqual((await finances()).rows[0], original);
      assert.deepEqual((await db.query('SELECT provider,reported_institution,status,transaction_time FROM notices WHERE id=$1', [notice.id])).rows[0],
        { provider: 'bancolombia', reported_institution: 'bancolombia', status: 'registered', transaction_time: '21:11' });
      await finishScan();
    }
  });

  await t.test('MIME alternatives keep complementary evidence separate and refuse contradictory financial values', async () => {
    const date = received.toFormat('dd/MM/yy');
    const original = `Bancolombia: Recibiste una transferencia por $35.000 el ${date} a las 21:11.`;
    const cases = [
      { id: 'mime-amount-conflict', plain: original, html: original.replace('$35.000', '$45.000'), amount: null, date: null },
      { id: 'mime-date-conflict', plain: original,
        html: original.replace(date, received.minus({ days: 1 }).toFormat('dd/MM/yy')), amount: null, date: null },
      { id: 'mime-complementary', plain: 'Bancolombia: Recibiste una transferencia por $35.000.',
        html: `Bancolombia: Recibiste una transferencia el ${date}.`, amount: '3500000', date: null },
      { id: 'mime-pending-registered-conflict', plain: original,
        html: `Bancolombia: Compraste $35.000 en TIENDA DEMO con tu T.Deb *1234, el ${date} a las 21:11.`, amount: null, date: null },
    ];
    for (const item of cases) rawById.set(item.id, Buffer.from([
      'From: <alertasynotificaciones@an.notificacionesbancolombia.com>', 'Subject: Alertas y Notificaciones',
      'Authentication-Results: mx.google.com; dmarc=pass header.from=notificacionesbancolombia.com', 'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary=review', '',
      '--review', 'Content-Type: text/plain; charset=UTF-8', '', item.plain,
      '--review', 'Content-Type: text/html; charset=UTF-8', '', '<p>' + item.html + '</p>', '--review--', '',
    ].join('\r\n')).toString('base64url'));
    const movementsBefore = (await db.query('SELECT count(*)::int AS total FROM transactions')).rows[0].total;
    const postedBefore = posted.length;
    ids = cases.map(item => item.id);
    await gmail.reprocessMonth(owner.id, mailbox.id);
    await gmail.scanReprocessPage();
    for (const _ of ids) assert.equal(await gmail.dispatchOne(), true);
    for (const item of cases) assert.deepEqual((await db.query(
      'SELECT status,reason,reported_amount_minor::text,reported_transaction_date::text FROM notices WHERE message_id=$1', [item.id])).rows[0],
    { status: 'pending', reason: 'unconfirmed_extraction', reported_amount_minor: item.amount, reported_transaction_date: item.date }, item.id);
    assert.equal((await db.query('SELECT count(*)::int AS total FROM transactions')).rows[0].total, movementsBefore);
    assert.equal(posted.length, postedBefore);
    await finishScan();
  });

  await t.test('a storage failure is diagnosable from mailbox status without exposing private values', async s => {
    ids = ['storage-diagnostic'];
    rawById.set(ids[0], rawById.get('registered-details')!);
    await makeDue();
    await gmail.reconcileOne();
    await gmail.scanReprocessPage();
    s.mock.method(results, 'save', async () => { throw Object.assign(new Error('secret row contents'), { code: '23514' }); });
    await gmail.dispatchOne();
    const diagnostic = (await gmail.list(owner.id))[0].delivery as { lastError: string; retrying: number };
    assert.equal(diagnostic.lastError, 'gmail_processing_failed:store_result:23514');
    assert.equal(diagnostic.retrying, 1);
    assert.doesNotMatch(JSON.stringify(diagnostic), /secret|row contents/);
  });
});
