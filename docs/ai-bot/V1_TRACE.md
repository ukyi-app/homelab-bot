# V1_TRACE — T21-audit

> 이 문서가 가리키는 `evidence/…` 파일과 `OBSERVATION-REQUESTS.md`, 감사 인계는 비공개 운영 저장소 `ukyi-app/homelab-bot-ops`의 `evidence/release-audit/`와 `handoffs/release-audit.md`에 있다(D-13). T21 1회차 감사(2026-11-07, 봇 `dda891f`)의 결과이며, 수정 뒤 재감사가 이 문서를 갈음한다.

판정 **NOT_READY**. 감사 기준은 봇 `dda891f7fbba8aabcc83b1b03fec36836012fd36`, homelab `691b532e66e7edd802b56d8518144197e8500c55`, ops `6caf4cb4d0a89048876b18da702275e2704bd6d7`이다. 2026-11-07에 독립적으로 코드를 대조하고 로컬 시험을 실행했다. 운영 수용 선언은 하지 않는다.

## 판정과 증거 읽는 법

- **현재 로컬 실행 리비전은 모든 행에서 `dda891f`**다. 과거 실연동 리비전은 별도 열에 적었다. 과거 작업 ID를 소스 커밋으로 쓰지 않았다. 현재 소스로 로컬 회귀를 통과한 사실이 과거 운영 시험을 현재 리비전의 운영 재실행으로 바꾸지는 않는다.
- `pass`는 적힌 증거와 범위에서의 통과다. `blocked`는 로컬 실패가 아니라, T21에 명시적으로 이관된 필수 실연동 하위 사례를 닫지 못했다는 뜻이다. live가 필요한 사례는 이번 읽기·로컬 시험 권한으로 실행하지 않는다. 별도 승인 없이 과거 `not_run`을 pass로 바꾸지 않는다. `fail`이 있으면 미실시보다 우선한다.
- 등급은 `04` §3의 `mock`, `local_integration`, `authorized_external`, `production_observation`, `approved_operational_execution`만 사용한다. 과거 문서의 `live`는 승인된 시험이면 `authorized_external`로 읽는다. V4/V5 실행 증거인 `approved_operational_execution`은 이번에 없다.
- **L** = `evidence/full.log`·`full.meta`와 check/build 로그. 아래 시험 파일 약칭은 `test/<약칭>.test.ts`이며 L에서 실제 실행했다. 모의 Discord/GitHub/모델을 쓰는 부분은 실서비스 증거가 아니다.
- **S1/S2** = `evidence/change-sec02.log` / `sec02-boundary.log`와 각 meta. 실제 감사 이미지, 합성 자격, 가짜 모델 API. 두 파일 10/10, 24/24 통과. 전체 시험에서 건너뛴 22개는 여기서 모두 실행했다.
- **A01/A02/A03** = `evidence/audit-probes.json`(질문·요약, 철회 경합, 원문 보존). **A04** = `evidence/bwrap-probe.json`. **A05** = `evidence/format-probe.json`. 등록 비교 보조 시험은 `evidence/registration-probe.json`(발견 A08의 근거)이다. **A06** = `evidence/retry-probe.json`(실제 자식 실패 안내와 retry 거부).
- **V:행** = 현재 봇 `docs/ai-bot/VERIFICATION.md`의 시작 위치. **H** = `evidence/historical-records.json`의 원본 해시·선별 집계와 명시한 ops HANDOFF. **G** = `evidence/github-review-records.json`·`change-pr-tree.json` 및 공개 GitHub GET 대조. **O01~O07** = 비공개 운영 인계용 `OBSERVATION-REQUESTS.md`의 요청 번호. 공개 문서에서는 ops 자료를 파일명으로만 가리킨다.

전체 시험: **2,085 tests / 2,063 pass / 0 fail / 22 skipped**, 197,990ms, PostgreSQL 18.6 Unix socket, Node 24.22.0. 알려진 간헐 실패 두 사례는 이번 전체 실행에서 발생하지 않아 단독 재시도하지 않았다. SEC-02 별도 34개는 전체와 겹치는 시험을 포함하므로 2,085+34개의 서로 다른 시험으로 세지 않는다.

수용 시험 30개 집계: **pass 21 / fail 2 / blocked 7 / not_run 0 / not_applicable 0**. 행 안의 미실시·해당 없음 하위 사례는 전체 ID의 판정과 구분했다.

## 수용 시험 30개

| ID | 판정값 | 증거 등급 | 실행 리비전(현재는 모두 dda891f; 아래는 과거) | 증거 위치 | 잡는 실패 | 놓치는 범위·차단 이유 |
|---|---|---|---|---|---|---|
| AUTH-01 | pass | local_integration; authorized_external | T16b 2d5ad21/097c93e; T17 작업자 10f5da4~d77944e | foundation, publisher-policy, pr-review, external-task-receiver; V:725·330; ops handoffs/foundation-deploy.md·pr-review.md | owner/guild/channel/DM/설치/저장소/작성자/fork·서명 거부 | 운영 외부인 두 번째 계정은 없음. 로컬 부정 사례와 실제 허용 밖 채널·fork 거부를 구분. |
| AUTH-02 | fail | local_integration; authorized_external | T16b 2d5ad21; T20 55555b3 | A02; publisher-policy, memory-briefing, task-bridge; V:794 | 철회 전후 명령·질문·기억 접근 검사와 철회 영속성 | 철회가 커밋된 뒤 Discord dispatch가 시작되는 경합을 재현. A02가 과거 pass를 제한. |
| EVENT-01 | pass | local_integration; authorized_external | T17 작업자 7a4dfe6~d77944e; 게시 서버 개별 SHA 미기록 | foundation, publisher-pg, pr-review, task-lane-pg; V:371; ops handoffs/pr-review.md | inbox/의미 키·중복 GitHub 재전송·동시 질문/명령의 작업 한 건 | 실제 Discord RESUME 중복을 의도적으로 만든 증거 없음. 이 하위 사례는 not_run, O02. |
| EVENT-02 | blocked | local_integration; authorized_external | T16b 2d5ad21→097c93e; CHANGE 현재 로컬 dda891f | review-3, review-4, github-writer, change-recovery, change-pg; V:738·2016; O02 | 로컬 REST 성공 후 응답 유실·DB 확인 실패·재시작에서 기존 외부 효과 대조와 무재전송 | Discord outbox 실제 ACK 유실, GitHub 변경 게시 중 실제 프로세스 kill/live fault는 승인 범위 밖. 상호작용 ACK 통과로 대신하지 않음. |
| EVENT-03 | pass | local_integration; authorized_external | T16b 097c93e; T17 10f5da4 | publisher-recovery, pr-review; V:330·740; ops handoffs/foundation-deploy.md | 중단 중 메시지 backfill, 15분 PR 재조정, gap/커서·예산 | 14분 통신 차단 해제 뒤 41초 복구 기록. 무한 기간·전체 과거 PR 복구 보장 아님. |
| EVENT-04 | pass | local_integration; authorized_external | T16b 2d5ad21; T18 작업자 88b37c4 | unknown-probe, stop-confirmation, publisher-shutdown, task-lane-pg; V:742·1026 | lease/단절은 unknown, 소멸 확인 뒤 failed/cancelled, unknown 자동 재실행 차단 | 실제 abrupt kill/OOM은 미실시(O02). 과거 정상 종료·취소와 현재 로컬 단절을 증거로 삼음. |
| CHAT-01 | pass | local_integration; authorized_external | T16b 097c93e | chat-context, typing-debounce, read-lane, task-assembly; V:744 | 구독 후속 메시지, debounce, task 별도 레인·대화 맥락 | 실모델 응답 품질 일반화·장시간 부하 보장 없음. 공통 발송 철회 결함 A02 별도. |
| CHAT-02 | pass | local_integration; authorized_external | T16b 2d5ad21/097c93e | foundation, chat-context, publisher-recovery; V:745 | stop/resume·비활성 수집 차단·재시작/세션 정리 | Discord 외부에서 권한·보관 상태가 바뀌는 모든 순서는 실측하지 않음. |
| READ-01 | pass | local_integration; authorized_external | T16b 097c93e; T24 12a09c3 | publisher-read, read-lane, briefing-observations; V:746·822 | 등록/미등록/관측 불가·오래됨, 사실/가설/미확인, 현재 원본 없는 정상 주장 금지 | READ logs는 공개 답에 줄 수만 제공. 전체 로그를 읽었다고 주장하지 않음. |
| READ-02 | pass | local_integration; authorized_external | T16b 2d5ad21/097c93e; homelab 현재 선언 691b532e | foundation, publisher-read, publisher-config; homelab platform/bot-slot/templates/rbac.yaml:23; V:747 | 엄격 스키마·템플릿·자원/namespace/시간/바이트 상한, Secret/ConfigMap/exec 차단 | Grafana 자격 자체는 넓어 게시 서버 침해까지 막지 못함. 실제 Secret 값을 읽어보는 시험은 하지 않음. |
| SEC-01 | pass | mock; local_integration; authorized_external | T16b 097c93e; T17 10f5da4~d77944e | foundation, review-lane, pr-review, memory-briefing, change-review; V:748·337 | PR/AGENTS/로그 지시를 자료로 전달, 도구/정책 변경 스키마 거부, 기억은 정책이 되지 않음 | 실모델 보편적 인젝션 저항성은 증명 안 됨. 기억→모델 경로는 현재 없음(그 하위 사례만 not_applicable). |
| SEC-02 | blocked | local_integration; authorized_external | 현재 감사 이미지 dda891f; 과거 운영 5fb4a20·d4c8bda | S1·S2; task-settings-boundary, task-process-containment; V:1364·1922; H; O01 | 실제 고정 CLI/Bun, 합성 자격, 파일·프로세스·소켓·네트워크·음성/양성 대조 | 현재 TaskLane 전체 조립 경로와 실모델 악성 시험 미확인. 과거 tools=0 api_error는 보안 통과 아님. 실자격 직접 Read 미실시. |
| DATA-01 | fail | local_integration; mock; authorized_external | 현재 dda891f; T17 7a4dfe6 전후; T19 게시 29c73b8/작업자 d4c8bda | A01-question·A01-summary; change-data, change-publication, pr-review; V:361·1956; O07 | CHANGE/review 공개 provenance·내부 표식·비밀 패턴 차단, 다른 thread 접근 거부 | v1 task 질문·완료 요약은 합성 토큰을 그대로 전달. 현재 모델 자격의 정확 일치 반사 검사는 존재하며 실제 키 유출을 입증한 것은 아님. |
| DATA-02 | pass | local_integration; authorized_external | T20 게시 55555b3; 복원 후 dab3de1 문서 관측 | deletion-ledger, deletion-ledger-pg, memory-briefing, t20-startup-pg; V:794; H | 기억 정정/삭제의 검색·파생 사본·삭제 원장·PITR 뒤 장벽 재적용 | 이미 외부로 게시된 사본/백업 모든 바이트 소거 보장 아님. A03은 기억 외 task/change 원문 보존 문제. NUC+SSD 동시 유실은 수용 위험. |
| REVIEW-01 | pass | local_integration; authorized_external | T17 작업자 10f5da4→7a4dfe6→d77944e; PR head는 아래 품질 표 | pr-review, review-lane; V:337; G | 의도한 오류 두 PR의 유효 지적, 정상/바이너리/의존성 PR 오탐·부분 범위 평가 | 게시 8건+restricted 1건의 작은 표본. 모든 사례의 사전 정답이 있는 것은 아님. 옛 오탐 1건을 숨기지 않음. |
| REVIEW-02 | pass | local_integration; authorized_external | T17 작업자 10f5da4~d77944e | pr-review, review-1, review-2; V:358 | head 교체·base retarget·선병합에 superseded와 검토 SHA 표시 | 마지막 GET과 POST 사이 원격 경쟁은 잔존. 기본 base 이동 재리뷰 off는 확정 결정이며 오래된 결과를 최신 인증으로 쓰지 않음. |
| REVIEW-03 | pass | local_integration; authorized_external | T17 작업자 7a4dfe6; PR14 01c3fbf | review-input 관련 pr-review·review-diff-peak·review-lane; V:344; G | 큰/잘린 diff·바이너리 제외, partial/미확인 표시 | 로컬 diff 피크와 상한은 전체 모델 프로세스의 운영 최대 RSS 측정이 아님. |
| REVIEW-04 | pass | local_integration; authorized_external | T17 작업자 10f5da4~d77944e | pr-review, github-review-app; src/review.ts:133; V:337; G | 허용 POST /reviews와 event COMMENT만, APPROVE/REQUEST_CHANGES/merge 거부 | App Pull requests write 권한 자체는 approve를 막지 않음. 제한 게시 코드 경계가 증거이며 프롬프트 약속과 구분. |
| REVIEW-05 | pass | local_integration; authorized_external | T17 작업자 d77944e; PR16 c637d98 | pr-review, publisher-review; V:371; G | Bot 댓글 무시·작성자 숫자 허용 목록·자기 트리거 중복 세대 차단, Renovate PR 허용 | 운영 Bot 댓글 실례는 not_run. 실제 Renovate PR 리뷰와 로컬 Bot 댓글 부정 시험을 분리. |
| TASK-01 | blocked | local_integration; authorized_external | T18 작업자 88b37c4; R08 게시 c39b074 | task-assembly, external-task-assembly, external-task-helper, external-task-pg; V:1415·1500; O03 | 명시 연결·서명·소유자·능력 표시·해제, Claude Stop→수신→Discord | 실제 Codex notify, 다른 member/집 밖 기기·복원 epoch 운영 실측 없음. R08은 확정된 읽기 전용 알림이며 작업 제어가 아님. |
| TASK-02 | pass | local_integration; authorized_external | T18 작업자 88b37c4; 게시 서버 개별 SHA 미기록 | task-bridge, task-lane-pg, codex-bridge; V:1034 | 질문 ID/기한/소유자/중복·같은 세션 resume, 실제 두 턴 질문/답 | 바인딩 기능 판정이다. 질문 내용 공개 차단 결함은 DATA-01 fail/A01로 별도 반영. |
| TASK-03 | pass | local_integration; authorized_external | T18 작업자 88b37c4; 취소 안내 수정 2ed8485 | task-stream, task-cancel-notice, task-process-containment, codex-bridge; V:1035 | idle/가짜 완료/승인 문구 불신·소멸 확인 뒤 취소, 실제 취소 stopped true | 실제 취소 때 완료 안내 누락은 기록상 있었고 이후 로컬 회귀로 수정. 현재 운영 안내 재관측은 없음. R08 완료는 외부 보고라고 표시. |
| CHANGE-01 | blocked | local_integration; authorized_external | T19 게시 29c73b8; 작업자 d4c8bda; PR18 355af39 | change-assembly, change-pg, change-verification, change-review; V:1971; G; O04 | artifact/tree/base·시험·독립 리뷰·digest 승인→PR, 실제 한 턴 H.tree=T1/parent=B | 실제 여러 턴 질문→답→새 증거·승인 경로는 미실시. A04의 준비 실패 분류와 A05 안내 분할도 제한. |
| CHANGE-02 | blocked | local_integration; authorized_external | T19 게시 29c73b8; 작업자 d4c8bda; AC-P8 homelab 56162bf | github-writer, change-policy, change-publication, change-pg; V:1940; H; O05 | main/보호 경로/merge/dispatch/GraphQL/force 요청 전 거부, 실제 main/deploy GH013·자동병합 제외 | 실제 writer 신원의 PUT merge와 workflow git push는 승인 밖이라 미실시. 기존 시험 App 결과로 대체 안 함. |
| CHANGE-03 | blocked | local_integration | 현재 dda891f; 과거 실연동 해당 사례 없음 | change-freshness, change-recovery, change-pg, github-writer; V:2010; O04 | base 이동·사람 commit/ref 충돌·오래된 승인/정책·취소 뒤 쓰기 차단 | live 경합 PR 미실시. 보호 코드/PG 시험 통과를 실제 GitHub 경합 관측으로 승격하지 않음. |
| DEPLOY-01 | blocked | mock; authorized_external; production_observation | T19 게시 29c73b8; H355af39/Mf0f5298/Ka4f1005 | change-deployment, change-assembly; V:1971; G; O06 | PR head/merge/config/image의 관계·stale/unready/unknown/기능 검증 미실시 구분 | 정상 observed 실연동은 있음. 현재 smoke 앱 제거, stale/unready 실연동 없음. 관측 불가를 배포 성공으로 세지 않음. |
| MEM-01 | pass | local_integration; authorized_external | T20 55555b3 | memory-briefing, memory-commands, memory-commands-pg; V:790; H | 근거/ACL/시각/충돌·candidate와 active, 일시 지시로 정책 변형 금지 | 기억 내용이 모델 맥락에 자동 연결되지 않음. 실제 수집하지 않은 사실을 기억으로 검증하지 않음. |
| BRIEF-01 | pass | local_integration; authorized_external; production_observation | T20 55555b3; T24 12a09c3; 작업 칸 c439cee | memory-briefing, briefing-observations, briefing-task-lane, t20-startup-pg; V:793·822·1447; H | 08:50 Asia/Seoul·회차 멱등·재시작·원장 장벽·미조회/오래됨 표시·모델 비의존 | T24 인증서/복원 칸은 해소됨. 전체 현재 운영 상태를 새로 관찰하지 않음. 공통 철회 경합 A02는 여전히 적용. |
| OPS-01 | pass | local_integration; authorized_external | T16b 2d5ad21/097c93e; T17 d77944e; T18 88b37c4 | typing-debounce, read-lane-pg, worker-server, task-lane-pg, review-diff-peak; V:749 | 큐/레인/시간/도구/바이트 상한·취소/한도·대화 ACK, 승인된 10 PR+10 알림 | 원래 30+30을 시험하지 않음. 사용자 10+10 축소 승인 근거 존재. 혼합 최악 부하·장기 비용/자원은 미측정. |
| OPS-02 | pass | local_integration; authorized_external | T16b 2d5ad21/097c93e; T13 플랫폼 실행 2026-10-29(봇 배포 전) | foundation, publisher-main, ops-metrics; V:750; approvals.md:554·555·556; H | 봇 replicas 0에서도 Telegram 경보, NUC 종료 때 독립 healthchecks down/up | NUC 정상 종료+RTC 복귀 15분 기록이며 갑작스러운 정전 복원 성공 증거는 아님. 외부 알림은 사용자 폰 수신 기록으로 갈음 승인. |

## F01~F09·R01~R18 구현 추적

모두 구현 위치가 존재한다. 상태는 구현 존재 여부만이 아니라 현재 결함과 필수 미완료를 반영한다. 공통 경계 결함은 F ID와 해당 기능 ID에 표시하고, 모든 기능 행에 중복해서 기능 부재로 표시하지 않았다. 파일·행은 봇 `dda891f` 기준이다.

| ID | 상태 | 구현 파일·행 | 시험 ID | 근거·제약 |
|---|---|---|---|---|
| F01 | fail | src/policy.ts:78; src/discord.ts:477; src/review.ts:89; src/change-policy.ts:119 | AUTH-01, AUTH-02 | 허용 목록·즉시 철회 구현은 있으나 발송 경합 A02. |
| F02 | blocked | src/store.ts:73; src/store.ts:278; src/discord.ts:541; src/review.ts:899; src/change-publisher.ts:57 | EVENT-01~04 | inbox/outbox·의미 키·대조 구현. 실제 게시 ACK 유실/kill O02 미완료. |
| F03 | blocked | src/review-input.ts:33; src/run-control.ts:42; src/executor-claude-task.ts:302; src/task-containment.ts:60; src/change-verifier.ts:43 | SEC-01, SEC-02, READ-02 | 비신뢰 경계·실행 격리 존재. 운영 TaskLane 조립 실측 O01 미완료. |
| F04 | fail | src/memory.ts:189; src/memory.ts:279; src/change-publication.ts:127; src/task-bridge.ts:70; src/change-store.ts:753 | DATA-01, DATA-02, AUTH-02 | task 공개 검사 A01·철회 A02·원문 보존 A03. |
| F05 | pass | src/store.ts:130; src/store.ts:263; src/store.ts:744; src/worker.ts:94; src/run-control.ts:129 | OPS-01, TASK-03 | 직렬 레인·상한·우선순위·비상 중단 구현. 시범 부하 범위만 검증. |
| F06 | fail | src/contracts.ts:8; src/store.ts:390; src/store.ts:537; src/health.ts:6; src/change-verifier.ts:97 | EVENT-04, OPS-02, CHANGE-01 | 실행/전달 상태 분리는 존재. bwrap 준비 실패를 시험 실패로 기록하는 A04. |
| F07 | pass | src/briefing.ts:143; src/main.ts:334; src/main.ts:351; src/deletion-ledger.ts:110 | BRIEF-01, DATA-02, EVENT-03, OPS-02 | 영속 예약·기동 장벽·기억 PITR. R08 epoch 운영 실측은 TASK-01 O03에 남음. |
| F08 | pass | src/change-contracts.ts:144; src/change-artifact.ts:121; src/change-review.ts:356; src/review.ts:156 | REVIEW-01~03, CHANGE-01, CHANGE-03 | SHA/tree/receipt/정책 바인딩 존재·현재 로컬 통과. 실연동 범위 제한은 해당 시험 blocked로 유지. |
| F09 | fail | src/worker.ts:55; src/review.ts:133; src/github-writer.ts:37; src/github-writer.ts:176; src/discord.ts:502 | DATA-01, AUTH-02, REVIEW-04, CHANGE-02 | 게시자 분리·GitHub 함수 허용 목록은 있으나 Discord 출력/권한 집행 A01·A02. |
| R01 | fail | src/discord.ts:79; src/store.ts:63; src/store.ts:657; src/chat-context.ts:14 | CHAT-01, CHAT-02, AUTH-02 | 구독/후속/중지 구현. 철회 뒤 미발송 답 경합 A02. |
| R02 | pass | src/discord.ts:79; src/activity.ts:21; src/typing.ts:32; src/store.ts:97 | CHAT-01, OPS-01 | ACK·입력 중 표시·debounce·urgent 분리. |
| R03 | pass | src/runtime.ts:42; src/runtime.ts:54; src/store.ts:617; src/claude-task-bridge.ts:106 | CHAT-02, TASK-03, EVENT-04 | 대화/작업 분리와 실제 중단 확인. CHANGE 자식 재시도 안내 A06은 사용성 결함. |
| R04 | pass | src/catalog.ts:9; src/read.ts:33 | READ-01 | 카탈로그와 미등록/관측 불가 구분. |
| R05 | pass | src/read.ts:55; src/read-transports.ts:57; src/read-transports.ts:151 | READ-02 | 엄격한 입력·고정 질의·응답 투영·허용 자원만 조회. |
| R06 | pass | src/read.ts:24; src/chat-format.ts:9; src/chat-context.ts:14 | READ-01 | 사실/가설/미확인·관측 시각, 오래된 정상은 현재 증거가 아님. |
| R07 | pass | src/alerts.ts:14; src/briefing-observations.ts:266 | READ-01, OPS-02, BRIEF-01 | 고정 경보 요약·사건 스레드·조회 가능한 백업/인증서/작업 메타데이터. |
| R08 | blocked | src/external-task-links.ts:80; src/external-task-receiver.ts:179; src/external-task-commands.ts:51 | TASK-01 | 사용자 확정 read-only 알림. 실제 Codex notify·복원 세대 관측 O03 필요. |
| R09 | fail | src/task-bridge.ts:70; src/task-bridge.ts:119; src/claude-task-bridge.ts:487; src/claude-task-bridge.ts:505 | TASK-02, TASK-03, DATA-01 | 질문 ID/소유자/기한·완료 판정은 구현. task 텍스트 공개 경계 A01. |
| R10 | blocked | src/task-worker.ts:194; src/task-workspace.ts:275; src/executor-claude-task.ts:351; src/task-containment.ts:60 | TASK-01, SEC-02 | 독립 작업 공간·파드·자격 분리. TaskLane 전체 격리 관측 O01 필요. |
| R11 | pass | src/review.ts:323; src/review.ts:467; src/review.ts:786; src/github-review-io.ts:88 | AUTH-01, REVIEW-01, REVIEW-04, REVIEW-05 | 전용 App·COMMENT·고정 Discord 요약. 사람 병합 권한을 대신하지 않음. |
| R12 | pass | src/review.ts:156; src/review-input.ts:345; src/review.ts:957 | EVENT-01, REVIEW-02, REVIEW-03 | head/comparison/policy 세대·부분 검토·누락 재조정. |
| R13 | blocked | src/change-runtime.ts:149; src/change-publisher.ts:57; src/change-policy.ts:155; src/github-writer.ts:125 | CHANGE-01~03 | 격리 작성·검증·승인·브랜치/PR 구현. O04·O05 미완료, A04·A05·A06 수정 후보. |
| R14 | pass | src/change-review.ts:356; src/change-review.ts:445; src/change-review.ts:681; src/review-lane.ts:87 | CHANGE-01, CHANGE-03 | 작성자와 별도 세션·실제 diff/기준/시험 receipt를 묶어 검토. 같은 모델 계열이라도 세션 독립이며 다른 계열 의무는 없음. |
| R15 | blocked | src/change-deployment.ts:78; src/change-deployment.ts:189; src/change-deployment.ts:240 | DEPLOY-01 | H/M/K/D·readiness와 기능 검증 구분. 현재 배포 대상 제거와 O06. |
| R16 | pass | src/memory.ts:142; src/memory.ts:189; src/memory.ts:393; src/document-source.ts:32 | MEM-01 | 출처·시각·적용 범위·ACL 기반 저장/검색. 자동 모델 맥락 주입은 없음. |
| R17 | pass | src/memory.ts:150; src/memory.ts:174; src/memory.ts:230; src/memory.ts:279; src/deletion-ledger.ts:110 | MEM-01, DATA-02, AUTH-02 | 기억 데이터 접근·정정·삭제·복원은 통과. 공통 Discord 발송 경합은 F01/F09/R01 결함으로 별도 추적. |
| R18 | pass | src/briefing.ts:66; src/briefing.ts:203; src/briefing.ts:254; src/briefing.ts:403 | BRIEF-01 | 실제 예약·회차 멱등·미확인 표시·재시작. T24와 T18 작업 칸 구현 확인. |

## `01` §9 end-to-end 흐름 5개

| 흐름 | 상태 | 실행 리비전·등급 | 실제 근거 | 남은 경계 |
|---|---|---|---|---|
| 1. Discord → 상태·근거 → 구독/세션 정리·맥락 | fail | dda891f local_integration; T16b 097c93e authorized_external | foundation/chat-context/read-lane/publisher-recovery + 실제 조회·stop/resume 기록 | 정상 경로는 동작. A02에서 철회 완료 뒤 답이 나가 허용 범위 종료 계약 위반 |
| 2. PR → 최신 리뷰 → COMMENT → Discord 요약 | pass | dda891f local_integration; T17 10f5da4~d77944e authorized_external | 실제 PR11/12/14/16 리뷰 SHA·COMMENTED와 HANDOFF Discord sent, 현재 publisher-review/pr-review | 일반 정확도·병합 전 리뷰 완료 보증 없음. 공통 Discord A02는 별도 출시 차단 |
| 3. 소유/명시 연결 작업 → 질문·답 → 산출물·전달 | fail | dda891f local_integration; T18 88b37c4/c39b074 authorized_external | 실제 task 두 턴·취소와 Claude Stop 서명 알림, task-bridge/external-task 시험 | A01 출력 검사 누락. 실제 Codex notify O03, TaskLane SEC-02 O01 blocked. R08에는 질문 답/실행 제어 능력이 없음 |
| 4. 수정 → 격리 시험·독립 검토 → PR → 배포 읽기 | blocked | dda891f local_integration; 게시29c73b8/작업자d4c8bda authorized_external | H3 PR18 H=355af39, M=f0f5298, K=a4f1005, digest ea8fc024…; tree/parent 일치 기록·GitHub GET | 한 턴은 통과했지만 여러 턴·실제 경합·writer 추가 거부·stale/unready O04~O06 미완료. 현재 smoke 배포 없음 |
| 5. 결정 저장 → 출처 검색·정정·삭제 → 브리핑 → 재시작 | pass | dda891f local_integration; T20 55555b3/T24 12a09c3 authorized_external | 실제 삭제 전 PITR → 원장 entries1/applied1 → 삭제 후 검색 부재, 브리핑 한 회차 보존; 현재 startup/ledger/briefing 시험 | 이미 전달된 사본은 회수 보장 안 됨. 외부 SSD 동시 소실·R08 복원은 별도. 공통 Discord A02 적용 |

## 리뷰 품질 (`04` §6)

공개 GitHub 리뷰와 PR 코드를 직접 대조했다. #11과 #12 첫 리비전의 알려진 두 결함은 실제 코드와 맞는다. #14의 제외 파일 오탐 및 수정 후 부분 검토 표시도 대조했다. 각 head를 고정하고, 현재 PR16의 새 head(7d2cef7)를 과거 c637d98 시험으로 대체하지 않았다. 아래 시간·호출 수는 과거 기록이며 이번에는 모델을 호출하지 않았다.

| 평가 PR / head | 알려진 정답·근거 | 유효 지적 | 오탐 | 알려진 문제 누락 | 중복/스타일 잡음 | 미검토 범위 | 시간/호출량 |
|---|---|---|---|---|---|---|---|
| smoke #11 / 77b9d48 | err.message가 HTTP/로그로 노출, echo가 HTML 무이스케이프 | 2 P1 | 0 | 알려진 2개 중 0 | 0 | 파일2, 제외0 | 약23초/1회(기록) |
| smoke #12 / 78d551b | 거절 요청도 시각 갱신, Map 무한 증가. 고정 ref 원문 직접 확인 | 결함2 P2 + 시험공백1 P3 | 알려진 두 결함에서는 0 | 알려진 2개 중 0 | 시험공백은 결함과 별도 | 파일2 | 1회(기록) |
| smoke #12 / 4531dfc, main base | 수정 후 코드; 사전 정답 없음 | 3건 관측, 정확도 합산 제외 | 독립 확정 안 함 | 산정 불가 | 사전 기준 없음 | 파일2 | 1회; 앞 세대 미게시1(기록) |
| smoke #12 / 4531dfc, 옛 base | 비교 기준 바뀌며 slow.test 삭제 포함 | 3건 관측, 합산 제외 | 독립 확정 안 함 | 산정 불가 | 사전 기준 없음 | 파일3 | 1회(기록) |
| smoke #13 / 85ba189 | 합성 키 문자열이 든 결과 | restricted, 게시0 | 해당 없음 | 산정 불가 | 해당 없음 | 모델 결과 전체 비공개 | 1회(기록) |
| smoke #14 / 7e3c3ca | 바이너리 제외는 결함이 아님 | 0 | 1 | 알려진 문제 없음 | 0 | partial, 확인1/제외1 | 1회(기록) |
| smoke #14 / 01c3fbf | 같은 입력, 제외 메타데이터 전달 수정 후 | 0 | 해당 오탐0 | 알려진 문제 없음 | 질문3은 결함 수와 분리 | partial, binary 제외 명시 | 1회(기록) |
| smoke #12 / aa11c60 | 같은 변경 재검토; 새로운 독립 정답 아님 | 3건 관측, 합산 제외 | 독립 확정 안 함 | 산정 불가 | 사전 기준 없음 | 파일3 | 1회(기록) |
| smoke #16 / c637d98 | 고정 Bun 버전 갱신(기록의 정상 사례) | 0 | 0 관측 | 알려진 문제 없음, 미지 오류 산정 불가 | 0 | 파일4 | 1회(기록) |

게시된 리뷰 8건과 공개 차단 1건이다. 과거 오탐 1건을 고친 재시험을 별도 표본의 일반 정확도로 합치지 않는다. 모델의 “pass/지적 없음”은 기능 안전 증거가 아니며, 실제 파일·시험·권한 거부와 함께만 사용한다.
