import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { test } from 'node:test';
import { OAuth2Client } from 'google-auth-library';
import { DateTime } from 'luxon';
import { readConfig, decrypt, token } from '../src/config.js';
import { Database } from '../src/db.js';
import { createApp } from '../src/main.js';

const connection = process.env.MAILGASTO_TEST_DATABASE_URL;
const password = 'synthetic-finance-password';

async function fixture(origin: string, google = false) {
  assert.match(new URL(connection!).pathname, /^\/mailgasto_test$/);
  const config = readConfig({
    PUBLIC_URL: origin, DATABASE_URL: connection, ENCRYPTION_KEY: '4a'.repeat(32),
    N8N_AGENT_KEY: 'local-agent-key-for-finance-test-only',
    N8N_INGEST_KEY: 'local-ingest-key-for-finance-test-only',
    SMTP_URL: 'smtp://localhost:1026', SMTP_FROM: 'MailGasto <finance@example.test>',
    GOOGLE_SIGNIN_CLIENT_ID: google ? 'fixture-google-client' : '',
    GOOGLE_SIGNIN_CLIENT_SECRET: google ? 'fixture-google-secret' : '',
  });
  const app = await createApp(config, false);
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const request = (path: string, method = 'GET', data?: unknown, cookie = '') => fetch(base + '/v1/' + path, {
    method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return { app, config, db: app.get(Database), request };
}

test('combina avisos y manuales, conserva monedas y protege datos y credenciales por cuenta', { skip: !connection }, async t => {
  const { app, config, db, request } = await fixture('http://localhost:3105');
  const email = 'fin-' + randomUUID() + '@example.test';
  const other = 'fin-' + randomUUID() + '@example.test';
  t.after(async () => {
    try { await db.query('DELETE FROM accounts WHERE email=ANY($1)', [[email, other]]); }
    finally { await app.close(); }
  });
  const readToken = async (address: string, key: string) => {
    const { rows: [row] } = await db.query<{ body: string }>(
      'SELECT o.body FROM outbox o JOIN accounts a ON a.id=o.account_id WHERE a.email=$1 AND o.dedupe_key LIKE $2',
      [address, key + ':%'],
    );
    return new RegExp('#' + key + '=([A-Za-z0-9_-]{43})').exec(decrypt(row.body, config.encryptionKey))![1];
  };
  const login = async (address: string, secret = password) => {
    const response = await request('auth/login', 'POST', { email: address, password: secret });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie')!.split(';')[0];
  };
  const register = async (address: string) => {
    assert.equal((await request('auth/register', 'POST', { name: 'Prueba', email: address, password })).status, 202);
    assert.equal((await request('auth/verify', 'POST', { token: await readToken(address, 'verify'), password })).status, 204);
    return login(address);
  };
  const cookie = await register(email);
  const otherCookie = await register(other);
  const me = await (await request('auth/me', 'GET', undefined, cookie)).json();
  const day = DateTime.now().setZone('America/Bogota').toISODate()!;
  const period = 'from=' + day + '&to=' + day + '&currency=COP';
  const income = { requestId: randomUUID(), amountMinor: '165000000', date: day, direction: 'income', currency: 'COP' };
  const expense = { requestId: randomUUID(), amountMinor: '48600000', date: day, direction: 'expense',
    currency: 'COP', category: 'alimentacion', description: 'Compra de prueba' };
  const create = async (value: unknown) => {
    const response = await request('movements', 'POST', value, cookie);
    assert.equal(response.status, 201);
    return (await response.json()).id as string;
  };
  const incomeId = await create(income);
  const expenseId = await create(expense);
  assert.equal(await create(income), incomeId);
  await create({ ...income, requestId: randomUUID(), amountMinor: '9876', currency: 'USD' });
  assert.equal((await request('movements/' + incomeId, 'GET', undefined, otherCookie)).status, 404);
  assert.equal((await request('movements/' + incomeId, 'DELETE', undefined, otherCookie)).status, 404);
  const analytics = async () => (await request('analytics?' + period, 'GET', undefined, cookie)).json();
  const result = await analytics();
  assert.deepEqual([result.incomeMinor, result.expenseMinor, result.balanceMinor], ['165000000', '48600000', '116400000']);
  assert.deepEqual(result.incomeSources, [{ key: 'manual', amountMinor: '165000000' }]);
  assert.deepEqual(result.series, [{ from: day, to: day, incomeMinor: '165000000', expenseMinor: '48600000', balanceMinor: '116400000' }]);
  assert.equal((await (await request('movements?' + period + '&direction=income', 'GET', undefined, cookie)).json()).items.length, 1);
  const { rows: [mailbox] } = await db.query('INSERT INTO mailboxes (account_id,email,source,state) VALUES ($1,$2,$3,$4) RETURNING id',
    [me.id, email, 'n8n', 'active']);
  const { rows: [notice] } = await db.query(
    "INSERT INTO notices (mailbox_id,message_id,received_at,provider,forwarded,status) VALUES ($1,$2,now(),'nequi',false,'registered') RETURNING id",
    [mailbox.id, randomUUID()],
  );
  await db.query(
    "INSERT INTO transactions (notice_id,amount_minor,currency,transaction_date,payment_method,description,category,direction) " +
    "VALUES ($1,48600000,'COP',$2,'Nequi','Compra por aviso','alimentacion','expense')", [notice.id, day],
  );
  const manual = await (await request('movements/' + expenseId, 'GET', undefined, cookie)).json();
  assert.equal(manual.matches[0].source, 'email');
  assert.equal((await request('movements/' + manual.matches[0].id, 'DELETE', undefined, cookie)).status, 404);
  assert.equal((await request('movements/' + expenseId, 'DELETE', undefined, cookie)).status, 204);
  assert.equal((await analytics()).expenseMinor, '48600000');
  assert.equal((await request('movements/' + incomeId, 'PATCH', { ...income, amountMinor: '166000000' }, cookie)).status, 204);
  assert.equal((await analytics()).balanceMinor, '117400000');
  const chat = await (await request('chat/sessions', 'POST', undefined, cookie)).json();
  const turn = await (await request('chat/sessions/' + chat.id + '/messages', 'POST',
    { message: 'Compara mis ingresos y gastos de hoy en COP' }, cookie)).json();
  assert.match(turn.answer, /Ingresos 1\.660\.000,00, gastos 486\.000,00, balance 1\.174\.000,00/);
  assert.equal(turn.range.currency, 'COP');
  assert.equal((await (await request('account/profile', 'PATCH', { name: 'Actualizado' }, cookie)).json()).name, 'Actualizado');
  const changed = password + '-changed';
  assert.equal((await request('account/password', 'POST', { current: password, password: changed }, cookie)).status, 204);
  await login(email, changed);
  assert.equal((await request('auth/password/reset', 'POST', { email })).status, 202);
  const code = await readToken(email, 'reset');
  assert.equal((await request('auth/password/reset/confirm', 'POST', { token: code, password })).status, 204);
  assert.equal((await request('auth/password/reset/confirm', 'POST', { token: code, password })).status, 422);
  assert.equal((await request('auth/me', 'GET', undefined, cookie)).status, 401);
  await login(email);
});

test('Google móvil verifica un token firmado y exige el verificador del dispositivo', { skip: !connection }, async t => {
  const { app, db, request } = await fixture('https://mailgasto.example.test', true);
  const email = 'qa-' + randomUUID() + '@gmail.com';
  t.after(async () => {
    try { await db.query('DELETE FROM accounts WHERE email=$1', [email]); }
    finally { await app.close(); }
  });
  const proof = (value: string) => createHash('sha256').update(value).digest('base64url');
  const verifier = token();
  const kickoff = await request('mobile/auth/google/authorize', 'POST', { challenge: proof(verifier) });
  assert.equal(kickoff.status, 200);
  const url = new URL((await kickoff.json()).url);
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://mailgasto.example.test/v1/mobile/auth/google/callback');
  const state = url.searchParams.get('state')!;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  const encode = (part: unknown) => Buffer.from(JSON.stringify(part)).toString('base64url');
  const jwt = encode({ alg: 'RS256', kid: 'fixture' }) + '.' + encode({
    iss: 'https://accounts.google.com', aud: 'fixture-google-client', sub: randomUUID(),
    email, email_verified: true, name: 'Google ficticio', iat: now, exp: now + 300, nonce: state,
  });
  const idToken = jwt + '.' + sign('RSA-SHA256', Buffer.from(jwt), privateKey).toString('base64url');
  t.mock.method(OAuth2Client.prototype, 'getFederatedSignonCertsAsync', async () => ({
    format: 'PEM', certs: { fixture: publicKey.export({ format: 'pem', type: 'spki' }).toString() },
  }));
  const realFetch = fetch;
  t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    if (input === 'https://oauth2.googleapis.com/token') {
      const form = init!.body as URLSearchParams;
      assert.equal(proof(form.get('code_verifier')!), url.searchParams.get('code_challenge'));
      return Response.json({ id_token: idToken });
    }
    return realFetch(input, init);
  });
  const callback = await request('mobile/auth/google/callback?code=fixture&state=' + state);
  assert.equal(callback.status, 200);
  const body = await callback.text();
  const receipt = /#receipt=([A-Za-z0-9_-]{43})/.exec(body)?.[1];
  assert.ok(receipt, body);
  assert.equal((await request('mobile/auth/google/complete', 'POST', { receipt, verifier: token() })).status, 400);
  const session = await request('mobile/auth/google/complete', 'POST', { receipt, verifier });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).email, email);
  assert.match(session.headers.get('set-cookie')!, /Secure/);
  assert.equal((await request('mobile/auth/google/complete', 'POST', { receipt, verifier })).status, 400);
});
