/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskPairEventChip } from '../../src/components/TaskPairEventChip.js';
import { TaskPairStatusPanel } from '../../src/components/TaskPairStatusPanel.js';
import { SupervisionTaskConsoleView } from '../../src/components/SupervisionTaskConsole.js';
import { createSupervisionTaskConsoleState, SUPERVISION_TASK_CONSOLE_PHASE } from '../../src/supervision-task-console-reducer.js';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
const taskId = 'tsk_service_preexecution_fee_20261010';
const exec = 'deck_sub_pair_auto_0123456789abcdef';
const audit = 'deck_sub_pair_auto_fedcba9876543210';
const title = '中文长任务名称'.repeat(8);
const payload = {
  taskId, title, verb: 'WORKING', toStatus: 'working', executor: exec, auditor: audit,
  executorLabel: `Pair ${taskId} executor: 产品排序任务`, auditorLabel: `Pair ${taskId} auditor: 产品排序任务`,
  executorModel: 'secret-model', executorThinking: 'high', auditorModel: 'other-model', auditorThinking: 'low',
};
const event = (p = payload) => [{ eventId: 'compact', type: 'task_pair.event', ts: Date.now(), payload: p }] as never;
afterEach(() => {
  cleanup(); window.localStorage.clear();
  delete (window as Window & { __imcodesTaskPairSnapshot?: unknown }).__imcodesTaskPairSnapshot;
  vi.restoreAllMocks();
});

function expandedPanel(container: HTMLElement) {
  if (!container.querySelector('.task-pair-status-rows')) fireEvent.click(container.querySelector('.task-pair-status-toggle')!);
}

describe('compact pair identities (screenshot counterexamples)', () => {
  it.each([390, 1280])('renders mobile/desktop %i task names and exact compact session identities', (width) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    const { container } = render(<TaskPairStatusPanel events={event()} />);
    expandedPanel(container);
    const heading = container.querySelector('.task-pair-status-row-title')!;
    expect(heading.textContent).toBe(title);
    const roles = container.querySelector('.task-pair-status-row-roles')!;
    expect(roles.textContent).toContain(`Pair executor${exec}`);
    expect(roles.textContent).toContain(`Pair auditor${audit}`);
    expect(roles.textContent).not.toContain(taskId);
    expect(roles.textContent).not.toContain('产品排序任务');
    expect(roles.textContent).not.toMatch(/secret-model|other-model|card_thinking/);
  });
  it('does not expose an ID-valued or absent task title on panels or event cards', () => {
    for (const value of [taskId, '', undefined]) {
      const p = { ...payload, title: value } as typeof payload;
      const panel = render(<TaskPairStatusPanel events={event(p)} />);
      expandedPanel(panel.container);
      expect(panel.container.querySelector('.task-pair-status-row-title')?.textContent).toBe('taskPair.panel_untitled');
      panel.unmount();
      const card = render(<TaskPairEventChip eventId="old" payload={p} />);
      expect(card.container.querySelector('.task-pair-chip-task')?.textContent).toBe('taskPair.card_untitled');
      expect(card.container.querySelector('.task-pair-chip-task')?.textContent).not.toContain(taskId);
      fireEvent.click(card.container.querySelector('.task-pair-card-toggle')!);
      expect(card.container.textContent).not.toContain(taskId);
      card.unmount();
    }
  });
  it('prefers live renamed labels over old snapshots, with precise links for identical labels and reused roles', () => {
    (window as Window & { __imcodesTaskPairSnapshot?: unknown }).__imcodesTaskPairSnapshot = {
      tasks: [{ ...payload, pair: { ...payload, status: 'working' }, updatedAt: 1 }],
    };
    const navigate = vi.fn();
    const listener = (e: Event) => navigate((e as CustomEvent).detail.session);
    window.addEventListener('deck:navigate', listener);
    const panel = render(<TaskPairStatusPanel events={[]} sessions={[{ name: exec, label: '同名' }, { name: audit, label: '同名' }]} />);
    expandedPanel(panel.container);
    const buttons = panel.container.querySelectorAll<HTMLButtonElement>('.task-pair-status-session');
    expect(buttons).toHaveLength(2);
    buttons.forEach((button) => fireEvent.click(button));
    expect(navigate.mock.calls).toEqual([[exec], [audit]]);
    panel.rerender(<TaskPairStatusPanel events={[]} sessions={[{ name: exec, label: '用户新名' }, { name: audit, label: 'Pair 自定义: 请保留' }]} />);
    expect(panel.container.textContent).toContain('用户新名');
    expect(panel.container.textContent).toContain('Pair 自定义: 请保留');
    act(() => window.dispatchEvent(new CustomEvent('supervision:task-pairs', { detail: {
      tasks: [{ taskId, title, updatedAt: 2, pair: { status: 'working', executor: audit, auditor: exec } }],
    } })));
    const swapped = panel.container.querySelectorAll<HTMLButtonElement>('.task-pair-status-session');
    fireEvent.click(swapped[0]!);
    expect(navigate).toHaveBeenLastCalledWith(audit);
    window.removeEventListener('deck:navigate', listener);
  });
  it('shows event role identities without model/thinking and never links none', () => {
    const { container } = render(<TaskPairEventChip eventId="roles" payload={{ ...payload, auditor: 'none' }} />);
    fireEvent.click(container.querySelector('.task-pair-card-toggle')!);
    const roles = container.querySelectorAll('.task-pair-card-role');
    expect(roles[0]!.textContent).toContain(`Pair executor (${exec})`);
    expect(roles[0]!.textContent).not.toMatch(/产品排序任务|secret-model|card_thinking/);
    expect(roles[1]!.querySelector('button')).toBeNull();
    expect(roles[1]!.textContent).toContain('taskPair.panel_no_audit');
  });
  it.each([false, true])('hides task IDs in collapsed and expanded console (mobile=%s), keeping session IDs', (mobile) => {
    const initial = createSupervisionTaskConsoleState({ projectName: 'test', coordinatorSessionName: 'deck_test_brain' });
    const state = {
      ...initial, phase: SUPERVISION_TASK_CONSOLE_PHASE.READY, subscriptionId: 'test-subscription',
      tasks: { [taskId]: { taskId, title: taskId, objective: 'Do not use objective as task name', status: 'implementing', phase: 'active', validationState: 'pending', updatedAt: Date.now(), lastEventId: 1 } },
      assignments: { worker: { assignmentId: 'worker', taskId, status: 'implementing', phase: 'active', role: 'implementer', ownerSessionName: exec, ownerSessionLabel: payload.executorLabel, observedModel: 'secret-model', validationState: 'pending', updatedAt: Date.now(), lastEventId: 1 } },
    };
    const navigate = vi.fn();
    const { container } = render(<SupervisionTaskConsoleView state={state as never} mobile={mobile} onClose={() => {}} onNavigateSession={navigate} />);
    const card = container.querySelector('.supervision-task-console-task')!;
    expect(card.querySelector('.supervision-task-console-task-title')?.textContent).toContain('taskPair.panel_untitled');
    expect(card.textContent).not.toContain(taskId);
    const button = card.querySelector<HTMLButtonElement>('.supervision-task-console-session')!;
    expect(button.textContent).toContain(`Pair executor (${exec})`);
    expect(button.textContent).not.toContain('secret-model');
    fireEvent.click(button);
    expect(navigate).toHaveBeenCalledWith(exec);
    fireEvent.click(card.querySelector('.supervision-task-console-details-toggle')!);
    expect(card.textContent).not.toContain(taskId);
    expect(card.querySelector('.supervision-task-console-copy-id')).toBeNull();
  });
});
