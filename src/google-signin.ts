import { BadRequestException, ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { AccountInfo, Accounts, normalizedEmail } from './accounts.js';
import { CONFIG, Config, decrypt, encrypt, hash, token } from './config.js';
import { Database } from './db.js';

const proof = (value: string) => createHash('sha256').update(value).digest('base64url');

@Injectable()
export class GoogleSignin {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(Database) private readonly db: Database,
    @Inject(Accounts) private readonly accounts: Accounts,
  ) {}

  private get clientId() { return this.config.GOOGLE_SIGNIN_CLIENT_ID ?? this.config.GOOGLE_CLIENT_ID; }
  private get clientSecret() { return this.config.GOOGLE_SIGNIN_CLIENT_SECRET ?? this.config.GOOGLE_CLIENT_SECRET; }
  private get callback() { return this.config.origin + '/v1/mobile/auth/google/callback'; }

  private requireGoogle() {
    if (!this.config.secure || !this.clientId || !this.clientSecret) {
      throw new ServiceUnavailableException('El inicio de sesión con Google todavía no está disponible en este servidor.');
    }
  }

  async authorize(challenge: string) {
    this.requireGoogle();
    const state = token();
    const verifier = token();
    await this.db.transaction(async client => {
      await client.query('DELETE FROM mobile_google_signins WHERE expires_at<=now()');
      await client.query(
        "INSERT INTO mobile_google_signins (state_hash,challenge,verifier,expires_at) VALUES ($1,$2,$3,now()+interval '10 minutes')",
        [hash(state), challenge, encrypt(verifier, this.config.encryptionKey)],
      );
    });
    const params = new URLSearchParams({
      client_id: this.clientId!, redirect_uri: this.callback, response_type: 'code',
      scope: 'openid email profile', state, nonce: state, prompt: 'select_account',
      code_challenge_method: 'S256', code_challenge: proof(verifier),
    });
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + params;
  }

  async receive(state: string, code?: string) {
    this.requireGoogle();
    const key = hash(state);
    if (!code) {
      await this.db.query("DELETE FROM mobile_google_signins WHERE state_hash=$1 AND verifier<>''", [key]);
      return null;
    }
    const { rows: [authorization] } = await this.db.query<{ verifier: string }>(
      "WITH request AS (SELECT state_hash,verifier FROM mobile_google_signins WHERE state_hash=$1 AND verifier<>'' " +
      "AND expires_at>now() FOR UPDATE) UPDATE mobile_google_signins s SET verifier='' FROM request " +
      'WHERE s.state_hash=request.state_hash RETURNING request.verifier', [key],
    );
    if (!authorization) throw new BadRequestException('La solicitud de Google expiró o ya fue usada.');
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: this.callback,
        client_id: this.clientId!, client_secret: this.clientSecret!,
        code_verifier: decrypt(authorization.verifier, this.config.encryptionKey),
      }),
    });
    if (!response.ok) throw new BadRequestException('Google no completó el acceso.');
    const { id_token: idToken } = await response.json() as { id_token?: unknown };
    if (typeof idToken !== 'string') throw new BadRequestException('Google no devolvió una identidad.');
    const verified = await new OAuth2Client().verifyIdToken({ idToken, audience: this.clientId });
    const claims = verified.getPayload();
    const email = normalizedEmail.safeParse(claims?.email);
    if (!claims?.sub || !claims.email_verified || !email.success ||
        (claims as unknown as { nonce?: string }).nonce !== state) {
      throw new BadRequestException('Google no confirmó una identidad válida.');
    }
    const address = email.data;
    const name = claims.name?.trim().slice(0, 80) || address.split('@')[0].slice(0, 80);
    const authoritative = address.endsWith('@gmail.com') || Boolean(claims.hd);
    if (!authoritative) throw new BadRequestException('Usa una cuenta Gmail o de Google Workspace.');
    const receipt = token();
    await this.db.transaction(async client => {
      const active = await client.query('SELECT 1 FROM mobile_google_signins WHERE state_hash=$1 AND expires_at>now() FOR UPDATE', [key]);
      if (!active.rowCount) throw new BadRequestException('La solicitud de Google expiró.');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [address]);
      const { rows: [linked] } = await client.query<{ account_id: string }>(
        'SELECT account_id FROM google_identities WHERE subject=$1', [claims.sub],
      );
      let id = linked?.account_id;
      if (!id) {
        const { rows: [created] } = await client.query<{ id: string }>(
          'INSERT INTO accounts (email,name,verified_at) VALUES ($1,$2,now()) ON CONFLICT(email) DO NOTHING RETURNING id',
          [address, name],
        );
        id = created?.id;
        if (!id) {
          const { rows: [existing] } = await client.query<{ id: string }>(
            'SELECT id FROM accounts WHERE email=$1 AND verified_at IS NOT NULL FOR UPDATE', [address],
          );
          if (!existing) throw new ConflictException('Usa el correo y la contraseña de tu cuenta.');
          id = existing.id;
        }
        const connection = await client.query(
          'INSERT INTO google_identities VALUES ($1,$2) ON CONFLICT DO NOTHING', [claims.sub, id],
        );
        if (!connection.rowCount) throw new ConflictException('La cuenta ya tiene una identidad de Google.');
      }
      await client.query(
        "UPDATE mobile_google_signins SET receipt_hash=$2,account_id=$3,expires_at=now()+interval '2 minutes' WHERE state_hash=$1",
        [key, hash(receipt), id],
      );
    });
    return receipt;
  }

  async complete(receipt: string, verifier: string, res: Response) {
    this.requireGoogle();
    const { rows: [account] } = await this.db.query<AccountInfo>(
      'DELETE FROM mobile_google_signins s USING accounts a WHERE s.receipt_hash=$1 AND s.challenge=$2 ' +
      'AND s.expires_at>now() AND a.id=s.account_id RETURNING a.id,a.name,a.email', [hash(receipt), proof(verifier)],
    );
    if (!account) throw new BadRequestException('La confirmación de Google expiró o no corresponde a esta solicitud.');
    return this.accounts.issueSession(account, res);
  }
}
