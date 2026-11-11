CREATE TABLE email_movement_adjustments (
  movement_id uuid PRIMARY KEY REFERENCES transactions ON DELETE CASCADE,
  amount_minor bigint CHECK (amount_minor > 0),
  transaction_date date CHECK (transaction_date >= DATE '1900-01-01'),
  category text CHECK (
    category IN ('alimentacion','transporte','vivienda','ocio','salud','educacion','compras','ingresos','otros')
  ),
  note text CHECK (char_length(note) BETWEEN 1 AND 200),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0)
);

CREATE TABLE email_movement_corrections (
  movement_id uuid NOT NULL REFERENCES transactions ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  corrected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  previous_amount_minor bigint NOT NULL CHECK (previous_amount_minor > 0),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  previous_transaction_date date NOT NULL,
  transaction_date date NOT NULL,
  PRIMARY KEY (movement_id, revision),
  CHECK ((previous_amount_minor, previous_transaction_date) <> (amount_minor, transaction_date))
);

CREATE OR REPLACE VIEW confirmed_movements AS
SELECT t.id, m.account_id, coalesce(a.amount_minor, t.amount_minor) AS amount_minor,
       t.currency, coalesce(a.transaction_date, t.transaction_date) AS transaction_date,
       t.payment_method, t.description, coalesce(a.category, t.category) AS category,
       t.direction, 'email'::text AS source, n.id AS notice_id, n.provider,
       a.note, t.amount_minor AS original_amount_minor, t.transaction_date AS original_transaction_date,
       coalesce(a.revision, 0) AS correction_revision
FROM transactions t JOIN notices n ON n.id=t.notice_id JOIN mailboxes m ON m.id=n.mailbox_id
LEFT JOIN email_movement_adjustments a ON a.movement_id=t.id
WHERE n.status='registered'
UNION ALL
SELECT id, account_id, amount_minor, currency, transaction_date,
       payment_method, description, category, direction, 'manual', NULL::uuid, NULL::text,
       NULL::text, NULL::bigint, NULL::date, NULL::integer
FROM manual_movements;
