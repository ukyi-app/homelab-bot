# V1_TRACE — T21-audit-4

판정 **READY_FOR_SCOPED_PILOT**, A09 **fixed**, DATA-02 **pass**. 봇 `772599fa7addece6b8d45ec219e7fae1cdcf57f0`, homelab `6c2939e994d1e5be0e1bdd2d5db5940f79185682`, ops `b8bca5c4dd9d4df17a79117c4d87c28c1dc2e5f0` 기준이다. 2026-11-09 독립 좁은 재감사이며 사용자·운영 수용 선언은 아니다.

**4회차 갱신 범위:** DATA-02·F04·R13·E2E4와 R17의 DATA-02 참조 문구. 나머지 행·품질 분석·외부 증거는 3회차 문서에 실린 **2회차 기준 그대로 유지**한다. 그 행의 “현재/이번”, L·S·H·T30·G·V와 `evidence/…`는 ops evidence/release-audit-2/다. 과거 증거를 새 리비전에서 실행한 것으로 바꾸지 않는다.

**N4:** ops evidence/release-audit-4/의 build.meta.json, focused.log, full.log, session-cleanup-race.json, observations-pg/pglite.json, lifecycle-pg/pglite.json, late-failure-pg.json, locking-review.md. 관련 **159/159**, Node24 전체 **2147/2125 pass/0 fail/22 skip/0 cancelled**, 205469.905215ms. 독립13시나리오는 단위시험과 합산하지 않는다. Node26 오실행 전체2147/2124pass/1fail/22skip은 full-node26.log에 별도 보존하며 유일한 실패는 런타임 버전 검사다. PGlite 최초 cwd 오류는 시험 시작 전 실패로 분리했다.

**4회차 집계:** 수용30 = **30 pass / fail0 / blocked0 / not_run0 / not_applicable0**. 요구27 = **27 pass / fail0**. E2E5 = **5 pass / fail0**. ID 수준 pass에 포함된 기존 not_run 하위 사례와 SEC-02 대체 증거 범위를 유지한다. 새 운영 관찰 요청0. 운영 현재 접근·이미지·별도 SEC-02는 이번 범위 밖이다.

## 3회차 실행 기록 (3회차 기준, 보존)

다음 N3와 집계는 ops evidence/release-audit-3/의 역사적 결과이며 현재 판정은 위 N4다.

**N3:** evidence/build.meta·focused.log·full.log, observations-pglite.json·observations-pg.json, session-cleanup-race.json, locking-review.md, ci-env-race.json. 지정 **83/83**, 전체 **2,143 / pass2,121 / fail0 / skip22 / cancelled0**, 전체1회. 원래 A09 버그 assert2개는 기대대로 exit1. 관찰 사본에서 gen2 종료0ms 보존·gen3 재개·새 종료+7일 cutoff 확인. 추가 PG 반례는 재검사 뒤 cleanup pending 커밋→삭제1·next 거부다. 전체 fail0이 이 독립 반례를 통과했다는 뜻은 아니다. CI env.json 경합은 시험 보조 코드 결함이며 이번 전체 자연 재발0회다.

**3회차 집계:** 수용30 = **29 pass / 1 fail(DATA-02) / blocked0 / not_run0 / not_applicable0**. 요구27 = **25 pass / 2 fail(F04·R13)**. E2E5 = **4 pass / 1 fail(흐름4)**. 과거 ID 수준 pass의 not_run 하위 사례는 그대로다. 새 운영 관찰 요청0, 감사 이미지·별도 SEC-02·운영 현재 접근은 범위 밖이다.

## 증거와 집계 (2회차 기준)

- **모든 현재 로컬 시험/구현 위치는 9da65f5 기준**이다. 표의 실행 리비전 열은 과거 실연동을 별도로 표시한다. 운영 이미지를 현재 소스로 재실행한 것으로 바꾸지 않는다.
- **L**: evidence/full.log·full.meta, npm-ci/check/build 로그. `L: name`은 현재 실행한 `test/name.test.ts`. mock 포트와 실제 로컬 DB/코드의 등급을 구분한다.
- **S1/S2**: evidence/change-sec02.log·sec02-boundary.log 및 meta, 새 감사 이미지. 10/10·24/24, skip0. 실제 고정 CLI/Bun이지만 합성 자격·가짜 모델 API, local seccomp/AppArmor unconfined다.
- **H**: evidence/historical-records.json. 첫 감사가 직접 읽은 원본 5개와 ops HANDOFF 7개의 현재 SHA-256을 다시 계산해 모두 일치 확인. 기존 외부 시험을 재실행하지 않았으며 현재 회귀·변경 diff와 함께 유지한다. ops 자료는 공개 문서에서 파일명으로만 가리킨다.
- **T30**: ops evidence/t30/INT-01~07.md, 결과 JSON, README·EQUIVALENCE. evidence/t30-records.json·t30-deployment-summary.json에 원본 해시·집계. 승인·동등성의 구체적 차이는 V1_RELEASE_REPORT의 T30 표가 기준이다.
- **G**: evidence/github-pr-records.json, 이번 GitHub GET으로 공개 PR 상태·review commit/state·tree/parent 대조. **V:**는 현재 docs/ai-bot/VERIFICATION.md의 행이다.
- 독립 재현은 evidence/audit-probes.json(A01~03), bwrap-probe.json(A04), format-probe.json(A05), retry-probe.json(A06), unknown-probe.json(A07), registration-probe.json(A08), retention-race-probe.json·retention-race-pg-probe.json(A09)이다.

전체 시험 **2,136 / pass 2,114 / fail 0 / skipped 22 / cancelled 0**, 206,272ms. npm ci·check·build 통과. SEC-02 별도 34개와 전체를 단순 합산하지 않는다. 알려진 세 간헐 실패가 없어서 재시도하지 않았다.

수용 시험 **pass 29 / fail 1 / blocked 0 / not_run 0 / not_applicable 0**. 전체 시험의 fail0은 추가 독립 A09 반례까지 통과했다는 뜻이 아니다. A09 probe의 exit0은 결함 발생을 assert했다는 뜻이다. ID 수준 pass와 행 안 not_run 하위 사례를 구분한다. approved_operational_execution 증거는 이번 V1 감사에 없다.

## 수용 시험 30개

| ID | 판정값 | 증거 등급 | 과거 실행 리비전·현재 보충 | 증거 위치 | 잡는 실패 | 재확인/유지·놓치는 범위 |
|---|---|---|---|---|---|---|
| AUTH-01 | pass | local_integration; authorized_external | T16b 2d5ad21/097c93e; T17 10f5da4~d77944e | L: foundation, publisher-policy, pr-review, external-task-receiver; H: foundation-deploy·pr-review | owner/guild/channel/설치/저장소/작성자/fork·서명 거부 | 현재 회귀 재실행; 과거 허용 밖 채널·fork 거부 기록 유지. 운영 두 번째 계정 부정 시험은 not_run. |
| AUTH-02 | pass | local_integration; authorized_external | T16b 2d5ad21; T20 55555b3; 현재 A02 | L: publisher-policy, task-bridge, memory-briefing; audit-probes.json; src/store.ts:546 | revoke 커밋이 dispatch보다 앞서면 REST0·blocked; 질문/기억/예약 재인가 | 1회차 fail 해소. dispatch 후 철회는 이미 시작한 전송을 취소하지 못함; ACK·typing 최종 조회를 네트워크 호출과 원자적이라고 주장하지 않음. |
| EVENT-01 | pass | local_integration; authorized_external | T17 7a4dfe6~d77944e; T30 a25876b | L: foundation, publisher-pg, pr-review, task-lane-pg, external-task-pg; H·T30 INT-03 | inbox·의미 키·세대·동시 질문·GitHub 재전송·R08 duplicate 흡수 | 현재 전체 PG 회귀 재실행. 실제 Discord Gateway RESUME 중복 주입은 not_run. R08 duplicate를 Gateway 중복으로 대체하지 않음. |
| EVENT-02 | pass | local_integration; authorized_external; mock | T30 a25876b(630c48d와 코드 동일) | L: review-3/4, github-writer, change-recovery, change-pg; T30 INT-02 result·EQUIVALENCE | 실제 Discord/PR 성공 후 local confirm 전 SIGKILL·동일 DB 재시작, 18/18·기존 효과 대조 | 1회차 blocked 해소. 선행 receipt/승인 fixture·draft PR·REST-only·localPG. wire 유실/운영 프로세스 전체 kill은 not_run. A/B는 같은 메시지 페이지. |
| EVENT-03 | pass | local_integration; authorized_external | T16b 097c93e; T17 10f5da4 | L: publisher-recovery, pr-review; H: foundation-deploy·pr-review | history backfill·gap·커서·15분 PR 재조정 | 현재 회귀와 기존 원본 해시 재확인. 과거14분 차단 뒤41초 복구; 무제한 과거 복구 아님. |
| EVENT-04 | pass | local_integration; authorized_external | T16b 2d5ad21; T18 88b37c4; T30 a25876b | L: unknown-probe, stop-confirmation, publisher-shutdown, task-lane-pg; H; INT-02 | lease·단절 unknown과 종료확인 failed 구분, 자동 재실행 방지 | 현재 회귀+실제 격리 publisher SIGKILL 대조. 작업자 운영 OOM은 not_run. A07의 51행 도달성 미확인 별도. |
| CHAT-01 | pass | local_integration; authorized_external | T16b 097c93e | L: chat-context, typing-debounce, read-lane, task-assembly; H | 후속 맥락·debounce·대화/작업 별도 레인 | 현재 T31 purged 맥락 제외까지 재실행. 과거 실모델 상호작용 증거 유지, 일반 품질·장기 부하 보장 아님. |
| CHAT-02 | pass | local_integration; authorized_external | T16b 2d5ad21/097c93e | L: foundation, chat-context, publisher-recovery; H | stop/resume·비활성 수집 차단·세션 정합 | 현재 회귀 재실행. Discord 외부 권한·보관 상태 변경의 모든 순서는 미실측. |
| READ-01 | pass | local_integration; authorized_external | T16b 097c93e; T24 12a09c3 | L: publisher-read, read-lane, briefing-observations; H; V:746·822 | 등록/미등록/관측 불가·오래됨, 사실/가설/미확인 분리 | 현재 코드·회귀 재확인, 기존 실측 유지. 로그는 줄 수만 공개하며 원문을 전부 읽었다고 말하지 않음. |
| READ-02 | pass | local_integration; authorized_external | T16b 2d5ad21/097c93e; homelab c1c0e5b 선언 | L: foundation, publisher-read, publisher-config; homelab platform/bot-slot/templates/rbac.yaml; H | 고정 질의·자원/시간/바이트 상한, Secret/ConfigMap/exec 차단 | 현재 선언과 로컬 거부 재확인. 읽기 자격 자체의 넓은 범위·publisher 침해는 별도 위험. 실제 Secret 값 접근 시험 없음. |
| SEC-01 | pass | mock; local_integration; authorized_external | T16b 097c93e; T17 10f5da4~d77944e | L: foundation, review-lane, pr-review, memory-briefing, change-review; H | PR/AGENTS/로그 지시는 비신뢰 자료·도구/정책 변경 거부 | 현재 MemoryService 호출 경로 재검색: 자동 기억→모델 없음, 그 하위 사례만 not_applicable. 모델 보편적 인젝션 저항성 보장 아님. |
| SEC-02 | pass | local_integration; authorized_external | 현재 감사 이미지 9da65f5; 운영 직접 exec 5fb4a20·d4c8bda | S1/S2; L: task-settings-boundary, task-process-containment; H; T30 INT-01; approvals 18:11 KST | 고정 CLI/Bun·파일/소켓/프로세스/네트워크 경계, 양성·음성 대조, 64/64·83pass 과거 직접exec | 1회차 blocked를 명시적 V1 대체 증거 수용 결정에 따라 해소. full signed TaskLane·악성 실모델·실자격 직접Read는 여전히 not_run. local unconfined≠운영 Localhost. |
| DATA-01 | pass | local_integration; mock; authorized_external | 현재 A01; T30 a25876b/작업자630c48d; T17 7a4dfe6 | L: task-output, change-data, change-publication, pr-review; audit-probes.json; T30 INT-07 | task 질문·완료 요약 공개 검사, 정책 부재 닫힘, 실제 합성 출력 marker 미게시 | 1회차 fail 해소. 실제 비밀 유출 사고나 임의 인코딩 DLP 입증 아님. 스캐너의 prefix 대소문자/비ASCII 변형 한계 명시. |
| DATA-02 | pass | local_integration; authorized_external(기억/PITR 기존) | **4회차 772599f**; 기억 T20 55555b3·dab3de1의 2회차 판단 유지 | N4: raw-input/raw-text/change-purge-race 및 PG; observations-pg/pglite.json; session-cleanup-race.json; lifecycle-pg/pglite.json; late-failure-pg.json; 기존 H | 원래 gen2 재종료 삭제0·gen3 성공·7일 cutoff. completed/none/retained 및 pending 보존, 실제 cleanup 뒤 cutoff 삭제·멱등 | **A09 fixed**. 세션 두 순서 후보0/삭제0·next 성공. after_recheck hook은 후보 제외로 미도달. worker/시계는 합성, 실제 cleanup API·SQL만 실행. 원격 공간·운영 빈도 미관측. |
| REVIEW-01 | pass | local_integration; authorized_external | T17 10f5da4→7a4dfe6→d77944e | L: pr-review, review-lane; H; G; 아래 기존 품질 평가 | 고정 PR head의 유효 지적·오탐·부분 검토 평가 | 현재 회귀와 공개PR 상태/SHA GET 대조, 과거 품질 분석 유지. 새 모델 평가0. 작은 표본·사전 정답 없는 사례는 정확도 합산 제외. |
| REVIEW-02 | pass | local_integration; authorized_external | T17 10f5da4~d77944e | L: pr-review, review-1/2; H; G | head/base retarget·선병합 superseded와 검토SHA 표시 | 현재 회귀 재실행. 마지막GET/POST 사이 원격 경쟁 잔존. 기본 base이동 재리뷰 off는 기존 결정. |
| REVIEW-03 | pass | local_integration; authorized_external | T17 7a4dfe6; PR14 01c3fbf | L: pr-review, review-diff-peak, review-lane; H; G | 큰/잘린 diff·binary·submodule/열거 누락 partial 표시 | 현재 상한 회귀 재실행, 과거 binary 실례 유지. 운영 전체 모델 최대RSS 실측 아님. |
| REVIEW-04 | pass | local_integration; authorized_external | T17 10f5da4~d77944e; T30 PR22 | L: pr-review, github-review-app; src/review.ts:133; H; G | COMMENT만·commit_id 고정, approve/request_changes/merge 거부 | 현재 제한 코드 재확인·회귀 재실행. App PR-write 권한 자체는 approve를 막지 않으므로 코드 경계가 필수. |
| REVIEW-05 | pass | local_integration; authorized_external | T17 d77944e; PR16 c637d98 | L: pr-review, publisher-review; H; G | Bot댓글 무시·허용 봇 작성자·중복 세대 차단, 실제 Renovate PR 리뷰 | 현재 회귀 재실행. 운영 Bot댓글 부정 사례 not_run. PR16 현재 head를 과거 평가head로 바꾸지 않음. |
| TASK-01 | pass | local_integration; authorized_external | T18 88b37c4/c39b074; T30 a25876b, 실제 Codex0.166.0 | L: task-assembly, external-task-assembly/helper/pg; T30 INT-03·fence-result | 명시 연결·실제 notify·서명·소유자·능력 표시·duplicate·detach, 로컬 restore fence11/11 | 1회차 blocked 해소. R08은 읽기 전용 알림. 수동 sender once이며 LaunchAgent·30일·다른 member·집밖·절전·운영PITR는 not_run. |
| TASK-02 | pass | local_integration; authorized_external | T18 88b37c4; T30 task630c48d | L: task-bridge, task-lane-pg, codex-bridge; H; T30 INT-04 A | 질문ID/소유자/기한/중복·동일세션 resume, 실제 두 턴 | 현재 회귀 재실행, DATA-01 질문 스캔도 수정확인. 운영 타인/늦은답 부정 사례는 로컬 증거만. |
| TASK-03 | pass | local_integration; authorized_external | T18 88b37c4·2ed8485 | L: task-stream, task-cancel-notice, task-process-containment, codex-bridge; H | idle·완료문구 불신·실제 종료확인, 취소 stopped true·unknown 유지 | 현재 회귀 재실행. 수정된 취소 안내 운영 재관측은 없음. R08 완료는 외부 보고이며 봇이 실행종료를 증명하는 능력 아님. |
| CHANGE-01 | pass | local_integration; authorized_external | T30 publisher2c77813(코드630c48d), task630c48d, reviewd4c8bda | L: change-assembly/pg/verification/review; T30 INT-04 A; G PR22 | 질문→답→실제검증→독립리뷰→digest 승인→PR, tree/parent 일치 | 1회차 blocked 해소. 고정 smoke 한 건, non-draft·미병합닫음. 모델 리뷰 경고2건 보존. A05 사용성·A09 장기 재개수명은 별도 추적. |
| CHANGE-02 | pass | local_integration; authorized_external | T30 publisher a25876b(코드630c48d); 실제 writer | L: github-writer, change-policy/publication/pg; T30 INT-05; H; G PR19 | main/보호경로/merge/dispatch/force 코드거부, 실제 merge405·workflow push GH013·main불변 | 1회차 blocked 해소. workflow는 권한 부족, merge는 ruleset이 막음. 일반ref201 양성 대조와 함께 판정. 모든 설치대상으로 확대하지 않음. |
| CHANGE-03 | pass | local_integration; authorized_external; mock | T30 a25876b(코드630c48d) | L: change-freshness/recovery/pg, github-writer; T30 INT-04 BCD·EQUIVALENCE | 실제 base이동 superseded·새세대/새digest·옛승인거부·기존ref 충돌 차단25/25 | 1회차 blocked 해소. receipt는fixture·Discord없음·publisherPOST금지guard. D는 writer신원으로 만든 사람선택내용, 승인전ref 충돌. gate후 실제경쟁은 로컬만. |
| DEPLOY-01 | pass | mock; authorized_external; production_observation | T30 a25876b(코드630c48d); 현재 reader 변경없음 | L: change-deployment, change-assembly; T30 INT-06·driver·JSON; G | H/M/K/digest·config_stale2·sync_running·pod_unready9·observed·제거blocked 구분 | 1회차 blocked 해소. 실제 reader, 수동mapping·kubectlGET·10초driver. 운영60초loop/Discord·비교stale단독·aggregateunready는 미실시. 현재 smoke앱 없음. |
| MEM-01 | pass | local_integration; authorized_external | T20 55555b3 | L: memory-briefing, memory-commands(-pg); H | 출처/ACL/시각·충돌·candidate/active·정책불변 | 현재 코드/회귀 재확인, 기존 실연동 기록 유지. 모델 자동기억주입 없음. |
| BRIEF-01 | pass | local_integration; authorized_external; production_observation | T20 55555b3; T24 12a09c3; task칸 c439cee | L: memory-briefing, briefing-observations/task-lane, t20-startup-pg; H | 08:50 Asia/Seoul·회차멱등·재시작·원장장벽·미조회/오래됨·모델비의존 | 현재 회귀 재실행, T24/T18칸 확인. 현재 운영상태 재관측 없음. A02 수정으로 공통 발송철회 차단 회복. |
| OPS-01 | pass | local_integration; authorized_external | T16b 2d5ad21/097c93e; T17 d77944e; T18 88b37c4 | L: typing-debounce, read-lane-pg, worker-server, task-lane-pg, review-diff-peak; H | 큐/레인/시간/도구/바이트 상한·취소·한도·대화ACK | 현재 상한 회귀 재실행. 실연동은 사용자승인 10PR+10알림, 원래30+30 아님. 최악혼합·장기비용/자원 미측정. |
| OPS-02 | pass | local_integration; authorized_external | T16b 2d5ad21/097c93e; T13 2026-10-29 | L: foundation, publisher-main, ops-metrics; H; homelab approvals | replicas0 Telegram·봇독립경보, NUC 종료 외부healthchecks down/up | 현재 선언/회귀와 승인기록 재확인. 정상종료+RTC복귀15분이며 갑작스러운정전 복원 증거 아님. 수신은 승인된 사용자 폰 기록. |

## F01~F09·R01~R18 구현 추적

27개 중 F04·R13의 위치·근거를 772599f로 갱신하고 R17의 DATA-02 참조만 맞췄다. 나머지는 2회차 소스 대조와 판정을 유지한다. **pass27 / fail0**. 새 근거는 N4, 그 밖의 위치 매핑은 2회차 evidence/source-map.json이다.

| ID | 상태 | 구현 파일·행(기본 2회차; F04/R13은 772599f) | 시험 ID | 현재 근거·제약 |
|---|---|---|---|---|
| F01 | pass | src/policy.ts:78; src/discord.ts:484; src/review.ts:89; src/change-policy.ts:119; src/store.ts:546 | AUTH-01, AUTH-02 | 현재 dispatch 철회 CAS까지 확인. A02 fixed. |
| F02 | pass | src/store.ts:77; src/store.ts:282; src/discord.ts:552; src/review.ts:899; src/change-publisher.ts:57 | EVENT-01~04 | 현재 inbox/outbox·의미 키·대조 회귀와 INT-02 실제 local-confirm 유실 복구. A07 운영 도달성 미확인 별도. |
| F03 | pass | src/review-input.ts:33; src/run-control.ts:42; src/executor-claude-task.ts:302; src/task-containment.ts:60; src/change-verifier.ts:43 | SEC-01, SEC-02, READ-02 | 현재 고정 CLI 경계·INT-01 명시적 대체증거 수용. 전체 signed 악성 경로 not_run을 유지. |
| F04 | pass | src/memory.ts:189; src/memory.ts:279; src/task-output.ts:24; src/raw-text-retention.ts:88; **src/change-store.ts:766; src/change-store.ts:773; src/change-store.ts:792; src/claude-task-bridge.ts:627; src/claude-task-bridge.ts:896** | DATA-01, DATA-02, AUTH-02 | **4회차:** 기존 공개검사·기억삭제 판단 유지. N4에서 새 세대·retained/pending 보존 및 실제 cleanup 뒤 cutoff 삭제 확인. A09 fixed. |
| F05 | pass | src/store.ts:134; src/store.ts:267; src/store.ts:780; src/worker.ts:94; src/run-control.ts:129 | OPS-01, TASK-03 | 직렬 레인·상한·우선순위·비상 중단, 실제 승인 부하10+10. A08 비용 개선 별도. |
| F06 | pass | src/contracts.ts:8; src/store.ts:397; src/store.ts:565; src/health.ts:6; src/change-verifier.ts:114 | EVENT-04, OPS-02, CHANGE-01 | 상태 분리와 시작 표식으로 준비 실패 분류 A04 fixed. unknown 시간만으로 성공/실패 확정하지 않음. |
| F07 | pass | src/briefing.ts:143; src/main.ts:336; src/main.ts:353; src/deletion-ledger.ts:110 | BRIEF-01, DATA-02, EVENT-03, OPS-02 | 영속 예약·원장 기동 장벽·기억 PITR 유지, R08 restore fence는 로컬PG11/11. |
| F08 | pass | src/change-contracts.ts:144; src/change-artifact.ts:121; src/change-review.ts:356; src/review.ts:156 | REVIEW-01~03, CHANGE-01, CHANGE-03 | SHA/tree/receipt/정책 바인딩 현재 회귀와 T30 실제PR22 대조. 모델 verdict를 정답으로 세지 않음. |
| F09 | pass | src/worker.ts:55; src/review.ts:133; src/github-writer.ts:37; src/github-writer.ts:176; src/discord.ts:509 | DATA-01, AUTH-02, REVIEW-04, CHANGE-02 | task 출력검사·Discord dispatch·COMMENT·writer route/최종효과 제한 재확인, 실제 writer 거부. |
| R01 | pass | src/discord.ts:79; src/store.ts:67; src/store.ts:685; src/chat-context.ts:14 | CHAT-01, CHAT-02, AUTH-02 | 구독/후속/중지·철회 dispatch·purged 맥락 제외 현재 회귀. |
| R02 | pass | src/discord.ts:79; src/activity.ts:21; src/typing.ts:32; src/store.ts:101 | CHAT-01, OPS-01 | ACK·typing·debounce·urgent 분리, A08 재등록 개선 후보. |
| R03 | pass | src/runtime.ts:42; src/runtime.ts:54; src/store.ts:645; src/claude-task-bridge.ts:108 | CHAT-02, TASK-03, EVENT-04 | 대화/작업 분리·소멸 확인, A06 불가능한 retry 안내 fixed. |
| R04 | pass | src/catalog.ts:9; src/read.ts:33 | READ-01 | 카탈로그·미등록/관측불가 구분, 현재 회귀와 과거 실제읽기. |
| R05 | pass | src/read.ts:55; src/read-transports.ts:57; src/read-transports.ts:151 | READ-02 | 엄격입력·고정질의·투영·허용리소스·RBAC 선언 재대조. |
| R06 | pass | src/read.ts:24; src/chat-format.ts:9; src/chat-context.ts:14 | READ-01 | 사실/가설/미확인·관측시각, 오래된 정상을 현재증거로 쓰지 않음. |
| R07 | pass | src/alerts.ts:14; src/briefing-observations.ts:266 | READ-01, OPS-02, BRIEF-01 | 고정경보·사건스레드·백업/인증서/작업 메타데이터, T24칸 포함. |
| R08 | pass | src/external-task-links.ts:80; src/external-task-receiver.ts:179; src/external-task-commands.ts:51 | TASK-01 | INT-03 실제 Codex notify·duplicate·detach. 읽기전용 알림, 운영restore/30일/다른기기는 미실시. |
| R09 | pass | src/task-bridge.ts:102; src/task-bridge.ts:151; src/claude-task-bridge.ts:503; src/claude-task-bridge.ts:530; src/task-output.ts:24 | TASK-02, TASK-03, DATA-01 | 질문바인딩·실제종료·task 출력검사 현재회귀, T30 두턴실연동. |
| R10 | pass | src/task-worker.ts:194; src/task-workspace.ts:275; src/executor-claude-task.ts:351; src/task-containment.ts:60 | TASK-01, SEC-02 | 작업공간·별도파드·자격/PID경계, SEC-02는 INT-01 수용범위에 한정. |
| R11 | pass | src/review.ts:323; src/review.ts:467; src/review.ts:786; src/github-review-io.ts:88 | AUTH-01, REVIEW-01, REVIEW-04, REVIEW-05 | 전용App·COMMENT·고정요약·허용작성자. 자동병합/필수gate 아님. |
| R12 | pass | src/review.ts:156; src/review-input.ts:345; src/review.ts:957 | EVENT-01, REVIEW-02, REVIEW-03 | head/comparison/policy 세대·partial·누락재조정, 현재회귀 및 과거실측 유지. |
| R13 | pass | src/change-runtime.ts:150; src/change-runtime.ts:533; src/change-publisher.ts:57; src/change-policy.ts:155; src/github-writer.ts:125; **src/change-store.ts:234; src/change-store.ts:773; src/change-store.ts:792; src/claude-task-bridge.ts:896** | CHANGE-01~03, DATA-02 | **4회차:** 정상작성/검증/게시·T30 실제경쟁/거부는 2회차 pass 유지. N4 원문/증거 수명·세션 보존 및 next 재개 통과, A09 fixed. |
| R14 | pass | src/change-review.ts:356; src/change-review.ts:445; src/change-review.ts:681; src/review-lane.ts:87 | CHANGE-01, CHANGE-03 | 별도리뷰세션·실제diff/기준/receipt 바인딩, INT-04 A 실모델 검토. 모델무결성 보장 아님. |
| R15 | pass | src/change-deployment.ts:78; src/change-deployment.ts:189; src/change-deployment.ts:240 | DEPLOY-01 | H/M/K/digest·stale/unready·기능시험 분리. INT-06 실제reader, 현재 smoke미등록. |
| R16 | pass | src/memory.ts:142; src/memory.ts:189; src/memory.ts:393; src/document-source.ts:32 | MEM-01 | 출처·시각·범위·ACL 저장검색. 자동 모델주입 없음. |
| R17 | pass | src/memory.ts:150; src/memory.ts:174; src/memory.ts:230; src/memory.ts:279; src/deletion-ledger.ts:110 | MEM-01, DATA-02, AUTH-02 | 기억 접근/정정/삭제/복원은 2회차 pass 유지. T31 일반원문 경합은 F04/R13·DATA-02에서 4회차 pass로 갱신. 기억 코드·외부 PITR 재검증을 새로 했다는 뜻이 아님. |
| R18 | pass | src/briefing.ts:66; src/briefing.ts:203; src/briefing.ts:254; src/briefing.ts:403 | BRIEF-01 | 예약·회차멱등·미확인·재시작, T24/T18칸과 철회발송 회귀 확인. |

## `01` §9 end-to-end 5개

| 흐름 | 상태 | 실행 리비전·등급 | 증거 | 놓치는 범위 |
|---|---|---|---|---|
| 1 Discord→상태·근거→구독/세션·맥락 | pass | 현재 local_integration; T16b097c93e authorized_external | L foundation/chat-context/read-lane/publisher-recovery + H 실제조회·stop/resume + A02 수정 | 운영 현재재실행 없음. dispatch 뒤 이미시작된 전송 회수 보장 없음 |
| 2 PR→최신리뷰→COMMENT→Discord | pass | 현재 local_integration; T17 authorized_external | L publisher-review/pr-review + H·G 고정head/COMMENT, T30 PR22 리뷰 | 일반정확도·병합전리뷰완료 보증 아님 |
| 3 소유/명시연결작업→질문·답→산출물·전달 | pass | 현재 local_integration; T18·T30 authorized_external | A01수정, 실제두턴작업·Codex notify·서명알림·detach | R08은 알림뿐, 질문/실행제어 없음. SEC-02 전체운영조립 미실시는 명시적수용 범위 |
| 4 수정→격리시험·독립검토→PR→배포읽기 | pass | **4회차 772599f local_integration**; T19·T30 외부 증거는 2회차 유지 | N4 새세대 수명·retained/pending 세션 보존·정리 전 next 성공·실제 cleanup 뒤 cutoff 삭제 확인. 정상 PR18/PR22·INT04~06은 2회차 pass 그대로 | 과거 실연동은 한 요청의 연속 전과정을 이번에 새로 실행한 증거가 아님. owner/허용채널/smoke 제한, 현재 smoke앱 없음. 운영 파일 정리·발생 빈도 미측정 |
| 5 결정저장→출처검색·정정·삭제→브리핑→재시작 | pass | 현재 local_integration; T20 55555b3/T24 12a09c3 authorized_external | L startup/ledger/briefing + H 실제PITR 원장entries1/applied1·검색부재·회차보존 | 외부사본회수/SSD동시유실 보장없음. 일반원문 A09는 흐름4와 DATA-02로 분리 |

## 리뷰 품질: 1회차 독립 분석을 유지한 범위

이번에는 모델 평가를 추가하지 않았다. 첫 감사가 고정 head의 코드·리뷰를 직접 대조한 아래 분석을 유지한다. 이번 GitHub GET은 PR 상태·리뷰 commit/state·tree/parent를 재확인했고 해당 기존 증거의 해시를 대조했다. 과거 head의 본문 전체를 이번에 새로 재평가했다고 주장하지 않는다. 현재 PR16 head는 7d2cef7이며 아래 c637d98과 구분한다.

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
