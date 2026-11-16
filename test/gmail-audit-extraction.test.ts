import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { GmailResults, gmailResult } from '../src/gmail-results.js';
import { candidate, gmailBankSenders, isGmailExplicitNonMovement, resolveGmailExtraction } from '../src/mail-rules.js';

test('Nequi receipt keeps the merchant when HTML folds its heading and payment into one line', () => {
  const lines = [
    'Listo tu pago en Claro', 'Pagaste con Nequi tu factura por $35.000', 'Estado: Exitoso',
    'Comprobante de Pago', 'Nombre: No aplica', 'Cel: 3145555555', 'Fecha: 14/Nov/2026',
    'Paquete: 30 GB+MNSMS+APPSX30D', 'Valor: $35.000',
  ];
  for (const separator of ['\n', ' ']) {
    const notice = candidate('somos@nequi.com.co', 'Comprobante de Pago Claro', lines.join(separator), gmailBankSenders, true);
    assert.ok(notice);
    const result = resolveGmailExtraction(notice, null, true);
    assert.equal(result.status, 'registered');
    assert.deepEqual(result.movement, {
      amountMinor: '3500000', currency: 'COP', date: '2026-11-14', paymentMethod: 'Nequi',
      description: 'Claro', direction: 'expense', category: 'otros',
      transactionTime: null, cardType: null, cardLast4: null, reportedInstitution: null,
      dateSource: 'reported',
    });
    assert.doesNotMatch(notice.body, /3145555555/);
  }
});

test('Nequi Bre-B receipt registers the real incoming cash flow without requiring a purpose', () => {
  const notice = candidate('notificaciones@nequi.com.co', '¡Recibiste plata por Bre-B!',
    'Recibiste 615.000 de PERSONA PRUEBA el 1 de noviembre de 2026 a las 10:29 p.m, desde el banco Davivienda. ' +
    'Revisa el detalle en los movimientos de tu app o descarga el comprobante si lo necesitas.', gmailBankSenders, true);
  assert.ok(notice);
  const result = resolveGmailExtraction(notice, null, true);
  assert.equal(result.status, 'registered');
  assert.deepEqual(result.movement, {
    amountMinor: '61500000', currency: 'COP', date: '2026-11-01', direction: 'income', paymentMethod: 'Bre-B',
    transactionTime: '22:29', cardType: null, cardLast4: null, reportedInstitution: null,
    dateSource: 'reported', category: 'ingresos', description: 'Ingreso · Bre-B',
  });
});

test('rejected Nu purchases and unpaid invoices cannot become movements', () => {
  for (const [sender, subject, body] of [
    ['avisos@nu.com.co', 'Faltan fondos para pagar en GOOGLE *Comercio', 'Tu compra por $19.900,00 se rechazó por falta de fondos en tu Cuenta.'],
    ['facturas@servicios.example', 'Llegó tu factura', 'Llegó tu factura del mes de noviembre de 2026. Valor a pagar $921.089,00. Fecha límite de pago 30/11/2026.'],
  ]) {
    const notice = candidate(sender, subject, body, gmailBankSenders, true);
    if (notice) assert.notEqual(resolveGmailExtraction(notice, null, true).status, 'registered');
  }
});

test('rejected Nu purchases are explicitly ignored so stale pending notices can be discarded', () => {
  const subject = 'Faltan fondos para pagar en GOOGLE *Crunchyroll An';
  const body = 'Tu compra por $19.900,00 se rechazó por falta de fondos en tu Cuenta.';
  assert.equal(candidate('avisos@nu.com.co', subject, body, gmailBankSenders, true), null);
  assert.equal(isGmailExplicitNonMovement(subject, body), true);
});

test('marketing delivery footer is not proof that the recipient received money', () => {
  const subject = 'Promos en tu restaurante top';
  const body = 'Recibiste este mail porque eres nuestro usuario. Copyright © RAPPI S.A.S. Todos los derechos reservados.';
  assert.equal(candidate('promos@rappi.com', subject, body, gmailBankSenders, true), null);
  assert.equal(isGmailExplicitNonMovement(subject, body), true);
  const receipt = 'Compraste $25.000 en RESTAURANTE DEMO con tu T.Deb *1234, el 14/11/2026 a las 12:30. ' + body;
  const notice = candidate('alertasynotificaciones@an.notificacionesbancolombia.com', 'Compra realizada', receipt, gmailBankSenders, true);
  assert.ok(notice);
  assert.equal(resolveGmailExtraction(notice, null, true).status, 'registered');
  assert.equal(isGmailExplicitNonMovement('Compra realizada', receipt), false);
});

test('employment alerts are non-movements even when cargo means job role or the offer contains a salary', () => {
  const subject = 'Ingeniero de software: Inter Rapidísimo ha contratado a profesionales cerca de ti';
  const observed = 'PERSONA PRUEBA, Inter Rapidísimo es una de las empresas destacadas que buscan personal para el puesto de Ingeniero de software.\n' +
    'Tendencias de la última semana en empleos de Ingeniero de software\nEmpresas que buscan personal para tu cargo\n' +
    'Las empresas de mayor tendencia\nEste email está dirigido a PERSONA PRUEBA (Desarrollador Backend)\n' +
    'Recibes emails sobre notificaciones de LinkedIn.';
  const salary = 'Empresas que buscan personal para tu cargo. Salario: COP 5.000.000 a COP 7.000.000. Publicado el 13/11/2026.';
  for (const [title, body] of [[subject, observed], ['Vacantes de ingeniería', salary],
    ['Actualizaciones de tu cargo', 'Recibes emails sobre notificaciones de LinkedIn.']]) {
    assert.equal(candidate('messages-noreply@linkedin.com', title, body, gmailBankSenders, true), null, title);
    assert.equal(isGmailExplicitNonMovement(title, body), true, title);
    assert.equal(resolveGmailExtraction({ provider: 'other', forwarded: false, subject: title, body },
      null, true, undefined, '2026-11-13T22:01:24Z').status, 'ignored', title);
  }
});

test('a synthetic paid LinkedIn Premium receipt survives the same notification footer', () => {
  const subject = 'Recibo de pago de LinkedIn Premium';
  const body = 'Tu pago fue procesado. Pagaste COP 49.900 por LinkedIn Premium el 13/11/2026.\n' +
    'Empresas que buscan personal para tu cargo\nRecibes emails sobre notificaciones de LinkedIn.';
  const notice = candidate('messages-noreply@linkedin.com', subject, body, gmailBankSenders, true);
  assert.ok(notice);
  assert.equal(isGmailExplicitNonMovement(subject, body), false);
  const result = resolveGmailExtraction(notice, null, true, undefined, '2026-11-13T22:01:24Z');
  assert.equal(result.status, 'registered');
  assert.deepEqual([result.movement?.amountMinor, result.movement?.currency, result.movement?.direction,
    result.movement?.date, result.movement?.dateSource], ['4990000', 'COP', 'expense', '2026-11-13', 'reported']);
});

test('Nequi outgoing Bre-B registers bare amounts and Spanish dates without requiring a purpose', () => {
  for (const [amount, clock, expectedTime] of [['80.000', 'a la 1:12 a.m.', '01:12'], ['440.000', 'a las 4:13 a.m.', '04:13']]) {
    const notice = candidate('notificaciones@nequi.com.co', '¡Enviaste plata por Bre-B!',
      `Enviaste de manera exitosa ${amount} a la llave 0090465666 de JUAN PRUEBA el 2 de noviembre de 2026 ${clock} ` +
      'Recuerda que también puedes usar la llave que elegiste con Nequi para recibir plata de otros bancos de manera rápida y fácil 24/7.',
      gmailBankSenders, true);
    assert.ok(notice);
    const result = resolveGmailExtraction(notice, null, true);
    assert.equal(result.status, 'registered');
    assert.equal(result.movement?.amountMinor, amount.replace('.', '') + '00');
    assert.equal(result.movement?.currency, 'COP');
    assert.equal(result.movement?.date, '2026-11-02');
    assert.equal(result.movement?.dateSource, 'reported');
    assert.equal(result.movement?.transactionTime, expectedTime);
    assert.equal(result.movement?.paymentMethod, 'Bre-B');
    assert.equal(result.movement?.direction, 'expense');
    assert.equal(result.movement?.category, 'otros');
  }
});

const connection = process.env.MAILGASTO_TEST_DATABASE_URL;
test('reprocessing distinguishes bank operation times and preserves ambiguous and strong-reference deduplication', { skip: !connection }, async t => {
  assert.match(new URL(connection!).pathname, /^\/mailgasto_test$/);
  const config = readConfig({
    DATABASE_URL: connection, ENCRYPTION_KEY: 'ab'.repeat(32),
    N8N_AGENT_KEY: 'local-audit-agent-key-for-testing-only', N8N_INGEST_KEY: 'local-audit-ingest-key-for-testing-only',
    SMTP_URL: 'smtp://localhost:1026', SMTP_FROM: 'test@example.test',
  });
  const db = new Database(config);
  await db.migrate();
  const account = randomUUID();
  t.after(async () => {
    try { await db.query('DELETE FROM accounts WHERE id=$1', [account]); }
    finally { await db.onApplicationShutdown(); }
  });
  await db.query('INSERT INTO accounts(id,email,name,password_hash,verified_at) VALUES($1,$2,$3,$4,now())',
    [account, 'audit-' + account + '@example.test', 'Audit fixture', 'unused']);
  const { rows: [mailbox] } = await db.query<{ id: string; generation: string }>(
    "INSERT INTO mailboxes(account_id,email,source,state,linked_at) VALUES($1,$2,'oauth','active','2026-11-01') RETURNING id,generation",
    [account, 'mailbox-' + account + '@example.test']);
  const { rows: [run] } = await db.query<{ id: string }>(
    "INSERT INTO gmail_reprocess_runs(mailbox_id,from_at,to_at) VALUES($1,'2026-11-01','2026-12-01') RETURNING id", [mailbox.id]);
  const service = new GmailResults(db, config);
  const submit = async (time: string | null, extra: Record<string, unknown> = {}, amountMinor = '3500000') => {
    const messageId = randomUUID();
    const attemptId = randomUUID();
    const receivedAt = '2026-11-14T20:00:00.000Z';
    const { rows: [delivery] } = await db.query<{ id: string }>(
      'INSERT INTO gmail_deliveries(mailbox_id,generation,message_id,attempt_id,received_at,reprocess_id,attempts,authenticated,forwarded) ' +
      'VALUES($1,$2,$3,$4,$5,$6,1,true,false) RETURNING id', [mailbox.id, mailbox.generation, messageId, attemptId, receivedAt, run.id]);
    const result = gmailResult.parse({
      source: 'oauth', deliveryId: delivery.id, attemptId, messageId, receivedAt,
      provider: 'bancolombia', forwarded: false, status: 'registered', confidence: 1,
      movement: { amountMinor, currency: 'COP', date: '2026-11-14', transactionTime: time,
        paymentMethod: 'Tarjeta', description: 'TIENDA DEMO', category: 'compras', direction: 'expense' },
      ...extra,
    });
    const response = await service.save(result);
    const { rows: [notice] } = await db.query<{ status: string; reason: string | null }>(
      'SELECT status,reason FROM notices WHERE mailbox_id=$1 AND message_id=$2', [mailbox.id, messageId]);
    return { response, notice, result, delivery };
  };
  const first = await submit('08:00:30');
  assert.equal(first.notice.status, 'registered');
  const later = await submit('09:10');
  assert.equal(later.notice.status, 'registered');
  assert.equal((await service.save(later.result)).outcome, 'duplicate');
  assert.equal((await submit('08:00')).notice.reason, 'possible_duplicate');
  assert.equal((await submit(null)).notice.reason, 'possible_duplicate');
  assert.equal((await submit('10:10', { provider: 'nequi' })).notice.reason, 'possible_duplicate');
  const strong = { references: ['pse:123456789'] };
  assert.equal((await submit('11:00', strong, '4500000')).notice.status, 'registered');
  const duplicate = await submit('12:00', strong, '4500000');
  assert.equal(duplicate.response.outcome, 'duplicate');
  assert.equal(duplicate.notice, undefined);
  const { rows: [completed] } = await db.query<{ outcome: string; last_error: string | null }>(
    'SELECT outcome,last_error FROM gmail_deliveries WHERE id=$1', [later.delivery.id]);
  assert.deepEqual(completed, { outcome: 'registered', last_error: null });
});

test('verified reprocessing enriches missing registered metadata while preserving financial data, corrections and manual confirmations',
  { skip: !connection }, async t => {
    assert.match(new URL(connection!).pathname, /^\/mailgasto_test$/);
    const config = readConfig({
      DATABASE_URL: connection, ENCRYPTION_KEY: 'ab'.repeat(32),
      N8N_AGENT_KEY: 'local-enrichment-agent-key-for-testing-only', N8N_INGEST_KEY: 'local-enrichment-ingest-key-for-testing-only',
      SMTP_URL: 'smtp://localhost:1026', SMTP_FROM: 'test@example.test',
    });
    const db = new Database(config);
    await db.migrate();
    const account = randomUUID();
    t.after(async () => {
      try { await db.query('DELETE FROM accounts WHERE id=$1', [account]); }
      finally { await db.onApplicationShutdown(); }
    });
    await db.query('INSERT INTO accounts(id,email,name,password_hash,verified_at) VALUES($1,$2,$3,$4,now())',
      [account, 'enrich-' + account + '@example.test', 'Enrichment fixture', 'unused']);
    const { rows: [mailbox] } = await db.query<{ id: string; generation: string }>(
      "INSERT INTO mailboxes(account_id,email,source,state,linked_at) VALUES($1,$2,'oauth','active','2026-11-01') RETURNING id,generation",
      [account, 'mailbox-' + account + '@example.test']);
    const { rows: [run] } = await db.query<{ id: string }>(
      "INSERT INTO gmail_reprocess_runs(mailbox_id,from_at,to_at) VALUES($1,'2026-11-01','2026-12-01') RETURNING id", [mailbox.id]);
    const service = new GmailResults(db, config);
    const evidence = {
      amountMinor: '61500000', currency: 'COP', date: '2026-11-01', direction: 'income',
      paymentMethod: 'Bre-B', transactionTime: '22:29',
    };
    const fixture = async (reason: string | null = null) => {
      const messageId = randomUUID();
      const attemptId = randomUUID();
      const receivedAt = '2026-11-02T03:29:00.000Z';
      const { rows: [notice] } = await db.query<{ id: string }>(
        "INSERT INTO notices(mailbox_id,message_id,received_at,provider,forwarded,status,reason) VALUES($1,$2,$3,'other',false,'registered',$4) RETURNING id",
        [mailbox.id, messageId, receivedAt, reason]);
      const { rows: [movement] } = await db.query<{ id: string }>(
        "INSERT INTO transactions(notice_id,amount_minor,currency,transaction_date,payment_method,description,category,direction) " +
        "VALUES($1,61500000,'COP','2026-11-01',NULL,'Descripción conservada','ingresos','income') RETURNING id", [notice.id]);
      const { rows: [delivery] } = await db.query<{ id: string }>(
        'INSERT INTO gmail_deliveries(mailbox_id,generation,message_id,attempt_id,received_at,reprocess_id,attempts,authenticated,forwarded) ' +
        'VALUES($1,$2,$3,$4,$5,$6,1,true,false) RETURNING id', [mailbox.id, mailbox.generation, messageId, attemptId, receivedAt, run.id]);
      const input = {
        source: 'oauth', deliveryId: delivery.id, attemptId, messageId, receivedAt,
        provider: 'nequi', forwarded: false, status: 'pending', reason: 'unconfirmed_extraction', confidence: 0, evidence,
      };
      const read = async () => (await db.query(
        'SELECT n.status,n.reason,n.provider,n.reported_transaction_date::text,n.transaction_time,n.reported_payment_method,' +
        'n.reported_institution,t.amount_minor::text,t.currency,t.transaction_date::text,t.payment_method,t.description,t.category,t.direction ' +
        'FROM notices n JOIN transactions t ON t.notice_id=n.id WHERE n.id=$1', [notice.id])).rows[0];
      return { input, notice, movement, delivery, read };
    };
    await t.test('a transfer left pending by new rules fills metadata of its existing movement without altering adjustments', async () => {
      const saved = await fixture();
      await db.query('INSERT INTO email_movement_adjustments(movement_id,amount_minor,transaction_date,category,note,revision) ' +
        "VALUES($1,62500000,'2026-11-02','ingresos','Nota conservada',1)", [saved.movement.id]);
      assert.equal((await service.save(gmailResult.parse(saved.input), { verifiedBank: true })).outcome, 'duplicate');
      assert.deepEqual(await saved.read(), {
        status: 'registered', reason: null, provider: 'nequi', reported_transaction_date: '2026-11-01',
        transaction_time: '22:29', reported_payment_method: 'Bre-B', reported_institution: 'nequi',
        amount_minor: '61500000', currency: 'COP', transaction_date: '2026-11-01', payment_method: 'Bre-B',
        description: 'Descripción conservada', category: 'ingresos', direction: 'income',
      });
      assert.deepEqual((await db.query(
        'SELECT amount_minor::text,transaction_date::text,category,note,revision FROM email_movement_adjustments WHERE movement_id=$1',
        [saved.movement.id])).rows[0], {
        amount_minor: '62500000', transaction_date: '2026-11-02', category: 'ingresos', note: 'Nota conservada', revision: 1,
      });
      assert.equal((await db.query('SELECT 1 FROM transactions WHERE notice_id=$1', [saved.notice.id])).rowCount, 1);
    });
    await t.test('existing metadata and provider stay unchanged', async () => {
      const saved = await fixture();
      await db.query("UPDATE notices SET provider='bancolombia',reported_transaction_date='2026-10-31',transaction_time='21:00'," +
        "reported_payment_method='Transferencia',reported_institution='bancolombia' WHERE id=$1", [saved.notice.id]);
      const before = await saved.read();
      await service.save(gmailResult.parse(saved.input), { verifiedBank: true });
      assert.deepEqual(await saved.read(), before);
    });
    await t.test('fundamental conflicts, missing evidence or unverified results cannot enrich registered metadata', async () => {
      for (const changed of [{ amountMinor: '61500001' }, { currency: 'USD' }, { date: '2026-11-02' },
        { direction: 'expense' }, { amountMinor: undefined }]) {
        const saved = await fixture();
        const before = await saved.read();
        await service.save(gmailResult.parse({ ...saved.input, evidence: { ...evidence, ...changed } }), { verifiedBank: true });
        assert.deepEqual(await saved.read(), before);
      }
      const saved = await fixture();
      const before = await saved.read();
      await service.save(gmailResult.parse(saved.input));
      assert.deepEqual(await saved.read(), before);
      const unauthenticated = await fixture();
      const unauthenticatedBefore = await unauthenticated.read();
      await db.query('UPDATE gmail_deliveries SET authenticated=false WHERE id=$1', [unauthenticated.delivery.id]);
      await service.save(gmailResult.parse(unauthenticated.input), { verifiedBank: true });
      assert.deepEqual(await unauthenticated.read(), unauthenticatedBefore);
    });
    await t.test('a user-confirmed movement is never enriched automatically', async () => {
      const saved = await fixture('user_confirmed');
      const before = await saved.read();
      await service.save(gmailResult.parse(saved.input), { verifiedBank: true });
      assert.deepEqual(await saved.read(), before);
    });
  });
