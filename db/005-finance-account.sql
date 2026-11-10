CREATE TABLE manual_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
  request_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency IN ('COP','USD','EUR')),
  transaction_date date NOT NULL,
  payment_method text,
  description text,
  category text NOT NULL CHECK (category IN ('alimentacion','transporte','vivienda','ocio','salud','educacion','ingresos','otros')),
  direction text NOT NULL CHECK (direction IN ('expense','income')),
  UNIQUE (account_id, request_id),
  CHECK ((direction = 'income') = (category = 'ingresos'))
);
CREATE INDEX manual_movements_history ON manual_movements(account_id, transaction_date DESC, id DESC);

CREATE VIEW confirmed_movements AS
SELECT t.id, m.account_id, t.amount_minor, t.currency, t.transaction_date,
       t.payment_method, t.description, t.category, t.direction, 'email'::text AS source,
       n.id AS notice_id, n.provider
FROM transactions t JOIN notices n ON n.id=t.notice_id JOIN mailboxes m ON m.id=n.mailbox_id
WHERE n.status='registered'
UNION ALL
SELECT id, account_id, amount_minor, currency, transaction_date,
       payment_method, description, category, direction, 'manual', NULL::uuid, NULL::text
FROM manual_movements;

ALTER TABLE account_tokens DROP CONSTRAINT account_tokens_purpose_check;
ALTER TABLE account_tokens ADD CHECK (purpose IN ('verify','delete','reset'));
ALTER TABLE accounts ALTER COLUMN password_hash DROP NOT NULL;

CREATE TABLE google_identities (
  subject text PRIMARY KEY,
  account_id uuid NOT NULL UNIQUE REFERENCES accounts ON DELETE CASCADE
);

CREATE TABLE mobile_google_signins (
  state_hash text PRIMARY KEY,
  challenge text NOT NULL,
  verifier text NOT NULL,
  receipt_hash text UNIQUE,
  account_id uuid REFERENCES accounts ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX mobile_google_signins_expiry ON mobile_google_signins(expires_at);

ALTER TABLE chat_turns ADD COLUMN ui_action text CHECK (ui_action IN ('register','analysis'));
