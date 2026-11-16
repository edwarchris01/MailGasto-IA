import { HttpException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { uuid } from './accounts.js';
import { CONFIG, Config, hash, token } from './config.js';
import { Database } from './db.js';
import { operationFingerprint } from './operation-reference.js';
import { parseNequiSms, type SmsMovement } from './sms-rules.js';

const sender = z.string().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/);
export const smsDeviceInput = z.strictObject({
  deviceId: uuid, name: z.string().trim().min(1).max(80).optional(),
  senders: z.array(sender).max(20).transform(values => [...new Set(values)]).default([]),
  autoDetect: z.boolean().default(true),
});
export const smsImportInput = z.strictObject({ items: z.array(z.strictObject({
  externalId: z.string().min(1).max(128), sender,
  receivedAt: z.iso.datetime({ offset: true }), body: z.string().max(5000), provider: z.literal('nequi'),
})).min(1).max(50) });
type Item = z.infer<typeof smsImportInput>['items'][number];
type Device = { id: string; account_id: string; senders: string[]; auto_detect: boolean };
type Saved = { id: string; status: 'registered' | 'duplicate' | 'ignored' | 'pending'; reason: string | null;
  movement_id: string | null; classifier_version: string; policy_hash: string };
type Match = { id: string; amount_minor: string; currency: string; transaction_date: string; direction: string; date_source: string | null };
const since = '2026-11-01';
export const smsClassifierVersion = '2026-11-16.2';

@Injectable()
export class Sms {
  constructor(@Inject(Database) private readonly db: Database, @Inject(CONFIG) private readonly config: Config) {}

  async configure(account: string, session: string, values: z.infer<typeof smsDeviceInput>) {
    const ingestToken = token();
    return this.db.transaction(async client => {
    const authorized = await client.query('SELECT 1 FROM sessions WHERE token_hash=$1 AND account_id=$2 AND expires_at>now() FOR SHARE',[session,account]);
    if (!authorized.rowCount) throw new UnauthorizedException('Inicia sesión para activar SMS.');
    const { rows: [device] } = await client.query<{ id: string }>(
      'INSERT INTO sms_devices(account_id,device_id,name,senders,token_hash,issuer_session_hash,auto_detect) VALUES($1,$2,$3,$4,$5,$6,$7) ' +
      'ON CONFLICT(account_id,device_id) DO UPDATE SET name=excluded.name,senders=excluded.senders,' +
      'token_hash=excluded.token_hash,issuer_session_hash=excluded.issuer_session_hash,auto_detect=excluded.auto_detect,enabled=true RETURNING id',
      [account, values.deviceId, values.name ?? 'Android', values.senders, hash(ingestToken), session, values.autoDetect]);
    return { id: device.id, ingestToken, senders: values.senders, autoDetect: values.autoDetect, since };
    });
  }

  async list(account: string) {
    const { rows } = await this.db.query('SELECT d.id,d.device_id,d.name,d.senders,d.auto_detect,d.enabled,d.last_import_at,' +
      "json_build_object('registered',count(e.id) FILTER(WHERE e.status='registered')," +
      "'duplicate',count(e.id) FILTER(WHERE e.status='duplicate'),'ignored',count(e.id) FILTER(WHERE e.status='ignored')," +
      "'pending',count(e.id) FILTER(WHERE e.status='pending')) AS counts " +
      'FROM sms_devices d LEFT JOIN sms_events e ON e.device_id=d.id WHERE d.account_id=$1 GROUP BY d.id ORDER BY d.created_at', [account]);
    return { items: rows };
  }

  async revoke(account: string, id: string) {
    const result = await this.db.query('UPDATE sms_devices SET enabled=false WHERE account_id=$1 AND id=$2', [account,id]);
    if (!result.rowCount) throw new NotFoundException('Dispositivo no encontrado.');
  }

  async import(authorization: string | undefined, values: z.infer<typeof smsImportInput>) {
    const bearer = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!bearer) throw new UnauthorizedException('Activa la importación de SMS en la app.');
    return this.db.transaction(async client => {
      // Lock the device for the bounded batch; a later revoke/rotation rejects all following batches.
      const { rows: [device] } = await client.query<Device>(
        'SELECT d.id,d.account_id,d.senders,d.auto_detect FROM sms_devices d JOIN accounts a ON a.id=d.account_id ' +
        'WHERE d.token_hash=$1 AND d.enabled AND a.verified_at IS NOT NULL FOR UPDATE OF d', [hash(bearer)]);
      if (!device) throw new UnauthorizedException('La importación de SMS está desactivada.');
      const { rows: [limit] } = await client.query<{ hits: number }>(
        "INSERT INTO rate_limits(bucket,hits,expires_at) VALUES($1,1,now()+interval '10 minutes') " +
        'ON CONFLICT(bucket) DO UPDATE SET hits=CASE WHEN rate_limits.expires_at<=now() THEN 1 ELSE rate_limits.hits+1 END,' +
        "expires_at=CASE WHEN rate_limits.expires_at<=now() THEN now()+interval '10 minutes' ELSE rate_limits.expires_at END RETURNING hits",
        [hash('sms:' + device.id)]);
      if (limit.hits > 120) throw new HttpException('Demasiadas importaciones. Inténtalo más tarde.',429);
      // Same lock as Gmail: simultaneous channel deliveries cannot both create an operation.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1))', [device.account_id]);
      const results = [];
      for (const item of values.items) results.push(await this.save(client,device,item));
      await client.query('UPDATE sms_devices SET last_import_at=clock_timestamp() WHERE id=$1',[device.id]);
      return { results };
    });
  }

  private async save(client: PoolClient, device: Device, item: Item) {
    const policyHash = hash(JSON.stringify([device.auto_detect,[...device.senders].sort()]));
    const normalizedBody = item.body.normalize('NFKC').replace(/\s+/g,' ').trim();
    const fingerprint = createHmac('sha256',this.config.encryptionKey).update(JSON.stringify([
      'sms-event',device.account_id,item.sender,new Date(item.receivedAt).toISOString(),normalizedBody,
    ])).digest('hex');
    const { rows: [existing] } = await client.query<Saved>(
      'SELECT id,status,reason,movement_id,classifier_version,policy_hash FROM sms_events WHERE account_id=$1 AND fingerprint=$2', [device.account_id,fingerprint]);
    if (existing && (existing.status === 'registered' || existing.status === 'duplicate' ||
        existing.classifier_version === smsClassifierVersion && existing.policy_hash === policyHash)) {
      return { externalId:item.externalId,status:existing.status === 'registered' ? 'duplicate' : existing.status,
      ...(existing.reason ? { reason:existing.reason } : {}), ...(existing.movement_id ? { movementId:existing.movement_id } : {}) };
    }
    let status: Saved['status'] = 'ignored', reason: string | null = null, movementId: string | null = null;
    let movement: SmsMovement | undefined, fingerprints: string[] = [];
    if (Date.parse(item.receivedAt)<Date.parse(since+'T05:00:00Z') || Date.parse(item.receivedAt)>Date.now()+300_000) reason='outside_import_period';
    else {
      const result = parseNequiSms(item,device.senders,device.auto_detect);
      if (result.status !== 'registered') { status=result.status === 'unconfirmed' ? 'pending' : 'ignored'; reason=result.reason; }
      else {
        movement=result.movement; status='registered';
        fingerprints=(result.references ?? []).map(reference=>operationFingerprint(reference,device.account_id,this.config.encryptionKey));
        if (fingerprints.length) {
          const matches=await this.referenceMatches(client,device.account_id,fingerprints);
          if (matches.length===1 && sameOperation(matches[0],movement)) { status='duplicate';movementId=matches[0].id;reason='verified_reference'; }
          else if (matches.length) { status='pending';reason='conflicting_reference'; }
        }
      }
    }
    // Only unregistered outcomes can be reconsidered, and only once per classifier/policy revision.
    const { rows:[event] } = existing ? await client.query<{id:string}>(
      'UPDATE sms_events SET status=$2,reason=$3,movement_id=$4,classifier_version=$5,policy_hash=$6 WHERE id=$1 RETURNING id',
      [existing.id,status,reason,movementId,smsClassifierVersion,policyHash]) : await client.query<{id:string}>(
      'INSERT INTO sms_events(account_id,device_id,fingerprint,received_at,status,reason,movement_id,classifier_version,policy_hash) ' +
      'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [device.account_id,device.id,fingerprint,item.receivedAt,status,reason,movementId,smsClassifierVersion,policyHash]);
    if (status==='registered' && movement) {
      const { rows:[saved] } = await client.query<{id:string}>(
        'INSERT INTO sms_movements(account_id,event_id,amount_minor,currency,transaction_date,payment_method,description,category,direction,date_source,transaction_time) ' +
        'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
        [device.account_id,event.id,movement.amountMinor,movement.currency,movement.date,movement.paymentMethod,
          movement.description,movement.category,movement.direction,movement.dateSource ?? 'reported',movement.transactionTime ?? null]);
      movementId=saved.id;
      await client.query('UPDATE sms_events SET movement_id=$2 WHERE id=$1',[event.id,movementId]);
      if (fingerprints.length) await client.query('INSERT INTO sms_operation_references(movement_id,fingerprint) ' +
        'SELECT $1,fingerprint FROM unnest($2::text[]) AS refs(fingerprint)',[movementId,fingerprints]);
    }
    return { externalId:item.externalId,status,...(reason ? {reason} : {}),...(movementId ? {movementId} : {}) };
  }

  private async referenceMatches(client: PoolClient,account: string,fingerprints: string[]) {
    const { rows } = await client.query<Match>(
      'SELECT DISTINCT t.id,t.amount_minor::text,t.currency,t.transaction_date::text,t.direction,n.date_source ' +
      'FROM gmail_operation_references r JOIN notices n ON n.id=r.notice_id JOIN transactions t ON t.notice_id=n.id ' +
      "JOIN mailboxes m ON m.id=n.mailbox_id WHERE m.account_id=$1 AND n.status='registered' AND r.fingerprint=ANY($2::text[]) " +
      'UNION SELECT DISTINCT s.id,s.amount_minor::text,s.currency,s.transaction_date::text,s.direction,s.date_source ' +
      'FROM sms_operation_references r JOIN sms_movements s ON s.id=r.movement_id WHERE s.account_id=$1 AND r.fingerprint=ANY($2::text[]) LIMIT 2',
      [account,fingerprints]);
    return rows;
  }
}

function sameOperation(existing: Match,movement: SmsMovement) {
  return existing.amount_minor===movement.amountMinor && existing.currency===movement.currency && existing.direction===movement.direction &&
    (existing.transaction_date===movement.date || movement.dateSource==='received_at' || existing.date_source==='received_at');
}
