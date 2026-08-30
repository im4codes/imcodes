/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  SUPERVISION_TASK_LIFECYCLE_STATUSES,
} from '@shared/supervision-config.js';
import { supervisionConsoleStatusGroup } from '@shared/supervision-task-console.js';
import {
  SupervisionTaskConsole,
  SupervisionTaskConsoleToggle,
  SupervisionTaskConsoleView,
  clampSupervisionConsoleWidth,
  sortSupervisionConsoleTasks,
  supervisionConsoleMaxWidth,
} from '../../src/components/SupervisionTaskConsole.js';
import { SUPERVISION_TASK_CONSOLE_PREFERENCES_STORAGE_KEY } from '../../src/supervision-task-console-preferences.js';
import {
  SUPERVISION_TASK_CONSOLE_PHASE,
  createSupervisionTaskConsoleState,
  type SupervisionTaskConsoleReducerState,
} from '../../src/supervision-task-console-reducer.js';

// Preact chooses the native lowercase event name only when the DOM advertises
// `onpointerdown`. jsdom does not, so without this capability marker Preact
// registers a case-sensitive `PointerDown` listener and a realistic
// `pointerdown` never reaches production code.
const originalOnPointerDown = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'onpointerdown');
Object.defineProperty(HTMLElement.prototype, 'onpointerdown', {
  configurable: true,
  writable: true,
  value: null,
});

function dispatchPointerEvent(
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: MouseEventInit & { pointerId: number },
): MouseEvent & { pointerId: number } {
  // jsdom has no PointerEvent constructor. Testing Library therefore falls
  // back to Event and silently drops button/clientX/pointerId. A MouseEvent
  // retains the real coordinates; pointerId is the only pointer-specific
  // field the production handler needs.
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init }) as MouseEvent & { pointerId: number };
  Object.defineProperty(event, 'pointerId', { configurable: true, value: init.pointerId });
  fireEvent(target, event);
  return event;
}

afterAll(() => {
  if (originalOnPointerDown) {
    Object.defineProperty(HTMLElement.prototype, 'onpointerdown', originalOnPointerDown);
  } else {
    delete (HTMLElement.prototype as HTMLElement & { onpointerdown?: unknown }).onpointerdown;
  }
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', resolvedLanguage: 'en' },
  }),
}));

const SCOPE = { projectName: 'alpha', coordinatorSessionName: 'deck_alpha_brain' };
const NOW = 200_000;
const ORIGINAL_INNER_WIDTH = window.innerWidth;

function state(
  overrides: Partial<SupervisionTaskConsoleReducerState> = {},
): SupervisionTaskConsoleReducerState {
  return {
    ...createSupervisionTaskConsoleState(SCOPE),
    phase: SUPERVISION_TASK_CONSOLE_PHASE.READY,
    subscriptionId: 'subscription-1',
    projectionVersion: 8,
    lastDurableEventId: 21,
    projectionEpoch: 'epoch-1',
    tasks: {
      'task-1': {
        taskId: 'task-1',
        semanticKey: 'console-web',
        topLevelTaskId: 'top-1',
        title: 'Build live task console',
        status: 'implementing',
        phase: 'active',
        ownerSessionName: 'deck_alpha_worker',
        observedModel: 'gpt-5.6-sol',
        poolKind: 'primary',
        progress: { completed: 2, total: 4 },
        currentAction: 'Write component tests',
        nextAction: 'Run audit',
        validationState: 'pending',
        heartbeatAt: NOW - 120_001,
        updatedAt: NOW - 1_000,
        lastEventId: 20,
      },
      'task-2': {
        taskId: 'task-2',
        title: '<img src=x onerror=alert(1)>',
        status: 'auditing',
        phase: 'audit',
        poolKind: 'economy',
        validationState: 'passed',
        heartbeatAt: NOW - 100,
        updatedAt: NOW,
        lastEventId: 21,
      },
    },
    assignments: {
      'assignment-primary': {
        assignmentId: 'assignment-primary',
        taskId: 'task-1',
        status: 'implementing',
        phase: 'active',
        role: 'implementer',
        ownerSessionName: 'deck_alpha_worker',
        ownerSessionLabel: 'Worker One',
        observedProvider: 'codex',
        observedModel: 'gpt-5.6-sol',
        poolKind: 'primary',
        validationState: 'pending',
        sessionState: 'running',
        sessionStateSource: 'runtime',
        sessionStateObservedAt: NOW,
        heartbeatAt: NOW - 100,
        updatedAt: NOW,
        lastEventId: 20,
      },
      'assignment-economy': {
        assignmentId: 'assignment-economy',
        taskId: 'task-1',
        status: 'auditing',
        phase: 'audit',
        role: 'auditor',
        ownerSessionName: 'deck_alpha_auditor',
        observedProvider: 'claude',
        observedModel: 'claude-opus',
        poolKind: 'economy',
        validationState: 'passed',
        auditVerdict: 'PASS',
        sessionState: 'running',
        sessionStateSource: 'runtime',
        sessionStateObservedAt: NOW,
        updatedAt: NOW,
        lastEventId: 21,
      },
    },
    eventsByTask: {
      'task-1': [{ eventId: 20, projectionVersion: 7, op: 'assignment_upsert' }],
    },
    pools: [
      { poolId: 'primary', label: 'Primary', activeCount: 1, capacity: 2 },
      { poolId: 'economy', label: 'Economy', activeCount: 1, capacity: 4 },
    ],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: ORIGINAL_INNER_WIDTH,
    writable: true,
  });
});

describe('SupervisionTaskConsole', () => {
  it('offers the compact toggle to an original Brain and shared-main viewers without elevating other roles', () => {
    const onToggle = vi.fn();
    const view = render(<SupervisionTaskConsoleToggle visibility={{ session: { role: 'brain' }, shareTargetKind: null, sharedAccessRole: null }} open={false} onToggle={onToggle} />);
    const button = screen.getByRole('button', { name: 'supervision_task_console.toggle' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);

    view.rerender(<SupervisionTaskConsoleToggle visibility={{ session: { role: 'brain' }, shareTargetKind: 'main', sharedAccessRole: 'viewer' }} open={false} onToggle={onToggle} />);
    expect(screen.getByRole('button', { name: 'supervision_task_console.toggle' })).toBeTruthy();

    view.rerender(<SupervisionTaskConsoleToggle visibility={{ session: { role: 'w1' }, shareTargetKind: 'main', sharedAccessRole: 'participant' }} open={false} onToggle={onToggle} />);
    expect(screen.queryByRole('button', { name: 'supervision_task_console.toggle' })).toBeNull();
  });

  it('hides the toggle for unresolved, server-shared, and sub-session-shared scopes', () => {
    const view = render(<SupervisionTaskConsoleToggle visibility={{ session: null, shareTargetKind: 'main', sharedAccessRole: 'viewer' }} open={false} onToggle={() => {}} />);
    expect(screen.queryByRole('button', { name: 'supervision_task_console.toggle' })).toBeNull();

    view.rerender(<SupervisionTaskConsoleToggle visibility={{ session: { role: 'brain' }, shareTargetKind: 'server', sharedAccessRole: 'participant' }} open={false} onToggle={() => {}} />);
    expect(screen.queryByRole('button', { name: 'supervision_task_console.toggle' })).toBeNull();

    view.rerender(<SupervisionTaskConsoleToggle visibility={{ session: { role: 'brain' }, shareTargetKind: 'subsession', sharedAccessRole: 'viewer' }} open={false} onToggle={() => {}} />);
    expect(screen.queryByRole('button', { name: 'supervision_task_console.toggle' })).toBeNull();
  });

  it('bounds the desktop split to 720-1440px and never past 92% of the viewport', () => {
    expect(clampSupervisionConsoleWidth(1000, 4000)).toBe(1000);
    expect(clampSupervisionConsoleWidth(10, 4000)).toBe(720);
    expect(clampSupervisionConsoleWidth(99_999, 4000)).toBe(1440);
    expect(clampSupervisionConsoleWidth(1200, 1000)).toBe(920);
    expect(clampSupervisionConsoleWidth(400, 400)).toBe(368);
  });

  it('publishes the split bounds to assistive tech', () => {
    render(
      <SupervisionTaskConsoleView
        state={state()}
        mobile={false}
        now={NOW}
        width={720}
        maxWidth={920}
        onResizeKeyDown={() => {}}
        onClose={() => {}}
        onNavigateSession={() => {}}
      />,
    );
    const handle = screen.getByRole('separator', { name: 'supervision_task_console.resize' });
    expect(handle.getAttribute('aria-valuemin')).toBe('720');
    expect(handle.getAttribute('aria-valuemax')).toBe('920');
    expect(handle.getAttribute('aria-valuenow')).toBe('720');
  });

  it.each([1, 2, 3])('clamps connected drag and keyboard paths without leaking viewport state (repeat %i)', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000, writable: true });
    const view = render(
      <SupervisionTaskConsole
        ws={null}
        connected={false}
        projectName="alpha"
        coordinatorSessionName="deck_alpha_brain"
        mobile={false}
        readOnly={false}
        onClose={() => {}}
        onNavigateSession={() => {}}
      />,
    );
    const handle = screen.getByRole('separator', { name: 'supervision_task_console.resize' });
    expect(handle.getAttribute('aria-valuemax')).toBe(String(supervisionConsoleMaxWidth(1000)));

    const addListenerSpy = vi.spyOn(document, 'addEventListener');
    dispatchPointerEvent(handle, 'pointerdown', { button: 0, pointerId: 7, clientX: 500 });
    expect(addListenerSpy).toHaveBeenCalledWith('pointermove', expect.any(Function));
    dispatchPointerEvent(document, 'pointermove', { pointerId: 99, clientX: -10_000 });
    expect(handle.getAttribute('aria-valuenow')).toBe('720');
    const acceptedMove = dispatchPointerEvent(document, 'pointermove', { pointerId: 7, clientX: -10_000 });
    expect(acceptedMove.clientX).toBe(-10_000);
    expect(handle.getAttribute('aria-valuenow')).toBe('920');
    dispatchPointerEvent(document, 'pointerup', { pointerId: 7 });
    addListenerSpy.mockRestore();

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800, writable: true });
    fireEvent(window, new Event('resize'));
    expect(handle.getAttribute('aria-valuemax')).toBe('736');
    expect(handle.getAttribute('aria-valuenow')).toBe('736');
    for (let index = 0; index < 30; index += 1) fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle.getAttribute('aria-valuenow')).toBe('720');
    for (let index = 0; index < 30; index += 1) fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle.getAttribute('aria-valuenow')).toBe('736');
    view.unmount();
  });

  it('persists pointer and keyboard widths and restores the exact desktop split after remount', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200, writable: true });
    const renderConsole = () => render(
      <SupervisionTaskConsole
        ws={null}
        connected={false}
        projectName="alpha"
        coordinatorSessionName="deck_alpha_brain"
        mobile={false}
        readOnly={false}
        onClose={() => {}}
        onNavigateSession={() => {}}
      />,
    );

    let view = renderConsole();
    let handle = screen.getByRole('separator', { name: 'supervision_task_console.resize' });
    dispatchPointerEvent(handle, 'pointerdown', { button: 0, pointerId: 11, clientX: 500 });
    dispatchPointerEvent(document, 'pointermove', { pointerId: 11, clientX: 340 });
    dispatchPointerEvent(document, 'pointerup', { pointerId: 11 });
    expect(handle.getAttribute('aria-valuenow')).toBe('880');
    expect(JSON.parse(window.localStorage.getItem(SUPERVISION_TASK_CONSOLE_PREFERENCES_STORAGE_KEY)!).width).toBe(880);

    view.unmount();
    view = renderConsole();
    handle = screen.getByRole('separator', { name: 'supervision_task_console.resize' });
    expect(handle.getAttribute('aria-valuenow')).toBe('880');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle.getAttribute('aria-valuenow')).toBe('904');
    expect(JSON.parse(window.localStorage.getItem(SUPERVISION_TASK_CONSOLE_PREFERENCES_STORAGE_KEY)!).width).toBe(904);

    view.unmount();
    renderConsole();
    expect(screen.getByRole('separator', { name: 'supervision_task_console.resize' }).getAttribute('aria-valuenow')).toBe('904');
  });

  it('falls back for malformed storage and migrates the old narrow v1 width to 720', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000, writable: true });
    window.localStorage.setItem(SUPERVISION_TASK_CONSOLE_PREFERENCES_STORAGE_KEY, '{bad json');
    const props = {
      ws: null,
      connected: false,
      projectName: 'alpha',
      coordinatorSessionName: 'deck_alpha_brain',
      mobile: false,
      readOnly: false,
      onClose: () => {},
      onNavigateSession: () => {},
    };
    const view = render(<SupervisionTaskConsole {...props} />);
    expect(screen.getByRole('separator', { name: 'supervision_task_console.resize' }).getAttribute('aria-valuenow')).toBe('720');

    view.unmount();
    window.localStorage.setItem(SUPERVISION_TASK_CONSOLE_PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 1, open: true, width: 700 }));
    render(<SupervisionTaskConsole {...props} />);
    expect(screen.getByRole('separator', { name: 'supervision_task_console.resize' }).getAttribute('aria-valuenow')).toBe('720');
  });

  it('keeps the mobile panel full-screen regardless of a persisted desktop width', () => {
    window.localStorage.setItem(SUPERVISION_TASK_CONSOLE_PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 1, open: true, width: 680 }));
    render(
      <SupervisionTaskConsole
        ws={null}
        connected={false}
        projectName="alpha"
        coordinatorSessionName="deck_alpha_brain"
        mobile
        readOnly
        onClose={() => {}}
        onNavigateSession={() => {}}
      />,
    );
    const panel = screen.getByRole('dialog', { name: 'supervision_task_console.title' });
    expect(panel.getAttribute('style')).toBeNull();
    expect(screen.queryByRole('separator', { name: 'supervision_task_console.resize' })).toBeNull();
  });

  it('suppresses mutation controls for viewers while retaining them for participants', () => {
    const mutationControl = <button type="button">mutate-task</button>;
    const view = render(
      <SupervisionTaskConsoleView
        state={state()}
        mobile={false}
        readOnly
        mutationControls={mutationControl}
        onClose={() => {}}
        onNavigateSession={() => {}}
      />,
    );
    expect(screen.getByRole('complementary').getAttribute('data-read-only')).toBe('true');
    expect(screen.queryByRole('button', { name: 'mutate-task' })).toBeNull();

    view.rerender(
      <SupervisionTaskConsoleView
        state={state()}
        mobile={false}
        readOnly={false}
        mutationControls={mutationControl}
        onClose={() => {}}
        onNavigateSession={() => {}}
      />,
    );
    expect(screen.getByRole('complementary').getAttribute('data-read-only')).toBe('false');
    expect(screen.getByRole('button', { name: 'mutate-task' })).toBeTruthy();
  });

  it('sorts by authoritative attention/runtime state, never by heartbeat age', () => {
    const row = (taskId: string, status: 'implementing' | 'auditing' | 'blocked', updatedAt: number) => ({
      taskId, title: taskId, status, phase: supervisionConsoleStatusGroup(status),
      validationState: 'unknown' as const, heartbeatAt: taskId === 'idle' ? NOW : 1,
      updatedAt, lastEventId: updatedAt,
    });
    const tasks = [row('idle', 'implementing', 50), row('audit', 'auditing', 40), row('running', 'implementing', 30), row('blocked', 'blocked', 20)];
    const assignments = new Map([
      ['idle', [{ assignmentId: 'a-idle', taskId: 'idle', status: 'implementing' as const, phase: 'active' as const, role: 'implementer', validationState: 'unknown' as const, sessionState: 'idle' as const, updatedAt: 50, lastEventId: 1 }]],
      ['audit', [{ assignmentId: 'a-audit', taskId: 'audit', status: 'auditing' as const, phase: 'audit' as const, role: 'auditor', validationState: 'unknown' as const, sessionState: 'running' as const, updatedAt: 40, lastEventId: 2 }]],
      ['running', [{ assignmentId: 'a-running', taskId: 'running', status: 'implementing' as const, phase: 'active' as const, role: 'implementer', validationState: 'unknown' as const, sessionState: 'running' as const, updatedAt: 30, lastEventId: 3 }]],
    ]);
    expect(sortSupervisionConsoleTasks(tasks, assignments).map((task) => task.taskId))
      .toEqual(['blocked', 'running', 'audit', 'idle']);
  });

  it('sorts equal-priority idle tasks by authoritative session activity over contradictory task updates', () => {
    const tasks = [
      {
        taskId: 'session-1000', title: 'Session 1000', status: 'implementing' as const,
        phase: 'active' as const, validationState: 'unknown' as const,
        updatedAt: 10, lastEventId: 1,
      },
      {
        taskId: 'session-50', title: 'Session 50', status: 'implementing' as const,
        phase: 'active' as const, validationState: 'unknown' as const,
        updatedAt: 10_000, lastEventId: 2,
      },
    ];
    const assignments = new Map([
      ['session-1000', [{
        assignmentId: 'assignment-1000', taskId: 'session-1000', status: 'implementing' as const,
        phase: 'active' as const, role: 'implementer', validationState: 'unknown' as const, sessionState: 'idle' as const,
        sessionStateObservedAt: 1_000, updatedAt: 20, lastEventId: 3,
      }]],
      ['session-50', [{
        assignmentId: 'assignment-50', taskId: 'session-50', status: 'implementing' as const,
        phase: 'active' as const, role: 'implementer', validationState: 'unknown' as const, sessionState: 'idle' as const,
        sessionStateObservedAt: 50, updatedAt: 9_000, lastEventId: 4,
      }]],
    ]);

    expect(sortSupervisionConsoleTasks(tasks, assignments).map((task) => task.taskId))
      .toEqual(['session-1000', 'session-50']);
  });

  it('sorts pending tasks by task activity rather than a shared session running elsewhere', () => {
    const tasks = [
      {
        taskId: 'older-pending', title: 'Older pending', status: 'ready_for_audit' as const,
        phase: 'audit' as const, validationState: 'pending' as const,
        updatedAt: 10, lastEventId: 1,
      },
      {
        taskId: 'newer-pending', title: 'Newer pending', status: 'ready_for_audit' as const,
        phase: 'audit' as const, validationState: 'pending' as const,
        updatedAt: 20, lastEventId: 2,
      },
    ];
    const assignments = new Map([
      ['older-pending', [{
        assignmentId: 'older-worker', taskId: 'older-pending', status: 'implementing' as const,
        phase: 'active' as const, role: 'implementer', validationState: 'pending' as const,
        sessionState: 'running' as const, sessionStateObservedAt: 10_000, updatedAt: 10_000, lastEventId: 3,
      }]],
      ['newer-pending', [{
        assignmentId: 'newer-worker', taskId: 'newer-pending', status: 'implementing' as const,
        phase: 'active' as const, role: 'implementer', validationState: 'pending' as const,
        sessionState: 'idle' as const, sessionStateObservedAt: 1, updatedAt: 1, lastEventId: 4,
      }]],
    ]);

    expect(sortSupervisionConsoleTasks(tasks, assignments).map((task) => task.taskId))
      .toEqual(['newer-pending', 'older-pending']);
  });

  it('uses exact production roles for implementer navigation and runtime priority', () => {
    const task = {
      taskId: 'production-shape', title: 'Production role shape', status: 'implementing' as const,
      phase: 'active' as const, validationState: 'pending' as const,
      updatedAt: 10, lastEventId: 30,
    };
    const auditRunningTask = {
      taskId: 'audit-running', title: 'Audit running', status: 'auditing' as const,
      phase: 'audit' as const, validationState: 'pending' as const,
      updatedAt: 9, lastEventId: 31,
    };
    const productionAssignments = [{
      assignmentId: 'coordinator', taskId: task.taskId, status: 'implementing' as const,
      phase: 'active' as const, role: 'coordinator', ownerSessionName: 'deck_alpha_brain',
      ownerSessionLabel: 'Coordinator', validationState: 'unknown' as const,
      sessionState: 'running' as const, sessionStateObservedAt: 1_001, updatedAt: 1_001, lastEventId: 40,
    }, {
      assignmentId: 'integration-owner', taskId: task.taskId, status: 'ready_for_integration' as const,
      phase: 'integration' as const, role: 'integration_owner', ownerSessionName: 'deck_alpha_integrator',
      ownerSessionLabel: 'Integrator', validationState: 'passed' as const,
      sessionState: 'running' as const, sessionStateObservedAt: 1_000, updatedAt: 1_000, lastEventId: 41,
    }, {
      assignmentId: 'malformed-role', taskId: task.taskId, status: 'implementing' as const,
      phase: 'active' as const, role: 'Implementer', ownerSessionName: 'deck_alpha_impostor',
      ownerSessionLabel: 'Malformed Role', validationState: 'unknown' as const,
      sessionState: 'running' as const, sessionStateObservedAt: 999, updatedAt: 999, lastEventId: 42,
    }, {
      assignmentId: 'implementer', taskId: task.taskId, status: 'implementing' as const,
      phase: 'active' as const, role: 'implementer', ownerSessionName: 'deck_alpha_worker',
      ownerSessionLabel: 'True Worker', validationState: 'pending' as const,
      sessionState: 'idle' as const, sessionStateObservedAt: 100, updatedAt: 100, lastEventId: 43,
    }, {
      assignmentId: 'auditor', taskId: task.taskId, status: 'auditing' as const,
      phase: 'audit' as const, role: 'auditor', ownerSessionName: 'deck_alpha_auditor',
      ownerSessionLabel: 'True Auditor', validationState: 'pending' as const,
      sessionState: 'idle' as const, sessionStateObservedAt: 200, updatedAt: 200, lastEventId: 44,
    }];
    const auditRunningAssignments = [{
      assignmentId: 'other-auditor', taskId: auditRunningTask.taskId, status: 'auditing' as const,
      phase: 'audit' as const, role: 'auditor', validationState: 'pending' as const,
      sessionState: 'running' as const, sessionStateObservedAt: 50, updatedAt: 50, lastEventId: 45,
    }];

    expect(sortSupervisionConsoleTasks(
      [task, auditRunningTask],
      new Map([[task.taskId, productionAssignments], [auditRunningTask.taskId, auditRunningAssignments]]),
    ).map((row) => row.taskId)).toEqual(['audit-running', 'production-shape']);

    const onNavigateSession = vi.fn();
    render(<SupervisionTaskConsoleView
      state={state({
        tasks: { [task.taskId]: task },
        assignments: Object.fromEntries(productionAssignments.map((assignment) => [assignment.assignmentId, assignment])),
      })}
      mobile={false}
      onClose={() => {}}
      onNavigateSession={onNavigateSession}
    />);

    expect(screen.getByTestId(`task-card-${task.taskId}`).getAttribute('data-activity-state')).toBe('idle');
    expect(screen.queryByText('Coordinator')).toBeNull();
    expect(screen.queryByText('Integrator')).toBeNull();
    expect(screen.queryByText('Malformed Role')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /True Worker/ }));
    fireEvent.click(screen.getByRole('button', { name: /True Auditor/ }));
    expect(onNavigateSession.mock.calls).toEqual([
      ['deck_alpha_worker'],
      ['deck_alpha_auditor'],
    ]);
  });

  it('provides keyboard tabs, moves terminal tasks to history, and preserves expanded details', () => {
    const initial = state();
    const finalized = {
      taskId: 'task-complete', title: 'Released task', status: 'finalized' as const, phase: 'final' as const,
      validationState: 'passed' as const, updatedAt: NOW + 1, lastEventId: 22,
    };
    const cancelled = {
      taskId: 'task-cancelled', title: 'Cancelled task', status: 'cancelled' as const, phase: 'final' as const,
      validationState: 'failed' as const, updatedAt: NOW + 2, lastEventId: 23,
    };
    const staleRunningAssignment = {
      assignmentId: 'cancelled-running', taskId: cancelled.taskId, status: 'implementing' as const,
      phase: 'active' as const, role: 'implementer', ownerSessionName: 'deck_alpha_old_worker',
      ownerSessionLabel: 'Stale Running Worker', validationState: 'pending' as const,
      sessionState: 'running' as const, sessionStateSource: 'runtime' as const,
      sessionStateObservedAt: NOW + 3, updatedAt: NOW + 3, lastEventId: 24,
    };
    render(<SupervisionTaskConsoleView state={state({
      tasks: { ...initial.tasks, [finalized.taskId]: finalized, [cancelled.taskId]: cancelled },
      assignments: { ...initial.assignments, [staleRunningAssignment.assignmentId]: staleRunningAssignment },
    })} mobile={false} onClose={() => {}} onNavigateSession={() => {}} />);
    const active = screen.getByRole('tab', { name: /supervision_task_console.tab_active/ });
    fireEvent.click(screen.getByText('Build live task console'));
    expect(screen.queryByText('Cancelled task')).toBeNull();
    expect(screen.queryByText('Released task')).toBeNull();
    fireEvent.keyDown(active, { key: 'ArrowRight' });
    const pendingTab = screen.getByRole('tab', { name: /supervision_task_console.tab_pending/ });
    expect(document.activeElement).toBe(pendingTab);
    expect(pendingTab.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(pendingTab, { key: 'ArrowRight' });
    const historyTab = screen.getByRole('tab', { name: /supervision_task_console.tab_history/ });
    expect(document.activeElement).toBe(historyTab);
    expect(historyTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Released task')).toBeTruthy();
    expect(screen.getByText('Cancelled task')).toBeTruthy();
    const cancelledCard = screen.getByTestId('task-card-task-cancelled');
    expect(cancelledCard.getAttribute('data-activity-state')).toBe('terminal');
    expect(cancelledCard.textContent).not.toContain('supervision_task_console.session_state.running');
    expect(cancelledCard.textContent).toContain('supervision_task_console.status.cancelled');
    expect(screen.getByText('Stale Running Worker')).toBeTruthy();
    fireEvent.keyDown(historyTab, { key: 'Home' });
    expect(document.activeElement).toBe(active);
    expect(screen.getByText('supervision_task_console.event_op.assignment_upsert')).toBeTruthy();
  });

  it('limits history to ten rows until show-more is requested', () => {
    const tasks = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`done-${index}`, {
      taskId: `done-${index}`, title: `Done ${index}`, status: 'pushed' as const, phase: 'final' as const,
      validationState: 'passed' as const, updatedAt: NOW - index, lastEventId: index + 1,
    }]));
    render(<SupervisionTaskConsoleView state={state({ tasks, assignments: {} })} mobile={false} onClose={() => {}} onNavigateSession={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: /supervision_task_console.tab_history/ }));
    expect(screen.getAllByTestId(/task-card-/)).toHaveLength(10);
    fireEvent.click(screen.getByRole('button', { name: 'supervision_task_console.show_more' }));
    expect(screen.getAllByTestId(/task-card-/)).toHaveLength(12);
  });

  it('keeps a cancelled-heavy production projection out of the default active tab', () => {
    const cancelledTasks = Object.fromEntries(Array.from({ length: 36 }, (_, index) => [`cancelled-${index}`, {
      taskId: `cancelled-${index}`, title: `Cancelled load ${index}`, status: 'cancelled' as const,
      phase: 'final' as const, validationState: 'failed' as const,
      updatedAt: NOW - index, lastEventId: 100 + index,
    }]));
    const cancelledAssignments = Object.fromEntries(Array.from({ length: 36 }, (_, index) => [`cancelled-assignment-${index}`, {
      assignmentId: `cancelled-assignment-${index}`, taskId: `cancelled-${index}`,
      status: 'implementing' as const, phase: 'active' as const, role: 'implementer',
      ownerSessionName: `deck_alpha_cancelled_${index}`, validationState: 'pending' as const,
      sessionState: 'running' as const, sessionStateSource: 'runtime' as const,
      sessionStateObservedAt: NOW, updatedAt: NOW, lastEventId: 200 + index,
    }]));
    const activeTasks = {
      implementing: {
        taskId: 'implementing', title: 'Still implementing', status: 'implementing' as const,
        phase: 'active' as const, validationState: 'pending' as const, updatedAt: NOW + 1, lastEventId: 301,
      },
      auditing: {
        taskId: 'auditing', title: 'Still auditing', status: 'auditing' as const,
        phase: 'audit' as const, validationState: 'pending' as const, updatedAt: NOW + 2, lastEventId: 302,
      },
    };
    render(<SupervisionTaskConsoleView state={state({
      tasks: { ...cancelledTasks, ...activeTasks },
      assignments: cancelledAssignments,
    })} mobile={false} onClose={() => {}} onNavigateSession={() => {}} />);

    expect(screen.getAllByTestId(/task-card-/)).toHaveLength(2);
    expect(screen.getByText('Still implementing')).toBeTruthy();
    expect(screen.getByText('Still auditing')).toBeTruthy();
    expect(screen.queryByText('Cancelled load 0')).toBeNull();
    const historyTab = screen.getByRole('tab', { name: /supervision_task_console\.tab_history 36/ });
    fireEvent.click(historyTab);
    for (let page = 10; page < 36; page += 10) {
      fireEvent.click(screen.getByRole('button', { name: 'supervision_task_console.show_more' }));
    }
    const historyCards = screen.getAllByTestId(/task-card-/);
    expect(historyCards).toHaveLength(36);
    expect(historyCards.every((card) => card.getAttribute('data-status') === 'cancelled')).toBe(true);
    expect(historyCards.every((card) => card.getAttribute('data-activity-state') === 'terminal')).toBe(true);
    expect(screen.queryByText('Still implementing')).toBeNull();
    expect(screen.queryByText('Still auditing')).toBeNull();
  });

  it('reduces the production-shaped 126 active count to ten and isolates pending runtime appearance', () => {
    const statusCounts = [
      ['planned', 48],
      ['delegated', 19],
      ['implementing', 10],
      ['validated', 2],
      ['ready_for_audit', 17],
      ['auditing', 0],
      ['rework', 5],
      ['ready_for_integration', 25],
      ['blocked', 2],
    ] as const;
    const rows = statusCounts.flatMap(([status, count]) => Array.from({ length: count }, (_, index) => {
      const taskId = `${status}-${index}`;
      return [taskId, {
        taskId,
        title: `${status} ${index}`,
        status,
        phase: supervisionConsoleStatusGroup(status),
        validationState: 'pending' as const,
        updatedAt: NOW - index,
        lastEventId: index + 1,
      }] as const;
    }));
    expect(rows.filter(([, task]) => task.status !== 'blocked')).toHaveLength(126);
    const tasks = Object.fromEntries(rows);
    const assignments = Object.fromEntries(rows.map(([taskId, task], index) => [`assignment-${taskId}`, {
      assignmentId: `assignment-${taskId}`,
      taskId,
      status: task.status,
      phase: task.phase,
      role: 'implementer',
      ownerSessionName: 'deck_alpha_shared_worker',
      ownerSessionLabel: 'Shared current worker',
      validationState: 'pending' as const,
      sessionState: 'running' as const,
      sessionStateSource: 'runtime' as const,
      sessionStateObservedAt: NOW + index,
      updatedAt: NOW + index,
      lastEventId: 500 + index,
    }]));

    render(<SupervisionTaskConsoleView
      state={state({ tasks, assignments })}
      mobile={false}
      onClose={() => {}}
      onNavigateSession={() => {}}
    />);

    expect(screen.getByRole('tab', { name: /supervision_task_console\.tab_active 10/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /supervision_task_console\.tab_pending 118/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /supervision_task_console\.tab_history 0/ })).toBeTruthy();
    expect(screen.getAllByTestId(/task-card-/)).toHaveLength(10);
    expect(screen.getAllByTestId(/task-card-/).every((card) => card.getAttribute('data-status') === 'implementing')).toBe(true);

    fireEvent.click(screen.getByRole('tab', { name: /supervision_task_console\.tab_pending 118/ }));
    const pendingCards = screen.getAllByTestId(/task-card-/);
    expect(pendingCards).toHaveLength(118);
    expect(pendingCards.every((card) => !['running', 'audit-running'].includes(card.getAttribute('data-activity-state') ?? ''))).toBe(true);
    expect(pendingCards.every((card) => !card.textContent?.includes('supervision_task_console.session_state.running'))).toBe(true);
    expect(Array.from(document.querySelectorAll('.supervision-task-console-session')).every((row) => (
      row.getAttribute('data-task-tab') === 'pending' && row.getAttribute('data-session-state') === null
    ))).toBe(true);
  });

  it('renders distinct localized empty states for active, pending, and history tabs', () => {
    const ended = {
      taskId: 'ended-only', title: 'Ended only', status: 'finalized' as const,
      phase: 'final' as const, validationState: 'passed' as const, updatedAt: NOW, lastEventId: 1,
    };
    const view = render(<SupervisionTaskConsoleView state={state({ tasks: { [ended.taskId]: ended }, assignments: {} })} mobile={false} onClose={() => {}} onNavigateSession={() => {}} />);
    expect(screen.getByText('supervision_task_console.no_active')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /supervision_task_console.tab_pending/ }));
    expect(screen.getByText('supervision_task_console.no_pending')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /supervision_task_console.tab_history/ }));
    expect(screen.getByText('Ended only')).toBeTruthy();

    const active = {
      taskId: 'active-only', title: 'Active only', status: 'implementing' as const,
      phase: 'active' as const, validationState: 'pending' as const, updatedAt: NOW, lastEventId: 2,
    };
    view.rerender(<SupervisionTaskConsoleView state={state({ tasks: { [active.taskId]: active }, assignments: {} })} mobile={false} onClose={() => {}} onNavigateSession={() => {}} />);
    expect(screen.getByText('supervision_task_console.no_history')).toBeTruthy();
  });

  it('renders compact tabs and authoritative role states without heartbeat inference', () => {
    const onNavigateSession = vi.fn();
    const onResizeKeyDown = vi.fn();
    const view = render(
      <SupervisionTaskConsoleView
        state={state()}
        mobile={false}
        now={NOW}
        width={720}
        onResizeKeyDown={onResizeKeyDown}
        onClose={() => {}}
        onNavigateSession={onNavigateSession}
      />,
    );
    expect(screen.getByRole('complementary', { name: 'supervision_task_console.title' })).toBeTruthy();
    const separator = screen.getByRole('separator', { name: 'supervision_task_console.resize' });
    expect(separator.getAttribute('aria-valuenow')).toBe('720');
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(onResizeKeyDown).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('tab', { name: /supervision_task_console.tab_active/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /supervision_task_console.tab_pending/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /supervision_task_console.tab_history/ })).toBeTruthy();
    expect(screen.queryByText('supervision_task_console.heartbeat_stale')).toBeNull();
    expect(readFileSync(resolve(import.meta.dirname, '../../src/components/SupervisionTaskConsole.tsx'), 'utf8')).not.toMatch(/heartbeat/i);
    expect(screen.getAllByText(/supervision_task_console\.session_state\.running/)).toHaveLength(2);
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(view.container.querySelector('img')).toBeNull();

    fireEvent.click(screen.getByText('Build live task console'));
    expect(screen.getByText('supervision_task_console.event_op.assignment_upsert')).toBeTruthy();
    const taskSummary = screen.getByText('Build live task console').closest('button')!;
    expect(taskSummary.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /Worker One/ }));
    expect(onNavigateSession).toHaveBeenCalledWith('deck_alpha_worker');
    expect(taskSummary.getAttribute('aria-expanded')).toBe('true');
  });

  it('uses an accessible mobile dialog and closes on Escape', async () => {
    const onClose = vi.fn();
    const returnTarget = document.createElement('button');
    document.body.append(returnTarget);
    const returnFocusRef = { current: returnTarget };
    const view = render(
      <SupervisionTaskConsoleView
        state={state()}
        mobile
        now={NOW}
        onClose={onClose}
        onNavigateSession={() => {}}
        returnFocusRef={returnFocusRef}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'supervision_task_console.title' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const close = screen.getByRole('button', { name: 'common.close' });
    await waitFor(() => expect(document.activeElement).toBe(close));
    const focusable = [...view.container.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
    const last = focusable[focusable.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(returnTarget));
    returnTarget.remove();
  });

  it('preserves task focus while replaying the transition highlight for a new event', () => {
    const initial = state();
    const view = render(
      <SupervisionTaskConsoleView state={initial} mobile={false} now={NOW} onClose={() => {}} onNavigateSession={() => {}} />,
    );
    const summary = screen.getByText('Build live task console').closest('button') as HTMLButtonElement;
    summary.focus();
    const task = initial.tasks['task-1'];
    view.rerender(
      <SupervisionTaskConsoleView
        state={state({ tasks: { ...initial.tasks, 'task-1': { ...task, lastEventId: 22, updatedAt: NOW } } })}
        mobile={false}
        now={NOW}
        onClose={() => {}}
        onNavigateSession={() => {}}
      />,
    );
    expect(document.activeElement).toBe(screen.getByText('Build live task console').closest('button'));
    expect(screen.getByTestId('task-card-task-1').querySelector('.supervision-task-console-transition')).toBeTruthy();
  });

  it('renders loading, empty, error, recovery, and unsupported-contract states', () => {
    const view = render(
      <SupervisionTaskConsoleView
        state={state({ phase: SUPERVISION_TASK_CONSOLE_PHASE.SUBSCRIBING, tasks: {}, assignments: {} })}
        mobile={false}
        now={NOW}
        onClose={() => {}}
        onNavigateSession={() => {}}
      />,
    );
    expect(screen.getByText('supervision_task_console.loading')).toBeTruthy();
    view.rerender(<SupervisionTaskConsoleView state={state({ tasks: {}, assignments: {} })} mobile={false} now={NOW} onClose={() => {}} onNavigateSession={() => {}} />);
    expect(screen.getByText('supervision_task_console.empty')).toBeTruthy();
    view.rerender(<SupervisionTaskConsoleView state={state({ phase: SUPERVISION_TASK_CONSOLE_PHASE.ERROR })} mobile={false} now={NOW} onClose={() => {}} onNavigateSession={() => {}} />);
    expect(screen.getByRole('alert').textContent).toContain('supervision_task_console.error');
    view.rerender(<SupervisionTaskConsoleView state={state({ phase: SUPERVISION_TASK_CONSOLE_PHASE.RESYNCING, resyncReason: 'version_gap' })} mobile={false} now={NOW} onClose={() => {}} onNavigateSession={() => {}} />);
    expect(screen.getByText('supervision_task_console.recovering')).toBeTruthy();
    view.rerender(<SupervisionTaskConsoleView state={state({ phase: SUPERVISION_TASK_CONSOLE_PHASE.RESYNCING, resyncReason: 'status_contract_mismatch' })} mobile={false} now={NOW} onClose={() => {}} onNavigateSession={() => {}} />);
    expect(screen.getByRole('alert').textContent).toContain('supervision_task_console.unsupported');
  });

  it('has a localized label for every fixed status and disables transition motion when requested', () => {
    const statusTasks = Object.fromEntries(SUPERVISION_TASK_LIFECYCLE_STATUSES.map((status, index) => [status, {
      taskId: status,
      title: `Task ${status}`,
      status,
      phase: supervisionConsoleStatusGroup(status),
      validationState: 'unknown' as const,
      currentAction: 'Contract row',
      updatedAt: NOW - index,
      lastEventId: index + 1,
    }]));
    render(
      <SupervisionTaskConsoleView
        state={state({ tasks: statusTasks, assignments: {} })}
        mobile={false}
        now={NOW}
        onClose={() => {}}
        onNavigateSession={() => {}}
      />,
    );
    const activeStatuses = ['implementing', 'retrying_external_ci', 'auditing', 'integrating', 'final_audit', 'finalizing'];
    const pendingStatuses = ['planned', 'delegated', 'validated', 'ready_for_audit', 'rework', 'passed', 'ready_for_integration', 'blocked'];
    const historyStatuses = ['committed', 'pushed', 'recovered', 'finalized', 'cancelled'];
    expect(screen.getByRole('tab', { name: /supervision_task_console\.tab_active 6/ })).toBeTruthy();
    for (const status of activeStatuses) {
      expect(screen.getByText(`supervision_task_console.status.${status}`)).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('tab', { name: /supervision_task_console\.tab_pending 8/ }));
    for (const status of pendingStatuses) {
      expect(screen.getByText(`supervision_task_console.status.${status}`)).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('tab', { name: /supervision_task_console.tab_history/ }));
    for (const status of historyStatuses) {
      expect(screen.getByText(`supervision_task_console.status.${status}`)).toBeTruthy();
    }
    const css = readFileSync(resolve(import.meta.dirname, '../../src/styles.css'), 'utf8');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?activity-running[\s\S]*?animation:\s*none/);
    expect(css).toMatch(/container-name:\s*supervision-console/);
    expect(css).toMatch(/@container supervision-console \(min-width: 1080px\)[\s\S]*?grid-template-columns:\s*repeat\(2/);
    expect(css).toMatch(/supervision-task-console-tabs[\s\S]*?grid-template-columns:\s*repeat\(3/);
    expect(css).toMatch(/activity-pending[\s\S]*?animation:\s*none/);
    expect(css).toMatch(/activity-terminal[\s\S]*?animation:\s*none/);
    const app = readFileSync(resolve(import.meta.dirname, '../../src/app.tsx'), 'utf8');
    expect(app).toMatch(/onNavigateSession=\{\(sessionName\) => \{\s*navigateToSession\(sessionName\);/);
    expect(app).toMatch(/<SupervisionTaskConsole[\s\S]*?connected=\{connected && daemonOnline\}/);
  });
});
