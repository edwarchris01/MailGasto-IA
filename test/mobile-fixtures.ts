import * as argon2 from 'argon2';
import { DateTime } from 'luxon';
import { readConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { createApp } from '../src/main.js';

async function main() {
  const url = new URL(process.env.MAILGASTO_MOBILE_DATABASE_URL ?? process.env.DATABASE_URL ?? '');
  const smtp = new URL(process.env.MAILGASTO_MOBILE_SMTP_URL ?? 'smtp://localhost:1026');
  const agent = process.env.MAILGASTO_MOBILE_AGENT_URL;
  const local = (host: string) => ['localhost', '127.0.0.1'].includes(host);
  if (!local(url.hostname) || !local(smtp.hostname) || (agent && !local(new URL(agent).hostname))) {
    throw new Error('Las pruebas móviles requieren servicios locales.');
  }
  url.pathname = '/mailgasto_mobile';
  const email = 'movil-qa@example.test';
  const config = readConfig({
    ...process.env,
    DATABASE_URL: url.href,
    PUBLIC_URL: 'http://localhost:3105',
    PORT: process.env.MAILGASTO_MOBILE_TEST_PORT ?? '3115',
    SMTP_URL: smtp.href,
    N8N_AGENT_URL: agent ?? '',
    N8N_GMAIL_WEBHOOK_URL: '',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    GOOGLE_SIGNIN_CLIENT_ID: '',
    GOOGLE_SIGNIN_CLIENT_SECRET: '',
    LEGACY_GMAIL_ADDRESS: email,
  });
  const app = await createApp(config);
  try {
    const today = DateTime.now().setZone('America/Bogota');
    const current = today.toISODate();
    const previous = today.minus({ months: 1 }).set({ day: 12 }).toISODate();
    const passwordHash = await argon2.hash('synthetic-mobile-password');
    await app.get(Database).transaction(async client => {
      const { rows: [owner] } = await client.query(
        "INSERT INTO accounts (email,name,password_hash,verified_at) VALUES ($1,'Cuenta de prueba',$2,now()) " +
        'ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash,verified_at=now() RETURNING id',
        [email, passwordHash],
      );
      const { rows: [mailbox] } = await client.query(
        "INSERT INTO mailboxes (account_id,email,source,state,last_synced_at) VALUES ($1,$2,'n8n','active',now()) " +
        "ON CONFLICT(email) DO UPDATE SET state='active',last_synced_at=now() RETURNING id",
        [owner.id, email],
      );
      await client.query('DELETE FROM notices WHERE mailbox_id=$1 AND message_id=ANY($2::text[])',
        [mailbox.id, ['cop', 'pending', 'pending-other']]);
      for (const [id, day, currency, minor, category, provider = 'nequi'] of [
        ['cop', current, 'COP', 2_500_000, 'alimentacion'],
        ['usd', current, 'USD', 1250, 'transporte'],
        ['previous', previous, 'COP', 500_000, 'transporte'],
        ['pending', current, null, null, null],
        ['pending-other', current, null, null, null, 'other'],
      ] as const) {
        const { rows: [notice] } = await client.query(
          'INSERT INTO notices (mailbox_id,message_id,received_at,provider,forwarded,status,reason,unconfirmed_fields) ' +
          "VALUES ($1,$2,$3::date+interval '13 hours',$4,false,$5,$6,$7) " +
          'ON CONFLICT(mailbox_id,message_id) DO UPDATE SET received_at=excluded.received_at RETURNING id',
          [mailbox.id, id, day, provider, minor ? 'registered' : 'pending',
            minor ? null : provider === 'other' ? 'unverified_sender' : 'missing_or_ambiguous_fields',
            minor || provider === 'other' ? null : ['amount']],
        );
        if (minor) {
          await client.query(
            'INSERT INTO transactions (notice_id,amount_minor,currency,transaction_date,payment_method,description,category,direction) ' +
            "VALUES ($1,$2,$3,$4,'Nequi','Comercio ficticio',$5,'expense') " +
            'ON CONFLICT(notice_id) DO UPDATE SET transaction_date=excluded.transaction_date',
            [notice.id, minor, currency, day, category],
          );
        }
      }
    });
    app.enableShutdownHooks();
    await app.listen(config.PORT, '127.0.0.1');
    console.info('API local de pruebas móviles en el puerto ' + config.PORT + '.');
  } catch (error) {
    await app.close();
    throw error;
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Falló el entorno móvil de prueba.');
  process.exitCode = 1;
});
