# homelab-bot

T16a FOUNDATION 구현. Discord 수신 → 권한 검사 → PostgreSQL 저장 → 제한 조회 또는
직렬 모의 작업자 → outbox → Discord 게시를 로컬에서 검증한다.
상태는 `LOCAL_VERIFIED_INTEGRATION_PENDING`이다. 운영 실행·배포 진입점은 아직 없다.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
```

시험은 외부 Discord·GitHub·플랫폼·모델에 연결하지 않는다. PostgreSQL 엔진인
PGlite와 임시 디스크 DB, loopback HTTP 서버, 주입한 Gateway/REST·관측·모델 모의를 쓴다.
시험 데이터는 합성 값이다. 임시 파일은 무시되는 `.local/` 안에서 만들고 지운다.
패키지 설치 외 네트워크는 필요하지 않다. 실제 PostgreSQL 서버의 다중 연결·CNPG·RBAC는 T16b 검증이다.

## 버전

직접 의존성과 개발 도구는 `package.json`, 전이 의존성은 `package-lock.json`에 정확히 고정했다.
설치 시 npm registry의 stable version을 확인했다. Codex 패키지는 계약 버전 고정용이며 시험에서 실행하지 않는다.

- Node **24.22.0**: 최신 major보다 낮게 고정. DISCOVERY에서 정한 Node 24 대안과 현재 로컬 검증 환경을 유지한다.
  Bun의 재연결 위험을 FOUNDATION 로직과 분리하려는 선택이다. 런타임 major 변경은 T16b 연동 검증 뒤 한다.
- npm **11.19.1**: 현재 Node 24 환경의 설치 도구를 고정했다. 최신 npm 12로 바꾸는 것은 런타임 major와 함께 검증한다.
- TypeScript **7.0.2**, pg **8.23.1**, zod **4.6.7**, PGlite **0.5.10**,
  @types/node **24.19.2**, @types/pg **8.23.1**, @openai/codex **0.163.0**, undici **7.30.1**.
  Node 타입은 최신 24.x로 런타임 범위에 맞춘다. undici는 최신 7.x로 Node 24 내장 fetch와 호환한다.
  8.x Agent는 내장 fetch와 `invalid onRequestStart method` 오류가 발생해 제외했다.
  작업자 HTTP의 headers/body timeout은 요청 예산 + 30초이며 호출자 취소 신호는 그대로 적용한다.

## 연결 지점

| 모듈 | 책임 |
|---|---|
| `src/database.ts`, `src/store.ts`, `migrations/001_foundation.sql` | PostgreSQL 트랜잭션, inbox·jobs·outbox·대화·예약 기반, lease·fencing·재시작 |
| `src/policy.ts` | 매 접근 때 정책 파일 재읽기, 5분 freshness, owner·scope 검사, 영속 즉시 거부 목록 |
| `src/discord.ts`, `src/discord-protocol.ts` | Gateway payload 정규화, 명령·버튼, 1440분 공개 스레드, ACK·REST·대조 |
| `src/read.ts` | 등록 서비스와 승인 템플릿, namespace·시간·행·바이트 제한, 현재 근거와 미확인 구분 |
| `src/worker.ts`, `src/worker-http.ts`, `src/runtime.ts` | 서명 capability, 포트 8080 HTTP 계약, 두 레인 합산 직렬 1, 취소·한도·unknown |
| `src/alerts.ts`, `src/health.ts`, `src/http.ts` | Alertmanager 사건 요약, 8080/8081 수신기, readiness·Gateway 지표·조건부 하트비트 |

외부 SDK와 인증은 주입 경계다. `DiscordProtocol.gateway()`에 인증된 Gateway frame을 전달하고,
REST는 `discordHttpApi(token, fetch)`를 주입한다. 직접 호출하지 않는 한 네트워크를 열지 않는다.
`receivers()`·`workerServer()`도 반환만 하며 호출자가 명시적으로 listen해야 한다.
게시 서버 수신 포트는 8080, 경보는 8081, 작업자 Service는 8080이다.

`Postgres`에는 전용 DB/역할의 `pg.Pool`을 주입한다. `migrate()`는 빌드 결과에서 호출한다.
운영 마이그레이션은 T16b의 Sync hook Job에서 실행한다. `001`은 초기 스키마, `002`는 철회 당시 정책 revision, `003`은 철회 ID·게시 일시 중지 상태, `004`는 결과별 서비스 접근 범위, `005`는 메시지 페이지 순서·경보 전달 키·기존 read 유형을 보완한다.
`006`은 서비스 범위를 복원할 수 없는 기존 미전달 경보를 blocked로 두고 감사한다. 새 경보 수신은 서비스 범위를 가진 새 세대를 만든다.
`007`은 복구 buffer·구독 세대/활성화 커서·복구 lease·게시 dispatch 표식을 추가한다. 기존 sending/unknown은 전송 가능성이 있는 것으로 이관한다.
후속 티켓도 기존 파일을 변경하지 않고 expand/contract 후속 파일을 추가한다.

## 사용 계약

허용 채널에서 멘션 또는 `/chat`으로 시작한다. `/read text:<template-id> target:<service-id>`는
최근 min(60초, 템플릿 상한)의 승인 템플릿을 실행한다. 시간창 상한은 유한한 1초 이상이어야 한다. `/task`는 모의 작업 레인 계약이다.
`/read`는 독립 job으로 즉시 대기열에 들어가며, 후속 chat/read가 앞선 조회를 합치거나 폐기하지 않는다.
활성 스레드 후속 메시지는 멘션 없이 받고, intent를 끄면 명령/버튼만 받는다. `/urgent`는 debounce를 건너뛰고 후속 일반 chat에도 priority 0을 유지한다.
`/stop`, `/resume`, `/list`, `/cancel target:<job-id>`, `/retry target:<job-id>`,
`/emergency-stop`, `/model-status`, `/resume-model target:<job-id|emergency-stop>`,
`/revoke target:<actor-id>`는 모델을 거치지 않는다.
버튼의 custom ID는 `list`, `stop`, `resume`, `cancel:<job-id>`만 허용한다.
실제 slash 명령 등록·Gateway 연결은 T16b다.

ACK 전에 이벤트와 처리 경로(job 또는 outbox, 제어 결과)를 영속 저장한다. 복구 중 live 입력은
대화별 최대 100건의 DB buffer에 저장한 뒤 ACK하고, 복구 끝에 같은 대화 잠금으로 수락·인계한다.
수신 처리 transaction은 PostgreSQL 18의 transaction_timeout과 남은 시간별 statement_timeout으로
1500ms 마감을 적용하고 최종 갱신 뒤에도 검사한다. 마감 내 commit한 뒤 응답만 잃은 경우의
수락 여부는 단정하지 않으며 같은 이벤트 ID로 중복 작업을 만들지 않는다.
상호작용 callback의 절대 마감은 Gateway 어댑터 진입 시각 + 2500ms다. 채널 조회·저장 시간을
모두 포함하고 HTTP 전송도 min(1000ms, 남은 시간)만 사용한다. 만료 뒤 callback을 시도하지 않는다.
ACK 응답 유실은 `ack_uncertain` 감사 기록을 남기고 이미 수락한 작업을 계속한다.
상호작용 응답의 만료·유실은 처리 스레드/DM에 상태 확인 안내를 한 번 보낸다. 새 스레드는 생성 확인 뒤 안내한다.
thread/DM의 모든 입력·복구·실행·게시에서 기존 대화 owner 일치를 확인한다. 모델 맥락은 같은 owner의
해당 job event_order 이하 수락 이벤트만 포함한다. buffer의 event_order는 실제 수락 때 재배치한다. 후속 요청은 자기 job에서 처리한다.
같은 이벤트 ID의 accepted 상태를 행 잠금 안에서 검사한다. 이미 수락했으면 종료하고,
미수락 inbox는 저장된 입력으로 처리 경로를 다시 만들어 save 직후 종료·transaction rollback을 복구한다. 부모 채널은 구독하지 않으며 매번 멘션/명령이 필요하다.

`queued/running/waiting_user/verifying/succeeded/failed/cancel_requested/cancelled/unknown/superseded`를
구분한다. 한도·인증 만료는 `waiting_user` + `model_limit/auth_expired`이며 모델 스케줄러를 정지한다.
waiting_user와 scheduler 중지는 한 transaction으로 기록한다. 기록 실패 시 슬롯을 보존하며,
waiting_user 자체도 다음 모델 실행을 막는다. 자동 계정 변경은 없다. unknown과 외부 게시 결과 불명은 자동 재실행하지 않는다. 게시 호출 전 DB 오류는 pending backoff로
돌린다. REST 직전 durable dispatch 표식을 기록하고, lease 만료 때 표식 없는 claim만 안전하게 재시도한다.
표식 기록 직후 프로세스 종료는 원격 요청 여부를 확정할 수 없어 unknown이다.
실행 중 권한 철회가 확인되면 종료 확인 후 `cancelled/authorization_revoked`, 종료 불명은
`unknown/authorization_revoked`로 남긴다. 실패 안내와 `/retry` 대상은 만들지 않는다.
완료와 교차한 monitor의 인가 결과도 반영하고, 정상·실패·한도·인증 만료 결과 모두 현재 정책을 확인한다.
확인된 한도·인증 만료는 일반 monitor DB 오류 때문에 재시도 가능한 실패로 바꾸지 않는다.
`/model-status`로 현재 중지 원인과 현재 대화의 waiting_user를 확인한다. 사람이 한도 창/인증 문제를
해소한 뒤 같은 대화에서 `/resume-model target:<job-id>`로 재개하거나 `/cancel target:<job-id>`로 포기한다.
재개는 대화 owner·대기 사유·구독·gap·100건 큐·총 3회 실행 상한을 확인하며 이전 lease를 지운다.
작업 전이·scheduler 해제·제어 응답은 함께 저장한다. `/resume`는 계속 대화 구독만 제어한다.
비상 중지는 `/resume-model target:emergency-stop`으로 명시 해제하며 실행 중/종료 불명 작업이 있으면 거부한다.
남은 waiting_user가 있으면 비상 중지를 해제해도 scheduler는 멈춘 채다. 이전 버전의 원인 없는 중지도
비상 중지로 보수적으로 취급해 이 확인을 먼저 요구한다. 자동 인증 복구·계정 전환은 없다.
unknown worker의 실제 종료 증거 수집과 운영 복구는 T16b/T18에서 연결한다.

정책 파일에는 `revision`, `confirmedAt`, `owner`, `guild`, `conversationChannel`,
`notificationChannel`, `dmEnabled`, `services`가 필요하다. 실제 값은 Infisical에서만 전달한다.
`confirmedAt`은 신뢰된 동기화 주체가 원본 revision 확인에 성공한 시각이다. 파일 mtime이나
읽은 시각으로 freshness를 갱신하지 않는다. 그 동기화 주체·Secret 마운트는 T16b가 연결한다.
구성 예시는 키 이름만 포함하며, 그대로 사용하면 오래된 정책으로 거부된다.
정책 누락·stale 동안 queued는 1초 뒤 재검사한다. pending은 1초부터 최대 60초까지 지수 backoff하며,
일시 중지 사유가 바뀔 때만 감사한다. 이미 인가해 시작한 모델은 heartbeat를 유지해 완료하고 게시는 새 정책을 기다린다.
정책 revision 변경 자체는 거부 사유가 아니다. `/revoke`는 거부를 추가하며, 해제하려면
철회 시각 이후 원본을 확인한 다른 revision이 owner·scope를 허용하고, 사람이 해당
`denied_actors.denial_id`를 정책의 `revocationRestores` 목록에 명시해야 한다. 무관한 정책 변경은 해제하지 않는다.
다시 철회하면 새 ID를 발급해 이전 해제 승인을 재사용하지 못한다.
Discord 401은 게시를 pending에 두며 자격 갱신 뒤 새 REST 어댑터를 주입해야 한다.
게시 POST의 400/403/404는 확정 거부로 즉시 blocked와 감사 기록을 남긴다. 408/409/5xx·응답 유실은
미전송을 단정하지 않고 unknown을 유지한다. 대조 GET의 404는 과거 POST의 미전송 증거가 아니다.

읽기 템플릿은 운영자가 사전 승인해 생성자에 전달한다. 사용자·모델은 쿼리 문자열이나
데이터소스·namespace를 바꿀 수 없다. Grafana/K8s/Argo CD의 실제 응답을
`ReadTransport`의 제한된 observation 형식으로 투영하는 연결은 T16b에서 실측하며,
Secret·ConfigMap·환경변수 원문을 observation에 넣지 않는다.
로그 원문은 내부 result에만 남고 공개 스레드에는 결정적인 상태 요약만 보낸다.
결과와 경보의 outbox.service_ids를 게시·대조 직전에 재인가하므로 전달 대기 중 서비스 철회도 적용된다.
경보 thread·초기 요약·후속 요약·대기 병합 모두 서비스 범위를 유지한다.
조회 요약은 항목별 예산과 생략 건수를 표시해 미확인·권장 확인을 보존한다. 긴 /list는 모든 작업을
독립적으로 유효한 JSON 배열 페이지로 나누며, 각 페이지의 nonce/marker는 서로 다르다.
페이지는 한 transaction으로 저장하고 앞 페이지가 sent일 때만 다음 페이지를 게시한다.
앞 페이지의 pending/unknown/blocked 동안 뒤 페이지는 대기하며 공유 rate limit이 없는 다른 메시지는 진행한다.
원격 생성 ID를 저장한 행은 현재 인가 뒤 그 ID로 로컬 confirm을 재시도하고 marker를 검색하지 않는다.
로컬 확정은 REST rate limit 대기와 분리하며 실패 시 1초~60초 backoff한다. 확정 ID 없는 unknown만
100건/24시간 불명 한도와 bounded marker 검색을 적용한다. 확정 ID는 보존하며 원격 재게시하지 않는다.
unknown 게시 대조가 429를 만나면 루프를 중단하고 retry_after까지 DB에 기록한 시각을 기다린다.
비전역 429는 채널 전체를 최소 1초 또는 retry_after 중 긴 시간 동안 영속 중지한다. 같은 채널의
다른 route도 보수적으로 함께 대기하고, 다른 채널은 진행한다. bucket 헤더는 오류·감사에 보존한다.
`global: true` 429는 영속 전체 중지 시각을 갱신한다. 새 delivery claim·대조·ACK·history는 그 시각까지 호출하지 않는다.
복구 중 gap은 새 작업의 claim·결과 게시를 지연하지만 진행 중 모델/read의 완료 결과를 폐기하지 않는다.
`/stop`은 구독 해제로 별도 처리한다. 활성화는 수락 transaction에 포함하며, 재개 메시지/명령의
커서 이전 메시지는 복구·지연 live 입력에서도 실행하지 않는다. 복구는 세대·token을 확인해 중지 이전
작업이 새 구독을 바꾸지 못하게 한다. dispatch 전 정책 대기와 취소가 겹치면 worker 호출 없이 cancelled로 확정한다.
차단된 경보 thread/요약 뒤 새 수신은 같은 fingerprint라도 새 세대 키로 수락한다.
아직 pending/sending/unknown인 스레드는 합쳐 대조하며, 스레드 확정·요약 저장·sent 기록은 원자적이다.

## 후속 작업의 경계

T16b는 실제 PostgreSQL·Gateway 세션 연결, 라이브 조회 응답 투영, 실제 Codex 실행기,
전용 CODEX_HOME·네트워크 격리, 지속 capability 재생 방지 저장소, 정책 갱신 확인,
Gateway 재연결·경보 규칙·하트비트 연결과 첫 배포를 맡는다.
작업자 /v1/cancel은 `{job, lease}`를 필수로 받고 capability·현재 실행·중단 어댑터 모두 같은 lease를 사용한다.
capability는 발급 시각이 검증기보다 최대 1000ms 앞서는 것만 허용한다. 발급→만료 30초 상한과
만료 시각·서명·본문·job/lease·일회 사용 검증은 유지한다.
작업자 검증기는 `consume(nonce)`에 **원자적·영속적인 일회 사용 기록**을 요구한다.
시험의 메모리 Set은 재시작 보안을 증명하지 않는다.

T17의 GitHub 리뷰·설치/저장소 게이트와 PR 대조, T18의 실제 작업 실행·질문·재개·프로세스 격리,
T20의 기억·예약 실행은 구현 범위 밖이다. 스키마의 예약 행은 보존만 하며 아직 실행하지 않는다.
DM과 브리핑 시각은 사용자 결정 전 `null`이다. 상세 결정과 증거 범위는
[ARCHITECTURE](docs/ai-bot/ARCHITECTURE.md), [VERIFICATION](docs/ai-bot/VERIFICATION.md)에 있다.

복구 after 커서의 정렬/선택 범위 판정과 문서 근거는 [DISCORD_RECOVERY.md](docs/ai-bot/DISCORD_RECOVERY.md)에 있다.
checkpoint가 없을 때도 after=0을 명시해 최초 페이지를 건너뛰지 않는다. 서버 실측은 T16b다.
