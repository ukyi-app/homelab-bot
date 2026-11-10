BEGIN;
-- Discord 리뷰 요청(COLLEAGUE_SPEC §4.10, AC-30). 리뷰 정책 목록 밖 조직 저장소의 세대에만 대상 기록(저장소 ID·이름·설치 ID·visibility)을 둔다.
-- 실행 직전·게시 직전 저장소 대조와 설치 토큰 범위가 이 기록으로 그 세대의 작업 하나만 통과시킨다. 정책 목록의 저장소면 NULL이다.
-- 기본값 없는 NULL 칸 하나라 옛 코드가 같은 DB를 써도 깨지지 않는다(옛 코드는 이 칸을 모르고, 그런 세대는 정책 대조에서 막힌다).
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS request_target jsonb;
INSERT INTO schema_migrations VALUES (23) ON CONFLICT DO NOTHING;
COMMIT;
