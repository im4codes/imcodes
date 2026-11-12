/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (
      key === 'subsessionBar.subs_count' ? `${vars?.count ?? 0}` : key
    ),
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../src/components/ChatView.js', () => ({
  ChatView: () => <div data-testid="mock-chat-view">chat preview</div>,
}));

vi.mock('../../src/components/TerminalView.js', () => ({
  TerminalView: () => <div data-testid="mock-terminal-view">term preview</div>,
}));

vi.mock('../../src/components/FileBrowser.js', () => ({
  FileBrowser: () => null,
}));

vi.mock('../../src/components/UsageFooter.js', () => ({
  UsageFooter: () => null,
}));

vi.mock('../../src/components/P2pProgressCard.js', () => ({
  P2pProgressCard: () => null,
}));

vi.mock('../../src/components/IdleFlashLayer.js', () => ({
  IdleFlashLayer: () => null,
}));

vi.mock('../../src/components/EmbeddingStatusIcon.js', () => ({
  EmbeddingStatusIcon: () => null,
}));

vi.mock('../../src/components/VoiceOverlay.js', () => ({
  VoiceOverlay: () => null,
}));

vi.mock('../../src/components/VoiceInput.js', () => ({
  isAvailable: () => false,
  startListening: vi.fn(),
  stopListening: vi.fn(),
  onAudioLevel: vi.fn(),
}));

vi.mock('../../src/components/AtPicker.js', () => ({
  AtPicker: () => null,
}));

vi.mock('../../src/components/P2pConfigPanel.js', () => ({
  P2pConfigPanel: () => null,
}));

vi.mock('../../src/components/p2p-combos.js', () => ({
  useP2pCustomCombos: () => ({ allCombos: { presets: [], custom: [] } }),
}));

vi.mock('../../src/hooks/useSwipeBack.js', () => ({
  useSwipeBack: () => ({ current: null }),
}));

vi.mock('../../src/hooks/useMachines.js', () => ({
  useMachines: () => ({
    machines: [],
    filtered: [],
    loaded: true,
    loading: false,
    error: null,
    stale: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('../../src/hooks/useTimeline.js', () => ({
  requestActiveTimelineRefreshAfterUserAction: vi.fn(),
  useTimeline: () => ({
    events: [{ eventId: 'evt-1', type: 'assistant.text', ts: 100, payload: { text: 'hello' } }],
    refreshing: false,
    historyStatus: 'idle',
    addOptimisticUserMessage: vi.fn(),
    markOptimisticFailed: vi.fn(),
    removeOptimisticMessage: vi.fn(),
    retryOptimisticMessage: vi.fn(),
    forceRefresh: vi.fn(),
    loadingOlder: false,
    hasOlderHistory: false,
    loadOlderEvents: vi.fn(),
    historyGap: null,
    loadMessageContext: vi.fn(),
  }),
}));

vi.mock('../../src/api.js', () => ({
  reorderSubSessions: vi.fn().mockResolvedValue(undefined),
  uploadFile: vi.fn(),
  deleteAttachment: vi.fn().mockResolvedValue(undefined),
  fetchSessionSupervisorDefaults: vi.fn().mockResolvedValue(null),
  saveSessionSupervisorDefaults: vi.fn().mockResolvedValue({}),
  getUserPref: vi.fn().mockResolvedValue(null),
  saveUserPref: vi.fn().mockResolvedValue(undefined),
  onUserPrefChanged: vi.fn(() => () => {}),
  apiFetch: vi.fn().mockResolvedValue({ data: { history: [], sessionHistory: {}, commands: [], phrases: [] } }),
}));

import { SubSessionBar } from '../../src/components/SubSessionBar.js';
import { SubSessionWindow } from '../../src/components/SubSessionWindow.js';
import {
  isMobileKeyboardInputTarget,
  isSubSessionBarInputTarget,
  shouldSuppressSubSessionBarForKeyboard,
} from '../../src/mobile-keyboard.js';
import type { SubSession } from '../../src/hooks/useSubSessions.js';

function makeSub(overrides: Partial<SubSession> = {}): SubSession {
  return {
    id: 'sub-ime-1',
    serverId: 'srv-1',
    type: 'codex-sdk',
    runtimeType: 'transport',
    shellBin: null,
    cwd: '/tmp/proj',
    label: 'worker',
    ccSessionId: null,
    geminiSessionId: null,
    parentSession: 'deck_proj_brain',
    ccPresetId: null,
    sessionName: 'deck_sub_sub-ime-1',
    state: 'idle',
    ...overrides,
  };
}

const makeQuickData = () => ({
  data: { history: [], sessionHistory: {}, commands: [], phrases: [] },
  loaded: true,
  recordHistory: vi.fn(),
  addCommand: vi.fn(),
  addPhrase: vi.fn(),
  removeCommand: vi.fn(),
  removePhrase: vi.fn(),
  removeHistory: vi.fn(),
  removeSessionHistory: vi.fn(),
  clearHistory: vi.fn(),
  clearSessionHistory: vi.fn(),
});

function makeWsStub(): any {
  return {
    sendSessionCommand: vi.fn(),
    send: vi.fn(),
    subscribeTerminal: vi.fn(),
    fsGitStatus: vi.fn(() => 'git-req-1'),
    onMessage: () => () => {},
    getDaemonCapabilitySnapshot: () => null,
    onDaemonCapabilitySnapshot: () => () => {},
  };
}

function firePointer(target: Element, type: string, pointerType = 'touch'): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerType', { configurable: true, value: pointerType });
  fireEvent(target, event);
}

describe('SubSessionCard / SubSessionBar / SubSessionWindow input, gesture isolation & simulated IME', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
  });

  afterEach(() => {
    cleanup();
    document.documentElement.className = '';
    vi.restoreAllMocks();
  });

  it('isolates touch, click, dblclick, and drag inside .subcard-input-area while keeping blank card open/close intact', () => {
    const onOpen = vi.fn();
    const onFocus = vi.fn();
    const onOpenMaximized = vi.fn();
    const onMaximize = vi.fn();
    const onRestore = vi.fn();
    const onVisualOrderChange = vi.fn();

    const subTransport = makeSub({ id: 'sub-tr', sessionName: 'deck_sub_sub-tr', label: 'transport-card' });
    const subFallback = makeSub({
      id: 'sub-fb',
      sessionName: 'deck_sub_sub-fb',
      label: 'shell-card',
      type: 'shell',
      runtimeType: 'process',
    });

    const { container } = render(
      <SubSessionBar
        subSessions={[subTransport, subFallback]}
        openIds={new Set(['sub-tr'])}
        collapsed={false}
        desktopLayoutCapable={true}
        onOpen={onOpen}
        onFocus={onFocus}
        onOpenMaximized={onOpenMaximized}
        onMaximize={onMaximize}
        onRestore={onRestore}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onVisualOrderChange={onVisualOrderChange}
        ws={makeWsStub()}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
        quickData={makeQuickData() as any}
      />,
    );

    const wraps = Array.from(container.querySelectorAll('.subcard-drag-wrap')) as HTMLDivElement[];
    const inputAreas = Array.from(container.querySelectorAll('.subcard-input-area')) as HTMLDivElement[];
    const composer = container.querySelector('.subcard-input-area [contenteditable="true"].controls-input') as HTMLElement;

    expect(wraps.length).toBe(2);
    expect(composer).toBeTruthy();
    expect(inputAreas[0].getAttribute('draggable')).toBe('false');

    // Touch / click / dblclick / pointerdown on compact SessionControls composer & input area wrapper
    for (const target of [inputAreas[0], composer, inputAreas[1]]) {
      firePointer(target, 'pointerdown', 'touch');
      fireEvent.touchStart(target, { touches: [{ clientX: 20, clientY: 20 }] });
      fireEvent.touchMove(target, { touches: [{ clientX: 21, clientY: 20 }] });
      fireEvent.touchEnd(target);
      firePointer(target, 'pointerdown', 'mouse');
      fireEvent.click(target);
      fireEvent.dblClick(target);
    }

    expect(onOpen).not.toHaveBeenCalled();
    expect(onFocus).not.toHaveBeenCalled();
    expect(onOpenMaximized).not.toHaveBeenCalled();
    expect(onMaximize).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();

    // Drag initiation inside .subcard-input-area disables wrap draggable and prevents HTML5 dragStart
    onVisualOrderChange.mockClear();
    firePointer(composer, 'pointerdown', 'mouse');
    fireEvent.mouseDown(composer);
    expect(wraps[0].draggable).toBe(false);
    const dragEvent = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(dragEvent, 'dataTransfer', { configurable: true, value: { effectAllowed: '' } });
    fireEvent(composer, dragEvent);
    expect(dragEvent.defaultPrevented).toBe(true);
    firePointer(wraps[0], 'pointerup', 'mouse');
    fireEvent.mouseUp(wraps[0]);
    expect(wraps[0].draggable).toBe(true);
    expect(onVisualOrderChange).not.toHaveBeenCalled();

    // Simulated IME composition in card compact composer preserves focus & content without toggling/closing
    composer.focus();
    expect(document.activeElement).toBe(composer);
    expect(isMobileKeyboardInputTarget(composer)).toBe(true);
    expect(isSubSessionBarInputTarget(composer)).toBe(true);
    document.documentElement.classList.add('input-focused', 'kb-open', 'subcard-input-focused');
    expect(shouldSuppressSubSessionBarForKeyboard(document)).toBe(false);

    fireEvent(composer, new Event('compositionstart', { bubbles: true }));
    composer.textContent = 'nihao';
    fireEvent(composer, new Event('compositionupdate', { bubbles: true }));
    composer.textContent = '你好';
    fireEvent(composer, new Event('compositionend', { bubbles: true }));
    expect(document.activeElement).toBe(composer);
    expect(onOpen).not.toHaveBeenCalled();

    // Positive control: tapping/clicking blank card preview area preserves open/close toggle semantics
    const previewBlank = container.querySelectorAll('.subcard-preview')[1] as HTMLElement;
    firePointer(previewBlank, 'pointerdown', 'touch');
    fireEvent.touchStart(previewBlank, { touches: [{ clientX: 20, clientY: 20 }] });
    fireEvent.touchEnd(previewBlank);
    expect(onOpen).toHaveBeenCalledWith('sub-fb');

    // Fallback <input class="subcard-input"> inside .subcard-input-area (when quickData is absent)
    cleanup();
    const fallbackOpen = vi.fn();
    const fallbackView = render(
      <SubSessionBar
        subSessions={[subFallback]}
        openIds={new Set()}
        collapsed={false}
        desktopLayoutCapable={false}
        onOpen={fallbackOpen}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        ws={makeWsStub()}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );
    const fallbackInput = fallbackView.container.querySelector('.subcard-input-area input.subcard-input') as HTMLInputElement;
    expect(fallbackInput).toBeTruthy();
    const fallbackWrap = fallbackView.container.querySelector('.subcard-drag-wrap') as HTMLDivElement;
    expect(fallbackWrap.draggable).toBe(false);
    firePointer(fallbackInput, 'pointerdown', 'touch');
    fireEvent.touchStart(fallbackInput, { touches: [{ clientX: 20, clientY: 20 }] });
    fireEvent.touchEnd(fallbackInput);
    fireEvent.click(fallbackInput);
    fireEvent.dblClick(fallbackInput);
    fallbackInput.focus();
    expect(document.activeElement).toBe(fallbackInput);
    expect(isSubSessionBarInputTarget(fallbackInput)).toBe(true);
    expect(fallbackOpen).not.toHaveBeenCalled();
  });

  it('keeps SubSessionWindow composer focused with simulated IME while yielding .subcard-bar on mobile', async () => {
    const onMinimize = vi.fn();
    const onClose = vi.fn();
    const sub = makeSub({ id: 'sub-win', sessionName: 'deck_sub_sub-win', label: 'window-worker' });

    const { container } = render(
      <div>
        <div class="subcard-bar" />
        <SubSessionWindow
          sub={sub}
          ws={makeWsStub()}
          connected={true}
          active={true}
          visible={true}
          onDiff={vi.fn()}
          onHistory={vi.fn()}
          onMinimize={onMinimize}
          onClose={onClose}
          onRestart={vi.fn()}
          onRename={vi.fn()}
          onFocus={vi.fn()}
          serverId="srv-1"
          zIndex={100}
        />
      </div>,
    );

    const composer = container.querySelector('.subsession-window [contenteditable="true"].controls-input') as HTMLElement;
    expect(composer).toBeTruthy();

    composer.focus();
    expect(document.activeElement).toBe(composer);
    expect(isMobileKeyboardInputTarget(composer)).toBe(true);
    expect(isSubSessionBarInputTarget(composer)).toBe(false);

    // Focusing SubSessionWindow input triggers .input-focused / .kb-open WITHOUT .subcard-input-focused
    document.documentElement.classList.add('input-focused', 'kb-open');
    expect(shouldSuppressSubSessionBarForKeyboard(document)).toBe(true);

    // Simulated IME composition in SubSessionWindow composer stays focused and never auto-closes
    fireEvent(composer, new Event('compositionstart', { bubbles: true }));
    composer.textContent = 'ceshi';
    fireEvent(composer, new Event('compositionupdate', { bubbles: true }));
    composer.textContent = '测试';
    fireEvent(composer, new Event('compositionend', { bubbles: true }));

    await waitFor(() => {
      expect(document.activeElement).toBe(composer);
    });
    expect(onMinimize).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
