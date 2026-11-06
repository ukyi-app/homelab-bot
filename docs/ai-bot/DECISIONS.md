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
- **DB의 삭제 표현:** 행은 남기되 진술·출처·범위·세부를 비운 `deleted` 행으로 바꾸고 검색 색인(`memory_terms`)을 지운다. 감사 기록에는 기억 내용을 넣지 않는다. 원본 Discord 메시지(`events`)는 기억 삭제로 지우지 않는다(출처 보존 기간 `retention.event_days`는 미정).
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
