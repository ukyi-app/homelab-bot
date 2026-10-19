BEGIN;
CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY);
CREATE TABLE IF NOT EXISTS conversations (
  id text PRIMARY KEY, owner_id text NOT NULL, scope jsonb NOT NULL,
  channel_id text NOT NULL, active boolean NOT NULL DEFAULT true,
  gap boolean NOT NULL DEFAULT false, checkpoint text,
  created_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id text PRIMARY KEY, event_order bigserial UNIQUE, provider text NOT NULL, delivery_id text NOT NULL,
  semantic_key text NOT NULL UNIQUE, actor_id text NOT NULL, scope jsonb NOT NULL,
  conversation_id text REFERENCES conversations(id), received_at bigint NOT NULL,
  payload jsonb NOT NULL, accepted boolean NOT NULL DEFAULT false,
  UNIQUE(provider, delivery_id)
);
CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY, event_id text NOT NULL UNIQUE REFERENCES events(id),
  conversation_id text REFERENCES conversations(id), type text NOT NULL,
  owner_id text NOT NULL, target jsonb NOT NULL, revision jsonb NOT NULL,
  budget jsonb NOT NULL, state text NOT NULL DEFAULT 'queued' CHECK (state IN
    ('queued','running','waiting_user','verifying','succeeded','failed',
     'cancel_requested','cancelled','unknown','superseded')),
  wait_reason text, attempt integer NOT NULL DEFAULT 0,
  priority integer NOT NULL, available_at bigint NOT NULL, created_at bigint NOT NULL,
  lease_token text, lease_until bigint, started_at bigint, finished_at bigint
);
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(state, priority, available_at);
CREATE TABLE IF NOT EXISTS results (
  job_id text PRIMARY KEY REFERENCES jobs(id), result jsonb NOT NULL,
  evidence jsonb NOT NULL, classification text NOT NULL, created_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  id text PRIMARY KEY, job_id text REFERENCES jobs(id), conversation_id text REFERENCES conversations(id),
  owner_id text NOT NULL, scope jsonb NOT NULL, policy_revision text NOT NULL,
  idempotency_key text NOT NULL UNIQUE, payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','unknown','blocked')),
  external_id text, attempt integer NOT NULL DEFAULT 0, available_at bigint NOT NULL,
  created_at bigint NOT NULL, lease_until bigint, lease_token text
);
CREATE TABLE IF NOT EXISTS schedules (
  id text PRIMARY KEY, owner_id text NOT NULL, scope jsonb NOT NULL,
  timezone text NOT NULL, next_run bigint NOT NULL, payload jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS denied_actors (actor_id text PRIMARY KEY, created_at bigint NOT NULL);
CREATE TABLE IF NOT EXISTS controls (key text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS audit (
  id bigserial PRIMARY KEY, kind text NOT NULL, subject text NOT NULL,
  detail jsonb NOT NULL, created_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS incidents (
  group_key text PRIMARY KEY, conversation_id text REFERENCES conversations(id),
  status text NOT NULL, fingerprint text NOT NULL, count integer NOT NULL,
  updated_at bigint NOT NULL
);
INSERT INTO schema_migrations VALUES (1) ON CONFLICT DO NOTHING;
COMMIT;
