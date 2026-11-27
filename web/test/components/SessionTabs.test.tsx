/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { h } from 'preact';
import { act, render, screen, fireEvent, cleanup } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
      if (key === 'session.unpin_to_stop') return 'Unpin tab first to stop';
      const template = typeof fallback === 'string' ? fallback : key.split('.').pop() ?? key;
      const values = typeof fallback === 'string' ? opts : fallback;
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name) => String(values?.[name] ?? `{{${name}}}`));
    },
  }),
}));

const getUserPrefMock = vi.fn().mockResolvedValue(null);
const saveUserPrefMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/api.js', () => ({
  getUserPref: (...args: unknown[]) => getUserPrefMock(...args),
  saveUserPref: (...args: unknown[]) => saveUserPrefMock(...args),
}));

import { SessionTabs } from '../../src/components/SessionTabs.js';
import type { SessionInfo } from '../../src/types.js';

const makeSessions = (overrides: Partial<SessionInfo>[] = []): SessionInfo[] =>
  overrides.map((o, i) => ({
    name: `session_w${i + 1}`,
    project: 'my-project',
    role: `w${i + 1}` as SessionInfo['role'],
    agentType: 'worker',
    state: 'idle',
    ...o,
  }));

// Default required props for SessionTabs
const defaultProps = {
  onNewSession: vi.fn(),
  onStopProject: vi.fn(),
  onRestartProject: vi.fn(),
  pinned: new Set<string>(),
  setPinnedArr: vi.fn(),
};

const readTabStyles = (): string => {
  const relPath = '../../src/styles.css';
  return readFileSync(new URL(relPath, import.meta.url), 'utf8');
};

function firePointer(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: MouseEventInit & { pointerId: number; pointerType: string },
) {
  const win = target.ownerDocument.defaultView ?? window;
  const eventNames = [
    type,
    type === 'pointerdown' ? 'PointerDown' : type === 'pointermove' ? 'PointerMove' : 'PointerUp',
  ];
  for (const eventName of eventNames) {
    const event = new win.MouseEvent(eventName, {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: init.button ?? 0,
      clientX: init.clientX,
      clientY: init.clientY,
    });
    Object.defineProperties(event, {
      pointerId: { value: init.pointerId, configurable: true },
      pointerType: { value: init.pointerType, configurable: true },
    });
    act(() => {
      target.dispatchEvent(event);
    });
  }
}

describe('SessionTabs', () => {
  beforeEach(() => {
    getUserPrefMock.mockResolvedValue(null);
    saveUserPrefMock.mockResolvedValue(undefined);
    // Ensure localStorage is available (jsdom may provide a broken stub)
    if (typeof globalThis.localStorage === 'undefined' || typeof globalThis.localStorage.setItem !== 'function') {
      const store: Record<string, string> = {};
      Object.defineProperty(globalThis, 'localStorage', {
        value: {
          getItem: (k: string) => store[k] ?? null,
          setItem: (k: string, v: string) => { store[k] = v; },
          removeItem: (k: string) => { delete store[k]; },
          clear: () => { for (const k of Object.keys(store)) delete store[k]; },
          get length() { return Object.keys(store).length; },
          key: (i: number) => Object.keys(store)[i] ?? null,
        },
        writable: true,
        configurable: true,
      });
    }
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders "No active sessions" when sessions array is empty and sessionsLoaded is true', () => {
    render(
      <SessionTabs sessions={[]} activeSession={null} onSelect={vi.fn()} sessionsLoaded={true} {...defaultProps} />,
    );
    expect(screen.getByText('No active sessions')).toBeDefined();
  });

  it('renders a button for each session', () => {
    const sessions = makeSessions([{}, {}]);
    render(
      <SessionTabs sessions={sessions} activeSession={null} onSelect={vi.fn()} sessionsLoaded={true} {...defaultProps} />,
    );
    const buttons = screen.getAllByRole('tab');
    expect(buttons).toHaveLength(2);
  });

  it('marks the active session button with aria-selected=true', () => {
    const sessions = makeSessions([{ name: 'session_w1' }, { name: 'session_w2' }]);
    render(
      <SessionTabs sessions={sessions} activeSession="session_w1" onSelect={vi.fn()} sessionsLoaded={true} {...defaultProps} />,
    );
    const buttons = screen.getAllByRole('tab');
    expect(buttons[0].getAttribute('aria-selected')).toBe('true');
    expect(buttons[1].getAttribute('aria-selected')).toBe('false');
  });

  it('scrolls the active tab into view by mutating tab-bar scrollLeft only (no scrollIntoView)', async () => {
    // Regression for "怎么往左偏这么多" (image ce683be95d350b6cda6852eae74bb320.png):
    // the previous implementation called Element.scrollIntoView({ inline: 'center' })
    // which walks the entire ancestor scroll chain and dragged the chat layout
    // sideways on mobile. Now we only mutate this tab-bar's scrollLeft.
    const scrollIntoView = vi.fn();
    const previous = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      const sessions = makeSessions([{ name: 'session_w1' }, { name: 'session_w2' }, { name: 'session_w3' }]);
      const view = render(
        <SessionTabs sessions={sessions} activeSession="session_w1" onSelect={vi.fn()} sessionsLoaded={true} {...defaultProps} />,
      );

      // Wait a frame so the requestAnimationFrame inside the effect runs.
      await new Promise((resolve) => setTimeout(resolve, 50));

      view.rerender(
        <SessionTabs sessions={sessions} activeSession="session_w3" onSelect={vi.fn()} sessionsLoaded={true} {...defaultProps} />,
      );

      // Wait again for the rerender's rAF.
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The new implementation MUST NOT use scrollIntoView (which would scroll
      // every scrollable ancestor including .chat-main / document body).
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      HTMLElement.prototype.scrollIntoView = previous;
    }
  });

  it('calls onSelect with the session name when a tab is clicked', () => {
    const onSelect = vi.fn();
    const sessions = makeSessions([{ name: 'session_w1' }, { name: 'session_w2' }]);
    render(
      <SessionTabs sessions={sessions} activeSession={null} onSelect={onSelect} sessionsLoaded={true} {...defaultProps} />,
    );

    const buttons = screen.getAllByRole('tab');
    fireEvent.click(buttons[1]);

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('session_w2');
  });

  it('selects a pinned tab on mouse pointer-up even if the browser suppresses the click', () => {
    const onSelect = vi.fn();
    const sessions = makeSessions([{ name: 'session_w1' }, { name: 'session_w2' }]);
    render(
      <SessionTabs
        sessions={sessions}
        activeSession={null}
        onSelect={onSelect}
        sessionsLoaded={true}
        {...defaultProps}
        pinned={new Set(['session_w2'])}
      />,
    );

    const pinnedTab = screen.getAllByRole('tab')[0];
    fireEvent.mouseDown(pinnedTab, {
      button: 0,
      clientX: 24,
      clientY: 12,
    });
    fireEvent.mouseUp(pinnedTab, {
      button: 0,
      clientX: 25,
      clientY: 13,
    });

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('session_w2');
  });

  it('selects a pinned tab on touch pointer-up even if Android suppresses the click', () => {
    const onSelect = vi.fn();
    const sessions = makeSessions([{ name: 'session_w1' }, { name: 'session_w2' }, { name: 'session_w3' }]);
    render(
      <SessionTabs
        sessions={sessions}
        activeSession={null}
        onSelect={onSelect}
        sessionsLoaded={true}
        {...defaultProps}
        pinned={new Set(['session_w2'])}
      />,
    );

    const pinnedTab = screen.getAllByRole('tab')[0];
    firePointer(pinnedTab, 'pointerdown', {
      pointerId: 11,
      pointerType: 'touch',
      button: 0,
      clientX: 24,
      clientY: 12,
    });
    firePointer(pinnedTab, 'pointerup', {
      pointerId: 11,
      pointerType: 'touch',
      button: 0,
      clientX: 25,
      clientY: 13,
    });

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('session_w2');
  });

  it('does not double-select when a touch click follows pointer-up activation', () => {
    const onSelect = vi.fn();
    const sessions = makeSessions([{ name: 'session_w1' }]);
    render(
      <SessionTabs sessions={sessions} activeSession={null} onSelect={onSelect} sessionsLoaded={true} {...defaultProps} />,
    );

    const tab = screen.getByRole('tab');
    firePointer(tab, 'pointerdown', {
      pointerId: 12,
      pointerType: 'touch',
      button: 0,
      clientX: 24,
      clientY: 12,
    });
    firePointer(tab, 'pointerup', {
      pointerId: 12,
      pointerType: 'touch',
      button: 0,
      clientX: 24,
      clientY: 12,
    });
    fireEvent.click(tab);

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('session_w1');
  });

  it('does not activate the touch pointer-up fallback after a scroll-sized move', () => {
    const onSelect = vi.fn();
    const sessions = makeSessions([{ name: 'session_w1' }]);
    render(
      <SessionTabs sessions={sessions} activeSession={null} onSelect={onSelect} sessionsLoaded={true} {...defaultProps} />,
    );

    const tab = screen.getByRole('tab');
    firePointer(tab, 'pointerdown', {
      pointerId: 13,
      pointerType: 'touch',
      button: 0,
      clientX: 24,
      clientY: 12,
    });
    firePointer(tab, 'pointermove', {
      pointerId: 13,
      pointerType: 'touch',
      button: 0,
      clientX: 46,
      clientY: 12,
    });
    firePointer(tab, 'pointerup', {
      pointerId: 13,
      pointerType: 'touch',
      button: 0,
      clientX: 46,
      clientY: 12,
    });

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does not double-select when the normal mouse click follows pointer-up activation', () => {
    const onSelect = vi.fn();
    const sessions = makeSessions([{ name: 'session_w1' }]);
    render(
      <SessionTabs sessions={sessions} activeSession={null} onSelect={onSelect} sessionsLoaded={true} {...defaultProps} />,
    );

    const tab = screen.getByRole('tab');
    fireEvent.mouseDown(tab, {
      button: 0,
      clientX: 24,
      clientY: 12,
    });
    fireEvent.mouseUp(tab, {
      button: 0,
      clientX: 24,
      clientY: 12,
    });
    fireEvent.click(tab);

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('session_w1');
  });

  it('does not activate from the mouse pointer fallback after a drag-sized move', () => {
    const onSelect = vi.fn();
    const sessions = makeSessions([{ name: 'session_w1' }]);
    render(
      <SessionTabs sessions={sessions} activeSession={null} onSelect={onSelect} sessionsLoaded={true} {...defaultProps} />,
    );

    const tab = screen.getByRole('tab');
    fireEvent.mouseDown(tab, {
      button: 0,
      clientX: 24,
      clientY: 12,
    });
    fireEvent.mouseMove(tab, {
      button: 0,
      clientX: 40,
      clientY: 12,
    });
    fireEvent.mouseUp(tab, {
      button: 0,
      clientX: 40,
      clientY: 12,
    });

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('opens the tab context menu from a touch long-press without selecting the tab', () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    const sessions = makeSessions([{ name: 'session_w1' }]);
    render(
      <SessionTabs sessions={sessions} activeSession={null} onSelect={onSelect} sessionsLoaded={true} {...defaultProps} />,
    );

    const tab = screen.getByRole('tab');
    firePointer(tab, 'pointerdown', {
      pointerId: 7,
      pointerType: 'touch',
      button: 0,
      clientX: 24,
      clientY: 12,
    });
    act(() => {
      vi.advanceTimersByTime(520);
    });

    expect(screen.getByRole('button', { name: 'Pin' })).toBeDefined();

    firePointer(tab, 'pointerup', {
      pointerId: 7,
      pointerType: 'touch',
      button: 0,
      clientX: 24,
      clientY: 12,
    });
    fireEvent.click(tab);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('triggers medium haptic once on touch long-press and not on mouse, short tap, or move-cancel', () => {
    vi.useFakeTimers();
    const vibrate = vi.fn(() => true);
    const originalVibrateDesc = Object.getOwnPropertyDescriptor(navigator, 'vibrate');
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate });

    try {
      const sessions = makeSessions([{ name: 'session_w1' }]);
      render(
        <SessionTabs sessions={sessions} activeSession={null} onSelect={vi.fn()} sessionsLoaded={true} {...defaultProps} />,
      );
      const tab = screen.getByRole('tab');

      // Mouse pointerdown does not trigger long-press haptic
      firePointer(tab, 'pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 24, clientY: 12 });
      act(() => { vi.advanceTimersByTime(600); });
      firePointer(tab, 'pointerup', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 24, clientY: 12 });
      expect(vibrate).not.toHaveBeenCalled();

      // Touch short tap does not vibrate
      firePointer(tab, 'pointerdown', { pointerId: 2, pointerType: 'touch', button: 0, clientX: 24, clientY: 12 });
      act(() => { vi.advanceTimersByTime(100); });
      firePointer(tab, 'pointerup', { pointerId: 2, pointerType: 'touch', button: 0, clientX: 24, clientY: 12 });
      act(() => { vi.advanceTimersByTime(500); });
      expect(vibrate).not.toHaveBeenCalled();

      // Touch move-cancel does not vibrate
      firePointer(tab, 'pointerdown', { pointerId: 3, pointerType: 'touch', button: 0, clientX: 24, clientY: 12 });
      firePointer(tab, 'pointermove', { pointerId: 3, pointerType: 'touch', clientX: 50, clientY: 12 });
      act(() => { vi.advanceTimersByTime(600); });
      firePointer(tab, 'pointerup', { pointerId: 3, pointerType: 'touch', button: 0, clientX: 50, clientY: 12 });
      expect(vibrate).not.toHaveBeenCalled();

      // Touch long-press triggers medium (20ms) once; pointerup does not repeat
      firePointer(tab, 'pointerdown', { pointerId: 4, pointerType: 'touch', button: 0, clientX: 24, clientY: 12 });
      act(() => { vi.advanceTimersByTime(520); });
      expect(screen.getByRole('button', { name: 'Pin' })).toBeDefined();
      expect(vibrate).toHaveBeenCalledTimes(1);
      expect(vibrate).toHaveBeenCalledWith(20);
      firePointer(tab, 'pointerup', { pointerId: 4, pointerType: 'touch', button: 0, clientX: 24, clientY: 12 });
      expect(vibrate).toHaveBeenCalledTimes(1);
    } finally {
      if (originalVibrateDesc) Object.defineProperty(navigator, 'vibrate', originalVibrateDesc);
      else delete (navigator as unknown as Record<string, unknown>).vibrate;
    }
  });

  it('renders brain tab with brain class and project name', () => {
    const sessions: SessionInfo[] = [{
      name: 'session_brain',
      project: 'my-project',
      role: 'brain',
      agentType: 'brain',
      state: 'running',
    }];
    render(
      <SessionTabs sessions={sessions} activeSession={null} onSelect={vi.fn()} sessionsLoaded={true} {...defaultProps} />,
    );
    const button = screen.getByRole('tab');
    expect(button.className).toContain('brain');
    expect(button.textContent).toContain('my-project');
  });

  it('applies busy class for running session state', () => {
    const sessions = makeSessions([{ name: 'session_w1', state: 'running' }]);
    render(
      <SessionTabs sessions={sessions} activeSession={null} onSelect={vi.fn()} sessionsLoaded={true} {...defaultProps} />,
    );
    const button = screen.getByRole('tab');
    expect(button.className).toContain('busy');
  });


  it('shows sdk family badges for claude and codex tabs', () => {
    const sessions = makeSessions([
      { name: 'sdk-cc', role: 'brain', project: 'sdk-proj', agentType: 'claude-code-sdk', state: 'idle', label: 'claude-code-sdk1' },
      { name: 'sdk-cx', role: 'w1', project: 'sdk-proj', agentType: 'codex-sdk', state: 'idle', label: 'codex-sdk2' },
    ]);

    const view = render(
      <SessionTabs sessions={sessions} activeSession={null} onSelect={vi.fn()} sessionsLoaded={true} {...defaultProps} />,
    );

    const badges = [...view.container.querySelectorAll('.agent-badge')].map((el) => el.textContent);
    expect(badges).toEqual(['cc', 'cx']);
    expect(screen.getByText('CC1')).toBeDefined();
    expect(screen.getByText('Cx2')).toBeDefined();
  });

  it('renders tab bar with role=tablist', () => {
    const sessions = makeSessions([{}]);
    render(
      <SessionTabs sessions={sessions} activeSession={null} onSelect={vi.fn()} sessionsLoaded={true} {...defaultProps} />,
    );
    expect(screen.getByRole('tablist')).toBeDefined();
  });

  it('does not replay a stale idle alert when a running tab becomes inactive', () => {
    const sessions = makeSessions([
      { name: 'session_running', label: 'Running', state: 'running' },
      { name: 'session_other', label: 'Other', state: 'idle' },
    ]);
    const idleAlerts = new Set(['session_running']);
    const view = render(
      <SessionTabs
        sessions={sessions}
        activeSession="session_running"
        idleAlerts={idleAlerts}
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
      />,
    );

    const runningTab = screen.getByRole('tab', { name: /running/i });
    expect(runningTab.classList.contains('alert')).toBe(false);

    view.rerender(
      <SessionTabs
        sessions={sessions}
        activeSession="session_other"
        idleAlerts={idleAlerts}
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
      />,
    );
    expect(screen.getByRole('tab', { name: /running/i }).classList.contains('alert')).toBe(false);
  });

  it('keeps a fresh completion alert visible while the session is idle', () => {
    const sessions = makeSessions([{ name: 'session_idle', label: 'Idle', state: 'idle' }]);
    render(
      <SessionTabs
        sessions={sessions}
        activeSession={null}
        idleAlerts={new Set(['session_idle'])}
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
      />,
    );

    expect(screen.getByRole('tab', { name: /idle/i }).classList.contains('alert')).toBe(true);
  });

  it('persists a pinned tab drag immediately and restores the order after remount', async () => {
    localStorage.removeItem('rcc_sync_tab_order');
    const sessions = makeSessions([
      { name: 'session_alpha', label: 'Alpha' },
      { name: 'session_beta', label: 'Beta' },
      { name: 'session_gamma', label: 'Gamma' },
    ]);
    const pinned = new Set(sessions.map((session) => session.name));

    const view = render(
      <SessionTabs
        sessions={sessions}
        activeSession={null}
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
        pinned={pinned}
      />,
    );

    const wrappers = [...view.container.querySelectorAll('.tab-wrap')];
    fireEvent.dragStart(wrappers[2]);
    fireEvent.dragOver(wrappers[0]);
    fireEvent.drop(wrappers[0]);
    fireEvent.dragEnd(wrappers[2]);

    const labels = () => screen.getAllByRole('tab').map((tab) => (
      ['Alpha', 'Beta', 'Gamma'].find((label) => tab.textContent?.includes(label))
    ));
    expect(labels()).toEqual(['Gamma', 'Alpha', 'Beta']);

    const stored = JSON.parse(localStorage.getItem('rcc_sync_tab_order') ?? 'null') as { v: string[]; t: number };
    expect(stored.v).toEqual(['session_gamma', 'session_alpha', 'session_beta']);
    // No timer advance is needed: discrete tab order writes start immediately.
    expect(saveUserPrefMock).toHaveBeenCalledWith('tab_order', JSON.stringify(stored), { signal: expect.any(AbortSignal) });

    view.unmount();
    render(
      <SessionTabs
        sessions={sessions}
        activeSession={null}
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
        pinned={pinned}
      />,
    );
    expect(labels()).toEqual(['Gamma', 'Alpha', 'Beta']);
  });

  it('requires three confirmations before stopping from the tab context dialog', () => {
    const onStopProject = vi.fn();
    const sessions = makeSessions([{ name: 'session_w1', project: 'proj-1' }]);
    render(
      <SessionTabs
        sessions={sessions}
        activeSession={null}
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
        onStopProject={onStopProject}
      />,
    );

    const tab = screen.getByRole('tab');
    fireEvent.contextMenu(tab);
    fireEvent.click(screen.getByRole('button', { name: /^Stop$/ }));

    const stopBtn = () => screen.getByRole('button', { name: /stop session|confirm stop|really stop/i });

    fireEvent.click(stopBtn());
    expect(onStopProject).not.toHaveBeenCalled();
    expect(screen.getByText('Confirm stop?')).toBeDefined();

    fireEvent.click(stopBtn());
    expect(onStopProject).not.toHaveBeenCalled();
    expect(screen.getByText('⚠ REALLY stop proj-1?')).toBeDefined();

    fireEvent.click(stopBtn());
    expect(onStopProject).toHaveBeenCalledOnce();
    expect(onStopProject).toHaveBeenCalledWith('proj-1');
  });

  it('removes whole-project stop from a concrete shared-session surface', () => {
    const sessions = makeSessions([{ name: 'session_w1', project: 'proj-1' }]);
    render(
      <SessionTabs
        sessions={sessions}
        activeSession={null}
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
        canStopProject={false}
      />,
    );

    fireEvent.contextMenu(screen.getByRole('tab'));
    expect(screen.queryByRole('button', { name: /^Stop$/ })).toBeNull();
  });

  it('uses typed icons and plain labels in the tab context menu', () => {
    const sessions = makeSessions([
      { name: 'deck_proj_brain', project: 'proj-1', role: 'brain', agentType: 'codex-sdk', userCreated: true },
    ]);
    render(
      <SessionTabs
        sessions={sessions}
        activeSession={null}
        onSelect={vi.fn()}
        sessionsLoaded={true}
        onOpenSessionSettings={vi.fn()}
        onCloneSession={vi.fn()}
        {...defaultProps}
      />,
    );

    fireEvent.contextMenu(screen.getByRole('tab'));
    const menu = document.querySelector('.tab-context-menu') as HTMLElement;
    expect(menu).toBeTruthy();

    const expected: Array<[string, string]> = [
      ['Pin', 'session-action-menu-icon-pin'],
      ['Restart', 'session-action-menu-icon-restart'],
      ['Start fresh', 'session-action-menu-icon-new'],
      ['Rename', 'session-action-menu-icon-rename'],
      ['Settings', 'session-action-menu-icon-settings'],
      ['Copy session', 'session-action-menu-icon-clone'],
      ['Stop', 'session-action-menu-icon-stop'],
    ];

    for (const [label, iconClass] of expected) {
      const button = screen.getByRole('button', { name: label });
      expect(button.closest('.tab-context-menu')).toBe(menu);
      expect(button.querySelector(`.${iconClass}`)).toBeTruthy();
    }
  });

  it('shows the same unpin-first stop guard in the tab context menu', () => {
    const onStopProject = vi.fn();
    const sessions = makeSessions([{ name: 'session_w1', project: 'proj-1' }]);
    render(
      <SessionTabs
        sessions={sessions}
        activeSession={null}
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
        pinned={new Set(['session_w1'])}
        onStopProject={onStopProject}
      />,
    );

    fireEvent.contextMenu(screen.getByRole('tab'));
    const stopButton = screen.getByRole('button', { name: /unpin tab first to stop/i });
    expect((stopButton as HTMLButtonElement).disabled).toBe(true);
    expect(stopButton.querySelector('.session-action-menu-icon-unpin')).toBeTruthy();
    fireEvent.click(stopButton);
    expect(onStopProject).not.toHaveBeenCalled();
  });

  it('opens session settings from the tab context menu', () => {
    const onOpenSessionSettings = vi.fn();
    const sessions = makeSessions([{ name: 'deck_proj_brain', project: 'proj-1', role: 'brain', agentType: 'codex-sdk' }]);
    render(
      <SessionTabs
        sessions={sessions}
        activeSession={null}
        onSelect={vi.fn()}
        sessionsLoaded={true}
        onOpenSessionSettings={onOpenSessionSettings}
        {...defaultProps}
      />,
    );

    fireEvent.contextMenu(screen.getByRole('tab'));
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));

    expect(onOpenSessionSettings).toHaveBeenCalledOnce();
    expect(onOpenSessionSettings).toHaveBeenCalledWith(sessions[0]);
  });

  it('opens clone session action from the tab context menu for main brain sessions only', () => {
    const onCloneSession = vi.fn();
    const sessions = makeSessions([
      { name: 'deck_proj_brain', project: 'proj-1', role: 'brain', agentType: 'codex-sdk', userCreated: true },
      { name: 'deck_proj_w1', project: 'proj-1', role: 'w1', agentType: 'codex-sdk', userCreated: true },
    ]);
    render(
      <SessionTabs
        sessions={sessions}
        activeSession={null}
        onSelect={vi.fn()}
        sessionsLoaded={true}
        onCloneSession={onCloneSession}
        {...defaultProps}
      />,
    );

    const [brainTab, workerTab] = screen.getAllByRole('tab');

    fireEvent.contextMenu(workerTab);
    expect(screen.queryByRole('button', { name: /copy session/i })).toBeNull();
    fireEvent.mouseDown(document.body);

    fireEvent.contextMenu(brainTab);
    fireEvent.click(screen.getByRole('button', { name: /copy session/i }));

    expect(onCloneSession).toHaveBeenCalledOnce();
    expect(onCloneSession).toHaveBeenCalledWith(sessions[0]);
  });

  it('uses the current label as the rename input value and commits a label update', () => {
    const onRenameSession = vi.fn();
    const sessions: SessionInfo[] = [{
      name: 'deck_proj_brain',
      project: 'my-project',
      role: 'brain',
      agentType: 'brain',
      state: 'idle',
      label: 'Main Label',
    }];

    render(
      <SessionTabs
        sessions={sessions}
        activeSession="deck_proj_brain"
        onSelect={vi.fn()}
        sessionsLoaded={true}
        renameRequest="deck_proj_brain"
        onRenameHandled={vi.fn()}
        onRenameSession={onRenameSession}
        {...defaultProps}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('Main Label');

    fireEvent.input(input, { target: { value: 'Readable Main' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRenameSession).toHaveBeenCalledWith('deck_proj_brain', 'Readable Main');
  });

  it('allows clearing the label so the session falls back to the project name', () => {
    const onRenameSession = vi.fn();
    const sessions: SessionInfo[] = [{
      name: 'deck_proj_brain',
      project: 'my-project',
      role: 'brain',
      agentType: 'brain',
      state: 'idle',
      label: 'Main Label',
    }];

    render(
      <SessionTabs
        sessions={sessions}
        activeSession="deck_proj_brain"
        onSelect={vi.fn()}
        sessionsLoaded={true}
        renameRequest="deck_proj_brain"
        onRenameHandled={vi.fn()}
        onRenameSession={onRenameSession}
        {...defaultProps}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.input(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onRenameSession).toHaveBeenCalledWith('deck_proj_brain', null);
  });

  it('never overwrites tab_order before sessionsLoaded and tabOrderHydrated, or when sessions is empty', async () => {
    const existing = { v: ['srv2_a', 'srv1_b'], t: 500 };
    localStorage.setItem('rcc_sync_tab_order', JSON.stringify(existing));

    let resolveRemote!: (val: string | null) => void;
    getUserPrefMock.mockImplementationOnce(() => new Promise<string | null>((res) => {
      resolveRemote = res;
    }));

    const sessions = makeSessions([{ name: 'srv1_a', label: 'A' }]);
    const view = render(
      <SessionTabs
        sessions={[]}
        activeSession={null}
        onSelect={vi.fn()}
        sessionsLoaded={false}
        {...defaultProps}
      />,
    );
    expect(saveUserPrefMock).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('rcc_sync_tab_order')!)).toEqual(existing);

    // Dashboard / loaded-but-empty must not clear other servers' tab_order
    view.rerender(
      <SessionTabs
        sessions={[]}
        activeSession={null}
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
      />,
    );
    expect(saveUserPrefMock).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('rcc_sync_tab_order')!)).toEqual(existing);

    // Sessions loaded, but tab_order still waiting for remote hydration
    view.rerender(
      <SessionTabs
        sessions={sessions}
        activeSession={null}
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
      />,
    );
    expect(saveUserPrefMock).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('rcc_sync_tab_order')!)).toEqual(existing);

    // Once remote preference finishes hydrating, missing local session is appended WITHOUT wiping existing names
    await act(async () => {
      resolveRemote(JSON.stringify(existing));
      await Promise.resolve();
    });
    const stored = JSON.parse(localStorage.getItem('rcc_sync_tab_order')!) as { v: string[]; t: number };
    expect(stored.v).toEqual(['srv2_a', 'srv1_b', 'srv1_a']);
  });

  it('does not ping-pong or wipe non-overlapping/partially overlapping sessions across storage events', async () => {
    const initial = { v: ['srv1_alpha', 'srv1_beta', 'srv2_gamma'], t: 100 };
    localStorage.setItem('rcc_sync_tab_order', JSON.stringify(initial));
    getUserPrefMock.mockResolvedValue(JSON.stringify(initial));

    const server1Sessions = makeSessions([
      { name: 'srv1_alpha', label: 'S1 Alpha' },
      { name: 'srv1_beta', label: 'S1 Beta' },
    ]);

    const view = render(
      <SessionTabs
        sessions={server1Sessions}
        activeSession={null}
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    saveUserPrefMock.mockClear();

    // Non-overlapping / partially overlapping update from another server tab arrives via storage event
    const fromOtherTab = { v: ['srv2_delta', 'srv2_gamma', 'srv1_alpha', 'srv1_beta'], t: 200 };
    localStorage.setItem('rcc_sync_tab_order', JSON.stringify(fromOtherTab));
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'rcc_sync_tab_order',
        newValue: JSON.stringify(fromOtherTab),
      }));
    });
    expect(saveUserPrefMock).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('rcc_sync_tab_order')!).v).toEqual(fromOtherTab.v);

    // Drag in Server 1 preserves Server 2 entries in their exact slots alongside reordered Server 1 tabs
    const wrappers = [...view.container.querySelectorAll('.tab-wrap')];
    fireEvent.dragStart(wrappers[1]);
    fireEvent.dragOver(wrappers[0]);
    fireEvent.drop(wrappers[0]);
    fireEvent.dragEnd(wrappers[1]);

    const afterDrop = JSON.parse(localStorage.getItem('rcc_sync_tab_order')!).v as string[];
    expect(afterDrop).toEqual(['srv2_delta', 'srv2_gamma', 'srv1_beta', 'srv1_alpha']);
  });

  it('surgically moves only the dragged tab in interleaved pinned/unpinned/other-server order and keeps pin/unpin immutable', async () => {
    const initial = { v: ['hidden_srv2', 'u1', 'p1', 'u2', 'p2'], t: 100 };
    localStorage.setItem('rcc_sync_tab_order', JSON.stringify(initial));
    getUserPrefMock.mockResolvedValue(JSON.stringify(initial));

    const sessions = makeSessions([
      { name: 'u1', label: 'U1' },
      { name: 'p1', label: 'P1' },
      { name: 'u2', label: 'U2' },
      { name: 'p2', label: 'P2' },
    ]);

    const view = render(
      <SessionTabs
        sessions={sessions}
        activeSession="p1"
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
        pinned={new Set(['p1', 'p2'])}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    saveUserPrefMock.mockClear();

    const getVisibleNames = () => screen.getAllByRole('tab').map((tab) => (
      ['P1', 'P2', 'U1', 'U2'].find((lbl) => tab.textContent?.includes(lbl))
    ));
    // Displayed order is pinned-first [P1, P2], then unpinned [U1, U2]
    expect(getVisibleNames()).toEqual(['P1', 'P2', 'U1', 'U2']);

    // 1) Drag unpinned U2 (idx=3) before U1 (idx=2): hidden_srv2, P1, P2 must keep their exact slots in tab_order!
    let wrappers = [...view.container.querySelectorAll('.tab-wrap')];
    fireEvent.dragStart(wrappers[3]);
    fireEvent.dragOver(wrappers[2]);
    fireEvent.drop(wrappers[2]);
    fireEvent.dragEnd(wrappers[3]);
    expect(getVisibleNames()).toEqual(['P1', 'P2', 'U2', 'U1']);
    expect(JSON.parse(localStorage.getItem('rcc_sync_tab_order')!).v).toEqual([
      'hidden_srv2',
      'u2',
      'u1',
      'p1',
      'p2',
    ]);

    // 2) Drag pinned P2 (idx=1) before P1 (idx=0): hidden_srv2, U2, U1 must keep their exact slots in tab_order!
    wrappers = [...view.container.querySelectorAll('.tab-wrap')];
    fireEvent.dragStart(wrappers[1]);
    fireEvent.dragOver(wrappers[0]);
    fireEvent.drop(wrappers[0]);
    fireEvent.dragEnd(wrappers[1]);
    expect(getVisibleNames()).toEqual(['P2', 'P1', 'U2', 'U1']);
    expect(JSON.parse(localStorage.getItem('rcc_sync_tab_order')!).v).toEqual([
      'hidden_srv2',
      'u2',
      'u1',
      'p2',
      'p1',
    ]);

    // 3) Cross-group drag (unpinned U1 onto pinned P2) must be rejected without touching tab_order
    saveUserPrefMock.mockClear();
    const rawBeforeCrossGroup = localStorage.getItem('rcc_sync_tab_order');
    wrappers = [...view.container.querySelectorAll('.tab-wrap')];
    fireEvent.dragStart(wrappers[3]);
    fireEvent.dragOver(wrappers[0]);
    fireEvent.drop(wrappers[0]);
    fireEvent.dragEnd(wrappers[3]);
    expect(saveUserPrefMock).not.toHaveBeenCalled();
    expect(localStorage.getItem('rcc_sync_tab_order')).toBe(rawBeforeCrossGroup);

    // 4) Pinning / unpinning tabs later leaves saved drag bytes completely unchanged
    view.rerender(
      <SessionTabs
        sessions={sessions}
        activeSession="p1"
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
        pinned={new Set(['p1', 'p2', 'u1'])}
      />,
    );
    expect(saveUserPrefMock).not.toHaveBeenCalled();
    expect(localStorage.getItem('rcc_sync_tab_order')).toBe(rawBeforeCrossGroup);

    view.rerender(
      <SessionTabs
        sessions={sessions}
        activeSession="p1"
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
        pinned={new Set()}
      />,
    );
    expect(saveUserPrefMock).not.toHaveBeenCalled();
    expect(localStorage.getItem('rcc_sync_tab_order')).toBe(rawBeforeCrossGroup);
    // Once unpinned, saved order reflects exact uncorrupted drag order [u2, u1, p2, p1]
    expect(getVisibleNames()).toEqual(['U2', 'U1', 'P2', 'P1']);
  });

  it('safely handles storage updates mid-drag and treats stale/removed drag indices as no-ops', async () => {
    const initial = { v: ['s1', 's2', 's3'], t: 100 };
    localStorage.setItem('rcc_sync_tab_order', JSON.stringify(initial));
    getUserPrefMock.mockResolvedValue(JSON.stringify(initial));

    const sessions = makeSessions([
      { name: 's1', label: 'S1' },
      { name: 's2', label: 'S2' },
      { name: 's3', label: 'S3' },
    ]);

    const view = render(
      <SessionTabs
        sessions={sessions}
        activeSession="s1"
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    saveUserPrefMock.mockClear();

    // Start dragging S3 (idx=2)
    let wrappers = [...view.container.querySelectorAll('.tab-wrap')];
    fireEvent.dragStart(wrappers[2]);

    // Another window prepends hidden_other via storage before drop
    const remoteUpdate = { v: ['hidden_other', 's1', 's2', 's3'], t: 200 };
    localStorage.setItem('rcc_sync_tab_order', JSON.stringify(remoteUpdate));
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'rcc_sync_tab_order',
        newValue: JSON.stringify(remoteUpdate),
      }));
    });

    // Drop onto S1 (idx=0): S3 moves before S1 while preserving hidden_other at slot 0
    wrappers = [...view.container.querySelectorAll('.tab-wrap')];
    fireEvent.drop(wrappers[0]);
    expect(JSON.parse(localStorage.getItem('rcc_sync_tab_order')!).v).toEqual([
      'hidden_other',
      's3',
      's1',
      's2',
    ]);

    // Start dragging S3 (now idx=0), then session list shrinks removing S3 before drop -> safe no-op
    saveUserPrefMock.mockClear();
    const rawBeforeRemoved = localStorage.getItem('rcc_sync_tab_order');
    wrappers = [...view.container.querySelectorAll('.tab-wrap')];
    fireEvent.dragStart(wrappers[0]);
    view.rerender(
      <SessionTabs
        sessions={sessions.slice(0, 2)}
        activeSession="s1"
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
      />,
    );
    wrappers = [...view.container.querySelectorAll('.tab-wrap')];
    fireEvent.drop(wrappers[0]);
    expect(saveUserPrefMock).not.toHaveBeenCalled();
    expect(localStorage.getItem('rcc_sync_tab_order')).toBe(rawBeforeRemoved);
  });

  it('keeps dragged order of two pinned tabs fixed and moves unpinned tab without oscillating', async () => {
    localStorage.removeItem('rcc_sync_tab_order');
    const sessions = makeSessions([
      { name: 'ag_aip', label: 'ag aip' },
      { name: 'ag_cd', label: 'ag cd' },
      { name: 'ag_worker', label: 'ag worker' },
    ]);
    getUserPrefMock.mockResolvedValue(null);

    const view = render(
      <SessionTabs
        sessions={sessions}
        activeSession="ag_aip"
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
        pinned={new Set(['ag_aip', 'ag_cd'])}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const getOrder = () => screen.getAllByRole('tab').map((tab) => (
      ['ag aip', 'ag cd', 'ag worker'].find((lbl) => tab.textContent?.includes(lbl))
    ));
    expect(getOrder()).toEqual(['ag aip', 'ag cd', 'ag worker']);

    // Drag second pinned tab ("ag cd") before first pinned tab ("ag aip")
    const wrappers = [...view.container.querySelectorAll('.tab-wrap')];
    fireEvent.dragStart(wrappers[1]);
    fireEvent.dragOver(wrappers[0]);
    fireEvent.drop(wrappers[0]);
    fireEvent.dragEnd(wrappers[1]);
    expect(getOrder()).toEqual(['ag cd', 'ag aip', 'ag worker']);
    expect(JSON.parse(localStorage.getItem('rcc_sync_tab_order')!).v).toEqual(['ag_cd', 'ag_aip', 'ag_worker']);

    saveUserPrefMock.mockClear();

    // Unrelated session activity re-renders must NOT swap pinned tabs or rewrite tab_order
    const updatedSessions = makeSessions([
      { name: 'ag_aip', label: 'ag aip', state: 'running' },
      { name: 'ag_cd', label: 'ag cd', state: 'idle' },
      { name: 'ag_worker', label: 'ag worker', state: 'idle' },
    ]);
    view.rerender(
      <SessionTabs
        sessions={updatedSessions}
        activeSession="ag_aip"
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
        pinned={new Set(['ag_aip', 'ag_cd'])}
      />,
    );
    expect(getOrder()).toEqual(['ag cd', 'ag aip', 'ag worker']);
    expect(saveUserPrefMock).not.toHaveBeenCalled();

    // Unpin "ag cd" while keeping "ag aip" pinned: "ag cd" moves cleanly to unpinned before "ag_worker" without oscillating
    view.rerender(
      <SessionTabs
        sessions={updatedSessions}
        activeSession="ag_aip"
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
        pinned={new Set(['ag_aip'])}
      />,
    );
    expect(getOrder()).toEqual(['ag aip', 'ag cd', 'ag worker']);
    expect(saveUserPrefMock).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('rcc_sync_tab_order')!).v).toEqual(['ag_cd', 'ag_aip', 'ag_worker']);
  });

  it('adds .incognito class on incognito tabs in both active and inactive states', () => {
    const sessions = makeSessions([
      { name: 'deck_priv_brain', label: 'priv', role: 'brain', agentType: 'claude-code-sdk', incognito: true },
      { name: 'deck_norm_brain', label: 'norm', role: 'brain', agentType: 'claude-code-sdk', incognito: false },
    ]);
    const view = render(
      <SessionTabs
        sessions={sessions}
        activeSession="deck_priv_brain"
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
      />,
    );
    const tabs = [...view.container.querySelectorAll('.tab')];
    expect(tabs[0]?.classList.contains('incognito')).toBe(true);
    expect(tabs[0]?.classList.contains('active')).toBe(true);
    expect(tabs[1]?.classList.contains('incognito')).toBe(false);
  });

  it('renders top-left corner sequence numbers matching visual tab order without increasing tab height or width', () => {
    const cssText = readTabStyles();

    // Inject tab CSS rules directly into the document to assert real box/positioning properties.
    const tabRule = cssText.match(/\.tab\s*\{[^}]+\}/)?.[0] ?? '';
    const topLeftRule = cssText.match(/\.tab-top-left-badges\s*\{[^}]+\}/)?.[0] ?? '';
    const seqRule = cssText.match(/\.session-tab-seq\s*\{[^}]+\}/)?.[0] ?? '';
    const barRule = cssText.match(/\.tab-bar\s*\{[^}]+\}/)?.[0] ?? '';
    const androidSubSeqRule = cssText.match(/html\[data-native-platform="android"\]\s*\.subsession-card-seq\s*\{[^}]+\}/)?.[0] ?? '';
    const androidTabSeqRule = cssText.match(/html\[data-native-platform="android"\]\s*\.session-tab-seq\s*\{[^}]+\}/)?.[0] ?? '';
    expect(tabRule).toContain('overflow: visible');
    expect(tabRule).toContain('position: relative');
    expect(topLeftRule).toContain('position: absolute');
    expect(topLeftRule).toContain('top: -3px');
    expect(topLeftRule).toContain('left: 0');
    expect(topLeftRule).toContain('display: inline-flex');
    expect(topLeftRule).toContain('pointer-events: none');
    expect(topLeftRule).toContain('z-index: 3');
    expect(seqRule).toContain('font-size: 9px');
    expect(seqRule).toContain('font-weight: 700');
    expect(seqRule).not.toContain('position: absolute');
    // Android keeps legacy .subsession-card-seq padding untouched while sizing .session-tab-seq cleanly
    expect(androidSubSeqRule).not.toContain('padding');
    expect(androidTabSeqRule).toContain('font-size: 8px');
    // .tab-bar has top/left padding sufficient so top: -3px / left: 0 corner badge is never clipped
    expect(barRule).toMatch(/padding:\s*4px\s+8px\s+0/);

    const sessions = makeSessions([
      { name: 'sess_a', label: 'Alpha', role: 'brain', agentType: 'claude-code-sdk' },
      { name: 'sess_b', label: 'Beta', role: 'w1', agentType: 'codex-sdk' },
      { name: 'sess_c', label: 'Gamma', role: 'w2', agentType: 'gemini-cli' },
    ]);
    const view = render(
      <SessionTabs
        sessions={sessions}
        activeSession="sess_a"
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
        pinned={new Set(['sess_c'])}
      />,
    );

    // Pinned tab sess_c moves first visually -> gets corner badge 1, sess_a -> 2, sess_b -> 3
    const renderedTabs = screen.getAllByRole('tab');
    expect(renderedTabs.map((btn) => btn.querySelector('.session-tab-seq')?.textContent)).toEqual(['1', '2', '3']);
    expect(screen.getByTestId('session-tab-seq-sess_c').textContent).toBe('1');
    expect(screen.getByTestId('session-tab-seq-sess_a').textContent).toBe('2');
    expect(screen.getByTestId('session-tab-seq-sess_b').textContent).toBe('3');

    // Drag sess_b before sess_a -> corner badges immediately renumber to match new visual order
    const wrappers = [...view.container.querySelectorAll('.tab-wrap')];
    fireEvent.dragStart(wrappers[2]);
    fireEvent.dragOver(wrappers[1]);
    fireEvent.drop(wrappers[1]);
    fireEvent.dragEnd(wrappers[2]);
    expect(screen.getByTestId('session-tab-seq-sess_c').textContent).toBe('1');
    expect(screen.getByTestId('session-tab-seq-sess_b').textContent).toBe('2');
    expect(screen.getByTestId('session-tab-seq-sess_a').textContent).toBe('3');
  });

  it('positions .tab-pin at bottom-left corner and .tab-top-left-badges at top-left corner out-of-flow without altering SessionTree badge', () => {
    const cssText = readTabStyles();

    // 1. Assert CSS rules for out-of-flow corner positioning
    const pinRule = cssText.match(/(?:^|\n)\.tab-pin\s*\{[^}]+\}/)?.[0] ?? '';
    const topLeftBadgesRule = cssText.match(/\.tab-top-left-badges\s*\{[^}]+\}/)?.[0] ?? '';
    const tabAgentBadgeRule = cssText.match(/\.tab-top-left-badges\s+\.agent-badge\s*\{[^}]+\}/)?.[0] ?? '';
    const baseAgentBadgeRule = cssText.match(/(?:^|\n)\.agent-badge\s*\{[^}]+\}/)?.[0] ?? '';
    const androidPinRule = cssText.match(/html\[data-native-platform="android"\]\s*\.tab-pin\s*\{[^}]+\}/)?.[0] ?? '';
    const androidTabAgentBadgeRule = cssText.match(/html\[data-native-platform="android"\]\s*\.tab-top-left-badges\s+\.agent-badge\s*\{[^}]+\}/)?.[0] ?? '';

    // .tab-pin must be bottom-left, absolute, pointer-events: none, margin: 0
    expect(pinRule).toContain('position: absolute');
    expect(pinRule).toMatch(/bottom:\s*(?:0|1px)/);
    expect(pinRule).toMatch(/left:\s*(?:0|1px)/);
    expect(pinRule).toContain('pointer-events: none');
    expect(pinRule).toContain('margin: 0');
    expect(pinRule).not.toContain('margin-right');

    // .tab-top-left-badges must be top-left, absolute, inline-flex, pointer-events: none
    expect(topLeftBadgesRule).toContain('position: absolute');
    expect(topLeftBadgesRule).toContain('top: -3px');
    expect(topLeftBadgesRule).toContain('left: 0');
    expect(topLeftBadgesRule).toContain('display: inline-flex');
    expect(topLeftBadgesRule).toContain('gap: 2px');
    expect(topLeftBadgesRule).toContain('pointer-events: none');

    // .tab-top-left-badges .agent-badge must have badge font/padding and no top-right absolute positioning
    expect(tabAgentBadgeRule).toContain('font-size: 8.5px');
    expect(tabAgentBadgeRule).toContain('padding: 1px 4px');
    expect(tabAgentBadgeRule).not.toContain('right: 0');

    // Base .agent-badge (used in SessionTree) must remain inline and NOT have position: absolute
    expect(baseAgentBadgeRule).toContain('display: inline-flex');
    expect(baseAgentBadgeRule).not.toContain('position: absolute');

    // Android compact rules must be present
    expect(androidPinRule).toContain('bottom: 1px');
    expect(androidPinRule).toContain('left: 1px');
    expect(androidTabAgentBadgeRule).toContain('font-size: 8px');
    expect(androidTabAgentBadgeRule).toContain('padding: 0 3px');

    // 2. Render SessionTabs with pinned tabs and agent types
    const sessions = makeSessions([
      { name: 'sess_pinned_cc', label: 'Pinned CC', agentType: 'claude-code' },
      { name: 'sess_normal_cx', label: 'Normal CX', agentType: 'codex-sdk' },
      { name: 'sess_no_badge', label: 'Plain' },
    ]);

    render(
      <SessionTabs
        sessions={sessions}
        activeSession="sess_pinned_cc"
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
        pinned={new Set(['sess_pinned_cc'])}
      />,
    );

    const renderedTabs = screen.getAllByRole('tab');
    expect(renderedTabs).toHaveLength(3);

    // Tab 1 (pinned, agent badge): has .tab-pin and .tab-top-left-badges containing .session-tab-seq and .agent-badge
    const tab1Pin = renderedTabs[0].querySelector('.tab-pin');
    const tab1TopLeft = renderedTabs[0].querySelector('.tab-top-left-badges');
    const tab1AgentBadge = tab1TopLeft?.querySelector('.agent-badge');
    const tab1Seq = tab1TopLeft?.querySelector('.session-tab-seq');
    expect(tab1Pin).not.toBeNull();
    expect(tab1Pin?.textContent).toBe('📌');
    expect(tab1Pin?.getAttribute('aria-hidden')).toBe('true');
    expect(tab1TopLeft).not.toBeNull();
    expect(tab1Seq?.textContent).toBe('1');
    expect(tab1AgentBadge).not.toBeNull();
    expect(tab1AgentBadge?.textContent).toBe('cc');
    expect(tab1Seq?.nextElementSibling).toBe(tab1AgentBadge);

    // Tab 2 (unpinned, agent badge): no .tab-pin, has .tab-top-left-badges with seq and badge
    const tab2Pin = renderedTabs[1].querySelector('.tab-pin');
    const tab2TopLeft = renderedTabs[1].querySelector('.tab-top-left-badges');
    const tab2Seq = tab2TopLeft?.querySelector('.session-tab-seq');
    const tab2AgentBadge = tab2TopLeft?.querySelector('.agent-badge');
    expect(tab2Pin).toBeNull();
    expect(tab2TopLeft).not.toBeNull();
    expect(tab2Seq?.textContent).toBe('2');
    expect(tab2AgentBadge).not.toBeNull();
    expect(tab2AgentBadge?.textContent).toBe('cx');
    expect(tab2Seq?.nextElementSibling).toBe(tab2AgentBadge);

    // Tab 3 (unpinned, no agent badge): no .tab-pin, has .tab-top-left-badges with seq only
    const tab3Pin = renderedTabs[2].querySelector('.tab-pin');
    const tab3TopLeft = renderedTabs[2].querySelector('.tab-top-left-badges');
    const tab3Seq = tab3TopLeft?.querySelector('.session-tab-seq');
    const tab3AgentBadge = tab3TopLeft?.querySelector('.agent-badge');
    expect(tab3Pin).toBeNull();
    expect(tab3TopLeft).not.toBeNull();
    expect(tab3Seq?.textContent).toBe('3');
    expect(tab3AgentBadge).toBeNull();

    // 3. Render 10+ tabs to verify 2-digit sequence numbers work cleanly alongside agent badge
    const tenSessions = makeSessions(
      Array.from({ length: 10 }, (_, i) => ({
        name: `sess_${i + 1}`,
        label: `Tab ${i + 1}`,
        agentType: i === 9 ? 'claude-code' : undefined,
      })),
    );
    const { container: tenContainer } = render(
      <SessionTabs
        sessions={tenSessions}
        activeSession="sess_10"
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
      />,
    );
    const tab10 = tenContainer.querySelectorAll('.tab')[9];
    const tab10TopLeft = tab10.querySelector('.tab-top-left-badges');
    const tab10Seq = tab10TopLeft?.querySelector('.session-tab-seq');
    const tab10Badge = tab10TopLeft?.querySelector('.agent-badge');
    expect(tab10Seq?.textContent).toBe('10');
    expect(tab10Badge?.textContent).toBe('cc');
    expect(tab10Seq?.nextElementSibling).toBe(tab10Badge);
  });

  it('ensures .tab-ws-dot, .tab-latency, and idle green dots are completely removed from tabs and styles', () => {
    const cssText = readTabStyles();

    // 1. Assert CSS rules for WS dot, latency, and idle green dots are completely absent
    const wsDotRule = cssText.match(/(?:^|\n)\.tab-ws-dot\s*\{[^}]+\}/)?.[0] ?? '';
    const latencyRule = cssText.match(/(?:^|\n)\.tab-latency\s*\{[^}]+\}/)?.[0] ?? '';
    const idleDotRule = cssText.match(/(?:^|\n)\.tab\.idle:not\(\.active\)::after\s*\{[^}]+\}/)?.[0] ?? '';
    const legacyIdleRule = cssText.match(/(?:^|\n)\.tab\.idle::after\s*\{[^}]+\}/)?.[0] ?? '';
    const androidWsDotRule = cssText.match(/html\[data-native-platform="android"\]\s*\.tab-ws-dot\s*\{[^}]+\}/)?.[0] ?? '';
    const androidLatencyRule = cssText.match(/html\[data-native-platform="android"\]\s*\.tab-latency\s*\{[^}]+\}/)?.[0] ?? '';
    const androidIdleRule = cssText.match(/html\[data-native-platform="android"\]\s*\.tab\.idle:not\(\.active\)::after\s*\{[^}]+\}/)?.[0] ?? '';

    expect(wsDotRule).toBe('');
    expect(latencyRule).toBe('');
    expect(idleDotRule).toBe('');
    expect(legacyIdleRule).toBe('');
    expect(androidWsDotRule).toBe('');
    expect(androidLatencyRule).toBe('');
    expect(androidIdleRule).toBe('');

    // 2. Render SessionTabs and verify no tab renders .tab-ws-dot or .tab-latency across connected/latency states
    const onSelect = vi.fn();
    const sessions = makeSessions([
      { name: 'sess_active', label: 'Active Tab', state: 'idle' },
      { name: 'sess_inactive', label: 'Inactive Tab', state: 'idle' },
    ]);

    const { rerender } = render(
      <SessionTabs
        sessions={sessions}
        activeSession="sess_active"
        connected={true}
        latencyMs={12}
        latencyColor="#34d399"
        onSelect={onSelect}
        sessionsLoaded={true}
        {...defaultProps}
      />,
    );

    const tabsA = screen.getAllByRole('tab');
    expect(tabsA[0].querySelector('.tab-ws-dot')).toBeNull();
    expect(tabsA[0].querySelector('.tab-latency')).toBeNull();
    expect(tabsA[1].querySelector('.tab-ws-dot')).toBeNull();
    expect(tabsA[1].querySelector('.tab-latency')).toBeNull();

    // Active tab click still cleanly selects sess_active without pointer obstruction
    fireEvent.click(tabsA[0]);
    expect(onSelect).toHaveBeenCalledWith('sess_active');

    // Case B: Disconnected state
    rerender(
      <SessionTabs
        sessions={sessions}
        activeSession="sess_active"
        connected={false}
        latencyMs={null}
        latencyColor="#34d399"
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
      />,
    );
    const tabsB = screen.getAllByRole('tab');
    expect(tabsB[0].querySelector('.tab-ws-dot')).toBeNull();
    expect(tabsB[0].querySelector('.tab-latency')).toBeNull();
  });

  it('enforces min-width not less than 5 characters on .tab and renders .tab.busy with bottom marquee animation', () => {
    const cssText = readTabStyles();

    // 1. .tab min-width at least 5ch plus padding and centered content
    const tabRule = cssText.match(/(?:^|\n)\.tab\s*\{[^}]+\}/)?.[0] ?? '';
    expect(tabRule).toContain('min-width: calc(5ch + 30px)');
    expect(tabRule).toContain('justify-content: center');

    // 2. .tab.busy::after uses bottom high-contrast marquee animation instead of 7px spinning circle
    const busyRule = cssText.match(/(?:^|\n)\.tab\.busy::after\s*\{[^}]+\}/)?.[0] ?? '';
    expect(busyRule).toContain('position: absolute');
    expect(busyRule).toContain('bottom: 0');
    expect(busyRule).toContain('height: 3px');
    expect(busyRule).toContain('z-index: 3');
    expect(busyRule).toContain('pointer-events: none');
    expect(busyRule).toContain('animation: tab-busy-marquee');
    expect(busyRule).not.toContain("content: '◌'");
    expect(cssText).toContain('@keyframes tab-busy-marquee');
    expect(cssText).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.tab\.busy::after\s*\{[\s\S]*?animation:\s*none;/);

    // 2.1 .tab-pin is elevated to z-index: 4 and .tab.pinned.busy::after clears left: 12px so pin icon is never obscured
    const pinRule = cssText.match(/(?:^|\n)\.tab-pin\s*\{[^}]+\}/)?.[0] ?? '';
    expect(pinRule).toContain('z-index: 4');
    const pinnedBusyRule = cssText.match(/(?:^|\n)\.tab\.pinned\.busy::after\s*\{[^}]+\}/)?.[0] ?? '';
    expect(pinnedBusyRule).toContain('left: 12px');

    // 3. Render test with short labels, active idle, inactive idle, busy, and pinned busy
    const sessions = makeSessions([
      { name: 'sess_short_active', label: 'cd', state: 'idle' },
      { name: 'sess_short_inactive', label: 'sh', state: 'idle' },
      { name: 'sess_busy', label: 'worker', state: 'running' },
      { name: 'sess_pinned_busy', label: 'pinned_worker', state: 'running' },
    ]);
    const onSelect = vi.fn();
    render(
      <SessionTabs
        sessions={sessions}
        activeSession="sess_short_active"
        connected={true}
        latencyMs={23}
        onSelect={onSelect}
        sessionsLoaded={true}
        {...defaultProps}
        pinned={new Set(['sess_pinned_busy'])}
      />,
    );

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(4);

    // Tab 1: Pinned + busy -> pinned tabs sort to front, has both .pinned and .busy, plus .tab-pin icon
    expect(tabs[0].className).toContain('tab');
    expect(tabs[0].className).toContain('pinned');
    expect(tabs[0].className).toContain('busy');
    const pinEl = tabs[0].querySelector('.tab-pin');
    expect(pinEl).not.toBeNull();
    expect(pinEl?.textContent).toBe('📌');

    // Tab 2: Active + idle
    expect(tabs[1].className).toContain('tab');
    expect(tabs[1].className).toContain('active');
    expect(tabs[1].className).toContain('idle');
    expect(tabs[1].querySelector('.tab-ws-dot')).toBeNull();

    // Tab 3: Inactive + idle (no green dot in DOM or CSS)
    expect(tabs[2].className).toContain('tab');
    expect(tabs[2].className).not.toContain('active');
    expect(tabs[2].className).toContain('idle');
    expect(tabs[2].querySelector('.tab-ws-dot')).toBeNull();

    // Tab 4: Inactive + busy
    expect(tabs[3].className).toContain('tab');
    expect(tabs[3].className).toContain('busy');
    expect(tabs[3].querySelector('.tab-ws-dot')).toBeNull();

    // Clicking inactive tab selects it cleanly
    fireEvent.click(tabs[2]);
    expect(onSelect).toHaveBeenCalledWith('sess_short_inactive');
  });

  it('renders visible non-transparent top/left/right borders across inactive and active regular and brain tabs', () => {
    const cssText = readTabStyles();

    const tabRule = cssText.match(/(?:^|\n)\.tab\s*\{[^}]+\}/)?.[0] ?? '';
    expect(tabRule).toMatch(/border:\s*1px solid rgba\(125,\s*211,\s*252,\s*0\.18\)/);
    expect(tabRule).toContain('border-bottom: none');

    const tabHoverRule = cssText.match(/(?:^|\n)\.tab:hover\s*\{[^}]+\}/)?.[0] ?? '';
    expect(tabHoverRule).toMatch(/border-color:\s*rgba\(125,\s*211,\s*252,\s*0\.32\)/);

    const activeTabRule = cssText.match(/(?:^|\n)\.tab\.active\s*\{[^}]+\}/)?.[0] ?? '';
    expect(activeTabRule).toMatch(/border-color:\s*rgba\(34,\s*211,\s*238,\s*0\.46\)/);

    const brainTabRule = cssText.match(/(?:^|\n)\.tab\.brain\s*\{[^}]+\}/)?.[0] ?? '';
    expect(brainTabRule).toMatch(/border-color:\s*rgba\(167,\s*139,\s*250,\s*0\.28\)/);

    const brainTabHoverRule = cssText.match(/(?:^|\n)\.tab\.brain:hover\s*\{[^}]+\}/)?.[0] ?? '';
    expect(brainTabHoverRule).toMatch(/border-color:\s*rgba\(167,\s*139,\s*250,\s*0\.40\)/);

    const activeBrainRule = cssText.match(/(?:^|\n)\.tab\.brain\.active\s*\{[^}]+\}/)?.[0] ?? '';
    expect(activeBrainRule).toMatch(/border-color:\s*rgba\(167,\s*139,\s*250,\s*0\.52\)/);
    expect(activeBrainRule).not.toMatch(/border-top-color:\s*transparent/);
    expect(activeBrainRule).toMatch(/border-bottom-color:\s*#8b5cf6/);

    // Verify rendered DOM elements
    const sessions = makeSessions([
      { name: 'sess_brain', label: 'Brain', role: 'brain', agentType: 'claude-code-sdk' },
      { name: 'sess_w1', label: 'Worker 1', role: 'w1', agentType: 'codex-sdk' },
    ]);
    render(
      <SessionTabs
        sessions={sessions}
        activeSession="sess_brain"
        connected={true}
        latencyMs={15}
        onSelect={vi.fn()}
        sessionsLoaded={true}
        {...defaultProps}
      />,
    );

    const renderedTabs = screen.getAllByRole('tab');
    expect(renderedTabs).toHaveLength(2);
    // Active brain tab
    expect(renderedTabs[0].className).toContain('tab');
    expect(renderedTabs[0].className).toContain('brain');
    expect(renderedTabs[0].className).toContain('active');
    // Inactive worker tab
    expect(renderedTabs[1].className).toContain('tab');
    expect(renderedTabs[1].className).not.toContain('brain');
    expect(renderedTabs[1].className).not.toContain('active');

    // Badges sit inside .tab-top-left-badges
    const badges = renderedTabs[0].querySelector('.tab-top-left-badges');
    expect(badges).not.toBeNull();
    const seq = badges?.querySelector('.session-tab-seq');
    const agentBadge = badges?.querySelector('.agent-badge');
    expect(seq).not.toBeNull();
    expect(agentBadge).not.toBeNull();
  });
});
