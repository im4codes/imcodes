import { TASK_PAIR_DECISION_ERROR, TASK_PAIR_DECISION_MSG } from '@shared/task-pair-decision.js';
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
  it('accepts free text for older paused tasks without inventing blocker details', () => {
    render(<TaskPairDecisionPanel taskId="task" pair={{ ...pair, decisionRequest: undefined, flags: ['blocked'] }} />);
    expect(screen.queryByText('taskPair.decision.missing')).toBeNull();
    expect(document.querySelector('.task-pair-decision-copy')).toBeNull();
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

    it('keeps legacy_unknown actions without a placeholder for an unrecorded blocker', () => {
      const unknownPair: SupervisionConsolePairInfo = {
        status: 'working',
        round: 1,
        flags: ['blocked'],
        blocking: ['P0'],
        decisionRevision: 'rev-1',
      };
      render(<TaskPairDecisionPanel taskId="task" pair={unknownPair} />);

      expect(screen.getByText('taskPair.decision.title')).toBeTruthy();
      expect(screen.queryByText('taskPair.decision.missing')).toBeNull();
    expect(document.querySelector('.task-pair-decision-copy')).toBeNull();
      expect(screen.getByRole('button', { name: 'taskPair.decision.ask' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'taskPair.decision.ready' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'taskPair.decision.wait' })).toBeTruthy();
    });

    it('a current BLOCKED note after PASS must not become completed-awaiting-Brain (F1)', () => {
      render(
        <TaskPairDecisionPanel
          taskId="task"
          pair={{
            status: 'passed',
            round: 1,
            lastVerdict: 'PASS',
            flags: ['blocked'],
            flagSides: { blocked: 'executor' },
            blockedNote: 'Current merge conflict needs input',
            executor: 'Ag1',
            brain: 'BrainChief',
            decisionRevision: 'rev-1',
          }}
        />,
      );
      expect(screen.getByTestId('expandable-task-objective-text').textContent).toContain('Current merge conflict needs input');
      expect(screen.queryByText('taskPair.decision.title_completed')).toBeNull();
      expect(screen.getByText('taskPair.decision.title_blocked')).toBeTruthy();
    });

    it('a pair with only an authoritative blockedNote still explains the blocker (F1)', () => {
      render(
        <TaskPairDecisionPanel
          taskId="task"
          pair={{
            status: 'working',
            round: 1,
            flags: [],
            blockedNote: 'Approval source has not been provided',
            decisionRevision: 'rev-1',
          }}
        />,
      );
      const copy = screen.queryByTestId('expandable-task-objective-text');
      expect(copy).not.toBeNull();
      expect(copy!.textContent).toContain('Approval source has not been provided');
      expect(screen.getByText('taskPair.decision.title_blocked')).toBeTruthy();
    });

    it('a late ruling for old question A must not resolve new same-round question B (F2)', () => {
      const a: any = {
        id: 'a', project: 'p', taskId: 'task', round: 1, kind: 'request',
        conclusion: 'Old', summary: 'Old issue', question: 'Old issue?', author: 'exec', at: 10,
      };
      const b: any = { ...a, id: 'b', question: 'Current issue B?', summary: 'Current issue B', at: 20 };
      render(
        <TaskPairDecisionPanel
          taskId="task"
          pair={{
            status: 'working',
            round: 1,
            flags: ['needs_input'],
            decisionRevision: 'rev-1',
            decisionRequest: b,
            latestDecision: { ...a, id: 'ruling-a', kind: 'decision', requestId: 'a', conclusion: 'Resolved A', at: 30 },
          }}
        />,
      );
      expect(screen.queryByText('taskPair.decision.resolved')).toBeNull();
      expect(screen.getByTestId('expandable-task-objective-text').textContent).toContain('Current issue B?');
      expect(screen.getByText('taskPair.decision.title_request')).toBeTruthy();
    });

    it('F1-R2: a known manual pause note is not replaced with unknown because a blocked flag remains', () => {
      render(
        <TaskPairDecisionPanel
          taskId="task"
          pair={{
            status: 'working',
            round: 1,
            flags: ['blocked'],
            flagSides: { blocked: 'executor' },
            blocking: ['P0'],
            executor: 'Ag1',
            brain: 'BrainChief',
            scheduling: {
              epoch: 1,
              manual: true,
              dependsOn: [],
              since: 1,
              writer: 'BrainChief',
              note: 'Approved maintenance window',
            },
            decisionRevision: 'rev-1',
          }}
        />,
      );
      expect(screen.getByTestId('expandable-task-objective-text').textContent).toContain('Approved maintenance window');
      expect(screen.queryByText('taskPair.decision.missing')).toBeNull();
      expect(screen.getByText('taskPair.decision.title_paused')).toBeTruthy();
    });

    it('F1-R2: a known dependency wait is not replaced with unknown because a blocked flag remains', () => {
      render(
        <TaskPairDecisionPanel
          taskId="task"
          pair={{
            status: 'working',
            round: 1,
            flags: ['blocked'],
            flagSides: { blocked: 'executor' },
            blocking: ['P0'],
            executor: 'Ag1',
            brain: 'BrainChief',
            scheduling: {
              epoch: 1,
              manual: false,
              dependsOn: ['tsk_dep1'],
              since: 1,
              writer: 'BrainChief',
              note: 'Waiting for dep1',
            },
            decisionRevision: 'rev-1',
          }}
        />,
      );
      expect(screen.getByTestId('expandable-task-objective-text').textContent).toContain('Waiting for dep1');
      expect(screen.queryByText('taskPair.decision.missing')).toBeNull();
      expect(screen.getByText('taskPair.decision.title_dependencies')).toBeTruthy();
    });

    it('F1-R2: a known capacity wait is not replaced with unknown because a blocked flag remains', () => {
      render(
        <TaskPairDecisionPanel
          taskId="task"
          pair={{
            status: 'working',
            round: 1,
            flags: ['blocked', 'waiting_for_capacity'],
            waitingReason: 'Pool exhausted',
            decisionRevision: 'rev-1',
          }}
        />,
      );
      expect(screen.getByTestId('expandable-task-objective-text').textContent).toContain('Pool exhausted');
      expect(screen.queryByText('taskPair.decision.missing')).toBeNull();
      expect(screen.getByText('taskPair.decision.title_capacity')).toBeTruthy();
    });

    it('F2-R2: an unbound late ruling from delivery 1 does not resolve a delivery 2 request', () => {
      const questionDeliv2: any = {
        id: 'q-delivery-2', project: 'p', taskId: 'task', round: 1, deliveryRound: 2,
        kind: 'request', conclusion: 'Current', summary: 'Current B', question: 'Current delivery B?', author: 'Ag1', at: 20,
      };
      const rulingDeliv1: any = {
        id: 'old-ruling', project: 'p', taskId: 'task', round: 1, deliveryRound: 1,
        kind: 'decision', conclusion: 'Old delivery', summary: 'Old', author: 'BrainChief', at: 30,
      };
      render(
        <TaskPairDecisionPanel
          taskId="task"
          pair={{
            status: 'working',
            round: 1,
            deliveryRound: 2,
            flags: ['blocked'],
            decisionRevision: 'rev-2',
            decisionRequest: questionDeliv2,
            latestDecision: rulingDeliv1,
          }}
        />,
      );
      expect(screen.queryByText('taskPair.decision.resolved')).toBeNull();
      expect(screen.getByTestId('expandable-task-objective-text').textContent).toContain('Current delivery B?');
      expect(screen.getByText('taskPair.decision.title_request')).toBeTruthy();
    });

    it('F2-R2: a ruling matching delivery 2 resolves delivery 2 request (positive control)', () => {
      const questionDeliv2: any = {
        id: 'q-delivery-2', project: 'p', taskId: 'task', round: 1, deliveryRound: 2,
        kind: 'request', conclusion: 'Current', summary: 'Current B', question: 'Current delivery B?', author: 'Ag1', at: 20,
      };
      const rulingDeliv2: any = {
        id: 'ruling-deliv-2', project: 'p', taskId: 'task', round: 1, deliveryRound: 2,
        kind: 'decision', conclusion: 'Approved B', summary: 'Go ahead with B', author: 'BrainChief', at: 30,
      };
      render(
        <TaskPairDecisionPanel
          taskId="task"
          pair={{
            status: 'working',
            round: 1,
            deliveryRound: 2,
            flags: ['blocked'],
            decisionRevision: 'rev-2',
            decisionRequest: questionDeliv2,
            latestDecision: rulingDeliv2,
          }}
        />,
      );
      expect(screen.getByText('taskPair.decision.resolved')).toBeTruthy();
      expect(screen.getByTestId('expandable-task-objective-text').textContent).toContain('Go ahead with B');
    });

    it('F1-R3: an old resolved question must not suppress a new blocker title or free feedback, and old option reply remains rejected', async () => {
      const questionA: any = {
        id: 'q-old', project: 'p', taskId: 'task', round: 1, deliveryRound: 1,
        kind: 'request', conclusion: 'Old approval', summary: 'Old source?', question: 'Old source?',
        options: [{ id: 'opt-a', label: 'Option A' }], author: 'executor', at: 10,
      };
      const rulingA: any = {
        ...questionA, id: 'ruling-old', kind: 'decision', requestId: questionA.id, author: 'brain',
        conclusion: 'Old source approved', at: 20,
      };
      const currentWithNewBlocker: SupervisionConsolePairInfo = {
        status: 'working',
        round: 1,
        deliveryRound: 1,
        flags: ['blocked'],
        flagSides: { blocked: 'executor' },
        blocking: ['P0'],
        blockedNote: 'NEW blocker: current credentials are unavailable',
        decisionRevision: 'rev-current',
        decisionRequest: questionA,
        latestDecision: rulingA,
        brain: 'brain',
      };

      const frames: any[] = [];
      unbind = bindTaskPairDecisions((frame) => {
        frames.push(frame);
        receiveTaskPairDecision(frame.requestId, { ok: true, decisions: [] });
      });

      render(<TaskPairDecisionPanel taskId="task" pair={currentWithNewBlocker} />);

      // Blocker note is visible
      expect(screen.getByTestId('expandable-task-objective-text').textContent).toContain('NEW blocker: current credentials are unavailable');
      // Title reflects current blocker category, NOT resolved
      expect(screen.queryByText('taskPair.decision.title_blocked')).not.toBeNull();
      expect(screen.queryByText('taskPair.decision.resolved')).toBeNull();
      // Free feedback textarea is accessible
      const textarea = screen.queryByRole('textbox');
      expect(textarea).not.toBeNull();
      // Old question options are NOT shown
      expect(screen.queryByRole('button', { name: 'Option A' })).toBeNull();

      // Submitting free feedback passes questionId: null
      fireEvent.input(textarea!, { target: { value: 'Credentials are now available' } });
      fireEvent.click(screen.getByRole('button', { name: 'taskPair.decision.send' }));

      await waitFor(() => expect(frames).toHaveLength(1));
      expect(frames[0]).toMatchObject({
        type: 'supervision.task_console.decision_feedback',
        taskId: 'task',
        questionId: null,
        feedback: 'Credentials are now available',
      });
    });

    it('F1-R4: current free feedback ACK does not resurrect old resolved question/options, and live reload/projection suppresses resolved request', async () => {
      const questionOld: any = {
        id: 'q-old', project: 'p', taskId: 'task', round: 1, deliveryRound: 1,
        kind: 'request', conclusion: 'Old conclusion', summary: 'Old question summary',
        question: 'Old question?', options: [{ id: 'old-opt', label: 'OLD CHOICE' }],
        author: 'executor', at: 10,
      };
      const rulingOld: any = {
        ...questionOld,
        id: 'ruling-old', kind: 'decision', requestId: questionOld.id,
        author: 'brain', conclusion: 'Approved Old', at: 20,
      };
      const current: SupervisionConsolePairInfo = {
        status: 'working',
        round: 1,
        deliveryRound: 1,
        flags: ['blocked'],
        blocking: ['P0'],
        blockedNote: 'NEW blocker: credentials unavailable',
        decisionRevision: 'rev-current',
        decisionRequest: questionOld,
        latestDecision: rulingOld,
        brain: 'brain',
      };

      unbind = bindTaskPairDecisions((frame) => {
        const feedbackRecord = {
          id: 'feedback-1', project: 'p', taskId: 'task', round: 1, deliveryRound: 1,
          kind: 'feedback' as const, summary: 'Feedback text', author: 'brain', at: 30,
        };
        receiveTaskPairDecision(frame.requestId, {
          ok: true,
          decisions: [feedbackRecord, rulingOld, questionOld],
        });
      });

      render(<TaskPairDecisionPanel taskId="task" pair={current} />);

      expect(screen.queryByRole('button', { name: 'OLD CHOICE' })).toBeNull();
      expect(screen.getByTestId('expandable-task-objective-text').textContent).toContain('NEW blocker: credentials unavailable');

      fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Current credentials are now available' } });
      fireEvent.click(screen.getByRole('button', { name: 'taskPair.decision.send' }));

      await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());

      expect(screen.queryByRole('button', { name: 'OLD CHOICE' })).toBeNull();
      expect(screen.getByTestId('expandable-task-objective-text').textContent).toContain('NEW blocker: credentials unavailable');

      cleanup();
      const reloadedPair: SupervisionConsolePairInfo = {
        ...current,
        decisionRequest: undefined,
        latestDecision: {
          id: 'feedback-1', project: 'p', taskId: 'task', round: 1, deliveryRound: 1,
          kind: 'feedback' as const, summary: 'Feedback text', author: 'brain', at: 30,
        },
      };
      render(<TaskPairDecisionPanel taskId="task" pair={reloadedPair} />);

      expect(screen.queryByRole('button', { name: 'OLD CHOICE' })).toBeNull();
      expect(screen.getByTestId('expandable-task-objective-text').textContent).toContain('NEW blocker: credentials unavailable');
    });

    it('F1-R5: live feedback before ACK retains new-note submission lock after an older ruling, and settling ACK releases lock and clears draft', async () => {
      const oldRuling: any = {
        id: 'old-ruling',
        project: 'p',
        taskId: 'task',
        round: 1,
        deliveryRound: 1,
        kind: 'decision',
        conclusion: 'Old ruling',
        summary: 'Old summary',
        author: 'brain',
        at: 20,
      };
      const current: SupervisionConsolePairInfo = {
        status: 'working',
        round: 1,
        deliveryRound: 1,
        flags: ['blocked'],
        blocking: ['P0'],
        blockedNote: 'Current NEW blocker',
        decisionRevision: 'rev-current-2',
        decisionRequest: undefined,
        latestDecision: oldRuling,
        brain: 'brain',
      };

      const capturedFrames: any[] = [];
      unbind = bindTaskPairDecisions((frame) => {
        capturedFrames.push(frame);
      });

      const view = render(<TaskPairDecisionPanel taskId="task" pair={current} />);
      const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textbox.disabled).toBe(false);

      // Submit new-note feedback
      fireEvent.input(textbox, { target: { value: 'Current explanation response' } });
      fireEvent.click(screen.getByRole('button', { name: 'taskPair.decision.send' }));

      await waitFor(() => expect(capturedFrames).toHaveLength(1));
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);

      // Live projection arrives before ACK: latestDecision becomes FEEDBACK
      view.rerender(
        <TaskPairDecisionPanel
          taskId="task"
          pair={{
            ...current,
            latestDecision: {
              id: 'live-feedback',
              project: 'p',
              taskId: 'task',
              round: 1,
              deliveryRound: 1,
              kind: 'feedback',
              conclusion: 'Human feedback',
              summary: 'Current explanation response',
              author: 'human',
              at: 30,
            },
          }}
        />
      );

      // Submission lock and draft text MUST be retained
      const liveTextbox = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(liveTextbox.disabled).toBe(true);
      expect(liveTextbox.value).toBe('Current explanation response');

      // Now settle the ACK: form cleans up and clears text
      receiveTaskPairDecision(capturedFrames[0].requestId, {
        ok: true,
        decisions: [
          {
            id: 'live-feedback',
            project: 'p',
            taskId: 'task',
            round: 1,
            deliveryRound: 1,
            kind: 'feedback',
            conclusion: 'Human feedback',
            summary: 'Current explanation response',
            author: 'human',
            at: 30,
          },
        ],
      });

      await waitFor(() => expect(liveTextbox.disabled).toBe(false));
      expect(liveTextbox.value).toBe('');
    });

    it('preserves live-before-ACK submission lock even when 201 other cards are mounted', async () => {
      const oldRuling: TaskPairDecisionRecord = {
        id: 'old-ruling',
        project: 'p',
        taskId: 'task',
        round: 1,
        deliveryRound: 1,
        kind: 'decision',
        conclusion: 'Old approval',
        summary: 'Old',
        author: 'brain',
        at: 20,
      };

      const current: SupervisionConsolePairInfo = {
        status: 'working',
        round: 1,
        deliveryRound: 1,
        flags: ['blocked'],
        blocking: ['P0'],
        blockedNote: 'Current NEW blocker',
        decisionRevision: 'rev-current-eviction',
        decisionRequest: undefined,
        latestDecision: oldRuling,
        brain: 'brain',
      };

      const capturedFrames: any[] = [];
      unbind = bindTaskPairDecisions((frame) => {
        capturedFrames.push(frame);
      });

      const view = render(<TaskPairDecisionPanel taskId="task" pair={current} />);
      const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textbox.disabled).toBe(false);

      fireEvent.input(textbox, { target: { value: 'Current explanation response' } });
      fireEvent.click(screen.getByRole('button', { name: 'taskPair.decision.send' }));

      await waitFor(() => expect(capturedFrames).toHaveLength(1));
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);

      // Render 201 other real cards to test cache eviction boundary
      render(
        <>
          {Array.from({ length: 201 }, (_, i) => (
            <TaskPairDecisionPanel
              key={i}
              taskId={`other-${i}`}
              readOnly
              pair={{
                ...current,
                latestDecision: {
                  ...oldRuling,
                  id: `other-ruling-${i}`,
                  taskId: `other-${i}`,
                },
              }}
            />
          ))}
        </>
      );

      // Live projection arrives before ACK: latestDecision becomes FEEDBACK
      view.rerender(
        <TaskPairDecisionPanel
          taskId="task"
          pair={{
            ...current,
            latestDecision: {
              id: 'live-feedback',
              project: 'p',
              taskId: 'task',
              round: 1,
              deliveryRound: 1,
              kind: 'feedback',
              conclusion: 'Human feedback',
              summary: 'Current explanation response',
              author: 'human',
              at: 30,
            },
          }}
        />
      );

      // Lock and draft must survive cache eviction from unrelated cards
      const liveTextbox = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(liveTextbox.disabled).toBe(true);
      expect(liveTextbox.value).toBe('Current explanation response');

      // Now settle the ACK: form cleans up and clears text
      receiveTaskPairDecision(capturedFrames[0].requestId, {
        ok: true,
        decisions: [
          {
            id: 'live-feedback',
            project: 'p',
            taskId: 'task',
            round: 1,
            deliveryRound: 1,
            kind: 'feedback',
            conclusion: 'Human feedback',
            summary: 'Current explanation response',
            author: 'human',
            at: 30,
          },
        ],
      });

      await waitFor(() => expect(liveTextbox.disabled).toBe(false));
      expect(liveTextbox.value).toBe('');
    });
  });
});


describe('stale question recovery', () => {
  it('refreshes a rejected question once, keeps the draft, and only submits the new choice after confirmation', async () => {
    const frames: any[] = [];
    const next = { ...question, id: 'new-question', question: 'Choose the current source?', options: [{ id: 'new', label: 'Use current fixture' }] };
    unbind = bindTaskPairDecisions((frame) => {
      frames.push(frame);
      if (frame.type === TASK_PAIR_DECISION_MSG.HISTORY) {
        receiveTaskPairDecision(frame.requestId, { ok: true, revision: 'revision', decisions: [next], pair: { ...pair, decisionRequest: next } });
      } else if (frame.questionId === next.id) {
        receiveTaskPairDecision(frame.requestId, { ok: true, revision: 'revision', decisions: [{ ...next, kind: 'feedback', id: 'new-feedback' }] });
      } else {
        receiveTaskPairDecision(frame.requestId, { ok: false, code: TASK_PAIR_DECISION_ERROR.CONTEXT_CHANGED, error: 'The decision question changed; refresh before replying' });
      }
    });
    render(<TaskPairDecisionPanel taskId="task" pair={{ ...pair, decisionRequest: undefined }} />);
    fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Keep my typed evidence' } });
    fireEvent.click(screen.getByRole('button', { name: 'taskPair.decision.send' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use current fixture' })).toBeTruthy());
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Keep my typed evidence');
    expect(frames).toHaveLength(2);
    expect(frames.map((f) => f.type)).toEqual([TASK_PAIR_DECISION_MSG.FEEDBACK, TASK_PAIR_DECISION_MSG.HISTORY]);
    expect(screen.getByRole('alert').textContent).toContain('taskPair.decision.context_refreshed');
    fireEvent.click(screen.getByRole('button', { name: 'Use current fixture' }));
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    expect(frames[2]).toMatchObject({ questionId: next.id, optionId: 'new', feedback: 'Keep my typed evidence' });
    expect(frames[2].requestId).not.toBe(frames[0].requestId);
  });

  it('does not reintroduce historical questions when the fresh task has already continued', async () => {
    const ruling = { ...question, kind: 'decision', id: 'ruling', requestId: question.id, at: 100 };
    const frames: any[] = [];
    unbind = bindTaskPairDecisions((frame) => {
      frames.push(frame);
      receiveTaskPairDecision(frame.requestId, frame.type === TASK_PAIR_DECISION_MSG.HISTORY
        ? { ok: true, revision: 'new', decisions: [ruling, question], pair: { ...pair, flags: [], decisionRevision: 'new', decisionRequest: undefined, latestDecision: ruling } }
        : { ok: false, code: TASK_PAIR_DECISION_ERROR.CONTEXT_CHANGED, error: 'Question resolved' });
    });
    render(<TaskPairDecisionPanel taskId="task" pair={pair} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use test data' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Use test data' })).toBeNull());
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText('taskPair.decision.sent')).toBeNull();
    expect(frames).toHaveLength(2);
  });

  it('bounds refresh failure and preserves the original draft and retry identity', async () => {
    const frames: any[] = [];
    unbind = bindTaskPairDecisions((frame) => {
      frames.push(frame);
      receiveTaskPairDecision(frame.requestId, frame.type === TASK_PAIR_DECISION_MSG.HISTORY
        ? { ok: false, error: 'History unavailable' }
        : { ok: false, code: TASK_PAIR_DECISION_ERROR.CONTEXT_CHANGED, error: 'Question changed' });
    });
    render(<TaskPairDecisionPanel taskId="task" pair={pair} />);
    fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Preserved draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use test data' }));
    await waitFor(() => expect(frames).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use test data' }).hasAttribute('disabled')).toBe(false));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Preserved draft');
    expect(screen.getByRole('alert').textContent).toContain('Question changed');
    fireEvent.click(screen.getByRole('button', { name: 'Use test data' }));
    await waitFor(() => expect(frames).toHaveLength(4));
    expect(frames[2].requestId).toBe(frames[0].requestId);
  });
});


describe('stale refresh ownership and version skew', () => {
  it('does not apply a late recovery snapshot across task A to B to A', async () => {
    const frames: any[] = [];
    unbind = bindTaskPairDecisions(frame => {
      frames.push(frame);
      if (frame.type === TASK_PAIR_DECISION_MSG.FEEDBACK) receiveTaskPairDecision(frame.requestId,
        { ok: false, code: TASK_PAIR_DECISION_ERROR.CONTEXT_CHANGED, error: 'Question changed' });
    });
    const view = render(<TaskPairDecisionPanel taskId="task" pair={pair} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use test data' }));
    await waitFor(() => expect(frames).toHaveLength(2));
    view.rerender(<TaskPairDecisionPanel taskId="other" pair={pair} />);
    view.rerender(<TaskPairDecisionPanel taskId="task" pair={pair} />);
    fireEvent.input(screen.getByRole('textbox'), { target: { value: 'New current input' } });
    await act(async () => receiveTaskPairDecision(frames[1].requestId, { ok: true, revision: 'late', decisions: [],
      pair: { ...pair, decisionRevision: 'late', decisionRequest: { ...question, id: 'late-question', question: 'OLD LATE' } } }));
    expect(screen.queryByText(/OLD LATE/)).toBeNull();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('New current input');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps an older-peer failure safe when its history reply has no live snapshot', async () => {
    const frames: any[] = [];
    unbind = bindTaskPairDecisions(frame => {
      frames.push(frame);
      receiveTaskPairDecision(frame.requestId, frame.type === TASK_PAIR_DECISION_MSG.HISTORY
        ? { ok: true, revision: 'old', decisions: [] }
        : { ok: false, code: TASK_PAIR_DECISION_ERROR.CONTEXT_CHANGED, error: 'Question changed' });
    });
    render(<TaskPairDecisionPanel taskId="task" pair={pair} />);
    fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Kept on old daemon' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use test data' }));
    await waitFor(() => expect(frames).toHaveLength(2));
    expect(screen.getByRole('alert').textContent).toContain('Question changed');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Kept on old daemon');
    expect(screen.queryByRole('status')).toBeNull();
  });
});


describe('recovery reconciles with the live console', () => {
  it('preserves the draft when the live projection catches up to the refreshed question', async () => {
    const next = { ...question, id: 'new-current', question: 'New current question?' };
    const fresh = { ...pair, decisionRevision: 'fresh-revision', decisionRequest: next };
    unbind = bindTaskPairDecisions(frame => receiveTaskPairDecision(frame.requestId,
      frame.type === TASK_PAIR_DECISION_MSG.HISTORY
        ? { ok: true, revision: fresh.decisionRevision, pair: fresh, decisions: [next] }
        : { ok: false, code: TASK_PAIR_DECISION_ERROR.CONTEXT_CHANGED, error: 'Question changed' }));
    const view = render(<TaskPairDecisionPanel taskId="task" pair={pair} />);
    fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Keep draft through live catch-up' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use test data' }));
    await waitFor(() => expect(screen.getByTestId('expandable-task-objective-text').textContent).toContain('New current question'));
    view.rerender(<TaskPairDecisionPanel taskId="task" pair={fresh} />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Keep draft through live catch-up');
  });
});
