/**
 * Tests for session stop behavior:
 *
 * 1. Sub-sessions: single-click stop (no multi-step confirmation)
 * 2. Main sessions: 3-level confirmation (warn → danger → dialog)
 * 3. Main session stop cascades to close all child sub-sessions
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

// ── main session: 3-level confirmation state machine ────────────────────────

describe('main session 3-level confirmation state machine', () => {
  type MenuAction = 'stop' | 'restart' | 'new';

  /**
   * Mirrors the main-session branch of handleMenuAction in SessionControls.tsx.
   * Main sessions: 3 steps (click → warn → danger → dialog).
   */
  function simulateMainConfirmStep(opts: {
    confirmAction: MenuAction | null;
    confirmLevel: number;
    action: MenuAction;
  }): 'level1' | 'level2' | 'dialog' {
    const { confirmAction, confirmLevel, action } = opts;
    if (confirmAction !== action) return 'level1';
    if (confirmLevel < 2) return 'level2';
    return 'dialog';
  }

  it('step 1: first click shows warning', () => {
    expect(simulateMainConfirmStep({ confirmAction: null, confirmLevel: 0, action: 'stop' })).toBe('level1');
  });

  it('step 2: second click escalates to danger', () => {
    expect(simulateMainConfirmStep({ confirmAction: 'stop', confirmLevel: 1, action: 'stop' })).toBe('level2');
  });

  it('step 3: third click shows dialog', () => {
    expect(simulateMainConfirmStep({ confirmAction: 'stop', confirmLevel: 2, action: 'stop' })).toBe('dialog');
  });

  it('restart also requires 3 steps', () => {
    expect(simulateMainConfirmStep({ confirmAction: null, confirmLevel: 0, action: 'restart' })).toBe('level1');
    expect(simulateMainConfirmStep({ confirmAction: 'restart', confirmLevel: 1, action: 'restart' })).toBe('level2');
    expect(simulateMainConfirmStep({ confirmAction: 'restart', confirmLevel: 2, action: 'restart' })).toBe('dialog');
  });

  it('clicking a different action resets to level1', () => {
    expect(simulateMainConfirmStep({ confirmAction: 'stop', confirmLevel: 2, action: 'restart' })).toBe('level1');
  });
});

// ── main session stop cascades to close all sub-sessions ────────────────────

describe('main session stop cascades to sub-sessions', () => {
  /**
   * Mirrors handleStopProject from app.tsx:
   * 1. Find all sub-sessions whose parentSession matches the main session
   * 2. Close each one
   * 3. Send session.stop for the main project
   */
  function simulateStopProject(
    project: string,
    subSessions: Array<{ id: string; parentSession: string | null; sessionName: string }>,
    opts: { ws: ReturnType<typeof makeWsStub>; closeSubSession: (id: string) => void },
  ) {
    const mainSessionName = `deck_${project}_brain`;
    for (const sub of subSessions) {
      if (sub.parentSession === mainSessionName) {
        opts.closeSubSession(sub.id);
      }
    }
    opts.ws.sendSessionCommand('stop', { project });
  }

  it('closes all sub-sessions belonging to the project', () => {
    const ws = makeWsStub();
    const closeSubSession = vi.fn();
    const subs = [
      { id: 'sub1', parentSession: 'deck_myapp_brain', sessionName: 'deck_sub_sub1' },
      { id: 'sub2', parentSession: 'deck_myapp_brain', sessionName: 'deck_sub_sub2' },
      { id: 'sub3', parentSession: 'deck_other_brain', sessionName: 'deck_sub_sub3' },
    ];

    simulateStopProject('myapp', subs, { ws, closeSubSession });

    expect(closeSubSession).toHaveBeenCalledTimes(2);
    expect(closeSubSession).toHaveBeenCalledWith('sub1');
    expect(closeSubSession).toHaveBeenCalledWith('sub2');
    // sub3 belongs to a different project — not closed
    expect(closeSubSession).not.toHaveBeenCalledWith('sub3');
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('stop', { project: 'myapp' });
  });

  it('sends stop even when there are no sub-sessions', () => {
    const ws = makeWsStub();
    const closeSubSession = vi.fn();

    simulateStopProject('myapp', [], { ws, closeSubSession });

    expect(closeSubSession).not.toHaveBeenCalled();
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('stop', { project: 'myapp' });
  });

  it('does not close sub-sessions with null parentSession', () => {
    const ws = makeWsStub();
    const closeSubSession = vi.fn();
    const subs = [
      { id: 'sub1', parentSession: null, sessionName: 'deck_sub_sub1' },
      { id: 'sub2', parentSession: 'deck_myapp_brain', sessionName: 'deck_sub_sub2' },
    ];

    simulateStopProject('myapp', subs, { ws, closeSubSession });

    expect(closeSubSession).toHaveBeenCalledTimes(1);
    expect(closeSubSession).toHaveBeenCalledWith('sub2');
  });
});
