import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskPairDecisionPanel } from '../../src/components/TaskPairDecisionPanel.js';
import { bindTaskPairDecisions, receiveTaskPairDecision } from '../../src/task-pair-decisions.js';
import type { SupervisionConsolePairInfo } from '@shared/supervision-task-console.js';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let unbind: (() => void) | undefined;
afterEach(() => { cleanup(); unbind?.(); unbind = undefined; });
const question = { id: 'question', project: 'p', taskId: 'task', round: 1, kind: 'request' as const,
  conclusion: 'Choose', summary: 'Source approval', question: 'Which source?', options: [{ id: 'test', label: 'Use test data' }],
  recommendation: 'Keep real data untouched', author: 'executor', at: 10 };
const pair: SupervisionConsolePairInfo = { status: 'working', round: 1, flags: ['needs_input'], blocking: ['P0'],
  decisionRevision: 'revision', decisionRequest: question, brain: 'brain' };
describe('TaskPairDecisionPanel', () => {
  it('shows the blocker/options and sends a selected option with task/question/round, without a resume command', async () => {
    const frames: any[] = [];
    unbind = bindTaskPairDecisions((frame) => {
      frames.push(frame);
      receiveTaskPairDecision(frame.requestId, { ok: true, revision: 'revision', decisions: [{ ...question, id: 'feedback', kind: 'feedback', requestId: question.id }] });
    });
    render(<TaskPairDecisionPanel taskId="task" pair={pair} />);
    expect(screen.getByText('Which source?')).toBeTruthy();
    fireEvent.input(screen.getByRole('textbox'), { target: { value: 'No production writes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use test data' }));
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ taskId: 'task', round: 1, questionId: 'question', optionId: 'test', feedback: 'No production writes' });
  });
  it('makes a missing blocker explicit and accepts free text for older paused tasks', () => {
    render(<TaskPairDecisionPanel taskId="task" pair={{ ...pair, decisionRequest: undefined, flags: ['blocked'] }} />);
    expect(screen.getByText('taskPair.decision.missing')).toBeTruthy();
    expect(screen.getByRole('textbox')).toBeTruthy();
  });
  it('keeps feedback and final rulings distinct and removes choices after a ruling', () => {
    render(<TaskPairDecisionPanel taskId="task" pair={{ ...pair, latestDecision: { ...question, id: 'ruling', kind: 'decision', requestId: question.id, at: 11 } }} />);
    expect(screen.getByText('taskPair.decision.resolved')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use test data' })).toBeNull();
  });
  it('shows delivery failures instead of claiming feedback was sent', async () => {
    unbind = bindTaskPairDecisions((frame) => receiveTaskPairDecision(frame.requestId, { ok: false, error: 'stale question' }));
    render(<TaskPairDecisionPanel taskId="task" pair={pair} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use test data' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('stale question'));
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('offers concrete fallback feedback for paused legacy tasks without inventing a decision', async () => {
    const frames: any[] = [];
    unbind = bindTaskPairDecisions((frame) => {
      frames.push(frame);
      receiveTaskPairDecision(frame.requestId, { ok: true, revision: 'revision', decisions: [] });
    });
    render(<TaskPairDecisionPanel taskId="task" pair={{ ...pair, decisionRequest: undefined, flags: ['blocked'] }} />);
    fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Fixture is ready' } });
    fireEvent.click(screen.getByRole('button', { name: 'taskPair.decision.ready' }));
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    expect(frames[0]).toMatchObject({ taskId: 'task', questionId: null, feedback: 'taskPair.decision.ready_message\nFixture is ready' });
    expect(frames[0].type).not.toContain('resume');
  });
  it('deduplicates double clicks and safely retries the same reply id after a delivery error', async () => {
    const frames: any[] = [];
    unbind = bindTaskPairDecisions((frame) => frames.push(frame));
    render(<TaskPairDecisionPanel taskId="task" pair={pair} />);
    const button = screen.getByRole('button', { name: 'Use test data' });
    fireEvent.click(button); fireEvent.click(button);
    expect(frames).toHaveLength(1);
    await act(async () => receiveTaskPairDecision(frames[0].requestId, { ok: false, error: 'Temporary failure' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    fireEvent.click(button);
    expect(frames).toHaveLength(2);
    expect(frames[1].requestId).toBe(frames[0].requestId);
    await act(async () => receiveTaskPairDecision(frames[1].requestId, { ok: true, revision: 'revision', decisions: [] }));
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
  });
  it('ignores an old reply after the task question changes, preserving the new input', async () => {
    let frame: any;
    unbind = bindTaskPairDecisions((value) => { frame = value; });
    const view = render(<TaskPairDecisionPanel taskId="task" pair={pair} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use test data' }));
    view.rerender(<TaskPairDecisionPanel taskId="task" pair={{ ...pair, decisionRevision: 'new-revision', decisionRequest: { ...question, id: 'new-question' } }} />);
    fireEvent.input(screen.getByRole('textbox'), { target: { value: 'New answer' } });
    await act(async () => receiveTaskPairDecision(frame.requestId, { ok: true, revision: 'revision', decisions: [] }));
    expect(screen.queryByRole('status')).toBeNull();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('New answer');
  });

});
