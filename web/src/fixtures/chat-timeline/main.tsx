/**
 * Browser harness entry for the chat-timeline virtualization work.
 *
 * Renders the REAL production `ChatView` against a deterministic fixture
 * chosen entirely from the URL query string, so Playwright can navigate to a
 * plain URL and get a reproducible scene without any test-only branching
 * inside ChatView.tsx itself.
 *
 * Query contract
 * --------------
 *   size        'smoke' | '300' | '2000' | '5000' | 'tool-heavy' | <int>
 *               Default '300'. Any positive integer is accepted (content-mix
 *               fixture targeting that many developer-mode presentation
 *               rows) in addition to the three required presets. 'smoke' is
 *               the minimal user-message-only fixture used by the harness's
 *               own smoke test. 'tool-heavy' switches to
 *               generateToolHeavyFixture and ignores the row-count meaning
 *               of `size` entirely.
 *   details     Positive integer. Tool calls per collection for `tool-heavy`.
 *               Defaults to the generator's stress value; set it to a realistic
 *               count to ask whether the stress case is worth designing for.
 *   seed        Positive integer RNG seed. Default CHAT_TIMELINE_FIXTURE_DEFAULT_SEED.
 *   windows     '1' | '4' — how many independent ChatView instances to mount
 *               (all fed the SAME generated event array; ChatView's internal
 *               caches are keyed by event object identity, so sharing is
 *               safe and avoids paying generation cost 4x). Default '1'.
 *
 * Example: /src/fixtures/chat-timeline/index.html?size=2000&windows=4
 *
 * Measurement control (`window.__chatTimelineHarness`)
 * ---------------------------------------------------
 * The performance benchmark drives the timeline from OUTSIDE ChatView: the
 * harness owns the events array and hands ChatView a NEW array on every
 * mutation, which is exactly the identity discipline the real timeline owner
 * uses (`useTimeline` replaces both the array and the changed event object,
 * and ChatView's merged-tool cache is keyed on those object identities). No
 * test-only code path exists inside ChatView; everything below is ordinary
 * prop movement.
 *
 * `appendStreamingChunk` grows the text of the TRAILING assistant event under
 * its existing `eventId`, because that — not a new event per token — is the
 * shape a streaming reply actually has, and it is the one whose per-chunk cost
 * must not scale with history length. If the fixture does not end in an
 * assistant message the first chunk opens one, so the growing row is always the
 * last row of an end-anchored log.
 *
 * `measureDerivation` / `measureRowBuild` call the production pure functions
 * (`buildViewItems` via its exported test seam, and `buildVirtualRows`) on the
 * harness's current events so the benchmark can attribute update cost to
 * derivation and to revision/summary aggregation separately, without
 * instrumenting ChatView.
 */
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import '../../styles.css';
import '../../i18n/index.js';
import { ChatView, __buildViewItemsForTests } from '../../components/ChatView.js';
import type { TimelineEvent } from '../../ws-client.js';
import {
  CHAT_TIMELINE_FIXTURE_DEFAULT_BASE_TS,
  CHAT_TIMELINE_FIXTURE_DEFAULT_SEED,
  generateChatTimelineFixture,
  generateSmokeFixture,
  generateSizedChatTimelineFixture,
  generateToolHeavyFixture,
  type ChatTimelineFixtureSize,
} from './generators.js';

function readQuery(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

function resolveEvents(query: URLSearchParams): { events: TimelineEvent[]; label: string } {
  const seed = Number(query.get('seed')) || CHAT_TIMELINE_FIXTURE_DEFAULT_SEED;
  const baseTs = CHAT_TIMELINE_FIXTURE_DEFAULT_BASE_TS;
  const sizeParam = query.get('size') ?? '300';

  if (sizeParam === 'tool-heavy') {
    // `details` exists because the default of 2,000 is a stress case, not a
    // realistic one: a real agent session runs tens of tools, occasionally a
    // couple of hundred. A comparison that only ever measures the extreme
    // cannot say whether the extreme is worth designing for.
    const details = Number(query.get('details'));
    const options = Number.isInteger(details) && details > 0
      ? { seed, baseTs, compactPairedCallCount: details, developerPairedCallCount: details }
      : { seed, baseTs };
    const fixture = generateToolHeavyFixture(options);
    return { events: fixture.events, label: `tool-heavy (seed=${seed}, details=${details || 'default'})` };
  }
  if (sizeParam === 'smoke') {
    const rowCount = Number(query.get('rows')) || undefined;
    const fixture = generateSmokeFixture({ seed, baseTs, rowCount });
    return { events: fixture.events, label: `smoke (seed=${seed}, rows=${fixture.meta.targetPresentationRows})` };
  }
  const presetSizes: readonly ChatTimelineFixtureSize[] = [300, 2000, 5000];
  const asNumber = Number(sizeParam);
  const preset = presetSizes.find((s) => s === asNumber);
  const fixture = preset !== undefined
    ? generateSizedChatTimelineFixture(preset, seed, baseTs)
    : generateChatTimelineFixture({ seed, baseTs, targetPresentationRows: Math.max(1, asNumber || 300) });
  return { events: fixture.events, label: `mix size=${sizeParam} (seed=${seed})` };
}

// ---------------------------------------------------------------------------
// Harness control surface
// ---------------------------------------------------------------------------

export interface ChatTimelineMeasurement {
  /** Median of `samples`, in milliseconds. */
  medianMs: number;
  samples: number[];
  /** Size of the thing produced, for sanity-checking what was measured. */
  count: number;
}

export interface ChatTimelineHarnessApi {
  readonly windows: number;
  /** `performance.now()` captured immediately before the first Preact render. */
  readonly renderStartMs: number;
  /** True once the first mount's effects have run. */
  ready: boolean;
  eventCount(): number;
  /** Appends one new event under a fresh `eventId`. Returns that id. */
  appendEvent(options?: { type?: string; text?: string }): string;
  /**
   * Grows the trailing assistant message under its EXISTING `eventId`.
   * Returns the id and the new text length.
   */
  appendStreamingChunk(chunk?: string): { eventId: string; length: number };
  /** Restores the generated fixture events (new array identity). */
  reset(): void;
  /** Times `buildViewItems` over the current events. */
  measureDerivation(options?: { runs?: number; showToolCalls?: boolean }): ChatTimelineMeasurement;
}

const query = readQuery();
const { events: initialEvents, label: fixtureLabel } = resolveEvents(query);
const windowCount = query.get('windows') === '4' ? 4 : 1;
/** Live events array. Replaced (never mutated) on every harness update. */
let currentEvents: TimelineEvent[] = initialEvents;
let publishEvents: ((next: TimelineEvent[]) => void) | null = null;
let harnessCounter = 0;

function publish(next: TimelineEvent[]): void {
  currentEvents = next;
  publishEvents?.(next);
}

/**
 * Index of the TRAILING assistant message, or -1 if the timeline does not end
 * in one.
 *
 * Trailing specifically, not "the last assistant message anywhere": the log is
 * end-anchored, so growing a message with other events after it leaves the
 * changed row outside the mounted window and measures a render nobody sees.
 */
function trailingAssistantIndex(events: readonly TimelineEvent[]): number {
  const index = events.length - 1;
  const event = events[index];
  if (!event) return -1;
  return event.type === 'assistant.text' && typeof event.payload?.text === 'string' ? index : -1;
}

function nextEnvelope(type: string, payload: Record<string, unknown>): TimelineEvent {
  const last = currentEvents[currentEvents.length - 1];
  harnessCounter += 1;
  const base = (last ?? {}) as TimelineEvent;
  return {
    ...base,
    eventId: `evt_harness_${harnessCounter.toString(36)}`,
    ts: (base.ts ?? CHAT_TIMELINE_FIXTURE_DEFAULT_BASE_TS) + harnessCounter * 1_000,
    seq: (base.seq ?? 0) + harnessCounter,
    type: type as TimelineEvent['type'],
    payload,
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const harness: ChatTimelineHarnessApi = {
  windows: windowCount,
  renderStartMs: 0,
  ready: false,
  eventCount: () => currentEvents.length,
  appendEvent(options = {}) {
    const type = options.type ?? 'assistant.text';
    const text = options.text ?? `Harness appended message ${harnessCounter + 1}.`;
    const event = nextEnvelope(type, { text });
    publish([...currentEvents, event]);
    return event.eventId;
  },
  appendStreamingChunk(chunk = ' more streamed output') {
    const index = trailingAssistantIndex(currentEvents);
    if (index < 0) {
      // The fixture does not end in an assistant message, so the stream opens
      // one. Every later chunk grows THIS event under its own id, which is the
      // identity-stable trailing stream the benchmark is defined against.
      const event = nextEnvelope('assistant.text', { text: chunk, streaming: true });
      publish([...currentEvents, event]);
      return { eventId: event.eventId, length: chunk.length };
    }
    const existing = currentEvents[index]!;
    const text = `${String(existing.payload.text ?? '')}${chunk}`;
    // New event object under the SAME eventId — the identity signal the real
    // timeline uses to say "this message's content changed".
    const grown: TimelineEvent = { ...existing, payload: { ...existing.payload, text, streaming: true } };
    const next = [...currentEvents];
    next[index] = grown;
    publish(next);
    return { eventId: grown.eventId, length: text.length };
  },
  reset() {
    harnessCounter = 0;
    publish([...initialEvents]);
  },
  measureDerivation(options = {}) {
    const runs = Math.max(1, options.runs ?? 5);
    const showToolCalls = options.showToolCalls ?? true;
    const samples: number[] = [];
    let count = 0;
    for (let i = 0; i < runs; i++) {
      const started = performance.now();
      const items = __buildViewItemsForTests(currentEvents, showToolCalls);
      samples.push(performance.now() - started);
      count = items.length;
    }
    return { medianMs: median(samples), samples, count };
  },
};

(window as unknown as { __chatTimelineHarness?: ChatTimelineHarnessApi }).__chatTimelineHarness = harness;

function FixtureHarness() {
  const [events, setEvents] = useState<TimelineEvent[]>(initialEvents);
  publishEvents = setEvents;
  useEffect(() => {
    harness.ready = true;
    document.documentElement.setAttribute('data-chat-timeline-harness', 'ready');
    return () => { publishEvents = null; };
  }, []);

  const cellStyle = windowCount === 4
    ? { height: '50vh', width: '50vw', display: 'flex', flexDirection: 'column' as const, overflow: 'hidden', boxSizing: 'border-box' as const, border: '1px solid #222' }
    : { height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column' as const, overflow: 'hidden' };

  const containerStyle = windowCount === 4
    ? { display: 'flex', flexWrap: 'wrap' as const, width: '100vw', height: '100vh' }
    : { width: '100vw', height: '100vh' };

  return (
    <div
      id="chat-timeline-fixture-harness"
      data-fixture-label={fixtureLabel}
      data-fixture-row-count={events.length}
      style={containerStyle}
    >
      {Array.from({ length: windowCount }, (_, i) => (
        <div key={i} class="chat-timeline-fixture-window" data-window-index={i} style={cellStyle}>
          <ChatView events={events} loading={false} sessionId={`fixture-window-${i}`} />
        </div>
      ))}
    </div>
  );
}

const root = document.getElementById('fixture-root');
if (!root) throw new Error('chat-timeline fixture harness: #fixture-root not found');
// Captured immediately before the first render so a cold-mount measurement
// excludes fixture generation, which is not what is being compared.
(harness as { renderStartMs: number }).renderStartMs = performance.now();
performance.mark('chat-timeline:render-start');
render(<FixtureHarness />, root);
