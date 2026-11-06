BEGIN;
-- T19 CHANGE_PR의 저장 표다. 기존 표를 고치지 않고 시드 행도 넣지 않는다.
-- 부모 change는 jobs 행이 아니다. 승인·배포를 몇 시간씩 기다리는 부모가 jobs 행이면 실행 slot을 막는다. 모델 실행만 자식 job이 맡는다.
-- 토큰·키는 어떤 표에도 받지 않는다. 트리거 오류는 ERRCODE CH001과 사유 코드로 내고 저장 계층이 값으로 바꾼다.

-- 코드 표 CHANGE_PHASE_TRANSITIONS와 같은 값이다. 시험이 모든 쌍을 대조한다.
CREATE OR REPLACE FUNCTION change_phase_transition_allowed(from_phase text, to_phase text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT (from_phase, to_phase) IN (VALUES
    ('requested','admitted'),('requested','blocked'),('requested','cancelled'),('requested','failed'),
    ('admitted','authoring'),('admitted','blocked'),('admitted','cancelled'),('admitted','failed'),
    ('authoring','snapshot_ready'),('authoring','superseded'),('authoring','blocked'),('authoring','cancelled'),('authoring','failed'),
    ('snapshot_ready','verifying'),('snapshot_ready','superseded'),('snapshot_ready','blocked'),('snapshot_ready','cancelled'),('snapshot_ready','failed'),
    ('verifying','reviewing'),('verifying','superseded'),('verifying','blocked'),('verifying','cancelled'),('verifying','failed'),
    ('reviewing','awaiting_publish_approval'),('reviewing','superseded'),('reviewing','blocked'),('reviewing','cancelled'),('reviewing','failed'),
    ('awaiting_publish_approval','approved'),('awaiting_publish_approval','superseded'),('awaiting_publish_approval','blocked'),('awaiting_publish_approval','cancelled'),('awaiting_publish_approval','failed'),
    ('approved','publishing'),('approved','superseded'),('approved','blocked'),('approved','cancelled'),('approved','failed'),
    ('publishing','proposed'),('publishing','superseded'),('publishing','blocked'),('publishing','cancelled'),('publishing','failed'),
    ('proposed','merged'),('proposed','superseded'),('proposed','blocked'),('proposed','cancelled'),
    ('merged','observing_deploy'),('merged','blocked'),('merged','failed'),
    ('observing_deploy','blocked'),('observing_deploy','failed')
  )
$$;
-- 코드 표 EFFECT_TRANSITIONS와 같은 값이다. unknown→pending이 없어 보냈는지 모르는 요청이 다시 나가지 못한다.
CREATE OR REPLACE FUNCTION change_effect_transition_allowed(from_state text, to_state text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT (from_state, to_state) IN (VALUES
    ('pending','sending'),('pending','blocked'),
    ('sending','pending'),('sending','confirmed'),('sending','unknown'),('sending','blocked'),
    ('unknown','confirmed'),('unknown','blocked')
  )
$$;
CREATE OR REPLACE FUNCTION change_label_rank(label text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE label WHEN 'public' THEN 0 WHEN 'approved_public_summary' THEN 1 WHEN 'unknown' THEN 2 WHEN 'private' THEN 3 END
$$;
CREATE OR REPLACE FUNCTION change_effect_stage_previous(stage text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE stage WHEN 'tree' THEN 'blob' WHEN 'commit' THEN 'tree' WHEN 'ref' THEN 'commit' WHEN 'pull' THEN 'ref' END
$$;

CREATE TABLE IF NOT EXISTS change_requests (
  -- 브랜치 이름으로 공개되는 무작위 값이라 Discord ID·제목을 담지 못하는 형식으로 묶는다.
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{32}$'),
  -- 같은 문구라도 다른 이벤트는 별도 요청이고, 같은 이벤트의 재전달은 새 change를 만들지 않는다.
  event_id text NOT NULL UNIQUE,
  owner_id text NOT NULL,
  conversation_id text NOT NULL REFERENCES conversations(id),
  scope jsonb NOT NULL,
  repo_id bigint NOT NULL CHECK (repo_id > 0),
  base_branch text NOT NULL,
  generation integer NOT NULL DEFAULT 1 CHECK (generation BETWEEN 1 AND 999),
  phase text NOT NULL DEFAULT 'requested' CHECK (phase IN ('requested','admitted','authoring','snapshot_ready','verifying','reviewing',
    'awaiting_publish_approval','approved','publishing','proposed','merged','observing_deploy','superseded','blocked','cancelled','failed')),
  phase_reason text CHECK (phase_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  label text NOT NULL CHECK (label IN ('public','approved_public_summary','unknown','private')),
  policy_revision text,
  brief jsonb,
  brief_digest text CHECK (brief_digest ~ '^[0-9a-f]{64}$'),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CONSTRAINT change_requests_brief_pair CHECK ((brief IS NULL) = (brief_digest IS NULL)),
  -- admission을 지난 단계는 brief와 정책 revision이 있어야 한다. 끝 상태에는 admission 전에 닫힌 행도 있다.
  CONSTRAINT change_requests_admission CHECK (phase IN ('requested','superseded','blocked','cancelled','failed')
    OR (brief IS NOT NULL AND policy_revision IS NOT NULL)),
  -- private·unknown 입력을 본 change는 진행 단계에 있을 수 없다(DATA-01). 모델의 신고로 이 값을 낮추는 길은 트리거가 막는다.
  CONSTRAINT change_requests_label_open CHECK (phase IN ('requested','superseded','blocked','cancelled','failed')
    OR label IN ('public','approved_public_summary'))
);
CREATE INDEX IF NOT EXISTS change_requests_open ON change_requests(phase, updated_at)
  WHERE phase NOT IN ('superseded','blocked','cancelled','failed');

-- 요청 원문과 추가 답변이다. 공개 경로가 읽지 않게 표를 나눈다. 코드에서 이 표를 읽는 수단은 ChangePrivateInputs 하나다.
CREATE TABLE IF NOT EXISTS change_request_inputs (
  event_id text PRIMARY KEY,
  change_id text NOT NULL REFERENCES change_requests(id),
  generation integer NOT NULL,
  label text NOT NULL CHECK (label IN ('public','approved_public_summary','unknown','private')),
  text text NOT NULL,
  text_sha256 text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS change_request_inputs_change ON change_request_inputs(change_id, created_at);

-- generation별로 고정되는 값이다. 뒤 단계의 증거 묶음이 이 행과 정책 revision을 가리킨다.
CREATE TABLE IF NOT EXISTS change_generations (
  change_id text NOT NULL REFERENCES change_requests(id),
  generation integer NOT NULL CHECK (generation BETWEEN 1 AND 999),
  repo_id bigint NOT NULL,
  base_branch text NOT NULL,
  branch text NOT NULL UNIQUE,
  base_commit text NOT NULL CHECK (base_commit ~ '^[0-9a-f]{40}$'),
  base_tree text NOT NULL CHECK (base_tree ~ '^[0-9a-f]{40}$'),
  policy_revision text NOT NULL,
  result_tree text CHECK (result_tree ~ '^[0-9a-f]{40}$'),
  artifact_digest text CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
  verifier_revision text,
  created_at bigint NOT NULL,
  PRIMARY KEY (change_id, generation),
  CONSTRAINT change_generations_result_pair CHECK ((result_tree IS NULL) = (artifact_digest IS NULL)),
  CONSTRAINT change_generations_branch_shape CHECK (branch = 'bot/change/' || change_id || '/g' || generation)
);

-- 게시 서버의 영속 사본이다. 작업자는 이 행이 커밋된 뒤에 결과를 지운다.
CREATE TABLE IF NOT EXISTS change_artifacts (
  change_id text NOT NULL,
  generation integer NOT NULL,
  artifact_digest text NOT NULL CHECK (artifact_digest ~ '^[0-9a-f]{64}$'),
  result_tree text NOT NULL CHECK (result_tree ~ '^[0-9a-f]{40}$'),
  manifest jsonb NOT NULL,
  -- 표시용이다. 리뷰가 읽으므로 manifest.patchSha256로 A에 묶인다.
  patch text NOT NULL,
  label text NOT NULL CHECK (label IN ('public','approved_public_summary')),
  changed_bytes integer NOT NULL CHECK (changed_bytes BETWEEN 0 AND 1048576),
  transport_bytes integer NOT NULL CHECK (transport_bytes BETWEEN 0 AND 2097152),
  created_at bigint NOT NULL,
  PRIMARY KEY (change_id, generation),
  FOREIGN KEY (change_id, generation) REFERENCES change_generations(change_id, generation)
);
-- 내용이 있는 변경만 바이트를 둔다. 삭제·mode 변경은 manifest만으로 게시할 수 있다.
CREATE TABLE IF NOT EXISTS change_artifact_files (
  change_id text NOT NULL,
  generation integer NOT NULL,
  path text NOT NULL,
  content bytea NOT NULL,
  PRIMARY KEY (change_id, generation, path),
  FOREIGN KEY (change_id, generation) REFERENCES change_artifacts(change_id, generation),
  CONSTRAINT change_artifact_files_size CHECK (octet_length(content) <= 1048576)
);

-- 모델 실행은 이 표로 부모에 묶인다. job 하나는 부모 하나에만 속한다.
CREATE TABLE IF NOT EXISTS change_child_jobs (
  job_id text PRIMARY KEY REFERENCES jobs(id),
  change_id text NOT NULL,
  generation integer NOT NULL,
  role text NOT NULL CHECK (role IN ('author','review')),
  created_at bigint NOT NULL,
  UNIQUE (change_id, generation, job_id),
  FOREIGN KEY (change_id, generation) REFERENCES change_generations(change_id, generation)
);

-- command마다 receipt 하나다. 재시험으로 통과만 골라 쓰지 못하게 한다. 응답 유실 뒤 같은 receipt를 다시 기록하는 것은 멱등이다.
CREATE TABLE IF NOT EXISTS change_verifications (
  change_id text NOT NULL,
  generation integer NOT NULL,
  command_id text NOT NULL CHECK (command_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  status text NOT NULL CHECK (status IN ('passed','failed','timed_out','not_run','source_changed','unknown')),
  exit_code integer,
  timed_out boolean NOT NULL,
  log_digest text CHECK (log_digest ~ '^[0-9a-f]{64}$'),
  runner_revision text NOT NULL,
  image_revision text NOT NULL,
  bundle_digest text NOT NULL CHECK (bundle_digest ~ '^[0-9a-f]{64}$'),
  receipt jsonb NOT NULL,
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^[0-9a-f]{64}$'),
  invalidated_at bigint,
  invalidated_reason text,
  created_at bigint NOT NULL,
  PRIMARY KEY (change_id, generation, command_id),
  FOREIGN KEY (change_id, generation) REFERENCES change_artifacts(change_id, generation),
  CONSTRAINT change_verifications_passed CHECK (status <> 'passed' OR (exit_code = 0 AND NOT timed_out AND log_digest IS NOT NULL)),
  CONSTRAINT change_verifications_timeout CHECK ((status = 'timed_out') = timed_out),
  CONSTRAINT change_verifications_invalidated CHECK ((invalidated_at IS NULL) = (invalidated_reason IS NULL))
);

-- generation마다 리뷰 하나다. 수정이 필요하면 새 generation에서 처음부터 다시 받는다.
CREATE TABLE IF NOT EXISTS change_reviews (
  change_id text NOT NULL,
  generation integer NOT NULL,
  job_id text NOT NULL,
  session_id text NOT NULL,
  instruction_revision text NOT NULL,
  coverage text NOT NULL CHECK (coverage IN ('complete','incomplete')),
  verdict text NOT NULL CHECK (verdict IN ('pass','pass_with_warnings','blocked')),
  bundle_digest text NOT NULL CHECK (bundle_digest ~ '^[0-9a-f]{64}$'),
  receipt jsonb NOT NULL,
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^[0-9a-f]{64}$'),
  invalidated_at bigint,
  invalidated_reason text,
  created_at bigint NOT NULL,
  PRIMARY KEY (change_id, generation),
  FOREIGN KEY (change_id, generation) REFERENCES change_artifacts(change_id, generation),
  -- 작성 세션이 자기 결과를 리뷰한 것으로 기록되지 못하게 자식 job 연결을 거친다.
  FOREIGN KEY (change_id, generation, job_id) REFERENCES change_child_jobs(change_id, generation, job_id),
  CONSTRAINT change_reviews_pass CHECK (verdict = 'blocked' OR coverage = 'complete'),
  CONSTRAINT change_reviews_invalidated CHECK ((invalidated_at IS NULL) = (invalidated_reason IS NULL))
);

-- 승인이 가리키는 정확한 대상과 공개 텍스트다. generation마다 하나이고 바뀌지 않는다. 내용이 바뀌면 새 generation이다.
CREATE TABLE IF NOT EXISTS change_approval_subjects (
  change_id text NOT NULL,
  generation integer NOT NULL,
  approval_digest text NOT NULL CHECK (approval_digest ~ '^[0-9a-f]{64}$'),
  subject jsonb NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (change_id, generation),
  UNIQUE (change_id, generation, approval_digest),
  FOREIGN KEY (change_id, generation) REFERENCES change_artifacts(change_id, generation)
);
CREATE TABLE IF NOT EXISTS change_approvals (
  id bigserial PRIMARY KEY,
  change_id text NOT NULL,
  generation integer NOT NULL,
  approval_digest text NOT NULL,
  event_id text NOT NULL UNIQUE,
  approved_by text NOT NULL,
  approved_at bigint NOT NULL,
  invalidated_at bigint,
  invalidated_reason text,
  FOREIGN KEY (change_id, generation, approval_digest) REFERENCES change_approval_subjects(change_id, generation, approval_digest),
  CONSTRAINT change_approvals_invalidated CHECK ((invalidated_at IS NULL) = (invalidated_reason IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS change_approvals_one_live ON change_approvals(change_id, generation) WHERE invalidated_at IS NULL;

-- blob stage는 행 하나다. 내용이 같으면 SHA가 같아 다시 보내도 중복이 없고, 파일별 결과는 expected·result가 담는다.
CREATE TABLE IF NOT EXISTS change_delivery_effects (
  change_id text NOT NULL,
  generation integer NOT NULL,
  stage text NOT NULL CHECK (stage IN ('blob','tree','commit','ref','pull')),
  approval_digest text NOT NULL,
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
  PRIMARY KEY (change_id, generation, stage),
  FOREIGN KEY (change_id, generation) REFERENCES change_generations(change_id, generation),
  FOREIGN KEY (change_id, generation, approval_digest) REFERENCES change_approval_subjects(change_id, generation, approval_digest),
  CONSTRAINT change_effects_lease CHECK ((state = 'sending') = (lease_id IS NOT NULL) AND (lease_id IS NULL) = (lease_until IS NULL)),
  CONSTRAINT change_effects_confirmed CHECK ((state = 'confirmed') = (result IS NOT NULL)),
  CONSTRAINT change_effects_unknown CHECK (state <> 'unknown' OR reconcile_deadline IS NOT NULL),
  CONSTRAINT change_effects_blocked CHECK ((state = 'blocked') = (blocked_reason IS NOT NULL)),
  CONSTRAINT change_effects_resolved CHECK ((resolution IS NOT NULL) = (resolved_at IS NOT NULL) AND (resolution IS NOT NULL) = (resolved_by IS NOT NULL) AND (resolution IS NULL OR state = 'blocked'))
);
-- 미확정 effect는 generation당 하나다. 해소되지 않은 blocked도 세므로 다음 게시자가 그 뒤 stage를 시작하지 못한다.
CREATE UNIQUE INDEX IF NOT EXISTS change_delivery_effects_one_unresolved ON change_delivery_effects(change_id, generation)
  WHERE state <> 'confirmed' AND resolution IS NULL;
CREATE INDEX IF NOT EXISTS change_delivery_effects_due ON change_delivery_effects(state, reconcile_deadline) WHERE state IN ('sending','unknown');

-- 배포 관측은 generation마다 최신 한 행이다. H·M은 첫 기록 뒤 바뀌지 않는다.
CREATE TABLE IF NOT EXISTS change_deployments (
  change_id text NOT NULL,
  generation integer NOT NULL,
  pr_number integer NOT NULL CHECK (pr_number > 0),
  head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  merge_commit text NOT NULL CHECK (merge_commit ~ '^[0-9a-f]{40}$'),
  config_commit text CHECK (config_commit ~ '^[0-9a-f]{40}$'),
  image_digest text CHECK (image_digest ~ '^sha256:[0-9a-f]{64}$'),
  argo_observed_at bigint,
  workload_observed_at bigint,
  observed_at bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','unknown','observed','not_applicable','blocked')),
  reason text CHECK (reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  PRIMARY KEY (change_id, generation),
  FOREIGN KEY (change_id, generation) REFERENCES change_generations(change_id, generation),
  CONSTRAINT change_deployments_observed CHECK (state <> 'observed' OR (config_commit IS NOT NULL AND image_digest IS NOT NULL
    AND argo_observed_at IS NOT NULL AND workload_observed_at IS NOT NULL AND reason IS NULL)),
  CONSTRAINT change_deployments_reason CHECK (state NOT IN ('not_applicable','blocked') OR reason IS NOT NULL)
);

-- 코드 경로를 거치지 않은 쓰기도 전이 표·증거 조건을 지나게 한다.
CREATE OR REPLACE FUNCTION change_requests_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.phase <> 'requested' OR NEW.generation <> 1 THEN
      RAISE EXCEPTION 'change_must_start_requested' USING ERRCODE = 'CH001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.event_id <> OLD.event_id OR NEW.owner_id <> OLD.owner_id OR NEW.conversation_id <> OLD.conversation_id
    OR NEW.repo_id <> OLD.repo_id OR NEW.base_branch <> OLD.base_branch OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'change_identity_immutable' USING ERRCODE = 'CH001';
  END IF;
  IF change_label_rank(NEW.label) < change_label_rank(OLD.label) THEN
    RAISE EXCEPTION 'label_lowered' USING ERRCODE = 'CH001';
  END IF;
  IF NEW.generation <> OLD.generation THEN
    IF NOT (OLD.phase = 'superseded' AND NEW.phase = 'requested' AND NEW.generation = OLD.generation + 1) THEN
      RAISE EXCEPTION 'generation_restart_invalid' USING ERRCODE = 'CH001';
    END IF;
    -- 옛 generation의 unknown을 두고 새 게시를 열면 공개된 객체가 어디까지인지 사람이 알 수 없게 된다.
    IF EXISTS (SELECT 1 FROM change_delivery_effects e WHERE e.change_id = NEW.id AND e.state <> 'confirmed' AND e.resolution IS NULL) THEN
      RAISE EXCEPTION 'unresolved_effects' USING ERRCODE = 'CH001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.brief_digest IS NOT NULL AND (NEW.brief_digest IS DISTINCT FROM OLD.brief_digest OR NEW.policy_revision IS DISTINCT FROM OLD.policy_revision) THEN
    RAISE EXCEPTION 'change_admission_immutable' USING ERRCODE = 'CH001';
  END IF;
  IF NEW.phase = OLD.phase THEN RETURN NEW; END IF;
  IF NOT change_phase_transition_allowed(OLD.phase, NEW.phase) THEN
    RAISE EXCEPTION 'transition_not_allowed' USING ERRCODE = 'CH001';
  END IF;
  CASE NEW.phase
    WHEN 'authoring' THEN
      IF NOT EXISTS (SELECT 1 FROM change_generations g WHERE g.change_id = NEW.id AND g.generation = NEW.generation) THEN
        RAISE EXCEPTION 'generation_required' USING ERRCODE = 'CH001';
      END IF;
    WHEN 'snapshot_ready' THEN
      IF NOT EXISTS (SELECT 1 FROM change_artifacts a WHERE a.change_id = NEW.id AND a.generation = NEW.generation) THEN
        RAISE EXCEPTION 'artifact_required' USING ERRCODE = 'CH001';
      END IF;
    WHEN 'verifying' THEN
      IF NOT EXISTS (SELECT 1 FROM change_generations g WHERE g.change_id = NEW.id AND g.generation = NEW.generation AND g.verifier_revision IS NOT NULL) THEN
        RAISE EXCEPTION 'verifier_required' USING ERRCODE = 'CH001';
      END IF;
    WHEN 'reviewing' THEN
      -- 필수 command마다 살아 있는 통과 receipt가 있어야 한다. 미실행·실패는 게시 차단이고 Draft 예외가 없다.
      IF NEW.brief IS NULL OR jsonb_array_length(NEW.brief->'verificationCommandIds') = 0 OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(NEW.brief->'verificationCommandIds') AS required(command_id)
        WHERE NOT EXISTS (SELECT 1 FROM change_verifications v WHERE v.change_id = NEW.id AND v.generation = NEW.generation
          AND v.command_id = required.command_id AND v.status = 'passed' AND v.invalidated_at IS NULL)) THEN
        RAISE EXCEPTION 'verification_required' USING ERRCODE = 'CH001';
      END IF;
    WHEN 'awaiting_publish_approval' THEN
      IF NOT EXISTS (SELECT 1 FROM change_reviews r WHERE r.change_id = NEW.id AND r.generation = NEW.generation
        AND r.verdict IN ('pass','pass_with_warnings') AND r.coverage = 'complete' AND r.invalidated_at IS NULL) THEN
        RAISE EXCEPTION 'review_required' USING ERRCODE = 'CH001';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM change_approval_subjects s WHERE s.change_id = NEW.id AND s.generation = NEW.generation) THEN
        RAISE EXCEPTION 'approval_subject_required' USING ERRCODE = 'CH001';
      END IF;
    WHEN 'approved', 'publishing' THEN
      IF NOT EXISTS (SELECT 1 FROM change_approvals a WHERE a.change_id = NEW.id AND a.generation = NEW.generation AND a.invalidated_at IS NULL) THEN
        RAISE EXCEPTION 'approval_required' USING ERRCODE = 'CH001';
      END IF;
    WHEN 'proposed' THEN
      IF NOT EXISTS (SELECT 1 FROM change_delivery_effects e WHERE e.change_id = NEW.id AND e.generation = NEW.generation AND e.stage = 'pull' AND e.state = 'confirmed') THEN
        RAISE EXCEPTION 'pull_effect_required' USING ERRCODE = 'CH001';
      END IF;
    WHEN 'merged' THEN
      IF NOT EXISTS (SELECT 1 FROM change_deployments d WHERE d.change_id = NEW.id AND d.generation = NEW.generation) THEN
        RAISE EXCEPTION 'merge_record_required' USING ERRCODE = 'CH001';
      END IF;
    ELSE NULL;
  END CASE;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS change_requests_guard ON change_requests;
CREATE TRIGGER change_requests_guard BEFORE INSERT OR UPDATE ON change_requests FOR EACH ROW EXECUTE FUNCTION change_requests_guard();

-- 묶음의 필드는 한 번 정해지면 바뀌지 않는다. 비어 있던 칸을 채우는 것만 허용한다.
CREATE OR REPLACE FUNCTION change_generations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.change_id, NEW.generation, NEW.repo_id, NEW.base_branch, NEW.branch, NEW.base_commit, NEW.base_tree, NEW.policy_revision, NEW.created_at)
      IS DISTINCT FROM (OLD.change_id, OLD.generation, OLD.repo_id, OLD.base_branch, OLD.branch, OLD.base_commit, OLD.base_tree, OLD.policy_revision, OLD.created_at)
    OR (OLD.result_tree IS NOT NULL AND NEW.result_tree IS DISTINCT FROM OLD.result_tree)
    OR (OLD.artifact_digest IS NOT NULL AND NEW.artifact_digest IS DISTINCT FROM OLD.artifact_digest)
    OR (OLD.verifier_revision IS NOT NULL AND NEW.verifier_revision IS DISTINCT FROM OLD.verifier_revision) THEN
    RAISE EXCEPTION 'change_generation_immutable' USING ERRCODE = 'CH001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS change_generations_guard ON change_generations;
CREATE TRIGGER change_generations_guard BEFORE UPDATE ON change_generations FOR EACH ROW EXECUTE FUNCTION change_generations_guard();

-- artifact·승인 대상은 고정된 증거라 고치지 못한다.
CREATE OR REPLACE FUNCTION change_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'change_evidence_immutable' USING ERRCODE = 'CH001';
END $$;
DROP TRIGGER IF EXISTS change_artifacts_immutable ON change_artifacts;
CREATE TRIGGER change_artifacts_immutable BEFORE UPDATE ON change_artifacts FOR EACH ROW EXECUTE FUNCTION change_evidence_immutable();
DROP TRIGGER IF EXISTS change_artifact_files_immutable ON change_artifact_files;
CREATE TRIGGER change_artifact_files_immutable BEFORE UPDATE ON change_artifact_files FOR EACH ROW EXECUTE FUNCTION change_evidence_immutable();
DROP TRIGGER IF EXISTS change_approval_subjects_immutable ON change_approval_subjects;
CREATE TRIGGER change_approval_subjects_immutable BEFORE UPDATE ON change_approval_subjects FOR EACH ROW EXECUTE FUNCTION change_evidence_immutable();

-- receipt는 무효 표시만 더할 수 있다. 실패를 통과로 고치지 못한다.
CREATE OR REPLACE FUNCTION change_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'invalidated_at' - 'invalidated_reason') IS DISTINCT FROM (to_jsonb(OLD) - 'invalidated_at' - 'invalidated_reason')
    OR (OLD.invalidated_at IS NOT NULL AND (NEW.invalidated_at, NEW.invalidated_reason) IS DISTINCT FROM (OLD.invalidated_at, OLD.invalidated_reason)) THEN
    RAISE EXCEPTION 'change_receipt_immutable' USING ERRCODE = 'CH001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS change_verifications_guard ON change_verifications;
CREATE TRIGGER change_verifications_guard BEFORE UPDATE ON change_verifications FOR EACH ROW EXECUTE FUNCTION change_receipt_guard();
DROP TRIGGER IF EXISTS change_reviews_guard ON change_reviews;
CREATE TRIGGER change_reviews_guard BEFORE UPDATE ON change_reviews FOR EACH ROW EXECUTE FUNCTION change_receipt_guard();

CREATE OR REPLACE FUNCTION change_approvals_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'invalidated_at' - 'invalidated_reason') IS DISTINCT FROM (to_jsonb(OLD) - 'invalidated_at' - 'invalidated_reason')
    OR (OLD.invalidated_at IS NOT NULL AND (NEW.invalidated_at, NEW.invalidated_reason) IS DISTINCT FROM (OLD.invalidated_at, OLD.invalidated_reason)) THEN
    RAISE EXCEPTION 'change_approval_immutable' USING ERRCODE = 'CH001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS change_approvals_guard ON change_approvals;
CREATE TRIGGER change_approvals_guard BEFORE UPDATE ON change_approvals FOR EACH ROW EXECUTE FUNCTION change_approvals_guard();

-- 네트워크로 나가는 전이(시작·pending→sending)는 지금 게시 단계이고 살아 있는 승인이 있어야 한다.
-- 부모를 FOR SHARE로 읽어 취소·무효화와 직렬화한다. 그래서 취소 커밋 뒤에 시작되는 전송이 없다.
CREATE OR REPLACE FUNCTION change_effect_may_send(row_change text, row_generation integer, row_digest text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  parent record;
BEGIN
  SELECT phase, generation INTO parent FROM change_requests WHERE id = row_change FOR SHARE;
  IF NOT FOUND OR parent.phase <> 'publishing' OR parent.generation <> row_generation THEN
    RAISE EXCEPTION 'change_not_publishing' USING ERRCODE = 'CH001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM change_approvals a WHERE a.change_id = row_change AND a.generation = row_generation
    AND a.approval_digest = row_digest AND a.invalidated_at IS NULL) THEN
    RAISE EXCEPTION 'approval_required' USING ERRCODE = 'CH001';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION change_effects_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous_stage text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- unknown을 지워서 새 게시를 여는 길을 막는다.
    IF OLD.state <> 'confirmed' AND OLD.resolution IS NULL THEN
      RAISE EXCEPTION 'effect_unresolved_delete' USING ERRCODE = 'CH001';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' THEN
      RAISE EXCEPTION 'effect_must_start_pending' USING ERRCODE = 'CH001';
    END IF;
    PERFORM change_effect_may_send(NEW.change_id, NEW.generation, NEW.approval_digest);
    previous_stage := change_effect_stage_previous(NEW.stage);
    IF previous_stage IS NOT NULL AND NOT EXISTS (SELECT 1 FROM change_delivery_effects e
      WHERE e.change_id = NEW.change_id AND e.generation = NEW.generation AND e.stage = previous_stage AND e.state = 'confirmed') THEN
      RAISE EXCEPTION 'predecessor_unconfirmed' USING ERRCODE = 'CH001';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.change_id, NEW.generation, NEW.stage, NEW.approval_digest, NEW.request_digest, NEW.expected, NEW.created_at)
    IS DISTINCT FROM (OLD.change_id, OLD.generation, OLD.stage, OLD.approval_digest, OLD.request_digest, OLD.expected, OLD.created_at) THEN
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
      PERFORM change_effect_may_send(NEW.change_id, NEW.generation, NEW.approval_digest);
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS change_effects_guard ON change_delivery_effects;
CREATE TRIGGER change_effects_guard BEFORE INSERT OR UPDATE OR DELETE ON change_delivery_effects FOR EACH ROW EXECUTE FUNCTION change_effects_guard();
INSERT INTO schema_migrations VALUES (17) ON CONFLICT DO NOTHING;
COMMIT;
