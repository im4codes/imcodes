/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key) }),
}));

import { TaskPairStatusPanel } from '../../src/components/TaskPairStatusPanel.js';
import { LEGACY_SESSION_MAP_KEY_PREFIX, resetTaskPairPanelMemoryForTests } from '../../src/task-pair-panel-state.js';

const originalMatchMedia = window.matchMedia;
const originalInnerWidth = window.innerWidth;
const screenDescriptors = { width: Object.getOwnPropertyDescriptor(window.screen, 'width'), height: Object.getOwnPropertyDescriptor(window.screen, 'height') };

type Device = 'phone' | 'tablet' | 'desktop';
function setDevice(device: Device) {
  const mobile = device !== 'desktop';
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: mobile, media: '', addEventListener: () => {}, removeEventListener: () => {} }) });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: device === 'phone' ? 390 : device === 'tablet' ? 820 : 1280 });
  Object.defineProperty(window.screen, 'width', { configurable: true, value: device === 'phone' ? 390 : device === 'tablet' ? 820 : 2560 });
  Object.defineProperty(window.screen, 'height', { configurable: true, value: device === 'phone' ? 844 : device === 'tablet' ? 1180 : 1440 });
  // the compact panel layout of a real device comes from its user agent (a tablet is wider than the 720 px breakpoint)
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(device === 'phone' ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' : device === 'tablet' ? 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' : 'Mozilla/5.0 (X11; Linux x86_64)');
}

const pairEvent = (taskId: string, toStatus: string, executor: string) =>
  ({ eventId: `${taskId}-${toStatus}`, type: 'task_pair.event', ts: Date.now(), payload: { taskId, title: `Task ${taskId}`, toStatus, executor } }) as never;
const isCollapsed = (container: HTMLElement) => container.querySelector('.task-pair-status-panel')!.classList.contains('is-collapsed');
const openIt = (container: HTMLElement) => fireEvent.click(container.querySelector('.task-pair-status-compact, .task-pair-status-toggle') as HTMLElement);
const storedKeys = () => Object.keys(window.localStorage).filter((key) => key.startsWith('imcodes.task-pair-status-panel'));

describe('the pair panel of a phone sub-session: closed every time it is opened', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetTaskPairPanelMemoryForTests();
    delete (window as Window & { __imcodesTaskPairSnapshot?: unknown }).__imcodesTaskPairSnapshot;
    setDevice('phone');
  });
  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
    for (const key of ['width', 'height'] as const) {
      const descriptor = screenDescriptors[key];
      if (descriptor) Object.defineProperty(window.screen, key, descriptor); else delete (window.screen as unknown as Record<string, unknown>)[key];
    }
    vi.restoreAllMocks();
  });

  const live = [pairEvent('t1', 'working', 'deck_sub_a')] as never[];
  const historyOnly = [pairEvent('t0', 'done', 'deck_sub_a')] as never[];
  const panel = (events: never[], scope = 'deck_sub_a', server = 'srv') => <TaskPairStatusPanel events={events} serverId={server} scopeSessionId={scope} />;

  it('closed on opening, with or without a live task, executor or auditor, whatever the status; the live count is on the collapsed strip', () => {
    const view = render(panel(live));
    expect(isCollapsed(view.container)).toBe(true);
    // the indicator: the strip shows what is going on without opening
    expect(view.container.querySelector('.task-pair-status-icon--working b')?.textContent).toBe('1');
    expect(view.container.querySelector('.task-pair-status-compact')?.getAttribute('aria-expanded')).toBe('false');
    cleanup();
    const auditing = [{ ...pairEvent('t2', 'in_audit', 'deck_sub_other'), payload: { taskId: 't2', title: 'T2', toStatus: 'in_audit', executor: 'deck_sub_other', auditor: 'deck_sub_a' } }] as never[];
    const audit = render(panel(auditing));
    expect(isCollapsed(audit.container)).toBe(true);
    expect(audit.container.querySelector('.task-pair-status-icon--audit b')?.textContent).toBe('1');
    cleanup();
    expect(isCollapsed(render(panel(historyOnly)).container)).toBe(true);
    cleanup();
    for (const status of ['queued', 'awaiting_brain_decision', 'rework', 'awaiting_audit', 'working']) {
      expect(isCollapsed(render(panel([pairEvent(`s-${status}`, status, 'deck_sub_a')] as never[])).container), status).toBe(true);
      cleanup();
    }
  });

  it('tapping opens it, and it stays as the user left it while the view stays open: resizes, re-renders, new events, with or without storage', () => {
    for (const blocked of [false, true]) {
      cleanup();
      window.localStorage.clear();
      resetTaskPairPanelMemoryForTests();
      if (blocked) {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
      }
      const view = render(panel(historyOnly));
      expect(isCollapsed(view.container)).toBe(true);
      openIt(view.container);
      expect(isCollapsed(view.container), `blocked ${blocked}`).toBe(false);
      for (let n = 0; n < 3; n += 1) act(() => { window.dispatchEvent(new Event('resize')); }); // the soft keyboard
      expect(isCollapsed(view.container), `after resize, blocked ${blocked}`).toBe(false);
      view.rerender(panel(historyOnly));
      view.rerender(panel([...historyOnly, pairEvent('t7', 'working', 'deck_sub_a')] as never[]));
      expect(isCollapsed(view.container), `after new events, blocked ${blocked}`).toBe(false);
      // and closing it again by hand also sticks for the view
      openIt(view.container);
      expect(isCollapsed(view.container)).toBe(true);
      act(() => { window.dispatchEvent(new Event('resize')); });
      expect(isCollapsed(view.container)).toBe(true);
      vi.restoreAllMocks();
    }
  });

  it('nothing is stored and nothing is remembered between visits: leaving and coming back closes it, even with storage broken', () => {
    const first = render(panel(live));
    openIt(first.container);
    expect(isCollapsed(first.container)).toBe(false);
    expect(storedKeys()).toEqual([]); // no localStorage at all for a phone sub-session
    cleanup(); // the user leaves the sub-session (its view unmounts) ...
    expect(isCollapsed(render(panel(live)).container)).toBe(true); // ... and re-enters it
    cleanup();
    // reload / reopening the app: a fresh page has no memory either (the in-tab state is gone with the component)
    resetTaskPairPanelMemoryForTests();
    expect(isCollapsed(render(panel(live)).container)).toBe(true);
    cleanup();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    const blocked = render(panel(live));
    openIt(blocked.container);
    cleanup();
    expect(isCollapsed(render(panel(live)).container)).toBe(true);
  });

  it('two sub-sessions are independent within a visit, and switching the same panel to another session closes it again', () => {
    const both = [pairEvent('ta', 'working', 'deck_sub_a'), pairEvent('tb', 'working', 'deck_sub_b')] as never[];
    const a = render(panel(both, 'deck_sub_a'));
    const b = render(panel(both, 'deck_sub_b'));
    const panels = () => [...document.querySelectorAll('.task-pair-status-panel')] as HTMLElement[];
    expect(panels().map((p) => p.classList.contains('is-collapsed'))).toEqual([true, true]);
    openIt(a.container);
    expect(panels().map((p) => p.classList.contains('is-collapsed'))).toEqual([false, true]); // B is not opened by A
    cleanup();
    // one mounted panel moved to another session (its choice belonged to the session it was opened in)
    const view = render(panel(both, 'deck_sub_a'));
    openIt(view.container);
    expect(isCollapsed(view.container)).toBe(false);
    view.rerender(panel(both, 'deck_sub_b'));
    expect(isCollapsed(view.container)).toBe(true);
    view.rerender(panel(both, 'deck_sub_a'));
    expect(isCollapsed(view.container)).toBe(true);
    void b;
  });

  it('removes the per-sub-session keys the previous version stored (once), and leaves the server-wide flags alone', () => {
    window.localStorage.setItem(`${LEGACY_SESSION_MAP_KEY_PREFIX}:srv`, JSON.stringify({ deck_sub_a: { c: 0, t: 1 } }));
    window.localStorage.setItem(`${LEGACY_SESSION_MAP_KEY_PREFIX}:other`, JSON.stringify({ x: { c: 1, t: 1 } }));
    window.localStorage.setItem('imcodes.task-pair-status-panel.collapsed:srv:mobile', '0');
    const view = render(panel(live));
    expect(isCollapsed(view.container)).toBe(true); // the old "opened" entry does not reopen it
    expect(storedKeys()).toEqual(['imcodes.task-pair-status-panel.collapsed:srv:mobile']);
  });

  it('the toggle says what it does and what state it is in, for taps and the keyboard', () => {
    const view = render(panel(live));
    const compact = view.container.querySelector('.task-pair-status-compact') as HTMLElement;
    expect(compact.getAttribute('role')).toBe('button');
    expect(compact.getAttribute('aria-expanded')).toBe('false');
    expect(compact.getAttribute('aria-label')).toContain('taskPair.panel_expand');
    fireEvent.keyDown(compact, { key: 'Enter' });
    const toggle = view.container.querySelector('.task-pair-status-toggle') as HTMLElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toContain('taskPair.panel_collapse');
  });
});

describe('everything that is not a phone sub-session is unchanged', () => {
  beforeEach(() => { window.localStorage.clear(); resetTaskPairPanelMemoryForTests(); delete (window as Window & { __imcodesTaskPairSnapshot?: unknown }).__imcodesTaskPairSnapshot; });
  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
    for (const key of ['width', 'height'] as const) {
      const descriptor = screenDescriptors[key];
      if (descriptor) Object.defineProperty(window.screen, key, descriptor); else delete (window.screen as unknown as Record<string, unknown>)[key];
    }
    vi.restoreAllMocks();
  });
  const live = [pairEvent('t1', 'working', 'deck_sub_a')] as never[];

  it('desktop: open by default, the one server-wide desktop flag, a session scope changes nothing', () => {
    setDevice('desktop');
    const view = render(<TaskPairStatusPanel events={live} serverId="srv" scopeSessionId="deck_sub_a" />);
    expect(isCollapsed(view.container)).toBe(false);
    openIt(view.container);
    expect(isCollapsed(view.container)).toBe(true);
    expect(window.localStorage.getItem('imcodes.task-pair-status-panel.collapsed:srv:desktop')).toBe('1');
    cleanup();
    expect(isCollapsed(render(<TaskPairStatusPanel events={live} serverId="srv" scopeSessionId="deck_sub_a" />).container)).toBe(true); // remembered as before
  });

  it('a tablet in the compact layout keeps the stored server-wide flag for sub-sessions too (it is not a phone)', () => {
    setDevice('tablet');
    const view = render(<TaskPairStatusPanel events={live} serverId="srv" scopeSessionId="deck_sub_a" />);
    expect(isCollapsed(view.container)).toBe(true); // compact-layout default, as before
    openIt(view.container);
    expect(isCollapsed(view.container)).toBe(false);
    expect(window.localStorage.getItem('imcodes.task-pair-status-panel.collapsed:srv:mobile')).toBe('0');
    cleanup();
    expect(isCollapsed(render(<TaskPairStatusPanel events={live} serverId="srv" scopeSessionId="deck_sub_a" />).container)).toBe(false); // persisted, as before
  });

  it('the phone main chat (no sub-session scope) keeps its stored server-wide flag', () => {
    setDevice('phone');
    const view = render(<TaskPairStatusPanel events={live} serverId="srv" />);
    expect(isCollapsed(view.container)).toBe(true);
    openIt(view.container);
    expect(window.localStorage.getItem('imcodes.task-pair-status-panel.collapsed:srv:mobile')).toBe('0');
    cleanup();
    expect(isCollapsed(render(<TaskPairStatusPanel events={live} serverId="srv" />).container)).toBe(false);
  });
});
