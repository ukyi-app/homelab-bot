# V1_RELEASE_REPORT — T21-audit-2

## 1회차 대비 바뀐 것

| 항목 | 1회차 | 2회차 |
|---|---|---|
| 최종 판정 | NOT_READY | **NOT_READY**. 기존 보안 차단 2건은 수정됐으나 새 보존 경합 A09로 DATA-02 실패 |
| A01 · high | task 질문·요약 공개 검사 누락 | **fixed**, 원래 합성 토큰 재현에서 유출 0; T30 실모델 출력 차단도 확인 |
| A02 · high | 철회 완료 뒤 Discord dispatch | **fixed**, 철회 커밋이 dispatch보다 앞서면 REST 0·blocked |
| A03 · medium | task 답·CHANGE 요청 원문 무기한 잔류 | **fixed**, 종료 7일 정리 확인. 새 경합 A09는 별도 발견 |
| A04 · medium | bwrap 준비 실패를 실행 실패로 분류 | **fixed**, payload 시작 표식 없으면 started=false |
| A05 · low | 승인 digest 메시지 분할 | **not_fixed**, 현재 렌더러로 재현 |
| A06 · low | CHANGE 자식에 불가능한 /retry 권고 | **fixed**, 부모 상태·새 요청 안내로 일치 |
| A07 · low | 첫 50개 unknown 뒤 후보 기아 | **not_fixed**, 51행 조건 재현; 정상 운영의 도달 가능성은 여전히 needs_verification |
| A08 · low | 응답 모양에 따른 반복 명령 등록 의심 | **not_fixed**, T30 운영 응답 모양·재시작 기록으로 confirmed로 변경 |
| A09 · medium | 미발견 | **새 발견**, 오래된 정리 후보를 잡은 뒤 새 generation이 종료되면 원문·brief·artifact를 즉시 소거 |
| AUTH-02 / DATA-01 | fail / fail | pass / pass |
| EVENT-02·SEC-02·TASK-01·CHANGE-01·CHANGE-02·CHANGE-03·DEPLOY-01 | blocked 7 | pass 7, 아래에 적은 T30 증거 범위와 SEC-02 수용 결정에 한정 |
| DATA-02 | pass | **fail**, T31 원문 수명 범위를 포함한 판정; 기억 삭제·PITR 경로 자체는 통과 |
| 수용 시험 30개 | pass 21 / fail 2 / blocked 7 | **pass 29 / fail 1 / blocked 0 / not_run 0 / not_applicable 0** |
| 전체 코드 시험 | 2,085 / pass 2,063 / fail 0 / skip 22 | **2,136 / pass 2,114 / fail 0 / skip 22** |
| 감사 이미지 SEC-02 | 10/10 + 24/24 | **10/10 + 24/24**, skip 0 |
| 활성 발견 | high 2 / medium 2 / low 4 | **blocker 0 / high 0 / medium 1 / low 3**, confirmed 3·needs_verification 1 |

**판정: NOT_READY.** `04-audit-handoff.md` §9의 필수 기능·기본 복구 결함 기준을 적용했다. A09는 새 세대 종료 후 7일을 보존해야 하는 기록을 즉시 지우고 `/change … next` 재개를 막는다. 데이터가 없어지는 필수 수명 계약 위반이므로 수정 전 출시 차단으로 분류한다. 심각도 medium은 발생 조건과 영향 범위에 대한 등급이며, 필수 계약 실패를 통과로 바꾸지 않는다.

기존 결함 5개와 T30의 7개 이관 시험은 아래 범위에서 해소됐다. A09가 없었다면 기록된 제한 대상에서 `READY_FOR_SCOPED_PILOT`의 근거가 성립한다. 이것은 조건부 설명이며 두 번째 판정이 아니다. V1 전체 사용자·운영 수용을 감사자가 선언하지 않는다. V2를 시작하지 않았다.

## 범위·리비전·실행 증거

2026-11-09, 독립 Codex 감사. 사용자 지시에 따라 대체 계정 `codex`를 사용했다. 하위 에이전트 없이 읽기와 로컬 시험만 수행했다. 운영 API·Discord·Infisical 값·파드·SSH·Mac에 접근하지 않았고 GitHub는 GET만 사용했다. 소스·Git 상태·외부 게시를 변경하지 않았다.

| 기준 | 확인한 리비전 |
|---|---|
| 봇, detached | `9da65f5558f5e816592c990048c77324aa4585c2` |
| homelab, detached | `c1c0e5bcf82ca7d99bcd8315109bff52c7ae775f` |
| ops 기록 | `4563a2cf29b90907c6d4d22deaf49fe6f8e66942` |

`git diff 9a84772 9da65f5 --stat`은 PROJECT_STATUS·VERIFICATION 두 문서만, 19 additions / 2 deletions이다. T31 코드 이후 동작 변경이 없다는 주장은 확인했다. `evidence/baseline.json`에 전체 비교를 남겼다.

| 선언 이미지 | GitHub attestation GET의 source | 현재 소스와의 관계 |
|---|---|---|
| publisher `sha256:9dd4377e…` | `9da65f5` | 감사 소스와 일치 |
| task `sha256:ff5d453e…` | `630c48d` | T28 포함. worker 실행 경로의 이후 변경은 호출되지 않는 게시 서버 보존 함수·상수뿐 |
| chat/review `sha256:b3331339…` | `d4c8bda` | 정적 runtime import 43개 중 task-bridge·change-verifier 파일은 달라짐. 전자는 보존 함수 추가, 후자는 task 분기에서만 생성하는 검증기라 chat/review 실행 동작에 닿지 않음 |

근거는 `evidence/image-provenance.json`·`worker-revision-closure.json`. **전체 import 파일이 동일하다고 주장하지 않는다.** `worker-main.ts`의 config.task 분기와 호출 지점을 대조한 경로별 동등성 판단이다. Dockerfile·package.json·lockfile·tsconfig도 비교했다. attestation의 payload를 GET으로 대조했으며 서명 암호 검증이나 현재 파드 관측을 실행한 것은 아니다.

Node 24.22.0, 실제 PostgreSQL Unix socket으로 npm ci·check·build와 전체 시험을 실행했다. 전체 206,272ms, 실패 0으로 알려진 간헐 실패의 재시험은 불필요했다. 새 Dockerfile 감사 이미지에서 SEC-02를 별도로 순차 실행했다. 전체 시험의 skip 22개는 이미지 의존 사례이고 별도 SEC-02에서 실행했다. 두 파일의 34개에는 전체 실행과 겹치는 사례가 있어 2,170개의 독립 시험으로 합산하지 않는다.

## A01~A08 재검증

| 발견 | 현재 코드·독립 재현 | 판정의 정확한 범위 |
|---|---|---|
| A01 fixed | `src/task-output.ts:24`, `src/claude-task-bridge.ts:354`·`:369`; `audit-probes.json` question/summary 모두 합성 토큰 미게시. 전체 task-output 회귀와 ops evidence/t30/INT-07.md | 질문은 고정 실패 안내, 완료 요약은 원문 대신 보류 안내. 정책을 읽지 못해도 닫힘. 실제 키 사고가 있었다는 주장은 하지 않음 |
| A02 fixed | `src/store.ts:546` dispatch 단일 SQL, `src/discord.ts:509`; audit-probes에서 revoke 커밋→dispatch→REST 0·blocked. T26 대화/예약/다른 scope/typing/ACK 회귀 | dispatch SQL을 발송 시작점으로 삼는다. 그 뒤 철회는 이미 시작한 외부 효과 회수 보장이 아님. ACK·typing의 최종 조회 뒤 네트워크 호출 사이까지 원자적이라고 확대하지 않음 |
| A03 fixed | `src/task-bridge.ts:59`, `src/change-store.ts:760`; 8일 뒤 질문 답·요청 원문 제거, digest 보존. raw-input-retention 실제 PG migration·복원 회귀 | 7일 정책과 진행 중 예외는 확정됨. 무기한 잔류 원인은 해소됐고 새 경쟁 조건은 A09로 분리 |
| A04 fixed | `src/change-verifier.ts:102`·`:115`·`:206`; bwrap-probe에서 chdir 실패, payload 미실행, started=false·exit1. change-verification 및 change-sec02 | payload 래퍼의 전용 fd 시작 표식으로 준비 완료 구분. 생존 프로세스가 없다는 확인도 필요. T30 INT-04 A의 운영 검증 성공이 양성 증거 |
| A05 not_fixed | `src/change-runtime.ts:740`, `src/format.ts:4`; format-probe의 실제 preview·messagePages | 전체 digest는 연결한 페이지에 남지만 어느 한 메시지에도 완전하지 않음. 승인 우회는 없음 |
| A06 fixed | `src/store.ts:355`, `src/change-advice.ts:7`; retry-probe의 실제 연결된 자식 실패 | 자식 retry는 계속 거부되고 안내는 부모 상태·새 요청으로 바뀜. 일반 작업의 retry 경로는 유지 |
| A07 not_fixed | `src/store.ts:454`·`:459`; unknown-probe에서 앞 50행 backoff, 51번째 due인데 선택 0. 첫 행 제거 후 51번째 선택 | 조건부 알고리즘 문제 확인. 현 단일 interactive 레인은 unknown이 새 실행을 막으므로 정상 운영에서 51개 누적은 입증하지 못함 |
| A08 not_fixed | `src/commands.ts:27`·`:91`·`:102`; registration-probe. ops evidence/t30/INT-03.md의 실제 32개 guild 정의에서 두 필드 생략, 재시작 2회 updated | 원래 정의를 그대로 돌려주는 대조군 PUT 0. 실제처럼 contexts/integration_types가 생략되면 호출 2회에 PUT 2. 운영 관찰로 조건 성립 확인 |

## 활성 발견 (`04` §8)

### A09 — [중요도: medium] 오래된 CHANGE 정리 후보가 새 세대의 원문·증거까지 지운다

- **대상 버전 / 요구사항:** V1 `9da65f5`, F04·R13, DATA-02(T27·T31 수명 계약).
- **근거:** `src/change-store.ts:762` 후보 SELECT, `:774` 개별 transaction, `:776`·`:777` phase만 재검사, `:778`~`:783` change_id 전체 세대 삭제·비움, `:241` input_purged 거부. `src/main.ts:606` 독립 주기 정리. `evidence/retention-race-probe.json`, `retention-race-pg-probe.json` 및 해당 실행 스크립트.
- **재현 조건과 관찰:** generation 1이 superseded로 8일 지난 뒤 정리 후보에 선정된다. 실제 제거 transaction 전에 owner가 generation 2를 열고, 정상 Store API로 snapshot_ready까지 진행한 뒤 base_moved로 다시 superseded가 된다. 정리는 현재 phase가 종료 상태라는 것만 보고 **종료 경과 0ms인 generation 2**의 artifact와 현재 brief·요청 원문까지 지운다. generation 3 열기는 `input_purged`로 거부된다. PGlite와 PostgreSQL 18에서 모두 재현했다. 반대로 generation 2 전이가 후보 SELECT 전에 끝난 대조군은 선택 0, 재개 성공이다.
- **영향:** 새 세대 증거와 재사용 요청문이 7일보다 일찍 비가역 소거된다. 사용자는 새 요청을 다시 작성해야 하고 상태 안내의 “보존 기간(7일)이 지나”도 실제 새 세대 시각과 맞지 않는다. 임의 외부 쓰기·권한 우회·운영 데이터 소실 사고를 관찰한 것은 아니다.
- **기존 시험이 놓친 이유:** cutoff 전후·진행 중 제외·정리 전 재개·복원은 검사하지만, 후보 SELECT와 부모 잠금 사이에 재개와 재종료가 모두 일어나는 순서는 없다. 20개 후보를 순서대로 처리하므로 뒤 후보의 선정 사실은 더 오래될 수 있다. 감사는 이 틈을 결정적으로 멈춰 합법적인 상태 전이를 넣었으며 실제 발생 빈도는 측정하지 않았다.
- **확인 상태:** `confirmed`. 오래된 SELECT/phase-only 재검사 구조는 기존 artifact 정리에도 있었고, T27·T31이 그 경계 안에 요청 원문·brief 소거를 더했다. 순수하게 T31에서 처음 생긴 race라고 서술하지 않는다.
- **최소 수정·추가 시험:** 부모 행 잠금 후 generation·종료 기준 시각·deployment 종료 조건·미확정 effect·활성/미정리 자식의 **전체 선정 조건**을 다시 확인하고 같은 transaction에서 지운다. 후보의 generation/updated_at CAS 또는 잠금 안 재선정으로 구현할 수 있다. 오래된 후보→새 세대→다시 종료를 실제 PG 두 연결에서 재현해 새 데이터가 남는지, 그 새 종료 시각+7일에는 지워지는지 확인한다. observing_deploy 상태 변경과 새 미정리 자식 경합도 검사한다.

### A05 — [중요도: low] 승인 digest가 두 메시지로 나뉜다

- **대상/근거:** V1 `9da65f5`, R13; `src/change-runtime.ts:740`, `src/format.ts:4`, `evidence/format-probe.json`.
- **조건/관찰:** 합성 파일 10개·최대 경로 192자, digest 시작 위치 1775. 1800자 페이지 경계가 digest를 가른다. 전체 연결 내용은 보존된다.
- **영향/기존 시험 공백:** 복사·승인 불편. 다른 digest는 거부되므로 권한 경계 결함은 아니다. 길이·전체 내용 시험에는 명령 토큰 불가분성 검사가 없다.
- **상태/최소 수정·시험:** `confirmed`. 승인 명령을 별도 메시지나 분할 금지 블록으로 만들고 경계 직전·중간·직후를 검사한다. 기존 다음 개선 후보를 유지한다.

### A07 — [중요도: low] unknown 후보 상한 뒤의 진행성은 보장되지 않는다

- **대상/근거:** V1 `9da65f5`, F02·F06; `src/store.ts:454`, `evidence/unknown-probe.json`.
- **조건/관찰:** 합성 unknown 51행 중 앞 50행의 다음 조사 시각만 미래로 설정하면 마지막 due 행을 고르지 않는다. 첫 행이 종료돼 후보에서 빠지자 마지막 행이 선택된다.
- **영향/기존 시험 공백:** 다수 unknown을 허용하는 복원·이관·향후 배치에서 뒤쪽 종료 확인이 지연될 수 있다. 정상 단일 interactive 슬롯의 상태 도달 증거는 없다. 기존 시험은 적은 수의 backoff·CAS 중심이다.
- **상태/최소 수정·시험:** 운영 영향은 `needs_verification`. 현재 출시 차단으로 올리지 않는다. 다수 unknown을 허용할 때 due 조건·커서를 DB 선정에 반영하고 같은 51행 진행성 시험을 둔다.

### A08 — [중요도: low] guild 명령 응답의 생략 필드 때문에 재등록한다

- **대상/근거:** V1 `9da65f5`, F05·R02; `src/commands.ts:27`·`:91`·`:102`, `evidence/registration-probe.json`, ops evidence/t30/INT-03.md.
- **조건/관찰:** 운영 GET은 32개 명령에서 contexts/integration_types를 생략한다. 기록된 두 재시작 모두 guild updated. 같은 응답 모양을 넣은 현재 함수는 PUT 2회, 그대로 반사하는 대조군은 PUT 0회다.
- **영향/기존 시험 공백:** READY·재시작 때 불필요한 쓰기·한도 소비. 보안 우회는 아니다. 기존 mock이 요청 모양을 그대로 돌려줘 놓쳤다.
- **상태/최소 수정·시험:** `confirmed`. guild에서 의미 없는 필드를 비교 대상에서 빼거나 API 응답의 기본값을 정규화한다. 실제 생략 모양으로 연속 등록 시 PUT 0과 정의 변경 시 PUT 1을 검사한다.

## T30 증거 재판정과 동등성의 한계

T30 완료 문구만으로 pass를 주지 않았다. 승인, 결과 JSON, 하네스 README·EQUIVALENCE, 고정 소스 diff, 현재 로컬 회귀를 대조했다. 원본 해시·선별 집계는 `evidence/t30-records.json`, deployment 집계는 `t30-deployment-summary.json`이다. 이번 감사의 실행이 아닌 과거 승인된 실연동 기록은 아래에서도 그 등급을 유지한다.

| 항목 / 관련 시험 | 인정한 증거 | 그 증거가 제외하는 것과 판정 |
|---|---|---|
| INT-01 / SEC-02 | 현재 local_integration 10+24. 과거 authorized_external: 운영 직접 exec의 도구 64/64, 무자격 검증 83 pass. 사용자 2026-11-08 18:11 KST의 기존 증거 수용 기록 | **전체 signed TaskLane→실모델 악성 도구→정리 경로는 not_run**. 실제 자격 직접 Read도 미실시. 사용자 결정이 허용한 V1 제한의 대체 증거로 ID를 pass로 재판정하며, 미실시 자체를 pass로 바꾸지 않는다. 운영 Localhost 프로필과 local unconfined를 동일시하지 않음 |
| INT-02 / EVENT-02 | authorized_external 실제 Discord·GitHub + local PG, assertions 18/18. 성공 응답 뒤 confirm 전 barrier→자식 SIGKILL 1회→동일 DB 재시작. Discord A unknown→sent 후 B 게시, POST 2; GitHub 각 쓰기 1회·PR 대조 | 선행 작성/검증/리뷰/승인은 mock, PR draft=true, Gateway·기동 장벽·다른 runtime loop 없음. A/B는 **같은 message_key의 페이지**. wire 유실·운영 파드 kill/OOM·서로 다른 메시지 순서를 입증하지 않음. 수용 시험의 “로컬 기록 유실” 실제 사례를 충족하므로 pass |
| INT-03 / TASK-01 | authorized_external 실제 Codex 0.166.0 notify→helper→서명 수신→Discord 1, 중복 재서명 202 duplicate·추가 게시 0, detach 뒤 401. 복원 fence는 local_integration PG 11/11 | 수동 sender once, LaunchAgent 지속 운전·실제 30일·집 밖·다른 member·절전 복귀는 not_run. 복원은 실제 운영 PITR이 아닌 로컬 세대 시험. 읽기 전용 알림의 필수 연결 경로를 확인해 pass |
| INT-04 A / CHANGE-01 | authorized_external 운영 조립·실모델. 질문→공개 답→같은 세션 resume→실제 smoke-unit→독립 리뷰→digest 승인→non-draft PR22. 현재 GET에서 H=38743cf, tree=d01f063, parent=1fdc730 확인 | 시험 문구·대상 하나. 리뷰 pass_with_warnings와 P2 두 건을 “결함 없음”으로 세지 않음. T28 시작 표식이 운영 프로필에서도 성공한 양성 증거. PR은 병합하지 않고 닫음. pass |
| INT-04 B/C/D / CHANGE-03 | authorized_external 실제 base 이동·GitHub ref, local PG의 실제 gate·명령 처리기, assertions 25/25. base 이동으로 superseded, 새 digest, 오래된 승인 거부, 예정 ref 충돌로 blocked·게시 쓰기 0 | 작성/검증/리뷰 receipt는 mock. publisher에는 가짜 키·POST 전부 거부 guard, Discord 없음. D의 “사람 commit”은 사람이 정한 내용을 writer 토큰으로 만든 것. **승인 전 존재 ref**의 gate 거부이며 gate 후 ref 경쟁은 로컬 증거만. 첫 BC의 cached404 blocked와 잘못된 run ID 시도를 숨기지 않음. 재개 승인·최종 JSON을 대조해 범위 내 pass |
| INT-05 / CHANGE-02 | authorized_external 실제 writer의 일반 bot ref 생성 201 양성 대조, SHA 고정 merge 405, workflow push GH013, main 불변·정리 확인 | merge는 ruleset·필수 리뷰, workflow는 workflows 권한 없음으로 거부된 서로 다른 경계. 프롬프트 거절이 아니다. 설치/권한 전체의 보편 안전성으로 확대하지 않음. pass |
| INT-06 / DEPLOY-01 | authorized_external 시험 변경 + production_observation 읽기. 실제 DeploymentReader/transport에 GitHub·Kubernetes 연결. config_stale 2→sync_running→observed, pod_unready 9, 제거 뒤 blocked | 서비스 매핑은 수동, kubectl GET transport, 10초 driver·5초 snapshot. 운영 60초 loop/Discord 전달은 아님. argo_compare_stale 단독·workload_unready 집계는 not_run, 로컬 회귀만. values 변경 반영 전 image 기준 observed를 전체 설정/기능 정상으로 해석하지 않음. pass |
| INT-07 / DATA-01 | authorized_external 모델 2회·도구 0, 분리한 합성 조각을 출력에서 결합. 질문 task_question_sensitive, 완료 요약 보류, 실제 Discord marker 0 | 실제 자격 사용·유출 시험 아님. 스캐너의 uppercase/비ASCII 하이픈 대조는 통과하나 원래 유효 토큰 바이트와 달라 “실제 키 유출” 증거가 아니다. 임의 인코딩·의미 기반 DLP 보장 없음. pass |

INT-02·04·05의 시험 PR 정리와 PR22의 tree/parent는 이번 GitHub GET으로도 대조했다(`evidence/github-pr-records.json`). PR19·20·22는 closed/unmerged, PR21은 승인된 base 이동으로 merged다. T30의 모델/Discord/운영 쓰기를 이번 감사가 다시 실행하지 않았다.

## T31: 다섯 칸의 7일 수명

| 원문 칸 | 현재 코드의 기준·예외 | 확인 |
|---|---|---|
| events.payload.text | received_at+7일. nonfinal job·buffered·확정 전 thread effect 제외. scheduler 잠금으로 retry와 직렬화, event는 SKIP LOCKED | raw-text-retention·PG migration·chat-context·재수신 회귀 pass |
| codex_questions.prompt | job finished_at, 없으면 created_at+7일. 진행/대기/unknown/cleanup pending 세션 제외 | cutoff·복원·멱등·상태 조합 회귀 pass |
| results.result | job finished_at, 없으면 result created_at+7일. 위 세션 예외. result={}·digest, evidence 유지 | 현재 실제 PG 포함 회귀 pass |
| outbox.payload.content | sent/blocked, available_at+7일. pending/sending/unknown·thread ID 제외 | 전송 시각 재기록·UTF-8 digest·대조용 원문 보존 회귀 pass |
| change_requests.brief | 종료 updated_at 또는 완료 deployment 관측/종료 창+7일. summary·goal·acceptanceCriteria만 비움, 경로·명령·label·digest 유지 | 정상 cutoff·복원 pass. **선정 후 재개/재종료 경쟁은 A09 fail** |

`src/raw-text-retention.ts`, `src/change-store.ts`, `src/main.ts:606`을 실제 시험과 대조했다. T27의 답·CHANGE 요청 원문도 함께 정리한다. 레인 스위치나 Discord READY 없이 기동 첫 바퀴와 1시간 주기로 실행한다. 다만 **1시간은 주기이며 무조건적인 최대 노출 시간은 아니다**. 각 원문 칸 최대 4,000행, CHANGE 최대 400건/바퀴, 잠금 건너뜀·DB 오류·적체에서는 여러 바퀴가 필요하다.

백업에는 최대 14일 원문이 남을 수 있다. 미종료 작업·변경, unknown·미확정 외부 효과, cleanup pending의 원문은 7일을 넘겨 보존한다. 이미 게시한 Discord/GitHub 사본을 DB 정리로 회수하지 않는다. 복원된 오래된 행은 다음 성공한 정리에서 다시 소거하며, 기억 삭제는 별도의 복원 밖 원장과 기동 장벽을 유지한다.

## 네 분류와 완료 조건

**출시 차단 / 결함 티켓 후보 FIX-09:** A09 전체 선정 조건을 잠금 안에서 재검사한다. 완료 조건은 새 세대·종료 시각·효과/자식 상태 경합의 PG 회귀, 7일 cutoff 양성/음성 대조, 현재 전체 시험 통과, 변경 리비전 고정 후 독립 재감사다. 소스 수정·티켓 생성·배포는 이 감사에서 하지 않았다.

**현 버전 필수 수정:** FIX-09 하나. 기존 T25~T29 수정은 확인됐다. A09를 발견했다고 A03의 무기한 보존 결함을 미수정으로 되돌리지는 않는다.

**승인·연동 티켓 후보:** 새 출시 차단 요청 **0건**. 첫 감사의 O01~O07은 T30 증거와 명시적 SEC-02 수용 결정으로 처리했다. 위 표에 남긴 미실시 하위 사례는 삭제하지 않았으며 제한 범위 확대·실행기 변경 때 재검토한다. 이번 결과를 낮추는 원인은 운영 권한 부재가 아니라 로컬에서 확인한 결함이다.

**다음 개선 제안:** A05 승인 명령 분할 방지, A07 다수 unknown 허용 시 진행성, 허용 밖 채널의 값 없는 거부 계수·owner 안내, CHANGE의 정상 단계 구조화 로그. 별도 서비스 추가 없이 기존 경로에 둔다.

**불필요한 복잡도 제거:** A08 불필요한 재등록을 응답 정규화로 줄인다. 현재처럼 동시성이 제한된 V1에 분산 큐·별도 지식 서비스·V4/V5 운영 실행기를 도입할 근거는 없다.

## T19·T20 이관 전수 처리

| 이관 항목 | 재확인·처리 |
|---|---|
| T19 여러 턴 CHANGE / writer merge·workflow 거부 / 실제 base·ref 경쟁 / stale·unready / 합성 비밀 출력 / ACK·kill | INT-04 A / INT-05 / INT-04 BCD / INT-06 / INT-07 / INT-02로 각각 처리. 하네스 제외 범위는 위 표대로 유지 |
| TaskLane 전체 SEC-02·악성 실모델·실자격 Read | INT-01 사용자 결정에 따른 대체 증거 수용. 전체 조립은 여전히 not_run |
| 스위치·정책은 재시작 반영, 종료 중 쓰기 가능 | 현재 기동 설정과 drain을 대조. 기존 계약으로 유지. 즉시 취소/철회도 이미 dispatch한 효과 회수는 아님 |
| bwrap 실패 분류 / task 질문 스캔 / 자식 retry 안내 / 두 원문 칸 | A04 / A01 / A06 / A03 fixed. T31 새 원문은 A09 별도 |
| CHANGE 정상 단계 로그 부족 | DB audit·상태 명령과 실패 로그는 있으나 모든 정상 전이의 구조화 로그는 없음. 기존 개선 후보 유지 |
| 승인 digest 분할 | A05 not_fixed, 편의 결함으로 추적 |
| 정책 revision 변경으로 진행 중 CHANGE 종료 | 증거의 정책 바인딩을 지키는 의도된 동작. 새 세대·새 증거/승인을 요구하는 계약 유지 |
| unknown 첫 50행 / 명령 재등록 | A07 not_fixed·도달성 미확인 / A08 not_fixed·운영 조건 confirmed |
| 두 publisher 시험의 간헐 verification_not_run | 이번 전체 실패 0. 운영 단일 publisher 제약 유지. 근본 원인을 해결했다고 주장하지 않음 |
| smoke만 writer 설치·CHANGE 허용, smoke 앱 제거, ruleset E | 선언·승인·T30 정리 기록 대조. 배포 미등록은 expected blocked, 배포 성공 아님 |
| T20 기억→모델 경로 | 현재 memory 표 접근·MemoryService 호출을 다시 검색. 기억 명령·모델 없는 briefing뿐; 자동 모델 주입 없음. 해당 SEC-01 하위 사례만 not_applicable |
| 인증서·복원 칸 T24, 작업·질문 칸 T18 | briefing-observations·briefing-task-lane 현재 회귀 및 기존 실측 기록 해시 재확인. 백업 성공·복원 검증을 구분 |
| 허용 밖 채널 조용한 거부 | 권한 거부는 유지. 감사/사용자 피드백은 개선 후보이며 비밀 없는 계수로 해결 가능 |

## 반례 10개 축

| 축 | 이번 감사의 결론 |
|---|---|
| 1 범위·누락 | 시험30·요구27·E2E5를 V1_TRACE에 전수 추적. R08은 사용자 결정한 읽기 전용 알림 |
| 2 리비전 | 세 HEAD, 문서 전용 diff, 세 attestation source, 43모듈 import와 경로별 변경 대조 |
| 3 역할·권한 | publisher/worker 분리·writer 제한·RBAC·서명 검사. A02 원래 경합 수정 |
| 4 비신뢰 주입 | PR/AGENTS/로그는 자료, 무도구 리뷰·고정 CLI 경계. 기억 자동 주입 없음 |
| 5 중복·누락·경합 | 현재 PG·backfill·세대 회귀와 T30 실제 외부 효과 대조. 원문 정리 경쟁 A09 별도 |
| 6 ACL·공개·삭제 | A01/A02 수정, T31 원문 수명 검증 중 A09 발견. 기억 삭제/PITR는 유지 |
| 7 실제 외부 기능 | 실제 Codex notify·COMMENT·writer 거부·PR22. fixture를 실모델로 세지 않음 |
| 8 장애·복구 | 실제 SIGKILL 뒤 대조, unknown 분리·소멸 확인·삭제 원장 장벽. A09 재개 실패 |
| 9 예산·복잡도 | 단일 publisher·직렬 레인·10+10 승인 부하 유지. A07/A08과 적체 정리 한계 명시 |
| 10 조기 도입 | V1 writer 끝점·R08 능력·read-only 배포 관측 유지. 새 운영 실행기 불필요 |

`04` §2의 13개 반례는 V1_TRACE의 AUTH·EVENT·READ·SEC·DATA·REVIEW·TASK·CHANGE·DEPLOY·OPS에 대응한다. D-07의 배포 digest 전용 자동병합에서 writer가 제외되고, V1 COMMENT는 병합 전 필수 검사가 아니다. API 200·idle·Ready·백업 성공·모델 pass를 서로 다른 성공 조건의 대용으로 사용하지 않았다.

## 모델 판단과 집행 증거

모델의 리뷰 verdict·“완료” 문장은 안전성 증거가 아니다. 이번 통과 근거는 실제 코드가 스키마/목표/권한을 거부한 시험, 실제 bwrap 경계의 양성·음성 대조, 실제 GitHub 거부 응답과 main 불변, Discord 게시 0 및 SHA/tree/receipt 대조다. INT-07은 모델이 합성 문자열을 출력하려 했고 게시 서버가 막았다는 증거다. 과거 tools=0 api_error는 SEC-02 통과 근거에서 제외한다.

## 권한표·운영 지침

| 역할 | 권한과 집행 경계 |
|---|---|
| 요청자 | 허용 owner·guild·scope에서 요청/답/digest 승인. 운영 shell·병합 권한으로 확대하지 않음 |
| publisher | Discord·review/writer App·봇 DB·읽기 API·서명 키·삭제 원장. 가장 큰 신뢰 경계; 작업자에 게시 자격을 넘기지 않음 |
| chat/review worker | 모델 자격·검증 공개 키·nonce/임시 공간. 무도구 리뷰, 정책/운영 자격 없음 |
| task worker | 별도 모델 자격·task PVC, hostUsers false·read-only root·SA 토큰 없음·Localhost 프로필·PID 정리. 컨트롤러에는 모델 자격이 존재함 |
| 무자격 verifier | 고정 toolchain·읽기 source·제한 scratch, 빈 자격 env·파일/네트워크 격리·소멸 확인 |
| GitHub reviewer/writer | reviewer COMMENT 코드 제한. writer 저장소 한정·contents/PR 토큰 분리·route/body 제한·ruleset 결합 |
| 홈랩 reader | 허용 get/list/watch·고정 Grafana 질의, Secret/ConfigMap/pods log/exec 제외. publisher 자체 침해까지 보장하지 않음 |
| R08 기기 | 연결별 서명 키·최소 이벤트·동의, tailnet 진입·nonce/시간·detach/fence. 터미널 제어 없음 |
| 사람 | 설치·키 회전·병합·복원·수용 결정. 감사자는 이를 대신하지 않음 |

연동은 `ARCHITECTURE.md` §14~16과 ops handoffs/foundation-deploy.md·pr-review.md·codex-bridge.md·change-pr.md를 따른다. 정책·스위치는 기동 시 반영하고 작업자 digest는 별도로 맞춘다. 이번 경로별 동등성 판단을 향후 이미지 변경에 자동 적용하지 않는다.

키 회전은 homelab `docs/runbooks-public/rotate.md`의 공통·모델·R08 절차를 따른다. 신원/최소 권한 확인→새 값 반영→승인된 최소 기능 검증→옛 키 폐기를 구분한다. Ready/SecretSynced만으로 새 자격이 유효하다고 판단하지 않는다. 값·서명 seed는 로그·인자·공개 기록에 남기지 않는다.

비상 중단은 `/emergency-stop`으로 새 모델 실행 차단·진행 모델 취소 요청, CHANGE는 `/change-cancel`, R08은 `/detach`다. `/revoke`는 dispatch보다 앞서 확정된 철회를 집행한다. 이미 시작한 전송·원격 효과는 회수 보장이 없으므로 필요하면 사람이 자격 회수/프로세스 중단 후 외부 상태를 대조한다. 스위치 재시작만을 즉시 중단으로 보지 않는다.

복구는 homelab `docs/runbooks-public/restore.md`와 봇의 기동 장벽·unknown 절차를 따른다. 삭제 원장 재적용 전 기억/브리핑을 열지 않고, R08 restore epoch를 바꿔 옛 키·미dispatch 알림을 막는다. unknown 자동 재실행 금지, 실제 소멸 증거 뒤 task-release, GitHub/Discord 외부 효과 조회 후 재시도 원칙을 지킨다. Telegram/healthchecks는 봇과 독립 유지한다.

## 남은 제약·미실시

운영 현재 상태를 새로 읽지 않았고, 제한 대상은 owner·허용 채널과 smoke 저장소다. SEC-02 전체 signed 운영 경로, 실자격 직접 Read, 실제 wire 유실/OOM, R08 다른 member·집 밖·절전·30일·운영 복원, gate 이후 실제 ref 경쟁, 별도 Argo 비교 stale·aggregate workload unready는 위 범위대로 미실시다. 새 운영 관찰 요청은 **0건**이며 이들을 실행했다고 쓰지 않았다.

고정 CLI·bubblewrap·호스트 프로필·커널 및 단일 task PID 공간 전제가 남는다. 구독 공유 한도·약관 관련 기존 사용자 결정은 유지하되 이번 감사가 최신 약관 적합성을 인증하지 않는다. 리뷰 평가 표본은 작고 사전 정답 없는 반복 사례도 있어 일반 정확도 수치로 확장하지 않는다. 최대 혼합 부하·장기 비용·실제 디스크 고갈·갑작스러운 정전 복원·대량 퍼징/변이는 실행하지 않았다.

필수 로컬 검사는 완료했다. 현재 남은 조치는 **FIX-09 수정 후 독립 재검증**이다. 보고서 수용·저장소 반영·운영 배포는 사람과 호출자의 결정이다.
