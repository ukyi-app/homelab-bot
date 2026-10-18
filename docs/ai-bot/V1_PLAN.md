# V1_PLAN: 봇 V1 구현 순서와 수용 시험 계획

- 단계: `TARGET=V1`, `STAGE=DISCOVERY`, `MODE=plan` (homelab 티켓 T15). 작성일 2026-10-18. 초안.
- 기준: STAGE와 요구 ID는 `01`, 시험 ID·증거 등급·판정은 `04` §3·§4·§9, 티켓 순서와 단계 AC는 homelab spec §7·§8이다. 이 계획은 요구 ID·시험 ID·C-08을 바꾸지 않는다.
- 결정: D-14~D-17·D-24는 확정(사용자 2026-10-18, T15)이다([DECISIONS.md](DECISIONS.md)). 아래 진입 조건은 그 결정을 따른다. R08 연결 방식은 T18에서 다시 판단한다(보류).
- 시점 정리: D-14 봇 구독 계정 준비와 작업자 `auth.json` 첫 시드는 T16b 전(모델을 처음 쓰는 단계 전)에 한다(대화 레인이 T16b에서 처음 모델을 쓴다. 설계 E9와 같다). 결정 기록끼리 맞추려고 에이전트가 정리한 것이고 사용자 결정이 아니다(DECISIONS D-14 "시점"). Codex Connector 설치 범위 축소는 T15에서 끝났다(사람 2026-10-18 17:45, homelab `approvals.md`, DECISIONS D-16). 남긴 저장소 목록은 사용자 보고이고 API로는 아직 확인하지 못했다.
- **§4 범위 조정: 안 3(시범 운영 + 로컬 선행), 확정(사용자 2026-10-18, T15).** T16을 T16a(로컬·mock)와 T16b(실연동·첫 배포)로 나누고, STAGE별 제한 시범 운영을 둔다. 기능 수는 줄이지 않는다.

## 1. STAGE 순서

spec §8.2 그래프에 안 3의 분할을 반영한 간선이다. "착수"는 로컬·mock 작업을 시작해도 되는 간선, "완료"는 실연동과 완료 판정에 필요한 간선이다.

```text
T15 → T16a                     DISCOVERY 뒤 FOUNDATION 로컬·mock 바로 착수
T13 → T16b                     플랫폼 통합 검증 뒤 실연동·첫 배포
T16a → T16b
T16a → T17, T18, T20           착수(로컬·mock)
T16b → T17, T18, T20           완료(실연동)
T17 → T19, T18 → T19
T17, T18, T19, T20 → T21
T16b → T22                     봇이 첫 실제 앱(D-01)
```

- T17·T18·T20은 T16a의 공유 계약에 자기 경로를 더하는 로컬 구현을 T16a 뒤 시작할 수 있다. 실연동과 완료 판정은 T16b 뒤다.
- T20의 브리핑에 넣는 Codex 작업 상태는 T18 뒤 연결한다(T20 메모).
- 한 세션에 STAGE 하나. `LOCAL_VERIFIED_INTEGRATION_PENDING`은 정상 중간 상태다(spec §10 6번).
- 각 STAGE는 먼저 로컬·mock으로 수직 흐름 하나를 완성하고, 사람 승인이 있는 외부 자산에서만 실연동한다(`00` §7 9항). T16a의 결과는 `mock`·`local_integration`뿐이고 실연동 완료를 주장하지 않는다.

## 2. 단계별 진입 조건과 첫 수직 흐름

| STAGE | 진입 조건(결정·사람 작업·플랫폼) | 첫 수직 흐름 | 완료 AC |
|---|---|---|---|
| FOUNDATION 로컬 (T16a) | T15. 플랫폼과 외부 계정은 필요 없다. 사람: DM 허용 여부와 브리핑 시각 결정(D-17 남은 것), 봇 저장소 PR 검토·병합 | 모의 Discord 허용 스레드에서 "등록된 서비스 상태 알려줘" → 사용자·채널 검사 → inbox 저장 → 모의 읽기 어댑터의 질의 템플릿 → 근거·미확인 포함 응답 → 재시작 뒤 대화·작업 상태 유지 | AC-B3의 `mock`·`local_integration` 부분 |
| FOUNDATION 실연동 (T16b) | T13, T16a. 사람: Discord 서버·봇 계정·intent(D-17), Infisical 봇 시크릿 등록, `platform/bot-slot` `target` 변경 PR(라벨 `homelab-bot`, 작업자 8080, 경보 수신 8081) 검토·병합, 작업자 영속 쓰기 공간(설계 C.8 변경, T08b와 함께), D-14 봇 전용 구독 계정 준비와 시드 `auth.json` 등록(T16b 전(모델을 처음 쓰는 단계 전). 대화 레인이 여기서 처음 모델을 쓴다. 영속 공간에 첫 시드, 설계 E9), 첫 배포 승인, 시범 P-1 승인. T15의 blocked 항목 재확인([VERIFICATION.md](VERIFICATION.md) 끝 점검표 14개. 항목별 해소 티켓은 [DISCOVERY.md](DISCOVERY.md) §9) | T16a 흐름을 실제 Discord와 읽기 계정으로 → 첫 배포(설계 E9) → 봇 중단 경보 확인 | AC-B3 완료 판정 |
| PR_REVIEW (T17) | 착수 T16a, 완료 T16b. D-16 확정. D-18 Renovate 설치(T10). D-14 봇 구독 계정과 작업자 `auth.json` 시드(리뷰가 모델을 쓴다. T16b 전(모델을 처음 쓰는 단계 전)에 준비됨). Connector 설치 범위 축소가 됐는지 확인(축소는 T15에서 끝남, `homelab-bot-ops` 제외. 남긴 저장소 목록의 API 확인은 아직). 사람: 리뷰 App 생성·설치(시험 저장소부터), 키 등록, 봇 리뷰 저장소의 Codex 자동 리뷰 끄기(저장소별 Codex 설정), 허용 봇 작성자 ID 등록, 시험 PR 게시 승인, 시범 P-2 승인. webhook 경로(T08a) | 허용 PR opened → 서명·설치·저장소·작성자 게이트(허용 봇 작성자 포함) → 고정 리비전의 base·head 압축본 → 작업자 리뷰(구조화 출력) → 게시 직전 head 재확인 → `COMMENT` + Discord 요약 | AC-B4 |
| CODEX_BRIDGE (T18) | 착수 T16a, 완료 T16b. D-14·D-15 확정. D-14 봇 구독 계정과 첫 시드는 T16b 전(모델을 처음 쓰는 단계 전)에 준비됨. R08 연결 방식 판단(사용자 결정). 사람: R08 연결 방식 결정, 재시드가 필요할 때 재시드(절차는 T18이 정한다) | Discord 요청 → 봇 소유 `codex exec` 작업 → 질문(clarification) 전달 → 허용 사용자 답 → `exec resume` → 결과·diff 확인 → 전달 | AC-B5 |
| MEMORY_BRIEFING (T20) | 착수 T16a, 완료 T16b(예약 기능). 브리핑 시각은 T16a가 정한 값. 브리핑은 알림·리뷰·브리핑 채널(D-17). Codex 상태 연결은 T18 뒤 | 운영 결정 저장(출처·범위) → ACL 검색 → 수정·삭제 → 예약 브리핑 → 재시작 뒤 중복·누락 처리 | AC-B7 |
| CHANGE_PR (T19) | T17·T18. D-24 확정과 남은 세부(토큰 분리, ruleset E, App 이름, 설치 저장소, 허용 파일 경로). 사람: 봇 쓰기 App 생성·설치, 키 등록, 시험 PR 승인. 플랫폼이 이 신원의 PR을 자동 병합하지 않음을 확인(AC-P8. 못 하면 봇 PR을 만들지 않고 blocked) | 명시적 수정 요청 → 고정 SHA 압축본 작업 공간에서 수정·시험 → 별도 리뷰 세션 → 게시 정책 → 게시 서버가 git data API로 `bot/` 브랜치·PR → 사람 병합 뒤 읽기 전용 배포 확인 | AC-B6 |
| RELEASE_AUDIT (T21) | T17·T18·T19·T20. 독립 감사 세션 | `01` §9의 end-to-end 흐름 5개. 시범 운영 증거도 본다 | AC-B8 |

## 3. 수용 시험 계획 (`04` §4의 30개)

- 주 단계는 spec §7 AC-B3~B7의 배정이다. 여러 단계가 같은 시험에 기여하면 각 단계는 자기 경로만 검증하고 T21이 전체를 다시 본다.
- "T16a→T16b"는 T16a가 첫 증거(`mock`·`local_integration`)를 내고 T16b가 실연동 증거를 더한다는 뜻이다. T16a는 실연동 부분을 `blocked`(사유: 실연동 전, 해소: T16b)로 적는다.
- **보안 경계 시험(AUTH-01, READ-02, SEC-01·02, DATA-01, REVIEW-04, CHANGE-02)은 그 단계 경로에서 최소 `mock` 또는 `local_integration`으로 `pass`여야 한다**(spec §7 공통 규칙).
- "첫 증거"는 로컬에서 먼저 낼 등급, "실연동"은 사람 승인 자산에서 낼 등급과 지금 막는 것이다. 막는 것이 남은 채 끝나면 `blocked`와 해소 티켓을 적는다.
- 이 표는 계획이다. 시험 30개는 모두 아직 `not_run`이다(코드 없음). `04` §4가 말하듯 표의 존재는 시험 통과가 아니다.

| 시험 | 주 단계 | 함께 기여 | 첫 증거 | 실연동과 막는 것 | DISCOVERY가 더한 사례 |
|---|---|---|---|---|---|
| AUTH-01 | T16a→T16b | T17(PR 경로) | mock | `authorized_external`: D-17 서버·채널(T16b), 리뷰 App 시험 PR(T17) | Discord: 사용자 ID 문자열 비교, 스레드는 `parent_id`, DM(T16a 결정에 따라), 버튼 누른 사람, 봇·webhook 메시지 무시. GitHub(D-16 하위 결정): `MEMBER` 통과, `NONE`·`CONTRIBUTOR`·`FIRST_TIME_CONTRIBUTOR` 차단, 허용 봇 ID 통과, 허용 밖 봇 ID 차단, fork PR 차단, 댓글은 `comment.author_association`, Bot 댓글 무시 |
| AUTH-02 | T16a→T16b | T18(질문), T20 | local_integration | `authorized_external`: Infisical 허용 목록 변경(T16b) | 반영 지연을 수치로 기록(ESO 동기화). 비공개 스레드 접근 상실은 이벤트가 오지 않음 |
| EVENT-01 | T16a | T17 | local_integration | 없음 | Discord 메시지·상호작용 ID, GitHub `X-GitHub-Delivery`와 `(repo_id, pr, head_sha, comparison_revision, policy_revision)` |
| EVENT-02 | T16a→T16b(Discord 전달) | T17·T19(게시) | local_integration(모의 API) | `authorized_external`(T16b) | Discord `nonce` + `enforce_nonce`와 outbox 대조, GitHub 리뷰·PR 존재 조회 뒤 재시도 |
| EVENT-03 | T16a→T16b | T17 | local_integration | `authorized_external`(T16b) | Discord `after=` 대조(최대 100건), 보관 스레드는 봇 DB가 원본. GitHub 열린 PR 대조(수동 재전송 3일 한계) |
| EVENT-04 | T16a | T18 | local_integration | 없음 | 작업자 파드 소멸 → `unknown`, 자동 재실행 없음 |
| CHAT-01 | T16a→T16b | | local_integration | `authorized_external`: D-17 대화 채널(T16b) | `MESSAGE_CONTENT` 켬(기본)과 끔(명령/버튼 모드) 둘 다 |
| CHAT-02 | T16a→T16b | | local_integration | `authorized_external`(T16b) | 구독 해제(방법은 T16a), 보관된 스레드(1440분)의 재활성화 |
| READ-01 | T16a→T16b | | mock | `production_observation`: T13 뒤 T16b | 관측 불가와 등록 안 됨 구분, "정상"은 현재 증거가 있을 때만 |
| READ-02 | T16a→T16b | | mock | `production_observation`(T16b) | 허용 밖 LogsQL·MetricsQL 거부, 시간창 상한 초과 거부, Secret·ConfigMap·`pods/log` 요청 거부, Argo CD live ConfigMap 노출 여부 기록 |
| SEC-01 | T16a | T17 | mock | 없음 | 로그·PR 본문·변경된 `AGENTS.md`·Renovate 릴리스 노트 속 지시. 허용 봇 작성자의 PR 본문도 비신뢰 |
| SEC-02 | T17·T18·T19 각 경로 | | local_integration | 없음 | 작업자에서 환경 변수·CODEX_HOME·`auth.json`·SA 경로 접근, 작업 레인 비신뢰 코드(설치 스크립트·시험)에서 `auth.json` 읽기 시도, `shell_environment_policy` 실효, `codeload.github.com` 밖 GitHub 호스트 차단 |
| DATA-01 | T17 | T19 | mock | 없음 | 내부 로그 → public PR·공개 스레드 차단, `output_classification` |
| DATA-02 | T20 | | local_integration | 없음 | 백업 14일 보존 중 삭제 표식, 복원 뒤 재적용 |
| REVIEW-01 | T17 | | local_integration(평가셋) | `authorized_external`: 시험 저장소 | `04` §6 표. 옛 AIOps 관찰 기준(최소 표본, 위험 제안 0, 정답을 모델 입력과 분리)을 참고 |
| REVIEW-02 | T17 | | local_integration | 없음 | 새 head·base, 리뷰보다 먼저 병합 |
| REVIEW-03 | T17 | | local_integration | 없음 | 파일 수·diff 상한을 넘으면 `partial` |
| REVIEW-04 | T17 | | mock | `authorized_external` | `event` ≠ COMMENT, dismiss, merge, auto-merge 거부, `commit_id` 명시 |
| REVIEW-05 | T17 | | local_integration | 없음 | 자기 리뷰·댓글 이벤트 루프 차단, 봇 작성 PR은 허용 봇 ID로 정상 리뷰 |
| TASK-01 | T18 | | mock | local_integration: 실제 `codex exec`(구독 `auth.json` 뒤) | tool approval은 `capability=false`로 표시. R08(명시적 연결)의 사례는 T18의 연결 방식 판단 뒤 정한다(보류) |
| TASK-02 | T18 | | mock | 없음 | 질문 ID = `job_id + thread_id + 턴 순번`, 다음 resume가 시작된 뒤의 늦은 답 거부, 답한 사람 검사 |
| TASK-03 | T18 | | mock(JSONL fixture) | local_integration | "완료" 문자열 무시, 종료 코드·JSONL·diff 대조, SIGTERM 동작 기록 |
| CHANGE-01 | T19 | | local_integration | `authorized_external`: 시험 저장소, D-24 App | 증거 리비전 일치, 별도 리뷰 세션 |
| CHANGE-02 | T19 | | mock | `authorized_external` | merge, `/merges`, `/dispatches`, update-branch, GraphQL 병합·auto-merge, `bot/` 밖 ref, force push, 워크플로 파일 변경 거부 |
| CHANGE-03 | T19 | | local_integration | 없음 | 기준 브랜치 이동 때 보류, 사람 커밋 덮어쓰기 방지 |
| DEPLOY-01 | T19 | | mock | `production_observation` | Argo CD 60초 폴링 지연을 고려한 대기 |
| MEM-01 | T20 | | local_integration | 없음 | |
| BRIEF-01 | T20 | | local_integration | `authorized_external`: D-17 알림·리뷰·브리핑 채널 | |
| OPS-01 | T16a→T16b | | local_integration | 없음 | IDENTIFY 예산과 재연결 백오프, 알림 폭주 요약, 429 처리, 긴 Codex 작업 중 대화 요청(모델 호출 직렬 1, D-14) |
| OPS-02 | T16a→T16b | | local_integration | `production_observation`: T16b(E9) | readiness 연동, 봇 하트비트 체크, replicas 0, **Bun 위 네트워크 차단·복구(#10840)** |

### 3.1 단계별 시험 배정 요약

| 단계 | 배정 시험 | 낼 증거 | 판정 |
|---|---|---|---|
| T16a | AC-B3의 13개(AUTH-01·02, EVENT-01~04, CHAT-01·02, READ-01·02, SEC-01, OPS-01·02) | `mock`·`local_integration` | 실연동 부분은 `blocked`(해소: T16b) |
| T16b | 같은 13개 | `authorized_external`·`production_observation`을 더함. 첫 배포 증거 | AC-B3 완료 판정 |
| 시범 P-1(T16b 뒤) | 새 시험 없음 | 허용 채널 읽기 조회 실사용 관찰 | V1 판정 아님 |
| T17 | AC-B4: REVIEW-01~05, SEC-01·02, DATA-01, EVENT-02, PR 경로의 AUTH-01·EVENT-01·EVENT-03 | `mock`·`local_integration` 뒤 시험 저장소 `authorized_external` | AC-B4 |
| 시범 P-2(T17 뒤) | 새 시험 없음 | 시험 저장소 PR 리뷰 실사용 관찰 | V1 판정 아님 |
| T18 | AC-B5: TASK-01~03, SEC-02, 질문 경로의 AUTH-02 | `mock` 뒤 실제 `codex exec` `local_integration` | AC-B5 |
| T20 | AC-B7: MEM-01, BRIEF-01, DATA-02, AUTH-02 | `local_integration`, 브리핑 채널 `authorized_external` | AC-B7 |
| T19 | AC-B6: CHANGE-01~03, DEPLOY-01, DATA-01, 변경 작업자 경로의 SEC-02, 게시 경로의 EVENT-02 | `mock`·`local_integration` 뒤 시험 저장소 `authorized_external` | AC-B6 |
| T21 | 30개 전부 다시 확인 | 단계별 증거 + 시범 증거 | `04` §9 판정 |

## 4. 범위 조정 (T15 할 일 6, spec §10 6번)

**선택: 안 3, 확정(사용자 2026-10-18, T15).** 에이전트 추천도 안 3이었다. 기능 수를 줄이는 안은 C-08 변경이라 제안하지 않았고 고르지도 않았다.

근거: 옛 AIOps는 "모든 생산자를 연결하기 전에는 시작하지 않는다"는 범위로 실제 진단을 한 번도 돌리지 못했다 [실측: 옛 문서와 journal]. 봇 V1도 필수 기능 7개, 요구 18개, 시험 30개로 일정 위험 1순위다(spec §4.5). 플랫폼 P2(T06~T13)는 사람 작업이 많은 긴 사슬이다.

| 안 | 내용 | 이득 | 대가 | 바꿔야 할 문서 |
|---|---|---|---|---|
| 안 1: STAGE별 제한 시범 운영 | 각 STAGE가 끝나면 그 기능을 승인된 시험 대상에서 실사용한다. V1 출시 판정 기준은 그대로 | 실사용 증거(`authorized_external`)가 일찍 쌓이고, 옛 AIOps의 "실사용 0" 실패를 피한다 | 단계마다 사람 승인과 `approvals.md` 기록이 는다. 시범 중 운영 잡음 | T16·T17 티켓에 시범 단계 추가. spec §8 그래프는 그대로 |
| 안 2: 로컬·mock 선행 | T16을 둘로 나눈다. T16a(로컬·mock: 공유 계약, 스키마, Discord·읽기 어댑터 모의, 작업자 계약)는 T15 뒤 바로, T16b(실연동·첫 배포)는 T13 뒤. T17·T18·T20의 로컬 구현도 T16a 뒤 시작할 수 있다 | 플랫폼 구축을 기다리는 시간에 봇 코드가 나아간다 | T13 실측이 계약을 바꾸면 고칠 일이 생긴다. 실연동 완료를 주장하지 않도록 증거 등급을 엄격히 나눠야 한다 | spec §8.1 표와 §8.2 그래프(T13 → T16 간선을 T16b로), T16 티켓 분할, AC-B3 배정 |
| **안 3 (선택): 안 1 + 안 2** | 둘을 함께 | 둘의 이득 | 둘의 대가 | 둘의 변경 |

### 시범 운영 단계

| 시범 | 시작 시점 | 실사용 범위 | 승인·기록 | 증거 등급 |
|---|---|---|---|---|
| P-1 | T16b 완료 뒤 | 허용 채널에서 읽기 조회만 | 시작 전 사람 승인, `approvals.md` | `authorized_external`, `production_observation` |
| P-2 | T17 완료 뒤 | 시험 저장소에서 PR 리뷰만. 대상 저장소를 늘릴 때마다 다시 승인 | 같음 | `authorized_external` |
| 그 뒤 | T18·T19·T20 뒤 | 정하지 않았다. 각 단계 HANDOFF가 범위를 제안하고 사람이 승인한다 | 같음 | 같음 |

- 시범은 V1 출시 판정이 아니다. V1 판정 기준은 `04` §9 그대로다.
- 시범 중 경계 위반(허용 밖 사용자 응답, 내부 자료 게시, `COMMENT` 밖 게시)이 보이면 시범을 멈추고 해당 시험을 `fail`로 기록하는 것을 제안한다 [가정].
- P-2 대상이 public 저장소면 D-14의 남는 위험(공식 문서의 "public or open-source repositories" 문구)에 바로 해당한다. 시범 승인 때 OpenAI 확인 결과를 함께 적는 것을 제안한다 [가정].

관련: D-16의 "일정 절충"(T17 전까지 Codex를 임시 시범 리뷰어로)은 범위 조정이 아니라 D-16 선택지였고, D-16은 기본안으로 확정됐다.

## 5. T16~T21 티켓 갱신 목록 (spec §12)

homelab 쪽 반영은 homelab `rebuild` 변경으로 한다(커밋·push는 사람 승인 뒤). 아래는 고칠 내용의 목록이다.

| 대상 | 고칠 것 |
|---|---|
| spec §8.1·§8.2 | T16을 T16a·T16b로 나눈다. 간선은 §1과 같다: T15 → T16a, T13 → T16b, T16a → T16b, T16a → T17·T18·T20(착수), T16b → T17·T18·T20(완료), T16b → T22. 위상 순서와 검사 문장을 다시 쓴다 |
| T16a(새 티켓) | 공유 계약(스키마, outbox, 게시 계층) 소유. Discord 어댑터를 D-17 기본값으로 모의 시험. 작업자 계약(D-14·D-15: 포트 8080, 동시성 1, `codeload.github.com` 압축본 + `git init`, waiting). 대화 레인의 호출 경로와 동시성을 D-14에 맞춰 정함(ARCHITECTURE §2·§9). 질의 템플릿과 시간창 상한(보존 기간과 따로). DM 허용 여부·브리핑 시각 결정. AC-B3 `mock`·`local_integration` |
| T16b(새 티켓, 옛 T16 대체) | T15 blocked 재확인(VERIFICATION 끝 점검표 14개. 항목별 해소 티켓은 DISCOVERY §9). Discord 준비(D-17 사람 작업). `target` 변경 값(라벨 `homelab-bot`, 작업자 8080, 경보 수신 8081). 작업자 배치(동시성 1, egress `codeload.github.com`만, 영속 쓰기 공간, U13 실패 때 호스트 UID + nft). D-14 봇 구독 계정 준비와 작업자 `auth.json` 첫 시드(T16b 전(모델을 처음 쓰는 단계 전), 설계 E9), 모델·인증 호스트 egress 실측, 재생성 뒤 `auth.json`이 시드로 덮이지 않음 확인. OPS-02 readiness·하트비트, Bun 단절 시험. Grafana 질의 템플릿·토큰 키 이름. 시범 P-1. AC-B3 완료 |
| T17 | Blocked by T16a(착수)·T16b(완료). D-16 결과(허용 봇 작성자 목록과 ID 등록, 허용 작성자 PR 본문 비신뢰, 저장소별 Codex 자동 리뷰 끄기, Connector 설치 범위 축소 확인. 축소는 T15에서 끝남, 남긴 저장소 목록의 API 확인은 아직). 리뷰어는 GitHub 자격 없이 base·head 압축본만(D-15). 외부 자동 리뷰를 고를 때 필요했던 REVIEW-04·DATA-01 경계 재정의는 빠진다. 리뷰 모델은 T16b 전(모델을 처음 쓰는 단계 전)에 준비한 D-14 계정·시드를 쓴다. D-14 남는 위험. 시범 P-2 |
| T18 | Blocked by T16a(착수)·T16b(완료). D-14 결과(조건 다섯, 재시드 절차). 봇 전용 구독 계정과 첫 시드는 T16b 전(모델을 처음 쓰는 단계 전)에 준비됨. Codex 능력 표시(ARCHITECTURE §4). R08 연결 방식 판단과 사용자 결정(보류 해소). `shell_environment_policy` 고정. SEC-02의 `auth.json` 사례. 인증 파일 분리와 레인 분리 검토(ARCHITECTURE §5.1) |
| T19 | D-24 결과와 남은 세부(토큰 분리, ruleset E, App 이름, 설치 저장소, 허용 파일 경로). 게시 서버 허용 API 목록. 작업자는 GitHub에 쓰지 않고 게시 서버가 git data API로 커밋. 워크플로 변경 불가 범위 축소. App 봇 사용자 ID를 허용 봇 작성자 목록에 등록 |
| T20 | Blocked by T16a(착수)·T16b(완료). 브리핑 시각(T16a 결정), 브리핑 채널(D-17 알림·리뷰·브리핑). 백업 14일 기준의 삭제 표식·복원 재적용 정책 |
| T21 | 시범 운영 증거(P-1, P-2와 그 뒤 시범)를 판정 근거에 넣는 방법. 판정 기준은 `04` §9 그대로 |
| T22 | Blocked by의 T16을 T16b로. D-29 비앱 저장소 처리 변경(사용자 2026-10-18 17:46): `aiops`·`mac-uptime-guard` 제거, `aiops-autodeploy-canary` private 보관. `mac-uptime-guard`는 장치를 끄고 옛 Telegram 봇 토큰을 폐기한 뒤(T06 표의 `보류(D-10, T22)` 줄을 닫음) 저장소를 삭제한다 |
| T08b(범위 밖, 함께 고침) | 작업자 전용 영속 쓰기 공간(D-14, 설계 C.8 변경). 작업자 egress의 GitHub 호스트를 `codeload.github.com`만으로(D-15) |
