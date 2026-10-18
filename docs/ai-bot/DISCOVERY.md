# DISCOVERY: 봇 V1 환경 조사 (공개판)

- 단계: `TARGET=V1`, `STAGE=DISCOVERY`, `MODE=plan` (homelab 티켓 T15). 조사일 2026-10-18. 초안.
- 기준 문서: 봇 문서 `00`·`01`·`04`(봇 저장소 `ukyi-app/homelab-bot@71c74a7`의 `docs/ai-bot/prompts/`), homelab 명세 `spec.md` §1·§4.5·§5와 플랫폼 설계 `platform/design.md` C.8·F(`ukyi-app/homelab`의 `rebuild` 브랜치 `8bdbfa2`, 경로 `docs/plans/2026-10-17-homelab-rebuild/`), 티켓 T15.
- 방법: 읽기 전용. 계정 생성, App 설치, PR·댓글·리뷰 게시, 배포, 설정 변경을 하지 않았다. GitHub는 `gh api` GET만 썼다. 모델 호출(`codex exec`, 대화, herdr 에이전트 시작)을 하지 않았고 Codex·herdr는 `--help`와 버전만 실행했다. 개인 CODEX_HOME의 내용과 인증 파일은 읽지 않았다.
- 꼬리표: `[확인: 출처, 확인일 2026-10-18]` 공식 문서나 계획 문서(계획 문서가 출처면 설계 의도이지 구축된 사실이 아니다), `[실측: 명령과 결과 요지]` 읽기 전용 실행 결과, `[가정]` 근거 있는 추론, `[미확인]` 확인하지 못한 것. 플랫폼 구축 뒤에만 볼 수 있는 것은 `blocked`와 해소 시점을 함께 적는다. 확인일은 모두 2026-10-18이라 꼬리표마다 다시 적지 않은 곳이 있다.
- 공개 범위: 이 파일은 public 봇 저장소용이다(D-13, D-29). 내부 경로, 실제 허용 목록 값, 조직 내부 식별자(사람 계정 이름, 비공개 App·설치·ruleset ID)는 private 운영 저장소 `ukyi-app/homelab-bot-ops`의 내부판과 evidence에만 둔다.
- 결정: 이 문서는 조사 결과다. D-14~D-17·D-24는 확정(사용자 2026-10-18, T15)이고 기록과 근거는 [DECISIONS.md](DECISIONS.md)에 있다. R08 연결 방식은 T18에서 다시 판단한다(보류). 능력표는 [VERIFICATION.md](VERIFICATION.md), 설계 제안은 [ARCHITECTURE.md](ARCHITECTURE.md)에 있다.

## 0. 결론

1. **새 플랫폼은 아직 서 있지 않다.** 옛 클러스터가 돌고 있고 homelab `rebuild` 브랜치에는 계획 문서만 있다 [실측: `gh api` 브랜치·트리 조회]. 봇이 기대는 플랫폼 자리(읽기 계정 셋, 격리 공간, webhook 경로, 경보 수신자, ruleset A~D, 배포·병합 App)는 설계로만 답했고, 실측은 **blocked(해소: T13 뒤, T16b 시작 때 재확인)**다.
2. **Discord:** 멘션 없이 이어지는 스레드 후속 메시지를 읽으려면 `MESSAGE_CONTENT` 특권 intent가 필요하다. 사용자 수가 적은 봇은 Developer Portal 토글로 켤 수 있다 [확인: https://docs.discord.com/developers/events/gateway , https://docs.discord.com/developers/gateway/getting-started-with-privileged-intent-review]. D-17로 켜기로 정했다. 실연동은 봇 계정·서버가 없어 blocked다.
3. **Codex:** 봇 소유 작업은 작업자 파드 안에서 `codex exec --json`을 직접 부르는 경로가 맞다. 이 경로에는 사람에게 도구 승인을 묻는 통로가 없어, V1은 질문(clarification)만 `exec resume`으로 중계하고 도구 승인 중계는 `capability=false`다 [실측: `codex exec --help`에 `-a` 없음]. 승인·중단 API가 있는 `codex app-server`는 공식 문서가 "운영 미지원 실험"이라 적는다.
4. **herdr:** 봇 경로에서 뺀다. 상태를 화면에서 읽고, 질문과 승인을 구분하지 않으며, 사람의 herdr 소켓에 붙으면 개인 패널 전체를 제어하게 된다 [확인: https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/website/src/content/docs/integrations.mdx , 실측: 소켓 권한].
5. **GitHub:** 모델 호출 전 `author_association` 확인(OWNER·MEMBER·COLLABORATOR)은 App이 만든 PR을 막는다. App PR은 `NONE`이나 `CONTRIBUTOR`로 찍혔다 [실측]. Renovate·봇 PR 리뷰(V1 기능 7)를 지키려면 허용 봇 작성자 목록이 필요하다. D-16 하위 결정으로 정했다.
6. **Codex Connector(D-16 대안):** 사람 PR 7건은 자동 리뷰했지만 봇 PR 1건은 리뷰하지 않았다. 결과는 GitHub API로 읽을 수 있으나 상태 형식이 비공식이고 11일 사이 바뀌었다 [실측]. 자동 리뷰는 저장소별 설정과 개인 설정이 함께 있어 저장소마다 끌 수 있다 [확인: https://learn.chatgpt.com/docs/third-party/github]. D-16은 기본안으로 정했다.
7. **모델 계정(D-14):** OpenAI 공식 문서는 자동화에 API 키를 권한다. 구독 인증의 무인 실행은 조건이 붙은 "고급" 경로이고 공개·오픈소스 저장소에는 쓰지 말라고 한다 [확인: https://learn.chatgpt.com/docs/auth , https://learn.chatgpt.com/docs/auth/ci-cd-auth]. 사용자는 에이전트 추천(API 키)이 아니라 봇 전용 ChatGPT 구독 계정을 골랐고, 공개 저장소 문구의 적용 범위는 OpenAI 확인 항목으로 남았다. Codex 밖 구독 OAuth 프록시와 여러 계정 순회는 공식 지원 밖이라 새 봇은 채택하지 않는다.
8. **설계 빈틈 셋(읽기 조회):** Grafana OSS Viewer는 모든 데이터소스를 질의할 수 있어 로그 제외가 플랫폼 권한으로 서지 않는다 [확인: https://grafana.com/docs/grafana/latest/administration/roles-and-permissions/ + 가정]. Argo CD `get`만으로 live ConfigMap 내용이 보이는지 모른다 [미확인]. 봇이 쓸 Grafana·Argo CD 토큰의 보관 위치가 설계에 없다 [확인: T08b 티켓].
9. **봇 중단 경보:** 설계는 "파드가 죽은 경우"만 잡는다. 살아 있으나 멈춘 봇과 replicas 0을 잡는 장치가 없다 [가정: 핵심 룰 목록 기준]. 봇 쪽 연결 제안은 ARCHITECTURE §8.
10. **옛 AIOps:** 권한·게시 경계는 잘 세웠지만 실제 모델 진단을 운영에서 한 번도 돌리지 못하고 멈췄다 [실측]. 가져올 것은 경계 설계, 피할 것은 처음부터 넓은 범위와 늦게 정한 모델 접근 경로다.

---

## 1. 질문 1: 저장소, 지침, CI, 운영 계약

**답:** 배포 설정은 `ukyi-app/homelab`(public), 봇 코드는 `ukyi-app/homelab-bot`(public), 봇 운영 산출물은 `ukyi-app/homelab-bot-ops`(private)다 [확인: spec §5.1 C-01·D-13·D-29]. 봇 저장소에는 아직 프롬프트 문서만 있고, 앱 템플릿과 CI는 E5(T10) 전이라 옛 내용이다.

**확인(계획 문서)**

- 봇 배포 설정은 homelab의 `apps/homelab-bot/`·`data/homelab-bot/`, 봇 쪽 platform 리소스는 `platform/bot-slot/`, ns는 `app-homelab-bot`, Infisical은 `/apps/homelab-bot/`(게시 서버)와 `/apps/homelab-bot/worker`(작업자)다 [확인: spec §5.1 D-13, 설계 C.8, 2026-10-18].
- 운영 계약(설계상): 앱 코드 → GHCR → 배포 갱신 App의 digest PR → 조건 9개를 만족하면 자동 병합 → Argo CD 60초 폴링 → 배포 [확인: 설계 C.4.1·C.4.7, spec §5.1 "설계 기본값"]. 공유 차트는 non-root, 읽기 전용 루트, SA 토큰 미마운트(봇만 `serviceAccountName: bot-reader`), requests·memory limit 필수, 기본 거부 + 허용 목록(인터넷 443에서 사설·tailnet 대역 제외)이다 [확인: 설계 C.4.5]. DB 마이그레이션은 Argo CD Sync hook Job + expand/contract다 [확인: spec §5.1 D-22].
- 새 구조의 homelab `AGENTS.md`는 설계에 이름만 있고 내용은 아직 없다 [확인: 설계 C.1].

**실측**

- homelab: 원격 main은 옛 커밋 `2d2054a` 그대로이고, `rebuild`에는 계획 문서만 있다. Actions는 꺼져 있다. 보호는 옛 상태다(필수 검사 `gate`, 승인 0, `enforce_admins=false`, 옛 ruleset 2개, `allow_auto_merge=true`) [실측: `gh api` 브랜치·보호·ruleset·저장소 조회]. 새 ruleset A~D와 `allow_auto_merge=false`는 T06(임시)·T10(정식) 몫이다 [확인: 설계 E1·C.4.7].
- homelab-bot: public, 파일 6개(`.github/CODEOWNERS`와 `docs/ai-bot/prompts/00`~`04`). `AGENTS.md`, CI 워크플로, Actions 실행, webhook, environment가 모두 0이다. `app-main` ruleset이 active다(PR 필수, 승인 1, code owner, 새 push 때 승인 무효화, force push·삭제 금지, bypass는 저장소 관리자 역할 `pull_request` 모드 하나, App bypass 없음). `CODEOWNERS` 오류 0. secret scanning·push protection·private vulnerability reporting 켜짐, fork PR 승인 `all_external_contributors`, interaction limit 없음. 병합 방식은 merge·squash·rebase 모두 허용, 병합 뒤 브랜치 삭제 꺼짐, auto-merge 꺼짐 [실측: `gh api` 저장소·트리·ruleset·보안 설정 조회].
- homelab-bot-ops: private, 빈 저장소(커밋 없음) [실측: 트리 조회 → 409 "Git Repository is empty"]. Free라 보호 규칙을 걸 수 없다 [확인: spec §4.5].
- homelab-app-template·files: 옛 내용(옛 reusable 워크플로 호출, 옛 SealedSecrets 도구, 매주 스키마 받기). `AGENTS.md`는 5줄 리뷰 규칙뿐이다. `app-main` active. **private vulnerability reporting은 꺼져 있다** [실측: `gh api` GET `private-vulnerability-reporting` → `enabled:false`]. 기준 리비전(`rebuild@8bdbfa2`)의 설계 C.3.9는 결정 5 하드닝이 이것을 먼저 켰다고 적지만 실측은 false다. spec 결정 5 목록에도 이 항목이 없어 spec과 설계가 서로 다르다. D-29 기본 설정은 켬이다. 템플릿에 옛 쓰기 App이 연 renovate PR 5개가 열려 있다 [실측].

**가정·미확인**

- 지금 봇 저장소에는 tailnet 이름 같은 D-23·D-29 금지 항목을 기계로 막는 CI가 없다. 템플릿(D-21)의 금지 패턴 검사가 들어오기 전까지는 사람이 지운다 [실측: 봇 저장소 PR #2가 공개 문서에서 내부 식별자를 지운 기록].
- 앱 저장소의 병합 방식 기준(squash만인지, 병합 뒤 브랜치 삭제인지)은 설계에 없다 [미확인].
- `files`·템플릿의 private vulnerability reporting이 꺼진 채면 설계의 E5 guard(저장소 설정 확인)가 두 저장소에서 실패할 것이다 [가정: 설계 C.3.9 guard 항목 2]. 이 불일치는 homelab `rebuild` 변경에서 설계 C.3.9 정정과 spec §11 사람 작업(T10 guard 첫 실행 전 켜기)으로 반영됐다(§11).

## 2. 질문 2: 실행 호스트, 영속 상태, 작업 실행기, 봇 중단 경보

**답:** 서버는 NUC 한 대이고(C-07), 설계상 게시 서버는 ns `app-homelab-bot`의 공유 차트 Deployment, 영속 상태는 공유 PostgreSQL의 봇 전용 DB, 작업자는 ns `sandbox`의 파드다 [확인: 설계 C.8, spec §5.1 D-05]. 남은 선택(D-15)과 봇 중단 경보 연결은 DECISIONS·ARCHITECTURE에 있다.

**확인(계획 문서)**

- 게시 서버가 받는 경로는 공개 webhook(`https://hooks.ukyi.app/github`, POST 한 경로, HMAC은 봇이 검증)과 클러스터 안 Alertmanager 수신뿐이다 [확인: 설계 C.8].
- 영속 상태: 공유 CNPG Cluster `pg` 안 봇 전용 DB·역할. 백업은 R2 `homelab-backups`, 14일. 큐 유실이 치명적이면 Valkey가 아니라 PostgreSQL에 둔다 [확인: spec §5.1 D-05·D-06].
- 작업자: 파드는 Git(Argo CD)만 만들고 봇에게 파드 생성 권한이 없다. 작업 전달은 봇 → 작업자 Service ingress 하나다. 작업자는 SA 토큰 없음, RBAC 없음, hostPath·hostNetwork·호스트 소켓 없음, Secret은 모델 자격 하나, egress는 허용 목록 프록시 하나(DNS도 막음)다 [확인: 설계 C.8 "격리 작업 실행 공간"].
- 격리의 남는 위험 둘: Infisical Free에 경로 RBAC가 없어 store identity가 같은 프로젝트의 다른 경로도 읽을 수 있다. 프록시는 CONNECT 호스트 이름만 봐서 `github.com`을 허용하면 읽기와 쓰기를 가르지 못한다 [확인: 설계 C.8·C.6.3].
- 봇 중단 때 경로: Alertmanager 기본 receiver는 Telegram(새 봇)이고 봇을 거치지 않는다. 봇 route는 `continue: true`이고 Telegram 형제 route를 함께 켠다. NUC 전체 중단은 Watchdog → healthchecks.io 새 체크다. 봇 파드에 걸리는 핵심 룰은 KubePodCrashLooping, KubePodNotReady(15분), ArgoCDAppDegraded(30분)다 [확인: 설계 C.3.7·C.8·E9, spec §5.1 D-10].

**실측**

- 서버 자원: CPU 14개, 메모리 60Gi(옛 클러스터 가동 중 가용 약 55Gi), 스왑 0, 루트 디스크 913G 중 44% 사용 [실측: `nproc`, `free -h`, `df -h`]. 네트워크는 무선이다 [확인: spec §4.5].
- 옛 k3s가 active다 [실측: `systemctl is-active k3s`].

**가정·미확인**

- 살아 있으나 멈춘 봇(Discord 연결 끊김, 큐 정체, 경보 수신 실패)은 파드가 Ready면 어떤 핵심 룰도 울리지 않는다 [가정: 핵심 룰 목록 기준].
- replicas 0이나 Application 삭제로 봇 파드가 없으면 파드 단위 룰이 발화할 대상이 없다. E9의 replicas 0 시험은 경보 경로 시험이지 감지 시험이 아니다 [가정].
- 앱 파드의 `/metrics` 수집 규칙이 설계에 없어 봇 지표 기반 룰을 바로 쓸 수 없다 [미확인].
- Watchdog → healthchecks ping 직접 연결의 실동작(U10) [미확인].
- 작업자 init 방화벽(U13), DNS 없는 작업자의 도구 동작(U29) [미확인. blocked(해소: T08b, T16b 시작 때 재확인)].

## 3. 질문 3: Discord

**답:** Gateway로 메시지와 상호작용을 받고, 멘션 없는 스레드 후속 메시지는 `MESSAGE_CONTENT`로 읽는다. 허용 사용자 제한은 봇 코드가 매 이벤트마다 사용자 ID로 검사한다. 실연동은 blocked(사유: Discord 서버·봇 계정 미준비. 해소: D-17(확정)대로 사람이 준비한 뒤 T16b).

**확인**

- **Intents** [확인: https://docs.discord.com/developers/events/gateway , 2026-10-18]: `GUILDS`(1), `GUILD_MESSAGES`(512), `DIRECT_MESSAGES`(4096), `MESSAGE_CONTENT`(32768, 특권). `MESSAGE_CONTENT`가 없으면 `content`·`embeds`·`attachments`·`components`·`poll`이 빈 값이다. 예외는 봇 자신의 메시지, 봇 DM, 봇 멘션, 메시지 컨텍스트 메뉴 대상이다. 켜지 않은 특권 intent를 요청하면 close code 4014.
- **특권 intent 심사** [확인: https://docs.discord.com/developers/gateway/getting-started-with-privileged-intent-review , 2026-10-18]: 2026-06-10부터 기준이 서버 100개에서 고유 사용자 10,000명으로 바뀌었고 그 미만은 Portal 토글이다. application flag 문서는 아직 "100 servers"로 적혀 있어 문서끼리 표현이 다르다 [확인: https://docs.discord.com/developers/resources/application]. 어느 기준으로도 이 봇은 토글 대상이다 [가정: 서버 1개, 사용자 소수].
- **Gateway 한도**: 연결당 60초에 120개 송신 이벤트. IDENTIFY는 24시간에 1000회이고 넘으면 모든 세션이 끊기고 봇 토큰이 리셋된다. RESUME 실패 뒤 새 IDENTIFY 때 놓친 이벤트가 재생되는지는 문서에 없다 [확인: https://docs.discord.com/developers/events/gateway]. 그래서 재시작 뒤 스레드마다 `GET /channels/{id}/messages?after=`로 대조한다 [가정: 설계].
- **스레드** [확인: https://docs.discord.com/developers/topics/threads , https://docs.discord.com/developers/resources/channel , 2026-10-18]: `auto_archive_duration`은 60·1440·4320·10080분. 메시지를 보내면 보관이 자동으로 풀린다(잠긴 스레드 제외). 보관된 스레드에서는 애플리케이션 명령을 쓸 수 없다. 스레드 안 발화에는 `SEND_MESSAGES_IN_THREADS`가 필요하다. 비공개 스레드는 멤버이거나 `MANAGE_THREADS`가 있을 때만 동기화되고, 접근을 잃어도 Thread Delete가 오지 않는다. 메시지 없이 스레드를 만들 때 `type` 기본값은 `PRIVATE_THREAD`라 항상 명시해야 한다. 보관된 스레드는 연결 때 미리 동기화되지 않는다.
- **상호작용** [확인: https://docs.discord.com/developers/interactions/receiving-and-responding , 2026-10-18]: Gateway(`INTERACTION_CREATE`)와 HTTP 엔드포인트는 배타적이다. Gateway로 받아도 응답은 HTTP 콜백이다. 첫 응답은 3초 안, 토큰은 15분 유효. 상호작용 엔드포인트는 전역 초당 50 제한 밖이다. 15분을 넘는 작업 결과는 봇 토큰으로 일반 메시지를 보낸다.
- **슬래시 명령** [확인: https://docs.discord.com/developers/interactions/application-commands , 2026-10-18]: 길드 명령은 즉시 반영되지만 DM에서는 못 쓴다. DM은 전역 명령과 `contexts`의 `BOT_DM`이 필요하다. 명령별 사용자·채널 허용(overwrite)은 봇 토큰으로 설정할 수 없다.
- **메시지** [확인: https://docs.discord.com/developers/resources/message , https://docs.discord.com/developers/reference , 2026-10-18]: `content` 2000자, embed 합계 6000자, 요청 최대 25 MiB, 파일당 기본 20 MiB. 일반 메시지의 `allowed_mentions` 기본값은 everyone까지 파싱한다. Snowflake는 64비트이고 API는 문자열로 준다.
- **레이트 제한** [확인: https://docs.discord.com/developers/topics/rate-limits , 2026-10-18]: 전역 초당 50, 경로별 버킷은 `X-RateLimit-Bucket`, 429는 `retry_after`. 한도를 코드에 고정하지 말라고 한다. 잘못된 요청(401·403·429)이 10분에 10,000건이면 IP가 일시 차단된다.
- **권장 사항**: 기능을 멘션·명령·버튼으로 만들 수 있으면 `MESSAGE_CONTENT`를 요청하지 말라고 한다 [확인: https://docs.discord.com/developers/gateway/you-might-not-need-a-privileged-intent , 2026-10-18]. 이 봇은 활성 스레드의 멘션 없는 대화(R01, CHAT-01)가 핵심이라 대안으로 기능 1을 다 채우지 못한다 [가정].

**실측**

- `discord.js` 14.27.0(latest, 2026-07-15), `@discordjs/core` 2.6.0, `@discordjs/rest` 2.6.3, `@discordjs/ws` 1.2.3. v15는 dev 태그뿐이다 [실측: `npm view`].
- Bun 1.4.3에서 `discord.js` 14.27.0을 격리 디렉터리에 설치(`--ignore-scripts`)해 `Client`(intents 37377)·`REST`·`WebSocketManager` 생성과 종료까지 성공했다. 토큰·로그인·Discord 통신은 없었다 [실측].
- Bun에서는 `@discordjs/util`의 `shouldUseGlobalFetchAndWebSocket()`이 true라 `ws` 패키지 대신 Bun 내장 `WebSocket`과 전역 `fetch`를 쓴다 [실측: 설치된 패키지 코드].
- 옛 커밋에는 Discord 관련 파일이 없다 [실측: `git grep -i -l discord 2d2054a` → 0건].

**가정·미확인**

- 공식 `create-discord-bot`에 Bun TypeScript 템플릿이 있다(이슈 #11346 완료) [확인: https://github.com/discordjs/discord.js/issues/11346]. 반면 이슈 #10840 "Bun에서 네트워크 끊김 뒤 재연결 크래시"는 관리자가 Bun 문제로 보고 not planned로 닫았다 [확인: https://github.com/discordjs/discord.js/issues/10840]. Bun 1.4.3에서 아직 재현되는지는 [미확인]. 서버가 무선망이라 **단절·재연결 시험을 T16b 필수로 둔다** [가정].
- 공개 스레드 `MESSAGE_CREATE` 수신에 봇의 스레드 멤버십이 필요한지, 스레드 생성 엔드포인트의 정확한 최소 권한, 길드 활성 스레드 상한, 채널당 메시지 전송 레이트, 메시지당 첨부 개수 상한, `enforce_nonce` 중복 창의 길이 [미확인].
- 공유 차트의 IPv4 전용 인터넷 443 허용으로 Gateway·REST 연결이 되는지 [미확인. blocked(해소: T16b 첫 배포)].
- Discord Developer Policy 원문(공식 페이지 403)과 개발자 모드 ID 복사 도움말 원문(403) [미확인: 검색 요약으로만 봄].
- 허용 목록 변경이 Infisical → ESO를 거쳐 봇에 반영되기까지의 지연(AUTH-02의 "즉시" 수치) [미확인. T16b에서 수치로 정함].

## 4. 질문 4: Codex·herdr

**답:** 설치 버전은 codex-cli 0.163.0, herdr 0.9.5(x86_64 Linux)로 spec §4.5와 같다 [실측: `--version`]. 봇 소유 작업은 `codex exec` 경로(A)로, 질문은 턴 종료 + `exec resume`으로만 중계하고, 도구 승인 중계는 지원하지 않는다고 표시한다. herdr는 봇 경로에서 뺀다. 사람의 기존 Codex 세션을 "명시적으로 연결"하는 규칙 준수 방법은 이 조사에서 찾지 못했다. 사용자는 R08 요구를 그대로 두고 연결 방식을 T18에서 다시 판단하기로 했다(보류, 2026-10-18 T15).

**확인**

- 공식 Codex 문서 주소가 `developers.openai.com/codex/*`에서 `learn.chatgpt.com/docs/*`로 308 영구 이동했다 [실측: WebFetch 응답]. `00` §9의 Codex 진입점도 이동 대상이다.
- `codex exec`는 Stable이고 스크립트·CI용이다. `--json`이면 stdout이 JSONL(`thread.started`(`thread_id`), `turn.started`, `turn.completed`(`usage`), `turn.failed`, `item.*`, `error`)이다. `-o`는 마지막 메시지 파일, `--output-schema`는 JSON Schema 응답이다. 기본 샌드박스는 read-only이고 Git 저장소 안에서만 돈다(`--skip-git-repo-check`로 끔). 취소·중단에 대한 공식 서술은 없다 [확인: https://learn.chatgpt.com/docs/non-interactive-mode , https://learn.chatgpt.com/docs/developer-commands?surface=cli , 2026-10-18].
- `codex app-server`는 `thread/start`, `turn/start`, `thread/resume`, `turn/interrupt`, `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`(결정 accept·decline·cancel 등), `tool/requestUserInput`(실험), `thread/status/changed`(`waitingOnApproval`)를 준다. 그러나 "The app-server command and WebSocket transport are experimental and aren't supported for production workloads." [확인: https://learn.chatgpt.com/docs/app-server , 2026-10-18].
- TypeScript SDK는 CLI를 띄워 JSONL을 주고받아 사실상 `exec` 경로다. Python SDK는 app-server를 JSON-RPC로 다루며 stable 표시라, app-server 명령의 실험 표시와 문서끼리 어긋난다 [확인: https://learn.chatgpt.com/docs/codex-sdk , 2026-10-18].
- `codex mcp-server`는 제거됐다 [확인: https://learn.chatgpt.com/docs/developer-commands?surface=cli , 실측: 0.163.0이 하위 명령으로 인식하지 않음].
- 샌드박스: Linux는 bwrap + seccomp이고 컨테이너가 막으면 동작하지 않을 수 있다. 그때는 컨테이너를 경계로 두고 `danger-full-access`로 돌리라고 하며, 그러면 Codex 자격이 유출될 수 있다고 경고한다 [확인: https://learn.chatgpt.com/docs/agent-approvals-security , 2026-10-18].
- **경고:** `shell_environment_policy.ignore_default_excludes` 기본값이 `true`라 `KEY`·`SECRET`·`TOKEN` 이름의 변수가 모델이 실행하는 명령에 넘어간다 [확인: https://learn.chatgpt.com/docs/config-file/config-advanced , 2026-10-18].
- herdr: 상태는 `idle`, `working`, `blocked`, `done`, `unknown`. `blocked`는 승인 또는 질문 UI를 뜻하고 둘을 구분하지 않는다. 턴 단위 추적이 없다. Codex 상태는 화면 판독이고 모르는 화면은 `idle`로 떨어진다. 소켓 API의 인증·접근 제어는 문서에 없고 이벤트 기록은 영속이 아니다 [확인: https://herdr.dev/docs/cli-reference/ , herdr v0.9.5 태그의 socket-api·agents·integrations 문서, 2026-10-18].

**실측**

- `codex exec --help`에 `-a/--ask-for-approval`이 없다. `--approve-for-me`(자동 검토)와 `--dangerously-bypass-approvals-and-sandbox`가 있다. `codex exec resume --help`에 `-s`·`-C`·`--add-dir`가 없다 [실측].
- `codex --help`의 승인 정책 값은 `on-request`, `never`다 [실측].
- 사람 계정으로 herdr 서버가 돌고 있고 소켓은 사용자 소유 0600이다 [실측: `ps`, `stat`].
- 호스트는 AppArmor로 비특권 user namespace를 제한한다 [실측: `sysctl kernel.apparmor_restrict_unprivileged_userns` → 1].

**가정·미확인**

- 경로 비교와 V1 능력 표시는 [VERIFICATION.md](VERIFICATION.md) 첫 세 행과 ARCHITECTURE §4에 있다.
- 사람의 herdr 소켓에 봇이 닿으면 그 서버의 모든 패널 입력과 에이전트 시작 권한을 갖는다 [가정: 메서드 목록에서 추론]. `00` §6 "호스트 소켓 전달 금지", F03과 어긋난다.
- 미확인: 샌드박스 밖 동작이 필요할 때 `exec`의 처리(자동 거부인지 턴 실패인지), SIGINT·SIGTERM 때 종료 코드·마지막 이벤트·세션 파일 정합성과 재개 가능 여부, `turn.failed`·`error` 필드와 인증 만료·한도·네트워크 실패의 구분, `exec resume`이 원래 샌드박스·작업 디렉터리를 물려받는지, 파드 안 bwrap 동작(모델 호출 없이 `codex sandbox -- true`로 확인 가능), `HTTPS_PROXY` 준수와 필요한 호스트 목록, `CODEX_API_KEY`가 자식 명령 환경에서 지워지는지, app-server의 클라이언트 단절 동작, 개인 세션을 개인 CODEX_HOME·herdr 소켓에 닿지 않고 연결할 방법(예: 사람이 상태를 보내는 Codex 훅. 공식 훅 이벤트 목록은 확인하지 않음. T18의 R08 판단 입력).

## 5. 질문 5: GitHub App, 쓰기 자격, 보호, 병합 경로

**답:** org에 설치된 App은 넷이고 그중 남는 것은 Codex Connector뿐이다. 새로 생길 쓰기 App은 배포·병합 App, 호스팅형 Renovate, 봇 리뷰 App, 봇 변경 PR App이다. 봇 저장소·`files`·템플릿에는 `app-main`이 active이고 homelab은 옛 보호다. 병합으로 이어지는 경로와 막는 장치는 아래와 같다.

**실측**

- org 설치 App 4개 [실측: `gh api orgs/ukyi-app/installations`]:

| App | 범위 | 권한 요지 | 처리 |
|---|---|---|---|
| 옛 reader | 전체 | contents read | T06 삭제(D-11) |
| 옛 writer | 전체 | contents·issues·pull_requests write, workflows 없음 | T06 삭제(D-11) |
| 옛 aiops | 선택 | contents·pull_requests·workflows write, actions read | T22 제거(D-13) |
| Codex Connector | 전체 | actions·contents·issues·pull_requests·workflows write, checks·statuses read, 이벤트 12종 | 유지 + 조건 넷(D-26). 범위는 선택 저장소로 축소함(D-16, 사람 2026-10-18) |

- 전체 저장소 설치 App은 private 운영 저장소에도 닿는다. 그중 contents write인 Codex Connector는 T06 뒤에도 남는다 [실측 + 가정: private 저장소에는 보호 규칙이 없음]. 그래서 Connector 설치 범위를 `homelab-bot-ops` 첫 push 전에 선택 저장소로 줄였다(사람 2026-10-18 17:45, homelab `approvals.md`). 범위가 `selected`로 바뀐 것은 확인했고 남긴 저장소 목록은 사용자 보고뿐이다 [실측: `gh api` GET. 목록은 미확인].
- `author_association` 실측과 Codex Connector 실측은 [DECISIONS.md](DECISIONS.md) D-16 근거와 하위 결정에 있다.
- org 기본 `GITHUB_TOKEN`은 read이고 PR 승인 불가다 [실측: `gh api orgs/ukyi-app/actions/permissions/workflow`].

**확인**

- 리뷰 게시 `POST /pulls/{n}/reviews`의 `event`는 APPROVE·REQUEST_CHANGES·COMMENT, 비우면 PENDING. 권한은 Pull requests write이고 같은 권한으로 dismiss·PR 생성도 된다. `commit_id`를 비우면 최신 커밋이다 [확인: https://docs.github.com/en/rest/pulls/reviews , 2026-10-18].
- PR 요약 댓글은 Issues write 또는 Pull requests write 중 하나면 된다 [확인: https://docs.github.com/en/rest/issues/comments , 2026-10-18].
- 병합·`/merges`·`repository_dispatch`는 Contents write, `workflow_dispatch`는 Actions write, 워크플로 파일은 Contents write + Workflows write다 [확인: https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps , 2026-10-18].
- 설치 토큰은 `repositories`·`permissions`로 줄일 수 있고 1시간에 만료된다. App이 받지 않은 권한은 줄 수 없다 [확인: https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app , 2026-10-18].
- webhook: `X-Hub-Signature-256` 상수 시간 비교, 원본 바이트로 계산, 10초 안 2XX, `X-GitHub-Delivery`로 중복 판정. **실패한 전달은 자동 재전송되지 않고 최근 3일 안만 수동 재전송된다** [확인: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries , .../best-practices-for-using-webhooks , .../redelivering-webhooks , 2026-10-18]. 그래서 열린 PR 주기 대조가 필요하다.
- `issue_comment` 구독은 문서상 Issues read 이상이다. 댓글로 리뷰를 부르는 경로는 `issue.author_association`(PR 작성자)이 아니라 `comment.author_association`을 봐야 한다 [확인: https://docs.github.com/en/webhooks/webhook-events-and-payloads , 해석].
- App 설치 토큰이나 PAT로 만든 PR은 `pull_request` 워크플로가 승인 프롬프트 없이 돈다 [확인: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow , 2026-10-18].
- 자동 병합 범위(D-07, 확정): 배포 갱신 App이 만든 한 앱의 `image.yaml` digest·revision만 바뀐 PR만, 조건 9개를 모두 만족할 때. 봇 변경 PR은 조건 1(작성자 숫자 ID) 밖이고 ruleset C 때문에 `deploy/**`를 만들 수 없다 [확인: 설계 C.4.7, spec §5.1 D-07].

**병합으로 이어지는 다른 경로** [확인: 설계 C.4.7 "남는 위험", F D-26 / 실측: 위 보호 상태]

1. code owner 승인 뒤 Contents write 신원의 API 병합(봇 변경 PR App, Codex Connector, Renovate). "봇은 병합하지 않는다"는 게시 서버 규칙과 CHANGE-02 시험으로 지킨다.
2. `repository_dispatch`(Contents write), `workflow_dispatch`(Actions write). D-26 조건 (2)가 시크릿 쓰는 워크플로를 `workflow_run`만으로 묶는다.
3. GitHub auto-merge. homelab은 지금 켜져 있고 T06에서 끈다 [실측: `allow_auto_merge=true`].
4. owner 관리자 bypass 병합. 봇은 owner 토큰을 받지 않는다 [가정: `00` §6 "모델 vs 게시"에서 도출].
5. Codex Connector의 `@codex <작업>`은 PR을 맥락으로 cloud 작업을 시작하고 권한이 있으면 브랜치에 push할 수 있다 [확인: https://learn.chatgpt.com/docs/third-party/github , 2026-10-18]. 외부인 호출(U38), owner 권한 병합(U37)은 [미확인].
6. **봇 저장소 자체도 자동 배포 대상이다.** `homelab-bot` main 병합은 `app-build` → digest PR → 자동 병합 → 배포로 이어진다. 그 앞 관문은 `app-main`의 code owner 승인 하나다 [가정: 설계 C.4.1 흐름과 조건 9를 봇에 적용].

**미확인**

- git push(contents API가 아닌 경로)로 워크플로 파일을 바꿀 때도 Workflows 권한이 필요한지(E5 시험).
- `author_association`이 이벤트 시점에 고정되는지(실측값은 조회 시점).
- Pull requests 권한만으로 PR 댓글의 `issue_comment`가 오는지, webhook payload의 `comment.author_association` 필드.
- App 승인이 code owner 승인을 대신하지 못한다는 가정(U08).

## 6. 질문 6: 등록 서비스, 관측 API, 읽기 계정, 민감 자료, 예산

**답:** 지금 등록할 수 있는 서비스는 없다(새 클러스터 없음). 설계상 봇은 Grafana·Argo CD·Kubernetes의 읽기 계정 `bot-reader` 셋으로만 읽고 vmsingle·VictoriaLogs·Alertmanager API에는 직접 닿지 않는다. 다만 로그 제외는 플랫폼 권한으로 서지 않아 봇 어댑터가 막아야 한다.

**확인(계획 문서)**

- 구축 뒤 후보: platform 구성 요소, 시험 앱(E5·E8), 봇 자신(T16b), `files`(T22) [확인: 설계 C.1·E5·E8·E9]. 시험 앱이 시험 뒤에도 등록돼 있는지는 [미확인].
- R04 카탈로그 원천: `apps/<app>/values.yaml`·`image.yaml`(public homelab), Argo CD Application, 앱 저장소. 내부 UI 이름은 tailnet 이름을 포함하므로 봇 저장소 코드·로그·이미지에 두지 않고, 봇은 이 이름으로 조회하지 않는다(인터넷 443 규칙이 tailnet 대역을 뺌) [확인: `01` §4 참고, 설계 C.4.5, spec §5.1 D-08·D-29].
- 읽기 계정 [확인: 설계 C.8 "읽기 전용 접근"]:
  - Kubernetes SA `bot-reader`: get·list·watch만. secrets, configmaps, pods/log, pods/exec, 모든 쓰기 없음.
  - Argo CD `bot-reader`: apiKey만, applications·applicationsets·projects get. sync·exec·logs 없음. Argo CD는 API 응답에서 Kubernetes Secret 값을 가린다 [확인: https://argo-cd.readthedocs.io/en/stable/operator-manual/security/ , 2026-10-18]. 파드 로그는 별도 `logs` 권한이 있어야 본다 [확인: https://argo-cd.readthedocs.io/en/stable/operator-manual/rbac/ , 2026-10-18].
  - Grafana `bot-reader`: Viewer.
- 보존 기간: 메트릭 30일, 로그 14일 [확인: 설계 C.3.7]. 이 값은 질의 시간창 상한이 아니다. 상한은 설계에 없고 T16a에서 정한다. 상한이 보존 기간과 같으면 R05의 시간창 제한이 아무것도 막지 않는다. 배포 확인(R15)은 Argo CD 60초 폴링 때문에 병합 뒤 최대 약 1분 늦다 [확인: spec §5.1 "설계 기본값"].
- 예산: 설계는 앱별 숫자 예산을 두지 않고 requests·memory limit 필수와 메모리·OOM 경보로 막는다. 봇은 새 Infisical identity를 쓰지 않는다(4/5 유지). healthchecks.io 무료 체크는 20개다 [확인: 설계 C.4.5, spec §5.1 D-04, 설계 F D-10].

**설계 빈틈 셋**

1. **Grafana Viewer는 데이터소스를 질의할 수 있고, 데이터소스별 권한은 Enterprise·Cloud 기능이다** [확인: https://grafana.com/docs/grafana/latest/administration/roles-and-permissions/ , 2026-10-18]. 설계는 OSS Grafana다 [가정: 설계에 Enterprise 언급 없음]. 그래서 봇은 VictoriaLogs로 수집된 모든 파드 로그를 읽을 수 있고 SA의 `pods/log` 제외가 로그에는 적용되지 않는다 [가정: 두 사실의 결합]. API 질의 경로(`/api/ds/query`)가 Viewer에 열려 있는지와 쓰기 불가(U12)는 [미확인. blocked(해소: T08b)]. 대응 제안은 ARCHITECTURE §6.
2. **Argo CD `applications, get`만으로 관리 리소스의 live 매니페스트(ConfigMap 내용)가 반환되는지** [미확인]. `argocd app manifests --source live`가 있다 [확인: https://argo-cd.readthedocs.io/en/stable/user-guide/commands/argocd_app_manifests/ , 2026-10-18]. 된다면 SA에서 뺀 configmaps 경계가 우회된다. blocked(해소: T08b 준비 확인, T16b 시작 때 재확인).
3. **봇이 쓸 Grafana 토큰·Argo CD apiKey의 보관 위치가 설계에 없다** [확인: T08b 티켓 "자격" 절]. 키 이름 제안은 ARCHITECTURE §5.

**공개 범위 제약** [확인: spec §5.1 D-13·D-29, `00` §6]: 읽은 운영 자료를 public 봇 저장소(코드·이슈·Actions 로그)나 public PR에 쓰지 않는다.

## 7. 질문 7: 모델, 인증, 예산

**답:** 공식 문서상 자동화의 기본은 API 키다. 구독 인증의 무인 실행은 조건부 "고급" 경로다. D-14는 봇 전용 ChatGPT 구독 계정 + 작업자 전용 CODEX_HOME으로 확정됐다(사용자 2026-10-18, T15, 에이전트 추천과 다름). 함께 지킬 조건과 남는 위험은 [DECISIONS.md](DECISIONS.md) D-14.

**확인**

- 인증 방식: ChatGPT 로그인(구독), API 키(사용량 과금), Codex access token(Business·Enterprise), device code(beta). 자격 저장은 `file`(CODEX_HOME 아래 `auth.json`)·`keyring`·`auto`·`ephemeral` [확인: https://learn.chatgpt.com/docs/auth , 2026-10-18].
- `CODEX_API_KEY`는 한 번의 비대화 실행에 키를 주고, 같은 프로세스 환경에서 비신뢰 코드가 돌지 않게 하라고 한다 [확인: https://learn.chatgpt.com/docs/non-interactive-mode , 2026-10-18].
- access token은 Business·Enterprise 워크스페이스만이고, 서비스 계정은 pay-as-you-go 플랜만이다. 인증 문서는 Enterprise만 적어 두 문서가 어긋난다 [확인: https://learn.chatgpt.com/docs/enterprise/access-tokens , .../service-accounts , 2026-10-18].
- 키를 Codex 프로세스에서 떼는 공식 도구 `codex-responses-api-proxy`가 있다. `/v1/responses` POST만 전달하고 키를 stdin으로 받는다 [확인: https://github.com/openai/codex/blob/main/codex-rs/responses-api-proxy/README.md , 2026-10-18]. NUC에는 설치돼 있지 않다 [실측: `command -v` 실패]. `HTTPS_PROXY`를 따르는지는 [미확인].
- 요금·한도·약관 근거는 D-14 근거 목록에 있다. D-14 A에서는 `auth.json` 하나당 직렬 1개와 갱신본 되쓰기가 조건이다 [확인: https://learn.chatgpt.com/docs/auth/ci-cd-auth].

**미확인**

- OpenAI 확인 항목 세 가지: ci-cd-auth의 "public or open-source repositories" 범위, 개인용 이용 약관의 자동 추출 조항 적용, 봇 전용 두 번째 개인 계정 허용(공식 해석 없음, OpenAI 문의로만 풀림).
- 구독 인증 Codex의 egress 도메인 목록, API long context 가격 경계, V1 예상 호출량과 월 비용.

## 8. 옛 AIOps 교훈 (참고 입력, 제약 아님)

옛 저장소 커밋 `2d2054a`의 `docs/aiops.md`, `docs/decisions/0008`~`0010`, `docs/reviews/aiops-codex/`(30개 파일)와 GitHub의 옛 aiops 저장소를 읽었다 [실측: `git show 2d2054a:…`, `gh api` GET]. 요구와 경계의 기준은 `00`·`01`이다.

**어디서 멈췄나** [실측]

- 실제 모델 진단은 운영에서 돌지 않았다. 진단 worker 타이머는 disabled이고 journal 보존 시작(2026-10-01) 뒤 worker·timer 기록이 0줄이다. 그 전은 journal이 없어 [미확인].
- AIOps App이 작성한 homelab PR은 0개다. 닫힌 aiops 브랜치 PR은 모두 owner가 만든 권한 시험용이다.
- 구현 검토 기록: 실제 역할·cgroup, 전용 구독 로그인, 생산자 도달, PR·Telegram 게시, 14일 관찰은 미수행이었고 12개 고정 사례는 모의 엔진으로만 통과했다.

**가져올 것** [실측]

- 역할과 자격 분리(6역할 별도 UID, 모델에 쓰기 자격 없음), 토큰을 역할마다 좁히고 실제 응답으로 검증.
- 게시자가 저장소 ID·기준·브랜치 접두어를 고정하고 merge·ready·automerge·dispatch API를 아예 갖지 않음. 기준이 움직였으면 보류.
- 결과를 모르면 `unknown`으로 두고 다시 보내지 않음. PR 생성 응답이 끊기면 기존 PR부터 대조.
- 검증 코드는 기준 리비전에서, 검증 대상은 후보에서 읽음(실제 반례로 확인).
- worker 밖 감독(단계별 시간·메모리·출력 상한, 정리 확인 불능이면 새 실행 차단), 비AI 알림 독립(`continue: true`), 모의 통과로 준비 완료를 만들지 않음.
- 수치 관찰 기준(14일, 최소 20사건, 근거 있는 원인 후보 80% 이상, 위험한 제안 0건, 대응 시간 30% 단축, 조용한 기간은 증거 아님, 정답을 모델 입력과 분리). `04` §6 리뷰 품질 측정의 출발점으로 쓸 수 있다 [가정].
- 계획 단계 적대적 리뷰 틀(고정 ref, read-only sandbox, approval never, 메모리 끔, deadline, schema 위반 시 폐기)이 격리 리뷰어의 견본이 된다 [가정].

**피할 것** [실측]

- 처음부터 넓은 범위: 모든 알림, homelab 전체 파일(워크플로 포함) 초안. 워크플로 쓰기가 필요해져 fork 경계(ADR-0009)를 이틀 만에 내부 Draft PR(ADR-0010)로 바꾸고 CI 자격 공급 전체를 다시 짰다. Draft PR은 보안 경계가 아니었다.
- 늦게, 여러 번 바뀐 모델 경로: 직접 `codex exec` → 공급자 추상화 → Codex 밖 구독 OAuth 프록시. 바뀔 때마다 수용 증거가 무효가 됐고 사용량을 알 수 없게 됐다. 프록시 경로는 공식 지원 밖이라 새 봇은 채택하지 않는다(D-14).
- 호스트 설치형 운영의 취약성: 2026-10-15 의존성 누락으로 수신기가 약 1분 사이 8번 재시작 실패, 약 43KB 자체 설치기, 90일 인증서 수동 교체.
- "모든 생산자를 연결하기 전에는 시작하지 않음"이 실사용 0으로 끝났다. V1_PLAN 범위 조정안의 근거다 [가정].

## 9. 플랫폼 미구축으로 blocked인 것

모두 해소 시점은 **T13 완료 뒤, T16b 시작 때 재확인**이다. 개별 해소 티켓은 괄호 안에 적었다.

- 읽기 계정 셋의 실제 권한, Grafana API 질의 범위(U12), Argo CD live 매니페스트 (T08b).
- sandbox 작업자의 init 방화벽(U13), DNS 없는 도구(U29), 작업자 ↔ 봇 Service 연결 (T08b).
- webhook 경로 `hooks.ukyi.app/github`의 403·401·200 동작 (T08a).
- Alertmanager → 봇 receiver, Telegram 형제 route, Watchdog → healthchecks (T08b).
- ruleset A~D, 리뷰 App 저장소별 설치 구조, 봇 변경 PR의 자동 병합 차단(시험 App) (T10).
- 호스팅형 Renovate와 봇 App PR의 실제 `author_association` (T10, D-18 설치 뒤).
- 봇 파드에서 Discord Gateway·REST 연결(IPv4 443) (T16b 첫 배포).
- 작업자 파드의 `codeload.github.com` 압축본 받기와 다른 GitHub 호스트 차단, 영속 쓰기 공간 유지(D-14·D-15) (T08b, T16b).

## 10. 미확인 목록 (결정·구현 전에 풀 것)

| 항목 | 해소 방법 |
|---|---|
| Bun 1.4.3에서 Discord 재연결 크래시(#10840) | T16b 네트워크 차단·복구 시험 |
| 공개 스레드 수신의 멤버십 필요 여부, 스레드 생성 최소 권한 | T16b 권한 하나씩 빼기 시험 |
| `codex exec`의 샌드박스 밖 동작 처리, 신호 처리, 오류 이벤트 필드, resume 상속 | 모델 호출 허가 뒤 T16b·T18 |
| 파드 안 Codex bwrap 동작 | `codex sandbox -- true`(모델 호출 없음), T08b·T16b |
| Codex의 `HTTPS_PROXY` 준수와 필요 호스트(구독 인증 도메인 포함) | T08b·T16b |
| 외부인 `@codex` 호출(U38), Draft PR의 Codex 회피, Connector가 읽는 `AGENTS.md` 리비전 | 사람이 별도 계정으로 시험(허가된 시험 자산) |
| 봇 PR 미리뷰 원인, Codex 저장소 설정에서 리뷰되는 작성자 범위(봇·Renovate PR 포함 여부) | 사람이 Codex 설정 화면 확인(T17) |
| OpenAI 확인 항목 세 가지: 공개 저장소 문구 범위, 자동 추출 조항 적용, 봇 전용 두 번째 개인 계정 허용 | OpenAI 문의(D-14 남는 위험) |
| Discord Developer Policy 원문 | 사람이 브라우저로 확인 |
| Grafana `/api/ds/query` Viewer 허용, Argo CD live ConfigMap | T08b, T16b |
| 앱 지표 스크레이프 규칙, 멈춘 봇·replicas 0 감지 룰 | T08b 룰 확정 때 또는 T16b |
| 허용 목록 변경 반영 지연(AUTH-02) | T16b |
| R08 명시적 연결 방법(Codex 공식 훅 이벤트 목록 포함) | T18 |

## 11. 봇 문서 정비 후보

- `00` §9의 Codex 진입점 `https://developers.openai.com/codex/app-server`가 `https://learn.chatgpt.com/docs/app-server`로 308 이동했다 [실측]. 결정 반영 변경에서 `00` §9의 주소를 바꿨다(봇 저장소 PR로 반영).
- `files`·템플릿의 private vulnerability reporting: 기준 리비전의 설계 C.3.9는 결정 5로 켜졌다고 적지만 실측은 false다 [실측]. spec 결정 5 목록과도 다르다. homelab `rebuild` 변경에서 설계 C.3.9 정정과 spec §11 사람 작업(T10 guard 첫 실행 전 켜기)으로 반영됐다.

## 12. 출처 (모두 확인일 2026-10-18)

- Discord: https://docs.discord.com/developers/events/gateway , https://docs.discord.com/developers/gateway/getting-started-with-privileged-intent-review , https://docs.discord.com/developers/gateway/you-might-not-need-a-privileged-intent , https://docs.discord.com/developers/resources/application , https://docs.discord.com/developers/topics/threads , https://docs.discord.com/developers/resources/channel , https://docs.discord.com/developers/resources/message , https://docs.discord.com/developers/reference , https://docs.discord.com/developers/interactions/receiving-and-responding , https://docs.discord.com/developers/interactions/application-commands , https://docs.discord.com/developers/topics/rate-limits , https://docs.discord.com/developers/topics/permissions . `discord.com/developers/docs/*`는 이 주소로 301 이동한다.
- discord.js: https://github.com/discordjs/discord.js (이슈 #10840, #11296, #11346, Bun 템플릿).
- OpenAI Codex: https://learn.chatgpt.com/docs/non-interactive-mode , https://learn.chatgpt.com/docs/developer-commands?surface=cli , https://learn.chatgpt.com/docs/app-server , https://learn.chatgpt.com/docs/codex-sdk , https://learn.chatgpt.com/docs/agent-approvals-security , https://learn.chatgpt.com/docs/permissions , https://learn.chatgpt.com/docs/auth , https://learn.chatgpt.com/docs/auth/ci-cd-auth , https://learn.chatgpt.com/docs/config-file/environment-variables , https://learn.chatgpt.com/docs/config-file/config-advanced , https://learn.chatgpt.com/docs/enterprise/access-tokens , https://learn.chatgpt.com/docs/enterprise/service-accounts , https://learn.chatgpt.com/docs/pricing , https://learn.chatgpt.com/docs/security/security-review , https://learn.chatgpt.com/docs/third-party/github (옛 주소 `developers.openai.com/codex/integrations/github`에서 308 이동).
- OpenAI 정책·API: https://openai.com/policies/row-terms-of-use/ , https://openai.com/policies/services-agreement/ , https://openai.com/policies/usage-policies/ (세 페이지는 직접 조회 403이라 공개 리더 중계로 본문을 읽음), https://help.openai.com/en/articles/10471989 , https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan , https://help.openai.com/en/articles/5722486 , https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform , https://help.openai.com/en/articles/8264778-what-is-prepaid-billing , https://developers.openai.com/api/docs/pricing , https://developers.openai.com/api/docs/guides/spend-limits , https://developers.openai.com/api/docs/guides/rate-limits , https://developers.openai.com/siwc/token-sharing-open-source .
- herdr: https://herdr.dev/docs/cli-reference/ , herdr 저장소 v0.9.5 태그의 `docs/next/website/src/content/docs/{socket-api,agents,integrations,session-state}.mdx`.
- GitHub: https://docs.github.com/en/rest/pulls/reviews , https://docs.github.com/en/rest/pulls/pulls , https://docs.github.com/en/rest/issues/comments , https://docs.github.com/en/rest/repos/contents , https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps , https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app , https://docs.github.com/en/webhooks/webhook-events-and-payloads , https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries , https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks , https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks , https://docs.github.com/en/graphql/reference/issues , https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow , https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows , https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments , https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets , https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app , https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app , https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app , https://docs.github.com/en/site-policy/github-terms/github-terms-of-service .
- Grafana·Argo CD: https://grafana.com/docs/grafana/latest/administration/roles-and-permissions/ , https://argo-cd.readthedocs.io/en/stable/operator-manual/rbac/ , https://argo-cd.readthedocs.io/en/stable/operator-manual/security/ , https://argo-cd.readthedocs.io/en/stable/user-guide/commands/argocd_app_manifests/ .
- 계획 문서: homelab `rebuild@8bdbfa2`의 spec §1·§4.5·§5·§7·§8·§10, platform/design.md C.1·C.3.7·C.4·C.5·C.6.3·C.8·E9·F, 티켓 T08b·T15~T21. 봇 문서 `homelab-bot@71c74a7`의 `00`·`01`·`04`.
