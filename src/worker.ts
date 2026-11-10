import { randomUUID } from 'node:crypto';
import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { Agent } from './agent.js';
import { CONFIG, Config, decrypt } from './config.js';
import { Database } from './db.js';
import { NoticeText, readModel, resolveExtraction } from './extraction.js';
import { Gmail } from './gmail.js';
import { saveNoticeEffects } from './gmail-results.js';

type Job = { id: string; mailbox_id: string; provider: NoticeText['provider']; forwarded: boolean; payload: string | null };
type MailJob = { id: string; account_id: string; subject: string; body: string; email: string; attempts: number };

@Injectable()
export class Worker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly transport;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<Promise<void>>();

  constructor(
    @Inject(Database) private readonly db: Database, @Inject(CONFIG) private readonly config: Config,
    @Inject(Gmail) private readonly gmail: Gmail, @Inject(Agent) private readonly agent: Agent,
  ) {
    const smtp = new URL(config.SMTP_URL);
    const secure = smtp.protocol === 'smtps:';
    this.transport = nodemailer.createTransport({
      host: smtp.hostname,
      port: Number(smtp.port || (secure ? 465 : 587)),
      secure,
      auth: smtp.username ? { user: decodeURIComponent(smtp.username), pass: decodeURIComponent(smtp.password) } : undefined,
      connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 15_000,
      requireTLS: config.secure && !secure,
      disableFileAccess: true, disableUrlAccess: true,
    });
  }

  onApplicationBootstrap() {
    this.schedule('Gmail synchronization', 1000, () => this.gmail.pollOne());
    this.schedule('Gmail delivery', 250, () => this.gmail.dispatchOne());
    this.schedule('Previous notice queue', 1000, () => this.processOne());
    this.schedule('Gmail delivery cleanup', 3_600_000, () => this.pruneDeliveries());
    this.schedule('Mail delivery', 500, () => this.sendOne());
  }

  async onApplicationShutdown() {
    this.timers.forEach(clearInterval);
    await Promise.all(this.running);
    this.transport.close();
  }

  private schedule(name: string, interval: number, work: () => Promise<boolean>) {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      const job = work().then(() => {}).catch(() => console.warn(name + ' will retry')).finally(() => {
        busy = false;
        this.running.delete(job);
      });
      this.running.add(job);
    }, interval);
    this.timers.push(timer.unref());
  }

  async processOne() {
    // Drain jobs created by the old intake only. New Gmail uses the result callback.
    const lease = randomUUID();
    const { rows: [job] } = await this.db.query<Job>(
      "UPDATE notices SET lease=$1,due_at=now()+interval '30 seconds',attempts=attempts+1 " +
      "WHERE id=(SELECT id FROM notices WHERE status='processing' AND due_at<=now() " +
      'ORDER BY due_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,mailbox_id,provider,forwarded,payload', [lease],
    );
    if (!job) return false;
    const notice = { provider: job.provider, forwarded: job.forwarded, text: '' };
    let result: ReturnType<typeof resolveExtraction>;
    try {
      if (!job.payload) throw new Error('Missing work payload');
      notice.text = decrypt(job.payload, this.config.encryptionKey);
      const data = readModel(await this.agent.extract(notice));
      if (!data) throw new Error('Invalid model output');
      result = resolveExtraction(notice, data);
    } catch {
      result = resolveExtraction(notice, null, true);
    }
    await this.db.transaction(async client => {
      const { rows: [mailbox] } = await client.query<{ account_id: string }>(
        "SELECT account_id FROM mailboxes WHERE id=$1 AND state='active' FOR UPDATE", [job.mailbox_id],
      );
      if (!mailbox) return;
      const updated = await client.query(
        "UPDATE notices SET status=$3,reason=$4,confidence=$5,unconfirmed_fields=$6,completed_at=clock_timestamp(),payload=NULL,lease=NULL " +
        "WHERE id=$1 AND lease=$2 AND status='processing'",
        [job.id, lease, result.status, 'reason' in result ? result.reason : null, result.confidence,
          result.status === 'pending' ? result.unconfirmedFields : null],
      );
      if (!updated.rowCount) return;
      await saveNoticeEffects(client, this.config, mailbox.account_id, job.id, result);
    });
    return true;
  }

  private async pruneDeliveries() {
    await this.db.query('DELETE FROM mobile_gmail_oauth WHERE expires_at<=now()');
    const deleted = await this.db.query('DELETE FROM gmail_deliveries WHERE id IN (' +
      "SELECT id FROM gmail_deliveries WHERE completed_at<now()-interval '7 days' ORDER BY completed_at LIMIT 1000)");
    return !!deleted.rowCount;
  }

  async sendOne() {
    // A stale sending row can have been accepted by SMTP already. Leave it for review.
    await this.db.query(
      "UPDATE outbox SET status='error',body=NULL WHERE status='sending' AND due_at<=now()",
    );
    const { rows: [mail] } = await this.db.query<MailJob>(
      "WITH claimed AS (UPDATE outbox SET status='sending',attempts=attempts+1,due_at=now()+interval '2 minutes' " +
      "WHERE id=(SELECT id FROM outbox WHERE status='queued' AND due_at<=now() ORDER BY due_at " +
      'FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *) ' +
      'SELECT claimed.*,a.email FROM claimed JOIN accounts a ON a.id=claimed.account_id',
    );
    if (!mail) return false;
    try {
      await this.transport.sendMail({
        from: this.config.SMTP_FROM, to: mail.email, subject: mail.subject,
        text: decrypt(mail.body, this.config.encryptionKey),
        messageId: '<' + mail.id + '@' + new URL(this.config.origin).hostname + '>',
        disableFileAccess: true, disableUrlAccess: true,
      });
    } catch (error) {
      const smtp = error as { code?: string; responseCode?: number; command?: string };
      const rejected = (smtp.responseCode && smtp.responseCode >= 400 && smtp.responseCode < 500) ||
        smtp.code === 'ECONNECTION' || smtp.command === 'CONN';
      const retry = !!rejected && mail.attempts < 3;
      await this.db.query(
        "UPDATE outbox SET status=CASE WHEN $2 THEN 'queued' ELSE 'error' END," +
        "body=CASE WHEN $2 THEN body ELSE NULL END,due_at=now()+interval '1 minute' WHERE id=$1 AND status='sending'",
        [mail.id, retry],
      );
      return true;
    }
    await this.db.query("UPDATE outbox SET status='sent',sent_at=now(),body=NULL WHERE id=$1 AND status='sending'", [mail.id]);
    return true;
  }
}
