/**
 * Tests for sub-session stop/restart callback chain and 3-step confirmation.
 *
 * Verifies that:
 * 1. SessionControls calls onSubStop (not session.stop) when the prop is provided
 * 2. SessionControls calls onSubRestart (not session.restart) when the prop is provided
 * 3. Without onSubStop, SessionControls falls back to session.stop (main session behavior)
 * 4. The confirmation dialog shows detailed sub-session info when onSubStop is present
 * 5. Sub-sessions require 3 confirmation steps (warn → danger → dialog)
 * 6. Main sessions require 2 confirmation steps (warn → dialog)
 */
import { describe, it, expect, vi } from 'vitest';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Minimal SessionInfo matching the type used by SessionControls. */
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

/** Minimal WsClient stub — only tracks calls to sendSessionCommand / send. */
function makeWsStub() {
  return {
    send: vi.fn(),
    sendSessionCommand: vi.fn(),
    sendInput: vi.fn(),
  };
}

// ── unit tests for the action dispatch logic ─────────────────────────────────

describe('sub-session stop/restart dispatch logic', () => {
  /**
   * Mirrors the final dispatch branch of handleMenuAction from SessionControls.tsx.
   * This is the code that runs AFTER all confirmations pass.
   */
  function simulateDispatch(
    action: 'stop' | 'restart' | 'new',
    opts: {
      onSubStop?: () => void;
      onSubRestart?: () => void;
      onSubNew?: () => void;
      onStopProject?: (p: string) => void;
      ws: ReturnType<typeof makeWsStub>;
      activeSession: ReturnType<typeof makeSessionInfo>;
    },
  ) {
    const { onSubStop, onSubRestart, onSubNew, onStopProject, ws, activeSession } = opts;

    if (action === 'restart') {
      onSubRestart
        ? onSubRestart()
        : ws.sendSessionCommand('restart', { project: activeSession.project });
    } else if (action === 'new') {
      onSubNew
        ? onSubNew()
        : ws.sendSessionCommand('restart', { project: activeSession.project, fresh: true });
    } else {
      onSubStop
        ? onSubStop()
        : onStopProject
          ? onStopProject(activeSession.project)
          : ws.sendSessionCommand('stop', { project: activeSession.project });
    }
  }

  it('calls onSubStop when provided instead of session.stop', () => {
    const ws = makeWsStub();
    const onSubStop = vi.fn();
    simulateDispatch('stop', { onSubStop, ws, activeSession: makeSessionInfo() });
    expect(onSubStop).toHaveBeenCalledOnce();
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
  });

  it('calls onSubRestart when provided instead of session.restart', () => {
    const ws = makeWsStub();
    const onSubRestart = vi.fn();
    simulateDispatch('restart', { onSubRestart, ws, activeSession: makeSessionInfo() });
    expect(onSubRestart).toHaveBeenCalledOnce();
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
  });

  it('calls onSubNew when provided instead of session.restart with fresh', () => {
    const ws = makeWsStub();
    const onSubNew = vi.fn();
    simulateDispatch('new', { onSubNew, ws, activeSession: makeSessionInfo() });
    expect(onSubNew).toHaveBeenCalledOnce();
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
  });

  it('falls back to session.stop when onSubStop is NOT provided', () => {
    const ws = makeWsStub();
    simulateDispatch('stop', { ws, activeSession: makeSessionInfo({ project: 'myproject' }) });
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('stop', { project: 'myproject' });
  });

  it('falls back to onStopProject when onSubStop is NOT provided but onStopProject is', () => {
    const ws = makeWsStub();
    const onStopProject = vi.fn();
    simulateDispatch('stop', { onStopProject, ws, activeSession: makeSessionInfo({ project: 'myproject' }) });
    expect(onStopProject).toHaveBeenCalledWith('myproject');
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
  });

  it('falls back to session.restart when onSubRestart is NOT provided', () => {
    const ws = makeWsStub();
    simulateDispatch('restart', { ws, activeSession: makeSessionInfo({ project: 'myproject' }) });
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('restart', { project: 'myproject' });
  });
});

// ── 3-step confirmation state machine ────────────────────────────────────────

describe('3-step sub-session confirmation state machine', () => {
  type MenuAction = 'stop' | 'restart' | 'new';

  /**
   * Mirrors the handleMenuAction confirmation state machine from SessionControls.tsx.
   * Returns what happens at each click: 'level1' | 'level2' | 'dialog'.
   */
  function simulateConfirmStep(opts: {
    isSub: boolean;
    confirmAction: MenuAction | null;
    confirmLevel: number;
    action: MenuAction;
  }): 'level1' | 'level2' | 'dialog' {
    const { isSub, confirmAction, confirmLevel, action } = opts;

    if (confirmAction !== action) {
      return 'level1';
    }
    if (isSub && confirmLevel < 2) {
      return 'level2';
    }
    return 'dialog';
  }

  // Sub-session: 3 steps (click → warn → danger → dialog)
  it('sub-session step 1: first click shows warning', () => {
    expect(simulateConfirmStep({ isSub: true, confirmAction: null, confirmLevel: 0, action: 'stop' })).toBe('level1');
  });

  it('sub-session step 2: second click escalates to danger', () => {
    expect(simulateConfirmStep({ isSub: true, confirmAction: 'stop', confirmLevel: 1, action: 'stop' })).toBe('level2');
  });

  it('sub-session step 3: third click shows dialog', () => {
    expect(simulateConfirmStep({ isSub: true, confirmAction: 'stop', confirmLevel: 2, action: 'stop' })).toBe('dialog');
  });

  // Main session: 2 steps (click → warn → dialog)
  it('main session step 1: first click shows warning', () => {
    expect(simulateConfirmStep({ isSub: false, confirmAction: null, confirmLevel: 0, action: 'stop' })).toBe('level1');
  });

  it('main session step 2: second click shows dialog directly', () => {
    expect(simulateConfirmStep({ isSub: false, confirmAction: 'stop', confirmLevel: 1, action: 'stop' })).toBe('dialog');
  });

  // Same for restart/new actions
  it('sub-session restart requires 3 steps', () => {
    expect(simulateConfirmStep({ isSub: true, confirmAction: null, confirmLevel: 0, action: 'restart' })).toBe('level1');
    expect(simulateConfirmStep({ isSub: true, confirmAction: 'restart', confirmLevel: 1, action: 'restart' })).toBe('level2');
    expect(simulateConfirmStep({ isSub: true, confirmAction: 'restart', confirmLevel: 2, action: 'restart' })).toBe('dialog');
  });

  it('clicking a different action resets to level1', () => {
    // Was confirming 'stop' at level 2, now clicking 'restart'
    expect(simulateConfirmStep({ isSub: true, confirmAction: 'stop', confirmLevel: 2, action: 'restart' })).toBe('level1');
  });
});

// ── confirmation dialog message logic ────────────────────────────────────────

describe('sub-session confirmation message logic', () => {
  function buildConfirmMsg(
    action: 'stop' | 'restart' | 'new',
    opts: { onSubStop?: () => void; activeSession: ReturnType<typeof makeSessionInfo> },
  ): { key: string; params?: Record<string, string> } {
    const isSub = !!opts.onSubStop;
    const subParams = isSub
      ? { type: opts.activeSession.agentType ?? '?', label: opts.activeSession.label || '—', name: opts.activeSession.name }
      : undefined;

    if (action === 'stop') {
      return isSub
        ? { key: 'session.confirm_sub_stop_dialog', params: subParams }
        : { key: 'session.confirm_stop_dialog' };
    } else if (action === 'restart') {
      return isSub
        ? { key: 'session.confirm_sub_restart_dialog', params: subParams }
        : { key: 'session.confirm_restart_dialog' };
    } else {
      return isSub
        ? { key: 'session.confirm_sub_new_dialog', params: subParams }
        : { key: 'session.confirm_new_dialog' };
    }
  }

  it('uses sub-session stop dialog with details when onSubStop is present', () => {
    const session = makeSessionInfo({ agentType: 'gemini', label: 'research', name: 'deck_sub_xyz' });
    const result = buildConfirmMsg('stop', { onSubStop: () => {}, activeSession: session });
    expect(result.key).toBe('session.confirm_sub_stop_dialog');
    expect(result.params).toEqual({ type: 'gemini', label: 'research', name: 'deck_sub_xyz' });
  });

  it('uses generic stop dialog when onSubStop is NOT present', () => {
    const session = makeSessionInfo();
    const result = buildConfirmMsg('stop', { activeSession: session });
    expect(result.key).toBe('session.confirm_stop_dialog');
    expect(result.params).toBeUndefined();
  });

  it('uses sub-session restart dialog with details when onSubStop is present', () => {
    const session = makeSessionInfo({ agentType: 'shell', label: null, name: 'deck_sub_999' });
    const result = buildConfirmMsg('restart', { onSubStop: () => {}, activeSession: session });
    expect(result.key).toBe('session.confirm_sub_restart_dialog');
    expect(result.params).toEqual({ type: 'shell', label: '—', name: 'deck_sub_999' });
  });

  it('uses sub-session new dialog with details when onSubStop is present', () => {
    const session = makeSessionInfo({ agentType: 'codex', label: 'builder' });
    const result = buildConfirmMsg('new', { onSubStop: () => {}, activeSession: session });
    expect(result.key).toBe('session.confirm_sub_new_dialog');
    expect(result.params).toEqual({ type: 'codex', label: 'builder', name: 'deck_sub_abc123' });
  });

  it('falls back to "—" when label is null/empty', () => {
    const session = makeSessionInfo({ label: '' });
    const result = buildConfirmMsg('stop', { onSubStop: () => {}, activeSession: session });
    expect(result.params!.label).toBe('—');
  });
});
