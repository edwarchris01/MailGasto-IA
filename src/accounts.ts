import {
  BadRequestException, ConflictException, ForbiddenException, Inject, Injectable,
  UnauthorizedException, UnprocessableEntityException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { CONFIG, Config, encrypt, hash, token } from './config.js';
import { Database } from './db.js';

export function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Los datos de la solicitud son inválidos.');
  return result.data;
}

export const normalizedEmail = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const registerInput = z.object({
  email: normalizedEmail,
  name: z.string().trim().min(1).max(80),
  password: z.string().min(12).max(128),
});
export const loginInput = registerInput.omit({ name: true });
export const tokenInput = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export const uuid = z.uuid();
export const sessionHash = (req: Request) => {
  const match = req.headers.cookie?.match(/(?:^|;\s*)mailgasto_session=([A-Za-z0-9_-]{43})(?:;|$)/);
  return match ? hash(match[1]) : '';
};

export async function queueMail(
  db: Pick<PoolClient, 'query'>, config: Config, accountId: string, key: string, subject: string, body: string,
) {
  await db.query(
    'INSERT INTO outbox (account_id,dedupe_key,subject,body) VALUES ($1,$2,$3,$4) ON CONFLICT (dedupe_key) DO NOTHING',
    [accountId, key, '[MailGasto IA] ' + subject, encrypt(body, config.encryptionKey)],
  );
}

type Account = { id: string; email: string; name: string; verified_at: Date | null; password_hash: string | null };
export type AccountInfo = Pick<Account, 'id' | 'email' | 'name'>;

@Injectable()
export class Accounts {
  private readonly dummyHash = argon2.hash(token());

  constructor(@Inject(Database) private readonly db: Database, @Inject(CONFIG) private readonly config: Config) {}

  async throttle(bucket: string, maximum: number, intervalSeconds: number) {
    const result = await this.db.query<{ hits: number }>(
      'INSERT INTO rate_limits (bucket,hits,expires_at) VALUES ($1,1,now()+$2*interval \'1 second\') ' +
      'ON CONFLICT (bucket) DO UPDATE SET hits=CASE WHEN rate_limits.expires_at<=now() THEN 1 ELSE rate_limits.hits+1 END, ' +
      'expires_at=CASE WHEN rate_limits.expires_at<=now() THEN excluded.expires_at ELSE rate_limits.expires_at END RETURNING hits',
      [hash(bucket), intervalSeconds],
    );
    if (result.rows[0].hits > maximum) throw new ForbiddenException('Demasiados intentos. Inténtalo más tarde.');
  }

  async register(values: z.infer<typeof registerInput>) {
    const password = await argon2.hash(values.password, { type: argon2.argon2id });
    await this.db.transaction(async client => {
      const created = await client.query<{ id: string }>(
        'INSERT INTO accounts (name,email,password_hash) VALUES ($1,$2,$3) ON CONFLICT (email) DO NOTHING RETURNING id',
        [values.name, values.email, password],
      );
      let id = created.rows[0]?.id;
      if (!id) {
        const existing = await client.query<Account>('SELECT * FROM accounts WHERE email=$1 FOR UPDATE', [values.email]);
        const account = existing.rows[0];
        if (!account?.password_hash || account.verified_at || !await argon2.verify(account.password_hash, values.password)) return;
        const active = await client.query(
          "SELECT 1 FROM account_tokens WHERE account_id=$1 AND purpose='verify' AND expires_at>now()+interval '23 hours 55 minutes'",
          [account.id],
        );
        if (active.rowCount) return;
        await client.query("DELETE FROM account_tokens WHERE account_id=$1 AND purpose='verify'", [account.id]);
        id = account.id;
      }
      const verification = token();
      await client.query(
        "INSERT INTO account_tokens VALUES ($1,$2,'verify',now()+interval '24 hours')", [hash(verification), id],
      );
      await queueMail(client, this.config, id, 'verify:' + hash(verification), 'Verifica tu correo',
        'Abre este enlace y confirma tu correo: ' + this.config.origin + '/#verify=' + verification);
    });
  }

  async verify(value: string, password: string) {
    await this.db.transaction(async client => {
      const result = await client.query<{ account_id: string; password_hash: string | null }>(
        "SELECT t.account_id,a.password_hash FROM account_tokens t JOIN accounts a ON a.id=t.account_id " +
        "WHERE t.token_hash=$1 AND t.purpose='verify' AND t.expires_at>now() FOR UPDATE OF a,t",
        [hash(value)],
      );
      if (!result.rows[0]?.password_hash || !await argon2.verify(result.rows[0].password_hash, password)) {
        throw new BadRequestException('El enlace o la contraseña son inválidos.');
      }
      await client.query('DELETE FROM account_tokens WHERE token_hash=$1', [hash(value)]);
      await client.query('UPDATE accounts SET verified_at=now() WHERE id=$1', [result.rows[0].account_id]);
    });
  }

  async login(values: z.infer<typeof loginInput>, response: Response) {
    const { rows: [account] } = await this.db.query<Account>('SELECT * FROM accounts WHERE email=$1', [values.email]);
    const valid = await argon2.verify(account?.password_hash ?? await this.dummyHash, values.password);
    if (!account?.password_hash || !valid) throw new UnauthorizedException('Correo o contraseña incorrectos.');
    if (!account.verified_at) throw new ForbiddenException('Verifica tu correo antes de iniciar sesión.');
    return this.issueSession(account, response, account.password_hash);
  }

  async issueSession(account: AccountInfo, response: Response, passwordHash?: string) {
    const session = token();
    if (passwordHash) {
      const result = await this.db.query(
        "INSERT INTO sessions SELECT $1,id,now()+interval '7 days' FROM accounts " +
        'WHERE id=$2 AND password_hash=$3 AND verified_at IS NOT NULL FOR SHARE', [hash(session), account.id, passwordHash],
      );
      if (!result.rowCount) throw new UnauthorizedException('La contraseña cambió. Inicia sesión nuevamente.');
    } else {
      await this.db.query("INSERT INTO sessions VALUES ($1,$2,now()+interval '7 days')", [hash(session), account.id]);
    }
    response.cookie('mailgasto_session', session, this.cookie());
    return { id: account.id, name: account.name, email: account.email };
  }

  async rename(account: string, name: string) {
    const { rows: [updated] } = await this.db.query<AccountInfo>(
      'UPDATE accounts SET name=$2 WHERE id=$1 RETURNING id,name,email', [account, name],
    );
    if (!updated) throw new UnauthorizedException('Inicia sesión para continuar.');
    return updated;
  }

  async changePassword(account: string, session: string, current: string, password: string) {
    const replacement = await argon2.hash(password, { type: argon2.argon2id });
    await this.db.transaction(async client => {
      const { rows: [row] } = await client.query<Pick<Account, 'password_hash'>>(
        'SELECT password_hash FROM accounts WHERE id=$1 FOR UPDATE', [account],
      );
      if (!row?.password_hash) throw new BadRequestException('Usa recuperar contraseña para establecer una contraseña.');
      if (!await argon2.verify(row.password_hash, current)) throw new BadRequestException('La contraseña actual es incorrecta.');
      await client.query('UPDATE accounts SET password_hash=$2 WHERE id=$1', [account, replacement]);
      await client.query("DELETE FROM account_tokens WHERE account_id=$1 AND purpose='reset'", [account]);
      await client.query('DELETE FROM sessions WHERE account_id=$1 AND token_hash<>$2', [account, session]);
    });
  }

  async requestReset(email: string) {
    await this.db.transaction(async client => {
      const { rows: [account] } = await client.query<{ id: string }>(
        'SELECT id FROM accounts WHERE email=$1 AND verified_at IS NOT NULL FOR UPDATE', [email],
      );
      if (!account) return;
      const active = await client.query(
        "SELECT 1 FROM account_tokens WHERE account_id=$1 AND purpose='reset' AND expires_at>now()+interval '55 minutes'",
        [account.id],
      );
      if (active.rowCount) return;
      await client.query("DELETE FROM account_tokens WHERE account_id=$1 AND purpose='reset'", [account.id]);
      const value = token();
      await client.query("INSERT INTO account_tokens VALUES ($1,$2,'reset',now()+interval '1 hour')", [hash(value), account.id]);
      await queueMail(client, this.config, account.id, 'reset:' + hash(value), 'Recupera tu contraseña',
        'Abre este enlace para elegir una contraseña nueva: ' + this.config.origin + '/mobile/auth/reset#reset=' + value);
    });
  }

  async resetPassword(value: string, password: string) {
    const replacement = await argon2.hash(password, { type: argon2.argon2id });
    await this.db.transaction(async client => {
      const key = hash(value);
      const { rows: [account] } = await client.query<{ id: string }>(
        "SELECT a.id FROM accounts a WHERE a.verified_at IS NOT NULL AND EXISTS (SELECT 1 FROM account_tokens t " +
        "WHERE t.account_id=a.id AND t.token_hash=$1 AND t.purpose='reset' AND t.expires_at>now()) FOR UPDATE", [key],
      );
      const used = account && await client.query(
        "DELETE FROM account_tokens WHERE token_hash=$1 AND account_id=$2 AND purpose='reset' AND expires_at>now()",
        [key, account.id],
      );
      if (!used?.rowCount) throw new UnprocessableEntityException('El enlace de recuperación expiró o ya fue usado.');
      await client.query('UPDATE accounts SET password_hash=$2 WHERE id=$1', [account.id, replacement]);
      await client.query('DELETE FROM sessions WHERE account_id=$1', [account.id]);
    });
  }

  async current(req: Request) {
    const session = sessionHash(req);
    const { rows: [account] } = await this.db.query<Omit<Account, 'password_hash' | 'verified_at'>>(
      'SELECT a.id,a.email,a.name FROM sessions s JOIN accounts a ON a.id=s.account_id ' +
      'WHERE s.token_hash=$1 AND s.expires_at>now() AND a.verified_at IS NOT NULL', [session],
    );
    if (!account) throw new UnauthorizedException('Inicia sesión para continuar.');
    return account;
  }

  async logout(req: Request, response: Response) {
    await this.db.query('DELETE FROM sessions WHERE token_hash=$1', [sessionHash(req)]);
    const { maxAge, ...cookie } = this.cookie();
    response.clearCookie('mailgasto_session', cookie);
  }

  async requestDeletion(accountId: string) {
    await this.db.transaction(async client => {
      await client.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [accountId]);
      const existing = await client.query(
        "SELECT 1 FROM account_tokens WHERE account_id=$1 AND purpose='delete' AND expires_at>now()", [accountId],
      );
      if (existing.rowCount) return;
      const value = token();
      await client.query("INSERT INTO account_tokens VALUES ($1,$2,'delete',now()+interval '1 hour')",
        [hash(value), accountId]);
      await queueMail(client, this.config, accountId, 'delete:' + hash(value), 'Confirma la eliminación',
        'Si solicitaste eliminar tus datos, inicia sesión y confirma en ' + this.config.origin + '/mobile/auth/delete#delete=' + value);
    });
  }

  async confirmDeletion(accountId: string, value: string) {
    await this.db.transaction(async client => {
      const valid = await client.query(
        "SELECT 1 FROM account_tokens WHERE account_id=$1 AND token_hash=$2 AND purpose='delete' AND expires_at>now() FOR UPDATE",
        [accountId, hash(value)],
      );
      if (!valid.rowCount) throw new UnprocessableEntityException('El enlace de eliminación expiró o es inválido.');
      const linked = await client.query(
        "SELECT 1 FROM mailboxes WHERE account_id=$1 AND source='oauth' AND state<>'disconnected' LIMIT 1",
        [accountId],
      );
      if (linked.rowCount) throw new ConflictException('Desvincula tus buzones de Gmail antes de eliminar la cuenta.');
      await client.query('DELETE FROM accounts WHERE id=$1', [accountId]);
    });
  }

  private cookie() {
    return { httpOnly: true, secure: this.config.secure, sameSite: 'lax' as const, path: '/', maxAge: 7 * 86_400_000 };
  }
}
