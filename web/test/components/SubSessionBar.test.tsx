/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (key === 'subsessionBar.subs_count') return `Subs (${vars?.count ?? 0})`;
      if (key === 'subsessionBar.add_sub_session_short') return '+ sub-session';
      if (key === 'subsessionBar.p2p_discussions') return 'Team discussions';
      if (key === 'repo.info_title') return 'Repository information';
      if (key === 'subsessionBar.scheduled_tasks') return 'Scheduled Tasks';
      if (key === 'subsessionBar.daemon_details_open') return 'Show daemon details';
      if (key === 'subsessionBar.daemon_details_kicker') return 'SYSTEM // DAEMON';
      if (key === 'subsessionBar.daemon_details_title') return 'Daemon status';
      if (key === 'subsessionBar.daemon_details_close') return 'Close daemon details';
      if (key === 'subsessionBar.daemon_details_version') return 'Full version';
      if (key === 'subsessionBar.daemon_details_cpu') return 'CPU';
      if (key === 'subsessionBar.daemon_details_memory') return 'Memory';
      if (key === 'subsessionBar.daemon_details_load') return 'Load 1 / 5 / 15';
      if (key === 'subsessionBar.daemon_details_uptime') return 'Uptime';
      if (key === 'subsessionBar.daemon_details_disks') return 'Disk capacity';
      if (key === 'subsessionBar.daemon_details_embedding') return 'Embedding';
      if (key === 'subsessionBar.daemon_details_memory_handles') return 'Memory handles';
      if (key === 'subsessionBar.daemon_details_memory_handles_ok') return 'Healthy';
      if (key === 'subsessionBar.daemon_details_local_time') return 'Local time';
      if (key === 'subsessionBar.daemon_details_no_data') return 'No data reported';
      if (key === 'embedding.status_ready') return 'Embedding ready';
      if (key === 'memory.short_ref_failure_short') return 'memory handles failing';
      if (key === 'memory.short_ref_failure_detail') {
        return `stage=${vars?.stage} failures=${vars?.failures} at=${vars?.when} error=${vars?.error}`;
      }
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
  P2pProgressCard: ({ hidden, onToggleHide, compact, mobile, ultraCompact }: { hidden?: boolean; onToggleHide?: () => void; compact?: boolean; mobile?: boolean; ultraCompact?: boolean }) => (
    <div
      data-testid="p2p-progress-card"
      data-compact={compact ? 'true' : 'false'}
      data-mobile={mobile ? 'true' : 'false'}
      data-ultra-compact={ultraCompact ? 'true' : 'false'}
    >
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
import { SUPPORTED_LOCALES } from '../../src/i18n/locales/index.js';

const LOCALE_DIR = join(process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web'), 'src/i18n/locales');

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
    expect(view.container.querySelector('.daemon-local-clock-date')?.textContent).toBe('2026-05-12');
    expect(view.container.querySelector('.daemon-local-clock-time')?.textContent).toBe('07:08:09');
    expect(getStatsText()).toContain('2026-05-12');
    expect(getStatsText()).toContain('07:08:09');
    const stableDateDigit = view.container.querySelector('.daemon-local-clock-date .daemon-local-clock-digit') as HTMLSpanElement;
    const changingSecondDigit = Array.from(view.container.querySelectorAll('.daemon-local-clock-time .daemon-local-clock-digit')).at(-1) as HTMLSpanElement;

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(view.container.querySelector('.daemon-local-clock-date')?.textContent).toBe('2026-05-12');
    expect(view.container.querySelector('.daemon-local-clock-time')?.textContent).toBe('07:08:10');
    expect(view.container.querySelector('.daemon-local-clock-date .daemon-local-clock-digit')).toBe(stableDateDigit);
    expect(Array.from(view.container.querySelectorAll('.daemon-local-clock-time .daemon-local-clock-digit')).at(-1)).not.toBe(changingSecondDigit);
  });

  it('shows a compact mobile daemon version without a local clock', async () => {
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

    const statsText = view.container.querySelector('.daemon-stats-inline')?.textContent ?? '';
    expect(statsText).toContain('5.2161-dev');
    expect(statsText).not.toContain('v2026.');
    expect(statsText).not.toMatch(/07:08:\d{2}/);
    expect(view.container.querySelector('.daemon-local-clock')).toBeNull();
  });

  it('opens the complete daemon status from the whole mobile status region and closes from the backdrop', async () => {
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
      statsWs.emit({
        ...daemonStatsMessage,
        disks: [
          { mount: '/', usedBytes: 440 * 1024 ** 3, totalBytes: 460 * 1024 ** 3, usedPercent: 96 },
          { mount: '/data', usedBytes: 120 * 1024 ** 3, totalBytes: 500 * 1024 ** 3, usedPercent: 24 },
        ],
        embedding: { state: 'ready', reason: null },
      });
    });

    const trigger = view.getByRole('button', { name: 'Show daemon details' });
    expect(trigger.classList.contains('daemon-stats-inline')).toBe(true);
    expect(trigger.textContent).toContain('2%');
    expect(trigger.querySelector('button')).toBeNull();
    fireEvent.click(trigger);

    const dialog = view.getByRole('dialog', { name: 'Daemon status' });
    expect(dialog.textContent).toContain('v2026.5.2161-dev.7');
    expect(dialog.textContent).toContain('2%');
    expect(dialog.textContent).toContain('9.9 / 41.2 GB');
    expect(dialog.textContent).toContain('0.8 / 0.7 / 0.6');
    expect(dialog.textContent).toContain('1h');
    expect(dialog.textContent).toContain('440/460GB');
    expect(dialog.textContent).toContain('120/500GB');
    expect(dialog.textContent).toContain('Embedding ready');
    expect(dialog.textContent).toContain('Healthy');
    expect(dialog.textContent).toContain('Local time');

    fireEvent.click(dialog);
    expect(view.queryByRole('dialog', { name: 'Daemon status' })).not.toBeNull();

    fireEvent.click(view.getByTestId('daemon-details-backdrop'));
    expect(view.queryByRole('dialog', { name: 'Daemon status' })).toBeNull();
  });

  it.each([true, false])('opens daemon details from the entire desktop status region when collapsed=%s', async (collapsed) => {
    const statsWs = makeStatsWs();
    const view = render(
      <SubSessionBar
        subSessions={[makeSubSession()]}
        openIds={new Set()}
        collapsed={collapsed}
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

    const trigger = view.getByRole('button', { name: 'Show daemon details' });
    expect(trigger.classList.contains('daemon-stats-inline')).toBe(true);
    expect(trigger.textContent).toContain(collapsed ? '2%' : 'CPU');
    expect(trigger.querySelector('.daemon-local-clock')).not.toBeNull();
    fireEvent.click(trigger);

    expect(view.getByRole('dialog', { name: 'Daemon status' }).textContent).toContain('v2026.5.2161-dev.7');
  });

  it('shows the Auto Deliver entry in the desktop sub-session toolbar', () => {
    const onViewAutoDeliver = vi.fn();
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
        onViewAutoDeliver={onViewAutoDeliver}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    const button = view.getByTestId('subsession-auto-deliver-status');
    fireEvent.click(button);

    expect(onViewAutoDeliver).toHaveBeenCalledTimes(1);
  });

  it('hides the Auto Deliver entry in the mobile sub-session toolbar', () => {
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
        onViewAutoDeliver={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    expect(view.queryByTestId('subsession-auto-deliver-status')).toBeNull();
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

  it('shows a desktop quick window strip for one or more open sub-session windows and reuses the shared close handler', () => {
    const onCloseAllOpen = vi.fn();
    const subSessions = [
      makeSubSession({ id: 'sub-a', sessionName: 'deck_sub_sub-a', label: 'a' }),
      makeSubSession({ id: 'sub-b', sessionName: 'deck_sub_sub-b', label: 'b' }),
      makeSubSession({ id: 'sub-c', sessionName: 'deck_sub_sub-c', label: 'c' }),
    ];

    const view = render(
      <SubSessionBar
        subSessions={subSessions}
        openIds={new Set(['sub-a', 'sub-b'])}
        collapsed={true}
        desktopLayoutCapable={true}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onCloseAllOpen={onCloseAllOpen}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    const strip = view.container.querySelector('.subsession-close-all-strip') as HTMLButtonElement;
    expect(strip).not.toBeNull();
    expect(strip.getAttribute('aria-label')).toBe('subsessionBar.quick_close_open');
    expect(strip.textContent).toBe('↓');

    fireEvent.click(strip);

    expect(onCloseAllOpen).toHaveBeenCalledTimes(1);

    view.rerender(
      <SubSessionBar
        subSessions={subSessions}
        openIds={new Set(['sub-a'])}
        collapsed={true}
        desktopLayoutCapable={true}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onCloseAllOpen={onCloseAllOpen}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    expect(view.container.querySelector('.subsession-close-all-strip')).not.toBeNull();
  });

  it('restores the windows closed by the desktop quick window strip', () => {
    const onCloseAllOpen = vi.fn();
    const onRestoreQuickClosed = vi.fn();
    const subSessions = [
      makeSubSession({ id: 'sub-a', sessionName: 'deck_sub_sub-a', label: 'a' }),
      makeSubSession({ id: 'sub-b', sessionName: 'deck_sub_sub-b', label: 'b' }),
    ];

    const view = render(
      <SubSessionBar
        subSessions={subSessions}
        openIds={new Set(['sub-a', 'sub-b'])}
        collapsed={true}
        desktopLayoutCapable={true}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onCloseAllOpen={onCloseAllOpen}
        onRestoreQuickClosed={onRestoreQuickClosed}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    fireEvent.click(view.container.querySelector('.subsession-close-all-strip') as HTMLButtonElement);

    view.rerender(
      <SubSessionBar
        subSessions={subSessions}
        openIds={new Set()}
        collapsed={true}
        desktopLayoutCapable={true}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onCloseAllOpen={onCloseAllOpen}
        onRestoreQuickClosed={onRestoreQuickClosed}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    const restoreStrip = view.container.querySelector('.subsession-close-all-strip') as HTMLButtonElement;
    expect(restoreStrip.disabled).toBe(false);
    expect(restoreStrip.getAttribute('aria-label')).toBe('subsessionBar.restore_quick_closed');
    expect(restoreStrip.textContent).toBe('↑');

    fireEvent.click(restoreStrip);

    expect(onRestoreQuickClosed).toHaveBeenCalledWith(['sub-a', 'sub-b']);
  });

  it('keeps the desktop quick window strip disabled until a window can be closed or restored', () => {
    const subSessions = [
      makeSubSession({ id: 'sub-a', sessionName: 'deck_sub_sub-a', label: 'a' }),
    ];

    const view = render(
      <SubSessionBar
        subSessions={subSessions}
        openIds={new Set()}
        collapsed={true}
        desktopLayoutCapable={true}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onCloseAllOpen={vi.fn()}
        onRestoreQuickClosed={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    const strip = view.container.querySelector('.subsession-close-all-strip') as HTMLButtonElement;
    expect(strip).not.toBeNull();
    expect(strip.disabled).toBe(true);
    expect(strip.getAttribute('aria-label')).toBe('subsessionBar.quick_close_unavailable');
    expect(strip.textContent).toBe('↓');
  });

  it('hides the quick window strip on mobile or without the shared handler', () => {
    const subSessions = [
      makeSubSession({ id: 'sub-a', sessionName: 'deck_sub_sub-a', label: 'a' }),
      makeSubSession({ id: 'sub-b', sessionName: 'deck_sub_sub-b', label: 'b' }),
    ];
    const renderBar = (props: { openIds: Set<string>; desktopLayoutCapable?: boolean; onCloseAllOpen?: () => void }) => render(
      <SubSessionBar
        subSessions={subSessions}
        openIds={props.openIds}
        collapsed={true}
        desktopLayoutCapable={props.desktopLayoutCapable ?? true}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onCloseAllOpen={props.onCloseAllOpen}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    const mobile = renderBar({ openIds: new Set(['sub-a', 'sub-b']), desktopLayoutCapable: false, onCloseAllOpen: vi.fn() });
    expect(mobile.container.querySelector('.subsession-close-all-strip')).toBeNull();
    mobile.unmount();

    const noHandler = renderBar({ openIds: new Set(['sub-a', 'sub-b']) });
    expect(noHandler.container.querySelector('.subsession-close-all-strip')).toBeNull();
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
          topic: 'Team audit',
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

  it('toggles and persists the desktop P2P compact bar mode', () => {
    const discussion = {
      id: 'p2p_run_1',
      topic: 'Team audit',
      state: 'running',
      currentRound: 1,
      maxRounds: 1,
      completedHops: 0,
      totalHops: 1,
    };
    const renderBar = () => render(
      <SubSessionBar
        subSessions={[makeSubSession()]}
        openIds={new Set()}
        desktopLayoutCapable={true}
        discussions={[discussion]}
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

    const view = renderBar();
    const card = () => view.getByTestId('p2p-progress-card');

    expect(card().getAttribute('data-compact')).toBe('true');
    expect(card().getAttribute('data-mobile')).toBe('false');
    expect(card().getAttribute('data-ultra-compact')).toBe('false');

    fireEvent.click(view.getByTestId('p2p-desktop-compact-toggle'));

    expect(card().getAttribute('data-compact')).toBe('false');
    expect(card().getAttribute('data-mobile')).toBe('false');
    expect(card().getAttribute('data-ultra-compact')).toBe('true');
    expect(localStorage.getItem('rcc_subcard_p2p_desktop_compact')).toBe('true');

    view.unmount();
    const restored = renderBar();
    expect(restored.getByTestId('p2p-progress-card').getAttribute('data-ultra-compact')).toBe('true');
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

  it('uses beginner-friendly desktop toolbar labels and compact mobile icons', () => {
    const renderBar = (desktopLayoutCapable: boolean) => render(
      <SubSessionBar
        subSessions={[]}
        openIds={new Set()}
        desktopLayoutCapable={desktopLayoutCapable}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        onViewDiscussions={vi.fn()}
        onViewRepo={vi.fn()}
        onViewCron={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    const desktop = renderBar(true);
    expect(desktop.container.querySelector('[data-onboarding="new-sub-session"]')?.textContent?.trim()).toBe('+ sub-session');
    expect(desktop.container.querySelector('[data-onboarding="discussion-history"]')?.textContent).toContain('👥');
    expect(desktop.container.querySelector('[data-onboarding="discussion-history"]')?.textContent).toContain('Team discussions');
    expect(desktop.container.querySelector('[data-onboarding="repo-page"]')?.textContent).toContain('🗂️');
    expect(desktop.container.querySelector('[data-onboarding="repo-page"]')?.textContent).toContain('Repository information');
    expect(desktop.container.querySelector('[data-onboarding="cron-manager"]')?.textContent).toContain('⏰');
    expect(desktop.container.querySelector('[data-onboarding="cron-manager"]')?.textContent).toContain('Scheduled Tasks');
    desktop.unmount();

    const mobile = renderBar(false);
    expect(mobile.container.querySelector('[data-onboarding="new-sub-session"]')?.textContent?.trim()).toBe('+');
    expect(mobile.container.querySelector('[data-onboarding="discussion-history"]')?.textContent).toContain('👥');
    expect(mobile.container.querySelector('[data-onboarding="discussion-history"]')?.textContent).not.toContain('Team discussions');
    expect(mobile.container.querySelector('[data-onboarding="repo-page"]')?.textContent).toContain('🗂️');
    expect(mobile.container.querySelector('[data-onboarding="repo-page"]')?.textContent).not.toContain('Repository information');
    expect(mobile.container.querySelector('[data-onboarding="cron-manager"]')?.textContent).toContain('⏰');
    expect(mobile.container.querySelector('[data-onboarding="cron-manager"]')?.textContent).not.toContain('Scheduled Tasks');
  });

  // Audit fix (P2P bar scoping follow-up) — pin the contract that the
  // View Discussions (👥) button shows a numeric badge when there are
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

  // The health record already travelled daemon -> bridge -> browser; these cover the
  // last hop, where it either becomes something an operator sees or dies silently.
  const failingHealth = {
    stage: 'persist_store',
    failures: 3,
    lastFailureAt: new Date(2026, 4, 12, 7, 8, 9).getTime(),
    lastError: 'ENOSPC: no space left on device',
  };

  function renderBarWithStats(collapsed: boolean, statsWs: ReturnType<typeof makeStatsWs>) {
    return render(
      <SubSessionBar
        subSessions={[makeSubSession()]}
        openIds={new Set()}
        collapsed={collapsed}
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
  }

  it.each([['collapsed', true], ['expanded', false]] as const)(
    'surfaces a short-ref persistence failure in the %s status bar',
    async (_label, collapsed) => {
      const statsWs = makeStatsWs();
      const view = renderBarWithStats(collapsed, statsWs);
      await waitFor(() => expect(statsWs.ws.onMessage).toHaveBeenCalled());

      // A healthy daemon must not show the marker, otherwise it is noise and
      // gets ignored exactly when it matters.
      act(() => { statsWs.emit(daemonStatsMessage); });
      expect(view.container.querySelector('.daemon-stat-shortref-alert')).toBeNull();

      act(() => { statsWs.emit({ ...daemonStatsMessage, shortRefHealth: failingHealth }); });

      const alert = view.container.querySelector('.daemon-stat-shortref-alert') as HTMLElement;
      expect(alert).toBeTruthy();
      expect(alert.textContent).toContain('memory handles failing');
      // The tooltip has to name the stage, the count and the underlying error;
      // "something is wrong" is not actionable at 3am.
      expect(alert.title).toContain('persist_store');
      expect(alert.title).toContain('failures=3');
      expect(alert.title).toContain('ENOSPC');
    },
  );

  it('keeps the marker visible on mobile, unlike the disk readout', async () => {
    // Disk usage is desktop-only by request, but a failure that silently breaks
    // memory recall should not depend on which client happens to be open.
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
      statsWs.emit({
        ...daemonStatsMessage,
        disks: [{ mount: '/', usedBytes: 5 * 1024 ** 4, totalBytes: 8 * 1024 ** 4, usedPercent: 62 }],
        shortRefHealth: failingHealth,
      });
    });

    expect(view.container.querySelector('.daemon-stat-disk')).toBeNull();
    expect(view.container.querySelector('.daemon-stat-shortref-alert')).toBeTruthy();
  });

  it('ships both alert strings in every locale, with the placeholders the tooltip passes', () => {
    // The t() mock above would happily render a key that does not exist in
    // production, so check the real locale files rather than trusting it.
    for (const locale of SUPPORTED_LOCALES) {
      const raw = JSON.parse(readFileSync(join(LOCALE_DIR, `${locale}.json`), 'utf8')) as Record<string, Record<string, string>>;
      const short = raw.memory?.short_ref_failure_short;
      const detail = raw.memory?.short_ref_failure_detail;
      expect(short, `${locale}: memory.short_ref_failure_short`).toBeTruthy();
      expect(detail, `${locale}: memory.short_ref_failure_detail`).toBeTruthy();
      for (const placeholder of ['stage', 'failures', 'when', 'error']) {
        expect(detail, `${locale}: {{${placeholder}}}`).toContain(`{{${placeholder}}}`);
      }
    }
  });

  it('ships every mobile daemon detail label in all locales', () => {
    const keys = [
      'daemon_details_open',
      'daemon_details_kicker',
      'daemon_details_title',
      'daemon_details_close',
      'daemon_details_version',
      'daemon_details_cpu',
      'daemon_details_memory',
      'daemon_details_load',
      'daemon_details_uptime',
      'daemon_details_disks',
      'daemon_details_embedding',
      'daemon_details_memory_handles',
      'daemon_details_memory_handles_ok',
      'daemon_details_local_time',
      'daemon_details_no_data',
    ];
    for (const locale of SUPPORTED_LOCALES) {
      const raw = JSON.parse(readFileSync(join(LOCALE_DIR, `${locale}.json`), 'utf8')) as Record<string, Record<string, string>>;
      for (const key of keys) {
        expect(raw.subsessionBar?.[key], `${locale}: subsessionBar.${key}`).toBeTruthy();
      }
    }
  });
});
