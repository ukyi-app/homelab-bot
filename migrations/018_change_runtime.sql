BEGIN;
-- T19 CHANGE_PR 조립에 필요한 저장. 017을 고치지 않고 더한다. CHANGE_PR_ENABLED가 꺼져 있으면 행이 생기지 않는다.

-- 리뷰 자유문 원문이다. receipt의 findings_digest가 가리킨다. 공개 렌더러·writer가 읽지 않는다.
CREATE TABLE IF NOT EXISTS change_review_findings (
  change_id text NOT NULL,
  generation integer NOT NULL,
  job_id text NOT NULL,
  session_id text NOT NULL,
  instruction_revision text NOT NULL,
  findings_digest text NOT NULL CHECK (findings_digest ~ '^[0-9a-f]{64}$'),
  problems jsonb NOT NULL,
  output jsonb,
  created_at bigint NOT NULL,
  PRIMARY KEY (change_id, generation, findings_digest),
  FOREIGN KEY (change_id, generation) REFERENCES change_generations(change_id, generation)
);

-- 배포 관측 창의 시작과 늦음 보고. recordDeployment가 observed_at을 덮어써 재시작 뒤 창을 그 값으로 잴 수 없다.
CREATE TABLE IF NOT EXISTS change_deployment_windows (
  change_id text NOT NULL,
  generation integer NOT NULL,
  started_at bigint NOT NULL,
  late_reported_at bigint,
  PRIMARY KEY (change_id, generation),
  FOREIGN KEY (change_id, generation) REFERENCES change_generations(change_id, generation)
);

-- 보존 기간이 지난 표시용 patch를 비운 시각. digest·manifest는 그대로 남아 증거를 대조할 수 있다.
ALTER TABLE change_artifacts ADD COLUMN IF NOT EXISTS purged_at bigint;
CREATE OR REPLACE FUNCTION change_artifacts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- 허용하는 변경은 하나다. 아직 비우지 않은 행의 patch를 빈 값으로 만들고 시각을 적는 것.
  IF OLD.purged_at IS NULL AND NEW.purged_at IS NOT NULL AND NEW.patch = ''
    AND NEW.change_id = OLD.change_id AND NEW.generation = OLD.generation AND NEW.artifact_digest = OLD.artifact_digest
    AND NEW.result_tree = OLD.result_tree AND NEW.manifest = OLD.manifest AND NEW.label = OLD.label
    AND NEW.changed_bytes = OLD.changed_bytes AND NEW.transport_bytes = OLD.transport_bytes AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'change_evidence_immutable' USING ERRCODE = 'CH001';
END $$;
DROP TRIGGER IF EXISTS change_artifacts_immutable ON change_artifacts;
CREATE TRIGGER change_artifacts_immutable BEFORE UPDATE ON change_artifacts FOR EACH ROW EXECUTE FUNCTION change_artifacts_guard();
INSERT INTO schema_migrations VALUES (18) ON CONFLICT DO NOTHING;
COMMIT;
