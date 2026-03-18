/**
 * Shared thinking-detection logic for chat views.
 * Returns the timestamp of the EARLIEST thinking event in the current continuous
 * thinking sequence (so the elapsed timer doesn't reset when multiple thinking
 * events arrive for the same turn).
 *
 * Only assistant.text and user.message end thinking.
 * All other event types (tool calls, state changes, hooks, status) are skipped.
 */

const THINKING_SKIP_TYPES = new Set([
  'agent.status',
  'usage.update',
  'tool.call',
  'tool.result',
  'session.state',
  'mode.state',
  'terminal.snapshot',
  'command.ack',
]);

export function getActiveThinkingTs(events: Array<{ type: string; ts: number; payload?: Record<string, unknown> }>): number | null {
  let thinkingTs: number | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'assistant.thinking') {
      // Keep walking backwards — we want the EARLIEST thinking ts so the timer
      // doesn't restart when multiple thinking events arrive in one turn.
      thinkingTs = e.ts;
      continue;
    }
    // session.state=idle means agent finished — end thinking
    if (e.type === 'session.state' && e.payload?.state === 'idle') break;
    if (THINKING_SKIP_TYPES.has(e.type)) continue;
    break; // assistant.text / user.message / ask.question — thinking ended
  }
  return thinkingTs;
}
