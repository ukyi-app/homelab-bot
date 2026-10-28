# VERIFICATION: 봇 V1 능력표 (요약)

- 현재 단계: `TARGET=V1`, `STAGE=FOUNDATION`, `MODE=build` (T16a), 갱신 2026-10-19. **로컬 검증, 실연동 대기**다.
- 아래 DISCOVERY 능력표는 2026-10-18 기록이다. T16a의 실행 결과는 끝의 FOUNDATION 표가 기준이다. T16a에서는 외부 모델·Discord·GitHub·플랫폼을 호출하지 않았다.
- 시험 판정값은 `04` §3을 따른다. **외부 권한이 없거나 플랫폼이 아직 없어 못 한 필수 항목은 `blocked`이고, 사유와 해소 시점을 적는다.** 규칙상 실행하지 않은 것은 `not_run`이다.
- 꼬리표와 세부 근거는 [DISCOVERY.md](DISCOVERY.md). 내부 식별자와 명령 원문은 private 운영 저장소의 evidence에 있다.
- 마지막 열의 판정은 확정 결정(D-14~D-17·D-24, 사용자 2026-10-18, T15)을 따른다([DECISIONS.md](DECISIONS.md)). R08(명시적 Codex 연결)에 걸린 부분은 보류(T18)다. 실연동은 아직 하지 않았으므로 "채택"은 설계 선택이지 시험 통과가 아니다.

## 검증표

| 기능 | 공식 명세·확인일 | 실제 버전·시험 결과 | 제한 | 채택 / 대체 / 보류 |
|---|---|---|---|---|
| **Codex 작업 시작·결과 수집** | `codex exec`는 Stable, 스크립트·CI용. `--json` JSONL(`thread.started`·`turn.started`·`turn.completed`·`turn.failed`·`item.*`·`error`), `-o`, `--output-schema`, 기본 read-only 샌드박스, Git 저장소 필요. https://learn.chatgpt.com/docs/non-interactive-mode , https://learn.chatgpt.com/docs/developer-commands?surface=cli (2026-10-18). 옛 `developers.openai.com/codex/*`는 308 이동 | codex-cli 0.163.0, x86_64 Linux [실측: `--version`]. `exec --help`로 플래그 확인 [실측]. 실제 작업 실행 `not_run`(모델 호출 금지 규칙). 작업자 파드 실행 `blocked`(사유: sandbox 미구축. 해소: T08b, T16b 시작 때 재확인) | `turn.failed`·`error` 필드 미문서. 파드 안 bwrap 동작, `HTTPS_PROXY` 준수 [미확인]. 기본 환경 상속이 `KEY`·`TOKEN` 변수를 모델 명령에 넘김 → `shell_environment_policy` 고정 필수. D-14 A라 작업자의 모델 호출은 `auth.json` 하나로 직렬 1개 | **채택: (A) `codex exec --json`을 작업자 파드에서 직접.** 작업 공간은 `codeload.github.com` 압축본 + `git init`(D-15). 대체: (C) `codex app-server`(실험). 버전 고정 + JSONL fixture 계약 시험 |
| **질문·승인 요청·취소·재개** | exec: 승인 정책 플래그 없음, 취소 서술 없음, `exec resume <id>`. app-server: `turn/interrupt`, `item/commandExecution/requestApproval`·`item/fileChange/requestApproval`, `tool/requestUserInput`(실험), `thread/resume`, 그러나 "experimental and aren't supported for production workloads". https://learn.chatgpt.com/docs/app-server (2026-10-18) | `exec --help`에 `-a/--ask-for-approval` 없음, `exec resume --help`에 `-s`·`-C`·`--add-dir` 없음 [실측]. 실제 질문·취소·재개 `not_run` | 질문은 턴 종료 + `exec resume`으로만. 도구 승인 중계 불가. 작업이 끝날 때마다(정상·실패·시간 초과·취소) 작업 process group(또는 cgroup) 정리와 소멸 확인(pgid만으로는 부족), 확인 못 하면 `unknown`과 새 실행 차단 [가정](ARCHITECTURE §4). 재개는 같은 작업의 세션 파일이 남을 때만(`--ephemeral` 금지, 세션 저장 공간은 작업마다 나눔 [가정], ARCHITECTURE §5.1). 신호 처리·resume 상속 [미확인] | **채택: (A) 제한 모드**(clarification만, tool approval `capability=false`, 취소 = 작업 process group(또는 cgroup) 전체 종료 확인). **보류: (C)**, 어댑터 뒤 실험 후보, V2 재검토. (C)를 쓰면 봇은 decline·cancel만 보낸다 |
| **herdr의 프로젝트 작업 연동** | 상태는 화면 판독, `blocked` = 승인 또는 질문(구분 없음), 턴 추적 없음, 소켓 인증 미문서, 이벤트 비영속. https://herdr.dev/docs/cli-reference/ , herdr v0.9.5 태그의 socket-api·agents·integrations 문서 (2026-10-18) | herdr 0.9.5 [실측: `--version`]. 그룹 도움말만 실측. 사람 계정 서버 가동 중, 소켓 사용자 소유 0600 [실측] | 완료·질문 판정을 화면에 기댐(`01` §6 "idle로 완료 판정 금지"에 걸림). 사람 서버에 붙으면 개인 패널 전체 제어(`00` §6 호스트 소켓 금지). 파드 안 별도 herdr는 얻는 것이 없음 [가정] | **보류: 봇 경로에서 제외.** 사람의 개인 도구로만 유지. R08(명시적으로 연결한 기존 Codex 작업)의 연결 방식은 **보류(T18)**. herdr를 거치지 않는 방법을 T18에서 다시 판단한다. 개인 세션을 `capability=false`로 정한 것은 아니다 |
| **Discord 활성 스레드 후속 메시지** | Gateway intents(`MESSAGE_CONTENT` 없으면 내용 빈 값), 특권 intent 심사 기준(2026-06-10부터 고유 사용자 10,000명), threads, channel, message, receiving-and-responding(3초·15분), rate-limits(IDENTIFY 1000회/일). 모두 docs.discord.com (2026-10-18) | discord.js 14.27.0 + Bun 1.4.3: 모듈 로드, `Client`(intents 37377)·`REST`·`WebSocketManager` 생성만 성공 [실측, 통신 없음]. Gateway 연결·스레드 수신·재연결 `blocked`(사유: Discord 서버·봇 계정 없음. 해소: 사람 준비(D-17) 뒤 T16b) | 멘션 없는 후속 메시지 내용은 `MESSAGE_CONTENT` 필요. 2000자. 보관된 스레드는 명령 불가(메시지로 보관 해제). 비공개 스레드는 멤버여야 수신. Bun 재연결 크래시 이슈(#10840, not planned 종료) → 단절 시험 T16b 필수. IPv4 전용 443 egress로 연결되는지 [미확인] | **채택(D-17 확정):** Gateway + `MESSAGE_CONTENT` 켬 + 공개 스레드 + 매 이벤트 사용자·채널 검사. **대체:** intent를 쓸 수 없으면 명령/버튼 모드(R01대로 명시). 로컬·mock은 T16a, 실연동은 T16b |
| **GitHub App COMMENT 게시·토큰 범위** | 리뷰 `event` = APPROVE·REQUEST_CHANGES·COMMENT, 빈 값은 PENDING, 권한 Pull requests write(같은 권한으로 dismiss·PR 생성도 됨), `commit_id` 기본값은 최신 커밋. 설치 토큰은 `repositories`·`permissions`로 축소, 1시간 만료. webhook `X-Hub-Signature-256` 상수 시간 비교, 10초 응답, 자동 재전송 없음(수동 3일). docs.github.com (2026-10-18) | 전용 리뷰 App 없음 → 게시 시험 `blocked`(사유: App 생성·설치는 사람과 별도 승인. 해소: T10 시험 App, T17). 같은 API 모양의 게시를 Codex Connector 기록으로 실측(`COMMENTED` 리뷰 + 인라인 + 요약 댓글 제자리 수정) [실측]. 모델 호출 전 작성자 확인이 App PR을 막음(App PR은 `NONE`·`CONTRIBUTOR`) [실측]. webhook 경로 `blocked`(해소: T08a) | 게시 서버가 `event=COMMENT`와 허용 API만 통과, `commit_id`는 검토 SHA 명시. secondary rate limit. `issue_comment` 구독은 문서상 Issues read 필요 → 리뷰 App 권한에 Issues read를 둔다(설계 세부, DECISIONS D-16 "리뷰 App 권한"). App PR 리뷰에는 허용 봇 작성자 목록 필요(D-16 하위 결정) | **채택: 기본안**(D-16 확정(사용자 2026-10-18, T15)). 허용 봇 작성자 목록으로 Renovate·봇 PR 리뷰. 실연동 `blocked` |
| **변경 브랜치·PR 작성, 병합·디스패치 차단** | PR 생성 = Pull requests write. 병합·`POST /merges`·`repository_dispatch` = Contents write. `workflow_dispatch` = Actions write. 워크플로 파일 = Contents write + Workflows write. ruleset 생성·갱신 제한 + App bypass. App 토큰 PR은 CI 즉시 실행. docs.github.com (2026-10-18) | 봇 쓰기 신원 없음 → 시험 `blocked`(해소: T10 시험 App으로 시나리오 15, 실제 신원은 T19). 봇·`files`·템플릿 저장소의 `app-main` active(App bypass 없음, 새 push 때 승인 무효화) [실측]. homelab은 아직 옛 보호와 `allow_auto_merge=true` [실측] → T06·T10 | Contents write라 승인 뒤 병합 API와 `repository_dispatch`는 권한으로 못 막음 → 게시 서버 허용 목록 + `allow_auto_merge=false` + D-26 조건 (2). ruleset E는 App을 `bot/**`에 가두지 못함 → 게시 서버가 ref 고정. git push로 워크플로 파일 변경 거부 [미확인, E5]. 봇은 워크플로 변경 PR을 만들 수 없음(받아들인 범위 축소) | **채택: 봇 전용 쓰기 App**(D-24 확정(사용자 2026-10-18, T15)). 커밋·PR은 게시 서버가 만들고 작업자는 GitHub에 쓰지 않음(D-15). 토큰 분리·ruleset E·App 이름·설치 저장소는 T19. 실연동 `blocked` |
| **읽기 전용 홈랩 조회·민감 값 제외** | 설계 C.8 읽기 계정 셋(K8s SA: secrets·configmaps·pods/log·exec 없음, Argo CD: get만·logs 없음, Grafana: Viewer). Grafana Viewer는 데이터소스 질의 가능, 데이터소스 권한은 Enterprise·Cloud 기능 https://grafana.com/docs/grafana/latest/administration/roles-and-permissions/ . Argo CD는 Secret 값을 가림 https://argo-cd.readthedocs.io/en/stable/operator-manual/security/ (2026-10-18) | 새 클러스터 없음 → `blocked`(사유: 플랫폼 미구축. 해소: T08b, T13 뒤 T16b 시작 때 재확인) | Grafana 경로로 모든 파드 로그를 읽을 수 있어 `pods/log` 제외가 로그에 안 섬 [확인: https://grafana.com/docs/grafana/latest/administration/roles-and-permissions/ + 가정]. Argo CD `get`만으로 live ConfigMap이 보이는지 [미확인]. 봇 토큰 보관 위치가 설계에 없음 | **조건부 채택:** 로그 제외는 봇 어댑터의 사전 승인 질의 템플릿·시간창 상한·응답량 상한으로 강제하고 READ-02에 허용 밖 질의 거부를 넣는다. 시간창 상한은 보존 기간과 따로 T16a에서 정한다. 토큰은 `/apps/homelab-bot/` 키 이름으로. 더 강하게는 읽기 프록시(U12 대안) |

## 검증표 밖 행

| 기능 | 공식 명세·확인일 | 실제 버전·시험 결과 | 제한 | 채택 / 대체 / 보류 |
|---|---|---|---|---|
| **모델 인증 형태 (D-14)** | 자동화 기본은 API 키. 구독 인증 무인 실행은 "고급", 조건 다섯, 공개·오픈소스 저장소 금지 문구, `auth.json` 하나당 직렬 1개, 약 8일마다 갱신본 되쓰기. https://learn.chatgpt.com/docs/auth , https://learn.chatgpt.com/docs/auth/ci-cd-auth (2026-10-18) | `codex login`이 `--with-api-key`·`--with-access-token`·`--device-auth`를 받음 [실측]. 로그인·호출 `not_run`. 작업자 영속 쓰기 공간 `blocked`(사유: 설계 C.8 변경 전, sandbox 미구축. 해소: T08b·T16b) | `--ignore-user-config`도 인증은 CODEX_HOME에서 읽음 → 작업자 CODEX_HOME 전용 필수 [실측]. 같은 파드의 비신뢰 코드가 `auth.json`에 닿을 수 있음(ARCHITECTURE §5.1). "public or open-source repositories" 문구의 적용 범위 [미확인] | **채택: 봇 전용 ChatGPT 구독 계정 + 작업자 전용 CODEX_HOME**(D-14 확정(사용자 2026-10-18, T15), 에이전트 추천 B와 다름). 직렬 1개, 자동 전환 없이 waiting, 영속 쓰기 공간. 남는 위험은 OpenAI 확인 항목. **T17 차단 조건(확정(사용자 2026-10-18, PR #3 리뷰)):** 조건은 OpenAI가 공개 저장소 PR 리뷰에 봇 전용 구독 인증 사용을 허용한다고 확인했거나 API 키 등 공식 지원 인증으로 바꿨을 것. 모델을 부르지 않는 로컬·mock 구현은 T16a 뒤 착수할 수 있다. 공개 저장소 PR 내용으로 구독 모델을 부르는 일(평가셋, `authorized_external`, 시범 P-2)은 차단 조건이 풀린 뒤에만 한다. T16a·T16b와 대화 레인은 그대로 진행 |
| **봇 중단 외부 경보 (OPS-02)** | 설계 C.3.7·C.8·E9, D-10(Telegram 새 봇, healthchecks.io). healthchecks 무료 체크 20개 | 플랫폼 미구축 → `blocked`(해소: T08b 시나리오 16·17, T16b E9 완료 기준) | 핵심 룰은 파드가 죽은 경우만 잡음. 살아 있으나 멈춘 봇, replicas 0을 잡는 장치 없음 [가정]. Watchdog 직접 ping(U10) [미확인] | **채택: D-10 경로.** 봇 쪽 연결은 readiness(수신·영속 저장 가능 여부만, Gateway는 넣지 않음) + 봇 전용 하트비트 체크 + Gateway 연결 지표 경보 제안(ARCHITECTURE §8). 지표 경보는 앱 지표 스크레이프 규칙이 정해진 뒤에야 선다 |
| **D-16 대안: Codex Connector 자동 리뷰** | 자동 리뷰는 저장소 설정("Automatic review", 저장소별 "All PRs"·"Follow personal preferences")과 개인 설정("for your pull requests", "Review trigger")이 함께 있음. GitHub에서는 P0·P1만이라고 문서화. GitHub code review는 API 키 인증에서 불가. https://learn.chatgpt.com/docs/third-party/github , https://learn.chatgpt.com/docs/pricing (2026-10-18) | 사람 PR 7건 자동 리뷰(요약 15~20초, 완료 2~3분), 봇 PR 1건 리뷰 없음(표본 1) [실측]. 숨은 상태 JSON 형식이 11일 사이 바뀜, P2 지적 게시 [실측] | 결과 계약·공개 범위·`COMMENT` 보장을 봇이 통제 못 함. 봇 PR 미리뷰 원인, 저장소 설정의 리뷰 범위(봇·Renovate PR 포함 여부), 외부인 `@codex` 호출(U38), Draft 회피, 읽는 `AGENTS.md` 리비전 [미확인] | **채택하지 않음(D-16 확정: 기본안).** 봇 리뷰 저장소의 Codex 자동 리뷰는 저장소별 Codex 설정에서 끈다(사람 작업, 수동 `@codex review`는 남김). Connector 설치는 선택 저장소로 줄였다(사람 2026-10-18 17:45, `homelab-bot-ops` 첫 push 전. 남긴 저장소 목록은 API로 확인하지 못함). Discord 중계는 V1 필수 아님(T17에서 정함) |

## T16b 시작 때 다시 볼 것 (blocked 해소 점검)

1. `kubectl auth can-i --as=system:serviceaccount:app-homelab-bot:bot-reader`로 `get secrets -A`, `get configmaps -A`, `get pods --subresource=log -A` → 모두 no.
2. Argo CD `bot-reader` 토큰으로 시험 앱 ConfigMap의 live 매니페스트 조회 결과 기록.
3. Grafana `bot-reader` 토큰으로 `POST /api/ds/query`에 VictoriaLogs 임의 질의 결과 기록, `POST /api/dashboards/db` → 403(U12).
4. 봇 파드에서 vmsingle·VictoriaLogs·Alertmanager API → 실패, Grafana·`argocd-server`·작업자 Service → 연결.
5. 봇 replicas 0에서 무엇이 울리는지 기록.
6. 호스팅형 Renovate PR과 시험 App PR의 `author_association`.
7. 봇 파드에서 Discord Gateway·REST(IPv4 443) 연결, 네트워크 차단·복구 뒤 RESUME 또는 재IDENTIFY와 프로세스 생존. 차단 동안 봇 파드가 Ready를 유지해 webhook(8080)·경보 수신(8081)이 계속 받는지, Gateway 연결 지표가 끊김을 보이는지.
8. 작업자 파드에서 `codex sandbox -- true`(모델 호출 없음)와 DNS 없이 `HTTPS_PROXY` 경유 모델 쪽 도메인 도달(U29).
9. 작업자 파드에서 프록시 경유 `codeload.github.com` → 연결, `github.com`·`api.github.com`·gist → 프록시 거부(D-15).
10. 작업자 파드를 다시 만든 뒤에도 영속 쓰기 공간의 파일이 남는지(D-14 조건 4).
11. 공개 webhook 경로(T08a): GET → 403, 다른 경로 POST → 403(또는 404), 서명이 틀린 POST → 401, 시험 webhook ping → Recent Deliveries 200.
12. Alertmanager 봇 route(`continue: true`)와 Telegram 형제 route를 함께 켠 뒤, 봇이 정상일 때와 replicas 0일 때 모두 시험 경보가 Telegram에 도착하는지(설계 C.3.7·E9).
13. homelab에 ruleset A~D가 active인지(`gh api` GET, T10).
14. 작업자 파드의 init 방화벽(U13): 프록시 ClusterIP:3128 밖으로 가는 새 연결(노드 IP의 6443·10250·22, DNS 53) → 실패, 봇 → 작업자 Service 요청의 응답 → 통과. 안 되면 작업자만 호스트 전용 UID + nft로 물러난다(D-15).

## FOUNDATION T16a 실행 결과 (2026-10-20)

현재 검증 기준은 호출자가 만든 `c8cd348a9056297174e9820fa93a0edf764515c6`(`feat/t16a-foundation`) 위 작업 트리다.
초기 구현 기준은 `2e84c5f58cc5d4d3b60eeebeb085b722ea3de795`이며, 작업자는 이번에도 커밋·index·브랜치를 변경하지 않았다.
`npm run check`와 `npm test` 통과, **276 tests / 276 pass / 0 fail / 0 skipped**.
실행 환경은 Node 24.22.0, TypeScript 7.0.2, PGlite 0.5.10이다.
시험 코드는 `test/foundation.test.ts`와 독립 리뷰 회귀 `test/review-1.test.ts`·`test/review-2.test.ts`·`test/review-3.test.ts`·`test/review-4.test.ts`·`test/review-5.test.ts`·`test/review-6.test.ts`·`test/review-7.test.ts`·`test/review-8.test.ts`, 모의/로컬 DB 구성은 `test/helpers.ts`다.
세부 명령 원문·실행 결과·파일 digest·HANDOFF는 호출자에게 전달한 비공개 작업 보고서에 있다.

등급 `local_integration`은 실제 앱 코드·PostgreSQL 엔진·임시 디스크/loopback HTTP의 통합을 뜻한다.
외부 서비스 응답은 모의다. PGlite는 실제 PostgreSQL 서버의 다중 연결·CNPG·네트워크 단절·RBAC를 검증하지 않는다.
보안 경계 AUTH-01·READ-02·SEC-01은 모두 아래 로컬 경로에서 pass다.

| 시험 ID | 등급 / 판정 | 확인한 경계 | 남은 검증 / 해소 티켓 |
|---|---|---|---|
| AUTH-01 | local_integration / pass | owner·guild·채널·스레드 parent·DM·버튼, bot/webhook 무시, Gateway 메타데이터 | 실제 Discord 권한 blocked(실연동 전), T16b. GitHub 설치·저장소 게이트 not_run(후속 단계), T17 |
| AUTH-02 | local_integration / pass | 정책 누락·5분 초과 시 대기와 갱신 후 재개, 현재 revision 재인가, DB 즉시 철회·명시 해제 ID 승인, 실행 중 stale은 heartbeat 유지, 대기 read 서비스 철회 차단 | 실제 Infisical/ESO freshness 전달 blocked, T16b. 질문/예약/기억 접근 not_run, T18/T20 |
| EVENT-01 | local_integration / pass | ACK 전 처리 경로 저장, ACK 유실·재시작 뒤 작업 한 건, interaction 만료 안내, 저장/큐 실패 ACK 없음, 최종 UPDATE 지연 rollback·COMMIT 잔여 예산 모의 검사 | PostgreSQL 서버 timeout·연결 유실 blocked, T16b. GitHub 세대 키 not_run, T17 |
| EVENT-02 | local_integration / pass | 실제 DiscordProtocol + 모의 API: 게시자 marker·페이지·보관 스레드 대조, 응답 유실 뒤 재게시 없음·429 대조 중단/영속 대기 | 실제 Discord 서버 nonce 유효 창·게시/대조·보관 스레드 응답 blocked, T16b. GitHub 게시 대조 not_run, T17/T19 |
| EVENT-03 | local_integration / pass | 실제 DiscordProtocol + 모의 API + DB scope로 101건 페이지 복구, 1000건 gap, checkpoint 후퇴 방지 | 실제 RESUME/IDENTIFY와 30초 실측 blocked, T16b. PR·base 이동 대조 not_run, T17 |
| EVENT-04 | local_integration / pass | lease 만료 unknown, stale 결과 거부, 새 모델 호출 차단, 디스크 DB 재시작 | 실제 파드 소멸·프로세스 종료 증거 blocked, T16b/T18 |
| CHAT-01 | local_integration / pass | 부모 채널 매번 멘션/명령 요구, 공개 스레드 1440분, 활성 스레드 후속·debounce·DM 분리, intent off, 실제 payload 형식의 모의 Gateway/REST | 실제 Gateway·slash 등록·스레드 후속 메시지 blocked, T16b |
| CHAT-02 | local_integration / pass | 구독 해제 뒤 수집 중단·명시 재개, 작업 유지, DB 재시작 보존 | 실제 archive/unarchive·권한 상실 이벤트 blocked, T16b |
| READ-01 | local_integration / pass | 등록 서비스→승인 질의→근거/시각/미조회→맞는 스레드, 미등록/관측 불가/오래된 정상 구분, 요약 항목 보존·생략 표시 | 라이브 Grafana/K8s/Argo CD 응답 투영·현재 상태 blocked, T16b |
| READ-02 | local_integration / pass | 임의 query·datasource·namespace·shell·Secret·ConfigMap·pods/log/exec 거부, 시간·응답행 상한 | 플랫폼 RBAC·Grafana Viewer·Argo CD live ConfigMap 노출 blocked, T16b |
| SEC-01 | local_integration / pass | 로그 지시는 비신뢰 자료, 원문 공개 금지. PR/기억/AGENTS 지시는 untrusted, 모델 tool/policy 필드 거부·실패 안내, 이후 미허용 조회 거부·효과 없음 | 실제 모델의 인젝션 저항성은 이 증거에 포함하지 않음. PR 수집 경로 확장은 not_run, T17 |
| OPS-01 | local_integration / pass | 긴 작업 중 ACK 지속·직렬 1, 대기 기록 ≥5초(모의 시계), 한도/인증 대기 원자성·실패 후 슬롯 보존, 연결 거부 failed·응답 단절 unknown, 취소 확인·timeout 실패 안내, 비상 중단·owner 대기 재개/포기·비상 해제·429·IDENTIFY 예산 | 실제 대화 지연·재연결 루프·자원·도구 호출 계수 blocked, T16b/T18 |
| OPS-02 | local_integration / pass | Gateway 단절 중 Ready·실제 로컬 HTTP 경보 저장, 5분 뒤 heartbeat 중단, Gateway gauge, 경보 중복/재발 요약·모델 0회, unknown 별도 상한·기한, 혼합 그룹 필터·미지원 라벨 감사/202, 게시 pause 감사 중복 억제·backoff, 경보 공통 admission 잠금 | 실제 healthchecks·스크레이프·Telegram·replicas 0·NUC 중단 blocked(실연동 전), T16b |

추가 계약 시험: Ed25519 scope·body·만료·재생 거부, loopback worker HTTP 인증,
취소 뒤 늦은 완료가 다음 작업 mutex를 풀지 않는 회귀, codeload URL·고정 SHA·잘못된 repository 거부는 pass다.
자격 없음 선언 상수는 실행 검증으로 세지 않는다. EVENT-02/03은 이제 실제 DiscordProtocol을 포함하며,
모의 API가 Discord 서버 동작까지 증명하지는 않는다. 300초 초과 loopback HTTP 시험 명령은
`npm run build && HOMELAB_WORKER_SLOW_MS=301500 node --test --test-name-pattern=R1-06 dist/test/review-1.test.js`다.
1차 수정 때 이 별도 시험은 1/1 pass였고, 301.5초 지연 응답을 수집했다(시험 실행 303057.193158ms, DB 준비 포함).
보안상 자격 파일·운영 계정은 전혀 읽지 않았다. 실제 worker filesystem/egress·영속 nonce는 검증하지 않았다.

최초 실행은 33개 중 재시작 시험 1개 실패였다. 모의 시계가 재기동 때 과거로 돌아가 outbox의
available_at에 도달하지 못한 fixture 오류를 수정했고 재실행에서 33/33 통과했다.
그 뒤 기존 47개와 독립 리뷰 13개 지적에 대한 회귀 23개를 합쳐 70/70을 확인했다.
리뷰 수정 중 undici 8.x Agent와 Node 24 내장 fetch의 호환 오류로 68개 중 3개가 실패했고,
호환되는 최신 7.x를 선택해 수정했다. 문서/설치 계약 일치도 회귀에 포함한다.
2차 수정은 회귀 15개를 추가해 **85/85**를 확인했다. 기존 401 회귀는 증가한 backoff의 available_at에
맞춰 복구 시계를 진행하도록 갱신했다. 기본 시험의 R2-08은 headers/body 기본값을 50ms로 낮춘
실제 loopback HTTP에서 1600ms 지연 응답이 실패하고, 작업 예산으로 덮으면 성공하는 대조를 포함한다.
2차에서는 301.5초 시험을 반복하지 않았다. 문서 표 열 수·복구 계약과 재시도 영향 0건도 검사한다.
이 결과를 실연동 성공·AC-B3 전체 완료·V1 출시 판정으로 사용하지 않는다.

3차 PR 리뷰의 10개 ID에 회귀 19개를 더해 104/104를 확인했다. cancel lease와 발급 시각, 부모 채널 urgent,
취소/완료 경합, 45건 list의 JSON 페이지도 포함한다. PGlite는 transaction을 직렬화하므로
경보 상한 시험은 공통 잠금이 count 앞에 놓이는지도 검사한다. 실제 PostgreSQL 다중 연결 경합과
transaction_timeout의 backend 종료·네트워크/COMMIT 응답 유실은 blocked(T16b)다.
Postgres 어댑터의 남은 시간 설정·마감 뒤 COMMIT 금지는 모의 pg client로 검사했다.

4차 PR 재리뷰의 7개 ID에 회귀 37개를 추가해 **141/141**을 확인했다. 경보 thread/요약 차단 뒤 새 세대,
global 429의 게시·대조·ACK·history 공통 대기, 페이지 순서/앞 페이지 대기/일괄 rollback,
gap 중 chat/read 결과 보존, 정책 대기와 취소 경합, 독립 read, 미수락 inbox 재전달을 포함한다.
기존 경로도 넓혀 부모 read, 기다리는 read 두 건, superseded/waiting 취소, 큐 포화 시 기존 job 반환,
경보 확정 중 summary 실패와 migration 재적용을 검사했다. 첫 추가 32개를 포함한 136개는 모두 통과했다.
추가 확장 중 140개 중 1개가 경보 참조 migration의 같은 시각 thread/summary 선택 오류로 실패했고,
대화 생성 뒤에는 요약만 참조하도록 수정했다. 최종 코드는 회귀 37개 단독과 전체 141개에서 통과했다.
이 결과는 PGlite와 모의 Discord를 이용한 local_integration이다. 실제 PostgreSQL 다중 연결 잠금,
전역 429의 다중 프로세스 경쟁, 실제 Gateway replay/Discord 메시지 순서는 blocked(T16b)다.

5차의 지적 4개에 회귀 22개를 추가해 **163/163**를 확인했다. 경보 service_ids(초기 thread·요약·후속·병합·대조),
1/15/60/120초 템플릿 시간창, task/chat의 event_order 경계·20건/32KiB, 150건 복구를 포함한다.
복구 커서 지적은 [문서 판정](DISCORD_RECOVERY.md)에 따라 기존 after 전진을 유지했고,
별도 최초 checkpoint=null 경로는 after=0으로 수정했다. 문서·소스 읽기만 허용받아 수행했으며 Discord API는 호출하지 않았다.
첫 check/test는 신규 mock 반환형 오류로 build 단계에서 실패했다. 수정 후 162개 중 sending fixture의 lease_until 누락으로
1개 실패했고, 유효한 lease 기한을 구성하고 claim 후 병합의 재인가 회귀를 더한 뒤 전체 163개가 통과했다. migration 006은 재적용·기존 경보 차단/감사도 검사했다.
모든 서버 응답은 모의이며 실제 Discord의 after 선택 범위·서비스 철회 경합·PostgreSQL 다중 연결은 blocked(T16b)다.


REVIEW-6 파일에 실제 기재된 **9개 ID(중복 1개, 고유 8개)**를 처리하고 동일 계열을 src 전체에서 점검했다.
회귀 **46개**를 추가한 최종 **209/209**과 `npm run check`가 통과했다. 판정은 mock/local_integration이며
운영 권한·외부 호출·Git 상태는 변경하지 않았다. 상세 경로 점검표는 작업 REPORT와 ARCHITECTURE에 남겼다.

- 4314746162: 마지막 history/live 교차, 중복 ACK, 실패 후 재복구, 중복 recover, buffer 상한·문맥 순서.
- 4314746171: 채널별 429의 backlog·ACK·history·대조 공유, 다른 채널 진행, HTTP bucket 헤더 전달.
- 4314746177 및 중복 4314746204: thread/DM × message/command/button의 owner 교체 거부,
  직접 저장·오염된 context·claim·control 게시와 경보 group 세대 격리.
- 4314746184: 인가/대기 조회 DB 오류는 미전송 pending, 응답 유실/확정 실패는 unknown 및 한 번만 전달.
- 4314746194: 첫 활성화/재활성화 수락 rollback, resume outbox 오류, queue full, 1500ms 기한 초과.
- 4314746217: stop 기간 메시지의 resume/mention 뒤 제외, 복구 도중 stop/resume, save 직전 stop의 세대 fencing.
- 4314746229: 후속 일반 chat에도 urgent priority 0/즉시 실행 보존.
- 4314746240: execute/cancel 모두 issued +1000ms 허용, +1001ms·만료·TTL 초과·nonce 재생 거부.
- 추가 공통 경계: dispatch 전후 lease 만료, terminal 게시 결과 fencing, 모델 직전 cancel/stop/gap/owner,
  직접 emergency-stop rollback, thread 생성 후 owner 변경, HTTP transport setup/cleanup, 중첩 heartbeat,
  migration 007 반복, 복구 lease 만료 응답 거부, 결과 저장 직전 stop, 경보 admission 잠금 뒤 owner/service 재인가.

초기 기존 시험에서는 save가 활성화한다는 fixture 가정, 같은 채널의 별도 메시지가 429 대기를 피해 간다는
기대, 실제 dispatch를 표시하지 않은 sending fixture 등이 새 계약과 충돌했다. 실제 활성 구독을 명시하고
다른 채널의 독립 진행을 검사하도록 수정했다. 새 시험은 buffer checkpoint 누락도 검출해 고쳤다.
HTTP cleanup 오류 mock의 재귀 구성은 순수 주입 dispatcher로 고쳤으며 최종 suite는 제한 없이 종료했다.

미검증 범위는 위 표대로다. 다중 연결 PostgreSQL의 실제 lock/commit 경합과 원격 효과의 exactly-once를
PGlite+mock 결과로 주장하지 않는다. migration 007은 로컬 DB에서만 실행했으며 운영 적용은 T16b다.


REVIEW-7의 **4315477925**와 같은 오류 분류 계열을 고쳤다. 회귀 **27개**를 추가해 최종
`npm run check` 및 **236/236 pass · 0 fail · 0 skipped**를 확인했다. 기준 commit은 `63810fe`다.

- owner/scope/즉시 거부 목록 × 종료 확인/미확인 6개: cancelled 또는 unknown, 사유 authorization_revoked,
  실패 안내·result 없음, /retry 거부. unknown은 다음 모델 실행도 막는다.
- cancel의 Denied/transport 예외 2개, cancel 중 정책 복구, 취소 기록 일시 실패: 철회 이유를 잃지 않는다.
- monitor 이전 succeeded/failed/limited/auth_expired 완료 4개와 완료/monitor 교차: 현재·확인된 철회 우선.
- 같은 계열: 확인된 limited/auth_expired와 monitor DB 오류 2개, 일반 monitor 오류의 종료 확인/미확인 2개,
  조회 응답 뒤 서비스 철회, failed/limited/auth_expired 결과의 stale 정책 3개,
  limited/auth_expired 확인 직후 인가/상태 DB 오류 4개(슬롯 보존·lease 만료 뒤 unknown·자동 재실행 없음).

수정 전 새 시험 20개를 실행해 **4 pass / 16 fail**로 재현했다. 수정 후 229/229 통과를 확인하고,
추가 stale 회귀 3개와 조회 후 철회 검증으로 232개 통과 뒤, 한도 확인 직후 인가/상태 DB 오류 4개를
추가해 수정 전 0 pass/4 fail로 재현하고 보완한 최종 236개도 통과했다. 기존 R2-02의 실제 철회 시험은
실패/실패 안내를 기대하던 잘못된 기대를 cancelled/authorization_revoked 및 outbox 없음으로 고쳤다.
추가 27개는 PGlite와 주입 worker·모의 interval의 local_integration이며 실제 정책 배포/worker 종료 증거는
blocked(실연동 전), T16b/T18에서 확인한다. Git HEAD/index/브랜치와 외부 시스템은 변경하지 않았다.


REVIEW-8의 4개 ID에 회귀 **40개**를 추가해 최종 `npm run check`와 **276/276 pass · 0 fail · 0 skipped**를
확인했다. 기준 commit은 `c8cd348`이며 Git HEAD/index/브랜치 변경과 외부 서비스 호출은 없다.

- 4316099207: slash/버튼 × 수신부터 2499/2500/2600ms 경계 6개, callback HTTP 남은 예산/만료 1개.
- 4316099215: limited/auth_expired × 재개/포기 4개, owner/scope/원인/unknown 거부, 대상·실행/큐 상한,
  scheduler/outbox 실패 rollback 2개, 동시 재개 단일 수락 1개.
- 4316099220: message/thread × 400/403/404 차단 6개, 408/409/500/502 unknown 유지 4개.
- 4316099228: message/thread 저장 ID로 rate limit 중에도 로컬 확정 2개, 24시간 이후 확정,
  현재 owner 철회 뒤 후속 효과 차단.
- 공통 경계 10개: 비상 중지 보존·이전 중지 명시 확인·미확인 실행 해제 거부, 대조 GET 404의 증거 구분,
  늦은 unknown/반복 confirm 실패의 ID 보존·backoff, cancel/비상 해제 outbox rollback 2개,
  재개 뒤 이전 lease 결과 거부, verifying cancel/비상 중지 2개.

첫 추가 32개를 포함한 268개가 모두 통과했고 경계 확장 후 276개도 통과했다. 기존 REVIEW-6의 직접
emergency-stop rollback 시험은 verifying까지 중지 요청하는 SQL을 가리키도록 fault injection을 갱신했다.
새 시험은 PGlite·실제 앱 코드·주입 API/worker의 local_integration/mock이다. 실제 Discord 3초 응답 수신,
slash 명령 등록, 실제 한도 창/인증 복구·worker 종료 증거, PG 다중 연결 경합은 blocked(실연동 전), T16b/T18이다.

## CODEX_BRIDGE T18 실행 결과 (2026-10-29, 로컬·mock)

- 기준: 브랜치 `feat/t18-codex-bridge-local`(origin/main `bf6a8e9` 위 로컬 커밋, PR 전). 구현은 [ARCHITECTURE.md](ARCHITECTURE.md) §12, 결정 대기는 [DECISIONS.md](DECISIONS.md) "T18 결정 대기 (사용자)".
- `npm run check` 통과, `npm test` **343 tests / 343 pass / 0 fail**(T16a 기준선 276 + T18 67, 시험 파일 `test/codex-bridge.test.ts`). rev-t18 r4 수정 뒤 전체 실행을 연속 3회 반복해 모두 통과했다. Node 24.22.0, TypeScript 7.0.2, PGlite 0.5.10.
- **실제 `codex` 실행과 모델 호출은 하지 않았다**(D-14 차단 조건). Codex 자리는 (1) JSONL fixture를 내보내는 fake launcher, (2) 같은 인자·stdin·환경으로 도는 로컬 node 스크립트다. JSONL fixture는 공식 문서의 이벤트 형태로 합성했고 실제 CLI 녹음이 아니다. 개인 `~/.codex*`, Discord, GitHub, 네트워크에 닿지 않았다.
- 등급: `mock`은 봇 쪽 실제 코드(Store·Runtime·PolicyGate·DiscordPublisher, PGlite)에 Codex 자리만 fake다. `local_integration`은 실제 로컬 프로세스·파일시스템·git·디스크 DB 재시작을 포함한다.
- **판정 갱신(rev-t18 r1·r2 반영 뒤, 2026-10-29):** 독립 Codex 리뷰 r1의 P1 3항목(S1·R2 같은 결함, R1)과 P2 4항목(S2·S3·R3·R4)을 r1 반영에서 고쳤으나, 재리뷰 r2 판정으로 S1·R2와 R4는 다른 유효 입력에서 깨지는 부분 수정이었다. r2의 N1~N5와 스스로 찾은 같은 종류 3건을 r2 반영에서 고쳤다. 재리뷰 r3은 N1~N5를 해결로 판정했지만, r2 자체 점검의 파일 읽기 보호는 마지막 경로 요소에만 적용되는 부분 수정이었다(N6·N7). r3 반영에서 고정 디렉터리 핸들로 고쳤다. 세 번 모두 회귀 시험을 먼저 넣어 수정 전 실패를 확인했다(아래 "r1 반영", "r2 반영", "r3 반영").
- **보안 경계 SEC-02는 이 경로에서 로컬로 시험할 수 있는 부분만 pass다.** 작업 레인 비신뢰 코드의 `auth.json` 읽기 격리와 세션 디렉터리 격리는 사용자 결정과 T16b 실측 전이라 `blocked`다. 그래서 T18 완료 조건(SEC-02 pass, R08 사용자 결정)은 아직 채우지 못했다.

| 시험 ID | 등급 / 판정 | 확인한 경계 | 남은 검증 / 해소 |
|---|---|---|---|
| TASK-01 | mock / pass (봇 소유 경로·능력 표시). R08 사례 blocked | Discord task → exec → 결과·증거 기록 → outbox → 게시, `codex_sessions` 소유 기록(외부 스레드·실행 호스트·능력표), 능력표(tool approval false, attach 미정), 타인·다른 스레드·미등록·대화 작업의 상태 조회 거부, 지시·답은 stdin, 위험 플래그 없음, `-`로 시작하는 스레드 ID 거부 | R08 명시적 연결 사례 blocked(사유: 연결 방식 사용자 결정 대기. 해소: DECISIONS "T18 결정 대기" (1) 결정 뒤 T18). 실제 `codex exec` blocked(T16b, D-14) |
| TASK-02 | mock / pass | 질문 ID `job:thread:turn`, owner만 답함, 다른 스레드·다른 사람·바뀐 owner 거부, 같은 이벤트 재전달은 한 번만 반영, 두 번째 답·이어 간 질문·기한 지난 질문·취소된 작업의 질문 거부, 만료 때 cancelled·알림·슬롯 해제(Runtime `sweep`), 질문 대기 중 비상 중지 해제 뒤 답하거나 만료되면 스케줄러도 풀림, 작업당 열린 질문 하나, 도구 승인 종류 질문 DB 거부, migration 009 반복 적용 | Discord `/answer` 명령 연결 not_run(T16a 소유 ingress 변경 필요, ARCHITECTURE §12 "T16a 소유 변경 요청" 2번). 이 시험은 브리지를 직접 불러 ingress 중복 제거·순서를 거치지 않는다. 실제 `exec resume` blocked(T16b) |
| TASK-03 | mock(JSONL fixture) / pass. 프로세스 정리·예산·출력 상한은 local_integration / pass(한계 기록) | 세션 전·긴 메시지 뒤쪽의 인증·한도 오류도 대기(r1 S1·R2, r2 N1), 축약이 판정 필드를 자르지 않음(r2 N2), 재개 예산 소진 뒤 /retry는 새 스레드(r2 N3), 옛 009 DB 업그레이드(r2 N4), git과 같은 소유자 실행 비트(r2 N5), 준비 중 중단·해제된 작업은 늦게 준비가 끝나도 프로세스를 띄우지 않음(r1 R1), 도구 호출 예산을 실행 중 집행하고 질문 뒤 재개까지 합산(r1 S2), 한 줄·전체 출력·이벤트 수 상한(r1 S3), 첫 턴 한도 대기 뒤 같은 스레드 재개(r1 R3), 실행 비트 변경도 diff(r1 R4), "완료" 문자열·로그 속 가짜 이벤트·idle 무시, 종료 코드·`turn.failed`·스키마 밖 출력·스트림 손상·스레드 불일치, 게시 변경 목록은 실제 diff 기준(보고만 있는 파일은 증거로 표시, 셸 변경도 보고, 작업 공간 밖 변경 보고는 실패, 일시 error 뒤 완료는 유지), 취소는 소멸 확인 뒤에만 cancelled, 남은 프로세스 → unknown·막힘 알림·새 실행 차단·owner 해제(0개 재확인), 중단 뒤 끝나지 않는 실행 → unknown, 시간 초과 → failed, 작업자 단절·동기 throw → 종료 확인에 따라 failed·unknown, 실행 파일 없음·이미 있는 `.git` 등 실행 전 실패 → 실제 launcher에서도 failed, 재개 실패를 새 스레드로 바꾸지 않음, 한도 도달 → 대기·재개 때 같은 답으로 같은 스레드(시도 한도면 /cancel 안내), 디스크 DB 재시작 뒤 막힘 유지, 실제 프로세스에서 정상 종료 뒤 배경 자식·새 세션 자식 정리, 못 읽는 새 프로세스는 확인 불가(unknown) | 환경을 지우고 새 세션으로 빠져나간 dumpable 자식은 못 찾는다(시험으로 기록, 그 시험은 자식이 살아 있는데 `completed`임을 확인한다). 그래서 이 시험들의 통과는 비신뢰 프로세스 소멸의 보장이 아니고, 소멸 확인 수단의 완전성은 blocked(cgroup 또는 파드 안 제어 프로세스 밖 0개 확인, T16b). 도구 예산은 초과 호출의 시작을 본 즉시 끝내지만 그 한 호출의 일부 효과는 남을 수 있다(CLI 제한 플래그 [미확인]). codex의 SIGTERM 동작·종료 코드, 실제 오류 순서·출력 크기 blocked(T16b) |
| SEC-02 | 부분: mock·local_integration / pass. `auth.json` 읽기 격리·세션 디렉터리 격리 blocked | `shell_environment_policy` inherit=none 설정 생성, `[projects]` 신뢰 없음, 남은 프로세스가 있으면 결과·인증·작업 공간을 읽지 않음, 실행 뒤 읽기는 실행 전에 고정한 디렉터리 핸들 아래에서만 하고, 확인 시점에 `run`·`workspace`·작업 디렉터리가 바깥 심링크로 바뀌어 있으면 본문 읽기 0회로 실패(정적 교체 재현, r4 N8), 작업 공간 루트 심링크·순회 중 심링크 교체·하드링크·FIFO를 따라가거나 읽지 않음, 크기 확인 뒤 커지는 파일도 실제 읽은 바이트로 상한(N7), codex 실행 환경 허용 목록(실제 프로세스에서 작업자 환경의 Discord·OpenAI·시드 값 미상속), 이전 턴 출력 파일 삭제, 개인 `~/.codex*` 아래·위 루트와 심링크·루트 아래 심링크 거부, 실행 중 접근 경로가 작업자 루트 밖으로 나가지 않음 | 작업 레인 비신뢰 코드의 `auth.json` 읽기 → 거부: blocked(사유: 같은 UID라 지금 구조로는 읽힌다. 해소: DECISIONS "T18 결정 대기" (2) 결정 + T16b 실측). 다른 작업·대화 세션 디렉터리 읽기: blocked((4) 결정 + T16b). Codex가 정책을 실제로 적용하는지(모델 셸 환경): blocked(T16b, codex 실행 필요). `codeload.github.com` 밖 GitHub 차단: blocked(T16b egress). 제어 끝점 호출 거부: 이 경로 not_run(T16a capability 시험이 기준). `auth.json` 값 반사 차단은 best-effort 보완책이라 pass 근거에 넣지 않는다. 실행 뒤 읽기 경계는 같은 UID 안의 경로 경계다. 고정 디렉터리 안의 내용 위조(결과 파일 직접 쓰기), codex 자신의 경로 읽기와 다른 살아 있는 프로세스의 경합, 원래 디렉터리를 제자리로 되돌린 교체(사후 확인으로 탐지 불가, r4 N9 한계 기록 시험), 마운트 변경은 막지 못한다(ARCHITECTURE §12 "실행 뒤 파일 읽기 경계", 별도 UID·마운트 namespace는 결정 대기 (2)·(4)와 T16b) |
| AUTH-02 (질문 경로) | mock / pass | 답 직전 owner 교체·즉시 철회는 Denied, 정책 만료는 PolicyUnavailable(질문·작업 상태 불변), 답 수락 뒤 철회는 재개 전 cancelled, 실행 중 철회는 소멸 확인에 따라 cancelled·unknown, owner가 바뀌어 남은 막힘은 옛 owner가 못 풀고 현재 owner만 0개 확인 뒤 해제 | 실제 Infisical·ESO 반영 blocked(T16b) |
| OPS-02 (막힘 알림 경로) | mock / pass(Discord만) | unknown 막힘의 Discord 알림(settle 안, lease 만료 등 settle 밖 모두 한 번) | Telegram 비AI 경로 blocked(T16b, `health.ts` 지표는 T16a 소유 변경 요청) |

이 결과를 실연동 성공·AC-B5 완료로 쓰지 않는다.

- **r1 반영(rev-t18 리뷰 `/home/ukyi/t13/bot/review-t18-r1.md`):** 지적별 회귀 시험(`test/codex-bridge.test.ts`)과 수정 커밋 `7b23166`.
  - S1·R2 [P1] 세션 전 한도·인증 오류: :868(판정), :876(waiting_user·스케줄러 정지·다음 작업 차단).
  - R1 [P1] 중단·해제 뒤 늦은 실행: :886(시간 초과 → unknown → release → 준비 완료 뒤 spawn 0회), :903(confirmStop의 세대 무효화, 중단된 신호로 실제 launcher spawn 0회).
  - S2 [P2] 도구 호출 예산: :921(예산 1, 호출 2 → failed), :930(질문 뒤 재개 합산), :942(실제 프로세스에서 초과 시작을 보고 끝내 셋째 호출의 효과 없음).
  - S3 [P2] 출력 상한: :948(한 줄 3MiB > 1MiB, 전체 > 64KiB → failed, 기본 상한에서 정상 완료).
  - R3 [P2] 첫 턴 한도 대기 재개: :956(`exec resume thread-one`, 최초 요청을 다시 보내지 않음, 세션 유지).
  - R4 [P2] 실행 비트: :970(0644 → 0755는 변경, git이 보지 않는 비트는 변경 아님).
  - 수정 전 실행: 새 10건 실패·기존 40건 통과(커밋 `2286f2f`). 수정 뒤 50/50, 전체 326/326을 3회 연속 통과.
  - 수정이 바꾼 기존 시험: 시간 초과 사례(:553)는 준비(git init) 중 시간 초과가 이제 실행을 막아(R1) 준비가 즉시 끝나는 작업 공간으로 바꿨다. 결과 객체에 `tools` 필드가 더해져 기대값 2개를 갱신했다. fake codex는 파이프 출력을 비운 뒤 끝나게 고쳤다(바로 exit하면 3MiB 출력이 잘림).
- **r2 반영(재리뷰 `/home/ukyi/t13/bot/review-t18-r2.md`):** 회귀 시험(`test/codex-bridge.test.ts`)과 수정 커밋 `33b8a27`.
  - N1 [P1] 긴 오류 메시지 뒤쪽 인증·한도 표식: :991(최상위 `error`·`turn.failed` 모두 2000자 뒤 표식 → 대기), :999(실제 브리지 waiting_user·스케줄러 정지·다음 작업 차단). r1 S1·R2를 완전히 닫는다.
  - N2 [P2] 경로 500개·4096자 절단 뒤 판정: :1009(501번째 공간 밖 경로, 4096자 뒤 상위 이동 → failed, 실제 브리지 포함).
  - N3 [P2] 재개 예산 소진 뒤 /retry: :1022(한도 대기 경로), :1039(clarification 경로). 세션 failed·질문 cancelled 정리 뒤 /retry가 새 스레드로 dispatch.
  - N4 [P2] 옛 009 DB 업그레이드: :1057(`ac5581d`·`c642fd9`판 원문 스키마 → 현재 009 두 번 적용 → 열·상태 제약, 사용량 모름 세션 재개 거부, /retry 새 실행).
  - N5 [P2] 소유자 실행 비트: :1091(0755→0655, 0644→0744, 0644→0655, 0755→0744, 0644→0755를 `git diff --summary`와 대조). r1 R4를 완전히 닫는다.
  - (r3 판정으로 정정) 아래 자체 점검의 "크기 확인 뒤 읽기·심링크·FIFO 비추적"은 마지막 경로 요소와 이미 큰 정적 파일에만 성립하는 부분 수정이었다. 상위 디렉터리 심링크와 읽는 도중 커지는 파일은 r3 반영에서 고쳤다.
  - 자체 점검(같은 종류): 맨 처음 009판에는 `repository` 열과 `waiting_model` 상태 제약도 없었다(N4 시험이 함께 확인). 실행 출력 파일을 크기 확인 없이 통째로 읽던 것(:1109, `output_too_large`). 변경 경로 중복 제거·대조가 경로 수의 제곱 비용이던 것(:1119, 수정 전 4만 5천 개에 1541ms, 수정 뒤 66ms). 축약에서 항목 id·종류·상태·스레드 ID를 자르던 것도 함께 없앴다.
  - 수정 전 실행: 새 8건 실패·기존 50건 통과(커밋 `1e6c990`, 원문 `.local/r2-red.txt`는 커밋하지 않음). 제곱 비용 시험은 그 뒤 더해 수정 전 실패(1541ms)를 따로 확인했다. 수정 뒤 59/59, 전체 335/335를 3회 연속 통과.
  - 시험 쪽 변경: D-14 시험의 파일 접근 기록용 spy에 새 `size` 메서드를 더했다.
- **r3 반영(재리뷰 `/home/ukyi/t13/bot/review-t18-r3.md`):** 회귀 시험(`test/codex-bridge.test.ts`)과 수정 커밋 `404fe6a`.
  - N6 [P1] 실행 뒤 상위 디렉터리 심링크로 바깥 읽기: :1140(리뷰어의 정적 교체 재현. 실행 구간에 `run`·`workspace`·둘 다·작업 디렉터리를 바깥 디렉터리 심링크로 교체 → `failed`(`workspace_tampered`), 바깥 요약 표식 없음), :1159(실제 브리지에서 결과 행·게시 없음), :1171(루트 심링크 스냅샷 거부, 상위 심링크를 거친 `nodeFiles.read` 거부).
  - N7 [P2] fstat 뒤 커지는 파일: :1190(fstat이 1바이트를 본 직후 2MiB로 키우는 순서를 고정 → 상한 1024에서 null).
  - 자체 점검(같은 종류: 경로 해석·심링크·TOCTOU): 하드링크 파일 읽기·해시(:1180), 설정 쓰기가 기존 하드링크를 따라 바깥 파일을 덮어쓰던 것(:1206, `O_EXCL` 새 inode), 스냅샷 순회의 lstat→readdir 사이 교체(핸들 기준 순회로 함께 고침), git 준비가 경로 기반이던 것(고정 핸들에서 돌림), 남은 프로세스가 있을 때도 결과·인증 파일을 읽던 것(N7 제안대로 읽지 않음).
  - 막은 범위와 남는 한계: ARCHITECTURE §12 "실행 뒤 파일 읽기 경계". 사슬 확인을 realpath 비교로 쓰지 않았고, 확인 뒤 교체는 고정 핸들이 지킨다. 같은 UID의 내용 위조, codex 자신의 경로 사용, 다른 살아 있는 프로세스의 경합은 남는다.
  - 수정 전 실행: 새 5건 실패·기존 59건 통과(커밋 `b43e376`). 처음에는 시험의 작업 ID에 16진수 아닌 글자를 넣어 다른 이유로 실패했고, 고친 뒤 의도한 실패(바깥 결과로 `completed`)를 확인했다. 설정 쓰기 하드링크 시험은 그 뒤 더해 수정 전 실패를 따로 확인했다. 수정 뒤 65/65, 전체 341/341을 3회 연속 통과.
  - 시험 쪽 변경: `CodexFiles`가 실행 전 경로 연산(mkdir·resolve)만 남아 D-14 시험의 spy를 그에 맞췄다.
- **r4 반영(재리뷰 `/home/ukyi/t13/bot/review-t18-r4.md`, P3 2건):** 재리뷰는 N6·N7과 r3 자체 수정 5건을 해결로 판정했다.
  - N8 [P3] 사슬 확인 전에 출력 파일을 읽던 순서: 확인 실패 반환을 모든 본문 읽기 앞으로 옮겼다(수정 커밋 `9a15db9`). 회귀 시험 `test/codex-bridge.test.ts:1221`은 실행 뒤 `FileHandle.read`·`readFile`·`readableWebStream` 호출을 모두 기록해, `workspace`만 바깥 심링크로 바꾸고 결과는 원래 `run`에 쓴 경우 읽기 0회를 확인한다. 수정 전에는 출력 파일을 2회(데이터·EOF) 읽어 실패했다(커밋 `3abf48d`).
  - N9 [P3] 사후 확인의 범위: 원래 inode로 되돌린 교체는 탐지하지 못한다는 한계, `dev`·`ino` 비교가 마운트를 보지 않는다는 점, 실행 전 디렉터리 만들기 경합이 실패로 닫히는 조건(잘못된 경로가 고정 단계까지 남아 있을 때)을 ARCHITECTURE §12에 적었다. 한계 기록 시험 `test/codex-bridge.test.ts:1253`은 바뀐 설정을 읽게 한 뒤 원래 디렉터리를 되돌리면 `completed`가 됨을 고정한다. 하드링크 변경 검출 범위 문구도 좁혔다.
  - 수정 뒤 67/67, 전체 343/343을 3회 연속 통과.
- 시험 중 잡은 결함: `-`로 시작하는 스레드 ID가 재개 인자 검사를 통과하던 것(첫 실행 1건 실패 뒤 수정), 질문 기록 SQL의 매개변수 타입 추론 오류(9건 실패 뒤 수정).
- 독립 리뷰 1회(읽기 전용 에이전트): 13건(P1 1, P2 6, P3 6). 12건을 고치고 회귀 시험을 더했다. 남은 1건은 Discord 명령 연결이고, T16a 소유 ingress 흐름을 바꿔야 해서 변경 요청으로 남겼다. 리뷰가 고친 판정: 알림 없는 unknown, 해제할 수 없는 unknown, environ을 못 읽는 프로세스를 0개로 세던 것(fail-open), diff 대조 없음, 한도를 failed로 보던 것, 반사 검사 우회·오탐.
- 2차 독립 리뷰(1차 반영 커밋 대상): 8건(P1 1, P2 3, P3 4)을 모두 고치고 회귀 시험을 더했다. 리뷰가 고친 판정: 실제 CLI가 `file_change` 경로를 절대 경로로 내면 정상 완료가 모두 실패하던 것([미확인] 형식이라 보고 차이는 증거로만 남김), 생존 프로세스가 있을 때 작업 공간 읽기, 스케줄러 잠금 순서, 실행 전 실패가 개발 기계에서 전역 unknown이 되던 것, 대기 알림 조건, 일시 error 이벤트, pgid 재사용, 이미 있는 `.git`.
- 반영 중 시험 fixture의 JWT 헤더·payload 끝이 우연히 같아 반사 검사가 오탐한 1건은 fixture를 실제 모양으로 고쳤다. non-dumpable 시험은 처음에 고정 300ms 대기에 기대 반복 실행 중 1회 흔들렸고, 준비 파일을 기다리게 고친 뒤 전체 3회 연속 통과했다.
