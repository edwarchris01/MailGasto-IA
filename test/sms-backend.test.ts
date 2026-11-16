import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { Accounts } from '../src/accounts.js';
import { hash, readConfig, token } from '../src/config.js';
import { Database } from '../src/db.js';
import { GmailResults, gmailResult } from '../src/gmail-results.js';
import { createApp } from '../src/main.js';

const connection=process.env.MAILGASTO_TEST_DATABASE_URL;
test('SMS imports remain scoped, private, idempotent, editable and distinct from email', {skip:!connection}, async t=>{
  const url=new URL(connection!);
  assert(['localhost','127.0.0.1'].includes(url.hostname));assert.equal(url.pathname,'/mailgasto_test');
  const admin=new Pool({connectionString:url.href});
  const schema='sms_backend_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE SCHEMA '+schema);url.searchParams.set('options','-c search_path='+schema);
  const config=readConfig({DATABASE_URL:url.href,ENCRYPTION_KEY:'cd'.repeat(32),N8N_AGENT_KEY:'local-sms-agent-key-not-production',
    N8N_INGEST_KEY:'local-sms-ingest-key-not-production',SMTP_URL:'smtp://localhost:1026',SMTP_FROM:'sms@example.test',
    LEGACY_GMAIL_ADDRESS:'sms-owner@example.test'});
  const app=await createApp(config,false);await app.listen(0,'127.0.0.1');
  t.after(async()=>{await app.close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
  const base=await app.getUrl(),db=app.get(Database),gmail=app.get(GmailResults);
  const account=async(email:string)=>{
    const {rows:[owner]}=await db.query<{id:string}>("INSERT INTO accounts(email,name,verified_at) VALUES($1,'SMS fixture',now()) RETURNING id",[email]);
    const secret=token();await db.query("INSERT INTO sessions VALUES($1,$2,now()+interval '7 days')",[hash(secret),owner.id]);
    return {id:owner.id,secret,cookie:'mailgasto_session='+secret};
  };
  const owner=await account('sms-owner@example.test'),other=await account('sms-other@example.test');
  const request=(path:string,method='GET',body?:unknown,credential=owner.cookie,bearer=false)=>fetch(base+'/v1/'+path,{
    method,headers:{Origin:config.origin,'Content-Type':'application/json',...(bearer?{Authorization:'Bearer '+credential}:{Cookie:credential})},
    body:body===undefined?undefined:JSON.stringify(body),
  });
  const configure=async(deviceId=randomUUID(),cookie=owner.cookie)=>{
    const response=await request('sms/devices','POST',{deviceId},cookie);assert.equal(response.status,200);return {...await response.json(),deviceId};
  };
  let device=await configure();
  const item=(body:string,receivedAt='2026-11-15T15:20:00.000Z',sender='85954')=>({externalId:randomUUID(),sender,receivedAt,body,provider:'nequi'});
  const incoming=item('Nequi: Recibiste COP 300.000 de PERSONA SINTETICA por Bre-B.');
  const ingest=async(items:unknown[],credential=device.ingestToken)=>{
    const response=await request('sms/import','POST',{items},credential,true);assert.equal(response.status,200);return (await response.json()).results;
  };
  let movementId:string;

  await t.test('opt-in token is write-only; session cookies cannot import and accounts cannot manage other devices',async()=>{
    assert.equal(device.autoDetect,true);assert.deepEqual(device.senders,[]);assert.equal(device.since,'2026-11-01');
    for(const path of ['auth/me','movements','sms/devices']) assert.equal((await request(path,'GET',undefined,device.ingestToken,true)).status,401);
    assert.equal((await request('sms/import','POST',{items:[incoming]})).status,401);
    assert.equal((await request('sms/devices/'+device.id,'DELETE',undefined,other.cookie)).status,404);
    assert.deepEqual((await (await request('sms/devices','GET',undefined,other.cookie)).json()).items,[]);
    const listed=await (await request('sms/devices')).json();assert.equal(listed.items[0].auto_detect,true);
    assert.doesNotMatch(JSON.stringify(listed),/token|session_hash/);
    assert.equal((await request('sms/import','POST',{items:Array(51).fill(incoming)},device.ingestToken,true)).status,400);
  });

  await t.test('concurrent replay, client ID changes and equivalent receipt timestamps create one SMS movement',async()=>{
    const [left,right]=await Promise.all([ingest([incoming]),ingest([{...incoming,externalId:'another-client-id',receivedAt:'2026-11-15T10:20:00-05:00',body:' Nequi:  Recibiste COP 300.000 de PERSONA SINTETICA por Bre-B. '}])]);
    assert.deepEqual([left[0].status,right[0].status].sort(),['duplicate','registered']);
    assert.equal(left[0].movementId,right[0].movementId);movementId=left[0].movementId;
    const detail=await (await request('movements/'+movementId)).json();
    assert.deepEqual([detail.source,detail.provider,detail.amount_minor,detail.direction,detail.transaction_date,detail.date_source,detail.transaction_time],
      ['sms','nequi','30000000','income','2026-11-15','received_at','10:20:00']);
    assert.equal(detail.notice_id,null);assert.equal(detail.reported_transaction_date,null);assert.equal(detail.correction_revision,0);
    assert.equal(detail.reported_institution,'nequi','Match the shared lowercase institution contract used by Flutter');
    assert.doesNotMatch(JSON.stringify(detail),/PERSONA SINTETICA|85954/);
    assert.equal((await request('movements/'+movementId,'GET',undefined,other.cookie)).status,404);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM notices')).rows[0].count,0);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM sms_events')).rows[0].count,1);
  });

  await t.test('different real events with equal amounts remain separate; privacy and ineffective states produce no notices',async()=>{
    const second=await ingest([item(incoming.body,'2026-11-15T15:21:00Z')]);assert.equal(second[0].status,'registered');
    assert.notEqual(second[0].movementId,movementId);
    const ignored=await ingest([
      item('Nequi: Tu codigo de seguridad es 123456.'),item('Nequi: Tu pago de COP 50.000 fue rechazado.'),
      item('Bancolombia: Recibiste COP 50.000.'),item('Recibiste COP 50.000.'),
      item('Nequi: Recibiste una transferencia.'),item(incoming.body,'2026-10-31T18:00:00Z'),
    ]);
    assert.deepEqual(ignored.map((r:{status:string})=>r.status),['ignored','ignored','ignored','ignored','pending','ignored']);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM notices')).rows[0].count,0);
    const events=(await db.query('SELECT * FROM sms_events')).rows;
    assert.doesNotMatch(JSON.stringify(events),/PERSONA|"body"|"sender"|Recibiste/);
    assert.ok(events.every(event=>!Object.hasOwn(event,'body') && !Object.hasOwn(event,'sender')));
    const list=await (await request('movements?source=sms')).json();assert.equal(list.items.length,2);
    const totals=await (await request('analytics?from=2026-11-01&to=2026-11-16&currency=COP')).json();assert.equal(totals.incomeMinor,'60000000');
    const status=await (await request('sms/devices')).json();
    assert.deepEqual(status.items[0].counts,{registered:2,duplicate:0,ignored:5,pending:1});
  });

  await t.test('amount/date corrections preserve the source, original receipt and revision audit',async()=>{
    const correction={revision:0,amountMinor:'29900000',date:'2026-11-14'};
    assert.equal((await request('movements/'+movementId+'/correction','PATCH',correction,other.cookie)).status,404);
    assert.equal((await request('movements/'+movementId+'/correction','PATCH',correction)).status,204);
    assert.equal((await request('movements/'+movementId+'/correction','PATCH',{revision:0,amountMinor:'29800000'})).status,409);
    let detail=await (await request('movements/'+movementId)).json();
    assert.deepEqual([detail.amount_minor,detail.original_amount_minor,detail.transaction_date,detail.original_transaction_date,detail.correction_revision],
      ['29900000','30000000','2026-11-14','2026-11-15',1]);
    assert.equal(detail.date_source,'received_at');assert.equal(detail.transaction_time,'10:20:00');
    assert.equal((await request('movements/'+movementId+'/email-details','PATCH',{note:'Nota del usuario'})).status,204);
    assert.equal((await ingest([incoming]))[0].status,'duplicate');
    detail=await (await request('movements/'+movementId)).json();assert.equal(detail.amount_minor,'29900000');assert.equal(detail.note,'Nota del usuario');
    const history=await (await request('movements/'+movementId+'/corrections')).json();
    assert.equal(history.items.length,1);assert.equal(history.items[0].previous_amount_minor,'30000000');
  });

  await t.test('strong PSE references deduplicate in either channel order while amount-only matches do not',async()=>{
    await db.query("INSERT INTO mailboxes(account_id,email,source,state,linked_at) VALUES($1,'sms-owner@example.test','n8n','active','2026-11-01')",[owner.id]);
    const mail=(amount:string,reference?:string)=>gmailResult.parse({source:'legacy',messageId:randomUUID(),receivedAt:'2026-11-15T15:30:00Z',
      startedAt:'2026-11-15T15:30:00Z',provider:'nequi',forwarded:false,authenticated:true,status:'registered',confidence:1,
      ...(reference?{references:['pse:'+reference]}:{}),movement:{amountMinor:amount,currency:'COP',date:'2026-11-15',dateSource:'reported',
        paymentMethod:'PSE',description:'Pago',category:'otros',direction:'expense'}});
    assert.equal((await gmail.save(mail('8000000','123456789012'))).outcome,'stored');
    const sms=await ingest([item('Nequi: Pagaste COP 80.000 mediante PSE el 15/11/2026. CUS: 123456789012.')]);
    assert.equal(sms[0].status,'duplicate');
    assert.equal((await ingest([item('Nequi: Pagaste COP 80.000 mediante PSE el 15/11/2026.')]))[0].status,'registered');
    const smsFirst=await ingest([item('Nequi: Pagaste COP 90.000 mediante PSE el 15/11/2026. CUS: 123456789013.')]);
    assert.equal(smsFirst[0].status,'registered');
    assert.equal((await gmail.save(mail('9000000','123456789013'))).outcome,'duplicate');
    const conflicting=await ingest([item('Nequi: Pagaste COP 95.000 mediante PSE el 15/11/2026. CUS: 123456789013.')]);
    assert.equal(conflicting[0].status,'pending');assert.equal(conflicting[0].reason,'conflicting_reference');
    const totals=await db.query('SELECT count(*)::int AS count FROM confirmed_movements WHERE amount_minor IN(8000000,9000000)');assert.equal(totals.rows[0].count,3);
    const [emailRace,smsRace]=await Promise.all([
      gmail.save(mail('10000000','123456789014')),
      ingest([item('Nequi: Pagaste COP 100.000 mediante PSE el 15/11/2026. CUS: 123456789014.')]),
    ]);
    assert.equal(Number(emailRace.outcome==='stored')+Number(smsRace[0].status==='registered'),1);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM confirmed_movements WHERE amount_minor=10000000')).rows[0].count,1);
  });

  await t.test('a throttled batch returns retriable 429 without partially creating movements',async()=>{
    const bucket=hash('sms:'+device.id);
    await db.query('UPDATE rate_limits SET hits=120 WHERE bucket=$1',[bucket]);
    assert.equal((await request('sms/import','POST',{items:[item('Nequi: Recibiste COP 40.000.')]},device.ingestToken,true)).status,429);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM confirmed_movements WHERE amount_minor=4000000')).rows[0].count,0);
    await db.query('DELETE FROM rate_limits WHERE bucket=$1',[bucket]);
  });

  await t.test('a policy or classifier upgrade can recover unregistered events without changing registered financial data',async()=>{
    const deviceId=randomUUID();
    const disabled=await (await request('sms/devices','POST',{deviceId,autoDetect:false})).json();
    const recovering=item('Nequi: Recibiste COP 45.000.');
    assert.equal((await ingest([recovering],disabled.ingestToken))[0].status,'ignored');
    const enabled=await configure(deviceId);
    assert.equal((await ingest([recovering],enabled.ingestToken))[0].status,'registered');
    assert.equal((await ingest([recovering],enabled.ingestToken))[0].status,'duplicate');
    assert.equal((await db.query('SELECT count(*)::int AS count FROM sms_events WHERE device_id=$1',[enabled.id])).rows[0].count,1);

    const legacyDevice=await (await request('sms/devices','POST',{deviceId:randomUUID(),autoDetect:false})).json();
    const legacy=item('Nequi: Recibiste COP 46.000.');
    assert.equal((await ingest([legacy],legacyDevice.ingestToken))[0].status,'ignored');
    // Model a persisted incomplete outcome from a previous classifier with today's same policy.
    await db.query('UPDATE sms_devices SET auto_detect=true WHERE id=$1',[legacyDevice.id]);
    await db.query("UPDATE sms_events SET status='pending',reason='missing_or_ambiguous_fields',policy_hash=$2 WHERE device_id=$1",
      [legacyDevice.id,hash(JSON.stringify([true,[]]))]);
    assert.equal((await ingest([legacy],legacyDevice.ingestToken))[0].status,'pending','No repeated parsing at the same version');
    await db.query("UPDATE sms_events SET classifier_version='previous-version' WHERE device_id=$1",[legacyDevice.id]);
    assert.equal((await ingest([legacy],legacyDevice.ingestToken))[0].status,'registered');
    assert.equal((await db.query("SELECT count(*)::int AS count FROM sms_events WHERE device_id=$1 AND status='registered'",[legacyDevice.id])).rows[0].count,1);
    await db.query("UPDATE sms_events SET classifier_version='previous-version' WHERE movement_id=$1",[movementId]);
    assert.equal((await ingest([incoming]))[0].status,'duplicate');
    const original=await (await request('movements/'+movementId)).json();assert.equal(original.amount_minor,'29900000');assert.equal(original.correction_revision,1);
  });

  await t.test('SMS classifier v2 recovers a prior unconfirmed reversal without changing its purchases or other movements',async()=>{
    const purchases=[
      item('NEQUI: Pagaste 300,00 en COMERCIO SINTETICO con tu Tarjeta','2026-11-04T08:20:36.834Z'),
      item('NEQUI: Pagaste 30.000,00 en COMERCIO SINTETICO con tu Tarjeta','2026-11-04T08:21:36.834Z'),
    ];
    const paid=await ingest(purchases);
    assert.deepEqual(paid.map((row:{status:string})=>row.status),['registered','registered']);
    const previous=(await db.query('SELECT id,source,amount_minor::text,currency,transaction_date::text,direction,' +
      'original_amount_minor::text,original_transaction_date::text,correction_revision,note FROM confirmed_movements ORDER BY id')).rows;
    const legacyDeviceId=randomUUID();
    const disabled=await (await request('sms/devices','POST',{deviceId:legacyDeviceId,autoDetect:false})).json();
    // Anonymized observed reversal. Seed its previously unconfirmed outcome without storing the SMS body.
    const reversal=item('NEQUI: Reversamos 300,00 de tu compra en COMERCIO SINTETICO a tu Tarjeta','2026-11-04T08:22:36.834Z');
    assert.equal((await ingest([reversal],disabled.ingestToken))[0].status,'ignored');
    const enabled=await configure(legacyDeviceId);
    const {rows:[prior]}=await db.query("UPDATE sms_events SET classifier_version='2026-11-16.1',policy_hash=$2," +
      "status='pending',reason='missing_or_ambiguous_fields' WHERE device_id=$1 RETURNING id",[enabled.id,hash(JSON.stringify([true,[]]))]);
    const [recovered]=await ingest([reversal],enabled.ingestToken);
    assert.equal(recovered.status,'registered');
    const detail=await (await request('movements/'+recovered.movementId)).json();
    assert.deepEqual([detail.source,detail.amount_minor,detail.currency,detail.direction,detail.category,
      detail.transaction_date,detail.transaction_time,detail.date_source,detail.received_at],
    ['sms','30000','COP','income','ingresos','2026-11-04','03:22:36','received_at','2026-11-04T08:22:36.834Z']);
    assert.deepEqual((await db.query('SELECT id,status,classifier_version,movement_id FROM sms_events WHERE device_id=$1',[enabled.id])).rows,
      [{id:prior.id,status:'registered',classifier_version:'2026-11-16.2',movement_id:recovered.movementId}]);
    assert.equal((await ingest([{...reversal,externalId:'retry-on-another-device'}]))[0].movementId,recovered.movementId);
    await db.query("UPDATE sms_events SET classifier_version='2026-11-16.1' WHERE movement_id=ANY($1::uuid[])",
      [paid.map((row:{movementId:string})=>row.movementId)]);
    assert.deepEqual((await ingest(purchases)).map((row:{status:string})=>row.status),['duplicate','duplicate']);
    const after=(await db.query('SELECT id,source,amount_minor::text,currency,transaction_date::text,direction,' +
      'original_amount_minor::text,original_transaction_date::text,correction_revision,note FROM confirmed_movements WHERE id=ANY($1::uuid[]) ORDER BY id',
    [previous.map(row=>row.id)])).rows;
    assert.deepEqual(after,previous,'Existing purchases, corrections and all financial values remain unchanged');
    assert.equal((await db.query('SELECT count(*)::int AS count FROM sms_movements WHERE event_id=$1',[prior.id])).rows[0].count,1);
  });

  await t.test('token survives passive session expiration, rotates on reconfiguration and revokes on logout',async()=>{
    await db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[hash(owner.secret)]);
    assert.equal((await ingest([incoming]))[0].status,'duplicate');
    assert.equal((await request('sms/devices','POST',{deviceId:device.deviceId})).status,401);
    await db.query("UPDATE sessions SET expires_at=now()+interval '1 day' WHERE token_hash=$1",[hash(owner.secret)]);
    const old=device.ingestToken;device=await configure(device.deviceId);
    assert.equal((await request('sms/import','POST',{items:[incoming]},old,true)).status,401);
    assert.equal((await ingest([incoming]))[0].status,'duplicate');
    assert.equal((await request('auth/logout','POST')).status,204);
    assert.equal((await request('sms/import','POST',{items:[incoming]},device.ingestToken,true)).status,401);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM confirmed_movements')).rows[0].count,11);
  });

  await t.test('explicit disable and password reset revoke device credentials without deleting movements',async()=>{
    const deviceB=await configure(randomUUID(),other.cookie);
    const ownCopy=await ingest([incoming],deviceB.ingestToken);
    assert.equal(ownCopy[0].status,'registered');assert.notEqual(ownCopy[0].movementId,movementId);
    assert.equal((await request('movements/'+ownCopy[0].movementId,'GET',undefined,other.cookie)).status,200);
    assert.equal((await request('sms/devices/'+deviceB.id,'DELETE',undefined,other.cookie)).status,204);
    assert.equal((await request('sms/import','POST',{items:[incoming]},deviceB.ingestToken,true)).status,401);
    const deviceC=await configure(randomUUID(),other.cookie),reset=token();
    await db.query("INSERT INTO account_tokens VALUES($1,$2,'reset',now()+interval '1 hour')",[hash(reset),other.id]);
    await app.get(Accounts).resetPassword(reset,'A synthetic password 123!');
    assert.equal((await request('sms/import','POST',{items:[incoming]},deviceC.ingestToken,true)).status,401);
  });
});
