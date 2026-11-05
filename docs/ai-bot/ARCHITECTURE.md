# ARCHITECTURE: 봇 V1 구조와 FOUNDATION 로컬 계약

- 단계: `TARGET=V1`, `STAGE=FOUNDATION`, `MODE=build` (T16a), 갱신 2026-10-19.
- **상태: 로컬 코드·mock/local_integration 검증, 실연동·배포 대기.** T15 설계 중 T16a가 확정한 부분은 §11이 기준이다. §1~10의 T16a 미정·제안 표시는 당시 기록이며 §11의 결정으로 대체한다. T17~T20의 열린 항목은 유지한다. D-14~D-17·D-24는 [DECISIONS.md](DECISIONS.md)를 따른다.
- **T16b 실행기 프로필(2026-10-30, D-14 변경):** 모델 실행기는 작업자 env로 고르는 프로필이다. 첫 운영 프로필은 Claude Code CLI + 구독 장기 토큰 + Opus 5.5이고, 기존 Codex 경로는 전환 가능한 프로필로 남았다. 아래 §0~§5의 Codex·`auth.json` 서술은 Codex 프로필 기준 기록이다. 작업자 실행기의 현재 기준은 §12 "T16b 실행기 프로필"이다.
- 근거 꼬리표는 [DISCOVERY.md](DISCOVERY.md)와 같다. 확인일은 모두 2026-10-18이라 꼬리표마다 다시 적지 않는다.
- 기준: 역할 경계는 `01` §1, 보안 경계는 `00` §6, 공통 계약은 `01` §2(F01~F09), 플랫폼 자리는 platform/design.md C.8. 이 문서는 이것들을 바꾸지 않는다.

## 0. 요약

1. **작은 제어 서비스 하나 + PostgreSQL + 격리 작업자 하나.** 게시 서버(ns `app-homelab-bot`, replicas 1)가 수신·조율·읽기 조회·게시를 맡고, 상태와 큐는 공유 PostgreSQL의 봇 전용 DB에 둔다. 모델 호출은 ns `sandbox`의 작업자만 한다.
2. **모델 자격은 작업자에만, 게시 자격은 게시 서버에만.** 모델 자격은 봇 전용 구독 계정의 `auth.json` 하나이고 작업자 전용 영속 CODEX_HOME에 있다(D-14). 비신뢰 자료(로그, PR, 댓글)를 읽는 모델은 Discord 토큰·GitHub App 키와 다른 파드에서 돈다.
3. **Codex는 `codex exec --json` 경로.** 질문은 턴 종료 + `exec resume`으로만, 도구 승인 중계는 `capability=false`. `codex app-server`는 어댑터 뒤 실험 후보로만 둔다. 사람이 연결한 기존 작업(R08)은 읽기 전용 알림으로 정했고 아직 켜지 않았다(§15).
4. **Discord는 Gateway로만 받는다.** 새 공개 수신 경로가 없다. 공개 경로는 GitHub webhook 한 경로뿐이다(설계 C.8).
5. **복구의 기본은 "외부 상태를 다시 읽고 대조"다.** Discord는 `after=` 대조, GitHub은 열린 PR 대조(webhook 수동 재전송은 3일 한정), 결과를 모르는 작업은 `unknown`으로 두고 다시 실행하지 않는다.
6. **작업자의 모델 호출은 한 번에 하나다.** `auth.json` 사본 하나를 대화 레인과 작업 레인이 함께 쓰기 때문이다(D-14 조건 3). 긴 작업 중 대화 응답성, 인증 파일 노출, 작업 사이 세션 파일 격리는 열린 항목이다(§5.1, §10).

## 1. 배치

```text
                 Discord Gateway(443 밖으로)     GitHub webhook          Alertmanager
                          │                    hooks.ukyi.app/github     (observability ns)
                          │                    Cloudflare → 터널 → Traefik     │ 경보 수신 포트 8081
                          ▼                              ▼ 앱 포트 8080       ▼
 ┌──────────────── ns app-homelab-bot : 게시 서버 (공유 차트, replicas 1) ────────────────┐
 │ 수신 어댑터: 서명·설치·저장소·작성자·사용자·채널 검사 → inbox 저장 → ACK                  │
 │ 조율자: 대화·작업 상태, 예약, 예산, 우선순위, 비상 중단                                    │
 │ 읽기 어댑터: Grafana(bot-reader Viewer) / K8s(SA bot-reader, Argo CD 앱 CR 포함, D9)      │
 │ 검증 계층: 리비전·공개 범위·허용 API·최종 효과 검사                                        │
 │ 제한 게시: Discord(봇 토큰) / GitHub 리뷰 App(COMMENT만) / 봇 쓰기 App(bot/ 브랜치·PR만)  │
 │ 자격: /apps/homelab-bot/ 경로만. 모델 자격 없음                                            │
 └───────────────┬──────────────────────────────────────────────┬───────────────────────────┘
                 │ 봇이 정한 HTTP 계약(작업자 포트 8080)            │ PostgreSQL(공유 pg, 봇 DB)
                 ▼                                                ▼
 ┌──────── ns sandbox : 작업자 (상주 파드, 모델 호출 직렬 1) ────────┐   inbox / jobs / outbox / 기억 / 예약
 │ 대화 레인: codex exec, 빈 작업 공간·read-only, 구조화 출력만     │
 │ 작업 레인: 작업마다 codex exec --json, 고정 SHA 작업 공간       │
 │ CODEX_HOME: 작업자 전용 영속 쓰기 공간(auth.json 갱신본 되쓰기)  │
 │ 자격: /apps/homelab-bot/worker 의 시드 auth.json 하나(D-14)      │
 │ egress: egress ns 프록시(고정 ClusterIP:3128)만                  │
 │         GitHub는 codeload.github.com만, GitHub 자격 없음(D-15)   │
 └──────────────────────────────────────────────────────────────────┘
```

- 게시 서버가 닿는 클러스터 안 목적지는 `platform/bot-slot`이 연 셋(작업자 Service, Grafana, `argocd-server`)과 PostgreSQL뿐이다. vmsingle·VictoriaLogs·Alertmanager API에는 닿지 않는다 [확인: 설계 C.8]. Kubernetes API는 노드 로컬 경로라 읽기 전용 SA가 경계다. D9(사용자 2026-10-30) 뒤 봇 코드는 `argocd-server`를 부르지 않는다(Argo CD 앱 상태도 Kubernetes API로 읽음, §5).
- 게시 서버의 인터넷 443은 공유 차트 규칙(IPv4, 사설·tailnet 대역 제외)을 따른다. Discord·GitHub·healthchecks.io 호출이 여기로 나간다 [확인: 설계 C.4.5 / IPv4만으로 되는지는 미확인, T16b].
- replicas 1인 이유: Discord Gateway는 shard 하나에 연결 하나이고, 큐 소비의 중복을 lease로만 막기보다 단일 소비자가 단순하다 [가정]. 재시작 중 짧은 공백은 §7의 대조로 메운다.
- T16a 확정: 대화도 작업자 Service:8080 → `codex exec` 계약을 따른다. 합산 모델 동시성은 1이다. 로컬 실행은 모의 작업자이며 실제 CLI 호출은 T16b다(§11).

## 2. 구현 방안 비교 (최대 2개)

두 방안 모두 NUC 클러스터 안이고(D-15), DB는 공유 인스턴스의 봇 전용 DB·역할(D-05), 큐는 PostgreSQL 테이블이다. 차이는 **대화용 모델 호출을 어디서 하느냐**다.

| 기준 | **방안 1 (추천): 모델 호출은 작업자에서만** | 방안 2: 게시 서버가 대화 모델을 직접 호출 |
|---|---|---|
| 구성 | 게시 서버 1 + 작업자 1. 작업자에 대화 레인과 작업 레인 | 게시 서버 1(대화 모델 호출 포함) + 작업자 1(Codex 작업·리뷰만) |
| 모델 자격 | `/apps/homelab-bot/worker`의 `auth.json` 하나(D-14) | 게시 서버에도 모델 자격이 필요하다. D-14 A의 `auth.json`은 사본 하나를 한 기기나 직렬 흐름 하나만 쓴다 [확인: https://learn.chatgpt.com/docs/auth/ci-cd-auth]. 그래서 따로 로그인한 두 번째 사본이 필요하고, 같은 계정으로 사본 둘을 둘 수 있는지는 [미확인] |
| 실행 격리 | 비신뢰 자료를 읽는 모델과 게시 자격이 다른 파드. 모델 출력은 HTTP 응답(구조화 JSON)으로만 돌아오고 게시 서버가 검증한다 | 같은 프로세스. 프롬프트 인젝션 때 함수 호출 검증(F09)이 유일한 경계. 게시 서버가 구독 자격을 가져 "모델 자격은 작업자에만"(설계 C.8)과 어긋난다 |
| 비용 | 같음(구독 고정 비용) | 같음 |
| 복구 | 작업자 장애 때 대화 응답도 멈춘다. 게시 서버는 수신 확인과 "모델 경로 장애" 상태를 계속 보낸다(R02, F06) | 작업자 장애가 대화에 번지지 않는다 |
| 운영 단순성 | 대화 한 번에 홉 하나가 더 있다 | 대화 경로가 짧다 |
| D-14 영향 | 대화 레인도 `codex exec`를 쓴다. API 직접 호출보다 느릴 수 있다 [가정]. 모델 호출이 작업 레인과 직렬이라 긴 작업 중 대화가 기다린다(§5.1) | 대화와 작업이 다른 사본을 쓰면 직렬 대기는 없다. 대신 위 자격 문제가 생긴다 |

**T16a 선택: 방안 1.** `00` §6 "모델 vs 게시"와 D-14의 자격 사본 하나·직렬 실행을 유지한다. 모의 지연 검증과 실측 계획은 §11이다. 실제 자격·프로세스 격리는 아직 미검증이다.

고르지 않은 것:

- **Valkey 큐:** D-06은 큐 유실이 치명적이면 PostgreSQL에 두라고 한다. F02(영속 inbox/outbox/job)가 바로 그 경우라 Valkey를 두지 않는다 [확인: spec §5.1 D-06 / 판단은 가정].
- **수신기·처리기 Deployment 분리, 마이크로서비스:** 논리 경계는 모듈로 나누고 프로세스는 하나로 시작한다(`00` §4 "작은 제어 서비스 + 영속 저장소 + 격리 실행기").
- **HTTP Interactions Endpoint:** 공개 경로와 Ed25519 검증이 하나 더 생긴다. D-17로 Interactions Endpoint URL은 비운다.

## 3. 도구·런타임

| 영역 | 제안 | 근거 | 확정 시점 |
|---|---|---|---|
| 언어·런타임 | TypeScript 7.0.2, **Node 24.22.0** | T16a 선택. DISCOVERY의 Node 24 대안과 로컬 검증 환경 유지. Bun 재연결 위험을 분리하며 Bun은 채택하지 않음 | T16a 확정, 실연동 T16b |
| Discord | **`DiscordProtocol` + 주입 REST(`discordHttpApi`)**. SDK 캐시 없이 PostgreSQL을 상태 원본으로 사용 | T16a는 Gateway frame 정규화·REST·history·게시 대조를 직접 계약 시험. `@discordjs/*`는 채택하지 않음 | T16a 어댑터 확정. 인증된 WebSocket 세션·heartbeat·RESUME 연결 구현은 T16b |
| Discord intents | `GUILDS` + `GUILD_MESSAGES` + `DIRECT_MESSAGES` + `MESSAGE_CONTENT` = 37377. intent를 끄면 4609와 명령/버튼 모드(DM 끔이면 513). DM을 쓰지 않으므로(확정(사용자 2026-10-20, T16a)) T16b는 `DIRECT_MESSAGES`를 뺀 33281로 연결했고, 개선안 v2(§13)부터 입력 중 힌트용 비특권 `GUILD_MESSAGE_TYPING`(2048)을 더한 35329로 연결한다 [가정: 실연동 T16b] | [실측: discord.js bitfield], D-17 확정 | DM 끔(T16a), 실연동 T16b |
| GitHub | App JWT → 작업마다 저장소 하나·필요 권한만의 1시간 설치 토큰. webhook은 원본 바이트 HMAC 상수 시간 비교 | [확인: https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app , https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries] | T17 |
| Codex | codex-cli 버전 고정(0.163.0 기준), `codex exec --json -o --output-schema`. JSONL fixture 계약 시험. 인증은 작업자 전용 CODEX_HOME의 `auth.json`(D-14) | [확인: https://learn.chatgpt.com/docs/non-interactive-mode / 실측: `codex exec --help`] | 대화 레인 T16a, 작업 레인 T18 |
| DB | 공유 CNPG `pg`의 봇 전용 DB·역할. 큐는 `FOR UPDATE SKIP LOCKED` + lease·heartbeat | [확인: spec §5.1 D-05·D-06] / 큐 방식은 [가정] | T16a |
| 마이그레이션 | Argo CD Sync hook Job, expand/contract | [확인: spec §5.1 D-22] | T16b |

[미확인] 새 앱 템플릿(D-21, E5)이 런타임·기본 이미지를 정하는지. 템플릿은 아직 옛 내용이다.

## 4. Codex 작업 어댑터의 V1 능력 표시

`01` §6 추상 계약 기준. 경로 (A) `codex exec`를 쓸 때다. 최종 값은 T18이 실측으로 정한다.

> T18 로컬·mock 값(2026-10-29)은 §12다. 실제 CLI 실측은 아직 없다(T16b, D-14 차단 조건).
> T16b(2026-10-30): 대화 레인의 실행기는 프로필로 고른다(§12 "T16b 실행기 프로필", Claude가 첫 운영 프로필). 이 표는 T18 Codex 작업 어댑터의 기준이다. 작업 레인은 Claude 전용 작업자로 조립했고 스위치가 기본 꺼짐이다(§12 "T18 작업 레인 조립").

| 계약 | V1 값 | 근거 |
|---|---|---|
| `capabilities()` | true. 고정 버전 + `--help` 대조 | [실측: `codex --version`, `codex exec --help`] |
| `start_task` | true. 작업 레인에서 `codex exec --json`, 작업 공간은 고정 SHA의 `codeload.github.com` 압축본 + `git init` 한 번 커밋(D-15) | [확인: https://learn.chatgpt.com/docs/non-interactive-mode] |
| `attach_task` | **결정 완료·구현 비활성.** R08은 읽기 전용 알림으로 정했다(§15). 핵심은 구현했지만 수신 경로가 미정이고 `/attach`·리스너가 연결되지 않아 어댑터 값은 아직 `undecided`이고 부르면 거부한다. 봇 소유 세션의 재개는 `resume_task`(R10 경로)다. herdr 경유는 쓰지 않는다 | 사용자 결정(2026-11-04, DECISIONS "T18 결정" (1)). herdr는 상태를 화면으로 추정하고 소켓에 인증이 없다 [확인: https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/website/src/content/docs/integrations.mdx , 실측: 소켓 0600] |
| `read_status`, `read_events` | true. JSONL 이벤트 + 프로세스 생존 | [확인: https://learn.chatgpt.com/docs/non-interactive-mode] |
| `read_final_result` | true. `-o` 파일 + `--output-schema` + 작업 공간 diff. "완료"라는 문자열은 판정 근거가 아니다 | `01` §6 완료 기준 |
| `answer_question` | **clarification만.** 모델이 턴을 끝내며 묻고, 봇이 `exec resume <id> "<답>"`으로 잇는다. 질문 ID는 봇이 `job_id + thread_id + 턴 순번`으로 만든다 | [실측: exec에 승인 플래그 없음] |
| tool approval 중계 | **false.** `--approve-for-me`(자동 검토)도 쓰지 않는다 | `01` §6 승인 구분, 무응답 자동 승인 금지 |
| `request_cancel`, `confirm_stop` | 작업마다 별도 process group(또는 cgroup)으로 실행한다. 취소 때 그 그룹 전체를 끝내고, 소멸을 확인한 뒤에만 `cancel_requested` → `cancelled`로 바꾼다. 확인할 수 없거나 남은 프로세스가 있으면 `unknown`으로 두고 새 실행을 막는다 [가정]. 정상 종료·실패·시간 초과 때도 같은 정리를 한다(아래 "작업 정리") | 공식 서술 없음 [미확인]. `codex exec` 부모의 종료만 보면 설치 스크립트·시험·모델 셸이 분리해 남긴 자식이 상주 파드에서 계속 돌고, 다음 작업 때도 `auth.json`·egress·제어 끝점에 닿을 수 있다 [가정] |
| `resume_task` | 같은 작업의 세션 파일이 남은 경우만(`--ephemeral` 금지). CODEX_HOME이 영속 공간이라 파드를 다시 만들어도 세션 파일은 남을 수 있다 [가정]. 진행 중이던 작업은 `unknown`으로 두고 재개 여부는 사람이 고른다. 리뷰·작업 레인은 다른 작업의 이전 세션을 재개하지 않고, 세션 저장 공간은 작업마다 나눈다 [가정](§5.1 "작업별 세션 저장 공간", T18) | [확인: https://learn.chatgpt.com/docs/non-interactive-mode (`exec resume`) / 실측: `codex exec resume --help`] |

**작업 정리** [가정], 방법은 T18:

- 작업 종료 사유(정상·실패·시간 초과·취소)와 무관하게 작업 그룹을 정리하고 소멸을 확인한 뒤에만 다음 작업을 받는다. 정상 종료한 `codex exec` 뒤에도 설치 스크립트·시험이 띄운 백그라운드 프로세스가 남을 수 있기 때문이다. 시간 초과는 §9의 1건 최대 시간이다.
- 확인 수단은 pgid만으로는 부족하다. 자식이 새 세션으로 빠져나가면 pgid로 찾을 수 없다. 후보는 작업 cgroup의 `cgroup.procs`가 비었는지 확인, 작업별 PID namespace, 또는 파드 안에서 제어 프로세스 밖 프로세스 0개 확인이다.
- 비특권 작업자 파드에서 cgroup 위임과 `unshare`가 되는지는 [미확인]이고 T08b·T16b에서 실측한다([DISCOVERY.md](DISCOVERY.md) §10).

**`unknown` 막힘 해제** [가정], 결정은 T18:

- 정리나 소멸 확인에 실패해 새 실행을 막으면, 그 막힘 상태는 봇 DB에 두고 재시작 뒤에도 유지한다.
- 막히면 Discord와 비AI 경로(Telegram)로 알린다.
- 해제는 작업자 파드를 다시 만든 뒤 프로세스 0개를 확인하거나 owner 명령으로 한다.
- 모델 호출은 대화 레인과 합쳐 직렬 1이라(D-14 조건 3) 막힌 동안 대화 레인도 대기하고, 게시 서버는 "모델 경로 장애"를 표시한다(§2 복구 행).
- 시험은 TASK-03과 OPS-02다.

함께 지킬 것: `shell_environment_policy`를 `inherit = "none"` 또는 명시 `include`로 고정한다 [확인: https://learn.chatgpt.com/docs/config-file/config-advanced 의 기본값 경고]. 모델 호출은 동시성 1이다(D-14 조건 3). 한도 도달·인증 만료 때 다른 계정이나 다른 인증으로 바꾸지 않고 waiting으로 둔다(D-14 조건 2).

## 5. 자격 배치 (키 이름만, 값은 Infisical)

| 경로 | 키 이름 제안 | 쓰는 곳 |
|---|---|---|
| `/apps/homelab-bot/` | `DISCORD_BOT_TOKEN` | 게시 서버 Discord 어댑터 |
| | `GITHUB_REVIEW_APP_ID`, `GITHUB_REVIEW_APP_PRIVATE_KEY`, `GITHUB_REVIEW_WEBHOOK_SECRET` | 리뷰 App(D-16) |
| | `GITHUB_WRITER_APP_ID`, `GITHUB_WRITER_APP_PRIVATE_KEY` | 봇 쓰기 App(D-24) |
| | `GRAFANA_READER_TOKEN` | 읽기 어댑터(Grafana). 설계에 보관 위치가 없던 자리. Argo CD 토큰은 두지 않는다(아래 D9) |
| | `HEALTHCHECKS_PING_URL` | 봇 하트비트(§8) |
| | `RUNTIME_POLICIES` | 허용 목록·runtime policy 실제 값(JSON). 모양은 [config/runtime-policy.example.json](config/runtime-policy.example.json). 공유 차트가 env로 넣고 봇은 기동 때 한 번 읽는다(D1, 사용자 2026-10-30, §11). §6 "허용 목록 반영" |
| `/apps/homelab-bot/worker` | 활성 프로필의 키 **하나**(D-14 변경, 사용자 2026-10-30): `CLAUDE_CODE_OAUTH_TOKEN`(Claude 구독 장기 토큰, `claude-subscription`) 또는 `CODEX_AUTH_JSON`(Codex 시드 `auth.json`, `codex-subscription`) | 작업자만. Claude 토큰은 실행마다 Secret 파일에서 읽어 그 실행의 자식 env 한 변수에만 넣는다(영속 공간 복사·되쓰기 없음). Codex 시드는 영속 CODEX_HOME에 `auth.json`이 없을 때만 쓴다. 두 키를 함께 넣어 인증 우선순위에 맡기지 않는다 |

- 작업자 경로에는 모델 자격 외에 아무것도 두지 않는다 [확인: 설계 C.8]. Kubernetes SA `bot-reader` 토큰은 Infisical이 아니라 공유 차트의 `serviceAccountName`으로 받는다 [확인: 설계 C.4.5].
- `ARGOCD_READER_TOKEN`(과 주소 `ARGOCD_URL`)은 없앴다(D9, 사용자 2026-10-30). `argocd-server`는 설계상 자체 서명 TLS만 써서 봇이 서버 인증서를 검증할 수 없고(사람용 Tailscale 프록시도 https+insecure로 붙는다), 봇이 읽는 것은 앱 객체 하나다. 그래서 Argo CD 앱 상태는 SA `bot-reader`(`get applications.argoproj.io -n argocd`)로 Kubernetes API의 Application CR을 읽는다. Kubernetes API는 SA의 클러스터 CA로 TLS를 검증한다. Infisical에 이미 넣은 값이 있으면 봇은 읽지 않으니 지워도 된다.
- App ID는 비밀이 아니지만 값 목록을 한곳에 모으려고 같은 경로에 둔다 [가정].
- ESO는 Infisical → Secret 한 방향이라 Codex가 갱신한 `auth.json`은 Infisical로 돌아가지 않는다 [가정: 설계 C.6.3의 읽기 전용 identity]. 갱신본의 원본은 작업자 영속 공간이고, 그 공간을 잃으면 사람이 다시 시드한다(D-14 남는 위험).
- 남는 위험: Infisical Free에는 경로 RBAC가 없다 [확인: 설계 C.6.3]. 작업자 store는 `/apps/homelab-bot/worker`로 묶이지만 같은 identity가 다른 경로도 읽을 수 있다.

### 5.1 작업자에 구독 인증 파일이 있는 구조 (D-14·D-15)

> D-14 변경(사용자 2026-10-30) 뒤 첫 운영 프로필은 Claude 구독 장기 토큰이다. 토큰은 회전 파일이 아니라 Secret 볼륨 파일 + 실행 중 모델 CLI 자식의 env 변수 하나에 있다(§12 "T16b 실행기 프로필"). 아래 대책과 남는 위험(같은 파드·UID의 비신뢰 코드가 자격을 읽을 수 있음, 작업별 세션 분리, 인증 파일 분리)은 토큰에도 같은 뜻으로 적용된다. T16b 대화 레인은 Claude 도구를 모두 끄고(`--tools ""`, MCP 없음, 실행 중 도구 호출 = 즉시 중단) 비신뢰 코드를 실행하지 않는다. 갱신본 되쓰기 항목은 Codex 프로필에만 해당한다.

D-14 A라서 작업자 파드에는 장기 갱신 토큰이 든 `auth.json`이 있다. 같은 파드에서 PR 코드의 패키지 설치·시험과 Codex가 띄우는 셸 명령이 돈다. 공식 문서는 비대화 실행에 키를 줄 때 같은 환경에서 비신뢰 코드가 돌지 않게 하라고 하고, 빌드 스크립트·시험·의존성 lifecycle 훅이 그 환경 변수를 읽을 수 있다고 적는다 [확인: https://learn.chatgpt.com/docs/non-interactive-mode]. 이 경고는 API 키 환경 변수에 대한 것이지만 같은 파일시스템의 `auth.json`에도 같은 이치가 적용된다 [가정].

| 대책 | 줄이는 것 | 근거 |
|---|---|---|
| egress는 egress 프록시 허용 목록만. GitHub는 `codeload.github.com`만이고 `github.com`·`api.github.com`·gist는 뺀다. 작업자에 GitHub 자격이 없다(D-15) | 작업 입력에 심긴 남의 토큰으로 gist나 push를 만들어 인증 파일을 내보내는 경로 | [확인: 설계 C.8 "남는 위험"(프록시는 CONNECT 호스트 이름만 봄)] |
| 모델 호출 동시성 1(D-14 조건 3) | 한 `auth.json`을 동시에 써서 갱신 토큰이 어긋나는 것, 같은 파드 작업끼리 작업 공간이 섞이는 것 | [확인: https://learn.chatgpt.com/docs/auth/ci-cd-auth] |
| 작업자 전용 영속 쓰기 공간(D-14 조건 4) | 파드 재생성 때 옛 시드로 덮어 인증이 끊기는 것 | [확인: https://learn.chatgpt.com/docs/auth/ci-cd-auth] |
| `shell_environment_policy` 고정 | 모델이 띄운 명령이 `KEY`·`SECRET`·`TOKEN` 이름의 변수를 받는 것 | [확인: https://learn.chatgpt.com/docs/config-file/config-advanced] |
| 작업자에 SA 토큰·kubeconfig·SSH agent·호스트 소켓 없음 | 운영 자격 노출 | [확인: 설계 C.8] |

**남는 위험**

- 비신뢰 코드(PR의 설치 스크립트·시험, 모델의 셸 명령)와 `auth.json`이 같은 파드·UID에 있다. 위 대책은 내보낼 경로를 줄일 뿐 읽기 자체는 막지 못한다 [가정]. egress 허용 목록에 남는 모델 쪽 도메인으로 내보내는 경로가 있는지는 [미확인].
- Codex Linux 샌드박스(bwrap)가 파드 안에서 안 돌면 `danger-full-access`로 돌려야 하고, 그러면 모델의 셸이 자격을 읽을 수 있다 [확인: https://learn.chatgpt.com/docs/agent-approvals-security]. Codex 샌드박스가 셸 명령의 CODEX_HOME 읽기를 막는지는 [미확인].
- 대화와 작업이 직렬 흐름 하나라 긴 작업 중에는 대화가 기다린다(R02, OPS-01).
- 작업별 세션 저장 공간(아래 열린 항목)이 정해지기 전에는 같은 UID에서 다른 작업과 대화 레인의 세션 파일도 읽힌다 [가정].

**열린 항목 (T18에서 판단. 단 인증 파일 분리는 T17·T18 중 먼저 공개 저장소 내용으로 모델을 부르는 단계 전에 정하고 SEC-02로 확인한다. 대화 레인의 경로·동시성은 T16a)**

- **인증 파일을 작업 레인 프로세스·파일시스템에서 떼는 방법.** 후보는 비신뢰 코드 실행(설치·시험)을 인증 파일이 없는 별도 컨테이너나 파드로 나누는 것이다 [가정]. 공식 `codex-responses-api-proxy`는 키를 stdin으로 받아 `/v1/responses`만 전달하는 도구라 [확인: https://github.com/openai/codex/blob/main/codex-rs/responses-api-proxy/README.md] API 키용이고, 구독 `auth.json`에는 그대로 맞지 않는다 [가정].
- **작업별 세션 저장 공간 [가정].** 대화 레인과 리뷰·작업 레인이 영속 CODEX_HOME 하나를 같이 쓰면 각 작업의 세션 파일이 같은 파일시스템에 남는다. 악성 PR 지시를 처리하는 `codex exec` 셸이 이전 비공개 Discord 대화나 다른 작업의 세션 파일을 읽어 구조화 결과에 넣으면, 그 결과가 공개 PR 댓글로 게시될 수 있다. 그래서 작업마다 세션 저장 공간을 나누고, 리뷰·작업 레인은 다른 작업의 이전 세션을 재개하지 않는다(같은 작업의 `exec resume`만, §4). 디렉터리만 나누면 같은 UID라 다른 세션 디렉터리 읽기를 막지 못한다(위 남는 위험). 수단 후보:
  - 작업별 UID나 마운트 namespace로 자기 세션 디렉터리만 보이게 한다.
  - 대화·리뷰 레인은 `--ephemeral`로 세션 파일을 남기지 않는 것을 검토한다. 재개가 필요한 작업 레인은 §4대로 `--ephemeral`을 쓰지 않는다.
  - 작업이 끝나면 그 작업의 세션 디렉터리를 지운다.
  - 인증 파일은 D-14 조건 4(영속 쓰기 공간에 갱신본 되쓰기)를 깨지 않게 다룬다. 예: 작업별 CODEX_HOME에 `auth.json` 쓰기 가능 사본을 두고, 작업이 끝나면 제어 프로세스가 직렬로 공유 원본에 되쓴다(사본의 `last_refresh`가 원본보다 새로울 때만). 취소되거나 `unknown`으로 끝난 작업의 사본을 되쓸지 버릴지는 열린 항목이다(T18).

  이 항목은 T18 열린 항목이지만 T17은 이 결정 뒤에 시작한다([V1_PLAN.md](V1_PLAN.md) §2·§5). 세션 파일 보존 기간과 기억 삭제(R17) 때 세션 기록 처리도 열린 항목이다. 시험은 DATA-01·SEC-02다.
- **대화 레인과 작업 레인의 분리 검토.** 같은 파드·같은 `auth.json`이면 직렬 1개를 나눠 쓴다. 파드를 나누면 대화 레인은 비신뢰 코드와 떨어지지만, 레인마다 따로 로그인한 `auth.json`이 필요하다 [확인: https://learn.chatgpt.com/docs/auth/ci-cd-auth "Use one auth.json per runner or per serialized workflow stream"]. 같은 계정으로 사본 둘을 둘 수 있는지는 [미확인]이다. D-14 조건 5(여러 계정 순회 금지)와 어떻게 맞출지 함께 본다.
- **구독 인증 Codex의 egress 도메인 목록** [미확인. T16b 실측].
- **작업자 제어 끝점 인증 (T16a 계약, T18).** 상주 제어 프로세스의 HTTP 끝점(작업자 포트 8080)은 같은 파드의 작업 프로세스(설치 스크립트, 시험, 모델 셸)가 loopback이나 파드 IP로 닿을 수 있다. Service 쪽 NetworkPolicy는 이 경로를 가르지 않고 [가정], init 방화벽(U13)도 loopback을 허용한다 [확인: 설계 부록 1 U13]. 인증이 없으면 악성 코드가 모델 작업을 넣어 구독 한도를 쓰거나 상태·취소 요청을 보낼 수 있다. 제안과 대안은 [DECISIONS.md](DECISIONS.md) D-15 "작업자 제어 끝점"이고, 시험은 SEC-02다.
- SEC-02에 "작업 레인 비신뢰 코드에서 `auth.json`·CODEX_HOME·환경 변수 읽기"와 "다른 작업·대화 레인의 세션 디렉터리 읽기" 사례를 넣는다([V1_PLAN.md](V1_PLAN.md) §3).

## 6. 보안 경계 (`00` §6 행별)

| `00` §6 경계 | 이 구조의 장치 | 남는 것·시험 |
|---|---|---|
| 조회 vs 변경 | 읽기 계정(`bot-reader`: Grafana Viewer, Kubernetes SA. Argo CD 앱 상태도 SA로 Kubernetes API에서 읽는다, D9)과 NetworkPolicy. **로그 제외는 플랫폼 권한으로 서지 않으므로**(Grafana OSS Viewer가 모든 데이터소스 질의) 읽기 어댑터가 사전 승인 질의 템플릿만 보낸다. 템플릿마다 데이터소스·네임스페이스·시간창 상한·응답량 상한. 시간창 상한은 보존 기간(메트릭 30일, 로그 14일, 설계 C.3.7)과 따로 T16a에서 정한다 | READ-02에 "허용 밖 LogsQL·MetricsQL 거부" 사례를 넣는다. 더 강하게는 데이터소스 API 앞 읽기 프록시(U12 대안). Argo CD live ConfigMap 노출 질문은 D9로 봇 경로에서 빠졌다(봇에 Argo CD API 자격 없음). SA는 `argocd` ns Application CR 전체(spec의 인라인 Helm values 포함)를 읽을 수 있고, transport는 `status.health`·`status.sync`만 투영한다 |
| 모델 vs 게시 | 모델은 작업자에만(방안 1), 게시 자격은 게시 서버에만. 작업자는 SA 토큰·kubeconfig·SSH agent·호스트 소켓·GitHub 자격 없음. 구독 인증 파일은 작업자 영속 공간에만(§5.1) | SEC-02: 작업자에서 환경 변수·CODEX_HOME·`auth.json`·SA 경로 접근, 다른 작업의 세션 디렉터리 읽기 시험 |
| 리뷰 | 전용 리뷰 App(D-16 확정). 게시 서버가 `event=COMMENT`만, `commit_id`는 검토한 head SHA. APPROVE·REQUEST_CHANGES·dismiss·merge·auto-merge 거부 | REVIEW-04 |
| 코드 수정 | 작업 공간은 고정 SHA의 `codeload.github.com` 압축본 + `git init` 한 번 커밋(D-15). diff는 base·head 압축본으로 만든다. 다만 리뷰 입력의 변경 목록은 압축본 비교로 정하지 않는다. 압축본에는 submodule 포인터(gitlink) 변경이 파일 내용으로 나타나지 않는다 [가정]. 게시 서버가 웹훅이나 조회로 head·base SHA를 먼저 고정하고, 같은 SHA 쌍으로 리뷰 App 토큰으로 Git tree API(recursive)나 compare API를 불러 경로·mode·object ID 차이(submodule gitlink 변경 포함)를 열거한 뒤, 같은 SHA의 압축본을 받아 blob 내용 수집에만 쓴다 [가정]. 기준 SHA는 `comparison_revision`과 같게 둔다. PR files API는 head SHA 대조에만 쓴다. 상한 초과나 `truncated`는 `partial`, 조회 실패는 `failed` 또는 `unknown`이고 압축본 비교로 대신하지 않는다. submodule 포인터 변경은 `01` §5의 누락 표시 규칙대로 결과에 드러낸다. 작업자에는 여전히 GitHub 자격이 없다(D-15) [가정]. 커밋·브랜치·PR은 게시 서버가 D-24 App(git data API)으로 만든다. 패키지 설치·시험은 비신뢰 코드 실행으로 본다 | SEC-02, CHANGE-01, REVIEW-03(submodule 포인터만 바뀐 PR, 열거 중 head 이동, 상한 초과) |
| 변경 게시 | 게시 서버 허용 API 목록(D-24, 목록 초안은 DECISIONS D-24). ref는 `refs/heads/bot/` 고정, `force: false`. 기준 리비전이 움직였으면 보류 | CHANGE-02·03 |
| 출처·공개 범위 | 결과마다 `output_classification`. 내부 출처(로그·메트릭·운영 기억)는 public PR·공개 스레드에 원문 게시 금지, 허용된 비민감 요약만. 마스킹만으로 충분하다고 보지 않는다 | DATA-01(다른 작업·대화 레인의 세션 파일을 읽어 공개 결과에 넣는 경로 포함, §5.1) |
| 프롬프트 인젝션 | 로그·PR 본문·댓글·변경된 `AGENTS.md`·기억은 자료 블록으로만 넘긴다. 리뷰 기준은 기준 리비전의 지침만. 허용 봇 작성자(Renovate 등)의 PR 본문도 비신뢰 자료(D-16 하위 결정) | SEC-01 |
| 현재 vs 과거 | 결과마다 `head_sha`·`comparison_revision`·`policy_revision`·관측 시각. 셋 중 하나라도 바뀌면(새 head, base 이동·재지정, 새 정책) 이전 결과 `superseded`(§7 대조) | REVIEW-02, R06 |
| 자동 실행 | V1에는 운영 실행 경로가 없다 | 해당 없음 |

**외부인 입력:** 봇 저장소와 앱 저장소가 public이라(D-29) 모델 호출 전 게이트를 둔다. 설치·저장소 허용, fork 제외, `author_association` 또는 허용 봇 작성자 ID(D-16 하위 결정). `CONTRIBUTOR`는 허용하지 않는다. 댓글 트리거는 `comment.author_association`을 보고 Bot 댓글은 무시한다. 댓글 트리거도 대상 PR을 조회해, 같은 저장소 PR이고 PR 작성자가 자동 리뷰와 같은 조건일 때만 모델을 호출한다(DECISIONS D-16 규칙 스케치).

**Discord 입력:** 매 이벤트마다 사용자 ID(문자열 snowflake)·guild·채널(스레드는 `parent_id`) 허용 검사. 봇·webhook 메시지 무시. 버튼은 누른 사람 ID를 질문 대상·작업 소유자와 대조. 모든 봇 메시지에 `allowed_mentions: {"parse": []}`(D-17).

**허용 목록 반영(F01, AUTH-02):** T16b D1(사용자 2026-10-30)로 아래 제안 중 파일 마운트·최대 나이는 채택하지 않았다. 지금 계약은 §11이다(env를 기동 때 읽기, 즉시 차단은 `/revoke`). 아래는 당시 기록이다. Infisical에서 허용 목록을 바꾸면 ESO 동기화를 거쳐야 봇에 닿는다. 정책을 확인할 수 없거나 오래됐으면 거부하도록 **실패 시 닫힘**으로 설계한다. 다만 이것이 철회의 즉시 효력을 보장하지는 않는다(아래 "남는 창"). 아래는 제안이고 값은 T16a에서 정한다 [가정]:

- 제안 [가정], T16a: runtime policy는 환경 변수가 아니라 마운트한 Secret 파일로 읽고, 파일이 바뀌면 다시 읽는다. 환경 변수는 파드를 다시 시작해야 반영된다 [확인: 설계 C.6.5]. 공유 차트 변경이 필요하다. 설계 C.4.5는 Secret을 키마다 환경 변수로만 넣는다 [확인: 설계 C.4.5]. 차트 대신 봇 쪽 추가 매니페스트로 할 수도 있다(T16a·T16b).
- 정책에 revision과 최대 나이를 둔다. 나이는 그 revision이 현재 값임을 마지막으로 확인한 때부터 잰다. 현재 revision을 확인할 수 없거나 최대 나이를 넘으면 접근을 거부한다. 확인 방법은 [미확인]이고 T16a에서 정한다.
- **남는 창:** Infisical에서만 철회하면 ESO 갱신 주기만큼 통과할 수 있다. 즉시 철회는 owner 거부 목록 명령으로만 된다. 위 확인 방법이 Infisical 원본 revision과 대조할 수 있는지는 [미확인]이다.
- owner의 즉시 철회 명령은 봇 DB 거부 목록에 바로 쓰여 ESO 동기화 전에도 효력이 있다. 거부 목록은 원본 정책 동기화와 별개로 명시적인 해제 확인까지 유지한다. 원본 Infisical 정책에서도 해당 권한을 철회한다.
- 즉시 철회 명령의 경계: owner ID로 검사하는 슬래시 명령이고, 모델을 거치지 않으며, 거부를 더할 수만 있다. T16a 해제는 철회 시각 이후 확인한 Infisical 새 revision이 해당 owner·scope를 허용하고, 사람이 DB의 해당 `denial_id`를 정책 `revocationRestores` 목록에 명시했을 때만 한다. 무관한 서비스 추가·revision 변경은 해제하지 않는다. 매 철회마다 새 ID를 발급하므로 이전 승인으로 새 철회를 풀 수 없다. 같은 revision의 재확인은 해제하지 않고 별도 owner 해제 명령은 없다. 그래서 `01` §10 비목표 "모델의 정책 자기 수정"(설정 `allow_policy_self_edit: false`)과 부딪히지 않는다 [가정].
- 큐에 든 작업, 예약, 기억 접근, 질문 답도 실행 직전에 같은 검사를 다시 한다(AUTH-02).
- **대가:** Infisical이나 ESO가 최대 나이보다 오래 멈추면 owner도 거부된다. 최대 나이는 이 대가와 철회 지연을 함께 보고 정한다.

## 7. 상태, 영속, 복구

**저장 단위(F02)** [가정: 스키마 초안, T16a에서 확정]: `events`(provider·actor·scope·수신 시각·delivery id·의미적 중복 키), `conversations`·`subscriptions`(스레드·DM·활성 상태), `jobs`(type·owner·target·revision·budget·state·attempt·lease), `questions`(job_id·question_id·유형·대상 사용자·만료), `results`·`evidence`(분류·리비전), `outbox`(대상·멱등 키·전달 상태·외부 ID), `memories`(`01` §8 최소 스키마), `schedules`(시간대·next_run), `audit`.

**상태 값:** `04` §3의 10개(`queued`~`superseded`)를 그대로 쓰고, 작업 결과·GitHub 게시·Discord 전달·PR 병합·배포 상태를 따로 기록한다. 모델 한도 도달·인증 만료 때의 waiting(D-14 조건 2)을 `04` §3 값 중 무엇으로 기록할지는 T16a에서 정한다.

**순서 규칙**

- 수신 → inbox 저장(짧은 타임아웃) → ACK. ACK는 최소 영속 insert가 끝난 뒤에만 보낸다. Discord 상호작용도 같다. 첫 응답(defer 포함)은 3초 안이어야 하지만 [확인: https://docs.discord.com/developers/interactions/receiving-and-responding] 저장 전에 defer하지 않는다. 저장이 그 안에 끝나지 않으면 작업을 받았다고 응답하지 않는다. 다시 시도하라는 명시적 실패를 응답하거나 응답하지 않아, 사용자가 실패를 보게 한다. 저장 전에 defer하면 그 뒤 프로세스가 죽거나 저장이 끝내 실패했을 때, 받은 것으로 보인 요청의 기록이 어디에도 남지 않아 대조할 수 없다 [가정]. 저장 타임아웃 값은 T16a에서 정한다(EVENT-01).
- 저장 타임아웃 뒤 insert가 늦게 commit되면, 사용자는 실패를 봤는데 작업이 돌고 다시 시도한 요청(새 interaction ID)과 중복된다. 그래서 전체 transaction과 각 statement에 남은 시간을 적용한다(§11). commit 응답만 잃으면 실제 수락 여부를 단정하지 않고, 같은 이벤트 ID의 중복 작업을 막는다 (EVENT-01).
- 외부 효과 전에 outbox에 멱등 키를 쓰고, 효과 뒤 외부 ID를 기록한다. 응답을 못 받으면 외부 상태를 먼저 조회한다(EVENT-02). Discord는 `nonce` + `enforce_nonce`로 짧은 창의 중복을 막고(창 길이 미확인), 그 밖은 outbox 대조로 막는다.
- 결과를 모르는 작업은 `unknown`. 자동 재실행하지 않는다(EVENT-04).

**재시작·누락 대조**

| 출처 | 대조 방법 | 한계 |
|---|---|---|
| Discord | RESUME 성공이면 재생. 새 IDENTIFY면 구독 스레드마다 마지막 처리 메시지 이후를 `GET /channels/{id}/messages?after=`로 읽는다. 한 번에 최대 100건이라 저장한 체크포인트부터 페이지를 이어 읽어 빈틈이 없을 때까지 반복하고, 정해진 복구 한도(100건×10쪽/30초, T16a §11)를 넘으면 그 스레드를 `gap` 상태로 기록하고 작업을 진행하지 않는다 [가정] | 새 IDENTIFY 때 놓친 이벤트 재생 여부는 문서에 없다. 보관된 스레드는 연결 때 동기화되지 않으므로 구독 목록 원본은 봇 DB다 |
| GitHub | 허용 저장소의 열린 PR을 주기적으로 읽어 처리 기록과 대조. 대조 키는 `01` §5의 세대 구분과 같은 `(head_sha, comparison_revision, policy_revision)`이다. head가 같아도 `comparison_revision`이 현재와 다르면 새 세대로 보고 이전 결과를 `superseded`로 둔다(REVIEW-02). 비교 기준은 정책 `comparison`이다. 운영 값 `merge_base`에서는 base 머리만 앞서가고 merge base가 같으면 같은 세대다. webhook 트리거에도 `pull_request` `edited` 중 base가 바뀐 경우(재지정)를 넣는다(DECISIONS D-16 규칙 스케치). 새 설치 직후 과거 PR을 무제한 리뷰하지 않는다 | 실패한 webhook은 자동 재전송되지 않고 수동 재전송은 3일 안만 된다. base 브랜치가 앞서가기만 하면 리뷰 App이 받는 PR 이벤트가 없어 폴링이 잡는다 [가정]. base만 움직였을 때 다시 리뷰할지는 `review.rereviewOnBaseMove`가 정한다. 운영 값은 `false`이고 재리뷰는 댓글 명령으로 한다(DECISIONS "T17 결정") |
| Alertmanager | 그룹화·반복 전송에 기댄다. 수신 실패는 Alertmanager 지표에 남는다 | 봇이 놓친 경보는 Telegram 경로가 따로 받는다 |
| 작업자 | 작업자 파드가 사라지면 `running` 작업을 `unknown`으로. CODEX_HOME은 영속 공간이라 세션 파일이 남을 수 있고, 재개 여부는 사람이 고른다 | 작업 공간(코드)은 영속이 아니다 [가정]. 영속 공간은 설계 C.8 변경이고 C.8 격리 행·E4b에 들어갔다(크기·백업은 T08b) |

**IDENTIFY 예산:** 24시간 1000회를 넘으면 모든 세션이 끊기고 봇 토큰이 리셋된다 [확인: https://docs.discord.com/developers/events/gateway]. 재연결은 지수 백오프로 하고, 프로세스 재시작 수와 IDENTIFY 수를 기록한다. 401이 이어지면 Discord 요청을 멈추고(잘못된 요청 10분 10,000건이면 IP 일시 차단) 비AI 경로로 알린다 [가정].

**백업·복원:** 봇 DB는 공유 PostgreSQL 백업(R2 `homelab-backups`, 14일)에 든다 [확인: spec §5.1 "설계 기본값"]. 삭제한 기억도 14일 동안 백업에 남을 수 있다. 삭제 표식을 봇 DB에만 두면, 삭제 전 백업으로 복원할 때 기억과 표식이 함께 되돌아가 다시 적용할 것이 남지 않는다. 그래서 삭제 표식은 **복원 대상 밖의 삭제 원장**에 둔다(DATA-02). 아래는 제안이다 [가정]:

- 원장은 봇 DB 복원으로 되돌아가지 않는 저장소에 둔다. 예: R2 append-only 객체, 또는 복원에서 빼는 별도 DB. 같은 공유 PostgreSQL 안의 별도 DB는 앱 하나 복원(설계 C.5.7, 그 DB만 되돌림)에서는 빠지지만 빈 NUC 복구(설계 C.6.4, 클러스터 전체)에서는 함께 되돌아간다 [가정: 설계 C.5.7·C.6.4의 복원 단위에서 도출].
- 원장에는 기억 ID, 그 기억의 `created_at`, 삭제 시각만 두고 내용은 두지 않는다. 재적용은 ID와 `created_at`이 둘 다 맞을 때만 삭제한다. 복원으로 ID 발급이 되감겨 새 기억이 같은 ID를 받으면, ID만 보는 재적용은 그 새 기억을 지운다.
- 제안: `memory_id`(`01` §8 최소 스키마)는 재사용되지 않는 값(UUID 등)으로 정한다. 위 `created_at` 대조와 함께 둔다.
- 봇은 기동할 때마다 원장의 삭제를 멱등하게 다시 적용하고, 그 뒤에 기억 조회를 연다. 그러면 백업 시점 이후의 삭제가 복원 뒤에도 다시 적용되고, 복원 절차가 봇에 따로 알리지 않아도 된다.
- 삭제 쓰기 순서 [가정], 결정은 T20: 원장 append가 내구성 있게 기록됐음을 확인한 뒤에만 봇 DB에서 지우고, 그 뒤에 삭제 완료를 응답한다(원장 기록 확인 → DB 삭제 → 완료 응답). 원장 쓰기가 실패하면 지우지 않고, 실패를 알리거나 재시도할 수 있는 outbox에 둔다. 원장 쓰기 결과를 모르면 원장을 확인해 기록 여부로 사용자 안내를 정한다. 원장 기록 뒤 DB 삭제가 실패하면 재시도 작업으로 성공할 때까지 지우고, 그동안 기억 조회(검색·브리핑·답변)는 원장(또는 DB의 숨김 표식)과 대조해 그 기억을 숨긴다. 기동 때 재적용만 기다리면 다음 재시작 전까지 지운 것으로 기록된 기억이 계속 쓰이기 때문이다. 두 쓰기는 서로 다른 저장소라 한 트랜잭션으로 묶이지 않는다. DB를 먼저 지우고 원장 쓰기가 실패한 채 완료로 응답하면, 삭제 전 백업을 복원할 때 다시 적용할 표식이 없어 기억이 되살아난다. 부분 실패 사례(원장 실패, DB 삭제 실패, 응답 유실)는 DATA-02다.
- 원장 위치는 정함(사용자 2026-11-02): NUC 두 번째 NVMe SSD의 파일(`deletions.jsonl` + 초기화 표식 `ledger.json`), 게시 서버만 PVC로 붙인다. 계약·단일 작성자 잠금·세대 묶기·받아들인 위험은 [DECISIONS](DECISIONS.md) T20. 보존 기간은 미정이고 백업 보존(14일)보다 짧으면 안 된다.

## 8. 봇 중단 경보 연결 (`01` §3 질문 2, OPS-02)

비AI 경보(Telegram)와 외부 생존 감시(healthchecks.io)는 플랫폼 몫이다(D-10). 봇 쪽에서 연결할 것:

| 장치 | 잡는 것 | 비용 |
|---|---|---|
| **(a) readiness는 수신·영속 저장 가능 여부만**: HTTP 수신기(webhook 8080, 경보 수신 8081)가 요청을 받아 inbox에 영속 저장할 수 있는지(DB 연결 등). Discord Gateway 연결과 inbox·outbox 지연은 넣지 않는다 | 요청을 저장하지 못하는 봇. KubePodNotReady(15분) → Telegram | 플랫폼 변경 없음 |
| **(b) 봇 전용 healthchecks.io 체크에 하트비트**: 조율자 루프가 돌 때만 주기 ping | 봇 정지, replicas 0, Application 삭제, NUC 중단. 통지가 NUC 밖에서 나간다 | 무료 체크 20개 중 1개 [확인: 설계 F D-10]. ping URL은 `/apps/homelab-bot/`에 |
| **(c) 봇 지표 + 봇 전용 룰**: Gateway 연결 여부 gauge, inbox·outbox 지연. Discord 재연결마다 울리지 않게 지속 시간 조건을 둔다 | Gateway 단절, 큐 적체처럼 살아 있으나 일을 못 하는 봇 | 앱 지표 스크레이프 규칙이 설계에 없어 먼저 정해야 한다 [미확인]. 지표 이름은 T16a, 룰 이름·지속 시간은 T08b |

**Gateway를 readiness에 묶지 않는 이유:** 게시 서버는 replicas 1이라 Not Ready가 되면 Service endpoint에서 빠진다. 그러면 멀쩡한 GitHub webhook(8080)과 Alertmanager 수신(8081)까지 끊겨, Discord 장애가 GitHub·경보 이벤트 유실로 번진다. 실패한 GitHub webhook은 자동 재전송되지 않는다(§7).

**추천: (a) + (b) + (c)** [가정]. Gateway 단절은 (c)로만 잡으므로 (c)를 미루지 않는다. **남는 위험:** 스크레이프 규칙과 봇 룰이 정해지기 전에는 Gateway만 끊긴 봇을 알리는 경보가 없다(해소: T08b 또는 T16b, §10). 모델 경로의 waiting(D-14 조건 2)은 봇 장애가 아니므로 readiness에 넣지 않는다 [가정].

**대안 (T16a에서 정함):** (b) 하트비트를 "Gateway가 최근 N분 연결돼 있을 때만 ping"으로 두면, (c)의 스크레이프 규칙이 없어도 오래 끊긴 Gateway가 healthchecks.io 외부 경보로 간다 [가정]. 고르면 위 남는 위험이 줄어든다. 채택 여부와 N은 T16a에서 정한다.

## 9. 예산 초기값 제안 (F05, `00` §8 `budgets`)

설정 초안에는 `null`로 두고 T16a·T16b에서 측정 뒤 정한다. 아래는 출발점 제안이다 [가정. 옛 AIOps 단계별 상한(모델 600초·2GiB, 전체 1200초)을 참고].

| 항목 | 제안 |
|---|---|
| 작업자 모델 호출 동시성 | 1. 대화 레인과 작업 레인을 합친 값이다(D-14 조건 3). 레인 분리는 §5.1 열린 항목 |
| PR 리뷰 1건 최대 시간 | 600초 |
| Codex·변경 작업 1건 최대 시간 | 1800초. 이 시간 동안 대화는 기다리므로 대화 요청에는 수신 확인과 대기 상태를 먼저 보낸다 [가정] |
| 외부 효과가 불명한 재시도 | 0(자동 재실행 금지) |
| 모델 오류 재시도 | 2회, 지수 백오프. 한도·인증 오류는 재시도 없이 waiting(D-14 조건 2) |
| 리뷰 입력 상한 | 파일 수·diff 크기 상한을 넘으면 `partial`로 표시(R12) |

## 10. 열린 설계 항목

- §5.1의 다섯: 인증 파일을 작업 레인에서 떼는 방법(T17·T18 중 먼저 모델을 부르는 단계 전에 정함), 작업별 세션 저장 공간(T17 시작 전에 정함)과 인증 파일 되쓰기 방식(취소·`unknown` 작업의 사본 처리 포함)·세션 보존 기간·R17 때 세션 기록 처리, 대화 레인·작업 레인 분리, 구독 인증 Codex의 egress 도메인 [T18, 실측은 T16b], 작업자 제어 끝점 인증 [T16a 계약, T18].
- 작업 종료 사유와 무관한 작업 그룹 정리와 소멸 확인 수단, `unknown` 막힘의 기록·알림·해제(§4) [T18, cgroup 위임·`unshare` 실측은 T08b·T16b].
- 대화 레인의 호출 경로와 동시성, 지연과 직렬 대기 시간 [T16a에서 정하고 T16b에서 측정].
- 작업자 영속 쓰기 공간의 크기와 백업 여부(D-14 조건 4): T08b가 정한다. 모양(PVC 하나, 파일이 없을 때만 시드)은 homelab `rebuild` 변경에서 설계 C.8 격리 행·E4b에 들어갔고, 영속 공간에 첫 시드를 복사하는 것은 T16b(설계 E9)다. 계정 준비와 시드 등록은 T16b 전(모델을 처음 쓰는 단계 전)이다.
- 작업자 이미지의 빌드·배포 경로: **정함(D2, 사용자 2026-10-30).** 게시 서버와 작업자가 봇 이미지 하나(`ghcr.io/ukyi-app/homelab-bot`, 저장소 `Dockerfile`)를 쓴다. `platform/sandbox`는 사람 PR로 그 digest를 고정하고 command만 `node dist/src/worker-main.js`로 바꾼다. 게시 서버는 자동 배포, 작업자는 사람 PR이라 버전이 어긋날 수 있다. 작업자 계약(`WorkerRequest` `version: 1`)을 바꾸는 봇 PR은 sandbox PR과 짝으로 낸다. 진입점은 §12 "T16b 작업자 진입점".
- Grafana 질의 템플릿 목록, 시간창 상한, 응답량 상한 수치 [T16a].
- 앱 지표 스크레이프 규칙과 Gateway 단절·큐 적체 봇 룰 [T08b 또는 T16b]. 정해지기 전에는 Gateway만 끊긴 봇을 알리는 경보가 없다(§8).
- 하트비트를 Gateway 연결에 묶는 대안의 채택 여부와 N(§8 "대안") [T16a].
- runtime policy의 현재 revision 확인 방법과 최대 나이(§6 "허용 목록 반영") [T16a]. → T16b D1로 정함: 기동 때 env 읽기, 나이 검사 없음(§11).
- 삭제 원장의 보존 기간(§7) [T20]. 저장소는 정함(SSD 파일, DECISIONS T20), 쓰기 순서와 부분 실패 처리는 T20에서 구현.
- R08 수신 경로 [H3]. 연결 방식은 정했다(§15).

## 11. T16a 확정 계약과 로컬 구현 (2026-10-19)

이 절은 T16a 범위의 구현 선택이다. 새로운 사용자 결정을 만들지 않으며, DM은 끄고(`dmEnabled: false`)
브리핑은 매일 08:50 Asia/Seoul이다(확정(사용자 2026-10-20, T16a)). 브리핑 실행은 T20이다.

### 호출 경로·직렬 대기·측정

Discord Gateway → `DiscordProtocol` → `DiscordIngress` → PostgreSQL 이벤트 저장 →
처리 경로(job/outbox/제어 결과) 영속 저장 → 수신 ACK(일반 메시지는 👀 리액션, §13) → `Runtime` → 서명 capability를 붙인 작업자 Service:8080의 `/v1/execute` →
`SerialWorker` → `codex exec` 계약 → 구조화 결과 → `results/outbox` → `DiscordPublisher`다.
`/read`는 모델을 부르지 않고 승인 템플릿 조회를 실행하며, 모델 슬롯과 분리된 read 레인에서 돈다(§13). Gateway 연결 루프는 T16b `src/gateway.ts`(아래), 모델 프로세스는 작업자 진입점(T16b)이다.
런타임은 Node 24.22.0이며, Discord 클라이언트는 SDK 없이 주입 가능한 `DiscordProtocol`을 선택했다.
인증된 WebSocket 세션은 T16b `GatewaySession`(Node 24 내장 WebSocket, intents 35329. §13 전에는 33281)이 이 어댑터에 잇는다. 봇 사용자 ID는 첫 READY에서 받고,
그 전에는 Discord 수신·게시를 하지 않는다(8080·8081 수신은 계속). 새 IDENTIFY(READY)마다 **live 이벤트를 처리하기 전에**
모든 활성 스레드·DM에 `gap=true`(복구 장벽)를 한 문장으로 세우고, 같은 문장에서 진행 중인 이전 복구의 `recovery_token`을 지워 새 복구 세대를 연다.
이전 세대의 복구는 다음 확인에서 토큰이 달라 손을 떼므로(`skipped`) 이전 history 스냅샷으로 새 장벽의 gap·checkpoint를 바꾸지 못하고,
스케줄러는 자기가 시작한 대기 항목일 때만 결과를 반영해 새 READY의 항목을 지우지 않는다. 그 뒤 live 메시지는 버퍼에 들어가 checkpoint를 올리지 못하므로
복구 차례를 기다리는 대화도 단절 중 메시지를 건너뛰지 않는다. 장벽 UPDATE가 실패하면 설 때까지 다시 시도하고 그동안 이벤트는 기다린다.
history 대조는 `RecoveryScheduler`(`src/recovery.ts`)가 대화별로 이벤트 처리 밖에서 돌린다. 일시적인 실패(시간 초과·429·서버 오류·정책 확인 불가)는
대화별 지수 백오프(1초부터 5분까지, 429·영속 pause면 `retry_after` 이상)로 READY 없이 다시 시도하고, 복구 한도(100건×10쪽/30초)를 넘은 경우만
수동 처리할 gap으로 남긴다(`recover()`가 `done`·`budget`·`skipped`를 돌려준다. 자기 토큰이 그대로인데 30초 lease가 지난 경우는
페이지 처리·버퍼 처리·checkpoint 갱신 어디서든 `budget`과 `history_gap` 감사이고, 토큰·구독 세대가 바뀐 경우만 `skipped`.
gap을 푸는 마지막 transaction은 lease 마감을 transaction 마감으로 받고 마지막 UPDATE 뒤에도 마감을 확인해, 확인 뒤 조회·UPDATE 왕복 중
마감을 넘기면 되돌려 gap을 남기고 `budget`으로 끝낸다. commit이 마감 안에 끝나면 `done`이다). 정책 거부는 재시도하지 않는다. 대기 목록은 메모리이고
재시작하면 새 READY가 다시 만든다. RESUMED면 Discord 재생에 맡긴다.
live 메시지 하나가 일시 장애(DB·REST·429 등)로 처리되지 못하면 그 이벤트는 sequence가 지나 다시 오지 않으므로, 그 채널의 활성 스레드·DM에만
같은 장벽(`RecoveryScheduler.guard()`, 진행 중 복구 토큰도 지움)을 세워 history 대조로 메운다. 장벽이 설 때까지 다음 이벤트는 기다려
뒤 메시지가 checkpoint를 먼저 올리지 못한다. 확정 거부(`Denied`·형식 오류·채널 403/404)는 장벽 없이 버린다. 상호작용은 토큰이 3초라
되살리지 않는다(사용자가 다시 보낸다). 작업 claim(`Runtime` 루프)은 첫 READY 장벽이 선 뒤에 시작한다. 재시작 때 남은 queued 작업이
중단 중 메시지를 history로 복구하기 전에 이전 입력으로 모델을 부르지 않고, 복구된 최신 메시지가 그 작업을 먼저 supersede할 수 있다. slash 명령은 READY마다 guild 단위로 FOUNDATION 12개에 맞춘다. 원장이 설정되면 `memory-*` 5개, 리뷰 경로가 열리면 `review-*` 3개, 작업 레인이 켜지면 `task` 등 5개를 더한다(같으면 쓰지 않음).
전역 명령은 비운다. 수신도 같은 목록만 받는다. 재연결·RESUME 실측은 실연동(S16)이다.

작업자 모델 호출은 **대화·작업 레인 합쳐 1개**다. DB의 scheduler 행 잠금과 작업자의 별도 mutex가
중복 실행을 막는다. lease가 끝나거나 호스트 결과를 모르면 `unknown`이 전체 모델 슬롯을 잡는다(read 레인은 막지 않는다).
개선안 v2(§13)부터 결과가 불확실하면 unknown 전에 cancel로 한 번 확인하고, chat unknown은 작업자의 종료 확인으로만 주기적으로 푼다.
한도·인증 만료는 `waiting_user` + `model_limit/auth_expired`와 스케줄러 정지를 원자적으로 기록한다.
이 기록이 실패하면 실행 슬롯을 유지하고 lease 만료 뒤 unknown으로 남긴다. waiting_user 자체도
새 claim을 차단한다. 자동 인증 전환은 없다. 완료 전이와 cancel_requested가 경합하면
같은 조건부 UPDATE가 cancelled를 선택하고 성공 결과·실패 안내를 만들지 않는다.
긴 작업 중 수신·저장 ACK·조회 없이 가능한 제어 명령은 계속 처리한다. 실행 중 작업을 대화가 선점하지 않는다.
실제 모델 답변은 직렬 대기하므로 대화의 즉시 답변을 보장하지 않는다. 파드 분리는 T18의 판단이다.

`audit.kind=model_timing`에 `queueWaitMs=started_at-created_at`, `executionMs=종료-started_at`을 남긴다.
로컬 시험은 모의 작업이 실행 중인 동안 두 번째 대화의 ACK가 도착하고 두 번째 모델 호출이 없음을 확인한 뒤,
가상 시계 5초를 전진하고 첫 작업을 끝낸다. 두 번째 호출의 기록된 대기가 **5초 이상**인지 검증한다.
이는 실제 모델 지연의 측정값이 아니다. T16b는 유휴 대화 30회와 긴 작업 중 대화 30회에서
수신→저장 ACK, 큐 대기, 모델 실행, outbox 대기, 수신→최종 게시의 p50/p95/max와 표본 수를 기록한다.
재연결·429·한도 대기는 따로 분류한다. 첫 ACK의 3초 제약, 아래 1500ms 저장 마감과 함께 실측하고
목표를 못 맞추면 모델 동시성을 늘리지 않고 작업 시간·대화 안내·T18 레인 설계를 재검토한다.

### 저장·권한·게시

`001_foundation.sql`은 이벤트, 대화/구독, 작업, 결과/증거, outbox, 예약 기반, 감사, 거부 목록,
사건 그룹을 정의한다. `002_denial_revision.sql`은 철회 당시 revision을 추가한다.
`003_recovery_controls.sql`은 철회 ID와 outbox의 영속 일시 중지 사유·횟수를 추가한다.
`004_delivery_services.sql`은 outbox service_ids를 추가하고 기존 read 결과도 job/event에서 역으로 채운다.
기존 revision/철회 ID 없는 거부 행은 자동 해제하지 않는다. T17·T18·T20은 후속 마이그레이션으로 확장한다.
작업 상태는 `04` §3의 10개 값이며 작업 성공과 외부 전달 상태는 별도다.

일반 PostgreSQL transaction의 statement timeout은 **1500ms**, lock timeout은 **1000ms**다.
수신 처리 경로에는 절대 마감을 전달하고, PostgreSQL 18의 transaction_timeout을 남은 시간으로 설정한다.
각 statement 및 COMMIT 직전에는 남은 시간 이내로 statement_timeout을 줄이고, 최종 UPDATE 뒤에도
마감을 검사해 rollback한다. 플랫폼 설계의 PostgreSQL 18.6 계약에 의존한다. DB에서 이미 commit한 뒤
응답 전달만 늦어진 경우는 늦게 실행된 transaction과 구분하며 수락 여부를 임의로 뒤집지 않는다.
ACK 전에 inbox와 처리 경로를 저장한다. 처리 경로 transaction 안에서 1500ms 마감을 검사하고,
그 전에 실패하면 ACK하지 않고 `accepted=false`만 남긴다. commit 응답 유실은 실제 commit 여부가
불확실하므로 수락 상태를 단정하지 않는다. 성공적으로 commit한 뒤 ACK 응답이 유실돼도 이미
저장한 작업은 계속되고 `ack_uncertain`을 남긴다. 같은 ID는 event 행을 FOR UPDATE로 잠그고 accepted를
확인한다. true면 종료하고 false면 저장된 actor/scope/입력으로 다시 라우팅한다. 제어 명령도 이 잠금과
같은 transaction 안에서 한 번 실행한다. save 직후 프로세스 종료·route rollback 뒤 재전달/복구도 적용한다.
기존 job 재수락은 큐 상한보다 먼저 검사하므로 큐가 가득 차도 같은 job을 반환한다.
Discord REST 전송 제한은 세 가지다(S16 실측 뒤 사용자 결정 2026-11-02, 이전 1초 일괄 제한을 나눔). 작업 수락 여부와는 분리한다.
상호작용 첫 응답(callback)은 그 상호작용 기한(아래 REVIEW-8, 진입 + 2500ms)의 남은 시간 전체를 쓴다.
Gateway dispatch 안의 REST(이벤트 채널 조회, 일반 메시지 👀 리액션과 그 대체 게시)는 **1초**다. dispatch는 이벤트를
하나씩 처리하므로 오래 기다리면 뒤에 밀린 상호작용이 3초 기한을 놓친다. 그 밖의 REST(게시·대조, history 복구의
채널·history 조회, 명령 등록, gateway URL, 입력 중 표시)는 **5초**다. 게시 lease·복구 lease(각 30초)나 별도 루프 안에서
돌아 몇 초 기다려도 계약이 깨지지 않는다. 복구 중 느린 응답으로 30초를 넘기면 기존대로 budget(gap 유지)이다.
`ack_uncertain` 감사 detail은 `{ processing: 'durable', reason }`이다. reason은 `timeout`(전송 제한 초과)·`expired`(기한이
지나 callback 생략)·`rate_limited`·`paused`(채널·전역 429 중지 중)·`rejected:<상태>`(400/403/404)·`unauthorized`·`denied`·
`policy_unavailable`·`http_error`(그 밖의 비정상 응답)·`error` 중 하나다. 오류 원문·토큰은 남기지 않는다.
상호작용 ACK 만료·유실 때는 처리 스레드/DM에 요청이 저장됐으며 재전송 전에 `/list`를 확인하라는
멱등 안내를 보낸다. 새 스레드는 생성 대조 뒤 안내한다. 같은 명령 문자열의 별도 요청을 자동 합치지 않는다.
정상적인 반복 작업을 잃지 않으려는 선택이며, 안내 전에 사용자가 새 ID로 재전송할 중복 위험은 남는다.
이벤트 payload는 검증된 사용자 입력만
저장하고 상호작용 token·원문 헤더를 저장하지 않는다. 대화 맥락은 **현재 job의 event_order 이하**에서 수락된 최근 **20건/32KiB**다.
작업 event ID를 경계로 반드시 전달하며 다른 대화의 경계나 존재하지 않는 event는 빈 맥락을 반환한다.
동일 수신 시각이나 작업 claim 뒤 도착한 후속 요청이 앞 작업의 맥락에 섞이지 않는다.

runtime policy는 env `RUNTIME_POLICIES`(Infisical → 공유 차트 env)를 **기동 때 한 번** 읽는다(D1, 사용자 2026-10-30, T16b).
`confirmedAt`은 사람이 넣지 않고 봇이 읽은 시각으로 채운다. JSON·구조가 잘못되면 기동이 실패하고, 오류에는 알려진 필드 이름만 남긴다(모르는 키는 이름 대신 `unknown_field(개수)`).
값을 바꾸면 `homelab secret set`이 파드를 다시 시작해 반영한다. 읽은 뒤 시간이 지났다는 이유로 닫지 않는다(300초 검사는 없앴다).
`confirmedAt`이 미래 시각(시계 역행)이거나 정책 원천을 읽지 못하면 닫힌다. ESO 동기화(1시간)와 재시작까지의 창은 남으며,
즉시 차단은 owner의 `/revoke`가 영속 거부 목록에 추가하는 것이다. 실행·조회·게시 전에 현재 owner·scope를 재검사한다.
정책 확인 불가는 queued/pending을 보존한다. queued는 1초 뒤, pending은 1초부터 최대 60초까지
지수 backoff한다. 일시 중지 사유·횟수는 DB에 남기고 감사는 사유 변화 때만 기록한다. 새 revision 자체로 거부하지 않는다.
실제 권한 철회는 작업 종료 확인 뒤 cancelled, 종료가 불명하면 unknown이며 게시는 blocked로 막는다. 완료된 모델 결과는 게시 정책 확인을 기다리며 재실행하지 않는다.
이미 인가해 실행 중인 모델은 정책 확인 불가만으로 중단하지 않고 lease heartbeat를 유지한다.
모델은 게시 권한이 없고, 완료 결과의 게시·새 작업은 최신 정책을 다시 확인한다.
실제 Denied·사용자 취소·예산 초과·lease 유지 실패는 중단을 요청한다. 확인된 실패는 실패 안내
outbox를 함께 기록하고 종료 불확실만 unknown이다. monitor에서 확인한 Denied는 실행 종료 처리까지
보존한다. 종료 확인 뒤 cancelled/authorization_revoked, 종료가 불명하면 unknown/authorization_revoked로
기록하고 실패 안내 outbox 자체를 만들지 않는다. /retry는 두 상태 모두 거부한다.
거부 목록 해제는 §6의 명시적 `revocationRestores` 승인과 새 revision, 철회 뒤 기동(읽은 시각 `confirmedAt` > 철회 시각) 조건을 모두 요구한다.
Discord 401은 별도 오류로 pending을 유지한다. 토큰 갱신 후 새 REST 어댑터를 주입해 재개한다.

부모 채널은 비활성이며 매번 멘션/명령이 필요하다. 활성 스레드만 멘션 없는 후속 메시지를 수집한다.
스레드는 공개, 보관 시간 **1440분**이다. 모든 메시지/상호작용 응답의 `allowed_mentions.parse=[]`를 강제한다.
제어 명령 결과(`/list`·`/stop`·`/resume`·`/cancel`·`/retry`·`/emergency-stop`·`/resume-model`·`/model-status`·리뷰 제어)는 `controlText`(`src/control-format.ts`)가 짧은 한국어 문장으로 바꿔 게시한다. 예: `/list` → "작업 N건" + 줄마다 `` `<작업 ID>` 상태(대기 사유) ``(최근 20건, 넘으면 머리줄에 "최근 20건만 표시"), 거절은 "실패: <안내>", `/model-status`는 모델 호출·비상 중지·실행 중 작업·한도/인증 대기 목록과 안내. 작업 ID는 `/cancel`·`/retry` target에 그대로 넣어야 해서 줄이지 않는다. 모르는 결과 모양은 JSON 그대로 둔다. 이전에는 결과를 `JSON.stringify`해 `{"ref":...,"data":[...]}`로 보였다(S16). 이제 제어 결과도 일반 문장이라 marker는 끝 줄 `[ref:…]`이고, JSON 본문의 marker 필드 방식(`markedContent`)은 JSON으로 읽히는 다른 본문을 위해 남겨 둔다.
outbox UUID별 멱등 키에서 24자 nonce와 게시 marker를 만든다. 응답 유실은 unknown으로 두고 게시자의 marker와
스레드 이름을 제한 조회한다. 못 찾았다고 재게시하지 않는다.
대조 중 429는 즉시 루프를 중단하고 전역 다음 대조 시각을 DB에 기록한다. 재기동해도
최소 1초 또는 retry_after 중 긴 쪽을 기다린다. 기존 unknown의 24시간 기한은 연장하지 않는다.
HTTP 429의 global 필드를 보존하며 true면 controls.discord_global_after에 더 긴 중지 시각을 기록한다.
새 delivery claim, 게시 직전, unknown 대조, ACK, history가 공통 중지 시각을 검사한다. ACK/history에서
받은 global 429도 같은 시각을 갱신한다. 대기 때문에 생략한 ACK는 시각을 연장하지 않고 기존 만료 안내를 쓴다.
이미 시작된 다른 요청을 소급 취소하지는 않는다. 실제 다중 프로세스 경합/Discord 제한 실측은 T16b다.
외부 생성 ID가 없는 unknown 전달은 별도 **100건/24시간** 한도로 유지하며 초과·만료 시 감사 기록 후 blocked로 닫는다.
경보 backpressure는 pending/sending만 센다. 서로 다른 groupKey도 공통 alert_admission 행을
잠근 뒤 count와 삽입을 한 transaction에서 실행해 동시 경보 수락의 상한 검사를 직렬화한다. unknown 지표 경보 연결은 T16b다. Discord의 exactly-once를 보증하지 않는다.
경보의 pending/sending/unknown thread는 재사용하고 blocked는 새 수신의 세대 키로 대체한다.
incidents.delivery_key가 마지막 전달을 추적하므로 thread 생성 전후 모두 차단 뒤 동일 fingerprint를 다시 수락한다.
세대는 사건 count를 사용하고 event semantic key도 세대를 포함한다. 원격 생성 여부가 불명인 unknown은 자동 재생성하지 않는다.
스레드 확정은 alert_admission 잠금을 공유하고 대화·event·incident·요약·sent를 한 transaction으로 갱신한다.
복구는 100건씩 **10페이지/30초**까지다. live 메시지 checkpoint를 갱신하고, 복구 중에는 `gap=true`로 새 job claim을 막는다.
active는 구독 여부만 뜻한다. gap 중에도 이미 시작한 모델/read는 결과를 저장하며 publisher는 pending을
history_gap 사유로 backoff하고 unknown 대조를 미룬다. gap 해제 뒤 같은 결과를 게시하며 모델을 다시 실행하지 않는다.
한도를 넘으면 gap을 유지한다. 더 긴 누락의 수동 복구는 T16b 운영 절차로 정한다.
after 페이지를 오름차순 처리한 뒤 최댓값으로 전진하는 방식은 유지한다. checkpoint=null일 때는 after=0을 명시한다.
정렬과 선택 범위에 대한 [공식 문서/라이브러리 판정](DISCORD_RECOVERY.md)을 참조한다. 이 판정은 서버 실측이 아니다.

### 조회·예산·작업자 제어

읽기 템플릿은 service·datasource·namespace·고정 query·시간창·바이트·행 상한을 함께 가진다.
상한은 상태 **5분**, 메트릭 **6시간**, 로그 **1시간**, 응답 **64KiB/200행**, 질의 문자열 **2000자**,
요청 **5초**다. 템플릿은 더 작게 정할 수 있다. 시간창 상한은 유한한 1초 이상이다.
Runtime의 /read는 ReadAdapter.recent를 통해 한 번 읽은 현재 시각을 기준으로 템플릿 상한(`maxWindowSeconds`) 전체를 요청한다(S16 수정, 이전 min(60초, 상한)은 logs를 거의 늘 0줄로 만들었다). 행 수·바이트 상한은 그대로다.
명시적인 read 시간창을 자동 축소하지 않으며 상한 초과와 정책 `services` 밖 서비스는 거부(Denied)한다. 보존 기간 30일/14일과 별개다.
등록되지 않은 서비스와, 없는 템플릿·다른 서비스의 템플릿은 조회 없이 `unregistered` 결과다(미확인: "등록되지 않은 서비스"/"등록되지 않은 조회 템플릿"). job은 succeeded이고 스레드에 같은 모양의 답이 간다. 템플릿 이름은 권한 경계가 아니라 입력 오류라서다. 이전에는 없는 템플릿이 Denied라 runtime이 `cancelled`(`authorization_revoked`)로 기록하고 아무 답도 없었다(S16). 정책 `services` 검사가 템플릿 검사보다 먼저라 권한 밖 서비스의 템플릿 존재 여부는 드러나지 않는다.
현재 사실은 5분 안의 관측이며 빈 응답·오래된 값·조회 실패는 미확인이다.
공개 응답은 대상·출처·시간창·시각·사실/가설/미확인·권장 확인을 포함한다. 시간창과 관측 시각은 ISO-8601 UTC 초 단위(`2026-11-02T01:54:55Z`)다(`readSummary`, 이전 epoch ms 숫자). 로그 원문은 게시하지 않는다(줄 수만).
서비스별 read 결과와 경보는 outbox의 service_ids에 범위를 남기고 게시·대조 직전 현재 policy.services로 검사한다.
경보는 지원 라벨을 거른 뒤 고유 서비스 집합을 저장하며, thread 병합으로 내용을 교체할 때 범위도 교체한다.
게시·대조 직전에 DB의 service_ids를 다시 읽어 claim 뒤 병합도 재인가한다.
초기 요약은 thread 확정 transaction에서 읽은 최신 service_ids를 이어받아 전송 중 병합도 반영한다.
fingerprint 계산에 서비스 ID도 포함해 같은 fingerprint 문자열의 서비스 변경을 놓치지 않는다.
006 이전 경보는 건수만 남아 서비스 범위를 재구성할 수 없으므로 미전달·범위 없는 행은 blocked와 감사로 닫는다.
이미 sent인 전달과 범위를 가진 행은 바꾸지 않으며 과거 경보의 범위를 현재 허용 목록으로 추정하지 않는다.
read 요약 예산은 대상/출처 각 120자, 사실 600자, 미확인/권장 확인 각 350자다. 항목 수가 넘으면 생략 건수를
표시한다. 대화(chat) 답은 이 섹션 예산을 쓰지 않고 모든 항목을 싣는다(§13 답 형식). 작업 목록은 최근 20건을 텍스트로 표시한다. 긴 본문은 1800자 이하 페이지로 나눠(JSON 배열 본문은 페이지마다 유효한 배열로) 별도 멱등 키로 게시한다.
논리 메시지 key와 0부터 시작하는 page_index를 저장하고 선행 페이지가 모두 sent인 경우에만 다음 페이지를 claim한다.
첫 페이지의 429/unknown/blocked 때문에 뒤 페이지가 추월하지 않으며 공유 rate limit이 없는 다른 메시지는 계속 처리한다.
페이지 생성 전체도 한 transaction이다. migration 005는 기존 :page:N 키를 순서로 옮기고 경보 전달 참조를 복원한다.
이미 게시된 역순 페이지는 되돌리거나 재게시하지 않는다. blocked 선행 페이지의 수동 해소는 T16b 운영 절차다.
일반 텍스트도 1800자씩 손실 없이 나눈다. 게시자가 끝 1900자를 조용히 버리는 처리는 없다.
004 이전의 비정상적인 큰 pending 메시지는 자동 절단하지 않고 blocked로 둔다.
임의 질의·Secret·ConfigMap·pods/log/exec의 요청 이름과 추가 필드를 거부한다.
라이브 API 응답 투영은 T16b `src/read-transports.ts`다(Grafana `POST /api/ds/query` 메트릭·VictoriaLogs, Kubernetes API의 Deployment·StatefulSet과
Argo CD Application CR(D9: `argocd-server` API가 아니라 SA `bot-reader`로 `/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/{이름}`,
이름은 카탈로그 고정값만, `status.health`·`status.sync`만 투영), 응답 4MiB 상한, redirect 거부, 고정 경로 모양만.
Kubernetes는 SA 토큰을 요청마다 다시 읽고 SA CA로 TLS를 검증하며, `status.observedGeneration`이 `metadata.generation`보다 뒤처지거나 없으면 `unknown`).
서비스·템플릿은 `src/catalog.ts`, 여는 서비스 ID는 정책이다. 플랫폼 권한 증거는 실연동(S16)이다.

부모 채널의 스레드 생성 뒤에도 저장된 urgent command/flag를 전달한다.
스레드/DM/부모 채널에서 받은 `/read`는 type=read, debounce 0이며 queued-chat supersede 대상에서 제외한다.
기존 read job도 migration 005로 유형을 옮긴다. 이미 종결된 superseded 작업은 임의로 재실행하지 않는다.
기본 debounce **2초**(owner 입력 중이면 작업 생성 뒤 최대 15초, §13. 이전 750ms), urgent **0ms**, 큐 **100건**(그중 read 몫 10), lease **30초**, 대화 모델 **60초**,
작업 레인 **1800초**, 도구 예산 **8회**, 확인된 실패의 사용자 재시도 **2회**다.
FOUNDATION 모델 경로에는 실행 가능한 셸/도구 dispatch가 없다. 실제 도구 카운터·작업 실행은 T18 계약으로 구현한다.
입력 오류는 수신 단계에서 거부한다. dispatch 전 확정 실패·작업자 실행 전 거부·중단 확인된 무효 출력은
failed와 실패 안내로 남기고 모델 슬롯을 해제한다. 연결 수립 전의 ECONNREFUSED·ENOTFOUND·
EAI_AGAIN·UND_ERR_CONNECT_TIMEOUT도 확정 실패다. ECONNRESET·응답 도중 단절은 unknown이다. dispatch 후 종료 불확실만 unknown이다.
작업자 HTTP는 Node 24 내장 fetch와 호환하는 undici 7.30.1 Agent를 쓰고,
headers/body timeout을 요청 예산 + 30초로 둔다. 호출자 예산·취소 신호는 그대로 적용한다.
dispatch 전 PolicyUnavailable의 defer는 최신 cancel_requested를 원자적으로 cancelled로 바꾸고 lease를 해제한다.
그 외에는 queued로 되돌린다. 유효 lease 조건은 유지한다. 완료/실패/대기/결과 폐기에서도 취소를 우선하며,
종료가 확인되지 않은 worker만 unknown으로 남아 전역 슬롯을 유지한다.
unknown은 자동 재시도 0회다. Discord 429는 retry_after를 지키고 총 3회 뒤 blocked다.
IDENTIFY는 rolling 24시간 **900회**를 로컬 상한으로 두고 1000회 문서 한도에 여유를 남긴다.
재연결 backoff는 1~60초 + 0~1초 jitter 계약이다. T16b `GatewaySession`은 새 IDENTIFY 직전에 `GatewayBudget.reserve()`로 일일 900회와
IDENTIFY 간격(단일 shard)을 같은 잠금 아래에서 함께 예약하고 그 시각까지 기다린다. 예약마다 전송 창(예약 시각부터 0.4초)이 있고
그 안에서만 보낸다. 예약 응답(DB)이 늦어 창을 놓치면 그 예약은 지우고(보내지 않았으니) 다시 예약한다(연결당 3번, 넘으면 끊고 재연결).
다음 예약은 직전 예약 + 5초 + 창 0.4초 + 망 지연 여유 0.1초 = 5.5초 뒤라, 실제 전송 간격은 늘 5.1초 이상이다.
예약은 audit에 남아 재시작에도 이어진다. 연결 전에는 `next()`로 소진·대기 시간을 보고(소진되면 연결하지 않음), RESUME은 예약하지 않는다.
다중 shard가 되면 `max_concurrency` 버킷마다 간격을 따로 둔다. 재연결 간격에는 이 backoff를 쓴다.
Gateway 끊김 판단: 봇이 스스로 끊는 경우(heartbeat ACK 누락, HELLO 시간 초과, op 7·op 9, 전송 실패, 잘못된 HELLO·READY, IDENTIFY 예약 실패)는
소켓의 close 응답을 **기다리지 않고** 그 자리에서 끊김으로 본다. 연결 gauge를 0으로 내리고 타이머를 정리한 뒤 close 코드 4900으로
재시도를 예약하고, 그다음 소켓 close를 시도한다(로그 순서 `gateway_drop → gateway_closed(4900) → gateway_retry`). 버린 소켓의 늦은
close·message·error는 무시한다. 패킷이 버려지는 망에서는 close 응답이 TCP 재전송 한도까지 오지 않아, 기다리면 그동안 gauge가 1로 남아
단절 경보가 울리지 않았다(S16: 13분 DROP 동안 1). 정상 종료 `stop()`만 close 1000 응답을 기한까지 기다린다.

작업자 제어 인증은 **Ed25519**다. 게시 서버에만 개인 키, 작업자에는 공개 키만 둔다.
capability는 audience·operation·job·lease·body digest·발급/만료 시각에 묶이고 유효기간은 **30초**다.
발급 시각은 한 번만 읽어 만료를 정확히 30초 뒤로 계산한다.
`execute`와 `cancel`을 구분하며 일회 사용 consume 저장소를 주입한다.
토큰의 두 부분은 canonical base64url(디코드 뒤 다시 인코드해 같은 표기)만 받고, nonce는 토큰 문자열이 아니라 서명이 덮는 payload의 SHA-256이다. 그래서 서명 표기를 바꿔 같은 capability를 다시 쓸 수 없다(T16b 선행 수정, PR #5 지적 4316750309).
cancel body는 `{job, lease}`가 필수이며 서명 lease·현재 busy lease와 모두 일치해야 중단한다.
실제 중단 어댑터에도 job/lease를 함께 전달해 이전 시도가 새 시도를 중단하지 못하게 한다. 로컬은 메모리 모의이고,
작업자 재시작 뒤에도 남는 nonce 저장소는 T16b에서 제공해야 한다. 게시 토큰·GitHub 자격은 worker 요청에 없다.
작업자 코드 읽기는 고정 SHA의 codeload 압축본 두 개, baseline git init/commit은 **선언 계약만**이다.
T16a 작업에서는 Git 초기화나 커밋을 실행하지 않았다. 실제 archive 안전 추출·diff·CLI 프로세스는 T18에서 검증한다.

### readiness·중단 경보

readiness는 두 수신기와 DB **쓰기 성공**만 본다. Gateway 연결, 모델 waiting, 큐 지연은 넣지 않는다.
앱 수신 8080과 경보 수신 8081은 별도 HTTP 서버이며 Gateway 단절 시험 중에도 저장에 성공했다.
`homelab_bot_gateway_connected`, `homelab_bot_outbox_oldest_seconds`, `homelab_bot_outbox_unknown`과 §13의 작업·gap·outbox·제어·Gateway 정지 gauge를 노출한다.
service 없는 플랫폼 경보·미등록 service·지원하지 않는 severity는 제외 건수만 감사 후 202로 무시한다.
혼합 그룹은 지원 항목의 fingerprint·건수만으로 계속 처리한다. 잘못된 요청 형식은 400이다.

하트비트 대안은 **채택**한다. 조율 루프가 최근 **60초** 안에 돌고 Gateway가 최근 **5분** 안에 연결됐을 때만
최소 **60초** 간격으로 ping한다. 기동 뒤 한 번도 연결되지 않았으면 ping하지 않는다.
따라서 Gateway 룰 스크레이프가 준비되기 전에도 오래 단절된 봇의 ping이 멈춘다.
T16b 진입점의 "조율 루프가 돎"은 한 바퀴가 DB에 닿은 루프(runtime의 `store.expire`, publisher의 `claimDelivery`)로만 잰다.
복구 루프는 대기 항목이 없으면 DB 없이 끝나므로 세지 않는다. 그래서 DB가 끊기면 60초 뒤 ping이 멈춘다.
실제 healthchecks 체크 생성·유예 시간·Telegram 도착·replicas 0은 T16b에서 확인한다.
기존 Alertmanager→Telegram 경로는 이 코드에 의존하지 않는다.

경보는 groupKey·fingerprint·상태로 중복을 합치고 사건 스레드에 결정적인 요약만 전달한다.
알림에서 모델을 부르지 않는다. 반복 횟수는 DB에 남기고 수신 대기 상한을 넘으면 503으로 backpressure를 건다.


### REVIEW-6: 경합·원자성·외부 호출 경계 점검

`007_execution_boundaries.sql`을 추가했다. 원격 효과와 DB commit은 하나의 transaction이 될 수 없으므로
재시도 가능 여부를 확인된 미전송과 결과 불명으로 나눈다. 다음 경계를 같은 방식으로 점검했다.

- **수신/복구:** 대화 → inbox 순서로 잠근다. `save`는 활성화하지 않고 route의 job/outbox·수락·활성화를
  함께 commit한다. gap 동안 live 입력은 `events.buffered`에 최대 대화별 100건 저장 후 ACK한다.
  중복 buffer 입력은 재ACK하지 않는다. 마지막 history 응답 뒤 buffer를 수락하고, 비었을 때 같은 대화
  잠금 안에서 gap을 해제한다. buffer 수락 순서로 event_order를 재배치해 먼저 복구한 입력도 문맥에 포함한다.
  복구 중단 시 buffer는 남고 다음 recover가 처리한다. token/30초 lease는 중복 복구를 막고 각 route에서
  epoch/token/active를 재확인한다. 10페이지/30초 또는 수락 용량을 넘으면 gap을 유지한다.
- **구독 경계:** stop은 epoch를 올리고 recovery token·buffer를 해제한다. 재활성화/명시적 resume는
  수락 transaction 안에서 활성화 메시지/interaction snowflake를 activation_after와 checkpoint에 저장한다.
  그 경계 이하 message는 live 재전달에도 실행하지 않는다. 직접 내부 control에 cursor가 없으면
  현재 시각의 Discord snowflake 하한을 쓴다. 기존 active 대화의 resume는 경계를 이동하지 않는다.
- **owner:** thread/DM의 message·command·button·저장·route·recover·claim·context·결과·게시·thread 확정에서
  기존 owner를 확인한다. 공유 부모 채널은 구독/모델 문맥 대상이 아니므로 그 예외를 유지한다.
  경보 group key는 owner/guild/notificationChannel을 포함한다. 이전 key와 합치지 않으므로 업그레이드 후
  첫 동일 경보는 새 사건 세대를 만들 수 있다. admission 잠금 뒤 policy와 service를 다시 확인한다.
- **게시:** 채널별 비전역 429 시각은 DB controls에 max로 저장하고 global 시각과 함께 검사한다.
  같은 채널의 다른 route도 대기하는 보수적 선택이며, 다른 채널의 backlog는 진행한다.
  bucket 헤더는 오류/감사에 남긴다. claim·dispatch·ACK·history·대조에서 공유 중지를 적용한다.
  호출 전 DB 오류는 attempt를 돌려놓고 1초~60초 pending backoff한다. REST 직전 lease/state CAS로
  dispatch_started를 기록한다. 표식 전 lease 만료는 pending, 표식 후 만료는 unknown이다.
  marker와 외부 ID로 대조하며, confirm 실패는 외부 ID를 보존한 unknown이다. terminal 상태는 늦은 오류가
  덮어쓰지 못한다. migration 007은 기존 sending/unknown을 보수적으로 표식 있는 상태로 이관한다.
- **실행/제어:** context 조회 뒤 모델 호출 직전 현재 policy·owner·cancel·active·gap·lease를 다시 본다.
  read 호출 직전에도 상태를 확인한다. finish는 대화를 잠그고 stop과 결과/outbox 쓰기를 직렬화한다.
  직접 control 호출도 transaction으로 감싸 emergency-stop의 부분 commit을 막는다. 일반 chat 합치기는
  queued priority 0 urgent를 제외한다. 이미 시작한 원격 호출을 소급 취소하는 보장은 하지 않는다.
- **작업자/운영:** HTTP dispatcher 구성/본문 검증 실패는 미시작 WorkerRejected이고 정리 실패는 확인된
  결과를 덮어쓰지 않는다. capability는 issued에만 1000ms 오차를 허용하고 TTL 30초·만료·digest·lease·nonce를
  유지한다. heartbeat는 in-flight 호출을 한 번으로 제한하며 실패 후 재시도할 수 있다.

`policy.ts`(현재 정책/철회), `read.ts`(조회 전후 인가·상한), `http.ts`(저장 후 응답·크기/시간 제한),
`format.ts`(순수 요약/페이지 분리), `contracts.ts`(스키마/예산), `database.ts`(rollback·deadline),
`worker.ts`(execute/cancel/lease), `discord-protocol.ts`(정규화·원격 결과 판정)의 기존 경계도 점검했다.
스케줄은 저장만 하며 실행 경로는 T20이다. Gateway 세션 루프와 메타데이터 조회의 transport 공통 제한,
실제 다중 연결 PostgreSQL lock 경합과 외부 서비스 429 동작 실측은 T16b에서 연결·검증한다.


### REVIEW-7: 실행 중 오류 분류 보존

`Runtime`은 monitor의 Denied를 `authorizationRevoked`에 보존한다. 중단 요청 뒤 정책이 복구되거나
취소 상태 쓰기가 일시 실패해 outer catch로 넘어가도 일반 실패로 바꾸지 않는다. cancel 호출 실패나
종료 미확인은 권한 철회가 확인됐더라도 unknown이며, 모델 슬롯을 계속 점유한다.

진행 중 monitor Promise는 interval 해제 뒤에도 종결 전에 기다린다. 정상 worker 완료와 늦은 Denied가
교차할 때 성공으로 먼저 확정하지 않기 위해서다. worker 결과는 종류와 무관하게 현재 정책을 다시 본다.
따라서 첫 1초 monitor 전에 failed/limited/auth_expired로 완료해도 현재 owner/scope/거부 목록의 철회가
우선한다. 정책 누락/stale은 실제 철회와 구분하고 이미 확인한 worker 결과를 보존한다.

종료가 확인된 limited/auth_expired는 일반 monitor DB 오류보다 우선해 waiting_user와 scheduler 중지를
기록한다. 결과를 받은 직후부터 한도 사실을 보존해 후속 인가/상태 DB 조회가 실패해도 failed로
바꾸지 않는다. 대기 전이를 저장하지 못하면 기존 슬롯을 유지하고 lease 만료 뒤 unknown으로 남긴다.
명시적 사용자 취소와 실제 권한 철회는 이 대기 결과보다 우선한다. 일반 monitor 오류/timeout은
기존대로 종료 확인 시 실패, 종료 불명 시 unknown이다. worker 실행 전 거부와 유효하지 않은 확인 결과도
기존 확정 실패 분류를 유지한다. 상태 쓰기와 lease fencing은 기존 Store 경로를 사용한다.

같은 계열의 catch를 Runtime, ReadAdapter, SerialWorker/HttpWorker/workerServer, Discord 수신·복구·게시·대조,
PolicyGate, DB rollback, HTTP/health, format에서 점검했다. ReadAdapter는 Denied/PolicyUnavailable을
재전파하고, worker의 불확실한 예외는 종료 증거 없이 failed로 확정하지 않는다. Discord 게시의 원격 성공
뒤 DB 실패는 unknown이고 권한 거부/일시 대기/429는 구분한다. 이 경로들은 추가 코드 수정이 필요 없었다.


### REVIEW-8: 마감 기준점·owner 재개·확정된 원격 응답

상호작용 마감은 `DiscordProtocol.gateway` 진입 시각 + 2500ms다. 메타데이터 조회가 끝난 뒤 새 타이머를
시작하지 않는다. slash/버튼 모두 같은 절대 시각을 사용하고 callback HTTP 예산은
expiresAt-now 전체다(2026-11-02 전에는 min(1000ms, expiresAt-now)). 저장 전 deferred ACK는 하지 않는다. 이미 수락했지만 마감이 지난 요청은
callback을 생략하고 기존 ackUncertain/처리 대화 안내 경로를 쓴다. 네트워크 지연 때문에 실제 최초 응답의
성공을 보장하는 것은 아니며, 토큰을 늦게 사용하지 않는 경계다.

`/model-status`는 scheduler 중지, 비상/이전 중지, 현재 대화의 대기 사유·ID(최대 5건), 실행 중/종료 불명
작업의 존재를 보여 준다. owner가 원인을 해소한 후 `/resume-model target:<job-id>`로 waiting_user를
queued로 돌리거나 `/cancel target:<job-id>`로 포기한다. 현재 대화 owner·active/gap·model_limit/auth_expired·
100건 큐·최대 3회 실행 예산을 검사하고 재개 때 이전 lease와 완료 시각을 지운다. /retry는 failed 전용,
/resume는 구독 전용이다. 스케줄러 행 잠금 안에서 job 전이와 전체 대기 해제를 처리하며 제어 outbox와도
같이 commit한다. 다른 waiting_user 또는 비상 중지가 있으면 전체 대기를 풀지 않는다.

`controls.scheduler_emergency`는 비상 중지를 별도로 보존한다. 기존 scheduler=true에 이 값이 없으면
원인이 불명인 이전 중지로 취급해 true로 초기화한다. `/resume-model target:emergency-stop`은 owner의
명시 확인으로 그 중지만 해제하며 running/verifying/cancel_requested/unknown이 있으면 거부한다(닫힘이 기록된 작업 레인의 unknown은 예외, "T18 게시 서버 스케줄링과 질문" 참고).
waiting_user는 각 대화에서 별도 처리해야 한다. verifying도 cancel/emergency-stop의 중지 요청 대상이다.
자격 파일 읽기/복구, 자동 계정 전환, unknown worker의 종료를 추정하는 기능은 추가하지 않았다.
실제 slash 명령 등록과 종료 확인 연결은 T16b/T18이다. 새 스키마 migration은 필요하지 않다.

게시 POST의 400/403/404는 `DiscordRejected(status)`로 보존하고 즉시 blocked와 감사 기록을 원자적으로
남긴다. 401/429의 기존 분류를 유지하고, 408/409/5xx·전송 단절은 미전송을 단정하지 않는다. 대조 GET의
거부는 이전 POST 성공 여부를 증명하지 않으므로 기존 unknown을 유지한다.

원격 생성 ID가 있는 unknown은 현재 owner/service/대화 인가를 확인한 뒤 같은 ID로 로컬 confirm을 재시도한다.
외부 ID가 없는 경우에만 bounded marker 검색을 한다. 저장된 ID는 늦은 상태 갱신에서 null로 지우지 않는다.
로컬 확정은 REST rate limit 중지 중에도 가능하고 반복 실패 시 1초부터 최대 60초 backoff한다. 확정 ID 없는
unknown만 100건/24시간 폐기 한도를 적용한다. 확정 증거는 이 한도로 폐기하지 않으며 로컬 확정 대조는
호출당 최대 100행이다. 오래 누적된 로컬 확정 대기는 기존 outbox 지표로 관찰하며 운영 보존 정책은 T16b다.

동일 계열로 수신/복구/worker capability·HTTP timeout의 기준점, waiting/비상/unknown/failed 제어,
POST 거부·GET 대조 거부·확정 ID 보존·인가 철회·local confirm 실패를 점검했다. 복구와 capability는
이미 절대 시각/lease 검사를 사용하고 worker cancel은 별도 5초 예산을 갖는다. unknown worker는 종료
증거 없이 해제하지 않는 기존 안전 경계를 유지한다.

## 12. T18 CODEX_BRIDGE 로컬 계약 (2026-10-29)

- 범위: 봇 소유 Codex 작업(R10)의 실행 경로, 질문(clarification)·완료 중계(R09), 취소·`unknown` 막힘(R03), 작업자 Codex 설정(T18 할 일 4). **로컬·mock이다.** 실제 `codex` 실행과 모델 호출은 하지 않았다(D-14 차단 조건, 실행은 T16b).
- 정하지 않은 것: R08 연결 방식(할 일 1), 인증 파일 분리·레인 분리(할 일 5), 작업별 세션 저장 공간. 후보·근거·추천은 [DECISIONS.md](DECISIONS.md) "T18 결정 대기 (사용자)"다.
- JSONL fixture는 공식 문서의 `codex exec --json` 이벤트 형태로 합성했다. 실제 CLI 녹음이 아니다.

### 구성

| 파일 | 역할 |
|---|---|
| `src/codex.ts` | 능력표 `CODEX_CAPABILITIES`, 어댑터 계약(`CodexTaskAdapter`·`CodexLauncher`), 작업자 쪽 `ExecCodexAdapter`, 게시 서버 쪽 `CodexBridge`(실행·질문·답·만료·상태·해제) |
| `src/codex-events.ts` | JSONL 해석, 완료 판정 `interpretRun`, 최종 출력 스키마, `auth.json` 값 반사 검사 |
| `src/codex-config.ts` | 작업 경로, `config.toml` 생성, codex 실행 환경, argv, 개인 Codex 홈 거부 |
| `src/codex-process.ts` | 작업마다 새 프로세스 그룹으로 띄우고 그룹·작업 표식으로 정리·소멸을 확인하는 launcher |
| `src/codex-workspace.ts` | 첫 실행 전 `git init`·기준 커밋(D-15), 실행 전후 작업 공간 파일 해시 대조 |
| `migrations/009_codex_bridge.sql` | `codex_sessions`(외부 스레드 ID·턴·실행 호스트·능력표), `codex_questions` |
| `src/runtime.ts` (T16a, 추가만) | 선택적 `TaskLane { run, sweep? }`. 연결하지 않으면 task도 기존 작업자 경로 그대로다 |

### 어댑터 능력표 (T18 로컬 값)

| 계약 | 값 | 로컬 시험 | 남은 실측·결정 |
|---|---|---|---|
| `capabilities()` | `CODEX_CAPABILITIES` 고정 표, 버전 0.163.0. 작업마다 `codex_sessions`에 기록 | TASK-01 | 설치 CLI `--help` 대조(T16b) |
| `start_task` | true. `codex exec --json --output-schema … -o … -`, 지시는 stdin | TASK-01 | 실제 실행(T16b) |
| `attach_task` | **결정 완료·구현 비활성.** 연결 방식은 읽기 전용 알림으로 정했다(§15). 어댑터 값은 아직 `undecided`이고 부르면 `CapabilityUnavailable(undecided)`다. `false`로 정한 것이 아니다 | TASK-01 | 수신 경로 결정(H3), `/attach`·리스너 조립(B5) |
| `read_status`, `read_events` | true. `status()`는 owner·같은 대화만. 이벤트는 판정에만 쓰고 원문 로그를 Discord로 흘리지 않는다 | TASK-01 | 없음 |
| `read_final_result` | true. 완료 = 종료 코드 0 + 마지막 turn 이벤트가 `turn.completed` + `-o` 파일이 출력 스키마 `completed` + 작업 그룹 소멸 확인 + 작업 공간 실제 diff를 얻음. 게시하는 변경 목록은 실제 diff 기준이고, Codex 보고와 다른 파일은 증거(`unconfirmedReports`)와 안내 문구로 남긴다. 작업 공간 밖을 바꿨다는 보고는 실패다. "완료" 문자열·로그는 근거가 아니다 | TASK-03 | 실제 저장소 압축본 작업 공간(T16b·T19), `file_change` 경로 형식 [미확인] |
| `answer_question` | clarification만. 질문은 모델이 `status=needs_input`으로 턴을 끝낼 때만 생긴다 | TASK-02 | 없음 |
| tool approval 중계 | **false.** 승인 플래그·`--approve-for-me`를 쓰지 않는다. 질문 종류 CHECK가 `clarification` 하나다 | TASK-01·03 | 없음 |
| `request_cancel`, `confirm_stop` | 작업 그룹 SIGTERM → SIGKILL, 프로세스 그룹과 작업 표식(`HOMELAB_WORKER_TASK`, T16b 전 이름 `HOMELAB_CODEX_TASK`)으로 남은 수 확인. 작업 시작 뒤 생긴 같은 UID 프로세스의 환경을 못 읽으면 확인 불가(`unknown`). 0개를 확인했을 때만 `cancelled`. `confirmStop`은 작업의 실행 세대를 올려, 아직 준비 중인 실행이 나중에 프로세스를 띄우지 못하게 한다 | TASK-03, SEC-02 | 환경을 지우고 새 세션으로 빠져나간 dumpable 자식은 못 찾는다(시험으로 기록). cgroup 또는 "파드 안 제어 프로세스 밖 0개" 확인은 T16b |
| `resume_task` | 같은 작업의 같은 스레드만(`exec resume <thread> -`). 세션이 대기 상태(`waiting_answer`·`waiting_model`)로 남은 경우에만 잇는다. 답한 질문이 있으면 그 답으로, 한도·인증 대기에서 `/resume-model`로 돌아왔으면 재개 프롬프트로 저장된 스레드를 잇는다. 예산 소진·사용량 미상으로 띄우지 않고 실패하면 세션을 `failed`로, 열린·답한 질문을 `cancelled`로 정리해 `/retry`가 새 스레드·새 예산으로 시작한다(rev r2 N3). 재개가 실패하면 `failed`이고 새 스레드로 조용히 바꾸지 않는다. 처음부터 다시 하는 것은 owner의 `/retry`와, 스레드가 생기기 전에 멈춘 경우뿐이다 | TASK-02 | `exec resume`의 `--json`·`-o`·`--output-schema` 수용과 `thread.started` 재발행 [미확인], T16b |

### 실행 흐름

1. Discord `task` 명령 → T16a `accept`(type `task`) → `Runtime.tick`이 claim·인가·`dispatchable` 뒤 `TaskLane.run(job)`.
2. 브리지는 다시 인가하고 lease를 확인한다. 답한 질문이 있으면 그 답으로 재개하고, 없으면 `TASK_INSTRUCTIONS` + 요청으로 새 스레드를 시작한다. `codex_sessions`에 외부 스레드 ID·턴·실행 호스트(`worker`)·능력표를 남긴다(`01` §6 소유자 연결).
3. 도구 호출 예산은 작업 단위다. 작업 `budget.toolCalls`(T16a 기본 8)에서 같은 스레드의 앞 턴 사용분을 뺀 값을 실행에 넘기고, 남은 예산이 없으면 띄우지 않고 실패로 끝낸다. 새 스레드(`/retry`)는 다시 센다.
4. 실행 중 `monitorMs`(기본 1초)마다 취소 요청·현재 정책·lease를 본다. 취소·철회·lease 상실·시간 초과는 중단 신호다. 중단 뒤 `stopWaitMs`(기본 15초) 안에 끝나지 않으면 기다리지 않고 `unknown`이다. 기다리며 lease만 늘리면 막힘을 숨기기 때문이다. 실행이 끝나 모니터를 멈춘 뒤, 결과를 확정하기 전에 한 번 더 인가한다. 마지막 검사 뒤의 철회·owner 교체면 완료·질문·한도 대기보다 취소(`authorization_revoked`, 소멸 확인에 따라 `cancelled`·`unknown`)가 앞선다(PR #9 4407854998, `Runtime.tick` 작업자 경로와 같다). 한도 대기로 두면 스케줄러가 멈춘 채 옛 owner도 새 owner도 `/cancel`·`/resume-model`로 풀 수 없기 때문이다.
5. 판정 순서(`interpretRun`): 실행 전 실패 → 소멸 확인 → 실행 중 상한 초과(도구 예산·출력) → 흐름 무결성(깨진 줄, 스레드 여럿·불일치, 스레드 ID 형식) → `turn.failed` 또는 끝나지 못한 턴의 `error`(한도·인증이면 대기, 세션이 생기기 전 오류 포함) → 세션 없음 → 종료 코드 → 마지막 turn 이벤트 → 출력 스키마 → `auth.json` 값 반사 → 실제 diff. 턴이 끝나고 종료 코드 0인 실행의 일시 `error` 이벤트는 결과를 버리지 않는다. 프로세스를 띄우기 전 실패(작업 공간 준비, 경로 거부, 인자 거부, 실행 파일 없음)는 남은 프로세스가 없으므로 `failed`다.

| 판정 | 작업 상태 | Discord |
|---|---|---|
| 완료 | `succeeded`(`store.finish`, 결과·증거 기록) | 완료 요약(1500자 이하) |
| 질문 | `waiting_user`·`clarification`, `codex_questions` open | 질문 ID·기한·답하는 방법 |
| 한도·인증 만료 | `waiting_user`(`model_limit`·`auth_expired`), T16a `waitForUser`로 스케줄러 정지. 재개 턴이었으면 답을 되돌려 `/resume-model` 뒤 같은 답으로 같은 스레드를 잇는다 | 실제로 대기에 들어갔을 때만 안내(다른 계정·인증으로 바꾸지 않음). clarification 재개도 시도 수를 올려 T16a `/resume-model` 한도(시도 3회)에 닿았으면 `/cancel`을 안내 |
| 실패(소멸 확인) | `failed`(`codex_<사유>`) | T16a 실패 안내(`/retry` 가능) |
| 취소·철회(소멸 확인) | `cancelled` | 없음 |
| 소멸 미확인 | `unknown`. 자동 재실행 없음, T16a `claim()`이 새 모델 실행을 막음 | 막힘 안내. settle 밖에서 생긴 unknown(lease 만료·기록 실패)도 `sweep()`이 한 번 넣는다 |

### 실행 중 예산·출력 상한 (rev-t18 r1 S2·S3)

- **도구 호출 예산:** 어댑터가 JSONL 줄이 들어오는 즉시 도구 호출 항목(`command_execution`·`mcp_tool_call`·`web_search`·`file_change`, 항목 id 기준)을 센다. 예산을 넘는 호출의 시작을 보면 그 실행만의 중단 신호로 작업 그룹을 끝내고 `failed`(`codex_tool_budget_exceeded`)다. 남은 프로세스를 확인하지 못하면 `unknown`이다.
- **한계:** CLI에 호출 수 제한 플래그가 없어 [미확인] 초과 호출을 시작 전에 막지는 못한다. 시작 이벤트를 본 순간 끝내므로 그 한 호출의 일부 효과는 남을 수 있다(실패로 끝내고 알린다). 어떤 항목 종류를 도구 호출로 셀지는 [가정]이다(T16b 실측).
- **예산 값:** 8회는 T16a 기본값(§11)이다. 코딩 작업에는 작을 수 있고, 값은 runtime policy와 사용자 판단으로 바꾼다. 이 작업은 값을 바꾸지 않았다.
- **JSONL 출력 상한:** launcher는 stdout 줄을 모아 두지 않고 바로 넘긴다. 한 줄 1MiB, 전체 16MiB를 넘으면 더 읽지 않고 작업 그룹을 끝내고 `failed`(`codex_output_limit_exceeded`)다. 어댑터는 이벤트 2만 개 상한을 두고, 판정에 쓰는 필드(종류·스레드 ID·오류 메시지·항목 id·종류·상태·변경 경로)만 남겨 명령 출력·메시지 본문은 버린다. **남긴 필드는 자르지 않는다**(rev r2 N1·N2). 자른 뒤 판정하면 긴 오류 뒤쪽의 인증·한도 표식, 500번째 뒤의 작업 공간 밖 경로, 4096자 뒤의 상위 이동이 사라진다. 남긴 크기는 위 바이트 상한이 묶는다. 경로 수만 개도 판정은 경로 수에 비례한다(Set). 결과 행에 남기는 경로 목록만 판정 뒤에 1000개로 줄이고 전체 수를 함께 기록한다.
- **파일 읽기 상한:** 실행 뒤 읽는 작업 공간 밖 파일(`-o` 최종 메시지 1MiB, `auth.json` 1MiB, 기준 스냅샷 64MiB)은 크기(fstat)로 먼저 거르고, 실제로 읽은 바이트로 다시 센다. 크기를 본 뒤 파일이 커져도 상한+1바이트에서 멈춘다(rev r3 N7). 작업 공간 스냅샷의 해시도 읽은 바이트로 센다. 최종 메시지가 상한을 넘으면 `failed`(`codex_output_too_large`)다. 상한 값은 [가정]이고 실제 CLI 출력 크기는 T16b에서 잰다. 이 읽기의 경로 경계는 아래 "실행 뒤 파일 읽기 경계"다.
- **늦은 실행 차단(rev r1 R1):** 준비(작업 공간·설정)가 끝난 뒤 spawn 직전에 중단 신호와 실행 세대를 확인한다. 이 확인과 spawn 사이에는 await가 없다. 실제 launcher도 중단된 신호로는 spawn하지 않고, 그룹 기록과 중단 처리를 첫 await 전에 건다. 그래서 시간 초과로 `unknown`이 된 뒤 `release`로 해제한 작업은 준비가 늦게 끝나도 프로세스를 띄우지 않는다. 같은 프로세스 안 어댑터 기준이며, 작업자 HTTP 경계(변경 요청 3번)에서도 같은 세대 확인이 필요하다.

### 실행 뒤 파일 읽기 경계 (rev r3 N6·N7)

제어 프로세스(어댑터)가 실행 뒤 읽는 것은 최종 메시지(`run/last-message.json`), `codex-home/auth.json`, 기준 스냅샷(`run/baseline.json`), 작업 공간 전체 해시다. 실행 중 같은 UID의 비신뢰 코드가 이 경로의 디렉터리를 바깥 디렉터리 심링크로 바꾸면, 경로로 읽는 제어 프로세스가 바깥 파일을 결과·증거로 채택했다(r3 재현: 바깥 `last-message.json` 요약으로 `completed`).

**막은 것(로컬 시험으로 확인):**

- 실행 전에 작업자 루트부터 `tasks` → 작업 → `codex-home`·`run`·`workspace`를 이름 하나씩 `O_DIRECTORY|O_NOFOLLOW`로 열어 고정한다. 설정 쓰기와 실행 뒤 모든 읽기는 고정 핸들 아래 이름 하나(`/proc/self/fd/N/이름`, `O_NOFOLLOW`)로만 한다. 고정한 뒤 경로가 바뀌어도 읽기는 원래 디렉터리에서 일어난다.
- 실행 뒤에는 결과·인증·작업 공간 본문을 읽기 전에 루트부터 사슬을 이름 하나씩 다시 열어 고정한 inode(`dev`·`ino`)와 비교한다. **확인 시점에** 어느 단계든 심링크로 바뀌어 있으면 `O_NOFOLLOW`가 막고, 다른 디렉터리로 바뀌어 있으면 inode가 다르다. 그러면 본문을 한 번도 읽지 않고 `failed`(`codex_workspace_tampered`)로 닫는다(rev r4 N8, 실행 뒤 파일 본문 읽기 0회를 시험으로 확인). 결과 파일 자리에 일반 파일이 아닌 것(심링크·FIFO·하드링크)이 있어도 같다. `run`·`workspace`·둘 다·작업 디렉터리 통째 교체를 시험한다.
- 이 사슬 확인은 경로를 따라가는 `realpath` 비교가 아니다. 그래도 확인과 읽기 사이의 교체를 확인이 막는 것은 아니다. 그 구간은 확인이 아니라 고정 핸들이 지킨다. 확인 뒤 경로를 바꿔도 읽기는 고정한 디렉터리에서 일어난다.
- 작업 공간 스냅샷은 루트가 심링크면 열지 않는다. 아래로는 열린 핸들 기준으로 이름 하나씩 연다. 순회 중 항목이 심링크로 바뀌면 열기가 막혀 스냅샷 전체가 실패하고, diff를 얻지 못해 작업이 실패한다. 심링크 항목은 따라가지 않고 링크 대상 문자열만 기록한다.
- 하드링크(링크 수 2 이상)는 다른 inode, 곧 작업 공간 밖 파일일 수 있어 내용을 읽지 않는다. 스냅샷에는 `special:hardlink`로 남긴다. 그래서 변경으로 잡히는 것은 읽을 수 있는 단일 링크 상태와 하드링크 상태 사이의 전환뿐이다. 링크 수가 계속 2 이상인 파일의 내용·링크 수 변화는 잡히지 않는다. 설정 쓰기는 기존 이름을 지우고 `O_EXCL`로 새 inode를 만들어, 하드링크를 따라 바깥 파일을 덮어쓰지 않는다.
- git 준비(`git init`)도 고정한 작업 공간 핸들(`/proc/<pid>/fd/N`)에서 돈다.
- 남은 프로세스가 있거나 확인할 수 없으면 결과·인증·작업 공간을 하나도 읽지 않고 `unknown`으로 닫는다.
- 경로로 읽는 일반 도구 `nodeFiles.read`는 연 파일의 실제 경로(`/proc/self/fd/N`)가 요청 경로와 같을 때만 읽는다. 상위 디렉터리 심링크를 거친 읽기를 막는다.

**남는 한계(막았다고 쓰지 않는다):**

- **같은 UID는 고정 디렉터리 안의 내용을 바꿀 수 있다.** 샌드박스가 `run/`·`codex-home/` 쓰기를 막지 못하면 비신뢰 코드가 `run/last-message.json`을 직접 써서 결과를 꾸밀 수 있다. 바깥 파일 채택은 막았지만 결과 위조는 막지 못한다. 샌드박스의 실제 쓰기 범위는 T16b 실측이다.
- **codex 자신은 경로로 읽고 쓴다.** `CODEX_HOME`(설정·`auth.json`)·`-o` 출력·작업 디렉터리(cwd)를 codex에 경로로 넘긴다. 실행 중 같은 UID 코드나 다른 살아 있는 프로세스(이전 작업에서 감지 못한 채 빠져나간 자식 등)가 경로를 바꾸면 codex가 바뀐 설정으로 돌 수 있다. 실행 자체는 이미 일어난다.
- **사후 확인은 교체 이력을 증명하지 못한다(rev r4 N9).** 사슬 확인은 확인 시점의 연결만 본다. 그때도 교체가 남아 있으면 실패로 닫는다. 그러나 원래 디렉터리를 옮겼다가 확인 전에 제자리로 되돌리면 inode가 같아 통과한다. 확인 뒤의 교체도 확인으로는 알 수 없다(그 뒤 읽기는 고정 핸들이 지킨다). 그래서 codex가 실행 중 바뀐 설정으로 돌고 원래대로 되돌려 놓은 경우 결과는 `completed`가 될 수 있다(한계 기록 시험). 실행 중 쓰인 설정·경로까지 보장하려면 작업마다 별도 UID나 마운트 namespace가 필요하다(DECISIONS "T18 결정 대기" (2)·(4), T16b).
- **`dev`·`ino` 비교는 마운트를 보지 않는다.** mount ID나 하위 마운트 구성은 비교하지 않는다. bind mount·mount namespace를 바꿀 권한이 있는 공격자를 막는 장치가 아니다(로컬에서 실행하지 않았다, T16b).
- **실행 전 디렉터리 만들기는 경로 기반이다.** 이미 있는 심링크는 `realpath` 확인이 하위를 만들기 전에 거부한다. 다만 확인과 만들기 사이에 동시 교체가 있으면 바깥에 빈 디렉터리 하나가 생길 수 있다. 그 잘못된 경로가 고정 단계까지 남아 있으면 고정이 `O_NOFOLLOW`로 실패해 실행하지 않는다. 고정 전에 원래대로 되돌리면 고정·쓰기·읽기는 원래 디렉터리에서 일어나고, 바깥의 빈 디렉터리만 남는다.
- **하드링크 파일의 내용 변경은 diff에 잡히지 않는다.** 링크 수 변화만 잡힌다. pnpm처럼 하드링크를 쓰는 도구의 산출물이 여기에 해당한다.
- **전제:** Linux `/proc` 마운트가 있어야 한다(작업자 파드 [가정], T16b 확인). 작업자 루트의 부모 디렉터리는 작업 UID가 쓸 수 없어야 한다(배치 설정).
- **이 모든 것은 같은 UID 안의 경로 경계다.** 비신뢰 코드가 `auth.json`을 직접 읽는 것은 이것으로 막지 못한다(SEC-02 blocked, 결정 대기 (2)).

### migration 009 업그레이드 (rev r2 N4)

- 009는 이 브랜치 안에서 두 번 바뀌었다(`ac5581d` → `a008ca8`: `repository` 열·`waiting_model` 상태, `7b23166`: `tool_calls` 열). `CREATE TABLE IF NOT EXISTS`만으로는 이전판으로 만든 로컬 DB에 바뀐 부분이 들어가지 않는다.
- 그래서 009 끝에서 `ADD COLUMN IF NOT EXISTS`와 상태 제약 교체를 멱등하게 한다. 운영 DB에는 아직 적용된 적이 없다(T16b).
- 업그레이드 전 세션의 도구 사용량은 알 수 없어 `tool_calls`를 null로 둔다. 브리지는 null인 세션을 잇지 않고 `failed`(`codex_tool_usage_unknown`)로 정리한다. 0으로 보면 예산을 넘길 수 있어서다. owner는 `/retry`로 새 스레드를 시작한다.

### 질문 계약 (TASK-02, AUTH-02)

- 질문 ID = `job_id:thread_id:턴 순번`. 턴은 이 작업 스레드에서 누적한 `turn.completed` 수다. 스레드 ID 형식은 질문을 받을 때 검사한다.
- 답·만료 정리는 T16a 제어 경로(`controlLocked`)와 같은 순서(대화 행 → 스케줄러 행 → 질문·작업 행)로 잠근다. 만료 알림의 outbox 삽입은 `conversation_id` 외래 키 검사로 대화 행 KEY SHARE를 잡는데, 스케줄러를 먼저 잡으면 같은 대화의 `/cancel`·`/model-status`(대화 행 FOR UPDATE 뒤 스케줄러 대기)와 교착한다(PR #9 4407855013, PostgreSQL 18.6에서 재현: 수정 전 한쪽이 잠금 시간 초과로 롤백). 만료 정리는 대화 행을 id 순으로 잠그고, 잠근 뒤 새로 만료된 다른 대화의 질문은 다음 정리로 미룬다. 그리고 끝나면 T16a `/cancel`과 같은 조건으로 스케줄러 정지를 푼다(질문 대기 중 비상 중지를 이미 풀었던 경우).
- 기한은 기본 1시간, 응답자는 작업 owner 하나다. 1시간인 이유는 아래 "T16a 소유 변경 요청" 1번이다.
- 답을 받을 때마다 현재 정책으로 다시 인가한다. owner 교체·즉시 철회는 `Denied`, 정책이 없거나 오래되면 `PolicyUnavailable`이고 질문·작업 상태는 그대로다.
- 다른 대화(스레드)의 답, 다른 사람의 답은 `Denied`다.
- 같은 Discord 이벤트의 재전달은 한 번만 반영한다. 두 번째 다른 답, 이미 이어 간 질문, 기한 지난 질문, 취소된 작업의 질문은 거부한다.
- 기한이 지나면 작업을 `cancelled`(`question_expired`)로 두고 알린다. 무응답을 승인이나 진행으로 보지 않는다. `Runtime.tick`이 claim 전에 `sweep()`으로 닫는다.
- 답은 argv가 아니라 stdin으로만 넘긴다. 답이 `--`로 시작해도 플래그가 되지 않고, 설정 파일·argv·샌드박스는 답과 무관하게 같다.
- 답을 받은 뒤 재개 전에 권한이 철회되면 `Runtime.tick`의 인가에서 `cancelled`(`authorization_revoked`)로 끝나고 재개하지 않는다.

### 작업자 Codex 설정 (할 일 4)

작업마다 CODEX_HOME의 `config.toml`을 다시 쓴다. `exec resume`에는 `-s`·`-C`가 없어서 [실측: 0.163.0 `exec resume --help`, §4] 시작과 재개가 같은 정책을 갖도록 플래그가 아니라 설정 파일에 고정한다.

```toml
sandbox_mode = "workspace-write"
approval_policy = "never"

[sandbox_workspace_write]
network_access = false

[shell_environment_policy]
inherit = "none"
ignore_default_excludes = false
exclude = ["*KEY*", "*SECRET*", "*TOKEN*", "*PASSWORD*", "*CREDENTIAL*", "*AUTH*", "CODEX_*", "OPENAI_*", "GITHUB_*", "DISCORD_*", "KUBECONFIG", "SSH_AUTH_SOCK"]
set = { PATH = "/usr/local/bin:/usr/bin:/bin", HOME = "<작업 HOME>", LANG = "C.UTF-8", TMPDIR = "<작업 tmp>", HOMELAB_WORKER_TASK = "<job>" }
```

- 기준은 `inherit = "none"`이다. `exclude`는 누가 `inherit`을 바꿔도 이름 필터가 남게 둔 것이다. `set`에 비밀 이름 변수나 CODEX_HOME 경로가 들어가면 코드가 거부한다.
- `approval_policy = "never"`는 승인을 묻지 않는다는 뜻이고 샌드박스 밖 실행을 허용하는 뜻이 아니다 [가정]. exec에서 샌드박스 밖 동작이 필요할 때의 처리는 [DISCOVERY.md](DISCOVERY.md)의 미확인 항목이다(T16b).
- codex 프로세스 자체의 환경은 작업자 환경을 병합하지 않는다. `PATH`·`HOME`(작업 HOME)·`LANG`·`TMPDIR`·`CODEX_HOME`·작업 표식과 선택적 `HTTPS_PROXY`·`NO_PROXY`만 둔다. 작업자 환경의 시드 `auth.json`(`CODEX_AUTH_JSON`)·Discord·GitHub·OpenAI 값은 넘어가지 않는다(실제 프로세스 시험).
- argv: `exec --json --output-schema <run>/output.schema.json -o <run>/last-message.json -`, 재개는 `exec resume … <thread> -`. `--dangerously-bypass-approvals-and-sandbox`·`--approve-for-me`·`--full-auto`·`--ephemeral`·`--ignore-user-config`·`-a`·`-s`·`-c`·`--add-dir`를 쓰지 않는다. 스레드 ID는 영숫자로 시작해야 한다. 지시는 stdin `-`로 준다 [확인: 0.163.0 `codex exec --help` "if `-` is used, instructions are read from stdin", 2026-10-30].
- 출력·스키마 파일(`run/`)은 모델 셸이 쓰는 `TMPDIR`·작업 공간과 떼고, 실행마다 이전 출력을 지운다.
- 작업 공간: 첫 실행 전에 `git init`·기준 커밋을 한다(D-15, `codex exec`의 Git 저장소 요구). git은 이때만 쓰고 `GIT_DIR`를 못 박아 위쪽 저장소를 찾지 않으며 사용자·시스템 git 설정, hooks, fsmonitor를 쓰지 않는다. 이미 `.git`이 있으면 누가 쓴 config인지 몰라 거부한다. 그래서 작업 공간 원본을 푸는 단계(T16b·T19)는 `.git` 없이 풀어야 한다.
- 실행 뒤 변경 대조는 git이 아니라 파일 해시와 git이 보는 소유자 실행 비트(0o100, git의 100755/100644)로 한다. 내용이 같은 `chmod u+x`·`u-x`도 변경이고, 그룹·기타 실행 비트만 바뀐 것은 git처럼 변경이 아니다(rev r2 N5, 시험이 `git diff --summary`와 대조). 실행 중 비신뢰 코드가 `.git/config`에 filter·fsmonitor를 심으면 제어 프로세스의 `git add`가 그 명령을 실행하기 때문이다. 스냅샷은 프로토타입 없는 객체에 파일 이름을 키로 담는다. 일반 객체면 루트의 `__proto__` 파일이 상속 setter에 먹혀 생성·수정·삭제가 증거에서 빠졌다(PR #9 4407855007). 기준 해시는 작업 공간 밖 `run/`에 둔다. 남은 프로세스가 있거나 모르면 작업 공간을 다시 읽지 않는다(결과는 어차피 unknown이고, 살아 있는 프로세스가 읽는 도중 바꿔치기할 수 있다). 읽기의 경로 경계와 남는 한계는 위 "실행 뒤 파일 읽기 경계"다.
- 설정에 프로젝트 신뢰(`[projects]`)를 넣지 않는다. 0.163.0이 작업 공간의 `.codex/config.toml`·rules 레이어를 신뢰한 프로젝트에서만 읽는다는 것은 리뷰가 바이너리 문자열로 본 것이고 [미확인]이다.
- 작업 경로는 `<작업자 루트>/tasks/<job>/{codex-home,home,workspace,run,tmp}`다. 경로 자리일 뿐이고 인증 파일 배치(공유 원본인지 작업별 사본인지)는 결정 대기다. 그래서 지금 모양 그대로 실제 CLI를 돌리면 작업 CODEX_HOME에 `auth.json`이 없어 인증에 실패한다(결정 뒤 T16b).
- 만드는 디렉터리마다 실제 경로가 그대로인지 확인한다. 루트 아래 심링크(예: `tasks` → 개인 Codex 홈)로 밖에 쓰지 않는다.
- `auth.json` 값 반사 검사는 작업 CODEX_HOME의 `auth.json`을 실행 전후로 읽는다. 영숫자만 남겨 16자 창으로 비교하고 JWT는 헤더와 payload 앞부분을 뺀다. **best-effort다**(base64 같은 변형은 못 잡음). SEC-02 pass 근거로 쓰지 않는다.

### 개인 Codex 홈 금지 (D-14, spec §4.5)

- 작업자 루트는 절대 경로여야 한다. realpath가 사람 홈의 `.codex*` 아래이거나, 사람 홈 자체나 그 조상이면 거부한다. 심링크(`~/.codex2` → `~/.codex-sub`)도 realpath로 막는다.
- 홈 디렉터리를 열거하지 않고 경로 모양으로만 판단한다. 작업자 UID가 사람과 다르면 배치 설정이 사람 홈을 `homes`로 더 넘긴다. 공개 저장소라 코드에 실제 경로를 적지 않는다.
- 시험은 실행 한 번 동안 어댑터가 건드린 모든 경로가 작업자 루트 아래인지, launcher에 넘긴 argv·env·cwd에 `.codex`가 없는지 본다.

### 작업 정리와 `unknown` 막힘 (§4 "작업 정리")

- 종료 사유(정상·실패·시간 초과·취소)와 무관하게 실행 뒤 작업 그룹을 끝내고 남은 수를 확인한다. 남으면 완료 출력이 있어도 `unknown`이다.
- 확인 수단은 프로세스 그룹(pgid)과 작업 표식 환경 변수다. 표식은 codex 프로세스 환경과 `shell_environment_policy.set` 양쪽에 넣어, 새 세션으로 빠져나간 자식도 환경을 지우지 않았다면 찾는다.
- **한계(시험으로 기록):** 환경을 지우고 새 세션으로 빠져나간 자식은 찾지 못한다. 그래서 `confirm_stop` 값은 `process_group_and_marker`다. 이 한계는 옛 Codex 경로의 것이다. Claude 작업 레인은 이 방식을 쓰지 않고 아래 "T18 작업 레인 실행·정리"의 파드 PID 공간 정리를 쓴다.
- 기록한 프로세스 그룹은 리더 pid가 다른 시작 시각으로 살아 있으면 재사용된 번호로 보고 쓰지 않는다.
- 확인 불가는 0개로 세지 않는다: 작업 시작 뒤 생긴 같은 UID 프로세스의 environ을 못 읽으면(non-dumpable 등) `unknown`이다. 작업 전부터 있던 프로세스는 셈에서 뺀다. 작업 기록이 없으면(재시작 뒤) 못 읽는 같은 UID 프로세스를 모두 의심한다. 작업자 파드에는 다른 프로세스가 없어 영향이 없지만, 개발 기계에서 `release`가 거부될 수 있다.
- 막힘 기록: `jobs.state='unknown'`이 DB에 남고(재시작 뒤 유지) T16a `claim()`이 새 모델 실행을 막는다. Discord 알림을 보낸다. settle 밖에서 생긴 unknown(lease 만료, 기록 실패)도 `Runtime.tick`의 `sweep()`이 알림을 한 번 넣는다. 비AI 경로(Telegram) 알림은 아래 T16a 변경 요청 5번이다.
- 해제: owner의 `release`는 작업자 프로세스 0개를 다시 확인한 뒤에만 `cancelled`(`stop_confirmed_after_unknown`)로 바꾸고 작업은 다시 실행하지 않는다. 남아 있으면 거부하고 파드 재생성을 안내한다. owner가 바뀌어 남은 막힘은 옛 owner가 풀 수 없으므로 그 작업에 한해 현재 정책 owner가 같은 확인 뒤 푼다(상태 조회 권한은 생기지 않는다).

- 대화 레인(chat)의 unknown은 §13 "불확실한 결과와 chat unknown"이 다룬다(종료 직전 취소 확인, 주기 조사). 위 `release`는 작업 레인(T18) 경로다.

### 재시드 절차 초안 (할 일 3, 사람 작업)

전제: 첫 시드는 T16b 전에 사람이 했다. 작업자는 영속 공간에 `auth.json`이 없을 때만 시드를 복사한다(D-14 조건 4, 설계 C.8 변경).

1. 언제: 작업이 `waiting_user`(`auth_expired`)로 멈추고 갱신으로 풀리지 않을 때, 영속 공간의 `auth.json`을 잃거나 손상됐을 때, 계정 쪽에서 세션을 끊었을 때. 봇은 다른 계정·인증으로 바꾸지 않고 기다린다(D-14 조건 2).
2. 멈춤: `/emergency-stop`으로 새 모델 실행을 막고 `/model-status`로 실행 중·`unknown` 작업이 없음을 확인한다.
3. 로그인: 신뢰하는 기계에서 빈 임시 디렉터리를 CODEX_HOME으로 잡고 봇 전용 계정으로 로그인한다(예: `CODEX_HOME=$(mktemp -d) codex login --device-auth`). 개인 `~/.codex*`를 쓰거나 복사하지 않는다.
4. 등록: 새 `auth.json`을 Infisical `/apps/homelab-bot/worker`의 `CODEX_AUTH_JSON` 새 버전으로 올리고 임시 디렉터리를 지운다.
5. 교체: 작업자 영속 공간의 옛 `auth.json`을 사람이 지운 뒤 작업자 파드를 다시 만든다. 파일이 없으므로 시드가 복사된다. 옛 파일이 남아 있으면 시드는 쓰이지 않는다. 반대로 정상인 갱신본을 시드로 덮으면 회전된 갱신 토큰과 어긋난다 [확인: https://learn.chatgpt.com/docs/auth/ci-cd-auth].
6. 확인: 작업자 readiness와 모델을 부르지 않는 로그인 상태 확인 [가정: `codex login status`, T16b 실측]. 그 뒤 `/resume-model target:<job>`과 `/resume-model target:emergency-stop`.
7. 기록: homelab `approvals.md`에 시각·사유·한 사람을 적는다(AC-X2).

열린 점: 영속 공간의 파일을 지우는 수단(사람의 `kubectl exec` 권한 또는 유지보수 Job)은 T16b가 정한다. 작업별 `auth.json` 사본을 쓰기로 정하면(결정 대기) 5단계에서 지울 대상이 공유 원본 하나인지 다시 본다.

### T16a 소유 변경 요청 (바꾸지 않았다)

1. **질문 대기가 전체 모델 슬롯을 잡는다.** T16a `Store.claim()`은 `waiting_user`를 모두 슬롯 점유로 본다(한도·인증 대기용). clarification 대기에는 실행 중인 모델 호출이 없는데도 대화와 다른 작업이 질문 기한까지 멈춘다. 제안: 점유 조건에서 `wait_reason='clarification'`을 뺀다. 바뀌면 질문 기한을 늘릴 수 있다.
2. **Discord 명령 연결(배치 전 필수).** 질문 답(`/answer question:<id>`)·막힘 해제(`/codex-release target:<job>`)·상태(`/codex-status`)는 `CodexBridge.answer`·`release`·`status`로 구현했지만 `DiscordIngress` 명령 목록과 slash 등록에는 넣지 않았다(T16a 소유 `discord.ts`, 영속 수신 흐름 변경). 지금 ingress는 목록 밖 명령을 Denied로 버리므로, 연결 없이 배치하면 안내대로 답해도 거부되고 질문 기한까지 대화 레인이 막힌다. 연결 때 ingress 트랜잭션 안에서 브리지를 부르도록 브리지에 트랜잭션 store를 받는 자리를 더해야 한다(지금 `answer`는 자기 트랜잭션을 연다). TASK-02 시험은 브리지를 직접 불러 ingress의 중복 제거·순서·구독 검사를 거치지 않는다.
3. **작업자 HTTP 계약.** 지금 어댑터는 같은 프로세스에서 부른다. 배치에서는 게시 서버 → 작업자 HTTP(T16a `WorkerRequest`, Ed25519 capability)로 task 요청(지시·재개 스레드·답)을 보내야 하는데 현재 스키마에 그 필드가 없다. 스키마 확장이나 task 전용 끝점이 필요하다(T16b 전).
4. **배치 진입점.** `Runtime`에 `CodexBridge`를 `TaskLane`으로 넘기는 본 루프는 T16b다.
5. **unknown의 비AI 알림.** `health.ts`에 task `unknown` 수 지표를 내서 Alertmanager → Telegram이 잡게 한다(OPS-02, T16b 스크레이프 규칙과 함께).
6. **`Store.accept()`의 잠금 순서.** PR #9 4407855013과 같은 역전이 T16a `accept()`에도 있다. 스케줄러 행을 먼저 잡은 뒤 `INSERT INTO jobs`의 `conversation_id` 외래 키 검사로 대화 행 KEY SHARE를 기다린다. 같은 대화의 `/cancel`·`/model-status`·`/resume-model`·`/emergency-stop`(대화 행 FOR UPDATE → 스케줄러)과 겹치면 교착한다. PostgreSQL 18.6 로컬 재현에서 `/model-status`가 대화 행을 잡은 사이 `accept()`가 `55P03`(잠금 시간 초과)으로 롤백됐다. 제안: `accept()`가 스케줄러보다 먼저 그 event의 대화 행을 잠근다. T18은 바꾸지 않았다. **해소(T16b, 2026-10-30):** `accept()`가 그 event의 대화 행을 `FOR UPDATE`로 먼저 잠근 뒤 스케줄러를 잡는다. 회귀 시험은 `test/review-9.test.ts`(잠금 문장 순서 기록, PGlite)와 `test/review-9-pg.test.ts`(PostgreSQL 18.6 다중 연결: 수정 전 `accept()`가 `55P03`으로 롤백, 수정 뒤 두 트랜잭션 모두 완료)다.

### [가정]·[미확인] (T16b 실측 목록에 더함)

- 재개 때 `thread.started`를 다시 내는지(내지 않아도 받게 했다). PROMPT `-`의 stdin 읽기와 `exec resume`의 `--json`·`-o`·`--output-schema`는 0.163.0 `--help`로 확인했다(T16b, 2026-10-30).
- 한도·인증 만료의 `turn.failed`·`error` 모양과, 세션(`thread.started`) 전에 오류가 나는 순서. 지금은 메시지에 `usage_limit`·`rate limit`·`429` 등이 있으면 한도, `401`·`unauthorized`·`refresh token` 등이 있으면 인증 만료로 보고 대기로 보낸다 [가정: 리뷰가 0.163.0 바이너리 문자열 `usage_limit_reached`를 확인]. 잘못 고르면 다른 계정으로 넘어가지 않고 사람 확인을 기다리는 쪽으로 틀린다. 그 밖은 `failed`(`codex_turn_failed`).
- `--output-schema`가 받는 JSON Schema 키워드 범위. 길이 제한은 봇이 검사한다.
- exec에서 `approval_policy = "never"`의 실제 동작, Codex Linux 샌드박스가 모델 셸의 CODEX_HOME 읽기를 막는지.
- SIGTERM 때 codex의 종료 코드·마지막 이벤트·세션 파일 정합성.

### T16b 작업자 진입점 (2026-10-30)

> 같은 날 실행기 프로필 구조로 바뀌었다(아래 "T16b 실행기 프로필", D-14 변경). 파일 `codex-chat.ts`·`codex-process.ts`와 env `CODEX_HOME`(필수)·`WORKER_SEED_DIR`·`WORKER_SEED_KEY`·`WORKER_CODEX_BIN`, 사유 코드 `codex_version_*`는 그 절의 것으로 대체됐다. 이 절의 nonce 저장소·종료·취소 서술은 공통 실행 제어에, 시드 복사·Codex 대화 레인 서술은 Codex 프로필에 그대로 적용된다.

- 결정: D2(이미지 하나 공유, sandbox digest는 사람 PR), D3(공개 키는 env, nonce는 영속 PVC 안 별도 디렉터리), D4(대화 레인은 공유 CODEX_HOME + 세션 기록 없음). 모두 사용자 2026-10-30, 기록은 [DECISIONS.md](DECISIONS.md) "T16b 결정".
- 플래그 확인 [실측: 설치한 codex-cli 0.163.0 `codex exec --help`, 모델 호출 없음]: `--ephemeral`("Run without persisting session files to disk"), `--skip-git-repo-check`, `--output-schema <FILE>`, `-o/--output-last-message`, `--json`, PROMPT `-`는 stdin. `exec resume`도 `--json`·`-o`·`--output-schema`·`--ephemeral`을 받는다. `codex login status`가 있다(재시드 절차 6단계).

| 파일 | 역할 |
|---|---|
| `src/worker-main.ts` | 진입점. env 읽기(`workerConfig`), `codex --version` 확인(`codexVersion`), 기동(`startWorker`), SIGTERM 정리(`main`) |
| `src/worker-state.ts` | 시드 복사(`seedAuth`), 영속 nonce 저장소(`FileNonceStore`), 값 없는 기동 실패 사유(`WorkerStartError`) |
| `src/codex-chat.ts` | 대화 레인 실행기(`ChatLane`), argv(`chatArgs`), 결과 판정(`interpretChat`). config·env는 T18 `codex-config`를 그대로 쓴다 |
| `src/worker-http.ts` | `workerServer(worker, ready)`에 `GET /readyz`(인증 없음, 본문 없음) |
| `Dockerfile`, `.github/workflows/build.yaml` | 이미지(test 단계 포함)와 app-build 호출. 템플릿 그대로 |

**기동 순서.** env 확인 → CODEX_HOME·시드 디렉터리·nonce 디렉터리가 사람 홈 자체나 그 아래 `.codex*`(심링크로 가리키는 경우 포함)가 아닌지(경로 모양, D-14 조건 1. 개인 `auth.json`을 시드로 복사하지 않는다) → `codex --version`이 `CODEX_CAPABILITIES.version`(0.163.0)과 같은지 → 시드 복사 → nonce 디렉터리 쓰기 확인 → 8080 수신. 어느 단계든 실패하면 `{"event":"worker_start_failed","reason":"<코드>"}` 한 줄과 종료 코드 1로 끝난다. 사유는 코드와 env 키 이름만이고 값(시드, 키, 오류 메시지 속 입력 조각)은 싣지 않는다. 버전 확인은 빈 임시 HOME·CODEX_HOME으로 돌려 영속 공간을 건드리지 않는다.

| env | 필수 | 내용 |
|---|---|---|
| `CODEX_HOME` | 예 | 작업자 영속 공간(PVC)의 Codex 홈. `auth.json` 갱신본이 여기에 남는다 |
| `WORKER_SEED_DIR`, `WORKER_SEED_KEY` | 예 | 시드 Secret 볼륨 디렉터리와 키 이름. 시드 파일은 `<DIR>/<KEY>` |
| `WORKER_NONCE_DIR` | 예 | 영속 공간 안 nonce 디렉터리. `CODEX_HOME`과 같으면 거부 |
| `WORKER_CONTROL_PUBLIC_KEY` | 예 | Ed25519 공개 키 PEM(SPKI). 한 줄의 `\n` 표기도 받는다. 개인 키 PEM은 거부(Node는 개인 키에서 공개 키를 뽑아 주므로 따로 막는다) |
| `WORKER_CODEX_BIN` | 아니오 | 기본 `/usr/local/bin/codex`(이미지의 실제 실행 파일 심링크) |
| `HTTPS_PROXY`, `NO_PROXY` | 아니오 | 있으면 codex 프로세스 env에만 넘긴다. 모델 셸(`shell_environment_policy.set`)에는 넘기지 않는다 |

**시드 복사.** `CODEX_HOME/auth.json`이 없을 때만 한다. 시드는 Secret 볼륨 심링크(`..data/키`)를 따라 열고 일반 파일·1MiB 이하·JSON 객체·`tokens.refresh_token` 문자열이 있는지만 본다 [가정: 필드 이름은 0.163.0 바이너리 문자열과 `codex login` 결과 모양]. 시드 파일의 최종 대상(링크를 모두 따라간 실제 경로)이 사람 홈의 `.codex*` 아래면 읽지 않고 기동 실패(`seed_personal_path`)다. 디렉터리만 보면 파일 자체의 심링크로 개인 `auth.json`을 복사할 수 있었다(리뷰 wrk-r1 P1). 검사한 경로와 실제로 연 파일이 같은지도 `/proc/self/fd`로 확인한다. 같은 디렉터리의 임시 파일(0600, `O_EXCL|O_NOFOLLOW`)에 쓰고 fsync한 뒤 `link`로 설치하고 임시 이름을 지운다. `link`는 이름이 이미 있으면 실패하므로 "없을 때만"이 설치 순간에 지켜진다. 확인 뒤 다른 쓰기 주체(먼저 뜬 작업자나 그 codex의 갱신)가 만든 `auth.json`은 보존하고 `kept`다. 처음 rename으로 설치했을 때는 덮어써서 갱신본·동시 기동의 설치를 잃었다(리뷰 wrk-r1 P1). 이미 있는 `auth.json`은 내용·권한을 손대지 않는다. 심링크·디렉터리면 따라가거나 고치지 않고 기동 실패(`auth_not_regular`)다. 시드가 없거나 깨졌으면 `seed_missing`·`seed_invalid`·`seed_unreadable`로 기동 실패하고 `auth.json`을 만들지 않는다.

**nonce 저장소.** `WorkerVerifier`가 넘기는 nonce(서명 payload의 SHA-256 hex 64자)를 파일 이름으로 `O_EXCL` 생성한다. 이미 있으면 재사용으로 거부하고, 그 밖의 생성 오류도 거부한다(fail-closed). 기록 시각은 mtime이고 보관은 62초(capability 수명 30초 + 시계 오차 1초의 두 배)다. 그 뒤 기록은 다음 사용 때 지운다. 한 프로세스 안의 사용은 차례로 처리한다. 파일을 만든 뒤의 시각 기록·닫기에서 I/O 오류가 나면 이번 사용도 거부한다(fail-closed, 리뷰 wrk-r1 P2). 남은 표식은 지우지 않는다. 보장 범위는 프로세스·파드 재시작까지다(페이지 캐시에 남은 기록으로 같은 capability를 거부한다). fsync는 하지 않는다: 페이지 캐시를 잃는 사고(노드 정전)는 복구에 capability 수명(31초)보다 오래 걸려, 그때는 기록이 없어도 검증기가 만료로 거부한다.

**대화 레인.**

- argv: `exec --json --ephemeral --skip-git-repo-check --output-schema <run>/answer.schema.json -o <run>/last-message.json -`. 지시는 stdin(시스템 지시 + 대화 기록 JSON, §13 "봇 답 문맥").
- `config.toml`은 공유 CODEX_HOME에 실행마다 원자적으로 다시 쓴다. 값은 작업 레인과 같고 `sandbox_mode`만 `read-only`다(`codexConfig(paths, 'read-only')`). `shell_environment_policy.inherit = "none"`.
- codex 프로세스 env는 허용 목록(`launchEnvironment`): `PATH`·`HOME`(실행별 임시)·`LANG`·`TMPDIR`(실행별 임시)·`CODEX_HOME`·작업 표식과 선택적 `HTTPS_PROXY`·`NO_PROXY`. 작업자 env(시드, 공개 키 등)는 넘어가지 않는다.
- 작업 공간은 실행마다 `/tmp` 아래 새 빈 디렉터리다. git이 필요 없어 이미지에 git을 넣지 않았다. 실행이 끝나고 남은 프로세스 0개를 확인하면 지운다.
- 세션 기록: `--ephemeral`에 더해, 남은 프로세스 0개를 확인한 뒤 CODEX_HOME의 `sessions/`·`archived_sessions/`를 지운다 [가정: Codex 기본 세션 위치]. 플래그가 실제로 지키는지는 모델 호출 전이라 [미확인]이고, 이 정리는 플래그가 지키면 아무 일도 하지 않는다. 이 CODEX_HOME의 세션은 대화 레인 것뿐이다(작업 레인 미연결). 작업 레인을 같은 CODEX_HOME에 연결하는 결정(T18)이 나면 다시 본다.
- 기한: 작업자는 `timeoutMs - 5초`(최소 절반)에 스스로 멈춘다. 게시 서버는 같은 `timeoutMs`에서 포기하고 `unknown`으로 두므로, 그보다 먼저 정리(SIGTERM 2초 + SIGKILL 2초)까지 끝내야 `failed`로 확정된다.
- 판정(`interpretChat`): 작업 레인과 같은 순서다. 남은 프로세스가 있거나 모르면 `unknown`(작업자는 이후 실행을 `worker_busy`로 거부), 한도·인증 만료 문구는 `limited`·`auth_expired`(다른 인증으로 바꾸지 않음), 구조화 출력이 `facts`·`hypotheses`·`unknowns`·`checks` 문자열 배열이 아니면 `failed`. 개수·길이 상한(8·4·8·4개, 500자)을 넘긴 답은 잘라 받는다. `auth.json` 값 반사는 `failed`(best-effort).
- 도구 호출 예산(`toolCalls`)과 출력 상한은 작업 레인과 같이 줄이 들어오는 즉시 집행한다.
- 작업 레인 요청(`lane: 'task'`)은 띄우지 않고 `failed`로 답한다. 배치는 T18 결정 대기다.
- 취소(`/v1/cancel`): 실행 중이면 멈추고 정리를 최대 4초 기다린 뒤 남은 프로세스 0개일 때만 `stopped: true`. `unknown`으로 막힌 작업은 다시 정리해 0개면 풀린다.

**종료.** SIGTERM·SIGINT를 직접 받는다(`node`가 PID 1이라 기본 동작이 없다). 먼저 새 실행을 닫는다(동기). 그 뒤 들어온 `/v1/execute`는 실행 전에 403 `{"status":"rejected","started":false}`로 거부하고, 이미 받아 본문 수신·서명 확인 중이던 요청도 codex를 띄우지 않고 `failed`로 끝낸다(리뷰 wrk-r1 P2: 종료 시작 뒤에 검증을 마친 요청이 새 codex를 띄웠다). `/v1/cancel`은 계속 받는다. 새 연결을 받지 않고, 실행 중인 codex를 멈춘 뒤 그 요청에 `failed`(`stopped: true`)를 답하고 닫는다. 종료 중의 응답은 `Connection: close`라 연결 정리를 기다리지 않는다. 연결을 먼저 끊으면 게시 서버가 결과를 몰라 `unknown`으로 둔다. 20초 안에 못 끝내면 강제 종료한다(kubelet 유예 30초).

**readiness.** `GET /readyz`는 기동 확인을 마친 뒤 영속 공간에 일반 파일 `auth.json`이 있으면 200, 없으면 503이다. 실행 중(바쁨)이어도 200이다. kubelet 프로브는 노드에서 오고 인증이 없으며 본문을 싣지 않는다.

**남는 것 [미확인]·[가정] (S11·S12 실측).**

- 대화 레인은 `read-only` 샌드박스를 쓴다. Codex Linux 샌드박스는 번들 bwrap(`codex-resources/bwrap`)을 쓰고 [실측: 0.163.0 패키지 구성], 파드의 `seccompProfile: RuntimeDefault`·비특권 user namespace에서 도는지는 [미확인]이다. S11의 `codex sandbox -- true`가 실패하면 D5다.
- 같은 UID의 모델 셸은 `read-only`에서도 공유 CODEX_HOME의 `auth.json`을 읽을 수 있다. D4가 받아들인 위험이다(T16b에는 비신뢰 코드 실행이 없고 대화 입력은 owner 한 명). 작업 레인을 열기 전에 T18 결정 (2)·(4)가 필요하다.
- codex는 CODEX_HOME 아래에 보조 실행 파일(PATH alias)을 만든다 [실측: 임시 디렉터리 CODEX_HOME에서 `--version`이 "Refusing to create helper binaries under temporary dir" 경고]. 영속 공간 크기(1Gi)에 들어가는지와 `--ephemeral` 실행 뒤 CODEX_HOME에 남는 파일 이름은 S12 첫 대화 뒤 이름만 확인한다.
- 이미지는 `node`가 PID 1이다. SIGTERM은 직접 받아 정리한다. 고아 손자 프로세스(zombie)는 거두지 않는다(tini 없음, 빌드에서 apt를 쓰지 않음). 정상 종료한 codex는 자기 자식을 거두므로 쌓이는 경우는 강제 종료 때뿐이다 [가정].
- 이미 끝나 잡고 있지 않은 대화 작업의 취소는 표식 프로세스를 정리하고 남은 프로세스 0개를 확인해야 `stopped: true`다(#42 `ExecutionSlot.cancel`, §13 "불확실한 결과와 chat unknown"). 확인하지 못하면 `stopped: false`다. 게시 서버의 시간 초과와 작업자 완료가 겹치면 `unknown`이 될 수 있어 위 기한 여유를 뒀다.

### T16b 실행기 프로필 (2026-10-30, D-14 변경)

- 결정: D-14 변경(사용자 2026-10-30, [DECISIONS.md](DECISIONS.md) D-14 "변경"). Claude Code CLI, 구독 장기 토큰, 첫 모델 Opus 5.5, 실행기를 설정으로 바꾸는 구조. 설계는 T16b 조사(실행기 어댑터·Claude 인증·Claude 전환 영향, 비공개 작업 문서)의 추천안 "공통 실행 제어 + 작은 실행기 어댑터 + 프로필 선택 + 이미지 하나"를 따랐다.
- 범위: 처음에는 대화 레인만이었다. 리뷰(T17)는 2026-11-04에 `claude-subscription`에 연결했다(`lanes.review=true`, #40·#42·#44, 아래). `codex-subscription`의 리뷰는 닫혀 있다(`lanes.review=false`). 작업 레인(T18)은 이 프로필 작업자가 아니라 `WORKER_LANES=task` 전용 작업자가 맡는다(이 표의 `lanes.task=false`, 프로필의 `taskCapabilities`). 게시 서버와의 HTTP v1(요청·응답·서명·nonce)은 바꾸지 않았다. 실행기 이름·플래그·자격은 그 계약에 들어가지 않는다.
- 리뷰 레인 연결(T17, 2026-11-04): 작업자 서버 하나(8080)가 `/v1/execute`·`/v1/cancel`·`/v1/review`·`/v1/review/cancel`을 받고 서명 확인과 영속 nonce를 함께 쓴다. 리뷰 경로는 리뷰 레인이 열렸을 때만 있다. 인증 없는 요청에는 401이고(게시 서버의 준비 확인 신호), 닫히면 404다. 대화와 리뷰는 실행 제어 `RunControl` 하나와 실행 자리 `ExecutionSlot` 하나를 함께 쓴다. 그래서 실행 잠금·`unknown` 잠금·잔여물 차단·readiness·종료 drain이 두 레인에 함께 걸린다. 기동 때 `sweep()`으로 이전 프로세스가 남긴 실행 공간을 지운다. 리뷰 실행은 도구 0개, MCP·hooks·skills 없음, 실행마다 빈 임시 공간, 세션 안 남김이다(`src/review-lane.ts`). 실제 모델 호출은 아직 없다([VERIFICATION](VERIFICATION.md) "T17 실가동 구현").
- 모델 호출·로그인 없음. Claude CLI는 고정 바이너리의 `--version`·`--help`만 실행했다. 시험의 CLI 자리는 같은 인자·stdin·env로 도는 가짜 실행 파일이다.

```text
게시 서버 ── 서명된 HTTP v1(변경 없음) ──▶ 작업자
  SerialWorker(대화)·ReviewWorker(리뷰): 서명·nonce, 실행 자리 ExecutionSlot(worker.ts) 하나로 직렬 1
  RunControl(run-control.ts, #40에서 ChatLane에서 분리): 공통 실행 제어
    ├ 실행마다 빈 /tmp/homelab-{chat,review}-*/{home,config,workspace,run,tmp}, 끝나고 소멸 확인 뒤 통째 삭제
    ├ 자식 env = 공통 기본(PATH·HOME·LANG·TMPDIR·작업 표식·프록시) + 어댑터가 선언한 이름만
    ├ 실행 전: 자격 유출 검사 / 실행 중: 도구 예산·정책 위반 즉시 중단 / 기한·취소·종료
    ├ ProcessGroupLauncher(process-launcher.ts): 그룹 정리·소멸 확인
    └ 판정: 소멸 확인 → 상한·위반·중단 → 어댑터 결과(대기·실패·답) → 공통 스키마 → 반사 검사
  ChatAdapter: argv·env 이름·설정 파일·출력 해석·CLI 오류 분류만
    ├ ClaudeChatAdapter(executor-claude.ts)
    └ CodexChatAdapter(executor-codex.ts, 기존 D4 경로)
  WorkerCredential: StaticEnvCredential(env-static) / FileMutableCredential(file-mutable)
```

| 파일 | 역할 |
|---|---|
| `src/executor.ts` | 내부 계약: `ChatAdapter`·`AdapterRun`·`ExecutorCapabilities`·`EngineOutcome` |
| `src/executor-profiles.ts` | 프로필 표 `PROFILES`, 선택 `selectProfile`, 조립 `createExecutor`, `--version` 확인 `executorVersion` |
| `src/run-control.ts` | 공통 실행 제어 `RunControl`, 실행 전 검사 `assertLaunchSafe`(#40에서 `chat-lane.ts`에서 옮김) |
| `src/chat-lane.ts` | 대화 레인 `ChatLane`, 판정 `interpretChat`, 출력 스키마 `CHAT_OUTPUT_JSON_SCHEMA` |
| `src/review-lane.ts` | 리뷰 레인 `createReviewerModel`, egress 조건 `assertEgressBound`(#40) |
| `src/archive-fetcher.ts` | 작업자 압축본 다운로더 `createArchiveFetcher`(#43, 진입점 연결 #44) |
| `src/executor-claude.ts` | Claude 어댑터: `claudeArgs`, `CLAUDE_FIXED_ENV`, `initViolation`, `classifyClaudeError`, `interpretClaudeStream` |
| `src/executor-codex.ts` | Codex 어댑터(옛 `codex-chat.ts`의 실행기 부분): `chatArgs`, `interpretCodexChat` |
| `src/credentials.ts` | 자격 방식 `StaticEnvCredential`·`FileMutableCredential` |
| `src/process-launcher.ts` | 공통 프로세스 그룹 실행(옛 `codex-process.ts`). 작업 표식 env 이름 `HOMELAB_WORKER_TASK` |
| `src/personal-homes.ts` | 개인 CLI 홈 이름(`.codex*`·`.claude*`). `assertWorkerRoot`·`assertNotPersonal`이 함께 쓴다 |

**프로필.** 작업자 env 세 개가 고른다. 표에 없는 조합은 기동 실패이고 다른 프로필로 몰래 돌아가지 않는다.

| 프로필 | `WORKER_EXECUTOR` | `WORKER_CREDENTIAL_KEY` | 자격 방식 | `WORKER_MODEL` | 실행 파일(이미지) | 추가 env |
|---|---|---|---|---|---|---|
| `claude-subscription` | `claude` | `CLAUDE_CODE_OAUTH_TOKEN` | env-static | `claude-`로 시작하는 전체 ID만(첫 값 `claude-opus-5-5`). 별칭(`opus`)·접미어(`[1m]`)는 거부 | `/usr/local/bin/claude` 2.1.308 | 없음 |
| `codex-subscription` | `codex` | `CODEX_AUTH_JSON` | file-mutable | `cli-default`만(`-m`을 넘기지 않음, CLI 기본 모델) | `/usr/local/bin/codex` 0.163.0 | `CODEX_HOME` |

거부 사유 코드: 모르는 실행기 `config_invalid:WORKER_EXECUTOR`, 키 이름 모양 `config_invalid:WORKER_CREDENTIAL_KEY`, 표에 없는 실행기·자격 조합(예: `claude` + `ANTHROPIC_API_KEY`) `profile_unsupported`, 모델 모양 `config_invalid:WORKER_MODEL`, 프로필 추가 env 없음 `config_missing:<이름>`. 같은 프로필 안 모델 바꾸기(예: `claude-sonnet-5-5`)는 설정만 바꾸면 된다.

**능력표(프로필에서 냄, `ExecutorCapabilities`).**

| | `claude-subscription` | `codex-subscription` |
|---|---|---|
| 레인 | 대화·리뷰(#40) | 대화만 |
| 구조화 출력 | `--json-schema` → 마지막 `result.structured_output` | `--output-schema` → `-o` 파일 |
| 도구 | none: `--tools ""`, MCP 없음, 실행 중 도구 호출이 보이면 즉시 중단(예산 0) | read-only 샌드박스 + 요청 도구 예산(D4) |
| 세션 기록 | `--no-session-persistence` + 실행 디렉터리(HOME·CLAUDE_CONFIG_DIR·TMPDIR) 통째 삭제 | `--ephemeral` + CODEX_HOME `sessions/`·`archived_sessions/` 삭제 |
| 모델 고정 | 예(`--model`, 실행마다 init 이벤트와 대조) | 아니오(CLI 기본) |
| 자격 | env-static | file-mutable |
| 근거 수준 | 가짜 CLI 시험 | 가짜 CLI 시험 |

**자격 방식.**

- env-static(Claude 토큰): `<WORKER_CREDENTIAL_DIR>/<WORKER_CREDENTIAL_KEY>`(Secret 볼륨 파일). 읽기는 Codex 시드와 같은 `readSecretFile`이다: 링크의 최종 대상이 사람 홈 `.codex*`·`.claude*`면 거부, 검사한 경로와 연 파일 대조, 일반 파일·16KiB 이하. 앞뒤 공백·줄바꿈을 떼고 인쇄 가능한 ASCII 한 줄(16~8192자)이어야 한다. 토큰 접두어는 공식 형식이 없어 [미확인] 보지 않는다. 기동 때, readiness 때, **실행 준비 때마다** 다시 읽는다. 그래서 ESO가 값을 바꾸면 파드 재시작 없이 다음 실행부터 새 값이다(이미 실행 중인 자식은 옛 값). 영속 공간에 복사하거나 되쓰지 않는다. 사유 코드는 `credential_missing`·`credential_unreadable`·`credential_personal_path`·`credential_invalid`다.
- file-mutable(Codex auth.json): 위 "T16b 작업자 진입점"의 시드 복사 그대로다. `CODEX_HOME`은 공장 함수(`createExecutor`)가 한 번 검증·해석한 실제 경로를 어댑터와 자격이 함께 쓴다. 정상 별칭(심링크) 경로를 자격에 그대로 넘기면 `O_NOFOLLOW` 읽기가 실패해 반사 검사가 비밀을 모른 채 돌았다(리뷰 exec-r1 P1).
- 두 방식 모두 실행 준비 때나 실행 뒤 자격을 읽지 못하면(파일 자격은 비밀 문자열이 하나도 안 나와도) `credential_unreadable`로 그 실행을 `failed`로 닫는다. 빈 비밀 목록으로 반사 검사를 건너뛰지 않는다.

**공통 실행 전 검사(`assertLaunchSafe`).** 다음이면 띄우지 않고 `failed`(남은 프로세스 없음)다: 어댑터 env 이름이 선언 목록 밖이거나 공통 기본 이름을 덮음, 자격 값이 어댑터의 자격 변수 밖(argv, 다른 env 값, 실행 디렉터리의 파일)에 있음, 정적 자격인데 자격 변수에 그 값이 없음, 반사 검사에 쓸 비밀이 하나도 없음. 작업자 프로세스 env는 읽거나 병합하지 않는다. 어댑터가 잘못돼도 공통부가 막는다(시험 CLD-09).

**Claude 어댑터.** 플래그는 고정 바이너리 2.1.308 `claude --help`에서 모두 확인했다[실측]. 이벤트 모양은 같은 바이너리에 든 SDK 메시지 스키마(정적 읽기)와 공식 headless 문서다[가정: 실제 출력 대조는 S12].

- argv: `-p --output-format stream-json --verbose --json-schema <CHAT_OUTPUT_JSON_SCHEMA> --model <WORKER_MODEL> --tools "" --strict-mcp-config --mcp-config {"mcpServers":{}} --no-session-persistence --permission-mode dontAsk --disable-slash-commands --safe-mode`. 프롬프트는 stdin이다(argv·파일에 두지 않음).
- 쓰지 않는 플래그(`CLAUDE_FORBIDDEN_FLAGS`, 시험이 확인): `--bare`(OAuth 토큰을 읽지 않는다 [확인: --help]), `--fallback-model`, `--dangerously-skip-permissions`, `--resume`·`--continue`, `--add-dir`, `--allowedTools`, `--settings`·`--setting-sources`, `--system-prompt`, `--plugin-dir`, `--debug-file` 등. 예외는 리뷰 레인의 `--settings` 하나다. 내장 플러그인 두 개(`cc-plugin-agents-md@builtin`·`cc-plugin-plugin-authoring@builtin`)를 끄는 고정 인라인 JSON(`REVIEW_SETTINGS`)만 넘기고, 시험이 값까지 확인한다. `--safe-mode`도 내장 플러그인은 켠 채 둬서 첫 실리뷰가 init `plugins` 검사에 막혔기 때문이다(2026-11-04 실측, [VERIFICATION](VERIFICATION.md) "T17 실가동 구현"). 대화 레인 argv는 그대로다.
- env: 공통 기본 + `CLAUDE_CONFIG_DIR`(실행별 임시) + `CLAUDE_CODE_OAUTH_TOKEN`(토큰) + 고정 8개 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`·`DISABLE_TELEMETRY=1`·`DISABLE_ERROR_REPORTING=1`·`DISABLE_FEEDBACK_COMMAND=1`·`CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1`·`ENABLE_CLAUDEAI_MCP_SERVERS=false`·`DISABLE_UPDATES=1`·`CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1`. 마지막 값은 Opus 5.5의 내용 기반 자동 모델 전환(Opus 5·Opus 4.8로 다시 실행)을 끈다. 이 전환은 `--fallback-model`과 별개로 기본 켜져 있다 [확인: 공식 모델 설정·env 문서, 2.1.308 바이너리의 전환 조건이 이 값을 봄](리뷰 exec-r1 P1). `-p`에서는 API 키가 OAuth 토큰보다 우선하므로 [확인: 공식 인증 문서] 자격 변수는 하나만 넣는다.
- 실행마다 첫 `system/init` 확인: `tools`가 출력 전달용 `StructuredOutput`뿐(또는 없음), `mcp_servers` 0개, `model` = `WORKER_MODEL`, `apiKeySource` = `none`(OAuth 토큰. API 키가 쓰였다면 `ANTHROPIC_API_KEY`), `claude_code_version` = 2.1.308. 하나라도 다르면 기한을 기다리지 않고 즉시 멈추고 `failed`다.
- init 뒤에도 모델을 본다(모델 고정은 사용자 결정): `system/model_refusal_fallback`(자동 전환) 이벤트가 오거나, assistant 메시지의 `message.model`이 `WORKER_MODEL`(날짜가 붙은 같은 ID 포함)이나 CLI 합성 오류 표식 `<synthetic>`이 아니면(없음 포함) 즉시 멈추고 `failed`다. 판정에서도 같은 조건을 다시 본다.
- 판정: init 하나·result 최대 하나가 아니거나 깨진 줄 → `failed`. 오류 결과(`is_error`가 false가 아니거나 subtype이 success가 아님)는 assistant 메시지의 `error` 종류로 가른다: `authentication_failed`·`oauth_org_not_allowed`·`account_on_hold`·`verification_required` → `auth_expired`, `rate_limit`·`billing_error` → `limited`, 그 밖 종류(`overloaded`·`server_error` 등) → `failed`. 종류가 없거나 `unknown`일 때만 HTTP 상태(401·403 → `auth_expired`, 429·402 → `limited`)를 본다. 성공은 `is_error=false` + subtype success + 종료 코드 0 + `structured_output`이 있어야 한다. 모델 답·`result` 텍스트에 "401"·"rate limit"이 있어도 보지 않는다. 중간 `system/api_retry` 뒤 성공한 실행은 성공이다.
- 출력 줄은 판정 필드만 남긴다(모델 본문·thinking·도구 입력·`result` 텍스트는 버림). 상한은 공통 `CHAT_LIMITS`(줄 1MiB, 전체 16MiB, 이벤트 2만 개)다.

**기동 순서.** env 확인(공통 여섯) → 프로필 선택 → 프로필 추가 env → 경로·공개 키 → 자격 디렉터리·nonce 디렉터리가 사람 홈이나 `.codex*`·`.claude*` 아래면 거부 → 어댑터·자격 조립(Codex는 CODEX_HOME 개인 경로 거부) → `<실행 파일> --version`(빈 임시 HOME·설정 디렉터리, 자격 없음, 모델 호출 없음)이 프로필 버전과 같은지(`executor_version_mismatch`·`executor_version_unavailable`) → 자격 준비(`present`·`seeded`·`kept`) → nonce 저장소 → 8080. 기동 로그는 `{"event":"worker_started","profile":…,"cli":…,"model":…,"credential":…}`이고 값(토큰·키)은 싣지 않는다.

| env | 필수 | 내용 |
|---|---|---|
| `WORKER_EXECUTOR` | 예 | `claude` 또는 `codex` |
| `WORKER_MODEL` | 예 | Claude는 전체 모델 ID(`claude-opus-5-5`), Codex는 `cli-default` |
| `WORKER_CREDENTIAL_DIR` | 예 | 자격 Secret 볼륨 디렉터리(절대 경로) |
| `WORKER_CREDENTIAL_KEY` | 예 | 자격 키 이름 = Secret 파일 이름 = 인증 방식(`CLAUDE_CODE_OAUTH_TOKEN`·`CODEX_AUTH_JSON`) |
| `WORKER_NONCE_DIR` | 예 | 영속 공간(PVC) 안 nonce 디렉터리. 프로필과 무관하게 필요하다(D3) |
| `WORKER_CONTROL_PUBLIC_KEY` | 예 | Ed25519 공개 키 PEM(위 절 그대로) |
| `CODEX_HOME` | Codex만 | 영속 공간의 Codex 홈(auth.json 갱신본). `WORKER_NONCE_DIR`과 같으면 거부 |
| `WORKER_EXECUTOR_BIN` | 아니오 | 실행 파일 경로를 바꾼다(시험용). 기본은 프로필의 이미지 경로 |
| `HTTPS_PROXY`, `NO_PROXY` | 아니오 | 모델 CLI 프로세스 env에 넘긴다. 없거나 잘못되면(`NO_PROXY`가 루프백 밖인 경우 포함) 리뷰 레인만 닫고 사유를 로그에 남긴다(`review_lane_closed`, #42). 압축본 다운로더는 이 env의 `HTTPS_PROXY`만 쓰고 `NO_PROXY`는 무시한다(#43·#44) |

**실행 기록 정리 실패(리뷰 exec-r1 P2).** 프로세스 소멸을 확인한 실행은 어댑터 고유 잔여물(Codex `sessions/`·`archived_sessions/`)과 실행 디렉터리를 지우고, 실행 디렉터리가 정말 없어졌는지 확인한 뒤에 결과를 확정한다. 지우지 못하면(권한·파일시스템 오류) 그 실행의 답은 게시하지 않고 `failed`(`stopped: true`, 프로세스는 끝났으니 `unknown`이 아님)이며, 한도·인증·실패 결과는 그대로 둔다. 지우지 못한 실행은 잔여물로 추적한다. 잔여물이 남은 동안 새 실행은 띄우지 않고(`failed`) readiness는 503이다. readiness 확인과 새 실행 직전마다 다시 지워 보고, 모두 지워지면 자동으로 돌아온다. 소멸을 확인하지 못한 실행은 살아 있는 프로세스가 쓰는 중일 수 있어 지우지 않는다(그 실행은 `unknown`이고 `ExecutionSlot`과 `RunControl`이 막는다). 기동 로그와 같은 줄 형식으로 값 없는 사건 `{"event":"cleanup_failed"}`·`{"event":"cleanup_recovered"}`만 남긴다(경로·내용 없음). `ChatLane`을 공유 실행 제어 없이 따로 조립할 때만 옛 이름 `chat_cleanup_*`로 옮겨 낸다. 운영 진입점은 공유 실행 제어라 이 경우가 아니다.

**정책 위반 종류 로그(2026-11-04).** 결과 `reason`과 DB는 `policy_violation` 한 단어뿐이라, 실행이 정책 위반으로 멈추면 같은 줄 형식으로 `{"component":"worker","level":"warn","event":"run_policy_violation","lane":"review","kind":"plugins_enabled"}`를 실행당 한 번 남긴다. `kind`는 봇 코드의 상수(`PolicyViolation`: `tools_enabled`·`mcp_enabled`·`skills_enabled`·`plugins_enabled`·`hooks_enabled`·`tool_activity`·`tool_not_allowed`·`session_mismatch`·`model_mismatch`·`model_fallback`·`credential_source_mismatch`·`version_mismatch`)뿐이고 도구·플러그인·모델 이름과 job ID는 싣지 않는다. 실행 중 관측(`observe`)과 사후 판정(`interpretClaudeStream`)을 모두 덮고, 프로세스 소멸을 확인하지 못해 결과가 `unknown`이어도 실행 중 관측분은 남는다. `tool_use` 블록은 정책 위반이 아니라 `tool_budget_exceeded` 경로라 이 사건을 내지 않는다.

**readiness.** `GET /readyz`는 앞 실행의 기록이 모두 지워졌고 선택한 자격이 쓸 수 있는 모양으로 있으면 200이다. Claude: 토큰 파일 읽기·모양(없어지거나 틀리면 503, 돌아오면 200). Codex: 영속 공간의 일반 파일 `auth.json`. 모델을 부르지 않는다. readiness 200은 인증 서버가 토큰을 받는다는 뜻이 아니다.

**준비된 프로필 사이 전환(설정 PR 하나 + 자격 하나).**

1. 사람이 대상 프로필의 자격 하나를 Infisical `/apps/homelab-bot/worker`의 그 키에 넣는다.
2. sandbox values PR: `WORKER_EXECUTOR`·`WORKER_MODEL`·`WORKER_CREDENTIAL_KEY` 세 값, ExternalSecret의 키 하나, 프로필 egress 호스트. 이미지 digest는 그대로다(두 CLI가 이미 들어 있다).
3. 배포 전 모델 실행을 멈추고 실행 중 작업을 drain한다. `unknown`이면 새 실행기로 넘기지 않는다. 프록시와 작업자 롤아웃은 원자적이지 않다.
4. 병합 뒤 버전·프로필·readiness를 보고, 승인된 최소 실제 대화로 확인한 뒤 사람이 재개한다.

롤백은 이전 프로필을 고르는 PR이다. Codex로 돌아갈 때는 PVC의 갱신본 `auth.json`을 쓰고 옛 시드로 덮지 않는다(시드 규칙이 이미 그렇다). 새 실행기(OpenCode 등)나 새 인증 방식(Claude API 키 등)은 어댑터·이미지·시험을 더한 뒤 프로필 표에 한 줄을 더하는 코드 PR이 먼저다.

**남는 것 [미확인]·[가정] (S11·S12 실측).**

- 실제 stream-json 모양: `system/init`의 `model` 값과 assistant `message.model`이 `--model`로 준 ID와 글자 그대로(또는 날짜 접미어만 붙어) 같은지, `apiKeySource`가 `none`인지, `--tools ""`일 때 `tools`에 `StructuredOutput`이 남고 구조화 출력이 되는지, 한도·인증 오류가 assistant `error` 종류로 오는지. 다르면 첫 대화가 `failed`(정책 위반 또는 결과 없음)로 닫히는 쪽으로 틀린다(fail-closed).
- egress: 모델 요청은 `api.anthropic.com:443` [확인: 공식 네트워크 문서]. 장기 토큰 사용 때 `claude.ai`·`platform.claude.com`(OAuth 교환·갱신)이 필요한지는 [미확인]이다. DNS 없는 파드에서 `HTTPS_PROXY`만으로 되는지도 [미확인]이고, 안 되면 먼저 볼 후보는 2.1.308에 있는 `CLAUDE_CODE_PROXY_RESOLVES_HOSTS`다(값의 뜻은 미확인이라 지금 넣지 않았다).
- 시작 실패 분류: 2.1.308은 일부 시작 실패를 stderr에만 쓰고, 구조화된 `startup_failure_reason` 결과는 `CLAUDE_CODE_STARTUP_FAILURE_RESULTS` opt-in이 있어야 낸다 [확인: 바이너리 스키마 설명, 리뷰 exec-r1]. 이 값은 넣지 않았다. 그런 실패는 결과 없음 → `failed`로 닫히고 한도·인증으로 분류되지 않는다.
- `--safe-mode`·`--strict-mcp-config`·`--disable-slash-commands`와 OAuth 토큰·구조화 출력의 조합이 실제로 함께 도는지. CLI가 실행 디렉터리 밖(`/tmp` 직접 등)에 쓰는 파일이 있는지.
- 메모리·`/tmp`(256Mi) 사용량, 첫 응답 시간(대화 기한 60초 안인지).
- Claude 토큰도 같은 UID에서 `/proc/<pid>/environ`으로 읽힌다. 대화 레인에는 비신뢰 코드가 없어 받아들인 위험이고, 작업 레인을 열기 전에 T18 결정 (2)·(4)가 필요하다.

### T18 작업 레인 계약 (Claude, 2026-11-05)

**이 절은 끝점 계약이다.** 라우트·조립·명령은 아래 "T18 작업 레인 조립"에 있고 스위치가 기본 꺼짐이다. 기존 `/v1/execute`·`/v1/cancel`·`/v1/review*`와 `REVIEW_INSTRUCTIONS`는 바꾸지 않는다. 위 "T16a 소유 변경 요청" 3의 task 요청 필드는 기존 `WorkerRequest`가 아니라 이 새 계약이 담는다. 이 절의 재개·수명 규칙은 Claude 작업 경로의 계약이고, 위 Codex 절의 어댑터 값을 바꾸지 않는다.

**계약.** `src/task-contracts.ts`가 끝점 표 `TASK_ENDPOINTS`로 끝점·operation·요청·응답을 묶는다. 모두 strict이고 `version:1`이다.

| 끝점 | capability operation | 요청 | 응답 |
|---|---|---|---|
| `POST /v1/task` | `task_execute` | `TaskRequestSchema`. `operation:'start'`(turn 1, `untrusted.request`) 또는 `'resume'`(turn 2 이상, `expectedWorker`·`resumeReason` 필수, clarification이면 `questionId`·`untrusted.answer` 필수) | `TaskResponseSchema`: `completed`·`needs_input`·`limited`·`auth_expired`·`failed`·`unknown` |
| `POST /v1/task/cancel` | `task_cancel` | job·lease·generation·sessionId + `expectedWorker`(첫 턴 응답을 잃었으면 null) | `stopped`·`cleaned`·`cleanupPending`·`sessionRetained`·worker identity. `cleaned`는 이 턴의 실행 잔여물을 치웠다는 뜻이다 |
| `POST /v1/task/status` | `task_status` | cancel과 같은 식별자 | `state`(`running`·`waiting`·`cleanup_pending`·`finalized`·`absent`·`unknown`)·`turn`·`sessionExists`·`stopped`·worker identity. 내용·파일·토큰은 없다 |
| `POST /v1/task/finalize` | `task_finalize` | 같은 식별자, `expectedWorker` 필수, `disposition:'terminal'`, 결과 영속 `receipt` | cancel과 같은 필드. `cleaned`는 세대 전체를 지웠다는 뜻이라 `sessionRetained`와 함께 true일 수 없다 |

거부는 `400·401·403·409` + `{status:'rejected',started:false}`(`TaskRejectionSchema`)다. 이것과 연결 전 실패만 미시작의 증거다.

`stopped`는 프로세스 소멸 확인만 말한다. `completed`·`needs_input`은 `cleanupPending:true`로 나가지 못해 그 경우는 `failed`(`cleanup_pending`)다. `unknown`은 `stopped:false`·`sessionRetained:true`만 있고 결과·diff 필드가 없다. 응답의 변경 목록·patch·검증 결과는 소멸 확인 뒤 작업자가 계산한 값이고, `failed.reason`은 상수 목록(`TASK_FAILURE_REASONS`)이다. 정리를 어떤 방식으로 확인했는지(작업 레인 프로세스 정리 backend)는 계약에 담지 않는다.

**서명.** 형식은 대화·리뷰와 같다(`src/worker.ts`의 `sealCapability`·`openCapability`·`capabilityLive`, Ed25519, 수명 30초, skew 1초, nonce 보존 62초). `TaskWorkerSigner`·`TaskWorkerVerifier`가 audience `homelab-task-worker`와 위 operation, `version`·`job`·`lease`·`generation`, 본문 digest를 검증한다. 대화·리뷰의 `homelab-worker` capability와는 같은 키로 서명돼도 양쪽 검증이 서로의 토큰을 거부하고, operation·본문 타입도 달라 컴파일에서 막힌다. digest는 `JSON.stringify` 기준이라 발급·검증 양쪽이 같은 schema로 파싱한 값을 넘겨야 한다.

**값.**

| 항목 | 값 | 근거 |
|---|---|---|
| 질문 대기 기한 | 1시간 | 확정(사용자 2026-11-05), `CODEX_DEFAULTS.questionTtlMs` |
| 모델 한도·인증 대기 | 24시간이 지나면 owner 확인 요구. 자동 재개·자동 폐기 없음 | 확정 |
| 작업 세션 PVC | 2Gi | 확정 |
| 같은 레인에 보존하는 작업 세션 | 최대 8개 | 확정 |
| unknown | 기한이 지나도 강제 삭제하지 않고 새 접수를 닫음 | 확정 |
| 첫 live 시험 저장소 | `homelab-smoke`. 이 변경에서 실행·개방하지 않음 | 확정 |
| 턴 기한, 남은 도구 호출, 입력 길이 | 1,800,000ms, 1~8회, 각 8,000자 | `DEFAULTS` 재사용 |
| 본문 | 2MiB | `MAX_TASK_BYTES` 재사용 |
| 줄·전체 출력·이벤트, 변경 목록 항목 | 1MiB·16MiB·2만 개, 1000개 | `CODEX_LIMITS`·`EVIDENCE_PATHS` 재사용 |
| 압축본·파일 수·파일 크기 | 200MB·1000개·2MB | 리뷰 레인 상한과 같은 값 |
| 요약·질문 | 1500자·500자 | `interpretRun`이 자르는 값과 같음 |
| job 누적 실행 시간 | 5,400,000ms(최대 턴 3회) | 제안. 실측 뒤 조정 |
| 턴 수 | 16 | 제안. 실측 뒤 조정 |
| patch | 1MiB, 넘치면 `truncated`와 전체 digest | 제안. 응답 본문 상한 안에 들어가게 정함 |

**DB(`migrations/013_task_lane.sql`, expand).** 009를 고치지 않는다. 새 열은 기본값이 있거나 비워 둘 수 있어 이 열을 모르는 코드가 그대로 돈다.

| 대상 | 추가 | 의미 |
|---|---|---|
| `codex_sessions` | `executor`(기본 `codex`), `claude_session_id`, `generation`, `worker_lease`, `worker_instance`, `worker_storage`, `base_sha`, `policy_revision`, `project_id`, `project_revision` | 옛 세션은 codex로 남고 Claude가 잇지 않는다. Claude 행은 재개 대조 값이 모두 있어야 한다(CHECK) |
| `codex_sessions` | `turn_timeout_ms`, `run_budget_ms`, `run_used_ms` | 턴 기한과 누적 예산을 나눠 재개로 시간이 새로 채워지지 않게 한다 |
| `codex_sessions` | `stopped`, `session_retained`, `cleanup_state`(`none`·`pending`·`cleaned`), `waiting_since`, `owner_confirm_requested_at` | 정리 상태와 모델 대기 시작·owner 확인 요청 시각 |
| `jobs` | `execution_lane`(생성 열) | task는 `task`, read는 NULL, 나머지는 `interactive` |
| `execution_lanes` | 행 `interactive`·`task`, `closed_reason`(`unknown`·`cleanup_pending`·`retention_full`), `closed_at` | 레인별 잠금 행과 새 접수 막힘. 작업 레인 개방 여부는 이 행이 아니라 설정 gate가 정한다 |

슬롯을 어떻게 쓰는지는 아래 "T18 게시 서버 스케줄링과 질문"이 다룬다.

**실행기 관측.** `Observation.tools`는 그 줄에서 시작한 도구 호출 ID 목록이다. 한 assistant 메시지의 `tool_use`를 모두 세고, ID가 없는 호출은 서로 합치지 않는다. 대화·리뷰는 도구 예산이 0이라 호출 하나로 멈춘다. 능력표 값 `tools:'sandboxed-task'`·`sessionPersistence:'per-job'`과 위반 종류 `tool_not_allowed`·`session_mismatch`는 아래 작업 어댑터만 낸다. 어떤 프로필에도 들어가지 않았다.

**R08은 이 계약 밖이다.** 계약·테이블은 §15에 따로 둔다.

### T18 작업 레인 실행·정리 (Claude, 2026-11-05)

`WORKER_LANES=task` 작업자만 이 코드를 쓴다(아래 "T18 작업 레인 조립"). 대화·리뷰의 argv·판정·정리·임시 공간은 그대로다.

**구성.**

| 파일 | 맡는 것 |
|---|---|
| `src/executor-claude-task.ts` | `ClaudeTaskAdapter`(argv·env·`--settings`·stream 판정), `taskPrompt`, `judgeTaskRun`(응답 union으로 분류), `runTaskTurn`(한 턴), `taskImageProblems`(이미지 검사) |
| `src/task-workspace.ts` | `TaskSessions`(세션 경로·추출·기준 커밋·재개 대조·증거 계산·finalize), `parseTaskArchive`(압축본 검사) |
| `src/task-containment.ts` | `PodPidSpace`(기준 상태 기록·파드 PID 공간 정리·소멸 확인) |
| `src/process-launcher.ts` | `options.cleanup`이 있으면 정리·소멸 확인을 그쪽에 넘긴다. 없으면 지금 그대로다 |
| `src/run-control.ts` | `RunSpec.session`이 있으면 임시 공간을 만들지도 지우지도 않고 그 공간을 쓴다 |

**한 턴의 순서.** 세션 준비(첫 턴: 압축본 받기 → 검사 → 풀기 → 기준 커밋·해시 / 재개: 묶인 값 대조) → 다른 작업 경로 열거 → 설정 생성 → 실행 → 정리 → 판정. 판정은 **정리 확인 → 실행 중 집행(상한·위반·중단) → stream 무결성 → 종료·오류 → structured_output → 실제 diff·반사 검사** 순서다. 소멸을 확인하지 못하면 결과 파일을 읽지 않는다.

**세션 공간.** `<TASK_STATE_ROOT>/tasks/<job>/<generation>/{home,config,workspace,run,tmp}`. `run`에는 묶인 값(`session.json`), 기준 해시(`baseline.json`), 기준 압축본(`baseline.tar.gz`)이 있고 모델의 셸·파일 도구에서 가린다. patch의 이전 쪽은 이 압축본에서 푼다. 실행 뒤의 `workspace/.git`은 비신뢰라 쓰지 않는다.

- **추출.** 고정 SHA URL만 `createArchiveFetcher` 계약으로 받는다. 디스크에 쓰기 전에 끝까지 검사하고, 하나라도 어긋나면 아무것도 쓰지 않는다. 절대경로·`..`·중복·`.git`(대소문자·깊이 무관)·device·FIFO·hardlink·GNU 확장·바깥 symlink·symlink를 거치는 항목을 거부한다. symlink는 글자가 아니라 실제로 따라가 판정한다(`x/up -> ..`, `out -> x/up/..`를 잡는다).
- **상한.** 보존 세션 8개, 볼륨 2Gi(로컬 PV는 요청 크기를 강제하지 않아 코드가 센다), 해제본 256MiB(대조 상한과 같음). 넘거나 디스크가 차면 `failed(storage_full)`이다. 응답 사유가 하나라 보존 수 초과와 디스크 부족을 구분하지 않는다(`TaskWorkspaceError.detail`에는 있다).
- **증거.** 변경 목록은 기준 해시와 실제 파일의 대조다. 바깥을 가리키는 symlink·hardlink는 `change_outside_workspace`, FIFO 등과 중첩 `.git`은 `change_path_invalid`, 정책 밖은 `change_outside_policy`다. 자격 반사는 바뀐 경로의 이름과, 기준 쪽(삭제 줄이 나오는 곳)·실행 뒤 쪽 본문(이진 포함)·symlink 대상, 그리고 잘리기 전 patch 출력 전체에서 찾는다. 이진 파일은 patch에서 base85가 되어 원본에서 재야 잡히고, 양쪽에 나뉜 조각은 patch에서 처음 이어지므로 둘 다 본다. 걸리면 `secret_echo`로 증거를 내보내지 않는다. 그래서 현재 자격이 든 기준 파일을 고치거나 지우는 작업은 완료될 수 없다. 바꾸지 않은 기준 파일은 patch에 나가지 않아 검사하지 않는다. patch는 설정을 읽지 않는 `git diff --no-index`로 만들어 1MiB까지 담고 digest는 전체 출력 기준이다. `verification`의 `command`는 서명된 요청의 이름(`^[a-z][a-z0-9_-]{0,63}$`)이고 상태는 상수라 작업이 만든 바이트가 없다.
- **샌드박스 흔적.** 고정 CLI는 모델의 의도와 무관하게 작업 디렉터리 최상위에 빈 항목을 남긴다. 변경 계산은 **실행 전 기준에 없고, 최상위이고, `SANDBOX_TRACE_NAMES`(`src/task-workspace.ts`)에 있고, 크기 0 일반 파일이고, 소유자 실행 비트가 없는 것**만 뺀다. 내용이 있거나, 실행 비트·심링크·FIFO·hardlink이거나, 하위 경로이거나, 실행 전에 있던 경로면 지금처럼 정책 판정을 받는다. 지우지 않고 계산에서만 빼며 세션 공간과 함께 finalize로 사라진다. 뺀 파일은 바이트가 없고 이름도 상수라 빼도 증거를 잃지 않는다. 빈 디렉터리(`.claude/agents`, `.claude/commands`, `.claude/.cc-writes`, `node_modules/.bin`)는 snapshot이 디렉터리를 기록하지 않아 처음부터 증거에 없다. 흔적의 출처는 둘이다(실측은 VERIFICATION "T18 live 시험 1").
  - **scrub stub.** `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`이면 CLI가 시작할 때 `package.json`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `bunfig.toml`, `.gitmodules`, `.env*` 8개를 만들고 끝나도 지우지 않는다. 도구를 부르지 않아도 생긴다. 완료 턴에서 남는 것은 이것이다.
  - **bwrap 마운트 지점.** 없는 deny 경로마다 Bash 명령 때 생긴다(`.gitconfig`, `.bashrc`, `.bash_profile`, `.zshrc`, `.zprofile`, `.profile`, `.ripgreprc`, `.mcp.json`, `.vscode`, `.idea`, `.github`, `scripts`). CLI가 정상 종료하면 지우고, 강제 종료되면 mode 444 빈 파일로 남는다. 디렉터리 이름도 파일로 남는다.
  - 목록의 나머지는 바이너리의 작업 디렉터리 보호 목록이고 실측에서 생기지 않았다. 목록은 CLI 2.1.308에 묶여 있다. **CLI를 올리면 바이너리와 실측으로 다시 뽑는다.** 버전 고정 시험이 그때 함께 깨진다.
- **오류 진단.** 턴이 `completed`·`needs_input` 말고 끝나면(예외 포함) 작업자가 `task_turn_finished` 앞에 `task_turn_error_detail`을 남긴다. 필드: job, generation, turn, status, reason, `cli_version`, `init_confirmed`, `engine_reason`(응답 사유로 바꾸기 전의 판정), `result_subtype`, `is_error`, `exit_code`, `exit_signal`, `tools`, `assistant_error`, `api_error`, `api_error_status`, `stop_reason`, `api_error_code`, `api_error_origin`. 문자열은 `^[a-z][a-z0-9_]{0,63}$` 식별자만(버전은 숫자 세 마디, 신호는 `SIG` 이름, origin은 `first_party`만), 상태는 100~599 정수만이고, 없으면 `null`, 형식 밖이면 `unknown`이다. `error_details`, `errors[]`, `message.content`, `result` 원문, stderr, 요청·응답 본문은 읽지 않는다. telemetry와 `--debug`는 켜지 않는다. 봇의 `api_error`는 HTTP 500 `api_error`와 다른 뜻이다. 오류 result를 받았는데 인증·한도·거절이 아닌 나머지 전부다. 이 이벤트의 값으로 원인을 가른다.
- **거절 분류.** 최종 `stop_reason: "refusal"`이거나 `api_error`가 `dlp_request_denied`·`safety_monitor_blocked`이면 판정은 `model_refusal`이다(모든 Claude 레인 공통). 오류 result뿐 아니라 HTTP 200 거절(오류 표시 없고 structured output 없음)도 같다. HTTP 상태 추정보다 앞선다. 조직 DLP가 403으로 오면 인증 만료로 읽혀 재인증을 기다리게 되기 때문이다. structured output이 있으면 거절로 뒤집지 않고, 종료 코드가 0이 아니면 `exit_nonzero`가 먼저다. 계약의 `TASK_FAILURE_REASONS`에 거절이 따로 없어 작업 응답의 사유는 `model_cannot_complete`이고 거절인지는 `engine_reason`이 말한다. 자동 재시도·모델 전환은 없다. 필드 위치는 고정 CLI의 SDK 스키마를 읽은 것이고 내부 필드라 유지 보장이 없다.
- **로그.** 내용 없이 상수와 수만 남긴다. 작업자: 턴마다 `task_turn_started`(job, generation, turn, operation)·`task_turn_finished`(status, reason, tools, ms, stopped, cleaned), 흔적을 뺐으면 `task_sandbox_traces_ignored`(count), 정책 밖 변경이면 `task_change_outside_policy`(reason, total, added, modified, deleted, topLevel, nested. **경로 이름 없음**), 라우트 거부·오류는 `task_route_rejected`(endpoint, status, reason)·`task_route_failed`(endpoint, error 이름). 게시 서버: 작업이 끝나면 `task_job_finished`(job, state, reason), dispatch 전 오류는 `task_job_prepare_error`(job, error 이름·사유 코드). 질문 만료(`expireQuestions`)와 lease 만료(`store.expire`)로 끝나는 경로는 브리지 밖이라 `task_job_finished`를 남기지 않는다. 사용자 요청·모델 출력·파일 내용·토큰은 어느 쪽에도 남기지 않는다.
- **보존 여부.** `sessionRetained`는 오류 사유로 짐작하지 않고 `TaskSessions.exists`(실제 세대 경로)로 답한다. `retained()`도 같은 디렉터리를 센다. 없음을 확인하지 못하면 남은 것으로 본다. 그래서 대화 기록 없는 재개와 깨진 `session.json`은 `failed(session_missing)`이어도 공간이 있으면 `sessionRetained:true`이고 finalize가 지운다. 공간이 없을 때만 `false`다. 첫 턴 실패 뒤 지우지 못했거나 같은 세대 첫 턴이 다시 온 경우도 `true`다. 예외는 `unknown`이다. 계약상 항상 `true`다.
- **표시 못 하는 것.** 압축본에 내용이 없는 submodule·LFS는 `TaskSession.unsupported`로 알려 준다. `verification`은 아직 전부 `not_run`이다. 검증 명령을 돌리는 코드가 없다.

**실행 설정.** argv·settings·env는 `test/task-settings-boundary.test.ts`가 값까지 확인한다. 경계로 세는 것과 세지 않는 것을 나눈다.

| 항목 | 상태 |
|---|---|
| 악성 스냅샷의 hook·`.mcp.json`·skill·명령·설정 차단(`--setting-sources user --safe-mode --strict-mcp-config --disable-slash-commands`) | 고정 CLI 실측: 시작·재개 모두 marker 0. 대조군에서는 hook이 돈다 |
| 샌드박스 못 세우면 실패 | 고정 CLI 실측: bwrap 없음은 기동 거부, socat 없음은 init 전 오류 |
| scrub·자격 경로 `denyRead`·Read deny | 파드 실측(위 DECISIONS "(2)") |
| 제어 경로·다른 작업 경로의 `denyRead`·`denyWrite`, Edit deny | **[미확인]** 도구 호출이 있어야 본다 |
| `blockReadsOutsideWorkingDirectories` | 2.1.308 바이너리에 있고 파싱된다. 막는지는 **[미확인]**이라 경계로 세지 않는다 |
| CLI 메시징 소켓 디렉터리 가림(`/tmp/cc-socks-<uid>`) | 제안. init의 `messaging_socket_path`에서 찾았다. 효과 **[미확인]** |

**프로세스 정리.** DECISIONS "T18 할 일 6 정리 방식"을 구현한다. 작업 레인 파드에서만 켠다.

1. 기동 때 `PodPidSpace.record({ dedicatedTaskPod: true })`가 작업자와 PID 1만 있음을 확인한다. 다른 프로세스가 보이면 `ContainmentUnavailable`이다.
2. `terminate`: `kill(-1, TERM)` → 유예(기본 1.5초, 모두 끝나면 바로 넘어감) → `kill(-1, KILL)` 반복(기본 2초). 합이 취소 대기 4초 안이다.
3. `survivors`: `/proc`의 `State`·`NSpid`로 같은 namespace 기준 밖과 다른 PID namespace를 함께 세고, 깨끗한 검사가 3번 연달아 나와야 0이다. 읽기 실패나 검사 중 사라지는 항목이 멈추지 않으면 `null`이다. 0이 아니면 위층에서 `unknown`이다.
4. 정리가 도는 동안 launcher는 새 프로세스를 띄우지 않는다.

좀비는 코드가 돌지 않아 세지 않는다. 단, 리더 스레드만 끝난 프로세스는 Z로 보여도 다른 스레드가 살아 있으면 센다.

**조립할 때 지킬 것.**

- `PodPidSpace.record`는 `--version` 확인이 끝난 뒤, HTTP를 열기 전에 부른다. `new ProcessGroupLauncher(['/usr/local/bin/claude'], { cleanup: space })`로 넘기고, 이 launcher는 작업 레인 `RunControl`에만 쓴다.
- 작업 파드에 exec probe·사이드카·`kubectl exec`가 있으면 정리에 함께 죽거나 기동이 실패한다.
- `runTaskTurn`은 서명·lease·fence·직렬 슬롯을 하지 않는다. 라우트가 앞에서 막는다. 턴 준비 중의 git도 정리에 죽을 수 있어 취소와 실행을 직렬로 묶는다.
- 이미지 검사(`taskImageProblems`)가 문제를 내면 작업 레인을 닫는다.

### T18 게시 서버 스케줄링과 질문 (2026-11-05)

`main.ts`가 작업 레인을 조립할 때만 두 옵션을 함께 켠다(아래 "T18 작업 레인 조립"). `RuntimeOptions.taskLoop`와 `ReviewRuntimeOptions.lanes`가 기본 false면 `Runtime.tick`이 지금처럼 모델 job 전부를 슬롯 하나로 처리하고 `tickTask`는 아무것도 하지 않으며 레인 행을 잡지 않는다. 아래는 두 옵션을 켠 배치의 동작이다.

**구성.** `src/task-bridge.ts`의 `TaskBridge`가 실행기와 무관한 부분(재인가, 질문 중복·만료, outbox, lease 감시, 상태, 해제 권한)을 갖고, `CodexBridge`와 `ClaudeTaskBridge`(`src/claude-task-bridge.ts`)가 이를 상속한다. 작업자 호출은 `TaskWorkerPort.call(endpoint, body, signal)` 하나로, `TASK_ENDPOINTS`의 요청·응답 타입을 그대로 쓴다. 저장소·기준 커밋·프로젝트 정책은 `TaskPlanSource.plan`이 정한다. 시작하지 않았다는 증거(거부 응답, 연결 전 실패)는 `TaskWorkerRejected`로 던지고, 그 밖의 예외는 시작 여부를 모르는 것으로 본다.

**슬롯.**

| 대상 | interactive(대화·리뷰) | task |
|---|---|---|
| 직렬 1 | `Store.claim('interactive')`, `ReviewRuntime.claim` | `Store.claim('task')` |
| 레인 안에서 막는 것 | 실행 중·unknown·waiting_user(질문 대기 제외) | 같음 |
| 질문 대기 | 해당 없음 | 슬롯을 놓는다. job이 queued로 돌아오기 전에는 그 job을 집을 수 없고, 턴 시작의 세션 CAS가 같은 세션의 겹친 재개를 막는다 |
| 계정 한도 대기(`model_limit`) | 어느 레인에서 나도 양쪽을 막는다(`scheduler` 켜짐). 토큰이 달라도 한도는 합쳐진다고 본다 | 같음 |
| 인증 대기(`auth_expired`) | `scheduler`를 켜 대화·리뷰가 멈추고 표시·지표는 지금 그대로다. 작업 레인은 막지 않는다 | `waitForUser(..., { laneOnly: true })`로 `scheduler`를 켜지 않고 작업 레인만 막는다 |
| 비상 중지·인가·전체 큐 상한 | 공유 | 공유 |
| unknown | 대화·리뷰 슬롯을 막고 비상 중지 해제도 거부한다 | 작업 레인만 막고 새 접수를 닫는다. 비상 중지 해제는 막지 않는다 |

작업 레인 claim은 `scheduler` 값을 보지 않고 `scheduler_emergency`와 `model_limit` 대기만 본다. 대화 레인의 인증 대기가 켠 `scheduler`에 막히지 않게 하려는 것이다. `releaseScheduler`는 비상 중지가 없고, 질문 대기와 작업 레인의 인증 대기를 뺀 대기가 없을 때 정지를 푼다.

**비상 중지 해제와 unknown(사용자 2026-11-05).** `/resume-model target:emergency-stop`은 실행 중·중지 요청 중인 job(레인 무관)과 interactive 레인의 unknown이 있으면 거부한다. 작업 레인의 unknown은 `execution_lanes.closed_reason='unknown'`이 기록돼 있을 때만 해제를 막지 않는다. 풀린 뒤 대화·리뷰는 돌고, 작업 레인은 `claim('task')`와 `accept('task')`가 계속 닫혀 있어 `/task-release`로 소멸을 확인하기 전에는 새 작업을 받지 않는다. 해제 응답의 `taskLane`, 감사 `model_emergency_released`의 `taskLaneClosed`·`taskUnknownJobs`, Discord 제어 응답 문장, `/model-status`의 `taskLaneClosed`와 안내 문장에 드러난다. 닫힘 기록을 조건으로 둔 이유는 두 가지다. 작업 루프를 켜지 않은 배치는 이 행이 닫히지 않아 슬롯을 함께 쓰는 task unknown이 지금처럼 해제를 막고, lease 만료 직후 sweep 전이면 잠시 거부됐다가 다음 sweep 뒤 풀린다. 닫히지 않은 채 풀어 새 작업을 받는 틈이 없다.

**잠금 순서.** 대화 행 → `scheduler` 행 → `execution_lanes` 행 → job·세션·질문 행. `Store.lockTaskControl`이 앞의 셋을 이 순서로 잡고, 턴 시작(`begin`)·결과 확정(`settle`)·정리·해제가 이것으로 시작한다. claim과 접수는 대화 행이 없는 구간부터 같은 순서를 따른다. 스케줄러 행은 레인과 무관하게 하나라 짧은 claim 트랜잭션끼리는 줄을 서지만, 실행 자체는 어떤 행도 쥐지 않아 긴 작업이 대화를 기다리게 하지 않는다.

**접수 닫힘.** `Store.syncTaskLane`이 DB 사실에서 사유를 다시 계산해 `execution_lanes`에 적는다. `unknown`(Claude 세션이 unknown이거나, Codex 세션이 아닌 작업 레인 job이 unknown. 턴 시작 전에 lease가 끝나 세션이 없는 job도 센다) → `cleanup_pending`(정리 확인 실패) → `retention_full`(보존 세션 8개) 순이고, 사실이 사라지면 다시 열린다. 사실이 DB에 있어 재시작 뒤에도 같은 값이다. `accept('task')`는 `LaneClosed`를 던진다. `unknown`·`cleanup_pending`이면 claim도 아무것도 집지 않는다. `retention_full`이면 이미 보존 중인 세션의 재개만 집는다. 막으면 그 세션이 끝나지 못해 칸이 영영 비지 않는다. 세션은 첫 요청 전부터 보존으로 세어 응답을 잃어도 칸을 놓치지 않는다. Codex 작업은 세지 않으며 jobs 상태로만 슬롯을 막는다.

**턴 흐름(`ClaudeTaskBridge.run`).**

- 한 번의 `run`이 `/v1/task` 한 번, 곧 한 턴이다. 첫 턴은 새 세션 UUID와 세대를 쓰고, `/retry`는 앞 세대를 지운 뒤 세대를 올린다. 지우기 전이면 대기열로 되돌린다.
- 재개 전에 세션의 저장소·기준·프로젝트·정책 revision을 대조하고 `/v1/task/status`로 세션 공간과 이전 턴 소멸을 확인한다. 어긋나거나 세션이 없으면 실패이고 새 세션으로 조용히 바꾸지 않는다. 파드만 바뀌었으면(같은 storage) 새 instance로 잇는다. 상태 확인이 끊기면 대기열로 되돌린다.
- 도구 호출 수와 누적 실행 시간은 세션에 누적해 재개로 새로 채워지지 않는다. 사용량을 모르면 잇지 않는다.
- 턴 시작은 lease 확인과 세션 상태 CAS를 한 트랜잭션으로 한다. 띄우지 않고 job을 되돌리거나 실패시키는 경로도 읽어 둔 세션 상태가 그대로일 때만 그렇게 해, 겹친 실행이 돌고 있는 턴의 job을 건드리지 못한다. 응답은 계약 스키마로 다시 읽고 job·lease·세대·세션·턴·작업자가 요청과 다르면 받지 않은 것과 같다.
- 결과 확정은 한 트랜잭션이고 다른 lease가 넘겨받았거나 job이 실행 중·`unknown`이 아니면(이미 해제·종료됐거나 `/retry`로 대기열에 돌아감) 어떤 행도 바꾸지 않는다. 해제와 `/retry`는 lease를 바꾸지 않아 lease만으로는 늦은 응답을 가려내지 못한다. 소멸을 확인하지 못하거나 lease를 잃으면 `unknown`이다. 멈춘 턴의 확인에는 `/v1/task/cancel`을 한 번만 보낸다.
- 취소·철회·시간 초과·종료로 취소를 보낸 턴의 실행 응답이 `stopped:false`이면 취소 결과를 기다려(`stopWaitMs` 안) 합친다. 그 턴을 띄운 작업자의 `stopped:true`면 소멸로 확정한다. 중단 신호 없이 온 `unknown` 응답에는 취소를 새로 보내지 않고 `unknown`으로 둔다.
- `/v1/task/cancel`·`status`·`finalize` 응답은 스키마를 통과해도 job·lease·세대·세션이 물어본 값과 다르면 근거로 쓰지 않는다. 재개 전 상태 확인이면 대기열로 되돌리고, 정리면 `cleanup_pending`, 해제면 거부다.
- `/task-release`는 소멸 확인을 읽어 둔 lease·세대의 것으로만 쓴다. 확인 사이 넘어갔으면 풀지 않는다.
- 실행기 구분: `ClaudeTaskBridge`와 `CodexBridge`는 상대 실행기 세션을 가진 작업을 재개·덮어쓰기·해제하지 않고, 그 질문의 답도 받지 않으며, unknown 안내도 넣지 않는다. 작업자가 달라 소멸 확인을 대신할 수 없기 때문이다. 재개 요청은 `task_session_mismatch`로 실패시키고 세션 행은 그대로 둔다. 기한 지난 질문 닫기는 실행기와 무관하게 한다. 프로세스 없는 대기라 의미가 같다.
- **취소 안내.** 작업(`type='task'`)이 `cancelled`로 확정되면 상태를 바꾸는 트랜잭션에서 outbox에 `task-cancelled:<job>` 안내를 넣는다. 저장소의 `complete`·`defer`와 `/cancel`·`/task-cancel` 즉시 취소(대기열·`waiting_user`)가 한 곳(`Store.cancelledNotice`)을 쓴다. `cancelled`는 끝 상태이고(재시도는 `failed`만 받는다) 키가 job마다 하나라 같은 확정을 두 번 처리해도 1건이다. 게시 때 정책 재확인은 다른 안내와 같다. 넣지 않는 경우: 소멸을 확인하지 못한 `unknown`(지금처럼 막힘 안내), 권한 철회(게시도 막힌다), 질문 만료(자기 안내가 있다), `/task-release`(결과를 대화에 게시한다), 대화·조회 job. 상태를 바꾸기 전에 대화 행을 잡아 제어 경로와 같은 잠금 순서를 지킨다. Codex 세션의 작업도 같은 경로라 함께 안내된다.
- 정상 종료 신호: dispatch 전이면 대기열로 되돌리고, 실행 중이면 `drainMs` 뒤 취소해 확인되면 `failed`(`task_shutdown`), 아니면 `unknown`이다. 작업은 자동으로 다시 실행하지 않는다.

**질문.**

- `questionId = taskQuestionId(job, sessionId, turn)`, `codex_questions.thread_id`에는 세션 UUID를 넣는다. 응답 스키마를 통과한 `needs_input`(`stopped:true`)으로만 만든다. 기한 1시간, 답 2,000자다.
- `TaskBridge.answerIn(store, input)`은 호출자가 연 트랜잭션 안에서 답을 처리한다. 수신 경로가 이벤트 처리와 답 쓰기를 한 번에 확정하는 경계다. 인가도 그 연결로 해 같은 대화의 `/revoke`와 대화 행으로 직렬화된다. `answer`는 이것을 자기 트랜잭션으로 감싼다.
- 권한 재확인 지점: 답 수락, 재개 dispatch 직전, 실행 중 감시, 결과 확정 전.
- 한도·인증으로 끊긴 턴이 나르던 답은 `answered`로 되돌려 `/resume-model` 뒤 같은 답으로 잇는다. 대기 사유는 세션의 `wait_reason`(migration 015)에 남는다. `/resume-model`이 `jobs.wait_reason`을 비우기 때문이다.

**수명.** `sweep`이 매 바퀴 하는 일: 기한 지난 질문 닫기, unknown 알림, `/cancel`·철회로 끝난 job의 세션·질문 닫기, 24시간 넘은 모델 대기에 `owner_confirm_requested_at` 표시와 알림 한 번(자동 재개·폐기 없음), 정리 재시도. 정리는 최종 상태를 DB에 남긴 뒤에만 `/v1/task/finalize`로 보내고 먼저 `/v1/task/status`로 identity를 얻는다. 다른 storage의 `absent`·`finalized`는 소멸 증명으로 쓰지 않는다. 실패하면 `cleanup_pending`이고 `finalizeRetryMs`(기본 30초) 뒤 다시 시도한다. 대기 세션의 `cleanupPending`은 세션을 지우지 않고 작업자가 `waiting`이라고 답하면 막힘만 푼다. unknown 해제(`release`)는 작업자의 소멸 확인 뒤에만 `cancelled`로 바꾸고 정리까지 시도하며 다시 실행하지 않는다.

**저장소 identity.** `codex_sessions.worker_storage`는 한 번 알면 그 세대가 끝날 때까지 바뀌지 않는다. status·cancel·finalize·턴 응답의 어떤 경로도 다른 storage로 덮어쓰지 않고, 같은 storage면 `worker_instance`만 파드 교체를 따라간다. 덮어쓰면 다음 재시도에서 새 저장소가 원래 저장소로 보여 그 `absent`만으로 `cleaned`가 되기 때문이다. 다른 storage가 답한 취소·해제 응답은 소멸 증명이 아니라 확인 실패로 보고, 다른 storage의 finalize 응답은 지운 것으로 치지 않는다. storage를 아직 모르는 세션(첫 턴 응답을 잃음)은 세션을 봤다고 답한 작업자에만 묶는다. `absent`·`unknown` 상태나 `sessionRetained:false`인 취소 응답으로는 묶지 않는다. 턴 시작의 재개 CAS는 storage를 조건에 넣고, 새 세대 시작은 앞 세대가 보존·정리 대기면 덮어쓰지 않는다. 정리 결론은 물어본 세대와 세션에만 쓴다.

**한계.**

- 저장소(PVC)가 바뀌면 옛 세션의 정리를 증명할 길이 없어 `cleanup_pending`이 남고 작업 레인이 닫힌 채로 있다. 자동으로 풀지 않는다.
- storage를 한 번도 알지 못한 세션은 작업자가 세션을 받았다는 근거가 없다. 그래서 `absent`여도 작업자의 `/v1/task/finalize` 답을 따른다. 첫 턴 응답을 잃은 바로 그 사이에 PVC까지 바뀐 경우는 구분하지 못한다. 시작 전에 identity를 알 수단이 계약에 없고, 막으면 작업자 단절 뒤 레인이 풀 길 없이 닫힌다.

### T18 작업 레인 조립 (2026-11-05)

**기본은 꺼짐이다.** `TASK_LANE_ENABLED`가 없거나 `false`면 작업 레인 객체를 만들지 않는다. 명령 등록·수신, 루프, 작업 HTTP 클라이언트, 지표 계열이 모두 없고 `taskLoop`·`lanes`도 꺼져 지금과 같다. 작업자 이미지는 사람 PR로만 바뀌고 `WORKER_LANES`가 없으면 대화·리뷰 작업자 그대로다. R08(외부 세션 알림)은 이 조립에 없다. `attach_task`는 작업 레인 능력표에서 `false`이고, 조립 자리는 아래 "R08"이다.

**구성.**

| 파일 | 맡는 것 |
|---|---|
| `src/task-worker.ts` | `TaskWorkerService`(서명·nonce·lease·fence·직렬 슬롯·세대·identity, 네 끝점의 동작), `TaskIntake`(수락 상태), `TaskReceipts`(실행 영수증), `TaskNonces` |
| `src/task-http.ts` | 작업자 라우트와 서버(`taskWorkerServer`), 게시 서버 포트(`HttpTaskWorker`), 무서명 상태 응답 `GET /v1/task/intake` |
| `src/task-policy.ts` | 정책 `task` 절 검사, `PolicyTaskPlans`(`TaskPlanSource`), 기준 SHA |
| `src/task-commands.ts` | Discord 작업 명령과 브리지 사이(`TaskCommands`) |

**작업자(`WORKER_LANES=task`) 기동 순서.** 설정 → `taskImageProblems()` → CLI `--version` → `PodPidSpace.record({ dedicatedTaskPod: true })`(HTTP 열기 전) → `ProcessGroupLauncher([bin], { cleanup: space })`와 전용 `RunControl` → 상태 볼륨(저장소 ID, 영수증, `TaskSessions`) → 수신. 대화·리뷰 끝점은 경로 자체가 없다. 시험은 `cleanup`을 가짜로 주입한다. 개발 기계에서는 `record`가 기준 밖 프로세스를 보고 거부해 `kill(-1)` 수단이 생기지 않는다.

**가용성. 무엇이 무엇을 닫는가.** 작업 파드가 Ready가 아니면 Argo CD root가 sandbox wave에서 멈춰 뒤 단계 플랫폼 적용까지 막힌다. 그래서 재시작으로 풀리지 않는 문제에 재시작을 걸지 않고, 런타임 장애가 Ready를 내리지 않는다.

| 구분 | 사유 | 프로세스 | `/readyz` | `/v1/task` | 제어 끝점 | 풀림 |
|---|---|---|---|---|---|---|
| 설정 오류 | env 누락·형식, 개인 경로, 프로필 | 종료 코드 1 | 없음 | 없음 | 없음 | 차트 PR |
| 기동 검사 | `bwrap_missing`·`socat_missing`·`git_missing`·`managed_settings_present`·`executor_version_*`·`pid_*`·`run_control_unavailable` | 유지 | 503 | 503 | 정리 수단이 있으면 동작, 없으면 `stopped:false`·`unknown` | 이미지 교체 |
| 런타임 | `nonce_write_failed`·`receipt_write_failed`·`volume_unwritable`·`volume_low`(여유 32MiB 미만)·`credential_unavailable` | 유지 | 200 | 503 | 동작 | 30초 주기 확인이 저절로 연다 |
| 볼륨 미확립 | `state_unavailable`(저장소 ID를 아직 읽지 못함) | 유지 | 200 | 503 | 503 | 같음 |

사유는 값 없는 상수이고 로그(`task_intake_closed`·`task_intake_recovered`), `GET /v1/task/intake`, 게시 서버 `/metrics`로 보인다.

**nonce 기록 실패와 제어.** 실행은 영속 기록이 되어야만 받는다. 취소·상태·정리는 기록을 못 쓰면 메모리로 받는다. 볼륨이 찼을 때 정리까지 막으면 공간을 비울 길이 없어 레인이 스스로 풀리지 못한다. 대가는 볼륨 장애와 컨테이너 재시작이 겹칠 때 수명 30초 안의 제어 capability를 다시 쓸 수 있다는 것이다. 제어는 본문 digest에 묶여 같은 일을 또 할 뿐이다.

**라우트 순서.** capability 없음 401(본문을 읽기 전) → 본문 상한·스키마 400 → (`/v1/task`만) 종료 중 403·수락 닫힘 503 → 서명·nonce 403(`/v1/task`의 기록 실패는 503) → identity 불일치 409 → (`/v1/task`만) 슬롯·fence 409. 거부 본문은 모두 `TaskRejectionSchema`다. 게시 서버는 400·401·403·409와 연결 전 실패만 미시작으로 본다. **503은 미시작의 증거로 세지 않는다**(B1 계약). 응답 불명과 같게 취소로 확인하고, 작업자가 멈춤을 답하면 `task_worker_lost` 실패, 아니면 `unknown`이다. 그래서 게시 서버는 먼저 `/v1/task/intake`를 보고 닫혀 있으면 새 접수와 claim을 멈춘다.

**fence.** nonce는 재생 방지이고 실행 멱등은 `.homelab-worker/receipts/<job>.json`이 맡는다. 실행 전에 기록하고, 못 쓰면 실행하지 않는다. 재시작 뒤에도 거부하는 것: 지난 세대, 같은 세대의 첫 턴 재전송, 지난 턴, 취소·정리된 세대의 늦은 요청. 취소는 세대를 막지만 옛 lease의 취소는 지금 턴을 건드리지 않는다. 기록은 1시간이 지나고 세션 공간도 없으면 지운다. 그때 발급된 capability는 모두 만료다.

**정리 호출.** `kill(-1)`은 파드 전체를 향한다. 다른 job의 턴이 도는 동안에는 부르지 않고 직렬 1을 근거로 답한다(소멸 미확인 job이 있으면 실행을 받지 않으므로 다른 턴이 돌면 그 job의 프로세스는 없다). 정리가 도는 동안에는 실행을 받지 않는다. 턴 준비 중의 git이 함께 죽기 때문이다.

**게시 서버 조립.** 정적 조건(스위치·주소·유효한 `task` 절)이 맞으면 `ClaudeTaskBridge`와 별도 루프 `runtime.tickTask()`를 만들고 `taskLoop`·`lanes`를 함께 켠다. 절이 없거나 틀리면 작업 레인만 닫고 대화·리뷰는 그대로 뜬다. 30초마다 `/v1/task/intake`를 물어 **작업 모드 작업자가 답한 뒤에** 명령을 연다. 옛 이미지·대화 작업자는 404라, 거기 실행을 보내 응답 불명으로 레인을 닫는 일을 막는다. 한 번 열면 닫지 않는다. 수락이 닫혀 있으면 claim만 멈추고 `sweep`(정리 재시도·질문 만료)은 계속한다.

**명령.** owner·허용 채널·스레드 소유 검사는 기존 수신 경로 그대로다.

| 명령 | 옵션 | 처리 |
|---|---|---|
| `/task` | `project`, `text` | 정책에 프로젝트가 없거나 레인·작업자 수락이 닫혔으면 안내만 하고 스레드·작업을 만들지 않는다. 그 뒤 닫히면 `accept`의 `LaneClosed`를 받아 같은 안내를 낸다. 스레드를 만든 뒤면 그 스레드에 남긴다 |
| `/answer` | `question`, `text`(2,000자) | 수신 `store.atomic` 안, `ownedConversation` 잠금 뒤 `answerIn`. 이벤트 처리와 답 쓰기를 한 번에 확정한다 |
| `/task-status` | `target` | 트랜잭션 밖. 이 대화의 작업만 |
| `/task-cancel` | `target` | `/cancel`과 같은 경로이고 작업 레인 작업만 |
| `/task-release` | `target` | 먼저 답하고 작업자 소멸 확인 결과를 대화에 게시한다. Gateway 이벤트 순서를 막으면 뒤 상호작용이 3초 기한을 놓친다 |

**기준 SHA.** 프로젝트 정책의 `branch`면 작업 시작 때 `GET https://api.github.com/repos/<repo>/commits/<branch>`(sha 미디어 타입)를 **자격 없이** 읽는다. `base`면 그 고정 SHA를 쓰고 GitHub에 묻지 않는다. 이유: 작업자가 같은 저장소를 자격 없이 codeload로 받으므로 익명으로 안 보이는 저장소는 어차피 시작할 수 없고, 리뷰 App 토큰을 작업 레인에 끌어오면 리뷰 조건에 묶인다. 게시 서버의 기존 인터넷 443 egress 안이다. 익명 한도(IP당 시간 60회)에 걸리거나 닿지 않으면 그 작업만 실패하고 `/retry`한다. 브리지가 재개 때 세션의 SHA와 대조하므로 대기 세션은 세션의 값을 돌려준다. `/retry`는 새 세대가 그때의 머리에서 시작한다.

**정책 키.** `task.projects[]`: `id`, `revision`, `repository`, `branch` 또는 `base`, `allowedPaths`, `forbiddenPaths`, `verifyCommands`, `limits`(선택, `TaskRunLimitsSchema` 상한 안). 값은 Infisical에만 둔다. `task` 키는 이 코드 이전의 게시 서버가 거부하므로(strict) 코드 배포 뒤에 넣는다.

**설정 키.** 게시 서버: `TASK_LANE_ENABLED`(`true`·`false`만), `TASK_WORKER_URL`(켰을 때 필수, http, 경로 `/`). 작업자: `WORKER_LANES`(미설정·`chat,review`·`task`), `TASK_STATE_ROOT`, `WORKER_NONCE_DIR`(`<TASK_STATE_ROOT>/.homelab-worker` 아래. 밖이면 샌드박스가 가리지 않아 기동 오류).

**지표(작업 레인을 조립했을 때만).** `homelab_bot_lane_jobs{lane,state}`, `homelab_bot_task_lane_closed{reason}`, `homelab_bot_task_cleanup_pending`, `homelab_bot_task_sessions_retained`, `homelab_bot_task_worker_routed`, `homelab_bot_task_worker_intake_open`.

**켜는 순서.**

1. **봇 병합(지금).** 게시 서버 자동 배포. 스위치 꺼짐이라 변화 없음.
2. **H2.** 이 코드가 든 digest로 `task.image`를 고정하고 `task.enabled:true`. `WORKER_LANES=task`·`TASK_STATE_ROOT=/worker-state`는 차트가 넣는다. 사람 토큰 등록 → ES 준비 → 파드 순서다.
3. **무모델 확인.** `/readyz` 200, `GET /v1/task/intake`의 `open:true`, 사유 없음. 모델을 부르지 않는다.
4. **H4.** `RUNTIME_POLICIES`에 `task` 절을 넣고 `TASK_LANE_ENABLED=true`, `TASK_WORKER_URL=http://worker-task.sandbox:8080`. 첫 시험 프로젝트는 승인된 범위로 묶고(`base` 고정 권장), live 시험은 그 승인 뒤다.

되돌리기는 `TASK_LANE_ENABLED`를 끈 게시 서버 배포가 먼저다. 실행 중 턴은 드레인·취소 확인을 거치고, 못 하면 `unknown`이다. 켠 채 작업자를 옛 이미지로 내리지 않는다.

**R08(B5b).** 수신 경로가 정해지면 `main.ts`의 `receivers` 라우트, `commands.ts`의 별도 명령 목록, `DiscordIngress` 처리기 인자, `CLAUDE_TASK_LANE_CAPABILITIES`와 별개의 연결 능력표에 더한다. 작업 레인 스위치와 묶지 않는다.

## 13. 개선안 v2 적용 (2026-10-30)

출처: [IMPROVEMENTS_V2.md](IMPROVEMENTS_V2.md)(사용자 개선안)를 코드와 대조해 게시 서버 쪽만 바꿨다. 항목별 판정은 그 문서 끝 "적용 상태"에 있다. 작업자 HTTP v1 계약(`WorkerRequestSchema`·`SYSTEM_INSTRUCTIONS`·`AnswerSchema`)과 작업자 파일은 아래 "봇 답 문맥"의 `chatPrompt` 설명 문구 하나만 바꿨다. 실행기 전환 작업(§12 "T16b 실행기 프로필")과 겹치지 않게 했고, 그 작업이 먼저 main에 들어와 이 브랜치에 합쳤다(작업자 파일은 이제 `src/chat-lane.ts`·`src/executor*.ts`·`src/credentials.ts`·`src/process-launcher.ts`·`src/worker*.ts`). 게시 서버(자동 배포)와 작업자(사람 배포)가 따로 배포돼도 맞게 하기 위해서다.

### read 레인

- 모델 claim(`Store.claim()`)은 `type<>'read'`만 고르고, 막힘 조건(실행 중·`unknown`·`waiting_user`)에서도 read를 세지 않는다.
- read는 `Store.claimRead()`가 `controls.read_lane` 행 아래에서 잡는다. 전체 게시 서버에서 동시 1개다. 대화 행·scheduler 행은 잡지 않고 job은 `SKIP LOCKED`라 기존 잠금 순서(대화 → scheduler → job)를 거꾸로 잡는 경로가 없다.
- read는 모델 슬롯·scheduler 정지(한도·인증 대기, 비상 중지)·`unknown`에 막히지 않는다. `/emergency-stop`은 "모델 호출" 중지라 실행 중 read를 취소하지 않는다. 구독 중지·gap·owner·권한 철회·서비스 정책은 모델과 같이 지킨다.
- 실행은 `src/read-runtime.ts`의 `ReadRuntime`(`Runtime.tickRead()`)이 별도 루프(`read`, 생존 근거)에서 한다. 순서·오류 처리는 이전 read 분기와 같다. 모델 `tick()`이 read를 받으면(구버전 claim 등) 같은 경로로 처리한다.
- lease가 끝난 read는 `unknown`이 아니라 `failed`(`lease_expired`) + 안내다. read에는 외부 쓰기가 없어 불확실성이 아니다. 구버전이 남긴 `unknown` read도 같은 이유로 정리한다. owner가 `/cancel`한 read는 `cancelled`.
- 대기열 상한 100건 중 read 몫 10건: 모델 계열(chat·task·review)은 read가 아닌 queued가 90건 미만일 때만 받는다. `/resume-model`·`/review-resume`도 같은 모델 상한이다(`Store.queueFull(type)`). `/retry`는 대상 작업의 실제 종류로 센다. 실패한 read의 재시도는 전체 상한만 보므로 모델이 정체해도 조회를 다시 돌 수 있다(Codex 리뷰 지적).
- 같은 대화 안에서 뒤에 요청한 read 답이 앞선 긴 chat 답보다 먼저 게시될 수 있다(대화 안 job 순서 계약은 없다).
- **받아들인 전환기 동작:** 배포 중 구버전(scheduler 행만 잠금)과 신버전(read_lane 행만 잠금)이 겹치는 몇 초 동안은 서로 다른 read 두 개가 동시에 돌 수 있다. 같은 job의 이중 실행은 아니고 read는 읽기 전용이라 받아들였다(독립 리뷰 지적, 2026-10-30).

### 정상 종료 (SIGTERM)

- `stop()` 첫 줄의 종료 신호가 runtime 종료 신호다. 신호 뒤에는 claim하지 않는다. 신호 전에 시작한 claim이 늦게 돌아오거나 dispatch 직전이면 `defer(job,'publisher_shutdown')`(attempt 소모 없음).
- 실행 중이면 드레인 10초(`DRAIN_MS`) 안의 자연 완료를 기다린다. 넘으면 **그 자리에서** 작업자 cancel(서명 capability)을 보내고 abort한다. 진행 중이던 인가 검사·상태 조회는 그 뒤에 끝나 최종 판정에 합친다. cancel 송신이 DB 지연을 기다리지 않게 하려는 것이다(독립 리뷰 지적).
  - 확인된 **chat**은 queued로 되돌린다(`publisher_shutdown`, `available_at=now`, attempt는 소모된 채). 새 게시 서버가 이어서 실행해 owner가 `/retry` 없이 답을 받는다. attempt가 상한(`maxRetries+1`)이면 `fail`.
  - 확인된 **task·review**는 외부 효과가 있을 수 있어 자동 재실행하지 않고 `fail(stop_confirmation)`.
  - 확인 실패는 `unknown`(`publisher_shutdown`). owner가 이미 `/cancel`했으면 `cancelled`.
  - 감사 `publisher_shutdown`(`outcome`: deferred·requeued·failed·unknown·stale).
- 전체 기한 하나(`stopTimeoutMs` 기본 20초)에서 남은 시간을 나눈다. Gateway 정지·수신 서버 닫기는 드레인·cancel과 동시에 돈다. 최악 약 23초(기한 20초 + k8s close 1초 + pool.end 2초)라 kubelet 종료 유예 30초를 바꾸지 않는다.
- 문서 제안(60초 대화를 끝까지 기다리고 유예 90초)과 다르게 한 이유: 끊기기 전에 작업자가 아직 job을 잡고 있을 때 취소를 확인해야 `unknown`이 남지 않는다. 비용은 드레인을 넘긴 chat의 모델 실행 한 번 더(attempt 하나)다.
- 이 변경이 처음 배포될 때 종료되는 구 파드는 구 코드의 종료 동작을 쓴다. 효과는 그다음 배포부터다.

### 불확실한 결과와 chat unknown

- 실행 대기가 `stopped:false`로 끝나면(불확실 응답 `worker_disconnected`, 실행 중 예외 `runtime_uncertain`, monitor abort, 시간 초과, 드레인) 인가 재검사·상태 조회 같은 DB 후처리 **전에** 그 자리에서 cancel을 보낸다. 한 실행에 cancel은 한 번이고(정상 판정·예외 처리가 같은 결과를 쓴다, 실패·오류 포함) 최종 상태는 공통 판정이다: 권한 철회면 확인 시 `cancelled`, 드레인이면 확인된 chat은 되돌리기, owner `/cancel`이면 `cancelled`, 그 밖은 확인 시 `fail(stop_confirmation)`(실패 안내 → `/retry`). 확인 실패는 모두 `unknown`. 작업자에 보내기 전 오류와 작업자가 받지 않은 요청(`WorkerRejected`)은 cancel하지 않는다.
- **확인된 멈춤은 거짓 `unknown`이 되지 않는다.** 확인 결과를 상태 쓰기 전에 보존하고, 뒤의 기록(fail·되돌리기·취소)이 일시 오류로 실패하면 cancel을 다시 묻지 않고 lease CAS 아래 최대 3번(200ms·400ms 간격) 다시 쓴다. 끝내 못 쓰면 로그·감사 `stop_confirmed_write_failed`를 남긴다. 그 뒤 lease가 끝나면 `expire()`가 `unknown`으로 두므로, 이 감사가 실제로 멈췄다는 근거다.
- chat·review `unknown`은 모델 `tick()`의 claim 직전에 주기적으로 조사한다(`Runtime.probeUnknown()`, review는 #42에서 넓힘). 이런 unknown이 있으면 모델 claim이 어차피 막혀 있어 모델 실행을 늦추지 않는다.
  - 예약은 `controls` 행 `unknown_probe:<job>`(`{lease,count,next}`)이고 마이그레이션은 없다. 행을 잠그고 시각이 된 것만 미뤄 돌려주므로 게시 서버 둘이 같은 job을 동시에 조사하지 않는다. backoff 즉시 → 30초 → 1분 → … → 상한 10분, 한 바퀴 3건.
  - 저장된 job ID·lease로 새 cancel capability를 만들어 DB 트랜잭션 밖에서 보낸다. 확인되면 짧은 트랜잭션의 CAS(`type IN ('chat','review') AND state='unknown' AND lease_token=<관측값>`)로 `failed`(`stop_confirmed_after_unknown`) + 감사 `unknown_stop_confirmed`. chat은 Discord 안내를 더한다. review는 Discord 안내 없이 밀려나지 않은 세대의 `pr_reviews.review_outcome`을 `failed`로 둔다(리뷰 job에는 게시할 Discord 채널이 없다). 이 쓰기가 일시 DB 오류로 실패하면 확인 결과를 유지한 채 쓰기만 재시도한다(정상 종료의 `afterStop`과 같음). 작업자는 첫 확인 뒤 job을 놓아, 다음 조사의 cancel은 소멸을 다시 확인하지 못하면 `stopped:false`다. 그래서 확인을 버리면 풀리지 않는 unknown이 모델 슬롯을 막을 수 있다(Codex 리뷰 지적).
  - 경과 시간만으로 풀지 않는다. 새 모델 실행을 자동으로 시작하지 않는다. task는 조사하지 않는다(작업 레인 소멸 확인 한계, §12). review는 도구 없는 단일 프로세스 그룹이고 작업자가 표식으로 소멸을 확인하므로 조사한다(#42). `/review-cancel`은 review `unknown`을 풀지 않고 이유만 답한다. 제어 명령은 DB 트랜잭션 안이라 작업자에게 물을 수 없고, 확인 없이 풀면 살아 있는 프로세스 옆에서 다음 작업이 돈다.
- **작업자 답(#42, `ExecutionSlot.cancel`, `src/worker.ts`):** 대화·리뷰가 같은 실행 자리를 쓴다.
  - 그 job·lease를 잡고 있으면 멈추고 소멸을 확인해 답한다.
  - 리뷰 레인은 마지막으로 끝낸 job·lease의 cancel에도 `stopped:true`다.
  - 잡고 있지 않은 job(응답 유실, 작업자 재시작·OOM 뒤)은 표식 프로세스를 정리하고 남은 프로세스 0개를 확인하면 `stopped:true`다. 그렇게 답한 job·lease의 늦은 실행 요청은 시작하지 않는다.
  - 다른 job이 자리를 잡고 있으면 `stopped:false`다.
- **한계:** 이 답은 작업자가 하나일 때만 믿을 수 있다(작업자 Recreate·`replicas: 1`, capability 30초 만료). 다른 파드의 실행은 볼 수 없다. 파드에서 실제로 `stopped:true`가 나오는지는 [미확인]이다. NUC에서 실제 launcher로 돌렸을 때는 같은 UID의 다른 프로세스 env를 읽지 못해 안전 쪽(`stopped:false`)으로 닫혔다(PR #42 본문). 그때는 unknown이 풀리지 않고 슬롯을 계속 막는다.

### 상태 안내 (멘션 없음)

| 상황 | 멱등 키 | 내용 |
|---|---|---|
| chat `waiting_user` | `waiting:<job>:<attempt>` | 모델 사용 한도/인증 만료, `/resume-model target:<job>`, `/model-status` |
| chat `unknown`(runtime 경로·lease 만료) | `unknown:<job>:<attempt>` | 종료 미확인으로 새 모델 실행 정지, 봇이 확인을 계속 시도, `/model-status` |
| chat unknown 해소 | `unknown-resolved:<job>:<attempt>` | 멈춤 확인, `/retry target:<job>` |
| read lease 만료 | `read-expired:<job>:<attempt>` | `/read`로 다시 요청 |

권한 철회로 생긴 unknown은 안내하지 않는다(게시도 막힌다). 모두 `safe_summary`, `allowed_mentions.parse=[]`다. owner를 부르는 개입 알림(개선안 5-3)은 아직 넣지 않았다.

### 수신·진행 신호

- 일반 메시지의 수신 ACK는 텍스트 메시지 대신 원문에 👀 리액션(`PUT .../reactions/%F0%9F%91%80/@me`)이다. 이전에는 메시지마다 "수신·처리 기록 저장됨…"을 게시해 대화가 덮였다.
- 리액션이 403/404(채널에 Add Reactions·Read Message History 없음 등)면 기존 텍스트 ACK로 한 번 대체하고 감사 `ack_reaction_fallback`을 남긴다. 429는 rate limit만 기록하고 대체하지 않는다. 상호작용(slash·버튼)은 ephemeral 응답 그대로다.
- ACK 단계의 오류(실패를 기록하는 DB 쓰기 포함)는 `receive()` 밖으로 나가지 않는다(`ack_failure_unrecorded` 로그). 나가면 `guard()`가 그 대화에 history gap 장벽을 세운다.
- 모델이 running인 chat의 채널(구독 켜짐·gap 아님·owner 일치)에 8초마다 `POST /channels/{id}/typing`(Discord 표시 10초)을 보낸다(`src/activity.ts`, 루프 `typing`, 생존 근거 아님). rate limit pause·정책 거부면 건너뛰고, 429는 채널 pause로 기록하며, 실패는 다음 주기에 다시 본다. 종료 신호를 받으면 진행 중인 바퀴도 대기 뒤·전송 직전에 멈추고, 전송 직전에 그 채널의 running chat이 아직 있는지 다시 확인한다.

### 입력 중 디바운스

- 일반 chat 디바운스 2초. owner의 `TYPING_START`(10초 안, 정책 owner·guild, 활성·gap 아닌 대화, 정책 재인가)는 그 대화의 queued·비긴급 chat을 `now+8초`로 늦추되 작업 생성 + 15초를 넘기지 않는다. 앞당기지 않는다(`src/typing.ts`, 한 UPDATE의 `state='queued'` CAS).
- 새 메시지가 오면 기존 대체 로직이 앞 작업을 superseded로 바꾸고 새 작업의 15초 상한이 다시 시작된다. 그래서 owner가 메시지를 계속 보내는 동안에만 늘어난다. `/urgent`·read·task·running은 영향이 없다.
- Gateway dispatch는 힌트를 **기다리지 않는다**(이벤트를 하나씩 처리하므로 기다리면 뒤의 메시지·상호작용의 3초 응답 기한이 밀린다). 백그라운드(종료 때 `stop()`이 기다리는 집합)에서 처리하고, 같은 채널 힌트가 처리 중이면 새 힌트는 버린다. 처리 전체에 1500ms 기한(트랜잭션 statement·transaction·lock timeout)을 두고, 넘으면 `typing_hint_expired` 로그만 남긴다. 판단은 **받은 시각** 기준이다: 미룸 목표 `받은 시각+8초`, 대상은 `created_at < 받은 시각`인 작업만이라 늦게 끝난 힌트가 뒤 메시지의 작업을 늘리지 않는다(같은 ms는 앞뒤를 가릴 수 없어 제외, 힌트는 잃어도 된다). 종료 신호 뒤에는 새 힌트를 등록하지 않고, 이미 등록된 힌트도 연결을 얻은 뒤 종료면 업무 질의 없이 끝난다(종료 뒤 늦게 dispatch된 힌트가 `stop()`이 기다리는 집합 밖에서 DB를 쓰지 않게).
- typing은 잃어도 되는 힌트다. 처리 오류는 `typing_hint_failed` 로그만 남기고 history gap 장벽을 세우지 않는다. 재연결 뒤 지난 힌트를 복원하지 않는다. 구 파드(intents 33281)와 함께 도는 동안은 미룸이 반쯤만 동작한다(해 없음).

### 대화 답 형식 (출력 스키마는 그대로)

- 이전에는 네 배열을 섹션당 350자 예산으로 줄여, 첫 항목이 325자를 넘으면 그 섹션이 "(1개 생략)"만 남았다(항목은 최대 500자). 빈 섹션도 "없음"으로 네 줄을 채웠다.
- 지금(`src/chat-format.ts`): 사실 → 가설 → 미확인 → 권장 확인 순서, 빈 섹션 생략, 모든 항목을 그대로 싣는다(스키마가 8/4/8/4개 × 500자로 묶는다). 사실 한 개뿐이면 라벨 없이 그 문장(JSON으로 읽히면 라벨 유지: 게시 표식이 JSON 본문을 다시 감싸기 때문). 모두 비면 결정적 안내. 긴 답은 기존 1800자 페이지 분할(최악 약 7개 메시지).
- read 요약(`summaryItems`)은 그대로다. `reply/risks/details/noReply` 스키마와 "자세히" 버튼은 작업자 출력 계약과 같이 정한다.

### 봇 답 문맥 (`untrusted`)

- `Store.context()` → `chatContext()`(`src/chat-context.ts`). owner 항목은 이벤트 payload에서 `text`·`kind`(명령이면 `command`·`target`)만 고른 `{from:'owner', ...}`, 봇 항목은 `{from:'bot', text, partial?}`.
- **수집 경로 표시는 넘기지 않는다(S16 수정).** 이전에는 payload 전체(`mention`·`activate`·`urgent`·`revision`)를 넣어, 모델이 구독 스레드의 멘션 없는 후속에 "mention=false라 봇에게 한 말이 아닐 수 있다, 멘션하라"고 답했다. 이 값들은 수신 라우팅에서 이미 쓰였고 모델 판단에 필요 없다. 게시 서버 쪽 변경이라 작업자 배포와 무관하게 바로 적용된다.
- 봇 항목은 같은 대화·owner의 **chat 결과 중 Discord 게시가 확정된(sent) 본문**만이다. 현재 입력보다 먼저 게시된 것만 넣는다(owner 메시지 ID와 게시 메시지 ID, 둘 다 snowflake로 비교. 불확실하면 뺀다). 일부 페이지만 sent면 `partial`. read·task·실패 안내·제어·스레드·경보는 넣지 않는다.
- 전체 20개(작업자 스키마 상한)·배열 JSON 32KiB(라벨 포함). 현재 owner 메시지는 항상 마지막, 다음은 직전 봇 답, 나머지는 최신부터 채우고 처음 넘치는 곳에서 멈춘다. 넘치는 봇 답은 앞 페이지만 `partial`로 넣는다.
- **받아들인 예외:** 현재 메시지 하나가 32KiB를 넘으면(입력 8000자 상한 안에서 제어 문자 등 JSON 이스케이프가 큰 극단 입력, 최대 약 48KB) 그것만 넣는다. 작업자 본문 상한 64KiB 안이고, 이전 코드는 이때 빈 문맥을 보냈다.
- **작업자 프롬프트:** `chatPrompt`(`src/chat-lane.ts`, 실행기 전환이 `src/codex-chat.ts`에서 옮김)가 이 배열을 "owner(`from:'owner'`) 메시지와 봇이 이미 게시한 답(`from:'bot'`, `partial`이면 일부)"으로 설명한다. 작업자는 사람 배포라 sandbox 이미지를 바꾸기 전까지 옛 작업자는 같은 배열을 "owner 메시지 기록"이라 부른다(항목의 `from`이 스스로 설명해 받아들인 전환기). 되돌리려면 `Store.context()`만 owner 전용으로 바꾸면 된다(DB 변경 없음).
- **신뢰 문맥(S16 수정):** `chatPrompt`가 지시문 다음, 대화 기록 앞에 `botFacts()`(`src/bot-facts.ts`)를 넣는다. 내용은 코드 고정값뿐이다: 구독 스레드에서 멘션 없이 보낸 owner 메시지도 봇에게 한 말이고 기록의 owner 메시지는 모두 받아들인 요청이라는 설명, 이 봇 자신의 slash 명령(`COMMAND_DEFINITIONS`의 이름·옵션·한 줄 설명), 서비스 카탈로그 공개 값(`SERVICES`의 id·namespace·deployment와 그 서비스의 `/read` 템플릿 ID). 대화 기록에서 만들지 않으므로 신뢰/비신뢰 경계는 그대로다. S16에서 모델이 `/revoke`를 "플랫폼 관리 콘솔 명령"으로, namespace를 `homelab-bot`으로 짐작했다(실제 `app-homelab-bot`). 작업자 HTTP v1 계약(`instructions` 리터럴·`untrusted` 배열)은 바꾸지 않아 옛 작업자도 새 요청을 받는다. 대신 신뢰 문맥은 **작업자 이미지를 다시 배포해야** 모델에 닿는다(작업자는 사람 배포).

### 지표 (`/metrics`, DB gauge)

- 기존 3개는 그대로. 더한 것: `homelab_bot_jobs{type,state}`(비종결 6상태 × chat·task·read·review, 0 포함), `homelab_bot_conversation_gaps`, `homelab_bot_outbox{state}`(pending·sending·unknown·blocked), `homelab_bot_scheduler_paused`, `homelab_bot_emergency_stop`, `homelab_bot_gateway_halted`(fatal close로 다시 연결하지 않는 상태, 첫 연결 fatal 포함).
- 라벨은 코드의 고정 목록에서만 만든다(ID·본문 없음). 쿼리는 상수 3번이다. readiness 정의는 바꾸지 않았다(Gateway 장애에도 Ready).
- RollingUpdate 동안 두 파드가 같은 DB 값을 낸다. 경보 룰은 `max()`로 묶는다(sum 금지). 스크레이프·룰·Telegram 경로는 플랫폼 D7 후속이다.

### 잠금 순서 보강

한 번의 만료 처리(`expire()`)는 기준 시각 하나로 **후보 job ID를 먼저 정하고**, 그 대화 행을 id 순으로 `FOR KEY SHARE` 잠근 뒤 `id=ANY(후보)`에 한해 만료 조건을 다시 확인해 바꾼다. 선잠금 뒤 새로 만료된 job은 다음 바퀴가 처리한다(선잠금과 UPDATE의 시각이 달라 잠그지 않은 대화의 job이 끼어들던 문제, 독립 리뷰 지적).

상태 안내를 outbox에 넣으면 외래 키로 대화 행 KEY SHARE를 잡는다. job·scheduler 행을 쥔 뒤 대화 행을 기다리면 제어 경로(대화 행 FOR UPDATE → scheduler → job)와 교착한다(실제 PostgreSQL에서 3건 모두 lock timeout으로 재현). 그래서 상태를 바꾸기 전에 대화 행을 `FOR KEY SHARE`로 먼저 잡는다: `transition(unknown)`, `waitForUser`(scheduler보다 먼저), `expire`(대상 대화를 id 순서로), `resolveUnknown`, 기존 `fail()`. `fail()`은 원래 job → outbox 순서였는데 종료 경로가 이 경로를 더 자주 타게 돼 함께 고쳤다.

## 14. 운영 세부(README에서 옮김)

README에 있던 운영 세부 중 §1~13과 다른 `docs/ai-bot/` 문서에 없던 내용을 문장 그대로 옮겼다. 옮기면서 사실을 고치지 않았다. 앞 절이나 지금 코드와 다르면 앞 절과 코드가 기준이다.

### 시험 환경

시험은 외부 Discord·GitHub·플랫폼·모델에 연결하지 않는다. PostgreSQL 엔진인 PGlite와 임시 디스크 DB, loopback HTTP 서버, 주입한 Gateway/REST·관측·모델 모의를 쓴다.
시험 데이터는 합성 값이다. 임시 파일은 무시되는 `.local/` 안에서 만들고 지운다.
패키지 설치 외 네트워크는 필요하지 않다.

### 게시 서버 실행

```sh
npm run build
node dist/src/migrate-main.js   # DATABASE_URL만 필요. 적용된 버전은 건너뛴다
node dist/src/main.js           # 게시 서버. 8080(/readyz·/metrics·/github), 8081(/alerts)
```

- 비밀 env(Infisical `/apps/homelab-bot/`): `DATABASE_URL`(차트가 넣음), `DISCORD_BOT_TOKEN`, `RUNTIME_POLICIES`, `GRAFANA_READER_TOKEN`, `HEALTHCHECKS_PING_URL`, `WORKER_CONTROL_PRIVATE_KEY`(Ed25519 PKCS8 PEM), `GITHUB_REVIEW_WEBHOOK_SECRET`(16자 이상).
- 주소 env(차트 values, 기본값 없음): `WORKER_URL`(http, 경로 `/`), `GRAFANA_URL`, `KUBERNETES_API_URL`(https). 차트가 넣는 `PORT`가 있으면 8080이어야 한다.
- 로컬에서 실제 Discord·플랫폼에 붙이지 않는다. 진입점 시험은 `test/publisher-*.test.ts`(가짜 Gateway·REST·HTTP)다.

### 작업자 실행

```sh
npm run build
# Claude 프로필(claude-subscription)
WORKER_EXECUTOR=claude WORKER_MODEL=claude-opus-5-5 \
WORKER_CREDENTIAL_DIR=/run/worker-credential WORKER_CREDENTIAL_KEY=CLAUDE_CODE_OAUTH_TOKEN \
WORKER_NONCE_DIR=/worker-state/.homelab-worker/nonces \
WORKER_CONTROL_PUBLIC_KEY="$(cat worker-control.pub.pem)" \
node dist/src/worker-main.js

# Codex 프로필(codex-subscription): 실행기·자격 키·모델과 CODEX_HOME만 다르다
WORKER_EXECUTOR=codex WORKER_MODEL=cli-default WORKER_CREDENTIAL_KEY=CODEX_AUTH_JSON CODEX_HOME=/codex-home ...
```

로컬에서 돌려 볼 때도 빈 임시 디렉터리와 봇 전용 자격만 쓴다.

### 이미지 빌드

이미지는 `docker build --target test .`(시험 단계)와 `docker build .`(최종)로 만든다. CI는 homelab `app-build`가 같은 두 빌드를 돈다.

### 버전 고정

직접 의존성과 개발 도구는 `package.json`, 전이 의존성은 `package-lock.json`에 정확히 고정했다.
설치 시 npm registry의 stable version을 확인했다.

- Node **24.22.0**: 최신 major보다 낮게 고정. DISCOVERY에서 정한 Node 24 대안과 현재 로컬 검증 환경을 유지한다. Bun의 재연결 위험을 FOUNDATION 로직과 분리하려는 선택이다. 런타임 major 변경은 T16b 연동 검증 뒤 한다.
- npm **11.19.1**: 현재 Node 24 환경의 설치 도구를 고정했다. 최신 npm 12로 바꾸는 것은 런타임 major와 함께 검증한다.
- TypeScript **7.0.2**, pg **8.23.1**, zod **4.6.7**, PGlite **0.5.10**, @types/node **24.19.2**, @types/pg **8.23.1**, @openai/codex **0.163.0**, @anthropic-ai/claude-code **2.1.308**(npm `stable` 태그, 2026-10-30 조회), undici **7.30.1**. Node 타입은 최신 24.x로 런타임 범위에 맞춘다. undici는 최신 7.x로 Node 24 내장 fetch와 호환한다. 8.x Agent는 내장 fetch와 `invalid onRequestStart method` 오류가 발생해 제외했다.

### 연결 지점

| 모듈 | 책임 |
|---|---|
| `src/database.ts`, `src/store.ts`, `migrations/001_foundation.sql` | PostgreSQL 트랜잭션, inbox·jobs·outbox·대화·예약 기반, lease·fencing·재시작 |
| `src/policy.ts` | env `RUNTIME_POLICIES`를 기동 때 한 번 읽기(D1), owner·scope 검사, 영속 즉시 거부 목록 |
| `src/discord.ts`, `src/discord-protocol.ts` | Gateway payload 정규화, 명령·버튼, 1440분 공개 스레드, ACK·REST·대조 |
| `src/read.ts` | 등록 서비스와 승인 템플릿, namespace·시간·행·바이트 제한, 현재 근거와 미확인 구분 |
| `src/worker.ts`, `src/worker-http.ts`, `src/runtime.ts` | 서명 capability, 포트 8080 HTTP 계약, 두 레인 합산 직렬 1, 취소·한도·unknown |
| `src/alerts.ts`, `src/health.ts`, `src/http.ts` | Alertmanager 사건 요약, 8080/8081 수신기, readiness·Gateway 지표·조건부 하트비트 |
| `src/main.ts`, `src/config.ts`, `src/log.ts` | 게시 서버 진입점(T16b): env 설정, pg Pool, 수신기·루프·Gateway 조립, SIGTERM 정리 |
| `src/migrate-main.ts` | 마이그레이션 진입점(차트 `migration.command`), advisory lock |
| `src/gateway.ts`, `src/commands.ts` | Gateway 세션(IDENTIFY·heartbeat·RESUME·재연결·예산), FOUNDATION slash 명령 등록 |
| `src/read-transports.ts`, `src/catalog.ts` | Grafana·Kubernetes API(Argo CD Application CR 포함) 읽기 transport와 응답 투영, 서비스·질의 템플릿 |

외부 SDK와 인증은 주입 경계다. `DiscordProtocol.gateway()`에 인증된 Gateway frame을 전달하고, REST는 `discordHttpApi(token, fetch)`를 주입한다. 직접 호출하지 않는 한 네트워크를 열지 않는다. `receivers()`·`workerServer()`도 반환만 하며 호출자가 명시적으로 listen해야 한다.

### 마이그레이션 실행

`Postgres`에는 전용 DB/역할의 `pg.Pool`을 주입한다. `migrate()`는 `schema_migrations`에 기록된 버전을 건너뛴다(T16b).
운영 마이그레이션은 Sync hook Job이 `node dist/src/migrate-main.js`로 매 sync마다 실행한다.
후속 티켓도 기존 파일을 변경하지 않고 expand/contract 후속 파일을 추가한다.

### 사용 계약 보충

`/read text:<template-id> target:<service-id>`는 승인 템플릿을 현재부터 그 템플릿의 `maxWindowSeconds`만큼 이전까지 실행한다.

`/stop`, `/resume`, `/list`, `/cancel target:<job-id>`, `/retry target:<job-id>`, `/emergency-stop`, `/model-status`, `/resume-model target:<job-id|emergency-stop>`, `/revoke target:<actor-id>`는 모델을 거치지 않는다.
버튼의 custom ID는 `list`, `stop`, `resume`, `cancel:<job-id>`만 허용한다.

`queued/running/waiting_user/verifying/succeeded/failed/cancel_requested/cancelled/unknown/superseded`를 구분한다.

Grafana/K8s/Argo CD의 실제 응답을 `ReadTransport`의 제한된 observation 형식으로 투영하는 연결은 T16b에서 실측하며, Secret·ConfigMap·환경변수 원문을 observation에 넣지 않는다.
로그 원문은 내부 result에만 남고 공개 스레드에는 결정적인 상태 요약만 보낸다.

비전역 429는 채널 전체를 최소 1초 또는 retry_after 중 긴 시간 동안 영속 중지한다.

### 작업자 nonce 저장소 요구

작업자 검증기는 `consume(nonce)`에 **원자적·영속적인 일회 사용 기록**을 요구한다.
시험의 메모리 Set은 재시작 보안을 증명하지 않는다.

## 15. R08 읽기 전용 알림 (2026-11-05)

사용자가 자기 기기에서 직접 돌리는 Claude Code·Codex 세션을 봇에 명시적으로 연결해, 턴이 끝나면 Discord로 알린다(DECISIONS "T18 결정" (1)). 사람 세션의 자기 보고이고 봇이 결과·프로세스 소멸을 검증한 것이 아니다.

- **아직 켜지 않았다.** `src/main.ts`가 이 모듈을 읽지 않고, `/attach`도 수신 포트도 없다. 수신 경로(tailnet 전용 또는 공개+Access)는 미정이고 조립은 B5, 노출은 H3이 한다. 어댑터의 `attach_task`는 그때까지 `undecided`다.
- **능력.** `EXTERNAL_TASK_CAPABILITIES`는 `read_status`·`read_events`만 true다. 이벤트로 모델 호출·작업 시작·답·취소·재개가 생기지 않는다. `jobs`·`codex_sessions`·`events`에 행을 만들지 않는다.

**저장(`migrations/016_external_task_links.sql`).** 015는 B3가 쓴다. 번호는 운영 적용 순서를 단조롭게 두려는 것이다.

| 표 | 내용 |
|---|---|
| `external_task_connections` | owner, 대화·scope, 등록한 외부 세션 ID, 실행기(`claude`·`codex`), Ed25519 public key, `key_id`, 만료(30일), 폐기 시각·사유, 요약 동의, 마지막 수신 시각. 개인 seed 열은 없다 |
| `external_task_events` | `connection_id`+`event_id` PK, 본문 SHA-256, 수락한 `accepted_key_id`, 발생·수신 시각, `outbox_key`, `post_state`(`pending`·`posted`·`blocked`). 요약 원문은 없다 |
| `external_task_link_fence` | 복원 감지 값 한 행 |

`post_state`의 원천은 `outbox.state`다. 게시자는 R08을 모르므로 트리거 `outbox_external_task_post_state`가 같은 트랜잭션에서 따라간다. `unknown`은 보냈는지 모르므로 미게시로 센다. 중복 방지 ID는 게시가 끝난 뒤 7일 보관하고 `ExternalTaskLinks.purge()`가 지운다(주기 호출은 B5). 지운 뒤의 재생은 `occurred_at` 24시간 창에서 거절된다.

**수명(`src/external-task-links.ts`).**

- `attach`는 서버에서 키쌍을 만들고 seed를 `OneTimeSeed`로 돌려준다. `reveal()`은 한 번만 되고, 문자열·JSON·`inspect`는 `[redacted]`다. 그래서 outbox·감사·오류 수집에 실수로 실려도 값이 남지 않는다. 전달은 호출자가 ephemeral로 한다.
- `rotate`는 같은 행의 키를 덮어써 이전 키를 즉시 무효로 하고, 이전 키로 들어온 미게시 행을 막는다.
- `revoke`·`detach`는 `pending`과 발송 시작 전 `sending`을 `blocked`로 바꾼다. 게시자의 dispatch 표시가 `state='sending'`을 요구하므로 이 트랜잭션 뒤에는 나갈 수 없다. 이미 발송을 시작한 행은 보냈을 수 있어 그대로 둔다. 전달 실패 때는 `revoke(...,'delivery_failed')`로 닫는다.
- **발송 중 폐기·재발급.** 그대로 둔 행의 발송이 429·401로 실패하면 게시자가 `pending`으로 되돌린다. 트리거 `outbox_external_task_claim`이 `pending`→`sending` 전이마다 연결 폐기, 수락한 키와 현재 키의 일치, WAL timeline을 다시 보고 어긋나면 `blocked`로 바꾼다. 게시자는 R08을 모르고 재시도 경로가 여럿이라 모든 발송이 지나는 이 전이에 둔다. 폐기·재발급·동의 변경이 연결 행을 잠근 동안에는 기다리지 않고(교착 방지) lease 30초만큼 미룬다.
- **동의 철회.** `setSummaryConsent`와 수락이 같은 연결 행 잠금으로 직렬화된다. 철회가 끝난 뒤 새로 저장되는 요약은 없고, 철회 전에 큐에 든 행과 이미 받은 이벤트의 재전송은 그대로다.

**복원.** 복원하면 폐기한 키가 DB 행과 함께 되살아난다. `enforceRestoreFence`는 attach·재발급·수신마다 지금 값(`timeline:<WAL timeline>;epoch:<restoreEpoch>`)을 저장 값과 비교하고, 다르면 활성 연결을 모두 `restore_fence`로 닫고 미게시 행을 막고 감사를 남긴다. 복원된 DB에는 어느 키가 폐기됐는지 알 근거가 없으므로 전부 닫고 사람이 다시 연결한다.

- 물리 복원·PITR은 timeline이 올라가 자동으로 잡힌다.
- **pg_dump 복원은 timeline이 그대로라 자동으로 못 잡는다.** 복원 절차에서 `restoreEpoch` 설정값을 올려야 한다.
- **장애 조치(promote)도 timeline을 올려 모든 연결이 닫힌다.** 안전한 쪽의 오탐이다.
- 값을 읽지 못하면 수신이 503으로 닫힌다.
- **조립(B5).** 게시 루프를 시작하기 전에 `enforceRestoreFence()`를 한 번 부른다. 게시 트리거는 timeline만 볼 수 있어 pg_dump 복원의 `restoreEpoch` 변경은 이 호출이 있어야 미게시 행보다 먼저 잡힌다.

**수신(`src/external-task-receiver.ts`).** `ExternalTaskReceiver`는 판정, `externalTaskServer`는 전용 HTTP 서버이고 listen은 조립하는 쪽이 한다. 이 서버에는 다른 경로가 없다(`/metrics`·`/readyz` 없음).

| 항목 | 값 |
|---|---|
| 경로 | `POST /external-task-events` 완전 일치. `req.url` 원문을 비교해 query·후행 slash·하위 경로·인코딩 변형·absolute-form을 거절한다 |
| 본문·헤더 | 실제 누적 4 KiB(413), `Content-Encoding` 전부 415, 헤더 8 KiB(431), 헤더·본문 각 5초(408), `application/json`만 |
| 동시·소켓 | 동시 8(503), 소켓 32. 소켓 상한은 헤더를 천천히 보내는 연결이 동시 수에 잡히기 전 단계라 따로 뒀다 |
| 전체 속도 | token bucket 초당 10·burst 20(429). 프로세스별이다 |
| 연결별 속도 | 서명 검증 뒤 분당 30·burst 5·시간당 300(429). 프로세스별이다. 남의 connection_id로 quota를 깎을 수 없다 |
| 역압 | 미게시 연결별 100(429)·전체 1,000(503). advisory 잠금으로 세기와 삽입을 묶어 동시에 들어와도 넘지 않는다. 이미 받은 이벤트의 재전송은 대상이 아니다 |
| 시각 | `sent_at` ±5분(422 `clock_skew`), `occurred_at` 미래 5분·과거 24시간(422) |
| DB | R08 동시 DB 작업 2개, 대기 6개(초과는 곧바로 503 `overloaded`), DB 단계마다 2초(복원 울타리·연결 조회·권한·수락), 처리 전체 5초(503 `unavailable`). GitHub·Discord 처리를 굶기지 않기 위해서다. 기한이 지난 대기는 줄에서 빠지고, 실행 중 작업은 다음 단계로 가지 않는다. 슬롯은 작업이 실제로 끝나야 돌아오므로 응답이 닫혀도 DB에 남는 작업은 2개를 넘지 않는다. 연결을 빌리는 대기(`pool.connect`)만 이 기한 밖이고 풀의 `connectionTimeoutMillis`로 끊긴다 |

요청 헤더는 `x-r08-connection-id`, `x-r08-key-id`, `x-r08-sent-at`(ms), `x-r08-signature`(Ed25519 base64url)다. 서명 입력은 아래 값을 개행으로 이은 UTF-8이고, JSON을 다시 직렬화하지 않는다.

```text
R08-v1
<환경 식별자>
POST
/external-task-events
<connection_id>
<key_id>
<sent_at>
<SHA-256(raw body) hex>
```

본문 필드는 `version`(1), `connection_id`(헤더와 같아야 함), `event_id`, `external_task_id`, `type`(`turn_complete`), `occurred_at`(ms), `summary`뿐이고 나머지는 거절한다. 판정 순서는 HTTP 상한 → 헤더 형식 → `sent_at` → 복원 울타리 → 서명 → 연결별 속도 → 본문 → 외부 ID·요약 동의 → 현재 owner 권한 → 수락 트랜잭션이다. 수락 트랜잭션은 연결 행을 잠근 뒤 폐기·`key_id`·만료를 잠금 시각으로, 새 요약의 동의를 잠근 행으로 다시 본다.

- **응답.** 수락과 중복은 같은 202다. 미등록·위조·폐기·만료·옛 키는 모두 같은 401이라 구별해 주지 않는다. 같은 ID 다른 내용은 409, 다른 외부 ID·동의 없는 요약·권한 거부는 403이다.
- **목적지.** 연결 레코드로만 정한다. 클라이언트의 owner·채널 필드는 거절한다.
- **요약.** 동의 없는 연결은 고정 문구 `턴 완료`만 받는다. 동의한 연결도 500 코드 포인트·2,000바이트·제어 문자 없음이고 경로·토큰 의심 표현은 거절한다. 같은 표가 helper에 있고 시험이 일치를 확인한다. 이 표는 완전한 비밀 탐지가 아니다.
- **게시.** "사람 세션이 턴을 끝냈다고 알림", 발생·수신 시각(KST), 지연을 적는다. `allowed_mentions.parse=[]`는 게시자가 건다. 게시자의 본문에 `flags` 칸이 없어 링크 미리보기는 내용 쪽에서 막는다. 사용자 값을 모두 코드 스팬에 넣는다.
- **게시 직전 권한.** 게시자가 `PolicyGate`와 대화 활성 여부를 다시 본다. 연결 폐기·재발급은 위 `blocked` 처리와 claim 트리거로 막는다. 만료는 게시를 막지 않는다. 만료 전에 정상으로 받은 이벤트이기 때문이다. 다시 연결해 옛 행이 `expired`로 닫혀도 같다.
- **권한 조립(B5).** `authorize`는 기한이 걸린 트랜잭션 `db`를 받는다. `(owner, scope, db) => gate.withDatabase(db).authorize(owner, scope)`로 넘긴다.
- **관측.** `metrics()`가 사유별 수·지연·동시 처리·DB 슬롯 사용·DB 대기·미게시 수를 고정 라벨로 낸다. 전용 포트에 두지 않으므로 8080 `/metrics`에 조립한다. 본문·인증 헤더·연결 ID는 없다.

**사람 쪽 helper(`tools/r08-helper/`).** 설치 안내는 그 디렉터리의 README다. 봇 이미지 런타임 단계는 `src`만 복사하므로 helper가 이미지에 들어가지 않고, Node 내장 모듈만 써서 기기에 복사해 쓴다. 시험 단계는 저장소 전체를 복사하므로 시험이 함께 돈다.

- `claude-stop.mjs`(Stop, `async: true`)·`codex-notify.mjs`는 등록한 세션만 큐에 넣고 끝난다. 네트워크와 키를 만지지 않는다.
- `sender.mjs`가 큐를 서명해 보낸다. 키는 `keychain:`·`libsecret:` 참조로만 받는다. 재시도는 본문을 유지하고 새 `sent_at`으로 다시 서명한다.
- 큐는 기기당 100건 또는 1 MiB, 발생 후 24시간이다. 초과·만료·서버 거절은 사유 코드로 남고 `sender.mjs status`가 보여 준다.
- 전달 보장이 아니다. 훅이 큐에 넣기 전에 죽거나 기기·봇이 24시간 넘게 꺼져 있으면 알림이 없다.

**시험의 한계.** Claude·Codex 입력은 공식 문서의 필드로 만든 합성 입력이다. 실제 CLI 버전별 필드, 절전 복귀, Keychain 동작, NUC 자원 안의 부하는 시험하지 않았다.
