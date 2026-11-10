BEGIN;
-- C27 게시 뒤 수정 차례(DECISIONS "동료 봇 전환" 16). 017·025·026의 변경 표에 phase 하나와 새 표·칸·트리거를 더한다.
-- 수정 차례는 generation을 올리지 않는다. 브랜치·승인 대상은 그 generation의 것 그대로이고, 차례마다 (change, generation, round) 키로
-- 증거(artifact·시험·리뷰)와 게시 effect를 새로 만든다. 처음 게시의 표(change_artifacts·change_verifications·change_reviews·
-- change_approval_subjects·change_delivery_effects)와 그 조건은 바꾸지 않는다. 기존 행을 고치지 않고 시드 행도 넣지 않는다.

-- phase CHECK에 amending을 더한다. 이름은 017의 열 CHECK가 받은 이름 그대로다.
ALTER TABLE change_requests DROP CONSTRAINT IF EXISTS change_requests_phase_check;
ALTER TABLE change_requests ADD CONSTRAINT change_requests_phase_check CHECK (phase IN ('requested','admitted','authoring','snapshot_ready','verifying','reviewing',
  'awaiting_publish_approval','approved','publishing','proposed','amending','merged','observing_deploy','superseded','blocked','cancelled','failed'));

-- 코드 표 CHANGE_PHASE_TRANSITIONS와 같은 값이다. 026에 proposed ↔ amending과 amending의 출구(merged·blocked·cancelled)를 더했다.
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
    ('proposed','merged'),('proposed','amending'),('proposed','superseded'),('proposed','blocked'),('proposed','cancelled'),
    ('amending','proposed'),('amending','merged'),('amending','blocked'),('amending','cancelled'),
    ('merged','observing_deploy'),('merged','blocked'),('merged','failed'),
    ('observing_deploy','blocked'),('observing_deploy','failed')
  )
$$;

-- 수정 요청 하나가 차례 하나다. 확정된 요청은 queued로 들어가고 한 번에 하나만 running이다. 상한은 코드 CHANGE_AMENDMENT.maxRounds와 같고
-- 대기열·실패한 차례도 센다. 지시 원문은 change_request_inputs의 같은 event_id 행이다(공개 경로가 읽지 않는 표, 7일 정리 대상).
-- materials는 확인 때 센 PR 리뷰·리뷰 댓글·대화 댓글 ID 묶음이다. 실행은 이 묶음의 글만 자료로 쓰고 그 뒤 글은 다음 차례 몫이다.
-- base_commit·base_tree는 차례를 시작할 때 다시 읽은 PR head와 그 tree이고 작성의 base다. 결과·묶음 칸은 한 번 정해지면 바뀌지 않는다.
CREATE TABLE IF NOT EXISTS change_amendments (
  change_id text NOT NULL,
  generation integer NOT NULL,
  round integer NOT NULL CHECK (round BETWEEN 1 AND 10),
  state text NOT NULL CHECK (state IN ('queued','running','committed','failed')),
  event_id text NOT NULL UNIQUE REFERENCES change_request_inputs(event_id),
  label text NOT NULL CHECK (label IN ('public','approved_public_summary')),
  pull_number integer NOT NULL CHECK (pull_number > 0),
  confirmed_head text NOT NULL CHECK (confirmed_head ~ '^[0-9a-f]{40}$'),
  materials jsonb NOT NULL CHECK (jsonb_typeof(materials) = 'array'),
  materials_digest text NOT NULL CHECK (materials_digest ~ '^[0-9a-f]{64}$'),
  base_commit text CHECK (base_commit ~ '^[0-9a-f]{40}$'),
  base_tree text CHECK (base_tree ~ '^[0-9a-f]{40}$'),
  result_tree text CHECK (result_tree ~ '^[0-9a-f]{40}$'),
  artifact_digest text CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
  verifier_revision text,
  commit_sha text CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
  reason text CHECK (reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at bigint NOT NULL,
  started_at bigint,
  finished_at bigint,
  PRIMARY KEY (change_id, generation, round),
  FOREIGN KEY (change_id, generation) REFERENCES change_generations(change_id, generation),
  CONSTRAINT change_amendments_started CHECK ((state = 'queued') = (started_at IS NULL) OR state = 'failed'),
  CONSTRAINT change_amendments_finished CHECK ((state IN ('committed','failed')) = (finished_at IS NOT NULL)),
  CONSTRAINT change_amendments_committed CHECK ((state = 'committed') = (commit_sha IS NOT NULL)),
  CONSTRAINT change_amendments_failed CHECK ((state = 'failed') = (reason IS NOT NULL)),
  CONSTRAINT change_amendments_base_pair CHECK ((base_commit IS NULL) = (base_tree IS NULL)),
  CONSTRAINT change_amendments_result_pair CHECK ((result_tree IS NULL) = (artifact_digest IS NULL))
);
-- 차례는 한 change에 하나씩만 돈다(병렬 실행 없음).
CREATE UNIQUE INDEX IF NOT EXISTS change_amendments_one_running ON change_amendments(change_id) WHERE state = 'running';

-- 요청 칸은 바뀌지 않는다. 상태는 queued → running → committed|failed, queued → failed로만 가고 끝난 차례는 다시 열리지 않는다.
-- 작성 base·결과·묶음 칸은 비어 있을 때 한 번만 채우고, 커밋 SHA는 committed로 갈 때만 적는다.
CREATE OR REPLACE FUNCTION change_amendments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'change_amendment_immutable' USING ERRCODE = 'CH001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'queued' OR NEW.base_commit IS NOT NULL OR NEW.result_tree IS NOT NULL OR NEW.verifier_revision IS NOT NULL OR NEW.commit_sha IS NOT NULL THEN
      RAISE EXCEPTION 'change_amendment_must_start_queued' USING ERRCODE = 'CH001';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.change_id, NEW.generation, NEW.round, NEW.event_id, NEW.label, NEW.pull_number, NEW.confirmed_head, NEW.materials, NEW.materials_digest, NEW.created_at)
      IS DISTINCT FROM (OLD.change_id, OLD.generation, OLD.round, OLD.event_id, OLD.label, OLD.pull_number, OLD.confirmed_head, OLD.materials, OLD.materials_digest, OLD.created_at)
    OR (OLD.base_commit IS NOT NULL AND (NEW.base_commit, NEW.base_tree) IS DISTINCT FROM (OLD.base_commit, OLD.base_tree))
    OR (OLD.result_tree IS NOT NULL AND (NEW.result_tree, NEW.artifact_digest) IS DISTINCT FROM (OLD.result_tree, OLD.artifact_digest))
    OR (OLD.verifier_revision IS NOT NULL AND NEW.verifier_revision IS DISTINCT FROM OLD.verifier_revision)
    OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at) THEN
    RAISE EXCEPTION 'change_amendment_immutable' USING ERRCODE = 'CH001';
  END IF;
  IF OLD.state IN ('committed','failed') AND (to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION 'change_amendment_immutable' USING ERRCODE = 'CH001';
  END IF;
  IF NEW.state <> OLD.state AND NOT ((OLD.state, NEW.state) IN (VALUES ('queued','running'),('queued','failed'),('running','committed'),('running','failed'))) THEN
    RAISE EXCEPTION 'change_amendment_transition_not_allowed' USING ERRCODE = 'CH001';
  END IF;
  IF NEW.state = 'running' AND OLD.state = 'queued' THEN
    -- 차례는 부모가 proposed에서 amending으로 가는 트랜잭션에서만 시작한다. 그 UPDATE보다 이 행이 먼저 바뀐다.
    IF NOT EXISTS (SELECT 1 FROM change_requests r WHERE r.id = NEW.change_id AND r.generation = NEW.generation AND r.phase = 'proposed') THEN
      RAISE EXCEPTION 'change_not_proposed' USING ERRCODE = 'CH001';
    END IF;
  END IF;
  IF NEW.state = 'committed' THEN
    -- 커밋은 이 차례의 ref effect가 그 SHA로 확정됐을 때만 적는다.
    IF NOT EXISTS (SELECT 1 FROM change_amendment_effects e WHERE e.change_id = NEW.change_id AND e.generation = NEW.generation AND e.round = NEW.round
      AND e.stage = 'ref' AND e.state = 'confirmed' AND e.result->>'sha' = NEW.commit_sha) THEN
      RAISE EXCEPTION 'amendment_ref_required' USING ERRCODE = 'CH001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- 차례 artifact. 처음 게시의 change_artifacts와 같은 모양에 차례 번호가 붙는다. base는 차례의 base_commit·base_tree다.
CREATE TABLE IF NOT EXISTS change_amendment_artifacts (
  change_id text NOT NULL,
  generation integer NOT NULL,
  round integer NOT NULL,
  artifact_digest text NOT NULL CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
  result_tree text NOT NULL CHECK (result_tree ~ '^[0-9a-f]{40}$'),
  manifest jsonb NOT NULL,
  patch text NOT NULL,
  label text NOT NULL CHECK (label IN ('public','approved_public_summary')),
  changed_bytes integer NOT NULL CHECK (changed_bytes BETWEEN 0 AND 1048576),
  transport_bytes integer NOT NULL CHECK (transport_bytes BETWEEN 0 AND 2097152),
  -- 작성 모델이 낸 확인할 것·남은 위험(C29 모양). 공개 검사 전 글이라 안내 댓글·Discord 결과 요약으로 낼 때 다시 검사한다.
  checks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(checks) = 'array'),
  risks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(risks) = 'array'),
  created_at bigint NOT NULL,
  purged_at bigint,
  PRIMARY KEY (change_id, generation, round),
  FOREIGN KEY (change_id, generation, round) REFERENCES change_amendments(change_id, generation, round)
);
CREATE TABLE IF NOT EXISTS change_amendment_artifact_files (
  change_id text NOT NULL,
  generation integer NOT NULL,
  round integer NOT NULL,
  path text NOT NULL,
  content bytea NOT NULL,
  PRIMARY KEY (change_id, generation, round, path),
  FOREIGN KEY (change_id, generation, round) REFERENCES change_amendment_artifacts(change_id, generation, round),
  CONSTRAINT change_amendment_artifact_files_size CHECK (octet_length(content) <= 1048576)
);
-- 018의 change_artifacts_guard와 같다. 허용하는 UPDATE는 보존 정리(patch·확인할 것·남은 위험 비우기) 하나다.
CREATE OR REPLACE FUNCTION change_amendment_artifacts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.purged_at IS NULL AND NEW.purged_at IS NOT NULL AND NEW.patch = '' AND NEW.checks = '[]'::jsonb AND NEW.risks = '[]'::jsonb
    AND (to_jsonb(NEW) - 'patch' - 'purged_at' - 'checks' - 'risks') = (to_jsonb(OLD) - 'patch' - 'purged_at' - 'checks' - 'risks') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'change_evidence_immutable' USING ERRCODE = 'CH001';
END $$;

-- 차례 시험 receipt. command마다 하나라 통과만 골라 쓰지 못한다. 차례가 끝나면 다음 차례가 새로 만든다.
CREATE TABLE IF NOT EXISTS change_amendment_verifications (
  change_id text NOT NULL,
  generation integer NOT NULL,
  round integer NOT NULL,
  command_id text NOT NULL CHECK (command_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  status text NOT NULL CHECK (status IN ('passed','failed','timed_out','not_run','source_changed','unknown')),
  bundle_digest text NOT NULL CHECK (bundle_digest ~ '^[0-9a-f]{64}$'),
  receipt jsonb NOT NULL,
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^[0-9a-f]{64}$'),
  created_at bigint NOT NULL,
  PRIMARY KEY (change_id, generation, round, command_id),
  FOREIGN KEY (change_id, generation, round) REFERENCES change_amendment_artifacts(change_id, generation, round)
);
-- 차례 리뷰 receipt. 그 차례에 묶인 리뷰 job만 남길 수 있다(작성 세션이 자기 결과를 리뷰한 것으로 기록되지 못한다).
CREATE TABLE IF NOT EXISTS change_amendment_reviews (
  change_id text NOT NULL,
  generation integer NOT NULL,
  round integer NOT NULL,
  job_id text NOT NULL,
  coverage text NOT NULL CHECK (coverage IN ('complete','incomplete')),
  verdict text NOT NULL CHECK (verdict IN ('pass','pass_with_warnings','blocked')),
  bundle_digest text NOT NULL CHECK (bundle_digest ~ '^[0-9a-f]{64}$'),
  receipt jsonb NOT NULL,
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^[0-9a-f]{64}$'),
  created_at bigint NOT NULL,
  PRIMARY KEY (change_id, generation, round),
  FOREIGN KEY (change_id, generation, round) REFERENCES change_amendment_artifacts(change_id, generation, round),
  FOREIGN KEY (change_id, generation, job_id) REFERENCES change_child_jobs(change_id, generation, job_id),
  CONSTRAINT change_amendment_reviews_pass CHECK (verdict = 'blocked' OR coverage = 'complete')
);

-- 자식 job이 어느 수정 차례에 속하는지. 0은 처음 게시(와 그 고치기 차례)다. 넣을 때 트리거가 부모의 지금 차례로 채운다.
ALTER TABLE change_child_jobs ADD COLUMN IF NOT EXISTS amendment_round integer NOT NULL DEFAULT 0 CHECK (amendment_round BETWEEN 0 AND 10);
CREATE OR REPLACE FUNCTION change_child_jobs_amendment_round() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.amendment_round := COALESCE((SELECT a.round FROM change_amendments a JOIN change_requests r ON r.id = a.change_id AND r.generation = a.generation
    WHERE a.change_id = NEW.change_id AND a.generation = NEW.generation AND a.state = 'running' AND r.phase = 'amending'), 0);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS change_child_jobs_amendment_round ON change_child_jobs;
CREATE TRIGGER change_child_jobs_amendment_round BEFORE INSERT ON change_child_jobs FOR EACH ROW EXECUTE FUNCTION change_child_jobs_amendment_round();

-- 차례 게시 effect. blob → tree → commit → ref(fast-forward)이고 PR 생성은 없다. 상태 표와 대조 규칙은 017의 change_delivery_effects와 같다.
-- 승인 digest 칸이 없다. 보내는 조건은 살아 있는 승인이 아니라 "부모가 amending이고 이 차례가 running이며 그 차례의 시험·리뷰가 통과"다.
CREATE TABLE IF NOT EXISTS change_amendment_effects (
  change_id text NOT NULL,
  generation integer NOT NULL,
  round integer NOT NULL,
  stage text NOT NULL CHECK (stage IN ('blob','tree','commit','ref')),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  expected jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','confirmed','unknown','blocked')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  available_at bigint NOT NULL,
  lease_id text,
  lease_until bigint,
  result jsonb,
  failure_code text CHECK (failure_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  reconcile_deadline bigint,
  blocked_reason text CHECK (blocked_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  resolution text CHECK (resolution IN ('not_sent','not_published','published_recorded')),
  resolved_by text,
  resolved_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (change_id, generation, round, stage),
  FOREIGN KEY (change_id, generation, round) REFERENCES change_amendments(change_id, generation, round),
  CONSTRAINT change_amendment_effects_lease CHECK ((state = 'sending') = (lease_id IS NOT NULL) AND (lease_id IS NULL) = (lease_until IS NULL)),
  CONSTRAINT change_amendment_effects_confirmed CHECK ((state = 'confirmed') = (result IS NOT NULL)),
  CONSTRAINT change_amendment_effects_unknown CHECK (state <> 'unknown' OR reconcile_deadline IS NOT NULL),
  CONSTRAINT change_amendment_effects_blocked CHECK ((state = 'blocked') = (blocked_reason IS NOT NULL)),
  CONSTRAINT change_amendment_effects_resolved CHECK ((resolution IS NOT NULL) = (resolved_at IS NOT NULL) AND (resolution IS NOT NULL) = (resolved_by IS NOT NULL)
    AND (resolution IS NULL OR state = 'blocked'))
);
-- 미확정 effect는 change당 하나다. 해소되지 않은 blocked도 센다.
CREATE UNIQUE INDEX IF NOT EXISTS change_amendment_effects_one_unresolved ON change_amendment_effects(change_id) WHERE state <> 'confirmed' AND resolution IS NULL;
CREATE INDEX IF NOT EXISTS change_amendment_effects_due ON change_amendment_effects(state, reconcile_deadline) WHERE state IN ('sending','unknown');

-- 네트워크로 나가는 전이(시작·pending→sending)의 조건. 부모를 FOR SHARE로 읽어 취소·병합 기록과 직렬화한다.
-- 처음 게시의 change_effect_may_send(게시 단계 + 살아 있는 승인)는 그대로 두고 수정 차례만 이 조건을 쓴다.
CREATE OR REPLACE FUNCTION change_amendment_may_send(row_change text, row_generation integer, row_round integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  parent record;
  amendment record;
BEGIN
  SELECT phase, generation, brief INTO parent FROM change_requests WHERE id = row_change FOR SHARE;
  IF NOT FOUND OR parent.phase <> 'amending' OR parent.generation <> row_generation THEN
    RAISE EXCEPTION 'change_not_amending' USING ERRCODE = 'CH001';
  END IF;
  SELECT state, artifact_digest INTO amendment FROM change_amendments WHERE change_id = row_change AND generation = row_generation AND round = row_round;
  IF NOT FOUND OR amendment.state <> 'running' OR amendment.artifact_digest IS NULL THEN
    RAISE EXCEPTION 'amendment_not_running' USING ERRCODE = 'CH001';
  END IF;
  -- 그 차례의 필수 시험이 모두 통과했고 완전한 통과 리뷰가 있어야 한다. 미실행·실패·막힘이면 커밋하지 않는다.
  IF parent.brief IS NULL OR jsonb_array_length(parent.brief->'verificationCommandIds') = 0 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(parent.brief->'verificationCommandIds') AS required(command_id)
    WHERE NOT EXISTS (SELECT 1 FROM change_amendment_verifications v WHERE v.change_id = row_change AND v.generation = row_generation AND v.round = row_round
      AND v.command_id = required.command_id AND v.status = 'passed')) THEN
    RAISE EXCEPTION 'verification_required' USING ERRCODE = 'CH001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM change_amendment_reviews v WHERE v.change_id = row_change AND v.generation = row_generation AND v.round = row_round
    AND v.verdict IN ('pass','pass_with_warnings') AND v.coverage = 'complete') THEN
    RAISE EXCEPTION 'review_required' USING ERRCODE = 'CH001';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION change_amendment_effects_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_stage text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'confirmed' AND OLD.resolution IS NULL THEN
      RAISE EXCEPTION 'effect_unresolved_delete' USING ERRCODE = 'CH001';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' THEN
      RAISE EXCEPTION 'effect_must_start_pending' USING ERRCODE = 'CH001';
    END IF;
    PERFORM change_amendment_may_send(NEW.change_id, NEW.generation, NEW.round);
    previous_stage := change_effect_stage_previous(NEW.stage);
    IF previous_stage IS NOT NULL AND NOT EXISTS (SELECT 1 FROM change_amendment_effects e
      WHERE e.change_id = NEW.change_id AND e.generation = NEW.generation AND e.round = NEW.round AND e.stage = previous_stage AND e.state = 'confirmed') THEN
      RAISE EXCEPTION 'predecessor_unconfirmed' USING ERRCODE = 'CH001';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.change_id, NEW.generation, NEW.round, NEW.stage, NEW.request_digest, NEW.expected, NEW.created_at)
    IS DISTINCT FROM (OLD.change_id, OLD.generation, OLD.round, OLD.stage, OLD.request_digest, OLD.expected, OLD.created_at) THEN
    RAISE EXCEPTION 'effect_intent_immutable' USING ERRCODE = 'CH001';
  END IF;
  IF OLD.resolution IS NOT NULL AND (NEW.resolution, NEW.resolved_by, NEW.resolved_at) IS DISTINCT FROM (OLD.resolution, OLD.resolved_by, OLD.resolved_at) THEN
    RAISE EXCEPTION 'effect_resolution_immutable' USING ERRCODE = 'CH001';
  END IF;
  IF NEW.state <> OLD.state THEN
    IF NOT change_effect_transition_allowed(OLD.state, NEW.state) THEN
      RAISE EXCEPTION 'effect_transition_not_allowed' USING ERRCODE = 'CH001';
    END IF;
    IF OLD.state = 'pending' AND NEW.state = 'sending' THEN
      PERFORM change_amendment_may_send(NEW.change_id, NEW.generation, NEW.round);
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- 부모 쪽 조건. amending에 들어가려면 그 generation에 running 차례가 있어야 하고, proposed·merged·cancelled로 나가려면 미해소 차례 effect가 없어야 한다
-- (해소하지 못하면 blocked만 된다). proposed로 돌아갈 때는 running 차례가 끝나 있어야 한다. 새 generation도 미해소 차례 effect가 있으면 열지 못한다.
CREATE OR REPLACE FUNCTION change_requests_amendment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.generation <> OLD.generation AND EXISTS (SELECT 1 FROM change_amendment_effects e WHERE e.change_id = NEW.id AND e.state <> 'confirmed' AND e.resolution IS NULL) THEN
    RAISE EXCEPTION 'unresolved_effects' USING ERRCODE = 'CH001';
  END IF;
  IF NEW.phase = 'amending' AND OLD.phase <> 'amending' AND NOT EXISTS (SELECT 1 FROM change_amendments a
    WHERE a.change_id = NEW.id AND a.generation = NEW.generation AND a.state = 'running') THEN
    RAISE EXCEPTION 'amendment_required' USING ERRCODE = 'CH001';
  END IF;
  IF OLD.phase = 'amending' AND NEW.phase <> 'amending' THEN
    IF NEW.phase IN ('proposed','merged','cancelled') AND EXISTS (SELECT 1 FROM change_amendment_effects e
      WHERE e.change_id = NEW.id AND e.state <> 'confirmed' AND e.resolution IS NULL) THEN
      RAISE EXCEPTION 'unresolved_effects' USING ERRCODE = 'CH001';
    END IF;
    IF NEW.phase = 'proposed' AND EXISTS (SELECT 1 FROM change_amendments a WHERE a.change_id = NEW.id AND a.generation = NEW.generation AND a.state = 'running') THEN
      RAISE EXCEPTION 'amendment_running' USING ERRCODE = 'CH001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS change_amendments_guard ON change_amendments;
CREATE TRIGGER change_amendments_guard BEFORE INSERT OR UPDATE OR DELETE ON change_amendments FOR EACH ROW EXECUTE FUNCTION change_amendments_guard();
DROP TRIGGER IF EXISTS change_amendment_artifacts_guard ON change_amendment_artifacts;
CREATE TRIGGER change_amendment_artifacts_guard BEFORE UPDATE OR DELETE ON change_amendment_artifacts FOR EACH ROW EXECUTE FUNCTION change_amendment_artifacts_guard();
DROP TRIGGER IF EXISTS change_amendment_artifact_files_immutable ON change_amendment_artifact_files;
CREATE TRIGGER change_amendment_artifact_files_immutable BEFORE UPDATE ON change_amendment_artifact_files FOR EACH ROW EXECUTE FUNCTION change_evidence_immutable();
DROP TRIGGER IF EXISTS change_amendment_verifications_immutable ON change_amendment_verifications;
CREATE TRIGGER change_amendment_verifications_immutable BEFORE UPDATE OR DELETE ON change_amendment_verifications FOR EACH ROW EXECUTE FUNCTION change_evidence_immutable();
DROP TRIGGER IF EXISTS change_amendment_reviews_immutable ON change_amendment_reviews;
CREATE TRIGGER change_amendment_reviews_immutable BEFORE UPDATE OR DELETE ON change_amendment_reviews FOR EACH ROW EXECUTE FUNCTION change_evidence_immutable();
DROP TRIGGER IF EXISTS change_amendment_effects_guard ON change_amendment_effects;
CREATE TRIGGER change_amendment_effects_guard BEFORE INSERT OR UPDATE OR DELETE ON change_amendment_effects FOR EACH ROW EXECUTE FUNCTION change_amendment_effects_guard();
DROP TRIGGER IF EXISTS change_requests_amendment ON change_requests;
CREATE TRIGGER change_requests_amendment BEFORE UPDATE ON change_requests FOR EACH ROW EXECUTE FUNCTION change_requests_amendment_guard();
INSERT INTO schema_migrations VALUES (27) ON CONFLICT DO NOTHING;
COMMIT;
