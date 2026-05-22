/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (key === 'subsessionBar.subs_count') return `Subs (${vars?.count ?? 0})`;
      return key;
    },
  }),
}));

vi.mock('../../src/components/SubSessionCard.js', () => ({
  SubSessionCard: ({ sub, accentColor }: { sub: SubSession; accentColor?: string }) => (
    <div
      data-testid={`subsession-preview-${sub.id}`}
      style={{ '--subsession-accent-color': accentColor } as any}
    />
  ),
}));

vi.mock('../../src/components/P2pProgressCard.js', () => ({
  P2pProgressCard: ({ hidden, onToggleHide }: { hidden?: boolean; onToggleHide?: () => void }) => (
    <div>
      <span data-testid="p2p-hidden-state">{hidden ? 'hidden' : 'visible'}</span>
      {onToggleHide && <button onClick={onToggleHide}>toggle-p2p-hide</button>}
    </div>
  ),
}));

vi.mock('../../src/api.js', () => ({
  reorderSubSessions: vi.fn().mockResolvedValue(undefined),
}));

import { SubSessionBar } from '../../src/components/SubSessionBar.js';
import { reorderSubSessions } from '../../src/api.js';
import type { SubSession } from '../../src/hooks/useSubSessions.js';
import { SUBSESSION_ACCENT_COLORS } from '../../src/subsession-accent-colors.js';

function makeSubSession(overrides: Partial<SubSession> = {}): SubSession {
  return {
    id: 'sub-1',
    serverId: 'srv-1',
    type: 'codex',
    shellBin: null,
    cwd: '/tmp',
    label: 'worker',
    ccSessionId: null,
    geminiSessionId: null,
    parentSession: 'deck_proj_brain',
    ccPresetId: null,
    sessionName: 'deck_sub_sub-1',
    state: 'idle',
    ...overrides,
  };
}

function makeStatsWs() {
  let handler: ((msg: any) => void) | null = null;
  const ws = {
    onMessage: vi.fn((next: (msg: any) => void) => {
      handler = next;
      return () => {
        if (handler === next) handler = null;
      };
    }),
  };
  return {
    ws,
    emit: (msg: any) => handler?.(msg),
  };
}

const daemonStatsMessage = {
  type: 'daemon.stats',
  daemonVersion: '2026.5.2161-dev.7',
  cpu: 2,
  memUsed: 9.9 * 1024 ** 3,
  memTotal: 41.2 * 1024 ** 3,
  load1: 0.8,
  load5: 0.7,
  load15: 0.6,
  uptime: 3600,
  embedding: null,
};

describe('SubSessionBar', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('can share collapsed state with an external fullscreen control', () => {
    const onCollapsedChange = vi.fn();
    const view = render(
      <SubSessionBar
        subSessions={[makeSubSession()]}
        openIds={new Set()}
        collapsed={false}
        onCollapsedChange={onCollapsedChange}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    expect(view.container.querySelector('.subcard-scroll')).toBeTruthy();

    fireEvent.click(view.container.querySelector('.subcard-toolbar-btn') as HTMLButtonElement);

    expect(onCollapsedChange).toHaveBeenCalledWith(true);

    view.rerender(
      <SubSessionBar
        subSessions={[makeSubSession()]}
        openIds={new Set()}
        collapsed={true}
        onCollapsedChange={onCollapsedChange}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    expect(view.container.querySelector('.subsession-bar')).toBeTruthy();
  });

  it('shows a desktop local clock after compact daemon stats and updates it from the shared ticker', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 12, 7, 8, 9));
    const statsWs = makeStatsWs();
    const view = render(
      <SubSessionBar
        subSessions={[makeSubSession()]}
        openIds={new Set()}
        collapsed={true}
        desktopLayoutCapable={true}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={statsWs.ws as any}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    await waitFor(() => expect(statsWs.ws.onMessage).toHaveBeenCalled());
    act(() => {
      statsWs.emit(daemonStatsMessage);
    });

    const getStatsText = () => view.container.querySelector('.daemon-stats-inline')?.textContent ?? '';
    expect(getStatsText()).toContain('2026-05-12 07:08:09');

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(getStatsText()).toContain('2026-05-12 07:08:10');
  });

  it('does not add the local clock to mobile daemon stats', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 12, 7, 8, 9));
    const statsWs = makeStatsWs();
    const view = render(
      <SubSessionBar
        subSessions={[makeSubSession()]}
        openIds={new Set()}
        collapsed={true}
        desktopLayoutCapable={false}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={statsWs.ws as any}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    await waitFor(() => expect(statsWs.ws.onMessage).toHaveBeenCalled());
    act(() => {
      statsWs.emit(daemonStatsMessage);
    });

    expect(view.container.querySelector('.daemon-stats-inline')?.textContent).not.toContain('2026-05-12');
  });

  it('only applies the running pulse to collapsed mini cards while the sub-session is running', () => {
    const idleView = render(
      <SubSessionBar
        subSessions={[makeSubSession({ state: 'idle' })]}
        openIds={new Set()}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    fireEvent.click(idleView.container.querySelector('.subcard-toolbar-btn') as HTMLButtonElement);
    const idleCard = idleView.container.querySelector('.subsession-card') as HTMLButtonElement;
    expect(idleCard.className).not.toContain('subcard-running-pulse');
    idleView.unmount();

    const runningView = render(
      <SubSessionBar
        subSessions={[makeSubSession({ state: 'running' })]}
        openIds={new Set()}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    if (!runningView.container.querySelector('.subsession-bar')) {
      fireEvent.click(runningView.container.querySelector('.subcard-toolbar-btn') as HTMLButtonElement);
    }
    const runningCard = runningView.container.querySelector('.subsession-card') as HTMLButtonElement;
    expect(runningCard.className).toContain('subcard-running-pulse');
  });

  it('assigns ordered accent colors to collapsed buttons and cycles after the palette', () => {
    const subSessions = Array.from({ length: 16 }, (_, index) => makeSubSession({
      id: `sub-${index + 1}`,
      sessionName: `deck_sub_sub-${index + 1}`,
      label: `worker-${index + 1}`,
    }));

    const view = render(
      <SubSessionBar
        subSessions={subSessions}
        openIds={new Set()}
        collapsed={true}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    const buttons = Array.from(view.container.querySelectorAll('.subsession-card')) as HTMLElement[];
    expect(buttons).toHaveLength(16);
    expect(buttons[0].style.getPropertyValue('--subsession-accent-color')).toBe(SUBSESSION_ACCENT_COLORS[0]);
    expect(buttons[14].style.getPropertyValue('--subsession-accent-color')).toBe(SUBSESSION_ACCENT_COLORS[14]);
    expect(buttons[15].style.getPropertyValue('--subsession-accent-color')).toBe(SUBSESSION_ACCENT_COLORS[0]);
  });

  it('passes the same ordered accent colors to expanded preview cards', () => {
    const subSessions = [
      makeSubSession({ id: 'sub-a', sessionName: 'deck_sub_sub-a', label: 'a' }),
      makeSubSession({ id: 'sub-b', sessionName: 'deck_sub_sub-b', label: 'b' }),
    ];

    const view = render(
      <SubSessionBar
        subSessions={subSessions}
        openIds={new Set()}
        collapsed={false}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    expect((view.getByTestId('subsession-preview-sub-a') as HTMLElement).style.getPropertyValue('--subsession-accent-color')).toBe(SUBSESSION_ACCENT_COLORS[0]);
    expect((view.getByTestId('subsession-preview-sub-b') as HTMLElement).style.getPropertyValue('--subsession-accent-color')).toBe(SUBSESSION_ACCENT_COLORS[1]);
  });

  it('progressively mounts expanded preview cards instead of mounting every card in the first render', async () => {
    vi.useFakeTimers();
    const subSessions = Array.from({ length: 8 }, (_, index) => makeSubSession({
      id: `sub-${index + 1}`,
      sessionName: `deck_sub_sub-${index + 1}`,
      label: `worker-${index + 1}`,
    }));

    const view = render(
      <SubSessionBar
        subSessions={subSessions}
        openIds={new Set()}
        collapsed={false}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    expect(view.container.querySelectorAll('[data-testid^="subsession-preview-"]')).toHaveLength(2);
    expect(view.container.querySelectorAll('.subcard-preview-placeholder')).toHaveLength(6);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(view.container.querySelectorAll('[data-testid^="subsession-preview-"]')).toHaveLength(6);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(32);
    });
    expect(view.container.querySelectorAll('[data-testid^="subsession-preview-"]')).toHaveLength(8);
    expect(view.container.querySelectorAll('.subcard-preview-placeholder')).toHaveLength(0);
  });

  it('toggles the mobile P2P compact bar from the toolbar', () => {
    const view = render(
      <SubSessionBar
        subSessions={[makeSubSession()]}
        openIds={new Set()}
        desktopLayoutCapable={false}
        discussions={[{
          id: 'p2p_run_1',
          topic: 'P2P audit',
          state: 'running',
          currentRound: 1,
          maxRounds: 1,
          completedHops: 0,
          totalHops: 1,
        }]}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    expect(view.getByTestId('p2p-hidden-state').textContent).toBe('visible');
    fireEvent.click(view.getByTestId('p2p-compact-toggle'));
    expect(view.getByTestId('p2p-hidden-state').textContent).toBe('hidden');
    fireEvent.click(view.getByTestId('p2p-compact-toggle'));
    expect(view.getByTestId('p2p-hidden-state').textContent).toBe('visible');
  });

  it('recalculates accent colors and reports visual order after drag reorder', async () => {
    const onVisualOrderChange = vi.fn();
    const subSessions = [
      makeSubSession({ id: 'sub-a', sessionName: 'deck_sub_sub-a', label: 'a' }),
      makeSubSession({ id: 'sub-b', sessionName: 'deck_sub_sub-b', label: 'b' }),
    ];

    const view = render(
      <SubSessionBar
        subSessions={subSessions}
        openIds={new Set()}
        collapsed={false}
        onVisualOrderChange={onVisualOrderChange}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    const wraps = Array.from(view.container.querySelectorAll('.subcard-drag-wrap')) as HTMLElement[];
    const dataTransfer = { effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(wraps[0], { dataTransfer });
    fireEvent.dragOver(wraps[1], { dataTransfer });

    await waitFor(() => {
      expect((view.getByTestId('subsession-preview-sub-b') as HTMLElement).style.getPropertyValue('--subsession-accent-color')).toBe(SUBSESSION_ACCENT_COLORS[0]);
      expect((view.getByTestId('subsession-preview-sub-a') as HTMLElement).style.getPropertyValue('--subsession-accent-color')).toBe(SUBSESSION_ACCENT_COLORS[1]);
      expect(onVisualOrderChange).toHaveBeenLastCalledWith(['sub-b', 'sub-a']);
    });
  });

  it('reorders collapsed desktop buttons with drag and persists the order', async () => {
    const onVisualOrderChange = vi.fn();
    const subSessions = [
      makeSubSession({ id: 'sub-a', sessionName: 'deck_sub_sub-a', label: 'a' }),
      makeSubSession({ id: 'sub-b', sessionName: 'deck_sub_sub-b', label: 'b' }),
    ];

    const view = render(
      <SubSessionBar
        subSessions={subSessions}
        openIds={new Set()}
        collapsed={true}
        serverId="srv-1"
        onVisualOrderChange={onVisualOrderChange}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() };
    const first = view.container.querySelector('[data-sub-id="sub-a"]') as HTMLElement;
    const second = view.container.querySelector('[data-sub-id="sub-b"]') as HTMLElement;

    fireEvent.dragStart(first, { dataTransfer });
    fireEvent.dragOver(second, { dataTransfer });

    await waitFor(() => {
      expect(Array.from(view.container.querySelectorAll('.subsession-card')).map((node) => (node as HTMLElement).dataset.subId)).toEqual(['sub-b', 'sub-a']);
      expect(onVisualOrderChange).toHaveBeenLastCalledWith(['sub-b', 'sub-a']);
    });

    fireEvent.dragEnd(view.container.querySelector('[data-sub-id="sub-a"]') as HTMLElement, { dataTransfer });

    await waitFor(() => {
      expect(vi.mocked(reorderSubSessions)).toHaveBeenCalledWith('srv-1', ['sub-b', 'sub-a']);
    });
  });

  it('keeps mobile long-press drag reorder working without opening the sub-session', async () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const onVisualOrderChange = vi.fn();
    const subSessions = [
      makeSubSession({ id: 'sub-a', sessionName: 'deck_sub_sub-a', label: 'a' }),
      makeSubSession({ id: 'sub-b', sessionName: 'deck_sub_sub-b', label: 'b' }),
    ];

    const view = render(
      <SubSessionBar
        subSessions={subSessions}
        openIds={new Set()}
        collapsed={true}
        desktopLayoutCapable={false}
        serverId="srv-1"
        onVisualOrderChange={onVisualOrderChange}
        onOpen={onOpen}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    const first = view.container.querySelector('[data-sub-id="sub-a"]') as HTMLElement;
    const second = view.container.querySelector('[data-sub-id="sub-b"]') as HTMLElement;
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => second),
    });

    try {
      fireEvent.touchStart(first, { touches: [{ clientX: 10, clientY: 10 }] });
      act(() => {
        vi.advanceTimersByTime(401);
      });
      fireEvent.touchMove(first, { touches: [{ clientX: 80, clientY: 10 }] });

      await waitFor(() => {
        expect(Array.from(view.container.querySelectorAll('.subsession-card')).map((node) => (node as HTMLElement).dataset.subId)).toEqual(['sub-b', 'sub-a']);
        expect(onVisualOrderChange).toHaveBeenLastCalledWith(['sub-b', 'sub-a']);
      });

      fireEvent.touchEnd(first);
      act(() => {
        vi.advanceTimersByTime(151);
      });

      expect(onOpen).not.toHaveBeenCalled();
      expect(vi.mocked(reorderSubSessions)).toHaveBeenCalledWith('srv-1', ['sub-b', 'sub-a']);
    } finally {
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: originalElementFromPoint,
      });
    }
  });

  it('shows idle flash on collapsed buttons only when the token increments after mount', () => {
    const view = render(
      <SubSessionBar
        subSessions={[makeSubSession({ state: 'idle' })]}
        openIds={new Set()}
        idleFlashTokens={new Map([['deck_sub_sub-1', 1]])}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    fireEvent.click(view.container.querySelector('.subcard-toolbar-btn') as HTMLButtonElement);
    expect(view.container.querySelector('.idle-flash-layer--frame')).toBeNull();

    view.rerender(
      <SubSessionBar
        subSessions={[makeSubSession({ state: 'idle' })]}
        openIds={new Set()}
        idleFlashTokens={new Map([['deck_sub_sub-1', 2]])}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    expect(view.container.querySelector('.idle-flash-layer--frame')).not.toBeNull();
  });

  it('registers a non-passive touchmove guard for the horizontal cards strip', () => {
    const addSpy = vi.spyOn(HTMLDivElement.prototype, 'addEventListener');

    render(
      <SubSessionBar
        subSessions={[makeSubSession({ state: 'idle' })]}
        openIds={new Set()}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    expect(addSpy.mock.calls.some(([type, , options]) => type === 'touchmove' && typeof options === 'object' && (options as AddEventListenerOptions).passive === false)).toBe(true);
  });

  it('persists the collapsed toolbar state locally', () => {
    const first = render(
      <SubSessionBar
        subSessions={[makeSubSession({ state: 'idle' })]}
        openIds={new Set()}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    fireEvent.click(first.container.querySelector('.subcard-toolbar-btn') as HTMLButtonElement);
    first.unmount();

    const second = render(
      <SubSessionBar
        subSessions={[makeSubSession({ state: 'idle' })]}
        openIds={new Set()}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    expect(second.container.querySelector('.subsession-bar')).not.toBeNull();
  });

  it('uses saved codex preference as legacy fallback for collapsed model-less codex-sdk sessions', () => {
    localStorage.setItem('imcodes-codex-model:deck_sub_sub-1', 'gpt-5.5');
    const view = render(
      <SubSessionBar
        subSessions={[makeSubSession({ type: 'codex-sdk' } as any)]}
        openIds={new Set()}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
        subUsages={new Map([[
          'deck_sub_sub-1',
          { inputTokens: 166_000, cacheTokens: 0, contextWindow: 258_400, contextWindowSource: 'provider' },
        ]]) as any}
      />,
    );

    fireEvent.click(view.container.querySelector('.subcard-toolbar-btn') as HTMLButtonElement);
    const card = view.container.querySelector('.subsession-card') as HTMLButtonElement;
    expect(card.title).toContain('gpt-5.5');
    expect(card.title).toContain('ctx 64%');
    expect(card.title).not.toContain('ctx 18%');
  });

  it('uses sub-session model metadata when collapsed usage omits model but has a provider window', () => {
    const view = render(
      <SubSessionBar
        subSessions={[makeSubSession({ type: 'codex-sdk', activeModel: 'gpt-5.5' } as any)]}
        openIds={new Set()}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
        subUsages={new Map([[
          'deck_sub_sub-1',
          { inputTokens: 100_000, cacheTokens: 0, contextWindow: 258_400, contextWindowSource: 'provider' },
        ]]) as any}
      />,
    );

    fireEvent.click(view.container.querySelector('.subcard-toolbar-btn') as HTMLButtonElement);
    const card = view.container.querySelector('.subsession-card') as HTMLButtonElement;
    expect(card.title).toContain('gpt-5.5');
    expect(card.title).toContain('ctx 39%');
    expect(card.title).not.toContain('ctx 11%');
  });

  // Audit fix (P2P bar scoping follow-up) — pin the contract that the
  // View Discussions (📋) button shows a numeric badge when there are
  // running discussions ANYWHERE on the daemon, not just in this
  // session's bar. Without it, scoping the bar to a single session
  // hides the existence of runs in other sessions and the user loses
  // track.
  describe('totalRunningDiscussions badge on view-discussions button', () => {
    const renderBarWithBadge = (totalRunningDiscussions: number) => render(
      <SubSessionBar
        subSessions={[]}
        openIds={new Set()}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        onViewDiscussions={vi.fn()}
        totalRunningDiscussions={totalRunningDiscussions}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    it('does NOT render the badge when no discussions are running', () => {
      const view = renderBarWithBadge(0);
      expect(view.container.querySelector('[data-testid="p2p-discussions-running-badge"]')).toBeNull();
    });

    it('renders the badge with the running count when there are 1+ running discussions', () => {
      const view = renderBarWithBadge(3);
      const badge = view.container.querySelector('[data-testid="p2p-discussions-running-badge"]');
      expect(badge).not.toBeNull();
      expect(badge?.textContent).toBe('3');
    });

    it('caps the displayed count at 99+ for runaway daemons', () => {
      const view = renderBarWithBadge(120);
      expect(
        view.container.querySelector('[data-testid="p2p-discussions-running-badge"]')?.textContent,
      ).toBe('99+');
    });

    it('exposes the running count via data attribute for screen-reader-friendly tooling', () => {
      const view = renderBarWithBadge(2);
      const button = view.container.querySelector('[data-onboarding="discussion-history"]') as HTMLButtonElement;
      expect(button.getAttribute('data-running-discussions')).toBe('2');
    });
  });

});
