const PAGE_SIZE = 1800;
// 버튼이 달린 글(버튼은 마지막 쪽에 붙는다)의 마지막 쪽 상한. 켜짐 때 저장한 글을 꺼진 게시 서버가 보내면 끝의 버튼 안내를
// '/' 안내로 바꾸는데(discord.ts unbuttoned), 그 안내는 custom_id(100자 상한) 안의 ID를 싣고 최대 약 290자 길어진다.
// 1500자면 바꾼 뒤에도 게시자의 본문 상한(1900자) 안이다. 시험(c17-publish-button)이 가장 긴 ID로 이 여유를 확인한다.
export const BUTTON_PAGE_SIZE = 1500;

// JSON list pages remain independently parseable; ordinary text is never discarded.
// lastPage는 일반 글의 마지막 쪽에만 거는 더 작은 상한이다. 앞쪽은 그대로 PAGE_SIZE로 나눈다.
export function messagePages(content: string, lastPage = PAGE_SIZE): string[] {
  if (content.length <= Math.min(PAGE_SIZE, lastPage)) return [content];
  let list: unknown;
  try { list = JSON.parse(content); } catch { /* Plain text is paged below. */ }
  if (Array.isArray(list)) {
    if (content.length <= PAGE_SIZE) return [content];
    const pages: string[] = [];
    let page: unknown[] = [];
    for (const item of list) {
      if (JSON.stringify([item]).length > PAGE_SIZE) throw new Error('message_item_too_large');
      if (JSON.stringify([...page, item]).length > PAGE_SIZE) { pages.push(JSON.stringify(page)); page = []; }
      page.push(item);
    }
    if (page.length) pages.push(JSON.stringify(page));
    return pages;
  }
  const pages = textPages(content, PAGE_SIZE);
  const last = pages.pop()!;
  return [...pages, ...textPages(last, Math.min(PAGE_SIZE, lastPage))];
}
function textPages(content: string, size: number): string[] {
  const pages: string[] = [];
  while (content.length) {
    let end = Math.min(size, content.length);
    if (end < content.length) {
      // 쪽 상한보다 짧은 줄은 두 메시지로 가르지 않는다. 승인 명령(/change-publish … text:<digest>)처럼
      // 한 줄을 통째로 복사해야 하는 토큰이 경계에 걸려도 한 메시지에 남는다.
      // 앞쪽이 공백뿐이면 Discord가 빈 메시지로 거부하므로 그때와 줄바꿈이 없을 때만 글자 수로 자른다.
      const lineEnd = content.lastIndexOf('\n', end - 1) + 1;
      if (lineEnd > 0 && /\S/.test(content.slice(0, lineEnd))) end = lineEnd;
      else if (/[\uD800-\uDBFF]/.test(content[end - 1]!)) end--;
    }
    pages.push(content.slice(0, end)); content = content.slice(end);
  }
  return pages;
}
export function bounded(value: string, budget: number): string {
  return value.length <= budget ? value : `${value.slice(0, budget - 20)}… (일부 생략)`;
}
export function summaryItems(items: string[], budget: number): string {
  const included: string[] = [];
  for (const item of items) {
    if ([...included, item].join('; ').length > budget - 25) break;
    included.push(item);
  }
  const omitted = items.length - included.length;
  return (included.join('; ') || (omitted ? '' : '없음')) + (omitted ? ` (${omitted}개 생략)` : '');
}
