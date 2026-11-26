/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en', resolvedLanguage: 'en' },
    t: (key: string) => key,
  }),
}));

vi.mock('../../src/components/FileEditor.js', () => ({
  FileEditor: () => null,
  FileEditorContent: () => null,
}));
vi.mock('../../src/components/file-editor-lazy.js', () => ({
  FileEditor: () => null,
  FileEditorContent: () => null,
}));
vi.mock('../../src/components/FilePreviewPane.js', () => ({
  default: () => null,
}));
vi.mock('../../src/components/TerminalView.js', () => ({
  TerminalView: () => null,
}));
vi.mock('../../src/components/ChatView.js', () => ({
  ChatView: () => null,
}));
vi.mock('../../src/components/VoiceInput.js', () => ({
  isAvailable: () => false,
}));
vi.mock('../../src/hooks/useSwipeBack.js', () => ({
  useSwipeBack: () => ({ current: null }),
}));
vi.mock('../../src/hooks/useTimeline.js', () => ({
  requestActiveTimelineRefreshAfterUserAction: vi.fn(),
  useTimeline: () => ({
    events: [],
    refreshing: false,
    addOptimisticUserMessage: vi.fn(),
    markOptimisticFailed: vi.fn(),
    retryOptimisticMessage: vi.fn(),
    loadingOlder: false,
    hasOlderHistory: false,
    loadOlderEvents: vi.fn(),
  }),
}));
vi.mock('../../src/components/QuickInputPanel.js', () => ({
  QuickInputPanel: () => null,
  useQuickData: () => ({
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
  }),
}));
vi.mock('../../src/git-status-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/git-status-store.js')>();
  return {
    ...actual,
    useSharedGitChangesCount: () => 0,
    useSharedGitChanges: () => [],
  };
});

import { SubSessionWindow } from '../../src/components/SubSessionWindow.js';
import type { SubSession } from '../../src/hooks/useSubSessions.js';

function makeSubSession(overrides: Partial<SubSession> = {}): SubSession {
  return {
    id: 'sub-pin-1',
    serverId: 'srv-1',
    type: 'claude-code',
    runtimeType: 'process',
    shellBin: null,
    cwd: '/tmp/proj',
    ccSessionId: null,
    geminiSessionId: null,
    parentSession: 'deck_proj_brain',
    label: 'Worker 1',
    ccPresetId: null,
    sessionName: 'deck_sub_pin_1',
    state: 'idle',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('SubSessionWindow header pin-to-sidebar button', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders Pin to sidebar visibly outside .subsession-hidden-actions before Maximize and passes current viewMode', () => {
    const onPin = vi.fn();
    const { container } = render(
      <SubSessionWindow
        sub={makeSubSession()}
        ws={null}
        connected={true}
        active={true}
        serverId="srv-1"
        onDiff={vi.fn()}
        onHistory={vi.fn()}
        onMinimize={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onRename={vi.fn()}
        onFocus={vi.fn()}
        onPin={onPin}
        onToggleMaximized={vi.fn()}
      />,
    );

    const pinButton = screen.getByRole('button', { name: 'sidebar.pin_to_sidebar' });
    expect(pinButton.getAttribute('type')).toBe('button');
    expect(pinButton.getAttribute('title')).toBe('sidebar.pin_to_sidebar');
    expect(pinButton.getAttribute('aria-label')).toBe('sidebar.pin_to_sidebar');
    expect(pinButton.closest('.subsession-hidden-actions')).toBeNull();
    expect(pinButton.hasAttribute('hidden')).toBe(false);
    expect(getComputedStyle(pinButton).display).not.toBe('none');

    // Placed right before desktop Maximize button inside the right action bar.
    const maximizeButton = screen.getByRole('button', { name: 'window.maximize' });
    expect(pinButton.nextElementSibling).toBe(maximizeButton);

    fireEvent.click(pinButton);
    expect(onPin).toHaveBeenCalledTimes(1);
    expect(onPin).toHaveBeenLastCalledWith('chat');

    // Toggle to terminal mode and click Pin again -> passes 'terminal'.
    const modeButton = container.querySelector('.subsession-mode-btn') as HTMLButtonElement;
    expect(modeButton).not.toBeNull();
    fireEvent.click(modeButton);
    fireEvent.click(pinButton);
    expect(onPin).toHaveBeenCalledTimes(2);
    expect(onPin).toHaveBeenLastCalledWith('terminal');
  });

  it('invokes onPin cleanly on an unfocused desktop sub-window without double invocation', () => {
    const onPin = vi.fn();
    const onFocus = vi.fn();
    render(
      <SubSessionWindow
        sub={makeSubSession({ id: 'sub-pin-unfocused' })}
        ws={null}
        connected={true}
        active={false}
        serverId="srv-1"
        onDiff={vi.fn()}
        onHistory={vi.fn()}
        onMinimize={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onRename={vi.fn()}
        onFocus={onFocus}
        onPin={onPin}
        onToggleMaximized={vi.fn()}
      />,
    );

    const pinButton = screen.getByRole('button', { name: 'sidebar.pin_to_sidebar' });
    fireEvent.mouseDown(pinButton);
    fireEvent.click(pinButton);
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onPin).toHaveBeenCalledTimes(1);
    expect(onPin).toHaveBeenCalledWith('chat');
  });

  it('omits Pin to sidebar when onPin is undefined and keeps hidden-actions and Minimize hidden', () => {
    const { container } = render(
      <SubSessionWindow
        sub={makeSubSession({ id: 'sub-pin-omitted' })}
        ws={null}
        connected={true}
        active={true}
        serverId="srv-1"
        onDiff={vi.fn()}
        onHistory={vi.fn()}
        onMinimize={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onRename={vi.fn()}
        onFocus={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'sidebar.pin_to_sidebar' })).toBeNull();

    const hiddenActions = container.querySelector('.subsession-hidden-actions') as HTMLElement | null;
    expect(hiddenActions).not.toBeNull();
    expect(hiddenActions?.hasAttribute('hidden')).toBe(true);
    expect(hiddenActions?.style.display).toBe('none');
    expect(hiddenActions?.querySelector('button[title="picker.files"]')).not.toBeNull();

    const minimizeButton = container.querySelector('button[title="window.minimize"]') as HTMLElement | null;
    expect(minimizeButton).not.toBeNull();
    expect(minimizeButton?.hasAttribute('hidden')).toBe(true);
    expect(minimizeButton?.style.display).toBe('none');
  });
});
