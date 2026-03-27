/**
 * isUserVisible — shared event visibility policy.
 *
 * Returns true for timeline events that render as standalone conversational
 * content in ChatView. Used by both useUnreadCounts (badge counting) and
 * ChatView (rendering) to keep classification consistent.
 *
 * Classification:
 *   Visible:     user.message, assistant.text, ask.question
 *   Not visible: assistant.thinking (streaming partial — merged into indicator),
 *                session.state, usage.update, tool.result, tool.call, command.ack,
 *                agent.status, mode.state, terminal.snapshot
 *
 * Rule for new event types: if it renders as a visible message row in ChatView,
 * add it here.
 */

const VISIBLE_TYPES = new Set([
  'user.message',
  'assistant.text',
  // assistant.thinking is streaming partial — merged into indicator, not a separate message row
  'ask.question',
]);

export function isUserVisible(event: { type: string; payload?: { streaming?: boolean } }): boolean {
  if (!VISIBLE_TYPES.has(event.type)) return false;
  // Streaming deltas are intermediate updates to the same message — only count the final one.
  if (event.type === 'assistant.text' && event.payload?.streaming === true) return false;
  return true;
}
