CREATE TABLE gmail_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id uuid NOT NULL REFERENCES mailboxes ON DELETE CASCADE,
  generation uuid NOT NULL,
  message_id text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  due_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0,
  attempt_id uuid,
  received_at timestamptz,
  completed_at timestamptz,
  UNIQUE (mailbox_id, generation, message_id)
);

CREATE INDEX gmail_delivery_due ON gmail_deliveries (due_at) WHERE completed_at IS NULL;
CREATE INDEX gmail_delivery_complete ON gmail_deliveries (completed_at) WHERE completed_at IS NOT NULL;
