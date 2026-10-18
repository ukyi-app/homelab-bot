# ARCHITECTURE: 봇 V1 구조 제안

- 단계: `TARGET=V1`, `STAGE=DISCOVERY`, `MODE=plan` (homelab 티켓 T15). 작성일 2026-10-18. 초안.
- **상태: 설계 제안이다.** 코드도 배포도 없다. D-14~D-17·D-24는 확정(사용자 2026-10-18, T15)이고 이 문서는 그 결정을 따른다([DECISIONS.md](DECISIONS.md)). D-14가 에이전트 추천(B, API 키)과 달라 대화 레인, 자격 배치, 예산을 구독 인증에 맞췄다(§2, §5, §5.1, §9). 대화 레인의 호출 경로와 동시성의 최종 값은 T16a가 정한다. R08 연결 방식은 T18에서 다시 판단한다(보류).
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
 │ 읽기 어댑터: Grafana(bot-reader Viewer) / Argo CD(bot-reader get) / K8s(SA bot-reader)    │
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

- 게시 서버가 닿는 클러스터 안 목적지는 `platform/bot-slot`이 연 셋(작업자 Service, Grafana, `argocd-server`)과 PostgreSQL뿐이다. vmsingle·VictoriaLogs·Alertmanager API에는 닿지 않는다 [확인: 설계 C.8]. Kubernetes API는 노드 로컬 경로라 읽기 전용 SA가 경계다.
- 게시 서버의 인터넷 443은 공유 차트 규칙(IPv4, 사설·tailnet 대역 제외)을 따른다. Discord·GitHub·healthchecks.io 호출이 여기로 나간다 [확인: 설계 C.4.5 / IPv4만으로 되는지는 미확인, T16b].
- replicas 1인 이유: Discord Gateway는 shard 하나에 연결 하나이고, 큐 소비의 중복을 lease로만 막기보다 단일 소비자가 단순하다 [가정]. 재시작 중 짧은 공백은 §7의 대조로 메운다.
- 대화 레인을 `codex exec`로 두는 것은 D-14 A의 출발점 제안이다 [가정]. 호출 경로와 동시성의 최종 값은 T16a가 정한다(T16a 할 일 6).

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

**추천: 방안 1.** `00` §6 "모델 vs 게시"를 프로세스 경계로 지키고, 설계 C.8의 "작업자 자격 하나"를 그대로 쓴다. 대화 레인 지연과 직렬 대기 시간은 T16a(모의)·T16b에서 측정한다 [미확인].

고르지 않은 것:

- **Valkey 큐:** D-06은 큐 유실이 치명적이면 PostgreSQL에 두라고 한다. F02(영속 inbox/outbox/job)가 바로 그 경우라 Valkey를 두지 않는다 [확인: spec §5.1 D-06 / 판단은 가정].
- **수신기·처리기 Deployment 분리, 마이크로서비스:** 논리 경계는 모듈로 나누고 프로세스는 하나로 시작한다(`00` §4 "작은 제어 서비스 + 영속 저장소 + 격리 실행기").
- **HTTP Interactions Endpoint:** 공개 경로와 Ed25519 검증이 하나 더 생긴다. D-17로 Interactions Endpoint URL은 비운다.

## 3. 도구·런타임

| 영역 | 제안 | 근거 | 확정 시점 |
|---|---|---|---|
| 언어·런타임 | TypeScript, Bun 1.4.3. **Bun 전용 API(`Bun.*`)는 쓰지 않는다** | NUC 설치본이다 [실측: `bun --version`]. discord.js 공식 Bun 템플릿이 있다 [확인: https://github.com/discordjs/discord.js (이슈 #11346)]. 전용 API를 피하면 Node 24로 바로 옮길 수 있다 | T16b 단절 시험이 실패하면 Node 24 [가정] |
| Discord | `@discordjs/core` + `@discordjs/rest` + `@discordjs/ws`(캐시 없음, 상태 원본은 PostgreSQL). 대안 `discord.js` 14.27.0 | 둘 다 같은 ws·rest 계층이라 Bun 위험은 같다 [실측: 패키지 의존] | T16a |
| Discord intents | `GUILDS` + `GUILD_MESSAGES` + `DIRECT_MESSAGES` + `MESSAGE_CONTENT` = 37377. intent를 끄면 4609와 명령/버튼 모드. DM을 쓰지 않으면 `DIRECT_MESSAGES`를 뺄 수 있다 [가정] | [실측: discord.js bitfield], D-17 확정 | DM 여부는 T16a, 실연동 T16b |
| GitHub | App JWT → 작업마다 저장소 하나·필요 권한만의 1시간 설치 토큰. webhook은 원본 바이트 HMAC 상수 시간 비교 | [확인: https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app , https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries] | T17 |
| Codex | codex-cli 버전 고정(0.163.0 기준), `codex exec --json -o --output-schema`. JSONL fixture 계약 시험. 인증은 작업자 전용 CODEX_HOME의 `auth.json`(D-14) | [확인: https://learn.chatgpt.com/docs/non-interactive-mode / 실측: `codex exec --help`] | 대화 레인 T16a, 작업 레인 T18 |
| DB | 공유 CNPG `pg`의 봇 전용 DB·역할. 큐는 `FOR UPDATE SKIP LOCKED` + lease·heartbeat | [확인: spec §5.1 D-05·D-06] / 큐 방식은 [가정] | T16a |
| 마이그레이션 | Argo CD Sync hook Job, expand/contract | [확인: spec §5.1 D-22] | T16b |

[미확인] 새 앱 템플릿(D-21, E5)이 런타임·기본 이미지를 정하는지. 템플릿은 아직 옛 내용이다.

## 4. Codex 작업 어댑터의 V1 능력 표시

`01` §6 추상 계약 기준. 경로 (A) `codex exec`를 쓸 때다. 최종 값은 T18이 실측으로 정한다.

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
| | `GRAFANA_READER_TOKEN`, `ARGOCD_READER_TOKEN` | 읽기 어댑터. 설계에 보관 위치가 없던 자리 |
| | `HEALTHCHECKS_PING_URL` | 봇 하트비트(§8) |
| | `RUNTIME_POLICIES` | 허용 목록·runtime policy 실제 값(JSON). 키 구조는 [config/homelab-bot.example.yaml](config/homelab-bot.example.yaml). 마운트한 Secret 파일로 읽는 것은 제안 [가정], T16a. 공유 차트 변경 필요(설계 C.4.5는 env만). §6 "허용 목록 반영" |
| `/apps/homelab-bot/worker` | `CODEX_AUTH_JSON` (D-14 A의 시드 `auth.json`) | 작업자만. 영속 CODEX_HOME에 `auth.json`이 없을 때만 시드로 쓴다 |

- 작업자 경로에는 모델 자격 외에 아무것도 두지 않는다 [확인: 설계 C.8]. Kubernetes SA `bot-reader` 토큰은 Infisical이 아니라 공유 차트의 `serviceAccountName`으로 받는다 [확인: 설계 C.4.5].
- App ID는 비밀이 아니지만 값 목록을 한곳에 모으려고 같은 경로에 둔다 [가정].
- ESO는 Infisical → Secret 한 방향이라 Codex가 갱신한 `auth.json`은 Infisical로 돌아가지 않는다 [가정: 설계 C.6.3의 읽기 전용 identity]. 갱신본의 원본은 작업자 영속 공간이고, 그 공간을 잃으면 사람이 다시 시드한다(D-14 남는 위험).
- 남는 위험: Infisical Free에는 경로 RBAC가 없다 [확인: 설계 C.6.3]. 작업자 store는 `/apps/homelab-bot/worker`로 묶이지만 같은 identity가 다른 경로도 읽을 수 있다.

### 5.1 작업자에 구독 인증 파일이 있는 구조 (D-14·D-15)

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

**열린 항목 (T18에서 판단. 대화 레인의 경로·동시성은 T16a)**

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
| 조회 vs 변경 | 읽기 계정 셋(`bot-reader`)과 NetworkPolicy. **로그 제외는 플랫폼 권한으로 서지 않으므로**(Grafana OSS Viewer가 모든 데이터소스 질의) 읽기 어댑터가 사전 승인 질의 템플릿만 보낸다. 템플릿마다 데이터소스·네임스페이스·시간창 상한·응답량 상한. 시간창 상한은 보존 기간(메트릭 30일, 로그 14일, 설계 C.3.7)과 따로 T16a에서 정한다 | READ-02에 "허용 밖 LogsQL·MetricsQL 거부" 사례를 넣는다. 더 강하게는 데이터소스 API 앞 읽기 프록시(U12 대안). Argo CD live ConfigMap 노출 여부는 T08b·T16b 시험 |
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

**허용 목록 반영(F01, AUTH-02):** Infisical에서 허용 목록을 바꾸면 ESO 동기화를 거쳐야 봇에 닿는다. 정책을 확인할 수 없거나 오래됐으면 거부하도록 **실패 시 닫힘**으로 설계한다. 다만 이것이 철회의 즉시 효력을 보장하지는 않는다(아래 "남는 창"). 아래는 제안이고 값은 T16a에서 정한다 [가정]:

- 제안 [가정], T16a: runtime policy는 환경 변수가 아니라 마운트한 Secret 파일로 읽고, 파일이 바뀌면 다시 읽는다. 환경 변수는 파드를 다시 시작해야 반영된다 [확인: 설계 C.6.5]. 공유 차트 변경이 필요하다. 설계 C.4.5는 Secret을 키마다 환경 변수로만 넣는다 [확인: 설계 C.4.5]. 차트 대신 봇 쪽 추가 매니페스트로 할 수도 있다(T16a·T16b).
- 정책에 revision과 최대 나이를 둔다. 나이는 그 revision이 현재 값임을 마지막으로 확인한 때부터 잰다. 현재 revision을 확인할 수 없거나 최대 나이를 넘으면 접근을 거부한다. 확인 방법은 [미확인]이고 T16a에서 정한다.
- **남는 창:** Infisical에서만 철회하면 ESO 갱신 주기만큼 통과할 수 있다. 즉시 철회는 owner 거부 목록 명령으로만 된다. 위 확인 방법이 Infisical 원본 revision과 대조할 수 있는지는 [미확인]이다.
- owner의 즉시 철회 명령은 봇 DB 거부 목록에 바로 쓰여 ESO 동기화 전에도 효력이 있다. 거부 목록은 동기화를 기다리는 동안의 장치이고, 원본은 Infisical 정책이라 거기서도 지운다.
- 즉시 철회 명령의 경계: owner ID로 검사하는 슬래시 명령이고, 모델을 거치지 않으며, 거부를 더할 수만 있다. 해제는 owner 명령으로 하거나, Infisical 새 revision을 확인한 뒤에 한다. 그래서 `01` §10 비목표 "모델의 정책 자기 수정"(설정 `allow_policy_self_edit: false`)과 부딪히지 않는다 [가정].
- 큐에 든 작업, 예약, 기억 접근, 질문 답도 실행 직전에 같은 검사를 다시 한다(AUTH-02).
- **대가:** Infisical이나 ESO가 최대 나이보다 오래 멈추면 owner도 거부된다. 최대 나이는 이 대가와 철회 지연을 함께 보고 정한다.

## 7. 상태, 영속, 복구

**저장 단위(F02)** [가정: 스키마 초안, T16a에서 확정]: `events`(provider·actor·scope·수신 시각·delivery id·의미적 중복 키), `conversations`·`subscriptions`(스레드·DM·활성 상태), `jobs`(type·owner·target·revision·budget·state·attempt·lease), `questions`(job_id·question_id·유형·대상 사용자·만료), `results`·`evidence`(분류·리비전), `outbox`(대상·멱등 키·전달 상태·외부 ID), `memories`(`01` §8 최소 스키마), `schedules`(시간대·next_run), `audit`.

**상태 값:** `04` §3의 10개(`queued`~`superseded`)를 그대로 쓰고, 작업 결과·GitHub 게시·Discord 전달·PR 병합·배포 상태를 따로 기록한다. 모델 한도 도달·인증 만료 때의 waiting(D-14 조건 2)을 `04` §3 값 중 무엇으로 기록할지는 T16a에서 정한다.

**순서 규칙**

- 수신 → inbox 저장(짧은 타임아웃) → ACK. ACK는 최소 영속 insert가 끝난 뒤에만 보낸다. Discord 상호작용도 같다. 첫 응답(defer 포함)은 3초 안이어야 하지만 [확인: https://docs.discord.com/developers/interactions/receiving-and-responding] 저장 전에 defer하지 않는다. 저장이 그 안에 끝나지 않으면 작업을 받았다고 응답하지 않는다. 다시 시도하라는 명시적 실패를 응답하거나 응답하지 않아, 사용자가 실패를 보게 한다. 저장 전에 defer하면 그 뒤 프로세스가 죽거나 저장이 끝내 실패했을 때, 받은 것으로 보인 요청의 기록이 어디에도 남지 않아 대조할 수 없다 [가정]. 저장 타임아웃 값은 T16a에서 정한다(EVENT-01).
- 저장 타임아웃 뒤 insert가 늦게 commit되면, 사용자는 실패를 봤는데 작업이 돌고 다시 시도한 요청(새 interaction ID)과 중복된다. 그래서 타임아웃 때 서버 쪽 트랜잭션을 취소하고(`statement_timeout` 등), commit 결과를 모르면 그 행을 수락 안 함으로 두고 자동 실행하지 않는다 [가정] (EVENT-01).
- 외부 효과 전에 outbox에 멱등 키를 쓰고, 효과 뒤 외부 ID를 기록한다. 응답을 못 받으면 외부 상태를 먼저 조회한다(EVENT-02). Discord는 `nonce` + `enforce_nonce`로 짧은 창의 중복을 막고(창 길이 미확인), 그 밖은 outbox 대조로 막는다.
- 결과를 모르는 작업은 `unknown`. 자동 재실행하지 않는다(EVENT-04).

**재시작·누락 대조**

| 출처 | 대조 방법 | 한계 |
|---|---|---|
| Discord | RESUME 성공이면 재생. 새 IDENTIFY면 구독 스레드마다 마지막 처리 메시지 이후를 `GET /channels/{id}/messages?after=`로 읽는다. 한 번에 최대 100건이라 저장한 체크포인트부터 페이지를 이어 읽어 빈틈이 없을 때까지 반복하고, 정해진 복구 한도(쪽 수·시간, 값은 T16a)를 넘으면 그 스레드를 `gap` 상태로 기록하고 작업을 진행하지 않는다 [가정] | 새 IDENTIFY 때 놓친 이벤트 재생 여부는 문서에 없다. 보관된 스레드는 연결 때 동기화되지 않으므로 구독 목록 원본은 봇 DB다 |
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

- §5.1의 다섯: 인증 파일을 작업 레인에서 떼는 방법, 작업별 세션 저장 공간(T17 시작 전에 정함)과 인증 파일 되쓰기 방식(취소·`unknown` 작업의 사본 처리 포함)·세션 보존 기간·R17 때 세션 기록 처리, 대화 레인·작업 레인 분리, 구독 인증 Codex의 egress 도메인 [T18, 실측은 T16b], 작업자 제어 끝점 인증 [T16a 계약, T18].
- 작업 종료 사유와 무관한 작업 그룹 정리와 소멸 확인 수단, `unknown` 막힘의 기록·알림·해제(§4) [T18, cgroup 위임·`unshare` 실측은 T08b·T16b].
- 대화 레인의 호출 경로와 동시성, 지연과 직렬 대기 시간 [T16a에서 정하고 T16b에서 측정].
- 작업자 영속 쓰기 공간의 크기와 백업 여부(D-14 조건 4): T08b가 정한다. 모양(PVC 하나, 파일이 없을 때만 시드)은 homelab `rebuild` 변경에서 설계 C.8 격리 행·E4b에 들어갔고, 영속 공간에 첫 시드를 복사하는 것은 T16b(설계 E9)다. 계정 준비와 시드 등록은 T16b 전(모델을 처음 쓰는 단계 전)이다.
- 작업자 이미지의 빌드·배포 경로: 봇 저장소가 두 번째 이미지를 내는지, `platform/sandbox`가 어떤 이미지를 digest로 참조하는지 설계에 없다 [미확인]. `platform/sandbox` 변경은 자동 병합 밖이라 작업자 갱신마다 사람 PR이 될 수 있다 [가정].
- Grafana 질의 템플릿 목록, 시간창 상한, 응답량 상한 수치 [T16a].
- 앱 지표 스크레이프 규칙과 Gateway 단절·큐 적체 봇 룰 [T08b 또는 T16b]. 정해지기 전에는 Gateway만 끊긴 봇을 알리는 경보가 없다(§8).
- 하트비트를 Gateway 연결에 묶는 대안의 채택 여부와 N(§8 "대안") [T16a].
- runtime policy의 현재 revision 확인 방법과 최대 나이(§6 "허용 목록 반영") [T16a].
- 삭제 원장의 저장소·자격·보존, 쓰기 순서와 부분 실패 처리(§7) [T20].
- R08 연결 방식 [T18].
