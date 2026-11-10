import * as argon2 from 'argon2';
import { DateTime } from 'luxon';
import { readConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { createApp } from '../src/main.js';

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '55433') {
    throw new Error('Usa el PostgreSQL local de MailGasto en el puerto 55433.');
  }
  url.pathname = '/mailgasto_mobile';
  const email = 'movil-qa@example.test';
  const config = readConfig({
    ...process.env,
    DATABASE_URL: url.href,
    PUBLIC_URL: 'http://localhost:3105',
    PORT: '3115',
    SMTP_URL: 'smtp://localhost:1026',
    N8N_AGENT_URL: '',
    N8N_GMAIL_WEBHOOK_URL: '',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
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
      for (const [id, day, currency, minor, category] of [
        ['cop', current, 'COP', 2_500_000, 'alimentacion'],
        ['usd', current, 'USD', 1250, 'transporte'],
        ['previous', previous, 'COP', 500_000, 'transporte'],
        ['pending', current, null, null, null],
      ] as const) {
        const { rows: [notice] } = await client.query(
          'INSERT INTO notices (mailbox_id,message_id,received_at,provider,forwarded,status,reason,unconfirmed_fields) ' +
          "VALUES ($1,$2,$3::date+interval '13 hours','nequi',false,$4,$5,$6) " +
          'ON CONFLICT(mailbox_id,message_id) DO UPDATE SET received_at=excluded.received_at RETURNING id',
          [mailbox.id, id, day, minor ? 'registered' : 'pending',
            minor ? null : 'missing_or_ambiguous_fields', minor ? null : ['amount']],
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
    console.info('API local de pruebas móviles en el puerto 3115.');
  } catch (error) {
    await app.close();
    throw error;
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Falló el entorno móvil de prueba.');
  process.exitCode = 1;
});
