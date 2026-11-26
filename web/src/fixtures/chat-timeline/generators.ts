/**
 * Deterministic TimelineEvent[] fixture generators for the chat-timeline
 * virtualization work.
 *
 * These build RAW events matching the shapes ChatView.tsx branches on (see
 * `web/src/components/ChatView.tsx`, read-only reference — never imported
 * here to avoid a source coupling; the payload fields below were read off
 * that file's switch/case bodies and its tool.call+tool.result merge pass).
 *
 * Row-count contract
 * -------------------
 * "Presentation rows" means the length of the array `buildViewItems(events,
 * showToolCalls)` produces in ChatView.tsx (exported for tests as
 * `__buildViewItemsForTests`). That function is mode-dependent: several
 * content types (`file.change`, `assistant.thinking`, unlinked
 * `memory.context`) are filtered out entirely when `showToolCalls` is false
 * (ChatView's "simple" chat mode) and rendered as their own row when it is
 * true ("developer" mode). A fresh ChatView with no saved preference resolves
 * `showToolCalls` to `true` (see ChatView.tsx ~2081: `value !== false`), so
 * developer mode is both the default a bare fixture harness observes AND the
 * mode these generators plan against. `expectedPresentationRowsDeveloperMode`
 * on each fixture's `meta` is the count these generators computed while
 * building the event list — `chat-timeline-fixtures.test.ts` cross-checks it
 * against the real `__buildViewItemsForTests` output rather than trusting
 * this module's own bookkeeping.
 */
import type { TimelineEvent } from '../../ws-client.js';
import type { FileChangeBatch } from '@shared/file-change.js';
import { TIMELINE_EVENT_FILE_CHANGE } from '@shared/file-change.js';
import { AGENT_DELEGATION_REPLY_TIMELINE_EVENT } from '@shared/agent-delegation.js';
import {
  createSeededRng,
  intBetween,
  markdownBlock,
  markdownImage,
  pick,
  sentence,
  shuffledIndices,
  word,
  type Rng,
} from './prng.js';

export const CHAT_TIMELINE_FIXTURE_SIZES = [300, 2000, 5000] as const;
export type ChatTimelineFixtureSize = (typeof CHAT_TIMELINE_FIXTURE_SIZES)[number];

/** Fixed default epoch so `?seed=` alone reproduces a fixture byte-for-byte
 *  without also having to pin a base timestamp. */
export const CHAT_TIMELINE_FIXTURE_DEFAULT_BASE_TS = 1_700_000_000_000;
export const CHAT_TIMELINE_FIXTURE_DEFAULT_SEED = 424242;

// ---------------------------------------------------------------------------
// Envelope construction
// ---------------------------------------------------------------------------

/** Builds the TimelineEvent envelope fields (eventId/seq/ts/source/...) so
 *  every turn-builder below only has to supply `type` + `payload`. */
class TimelineBuilder {
  readonly events: TimelineEvent[] = [];
  private seq = 0;
  private ts: number;

  constructor(private readonly rng: Rng, private readonly sessionId: string, baseTs: number, private readonly tag: string) {
    this.ts = baseTs;
  }

  private nextTs(): number {
    // Organic-looking but fully deterministic spacing between events.
    this.ts += intBetween(this.rng, 150, 4000);
    return this.ts;
  }

  push(type: TimelineEvent['type'], payload: Record<string, unknown>, opts: { eventId?: string; ts?: number } = {}): TimelineEvent {
    this.seq += 1;
    const eventId = opts.eventId ?? `evt_${this.tag}_${this.seq.toString(36)}`;
    const ts = opts.ts ?? this.nextTs();
    const event: TimelineEvent = {
      eventId,
      sessionId: this.sessionId,
      ts,
      seq: this.seq,
      epoch: 0,
      source: 'daemon',
      confidence: 'high',
      type,
      payload,
    };
    this.events.push(event);
    return event;
  }
}

const TOOL_NAMES = ['Read', 'Bash', 'Grep', 'Write', 'Edit', 'WebSearch', 'Glob'] as const;

function toolInputFor(tool: string, rng: Rng, index: number): string {
  switch (tool) {
    case 'Bash': return `npm run build:fixture-${index} -- --seed=${intBetween(rng, 1, 999)}`;
    case 'Read': return `/repo/src/${word(rng)}/${word(rng)}-${index}.ts`;
    case 'Write':
    case 'Edit': return `/repo/src/${word(rng)}/${word(rng)}-${index}.ts`;
    case 'Grep': return `${word(rng)}_${word(rng)}`;
    case 'WebSearch': return `${word(rng)} ${word(rng)} best practices`;
    default: return `${word(rng)}/${word(rng)}-${index}`;
  }
}

function toolOutputFor(tool: string, rng: Rng, index: number): string {
  if (tool === 'Bash') return `ok (${intBetween(rng, 1, 400)}ms) — ${sentence(rng, 3, 6)}`;
  return `${sentence(rng, 3, 8)} [#${index}]`;
}

// ---------------------------------------------------------------------------
// Content-mix fixture (300 / 2,000 / 5,000 presentation rows)
// ---------------------------------------------------------------------------

export interface ChatTimelineFixtureOptions {
  seed: number;
  baseTs: number;
  sessionId?: string;
  /** Exact developer-mode presentation-row target (see module doc). */
  targetPresentationRows: number;
}

export interface ChatTimelineFixtureMeta {
  seed: number;
  sessionId: string;
  targetPresentationRows: number;
  expectedPresentationRowsDeveloperMode: number;
  rawEventCount: number;
}

export interface ChatTimelineFixture {
  events: TimelineEvent[];
  meta: ChatTimelineFixtureMeta;
}

/** One "turn" in the content-mix pattern. `rowContribution` is the number of
 *  developer-mode presentation rows this turn is known to add (0 or 1 — see
 *  module doc; verified against the real consolidation logic in tests). */
type TurnResult = { rowContribution: 0 | 1; userEventId?: string };

/** A run of correlated (and, in chunks >1, interleaved) tool.call/tool.result
 *  pairs, plus optional dangling (unpaired) calls, all as ONE contiguous
 *  block of tool.call/tool.result events. ChatView's grouping pass collapses
 *  any contiguous run of tool events into exactly one row regardless of how
 *  many pairs it contains — that's what makes the tool-heavy fixture's
 *  "one row, 2000 rendered details" shape possible. */
function emitToolRun(
  b: TimelineBuilder,
  rng: Rng,
  tag: string,
  pairCount: number,
  danglingCount: number,
): { firstToolCallId: string; lastToolCallId: string } {
  const allCallIds: string[] = [];
  let emitted = 0;
  while (emitted < pairCount) {
    const chunk = Math.min(intBetween(rng, 2, 4), pairCount - emitted);
    const chunkIds: string[] = [];
    for (let k = 0; k < chunk; k++) {
      const toolCallId = `call_${tag}_${emitted + k}`;
      chunkIds.push(toolCallId);
      allCallIds.push(toolCallId);
      const tool = pick(rng, TOOL_NAMES);
      b.push('tool.call', { tool, toolCallId, input: toolInputFor(tool, rng, emitted + k) });
    }
    // Interleave: results land in a shuffled (deterministic) order relative
    // to their calls, exercising id-correlation rather than adjacency.
    const order = shuffledIndices(rng, chunk);
    for (const idx of order) {
      const toolCallId = chunkIds[idx];
      const tool = pick(rng, TOOL_NAMES);
      const failed = rng() < 0.05;
      b.push('tool.result', failed
        ? { toolCallId, error: `${tool} failed: ${sentence(rng, 3, 6)}` }
        : { toolCallId, output: toolOutputFor(tool, rng, emitted + idx), detail: { input: toolInputFor(tool, rng, emitted + idx) } });
    }
    emitted += chunk;
  }
  for (let d = 0; d < danglingCount; d++) {
    const toolCallId = `call_${tag}_dangling_${d}`;
    allCallIds.push(toolCallId);
    const tool = pick(rng, TOOL_NAMES);
    // No matching tool.result is ever emitted for these — they stay
    // unmerged, each still contributing one entry to the rendered run.
    b.push('tool.call', { tool, toolCallId, input: toolInputFor(tool, rng, d) });
  }
  return { firstToolCallId: allCallIds[0] ?? '', lastToolCallId: allCallIds[allCallIds.length - 1] ?? '' };
}

function buildUserText(b: TimelineBuilder, text: string, extra: Record<string, unknown> = {}): TurnResult {
  const ev = b.push('user.message', { text, ...extra });
  return { rowContribution: 1, userEventId: ev.eventId };
}

function buildAssistantMarkdown(b: TimelineBuilder, rng: Rng, size: 'short' | 'medium' | 'long', withImage = false): TurnResult {
  const text = withImage
    ? `${markdownBlock(rng, size)}\n\n${markdownImage(rng, intBetween(rng, 1, 999999))}`
    : markdownBlock(rng, size);
  b.push('assistant.text', { text });
  return { rowContribution: 1 };
}

function buildAssistantStreamingUpdate(b: TimelineBuilder, rng: Rng): TurnResult {
  // Same eventId across several raw events simulates progressive streaming
  // deltas. ChatView's pre-pass keeps only the LAST occurrence of a given
  // eventId, so this still nets exactly one presentation row.
  const eventId = `evt_stream_${Math.floor(rng() * 1e9).toString(36)}`;
  let text = word(rng);
  b.push('assistant.text', { text, streaming: true }, { eventId });
  text = `${text} ${word(rng)} ${word(rng)}`;
  b.push('assistant.text', { text, streaming: true }, { eventId });
  text = `${text} ${sentence(rng, 4, 8)}`;
  b.push('assistant.text', { text }, { eventId });
  return { rowContribution: 1 };
}

function buildToolRunSmall(b: TimelineBuilder, rng: Rng, tag: string): TurnResult {
  emitToolRun(b, rng, tag, intBetween(rng, 1, 3), 0);
  return { rowContribution: 1 };
}

function buildToolRunInterleaved(b: TimelineBuilder, rng: Rng, tag: string): TurnResult {
  emitToolRun(b, rng, tag, intBetween(rng, 3, 6), 0);
  return { rowContribution: 1 };
}

function buildToolRunDangling(b: TimelineBuilder, rng: Rng, tag: string): TurnResult {
  emitToolRun(b, rng, tag, intBetween(rng, 0, 2), intBetween(rng, 1, 2));
  return { rowContribution: 1 };
}

function buildMemoryContextLinked(b: TimelineBuilder, rng: Rng, relatedToEventId: string | null): TurnResult {
  if (!relatedToEventId) return { rowContribution: 0 };
  b.push('memory.context', {
    relatedToEventId,
    query: sentence(rng, 3, 6),
    reason: 'message',
    items: [
      { id: `mem_${intBetween(rng, 1, 999999)}`, projectId: 'fixture-project', summary: sentence(rng, 6, 12), relevanceScore: rng() },
    ],
  });
  // Linked memory.context is attached to the preceding user row (not its own
  // row) — see ChatView's `linkedMemoryEvents` pass, which pulls anything
  // whose relatedToEventId matches a user.message id out of `renderable`.
  return { rowContribution: 0 };
}

function buildMemoryContextUnlinked(b: TimelineBuilder, rng: Rng): TurnResult {
  b.push('memory.context', {
    query: sentence(rng, 3, 6),
    reason: 'startup',
    status: 'no_matches',
    items: [],
  });
  return { rowContribution: 1 };
}

function buildFileChange(b: TimelineBuilder, rng: Rng, index: number): TurnResult {
  const batch: FileChangeBatch = {
    provider: 'claude-code',
    title: `Update ${word(rng)}-${index}.ts`,
    patches: [
      {
        filePath: `src/${word(rng)}/${word(rng)}-${index}.ts`,
        operation: 'update',
        confidence: 'exact',
        unifiedDiff: `@@ -1,2 +1,2 @@\n-const ${word(rng)} = 1;\n+const ${word(rng)} = 2;\n`,
      },
    ],
  };
  b.push(TIMELINE_EVENT_FILE_CHANGE, { batch });
  return { rowContribution: 1 };
}

function buildDelegationCard(b: TimelineBuilder, rng: Rng): TurnResult {
  b.push(AGENT_DELEGATION_REPLY_TIMELINE_EVENT, {
    memoryExcluded: true,
    sourceSessionName: `deck_fixture_${word(rng)}`,
    sourceLabel: `Delegate ${word(rng)}`,
    result: paragraphResult(rng),
  });
  return { rowContribution: 1 };
}

function paragraphResult(rng: Rng): string {
  return sentence(rng, 8, 16);
}

function buildPeerAuditResult(b: TimelineBuilder, rng: Rng): TurnResult {
  b.push('peer_audit.result', {
    memoryExcluded: true,
    trigger: pick(rng, ['automatic', 'quick'] as const),
    outcome: pick(rng, ['pass', 'rework'] as const),
    auditorSessionName: `deck_fixture_${word(rng)}`,
    auditorLabel: `Auditor ${word(rng)}`,
    elapsedMs: intBetween(rng, 2000, 120000),
    findingsPreview: sentence(rng, 6, 12),
  });
  return { rowContribution: 1 };
}

function buildSnapshot(b: TimelineBuilder, rng: Rng): TurnResult {
  // Always filtered out of the rendered chat log by ChatView regardless of
  // mode (`isVisibleChatTimelineEvent` excludes 'terminal.snapshot'
  // unconditionally) — included for content-mix realism only, 0 rows.
  b.push('terminal.snapshot', {
    lines: Array.from({ length: intBetween(rng, 3, 12) }, () => `$ ${sentence(rng, 2, 5)}`),
  });
  return { rowContribution: 0 };
}

function buildAssistantThinkingStandalone(b: TimelineBuilder, rng: Rng): TurnResult {
  b.push('assistant.thinking', { text: sentence(rng, 5, 10), durationMs: intBetween(rng, 400, 9000) });
  return { rowContribution: 1 };
}

const USER_TEXT_LENGTHS: ReadonlyArray<[number, number]> = [[4, 8], [10, 24], [30, 60]];

function variableHeightUserText(rng: Rng, index: number): string {
  const [min, max] = pick(rng, USER_TEXT_LENGTHS);
  const lines = intBetween(rng, 1, 3);
  return Array.from({ length: lines }, () => sentence(rng, min, max)).join('\n') + ` (#${index})`;
}

type TurnKind =
  | 'userText' | 'assistantShort' | 'toolRunSmall' | 'assistantLong' | 'userAttachment'
  | 'assistantStreaming' | 'toolRunInterleaved' | 'userPending' | 'assistantMedium'
  | 'memoryLinked' | 'userFailed' | 'toolRunDangling' | 'assistantWithImage'
  | 'delegationCard' | 'memoryUnlinked' | 'peerAudit' | 'fileChange' | 'userText2'
  | 'assistantThinking' | 'snapshot';

/** Order matters: no two turns whose events are BOTH type `assistant.text`
 *  are ever adjacent (that would merge into one row instead of two), and
 *  every turn is safe to truncate the sequence after (see module doc /
 *  chat-timeline-fixtures.test.ts for the adjacency argument). */
const CONTENT_MIX_PATTERN: readonly TurnKind[] = [
  'userText', 'assistantShort', 'toolRunSmall', 'assistantLong', 'userAttachment',
  'assistantStreaming', 'toolRunInterleaved', 'userPending', 'assistantMedium',
  'memoryLinked', 'userFailed', 'toolRunDangling', 'assistantWithImage',
  'delegationCard', 'memoryUnlinked', 'peerAudit', 'fileChange', 'userText2',
  'assistantThinking', 'snapshot',
];

function applyTurn(kind: TurnKind, b: TimelineBuilder, rng: Rng, turnIndex: number, lastUserEventId: string | null): TurnResult {
  switch (kind) {
    case 'userText': return buildUserText(b, variableHeightUserText(rng, turnIndex));
    case 'assistantShort': return buildAssistantMarkdown(b, rng, 'short');
    case 'toolRunSmall': return buildToolRunSmall(b, rng, `mix_${turnIndex}`);
    case 'assistantLong': return buildAssistantMarkdown(b, rng, 'long');
    case 'userAttachment': return buildUserText(b, `Attached a screenshot. (#${turnIndex})`, {
      attachments: [{ id: `att_${turnIndex}`, originalName: `screenshot-${turnIndex}.png`, mime: 'image/png', size: intBetween(rng, 2000, 900000), daemonPath: `/tmp/screenshot-${turnIndex}.png` }],
    });
    case 'assistantStreaming': return buildAssistantStreamingUpdate(b, rng);
    case 'toolRunInterleaved': return buildToolRunInterleaved(b, rng, `mix_${turnIndex}`);
    case 'userPending': return buildUserText(b, variableHeightUserText(rng, turnIndex), { pending: true, commandId: `cmd_${turnIndex}` });
    case 'assistantMedium': return buildAssistantMarkdown(b, rng, 'medium');
    case 'memoryLinked': return buildMemoryContextLinked(b, rng, lastUserEventId);
    case 'userFailed': return buildUserText(b, variableHeightUserText(rng, turnIndex), { failed: true, failureReason: 'network error', commandId: `cmd_${turnIndex}` });
    case 'toolRunDangling': return buildToolRunDangling(b, rng, `mix_${turnIndex}`);
    case 'assistantWithImage': return buildAssistantMarkdown(b, rng, 'medium', true);
    case 'delegationCard': return buildDelegationCard(b, rng);
    case 'memoryUnlinked': return buildMemoryContextUnlinked(b, rng);
    case 'peerAudit': return buildPeerAuditResult(b, rng);
    case 'fileChange': return buildFileChange(b, rng, turnIndex);
    case 'userText2': return buildUserText(b, variableHeightUserText(rng, turnIndex));
    case 'assistantThinking': return buildAssistantThinkingStandalone(b, rng);
    case 'snapshot': return buildSnapshot(b, rng);
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled turn kind: ${String(exhaustive)}`);
    }
  }
}

/**
 * Generates a full content-mix fixture with exactly `targetPresentationRows`
 * developer-mode rows (300 / 2,000 / 5,000 are the required sizes, but any
 * positive integer works — the smoke test uses a small one).
 */
export function generateChatTimelineFixture(options: ChatTimelineFixtureOptions): ChatTimelineFixture {
  const { seed, baseTs, targetPresentationRows } = options;
  const sessionId = options.sessionId ?? `fixture-session-mix-${seed}`;
  const rng = createSeededRng(seed);
  const b = new TimelineBuilder(rng, sessionId, baseTs, `mix${seed}`);

  let rows = 0;
  let lastUserEventId: string | null = null;
  let turnIndex = 0;
  while (rows < targetPresentationRows) {
    const kind = CONTENT_MIX_PATTERN[turnIndex % CONTENT_MIX_PATTERN.length];
    const result = applyTurn(kind, b, rng, turnIndex, lastUserEventId);
    rows += result.rowContribution;
    if (result.userEventId) lastUserEventId = result.userEventId;
    turnIndex += 1;
  }

  return {
    events: b.events,
    meta: {
      seed,
      sessionId,
      targetPresentationRows,
      expectedPresentationRowsDeveloperMode: rows,
      rawEventCount: b.events.length,
    },
  };
}

export function generateSizedChatTimelineFixture(size: ChatTimelineFixtureSize, seed = CHAT_TIMELINE_FIXTURE_DEFAULT_SEED, baseTs = CHAT_TIMELINE_FIXTURE_DEFAULT_BASE_TS): ChatTimelineFixture {
  return generateChatTimelineFixture({ seed, baseTs, targetPresentationRows: size });
}

// ---------------------------------------------------------------------------
// Tool-heavy fixture — 2,000 rendered details in one compact tool-activity
// row AND 2,000 in one developer tool-group row.
// ---------------------------------------------------------------------------

export const TOOL_HEAVY_DEFAULT_DETAIL_COUNT = 2000;

export const TOOL_HEAVY_MARKERS = {
  beforeCompact: '__FIXTURE_MARKER__before_compact_tool_block__',
  afterCompact: '__FIXTURE_MARKER__after_compact_tool_block__',
  beforeDeveloper: '__FIXTURE_MARKER__before_developer_tool_block__',
  afterDeveloper: '__FIXTURE_MARKER__after_developer_tool_block__',
} as const;

export interface ToolHeavyFixtureOptions {
  seed: number;
  baseTs: number;
  sessionId?: string;
  /** Correlated call/result pairs feeding the "compact" (simple-mode
   *  tool-activity) block. Each pair consolidates to ONE rendered detail. */
  compactPairedCallCount?: number;
  /** Unpaired/dangling calls appended to the compact block. Each dangling
   *  call is ALSO one rendered detail (it never merges), so the block's
   *  total rendered-detail count is paired + dangling. */
  compactDanglingCallCount?: number;
  developerPairedCallCount?: number;
  developerDanglingCallCount?: number;
}

export interface ToolHeavyFixtureBlockMeta {
  /** Explicit, generator-computed rendered-detail count for this block —
   *  callers must not have to infer it from raw event counts. Verified
   *  against ChatView's real consolidation in chat-timeline-fixtures.test.ts. */
  renderedDetailCount: number;
  pairedCallCount: number;
  danglingCallCount: number;
  beforeMarker: string;
  afterMarker: string;
  beforeEventId: string;
  afterEventId: string;
  firstToolCallId: string;
  lastToolCallId: string;
}

export interface ToolHeavyFixtureMeta {
  seed: number;
  sessionId: string;
  rawEventCount: number;
  compactBlock: ToolHeavyFixtureBlockMeta;
  developerBlock: ToolHeavyFixtureBlockMeta;
}

export interface ToolHeavyFixture {
  events: TimelineEvent[];
  meta: ToolHeavyFixtureMeta;
}

export function generateToolHeavyFixture(options: ToolHeavyFixtureOptions): ToolHeavyFixture {
  const { seed, baseTs } = options;
  const sessionId = options.sessionId ?? `fixture-session-tool-heavy-${seed}`;
  const rng = createSeededRng(seed);
  const b = new TimelineBuilder(rng, sessionId, baseTs, `heavy${seed}`);

  const compactPaired = options.compactPairedCallCount ?? TOOL_HEAVY_DEFAULT_DETAIL_COUNT;
  const compactDangling = options.compactDanglingCallCount ?? 0;
  const developerPaired = options.developerPairedCallCount ?? TOOL_HEAVY_DEFAULT_DETAIL_COUNT;
  const developerDangling = options.developerDanglingCallCount ?? 0;

  // Bracket shape is deliberate, not decorative: ChatView's Simple view
  // ("showToolCalls=false") only flushes accumulated tool events at the
  // NEXT USER TURN, not at the next assistant.text (see ChatView.tsx's
  // buildViewItems: `if (showToolCalls) flushTools();` inside the
  // assistant.text branch — false in Simple view, so an assistant.text row
  // placed right after a tool run would render AFTER the tool-activity rail,
  // not before it, and the "one row between the brackets" shape below would
  // break). A `user.message` unconditionally flushes pending tools in EVERY
  // mode, so using assistant.text for the row above a block and user.message
  // for the row below it keeps both blocks correctly bracketed regardless of
  // which showToolCalls mode a given assertion runs under.
  b.push('user.message', { text: 'Kick off the compact tool-activity scenario.' });
  const beforeCompact = b.push('assistant.text', { text: TOOL_HEAVY_MARKERS.beforeCompact });
  const compactRun = emitToolRun(b, rng, `${seed}_compact`, compactPaired, compactDangling);
  const afterCompact = b.push('user.message', { text: TOOL_HEAVY_MARKERS.afterCompact });

  const beforeDeveloper = b.push('assistant.text', { text: TOOL_HEAVY_MARKERS.beforeDeveloper });
  const developerRun = emitToolRun(b, rng, `${seed}_developer`, developerPaired, developerDangling);
  const afterDeveloper = b.push('user.message', { text: TOOL_HEAVY_MARKERS.afterDeveloper });
  b.push('assistant.text', { text: 'All scenarios complete.' });

  return {
    events: b.events,
    meta: {
      seed,
      sessionId,
      rawEventCount: b.events.length,
      compactBlock: {
        renderedDetailCount: compactPaired + compactDangling,
        pairedCallCount: compactPaired,
        danglingCallCount: compactDangling,
        beforeMarker: TOOL_HEAVY_MARKERS.beforeCompact,
        afterMarker: TOOL_HEAVY_MARKERS.afterCompact,
        beforeEventId: beforeCompact.eventId,
        afterEventId: afterCompact.eventId,
        firstToolCallId: compactRun.firstToolCallId,
        lastToolCallId: compactRun.lastToolCallId,
      },
      developerBlock: {
        renderedDetailCount: developerPaired + developerDangling,
        pairedCallCount: developerPaired,
        danglingCallCount: developerDangling,
        beforeMarker: TOOL_HEAVY_MARKERS.beforeDeveloper,
        afterMarker: TOOL_HEAVY_MARKERS.afterDeveloper,
        beforeEventId: beforeDeveloper.eventId,
        afterEventId: afterDeveloper.eventId,
        firstToolCallId: developerRun.firstToolCallId,
        lastToolCallId: developerRun.lastToolCallId,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Smoke fixture — minimal, unambiguous shape for the Playwright harness
// smoke test. Plain user.message rows only: exactly `rowCount` presentation
// rows in EITHER showToolCalls mode, and each renders as a single
// `.chat-event.chat-user[data-event-id]` element with no nested sub-rows,
// so the smoke test can assert a DOM count without depending on
// tool/assistant consolidation internals.
// ---------------------------------------------------------------------------

export interface SmokeFixtureOptions {
  seed: number;
  baseTs: number;
  sessionId?: string;
  rowCount?: number;
}

export const SMOKE_FIXTURE_DEFAULT_ROW_COUNT = 20;

export function generateSmokeFixture(options: SmokeFixtureOptions): ChatTimelineFixture {
  const { seed, baseTs } = options;
  const rowCount = options.rowCount ?? SMOKE_FIXTURE_DEFAULT_ROW_COUNT;
  const sessionId = options.sessionId ?? `fixture-session-smoke-${seed}`;
  const rng = createSeededRng(seed);
  const b = new TimelineBuilder(rng, sessionId, baseTs, `smoke${seed}`);

  for (let i = 0; i < rowCount; i++) {
    b.push('user.message', { text: `Smoke row ${i + 1}: ${sentence(rng, 4, 10)}` });
  }

  return {
    events: b.events,
    meta: {
      seed,
      sessionId,
      targetPresentationRows: rowCount,
      expectedPresentationRowsDeveloperMode: rowCount,
      rawEventCount: b.events.length,
    },
  };
}
