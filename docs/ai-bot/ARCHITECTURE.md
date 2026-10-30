# ARCHITECTURE: 봇 V1 구조와 FOUNDATION 로컬 계약

- 단계: `TARGET=V1`, `STAGE=FOUNDATION`, `MODE=build` (T16a), 갱신 2026-10-19.
- **상태: 로컬 코드·mock/local_integration 검증, 실연동·배포 대기.** T15 설계 중 T16a가 확정한 부분은 §11이 기준이다. §1~10의 T16a 미정·제안 표시는 당시 기록이며 §11의 결정으로 대체한다. T17~T20의 열린 항목은 유지한다. D-14~D-17·D-24는 [DECISIONS.md](DECISIONS.md)를 따른다.
- **T16b 실행기 프로필(2026-10-30, D-14 변경):** 모델 실행기는 작업자 env로 고르는 프로필이다. 첫 운영 프로필은 Claude Code CLI + 구독 장기 토큰 + Opus 5.5이고, 기존 Codex 경로는 전환 가능한 프로필로 남았다. 아래 §0~§5의 Codex·`auth.json` 서술은 Codex 프로필 기준 기록이다. 작업자 실행기의 현재 기준은 §12 "T16b 실행기 프로필"이다.
- 근거 꼬리표는 [DISCOVERY.md](DISCOVERY.md)와 같다. 확인일은 모두 2026-10-18이라 꼬리표마다 다시 적지 않는다.
- 기준: 역할 경계는 `01` §1, 보안 경계는 `00` §6, 공통 계약은 `01` §2(F01~F09), 플랫폼 자리는 platform/design.md C.8. 이 문서는 이것들을 바꾸지 않는다.

## 0. 요약

1. **작은 제어 서비스 하나 + PostgreSQL + 격리 작업자 하나.** 게시 서버(ns `app-homelab-bot`, replicas 1)가 수신·조율·읽기 조회·게시를 맡고, 상태와 큐는 공유 PostgreSQL의 봇 전용 DB에 둔다. 모델 호출은 ns `sandbox`의 작업자만 한다.
2. **모델 자격은 작업자에만, 게시 자격은 게시 서버에만.** 모델 자격은 봇 전용 구독 계정의 `auth.json` 하나이고 작업자 전용 영속 CODEX_HOME에 있다(D-14). 비신뢰 자료(로그, PR, 댓글)를 읽는 모델은 Discord 토큰·GitHub App 키와 다른 파드에서 돈다.
3. **Codex는 `codex exec --json` 경로.** 질문은 턴 종료 + `exec resume`으로만, 도구 승인 중계는 `capability=false`. `codex app-server`는 어댑터 뒤 실험 후보로만 둔다. 사람이 연결한 기존 Codex 작업(R08)의 연결 방식은 T18에서 다시 판단한다.
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
| Discord intents | `GUILDS` + `GUILD_MESSAGES` + `DIRECT_MESSAGES` + `MESSAGE_CONTENT` = 37377. intent를 끄면 4609와 명령/버튼 모드(DM 끔이면 513). DM을 쓰지 않으므로(확정(사용자 2026-10-20, T16a)) T16b는 `DIRECT_MESSAGES`를 뺀 33281로 연결한다 [가정: 실연동 T16b] | [실측: discord.js bitfield], D-17 확정 | DM 끔(T16a), 실연동 T16b |
| GitHub | App JWT → 작업마다 저장소 하나·필요 권한만의 1시간 설치 토큰. webhook은 원본 바이트 HMAC 상수 시간 비교 | [확인: https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app , https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries] | T17 |
| Codex | codex-cli 버전 고정(0.163.0 기준), `codex exec --json -o --output-schema`. JSONL fixture 계약 시험. 인증은 작업자 전용 CODEX_HOME의 `auth.json`(D-14) | [확인: https://learn.chatgpt.com/docs/non-interactive-mode / 실측: `codex exec --help`] | 대화 레인 T16a, 작업 레인 T18 |
| DB | 공유 CNPG `pg`의 봇 전용 DB·역할. 큐는 `FOR UPDATE SKIP LOCKED` + lease·heartbeat | [확인: spec §5.1 D-05·D-06] / 큐 방식은 [가정] | T16a |
| 마이그레이션 | Argo CD Sync hook Job, expand/contract | [확인: spec §5.1 D-22] | T16b |

[미확인] 새 앱 템플릿(D-21, E5)이 런타임·기본 이미지를 정하는지. 템플릿은 아직 옛 내용이다.

## 4. Codex 작업 어댑터의 V1 능력 표시

`01` §6 추상 계약 기준. 경로 (A) `codex exec`를 쓸 때다. 최종 값은 T18이 실측으로 정한다.

> T18 로컬·mock 값(2026-10-29)은 §12다. 실제 CLI 실측은 아직 없다(T16b, D-14 차단 조건).
> T16b(2026-10-30): 대화 레인의 실행기는 프로필로 고른다(§12 "T16b 실행기 프로필", Claude가 첫 운영 프로필). 이 표는 T18 Codex 작업 어댑터의 기준이고, 작업 레인은 아직 어떤 실행기에도 연결하지 않았다.

| 계약 | V1 값 | 근거 |
|---|---|---|
| `capabilities()` | true. 고정 버전 + `--help` 대조 | [실측: `codex --version`, `codex exec --help`] |
| `start_task` | true. 작업 레인에서 `codex exec --json`, 작업 공간은 고정 SHA의 `codeload.github.com` 압축본 + `git init` 한 번 커밋(D-15) | [확인: https://learn.chatgpt.com/docs/non-interactive-mode] |
| `attach_task` | **보류(T18).** R08(사용자가 명시적으로 연결한 기존 Codex 작업)은 요구 그대로이고 연결 방식은 T18에서 다시 판단한다. 봇 소유 세션의 재개는 `resume_task`(R10 경로)다. herdr 경유는 쓰지 않는다 | 사용자 결정(2026-10-18, T15). herdr는 상태를 화면으로 추정하고 소켓에 인증이 없다 [확인: https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/website/src/content/docs/integrations.mdx , 실측: 소켓 0600]. Codex 공식 훅 이벤트 목록 [미확인] |
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
| GitHub | 허용 저장소의 열린 PR을 주기적으로 읽어 처리 기록과 대조. 대조 키는 `01` §5의 세대 구분과 같은 `(head_sha, comparison_revision, policy_revision)`이다. head가 같아도 기록된 base·`comparison_revision`이 현재와 다르면(base 브랜치가 앞서감, base 재지정) 새 세대로 보고 이전 결과를 `superseded`로 둔다(REVIEW-02). webhook 트리거에도 `pull_request` `edited` 중 base가 바뀐 경우(재지정)를 넣는다(DECISIONS D-16 규칙 스케치). 새 설치 직후 과거 PR을 무제한 리뷰하지 않는다 | 실패한 webhook은 자동 재전송되지 않고 수동 재전송은 3일 안만 된다. base 브랜치가 앞서가기만 하면 리뷰 App이 받는 PR 이벤트가 없어 폴링이 잡는다 [가정]. `comparison_revision`을 무엇으로 둘지(base 브랜치 머리 또는 merge base), base만 움직였을 때 다시 리뷰할지 결과만 `superseded`로 표시할지는 모델 호출 직렬 1(D-14)을 보고 T17에서 정한다 |
| Alertmanager | 그룹화·반복 전송에 기댄다. 수신 실패는 Alertmanager 지표에 남는다 | 봇이 놓친 경보는 Telegram 경로가 따로 받는다 |
| 작업자 | 작업자 파드가 사라지면 `running` 작업을 `unknown`으로. CODEX_HOME은 영속 공간이라 세션 파일이 남을 수 있고, 재개 여부는 사람이 고른다 | 작업 공간(코드)은 영속이 아니다 [가정]. 영속 공간은 설계 C.8 변경이고 C.8 격리 행·E4b에 들어갔다(크기·백업은 T08b) |

**IDENTIFY 예산:** 24시간 1000회를 넘으면 모든 세션이 끊기고 봇 토큰이 리셋된다 [확인: https://docs.discord.com/developers/events/gateway]. 재연결은 지수 백오프로 하고, 프로세스 재시작 수와 IDENTIFY 수를 기록한다. 401이 이어지면 Discord 요청을 멈추고(잘못된 요청 10분 10,000건이면 IP 일시 차단) 비AI 경로로 알린다 [가정].

**백업·복원:** 봇 DB는 공유 PostgreSQL 백업(R2 `homelab-backups`, 14일)에 든다 [확인: spec §5.1 "설계 기본값"]. 삭제한 기억도 14일 동안 백업에 남을 수 있다. 삭제 표식을 봇 DB에만 두면, 삭제 전 백업으로 복원할 때 기억과 표식이 함께 되돌아가 다시 적용할 것이 남지 않는다. 그래서 삭제 표식은 **복원 대상 밖의 삭제 원장**에 둔다(DATA-02). 아래는 제안이다 [가정]:

- 원장은 봇 DB 복원으로 되돌아가지 않는 저장소에 둔다. 예: R2 append-only 객체, 또는 복원에서 빼는 별도 DB. 같은 공유 PostgreSQL 안의 별도 DB는 앱 하나 복원(설계 C.5.7, 그 DB만 되돌림)에서는 빠지지만 빈 NUC 복구(설계 C.6.4, 클러스터 전체)에서는 함께 되돌아간다 [가정: 설계 C.5.7·C.6.4의 복원 단위에서 도출].
- 원장에는 기억 ID, 그 기억의 `created_at`, 삭제 시각만 두고 내용은 두지 않는다. 재적용은 ID와 `created_at`이 둘 다 맞을 때만 삭제한다. 복원으로 ID 발급이 되감겨 새 기억이 같은 ID를 받으면, ID만 보는 재적용은 그 새 기억을 지운다.
- 제안: `memory_id`(`01` §8 최소 스키마)는 재사용되지 않는 값(UUID 등)으로 정한다. 위 `created_at` 대조와 함께 둔다.
- 봇은 기동할 때마다 원장의 삭제를 멱등하게 다시 적용하고, 그 뒤에 기억 조회를 연다. 그러면 백업 시점 이후의 삭제가 복원 뒤에도 다시 적용되고, 복원 절차가 봇에 따로 알리지 않아도 된다.
- 삭제 쓰기 순서 [가정], 결정은 T20: 원장 append가 내구성 있게 기록됐음을 확인한 뒤에만 봇 DB에서 지우고, 그 뒤에 삭제 완료를 응답한다(원장 기록 확인 → DB 삭제 → 완료 응답). 원장 쓰기가 실패하면 지우지 않고, 실패를 알리거나 재시도할 수 있는 outbox에 둔다. 원장 쓰기 결과를 모르면 원장을 확인해 기록 여부로 사용자 안내를 정한다. 원장 기록 뒤 DB 삭제가 실패하면 재시도 작업으로 성공할 때까지 지우고, 그동안 기억 조회(검색·브리핑·답변)는 원장(또는 DB의 숨김 표식)과 대조해 그 기억을 숨긴다. 기동 때 재적용만 기다리면 다음 재시작 전까지 지운 것으로 기록된 기억이 계속 쓰이기 때문이다. 두 쓰기는 서로 다른 저장소라 한 트랜잭션으로 묶이지 않는다. DB를 먼저 지우고 원장 쓰기가 실패한 채 완료로 응답하면, 삭제 전 백업을 복원할 때 다시 적용할 표식이 없어 기억이 되살아난다. 부분 실패 사례(원장 실패, DB 삭제 실패, 응답 유실)는 DATA-02다.
- 원장의 저장소·자격·보존 기간은 T20(R17)에서 정한다. 보존 기간은 백업 보존(14일)보다 짧으면 안 된다.

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
- 삭제 원장의 저장소·자격·보존, 쓰기 순서와 부분 실패 처리(§7) [T20].
- R08 연결 방식 [T18].

## 11. T16a 확정 계약과 로컬 구현 (2026-10-19)

이 절은 T16a 범위의 구현 선택이다. 새로운 사용자 결정을 만들지 않으며, DM은 끄고(`dmEnabled: false`)
브리핑은 매일 08:50 Asia/Seoul이다(확정(사용자 2026-10-20, T16a)). 브리핑 실행은 T20이다.

### 호출 경로·직렬 대기·측정

Discord Gateway → `DiscordProtocol` → `DiscordIngress` → PostgreSQL 이벤트 저장 →
처리 경로(job/outbox/제어 결과) 영속 저장 → 수신 ACK → `Runtime` → 서명 capability를 붙인 작업자 Service:8080의 `/v1/execute` →
`SerialWorker` → `codex exec` 계약 → 구조화 결과 → `results/outbox` → `DiscordPublisher`다.
`/read`는 모델을 부르지 않고 승인 템플릿 조회를 실행한다. Gateway 연결 루프는 T16b `src/gateway.ts`(아래), 모델 프로세스는 작업자 진입점(T16b)이다.
런타임은 Node 24.22.0이며, Discord 클라이언트는 SDK 없이 주입 가능한 `DiscordProtocol`을 선택했다.
인증된 WebSocket 세션은 T16b `GatewaySession`(Node 24 내장 WebSocket, intents 33281)이 이 어댑터에 잇는다. 봇 사용자 ID는 첫 READY에서 받고,
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
중단 중 메시지를 history로 복구하기 전에 이전 입력으로 모델을 부르지 않고, 복구된 최신 메시지가 그 작업을 먼저 supersede할 수 있다. slash 명령은 READY마다 guild 단위로 FOUNDATION 12개에 맞추고(`task`·`review-*` 없음, 같으면 쓰지 않음)
전역 명령은 비운다. 수신도 같은 목록만 받는다. 재연결·RESUME 실측은 실연동(S16)이다.

작업자 모델 호출은 **대화·작업 레인 합쳐 1개**다. DB의 scheduler 행 잠금과 작업자의 별도 mutex가
중복 실행을 막는다. lease가 끝나거나 호스트 결과를 모르면 `unknown`이 전체 모델 슬롯을 잡는다.
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
Discord REST의 1초 전송 제한은 상호작용 첫 응답 3초에 맞춰 유지하며 작업 수락 여부와 분리한다.
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
Runtime의 /read는 ReadAdapter.recent를 통해 한 번 읽은 현재 시각을 기준으로 min(60초, 템플릿 상한)을 요청한다.
명시적인 read 시간창을 자동 축소하지 않으며 상한 초과·미허용 템플릿·서비스는 기존대로 거부한다. 보존 기간 30일/14일과 별개다.
현재 사실은 5분 안의 관측이며 빈 응답·오래된 값·조회 실패는 미확인이다.
공개 응답은 대상·출처·시간창·시각·사실/가설/미확인·권장 확인을 포함한다. 로그 원문은 게시하지 않는다.
서비스별 read 결과와 경보는 outbox의 service_ids에 범위를 남기고 게시·대조 직전 현재 policy.services로 검사한다.
경보는 지원 라벨을 거른 뒤 고유 서비스 집합을 저장하며, thread 병합으로 내용을 교체할 때 범위도 교체한다.
게시·대조 직전에 DB의 service_ids를 다시 읽어 claim 뒤 병합도 재인가한다.
초기 요약은 thread 확정 transaction에서 읽은 최신 service_ids를 이어받아 전송 중 병합도 반영한다.
fingerprint 계산에 서비스 ID도 포함해 같은 fingerprint 문자열의 서비스 변경을 놓치지 않는다.
006 이전 경보는 건수만 남아 서비스 범위를 재구성할 수 없으므로 미전달·범위 없는 행은 blocked와 감사로 닫는다.
이미 sent인 전달과 범위를 가진 행은 바꾸지 않으며 과거 경보의 범위를 현재 허용 목록으로 추정하지 않는다.
요약 예산은 대상/출처 각 120자, 사실 600자, 미확인/권장 확인 각 350자다. 항목 수가 넘으면 생략 건수를
표시한다. 긴 작업 목록은 유효한 JSON 배열로 1800자 이하 페이지를 만들어 별도 멱등 키로 게시한다.
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
기본 debounce **750ms**, urgent **0ms**, 큐 **100건**, lease **30초**, 대화 모델 **60초**,
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
`homelab_bot_gateway_connected`, `homelab_bot_outbox_oldest_seconds`, `homelab_bot_outbox_unknown`을 노출한다.
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
min(1000ms, expiresAt-now)다. 저장 전 deferred ACK는 하지 않는다. 이미 수락했지만 마감이 지난 요청은
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
명시 확인으로 그 중지만 해제하며 running/verifying/cancel_requested/unknown이 있으면 거부한다.
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
| `attach_task` | **미정**(`undecided`). 부르면 `CapabilityUnavailable(undecided)`. `false`로 정한 것이 아니다 | TASK-01 | R08 연결 방식 사용자 결정 |
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
- **한계(시험으로 기록):** 환경을 지우고 새 세션으로 빠져나간 자식은 찾지 못한다. 그래서 `confirm_stop` 값은 `process_group_and_marker`다. 이 한계가 풀리기 전에는 작업 레인에서 비신뢰 코드를 돌리는 단계(T19)의 소멸 확인 근거로 충분하지 않다. cgroup 위임·PID namespace 실측은 T16b다.
- 기록한 프로세스 그룹은 리더 pid가 다른 시작 시각으로 살아 있으면 재사용된 번호로 보고 쓰지 않는다.
- 확인 불가는 0개로 세지 않는다: 작업 시작 뒤 생긴 같은 UID 프로세스의 environ을 못 읽으면(non-dumpable 등) `unknown`이다. 작업 전부터 있던 프로세스는 셈에서 뺀다. 작업 기록이 없으면(재시작 뒤) 못 읽는 같은 UID 프로세스를 모두 의심한다. 작업자 파드에는 다른 프로세스가 없어 영향이 없지만, 개발 기계에서 `release`가 거부될 수 있다.
- 막힘 기록: `jobs.state='unknown'`이 DB에 남고(재시작 뒤 유지) T16a `claim()`이 새 모델 실행을 막는다. Discord 알림을 보낸다. settle 밖에서 생긴 unknown(lease 만료, 기록 실패)도 `Runtime.tick`의 `sweep()`이 알림을 한 번 넣는다. 비AI 경로(Telegram) 알림은 아래 T16a 변경 요청 5번이다.
- 해제: owner의 `release`는 작업자 프로세스 0개를 다시 확인한 뒤에만 `cancelled`(`stop_confirmed_after_unknown`)로 바꾸고 작업은 다시 실행하지 않는다. 남아 있으면 거부하고 파드 재생성을 안내한다. owner가 바뀌어 남은 막힘은 옛 owner가 풀 수 없으므로 그 작업에 한해 현재 정책 owner가 같은 확인 뒤 푼다(상태 조회 권한은 생기지 않는다).

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

- argv: `exec --json --ephemeral --skip-git-repo-check --output-schema <run>/answer.schema.json -o <run>/last-message.json -`. 지시는 stdin(시스템 지시 + owner 메시지 기록 JSON).
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
- `SerialWorker.cancel`(T16a)은 이미 끝나 바쁘지 않은 작업의 취소에 `stopped: false`를 답한다. 게시 서버의 시간 초과와 작업자 완료가 겹치면 `unknown`이 될 수 있어 위 기한 여유를 뒀다.

### T16b 실행기 프로필 (2026-10-30, D-14 변경)

- 결정: D-14 변경(사용자 2026-10-30, [DECISIONS.md](DECISIONS.md) D-14 "변경"). Claude Code CLI, 구독 장기 토큰, 첫 모델 Opus 5.5, 실행기를 설정으로 바꾸는 구조. 설계는 T16b 조사(실행기 어댑터·Claude 인증·Claude 전환 영향, 비공개 작업 문서)의 추천안 "공통 실행 제어 + 작은 실행기 어댑터 + 프로필 선택 + 이미지 하나"를 따랐다.
- 범위: 대화 레인만. 작업 레인(T18)·리뷰(T17)는 어떤 실행기에도 연결하지 않았다(능력표 `lanes.task=false`). 게시 서버와의 HTTP v1(요청·응답·서명·nonce)은 바꾸지 않았다. 실행기 이름·플래그·자격은 그 계약에 들어가지 않는다.
- 모델 호출·로그인 없음. Claude CLI는 고정 바이너리의 `--version`·`--help`만 실행했다. 시험의 CLI 자리는 같은 인자·stdin·env로 도는 가짜 실행 파일이다.

```text
게시 서버 ── 서명된 HTTP v1(변경 없음) ──▶ 작업자
  SerialWorker: 서명·nonce·직렬 1
  ChatLane(chat-lane.ts): 공통 실행 제어
    ├ 실행마다 빈 /tmp/homelab-chat-*/{home,config,workspace,run,tmp}, 끝나고 소멸 확인 뒤 통째 삭제
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
| `src/chat-lane.ts` | 공통 실행 제어 `ChatLane`, 판정 `interpretChat`, 실행 전 검사 `assertLaunchSafe`, 출력 스키마 `CHAT_OUTPUT_JSON_SCHEMA` |
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
| 레인 | 대화만 | 대화만 |
| 구조화 출력 | `--json-schema` → 마지막 `result.structured_output` | `--output-schema` → `-o` 파일 |
| 도구 | none: `--tools ""`, MCP 없음, 실행 중 도구 호출이 보이면 즉시 중단(예산 0) | read-only 샌드박스 + 요청 도구 예산(D4) |
| 세션 기록 | `--no-session-persistence` + 실행 디렉터리(HOME·CLAUDE_CONFIG_DIR·TMPDIR) 통째 삭제 | `--ephemeral` + CODEX_HOME `sessions/`·`archived_sessions/` 삭제 |
| 모델 고정 | 예(`--model`, 실행마다 init 이벤트와 대조) | 아니오(CLI 기본) |
| 자격 | env-static | file-mutable |
| 근거 수준 | 가짜 CLI 시험 | 가짜 CLI 시험 |

**자격 방식.**

- env-static(Claude 토큰): `<WORKER_CREDENTIAL_DIR>/<WORKER_CREDENTIAL_KEY>`(Secret 볼륨 파일). 읽기는 Codex 시드와 같은 `readSecretFile`이다: 링크의 최종 대상이 사람 홈 `.codex*`·`.claude*`면 거부, 검사한 경로와 연 파일 대조, 일반 파일·16KiB 이하. 앞뒤 공백·줄바꿈을 떼고 인쇄 가능한 ASCII 한 줄(16~8192자)이어야 한다. 토큰 접두어는 공식 형식이 없어 [미확인] 보지 않는다. 기동 때, readiness 때, **실행 준비 때마다** 다시 읽는다. 그래서 ESO가 값을 바꾸면 파드 재시작 없이 다음 실행부터 새 값이다(이미 실행 중인 자식은 옛 값). 영속 공간에 복사하거나 되쓰지 않는다. 사유 코드는 `credential_missing`·`credential_unreadable`·`credential_personal_path`·`credential_invalid`다.
- file-mutable(Codex auth.json): 위 "T16b 작업자 진입점"의 시드 복사 그대로다.

**공통 실행 전 검사(`assertLaunchSafe`).** 다음이면 띄우지 않고 `failed`(남은 프로세스 없음)다: 어댑터 env 이름이 선언 목록 밖이거나 공통 기본 이름을 덮음, 자격 값이 어댑터의 자격 변수 밖(argv, 다른 env 값, 실행 디렉터리의 파일)에 있음, 정적 자격인데 자격 변수에 그 값이 없음. 작업자 프로세스 env는 읽거나 병합하지 않는다. 어댑터가 잘못돼도 공통부가 막는다(시험 CLD-09).

**Claude 어댑터.** 플래그는 고정 바이너리 2.1.308 `claude --help`에서 모두 확인했다[실측]. 이벤트 모양은 같은 바이너리에 든 SDK 메시지 스키마(정적 읽기)와 공식 headless 문서다[가정: 실제 출력 대조는 S12].

- argv: `-p --output-format stream-json --verbose --json-schema <CHAT_OUTPUT_JSON_SCHEMA> --model <WORKER_MODEL> --tools "" --strict-mcp-config --mcp-config {"mcpServers":{}} --no-session-persistence --permission-mode dontAsk --disable-slash-commands --safe-mode`. 프롬프트는 stdin이다(argv·파일에 두지 않음).
- 쓰지 않는 플래그(`CLAUDE_FORBIDDEN_FLAGS`, 시험이 확인): `--bare`(OAuth 토큰을 읽지 않는다 [확인: --help]), `--fallback-model`, `--dangerously-skip-permissions`, `--resume`·`--continue`, `--add-dir`, `--allowedTools`, `--settings`·`--setting-sources`, `--system-prompt`, `--plugin-dir`, `--debug-file` 등.
- env: 공통 기본 + `CLAUDE_CONFIG_DIR`(실행별 임시) + `CLAUDE_CODE_OAUTH_TOKEN`(토큰) + 고정 7개 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`·`DISABLE_TELEMETRY=1`·`DISABLE_ERROR_REPORTING=1`·`DISABLE_FEEDBACK_COMMAND=1`·`CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1`·`ENABLE_CLAUDEAI_MCP_SERVERS=false`·`DISABLE_UPDATES=1`. `-p`에서는 API 키가 OAuth 토큰보다 우선하므로 [확인: 공식 인증 문서] 자격 변수는 하나만 넣는다.
- 실행마다 첫 `system/init` 확인: `tools`가 출력 전달용 `StructuredOutput`뿐(또는 없음), `mcp_servers` 0개, `model` = `WORKER_MODEL`, `apiKeySource` = `none`(OAuth 토큰. API 키가 쓰였다면 `ANTHROPIC_API_KEY`), `claude_code_version` = 2.1.308. 하나라도 다르면 기한을 기다리지 않고 즉시 멈추고 `failed`다.
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
| `HTTPS_PROXY`, `NO_PROXY` | 아니오 | 모델 CLI 프로세스 env에만 넘긴다 |

**readiness.** `GET /readyz`는 선택한 자격이 쓸 수 있는 모양으로 있으면 200이다. Claude: 토큰 파일 읽기·모양(없어지거나 틀리면 503, 돌아오면 200). Codex: 영속 공간의 일반 파일 `auth.json`. 모델을 부르지 않는다. readiness 200은 인증 서버가 토큰을 받는다는 뜻이 아니다.

**준비된 프로필 사이 전환(설정 PR 하나 + 자격 하나).**

1. 사람이 대상 프로필의 자격 하나를 Infisical `/apps/homelab-bot/worker`의 그 키에 넣는다.
2. sandbox values PR: `WORKER_EXECUTOR`·`WORKER_MODEL`·`WORKER_CREDENTIAL_KEY` 세 값, ExternalSecret의 키 하나, 프로필 egress 호스트. 이미지 digest는 그대로다(두 CLI가 이미 들어 있다).
3. 배포 전 모델 실행을 멈추고 실행 중 작업을 drain한다. `unknown`이면 새 실행기로 넘기지 않는다. 프록시와 작업자 롤아웃은 원자적이지 않다.
4. 병합 뒤 버전·프로필·readiness를 보고, 승인된 최소 실제 대화로 확인한 뒤 사람이 재개한다.

롤백은 이전 프로필을 고르는 PR이다. Codex로 돌아갈 때는 PVC의 갱신본 `auth.json`을 쓰고 옛 시드로 덮지 않는다(시드 규칙이 이미 그렇다). 새 실행기(OpenCode 등)나 새 인증 방식(Claude API 키 등)은 어댑터·이미지·시험을 더한 뒤 프로필 표에 한 줄을 더하는 코드 PR이 먼저다.

**남는 것 [미확인]·[가정] (S11·S12 실측).**

- 실제 stream-json 모양: `system/init`의 `model` 값이 `--model`로 준 ID와 글자 그대로 같은지, `apiKeySource`가 `none`인지, `--tools ""`일 때 `tools`에 `StructuredOutput`이 남고 구조화 출력이 되는지, 한도·인증 오류가 assistant `error` 종류로 오는지. 다르면 첫 대화가 `failed`(정책 위반 또는 결과 없음)로 닫히는 쪽으로 틀린다(fail-closed).
- egress: 모델 요청은 `api.anthropic.com:443` [확인: 공식 네트워크 문서]. 장기 토큰 사용 때 `claude.ai`·`platform.claude.com`(OAuth 교환·갱신)이 필요한지는 [미확인]이다. DNS 없는 파드에서 `HTTPS_PROXY`만으로 되는지도 [미확인]이고, 안 되면 먼저 볼 후보는 2.1.308에 있는 `CLAUDE_CODE_PROXY_RESOLVES_HOSTS`다(값의 뜻은 미확인이라 지금 넣지 않았다).
- `--safe-mode`·`--strict-mcp-config`·`--disable-slash-commands`와 OAuth 토큰·구조화 출력의 조합이 실제로 함께 도는지. CLI가 실행 디렉터리 밖(`/tmp` 직접 등)에 쓰는 파일이 있는지.
- 메모리·`/tmp`(256Mi) 사용량, 첫 응답 시간(대화 기한 60초 안인지).
- Claude 토큰도 같은 UID에서 `/proc/<pid>/environ`으로 읽힌다. 대화 레인에는 비신뢰 코드가 없어 받아들인 위험이고, 작업 레인을 열기 전에 T18 결정 (2)·(4)가 필요하다.
