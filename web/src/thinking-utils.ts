/**
 * Shared thinking-detection logic for chat views.
 * Returns the timestamp of the EARLIEST thinking event in the current continuous
 * thinking sequence (so the elapsed timer doesn't reset when multiple thinking
 * events arrive for the same turn).
 *
 * Only assistant.text, user.message, and session.state=idle end thinking.
 * Tool calls, status updates, and other events are skipped (don't end thinking).
 */

const THINKING_SKIP_TYPES = new Set([
  'agent.status',
  'usage.update',
  'tool.call',
  'tool.result',
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
    // session.state: idle = agent finished (end thinking), running = skip (don't end thinking)
    if (e.type === 'session.state') {
      if (e.payload?.state === 'idle') break;
      continue;
    }
    if (THINKING_SKIP_TYPES.has(e.type)) continue;
    break; // assistant.text / user.message / ask.question — thinking ended
  }
  return thinkingTs;
}

/**
 * Unified "visual busy" derivation — single source of truth for all running animations.
 * Use this instead of ad-hoc conditions in each component.
 *
 * Only authoritative session.state drives the main animation (scan-sweep, subcard pulse).
 * activeThinking is intentionally NOT used here — it's a derivative signal that can linger
 * after the agent stops (e.g., Gemini idle confirmation takes 3+s). Using it caused ghost
 * animations on the main session input bar. activeThinking should only drive text labels
 * and thinking timers, not high-visibility animations.
 */
/**
 * Extract active agent status label (e.g. "Reading file...") from the tail of events.
 * Returns the label of the last agent.status event if it's at the very end of the
 * event stream (only other agent.status events may follow it).
 */
export function getActiveStatusText(events: Array<{ type: string; payload?: Record<string, unknown> }>): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'agent.status') {
      if (e.payload?.label) return String(e.payload.label);
      return null;
    }
    if (e.type !== 'agent.status') break;
  }
  return null;
}

export function isRunningSessionState(sessionState: string | undefined): boolean {
  return sessionState === 'running';
}

export function isVisuallyBusy(sessionState: string | undefined, _activeThinking: boolean): boolean {
  return isRunningSessionState(sessionState);
}
