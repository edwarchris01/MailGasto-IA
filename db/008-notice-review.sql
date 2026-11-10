ALTER TABLE notices
  DROP CONSTRAINT notices_status_check,
  ADD CONSTRAINT notices_status_check CHECK (status IN ('processing','registered','pending','error','discarded'));
