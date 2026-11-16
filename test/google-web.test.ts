import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { test } from 'node:test';
import { OAuth2Client } from 'google-auth-library';
import { hash, readConfig, token } from '../src/config.js';
import { Database } from '../src/db.js';
import { createApp } from '../src/main.js';

const connection = process.env.MAILGASTO_TEST_DATABASE_URL;
const proof = (value: string) => createHash('sha256').update(value).digest('base64url');

test('Google web and mobile bind the return platform and issue a one-use session after signed identity and PKCE verification',
  { skip: !connection }, async t => {
    assert.match(new URL(connection!).pathname, /^\/mailgasto_test$/);
    const origin = 'https://mailgasto.example.test';
    const clientId = 'web-google-fixture-client';
    const app = await createApp(readConfig({
      PUBLIC_URL: origin, DATABASE_URL: connection, ENCRYPTION_KEY: '4a'.repeat(32),
      N8N_AGENT_KEY: 'local-google-web-agent-key-for-testing-only',
      N8N_INGEST_KEY: 'local-google-web-ingest-key-for-testing-only',
      SMTP_URL: 'smtp://localhost:1026', SMTP_FROM: 'test@example.test',
      GOOGLE_SIGNIN_CLIENT_ID: clientId, GOOGLE_SIGNIN_CLIENT_SECRET: 'fixture-client-secret',
    }), false);
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const db = app.get(Database);
    const emails: string[] = [];
    const states: string[] = [];
    t.after(async () => {
      try {
        await db.query('DELETE FROM mobile_google_signins WHERE state_hash=ANY($1)', [states.map(hash)]);
        await db.query('DELETE FROM accounts WHERE email=ANY($1)', [emails]);
      } finally { await app.close(); }
    });
    const request = (path: string, method = 'GET', data?: unknown, requestOrigin = origin, cookie = '') =>
      fetch(base + '/v1/' + path, {
        method, redirect: 'manual', headers: { Origin: requestOrigin, 'Content-Type': 'application/json', Cookie: cookie },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const encode = (part: unknown) => Buffer.from(JSON.stringify(part)).toString('base64url');
    const grants = new Map<string, { state: string; email: string; challenge: string; fail?: boolean; wrongNonce?: boolean }>();
    t.mock.method(OAuth2Client.prototype, 'getFederatedSignonCertsAsync', async () => ({
      format: 'PEM', certs: { fixture: publicKey.export({ format: 'pem', type: 'spki' }).toString() },
    }));
    const realFetch = fetch;
    let providerExchanges = 0;
    t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
      if (input !== 'https://oauth2.googleapis.com/token') return realFetch(input, init);
      providerExchanges++;
      const form = init!.body as URLSearchParams;
      const grant = grants.get(form.get('code')!);
      assert.ok(grant);
      assert.equal(form.get('redirect_uri'), origin + '/v1/mobile/auth/google/callback');
      assert.equal(proof(form.get('code_verifier')!), grant.challenge);
      if (grant.fail) return Response.json({ error: 'fixture_secret_provider_detail' }, { status: 400 });
      const now = Math.floor(Date.now() / 1000);
      const jwt = encode({ alg: 'RS256', kid: 'fixture' }) + '.' + encode({
        iss: 'https://accounts.google.com', aud: clientId, sub: randomUUID(),
        email: grant.email, email_verified: true, name: 'Google web fixture',
        iat: now, exp: now + 300, nonce: grant.wrongNonce ? token() : grant.state,
      });
      return Response.json({ id_token: jwt + '.' + sign('RSA-SHA256', Buffer.from(jwt), privateKey).toString('base64url') });
    });
    const authorize = async (platform: 'web' | 'mobile') => {
      const verifier = token();
      const response = await request((platform === 'web' ? '' : 'mobile/') + 'auth/google/authorize', 'POST', { challenge: proof(verifier) });
      assert.equal(response.status, 200);
      const url = new URL((await response.json()).url);
      assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
      assert.equal(url.searchParams.get('redirect_uri'), origin + '/v1/mobile/auth/google/callback');
      assert.equal(url.searchParams.get('scope'), 'openid email profile');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      const state = url.searchParams.get('state')!;
      states.push(state);
      const { rows: [stored] } = await db.query<{ client_platform: string; challenge: string }>(
        'SELECT client_platform,challenge FROM mobile_google_signins WHERE state_hash=$1', [hash(state)]);
      assert.deepEqual(stored, { client_platform: platform, challenge: proof(verifier) });
      const email = 'google-web-' + randomUUID() + '@gmail.com';
      emails.push(email);
      const code = randomUUID();
      const grant = { state, email, challenge: url.searchParams.get('code_challenge')!, fail: false, wrongNonce: false };
      grants.set(code, grant);
      return { state, verifier, email, code, grant };
    };
    const callback = async (state: string, code?: string) => {
      const response = await request('mobile/auth/google/callback?' + new URLSearchParams({ state, ...(code ? { code } : { error: 'access_denied' }) }));
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(await response.text(), '');
      const location = new URL(response.headers.get('location')!);
      assert.equal(location.search, '');
      return location;
    };

    await t.test('rejects cross-origin authorization', async () => {
      const response = await request('auth/google/authorize', 'POST', { challenge: proof(token()) }, 'https://untrusted.example');
      assert.equal(response.status, 403);
    });
    await t.test('returns web identity to root and requires the original verifier exactly once', async () => {
      const web = await authorize('web');
      const location = await callback(web.state, web.code);
      assert.equal(location.origin + location.pathname, origin + '/');
      const fragment = new URLSearchParams(location.hash.slice(1));
      assert.equal(fragment.get('google'), 'complete');
      const receipt = fragment.get('receipt');
      assert.match(receipt!, /^[A-Za-z0-9_-]{43}$/);
      assert.equal((await request('auth/google/complete', 'POST', { receipt, verifier: token() })).status, 400);
      const login = await request('auth/google/complete', 'POST', { receipt, verifier: web.verifier });
      assert.equal(login.status, 200);
      assert.equal((await login.json()).email, web.email);
      const cookie = login.headers.get('set-cookie')!;
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /Secure/);
      assert.match(cookie, /SameSite=Lax/);
      assert.equal((await request('auth/me', 'GET', undefined, origin, cookie.split(';')[0])).status, 200);
      assert.equal((await request('auth/google/complete', 'POST', { receipt, verifier: web.verifier })).status, 400);
    });
    await t.test('preserves the existing Android return and complete endpoint', async () => {
      const mobile = await authorize('mobile');
      const location = await callback(mobile.state, mobile.code);
      assert.equal(location.origin + location.pathname, origin + '/mobile/auth/google/return');
      const receipt = new URLSearchParams(location.hash.slice(1)).get('receipt');
      assert.match(receipt!, /^[A-Za-z0-9_-]{43}$/);
      const response = await request('mobile/auth/google/complete', 'POST', { receipt, verifier: mobile.verifier });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).email, mobile.email);
    });
    await t.test('cancellation returns to each originating client without contacting the provider', async () => {
      const before = providerExchanges;
      for (const platform of ['web', 'mobile'] as const) {
        const pending = await authorize(platform);
        const location = await callback(pending.state);
        assert.equal(location.href, origin + (platform === 'web' ? '/#google=cancelled' : '/mobile/auth/google/return#status=cancelled'));
        assert.equal((await db.query('SELECT 1 FROM mobile_google_signins WHERE state_hash=$1', [hash(pending.state)])).rowCount, 0);
      }
      assert.equal(providerExchanges, before);
    });
    await t.test('provider failure and wrong nonce remain failed web returns with no account or session', async () => {
      for (const reason of ['fail', 'wrongNonce'] as const) {
        const pending = await authorize('web');
        pending.grant[reason] = true;
        const location = await callback(pending.state, pending.code);
        assert.equal(location.href, origin + '/#google=failed');
        assert.equal((await db.query('SELECT 1 FROM accounts WHERE email=$1', [pending.email])).rowCount, 0);
        assert.equal((await callback(pending.state, pending.code)).href, origin + '/#google=failed');
      }
    });
    await t.test('an expired web request stays on web and cannot exchange its provider code', async () => {
      const pending = await authorize('web');
      await db.query("UPDATE mobile_google_signins SET expires_at=now()-interval '1 second' WHERE state_hash=$1", [hash(pending.state)]);
      const before = providerExchanges;
      assert.equal((await callback(pending.state, pending.code)).href, origin + '/#google=failed');
      assert.equal(providerExchanges, before);
    });
  });
