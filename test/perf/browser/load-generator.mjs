#!/usr/bin/env node

/** Deterministic synthetic many-window timeline workload. */
export const DEFAULT_WORKLOAD = Object.freeze({
  seed: 0x4d57494e,
  sessions: 20,
  streamingSessions: 5,
  hiddenSessions: 10,
  statusHz: 12,
  streamHz: 25,
});

export function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sessionName(seed, index) {
  // Guarded test family plus production-shaped deck_<project>_<role> syntax,
  // so the real SPA treats every generated window as a navigable brain.
  return `deck_perflat_imcperf-${(seed >>> 0).toString(36)}-${index.toString(36)}_brain`;
}

export function buildWorkload(options = {}) {
  const config = { ...DEFAULT_WORKLOAD, ...options };
  const rng = createRng(config.seed);
  const sessions = Array.from({ length: config.sessions }, (_, index) => ({
    id: sessionName(config.seed, index),
    name: sessionName(config.seed, index),
    index,
    full: index < config.sessions - config.hiddenSessions,
    streaming: index < config.streamingSessions,
    events: [],
    finalText: `Final answer for ${sessionName(config.seed, index)}.`,
  }));
  for (const session of sessions) {
    const bodyBytes = 19_000 + Math.floor(rng() * 40_001);
    session.events.push({ type: 'user.message', seq: 1, text: `Work request ${session.index}.` });
    session.events.push({ type: 'tool.call', seq: 2, name: 'shell', status: 'running', bodyBytes });
    session.events.push({ type: 'tool.result', seq: 3, name: 'shell', status: 'ok', bodyBytes });
    session.events.push({ type: 'session.state', seq: 4, state: 'running' });
  }
  return { ...config, sessions };
}

export function streamingEvents(session, count, startSeq = 5) {
  return Array.from({ length: count }, (_, offset) => ({
    sessionId: session.id,
    type: 'assistant.text',
    seq: startSeq + offset,
    streaming: true,
    text: `stream-${offset} `,
  }));
}

export function finalEvent(session, seq) {
  return { sessionId: session.id, type: 'assistant.text', seq, streaming: false, text: session.finalText };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const workload = buildWorkload({ seed: Number(process.env.IMC_PERF_SEED ?? DEFAULT_WORKLOAD.seed) });
  process.stdout.write(`${JSON.stringify(workload)}\n`);
}
