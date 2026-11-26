/**
 * Deterministic pseudo-random content generation for chat-timeline fixtures.
 *
 * Browser benchmarks compare runs against each other, so fixture content must
 * be byte-identical run to run for the same seed. Every generator in this
 * directory threads a seeded RNG explicitly and never touches Math.random()
 * or Date.now() — timestamps are derived from a caller-supplied `baseTs` plus
 * RNG-driven (but reproducible) deltas.
 */

export type Rng = () => number;

/**
 * mulberry32 — small, fast, good-enough distribution for fixture content (not
 * cryptographic). Same 32-bit seed produces the same infinite sequence.
 */
export function createSeededRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  const index = Math.floor(rng() * items.length) % items.length;
  return items[index];
}

/** Inclusive on both ends. */
export function intBetween(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Deterministic Fisher-Yates shuffle of `[0, count)`. */
export function shuffledIndices(rng: Rng, count: number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  return order;
}

const WORD_BANK = [
  'session', 'timeline', 'render', 'virtualize', 'window', 'buffer', 'chunk',
  'consolidate', 'merge', 'stream', 'delta', 'payload', 'event', 'anchor',
  'scroll', 'height', 'measure', 'layout', 'reflow', 'commit', 'daemon',
  'tmux', 'transport', 'provider', 'agent', 'tool', 'call', 'result',
  'correlate', 'fixture', 'seed', 'deterministic', 'benchmark', 'harness',
  'markdown', 'block', 'diff', 'patch', 'repository', 'branch', 'snapshot',
  'memory', 'context', 'recall', 'projection', 'delegate', 'audit',
  'verdict', 'attachment', 'preview', 'thumbnail', 'throttle', 'cache',
  'identity', 'weakmap', 'reconcile', 'reorder', 'threshold', 'follow',
  'unfollow', 'reveal', 'bracket', 'marker', 'pending', 'failed', 'retry',
] as const;

export function word(rng: Rng): string {
  return pick(rng, WORD_BANK);
}

export function sentence(rng: Rng, minWords = 5, maxWords = 14): string {
  const count = intBetween(rng, minWords, maxWords);
  const words = Array.from({ length: count }, () => word(rng));
  const text = words.join(' ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

export function paragraph(rng: Rng, minSentences = 2, maxSentences = 5): string {
  const count = intBetween(rng, minSentences, maxSentences);
  return Array.from({ length: count }, () => sentence(rng)).join(' ');
}

export function bulletList(rng: Rng, minItems = 2, maxItems = 5): string {
  const count = intBetween(rng, minItems, maxItems);
  return Array.from({ length: count }, () => `- ${sentence(rng, 3, 9)}`).join('\n');
}

const CODE_LANGS = ['ts', 'tsx', 'bash', 'json'] as const;

export function codeBlock(rng: Rng, lines = 4): string {
  const lang = pick(rng, CODE_LANGS);
  const body = Array.from(
    { length: lines },
    () => `const ${word(rng)}_${intBetween(rng, 0, 999)} = ${word(rng)}("${word(rng)}");`,
  ).join('\n');
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}

export type MarkdownBlockSize = 'short' | 'medium' | 'long';

/**
 * Builds Markdown text sized to exercise variable row heights in the
 * virtualization work — 'short' is a one-liner, 'long' stacks a heading,
 * two paragraphs, a list, and a code block.
 */
export function markdownBlock(rng: Rng, size: MarkdownBlockSize, headingWord?: string): string {
  const heading = headingWord ?? word(rng);
  if (size === 'short') return sentence(rng, 4, 9);
  if (size === 'medium') {
    return [
      `## ${heading}`,
      paragraph(rng, 2, 3),
      bulletList(rng, 2, 3),
    ].join('\n\n');
  }
  return [
    `## ${heading}`,
    paragraph(rng, 3, 5),
    bulletList(rng, 3, 5),
    codeBlock(rng, intBetween(rng, 4, 9)),
    paragraph(rng, 1, 2),
  ].join('\n\n');
}

/** Deterministic "delayed-loading" image reference — a Markdown image whose
 *  URL will not resolve instantly (or at all, offline), so it exercises the
 *  same late-arriving-content / layout-shift path a real slow image does. */
export function markdownImage(rng: Rng, index: number): string {
  const w = pick(rng, [320, 480, 640]);
  const h = pick(rng, [180, 240, 360]);
  return `![fixture image ${index}](https://picsum.photos/seed/chat-timeline-${index}/${w}/${h})`;
}
