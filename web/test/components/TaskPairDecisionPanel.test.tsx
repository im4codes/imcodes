import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskPairDecisionPanel } from '../../src/components/TaskPairDecisionPanel.js';
import { bindTaskPairDecisions, receiveTaskPairDecision } from '../../src/task-pair-decisions.js';
import type { SupervisionConsolePairInfo } from '@shared/supervision-task-console.js';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let unbind: (() => void) | undefined;
afterEach(() => { cleanup(); unbind?.(); unbind = undefined; vi.restoreAllMocks(); });
const question = { id: 'question', project: 'p', taskId: 'task', round: 1, kind: 'request' as const,
  conclusion: 'Choose', summary: 'Source approval', question: 'Which source?', options: [{ id: 'test', label: 'Use test data' }],
  recommendation: 'Keep real data untouched', author: 'executor', at: 10 };
const pair: SupervisionConsolePairInfo = { status: 'working', round: 1, flags: ['needs_input'], blocking: ['P0'],
  decisionRevision: 'revision', decisionRequest: question, brain: 'brain' };
describe('TaskPairDecisionPanel', () => {
  it('folds long decision copy with expand/collapse while keeping feedback controls outside it', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(180);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(90);
    const long = { ...pair, decisionRequest: { ...question, question: 'Long blocker '.repeat(60) } };
    render(<TaskPairDecisionPanel taskId="task" pair={long} />);
    const copy = screen.getByTestId('expandable-task-objective-text');
    expect(copy.closest('.task-pair-decision-copy')).toBeTruthy();
    expect(copy.getAttribute('role')).toBe('region');
    expect(copy.getAttribute('aria-label')).toBe('taskPair.decision.title');
    expect(copy.tabIndex).toBe(0);
    expect(screen.getByRole('button', { name: 'delegation.objective_expand' }).getAttribute('aria-expanded')).toBe('false');
    expect(copy.contains(screen.getByRole('button', { name: 'Use test data' }))).toBe(false);
    expect(copy.contains(screen.getByRole('textbox'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'delegation.objective_expand' }));
    expect(copy.classList.contains('is-expanded')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'delegation.objective_collapse' }));
    expect(copy.classList.contains('is-clamped')).toBe(true);
  });
  it('does not add an expansion control to short copy', () => {
    render(<TaskPairDecisionPanel taskId="task" pair={pair} />);
    expect(screen.queryByRole('button', { name: 'delegation.objective_expand' })).toBeNull();
    expect(screen.getByTestId('expandable-task-objective-text').hasAttribute('tabindex')).toBe(false);
  });
  it('starts a new ruling collapsed and shows its decision time outside the folded text', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(180);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(90);
    const ruling = { ...question, id: 'ruling', kind: 'decision' as const, requestId: question.id, at: 1_793_673_000_000 };
    const view = render(<TaskPairDecisionPanel taskId="task" pair={{ ...pair, latestDecision: ruling }} />);
    fireEvent.click(screen.getByRole('button', { name: 'delegation.objective_expand' }));
    view.rerender(<TaskPairDecisionPanel taskId="task" pair={{ ...pair, latestDecision: { ...ruling, id: 'ruling-2', at: ruling.at + 1000 } }} />);
    expect(screen.getByRole('button', { name: 'delegation.objective_expand' }).getAttribute('aria-expanded')).toBe('false');
    const time = document.querySelector('.task-pair-decision-time time');
    expect(time?.getAttribute('datetime')).toBe(new Date(ruling.at + 1000).toISOString());
    expect(time?.textContent).toBe(new Date(ruling.at + 1000).toLocaleString());
    expect(time?.closest('.task-pair-decision-copy')).toBeNull();
  });
  it('numbers history records in their returned order and includes each timestamp and round', async () => {
    const records = [
      { ...question, id: 'ruling', kind: 'decision' as const, at: 1_793_673_000_000 },
      { ...question, id: 'reply', kind: 'feedback' as const, at: 1_793_672_000_000 },
      question,
    ];
    unbind = bindTaskPairDecisions((frame) => receiveTaskPairDecision(frame.requestId, { ok: true, decisions: records }));
    render(<TaskPairDecisionPanel taskId="task" pair={pair} />);
    const details = screen.getByText('taskPair.decision.history').parentElement as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    await waitFor(() => expect(document.querySelectorAll('.task-pair-decision-records > li')).toHaveLength(3));
    const rows = [...document.querySelectorAll('.task-pair-decision-records > li')];
    rows.forEach((row, index) => {
      expect(row.getAttribute('value')).toBe(String(index + 1));
      expect(row.querySelector('time')?.getAttribute('datetime')).toBe(new Date(records[index].at).toISOString());
      expect(row.textContent).toContain('taskPair.round');
    });
  });
  it('shows the blocker/options and sends a selected option with task/question/round, without a resume command', async () => {
    const frames: any[] = [];
    unbind = bindTaskPairDecisions((frame) => {
      frames.push(frame);
      receiveTaskPairDecision(frame.requestId, { ok: true, revision: 'revision', decisions: [{ ...question, id: 'feedback', kind: 'feedback', requestId: question.id }] });
    });
    render(<TaskPairDecisionPanel taskId="task" pair={pair} />);
    expect(screen.getByText(/Which source\?/)).toBeTruthy();
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

  it('does not let loaded history mask a newer ruling or inherit its expansion', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(180);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(90);
    const ruling = { ...question, id: 'ruling', kind: 'decision' as const, requestId: question.id, at: 1000 };
    unbind = bindTaskPairDecisions((frame) => receiveTaskPairDecision(frame.requestId, { ok: true, decisions: [ruling] }));
    const view = render(<TaskPairDecisionPanel taskId="task" pair={{ ...pair, latestDecision: ruling }} />);
    const details = screen.getByText('taskPair.decision.history').parentElement as HTMLDetailsElement;
    details.open = true; fireEvent(details, new Event('toggle'));
    await waitFor(() => expect(document.querySelectorAll('.task-pair-decision-records > li')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'delegation.objective_expand' }));
    view.rerender(<TaskPairDecisionPanel taskId="task" pair={{ ...pair, latestDecision: { ...ruling, id: 'new-ruling', at: 2000, summary: 'New conclusion' } }} />);
    expect(document.querySelector('.task-pair-decision-time time')?.getAttribute('datetime')).toBe(new Date(2000).toISOString());
    expect(screen.getByTestId('expandable-task-objective-text').textContent).toContain('New conclusion');
    expect(screen.getByRole('button', { name: 'delegation.objective_expand' }).getAttribute('aria-expanded')).toBe('false');
  });
  it('ignores stale history across task A to B to A and loads the current history on demand', async () => {
    const frames: any[] = [];
    unbind = bindTaskPairDecisions((frame) => frames.push(frame));
    const view = render(<TaskPairDecisionPanel taskId="task" pair={pair} />);
    const openHistory = () => {
      const details = screen.getByText('taskPair.decision.history').parentElement as HTMLDetailsElement;
      details.open = true; fireEvent(details, new Event('toggle'));
    };
    openHistory();
    view.rerender(<TaskPairDecisionPanel taskId="other" pair={pair} />);
    view.rerender(<TaskPairDecisionPanel taskId="task" pair={pair} />);
    await act(async () => receiveTaskPairDecision(frames[0].requestId, { ok: true, decisions: [{ ...question, id: 'stale', summary: 'Stale history' }] }));
    expect(document.querySelectorAll('.task-pair-decision-records > li')).toHaveLength(0);
    openHistory();
    await act(async () => receiveTaskPairDecision(frames.at(-1).requestId, { ok: true, decisions: [{ ...question, id: 'current', summary: 'Current history' }] }));
    expect(document.querySelector('.task-pair-decision-records')?.textContent).toContain('Current history');
    expect(document.querySelector('.task-pair-decision-records')?.textContent).not.toContain('Stale history');
  });
  it('ignores a stale feedback acknowledgement after task A to B to A', async () => {
    let frame: any;
    unbind = bindTaskPairDecisions((value) => { frame = value; });
    const view = render(<TaskPairDecisionPanel taskId="task" pair={pair} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use test data' }));
    view.rerender(<TaskPairDecisionPanel taskId="other" pair={pair} />);
    view.rerender(<TaskPairDecisionPanel taskId="task" pair={pair} />);
    fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Current input' } });
    await act(async () => receiveTaskPairDecision(frame.requestId, { ok: true, decisions: [] }));
    expect(screen.queryByRole('status')).toBeNull();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Current input');
  });

  it('keeps an in-flight feedback reply locked when its live feedback record arrives before the ack', async () => {
    const frames: any[] = [];
    unbind = bindTaskPairDecisions((frame) => frames.push(frame));
    const view = render(<TaskPairDecisionPanel taskId="task" pair={pair} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use test data' }));
    view.rerender(<TaskPairDecisionPanel taskId="task" pair={{ ...pair, latestDecision: { ...question, id: 'live-feedback', kind: 'feedback', requestId: question.id, at: 20 } }} />);
    const button = screen.getByRole('button', { name: 'Use test data' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(frames).toHaveLength(1);
    await act(async () => receiveTaskPairDecision(frames[0].requestId, { ok: true, decisions: [] }));
    expect(screen.getByRole('status')).toBeTruthy();
  });

  describe('category classification and wait reasons (tsk_af1a123756)', () => {
    it('shows completed_awaiting_brain when executor reported done without blocker (counterexample to base)', () => {
      // In base, pair.status === 'awaiting_brain_decision' fell into generic 'taskPair.decision.title',
      // rendered 'taskPair.decision.missing', fake buttons ('ask', 'ready', 'wait'), and open textarea.
      const completedPair: SupervisionConsolePairInfo = {
        status: 'awaiting_brain_decision',
        round: 1,
        flags: [],
        blocking: [],
        executor: 'Ag1',
        brain: 'BrainChief',
        decisionRevision: 'rev-1',
      };
      render(<TaskPairDecisionPanel taskId="task" pair={completedPair} />);

      expect(screen.getByText('taskPair.decision.title_completed')).toBeTruthy();
      expect(screen.queryByText('taskPair.decision.title')).toBeNull();
      expect(screen.queryByText('taskPair.decision.missing')).toBeNull();
      // No fake blocker buttons
      expect(screen.queryByRole('button', { name: 'taskPair.decision.ask' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'taskPair.decision.ready' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'taskPair.decision.wait' })).toBeNull();
      // Feedback is tucked inside collapsed details, not directly dominating card
      const details = screen.getByText('taskPair.decision.feedback').closest('details') as HTMLDetailsElement;
      expect(details).toBeTruthy();
      expect(details.open).toBe(false);
    });

    it('shows wait_dependencies with dependency task list and note, omitting ask button', () => {
      const depPair: SupervisionConsolePairInfo = {
        status: 'working',
        round: 1,
        flags: [],
        blocking: [],
        scheduling: {
          dependsOn: ['tsk_backend', 'tsk_auth'],
          note: 'Waiting for auth migration',
        },
        decisionRevision: 'rev-1',
      };
      render(<TaskPairDecisionPanel taskId="task" pair={depPair} />);

      expect(screen.getByText('taskPair.decision.title_dependencies')).toBeTruthy();
      const objective = screen.getByTestId('expandable-task-objective-text');
      expect(objective.textContent).toContain('Waiting for auth migration');
      expect(objective.textContent).toContain('taskPair.decision.waiting_for_tasks');
      expect(objective.textContent).toContain('taskPair.decision.responsible_brain');
      // No ask button because reason is known, but ready and wait buttons exist
      expect(screen.queryByRole('button', { name: 'taskPair.decision.ask' })).toBeNull();
      expect(screen.getByRole('button', { name: 'taskPair.decision.ready' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'taskPair.decision.wait' })).toBeTruthy();
    });

    it('shows paused with scheduling note', () => {
      const pausedPair: SupervisionConsolePairInfo = {
        status: 'working',
        round: 1,
        flags: [],
        blocking: [],
        scheduling: {
          manual: true,
          dependsOn: [],
          pausedAt: 1793700000000,
          note: 'Paused for database backup',
        },
        decisionRevision: 'rev-1',
      };
      render(<TaskPairDecisionPanel taskId="task" pair={pausedPair} />);

      expect(screen.getByText('taskPair.decision.title_paused')).toBeTruthy();
      const objective = screen.getByTestId('expandable-task-objective-text');
      expect(objective.textContent).toContain('Paused for database backup');
      expect(objective.textContent).toContain('taskPair.decision.responsible_brain');
    });

    it('shows waiting_capacity when waiting_for_capacity or needs_auditor flag is set', () => {
      const capPair: SupervisionConsolePairInfo = {
        status: 'working',
        round: 1,
        flags: ['waiting_for_capacity'],
        blocking: [],
        waitingReason: 'Concurrency limit reached: 4/4 workers active',
        decisionRevision: 'rev-1',
      };
      render(<TaskPairDecisionPanel taskId="task" pair={capPair} />);

      expect(screen.getByText('taskPair.decision.title_capacity')).toBeTruthy();
      const objective = screen.getByTestId('expandable-task-objective-text');
      expect(objective.textContent).toContain('Concurrency limit reached: 4/4 workers active');
      expect(objective.textContent).toContain('taskPair.decision.responsible_scheduler');
      // No blocker buttons
      expect(screen.queryByRole('button', { name: 'taskPair.decision.ask' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'taskPair.decision.ready' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'taskPair.decision.wait' })).toBeNull();
    });

    it('shows blocked with specific note and identified executor author', () => {
      const blockedPair: SupervisionConsolePairInfo = {
        status: 'working',
        round: 1,
        flags: ['blocked'],
        blocking: ['P0'],
        blockedNote: 'Third-party API rate limited (HTTP 429)',
        flagSides: { blocked: 'executor' },
        executor: 'Ag1',
        decisionRevision: 'rev-1',
      };
      render(<TaskPairDecisionPanel taskId="task" pair={blockedPair} />);

      expect(screen.getByText('taskPair.decision.title_blocked')).toBeTruthy();
      const objective = screen.getByTestId('expandable-task-objective-text');
      expect(objective.textContent).toContain('Third-party API rate limited (HTTP 429)');
      expect(objective.textContent).toContain('taskPair.decision.responsible_executor');
      // Does not ask Brain to explain since blockedNote is already clear
      expect(screen.queryByRole('button', { name: 'taskPair.decision.ask' })).toBeNull();
      expect(screen.getByRole('button', { name: 'taskPair.decision.ready' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'taskPair.decision.wait' })).toBeTruthy();
    });

    it('shows legacy_unknown with missing notice and ask button for truly unrecorded blocker', () => {
      const unknownPair: SupervisionConsolePairInfo = {
        status: 'working',
        round: 1,
        flags: ['blocked'],
        blocking: ['P0'],
        decisionRevision: 'rev-1',
      };
      render(<TaskPairDecisionPanel taskId="task" pair={unknownPair} />);

      expect(screen.getByText('taskPair.decision.title')).toBeTruthy();
      expect(screen.getByText('taskPair.decision.missing')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'taskPair.decision.ask' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'taskPair.decision.ready' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'taskPair.decision.wait' })).toBeTruthy();
    });
  });
});
