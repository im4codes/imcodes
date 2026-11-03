import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskPairEventChip } from '../../src/components/TaskPairEventChip.js';
import { TaskPairEventDecisions } from '../../src/components/TaskPairEventDecisions.js';
import { bindTaskPairDecisions, receiveTaskPairDecision } from '../../src/task-pair-decisions.js';
import { TASK_PAIR_DECISION_MSG } from '@shared/task-pair-decision.js';
const layout = vi.hoisted(() => ({ mobile: false }));
vi.mock('../../src/mobile-device.js', () => ({ isMobileLayout: () => layout.mobile }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
let unbind: (() => void) | undefined;
afterEach(() => { cleanup(); unbind?.(); unbind = undefined; layout.mobile = false; vi.restoreAllMocks(); });
const question = { id: 'question', project: 'p', taskId: 'task', round: 1, kind: 'request',
  conclusion: 'Choose', summary: 'Fixture choice', question: 'Which fixture?', recommendation: 'Use isolated data',
  options: [{ id: 'a', label: 'Use A' }], author: 'executor', at: 1000 };
const ruling = { ...question, id: 'ruling', kind: 'decision', requestId: 'question', conclusion: 'Approved', summary: 'Use the test fixture', at: 2000 };
const payload = { taskId: 'task', title: 'Wide desktop task', writer: 'daemon', verb: 'WORKING', toStatus: 'working',
  executor: 'exec', executorLabel: 'Worker', executorModel: 'model-x', auditor: 'aud', auditorLabel: 'Reviewer', auditorModel: 'model-y' };

describe('event decision details are on demand and read only', () => {
  it('shows desktop role/model overview before opening and does not eagerly fetch history', async () => {
    const send = vi.fn(); unbind = bindTaskPairDecisions(send);
    const { container } = render(<TaskPairEventChip eventId="desktop" payload={payload} />);
    expect(container.querySelector('.task-pair-card-overview')?.textContent).toContain('Worker (exec)');
    expect(container.textContent).toContain('taskPair.card_model');
    await act(async () => {});
    expect(send).not.toHaveBeenCalled();
  });
  it('keeps phone overview compact and reads history only after click', async () => {
    layout.mobile = true;
    const send = vi.fn((frame) => receiveTaskPairDecision(frame.requestId, { ok: true, revision: 'r', decisions: [ruling, question] }));
    unbind = bindTaskPairDecisions(send);
    const { container } = render(<TaskPairEventChip eventId="phone" payload={payload} />);
    expect(container.querySelector('.task-pair-card-overview')).toBeNull();
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('.task-pair-card-toggle')!);
    await waitFor(() => expect(container.textContent).toContain('Use the test fixture'));
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].type).toBe(TASK_PAIR_DECISION_MSG.HISTORY);
  });
  it('shows question/recommendation/ruling/time but never offers feedback based on an old event', async () => {
    const send = vi.fn((frame) => receiveTaskPairDecision(frame.requestId, { ok: true, revision: 'r', decisions: [ruling, question] }));
    unbind = bindTaskPairDecisions(send);
    render(<TaskPairEventDecisions taskId="task" status="working" />);
    await waitFor(() => expect(screen.getByText(/Which fixture/)).toBeTruthy());
    expect(document.body.textContent).toContain('Use isolated data');
    expect(document.body.textContent).toContain('Use the test fixture');
    expect(document.querySelector('.task-pair-decision-time time')?.getAttribute('datetime')).toBe(new Date(2000).toISOString());
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use A' })).toBeNull();
    expect(document.body.textContent).not.toContain('taskPair.decision.sent');
    expect(send.mock.calls.every(([frame]) => frame.type === TASK_PAIR_DECISION_MSG.HISTORY)).toBe(true);
  });
  it('does not invent a blocker or ruling for empty history', async () => {
    unbind = bindTaskPairDecisions((frame) => receiveTaskPairDecision(frame.requestId, { ok: true, revision: 'r', decisions: [] }));
    const { container } = render(<TaskPairEventDecisions taskId="task" status="done" />);
    await waitFor(() => expect(container.textContent).toBe(''));
    expect(container.querySelector('.task-pair-decision')).toBeNull();
  });
  it('drops late results across task changes and unmounts', async () => {
    const frames: Array<{ requestId: string; taskId: string }> = [];
    unbind = bindTaskPairDecisions((frame) => { frames.push(frame); });
    const view = render(<TaskPairEventDecisions taskId="task" status="working" />);
    view.rerender(<TaskPairEventDecisions taskId="other" status="working" />);
    await act(async () => receiveTaskPairDecision(frames[0].requestId, { ok: true, revision: 'r', decisions: [ruling, question] }));
    expect(view.container.textContent).not.toContain('Use the test fixture');
    await act(async () => receiveTaskPairDecision(frames[1].requestId, { ok: true, revision: 'r', decisions: [] }));
    expect(view.container.textContent).toBe('');
    view.rerender(<TaskPairEventDecisions taskId="third" status="working" />);
    view.unmount();
    await act(async () => receiveTaskPairDecision(frames[2].requestId, { ok: true, revision: 'r', decisions: [ruling] }));
    expect(document.body.textContent).not.toContain('Use the test fixture');
  });
  it('shows a retryable history failure without clearing other event content', async () => {
    let failed = true;
    const send = vi.fn((frame) => receiveTaskPairDecision(frame.requestId, failed
      ? { ok: false, error: 'unavailable' }
      : { ok: true, revision: 'r', decisions: [ruling, question] }));
    unbind = bindTaskPairDecisions(send);
    render(<TaskPairEventDecisions taskId="task" status="working" />);
    await waitFor(() => expect(screen.getByText('taskPair.decision.history_failed')).toBeTruthy());
    failed = false; fireEvent.click(screen.getByRole('button', { name: 'taskPair.decision.retry' }));
    await waitFor(() => expect(screen.getByText(/Use the test fixture/)).toBeTruthy());
    expect(send).toHaveBeenCalledTimes(2);
  });
});
