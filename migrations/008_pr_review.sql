BEGIN;
-- PR 리뷰 작업은 jobs(type='review', conversation_id NULL)에 둔다. 대화 작업과 모델 슬롯 1개를 같은 표로 나눈다.
CREATE TABLE IF NOT EXISTS github_deliveries (
  delivery_id text PRIMARY KEY, event text NOT NULL, action text, repo_id bigint, pr_number integer,
  outcome text NOT NULL, reason text, generation_key text, received_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS pr_reviews (
  job_id text PRIMARY KEY REFERENCES jobs(id), generation_key text NOT NULL UNIQUE,
  installation_id bigint NOT NULL, repo_id bigint NOT NULL, repo_full_name text NOT NULL, pr_number integer NOT NULL,
  head_sha text NOT NULL, comparison_revision text NOT NULL, base_ref text NOT NULL, policy_revision text NOT NULL,
  trigger text NOT NULL, pr_updated_at bigint NOT NULL, created_at bigint NOT NULL,
  review_outcome text CHECK (review_outcome IN ('completed','partial','failed','superseded')),
  result jsonb, positions jsonb, superseded_reason text, superseded_at bigint, defer_count integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pr_reviews_pr ON pr_reviews(repo_id, pr_number, created_at);
CREATE TABLE IF NOT EXISTS review_deliveries (
  id text PRIMARY KEY, job_id text NOT NULL REFERENCES jobs(id), idempotency_key text NOT NULL UNIQUE,
  repo_id bigint NOT NULL, repo_full_name text NOT NULL, pr_number integer NOT NULL,
  head_sha text NOT NULL, comparison_revision text NOT NULL, policy_revision text NOT NULL,
  body text NOT NULL, comments jsonb NOT NULL, inline boolean NOT NULL DEFAULT true,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','unknown','blocked','superseded')),
  reason text, external_id text, attempt integer NOT NULL DEFAULT 0, dispatch_started boolean NOT NULL DEFAULT false,
  pause_count integer NOT NULL DEFAULT 0, available_at bigint NOT NULL, created_at bigint NOT NULL, lease_token text, lease_until bigint
);
CREATE INDEX IF NOT EXISTS review_deliveries_queue ON review_deliveries(state, available_at);
-- 008은 배포 전에 열이 늘었다. 앞선 008로 이미 만든 표에도 같은 열이 생기게 멱등하게 더한다.
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS positions jsonb;
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS defer_count integer NOT NULL DEFAULT 0;
ALTER TABLE review_deliveries ADD COLUMN IF NOT EXISTS inline boolean NOT NULL DEFAULT true;
ALTER TABLE review_deliveries ADD COLUMN IF NOT EXISTS pause_count integer NOT NULL DEFAULT 0;
INSERT INTO schema_migrations VALUES (8) ON CONFLICT DO NOTHING;
COMMIT;
