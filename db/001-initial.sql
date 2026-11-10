CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE TABLE account_tokens (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify','delete')),
  expires_at timestamptz NOT NULL
);
CREATE TABLE oauth_states (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
  session_hash text NOT NULL REFERENCES sessions ON DELETE CASCADE,
  verifier text NOT NULL,
  expected_mailbox uuid,
  expires_at timestamptz NOT NULL
);
CREATE TABLE mailboxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
  email text NOT NULL UNIQUE,
  source text NOT NULL CHECK (source IN ('n8n','oauth')),
  state text NOT NULL CHECK (state IN ('active','reconnect','disconnected')),
  secret text,
  history_id text,
  linked_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz,
  sync_due_at timestamptz NOT NULL DEFAULT now(),
  sync_lease uuid
);
CREATE TABLE notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id uuid NOT NULL REFERENCES mailboxes ON DELETE CASCADE,
  message_id text NOT NULL,
  received_at timestamptz NOT NULL,
  provider text NOT NULL CHECK (provider IN ('nequi','bancolombia')),
  forwarded boolean NOT NULL,
  payload text,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','registered','pending','error')),
  reason text,
  confidence real CHECK (confidence BETWEEN 0 AND 1),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  due_at timestamptz NOT NULL DEFAULT now(),
  lease uuid,
  attempts int NOT NULL DEFAULT 0,
  UNIQUE (mailbox_id, message_id)
);
CREATE TABLE transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_id uuid NOT NULL UNIQUE REFERENCES notices ON DELETE CASCADE,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  transaction_date date NOT NULL,
  payment_method text NOT NULL,
  description text NOT NULL,
  category text NOT NULL CHECK (category IN ('alimentacion','transporte','vivienda','ocio','salud','educacion','ingresos','otros')),
  direction text NOT NULL CHECK (direction IN ('expense','income'))
);
CREATE TABLE chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE chat_turns (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES chat_sessions ON DELETE CASCADE,
  question text NOT NULL,
  answer text NOT NULL,
  filters jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
  dedupe_key text NOT NULL UNIQUE,
  subject text NOT NULL,
  body text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','error')),
  attempts int NOT NULL DEFAULT 0,
  due_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE TABLE rate_limits (
  bucket text PRIMARY KEY,
  hits int NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX mailbox_owner ON mailboxes(account_id);
CREATE INDEX mailbox_sync ON mailboxes(sync_due_at) WHERE state = 'active' AND source = 'oauth';
CREATE INDEX notice_history ON notices(mailbox_id, received_at DESC, id DESC);
CREATE INDEX notice_jobs ON notices(due_at) WHERE status = 'processing';
CREATE INDEX transaction_summary ON transactions(transaction_date, category);
CREATE INDEX chat_turn_history ON chat_turns(session_id, id DESC);
CREATE INDEX outbox_jobs ON outbox(due_at) WHERE status IN ('queued','sending');
