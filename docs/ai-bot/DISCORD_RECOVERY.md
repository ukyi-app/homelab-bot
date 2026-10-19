# Discord 복구 커서 판정 — PR 코멘트 4314491302

확인일: 2026-10-19. 공개 문서와 라이브러리 소스만 읽었다. Discord API를 호출하지 않았다.

## 판정

기존 checkpoint가 있을 때 `after` 페이지의 최댓값으로 커서를 전진시키는 구현은 유지한다.
지적의 “응답이 내림차순이므로 전체 구간의 최신 100개가 선택된다”는 추론은 채택하지 않는다.
페이지 안의 정렬과 페이지에 포함되는 범위는 서로 다른 성질이다.

- [Discord Get Channel Messages](https://docs.discord.com/developers/resources/message#get-channel-messages)는 응답 배열의 newest-to-oldest 정렬, before/after/around의 상호 배타성, limit 1~100을 명시한다. **after가 최신 N개를 선택한다는 보장은 이 문장에 없다.**
- [discord.js MessageManager._fetchMany](https://github.com/discordjs/discord.js/blob/main/packages/discord.js/src/managers/MessageManager.js)는 API 옵션을 그대로 넘기고 응답 순서대로 Collection을 만든다. 자동 페이지 순회나 after 선택 범위에 대한 추가 근거를 제공하지 않는다.
- [discord.py v2.6.4 Messageable.history](https://github.com/Rapptz/discord.py/blob/v2.6.4/discord/abc.py#L1821-L1901)의 `_after_strategy`는 after를 넘겨 요청하고 다음 커서를 `data[0]['id']`로 갱신한다. oldest_first 경로에서는 이 전략을 고른 뒤 배열을 뒤집어 오래된 순서로 내보내며 페이지를 반복한다.

**구현에서 도출한 판단:** 널리 쓰이는 discord.py의 전진 순회가 성립하려면 after는 커서 바로 뒤의 가장 오래된 N개를 선택하고, 그 페이지를 내림차순으로 반환해야 한다. 기존 봇의 페이지 오름차순 처리 후 최댓값 전진은 같은 방식이다. 공식 문서만으로 선택 범위를 증명했다고 쓰거나 이를 실제 Discord 실측으로 분류하지 않는다. 서버 동작 검증은 T16b의 blocked 항목이다.

예: checkpoint=1000, 누락 1001~1150이면 첫 응답은 1100~1001, 다음 after=1100 응답은 1150~1101이다. 페이지를 정렬해 처리하면 150건 모두 저장된다. before 역방향 전환은 하지 않는다.

## 별도로 수정한 최초 복구

기존 DiscordProtocol은 checkpoint=null이면 after를 생략했다. 이 경우 최신 페이지에서 시작해 오래된 메시지를 건너뛸 수 있다. 이제 명시적으로 after=0에서 시작하고 기존 10페이지/30초 한도를 적용한다. [discord.py의 초기 경계](https://github.com/Rapptz/discord.py/blob/v2.6.4/discord/abc.py#L1850-L1854)와 [OLDEST_OBJECT 정의](https://github.com/Rapptz/discord.py/blob/master/discord/object.py#L108-L109)의 0 sentinel과 같은 선택이다. master 소스는 확인일 기준이며, 이 자료도 서버 실측을 대신하지 않는다.

## 회귀 근거

`test/review-5.test.ts`는 실제 DiscordProtocol→DiscordIngress→PGlite 경로를 실행한다. 모의 API는 전체 150건 중 after 바로 뒤 100건을 골라 역순으로 반환한다. after 생략 시에는 최신 100건을 반환하도록 해 최초 커서 누락도 잡는다.

checkpoint=1000과 checkpoint=null 각각에서 두 페이지의 커서, 첫 페이지의 실제 순서, 모든 event의 시간순 저장, 최종 checkpoint, gap=false를 검사한다. 기존의 101건 복구·1000건 한도·scope 검사도 전체 시험에 남아 있다. 등급은 local_integration이며 API 응답은 mock이다.
