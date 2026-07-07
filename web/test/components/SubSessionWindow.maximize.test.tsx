/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../src/components/TerminalView.js', () => ({
  TerminalView: () => null,
}));

vi.mock('../../src/components/FileBrowser.js', () => ({
  FileBrowser: () => <div data-testid="file-browser-stub" />,
}));

vi.mock('../../src/components/ChatView.js', () => ({
  ChatView: () => null,
}));

vi.mock('../../src/components/SessionControls.js', () => ({
  SessionControls: (props: any) => (
    <button type="button" aria-label="stop-subsession" onClick={() => props.onSubStop?.()}>
      stop
    </button>
  ),
}));

vi.mock('../../src/components/UsageFooter.js', () => ({
  UsageFooter: () => null,
}));

vi.mock('../../src/thinking-utils.js', () => ({
  getActiveThinkingTs: () => null,
  getActiveStatusText: () => null,
  hasActiveToolCall: () => false,
  getTailSessionStateInfo: () => ({ state: null, ts: null }),
  getTailSessionState: () => null,
}));

vi.mock('../../src/hooks/useTimeline.js', () => ({
  requestActiveTimelineRefreshAfterUserAction: vi.fn(),
  useTimeline: () => ({
    events: [],
    refreshing: false,
    addOptimisticUserMessage: vi.fn(),
    markOptimisticFailed: vi.fn(),
    retryOptimisticMessage: vi.fn(),
  }),
}));

vi.mock('../../src/hooks/useSwipeBack.js', () => ({
  useSwipeBack: () => ({ current: null }),
}));

vi.mock('../../src/components/QuickInputPanel.js', () => ({
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
    useSharedGitChanges: () => [],
  };
});

const floatingPanelPropsSpy = vi.fn();

vi.mock('../../src/components/FloatingPanel.js', () => ({
  FloatingPanel: (props: any) => {
    floatingPanelPropsSpy(props);
    return (
      <div
        data-testid={`floating-panel-${props.id}`}
        data-maximized={props.maximized === true ? 'true' : 'false'}
        style={{ zIndex: props.zIndex }}
      >
        {props.children}
      </div>
    );
  },
}));

import { SubSessionWindow } from '../../src/components/SubSessionWindow.js';
import type { SubSession } from '../../src/hooks/useSubSessions.js';

function makeSubSession(overrides: Partial<SubSession> = {}): SubSession {
  return {
    id: 'sub-1',
    serverId: 'srv-1',
    type: 'claude-code-sdk',
    runtimeType: 'transport' as any,
    shellBin: null,
    cwd: '/tmp',
    ccSessionId: null,
    geminiSessionId: null,
    parentSession: 'deck_myapp_brain',
    label: 'worker',
    ccPresetId: null,
    sessionName: 'deck_sub_sub-1',
    state: 'running',
    ...overrides,
  };
}

const ws = {
  subscribeTerminal: vi.fn(),
  unsubscribeTerminal: vi.fn(),
  sendSnapshotRequest: vi.fn(),
  sendResize: vi.fn(),
} as any;

function renderWindow(props: Partial<Parameters<typeof SubSessionWindow>[0]> = {}) {
  return render(
    <SubSessionWindow
      sub={makeSubSession()}
      ws={ws}
      connected={true}
      active={true}
      onDiff={vi.fn()}
      onHistory={vi.fn()}
      onMinimize={vi.fn()}
      onClose={vi.fn()}
      onRestart={vi.fn()}
      onRename={vi.fn()}
      zIndex={5010}
      onFocus={vi.fn()}
      {...props}
    />,
  );
}

describe('SubSessionWindow maximize integration', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem('rcc_subsession_sub-1', JSON.stringify({
      geom: { x: 111, y: 122, w: 633, h: 444 },
      viewMode: 'chat',
    }));
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('places an accessible maximize control immediately before minimize', async () => {
    const onToggleMaximized = vi.fn();
    const { container } = renderWindow({ onToggleMaximized });

    const buttons = Array.from(container.querySelectorAll('.subsession-header button'));
    const maximize = screen.getByRole('button', { name: 'window.maximize' });
    const minimize = screen.getByRole('button', { name: 'window.minimize' });

    expect(maximize.getAttribute('title')).toBe('window.maximize');
    expect(buttons.indexOf(maximize as HTMLButtonElement)).toBe(buttons.indexOf(minimize as HTMLButtonElement) - 1);

    fireEvent.click(maximize);
    expect(onToggleMaximized).toHaveBeenCalledTimes(1);
  });

  it('does not expose maximize controls when desktop layout capability is disabled', async () => {
    renderWindow({ desktopLayoutCapable: false, onToggleMaximized: vi.fn() });

    expect(screen.queryByRole('button', { name: 'window.maximize' })).toBeNull();
  });

  it('uses workspace bounds while maximized and restores the normal geometry', async () => {
    const getMaximizeBounds = vi.fn(() => ({ x: 40, y: 72, w: 900, h: 640 }));
    const onToggleMaximized = vi.fn();
    const view = renderWindow({ maximized: false, onToggleMaximized, getMaximizeBounds });

    const panel = view.container.querySelector('.subsession-window') as HTMLElement;
    expect(panel.style.left).toBe('111px');
    expect(panel.style.top).toBe('122px');
    expect(panel.style.width).toBe('633px');
    expect(panel.style.height).toBe('444px');

    view.rerender(
      <SubSessionWindow
        sub={makeSubSession()}
        ws={ws}
        connected={true}
        active={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
        onMinimize={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onRename={vi.fn()}
        zIndex={5010}
        onFocus={vi.fn()}
        maximized={true}
        onToggleMaximized={onToggleMaximized}
        getMaximizeBounds={getMaximizeBounds}
      />,
    );

    expect(panel.style.left).toBe('40px');
    expect(panel.style.top).toBe('72px');
    expect(panel.style.width).toBe('900px');
    expect(panel.style.height).toBe('640px');
    expect(screen.getByRole('button', { name: 'window.restore' }).getAttribute('title')).toBe('window.restore');
    expect(screen.getByText('worker · claude-code-sdk')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'picker.files' })).toBeTruthy();

    view.rerender(
      <SubSessionWindow
        sub={makeSubSession()}
        ws={ws}
        connected={true}
        active={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
        onMinimize={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onRename={vi.fn()}
        zIndex={5010}
        onFocus={vi.fn()}
        maximized={false}
        onToggleMaximized={onToggleMaximized}
        getMaximizeBounds={getMaximizeBounds}
      />,
    );

    expect(panel.style.left).toBe('111px');
    expect(panel.style.top).toBe('122px');
    expect(panel.style.width).toBe('633px');
    expect(panel.style.height).toBe('444px');
  });

  it('can first paint as maximized for closed plus double-click handoff', async () => {
    const { container } = renderWindow({
      maximized: true,
      onToggleMaximized: vi.fn(),
      getMaximizeBounds: () => ({ x: 10, y: 20, w: 700, h: 500 }),
    });

    const panel = container.querySelector('.subsession-window') as HTMLElement;
    expect(panel.style.left).toBe('10px');
    expect(panel.style.top).toBe('20px');
    expect(panel.style.width).toBe('700px');
    expect(panel.style.height).toBe('500px');
  });

  it('clamps transient maximized bounds up to a sane visible workspace size', async () => {
    const { container } = renderWindow({
      maximized: true,
      onToggleMaximized: vi.fn(),
      getMaximizeBounds: () => ({ x: 10, y: 20, w: 700, h: 80 }),
    });

    const panel = container.querySelector('.subsession-window') as HTMLElement;
    expect(panel.style.left).toBe('10px');
    expect(panel.style.top).toBe('20px');
    expect(panel.style.width).toBe('700px');
    expect(panel.style.height).toBe('400px');
  });

  it('normalizes malformed stored geometry instead of rendering NaN styles', async () => {
    localStorage.setItem('rcc_subsession_sub-1', JSON.stringify({
      geom: { x: null, y: 'bad', w: Number.NaN, h: Infinity },
      viewMode: 'invalid',
    }));

    const { container } = renderWindow({ onToggleMaximized: vi.fn() });

    const panel = container.querySelector('.subsession-window') as HTMLElement;
    expect(panel.style.left).not.toContain('NaN');
    expect(panel.style.top).not.toContain('NaN');
    expect(panel.style.width).not.toContain('NaN');
    expect(panel.style.height).not.toContain('NaN');
  });

  it('keeps normal window geometry above the reserved sub-session strip', async () => {
    localStorage.setItem('rcc_subsession_sub-1', JSON.stringify({
      geom: { x: 111, y: 999, w: 633, h: 444 },
      viewMode: 'chat',
    }));

    const { container } = renderWindow({ onToggleMaximized: vi.fn() });
    const panel = container.querySelector('.subsession-window') as HTMLElement;

    expect(parseFloat(panel.style.top) + parseFloat(panel.style.height)).toBeLessThanOrEqual(window.innerHeight - 100);
  });

  it('restores offscreen normal window geometry fully inside the viewport', async () => {
    localStorage.setItem('rcc_subsession_sub-1', JSON.stringify({
      geom: { x: 99999, y: 122, w: 633, h: 444 },
      viewMode: 'chat',
    }));

    const { container } = renderWindow({ onToggleMaximized: vi.fn() });
    const panel = container.querySelector('.subsession-window') as HTMLElement;

    expect(parseFloat(panel.style.left) + parseFloat(panel.style.width)).toBeLessThanOrEqual(window.innerWidth);
  });

  it('does not persist maximized geometry over normal localStorage', async () => {
    renderWindow({
      maximized: true,
      onToggleMaximized: vi.fn(),
      getMaximizeBounds: () => ({ x: 1, y: 2, w: 999, h: 888 }),
    });

    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem('rcc_subsession_sub-1') ?? '{}');
      expect(saved.geom).toEqual({ x: 111, y: 122, w: 633, h: 444 });
    });
  });

  it('hides resize handles and ignores header drag while maximized', async () => {
    const { container } = renderWindow({
      maximized: true,
      onToggleMaximized: vi.fn(),
      getMaximizeBounds: () => ({ x: 8, y: 9, w: 700, h: 500 }),
    });

    expect(container.querySelector('.resize-handle')).toBeNull();
    const panel = container.querySelector('.subsession-window') as HTMLElement;
    const header = container.querySelector('.subsession-header') as HTMLElement;

    fireEvent.mouseDown(header, { clientX: 20, clientY: 20 });
    fireEvent.mouseMove(document, { clientX: 220, clientY: 220 });
    fireEvent.mouseUp(document);

    expect(panel.style.left).toBe('8px');
    expect(panel.style.top).toBe('9px');
  });

  it('clears maximized state before minimize, hide, and stop close paths', async () => {
    const calls: string[] = [];
    const { container } = renderWindow({
      maximized: true,
      onToggleMaximized: vi.fn(),
      onRestoreBeforeClose: () => calls.push('restore'),
      onMinimize: () => calls.push('minimize'),
      onClose: () => calls.push('close'),
      getMaximizeBounds: () => ({ x: 0, y: 0, w: 800, h: 600 }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'window.minimize' }));
    expect(calls).toEqual(['restore', 'minimize']);

    calls.length = 0;
    fireEvent.click(screen.getByRole('button', { name: 'window.hide' }));
    expect(calls).toEqual(['restore', 'minimize']);

    calls.length = 0;
    fireEvent.click(container.querySelector('button[aria-label="stop-subsession"]') as HTMLButtonElement);
    expect(calls).toEqual(['restore', 'close']);
  });

  it('keeps delegated child file-browser layering and does not pass maximize support to it', async () => {
    const { container } = renderWindow({
      maximized: true,
      onToggleMaximized: vi.fn(),
      desktopFileBrowserZIndex: 5777,
      onDesktopFileBrowserOpen: vi.fn(),
      onDesktopFileBrowserClose: vi.fn(),
      onDesktopFileBrowserFocus: vi.fn(),
      getMaximizeBounds: () => ({ x: 0, y: 0, w: 800, h: 600 }),
    });

    fireEvent.click(container.querySelector('button[title="picker.files"]') as HTMLButtonElement);

    await waitFor(() => {
      const child = screen.getByTestId('floating-panel-subsession-filebrowser:sub-1');
      expect(child.style.zIndex).toBe('5777');
      expect(child.dataset.maximized).toBe('false');
      expect(floatingPanelPropsSpy.mock.calls.at(-1)?.[0]).not.toHaveProperty('onToggleMaximized');
    });
  });
});
