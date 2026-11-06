/** @vitest-environment jsdom */
import { act, cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidebarPinnedPanel } from '../../src/components/SidebarPinnedPanel.js';
import { SubSessionTaskTitle, currentSubSessionTask } from '../../src/components/SubSessionTaskTitle.js';
vi.mock('../../src/components/PinnedPanelRegistry.js', () => ({ getPanelTitle: () => 'Pinned worker', renderPanelContent: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const row = (id: string, executor = 'deck_sub_header', status = 'working', updatedAt = 1) => ({ taskId: id, title: `Task ${id}`, updatedAt, pair: { status, executor, auditor: 'deck_sub_auditor', updatedAt } });
const snapshot = (tasks = [row('one')]) => ({ authoritative: true, serverId: 'server-one', tasks });
const resolve = (value: unknown, session = 'deck_sub_header', server = 'server-one') => currentSubSessionTask(value as never, session, server);
afterEach(() => { cleanup(); delete (window as Window & { __imcodesTaskPairSnapshot?: unknown }).__imcodesTaskPairSnapshot; });
describe('canonical current sub-session task title', () => {
  it('includes executors and auditors, not other agents or servers with the same display label', () => {
    expect(resolve(snapshot())?.title).toBe('Task one');
    expect(resolve(snapshot(), 'deck_sub_auditor')?.status).toBe('working');
    expect(resolve(snapshot(), 'other')).toBeUndefined();
    expect(resolve(snapshot(), 'deck_sub_header', 'server-two')).toBeUndefined();
    expect(resolve({ ...snapshot(), serverId: undefined })).toBeUndefined();
  });
  it('selects the latest open task, not completed history or an old passed task', () => {
    const s = snapshot([row('old', 'deck_sub_header', 'passed', 90), row('current', 'deck_sub_header', 'rework', 10), row('history', 'deck_sub_header', 'done', 100)]);
    expect(resolve(s)?.title).toBe('Task current');
    expect(resolve(snapshot([row('finished', 'deck_sub_header', 'cancelled')]))).toBeUndefined();
    expect(resolve(snapshot([row('reviewed', 'deck_sub_header', 'passed')]))?.status).toBe('passed');
  });
  it('reuses scheduling status and assignment ownership from the authoritative projection', () => {
    const s = snapshot();
    (s.tasks[0].pair as any).scheduling = { epoch: 1, manual: true, dependsOn: [], since: 1, writer: 'brain' };
    // Use the real wire pause shape rather than a second status implementation.
    const legacy = { ...s, tasks: [{ ...s.tasks[0], pair: { ...s.tasks[0].pair, executor: undefined, auditor: undefined } }], assignments: [{ taskId: 'one', ownerSessionName: 'legacy-agent' }] };
    expect(resolve(legacy, 'legacy-agent')?.title).toBe('Task one');
    expect(resolve({ ...s, assignments: legacy.assignments }, 'legacy-agent')).toBeUndefined();
    expect(resolve(s)?.status).toBe('paused');
  });
  it.each([{ authoritative: false }, { scopeReset: true }, { authorityUnavailable: true }])('does not render stale or unauthoritative data: %j', (flags) => {
    expect(resolve({ ...snapshot(), ...flags })).toBeUndefined();
  });
  it('does not expose an unusable internal task id as a title', () => {
    const s = snapshot(); s.tasks[0].title = s.tasks[0].taskId;
    expect(resolve(s)).toBeUndefined();
  });
  it('updates title/status live, clears at scope reset and preserves a plain session label when no task exists', () => {
    (window as any).__imcodesTaskPairSnapshot = snapshot();
    const view = render(<SubSessionTaskTitle sessionName="deck_sub_header" serverId="server-one" fallback="Agent A" />);
    expect(view.container.textContent).toBe('Task onetaskPair.status.working');
    act(() => { window.dispatchEvent(new CustomEvent('supervision:task-pairs', { detail: snapshot([row('renamed', 'deck_sub_header', 'in_audit', 2)]) })); });
    expect(view.container.textContent).toBe('Task renamedtaskPair.status.in_audit');
    act(() => { window.dispatchEvent(new CustomEvent('supervision:task-pairs', { detail: { scopeReset: true } })); });
    expect(view.container.textContent).toBe('Agent A');
    act(() => { window.dispatchEvent(new CustomEvent('supervision:task-pairs', { detail: snapshot([]) })); });
    expect(view.container.querySelector('.subsession-task-state')).toBeNull();
    view.rerender(<SubSessionTaskTitle sessionName="deck_sub_other" serverId="server-two" fallback="Agent B" />);
    expect(view.container.textContent).toBe('Agent B');
  });
  it('also displays the current task in the pinned sub-session header without changing other panel types', () => {
    (window as any).__imcodesTaskPairSnapshot = snapshot();
    const props = { panel: { id: 'pin-one', type: 'subsession', props: { sessionName: 'deck_sub_header' } }, height: 300, onUnpin: vi.fn(), onResize: vi.fn(), ctx: { serverId: 'server-one' } as any };
    const view = render(<SidebarPinnedPanel {...props} />);
    expect(view.container.querySelector('.sidebar-pinned-title')?.textContent).toBe('Task onetaskPair.status.working');
    view.rerender(<SidebarPinnedPanel {...props} panel={{ ...props.panel, type: 'filebrowser' }} />);
    expect(view.container.querySelector('.sidebar-pinned-title')?.textContent).toBe('Pinned worker');
  });

});
