const PAGE_SIZE = 1800;

// JSON list pages remain independently parseable; ordinary text is never discarded.
export function messagePages(content: string): string[] {
  if (content.length <= PAGE_SIZE) return [content];
  let list: unknown;
  try { list = JSON.parse(content); } catch { /* Plain text is paged below. */ }
  if (Array.isArray(list)) {
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
  const pages: string[] = [];
  while (content.length) {
    let end = Math.min(PAGE_SIZE, content.length);
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]!)) end--;
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
