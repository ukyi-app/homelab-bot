# PROJECT_STATUS: 홈랩 AI Discord 봇

- 기준일: 2026-11-09. 게시 서버는 봇 main을 자동 배포로 따라가고, 작업자 이미지는 homelab 사람 PR로 올린다(`platform/sandbox/values.yaml`). 아래 "주요 위험"·"다음 행동"은 T16a 당시 기록이고, 실연동 결과는 [VERIFICATION](VERIFICATION.md)의 티켓별 절이 기준이다.
- 한 줄 상태: **T16b·T17·T18·T19·T20 완료. T21 판정 `READY_FOR_SCOPED_PILOT`(4회차 2026-11-09, [V1_RELEASE_REPORT](V1_RELEASE_REPORT.md)), 사용자가 제한 대상 범위로 수용했다(2026-11-09). V1 전체 사용자·운영 수용(`V1_ACCEPTED`)은 아니다. 1회차(2026-11-07) 출시 차단·필수 수정은 T25·T26(A01·A02), T27~T29(A03·A04·A06), T30(blocked 7건), T31(원문 칸 7일 보존)로, 2회차(2026-11-09) 출시 차단 A09(CHANGE 정리 경합)는 T32(#104·#106)로 고쳐 배포했다([VERIFICATION](VERIFICATION.md) 티켓별 절). 남은 발견은 low 3건(A05·A07·A08).** 작업 레인은 운영에서 owner·`homelab-smoke`만 열려 있고, 변경 PR(CHANGE_PR)은 정책의 `homelab-smoke` 하나로 켜져 있다. R08 수신 경로는 운영에서 켜져 있고 활성 R08 연결은 없다.

## 현재 단계

| 항목 | 상태 |
|---|---|
| 목표 | V1 (`00` §3 필수 기능 7개) |
| 현재 STAGE | FOUNDATION (`MODE=build`, homelab 티켓 T16b 실연동 완료, 시범 P-1 승인 대기) |
| DISCOVERY 산출물 | 초안 작성: [DISCOVERY.md](DISCOVERY.md), [ARCHITECTURE.md](ARCHITECTURE.md), [DECISIONS.md](DECISIONS.md), [VERIFICATION.md](VERIFICATION.md), [V1_PLAN.md](V1_PLAN.md), 이 파일, [config/homelab-bot.example.yaml](config/homelab-bot.example.yaml). 이 저장소 병합 전(PR과 사람 승인 필요) |
| 운영 산출물 | HANDOFF·evidence·내부판은 private 운영 저장소 몫이다(D-13). 그 저장소는 아직 비어 있다. 첫 커밋 전에 할 Codex Connector 설치 범위 축소(D-16)는 끝났다(사람 2026-10-18 17:45. 남긴 저장소 목록은 사용자 보고이고 API로는 확인하지 못함). 첫 커밋은 사람 승인 뒤다 |
| 결정 | D-14, D-15(남은 부분), D-16(하위 결정 포함), D-17, D-24: 확정(사용자 2026-10-18, T15). D-14는 에이전트 추천(API 키)이 아니라 봇 전용 ChatGPT 구독 계정을 골랐다. D-14에 T17 차단 조건을 더했다(확정(사용자 2026-10-18, PR #3 리뷰)). 그 차단은 Claude 구독 프로필에서 해제(사용자 2026-11-04, DECISIONS D-14 "재조사와 해제") |
| 남은 미정 세부 | 없음. D-24 세부는 확정(사용자 2026-11-05, DECISIONS D-24 "T19 세부 결정"), R08 연결 방식은 확정(사용자 2026-11-04, DECISIONS "T18 결정 (Claude 실행기 기준)") |
| 범위 조정 | 안 3(시범 운영 + 로컬 선행), 확정(사용자 2026-10-18, T15). T16을 T16a·T16b로 나눈다(V1_PLAN §4) |
| 코드 | `src/`, PostgreSQL 마이그레이션, 로컬·mock 시험. Gateway·모델 실연동과 배포 진입점은 T16b |
| CI | `build.yaml`이 공통 `app-build`를 부른다. PR은 공개 금지 패턴 검사, Dockerfile test 단계, 빌드 확인을 돌고 main push는 이미지 push와 배포 PR까지 간다 |
| 배포 | T16b에서 첫 배포. 봇 main 병합 → 빌드 → 배포 PR 자동 병합 → Argo CD(시나리오 1). 작업자 이미지는 사람 PR로 digest 고정. 2026-11-04 게시 서버·작업자 모두 `bd0bc8f`(작업자는 homelab #1055) |

## STAGE 진행표

| STAGE | 티켓 | 상태 | 막는 것 |
|---|---|---|---|
| DISCOVERY | T15 | 초안, 결정 확정, 저장소 반영 대기 | 이 저장소 PR 병합과 운영 저장소 push(사람 승인) |
| FOUNDATION 로컬·mock | T16a | 완료(PR #5 병합 2026-10-20, DM·브리핑 확정) | 없음 |
| FOUNDATION 실연동·첫 배포 | T16b | 실연동·첫 배포 완료(2026-11-02). 배정 시험 fail 없음, EVENT-01 not_run·EVENT-02 outbox 경로 not_run은 사유와 해소 티켓 있음([VERIFICATION](VERIFICATION.md) "T16b 실연동 결과"). 시범 P-1 진행 중(사용자 승인 2026-11-02 18:31: 허용 채널에서 owner의 `/read`와 대화), 2026-11-03 T20 기억·브리핑으로 확장 | 없음 |
| PR_REVIEW | T17 | **완료(2026-11-04, 사용자 확인, [VERIFICATION](VERIFICATION.md) "T17 완료 판정").** 실가동 구현 운영 배포 완료(2026-11-04, PR #38~#44, #46). 모델 없는 배포 경계 확인 통과. **리뷰 켬(2026-11-04, 사용자 승인, 시범 P-2, 대상 `homelab-smoke`만).** 첫 시험 PR #11은 작성자 게이트(비공개 멤버십)와 CLI 내장 플러그인(#46)에 막힌 뒤 COMMENT 리뷰 1건과 Discord 요약이 나갔다. 심은 결함 2개 모두 지적, 오탐 0. 반례·복구 시험 A 묶음 7건·B 묶음 4건 pass(B는 Renovate 허용 봇 경로, fork 차단, webhook 재전송 중복 무시, 제어 명령·비상 중지·재개), 운영 not_run 4건은 사유·해소 티켓과 함께 기록. 실모델 평가 8건(오탐 1은 #50으로 해소)([VERIFICATION](VERIFICATION.md) "T17 실가동 구현"). 로컬·mock 단계(2026-10-29, PR #7)의 판정은 그 위 "PR_REVIEW T17" 표 | 없음. 시범 P-2는 `homelab-smoke`만 계속(대상 확대마다 사람 승인). 운영 not_run(허용 밖 사람 작성자·댓글, 실행 중 비상 중지, Bot 댓글 실례, 한도·인증 대기·게시 응답 유실 대조)은 T21이 다시 본다. 풀린 것: 결정 5건과 시험 저장소 확정(사용자 2026-11-04, [DECISIONS](DECISIONS.md) "T17 결정"). 작업별 세션 저장 공간 확정(사용자 2026-11-04, DECISIONS "T18 결정" (4): 리뷰 레인은 실행마다 빈 임시 공간). 인증 격리·SEC-02 진입 조건은 리뷰 레인에 한해 무도구 경계로 갈음 확정(사용자 2026-11-04, 같은 절). 리뷰 App 생성·설치 완료. D-14 차단 조건은 Claude 구독 프로필에서 해제(사용자 2026-11-04, DECISIONS D-14 "재조사와 해제") |
| CODEX_BRIDGE | T18 | **완료(2026-11-06, 사용자 확인, [VERIFICATION](VERIFICATION.md) "T18 완료 판정").** 작업 레인 운영 개방(owner·`homelab-smoke`만), R08 운영 켬(VM 꺼짐). 배정 시험 fail 0. 아래는 진행 기록이다. 로컬·mock 진행(2026-10-29, 브랜치 `feat/t18-codex-bridge-local`, PR #9). 봇 소유 작업 경로, 질문·완료 중계, 작업자 Codex 설정 생성, 어댑터 능력표, 도구 호출 예산·출력 상한 집행. rev-t18 r1 지적 6건·재리뷰 r2 지적 5건·r3 지적 2건·r4 지적 2건과 자체 점검, PR #9 Codex Connector 리뷰 1라운드 3건 반영, 347/347([ARCHITECTURE](ARCHITECTURE.md) §12, [VERIFICATION](VERIFICATION.md) "CODEX_BRIDGE T18"). AC-B5 완료 아님 | 없음. 운영 not_run은 T19(변경 작업자 경로 SEC-02)와 T21이 다시 본다. 아래는 진행 중 기록이다. 완료 T16b(실제 `codex exec`·작업자 파드). R08 연결 방식, 인증 파일 분리, 레인 분리, 작업별 세션 저장 공간은 확정(사용자 2026-11-04, [DECISIONS](DECISIONS.md) "T18 결정 (Claude 실행기 기준)"). 작업 레인 격리 파드 실측은 통과했다(2026-11-04, 전용 Localhost seccomp·AppArmor + scrub + 샌드박스, [VERIFICATION](VERIFICATION.md) "T18 작업 레인 격리 파드 실측", [DECISIONS](DECISIONS.md) "(2) 파드 실측 결과와 대가 수용"). 운영 반영(호스트 프로필, 이미지 bubblewrap·socat, 작업 레인 설정·파드)이 남았다. SEC-02 `auth.json` 읽기·세션 디렉터리 격리 blocked(로컬 시험 가능 부분만 pass). 소멸 확인 완전성(cgroup) blocked. T16a 소유 변경 요청(Discord 명령 연결 등, ARCHITECTURE §12). D-14 차단 조건은 Claude 구독 프로필에서 해제(사용자 2026-11-04, DECISIONS D-14 "재조사와 해제") |
| MEMORY_BRIEFING | T20 | 완료(2026-11-03, homelab spec §8.1). 실연동(2026-11-02~03, live). 원장(NUC SSD 계약 v1)·기동 장벽·기억 명령 5개·일일 브리핑(08:50 Asia/Seoul)을 운영에 열었다. MEM-01·BRIEF-01·DATA-02(정식 `homelab db restore`로 삭제 전 시각 복원 → 원장 재적용) pass, AUTH-02는 기억 명령 경로 pass(허용 밖 채널 거부 포함)([VERIFICATION](VERIFICATION.md) "T20 실연동 결과"). 로컬·mock 단계(2026-10-29, PR #8)의 판정은 그 아래 T20 표 | 없음. 시범 P-1 확장 진행 중(사용자 승인 2026-11-03: owner가 대화 채널에서 기억 명령 실사용, 일일 브리핑. 범위·멈춤 조건은 homelab T20 티켓 "시범 운영"). 미확인 칸 해소: 브리핑 인증서·복원 검증 원본은 homelab T24 완료(2026-11-04, [VERIFICATION](VERIFICATION.md) "T24 실연동 결과"), Codex 작업 상태·질문 대기 칸 T18, 기억을 모델 맥락에 넣는 경로(SEC-01)는 V1 코드에 없어 T21이 다시 확인 |
| CHANGE_PR | T19 | **완료(2026-11-07, 사용자 확인, [VERIFICATION](VERIFICATION.md) "T19 완료 판정").** B0~B5(PR #79~#83, #85)와 보안 재검토 수정 #86. 운영 무모델 측정, 실제 `ukyi-writer` AC-P8을 거쳐 `homelab-smoke` 하나로 켰고, live 한 건이 PR 게시·사람 병합·배포 관측까지 통과했다 | 없음. 운영에서 만들지 않은 사례와 결함·한계는 T21 |
| RELEASE_AUDIT | T21 | 완료(2026-11-09, 사용자 수용). 4회차 판정 `READY_FOR_SCOPED_PILOT`(독립 감사 Codex, 봇 `772599f`). 1~3회차 발견 A01~A04·A06·A09 fixed, A05·A07·A08(low) not_fixed. 수용 시험 pass 30·fail 0, 관련 159/159, 전체 2,147 중 실패 0([V1_RELEASE_REPORT](V1_RELEASE_REPORT.md), [V1_TRACE](V1_TRACE.md)) | 회차별: 1회차 `NOT_READY`(2026-11-07, `dda891f`) → T25~T31 → 2회차 `NOT_READY`(새 A09, `9da65f5`) → T32 1차 → 3회차 `NOT_READY`(A09 `partially_fixed`, `4a10f3c`) → T32 2차 → 4회차(`772599f`). 남은 위험: 작업자 정리를 끝내 확인 못 한 세션의 CHANGE 원문 장기 보존, 백업 14일. 티켓은 homelab spec §8 |

V1 출시 판정: T21 4회차 `READY_FOR_SCOPED_PILOT`(2026-11-09), 사용자가 기존 제한 대상(owner·허용 채널·`homelab-smoke`) 범위로 수용(2026-11-09). V1 전체 사용자·운영 수용(`V1_ACCEPTED`) 기록은 없고, 대상 확대는 별도 결정이다. 시범 운영은 T16b 뒤(P-1, 허용 채널 읽기 조회만)와 T17 뒤(P-2, 시험 저장소 PR 리뷰만)에 사람 승인으로 시작한다. P-1은 2026-11-02에 시작했고 2026-11-03 T20 기억·브리핑으로 넓혔다. D-14 차단 조건(Claude 구독 프로필에서 해제(사용자 2026-11-04, DECISIONS D-14 "재조사와 해제"). 아래는 해제 전 기록): 모델을 부르지 않는 로컬·mock 구현은 T16a 뒤 착수할 수 있다. 공개 저장소 PR 내용으로 구독 모델을 부르는 일(평가셋, `authorized_external`, 시범 P-2)은 차단 조건이 풀린 뒤에만 한다.

## 주요 위험

1. **일정:** V1 규모(기능 7, 요구 18, 시험 30)가 일정 위험 1순위다. 대응은 안 3(V1_PLAN §4).
2. **모델 약관(D-14):** 공개 저장소 차단은 Claude 구독 프로필에서 해제(사용자 2026-11-04, DECISIONS D-14 "재조사와 해제"). 남는 위험은 약관 해석 회색(2026-11-12 Usage Policy 포함), 사전 통지 없는 집행이 토큰 계정에 닿는 것, 구독 한도 공유다(사용자 수용). 아래는 해제 전 기록이다. 공식 CI/CD 인증 안내가 구독 무인 실행을 고급 경로로 두고 "public or open-source repositories"에 쓰지 말라고 적는다. 봇의 리뷰 대상은 public이다. 적용 범위는 [미확인]이고 OpenAI 확인 항목이다. 그래서 T17 차단 조건을 두었다. 조건은 OpenAI가 허용을 확인하거나 API 키 등 공식 지원 인증으로 바꾸는 것이다. 모델을 부르지 않는 로컬·mock 구현은 T16a 뒤 착수할 수 있다. 공개 저장소 PR 내용으로 구독 모델을 부르는 일(평가셋, `authorized_external`, 시범 P-2)은 차단 조건이 풀린 뒤에만 한다. T16a·T16b와 대화 레인은 그대로 진행한다(확정(사용자 2026-10-18, PR #3 리뷰)). 범위는 사용자 결정대로 T17이다. T18도 같은 차단을 받는다(확정(사용자 2026-10-18, PR #3 리뷰)): 허용 확인이나 공식 지원 인증 전환 전에는 공개 저장소 코드로 구독 모델을 부르는 T18 작업을 하지 않고, 모델을 부르지 않는 로컬·mock 구현만 T16a 뒤 착수한다. T19는 T17 뒤라 함께 기다린다.
3. **작업자의 인증 파일:** 구독 `auth.json`이 비신뢰 코드와 같은 작업자 파드에 있다. egress를 `codeload.github.com`과 모델 쪽으로 좁혔지만 읽기 자체는 막지 못한다. 인증 파일 분리와 레인 분리는 열린 항목이다(ARCHITECTURE §5.1). 작업 사이 세션 파일 격리도 열린 항목이고, 정해지기 전에는 같은 UID에서 다른 작업과 대화 레인의 세션 파일도 읽힌다. T17은 작업별 세션 저장 공간을 정한 뒤 시작한다. 2026-11-04 확정: 리뷰 레인은 실행마다 빈 임시 공간을 쓰고 도구가 없어 무도구 경계로 갈음했다. 작업 레인은 T18 파드 실측 뒤에 연다(DECISIONS "T18 결정 (Claude 실행기 기준)").
4. **모델 호출 직렬 1개:** 긴 Codex 작업 중에는 대화가 기다린다(D-14 조건 3). T16a는 작업자 경유 경로를 확정했다(ARCHITECTURE §11). 실측은 T16b다.
5. **플랫폼 의존:** 읽기 계정, 격리 작업 공간, webhook 경로, 경보 수신자가 모두 설계로만 있다. 작업자 영속 쓰기 공간은 설계 C.8 변경이고 homelab `rebuild` 변경에서 C.8·E4b에 들어갔다(크기·백업은 T08b). 실측은 blocked(해소: T13 뒤, T16b 시작 때 재확인).
6. **Discord 재연결:** Bun 위 discord.js의 재연결 크래시 이슈가 not planned로 닫혀 있다. 서버가 무선망이라 단절 시험을 T16b 필수로 둔다. Gateway 단절은 readiness가 아니라 봇 지표 경보로 알린다(readiness에 묶으면 webhook·경보 수신까지 끊긴다). 그 경보는 앱 지표 스크레이프 규칙(T08b 또는 T16b)이 정해져야 선다(ARCHITECTURE §8).
7. **읽기 조회 경계:** Grafana Viewer가 모든 데이터소스를 질의할 수 있어 로그 제외는 봇 질의 템플릿으로 강제해야 한다.

## 다음 행동

T16a 이후: 호출자는 작업 트리와 보고서의 HANDOFF·검증 결과를 검토하고 커밋·PR을 처리한다. DM 허용 여부와 브리핑 시각은 확정됐고(사용자 2026-10-20) 설정 예시에 반영했다. 실제 값은 Infisical runtime policy(`dmEnabled: false`)에 둔다. T16b는 VERIFICATION의 blocked 점검과 ARCHITECTURE §11의 연결 지점부터 시작한다. 아래 목록은 T15 당시 계획 기록이며, T16a를 다시 시작하라는 지시가 아니다.

1. 이 산출물을 봇 저장소에 PR로 올리고, HANDOFF와 evidence를 private 운영 저장소에 push한다(각각 사람 승인, `approvals.md`). 그 전까지 초안이 세션 임시 위치에만 있어 유실 위험이 있다.
2. 결정을 봇 문서 `docs/ai-bot/prompts/`의 자리에 반영한다(봇 저장소 PR, DECISIONS "결정 반영 자리"). homelab 쪽(spec, 설계 C.8, 플랫폼 프롬프트, T16~T22 티켓)은 homelab `rebuild` 변경으로 하고 커밋·push는 사람 승인 뒤다(V1_PLAN §5).
3. T16a를 시작한다. 플랫폼을 기다리지 않는다.
4. 사람 준비: OpenAI 확인 세 가지(D-14. Claude 구독 프로필의 공개 저장소 차단은 2026-11-04 해제했다. 아래는 Codex 프로필로 돌아갈 때의 조건이다. 공개 저장소 문구는 T17 차단 조건이라, 공개 저장소 PR 내용으로 구독 모델을 부르기 전에 허용 확인을 받거나 API 키 등 공식 지원 인증으로 바꾼다. 인증 전환은 D-14 변경이라 사용자 결정과 설계 C.8 검토가 필요하다), Discord 서버·봇 계정(늦어도 T16b 실연동 전, T16b 할 일 2), 봇 전용 구독 계정·첫 시드(T16b 전(모델을 처음 쓰는 단계 전). 대화 레인이 모델을 쓴다), 리뷰 App(T17 전), 봇 쓰기 App(T19 전). 각 단계 진입 전 `approvals.md` 기록.
