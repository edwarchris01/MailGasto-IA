import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { readConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { Finance, movementFilters } from '../src/finance.js';
import { GmailResults, gmailResult } from '../src/gmail-results.js';
import { History, historySchema } from '../src/history.js';

const connection = process.env.MAILGASTO_TEST_DATABASE_URL;
test('Gmail persists truthful date provenance and preserves corrections, duplicates and user decisions', { skip: !connection }, async t => {
  const url = new URL(connection!);
  assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.match(url.pathname, /^\/mailgasto_test$/);
  const admin = new Pool({ connectionString: url.href });
  const schema = 'date_source_' + randomUUID().replaceAll('-', '');
  await admin.query('CREATE SCHEMA ' + schema);
  url.searchParams.set('options', '-c search_path=' + schema);
  const config = readConfig({ DATABASE_URL: url.href, ENCRYPTION_KEY: 'ab'.repeat(32),
    N8N_AGENT_KEY: 'local-date-source-agent-key-only', N8N_INGEST_KEY: 'local-date-source-ingest-key-only',
    SMTP_URL: 'smtp://localhost:1026', SMTP_FROM: 'fixture@example.test' });
  const db = new Database(config);
  t.after(async () => { await db.onApplicationShutdown(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); });
  await db.migrate();
  const finance = new Finance(db);
  const history = new History(db, undefined as never, finance);
  const results = new GmailResults(db, config);
  const { rows: [account] } = await db.query("INSERT INTO accounts(email,name,verified_at) VALUES('date-source@example.test','Fixture',now()) RETURNING id");
  const { rows: [mailbox] } = await db.query("INSERT INTO mailboxes(account_id,email,source,state,linked_at) VALUES($1,'dates@example.test','oauth','active','2026-11-01') RETURNING id,generation", [account.id]);
  const { rows: [run] } = await db.query("INSERT INTO gmail_reprocess_runs(mailbox_id,from_at,to_at) VALUES($1,'2026-11-01','2026-12-01') RETURNING id", [mailbox.id]);
  const fixture = async (amountMinor: string, extra: Record<string, unknown> = {}, receivedAt = '2026-11-16T02:04:05.000Z') => {
    const messageId = randomUUID(), attemptId = randomUUID();
    const { rows: [delivery] } = await db.query('INSERT INTO gmail_deliveries(mailbox_id,generation,message_id,attempt_id,received_at,reprocess_id,attempts,authenticated,forwarded) ' +
      'VALUES($1,$2,$3,$4,$5,$6,1,true,false) RETURNING id', [mailbox.id, mailbox.generation, messageId, attemptId, receivedAt, run.id]);
    const result = gmailResult.parse({ source: 'oauth', deliveryId: delivery.id, attemptId, messageId, receivedAt,
      provider: 'bancolombia', forwarded: false, status: 'registered', confidence: 1,
      movement: { amountMinor, currency: 'COP', date: '2026-11-16', dateSource: 'received_at', transactionTime: '00:00',
        paymentMethod: 'Transferencia', description: 'Transferencia', category: 'otros', direction: 'expense', ...extra } });
    const read = async () => (await db.query('SELECT n.id,n.status,n.reason,n.date_source,n.reported_transaction_date::text,n.transaction_time,' +
      't.id AS movement_id,t.amount_minor::text,t.transaction_date::text,t.description,t.category,t.direction ' +
      'FROM notices n LEFT JOIN transactions t ON t.notice_id=n.id WHERE n.mailbox_id=$1 AND n.message_id=$2', [mailbox.id, messageId])).rows[0];
    return { result, read, messageId, delivery };
  };

  await t.test('receipt fallback uses the delivery date and clock in Bogota and stays explicit in both APIs', async () => {
    const f = await fixture('61500000', { direction: 'income', category: 'ingresos' });
    await results.save(f.result);
    const stored = await f.read();
    assert.equal(stored.status, 'registered');
    assert.equal(stored.date_source, 'received_at');
    assert.equal(stored.transaction_date, '2026-11-15');
    assert.equal(stored.transaction_time, '21:04:05');
    assert.equal(stored.reported_transaction_date, null);
    assert.equal((await results.save(f.result)).outcome, 'duplicate');
    const detail = await finance.detail(account.id, stored.movement_id) as Record<string, unknown>;
    assert.equal(detail.date_source, 'received_at');
    assert.equal(new Date(detail.received_at as string).toISOString(), f.result.receivedAt);
    assert.equal(detail.transaction_time, '21:04:05');
    const listed = await finance.list(account.id, movementFilters.parse({}));
    assert.equal(listed.items.find(row => row.id === stored.movement_id)?.date_source, 'received_at');
    assert.equal((await history.detail(account.id, stored.id)).date_source, 'received_at');
    assert.equal((await history.list(account.id, historySchema.parse({}))).items.find(row => row.id === stored.id)?.date_source, 'received_at');
    await finance.correctEmailMovement(account.id, stored.movement_id, { revision: 0, date: '2026-11-14' });
    const corrected = await finance.detail(account.id, stored.movement_id) as Record<string, unknown>;
    assert.equal(corrected.transaction_date, '2026-11-14');
    assert.equal(corrected.original_transaction_date, '2026-11-15');
    assert.equal(corrected.date_source, 'received_at', 'Provenance refers to the original extraction, not the user correction');
  });

  await t.test('an explicit date without a clock keeps the operation time unknown', async () => {
    const f = await fixture('1700000', { date: '2026-11-12', dateSource: 'reported', transactionTime: null });
    await results.save(f.result);
    const stored = await f.read();
    assert.equal(stored.date_source, 'reported');
    assert.equal(stored.transaction_date, '2026-11-12');
    assert.equal(stored.reported_transaction_date, '2026-11-12');
    assert.equal(stored.transaction_time, null);
  });

  await t.test('different receipt clocks do not prove two different bank operations', async () => {
    const first = await fixture('2000000');
    await results.save(first.result);
    assert.equal((await first.read()).status, 'registered');
    const copy = await fixture('2000000', {}, '2026-11-16T03:10:00.000Z');
    await results.save(copy.result);
    const stored = await copy.read();
    assert.equal(stored.status, 'pending');
    assert.equal(stored.reason, 'possible_duplicate');
    assert.equal(stored.movement_id, null);
    assert.equal(stored.date_source, 'received_at');
  });

  await t.test('registered user decisions and discarded notices survive reprocessing', async () => {
    for (const status of ['registered', 'discarded']) {
      const f = await fixture(status === 'registered' ? '3000000' : '3100000');
      const { rows: [notice] } = await db.query('INSERT INTO notices(mailbox_id,message_id,received_at,provider,forwarded,status,reason) ' +
        "VALUES($1,$2,$3,'other',false,$4,$5) RETURNING id", [mailbox.id, f.messageId, f.result.receivedAt, status,
        status === 'registered' ? 'user_confirmed' : 'user_discarded']);
      if (status === 'registered') await db.query('INSERT INTO transactions(notice_id,amount_minor,currency,transaction_date,description,category,direction) ' +
        "VALUES($1,3000000,'COP','2026-11-15','Conservar usuario','otros','expense')", [notice.id]);
      const before = await f.read();
      await results.save(f.result, { verifiedBank: true });
      assert.deepEqual(await f.read(), before);
    }
  });

  await t.test('a receipt-date fallback on an Aval copy cannot defeat its strong operation reference', async () => {
    const reference = 'aval-bre-b:1234567890ab';
    const original = await fixture('2300000', { date: '2026-11-12', dateSource: 'reported', paymentMethod: 'Bre-B' });
    await results.save(gmailResult.parse({ ...original.result, references: [reference] }));
    assert.equal((await original.read()).status, 'registered');
    const copy = await fixture('2300000');
    const result = gmailResult.parse({ source: 'oauth', deliveryId: copy.result.deliveryId, attemptId: copy.result.attemptId,
      messageId: copy.messageId, receivedAt: copy.result.receivedAt, provider: 'other', forwarded: false,
      status: 'pending', reason: 'missing_or_ambiguous_fields', confidence: 0, avalCopy: true, references: [reference],
      evidence: { date: '2026-11-16', dateSource: 'received_at', paymentMethod: 'Bre-B', amountMinor: '2300000', currency: 'COP' } });
    assert.equal((await results.save(result)).outcome, 'duplicate');
    assert.equal(await copy.read(), undefined, 'The late-arriving receipt copy must not create a review notice or another movement');
  });

  await t.test('verified rejected or cancelled messages remove stale pending and error notices without creating movements', async () => {
    for (const status of ['pending', 'error']) {
      const f = await fixture('1900000');
      await db.query('INSERT INTO notices(mailbox_id,message_id,received_at,provider,forwarded,status,reason,date_source) ' +
        "VALUES($1,$2,$3,'bancolombia',false,$4,$5,'received_at')", [mailbox.id, f.messageId, f.result.receivedAt, status,
        status === 'error' ? 'extractor_unavailable' : 'unconfirmed_extraction']);
      await results.save({ source: 'oauth', deliveryId: f.result.deliveryId, attemptId: f.result.attemptId,
        messageId: f.messageId, receivedAt: f.result.receivedAt, status: 'ignored' }, { explicitNonMovement: true });
      const stored = await f.read();
      assert.equal(stored.status, 'discarded');
      assert.equal(stored.reason, 'not_transaction');
      assert.equal(stored.date_source, null);
      assert.equal(stored.movement_id, null);
    }
  });
});
