# PROJECT_STATUS: 홈랩 AI Discord 봇

- 기준일: 2026-10-18. 다음 갱신은 저장소 반영이나 STAGE 진입 때.
- 한 줄 상태: **V1 DISCOVERY 초안이 나왔고 결정 5개(D-14~D-17·D-24)와 범위 조정(안 3)이 확정됐다. 저장소 반영은 사람 승인 대기다. 코드와 배포는 없다.**

## 현재 단계

| 항목 | 상태 |
|---|---|
| 목표 | V1 (`00` §3 필수 기능 7개) |
| 현재 STAGE | DISCOVERY (`MODE=plan`, homelab 티켓 T15) |
| DISCOVERY 산출물 | 초안 작성: [DISCOVERY.md](DISCOVERY.md), [ARCHITECTURE.md](ARCHITECTURE.md), [DECISIONS.md](DECISIONS.md), [VERIFICATION.md](VERIFICATION.md), [V1_PLAN.md](V1_PLAN.md), 이 파일, [config/homelab-bot.example.yaml](config/homelab-bot.example.yaml). 이 저장소 병합 전(PR과 사람 승인 필요) |
| 운영 산출물 | HANDOFF·evidence·내부판은 private 운영 저장소 몫이다(D-13). 그 저장소는 아직 비어 있다. 첫 커밋 전에 할 Codex Connector 설치 범위 축소(D-16)는 끝났다(사람 2026-10-18 17:45. 남긴 저장소 목록은 사용자 보고이고 API로는 확인하지 못함). 첫 커밋은 사람 승인 뒤다 |
| 결정 | D-14, D-15(남은 부분), D-16(하위 결정 포함), D-17, D-24: 확정(사용자 2026-10-18, T15). D-14는 에이전트 추천(API 키)이 아니라 봇 전용 ChatGPT 구독 계정을 골랐다 |
| 남은 미정 세부 | D-17의 DM 허용 여부·브리핑 시각(T16a), D-24의 토큰 분리·ruleset E·App 이름·설치 저장소·허용 파일 경로(T19), R08 연결 방식(T18, 보류) |
| 범위 조정 | 안 3(시범 운영 + 로컬 선행), 확정(사용자 2026-10-18, T15). T16을 T16a·T16b로 나눈다(V1_PLAN §4) |
| 코드 | 없음. 저장소에는 `docs/ai-bot/prompts/`와 `CODEOWNERS`만 있다 |
| CI | 없음. 템플릿 기반 `build.yaml`과 금지 패턴 검사는 플랫폼 E5·E9 뒤 |
| 배포 | 없음. 새 플랫폼이 아직 서 있지 않다(homelab T06~T13 대기) |

## STAGE 진행표

| STAGE | 티켓 | 상태 | 막는 것 |
|---|---|---|---|
| DISCOVERY | T15 | 초안, 결정 확정, 저장소 반영 대기 | 이 저장소 PR 병합과 운영 저장소 push(사람 승인) |
| FOUNDATION 로컬·mock | T16a | 대기 | T15 |
| FOUNDATION 실연동·첫 배포 | T16b | 대기 | T13(플랫폼), T16a, Discord 서버·봇 계정, 작업자 영속 쓰기 공간(설계 C.8 변경), 봇 전용 구독 계정·첫 시드(D-14) |
| PR_REVIEW | T17 | 대기 | 착수 T16a, 완료 T16b. 리뷰 App |
| CODEX_BRIDGE | T18 | 대기 | 착수 T16a, 완료 T16b. R08 연결 방식 판단 |
| MEMORY_BRIEFING | T20 | 대기 | 착수 T16a, 완료 T16b |
| CHANGE_PR | T19 | 대기 | T17, T18, D-24 App |
| RELEASE_AUDIT | T21 | 대기 | T17~T20 |

V1 출시 판정: 없음(아직 판정 대상 아님). 시범 운영은 T16b 뒤(P-1, 허용 채널 읽기 조회만)와 T17 뒤(P-2, 시험 저장소 PR 리뷰만)에 사람 승인으로 시작한다.

## 주요 위험

1. **일정:** V1 규모(기능 7, 요구 18, 시험 30)가 일정 위험 1순위다. 대응은 안 3(V1_PLAN §4).
2. **모델 약관(D-14):** 공식 CI/CD 인증 안내가 구독 무인 실행을 고급 경로로 두고 "public or open-source repositories"에 쓰지 말라고 적는다. 봇의 리뷰 대상은 public이다. 적용 범위는 [미확인]이고 OpenAI 확인 항목이다.
3. **작업자의 인증 파일:** 구독 `auth.json`이 비신뢰 코드와 같은 작업자 파드에 있다. egress를 `codeload.github.com`과 모델 쪽으로 좁혔지만 읽기 자체는 막지 못한다. 인증 파일 분리와 레인 분리는 열린 항목이다(ARCHITECTURE §5.1).
4. **모델 호출 직렬 1개:** 긴 Codex 작업 중에는 대화가 기다린다(D-14 조건 3). 대화 레인의 호출 경로는 T16a가 정한다.
5. **플랫폼 의존:** 읽기 계정, 격리 작업 공간, webhook 경로, 경보 수신자가 모두 설계로만 있다. 작업자 영속 쓰기 공간은 설계 C.8 변경이고 homelab `rebuild` 변경에서 C.8·E4b에 들어갔다(크기·백업은 T08b). 실측은 blocked(해소: T13 뒤, T16b 시작 때 재확인).
6. **Discord 재연결:** Bun 위 discord.js의 재연결 크래시 이슈가 not planned로 닫혀 있다. 서버가 무선망이라 단절 시험을 T16b 필수로 둔다.
7. **읽기 조회 경계:** Grafana Viewer가 모든 데이터소스를 질의할 수 있어 로그 제외는 봇 질의 템플릿으로 강제해야 한다.

## 다음 행동

1. 이 산출물을 봇 저장소에 PR로 올리고, HANDOFF와 evidence를 private 운영 저장소에 push한다(각각 사람 승인, `approvals.md`). 그 전까지 초안이 세션 임시 위치에만 있어 유실 위험이 있다.
2. 결정을 봇 문서 `docs/ai-bot/prompts/`의 자리에 반영한다(봇 저장소 PR, DECISIONS "결정 반영 자리"). homelab 쪽(spec, 설계 C.8, 플랫폼 프롬프트, T16~T22 티켓)은 homelab `rebuild` 변경으로 하고 커밋·push는 사람 승인 뒤다(V1_PLAN §5).
3. T16a를 시작한다. 플랫폼을 기다리지 않는다.
4. 사람 준비: OpenAI 확인 세 가지(D-14), Discord 서버·봇 계정(늦어도 T16b 실연동 전, T16b 할 일 2), 봇 전용 구독 계정·첫 시드(T16b 전(모델을 처음 쓰는 단계 전). 대화 레인이 모델을 쓴다), 리뷰 App(T17 전), 봇 쓰기 App(T19 전). 각 단계 진입 전 `approvals.md` 기록.
