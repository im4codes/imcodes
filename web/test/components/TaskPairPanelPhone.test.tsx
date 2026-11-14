/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key) }),
}));

import { TaskPairStatusPanel, TaskPairStatusPanelHost } from '../../src/components/TaskPairStatusPanel.js';
import { TaskPairEventChip } from '../../src/components/TaskPairEventChip.js';
import { NATIVE_HOST_EVENT } from '../../src/native-platform.js';
import { TASK_PAIR_PANEL_MAX_HEIGHT_VAR } from '../../src/task-pair-panel-fit.js';
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
  it.each(['timeline', 'snapshot'])('split visits isolate canonical session tasks from %s while keeping right/third/main behavior', (source) => {
    setDevice('desktop');
    window.localStorage.setItem('imcodes.task-pair-status-panel.collapsed:srv:desktop', '0');
    const rows = [
      { taskId: 'left', title: 'Left task', toStatus: 'working', executor: 'deck_sub_a', auditor: 'deck_sub_b' },
      { taskId: 'third', title: 'Third task', toStatus: 'working', executor: 'deck_sub_c', auditor: 'deck_sub_b' },
      { taskId: 'unrelated', title: 'Unrelated task', toStatus: 'working', executor: 'other', auditor: 'another' },
    ];
    const events = source === 'timeline' ? rows.map((payload) => ({ eventId: payload.taskId, type: 'task_pair.event', ts: 1000, payload })) as never[] : [];
    if (source === 'snapshot') (window as any).__imcodesTaskPairSnapshot = { tasks: rows.map((row) => ({ taskId: row.taskId, title: row.title, pair: { ...row, status: row.toStatus } })) };
    const sessions = ['deck_sub_a', 'deck_sub_b', 'deck_sub_c'].map((name) => ({ name, label: 'Same label' }));
    const view = render(<div>
      <div data-window="left"><TaskPairStatusPanel events={events} sessions={sessions} serverId="srv" scopeSessionId="deck_sub_a" collapsedVisitKey="split-A" /></div>
      <div data-window="right"><TaskPairStatusPanel events={events} sessions={sessions} serverId="srv" scopeSessionId="deck_sub_b" /></div>
      <div data-window="third"><TaskPairStatusPanel events={events} sessions={sessions} serverId="srv" scopeSessionId="deck_sub_c" /></div>
      <div data-window="main"><TaskPairStatusPanel events={events} sessions={sessions} serverId="srv" /></div>
    </div>);
    const pane = (name: string) => view.container.querySelector(`[data-window="${name}"]`) as HTMLElement;
    const titles = (name: string) => [...pane(name).querySelectorAll('.task-pair-status-row-title')].map((el) => el.textContent);
    expect(isCollapsed(pane('left'))).toBe(true);
    expect(pane('left').querySelector('.task-pair-status-icon--working b')?.textContent).toBe('1');
    openIt(pane('left'));
    expect(titles('left')).toEqual(['Left task']);
    expect(titles('right')).toEqual(['Left task', 'Third task']);
    expect(titles('third')).toEqual(['Third task']);
    expect(titles('main')).toEqual(['Left task', 'Third task', 'Unrelated task']);
    openIt(pane('left'));
    expect(window.localStorage.getItem('imcodes.task-pair-status-panel.collapsed:srv:desktop')).toBe('0');
    expect(isCollapsed(pane('main'))).toBe(false);
  });

  it('keeps a split visit choice across desktop/phone resizes but resets on task/server/session/exit/re-entry', () => {
    setDevice('desktop');
    window.localStorage.setItem('imcodes.task-pair-status-panel.collapsed:srv:desktop', '0');
    window.localStorage.setItem('imcodes.task-pair-status-panel.collapsed:srv:mobile', '0');
    const both = [pairEvent('ta', 'working', 'deck_sub_a'), pairEvent('tb', 'working', 'deck_sub_b')] as never[];
    const panel = (key: string | undefined, serverId = 'srv', scopeSessionId = 'deck_sub_a') => <TaskPairStatusPanel events={both} serverId={serverId} scopeSessionId={scopeSessionId} collapsedVisitKey={key} />;
    const view = render(panel('A'));
    openIt(view.container); expect(isCollapsed(view.container)).toBe(false);
    setDevice('phone'); act(() => window.dispatchEvent(new Event('resize')));
    expect(isCollapsed(view.container)).toBe(false);
    setDevice('desktop'); act(() => window.dispatchEvent(new Event('resize')));
    expect(isCollapsed(view.container)).toBe(false);
    view.rerender(panel('B')); expect(isCollapsed(view.container)).toBe(true);
    openIt(view.container);
    view.rerender(panel('A')); expect(isCollapsed(view.container)).toBe(true);
    openIt(view.container);
    view.rerender(panel(undefined)); expect(isCollapsed(view.container)).toBe(false); // exit restores server default
    view.rerender(panel('A')); expect(isCollapsed(view.container)).toBe(true);
    openIt(view.container);
    view.rerender(panel('A', 'new-server')); expect(isCollapsed(view.container)).toBe(true);
    openIt(view.container);
    view.rerender(panel('A', 'new-server', 'deck_sub_b')); expect(isCollapsed(view.container)).toBe(true);
    openIt(view.container);
    expect(view.container.querySelector('.task-pair-status-row-title')?.textContent).toBe('Task tb');
    expect(window.localStorage.getItem('imcodes.task-pair-status-panel.collapsed:srv:desktop')).toBe('0');
    expect(window.localStorage.getItem('imcodes.task-pair-status-panel.collapsed:new-server:desktop')).toBeNull();
  });

  it('binds --task-pair-panel-max-h even when rows populate after initial empty mount and after portal anchor attachment', () => {
    setDevice('phone');
    const host = document.createElement('div');
    host.className = 'chat-main';
    const titlebar = document.createElement('div');
    titlebar.className = 'chat-titlebar';
    host.appendChild(titlebar);
    document.body.appendChild(host);
    host.getBoundingClientRect = () => ({ top: 140, bottom: 637, left: 0, right: 440, width: 440, height: 497, x: 0, y: 140, toJSON: () => ({}) } as DOMRect);
    titlebar.getBoundingClientRect = () => ({ top: 140, bottom: 193, left: 0, right: 440, width: 440, height: 53, x: 0, y: 140, toJSON: () => ({}) } as DOMRect);

    const anchorRef: { current: Element | null } = { current: null };
    const mountTarget = document.createElement('div');
    host.appendChild(mountTarget);

    // Mount with activity for another session so active=true in Host while scoped allRows is initially empty.
    const view = render(
      <TaskPairStatusPanelHost
        events={[pairEvent('other', 'working', 'deck_sub_other')]}
        serverId="srv"
        scopeSessionId="deck_sub_a"
        mobileAnchorRef={anchorRef}
      />,
      { container: mountTarget },
    );
    expect(host.querySelector('[data-testid="task-pair-status-panel"]')).toBeNull();

    // Now anchor attaches and scoped rows arrive later (snapshot / event update).
    anchorRef.current = titlebar;
    view.rerender(
      <TaskPairStatusPanelHost
        events={[pairEvent('other', 'working', 'deck_sub_other'), pairEvent('t1', 'working', 'deck_sub_a')]}
        serverId="srv"
        scopeSessionId="deck_sub_a"
        mobileAnchorRef={anchorRef}
      />,
    );
    const panel = titlebar.querySelector('[data-testid="task-pair-status-panel"]') as HTMLElement | null;
    expect(panel).toBeTruthy();
    // 637 - (193 + 4) - 8 = 432px
    expect(panel!.style.getPropertyValue(TASK_PAIR_PANEL_MAX_HEIGHT_VAR)).toBe('432px');
    host.remove();
  });

  it('detaches the expanded scroll container, resets scrollTop/scrollLeft on collapse, and restores cleanly on re-expand', () => {
    setDevice('phone');
    const host = document.createElement('div');
    host.className = 'chat-main';
    const titlebar = document.createElement('div');
    titlebar.className = 'chat-titlebar';
    host.appendChild(titlebar);
    document.body.appendChild(host);
    host.getBoundingClientRect = () => ({ top: 140, bottom: 637, left: 0, right: 440, width: 440, height: 497, x: 0, y: 140, toJSON: () => ({}) } as DOMRect);
    titlebar.getBoundingClientRect = () => ({ top: 140, bottom: 193, left: 0, right: 440, width: 440, height: 53, x: 0, y: 140, toJSON: () => ({}) } as DOMRect);

    const anchorRef = { current: titlebar };
    const mountTarget = document.createElement('div');
    host.appendChild(mountTarget);

    render(
      <TaskPairStatusPanelHost
        events={[
          pairEvent('t1', 'working', 'deck_sub_a'),
          pairEvent('t2', 'in_audit', 'deck_sub_a'),
          pairEvent('t3', 'queued', 'deck_sub_a'),
        ]}
        serverId="srv"
        scopeSessionId="deck_sub_a"
        mobileAnchorRef={anchorRef}
      />,
      { container: mountTarget },
    );

    // Expand
    const compactBefore = titlebar.querySelector('.task-pair-status-compact') as HTMLElement;
    expect(compactBefore).toBeTruthy();
    fireEvent.click(compactBefore);

    const panel = titlebar.querySelector('[data-testid="task-pair-status-panel"]') as HTMLElement;
    const expandedToggle = titlebar.querySelector('button.task-pair-status-toggle') as HTMLElement;
    const rows = titlebar.querySelector('[data-testid="task-pair-status-rows"]') as HTMLElement;
    expect(panel.classList.contains('is-collapsed')).toBe(false);
    expect(rows.parentElement?.classList.contains('task-pair-status-body')).toBe(true);

    // Scroll the expanded rows list and simulate accidental scroll offset on panel/toggle/titlebar
    rows.scrollTop = 180;
    panel.scrollTop = 16;
    panel.scrollLeft = 12;
    fireEvent.scroll(panel);
    expect(panel.scrollTop).toBe(0);
    expect(panel.scrollLeft).toBe(0);

    // Re-inject non-zero scroll offsets directly before collapsing to verify collapse cleanup resets them
    panel.scrollTop = 14;
    panel.scrollLeft = 10;
    expandedToggle.scrollTop = 8;
    expandedToggle.scrollLeft = 9;
    titlebar.scrollTop = 6;
    titlebar.scrollLeft = 5;

    // Collapse
    fireEvent.click(expandedToggle);
    expect(panel.classList.contains('is-collapsed')).toBe(true);
    expect(titlebar.querySelector('[data-testid="task-pair-status-rows"]')).toBeNull();
    expect(titlebar.querySelector('.task-pair-status-body')).toBeNull();

    const compactAfter = titlebar.querySelector('.task-pair-status-compact') as HTMLElement;
    expect(compactAfter).toBeTruthy();
    expect(compactAfter).not.toBe(expandedToggle);
    expect(panel.scrollTop).toBe(0);
    expect(panel.scrollLeft).toBe(0);
    expect(compactAfter.scrollTop).toBe(0);
    expect(compactAfter.scrollLeft).toBe(0);
    expect(titlebar.scrollTop).toBe(0);
    expect(titlebar.scrollLeft).toBe(0);

    // Re-expand and verify state fidelity & fit bound
    fireEvent.click(compactAfter);
    expect(panel.classList.contains('is-collapsed')).toBe(false);
    const rowsReopened = titlebar.querySelector('[data-testid="task-pair-status-rows"]') as HTMLElement;
    expect(rowsReopened).toBeTruthy();
    expect(rowsReopened.scrollTop).toBe(0);
    expect(panel.scrollTop).toBe(0);
    expect(panel.scrollLeft).toBe(0);
    expect(panel.style.getPropertyValue(TASK_PAIR_PANEL_MAX_HEIGHT_VAR)).toBe('432px');
    expect(rowsReopened.querySelectorAll('.task-pair-status-row')).toHaveLength(3);
    host.remove();
  });

  it('updates mounted TaskPairStatusPanel and TaskPairEventChip on late native-host without resize or matchMedia', async () => {
    window.localStorage.setItem('imcodes.task-pair-status-panel.collapsed:srv:desktop', '0');
    window.localStorage.setItem('imcodes.task-pair-status-panel.collapsed:srv:mobile', '1');
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'ios' });
    vi.stubGlobal('__IMCODES_NATIVE_HOST__', undefined);
    // MatchMedia unavailable, iPad UA, 0 touch points -> native iOS starts mobile before nativeHost arrives
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    Object.defineProperty(window.screen, 'width', { configurable: true, value: 1600 });
    Object.defineProperty(window.screen, 'height', { configurable: true, value: 1000 });
    vi.stubGlobal('navigator', {
      platform: 'iPad',
      userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)',
      maxTouchPoints: 0,
    });

    const chipPayload = {
      taskId: 't1',
      title: 'Late host task',
      verb: 'WORKING',
      toStatus: 'working',
      executor: 'deck_sub_a',
      auditor: 'deck_sub_b',
    };

    try {
      const panelView = render(<TaskPairStatusPanel events={live} serverId="srv" scopeSessionId="deck_sub_a" />);
      const chipView = render(<TaskPairEventChip eventId="ev-late" payload={chipPayload} />);
      expect(isCollapsed(panelView.container)).toBe(true);
      expect(chipView.container.querySelector('.task-pair-split-btn')).toBeNull();

      // Late imcodes:native-host without any resize event
      vi.stubGlobal('__IMCODES_NATIVE_HOST__', { isMacDesktop: true, pageZoomApplied: false, scaleMode: 'native-1x' });
      await act(() => {
        window.dispatchEvent(new CustomEvent(NATIVE_HOST_EVENT));
      });
      expect(isCollapsed(panelView.container)).toBe(false);
      expect(chipView.container.querySelector('.task-pair-split-btn')).not.toBeNull();

      // Negative control: narrow desktop width <= 720 compacts panel and hides split button
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 640 });
      await act(() => {
        window.dispatchEvent(new Event('resize'));
      });
      expect(isCollapsed(panelView.container)).toBe(true);
      expect(chipView.container.querySelector('.task-pair-split-btn')).toBeNull();

      // Restore wide viewport, then verify real iPhone stays compact
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
      vi.stubGlobal('__IMCODES_NATIVE_HOST__', { isMacDesktop: false, pageZoomApplied: false, scaleMode: 'none' });
      vi.stubGlobal('navigator', {
        platform: 'iPhone',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        maxTouchPoints: 5,
      });
      await act(() => {
        window.dispatchEvent(new CustomEvent(NATIVE_HOST_EVENT));
      });
      expect(isCollapsed(panelView.container)).toBe(true);
      expect(chipView.container.querySelector('.task-pair-split-btn')).toBeNull();

      panelView.unmount();
      chipView.unmount();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('expands main chat task panel to fullscreen on mobile without cramped collapse, auto-collapses on deck:navigate and collapse toggle', () => {
    setDevice('phone');
    const host = document.createElement('div');
    host.className = 'chat-main';
    const titlebar = document.createElement('div');
    titlebar.className = 'chat-titlebar';
    host.appendChild(titlebar);
    document.body.appendChild(host);
    // Cramped inline chat height (< TASK_PAIR_PANEL_MIN_USABLE_PX) simulating open keyboard
    host.getBoundingClientRect = () => ({ top: 140, bottom: 210, left: 0, right: 390, width: 390, height: 70, x: 0, y: 140, toJSON: () => ({}) } as DOMRect);
    titlebar.getBoundingClientRect = () => ({ top: 140, bottom: 180, left: 0, right: 390, width: 390, height: 40, x: 0, y: 140, toJSON: () => ({}) } as DOMRect);
    const anchorRef = { current: titlebar };
    const mountTarget = document.createElement('div');
    host.appendChild(mountTarget);

    const navigateEvents: string[] = [];
    const onNavigate = (e: Event) => navigateEvents.push((e as CustomEvent<{ session: string }>).detail.session);
    window.addEventListener('deck:navigate', onNavigate);
    try {
      render(
        <TaskPairStatusPanelHost
          events={live}
          serverId="srv"
          mobileAnchorRef={anchorRef}
        />,
        { container: mountTarget },
      );
      const panel = titlebar.querySelector('[data-testid="task-pair-status-panel"]') as HTMLElement;
      expect(panel.classList.contains('is-collapsed')).toBe(true);
      expect(panel.classList.contains('is-fullscreen')).toBe(false);

      // Expand -> fullscreen class added, not collapsed by cramped height, no --task-pair-panel-max-h written
      fireEvent.click(titlebar.querySelector('.task-pair-status-compact') as HTMLElement);
      expect(panel.classList.contains('is-collapsed')).toBe(false);
      expect(panel.classList.contains('is-mobile')).toBe(true);
      expect(panel.classList.contains('is-fullscreen')).toBe(true);
      expect(panel.style.getPropertyValue(TASK_PAIR_PANEL_MAX_HEIGHT_VAR)).toBe('');

      // Collapse via ⌃ toggle
      fireEvent.click(titlebar.querySelector('button.task-pair-status-toggle') as HTMLElement);
      expect(panel.classList.contains('is-collapsed')).toBe(true);
      expect(panel.classList.contains('is-fullscreen')).toBe(false);

      // Re-expand and click session pill -> dispatches deck:navigate and auto-collapses fullscreen panel
      fireEvent.click(titlebar.querySelector('.task-pair-status-compact') as HTMLElement);
      expect(panel.classList.contains('is-fullscreen')).toBe(true);
      const sessionBtn = titlebar.querySelector('.task-pair-status-session[data-session-name="deck_sub_a"]') as HTMLElement;
      expect(sessionBtn).toBeTruthy();
      fireEvent.click(sessionBtn);
      expect(navigateEvents).toEqual(['deck_sub_a']);
      expect(panel.classList.contains('is-collapsed')).toBe(true);
      expect(panel.classList.contains('is-fullscreen')).toBe(false);
    } finally {
      window.removeEventListener('deck:navigate', onNavigate);
      host.remove();
    }
  });

  it('keeps mobile sub-window task panel inline without is-fullscreen and preserves fit/cramped measurement', () => {
    setDevice('phone');
    const host = document.createElement('div');
    host.className = 'chat-main';
    const titlebar = document.createElement('div');
    titlebar.className = 'chat-titlebar';
    host.appendChild(titlebar);
    document.body.appendChild(host);
    host.getBoundingClientRect = () => ({ top: 140, bottom: 637, left: 0, right: 390, width: 390, height: 497, x: 0, y: 140, toJSON: () => ({}) } as DOMRect);
    titlebar.getBoundingClientRect = () => ({ top: 140, bottom: 193, left: 0, right: 390, width: 390, height: 53, x: 0, y: 140, toJSON: () => ({}) } as DOMRect);
    const anchorRef = { current: titlebar };
    const mountTarget = document.createElement('div');
    host.appendChild(mountTarget);

    try {
      render(
        <TaskPairStatusPanelHost
          events={live}
          serverId="srv"
          scopeSessionId="deck_sub_a"
          mobileAnchorRef={anchorRef}
        />,
        { container: mountTarget },
      );
      const panel = titlebar.querySelector('[data-testid="task-pair-status-panel"]') as HTMLElement;
      expect(panel.classList.contains('is-collapsed')).toBe(true);
      expect(panel.classList.contains('is-fullscreen')).toBe(false);

      fireEvent.click(titlebar.querySelector('.task-pair-status-compact') as HTMLElement);
      expect(panel.classList.contains('is-collapsed')).toBe(false);
      expect(panel.classList.contains('is-mobile')).toBe(true);
      expect(panel.classList.contains('is-fullscreen')).toBe(false);
      expect(panel.style.getPropertyValue(TASK_PAIR_PANEL_MAX_HEIGHT_VAR)).toBe('432px');
    } finally {
      host.remove();
    }
  });

  it('keeps desktop main chat and sub-window panels docked/inline without is-fullscreen and does not collapse on session click', () => {
    setDevice('desktop');
    const navigateEvents: string[] = [];
    const onNavigate = (e: Event) => navigateEvents.push((e as CustomEvent<{ session: string }>).detail.session);
    window.addEventListener('deck:navigate', onNavigate);
    try {
      const mainView = render(<TaskPairStatusPanel events={live} serverId="srv" />);
      const mainPanel = mainView.container.querySelector('[data-testid="task-pair-status-panel"]') as HTMLElement;
      expect(mainPanel.classList.contains('is-desktop')).toBe(true);
      expect(mainPanel.classList.contains('is-fullscreen')).toBe(false);
      expect(mainPanel.classList.contains('is-collapsed')).toBe(false);
      expect(mainPanel.querySelector('.task-pair-status-resize')).toBeTruthy();

      fireEvent.click(mainPanel.querySelector('.task-pair-status-session[data-session-name="deck_sub_a"]') as HTMLElement);
      expect(navigateEvents).toEqual(['deck_sub_a']);
      expect(mainPanel.classList.contains('is-collapsed')).toBe(false);
      mainView.unmount();

      const subView = render(<TaskPairStatusPanel events={live} serverId="srv" scopeSessionId="deck_sub_a" />);
      const subPanel = subView.container.querySelector('[data-testid="task-pair-status-panel"]') as HTMLElement;
      expect(subPanel.classList.contains('is-desktop')).toBe(true);
      expect(subPanel.classList.contains('is-fullscreen')).toBe(false);
      expect(subPanel.classList.contains('is-collapsed')).toBe(false);
      subView.unmount();
    } finally {
      window.removeEventListener('deck:navigate', onNavigate);
    }
  });
});
