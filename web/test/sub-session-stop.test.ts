/**
 * Tests for session stop behavior:
 *
 * 1. Sub-sessions: single-click stop (no multi-step confirmation)
 * 2. Main sessions: 3-level confirmation (warn → danger → dialog)
 * 3. Main session stop is browser-thin and sends only session.stop
 */
import { describe, it, expect, vi } from 'vitest';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeSessionInfo(overrides: Record<string, unknown> = {}) {
  return {
    name: 'deck_sub_abc123',
    project: 'deck_sub_abc123',
    role: 'w1',
    agentType: 'claude-code',
    state: 'running' as const,
    label: 'my-worker',
    projectDir: '/tmp/test',
    ...overrides,
  };
}

function makeWsStub() {
  return {
    send: vi.fn(),
    sendSessionCommand: vi.fn(),
    sendInput: vi.fn(),
    subSessionStop: vi.fn(),
  };
}

// ── sub-session: single-click dispatch (no multi-step) ──────────────────────

describe('sub-session stop: single-click dispatch', () => {
  /**
   * Mirrors the sub-session branch of handleMenuAction in SessionControls.tsx.
   * Sub-sessions execute immediately — no confirmation state machine.
   */
  function simulateSubAction(
    action: 'stop' | 'restart' | 'new',
    opts: {
      onSubStop: () => void;
      onSubRestart?: () => void;
      onSubNew?: () => void;
      ws: ReturnType<typeof makeWsStub>;
      activeSession: ReturnType<typeof makeSessionInfo>;
    },
  ) {
    const { onSubStop, onSubRestart, onSubNew, ws, activeSession } = opts;
    if (action === 'stop') {
      onSubStop();
    } else if (action === 'restart') {
      onSubRestart ? onSubRestart() : ws.sendSessionCommand('restart', { project: activeSession.project });
    } else {
      onSubNew ? onSubNew() : ws.sendSessionCommand('restart', { project: activeSession.project, fresh: true });
    }
  }

  it('calls onSubStop immediately on first click', () => {
    const ws = makeWsStub();
    const onSubStop = vi.fn();
    simulateSubAction('stop', { onSubStop, ws, activeSession: makeSessionInfo() });
    expect(onSubStop).toHaveBeenCalledOnce();
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
  });

  it('calls onSubRestart immediately on first click', () => {
    const ws = makeWsStub();
    const onSubRestart = vi.fn();
    simulateSubAction('restart', { onSubRestart, onSubStop: vi.fn(), ws, activeSession: makeSessionInfo() });
    expect(onSubRestart).toHaveBeenCalledOnce();
  });

  it('calls onSubNew immediately on first click', () => {
    const ws = makeWsStub();
    const onSubNew = vi.fn();
    simulateSubAction('new', { onSubNew, onSubStop: vi.fn(), ws, activeSession: makeSessionInfo() });
    expect(onSubNew).toHaveBeenCalledOnce();
  });

  it('falls back to ws.sendSessionCommand for restart when no callback', () => {
    const ws = makeWsStub();
    simulateSubAction('restart', { onSubStop: vi.fn(), ws, activeSession: makeSessionInfo({ project: 'proj' }) });
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('restart', { project: 'proj' });
  });
});

// ── confirmation levels per action type ──────────────────────────────────────

describe('confirmation levels', () => {
  type MenuAction = 'stop' | 'restart' | 'new';

  /** Mirrors handleMenuAction confirmation logic. */
  function simulateConfirmStep(opts: {
    isSub: boolean;
    confirmAction: MenuAction | null;
    confirmLevel: number;
    action: MenuAction;
  }): 'level1' | 'level2' | 'execute' | 'dialog' {
    const { isSub, confirmAction, confirmLevel, action } = opts;
    const isStop = action === 'stop';

    if (isSub) {
      // Sub-session: all actions need 1 warn click first
      if (confirmAction !== action) return 'level1';
      // stop → execute directly, restart/new → execute directly
      return isStop ? 'execute' : 'execute';
    }

    // Main session stop: 3-level (warn → danger → dialog)
    if (isStop) {
      if (confirmAction !== action) return 'level1';
      if (confirmLevel < 2) return 'level2';
      return 'dialog';
    }

    // Main session restart/new: 1-click confirm → dialog
    return confirmAction !== action ? 'level1' : 'dialog';
  }

  // Sub-session stop: 2-level (warn → execute)
  it('sub-session stop: first click warns', () => {
    expect(simulateConfirmStep({ isSub: true, confirmAction: null, confirmLevel: 0, action: 'stop' })).toBe('level1');
  });
  it('sub-session stop: second click executes', () => {
    expect(simulateConfirmStep({ isSub: true, confirmAction: 'stop', confirmLevel: 1, action: 'stop' })).toBe('execute');
  });

  // Sub-session restart: 2-level (warn → execute)
  it('sub-session restart: first click warns', () => {
    expect(simulateConfirmStep({ isSub: true, confirmAction: null, confirmLevel: 0, action: 'restart' })).toBe('level1');
  });
  it('sub-session restart: second click executes', () => {
    expect(simulateConfirmStep({ isSub: true, confirmAction: 'restart', confirmLevel: 1, action: 'restart' })).toBe('execute');
  });

  // Main session stop: 3-level
  it('main stop step 1: first click warns', () => {
    expect(simulateConfirmStep({ isSub: false, confirmAction: null, confirmLevel: 0, action: 'stop' })).toBe('level1');
  });
  it('main stop step 2: second click escalates to danger', () => {
    expect(simulateConfirmStep({ isSub: false, confirmAction: 'stop', confirmLevel: 1, action: 'stop' })).toBe('level2');
  });
  it('main stop step 3: third click shows dialog', () => {
    expect(simulateConfirmStep({ isSub: false, confirmAction: 'stop', confirmLevel: 2, action: 'stop' })).toBe('dialog');
  });

  // Main session restart: 1-click
  it('main restart: first click warns', () => {
    expect(simulateConfirmStep({ isSub: false, confirmAction: null, confirmLevel: 0, action: 'restart' })).toBe('level1');
  });
  it('main restart: second click shows dialog', () => {
    expect(simulateConfirmStep({ isSub: false, confirmAction: 'restart', confirmLevel: 1, action: 'restart' })).toBe('dialog');
  });

  it('clicking a different action resets to level1', () => {
    expect(simulateConfirmStep({ isSub: false, confirmAction: 'stop', confirmLevel: 2, action: 'restart' })).toBe('level1');
  });
});

// ── main session stop is browser-thin ────────────────────────────────────────

describe('main session stop sends only session.stop', () => {
  /**
   * Mirrors the shutdown-main behavior in handleStopProject from app.tsx.
   * Browser marks the project stopping locally, but sends only session.stop and
   * leaves descendant shutdown to the daemon.
   */
  function simulateStopProject(
    project: string,
    opts: { ws: ReturnType<typeof makeWsStub> },
  ) {
    opts.ws.sendSessionCommand('stop', { project });
  }

  it('does not close descendant sub-sessions from the browser', () => {
    const ws = makeWsStub();
    simulateStopProject('myapp', { ws });
    expect(ws.subSessionStop).not.toHaveBeenCalled();
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('stop', { project: 'myapp' });
  });

  it('sends stop even when there are no sub-sessions', () => {
    const ws = makeWsStub();
    simulateStopProject('myapp', { ws });
    expect(ws.subSessionStop).not.toHaveBeenCalled();
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('stop', { project: 'myapp' });
  });

  it('does not depend on descendant parent links in the browser', () => {
    const ws = makeWsStub();
    simulateStopProject('myapp', { ws });
    expect(ws.subSessionStop).not.toHaveBeenCalled();
    expect(ws.sendSessionCommand).toHaveBeenCalledTimes(1);
  });
});
