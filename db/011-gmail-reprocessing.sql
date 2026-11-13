ALTER TABLE mailboxes ADD COLUMN openai_consented_at timestamptz;

CREATE TABLE gmail_reprocess_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id uuid NOT NULL REFERENCES mailboxes ON DELETE CASCADE,
  from_at timestamptz NOT NULL,
  to_at timestamptz NOT NULL CHECK (to_at > from_at),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  page_token text,
  scan_due_at timestamptz NOT NULL DEFAULT now(),
  scan_lease uuid,
  scan_attempts integer NOT NULL DEFAULT 0,
  scan_finished_at timestamptz,
  failure text CHECK (failure IN ('gmail_list_failed', 'mailbox_unavailable')),
  summary jsonb,
  finished_at timestamptz
);

CREATE UNIQUE INDEX gmail_reprocess_active ON gmail_reprocess_runs (mailbox_id) WHERE finished_at IS NULL;
CREATE INDEX gmail_reprocess_latest ON gmail_reprocess_runs (mailbox_id, started_at DESC);

ALTER TABLE gmail_deliveries
  ADD COLUMN reprocess_id uuid REFERENCES gmail_reprocess_runs ON DELETE SET NULL;
CREATE INDEX gmail_deliveries_reprocess ON gmail_deliveries (reprocess_id) WHERE reprocess_id IS NOT NULL;

CREATE TABLE gmail_reprocess_results (
  run_id uuid NOT NULL REFERENCES gmail_reprocess_runs ON DELETE CASCADE,
  message_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('registered','pending','ignored','error','skipped')),
  PRIMARY KEY (run_id, message_id)
);

ALTER TABLE notices DROP CONSTRAINT notices_reported_payment_method_check;
ALTER TABLE notices ADD CHECK (
  reported_payment_method IN ('Nequi','Bancolombia','Tarjeta','PSE','Transferencia','QR','Botón Bancolombia')
);
ALTER TABLE notices
  ADD COLUMN reported_amount_minor bigint CHECK (reported_amount_minor > 0),
  ADD COLUMN reported_currency char(3) CHECK (reported_currency IN ('COP','USD','EUR')),
  ADD COLUMN reported_direction text CHECK (reported_direction IN ('income','expense'));
