# V1_RELEASE_REPORT — T21-audit

> 이 문서가 가리키는 `evidence/…` 파일과 `OBSERVATION-REQUESTS.md`, 감사 인계는 비공개 운영 저장소 `ukyi-app/homelab-bot-ops`의 `evidence/release-audit/`와 `handoffs/release-audit.md`에 있다(D-13). T21 1회차 감사(2026-11-07, 봇 `dda891f`)의 결과이며, 수정 뒤 재감사가 이 문서를 갈음한다.

**판정: NOT_READY.** `04-audit-handoff.md` §9의 “권한 위반·보안 경계 위반·필수 기능 결함”에 해당하는 두 경계를 현재 코드에서 재현했다. `/task` 질문·완료 요약의 비밀 패턴 차단 누락(A01), 권한 철회 완료 뒤 Discord 발송(A02)이다. 제한 시범 운영 기록은 존재하지만, 이 결함 때문에 `READY_FOR_SCOPED_PILOT`로 판정하지 않는다. 운영·사용자 수용을 대신 선언하지 않는다. 감사 산출물은 반환하지만 **T21 티켓 완료 조건은 충족하지 못했다. V2를 시작하지 않았다.**

발견 **8건: blocker 0 / high 2 / medium 2 / low 4**. 이 중 6건은 `confirmed`, 2건(A07·A08)은 `needs_verification`이다. 수용 시험 30개는 **pass 21 / fail 2 / blocked 7 / not_run 0 / not_applicable 0**이며, [V1_TRACE.md](V1_TRACE.md)에 증거 등급·실행 리비전·놓치는 범위를 모두 적었다. `blocked`는 로컬 시험 실패와 구분한다.

## 범위·리비전·실행 결과

- `MODE=audit`, 실행 `t21`, 작업 `T21-audit`, 독립 감사 Codex. 2026-11-07. 구현 세션이나 이전 Codex 리뷰의 “지적 없음”을 독립 통과 증거로 사용하지 않았다.
- 봇 `dda891f7fbba8aabcc83b1b03fec36836012fd36`, homelab `691b532e66e7edd802b56d8518144197e8500c55`, ops `6caf4cb4d0a89048876b18da702275e2704bd6d7`. 봇·homelab detached 유지. 저장소 추적 파일 변경·외부 쓰기·운영 접근·추가 에이전트 없음.
- 필수 기준 `spec.md` §5·§8·§11, `platform/design.md`, `00`·`01`·`04`, V1 계획·상태·결정·검증·아키텍처·조사, ops HANDOFF·기록, approvals를 대조했다. 승인 기록은 과거 시험의 허용 범위를 확인하는 근거이며 현재 감사의 운영 실행 권한이 아니다.
- `npm ci`, `npm run check`, `npm run build` 성공. Node 24.22.0, npm 11.19.1. 전체 시험은 PostgreSQL 18.6 Unix socket을 사용해 concurrency 6으로 **2,085 / pass 2,063 / fail 0 / skip 22**, 약198초였다. 알려진 `change-pg`·`codex-bridge` 간헐 실패는 이번에 나타나지 않아 단독 재시도하지 않았다.
- Dockerfile로 감사 이미지 `localhost/homelab-bot:t21-audit` 빌드 성공. 이미지 ID `0d5c74a10440185c3d95c08599644560c47a16b8137ef44371c79e7b33713721`. SEC-02 `change-sec02` **10/10**, `sec02-boundary` **24/24**, 실패·skip 0. 전체 시험의 skip 22개를 별도 실행으로 모두 확인했다. 중복 시험을 더해 새로운 총시험 수로 소개하지 않는다.
- 전체 시험 → 이미지 빌드 → SEC-02를 직렬 실행했다. 시험용 `t21a-pg`는 종료·삭제하고 부재를 확인했다. 감사 이미지는 재현용으로 남겼다.
- 독립 재현 스크립트는 산출물 폴더에만 두었다. 실제 컴파일된 코드·PGlite·합성 worker/Discord를 사용했고, bwrap 재현은 감사 이미지 안에서만 수행했다. 실제 비밀 값은 사용·기록하지 않았다.

### 선언 이미지와 증거 리비전

| 대상 | 확인한 연결 | 한계 |
|---|---|---|
| 게시 서버 | homelab `apps/homelab-bot/image.yaml`: revision dda891f, digest `sha256:71c1871688c2a57d6ec5886779428d7796cefc4fbd3b659084b8a51e62fc2c23`. GitHub attestation GET payload의 source commit과 일치 | 실제 현재 파드 imageID는 관찰하지 않음. 이번 감사에서 attestation 암호 서명 재검증은 안 함 |
| 작업자 두 레인 | `platform/sandbox/values.yaml`: `sha256:b3331339d5b157dd1fa0b3b9941f9094918335d9cdc4ea9e8e91eed87cd9803d` → attestation source `d4c8bdaeff6de34abc3622a73ac16303be449649`. approvals의 교체·서명 검증 기록과 일치 | 선언/기록 연결을 확인했으며 현재 운영 프로세스 실측은 아님 |
| #87 동작 동일 주장 | `git diff 29c73b8 dda891f --stat`: DECISIONS·PROJECT_STATUS·VERIFICATION 세 문서만, 107줄 추가/2줄 삭제 | 소스·Dockerfile·의존성 변경 없음. 기록된 #86 동작 동일 주장은 타당 |
| 최신 소스와 구 작업자 | 컴파일된 `worker-main.js`에서 상대 import를 따라간 runtime 모듈 43개의 대응 TS, Dockerfile/package/lock/tsconfig는 d4c8bda→dda891f 사이 변경 없음 | type import까지 포함한 넓은 그래프에는 게시자 변경이 보이므로 따로 구분했다. 런타임 소스 동등성을 확인한 것이며 서로 다른 빌드의 바이트 동일성 증명은 아님 |

근거: `evidence/baseline.json`, `image-provenance.json`, `worker-revision-closure.json`, 각 실행 `.meta`·`.log`, `container-cleanup.json`. 과거 기록 원본은 해시와 선별 집계로 대조했고, 공개 GitHub 리뷰는 GET으로 head·COMMENTED·본문 해시를 확인했다(`historical-records.json`, `github-review-records.json`). ops 문서의 과거 경로에 있는 실제 결과 파일도 대조했으며 원문·개인 식별자는 이 보고서에 복사하지 않았다.

## 발견 (`04` §8)

### A01 — [중요도: high] v1 task 질문과 완료 요약이 비밀 패턴을 `safe_summary`로 내보낸다

- **대상 버전 / 요구사항 ID:** V1 dda891f / F04, F09, R09, DATA-01.
- **근거:** `src/task-bridge.ts:70`·`:83`·`:86`, `src/claude-task-bridge.ts:487`·`:505`, `src/executor-claude-task.ts:328`, `test/task-bridge.test.ts:103`. 독립 `evidence/audit-probes.json` A01-question/A01-summary.
- **재현 조건과 실제 관찰:** 허용된 task의 작업자 응답에 합성 GitHub 토큰 형식 문자열을 질문 또는 완료 요약으로 넣었다. 실제 bridge→Store→DiscordPublisher를 지나 모의 Discord 메시지에 원문이 포함됐다(각 1건). 운영 키·실모델은 사용하지 않았다. 실행기에는 **현재 모델 자격의 정확 일치 반사 검사**가 있지만 일반 비밀 패턴·다른 출처 비공개 표식 검사와는 범위가 다르다.
- **사용자 또는 운영 영향:** 작업 코드/답/모델 출력에 포함된 자격 형태·비공개 자료를 검사하지 않은 채 Discord 게시 가능. 허용된 owner 스레드도 원본 비밀을 자동으로 게시해도 되는 경계는 아니다. 실제 자격이 이미 유출됐다고 단정하지 않는다.
- **기존 테스트가 놓친 이유:** 해당 `task-bridge` 시험은 합성 토큰이 메시지에 포함되는 동작 자체를 통과 조건으로 둔다. CHANGE에 추가된 질문·답 검사로 v1 task 경로가 덮이지 않는다. 전체 시험 green은 이 경계를 보증하지 않는다.
- **확인 상태:** `confirmed`.
- **최소 수정안과 추가 시험:** 질문과 완료 요약의 공통 게시 경계에서 출처·수신 범위·민감 패턴을 검사하고, 차단 시 원문 없는 고정 안내/사유만 남긴다. 기존 정확 자격 반사 검사는 유지한다. 합성 토큰·내부 표식·인코딩 변형·정상 질문/요약을 같은 bridge→outbox→publisher 경로로 검사하고 DB/로그에도 원문이 남지 않는지 확인한다.

### A02 — [중요도: high] `/revoke` 완료 뒤에도 Discord 발송을 시작할 수 있다

- **대상 버전 / 요구사항 ID:** V1 dda891f / F01, F04, F09, R01, AUTH-02.
- **근거:** `src/discord.ts:477`·`:502`·`:577`, `src/store.ts:533`, `src/policy.ts:96`; `evidence/audit-probes.json` A02.
- **재현 조건과 실제 관찰:** 미발송 답을 claim하고 `authorized()`가 끝난 다음, 발송 전 `discordPauseUntil()` 대기 지점에서 실제 ingress `/revoke`를 완료했다. `denied_actors` 커밋을 확인한 뒤 dispatch를 재개했다. dispatch 시점에도 철회 행이 존재하지만 REST 발송 1건이 발생했다. 사후 confirm의 ACL 검사 때문에 outbox는 `unknown`이 됐다. 이미 전송 중이던 요청의 취소 불가능 사례가 아니라 **철회 완료가 발송 시작보다 앞선** 순서다.
- **사용자 또는 운영 영향:** 권한 철회 후 이전 답·예약 사본을 수신 대상에 보낼 수 있다. 사후 `unknown`·재대조는 이미 전달된 자료를 회수하지 못한다. “즉시 중단은 /revoke”라는 인계 설명은 Discord 경로에서 현재 보장되지 않는다.
- **기존 테스트가 놓친 이유:** 인가 전에 철회하는 사례와 발송 후 상태 대조는 있으나, 인가 후 여러 DB await 사이 철회를 끼운 시험이 없다. #86 GitHub writer의 전송 직전 재인가가 Discord에도 적용된 것은 아니다.
- **확인 상태:** `confirmed`.
- **최소 수정안과 추가 시험:** 철회와 발송 시작의 순서를 DB의 공통 잠금/최신 ACL 검사·dispatch CAS로 정의하고, 발송 경계 직전에 다시 집행한다. 이미 시작한 외부 요청의 제한은 문서화한다. message/thread·예약 사본·다른 대화에서 owner 철회·실제 PostgreSQL 두 연결의 경합에서 철회가 먼저 완료되면 REST 호출 0을 검증한다.

### A03 — [중요도: medium] task 답과 CHANGE 요청 원문의 보존·삭제 정책이 닫히지 않았다

- **대상 버전 / 요구사항 ID:** V1 dda891f / F04.
- **근거:** `src/task-bridge.ts:119`, `migrations/009_codex_bridge.sql:21`, `src/change-store.ts:753`·`:779`, `docs/ai-bot/ARCHITECTURE.md:1917`; `evidence/audit-probes.json` A03.
- **재현 조건과 실제 관찰:** 완료된 task의 합성 비공개 답과 종료된 CHANGE 원문을 저장했다. 8일 뒤 실제 `purgeExpiredChangeContent()`를 실행하면 CHANGE artifact 1건은 정리되지만 `change_request_inputs.text`와 `codex_questions.answer`는 그대로 남았다. 현재 코드에서 이 원문을 주기적으로 정리하는 경로를 찾지 못했다.
- **사용자 또는 운영 영향:** 비공개 원문이 DB 및 백업에 기간 미정으로 축적된다. 7일 규칙은 artifact/리뷰 원문에 대한 규칙이므로 이 필드에도 이미 같은 기간이 합의됐다고 주장하지 않는다. 문제는 별도 보존·삭제 계약과 집행의 부재다.
- **기존 테스트가 놓친 이유:** artifact 정리와 memory 삭제 원장은 시험하지만 task/change 입력 원문의 수명은 별도 검증 대상이 아니다.
- **확인 상태:** `confirmed`.
- **최소 수정안과 추가 시험:** 원문 종류별 보존 기간·삭제 요청·진행 중/unknown 예외·백업 복원 시 재적용을 먼저 정하고 집행한다. evidence digest/receipt는 남기되 원문은 정리한다. cutoff 전후·재개/unknown·중복 정리·복원에서 삭제된 원문이 다시 노출되지 않는 시험을 추가한다.

### A04 — [중요도: medium] bwrap 준비 실패를 시험 실행 실패로 기록한다

- **대상 버전 / 요구사항 ID:** V1 dda891f / F06, R13, CHANGE-01.
- **근거:** `src/change-verifier.ts:97`·`:189`·`:213`; `evidence/bwrap-probe.json`.
- **재현 조건과 실제 관찰:** 감사 이미지의 실제 bwrap에 존재하지 않는 합성 cwd를 주었다. payload는 실행되지 않았고 `Can't chdir` 준비 오류였지만 `spawnSandbox`는 `started:true`, `exitCode:1`을 반환했다. 코드의 judge는 자격/정리 등 다른 조건이 정상일 때 이를 `failed`로 분류한다. `child-pid`는 payload exec 성공 증거가 아니다.
- **사용자 또는 운영 영향:** 환경 문제를 변경 코드의 시험 실패로 보고해 진단·재시도 방향을 잘못 잡는다. 실패 쪽으로 닫히므로 시험 미실행을 통과로 만드는 우회는 확인하지 않았다.
- **기존 테스트가 놓친 이유:** `started:false` 준비 실패와 `started:true` payload 실패는 다루지만, child-pid가 나온 뒤 준비가 실패하는 경우를 분리하지 않는다.
- **확인 상태:** `confirmed`.
- **최소 수정안과 추가 시험:** payload 시작을 확인하는 별도 신호/상태를 두고 준비 실패를 `not_run(sandbox_unavailable)`로 분류한다. mount/chdir/namespace 준비 실패, 실제 assertion 실패, timeout/cancel을 구분하는 컨테이너 시험을 추가한다.

### A05 — [중요도: low] 승인 digest가 메시지 두 개로 잘릴 수 있다

- **대상 버전 / 요구사항 ID:** V1 dda891f / R13.
- **근거:** `src/change-runtime.ts:741`·`:755`, `src/format.ts:4`; `evidence/format-probe.json`.
- **재현 조건과 실제 관찰:** 실제 preview 렌더러에 합성 변경 파일 10개(최대 경로 길이 192)를 넣었다. digest가 문자 1775에서 시작하도록 내용 길이를 맞추면 1800자 페이지 경계에서 갈리고, 어느 메시지에도 완전한 digest가 없다. 페이지를 합치면 원문은 보존된다. 모의 artifact/approval 포트를 사용한 렌더링 시험이다.
- **사용자 또는 운영 영향:** 복사·승인 실패와 혼란. 잘못된 digest는 거부되므로 승인 우회를 확인한 것은 아니다.
- **기존 테스트가 놓친 이유:** 길이 제한·내용 보존은 검사하지만 명령/승인 토큰의 불가분성을 검사하지 않는다.
- **확인 상태:** `confirmed`.
- **최소 수정안과 추가 시험:** 승인 명령을 별도 메시지 또는 분할 금지 블록으로 보낸다. 경계 직전/중간/직후에 digest가 걸리는 세 사례와 긴 경로를 검사한다.

### A06 — [중요도: low] CHANGE 자식 실패 안내의 `/retry`가 실제로는 거부된다

- **대상 버전 / 요구사항 ID:** V1 dda891f / R03, R13.
- **근거:** `src/store.ts:351`·`:358`·`:729`·`:737`, `src/claude-task-bridge.ts`의 실패 처리, `src/change-runtime.ts:730`; `evidence/retry-probe.json`.
- **재현 조건과 실제 관찰:** 실제 Store·ChangeStore와 PGlite에서 authoring 세대에 연결된 자식 작업을 실패시켰다. 실패 outbox는 `/retry`를 권했지만 같은 작업의 retry는 `ok:false`, 상태 `failed`였다. retry UPDATE가 `change_child_jobs`가 있는 행을 제외하는 코드와 일치한다. CHANGE 부모의 안내는 별도로 새 `/change`를 요구한다. 모델·운영 Discord는 사용하지 않았다.
- **사용자 또는 운영 영향:** 지시된 복구 명령이 실패하고 상충하는 안내를 받는다. 자식을 되살리지 않는 보호 조건 자체는 타당하다.
- **기존 테스트가 놓친 이유:** 자식 retry 거부는 검증하지만 사용자에게 보낸 문구와 가능한 복구 행동의 일치를 검사하지 않는다.
- **확인 상태:** `confirmed`.
- **최소 수정안과 추가 시험:** CHANGE 자식은 부모 상태·새 요청/세대 안내를 사용하고 일반 작업만 `/retry`를 제시한다. 실제 자식 실패 알림에서 불가능한 명령을 권하지 않는 회귀를 둔다.

### A07 — [중요도: low] unknown 조사 후보가 첫 50행에 고정되는 조건부 굶주림

- **대상 버전 / 요구사항 ID:** V1 dda891f / F02, F06.
- **근거:** `src/store.ts:447`·`:452`, `test/unknown-probe.test.ts`; T19 이관 항목.
- **재현 조건과 실제 관찰:** SQL은 unknown chat/review를 `ORDER BY id LIMIT 50`으로 먼저 자르고, 그 안에서만 backoff를 검사한다. 앞 50행이 남으면 뒤 행은 후보가 되지 않는 구조다. **현 배치의 interactive 직렬 슬롯은 unknown이 남는 동안 새 실행을 막으므로, 정상 경로에서 51개까지 쌓이는 도달 조건을 입증하지 못했다.** 대량 시드/퍼징은 하지 않았다.
- **사용자 또는 운영 영향:** 복원·이관·향후 동시성 확대 등으로 많은 unknown을 허용하면 뒤 행의 종료 확인이 지연될 수 있다. 현재 운영에서 발생한 장애로 보지 않는다.
- **기존 테스트가 놓친 이유:** backoff·CAS·단일 unknown 해소 중심이며 후보 상한 뒤의 진행성은 검사하지 않는다.
- **확인 상태:** `needs_verification`.
- **최소 수정안과 추가 시험:** 먼저 unknown 개수 불변식/복원 경로를 확인한다. 다수 unknown이 가능한 계약이면 DB 커서나 due 조건을 SELECT에 적용하고 제한된 51행 진행성 시험을 둔다. 현재 출시 차단으로 추가하지 않는다.

### A08 — [중요도: low] 명령 재등록 주장은 Discord 응답 모양 확인이 필요하다

- **대상 버전 / 요구사항 ID:** V1 dda891f / F05, R02.
- **근거:** `src/commands.ts:27`·`:91`·`:102`, `test/publisher-main.test.ts:188`; `evidence/registration-probe.json`.
- **재현 조건과 실제 관찰:** 같은 정의가 그대로 돌아오는 대조군은 등록 함수 2회에 PUT 0회다. 따라서 T19의 “늘 PUT”을 무조건 참으로 수용하지 않는다. 반면 guild 응답에서 `contexts`/`integration_types`가 빠진 대역은 두 번 모두 PUT한다. 실제 운영 GET 응답의 해당 필드 존재/형식은 이번에 관찰하지 않았다.
- **사용자 또는 운영 영향:** 그 응답 모양이면 재시작/READY마다 불필요한 API 쓰기가 발생한다. 보안 경계 우회 증거는 아니다.
- **기존 테스트가 놓친 이유:** 모의 API가 전송한 정의를 그대로 저장·반환하므로 서버가 정규화/생략하는 필드가 드러나지 않는다.
- **확인 상태:** `needs_verification`.
- **최소 수정안과 추가 시험:** O03의 민감 값 없는 응답 shape 확인 뒤 guild에서 의미 있는 필드만 비교한다. roundtrip/생략/default 응답별 불필요한 PUT 0을 검사하고, 실제 명령 정의 변경은 계속 갱신되게 한다.

## 네 분류와 티켓 후보

| 분류 | 항목 | 처리 방향 |
|---|---|---|
| 출시 차단 | A01·A02 | 출력·최신 권한 집행 수정 후 보안 회귀와 T21 재감사. 실자격 유출 사고로 확정한 것은 아님 |
| 현 버전 필수 수정 | A03·A04·A06 | 원문 수명 계약/집행, 준비 실패 상태 정정, 가능한 복구 명령으로 안내 정정 |
| 다음 버전 개선 제안 | A05·A07, CHANGE 단계의 구조화 진행 로그, 조용한 허용 밖 채널 거부의 관측성 | A05는 작은 수정이면 V1에 포함 가능. A07은 도달 가능성부터 확인. 로그에는 ID/단계/사유 코드만, 본문·비공개 라벨 없음 |
| 불필요한 복잡도 제거 | A08의 불필요한 재등록(조건부), 무근거 서비스 추가 금지 | 응답 정규화가 필요하면 비교만 단순화. 별도 벡터 DB·지식 그래프·웹 UI·새 운영 실행기를 도입할 근거 없음. 격리 파드·독립 삭제 원장·서명 R08 경로는 확인한 경계 때문에 필요하므로 제거 대상으로 삼지 않음 |

**결함 티켓 후보**(저장소 이슈는 생성하지 않음):

| 후보 | 범위 | 완료 조건 |
|---|---|---|
| FIX-01 | A01 task 질문/요약 공개 검사 | 정상 중계 유지, 합성 비밀·내부 표식은 실제 게시 경로에서 REST 0 또는 고정 비민감 안내, 원문 로그/저장 없음; 관련 DATA-01 fail 해소 |
| FIX-02 | A02 Discord 철회/dispatch 경합 | 철회와 발송 시작의 기준점 문서화, 철회 선행 시 message/thread/예약 REST 0, 실제 PG 두 연결·재시작/unknown 회귀; AUTH-02 fail 해소 |
| FIX-03 | A03 원문 보존 | 필드별 기간·삭제·진행 중 예외·백업 재적용 합의와 구현, cutoff/복원 시험으로 원문 비노출 확인 |
| FIX-04 | A04 검증 상태 | payload 미시작 준비 실패 not_run, 실제 시험 실패 failed, unknown/취소 구분·재현 로그 |
| FIX-05 | A06 실패 안내 | CHANGE 부모/자식과 일반 작업의 안내를 실행 가능한 명령에 맞추고 회귀 검증 |
| 개선 후보 | A05·A07·A08 | A05 분할 방지; A07 도달 조건 먼저; A08 실제 response shape 확인 뒤 결정. 출시 차단 해소와 혼동하지 않음 |

**승인·연동 티켓 후보**는 코드 결함과 따로 둔다. 추가 실행은 이 감사가 승인하지 않는다. 정확한 질의·승인·중단/정리 조건은 `OBSERVATION-REQUESTS.md`에 있다.

| 후보 | 필수 미완료 | 완료 조건 |
|---|---|---|
| INT-01 / O01 | SEC-02 TaskLane 전체 조립·실모델 악성 입력 | 실제 배포 digest/프로필에 연결된 격리 경로에서 합성 자격·양성/음성 대조, 도구 실행 확인·외부 효과 0·정리 완료. tools=0/api_error는 not_run. 실자격 직접 Read는 승인 없이 하지 않으며 동등 경로 합성 대안의 수용 범위를 기록 |
| INT-02 / O02 | EVENT-02 실제 게시 ACK 유실·프로세스 종료 | 지정 시험 채널/PR에서 effect→로컬 ACK 사이 단 한 번 장애, 재기동 뒤 기존 게시와 맞춰 중복 0·unknown 보존/해소 증거. Discord 실제 중복 하위 사례도 가능한 범위 명시 |
| INT-03 / O03 | TASK-01 실제 Codex notify, R08 운영 수명·복원 | 시험 연결의 서명·소유자·중복·해제/복원 fence·대기 사본 처리, 고정 알림임을 확인하고 키 폐기. 명령 API shape 관찰은 부가 항목 |
| INT-04 / O04 | CHANGE-01 여러 턴·CHANGE-03 live 경쟁 | 질문→정상/비공개 답→새 artifact/시험/독립 리뷰/승인 바인딩; base 또는 사람 ref 이동 때 덮어쓰기/구증거 게시 0 |
| INT-05 / O05 | CHANGE-02 실제 writer 신원의 미실시 거부 | 안전한 시험 대상·정확 API/branch/file을 사람이 승인, merge/workflow 경계의 실제 거부와 원인·main 불변·정리 확인. 권한 부족 403을 ruleset 증거로 대체 안 함 |
| INT-06 / O06 | DEPLOY-01 stale/unready·현재 등록 대상 없음 | 시험 앱 재등록을 승인하거나 동등 제한 대상 결정. H/M/K/D와 Argo 관측 시각/Ready 불일치를 성공으로 표시하지 않는 증거; 정리 뒤 미등록 상태 명시 |
| INT-07 / O07 | DATA-01 실모델 출력의 공개 범위 | FIX-01 뒤 공개 입력+합성 비공개 표식으로 모델이 내놓은 결과를 코드가 거부하는 것을 관찰. 모델이 거절하거나 표식을 출력하지 않은 경우 “시도되지 않음”과 검사기 통과를 분리 |

고위험 live 부정 시험을 생략하려면 사람과 호출자가 제한 대상·제외 기능·대체 증거 수용을 명시해야 한다. 감사자는 이를 추정해 `blocked`를 지우지 않는다. 결함과 승인·연동 후보를 처리한 뒤 T21을 다시 실행한다.

## T19·T20 이관 항목 전수 처리

| 이관 항목 | 감사 처리·근거 | 티켓/수용 사유 |
|---|---|---|
| T19 여러 턴 CHANGE 질문/answer live | 로컬 회귀 통과, 실제 H3는 작성 한 턴 | INT-04, CHANGE-01 blocked |
| T19 실제 writer PUT merge·workflow push 거부 | AC-P8 원본 19 steps 중 try-merge not_run; workflow push 미실시 | INT-05, CHANGE-02 blocked |
| T19 live 경합 PR | freshness/ref/사람 commit 로컬 시험 존재·통과 | INT-04, CHANGE-03 blocked |
| T19 Argo stale/unready | mock 통과·정상 observed 기록만 있음 | INT-06, DEPLOY-01 blocked |
| T19 공개 입력→실모델 비공개 값 생성 | 실제 비밀을 넣지 않았으며 이전 실연동 없음 | INT-07. DATA-01은 독립 A01 때문에 fail |
| T19 TaskLane SEC-02·실모델 악성·실자격 Read | 로컬 CLI/Bun 경계 통과, 운영 직접 exec 64도구/83 pass 기록. TaskLane 아님 | INT-01. 실제 키를 읽지 않는 동등 경로 시험을 우선 제안; 승인 전 blocked |
| T19 실제 프로세스 kill/live fault | 현재 PG·REST 대역 시험 통과, 운영에서는 미실시 | INT-02, EVENT-02 blocked |
| T19 스위치/정책 재시작 반영·종료 중 쓰기 | D1의 기동 시 정책 고정과 현재 종료 루프를 확인 | 설계 선택 수용 근거는 사용자 결정. 즉시 효과가 필요하면 별도 중단·자격 회수. /revoke의 현재 Discord 보장은 A02로 제한 |
| T19 bwrap 준비 실패 분류 | 실제 감사 이미지에서 payload 미실행/started true 재현 | A04/FIX-04 |
| T19 task v1 질문 비밀 검사 | 질문뿐 아니라 완료 요약도 재현. CHANGE 질문 검사는 현재 존재 | A01/FIX-01 |
| T19 CHANGE 전이 로그 없음 | `change_phase` DB 감사와 `/change-status`는 존재. 프로세스 진행 로그 부재와 감사 기록 부재는 다름 | 다음 개선: 고정 코드 진행 로그. 별도 출시 차단 아님 |
| T19 승인 digest 분할 | 실제 preview+페이지 함수의 조건부 분할 재현 | A05 개선 후보, 잘못된 digest는 거부 |
| T19 CHANGE 자식 `/retry` 안내 | 실제 연결된 자식의 실패 안내/retry 거부를 재현 | A06/FIX-05 |
| T19 request_inputs·questions.answer 보존 | 8일 뒤 artifact만 지워짐을 재현 | A03/FIX-03. artifact 7일을 모든 원문 정책이라고 오해하지 않음 |
| T19 정책 revision 변경 시 진행 CHANGE 차단 | 증거·승인의 정책 바인딩 때문에 의도적으로 닫힘 | 수용: 새 정책에 옛 승인을 재사용하지 않음. 상태 확인 뒤 새 요청/세대 필요 |
| T19 reserveUnknownProbes 굶주림 모양 | 첫50행 구조 확인, 현 직렬 슬롯에서 51행 도달은 미입증 | A07 needs_verification, 현 버전 확정 장애로 세지 않음 |
| T19 registerCommands 늘 PUT | 동일 정의 왕복 PUT0, 필드 생략 대역 PUT2 | A08 needs_verification. 무조건 “늘”이라는 주장은 정정 필요 |
| T19 게시 서버 둘의 간헐 verification_not_run | 이번 전체 실행 통과. 과거 270회 중21회 기록은 역사적 증거이며 이번 재현 아님 | 운영 단일 게시 서버 제약 유지. 고가용/다중 게시 서버 전 필수 조사; 반복 부하 시험은 제안만 |
| T19 CHANGE 켜짐·smoke 배포 제거·writer 설치 | 현재 Git 선언 CHANGE enabled, smoke 앱 없음. approvals의 writer smoke만 설치·homelab E 유지 기록 대조 | 의도된 정리로 수용. deploy_config_unregistered를 성공으로 읽지 않음. 현재 설치 상태 새 실측은 아님 |
| T20 기억→모델 경로 | memories 조회와 MemoryService 소비자는 기억 명령·모델 없는 브리핑. 현재 코드에도 자동 주입 경로 없음 | 그 하위 SEC-01만 not_applicable. 전체 SEC-01은 PR/로그 경계를 평가해 pass |
| T20 인증서·복원 칸 T24, 작업/질문 칸 T18 | T24 실제 cert 지표·restore annotation·브리핑 기록과 현재 코드, c439cee 작업 칸 확인 | 이관 시점의 미확인 상태는 해소. 백업 성공=복원 성공으로 합치지 않음 |
| T20 허용 밖 채널 조용한 거부 | 현재 ingress Denied와 실제 과거 “응답 없음” 기록 일치 | 보안 거부는 동작. 정보 노출 없는 감사 카운터/owner 안내를 다음 개선으로 제안 |

## 반례 10개 축과 필수 반례 표의 결론

| 감사 축 (`04` §1) | 실제 대조 | 결론 |
|---|---|---|
| 1 범위/누락 | F9+R18 위치, 시험30, E2E5, 확정 D-14/R08 범위 | 구현 위치27개 존재. 실제 Codex notify 등은 blocked, 미래 실행 권한 부여 없음 |
| 2 리비전 일치 | detached HEAD, docs-only diff, 이미지 provenance, worker runtime43 모듈 | 선언·기록 연결 확인. 현재 파드 재관측과 서명 재검증은 아님 |
| 3 역할/권한 | 서명 capability·worker 자격·RBAC·writer route·Discord dispatch | GitHub 제한은 실제 코드 집행, Discord A02 위반 |
| 4 비신뢰 주입 | PR/AGENTS/로그 untrusted, 무도구 리뷰, 고정 CLI 격리 | SEC-01 제한 통과; SEC-02 조립 실측 blocked |
| 5 중복/누락/ACK/경쟁 | inbox/세대/lease/PG/대조, 실제 재전송·backfill | 정상 복구 근거 있음. live ACK/kill·CHANGE 경쟁은 별도 승인 필요 |
| 6 ACL/출력/삭제 | task relay, memory 삭제/복원, CHANGE 공개 검사 | A01·A02·A03; 기억 삭제는 별도 실제 PITR 증거 있음 |
| 7 실제 외부 기능 | 고정 CLI 능력·R08 read-only·App 기록·PR 실제 COMMENTED | attach를 임의 작업 제어로 과장하지 않음. 실제 Codex notify 미확인 |
| 8 장애/복구 | unknown과 취소, 원장 기동 장벽, NUC/봇 중단 기록 | bwrap 분류 A04. 정상 shutdown/RTC를 정전 성공으로 확대하지 않음 |
| 9 예산/복잡도 | 레인/상한·10+10 승인·운영 단일 게시자·프로필 관리 | 최악 혼합 부하·큰 저장소 최대 RSS 미측정; A07·A08 조건부 개선 |
| 10 조기 도입/과설계 | V1 writer 끝점·R08 능력·배포 read-only | V4/V5 실행기·새 지식 서비스는 필요 근거 없음 |

`04` §2의 PR 병합 정책·간접 쓰기는 봇 App을 D-07 배포 자동병합 작성 주체에서 제외하는 실제 AC-P8 기록과 writer route 차단으로 대조했다. 참고 리뷰는 병합 전 필수 gate가 아니다. 게시 자격·PR 인젝션은 역할표/SEC-01·02, 리비전 경쟁·중복 외부 효과는 REVIEW-02/CHANGE-03/EVENT-02, 접근 제어·보안 출력은 A01·A02/DATA-01, 성공/중단 판정은 A04/TASK-03/EVENT-04, 외부 기능은 TASK-01, 기억 삭제는 DATA-02, 독립 운영 복구는 OPS-02로 각각 추적했다.

## 모델 판단과 실행기 증거

| 무엇을 주장할 수 있는가 | 증거 | 주장할 수 없는 것 |
|---|---|---|
| 코드가 금지된 GitHub 함수·대상·본문을 거부 | writerRouteAllowed/bodyAllowed·restrictGitHubWrite의 실제 회귀, 호출 수0, AC-P8 main/deploy GH013 | 모델이 “안전”하다고 말했으니 merge도 안전하다는 주장 |
| 무도구 리뷰가 정해진 구조의 결과만 수용 | 고정 CLI 초기화/도구 검사·스키마, 실제 COMMENTED | 모든 모델 인젝션/논리 오류를 막는다는 보증 |
| 실제 sandbox가 합성 자격/파일/소켓 접근을 막음 | 로컬 CLI/Bun 강제 tool_use, 정책 해제 대조에서 노출을 잡고 정상 파일 작업은 허용; 과거 운영 직접 exec | tools0/api_error 또는 모델의 접근 거절을 격리 집행 통과로 세기 |
| 변경 증거가 같은 tree/base/정책에 묶임 | receipt/digest/CAS·실제 PR18 parent/tree 기록 | 독립 리뷰 pass가 변경에 버그가 없다는 증거라는 주장 |
| task 출력 경계가 빠져 있음 | 합성 토큰이 실제 relay 코드에서 메시지로 나감 | 실제 운영 키가 유출됐다는 사고 확정 |

## 권한표와 운영 지침

| 역할 | 가진 권한/자료 | 집행 경계·잔여 위험 |
|---|---|---|
| 요청자(owner) | 허용 guild/채널에서 명령·질문 답·digest 승인 | 비owner·DM·타 스레드 거부. owner 권한도 운영 shell/DB 변경/병합으로 확대하지 않음 |
| 게시 서버 | Discord bot 자격, 리뷰 App 키, writer App 키, 봇 DB, 읽기 Grafana/Kubernetes, worker 서명 개인 키, 삭제 원장 | 가장 큰 신뢰 경계. 키는 작업자에 전달하지 않음. App 권한만으로 merge를 막을 수 없어 제한 코드가 필수. A01·A02 수정 필요 |
| 대화/리뷰 작업자 | 해당 레인 모델 자격, 검증 공개 키, nonce/임시 공간; 운영/게시 키 없음 | 초기 env 구성·무도구 리뷰·빈 workspace·고정 버전. 모델 한도는 task와 계정 차원 공유 가능 |
| task 작업자 | 별도 모델 토큰, task 전용 PVC, 서명 공개 키 | hostUsers false, 무권한 UID, read-only root, SA 토큰 없음, Localhost seccomp/AppArmor, task PID 정리. 컨트롤러는 모델 자격을 읽어 CLI에 전달하므로 “파드 안에 자격이 전혀 없음”은 아님 |
| 무자격 검증 프로세스 | 고정 toolchain·읽기 source·제한 scratch | 비어 있는 env·파일/네트워크 격리·실제 소멸 확인. namespace 준비 실패 분류 A04 |
| GitHub reviewer / writer | reviewer: 선택 저장소 COMMENT 경로. writer: 작업별 저장소1개, Contents write 토큰과 PR 토큰 분리 | writer 신원·ruleset·최종 효과의 결합. 과거 기록상 writer 설치는 smoke 하나; 이번 현재 설치 조회는 없음 |
| 홈랩 읽기 | get/list/watch 허용 리소스·Grafana 고정 템플릿 | Secret·ConfigMap·pods/log·exec 없음. 넓은 원본 읽기 권한을 가진 게시 서버 자체 침해까지 보호하는 것은 아님 |
| R08 외부 기기 | 명시 연결별 서명 키·동의한 최소 이벤트 | tailnet 전용 진입·시간/nonce/순서·소유자·detach. 터미널 제어권 없음. 만료 전에 받은 이벤트는 만료 후 게시 가능하다는 현 계약을 detach와 구분 |
| 사람/호출자 | 운영 승인·키 회전·GitOps 병합·복원 | 이 감사는 그 권한을 사용하거나 수용을 대신 선언하지 않음 |

**연동:** 봇 `ARCHITECTURE.md` §14·§15·§16과 ops handoffs/foundation-deploy.md·pr-review.md·codex-bridge.md·change-pr.md를 기준으로 스위치/정책/대상/키/작업자 버전을 맞춘다. 정책·스위치는 기동 시 반영한다. 실행 성공, GitHub 게시, Discord 전달, 병합, 배포 관측, 기능 시험을 별도 상태로 확인한다. 현재 smoke 앱은 제거돼 있어 CHANGE 결과의 배포 관측이 미등록으로 닫히는 것이 정상이다.

**키 회전:** homelab `docs/runbooks-public/rotate.md`의 공통 절차·모델 토큰 §3e·R08 절차를 따른다. 새 키의 실제 신원/최소 범위 확인 → 원본 교체 → Secret/소비자 반영 → 승인된 최소 기능 확인 → 옛 키 폐기를 구분한다. Ready나 SecretSynced만으로 새 자격의 유효성을 확정하지 않는다. 리뷰/writer App 키는 각 App/설치 범위를 확인하고 게시 서버 기동 반영이 필요하다. 값·서명 seed를 로그·명령 인자·공개 기록에 남기지 않는다. Codex file-mutable 프로필 복귀 시 갱신본을 초기 seed로 덮지 않는다.

**비상 중단:** `/emergency-stop`은 새 모델 실행 차단·진행 모델 취소 요청이다. 이미 나간 외부 효과의 회수나 read 중단 명령은 아니다. CHANGE는 `/change-cancel`, R08은 끄기 전에 `/detach`로 연결을 폐기한다. 스위치 PR·정책 변경은 재시작까지 즉시 효력이 없고 종료 중인 바퀴의 쓰기가 남을 수 있다. `/revoke`는 권한 차단 수단이지만 A02 때문에 현재 Discord 발송의 완전한 즉시 차단 수단으로 신뢰하면 안 된다. 즉시 외부 쓰기를 막아야 하는 사고는 사람이 자격 회수/게시 프로세스 중단을 별도 승인 절차로 수행하고, 이미 전송한 효과는 조회로 대조한다. 이번 감사는 중단·회수를 실행하지 않았다.

**복구:** homelab `docs/runbooks-public/restore.md` §2·§2.1과 봇 `ARCHITECTURE.md` 기동 장벽·unknown 절차를 따른다. unknown을 자동 재실행하지 않는다. DB 복원 뒤 삭제 원장 적용/대기0을 확인하기 전 기억·브리핑을 열지 않는다. R08은 CLI 재개 PR의 `EXTERNAL_TASK_RESTORE_EPOCH` 변경이 필요하며 손 복원도 빠뜨리지 않는다. `/task-release`는 작업자가 실제로 사라졌다는 증거 뒤에만 사용한다. GitHub marker/ref/PR·Discord marker를 대조하고 부재 검색만으로 재게시하지 않는다. 비AI Telegram/healthchecks 경보는 봇과 독립 유지한다.

## 잔여 위험과 미실시

- 운영 접근을 하지 않아 현재 파드·정책 값·App 설치·현재 Discord 표시를 새로 확인하지 않았다. 선언 리비전과 과거 승인·시험 기록의 일치를 확인한 것이다.
- 과거 SEC-02 운영 기록은 직접 exec 경로다. 이번 로컬 컨테이너는 운영 Localhost LSM 프로필과 같지 않다. 모델의 거절·API 오류는 집행 증거가 아니다.
- 모델 구독 약관 해석·집행/공유 한도 위험은 D-14의 사용자 수용 기록이 있으나 감사가 서비스 제공자의 정책 적합성을 인증하지 않는다. 이번에 최신 약관을 재조사하지 않았다.
- 전용 host 프로필·bubblewrap·고정 CLI에 의존한다. 버전/설정/이미지 변경 시 같은 격리 대조를 다시 해야 한다. PID sweep은 task 전용 파드 전제가 필요하며 잘못된 동시 exec/sidecar 운영과 섞지 않는다.
- 삭제 원장 SSD와 NUC 동시 유실, 이미 게시된 외부 사본, 백업 보존 중 원문 바이트는 단순 DB 삭제로 해결되지 않는다. 수용된 위험과 A03의 미정 원문 수명은 별개다.
- R08 만료 전 접수된 미게시 이벤트는 연결 만료 후에도 나갈 수 있다. detach/권한 철회/복원 fence와 같은 의미로 표시하지 않는다. 실제 Codex notify·절전/외부 기기·복원 fence live는 O03에 남는다.
- 리뷰 표본은 작고 사전 정답이 없는 반복 사례가 섞여 있다. 전체 코드 정확도·보안 무결성을 수치화할 수 없다. 단일 서버·단일 게시자에서 검증했으며 큰 저장소/최악 혼합 부하와 간헐 실패의 근본 원인 조사는 남았다.
- 대량 퍼징·변이·운영 장애 주입·실자격 Read·PR/댓글/리뷰/라벨/배포 쓰기는 하지 않았다. 필수 로컬 검사는 모두 완료했고, 미완료 원인은 예산 부족이 아니라 운영 권한·실연동 범위다.

운영 관찰 요청은 **7건(O01~O07)**이다. 결함 수정과 명시적 승인·연동 결과가 갖춰진 뒤 다시 판정한다.
