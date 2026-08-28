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

  it('bounds the desktop split to 320-720px and never past 65% of the viewport', () => {
    expect(clampSupervisionConsoleWidth(500, 4000)).toBe(500);
    expect(clampSupervisionConsoleWidth(10, 4000)).toBe(320);
    expect(clampSupervisionConsoleWidth(99_999, 4000)).toBe(720);
    expect(clampSupervisionConsoleWidth(720, 1000)).toBe(650);
    expect(clampSupervisionConsoleWidth(400, 400)).toBe(320);
  });

  it('publishes the split bounds to assistive tech', () => {
    render(
      <SupervisionTaskConsoleView
        state={state()}
        mobile={false}
        now={NOW}
        width={420}
        maxWidth={650}
        onResizeKeyDown={() => {}}
        onClose={() => {}}
        onNavigateSession={() => {}}
      />,
    );
    const handle = screen.getByRole('separator', { name: 'supervision_task_console.resize' });
    expect(handle.getAttribute('aria-valuemin')).toBe('320');
    expect(handle.getAttribute('aria-valuemax')).toBe('650');
    expect(handle.getAttribute('aria-valuenow')).toBe('420');
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
    expect(handle.getAttribute('aria-valuenow')).toBe('420');
    const acceptedMove = dispatchPointerEvent(document, 'pointermove', { pointerId: 7, clientX: -10_000 });
    expect(acceptedMove.clientX).toBe(-10_000);
    expect(handle.getAttribute('aria-valuenow')).toBe('650');
    dispatchPointerEvent(document, 'pointerup', { pointerId: 7 });
    addListenerSpy.mockRestore();

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800, writable: true });
    fireEvent(window, new Event('resize'));
    expect(handle.getAttribute('aria-valuemax')).toBe('520');
    expect(handle.getAttribute('aria-valuenow')).toBe('520');
    for (let index = 0; index < 30; index += 1) fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle.getAttribute('aria-valuenow')).toBe('320');
    for (let index = 0; index < 30; index += 1) fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle.getAttribute('aria-valuenow')).toBe('520');
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
    expect(handle.getAttribute('aria-valuenow')).toBe('580');
    expect(JSON.parse(window.localStorage.getItem(SUPERVISION_TASK_CONSOLE_PREFERENCES_STORAGE_KEY)!).width).toBe(580);

    view.unmount();
    view = renderConsole();
    handle = screen.getByRole('separator', { name: 'supervision_task_console.resize' });
    expect(handle.getAttribute('aria-valuenow')).toBe('580');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle.getAttribute('aria-valuenow')).toBe('604');
    expect(JSON.parse(window.localStorage.getItem(SUPERVISION_TASK_CONSOLE_PREFERENCES_STORAGE_KEY)!).width).toBe(604);

    view.unmount();
    renderConsole();
    expect(screen.getByRole('separator', { name: 'supervision_task_console.resize' }).getAttribute('aria-valuenow')).toBe('604');
  });

  it('falls back for malformed width storage and clamps restored width to the current 65vw cap', () => {
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
    expect(screen.getByRole('separator', { name: 'supervision_task_console.resize' }).getAttribute('aria-valuenow')).toBe('420');

    view.unmount();
    window.localStorage.setItem(SUPERVISION_TASK_CONSOLE_PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 1, open: true, width: 700 }));
    render(<SupervisionTaskConsole {...props} />);
    expect(screen.getByRole('separator', { name: 'supervision_task_console.resize' }).getAttribute('aria-valuenow')).toBe('650');
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

  it('renders grouped real-time evidence, two pools, stale heartbeat, and canonical owner navigation', () => {
    const onNavigateSession = vi.fn();
    const onResizeKeyDown = vi.fn();
    const view = render(
      <SupervisionTaskConsoleView
        state={state()}
        mobile={false}
        now={NOW}
        width={420}
        onResizeKeyDown={onResizeKeyDown}
        onClose={() => {}}
        onNavigateSession={onNavigateSession}
      />,
    );
    expect(screen.getByRole('complementary', { name: 'supervision_task_console.title' })).toBeTruthy();
    const separator = screen.getByRole('separator', { name: 'supervision_task_console.resize' });
    expect(separator.getAttribute('aria-valuenow')).toBe('420');
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(onResizeKeyDown).toHaveBeenCalledTimes(1);
    expect(screen.getByText('supervision_task_console.group.active')).toBeTruthy();
    expect(screen.getByText('supervision_task_console.group.audit')).toBeTruthy();
    expect(screen.getByText('supervision_task_console.heartbeat_stale')).toBeTruthy();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(view.container.querySelector('img')).toBeNull();

    fireEvent.click(screen.getByText('Build live task console'));
    expect(screen.getAllByText('supervision_task_console.pool_kind.primary').length).toBeGreaterThan(0);
    expect(screen.getAllByText('supervision_task_console.pool_kind.economy').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId(/task-assignment-/)).toHaveLength(2);
    expect(screen.getByText('supervision_task_console.event_op.assignment_upsert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Worker One/ }));
    expect(onNavigateSession).toHaveBeenCalledWith('deck_alpha_worker');
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
    const summaries = [...view.container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')];
    const last = summaries[summaries.length - 1];
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
    for (const status of SUPERVISION_TASK_LIFECYCLE_STATUSES) {
      expect(screen.getByText(`supervision_task_console.status.${status}`)).toBeTruthy();
    }
    const css = readFileSync(resolve(import.meta.dirname, '../../src/styles.css'), 'utf8');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.supervision-task-console-transition\s*\{\s*animation:\s*none/);
    const app = readFileSync(resolve(import.meta.dirname, '../../src/app.tsx'), 'utf8');
    expect(app).toMatch(/onNavigateSession=\{\(sessionName\) => \{\s*navigateToSession\(sessionName\);/);
    expect(app).toMatch(/<SupervisionTaskConsole[\s\S]*?connected=\{connected && daemonOnline\}/);
  });
});
