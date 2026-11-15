ALTER TABLE gmail_deliveries
  ADD COLUMN authenticated boolean,
  ADD COLUMN forwarded boolean,
  ADD COLUMN webhook_accepted_at timestamptz,
  ADD COLUMN retry_requested_at timestamptz;

-- An attempt started before this migration has no trusted authentication state.
UPDATE gmail_deliveries SET attempt_id=NULL, received_at=NULL, attempts=0, due_at=LEAST(due_at, now())
WHERE completed_at IS NULL AND attempt_id IS NOT NULL;
