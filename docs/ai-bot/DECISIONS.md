# DECISIONS: 봇 V1 DISCOVERY 결정 기록

> T16a 갱신(2026-10-19): 사용자 결정은 유지한다. 구현 선택은 [ARCHITECTURE §11](ARCHITECTURE.md#11-t16a-확정-계약과-로컬-구현-2026-10-19)에 기록했다. 방안 1(작업자에서 대화·작업 합산 직렬 1), Node 24 런타임, 5분 정책 freshness, 승인 질의 상한, Ed25519 제어 계약, 최근 5분 Gateway 연결 조건의 하트비트를 채택했다. DM 허용 여부·브리핑 시각은 2026-10-20 사용자가 정했다(아래 D-17).

- 단계: `TARGET=V1`, `STAGE=DISCOVERY`, `MODE=plan` (homelab 티켓 T15). 작성일 2026-10-18. 초안.
- **상태: D-14, D-15(남은 부분), D-16, D-17, D-24는 확정(사용자 2026-10-18, T15)이다.** 사용자가 2026-10-18 16:29 T15 질문에 답해 정했다. D-14는 에이전트 추천(B)이 아니라 A를 골랐다. D-15의 코드 읽기 축소는 에이전트 설명을 듣고 골랐다. 나머지는 에이전트 추천을 받아들였다. 결정 기록의 기준은 homelab spec §5.1이고, 이 문서는 선택지·근거·함께 지킬 조건을 남긴다.
- 확정된 결정 안에 남은 미정 세부는 새 결정 ID 없이 담당 티켓에서 정한다(spec §5.3): D-17의 DM 허용 여부와 브리핑 시각은 T16a(확정(사용자 2026-10-20): DM 끔, 브리핑 매일 08:50 Asia/Seoul), D-24의 토큰 분리·ruleset E 여부·App 이름·설치 저장소·허용 파일 경로는 T19.
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
| D-14 | 봇 모델 계정과 인증 | 봇 전용 ChatGPT 구독 계정 + 작업자 전용 CODEX_HOME, 함께 지킬 조건 다섯. 에이전트 추천(B, OpenAI API 프로젝트 키)과 다름 | OpenAI 확인 항목 셋 [미확인]. 공개 저장소 문구는 T17 차단 조건(허용 확인이나 공식 지원 인증 전환 전에는 공개 저장소 PR 내용으로 구독 모델을 부르지 않음. 모델을 부르지 않는 T17 로컬·mock 구현은 T16a 뒤 착수, 확정(사용자 2026-10-18, PR #3 리뷰)). T18도 같은 차단(확정(사용자 2026-10-18, PR #3 리뷰)). 계정 준비와 첫 시드: T16b 전(모델을 처음 쓰는 단계 전). 영속 쓰기 공간의 크기·백업(T08b) |
| D-15 | 실행 호스트, 라벨·포트, 코드 읽기 호스트 | NUC 클러스터 안. 라벨 `homelab-bot`, 앱·작업자 포트 8080, 경보 수신 포트 8081. 작업자 코드 읽기는 `codeload.github.com` 압축본만 | U13·U29와 프록시 경유 압축본 받기 실측(T08b·T16b) |
| D-16 | PR 리뷰 방식 | 기본안. 봇 리뷰 저장소의 Codex 자동 리뷰는 저장소별 설정에서 끔. Connector 설치는 선택 저장소로 줄이고 운영 저장소는 뺌(축소 완료, 사람 2026-10-18 17:45). 하위 결정: 허용 봇 작성자 목록 | 남긴 저장소 목록의 API 확인(사용자 보고만 있음). 리뷰 대상 저장소 목록과 리뷰 App 이름, 리뷰 App 권한 확인(Issues read 포함, 설계 세부)(T17) |
| D-17 | Discord 서버, 채널, 허용 사용자 | 봇 전용 개인 서버 신설, 허용 사용자 owner 1명, 채널 2개, `MESSAGE_CONTENT` 켬. DM 끔, 브리핑 매일 08:50 Asia/Seoul(확정(사용자 2026-10-20, T16a)) | 없음 |
| D-24 | 봇 변경 PR 작성 신원 | 봇 전용 쓰기 GitHub App(Contents·Pull requests write, Metadata read) | 토큰 분리, ruleset E 여부, App 이름, 설치 저장소, 허용 파일 경로(T19) |

---

## D-14 봇 모델 계정과 인증

**상태:** 확정(사용자 2026-10-18, T15). **A: 봇 전용 ChatGPT 구독 계정 + 작업자 전용 CODEX_HOME.** 에이전트 추천은 B(OpenAI API 전용 프로젝트 + 서비스 계정 키)였다. 사용자는 추천이 아닌 A를 골랐다. T17 차단 조건을 더했다(확정(사용자 2026-10-18, PR #3 리뷰), 아래 "차단 조건").

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

### 차단 조건 (확정(사용자 2026-10-18, PR #3 리뷰))

PR #3 리뷰에서 공개 저장소 문구를 남는 위험으로만 두면 지원되지 않는 인증 방식으로 공개 저장소 리뷰를 운영할 수 있다는 지적이 나왔고, 사용자가 "T17 전 차단 조건 추가"로 답했다.

- 조건: OpenAI가 공개 저장소 PR 리뷰에 봇 전용 구독 인증 사용을 허용한다고 확인했거나, API 키 등 공식 지원 인증으로 바꿨을 것.
- 범위: 모델을 부르지 않는 로컬·mock 구현은 T16a 뒤 착수할 수 있다. 공개 저장소 PR 내용으로 구독 모델을 부르는 일(평가셋, `authorized_external`, 시범 P-2)은 차단 조건이 풀린 뒤에만 한다.
- 그 전 단계(T16a·T16b, 대화 레인)는 그대로 진행한다.
- 인증 전환은 D-14 변경이라 사용자 결정과 설계 C.8 검토가 필요하다.
- T18 범위: T18도 같은 차단을 받는다(확정(사용자 2026-10-18, PR #3 리뷰)): 허용 확인이나 공식 지원 인증 전환 전에는 공개 저장소 코드로 구독 모델을 부르는 T18 작업을 하지 않고, 모델을 부르지 않는 로컬·mock 구현만 T16a 뒤 착수한다. T19는 T17 뒤라 함께 기다린다.
- 반영 자리: [V1_PLAN.md](V1_PLAN.md) 머리말·§1·§2 T17 진입 조건·§3 REVIEW-01·§4 시범 운영 단계·§5 T17 행, [PROJECT_STATUS.md](PROJECT_STATUS.md) 결정 행·STAGE 진행표·주요 위험·다음 행동, [VERIFICATION.md](VERIFICATION.md) "모델 인증 형태 (D-14)" 행, [DISCOVERY.md](DISCOVERY.md) §10, 설정 초안 `codex.auth` 주석.

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

### T19에서 정할 것 (에이전트 추천 유지)

| 항목 | 추천 | 근거 |
|---|---|---|
| 토큰 분리 | 분리한다: 커밋·ref용 Contents write 토큰과 PR 생성·본문 갱신용 Contents read + Pull requests write 토큰 | PR을 다루는 경로에서 병합 API 권한이 빠진다. 병합 차단의 주 장치는 여전히 ruleset과 게시 서버다 [가정] |
| ruleset E | 둔다(`infra/github`, App ID는 숫자 리터럴, D-28) | 다른 신원이 봇 브랜치를 덮는 것을 막는다. homelab에 같은 모양의 옛 ruleset 선례가 있다 [실측] |
| App 이름·설치 저장소 | 이름 예 `homelab-bot-writer`. 설치 저장소는 `github.change_writer_repositories` | 이름은 예시다 [가정] |

게시 서버 허용 API(결정의 "허용 목록"을 채울 초안, CHANGE-02 시험 대상) [가정]: git data(`POST /git/blobs`, `/git/trees`, `/git/commits`), `bot/` 접두의 `POST /git/refs`·`PATCH /git/refs/heads/bot/…`(`force: false`), `POST /pulls`(head `bot/…`), `PATCH /pulls/{n}`(제목·본문). 그 밖은 거부. 특히 merge, `/merges`, `/dispatches`, update-branch, GraphQL `mergePullRequest`·`enablePullRequestAutoMerge`, 리뷰 API. 허용 파일 경로(`github.change_writer_allow_paths`)도 T19에서 정한다.

리뷰 연결: 이 App의 봇 사용자 ID는 D-16 하위 결정의 허용 봇 작성자 목록에 넣는다(결정됨, 생성 뒤).

사람 작업(T19 시작 전, `approvals.md` 기록): App 생성·설치, 키를 Infisical `/apps/homelab-bot/`에 등록.

---

## R08 명시적 Codex 연결 (결정 ID 없음)

**상태:** 보류. 확정(사용자 2026-10-18, T15): R08(V1 기능 3, 사용자가 명시적으로 연결한 기존 Codex 작업)은 요구를 그대로 두고, 연결 방식은 T18(CODEX_BRIDGE)에서 다시 판단한다. 그때까지 보류한다. T15 질문에서 "T18에서 다시 판단"을 에이전트 추천으로 제시했고 사용자가 골랐다.

- 사람의 개인 세션을 `capability=false`로 정한 것이 아니다. T15 초안이 그렇게 적었던 곳(ARCHITECTURE §4, VERIFICATION, 설정 초안, V1_PLAN TASK-01)은 "보류(T18)"로 고쳤다.
- 근거로 남기는 조사 결과: herdr를 거치는 연결은 Codex 상태를 화면으로 추정하고 [확인: https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/website/src/content/docs/integrations.mdx "Codex state comes from Herdr's screen manifest detection"], 소켓 API의 인증·접근 제어가 문서에 없어 [확인: https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/website/src/content/docs/socket-api.mdx, 실측: 소켓은 사용자 소유 0600] 쓰지 않는다.
- T18이 볼 입력: 개인 CODEX_HOME과 herdr 소켓에 봇이 닿지 않는 연결 방법. 예를 들어 사람이 상태를 봇에 보내는 Codex 공식 훅이 후보다. 공식 훅 이벤트 목록은 아직 확인하지 않았다 [미확인].
- 봇 소유 작업의 재개(`exec resume`, 봇 CODEX_HOME 안 세션)는 R10 경로이고 이 보류와 별개다.

---

## T20 기억·삭제 원장·브리핑 (로컬·mock, 2026-10-29)

**상태:** 결정 대기 1건(삭제 원장의 저장소·자격·보존). 나머지는 T20 구현 선택이고 사용자 결정이 아니다. 코드는 `src/memory.ts`, `src/briefing.ts`, `migrations/010_memory_briefing.sql`, 시험은 `test/memory-briefing.test.ts`다. 실제 R2·자격·Discord는 쓰지 않았고 원장은 로컬 파일 대역(`FileDeletionLedger`)이다.

### 결정 대기: 삭제 원장의 저장소·자격·보존 (R17, DATA-02)

ARCHITECTURE §7은 삭제 표식을 봇 DB 복원으로 되돌아가지 않는 곳에 두라고 한다. 어디에 둘지는 사용자 결정이다. 정해지기 전에는 실제 배포에서 기억 삭제를 "완료"로 응답할 원장이 없다.

| 후보 | 복원에서 빠지는가 | 비용·위험 |
|---|---|---|
| (A) R2 append-only 객체(삭제마다 객체 하나, 예: `<memory_id>@<created_at>.json`) | 빠진다. 봇 DB 복원(설계 C.5.7)과 빈 NUC 복구(C.6.4) 모두 R2를 되돌리지 않는다 [가정] | `/apps/homelab-bot/`에 R2 자격이 하나 는다. 버킷을 `homelab-backups`와 같이 쓰면 14일 lifecycle에 원장도 지워지므로 별도 버킷이나 lifecycle 제외 접두사가 필요하다. 덮어쓰기 금지(조건부 PUT) 지원 여부 [미확인] |
| (B) 같은 공유 PostgreSQL의 별도 DB | 앱 하나 복원에서는 빠지지만 빈 NUC 복구에서는 함께 되돌아간다 [가정] | 새 자격·외부 의존이 없다. 클러스터 전체 복구 때 삭제가 되살아날 수 있다 |
| (C) 봇 파드 PVC의 파일(로컬 대역과 같은 방식) | PVC 백업 방식에 달렸다 [미확인] | NUC 디스크와 운명을 같이해 빈 NUC 복구 때 잃는다 |

**에이전트 추천:** (A). 두 복원 단위 모두에서 빠지는 유일한 후보다. 보존은 백업 보존(14일)보다 짧으면 안 되며, 항목에 내용이 없어(기억 ID·`created_at`·삭제 시각만) 기본은 무기한, 줄인다면 백업 보존 + 7일 이상을 제안한다. 사람 작업: 버킷·토큰 생성과 Infisical 등록(키 이름은 결정 뒤 정함), `approvals.md` 기록. 해소 전에는 T16b 배포에서 기억 삭제 명령을 열지 않는다.

### 구현 선택 (재검토 조건: T16b 실측, 원장 결정)

- **기억 ID:** UUID(`randomUUID`)로 재사용하지 않는다. 원장 재적용은 ID와 `created_at`이 둘 다 맞을 때만 지운다(복원으로 ID가 되감긴 경우 보호).
- **삭제 순서와 부분 실패(ARCHITECTURE §7 제안 채택):** 삭제 요청을 DB에 기록하고 바로 조회에서 숨긴다 → 원장 append 확인 → DB 정리 → 완료 응답. 원장 쓰기가 실패하거나 결과를 모르면 원장을 다시 읽어 판단하고, 기록을 확인하지 못하면 "아직 삭제하지 않음"으로 답하고 숨긴 채 재시도한다(`resume`). 원장 기록 뒤 DB 정리가 실패하면 완료라 하지 않고, 프로세스 안 원장 사본과 DB 요청 행으로 숨긴 채 재시도·재기동 재적용으로 정리한다. 원장 append 결과를 모를 때 재시도하면 같은 항목이 두 번 들어갈 수 있고, 재적용은 멱등이라 받아들인다.
- **기동 순서:** 원장 전체를 다시 적용한 뒤에만 기억 조회·저장을 연다. 원장을 읽지 못하면 닫힌 채로 두고, 브리핑의 기억 칸은 "미확인"으로 보낸다. 복원된 DB에는 지운 기억이 든 대기 브리핑이 있을 수 있으므로 게시자와 브리핑 tick은 원장 재적용 뒤에 시작해야 한다. 지난 회차의 대기 브리핑은 tick이 정리하므로 게시자는 첫 tick 뒤에 시작해야 하고, 원장 기록 재시도(`resume`)는 주기적으로 불러야 한다. 이 진입점 연결은 T16b다.
- **로컬 원장 대역:** 쓰는 프로세스 하나를 가정하고 프로세스 안의 append는 줄 세운다. 끊긴 append 조각은 다음 append 전에 잘라낸다. fsync가 한 번 실패하면 커널이 실패한 페이지를 clean으로 돌릴 수 있어 그 뒤로는 `has`로 기록됐다고 판정하지 않는다. `has`는 파일과 디렉터리 항목을 모두 fsync로 확인한 뒤에만 true다. 디렉터리 fsync는 확인될 때까지 다시 한다. 삭제 뒤 append 결과를 모르면 한 번 더 쓰고(중복 항목은 무해), 그래도 실패할 때만 원장을 다시 읽는다. 후보 (C)로 운영에 쓰려면 다중 프로세스 쓰기와 디스크 오류 처리를 다시 검토한다.
- **DB의 삭제 표현:** 행은 남기되 진술·출처·범위·세부를 비운 `deleted` 행으로 바꾸고 검색 색인(`memory_terms`)을 지운다. 감사 기록에는 기억 내용을 넣지 않는다. 원본 Discord 메시지(`events`)는 기억 삭제로 지우지 않는다(출처 보존 기간 `retention.event_days`는 미정).
- **파생 요약(브리핑):** 지운 기억이 들어간 미전송 브리핑은 `blocked`로 막고 로컬 사본을 가린다. 게시자가 잡았지만 발송을 시작하지 않은 행도 막는다(게시자의 발송 표시가 `sending` 상태를 요구한다). 이미 보냈거나 발송을 시작했거나 결과를 모르는 브리핑은 Discord에서 지우지 않고(거짓 약속 금지), 로컬 사본을 가린 뒤 그 건수를 삭제 응답에 적는다. 가린 행은 분류를 `safe_summary` 밖으로 바꿔, 429 등으로 대기열에 돌아오거나 결과 대조를 다시 해도 기존 게시자가 거부한다(결과를 모르던 행은 대조 대신 `blocked`가 된다). 브리핑 작성 중에 지우거나 대체한 기억은 큐에 넣는 transaction에서 `FOR SHARE`로 다시 확인해 빼고 다시 작성한다. 큐에 넣은 뒤의 정정·저장 제외·삭제도 같은 transaction에서 반영한다. 한 쪽도 발송을 시작하지 않은 회차는 막고 새 revision 멱등 키(`…:r<n>`)로 다시 작성하며, 막은 이전 사본은 가린다.
- **근거와 상태:** 출처가 없으면 거부, 원본에 접근할 수 없으면 거부, 저장 제외한 출처·채널이면 거부. 종류별로 근거로 인정하는 확인된 출처가 있을 때만 `active`다(설정: 문서·성공 작업, 결정: owner 대화·문서, 장애: 성공 작업·문서, 선호: 대상 사용자 대화). PR 댓글·로그 같은 비신뢰 자료(`external`)는 근거로 세지 않는다. 같은 주제에 다른 진술이 살아 있으면 새 기억은 `candidate`, 둘 다 충돌 표시다. 같은 주제의 동시 저장·정정은 주제별 advisory lock으로 직렬화하고, 정정은 주제 잠금을 행 잠금보다 먼저 잡는다. 저장 제외로 숨긴 기억과 만료된 기억은 충돌 판정·표시에서 뺀다. 정정은 사유가 필요하고 대체된 기억은 `superseded`, 색인에서 빠진다. 기억에는 정책·권한·게시 대상 필드가 없고 어떤 권한 판단에도 쓰이지 않는다.
- **저장 제외:** 제외한 출처·채널은 새 저장을 거부하고, 이미 저장한 기억도 다음 접근부터 검색·브리핑에서 뺀다. 대화 출처와 작업 출처 모두 그 대상 채널과 부모 채널을 제외 키로 갖는다. 010은 아직 배포 전이라 기존 행의 키를 보완하는 이전은 두지 않는다. 저장소·백업에서 지우는 것은 삭제다.
- **접근 범위:** owner와 기억의 접근 채널(기본: 만든 대화의 부모 채널)에 더해, 현재 정책의 채널·서비스·guild를 매 접근에 다시 적용한다. 서비스가 정책에서 빠지면 그 서비스 기억은 다음 접근부터 보이지 않는다(삭제는 아님).
- **일일 브리핑:** 모델을 부르지 않고 조립한다. 그래서 모델 한도·인증 대기·비상 중지와 직렬 1 슬롯에 막히지 않고, 중지 상태는 브리핑에 적는다. 시각·시간대는 설정값(08:50, Asia/Seoul)이고 비었거나 잘못되면 예약을 끈다. 대상은 매 회차 현재 정책의 owner·알림 채널로 다시 정하고(바뀌면 예약 행을 고치고 감사 기록), 작성 때와 큐에 넣기 직전에 다시 인가한다. 작성 중에 대상 설정만 바뀌면 막지 않고 새 대상으로 다시 작성한다. 게시 직전 검사는 기존 게시자가 한다. 회차 키는 현지 날짜이고 `briefing_runs` 기본 키와 outbox 멱등 키로 한 번만 만든다. 중단 동안 지난 회차는 몰아 보내지 않고 누락으로 남겨 최신 한 건에 표시한다. 큐에 넣었지만 발송을 시작하지 않은 지난 회차와 12시간 넘게 못 보낸 회차도 tick 때 막고 누락으로 바꾼다. 예정 시각보다 10분 넘게 늦으면 지연을 표시하고, 12시간 넘게 늦으면 보내지 않고 다음 브리핑에 누락으로 적는다. 작성 lease는 120초, 관측 신선도는 1시간, 관측 원본은 함께 읽고 원본마다 10초 한도다. 한 번의 중단에서 누락 기록은 최대 31회이고 그 이상은 "이상"으로 표시한다. 이 수치는 구현 기본값이다.
- **브리핑 내용의 경계:** "정상"은 신선한 관측이 있을 때만 쓴다. 읽기 실패는 마지막 정상 수집 시각과 "미확인", 백업은 복원 검증을 따로 적는다. 연결된 관측 원본이 없으면 "연결된 조회 없음 · 미확인"이다. Codex 작업 상태·승인/질문 대기는 T18 연결 전이라 "0건"이 아니라 "연결 전 · 미확인"으로 적는다.

---

## 결정 반영 자리 (spec §12)

homelab 쪽(spec, 설계, 플랫폼 프롬프트, 티켓)은 homelab `rebuild` 변경으로, 봇 문서는 봇 저장소 PR로 반영한다. 커밋·push·PR은 사람 승인 뒤다.

| 결정 | 봇 문서 자리(`01` §11, `00` §3·§5·§6·§8, `04` §2·§10) | homelab·그 밖 자리 |
|---|---|---|
| D-14 | `01` §3 질문 7·이 단계에서 정할 결정, `01` §6 격리, `00` §3 둘째 "> 참고:"(본문은 C-08 보호), `00` §5 "격리 작업 공간" 행, `00` §8 `platform.isolated_workspace`·`codex.codex_home`·`budgets.max_concurrent_jobs`와 주석 | spec §5.1, §10 7번(남는 위험), §11 모델 행, 설계 C.8 격리 행(작업자 영속 쓰기 공간)·E4b·E9·F, 플랫폼 프롬프트 D-14 자리, T08b·T16b·T17(차단 조건)·T18, 설정 초안 `codex.auth` |
| D-15 | `01` §3 질문 2·아키텍처 선택·이 단계에서 정할 결정, `01` §6 격리, `00` §3 둘째 "> 참고:", `00` §5 "격리 작업 공간"·"webhook 수신 경로"·"Alertmanager 수신자" 행(포트), `00` §8 `project.*_host`·`platform.isolated_workspace`·`budgets.max_concurrent_jobs` | spec §5.1, §10 8번, 설계 C.8 격리 행·봇 자리 Application·E4b·E9, 플랫폼 프롬프트 D-15 자리, T16b "봇 자리 `target` 변경" |
| D-16(하위 결정 포함) | `01` §3 PR 리뷰 선택·이 단계에서 정할 결정, `01` §5 이벤트·신뢰 아래 참고(`author_association`), `04` §2 표 아래 "PR 인젝션"(`author_association` [미검증] 문장이 T15 실측으로 풀림)·§10 D-16 행, `00` §3 첫째 "> 참고:", `00` §5 "GitHub App 구조"·"webhook 수신 경로" 행, `00` §6 아래 "> 참고:", `00` §8 `github.review_identity`·`reviewed_repositories`·`model_call_author_associations` 주석과 새 키 `allowed_bot_author_ids` | spec §5.1, §10 17번, §11 Connector 행, D-26 설치 범위, 설계 C.8 리뷰 App 행(권한에 Issues read 추가 필요, 설계 세부)·webhook 행([미검증] 표시), 플랫폼 프롬프트 D-16 자리, T15(Connector 축소, 완료), T17 |
| D-17 | `01` §3 질문 3·이 단계에서 정할 결정, `00` §3 둘째 "> 참고:", `00` §8 `discord.*` | spec §5.1, T16a·T16b |
| D-24 | `01` §3 이 단계에서 정할 결정, `01` §6 격리, `01` §7 다섯째 항목, `00` §5 "봇 변경 PR 작성 자격" 행, `00` §6 아래 "> 참고:"(본문은 C-08 보호), `00` §8 `github.change_writer_*` 주석 | spec §5.1, 설계 C.8 봇 변경 PR 행, 플랫폼 프롬프트 D-24 자리, T19 |
| R08 보류 | `01` §3 질문 4, `01` §11 새 행, `00` §3 둘째 "> 참고:", `00` §8 `codex.adapters_to_verify` 주석(요구·계약 문구는 그대로) | spec §5.1, T18 |
| 범위 조정(안 3) | `01` §0 아래 "실제 티켓 순서와 완료 조건", `01` §3 질문 1(플랫폼 등록은 T16b), `01` §11 새 행, `00` §3 둘째 "> 참고:" | spec §8.1 표·§8.2 그래프(T16을 T16a·T16b로), §10 6번, T16 분할, T17~T22 머리말([V1_PLAN.md](V1_PLAN.md) §5) |
| 모든 결정 | spec §12대로 봇 문서 `00`~`04` 전체를 D-14~D-17·D-24로 다시 검색해 빠진 자리를 찾는다 | 같은 방법으로 플랫폼 프롬프트(`platform/design-prompt.md`)와 설계 C.8·F를 검색한다 |
