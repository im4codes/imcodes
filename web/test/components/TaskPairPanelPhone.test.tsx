/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key) }),
}));

import { TaskPairStatusPanel } from '../../src/components/TaskPairStatusPanel.js';
import { resetTaskPairPanelMemoryForTests, sessionMapStorageKey, forgetTaskPairPanelSession } from '../../src/task-pair-panel-state.js';

const originalMatchMedia = window.matchMedia;
const originalInnerWidth = window.innerWidth;

function setLayout(mobile: boolean) {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: mobile, media: '', addEventListener: () => {}, removeEventListener: () => {} }) });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: mobile ? 390 : 1280 });
}

const pairEvent = (taskId: string, toStatus: string, executor: string) =>
  ({ eventId: `${taskId}-${toStatus}`, type: 'task_pair.event', ts: Date.now(), payload: { taskId, title: `Task ${taskId}`, toStatus, executor } }) as never;

const isCollapsed = (container: HTMLElement) => container.querySelector('.task-pair-status-panel')!.classList.contains('is-collapsed');
const expandedState = (container: HTMLElement) => (container.querySelector('.task-pair-status-toggle') as HTMLElement).getAttribute('aria-expanded');

describe('the pair panel of a phone sub-session', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetTaskPairPanelMemoryForTests();
    delete (window as Window & { __imcodesTaskPairSnapshot?: unknown }).__imcodesTaskPairSnapshot;
    setLayout(true);
  });
  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
    vi.restoreAllMocks();
  });

  const live = [pairEvent('t1', 'working', 'deck_sub_a')];
  const historyOnly = [pairEvent('t0', 'done', 'deck_sub_a')];
  const panel = (events: never[], scope = 'deck_sub_a', server = 'srv') => <TaskPairStatusPanel events={events} serverId={server} scopeSessionId={scope} />;

  it('first view: open when the sub-session has a live task (executor or auditor), closed when it only has history', () => {
    expect(isCollapsed(render(panel(live as never[])).container)).toBe(false);
    cleanup();
    const auditing = [{ ...pairEvent('t2', 'in_audit', 'deck_sub_other'), payload: { taskId: 't2', title: 'T2', toStatus: 'in_audit', executor: 'deck_sub_other', auditor: 'deck_sub_a' } }] as never[];
    expect(isCollapsed(render(panel(auditing)).container)).toBe(false);
    cleanup();
    expect(isCollapsed(render(panel(historyOnly as never[])).container)).toBe(true);
    cleanup();
    for (const status of ['queued', 'awaiting_brain_decision', 'rework', 'awaiting_audit']) {
      expect(isCollapsed(render(panel([pairEvent(`s-${status}`, status, 'deck_sub_a')] as never[])).container), status).toBe(false);
      cleanup();
    }
  });

  it('a choice sticks across a remount: closed by the user stays closed with a live task, opened by the user stays open with none', () => {
    const first = render(panel(live as never[]));
    expect(isCollapsed(first.container)).toBe(false);
    fireEvent.click(first.container.querySelector('.task-pair-status-toggle') as HTMLElement);
    expect(isCollapsed(first.container)).toBe(true);
    cleanup();
    expect(isCollapsed(render(panel(live as never[])).container)).toBe(true); // never auto-opened over what the user closed
    cleanup();
    window.localStorage.clear();
    resetTaskPairPanelMemoryForTests();
    const second = render(panel(historyOnly as never[]));
    expect(isCollapsed(second.container)).toBe(true);
    fireEvent.click(second.container.querySelector('.task-pair-status-compact') as HTMLElement);
    expect(isCollapsed(second.container)).toBe(false);
    cleanup();
    expect(isCollapsed(render(panel(historyOnly as never[])).container)).toBe(false); // never auto-closed after the user opened it
  });

  it('is independent per sub-session and from the main chat: the choice made in one does not close or open another', () => {
    const a = render(panel(live as never[], 'deck_sub_a'));
    fireEvent.click(a.container.querySelector('.task-pair-status-toggle') as HTMLElement); // user closes A
    cleanup();
    const liveB = [pairEvent('t9', 'working', 'deck_sub_b')] as never[];
    expect(isCollapsed(render(panel(liveB, 'deck_sub_b')).container)).toBe(false); // B has no choice: live task opens it
    cleanup();
    // the main chat (no scope) keeps its own flag: closing it there does not close a sub-session
    const main = render(<TaskPairStatusPanel events={live as never[]} serverId="srv" />);
    fireEvent.click(main.container.querySelector('.task-pair-status-compact') as HTMLElement); // opens main
    fireEvent.click(main.container.querySelector('.task-pair-status-toggle') as HTMLElement); // closes main again
    cleanup();
    expect(isCollapsed(render(panel(liveB, 'deck_sub_b')).container)).toBe(false);
    cleanup();
    expect(isCollapsed(render(panel(live as never[], 'deck_sub_a')).container)).toBe(true); // A is still the user's choice
  });

  it('switching to another sub-session on the same mounted panel reads that session\'s own choice', () => {
    window.localStorage.setItem(sessionMapStorageKey('srv'), JSON.stringify({ deck_sub_a: { c: 0, t: 1 }, deck_sub_b: { c: 1, t: 2 } }));
    const both = [pairEvent('ta', 'working', 'deck_sub_a'), pairEvent('tb', 'working', 'deck_sub_b')] as never[];
    const view = render(panel(both, 'deck_sub_a'));
    expect(isCollapsed(view.container)).toBe(false);
    view.rerender(panel(both, 'deck_sub_b'));
    expect(isCollapsed(view.container)).toBe(true);
    view.rerender(panel(both, 'deck_sub_a'));
    expect(isCollapsed(view.container)).toBe(false);
  });

  it('a resize (the soft keyboard fires one) never resets what the user chose, with or without working storage', () => {
    for (const blocked of [false, true]) {
      cleanup();
      window.localStorage.clear();
      resetTaskPairPanelMemoryForTests();
      if (blocked) {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
      }
      const view = render(panel(historyOnly as never[]));
      expect(isCollapsed(view.container)).toBe(true);
      fireEvent.click(view.container.querySelector('.task-pair-status-compact') as HTMLElement); // the user opens it
      expect(isCollapsed(view.container)).toBe(false);
      for (let n = 0; n < 3; n += 1) act(() => { window.dispatchEvent(new Event('resize')); });
      expect(isCollapsed(view.container), `blocked storage: ${blocked}`).toBe(false);
      // and remounting in the same tab keeps it, even though storage cannot
      cleanup();
      expect(isCollapsed(render(panel(historyOnly as never[])).container), `blocked storage, remount: ${blocked}`).toBe(false);
      vi.restoreAllMocks();
    }
  });

  it('the toggle says what it does and what state it is in', () => {
    const view = render(panel(live as never[]));
    expect(expandedState(view.container)).toBe('true');
    const toggle = view.container.querySelector('.task-pair-status-toggle') as HTMLElement;
    expect(toggle.getAttribute('aria-label')).toContain('taskPair.panel_collapse');
    fireEvent.click(toggle);
    const compact = view.container.querySelector('.task-pair-status-compact') as HTMLElement;
    expect(compact.getAttribute('aria-expanded')).toBe('false');
    expect(compact.getAttribute('aria-label')).toContain('taskPair.panel_expand');
    fireEvent.keyDown(compact, { key: 'Enter' });
    expect(expandedState(view.container)).toBe('true');
  });

  it('desktop is unchanged: open by default, the one server-wide flag, a session scope does not change it', () => {
    setLayout(false);
    const view = render(panel(historyOnly as never[]));
    expect(isCollapsed(view.container)).toBe(false);
    fireEvent.click(view.container.querySelector('.task-pair-status-toggle') as HTMLElement);
    expect(window.localStorage.getItem('imcodes.task-pair-status-panel.collapsed:srv:desktop')).toBe('1');
    expect(window.localStorage.getItem(sessionMapStorageKey('srv'))).toBeNull();
    cleanup();
    expect(isCollapsed(render(panel(live as never[], 'deck_sub_a')).container)).toBe(true); // the desktop flag, shared as before
  });

  it('closing a sub-session forgets its remembered choice', () => {
    const view = render(panel(live as never[]));
    fireEvent.click(view.container.querySelector('.task-pair-status-toggle') as HTMLElement);
    expect(window.localStorage.getItem(sessionMapStorageKey('srv'))).toContain('deck_sub_a');
    forgetTaskPairPanelSession('srv', 'deck_sub_a');
    expect(window.localStorage.getItem(sessionMapStorageKey('srv'))).toBeNull();
    cleanup();
    expect(isCollapsed(render(panel(live as never[])).container)).toBe(false); // first-view default again
  });
});
