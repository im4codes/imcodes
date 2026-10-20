/**
 * Deterministic, production-shaped timeline for the stale-window scenario (test-only).
 *
 * Both the fake daemon (which serves it as the session's authoritative history) and the browser spec
 * (which seeds the OLD block of it into IndexedDB as the window's stale local cache) build it from
 * these constants, so the two sides always agree on ids, timestamps and text without sharing memory.
 *
 * Shape: turns of user.message -> assistant.text -> tool.call -> tool.result -> tool.call -> tool.result,
 * i.e. one readable message in three events, with tool bodies mostly small and every 9th turn a large
 * (30 KB) result — the "session with huge tool outputs" case the text-first peek exists for.
 */
export const STALE_SESSION_NAME = 'deck_perflat_imcperf-stale_brain';
/** Fixed origin so daemon and browser agree without a clock; far enough in the past to always be stale. */
export const STALE_BASE_TS = Date.UTC(2026, 8, 20, 8, 0, 0);
export const STALE_STEP_MS = 40_000;
export const STALE_EPOCH = 1;

export function buildStaleTimeline({ name = STALE_SESSION_NAME, total = 6000 } = {}) {
  const events = [];
  for (let index = 0; index < total; index += 1) {
    const turn = Math.floor(index / 6);
    const slot = index % 6;
    const type = ['user.message', 'assistant.text', 'tool.call', 'tool.result', 'tool.call', 'tool.result'][slot];
    const big = turn % 9 === 4;
    let payload;
    if (type === 'user.message') payload = { text: `stale-user-${turn}: please continue with step ${turn}` };
    else if (type === 'assistant.text') payload = { text: `stale-msg-${index}: working on step ${turn}; here is what I found so far.`, streaming: false };
    else if (type === 'tool.call') payload = { name: 'shell', status: 'running', input: `rg -n step${turn}` };
    else payload = { name: 'shell', status: 'ok', output: `${'r'.repeat(big ? 30_000 : 1_500)}#${index}` };
    events.push({
      eventId: `stale-${name}-${index}`,
      sessionId: name,
      epoch: STALE_EPOCH,
      seq: index + 1,
      ts: STALE_BASE_TS + index * STALE_STEP_MS,
      source: 'daemon',
      confidence: 'high',
      type,
      payload,
    });
  }
  return events;
}

/** The newest readable message's text, so the spec can wait for it to appear. */
export function newestStaleText(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'assistant.text') return event.payload.text;
  }
  return null;
}
