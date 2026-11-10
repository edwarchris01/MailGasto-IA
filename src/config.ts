import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const settings = z.object({
  PUBLIC_URL: z.url().default('http://localhost:3105'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3105),
  DATABASE_URL: z.url(),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i),
  N8N_INGEST_KEY: z.string().min(32),
  N8N_AGENT_KEY: z.string().min(32),
  N8N_AGENT_URL: z.url().optional(),
  N8N_AGENT_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(4000),
  N8N_GMAIL_WEBHOOK_URL: z.url({ protocol: /^https?$/ }).optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_SIGNIN_CLIENT_ID: z.string().optional(),
  GOOGLE_SIGNIN_CLIENT_SECRET: z.string().optional(),
  ANDROID_APP_LINK_SHA256: z.string().regex(/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/i).optional(),
  LEGACY_GMAIL_ADDRESS: z.email().optional(),
  SMTP_URL: z.url({ protocol: /^smtps?$/ }),
  SMTP_FROM: z.string().min(3),
  SUPPORT_KEY: z.string().min(32).optional(),
});

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const values = settings.parse(Object.fromEntries(Object.entries(env).filter(([, value]) => value)));
  if (Boolean(values.GOOGLE_SIGNIN_CLIENT_ID) !== Boolean(values.GOOGLE_SIGNIN_CLIENT_SECRET)) {
    throw new Error('Configure both GOOGLE_SIGNIN_CLIENT_ID and GOOGLE_SIGNIN_CLIENT_SECRET');
  }
  const publicUrl = new URL(values.PUBLIC_URL);
  if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash ||
      (publicUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(publicUrl.hostname))) {
    throw new Error('PUBLIC_URL must be an HTTPS origin or a local development origin');
  }
  return {
    ...values,
    origin: publicUrl.origin,
    secure: publicUrl.protocol === 'https:',
    encryptionKey: Buffer.from(values.ENCRYPTION_KEY, 'hex'),
  };
}

export type Config = ReturnType<typeof readConfig>;
export const CONFIG = Symbol('CONFIG');
export const token = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function equalSecret(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function encrypt(value: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

export function decrypt(value: string, key: Buffer) {
  const bytes = Buffer.from(value, 'base64url');
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
}
