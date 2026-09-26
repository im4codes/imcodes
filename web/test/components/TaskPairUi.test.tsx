/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key),
  }),
}));

import { TaskPairEventChip } from '../../src/components/TaskPairEventChip.js';
import { TaskPairStatusPanel } from '../../src/components/TaskPairStatusPanel.js';
import { formatElapsedDuration } from '../../src/util/tool-duration.js';
import { watchProjectionStore } from '../../src/watch-projection.js';
import { TaskPairSettingsSection, type TaskPairSettingsValue } from '../../src/components/TaskPairSettingsSection.js';
import { DAEMON_COMMAND_TYPES } from '../../../shared/daemon-command-types.js';
import {
  TASK_PAIR_MAX_CONCURRENCY_RESULT,
  TASK_PAIR_MAX_CONCURRENCY_CAP,
  TASK_PAIR_STATUSES,
  TASK_PAIR_WORKSPACE_EFFECTS,
  TASK_PAIR_WORKSPACE_EVENT_VERB,
} from '../../../shared/task-pair.js';

describe('TaskPairEventChip', () => {
  afterEach(() => cleanup());

  it('shows the task, writer, verb, new status and non-zero severity counts', () => {
    const { container } = render(<TaskPairEventChip eventId="e1" payload={{
      taskId: 'T42', title: 'Fix login', writer: 'deck_sub_aud', verb: 'REWORK', toStatus: 'rework',
      severityCounts: { P0: 1, P1: 0, P2: 2, P3: 0, P4: 0 }, verdictJudgement: 'consistent', unusual: false,
    }} />);
    const chip = container.querySelector('.task-pair-chip')!;
    expect(chip.getAttribute('data-task-id')).toBe('T42');
    expect(chip.textContent).toContain('Fix loginT42');
    expect(chip.textContent).toContain('taskPair.chip:{"writer":"deck_sub_aud","verb":"taskPair.verb.rework"}');
    expect(chip.textContent).toContain('taskPair.status.rework');
    expect(chip.textContent).toContain('taskPair.severity:{"level":"P0","count":1}');
    expect(chip.textContent).toContain('taskPair.severity:{"level":"P2","count":2}');
    expect(chip.textContent).not.toContain('"level":"P1"');
    expect(chip.textContent).not.toContain('taskPair.verdict_held');
  });

  it('renders title before the muted id and opens labelled sessions', () => {
    const navigate = vi.fn();
    const listener = (event: Event) => navigate((event as CustomEvent).detail.session);
    window.addEventListener('deck:navigate', listener);
    const { container } = render(<TaskPairEventChip eventId="e-label" payload={{
      taskId: 'T7', title: 'Readable task', writer: 'brain', verb: 'DISPATCH',
      executor: 'deck_sub_worker', executorLabel: 'Cx6', unusual: false,
    }} />);
    const task = container.querySelector('.task-pair-chip-task')!;
    expect(task.querySelector('strong')?.textContent).toBe('Readable task');
    expect(task.querySelector('small')?.textContent).toBe('T7');
    fireEvent.click(screen.getByRole('button', { name: 'Cx6 (deck_sub_worker)' }));
    expect(navigate).toHaveBeenCalledWith('deck_sub_worker');
    window.removeEventListener('deck:navigate', listener);
  });

  it('marks a held verdict and an unusual event, and names the daemon', () => {
    const { container } = render(<TaskPairEventChip eventId="e2" payload={{
      taskId: 'T42', writer: 'daemon', verb: 'PASS', verdictJudgement: 'inconsistent', unusual: true,
    }} />);
    const chip = container.querySelector('.task-pair-chip')!;
    expect(chip.classList.contains('task-pair-chip--held')).toBe(true);
    expect(chip.textContent).toContain('taskPair.verdict_held');
    expect(chip.textContent).toContain('taskPair.unusual');
    expect(chip.textContent).toContain('"writer":"taskPair.daemon"');
  });
});

describe('TaskPairEventChip workspace events', () => {
  afterEach(() => cleanup());

  it('tells the user where a kept deliverable was saved, or why it was not', () => {
    const saved = render(<TaskPairEventChip eventId="w1" payload={{
      taskId: 'T7', writer: 'daemon', verb: TASK_PAIR_WORKSPACE_EVENT_VERB, effect: TASK_PAIR_WORKSPACE_EFFECTS.OUTPUT_SAVED,
      outputPath: '/home/u/proj/reports/summary.md', toStatus: 'done', unusual: false,
    }} />);
    expect(saved.container.textContent).toContain('taskPair.output_saved:{"path":"/home/u/proj/reports/summary.md"}');
    expect(saved.container.textContent).not.toContain('taskPair.chip');
    cleanup();
    const failed = render(<TaskPairEventChip eventId="w2" payload={{
      taskId: 'T7', writer: 'daemon', verb: TASK_PAIR_WORKSPACE_EVENT_VERB, effect: TASK_PAIR_WORKSPACE_EFFECTS.OUTPUT_FAILED,
      outputError: 'outside_workspace', toStatus: 'done', unusual: true,
    }} />);
    expect(failed.container.textContent).toContain('taskPair.output_failed:{"reason":"outside_workspace"}');
    cleanup();
    const kept = render(<TaskPairEventChip eventId="w3" payload={{
      taskId: 'T7', writer: 'daemon', verb: TASK_PAIR_WORKSPACE_EVENT_VERB, effect: TASK_PAIR_WORKSPACE_EFFECTS.KEPT, toStatus: 'cancelled', unusual: true,
    }} />);
    expect(kept.container.textContent).toContain('taskPair.workspace_kept');
  });

  it('has every workspace chip string in all seven locales', () => {
    const WEB = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko']) {
      const taskPair = (JSON.parse(readFileSync(join(WEB, 'src/i18n/locales', `${locale}.json`), 'utf8')) as { taskPair: Record<string, string> }).taskPair;
      for (const key of ['output_saved', 'output_failed', 'workspace_removed', 'workspace_kept']) {
        expect(taskPair[key], `${locale}.${key}`).toBeTruthy();
      }
      expect(taskPair.output_saved).toContain('{{path}}');
      expect(taskPair.output_failed).toContain('{{reason}}');
    }
  });
});
describe('TaskPairStatusPanel', () => {
  afterEach(() => {
    cleanup();
    window.localStorage.removeItem('imcodes.task-pair-status-panel.collapsed');
    window.localStorage.removeItem('imcodes.task-pair-status-panel.collapsed:server-a');
    window.localStorage.removeItem('imcodes.task-pair-status-panel.collapsed:server-b');
  });
  it('groups live pair state, keeps counts while collapsed, and persists collapse', () => {
    const events = [
      { eventId: 'p1', type: 'task_pair.event', ts: Date.now() - 2_000, payload: { taskId: 'T1', title: 'Build panel', toStatus: 'working', executor: 'deck_sub_w', executorLabel: 'Cx6', round: 1 } },
      { eventId: 'p2', type: 'task_pair.event', ts: Date.now(), payload: { taskId: 'T2', title: 'Audit panel', toStatus: 'in_audit', auditor: 'deck_sub_a', auditorLabel: 'CC2', round: 2 } },
    ] as never;
    render(<TaskPairStatusPanel events={events} />);
    expect(screen.getByText('Build panel')).toBeTruthy();
    expect(screen.getByText('Cx6')).toBeTruthy();
    expect(screen.getByText('CC2')).toBeTruthy();
    expect(screen.queryByText('Cx6 (deck_sub_w)')).toBeNull();
    expect(screen.queryByText('CC2 (deck_sub_a)')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /taskPair.panel_title/ }));
    expect(screen.queryByText('Build panel')).toBeNull();
    expect(screen.getByText(/taskPair.panel_count_working/)).toBeTruthy();
    expect(screen.getByText(/taskPair.panel_count_audit/)).toBeTruthy();
    expect(screen.getByText(/taskPair.panel_count_queued/)).toBeTruthy();
    expect(window.localStorage.getItem('imcodes.task-pair-status-panel.collapsed')).toBe('1');
  });

  it('shows queued pairs in queue order with assignment fallback and urgency', () => {
    window.localStorage.removeItem('imcodes.task-pair-status-panel.collapsed');
    const events = [
      { eventId: 'q1', type: 'task_pair.event', ts: Date.now() - 5_000, payload: { taskId: 'Q1', title: 'Urgent queued', toStatus: 'queued', queuePosition: 1, urgent: true, executor: 'deck_sub_e', executorLabel: 'Cx6' } },
      { eventId: 'q2', type: 'task_pair.event', ts: Date.now() - 2_000, payload: { taskId: 'Q2', title: 'Second queued', toStatus: 'queued', queuePosition: 2 } },
    ] as never;
    render(<TaskPairStatusPanel events={events} />);
    expect(screen.getByText(/Urgent queued/)).toBeTruthy();
    expect(screen.getByText(/Second queued/)).toBeTruthy();
    expect(screen.getByText('Cx6')).toBeTruthy();
    expect(screen.getAllByText(/taskPair.panel_unassigned/).length).toBeGreaterThan(0);
    expect(screen.getByText('!')).toBeTruthy();
  });

  it('renders an authoritative console snapshot even when chat history has no pair events', async () => {
    render(<TaskPairStatusPanel events={[]} />);
    window.dispatchEvent(new CustomEvent('supervision:task-pairs', { detail: {
      tasks: [{ taskId: 'S1', title: 'Snapshot task', updatedAt: Date.now(), pair: { status: 'queued', createdAt: Date.now() - 4_000, executor: 'deck_sub_e', urgent: true, queueOrder: 1 } }],
      assignments: [{ taskId: 'S1', role: 'implementer', ownerSessionName: 'deck_sub_e', ownerSessionLabel: 'Cx6', sessionState: 'running' }],
    } }));
    await waitFor(() => expect(screen.getByText('Snapshot task')).toBeTruthy());
    expect(screen.getByText('Cx6')).toBeTruthy();
    expect(screen.getByText('!')).toBeTruthy();
  });

  it('renders the complete title without exposing the task id in metadata', () => {
    const title = 'A deliberately long task title that must remain fully readable';
    render(<TaskPairStatusPanel events={[{
      eventId: 'title-only', type: 'task_pair.event', ts: Date.now(),
      payload: { taskId: 'secret-id', title, toStatus: 'working' },
    }] as never} />);
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.queryByText(/secret-id/)).toBeNull();
  });

  it('computes checklist badges from the shared brief parser, hides empty checklists, and expands the full markdown with audit state', () => {
    const brief = '# Objective\n\nDo the thing.\n\n- [x][ ] Fix the bug\n- [x][x] Add tests\n';
    const { container } = render(<TaskPairStatusPanel events={[{
      eventId: 'checklist', type: 'task_pair.event', ts: Date.now(),
      payload: { taskId: 'private-task-id', title: 'Checklist task', toStatus: 'working', brief },
    }] as never} />);
    expect(screen.getByText('taskPair.checklist_progress:{"total":2,"implemented":2,"audited":1}')).toBeTruthy();
    expect(container.querySelector('.task-pair-status-brief')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'taskPair.panel_show_brief' }));
    expect(screen.getByRole('heading', { name: 'Objective' })).toBeTruthy();
    expect(screen.getByText('Do the thing.')).toBeTruthy();
    const rows = [...container.querySelectorAll('.task-pair-status-checklist-row')];
    expect(rows).toHaveLength(2);
    expect([...rows[0]!.querySelectorAll('input')].map((input) => (input as HTMLInputElement).checked)).toEqual([true, false]);
    expect(screen.queryByText(/private-task-id/)).toBeNull();
  });

  it('hides checklist progress when there is no checklist in the brief', () => {
    render(<TaskPairStatusPanel events={[{
      eventId: 'plain-brief', type: 'task_pair.event', ts: Date.now(),
      payload: { taskId: 'plain', title: 'Prose', toStatus: 'working', brief: 'Only prose.' },
    }] as never} />);
    expect(screen.queryByText(/taskPair.checklist_progress/)).toBeNull();
  });

  it('loads an omitted large brief only on expand and includes serverId routing on the HTTP request', async () => {
    const brief = '# Large task\n\n- [x][ ] Review the complete brief\n';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      events: [{ type: 'task_pair.event', payload: { taskId: 'lazy-task', brief } }],
      epoch: null, hasMore: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(<TaskPairStatusPanel events={[{
        eventId: 'large', type: 'task_pair.event', ts: Date.now(),
        payload: { taskId: 'lazy-task', title: 'Large brief', toStatus: 'working', briefAvailable: true, checklist: { total: 1, implemented: 1, audited: 0 } },
      }] as never} brain="deck_brain" serverId="server-1" />);
      expect(fetchMock).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'taskPair.panel_show_brief' }));
      await screen.findByRole('heading', { name: 'Large task' });
      const requestedUrl = String(fetchMock.mock.calls[0]![0]);
      expect(requestedUrl).toContain('serverId=server-1');
      expect(requestedUrl).toContain('sessionName=deck_brain');
    } finally { vi.unstubAllGlobals(); }
  });

  it('expands a large brief from the authoritative snapshot without relying on a timestamp guess', async () => {
    const brief = `# Snapshot large brief\n\n${'complete '.repeat(900)}`;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      events: [{ type: 'task_pair.event', ts: 123, payload: { taskId: 'snapshot-large', brief } }],
      epoch: null, hasMore: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(<TaskPairStatusPanel events={[]} brain="deck_brain" serverId="server-snapshot" />);
      window.dispatchEvent(new CustomEvent('supervision:task-pairs', { detail: {
        tasks: [{ taskId: 'snapshot-large', title: 'Snapshot large', updatedAt: 1000, pair: { status: 'working', updatedAt: 1001, briefAvailable: true, checklist: { total: 0, implemented: 0, audited: 0 } } }],
        assignments: [],
      } }));
      await screen.findByText('Snapshot large');
      fireEvent.click(screen.getByRole('button', { name: 'taskPair.panel_show_brief' }));
      await screen.findByRole('heading', { name: 'Snapshot large brief' });
      expect(screen.getByText(/complete complete complete/)).toBeTruthy();
      const requestedUrl = String(fetchMock.mock.calls[0]![0]);
      expect(requestedUrl).toContain('serverId=server-snapshot');
      expect(requestedUrl).not.toContain('afterTs=');
      expect(requestedUrl).not.toContain('beforeTs=');
    } finally { vi.unstubAllGlobals(); }
  });

  it('pages backward when the task-pair event is older than the first history page', async () => {
    const brief = '# Paged brief\n\nThe complete older brief';
    const firstPage = Array.from({ length: 500 }, (_, index) => ({ type: 'assistant.text', ts: 2000 - index, payload: { text: `event-${index}` } }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ events: firstPage, epoch: 7, hasMore: true, nextCursor: { epoch: 7, beforeTs: 1501, direction: 'older' } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ events: [{ type: 'task_pair.event', ts: 100, payload: { taskId: 'paged-task', brief } }], epoch: null, hasMore: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(<TaskPairStatusPanel events={[{ eventId: 'paged', type: 'task_pair.event', ts: Date.now(), payload: { taskId: 'paged-task', title: 'Paged task', toStatus: 'working', briefAvailable: true } }] as never} brain="deck_brain" serverId="server-paged" />);
      fireEvent.click(screen.getByRole('button', { name: 'taskPair.panel_show_brief' }));
      await screen.findByRole('heading', { name: 'Paged brief' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[1]![0])).toContain('beforeTs=1501');
    } finally { vi.unstubAllGlobals(); }
  });

  function fakeWs() {
    const handlers = new Set<(msg: unknown) => void>();
    const sent: Record<string, unknown>[] = [];
    return {
      sent,
      ws: { send: (msg: Record<string, unknown>) => sent.push(msg), onMessage: (handler: (msg: unknown) => void) => { handlers.add(handler); return () => handlers.delete(handler); } } as never,
      emit: (msg: unknown) => handlers.forEach((handler) => handler(msg)),
    };
  }

  it('reads concurrency from the daemon and sends a capped debounced update on click-to-edit', async () => {
    vi.useFakeTimers();
    try {
      const { ws, sent, emit } = fakeWs();
      render(<TaskPairStatusPanel events={[{ eventId: 'c', type: 'task_pair.event', ts: Date.now(), payload: { taskId: 'C1', toStatus: 'working' } }] as never} ws={ws} brain="deck_brain" />);
      expect(sent[0]).toMatchObject({ type: DAEMON_COMMAND_TYPES.TASK_PAIR_GET_MAX_CONCURRENCY, brain: 'deck_brain' });
      await act(async () => { emit({ type: TASK_PAIR_MAX_CONCURRENCY_RESULT, commandId: sent[0]!.commandId, ok: true, maxConcurrency: 9, fixedOverride: false }); });
      fireEvent.click(screen.getByRole('button', { name: 'taskPair.panel_concurrency:{"max":9}' }));
      const input = screen.getByRole('spinbutton');
      fireEvent.input(input, { target: { value: String(TASK_PAIR_MAX_CONCURRENCY_CAP + 8) } });
      await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); vi.advanceTimersByTime(400); });
      expect(sent.at(-1)).toMatchObject({ type: DAEMON_COMMAND_TYPES.TASK_PAIR_SET_MAX_CONCURRENCY, maxConcurrency: TASK_PAIR_MAX_CONCURRENCY_CAP });
    } finally { vi.useRealTimers(); }
  });

  it('sends the incremented/decremented absolute value from the -/+ buttons, clamped at the floor, without opening the number editor', async () => {
    vi.useFakeTimers();
    try {
      const { ws, sent, emit } = fakeWs();
      render(<TaskPairStatusPanel events={[{ eventId: 'c2', type: 'task_pair.event', ts: Date.now(), payload: { taskId: 'C2', toStatus: 'working' } }] as never} ws={ws} brain="deck_brain" />);
      await act(async () => { emit({ type: TASK_PAIR_MAX_CONCURRENCY_RESULT, commandId: sent[0]!.commandId, ok: true, maxConcurrency: 1, fixedOverride: false }); });
      const decrease = screen.getByRole('button', { name: 'taskPair.panel_concurrency_decrease' });
      expect(decrease.hasAttribute('disabled')).toBe(true);
      const increase = screen.getByRole('button', { name: 'taskPair.panel_concurrency_increase' });
      fireEvent.click(increase);
      await act(async () => { vi.advanceTimersByTime(400); });
      expect(sent.at(-1)).toMatchObject({ type: DAEMON_COMMAND_TYPES.TASK_PAIR_SET_MAX_CONCURRENCY, maxConcurrency: 2 });
      expect(screen.queryByRole('spinbutton')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('disables every editing control and explains the override when a fixed Brain-settings value is in effect', async () => {
    const { ws, sent, emit } = fakeWs();
    render(<TaskPairStatusPanel events={[{ eventId: 'c3', type: 'task_pair.event', ts: Date.now(), payload: { taskId: 'C3', toStatus: 'working' } }] as never} ws={ws} brain="deck_brain" />);
    await act(async () => { emit({ type: TASK_PAIR_MAX_CONCURRENCY_RESULT, commandId: sent[0]!.commandId, ok: true, maxConcurrency: 4, fixedOverride: true }); });
    expect(screen.getByRole('button', { name: 'taskPair.panel_concurrency_decrease' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'taskPair.panel_concurrency_increase' }).hasAttribute('disabled')).toBe(true);
    const value = screen.getByRole('button', { name: 'taskPair.panel_concurrency:{"max":4}' });
    expect(value.hasAttribute('disabled')).toBe(true);
    fireEvent.click(value);
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.getByText('taskPair.panel_concurrency_fixed_note')).toBeTruthy();
  });

  it('collapsing hides the rows list from the DOM entirely while the header keeps live counts updating', () => {
    window.localStorage.removeItem('imcodes.task-pair-status-panel.collapsed');
    const { container, rerender } = render(<TaskPairStatusPanel events={[
      { eventId: 'collapse-1', type: 'task_pair.event', ts: Date.now(), payload: { taskId: 'CO1', title: 'Collapsible task', toStatus: 'working' } },
    ] as never} />);
    expect(container.querySelector('.task-pair-status-rows')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /taskPair.panel_title/ }));
    expect(container.querySelector('.task-pair-status-rows')).toBeNull();
    expect(container.querySelector('.task-pair-status-header')).toBeTruthy();
    expect(screen.getByText('taskPair.panel_count_working:{"count":1}')).toBeTruthy();
    rerender(<TaskPairStatusPanel events={[
      { eventId: 'collapse-1', type: 'task_pair.event', ts: Date.now(), payload: { taskId: 'CO1', title: 'Collapsible task', toStatus: 'working' } },
      { eventId: 'collapse-2', type: 'task_pair.event', ts: Date.now(), payload: { taskId: 'CO2', title: 'Second', toStatus: 'in_audit' } },
    ] as never} />);
    expect(container.querySelector('.task-pair-status-rows')).toBeNull();
    expect(screen.getByText('taskPair.panel_count_working:{"count":1}')).toBeTruthy();
    expect(screen.getByText('taskPair.panel_count_audit:{"count":1}')).toBeTruthy();
  });

  it('persists the collapsed state per server, so a remount for the same server stays collapsed but a different server starts expanded', () => {
    window.localStorage.removeItem('imcodes.task-pair-status-panel.collapsed:server-a');
    window.localStorage.removeItem('imcodes.task-pair-status-panel.collapsed:server-b');
    const events = [{ eventId: 'persist-1', type: 'task_pair.event', ts: Date.now(), payload: { taskId: 'P1', title: 'Persisted task', toStatus: 'working' } }] as never;
    const first = render(<TaskPairStatusPanel events={events} serverId="server-a" />);
    fireEvent.click(screen.getByRole('button', { name: /taskPair.panel_title/ }));
    expect(window.localStorage.getItem('imcodes.task-pair-status-panel.collapsed:server-a')).toBe('1');
    first.unmount();

    const otherServer = render(<TaskPairStatusPanel events={events} serverId="server-b" />);
    expect(otherServer.container.querySelector('.task-pair-status-rows')).toBeTruthy();
    otherServer.unmount();

    const sameServer = render(<TaskPairStatusPanel events={events} serverId="server-a" />);
    expect(sameServer.container.querySelector('.task-pair-status-rows')).toBeNull();
  });

  it('resolves a missing payload label from the watch session store', () => {
    watchProjectionStore.updateFromSessionList(
      { id: 'server-test', name: 'Test', baseUrl: 'http://test' },
      [{ name: 'deck_sub_store', project: 'p', role: 'w1', agentType: 'codex', state: 'running', label: 'Store Cx' }],
    );
    try {
      render(<TaskPairStatusPanel events={[{
        eventId: 'store-label', type: 'task_pair.event', ts: Date.now(),
        payload: { taskId: 'store-task', title: 'Store label', toStatus: 'working', executor: 'deck_sub_store' },
      }] as never} />);
      expect(screen.getByText('Store Cx')).toBeTruthy();
      expect(screen.queryByText('deck_sub_store')).toBeNull();
    } finally {
      watchProjectionStore.setSnapshotStatus('switching');
    }
  });

  it('shows payload model, falls back to the session model, hides ids, and navigates roles', () => {
    const navigate = vi.fn();
    const listener = (event: Event) => navigate((event as CustomEvent).detail.session);
    window.addEventListener('deck:navigate', listener);
    render(<TaskPairStatusPanel sessions={[{ name: 'deck_sub_exec', label: 'Cx1', requestedModel: 'gpt-6-luna' }, { name: 'deck_sub_aud', label: 'Auditor', activeModel: 'gpt-6-astra' }]} events={[{
      eventId: 'models', type: 'task_pair.event', ts: Date.now(),
      payload: { taskId: 'model-task', title: 'Models', toStatus: 'working', executor: 'deck_sub_exec', executorLabel: 'Executor', executorModel: 'gpt-6-sol', auditor: 'deck_sub_aud' },
    }] as never} />);
    expect(screen.getByText(/Executor.*gpt-6-sol/)).toBeTruthy();
    expect(screen.getByText(/Auditor.*gpt-6-astra/)).toBeTruthy();
    expect(screen.queryByText(/deck_sub_(exec|aud)/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Executor.*gpt-6-sol/ }));
    expect(navigate).toHaveBeenCalledWith('deck_sub_exec');
    window.removeEventListener('deck:navigate', listener);
  });

  it('uses localized neutral role fallbacks when labels are missing', () => {
    render(<TaskPairStatusPanel events={[{ eventId: 'fallback', type: 'task_pair.event', ts: Date.now(), payload: { taskId: 'fallback-task', title: 'Fallback', toStatus: 'working', executor: 'deck_sub_exec' } }] as never} />);
    expect(screen.getByText('taskPair.panel_executor')).toBeTruthy();
    expect(screen.queryByText('deck_sub_exec')).toBeNull();
  });

  const readCss = () => {
    const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');
    return readFileSync(join(WEB_ROOT, 'src/styles.css'), 'utf8');
  };
  const cssRule = (css: string, selector: string) =>
    new RegExp(`${selector.replace(/[.:]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';

  it('fills its parent height with the rows list owning the scroll, not a fixed height on the panel', () => {
    const css = readCss();
    const panelRule = cssRule(css, '.task-pair-status-panel');
    expect(panelRule).toMatch(/bottom:\s*0/);
    expect(panelRule).toMatch(/display:\s*flex/);
    expect(panelRule).toMatch(/flex-direction:\s*column/);
    const rowsRule = cssRule(css, '.task-pair-status-rows');
    expect(rowsRule).toMatch(/flex:\s*1/);
    expect(rowsRule).toMatch(/min-height:\s*0/);
    expect(rowsRule).toMatch(/overflow-y:\s*auto/);
    expect(rowsRule).not.toMatch(/max-height/);
  });

  it('starts below the sidebar toolbar cluster instead of z-index-stacking over it (which would still block its clicks)', () => {
    const css = readCss();
    // .chat-top-actions floats at top:6px, its tallest button is 24px, and the
    // count badge extends 4px above that -- roughly y=2..30. The panel must
    // start at or below that band so the toolbar's buttons stay reachable
    // (an overlapping panel, even with header padding to clear the *text*,
    // still intercepts clicks meant for the toolbar underneath it).
    const panelRule = cssRule(css, '.task-pair-status-panel');
    const topOffset = /top:\s*(\d+)px/.exec(panelRule)?.[1];
    expect(Number(topOffset)).toBeGreaterThanOrEqual(34);
  });

  it('gives the panel an opaque background from tokens that are actually defined, so it never renders transparent over the toolbar or chat text', () => {
    const css = readCss();
    const rootVars = new Set(
      [...cssRule(css, ':root').matchAll(/--([\w-]+):/g)].map((match) => match[1]),
    );
    const panelRule = cssRule(css, '.task-pair-status-panel');
    const background = /background:\s*([^;]+);/.exec(panelRule)?.[1] ?? '';
    expect(background).toBeTruthy();
    // Every var(--x, ...) reference in the background must resolve: either
    // --x itself is a defined :root token, or its fallback chain bottoms out
    // at one. A var() with no defined property anywhere in the chain (like
    // the retired --panel-bg / --surface-2 pair) computes to nothing, which
    // silently makes the whole declaration (and therefore the background)
    // transparent -- exactly the bug this guards against.
    const varRefs = [...background.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1].slice(2));
    expect(varRefs.length).toBeGreaterThan(0);
    for (const name of varRefs) expect(rootVars.has(name)).toBe(true);
  });

  it('renders every group -- including a tall rework group -- so the list can scroll to reach it, never dropping rows from the DOM', () => {
    const events = [
      { eventId: 'w1', type: 'task_pair.event', ts: Date.now(), payload: { taskId: 'W1', title: 'Working one', toStatus: 'working', executor: 'deck_sub_w1' } },
      { eventId: 'w2', type: 'task_pair.event', ts: Date.now(), payload: { taskId: 'W2', title: 'Working two', toStatus: 'working', executor: 'deck_sub_w2' } },
      { eventId: 'w3', type: 'task_pair.event', ts: Date.now(), payload: { taskId: 'W3', title: 'Working three', toStatus: 'working', executor: 'deck_sub_w3' } },
      { eventId: 'r1', type: 'task_pair.event', ts: Date.now(), payload: { taskId: 'R1', title: 'Needs rework', toStatus: 'rework', executor: 'deck_sub_r1', round: 2 } },
    ] as never;
    const { container } = render(<TaskPairStatusPanel events={events} />);
    // Not clipped away by MAX_ROWS or any render-time truncation -- only CSS
    // (overflow-y: auto on .task-pair-status-rows, asserted above) is
    // responsible for keeping this reachable by scrolling instead of visible.
    expect(container.querySelector('.task-pair-status-group-working')).toBeTruthy();
    expect(container.querySelector('.task-pair-status-group-rework')).toBeTruthy();
    expect(screen.getByText('Needs rework')).toBeTruthy();
  });

  it('keeps the header total in sync with the sum of every rendered group -- including rework', () => {
    const events = [
      { eventId: 'c1', type: 'task_pair.event', ts: Date.now(), payload: { taskId: 'C1', title: 'A', toStatus: 'working' } },
      { eventId: 'c2', type: 'task_pair.event', ts: Date.now(), payload: { taskId: 'C2', title: 'B', toStatus: 'working' } },
      { eventId: 'c3', type: 'task_pair.event', ts: Date.now(), payload: { taskId: 'C3', title: 'C', toStatus: 'rework' } },
      { eventId: 'c4', type: 'task_pair.event', ts: Date.now(), payload: { taskId: 'C4', title: 'D', toStatus: 'in_audit' } },
      { eventId: 'c5', type: 'task_pair.event', ts: Date.now(), payload: { taskId: 'C5', title: 'E', toStatus: 'queued', queuePosition: 1 } },
    ] as never;
    const { container } = render(<TaskPairStatusPanel events={events} />);
    // 'working' + 'rework' both count toward the header's "working" bucket.
    expect(screen.getByText('taskPair.panel_count_working:{"count":3}')).toBeTruthy();
    expect(screen.getByText('taskPair.panel_count_audit:{"count":1}')).toBeTruthy();
    expect(screen.getByText('taskPair.panel_count_queued:{"count":1}')).toBeTruthy();
    const groupCount = (key: string) => Number(container.querySelector(`.task-pair-status-group-${key} small`)?.textContent?.replace(/[()]/g, '') ?? 0);
    expect(groupCount('working') + groupCount('rework')).toBe(3);
    expect(groupCount('audit')).toBe(1);
    expect(groupCount('queued')).toBe(1);
  });

  it('shows a non-clickable "no audit needed" label for auditor=none instead of a dangling session button', () => {
    const navigate = vi.fn();
    const listener = (event: Event) => navigate((event as CustomEvent).detail.session);
    window.addEventListener('deck:navigate', listener);
    try {
      const { container } = render(<TaskPairStatusPanel events={[{
        eventId: 'no-audit', type: 'task_pair.event', ts: Date.now(),
        payload: { taskId: 'NA1', title: 'Solo task', toStatus: 'working', executor: 'deck_sub_solo', auditor: 'none' },
      }] as never} />);
      expect(screen.getByText('taskPair.panel_no_audit')).toBeTruthy();
      const buttons = [...container.querySelectorAll('.task-pair-status-session')];
      expect(buttons).toHaveLength(1);
      expect(buttons[0].getAttribute('data-session-name')).toBe('deck_sub_solo');
      fireEvent.click(screen.getByText('taskPair.panel_no_audit'));
      expect(navigate).not.toHaveBeenCalledWith('none');
    } finally {
      window.removeEventListener('deck:navigate', listener);
    }
  });

  it('gives every card the same task-pair-chip--STATUS class its badge uses, so both share one colour token instead of a duplicated palette', () => {
    for (const toStatus of TASK_PAIR_STATUSES) {
      const { container } = render(<TaskPairStatusPanel events={[{
        eventId: `badge-${toStatus}`, type: 'task_pair.event', ts: Date.now(),
        payload: { taskId: `B-${toStatus}`, title: 'Badge task', toStatus, executor: 'deck_sub_b' },
      }] as never} />);
      const row = container.querySelector('.task-pair-status-row')!;
      expect(row.classList.contains(`task-pair-chip--${toStatus}`), toStatus).toBe(true);
      const badge = row.querySelector('.task-pair-status-badge')!;
      expect(badge.classList.contains(`task-pair-chip--${toStatus}`), toStatus).toBe(true);
      cleanup();
    }
  });

  it('replaces the retired single-string header counts with three separate status badges', () => {
    render(<TaskPairStatusPanel events={[{
      eventId: 'header-badges', type: 'task_pair.event', ts: Date.now(),
      payload: { taskId: 'HB1', title: 'Header badges', toStatus: 'working' },
    }] as never} />);
    expect(screen.getByText(/taskPair.panel_count_working/)).toBeTruthy();
    expect(screen.getByText(/taskPair.panel_count_audit/)).toBeTruthy();
    expect(screen.getByText(/taskPair.panel_count_queued/)).toBeTruthy();
    expect(screen.queryByText(/taskPair.panel_counts(?!:)/)).toBeNull();
  });

  it('derives the panel width, .chat-view padding-right, and the pinned "last sent" margin-right from one shared token, so they can never drift apart again', () => {
    const css = readCss();
    const varRef = (rule: string) => /var\(\s*(--[\w-]+)/.exec(rule)?.[1];
    const panelRule = cssRule(css, '.task-pair-status-panel');
    // Both the panel's own max-width and its min()-clamped width must read the
    // same token as .chat-view and the last-sent banner below -- a flat
    // literal (or a different vw-based formula) here is exactly the bug this
    // guards against: the panel and its neighbours silently disagreeing on
    // how wide the panel actually renders.
    expect(varRef(/max-width:\s*([^;]+);/.exec(panelRule)?.[1] ?? '')).toBe('--task-pair-panel-width');
    expect(varRef(/width:\s*([^;]+);/.exec(panelRule)?.[1] ?? '')).toBe('--task-pair-panel-width');
    const chatViewRule = /\.chat-view-wrap:has\(\.task-pair-status-panel\) \.chat-view \{([^}]*)\}/.exec(css)?.[1] ?? '';
    const lastSentRule = /\.chat-view-wrap:has\(\.task-pair-status-panel\) \.chat-pinned-last-sent \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(varRef(chatViewRule)).toBe('--task-pair-panel-width');
    expect(varRef(lastSentRule)).toBe('--task-pair-panel-width');
    const rootVars = new Set([...cssRule(css, ':root').matchAll(/--([\w-]+):/g)].map((match) => match[1]));
    expect(rootVars.has('task-pair-panel-width')).toBe(true);
  });

  it('shrinks to a bare header and drops the reserved chat-view padding once collapsed, so the chat area is freed', () => {
    const css = readCss();
    const collapsedPanelRule = [...css.matchAll(/\.task-pair-status-panel\.is-collapsed\s*\{([^}]*)\}/g)].map((m) => m[1])[0] ?? '';
    expect(collapsedPanelRule).toMatch(/bottom:\s*auto/);
    const expandedPadding = /\.chat-view-wrap:has\(\.task-pair-status-panel\)\s*\.chat-view\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const collapsedPadding = /\.chat-view-wrap:has\(\.task-pair-status-panel\.is-collapsed\)\s*\.chat-view\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(expandedPadding).toMatch(/padding-right:\s*calc\(var\(--task-pair-panel-width\)/);
    expect(collapsedPadding).toMatch(/padding-right:\s*12px/);
  });

  it('has every new badge/count-count i18n key in all seven locales, and no leftover panel_counts key', () => {
    const WEB = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko']) {
      const taskPair = (JSON.parse(readFileSync(join(WEB, 'src/i18n/locales', `${locale}.json`), 'utf8')) as { taskPair: Record<string, string> }).taskPair;
      for (const key of ['panel_count_working', 'panel_count_audit', 'panel_count_queued']) {
        expect(taskPair[key], `${locale}.${key}`).toBeTruthy();
        expect(taskPair[key], `${locale}.${key}`).toContain('{{count}}');
      }
      expect(taskPair.panel_counts, `${locale}.panel_counts should be removed`).toBeUndefined();
    }
  });
});

describe('formatElapsedDuration', () => {
  const en = { day: 'd', hour: 'h', minute: 'm', second: 's', separator: ' ' };
  const zh = { day: '天', hour: '小时', minute: '分', second: '秒', separator: '' };
  it.each([
    [0, '0s'], [59, '59s'], [60, '1m 0s'], [3599, '59m 59s'],
    [3600, '1h 0m'], [86_399, '23h 59m'], [86_400, '1d 0h'],
  ])('formats %s seconds in English', (seconds, expected) => {
    expect(formatElapsedDuration(seconds, en)).toBe(expected);
  });
  it.each([
    [0, '0秒'], [59, '59秒'], [60, '1分0秒'], [3599, '59分59秒'],
    [3600, '1小时0分'], [86_399, '23小时59分'], [86_400, '1天0小时'],
  ])('formats %s seconds in Simplified Chinese', (seconds, expected) => {
    expect(formatElapsedDuration(seconds, zh)).toBe(expected);
  });
});

describe('TaskPairEventChip status colours', () => {
  afterEach(() => cleanup());
  const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');
  const css = readFileSync(join(WEB_ROOT, 'src/styles.css'), 'utf8');
  /** The `--task-pair-status-text` value a status class sets, e.g. `var(--status-pass-text)`. */
  const statusTextToken = (status: string): string | undefined => {
    const rule = new RegExp(`\\.task-pair-chip--${status} \\{([^}]*)\\}`).exec(css)?.[1];
    return /--task-pair-status-text:\s*([^;]+);/.exec(rule ?? '')?.[1]?.trim();
  };

  it('gives every pair status its own class and its own colour', () => {
    for (const status of TASK_PAIR_STATUSES) {
      const { container } = render(<TaskPairEventChip eventId={`e-${status}`} payload={{ taskId: 'T1', writer: 'w', verb: 'WORKING', toStatus: status }} />);
      const chip = container.querySelector('.task-pair-chip')!;
      expect(chip.classList.contains(`task-pair-chip--${status}`), status).toBe(true);
      expect(chip.getAttribute('data-task-status')).toBe(status);
      cleanup();
    }
    const tokens = TASK_PAIR_STATUSES.map((status) => statusTextToken(status));
    expect(tokens.every(Boolean), JSON.stringify(tokens)).toBe(true);
    expect(new Set(tokens).size).toBe(TASK_PAIR_STATUSES.length);
  });

  it('shows PASS and REWORK in the shared verdict colours, not the same one', () => {
    expect(statusTextToken('passed')).toBe('var(--status-pass-text)');
    expect(statusTextToken('rework')).toBe('var(--status-rework-text)');
    // The same tokens drive the peer-audit verdict pill, so one verdict has one colour.
    expect(css).toContain('.peer-audit-result-outcome--pass { border-color: var(--status-pass-border); color: var(--status-pass-text); }');
    expect(css).toContain('.peer-audit-result-outcome--rework { border-color: var(--status-rework-border); color: var(--status-rework-text); }');
  });

  it('adds no status class to an event that changed no status', () => {
    const { container } = render(<TaskPairEventChip eventId="e-none" payload={{ taskId: '-', writer: 'w', verb: 'BOGUS' }} />);
    const chip = container.querySelector('.task-pair-chip')!;
    expect([...chip.classList].some((name) => /^task-pair-chip--(?!held|unusual)/.test(name))).toBe(false);
  });
});

describe('TaskPairSettingsSection', () => {
  afterEach(() => cleanup());

  it('edits engine and limit starting from the defaults', () => {
    let value: TaskPairSettingsValue = {};
    const onChange = vi.fn((next: TaskPairSettingsValue) => { value = next; });
    render(<TaskPairSettingsSection value={value} onChange={onChange} />);
    // An unconfigured project is inert (owner decision, 2026-09-26), not
    // 'pairs' -- the select must show that truthfully, or choosing 'pairs'
    // fires no input event because it already matches the shown value.
    expect((screen.getByTestId('task-pair-engine') as HTMLSelectElement).value).toBe('');
    expect((screen.getByTestId('task-pair-max-concurrency') as HTMLInputElement).value).toBe('5');
    // Who does executor/auditor work is not configured here -- it is the
    // execution pool's per-entry role, in SessionSettingsDialog's pool editor.
    expect(screen.queryByTestId(/task-pair-allowlist-row-/)).toBeNull();

    const engine = screen.getByTestId('task-pair-engine') as HTMLSelectElement;
    expect([...engine.options].map((option) => option.value)).not.toContain('legacy');
    fireEvent.input(screen.getByTestId('task-pair-max-concurrency'), { target: { value: '8' } });
    expect(value.pairMaxConcurrency).toBe(8);
  });

  it('clamps the Brain settings concurrency editor to the shared cap', () => {
    let value: TaskPairSettingsValue = {};
    const onChange = vi.fn((next: TaskPairSettingsValue) => { value = next; });
    render(<TaskPairSettingsSection value={value} onChange={onChange} />);
    const input = screen.getByTestId('task-pair-max-concurrency') as HTMLInputElement;
    expect(input.max).toBe(String(TASK_PAIR_MAX_CONCURRENCY_CAP));
    fireEvent.input(input, { target: { value: String(TASK_PAIR_MAX_CONCURRENCY_CAP + 8) } });
    expect(value.pairMaxConcurrency).toBe(TASK_PAIR_MAX_CONCURRENCY_CAP);
  });

  it('renders a stored legacy value as inert unset without offering it again', () => {
    render(<TaskPairSettingsSection value={{ pairEngine: 'legacy' }} onChange={vi.fn()} />);
    const engine = screen.getByTestId('task-pair-engine') as HTMLSelectElement;
    expect(engine.value).toBe('');
    expect([...engine.options].map((option) => option.value)).not.toContain('legacy');
  });

  it('lets the user opt an unconfigured project into pairs, and back out to not-enabled', () => {
    let value: TaskPairSettingsValue = {};
    const onChange = vi.fn((next: TaskPairSettingsValue) => { value = next; });
    const view = render(<TaskPairSettingsSection value={value} onChange={onChange} />);
    const engine = screen.getByTestId('task-pair-engine') as HTMLSelectElement;
    expect(engine.value).toBe('');

    engine.value = 'pairs';
    fireEvent.input(engine);
    expect(onChange).toHaveBeenCalled();
    expect(value.pairEngine).toBe('pairs');

    view.rerender(<TaskPairSettingsSection value={value} onChange={onChange} />);
    const reselected = screen.getByTestId('task-pair-engine') as HTMLSelectElement;
    expect(reselected.value).toBe('pairs');
    reselected.value = '';
    fireEvent.input(reselected);
    expect(value.pairEngine).toBeUndefined();
  });
});
