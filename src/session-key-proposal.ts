import { KEY_PENDING, SESSION_KEY_BUTTON, SESSION_KEY_TEXT, attachTarget, parseAttach, readAttachTarget } from './external-task-commands.js';
import { EXTERNAL_TASK_ID } from './external-task-links.js';
import type { ActionRow } from './proposals.js';

type RunHandler = Extract<NonNullable<ActionRow['handler']>, { kind: 'run' }>;
// 제안 동작 표(proposals.ts ACTIONS)의 세션 연결 줄. R08 명령 모듈은 제안 코드를 import하지 않으므로 이 파일에 둔다.
// 모델은 세션 ID(target)와 '/attach'의 text 꼴(content: `claude`·`codex`, 동의하면 뒤에 summary=on)만 고른다.
// "할게요"에서는 대상만 확정하고 키 보기 버튼 글을 게시한다. 연결과 키는 "키 보기" 상호작용 안에서 만든다.
export const sessionAttachHandler: RunHandler = {
  kind: 'run',
  async prepare({ job, proposal, externalConnected }) {
    if (!externalConnected || job.target.kind === 'channel' || !proposal.target || !EXTERNAL_TASK_ID.test(proposal.target)) return;
    const parsed = parseAttach(proposal.content ?? '');
    if (!parsed) return;
    return { target: attachTarget({ externalTaskId: proposal.target, ...parsed }), content: null, value: null, sourceEvent: null,
      question: SESSION_KEY_TEXT.question(proposal.target, parsed.executor, parsed.summaryConsent),
      plainQuestion: SESSION_KEY_TEXT.questionWithheld(parsed.executor, parsed.summaryConsent) };
  },
  async current(_store, row) { return { target: row.target, content: null }; },
  async execute(store, row, values, { revision }) {
    const spec = readAttachTarget(values.target);
    if (!spec) return { state: 'refused', reason: 'attach_target_invalid', content: SESSION_KEY_TEXT.missing };
    // 버튼 글은 공개 글이다. 고정 문구와 제안 ID만 싣는다.
    await store.enqueue({ key: `session-key:${row.id}`, conversation: row.conversation_id, actor: row.owner_id, scope: row.scope, revision,
      payload: { kind: 'message', channel: row.scope.channel, content: SESSION_KEY_TEXT.ready, classification: 'safe_summary',
        buttons: [{ id: `${SESSION_KEY_BUTTON}:${row.id}`, label: SESSION_KEY_TEXT.button, style: 'primary' }] } });
    return { state: 'confirmed', reason: KEY_PENDING, content: SESSION_KEY_TEXT.confirmed(spec.executor) };
  },
};
