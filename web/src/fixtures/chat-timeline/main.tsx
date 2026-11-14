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
import { SupervisionTaskConsoleView } from '../../components/SupervisionTaskConsole.js';
import { createSupervisionTaskConsoleState, SUPERVISION_TASK_CONSOLE_PHASE, SUPERVISION_TASK_CONSOLE_SYNC_STATE } from '../../supervision-task-console-reducer.js';
import { TASK_PAIR_TIMELINE_EVENT } from '@shared/task-pair.js';
import type { SupervisionConsolePairInfo } from '@shared/supervision-task-console.js';
import { SubSessionWindow } from '../../components/SubSessionWindow.js';
import { SubSessionBar } from '../../components/SubSessionBar.js';
import { SUBSESSION_DESKTOP_LAYOUT } from '../../subsession-desktop-layout-preference.js';
import {
  getMobileKeyboardState,
  isMobileKeyboardInputTarget,
  isSubSessionBarInputTarget,
} from '../../mobile-keyboard.js';
import type { SubSession } from '../../hooks/useSubSessions.js';
import type { SessionInfo } from '../../types.js';
import { ChatLocalImagePreview } from '../../components/ChatLocalImagePreview.js';
import { SessionControls } from '../../components/SessionControls.js';
import { ChatView, __buildViewItemsForTests } from '../../components/ChatView.js';
import { WsClient, type TimelineEvent } from '../../ws-client.js';
import { bindTaskPairDecisions, receiveTaskPairDecision } from '../../task-pair-decisions.js';
import type { TaskPairDecisionRecord } from '@shared/task-pair-decision.js';
import { ingestSessionRepoContext } from '../../session-repo-context-store.js';
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
  /** Replaces the live event list (used by deterministic integration probes). */
  setEvents(events: TimelineEvent[]): void;
  /** In-memory IO boundary for the real lazy decision consumer (never a daemon). */
  setDecisionRecords(records: TaskPairDecisionRecord[]): void;
  /** Appends one new event under a fresh `eventId`. Returns that id. */
  appendEvent(options?: { type?: string; text?: string }): string;
  /**
   * Grows the trailing assistant message under its EXISTING `eventId`.
   * Returns the id and the new text length.
   */
  appendStreamingChunk(chunk?: string): { eventId: string; length: number };
  /**
   * Turns on backward pagination like the real timeline hook: each `onLoadOlder`
   * shows the loading state, then after `delayMs` prepends the next page (newest
   * page first) and clears it. `hasOlderHistory` is true while pages remain.
   */
  setOlderPages(pages: TimelineEvent[][], delayMs?: number): void;
  /** Older pages not yet prepended (a page counts as taken when its request starts). */
  olderPagesRemaining(): number;
  /** Restores the generated fixture events (new array identity). */
  reset(): void;
  /** Times `buildViewItems` over the current events. */
  measureDerivation(options?: { runs?: number; showToolCalls?: boolean }): ChatTimelineMeasurement;
}

const query = readQuery();
const { events: initialEvents, label: fixtureLabel } = resolveEvents(query);
const windowCount = query.get('windows') === '4' ? 4 : 1;
const fixturePinsEnabled = query.get('pins') === '1';
/**
 * `chrome=1` adds a stand-in for the bottom chrome the real app stacks under
 * the chat (context progress bar, agent status row, control row, composer,
 * queue chip, sub-session bar; ~300 CSS px on a phone) so layout checks can
 * measure against the elements a chat overlay must never reach.
 */
const fixtureChromeEnabled = query.get('chrome') === '1';
// Opt-in real titlebar/portal controls for responsive pair-card regression tests.
// This client is deliberately never connected; browser tests own the IO boundary.
const pairControls = query.get('pairControls') === '1';
const fixtureWs = pairControls ? new WsClient('', 'fixture-server') : undefined;
const fixtureWorkdir = pairControls && query.has('branch') ? '/scoped-fixture-project' : undefined;
if (fixtureWorkdir) for (let i = 0; i < windowCount; i++) ingestSessionRepoContext({ sessionId: `fixture-window-${i}`, projectDir: fixtureWorkdir, context: { currentBranch: query.get('branch') } });
let decisionRecords: TaskPairDecisionRecord[] = [];
if (pairControls) bindTaskPairDecisions(({ requestId }) => {
  window.dispatchEvent(new CustomEvent('fixture:decision-request'));
  setTimeout(() => receiveTaskPairDecision(requestId, { ok: true, decisions: decisionRecords, revision: 'fixture' }), 50);
});
/** Live events array. Replaced (never mutated) on every harness update. */
let currentEvents: TimelineEvent[] = initialEvents;
let publishEvents: ((next: TimelineEvent[]) => void) | null = null;
let harnessCounter = 0;

function publish(next: TimelineEvent[]): void {
  currentEvents = next;
  publishEvents?.(next);
}

/** Backward-pagination state (see `setOlderPages`). */
let olderPages: TimelineEvent[][] = [];
let olderDelayMs = 250;
let olderLoading = false;
let publishOlderState: ((state: { loading: boolean; hasMore: boolean }) => void) | null = null;
function publishOlder(): void {
  publishOlderState?.({ loading: olderLoading, hasMore: olderPages.length > 0 });
}
function loadOlderPage(): void {
  if (olderLoading || olderPages.length === 0) return;
  olderLoading = true;
  publishOlder();
  setTimeout(() => {
    const page = olderPages.shift();
    if (page) publish([...page, ...currentEvents]);
    olderLoading = false;
    publishOlder();
  }, olderDelayMs);
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
  setEvents(events) {
    publish([...events]);
  },
  setDecisionRecords(records) { decisionRecords = records; },
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
  olderPagesRemaining: () => olderPages.length,
  setOlderPages(pages, delayMs = 250) {
    olderPages = pages.map((page) => [...page]);
    olderDelayMs = delayMs;
    olderLoading = false;
    publishOlder();
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

const FIXTURE_CHROME_ROWS: ReadonlyArray<readonly [string, number]> = [
  ['progress-bar', 12], ['agent-row', 56], ['control-row', 50], ['composer', 64], ['queue-chip', 40], ['session-bar', 80],
];

function FixtureBottomChrome() {
  return (
    <div data-testid="fixture-bottom-chrome" style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column' }}>
      {FIXTURE_CHROME_ROWS.map(([name, height]) => (
        <div
          key={name}
          data-testid={`fixture-${name}`}
          style={{ height, flex: '0 0 auto', boxSizing: 'border-box', borderTop: '1px solid #334155', background: '#0f172a', color: '#94a3b8', font: '11px monospace' }}
        >{name}</div>
      ))}
    </div>
  );
}

// Opt-in production sub-window header fixture; no live socket or daemon session.
function FixtureSubWindow() {
  const [maximized, setMaximized] = useState(false);
  const sub: SubSession = { id: 'fixture-header', serverId: 'fixture-server', type: 'codex-sdk', runtimeType: 'transport', shellBin: null, cwd: null, ccSessionId: null, geminiSessionId: null, parentSession: 'fixture-brain', label: 'Fixture worker', ccPresetId: null, sessionName: 'fixture-window-0', state: 'idle', createdAt: 1700000000000, updatedAt: 1700000000000 };
  return <SubSessionWindow sub={sub} ws={null} connected={false} active serverId="fixture-server" zIndex={10}
    onDiff={() => {}} onHistory={() => {}} onMinimize={() => {}} onClose={() => {}} onRestart={() => {}} onRename={() => {}} onFocus={() => {}}
    onPin={() => {}} maximized={maximized} onToggleMaximized={() => setMaximized(value => !value)}
    getMaximizeBounds={() => ({ x: 0, y: 0, w: innerWidth, h: innerHeight })} />;
}

function useFixtureMobileKeyboardClasses(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    let inputFocused = false;
    let subCardInputFocused = false;
    let hadKeyboardOpen = false;
    const update = () => {
      const vh = vv?.height ?? window.innerHeight;
      const shrink = Math.max(0, window.innerHeight - vh);
      const state = getMobileKeyboardState(inputFocused, shrink, hadKeyboardOpen);
      hadKeyboardOpen = state.hadKeyboardOpen;
      document.documentElement.classList.toggle('kb-open', state.kbOpen);
      document.documentElement.classList.toggle('input-focused', state.hideInputUi);
      document.documentElement.classList.toggle('subcard-input-focused', state.hideInputUi && subCardInputFocused);
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el) return;
      inputFocused = isMobileKeyboardInputTarget(el);
      subCardInputFocused = isSubSessionBarInputTarget(el);
      document.documentElement.classList.toggle('input-focused', inputFocused);
      document.documentElement.classList.toggle('subcard-input-focused', inputFocused && subCardInputFocused);
    };
    const onFocusOut = () => {
      inputFocused = false;
      subCardInputFocused = false;
      hadKeyboardOpen = false;
      document.documentElement.classList.remove('input-focused', 'subcard-input-focused');
      update();
    };
    vv?.addEventListener('resize', update);
    window.addEventListener('resize', update);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      vv?.removeEventListener('resize', update);
      window.removeEventListener('resize', update);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.documentElement.classList.remove('kb-open', 'input-focused', 'subcard-input-focused');
    };
  }, []);
}

// Opt-in production SubSessionBar + SubSessionCard + SubSessionWindow IME/focus fixture.
function FixtureSubBar() {
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [focusedSubId, setFocusedSubId] = useState<string | null>(null);
  const [maximizedIds, setMaximizedIds] = useState<string[]>([]);
  const [showWindow, setShowWindow] = useState(query.get('openWindow') === '1');
  const [windowMinimizedCount, setWindowMinimizedCount] = useState(0);
  const subTransport: SubSession = { id: 'sub-tr', serverId: 'fixture-server', type: 'codex-sdk', runtimeType: 'transport', shellBin: null, cwd: null, ccSessionId: null, geminiSessionId: null, parentSession: 'fixture-brain', label: 'Card Transport', ccPresetId: null, sessionName: 'fixture-sub-tr', state: 'idle', createdAt: 1700000000000, updatedAt: 1700000000000 };
  const subShell: SubSession = { id: 'sub-sh', serverId: 'fixture-server', type: 'shell', runtimeType: 'process', shellBin: '/bin/bash', cwd: null, ccSessionId: null, geminiSessionId: null, parentSession: 'fixture-brain', label: 'Card Shell', ccPresetId: null, sessionName: 'fixture-sub-sh', state: 'idle', createdAt: 1700000000000, updatedAt: 1700000000000 };

  useFixtureMobileKeyboardClasses();

  const useFallbackInput = query.get('fallback') === '1';
  const subBarWs = useFallbackInput ? null : ({
    sendSessionCommand: () => {},
    send: () => {},
    subscribeTerminal: () => {},
    onMessage: () => () => {},
    getDaemonCapabilitySnapshot: () => null,
    onDaemonCapabilitySnapshot: () => () => {},
    fsGitStatus: () => '1',
  } as unknown as WsClient);

  const quickData = {
    data: { history: [], sessionHistory: {}, commands: [], phrases: [] },
    loaded: true,
    recordHistory: () => {},
    addCommand: () => {},
    addPhrase: () => {},
    removeCommand: () => {},
    removePhrase: () => {},
    removeHistory: () => {},
    removeSessionHistory: () => {},
    clearHistory: () => {},
    clearSessionHistory: () => {},
  };

  return (
    <div
      data-testid="fixture-subbar-host"
      data-open-ids={openIds.join(',')}
      data-focused-id={focusedSubId ?? ''}
      data-maximized-ids={maximizedIds.join(',')}
      data-window-minimized-count={String(windowMinimizedCount)}
      style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw' }}
    >
      <div style={{ flex: '1 1 auto', padding: 12 }}>
        <div
          contenteditable="true"
          role="textbox"
          class="controls-input"
          data-testid="main-composer"
          data-placeholder="Main session input"
        />
      </div>
      {showWindow && (
        <SubSessionWindow
          sub={subTransport}
          ws={subBarWs}
          connected={true}
          active
          serverId="fixture-server"
          zIndex={20}
          onDiff={() => {}}
          onHistory={() => {}}
          onMinimize={() => { setWindowMinimizedCount((c) => c + 1); setShowWindow(false); }}
          onClose={() => setShowWindow(false)}
          onRestart={() => {}}
          onRename={() => {}}
          onFocus={() => setFocusedSubId(subTransport.id)}
        />
      )}
      <SubSessionBar
        desktopLayout={SUBSESSION_DESKTOP_LAYOUT.HORIZONTAL}
        subSessions={[subTransport, subShell]}
        openIds={new Set(openIds)}
        maximizedIds={new Set(maximizedIds)}
        focusedSubId={focusedSubId}
        collapsed={false}
        desktopLayoutCapable={window.matchMedia('(pointer: fine)').matches}
        onOpen={(id) => {
          setOpenIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
          setFocusedSubId(id);
        }}
        onFocus={(id) => setFocusedSubId(id)}
        onOpenMaximized={(id) => {
          setOpenIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
          setMaximizedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
        }}
        onMaximize={(id) => setMaximizedIds((prev) => (prev.includes(id) ? prev : [...prev, id]))}
        onRestore={(id) => setMaximizedIds((prev) => prev.filter((item) => item !== id))}
        onClose={() => {}}
        onRestart={() => {}}
        ws={subBarWs}
        connected={true}
        serverId="fixture-server"
        onDiff={() => {}}
        onHistory={() => {}}
        quickData={useFallbackInput ? undefined : (quickData as any)}
      />
    </div>
  );
}

const FIXTURE_IMAGE_DATA_URL = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="220"><rect width="320" height="220" fill="#38bdf8"/></svg>');
const fixtureLoadImagePreview = async () => ({ dataUrl: FIXTURE_IMAGE_DATA_URL, alt: 'sent-photo.png' });

// Opt-in production ChatLocalImagePreview + SessionControls mobile layout-shift regression fixture.
function FixtureMobileImageTap() {
  useFixtureMobileKeyboardClasses();
  const activeSession: SessionInfo = {
    name: 'deck_fixture_main',
    project: 'fixture',
    role: 'brain',
    agentType: 'claude-code-sdk',
    state: 'idle',
    runtimeType: 'transport',
    projectDir: '/tmp/fixture',
  };
  const ws = {
    connected: true,
    send: () => {},
    sendSessionCommand: () => {},
    onMessage: () => () => {},
    subscribeTerminal: () => {},
    getDaemonCapabilitySnapshot: () => null,
    onDaemonCapabilitySnapshot: () => () => {},
    fsGitStatus: () => '1',
  } as unknown as WsClient;
  const quickData = {
    data: { history: [], sessionHistory: {}, commands: [], phrases: [] },
    loaded: true,
    recordHistory: () => {},
    addCommand: () => {},
    addPhrase: () => {},
    removeCommand: () => {},
    removePhrase: () => {},
    removeHistory: () => {},
    removeSessionHistory: () => {},
    clearHistory: () => {},
    clearSessionHistory: () => {},
  };
  return (
    <div
      data-testid="fixture-mobile-image-tap"
      style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', overflow: 'hidden', background: '#0b1220' }}
    >
      <div
        class="chat-view"
        tabIndex={-1}
        style={{ flex: '1 1 0%', minHeight: 0, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', overflowY: 'auto', padding: '0 12px' }}
      >
        <ChatLocalImagePreview
          path="/repo/sent-photo.png"
          loadImagePreview={fixtureLoadImagePreview}
        />
      </div>
      <SessionControls
        ws={ws}
        activeSession={activeSession}
        connected={true}
        quickData={quickData as any}
        sessions={[]}
        subSessions={[]}
        serverId="fixture-server"
      />
      <div class="subcard-bar" style={{ height: '64px', flexShrink: 0, background: '#111827' }}>
        subcard-bar
      </div>
      <div class="session-usage-footer" style={{ height: '28px', flexShrink: 0, background: '#0f172a' }}>
        usage-footer
      </div>
    </div>
  );
}

function FixtureHarness() {
  const [events, setEvents] = useState<TimelineEvent[]>(initialEvents);
  publishEvents = setEvents;
  const [older, setOlder] = useState({ loading: false, hasMore: false });
  publishOlderState = setOlder;
  useEffect(() => {
    harness.ready = true;
    document.documentElement.setAttribute('data-chat-timeline-harness', 'ready');
    return () => { publishEvents = null; publishOlderState = null; };
  }, []);

  if (query.get('mobileImageTap') === '1') return <FixtureMobileImageTap />;
  if (query.get('subWindow') === '1') return <FixtureSubWindow />;
  if (query.get('subBar') === '1') return <FixtureSubBar />;

  const cellStyle = windowCount === 4
    ? { height: '50vh', width: '50vw', display: 'flex', flexDirection: 'column' as const, overflow: 'hidden', boxSizing: 'border-box' as const, border: '1px solid #222' }
    : { height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column' as const, overflow: 'hidden' };

  const containerStyle = windowCount === 4
    ? { display: 'flex', flexWrap: 'wrap' as const, width: '100vw', height: '100vh' }
    : { width: '100vw', height: '100vh' };

  // Opt-in real console consumer, sharing the same synthetic event IO seam.
  // This fixture-only module is excluded from normal production builds.
  if (query.get('console') === '1') {
    const event = events.find(entry => entry.type === TASK_PAIR_TIMELINE_EVENT);
    const payload = event?.payload as (SupervisionConsolePairInfo & { taskId: string; title: string }) | undefined;
    const state = createSupervisionTaskConsoleState({ projectName: 'fixture', coordinatorSessionName: 'fixture-brain' });
    return <div style={{ display: 'flex', height: '100vh', width: '100vw' }}>
      <SupervisionTaskConsoleView mobile={window.innerWidth <= 720} width={Math.min(window.innerWidth, 720)} onClose={() => {}} onNavigateSession={session => window.dispatchEvent(new CustomEvent('deck:navigate', { detail: { session } }))}
        state={{ ...state, phase: SUPERVISION_TASK_CONSOLE_PHASE.READY, hasAuthoritativeSnapshot: true, syncState: SUPERVISION_TASK_CONSOLE_SYNC_STATE.SYNCED,
          tasks: payload ? { [payload.taskId]: { taskId: payload.taskId, title: payload.title, status: 'implementing', phase: 'active', validationState: 'pending', updatedAt: event!.ts, lastEventId: 1, pair: payload } } : {} }} />
    </div>;
  }

  return (
    <div
      id="chat-timeline-fixture-harness"
      data-fixture-label={fixtureLabel}
      data-fixture-row-count={events.length}
      style={containerStyle}
    >
      {Array.from({ length: windowCount }, (_, i) => (
        <div key={i} class="chat-timeline-fixture-window" data-window-index={i} style={cellStyle}>
          {fixtureChromeEnabled ? (
            <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <ChatView
                events={events}
                loading={false}
                loadingOlder={older.loading}
                hasOlderHistory={older.hasMore}
                onLoadOlder={loadOlderPage}
                sessionId={`fixture-window-${i}`}
                serverId={fixturePinsEnabled ? 'fixture-server' : undefined}
                messagePinsEnabled={fixturePinsEnabled}
                scopeTaskPairs={query.get('scope') === '1'}
                taskPairPanelVisitKey={query.get('visit') ?? undefined}
                ws={fixtureWs}
                workdir={fixtureWorkdir}
                onViewRepo={pairControls ? () => window.dispatchEvent(new CustomEvent('fixture:repo')) : undefined}
                onForceSync={pairControls ? () => window.dispatchEvent(new CustomEvent('fixture:sync')) : undefined}
              />
            </div>
          ) : (
            <ChatView
              events={events}
              loading={false}
              loadingOlder={older.loading}
              hasOlderHistory={older.hasMore}
              onLoadOlder={loadOlderPage}
              sessionId={`fixture-window-${i}`}
              serverId={fixturePinsEnabled ? 'fixture-server' : undefined}
              messagePinsEnabled={fixturePinsEnabled}
              scopeTaskPairs={query.get('scope') === '1'}
              taskPairPanelVisitKey={query.get('visit') ?? undefined}
              ws={fixtureWs}
              workdir={fixtureWorkdir}
              onViewRepo={pairControls ? () => window.dispatchEvent(new CustomEvent('fixture:repo')) : undefined}
              onForceSync={pairControls ? () => window.dispatchEvent(new CustomEvent('fixture:sync')) : undefined}
            />
          )}
          {fixtureChromeEnabled && <FixtureBottomChrome />}
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
