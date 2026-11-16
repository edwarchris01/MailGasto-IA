ALTER TABLE gmail_deliveries
  ADD COLUMN outcome text CHECK (outcome IN ('registered','pending','ignored','error','skipped')),
  ADD COLUMN last_error text,
  ADD COLUMN last_error_at timestamptz,
  ADD COLUMN recovery_count integer NOT NULL DEFAULT 0 CHECK (recovery_count >= 0),
  ADD COLUMN classifier_version text;

ALTER TABLE gmail_reprocess_runs
  ADD COLUMN automatic boolean NOT NULL DEFAULT false,
  ADD COLUMN classifier_version text;

ALTER TABLE mailboxes
  ADD COLUMN reconciliation_due_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN reconciliation_version text;

CREATE INDEX gmail_reconciliation_due ON mailboxes (reconciliation_due_at)
  WHERE source='oauth' AND state='active';

-- Preserve known prior results. Unknown completed deliveries are reviewed once;
-- they may represent an old ignored message or a transport failure without a notice.
UPDATE gmail_deliveries d SET outcome=CASE WHEN n.status='discarded' THEN 'skipped' ELSE n.status END
FROM notices n WHERE n.mailbox_id=d.mailbox_id AND n.message_id=d.message_id
  AND d.completed_at IS NOT NULL AND n.status IN ('registered','pending','error','discarded');
