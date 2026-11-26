/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GLOBAL_TASK_MODE_MSG,
  GLOBAL_TASK_TICKET_PATH,
  GLOBAL_TASK_WS_PATH,
  type GlobalTaskServerFrame,
} from '@shared/global-task-mode.js';
import { configure as configureApi, configureApiKey, clearApiKey } from '../../src/api.js';
import { clearGlobalTaskModeSessionState, GLOBAL_TASK_MUTED_SERVERS_STORAGE_KEY } from '../../src/global-task-mode-store.js';
import en from '../../src/i18n/locales/en.json';
import es from '../../src/i18n/locales/es.json';
import ja from '../../src/i18n/locales/ja.json';
import ko from '../../src/i18n/locales/ko.json';
import ru from '../../src/i18n/locales/ru.json';
import zhCN from '../../src/i18n/locales/zh-CN.json';
import zhTW from '../../src/i18n/locales/zh-TW.json';

const voiceOverlayMock = vi.hoisted(() => ({
  renders: [] as Array<{ open: boolean; autoStartListening?: boolean; sessionLabel?: string; initialText?: string }>,
  lastOnSend: null as ((text: string) => 'accepted' | 'pending' | 'rejected') | null,
  lastOnClose: null as (() => void) | null,
}));

const i18nMock = vi.hoisted(() => ({
  language: 'en-US',
}));

vi.mock('../../src/components/VoiceOverlay.js', () => ({
  VoiceOverlay: (props: {
    open: boolean;
    autoStartListening?: boolean;
    sessionLabel?: string;
    initialText?: string;
    onSend: (text: string) => 'accepted' | 'pending' | 'rejected';
    onClose: () => void;
  }) => {
    voiceOverlayMock.renders.push({
      open: props.open,
      autoStartListening: props.autoStartListening,
      sessionLabel: props.sessionLabel,
      initialText: props.initialText,
    });
    voiceOverlayMock.lastOnSend = props.onSend;
    voiceOverlayMock.lastOnClose = props.onClose;
    if (!props.open) return null;
    return (
      <div
        data-testid="mock-voice-overlay"
        data-auto-start={String(Boolean(props.autoStartListening))}
        data-session-label={props.sessionLabel ?? ''}
        data-initial-text={props.initialText ?? ''}
      >
        <button
          type="button"
          data-testid="mock-voice-send-btn"
          onClick={() => {
            const res = props.onSend('Voice command payload');
            if (res === 'accepted') props.onClose();
          }}
        >
          Send Voice
        </button>
      </div>
    );
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: string | Record<string, unknown>) => {
      const lookup = (obj: Record<string, unknown>, path: string): string | undefined => {
        let cur: unknown = obj;
        for (const part of path.split('.')) {
          if (!cur || typeof cur !== 'object') return undefined;
          cur = (cur as Record<string, unknown>)[part];
        }
        return typeof cur === 'string' ? cur : undefined;
      };
      const dict = i18nMock.language.startsWith('zh') ? (zhCN as unknown as Record<string, unknown>) : (en as unknown as Record<string, unknown>);
      let text = lookup(dict, key) ?? (typeof opts === 'string' ? opts : undefined) ?? (typeof opts === 'object' && opts && typeof opts.defaultValue === 'string' ? opts.defaultValue : key);
      if (opts && typeof opts === 'object') {
        for (const [k, v] of Object.entries(opts)) {
          text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
        }
      }
      return text;
    },
    i18n: {
      get language() { return i18nMock.language; },
      get resolvedLanguage() { return i18nMock.language; },
    },
  }),
}));

// Preact binds lowercase pointer events only when `onpointer*` properties exist on HTMLElement.prototype.
const pointerPropNames = ['onpointerdown', 'onpointermove', 'onpointerup', 'onpointercancel'] as const;
const originalPointerDescriptors = Object.fromEntries(
  pointerPropNames.map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]),
) as Record<(typeof pointerPropNames)[number], PropertyDescriptor | undefined>;
for (const name of pointerPropNames) {
  Object.defineProperty(HTMLElement.prototype, name, {
    configurable: true,
    writable: true,
    value: null,
  });
}

function dispatchPointer(
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  init: MouseEventInit & { pointerId?: number; pointerType?: string } = {},
) {
  const evt = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }) as MouseEvent & {
    pointerId: number;
    pointerType: string;
  };
  Object.defineProperty(evt, 'pointerId', { configurable: true, value: init.pointerId ?? 1 });
  Object.defineProperty(evt, 'pointerType', { configurable: true, value: init.pointerType ?? 'touch' });
  fireEvent(target, evt);
}

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  private listeners = new Map<string, Set<(ev: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', { code: 1000 });
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.emit('open', {});
  }

  simulateMessage(frame: GlobalTaskServerFrame): void {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  private emit(type: string, ev: unknown): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }
}

class MockUtterance {
  text: string;
  lang = '';
  rate = 1;
  onend: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

describe('GlobalTaskModeView', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let spokenUtterances: MockUtterance[];
  let cancelSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.clear();
    MockWebSocket.instances = [];
    voiceOverlayMock.renders = [];
    voiceOverlayMock.lastOnSend = null;
    voiceOverlayMock.lastOnClose = null;
    i18nMock.language = 'en-US';
    spokenUtterances = [];
    cancelSpy = vi.fn();

    configureApi('http://localhost:3000');
    configureApiKey('test-key');

    fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(GLOBAL_TASK_TICKET_PATH)) {
        return new Response(JSON.stringify({ ticket: 'gt-ticket' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/session/send')) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/task-pairs/') && url.endsWith('/close')) {
        return new Response(JSON.stringify({ ok: true, taskId: 'tsk-1', status: 'cancelled', updatedAt: Date.now(), endedAt: Date.now() }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal('SpeechSynthesisUtterance', MockUtterance);
    vi.stubGlobal('speechSynthesis', {
      speak: vi.fn((u: MockUtterance) => {
        spokenUtterances.push(u);
      }),
      cancel: cancelSpy,
    });
  });

  afterEach(async () => {
    cleanup();
    clearGlobalTaskModeSessionState();
    const tts = await import('../../src/tts.js');
    await tts.__resetTtsForTests();
    clearApiKey();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    localStorage.clear();
  });

  afterAll(() => {
    for (const name of pointerPropNames) {
      const orig = originalPointerDescriptors[name];
      if (orig) {
        Object.defineProperty(HTMLElement.prototype, name, orig);
      } else {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      }
    }
  });

  async function mountWithSnapshot() {
    const { GlobalTaskModeView } = await import('../../src/components/GlobalTaskModeView.js');
    const onExit = vi.fn();
    const onJumpToSession = vi.fn();
    render(<GlobalTaskModeView onExit={onExit} onJumpToSession={onJumpToSession} />);
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.instances[0]!;
    expect(ws.url).toContain(GLOBAL_TASK_WS_PATH);

    await act(async () => {
      ws.simulateOpen();
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
        ts: 10_000,
        servers: [
          { id: 'srv-1', name: 'M3-Mac', online: true },
          { id: 'srv-2', name: 'Linux-GPU', online: true },
        ],
        brains: [
          {
            serverId: 'srv-1',
            serverName: 'M3-Mac',
            serverOnline: true,
            sessionName: 'deck_imcodes_brain',
            projectName: 'imcodes',
            label: 'IM Brain',
            state: 'idle',
            agentType: 'claude-code',
          },
          {
            serverId: 'srv-2',
            serverName: 'Linux-GPU',
            serverOnline: true,
            sessionName: 'deck_gpu_brain',
            projectName: 'trainer',
            label: 'GPU Brain',
            state: 'running',
            agentType: 'codex-sdk',
          },
        ],
        tasks: [
          {
            serverId: 'srv-1',
            serverName: 'M3-Mac',
            serverOnline: true,
            projectName: 'imcodes',
            brainSession: 'deck_imcodes_brain',
            brainLabel: 'IM Brain',
            taskId: 'tsk_pair_1',
            title: 'Build Global View',
            status: 'in_audit',
            flags: [],
            round: 2,
            checklist: { total: 5, implemented: 4, audited: 2 },
            executorLabel: 'Worker 1',
            auditorLabel: 'Auditor 1',
            liveSummary: 'Running unit tests',
            createdAt: 100,
            updatedAt: 500,
            isTerminal: false,
            needsAttention: false,
          },
          {
            serverId: 'srv-2',
            serverName: 'Linux-GPU',
            serverOnline: true,
            projectName: 'trainer',
            brainSession: 'deck_gpu_brain',
            brainLabel: 'GPU Brain',
            taskId: 'tsk_no_checklist',
            title: 'Check GPU cluster',
            status: 'awaiting_brain_decision',
            flags: ['needs_input'],
            round: 1,
            checklist: { total: 0, implemented: 0, audited: 0 },
            createdAt: 90,
            updatedAt: 400,
            isTerminal: false,
            needsAttention: true,
          },
          {
            serverId: 'srv-1',
            serverName: 'M3-Mac',
            serverOnline: true,
            projectName: 'imcodes',
            brainSession: 'deck_imcodes_brain',
            brainLabel: 'IM Brain',
            taskId: 'tsk_done_1',
            title: 'Ship WS backend',
            status: 'done',
            flags: [],
            round: 1,
            checklist: { total: 3, implemented: 3, audited: 3 },
            createdAt: Date.now() - 120_000,
            updatedAt: Date.now() - 60_000,
            isTerminal: true,
            needsAttention: false,
          },
        ],
      });
    });

    return { ws, onExit, onJumpToSession };
  }

  it('renders both implementation and audit progress simultaneously, hides 0/0 bars, supports filtering & server muting, and collapses finished tasks', async () => {
    const { ws, onJumpToSession } = await mountWithSnapshot();

    // Both Impl & Audit progress are rendered simultaneously on Pair cards
    expect(screen.getByTestId('task-mode-impl-progress-tsk_pair_1').textContent).toContain('Impl 4/5');
    expect(screen.getByTestId('task-mode-audit-progress-tsk_pair_1').textContent).toContain('Audit 2/5');
    expect(screen.queryByTestId('task-mode-progress-tsk_no_checklist')).toBeNull();

    // Expand card details & jump to original session with task context
    fireEvent.click(screen.getByTestId('task-mode-card-tsk_pair_1'));
    expect(screen.getByTestId('task-mode-details-tsk_pair_1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('task-mode-jump-tsk_pair_1'));
    expect(onJumpToSession).toHaveBeenCalledWith('srv-1', 'deck_imcodes_brain', {
      taskId: 'tsk_pair_1',
      title: 'Build Global View',
      status: 'in_audit',
    });

    // Context menu Open session also passes task context
    fireEvent.contextMenu(screen.getByTestId('task-mode-card-tsk_pair_1'), { clientX: 80, clientY: 90 });
    fireEvent.click(screen.getByTestId('task-mode-ctx-open-tsk_pair_1'));
    expect(onJumpToSession).toHaveBeenLastCalledWith('srv-1', 'deck_imcodes_brain', {
      taskId: 'tsk_pair_1',
      title: 'Build Global View',
      status: 'in_audit',
    });

    // Status filter: Attention shows only tsk_no_checklist
    fireEvent.click(screen.getByTestId('task-mode-filter-attention'));
    expect(screen.getByTestId('task-mode-card-tsk_no_checklist')).toBeTruthy();
    expect(screen.queryByTestId('task-mode-card-tsk_pair_1')).toBeNull();

    fireEvent.click(screen.getByTestId('task-mode-filter-all'));
    expect(screen.getByTestId('task-mode-card-tsk_pair_1')).toBeTruthy();

    // Collapsible recent finished
    expect(screen.getByTestId('task-mode-card-tsk_done_1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('task-mode-finished-toggle'));
    expect(screen.queryByTestId('task-mode-card-tsk_done_1')).toBeNull();
    fireEvent.click(screen.getByTestId('task-mode-finished-toggle'));
    expect(screen.getByTestId('task-mode-card-tsk_done_1')).toBeTruthy();

    // Mute srv-2 from Server Filter dropdown -> removes card & sends set_filter to WS
    fireEvent.click(screen.getByTestId('task-mode-server-filter-btn'));
    fireEvent.click(screen.getByTestId('task-mode-server-toggle-srv-2'));
    await waitFor(() => expect(screen.queryByTestId('task-mode-card-tsk_no_checklist')).toBeNull());
    expect(ws.sent.map((raw) => JSON.parse(raw))).toContainEqual({
      type: GLOBAL_TASK_MODE_MSG.SET_FILTER,
      mutedServerIds: ['srv-2'],
    });
  });

  it('supports pinning Brains, quick dispatch modal, tap reply composer with task title, and long-press VoiceOverlay reuse without scroll misfires', async () => {
    await mountWithSnapshot();

    // Unpinned snapshot sessions do NOT appear in quickbar by default; quickbar stays compact with + button
    expect(screen.getByTestId('task-mode-quickbar')).toBeTruthy();
    expect(screen.queryByTestId('task-mode-quickbar-list')).toBeNull();
    expect(screen.queryByTestId('task-mode-brain-pill-srv-1-deck_imcodes_brain')).toBeNull();

    // Open + Add / Dispatch modal: manually lists unpinned servers/brains and lets user pin IM Brain into quickbar
    fireEvent.click(screen.getByTestId('task-mode-add-brain-btn'));
    const pinToggle = screen.getByTestId('task-mode-add-pin-toggle');
    fireEvent.click(pinToggle);
    const pinBtn = screen.getByTestId('task-mode-brain-pin-srv-1-deck_imcodes_brain');
    expect(pinBtn.getAttribute('aria-pressed')).toBe('true');

    // + Add / Dispatch modal sends raw instruction (no task title prefix)
    fireEvent.input(screen.getByTestId('task-mode-add-input'), { target: { value: 'Start audit cleanup' } });
    fireEvent.click(screen.getByTestId('task-mode-add-submit-btn'));

    await waitFor(() => {
      const sendCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/api/server/srv-1/session/send'));
      expect(sendCall).toBeDefined();
      const body = JSON.parse(String((sendCall![1] as RequestInit).body));
      expect(body.sessionName).toBe('deck_imcodes_brain');
      expect(body.text).toBe('Start audit cleanup');
      expect(body.deliveryMode).toBe('append');
      expect(screen.queryByTestId('task-mode-add-modal')).toBeNull();
    });

    // Tap card Reply button -> opens compact composer and sends with task title prefix
    fireEvent.click(screen.getByTestId('task-mode-reply-tsk_pair_1'));
    const composer = screen.getByTestId('task-mode-composer');
    expect(composer.textContent).toContain('Build Global View');
    fireEvent.input(screen.getByTestId('task-mode-composer-input'), { target: { value: 'Check failing spec' } });
    fireEvent.click(screen.getByTestId('task-mode-composer-send-btn'));

    await waitFor(() => {
      const sendCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('/api/server/srv-1/session/send'));
      const lastBody = JSON.parse(String((sendCalls.at(-1)![1] as RequestInit).body));
      expect(lastBody.text).toBe('[Regarding task "Build Global View"]\nCheck failing spec');
      expect(lastBody.deliveryMode).toBe('append');
      expect(screen.queryByTestId('task-mode-composer')).toBeNull();
    });

    // Mobile scroll (>12px movement) during press cancels long press and tap
    const replyBtn = screen.getByTestId('task-mode-reply-tsk_pair_1');
    dispatchPointer(replyBtn, 'pointerdown', { clientX: 100, clientY: 100, pointerId: 2 });
    dispatchPointer(replyBtn, 'pointermove', { clientX: 100, clientY: 124, pointerId: 2 });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    dispatchPointer(replyBtn, 'pointerup', { clientX: 100, clientY: 124, pointerId: 2 });
    fireEvent.click(replyBtn);
    expect(screen.queryByTestId('mock-voice-overlay')).toBeNull();
    expect(screen.queryByTestId('task-mode-composer')).toBeNull();

    // True long press (>=260ms, no movement) opens reused VoiceOverlay with autoStartListening & sends task-prefixed message
    dispatchPointer(replyBtn, 'pointerdown', { clientX: 100, clientY: 100, pointerId: 3 });
    await act(async () => {
      vi.advanceTimersByTime(280);
    });
    const voiceEl = screen.getByTestId('mock-voice-overlay');
    expect(voiceEl.getAttribute('data-auto-start')).toBe('true');
    expect(voiceEl.getAttribute('data-session-label')).toContain('M3-Mac');
    expect(voiceEl.getAttribute('data-session-label')).toContain('Build Global View');
    fireEvent.click(screen.getByTestId('mock-voice-send-btn'));
    await waitFor(() => {
      const sendCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('/api/server/srv-1/session/send'));
      const lastBody = JSON.parse(String((sendCalls.at(-1)![1] as RequestInit).body));
      expect(lastBody.text).toBe('[Regarding task "Build Global View"]\nVoice command payload');
    });

    // Quick-dispatch Brain pill tap -> raw instruction without task prefix; voice switch keeps draft
    const brainPill = screen.getByTestId('task-mode-brain-pill-srv-1-deck_imcodes_brain');
    fireEvent.click(brainPill);
    fireEvent.input(screen.getByTestId('task-mode-composer-input'), { target: { value: 'Draft text' } });
    fireEvent.click(screen.getByTestId('task-mode-composer-voice-btn'));
    const switchedVoice = screen.getByTestId('mock-voice-overlay');
    expect(switchedVoice.getAttribute('data-initial-text')).toBe('Draft text');
    fireEvent.click(screen.getByTestId('mock-voice-send-btn'));
    await waitFor(() => {
      const sendCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('/api/server/srv-1/session/send'));
      const lastBody = JSON.parse(String((sendCalls.at(-1)![1] as RequestInit).body));
      expect(lastBody.text).toBe('Voice command payload');
    });
  });

  it('auto-reads new Brain text & status transitions in order, deduplicates, ignores muted servers & historical snapshots, and stops task-mode TTS on exit without clearing global preference', async () => {
    const { setTtsAutoReadEnabled, getTtsAutoReadEnabled } = await import('../../src/tts.js');
    setTtsAutoReadEnabled(true);

    const { ws } = await mountWithSnapshot();

    // Initial snapshot must NEVER trigger TTS playback
    expect(spokenUtterances).toHaveLength(0);

    // Open & verify reused TtsQuickSettingsPopover
    fireEvent.click(screen.getByTestId('task-mode-tts-settings-btn'));
    expect(screen.getByTestId('chat-tts-settings-popover')).toBeTruthy();

    // Mute srv-2 first
    fireEvent.click(screen.getByTestId('task-mode-server-filter-btn'));
    fireEvent.click(screen.getByTestId('task-mode-server-toggle-srv-2'));

    // New Brain text from unmuted srv-1 -> rendered + queued TTS with server prefix; duplicate eventId ignored
    const liveTs = Date.now();
    await act(async () => {
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.BRAIN_TEXT,
        event: {
          serverId: 'srv-1',
          serverName: 'M3-Mac',
          sessionName: 'deck_imcodes_brain',
          projectName: 'imcodes',
          eventId: 'evt-brain-1',
          text: 'All unit tests passed.',
          ts: liveTs,
        },
      });
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.BRAIN_TEXT,
        event: {
          serverId: 'srv-1',
          serverName: 'M3-Mac',
          sessionName: 'deck_imcodes_brain',
          projectName: 'imcodes',
          eventId: 'evt-brain-1',
          text: 'All unit tests passed.',
          ts: liveTs,
        },
      });
      // Muted server Brain text must not speak
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.BRAIN_TEXT,
        event: {
          serverId: 'srv-2',
          serverName: 'Linux-GPU',
          sessionName: 'deck_gpu_brain',
          projectName: 'trainer',
          eventId: 'evt-muted-1',
          text: 'Should stay silent.',
          ts: liveTs + 100,
        },
      });
    });

    expect(screen.getByTestId('task-mode-brain-preview-tsk_pair_1').textContent).toContain('All unit tests passed.');
    expect(spokenUtterances).toHaveLength(1);
    expect(spokenUtterances[0]!.text).toContain('M3-Mac');
    expect(spokenUtterances[0]!.text).toContain('All unit tests passed.');

    // Finish first utterance, verify live UPSERT status announcement speaks
    await act(async () => {
      spokenUtterances[0]!.onend?.();
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.UPSERT,
        task: {
          serverId: 'srv-1',
          serverName: 'M3-Mac',
          serverOnline: true,
          projectName: 'imcodes',
          brainSession: 'deck_imcodes_brain',
          brainLabel: 'IM Brain',
          taskId: 'tsk_pair_1',
          title: 'Build Global View',
          status: 'passed',
          flags: [],
          round: 2,
          checklist: { total: 5, implemented: 5, audited: 5 },
          createdAt: 100,
          updatedAt: liveTs + 200,
          isTerminal: false,
          needsAttention: false,
        },
      });
    });

    expect(spokenUtterances).toHaveLength(2);
    expect(spokenUtterances[1]!.text).toContain('Build Global View');

    // Voice capture suppression blocks new Brain auto-read playback without retry spin loops; releasing restores auto-read.
    const { setTtsVoiceCaptureActive } = await import('../../src/tts.js');
    await act(async () => { spokenUtterances[1]!.onend?.(); });
    setTtsVoiceCaptureActive(true);
    await act(async () => {
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.BRAIN_TEXT,
        event: {
          serverId: 'srv-1',
          serverName: 'M3-Mac',
          sessionName: 'deck_imcodes_brain',
          projectName: 'imcodes',
          eventId: 'evt-brain-suppressed',
          text: 'Must stay silent during dictation.',
          ts: liveTs + 300,
        },
      });
    });
    expect(spokenUtterances).toHaveLength(2);
    setTtsVoiceCaptureActive(false);
    await act(async () => {
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.BRAIN_TEXT,
        event: {
          serverId: 'srv-1',
          serverName: 'M3-Mac',
          sessionName: 'deck_imcodes_brain',
          projectName: 'imcodes',
          eventId: 'evt-brain-resumed',
          text: 'Resumed after voice stop.',
          ts: liveTs + 400,
        },
      });
    });
    expect(spokenUtterances).toHaveLength(3);
    expect(spokenUtterances[2]!.text).toContain('Resumed after voice stop.');

    // Manual speak button stops/reads on click
    fireEvent.click(screen.getByTestId('task-mode-speak-tsk_pair_1'));
    expect(spokenUtterances.length).toBeGreaterThanOrEqual(4);

    // Unmount leaves global ttsAutoRead enabled while stopping active task-mode playback
    cancelSpy.mockClear();
    cleanup();
    expect(cancelSpy).toHaveBeenCalled();
    expect(getTtsAutoReadEnabled()).toBe(true);
  });

  it('keeps taskMode i18n keys aligned across all 7 locales with no English fallback on titles', () => {
    const locales = { en, es, ja, ko, ru, 'zh-CN': zhCN, 'zh-TW': zhTW } as const;
    const expectedKeys = Object.keys(en.taskMode).sort();
    for (const [locale, messages] of Object.entries(locales)) {
      const keys = Object.keys(messages.taskMode).sort();
      expect(keys, locale).toEqual(expectedKeys);
      for (const k of expectedKeys) {
        expect((messages.taskMode as Record<string, string>)[k]?.trim().length, `${locale}.${k}`).toBeGreaterThan(0);
      }
      if (locale !== 'en') {
        expect(messages.taskMode.title, locale).not.toBe(en.taskMode.title);
      }
    }
  });

  it('renders a scrollable 2/3-column grid server filter menu for 24+ servers with truncation, click-outside containment, and empty state', async () => {
    const servers = Array.from({ length: 24 }, (_, idx) => ({
      id: `srv-${idx + 1}`,
      name: idx === 0 ? '1d5c5b1f8ce8-very-long-server-name' : `Node-${idx + 1}`,
      online: idx % 2 === 0,
    }));

    const { ws } = await mountWithSnapshot();

    await act(async () => {
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
        ts: 11_000,
        servers,
        brains: [],
        tasks: [],
        mutedServerIds: [],
      });
    });

    const filterBtn = screen.getByTestId('task-mode-server-filter-btn');
    expect(filterBtn.textContent).toContain('24/24');
    fireEvent.click(filterBtn);

    const menu = screen.getByTestId('task-mode-server-filter-menu');
    const list = screen.getByTestId('task-mode-server-filter-list');
    expect(menu.contains(list)).toBe(true);
    expect(list.querySelectorAll('.global-task-server-filter-item')).toHaveLength(24);
    const longNameEl = list.querySelector('.global-task-server-filter-name');
    expect(longNameEl?.getAttribute('title')).toBe('1d5c5b1f8ce8-very-long-server-name');

    // Clicking inside scrollable list does NOT trigger click-outside close
    fireEvent.pointerDown(list);
    expect(screen.queryByTestId('task-mode-server-filter-menu')).not.toBeNull();

    // Toggling the 24th server updates active count & stays open
    fireEvent.click(screen.getByTestId('task-mode-server-toggle-srv-24'));
    expect(filterBtn.textContent).toContain('23/24');
    expect(ws.sent.map((raw) => JSON.parse(raw))).toContainEqual({
      type: GLOBAL_TASK_MODE_MSG.SET_FILTER,
      mutedServerIds: ['srv-24'],
    });
    expect(screen.queryByTestId('task-mode-server-filter-menu')).not.toBeNull();

    // Pointer down outside closes the menu
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('task-mode-server-filter-menu')).toBeNull();

    // Empty server list renders empty placeholder without list grid collapse
    await act(async () => {
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
        ts: 12_000,
        servers: [],
        brains: [],
        tasks: [],
        mutedServerIds: [],
      });
    });
    fireEvent.click(filterBtn);
    expect(screen.getByTestId('task-mode-server-filter-menu').textContent).toContain('No servers');
    expect(screen.queryByTestId('task-mode-server-filter-list')).toBeNull();

    // CSS contract: scrollable list with touch containment, 3-col desktop / 2-col mobile grid, ellipsis truncation
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve(process.cwd().endsWith('/web') ? process.cwd() : resolve(process.cwd(), 'web'), 'src/styles.css'), 'utf8');
    expect(css).toMatch(/\.global-task-server-filter-menu\s*\{[^}]*max-height:[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.global-task-server-filter-list\s*\{[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;[^}]*touch-action:\s*pan-y;[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*640px\)\s*\{[^}]*\.global-task-server-filter-menu\s*\{[^}]*position:\s*fixed;[^}]*left:\s*10px;[^}]*right:\s*10px;[^}]*\}\s*\.global-task-server-filter-list\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s);
    expect(css).toMatch(/\.global-task-server-filter-name\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
  });

  it('prevents body horizontal scroll, packs mobile topbar into 2 rows with dot-only sync indicator, and renders compact 2-row quick-dispatch grid with + button', async () => {
    const brains = Array.from({ length: 6 }, (_, idx) => ({
      serverId: `srv-${idx + 1}`,
      serverName: idx === 0 ? 'very-long-production-cluster-host-01' : `Server-${idx + 1}`,
      serverOnline: idx % 2 === 0,
      sessionName: `deck_brain_${idx + 1}`,
      label: `Brain-${idx + 1}`,
      projectName: `proj-${idx + 1}`,
      state: 'idle',
      agentType: 'claude-code',
    }));

    const { GlobalTaskModeView } = await import('../../src/components/GlobalTaskModeView.js');
    render(
      <GlobalTaskModeView
        onExit={vi.fn()}
        onJumpToSession={vi.fn()}
        pinnedSessionNames={new Set(brains.map((b) => b.sessionName))}
      />,
    );
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.instances[0]!;
    await act(async () => {
      ws.simulateOpen();
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
        ts: 15_000,
        servers: brains.map((b) => ({ id: b.serverId, name: b.serverName, online: b.serverOnline })),
        brains,
        tasks: [],
        mutedServerIds: [],
      });
    });

    // Topbar sync badge exposes title & aria-label for dot-only mobile mode and separate label span
    const syncBadge = screen.getByTestId('task-mode-sync-badge');
    expect(syncBadge.getAttribute('aria-label')).toBeTruthy();
    expect(syncBadge.getAttribute('title')).toBeTruthy();
    expect(syncBadge.querySelector('.global-task-mode-sync-label')).not.toBeNull();

    // Quick-dispatch compact + button + 2-row pill grid with title/ellipsis
    const addBtn = screen.getByTestId('task-mode-add-brain-btn');
    expect(addBtn.textContent).toBe('+');
    expect(addBtn.getAttribute('aria-label')).toBeTruthy();
    const quickList = screen.getByTestId('task-mode-quickbar-list');
    expect(quickList.querySelectorAll('.global-task-brain-pill')).toHaveLength(6);
    const firstPillText = quickList.querySelector('.global-task-brain-pill-text');
    expect(firstPillText?.getAttribute('title')).toContain('very-long-production-cluster-host-01');

    // Pin button inside grid pill still stops propagation without opening composer
    fireEvent.click(screen.getByTestId('task-mode-brain-pin-srv-1-deck_brain_1'));
    expect(screen.queryByTestId('task-mode-composer')).toBeNull();
    expect(screen.getByTestId('task-mode-brain-pin-srv-1-deck_brain_1').getAttribute('aria-pressed')).toBe('true');

    // Verify CSS contracts for horizontal overflow prevention, 2-row mobile topbar, and 2-row quickbar grid
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve(process.cwd().endsWith('/web') ? process.cwd() : resolve(process.cwd(), 'web'), 'src/styles.css'), 'utf8');
    expect(css).toMatch(/\.global-task-mode-body\s*\{[^}]*overflow-x:\s*hidden;[^}]*overscroll-behavior-x:\s*none;/s);
    expect(css).toMatch(/\.global-task-card-title\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
    expect(css).toMatch(/\.global-task-quickbar-list\s*\{[^}]*max-height:\s*58px;[^}]*overflow-y:\s*auto;[^}]*overflow-x:\s*hidden;/s);
    expect(css).toMatch(/\.global-task-brain-pill-text\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
    const mobileBlock = css.slice(css.lastIndexOf('@media (max-width: 720px)'));
    expect(mobileBlock).toMatch(/\.global-task-mode-topbar-left\s*\{\s*display:\s*contents;/);
    expect(mobileBlock).toMatch(/\.global-task-mode-sync-label\s*\{\s*display:\s*none;/);
    expect(mobileBlock).toMatch(/\.global-task-mode-topbar-right\s*\{[^}]*flex-wrap:\s*nowrap;/s);
    expect(mobileBlock).toMatch(/\.global-task-quickbar-list\s*\{\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/);
  });

  it('orders quick-dispatch pills, server filter list, and add-modal server select by workspace pinned server + pinned session priorities', async () => {
    // Explicit all-servers filter so both pinned and unpinned servers participate in priority sorting.
    localStorage.setItem(GLOBAL_TASK_MUTED_SERVERS_STORAGE_KEY, '[]');
    const { GlobalTaskModeView } = await import('../../src/components/GlobalTaskModeView.js');
    render(
      <GlobalTaskModeView
        onExit={vi.fn()}
        onJumpToSession={vi.fn()}
        pinnedServerIds={new Set(['srv-pin'])}
        pinnedSessionNames={new Set(['sess_pin'])}
        serverOrder={['srv-pin', 'srv-plain-2', 'srv-plain-1']}
        tabOrder={['sess_pin', 'sess_plain']}
      />,
    );

    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.instances[0]!;

    await act(async () => {
      ws.simulateOpen();
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
        ts: 20_000,
        servers: [
          { id: 'srv-plain-1', name: 'Plain-1', online: true },
          { id: 'srv-plain-2', name: 'Plain-2', online: true },
          { id: 'srv-pin', name: 'Pinned-Srv', online: false },
        ],
        brains: [
          {
            serverId: 'srv-plain-1',
            serverName: 'Plain-1',
            serverOnline: true,
            sessionName: 'sess_plain',
            projectName: 'p3',
            label: 'Tier3-Plain',
            state: 'idle',
            agentType: 'claude-code',
          },
          {
            serverId: 'srv-pin',
            serverName: 'Pinned-Srv',
            serverOnline: false,
            sessionName: 'sess_plain_on_pin',
            projectName: 'p2',
            label: 'Tier2-PinSrvOnly',
            state: 'idle',
            agentType: 'claude-code',
          },
          {
            serverId: 'srv-plain-2',
            serverName: 'Plain-2',
            serverOnline: true,
            sessionName: 'sess_pin',
            projectName: 'p1',
            label: 'Tier1-PinSessOnly',
            state: 'idle',
            agentType: 'claude-code',
          },
          {
            serverId: 'srv-pin',
            serverName: 'Pinned-Srv',
            serverOnline: false,
            sessionName: 'sess_pin',
            projectName: 'p0',
            label: 'Tier0-BothPinned',
            state: 'idle',
            agentType: 'claude-code',
          },
        ],
        tasks: [],
        mutedServerIds: [],
      });
    });

    const pills = Array.from(
      screen.getByTestId('task-mode-quickbar-list').querySelectorAll('.global-task-brain-pill'),
    ).map((el) => el.getAttribute('data-testid'));
    expect(pills).toEqual([
      'task-mode-brain-pill-srv-pin-sess_pin',
      'task-mode-brain-pill-srv-plain-2-sess_pin',
    ]);
    expect(screen.queryByTestId('task-mode-brain-pill-srv-pin-sess_plain_on_pin')).toBeNull();
    expect(screen.queryByTestId('task-mode-brain-pill-srv-plain-1-sess_plain')).toBeNull();

    // Server filter menu puts pinned server first, followed by unpinned servers in serverOrder
    fireEvent.click(screen.getByTestId('task-mode-server-filter-btn'));
    const filterOrder = Array.from(
      screen.getByTestId('task-mode-server-filter-list').querySelectorAll('input[type="checkbox"]'),
    ).map((el) => el.getAttribute('data-testid'));
    expect(filterOrder).toEqual([
      'task-mode-server-toggle-srv-pin',
      'task-mode-server-toggle-srv-plain-2',
      'task-mode-server-toggle-srv-plain-1',
    ]);

    // Add-modal server select also lists pinned server first and selects it by default, while allowing manual selection of unpinned servers/sessions
    fireEvent.click(screen.getByTestId('task-mode-add-brain-btn'));
    const selectEl = screen.getByTestId('task-mode-add-server-select') as HTMLSelectElement;
    expect(Array.from(selectEl.options).map((o) => o.value)).toEqual([
      'srv-pin',
      'srv-plain-2',
      'srv-plain-1',
    ]);
    expect(selectEl.value).toBe('srv-pin');
    const brainSelectEl = screen.getByTestId('task-mode-add-brain-select') as HTMLSelectElement;
    expect(Array.from(brainSelectEl.options).map((o) => o.value)).toEqual(['sess_plain_on_pin', 'sess_pin']);
    await act(async () => {
      selectEl.value = 'srv-plain-1';
      selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(() => {
      const updatedBrainSelect = screen.getByTestId('task-mode-add-brain-select') as HTMLSelectElement;
      expect(Array.from(updatedBrainSelect.options).map((o) => o.value)).toEqual(['sess_plain']);
    });
  });

  it('suppresses TTS for stale tasks, pre-mount backfill, out-of-order frames, unmuted server reveals, and stale brain_text while keeping UI updates, manual speak, clock skew tolerance, and live announcements working', async () => {
    const { setTtsAutoReadEnabled } = await import('../../src/tts.js');
    const {
      GLOBAL_TASK_TTS_CLOCK_SKEW_MS,
      GLOBAL_TASK_TTS_MAX_AGE_MS,
      shouldAutoSpeakBrainText,
      shouldAutoSpeakTaskUpdate,
    } = await import('../../src/components/GlobalTaskModeView.js');
    setTtsAutoReadEnabled(true);

    const mountAt = Date.now();
    const { ws } = await mountWithSnapshot();
    expect(spokenUtterances).toHaveLength(0);

    // Pure boundary checks: 30s clock skew + future-skewed timestamps allowed; >2m or pre-mount rejected
    expect(shouldAutoSpeakBrainText({
      eventTs: mountAt - 20_000,
      now: mountAt,
      mountAt,
    })).toBe(true);
    expect(shouldAutoSpeakBrainText({
      eventTs: mountAt + 5_000,
      now: mountAt,
      mountAt,
    })).toBe(true);
    expect(shouldAutoSpeakBrainText({
      eventTs: mountAt - GLOBAL_TASK_TTS_CLOCK_SKEW_MS - 1_000,
      now: mountAt,
      mountAt,
    })).toBe(false);
    expect(shouldAutoSpeakBrainText({
      eventTs: mountAt - GLOBAL_TASK_TTS_MAX_AGE_MS - 1_000,
      now: mountAt,
      mountAt,
    })).toBe(false);

    expect(shouldAutoSpeakTaskUpdate({
      row: {
        serverId: 'srv-1',
        serverName: 'M3-Mac',
        serverOnline: true,
        projectName: 'imcodes',
        brainSession: 'deck_imcodes_brain',
        brainLabel: 'IM Brain',
        taskId: 'tsk_skew',
        title: 'Clock skew live task',
        status: 'working',
        flags: [],
        round: 1,
        checklist: { total: 0, implemented: 0, audited: 0 },
        createdAt: mountAt - 10_000,
        updatedAt: mountAt - 10_000,
        isTerminal: false,
        needsAttention: false,
      },
      prev: undefined,
      now: mountAt,
      mountAt,
    })).toBe(true);

    // Counterexample 1: !prev historical UPSERT (2 hours old) -> NO TTS, but card still renders in UI
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    await act(async () => {
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.UPSERT,
        task: {
          serverId: 'srv-1',
          serverName: 'M3-Mac',
          serverOnline: true,
          projectName: 'imcodes',
          brainSession: 'deck_imcodes_brain',
          brainLabel: 'IM Brain',
          taskId: 'tsk_old_hist',
          title: 'Old historical done task',
          status: 'done',
          flags: [],
          round: 1,
          checklist: { total: 2, implemented: 2, audited: 2 },
          createdAt: twoHoursAgo - 60_000,
          updatedAt: twoHoursAgo,
          isTerminal: true,
          needsAttention: false,
        },
      });
    });
    expect(screen.getByTestId('task-mode-card-tsk_old_hist')).toBeTruthy();
    expect(spokenUtterances).toHaveLength(0);

    // Counterexample 2: existing task transitioning status with stale updatedAt (10 minutes ago) -> NO TTS
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    await act(async () => {
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.UPSERT,
        task: {
          serverId: 'srv-1',
          serverName: 'M3-Mac',
          serverOnline: true,
          projectName: 'imcodes',
          brainSession: 'deck_imcodes_brain',
          brainLabel: 'IM Brain',
          taskId: 'tsk_pair_1',
          title: 'Build Global View',
          status: 'done',
          flags: [],
          round: 2,
          checklist: { total: 5, implemented: 5, audited: 5 },
          createdAt: 100,
          updatedAt: tenMinAgo,
          isTerminal: true,
          needsAttention: false,
        },
      });
    });
    expect(spokenUtterances).toHaveLength(0);

    // Out-of-order stale frame whose updatedAt < prev.updatedAt MUST NOT speak even if within 2m
    const nowLive = Date.now();
    await act(async () => {
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.UPSERT,
        task: {
          serverId: 'srv-1',
          serverName: 'M3-Mac',
          serverOnline: true,
          projectName: 'imcodes',
          brainSession: 'deck_imcodes_brain',
          brainLabel: 'IM Brain',
          taskId: 'tsk_live_monotonic',
          title: 'Live monotonic task',
          status: 'passed',
          flags: [],
          round: 1,
          checklist: { total: 1, implemented: 1, audited: 1 },
          createdAt: nowLive,
          updatedAt: nowLive,
          isTerminal: false,
          needsAttention: false,
        },
      });
    });
    expect(spokenUtterances).toHaveLength(1);
    await act(async () => {
      spokenUtterances[0]!.onend?.();
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.UPSERT,
        task: {
          serverId: 'srv-1',
          serverName: 'M3-Mac',
          serverOnline: true,
          projectName: 'imcodes',
          brainSession: 'deck_imcodes_brain',
          brainLabel: 'IM Brain',
          taskId: 'tsk_live_monotonic',
          title: 'Live monotonic task',
          status: 'working',
          flags: [],
          round: 1,
          checklist: { total: 1, implemented: 0, audited: 0 },
          createdAt: nowLive - 5_000,
          updatedAt: nowLive - 5_000,
          isTerminal: false,
          needsAttention: false,
        },
      });
    });
    expect(spokenUtterances).toHaveLength(1);

    // Counterexample 3: mute srv-2 then unmute srv-2 -> revealed tasks (even with snapshot or fresh updatedAt) DO NOT speak
    fireEvent.click(screen.getByTestId('task-mode-server-filter-btn'));
    fireEvent.click(screen.getByTestId('task-mode-server-toggle-srv-2'));
    await waitFor(() => expect(screen.queryByTestId('task-mode-card-tsk_no_checklist')).toBeNull());
    fireEvent.click(screen.getByTestId('task-mode-server-toggle-srv-2'));
    await act(async () => {
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
        ts: Date.now(),
        servers: [
          { id: 'srv-1', name: 'M3-Mac', online: true },
          { id: 'srv-2', name: 'Linux-GPU', online: true },
        ],
        brains: [],
        tasks: [
          {
            serverId: 'srv-1',
            serverName: 'M3-Mac',
            serverOnline: true,
            projectName: 'imcodes',
            brainSession: 'deck_imcodes_brain',
            brainLabel: 'IM Brain',
            taskId: 'tsk_old_hist',
            title: 'Old historical done task',
            status: 'done',
            flags: [],
            round: 1,
            checklist: { total: 2, implemented: 2, audited: 2 },
            createdAt: twoHoursAgo - 60_000,
            updatedAt: twoHoursAgo,
            isTerminal: true,
            needsAttention: false,
          },
          {
            serverId: 'srv-2',
            serverName: 'Linux-GPU',
            serverOnline: true,
            projectName: 'trainer',
            brainSession: 'deck_gpu_brain',
            brainLabel: 'GPU Brain',
            taskId: 'tsk_no_checklist',
            title: 'Check GPU cluster',
            status: 'awaiting_brain_decision',
            flags: ['needs_input'],
            round: 1,
            checklist: { total: 0, implemented: 0, audited: 0 },
            createdAt: nowLive,
            updatedAt: nowLive,
            isTerminal: false,
            needsAttention: true,
          },
        ],
      });
    });
    expect(screen.getByTestId('task-mode-card-tsk_no_checklist')).toBeTruthy();
    expect(spokenUtterances).toHaveLength(1);

    // Counterexample 4: stale BRAIN_TEXT (10 minutes ago) & pre-mount backfill (45s before mount) -> NO auto TTS,
    // while manual speak button still reads the card aloud regardless of age.
    await act(async () => {
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.BRAIN_TEXT,
        event: {
          serverId: 'srv-1',
          serverName: 'M3-Mac',
          sessionName: 'deck_imcodes_brain',
          projectName: 'imcodes',
          eventId: 'evt-brain-old',
          text: 'Historical reply from 10 minutes ago.',
          ts: tenMinAgo,
        },
      });
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.BRAIN_TEXT,
        event: {
          serverId: 'srv-1',
          serverName: 'M3-Mac',
          sessionName: 'deck_imcodes_brain',
          projectName: 'imcodes',
          eventId: 'evt-brain-premount',
          text: 'Pre-mount reply.',
          ts: mountAt - GLOBAL_TASK_TTS_CLOCK_SKEW_MS - 15_000,
        },
      });
    });
    expect(spokenUtterances).toHaveLength(1);
    fireEvent.click(screen.getByTestId('task-mode-speak-tsk_old_hist'));
    expect(spokenUtterances).toHaveLength(2);

    // Positive case: fresh live BRAIN_TEXT + fresh live transition both speak
    const freshNow = Date.now();
    await act(async () => {
      spokenUtterances[1]!.onend?.();
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.BRAIN_TEXT,
        event: {
          serverId: 'srv-1',
          serverName: 'M3-Mac',
          sessionName: 'deck_imcodes_brain',
          projectName: 'imcodes',
          eventId: 'evt-brain-live',
          text: 'Fresh live reply.',
          ts: freshNow,
        },
      });
    });
    expect(spokenUtterances).toHaveLength(3);
    expect(spokenUtterances[2]!.text).toContain('Fresh live reply.');
  });

  it('renders status filter pills and server filter button as icon + count only with localized title/aria-label and clean edge counts', async () => {
    const { ws } = await mountWithSnapshot();

    // Verify 0/0 server boundary and zero task counts first
    await act(async () => {
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
        ts: 12_000,
        servers: [],
        brains: [],
        tasks: [],
        mutedServerIds: [],
      });
    });

    const serverBtnEmpty = screen.getByTestId('task-mode-server-filter-btn');
    expect(serverBtnEmpty.querySelector('svg')).not.toBeNull();
    expect(serverBtnEmpty.textContent?.trim()).toBe('0/0');
    expect(serverBtnEmpty.getAttribute('title')).toBeTruthy();
    expect(serverBtnEmpty.getAttribute('aria-label')).toBe(serverBtnEmpty.getAttribute('title'));

    // Emit snapshot with tasks across all statuses + 24 servers (12 muted -> 12/24)
    const servers = Array.from({ length: 24 }, (_, idx) => ({
      id: `srv-${idx + 1}`,
      name: `Node-${idx + 1}`,
      online: true,
    }));
    await act(async () => {
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
        ts: 13_000,
        servers,
        brains: [],
        tasks: [
          { serverId: 'srv-1', serverName: 'Node-1', serverOnline: true, projectName: 'p', brainSession: 'b1', brainLabel: 'B1', taskId: 't-att', title: 'Needs Decision', status: 'awaiting_brain_decision', flags: [], round: 1, checklist: { total: 1, implemented: 0, audited: 0 }, createdAt: 1, updatedAt: 100, isTerminal: false, needsAttention: true },
          { serverId: 'srv-1', serverName: 'Node-1', serverOnline: true, projectName: 'p', brainSession: 'b1', brainLabel: 'B1', taskId: 't-work', title: 'Active Work', status: 'working', flags: [], round: 1, checklist: { total: 1, implemented: 0, audited: 0 }, createdAt: 2, updatedAt: 200, isTerminal: false, needsAttention: false },
          { serverId: 'srv-1', serverName: 'Node-1', serverOnline: true, projectName: 'p', brainSession: 'b1', brainLabel: 'B1', taskId: 't-audit', title: 'In Audit', status: 'in_audit', flags: [], round: 1, checklist: { total: 1, implemented: 1, audited: 0 }, createdAt: 3, updatedAt: 300, isTerminal: false, needsAttention: false },
          { serverId: 'srv-1', serverName: 'Node-1', serverOnline: true, projectName: 'p', brainSession: 'b1', brainLabel: 'B1', taskId: 't-done', title: 'Finished', status: 'done', flags: [], round: 1, checklist: { total: 1, implemented: 1, audited: 1 }, createdAt: Date.now() - 120_000, updatedAt: Date.now() - 60_000, isTerminal: true, needsAttention: false },
        ],
      });
    });

    const expectedChips: Array<{ id: string; count: string; label: string }> = [
      { id: 'all', count: '4', label: 'All' },
      { id: 'attention', count: '1', label: 'Attention' },
      { id: 'working', count: '1', label: 'Working' },
      { id: 'audit', count: '1', label: 'Audit' },
      { id: 'done', count: '1', label: 'Done' },
    ];
    for (const chip of expectedChips) {
      const btn = screen.getByTestId(`task-mode-filter-${chip.id}`);
      expect(btn.querySelector('svg')).not.toBeNull();
      expect(btn.textContent?.trim()).toBe(chip.count);
      expect(btn.getAttribute('title')).toContain(`(${chip.count})`);
      expect(btn.getAttribute('aria-label')).toBe(btn.getAttribute('title'));
      expect(btn.getAttribute('data-filter')).toBe(chip.id);
    }

    const serverBtn = screen.getByTestId('task-mode-server-filter-btn');
    expect(serverBtn.querySelector('svg')).not.toBeNull();
    expect(serverBtn.textContent?.trim()).toBe('24/24');
    expect(serverBtn.getAttribute('title')).toBeTruthy();
    expect(serverBtn.getAttribute('aria-label')).toBe(serverBtn.getAttribute('title'));

    // Clicking icon-only filter & server filter buttons still works identically
    fireEvent.click(screen.getByTestId('task-mode-filter-audit'));
    expect(screen.getByTestId('task-mode-filter-audit').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('task-mode-card-t-audit')).not.toBeNull();
    expect(screen.queryByTestId('task-mode-card-t-work')).toBeNull();

    fireEvent.click(serverBtn);
    expect(serverBtn.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('task-mode-server-filter-menu')).toBeTruthy();

    for (let i = 13; i <= 24; i += 1) {
      fireEvent.click(screen.getByTestId(`task-mode-server-toggle-srv-${i}`));
    }
    expect(serverBtn.textContent?.trim()).toBe('12/24');
  });

  it('defaults server filter to workspace-pinned servers, syncs SET_FILTER without spurious TTS, falls back when none match, and preserves explicit user toggles', async () => {
    const { setTtsAutoReadEnabled } = await import('../../src/tts.js');
    setTtsAutoReadEnabled(true);

    const { GlobalTaskModeView } = await import('../../src/components/GlobalTaskModeView.js');
    const pinnedSet = new Set(['srv-pin']);
    const { rerender } = render(
      <GlobalTaskModeView
        onExit={vi.fn()}
        onJumpToSession={vi.fn()}
        pinnedServerIds={pinnedSet}
      />,
    );

    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.instances[0]!;
    const nowLive = Date.now();

    await act(async () => {
      ws.simulateOpen();
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
        ts: nowLive,
        servers: [
          { id: 'srv-pin', name: 'Pinned-Srv', online: true },
          { id: 'srv-unpin', name: 'Unpinned-Srv', online: true },
        ],
        brains: [
          {
            serverId: 'srv-pin',
            serverName: 'Pinned-Srv',
            serverOnline: true,
            sessionName: 'brain_pin',
            projectName: 'p1',
            label: 'PinnedBrain',
            state: 'idle',
            agentType: 'claude-code',
          },
          {
            serverId: 'srv-unpin',
            serverName: 'Unpinned-Srv',
            serverOnline: true,
            sessionName: 'brain_unpin',
            projectName: 'p2',
            label: 'UnpinnedBrain',
            state: 'idle',
            agentType: 'claude-code',
          },
        ],
        tasks: [
          {
            serverId: 'srv-pin',
            serverName: 'Pinned-Srv',
            serverOnline: true,
            projectName: 'p1',
            brainSession: 'brain_pin',
            brainLabel: 'PinnedBrain',
            taskId: 'tsk_pin_1',
            title: 'Pinned task',
            status: 'working',
            flags: [],
            round: 1,
            checklist: { total: 1, implemented: 0, audited: 0 },
            createdAt: nowLive - 1000,
            updatedAt: nowLive,
            isTerminal: false,
            needsAttention: false,
          },
          {
            serverId: 'srv-unpin',
            serverName: 'Unpinned-Srv',
            serverOnline: true,
            projectName: 'p2',
            brainSession: 'brain_unpin',
            brainLabel: 'UnpinnedBrain',
            taskId: 'tsk_unpin_1',
            title: 'Unpinned task',
            status: 'working',
            flags: [],
            round: 1,
            checklist: { total: 1, implemented: 0, audited: 0 },
            createdAt: nowLive - 1000,
            updatedAt: nowLive,
            isTerminal: false,
            needsAttention: false,
          },
        ],
      });
    });

    // Only pinned server is checked and visible; SET_FILTER synced over WS; no localStorage write; no spurious TTS
    expect(screen.queryByTestId('task-mode-card-tsk_pin_1')).not.toBeNull();
    expect(screen.queryByTestId('task-mode-card-tsk_unpin_1')).toBeNull();
    expect(localStorage.getItem(GLOBAL_TASK_MUTED_SERVERS_STORAGE_KEY)).toBeNull();
    expect(spokenUtterances).toHaveLength(0);
    expect(ws.sent.map((s) => JSON.parse(s))).toEqual([
      { type: GLOBAL_TASK_MODE_MSG.SET_FILTER, mutedServerIds: [] },
      { type: GLOBAL_TASK_MODE_MSG.SET_FILTER, mutedServerIds: ['srv-unpin'] },
    ]);

    fireEvent.click(screen.getByTestId('task-mode-server-filter-btn'));
    expect((screen.getByTestId('task-mode-server-toggle-srv-pin') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('task-mode-server-toggle-srv-unpin') as HTMLInputElement).checked).toBe(false);

    // Idempotent re-render does not send duplicate SET_FILTER or trigger TTS
    rerender(
      <GlobalTaskModeView
        onExit={vi.fn()}
        onJumpToSession={vi.fn()}
        pinnedServerIds={pinnedSet}
      />,
    );
    expect(ws.sent).toHaveLength(2);
    expect(spokenUtterances).toHaveLength(0);

    // Explicit toggle persists '[]' and prevents pinned default from overwriting on later snapshots
    fireEvent.click(screen.getByTestId('task-mode-server-toggle-srv-unpin'));
    expect(localStorage.getItem(GLOBAL_TASK_MUTED_SERVERS_STORAGE_KEY)).toBe('[]');
    expect((screen.getByTestId('task-mode-server-toggle-srv-unpin') as HTMLInputElement).checked).toBe(true);

    await act(async () => {
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
        ts: nowLive + 1000,
        servers: [
          { id: 'srv-pin', name: 'Pinned-Srv', online: true },
          { id: 'srv-unpin', name: 'Unpinned-Srv', online: true },
        ],
        brains: [],
        tasks: [],
      });
    });
    expect((screen.getByTestId('task-mode-server-toggle-srv-unpin') as HTMLInputElement).checked).toBe(true);
    expect(localStorage.getItem(GLOBAL_TASK_MUTED_SERVERS_STORAGE_KEY)).toBe('[]');
  });

  it('falls back to checking all servers when pinnedServerIds matches no available server', async () => {
    const { GlobalTaskModeView } = await import('../../src/components/GlobalTaskModeView.js');
    render(
      <GlobalTaskModeView
        onExit={vi.fn()}
        onJumpToSession={vi.fn()}
        pinnedServerIds={new Set(['srv-not-in-list'])}
      />,
    );

    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.instances[0]!;

    await act(async () => {
      ws.simulateOpen();
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
        ts: Date.now(),
        servers: [
          { id: 'srv-1', name: 'Srv-1', online: true },
          { id: 'srv-2', name: 'Srv-2', online: true },
        ],
        brains: [],
        tasks: [],
      });
    });

    fireEvent.click(screen.getByTestId('task-mode-server-filter-btn'));
    expect((screen.getByTestId('task-mode-server-toggle-srv-1') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('task-mode-server-toggle-srv-2') as HTMLInputElement).checked).toBe(true);
    expect(ws.sent.map((s) => JSON.parse(s))).toEqual([
      { type: GLOBAL_TASK_MODE_MSG.SET_FILTER, mutedServerIds: [] },
    ]);
  });

  it('clamps verbose card text with full hover titles when collapsed and expands cleanly on click', async () => {
    const longTitle = 'A very long task title that should clamp to one line when collapsed and expand on click';
    const longSummary = 'Very verbose live summary detailing multiple steps that must stay one line until expanded';
    const longBrainText = 'Detailed Brain update message that should clamp to 1 line collapsed and expand to 6 lines';

    const { ws } = await mountWithSnapshot();
    const now = Date.now();

    await act(async () => {
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
        ts: now,
        servers: [{ id: 'srv-1', name: 'extremely-long-server-hostname-01', online: true }],
        brains: [],
        tasks: [
          {
            serverId: 'srv-1',
            serverName: 'extremely-long-server-hostname-01',
            serverOnline: true,
            projectName: 'imcodes',
            brainSession: 'deck_very_long_brain_session_name',
            brainLabel: 'Extremely Long Brain Label Name',
            taskId: 'tsk_compact_1',
            title: longTitle,
            status: 'working',
            flags: [],
            round: 2,
            checklist: { total: 4, implemented: 2, audited: 1 },
            liveSummary: longSummary,
            createdAt: now - 5_000,
            updatedAt: now,
            isTerminal: false,
            needsAttention: false,
          },
          {
            serverId: 'srv-1',
            serverName: 'extremely-long-server-hostname-01',
            serverOnline: true,
            projectName: 'imcodes',
            brainSession: 'deck_very_long_brain_session_name',
            brainLabel: 'Extremely Long Brain Label Name',
            taskId: 'tsk_no_check',
            title: 'No checklist task',
            status: 'working',
            flags: [],
            round: 1,
            checklist: { total: 0, implemented: 0, audited: 0 },
            createdAt: now - 5_000,
            updatedAt: now,
            isTerminal: false,
            needsAttention: false,
          },
        ],
        mutedServerIds: [],
      });
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.BRAIN_TEXT,
        event: {
          serverId: 'srv-1',
          serverName: 'extremely-long-server-hostname-01',
          sessionName: 'deck_very_long_brain_session_name',
          projectName: 'imcodes',
          eventId: 'evt-compact-1',
          text: longBrainText,
          ts: now,
        },
      });
    });

    const card = screen.getByTestId('task-mode-card-tsk_compact_1');
    expect(card.className).not.toContain('is-expanded');
    expect(card.querySelector('.global-task-card-title')?.getAttribute('title')).toBe(longTitle);
    expect(card.querySelector('.global-task-live-summary')?.getAttribute('title')).toBe(longSummary);
    expect(card.querySelector('.global-task-brain-preview-text')?.getAttribute('title')).toBe(longBrainText);
    expect(card.querySelector('.global-task-server-tag')?.getAttribute('title')).toBe('extremely-long-server-hostname-01');
    expect(card.querySelector('.global-task-brain-tag')?.getAttribute('title')).toBe('Extremely Long Brain Label Name');

    // Progress bar renders when total > 0 and stays hidden when checklist.total === 0
    expect(screen.queryByTestId('task-mode-progress-tsk_compact_1')).not.toBeNull();
    expect(screen.queryByTestId('task-mode-progress-tsk_no_check')).toBeNull();

    // Clicking the card toggles is-expanded and reveals detail metadata
    fireEvent.click(card);
    expect(card.className).toContain('is-expanded');
    expect(screen.queryByTestId('task-mode-details-tsk_compact_1')).not.toBeNull();

    // Verify CSS compactness, 1-line collapsed clamping, expansion unclamping, and mobile containment
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve(process.cwd().endsWith('/web') ? process.cwd() : resolve(process.cwd(), 'web'), 'src/styles.css'), 'utf8');
    expect(css).toMatch(/\.global-task-mode-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(310px,\s*1fr\)\);[^}]*gap:\s*6px;/s);
    expect(css).toMatch(/\.global-task-card-meta\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.global-task-card-title\s*\{[^}]*-webkit-line-clamp:\s*1;[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.global-task-card\.is-expanded\s+\.global-task-card-title\s*\{[^}]*-webkit-line-clamp:\s*unset;[^}]*display:\s*block;/s);
    expect(css).toMatch(/\.global-task-live-summary\s*\{[^}]*-webkit-line-clamp:\s*1;[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.global-task-card\.is-expanded\s+\.global-task-live-summary\s*\{[^}]*-webkit-line-clamp:\s*unset;[^}]*display:\s*block;/s);
    expect(css).toMatch(/\.global-task-brain-preview-text\s*\{[^}]*-webkit-line-clamp:\s*1;[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.global-task-card\.is-expanded\s+\.global-task-brain-preview-text\s*\{[^}]*-webkit-line-clamp:\s*6;/s);
    expect(css).toMatch(/\.global-task-progress-wrap\s*\{[^}]*flex-direction:\s*row;[^}]*align-items:\s*center;/s);
    const mobileBlock = css.slice(css.lastIndexOf('@media (max-width: 720px)'));
    expect(mobileBlock).toMatch(/\.global-task-mode-grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);/s);
    expect(css).not.toMatch(/\.global-task-card-actions\b/);
    expect(css).toMatch(/\.global-task-reply-btn\s*\{[^}]*margin-left:\s*auto;[^}]*flex:\s*0\s+0\s+auto;/s);
    expect(css).toMatch(/\.global-task-server-tag\s*\{[^}]*flex:\s*0\s+1\s+auto;[^}]*min-width:\s*0;/s);
    expect(css).toMatch(/\.global-task-brain-tag\s*\{[^}]*flex:\s*0\s+1\s+auto;[^}]*min-width:\s*0;/s);
  });

  it('renders inline icon-only reply button inside meta header without separate actions column on active and terminal cards', async () => {
    await mountWithSnapshot();

    expect(document.querySelector('.global-task-card-actions')).toBeNull();

    const activeCard = screen.getByTestId('task-mode-card-tsk_pair_1');
    const activeReplyBtn = screen.getByTestId('task-mode-reply-tsk_pair_1');
    const activeBriefBtn = screen.getByTestId('task-mode-brief-btn-tsk_pair_1');
    expect(activeReplyBtn.closest('.global-task-card-meta')).not.toBeNull();
    expect(activeBriefBtn.closest('.global-task-card-meta')).toBe(activeReplyBtn.closest('.global-task-card-meta'));
    expect(activeReplyBtn.parentElement?.className).toContain('global-task-card-quick-actions');
    expect(activeReplyBtn.querySelectorAll('svg').length).toBe(2);
    expect(activeReplyBtn.textContent?.trim()).toBe('');
    expect(activeReplyBtn.getAttribute('aria-label')).toBe('Reply');
    expect(activeReplyBtn.getAttribute('title')).toBe('Tap to type, hold for voice');

    fireEvent.click(activeReplyBtn);
    expect(activeCard.className).not.toContain('is-expanded');
    expect(screen.getByTestId('task-mode-composer').textContent).toContain('Build Global View');
    fireEvent.click(screen.getByTestId('task-mode-composer-backdrop'));

    const doneCard = screen.getByTestId('task-mode-card-tsk_done_1');
    const doneReplyBtn = screen.getByTestId('task-mode-reply-tsk_done_1');
    const doneBriefBtn = screen.getByTestId('task-mode-brief-btn-tsk_done_1');
    expect(doneReplyBtn.closest('.global-task-card-meta')).not.toBeNull();
    expect(doneBriefBtn.closest('.global-task-card-meta')).toBe(doneReplyBtn.closest('.global-task-card-meta'));
    expect(doneReplyBtn.parentElement?.className).toContain('global-task-card-quick-actions');
    expect(doneReplyBtn.querySelectorAll('svg').length).toBe(2);
    expect(doneReplyBtn.textContent?.trim()).toBe('');
    expect(doneReplyBtn.getAttribute('aria-label')).toBe('Follow up');
    expect(doneReplyBtn.getAttribute('title')).toBe('Tap to type, hold for voice');

    fireEvent.click(doneReplyBtn);
    expect(doneCard.className).not.toContain('is-expanded');
    expect(screen.getByTestId('task-mode-composer').textContent).toContain('Ship WS backend');
    fireEvent.click(screen.getByTestId('task-mode-composer-backdrop'));

    dispatchPointer(doneReplyBtn, 'pointerdown', { clientX: 100, clientY: 100, pointerId: 9 });
    await act(async () => {
      vi.advanceTimersByTime(280);
    });
    expect(doneCard.className).not.toContain('is-expanded');
    expect(screen.getByTestId('mock-voice-overlay').getAttribute('data-session-label')).toContain('Ship WS backend');
  });

  it('displays compact start time and live/final execution duration on cards and tightens mobile layout CSS', async () => {
    const baseNow = Date.now();
    const { ws } = await mountWithSnapshot();

    await act(async () => {
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
        ts: baseNow,
        servers: [{ id: 'srv-1', name: 'Alpha Box', online: true }],
        brains: [],
        tasks: [
          {
            serverId: 'srv-1',
            serverName: 'Alpha Box',
            serverOnline: true,
            projectName: 'imcodes',
            brainSession: 'deck_imcodes_brain',
            brainLabel: 'Main',
            taskId: 'tsk_live_timed',
            title: 'Active timed task',
            status: 'working',
            flags: [],
            round: 1,
            checklist: { total: 4, implemented: 2, audited: 1 },
            startedAt: baseNow - 65_000,
            createdAt: baseNow - 120_000,
            updatedAt: baseNow - 5_000,
            isTerminal: false,
            needsAttention: false,
          },
          {
            serverId: 'srv-1',
            serverName: 'Alpha Box',
            serverOnline: true,
            projectName: 'imcodes',
            brainSession: 'deck_imcodes_brain',
            brainLabel: 'Main',
            taskId: 'tsk_queued_no_start',
            title: 'Queued task without startedAt',
            status: 'queued',
            flags: [],
            round: 0,
            checklist: { total: 0, implemented: 0, audited: 0 },
            createdAt: baseNow - 30_000,
            updatedAt: baseNow - 30_000,
            isTerminal: false,
            needsAttention: false,
          },
          {
            serverId: 'srv-1',
            serverName: 'Alpha Box',
            serverOnline: true,
            projectName: 'imcodes',
            brainSession: 'deck_imcodes_brain',
            brainLabel: 'Main',
            taskId: 'tsk_done_frozen',
            title: 'Terminal task with fixed duration',
            status: 'done',
            flags: [],
            round: 1,
            checklist: { total: 0, implemented: 0, audited: 0 },
            startedAt: baseNow - 90_000,
            endedAt: baseNow - 20_000,
            createdAt: baseNow - 100_000,
            updatedAt: baseNow - 15_000,
            isTerminal: true,
            needsAttention: false,
          },
        ],
      });
    });

    const liveTiming = screen.getByTestId('task-mode-timing-tsk_live_timed');
    expect(liveTiming.closest('.global-task-progress-wrap')).not.toBeNull();
    expect(liveTiming.textContent).toContain('1m 5s');
    expect(liveTiming.textContent).not.toContain('NaN');

    const queuedTiming = screen.getByTestId('task-mode-timing-tsk_queued_no_start');
    expect(queuedTiming.closest('.global-task-timing-row')).not.toBeNull();
    expect(queuedTiming.textContent).toContain('30s');
    expect(queuedTiming.textContent).not.toContain('NaN');

    const doneTiming = screen.getByTestId('task-mode-timing-tsk_done_frozen');
    expect(doneTiming.textContent).toContain('1m 10s');

    // Advance 5 seconds: active & queued tick forward, terminal stays frozen at 1m 10s
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByTestId('task-mode-timing-tsk_live_timed').textContent).toContain('1m 10s');
    expect(screen.getByTestId('task-mode-timing-tsk_queued_no_start').textContent).toContain('35s');
    expect(screen.getByTestId('task-mode-timing-tsk_done_frozen').textContent).toContain('1m 10s');

    // Verify mobile <=720px compact spacing rules in styles.css
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve(process.cwd().endsWith('/web') ? process.cwd() : resolve(process.cwd(), 'web'), 'src/styles.css'), 'utf8');
    const mobileBlock = css.slice(css.lastIndexOf('@media (max-width: 720px)'));
    expect(mobileBlock).toMatch(/\.global-task-mode-body\s*\{[^}]*padding:\s*8px;[^}]*gap:\s*6px;/s);
    expect(mobileBlock).toMatch(/\.global-task-quickbar\s*\{[^}]*padding:\s*6px 8px;[^}]*gap:\s*5px;/s);
    expect(mobileBlock).toMatch(/\.global-task-card-surface\s*\{[^}]*padding:\s*5px 7px;[^}]*gap:\s*2\.5px;/s);
    expect(mobileBlock).toMatch(/\.global-task-card\.is-terminal \.global-task-card-surface\s*\{[^}]*padding:\s*4px 7px;/s);
    expect(mobileBlock).toMatch(/\.global-task-card-title\s*\{[^}]*font-size:\s*11\.5px;/s);
    expect(mobileBlock).toMatch(/\.global-task-card-timing\s*\{[^}]*font-size:\s*9\.5px;/s);
    expect(mobileBlock).toMatch(/\.global-task-progress-track\s*\{[^}]*min-width:\s*20px;/s);
  });

  it('plays Task Mode announcements in true chronological execution order across BRAIN_TEXT and UI-prioritized task transitions', async () => {
    const { setTtsAutoReadEnabled } = await import('../../src/tts.js');
    const { compareTaskModeTtsItems, enqueueChronologicalTtsItems } = await import('../../src/components/GlobalTaskModeView.js');
    setTtsAutoReadEnabled(true);

    // Pure queue ordering check: chronological eventTs ASC, then arrivalSeq ASC
    const sorted: Array<{ text: string; messageId: string; lang: string; eventTs: number; arrivalSeq: number }> = [];
    enqueueChronologicalTtsItems(sorted, [
      { text: 'Second', messageId: 'm2', lang: 'en', eventTs: 200, arrivalSeq: 1 },
      { text: 'FirstB', messageId: 'm1b', lang: 'en', eventTs: 100, arrivalSeq: 3 },
      { text: 'FirstA', messageId: 'm1a', lang: 'en', eventTs: 100, arrivalSeq: 2 },
    ]);
    expect(sorted.map((x) => x.messageId)).toEqual(['m1a', 'm1b', 'm2']);
    expect(compareTaskModeTtsItems(sorted[0]!, sorted[1]!)).toBeLessThan(0);

    const { ws } = await mountWithSnapshot();
    expect(spokenUtterances).toHaveLength(0);

    const baseTs = Date.now();
    // Send newer high-priority attention task + newer brain text BEFORE older transitions in the same turn
    await act(async () => {
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.BRAIN_TEXT,
        event: {
          serverId: 'srv-1',
          serverName: 'M3-Mac',
          sessionName: 'deck_imcodes_brain',
          projectName: 'imcodes',
          eventId: 'evt-order-3',
          text: 'Third brain update',
          ts: baseTs + 300,
        },
      });
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.UPSERT,
        task: {
          serverId: 'srv-1',
          serverName: 'M3-Mac',
          serverOnline: true,
          projectName: 'imcodes',
          brainSession: 'deck_imcodes_brain',
          brainLabel: 'IM Brain',
          taskId: 'tsk_later_urgent',
          title: 'Urgent Later Task',
          status: 'awaiting_brain_decision',
          flags: ['blocked'],
          round: 1,
          checklist: { total: 1, implemented: 0, audited: 0 },
          createdAt: baseTs + 150,
          updatedAt: baseTs + 200,
          isTerminal: false,
          needsAttention: true,
        },
      });
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.UPSERT,
        task: {
          serverId: 'srv-1',
          serverName: 'M3-Mac',
          serverOnline: true,
          projectName: 'imcodes',
          brainSession: 'deck_imcodes_brain',
          brainLabel: 'IM Brain',
          taskId: 'tsk_earlier_done',
          title: 'Earlier Done Task',
          status: 'done',
          flags: [],
          round: 1,
          checklist: { total: 1, implemented: 1, audited: 1 },
          createdAt: baseTs + 50,
          updatedAt: baseTs + 100,
          isTerminal: true,
          needsAttention: false,
        },
      });
    });

    // Earliest item (baseTs + 100) must speak first, even though Urgent Later Task sorts first in UI cards
    expect(spokenUtterances).toHaveLength(1);
    expect(spokenUtterances[0]!.text).toContain('Earlier Done Task');

    await act(async () => {
      spokenUtterances[0]!.onend?.();
    });
    expect(spokenUtterances).toHaveLength(2);
    expect(spokenUtterances[1]!.text).toContain('Urgent Later Task');

    await act(async () => {
      spokenUtterances[1]!.onend?.();
    });
    expect(spokenUtterances).toHaveLength(3);
    expect(spokenUtterances[2]!.text).toContain('Third brain update');
  });

  it('queues bursts of more than 6 announcements without dropping earlier items and clears pending buffer on unmount', async () => {
    const { setTtsAutoReadEnabled, getTtsAutoReadEnabled } = await import('../../src/tts.js');
    setTtsAutoReadEnabled(true);

    const { ws } = await mountWithSnapshot();
    const baseTs = Date.now();

    // Burst 10 announcements out of reverse order (10 down to 1) -> all 10 must speak in chronological order 1..10
    await act(async () => {
      for (let i = 10; i >= 1; i--) {
        ws.simulateMessage({
          type: GLOBAL_TASK_MODE_MSG.BRAIN_TEXT,
          event: {
            serverId: 'srv-1',
            serverName: 'M3-Mac',
            sessionName: 'deck_imcodes_brain',
            projectName: 'imcodes',
            eventId: `evt-burst-${i}`,
            text: `Burst announcement ${i}`,
            ts: baseTs + i * 100,
          },
        });
      }
    });

    expect(spokenUtterances).toHaveLength(1);
    expect(spokenUtterances[0]!.text).toContain('Burst announcement 1');

    // Play items 2..10 sequentially without losing any item > 6
    for (let i = 1; i < 10; i++) {
      await act(async () => {
        spokenUtterances[i - 1]!.onend?.();
      });
      expect(spokenUtterances).toHaveLength(i + 1);
      expect(spokenUtterances[i]!.text).toContain(`Burst announcement ${i + 1}`);
    }

    // Queue another burst, finish current, then unmount -> unplayed buffered items stop & do not leak post-unmount
    await act(async () => {
      spokenUtterances[9]!.onend?.();
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.BRAIN_TEXT,
        event: {
          serverId: 'srv-1',
          serverName: 'M3-Mac',
          sessionName: 'deck_imcodes_brain',
          projectName: 'imcodes',
          eventId: 'evt-after-1',
          text: 'Before unmount 1',
          ts: baseTs + 2000,
        },
      });
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.BRAIN_TEXT,
        event: {
          serverId: 'srv-1',
          serverName: 'M3-Mac',
          sessionName: 'deck_imcodes_brain',
          projectName: 'imcodes',
          eventId: 'evt-after-2',
          text: 'Should not leak after unmount 2',
          ts: baseTs + 2100,
        },
      });
    });
    expect(spokenUtterances).toHaveLength(11);
    cleanup();
    expect(getTtsAutoReadEnabled()).toBe(true);
    expect(spokenUtterances).toHaveLength(11);
  });

  it('recovers missed live transitions chronologically on post-seed reconnect snapshot without speaking unchanged or pre-mount history', async () => {
    const { setTtsAutoReadEnabled } = await import('../../src/tts.js');
    setTtsAutoReadEnabled(true);

    const { ws } = await mountWithSnapshot();
    expect(spokenUtterances).toHaveLength(0);

    const liveTs = Date.now();
    // Simulate WS drop + reconnect SNAPSHOT containing:
    // 1. Existing tsk_pair_1 transitioned working -> passed (newer timestamp: liveTs + 200)
    // 2. Newly appeared live task tsk_reconnect_new (earlier timestamp: liveTs + 100)
    // 3. Pre-mount historical task tsk_premount_hist (old timestamp) -> must NOT speak
    // 4. Unchanged existing task tsk_done_1 -> must NOT speak
    await act(async () => {
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
        ts: liveTs + 300,
        servers: [
          { id: 'srv-1', name: 'M3-Mac', online: true },
          { id: 'srv-2', name: 'Linux-GPU', online: true },
        ],
        brains: [],
        tasks: [
          {
            serverId: 'srv-1',
            serverName: 'M3-Mac',
            serverOnline: true,
            projectName: 'imcodes',
            brainSession: 'deck_imcodes_brain',
            brainLabel: 'IM Brain',
            taskId: 'tsk_pair_1',
            title: 'Build Global View',
            status: 'passed',
            flags: [],
            round: 2,
            checklist: { total: 5, implemented: 5, audited: 5 },
            createdAt: 100,
            updatedAt: liveTs + 200,
            isTerminal: false,
            needsAttention: false,
          },
          {
            serverId: 'srv-1',
            serverName: 'M3-Mac',
            serverOnline: true,
            projectName: 'imcodes',
            brainSession: 'deck_imcodes_brain',
            brainLabel: 'IM Brain',
            taskId: 'tsk_reconnect_new',
            title: 'Reconnect New Task',
            status: 'working',
            flags: [],
            round: 1,
            checklist: { total: 2, implemented: 0, audited: 0 },
            createdAt: liveTs + 50,
            updatedAt: liveTs + 100,
            isTerminal: false,
            needsAttention: false,
          },
          {
            serverId: 'srv-1',
            serverName: 'M3-Mac',
            serverOnline: true,
            projectName: 'imcodes',
            brainSession: 'deck_imcodes_brain',
            brainLabel: 'IM Brain',
            taskId: 'tsk_premount_hist',
            title: 'Pre-mount Historical Task',
            status: 'done',
            flags: [],
            round: 1,
            checklist: { total: 1, implemented: 1, audited: 1 },
            createdAt: 10,
            updatedAt: liveTs - 5 * 60 * 1000,
            isTerminal: true,
            needsAttention: false,
          },
          {
            serverId: 'srv-1',
            serverName: 'M3-Mac',
            serverOnline: true,
            projectName: 'imcodes',
            brainSession: 'deck_imcodes_brain',
            brainLabel: 'IM Brain',
            taskId: 'tsk_done_1',
            title: 'Ship WS backend',
            status: 'done',
            flags: [],
            round: 1,
            checklist: { total: 3, implemented: 3, audited: 3 },
            createdAt: 50,
            updatedAt: 200,
            isTerminal: true,
            needsAttention: false,
          },
        ],
      });
    });

    // tsk_reconnect_new (liveTs + 100) speaks BEFORE tsk_pair_1 passed (liveTs + 200); historical & unchanged stay silent
    expect(spokenUtterances).toHaveLength(1);
    expect(spokenUtterances[0]!.text).toContain('Reconnect New Task');

    await act(async () => {
      spokenUtterances[0]!.onend?.();
    });
    expect(spokenUtterances).toHaveLength(2);
    expect(spokenUtterances[1]!.text).toContain('Build Global View');

    await act(async () => {
      spokenUtterances[1]!.onend?.();
    });
    expect(spokenUtterances).toHaveLength(2);
  });

  it('displays readable session names everywhere instead of internal session IDs and keeps routing by internal sessionName', async () => {
    const { GlobalTaskModeView } = await import('../../src/components/GlobalTaskModeView.js');
    const onExit = vi.fn();
    const onJumpToSession = vi.fn();
    render(
      <GlobalTaskModeView
        onExit={onExit}
        onJumpToSession={onJumpToSession}
        pinnedSessionNames={new Set(['deck_cd_brain', 'deck_chan_brain'])}
      />,
    );
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.instances[0]!;
    const now = Date.now();

    await act(async () => {
      ws.simulateOpen();
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
        ts: now,
        servers: [{ id: 'srv-1', name: 'M3-Mac', online: true }],
        brains: [
          {
            serverId: 'srv-1',
            serverName: 'M3-Mac',
            serverOnline: true,
            sessionName: 'deck_cd_brain',
            projectName: 'cd',
            label: 'deck_cd_brain',
            state: 'idle',
            agentType: 'claude-code-sdk',
          },
          {
            serverId: 'srv-1',
            serverName: 'M3-Mac',
            serverOnline: true,
            sessionName: 'deck_chan_brain',
            projectName: 'chat-proj',
            label: 'discord:1476187408042033309#general',
            state: 'idle',
            agentType: 'codex-sdk',
          },
        ],
        tasks: [
          {
            serverId: 'srv-1',
            serverName: 'M3-Mac',
            serverOnline: true,
            projectName: 'cd',
            brainSession: 'deck_cd_brain',
            brainLabel: 'deck_cd_brain',
            taskId: 'tsk_display_1',
            title: 'Check Display Names',
            status: 'working',
            flags: [],
            round: 1,
            checklist: { total: 1, implemented: 0, audited: 0 },
            executorLabel: 'deck_sub_pair_auto_exec1',
            auditor: 'deck_sub_pair_auto_6ac6fe82aa0aecfc',
            auditorLabel: 'deck_sub_pair_auto_6ac6fe82aa0aecfc',
            createdAt: now - 10_000,
            updatedAt: now - 1_000,
            isTerminal: false,
            needsAttention: false,
          },
        ],
      });
    });

    // Quick Dispatch pills show readable project/formatted channel labels, never internal session IDs
    const cdPill = screen.getByTestId('task-mode-brain-pill-srv-1-deck_cd_brain');
    expect(cdPill.textContent).toContain('M3-Mac · cd');
    expect(cdPill.textContent).not.toContain('deck_cd_brain');
    const chanPill = screen.getByTestId('task-mode-brain-pill-srv-1-deck_chan_brain');
    expect(chanPill.textContent).toContain('M3-Mac · discord#general');

    // Card header Brain tag shows readable name 'cd'
    const card = screen.getByTestId('task-mode-card-tsk_display_1');
    const brainTag = card.querySelector('.global-task-brain-tag');
    expect(brainTag?.textContent).toBe('cd');
    expect(brainTag?.getAttribute('title')).toBe('cd');

    // Expanded details never leak internal deck_sub_* IDs, and jump still uses internal sessionName
    fireEvent.click(card);
    const details = screen.getByTestId('task-mode-details-tsk_display_1');
    expect(details.textContent).not.toContain('deck_sub_');
    expect(details.textContent).toContain('Executor: Unassigned');
    expect(details.textContent).toContain('Auditor: Auditor');
    fireEvent.click(screen.getByTestId('task-mode-jump-tsk_display_1'));
    expect(onJumpToSession).toHaveBeenCalledWith('srv-1', 'deck_cd_brain', {
      taskId: 'tsk_display_1',
      title: 'Check Display Names',
      status: 'working',
    });

    // Reply composer header and VoiceOverlay show readable Brain label
    fireEvent.click(screen.getByTestId('task-mode-reply-tsk_display_1'));
    expect(screen.getByTestId('task-mode-composer').textContent).toContain('M3-Mac · cd');
    expect(screen.getByTestId('task-mode-composer').textContent).not.toContain('deck_cd_brain');
    fireEvent.click(screen.getByTestId('task-mode-composer-voice-btn'));
    expect(screen.getByTestId('mock-voice-overlay').getAttribute('data-session-label')).toContain('M3-Mac · cd');
    await act(async () => {
      voiceOverlayMock.lastOnClose?.();
    });

    // + Add / Dispatch dropdown avoids 'cd (cd)' duplication and formats custom label with project
    fireEvent.click(screen.getByTestId('task-mode-add-brain-btn'));
    const select = screen.getByTestId('task-mode-add-brain-select') as HTMLSelectElement;
    const optionTexts = Array.from(select.options).map((o) => o.textContent);
    expect(optionTexts).toContain('cd');
    expect(optionTexts).not.toContain('cd (cd)');
    expect(optionTexts).toContain('discord#general (chat-proj)');
  });

  it('never leaks raw internal IDs when stale localStorage and legacy task rows have no projectName or live session', async () => {
    const {
      GLOBAL_TASK_PINNED_BRAINS_STORAGE_KEY,
      GLOBAL_TASK_RECENT_BRAINS_STORAGE_KEY,
      clearGlobalTaskModeSessionState,
      globalTaskModeStore,
    } = await import('../../src/global-task-mode-store.js');
    clearGlobalTaskModeSessionState();
    const stalePinned = [
      { serverId: 'srv-1', sessionName: 'deck_cd_brain', label: 'deck_cd_brain' },
      { serverId: 'srv-1', sessionName: 'deck_sub_pair_auto_6ac6fe82aa0aecfc', label: 'deck_sub_pair_auto_6ac6fe82aa0aecfc' },
    ];
    const staleRecent = [
      { serverId: 'srv-1', sessionName: 'bootmainxowfy6', label: 'bootmainxowfy6', lastUsedAt: Date.now() },
    ];
    localStorage.setItem(GLOBAL_TASK_PINNED_BRAINS_STORAGE_KEY, JSON.stringify(stalePinned));
    localStorage.setItem(GLOBAL_TASK_RECENT_BRAINS_STORAGE_KEY, JSON.stringify(staleRecent));
    (globalTaskModeStore as unknown as { setState: (patch: Record<string, unknown>) => void }).setState({
      pinnedBrains: stalePinned,
      recentBrains: staleRecent,
    });

    const { GlobalTaskModeView } = await import('../../src/components/GlobalTaskModeView.js');
    const onJumpToSession = vi.fn();
    render(
      <GlobalTaskModeView
        onExit={vi.fn()}
        onJumpToSession={onJumpToSession}
        pinnedSessionNames={new Set(['bootmainxowfy6'])}
      />,
    );
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.instances[0]!;
    const now = Date.now();

    await act(async () => {
      ws.simulateOpen();
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
        ts: now,
        servers: [{ id: 'srv-1', name: 'M3-Mac', online: true }],
        brains: [],
        tasks: [
          {
            serverId: 'srv-1',
            serverName: 'M3-Mac',
            serverOnline: true,
            projectName: '',
            brainSession: 'bootmainxowfy6',
            brainLabel: 'bootmainxowfy6',
            taskId: 'tsk_legacy_noproj',
            title: 'Legacy No Project',
            status: 'working',
            flags: [],
            round: 1,
            checklist: { total: 1, implemented: 0, audited: 0 },
            createdAt: now - 10_000,
            updatedAt: now - 500,
            isTerminal: false,
            needsAttention: false,
          },
          {
            serverId: 'srv-1',
            serverName: 'M3-Mac',
            serverOnline: true,
            projectName: '',
            brainSession: 'deck_legacy_brain',
            brainLabel: 'Legacy Readable',
            taskId: 'tsk_legacy_readable',
            title: 'Legacy With Label',
            status: 'working',
            flags: [],
            round: 1,
            checklist: { total: 1, implemented: 0, audited: 0 },
            createdAt: now - 10_000,
            updatedAt: now - 200,
            isTerminal: false,
            needsAttention: false,
          },
        ],
      });
    });

    // Quick dispatch pills never show deck_* or bootmain* IDs
    const pillCd = screen.getByTestId('task-mode-brain-pill-srv-1-deck_cd_brain');
    const pillSub = screen.getByTestId('task-mode-brain-pill-srv-1-deck_sub_pair_auto_6ac6fe82aa0aecfc');
    const pillBoot = screen.getByTestId('task-mode-brain-pill-srv-1-bootmainxowfy6');
    expect(pillCd.textContent).toContain('Brain');
    expect(pillSub.textContent).toContain('Worker');
    expect(pillBoot.textContent).toContain('Brain');
    for (const el of [pillCd, pillSub, pillBoot]) {
      expect(el.textContent).not.toMatch(/deck_|bootmain/);
    }

    // Legacy task with no projectName & internal brainLabel renders generic fallback; readable brainLabel keeps precedence
    const legacyNoProjCard = screen.getByTestId('task-mode-card-tsk_legacy_noproj');
    const legacyNoProjTag = legacyNoProjCard.querySelector('.global-task-brain-tag');
    expect(legacyNoProjTag?.textContent).toBe('Brain');
    expect(legacyNoProjTag?.textContent).not.toContain('bootmain');

    const legacyReadableCard = screen.getByTestId('task-mode-card-tsk_legacy_readable');
    expect(legacyReadableCard.querySelector('.global-task-brain-tag')?.textContent).toBe('Legacy Readable');

    // Reply composer, VoiceOverlay, and onJumpToSession preserve routing key while displaying fallback
    fireEvent.click(screen.getByTestId('task-mode-reply-tsk_legacy_noproj'));
    expect(screen.getByTestId('task-mode-composer').textContent).toContain('M3-Mac · Brain');
    expect(screen.getByTestId('task-mode-composer').textContent).not.toContain('bootmain');
    fireEvent.click(screen.getByTestId('task-mode-composer-voice-btn'));
    const voiceLabel = screen.getByTestId('mock-voice-overlay').getAttribute('data-session-label') ?? '';
    expect(voiceLabel).toContain('Brain');
    expect(voiceLabel).not.toContain('bootmain');
    await act(async () => {
      voiceOverlayMock.lastOnClose?.();
    });

    fireEvent.click(legacyNoProjCard);
    fireEvent.click(screen.getByTestId('task-mode-jump-tsk_legacy_noproj'));
    expect(onJumpToSession).toHaveBeenCalledWith('srv-1', 'bootmainxowfy6', {
      taskId: 'tsk_legacy_noproj',
      title: 'Legacy No Project',
      status: 'working',
    });
  });

  it('provides an Open session button in the Quick Composer footer alongside Mic and Send for reply, dispatch, and add-dispatch modals', async () => {
    const { onJumpToSession } = await mountWithSnapshot();

    // 1. Reply composer mode: Open session button lives in the footer alongside Mic and Send
    fireEvent.click(screen.getByTestId('task-mode-reply-tsk_pair_1'));
    const replyDialog = screen.getByTestId('task-mode-composer');
    const replyEnterBtn = screen.getByTestId('task-mode-composer-enter-session');
    const replyFooter = replyDialog.querySelector('.global-task-composer-footer')!;
    expect(replyFooter.contains(replyEnterBtn)).toBe(true);
    expect(replyFooter.contains(screen.getByTestId('task-mode-composer-voice-btn'))).toBe(true);
    expect(replyFooter.contains(screen.getByTestId('task-mode-composer-send-btn'))).toBe(true);
    fireEvent.click(replyEnterBtn);
    expect(screen.queryByTestId('task-mode-composer')).toBeNull();
    expect(onJumpToSession).toHaveBeenNthCalledWith(1, 'srv-1', 'deck_imcodes_brain', {
      taskId: 'tsk_pair_1',
      title: 'Build Global View',
      status: 'in_audit',
    });

    // 2. + Add / Dispatch modal: Open session button lives in the footer for selected server+Brain
    fireEvent.click(screen.getByTestId('task-mode-add-brain-btn'));
    const addModal = screen.getByTestId('task-mode-add-modal');
    const addEnterBtn = screen.getByTestId('task-mode-add-enter-session') as HTMLButtonElement;
    const addFooter = addModal.querySelector('.global-task-composer-footer')!;
    expect(addFooter.contains(addEnterBtn)).toBe(true);
    expect(addFooter.contains(screen.getByTestId('task-mode-add-voice-btn'))).toBe(true);
    expect(addFooter.contains(screen.getByTestId('task-mode-add-submit-btn'))).toBe(true);
    expect(addEnterBtn.disabled).toBe(false);

    const srvSelect = screen.getByTestId('task-mode-add-server-select') as HTMLSelectElement;
    await waitFor(() => expect(srvSelect.value).toBe('srv-1'));
    await act(async () => {
      srvSelect.value = 'srv-2';
      srvSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(() => expect((screen.getByTestId('task-mode-add-brain-select') as HTMLSelectElement).value).toBe('deck_gpu_brain'));
    fireEvent.click(screen.getByTestId('task-mode-add-pin-toggle'));

    // Clicking Open session from + Add / Dispatch closes modal and jumps to srv-2/deck_gpu_brain
    fireEvent.click(addEnterBtn);
    expect(screen.queryByTestId('task-mode-add-modal')).toBeNull();
    expect(onJumpToSession).toHaveBeenNthCalledWith(2, 'srv-2', 'deck_gpu_brain');

    // 3. Pinned Brain pill -> Quick Dispatch composer mode: footer button closes modal and jumps to session
    fireEvent.click(screen.getByTestId('task-mode-brain-pill-srv-2-deck_gpu_brain'));
    const dispatchDialog = screen.getByTestId('task-mode-composer');
    const dispatchEnterBtn = screen.getByTestId('task-mode-composer-enter-session');
    expect(dispatchDialog.querySelector('.global-task-composer-footer')!.contains(dispatchEnterBtn)).toBe(true);
    fireEvent.click(dispatchEnterBtn);
    expect(screen.queryByTestId('task-mode-composer')).toBeNull();
    expect(onJumpToSession).toHaveBeenNthCalledWith(3, 'srv-2', 'deck_gpu_brain');
  });

  it('disables the Open session button in Add / Dispatch modal when the selected server has no Brain', async () => {
    const { ws } = await mountWithSnapshot();
    await act(async () => {
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
        ts: 20_000,
        servers: [
          { id: 'srv-empty', name: 'empty-host', online: true },
        ],
        brains: [],
        tasks: [],
      });
    });
    fireEvent.click(screen.getByTestId('task-mode-add-brain-btn'));
    const addEnterBtn = screen.getByTestId('task-mode-add-enter-session') as HTMLButtonElement;
    expect(addEnterBtn.disabled).toBe(true);
  });

  it('supports horizontal swipe-left with confirmation to cancel an active task while ignoring vertical scroll and partial swipes', async () => {
    const closeCalls: Array<{ url: string; body: unknown }> = [];
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(GLOBAL_TASK_TICKET_PATH)) {
        return new Response(JSON.stringify({ ticket: 'gt-ticket' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/task-pairs/') && url.endsWith('/close')) {
        closeCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response(JSON.stringify({
          ok: true,
          taskId: 'tsk_pair_1',
          status: 'cancelled',
          updatedAt: Date.now(),
          endedAt: Date.now(),
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await mountWithSnapshot();
    const card = screen.getByTestId('task-mode-card-tsk_pair_1');

    // 1. Vertical scroll gesture (dy > dx) must never trigger swipe cancel or modal
    fireEvent.touchStart(card, { touches: [{ clientX: 200, clientY: 200 }] });
    fireEvent.touchMove(card, { touches: [{ clientX: 185, clientY: 110 }] });
    fireEvent.touchEnd(card);
    expect(screen.queryByTestId('task-mode-swipe-cancel-tsk_pair_1')).toBeNull();
    expect(screen.queryByTestId('task-pair-close-confirm-dialog')).toBeNull();
    expect(closeCalls).toHaveLength(0);

    // 2. Tiny horizontal nudge (<40px) snaps back cleanly without revealing or confirming
    fireEvent.touchStart(card, { touches: [{ clientX: 200, clientY: 200 }] });
    fireEvent.touchMove(card, { touches: [{ clientX: 175, clientY: 202 }] });
    fireEvent.touchEnd(card);
    expect(screen.queryByTestId('task-mode-swipe-cancel-tsk_pair_1')).toBeNull();
    expect(screen.queryByTestId('task-pair-close-confirm-dialog')).toBeNull();

    // 3. Moderate swipe (55px) reveals Cancel button without auto-cancelling
    fireEvent.touchStart(card, { touches: [{ clientX: 200, clientY: 200 }] });
    fireEvent.touchMove(card, { touches: [{ clientX: 145, clientY: 202 }] });
    fireEvent.touchEnd(card);
    const swipeBtn = screen.getByTestId('task-mode-swipe-cancel-tsk_pair_1');
    expect(closeCalls).toHaveLength(0);

    // Tapping revealed button opens confirmation dialog; Keep dismisses without API call
    fireEvent.click(swipeBtn);
    expect(screen.getByTestId('task-pair-close-confirm-dialog')).toBeTruthy();
    fireEvent.click(screen.getByTestId('task-pair-close-keep-btn'));
    expect(screen.queryByTestId('task-pair-close-confirm-dialog')).toBeNull();
    expect(closeCalls).toHaveLength(0);

    // 4. Full swipe left (>=88px) opens confirmation dialog; Confirm cancels the task
    fireEvent.touchStart(card, { touches: [{ clientX: 220, clientY: 200 }] });
    fireEvent.touchMove(card, { touches: [{ clientX: 120, clientY: 202 }] });
    fireEvent.touchEnd(card);
    expect(screen.getByTestId('task-pair-close-confirm-dialog')).toBeTruthy();
    expect(closeCalls).toHaveLength(0);

    fireEvent.click(screen.getByTestId('task-pair-close-confirm-btn'));
    await waitFor(() => expect(closeCalls).toHaveLength(1));
    expect(closeCalls[0]).toEqual({
      url: 'http://localhost:3000/api/server/srv-1/task-pairs/tsk_pair_1/close',
      body: { action: 'cancel' },
    });
    await waitFor(() => {
      expect(screen.queryByTestId('task-pair-close-confirm-dialog')).toBeNull();
      expect(screen.getByTestId('task-mode-card-tsk_pair_1').className).toContain('is-terminal');
    });
  });

  it('supports desktop right-click context menu on Task Mode cards with confirmation, terminal guard, and error display', async () => {
    const closeCalls: Array<{ url: string; body: unknown }> = [];
    let shouldFailOffline = true;
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(GLOBAL_TASK_TICKET_PATH)) {
        return new Response(JSON.stringify({ ticket: 'gt-ticket' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/task-pairs/') && url.endsWith('/close')) {
        closeCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (shouldFailOffline) {
          return new Response(JSON.stringify({ ok: false, error: 'daemon_offline' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({
          ok: true,
          taskId: 'tsk_pair_1',
          status: 'cancelled',
          updatedAt: Date.now(),
          endedAt: Date.now(),
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await mountWithSnapshot();

    // Terminal card right-click offers Open session / Follow up, NOT Cancel task
    fireEvent.contextMenu(screen.getByTestId('task-mode-card-tsk_done_1'), { clientX: 120, clientY: 140 });
    expect(screen.getByTestId('task-pair-context-menu')).toBeTruthy();
    expect(screen.queryByTestId('task-mode-ctx-cancel-tsk_done_1')).toBeNull();
    expect(screen.getByTestId('task-mode-ctx-open-tsk_done_1')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('task-pair-context-menu')).toBeNull();

    // Active card right-click opens Cancel task -> Confirm -> offline error stays in dialog -> retry succeeds
    fireEvent.contextMenu(screen.getByTestId('task-mode-card-tsk_pair_1'), { clientX: 140, clientY: 160 });
    fireEvent.click(screen.getByTestId('task-mode-ctx-cancel-tsk_pair_1'));
    expect(screen.getByTestId('task-pair-close-confirm-dialog')).toBeTruthy();

    fireEvent.click(screen.getByTestId('task-pair-close-confirm-btn'));
    await waitFor(() => expect(screen.getByTestId('task-pair-close-confirm-error').textContent).toContain('Daemon is offline'));
    expect(closeCalls).toHaveLength(1);

    shouldFailOffline = false;
    fireEvent.click(screen.getByTestId('task-pair-close-confirm-btn'));
    await waitFor(() => expect(screen.queryByTestId('task-pair-close-confirm-dialog')).toBeNull());
    expect(closeCalls).toHaveLength(2);
    expect(screen.getByTestId('task-mode-card-tsk_pair_1').className).toContain('is-terminal');
  });

  it('computes and renders compact 24h done count and average duration inline in the finished header row without affecting active section', async () => {
    const { computeTaskMode24hStats, GlobalTaskModeView } = await import('../../src/components/GlobalTaskModeView.js');
    const nowMs = 1_795_000_000_000;
    const hourMs = 60 * 60 * 1000;

    // 1. Pure helper edge cases: done only, 24h window, fallbacks, invalid/reversed timestamps
    expect(computeTaskMode24hStats([], nowMs)).toEqual({ completedCount: 0, avgDurationMs: null });
    const pureStats = computeTaskMode24hStats([
      {
        serverId: 'srv-1',
        serverName: 'M3',
        serverOnline: true,
        projectName: 'p1',
        brainSession: 'b1',
        brainLabel: 'B1',
        taskId: 'd-1',
        title: 'Done with startedAt/endedAt',
        status: 'done',
        flags: [],
        round: 1,
        checklist: { total: 1, implemented: 1, audited: 1 },
        createdAt: nowMs - 3 * hourMs,
        startedAt: nowMs - 2 * hourMs,
        endedAt: nowMs - 2 * hourMs + 60_000,
        updatedAt: nowMs - 2 * hourMs + 60_000,
        isTerminal: true,
        needsAttention: false,
      },
      {
        serverId: 'srv-1',
        serverName: 'M3',
        serverOnline: true,
        projectName: 'p1',
        brainSession: 'b1',
        brainLabel: 'B1',
        taskId: 'd-2',
        title: 'Done fallback createdAt/updatedAt',
        status: 'done',
        flags: [],
        round: 1,
        checklist: { total: 1, implemented: 1, audited: 1 },
        createdAt: nowMs - hourMs,
        updatedAt: nowMs - hourMs + 120_000,
        isTerminal: true,
        needsAttention: false,
      },
      {
        serverId: 'srv-1',
        serverName: 'M3',
        serverOnline: true,
        projectName: 'p1',
        brainSession: 'b1',
        brainLabel: 'B1',
        taskId: 'd-reversed',
        title: 'Done reversed ts excluded from avg only',
        status: 'done',
        flags: [],
        round: 1,
        checklist: { total: 1, implemented: 1, audited: 1 },
        createdAt: nowMs - 30_000,
        startedAt: nowMs - 10_000,
        endedAt: nowMs - 20_000,
        updatedAt: nowMs - 20_000,
        isTerminal: true,
        needsAttention: false,
      },
      {
        serverId: 'srv-1',
        serverName: 'M3',
        serverOnline: true,
        projectName: 'p1',
        brainSession: 'b1',
        brainLabel: 'B1',
        taskId: 'c-1',
        title: 'Cancelled ignored',
        status: 'cancelled',
        flags: [],
        round: 1,
        checklist: { total: 1, implemented: 0, audited: 0 },
        createdAt: nowMs - 90_000,
        startedAt: nowMs - 80_000,
        endedAt: nowMs - 10_000,
        updatedAt: nowMs - 10_000,
        isTerminal: true,
        needsAttention: false,
      },
      {
        serverId: 'srv-1',
        serverName: 'M3',
        serverOnline: true,
        projectName: 'p1',
        brainSession: 'b1',
        brainLabel: 'B1',
        taskId: 'd-old',
        title: 'Done >24h old ignored',
        status: 'done',
        flags: [],
        round: 1,
        checklist: { total: 1, implemented: 1, audited: 1 },
        createdAt: nowMs - 30 * hourMs,
        startedAt: nowMs - 30 * hourMs,
        endedAt: nowMs - 25 * hourMs,
        updatedAt: nowMs - 25 * hourMs,
        isTerminal: true,
        needsAttention: false,
      },
    ], nowMs);
    expect(pureStats).toEqual({ completedCount: 3, avgDurationMs: 90_000 });

    // 2. Component rendering inline inside finished section (even while collapsed)
    vi.setSystemTime(nowMs);
    render(<GlobalTaskModeView onExit={vi.fn()} onJumpToSession={vi.fn()} />);
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.instances[0]!;

    await act(async () => {
      ws.simulateOpen();
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
        ts: nowMs,
        servers: [
          { id: 'srv-1', name: 'M3-Mac', online: true },
          { id: 'srv-2', name: 'Linux-GPU', online: true },
        ],
        brains: [],
        tasks: [
          {
            serverId: 'srv-1',
            serverName: 'M3-Mac',
            serverOnline: true,
            projectName: 'imcodes',
            brainSession: 'deck_imcodes_brain',
            brainLabel: 'IM Brain',
            taskId: 't-active',
            title: 'Active task',
            status: 'working',
            flags: [],
            round: 1,
            checklist: { total: 2, implemented: 1, audited: 0 },
            createdAt: nowMs - 10_000,
            updatedAt: nowMs - 5_000,
            isTerminal: false,
            needsAttention: false,
          },
          {
            serverId: 'srv-1',
            serverName: 'M3-Mac',
            serverOnline: true,
            projectName: 'imcodes',
            brainSession: 'deck_imcodes_brain',
            brainLabel: 'IM Brain',
            taskId: 't-done-1',
            title: 'Done 60s',
            status: 'done',
            flags: [],
            round: 1,
            checklist: { total: 2, implemented: 2, audited: 2 },
            createdAt: nowMs - 70_000,
            startedAt: nowMs - 65_000,
            endedAt: nowMs - 5_000,
            updatedAt: nowMs - 5_000,
            isTerminal: true,
            needsAttention: false,
          },
          {
            serverId: 'srv-2',
            serverName: 'Linux-GPU',
            serverOnline: true,
            projectName: 'trainer',
            brainSession: 'deck_gpu_brain',
            brainLabel: 'GPU Brain',
            taskId: 't-done-2',
            title: 'Done 120s',
            status: 'done',
            flags: [],
            round: 1,
            checklist: { total: 2, implemented: 2, audited: 2 },
            createdAt: nowMs - 130_000,
            updatedAt: nowMs - 10_000,
            isTerminal: true,
            needsAttention: false,
          },
          {
            serverId: 'srv-1',
            serverName: 'M3-Mac',
            serverOnline: true,
            projectName: 'imcodes',
            brainSession: 'deck_imcodes_brain',
            brainLabel: 'IM Brain',
            taskId: 't-cancelled',
            title: 'Cancelled task',
            status: 'cancelled',
            flags: [],
            round: 1,
            checklist: { total: 1, implemented: 0, audited: 0 },
            createdAt: nowMs - 60_000,
            startedAt: nowMs - 50_000,
            endedAt: nowMs - 10_000,
            updatedAt: nowMs - 10_000,
            isTerminal: true,
            needsAttention: false,
          },
          {
            serverId: 'srv-1',
            serverName: 'M3-Mac',
            serverOnline: true,
            projectName: 'imcodes',
            brainSession: 'deck_imcodes_brain',
            brainLabel: 'IM Brain',
            taskId: 't-old-done',
            title: 'Old done >24h',
            status: 'done',
            flags: [],
            round: 1,
            checklist: { total: 1, implemented: 1, audited: 1 },
            createdAt: nowMs - 30 * hourMs,
            startedAt: nowMs - 30 * hourMs,
            endedAt: nowMs - 26 * hourMs,
            updatedAt: nowMs - 26 * hourMs,
            isTerminal: true,
            needsAttention: false,
          },
        ],
      });
    });

    const activeSection = screen.getByTestId('task-mode-active-section');
    const finishedSection = screen.getByTestId('task-mode-finished-section');
    const toggleBtn = screen.getByTestId('task-mode-finished-toggle');
    const statsEl = screen.getByTestId('task-mode-24h-stats');
    expect(finishedSection.contains(statsEl)).toBe(true);
    expect(activeSection.contains(statsEl)).toBe(false);
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true');
    // Fallback client calculation across 4 windows:
    // h24: t-done-1 (60s) + t-done-2 (120s) -> 2, avg 1m 30s (1m30s)
    // h48/w1/m1: + t-old-done (4h) -> 3, avg (60 + 120 + 14400)/3 = 4860s = 1h21m
    expect(screen.getByTestId('task-mode-stat-h24').textContent).toBe('24h 2·1m30s');
    expect(screen.getByTestId('task-mode-stat-h48').textContent).toBe('· 48h 3·1h21m');
    expect(screen.getByTestId('task-mode-stat-w1').textContent).toBe('· 1w 3·1h21m');
    expect(screen.getByTestId('task-mode-stat-m1').textContent).toBe('· 1m 3·1h21m');

    // Remains visible inline in the header row when finished section is collapsed
    fireEvent.click(toggleBtn);
    expect(screen.getByTestId('task-mode-finished-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('task-mode-stat-h24').textContent).toBe('24h 2·1m30s');

    // Server-provided snapshot.stats overrides client 48h fallback for accurate 1w/1m metrics
    await act(async () => {
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
        ts: nowMs,
        servers: [{ id: 'srv-1', name: 'M3-Mac', online: true }],
        brains: [],
        stats: {
          h24: { completedCount: 5, avgDurationMs: 240_000 },
          h48: { completedCount: 12, avgDurationMs: 360_000 },
          w1: { completedCount: 30, avgDurationMs: 480_000 },
          m1: { completedCount: 90, avgDurationMs: 540_000 },
        },
        tasks: [
          {
            serverId: 'srv-1',
            serverName: 'M3-Mac',
            serverOnline: true,
            projectName: 'imcodes',
            brainSession: 'deck_imcodes_brain',
            brainLabel: 'IM Brain',
            taskId: 't-done-1',
            title: 'Recent done',
            status: 'done',
            flags: [],
            round: 1,
            checklist: { total: 1, implemented: 1, audited: 1 },
            createdAt: nowMs - 60_000,
            updatedAt: nowMs - 10_000,
            isTerminal: true,
            needsAttention: false,
          },
        ],
      });
    });
    expect(screen.getByTestId('task-mode-stat-h24').textContent).toBe('24h 5·4m');
    expect(screen.getByTestId('task-mode-stat-h48').textContent).toBe('· 48h 12·6m');
    expect(screen.getByTestId('task-mode-stat-w1').textContent).toBe('· 1w 30·8m');
    expect(screen.getByTestId('task-mode-stat-m1').textContent).toBe('· 1m 90·9m');

    // Showing only cancelled-or-old leaves compact 0 counts without NaN/avg
    await act(async () => {
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
        ts: nowMs,
        servers: [{ id: 'srv-1', name: 'M3-Mac', online: true }],
        brains: [],
        tasks: [
          {
            serverId: 'srv-1',
            serverName: 'M3-Mac',
            serverOnline: true,
            projectName: 'imcodes',
            brainSession: 'deck_imcodes_brain',
            brainLabel: 'IM Brain',
            taskId: 't-cancelled-only',
            title: 'Cancelled only',
            status: 'cancelled',
            flags: [],
            round: 1,
            checklist: { total: 1, implemented: 0, audited: 0 },
            createdAt: nowMs - 60_000,
            updatedAt: nowMs - 10_000,
            isTerminal: true,
            needsAttention: false,
          },
        ],
      });
    });
    expect(screen.getByTestId('task-mode-stat-h24').textContent).toBe('24h 0');
    expect(screen.getByTestId('task-mode-stat-h48').textContent).toBe('· 48h 0');
    expect(screen.getByTestId('task-mode-stat-w1').textContent).toBe('· 1w 0');
    expect(screen.getByTestId('task-mode-stat-m1').textContent).toBe('· 1m 0');
  });

  it('renders compact last-2-segment executor and auditor models inline in card meta with full hover titles and none/missing guards', async () => {
    const { formatTaskCardModels, GlobalTaskModeView } = await import('../../src/components/GlobalTaskModeView.js');

    expect(formatTaskCardModels('claude-opus-4-6-high', 'gpt-6.2-sol', 'deck_sub_aud')).toEqual({
      label: 'opus-4.6 / 6.2-sol',
      title: 'claude-opus-4-6-high / gpt-6.2-sol',
    });
    expect(formatTaskCardModels('sonnet', 'o3', 'deck_sub_aud')).toEqual({
      label: 'sonnet / o3',
      title: 'sonnet / o3',
    });
    expect(formatTaskCardModels('gpt-5.4-mini', 'none', 'none')).toEqual({
      label: '5.4-mini',
      title: 'gpt-5.4-mini',
    });
    expect(formatTaskCardModels('gpt-5.4-mini', '__none__', '__none__')).toEqual({
      label: '5.4-mini',
      title: 'gpt-5.4-mini',
    });
    expect(formatTaskCardModels(undefined, '__none__', '__none__')).toBeNull();
    expect(formatTaskCardModels(undefined, undefined, undefined)).toBeNull();

    const nowMs = Date.now();
    render(<GlobalTaskModeView onExit={vi.fn()} onJumpToSession={vi.fn()} />);
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.instances[0]!;

    await act(async () => {
      ws.simulateOpen();
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
        ts: nowMs,
        servers: [{ id: 'srv-1', name: 'M3-Mac', online: true }],
        brains: [],
        tasks: [
          {
            serverId: 'srv-1',
            serverName: 'M3-Mac',
            serverOnline: true,
            projectName: 'imcodes',
            brainSession: 'deck_imcodes_brain',
            brainLabel: 'IM Brain',
            taskId: 't-both-models',
            title: 'Pair with both models',
            status: 'working',
            flags: [],
            round: 2,
            checklist: { total: 2, implemented: 1, audited: 0 },
            executorModel: 'claude-opus-4-6-high',
            auditorModel: 'gpt-6.2-sol',
            auditor: 'deck_sub_aud',
            createdAt: nowMs - 10_000,
            updatedAt: nowMs - 1_000,
            isTerminal: false,
            needsAttention: false,
          },
          {
            serverId: 'srv-1',
            serverName: 'M3-Mac',
            serverOnline: true,
            projectName: 'imcodes',
            brainSession: 'deck_imcodes_brain',
            brainLabel: 'IM Brain',
            taskId: 't-short-models',
            title: 'Pair with short models',
            status: 'in_audit',
            flags: [],
            round: 1,
            checklist: { total: 1, implemented: 1, audited: 0 },
            executorModel: 'sonnet',
            auditorModel: 'o3',
            auditor: 'deck_sub_aud',
            createdAt: nowMs - 20_000,
            updatedAt: nowMs - 2_000,
            isTerminal: false,
            needsAttention: false,
          },
          {
            serverId: 'srv-1',
            serverName: 'M3-Mac',
            serverOnline: true,
            projectName: 'imcodes',
            brainSession: 'deck_imcodes_brain',
            brainLabel: 'IM Brain',
            taskId: 't-no-auditor',
            title: 'No auditor task',
            status: 'working',
            flags: [],
            round: 0,
            checklist: { total: 0, implemented: 0, audited: 0 },
            executorModel: 'gpt-5.4-mini',
            auditorModel: '__none__',
            auditor: '__none__',
            createdAt: nowMs - 30_000,
            updatedAt: nowMs - 3_000,
            isTerminal: false,
            needsAttention: false,
          },
          {
            serverId: 'srv-1',
            serverName: 'M3-Mac',
            serverOnline: true,
            projectName: 'imcodes',
            brainSession: 'deck_imcodes_brain',
            brainLabel: 'IM Brain',
            taskId: 't-no-models',
            title: 'Legacy task without models',
            status: 'queued',
            flags: [],
            round: 0,
            checklist: { total: 0, implemented: 0, audited: 0 },
            createdAt: nowMs - 40_000,
            updatedAt: nowMs - 4_000,
            isTerminal: false,
            needsAttention: false,
          },
        ],
      });
    });

    const bothEl = screen.getByTestId('task-mode-models-t-both-models');
    expect(bothEl.textContent).toBe('opus-4.6 / 6.2-sol');
    expect(bothEl.getAttribute('title')).toBe('claude-opus-4-6-high / gpt-6.2-sol');
    expect(screen.getByTestId('task-mode-card-t-both-models').querySelector('.global-task-card-meta')?.contains(bothEl)).toBe(true);

    const shortEl = screen.getByTestId('task-mode-models-t-short-models');
    expect(shortEl.textContent).toBe('sonnet / o3');
    expect(shortEl.getAttribute('title')).toBe('sonnet / o3');

    const noAudEl = screen.getByTestId('task-mode-models-t-no-auditor');
    expect(noAudEl.textContent).toBe('5.4-mini');
    expect(noAudEl.getAttribute('title')).toBe('gpt-5.4-mini');

    expect(screen.queryByTestId('task-mode-models-t-no-models')).toBeNull();
  });

  it('toggles TTS quick settings popover cleanly above Task Mode and switches cleanly with server filter dropdown', async () => {
    await mountWithSnapshot();

    const ttsBtn = screen.getByTestId('task-mode-tts-settings-btn');
    const filterBtn = screen.getByTestId('task-mode-server-filter-btn');

    // Opening TTS settings portals popover into document.body
    fireEvent.click(ttsBtn);
    const popover = screen.getByTestId('chat-tts-settings-popover');
    expect(popover).toBeTruthy();
    expect(document.body.contains(popover)).toBe(true);
    expect(ttsBtn.getAttribute('aria-expanded')).toBe('true');

    // Clicking server filter opens menu and closes TTS settings popover via outside pointerdown
    fireEvent.pointerDown(filterBtn, { bubbles: true });
    fireEvent.click(filterBtn);
    expect(screen.getByTestId('task-mode-server-filter-menu')).toBeTruthy();
    expect(screen.queryByTestId('chat-tts-settings-popover')).toBeNull();
    expect(filterBtn.getAttribute('aria-expanded')).toBe('true');

    // Clicking TTS settings while server menu is open closes server menu and opens popover
    fireEvent.pointerDown(ttsBtn, { bubbles: true });
    fireEvent.click(ttsBtn);
    expect(screen.getByTestId('chat-tts-settings-popover')).toBeTruthy();
    expect(screen.queryByTestId('task-mode-server-filter-menu')).toBeNull();

    // Clicking TTS settings again closes popover cleanly
    fireEvent.pointerDown(ttsBtn, { bubbles: true });
    fireEvent.click(ttsBtn);
    expect(screen.queryByTestId('chat-tts-settings-popover')).toBeNull();
    expect(ttsBtn.getAttribute('aria-expanded')).toBe('false');
  });

  it('enlarges desktop active cards via @media (min-width: 721px), exposes running-only metadata without duplication on expand, and keeps mobile <= 720px unchanged', async () => {
    const { GlobalTaskModeView } = await import('../../src/components/GlobalTaskModeView.js');
    const onJumpToSession = vi.fn();
    render(<GlobalTaskModeView onExit={vi.fn()} onJumpToSession={onJumpToSession} />);
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.instances[0]!;
    const now = Date.now();

    await act(async () => {
      ws.simulateOpen();
      ws.simulateMessage({
        type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
        ts: now,
        servers: [{ id: 'srv-1', name: 'M3-Ultra-Workstation', online: true }],
        brains: [],
        tasks: [
          {
            serverId: 'srv-1',
            serverName: 'M3-Ultra-Workstation',
            serverOnline: true,
            projectName: 'imcodes-core',
            brainSession: 'deck_cd_brain',
            brainLabel: 'MainBrain',
            taskId: 'tsk_run_dense',
            title: 'Unwrapped very long desktop active task title that must remain completely readable without truncation',
            status: 'working',
            flags: ['blocked'],
            round: 2,
            checklist: { total: 4, implemented: 2, audited: 1 },
            executor: 'deck_sub_exec',
            executorLabel: 'CxExec',
            auditor: 'deck_sub_aud',
            auditorLabel: 'SolAud',
            executorModel: 'gpt-6.2-codex',
            auditorModel: 'gpt-6.2-sol',
            createdAt: now - 120_000,
            updatedAt: now - 15_000,
            isTerminal: false,
            needsAttention: true,
          },
          {
            serverId: 'srv-1',
            serverName: 'M3-Ultra-Workstation',
            serverOnline: true,
            projectName: 'imcodes-core',
            brainSession: 'deck_cd_brain',
            brainLabel: 'MainBrain',
            taskId: 'tsk_term_compact',
            title: 'Finished task remains compact',
            status: 'done',
            flags: ['needs_input'],
            round: 1,
            checklist: { total: 2, implemented: 2, audited: 2 },
            executorLabel: 'CxExec',
            auditorLabel: 'SolAud',
            createdAt: now - 300_000,
            updatedAt: now - 60_000,
            isTerminal: true,
            needsAttention: false,
          },
        ],
      });
    });

    const activeSection = screen.getByTestId('task-mode-active-section');
    const activeGrid = activeSection.querySelector('.global-task-mode-grid');
    expect(activeGrid?.className).toContain('is-active-grid');

    // Recent finished section renders expanded by default with finished grid class and no running meta strip on terminal cards
    const finishedSection = screen.getByTestId('task-mode-finished-section');
    const finishedGrid = finishedSection.querySelector('.global-task-mode-grid');
    expect(finishedGrid?.className).toContain('is-finished-grid');
    expect(screen.queryByTestId('task-mode-running-meta-tsk_term_compact')).toBeNull();

    // Active running card surfaces executor, auditor, project (!= brainLabel), relative time, inline action buttons, and flag chips before expand
    const runningMeta = screen.getByTestId('task-mode-running-meta-tsk_run_dense');
    expect(runningMeta.textContent).toContain('Executor: CxExec');
    expect(runningMeta.textContent).toContain('Auditor: SolAud');
    expect(runningMeta.textContent).toContain('Project: imcodes-core');
    expect(runningMeta.textContent).toContain('Blocked');
    expect(runningMeta.textContent).toMatch(/\d{1,2}:\d{2}/);
    expect(screen.queryByTestId('task-mode-details-tsk_run_dense')).toBeNull();

    const runningBar = runningMeta.querySelector('.global-task-desktop-running-bar');
    expect(runningBar).not.toBeNull();
    expect(runningBar?.querySelector('.global-task-desktop-running-row')).not.toBeNull();
    const runningBriefBtn = screen.getByTestId('task-mode-running-brief-tsk_run_dense');
    const runningJumpBtn = screen.getByTestId('task-mode-running-jump-tsk_run_dense');
    expect(runningBriefBtn.closest('.global-task-desktop-running-actions')?.parentElement).toBe(runningBar);
    expect(runningJumpBtn.closest('.global-task-desktop-running-actions')?.parentElement).toBe(runningBar);
    expect(runningBriefBtn.className).toContain('is-compact');
    expect(runningJumpBtn.className).toContain('is-compact');
    expect(screen.queryByTestId('task-mode-running-brief-tsk_term_compact')).toBeNull();
    expect(screen.queryByTestId('task-mode-running-jump-tsk_term_compact')).toBeNull();

    // Clicking desktop inline buttons opens brief modal or jumps to session without expanding the card
    fireEvent.click(runningBriefBtn);
    expect(screen.getByTestId('global-task-brief-hud')).toBeTruthy();
    expect(screen.queryByTestId('task-mode-details-tsk_run_dense')).toBeNull();
    fireEvent.click(screen.getByTestId('global-task-brief-hud-close'));
    expect(screen.queryByTestId('global-task-brief-hud')).toBeNull();

    fireEvent.click(runningJumpBtn);
    expect(onJumpToSession).toHaveBeenCalledWith('srv-1', 'deck_cd_brain', {
      taskId: 'tsk_run_dense',
      title: 'Unwrapped very long desktop active task title that must remain completely readable without truncation',
      status: 'working',
    });
    expect(screen.queryByTestId('task-mode-details-tsk_run_dense')).toBeNull();

    // Clicking active card expands full details and hides running-meta strip so rows/actions/flags are never duplicated
    fireEvent.click(screen.getByTestId('task-mode-card-tsk_run_dense'));
    expect(screen.queryByTestId('task-mode-running-meta-tsk_run_dense')).toBeNull();
    expect(screen.queryByTestId('task-mode-running-brief-tsk_run_dense')).toBeNull();
    expect(screen.queryByTestId('task-mode-running-jump-tsk_run_dense')).toBeNull();
    const details = screen.getByTestId('task-mode-details-tsk_run_dense');
    expect(details.textContent).toContain('Executor: CxExec');
    expect(details.textContent).toContain('Auditor: SolAud');
    expect(screen.getByTestId('task-mode-detail-brief-tsk_run_dense')).toBeTruthy();
    expect(screen.getByTestId('task-mode-jump-tsk_run_dense')).toBeTruthy();

    // CSS contract: desktop overrides strictly scoped to @media (min-width: 721px), mobile @media (max-width: 720px) unchanged
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve(process.cwd().endsWith('/web') ? process.cwd() : resolve(process.cwd(), 'web'), 'src/styles.css'), 'utf8');
    expect(css).toMatch(/\.global-task-desktop-running-meta\s*\{\s*display:\s*none;\s*\}/s);
    const desktopStart = css.indexOf('@media (min-width: 721px)');
    const mobileStart = css.lastIndexOf('@media (max-width: 720px)');
    expect(desktopStart).toBeGreaterThan(-1);
    expect(mobileStart).toBeGreaterThan(desktopStart);
    const desktopBlock = css.slice(desktopStart, mobileStart);
    expect(desktopBlock).toMatch(/\.global-task-mode-grid\.is-active-grid\s*\{[^}]*minmax\(min\(460px,\s*100%\),\s*1fr\)/s);
    expect(desktopBlock).toMatch(/\.global-task-mode-grid\.is-finished-grid\s*\{[^}]*minmax\(min\(380px,\s*100%\),\s*1fr\)/s);
    expect(desktopBlock).toMatch(/\.global-task-card-meta\s*\{[^}]*flex-wrap:\s*wrap;[^}]*overflow:\s*visible;/s);
    expect(desktopBlock).toMatch(/\.global-task-card:not\(\.is-terminal\)\s+\.global-task-card-title\s*\{[^}]*-webkit-line-clamp:\s*unset;[^}]*overflow:\s*visible;/s);
    expect(desktopBlock).toMatch(/\.global-task-card:not\(\.is-terminal\)\s+\.global-task-live-summary\s*\{[^}]*-webkit-line-clamp:\s*3;/s);
    expect(desktopBlock).toMatch(/\.global-task-card:not\(\.is-terminal\)\s+\.global-task-brain-preview-text\s*\{[^}]*-webkit-line-clamp:\s*3;/s);
    expect(desktopBlock).toMatch(/\.global-task-desktop-running-meta\s*\{[^}]*display:\s*flex;/s);
    expect(desktopBlock).toMatch(/\.global-task-desktop-running-bar\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*space-between;/s);
    expect(desktopBlock).toMatch(/\.global-task-desktop-running-actions\s*\{[^}]*display:\s*inline-flex;/s);
    expect(desktopBlock).toMatch(/\.global-task-card\s+\.global-task-brief-detail-btn\.is-compact,\s*\.global-task-card\s+\.global-task-jump-btn\.is-compact\s*\{[^}]*white-space:\s*nowrap;/s);
  });
});
