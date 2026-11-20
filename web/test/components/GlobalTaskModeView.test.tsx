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
import { clearGlobalTaskModeSessionState } from '../../src/global-task-mode-store.js';
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
            createdAt: 50,
            updatedAt: 200,
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

    // Expand card details & jump to original session
    fireEvent.click(screen.getByTestId('task-mode-card-tsk_pair_1'));
    expect(screen.getByTestId('task-mode-details-tsk_pair_1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('task-mode-jump-tsk_pair_1'));
    expect(onJumpToSession).toHaveBeenCalledWith('srv-1', 'deck_imcodes_brain');

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

    // Pin IM Brain in quick bar
    const pinBtn = screen.getByTestId('task-mode-brain-pin-srv-1-deck_imcodes_brain');
    expect(pinBtn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(pinBtn);
    expect(pinBtn.getAttribute('aria-pressed')).toBe('true');

    // + Add / Dispatch modal sends raw instruction (no task title prefix)
    fireEvent.click(screen.getByTestId('task-mode-add-brain-btn'));
    fireEvent.input(screen.getByTestId('task-mode-add-input'), { target: { value: 'Start audit cleanup' } });
    fireEvent.click(screen.getByTestId('task-mode-add-submit-btn'));

    await waitFor(() => {
      const sendCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/api/server/srv-1/session/send'));
      expect(sendCall).toBeDefined();
      const body = JSON.parse(String((sendCall![1] as RequestInit).body));
      expect(body.sessionName).toBe('deck_imcodes_brain');
      expect(body.text).toBe('Start audit cleanup');
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
          ts: 20_000,
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
          ts: 20_000,
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
          ts: 20_100,
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
          updatedAt: 25_000,
          isTerminal: false,
          needsAttention: false,
        },
      });
    });

    expect(spokenUtterances).toHaveLength(2);
    expect(spokenUtterances[1]!.text).toContain('Build Global View');

    // Manual speak button stops/reads on click
    fireEvent.click(screen.getByTestId('task-mode-speak-tsk_pair_1'));
    expect(spokenUtterances.length).toBeGreaterThanOrEqual(3);

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
});
