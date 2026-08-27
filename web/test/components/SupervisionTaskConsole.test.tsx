/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import {
  SUPERVISION_TASK_CONSOLE_PHASE,
  createSupervisionTaskConsoleState,
  type SupervisionTaskConsoleReducerState,
} from '../../src/supervision-task-console-reducer.js';

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
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: ORIGINAL_INNER_WIDTH,
    writable: true,
  });
});

describe('SupervisionTaskConsole', () => {
  it('offers the compact toggle only for a main coordinator session', () => {
    const onToggle = vi.fn();
    const view = render(<SupervisionTaskConsoleToggle session={{ role: 'brain' }} open={false} onToggle={onToggle} />);
    const button = screen.getByRole('button', { name: 'supervision_task_console.toggle' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);

    view.rerender(<SupervisionTaskConsoleToggle session={{ role: 'w1' }} open={false} onToggle={onToggle} />);
    expect(screen.queryByRole('button', { name: 'supervision_task_console.toggle' })).toBeNull();
  });

  it('hides the toggle whenever there is no coordinator session to scope it to', () => {
    render(<SupervisionTaskConsoleToggle session={null} open={false} onToggle={() => {}} />);
    expect(screen.queryByRole('button', { name: 'supervision_task_console.toggle' })).toBeNull();

    cleanup();
    render(<SupervisionTaskConsoleToggle session={undefined} open={false} onToggle={() => {}} />);
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
        onClose={() => {}}
        onNavigateSession={() => {}}
      />,
    );
    const handle = screen.getByRole('separator', { name: 'supervision_task_console.resize' });
    expect(handle.getAttribute('aria-valuemax')).toBe(String(supervisionConsoleMaxWidth(1000)));

    fireEvent.pointerDown(handle, { button: 0, pointerId: 7, clientX: 500 });
    fireEvent.pointerMove(document, { pointerId: 7, clientX: -10_000 });
    expect(handle.getAttribute('aria-valuenow')).toBe('650');
    fireEvent.pointerUp(document, { pointerId: 7 });

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
  });
});
