ALTER TABLE notices ADD COLUMN avalpay_partial boolean NOT NULL DEFAULT false;

CREATE TABLE gmail_operation_references (
  notice_id uuid NOT NULL REFERENCES notices ON DELETE CASCADE,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (notice_id, fingerprint)
);

CREATE INDEX gmail_operation_references_fingerprint ON gmail_operation_references (fingerprint);
