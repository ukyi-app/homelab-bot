# DECISIONS: 봇 V1 DISCOVERY 결정 기록

> T16a 갱신(2026-10-19): 사용자 결정은 유지한다. 구현 선택은 [ARCHITECTURE §11](ARCHITECTURE.md#11-t16a-확정-계약과-로컬-구현-2026-10-19)에 기록했다. 방안 1(작업자에서 대화·작업 합산 직렬 1), Node 24 런타임, 5분 정책 freshness, 승인 질의 상한, Ed25519 제어 계약, 최근 5분 Gateway 연결 조건의 하트비트를 채택했다. DM 허용 여부·브리핑 시각은 2026-10-20 사용자가 정했다(아래 D-17).

- 단계: `TARGET=V1`, `STAGE=DISCOVERY`, `MODE=plan` (homelab 티켓 T15). 작성일 2026-10-18. 초안.
- **상태: D-14, D-15(남은 부분), D-16, D-17, D-24는 확정(사용자 2026-10-18, T15)이다.** 사용자가 2026-10-18 16:29 T15 질문에 답해 정했다. D-14는 에이전트 추천(B)이 아니라 A를 골랐다. D-15의 코드 읽기 축소는 에이전트 설명을 듣고 골랐다. 나머지는 에이전트 추천을 받아들였다. 결정 기록의 기준은 homelab spec §5.1이고, 이 문서는 선택지·근거·함께 지킬 조건을 남긴다.
- 확정된 결정 안에 남은 미정 세부는 새 결정 ID 없이 담당 티켓에서 정한다(spec §5.3): D-17의 DM 허용 여부와 브리핑 시각은 T16a(확정(사용자 2026-10-20): DM 끔, 브리핑 매일 08:50 Asia/Seoul), D-24의 토큰 분리·ruleset E 여부·App 이름·설치 저장소·허용 파일 경로는 T19(확정(사용자 2026-11-05): 아래 D-24 "T19 세부 결정").
- 같은 응답에서 함께 정한 것: R08 연결 방식은 T18에서 다시 판단하고 그때까지 보류한다(아래 "R08"). V1 범위 조정은 안 3이다([V1_PLAN.md](V1_PLAN.md) §4). 둘 다 T15 질문에 에이전트 추천으로 제시한 안이고 사용자가 골랐다.
- 같은 날 뒤이어 정한 것(사용자 2026-10-18): Codex Connector 설치 범위 축소는 `homelab-bot-ops`에 운영 산출물을 처음 올리기 전에 사람이 한다(아래 D-16 "Codex Connector 설치 범위"). 축소는 완료됐다(사람 2026-10-18 17:45, homelab `approvals.md`). 또 D-29의 비앱 저장소 처리를 `aiops`·`mac-uptime-guard` 제거, `aiops-autodeploy-canary` private 보관으로 바꿨다(사용자 2026-10-18 17:46, 실행 T22).
- PR #3 리뷰 중 정한 것(사용자 2026-10-18): D-14에 T17 차단 조건을 더했다(아래 D-14 "차단 조건").
- 에이전트가 문서끼리 맞춘 정리(사용자 결정 아님): D-14 봇 구독 계정 준비와 작업자 `auth.json` 첫 시드는 T16b 전(모델을 처음 쓰는 단계 전)에 한다. 대화 레인이 T16b에서 처음 모델을 쓰기 때문이다(아래 D-14 "시점").
- 근거 꼬리표: `[확인: 출처]` 공식 문서나 계획 문서, `[실측: 명령과 결과 요지]` 읽기 전용 실행 결과, `[가정]` 근거 있는 추론, `[미확인]` 확인하지 못한 것. 확인일은 모두 2026-10-18이라 꼬리표마다 다시 적지 않는다. 세부 근거는 [DISCOVERY.md](DISCOVERY.md)와 [VERIFICATION.md](VERIFICATION.md)에 있다.
- 실제 값(Discord ID, 허용 목록, 키)은 Infisical `/apps/homelab-bot/`에 사람이 두고, 이 저장소에는 키 이름만 둔다(D-13).
- 바꾸지 않는 것: C-08(V1 7기능 필수, V1~V3 운영 읽기 전용), `00` §6 보안 경계, 요구 ID(F01~F09, R01~R18), 시험 ID(`04` §4), 계약 문구. 결정을 봇 문서에 반영할 때도 `00` §3·§6 본문과 `04` §9 판정 문장은 바꾸지 않고 "> 참고:" 줄만 더한다.

## 한눈에

| ID | 질문 | 결정 | 남은 미정·담당 |
|---|---|---|---|
| D-14 | 봇 모델 계정과 인증 | **변경(사용자 2026-10-30): Claude Code CLI + 구독 장기 토큰(`CLAUDE_CODE_OAUTH_TOKEN`) + 첫 모델 Opus 5.5(`claude-opus-5-5`), 실행기를 설정으로 바꾸는 프로필 구조**(아래 "변경"). 이전 결정: 봇 전용 ChatGPT 구독 계정 + 작업자 전용 CODEX_HOME, 함께 지킬 조건 다섯. 에이전트 추천(B, OpenAI API 프로젝트 키)과 다름. Codex 경로는 프로필 하나로 남았다 | OpenAI 확인 항목 셋 [미확인]. 공개 저장소 문구는 T17 차단 조건(허용 확인이나 공식 지원 인증 전환 전에는 공개 저장소 PR 내용으로 구독 모델을 부르지 않음. 모델을 부르지 않는 T17 로컬·mock 구현은 T16a 뒤 착수, 확정(사용자 2026-10-18, PR #3 리뷰)). T18도 같은 차단(확정(사용자 2026-10-18, PR #3 리뷰)). → **해제(사용자 2026-11-04, Claude 구독 프로필)**: 아래 "차단 조건"의 "재조사와 해제". 계정 준비와 첫 시드: T16b 전(모델을 처음 쓰는 단계 전). 영속 쓰기 공간의 크기·백업(T08b) |
| D-15 | 실행 호스트, 라벨·포트, 코드 읽기 호스트 | NUC 클러스터 안. 라벨 `homelab-bot`, 앱·작업자 포트 8080, 경보 수신 포트 8081. 작업자 코드 읽기는 `codeload.github.com` 압축본만 | U13·U29와 프록시 경유 압축본 받기 실측(T08b·T16b) |
| D-16 | PR 리뷰 방식 | 기본안. 봇 리뷰 저장소의 Codex 자동 리뷰는 저장소별 설정에서 끔. Connector 설치는 선택 저장소로 줄이고 운영 저장소는 뺌(축소 완료, 사람 2026-10-18 17:45). 하위 결정: 허용 봇 작성자 목록 | 남긴 저장소 목록의 API 확인(사용자 보고만 있음). 리뷰 대상 저장소 목록과 리뷰 App 이름, 리뷰 App 권한 확인(Issues read 포함, 설계 세부)(T17) |
| D-17 | Discord 서버, 채널, 허용 사용자 | 봇 전용 개인 서버 신설, 허용 사용자 owner 1명, 채널 2개, `MESSAGE_CONTENT` 켬. DM 끔, 브리핑 매일 08:50 Asia/Seoul(확정(사용자 2026-10-20, T16a)) | 없음 |
| D-24 | 봇 변경 PR 작성 신원 | 봇 전용 쓰기 GitHub App(Contents·Pull requests write, Metadata read). 세부(사용자 2026-11-05): 이름 `ukyi-writer`, 토큰 두 종류, 설치 저장소마다 ruleset E(`bot/**/*` 생성·갱신·삭제), smoke 먼저 설치, 저장소별 좁은 허용 경로 | App 생성·설치와 키 등록(사람), 실제 writer 신원의 AC-P8 시험(T19) |

---

## D-14 봇 모델 계정과 인증

**상태:** **변경(사용자 2026-10-30): Claude Code CLI + 구독 장기 토큰 + Opus 5.5 + 실행기 프로필 구조**(바로 아래 "변경"). 이전: 확정(사용자 2026-10-18, T15). **A: 봇 전용 ChatGPT 구독 계정 + 작업자 전용 CODEX_HOME.** 에이전트 추천은 B(OpenAI API 전용 프로젝트 + 서비스 계정 키)였다. 사용자는 추천이 아닌 A를 골랐다. T17 차단 조건을 더했다(확정(사용자 2026-10-18, PR #3 리뷰), 아래 "차단 조건").

### 변경 (사용자 2026-10-30): Claude Code CLI·구독 장기 토큰·Opus 5.5·실행기 프로필

**결정(사용자 2026-10-30, 그대로 기록).**

1. 봇 모델 실행기는 **Claude Code CLI**다. 인증은 **구독 장기 토큰**(`claude setup-token`이 만드는 1년 토큰, 실행 env `CLAUDE_CODE_OAUTH_TOKEN`)이다. API 키가 아니다.
2. 첫 모델은 **Opus 5.5**(`claude-opus-5-5`)다.
3. 바꾸기 쉬운 구조가 중요하다: "추후 쉽게 claude, codex, opencode 등 변경하기 용이하게." 목표는 **이미 지원하는 실행기 사이 전환이 설정 PR 하나 + 자격 하나**다. 아직 지원하지 않는 실행기(예: OpenCode)를 처음 넣는 일은 어댑터·이미지·시험 개발이 따로 든다.

**에이전트 추천과 다른 점(기록).** Claude 인증 조사의 추천은 봇 전용 Console service account API 키 + `claude -p --bare`였다(제품 인증 지침·비용 통제·철회가 더 명확하다는 이유). 사용자는 구독 장기 토큰을 골랐다. 조사가 확인한 사실: `setup-token`은 공식 CI·스크립트 경로이고 1년 토큰이며 파일에 저장하지 않는다. `--bare`는 이 토큰을 읽지 않는다. 철회는 Claude Settings의 Claude Code 토큰 삭제다. 2026-10-07 기준 구독으로 로그인한 `claude -p`는 구독 한도를 쓴다 [확인: https://code.claude.com/docs/en/iam , https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan].

**구현(T16b, 이 저장소. 상세는 [ARCHITECTURE.md](ARCHITECTURE.md) §12 "T16b 실행기 프로필").**

- 게시 서버와 작업자의 HTTP v1은 그대로다. 작업자 안을 **공통 실행 제어 + 작은 실행기 어댑터 + 프로필 선택 + 이미지 하나**로 나눴다.
- 프로필은 작업자 env 세 개로 고른다: `WORKER_EXECUTOR`(실행기), `WORKER_CREDENTIAL_KEY`(자격 키 이름 = 인증 방식), `WORKER_MODEL`. 지원 프로필은 `claude-subscription`(claude, `CLAUDE_CODE_OAUTH_TOKEN`, 모델은 `claude-`로 시작하는 전체 ID)과 `codex-subscription`(codex, `CODEX_AUTH_JSON`, 모델 `cli-default` = CLI 기본값) 둘이다. 표에 없는 조합·별칭 모델은 기동 실패이고 다른 프로필로 몰래 돌아가지 않는다.
- 자격 방식은 실행기 이름과 따로 두 가지다. `env-static`(Claude 토큰): Secret 볼륨 파일을 실행마다 다시 읽어 그 실행의 자식 env 한 변수에만 넣는다. 영속 공간에 복사하거나 되쓰지 않는다. `file-mutable`(Codex auth.json): 기존 시드·되쓰기 규칙 그대로다.
- 이미지에는 Claude Code CLI **2.1.308**(npm `stable` 태그)과 Codex CLI 0.163.0을 둘 다 고정 설치한다. 그래서 두 프로필 사이 전환에 이미지 재빌드가 필요 없다.

**함께 지킬 조건 다섯의 새 적용.**

1. 개인 홈 금지: `~/.codex*`에 더해 `~/.claude*`(`.claude.json` 포함)도 경로 모양으로 거부한다. 유지.
2. 한도·인증 만료 때 자동 전환 금지: 유지. `--fallback-model`을 쓰지 않고, 다른 모델·계정·실행기로 넘어가지 않고 waiting으로 둔다. Opus 5.5의 내용 기반 자동 모델 전환도 env로 끄고, 전환 이벤트나 다른 모델의 응답이 보이면 그 실행을 실패로 닫는다(모델 고정, 리뷰 exec-r1 P1).
3. 직렬 1개: 유지. Claude 토큰에는 Codex 같은 "사본 하나당 직렬 흐름 하나" 문서 조건이 없지만, 구독 한도와 작업자 구조(D-15, SerialWorker)가 전제라 그대로 둔다.
4. 영속 쓰기 공간: Claude 프로필은 자격 되쓰기가 없다. **PVC는 nonce(T16b D3) 때문에 유지한다.** Codex 프로필로 돌아갈 때 쓰도록 CODEX_HOME 자리도 그대로 둔다.
5. CLI 밖 OAuth 프록시·여러 계정 순회 금지: Claude에도 같은 뜻으로 유지한다. 구독 토큰은 Claude Code CLI 안에서만 쓰고 계정은 하나다.

**변경(사용자 2026-11-09, 아래 "동료 봇 전환" 7·8).** 조건 2의 자동 전환 금지는 유지한다. 한도 멈춤의 재개는 사람 재개에서 CLI가 알려 준 풀리는 시각의 자동 재개(같은 계정)로 바뀐다. 조건 5의 "계정은 하나다"는 "봇이 쓰는 계정은 한 번에 하나이고, 바꾸는 건 owner가 CLI로만 한다. 봇은 스스로 바꾸지 않는다"로 바뀐다. 쓰는 방식에 API 크레딧(Claude Console API 키)이 더해진다.

**남는 것.**

- **공개 저장소 차단(아래 "차단 조건")은 이 변경으로 풀리지 않는다.** 그 조건은 OpenAI 문구에서 나왔지만, Claude 구독 경로로 공개 저장소 PR 내용을 처리해도 되는지는 따로 정한다. 조사는 Claude 문서에서 일괄 금지는 찾지 못했고, 한국 적용 Consumer Terms 본문은 [미확인], Code 법적 안내는 제품·서비스에는 API 키 인증을 권한다. T17·T18 실호출 전 사용자 결정이 필요하다. → **해제(사용자 2026-11-04, Claude 구독 프로필)**: 아래 "차단 조건"의 "재조사와 해제".
- 같은 파드·UID의 비신뢰 코드가 자격을 읽을 수 있다는 [ARCHITECTURE.md](ARCHITECTURE.md) §5.1의 남는 위험은 토큰에도 같다. T16b 대화 레인은 도구를 끈 채 돌아 비신뢰 코드 실행이 없다.
- 사람 작업: 봇에 쓸 Claude 구독 계정에서 `claude setup-token`으로 토큰을 만들고 Infisical `/apps/homelab-bot/worker`의 키 `CLAUDE_CODE_OAUTH_TOKEN`에 넣는다(개인 `~/.claude*`를 복사하지 않는다). 모델 개선 사용 설정(claude.ai 데이터 설정)을 확인한다. 만료(1년) 전 교체 알림과 유출 때 철회 절차(Settings → Claude Code)를 둔다.
- 첫 승인 대화(S12)에서 확인: 실제 stream-json 모양과 `system/init`의 `model`·`apiKeySource`·`tools` 값, `--tools ""`와 구조화 출력의 동시 동작, 한도·인증 오류의 실제 필드, egress 호스트, 메모리.

이전 결정(A, ChatGPT 구독 + CODEX_HOME)과 그 근거·차단 조건은 아래에 기록으로 둔다. Codex 프로필을 고르면 그 조건이 그대로 다시 적용된다.

**질문:** 봇이 모델(Codex)을 부를 때 어떤 계정과 인증을 쓰는가. spec §5.3의 추천 기본값은 "전용 계정과 전용 CODEX_HOME. 자동 호출 약관 확인 후 결정"이었다. 봇 문서는 구독 플랜의 사용 조건을 자동 호출 권한으로 가정하지 말라고 한다(`01` §3 질문 7).

### 함께 지킬 조건 (결정의 일부)

1. **개인 CODEX_HOME을 쓰거나 복사하지 않는다**(`00` §8, `01` §6). 사람이 쓰는 계정과 봇 자격을 섞지 않는다.
2. **한도 도달·인증 만료 때 다른 계정이나 다른 인증으로 자동 전환하지 않고 waiting으로 둔다**(`00` §7 7항). 관측하지 못한 사용량은 0이 아니라 null로 남긴다.
3. **작업은 직렬 1개(동시성 1)다.** 공식 문서는 `auth.json` 사본 하나를 "only one machine or serialized job stream"만 쓰게 하고 "Do not share the same file across concurrent jobs or multiple machines."라고 한다 [확인: https://learn.chatgpt.com/docs/auth/ci-cd-auth]. 작업자 안의 대화 레인과 작업 레인이 이 사본 하나를 쓰면 둘을 합쳐 한 번에 하나다 [가정]. 영향과 열린 항목은 [ARCHITECTURE.md](ARCHITECTURE.md) §5.1.
4. **Codex가 갱신한 인증 파일을 되쓰도록 작업자 전용 영속 쓰기 공간을 둔다.** Codex는 `last_refresh`가 약 8일을 넘으면 토큰을 갱신해 `auth.json`에 다시 쓴다. 공식 문서는 갱신본을 실행 사이에 보존하고 원래 시드로 매번 덮지 말라고 한다 [확인: https://learn.chatgpt.com/docs/auth/ci-cd-auth]. 설계 C.8은 작업자 자격을 Infisical `/apps/homelab-bot/worker`에서 ESO로만 받으므로 이 공간은 **설계 C.8 변경**이고 T08b·T16b가 반영한다.
5. **Codex 밖 구독 OAuth 프록시와 여러 계정 순회를 쓰지 않는다.** 공식 지원 밖이라 채택하지 않는다(아래 "검토 후 제외" E).

### 남는 위험 (spec §10 7번)

- **공개 저장소 문구:** 구독 인증의 무인 실행 안내는 이 경로를 "advanced workflow for enterprise and other trusted private automation"으로 두고 "Do not use this workflow for public or open-source repositories."라고 적는다 [확인: https://learn.chatgpt.com/docs/auth/ci-cd-auth]. 봇이 리뷰하는 저장소는 public이다(D-29). 이 문구가 실행 위치를 말하는지 다루는 코드를 말하는지는 [미확인]이다. OpenAI에 확인할 항목으로 남기고, 풀리기 전에는 공개 저장소 PR 내용으로 구독 모델을 부르지 않는다(아래 "차단 조건").
- **OpenAI 확인 항목 세 가지:** 위 공개 저장소 문구의 범위, 개인용 이용 약관의 자동 추출 조항이 Codex CLI 무인 실행에 적용되는지, 한 사람이 봇 전용 두 번째 개인 ChatGPT 계정을 두는 것의 허용 여부. 셋 다 공식 해석이 없어 [미확인]이고 OpenAI에 확인한다. 조항별 검토는 이 공개 문서에 두지 않는다.
- **되쓰기:** 파드를 다시 만들 때 옛 시드로 덮으면 회전된 갱신 토큰과 어긋나 사람이 다시 시드해야 한다 [확인: https://learn.chatgpt.com/docs/auth/ci-cd-auth 의 재시드 조건]. 작업별 세션 저장 공간을 나눌 때도 조건 4를 깨지 않는다. 예는 작업별 쓰기 가능 사본을 제어 프로세스가 직렬로 되쓰는 방식이다 [가정]. 취소·`unknown` 작업의 사본 처리는 T18이다(ARCHITECTURE §5.1).
- **직렬 1개와 한도:** 긴 작업 중에는 대화도 기다린다(조건 3). 5시간·주간 한도는 공식 문서가 고정 수치가 아닌 추정치로 적어 예측하기 어렵다 [확인: https://learn.chatgpt.com/docs/pricing].
- **같은 파드의 비신뢰 코드:** 장기 갱신 토큰이 든 `auth.json`이 PR 코드의 설치·시험이 도는 작업자 파드에 있다. 대책과 남는 위험은 ARCHITECTURE §5.1이다.
- **학습 사용:** Free·Plus·Pro 입력은 기본으로 모델 개선에 쓰일 수 있고 설정에서 끈다 [확인: https://help.openai.com/en/articles/5722486]. 봇 계정을 준비할 때 이 설정을 확인한다.

### 차단 조건 (확정(사용자 2026-10-18, PR #3 리뷰). Claude 구독 프로필에서 해제(사용자 2026-11-04))

PR #3 리뷰에서 공개 저장소 문구를 남는 위험으로만 두면 지원되지 않는 인증 방식으로 공개 저장소 리뷰를 운영할 수 있다는 지적이 나왔고, 사용자가 "T17 전 차단 조건 추가"로 답했다.

- 조건: OpenAI가 공개 저장소 PR 리뷰에 봇 전용 구독 인증 사용을 허용한다고 확인했거나, API 키 등 공식 지원 인증으로 바꿨을 것.
- 범위: 모델을 부르지 않는 로컬·mock 구현은 T16a 뒤 착수할 수 있다. 공개 저장소 PR 내용으로 구독 모델을 부르는 일(평가셋, `authorized_external`, 시범 P-2)은 차단 조건이 풀린 뒤에만 한다.
- 그 전 단계(T16a·T16b, 대화 레인)는 그대로 진행한다.
- 인증 전환은 D-14 변경이라 사용자 결정과 설계 C.8 검토가 필요하다.
- T18 범위: T18도 같은 차단을 받는다(확정(사용자 2026-10-18, PR #3 리뷰)): 허용 확인이나 공식 지원 인증 전환 전에는 공개 저장소 코드로 구독 모델을 부르는 T18 작업을 하지 않고, 모델을 부르지 않는 로컬·mock 구현만 T16a 뒤 착수한다. T19는 T17 뒤라 함께 기다린다.
- 반영 자리: [V1_PLAN.md](V1_PLAN.md) 머리말·§1·§2 T17 진입 조건·§3 REVIEW-01·§4 시범 운영 단계·§5 T17 행, [PROJECT_STATUS.md](PROJECT_STATUS.md) 결정 행·STAGE 진행표·주요 위험·다음 행동, [VERIFICATION.md](VERIFICATION.md) "모델 인증 형태 (D-14)" 행, [DISCOVERY.md](DISCOVERY.md) §10, 설정 초안 `codex.auth` 주석.

#### 재조사와 해제 (사용자 2026-11-04)

**재조사(2026-11-04, 에이전트, 공식 문서 원문 확인).** Claude 구독 토큰으로 공개 저장소 PR·코드를 처리해도 되는지 다시 봤다.

- 허용 쪽 근거:
  - Claude 문서에 공개 저장소 사용을 막는 문장은 없다.
  - `claude setup-token`은 공식 CI·스크립트 경로다 [확인: https://code.claude.com/docs/en/iam].
  - Claude Code GitHub Actions도 `claude_code_oauth_token`을 공식 입력으로 받고 PR 리뷰 예시를 둔다 [확인: https://code.claude.com/docs/en/github-actions].
- 불리한 근거:
  - Claude Code Legal and compliance는 제품·서비스를 만드는 개발자에게 API 키 인증을 쓰라고 한다. 사용자를 대신해 구독 자격으로 요청을 보내는 것은 금지한다 [확인: https://code.claude.com/docs/en/legal-and-compliance].
  - Consumer Terms(한국판 KR 포함, 2025-10-08 시행)는 API 키나 명시적 허용 없이 봇·스크립트로 자동 접속하는 것을 금지 행위로 둔다 [확인: https://www.anthropic.com/legal/consumer-terms/KR].
  - 2026-11-12 시행 Usage Policy는 "Do Not Abuse Our Platform"에 "services that route requests through consumer subscriptions"를 새로 넣었다(2025-09-15 판에는 없음) [확인: https://www.anthropic.com/legal/aup].
  - Anthropic은 이 제한을 사전 통지 없이 집행할 수 있다고 적는다.
- 판단 [해석]: owner 한 사람만 쓰고 자격도 owner 것 하나라 문자 그대로는 "남에게 제공"에 걸리지 않는다. 그래도 "허용 확인"이라 할 공식 문장은 없다. 금지를 확인한 문장도 없다. 회색 지대다.
- 에이전트 추천(채택되지 않음): 자격만 Console API 키로 바꾼다. Claude Code CLI·Opus 5.5·프로필 구조는 그대로 둔다. 월 비용은 Opus 5.5 공식 단가로 리뷰 $5~26, T18 $12~18 정도다. Max·Ultra 플랜이면 월 API 크레딧이 덮는다.

**함께 본 대안(채택되지 않음).**

- 저장소 비공개 전환:
  - org를 GitHub Team으로 바꿔 비공개로 돌리는 안은 가능하다.
  - 대가가 있다. 공개 저장소에서 무료인 GitHub 비밀 검사·push 차단을 잃거나(Secret Protection은 활성 커미터당 월 $19) 돈을 내야 한다. Argo CD 저장소 자격과 이미지 pull 자격처럼 새 자격이 는다. D-23·D-29·D-13도 되돌려야 한다.
  - 개인 계정으로 옮기는 안은 ruleset bypass 목록이 org 저장소에서만 되어 배포 App 자동 병합 구조(D-07)가 깨진다.
- 공개 저장소로 남겨도 되는 근거(2026-11-04 실측):
  - 6개 저장소 모두 비밀 검사·push 차단이 켜져 있다.
  - fork PR은 org·저장소 모두 `all_external_contributors`다.
  - T17은 작성자가 OWNER·MEMBER·COLLABORATOR이거나 허용 목록에 있는 봇일 때만 모델에 보낸다. fork PR은 막는다(`src/review.ts` `authorAllowed`).

**결정(사용자 2026-11-04, 그대로 기록).**

1. 구독 토큰을 유지한다("일단은 구독 유지로 진행하자").
2. 저장소는 공개로 유지한다.
3. 이 차단 조건을 **Claude 구독 프로필에서 해제**한다("그래 그렇게해").

해제 뒤에는 공개 저장소 PR·코드로 구독 모델을 부르는 일(평가셋, `authorized_external`, 시범 P-2, T18 실연동)을 각자의 다른 진입 조건을 지킨 뒤에 할 수 있다.

**해제가 바꾸지 않는 것.**

- T17 진입 조건 가운데 나머지는 그대로다: 작업별 세션 저장 공간 결정(ARCHITECTURE §5.1), D-16 결과, 리뷰 App(사람), 시범 P-2 사람 승인. T18 결정 대기 4건도 그대로다.
- 작업자 파드의 비신뢰 코드가 자격을 읽을 수 있는 위험(ARCHITECTURE §5.1)은 이 차단과 별개다. T18 결정 (2)에서 다룬다.
- Codex 프로필(`codex-subscription`)로 돌아가면 OpenAI 문서 문구가 그대로라 이 차단이 다시 적용된다.

**남는 위험(사용자 수용).**

- 약관 해석이 갈린다. 2026-11-12 Usage Policy도 함께 걸린다.
- 사전 통지 없는 집행이 봇 토큰을 만든 계정에 닿는다.
- 리뷰·작업 호출이 그 계정의 구독 한도를 함께 쓴다.

정책 문구가 바뀌거나 Anthropic이 통지하면 다시 본다. 조사 원문은 비공개 작업 문서(2026-11-04 D-14 재조사)에 있다.

### 선택지 (기록)

| 선택지 | 내용 | 장점 | 단점·대가 |
|---|---|---|---|
| **A (선택)** | 봇 전용 ChatGPT 개인 계정(구독) + 작업자 전용 CODEX_HOME(`auth.json`) | 고정 비용(Plus 월 $20, Pro 월 $100 이상). 사람 계정과 한도가 분리된다 | 공식 문서상 "고급" 경로이고 조건 다섯이 모두 참이어야 한다. "public or open-source repositories"에 쓰지 말라는 문구가 있다. `auth.json` 하나당 한 기기 또는 직렬 작업 하나. 약 8일마다 갱신본을 되써야 해서 영속 쓰기 공간이 필요하다(설계 C.8 변경). 5시간·주간 한도를 예측하기 어렵다 |
| B (에이전트 추천) | OpenAI API 전용 프로젝트 + 프로젝트 서비스 계정 키. 작업자에는 세션 기록용 전용 CODEX_HOME만 | 공식 문서가 자동화 기본값으로 권한다. API 약관이 내 앱을 다른 사용자(End User)에게 제공하는 것을 허용한다. 되쓰기가 없어 설계 C.8(작업자 자격 하나, ESO 한 방향 전달)을 그대로 쓴다. 프로젝트 하드 지출 한도, 키 권한 제한, 모델 허용 목록을 걸 수 있다. 입력이 기본으로 학습에 쓰이지 않는다 | 사용량 비례 변동 비용. 옛 AIOps의 사용자 선택("구독만, API 과금 제외")과 다르다 |
| C | ChatGPT Business 워크스페이스 + Codex access token | 비인간 신원용 공식 경로 | 최소 2좌석(약 월 $40~50 [가정: 좌석 가격 × 2]). 서비스 계정은 pay-as-you-go 플랜에만 있다. 1인 홈랩에 과하다 |

검토 후 제외:

- **D. Sign in with ChatGPT "ChatGPT plan usage"**: 오픈소스·로컬 앱용 preview이고 무인 봇이 범위인지 문서에 없다 [미확인].
- **E. Codex 밖 구독 OAuth 프록시로 일반 API를 만들고 여러 계정을 순회하는 방식**: 공식 지원 밖이라 채택하지 않는다. 구독 무인 실행 안내도 "generic OAuth clients outside Codex"를 적용 밖으로 둔다 [확인: https://learn.chatgpt.com/docs/auth/ci-cd-auth].

### 근거

- [확인: https://learn.chatgpt.com/docs/auth] "API keys are still the recommended default for automation." "Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs."
- [확인: https://learn.chatgpt.com/docs/auth/ci-cd-auth] 구독 인증의 무인 실행은 "advanced workflow for enterprise and other trusted private automation"이다. 쓸 조건 다섯이 모두 참이어야 한다: ChatGPT 관리 인증이 필요함, 원격 실행기에서 `codex login`을 할 수 없음, 실행기가 신뢰하는 사설 인프라임, 갱신된 `auth.json`을 실행 사이에 보존할 수 있음, 한 기기나 직렬 작업 흐름 하나만 사본 하나를 씀. "Do not use this workflow for public or open-source repositories."
- [확인: https://openai.com/policies/row-terms-of-use/ , Effective 2026-01-01. 직접 조회가 403이라 공개 리더 중계로 본문을 읽었다] 개인용 이용 약관. A와 닿는 조항은 위 "OpenAI 확인 항목 세 가지"로만 남긴다.
- [확인: https://openai.com/policies/services-agreement/ , Effective 2026-01-01. 같은 방식으로 읽음] 2.2 Customer Application을 End User에게 제공 허용. 3.1 사용자 사이 자격 공유 금지. 3.3 Usage Limits 우회 금지. B의 근거였다.
- [확인: https://developers.openai.com/api/docs/guides/spend-limits] 조직·프로젝트 하드 지출 한도를 넘으면 429(`project_spend_limit_exceeded`). 집행이 즉시는 아니라 기록 지출이 조금 넘을 수 있다. B의 근거였다.
- [확인: https://learn.chatgpt.com/docs/pricing , https://developers.openai.com/api/docs/pricing] Plus 월 $20, Pro 월 $100·$200·$500. API Key 요금제 칸은 "Great for automation in shared environments like CI"이고 GitHub code review 같은 클라우드 기능이 없다. gpt-6.1-sol 짧은 맥락 가격은 1M 토큰당 입력 $2.00, 캐시 입력 $0.10, 캐시 쓰기 $2.50, 출력 $10.00이다. 긴 맥락 가격은 따로 있다(입력 $4.00 등). 긴 맥락이 시작되는 토큰 수는 가격표에서 확인하지 못했다 [미확인].
- [실측: `codex --version` → codex-cli 0.163.0, `codex login --help` → `--with-api-key`·`--with-access-token`·`--device-auth`] 설치된 CLI가 세 인증 형태를 모두 받는다. `codex exec --help`의 `--ignore-user-config`는 "auth still uses `CODEX_HOME`"이라 작업자의 CODEX_HOME은 반드시 전용이어야 한다.

### 에이전트 추천 (기록, 채택되지 않음)

**B.** 공식 문서가 자동화 기본값으로 명시하고, API 약관이 다른 사용자가 쓰는 앱을 허용하며, 플랫폼 설계를 바꾸지 않는다는 이유였다. 대가는 변동 비용이었다. 예를 들어 gpt-6.1-sol로 입력 15만 토큰(그중 10만 캐시) + 출력 1.5만 토큰인 리뷰 1건은 약 $0.26이다 [가정: 토큰 수는 예시, 가격은 위 확인값]. 이 값은 캐시 쓰기와 긴 맥락 가격을 넣지 않았다. 캐시 입력 10만 토큰을 처음 쓸 때는 캐시 쓰기($2.50/1M)로 약 $0.25가 더 든다.

### 남은 사람 작업 (`approvals.md` 기록)

- 봇 전용 ChatGPT 계정 준비와 플랜 선택(Plus 월 $20, Pro 월 $100 이상). 학습 사용 설정 확인.
- 시드 `auth.json` 만들기와 Infisical `/apps/homelab-bot/worker` 등록. 개인 CODEX_HOME이 아닌 빈 전용 디렉터리에서 로그인해 만든다 [가정: ci-cd-auth의 "원격 실행기에서 로그인할 수 없을 때" 흐름]. 키 이름 제안은 ARCHITECTURE §5.
- OpenAI 확인 세 가지: 공개 저장소 문구의 범위, 자동 추출 조항의 적용, 봇 전용 두 번째 개인 계정의 허용. 공개 저장소 문구는 공개 저장소 PR 내용으로 구독 모델을 부르기 전에 풀려야 한다(위 "차단 조건").
- 시점: 계정 준비와 작업자 `auth.json` 첫 시드는 T16b 전(모델을 처음 쓰는 단계 전)에 한다. 대화 레인이 T16b에서 처음 모델을 쓰기 때문이다. 설계 E9(T16b)의 사람 작업과 만들 것(작업자 영속 공간에 첫 시드)과 같다. 그 뒤 T17·T18은 이 계정을 그대로 쓴다. 이 시점은 결정 기록끼리 맞추려고 에이전트가 정리한 것이고 사용자 결정이 아니다. 반영 자리는 [V1_PLAN.md](V1_PLAN.md) §2·§5.

---

## D-15 봇 실행 호스트와 작업자 격리 (남은 부분)

**상태:** 확정(사용자 2026-10-18, T15). (1) 1a, (2) 아래 값, (3) 3b와 그 세부. 코드 읽기 축소(3)는 에이전트 설명을 듣고 골랐다. 설명의 요지는 "작업자에 D-14 구독 인증 파일이 있어 GitHub 호스트를 허용하면, 작업 입력에 심긴 남의 토큰으로 gist나 push를 만들어 인증 파일을 내보낼 수 있다"였다. 나머지는 에이전트 추천을 받아들였다.

**이미 정해진 것:** 격리 작업 공간의 기본 방식은 설계 C.8 기본값이다(확정(사용자 2026-10-18, T05)): ns `sandbox`(작업자) + ns `egress`(허용 목록 프록시), 작업자 Secret은 Infisical `/apps/homelab-bot/worker`의 모델 자격 하나.

### 결정 내용

- **실행 호스트:** NUC k3s 클러스터 안. 게시 서버는 ns `app-homelab-bot`의 공유 차트 Deployment(replicas 1), 작업자는 ns `sandbox`의 상주 파드이고 동시성 1이다(D-14 조건 3).
- **라벨·포트:** 앱 라벨 `homelab-bot`, 게시 서버 앱 포트 8080, 작업자 포트 8080, 경보 수신 포트 8081.
- **코드 읽기:** 작업자는 `codeload.github.com` 압축본만 받는다. 작업자 egress에서 `github.com`·`api.github.com`·gist를 뺀다. 작업자에는 GitHub 자격이 없다. 받은 코드는 작업자가 `git init`으로 한 번 커밋해 `codex exec`의 Git 저장소 요구를 맞춘다. diff는 base·head 압축본으로 만든다. 리뷰 입력의 변경 목록은 압축본 비교만으로 정하지 않고, 게시 서버가 head·base SHA를 먼저 고정한 뒤 같은 SHA 쌍으로 리뷰 App 토큰으로 Git tree API(recursive)나 compare API에서 경로·mode·object ID 차이(submodule gitlink 포함)를 열거한다. 압축본은 같은 SHA의 blob 내용 수집에만 쓴다 [가정](설계 세부, 사용자 결정 아님. ARCHITECTURE §6). push와 PR 생성은 게시 서버가 D-24 App으로 한다.
- **물러날 곳:** 파드 방화벽(U13)이 안 되면 작업자만 호스트 전용 UID + nft로 옮긴다(1b).

### (1) 실행 호스트 (기록)

| 선택지 | 내용 | 판단 근거 |
|---|---|---|
| **1a (선택)** | NUC k3s 클러스터 안. 게시 서버는 ns `app-homelab-bot`의 공유 차트 Deployment(replicas 1), 작업자는 ns `sandbox`의 상주 파드 | 설계 C.8 그대로 [확인: platform/design.md C.8]. 영속 상태는 공유 PostgreSQL의 봇 전용 DB(D-05) |
| 1b (물러날 곳) | 작업자만 NUC 호스트의 전용 UID + nft(옛 AIOps 방식) | 설계가 적은 대안이고 init 방화벽(U13)이 안 될 때만 쓴다 [확인: 설계 C.8, 부록 1 U13]. 옛 방식은 운영 부담이 컸다: 2026-10-15 의존성 누락으로 약 1분 사이 8번 재시작 실패, 약 43KB 자체 설치기, 자동 감시 없는 90일 인증서 수동 교체 [실측: journalctl, 옛 aiops 트리] |
| 1c | herdr나 사람의 Codex 세션 위에서 호스트 실행 | 고르지 않음. 사람의 herdr 소켓은 사용자 소유 0600이고 소켓 API에 인증이 없어, 닿으면 개인 패널 전체를 제어한다 [실측: `stat`. 확인: https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/website/src/content/docs/socket-api.mdx]. `00` §6 "호스트 소켓 전달 금지", F03과 어긋난다 |

작업자 구조 [가정]: 작업자 파드 안의 작은 상주 프로세스가 봇이 정한 HTTP 계약으로 작업을 받고, 작업마다 `codex exec --json`을 띄운다. 모델 호출은 동시성 1이다(D-14 조건 3). 작업 단위 파드는 ValidatingAdmissionPolicy로 파드 모양을 고정한 뒤에만 둔다(설계 C.8).

**작업자 제어 끝점** (설계 세부, 사용자 결정 아님. 결정은 T16a(계약)·T18): 상주 제어 프로세스의 HTTP 끝점은 같은 파드에서 도는 작업 프로세스(PR의 설치 스크립트·시험, 모델의 셸 명령)가 loopback이나 파드 IP로 닿을 수 있다. Service 쪽 NetworkPolicy는 파드 안 경로를 가르지 않고 [가정], init 방화벽(U13)도 loopback을 허용한다 [확인: 설계 부록 1 U13]. 인증이 없으면 악성 코드가 모델 작업을 넣어 구독 한도를 쓰거나 상태·취소 요청을 보낼 수 있다. 제안 [가정]:

- 게시 서버가 요청마다 서명한 단기 capability(작업 ID, 만료, 한 번만 쓰는 값을 묶음)를 요구한다.
- 키는 제어 프로세스만 읽는 파일에 둔다. 작업 프로세스는 다른 UID와 정리된 환경으로 띄워 키와 capability를 물려받지 않게 한다. 다른 UID는 ARCHITECTURE §5.1의 `auth.json` 분리와도 겹친다.
- HMAC 같은 대칭 키를 쓰면 작업자에 모델 자격 밖의 비밀이 하나 더 생겨 설계 C.8("작업자 Secret은 모델 자격 하나")의 변경이 된다. 게시 서버만 개인 키를 갖는 서명이면 작업자에는 공개 키만 있다.
- 대안: 작업을 별도 네트워크 namespace에서 돌려 제어 끝점에 닿지 못하게 한다.
- 시험: SEC-02에 "작업 프로세스가 제어 끝점을 부르면 거부"를 넣는다([V1_PLAN.md](V1_PLAN.md) §3).

함께 알 위험: Codex의 Linux 샌드박스(bwrap + seccomp)가 파드 안에서 동작하는지 [미확인]. 안 되면 공식 안내대로 파드를 경계로 두고 `--sandbox danger-full-access`로 돌린다. 그러면 모델의 셸이 모델 자격을 읽을 수 있다 [확인: https://learn.chatgpt.com/docs/agent-approvals-security]. 어느 경우든 `shell_environment_policy`를 고정해야 한다. 기본값은 `KEY`·`SECRET`·`TOKEN` 이름의 변수를 모델이 띄우는 명령에 넘긴다 [확인: https://learn.chatgpt.com/docs/config-file/config-advanced].

### (2) 라벨·포트 (결정값)

`platform/bot-slot/values.yaml`의 `target` 하나(ns, 앱 라벨, 작업자 포트, 경보 수신 포트)가 봇 쪽 NetworkPolicy, sandbox ingress 출처, SA `bot-reader`의 ns를 함께 정한다. 작업자 포트는 `platform/sandbox`의 작업자 컨테이너 포트와 같아야 한다 [확인: 설계 C.8 "봇 자리 Application", E9].

| 항목 | 결정값 | 근거 |
|---|---|---|
| 앱 라벨 `homelab.ukyi.app/app` | `homelab-bot` | 설계 E9가 이미 이 값을 적었다. D-13 이름 규칙과 같다 |
| 게시 서버 앱 포트(webhook 수신) | 8080 | 공유 차트 예시 `port: 8080` [확인: 설계 C.4.5 예시] |
| 경보 수신 포트 | 8081 | 앱 포트와 나누면 Traefik(공개 webhook)과 Alertmanager(클러스터 안)의 허용을 포트로 가를 수 있다 [가정]. 같은 포트에 경로로 나누는 대안은 더 단순하지만 NetworkPolicy로 둘을 구분하지 못한다 |
| 작업자 포트 | 8080 | 작업자는 다른 파드라 게시 서버 포트와 겹쳐도 된다 [가정] |

### (3) 코드 읽기를 읽기 전용 호스트로 좁힐지 (기록)

설계 C.8의 남는 위험: 프록시는 CONNECT의 호스트 이름만 봐서 `github.com`을 허용하면 읽기와 쓰기를 가르지 못한다. 작업 입력에 심긴 남의 토큰으로 push하거나 gist를 만들 수 있다 [확인: 설계 C.8]. D-14 A로 작업자에 구독 인증 파일이 있어 이 위험이 커졌다.

| 선택지 | 내용 | 대가 |
|---|---|---|
| 3a | 좁히지 않음. `github.com`·`api.github.com` 허용 | `git clone`과 히스토리를 쓴다. 위 쓰기 유출 위험이 남는다 |
| **3b (선택)** | `codeload.github.com`(브랜치·태그·커밋 압축본)만 허용 | 히스토리(`git log`, `blame`)가 없다. `codex exec`는 Git 저장소 안에서만 돌아서 [확인: https://learn.chatgpt.com/docs/non-interactive-mode] 압축본을 푼 뒤 `git init`으로 한 번 커밋한다. 작업자는 diff만 내고 커밋·브랜치·PR은 게시 서버가 D-24 App으로 만든다 |
| 3c | 작업자 egress에서 GitHub 호스트를 모두 뺌. 게시 서버가 고정 SHA 압축본과 diff를 작업 입력으로 넘김 | 가장 좁다. 게시 서버가 큰 입력을 다뤄야 한다 |

- V1 대상 저장소는 모두 public이라(D-29) 압축본을 받는 데 GitHub 자격이 필요 없다 [가정: public 저장소 압축본은 익명 조회 가능하다는 일반 동작. 프록시 경유는 T16b 실측].
- 옛 AIOps 교훈: 모델에게 셸 대신 고정 Git blob 읽기 도구만 주는 형태가 격리 요구를 크게 줄였다 [실측: 옛 aiops 저장소 `tools/docs/ai-provider.md`]. 3b는 PR 리뷰어를 이 형태에 가깝게 만든다 [가정].
- 이 결정으로 줄지 않는 것: 패키지 레지스트리의 게시 API 경로(설계 C.8).
- [미확인] DNS 없는 작업자에서 Codex·패키지 관리자가 `HTTPS_PROXY`로 이름 해석을 프록시에 맡기는지(U29). Codex가 `HTTPS_PROXY`를 따르는지는 공식 환경 변수 문서에 없다.

### 남은 것

- 실측(T08b·T16b): U13 init 방화벽, U29 DNS 없는 도구, 프록시를 거친 `codeload.github.com` 압축본 받기와 `github.com`·`api.github.com`·gist 차단.
- 작업자 영속 쓰기 공간(D-14 조건 4): 모양(PVC 하나, 파일이 없을 때만 시드)은 homelab `rebuild` 변경에서 설계 C.8 격리 행·E4b에 들어갔다. 크기·백업은 T08b, 영속 공간에 첫 시드 복사는 T16b(설계 E9). 계정 준비와 시드 등록은 T16b 전(모델을 처음 쓰는 단계 전)이다.
- 1b로 물러날 때는 그 시점에 사람이 승인한다(`approvals.md`).

---

## D-16 PR 리뷰 방식

**변경(사용자 2026-11-09, 아래 "동료 봇 전환" 16·18).** 댓글 내용은 owner가 Discord에서 봇 변경 PR의 수정을 요청했을 때만 그 PR에서 자료로 읽는다. 댓글·리뷰만으로는 봇이 움직이지 않고, `/homelab-review` 명령 규칙은 그대로다. 리뷰 App 설치는 조직의 모든 저장소로 넓히되 자동 리뷰 대상은 정책 목록 그대로다.

**리뷰 App 설치 범위 수행(C30):** 2026-11-10 기준 `ukyi-review`는 조직에 `repository_selection: selected`로 설치돼 있고 All repositories로 넓히는 사람 작업은 아직이다(owner 승인과 homelab `approvals.md` 기록은 C30 할 일 7, 주 진행자). 넓히기 전에는 선택되지 않은 저장소의 리뷰 요청이 "리뷰 App 없음"으로 거절된다 [가정: 선택 밖 저장소의 설치 조회는 404, 실측은 C24 S5]. 코드 쪽은 "C30 리뷰 요청 구현 선택"(아래).

**상태:** 확정(사용자 2026-10-18, T15). **선택지 1(기본안): 전용 리뷰 App + 격리 리뷰어 + 제한 게시 서버(`01` §5).** 봇이 리뷰하는 저장소는 저장소별 Codex 설정에서 Codex 자동 리뷰를 끈다(사람 작업. 수동 `@codex review`는 남긴다). Codex Connector 설치 범위는 선택 저장소로 줄이고 private 운영 저장소 `homelab-bot-ops`는 뺀다(사람 작업, D-26의 설치 범위 축소. 완료(사람 2026-10-18 17:45). 시점과 결과는 아래 "Codex Connector 설치 범위"). 작성자 확인의 App 예외는 새 결정 ID 없이 D-16 안의 하위 결정으로 정했다(아래). 모두 에이전트 추천을 받아들였다.

**질문:** V1 기능 7(전용 GitHub App 중심의 PR 자동 리뷰)을 무엇으로 채우는가. Codex Connector는 유지로 확정됐고(D-26) 설치 범위 축소는 여기서 함께 봤다.

### 선택지 (기록)

| 선택지 | 내용 | 판단 |
|---|---|---|
| **1. 기본안 (선택)** | 전용 리뷰 App + 격리 리뷰어 + 제한 게시 서버(`01` §5). 봇이 리뷰하는 저장소에서는 Codex 자동 리뷰를 끈다. 수동 `@codex review`는 기본 리뷰가 아니라 남겨도 된다 [가정: `01` §3 "두 기본 리뷰 동시 금지"의 해석] | R11·기능 7과 그대로 맞는다 |
| 2. 대안 | Codex Connector 자동 리뷰 + 결과만 Discord로 중계 | `01` §3은 D-16 선택지로 허용한다. 그러나 R11 문구("전용 GitHub App")와 충돌해, 고르면 R11 문구 조정이 필요하다. 그것이 C-08 변경인지는 사용자가 판단할 일이었다 |
| 3. 일정 절충 | T17 전까지 Codex를 임시 시범 리뷰어로 쓰고, V1 판정 전 기본안을 완성한다 | R11 문구는 그대로. 기본안 구현 부담은 줄지 않는다 |

### 근거

- [실측: `gh api` GET으로 리뷰·댓글·반응·timeline 조회] Codex Connector는 사람이 연 PR 7건에 모두 자동 리뷰를 달았다(요약 댓글 약 15~20초, 완료 약 2~3분). 봇 App이 연 PR 1건(약 12분 열림)에는 아무것도 달지 않았다. 봇 PR 표본은 1건이다.
- [확인: https://learn.chatgpt.com/docs/third-party/github] 자동 리뷰 설정은 저장소 단위와 개인 단위가 함께 있다. 저장소 설정은 "Choose your repository, then turn on Automatic review under Review code"이고, 문서의 설정 화면 예시에 저장소별 값 "Automatic code review: All PRs"와 "Follow personal preferences"가 보인다. 개인 설정은 "To enable automatic reviews for your pull requests, turn on Automatic review under Personal preferences"이고 "Choose when reviews run with Review trigger"다. 문제 해결 절은 "check Automatic review under the repository settings and Personal preferences"라고 한다. 그래서 봇이 리뷰하는 저장소만 골라 끌 수 있다. 개인 설정을 끄면 다른 저장소의 Codex 자동 리뷰까지 사라진다 [가정].
- [미확인] 봇 PR이 리뷰되지 않은 원인. 저장소 값이 "Follow personal preferences"라면 개인 설정의 "for your pull requests"만 리뷰된다는 해석과 맞지만, 저장소 값은 보지 못했다. Draft로 열면 자동 리뷰를 피하는지도 Review trigger 설정에 달렸을 수 있다. 저장소 설정에서 어떤 작성자의 PR까지 리뷰되는지(봇·Renovate PR 포함 여부)는 사람이 Codex 설정 화면에서 확인한다.
- [실측] Codex 결과는 GitHub API로 읽을 수 있다(리뷰 `COMMENTED`, 인라인, 요약 댓글). 다만 요약 댓글의 숨은 상태 JSON은 비공식이고 2026-10-07과 2026-10-18 사이 형식이 바뀌었다. 문서는 "P0·P1만"이라는데 P2 지적이 게시됐다. coverage·partial 정보가 없다.
- [실측] 조사 때 Connector는 org 전체 저장소에 actions·contents·issues·pull_requests·workflows write였다. private 운영 산출물 저장소(Free라 보호 규칙 불가)에도 닿았다. 그 뒤 설치 범위를 선택 저장소로 줄였다(아래 "Codex Connector 설치 범위").
- [확인: https://learn.chatgpt.com/docs/pricing] GitHub code review는 API 키 인증에서 안 된다. Connector는 사용자의 ChatGPT 플랜으로 돌고 봇 자격과 따로다.
- [확인: https://docs.github.com/en/rest/pulls/reviews , https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps] 리뷰 게시는 Pull requests write이고, 같은 권한으로 APPROVE·REQUEST_CHANGES·dismiss·PR 생성도 된다. 기본안의 게시 서버가 `event=COMMENT`와 허용 API만 통과시켜야 한다. `commit_id`를 비우면 최신 커밋이 기본이라 검토한 head SHA를 명시해야 한다.
- [미확인] 외부인의 `@codex` 호출(U38), Connector가 PR head와 base 중 어느 `AGENTS.md`를 리뷰 기준으로 읽는지.

### Codex Connector 설치 범위 (D-26 "D-16과 함께")

| 선택지 | 내용 |
|---|---|
| 유지 | org 전체 그대로. 봇 리뷰 대상 저장소에서 자동 리뷰 설정만 끈다 |
| **선택 저장소로 축소 (선택)** | private 운영 저장소 `homelab-bot-ops`(보호 불가)를 빼고, 봇 리뷰 대상 저장소의 자동 리뷰는 저장소별 설정에서 끈다. `repository_dispatch`·`workflow_dispatch`·issue 경로 위험도 함께 준다 [확인: 설계 F D-26 이유 (b)] |
| 제거 | Codex 리뷰 가치를 잃는다 |

**축소의 시점과 범위(확정(사용자 2026-10-18)):** `homelab-bot-ops`에 운영 산출물을 처음 올리기 전에 사람이 한다. 그 저장소의 첫 커밋에는 내부 식별자가 든 evidence가 들어간다. 남길 저장소 후보는 public 저장소(`homelab`, `homelab-app-template`, `files`, `homelab-bot`)이고, `homelab-bot-ops`와 private 저장소(제거 예정 `aiops`·`mac-uptime-guard`, 보관 `aiops-autodeploy-canary`)는 뺀다.

**축소 결과(완료, 사람 2026-10-18 17:45, homelab `approvals.md`):** 남긴 저장소는 사용자 보고로 위 public 저장소 넷이다. 설치 범위가 선택 저장소(`repository_selection` = `selected`)로 바뀐 것은 확인했다 [실측: `gh api` GET]. 저장소 목록은 조회 권한이 없어 API로 확인하지 못했다 [미확인]. T17은 축소가 됐는지 확인만 한다. 저장소 목록의 API 확인은 아직이다.

Codex 결과의 Discord 중계는 V1 필수가 아니므로 선택 기능으로 미루기를 추천한다(에이전트 추천, T17에서 정함).

### 남은 것 (T17)

- 리뷰 대상 저장소 목록(`github.reviewed_repositories`). 설치는 시험 저장소부터 시작한다(T17 제약).
- 사람 작업(`approvals.md` 기록): 리뷰 App 생성·설치와 키 등록, 봇 리뷰 저장소의 Codex 자동 리뷰 끄기(저장소별 Codex 설정), 저장소 설정의 리뷰 범위 확인. Connector 설치 범위 축소는 T15에서 끝났고(사람 2026-10-18 17:45) T17은 확인만 한다. 남긴 저장소 목록의 API 확인은 아직이다.
- Codex 결과의 Discord 중계를 둘지(위 에이전트 추천).
- 리뷰 App 권한과 구독 이벤트 확인(아래).

### 리뷰 App 권한과 구독 이벤트 (설계 세부, 사용자 결정 아님)

D-16 기본안을 구현하려고 에이전트가 정리한 값이다. 최종 확인은 T17이 App을 만들 때 한다.

- **권한:** Pull requests write(리뷰·요약 댓글 게시), Contents read, Metadata read(여기까지 `01` §5 "역할·권한"), Checks read, Issues read. Contents write·Workflows·Administration은 없다. Checks read는 설계 C.8 리뷰 App 행대로 늘 포함한다(`01` §5 표의 "실사용 시에만"보다 넓다). Actions read는 설계 C.8에 없고 `01` §5대로 실사용할 때만 더한다.
- **Issues read를 두는 이유:** `issue_comment` 구독에는 Issues read 이상이 필요하다 [확인: https://docs.github.com/en/webhooks/webhook-events-and-payloads]. 없으면 아래 규칙 스케치의 댓글 리뷰 요청이 오지 않아 작성자 확인과 루프 차단이 돌 일도 없다. Issues write는 두지 않는다. PR 요약 댓글은 Pull requests write로 된다 [확인: https://docs.github.com/en/rest/issues/comments].
- **구독 이벤트:** `pull_request`, `issue_comment`.
- D-24 쓰기 App의 "Issues 없음"은 그대로다. 그 App은 webhook을 끄고 이벤트를 받지 않는다.

### 하위 결정: 모델 호출 전 작성자 확인의 App 예외

**상태:** 확정(사용자 2026-10-18, T15). 새 결정 ID를 만들지 않고 D-16 안에 둔다.

**질문:** 설계 C.8은 봇이 모델 호출 전에 `author_association`이 OWNER·MEMBER·COLLABORATOR인지 확인하게 한다(D-29). 이것이 Renovate App과 봇 변경 PR App의 PR을 막는가. 막으면 허용할 App을 따로 둘까(T15 할 일 4, V1 기능 7, AC-B4).

**실측 결과: 막는다.**

- [실측: `gh api` GET으로 PR 목록 집계] App이 연 PR은 그 저장소에 병합된 커밋이 없으면 `NONE`, 있으면 `CONTRIBUTOR`였다. OWNER·MEMBER·COLLABORATOR는 한 번도 나오지 않았다. 옛 쓰기 App의 PR은 public 저장소 둘에서 모두 `CONTRIBUTOR`(121건, 14건), private 저장소 하나에서 `NONE`(4건)이었다. org 밖 public 저장소의 호스팅형 Renovate PR 표본은 열린 것 100/100 `CONTRIBUTOR`, 병합된 것 99/100 `CONTRIBUTOR`·1/100 `NONE`이었다.
- [실측] 사람 owner가 org 저장소에 연 PR은 `OWNER`가 아니라 `MEMBER`다. org 저장소의 소유자는 org이기 때문이다 [확인: https://docs.github.com/en/graphql/reference/issues (CommentAuthorAssociation)].
- [가정] 새로 설치할 호스팅형 Renovate와 봇 변경 PR App도 첫 PR은 `NONE`, 병합 뒤 `CONTRIBUTOR`일 것이다. 두 App은 아직 없어 직접 실측은 blocked(해소: T10의 D-18 설치 뒤, T19의 D-24 App 생성 뒤).

**결정 내용**

- 허용 봇 작성자 목록을 둔다. `pull_request.user.type`이 `Bot`이고 숫자 `user.id`가 목록에 있으면 통과한다.
- 초기 목록은 호스팅형 Renovate 봇과 D-24 App의 봇 사용자(생성 뒤)다. 배포 갱신 App(`homelab-deploy`), Codex Connector, 옛 writer는 넣지 않는다.
- fork PR은 제외한다. 댓글 트리거는 `comment.author_association`을 보고 Bot 댓글은 무시한다. `CONTRIBUTOR`는 허용하지 않는다.
- 댓글 트리거도 대상 PR을 조회해 `head.repo.id == base.repo.id`(같은 저장소)이고 PR 작성자가 자동 리뷰와 같은 조건(OWNER·MEMBER·COLLABORATOR 또는 허용 봇)일 때만 모델을 호출한다. 새 결정이 아니라 위 fork 제외·허용 작성자 하위 결정을 댓글 경로에 그대로 적용한 것이다. 이것이 없으면 허용된 사람이 fork PR이나 외부인 PR에 리뷰 요청 댓글을 달 때 모델 호출이 통과한다.
- 그래서 기능 7의 모델 리뷰 범위는 OWNER·MEMBER·COLLABORATOR와 허용 봇 작성자가 연 같은 저장소 PR이다. 외부인 PR은 D-29의 모델 호출 전 작성자 확인으로, fork PR은 이 하위 결정으로 모델 리뷰에서 빠진다. 외부인 PR이 모델 호출을 일으키지 않는다는 것은 `00` §3 7번 아래 참고 줄에도 있다.
- 실제 ID는 Infisical runtime policy(키 이름 예: `review.allowed_bot_author_ids`)에만 둔다. 이 저장소에는 키 이름만 둔다(D-13).
- 허용 작성자의 PR 본문도 비신뢰 자료로 다룬다. Renovate PR 본문에는 상류 프로젝트의 릴리스 노트가 그대로 들어간다 [실측]. 본문을 모델 입력에서 뺄지 자료 블록으로 격리할지는 T17 구현에서 정한다.

**선택지 (기록)**

| 선택지 | 내용 | 판단 |
|---|---|---|
| **1 (선택)** | 허용 봇 작성자 목록. `pull_request.user.type == "Bot"` 이고 `pull_request.user.id`가 목록에 있으면 통과 | 기능 7을 지킨다. 숫자 ID라 이름 바꾸기에 흔들리지 않는다 |
| 2 | 예외 없음. Renovate·봇 PR은 모델 리뷰를 하지 않는다 | 기능 7 범위("사람·Renovate·봇 작성 PR")가 줄어 C-08 범위에 닿는다 |
| 3 | `CONTRIBUTOR`를 허용 값에 넣는다 | 고르지 않음. 외부인도 PR 하나가 병합되면 `CONTRIBUTOR`가 된다 [확인: 위 CommentAuthorAssociation 정의] |

installation id로 작성 App을 가리는 것은 맞지 않다. 리뷰 App이 받는 webhook의 `installation`은 받는 App 자신의 설치다 [확인: https://docs.github.com/en/webhooks/webhook-events-and-payloads , 해석]. App이 작성한 PR의 `performed_via_github_app`도 `null`이었다 [실측].

**규칙 스케치 (실제 코드 아님)**

```text
모델 호출 허용 :=
  installation.id ∈ 허용 설치(리뷰 App 자신)
  ∧ repository.id ∈ 허용 저장소
  ∧ 이벤트별 조건

pull_request (opened | reopened | ready_for_review | synchronize | edited 중 base 변경):
  head.repo.id == base.repo.id                       # fork PR 제외
  ∧ ( author_association ∈ {OWNER, MEMBER, COLLABORATOR}
      ∨ (user.type == "Bot" ∧ user.id ∈ allowed_bot_author_ids) )
  ∧ draft == false (명시 요청 예외는 따로)

issue_comment (PR 댓글로 리뷰 요청):
  action == "created"                                          # 수정·삭제는 트리거 아님
  ∧ comment.body가 정해진 리뷰 명령과 정확히 일치               # 일반 토론 댓글은 트리거 아님. 문법은 T17
  ∧ comment.author_association ∈ {OWNER, MEMBER, COLLABORATOR}   # issue.author_association 아님
  ∧ comment.user.type != "Bot"                                 # 자기·Codex 댓글 루프 차단
  ∧ pr := 대상 PR을 PR API로 조회                               # 아래 첫 항목
  ∧ pr.head.repo.id == pr.base.repo.id                         # fork PR 제외(자동 리뷰와 같음)
  ∧ ( pr.author_association ∈ {OWNER, MEMBER, COLLABORATOR}
      ∨ (pr.user.type == "Bot" ∧ pr.user.id ∈ allowed_bot_author_ids) )
```

- `issue_comment` payload에는 PR의 head 저장소가 없어 fork 여부를 PR API로 읽는다 [가정]. 조회가 실패하면 모델을 호출하지 않는다.
- `synchronize`의 `sender`는 감사·대조용으로 기록한다 [가정].
- 댓글 리뷰 요청은 같은 PR의 같은 세대(`head_sha`, `comparison_revision`, `policy_revision`)에 대기·진행 중인 리뷰가 있으면 새로 넣지 않는다. 모델 호출이 직렬 1개(D-14)라 일반 토론 댓글이 리뷰를 다시 넣으면 대화와 작업이 밀린다 [가정].
- `edited`는 base가 바뀐 경우(재지정)만 새 리뷰 세대로 본다. 판정은 받은 PR의 base를 처리 기록과 비교해 한다. base 브랜치가 앞서가기만 하는 경우는 PR 이벤트가 없어 열린 PR 폴링이 잡는다. 세대 구분은 `01` §5의 `(head_sha, comparison_revision, policy_revision)`이다(ARCHITECTURE §7, REVIEW-02) [가정].

**초기 목록**

| 대상 | 넣을지 | 이유 |
|---|---|---|
| 호스팅형 Renovate 봇 사용자 | 넣음 | D-18이 기능 7의 리뷰 대상으로 정했다 |
| D-24 봇 변경 PR App의 봇 사용자 | 넣음(생성 뒤) | `01` §5 "봇이 작성한 PR 자체는 정상 리뷰" |
| 배포 갱신 App(`homelab-deploy`) | 제외 | 기능 7 범위("사람·Renovate·봇 작성 PR")에 없고, 자동 병합이 리뷰보다 먼저 끝나기 쉽다 |
| Codex Connector | 제외 | PR 작성자가 아니고(Codex PR은 owner 계정으로 찍힘, 설계 C.4.7) 댓글은 루프 원인 |
| 옛 쓰기 App | 제외 | T06에서 삭제 |

**이 결정에서 나온 AC-B4 기대값:** `MEMBER` 통과, `NONE`·`CONTRIBUTOR`·`FIRST_TIME_CONTRIBUTOR` 차단, 허용 봇 ID 통과, 허용 밖 봇 ID 차단, fork PR 차단, Bot 댓글 무시, 허용된 사람의 리뷰 요청 댓글이라도 대상 PR이 fork거나 PR 작성자가 허용 밖이면 차단.

---

## D-17 Discord 서버, 채널, 허용 사용자

**상태:** 확정(사용자 2026-10-18, T15). **봇 전용 개인 서버를 새로 만든다.** 아래 표의 "결정" 칸 기본값도 함께 정했다(에이전트 추천 수락). DM 허용 여부와 브리핑 시각은 T16a에서 정했다(확정(사용자 2026-10-20)): DM 끔, 브리핑 매일 08:50 Asia/Seoul.

**질문:** 봇이 붙을 Discord 서버, 채널, 허용 사용자와 대화 방식. spec §5.3은 "사용자 제공"이었다.

### 서버 선택지 (기록)

| 선택지 | 내용 | 판단 |
|---|---|---|
| **1 (선택)** | 봇 전용 개인 서버를 새로 만든다 | 멤버가 허용 사용자뿐이라 공개 스레드 노출(DATA-01), 멘션 사고, 권한 계산이 단순하다 [가정] |
| 2 | 기존 서버의 비공개 채널 | 허용 채널을 비공개로 두고 overwrite로 막아야 한다. 다른 멤버가 공개 스레드를 볼 수 있다 [가정] |

### 설정

| 설정 | 결정 | 근거 |
|---|---|---|
| `MESSAGE_CONTENT` 특권 intent | 켬 | 없으면 멘션 없는 메시지의 `content`·`embeds`·`attachments`·`components`·`poll`이 빈 값이다. 예외는 봇 자신의 메시지, 봇 DM, 봇 멘션, 메시지 컨텍스트 메뉴 대상뿐이다 [확인: https://docs.discord.com/developers/events/gateway]. 2026-06-10부터 심사 기준이 고유 사용자 10,000명이고 그 미만은 Developer Portal 토글로 켠다 [확인: https://docs.discord.com/developers/gateway/getting-started-with-privileged-intent-review]. 쓸 수 없게 되면 R01대로 명령/버튼 모드를 명시해 운영한다 |
| 활성화 | 허용 채널에서 멘션이나 `/` 명령으로 공개 스레드를 시작하고, 스레드 안 후속 메시지는 멘션 없이 처리한다. 구독 해제(R01)를 해제 명령으로 하는 것은 에이전트 제안이고 T16a에서 정한다 | R01, CHAT-01·02 [가정] |
| 채널 | 2개: 대화 시작 채널, 알림·PR 리뷰·브리핑 채널 | 알림 폭주가 대화를 덮지 않게(OPS-01) [가정] |
| 허용 사용자 | owner 1명 | D-14 A의 계정 공유 위험도 이때 가장 작다 [가정] |
| DM | 끔(확정(사용자 2026-10-20, T16a)) | 기능 1은 DM을 포함할 수 있다. 서버 채널은 서버·채널·사용자 세 겹으로 판정하지만 DM에는 채널 경계가 없어 사용자 ID 하나로만 판정한다. 개인 서버 채널도 휴대폰에서 바로 쓸 수 있어 DM의 편의가 작다. 켜려면 runtime policy `dmEnabled`와 명령 등록을 함께 바꾼다. DM에서 슬래시 명령을 쓰려면 전역 명령과 `contexts`의 `BOT_DM`이 필요하다 [확인: https://docs.discord.com/developers/interactions/application-commands] |
| 스레드 종류 | 공개 스레드 | 비공개 스레드는 봇이 멤버여야 동기화되고, 접근을 잃어도 Thread Delete가 오지 않는다 [확인: https://docs.discord.com/developers/topics/threads] |
| `auto_archive_duration` | 1440분 | 허용 값은 60·1440·4320·10080분. 메시지를 보내면 보관이 풀린다(잠긴 스레드 제외) [확인: https://docs.discord.com/developers/topics/threads] |
| 봇 권한 | 관리자·MANAGE_THREADS·MENTION_EVERYONE 없음. 서버 역할이 아니라 허용 채널 overwrite로 준다 | MANAGE_THREADS는 모든 비공개 스레드 보기를 포함한다. 권한 정수 제안값은 309237763136(VIEW_CHANNEL, SEND_MESSAGES, SEND_MESSAGES_IN_THREADS, CREATE_PUBLIC_THREADS, READ_MESSAGE_HISTORY, EMBED_LINKS, ADD_REACTIONS, ATTACH_FILES)이다 [실측: 비트 합 계산. 실제 동작은 미확인, T16b] |
| 앱 설정 | Public Bot 끔, 서버 설치만, Interactions Endpoint URL 비움(Gateway로 받음) | Gateway로 받으면 새 공개 수신 경로가 필요 없다(설계의 봇 공개 경로는 GitHub webhook 하나) [가정]. Requires OAuth2 Code Grant 끔과 Members·Presence intent 끔은 결정 목록 밖의 에이전트 추천으로 남는다 |
| 멘션 기본값 | 모든 봇 메시지에 `allowed_mentions: {"parse": []}` | 일반 메시지의 기본값은 everyone까지 파싱한다 [확인: https://docs.discord.com/developers/resources/message] |
| 멘션 기본값(동료 봇 전환 4·11, C07) | 기본은 그대로 `parse: []`. owner 호출 넷(작업 질문, 작업 완료·실패, 변경 미리보기, 변경 실패)만 `users: [owner]` 하나를 허용하고, 답장은 `replied_user: false`로 알림 없이 단다 | ARCHITECTURE §6 "Discord 입력", §11 "표식·답장·스레드" |

- **경계는 봇 코드다.** 매 이벤트마다 사용자 ID(문자열 snowflake)를 허용 목록과 비교하고, 스레드는 `parent_id`로 채널을 대조하며, 봇·webhook 메시지는 무시한다. 슬래시 명령 권한 overwrite는 봇 토큰으로 설정할 수 없고 명령 표시 제어일 뿐이다 [확인: https://docs.discord.com/developers/interactions/application-commands]. 버튼은 메시지를 볼 수 있는 누구나 누를 수 있다고 보고 서버에서 검사한다 [가정].
- D-14와 연결: Discord Developer Policy가 API로 얻은 메시지 내용으로 AI 모델을 학습시키는 것을 금지한다고 검색 요약이 전한다 [미확인: 원문 403]. D-14 A의 구독 계정은 입력이 기본으로 학습에 쓰일 수 있으므로 [확인: https://help.openai.com/en/articles/5722486] 그 설정을 끄는 것을 계정 준비에 넣는다.

### 남은 것

- T16a에서 정함(사용자 2026-10-20): DM 끔, 브리핑 매일 08:50 Asia/Seoul(R18). 08:50은 밤사이 백업(homelab 설계: DB 03:00, Valkey 03:30) 결과가 나온 뒤다.
- 실제 서버 ID, 채널 ID, 허용 사용자 ID(문자열 snowflake). **값은 Infisical `/apps/homelab-bot/`에만 두고 이 저장소와 공개 문서에는 쓰지 않는다.**
- 사람 작업(`approvals.md` 기록, AC-X2): 서버 생성, Developer Portal 앱·봇 생성과 위 앱 설정, intent 토글, 봇 토큰 발급과 Infisical 등록, 설치 URL로 서버 추가, 허용 채널 overwrite, 슬래시 명령 사용자 허용.

---

## D-24 봇 변경 PR 작성 신원

**상태:** 확정(사용자 2026-10-18, T15). **A: 봇 전용 쓰기 GitHub App.** Contents write + Pull requests write + Metadata read. Workflows·Actions·Administration·Issues 없음. webhook 끔. 선택 저장소에 설치. 작업마다 저장소 하나로 좁힌 1시간 토큰. 병합 API·`/merges`·`repository_dispatch`·update-branch·GraphQL 병합은 권한으로 막지 못하므로 게시 서버의 허용 목록이 막는다. 봇은 `.github/workflows` 변경 PR을 만들 수 없다(받아들인 범위 축소). 토큰 분리, ruleset E 여부, App 이름과 설치 저장소, 허용 파일 경로는 미정이고 T19에서 정한다. 에이전트 추천을 받아들였다.

**질문:** CHANGE_PR(R13)에서 봇 브랜치를 push하고 PR을 만드는 신원. spec §5.3 추천 기본값은 리뷰 App·배포 App과 분리한 봇 전용 쓰기 GitHub App이었다.

### 선택지 (기록)

| 선택지 | 내용 | 판단 |
|---|---|---|
| **A (선택)** | 봇 전용 쓰기 GitHub App. Contents write + Pull requests write + Metadata read. Workflows·Actions·Administration·Issues 없음. webhook 끔. 선택 저장소에만 설치. 작업마다 저장소 하나로 줄인 1시간 토큰. 키는 Infisical 게시 서버 경로에만 | owner가 작성자가 아니므로 `app-main`·ruleset B의 승인 1 + code owner가 걸린다 [실측: 봇·`files`·템플릿 저장소의 `app-main`, 확인: 설계 C.4.7]. seat를 쓰지 않고 사람에 묶이지 않는다 [확인: https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app] |
| B | 봇용 machine user 계정 + fine-grained PAT | 고르지 않음. collaborator면 `COLLABORATOR`로 작성자 확인을 그냥 통과한다 [가정]. PAT는 사용자에 묶이고 만료 관리가 필요하다. 무료 machine account는 하나까지다 [확인: https://docs.github.com/en/site-policy/github-terms/github-terms-of-service] |
| C | 그 밖: owner 계정 `gh` 로그인, Codex `@codex` push, 리뷰 App에 contents write 추가, Actions `GITHUB_TOKEN` | 고르지 않음. owner와 Codex는 승인 관문이 없고(owner PR은 bypass 병합), 리뷰 App 확장은 `01` §5(리뷰 App은 Contents 쓰기 불가)와 `01` §7(다른 신원)에 어긋나며, `GITHUB_TOKEN` 경로는 D-26 조건 (2)(시크릿 쓰는 dispatch 금지)에 걸린다 |

### 근거

- [확인: https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps , https://docs.github.com/en/rest/pulls/pulls] PR 병합 `PUT /pulls/{n}/merge`, 브랜치 병합 `POST /merges`, `repository_dispatch`는 모두 Contents write다. `workflow_dispatch`는 Actions write다. `.github/workflows` 파일 변경(contents API)은 Contents write와 Workflows write를 함께 요구한다 [확인: https://docs.github.com/en/rest/repos/contents].
- 뜻: Contents write를 받는 이상 승인 조건이 채워진 PR의 병합 API, `POST /merges`, `repository_dispatch`, update-branch, GraphQL 병합·auto-merge는 권한으로 막을 수 없다. 막는 장치는 ruleset(승인 1 + code owner + 새 push 때 승인 무효화), 저장소 `allow_auto_merge=false`, D-26 조건 (2), 그리고 게시 서버의 API 허용 목록이다.
- [실측] 봇·`files`·템플릿 저장소의 `app-main`은 App bypass가 없다. homelab은 아직 옛 보호이고 `allow_auto_merge=true`다(T06·T10에서 바뀜).
- [확인: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets] 선택 ruleset E(`bot/**` 생성·갱신을 이 App만)는 다른 신원이 `bot/**`를 덮지 못하게 하지만 이 App을 `bot/**` 안에 가두지는 않는다. 게시 서버가 ref를 `refs/heads/bot/`로 고정해야 한다.
- [확인: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow] App 토큰으로 만든 PR은 승인 프롬프트 없이 CI가 바로 돈다. CI의 간접 효과는 저장소·org secret 0개, environment secret은 `workflow_run`·main만(D-04, D-26)으로 막는다.
- [실측: `git show 2d2054a:docs/decisions/0009-…`, `0010-…`] 옛 AIOps는 "모든 파일(워크플로 포함) 초안" 범위 때문에 workflows 쓰기가 필요해졌고, 그것이 fork·environment 재편까지 이어졌다. Workflows 권한을 빼면 이 비용의 뿌리가 사라진다.

### 받아들인 범위 축소

Workflows 권한이 없으므로 **봇은 `.github/workflows` 변경 PR을 만들 수 없다** [확인: https://docs.github.com/en/rest/repos/contents]. git push 경로로도 거부되는지는 E5 시험이다 [미확인]. D-15로 작업자는 GitHub에 쓰지 않고, 커밋·브랜치·PR은 게시 서버가 이 App으로 만든다.

### T19 세부 결정 (사용자 2026-11-05)

사용자가 독립 리뷰(Codex)와 에이전트 의견을 나란히 본 뒤 정했다. 이름은 추천(`ukyi-homelab-bot-writer`)이 아니라 사용자가 고른 값이다. 나머지 넷은 두 리뷰의 추천과 같고, ruleset E의 삭제 제한은 에이전트 의견을 받았다.

| 항목 | 결정 | 근거·함정 |
|---|---|---|
| App 이름 | `ukyi-writer`(org 소유 private App) | 이름은 GitHub 전체에서 유일해야 하고 등록 때 확인한다. ruleset bypass에는 App ID, 토큰 발급에는 설치 ID, 작성자 허용에는 봇 사용자의 숫자 `user.id`를 쓴다. 이름 문자열은 허용 근거가 아니다 |
| 토큰 분리 | 같은 App에서 두 종류: 커밋·ref는 `contents: write`, PR 생성·제목·본문은 `contents: read` + `pull_requests: write`. 둘 다 작업마다 `repository_ids` 하나와 `permissions`를 명시하고, 반환된 저장소·권한·만료를 대조한다 | PR을 다루는 코드에서 병합 API 권한(Contents write)이 빠진다. 커밋용 토큰에는 여전히 병합 권한이 있고 같은 App 키가 두 토큰을 모두 만들 수 있어, 키 유출에는 효과가 없다. 병합 차단의 주 장치는 ruleset과 게시 서버 허용 API다 |
| ruleset E | 설치 저장소마다 둔다(`infra/github`, App ID는 숫자 리터럴, D-28). 대상 `refs/heads/bot/**/*`, 생성·갱신·삭제 제한, bypass는 `ukyi-writer` App(`Integration`) 하나 `always` | 다른 신원이 봇 브랜치를 만들거나 덮거나 지우는 것을 막는다. 패턴 함정: `refs/heads/deploy/**`는 `deploy/x`에만 걸리고 `deploy/x/y`에는 걸리지 않았다(2026-11-05 `GET /rules/branches` 실측). E는 writer를 `bot/` 안에 가두지 않는다. 그것은 게시 서버의 ref 제한과 main·deploy·태그 ruleset이 한다. E의 bypass를 다른 ruleset에 복사하지 않는다 |
| 설치 저장소 | `ukyi-app/homelab-smoke` 하나로 시작한다. `ukyi-app/homelab`은 실제 `ukyi-writer` 신원의 AC-P8 시험 직전에 별도 승인으로 더한다. `homelab-bot`·`files`·템플릿·운영 저장소는 지금 열지 않는다 | 키가 새도 설치되지 않은 저장소에는 토큰을 만들 수 없어, 키 유출에 남는 유일한 상한이다. 설치는 기능 개방이 아니다. 런타임 정책 `change.repositories`(`ChangeRepositoryPolicySchema`)는 설치 목록과 따로 좁힌다 |
| 허용 파일 경로 | 저장소별 좁은 목록. smoke는 `src/**`·`tests/**`·`docs/**`·`README.md`, homelab은 `docs/runbooks-public/**`. 정책이 없는 저장소와 빈 목록은 모두 거부. 어디서든 `.github/**`, 모든 위치의 `AGENTS.md`·`CLAUDE.md`·`CODEOWNERS`, `.gitmodules`, 보안 검사 설정(`.gitleaks*`, `.pre-commit-config.yaml`), 자격 파일은 거부 | Free + public이라 GitHub 파일 경로 제한(push ruleset)을 쓸 수 없다. 그래서 이 목록은 게시 서버가 지킨다. 고정 base tree와 결과 tree 전체를 비교해 추가·수정·삭제·rename 양쪽과 mode를 보고, `..`·절대 경로·symlink·gitlink는 거부한다. **첫 blob을 GitHub에 올리기 전에** 검사를 끝낸다. 올린 객체는 되돌릴 수 없는 공개다. 키가 새면 이 경계는 우회된다 |

게시 서버 허용 API의 V1 확정 목록은 ARCHITECTURE §16.3의 표다. `PATCH git/refs`·`PATCH pulls`는 V1에 노출하지 않는다. 아래는 출발점이던 초안이다(결정의 "허용 목록"을 채울 초안, CHANGE-02 시험 대상) [가정]: git data(`POST /git/blobs`, `/git/trees`, `/git/commits`), `bot/` 접두의 `POST /git/refs`·`PATCH /git/refs/heads/bot/…`(`force: false`), `POST /pulls`(head `bot/…`), `PATCH /pulls/{n}`(제목·본문). 그 밖은 거부. 특히 merge, `/merges`, `/dispatches`, update-branch, GraphQL `mergePullRequest`·`enablePullRequestAutoMerge`, 리뷰 API. 허용 파일 경로(`github.change_writer_allow_paths`)도 T19에서 정한다.

리뷰 연결: 이 App의 봇 사용자 ID는 D-16 하위 결정의 허용 봇 작성자 목록에 넣는다(결정됨, 생성 뒤).

사람 작업(T19 시작 전, `approvals.md` 기록): App 생성·설치, 키를 Infisical `/apps/homelab-bot/`에 등록.

### T19 운영 결정 (사용자 2026-11-06~07)

| 항목 | 결정 | 근거·함정 |
|---|---|---|
| 사람 단계 범위 | H2 작업자 갱신과 운영 파드 무모델 측정 → 정책 등록 → H1 실제 writer AC-P8 → H0 시험 앱 임시 등록 → H3 켜기와 live 한 건(모델 호출 최대 4회). 시험 PR의 게시와 병합은 결과마다 따로 승인 | 순서는 T19 계획의 배포 순서다. 기준이 어긋나면 멈춘다 |
| `writerAccepted` | 정책을 먼저 false로 등록하고, 실제 신원 AC-P8 통과 뒤 true | 확인 전에는 게시가 막힌다 |
| 켜기 전 보안 확인 | #85 `cf1d3c2` 보안 지적은 내용을 볼 수 없어 Codex CLI로 #85 전체를 다시 보고, P0·P1이 없을 때 켠다 | 3회 만에 P0·P1 0. 수정은 #86(VERIFICATION "T19 보안 재검토와 수정") |
| 켠 범위 | `CHANGE_PR_ENABLED` true, 정책의 `homelab-smoke` 하나 | 시험 앱은 뺐으므로 smoke 변경의 배포 관측은 `deploy_config_unregistered`로 닫힌다 |
| homelab 설치 | AC-P8 동안만 설치했다가 뺐고, homelab의 ruleset E는 남긴다 | 설치가 없으면 E의 bypass는 쓰일 곳이 없다. E를 지우는 것은 ruleset 삭제(파괴 명령)다. 다시 설치는 별도 승인이다 |

## T27 사람 입력 원문 보존 (사용자 2026-11-07)

T21 감사 A03: 7일 정리가 CHANGE artifact·리뷰 원문에만 걸려 작업 레인 질문의 답과 변경 요청 원문이 남았다.

**사용자 결정.** `codex_questions.answer`와 `change_request_inputs.text`를 **7일** 보존한다. digest와 영수증은 증거라 남긴다. CHANGE artifact·리뷰 원문과 같은 기간이다. 다른 원문 칸은 이 결정에 들지 않는다.

**구현에서 정한 것(사용자 결정 아님).**

| 항목 | 정한 값 | 이유 |
|---|---|---|
| 요청 원문 기준 시각 | change가 끝 상태에 든 때. artifact 정리와 같은 질의·같은 트랜잭션 | 기존 정리 기준과 맞춘다. 진행 중 건은 접수·재개가 원문을 읽는다 |
| 질문 답 기준 시각 | 그 job이 끝 상태(`succeeded`·`failed`·`cancelled`·`superseded`)에 든 때(`finished_at`, 없으면 답한 시각) | 작업 레인은 change가 없을 수 있다. CHANGE 작성 job의 답은 change보다 먼저 끝나 더 일찍 지워질 수 있고, 같은 답은 `change_request_inputs`에도 있어 change 끝 기준으로 따로 지워진다 |
| 예외 | change: 진행 중, 미확정 effect, 살아 있는 자식 job, 정리 안 끝난 세션(기존 그대로). 질문 답: job이 끝 상태가 아님(`waiting_user`·`unknown` 포함), 세션이 `running`·`waiting_answer`·`waiting_model`·`unknown`이거나 `cleanup_state='pending'` | 재개(`codex.ts`·`claude-task-bridge.ts`·CHANGE `resumeAuthor`)는 대기 세션일 때만 답을 읽는다. 대기 세션을 가진 `failed`는 `/retry`가 같은 답으로 이을 수 있어 남긴다 |
| 지운 표시 | 요청 원문은 `text=''`와 `purged_at`(`text`가 NOT NULL이라 옛 코드가 읽어도 깨지지 않는다). 질문 답은 `answer=NULL`, `answer_purged_at`, `answer_sha256` | migration 019는 칸을 더하기만 한다. 질문 답의 digest는 답을 쓰는 옛 코드가 칸을 몰라도 남도록 지울 때 DB가 계산한다(UTF-8 SHA-256) |
| 재개방 | 원문을 지운 superseded 건의 `/change … text:next`는 `input_purged`로 거절한다 | 새 generation 접수가 원문을 다시 읽는다. 열어 두면 `request_invalid`로 막혀 이유가 가려진다 |
| 부르는 자리 | 요청 원문은 기존 `change_retention`(1시간), 질문 답은 새 `task_answer_retention`(1시간). 둘 다 게시 서버가 뜨면 레인 스위치와 무관하게 돈다 | DB만 쓰는 정리를 레인 루프에 묶으면 레인을 끈 채 재시작했을 때 지울 때가 된 원문이 다시 켤 때까지 남는다(#94 Codex P2) |
| 복원 | 시각 기준이라 복원된 옛 행도 다음 정리가 다시 지운다. 원문이 다시 보이는 창은 복원부터 다음 정리까지, 최대 1시간(재시작이면 게시 서버가 뜬 직후 첫 바퀴까지). 정리는 한 바퀴에 change 20건×20번, 답 200행×20번까지 지운다 | 백업 자체에 든 원문은 백업 보존 기간(14일) 동안 남는다. 이 결정의 범위 밖이다 |

**정리 경로가 없던 다른 원문 칸.** `events.payload.text`(`/task` 요청문, CHANGE가 아닌 `/answer` 답 사본), `codex_questions.prompt`(모델 질문), `results.result`(작업 완료 요약 등 모델 출력), `outbox.payload.content`(Discord로 보낸 질문·요약 본문), `change_requests.brief`(요청 원문에서 뽑은 summary·goal·acceptance). 아래 T31에서 정했다. 감사 기록(`audit.detail`)에는 원문을 넣지 않는다.

## T31 원문 칸 보존 (사용자 2026-11-09)

T27이 넘긴 다섯 칸에 정리 경로가 없어 같은 원문이나 그 사본이 남았다(homelab T31, AC-B8).

**사용자 결정.** 다섯 칸을 **7일** 보존한다. 방식은 T27과 같다. 끝난 시각 기준으로 정리하고, digest·영수증은 남기고, 레인 스위치와 무관하게 게시 서버 시작 때부터 돌고, 한 바퀴에 여러 쪽을 지운다.

| 칸 | 지울 때(사용자 결정) | 고르지 않는 행(사용자 결정) |
|---|---|---|
| `events.payload.text` | 받은 지 7일 뒤, 원문만 비운다. 행·`semantic_key`·다른 칸은 유지 | 아직 끝나지 않은 작업이 가리키는 행. 작업 시작·재개가 원문을 다시 읽는 경로를 모두 찾아 그 조건으로 지킨다 |
| `codex_questions.prompt` | 작업이 끝난 지 7일 뒤 | 진행 중 작업(T27 질문 답과 같은 조건) |
| `results.result` | 작업이 끝난 지 7일 뒤 | 진행 중 작업 |
| `outbox.payload.content` | 보낸 지 7일 뒤 | 끝나지 않은 상태(`pending`·`sending`·`unknown`) |
| `change_requests.brief` | 변경이 끝난 지 7일 뒤(T27 요청 원문과 같은 기준 시각) | 진행 중 변경 |

**구현에서 정한 것(사용자 결정 아님).**

| 항목 | 정한 값 | 이유 |
|---|---|---|
| 지운 표시 | 행은 남기고 원문만 비운다. `events`는 `payload.text=''`, 질문은 `prompt=''`, 결과는 `result='{}'`, 게시는 `payload.content=''`. 각 표에 `*_sha256`·`*_purged_at`을 더한다(migration 020, 칸 추가만). brief는 `brief_purged_at` | 세 칸이 NOT NULL이다. digest는 행을 쓰는 옛 코드가 칸을 몰라도 남도록 지울 때 DB가 계산한다(UTF-8 SHA-256, 결과는 jsonb의 text 표현) |
| `events`가 원문을 다시 읽는 자리 | 끝나지 않은 job의 시작·재개(`codex.ts`·`claude-task-bridge.ts`·`read-runtime.ts`)와 대화 맥락, 누락 복구 버퍼(`buffered=true`), 확정 전 스레드 게시(`outbox` `kind=thread`, `pending`·`sending`·`unknown`, content가 그 event ID) | 셋 다 고르지 않는다. 스레드 게시는 확정 때 그 원문으로 job을 만들거나 경보 요약을 게시한다. job이 아직 없어 "끝나지 않은 작업" 조건으로는 잡히지 않는다 |
| `/retry` | 요청 원문을 비운 `failed` job은 되살리지 않고 "보존 기간(7일)이 지나 요청 원문을 지워 재시도할 수 없습니다"를 돌려준다 | `/retry`는 끝난 job을 새 스레드로 다시 시작해 원문을 읽는다. 실패 job의 원문을 남기면 기간 없이 남고, 열어 두면 빈 요청으로 모델을 부른다. T27 `input_purged`와 같은 처리다 |
| 정리와 `/retry`의 경합 | `events` 정리는 scheduler 행을 잠근 트랜잭션에서 비운다. `/retry`도 같은 행 아래에서 판정한다. 잠긴 event 행은 `SKIP LOCKED`로 건너뛴다 | 서로 다른 행을 쓰는 두 판정이 엇갈려 되살린 job의 원문을 비우는 일을 막는다. 수신 경로는 event 행 → scheduler 행 순서로 잡아, 기다리면 교착이 된다 |
| 받지 못한 채 비운 입력 | 다시 와도(누락 복구 등) `ignored:"text_purged"`로 두고 처리하지 않는다 | 저장된 빈 원문으로 job을 만들지 않는다 |
| 대화 맥락 | 비운 owner 메시지는 빼고, 본문을 비운 봇 페이지는 빠진 페이지로 본다 | 빈 말을 기록으로 넣지 않는다 |
| 기준 시각 | 요청: `received_at`. 질문·결과: `COALESCE(finished_at, created_at)`. 게시: `available_at` | 게시를 `sent`로 바꾸는 유일한 자리(`deliveryState`)가 `available_at`을 그 시각으로 적는다. 따로 보낸 시각 칸은 없다 |
| `blocked` 게시 | `sent`와 함께 지운다. 기준 시각은 막기 전 마지막 예정 시각(`available_at`) | 끝 상태이고 다시 열리는 길이 없다. 결정 표의 "보낸 지"를 끝 상태 전체로 넓혔다 |
| `kind=thread` 게시 | 고르지 않는다 | content가 원문이 아니라 event ID이고 경보 묶음이 그 값으로 이어 붙인다 |
| 질문·결과 예외 | T27 질문 답과 같다: job이 끝 상태가 아님, 세션이 `running`·`waiting_answer`·`waiting_model`·`unknown`이거나 `cleanup_state='pending'` | 마무리(finalize)는 `results.evidence`의 `resultDigest`만 읽어 evidence는 남긴다 |
| brief | summary·goal·acceptanceCriteria만 비우고 경로·명령·label·`brief_digest`는 남긴다. artifact·요청 원문과 같은 질의·같은 트랜잭션 | admission CHECK·`brief_digest` 불변 트리거·짝 CHECK 때문에 NULL로 둘 수 없다. brief를 읽는 경로는 모두 진행 단계다 |
| superseded 건의 새 generation | 막는다. T27 `input_purged`가 그대로 적용된다 | 새 generation은 brief를 요청 원문에서 다시 만든다. 요청 원문을 같은 트랜잭션에서 지우므로 따로 막을 것이 없다 |
| 부르는 자리 | 네 칸은 새 `raw_text_retention`(1시간), brief는 기존 `change_retention`. `change_retention`은 한 바퀴에 20건×20번(`purgeExpiredChangeContentRounds`)이다 | T27의 `change_retention`은 한 쪽(20건)만 불러 결정 기록의 "20번"과 달랐다. 이번에 맞췄다 |
| 한 바퀴 | 네 칸 각각 200행×20번 | T27 질문 답과 같다 |
| 복원 | 시각 기준이라 복원된 옛 행도 다음 정리가 다시 비운다. 원문이 다시 보이는 창은 최대 1시간(재시작이면 게시 서버가 뜬 직후 첫 바퀴까지) | 백업 자체에 든 원문은 백업 보존 기간(14일) 동안 남는다 |

**받아들인 영향.** 받은 지 7일이 지난 요청은 작업이 그 뒤에 실패해도 바로 비워져 `/retry`할 수 없다(같은 내용을 새로 요청). 끝나지 않는 작업·변경, 확정되지 않는 게시의 원문은 7일을 넘겨 남는다. 기억 삭제(T20)는 여전히 `events` 행을 지우지 않지만 원문은 7일 뒤 비워진다.

**CHANGE 정리의 선정·삭제 경합 (T32, T21 재감사 A09).** `purgeExpiredChangeContent`는 후보를 잠금 밖에서 고른 뒤 건마다 트랜잭션에서 지운다. 그사이 owner가 새 generation을 열고 그 generation이 다시 끝나면, 부모 phase만 다시 보던 정리가 끝난 지 0ms인 새 generation의 artifact·리뷰 원문·요청 원문·brief까지 지우고 다음 generation을 `input_purged`로 막았다. 이 구조는 T27 전 artifact 정리부터 있었고 T27·T31이 지우는 범위를 넓혔다. 이제 부모 행을 `FOR UPDATE`로 잠근 뒤 선정 질의와 같은 조건 전체(현재 generation의 끝 상태와 기준 시각 cutoff, 배포 관측·늦음 표시, 미확정 effect, 진행 중 자식 job·정리 전 세션, 지울 것이 남았는지)를 그 id로 다시 돌고 맞을 때만 지운다. generation·`updated_at` CAS는 배포 관측·자식 job·effect 변화를 잡지 못해 쓰지 않았다. 잠금과 재검사를 한 문장(`SELECT … FOR UPDATE OF r`)에 두지 않는 이유는 PostgreSQL의 재평가가 잠근 행만 새로 읽고 조인·하위 질의는 옛 스냅숏으로 보기 때문이다. effect 기록·배포 관측·자식 job 연결은 모두 부모 행을 `FOR SHARE`/`FOR UPDATE`로 잡아 재검사와 커밋 사이에 끼어들지 못한다(`linkChildJob`도 부모를 `FOR SHARE`로 잡는다). 자식 job·세션 행과 늦음 표시는 부모 잠금 없이 바뀌므로, 재검사를 "고름 → 제외"로 뒤집는 전이가 없어야 한다. 그래서 정리 전 세션은 진행 중 상태, `cleanup_state='pending'`, 작업자 공간이 남은 세션(`session_retained`) 셋 중 하나면 제외한다. `ClaudeChangeAuthor.finalize`가 세션을 `completed`로 커밋한 뒤 `finalizeJob`이 작업자에 묻고 `execution_lanes`만 잠근 채 pending을 쓰기 때문에, 그 사이의 `completed`·`none` 세션을 상태와 pending만으로는 잡지 못한다. 그 세션을 고르면 재검사 뒤 커밋된 pending을 정리가 보지 못해 원문을 지우고 다음 generation이 `input_purged`로 막힌다. finalize 뒤 프로세스가 죽어도 같은 세션이 sweep까지 남는다. `session_retained`는 작업자 정리를 확인한 뒤에만 `false`가 되고 `true`가 되는 곳은 세션 시작(job이 running이라 이미 제외)뿐이며, pending 표식도 running 세션(턴 확정)이나 이미 retained·pending인 세션(`finalizeJob`)에만 쓰여 이 전제가 선다. job은 끝 상태에서 다시 열리지 않고, 늦음 표시는 NULL일 때 지금 시각으로 한 번 적혀 cutoff를 넘지 않는다. 끝 상태 커밋과 pending 표식을 한 트랜잭션에 묶는 방법은 쓰지 않았다. 표식은 작업자 응답을 기다린 뒤라 묶으려면 작업자 호출을 트랜잭션 안에 두거나 finalize·settle·sweep의 끝 전이마다 표식을 함께 써야 하는데, retained는 이미 모든 끝 전이에 같은 뜻으로 남아 있다. 작업자가 끝내 답하지 않는 세션은 retained·pending으로 남아 그 변경의 원문도 남는다. 이는 pending과 같은 성질이고 `homelab_bot_task_sessions_retained`·`homelab_bot_task_cleanup_pending` 지표로 보인다. 제외 조건에 새 세션 칸을 쓰거나 세션 전이를 더하면 이 전제를 다시 확인한다. 반환값은 실제로 지운 건수다. `raw-text-retention.ts`의 네 칸과 T27 `purgeExpiredTaskAnswers`는 고르기와 비우기가 UPDATE 한 문장이라 모든 조건을 한 스냅숏에서 보고 대상 행 자체의 조건은 재평가된다. 선정과 삭제 사이의 시간차가 없어 이 경합에 들지 않는다. `events` 원문과 `/retry`의 엇갈림은 위 scheduler 행 잠금이 맡는다. 재현은 `test/change-purge-race.test.ts`(PGlite, 실제 PostgreSQL 두 연결)다.

## T33 V1 정비 (T21 4회차 low A05·A08, 구현 선택이며 사용자 결정 아님)

**승인 명령을 한 메시지에 둔다 (A05).** `messagePages()`가 일반 글을 1,800자마다 잘라, CHANGE 게시 미리보기의 `/change-publish target:… text:<digest>` 줄이 경계에 걸리면 digest가 두 메시지로 갈렸다(감사: 파일 10개·최대 경로 192자, digest 시작 1775). 이제 일반 글은 1,800자 안의 마지막 줄바꿈에서 자르고, 줄바꿈이 없거나 앞쪽이 공백 줄뿐일 때만 글자 수로 자른다(대리쌍 보호는 그대로). 그래서 1,800자보다 짧은 줄은 어느 메시지에서든 갈리지 않는다. 승인 명령만 따로 보내는 방법은 쓰지 않았다. 게시 키가 둘이 되어 복구·순서 규칙을 새로 따져야 하고, 다른 명령 안내(`/review-resume`·`/resume-model`·`/task-release`·`/retry`·`/answer`·`/change-status` 등)도 같은 `messagePages`를 지나는데 모두 한 줄에 들어 있어 줄 단위 규칙 하나로 함께 지켜진다. 이 안내들은 지금 대부분 메시지 전체가 1,800자 아래라 나뉘지도 않는다. 페이지는 넣을 때 한 번 계산해 `outbox`에 저장하므로 배포 전에 넣은 메시지의 페이지는 바뀌지 않는다. 대가: 페이지가 줄 끝에서 끊겨 같은 글이 이전보다 한 페이지 더 나올 수 있다. 1,800자보다 긴 한 줄(예: 아주 긴 경로) 안의 토큰은 여전히 갈릴 수 있다. 시험은 `test/change-preview-pages.test.ts`(실제 `ChangeRuntime.preview`, 경계가 digest 앞·첫 글자 뒤·중간·마지막 글자 앞·바로 뒤, 둘째 경계)다.

**guild 명령 비교에서 `contexts`·`integration_types`를 뺀다 (A08).** Discord 문서(Application Commands, application command object)는 두 필드를 "only for globally-scoped commands"로 적고, Create Guild Application Command는 둘을 받지 않는다 [확인: https://raw.githubusercontent.com/discord/discord-api-docs/main/developers/interactions/application-commands.mdx, 2026-11-09]. 운영 guild GET도 32개 명령 모두 두 필드를 생략해(T30 INT-03 ⑥) 요청 모양과 늘 어긋났고, 재시작마다 `guild: updated` PUT이 나갔다. 비교에서 두 필드를 빼고 PUT 본문에는 그대로 둔다(guild 명령에는 효과가 없고, 전역으로 옮길 때 DM이 열리지 않게 한다). 비교는 이 봇이 정하는 필드(이름·type·설명·옵션의 type·name·설명·required·max_length)만 보고, 문서상 생략 가능한 값은 기본값으로 맞춘다(type 1, required false, options 빈 목록). `nsfw`·`dm_permission`·`default_member_permissions`·`id`·`version`·localization은 원래부터 zod가 버려 응답에 있든 없든 비교가 같다. 그래서 같은 문제가 없다. 대가: 정의에서 `contexts`·`integration_types`만 바꾸면 PUT하지 않는다. 앞으로 `nsfw`·`default_member_permissions` 같은 필드를 정의에 넣으면 비교에도 넣어야 바뀐 값이 등록된다. 시험은 `test/commands-register.test.ts`(생략 모양 연속 등록 PUT 0, 정의 변경 PUT 1)다.

---

## 동료 봇 전환 (사용자 2026-11-09)

feature-plan 합의로 정했다. 질문마다 사용자가 에이전트 추천을 받아들이거나("예") 다른 값을 골랐다. 명세는 [COLLEAGUE_SPEC.md](COLLEAGUE_SPEC.md), 용어는 저장소 루트 `GLOSSARY.md`다. 구현은 T21 수용(2026-11-09) 뒤 티켓으로 한다.

1. **호출:** **멘션 요청**이 기본이다. 허용 채널(대화·알림) 어디서든 받고, 봇이 만들지 않은 스레드와 오래 쉰 스레드도 받는다. 봇 글에 답장하면 그 봇 글을 자료로 넣는다(봇 자신의 글만). '/' 명령은 시범 동안 안내 없는 예비로만 남고, 없앨지는 시범 뒤에 정한다. 말로 하는 구독 끄기는 두지 않는다.
   구현(C08): 받는 자리는 `DiscordIngress.receive`(알림 채널 부모 멘션 수용), 봇 글 답장은 `gatewayMessage`가 읽은 `replyTo`와 `chat-context.ts`의 `replied_bot_post` 자료 항목(본문은 outbox 게시 확정 본문), 멘션 표기 제거는 `ownerText`다. 계약은 [ARCHITECTURE](ARCHITECTURE.md) §6 "Discord 입력"·§13 "봇 답 문맥", 검증은 [VERIFICATION](VERIFICATION.md) "C08 멘션 범위와 답장 맥락".
2. **모델은 제안만 한다:** 대화 호출 한 번이 답과 제안 하나를 낸다. 실행 요청은 봇이 한 줄로 되묻고 owner가 버튼으로 확정해야 실행된다. 읽기 요청은 바로 답한다. 작업 질문은 열린 질문이 하나면 다음 말이 답이다. 변경 게시는 미리보기 digest에 묶인 버튼으로 승인하고 digest 입력은 예비로 남는다. 세션 연결 키는 버튼 뒤 본인만 보이는 응답으로 준다. 이 결정은 "대화 모델 출력은 글만 쓴다"는 이전 방어를 "실행은 owner의 버튼 상호작용으로만 일어난다"로 바꾼다.
3. **관리 기능은 CLI로:** 비상 정지·해제·차단·상태 보기·unknown 해제는 `homelab bot` CLI(클러스터 접근)로 한다. 말로 하지 않는다. 관리자 페이지는 두지 않는다. 차단 해제는 지금의 Infisical 절차 그대로다. ARCHITECTURE §6의 "즉시 철회 명령의 경계"('/' 명령 계약)는 구현 티켓이 "클러스터 접근 권한으로 도는 CLI 관리 명령, 모델을 거치지 않고 거부를 더할 수만 있다"로 고치고 T21 영향 항목을 다시 검증한다. 구현 위치: 봇 `src/admin.ts`·`src/admin-main.ts`, homelab `cli/src/commands/bot.ts`(아래 "C05 관리 CLI").
4. **말투:** Discord와 GitHub PR 리뷰 모두 해요체 **동료 말투**다. **고정 문구**는 사람이 다듬는다. 리뷰는 심각도를 두고 조건·영향·근거·개선을 한 문단으로 쓴다. **대조 표식**은 작게, 스레드 제목은 사람이 읽게 한다. **owner 호출**은 owner 손이 필요할 때만 하고 답장은 알림 없이 단다.
5. **반응:** 👀 받음, ⏳ 대기, 💤 모델 멈춤 중 대기, 답하면 지움(✅ 없음), 실패면 지우고 한 줄, 답이 필요 없는 말은 👍(모델이 판단).
   구현(C04): 👀·⏳·지움·실패는 `src/reactions.ts`(상태 표·`ReactionSync`), `Store.claim`(⏳ 판단), 게시 확정·실패·취소 확정의 정리다. 👍·💤는 같은 상태 표에 이름을 더한다. 계약은 [ARCHITECTURE](ARCHITECTURE.md) §13 "수신·진행 신호", 검증은 [VERIFICATION](VERIFICATION.md) "C04 반응 수명".
6. **기억:** 대화 기록 상한을 20개·32KiB에서 50개·80KiB로 올린다(에이전트 추천은 40개·64KiB, 사용자가 50개를 골랐고 바이트는 같은 비율). 원문 7일 정리(T31)는 그대로이고, 오래된 스레드에서는 앞 내용이 기억나지 않는다고 말한다. 기억을 지우면 원래 메시지가 7일 뒤 지워진다고 알린다. 말로 한 기억 원문을 따로 봉인하지 않는다.
7. **모델 멈춤:** 한도는 CLI `rate_limit_event`의 풀리는 시각 1분 뒤 같은 계정으로 저절로 이어서 한다. 시각을 모르면 30분마다 다시 시도한다. 결제 멈춤은 저절로 재개하지 않는다. 한도 경고(`allowed_warning`)가 오면 리뷰부터 미룬다. Discord에는 **자리 비움**(상태·💤·원인 없는 한 줄)만 보이고, 원인·풀리는 시각·할 일은 Telegram **운영 알림**으로 간다(에이전트 1차 추천은 Discord에 원인·시각을 한 번 적는 것이었고 사용자가 Telegram으로 바꿨다). 토큰 만료 30일 전부터 브리핑에 알린다.
   구현(C20, 자리 비움): 멈춤 판단·회차 `src/away.ts`, Gateway 상태 `src/gateway.ts`(`setPresence`, READY·RESUMED 복원)와 `src/main.ts` 루프 `model_away`, 💤 `src/reactions.ts`의 `away` 상태, 한 줄 `CHAT_TASK_TEXT.away`(대기 진입·owner 호출 모두 멱등 키 `away:<채널>:<회차>`). 계약은 [ARCHITECTURE](ARCHITECTURE.md) §13 "자리 비움과 Gateway 상태 (C20)", 구현 선택은 아래 "C20 자리 비움", 검증은 [VERIFICATION](VERIFICATION.md) "C20 자리 비움".
8. **계정 전환:** owner가 CLI로 계정을 등록하고(구독은 `claude setup-token` OAuth, API 크레딧은 Console API 키), 계정과 쓰는 방식을 골라 바꾼다. 대화·리뷰·작업이 함께 바뀐다. 에이전트는 다른 구독 계정으로 바꾸는 것이 Anthropic 에이전트 사용 안내의 "보호 장치를 피하려는 여러 계정" 금지로 읽힐 수 있다고 알렸고, 사용자는 "정책으로 확인이 안 되었으니 일단 제공"으로 정했다. 약관은 새 이용 정책 시행(2026-11-12) 뒤 구현을 시작할 때 다시 확인한다. API 크레딧 방식은 사용자 질문에서 더했다(Max·Ultra 월 크레딧, 확인 2026-11-09 support.claude.com "Monthly API credits for Max and Team plans"). D-14 조건 2·5의 바뀐 문구는 D-14 절에 있다.
9. **스위치:** 기본 꺼짐의 임시 스위치 하나가 말로 실행하는 기능과 '/'를 안내하는 고정 문구만 막는다. 나머지는 배포로 적용된다. 배포 순서를 지키려는 장치이고, 시범이 끝나 '/'를 정리할 때 같이 없앤다.
10. **범위 밖:** 리뷰·대화 병렬 처리(따로 계획, 리뷰 시간 측정부터), Codex 전환(시범 뒤 API 크레딧이 모자라면 따로 계획, 지금의 설정 PR 전환은 그대로), 긴 스레드 요약, 원문 장기 보관(V1 판정 뒤), 관리자 페이지.
11. **명세 세부(사용자 2026-11-09, 추천 수락):** 제안 버튼 만료 24시간. 말로 시킨 작업·변경 내용은 owner 원문을 쓰고 모델은 대상과 동작만 고른다(기억 저장 내용은 모델이 골라 확인 글에 그대로 보인다). owner 호출은 작업 질문, 작업 완료·실패, 변경 미리보기, 변경 실패 넷. 멘션으로 시작한 대화는 owner 메시지에서 스레드를 연다. 리뷰를 미루는 동안 대화와 작업은 계속한다. 검증 경계는 명세 6절 S1~S5다.
12. **시기(사용자 2026-11-09):** V1 시범 운영(homelab T35, 2주)을 이 작업이 끝난 뒤로 미룬다. 그래서 티켓은 선행 관계대로 병합하고, 시범 운영은 동료 기능을 켠 봇을 대상으로 한다. 에이전트 추천은 "시범 중에는 동작이 그대로인 티켓만 병합"이었다.
13. **리뷰 제어 장소(사용자 2026-11-09):** 말로 하는 리뷰 재개·취소는 owner가 허용 채널(대화·알림)이나 그 아래 스레드 어디서 말해도 받는다. '/' 리뷰 제어의 "알림 채널 본문" 제한은 '/' 예비에만 남는다.
14. **변경 질문(사용자 2026-11-09):** 변경 작업은 웬만하면 묻지 않고 가정해서 진행하고, 가정은 미리보기와 PR 설명의 "확인할 것"에 적는다. 진행이 불가능할 때만 Discord에 질문과 선택지 버튼(2~4개), "직접 답하기"(다음 말)를 단다. 공개 여부는 따로 묻지 않는다. 처음 게시 전에는 미리보기 승인이 공개를 막는다. 에이전트가 검토하고 뺀 방법: 다음 말 + 공개 버튼, 입력 창(모달), PR에서 묻기. 구현 위치(작업자 지시문·출력, C25): 아래 "동료 봇 전환 14·16 작업자 변경 작성 v2 판".
15. **변경 요청 확인 문구(사용자 2026-11-09):** 말로 한 변경 요청의 실행 확인은 "<저장소>에 이 변경 PR을 준비할까요?"로 묻고, 누르면 지금 규칙의 공개 표시(`label=public`)로 접수한다. 공개 여부를 따로 묻지 않는다.
16. **PR 수정 반복(사용자 2026-11-09):** 처음 게시는 지금처럼 Discord 미리보기 승인 뒤다. 게시한 변경 PR을 고치는 **수정 요청**은 Discord에서 owner만 한다. PR은 읽기와 리뷰만 하는 곳이고, PR의 리뷰·댓글(다른 계정 것 포함)은 수정 요청 때 자료로만 읽는다. 수정 요청도 실행 확인 버튼을 거치고, 시험·자체 리뷰·공개 검사를 통과하면 미리보기 없이 같은 PR 브랜치에 수정 커밋을 올린다. 결과와 실패 이유는 Discord로만 알린다. 한 PR에 수정은 최대 10번이다. 에이전트 1차 추천은 "이 계획 뒤 별도 계획", 사용자는 "이 계획으로 진행", 그다음 사용자가 "PR은 읽기 전용, 수정 요청은 Discord에서만(누가 시켰는지 추적)"으로 정했다. 구현 위치(GitHub 포트, C26): 아래 "동료 봇 전환 16·17 구현 위치". 구현 위치(작업자 수정 차례 입력, C25): 아래 "동료 봇 전환 14·16 작업자 변경 작성 v2 판". 차례 모델(generation을 올리지 않고 차례 키를 더함)과 수정 요청 label 판단(C27): 아래 "동료 봇 전환 16 수정 요청 구현 선택".
17. **안내 댓글(사용자 2026-11-09):** 봇 PR에는 자체 리뷰 전체를 달지 않고, 가정한 곳과 남은 위험에만 짧은 리뷰 댓글을 단다. 자체 리뷰에서 찾은 문제는 게시 전에 고친다. 지금 코드는 P0·P1이면 바로 막으므로, 게시 전 고치기 차례(최대 2번, 기본값)를 더한다(티켓 C31). 수정 차례 뒤 diff 밖 확인할 것은 PR 설명을 고치지 않고 Discord 결과 요약에 싣는다. 구현 위치(게시 포트, C26): 아래 "동료 봇 전환 16·17 구현 위치".
18. **리뷰 요청(사용자 2026-11-09):** owner가 Discord에서 "이 PR 리뷰해 줘"라고 하면 확인 없이 리뷰를 시작한다. 대상은 리뷰 App이 설치된 ukyi-app 조직 저장소다. 리뷰 App `ukyi-review`의 설치 범위를 조직의 모든 저장소로 넓힌다(owner가 GitHub에서 수행, 승인 기록). 자동 리뷰 대상은 지금 정책 목록(`homelab-smoke`) 그대로이고, 넓히는 일은 리뷰 시간 측정과 병렬 처리 계획 뒤 저장소별로 정한다(이유: 대화와 같은 모델 자리, Codex 리뷰 중복(D-16), V1 시범 범위).

---

## R08 명시적 Codex 연결 (결정 ID 없음)

**상태:** 보류. 확정(사용자 2026-10-18, T15): R08(V1 기능 3, 사용자가 명시적으로 연결한 기존 Codex 작업)은 요구를 그대로 두고, 연결 방식은 T18(CODEX_BRIDGE)에서 다시 판단한다. 그때까지 보류한다. T15 질문에서 "T18에서 다시 판단"을 에이전트 추천으로 제시했고 사용자가 골랐다.

- 사람의 개인 세션을 `capability=false`로 정한 것이 아니다. T15 초안이 그렇게 적었던 곳(ARCHITECTURE §4, VERIFICATION, 설정 초안, V1_PLAN TASK-01)은 "보류(T18)"로 고쳤다.
- 근거로 남기는 조사 결과: herdr를 거치는 연결은 Codex 상태를 화면으로 추정하고 [확인: https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/website/src/content/docs/integrations.mdx "Codex state comes from Herdr's screen manifest detection"], 소켓 API의 인증·접근 제어가 문서에 없어 [확인: https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/website/src/content/docs/socket-api.mdx, 실측: 소켓은 사용자 소유 0600] 쓰지 않는다.
- T18이 볼 입력: 개인 CODEX_HOME과 herdr 소켓에 봇이 닿지 않는 연결 방법. 예를 들어 사람이 상태를 봇에 보내는 Codex 공식 훅이 후보다. 공식 훅 이벤트 목록은 아직 확인하지 않았다 [미확인].
- 봇 소유 작업의 재개(`exec resume`, 봇 CODEX_HOME 안 세션)는 R10 경로이고 이 보류와 별개다.
- T18 후보·근거·추천(2026-10-29): 아래 "T18 결정 대기 (사용자)" (1). 사용자가 2026-11-04에 정했다(아래 "T18 결정 (Claude 실행기 기준)" (1)). Codex 어댑터의 `attach_task`는 `false`이고 R08은 별도 경로다(ARCHITECTURE §12·§15).

---

## T18 결정 대기 (사용자) → 확정(사용자 2026-11-04, 아래 "T18 결정 (Claude 실행기 기준)")

- 작성: T18 CODEX_BRIDGE 로컬·mock 작업(2026-10-29, 에이전트). **아래 넷은 사용자가 정한다. 에이전트는 정하지 않았고, 구현은 결정과 무관한 부분만 했다.** 구현과 시험은 [ARCHITECTURE.md](ARCHITECTURE.md) §12, 결과는 [VERIFICATION.md](VERIFICATION.md) "CODEX_BRIDGE T18"이다.
- 근거 꼬리표의 확인일은 따로 적지 않으면 2026-10-18 T15 조사다. 이번 작업은 네트워크를 쓰지 않아 새로 확인한 공식 문서가 없다.
- 답이 필요한 때: (2)·(4)는 T17이 기다린다([V1_PLAN.md](V1_PLAN.md) §2 T17 진입 조건). (1)은 T18 완료 조건이다. (2)·(3)이 설계 C.8(작업자 상주 파드 하나, 동시성 1, 작업자 자격 하나)을 바꾸면 그 변경도 사용자 결정이다.

### (1) R08 연결 방식 (T18 할 일 1)

질문: 사람이 자기 터미널에서 돌리는 기존 Codex 작업을, 봇이 개인 CODEX_HOME·herdr 소켓에 닿지 않고 어떻게 "명시적으로 연결"해 조회하는가. herdr 경유는 이미 제외다(T15).

| 후보 | 내용 | 장점 | 단점·위험 |
|---|---|---|---|
| **A. 사람 쪽 알림 훅이 봇에 밀어 넣기(읽기 전용)** | 사람이 자기 Codex 설정에 턴 완료 알림 프로그램을 걸고, 그 프로그램이 연결 토큰으로 서명한 최소 이벤트(외부 작업 ID, 턴 완료, 길이 제한한 요약)를 봇에 보낸다. 공식 `notify` 설정이 후보다 [미확인: 0.163.0의 이벤트 종류·payload 재확인 필요]. 봇은 `/attach`로 연결 기록(owner·대화·외부 ID·허용 능력)을 만들고 토큰을 한 번 보여 준다 | 봇이 개인 홈을 읽거나 제어하지 않는다. 사람이 세션마다 켜고 끈다. 조회·완료 중계가 된다 | 질문 답·취소는 못 한다. 사람 기계 → 봇 수신 경로가 새로 필요하다(공개 webhook 경로 재사용 또는 내부 경로, 플랫폼 결정). 알림에 비공개 대화 내용이 실릴 수 있어 길이·분류 검사가 필요하다. 훅 이벤트 목록 [미확인] |
| B. 수동 연결 기록만 | 사람이 `/attach`로 외부 작업 ID와 상태 메모를 남기고 봇은 기록만 보여 준다 | 새 수신 경로가 없다. 가장 단순하다 | 실시간 조회가 아니라 R08 "조회"를 거의 채우지 못한다 |
| C. 사람 세션을 봇 소유로 넘기기 | 사람이 세션 파일을 봇 CODEX_HOME으로 옮기고 봇이 `exec resume` | 이후 봇 소유 경로(R10)를 그대로 쓴다 | 개인 Codex 데이터를 봇 공간으로 복사한다(D-14 조건 1 위반 소지). 계정이 달라 재개되는지 [미확인]. 제외 권장 |
| D. 사람이 띄운 `codex app-server`에 봇이 클라이언트로 붙기 | 승인·질문 API가 있다 | 기능이 가장 넓다 | 공식 문서가 "experimental and aren't supported for production workloads"라고 한다 [확인: https://learn.chatgpt.com/docs/app-server]. 봇이 사람 세션을 제어하게 되어 개인 세션 통합 제어 금지(`01` §6)와 부딪친다. 제외 권장 |
| E. R08을 V1에서 줄이기 | 연결 기능을 `capability=false`로 두고 V1 밖으로 | 구현이 없다 | R08은 V1 필수다(C-08). 범위 조정이라 V1 판정에 영향 |

**에이전트 추천: A를 읽기 전용으로.** 개인 홈·소켓에 닿지 않는 후보 중 R08 "조회"를 실제로 채우는 것은 A뿐이다. 함께 둘 조건:

- 연결 기록의 허용 능력은 `read_status`·`read_events`만 true, `answer_question`·`request_cancel`은 false로 표시한다.
- 연결 토큰은 연결마다 따로 만들고 해제 때 폐기한다. 미등록 토큰·다른 owner의 이벤트는 거부한다.
- 받은 이벤트는 비신뢰 자료로 저장하고 길이 제한한 요약만 그 대화에 게시한다. 완료 판정은 하지 않고 "사람 세션이 턴을 끝냈다고 알림"으로만 표시한다.
- 공식 훅의 이벤트·payload를 T16b 전에 확인한다. 안 되면 B로 물러난다.
- 사람 기계 → 봇 수신 경로는 플랫폼 자리라 T16b·플랫폼 설계와 함께 정한다.

### (2) 인증 파일을 작업 레인 비신뢰 코드에서 떼는 방법 (T18 할 일 5 (1))

현재 작업자 파드·UID 하나에 `auth.json`과 비신뢰 코드(모델이 띄우는 셸, 작업 코드의 설치·시험)가 함께 있다. 같은 UID라 디렉터리만 나눠서는 읽기를 막지 못한다(ARCHITECTURE §5.1).

| 후보 | 막는 것 | 못 막는 것·대가 | 설계 C.8 변경 |
|---|---|---|---|
| a. 봇이 직접 돌리는 설치·시험을 인증 파일 없는 별도 컨테이너나 파드로 | 작업 코드의 lifecycle 훅·시험이 `auth.json`에 닿는 것 | 모델이 띄우는 셸은 여전히 codex와 같은 곳에서 돈다 | 예(작업자 구성 추가) |
| b. Codex 샌드박스로 모델 셸의 CODEX_HOME 읽기 막기 | 모델 셸의 직접 읽기 | 막을 수 있는지 [미확인]. `read-only`·`workspace-write`는 쓰기 제한이고 읽기는 넓다 [가정]. 파드 안 bwrap 동작 [미확인] | 아니오 |
| c. 작업별 UID·마운트 namespace로 CODEX_HOME을 모델 셸에서 숨기기 | 모델 셸·작업 코드의 읽기 | codex 자신은 읽어야 해서 셸만 다른 UID로 띄우는 수단이 필요하다. Codex에 그런 자리가 있는지 [미확인]. 비특권 파드에서 `unshare` [미확인] | 아니오(파드 보안 설정은 바뀔 수 있음) |
| d. API 키 + 공식 `codex-responses-api-proxy`로 전환 | 키가 codex 프로세스 밖에 있다 | D-14를 바꾼다(구독 → API 과금). 구독 `auth.json`에는 그대로 맞지 않는다 [가정] | 예(D-14 변경) |
| e. 결과 게시 전 `auth.json` 값 반사 검사 (T18 구현) | 결과·질문에 실린 토큰(띄어 쓰거나 기호를 끼운 조각 포함)이 Discord·PR로 나가는 것 | best-effort다. base64 같은 변형, 읽기 자체, 다른 경로 유출은 못 막는다. 보완책이고 SEC-02 pass 근거가 아니다 | 아니오 |

**에이전트 추천: a + b·c 실측(T16b) + e(구현됨).** 실측에서 b·c가 모두 안 되면, 비신뢰 코드를 모델 셸로 돌리는 작업은 d로 바꾸기 전까지 하지 않는다. 봇 소유 작업이 공개 저장소 코드로 모델을 부르는 일은 D-14 차단 조건에 묶여 있어, 결정 전 위험은 로컬·mock에 머문다. 이 결정은 T17·T18 중 먼저 모델을 부르는 단계 전에 필요하고, SEC-02 "작업 레인 비신뢰 코드에서 `auth.json` 읽기 → 거부" 사례는 결정과 T16b 실측 전까지 `blocked`다.

### (3) 대화 레인과 작업 레인 분리 (T18 할 일 5 (2))

| 후보 | 내용 | 장점 | 단점 |
|---|---|---|---|
| **i. 현행 유지** | 파드 하나, `auth.json` 하나, 대화·작업 합산 직렬 1(D-14 조건 3) | 설계 C.8 그대로. 공식 "one auth.json per runner or per serialized workflow stream"과 맞는다 [확인: https://learn.chatgpt.com/docs/auth/ci-cd-auth] | 긴 작업·질문 대기 중 대화가 기다린다(OPS-01). 대화 레인이 비신뢰 코드와 같은 파드다 |
| ii. 파드 둘, 같은 계정으로 레인마다 따로 로그인한 `auth.json` | 대화 레인이 비신뢰 코드와 떨어지고 작업을 기다리지 않는다 | 같은 계정 사본 둘의 허용 여부 [미확인]. D-14 조건 5(여러 계정 순회 금지)와의 관계 확인 필요. 한도는 공유한다 |
| iii. 파드 둘, 대화 레인만 다른 인증(API 키) | 분리 + 레인별 비용 통제 | D-14 변경 |
| iv. 파드 하나, 레인별 UID·마운트 분리 | 대화 세션 파일이 작업 레인에서 안 보인다 | 여전히 직렬 1. 수단 [미확인] |

**에이전트 추천: V1은 i 유지 + (4)의 작업별 세션 저장 공간으로 세션 파일 노출을 줄이기.** T16b·OPS-01에서 대화 대기 시간을 재고 예산을 넘으면 ii를 다시 본다. ii는 OpenAI 확인 항목(D-14 남는 위험)이 풀린 뒤에만 고른다.

### (4) 작업별 세션 저장 공간과 인증 파일 되쓰기 (ARCHITECTURE §5.1 열린 항목)

| 후보 | 내용 | 대가 |
|---|---|---|
| **α. 작업별 CODEX_HOME + `auth.json` 쓰기 가능 사본. 끝나면 제어 프로세스가 직렬로 공유 원본에 되쓴다(사본의 `last_refresh`가 더 새로울 때만)** | 세션 파일이 작업마다 나뉜다. T18 작업 경로(`tasks/<job>/codex-home`)가 이 모양의 자리를 둔다 | 같은 UID면 다른 작업 디렉터리 읽기는 못 막는다(UID·마운트 분리 필요). 되쓰기 실패 처리가 필요하다 |
| β. 공유 CODEX_HOME 하나(현행 설계) | 단순하다 | 모든 작업·대화 세션 파일이 한곳에 있다(§5.1 위험) |
| γ. 대화·리뷰 레인은 `--ephemeral`, 작업 레인만 α | 재개가 필요 없는 레인은 세션 파일을 남기지 않는다 | `--ephemeral` 동작 [미확인] |

- 취소·`unknown` 작업의 사본: **에이전트 추천은 `unknown`이면 되쓰지 않고 보존한 뒤 사람이 확인.** 소멸 확인이 안 된 작업의 사본은 아직 다른 프로세스가 쓰고 있을 수 있다. `cancelled`(소멸 확인됨)는 `last_refresh`가 새로우면 되쓴다.
- **에이전트 추천: α, 대화·리뷰 레인은 γ 검토, UID·마운트 분리는 T16b 실측 뒤.** 세션 보존 기간과 R17 삭제 때 세션 기록 처리는 T20과 함께 정한다.

---

## T18 결정 (Claude 실행기 기준, 사용자 2026-11-04)

위 "T18 결정 대기" 네 건은 Codex `auth.json`을 전제로 쓰였다. 실행기가 Claude Code CLI(구독 장기 토큰 `CLAUDE_CODE_OAUTH_TOKEN`, env-static)로 바뀐 뒤 사실을 다시 확인했다. 확인한 출처는 공식 문서와 고정 바이너리 2.1.308의 `--help`·문자열이다. 그 뒤 사용자가 추천안 넷을 그대로 골랐다. 같은 날 T17 진입 조건 하나도 정했다. 조사 원문은 비공개 작업 문서(2026-11-04 T18 Claude 사실 조사)에 있다.

**다시 확인한 사실.**

- Bash 도구가 띄우는 명령은 부모 env를 그대로 물려받는다. 그래서 작업 레인에서 셸을 켜면 토큰이 셸 명령에 보인다. `echo`·`cat` 같은 읽기 명령은 `dontAsk`로도 막지 못한다 [확인: https://code.claude.com/docs/en/sandboxing 기본값 표, https://code.claude.com/docs/en/permissions 읽기 전용 명령].
- 공식 대책은 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`이다. 2.1.83에서 env 제거가, 2.1.98에서 Linux PID namespace 격리가 들어왔다. 2.1.308 바이너리의 제거 목록에 `CLAUDE_CODE_OAUTH_TOKEN`이 있다 [확인: https://code.claude.com/docs/en/env-vars "What the subprocess environment scrub removes"] [실측: 바이너리 문자열].
  - 이 모드는 bubblewrap 샌드박스를 강제하고 새 `/proc` 마운트를 요구한다. 그래서 비특권 파드(user namespace 없음, `procMount` 기본, 이미지에 bwrap 없음)에서는 실패할 가능성이 크다 [해석: 파드 실측 전].
  - 권한 모드도 `default`로 바뀐다. 그래서 `--allowedTools`를 명시해야 한다.
- 같은 UID의 다른 프로세스는 `/proc/<pid>/environ`으로 env를 읽을 수 있다. `hidepid`도 같은 UID는 막지 못한다 [실측: 가짜 값].
- 클러스터 프록시가 구독 토큰을 대신 붙이는 방식은 쓸 수 없다. Claude Code Legal의 "may not collect, store, or intermediate Claude.ai credentials or session tokens"에 정면으로 걸리기 때문이다 [확인: https://code.claude.com/docs/en/legal-and-compliance]. 작업자 밖에 키를 두는 방식은 Console API 키 + LLM gateway만 공식이다.
- 작업 재개 방법: 처음에 `--session-id <uuid>`를 주고, 다음 턴에 `-p --resume <uuid>`로 잇는다. 세션은 `$CLAUDE_CONFIG_DIR/projects/` 아래에 남는다. `--no-session-persistence`를 쓰면 재개할 수 없다. 같은 세션을 동시에 재개하면 안 된다.
- Codex의 "`auth.json` 하나당 직렬 흐름 하나" 같은 조건은 Claude 문서에 없다. 한도는 계정 전체가 함께 쓴다.
- R08의 사람 쪽 이벤트는 공식으로 있다. Claude Code hooks의 `Stop`(`last_assistant_message`)·`Notification`과 Codex `notify`(`agent-turn-complete`)다. 다만 payload에 마지막 답 전문과 `cwd`가 실린다.

**결정.**

| 항목 | 결정 |
|---|---|
| (1) R08 연결 방식 | **A 읽기 전용 알림.** 사람 쪽 Claude Code `Stop` 훅(처리기는 `command`, `async: true`)과 Codex `notify`가 최소 필드만 연결 토큰으로 서명해 봇에 보낸다. 최소 필드는 외부 작업 ID, 턴 완료, 길이를 제한한 요약이다. 답 전문을 그대로 보내는 raw `http` 처리기는 쓰지 않는다. 연결 기록의 능력은 `read_status`·`read_events`만 true다. 수신 경로는 플랫폼 작업으로 따로 정한다 |
| (2) 작업 레인 자격 분리 | **파드 실측 먼저.** 작업자 파드에서 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` + bubblewrap 샌드박스가 실제로 도는지 잰다. 이를 위해 `hostUsers: false`, `procMount: Unmasked`, 이미지의 bwrap·socat이 필요하고 플랫폼 PR로 바꾼다. Read 도구와 다른 작업 디렉터리 읽기도 함께 막는다. 실측이 실패하거나 약한 모드만 되면, 작업 레인은 "Console API 키 + 클러스터 LLM gateway"(d)로 바꾸기 전까지 열지 않는다. 다른 UID(c)는 Claude에 자리가 없다. 반사 검사(e)는 보완책으로 유지한다 |
| (3) 대화·작업 레인 분리 | **열 때 파드 둘.** 작업 레인을 열기 전까지는 지금처럼 파드 하나·직렬 1로 둔다. 작업 레인을 열 때 파드를 둘로 나누고, 레인마다 setup-token을 따로 만들어 철회를 분리한다. 직렬 1 조건(D-14 조건 3)을 레인별로 바꾸는 것은 이 결정에 포함된다. 한도는 계정을 함께 쓰므로 합산 사용량을 본다 |
| (4) 작업별 세션 저장 공간 | **α′.** 작업마다 따로 `CLAUDE_CONFIG_DIR`을 두고, 같은 작업의 턴 사이에는 유지하며, 작업이 끝나면 지운다. 같은 작업의 턴은 직렬로 돈다. 자격 되쓰기 문제는 env-static이라 없다. 다른 작업 디렉터리 읽기는 샌드박스 `filesystem.denyRead`와 파일 도구 가두기로 막는다. 리뷰 레인은 대화처럼 실행마다 빈 임시 공간을 쓰고 세션을 남기지 않는다 |
| T17 진입 조건(인증 격리·SEC-02) | **무도구 경계로 갈음.** 리뷰 레인은 도구 0개·MCP·hooks·skills 없음으로 돌아 셸이 없다. 그래서 토큰을 읽을 비신뢰 프로세스가 없다. 리뷰에는 V1_PLAN T17 행의 "인증 파일 격리를 정하고 그 SEC-02 사례가 통과한 뒤" 조건 대신 다음 무도구 경계 시험을 둔다. 가짜 CLI·가짜 자격으로 모델 호출 전에 보인다. (a) 실행 중 도구 호출이 보이면 즉시 중단 (b) MCP·hooks·skills 0개 (c) 출력 반사 검사 (d) 작업자 egress 제한 (e) 실행별 임시 공간 삭제와 실패 시 차단. T18 작업 레인에는 원래 조건(위 (2))이 그대로 걸린다 |

### (2) 파드 실측 결과와 대가 수용 (사용자 2026-11-04)

위 (2)의 "파드 실측 먼저"를 2026-11-04 운영 NUC에서 쟀다. 근거는 [VERIFICATION](VERIFICATION.md) "T18 작업 레인 격리 파드 실측"이다.

- **결과.** 기본 보안 설정(RuntimeDefault seccomp + containerd 기본 AppArmor)에서는 bwrap이 돌지 않는다. 전용 Localhost seccomp·AppArmor 프로필로는 약한 모드(`enableWeakerNestedSandbox`) 없이 돈다. 진짜 토큰 시험에서 샌드박스 Bash의 env·`/proc/*/environ` 토큰 0건, 자격 파일 가려짐, 중첩 userns 거부가 나왔다. 대조군에서는 `/proc`로 1건이 보였다. 그래서 (2)의 "실측이 실패하거나 약한 모드만 되면 (d)" 조건에 걸리지 않는다. 작업 레인은 (d)로 바꾸지 않고 아래 조합으로 연다(운영 반영 뒤).
- **고른 과정.** 기본 설정이 실패한 뒤 세 길을 비교했다: (가) 파드 seccomp·AppArmor를 둘 다 Unconfined로 연다, (나) 전용 Localhost 프로필, (다) (d)로 전환. 독립 리뷰(Codex)는 (다)를 추천했다. 단일 노드의 호스트 공격면과 (나)의 검증·유지 비용이 이유였다. 사용자는 리뷰를 본 뒤 (나)를 골랐고(2026-11-04), 실측이 통과한 뒤 아래 대가를 받아들였다(2026-11-04). (가)는 쓰지 않는다.
- **작업 레인 조합.**
  - 파드: `hostUsers: false`. worker 컨테이너만 `procMount: Unmasked`, `seccompProfile`·`appArmorProfile`은 `Localhost`. init 방화벽은 RuntimeDefault다. uid 10001·capability 없음·`no_new_privs`·읽기 전용 루트는 지금 그대로다.
  - 호스트: containerd 기본에서 만든 전용 seccomp(+ `clone`·`unshare`·`mount`·`umount2`·`pivot_root`·`sethostname`)·AppArmor(bwrap 0.12.0이 하는 mount만, 겹친 라벨 peer 규칙, `max_user_namespaces` 쓰기 예외)를 사람이 설치한다(homelab `host/`).
  - 이미지: `bubblewrap`(`/usr/bin/bwrap`)·`socat`을 Debian 패키지로 넣고 버전을 고정한다.
  - 실행: `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, `--settings`로 `sandbox.enabled`·`failIfUnavailable: true`·`allowUnsandboxedCommands: false`·`network.allowAllUnixSockets: true`·`filesystem.denyRead`(자격 디렉터리, 다른 작업의 세션), `permissions.deny`의 `Read(//<자격 디렉터리>/**)`, `--allowedTools` 명시.
  - 설정 출처: 저장소 스냅샷의 설정·hook·MCP를 읽지 않는다. hook·로컬 MCP는 샌드박스 밖에서 같은 uid로 돌아 scrub·`denyRead`·`--allowedTools`가 막지 못하고 자격 파일을 읽을 수 있다. 작업마다 빈 전용 `CLAUDE_CONFIG_DIR`, `--setting-sources user`, `--safe-mode`, `--strict-mcp-config`(빈 MCP 설정), `--disable-slash-commands`를 강제한다(대화·리뷰 레인과 같은 방식). 악성 `.claude/settings.json` hook·`.mcp.json`·CLAUDE.md를 넣은 스냅샷으로 hook이 돌지 않고 결과에 자격이 없음을 회귀 시험하고, 이 플래그들 아래에서도 `--settings`의 샌드박스 설정이 걸리는지 확인한다.
- **받아들인 대가(사용자 2026-11-04).**
  - **유닉스 소켓 차단 없음.** Claude의 소켓 차단 도우미(`apply-seccomp`)가 Ubuntu의 `unpriv_bwrap` 제한과 충돌해 `allowAllUnixSockets: true`로 끈다. 샌드박스 안 명령이 파일 경로로 보이는 유닉스 소켓에 연결할 수 있다. 지금 파드에는 Claude 자신의 중계 소켓 말고 소켓 서비스가 없다. 이미지나 파드에 소켓을 여는 것을 더하면 다시 본다.
  - **Ubuntu 프로필 의존.** bwrap이 namespace를 만들 수 있는 것은 호스트 Ubuntu의 `bwrap` 프로필이 `/usr/bin/bwrap`에 경로로 붙어서다. bwrap 경로를 바꾸거나 호스트에서 그 프로필이 빠지면 다시 잰다.
  - **호스트 프로필 유지.** 전용 프로필은 containerd 기본의 복사본이라 upstream 수정이 저절로 들어오지 않는다. k3s·containerd·Ubuntu·bubblewrap·Claude CLI를 올릴 때마다 다시 생성하고 실측한다.
- **남은 일.** 운영 반영(호스트 → 이미지 → 작업 레인 설정 → 작업 레인 파드)과, 운영 작업 레인에서 같은 조합으로 SEC-02 작업 레인 사례를 다시 확인하는 것.

### T18 할 일 6 정리 방식 (사용자 2026-11-05)

작업 레인에서 프로세스 소멸을 무엇으로 확인할지 정했다. 티켓의 cgroup 요구를 이 방식으로 바꾼 것은 사용자 결정이다. 근거는 [VERIFICATION](VERIFICATION.md) "T18 할 일 6·작업 레인 실행 부품"이다.

- **실측 요약(무모델 시험 파드).**
  - 파드 안 cgroup 위임은 불가능했다. `/sys/fs/cgroup`이 읽기 전용이고 소유자가 65534다.
  - 작업을 바깥 bwrap PID namespace로 감싸면 그 안에서 Claude 샌드박스 bwrap이 namespace를 못 만들어 쓸 수 없다. 샌드박스 안에서 `unshare`·중첩 bwrap도 거부됐다.
  - Claude 샌드박스 모양의 bwrap 안에 둔 회피 자식(`setsid`·double fork·`env -i`·TERM 무시·`nohup`)은 그 bwrap이 죽으면 die-with-parent로 모두 끝났다. 샌드박스 밖에 남은 `setsid` 도우미는 파드 PID 공간 전체를 훑어 끝냈다.
- **채택.** 작업 전용 파드(`worker-task`, 직렬 1)에서 작업이 끝나면 작업자 자신과 init을 뺀 파드 PID 공간의 모든 프로세스를 TERM 유예 뒤 KILL하고, 기준 상태(같은 namespace 기준 밖 0, 다른 PID namespace 0)로 돌아온 것을 확인한 뒤에만 `stopped:true`다. 확인 실패·권한 오류·시간 초과는 `stopped:false`(unknown)이고 새 접수를 닫는다.
- **구현 선택(사용자 결정 아님).**
  - 신호는 번호별이 아니라 `kill(-1)`로 보낸다. 커널이 한 번에 처리해 fork와 경쟁하지 않고 PID 재사용 위험이 없다.
  - 검사가 깨끗해 보여도 TERM·KILL을 한 번씩은 보낸다. `/proc` 검사는 원자적이지 않아 fork와 exit를 빠르게 되풀이하는 프로세스는 목록에 잡혀도 읽을 때 없어 깨끗하게 보인다. 로컬 시험에서 실제로 그렇게 보였다. 같은 이유로 검사 중 사라진 항목이 계속 나오면 0이 아니라 확인 불가다.
  - 확인은 `/proc/<pid>/status`의 `State`·`NSpid`로 한다. `environ`·`ns/pid`와 달리 ptrace 검사가 없어 non-dumpable 프로세스도 읽힌다.
- **켜는 조건.** `PodPidSpace.record({ dedicatedTaskPod: true })`로만 켠다. 기록 때 기준 밖 프로세스가 하나라도 보이면 거부한다. 개발 기계나 대화·리뷰 파드에서 잘못 켜도 `kill(-1)`이 나가지 않는다. 대화·리뷰 레인의 정리는 그대로 프로세스 그룹과 표식이다.
- **남는 위험.**
  - **전제가 깨지면 방식도 깨진다.** 파드가 작업 전용이고 직렬 1이어야 한다. 같은 PID 공간에 다른 일이 돌면 함께 죽는다(`kubectl exec` 세션, exec probe, 작업자의 다른 자식 포함). 그래서 차트는 exec probe를 쓰지 않아야 하고, 기동 때 기록 시점에 다른 프로세스가 있으면 기동이 실패한다.
  - **좀비 누적.** 작업자(Node)가 PID 1이면 고아 좀비를 회수하지 않는다(로컬 실측). 좀비는 코드가 돌지 않아 소멸 확인에서 세지 않지만 파드 재시작까지 PID를 차지한다. 악성 작업이 fork를 되풀이하면 PID 상한까지 채워 다음 턴이 뜨지 못할 수 있다. 격리 경계가 아니라 가용성 위험이고 파드 재시작으로 풀린다.
  - **운영 조합 미확인.** `kill(-1)`과 `NSpid` 판독은 로컬 PID namespace에서 시험했다. 운영 파드의 AppArmor peer 규칙 아래에서 같은지는 작업 레인 파드 배포 뒤 무모델 시험으로 확인한다. 신호가 막히면 프로세스가 검사에 남아 unknown으로 닫히는 쪽으로 틀린다.

### 작업 레인 unknown과 비상 중지 (사용자 2026-11-05)

작업 레인의 unknown·정리 실패는 작업 레인만 닫는다. 작업 파드 하나의 불확실성 때문에 대화까지 멈춘 채로 두지 않기 위해서다. 비상 중지 해제(`/resume-model target:emergency-stop`)는 interactive 레인의 unknown만 막고, task 레인의 unknown은 `execution_lanes.closed_reason`으로 닫힘이 기록돼 있으면 막지 않는다. 풀린 뒤에도 그 레인은 닫혀 있어 소멸을 확인(`/task-release`)하기 전에는 새 작업을 받지 않고, 응답·감사·Discord 안내에 이 사실을 드러낸다. 실행 중·중지 요청 중인 job과 interactive unknown의 거부, 작업 루프를 켜지 않은 배치의 task unknown 거부는 그대로다. 세부는 [ARCHITECTURE](ARCHITECTURE.md) "T18 게시 서버 스케줄링과 질문"이다.

### R08 수신 경로: tailnet 전용 (사용자 2026-11-06)

A안 읽기 전용 알림은 그대로 두고 수신 경로만 정했다. 근거는 독립 리뷰(후보 ① 공개+서명, ② tailnet 전용+서명, ③ 공개+Access+서명, ④ Discord webhook 경유)다.

- **결정.** 사람 helper → `https://<일반 서비스명>.<tailnet>.ts.net/external-task-events` → 전용 Tailscale operator 프록시(태그 `tag:k8s-r08` 하나) → 전용 ClusterIP Service → 게시 서버의 R08 전용 리스너(8082). 인터넷 공개 경로, Cloudflare WAF 변경, Funnel, NodePort, NUC 443 개방은 없다. 연결별 Ed25519 서명과 읽기 능력 둘(`read_status`·`read_events`)은 그대로다.
- **이유.**
  - 발신자가 명시적으로 연결한 개인 기기뿐이라 공개 웹 애플리케이션이 필요한 요구가 아니다.
  - 익명 요청이 봇의 서명 검증·DB 조회까지 닿는 길을 늘리지 않는다. 기존 공개 경계(`/github` WAF)를 넓히지 않아도 된다.
  - 기존 Tailscale operator를 다시 쓴다. D-11(NUC → 사람 없음)도 그대로다. 사람이 먼저 보내는 요청의 응답이라 역방향 허용이 필요 없다.
- **남는 위험.**
  - **모든 발신 기기에 Tailscale이 필요하다.** 로그아웃·다른 VPN 충돌·회사 기기의 설치 제한이면 알림이 늦거나 나가지 않는다. Tailscale을 쓸 수 없는 기기가 필수가 되면 ③으로 다시 판단한다.
  - **NUC·집 인터넷·PostgreSQL·Discord가 단일 장애점이다.** 경로를 어떻게 골라도 없어지지 않는다. helper의 로컬 큐(24시간·100건·1 MiB)가 메울 수 있는 만큼만 메운다.
  - 허용된 기기가 침해되면 그 기기의 연결로 허위 알림이나 부하를 만들 수 있다. 서명은 이것을 막지 않는다. 네트워크 경로도 NUC 자체 침해를 막는 경계가 아니다.
  - 전용 리스너는 경로 노출을 나눌 뿐 프로세스 자원을 나누지 않는다. R08 수신 상한(ARCHITECTURE §15)이 다른 처리를 굶기지 않게 막는 전부다.
- **구현 선택(사용자 결정 아님).** 명령 이름은 `/attach`·`/detach`·`/attach-list`다. 재발급 명령은 두지 않고 해제 뒤 다시 연결한다. 연결 ID가 바뀌지만 명령과 helper 설정 변경이 하나로 끝난다. 요약 동의도 연결할 때만 정한다.

## T20 기억·삭제 원장·브리핑 (로컬·mock, 2026-10-29)

**상태:** 삭제 원장 위치는 정함(아래, 사용자 2026-11-02). 나머지는 T20 구현 선택이고 사용자 결정이 아니다. 코드는 `src/memory.ts`, `src/deletion-ledger.ts`, `src/ledger-lock.ts`, `src/briefing.ts`, `migrations/010_memory_briefing.sql`·`012_deletion_ledger_generation.sql`, 시험은 `test/memory-briefing.test.ts`, `test/deletion-ledger.test.ts`, `test/deletion-ledger-pg.test.ts`다. 실제 SSD·Discord는 쓰지 않았다.

### 정함: 삭제 원장은 NUC 두 번째 NVMe SSD의 파일 (R17, DATA-02, 사용자 2026-11-02)

ARCHITECTURE §7은 삭제 표식을 봇 DB 복원으로 되돌아가지 않는 곳에 두라고 한다. 사용자는 R2·별도 DB 대신 NUC의 두 번째 NVMe SSD(라벨 `bulk-ssd`, ext4, 호스트 `/mnt/bulk`)를 골랐다. 이전의 R2 추천(옛 후보 A)과 "결정 대기"는 이 결정으로 대체한다. homelab 계획 D-12("새 구조에서 쓰지 않음")의 변경이다.

- **받아들인 위험:** NUC 본체와 SSD를 함께 잃으면 R2의 DB 백업만 돌아와 지운 기억이 되살아날 수 있다. **받아들이지 않은 것:** 평상시의 미마운트·파일 유실·잘못된 볼륨을 조용히 빈 원장으로 받는 것. 기본은 멈춤·경보다.
- **원장 계약 v1:** 호스트 `/mnt/bulk/homelab-bot/deletion-ledger`(65532:65532, 0750)를 PVC `deletion-ledger`로 게시 서버 컨테이너 `/var/lib/homelab-bot/ledger`에만 붙인다(작업자·migration Job에는 붙이지 않음). 원장은 `deletions.jsonl`(0600, JSONL `{memoryId, createdAt, deletedAt}` 그대로), 초기화 표식은 `ledger.json`(0600, 정확히 한 줄 + 개행 `{"format":"homelab-bot-deletion-ledger","version":1,"generation":"<uuid v4 소문자>","initializedAt":"<YYYY-MM-DDTHH:MM:SSZ>"}`)이다. 두 파일은 사람이 `sudo host/install.sh`로만 만든다. 봇은 어떤 파일도 만들지 않는다. 원장 PVC를 붙인 파드는 fsGroup 없이 뜬다(local 볼륨에 fsGroup을 주면 kubelet이 파일 0660·디렉터리 2770으로 넓혀 이 권한 계약이 깨진다).
- **열기 검사(`FileDeletionLedger.open`):** 잠금 → 디렉터리·표식·원장 파일 검증 → 세대 묶기 순서다. 디렉터리는 실제 디렉터리, 두 파일은 일반 파일(심링크는 `O_NOFOLLOW`로 거부), 소유 uid는 프로세스 uid, group·other 쓰기 없음. 표식은 위 바이트 모양 그대로여야 한다(키 순서·공백·날짜 왕복까지). 어긋나면 이유 코드가 있는 `LedgerError`로 실패하고 기억 기능은 닫힌다. 예전처럼 파일·부모 경로가 없을 때 빈 원장으로 열지 않는다(`O_CREAT` 없음).
- **단일 작성자:** 배포 `Recreate`(배포마다 수십 초 끊김, 사용자 수용)에 더해, 봇은 PostgreSQL 세션 advisory lock(`pg_try_advisory_lock`, 고정 bigint 키, DB 단위)을 전용 연결 하나로 프로세스 수명 동안 잡는다. 못 잡으면 열지 않는다. 잠금 연결의 error·end에서 즉시 `fenced`가 되고 이후 append·재적용 확인·읽기가 실패한다. append 직전에도 그 연결로 왕복 확인한다. 확인과 write 사이에 끊기는 틈은 남고, 그 틈에 새 작성자가 들어오는 일은 Recreate로 줄인다. `close()`는 줄 선 쓰기를 마친 뒤 파일을 닫고 잠금을 놓는다.
- **세대 묶기:** migration 012의 한 행 표 `deletion_ledger_generation`에 표식의 generation을 묶는다. 첫 open이 묶고(감사 `memory_ledger_generation_bound`), 다르면(SSD 교체·재초기화·다른 디스크) 열지 않는다. 운영자가 그 세대를 명시(env `MEMORY_LEDGER_ACCEPT_GENERATION`)할 때만 바꾸고 감사(`memory_ledger_generation_accepted`, from·to)를 남긴다. 수용 입력이 표식과 다르면 거부한다. 묶음 행이 없는 DB 백업으로 복원하면 다음 open이 현재 표식으로 다시 묶는다(같은 SSD면 정상).
- **보존:** 자동 삭제·rotation 없음. 보존 기간은 미정이고 백업 보존(14일)보다 짧으면 안 된다.

### 구현 선택 (재검토 조건: T16b 실측)

- **기억 ID:** UUID(`randomUUID`)로 재사용하지 않는다. 원장 재적용은 ID와 `created_at`이 둘 다 맞을 때만 지운다(복원으로 ID가 되감긴 경우 보호).
- **삭제 순서와 부분 실패(ARCHITECTURE §7 제안 채택):** 삭제 요청을 DB에 기록하고 바로 조회에서 숨긴다 → 원장 append 확인 → DB 정리 → 완료 응답. 원장 쓰기가 실패하거나 결과를 모르면 원장을 다시 읽어 판단하고, 기록을 확인하지 못하면 "아직 삭제하지 않음"으로 답하고 숨긴 채 재시도한다(`resume`). 원장 기록 뒤 DB 정리가 실패하면 완료라 하지 않고, 프로세스 안 원장 사본과 DB 요청 행으로 숨긴 채 재시도·재기동 재적용으로 정리한다. 원장 append 결과를 모를 때 재시도하면 같은 항목이 두 번 들어갈 수 있고, 재적용은 멱등이라 받아들인다.
- **기동 순서:** 원장 전체를 다시 적용한 뒤에만 기억 조회·저장을 연다. 원장을 읽지 못하면 닫힌 채로 두고, 브리핑의 기억 칸은 "미확인"으로 보낸다. 원장을 읽었지만 내구성(`durable()`)을 확인하지 못하면 그 항목의 기억은 숨기고 그 기억이 든 대기 브리핑 사본의 발송만 막으며, 기억·사본 본문을 지우거나 완료로 올리지 않는다. 확인과 정리는 `resume()`이 다시 시도하고, 정리에 성공한 항목만 재시도 목록에서 뺀다(복원으로 삭제 요청 행이 없으면 이 목록이 유일한 근거다). 원장을 아예 읽지 못해 `open()`이 실패하면 기억이 든 대기 사본을 모두 막는다. 삭제 재요청도 원장에서 보기만 한 항목이면 다시 써서 확인한다. 복원된 DB에는 지운 기억이 든 대기 브리핑이 있을 수 있으므로 게시자와 브리핑 tick은 원장 재적용 뒤에 시작해야 한다. 지난 회차의 대기 브리핑은 tick이 정리하므로 게시자는 첫 tick 뒤에 시작해야 하고, 원장 기록 재시도(`resume`)는 주기적으로 불러야 한다. 진입점(`src/main.ts`)이 이 순서를 장벽으로 강제한다(T20 2단계, 아래 "진입점 기동 장벽").
- **진입점 기동 장벽(T20 2단계, 2026-11-02):** env `MEMORY_LEDGER_DIR`이 있을 때만 원장(`FileDeletionLedger`, 풀과 다른 전용 연결의 advisory lock)·`MemoryService`·`BriefingScheduler`를 만든다. 없으면 T20 전과 같다(원장·기억·브리핑 없음, 게시자 바로 시작). 첫 READY에서 원장 열기·재적용(`memory.open()`) → 예약 반영(`ensure()`) → 첫 `tick()`이 끝난 뒤에만 게시자(reconcile·deliver 모두)를 연다. 대화 수신·복구 장벽·runtime claim은 이 장벽을 기다리지 않는다(그동안 나온 답은 outbox에 쌓였다가 나간다). `memory.open()`이 원장 오류(`LedgerError`)로 실패하면 그것은 기억이 든 대기 사본 차단이 성공한 뒤라 기억만 닫고 진행한다. 그 밖의 오류(차단 transaction·재적용 DB 오류)와 `ensure()`·첫 tick의 throw(교착 포함)는 무엇이 막혔는지 모르므로 게시자를 열지 않고 그 단계부터 다시 시도한다(1초부터 30초까지 늘림). 문서 출처 확인기는 아래 "문서 출처 확인기"다(T20 B4). 관측 원본은 빈 배열이다(T20 B5).
- **주기 루프와 재열기(T20 2단계):** 장벽 뒤 브리핑 `tick()` 30초, `memory.resume()` 60초(기억이 열렸을 때만). 원장을 못 연 채 기동했으면 60초마다 `memory.open()`을 다시 부른다(SSD·PVC·잠금이 나중에 준비되는 경우, 예: `missing`·`lock_held`·`lock_unavailable`). 한 번 연 뒤 쓰는 중에 `failed`·`fenced`가 되면 다시 열지 않는다. 재기동이 잠금·파일 동일성·세대를 처음부터 다시 확인해야 하고, 원장도 그 인스턴스의 재열기를 거부한다. 열기 중에 잠금을 잃은 `fenced`도 다시 열지 않는다. 세대 불일치·표식 버전처럼 재기동해야 풀리는 열기 실패도 주기마다 다시 시도하지만(무해, 매번 차단 transaction 한 번) 열리지 않는다. 종료(`stop()`)는 루프를 멈춰 새 tick·resume·재열기를 막고, 진행 중 바퀴를 전체 종료 기한 안에서 기다린 뒤 `ledger.close()`로 줄 선 원장 쓰기를 마치고 잠금을 놓는다. 기한을 넘기면 기다리지 않는다(프로세스가 끝나면 잠금 연결이 닫혀 PostgreSQL이 잠금을 푼다).
- **readiness를 원장에 묶지 않음(T20 2단계):** 원장 상태(`closed`·`failed`·`fenced` 등)는 `/readyz`에 반영하지 않는다. Ready가 떨어지면 Service에서 빠져 경보 수신(8081)과 GitHub webhook까지 끊기는데, 원장 장애는 기억·브리핑 경로만 닫으면 충분하다. 대신 지표 `homelab_bot_deletion_ledger_state{state}`(closed·ready·degraded·failed·fenced·disabled one-hot), `homelab_bot_memory_deletions_pending`, `homelab_bot_memory_deletion_pending_oldest_seconds`, `homelab_bot_briefing_enabled`로 알리고 경보는 플랫폼(T20 H3)이 건다. 삭제 대기 두 지표는 DB의 정리 안 끝난 삭제 요청(`memory_deletions.applied_at IS NULL`)이고, 복원으로 요청 행이 사라진 원장 재적용 대기는 세지 않는다.
- **설정 env(T20 2단계):** `MEMORY_LEDGER_DIR`(없으면 끔, 있으면 `/var/lib/homelab-bot/` 아래 정규화된 절대 경로), `MEMORY_LEDGER_ACCEPT_GENERATION`(선택, uuid v4 소문자), `BRIEFING_TIME`(`HH:MM`)·`BRIEFING_TIMEZONE`(IANA). 브리핑 두 값은 둘 다 있거나 둘 다 없어야 하고, 브리핑·세대 수용 키는 `MEMORY_LEDGER_DIR` 없이 줄 수 없다(원장 없이 켠 설정을 조용히 끔으로 받지 않음). 빈 값도 형식 오류다. 오류에는 키 이름과 사유만 남긴다. 브리핑 env가 없으면 `ensure()`가 예약을 끄고 남은 사본을 막는다.
- **기억 명령 모양(T20 2단계 B4, 2026-11-02):** 최상위 명령 다섯 개 `memory-save`·`memory-search`·`memory-correct`·`memory-exclude`·`memory-delete`(lead 2026-11-02). 수신·프로토콜이 문자열 옵션 `text`·`target`만 다뤄 하위 명령 대신 하이픈 이름을 쓰고, 종류별 값은 `text` 안에 `진술 | 키=값 | …`로 받는다(진술에는 `|`를 못 쓴다). `memory-save`는 `target`=종류(configuration·decision·incident·preference), 키는 공통 `topic`·`service`·`recheck`·`expires`·`doc`(최대 3개)·`briefing=yes|no`(yes면 `safe_summary`라 브리핑 재확인 칸에 들어감)에 종류별로 설정 `observed`, 결정 `applies`(필수)·`by`·`decided`, 장애 `fact`·`hypothesis`·`cause`(반복), 선호 `expires`·`end`(둘 다 필수)다. 설정은 `recheck`나 `expires`가 필수다. 시각은 `30d`·`12h`·`2w`(지금부터, 관측·결정 시각은 지금 이전) 또는 오프셋 있는 ISO(`2026-12-31T09:00+09:00`)만 받는다(날짜만은 시간대를 짐작해야 해 받지 않는다). `memory-correct`는 `target`=바꿀 ID(쉼표, 최대 5), `text`에 `kind=`·`reason=`이 필수다. `memory-exclude`는 `target`=출처 키 또는 `here`(이 채널·스레드). `memory-delete`는 `target`=ID 하나. 출처는 늘 이 명령의 상호작용 이벤트(대화)이고 문서 링크를 더할 수 있다. 결정자는 기본이 명령을 쓴 owner라 owner 결정·선호는 대화만으로 active, 설정·장애는 확인된 문서(또는 작업)가 있어야 active다. 오류 응답은 이유와 서식만 말하고 입력값을 되풀이하지 않는다.
- **기억 명령 처리(T20 2단계 B4):** 원장이 켜졌을 때(`MEMORY_LEDGER_DIR`)만 등록 목록과 수신 목록에 넣는다. 원장을 끄고 재기동하면 등록 PUT이 목록에서 뺀다. 수신은 기존 검사(owner, 허용 채널·서버, 스레드 소유자)를 그대로 거치고, 제어 명령처럼 알림 채널에서도 받는다(기억 접근 채널이 대화·알림 둘이다). 구독·gap·작업 큐를 거치지 않고 받은 자리에서 처리하며, 모델을 부르지 않는다. 같은 상호작용은 `events`의 `accepted`를 `FOR UPDATE`로 먼저 잡은 쪽만 처리한다(잡은 뒤 죽으면 다시 하지 않음, 응답 토큰이 3초라 되살릴 수 없다). **진술·검색어는 `events`에 넣지 않는다.** `events`는 대화 맥락으로 모델에 들어가고(`chat-context.ts`) 기억 삭제가 지우지 못하기 때문이다. `target`(종류·ID·출처 키)과 명령 이름만 남는다. 응답은 기존 상호작용 응답(type 4, ephemeral flags 64, 멘션 없음)으로만 보내고 outbox로 채널에 게시하지 않는다. 응답을 못 보내면 기존 `ack_uncertain` 감사와 함께 내용 없는 고정 안내만 채널에 남긴다. 원장이 `closed`·`failed`·`fenced`이거나 기억이 아직 열리지 않았거나(`MemoryNotReady`) 종료 중이면 "지금 기억을 쓸 수 없음"으로 답한다(`degraded`는 받는다, 그때 삭제는 pending). 로그는 명령 이름과 결과 코드(`ok`·거부 사유)만 남긴다. 삭제 응답은 `deleted`/`pending`을 나누고 서비스 문구(백업 최대 14일)에 "이미 Discord에 게시된 사본(브리핑·이 명령들의 응답)은 지우지 않는다"를 붙인다.
- **문서 출처 확인기(T20 2단계 B4):** 공개 저장소 `ukyi-app/homelab`·`ukyi-app/homelab-bot`의 GitHub blob 링크만 본다. 커밋 고정 링크(40자 SHA)는 `https://raw.githubusercontent.com/<저장소>/<SHA>/<경로>`를 `GET`(리다이렉트 거부, 1초 제한, 본문은 읽지 않음)해 200이면 `verified`, 404면 `inaccessible`(저장 거부), 그 밖의 응답·시간 초과는 `unverified`(근거로 세지 않음)다. 브랜치 링크는 내용이 바뀌므로 요청 없이 `unverified`, 허용 저장소 밖·모양이 다른 링크·`..`·퍼센트 인코딩·질의 문자열이 든 경로는 요청 없이 `inaccessible`이다. 이유: 게시 서버는 공유 차트 NetworkPolicy로 이미 인터넷 TCP 443(IPv4, 사설·tailnet 대역 제외)에 나가므로 새 egress·토큰·플랫폼 권한이 필요 없다. 저장소가 공개라 actor별 권한 차이가 없고(기억 명령은 owner만 씀), SHA 고정이라 같은 링크의 내용이 바뀌지 않는다. `verified`는 그 커밋에 그 파일이 있다는 뜻이지 진술이 맞다는 뜻이 아니다(EVIDENCE 규칙 그대로). 비공개 저장소·다른 문서 저장소·한글 경로는 받지 않는다(필요하면 범위를 다시 정한다).
- **파일 원장(T20 계약 v1로 바꿈, 2026-11-02):** 프로세스 사이는 advisory lock, 프로세스 안은 원장 작업(append·읽기·내구성 확인)을 줄 세운다. 끊긴 append 조각은 다음 append 전에 잘라낸다. 재시작 때는 원장 전체를 엄격히 다시 읽는다(줄바꿈으로 끝난 손상 줄은 오류). 원장 파일과 디렉터리를 열어 둔 채 dev·ino·생성 시각을 기억하고, append·읽기·내구성 확인 전마다 경로와 대조한다. 교체·삭제·재생성이면 쓰지 않고 그 인스턴스를 `failed`로 고정한다(예전에는 디렉터리 fsync 확인 표시가 교체 뒤에도 이어졌다). **파일 fsync 실패는 이제 프로세스 수명 동안 원장을 실패로 고정한다.** 예전에는 그 인스턴스만 기존 내용을 다시 믿지 않고 새 append 성공은 새 기록으로 인정했으며, 새 인스턴스는 표시를 물려받지 않았다. 지금은 같은 파일(dev·ino·생성 시각)에 대해 새 append도, 같은 프로세스의 새 인스턴스도 거부한다. 재기동하면 다시 믿으므로 운영자가 매체를 확인해야 한다(경보는 T20 H3). 디렉터리 fsync 실패는 예전처럼 재시도할 수 있는 `degraded`로 두고 확인될 때까지 `durable()`이 false다. 쓰기·읽기·잘라내기의 ENOSPC·EIO·EROFS·EACCES 등도 `degraded`다. 상태는 `status()`(state: closed·ready·degraded·failed·fenced, 실패 단계 open·read·truncate·append·fsync·dirsync·close·lock·verify·generation, errno 코드, 시각)로 본다. 오류·상태에는 기억 내용과 경로를 넣지 않는다. `has`는 파일과 디렉터리 항목을 모두 fsync로 확인한 뒤에만 true다. 삭제 뒤 append 결과를 모르면 한 번 더 쓰고(중복 항목은 무해), 그래도 실패할 때만 원장을 다시 읽는다.
- **DB의 삭제 표현:** 행은 남기되 진술·출처·범위·세부를 비운 `deleted` 행으로 바꾸고 검색 색인(`memory_terms`)을 지운다. 감사 기록에는 기억 내용을 넣지 않는다. 원본 Discord 메시지(`events`)는 기억 삭제로 지우지 않는다(행의 보존 기간 `retention.event_days`는 미정. 원문 `payload.text`는 T31로 받은 지 7일 뒤 비운다).
- **파생 요약(브리핑):** 브리핑 사본마다 담은 기억을 `briefing_copies`에 남겨, 다시 작성한 회차의 이전 사본도 찾는다. 발송 차단과 본문 가리기를 나눈다. 삭제 요청(원장 기록 전 포함)과 내구성 확인 전 원장 재적용은 발송만 막고, 원장 확인 뒤 정리 때 본문을 가린다. 지운 기억이 들어간 미전송 브리핑은 `blocked`로 막고 로컬 사본을 가린다. 게시자가 잡았지만 발송을 시작하지 않은 행도 막는다(게시자의 발송 표시가 `sending` 상태를 요구한다). 이미 보냈거나 발송을 시작했거나 결과를 모르는 브리핑은 Discord에서 지우지 않고(거짓 약속 금지), 로컬 사본을 가린 뒤 그 건수를 삭제 응답에 적는다. 가린 행은 분류를 `safe_summary` 밖으로 바꿔, 429 등으로 대기열에 돌아오거나 결과 대조를 다시 해도 기존 게시자가 거부한다(결과를 모르던 행은 대조 대신 `blocked`가 된다). 브리핑 작성 중에 지우거나 대체한 기억은 큐에 넣는 transaction에서 `FOR SHARE`로 다시 확인해 빼고 다시 작성한다. 큐에 넣은 뒤의 정정·저장 제외·삭제도 같은 transaction에서 반영한다. 한 쪽도 발송을 시작하지 않은 회차는 막고 새 revision 멱등 키(`…:r<n>`)로 다시 작성하며, 막은 이전 사본은 가린다.
- **근거와 상태:** 출처가 없으면 거부, 원본에 접근할 수 없으면 거부, 저장 제외한 출처·채널이면 거부. 종류별로 근거로 인정하는 확인된 출처가 있을 때만 `active`다(설정: 문서·성공 작업, 결정: owner 대화·문서, 장애: 성공 작업·문서, 선호: 대상 사용자 대화). PR 댓글·로그 같은 비신뢰 자료(`external`)는 근거로 세지 않는다. 같은 주제에 다른 진술이 살아 있으면 새 기억은 `candidate`, 둘 다 충돌 표시다. 같은 주제의 동시 저장·정정은 주제별 advisory lock으로 직렬화하고, 정정은 주제 잠금을 행 잠금보다 먼저 잡는다. 저장 제외로 숨긴 기억과 만료된 기억은 충돌 판정·표시에서 뺀다. 정정은 사유가 필요하고 대체된 기억은 `superseded`, 색인에서 빠진다. 기억에는 정책·권한·게시 대상 필드가 없고 어떤 권한 판단에도 쓰이지 않는다.
- **저장 제외:** 제외한 출처·채널은 새 저장을 거부하고, 이미 저장한 기억도 다음 접근부터 검색·브리핑에서 뺀다. 대화 출처와 작업 출처 모두 그 대상 채널과 부모 채널을 제외 키로 갖는다. 010은 아직 배포 전이라 기존 행의 키를 보완하는 이전은 두지 않는다(`briefing_copies` 추가와 `briefing_runs.memory_ids` 제거도 같은 전제다. 옛 010으로 만든 DB를 살려야 하면 backfill이나 재생성이 필요하다). 저장 제외와 브리핑 큐 등록은 owner별 advisory lock으로 줄 세우고, 잠금을 얻은 뒤의 새 문장에서 제외 상태를 확인한다. 정정·삭제 요청은 기억 행 잠금이 브리핑의 `FOR SHARE`와 부딪혀 따로 잡지 않는다. 저장소·백업에서 지우는 것은 삭제다.
- **접근 범위:** owner와 기억의 접근 채널(기본: 만든 대화의 부모 채널)에 더해, 현재 정책의 채널·서비스·guild를 매 접근에 다시 적용한다. 서비스가 정책에서 빠지면 그 서비스 기억은 다음 접근부터 보이지 않는다(삭제는 아님).
- **일일 브리핑:** 모델을 부르지 않고 조립한다. 그래서 모델 한도·인증 대기·비상 중지와 직렬 1 슬롯에 막히지 않고, 중지 상태는 브리핑에 적는다. 시각·시간대는 설정값(08:50, Asia/Seoul)이고 비었거나 잘못되면 예약을 끈다. 끄기는 한 transaction에서 예약 `enabled=false`, 그 예약의 발송 전 사본(`briefing_copies`에 남은 옛 revision 포함, `pending` 또는 발송을 시작하지 않은 `sending`) `blocked`, 작성 중 회차의 lease 무효화와 회차 `blocked`(`schedule_disabled`)를 함께 한다. 이미 보냈거나 발송을 시작했거나 결과를 모르는 행은 그대로 두고 그 회차를 취소로 바꾸지 않는다. 작성 중 회차의 큐 확정은 같은 transaction에서 예약 행(`FOR SHARE`)을 다시 보고, 끄기와는 예약 행·회차 행 잠금으로 줄 선다. 게시자는 브리핑 사본을 보내기 직전 예약이 켜져 있는지 보고 꺼져 있으면 막는다(발송 중에 끈 뒤 429로 돌아온 행). 다시 켤 때도 남은 발송 전 사본을 막고 다음 회차부터 센다(T20 예약 해제, 2026-11-02, 로컬·PG 범위). 대상은 매 회차 현재 정책의 owner·알림 채널로 다시 정하고(바뀌면 예약 행을 고치고 감사 기록), 작성 때와 큐에 넣기 직전에 다시 인가한다. 작성 중에 대상 설정만 바뀌면 막지 않고 새 대상으로 다시 작성한다. 게시 직전 검사는 기존 게시자가 한다. 회차 키는 현지 날짜이고 `briefing_runs` 기본 키와 outbox 멱등 키로 한 번만 만든다. 중단 동안 지난 회차는 몰아 보내지 않고 누락으로 남겨 최신 한 건에 표시한다. 큐에 넣었지만 발송을 시작하지 않은 지난 회차와 12시간 넘게 못 보낸 회차도 tick 때 막고 누락으로 바꾼다. 예정 시각보다 10분 넘게 늦으면 지연을 표시하고, 12시간 넘게 늦으면 보내지 않고 다음 브리핑에 누락으로 적는다. 작성 lease는 120초, 관측 신선도는 1시간, 관측 원본은 함께 읽고 원본마다 10초 한도다. 한 번의 중단에서 누락 기록은 최대 31회이고 그 이상은 "이상"으로 표시한다. 이 수치는 구현 기본값이다.
- **브리핑 내용의 경계:** "정상"은 신선한 관측이 있을 때만 쓴다. 읽기 실패는 마지막 정상 수집 시각과 "미확인", 백업은 복원 검증을 따로 적는다. 연결된 관측 원본이 없으면 "연결된 조회 없음 · 미확인"이다. 작업 레인 칸은 상태와 건수를 적고, 확인하지 못하면 "0건"이나 "열림"이 아니라 "미확인"으로 적는다(ARCHITECTURE §12 "브리핑 칸").

---

## 결정 반영 자리 (spec §12)

homelab 쪽(spec, 설계, 플랫폼 프롬프트, 티켓)은 homelab `rebuild` 변경으로, 봇 문서는 봇 저장소 PR로 반영한다. 커밋·push·PR은 사람 승인 뒤다.

| 결정 | 봇 문서 자리(`01` §11, `00` §3·§5·§6·§8, `04` §2·§10) | homelab·그 밖 자리 |
|---|---|---|
| D-14 | `01` §3 질문 7·이 단계에서 정할 결정, `01` §6 격리, `00` §3 둘째 "> 참고:"(본문은 C-08 보호), `00` §5 "격리 작업 공간" 행, `00` §8 `platform.isolated_workspace`·`codex.codex_home`·`budgets.max_concurrent_jobs`와 주석 | spec §5.1, §10 7번(남는 위험), §11 모델 행, 설계 C.8 격리 행(작업자 영속 쓰기 공간)·E4b·E9·F, 플랫폼 프롬프트 D-14 자리, T08b·T16b·T17(차단 조건)·T18, 설정 초안 `codex.auth` |
| D-15 | `01` §3 질문 2·아키텍처 선택·이 단계에서 정할 결정, `01` §6 격리, `00` §3 둘째 "> 참고:", `00` §5 "격리 작업 공간"·"webhook 수신 경로"·"Alertmanager 수신자" 행(포트), `00` §8 `project.*_host`·`platform.isolated_workspace`·`budgets.max_concurrent_jobs` | spec §5.1, §10 8번, 설계 C.8 격리 행·봇 자리 Application·E4b·E9, 플랫폼 프롬프트 D-15 자리, T16b "봇 자리 `target` 변경" |
| D-16(하위 결정 포함) | `01` §3 PR 리뷰 선택·이 단계에서 정할 결정, `01` §5 이벤트·신뢰 아래 참고(`author_association`), `04` §2 표 아래 "PR 인젝션"(`author_association` [미검증] 문장이 T15 실측으로 풀림)·§10 D-16 행, `00` §3 첫째 "> 참고:", `00` §5 "GitHub App 구조"·"webhook 수신 경로" 행, `00` §6 아래 "> 참고:", `00` §8 `github.review_identity`·`reviewed_repositories`·`model_call_author_associations` 주석과 새 키 `allowed_bot_author_ids` | spec §5.1, §10 17번, §11 Connector 행, D-26 설치 범위, 설계 C.8 리뷰 App 행(권한에 Issues read 추가 필요, 설계 세부)·webhook 행([미검증] 표시), 플랫폼 프롬프트 D-16 자리, T15(Connector 축소, 완료), T17 |
| D-17 | `01` §3 질문 3·이 단계에서 정할 결정, `00` §3 둘째 "> 참고:", `00` §8 `discord.*` | spec §5.1, T16a·T16b |
| D-24 | `01` §3 이 단계에서 정할 결정, `01` §6 격리, `01` §7 다섯째 항목, `00` §5 "봇 변경 PR 작성 자격" 행, `00` §6 아래 "> 참고:"(본문은 C-08 보호), `00` §8 `github.change_writer_*` 주석(구현 키는 `change.repositories`) | spec §5.1, 설계 C.8 봇 변경 PR 행, 플랫폼 프롬프트 D-24 자리, T19 |
| R08 보류 | `01` §3 질문 4, `01` §11 새 행, `00` §3 둘째 "> 참고:", `00` §8 `codex.adapters_to_verify` 주석(요구·계약 문구는 그대로) | spec §5.1, T18 |
| 범위 조정(안 3) | `01` §0 아래 "실제 티켓 순서와 완료 조건", `01` §3 질문 1(플랫폼 등록은 T16b), `01` §11 새 행, `00` §3 둘째 "> 참고:" | spec §8.1 표·§8.2 그래프(T16을 T16a·T16b로), §10 6번, T16 분할, T17~T22 머리말([V1_PLAN.md](V1_PLAN.md) §5) |
| 모든 결정 | spec §12대로 봇 문서 `00`~`04` 전체를 D-14~D-17·D-24로 다시 검색해 빠진 자리를 찾는다 | 같은 방법으로 플랫폼 프롬프트(`platform/design-prompt.md`)와 설계 C.8·F를 검색한다 |

---

## T17 PR_REVIEW 구현 선택과 결정 대기 (2026-10-29, 로컬·mock)

**상태:** 에이전트의 구현 선택(사용자 결정 아님)과 결정 대기 목록이다. 결정 대기 항목은 결정과 무관한 부분만 구현했고 결정 결과를 지어내지 않았다. 코드는 `src/review.ts`·`src/review-input.ts`·`migrations/008_pr_review.sql`, 시험 결과는 [VERIFICATION.md](VERIFICATION.md) "PR_REVIEW T17".

### 구현 선택 (사용자 결정 아님)

1. **리뷰 작업 저장:** 공유 `jobs`에 `type='review'`, `conversation_id` NULL로 둔다. 대화 레인과 같은 `auth.json` 직렬 1(D-14 조건 3)을 공유 코드 변경 없이 지키려는 것이다. T16a `Store.claim`은 대화 join 때문에 리뷰 작업을 집지 않지만, 실행·`unknown`·`waiting_user` 검사로 리뷰 작업을 슬롯 점유로 본다. 세대 기록은 `pr_reviews`, GitHub 게시는 `review_deliveries`다(Discord outbox와 분리).
2. **리뷰 정책 키:** runtime policy JSON의 `review` 아래에 둔다. 허용 봇 작성자 목록은 `review.allowedBotAuthorIds`(문서의 키 이름 예 `review.allowed_bot_author_ids`와 같은 값, JSON 정책은 T16a 관례대로 camelCase)다. 나머지는 `repositories`(id·fullName·installationId·visibility), `commentCommand`, `reviewDrafts`, `rereviewOnBaseMove`, `comparison`, `reviewSince`, `internalMarkers`, `input`·`publish`·`reconcile` 상한이다. `review`가 없거나 형식이 틀리거나 `comparison`이 `null`이면 리뷰가 비활성이다. 새 요청은 받지 않고, 대기 작업과 미게시 결과는 지우지 않고 다시 켜질 때까지 기다린다(철회로 다루지 않는다). 실제 값은 Infisical runtime policy에만 둔다.
3. **PR 본문(D-16 "빼기·격리 방식은 T17"):** 빼지 않고 `untrusted.pullRequest.body` 자료 블록으로 격리하고 `input.maxBodyChars`로 자른다(잘리면 `body_truncated`). Renovate 본문의 릴리스 노트는 호환성 판단 근거라 버리면 리뷰 가치가 준다. 지시 효력은 리뷰 기준을 고정 지침과 base 리비전 `AGENTS.md`로만 두는 것으로 막는다(SEC-01).
4. **세대 키의 `policy_revision`:** 리뷰 지침 문구, 입력 상한, 비교 기준의 해시(`rp-…`)다. 허용 목록·저장소 같은 권한 값은 세대 키에 넣지 않고 실행·게시 직전에 매번 다시 검사한다. 권한 값을 바꿀 때마다 열린 PR 전체가 다시 리뷰되는 모델 호출 폭주를 피한다.
5. **Draft:** 기본 대기(설정 초안 `review_drafts_by_default: false`). 댓글 명령만 예외다. `converted_to_draft` 이벤트도 같은 규칙으로 처리한다(PR #7 리뷰): `reviewDrafts`가 켜져 있으면 아무것도 정리하지 않고, 꺼져 있으면 댓글 명시 요청 세대를 뺀 대기 작업·미게시 결과만 정리한다.
6. **같은 세대 재요청:** 대기·진행·게시된 세대는 다시 넣지 않는다. 확인된 실패·취소의 댓글 재요청, 그리고 닫힘·draft·옛 이벤트로 밀려나 게시되지 못한 세대가 다시 live가 된 경우만 같은 작업을 되살린다. 세대당 시도는 재시도 한도(3)로 묶고, 게시 키는 시도마다 나눈다. 리뷰 작업은 지금 집을 수 있는 대화·작업에 슬롯을 양보한다(F05).
7. **이벤트 순서:** `pull_request.updated_at`이 기록보다 오래된 이벤트는 `stale_event`로 무시한다. 실행 직전과 게시 직전에 live PR을 다시 읽는다.
8. **게시 대조:** 응답을 잃은 게시는 다시 보내지 않고 marker(`<!-- homelab-bot-review:github-review:<job id>:<시도> -->`)와 검토 SHA로 PR 리뷰 목록을 대조한다. 못 찾으면 `unknown`을 유지하고 `unknown` 진입 24시간 뒤 은퇴한다(T16a Discord 대조와 같은 원칙. 진입 시각은 T16a outbox 관례대로 `available_at`에 둔다. PR #7 리뷰). 게시 전 원격 조회 동안에는 현재 lease token에 한정해 게시 lease를 갱신한다. 422(인라인 위치 무효)는 본문만으로 한 번 더 보낸다. 전송 전 일시 장애(정책 확인 불가, GitHub 5xx·429)는 재시도 횟수를 쓰지 않고 1초~60초 백오프로 기다린다.
9. **공개 범위(DATA-01):** 마스킹이 아니라 게시 차단이다. 내부 표식 실제 값은 runtime policy `review.internalMarkers`에만 둔다. Discord 요약은 알림 채널(D-17)에 코드가 만든 숫자·리비전만 쓰고 모델 문장은 넣지 않는다.
10. **변경 목록:** 게시 서버가 API로 열거한 목록이 기준이고 압축본은 blob 내용에만 쓴다(ARCHITECTURE §6). 열거 실패는 `failed`이고 압축본 비교로 대신하지 않는다. 429·5xx는 Retry-After와 지수 백오프로 기다리다 10회를 넘으면 `failed`다.
11. **게시 직전 재확인(r2·r3):** draft는 게시 직전 live PR로도 본다(댓글 명시 요청만 예외). 이때 게시 행과 세대 기록을 함께 보류로 두어, 뒤에 ready_for_review·재조정·댓글이 오면 다시 이을 수 있게 한다(16번). 게시 상한(지적 수·인라인 수·본문 길이)은 저장된 구조화 결과를 게시 시점 정책으로 다시 렌더링해 적용한다.
12. **이벤트 순서(r2·r3):** admission과 같은 잠금 안에서 PR의 최신 관측 시각(`pr_updated_at`)을 기록한다. 같은 세대의 중복 이벤트(재개·draft 해제 등)에서도 단조 증가시킨다. `closed`·`converted_to_draft`를 포함해 그보다 오래된 이벤트는 `stale_event`로 무시한다. 한계: 판정은 webhook·live PR의 `updated_at`(초 단위)을 믿으므로 같은 초 안의 역순은 가리지 못한다. 남는 창은 실행 직전·게시 직전 live PR 재확인이 막는다.
13. **diff 표현(r2):** 모드(실행 비트)·이름·새 파일·삭제는 git 형식 머리줄로, 파일 끝 개행 추가·삭제는 `\ No newline at end of file`로 전달한다. 변경 목록 계약에 `baseMode`·`headMode`를 두고, 없으면 압축본의 실행 비트를 쓴다. 보이는 차이가 없는 목록 항목은 `archive_mismatch`로 미검토다.
14. **기준 지침 예산(r2):** base `AGENTS.md`도 파일 상한(`input.maxFileBytes`)과 모델 입력 예산(`input.maxDiffBytes`, diff보다 먼저 잡음)을 받는다. 넘으면 자르지 않고 빼고 `guidelines_limit`로 partial 표시한다.
15. **권한 재확인 시점(r2):** GitHub 조회를 마친 뒤 capability 발급 직전에 최신 정책으로 저장소·설치·작성자·입력 정책 revision·리뷰 활성 여부를 다시 본다. 재조정의 실행당 상한은 새 작업과 되살린 작업을 함께 센다.
16. **같은 세대 결과 재사용(r3):** 같은 세대(head·비교 기준·정책 revision이 같음)에 공개 가능한 결과가 이미 있는데 닫힘·draft·게시 직전 상태 변화로 게시만 못 했으면, 재개·ready_for_review·재조정·댓글에서 모델을 다시 부르지 않고 게시 행을 다시 대기시킨다(`resumed`, 재조정 예산에 세지 않음). 본문은 게시 직전 현재 정책으로 다시 렌더링된다. 이미 게시·대기·차단된 세대는 다시 잇지 않는다.
17. **마이그레이션 008의 열 추가(r3):** 008은 아직 배포 전이지만, 앞선 008로 만든 표에도 같은 열이 생기도록 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`를 둔다(`positions`·`inline`·`defer_count`·`pause_count`).

### 결정 대기 (사용자 결정 필요) → 확정(사용자 2026-11-04, 아래 "T17 결정")

| 항목 | 후보 | 근거 | 추천 | 지금 구현 |
|---|---|---|---|---|
| `comparison_revision` 기준(ARCHITECTURE §7 "T17에서 정한다") | (a) PR `base.sha`(base 브랜치 머리) (b) merge base | (a)는 V1_PLAN 흐름 문구와 같고 단순하다. base가 앞서가면 PR이 바꾸지 않은 base 쪽 변경이 역방향 diff로 섞여 오탐이 생길 수 있다 [가정]. (b)는 GitHub "Files changed"와 같은 diff이고, base가 앞서가도 세대가 바뀌지 않아 모델 호출이 준다. 게시 서버가 compare API의 merge base를 고정해야 한다 | (b). 독립 리뷰가 (a)의 실제 결함을 확인했다: GitHub compare API 목록은 merge base 기준이라 (a)의 압축본 diff와 어긋나 뒤처진 PR이 거의 늘 `partial`이 되고, main 쪽 변경이 역방향으로 섞인다. (a)를 고르면 변경 목록을 두 커밋 사이 tree 비교로 따로 만들어야 한다 | 두 방식 모두 구현하고 runtime policy `review.comparison`(`merge_base` 또는 `base_head`)으로 고른다. 값이 `null`이면 리뷰가 비활성(새 요청만 막고 대기 작업은 기다림)이다. `merge_base`면 게시 서버가 merge base를 조회해 세대 키·압축본·실행 직전·게시 직전 재확인에 쓰고, 조회가 실패하면 모델 작업을 만들지 않는다 |
| head는 같고 base만 움직였을 때 다시 리뷰할지(`review.rereviewOnBaseMove`) | 다시 리뷰 / 결과만 `superseded` | 모델 직렬 1(D-14)이라 base 활동이 많은 저장소에서 대기열이 밀린다. 위에서 (b)를 고르면 거의 생기지 않는다 | 결과만 `superseded`, 재리뷰는 댓글 명령으로 | 값이 `null`이면 결과만 `superseded`로 두고 재리뷰를 건너뛰는 조건은 같은 head의 결과가 게시(차단 포함)됐거나, 공개 범위 검사에서 막혔거나, 확인된 실패거나, 같은 head에서 이미 두 번 리뷰한 경우다. 그 밖(아직 리뷰 결과를 한 번도 게시하지 못한 경우)은 한 번 더 리뷰한다. 상한 때문에 끝내 게시하지 못하면 알림 채널에 원문 없는 안내를 남긴다. base 재지정(`edited`)과 댓글 명령은 늘 새 세대 |
| 댓글 리뷰 명령 문법(`review.commentCommand`, D-16 규칙 스케치 "문법은 T17") | 슬래시형 고정 문자열 / `@<리뷰 App>` 멘션형 | 멘션형은 아직 없는 App 이름에 묶이고 수동 `@codex review`와 헷갈린다 | 슬래시형 하나(예 `/homelab-review`) | 값이 `null`이면 댓글 트리거 끔. 앞뒤 공백만 무시하고 정확히 일치할 때만 |
| 게시 상한 값(`review.publish`: 지적 수, 인라인 수, 본문 길이) | `01` §5대로 대표 평가 뒤 | 평가셋은 D-14 차단 조건 뒤다(Claude 구독 프로필에서 해제, 사용자 2026-11-04) | 평가 전 임시값 지적 10·인라인 5·본문 20,000자 [가정] | 값이 `null`이면 자동 게시 거부(`publish_limits_unset`) |
| 입력 상한 값(`review.input`) | 운영 값 | 압축본 크기와 직렬 1 대기 시간 | 파일 200개, 파일 1MB, diff 1MB, 압축본 100MB, 본문 8,000자 [가정] | 정책 필수 값. 없으면 리뷰가 비활성이다 |

### T17 결정 (사용자 2026-11-04)

위 표의 추천안을 그대로 고르고, 시범 P-2의 시험 저장소를 함께 정했다("진행해").

| 항목 | 결정 |
|---|---|
| `comparison_revision` 기준 | `comparison: merge_base`. GitHub "Files changed"와 같은 diff다. 게시 서버가 compare API의 merge base를 고정한다 |
| `review.rereviewOnBaseMove` | `false`: 다시 리뷰하지 않는다. 결과만 `superseded`로 두고, 재리뷰는 댓글 명령으로 한다. 코드의 예외는 그대로 유지한다(`src/review.ts` `admit`). 예외는 두 가지다. 아직 게시하지 못했고 끝나지도 않은 세대는 한 번 더 리뷰하고, base 재지정(`retarget`)과 댓글은 늘 새 세대다. merge base 기준이라 base만 움직였다고 세대가 바뀌는 일은 드물다 |
| `review.commentCommand` | `"/homelab-review"` 하나다. 앞뒤 공백만 무시하고 정확히 일치할 때만 받는다 |
| `review.publish` | 평가 전 임시값으로 `maxFindings` 10, `maxInlineComments` 5, `maxBodyChars` 20,000이다. 대표 평가 뒤 다시 정한다 |
| `review.input` | `maxFiles` 200, `maxFileBytes` 1,000,000, `maxDiffBytes` 1,000,000, `maxArchiveBytes` 100,000,000, `maxBodyChars` 8,000. MB는 10진(1MB = 1,000,000바이트)이다 |
| 시험 저장소(시범 P-2, REVIEW `authorized_external`) | `ukyi-app/homelab-smoke`. T13 시험 앱이라 새 저장소를 만들지 않는다 |

- 값은 런타임 정책(`RUNTIME_POLICIES`, Infisical)의 review 절에 넣는다. 넣는 때는 리뷰 활성화 단계다. 이 문서에는 값의 출처만 둔다.
- 리뷰 App(사람 작업, 2026-11-04 14:05): 사용자가 org `ukyi-app`의 GitHub App `ukyi-review`(App ID 5606407)를 만들었다. 권한은 Pull requests write와 Contents·Metadata·Checks·Issues read이고, 이벤트는 `pull_request`·`issue_comment`다(`gh api apps/ukyi-review`로 확인). 위 "리뷰 App 권한과 구독 이벤트"와 같다. 다음은 사람 작업으로 이어진다: 설치(`homelab-smoke` 하나), 개인 키, Infisical `GITHUB_REVIEW_APP_ID`·`GITHUB_REVIEW_APP_PRIVATE_KEY`, `homelab-smoke`의 Codex 자동 리뷰 끄기.
- 그대로 남은 T17 진입 조건이 있다. 작업별 세션 저장 공간과 인증 파일 분리(T18 결정 (2)·(4))이고, V1_PLAN T17 행 기준이다.

### 공유 파일(T16a 소유) 변경이 필요해 하지 않은 것

- **리뷰 작업의 `waiting_user` 해제(r2에서 해소, lead 허용 2026-10-29):** `Store.control`에 리뷰 전용 명령 `review-status`·`review-resume`·`review-cancel`을 **추가**했다. `DiscordIngress`는 현재 정책의 owner가 알림 채널(부모 없는 채널)에서 보낸 명령일 때만 리뷰 제어를 허용한다. 재개·포기 뒤 전역 scheduler 해제는 기존 `releaseScheduler` 규칙(비상 중지·다른 대기 우선)을 그대로 쓴다. 기존 대화 명령(`resume-model`·`cancel`·`list`·`model-status`)의 뜻·동작은 바꾸지 않았다. 리뷰가 대기에 들어가면 알림 채널에 job ID와 명령을 안내한다. 실제 슬래시 명령 등록은 T16b다. → T16b 배포 진입점은 `review-*`를 등록하지 않고 수신에서도 닫는다(FOUNDATION 범위).
- **webhook 수신 연결:** `src/http.ts` 앱 서버(8080)에 `githubWebhook`을 붙이는 것. 지금은 404 그대로다. → T16b에서 `POST /github`을 리뷰 비활성으로 연결했다(아래 "T16b 결정" D6).
- **작업자 쪽 mutex 공유:** 리뷰 레인 HTTP는 새 파일 `src/review-http.ts`(`/v1/review`, `/v1/review/cancel`)에 두었다. 작업자 쪽 mutex를 대화 레인 `SerialWorker`와 하나로 묶는 것은 `worker.ts` 변경이라 하지 않았다. 지금은 게시 서버의 SQL 슬롯만 두 레인이 공유하고, 작업자 쪽 mutex는 `ReviewWorker`가 따로 가진다. 한 작업자 프로세스에 두 레인을 올릴 때(T16b) 묶어야 한다.

## T16b 결정 (사용자 2026-10-30)

출처: T16b 실행 계획 4절(비공개 작업 문서)의 후보와 추천을 사용자가 골랐다. 반영 위치를 함께 적는다. D5(작업자 파드 안 Codex 샌드박스 실패 시)는 실측 결과에 따른 조건부 결정이라 아직 없다. 같은 날의 모델 실행기 변경(Claude Code CLI·구독 장기 토큰·Opus 5.5·프로필 구조)은 위 [D-14 "변경"](#변경-사용자-2026-10-30-claude-code-cli구독-장기-토큰opus-55실행기-프로필)이다. D4의 "영속 CODEX_HOME 직접 사용"은 Codex 프로필에만 해당하고, Claude 프로필은 실행마다 임시 HOME·CLAUDE_CONFIG_DIR을 쓴다.

| ID | 결정 | 반영 |
|---|---|---|
| D1 런타임 정책 | 정책은 공유 차트가 넣는 env `RUNTIME_POLICIES`(Infisical)를 **기동 때 한 번** 읽는다. 값을 바꾸면 `homelab secret set`이 파드를 다시 시작해 반영한다. 즉시 차단은 `/revoke`(DB 거부 목록). T16a의 "파일 매 접근 재읽기 + `confirmedAt` 300초" 검사는 없애고 `confirmedAt`은 봇이 읽은 시각으로 채운다 | `src/policy.ts`, [ARCHITECTURE](ARCHITECTURE.md) §11, AUTH-02 시험 |
| D2 작업자 이미지 | 작업자는 봇 이미지 하나를 공유한다. sandbox는 사람 PR로 그 digest를 고정하고 command만 작업자 진입점으로 바꾼다 | 작업자 진입점·Dockerfile(T16b S4·S5) |
| D3 작업자 공개 키·nonce | 공개 키는 `platform/sandbox` values(Git)의 env, nonce 저장소는 영속 PVC 안 별도 디렉터리(30초 만료, 재기동 뒤에도 재사용 거부) | 작업자 진입점(T16b S4) |
| D4 대화 레인 세션 | 대화 레인은 영속 CODEX_HOME을 직접 쓰고 세션 기록을 남기지 않는다(`--ephemeral`, 안 되면 실행마다 세션 디렉터리 삭제). 빈 임시 작업 공간 + `--skip-git-repo-check`. 작업·리뷰 레인 배치는 T18 결정으로 남긴다 | 작업자 진입점(T16b S4). 게시 서버는 해당 없음 |
| D6 공개 webhook | 공유 차트 그대로(`public.host`, `/` Prefix)를 받는다. 봇은 `POST /github`에 `githubWebhook`을 **리뷰 비활성**으로 연결해(정책에 리뷰 설정이 있어도) `review_disabled`로 기록하고, 서명이 틀리면 401이다. 8080의 그 밖 경로는 `/readyz`·`/metrics` 말고 404. 비밀 키는 `GITHUB_REVIEW_WEBHOOK_SECRET`(시험 webhook과 T17 리뷰 App이 같은 값). 남는 위험: 클러스터 안에서 Traefik에 공개 host로 오는 요청은 `/readyz`·`/metrics`에 닿는다(WAF 규칙이 밖에서 막음) | `src/main.ts`, `src/http.ts` |
| D7 봇 지표 스크레이프 | `vmsingle/scrape.yaml`에 봇 job, `platform/bot-slot`에 vmsingle → 봇 8080 ingress | 플랫폼 PR(T16b S15) |
| D8 Kubernetes API 경로 | 봇 파드 → Kubernetes API 길은 플랫폼 PR이 연다. 읽기 transport의 K8s 출처는 in-cluster SA 토큰(`/var/run/secrets/kubernetes.io/serviceaccount`)으로 `https://kubernetes.default.svc`를 부른다 | `src/read-transports.ts`, 주소는 env `KUBERNETES_API_URL` |
| D9 Argo CD 앱 상태 경로 | 봇은 Argo CD 앱 상태를 Argo CD API(`argocd-server`, `ARGOCD_URL`·`ARGOCD_READER_TOKEN`)가 아니라 **Kubernetes API의 Application CR**(`GET /apis/argoproj.io/v1alpha1/namespaces/argocd/applications/{이름}`)로 읽는다. 이유: `argocd-server`는 설계상 자체 서명 TLS만 쓰고(사람용 Tailscale 프록시가 https+insecure로 붙는다) 봇이 읽는 것은 앱 객체 하나뿐이다. Kubernetes API는 SA의 클러스터 CA로 TLS를 검증하고, 자격도 SA 하나로 준다. SA `bot-reader`에 `get applications.argoproj.io -n argocd`를 준다(플랫폼, lead 확인). 앱 이름은 카탈로그 고정값만, 경로의 namespace는 `argocd` 고정, 투영은 `status.health`·`status.sync`만(D9 전과 같은 판정·관측 시각). 남는 범위: 이 권한은 `argocd` ns의 모든 Application(spec의 인라인 Helm values 포함)을 읽게 한다. Argo CD `applications, get`도 같은 범위였다. 더 줄이려면 Role에 `resourceNames`(카탈로그 앱 이름)를 둘 수 있으나 새 앱마다 플랫폼 PR이 든다(선택) | `src/read-transports.ts`(`kubernetesTransport`의 datasource `argocd`), `src/catalog.ts` `ARGOCD_APPLICATIONS`, `src/config.ts`·`src/main.ts`(env 2개 제거), [ARCHITECTURE](ARCHITECTURE.md) §5·§11, [VERIFICATION](VERIFICATION.md) "T16b D9" |

## C01 동료 기능 스위치 (2026-11-09)

"동료 봇 전환 (사용자 2026-11-09)" 9의 구현 위치: 런타임 정책 칸 `colleagueEnabled`(`src/policy.ts` `PolicyFields`), 읽는 곳 `PublisherConfig.colleagueEnabled`(`src/config.ts`). 뒤 티켓의 말로 실행하는 기능과 '/' 이름 없는 고정 문구는 이 값만 본다. 시험·결과는 [VERIFICATION](VERIFICATION.md) "C01 동료 기능 스위치".

- **env 키가 아니라 정책 칸:** 명세 §4.9가 "런타임 정책에 둔다, 기존 스위치처럼 기동 때 읽음"으로 정했다. 그래서 차트 env 스위치(`REVIEW_ENABLED`·`CHANGE_PR_ENABLED`)와 달리 Infisical `RUNTIME_POLICIES` 값만 바꾸고 재시작하면 켜진다.
- **참·거짓만:** 문자열 `"true"` 같은 오타가 조용히 꺼짐이 되지 않게 기동 오류로 막는다. 오류에는 필드 경로만 남긴다(기존 `runtime_policies_invalid` 규칙).
- **설정의 선택 칸:** `PublisherConfig`를 직접 만드는 시험이 있어 `colleagueEnabled?: boolean`이고, `loadPublisherConfig`는 늘 참·거짓을 채운다. 없으면 꺼짐으로 읽는다.
- **수명:** 시범이 끝나 '/' 명령을 정리할 때 칸·설정·예시를 같이 없앤다(명세 §4.9).

## 동료 봇 전환 16·17 구현 위치 (C26, 2026-11-09)

"동료 봇 전환 (사용자 2026-11-09)" 16(PR 수정 반복)·17(안내 댓글)의 GitHub 포트 자리다. 결정은 바꾸지 않았다.

- 16 수정 커밋의 fast-forward 갱신: `src/github-writer.ts` `GitHubWriterPort.fastForwardBranch`(자기 변경 브랜치만, `force:false`, 기대 head·부모 확인 뒤 전송). PR의 리뷰·댓글 자료 읽기: `src/github-review-io.ts` `discussion.read`(리뷰 App 읽기 토큰, 허용 경로 `src/github-app.ts` GET 두 줄). 부르는 곳은 C27.
- 17 안내 댓글 게시: `src/github-review-io.ts` `guidance.post`·`guidance.find`(`restrictGitHubWrite`를 지나는 `COMMENT` 리뷰, 안내 표식으로 회수). 부르는 곳은 C29.
- 기록: [ARCHITECTURE](ARCHITECTURE.md) §6 리뷰 행·§16.3, [VERIFICATION](VERIFICATION.md) "C26 GitHub 쓰기·읽기 확장".

## 동료 봇 전환: 작업자 계약 v1·v2 공존 (C02, 2026-11-09)

- 작업자는 대화 요청 v1·v2와 리뷰 지시문 v1·v2 literal을 함께 받는다. 게시 서버는 자동 배포라 작업자(사람 배포, C06)가 먼저 두 판을 받아야 서버가 v2로 바꿀 수 있다(C11·C12). v1 수용은 시범이 끝난 뒤 뺀다(명세 §4.2 "계약 배포 순서" 3단계). 구현과 시험은 [ARCHITECTURE](ARCHITECTURE.md) §13 "봇 답 문맥"·"대화 답 형식", [VERIFICATION](VERIFICATION.md) "C02 작업자 계약 v2".

## C09 고정 문구 1: 대화·작업·제어 (2026-11-10)

"동료 봇 전환 (사용자 2026-11-09)" 4(말투)·9(스위치)의 대화·작업·제어 문구 자리다. 사용자 결정이 아니라 구현 선택이고, 말의 자연스러움은 owner 검토(C24 말투 표본)로 다시 본다. 시험·결과는 [VERIFICATION](VERIFICATION.md) "C09 고정 문구 1".

- **문구 한곳:** `src/chat-task-text.ts` `CHAT_TASK_TEXT`. 항목마다 첫 인자가 스위치 값이고, 분기가 그 값 하나뿐이어야 시험이 모든 항목을 같은 인자로 불러 '/' 이름을 검사할 수 있다. 사유로 문장이 갈리는 곳(한도·인증, 이어 갈 수 있음·없음)은 항목을 나눴다.
- **스위치를 읽는 곳:** `Store.colleague`(생성자 셋째 인자, 기본 `false`). 브리지·`TaskCommands`는 자기 `Store`에서 읽는다. `controlText`·`taskLaneClosedText`는 인자로 받는다(기본 `false`).
- **관리 기능 안내:** 비상 정지 해제, unknown 해제, 모델 상태, 한도·인증 대기 작업 재개의 켜짐 판은 "`homelab bot` CLI로 …"까지만 말하고 하위 명령 이름은 적지 않는다. 이름이 C05에서 정해지고 바뀔 수 있어서다. 대기 작업 재개를 CLI 쪽에 둔 것은 지금 그 경로가 `/resume-model` 하나뿐이고 말로 하는 재개가 없어서다.
- **말로 하는 안내:** 켜짐 판은 "작업 목록을 보여 달라고", "다시 해 달라고", "취소해 달라고", "리뷰를 재개하거나 취소해 달라고"처럼 할 일을 말로 적는다. 대화 모델이 그 말을 제안으로 바꾸는 것은 C11·C13 몫이다. 작업 질문 답은 C16 전까지 질문 ID를 함께 적어 달라고 안내한다.
- **사유 코드 풀기:** owner가 읽는 문장에 괄호로 붙던 `unknown`·`cancelled`·`failed`·`cleanup_pending`·`retention_full`을 뜻으로 바꿨다. `/list`·리뷰 목록·`/task-status`의 상태·대기 사유는 표(`jobStateText`·`waitReasonText`)로 풀고, 표에 없는 코드는 그대로 보인다. DB·감사·로그·멱등 키의 코드는 그대로다. 작업자 접수 닫힘 사유(`intake.reasons`)와 공개 검사 사유는 코드 그대로 싣는다.
- **그대로 둔 것:** `/stop`의 켜짐 판은 "구독을 다시 켜 주세요"로만 적었다. 말로 하는 구독 켜기가 없어서(명세 §4.1) 더 구체적으로 적을 수 없다.

## C05 관리 CLI (2026-11-10)

"동료 봇 전환 (사용자 2026-11-09)" 3의 구현. 봇 `src/admin.ts`(명령 처리)·`src/admin-main.ts`(진입점), homelab `cli/src/commands/bot.ts`와 core `podops.ts`의 `bot` 어댑터. 시험·결과는 [VERIFICATION](VERIFICATION.md) "C05 관리 CLI".

- **권한의 근거는 클러스터 접근:** 진입점은 DATABASE_URL만 읽는다. 정책(`RUNTIME_POLICIES`)·Discord·작업자·모델 자격을 읽지 않아 정책을 읽지 못하는 때에도 비상 정지가 된다. 감사 행위자는 `cli`다(`admin_command` 행, subject는 동작, detail에 `actor`·`result`. 비상 정지 해제는 기존 `model_emergency_released` 행도 subject `cli`로 남는다).
- **`Store.control`을 시그니처 그대로 부른다:** 대화 자리에 실제 대화 ID(`종류:guild:채널`)와 겹치지 않는 `admin:cli`를 넘긴다. 그 대화 행이 없어 owner 대조를 거치지 않는다. `model-status`의 대기 작업 목록은 대화에 묶여 비어 나오므로 상태 보기에서 뺐다(비상 정지·일시 중지·실행 중 여부·작업 레인 닫힘만).
- **재실행 안전:** 비상 정지가 없을 때의 해제는 아무것도 바꾸지 않는다(`not_stopped`). 같은 경우의 `/resume-model target:emergency-stop`은 다른 대기가 없으면 전역 일시 중지도 푼다. 상태 확인과 바꾸기는 한 트랜잭션이다.
- **`kubectl exec`는 쓰기(주 진행자 결정, 2026-11-10):** 상태 보기도 `homelab bot status --apply`에서만 실행하고 plan은 대상 파드와 argv만 보인다. 읽기 허용 exec 종류는 만들지 않았다(homelab 설계 C.7 표).
- **받지 않은 동작(시그니처 불변 규칙):** 차단·unknown 해제·멈춘 작업 재개는 진입점이 미지원(종료 4)으로 답한다. 기존 함수가 Discord owner 행위자와 대화를 요구해 CLI 행위자로 부를 수 없다. 그동안 '/' 예비(`/revoke`·`/task-release`·`/resume-model`)로 한다.
  - 차단: `PolicyGate.revoke(actor, scope, target)`가 먼저 `authorize(actor, scope)`로 actor = 정책 owner와 허용 범위를 요구한다. 필요한 변경: 정책 revision만 읽어(실패 시 닫힘) 같은 거부 행(새 `denial_id`)을 더하는 관리용 메서드. 정책 owner로 대신 부르면 owner가 이미 거부된 뒤의 재실행이 `Denied`로 실패한다.
  - unknown 해제: `ClaudeTaskBridge.release`·`CodexBridge.release(actor, scope, job)`이 `TaskBridge.releasable`에서 `authorize`와 작업 소유·대화 대조(또는 정책 owner의 후계 규칙)를 거친다. 필요한 변경: 작업 ID만으로 같은 소멸 확인을 거쳐 풀고 감사 행위자를 받는 관리용 경로.
  - 멈춘 작업 재개: `Store.control`의 `resume-model <job>`이 `owner_id = actor`, `conversation_id`, 대화 구독 활성을 요구한다. 필요한 변경: 작업 ID만으로 같은 상태·시도 한도 조건을 보고 재개하는 관리용 동작(리뷰 작업은 `review-resume`이 이미 actor를 감사에만 쓴다).

## C32 관리 CLI 나머지 동작 (2026-11-10)

위 "C05 관리 CLI"의 "받지 않은 동작" 셋을 연다(사용자 2026-11-10, C05에서 나눔). 기존 '/' 경로 함수의 시그니처는 그대로 두고 CLI 행위자용 관리 메서드를 더했다. 셋 모두 owner·대화를 대조하지 않는다(권한의 근거는 클러스터 접근). 시험·결과는 [VERIFICATION](VERIFICATION.md) "C32 관리 CLI 나머지 동작".

- **차단 `PolicyGate.deny(target)`(`src/policy.ts`):** 정책은 거부 행의 revision을 적으려고만 읽고, 읽지 못하면 아무것도 더하지 않는다. 거부 행만 더하고 해제 메서드는 없다. 이미 거부돼 있으면 행을 덮어쓰지 않는다(`already_blocked`). `/revoke`처럼 덮어쓰면 `denial_id`가 바뀌어 사람이 `revocationRestores`에 준비해 둔 해제 승인이 듣지 않게 되고, 재실행이 상태를 바꾼다. 예외: 해제 승인이 이미 적힌 옛 거부(다음 인가가 지울 행)는 먼저 지우고 새 거부를 더한다. 그대로 두면 차단했다고 답한 뒤 다음 이벤트에 풀린다. `authorize`의 해제 조건 SQL은 같은 private 메서드(`restoreApproved`)로 옮겨 둘이 함께 쓴다(동작 불변).
- **unknown 해제 `TaskBridge.adminRelease(job, actor)`(`src/claude-task-bridge.ts`·`src/codex.ts`):** 두 브리지의 '/' 해제 본문을 `releaseJob`으로 떼어 '/' 경로(`release`)와 관리 경로가 같은 소멸 확인·해제 CAS를 쓴다. 결과는 `ReleaseOutcome`(`released`·`missing`·`not_unknown`·`foreign`·`worker_alive`·`state_changed`)이고 '/' 경로는 지금과 같은 안내 문구로 바꾼다. 관리 경로는 정책을 읽지 않는다(정책을 못 읽어도 소멸 확인만으로 푼다). 진입점은 브리지를 앞에서부터 묻고 `foreign`이면 다음 브리지로 넘긴다. 게시 서버가 Claude 브리지만 조립하므로 진입점도 Claude 브리지만 만들고, Codex 브리지의 관리 경로는 시험만 있다.
- **멈춘 작업 재개 `Store.adminResumeJob(job, actor)`(`src/store.ts`):** '/resume-model <job>'의 조건 중 owner·대화·구독 활성만 뺐다. 비상 정지 중이면 `emergency_stopped`, 큐가 차면 `queue_full`, 한도·인증 대기가 아니거나 시도 한도면 `not_waiting`이다. 리뷰 작업은 고르지 않는다('/resume-model'도 닿지 않고 리뷰 재개는 따로다).
- **진입점이 읽는 env(`src/admin-main.ts` `adminPorts`):** 비상 정지·해제·상태 보기·멈춘 작업 재개는 그대로 DATABASE_URL만 읽는다. 차단은 `RUNTIME_POLICIES`, unknown 해제는 게시 서버 설정 전체(`loadPublisherConfig`, `taskPrecondition`)를 읽는다. "C05 관리 CLI"의 "진입점은 DATABASE_URL만 읽는다"는 이 두 동작에서 바뀐다. 정책을 못 읽어도 비상 정지가 되는 성질은 남는다.
- **결과 이름과 종료 코드:** `blocked`·`already_blocked`(0), `released`(0), 소멸 미확인·확인 사이 상태 변경 `running_jobs`(3), 없는 작업·unknown 아님·맡는 브리지 없음 `not_releasable`(3), `resumed`(0), `not_waiting`·`emergency_stopped`·`queue_full`(3). 작업 레인이 닫힌 배치의 해제와 정책·설정 읽기 실패는 `failed`(1). 새 이름 일곱(`blocked`·`already_blocked`·`not_releasable`·`resumed`·`not_waiting`·`emergency_stopped`·`queue_full`)은 homelab CLI `BOT_RESULTS`에 아직 없어, homelab 쪽 집합을 넓히기 전에는 CLI가 봇 결과를 형식 오류로 본다.

## 동료 봇 전환 7 한도 정보 구현 위치 (C03, 2026-11-10)

- "동료 봇 전환 (사용자 2026-11-09)" 7의 한도 정보 읽기 자리다. 결정은 바꾸지 않았다. 작업자가 `rate_limit_event`를 읽어 응답 한도 칸(`src/contracts.ts` `RateLimitInfoSchema`)에 싣는다: 해석 `src/executor-claude.ts`, 대화 v2 `src/chat-lane.ts`, 리뷰 `src/review-lane.ts`·`src/review-http.ts`, 작업 레인 `src/executor-claude-task.ts`·`src/task-contracts.ts`. 결제 멈춤은 칸의 `stop.cause: 'billing'`으로 한도와 가른다. 재개·리뷰 미루기는 C19다. 기록은 [ARCHITECTURE](ARCHITECTURE.md) §12 "T16b 실행기 프로필"의 "한도 정보", [VERIFICATION](VERIFICATION.md) "C03 작업자 한도 정보".

## C10 고정 문구: 기억·브리핑 (2026-11-10)

"동료 봇 전환 (사용자 2026-11-09)" 4(말투)·6(기억)·9(스위치)의 기억·브리핑 쪽 구현 선택이다(사용자 결정 아님). 결정은 바꾸지 않았다. 시험·결과는 [VERIFICATION](VERIFICATION.md) "C10 고정 문구 2".

- **해요체 대상은 문장:** 기억 명령 응답·오류·충돌·삭제 안내, 브리핑의 누락·지난 회차 전달 줄은 해요체 문장으로 바꿨다. 브리핑 칸 이름(`■ 확인 필요` 등)과 상태 표시(정상·미확인·확인 필요·읽기 불가·연결된 조회 없음), 관측 칸 요약(`src/briefing-observations.ts`), 검색 결과의 상태 꼬리표(`active(확정)`)는 명사형 표시라 그대로 둔다. 그래서 `briefing-observations.ts`는 고치지 않았다. "정상"은 신선한 관측일 때만, 확인 못 하면 "미확인" 규칙도 그대로다.
- **스위치로 고르는 줄:** 기억 명령 충돌 안내(`memory-search`·`memory-correct`), 저장 제외 뒤 삭제 안내(`memory-delete`), 응답 유실·일시 오류 안내(`/memory-search`), 브리핑 모델 호출 중지 줄(`/model-status`)이다. 표는 `src/memory-commands.ts` `MEMORY_GUIDE`와 `src/briefing.ts` `BRIEFING_TEXT.modelStopped`다. 켜짐 판은 말로 하는 안내("그 기억 지워 줘")이고, 모델 상태는 `homelab bot` CLI로 확인한다고만 적는다(하위 명령 이름은 C05가 정한다). 입력 서식 오류의 키 이름(`expires=` 등)은 명령 이름이 아니라 두 판이 같다.
- **스위치 전달:** `MemoryCommands`는 다섯 번째 인수 `colleague`, 브리핑은 `BriefingConfig.colleague`로 받는다. 수신(`discord.ts`)은 처리기의 `guide`를 써서 생성자 모양을 바꾸지 않는다. 운영 배선(`src/main.ts`에서 `config.colleagueEnabled === true`를 넘기는 두 자리)은 이 티켓의 파일 밖이라 하지 않았다. 배선 전에는 늘 꺼짐 판이다.
- **원문 7일 안내:** 삭제 응답(완료·대기 모두) 끝에 "이 스레드의 원래 메시지는 7일 뒤에 지워져요(제가 받아 둔 원문 기준이고, Discord에 올라간 메시지는 그대로 남아요)."를 붙인다. 기억 삭제는 원문을 지우지 않고 T31 정리(받은 지 7일, 끝나지 않은 작업이 가리키는 행은 남김)가 비운다. owner가 Discord에서 자기 메시지가 사라진다고 읽지 않게 괄호를 더했다. 7은 `RAW_TEXT_RETENTION_MS`에서 계산한다.
- **안전 문장 유지:** 오류 응답은 입력값을 되풀이하지 않고(키 이름만), 삭제 응답은 완료/대기와 백업 최대 14일, 이미 Discord에 올라간 사본(브리핑, 기억 응답)을 지우지 않는다는 문장을 그대로 싣는다. 사본 범위 문구의 "이 명령들의 응답"은 켜짐 판에서 '/' 명령을 가리키지 않게 "기억 응답"으로 바꿨다.

## 동료 봇 전환 4·11 답장·owner 호출·스레드·표식 구현 위치 (C07, 2026-11-10)

"동료 봇 전환 (사용자 2026-11-09)" 4·11의 게시 쪽 구현 선택이다(사용자 결정 아님). 결정은 바꾸지 않았다. 계약은 [ARCHITECTURE](ARCHITECTURE.md) §11 "표식·답장·스레드", 시험은 [VERIFICATION](VERIFICATION.md) "C07 답장·owner 호출·스레드·표식". 스위치 밖이라 병합하면 바로 운영에 나간다.

- **답장 범위:** 그 job을 만든 owner 일반 메시지가 답과 같은 채널에 있을 때의 대화 답·실패 안내(첫 쪽)만 답장한다. 명령으로 받은 대화, 채널 멘션으로 연 스레드의 첫 답은 답장하지 않는다(뒤는 스레드가 그 메시지에 묶여 있다). 상태 안내·제어 결과도 답장하지 않는다.
- **owner 호출 범위:** 작업 질문, 작업 완료(`Store.finish`), 작업 실패(`Store.fail`을 부르는 Claude·Codex 작업 브리지 경로), 변경 미리보기(`awaiting_publish_approval`), 변경 실패(`failed`)만이다. 변경 `blocked`·`cancelled`·`superseded`·`proposed`, 작업 막힘(unknown)·한도 대기·owner 확인 요청 안내는 부르지 않는다. CHANGE 자식 job의 실패 안내도 부르지 않는다(부모 변경 실패 알림이 부른다).
- **호출 모양:** 문구는 그대로 두고 게시자가 첫 쪽 앞에 `<@owner> `를 붙인다. `allowed_mentions.users`만으로는 본문에 멘션이 없어 알림이 가지 않는다.
- **스레드 제목이 비면** "새 대화"다. 제목은 게시 때 events 원문에서 만든다(원문이 7일 정리로 비었으면 이 고정 문구).

## 동료 봇 전환 14·16 작업자 변경 작성 v2 판 (C25, 2026-11-10)

"동료 봇 전환 (사용자 2026-11-09)" 14(변경 질문)·16(PR 수정 반복)의 작업자 쪽 자리다. 결정은 바꾸지 않았다. 지시문 `src/executor-claude-task.ts` `TASK_INSTRUCTIONS['change-v2']`, 출력 `CHANGE_OUTPUT_JSON_SCHEMA`·`judgeTaskRun`, 계약 `src/task-contracts.ts`, intake `src/task-http.ts`, port 타입 `src/change-contracts.ts`. 기록은 [ARCHITECTURE](ARCHITECTURE.md) §16.4 "변경 작성 v2 판", [VERIFICATION](VERIFICATION.md) "C25 작업자 변경 작성 v2".

- **판 이름 `change-v2`(구현 선택):** 작업 레인 v1 판 `task-v1`과 이름으로 갈린다. 작업자는 v2 요청에 두 판을 받고, 게시 서버가 어느 판을 보낼지는 intake의 `change.instructions`로 정한다(C27·C28·C29). `TASK_INSTRUCTIONS_REVISION` 상수는 게시 서버가 보내는 판으로 그대로 두고 목록 `TASK_INSTRUCTIONS_REVISIONS`를 따로 뒀다. 상수를 목록으로 바꾸면 그 값을 요청에 싣는 `src/claude-task-bridge.ts`(소유 C09)를 고쳐야 해서다.
- **모델 글을 결과에 싣는 범위(T19 B1 규칙의 예외):** 새 판 결과에만 선택지·확인할 것·남은 위험을 싣는다. 요약은 여전히 싣지 않는다. 증거·승인 digest 재료가 아니고, 작업자는 반사 검사만 하며, 공개 경로로 내기 전의 공개 검사는 게시 서버(C28·C29)가 한다.
- **선택지 개수가 틀리면 출력 전체를 받지 않는다(`invalid_output`):** 자르거나 채워서 고칠 수 없는 칸이라서다(2개 미만이면 버튼을 만들 수 없다). 확인할 것·남은 위험은 개수·길이를 자르고 어긋난 위치만 버린다.
- **자료 블록 label은 `public`만:** 공개 저장소 PR의 리뷰·댓글이라서다. 상한(50개·4,000자·합계 40,000자)은 [제안]이고 C27 실측 뒤 조정한다.

## C12 PR 리뷰 말투 (2026-11-10)

"동료 봇 전환 (사용자 2026-11-09)" 4(말투)의 GitHub 리뷰 자리와 명세 §4.4 "PR 리뷰(GitHub)"·"리뷰 지시문 변경의 대가"다. 코드는 `src/review.ts`(`render`, `SERVER_REVIEW_INSTRUCTIONS`, `reviewRevision`, `ReviewQueue.admit`, `ReviewPublisher.publishable`), 시험 결과는 [VERIFICATION](VERIFICATION.md) "C12 PR 리뷰 말투".

- **렌더 형식(구현 선택):** 첫 줄은 대조 marker 그대로(T17 구현 선택 8). 둘째 줄은 "참고용 자동 리뷰예요. 승인·병합 판단이 아니고 안전을 보증하지도 않아요.", 셋째 줄은 검토 결과(검토를 마쳤어요/부분 검토예요, 본 파일 수, 못 본 파일 수, 상한 이름)와 리비전(head·기준·정책)을 한 줄에 둔다. 못 본 파일 목록(20개까지, 넘으면 남은 수), 공개 요약, 지적, 상한 생략 건수, 확인 질문은 정보는 그대로 두고 말투만 바꿨다. 지적은 `**[P0~P3] 제목** · 위치` 줄 아래 조건·영향·근거·개선을 공백으로 이은 한 문단이다. 인라인 댓글은 `**[심각도] 제목**`과 빈 줄 뒤 같은 문단이다(위치는 GitHub가 보여 준다).
- **한 문단 보장(구현 선택):** 모델 칸 안의 줄바꿈은 공백으로 접어 빈 줄이 문단을 끊지 못하게 한다. 칸이 글자·숫자로 끝나면 마침표를 붙인다. v1 지시문으로 저장된 결과(칸이 "…일 때" 같은 조각)도 새 렌더로 나가기 때문이다. 대신 근거 칸의 여러 줄 코드 블록은 한 줄로 접힌다. 모델 글은 지금처럼 `inert`(멘션·HTML 주석 무력화) 뒤에만 싣는다.
- **게시 서버 지시문:** `SERVER_REVIEW_INSTRUCTIONS` = `REVIEW_INSTRUCTIONS_V2`(C02). 출력 스키마는 그대로다. 작업자 `9b067e9` 이미지가 v1·v2를 받는다는 C06 운영 확인(homelab `approvals.md` 2026-11-10 10:1x~10:3x) 뒤라 병합해도 요청이 거부되지 않는다.
- **재리뷰 몰림 확인(코드):** 지시문은 세대 revision의 재료라(T17 구현 선택 4) 배포 순간 revision이 바뀐다. 고치기 전 코드에서는 재조정(`ReviewReconciler.run`)이 `reviewSince` 뒤에 갱신된 열린 PR마다 `admitLive`를 부르고, 새 세대 키에는 기존 행이 없고 base만 움직인 경우(`baseOnly`)도 아니라서 같은 head에 게시된 리뷰가 있어도 **열린 PR마다 새 세대가 생겼다**(사유 `policy_changed`). 한 바퀴 상한(`maxReviewsPerRun`, 최대 20)은 한 번에 넣는 수만 묶고, 다음 바퀴가 나머지를 넣는다. 게시를 기다리던 결과도 `publishable`에서 `policy_changed`로 버려졌다.
- **대응(구현 선택):** 출력 스키마가 같고 말투만 다른 지시문 판(`REVIEW_INSTRUCTIONS`·`REVIEW_INSTRUCTIONS_V2`)끼리만 다른 revision(입력 상한·비교 기준은 같음)은 "같은 리뷰 내용"으로 본다. (1) 그런 revision으로 저장된 게시 대기 결과는 버리지 않고 게시 직전 현재 렌더로 게시한다(T17 구현 선택 11·16과 같은 원칙). (2) 같은 PR·head·비교 기준에 그런 revision의 결과가 게시됐거나(`sending`·`sent`·`unknown`) 게시를 기다리면(`pending`) 자동 이벤트(webhook·재조정·live 재확인)로는 새 세대를 만들지 않는다(admission 결과 `instructions_only`, 재조정 예산에 세지 않음). 댓글 리뷰 명령과 base 재지정은 늘 새 세대다. (3) 모델을 아직 부르지 않은 대기 작업은 명세대로 `policy_changed`로 닫고 새 지시문으로 새 세대를 만든다. 결과가 차단(`blocked`·공개 범위 `restricted`)됐거나 실패한 head는 한 번 다시 리뷰된다(결과가 게시되지 않아 지킬 것이 없음).
- **예상 건수:** 2026-11-10 GET 조회로 `homelab-smoke` 열린 PR은 #12·#16 둘이고, 둘 다 현재 head(#12 `aa11c609`, #16 `7d2cef74`)에 봇 리뷰가 게시돼 있다. 그래서 병합 뒤 지시문 변경만으로 생기는 재리뷰는 0건으로 본다(대응 전 코드였으면 2건). 배포 순간 대기·실행 중인 리뷰가 있으면 그만큼 새 세대가 생긴다. 실제 건수는 배포 뒤 관찰(`review_reconciled` 로그, `pr_reviews`의 `superseded_reason='policy_changed'`)로 확인한다.
- **판 목록 유지:** v1 수용을 작업자에서 빼더라도(명세 §4.2 3단계) `VOICE_ONLY_INSTRUCTIONS`의 v1은 옛 결과를 알아보는 데 쓰이므로 남겨도 된다. 앞으로 지시문을 바꿀 때 출력 뜻이 바뀌는 변경(지적 기준·스키마)이면 이 목록에 넣지 않는다. 그러면 지금처럼 열린 PR이 다시 리뷰된다.
- **남는 것:** 실행 직전 검사(`ReviewRuntime`의 첫 정책 확인)는 `policy_changed`로 닫기만 하고 새 세대는 다음 재조정이 만든다(기존 동작). Discord 리뷰 요약·미게시 안내 문장은 C18 몫이라 바꾸지 않았다.

## C13 제안과 실행 확인 구현 선택 (2026-11-10)

"동료 봇 전환 (사용자 2026-11-09)" 2(모델은 제안만 한다)·9(스위치)·11(만료 24시간, 내용은 owner 원문)의 첫 구현이다. 사용자 결정이 아니라 구현 선택이고 결정은 바꾸지 않았다. 계약은 [ARCHITECTURE](ARCHITECTURE.md) §13 "제안과 실행 확인 (C13)", 시험은 [VERIFICATION](VERIFICATION.md) "C13 제안과 실행 확인".

- **연결한 동작은 둘:** 작업 목록(`list`, 읽기)과 작업 시작(`task`, 실행). 나머지 동작 줄은 "연결 안 됨"으로 버린다(C14~C17이 처리기를 단다). 관리 기능·구독 끄기·켜기·급한 질문은 표에 종류만 적고 처리기가 있어도 버린다.
- **답과 확인 글을 나눈다:** 모델 `reply`는 그대로 대화 답으로 게시하고, 실행 확인은 따로 한 줄 되묻기 글(버튼 달림)로 게시한다. 읽기 요청 결과도 따로 일반 글이다. 둘 다 outbox 키를 `result:<job>:proposal`·`result:<job>:read`로 둬 대화 답(`result:<job>`) 뒤에 나간다. 대화 기록의 봇 항목은 `result:<job>` 그대로라 이 둘은 다음 대화 기록에 들지 않는다.
- **제안은 결과 확정 뒤 별도 트랜잭션:** `Store.finish`의 시그니처를 바꾸지 않으려고 결과 확정 뒤 `ProposalDesk.consider`가 따로 쓴다. 사이에 죽으면 답만 나가고 버튼 글이 없다(실행 쪽으로는 안전). `source_job` UNIQUE라 다시 처리해도 제안은 하나다.
- **실행은 새 입력 이벤트로 '/task'와 같은 접수:** 작업 레인(`ClaudeTaskBridge`·`PolicyTaskPlans`, 소유 C09)이 job의 이벤트에서 원문(`text`)과 프로젝트(`target`)를 읽으므로, 버튼이 눌리면 원문·프로젝트를 담은 `provider='proposal'` 이벤트를 하나 넣고 `Store.accept(…, 'task')`로 접수한다. 원래 메시지 이벤트에는 이미 대화 job이 묶여 있어(jobs.event_id UNIQUE) 다시 쓸 수 없다. 이 이벤트는 owner의 받아들인 입력이라 다음 대화 기록에 '/task' 명령 항목으로 보인다(원문이 한 번 더 들어간다). 원문 7일 정리는 다른 이벤트와 같이 받는다.
- **"값 digest"의 재료:** `[동작, 대상, 내용]`의 sha256이다. 작업 시작의 내용은 원문 이벤트에서 다시 읽으므로, 그 원문이 비워지거나 바뀌면 버튼이 거부된다. 저장소가 작업 정책에서 빠진 경우는 digest가 아니라 실행 때의 `admit`이 거절한다.
- **"확인 글 메시지 ID"는 outbox 참조:** 제안 행에는 확인 글의 outbox `message_key`를 두고 메시지 ID는 그 행의 `external_id`로 읽는다. 상호작용의 `message.id`와 대조하지 않는다. 작업자 계약 밖 칸(`EventInput`, 소유 C02)을 늘려야 해서다. 대신 버튼은 추측할 수 없는 제안 ID(UUID)와 owner·대화 대조에 묶인다.
- **처리 뒤 응답은 결과 한 줄로 글을 바꾼다(`UPDATE_MESSAGE`):** 되묻기 글의 본문이 결과 한 줄로 바뀌고 버튼이 사라진다. 원문 앞부분이 그 글에서 사라지는 대신 결과(작업 ID)가 남는다.
- **누르지 않은 제안의 정리:** 새 제안을 만들 때 만료된 대기 제안을 `expired`로 바꾸고 값을 비운다. 따로 주기 작업을 두지 않았다. 작업 시작은 `value`가 비어 있어(원문은 참조) 지금은 남는 내용이 없다. C14가 기억 진술을 `value`에 두면 주기 정리(예: `Store.expire`에서 부르기)를 더할지 다시 본다.
- **버튼 이름:** `proposal-yes`·`proposal-no`. 기존 '/' 제어 버튼은 칸 수를 정확히 보게 바뀌어 `list:x`처럼 쓰지 않던 꼴은 이제 받지 않는다(게시 서버가 그런 버튼을 만든 적은 없다).

## C17 게시 승인 버튼 custom_id 묶음 (2026-11-10)

"동료 봇 전환 (사용자 2026-11-09)" 2(변경 게시는 미리보기 digest에 묶인 버튼, digest 입력은 예비)·9(스위치)의 구현 선택이다. 사용자 결정이 아니고 결정은 바꾸지 않았다. 시험은 [VERIFICATION](VERIFICATION.md) "C17 게시 승인 버튼".

- **묶음 행 없이 custom_id에 싣는다:** `change-publish-ok:<변경 ID 32자>.<generation>.<승인 digest 앞 16자>`(g1이면 67자, Discord 상한 100자). 변경 ID와 전체 digest(64자)를 함께 담으면 100자를 넘는다. 티켓은 그 경우 묶음 행(변경 ID·generation·digest·만든 시각)을 저장하라고 했지만, 승인 대상(`change_approval_subjects`)은 generation마다 하나이고 DB가 내용 변경을 막아(ARCHITECTURE §16 "DB가 직접 막는 것") 변경 ID·generation이 이미 digest 하나를 정한다. 그래서 마이그레이션을 더하지 않았다. digest 앞 16자는 누를 때 그 generation의 승인 대상 digest와 한 번 더 대조하고, 승인은 서버가 읽은 전체 digest로 `/change-publish`와 같은 `ChangeStore.approve`를 부른다(owner·generation·phase·digest·이벤트 멱등 검사가 같다). 대상 칸은 `BUTTONS` 표의 2칸 꼴에 맞추려고 ':' 대신 '.'로 나눈다.
- **옛 버튼:** 새 미리보기는 늘 새 generation이므로(공개 텍스트만 바뀌어도 새 generation) 옛 버튼은 generation 불일치로 거부되고 아무것도 바꾸지 않는다. 같은 generation이 무효화로 끝 상태가 되면 phase 불일치로 거부된다.
- **처리 뒤 응답:** 승인하면 `UPDATE_MESSAGE`로 버튼을 없앤다. 이 응답은 글 본문을 바꾸므로, 미리보기 마지막 쪽 본문(outbox `change-phase:<ID>:<generation>:awaiting_publish_approval`의 마지막 쪽)을 남기고 결과 한 줄을 붙인다. 보존 기간이 지나 본문을 비웠으면 결과 한 줄만 남는다. 거부(지난 미리보기·이미 승인·writer 확인 전·볼 수 없음)는 누른 owner에게만 보이는 응답이고 버튼은 남는다.
- **구독 꺼진 대화:** 실행 확인 버튼(C13)과 같이 버튼으로는 승인하지 않고 알린다. '/change-publish'는 지금처럼 구독과 무관하게 받는다.

## C15 세션 연결 키 버튼 구현 선택 (2026-11-10)

"동료 봇 전환 (사용자 2026-11-09)" 2(세션 연결 키는 버튼 뒤 본인만 보이는 응답)·9(스위치)의 구현이다. 사용자 결정이 아니라 구현 선택이고 결정은 바꾸지 않았다. 계약은 [ARCHITECTURE](ARCHITECTURE.md) §15 "seed 경계"의 "버튼 경로(C15)", 시험은 [VERIFICATION](VERIFICATION.md) "C15 세션 연결 키 버튼".

- **키는 "키 보기" 상호작용 안에서 만든다:** 티켓이 먼저 검토하라고 한 방식이다. "할게요"는 대상만 확정하고, 연결 생성(`ExternalTaskLinks.attach`)과 키 응답은 "키 보기" 상호작용 하나에서 한다. 키를 상호작용 사이에 보관하지 않으므로 '/attach'의 seed 경계(평문은 `seedMessage` 한 곳, `deliverPrivate`로만, 실패면 폐기, 다시 보내지 않음)를 그대로 쓴다. 검토하고 뺀 방법: "할게요"에서 연결을 만들고 "키 보기"에서 `rotate`로 새 키를 내기(키는 남지 않지만 실행 확인 트랜잭션 안에서 별도 트랜잭션인 `attach`를 불러야 해 대화 행 잠금과 엉킨다).
- **"이미 보여 줌" 표시는 제안 행의 사유 칸:** 끝 상태(`confirmed`)는 C13의 한 번 전이 그대로 두고, 사유를 `key_pending` → `key_shown`으로 바꾸는 조건부 UPDATE 한 번으로 키를 한 번만 만든다. 새 표·열(마이그레이션)을 더하지 않으려는 것이다. 표시를 연결 생성 전에 잡으므로, 그 뒤에 실패하면 같은 버튼으로는 다시 볼 수 없고 말로 다시 부탁한다(키를 두 번 만들 가능성보다 낫다고 봤다).
- **연결 대상은 제안 행 `target` 한 칸:** 끝 상태가 되면 C13이 `value`를 비우므로 세션 ID·실행기·동의를 JSON `[세션 ID, 실행기, 동의]`로 `target`에 둔다. 모두 서버가 형식을 대조한 값이고 비밀이 아니다.
- **"키 보기" 버튼 글은 따로 게시한다:** C13의 "할게요" 응답(`UPDATE_MESSAGE`)은 버튼을 모두 없애고 상호작용 응답 모양을 바꾸지 않으려고, 버튼 글은 outbox 버튼 칸으로 새 글을 낸다(README 5절의 "outbox 버튼 칸(C15·C17이 씀)").
- **R08 스위치 전달:** 제안 처리(`ProposalDesk`)가 R08 연결 명령을 조립했는지 알아야 꺼졌을 때 제안을 버릴 수 있다. 그래서 `Runtime` 옵션 `externalTask`와 `ProposalDesk`의 넷째 인수(기본 `false`), 준비 문맥의 `externalConnected`를 더했다. 조립은 `main.ts`가 `!!config.externalTask`를 넘기는 한 줄이다.
- **모델이 실행기를 고르는 꼴:** 대화 출력 스키마(`CHAT_REPLY_JSON_SCHEMA`, 소유 C02)의 `content` 설명은 기억 진술·검색어만 말한다. 세션 연결 제안은 `content`에 '/attach'의 text 꼴(`claude`·`codex`, 동의하면 `summary=on`)을 요구하고, 그 꼴이 아니면 버린다. 스키마 설명에 이 꼴을 더하는 일은 이 티켓 밖이다(아래 VERIFICATION "남은 위험").

## C19 한도 재개와 리뷰 미루기 (2026-11-10)

"동료 봇 전환 (사용자 2026-11-09)" 7과 D-14 조건 2의 "변경(사용자 2026-11-09)" 문단의 구현이다. 결정 자체는 바꾸지 않았고, 아래는 구현 선택이다(사용자 결정 아님). 스위치 밖이라 병합하면 바로 운영에 나간다. 계약은 [ARCHITECTURE](ARCHITECTURE.md) §11 "호출 경로·직렬 대기·측정"·§13 "상태 안내", 시험은 [VERIFICATION](VERIFICATION.md) "C19 한도 재개와 리뷰 미루기".

- **멈춤 기록 한곳(`migrations/022_model_pause.sql`):** 대기 작업마다 `model_pauses` 한 행(종류 `rate_limit`·`auth_expired`·`billing`, 풀리는 시각, 한도 종류, 사용률, 다음 재시도 시각)이고, 계정의 마지막 한도 관측과 리뷰 미룸 기한은 `model_limit_state` 한 행이다. 둘 다 DB에 있어 재시작 뒤에도 같다. C21 지표가 이 표를 읽는다. `jobs.wait_reason`은 그대로 `model_limit`·`auth_expired`라 상태 문구·브리핑·'/' 명령이 바뀌지 않는다.
- **재개 스케줄:** 한도 + 풀리는 시각이면 그 시각 + 1분, 시각이 없으면(옛 작업자, 칸 미수신) 30분 뒤, 인증 만료는 30분 뒤다. 다시 한도로 멈추면 새 기록으로 다시 잡는다(그래서 "30분마다"). 풀리는 시각이 이미 지났다고 오면 적어도 1분 뒤로 둔다(곧바로 재실행 반복 방지). 상수는 `src/store.ts` `MODEL_RESUME`.
- **재개 예약 루프:** `Store.resumeDue()`를 게시 서버가 15초마다 부른다(`src/main.ts` `model_resume`). 비상 정지 중이면 아무것도 하지 않고, 결제 멈춤은 재시도 시각이 없어 고르지 않으며, 큐가 차면 다음 바퀴에 본다. 감사 행위자는 `auto_resume`이다.
- **같은 해제 전이 하나:** '/resume-model <job>', 관리 진입점 `homelab bot resume job`(C32 `adminResumeJob`), '/review-resume', 재개 예약 루프가 모두 `Store.resumeWaiting` 하나를 부른다(`waiting_user` → `queued`, 시도 한도 검사, 멈춤 기록 지움, 전역 정지 해제). 그래서 인증 만료를 owner가 풀면 어느 진입점이든 그 자리에서 재개하고, 예약 루프가 같은 작업을 또 재개하지 않는다. 작업 행만 바꾸므로 계정·모델·실행기는 그대로다. 계정 전환 뒤 해제(C22)도 이 경로를 쓰면 된다.
- **결제 구분:** 작업자 응답의 한도 칸 `stop.cause`(C03)가 `billing`이면 결제 멈춤이다. 작업자 계약은 바꾸지 않았다. 칸이 없는 응답(옛 작업자)의 `limited`는 한도로 본다.
- **한도·인증 멈춤은 시도로 세지 않는다(티켓의 "재시도 상한 유지"와 다름):** 대기에 들어갈 때 `attempt`를 하나 되돌린다. 세면 시각을 모르는 한도는 두 번 재시도한 뒤 시도 한도(3)에 닿아 재개될 수 없고, 그 작업이 전역 정지를 영영 잡아 봇 전체가 owner의 취소를 기다린다. 명세의 "30분마다"·"토큰 교체 뒤 30분 안에"를 지키려면 세지 않아야 한다. 시도 한도 검사 자체는 그대로라 실패 재시도·질문 재개는 지금처럼 센다. 결제 멈춤은 owner가 풀어야 하므로 지금처럼 센다. 같은 시도 번호로 다시 멈추면 대기 안내의 멱등 키(`waiting:<job>:<attempt>`)가 같아 30분마다 안내가 다시 나가지 않는다. 바뀌는 기존 동작: 질문 재개로 시도 한도에 닿은 작업 레인 작업이 한도로 멈추면 지금까지는 재개 대신 취소를 안내했지만(T18 "재개 대신 /cancel"), 이제 그 멈춤이 시도 하나를 돌려받아 재개를 안내하고 저절로 이어서 한다. 주 진행자 확인이 필요한 선택이다.
- **한도·인증 대기 턴은 작업 턴 예산에서도 뺀다(주 진행자 결정, PR #126 Codex 지적):** 시도만 되돌리면 작업 세션의 턴 예산 16이 재시도마다 줄어 시각 모르는 한도가 약 8시간 이어지면 진행 없이 `task_turn_limit`으로 끝난다. 그래서 세션 프로토콜의 턴 번호 상한(`src/task-contracts.ts`)을 DB integer 한계로 올려 예산과 떼고, `codex_sessions.model_wait_turns`(결제 제외, 새 세대에서 0)를 빼고 센다. CHANGE 작성 재개도 같은 검사(`change_turn_limit`)다. 배포는 게시 서버가 먼저이고 작업자는 C23 이미지 갱신에서 따라온다. 그 전까지 옛 작업자는 턴 17 이상을 거부해 작업이 `task_worker_rejected`로 실패한다(지금 `task_turn_limit`과 같은 결말).
- **배포 전에 생긴 대기:** 멈춤 기록이 없는 한도·인증 대기는 예약 루프가 처음 본 때부터 30분 뒤로 잡고(감사 `model_pause_backfilled`), 같은 규칙으로 시도로 세지 않는다. 시도 한도에 닿아 있던 옛 대기도 30분 뒤 재개된다. 옛 `model_limit` 중 결제였던 것은 재실행에서 결제로 다시 기록돼 멈춘다.
- **리뷰 미루기:** 대화·리뷰 실행 결과의 `allowed_warning` + 풀리는 시각을 `model_limit_state.review_deferred_until`에 남기고(늘리기만 함), 그 시각까지 `ReviewRuntime.claim`이 PR 리뷰를 집지 않는다. 대화·작업 claim은 보지 않는다. 미룬 리뷰는 `queued`로 남는다. 작업 레인 응답의 경고는 쓰지 않는다(티켓 범위: 대화·리뷰). 미게시 후보 리뷰(`/v1/change-review`)는 결과 스키마에 한도 칸이 없어 경고를 받지 못하고, owner가 시킨 변경 작업의 한 단계라 미루지 않는다.
- **브리핑:** 미루는 동안 대기열의 PR 리뷰 건수를 `BRIEFING_TEXT.reviewsDeferred` 한 줄로 적는다. 미루지 않거나 0건이면 줄이 없다.

## C14 나머지 동작 연결: 값의 출처와 구현 선택 (2026-11-10)

"동료 봇 전환 (사용자 2026-11-09)" 2·11·13·15를 C13 동작 표의 나머지 줄에 이었다. 사용자 결정이 아니라 구현 선택이고 결정은 바꾸지 않았다. 계약은 [ARCHITECTURE](ARCHITECTURE.md) §13 "제안과 실행 확인 (C13)"의 "나머지 동작 줄(C14)"·"게시 순서(선행 키)", 시험은 [VERIFICATION](VERIFICATION.md) "C14 나머지 동작 연결".

- **값의 출처:** 변경 요청 내용은 owner 원문(멘션 표기 제거)이고 모델은 저장소(변경 정책의 `fullName`이나 저장소 ID)와 동작만 고른다. 모델의 `content`는 쓰지 않는다. 기억 저장·정정 내용은 모델이 골라낸 글(`content`)이라 `proposals.value`에 두고 확인 글에 줄이지 않고 싣는다. 버튼 때 digest(`[동작, 대상, 내용]`)가 같은 그 글만 저장한다. 기억 검색어도 모델 `content`다(읽기라 확인 없이 '/'와 같은 처리기를 부른다). 나머지 대상(작업·변경·기억·연결 ID, 템플릿 ID, 출처 키)은 모델 `target`이고 서버가 대조한다.
- **기억의 출처는 원 메시지:** 기억 저장·정정의 대화 출처는 owner가 말한 원 메시지 이벤트(Discord 메시지 ID)다. 버튼 상호작용 이벤트가 아니다. 그래서 근거 판정(`memory.ts` 출처 확인: provider `discord`, 받은 입력, 같은 owner, 지금 닿는 채널)이 '/memory-save'와 같이 "owner 대화"가 된다. 출처 제외 `here`도 그 스레드다.
- **이벤트 원문 규칙과 말로 한 기억:** "기억 명령 처리"의 "진술·검색어를 `events`에 넣지 않는다"는 '/' 명령의 입력 칸에 대한 규칙이다. 말로 한 기억·검색 요청은 owner가 이미 일반 메시지로 보낸 글이라 그 메시지가 `events`에 남고 다음 대화 맥락에 들어간다(명세 §4.3 "기억 원문": 따로 봉인하지 않는다, 원문 7일 정리는 그대로). 이 규칙은 그 메시지에는 해당하지 않는다. 서버가 따로 만드는 값(모델이 골라낸 진술)은 `events`에 넣지 않고 `proposals.value`에만 두며, 처리·거절·만료로 끝나면 비운다.
- **말로 한 변경 요청의 서식:** '/change'의 text 서식(`요약 | accept=… | label=…`)은 인수 조건이 하나 이상 있어야 받는다. 말에는 인수 조건 칸이 없으므로 서버 고정 문구 `SPOKEN_CHANGE_ACCEPTANCE`("요약에 적힌 owner의 요청이 반영돼 있다") 하나를 붙이고, 출처는 결정 15의 공개 표시 `label=public`이다. 요약은 원문 그대로라 원문에 서식 글자(` | `, 앞머리 `goal=` 등)가 있거나 길이·제어 문자 상한에 걸리면 제안을 버린다(owner는 '/change'로 할 수 있다). 명세는 인수 조건을 정하지 않았다.
- **변경 요청 확인 글은 원문을 싣지 않는다:** 결정 15의 문구 그대로 "<저장소>에 이 변경 PR을 준비할까요?" 한 줄이다. 무엇을 바꿀지는 바로 위 대화 답과 owner 자신의 말이 보여 준다. 그래서 확인 글 공개 검사에 원문이 걸려 문구가 바뀌는 일이 없다.
- **처리기 배선은 같은 `Store`에 묶는다:** 읽기 요청과 제안 준비는 `Runtime`의 대화 성공 분기에서 일어나는데, '/' 처리기는 Gateway 준비 뒤에 만드는 수신(`DiscordIngress`)이 갖고 있다. `Runtime`·`main.ts`(이 티켓 소유 밖)를 고치지 않고 수신 생성자가 같은 `Store`에 처리기를 묶는다(`bindProposalHandlers`, WeakMap). 수신이 아직 없을 때 끝난 대화의 기억·변경·연결 제안은 "연결 안 됨"으로 버린다(대화 답은 나간다). 생성 인수로 넘기는 편이 더 드러나지만 `Runtime` 시그니처를 바꿔야 한다.
- **커밋 뒤 실행:** 기억·변경·세션 연결 처리기는 버튼 트랜잭션 커밋 뒤 한 번 부른다. 제안은 그 전에 `confirmed`가 되므로, 처리기가 거절해도(입력 오류·권한) 제안은 `confirmed`로 남고 결과는 버튼 응답 문장으로만 보인다. `confirmed`는 "owner가 확인해 '/'와 같은 처리기에 넘겼다"는 뜻이다. 작업 취소·재시도·리뷰 제어는 '/'처럼 트랜잭션 안에서 실행하고 제어가 거절하면(`ok: false`) `refused`(`control_refused`)다.
- **말로 하는 세션 연결 해제는 이 스레드의 연결만:** '/detach'는 owner의 연결이면 어느 스레드에서든 받는다. 말로 할 때는 티켓 할 일 2("이 대화에서 볼 수 있는 것만")대로 그 스레드에 연결한 열린 연결만 받는다.
- **리뷰 대상은 리뷰 job이면 된다:** 리뷰 작업은 대화가 없어 "이 대화에서 볼 수 있는" 대조가 없다. 대상은 `type='review'` job이고 권한은 결정 13의 장소(owner, 허용 채널 본문·그 아래 스레드)다. 버튼 때 누른 시점의 정책으로 다시 판단한다.
- **누르지 않은 기억 제안의 값:** 새 제안을 만들 때와 버튼을 누를 때만 만료를 정리한다(C13 그대로). 주기 정리(`Store.expire` 등)는 `store.ts`의 이 티켓 자리 밖이라 더하지 않았다. 그래서 누르지 않은 기억 진술은 24시간 뒤 다음 제안이 생기거나 그 버튼을 누를 때까지 `proposals.value`에 남는다.
- **게시 순서는 선행 키로:** 확인 글·읽기 결과의 outbox `payload.after`에 대화 답의 `message_key`를 두고 `claimDelivery`가 그 글의 쪽이 모두 끝날 때까지 집지 않는다(PR #125 Codex 2차 P2). 새 칸이 아니라 payload JSON 안의 키라 마이그레이션이 없다. 선행 글이 `blocked`·`failed`로 끝나면 기다리지 않는다.

## C16 작업 질문 바로 답 구현 선택 (2026-11-10)

"동료 봇 전환 (사용자 2026-11-09)" 2(작업 질문은 열린 질문이 하나면 다음 말이 답)·9(스위치)·14(변경 질문은 C28)의 구현이다. 사용자 결정이 아니라 구현 선택이다. 계약은 [ARCHITECTURE](ARCHITECTURE.md) §12 "질문 계약"의 "작업 질문 바로 답", 시험은 [VERIFICATION](VERIFICATION.md) "C16 작업 질문 바로 답".

- **멘션도 답으로 본다:** 열린 작업 질문이 있는 스레드에서 owner가 보낸 일반 메시지는 멘션이 있어도 답이다. 명세 §4.3의 "owner의 다음 메시지"를 그대로 따랐다. 질문 중에 대화를 하려면 질문에 답하거나 다른 스레드에서 말한다.
- **열린 질문은 수신 트랜잭션 안에서 센다:** 티켓은 "저장 전"에 보라고 적었지만, 작업 질문의 답은 지금 `/answer`(v1)처럼 원문을 `events`에 두므로 저장 전에 봉인할 것이 없다. 대화 행을 잠근 뒤 세면 수신과 질문 만료·답 사이의 경합이 없다. CHANGE 질문은 세지 않으므로 그 답이 이 경로로 봉인 없이 저장되는 일도 없다.
- **고르기 행은 `controls`에 둔다:** 마이그레이션 번호를 쓰지 않으려고 반응 행(`reaction:`)처럼 `controls`에 `question-pick:<UUID>`로 둔다. 값은 ID뿐이라 7일 정리 대상이 아니다.
- **버튼 이름은 번호, 앞부분은 본문:** 티켓은 버튼에 질문 앞부분을 보이라고 했지만 7일 정리(T31)는 게시의 `payload.content`만 비운다. 버튼 이름에 모델이 쓴 질문 조각을 두면 기간 없이 남아 본문에 번호와 함께 싣고 버튼은 "1번 질문"으로 했다. 한 줄 상한 때문에 버튼은 5개까지다.
- **질문 글의 판:** 작업 질문 글은 켜짐 판에서 질문 ID를 옮겨 적으라고 하지 않는다. 변경 질문 글은 같은 `ask`로 만들지만 `change_child_jobs`(role `author`)로 가려 지금 판(질문 ID와 `/answer`)을 켜짐에서도 둔다. 이 판은 C28이 바꾼다.
- **결과 안내:** `/answer`와 같은 `controlText('answer', …)` 문구를 그 메시지에 답장으로 단다. 받았다는 👀는 달지 않는다. 이 글이 받은 표시이고, 대화 작업이 없어 👀를 지울 계기가 없다. history gap 동안 받아 버퍼에 둘 때 이미 단 👀는 복구 때 바로 답·고르기로 보내면서 그 반응 행을 `cleared`로 옮겨 지운다.
- **고르기 글의 버튼은 실제로 답을 붙였을 때만 없앤다:** 새 고르기는 닫힌 질문의 행만 지우므로, 행 하나가 없거나 그 질문을 바로 답할 수 없는 것은 그 질문만의 끝이다. 그 버튼을 누르면 본인에게만 안내하고 같은 글의 다른 버튼은 남긴다. 버튼을 없애는 것은 답을 붙였을 때와 그 말 자체를 쓸 수 없을 때(원문 정리, 다른 사람·다른 대화의 말)뿐이다.

## C21 운영 알림 (2026-11-10)

"동료 봇 전환 (사용자 2026-11-09)" 7의 "원인·풀리는 시각·할 일은 Telegram 운영 알림으로"의 구현이다. 결정은 바꾸지 않았고, 아래는 구현 선택이다(사용자 결정 아님). 지표는 [ARCHITECTURE](ARCHITECTURE.md) §13 "지표", 경보는 homelab `platform/observability/stack/vmalert/rules/bot.yaml` `HomelabBotModelPaused`, 시험은 [VERIFICATION](VERIFICATION.md) "C21 운영 알림".

- **멈춤은 종류별 작업 수 + 풀리는 시각 두 계열:** 종류(`rate_limit`·`auth_expired`·`billing`)는 `model_pauses.kind`의 CHECK 목록 그대로 코드에 고정하고, 멈춤이 없어도 0으로 낸다. 풀리는 시각은 그 종류의 대기 중 가장 늦은 것(Unix 초)이고 모르면 **0**이다(계열을 없애지 않는다). 경보가 이 값을 경보 값으로 쓰고 멈춤 여부는 작업 수로 가르기 때문이다. 0이면 경보 문구가 "모름"(한도)·"없음"(인증 만료·결제)으로 적는다.
- **지금 계정은 라벨:** 운영 알림에 계정 이름이 나와야 하고 Telegram 문구는 vmalert 템플릿이 만들므로, 이름을 라벨 값으로 둔다. 비밀이 아니고(owner가 CLI로 정한 짧은 이름) 계정은 한 번에 하나라 계열도 하나다. 계정 기록은 C22가 만든다. **그 전 모양은 `homelab_bot_model_account{method="none"} 1`**(계정 라벨 없음)이고 경보 문구는 "미등록"이다. C22가 이 줄에 `account`(CLI 이름 규칙을 통과한 이름만, 그 밖이면 라벨을 비운다)와 `method`(`subscription`·`api`)를 채운다. 계정을 바꾸면 옛 계열은 수집 staleness로 사라진다.
- **미룬 리뷰 수:** 브리핑(C19)과 같은 대상, 리뷰 미루기 기한 안의 대기열 PR 리뷰(미게시 후보 리뷰 제외)다. 기한 밖이면 0이다. 경보는 걸지 않았다(멈춤이 아니라 대화·작업은 계속된다).
- **KST 표기:** vmalert 템플릿에 시간대 함수가 없어 `toTime`의 UTC에 9시간을 더해 "YYYY-MM-DD HH:MM KST"로 적는다. 한국은 서머타임이 없어 이 계산이 늘 맞다. 봇 지표는 Unix 초 그대로다.
- **경보 지속:** `for` 없이 첫 평가에 울리고(도착 예산 2분), `keep_firing_for: 5m`로 재시도 틈을 잇는다. 시각 모르는 한도·인증 만료는 30분마다, 한도는 풀리는 시각 1분 뒤 작업을 다시 돌려 그동안 작업 수가 0이 된다. 그 틈에 해소·새 발생이 가지 않는 대신 진짜 해소도 5분 늦게 온다.
- **Discord에는 안 간다:** 경보에 `service` 라벨이 없어 봇 수신기가 감사(`alert_ignored`)만 남기고 버린다. Alertmanager 설정은 바꾸지 않았다(warning → 봇 route `continue` + Telegram 형제 route, 4시간 반복, 해소 전송).

## C30 리뷰 요청 구현 선택 (2026-11-10)

"동료 봇 전환 (사용자 2026-11-09)" 9(스위치)·18(리뷰 요청, 설치 범위, 자동 리뷰 대상은 정책 목록 그대로)의 구현이다. 사용자 결정이 아니라 구현 선택이고 결정은 바꾸지 않았다. 계약은 [ARCHITECTURE](ARCHITECTURE.md) §13 "제안과 실행 확인 (C13)"의 "리뷰 요청(C30)", 시험은 [VERIFICATION](VERIFICATION.md) "C30 리뷰 요청".

- **제안 동작 ID:** 작업자 계약의 제안 동작 목록(`PROPOSAL_RUN_ACTIONS`) 끝에 `review_request` 하나를 더했다(주 진행자 2026-11-10 허용). 목록은 작업자 요청 본문이 아니라 작업자 안의 출력 스키마에만 들어가 capability digest와 요청 `z.literal`은 그대로다. 그래서 새 게시 서버 + 옛 작업자(운영 이미지 `9b067e9`)는 대화가 깨지지 않지만 모델이 이 제안을 낼 수 없다(작업자 출력 스키마 enum에 없음). 작업자 이미지를 바꿔야 리뷰 요청이 동작한다. 반대(옛 게시 서버 + 새 작업자)는 모델이 `review_request`를 내면 게시 서버의 응답 검사(`ChatReplySchema`)에 걸려 그 대화가 실패하므로, 게시 서버가 먼저 배포돼야 한다(지금 배포 순서: 게시 서버 자동, 작업자는 사람 PR).
- **"확인 없는 실행" 줄:** 동작 표(`ACTIONS`)에 종류 `run`이고 `confirm: false`인 줄을 하나 더했다. 이 칸이 있는 실행 줄만 읽기 줄처럼 확인 글·버튼 없이 처리기 결과를 일반 답(`result:<job>:read`)으로 단다. 기존 줄은 이 칸이 없어 그대로다.
- **대상은 owner 원문에 있어야 한다:** 확인 버튼이 없으므로 모델이 고른 대상(`<소유자>/<저장소>#<번호>`, 링크 등)은 그 owner 메시지 원문(멘션 표기 제거)에 같은 PR이 링크(`github.com/<소유자>/<저장소>/pull/<번호>`)나 짧은 꼴(`<소유자>/<저장소>#<번호>`, 소유자를 빼면 조직 저장소)로 있을 때만 쓴다. 원문에 없으면 리뷰하지 않고 그 이유를 답한다(버리면 모델 답만 "리뷰할게요"로 남아 아무 일 없는 것처럼 보인다). "12번 PR"처럼 저장소가 없는 말은 받지 않는다.
- **조직 이름은 코드 상수:** `REVIEW_REQUEST_ORGANIZATION = 'ukyi-app'`(`src/review-request.ts`). 리뷰 정책(`ReviewPolicySchema`)에 칸을 더하면 운영 정책 JSON이 그 칸 없이 검사에 걸려 리뷰 경로가 닫히므로 정책을 바꾸지 않았다. 조직 이름은 공개 정보다.
- **명시 트리거는 `comment` 그대로:** Discord 요청도 PR 댓글 명령과 같은 trigger 값(`comment`)으로 접수해 draft 예외·늘 새 세대·대체에서 보호가 코드 한 곳도 바뀌지 않고 같다. 출처는 리뷰 입력 이벤트의 `delivery_id`(`discord:<대화 job>`)와 payload `source: 'discord'`, 감사 `review_requested`(저장소·번호·결과·거절 사유)로 구분한다.
- **목록 밖 저장소의 범위는 그 세대의 작업 하나:** 대상 기록(저장소 ID·이름·설치 ID·visibility)은 `pr_reviews.request_target`(마이그레이션 023)에만 둔다. 실행 직전·게시 직전 저장소 대조와 설치 토큰 범위(`policyRepositories`)는 정책 목록에 없을 때 이 기록을 쓰되, 토큰은 그 세대가 아직 살아 있을 때(작업 `queued`·`running`·`verifying`·`waiting_user`·`cancel_requested`, 게시 `pending`·`sending`·`unknown`)만 받는다. 실행 전 head가 바뀌거나 정책 revision이 바뀌어 그 세대가 닫혀도 새 세대를 자동으로 만들지 않는다(정책 목록 저장소는 지금처럼 `live_check`로 다시 넣는다). owner가 다시 부탁하면 된다. 정책 목록·폴링 대조·webhook 저장소 검사(`GitHubIngress`)에는 더하지 않는다.
- **대상 조회:** 조직 밖이면 GitHub에 묻지 않는다. 조직 안이고 정책 목록 밖이면 App JWT로 `GET /repos/{owner}/{repo}/installation`(없으면 404 → "리뷰 App 없음"), 저장소 ID를 아직 모르므로 이름으로 좁힌 메타데이터 읽기 토큰(`repositories: [이름]`, `permissions: { metadata: read }`)으로 `GET /repos/{owner}/{repo}`를 읽는다. 설치 계정·토큰 저장소·저장소 정보(ID·이름·소유자 `Organization`)가 하나라도 요청과 다르면 쓰지 않는다. visibility는 응답의 `visibility` 칸(`public`·`private`·`internal`)을 먼저 보고, 칸이 없으면 `private` 불리언으로, 둘 다 없거나 서로 어긋나면 `private`로 닫는다 [확인: https://docs.github.com/en/rest/apps/apps#get-a-repository-installation-for-the-authenticated-app , https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app , https://docs.github.com/en/rest/repos/repos#get-a-repository]. PR과 merge base는 그 뒤 저장소 ID 하나·읽기 권한 토큰으로 읽는다.
- **목록 밖 비공개 저장소는 거절(Codex 리뷰 P2 반영):** 리뷰 작업자는 압축본을 `archiveContract`의 `codeload.github.com` 주소에서 자격 없이 받는다(`createArchiveFetcher`, `credentials: 'omit'`). 그래서 정책 목록 밖의 비공개·internal 저장소를 접수하면 "리뷰 시작했어요"라고 답한 뒤 다운로드 거부로 반드시 실패한다. 작업자에 GitHub 자격을 넘기지 않는 경계를 지키려고 인증된 압축본 경로는 만들지 않고, 접수(`ReviewRequests`)에서 대상 조회 결과가 `public`이 아니면 PR을 읽기 전에 `not_public`("비공개 저장소의 PR은 아직 리뷰할 수 없어요.")으로 거절한다(리뷰 작업 0건). 인증된 압축본 전달 경로가 생기기 전까지의 한계다. 정책 목록 저장소는 운영자가 고른 대상이라 visibility와 상관없이 지금처럼 받는다.
- **배선:** 리뷰 요청 접수(`ReviewRequests`)는 App 자격이 있는 리뷰 입출력 조립(`githubReviewIO`의 `requests` 인수)이 같은 `Store`에 묶는다(`bindReviewRequests`, C14 `bindProposalHandlers`와 같은 WeakMap 방식). `main.ts`는 그 조립 줄의 인수만 바뀌었다. 리뷰 경로를 열지 않은 게시 서버에서는 묶이지 않아 제안을 "연결 안 됨"으로 버린다.

## C28 변경 질문 선택지 구현 선택 (2026-11-10)

"동료 봇 전환 (사용자 2026-11-09)" 14(변경 질문: 선택지 버튼 2~4개와 "직접 답하기", 공개 여부를 묻지 않음)·9(스위치)의 게시 서버 쪽 구현이다. 사용자 결정이 아니라 구현 선택이고 결정은 바꾸지 않았다. 코드는 `src/change-question.ts`(버튼·문구·누름 처리), `src/question-pick.ts`(다음 말·고르기), `src/discord.ts`(저장 전 봉인·버튼 분기), `src/task-bridge.ts` `ask`(질문 글·선택지 저장), `src/claude-task-bridge.ts`(판 고르기·선택지 전달), `src/change-runtime.ts` `questionRisk`, `src/raw-text-retention.ts`, `migrations/024_question_options.sql`. 계약은 [ARCHITECTURE](ARCHITECTURE.md) §16.5 "CHANGE 질문 답", 시험은 [VERIFICATION](VERIFICATION.md) "C28 변경 질문 선택지".

- **게시 서버가 변경 작성 요청을 `change-v2`로 보낸다(주 진행자 2026-11-10, 동료 기능 스위치 밖):** `ClaudeChangeAuthor.start`가 작업자 intake의 `change.instructions`(`TaskV2WorkerPort.changeInstructions`)를 읽어 `change-v2`가 있으면 그 판으로, 없거나(옛 작업자, 이 메서드가 없는 port) 읽지 못하면 옛 판 `task-v1`로 보낸다. 받지 않는 작업자에게 닫지 않고 옛 판을 보내는 이유: 옛 판은 지금 운영 동작 그대로이고, 새 판 요청은 옛 작업자가 모양으로 거부해(400 → `TaskWorkerRejected`) 변경이 시작도 못 하기 때문이다. 시작 턴의 판은 세션 `capabilities.instructions`에 남기고 답 뒤 재개는 그 판을 그대로 보낸다(판을 남기기 전 세션은 옛 판). 한 세션 안에서 판이 바뀌면 출력 스키마가 턴마다 달라진다.
  - **운영 영향:** `CHANGE_PR_ENABLED`가 켜져 있으면 병합·배포 즉시 새 변경 작성의 지시문이 바뀐다(C06 작업자 `9b067e9`가 `change-v2`를 알린다). 모델은 막히지 않으면 묻지 않고 가정해서 진행하고, 가정은 결과의 `checks`(확인할 것)·`risks`로 나온다. 이 두 칸을 미리보기·PR 설명에 싣는 것은 C29이고, 그 전까지 게시 서버는 두 칸을 받아도 쓰지 않는다. 묻는 경우 질문에 선택지 2~4개가 붙고, 선택지가 2~4개가 아니면 작업자가 `invalid_output`으로 그 변경을 실패시킨다. 스위치가 꺼져 있으면 선택지는 저장만 하고 질문 글·답 경로는 지금 그대로다.
  - **되돌림:** 게시 서버만 이 티켓 이전(C25 이후)으로 되돌리면 안전하다. 새 요청은 옛 판이고 작업자는 두 판을 받는다. 결과 스키마는 C25가 이미 선택 칸으로 넓혀 두어 진행 중인 새 판 세션의 결과도 읽고(선택지는 버리고 '/answer' 판 질문 글을 낸다), 그 재개는 옛 판으로 가며 작업자가 받는다. C25 이전으로 되돌리면 새 판 결과를 모양으로 거부한다. 작업자만 되돌리면(`change-v2`를 모르는 이미지) 진행 중인 새 판 세션의 재개 요청이 모양 거부로 실패하고, 그 작업자가 저장해 둔 새 판 결과(선택지·확인할 것·남은 위험이 든 것)를 읽지 못한다(ARCHITECTURE §16.4 "배포 순서와 되돌림"). 작업자를 되돌리기 전에는 진행 중인 CHANGE 턴을 받아 두거나 drain한다.
- **고르기 대기 중 원문은 들고 있지 않는다(티켓 할 일 6의 판단):** 열린 질문이 둘 이상이고 그중 변경 질문이 있으면 그 말을 저장 전에 봉인하고, 답으로 쓰지 않는다. 고르기 글("어느 질문에 답할지 먼저 골라 주세요")과 C16 고르기 버튼을 달고, 누르면 그 질문을 이 대화의 다음 말 대상으로 적는다(`controls`의 `question-chosen:<대화>`, 값은 질문 ID와 owner뿐). 그 뒤 owner의 말이 그 질문의 답이다. 변경 질문 글의 "직접 답하기"도 누른 질문을 같은 자리에 다음 말 대상으로 적는다(`chooseNextAnswer`, Codex 2차 P2, 주 진행자 판정 수용). 티켓 할 일 5는 "직접 답하기"가 상태를 바꾸지 않는다고 적었지만, 고르기에서 작업 질문 A를 고른 뒤 변경 질문 B의 "직접 답하기"를 누르면 다음 말이 B가 아니라 A의 답이 됐다. 질문 행·작업 상태는 여전히 그대로이고 바뀌는 것은 다음 답 대상 표시 하나다. 마지막으로 누른 것(고르기 버튼이든 "직접 답하기"든)이 이긴다. 봉인한 원문을 고르는 동안 둘 자리가 마땅치 않아서다. `events`는 대화 맥락으로 모델에 들어가고, 고르기 행·`controls`는 7일 정리가 닿지 않는다. 대가는 owner가 같은 답을 한 번 더 말해야 하는 것이다. 질문이 작업 질문뿐이면 C16 흐름(그 말을 고른 질문에 붙임) 그대로다.
- **저장 전 봉인과 다시 보기:** 수신은 저장 전에 잠그지 않고 "이 말이 변경 질문의 답이 될 수 있는가"(`sealsNextMessage`)를 보고 참이면 원문을 비워 저장한다. 수신 트랜잭션에서 대화 행을 잠근 뒤 다시 센다. 그사이 변경 질문이 닫혀 답으로 쓰지 않게 되면 일반 대화라 원문을 되돌린다. 답 경로(바로 답·고르기)로 보낼 때는 저장 전 판단과 상관없이 늘 그 자리에서 `events` 원문을 비운다(Codex 2차 P1, 주 진행자 판정 수용). 저장 전 판단이 참이어도 행에 원문이 있을 수 있어서다. 질문이 열리기 전 gap 버퍼에 원문과 함께 둔 말을 질문이 열린 뒤 복구하면 그때의 판단은 참이지만 `Store.save`가 이미 있는 이벤트의 payload를 덮어쓰지 않는다. 판단만 믿고 비우기를 건너뛰면 공개 검사에 막힌 답까지 `events`에 남아 대화 맥락(`chatContext`)으로 모델에 갔다. 봉인한 말은 history gap 중이어도 복구 버퍼에 두지 않는다. 버퍼 재생은 `events`의 원문을 다시 읽는데 봉인한 행에는 원문이 없기 때문이다. gap 동안에는 checkpoint가 움직이지 않아 복구가 앞선 메시지를 그대로 다시 읽는다.
- **gap 중 실시간으로 받은 봉인한 말은 답으로 쓰지 않고 다시 말해 달라고 한다(Codex P2, 주 진행자 판정 수용):** 재연결 뒤 누락 복구가 끝나기 전에 실시간 말 B를 바로 답으로 쓰면, 누락 구간의 앞선 말 A(진짜 첫 답)보다 B가 질문을 닫고, 뒤에 복구한 A는 열린 질문이 없어 원문째 일반 대화로 들어갔다. 그래서 gap 중 B는 원문 없이 받은 것으로 닫고(`events.accepted`, `ignored: sealed_in_gap`) "놓친 말을 확인하는 중이라 방금 말은 답으로 쓰지 않았어요, 다시 말해 주세요" 뜻의 고정 글을 B에 답장으로 단다. A는 복구가 같은 봉인 판단으로 받아 원문 없이 답이 되고, history에 다시 나오는 B는 받은 것이라 건너뛴다. 메모리 순서 버퍼(원문을 들고 있다가 복구 뒤 순서대로 처리)를 고르지 않은 이유: 버퍼 재생·history 대조·재시작 세 경로에서 원문 출처를 따로 맞춰야 하고, 마지막 history 쪽과 버퍼 비우기 사이에 온 말은 어차피 원문을 잃어 되묻기가 또 필요하다. 이 방식은 원문을 메모리에도 들지 않아 재시작으로 잃을 것이 없다. 대가: 누락된 말이 없어도 gap 중의 답은 한 번 더 말해야 하고, 복구 한도를 넘겨 gap이 남은(budget, 수동 처리) 동안은 매번 되묻는다. 일반 메시지도 그동안 버퍼에서 기다리므로 대화 전체가 같은 상태다. 작업 질문뿐인 스레드(C16)와 스위치 꺼짐은 봉인하지 않아 지금처럼 버퍼에 둔다.
- **답에 공개 표시를 붙여 기존 처리기로:** 버튼의 선택지 글과 분류를 적지 않은 다음 말을 `label=public | <글>`로 `ChangeAnswerGuard.answerIn`(= `/answer`)에 넘긴다. 공개 검사(`scanPublicText`)·출처 기록·막기 규칙과 응답자·대화·기한·중복 검사가 '/' 경로와 같다. 공개 여부는 묻지 않는다(결정 14). 선택지 글은 모델이 쓴 것이라 `label=`로 시작해도 글 전체가 공개 답이다.
- **owner가 말에 적은 분류는 덮지 않는다(Codex 2차 P2 보안, 주 진행자 판정 수용):** 다음 말이 `label=`로 시작하면(대소문자·공백 무관, `spokenAnswer`) owner가 직접 적은 분류라 공개 표시를 붙이지 않고 그대로 처리기에 넘긴다. 처리기는 바깥 `label` 하나만 읽으므로, 덮어 감싸면 `label=private | …`가 공개 답 본문이 되어 작성 모델에 갔다. 같은 값이 `/answer`에서는 막히던 것과 어긋났다. 그대로 넘기면 결과가 `/answer`와 같다: `private`·`unknown`이면 작성 모델에 넘기지 않고 비공개 입력으로 기록하며 막고, `public`이면 표시를 떼고 공개 검사를 하고, 서식이 틀리면(모르는 분류, `|` 없음) 서식 안내를 답하고 질문은 열려 있다. 이 서식 안내는 owner가 분류를 적었을 때만 나오므로 공개 여부를 먼저 묻는 글이 아니다. 공개 검사에 걸린 답의 안내는 처리기 문구 그대로라 '/' 이름은 없지만 말투는 합니다체다(`change-commands.ts` 문구는 C18 자리라 고치지 않았다).
- **버튼 모양:** 선택지 버튼 이름은 "1번"처럼 번호이고 선택지 글은 질문 글 본문에 번호와 함께 싣는다. C16과 같은 이유(7일 정리는 게시 본문만 비움)에 더해 Discord 버튼 이름 상한(80자)이 선택지 상한(100자)보다 짧다. custom_id는 `change-choice:<질문 ID의 ':'를 '.'로>.<순번>`·`change-direct:<같은 질문 ID>`이고 선택지 글은 싣지 않는다(서버가 질문 행에서 읽는다). 질문 ID가 job·세션 UUID와 턴이라 100자 안이다. 버튼은 한 줄(선택지 최대 4개 + "직접 답하기")이다. 누른 뒤 응답은 질문 글을 질문·선택지·"n번을 답으로 보냈어요"로 바꿔 버튼을 없앤다. 닫힌 질문·다른 선택지·같은 버튼을 다시 누르면 본인에게만 "이미 답했거나 닫힌 질문"을 알린다.
- **선택지 없는 변경 질문(옛 판 세션):** 켜짐 판에서도 "직접 답하기"와 말로 답하기만 둔다. 배포 순간 진행 중이던 옛 판 세션의 질문이 여기에 해당한다.
- **선택지 저장과 7일 정리:** `codex_questions.options`(jsonb, 없으면 NULL)에 질문 행과 같은 트랜잭션으로 둔다. 질문 원문과 같은 기준·예외(`purgeExpiredQuestionPrompts`)로 NULL로 비우고 jsonb text 표현의 SHA-256을 `options_sha256`에 남긴다. 지운 시각은 같은 행의 `prompt_purged_at`이다.

## 동료 봇 전환 14·17 확인할 것과 안내 댓글 구현 선택 (C29, 2026-11-10)

"동료 봇 전환 (사용자 2026-11-09)" 14(가정은 미리보기와 PR 설명의 확인할 것에)·17(안내 댓글, 자체 리뷰 전체 비게시)의 게시 쪽 구현이다. 사용자 결정이 아니라 구현 선택이고 결정은 바꾸지 않았다. 계약은 [ARCHITECTURE](ARCHITECTURE.md) §16.3 "확인할 것·남은 위험 (C29)"·"안내 댓글 (C29)", 시험은 [VERIFICATION](VERIFICATION.md) "C29 안내 댓글과 확인할 것". 스위치 밖이라 병합하면 변경 PR을 새로 게시할 때부터 운영에 나간다.

- **자체 리뷰 흐름은 그대로:** 자체 리뷰가 P0·P1을 내면 지금처럼 고치지 않고 그 변경을 막고(`review_blocked`), P2·P3만 남으면 위험 건수(고정 enum)만 싣고 게시한다. 자체 리뷰 `findings` 자유문은 PR 설명·안내 댓글 어디에도 싣지 않는다(공개 렌더러에 받을 자리가 없다). 결정 17의 "게시 전에 고친다"는 고치기 차례(C31)가 만든다.
- **리뷰 App 설치 전제:** 안내 댓글은 리뷰 App이 변경 대상 저장소에 설치돼 있고 그 저장소가 리뷰 정책 저장소 목록(`review.repositories`)에 있어야 달린다. C26 포트가 이 목록으로만 토큰을 받기 때문이다. 없으면 그 차례만 `repository_denied`(설치가 없으면 토큰 발급 실패 코드)로 건너뛰고 게시는 막지 않는다. 2026-11-10 기준 리뷰 App은 조직에 선택 저장소로만 설치돼 있고 저장소 목록은 미확인이라, 운영 확인은 owner 확인 또는 C30의 설치 범위 넓히기 뒤로 미룬다.
- **기록은 새 표 둘(migration 025):** 확인할 것·남은 위험(`change_notes`)은 증거 묶음·승인 대상 표 모양(C25·C17 소유)을 바꾸지 않으려고 따로 뒀다. 승인 digest는 이 목록을 그린 본문에 묶이므로 별도 digest 칸이 필요 없다. 안내 댓글 전송 기록(`change_guidance`)은 게시 effect 표(`change_delivery_effects`, stage 순서·승인 생존 트리거)에 넣지 않았다. 그 표의 단계는 승인이 살아 있는 `publishing` 동안만 intent를 받고, 안내 댓글은 `proposed` 뒤의 일이라서다.
- **목록도 7일 원문 정리에 넣는다(#134 Codex P2):** 목록은 공개 검사 전에 저장되는 모델 글이라 내부 표식·비밀값 때문에 승인 준비가 막힌 변경에도 남는다. 그래서 T27·T31과 같은 기준(변경이 끝난 지 7일, `purgeExpiredChangeContent`의 같은 트랜잭션)으로 두 목록을 빈 배열로 비우고 원래 목록의 digest(`notes_sha256`)와 지운 시각만 남긴다. 사용자 결정(T27·T31)의 칸 목록에 이 칸을 더한 것이 아니라 같은 방식을 새 원문 칸에 적용한 구현 선택이다. migration 025의 UPDATE 거부 트리거는 이 정리 모양만 받는다(새 마이그레이션 번호를 쓰지 않는다).
- **diff 안 항목이 없으면 리뷰를 달지 않는다:** 본문만 있는 `COMMENT` 리뷰는 PR 설명과 같은 말이라 알림만 늘린다.
- **상한은 PR 리뷰와 같은 값:** 리뷰 정책 `publish.maxInlineComments`(운영 5)를 쓴다. 리뷰 정책이 없거나 게시가 닫혔으면(`publish: null`) 안내 댓글도 달지 않는다(`review_publish_closed`).
- **PR 설명의 경로 표시는 끝 100자:** C25 상한(경로 512바이트)대로 20개 항목이 모두 최대이면 본문 16,000자를 넘어 승인 준비가 막힌다. 줄 댓글은 실제 경로를 그대로 쓴다.
- **안내 댓글 글은 짧은 고정 머리말 + 항목 글:** 리뷰 본문은 "확인할 것과 남은 위험 중 바뀐 줄에 있는 것만 줄 댓글로 달았어요. 전체 목록은 PR 설명에 있어요."(수정 차례는 "나머지는 Discord 결과 요약에 있어요"), 줄 댓글은 `**확인할 것**`·`**남은 위험**` 머리에 항목 글이다. 말투는 owner 검토(C24 말투 표본)로 다시 본다.

## C31 게시 전 자체 리뷰 고치기 구현 선택 (2026-11-10)

"동료 봇 전환 (사용자 2026-11-09)" 17(자체 리뷰에서 찾은 문제는 게시 전에 고친다, 최대 2번)의 구현이다. 사용자 결정이 아니라 구현 선택이고 결정은 바꾸지 않았다. 계약은 [ARCHITECTURE](ARCHITECTURE.md) §16 "게시 전 고치기 차례(C31)", 시험은 [VERIFICATION](VERIFICATION.md) "C31 게시 전 자체 리뷰 고치기". `CHANGE_PR_ENABLED` 안의 흐름이고 동료 기능 스위치와는 별개다.

- **상한 2번은 기본값:** 코드 `CHANGE_SELF_FIX.maxRounds`와 DB `change_generations.fix_round` CHECK(0~2)가 같은 값이고 시험이 대조한다. 바꾸려면 둘을 함께 바꾸는 마이그레이션이 필요하다. DB까지 묶은 이유는 상한 무시를 코드 밖 쓰기도 못 하게 하려는 것이다.
- **차례 키 대신 "살아 있는 증거 = 마지막 차례":** 차례를 열 때 앞 차례의 리뷰·시험·artifact를 digest만 `change_fix_rounds`로 옮기고 살아 있는 자리를 비운다. 승인 대상·게시자·리뷰 입력·미리보기가 읽는 (change, generation) 자리를 그대로 두므로 그 파일들(C29·C27 자리)을 고치지 않고도 앞 차례 증거로 승인될 길이 없다. 게시 뒤 수정 차례(C27)는 이미 공개된 증거를 지울 수 없어 (change, generation, 차례) 키가 따로 필요하다. 그 키를 받을 자리는 `change_child_jobs.fix_round`와 `ChangeReviewService`의 차례별 리뷰 job 조회다.
- **고칠 대상:** 완전한 리뷰의 P0·P1만이다. 범위 부족(`incomplete`)은 코드 문제가 아니고, 리뷰 출력 자체의 비밀·내부 표식(`reviewer_output_restricted`)은 그 글을 작성 모델에 넘기지 않으려고 뺀다. P2·P3와 우선순위가 낮은 `data_exposure`만인 막힘은 고치지 않고 지금처럼 닫거나(막힘) 미리보기의 경고로 간다.
- **고치기 작성은 새 job·새 세션이고 base는 B 그대로:** 앞 차례 세션은 결과 저장 뒤 끝나 이어 쓸 수 없다. 원래 brief와 함께 그 차례를 연 리뷰의 P0·P1 발견을 자료로 넘긴다. 모델 지적 없이 코드가 정한 P0·P1(보호 경로·목표·인수 조건)은 고정 설명으로 더한다.
- **고치기가 실패하면 `review_blocked`:** 고치기 작성의 실패와 작업자가 요청을 받지 않은 경우는 새 사유를 만들지 않는다. 남은 문제는 앞 차례 리뷰의 것이라 그 사유가 맞다. 실제 사유는 `change_self_fix_failed` 로그에 남는다.
- **고치기 요청은 수정 차례 칸에 PR 번호 없이 싣는다(주 진행자 2026-11-10, 분해 불일치 수용):** C25의 수정 차례 칸 `amendment`는 `pullNumber`가 필수였고 지시문이 "PR #n의 브랜치 head 위에서", 자료를 "PR 리뷰·댓글"이라고 말해 게시 전 요청을 담지 못했다. 주 진행자가 이 티켓에 두 자리를 열었다: `src/task-contracts.ts` `AmendmentSchema.pullNumber`를 null도 받게 넓히고(칸 순서·숫자 값의 직렬화 그대로, 게시 뒤 수정 차례(C27)는 PR 번호 필수 의미 유지: `ChangeAmendmentInput.pullNumber`는 숫자), `src/executor-claude-task.ts`가 null일 때 게시 전 고치기 문장을 쓴다. 게시 서버는 고치기 차례에만 판 `change-v2`와 `amendment`(`pullNumber: null`, head=B, 지시 `SELF_FIX_INSTRUCTION`, 자료 `selfFixMaterials`)를 보낸다. 보통 작성의 시작 판은 C28 규칙(작업자 intake가 `change-v2`를 알리면 그 판)을 따르고, 고치기 시작 턴은 늘 `change-v2`다. 재개는 C28 규칙대로 시작 턴이 세션 `capabilities.instructions`에 남긴 판을 다시 보내므로, 고치기 세션이 질문이나 한도로 멈췄다 이어도 `change-v2`다(재개 때 작업자 알림은 보지 않는다).
- **배포 순서와 옛 작업자:** `supportsSelfFix()`는 작업자 intake가 `change-v2`를 말할 때만 참이다(C28의 새 세션 판 고르기 `startInstructions()`와 같은 근거를 쓴다). 운영 작업자(이미지 9b067e9)는 그 판을 말하지만 PR 번호 없는 요청을 400으로 거부하므로, 게시 서버만 먼저 배포되면 P0·P1 건은 차례를 하나 연 뒤 지금과 같은 `review_blocked`로 닫힌다(새 실패 모양 없음, 고치기 없음). 실제 고치기는 이 변경이 든 작업자 이미지가 배포된 뒤에 돈다. 순서는 게시 서버 → 작업자 이미지이고, 거꾸로 해도 옛 게시 서버는 null을 보내지 않아 새 작업자에서 지금과 같다.
- **확인할 것·남은 위험(C29 `change_notes`)도 마지막 차례 것:** 목록은 그 차례 작성 결과라 차례를 열 때 리뷰·시험·artifact와 함께 지우고(digest도 남기지 않는다. 앞 차례 목록은 PR에 실린 적이 없다), 다음 차례 결과의 목록을 새로 기록한다. 지우지 않으면 `recordChangeNotes`가 generation마다 처음 것만 두어 고치기 전 목록이 PR 본문·미리보기에 실린다. 지우기는 살아 있는 증거와 같은 삭제 가드(026)로 고치기 차례를 여는 트랜잭션만 할 수 있고, 7일 원문 정리는 UPDATE라 이 가드와 무관하다. 안내 댓글(`change_guidance`)은 게시 뒤 차례 기록이라 건드리지 않는다.
- **알림:** 차례 시작은 알리지 않는다. `review_blocked`로 닫히면 남은 P0·P1 제목을 최대 5개 싣는다. 리뷰 모델의 글이라 공개 검사를 지난 제목만 싣고 걸리면 코드로 바꾸며 조건·근거 원문은 싣지 않는다.

## C33 시험 거부 뒤 재조회 (2026-11-10)

T19 B5 EVENT-02 "게시 서버 둘이 같은 부모를 동시에 밀어도 모델·시험·PR이 하나다"의 결함 수정이다(사용자 2026-11-10 "그래 그렇게 진행해"). 동료 봇 명세의 AC가 아니고 봇 #85부터 있던 결함이다. 코드는 `src/change-verifier.ts`(`WorkerChangeVerification.run`)와 `src/claude-task-bridge.ts`(`verificationWorker`)다.

- **원인:** 작업자 capability claims에는 무작위 값이 없다(`TaskWorkerSigner.issue`: operation·job·lease·generation·본문 digest·`issued`(ms)·`expires`). nonce는 payload의 sha256이고 Ed25519 서명도 결정적이라, 게시 서버 둘이 같은 밀리초에 같은 `/v2/task/verify`를 서명하면 토큰이 같다. 작업자는 늦게 온 쪽을 재사용으로 보고 403으로 거부한다. 진 쪽은 거부를 로컬 `not_run` receipt로 굳혔고, 이긴 쪽 시험이 끝나기 전에 그 기록이 먼저 들어가 부모가 `verifying → blocked (verification_not_run)`으로 닫혔다. receipt가 command마다 하나라 이긴 쪽 `passed`는 `receipt_conflict`가 되어 같은 generation을 살릴 수 없었다. `verificationWorker`의 `expectedWorker: null` 재시도는 verify 요청 schema가 null을 받지 않아 보내기 전에 실패하는 죽은 경로였다. 재현율: main `9377c33`에서 기존 실제 PostgreSQL 시험 반복 55번 중 5번.
- **고른 방법(게시 서버만):** 거부는 "이 요청이 시작하지 않았다"는 증거일 뿐 "이 command가 시작하지 않았다"는 증거가 아니다. 그래서 `run`은 거부를 받으면 `/v2/task/verification`으로 그 command를 다시 묻는다. `running`·`done`이면 그 결과를 따른다(다른 게시 서버가 낸 시험). `absent`면 재조회가 답한 작업자 신원으로 verify를 **한 번만** 다시 보내고, 그것도 거부될 때만 `not_run`이다. 다시 보내는 이유는 둘이다. 이긴 쪽 요청이 아직 슬롯을 잡기 전이면 재조회가 `absent`로 답할 수 있고, 파드 교체로 instance가 바뀌어 `worker_mismatch`로 거부됐으면 새 신원이 있어야 시작할 수 있다. 작업자는 시작 기록(`O_EXCL`)과 슬롯으로 command마다 한 번만 돌리므로 다시 보내도 시험은 하나다. 재조회가 기한(`waitMs`, 표의 가장 긴 시한 + 60초)까지 닿지 않으면 시작 여부를 모르므로 기존 기한 규칙대로 `unknown`이다.
- **티켓 문구와 다른 점:** 티켓은 "물어도 모르면 확정하지 않고 다음 바퀴에 다시 본다"였다. 다음 바퀴로 던지면 레인 재시도(`guarded`)에 시도 상한이 없어 작업자가 닿지 않는 동안 변경을 끝없이 붙잡는다. 그래서 같은 호출 안에서 `pollMs`마다 다시 묻고 기존 기한에서 `unknown`으로 닫는다. 그 결과 작업자가 연결 전에 닿지 않는 경우(`TaskWorkerRejected`)도 예전처럼 즉시 `not_run`이 아니라 기한까지 다시 묻고 `unknown`이다.
- **`verificationWorker`:** `expectedWorker: null` 재시도를 `/v2/task/verification`에만 둔다. verify는 다시 보내지 않고 거부를 그대로 올려, 위 재조회가 지금 신원을 얻어 다시 보낸다(파드 교체 동작을 S1 시험으로 고정).
- **근본 수정을 미룬 이유:** 근본 수정은 capability claims에 무작위 nonce(jti)를 넣어 같은 요청이라도 서버마다 토큰이 다르게 하는 것이다. 그런데 `TaskCapabilitySchema`가 `strictObject`라 작업자가 새 칸을 먼저 받아들이도록 배포된 뒤에야 게시 서버가 보낼 수 있다. 순서가 바뀌면 모든 작업자 호출이 403이 된다. 작업자 배포 순서를 묶는 변경이라 이 티켓(게시 서버만) 밖에 둔다. 이 수정 뒤에도 같은 밀리초 충돌 자체는 남고(진 쪽이 재조회 한 번과 재전송 한 번을 더 쓴다), 같은 ms의 `/v2/task/verification` 폴링 충돌은 원래도 null 재시도로 통한다.
- **운영 영향:** 스위치 밖이다. 병합·배포 즉시 운영 변경 흐름(`CHANGE_PR_ENABLED`가 켜져 있을 때)의 시험 단계에 적용된다. 바뀌는 것은 verify가 거부됐을 때뿐이다. 작업자 계약·이미지는 그대로라 작업자를 함께 배포할 필요가 없다. 되돌리면 같은 밀리초 충돌과 파드 교체 때 다시 `verification_not_run`으로 닫힌다.

## C18 고정 문구 3: 변경·리뷰 알림·경보·세션 연결 (2026-11-10)

"동료 봇 전환 (사용자 2026-11-09)" 4(말투)·9(스위치)의 변경·리뷰 안내·경보·세션 연결 문구 자리와, C15·C28·C30에서 넘겨받은 동작 수정 넷이다. 사용자 결정이 아니라 구현 선택이고, 말의 자연스러움은 owner 검토(PR 설명의 바뀐 문구 표, C24 말투 표본)로 다시 본다. 시험·결과는 [VERIFICATION](VERIFICATION.md) "C18 고정 문구 3".

- **문구를 둔 자리:** 파일마다 표 하나다. 변경 명령·답 처리기 `CHANGE_TEXT`(`src/change-commands.ts`, 게시 버튼 응답 `PUBLISH_TEXT`는 C17 그대로), 변경 알림·미리보기 `CHANGE_NOTICE_TEXT`(`src/change-runtime.ts`), 실패 안내 꼬리 `changeRestart`·`changeNextGeneration`·`changeChildFailed`(`src/change-advice.ts`), 배포 관측 `DEPLOYMENT_TEXT`(`src/change-deployment.ts`), 알림 채널 리뷰 안내 `REVIEW_NOTICE_TEXT`(`src/review.ts`), 경보 중계 `ALERT_TEXT`(`src/alerts.ts`), 세션 연결 명령 `ATTACH_COMMAND_TEXT`(`src/external-task-commands.ts`, 키 버튼 경로 `SESSION_KEY_TEXT`는 C15 그대로), R08 턴 완료 알림 `EXTERNAL_NOTICE_TEXT`(`src/external-task-receiver.ts`). C09와 같이 항목마다 첫 인자가 스위치 값이고 분기는 그 값 하나뿐이라, 시험이 모든 항목을 같은 인자로 불러 '/' 이름을 검사한다.
- **두 판 규칙:** '/' 명령 이름을 안내하는 줄만 스위치로 고른다. 꺼짐 판은 지금의 '/' 안내를 해요체로만 바꿨고, 켜짐 판은 말로 하는 안내다. 미리보기 켜짐 판은 승인 명령 줄 대신 같은 글의 게시 승인 버튼("게시해 주세요")을 가리키고 digest를 옮겨 적게 하지 않는다. 변경 상태·세션 연결 목록은 "물어보면 알려 드릴게요", unknown 작업 해제는 C09와 같이 "`homelab bot` CLI"로 적는다. '/' 이름이 없는 줄(배포 관측, 리뷰 요약·미게시·공개 범위 막힘 안내, 경보, R08 알림, 변경 게시·막힘 알림)은 판이 하나이고 병합하면 바로 운영에 나간다. 입력 칸 이름(`label=`·`goal=`·`summary=on`)과 phase·사유 코드·SHA는 명령 이름이 아니라 두 판이 같다.
- **새 generation의 켜짐 판:** 말로 새 generation을 여는 제안 동작이 없다. 그래서 대체(superseded) 알림과 `text:next` 서식 안내의 켜짐 판은 "같은 내용을 다시 부탁하면 새 변경으로 받아요"라고 적는다. 없는 길을 안내하지 않으려는 것이다.
- **스위치를 읽는 곳:** 변경 명령·알림·답 처리기는 `Store.colleague`(C09)를 읽는다. 세션 연결 명령은 `Store`를 받지 않아 `ExternalTaskCommands` 넷째 인수 `colleague`(기본 `false`)를 더했고, `src/main.ts`가 `config.colleagueEnabled === true`를 넘기는 한 줄이다(README 5절 main.ts 행 규칙). `changeChildFailed`는 셋째 인수(기본 `false`)로 받고, `src/store.ts`(소유 C04)의 자식 실패 안내 한 줄이 `store.colleague`를 넘긴다(주 진행자 2026-11-10 허용, README 5절 store.ts 행의 문구 줄 규칙).
- **안전 문장은 그대로:** 경보 중계는 상태·건수만 싣고 원문을 게시하지 않았다고 말한다. Discord 리뷰 요약은 코드가 만든 숫자·리비전·고정 낱말만 싣고 "승인·병합 판단이 아니에요"를 남긴다. 미리보기에는 리뷰 자유문·시험 로그·요청 원문을 싣지 않는다(C29·C31 줄의 공개 검사도 그대로). 연결 키는 본인만 보는 키 응답(`seedMessage`) 밖에 싣지 않는다. R08 알림의 사용자 값은 코드 스팬 그대로이고 "결과를 제가 확인한 건 아니에요"로 끝난다.
- **C28 넘김(변경 답 안내 말투):** `ChangeAnswerGuard`의 서식·출처·공개 검사 안내를 해요체로 바꿨다. 공개 검사(`scanPublicText`)·출처 기록·막기 규칙과 사유 칸은 그대로다. 서식 안내의 켜짐 판은 `label=public | <답>` 꼴만 말하고 '/answer'를 말하지 않는다.
- **3a·3b 대화 신뢰 문맥과 출력 스키마(C15·C30 넘김):** `SPEECH_ACTIONS`(`src/bot-facts.ts`)에 "확인 없이 바로 시작하는 요청: PR 리뷰 요청"(대상은 owner 메시지의 PR 링크나 `<소유자>/<저장소>#<번호>`)을, `CHAT_REPLY_JSON_SCHEMA`(`src/chat-lane.ts`)의 `target` 설명에 같은 꼴과 세션 ID를, `content` 설명에 세션 연결 꼴(`claude`·`codex`, 동의하면 `summary=on`)을 더했다. 두 문자열은 작업자 안에서만 쓰인다: 작업자 요청 본문(`WorkerRequestV2Schema`)에 없고 capability digest는 요청 본문의 해시라 이 글을 재료로 하지 않으며, 작업자는 지시문 literal(`SYSTEM_INSTRUCTIONS_V2`)만 대조한다. 그래서 새 게시 서버 + 옛 작업자(9b067e9), 옛 게시 서버 + 새 작업자 모두 요청이 그대로 받아지고 대화가 깨지지 않는다. 대신 **효과는 이 변경이 든 작업자 이미지가 배포돼야 난다**(C23 sandbox PR의 이미지 교체와 같이 나가면 된다, 순서 제약 없음).
- **3c 리뷰 요청 최신성(C30 넘김):** `ReviewRequests`가 GitHub 조회(설치·저장소·PR·merge base)를 마친 뒤 리뷰를 접수하는 트랜잭션에서, 요청 키가 대화 작업이면 그 대화 행을 잠그고 최신성(`src/chat-currency.ts` `lockedChatJobCurrent`, 제안 처리의 `current()`와 같은 SQL)을 다시 본다. 그사이 owner가 같은 대화에 새 말을 보냈으면 리뷰를 만들지 않고 `ChatSuperseded`를 던지며, 제안 처리는 답 없이 제안을 `superseded`로 버린다(감사 `review_requested`의 outcome `superseded`). 포트 타입(`ReviewRequestPort`, `src/review-request.ts`)을 바꾸지 않으려고 결과 값 대신 예외로 알린다. 대화 작업이 아닌 키(시험의 직접 호출)는 검사하지 않는다.
- **3d "직접 답하기"(C28 넘김):** `pressChangeQuestion`이 다음 답 대상을 적기 전에 선택지 버튼(`answerIn`)과 같은 검사를 한다. 기한이 지났으면(만료 정리 전이라 `state='open'`이어도) "답할 기한이 지난 질문이라 답을 받지 않아요."(`CHANGE_QUESTION_TEXT.expired`), 작업이 답을 기다리지 않으면 "이미 답했거나 닫힌 질문이에요."로 본인에게만 답하고 대상을 적지 않는다. 질문 행·작업 상태는 바꾸지 않는다(정리는 기존 만료 경로).

## 동료 봇 전환 16 수정 요청 구현 선택 (C27, 2026-11-10)

"동료 봇 전환 (사용자 2026-11-09)" 16(PR 수정 반복)·9(스위치)·11(owner 호출)의 구현이다. 사용자 결정이 아니라 구현 선택이고 결정은 바꾸지 않았다. 계약은 [ARCHITECTURE](ARCHITECTURE.md) §16 "게시 뒤 수정 차례(C27)", 시험은 [VERIFICATION](VERIFICATION.md) "C27 수정 요청".

- **차례 모델: generation을 올리지 않고 (change, generation, round) 키를 더한다(티켓 할 일 1).** 브랜치·artifact·시험·리뷰·승인·effect가 (change, generation)에 묶여 있고 새 generation은 새 브랜치(`bot/change/<id>/g<n>`)에서 처음부터라 같은 PR 브랜치를 쓸 수 없다. C31의 "살아 있는 증거 = 마지막 차례"도 쓸 수 없다. 처음 게시의 증거는 승인 대상이 가리키고 이미 공개돼 지울 수 없다. 그래서 차례의 증거·effect는 새 표(`change_amendment_*`)에 두고 처음 게시의 표와 조건(살아 있는 승인)은 그대로 둔다. 차례 effect를 `change_delivery_effects`에 칸으로 더하지 않은 이유: 그 표의 키(change, generation, stage)를 쓰는 읽기가 게시자·명령·런타임에 여럿이라 한 표에 섞으면 처음 게시 경로가 차례 행을 읽을 수 있다. 대신 미해소 차례 effect를 새 generation·끝 상태 전이·보존 정리의 검사에 더했다.
- **상한 10번은 확정된 요청 수:** 대기열에 든 것과 실패한 차례도 센다. 실패한 차례를 빼면 같은 실패를 끝없이 되풀이할 수 있다. 코드 `CHANGE_AMENDMENT.maxRounds`와 DB `change_amendments.round` CHECK가 같은 값이다.
- **수정 요청 label은 `public`(티켓 할 일 4 판단):** 명세에 수정 요청의 label 문장이 없다. 결정 15(말로 한 변경 요청은 확인을 누르면 `label=public`으로 접수)와 같게 owner 원문(멘션 표기 제거)을 지시로 `public` 기록한다. 대신 첫 요청의 `scanBrief`처럼 지시에 공개하면 안 되는 값이 걸리면 확인 글을 만들지 않고 거절한다. 자료(PR 리뷰·댓글)는 공개 PR의 글이라 C25 자료 블록 label `public` 그대로다.
- **확인 글의 k와 자료 범위:** 확인 글을 만들 때 리뷰 App으로 그 PR의 리뷰·리뷰 댓글·대화 댓글을 읽어 본문이 빈 글(승인만 누른 리뷰 등)을 뺀 수를 k로 센다. 그 ID 묶음, 그 글들의 digest, PR head(마지막으로 확정한 수정 커밋, 없으면 처음 게시 head)를 제안 값 digest에 넣는다. 실행은 그 ID의 글만 다시 읽어 자료로 쓰고, 확인 뒤 달린 글은 다음 차례 몫이다(아래 "확인한 자료만 반영").
- **대상 고르기:** 모델 대상은 변경 ID나 PR 번호(`#n`·`n`·PR 링크)다. PR 번호는 이 스레드에서 owner가 낸 변경의 확정된 PR 번호와 대조한다. 남의 변경·다른 스레드는 존재를 알리지 않고 버리고, 병합·닫힌 PR·상한·아직 PR 없음은 확인 글 없이 거절 한 줄(`AMENDMENT_REQUEST_TEXT`)을 일반 답으로 단다. 이를 위해 C13 실행 줄 처리기의 `prepare`가 거절 한 줄을 돌려줄 수 있게 했다(기존 줄은 그대로).
- **확인 이벤트는 제안 ID:** 차례의 `event_id`는 `proposal:<제안 ID>`다. 제안은 한 번만 눌리므로 같은 요청이 두 번 들어가지 않는다.
- **owner 호출 둘을 더했다:** 수정 결과(커밋)와 수정 실패. 결정 11의 넷(작업 질문, 작업 완료·실패, 변경 미리보기, 변경 실패)에 이 둘을 더한다. 차례 시작은 알리지 않는다.
- **제안 동작 ID `change_amend`(주 진행자 2026-11-10 허용):** `PROPOSAL_RUN_ACTIONS` 끝에 한 줄 더했다. 목록은 작업자 안의 출력 스키마 enum에만 들어가 요청 본문·capability digest는 그대로다. 새 게시 서버 + 옛 작업자(운영 9b067e9)는 대화가 그대로이고 모델이 이 제안을 낼 수 없을 뿐이다. 옛 게시 서버 + 새 작업자는 모델이 `change_amend`를 내면 응답 검사(`ChatReplySchema`)에 걸려 그 대화가 실패하므로 게시 서버가 먼저다(C30과 같은 순서).
- **작업자 호환:** 수정 차례 요청은 C25 칸(PR 번호 있음)이라 운영 작업자 9b067e9도 받는다. 판 `change-v2`를 말하지 않는 작업자면 차례를 `worker_unsupported`로 닫는다.
- **조립 배선(주 진행자 2026-11-10 허용):** 티켓 파일 목록 밖이던 세 자리를 열었다. (1) `change-assembly.ts` `authorizeWrite`가 수정 차례 쓰기를 받되 게시 단계와 같은 강도로 좁힌다. 차례 effect 트리거와 뜻이 갈라지지 않게 같은 DB 함수(`change_amendment_may_send`)를 불러 판단한다(`ChangeStore.amendmentWritable`). 처음 게시 조건은 그대로다. (2) 같은 파일의 런타임 의존성·`changeCommandHandler`에 `discussion` 선택 인수. (3) `main.ts`는 리뷰 경로의 `discussion.read`를 넘기는 줄만이다(작성자 구분 칸은 자료로 쓰지 않아 writer 숫자 ID만 준다).
- **리뷰 경로가 없으면 거절 한 줄:** 수정 요청 처리기는 늘 있고, 읽기가 없거나 읽기에 실패하면 이 스레드에서 보이는 변경에 한해 "지금은 PR 리뷰·댓글을 읽을 수 없어서…"로 답한다. 버리면 모델 답만 "반영할게요"로 남아 아무 일 없는 것처럼 보인다(C30과 같은 이유). 남의 변경은 지금처럼 존재를 알리지 않고 버린다.
- **Codex 1차 리뷰 반영(2026-11-10):** (1) 실패 receipt 저장 직후 끊겨도 차례가 `running`에 남지 않게, 작성·시험 바퀴는 receipt 존재가 아니라 모든 필수 시험의 통과 여부로 끝맺는다. 저장된 실패가 있으면 뒤 시험을 돌리지 않는다. (2) PR 링크 대상은 저장소까지 대조하고 확인 글에 저장소를 보인다. 번호만 맞추면 같은 스레드의 다른 저장소 PR 브랜치에 커밋이 올라갈 수 있다. `#n`·`n`은 지금처럼 이 스레드의 가장 최근 변경이다. (3) 실패 전이는 claim 전 `pending` effect만 같은 트랜잭션에서 `not_sent`로 해소한다. 해소하지 않으면 트리거가 복귀를 막아 같은 실패만 되풀이하고 대기열이 멈춘다. 027 트리거는 바꾸지 않았다. (4) 안내 리뷰가 달리지 않고 끝나면(failed·skipped) 보내려던 항목도 요약에 싣는다. 이를 위해 C29 `GuidanceOutcome`에 선택 칸 `cleared` 하나를 더했다(처음 게시 경로는 읽지 않는다). (5) 수정 결과 알림 조회를 다른 런타임 조회처럼 커서로 돈다.
- **확인한 자료만 반영(Codex 보안 리뷰 P2, 주 진행자 2026-11-10 수용):** 확인 글을 만들 때 읽은 글마다 ID·종류·작성자·관계·위치·본문을 묶은 digest(`amendmentMaterialsDigest`, 작성 모델이 받는 칸 전부)를 제안 값에 넣고 확정된 차례의 `materials_digest`에 둔다. 차례를 시작할 때 같은 ID 묶음의 글을 다시 읽어 digest가 다르면(묶음 안 글이 고쳐졌거나 지워짐) 작업 claim·모델 호출 전에 `materials_changed`로 닫고 "확인한 뒤로 반영할 PR 리뷰·댓글이 고쳐지거나 지워졌어요" 한 줄로 owner를 부른다. 대기열에서 기다린 차례도 시작 때 같은 대조다. 이유: ID만 묶으면 확인 뒤 댓글 작성자가 같은 글을 고쳐 owner가 보지 않은 피드백을 같은 PR 브랜치 커밋으로 올릴 수 있다. 본문 원문은 DB에 새로 두지 않는다(원문 보존 규칙을 늘리지 않게 digest만). 확인 뒤 새로 달린 글은 묶음 밖이라 자료에 들지 않으므로 대조에서도 뺀다. 늘어난 글까지 실패로 닫으면 앞 차례가 커밋 뒤 단 안내 리뷰(C29) 때문에 대기열 차례가 늘 실패한다.

## C34 수정 요청 후속: 재시작 정리와 닫힌 PR 거절 (2026-11-10)

봇 #138(C27) Codex 3차 리뷰 P2 둘의 구현 선택이다. 사용자 결정은 바꾸지 않았다. 계약은 [ARCHITECTURE](ARCHITECTURE.md) §16 "게시 뒤 수정 차례(C27)"의 "재시작과 닫힌 PR(C34)", 시험은 [VERIFICATION](VERIFICATION.md) "C34 수정 요청 후속".

- **통과 뒤 정리는 작성·시험 바퀴가 잇는다(티켓 할 일 1):** 시험이 모두 통과한 차례에서 작성 세션이 아직 `running`이면 `amendLane`이 `finalize`를 부른다. 정리 바퀴(`childrenTick`)가 running 차례의 자식도 보게 넓히지 않은 이유: 그 바퀴는 "부모가 넘어간 자식"을 취소·버리는 곳이라 돌고 있는 차례의 작성 결과를 잘못 지울 수 있다. 시험 결과와 따로 세션 상태만 보므로 정리가 이미 끝났으면 아무것도 하지 않는다.
- **PR 상태는 PR 리뷰·댓글 읽기에 한 칸으로 싣는다(할 일 2, 확인 글 준비):** `PullDiscussion.open`을 더하고 `discussion.read`가 `GET pulls/{n}`(이미 허용된 경로, 같은 리뷰 App 읽기 토큰)을 먼저 읽는다. 병합 읽기 포트(`ChangeDeploymentPort.readMerge`)를 명령 처리기에 넘기려면 `change-assembly.ts`(C20 소유)의 `changeCommandHandler` 인수를 바꿔야 해서 티켓 파일 소유 안의 리뷰 App 읽기를 썼다. 명령 처리기와 런타임 모두 이미 이 읽기를 받으므로 `main.ts`·조립은 그대로다. 새 GitHub 경로·허용 경로 줄은 없다. 대가: 수정 요청 확인 글과 차례 시작 때 리뷰 App 읽기가 한 번씩 는다.
- **차례 열기 전 병합 읽기는 기존 병합 읽기를 앞당긴다(할 일 2, 런타임):** 열 차례가 기다리는 `proposed`에서만 `merge:` 주기를 건너뛰고 §16.1 `readMerge`를 먼저 부른다. 기다리는 차례가 없으면 주기·순서가 C27과 같다. 읽기 실패는 차례를 열지 않고 실패 간격으로 다시 본다(모르는 채 작성 모델을 돌리지 않는다). 차례를 열지 못한 채 남으면 병합 읽기(익명, 시간 60회)를 바퀴마다 하지 않게 `step` 슬롯을 병합 읽기 주기만큼 늦춘다.
- **거절 문구는 기존 것:** 병합·닫힘 모두 `AMENDMENT_REQUEST_TEXT.not_open`("이미 병합됐거나 닫힌 PR이라 고칠 수 없어요.")이다. 새 문구가 없다.

## C20 자리 비움 (2026-11-11)

"동료 봇 전환 (사용자 2026-11-09)" 5(💤)·7(Discord에는 자리 비움만)의 구현이다. 결정은 바꾸지 않았고, 아래는 구현 선택이다(사용자 결정 아님). 스위치 밖이라 병합하면 바로 운영에 나간다. 계약은 [ARCHITECTURE](ARCHITECTURE.md) §13 "자리 비움과 Gateway 상태 (C20)"·"상태 안내", 시험은 [VERIFICATION](VERIFICATION.md) "C20 자리 비움".

- **멈춤 판단은 C19 기록 + 대기 상태:** `model_pauses` 행이 있고 그 작업이 한도·인증 대기면 멈춤이다(결제 포함). Claude 작업 레인 토큰의 인증 만료는 대화가 계속 답하므로 빼서, 대화에 💤·한 줄이 붙고 곧바로 답하는 어긋남을 막았다(`Store.releaseScheduler`의 구분과 같다). C21 운영 알림은 이 경우도 센다(Telegram에는 간다). 비상 정지는 보지 않는다.
- **회차와 5분 유예(마이그레이션 없음):** 스레드마다 한 번을 outbox 멱등 키 `away:<채널>:<회차>`로 지킨다. 회차는 `controls`의 `model_away` 한 행이다. 재개 예약 루프가 30분마다 작업을 다시 돌릴 때 멈춤 기록이 잠깐 비므로, 유예 없이 회차를 닫으면 같은 멈춤이 재시도마다 새 회차가 되어 owner가 부를 때마다 한 줄이 또 나간다. 그래서 멈춤 기록이 5분(`AWAY_GRACE_MS`, C21 경보의 `keep_firing_for`와 같은 값) 비어야 닫는다. 대가: 풀린 뒤 5분 안에 다시 멈추면 같은 회차라 그 사이 한 줄을 받은 스레드에는 다시 나가지 않는다. Gateway 상태와 💤·한 줄의 "지금 멈춤인가"는 유예 없이 지금 기록을 본다.
- **대기 진입 안내와 owner 호출이 같은 키:** 멈춘 스레드는 대기 진입 때 한 줄을 받고, 그 스레드에서 다시 불러도 같은 키라 더 나가지 않는다. 바뀌는 기존 키: 대화 `waiting:<job>:<attempt>`, 작업 레인 `task-wait:`·`codex-wait:`(자리 비움일 때), PR 리뷰 `review-waiting:<job>`, 변경 리뷰 자식 `change-review-wait:` → 모두 `away:<채널>:<회차>`. 자리 비움이 아닌 대기(작업 레인 인증 만료)와 시도 한도에 닿아 이어서 할 수 없는 결제 멈춤은 작업별 키 그대로다.
- **안내에서 뺀 것:** 원인(한도·인증·결제), 시각, '/resume-model'·'/review-resume'·'/review-cancel' 이름, 작업 ID, PR 이름. 재개는 저절로 하고(C19) 원인은 Telegram(C21)이라 Discord 글로 할 일이 없다. 결제 멈춤은 저절로 재개하지 않지만 owner는 운영 알림으로 원인과 CLI 명령을 받는다. 문구 상수 `modelWaitAuth`·`modelWaitLimit`·`taskLimitPaused`·`taskAuthPaused`·`codexLimitPaused`·`codexAuthPaused`·`modelPauseResume`·`modelPauseFinal`은 쓰는 곳이 없어 지웠다. 이어서 할 수 없는 경우만 `awayFinal`("취소하고 새로 요청")을 둔다(스위치 밖이라 '/cancel' 이름 없이 두 판이 같다).
- **💤는 답할 때까지:** 멈춤이 풀려도 💤를 👀로 되돌리지 않고 답·실패·취소 확정이 지운다(명세 "답한 뒤 💤를 지운다"). 멈춤 중에 받은 메시지에도 👀는 지금처럼 수신 ACK가 달고(403/404 대체 글 규칙 유지), 동기화가 💤로 바꾼다. 반응 REST가 메시지마다 두 번 는다. 💤로 바꾸기는 회차 시작이 아니라 "지금 멈춤인가"를 따른다: 같은 회차 안에서 풀린 틈에 받은 메시지가 👀·⏳로 남지 않게 한다(봇 PR #141 Codex P2). 한 줄의 회차(스레드마다 한 번)는 그대로다.
- **Gateway 상태는 바뀐 때만, 연결마다 다시:** 15초 루프가 상태를 넘기고 세션은 바뀐 것만 보낸다. RESUME 뒤 Discord가 상태를 지키는지 문서에 없어 READY·RESUMED마다 멈춤 기록을 다시 읽어 보낸다. IDENTIFY의 `presence` 칸은 쓰지 않았다(IDENTIFY는 예약 창 안에서 보내야 해 그 자리에서 DB를 읽지 않는다). 대가: 새 IDENTIFY 직후 READY까지 잠깐 online으로 보일 수 있다.
- **넘김(C19, 봇 PR #126 Codex P2):** 작업 레인 `settle`이 대기가 아닌 응답(완료·질문·실패)에 실린 한도 칸을 트랜잭션 밖에서 `Store.observeRateLimit`으로 남긴다(실패는 로그 `task_rate_limit_record_failed`만). 이제 작업 레인에서 본 `allowed_warning`도 PR 리뷰를 미룬다. C19 "리뷰 미루기"의 "작업 레인 응답의 경고는 쓰지 않는다"는 이 판부터 바뀐다.

## C22 약관 재확인: 다른 구독 계정으로 바꾸기 (2026-11-11, owner 판단 대기)

"동료 봇 전환 (사용자 2026-11-09)" 8과 D-14 "변경(사용자 2026-11-09)"이 정한 "새 이용 정책 시행 뒤 구현을 시작할 때 다시 확인"의 결과다. 에이전트의 읽기이고 법적 판단이 아니다. **판단은 owner가 한다.**

**읽은 곳(2026-11-11):**

- 이용 정책 https://www.anthropic.com/legal/aup : 페이지 표시 "Effective Nov 12, 2026". 이 환경에서는 한국어 판이 왔다(영문 PDF는 글자를 뽑지 못했다). "범용 사용 표준 > 플랫폼을 남용하지 마세요" 아래 문장 그대로:
  - (여러 계정) "여러 계정 전반에서 악성 활동을 조직하거나, 여러 계정을 생성하여 탐지를 피하거나, 제품 가드레일을 우회하거나, 당사의 사용 정책을 기타 방법으로 위반하는 동일하거나 유사한 입력을 생성하는 행위"
  - (차단 회피) "신규 계정 생성, 기존 계정의 사용, 이전에 차단 당한 사람 또는 단체에게 접근 권한을 제공하는 등의 방법을 통해 차단을 우회하는 행위"
  - (제한 우회) "계정 가입 또는 로그인 절차를 우회하거나 모델에게 유해한 출력을 생성하도록 지시(예: 탈옥, 프롬프트 인젝션)하는 행위를 포함하여 Anthropic의 사전 승인 없이 제품 내에 설정된 기능, 제한 사항, 가드레일을 의도적으로 우회하거나 방해하는 행위"
  - (재판매·대리) "소비자 구독을 통해 요청을 처리하거나 사용 중인 제품이나 클라이언트를 왜곡하는 서비스를 포함해 허가되지 않은 수단을 통해 Claude를 재판매하거나, 대리하거나, 다른 방법으로 접근 권한을 제공하는 행위"
  - (에이전트) "추가 사용 사례 가이드라인": "에이전틱 사용 사례는 사용 정책을 준수해야 합니다." "사용자는 도구, 브라우저, 연결된 시스템을 통해 수행하는 작업을 포함해 자신이 구축하거나 배포하는 에이전트가 본 사용 정책을 준수하도록 할 책임이 있습니다."
- 개정 공지 https://www.anthropic.com/news/2026-usage-policy-update (Published Oct 8, 2026): "The updated policy takes effect on November 12."
- 에이전트 사용 안내 https://support.claude.com/en/articles/12005017-using-agents-according-to-our-usage-policy (March 16, 2026), "Do Not Use Agents to Engage in Scaled Abuse": "Create or manage multiple accounts to evade detection or circumvent platform safeguards".
- 구독 장기 토큰 https://code.claude.com/docs/en/authentication : `claude setup-token`은 브라우저 승인 뒤 토큰을 터미널에 출력하고 저장하지 않는다(직접 복사), 1년 추론 전용 토큰이다.

**읽기: 애매하다(금지로 확정되지 않았다).**

- 해석 A(허용): 문장들이 막는 것은 탐지 회피·가드레일 우회·차단 회피·악성 활동 조직이다. owner가 각자 값을 낸 자기 구독 계정 가운데 하나를 사람이 골라 쓰고, 봇은 한 번에 하나만 쓰며 스스로 바꾸지 않는다(D-14 조건 2·5). 사용 한도는 안전 가드레일이 아니라 요금제의 양이다.
- 해석 B(금지로 읽힐 수 있음): 사용 한도도 "제품 내에 설정된 … 제한 사항"이다. 한 구독이 한도에 닿았을 때 두 번째 구독으로 바꿔 같은 일을 이어 가는 것은 "여러 계정을 생성하여 … 제품 가드레일을 우회"나 "제한 사항을 의도적으로 우회"로 읽힐 수 있다. 계정 전환의 주 용도(운영 경보 문구의 할 일 3 "다른 구독 계정으로 바꾸기")가 바로 이 경우다.
- 같은 계정 안의 토큰 교체(만료 전 교체·유출 뒤 재발급): 위 문장 어디에도 닿지 않는다. 허용으로 읽었다.
- API 크레딧 방식(C23): Console 키로 값을 내는 경로라 위 문장에 닿지 않는다. 명세 §8의 "허용된 유료 경로" 그대로다.
- 따로 적어 둘 것: 재판매·대리 문장의 "소비자 구독을 통해 요청을 처리하는 … 서비스"는 계정 전환이 아니라 봇이 구독 토큰으로 도는 구조 자체(D-14 변경, 사용자 2026-10-30)에 닿을 수 있는 문장이다. 봇은 owner 한 사람이 자기 일에 쓰고 남에게 접근을 주지 않는다. 이 티켓 범위 밖이지만 owner가 함께 본다.

**처리:** 사용자 결정 "정책으로 확인이 안 되었으니 일단 제공"(동료 봇 전환 8)과 작업 계약(애매하면 값과 무관한 부분은 구현하고 판단을 기다림)에 따라 C22 코드는 모두 만들었다. `account add`·`use`는 같은 계정의 토큰 교체(rotate.md 3e)에도 쓰여 해석과 무관하게 필요하다. **다른 구독 계정을 실제로 등록해 전환할지, 경보 문구의 할 일 3을 남길지는 owner 판단 대기다.** 판단이 금지로 나면 homelab 경보 문구(`vmalert/rules/bot.yaml`)의 할 일 3과 명세 §4.7 "운영 알림"의 할 일 목록을 고치는 후속이 필요하다(이 티켓은 그 파일을 고치지 않았다).

## C22 계정 등록·전환과 토큰 만료 알림 (2026-11-11)

명세 §4.7 "토큰 만료 알림", §4.8 "계정 등록"·"계정 전환"·"계정 목록"의 구현이다(구독 방식만, API 크레딧은 C23). 사용자 결정은 바꾸지 않았고 아래는 구현 선택이다. 약관 재확인은 바로 위 절, 시험은 [VERIFICATION](VERIFICATION.md) "C22 계정 등록·전환", 자격 배치는 [ARCHITECTURE](ARCHITECTURE.md) §5, 지표는 §13 "지표".

- **계정 기록(`migrations/028_model_accounts.sql`, `src/model-accounts.ts`):** `model_accounts`의 키는 (이름, 방식)이다(한 계정이 구독·API 둘을 가질 수 있다). 이름은 `^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$`(DB CHECK, 진입점, homelab CLI 같은 규칙. Infisical 폴더 이름 조각이자 지표 라벨 값). 지금 계정은 부분 유일 인덱스로 하나다. 값 칸은 없다. 발급일은 CLI가 토큰을 저장한 직후 진입점이 적은 시각이고, 같은 계정을 `--replace`로 다시 등록하면 발급일만 새로 한다. CLI 밖에서 바꾼 토큰의 발급일은 모른다(AC-19의 못 잡는 범위).
- **관리 진입점 동작(`src/admin.ts`):** `account record <이름> subscription`(결과 `recorded`), `account use <이름> subscription`(`switched`, 등록 안 됨 `unknown_account` 종료 3), `account list`(`accounts`). 셋 다 DATABASE_URL만 읽고 모델·작업자·정책을 읽지 않는다. 감사 행위자는 `cli`이고 `admin_command` detail에 계정 이름·방식을 더한다(목록은 감사하지 않는다, 상태 보기와 같다). `api`는 사용법 오류다(C23).
- **전환 뒤 해제(`switchAccount`):** 지금 표시를 옮기고 같은 트랜잭션에서 모델 멈춤 작업을 모두 C19의 같은 해제 전이(`Store.resumeWaiting`)로 되돌린다. 대화·작업은 `Store.adminResumeJob`(C32), PR 리뷰는 `'/review-resume'`과 같은 리뷰 제어(`Store.control` `review-resume`, 리뷰 권한 확인 true. 권한의 근거는 클러스터 접근)다. **결제 멈춤도 해제한다**(C21 넘김 1): 재시도 시각이 없어 예약 루프가 고르지 않는 멈춤이라 owner의 전환이 유일한 해제 길이다. 같은 계정으로 다시 `use`하면 표시는 그대로 두고 해제만 한다. 그래서 결제 원인을 같은 계정에서 푼 owner도 `homelab bot account use <지금 계정>`으로 푼다. 비상 정지 중이면 표시만 바꾸고 해제하지 않으며(`held: emergency_stopped`), 큐가 차면 거기서 멈춘다(`held: queue_full`, 남은 한도·인증 대기는 예약 루프가 30분 안에 다시 본다). 결과에 해제 수·아직 대기 수를 싣는다. 해제는 homelab CLI가 작업자 반영(지문)을 확인한 뒤에만 부른다(아래).
- **한도 관측은 계정을 따라간다(주 진행자 확인이 필요한 선택):** 계정이 바뀌면 `model_limit_state`(C19, 지금 계정의 마지막 한도 관측과 리뷰 미루기 기한)를 옛 계정 행의 `last_*`로 옮기고 비운다. 그래서 목록이 계정마다 마지막 사용률을 보이고, 새 계정은 리뷰 미루기 없이 시작한다. 옛 계정의 경고로 새 계정의 리뷰까지 미루면 전환한 이유가 사라진다. 처음 고르는 계정(그 전 지금 계정 없음)도 관측을 비운다(그 관측이 어느 토큰 것인지 모른다).
- **전환 전에 시작한 실행의 관측은 버린다(Codex 1차 리뷰 반영):** 작업자는 실행을 시작할 때 자격 파일을 읽으므로, 전환 전에 시작해 전환 뒤 끝난 대화·리뷰·작업 실행은 옛 계정으로 돌았을 수 있다. 그 실행의 `allowed_warning`이 새 계정의 사용률이 되고 새 계정의 PR 리뷰를 옛 계정의 풀리는 시각까지 미루면 안 된다. 그래서 `model_accounts.switched_at`(마지막으로 지금 계정이 된 시각, migration 028 안)을 두고, 관측을 적는 한 자리 `Store.observeRateLimit(rateLimit, job)`가 그 실행의 `jobs.started_at`이 지금 계정의 `switched_at` 이하이면 `model_limit_state`에 적지 않는다(같은 밀리초는 순서를 몰라 버린다). 전환 직전에 시작해 이미 새 자격을 읽은 실행의 관측도 함께 버리는 보수적 판단이다. 멈춤 기록(`model_pauses`)과 재개는 그대로라, 옛 자격으로 멈춘 작업은 전환 해제가 지나간 뒤라도 30분 재시도로 새 자격에서 다시 돈다. 대기 경로(`recordPause`)는 이미 job을 알고, 대기가 아닌 결과의 관측 두 곳(`src/runtime.ts` 대화, `src/review.ts` 리뷰)은 호출에 `job.id` 인자 하나만 더했다. 버린 대안: (1) 호출부를 그대로 두고 "전환 전에 시작해 아직 도는 실행이 있으면 모든 관측을 버림": 작업 레인 실행이 몇 시간 도는 동안 새 계정의 경고까지 버려 리뷰 미루기가 늦는다. (2) 계정마다 한도 상태 행을 두기: 실행이 어느 자격으로 돌았는지는 결국 시각 비교로만 알고, `reviewDeferredUntil`·C19 지표·목록 쿼리가 함께 바뀐다. (3) 작업자 응답에 자격 지문을 싣기: 세 작업자 계약 변경이라 이 티켓 범위를 넘는다.
- **잠금 순서(Codex 1차 리뷰 반영):** `switchAccount`는 scheduler 행을 가장 먼저 잡고 그 뒤에 계정 행·`model_limit_state`를 고친다. 모델 대기(`Store.waitForUser`)가 scheduler → `model_limit_state` 순서라, 거꾸로 잡으면 서로 기다리다 한쪽이 잠금 시간 제한으로 되돌려진다. 전환이 되돌려지면 작업자 자격은 이미 바뀌었는데 DB의 지금 계정과 해제가 옛 상태로 남는다. 관측의 계정 확인(`model_accounts` 읽기)은 잠그지 않는 SELECT라 순서에 끼지 않는다.
- **돌아온 지금 계정의 목록 값:** A → B → A처럼 지금 계정이 되었는데 그 뒤 관측이 아직 없으면 목록은 그 계정에 옮겨 둔 `last_*`를 보인다. 표시만이고 리뷰 미루기 기한은 되살리지 않는다(옛 관측이라 지금 창과 맞는지 모른다).
- **목록(C21 넘김 1):** 이름·방식·지금 계정·발급일·만료일(발급 뒤 달력 1년, 구독만)·마지막 한도 관측(상태·종류·사용률·풀리는 시각·관측 시각)과 종류별 모델 멈춤 작업 수(`paused`)를 낸다. 작업 ID는 싣지 않았다. 멈춘 일은 전환·같은 계정 재전환이 한꺼번에 풀고, 하나씩 풀 일은 `homelab bot resume <작업 ID>`(C32)가 이미 있다.
- **토큰 만료 줄(`src/briefing.ts`):** CLI로 등록한 구독 토큰마다(지금 쓰지 않는 계정 포함, 바꿔 쓸 수 있어야 하므로) 만료까지 30일 이하이면 `BRIEFING_TEXT.tokenExpiring`("Claude 토큰(<이름>)이 N일 뒤 만료돼요.", N은 남은 시간을 일로 내림, 0이면 "하루 안에"), 지났으면 `tokenExpired`. 30일보다 많이 남으면 줄이 없다. 브리핑 모델 칸(`modelLines`)에 둔다.
- **지표(`src/ops-metrics.ts`):** `homelab_bot_model_account{account,method}`를 지금 계정 행으로 채운다. 지금 계정이 없으면 C21 그대로 `{method="none"}`. 같은 쿼리에 한 줄을 더해 왕복이 늘지 않는다. homelab 경보 규칙(`max by (account, method)`, `none`→미등록, `api`→API 크레딧, 그 밖→구독)과 라벨 이름·값이 같다(시험).
- **homelab CLI(C21 넘김 2):** 명령 이름은 경보 문구 그대로 `homelab bot account add|use|list`다. `--by`는 값 `subscription`·`api`를 받되 `api`는 "아직 없다"는 사용법 오류(64)로 아무것도 읽지 않는다(C23이 연다).
- **계정 폴더:** 값은 Infisical `/bot-accounts/<이름>`의 `CLAUDE_CODE_OAUTH_TOKEN`(대화·리뷰)·`CLAUDE_CODE_OAUTH_TOKEN_TASK`(작업)다. 작업자 store `infisical-sandbox`는 `secretsPath: /apps/homelab-bot/worker`에 키를 하나씩 적는 ExternalSecret만 쓰고, 봇 앱 ExternalSecret(`platform/charts/app` `externalsecret.yaml`)은 store `infisical-apps`(`/apps`)에서 values `secrets` 목록의 `homelab-bot/<KEY>`를 하나씩 읽는다(재귀·`find`가 없다, 2026-11-11 코드 확인). 그래서 `/apps` 밖의 이 폴더를 읽는 ExternalSecret은 없다. Free 플랜은 경로 RBAC가 없어 secretsPath가 보안 경계는 아니다(homelab `platform/external-secrets` 머리 주석). 경계는 ExternalSecret이 Git PR로만 생긴다는 것이다.
- **전환 순서(homelab `bot-account-use.ts`):** 계정 폴더 두 값 확인 → 봇 DB 기록 확인 → 두 값을 작업자 키로(둘 다 읽은 뒤 쓴다) → 두 ExternalSecret 즉시 동기화와 Secret 해시 확인 → 두 작업자 파드의 자격 파일 지문 확인(`kubectl exec deploy/worker|worker-task -c worker -- sha256sum`, exec 실패는 기다림의 일부라 기한 180초 안에서 다시 본다. `worker-task`의 exec가 정리 sweep에 죽는 함정) → 진입점 `account use`. 엔진이 실패한 단계에서 멈추므로 반영 전에는 해제하지 않는다. 기다림 합은 동기화 60초·Secret 90초·볼륨 180초가 상한이고 보통 kubelet 갱신 1분 안팎이라 "대략 2분" 안이다(실측은 S5).
- **`setup-token` 출력 수집: 하지 않는다(미확인으로 남김).** `claude setup-token --help`(로컬 2.1.322)에 출력 선택지가 없고, 공식 문서는 토큰을 터미널에 출력한다고만 적고 꼴을 정하지 않는다. 그래서 CLI는 tty에서 레인마다 `claude setup-token`을 띄우고(core `exec`의 이 argv 하나만 예외) 토큰은 에코 없는 입력으로 받는다. 자식 stdout은 stderr로 보낸다(`stdout-to-stderr`만 허용): stdout은 결과 문서 하나라 `--json >파일`에 안내와 발급 토큰이 섞이면 안 된다. stderr가 터미널이 아니면 토큰이 그 파일·파이프에 남으므로 로그인을 띄우지 않고 아무것도 쓰기 전에 실패한다(종료 1. 64 사용법 오류로 하려면 실행 문맥에 stderr tty 여부를 넘기는 `main.ts`·`runtime.ts` 변경이 필요해 하지 않았다). 파이프면 stdin 두 줄이다. 두 값이 같으면 거부한다(레인 분리). 남는 위험: 토큰이 owner 터미널 스크롤에 한 번 남는다(안내에 지우라고 적었다).
- **하지 않은 것(사람 단계, 티켓 할 일 10):** 실토큰 등록, 운영 전환 1회, approvals.md 기록, 봇 구독 계정이 owner 개인 사용과 같은 계정인지(명세 §8, 미확인) 묻기.

## C23 API 크레딧 방식 (2026-11-11)

"동료 봇 전환 (사용자 2026-11-09)" 8의 API 크레딧 방식과 명세 §4.8 "API 크레딧 방식"·AC-22의 구현이다. 사용자 결정은 바꾸지 않았고 아래는 구현 선택이다. 시험은 [VERIFICATION](VERIFICATION.md) "C23 API 크레딧 방식", 자격 배치는 [ARCHITECTURE](ARCHITECTURE.md) §5.

**키 이름과 방식 표시(sandbox 배포 PR과 homelab CLI가 이 이름을 그대로 쓴다).** Infisical 프로젝트 homelab, 환경 prod.

| 폴더 | Infisical 키 | 값 | 작업자 Secret 키(= 파일 이름) |
|---|---|---|---|
| `/apps/homelab-bot/worker` | `CLAUDE_AUTH_METHOD` | 방식 표시 `subscription` 또는 `api`(비밀 아님). 두 레인이 이 키 하나를 함께 읽는다 | 두 Secret 모두 `CLAUDE_AUTH_METHOD` |
| | `CLAUDE_CODE_OAUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN_TASK` | 대화·리뷰 / 작업 레인 구독 토큰(지금 그대로), 안 쓰면 `unset` | `CLAUDE_CODE_OAUTH_TOKEN`(작업 Secret은 `_TASK`를 이 이름으로) |
| | `ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY_TASK` | 대화·리뷰 / 작업 레인 Console API 키, 안 쓰면 `unset` | `ANTHROPIC_API_KEY`(작업 Secret은 `_TASK`를 이 이름으로) |
| `/bot-accounts/<이름>` | `ANTHROPIC_API_KEY`, `ANTHROPIC_API_KEY_TASK` | 계정의 두 레인 API 키(`homelab bot account add --by api`). 구독 토큰 두 키는 C22 그대로 | 없음(작업자가 읽지 않는다) |

- 방식 표시 값 글자는 봇 DB `model_accounts.method`·지표 `homelab_bot_model_account{method}` 값과 같다(`none`은 지표에만, "계정 없음"). 기본값은 지금과 같은 구독이다: 표시 키가 없으면 구독으로 본다(아래).
- 안 쓰는 방식의 작업자 키는 지우지 않고 값 `unset`(자리 표시값)으로 둔다. ExternalSecret은 적힌 키가 Infisical에 모두 있어야 Ready라, 키를 지우면 Degraded로 root가 sandbox wave에서 멈춘다. 작업자는 `unset`을 "자격 없음"(`credential_missing`)으로 읽는다. 작업자 Secret 이름(`worker-credential-claude-subscription` 등)과 `WORKER_CREDENTIAL_KEY=CLAUDE_CODE_OAUTH_TOKEN`·프로필 이름 `claude-subscription`은 바꾸지 않는다(sandbox values·schema `const`와 호환).
- sandbox 배포 PR(할 일 6) 전제: 병합 전에 Infisical에 `CLAUDE_AUTH_METHOD`(=`subscription`)·`ANTHROPIC_API_KEY`·`ANTHROPIC_API_KEY_TASK`(=`unset`)가 있어야 한다. `homelab bot account use <지금 계정> --apply`를 한 번 치면 셋이 생긴다(구독 전환도 방식 표시와 `unset`을 쓴다). 이 값들은 16자 미만이라 `homelab secret set`(시크릿 입력 16자 하한)으로는 넣을 수 없다.

**"표시가 없으면 실행하지 않는다"(할 일 2)와 "기본값은 지금과 같은 구독"(티켓 목표)이 부딪힌 곳: 표시가 없으면 구독으로 본다(분해 불일치로 보고).** 비교한 두 안:

1. 표시가 없으면 실행하지 않고, sandbox PR 병합 전에 Infisical에 표시 키를 먼저 넣는 순서로 푼다: 봇 이미지 digest만 먼저 올리는 PR, 복구 스위치(`externalSecrets.enabled: false`)로 손 Secret을 토큰 하나만 만든 복원(restore.md 3.1), 키를 하나 빠뜨린 손 실수 모두에서 작업자가 모든 실행을 거부해 봇 전체가 멈춘다. 새 작업자 + 표시 없는 지금 Secret 조합이 지금처럼 구독으로 돌아야 한다는 호환 조건도 깨진다.
2. **(채택)** 표시 파일이 없으면 구독이다. 표시가 있는데 모르는 값이면 실행하지 않는다(`credential_method_invalid`). 표시한 방식의 자격이 없거나 `unset`인데 다른 방식의 자격이 있으면 실행하지 않는다(`credential_method_mismatch`). 그래서 표시가 없고 API 키만 있는 경우도 API 키로 몰래 돌지 않고 거부된다. 할 일 2가 막으려던 "다른 방식의 자격으로 도는 것"은 그대로 막히고, 잃는 것은 "표시 키 누락을 실행 거부로 알아채는 것"뿐이다(그때도 구독 토큰으로 돌 뿐이라 지금 동작과 같다).

**실행마다 방식 고르기(`src/credentials.ts` `MethodEnvCredential`, `src/executor-profiles.ts` `methods`·`staticCredential`).** 방식은 기동 env가 아니라 Secret 볼륨의 방식 표시 파일이 고른다(전환이 파드 재시작 없이 다음 실행부터 반영돼야 한다). 자격은 실행 준비 때마다 표시 → 그 방식의 자격 → 다른 방식의 자격 순으로 다시 읽고 `RunCredential.method`를 싣는다. Claude 어댑터(대화·리뷰 `ClaudeChatAdapter`, 작업 `ClaudeTaskAdapter`)는 `start`에서 그 방식으로 자격 변수 이름(`CLAUDE_CODE_OAUTH_TOKEN` 또는 `ANTHROPIC_API_KEY`)과 init `apiKeySource` 기대값(`none` 또는 `ANTHROPIC_API_KEY`)을 고른다. 어댑터의 `credentialEnv`·`envNames`는 그 실행의 값을 돌려주는 getter라, 공통부(`RunControl`, 바꾸지 않음)가 `start` 직후 하는 env 허용 목록 검사가 "자격 변수는 그 실행의 것 하나"를 강제한다. 다른 방식의 변수가 끼면 띄우지 않는다. 반사·유출 검사에는 읽을 수 있는 두 방식의 자격을 모두 쓴다. 작업 레인의 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` 목록에 `ANTHROPIC_API_KEY`가 들어 있다 [확인: 2.1.308 바이너리]. 버린 대안: (1) API 키 프로필 줄을 따로 두고 기동 env로 고르기: 전환마다 sandbox PR과 파드 재시작이 든다. (2) 공통부 `assertLaunchSafe`에 "자격 변수 정확히 하나" 검사를 더하기: `run-control.ts`는 이 티켓 소유가 아니고, getter로 같은 효과가 난다.

**`--bare`와 금지 플래그 재검토 결론: 바꾸지 않는다.** `--bare`는 두 방식 모두 쓰지 않고 `CLAUDE_FORBIDDEN_FLAGS`에 그대로 둔다. bare는 OAuth를 읽지 않아(2.1.308 `--help` "strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never read)") 구독에는 못 쓰고, API 방식에만 쓰면 방식마다 argv가 갈려 검증한 argv 하나(`claudeArgs`)가 둘이 된다. 비대화 실행은 bare 없이도 env의 `ANTHROPIC_API_KEY`를 쓰고 출처를 `ANTHROPIC_API_KEY`로 알린다 [확인: 2.1.308 바이너리의 자격 출처 함수, SDK init `apiKeySource` enum]. bare가 끄는 사용자 지정(hooks·plugins·CLAUDE.md 등)은 이미 `--safe-mode`·빈 `CLAUDE_CONFIG_DIR`·init 검사가 끈다. `apiKeyHelper`를 여는 `--settings`도 계속 금지다(리뷰 레인의 고정 인라인 JSON만 예외).

**크레딧 소진 분류(`classifyClaudeError`).** 결제 구분이 작업자 응답에 실리는 방식은 C19 그대로다(`rateLimit.stop.cause === 'billing'`, 저절로 재개하지 않음, 경보 `HomelabBotModelPausedBilling`). 모양 근거: API는 소진을 400 `invalid_request_error`("Your credit balance is too low to access the Anthropic API…")로 주고 CLI가 이 문구를 error `billing_error`로 바꾼다 [확인: 봇 이미지 고정 2.1.308 바이너리, 로컬 2.1.319·2.1.322도 같음]. 공식 오류 문서(platform.claude.com/docs/en/api/errors, 2026-11-11)는 402 `billing_error`, 400(조직·workspace 지출 한도), 429(분당 한도와 사용 등급 월 지출 상한·Claude Code workspace 지출 한도)를 적고 선불 크레딧 소진의 모양은 적지 않는다. 그래서 확인하지 못한 모양은 결제 쪽으로 닫는다: (1) 서버 오류 식별자(`api_error`·`api_error_code`)가 `billing`·`credit`·`spend` 단어를 담으면 종류와 무관하게 결제, (2) API 방식의 한도(`rate_limit` 종류·429)는 결제. 짧은 429는 CLI가 안에서 다시 시도한 뒤라 여기 온 429는 오래 가는 상한일 수 있고, API 방식에는 풀리는 시각(`rate_limit_event`)이 없어 한도로 두면 30분마다 헛돈다. 대가: API 방식의 진짜 분당 한도도 owner가 `account use`로 풀어야 한다. 구독 방식의 분류는 그대로다. 본문 문구("credit balance")는 보지 않는다(모델 답에 실릴 수 있어서, 기존 원칙).

**egress.** API 방식도 모델 요청은 `api.anthropic.com:443`이다 [가정: 공식 네트워크 문서의 필수 호스트, 구독 OAuth 갱신 호스트는 API 키에 필요 없음]. 실제 확인은 S5(C24)다. 프록시 허용 목록은 이 티켓이 바꾸지 않았다.

**관리 진입점.** `account record|use <이름> api`를 받는다(`src/admin.ts`). API 계정은 발급일·만료일이 없어 토큰 만료 줄이 없다(C22 그대로). 등록하지 않은 방식으로 `use`하면 `unknown_account`(종료 3)다.

**homelab CLI 순서(자격 둘을 두지 않기).** `account use --by <방식>`은 작업자 키를 그 방식의 두 값 → 방식 표시 → 다른 방식 두 키 `unset` 순서로 쓴다. 어느 순간에 멈춰도 표시는 자격이 있는 방식을 가리켜 작업자가 불일치로 거부하는 틈이 없고, 다 쓴 뒤에는 작업자 키에 자격이 하나뿐이다. 반대 순서(옛 자격부터 비우기)는 중간에 멈추면 봇 전체가 불일치로 멈춰 버렸다. 그 뒤는 C22 순서(즉시 동기화 → Secret 해시·표시 → 볼륨 지문·표시 → 해제)다. 구독은 방식 표시 파일이 없어도 반영으로 본다(sandbox 배포 전 Secret). 방식 표시·`unset`은 비밀이 아닌 고정 값이라 core의 `setMarker`(값 셋만)로 쓴다.

**C22 넘김(할 일 4a, `Store.observeRateLimit`).** "이 실행이 계정 전환보다 먼저 시작했는가" 확인과 `model_limit_state` 쓰기를 전환과 같은 scheduler 행 잠금 아래 한 트랜잭션에서 한다. 트랜잭션 밖 호출(대화 `runtime.ts`, 리뷰 `review.ts`, 작업 `claude-task-bridge.ts` `settle` 뒤)은 스스로 트랜잭션을 열어 scheduler를 먼저 잡고, 대기 경로(`recordPause`)는 이미 scheduler를 쥔 트랜잭션을 넘긴다. 잠금 순서는 scheduler → `model_limit_state` 그대로다. `settle`은 자기 트랜잭션(작업 제어·job 행)을 끝낸 뒤에 관측을 부르므로 잡은 잠금이 없어 순환하지 않는다.

**남는 위험.**

- 방식 표시와 자격 파일은 따로 읽는다. kubelet의 볼륨 교체와 엇갈리면 그 실행 하나가 불일치로 거부될 수 있다(다른 방식으로 돌지는 않는다). CLI는 자격을 쓰고 동기화를 한 번에 하므로 보통 Secret 한 판에 함께 바뀐다.
- 불일치·표시 오류의 사유 코드는 자격 오류(`WorkerStartError.code`)에 있고, 실행 중에는 공통부가 그 실행을 `failed`(띄우지 않음)로 닫으며 readiness가 503이 된다. 실행마다 사유 코드를 로그 줄로 남기는 것은 공통부(`run-control.ts`) 변경이라 하지 않았다. 기동 때는 `worker_start_failed` 사유로 남는다.
- API 방식의 진짜 분당 한도도 결제 멈춤이 된다(위 분류의 대가).

## C36 묶음 C: 문구·브리핑 (2026-11-11)

전체 리뷰 1차의 F-5·F-12·F-13 수정이다. "동료 봇 전환 (사용자 2026-11-09)" 7(Discord에는 자리 비움만)·9(스위치)를 브리핑·24시간 대기 안내·명령 수신 안내에 맞춘 구현 선택이고, 결정은 바꾸지 않았다. 시험은 [VERIFICATION](VERIFICATION.md) "C36 묶음 C".

- **브리핑의 모델 멈춤 줄(F-5):** 비상 정지와 모델 멈춤을 다른 줄로 나눴다. 비상 정지는 지금처럼 `BRIEFING_TEXT.modelStopped`(스위치 두 판, 꺼짐 `/model-status`·켜짐 `homelab bot` CLI)이고, 사유 칸에는 '비상 중지'만 들어간다. 모델 멈춤(한도·인증·결제 대기 작업이 있거나, 비상 정지 없이 scheduler가 닫힘)은 `BRIEFING_TEXT.modelAway` 한 줄("자리 비움 · 기다리는 일 n건은 돌아오면 이어서 해요")이고 스위치 밖이다. 원인 낱말과 '/' 이름이 없다. 그래서 위 "C10 고정 문구" 절의 "브리핑 모델 호출 중지 줄(`/model-status`)"은 이제 비상 정지 줄만 가리킨다. 둘이 겹치면 두 줄이 다 나온다. 미룬 PR 리뷰 건수(C19)·토큰 만료(C22) 줄은 그대로다.
- **작업 레인 줄의 대기 건수(F-5, 티켓 범위보다 한 칸 넓음):** 같은 브리핑의 작업 레인 줄 "한도·인증 대기 n건"도 원인을 알려 주므로 "모델 대기 n건"으로 바꿨다. 세는 행(`waiting_user` + `model_limit`·`auth_expired`)은 그대로다.
- **24시간 대기 안내(F-5, `CHAT_TASK_TEXT.modelWaitLong`):** "저절로 재개하거나 버리지 않아요"와 재개 명령(꺼짐 `/resume-model`, 켜짐 CLI 재개)을 뺐다. 재개는 재개 예약 루프(C19)가 하므로 owner가 정할 것은 세션을 계속 둘지뿐이다. 그만두는 길만 스위치로 고른다(꺼짐 `/cancel target:<작업>`, 켜짐 "작업을 취소해 달라고 말해 주세요"). 결제 멈춤도 같은 문구다(owner는 원인과 CLI 해제를 운영 알림으로 받는다).
- **명령 수신 안내(F-12, `src/discord.ts` `COMMAND_INGRESS_TEXT`):** `CHANGE_ACK_NOTICE`·`EXTERNAL_ACK_NOTICE` 상수와 변경·세션 연결 처리기 예외 답 리터럴을 이 표 하나로 옮겼다(키 `changeAckLost`·`changeFailed`·`attachAckLost`·`attachFailed`). 첫 인자가 `Store.colleague`인 C18 규칙 그대로라 `c18-fixed-text`의 표 검사가 함께 돈다. `changeFailed`는 `CHANGE_TEXT.transient`, 켜짐 `attachFailed`는 `SESSION_KEY_TEXT.failed`를 그대로 쓴다(같은 뜻의 문구를 두 벌 두지 않음). 꺼짐 판은 '/' 안내를 해요체로만 바꿨다.
- **주석(F-13):** `src/contracts.ts` `PROPOSAL_RUN_ACTIONS`의 이력 주석을 지금의 제약(동작 이름은 작업자 출력 스키마 enum에만 들어가 요청 본문·capability digest의 재료가 아님)으로 고쳐 썼다.
