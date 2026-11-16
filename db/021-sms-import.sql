CREATE TABLE sms_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
  device_id uuid NOT NULL,
  name text NOT NULL,
  senders text[] NOT NULL DEFAULT '{}',
  auto_detect boolean NOT NULL DEFAULT true,
  token_hash text NOT NULL UNIQUE,
  issuer_session_hash text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_import_at timestamptz,
  UNIQUE (account_id,device_id)
);

-- Raw messages and operation references never enter these tables.
CREATE TABLE sms_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES sms_devices ON DELETE CASCADE,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('registered','duplicate','ignored','pending')),
  classifier_version text NOT NULL,
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  reason text,
  movement_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id,fingerprint)
);

CREATE TABLE sms_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
  event_id uuid NOT NULL UNIQUE REFERENCES sms_events ON DELETE CASCADE,
  amount_minor bigint NOT NULL CHECK (amount_minor>0),
  currency char(3) NOT NULL CHECK (currency IN ('COP','USD','EUR')),
  transaction_date date NOT NULL CHECK (transaction_date>=DATE '1900-01-01'),
  payment_method text,
  description text NOT NULL,
  category text NOT NULL CHECK (category IN ('alimentacion','transporte','vivienda','ocio','salud','educacion','compras','ingresos','otros')),
  direction text NOT NULL CHECK (direction IN ('expense','income')),
  date_source text NOT NULL CHECK (date_source IN ('reported','received_at')),
  transaction_time text,
  CHECK ((direction='income')=(category='ingresos'))
);

CREATE TABLE sms_operation_references (
  movement_id uuid NOT NULL REFERENCES sms_movements ON DELETE CASCADE,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (movement_id,fingerprint)
);
CREATE INDEX sms_operation_references_fingerprint ON sms_operation_references(fingerprint);
CREATE INDEX sms_events_device ON sms_events(device_id,status);

CREATE TABLE sms_movement_adjustments (LIKE email_movement_adjustments INCLUDING ALL);
ALTER TABLE sms_movement_adjustments ADD FOREIGN KEY (movement_id) REFERENCES sms_movements ON DELETE CASCADE;
CREATE TABLE sms_movement_corrections (LIKE email_movement_corrections INCLUDING ALL);
ALTER TABLE sms_movement_corrections ADD FOREIGN KEY (movement_id) REFERENCES sms_movements ON DELETE CASCADE;

CREATE OR REPLACE VIEW confirmed_movements AS
SELECT t.id,m.account_id,coalesce(a.amount_minor,t.amount_minor) AS amount_minor,
       t.currency,coalesce(a.transaction_date,t.transaction_date) AS transaction_date,
       t.payment_method,t.description,coalesce(a.category,t.category) AS category,
       t.direction,'email'::text AS source,n.id AS notice_id,n.provider,
       a.note,t.amount_minor AS original_amount_minor,t.transaction_date AS original_transaction_date,
       coalesce(a.revision,0) AS correction_revision,n.date_source,n.received_at
FROM transactions t JOIN notices n ON n.id=t.notice_id JOIN mailboxes m ON m.id=n.mailbox_id
LEFT JOIN email_movement_adjustments a ON a.movement_id=t.id WHERE n.status='registered'
UNION ALL
SELECT id,account_id,amount_minor,currency,transaction_date,payment_method,description,category,direction,
       'manual',NULL::uuid,NULL::text,NULL::text,NULL::bigint,NULL::date,NULL::integer,NULL::text,NULL::timestamptz
FROM manual_movements
UNION ALL
SELECT s.id,s.account_id,coalesce(a.amount_minor,s.amount_minor),s.currency,coalesce(a.transaction_date,s.transaction_date),
       s.payment_method,s.description,coalesce(a.category,s.category),s.direction,'sms',NULL::uuid,'nequi',
       a.note,s.amount_minor,s.transaction_date,coalesce(a.revision,0),s.date_source,e.received_at
FROM sms_movements s JOIN sms_events e ON e.id=s.event_id
LEFT JOIN sms_movement_adjustments a ON a.movement_id=s.id;
