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
2. ~~Argo CD `bot-reader` 토큰으로 시험 앱 ConfigMap의 live 매니페스트 조회 결과 기록.~~ D9(사용자 2026-10-30)로 봇에 Argo CD API 자격이 없다. 대신 같은 `kubectl auth can-i --as=…:bot-reader`로 `get applications.argoproj.io -n argocd` → yes, 다른 ns의 `applications.argoproj.io`와 `patch`·`update`·`delete applications.argoproj.io -n argocd` → no.
3. Grafana `bot-reader` 토큰으로 `POST /api/ds/query`에 VictoriaLogs 임의 질의 결과 기록, `POST /api/dashboards/db` → 403(U12).
4. 봇 파드에서 vmsingle·VictoriaLogs·Alertmanager API → 실패, Grafana·작업자 Service·Kubernetes API(D8) → 연결. `argocd-server`는 D9 뒤 봇 코드가 부르지 않는다.
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
| EVENT-02 | local_integration / pass | 실제 DiscordProtocol + 모의 API: 게시자 marker·페이지·보관 스레드 대조, 응답 유실 뒤 재게시 없음·429 대조 중단/영속 대기, JSON 본문(목록 페이지·제어 결과)은 marker를 JSON 필드(`{"ref","data"}`)로 실어 메시지 전체가 파싱됨(T16b 이월), 외부 ID 없는 unknown의 검색 miss·오류는 다음 대조 시각을 1초부터 두 배씩 15분까지 늦추고 24시간 폐기 기한은 그대로(T16b 이월) | 실제 Discord 서버 nonce 유효 창·게시/대조·보관 스레드 응답 blocked, T16b. GitHub 게시 대조 not_run, T17/T19 |
| EVENT-03 | local_integration / pass | 실제 DiscordProtocol + 모의 API + DB scope로 101건 페이지 복구, 1000건 gap, checkpoint 후퇴 방지 | 실제 RESUME/IDENTIFY와 30초 실측 blocked, T16b. PR·base 이동 대조 not_run, T17 |
| EVENT-04 | local_integration / pass | lease 만료 unknown, stale 결과 거부, 새 모델 호출 차단, 디스크 DB 재시작 | 실제 파드 소멸·프로세스 종료 증거 blocked, T16b/T18 |
| CHAT-01 | local_integration / pass | 부모 채널 매번 멘션/명령 요구, 공개 스레드 1440분, 활성 스레드 후속·debounce·DM 분리, intent off, 실제 payload 형식의 모의 Gateway/REST, 모델 응답 섹션은 완결 항목만 싣고 생략 건수 표시(T16b 이월, 개선안 v2에서 모든 항목 게시·빈 섹션 생략으로 바뀜) | 실제 Gateway·slash 등록·스레드 후속 메시지 blocked, T16b |
| CHAT-02 | local_integration / pass | 구독 해제 뒤 수집 중단·명시 재개, 작업 유지, DB 재시작 보존 | 실제 archive/unarchive·권한 상실 이벤트 blocked, T16b |
| READ-01 | local_integration / pass | 등록 서비스→승인 질의→근거/시각/미조회→맞는 스레드, 미등록/관측 불가/오래된 정상 구분, 요약 항목 보존·생략 표시, 5초 시간 초과 때 `ReadTransport`의 `AbortSignal`을 abort(T16b 이월) | 라이브 Grafana/K8s/Argo CD 응답 투영·현재 상태 blocked, T16b |
| READ-02 | local_integration / pass | 임의 query·datasource·namespace·shell·Secret·ConfigMap·pods/log/exec 거부, 시간·응답행 상한 | 플랫폼 RBAC·Grafana Viewer·Argo CD live ConfigMap 노출 blocked, T16b |
| SEC-01 | local_integration / pass | 로그 지시는 비신뢰 자료, 원문 공개 금지. PR/기억/AGENTS 지시는 untrusted, 모델 tool/policy 필드 거부·실패 안내, 이후 미허용 조회 거부·효과 없음 | 실제 모델의 인젝션 저항성은 이 증거에 포함하지 않음. PR 수집 경로 확장은 not_run, T17 |
| OPS-01 | local_integration / pass | 긴 작업 중 ACK 지속·직렬 1, 대기 기록 ≥5초(모의 시계), 한도/인증 대기 원자성·실패 후 슬롯 보존, 연결 거부 failed·응답 단절 unknown, 취소 확인·timeout 실패 안내, 비상 중단·owner 대기 재개/포기·비상 해제·429·IDENTIFY 예산, `/retry`도 스케줄러 잠금 아래 queued 100 상한(T16b 이월), `accept()` 잠금 순서 대화 행 → 스케줄러(T16a 변경 요청 6, 실제 PostgreSQL 다중 연결 포함) | 실제 대화 지연·재연결 루프·자원·도구 호출 계수 blocked, T16b/T18 |
| OPS-02 | local_integration / pass | Gateway 단절 중 Ready·실제 로컬 HTTP 경보 저장, 5분 뒤 heartbeat 중단, Gateway gauge, 경보 중복/재발 요약·모델 0회, unknown 별도 상한·기한, 혼합 그룹 필터·미지원 라벨 감사/202, 게시 pause 감사 중복 억제·backoff, 경보 공통 admission 잠금 | 실제 healthchecks·스크레이프·Telegram·replicas 0·NUC 중단 blocked(실연동 전), T16b |

추가 계약 시험: Ed25519 scope·body·만료·재생 거부, loopback worker HTTP 인증,
취소 뒤 늦은 완료가 다음 작업 mutex를 풀지 않는 회귀, codeload URL·고정 SHA·잘못된 repository 거부는 pass다.
자격 없음 선언 상수는 실행 검증으로 세지 않는다. EVENT-02/03은 이제 실제 DiscordProtocol을 포함하며,
모의 API가 Discord 서버 동작까지 증명하지는 않는다. 300초 초과 loopback HTTP 시험 명령은
`npm run build && HOMELAB_WORKER_SLOW_MS=301500 node --test --test-name-pattern=R1-06 dist/test/review-1.test.js`다.
1차 수정 때 이 별도 시험은 1/1 pass였고, 301.5초 지연 응답을 수집했다(시험 실행 303057.193158ms, DB 준비 포함).

T16b 이월 수정(2026-10-30): PR #5 마지막 재리뷰에서 넘긴 P2 5개와 T16a 변경 요청 6번의 회귀 시험은 `test/review-9.test.ts`(PGlite, 12개)와 `test/review-9-pg.test.ts`(실제 PostgreSQL, 2개, `HOMELAB_TEST_PG_SOCKET` 없으면 건너뜀)다. 수정 전 코드에서 PGlite 10개·PG 2개가 지적한 증상으로 실패했고 수정 뒤 모두 통과했다. 외부 ID 없는 unknown의 다음 검색 시각은 migration 011의 `outbox.reconcile_after`다(로컬 DB에만 적용, 운영 적용은 T16b 배포). 실제 Discord·Grafana 응답은 모의이고 실연동은 T16b다.
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

## PR_REVIEW T17 실행 결과 (2026-10-29, 로컬·mock)

- 범위: homelab 티켓 T17의 할 일 2·3·4 코드다. 할 일 1·5(사람 작업: 리뷰 App 생성·설치와 키 등록, 봇 리뷰 저장소의 Codex 자동 리뷰 끄기와 끈 뒤 확인, 허용 봇 작성자 ID 등록)는 하지 않았다. 해당 확인은 `blocked`(사람 작업, 실연동은 T16b 뒤)다.
- 브랜치 `feat/t17-pr-review-local`(origin/main `bf6a8e9` 기준), 로컬 커밋만 했다. push·PR·GitHub 쓰기는 없다.
- `npm run check` 통과, `npm test` **358 tests / 358 pass / 0 fail / 0 skipped**(기준선 276 + 새 82개, `test/pr-review.test.ts`). PR #7 리뷰 r1 수정·회귀 검증 뒤 다시 적은 판정이다. Node 24.22.0, TypeScript 7.0.2, PGlite 0.5.10.
- 외부 호출 없음: GitHub API·webhook 발신·codeload·Discord·모델(Codex·OpenAI) 모두 모의다. 리뷰 모델 자리는 고정 출력 fake 리뷰어다(D-14 차단 조건). 허용 봇 작성자 ID는 시험용 가짜 숫자이고 실제 ID는 runtime policy 키(`review.allowed_bot_author_ids`, 코드에서는 `review.allowedBotAuthorIds`)에만 둔다.
- 등급: `local_integration`은 실제 앱 코드 + PGlite + 실제 tar.gz 해석·diff 코드(+ webhook 수신과 리뷰 레인 작업자는 loopback HTTP)이고, 압축본 받기·GitHub 응답은 모의다. `mock`은 모의 API·fake 리뷰어 계약 시험이다.
- 리뷰 작업은 공유 `jobs`에 `type='review'`(대화 없음)로 둔다. 대화 작업과 모델 슬롯 1개를 양방향으로 나누고, 지금 집을 수 있는 대화가 있으면 리뷰가 양보한다(F05). 모델 한도 때 전역 대기, 비상 중지가 PR 조회 중이면 dispatch 전에 취소, dispatch 전 조회 중 lease를 잃으면 대기열로 되돌림, 실행 중이면 리뷰 호출을 중단하고 종료를 확인하지 못하면 `unknown`으로 슬롯을 잡는다. 작업자 멈춤 확인 뒤의 저장 오류는 `failed`로 닫는다. 리뷰가 모델 한도·인증 만료로 전역 대기에 들어가면 알림 채널에 job ID를 안내하고, owner가 알림 채널에서 `/review-status`·`/review-resume`·`/review-cancel`로 조회·재개·포기해 전역 슬롯을 푼다(다른 채널·스레드·다른 사용자·기존 대화 명령으로는 안 풀림, 비상 중지 중 재개 거부)(`pr-review.test.ts` "D-14"·"F05"·"r2 P1-02" 시험).
- 독립 리뷰 3회(같은 세션의 별도 에이전트, 읽기 전용): 보안 경계 우회는 찾지 못했다. 상태 흐름 지적 11건 중 10건과 재확인에서 나온 4건을 고치고 회귀 시험을 더했다.
- r2(독립 Codex 리뷰 r1의 P1 2건·P2 7건): 지적마다 실패를 재현하는 회귀 시험(`pr-review.test.ts` "r2 …")을 먼저 넣어 실패를 확인하고, 고친 뒤 통과를 확인했다. P1-02(리뷰 모델 대기 해제)는 lead 허용에 따라 공유 제어 계약에 리뷰 전용 명령을 **추가**해 풀었다. 기존 대화 명령의 뜻·동작은 바꾸지 않았고 T16a 기존 시험 276개가 그대로 통과한다.
- r3(재리뷰 r2의 P2 3건): 같은 방식(회귀 시험 `pr-review.test.ts` "r3 …"을 먼저 넣어 실패 확인 → 수정 → 통과)으로 처리했다. 확인 범위는 로컬·mock이다. 마이그레이션 재적용은 r1 반환 시점(`0daf892`) 008 원문으로 만든 PGlite 표에서만 확인했고, 운영 DB 갱신은 T16b다. 기존 시험 2개는 실제 순서에 맞게 fixture를 고치거나(live PR 시각이 받은 webhook보다 앞서던 것), 결과 재사용으로 바뀐 기대값(같은 세대 재개 때 모델 재호출 없음)을 갱신했다.
- PR #7 리뷰 r1(Codex Connector 인라인 P2 3건, 지적 ID 4407851847·4407851854·4407851858): 3건 모두 수용했다. 같은 방식(회귀 시험 `pr-review.test.ts` "4407851…"을 먼저 넣어 실패 확인 → 수정 → 통과)이다. 기존 시험 기대값은 바꾸지 않았다.

| 시험 ID | 등급 / 판정 | 확인한 경계 | 남은 검증 / 해소 |
|---|---|---|---|
| AUTH-01 (PR 경로) | local_integration / pass | GitHub 조회 중 저장소·허용 봇 철회·입력 정책 변경·리뷰 비활성을 capability 발급 직전 최신 정책으로 재확인(모델 호출 없음), 비교 기준 미설정·merge base 조회 실패 시 모델 작업 없음, 실행 직전·게시 직전 저장소·허용 봇 철회 반영, 원본 바이트 HMAC 서명(위조·변조·누락 401, 저장 없음), 설치·저장소 허용, `MEMBER`·`OWNER`·`COLLABORATOR` 통과, `NONE`·`CONTRIBUTOR`·`FIRST_TIME_CONTRIBUTOR`·`FIRST_TIMER` 차단, `type=Bot`이고 허용 숫자 ID일 때만 통과(허용 밖 봇·이름 위장·User 타입 차단), fork·삭제된 head 저장소 차단, Bot 댓글 무시, 댓글은 `comment.author_association`, 댓글 요청도 대상 PR을 조회해 fork·작성자 재확인, 조회 실패 시 모델 작업 없음, 리뷰 정책 없음·stale 정책 닫힘, loopback HTTP 401/202/413/404 | 실제 리뷰 App 설치·webhook 전달·Renovate/App PR의 `author_association` 실측 blocked(사람: 리뷰 App 생성·설치, webhook 경로 T08a, T16b) |
| EVENT-01 | local_integration / pass | PR의 최신 관측 시각(같은 세대 재개·draft 해제 이벤트로도 갱신)보다 오래된 `closed`·`converted_to_draft`는 `stale_event`(최신 세대의 대기 작업·미게시 결과 유지), 댓글 재요청은 확인된 실패·취소만 같은 세대로 되살리고 재시도 한도 뒤 중복, 같은 `X-GitHub-Delivery` 재전송, 같은 세대 `(repo_id, pr, head_sha, comparison_revision, policy_revision)`의 다른 delivery·댓글 요청은 작업 1건, 늦게 온 옛 `synchronize`가 새 세대를 밀어내지 않음 | 실제 GitHub 재전송 blocked(T16b). 순서 판정은 `updated_at`(초 단위)을 믿으므로 같은 초 안의 역순은 이 시험 범위 밖(게시 직전 live 재확인이 남는 창을 막음) |
| EVENT-02 | local_integration / pass | 게시 응답 유실 → `unknown`, PR 리뷰 목록에서 marker·검토 SHA로 대조해 `sent`(재게시 0, Discord 요약 1회), 못 찾으면 `unknown` 유지·`unknown` 진입 24시간 뒤 은퇴(생성 뒤 하루 넘게 대기한 행도 진입 시각부터), 재시도 전 기존 게시 대조, 게시 중 lease 만료(전송 전 재시도, 전송 뒤 unknown), 게시 전 조회가 lease(30초)보다 길면 현재 lease만 갱신해 그 시도에서 게시(다른 lease로 넘어간 행은 갱신·전송 안 함), 무효 인라인(422) → 본문만 1회, 401/403/404 차단, 429 대기, 게시 전 정책 확인 불가·GitHub 일시 장애는 재시도 횟수 없이 백오프 | 실제 GitHub 게시·목록 대조 blocked(리뷰 App, T16b) |
| EVENT-03 | local_integration / pass | 열린 PR 대조로 놓친 세대 복구, `reviewSince` 이전 PR 제외, 실행당 상한·감사(되살린 작업도 같은 예산), 작성자·fork 게이트 유지, 이미 받은 세대 중복 없음, 새 head만 추가 | 실제 열린 PR 조회·수동 재전송 3일 한계 blocked(T16b) |
| REVIEW-01 | mock / pass(평가 하네스만). **모델 품질 평가 blocked** | 정답을 모델 입력과 분리해 유효 지적·오탐·누락·미검토를 세는 하네스, fake 리뷰어 4사례(아래 품질 표). Renovate 의존성 갱신 PR 결과 1건(mock) | 실제 모델 평가 blocked: D-14 차단 조건(공개 저장소 PR 내용으로 구독 모델 호출 금지)과 인증 파일 격리·SEC-02 선행(ARCHITECTURE §5.1). 해소: 차단 조건 해제 뒤 T17 |
| REVIEW-02 | local_integration / pass | 게시 직전 live PR이 draft면 자동 리뷰는 게시하지 않고 보류(댓글 명시 요청은 게시), `converted_to_draft`도 같은 규칙(`reviewDrafts`가 켜져 있으면 무시, 꺼져 있어도 댓글 명시 요청 세대의 대기 작업·미게시 결과는 유지), 보류 뒤 ready_for_review·재조정·댓글이 오면 저장 결과로 모델 재호출 없이 게시, 새 head가 대기 세대를 `superseded`, 실행 직전 live PR 재확인(옛 head는 모델 없이 superseded 후 live 세대 추가), 실행 중 새 세대 → 결과는 superseded 기록만, 게시 직전 head 이동·base 이동·병합·닫힘 → 게시 안 함, head 같고 base만 앞섬 → 결과 superseded·재리뷰는 정책값, base 재지정(`edited`) 새 세대, 병합 이벤트 → `merged_before_review`, draft 대기·`ready_for_review`, 닫힘 뒤 재개·draft 복귀: 아직 실행하지 않은 세대는 되살려 1회 실행, 결과가 있는데 게시만 못 한 세대(실행 중 밀린 경우 포함)는 저장 결과로 게시, 아직 게시된 리뷰가 없으면 base 이동도 재리뷰(같은 head 두 번까지, 게시 차단·공개 범위 차단·실패 결과 뒤에는 안 함, 상한으로 못 게시하면 Discord 안내), 리뷰 비활성 중 대기 작업·미게시 결과 보존, 비교 기준 `merge_base`(뒤처진 PR은 merge base와 head로 diff, base 머리만 앞서가면 같은 세대로 게시)·`base_head` 두 방식 | 실제 GitHub 이벤트 순서·compare/merge base 응답 blocked(T16b). 비교 기준과 base만 움직였을 때 재리뷰 여부는 결정 대기(DECISIONS "T17"). 정책 값이 없으면 리뷰 비활성(새 요청만 막고 대기 작업·미게시 결과는 기다림) |
| REVIEW-03 | local_integration / pass | 변경 목록은 API 열거 기준, 압축본은 blob 내용만. 모드(실행 비트)·이름·새 파일·삭제는 git 형식 머리줄로, 파일 끝 개행 추가·삭제는 `\ No newline at end of file`로 전달, 목록은 변경인데 보이는 차이가 없으면 `archive_mismatch` 미검토, 기준 `AGENTS.md`도 파일 상한·입력 예산(넘으면 빼고 `guidelines_limit` partial). 파일 수·diff 크기·PR 본문 상한, 바이너리, 큰 잠금 파일, submodule 포인터(gitlink)만 바뀐 PR, 열거 `truncated`, 압축본·목록 불일치 → `partial`과 미검토 표시. 열거 실패 → 압축본 비교로 대신하지 않고 `failed`(429·5xx는 Retry-After·지수 백오프 뒤 10회 넘으면 `failed`), 열거 중 head 이동 → 고정 SHA 쌍 기준·게시 직전 차단, 압축 폭탄·경로 탈출 tar → `failed` | 실제 codeload 압축본·Git tree/compare API 응답 형식 blocked(T16b, 리뷰 App) |
| REVIEW-04 | mock / pass | 게시 시점 정책으로 저장된 구조화 결과를 다시 렌더링해 지적 수·인라인 수·본문 길이 상한 적용, 게시 쓰기는 `restrictGitHubWrite`만 통과: `POST /repos/{저장소}/pulls/{번호}/reviews`, `event=COMMENT`, `commit_id`=검토 head, 인라인 `side=RIGHT`. APPROVE·REQUEST_CHANGES·event 없음(PENDING)·dismiss·submit·merge·auto-merge(GraphQL)·PR 수정·issue 댓글·merges·dispatches·다른 PR·다른 SHA는 전송 전 거부. 게시 상한 미설정·초과 → 게시 거부 | 실제 리뷰 App 권한·`authorized_external` blocked(사람: 리뷰 App, 시험 PR 게시 승인) |
| REVIEW-05 | local_integration / pass | Bot 댓글(명령·자기 리뷰 본문 포함) 무시, `pull_request_review`는 구독 밖으로 무시, 허용 봇 ID가 연 PR은 정상 리뷰 | 실제 자기 이벤트 루프 blocked(T16b) |
| SEC-01 | mock / pass | PR 본문·Renovate 릴리스 노트·PR이 바꾼 `AGENTS.md`의 지시는 `untrusted` 자료로만, 리뷰 기준은 고정 지침 + base 리비전 `AGENTS.md`만, 정책·허용 목록 불변. 모델 출력의 승인·병합·정책·확신 점수 필드, 검토 밖 파일 지적 → `invalid_output`, 게시 없음 | 실제 모델의 인젝션 저항성은 이 증거에 넣지 않는다(D-14 차단 조건) |
| SEC-02 | local_integration / pass(작업자 입력·자격·제어 끝점 경계). **파드 격리 사례 blocked** | 리뷰 레인 작업자 HTTP(loopback)는 capability 없음 401, 위조·재사용·본문 불일치 403으로 시작 전 거부, 연결 거부는 확정 실패(슬롯을 잡지 않음). 작업자는 서명 capability에 묶인 요청에서 고정 SHA `codeload.github.com` 주소만 받고(바뀐 주소·api.github.com·github.com·브랜치 이름 거부), 압축본 요청은 `credentials: omit`·`redirect: error`·인증 헤더 자리 없음, capability 재사용·본문 불일치 거부, 압축 해제 크기 상한 | `auth.json`·CODEX_HOME·환경 변수 읽기, 작업 레인 비신뢰 코드, `shell_environment_policy`, egress 프록시, 같은 파드 프로세스의 제어 끝점 호출, 세션 디렉터리 격리, 남은 프로세스 blocked: 실제 작업자 파드 없음(T16b·T18), 인증 파일 분리·작업별 세션 저장 공간 결정 대기(ARCHITECTURE §5.1). **이 사례가 통과하기 전에는 T17이 모델을 부르지 않는다** |
| DATA-01 | mock / pass(출력 분류·입력 분리). **세션 파일 사례 blocked** | `output_classification`: 내부 표식(runtime policy `review.internalMarkers`)·GitHub·OpenAI 토큰·개인 키·tailnet 주소·Tailscale 주소·refresh_token이 있으면 `restricted` → 공개 PR 게시 차단, Discord에는 원문 없는 안내만. 게시 직전 현재 정책으로 재분류. 리뷰 입력에 Discord 대화 없음, Discord 요약에 모델 문장 없음. 모델 문장과 PR 파일 경로의 멘션·HTML 주석·코드 칸 깨기 무력화 | 다른 작업·대화 레인의 세션 파일을 읽어 결과에 넣는 경로 blocked(작업별 세션 저장 공간 결정 대기, ARCHITECTURE §5.1, T18) |

### PR 자동 리뷰 품질 측정 (`04` §6, fake 리뷰어)

고정 출력 fake 리뷰어라 모델 품질 수치가 아니다. 하네스가 정답을 모델 입력과 분리해 판정하고 미검토를 드러내는지만 보인다(`test/pr-review.test.ts` "REVIEW-01 평가 하네스"). 실제 평가셋은 D-14 차단 조건이 풀린 뒤다.

| 평가 PR / head SHA | 알려진 정답·근거 | 유효 지적 | 오탐 | 알려진 문제 누락 | 중복/스타일 잡음 | 미검토 범위 표시 | 시간/호출량 |
|---|---|---|---|---|---|---|---|
| fixture normal / 시험용 SHA | 정상(주석 한 줄 추가) | 0 | 0 | 0 | 0 | 없음(completed) | fake 1회, 시간 not_run |
| fixture bug / 시험용 SHA | `src/app.ts:2` 0으로 나누기 | 1 | 0 | 0 | 0 | 없음(completed) | fake 1회, 시간 not_run |
| fixture Renovate 의존성 갱신 / 시험용 SHA | 정상 버전 갱신, 본문에 릴리스 노트 지시 | 0 | 0 | 0 | 0 | `package-lock.json` large_lockfile(partial) | fake 1회, 시간 not_run |
| fixture noisy / 시험용 SHA | 정상, fake가 근거 없는 지적 1건 | 0 | 1 | 0 | 0 | 없음(completed) | fake 1회, 시간 not_run |

### T17 남은 것

- (r2에서 해소) 리뷰 작업의 `waiting_user` 해제: `Store.control`에 리뷰 전용 명령(`review-status`·`review-resume`·`review-cancel`)과 별도 권한 검사(현재 정책 owner가 알림 채널에서 보낸 명령)를 추가했다. 실제 Discord 슬래시 명령 등록과 실연동 확인은 T16b다.
- 실제 GitHub 리뷰 App 경로(설치 토큰 발급, REST 어댑터, `pull_request`·`issue_comment` 수신 연결)와 실제 작업자 프로세스(codeload 받기, 모델 실행)는 아직 없다. 리뷰 레인 작업자 HTTP(`src/review-http.ts`)는 loopback 시험까지다. 게시 서버 HTTP의 webhook 경로 연결은 `src/http.ts`(T16a 소유) 변경이라 하지 않았다.
- HANDOFF는 private 운영 저장소 몫이다(D-13). 이번 반환 보고가 그 원문이다.

## MEMORY_BRIEFING T20 실행 결과 (2026-10-29)

로컬·mock 범위다. 기준은 `origin/main` `bf6a8e9`, 브랜치 `feat/t20-memory-briefing-local`이다.
`npm run check` 통과. `npm test`(기본)는 **333 tests / 331 pass / 0 fail / 2 skipped**다(T16a 기준선 276 + T20 57). 건너뛴 2개는 실제 PostgreSQL이 필요한 경합 시험이고, 소켓 디렉터리를 `HOMELAB_TEST_PG_SOCKET`으로 주고 실행하면 **333/333 pass**다(rev-pr8 수정 뒤 3회 반복 모두 통과, 그 전 329개 기준 8회 반복 모두 통과).
실행 환경은 Node 24.22.1(로컬 셸 실측, `package.json` engines는 24.22.0), TypeScript 7.0.2, PGlite 0.5.10이다. 시험 코드는 `test/memory-briefing.test.ts`(PGlite)와 `test/memory-briefing-pg.test.ts`(실제 PostgreSQL 경합)다. PG 시험은 로컬에 이미 있던 `postgres:18-alpine` 이미지(PostgreSQL 18.6)를 `--pull=never --network none`, 데이터 tmpfs, 유닉스 소켓 디렉터리 바인드로 띄워 실행했고 외부 네트워크·연동은 없다.
R2·Discord·모델·플랫폼은 호출하지 않았다. 삭제 원장은 로컬 파일 대역(`FileDeletionLedger`), Discord는 T16a 모의 REST,
백업 복원은 PGlite 디스크 디렉터리 복사로 흉내 냈다. 이 단계에 배정된 보안 경계 시험은 없다(spec §7).
T16a 표의 AUTH-02 "예약/기억 접근 not_run"은 아래 T20 행으로 채운다. 질문 접근은 여전히 T18이다.

| 시험 ID | 등급 / 판정 | 확인한 경계 | 남은 검증 / 해소 티켓 |
|---|---|---|---|
| MEM-01 | local_integration / pass(오른쪽 경계로 한정) | 출처 없음·접근 불가 출처·저장 제외 출처 거부, 저장 제외는 이미 저장한 기억도 다음 접근부터 빼고 충돌 판정에도 넣지 않음, 충돌이 생긴 뒤 한쪽을 저장 제외하면 그 충돌 표시만 사라지고 다른 유효한 충돌 표시는 남음, 채널 저장 제외는 그 채널 작업을 출처로 한 기억에도 적용, 만료된 기억과 원장에서 삭제를 본(정리 전) 기억은 충돌 판정·표시에서 제외, 종류별 근거 출처가 없으면 candidate와 검색의 미확인 표시, 다른 결정자의 결정은 확인된(verified) 문서 출처가 있어야 active(owner 대화에 revision 없는 문서·미확인 문서를 더해도 candidate), 성공한 작업만 장애 근거, 비신뢰 PR 댓글의 정책 변경 지시는 candidate로만 남고 정책·권한 불변·정책 필드 거부, 같은 주제의 충돌은 양쪽 표시와 사유 있는 정정으로 정리·색인 갱신, 일시 지시의 유효기간 필수·만료 뒤 제외, 재확인 표시 | 충돌 상대가 만료·저장 제외·삭제로 사라져도 기존 candidate를 자동으로 active로 올리지 않는다(정정 필요, 설계 한계). 기억을 모델 맥락으로 넘기는 경로는 아직 없다(연결 때 untrusted 표시 필요, not_run). 실제 문서 출처 확인기 blocked, T16b |
| BRIEF-01 | local_integration / pass (로컬 경로). 실제 채널 전송 blocked | 08:50 Asia/Seoul에만 한 번(UTC 08:50·08:49:59에는 없음), 시각·시간대 누락·오류면 예약 끔, 중복 tick·두 인스턴스 호출에서 한 번(PGlite 직렬), 알림 채널 설정이 바뀌면 다음 회차는 현재 채널로(작성 중 변경은 다시 작성), 디스크 DB 재시작 뒤 중복 없음, 작성 중 중단은 lease 만료 뒤 한 번, 3일 중단 뒤 최신 한 건과 누락·지연 표시, 큐에 넣고 보내지 못한 지난 회차는 재시작 뒤 막고 누락 처리, 12시간 넘게 늦거나 못 보낸 회차 미발송, 모델 비상 중지 중에도 모델 호출 0회로 한 번, 읽기 불가·오래된 관측·형식 오류(소수 시각 포함)는 미확인과 마지막 정상 수집 시각, 백업과 복원 검증 구분, 전달 실패는 다음 브리핑에 안내하고 재전송 없음, 원장 재적용 전 기억 칸 미확인 | 실제 Discord 브리핑 채널 전송(`authorized_external`) blocked: 배포된 봇·Discord 서버 필요, T16b. 실제 백업·인증서·예약 작업 관측 원본, 실제 시계·프로세스 재시작, PostgreSQL 다중 연결 blocked, T16b. Codex 작업 상태·승인/질문 대기 칸 not_run, T18 |
| DATA-02 | local_integration / pass(오른쪽 경계로 한정) | 저장 제외와 브리핑 큐 등록이 겹쳐도(어느 쪽이 먼저 시작하든, 실제 PostgreSQL 18.6 다중 연결) 제외된 기억을 보내지 않음, 원장 기록 확인 뒤에만 DB 정리·완료 응답(원장 append 시점에 DB는 아직 active), 원장 디렉터리 fsync를 확인하지 못하면 미완료·확인 뒤 정리(장애가 이어지는 중 새 원장·새 서비스로 재기동해도 원장 재적용과 삭제 재요청 모두 완료로 올리지 않고 숨기기만 함, 복원으로 삭제 요청 행이 없어도 같음), 삭제 전 백업 복원·최신 회차 대기 브리핑·디렉터리 장애에서 정상 기동해도 지운 기억을 보내지 않고 확인 뒤 기억·사본 본문 정리, 원장 기록 실패로 미완료인 삭제도 대기 사본 발송 차단, 원장을 읽지 못한 기동은 기억이 든 대기 사본 모두 차단, 재적용 정리가 일회성 DB 오류로 실패해도 다음 resume이 마무리, 내용·색인 비움·감사에 내용 없음, 원장 쓰기 실패는 미완료 응답·숨김·재시도, 응답 유실은 원장 재조회로 판단하고 못 읽으면 미완료, DB 정리 실패는 미완료·숨김·재기동 재적용, 삭제 전 디스크 DB 백업으로 복원해도 기동 때 재적용하고 그 전에는 조회 닫힘, ID가 같아도 `created_at`이 다르면 지우지 않음, 원장을 못 읽으면 닫힘, 끊긴 마지막 줄 무시·중간 손상 닫힘, 지운 기억이 든 대기 브리핑과 게시자가 잡았지만 아직 보내지 않은 브리핑 차단, 발송 시작 뒤 429로 돌아온 브리핑도 다시 보내지 않음, 끊긴 조각이 있는 원장에 동시 append해도 항목 보존(100회×5), 작성 중에 지운 기억은 큐에 넣지 않고 다시 작성, 큐에 넣은 뒤 정정·저장 제외·삭제하면 발송 전 브리핑을 막고 새 revision으로 다시 작성, 이미 보낸 브리핑은 지우지 않았다고 안내 | 원장 저장소·자격·보존은 결정 대기([DECISIONS](DECISIONS.md) T20). 실제 R2 append와 CNPG 백업 복원 blocked, T16b(결정 뒤). PGlite 디렉터리 복사는 CNPG 복원 절차를 검증하지 않는다. 정정·삭제 요청과 큐 등록의 겹침(기억 행 잠금과 `FOR SHARE`)은 저장소 시험이 아니라 리뷰어 탐침으로만 확인했다. 게시자를 원장 재적용·첫 tick 전에 시작하는 기동 순서 위반은 코드로 막지 않는다(진입점 T16b). 실제 전원 차단·writeback 오류는 실행하지 않았다. 파일 fsync 실패를 본 원장 인스턴스에서는 요청 행 없는 복원 항목이 자동으로 끝나지 않는다(삭제 재요청·재기동 필요) |
| AUTH-02 (T20 부분) | local_integration / pass | 기억 저장·검색·정정·삭제마다 현재 정책 재인가(owner 교체·DB 철회·5분 stale 차단), 다른 채널 누출 차단, 서비스 철회는 다음 접근부터 숨김, 서비스·guild 권한과 원장 숨김은 검색·재확인 조회의 개수 제한 전에 적용(철회·변경된 기억이 앞자리를 채워도 접근 가능한 기억이 검색·브리핑에서 빠지지 않음), 예약 브리핑은 발송 시점 철회와 작성 중 철회(큐 직전 재인가) 모두 blocked·감사, 큐에 넣은 뒤 owner 교체는 게시자가 차단, 정책 확인 불가 동안 미루고 확인 뒤 한 번 | 질문 접근 not_run, T18. 실제 Infisical/ESO 전달 blocked, T16b |

새 시험은 프로세스 `TZ`를 `UTC`·`America/Los_Angeles`·`Pacific/Chatham`으로 바꿔 다시 돌려도 모두 통과했다(예약 계산이 서버 시간대와 무관).
PGlite는 transaction을 직렬화한다. 실제 PostgreSQL 다중 연결 경합 중 저장소 시험으로 검증한 것은 저장 제외·큐 등록 공통 잠금(두 순서)뿐이다. 브리핑 claim의 `FOR UPDATE`, 정정·삭제와 `FOR SHARE`, 같은 주제 advisory lock 효과는 저장소 시험으로 검증하지 않았다(작성 중 삭제 차단은 2차 리뷰어 탐침으로만 확인, 나머지는 blocked, T16b).
독립 리뷰 두 번(읽기 전용 에이전트)의 지적을 반영했다. 1차는 P1 1건·P2 4건·P3 5건, 2차(수정 커밋 대상)는 P2 2건·P3 3건이다. 2차 리뷰어는 로컬 PostgreSQL 18 컨테이너로 다중 연결 탐침을 돌려, 작성 중 삭제 차단(`FOR SHARE`)이 세 가지 겹침 순서 모두에서 닫힘을 확인했다(저장소 시험 증거는 아님). 회귀 시험 9개는 고친 줄을 하나씩 되돌리면 각각 실패함을 확인했다. fsync 실패 뒤 판정과 주제 잠금 순서는 시험으로 재현하지 못했다(코드 검토만).
실제 PostgreSQL에서 bigint가 문자열로 오는 경로는 코드에서 `Number()`로 바꾸지만 실서버로는 실행하지 않았다.
기억 저장·검색·삭제를 Discord 명령으로 여는 연결과 기동 순서(원장 재적용 → 브리핑 예약 확인 → tick으로 지난 회차 정리 → 게시자 시작)의 진입점은 아직 없다(T16b). 게시자가 tick보다 먼저 돌면 지난 회차 정리를 앞지를 수 있다.

**재판정(Codex 리뷰 rev-t20 반영, 2026-10-29):** rev-t20은 312/312 시점의 MEM-01·DATA-02·BRIEF-01 pass가 P1 1건(원장 디렉터리 fsync 실패를 기록 성공으로 판정)과 P2 4건(정정·저장 제외의 대기 브리핑 미반영, 재시작 때 지난 회차 대기 outbox 발송, 작업 출처의 채널 저장 제외 누락, 만료 기억의 충돌 잔류)을 포함하지 않는다고 지적했다. 실패 경로를 재현하는 회귀 시험 7개를 먼저 넣어 `e1f2183`에서 7개 실패(36 pass / 7 fail)를 확인했고, 수정 `0573041`에서 모두 통과했다. 수정 줄을 하나씩 되돌리면 해당 시험이 다시 실패한다. 위 표의 판정은 이 수정과 회귀 검증 뒤 다시 매긴 것이다.

**재판정(Codex 재리뷰 rev-t20b 반영, 2026-10-29):** rev-t20b는 rev-t20의 P2 4건을 해결로, P1을 부분 해결로 판정하고 잔여 P1을 재현했다. 디렉터리 fsync 장애가 이어지는 중 새 `FileDeletionLedger`·`MemoryService`로 `open()`하면 원장 줄을 확인 없이 재적용해 삭제를 완료로 올렸다. 이에 따라 DATA-02는 수정 전까지 **fail**이었다. 재기동 경로를 그대로 재현하는 회귀 시험 2개를 먼저 넣어 `b6ec764`에서 실패(43 pass / 2 fail)를 확인했고, 수정 `0b75036`에서 원장 계약에 `durable()`을 더해 확인 전에는 숨기기만 하도록 고친 뒤 모두 통과했다. 기동 재적용·삭제 재요청·원장 디렉터리 확인을 하나씩 되돌리면 해당 시험이 다시 실패한다. 위 표의 DATA-02 pass는 이 수정 뒤의 판정이다. 파일 fsync가 한 번 실패한 뒤 커널이 실패한 페이지를 clean으로 돌리는 경우는 재부팅 전까지 캐시만 보일 수 있다는 한계가 남는다. 파일 fsync 실패를 본 원장 인스턴스는 기존 내용을 `durable`·`has`로 다시 확정하지 않지만, 새 인스턴스는 그 표시를 물려받지 않고 그 fsync 성공은 이 한계를 넘지 못한다. 새 항목의 append 성공은 별도로 그 항목의 기록으로 인정한다. 실제 디스크 오류·전원 차단은 실행하지 않았다.

**재판정(Codex 재리뷰 rev-t20c 반영, 2026-10-29):** rev-t20c는 rev-t20b P1을 해결로 판정하고 새 P1 1건(내구성 미확인 기동 때 복원된 대기 브리핑 사본 발송)과 P2 1건(재적용 정리 전 재시도 상태 해제)을 재현했다. 이에 따라 DATA-02는 수정 전까지 **fail**이었다. 같은 경로(원장·복원·대기 사본)를 다시 훑어 자체 점검으로 세 건을 더 찾았다: 원장 기록 실패로 미완료인 삭제의 대기 사본 발송(G1), 원장을 읽지 못한 기동의 대기 사본 발송(G2), 정리 전 숨긴 기억의 충돌 판정 참여(G3). 리뷰어의 재현 순서(삭제 전 백업 복원 + 최신 회차 대기 outbox + 디렉터리 sync 장애 + 정상 기동 순서)를 포함한 회귀 시험 5개를 먼저 넣어 `9aadfbb`에서 실패(45 pass / 5 fail)를 확인했고, 수정 `bebe34e`에서 모두 통과했다. 발송 차단과 본문 삭제·완료 승격을 분리했으며, 확인 전에 정리하도록 되돌리는 변이는 rev-t20b·rev-t20c 시험이 잡는다. 수정 줄을 하나씩 되돌리면 해당 시험이 다시 실패한다. 위 표의 DATA-02 pass는 이 수정 뒤의 판정이다.

**재판정(Codex 재리뷰 rev-t20d 반영, 2026-10-29):** rev-t20d는 rev-t20c의 P1·P2와 자체 점검 G1~G3을 해결로 판정하고 P2 2건을 재현했다. 저장 제외가 브리핑 큐 등록과 겹치면 제외된 기억이 새 사본으로 나갔고(실제 PostgreSQL 다중 연결), 충돌이 생긴 뒤 한쪽을 저장 제외해도 충돌 표시가 남았다. 이에 따라 DATA-02·MEM-01은 수정 전까지 **fail**이었다. 반례 3개(PG 두 순서, PGlite 충돌 표시)를 먼저 넣어 `401fc49`에서 실패를 확인했고, 수정 `290d47a`에서 모두 통과했다. 저장 제외·큐 등록 직전 확인에 같은 owner별 잠금을 두고 잠금을 얻은 뒤의 새 문장에서 제외 상태를 본다. 잠금 두 곳과 충돌 표시 필터를 하나씩 되돌리면 해당 시험이 다시 실패한다. 위 표의 DATA-02·MEM-01 pass는 이 수정 뒤의 판정이며 각 행 오른쪽 경계로 한정한다.

**재판정(PR #8 Codex Connector 리뷰 1라운드 rev-pr8 반영, 2026-10-29):** rev-pr8은 P2 2건을 지적했고 둘 다 재현했다. (1) `search()`·`recheckDue()`가 `LIMIT 20`·`LIMIT 50` 뒤에 서비스·guild 권한과 원장 숨김을 적용해, 철회된 서비스의 기억이 앞자리를 채우면 접근 가능한 기억이 검색에서 빠지고 브리핑 기억 칸이 "없음"으로 나갔다(누출이 아니라 누락). 같은 종류의 빈틈인 guild 변경·원장에서 본 삭제(정리 전) 기억도 함께 재현했다. (2) 다른 결정자의 결정은 문서 출처의 존재만 확인해, owner 대화에 revision 없는 문서나 확인기가 unverified로 답한 문서를 더하면 active가 됐다. 이에 따라 MEM-01은 수정 전까지 **fail**이었다. 회귀 시험 4개를 먼저 넣어 `df10ede`에서 4개 실패를 확인했고, 수정 `b7a5164`에서 모두 통과했다. 권한·숨김 조건은 LIMIT 전 SQL로 옮기고 뒤의 `visible()` 필터는 그대로 두었다. 서비스·guild·숨김 조건과 문서 확인 조건을 하나씩 무력화하면 해당 시험만 다시 실패한다. 실제 PostgreSQL 18.6에서 333/333 pass(3회)다. 위 표의 MEM-01·AUTH-02 pass는 이 수정 뒤의 판정이며 각 행 오른쪽 경계로 한정한다. `recheckDue()`의 `total`은 여전히 50건에서 멈춘다(브리핑의 "외 N건"은 최대 45건, 기존 설계).

## CODEX_BRIDGE T18 실행 결과 (2026-10-29, 로컬·mock)

- 기준: 브랜치 `feat/t18-codex-bridge-local`(origin/main `bf6a8e9` 위, PR #9). 구현은 [ARCHITECTURE.md](ARCHITECTURE.md) §12, 결정 대기는 [DECISIONS.md](DECISIONS.md) "T18 결정 대기 (사용자)".
- `npm run check` 통과, `npm test` **347 tests / 347 pass / 0 fail**(T16a 기준선 276 + T18 71, 시험 파일 `test/codex-bridge.test.ts`). PR #9 리뷰 1라운드 수정 뒤 전체 실행을 연속 3회 반복해 모두 통과했다. Node 24.22.0, TypeScript 7.0.2, PGlite 0.5.10.
- **실제 `codex` 실행과 모델 호출은 하지 않았다**(D-14 차단 조건). Codex 자리는 (1) JSONL fixture를 내보내는 fake launcher, (2) 같은 인자·stdin·환경으로 도는 로컬 node 스크립트다. JSONL fixture는 공식 문서의 이벤트 형태로 합성했고 실제 CLI 녹음이 아니다. 개인 `~/.codex*`, Discord, GitHub, 네트워크에 닿지 않았다.
- 등급: `mock`은 봇 쪽 실제 코드(Store·Runtime·PolicyGate·DiscordPublisher, PGlite)에 Codex 자리만 fake다. `local_integration`은 실제 로컬 프로세스·파일시스템·git·디스크 DB 재시작을 포함한다.
- **판정 갱신(rev-t18 r1·r2 반영 뒤, 2026-10-29):** 독립 Codex 리뷰 r1의 P1 3항목(S1·R2 같은 결함, R1)과 P2 4항목(S2·S3·R3·R4)을 r1 반영에서 고쳤으나, 재리뷰 r2 판정으로 S1·R2와 R4는 다른 유효 입력에서 깨지는 부분 수정이었다. r2의 N1~N5와 스스로 찾은 같은 종류 3건을 r2 반영에서 고쳤다. 재리뷰 r3은 N1~N5를 해결로 판정했지만, r2 자체 점검의 파일 읽기 보호는 마지막 경로 요소에만 적용되는 부분 수정이었다(N6·N7). r3 반영에서 고정 디렉터리 핸들로 고쳤다. 세 번 모두 회귀 시험을 먼저 넣어 수정 전 실패를 확인했다(아래 "r1 반영", "r2 반영", "r3 반영").
- **보안 경계 SEC-02는 이 경로에서 로컬로 시험할 수 있는 부분만 pass다.** 작업 레인 비신뢰 코드의 `auth.json` 읽기 격리와 세션 디렉터리 격리는 사용자 결정과 T16b 실측 전이라 `blocked`다. 그래서 T18 완료 조건(SEC-02 pass, R08 사용자 결정)은 아직 채우지 못했다.

| 시험 ID | 등급 / 판정 | 확인한 경계 | 남은 검증 / 해소 |
|---|---|---|---|
| TASK-01 | mock / pass (봇 소유 경로·능력 표시). R08 사례 blocked | Discord task → exec → 결과·증거 기록 → outbox → 게시, `codex_sessions` 소유 기록(외부 스레드·실행 호스트·능력표), 능력표(tool approval false, attach 미정), 타인·다른 스레드·미등록·대화 작업의 상태 조회 거부, 지시·답은 stdin, 위험 플래그 없음, `-`로 시작하는 스레드 ID 거부 | R08 명시적 연결 사례 blocked(사유: 연결 방식 사용자 결정 대기. 해소: DECISIONS "T18 결정 대기" (1) 결정 뒤 T18). 실제 `codex exec` blocked(T16b, D-14) |
| TASK-02 | mock / pass | 질문 ID `job:thread:turn`, owner만 답함, 다른 스레드·다른 사람·바뀐 owner 거부, 같은 이벤트 재전달은 한 번만 반영, 두 번째 답·이어 간 질문·기한 지난 질문·취소된 작업의 질문 거부, 만료 때 cancelled·알림·슬롯 해제(Runtime `sweep`), 답·만료 정리의 잠금 순서가 T16a 제어 경로와 같음(대화 행 → 스케줄러 행, PR #9), 질문 대기 중 비상 중지 해제 뒤 답하거나 만료되면 스케줄러도 풀림, 작업당 열린 질문 하나, 도구 승인 종류 질문 DB 거부, migration 009 반복 적용 | Discord `/answer` 명령 연결 not_run(T16a 소유 ingress 변경 필요, ARCHITECTURE §12 "T16a 소유 변경 요청" 2번). 이 시험은 브리지를 직접 불러 ingress 중복 제거·순서를 거치지 않는다. 실제 `exec resume` blocked(T16b) |
| TASK-03 | mock(JSONL fixture) / pass. 프로세스 정리·예산·출력 상한은 local_integration / pass(한계 기록) | 세션 전·긴 메시지 뒤쪽의 인증·한도 오류도 대기(r1 S1·R2, r2 N1), 축약이 판정 필드를 자르지 않음(r2 N2), 재개 예산 소진 뒤 /retry는 새 스레드(r2 N3), 옛 009 DB 업그레이드(r2 N4), git과 같은 소유자 실행 비트(r2 N5), 준비 중 중단·해제된 작업은 늦게 준비가 끝나도 프로세스를 띄우지 않음(r1 R1), 도구 호출 예산을 실행 중 집행하고 질문 뒤 재개까지 합산(r1 S2), 한 줄·전체 출력·이벤트 수 상한(r1 S3), 첫 턴 한도 대기 뒤 같은 스레드 재개(r1 R3), 실행 비트 변경도 diff(r1 R4), 루트 `__proto__` 파일의 생성·수정·삭제도 diff(PR #9), "완료" 문자열·로그 속 가짜 이벤트·idle 무시, 종료 코드·`turn.failed`·스키마 밖 출력·스트림 손상·스레드 불일치, 게시 변경 목록은 실제 diff 기준(보고만 있는 파일은 증거로 표시, 셸 변경도 보고, 작업 공간 밖 변경 보고는 실패, 일시 error 뒤 완료는 유지), 취소는 소멸 확인 뒤에만 cancelled, 남은 프로세스 → unknown·막힘 알림·새 실행 차단·owner 해제(0개 재확인), 중단 뒤 끝나지 않는 실행 → unknown, 시간 초과 → failed, 작업자 단절·동기 throw → 종료 확인에 따라 failed·unknown, 실행 파일 없음·이미 있는 `.git` 등 실행 전 실패 → 실제 launcher에서도 failed, 재개 실패를 새 스레드로 바꾸지 않음, 한도 도달 → 대기·재개 때 같은 답으로 같은 스레드(시도 한도면 /cancel 안내), 디스크 DB 재시작 뒤 막힘 유지, 실제 프로세스에서 정상 종료 뒤 배경 자식·새 세션 자식 정리, 못 읽는 새 프로세스는 확인 불가(unknown) | 환경을 지우고 새 세션으로 빠져나간 dumpable 자식은 못 찾는다(시험으로 기록, 그 시험은 자식이 살아 있는데 `completed`임을 확인한다). 그래서 이 시험들의 통과는 비신뢰 프로세스 소멸의 보장이 아니고, 소멸 확인 수단의 완전성은 blocked(cgroup 또는 파드 안 제어 프로세스 밖 0개 확인, T16b). 도구 예산은 초과 호출의 시작을 본 즉시 끝내지만 그 한 호출의 일부 효과는 남을 수 있다(CLI 제한 플래그 [미확인]). codex의 SIGTERM 동작·종료 코드, 실제 오류 순서·출력 크기 blocked(T16b) |
| SEC-02 | 부분: mock·local_integration / pass. `auth.json` 읽기 격리·세션 디렉터리 격리 blocked | `shell_environment_policy` inherit=none 설정 생성, `[projects]` 신뢰 없음, 남은 프로세스가 있으면 결과·인증·작업 공간을 읽지 않음, 실행 뒤 읽기는 실행 전에 고정한 디렉터리 핸들 아래에서만 하고, 확인 시점에 `run`·`workspace`·작업 디렉터리가 바깥 심링크로 바뀌어 있으면 본문 읽기 0회로 실패(정적 교체 재현, r4 N8), 작업 공간 루트 심링크·순회 중 심링크 교체·하드링크·FIFO를 따라가거나 읽지 않음, 크기 확인 뒤 커지는 파일도 실제 읽은 바이트로 상한(N7), codex 실행 환경 허용 목록(실제 프로세스에서 작업자 환경의 Discord·OpenAI·시드 값 미상속), 이전 턴 출력 파일 삭제, 개인 `~/.codex*` 아래·위 루트와 심링크·루트 아래 심링크 거부, 실행 중 접근 경로가 작업자 루트 밖으로 나가지 않음 | 작업 레인 비신뢰 코드의 `auth.json` 읽기 → 거부: blocked(사유: 같은 UID라 지금 구조로는 읽힌다. 해소: DECISIONS "T18 결정 대기" (2) 결정 + T16b 실측). 다른 작업·대화 세션 디렉터리 읽기: blocked((4) 결정 + T16b). Codex가 정책을 실제로 적용하는지(모델 셸 환경): blocked(T16b, codex 실행 필요). `codeload.github.com` 밖 GitHub 차단: blocked(T16b egress). 제어 끝점 호출 거부: 이 경로 not_run(T16a capability 시험이 기준). `auth.json` 값 반사 차단은 best-effort 보완책이라 pass 근거에 넣지 않는다. 실행 뒤 읽기 경계는 같은 UID 안의 경로 경계다. 고정 디렉터리 안의 내용 위조(결과 파일 직접 쓰기), codex 자신의 경로 읽기와 다른 살아 있는 프로세스의 경합, 원래 디렉터리를 제자리로 되돌린 교체(사후 확인으로 탐지 불가, r4 N9 한계 기록 시험), 마운트 변경은 막지 못한다(ARCHITECTURE §12 "실행 뒤 파일 읽기 경계", 별도 UID·마운트 namespace는 결정 대기 (2)·(4)와 T16b) |
| AUTH-02 (질문 경로) | mock / pass | 답 직전 owner 교체·즉시 철회는 Denied, 정책 만료는 PolicyUnavailable(질문·작업 상태 불변), 답 수락 뒤 철회는 재개 전 cancelled, 실행 중 철회는 소멸 확인에 따라 cancelled·unknown, 마지막 모니터 검사 뒤 철회·owner 교체도 결과 확정 전 재인가로 완료·질문·한도 대기 대신 cancelled·스케줄러 정지 없음(PR #9), owner가 바뀌어 남은 막힘은 옛 owner가 못 풀고 현재 owner만 0개 확인 뒤 해제 | 실제 Infisical·ESO 반영 blocked(T16b) |
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
- **PR #9 Codex Connector 리뷰 1라운드 반영(지적 3건, 모두 수용):** 회귀 시험(`test/codex-bridge.test.ts`)을 먼저 넣어 수정 전 실패를 확인했다(커밋 `db5e5fa`, 346개 중 343 pass·새 3건 fail). 재인가 예외 처리 시험(:1302)은 그 뒤 더해 수정 전 실패를 따로 확인했다.
  - 4407854998 [P1] 결과 확정 전 재인가: :1278(owner 교체·즉시 철회 × 완료·질문·한도 6사례. 모니터가 실행 중 돌지 않게 해 마지막 검사 뒤 철회만 남김 → `cancelled`·`authorization_revoked`, 결과·질문·outbox 없음, 스케줄러 정지 없음). 수정 전에는 `succeeded`·`waiting_user`였다(6사례 모두 따로 확인). :1302(재인가가 정책 밖 오류면 `failed`(`codex_monitor`)로 결과를 기록하지 않음, 정책 만료(`PolicyUnavailable`)는 `Runtime.tick`처럼 진행하고 게시 직전 재인가에 맡김).
  - 4407855007 [P2] `__proto__` 파일 이름: :1321(스냅샷·`changedPaths`·기준 JSON 왕복, 실제 브리지에서 실행 전부터 있던 `__proto__` 삭제와 새로 만든 `__proto__`가 결과 변경 목록에 들어감).
  - 4407855013 [P2] 질문 만료 정리의 잠금 순서: :1377. PGlite는 연결이 하나라 교착을 재현할 수 없어, 트랜잭션마다 잠금 문장 순서를 기록해 Runtime 정리·답 경로가 T16a `/model-status`와 같은 순서(대화 행 → 스케줄러 행)인지 본다. 이 시험은 `mock`이다. 실제 교착은 로컬 PostgreSQL 18.6(네트워크 없는 컨테이너, 시험 스위트 밖 일회성 재현)에서 확인했다. `/model-status`가 대화 행을 잡은 사이 만료 정리·기한 지난 답이 스케줄러를 잡으면, 수정 전에는 만료 쪽이 `55P03`(잠금 시간 초과)으로 롤백되고 질문이 열린 채 남았다. 수정 뒤에는 두 트랜잭션이 모두 끝나고 작업이 `cancelled`(`question_expired`)·알림 1건이 됐다. 같은 재현에서 T16a `accept()`도 같은 역전으로 롤백됐다(ARCHITECTURE §12 "T16a 소유 변경 요청" 6번, 바꾸지 않음).
  - 수정 뒤 71/71, 전체 347/347을 3회 연속 통과.
- 시험 중 잡은 결함: `-`로 시작하는 스레드 ID가 재개 인자 검사를 통과하던 것(첫 실행 1건 실패 뒤 수정), 질문 기록 SQL의 매개변수 타입 추론 오류(9건 실패 뒤 수정).
- 독립 리뷰 1회(읽기 전용 에이전트): 13건(P1 1, P2 6, P3 6). 12건을 고치고 회귀 시험을 더했다. 남은 1건은 Discord 명령 연결이고, T16a 소유 ingress 흐름을 바꿔야 해서 변경 요청으로 남겼다. 리뷰가 고친 판정: 알림 없는 unknown, 해제할 수 없는 unknown, environ을 못 읽는 프로세스를 0개로 세던 것(fail-open), diff 대조 없음, 한도를 failed로 보던 것, 반사 검사 우회·오탐.
- 2차 독립 리뷰(1차 반영 커밋 대상): 8건(P1 1, P2 3, P3 4)을 모두 고치고 회귀 시험을 더했다. 리뷰가 고친 판정: 실제 CLI가 `file_change` 경로를 절대 경로로 내면 정상 완료가 모두 실패하던 것([미확인] 형식이라 보고 차이는 증거로만 남김), 생존 프로세스가 있을 때 작업 공간 읽기, 스케줄러 잠금 순서, 실행 전 실패가 개발 기계에서 전역 unknown이 되던 것, 대기 알림 조건, 일시 error 이벤트, pgid 재사용, 이미 있는 `.git`.
- 반영 중 시험 fixture의 JWT 헤더·payload 끝이 우연히 같아 반사 검사가 오탐한 1건은 fixture를 실제 모양으로 고쳤다. non-dumpable 시험은 처음에 고정 300ms 대기에 기대 반복 실행 중 1회 흔들렸고, 준비 파일을 기다리게 고친 뒤 전체 3회 연속 통과했다.

## T16b 선행 보안 수정: capability nonce 정규화 (2026-10-30, 로컬)

- 기준: 브랜치 `fix/t16b-capability-nonce`(origin/main `1dba78e` 위). PR #5 Codex 리뷰 지적 4316750309의 이월분이다(구현은 [ARCHITECTURE.md](ARCHITECTURE.md) 작업자 제어 인증).
- `npm run check` 통과, `npm test` **489 tests / 487 pass / 0 fail / 2 skipped**(새 시험 3개 포함, 건너뜀 2개는 로컬 PostgreSQL 소켓이 필요한 기존 DATA-02 PG 시험). Node 24.22.2, TypeScript 7.0.2, PGlite 0.5.10. 외부 서비스 호출 없음.

| 시험 ID | 등급 / 판정 | 확인한 경계 | 남은 검증 / 해소 |
|---|---|---|---|
| SEC-02 (capability 재생) | local_integration / pass | execute·cancel capability를 한 번 쓴 뒤 같은 payload·서명 바이트의 다른 base64url 표기(`=`·`==`·`!` 덧붙임, 중간 `!`, 표준 base64 `+/`, 서명 끝 글자의 남는 비트, payload 뒤 `=`)로 다시 보내면 거부, 비정규 표기를 먼저 보내도 nonce를 쓰지 않음, 작업자 HTTP(loopback)는 변형 재전송에 403·실행 1회. 수정 전 같은 시험 3/3 fail(정상 1회 뒤 서명 변형이 모두 통과, HTTP 200으로 같은 작업 재실행) | 재시작 뒤에도 남는 원자적 nonce 저장소, T16b |

## T16b 게시 서버 진입점 (2026-10-30, 로컬·mock)

- 기준: 브랜치 `feat/t16b-publisher-entry`(origin/main `3fb389a` 위). 결정은 [DECISIONS.md](DECISIONS.md) "T16b 결정"(D1·D6·D8). 실제 Discord·Grafana·Argo CD·클러스터·모델에는 연결하지 않았다.
- `npm run check` 통과. `npm test` **548 tests / 540 pass / 0 fail / 8 skipped**(건너뜀 8개는 `HOMELAB_TEST_PG_SOCKET`이 필요한 실제 PostgreSQL 시험, 새 4개 포함). 로컬 `postgres:18-alpine`(PostgreSQL **18.6**, `--pull=never --network none`, 데이터 tmpfs, 소켓 디렉터리 바인드)을 주면 **547/547 pass**를 3회 연속, 등록 재시도 시험을 더한 마지막 상태에서 **548/548 pass**를 확인했다. Node 24.22.2, TypeScript 7.0.2, PGlite 0.5.10.
- 흔들림: 전체 병렬 실행에서 T18 실제 프로세스 시험(`S2`·`S3`·`SEC-02`)이 19회 중 4회 한 건씩 실패했다(단독 실행은 매번 통과). 기준 커밋 `3fb389a`도 4회 중 1회 `TASK-03`이 실패했다. 모두 실제 하위 프로세스와 짧은 실시간 대기(예: `test/codex-bridge.test.ts` `graceMs: 500`)에 기대는 시험이다. 이번 변경은 T18 코드를 바꾸지 않았고 새 시험 파일이 병렬 부하를 늘렸다. Docker test 단계가 같은 시험을 돌리므로 PLAN 위험 13과 같은 문제다.
- 시험 파일: `test/publisher-{migrate,policy,config,read,gateway,main,pg}.test.ts`, 가짜 Gateway `test/fake-gateway.ts`(RFC 6455 최소 구현, 실제 Node 24 WebSocket 클라이언트가 붙음).

| 시험 ID | 등급 / 판정 | 확인한 경계 | 남은 검증 / 해소 |
|---|---|---|---|
| AUTH-02 (D1) | local_integration / pass | env `RUNTIME_POLICIES`를 기동 때 한 번 읽고 300.001초·하루 뒤에도 열림, `confirmedAt`은 읽은 시각(사람이 넣으면 거부), JSON·구조 오류는 기동 실패이고 오류에는 필드 경로만, `/revoke`는 같은 값 재시작에도 유지, 해제는 새 revision + `revocationRestores` + 철회 뒤 기동일 때만. 정책 확인 불가 방어 경로(대기·backoff·heartbeat 유지)는 기존 시험이 명시 스위치로 계속 본다. 수정 전 기동 시각 정책은 300.001초 뒤 `PolicyUnavailable`이었다 | 실제 Infisical → ESO → 파드 재시작 반영, S16 |
| AUTH-01 (명령 범위) | local_integration / pass | 등록이 한 번 실패해도 다음 READY를 기다리지 않고 몇 번 더 시도. 진입점 수신은 FOUNDATION 12개(`chat`·`urgent`·`read`·`stop`·`resume`·`list`·`cancel`·`retry`·`emergency-stop`·`resume-model`·`model-status`·`revoke`)만 받아 `/task`·`/review-status`는 저장·ACK 없음. 등록은 guild 단위 12개, 전역 명령은 비움, 같으면 다시 쓰지 않음. 진입점이 목록을 넘기지 않으면 `/task`·`/review-status`가 저장돼 실패함을 확인 | 실제 Discord 명령 등록·권한, S16 |
| webhook 경로 (D6, 점검 11) | local_integration / pass | `POST /github`은 정책에 리뷰 설정이 있어도 `review_disabled`로 기록하고 202, 서명이 틀리면 401·저장 없음, `GET /github`·그 밖 경로 404(`/readyz`·`/metrics` 제외) | Cloudflare WAF·Traefik 경유 403·401·ping 200, S13 |
| EVENT-03 (Gateway) | mock / pass | 실제 WebSocket 클라이언트 + 가짜 Gateway: `v=10&encoding=json`, IDENTIFY intents 33281(DM 끔. 개선안 v2부터 35329), heartbeat, READY, 끊기면 `resume_gateway_url`로 RESUME(session_id·마지막 seq, IDENTIFY 예산 미사용), ACK 없음·op 7은 4900으로 끊고 RESUME, INVALID_SESSION(false)은 1~5초 뒤 새 IDENTIFY, 4004·4014는 멈춤, `stop()`은 1000으로 닫고 재연결 없음. 진입점은 READY 뒤 활성 스레드를 checkpoint 다음부터 history로 대조하고 gap을 푼다 | 실제 Discord RESUME·재IDENTIFY·중단 중 메시지 `after=` 대조 30초, S16 |
| OPS-01 (IDENTIFY 예산) | local_integration / pass | 24시간 900회가 차면 연결하지 않고 대기(감사 행 수 그대로), `session_start_limit.remaining=0`이면 `reset_after`만큼 대기, Gateway 주소는 discord.gg의 wss만 | 실제 크래시 루프에서 IDENTIFY 수, S16 |
| READ-01 | mock / pass (transport), local_integration / pass (진입점 경로) | Grafana `POST /api/ds/query` 메트릭(uid `victoriametrics`, instant, 계열별 마지막 값)·로그(uid `victorialogs`, 줄 수는 사실, 원문은 1000자로 잘라 untrusted), Argo CD 앱 객체(Healthy·Synced → healthy), Kubernetes Deployment(SA 토큰 요청마다 다시 읽기), HTTP 오류·질의 오류·다른 이름 객체는 관측 불가. 세 transport 모두 `AbortSignal`로 응답 없는 요청과 서버 쪽 연결을 끊음(신호를 빼면 `hung`으로 실패 확인). 진입점에서 `/read` → 스레드 → read 작업 → Argo CD → 결과 게시, 작업자 호출 0 | 라이브 응답 모양, VictoriaLogs 질의 필드 [미확인], S16 |
| READ-02 | mock / pass | transport가 고정 경로 모양만 만든다: `secret/`·`configmap/`·`pods/…/log`·`exec`·경로 조작·`../` namespace·Argo CD 하위 경로·모르는 datasource(`__proto__` 포함)는 요청 없이 거부. 응답 4MiB 초과(선언 길이·chunked)는 끝까지 담지 않고 관측 불가 | 플랫폼 RBAC·Grafana Viewer·Argo CD live ConfigMap 노출, S8·S16 |
| OPS-02 (진입점) | local_integration / pass | 8080·8081은 Discord 연결 전에도 받는다(경보 저장, pending 유지). Gateway 연결·루프가 돌 때 healthchecks ping, `stop()` 뒤 수신 닫힘·재연결 없음. 실제 PostgreSQL 풀로 `/readyz` 200(DB 쓰기) | 실제 healthchecks·Telegram·replicas 0, S16 |
| 위험 5 마이그레이션 | local_integration / pass (PGlite + PostgreSQL 18.6) | 재실행은 적용된 버전을 건너뜀(006이 대기 경보를 다시 막지 않음), 010까지 적용된 기존 DB는 011만, 마이그레이션 Job 셋이 겹쳐도 advisory lock으로 한 번(잠금을 빼면 실패 확인), 목록과 디렉터리·버전 기록 대조. 수정 전 재실행은 대기 경보를 `blocked`로 바꿨다 | 실제 CNPG·Sync hook Job, S10 |
| 설정 | mock / pass | 비밀 8개·주소 4개 중 하나라도 없거나 틀리면 기동 실패, 오류에 키 이름·사유만(값 없음), `PORT`는 8080만, 작업자 키는 Ed25519. 차트의 `sslmode=require`는 node-pg 기본이 verify-full이라 `uselibpqcompat=true`로 libpq 의미(암호화, 검증 없음)로 맞춤 | 실제 차트 env·CNPG 인증서로 연결, S10 |

### 리뷰 1라운드 반영 (rev-pub-r1, 2026-10-30)

리뷰(`3e28b0b` 기준) 발견 6건과 남는 한계 1건을 고쳤다. 항목마다 리뷰어 재현을 회귀 시험으로 옮겨 **수정 전 코드에서 실패**를 먼저 확인했다. `npm run check` 통과, `npm test` **562 tests / 553 pass / 0 fail / 9 skipped**(건너뜀은 PG 소켓 시험), PostgreSQL 18.6 소켓을 주면 **562/562 pass** 3회 연속.

| 발견 | 고친 방식 | 회귀 시험 / 수정 전 |
|---|---|---|
| P1-1 새 READY에서 복구 차례를 기다리는 스레드의 체크포인트가 live 입력으로 올라가 단절 중 메시지 유실 | READY 처리(이벤트 순서 안)에서 live 이벤트보다 먼저 모든 활성 스레드·DM에 `gap=true` 장벽, history 대조는 그 뒤 대화별로 | `P1-1 새 READY: 모든 활성 스레드를 live 입력보다 먼저 막아…`(진입점, 두 스레드 + 동시 live). 수정 전 thread-b history가 `after=300`이고 메시지 200 없음 |
| P1-2 일시적인 history 실패 뒤 재시도 없음(gap 유지, 버퍼 정지) | `RecoveryScheduler`: 대화별 지수 백오프(429·영속 pause는 `retry_after` 이상), `recover()` 결과 `done`·`budget`·`skipped`로 한도 초과(수동 gap)와 구분 | `P1-2 일시적인 history 조회 실패 뒤 새 READY 없이…`, `P1-2 영속 Discord pause 동안은 history를 부르지 않고…`(진입점), 스케줄러 단위 시험 3개. 수정 전 history 1회·`gap=true`·이벤트 `buffered=true, accepted=false`. 재시도를 빼는 변형에서도 진입점 두 시험 실패 확인 |
| P2-3 IDENTIFY 5초 간격 미보장 | `GatewayBudget.reserve()`가 일일 900회와 간격 5.5초(5초 + 지연 여유)를 같은 잠금에서 예약해 audit에 남김(재시작에도 유지). IDENTIFY 직전에 예약하고 그 시각까지 대기, 연결 전 `next()`로 대기·소진 확인, RESUME은 예약 없음. 가짜 Gateway에 Discord처럼 간격 위반 시 op 9를 넣고 모든 Gateway·진입점 시험에서 위반 0을 확인 | `P2-3 IDENTIFY는 일일 예산과 함께 직전 IDENTIFY에서 5초 뒤에만…`(실제 `GatewayBudget` + 가짜 5초 제한), `P2-3 GatewayBudget: 예약은 직전 예약에서 5.5초 뒤…`. 수정 전 간격 위반 4회 |
| P2-4 K8s 이전 세대 상태를 healthy로 판정 | `observedGeneration`이 `generation`보다 작거나 둘 중 하나가 없으면 `unknown` | `P2-4 Kubernetes: 컨트롤러가 최신 세대를 관측하지 않았으면…`(Deployment·StatefulSet 각 5경우). 수정 전 `healthy` |
| P2-5 8081 listen 실패 시 8080이 남아 프로세스가 반쪽으로 생존 | listen 실패면 두 서버·K8s 연결 풀을 닫고 다시 던짐. 진입점은 종료 코드 1, 남은 것이 있어도 5초 뒤 끝내는 안전 타이머(unref) | `P2-5 8081 listen이 실패하면 먼저 연 8080도 닫고…`(수정 전 거부 없이 기동), `P2-5 실제 진입 프로세스: …종료 코드 1로 끝남`(PG, 실제 `dist/src/main.js`, 자식의 fetch·WebSocket은 시험 장치로 막음, 실패 로그 뒤 3초 안 종료 확인. 수정 전 10초 뒤에도 살아 있음) |
| P3-6 정책의 모르는 키 이름이 오류·로그에 실림 | 모르는 키는 `unknown_field(개수)`만, 고정 필드 `confirmedAt`만 이름으로 | `P3-6 정책의 모르는 키 이름은…`. 수정 전 `runtime_policies_invalid: fixture-secret-used-as-key` |
| 남는 한계: `src/gateway.ts`가 외부 오류 `message`를 그대로 로그에 씀 | `gateway_open_failed`·`gateway_event_failed`도 `errorInfo()` 규칙(우리 코드 형식 메시지·code만) | `로그 정제: Gateway 주소 조회 오류…`, `로그 정제: Gateway 이벤트 처리 오류…`. 수정 전 URL·메시지 원문이 로그에 있음 |

### 리뷰 2라운드 반영 (rev-pub-r2, 2026-10-30)

리뷰(`17b738d` 기준) 발견 3건을 고쳤다. 리뷰어 재현을 회귀 시험으로 옮겨 **수정 전 코드에서 7개 모두 실패**를 먼저 확인했고, 고친 부분을 하나씩 빼는 변형에서도 해당 시험이 실패함을 확인했다(원복). `npm run check` 통과, `npm test` **569 tests / 560 pass / 0 fail / 9 skipped**(PG 소켓 없음). PostgreSQL 18.6 소켓 포함은 이 브랜치 5회 중 2회 569/569, 3회는 기존 `TASK-03`(실행 예산 30ms의 실시간 시험) 1건 실패다. 같은 코드의 사본은 3/3 통과했고, 작업자 브랜치의 TASK-03 수정(`bfd8f04`)을 얹은 사본도 3/3 통과했다(호스트 부하에 따른 흔들림, 병합 때 해소).

| 발견 | 고친 방식 | 회귀 시험 / 수정 전 |
|---|---|---|
| P1 새 READY의 장벽·대기 항목을 이전 복구가 풀거나 지움 | 장벽 UPDATE가 같은 문장에서 기존 `recovery_token`을 지워 새 복구 세대를 연다(이전 복구는 토큰이 달라 `skipped`). 스케줄러는 자기가 시작한 대기 항목일 때만 완료·재시도·삭제를 반영 | `R2-1 마지막 정리 중 새 READY…`(수정 전 대기 항목 0), `R2-1 history 처리 중 새 READY…`(수정 전 이전 스냅샷으로 gap 해제), `R2-1 진입점: history 대기 중 새 READY…`(실제 Gateway 재IDENTIFY, 수정 전 메시지 200 유실). 토큰 무효화만 빼면 history 시험, 소유 확인만 빼면 정리 시험이 실패 |
| P2 30초 lease 만료를 재시도 가능한 skipped로 반환 | `recover()`의 확인이 `stale`(토큰·구독 세대 변경)과 `expired`(자기 lease 만료)를 구분, 만료는 페이지·버퍼·checkpoint 어디서든 `budget` + `history_gap` 감사 | `R2-2 history 페이지 처리 중 30초…`(수정 전 `['skipped','skipped','skipped']`), `R2-2 마지막 checkpoint 갱신에서…`, `R2-2 버퍼 처리 중…`(둘 다 수정 전 `skipped`) |
| P2 예약 응답 지연 때 실제 IDENTIFY 간격 위반 | 예약에 전송 창(0.4초)을 두고 창 안에서만 전송, 창을 놓친 예약은 지우고 다시 예약(연결당 3번). 간격 5.5초 = 5초 + 창 + 망 여유 0.1초라 실제 전송 간격 5.1초 이상 | `R2-3 예약 응답이 늦어져도…`(첫 COMMIT 응답 900ms 지연, 가짜 5초 제한. 수정 전 위반 1회). 창 확인만 빼면 실패 |

리뷰가 짚은 시험 흔들림 위험 중 `P1-2 일시적인 history 조회 실패…`의 `calls === 1` 폴링은 `calls >= 1`로 바꿨다. 빠른 Gateway 시험의 대역 예산은 간격 300ms·창 50ms로 실제 전송 간격 250ms 이상(가짜 제한 200ms)이다.

### 리뷰 3라운드 반영 (rev-pub-r3, 2026-10-30)

리뷰(`828172e` 기준)의 P2 1건을 고쳤다. `npm run check` 통과, `npm test` **573 tests / 564 pass / 0 fail / 9 skipped**(PG 소켓 없음, 3회 중 1회는 기존 `TASK-03` 1건 실패), PostgreSQL 18.6 소켓 포함 **573/573 pass** 3회 연속.

| 발견 | 고친 방식 | 회귀 시험 / 수정 전 |
|---|---|---|
| P2 gap을 푸는 마지막 transaction에서 `check()` 뒤 빈 버퍼 조회·gap UPDATE 왕복 중 30초를 넘겨도 `done`(수동 gap·감사 생략) | 그 transaction에 lease 마감(`started + 30초`)을 transaction 마감으로 넘기고, gap UPDATE 뒤에도 마감을 확인한다. 넘으면 되돌려 gap을 남기고 `history_gap` 감사와 `budget`. 실패 원인이 무엇이든 그 시점에 마감을 넘겼으면 한도 초과로 본다. 토큰·구독 변경은 그대로 `skipped` | `R3-1 리뷰어 재현: 인가 왕복 누적 + 마지막 빈 버퍼 조회 응답…`(수정 전 `['done']`), `R3-1 마지막 check() 뒤 빈 버퍼 조회 응답에서…`, `R3-1 마지막 check() 뒤 gap 해제 UPDATE 응답에서…`(둘 다 수정 전 `done`), 대조 `R3-1 경계 안에서 끝나면 그대로 done`. 두 장치(transaction 마감, 마지막 확인)는 겹치는 방어라 하나만 빼면 시험이 통과하고 둘 다 빼면 세 시험이 실패한다 |

리뷰가 짚은 대로 R2-2의 "마지막 checkpoint 갱신" 시험은 마지막 `check()` **전**에 시간을 넘기고, 버퍼 시험은 `check()` 안의 행 잠금 응답에서 넘긴다. 이번 R3-1 시험이 마지막 `check()` **뒤** 경계를 본다.

### PR #12 Codex 리뷰 P1 반영 (4420530263, 2026-10-30)

지적: 활성 스레드 메시지 처리가 DB 일시 끊김이나 `DiscordProtocol.channel()` REST 실패로 끝나면 이벤트를 로그만 남기고 버렸다. Gateway sequence는 이미 지나 RESUME으로도 다시 오지 않고, 뒤 메시지가 checkpoint를 올리면 다음 READY 복구도 그 메시지를 건너뛴다. 타당하다고 판단해 고쳤다. `npm run check` 통과, `npm test` **578 tests / 569 pass / 0 fail / 9 skipped**(PG 소켓 없음), PostgreSQL 18.6 소켓 포함 3회 중 2회 **578/578**, 1회는 기존 `TASK-03` 1건 실패.

| 고친 방식 | 회귀 시험 / 수정 전 |
|---|---|
| 진입점 dispatch가 실패를 나눈다. 확정 거부(`Denied`, `ZodError`, `DiscordRejected` 403/404)는 버린다. 그 밖(일시 장애)이고 메시지면 그 채널의 활성 스레드·DM에 `RecoveryScheduler.guard()`로 장벽(gap, 진행 중 복구 토큰 무효화, 대기 항목)을 세우고 history 대조로 메운다. 장벽 UPDATE가 실패하면 설 때까지 다시 시도하고 그동안 다음 이벤트는 기다린다. 상호작용은 되살리지 않는다 | `PR12 활성 스레드 메시지가 일시 장애(채널 REST 조회)로…`, `…(DB 쓰기)로…`(둘 다 수정 전 201 없음·checkpoint 202·gap 해제), `PR12 장벽 UPDATE도 일시 실패하면…`(장벽을 기다리지 않는 변형에서 실패), `PR12 확정 거부(허용되지 않은 사용자)는 장벽을 세우지 않고…`(확정 거부도 장벽을 세우는 변형에서 실패), `PR12 guard()는 그 채널의 활성 스레드·DM에만…`(단위) |

남는 범위: 부모 채널의 멘션 메시지와 상호작용은 history 대조 대상이 아니라 일시 장애 때 되살리지 않는다(ACK가 없으니 사용자가 다시 보낸다). 활성 대화가 없는 스레드의 메시지도 같다.

### PR #12 Codex 재리뷰 반영 (4420612638 P1, 4420612644 P2, 2026-10-30)

두 지적 모두 타당하다고 판단해 고쳤다. 4420592975(P2, DB TLS 검증)는 플랫폼 전체의 `sslmode=require` 선택이라 이번 범위에서 바꾸지 않았다(lead가 스레드에서 다룸). `npm run check` 통과, `npm test` **581 tests / 572 pass / 0 fail / 9 skipped**(PG 소켓 없음), PostgreSQL 18.6 소켓 포함 5회 중 2회 **581/581**, 3회는 기존 `TASK-03` 1건만 실패.

| 지적 | 고친 방식 | 회귀 시험 / 수정 전 |
|---|---|---|
| 4420612638 P1: 재시작 때 남은 queued 작업이 첫 READY 장벽보다 먼저 claim돼 이전 입력으로 모델을 부름 | `Runtime` 루프를 첫 READY 장벽이 선 뒤에 시작한다. 이후 READY의 장벽은 claim의 gap 조건이 막는다 | `PR12-2 Gateway가 붙기 전(첫 READY 장벽 전)에는 남아 있던 queued 작업을 claim하지 않음`(수정 전 `failed`, 작업자 호출), `PR12-2 재시작 뒤 첫 READY 복구가 중단 중 메시지를 먼저 읽어 이전 queued 작업을 supersede`(수정 전 `failed`, 기대 `superseded`) |
| 4420612644 P2: 대기 항목 없는 복구 루프가 DB 없이 하트비트 생존을 기록해 DB 장애 중에도 ping | 루프마다 "한 바퀴 성공 = DB에 닿음"인지 표시하고, 그런 루프(runtime·publisher)만 `health.loop()`. 복구 루프는 세지 않는다 | `PR12-3 DB가 끊기면 DB에 닿지 못한 루프는 하트비트 생존으로 치지 않아 60초 뒤 ping이 멈춤`(시계 61초 전진, 수정 전 DB 장애 중 ping 1회) |

## T16b 작업자 진입점·이미지 (2026-10-30, 로컬)

- 기준: 브랜치 `feat/t16b-worker-entry`(origin/main `3fb389a` 위). 구현은 [ARCHITECTURE.md](ARCHITECTURE.md) §12 "T16b 작업자 진입점", 결정은 D2·D3·D4(사용자 2026-10-30).
- 모델 호출 없음. codex는 `--help`·`--version`만 실행했다. 시험의 codex 자리는 같은 인자·stdin·env로 도는 가짜 실행 파일이다. 시드는 합성 값이고 개인 `~/.codex*`는 쓰지 않았다.
- `npm run check` 통과, `npm test` **521 tests / 517 pass / 0 fail / 4 skipped**(건너뜀 4개는 로컬 PostgreSQL 소켓이 필요한 기존 PG 시험). Node 24.22.2(로컬), 컨테이너 시험 단계는 Node 24.22.0.
- 이미지: `docker build --target test .` 안에서 같은 결과(521 / 517 / 0 / 4, 비root `node` 사용자). 최종 이미지 로컬 빌드 679MB(대부분 codex linux-x64 패키지 약 411MB). 로컬 digest는 CI(`app-build`, 캐시 없음)와 다르므로 sandbox는 main 빌드의 GHCR digest를 쓴다.

| 시험 ID | 등급 / 판정 | 확인한 경계 | 남은 검증 / 해소 |
|---|---|---|---|
| TASK-03 시간 초과 시험 안정화 | local_integration / pass | 실제 30ms 타이머가 준비 단계(디렉터리·설정 쓰기) 중에 울려 프로세스를 띄우지 않던 흔들림. 바쁜 루프 14개(코어 14)에서 수정 전 12회 중 7회 실패, 가짜 시계로 바꾼 뒤 20회 모두 통과 | 없음 |
| 시드 복사 (WRK-01·02·14) | local_integration / pass | `auth.json`이 없을 때만 0600 복사(임시 파일 → fsync → rename), 있으면 내용·권한 그대로(갱신본을 새 시드로 덮지 않음), Secret 볼륨 `..data` 심링크 시드, 없음·빈 파일·JSON 아님·갱신 토큰 없음·디렉터리 → 기동 실패하고 `auth.json`·임시 파일 없음, 오류에 값 없음, `auth.json` 심링크·디렉터리는 따라가지 않고 실패, 시드·nonce 경로가 사람 홈이나 `.codex*`(심링크 포함)면 읽기·쓰기 전에 실패 | 실제 Secret 볼륨·PVC에서 1회 복사와 파드 재생성 뒤 유지(`sha256sum` 비교만), S11 |
| SEC-02 capability 재생 (WRK-03·04·12) | local_integration / pass | 영속 nonce 디렉터리: 쓴 capability는 프로세스를 새로 띄워도 거부, 같은 nonce 동시 사용 10건 중 1건만 통과, nonce 모양이 아니면 파일을 만들지 않고 거부, 62초 뒤 기록 정리, 쓸 수 없는 디렉터리면 기동 실패. HTTP 끝까지(서명 → 실행 → 재사용 거부 → 작업자 재기동 → 재사용 거부) | 실제 PVC에서 파드 재생성 뒤 거부, S11 |
| 대화 레인 (WRK-05~09) | local_integration / pass | argv `--ephemeral`·`--skip-git-repo-check`·`--output-schema`·`-o`·stdin `-`, `sandbox_mode = "read-only"`·`inherit = "none"`, 빈 임시 작업 공간, codex env 허용 목록(부모 env의 시드·Discord·공개 키·OpenAI 값 미상속), 세션 파일이 남지 않음(가짜 codex가 플래그를 무시하고 써도 지움), `auth.json` 유지, 한도 → `limited`, 인증 만료 → `auth_expired`, 스키마 밖·반사·중단·도구 예산 초과 → `failed`, 긴 답은 잘라 받음, 남은 프로세스 모름 → `unknown`과 이후 `worker_busy`, 작업 레인 요청은 띄우지 않음, 기한은 게시 서버보다 5초 먼저(가짜 시계로 54.999초 미중단·55초 중단), 취소는 정리 확인 뒤 `stopped: true` | 실제 codex 첫 대화(모델·인증 호스트 실측, `--ephemeral` 실제 동작, CODEX_HOME에 남는 파일 이름), S12 |
| 작업자 기동·readiness (WRK-10·11·13·15) | local_integration / pass | 필수 env 다섯, 키 이름만 알림, 개인 키·RSA·깨진 PEM 거부, `codex --version` 0.163.0 아니면 실패, `GET /readyz` 200(`auth.json` 없어지면 503), 그 밖 경로 404, 인증 없는 실행 401, 진입점 프로세스 종료 코드 1·사유 한 줄, SIGTERM → 0, 종료 중 실행은 codex를 멈추고 `failed`로 답함 | 파드 readiness 경로 `/readyz`로 바꾸기, S11 |
| 이미지 (Dockerfile, 로컬 podman) | local_integration / pass | uid 65532·10001, 읽기 전용 루트, 네트워크 없음에서: `codex --version` → `codex-cli 0.163.0`, `/app` 아래 남이 못 읽는 파일 0개·남이 쓸 수 있는 파일 0개, git 없음, env 없음·시드 없음 → 종료 코드 1(`config_missing:…`·`seed_missing`), 합성 시드로 기동(`seeded`, `auth.json` 0600·uid 10001) → `/readyz` 200 → 서명한 작업 레인 요청 200(`failed`, codex 미실행) → 재사용·위조 403 → 같은 볼륨으로 재기동(`kept`) → 재사용 403 → SIGTERM 종료 코드 0. 대기 메모리: cgroup 35.6MB, PID 1 RSS 85MB. codex 최대 RSS `--version` 26MB, `exec --help` 60MB | 기본 CMD(게시 서버 `dist/src/main.js`)는 이 브랜치에 없어 기동 확인 대상이 아니다(MODULE_NOT_FOUND). 대화 실행 중 메모리는 모델 호출이 필요해 S12 |

- **리뷰 wrk-r1 반영(2026-10-30):** 지적 4건을 모두 고쳤다. 지적마다 리뷰어 재현을 회귀 시험으로 옮겨 수정 전 실패를 먼저 확인했다(`test/worker-entry.test.ts` WRK-16~19).
  - P1 시드 설치가 확인 뒤 생긴 `auth.json`을 덮음: WRK-16(설치 직전에 갱신본·심링크를 끼워 넣음, 동시 기동 둘이 모두 "없음"을 본 뒤 설치). 수정 전 `seeded`로 갱신본을 덮었다. `rename` 대신 `link`(이름이 있으면 실패)로 설치해 `kept`와 갱신본 보존, 동시 기동은 하나만 `seeded`.
  - P1 시드 파일 자체의 심링크로 개인 `auth.json` 복사: WRK-17(허용 디렉터리 안 파일 → 사람 홈 `.codex/auth.json`, Secret 볼륨 `..data` → 사람 홈 `.codex`). 수정 전 정상 기동하며 복사했다. 최종 대상을 해석해 `seed_personal_path`로 거부, 정상 Secret 볼륨 링크는 계속 허용.
  - P2 종료 시작 뒤 검증을 마친 요청이 codex를 띄움: WRK-18 둘(본문 한 글자만 보낸 상태에서 종료 시작, nonce 확인 중 종료 시작). 수정 전 codex를 띄웠다(실행 1회, `succeeded`). 종료 시작과 함께 새 실행을 닫아 403 `started:false` 또는 `failed`, 실행 0회.
  - P2 nonce 기록 I/O 오류를 성공 처리: WRK-19(만든 뒤 `utimes`·`close`에 EIO 주입). 수정 전 `true`였다. 거부로 바꿨다.
  - 함께 고친 것: 이미지의 `package.json`·마이그레이션 SQL이 빌드 기계 umask 그대로 0664였던 것(리뷰 메모). 최종 이미지에 넣는 파일 전부 그룹·기타 쓰기를 뺐다(로컬 재빌드에서 `find /app -perm /022` 0개).
  - 결과: `npm run check` 통과, `npm test` 526 / 522 pass / 0 fail / 4 skipped, 로컬 PostgreSQL 18.6 소켓(`HOMELAB_TEST_PG_SOCKET`)을 주면 526 / 526 pass. 재빌드한 이미지에서 합성 시드로 첫 기동 `seeded`(0600, 링크 수 1, 임시 파일 없음) → 재기동 `kept`, SIGTERM 종료 코드 0.
- 시험이 잡는지 확인: 코드를 일부러 망가뜨려(`--ephemeral` 빼기, 세션 정리 빼기, 시드 덮어쓰기, nonce 메모리 저장, 개인 키 허용, env 상속, 버전 확인 빼기, workspace-write, 기한 여유 빼기, 0644, 작업 레인 실행, `/readyz` 빼기, 개인 경로 검사 빼기, 연결 먼저 끊기) 각각 해당 WRK 시험이 실패하는 것을 봤다.
- T18 실제 프로세스 시험의 흔들림(`test/codex-bridge.test.ts`, 2차 수정): 주원인은 **고정 작업 ID**였다. launcher는 같은 UID의 모든 프로세스에서 작업 표식을 찾아 끝내고 세므로, 같은 기계에서 동시에 도는 다른 시험 실행의 같은 시험 프로세스를 자기 것으로 죽였다. 부하 없이 두 벌 동시 실행만으로 `S2`가 8회 중 3회 `exit_nonzero`(관찰된 증상과 같음)로 재현했다. 실제 프로세스 시험의 작업 ID를 실행마다 `randomUUID()`로 바꾼 뒤 두 벌 동시 실행 12회 모두 통과. 함께 없앤 시간 의존: S2 가짜 codex의 150ms 간격 도구 호출(둘째를 바로 내고 셋째는 정리 실패 때만 30초 뒤), SEC-02 hang의 300ms 중단(어댑터가 `thread.started`를 받은 뒤 중단), non-dumpable 자식의 5초 상한 바쁜 대기(상태 기다리기), 정리 유예 500ms(5초, 사라지면 바로 끝남), 스냅샷 `< 2000ms`(멈추는지만 봄), 경로 판정 `< 800ms` 벽시계(원소 읽기 수 + 이 프로세스 CPU 시간), R1의 고정 100ms 대기(실제 실행이 끝나기를 기다림). 확인: 부하 생성기 8개(`nice -n 19`, 운영 k3s 보호를 위한 lead 제한) 아래 전체 `npm test` 12회 모두 521 / 517 / 0 / 4(load 8.6~20). 바꾼 시험이 계속 잡는지 코드를 망가뜨려 봤다(예산 미집행 → S2 실패, 제곱 판정 → 경로 시험 실패, 실행 전 중단 확인 제거 → R1 두 시험 실패). 남는 것: non-dumpable 시험의 자식은 그 시험 동안 같은 UID의 다른 시험 실행이 "확인 불가"(`unknown`)로 판정하게 만들 수 있다(설계상 fail-closed). 한 실행 안에서는 실제 프로세스 시험이 차례로 돌아 겹치지 않고, 컨테이너 test 단계에는 해당이 없다. 런처의 실행 뒤 출력 마저 읽기 200ms 상한(`src/codex-process.ts`)도 시간 의존이지만 `src/` 동작이라 바꾸지 않았다.

## T16b D9: Argo CD 앱 상태를 Kubernetes API로 (2026-10-30, 로컬·mock)

- 기준: 브랜치 `feat/t16b-argocd-via-k8s`(origin/main `8ae9294` 위). 결정은 [DECISIONS.md](DECISIONS.md) "T16b 결정" D9. 실제 클러스터·Argo CD·Infisical·Discord·모델에는 연결하지 않았다.
- `npm run check` 통과. `npm test` **608 tests / 599 pass / 0 fail / 9 skipped**(PG 소켓 없음. 기준선 `8ae9294`는 604 / 595 / 0 / 9). 로컬 `postgres:18-alpine`(PostgreSQL **18.6**, `--pull=never --network none`, 데이터 tmpfs, 소켓 디렉터리 바인드)을 주면 3회 중 2회 **608/608**, 1회는 T18 실제 프로세스 시험 `SEC-02 실제 프로세스: …배경 자식…` 1건 실패다(호스트 load 13, 같은 시험 단독 3회 통과. 이번 변경과 무관한 기존 흔들림). Node 24.22.2.
- 시험이 잡는지: transport에서 앱 이름 허용 목록 검사, 응답 객체 namespace 검사, `AbortSignal` 전달을 하나씩 빼면 각각 해당 시험이 실패함을 확인했다(원복).

| 시험 ID | 등급 / 판정 | 확인한 경계 | 남은 검증 / 해소 |
|---|---|---|---|
| READ-01 (Argo CD, D9) | mock / pass (transport), local_integration / pass (진입점 경로) | 가짜 Kubernetes API에 `GET /apis/argoproj.io/v1alpha1/namespaces/argocd/applications/homelab-bot`, SA 토큰을 요청마다 다시 읽음(교체 반영). Healthy·Synced → healthy, Healthy·OutOfSync·Degraded·Missing → degraded, Progressing·Suspended·status 없음 → unknown, 관측 시각은 요청 시각, untrusted는 `health=… sync=…`(D9 전과 같은 의미). spec(Helm values)·`status.resources`·`operationState`는 결과에 없음. 403·404·다른 이름·다른 namespace·namespace 없음·JSON 아님·redirect(따라가지 않음)는 관측 불가. 진입점 `/read` → 스레드 → read 작업 → Application CR(SA 토큰) → 결과 게시, `/api/v1/applications` 호출 0 | 라이브 Application CR 모양과 SA 권한, S8·S16 |
| READ-02 (Argo CD, D9) | mock / pass | 앱 이름은 카탈로그 고정값(`ARGOCD_APPLICATIONS` = `homelab-bot`)만. 다른 앱 이름·대문자·빈 값·하위 경로(`resource-tree`·`managed-resources`)·query 문자열·`..`·퍼센트 인코딩·모르는 datasource는 SA 토큰도 읽지 않고 요청 없이 거부, 모양이 틀린 허용 목록 값은 버림. 경로 namespace는 템플릿 namespace와 상관없이 `argocd` 고정. 응답 4MiB 초과(선언 길이·chunked)는 끝까지 담지 않고 관측 불가, 정확히 4MiB는 관측. 시간 초과 신호로 응답 없는 요청과 서버 쪽 연결을 끊음(kubernetes·argocd·Grafana 경로) | 플랫폼 RBAC(다른 ns·쓰기 no), S8 |
| 설정 (D9) | mock / pass (PG 진입 프로세스 포함) | 비밀 7개·주소 3개(목록을 순서까지 고정), `ARGOCD_URL`·`ARGOCD_READER_TOKEN`은 없어도·값이 틀려도 기동에 영향 없음. 실제 진입 프로세스 시험(PostgreSQL)도 두 키 없는 env로 설정을 통과 | 차트 env·Infisical에서 두 키 정리(사람·플랫폼), S10 |

## T16b 실행기 프로필·Claude 대화 어댑터 (2026-10-30, 로컬)

- 기준: 브랜치 `feat/t16b-executor-profiles`(origin/main `34d6334` 위). 결정은 [DECISIONS.md](DECISIONS.md) D-14 "변경"(사용자 2026-10-30), 구현은 [ARCHITECTURE.md](ARCHITECTURE.md) §12 "T16b 실행기 프로필".
- **모델 호출·로그인 없음.** Claude Code CLI 2.1.308은 `--version`·`--help`만 실행했다(빈 HOME·`CLAUDE_CONFIG_DIR`, 부가 통신·업데이트 끔, 실행 뒤 두 디렉터리에 파일 0개). stream-json 이벤트 모양은 같은 바이너리에 든 SDK 메시지 스키마(Zod 정의)를 정적으로 읽어 맞췄다. 시험의 claude 자리는 같은 인자·stdin·env로 도는 가짜 실행 파일이고, 토큰은 합성 값이다. 개인 `~/.claude*`·`~/.codex*`는 읽지 않았다.
- `npm run check` 통과, `npm test` **629 tests / 620 pass / 0 fail / 9 skipped**(건너뜀은 로컬 PostgreSQL 소켓이 필요한 기존 PG 시험). 기준선 `34d6334`는 614 / 605 / 0 / 9다. 늘어난 15개는 새 Claude 시험 14개(CLD-01~14)와 WRK-07을 공통·Codex 해석 둘로 나눈 1개다. Node 24.22.2(로컬), 컨테이너 시험 단계(Node 24.22.0)도 629 / 620 / 0 / 9.

**CLI 확인 [실측: 고정 바이너리 2.1.308, 모델 호출 없음].**

| 항목 | 결과 |
|---|---|
| 버전 | `claude --version` → `2.1.308 (Claude Code)`. npm `dist-tags`: stable 2.1.308(2026-10-22 게시), latest 2.1.314(2026-10-30 게시). stable을 고정했다 |
| 패키지 | `@anthropic-ai/claude-code`(래퍼, 189KB) + 플랫폼 optional 패키지 `@anthropic-ai/claude-code-linux-x64`(glibc ELF 실행 파일 `claude`, 279MiB). lockfile에 integrity 고정 |
| `--help`로 확인한 플래그 | `-p`, `--output-format text|json|stream-json`, `--verbose`, `--json-schema`, `--model`, `--tools`("" = 전부 끔), `--strict-mcp-config`, `--mcp-config`, `--no-session-persistence`, `--permission-mode`(acceptEdits·auto·bypassPermissions·manual·dontAsk·plan), `--disable-slash-commands`, `--safe-mode`, `--bare`("OAuth and keychain are never read"), `--fallback-model`, `--setting-sources`, `--settings`, `--restricted`. `--max-turns`는 도움말에 없다 |
| 바이너리 스키마(정적) | `system/init`: `tools`·`mcp_servers`·`model`·`apiKeySource`(OAuth·bearer 토큰이면 `none`)·`claude_code_version`·`permissionMode`. assistant: `error` 종류(`authentication_failed`·`oauth_org_not_allowed`·`account_on_hold`·`verification_required`·`billing_error`·`rate_limit`·`overloaded`·`invalid_request`·`model_not_found`·`server_error`·`unknown`·`max_output_tokens`·`cloud_credential_error`), `api_error_status`. result: success(`is_error`·`api_error_status`·`structured_output`) / `error_during_execution`·`error_max_turns`·`error_max_budget_usd`·`error_max_structured_output_retries`. 출력 전달 도구 이름 `StructuredOutput` |

| 시험 ID | 등급 / 판정 | 확인한 경계 | 남은 검증 / 해소 |
|---|---|---|---|
| CLD-01 프로필 | mock / pass | `claude`+`CLAUDE_CODE_OAUTH_TOKEN`+전체 모델 ID만 `claude-subscription`. 모르는 실행기(`opencode`)·`ANTHROPIC_API_KEY`·실행기와 안 맞는 키 → `profile_unsupported`, 별칭 `opus`·`[1m]`·공백 섞인 값·다른 실행기 모델 → `config_invalid:WORKER_MODEL`. 능력표(대화만·도구 없음·세션 없음·모델 고정·env-static·가짜 CLI 근거)와 모든 프로필의 능력표·자격 방식 일치, 작업 레인 false | 없음 |
| CLD-02 argv | mock / pass | 정확한 argv, 금지 플래그(`--bare`·`--fallback-model`·`--dangerously-skip-permissions`·`--resume`·`--add-dir`·`--settings` 등) 없음, 위치 인자(프롬프트) 없음 | 실제 CLI가 이 조합을 받는지(S12) |
| CLD-03 env·자격 위치 | local_integration / pass | 자식 env가 정확히 공통 기본 + `CLAUDE_CONFIG_DIR` + 토큰 + 고정 7개. 토큰은 `CLAUDE_CODE_OAUTH_TOKEN`에만(Secret 파일 값, 작업자 env의 같은 이름 값이 아님). argv·다른 env·stdin·실행 디렉터리 파일에 없음. 작업자 env의 `ANTHROPIC_API_KEY`·Discord·Codex 값 미상속. HOME·설정·TMPDIR·cwd가 실행별 임시 디렉터리 안에서 서로 다름, 빈 작업 공간, 프롬프트는 stdin | 실제 파드(S11) |
| CLD-04 세션 파일 | local_integration / pass | 가짜 CLI가 `--no-session-persistence`를 무시하고 `CLAUDE_CONFIG_DIR/projects`·`HOME/.claude.json`·TMPDIR에 써도 실행 뒤 실행 디렉터리째 없음. nonce·자격 디렉터리에 쓰지 않음 | 실제 CLI가 실행 디렉터리 밖에 쓰는 파일(S12) |
| CLD-05 결과 해석 | mock / pass | 답은 `structured_output`만. 한도(`rate_limit`·`billing_error`, 429·402)·인증(`authentication_failed` 등, 401·403)은 구조화 종류·상태로만. 과부하·서버 오류는 상태가 429여도 `failed`. 모델 답·result 텍스트의 "401·rate limit"은 무시. 재시도 뒤 성공은 성공. 구조화 출력 없음·`is_error` 없음·종료 코드≠0·result 둘·init 둘·init 없음·깨진 줄 → `failed`. init의 작업 도구·MCP·다른 모델·API 키 출처·다른 버전 → `failed` | 실제 오류 필드(S12) |
| CLD-06 실제 실행 판정 | local_integration / pass | 한도 → `limited`, 인증 → `auth_expired`, 과부하·스키마 밖 답·토큰 반사 → `failed`, 작업 레인은 띄우지 않음 | 없음 |
| CLD-07 정책 위반 즉시 중단 | local_integration / pass | init에 작업 도구·MCP·다른 모델·API 키 출처, 실행 중 `Bash` 도구 호출 → 기한(55초)을 기다리지 않고 바로 중단, `failed`(시험 상한 20초) | 없음 |
| CLD-08 기한·취소·unknown | local_integration / pass | 가짜 시계로 54.999초 미중단·55초 중단, 취소는 정리 확인 뒤 `stopped:true`, 남은 프로세스 모름 → `unknown`과 이후 `worker_busy` | 없음 |
| CLD-09 공통 유출 검사 | local_integration / pass | 일부러 잘못 만든 어댑터가 토큰을 argv·다른 env·설정 파일에 두거나, 허용 밖 env(`ANTHROPIC_API_KEY`)·기본 env 덮기(`HOME`)·자격 변수 누락이면 띄우지 않고 `failed`, 실행 디렉터리도 지움 | 없음 |
| CLD-10 자격 교체 | local_integration / pass | Secret 파일을 실행마다 다시 읽어 바뀐 토큰이 재시작 없이 다음 실행에 반영. 실행 때 파일이 없으면 띄우지 않음. 빈 값·짧은 값·공백·여러 줄·비ASCII·16KiB 초과 → `credential_invalid`, 없음 → `credential_missing`, 오류에 토큰 없음. 자격 디렉터리에 아무것도 더 쓰지 않음 | ESO 교체 실측(S11) |
| CLD-11 개인 `~/.claude*` | local_integration / pass | 자격 디렉터리 `~/.claude`·nonce `~/.claude-sub` → `config_invalid:*`, 토큰 파일이 사람 홈 `.claude/…`를 가리키는 심링크 → `credential_personal_path`, 실행 루트가 `~/.claude`면 거부, 만들지 않음 | 없음 |
| CLD-12 기동·readiness | local_integration / pass | `--version`은 자격 없이 빈 임시 HOME·설정 디렉터리로만. 2.1.314 → `executor_version_mismatch`, 다른 모양 → `executor_version_unavailable`, 토큰 없음 → `credential_missing`. `/readyz` 200 → 토큰 삭제·모양 틀림 503 → 복구 200 | 파드 프로브(S11) |
| CLD-13 HTTP 끝까지 | local_integration / pass | 서명 요청 → Claude 대화 → `succeeded`, `HTTPS_PROXY` 전달, 같은 capability 재사용·재기동 뒤 재사용 거부, 한도 → `limited` | 없음 |
| CLD-14 진입점 프로세스 | local_integration / pass | 토큰 모양 틀림·API 키 프로필·별칭 모델 → 종료 코드 1과 사유 코드 한 줄, 출력에 토큰·공개 키 없음(회귀로 기동이 성공하면 10초 뒤 끝내고 실패) | 없음 |
| Codex 프로필(WRK-01~19) | local_integration / pass | 기존 Codex 대화 경로를 같은 인터페이스 뒤로 옮긴 뒤에도 기존 시험 그대로 통과(env 이름만 새 이름). WRK-07은 공통 판정과 Codex 해석으로 나눔 | Codex 실제 첫 대화(S12, 그 프로필을 고를 때) |

- **시험이 잡는지(일부러 망가뜨려 봄, 각각 되돌림).** init 위반 즉시 중단 제거 → CLD-07, 공통 유출 검사 제거 → CLD-09, 토큰을 argv에도 → CLD-03 등, 작업자 env 상속 → CLD-03, 실행 디렉터리 삭제 제거 → CLD-03·04·06·09, 토큰을 기동 때 한 번만 읽기 → CLD-10, `.claude*` 개인 경로 검사 제거 → CLD-11, `--bare` 추가 → CLD-02, 도구 끈 실행기에 요청 도구 예산 적용 → CLD-07, 결과 텍스트로 한도 분류 → CLD-05, 모델 별칭 허용 → CLD-01·14, API 키 조합을 첫 프로필로 몰래 허용 → CLD-01·14, init 모델 대조 제거 → CLD-05·07, Codex 세션 정리 제거 → WRK-06, 소멸 미확인에도 결과 사용 → CLD-08. 15개 모두 실패로 잡혔다. 처음 돌렸을 때 두 경우(토큰을 argv에, 별칭 허용)는 실패 대신 시험 파일이 끝나지 않았다(실행이 뜨기를 기다리는 루프, 회귀로 기동해 버린 진입점). 기다림을 횟수로 끊고 진입점 시험에 10초 상한을 둬 실패로 잡히게 고쳤다.
- **이미지(로컬 podman, `nice -n 10`).** 최종 이미지 **972MB**(이전 679MB, +293MB = Claude 플랫폼 실행 파일). 빌드 중 `claude --version`이 정확히 `2.1.308 (Claude Code)`이고 `/tmp`에 아무것도 남기지 않는지 확인한다. 네트워크 없음·읽기 전용 루트·uid 10001·합성 토큰으로: `/usr/local/bin/claude` → 플랫폼 실행 파일, `/app` 아래 남이 못 읽는 파일 0개·그룹/기타 쓰기 가능한 일반 파일 0개, 공개 키 없음·API 키 프로필·별칭 모델 → 종료 코드 1과 사유 코드, 정상 기동(이미지 안 실제 `claude --version` 대조) → `{"profile":"claude-subscription","cli":"2.1.308","model":"claude-opus-5-5","credential":"present"}` → `/readyz` 200 → 서명한 작업 레인 요청 200 `failed`(CLI 미실행) → 재사용 403 → 토큰 파일 치움 503·복구 200 → SIGTERM 종료 코드 0. 로그에 토큰 없음. 대기 메모리 35.3MB, 프로세스는 PID 1 하나, `/tmp` 비어 있음. 로컬 digest는 CI와 다르므로 sandbox는 main 빌드의 GHCR digest를 쓴다.
- **남은 검증(S11·S12, 승인 뒤).** 실제 stream-json 모양과 init 값(`model` 글자 그대로, `apiKeySource` `none`, `tools`에 `StructuredOutput`만), `--tools ""`와 구조화 출력의 동시 동작, 한도·인증 오류 필드, 최소 egress(`api.anthropic.com` 외 필요 여부, DNS 없는 파드의 프록시 경유), 대화 중 메모리·`/tmp`·응답 시간, CLI가 실행 디렉터리 밖에 쓰는 파일.

### 리뷰 exec-r1 반영 (2026-10-30, 로컬)

- 지적 3건(P1 2, P2 1)을 모두 고쳤다. 지적마다 리뷰어 재현을 회귀 시험으로 옮겨 **수정 전 실패를 먼저 확인**했다(그 4개만 실패, 나머지 38개 통과). 모델 호출·로그인 없음, 합성 자격만.
- `npm run check` 통과, `npm test` **633 tests / 624 pass / 0 fail / 9 skipped**(직전 629 / 620 / 0 / 9에 회귀 시험 4개). Dockerfile·의존성은 바뀌지 않아 이미지는 다시 빌드하지 않았다.

| 시험 ID | 등급 / 판정 | 수정 전 실패(리뷰어 재현) | 고친 것 |
|---|---|---|---|
| WRK-20 [r1 P1] Codex 홈 별칭 | local_integration / pass | `CODEX_HOME`이 작업자 디렉터리를 가리키는 정상 심링크면 시드·readiness는 성공하는데 자격 객체가 별칭 경로를 `O_NOFOLLOW`로 못 열어 비밀 0개 → 갱신 토큰이 섞인 답이 `succeeded`로 나감 | 공장 함수가 홈을 한 번 해석해 어댑터·자격에 같은 실제 경로. 실행 전·후 자격을 못 읽거나 비밀이 0개면 `failed`(실행 전이면 띄우지 않음). 공통 실행 전 검사도 비밀 0개면 거부. 실행 중 auth.json이 망가져 실행 뒤 못 읽는 경우도 `failed` |
| CLD-15 [r1 P1] 자동 모델 전환 | mock·local_integration / pass | 자동 전환을 끄는 env 없음. init 뒤 `system/model_refusal_fallback`, 다른 모델(`claude-opus-4-8`)의 assistant 응답, 모델 없는 응답이 모두 무시돼 결과 `output` | env `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1`. 전환 이벤트·요청 모델이 아닌 응답(날짜 접미어는 같은 모델, CLI 합성 오류 `<synthetic>`은 예외)은 실행 중 즉시 중단·판정 실패 |
| CLD-16 [r1 P2] 실행 디렉터리 삭제 실패 | local_integration / pass(비root) | 남긴 기록 디렉터리를 쓰기 금지로 바꾸면 삭제 실패를 숨겨 두 실행 모두 `succeeded`, readiness true, 실행 디렉터리 2개가 남음 | 결과 확정 전에 삭제·부재를 확인. 실패하면 답을 게시하지 않고 `failed`, 잔여물로 추적, 남은 동안 새 실행 안 띄움·readiness 503, 확인 때마다 다시 지워 풀리면 재개. 값 없는 사건 로그 |
| WRK-21 [r1 P2] Codex 세션 정리 실패 | local_integration / pass(비root) | Codex 어댑터가 `sessions/` 삭제 오류를 숨겨 `succeeded` | 어댑터 정리 오류를 올려 보내 공통부가 같은 방식으로 처리 |

- 리뷰어 재현 스크립트를 고친 빌드에 그대로 돌림: 전환 흐름 위반 `[null, model_fallback, model_mismatch, null]`·결과 `failed`, 정리 실패 `first=failed, second=failed(미실행), ready=false, 남은 디렉터리 1`, Codex 별칭 `secrets=1, status=failed, secretPublished=false`.
- 시험이 잡는지(고친 곳을 하나씩 되돌림): 별칭 경로를 자격에 넘김, 파일 자격 읽기 실패를 빈 목록으로(공통 검사 제거와 함께도), 실행 뒤 자격 읽기 실패 무시 → WRK-20. 전환 끄는 env 제거, 실행 중·판정의 모델 확인 제거, assistant 모델 대조 제거 → CLD-15. 정리 실패해도 결과 그대로, 실행 전 잔여물 확인 제거, readiness가 잔여물 무시 → CLD-16·WRK-21. Codex 세션 정리 오류 숨김 → WRK-21. 12가지 모두 실패로 잡혔다.
- 고쳐 둔 것: 리뷰가 짚은 대로 "시작 실패가 stdout에 구조화돼 온다"는 직전 보고는 조건부였다. 2.1.308은 일부 시작 실패 결과를 `CLAUDE_CODE_STARTUP_FAILURE_RESULTS` opt-in에서만 낸다. 넣지 않았고, 그런 실패는 결과 없음 → `failed`로 닫힌다(ARCHITECTURE §12 남는 것).

## 개선안 v2 (2026-10-30, 로컬·mock)

- 기준: 브랜치 `feat/improvements-v2`(origin/main `34d6334` 위). 분석·판정은 [IMPROVEMENTS_V2.md](IMPROVEMENTS_V2.md) "적용 상태", 구현은 [ARCHITECTURE.md](ARCHITECTURE.md) §13. 실제 클러스터·Discord·Infisical·모델에는 연결하지 않았다.
- 구현은 세 묶음(chat·sched·signal)을 따로 만든 뒤 합쳤고, 다른 모델 계열(Codex)의 독립 리뷰 두 건과 재확인을 거쳤다. 리뷰 지적 중 고친 것: 만료 처리의 잠금 역전, 종료 드레인 뒤 cancel 지연, 확인된 멈춤의 일시 DB 오류 유실, 입력 중 힌트의 Gateway 처리 지연, 종료 뒤 입력 중 표시 전송. 받아들인 것 두 건은 ARCHITECTURE §13 "받아들인 전환기 동작"·"받아들인 예외"다.
- 결과: `npm run check` 통과. `npm test`(PG 없이) **741 tests / 723 pass / 0 fail / 18 skipped**(기준선 `34d6334`는 614 / 605 / 0 / 9). 로컬 PostgreSQL 소켓(`HOMELAB_TEST_PG_SOCKET`)을 주면 **741/741 pass**를 두 번 연속 확인했다.
- main 합친 뒤(2026-10-31, #18 실행기 프로필·#19 게시 핫픽스 위, `chatPrompt` 문구 변경 포함): `npm run check` 통과, `npm test`(PG 없이) **763 tests / 744 pass / 0 fail / 19 skipped**, 로컬 PostgreSQL 18.6 소켓을 주면 **763/763 pass**. Codex 리뷰(`50531b7`) P2 "unknown 조사에서 확인 뒤 쓰기 재시도"를 고친 뒤(`test/unknown-probe.test.ts` 새 시험 1개, 수정 전 `cancel을 다시 물음`으로 실패): **764 / 745 / 0 / 19**, PG 포함 **764/764**. 이어서 Codex 리뷰(`f733420`) P2 "`/retry` 상한을 대상 종류로"를 고친 뒤(`test/read-lane.test.ts` 새 시험 1개, 수정 전 "대기열이 가득 찼습니다"로 실패): **765 / 746 / 0 / 19**, PG 포함 **765/765**.
- 실행 환경: Node 24.22.2, TypeScript 7.0.2, PGlite 0.5.10, 로컬 `postgres:18-alpine`(PostgreSQL 18.6, `--pull=never --network none`, 데이터 tmpfs, 소켓 디렉터리 바인드).
- 새 핵심 시험은 수정 전 코드에서 실패하는 것을 먼저 확인했다(각 묶음 보고 기준: 답 형식 7, 수신 표시 13, 봇 답 문맥 10, read 레인 11, 종료 7, unknown·안내 10, 잠금 역전 PG 3, 지표·디바운스·진행 신호 21, 리뷰 수정 시험 전부).

| 시험 ID / 파일 | 등급 / 판정 | 확인한 경계 | 남은 검증 |
|---|---|---|---|
| 답 형식 `test/chat-format.test.ts` | mock / pass | 첫 항목 400자도 온전히 게시(이전엔 "(1개 생략)"), 사실 하나면 한 문장, 빈 섹션 생략, 24항목·한글·대리쌍 페이지 분할, 모두 빈 답 안내, read 요약 불변 | 실제 긴 답의 메시지 수·429 |
| 수신 표시 `test/chat-ack.test.ts` | mock / pass | 일반 메시지 👀 1회·텍스트 없음, 403/404 텍스트 대체 + 감사, 429 대체 없음, 상호작용 ephemeral 불변, ACK 단계 DB 오류가 `receive()` 밖으로 안 나감(job 1개 유지), history 복구·중복 무표시 | 실제 채널 권한(Add Reactions·Read Message History), 감사 `ack_reaction_fallback` 건수 |
| 봇 답 문맥 `test/chat-context.test.ts` | local_integration(PGlite) / pass | "가설 2번" 장면, sent만(pending·sending·unknown·blocked 제외), 일부 페이지 `partial`, 현재 입력 뒤 게시 제외, 다른 대화·owner·read·안내 제외, 20개·32KiB(한글·이모지), 현재 메시지 마지막 | 작업자 프롬프트 문구 변경 뒤 후속 질문 품질 |
| read 레인 `test/read-lane.test.ts`, `test/read-lane-pg.test.ts` | local_integration / pass, PG 다중 연결 / pass | 모델 실행·unknown·waiting_user·비상 중지 중 read 성공, read 동시 1·모델 동시 1, `/stop`·gap·철회 차단, lease 만료 failed+안내, 구버전 unknown read 정리, 대기열 read 몫, 게시 서버 둘의 동시 claim 중복 없음·제어 명령과 교착 없음 | 운영에서 모델 대기 중 `/read` 응답 |
| 정상 종료 `test/publisher-shutdown.test.ts`, `test/stop-confirmation.test.ts` | local_integration / pass | 드레인 안 완료, 드레인 초과 → cancel 확인 → chat queued(attempt 유지)·새 게시 서버가 이어 실행, 상한 chat·task는 failed, 확인 실패 unknown, dispatch 전 defer, 신호 뒤 claim 없음, 진입점 `stop()` 기한, DB 지연 중에도 드레인 직후 cancel, 확인 뒤 쓰기 일시 오류에도 cancel 재질문 없이 확정 | 실제 SIGTERM 경과 시간·감사 `publisher_shutdown` outcome |
| unknown 조사·상태 안내 `test/unknown-probe.test.ts`, `test/status-notice.test.ts`, `test/status-notice-pg.test.ts` | local_integration / pass, PG / pass | 작업자 확인 시에만 failed+안내, backoff 30초~10분, CAS, chat만, 불확실한 결과의 즉시 cancel, waiting·unknown 안내 멱등·멘션 없음, `/cancel`·`/model-status`와 안내 삽입·만료 처리(선잠금 직후 lease 만료 포함)가 교착 없이 끝남 | 작업자가 이미 끝낸 job의 해소(작업자 cancel 의미 변경 뒤) |
| 지표 `test/ops-metrics.test.ts` | mock / pass | 빈 DB 0, 작업 상태×종류, gap, outbox 상태, 제어 값, Gateway 정지, 기존 3개 불변, 라벨 화이트리스트 | 스크레이프·룰(D7) |
| 디바운스 `test/typing-debounce.test.ts`, `test/typing-pg.test.ts` | local_integration / pass, PG / pass | 2초 경계, owner 입력 → 8초 미룸·15초 상한·앞당기지 않음, 무관 입력 무시, running·urgent·read·task 불변, 오류가 gap 장벽을 세우지 않음, 힌트 처리 중에도 뒤 메시지·상호작용 즉시 처리, 늦게 끝난 힌트·같은 ms의 뒤 작업을 늘리지 않음, 채널별 합치기, 1.5초 기한·잠금 대기 시 버림, 종료 뒤 늦게 dispatch된 힌트의 DB 작업 0건 | 실제 TYPING_START 전달·intents 35329 수락 |
| 진행 신호 `test/activity.test.ts` | mock / pass, 진입점 / pass | running chat에만 8초마다, pause·정책 거부·종료 신호(대기 중 포함) 존중, 전송 직전 running 재확인, 429 기록 | 실제 typing 표시·rate limit |

- 기존 시험 기대값 변경(정당한 동작 변경): read를 `tickRead()`로 실행, 모델 대기열 상한 90, 상태 안내를 outbox 개수에서 구분, 답 섹션 "없음"·"(n개 생략)" 기대 제거(`review-9` 2건), 디바운스 경계 `advance(800)` → `advance(DEFAULTS.debounceMs + 50)`, intents 35329.
- 운영 확인 항목(미실행): 배포 중 대화 진행 시 감사 `publisher_shutdown`, 👀 표시와 `ack_reaction_fallback` 건수, 스레드에서 입력 중 → 첫 답이 15초 안, 모델 실행 중 입력 중 표시, `/metrics` 새 계열, 모델 대기 중 `/read`.
