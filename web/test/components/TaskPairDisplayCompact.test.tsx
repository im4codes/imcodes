import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TaskPairDecisionPanel } from '../../src/components/TaskPairDecisionPanel.js';
import { TaskPairBrief } from '../../src/components/TaskPairBrief.js';
import { bindTaskPairDecisions, receiveTaskPairDecision } from '../../src/task-pair-decisions.js';
import { resetTaskPairBriefStoreForTests, setTaskPairBriefRequester, receiveTaskPairBrief } from '../../src/task-pair-brief-store.js';
import type { SupervisionConsolePairInfo } from '@shared/supervision-task-console.js';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../src/components/ChatMarkdown.js', () => ({ ChatMarkdown: ({ text }: { text: string }) => <div>{text}</div> }));
let unbind: (() => void) | undefined;
const ruling = { id: 'ruling', project: 'p', taskId: 'task', round: 1, kind: 'decision' as const, conclusion: 'Approved', summary: 'Use isolated fixtures', author: 'brain', at: 100 };
const pair: SupervisionConsolePairInfo = { status: 'working', round: 1, flags: [], blocking: [], decisionRevision: 'revision' };
beforeEach(() => resetTaskPairBriefStoreForTests());
afterEach(() => { cleanup(); unbind?.(); unbind = undefined; resetTaskPairBriefStoreForTests(); vi.restoreAllMocks(); });
it('shows a real historical ruling without inventing an unknown blocker', () => {
  const { container } = render(<TaskPairDecisionPanel taskId="task" pair={{ ...pair, latestDecision: ruling }} />);
  expect(container.textContent).not.toContain('taskPair.decision.missing');
  expect(container.querySelector('.task-pair-decision-copy')?.textContent).toContain('Approved — Use isolated fixtures');
  expect(container.querySelector('time')?.dateTime).toBe(new Date(100).toISOString());
});
it.each([false, true])('does not create an empty copy or empty read-only decoration (readOnly=%s)', readOnly => {
  const request = vi.fn(); unbind = bindTaskPairDecisions(request);
  const { container } = render(<TaskPairDecisionPanel readOnly={readOnly} taskId="task" pair={{ ...pair, flags: ['blocked'], blockedNote: '  \n ' }} />);
  expect(container.querySelector('.task-pair-decision-copy')).toBeNull();
  expect(container.textContent).not.toContain('taskPair.decision.missing');
  if (readOnly) expect(container.querySelector('.task-pair-decision')).toBeNull();
  else { expect(container.querySelector('textarea')).not.toBeNull(); expect(container.textContent).toContain('taskPair.decision.ready'); }
  expect(request).not.toHaveBeenCalled();
});
it('keeps ruling metadata and real history but omits blank recommendation/ruling paragraphs', async () => {
  const blank = { ...ruling, conclusion: ' \n ', summary: '  ' };
  unbind = bindTaskPairDecisions(frame => receiveTaskPairDecision(frame.requestId, { ok: true, decisions: [blank, { ...ruling, id: 'feedback', kind: 'feedback', summary: 'Actual feedback', conclusion: '' }] }));
  const { container } = render(<TaskPairDecisionPanel taskId="task" readOnly pair={{ ...pair, latestDecision: blank }} />);
  expect(container.querySelector('.task-pair-decision-copy')).toBeNull();
  expect(container.querySelector('time')).not.toBeNull();
  const details = container.querySelector('details')!; details.open = true; fireEvent(details, new Event('toggle'));
  await waitFor(() => expect(container.querySelectorAll('.task-pair-decision-records li')).toHaveLength(2));
  expect(container.querySelectorAll('.task-pair-decision-records li')[0].querySelector('p')).toBeNull();
  expect(container.textContent).toContain('Actual feedback');
});
it('does not let a historical ruling swallow a new note-only blocker', () => {
  const { container } = render(<TaskPairDecisionPanel taskId="task" pair={{ ...pair, latestDecision: ruling, blockedNote: 'Current error: source denied', flags: ['blocked'] }} />);
  expect(container.querySelector('.task-pair-decision-copy')?.textContent).toContain('Current error: source denied');
  expect(container.querySelector('.task-pair-decision-copy')?.textContent).not.toContain('Approved');
});
it.each([0, 5, 101])('shows compact true counts and descriptive accessible labels for %s items', total => {
  const brief = total ? Array.from({ length: total }, (_, i) => `- [${i === 0 ? 'x' : ' '}][ ] Item ${i}`).join('\n') : 'Actual task explanation';
  const { container } = render(<TaskPairBrief taskId="task" brief={brief} />);
  const button = container.querySelector<HTMLButtonElement>('.task-pair-brief-checklist-toggle')!;
  const implemented = total ? 1 : 0;
  expect(button.textContent).toBe(`${implemented}/${total} : 0/${total}`);
  expect(button.getAttribute('aria-label')).toBe(`taskPair.checklist_toggle: taskPair.implemented ${implemented}/${total}, taskPair.audited 0/${total}`);
  expect(button.title).toBe(button.getAttribute('aria-label'));
  fireEvent.click(button);
  expect(container.querySelectorAll('.task-pair-brief-checklist-row')).toHaveLength(total);
});
it('does not invent zero counts before lazy metadata arrives and does not fetch on stream redraw', async () => {
  const request = vi.fn(); setTaskPairBriefRequester(request);
  const view = render(<TaskPairBrief taskId="task" briefRevision="rev" />);
  const button = view.container.querySelector<HTMLButtonElement>('.task-pair-brief-checklist-toggle')!;
  expect(button.textContent).toBe('— : —');
  view.rerender(<TaskPairBrief taskId="task" briefRevision="rev" />);
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(button); expect(request).toHaveBeenCalledTimes(1);
  receiveTaskPairBrief('task', 'rev', '- [x][x] Actual item');
  await waitFor(() => expect(button.textContent).toBe('1/1 : 1/1'));
});
it('keeps an icon-only copy beside the unchanged explanation action and copies the complete inline brief', async () => {
  const text = 'Task explanation\n- [x][ ] Entire checklist';
  const writeText = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const { container } = render(<TaskPairBrief taskId="task" brief={text} />);
  const button = container.querySelector<HTMLButtonElement>('.task-pair-brief-copy')!;
  expect(button.previousElementSibling?.textContent).toBe('taskPair.brief_expand');
  expect(button.textContent).toBe(''); expect(button.title).toBe('taskPair.brief_copy');
  expect(button.getAttribute('aria-label')).toBe('taskPair.brief_copy'); expect(button.querySelector('svg')).not.toBeNull();
  fireEvent.click(button); await waitFor(() => expect(writeText).toHaveBeenCalledWith(text));
  await waitFor(() => expect(button.getAttribute('aria-label')).toBe('taskPair.brief_copied'));
  expect(button.textContent).toBe(''); expect(button.title).toBe('taskPair.brief_copied');
});
it('keeps the clipboard fallback complete and leaves no temporary textarea', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  const command = vi.fn().mockReturnValue(true); Object.defineProperty(document, 'execCommand', { configurable: true, value: command });
  const { container } = render(<TaskPairBrief taskId="task" brief="Actual explanation\n- [ ][ ] Item" />);
  fireEvent.click(container.querySelector('.task-pair-brief-copy')!);
  await waitFor(() => expect(command).toHaveBeenCalledWith('copy'));
  expect(document.querySelector('textarea')).toBeNull();
});

it('treats a whitespace question as absent text but preserves its actual summary and recommendation', () => {
  const { container } = render(<TaskPairDecisionPanel taskId="task" pair={{ ...pair, decisionRequest: { ...ruling, kind: 'request', question: '  ', summary: 'Real summary', recommendation: '  ' } }} />);
  expect(container.querySelector('.task-pair-decision-copy')?.textContent).toContain('Real summary');
  expect(container.textContent).not.toContain('taskPair.decision.recommendation:');
});
it('keeps a concrete waiting reason rather than inventing a fallback', () => {
  const { container } = render(<TaskPairDecisionPanel taskId="task" pair={{ ...pair, flags: ['needs_input'], waitingReason: 'Actual service denied the operation' }} />);
  expect(container.querySelector('.task-pair-decision-copy')?.textContent).toBe('Actual service denied the operation');
});
it('does not treat whitespace notes as a new blocker hiding a real ruling', () => {
  const { container } = render(<TaskPairDecisionPanel taskId="task" pair={{ ...pair, blockedNote: '  ', latestDecision: ruling }} />);
  expect(container.querySelector('.task-pair-decision-copy')?.textContent).toContain('Approved — Use isolated fixtures');
});
it('keeps copy failure retryable without showing a false success', async () => {
  const writeText = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const { container } = render(<TaskPairBrief taskId="task" brief="Actual content" />);
  const button = container.querySelector<HTMLButtonElement>('.task-pair-brief-copy')!;
  fireEvent.click(button); await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  expect(button.getAttribute('aria-label')).toBe('taskPair.brief_copy');
  fireEvent.click(button); await waitFor(() => expect(button.getAttribute('aria-label')).toBe('taskPair.brief_copied'));
});
it.each([{ flags: [] }, { flags: ['blocked'] }])('keeps a real history error visible after its explanatory note is cleared (%j)', async ({ flags }) => {
  unbind = bindTaskPairDecisions(frame => receiveTaskPairDecision(frame.requestId, { ok: false, error: 'Actual history transport failure' }));
  const view = render(<TaskPairDecisionPanel taskId="task" readOnly pair={{ ...pair, flags: ['blocked'], blockedNote: 'Actual previous issue' }} />);
  const details = view.container.querySelector('details')!; details.open = true; fireEvent(details, new Event('toggle'));
  await waitFor(() => expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Actual history transport failure'));
  view.rerender(<TaskPairDecisionPanel taskId="task" readOnly pair={{ ...pair, flags, blockedNote: ' ' }} />);
  expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Actual history transport failure');
  expect(view.container.querySelector('.task-pair-decision-copy')).toBeNull();
});
it('keeps real feedback acknowledgement when the reason clears before the next history record', async () => {
  unbind = bindTaskPairDecisions(frame => receiveTaskPairDecision(frame.requestId, { ok: true, decisions: [] }));
  const view = render(<TaskPairDecisionPanel taskId="task" pair={{ ...pair, flags: ['blocked'] }} />);
  fireEvent.input(view.container.querySelector('textarea')!, { target: { value: 'Actual feedback' } });
  const send = [...view.container.querySelectorAll('button')].find(button => button.textContent === 'taskPair.decision.send')!;
  fireEvent.click(send); await waitFor(() => expect(view.container.querySelector('[role="status"]')).not.toBeNull());
  view.rerender(<TaskPairDecisionPanel taskId="task" pair={pair} />);
  expect(view.container.querySelector('[role="status"]')?.textContent).toBe('taskPair.decision.sent');
});
it.each([
  { checklist: undefined }, { checklist: null }, { checklist: {} },
  { checklist: { total: 5, implemented: 1 } },
  { checklist: { total: 5, implemented: NaN, audited: 0 } },
  { checklist: { total: 5, implemented: 6, audited: 0 } },
])('does not fabricate progress from missing or incomplete legacy metadata (%j)', ({ checklist }) => {
  const request = vi.fn(); setTaskPairBriefRequester(request);
  const { container } = render(<TaskPairBrief taskId="task" briefRevision="pending" checklist={checklist as never} />);
  const button = container.querySelector<HTMLButtonElement>('.task-pair-brief-checklist-toggle')!;
  expect(button.textContent).toBe('— : —');
  expect(button.getAttribute('aria-label')).toBe('taskPair.checklist_toggle');
  expect(request).not.toHaveBeenCalled();
});
