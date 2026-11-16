import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DateTime } from 'luxon';
import { Pool } from 'pg';
import { encrypt, readConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { Gmail, gmailClassifierVersion } from '../src/gmail.js';
import { GmailExtraction } from '../src/gmail-extraction.js';
import { readGmailMime } from '../src/gmail-mime.js';
import { GmailResults } from '../src/gmail-results.js';
import { isGmailExplicitNonMovement } from '../src/mail-rules.js';

const connection = process.env.MAILGASTO_TEST_DATABASE_URL;
const configValues = {
  PUBLIC_URL: 'http://localhost:3105', ENCRYPTION_KEY: 'ab'.repeat(32),
  N8N_AGENT_KEY: 'local-non-movement-agent-key-only', N8N_INGEST_KEY: 'local-non-movement-ingest-key-only',
  GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret',
  SMTP_URL: 'smtp://localhost:1026', SMTP_FROM: 'fixture@example.test',
};
const bank = 'alertasynotificaciones@an.notificacionesbancolombia.com';
// Anonymized structures from the audit: HTML entities were delivered literally in text/plain.
const offerSubject = '¡Solo queda 1 semana! Descubre la recompensa que te espera';
const offerPlain = 'To view this email as a web page. Suma que suma est&aacute; por terminar… ' +
  '¿Todav&iacute;a no participas&#63; Reg&iacute;strate. Vuelve a usar tu link de pago o dat&aacute;fono. ' +
  'Recibe $50.000 COP en una o varias ventas y podr&aacute;s ganar 5.000 PuntosColombia. ' +
  'Si quieres recibir los pagos de tus ventas por Internet, Wompi.';
const debtBody = 'Su obligación registra una mora de 1 día y un saldo total a pagar de $812,795. ' +
  'Si en un plazo de veinte días no realiza el pago total o no formaliza un acuerdo de pago, ' +
  'su información será reportada. ¿Cómo evitar el reporte? Comunicarse para formalizar un acuerdo de pago. ' +
  'Pagar el valor total de la obligación. Si usted ha recibido este correo por error, favor eliminarlo.';
const encode = (from: string, subject: string, plain: string, html?: string, authenticated = true) => Buffer.from([
  'From: <' + from + '>', 'Subject: ' + subject,
  'Authentication-Results: mx.google.com; ' + (authenticated ? 'dmarc=pass header.from=' + from.split('@')[1] :
    'spf=pass smtp.mailfrom=' + from.split('@')[1] + '; dkim=fail reason="no key"; dmarc=fail header.from=' + from.split('@')[1]),
  'MIME-Version: 1.0', ...(html === undefined ? ['Content-Type: text/html; charset=UTF-8', '', plain] : [
    'Content-Type: multipart/alternative; boundary=fixture', '', '--fixture',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', plain,
    '--fixture', 'Content-Type: text/html; charset=UTF-8', '', '<p>' + html + '</p>', '--fixture--',
  ]),
].join('\r\n'));

test('entity-laden text preview has no completed cash flow while its HTML proves an offer', async () => {
  const mime = await readGmailMime(encode('ayuda@email.wompi.com', offerSubject, offerPlain, offerPlain), ['INBOX']);
  assert.equal(mime.authenticated, true);
  assert.equal(isGmailExplicitNonMovement(mime.email.subject, mime.email.text), false);
  assert.equal(isGmailExplicitNonMovement(mime.email.subject, mime.alternative!), true);
  const extraction = new GmailExtraction(readConfig({ ...configValues, DATABASE_URL: 'postgres://localhost/mailgasto_test' }));
  const plain = await extraction.classify(mime.email, false, true, '2026-11-11T22:05:11.000Z');
  assert.equal(plain.status, 'pending');
  if (plain.status === 'pending') assert.equal(plain.evidence?.direction ?? null, null);
  assert.equal((await extraction.classify({ ...mime.email, text: mime.alternative! }, false, true)).status, 'ignored');
});

test('OAuth reprocessing excludes proven non-movements without losing financial or user evidence', { skip: !connection }, async t => {
  const url = new URL(connection!);
  assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.match(url.pathname, /^\/mailgasto_test$/);
  const admin = new Pool({ connectionString: url.href });
  const schema = 'non_movement_' + randomUUID().replaceAll('-', '');
  await admin.query('CREATE SCHEMA ' + schema);
  url.searchParams.set('options', '-c search_path=' + schema);
  const config = readConfig({ ...configValues, DATABASE_URL: url.href });
  const db = new Database(config);
  t.after(async () => { await db.onApplicationShutdown(); await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); });
  await db.migrate();
  const results = new GmailResults(db, config);
  const gmail = new Gmail(db, config, new GmailExtraction(config), results);
  const received = DateTime.now().setZone('America/Bogota').minus({ minutes: 2 });
  const { rows: [account] } = await db.query("INSERT INTO accounts(email,name,verified_at) VALUES('exclusion@example.test','Fixture',now()) RETURNING id");
  const { rows: [mailbox] } = await db.query('INSERT INTO mailboxes(account_id,email,source,state,secret,linked_at) ' +
    "VALUES($1,'exclusion@example.test','oauth','active',$2,$3) RETURNING id,generation",
  [account.id, encrypt('synthetic-refresh-token', config.encryptionKey), received.minus({ days: 1 }).toJSDate()]);
  const { rows: [run] } = await db.query('INSERT INTO gmail_reprocess_runs(mailbox_id,from_at,to_at,classifier_version) VALUES($1,$2,$3,$4) RETURNING id',
    [mailbox.id, received.minus({ days: 2 }).toJSDate(), received.plus({ days: 1 }).toJSDate(), gmailClassifierVersion]);
  const rawById = new Map<string, Buffer>();
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const address = String(input);
    if (address === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'synthetic-access', expires_in: 3600 });
    if (address.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages/')) {
      const id = new URL(address).pathname.split('/').at(-1)!;
      assert(rawById.has(id));
      return Response.json({ id, raw: rawById.get(id)!.toString('base64url'), internalDate: String(received.toMillis()), labelIds: ['INBOX'] });
    }
    throw Error('Unexpected external request: ' + address);
  });
  const read = async (id: string) => (await db.query('SELECT n.status,n.reason,n.reported_amount_minor::text,n.reported_direction,' +
    'n.date_source,t.amount_minor::text AS movement_amount FROM notices n LEFT JOIN transactions t ON t.notice_id=n.id ' +
    'WHERE n.mailbox_id=$1 AND n.message_id=$2', [mailbox.id, id])).rows[0];
  const seed = async (raw: Buffer, prior?: string, reason?: string | null, reprocess = true) => {
    const id = randomUUID(); rawById.set(id, raw);
    const { rows: [delivery] } = await db.query('INSERT INTO gmail_deliveries(mailbox_id,generation,message_id,reprocess_id,classifier_version) ' +
      'VALUES($1,$2,$3,$4,$5) RETURNING id', [mailbox.id, mailbox.generation, id, reprocess ? run.id : null, gmailClassifierVersion]);
    if (prior) await db.query('INSERT INTO notices(mailbox_id,message_id,received_at,provider,forwarded,status,reason,reported_amount_minor,reported_currency,date_source) ' +
      "VALUES($1,$2,$3,'other',false,$4,$5,81279500,'COP','received_at')", [mailbox.id, id, received.toJSDate(), prior,
      reason === undefined ? 'unconfirmed_extraction' : reason]);
    return { id, deliveryId: delivery.id };
  };
  const dispatch = async (raw: Buffer, prior?: string, reason?: string) => {
    const f = await seed(raw, prior, reason);
    assert.equal(await gmail.dispatchOne(), true);
    const delivery = (await db.query('SELECT completed_at,outcome,authenticated FROM gmail_deliveries WHERE id=$1', [f.deliveryId])).rows[0];
    assert(delivery.completed_at, 'Local deterministic outcomes must finish without an AI callback');
    return { ...f, delivery, notice: await read(f.id) };
  };

  await t.test('promotional HTML clears its incomplete plain preview, including stale errors and reversed versions', async () => {
    for (const prior of ['pending', 'error', undefined]) {
      const f = await dispatch(encode('ayuda@email.wompi.com', offerSubject, offerPlain, offerPlain), prior);
      assert.equal(f.delivery.outcome, 'ignored');
      assert.equal(f.notice?.status, prior ? 'discarded' : undefined);
      if (prior) assert.deepEqual(f.notice, { status: 'discarded', reason: 'not_transaction', reported_amount_minor: null,
        reported_direction: null, date_source: null, movement_amount: null });
    }
    const f = await dispatch(encode('ayuda@email.wompi.com', offerSubject, 'Suma que suma está por terminar. Regístrate para participar.',
      'Oferta &amp;aacute;: valor $50.000 COP.'), 'pending');
    assert.equal(f.notice.status, 'discarded');
  });

  await t.test('a completed or incomplete actual payment conflicting with a non-movement remains pending', async () => {
    for (const body of ['Bancolombia: Pagaste $35.000.', 'Bancolombia: Pagaste en TIENDA DEMO.',
      'Bancolombia: Recibiste $35.000 y enviaste $20.000.']) {
      for (const reversed of [false, true]) {
        const negative = 'Tu pago fue rechazado por falta de fondos.';
        const f = await dispatch(encode(bank, 'Notificación', reversed ? negative : body, reversed ? body : negative));
        assert.equal(f.notice.status, 'pending', body);
        assert.equal(f.notice.reason, 'unconfirmed_extraction');
        assert.equal(f.notice.movement_amount, null);
        assert.equal(f.delivery.outcome, 'pending');
      }
    }
  });

  await t.test('contradictory amounts or dates remain pending and a neutral preview does not hide a receipt', async () => {
    const date = received.toFormat('dd/MM/yy');
    const payment = `Bancolombia: Recibiste una transferencia por $35.000 el ${date} a las 21:11.`;
    for (const other of [payment.replace('$35.000', '$45.000'), payment.replace(date, received.minus({ days: 1 }).toFormat('dd/MM/yy'))]) {
      const f = await dispatch(encode(bank, 'Notificación', payment, other));
      assert.equal(f.notice.status, 'pending');
      assert.equal(f.notice.reason, 'unconfirmed_extraction');
      assert.equal(f.notice.movement_amount, null);
    }
    const f = await dispatch(encode(bank, 'Notificación', 'Consulta la versión HTML de este mensaje.', payment));
    assert.equal(f.notice.status, 'registered');
    assert.equal(f.notice.movement_amount, '3500000');
  });

  await t.test('SPF-only debt is discarded, while unauthenticated completed cash flow still cannot register', async () => {
    for (const prior of ['pending', 'error']) {
      const debt = await dispatch(encode('micredito@rapicredit.com', 'Notificación reporte centrales de riesgo', debtBody, undefined, false), prior);
      assert.equal(debt.delivery.authenticated, false);
      assert.equal(debt.delivery.outcome, 'ignored');
      assert.equal(debt.notice.status, 'discarded');
      assert.equal(debt.notice.reported_amount_minor, null);
    }
    const paid = await dispatch(encode(bank, 'Pago realizado', 'Bancolombia: Pagaste $27.000 en TIENDA DEMO.', undefined, false), 'pending');
    assert.equal(paid.delivery.authenticated, false);
    assert.equal(paid.notice.status, 'pending');
    assert.equal(paid.notice.movement_amount, null);
  });

  await t.test('cleanup respects registered movements, manual decisions and exact delivery identity', async () => {
    const raw = encode('micredito@rapicredit.com', 'Notificación reporte centrales de riesgo', debtBody, undefined, false);
    for (const prior of [{ status: 'registered', reason: 'user_confirmed' }, { status: 'registered', reason: null },
      { status: 'discarded', reason: 'user_discarded' }]) {
      const f = await seed(raw, prior.status, prior.reason);
      if (prior.status === 'registered') await db.query('INSERT INTO transactions(notice_id,amount_minor,currency,transaction_date,description,category,direction) ' +
        "SELECT id,81279500,'COP',$3,'Conservar usuario','otros','expense' FROM notices WHERE mailbox_id=$1 AND message_id=$2",
      [mailbox.id, f.id, received.toISODate()]);
      const before = await read(f.id);
      await gmail.dispatchOne();
      assert.deepEqual(await read(f.id), before);
    }
    const f = await seed(raw, 'pending');
    const attemptId = randomUUID();
    await db.query('UPDATE gmail_deliveries SET attempt_id=$2,received_at=$3,authenticated=false,forwarded=false WHERE id=$1',
      [f.deliveryId, attemptId, received.toJSDate()]);
    const identity = { source: 'oauth' as const, deliveryId: f.deliveryId, attemptId, messageId: f.id, receivedAt: received.toISO()!, status: 'ignored' as const };
    for (const changed of [{ messageId: randomUUID() }, { attemptId: randomUUID() }, { receivedAt: received.minus({ seconds: 1 }).toISO()! }]) {
      assert.equal((await results.save({ ...identity, ...changed }, { explicitNonMovement: true })).outcome, 'discarded');
      assert.equal((await read(f.id)).status, 'pending');
    }
    assert.equal((await results.save(identity, { explicitNonMovement: true })).outcome, 'stored');
    assert.equal((await read(f.id)).status, 'discarded');
  });

  await t.test('forwarding, unproven exclusions and deliveries outside reprocessing do not clear pending notices', async () => {
    for (const mode of ['forwarded', 'no-proof', 'not-reprocessing']) {
      const f = await seed(encode(bank, 'Aviso', debtBody), 'pending', undefined, mode !== 'not-reprocessing');
      const attemptId = randomUUID();
      await db.query('UPDATE gmail_deliveries SET attempt_id=$2,received_at=$3,authenticated=false,forwarded=$4 WHERE id=$1',
        [f.deliveryId, attemptId, received.toJSDate(), mode === 'forwarded']);
      await results.save({ source: 'oauth', deliveryId: f.deliveryId, attemptId, messageId: f.id,
        receivedAt: received.toISO()!, status: 'ignored' }, { explicitNonMovement: mode !== 'no-proof' });
      assert.equal((await read(f.id)).status, 'pending', mode);
    }
  });
});
