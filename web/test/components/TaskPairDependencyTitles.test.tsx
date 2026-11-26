/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupervisionConsolePairInfo } from '@shared/supervision-task-console.js';
import { projectPairScheduling, readPairScheduling, type TaskPairScheduling } from '@shared/task-pair-suspension.js';
import { TASK_PAIR_DECISION_KIND, TASK_PAIR_DECISION_MSG } from '@shared/task-pair-decision.js';
import { formatTaskPairDependencyTasks } from '@shared/task-pair-display.js';
import { TaskPairDecisionPanel } from '../../src/components/TaskPairDecisionPanel.js';
import { TaskPairEventDecisions } from '../../src/components/TaskPairEventDecisions.js';
import { TaskPairStatusPanel } from '../../src/components/TaskPairStatusPanel.js';
import { TASK_PAIR_SNAPSHOT_EVENT } from '@shared/task-pair.js';
import { bindTaskPairDecisions, receiveTaskPairDecision } from '../../src/task-pair-decisions.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));

const BASE_SCHEDULING: TaskPairScheduling = {
  epoch: 1,
  manual: false,
  dependsOn: [],
  admitted: true,
  resumePending: false,
  details: { brief: { manual: false, dependsOn: [] } },
};

function makePair(overrides: Partial<SupervisionConsolePairInfo> = {}): SupervisionConsolePairInfo {
  return {
    status: 'queued',
    round: 0,
    flags: [],
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

describe('dependency title resolution across Task Pair panels', () => {
  afterEach(() => {
    cleanup();
    delete (window as { __imcodesTaskPairSnapshot?: unknown }).__imcodesTaskPairSnapshot;
    localStorage.clear();
  });

  it('TaskPairDecisionPanel resolves dependsOn IDs via taskTitles, scheduling.details.brief.dependencyTitles, and ID fallback', () => {
    const scheduling = projectPairScheduling(
      { ...BASE_SCHEDULING, dependsOn: ['tsk_done_1', 'tsk_brief_2', 'tsk_missing_3', 'tsk_placeholder_4'] },
      { tsk_brief_2: 'Brief dependency title' },
    );
    const taskTitles = new Map([
      ['tsk_done_1', 'Completed upstream title'],
      ['tsk_placeholder_4', 'tsk_placeholder_4'],
    ]);

    const { container } = render(
      <TaskPairDecisionPanel
        taskId="tsk_child"
        pair={makePair({ scheduling })}
        taskTitles={taskTitles}
      />,
    );

    const text = container.textContent ?? '';
    expect(text).toContain('Completed upstream title');
    expect(text).toContain('Brief dependency title');
    expect(text).toContain('tsk_missing_3');
    expect(text).toContain('tsk_placeholder_4');
    expect(text).not.toContain('tsk_done_1');
    expect(text).not.toContain('tsk_brief_2');
  });

  it('TaskPairStatusPanel resolves dependency titles in both wait meta and TaskPairDecisionPanel', async () => {
    const scheduling = projectPairScheduling({
      ...BASE_SCHEDULING,
      dependsOn: ['tsk_finished', 'tsk_active', 'tsk_wire_only', 'tsk_unknown'],
      note: 'Waiting on dependencies',
    }, {
      tsk_wire_only: 'Wire projected dependency',
    });

    const events = [
      {
        eventId: 'ev-active',
        type: 'task_pair.event',
        ts: 1_000,
        payload: {
          taskId: 'tsk_active',
          title: 'Active sibling title',
          toStatus: 'working',
          round: 0,
        },
      },
      {
        eventId: 'ev-child',
        type: 'task_pair.event',
        ts: 2_000,
        payload: {
          taskId: 'tsk_waiting_child',
          title: 'Child waiting task',
          toStatus: 'queued',
          round: 0,
          scheduling,
        },
      },
    ] as never;

    const { container } = render(<TaskPairStatusPanel events={events} serverId="srv-1" />);
    await act(async () => {
      window.dispatchEvent(new CustomEvent(TASK_PAIR_SNAPSHOT_EVENT, {
        detail: {
          tasks: [
            {
              taskId: 'tsk_active',
              title: 'Active sibling title',
              updatedAt: 1_500,
              pair: makePair({ status: 'working' }),
            },
            {
              taskId: 'tsk_waiting_child',
              title: 'Child waiting task',
              updatedAt: 2_000,
              pair: makePair({ scheduling }),
            },
          ],
          taskTitles: {
            tsk_active: 'Active sibling title',
            tsk_finished: 'Finished macOS packaging task',
            tsk_waiting_child: 'Child waiting task',
          },
          assignments: [],
        },
      }));
    });

    await waitFor(() => {
      const childRow = Array.from(container.querySelectorAll('.task-pair-status-row'))
        .find((row) => (row.textContent ?? '').includes('Child waiting task'));
      const meta = childRow?.querySelector('.task-pair-status-row-meta')?.textContent ?? '';
      expect(meta).toContain('Finished macOS packaging task');
      expect(meta).toContain('Active sibling title');
      expect(meta).toContain('Wire projected dependency');
      expect(meta).toContain('tsk_unknown');
      expect(meta).not.toContain('tsk_finished');
      expect(meta).not.toContain('tsk_active');
      expect(meta).not.toContain('tsk_wire_only');

      const decisionText = childRow?.querySelector('.task-pair-decision')?.textContent ?? '';
      expect(decisionText).toContain('Finished macOS packaging task');
      expect(decisionText).toContain('Active sibling title');
      expect(decisionText).toContain('Wire projected dependency');
      expect(decisionText).toContain('tsk_unknown');
      expect(decisionText).not.toContain('tsk_finished');
      expect(decisionText).not.toContain('tsk_active');
      expect(decisionText).not.toContain('tsk_wire_only');
    });
  });

  it('TaskPairEventDecisions resolves wait_dependencies titles from snapshot updates and props', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const unbind = bindTaskPairDecisions((message) => { sent.push(message as unknown as Record<string, unknown>); });
    try {
      const scheduling = projectPairScheduling({
        ...BASE_SCHEDULING,
        dependsOn: ['tsk_snap_done', 'tsk_prop_title', 'tsk_absent'],
      });

      const { container } = render(
        <TaskPairEventDecisions
          taskId="tsk_event_child"
          status="queued"
          scheduling={scheduling}
          taskTitles={{ tsk_prop_title: 'Prop resolved title' }}
        />,
      );

      await waitFor(() => expect(sent.length).toBe(1));
      await act(async () => {
        receiveTaskPairDecision(String(sent[0].requestId), {
          type: TASK_PAIR_DECISION_MSG.HISTORY,
          taskId: 'tsk_event_child',
          ok: true,
          revision: 'rev-1',
          decisions: [
            {
              id: 'dec-1',
              taskId: 'tsk_event_child',
              round: 0,
              kind: TASK_PAIR_DECISION_KIND.DECISION,
              author: 'brain',
              summary: 'Hold for dependencies',
              conclusion: 'Wait',
              createdAt: 1_000,
            },
          ],
        });
      });

      await waitFor(() => {
        expect(container.textContent).toContain('tsk_snap_done');
        expect(container.textContent).toContain('Prop resolved title');
        expect(container.textContent).toContain('tsk_absent');
      });

      await act(async () => {
        (window as { __imcodesTaskPairSnapshot?: unknown }).__imcodesTaskPairSnapshot = {
          tasks: [],
          taskTitles: { tsk_snap_done: 'Snapshot completed dependency' },
        };
        window.dispatchEvent(new CustomEvent(TASK_PAIR_SNAPSHOT_EVENT, {
          detail: (window as { __imcodesTaskPairSnapshot?: unknown }).__imcodesTaskPairSnapshot,
        }));
      });

      await waitFor(() => {
        expect(container.textContent).toContain('Snapshot completed dependency');
        expect(container.textContent).toContain('Prop resolved title');
        expect(container.textContent).toContain('tsk_absent');
        expect(container.textContent).not.toContain('tsk_snap_done');
      });
    } finally {
      unbind();
    }
  });

  it('projectPairScheduling keeps dependencyTitles inside details.brief so share redaction strips both', () => {
    const projected = projectPairScheduling(
      { ...BASE_SCHEDULING, dependsOn: ['tsk_a', 'tsk_b'] },
      { tsk_a: 'Task Alpha', tsk_b: 'tsk_b', '': 'Ignored' },
    );
    expect(projected.dependencyTitles).toBeUndefined();
    expect(projected.details?.brief?.dependencyTitles).toEqual({ tsk_a: 'Task Alpha' });
    expect(readPairScheduling(projected)?.dependencyTitles).toEqual({ tsk_a: 'Task Alpha' });

    const redacted = {
      ...projected,
      details: {},
    };
    expect(readPairScheduling(redacted)?.dependsOn).toEqual([]);
    expect(readPairScheduling(redacted)?.dependencyTitles).toBeUndefined();
    expect(formatTaskPairDependencyTasks(['tsk_a', 'tsk_b'], undefined, readPairScheduling(projected)?.dependencyTitles)).toBe('Task Alpha, tsk_b');
    expect(screen.queryByText('Nonexistent')).toBeNull();
  });
});
