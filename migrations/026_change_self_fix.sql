BEGIN;
-- C31 게시 전 자체 리뷰 고치기(DECISIONS "동료 봇 전환" 17). 017·018·025의 변경 표에만 칸·표·트리거를 더한다.
-- 같은 generation 안의 고치기 차례다. 살아 있는 증거 자리(change_artifacts·change_verifications·change_reviews·change_notes와 묶음 칸)는
-- 늘 마지막 차례의 것이고, 앞 차례의 증거는 digest만 change_fix_rounds로 옮긴다. 그래서 승인·게시·리뷰 입력은 앞 차례의 증거를 볼 수 없다.

-- 지금 차례 번호. 0은 처음 작성이다. 상한은 코드 CHANGE_SELF_FIX.maxRounds와 같고 시험이 대조한다.
ALTER TABLE change_generations ADD COLUMN IF NOT EXISTS fix_round integer NOT NULL DEFAULT 0 CHECK (fix_round BETWEEN 0 AND 2);
-- 자식 job이 어느 차례에 속하는지. 넣을 때 트리거가 그 generation의 지금 차례로 채워 호출자가 다른 차례로 적지 못한다.
ALTER TABLE change_child_jobs ADD COLUMN IF NOT EXISTS fix_round integer NOT NULL DEFAULT 0 CHECK (fix_round BETWEEN 0 AND 2);

-- 고치기 차례를 연 근거. fix_round=n 행은 n번째 고치기를 연 앞 차례의 막힌 리뷰와 그 증거다. 리뷰 자유문은 없고 receipt(코드·우선순위)와 digest만 있다.
CREATE TABLE IF NOT EXISTS change_fix_rounds (
  change_id text NOT NULL,
  generation integer NOT NULL,
  fix_round integer NOT NULL CHECK (fix_round BETWEEN 1 AND 2),
  review_job_id text NOT NULL REFERENCES jobs(id),
  review_receipt jsonb NOT NULL,
  review_receipt_digest text NOT NULL CHECK (review_receipt_digest ~ '^[0-9a-f]{64}$'),
  artifact_digest text NOT NULL CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
  result_tree text NOT NULL CHECK (result_tree ~ '^[0-9a-f]{40}$'),
  verifier_revision text NOT NULL,
  -- [{commandId, status, receiptDigest}]
  verifications jsonb NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (change_id, generation, fix_round),
  FOREIGN KEY (change_id, generation) REFERENCES change_generations(change_id, generation)
);
DROP TRIGGER IF EXISTS change_fix_rounds_immutable ON change_fix_rounds;
CREATE TRIGGER change_fix_rounds_immutable BEFORE UPDATE OR DELETE ON change_fix_rounds FOR EACH ROW EXECUTE FUNCTION change_evidence_immutable();

-- 코드 표 CHANGE_PHASE_TRANSITIONS와 같은 값이다. 017에 ('reviewing','authoring') 하나를 더했다.
CREATE OR REPLACE FUNCTION change_phase_transition_allowed(from_phase text, to_phase text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT (from_phase, to_phase) IN (VALUES
    ('requested','admitted'),('requested','blocked'),('requested','cancelled'),('requested','failed'),
    ('admitted','authoring'),('admitted','blocked'),('admitted','cancelled'),('admitted','failed'),
    ('authoring','snapshot_ready'),('authoring','superseded'),('authoring','blocked'),('authoring','cancelled'),('authoring','failed'),
    ('snapshot_ready','verifying'),('snapshot_ready','superseded'),('snapshot_ready','blocked'),('snapshot_ready','cancelled'),('snapshot_ready','failed'),
    ('verifying','reviewing'),('verifying','superseded'),('verifying','blocked'),('verifying','cancelled'),('verifying','failed'),
    ('reviewing','awaiting_publish_approval'),('reviewing','authoring'),('reviewing','superseded'),('reviewing','blocked'),('reviewing','cancelled'),('reviewing','failed'),
    ('awaiting_publish_approval','approved'),('awaiting_publish_approval','superseded'),('awaiting_publish_approval','blocked'),('awaiting_publish_approval','cancelled'),('awaiting_publish_approval','failed'),
    ('approved','publishing'),('approved','superseded'),('approved','blocked'),('approved','cancelled'),('approved','failed'),
    ('publishing','proposed'),('publishing','superseded'),('publishing','blocked'),('publishing','cancelled'),('publishing','failed'),
    ('proposed','merged'),('proposed','superseded'),('proposed','blocked'),('proposed','cancelled'),
    ('merged','observing_deploy'),('merged','blocked'),('merged','failed'),
    ('observing_deploy','blocked'),('observing_deploy','failed')
  )
$$;

-- reviewing → authoring은 고치기 차례를 연 트랜잭션에서만 지난다: 지금 차례의 기록 행이 있고, 살아 있는 결과·리뷰가 비어 있어야 한다.
-- 차례마다 묶음 칸을 비우려면 차례 번호가 올라야 하므로 이 전이 횟수도 fix_round CHECK에 묶인다.
CREATE OR REPLACE FUNCTION change_requests_self_fix_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.phase = 'reviewing' AND NEW.phase = 'authoring' AND NOT EXISTS (
    SELECT 1 FROM change_generations g JOIN change_fix_rounds f ON f.change_id = g.change_id AND f.generation = g.generation AND f.fix_round = g.fix_round
    WHERE g.change_id = NEW.id AND g.generation = NEW.generation AND g.result_tree IS NULL
      AND NOT EXISTS (SELECT 1 FROM change_reviews r WHERE r.change_id = NEW.id AND r.generation = NEW.generation)) THEN
    RAISE EXCEPTION 'self_fix_required' USING ERRCODE = 'CH001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS change_requests_self_fix ON change_requests;
CREATE TRIGGER change_requests_self_fix BEFORE UPDATE ON change_requests FOR EACH ROW EXECUTE FUNCTION change_requests_self_fix_guard();

-- 017의 규칙(묶음 필드 불변, 빈 칸 채우기만 허용)에 고치기 차례 한 걸음을 더했다.
CREATE OR REPLACE FUNCTION change_generations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.change_id, NEW.generation, NEW.repo_id, NEW.base_branch, NEW.branch, NEW.base_commit, NEW.base_tree, NEW.policy_revision, NEW.created_at)
      IS DISTINCT FROM (OLD.change_id, OLD.generation, OLD.repo_id, OLD.base_branch, OLD.branch, OLD.base_commit, OLD.base_tree, OLD.policy_revision, OLD.created_at) THEN
    RAISE EXCEPTION 'change_generation_immutable' USING ERRCODE = 'CH001';
  END IF;
  -- 고치기 차례: 번호가 1 오르고 결과 칸 셋을 함께 비운다. 그 차례의 기록 행이 먼저 있고 살아 있는 artifact가 없어야 한다.
  IF NEW.fix_round IS DISTINCT FROM OLD.fix_round THEN
    IF NEW.fix_round <> OLD.fix_round + 1 OR NEW.result_tree IS NOT NULL OR NEW.artifact_digest IS NOT NULL OR NEW.verifier_revision IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM change_fix_rounds f WHERE f.change_id = NEW.change_id AND f.generation = NEW.generation AND f.fix_round = NEW.fix_round)
      OR EXISTS (SELECT 1 FROM change_artifacts a WHERE a.change_id = NEW.change_id AND a.generation = NEW.generation) THEN
      RAISE EXCEPTION 'change_generation_immutable' USING ERRCODE = 'CH001';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.result_tree IS NOT NULL AND NEW.result_tree IS DISTINCT FROM OLD.result_tree)
    OR (OLD.artifact_digest IS NOT NULL AND NEW.artifact_digest IS DISTINCT FROM OLD.artifact_digest)
    OR (OLD.verifier_revision IS NOT NULL AND NEW.verifier_revision IS DISTINCT FROM OLD.verifier_revision) THEN
    RAISE EXCEPTION 'change_generation_immutable' USING ERRCODE = 'CH001';
  END IF;
  RETURN NEW;
END $$;

-- 살아 있는 증거는 고치기 차례를 여는 트랜잭션만 지운다. 그 트랜잭션은 다음 차례의 기록 행을 먼저 넣는다.
-- artifact 바이트(change_artifact_files)는 보존 정리도 지우므로 여기서 막지 않는다. 바이트만으로는 승인·리뷰가 되지 않는다.
CREATE OR REPLACE FUNCTION change_live_evidence_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM change_fix_rounds f JOIN change_generations g ON g.change_id = f.change_id AND g.generation = f.generation
    WHERE f.change_id = OLD.change_id AND f.generation = OLD.generation AND f.fix_round = g.fix_round + 1) THEN
    RAISE EXCEPTION 'change_evidence_immutable' USING ERRCODE = 'CH001';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS change_artifacts_delete_guard ON change_artifacts;
CREATE TRIGGER change_artifacts_delete_guard BEFORE DELETE ON change_artifacts FOR EACH ROW EXECUTE FUNCTION change_live_evidence_delete_guard();
DROP TRIGGER IF EXISTS change_verifications_delete_guard ON change_verifications;
CREATE TRIGGER change_verifications_delete_guard BEFORE DELETE ON change_verifications FOR EACH ROW EXECUTE FUNCTION change_live_evidence_delete_guard();
DROP TRIGGER IF EXISTS change_reviews_delete_guard ON change_reviews;
CREATE TRIGGER change_reviews_delete_guard BEFORE DELETE ON change_reviews FOR EACH ROW EXECUTE FUNCTION change_live_evidence_delete_guard();
-- 025의 확인할 것·남은 위험 목록도 차례의 작성 결과다. 고치기 차례를 열 때 함께 지워 다음 차례 결과의 목록이 새로 기록된다(원문 정리는 UPDATE라 무관하다).
DROP TRIGGER IF EXISTS change_notes_delete_guard ON change_notes;
CREATE TRIGGER change_notes_delete_guard BEFORE DELETE ON change_notes FOR EACH ROW EXECUTE FUNCTION change_live_evidence_delete_guard();

CREATE OR REPLACE FUNCTION change_child_jobs_round() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.fix_round := COALESCE((SELECT g.fix_round FROM change_generations g WHERE g.change_id = NEW.change_id AND g.generation = NEW.generation), 0);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS change_child_jobs_round ON change_child_jobs;
CREATE TRIGGER change_child_jobs_round BEFORE INSERT ON change_child_jobs FOR EACH ROW EXECUTE FUNCTION change_child_jobs_round();
INSERT INTO schema_migrations VALUES (26) ON CONFLICT DO NOTHING;
COMMIT;
