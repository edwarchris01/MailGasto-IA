ALTER TABLE notices ADD COLUMN unconfirmed_fields text[];

CREATE TABLE mobile_gmail_oauth (
  state_hash text PRIMARY KEY,
  session_hash text NOT NULL REFERENCES sessions ON DELETE CASCADE,
  verifier text NOT NULL,
  expected_mailbox uuid,
  expires_at timestamptz NOT NULL,
  receipt_hash text UNIQUE,
  encrypted_code text
);

CREATE INDEX mobile_gmail_oauth_expiry ON mobile_gmail_oauth (expires_at);
