/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, type ComponentProps } from 'preact';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';

const { probeDirectConnectivityMock, directFileStatusListeners } = vi.hoisted(() => ({
  probeDirectConnectivityMock: vi.fn(),
  directFileStatusListeners: new Set<(status: 'none' | 'direct' | 'relay') => void>(),
}));

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
      if (key === 'subsessionBar.daemon_details_direct_connectivity') return 'Direct connectivity';
      if (key === 'subsessionBar.daemon_connection_direct') return 'Direct link';
      if (key === 'subsessionBar.daemon_connection_relay') return 'Relay';
      if (key === 'subsessionBar.daemon_connection_none') return 'Not connected';
      if (key === 'subsessionBar.daemon_details_direct_runtime_unavailable') return 'WebRTC runtime unavailable';
      if (key === 'subsessionBar.daemon_details_direct_probing') return 'Testing direct path…';
      if (key === 'subsessionBar.daemon_details_direct_lan') return 'LAN direct';
      if (key === 'subsessionBar.daemon_details_direct_ip') return 'IP direct';
      if (key === 'subsessionBar.daemon_details_direct_relay') return 'Relay path';
      if (key === 'subsessionBar.daemon_details_direct_refresh') return 'Test direct connectivity';
      if (key === 'subsessionBar.daemon_details_direct_current_step') return 'Current step';
      if (key === 'subsessionBar.daemon_details_direct_browser_nat') return 'Browser network (inferred)';
      if (key === 'subsessionBar.daemon_details_direct_daemon_nat') return 'Daemon network (inferred)';
      if (key === 'subsessionBar.daemon_details_direct_nat_note') return 'Candidate inference only';
      if (key === 'subsessionBar.daemon_details_direct_technical_details') return 'Technical details';
      if (key === 'subsessionBar.daemon_details_direct_no_candidates') return 'No ICE candidates observed';
      if (key === 'subsessionBar.daemon_details_direct_stage_authorizing') return 'Requesting signaling authority';
      if (key === 'subsessionBar.daemon_details_direct_stage_offer') return 'Creating browser offer';
      if (key === 'subsessionBar.daemon_details_direct_stage_candidates') return 'Exchanging SDP / ICE candidates';
      if (key === 'subsessionBar.daemon_details_direct_stage_checking') return 'Checking ICE connectivity';
      if (key === 'subsessionBar.daemon_details_direct_stage_channel') return 'DataChannel open';
      if (key === 'subsessionBar.daemon_details_direct_stage_verifying') return 'Verifying probe round trip';
      if (key === 'subsessionBar.daemon_details_direct_stage_complete') return 'Probe complete';
      if (key === 'subsessionBar.daemon_details_direct_endpoint_private') return 'Private / routed';
      if (key === 'subsessionBar.daemon_details_direct_endpoint_public') return 'Public direct';
      if (key === 'subsessionBar.daemon_details_direct_endpoint_nat') return 'NAT mapped';
      if (key === 'subsessionBar.daemon_details_direct_endpoint_prflx') return 'Peer-reflexive mapping';
      if (key === 'subsessionBar.daemon_details_direct_endpoint_relay') return 'TURN relay';
      if (key === 'subsessionBar.daemon_details_direct_endpoint_host') return 'Host candidates';
      if (key === 'subsessionBar.daemon_details_direct_endpoint_unknown') return 'Unknown';
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
  SubSessionCard: ({ sub, accentColor, sequenceNumber }: { sub: SubSession; accentColor?: string; sequenceNumber?: number }) => (
    <div
      data-testid={`subsession-preview-${sub.id}`}
      style={{ '--subsession-accent-color': accentColor } as any}
    >
      {typeof sequenceNumber === 'number' && sequenceNumber > 0 ? (
        <sup class="subcard-seq" data-testid={`subsession-seq-${sub.id}`}>{sequenceNumber}</sup>
      ) : null}
    </div>
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

vi.mock('../../src/direct-file-transfer.js', () => ({
  DirectFileTransferFailure: class DirectFileTransferFailure extends Error {
    constructor(readonly code: string) { super(code); }
  },
  probeDirectConnectivity: probeDirectConnectivityMock,
  prewarmDirectFileLease: vi.fn(() => () => undefined),
  subscribeDirectFileConnectionStatus: vi.fn((_ws, _serverId, listener) => {
    directFileStatusListeners.add(listener);
    listener('none');
    return () => directFileStatusListeners.delete(listener);
  }),
}));

import { SubSessionBar as DefaultSubSessionBar } from '../../src/components/SubSessionBar.js';
import { reorderSubSessions } from '../../src/api.js';
import type { SubSession } from '../../src/hooks/useSubSessions.js';
import { SUBSESSION_ACCENT_COLORS } from '../../src/subsession-accent-colors.js';
import { SUPPORTED_LOCALES } from '../../src/i18n/locales/index.js';
import {
  SUBSESSION_DESKTOP_DOCK_SIDE,
  SUBSESSION_DESKTOP_LAYOUT,
} from '../../src/subsession-desktop-layout-preference.js';
import { TEAM_DISCUSSION_LAYOUT } from '../../src/team-discussion-layout-preference.js';

const LOCALE_DIR = join(process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web'), 'src/i18n/locales');

// Existing interaction fixtures explicitly exercise horizontal/expanded mode.
function SubSessionBar(props: ComponentProps<typeof DefaultSubSessionBar>) {
  return <DefaultSubSessionBar desktopLayout={SUBSESSION_DESKTOP_LAYOUT.HORIZONTAL} {...props} />;
}

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

function makeStatsWs(capabilities: string[] = []) {
  let handler: ((msg: any) => void) | null = null;
  const ws = {
    getDaemonCapabilitySnapshot: vi.fn(() => ({
      daemonId: 'daemon-1', capabilities, helloEpoch: 1, sentAt: Date.now(), observedAt: Date.now(),
    })),
    send: vi.fn(),
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
    localStorage.setItem('rcc_subcard_collapsed', 'false');
    vi.clearAllMocks();
    directFileStatusListeners.clear();
    probeDirectConnectivityMock.mockResolvedValue({
      route: 'lan_direct',
      rttMs: 1.4,
      localCandidate: { address: '192.168.2.145', port: 49153, type: 'host', transportType: 'udp' },
      remoteCandidate: { address: '192.168.2.59', port: 59074, type: 'prflx', transportType: 'udp' },
    });
  });

  it('defaults to left-docked vertical pills while preserving explicit expanded preference', () => {
    localStorage.removeItem('rcc_subcard_collapsed');
    const host = document.createElement('aside');
    document.body.appendChild(host);
    const props = {
      subSessions: [makeSubSession()], openIds: new Set<string>(),
      onOpen: vi.fn(), onClose: vi.fn(), onRestart: vi.fn(),
      ws: null, connected: true, onDiff: vi.fn(), onHistory: vi.fn(),
      verticalRailHost: host, onDesktopDockSideChange: vi.fn(),
    };
    try {
      const view = render(<DefaultSubSessionBar {...props} />);
      expect(host.querySelector('.subsession-card-rail')).toBeTruthy();
      expect(host.querySelector('[data-testid="subsession-vertical-rail-dock-left"]')?.getAttribute('aria-pressed')).toBe('true');
      expect(JSON.parse(localStorage.getItem('rcc_subcard_collapsed')!)).toBe(true);
      view.unmount();
      localStorage.setItem('rcc_subcard_collapsed', 'false');
      const expanded = render(<DefaultSubSessionBar {...props} />);
      expect(expanded.getByTestId('subsession-preview-sub-1')).toBeTruthy();
      expect(JSON.parse(localStorage.getItem('rcc_subcard_collapsed')!)).toBe(false);
      expanded.unmount();
    } finally { host.remove(); }
  });

  it('caps compact model labels without shortening the identity or context', () => {
    const sub = makeSubSession({ type: 'gemini', activeModel: 'gemini-4-argon-high' });
    const props = {
      subSessions: [sub], openIds: new Set<string>(), collapsed: true,
      desktopLayoutCapable: false, onOpen: vi.fn(), onClose: vi.fn(),
      onRestart: vi.fn(), onNew: vi.fn(), ws: null, connected: true,
      onDiff: vi.fn(), onHistory: vi.fn(),
      subUsages: new Map([[sub.sessionName, { inputTokens: 100_000, cacheTokens: 0, contextWindow: 1_000_000, model: 'gemini-4-argon-high' }]]),
    };
    const view = render(<SubSessionBar {...props} />);
    expect(view.container.querySelector('.subsession-card-model')?.textContent).toBe('ar.n-high');
    expect(view.container.querySelector('.subsession-card-model')?.getAttribute('title')).toContain('gemini-4-argon-high');
    expect((view.container.querySelector('.subsession-card') as HTMLButtonElement).title).toContain('gemini-4-argon-high');
    expect((view.container.querySelector('.subsession-card') as HTMLButtonElement).title).toContain('ctx 10%');
    expect(sub.activeModel).toBe('gemini-4-argon-high');
    view.rerender(<SubSessionBar {...props} subSessions={[{ ...sub, activeModel: 'gpt-6.1-sol' }]} />);
    expect(view.container.querySelector('.subsession-card-model')?.textContent).toBe('6.1-sol');
    view.rerender(<SubSessionBar {...props} subSessions={[{ ...sub, activeModel: 'opus[1M]' }]} subUsages={new Map([[sub.sessionName, { inputTokens: 100_000, cacheTokens: 0, contextWindow: 1_000_000, model: 'claude-opus-4-8' }]])} />);
    expect(view.container.querySelector('.subsession-card-model')?.textContent).toBe('opus-4.8');
    expect(view.container.querySelector('.subsession-card-model')?.getAttribute('title')).toContain('claude-opus-4-8');
    view.rerender(<SubSessionBar {...props} subSessions={[{ ...sub, activeModel: null }]} subUsages={undefined} />);
    expect(view.container.querySelector('.subsession-card-model')).toBeNull();
    view.rerender(<SubSessionBar {...props} subSessions={[{ ...sub, activeModel: null }]} />);
    expect(view.container.querySelector('.subsession-card-model')?.textContent).toBe('ar.n-high');
    view.rerender(
      <SubSessionBar
        {...props}
        subSessions={[{ ...sub, requestedModel: 'gemini-4-hydrogen-high', activeModel: 'gemini-4-hydrogen-high' }]}
        subUsages={new Map([[sub.sessionName, { inputTokens: 100_000, cacheTokens: 0, contextWindow: 1_000_000, model: 'gemini-2.5-pro' }]])}
      />,
    );
    expect(view.container.querySelector('.subsession-card-model')?.textContent).toBe('hy.n-high');
    expect(view.container.querySelector('.subsession-card-model')?.getAttribute('title')).toBe('gemini-4-hydrogen-high · gemini-2.5-pro');
    expect((view.container.querySelector('.subsession-card') as HTMLButtonElement).title).toContain('gemini-4-hydrogen-high · gemini-2.5-pro');

    const cssPath = join(process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web'), 'src/styles.css');
    const css = readFileSync(cssPath, 'utf8');
    const cardModelRule = /^\.subsession-card-model \{([^}]*)\}/m.exec(css)?.[1] ?? '';
    expect(cardModelRule).toMatch(/white-space:\s*nowrap/);
    expect(cardModelRule).toMatch(/overflow:\s*hidden/);
    expect(cardModelRule).toMatch(/max-width:\s*100%/);
    expect(cardModelRule).toMatch(/margin-left:\s*0/);
  });

  it('shows gray, green, and yellow daemon-bar connection states from the live broker', async () => {
    const statsWs = makeStatsWs();
    const view = render(
      <SubSessionBar
        subSessions={[makeSubSession()]}
        openIds={new Set()}
        collapsed={false}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        ws={statsWs.ws as any}
        serverId="srv-1"
        connected
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );
    act(() => statsWs.emit(daemonStatsMessage));

    const dot = await waitFor(() => view.getByTestId('daemon-file-connection-status'));
    expect(dot.getAttribute('data-status')).toBe('none');
    expect(dot.getAttribute('title')).toBe('Not connected');

    act(() => directFileStatusListeners.forEach((listener) => listener('direct')));
    expect(dot.getAttribute('data-status')).toBe('direct');
    expect(dot.getAttribute('title')).toBe('Direct link');

    act(() => directFileStatusListeners.forEach((listener) => listener('relay')));
    expect(dot.getAttribute('data-status')).toBe('relay');
    expect(dot.getAttribute('title')).toBe('Relay');
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

  it('auto-probes direct connectivity in daemon details and supports a manual refresh', async () => {
    const statsWs = makeStatsWs(['file.transfer.direct.lease.v2']);
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
      statsWs.emit({
        ...daemonStatsMessage,
        directConnectivity: { state: 'available' },
      });
    });
    fireEvent.click(view.getByRole('button', { name: 'Show daemon details' }));

    await waitFor(() => expect(probeDirectConnectivityMock).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const text = view.getByRole('dialog', { name: 'Daemon status' }).textContent ?? '';
      expect(text).toContain('LAN direct · 1.4 ms');
      expect(text).toContain('Current step7/7 · Probe complete');
      expect(text).toContain('Browser network (inferred)Peer-reflexive mapping');
      expect(text).toContain('Daemon network (inferred)Private / routed');
      expect(text).toContain('Technical details');
      expect(text).toContain('PRFLX · 192.168.2.59:59074');
      expect(text).toContain('HOST · 192.168.2.145:49153');
      expect(text).toContain('Candidate inference only');
    });
    const technicalDetails = view.getByRole('dialog', { name: 'Daemon status' }).querySelector('details');
    expect(technicalDetails).not.toBeNull();
    expect(technicalDetails?.open).toBe(false);
    fireEvent.click(view.getByText('Technical details'));
    expect(technicalDetails?.open).toBe(true);
    fireEvent.click(view.getByRole('button', { name: 'Test direct connectivity' }));
    await waitFor(() => expect(probeDirectConnectivityMock).toHaveBeenCalledTimes(2));
  });

  it('shows the live signaling stage and candidate inference before the probe finishes', async () => {
    let finishProbe!: (value: unknown) => void;
    probeDirectConnectivityMock.mockImplementationOnce((_ws, onDiagnostics) => {
      onDiagnostics?.({
        stage: 'checking',
        browserCandidateTypes: ['srflx'],
        daemonCandidateTypes: ['host'],
      });
      return new Promise((resolve) => { finishProbe = resolve; });
    });
    const statsWs = makeStatsWs(['file.transfer.direct.lease.v2']);
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
      statsWs.emit({ ...daemonStatsMessage, directConnectivity: { state: 'available' } });
    });
    fireEvent.click(view.getByRole('button', { name: 'Show daemon details' }));

    await waitFor(() => {
      const text = view.getByTestId('direct-connectivity-diagnostics').textContent ?? '';
      expect(text).toContain('Current step4/7 · Checking ICE connectivity');
      expect(text).toContain('Browser network (inferred)NAT mapped');
      expect(text).toContain('Daemon network (inferred)Host candidates');
      expect(text).toContain('Technical details');
      expect(text).toContain('SRFLX');
      expect(text).toContain('HOST');
    });

    act(() => {
      finishProbe({
        route: 'lan_direct',
        rttMs: 1.4,
        localCandidate: { address: '192.168.2.145', port: 49153, type: 'host', transportType: 'udp' },
        remoteCandidate: { address: '192.168.2.59', port: 59074, type: 'prflx', transportType: 'udp' },
      });
    });
    await waitFor(() => expect(view.getByTestId('direct-connectivity-diagnostics').textContent).toContain('Probe complete'));
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
    expect(idleCard.querySelector('.subcard-running')).toBeNull();
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
    // tsk_5zv: running must not be conveyed by animation alone. Under
    // prefers-reduced-motion the marquee stops, so the collapsed/rail button
    // needs a static running mark exactly like the expanded card has.
    expect(runningCard.querySelector('.subcard-running')).not.toBeNull();
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

  it('persists quick-closed windows per main session so refresh can restore them', () => {
    const onCloseAllOpen = vi.fn();
    const subSessions = [
      makeSubSession({ id: 'sub-a', sessionName: 'deck_sub_sub-a', label: 'a' }),
      makeSubSession({ id: 'sub-b', sessionName: 'deck_sub_sub-b', label: 'b' }),
    ];

    const firstView = render(
      <SubSessionBar
        subSessions={subSessions}
        openIds={new Set(['sub-a', 'sub-b'])}
        collapsed={true}
        desktopLayoutCapable={true}
        serverId="srv-1"
        quickClosePersistenceScope="deck_alpha_brain"
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onCloseAllOpen={onCloseAllOpen}
        onRestoreQuickClosed={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    fireEvent.click(firstView.container.querySelector('.subsession-close-all-strip') as HTMLButtonElement);
    expect(onCloseAllOpen).toHaveBeenCalledTimes(1);
    firstView.unmount();

    const otherSession = render(
      <SubSessionBar
        subSessions={subSessions}
        openIds={new Set()}
        collapsed={true}
        desktopLayoutCapable={true}
        serverId="srv-1"
        quickClosePersistenceScope="deck_beta_brain"
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
    expect((otherSession.container.querySelector('.subsession-close-all-strip') as HTMLButtonElement).disabled).toBe(true);
    otherSession.unmount();

    const onRestoreQuickClosed = vi.fn();
    const refreshedView = render(
      <SubSessionBar
        subSessions={subSessions}
        openIds={new Set()}
        collapsed={true}
        desktopLayoutCapable={true}
        serverId="srv-1"
        quickClosePersistenceScope="deck_alpha_brain"
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onCloseAllOpen={vi.fn()}
        onRestoreQuickClosed={onRestoreQuickClosed}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    const restoreStrip = refreshedView.container.querySelector('.subsession-close-all-strip') as HTMLButtonElement;
    expect(restoreStrip.disabled).toBe(false);
    expect(restoreStrip.getAttribute('aria-label')).toBe('subsessionBar.restore_quick_closed');
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

  it('portals Team discussions into a compact right rail and exposes both layout choices', () => {
    const host = document.createElement('aside');
    document.body.append(host);
    const onTeamDiscussionLayoutChange = vi.fn();
    const discussion = {
      id: 'p2p_run_rail',
      topic: 'Responsive Team audit',
      state: 'running',
      currentRound: 1,
      maxRounds: 2,
      completedHops: 0,
      totalHops: 2,
    };

    try {
      const view = render(
        <SubSessionBar
          subSessions={[makeSubSession()]}
          openIds={new Set()}
          desktopLayoutCapable
          teamDiscussionLayout={TEAM_DISCUSSION_LAYOUT.RIGHT}
          onTeamDiscussionLayoutChange={onTeamDiscussionLayoutChange}
          teamDiscussionRailHost={host}
          discussions={[discussion]}
          onOpen={vi.fn()}
          onClose={vi.fn()}
          onRestart={vi.fn()}
          ws={null}
          connected
          onDiff={vi.fn()}
          onHistory={vi.fn()}
        />,
      );

      expect(view.queryByTestId('team-discussion-bottom')).toBeNull();
      expect(host.querySelector('[data-testid="team-discussion-rail"]')).toBeTruthy();
      expect(host.querySelector('[data-testid="team-discussion-rail-scroll"]')).toBeTruthy();
      expect(host.querySelector('[data-testid="p2p-progress-card"]')?.getAttribute('data-ultra-compact')).toBe('true');
      expect(host.querySelector('[data-testid="team-discussion-layout-right"]')?.getAttribute('aria-pressed')).toBe('true');

      fireEvent.click(host.querySelector('[data-testid="team-discussion-layout-bottom"]')!);
      expect(onTeamDiscussionLayoutChange).toHaveBeenCalledWith(TEAM_DISCUSSION_LAYOUT.BOTTOM);
    } finally {
      host.remove();
    }
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


  function touchReorderSessions() {
    return [
      makeSubSession({ id: 'sub-a', sessionName: 'deck_sub_sub-a', label: 'a' }),
      makeSubSession({ id: 'sub-b', sessionName: 'deck_sub_sub-b', label: 'b' }),
    ];
  }

  function renderTouchReorderBar(subSessions = touchReorderSessions()) {
    const onOpen = vi.fn();
    const props = {
      subSessions, openIds: new Set<string>(), collapsed: true, desktopLayoutCapable: false,
      serverId: 'srv-1', onOpen, onClose: vi.fn(), onRestart: vi.fn(), onNew: vi.fn(),
      ws: null, connected: true, onDiff: vi.fn(), onHistory: vi.fn(),
    };
    const view = render(<SubSessionBar {...props} />);
    return {
      ...view, onOpen,
      updateSessions: (next: SubSession[], serverId = props.serverId) =>
        view.rerender(<SubSessionBar {...props} subSessions={next} serverId={serverId} />),
      first: view.container.querySelector('[data-sub-id="sub-a"]') as HTMLElement,
      bar: view.container.querySelector('.subsession-bar') as HTMLElement,
    };
  }

  it.each([true, false])('binds long-press reorder when the compact bar mounts after loading or removal (initially empty: %s)', (initiallyEmpty) => {
    vi.useFakeTimers();
    const view = renderTouchReorderBar(initiallyEmpty ? [] : touchReorderSessions());
    if (!initiallyEmpty) {
      fireEvent.touchStart(view.first, { touches: [{ clientX: 10, clientY: 10 }] });
      act(() => { vi.advanceTimersByTime(200); });
      view.updateSessions([]);
    }
    act(() => { vi.advanceTimersByTime(500); });
    if (view.first) expect(view.first.style.transform).toBe('');

    view.updateSessions(touchReorderSessions());
    const first = view.container.querySelector('[data-sub-id="sub-a"]') as HTMLElement;
    const second = view.container.querySelector('[data-sub-id="sub-b"]') as HTMLElement;
    const bar = view.container.querySelector('.subsession-bar') as HTMLElement;
    if (view.bar) expect(bar).not.toBe(view.bar);
    Object.defineProperty(bar, 'scrollWidth', { configurable: true, value: 600 });
    Object.defineProperty(bar, 'clientWidth', { configurable: true, value: 200 });
    bar.scrollLeft = 200;

    // A newly mounted bar must still allow an ordinary swipe, never reorder it.
    fireEvent.touchStart(first, { touches: [{ clientX: 10, clientY: 10 }] });
    const swipe = new Event('touchmove', { bubbles: true, cancelable: true });
    Object.defineProperty(swipe, 'touches', { value: [{ clientX: 60, clientY: 10 }] });
    fireEvent(first, swipe);
    expect(swipe.defaultPrevented).toBe(false);
    act(() => { vi.advanceTimersByTime(500); });
    expect(first.style.transform).toBe('');
    fireEvent.touchEnd(first);
    fireEvent.click(first);
    expect(view.onOpen).not.toHaveBeenCalled();

    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => second) });
    try {
      fireEvent.touchStart(first, { touches: [{ clientX: 10, clientY: 10 }] });
      act(() => { vi.advanceTimersByTime(399); });
      expect(first.style.transform).toBe('');
      act(() => { vi.advanceTimersByTime(1); });
      expect(first.style.transform).toBe('scale(1.18)');
      expect(first.style.borderColor).toBe('rgb(245, 158, 11)');
      expect(bar.style.overflowX).toBe('hidden');
      fireEvent.touchMove(first, { touches: [{ clientX: 20, clientY: 10 }] });
      expect(Array.from(bar.querySelectorAll<HTMLElement>('[data-sub-id]')).map((el) => el.dataset.subId))
        .toEqual(['sub-b', 'sub-a']);
      fireEvent.touchEnd(first);
      fireEvent.click(first);
      act(() => { vi.advanceTimersByTime(151); });
      expect(vi.mocked(reorderSubSessions)).toHaveBeenCalledExactlyOnceWith('srv-1', ['sub-b', 'sub-a']);
      expect(view.onOpen).not.toHaveBeenCalled();
      expect(first.style.transform).toBe('');
      expect(bar.style.overflowX).toBe('');
    } finally {
      Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: originalElementFromPoint });
    }
  });

  it('keeps a pending hold across status updates but cancels it when switching server', () => {
    vi.useFakeTimers();
    const view = renderTouchReorderBar();
    fireEvent.touchStart(view.first, { touches: [{ clientX: 10, clientY: 10 }] });
    act(() => { vi.advanceTimersByTime(200); });
    view.updateSessions(touchReorderSessions().map((sub) => ({ ...sub, state: 'running' })));
    act(() => { vi.advanceTimersByTime(200); });
    expect(view.first.style.transform).toBe('scale(1.18)');
    view.updateSessions(touchReorderSessions(), 'srv-2');
    expect(view.first.style.transform).toBe('');
    expect(view.bar.style.overflowX).toBe('');
    act(() => { vi.advanceTimersByTime(500); });
    expect(view.first.style.transform).toBe('');
    expect(vi.mocked(reorderSubSessions)).not.toHaveBeenCalled();
  });

  it.each([[70, 10], [-70, 10], [10, 70]])('keeps a pre-hold swipe scrollable without reorder or a ghost click (%s,%s)', (x, y) => {
    vi.useFakeTimers();
    const { first, bar, onOpen, container } = renderTouchReorderBar();
    Object.defineProperty(bar, 'scrollWidth', { configurable: true, value: 600 });
    Object.defineProperty(bar, 'clientWidth', { configurable: true, value: 200 });
    bar.scrollLeft = 200; // Neither edge: the separate overscroll guard must not intercept.
    fireEvent.touchStart(first, { touches: [{ clientX: 10, clientY: 10 }] });
    const move = new Event('touchmove', { bubbles: true, cancelable: true });
    Object.defineProperty(move, 'touches', { value: [{ clientX: x, clientY: y }] });
    fireEvent(first, move);
    expect(move.defaultPrevented).toBe(false);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(bar.style.overflowX).toBe('');
    expect(first.style.transform).toBe('');
    fireEvent.touchEnd(first);
    fireEvent.click(first);
    expect(onOpen).not.toHaveBeenCalled();
    expect(Array.from(container.querySelectorAll('.subsession-card')).map((el) => (el as HTMLElement).dataset.subId))
      .toEqual(['sub-a', 'sub-b']);
    expect(vi.mocked(reorderSubSessions)).not.toHaveBeenCalled();
  });

  it('arms reorder only after a stationary hold and tolerates small finger jitter', () => {
    vi.useFakeTimers();
    const { first, bar, onOpen } = renderTouchReorderBar();
    fireEvent.touchStart(first, { touches: [{ clientX: 10, clientY: 10 }] });
    fireEvent.touchMove(first, { touches: [{ clientX: 12, clientY: 12 }] });
    act(() => { vi.advanceTimersByTime(399); });
    expect(bar.style.overflowX).toBe('');
    act(() => { vi.advanceTimersByTime(1); });
    expect(bar.style.overflowX).toBe('hidden');
    fireEvent.touchEnd(first);
    act(() => { vi.advanceTimersByTime(1); });
    fireEvent.click(first);
    expect(bar.style.overflowX).toBe('');
    expect(onOpen).not.toHaveBeenCalled();
    expect(vi.mocked(reorderSubSessions)).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'scroll', 'unmount', 'multitouch'])('cancels pending reorder on %s', (reason) => {
    vi.useFakeTimers();
    const { first, bar, onOpen, unmount } = renderTouchReorderBar();
    fireEvent.touchStart(first, { touches: [{ clientX: 10, clientY: 10 }] });
    act(() => { vi.advanceTimersByTime(200); });
    if (reason === 'cancel') fireEvent.touchCancel(first);
    if (reason === 'scroll') fireEvent.scroll(bar);
    if (reason === 'unmount') unmount();
    if (reason === 'multitouch') fireEvent.touchStart(first, { touches: [
      { clientX: 10, clientY: 10 }, { clientX: 20, clientY: 20 },
    ] });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(bar.style.overflowX).toBe('');
    expect(first.style.transform).toBe('');
    expect(onOpen).not.toHaveBeenCalled();
    expect(vi.mocked(reorderSubSessions)).not.toHaveBeenCalled();
  });

  it('keeps a short tap opening the sub-session and clears its hold timer', () => {
    vi.useFakeTimers();
    const { first, bar, onOpen } = renderTouchReorderBar();
    fireEvent.touchStart(first, { touches: [{ clientX: 10, clientY: 10 }] });
    act(() => { vi.advanceTimersByTime(150); });
    fireEvent.touchEnd(first);
    act(() => { vi.advanceTimersByTime(500); });
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith('sub-a');
    expect(bar.style.overflowX).toBe('');
    expect(vi.mocked(reorderSubSessions)).not.toHaveBeenCalled();
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
      act(() => { vi.advanceTimersByTime(401); });
      fireEvent.touchMove(first, { touches: [{ clientX: 20, clientY: 10 }] });

      await act(async () => { await Promise.resolve(); });
      expect(Array.from(view.container.querySelectorAll('.subsession-card')).map((node) => (node as HTMLElement).dataset.subId)).toEqual(['sub-b', 'sub-a']);
      expect(onVisualOrderChange).toHaveBeenLastCalledWith(['sub-b', 'sub-a']);
      expect(document.body.querySelector('[data-testid="subsession-context-menu"]')).toBeNull();

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

  it('fails safe when jsdom does not provide elementFromPoint during touch drag', async () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const subSessions = [
      makeSubSession({ id: 'sub-a', sessionName: 'deck_sub_sub-a', label: 'a' }),
      makeSubSession({ id: 'sub-b', sessionName: 'deck_sub_sub-b', label: 'b' }),
    ];
    const view = render(
      <SubSessionBar
        subSessions={subSessions}
        openIds={new Set()}
        collapsed
        desktopLayoutCapable={false}
        serverId="srv-1"
        onVisualOrderChange={vi.fn()}
        onOpen={onOpen}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );
    const first = view.container.querySelector('[data-sub-id="sub-a"]') as HTMLElement;
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: undefined });
    try {
      fireEvent.touchStart(first, { touches: [{ clientX: 10, clientY: 10 }] });
      act(() => { vi.advanceTimersByTime(401); });
      fireEvent.touchMove(first, { touches: [{ clientX: 20, clientY: 10 }] });
      await act(async () => { await Promise.resolve(); });
      fireEvent.touchEnd(first);
      act(() => { vi.advanceTimersByTime(151); });
      expect(onOpen).not.toHaveBeenCalled();
      expect(vi.mocked(reorderSubSessions)).toHaveBeenCalledWith('srv-1', ['sub-a', 'sub-b']);
    } finally {
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: originalElementFromPoint,
      });
    }
  });

  it('does not open a context menu on a stationary mobile long press', () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const view = render(
      <SubSessionBar
        subSessions={[makeSubSession({ id: 'sub-a', sessionName: 'deck_sub_sub-a', label: 'a' })]}
        openIds={new Set()}
        collapsed
        desktopLayoutCapable={false}
        onOpen={onOpen}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onRenameSubSession={vi.fn()}
        onToggleSubSessionPin={vi.fn()}
        pinnedSubSessionIds={new Set()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );
    const button = view.container.querySelector('[data-sub-id="sub-a"]') as HTMLElement;
    fireEvent.touchStart(button, { touches: [{ clientX: 40, clientY: 50 }] });
    act(() => { vi.advanceTimersByTime(401); });
    expect(document.body.querySelector('[data-testid="subsession-context-menu"]')).toBeNull();
    fireEvent.touchEnd(button);
    expect(onOpen).not.toHaveBeenCalled();
    expect(vi.mocked(reorderSubSessions)).not.toHaveBeenCalled();
  });

  it('does not open a mobile context menu from a contextmenu event', () => {
    vi.useFakeTimers();
    const view = render(
      <SubSessionBar
        subSessions={[makeSubSession({ id: 'sub-a', sessionName: 'deck_sub_sub-a', label: 'a' })]}
        openIds={new Set()}
        collapsed
        desktopLayoutCapable={false}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onRenameSubSession={vi.fn()}
        onToggleSubSessionPin={vi.fn()}
        pinnedSubSessionIds={new Set()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );
    const button = view.container.querySelector('[data-sub-id="sub-a"]') as HTMLElement;
    fireEvent.contextMenu(button, { clientX: 40, clientY: 50 });
    expect(document.body.querySelector('[data-testid="subsession-context-menu"]')).toBeNull();
    view.unmount();
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

  it('opens a context menu for compact buttons without opening the sub-session', () => {
    const onOpen = vi.fn();
    const onRename = vi.fn();
    const onTogglePin = vi.fn();
    const view = render(
      <SubSessionBar
        subSessions={[makeSubSession()]}
        openIds={new Set()}
        collapsed
        onOpen={onOpen}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onRenameSubSession={onRename}
        onToggleSubSessionPin={onTogglePin}
        pinnedSubSessionIds={new Set()}
        ws={null}
        connected
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );
    const button = view.container.querySelector('[data-sub-id="sub-1"]') as HTMLButtonElement;
    fireEvent.contextMenu(button, { clientX: 9999, clientY: 9999 });
    expect(document.body.querySelector('[data-testid="subsession-context-menu"]')).not.toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(document.body.querySelector('[data-testid="subsession-context-pin"]') as HTMLButtonElement);
    expect(onTogglePin).toHaveBeenCalledWith('sub-1');
  });

  it('renders pinned compact sessions before unpinned sessions and supports rename', () => {
    const onRename = vi.fn();
    vi.stubGlobal('prompt', vi.fn(() => 'renamed'));
    const view = render(
      <SubSessionBar
        subSessions={[makeSubSession({ id: 'sub-a', sessionName: 'deck_sub_a' }), makeSubSession({ id: 'sub-b', sessionName: 'deck_sub_b' })]}
        openIds={new Set()}
        collapsed
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onRenameSubSession={onRename}
        pinnedSubSessionIds={new Set(['sub-b'])}
        ws={null}
        connected
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );
    expect(Array.from(view.container.querySelectorAll('[data-sub-id]')).map((node) => (node as HTMLElement).dataset.subId)).toEqual(['sub-b', 'sub-a']);
    fireEvent.contextMenu(view.container.querySelector('[data-sub-id="sub-b"]') as HTMLButtonElement, { clientX: 20, clientY: 20 });
    fireEvent.click(document.body.querySelector('[data-testid="subsession-context-rename"]') as HTMLButtonElement);
    expect(onRename).toHaveBeenCalledWith('sub-b', 'renamed');
    vi.unstubAllGlobals();
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

  describe('daemon status frames fold into the last snapshot', () => {
    const livenessFrame = {
      type: 'daemon.liveness',
      daemonVersion: '2026.5.2161-dev.7',
      mainEventLoopLagMs: 4,
      mainEventLoopBlockedMs: 30_000,
      mainEventLoopBusy: true,
    };

    function openDetails(view: ReturnType<typeof renderBarWithStats>) {
      fireEvent.click(view.getByLabelText('Show daemon details'));
      return view.getByRole('dialog');
    }

    it.each([['collapsed', true], ['expanded', false]] as const)(
      'keeps CPU, memory, load and uptime when liveness-only and number-less frames arrive (%s bar and detail card)',
      async (_label, collapsed) => {
        const statsWs = makeStatsWs();
        const view = renderBarWithStats(collapsed, statsWs);
        await waitFor(() => expect(statsWs.ws.onMessage).toHaveBeenCalled());
        act(() => { statsWs.emit(daemonStatsMessage); });
        const before = view.container.querySelector('.daemon-stats-inline')!.textContent;

        // The frame the link worker's heartbeat becomes, and what an older
        // server used to send in its place: stats with every number missing.
        act(() => { statsWs.emit(livenessFrame); });
        act(() => { statsWs.emit({ type: 'daemon.stats', daemonVersion: '2026.5.2161-dev.7' }); });
        act(() => { statsWs.emit({ ...daemonStatsMessage, cpu: undefined, memUsed: Number.NaN, load1: null, uptime: 'soon' }); });

        expect(view.container.querySelector('.daemon-stats-inline')!.textContent).toBe(before);
        const dialog = openDetails(view);
        const cards = dialog.querySelector('.daemon-details-grid')!.textContent!;
        expect(cards).toContain('2%');
        expect(cards).toContain('9.9 / 41.2 GB');
        expect(cards).toContain('0.8 / 0.7 / 0.6');
        expect(cards).toContain('1h');
        expect(view.container.textContent).not.toContain('NaN');
        expect(dialog.textContent).not.toContain('NaN');
      },
    );

    it.each([['collapsed', true], ['expanded', false]] as const)(
      'clears the memory-handle alert when a healthy full frame follows a failing one (%s bar)',
      async (_label, collapsed) => {
        const statsWs = makeStatsWs();
        const view = renderBarWithStats(collapsed, statsWs);
        await waitFor(() => expect(statsWs.ws.onMessage).toHaveBeenCalled());

        act(() => { statsWs.emit({ ...daemonStatsMessage, shortRefHealth: failingHealth }); });
        expect(view.container.querySelector('.daemon-stat-shortref-alert')).toBeTruthy();

        // The daemon only sends shortRefHealth while failing; recovery is the
        // field going missing from an otherwise full frame.
        act(() => { statsWs.emit(daemonStatsMessage); });
        expect(view.container.querySelector('.daemon-stat-shortref-alert')).toBeNull();

        // A number-less degraded frame must not resurrect or hide anything.
        act(() => { statsWs.emit({ ...daemonStatsMessage, shortRefHealth: failingHealth }); });
        act(() => { statsWs.emit({ type: 'daemon.stats', daemonVersion: '2026.5.2161-dev.7' }); });
        expect(view.container.querySelector('.daemon-stat-shortref-alert')).toBeTruthy();
      },
    );

    it('shows nothing from the previous server after the socket changes, until the new one reports', async () => {
      const first = makeStatsWs();
      const second = makeStatsWs();
      const props = {
        subSessions: [makeSubSession()],
        openIds: new Set<string>(),
        collapsed: false,
        desktopLayoutCapable: true,
        onOpen: vi.fn(),
        onClose: vi.fn(),
        onRestart: vi.fn(),
        onNew: vi.fn(),
        connected: true,
        onDiff: vi.fn(),
        onHistory: vi.fn(),
      };
      const view = render(<SubSessionBar {...props} ws={first.ws as any} serverId="srv-a" />);
      await waitFor(() => expect(first.ws.onMessage).toHaveBeenCalled());
      act(() => { first.emit({ ...daemonStatsMessage, shortRefHealth: failingHealth, disks: [{ mount: '/', totalBytes: 10 * 1024 ** 3, usedBytes: 5 * 1024 ** 3, usedPercent: 50 }] }); });
      expect(view.container.querySelector('.daemon-stats-inline')).toBeTruthy();
      expect(view.container.querySelector('.daemon-stat-shortref-alert')).toBeTruthy();
      expect(view.container.querySelector('.daemon-stat-disk')).toBeTruthy();

      view.rerender(<SubSessionBar {...props} ws={second.ws as any} serverId="srv-b" />);
      await waitFor(() => expect(second.ws.onMessage).toHaveBeenCalled());
      expect(view.container.querySelector('.daemon-stats-inline')).toBeNull();
      expect(view.container.querySelector('.daemon-stat-shortref-alert')).toBeNull();

      // The new server's first frame omits every optional object: none carried over.
      act(() => { second.emit(daemonStatsMessage); });
      expect(view.container.querySelector('.daemon-stats-inline')).toBeTruthy();
      expect(view.container.querySelector('.daemon-stat-shortref-alert')).toBeNull();
      expect(view.container.querySelector('.daemon-stat-disk')).toBeNull();
    });

    it('shows a placeholder, never NaN, while no full stats frame has arrived yet', async () => {
      const statsWs = makeStatsWs();
      const view = renderBarWithStats(false, statsWs);
      await waitFor(() => expect(statsWs.ws.onMessage).toHaveBeenCalled());

      act(() => { statsWs.emit(livenessFrame); });
      const strip = view.container.querySelector('.daemon-stats-inline')!;
      expect(strip.textContent).toContain('CPU —');
      expect(strip.textContent).not.toContain('NaN');

      const dialog = openDetails(view);
      const cards = dialog.querySelector('.daemon-details-grid')!.textContent!;
      expect(cards).not.toContain('NaN');
      expect(cards).toContain('—');
    });
  });

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
      'daemon_details_direct_connectivity',
      'daemon_connection_direct',
      'daemon_connection_relay',
      'daemon_connection_none',
      'daemon_details_direct_runtime_unavailable',
      'daemon_details_direct_probing',
      'daemon_details_direct_lan',
      'daemon_details_direct_ip',
      'daemon_details_direct_relay',
      'daemon_details_direct_timeout',
      'daemon_details_direct_signaling_failed',
      'daemon_details_direct_ice_failed',
      'daemon_details_direct_not_tested',
      'daemon_details_direct_refresh',
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

  it('renders one ordered compact button set in the desktop vertical rail and keeps its gestures', async () => {
    const host = document.createElement('aside');
    document.body.append(host);
    const onOpen = vi.fn();
    const onOpenMaximized = vi.fn();
    const onDesktopLayoutChange = vi.fn();
    const onDesktopDockSideChange = vi.fn();
    const sessions = [
      makeSubSession({ id: 'sub-1', sessionName: 'deck_sub_sub-1', label: 'first' }),
      makeSubSession({ id: 'sub-2', sessionName: 'deck_sub_sub-2', label: 'second' }),
    ];

    try {
      const view = render(
        <SubSessionBar
          subSessions={sessions}
          openIds={new Set()}
          collapsed={false}
          desktopLayoutCapable
          desktopLayout={SUBSESSION_DESKTOP_LAYOUT.VERTICAL}
          onDesktopLayoutChange={onDesktopLayoutChange}
          desktopDockSide={SUBSESSION_DESKTOP_DOCK_SIDE.LEFT}
          onDesktopDockSideChange={onDesktopDockSideChange}
          verticalRailHost={host}
          onOpen={onOpen}
          onOpenMaximized={onOpenMaximized}
          onClose={vi.fn()}
          onRestart={vi.fn()}
          ws={null}
          connected
          onDiff={vi.fn()}
          onHistory={vi.fn()}
          serverId="srv-1"
        />,
      );

      expect(view.container.querySelector('.subcard-scroll')).toBeNull();
      expect(view.container.querySelector('.subsession-bar')).toBeNull();
      expect(view.container.querySelectorAll('[data-sub-id]')).toHaveLength(0);
      expect(Array.from(host.querySelectorAll<HTMLElement>('[data-sub-id]')).map((node) => node.dataset.subId))
        .toEqual(['sub-1', 'sub-2']);
      expect(host.querySelectorAll('.subsession-card-rail')).toHaveLength(2);

      const dockGroup = host.querySelector('[role="group"]');
      expect(dockGroup?.getAttribute('aria-label')).toBe('subsessionBar.dock_side');
      const dockLeft = host.querySelector<HTMLButtonElement>('[data-testid="subsession-vertical-rail-dock-left"]')!;
      const dockRight = host.querySelector<HTMLButtonElement>('[data-testid="subsession-vertical-rail-dock-right"]')!;
      expect(dockLeft.getAttribute('aria-label')).toBe('subsessionBar.dock_left');
      expect(dockRight.getAttribute('aria-label')).toBe('subsessionBar.dock_right');
      expect(dockLeft.getAttribute('aria-pressed')).toBe('true');
      expect(dockRight.getAttribute('aria-pressed')).toBe('false');
      fireEvent.click(dockRight);
      expect(onDesktopDockSideChange).toHaveBeenCalledWith(SUBSESSION_DESKTOP_DOCK_SIDE.RIGHT);

      const toggle = view.getByTestId('subsession-desktop-layout-toggle');
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      expect(toggle.getAttribute('aria-label')).toBe('subsessionBar.switch_to_horizontal');
      expect(toggle.textContent).toBe('⇆');
      fireEvent.click(toggle);
      expect(onDesktopLayoutChange).toHaveBeenCalledWith(SUBSESSION_DESKTOP_LAYOUT.HORIZONTAL);

      fireEvent.dblClick(host.querySelector('[data-sub-id="sub-1"]')!);
      expect(onOpenMaximized).toHaveBeenCalledWith('sub-1');

      const first = host.querySelector('[data-sub-id="sub-1"]')!;
      const second = host.querySelector('[data-sub-id="sub-2"]')!;
      fireEvent.dragStart(first);
      fireEvent.dragOver(second);
      fireEvent.dragEnd(first);
      await waitFor(() => expect(reorderSubSessions).toHaveBeenCalledWith('srv-1', ['sub-2', 'sub-1']));
    } finally {
      host.remove();
    }
  });

  it('keeps mobile on the existing horizontal compact bar without rendering or toggling a desktop rail', () => {
    const host = document.createElement('aside');
    document.body.append(host);
    try {
      const view = render(
        <SubSessionBar
          subSessions={[makeSubSession()]}
          openIds={new Set()}
          collapsed
          desktopLayoutCapable={false}
          desktopLayout={SUBSESSION_DESKTOP_LAYOUT.VERTICAL}
          onDesktopLayoutChange={vi.fn()}
          desktopDockSide={SUBSESSION_DESKTOP_DOCK_SIDE.LEFT}
          onDesktopDockSideChange={vi.fn()}
          verticalRailHost={host}
          onOpen={vi.fn()}
          onClose={vi.fn()}
          onRestart={vi.fn()}
          ws={null}
          connected
          onDiff={vi.fn()}
          onHistory={vi.fn()}
        />,
      );

      expect(view.queryByTestId('subsession-desktop-layout-toggle')).toBeNull();
      expect(host.querySelector('[data-testid="subsession-vertical-rail"]')).toBeNull();
      expect(view.queryByTestId('subsession-vertical-rail-dock-left')).toBeNull();
      expect(view.container.querySelector('.subsession-bar [data-sub-id="sub-1"]')).toBeTruthy();
    } finally {
      host.remove();
    }
  });

  it('ships desktop layout labels in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const raw = JSON.parse(readFileSync(join(LOCALE_DIR, `${locale}.json`), 'utf8')) as Record<string, any>;
      for (const key of [
        'switch_to_vertical',
        'switch_to_horizontal',
        'vertical_rail',
        'dock_side',
        'dock_left',
        'dock_right',
        'team_layout',
        'team_dock_right',
        'team_dock_bottom',
        'team_right_rail',
      ]) {
        expect(raw.subsessionBar?.[key], `${locale}: subsessionBar.${key}`).toBeTruthy();
      }
      for (const key of [
        'title',
        'desc',
        'open_label',
        'modifiers_aria',
        'min_one_hint',
        'reset_aria',
      ]) {
        expect(raw.settings?.shortcuts?.subsession_quick?.[key], `${locale}: settings.shortcuts.subsession_quick.${key}`).toBeTruthy();
      }
      expect(raw.settings?.shortcuts?.actions?.subsession_close_all?.title, `${locale}: settings.shortcuts.actions.subsession_close_all.title`).toBeTruthy();
      expect(raw.settings?.shortcuts?.actions?.subsession_close_all?.desc, `${locale}: settings.shortcuts.actions.subsession_close_all.desc`).toBeTruthy();
    }
  });

  it('renders 1-based sequence badges across collapsed pills, vertical rail, overflow pills, expanded cards, and drag-reorder', () => {
    const twentySixSubs = Array.from({ length: 26 }, (_, idx) => makeSubSession({
      id: `seq-${idx + 1}`,
      sessionName: `deck_sub_seq_${idx + 1}`,
      label: `Sub ${idx + 1}`,
    }));
    const eightSubs = twentySixSubs.slice(0, 8);

    // Collapsed horizontal bar: 1..8
    const collapsedView = render(
      <SubSessionBar
        subSessions={eightSubs}
        openIds={new Set()}
        collapsed
        desktopLayoutCapable
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        ws={null}
        connected
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );
    eightSubs.forEach((sub, idx) => {
      const badge = collapsedView.getByTestId(`subsession-seq-${sub.id}`);
      expect(badge.tagName).toBe('SUP');
      expect(badge.classList.contains('subsession-card-seq')).toBe(true);
      expect(badge.textContent).toBe(String(idx + 1));
    });

    // Drag-reorder swaps seq-1 and seq-2 immediately -> badges update 1<->2
    const btn1 = collapsedView.container.querySelector('[data-sub-id="seq-1"]')!;
    const btn2 = collapsedView.container.querySelector('[data-sub-id="seq-2"]')!;
    fireEvent.dragStart(btn1);
    fireEvent.dragOver(btn2);
    expect(collapsedView.getByTestId('subsession-seq-seq-2').textContent).toBe('1');
    expect(collapsedView.getByTestId('subsession-seq-seq-1').textContent).toBe('2');
    collapsedView.unmount();

    // Vertical rail: 1..8
    const host = document.createElement('aside');
    document.body.append(host);
    try {
      const railView = render(
        <SubSessionBar
          subSessions={eightSubs}
          openIds={new Set()}
          collapsed
          desktopLayoutCapable
          desktopLayout={SUBSESSION_DESKTOP_LAYOUT.VERTICAL}
          verticalRailHost={host}
          onOpen={vi.fn()}
          onClose={vi.fn()}
          onRestart={vi.fn()}
          ws={null}
          connected
          onDiff={vi.fn()}
          onHistory={vi.fn()}
        />,
      );
      eightSubs.forEach((sub, idx) => {
        expect(host.querySelector(`[data-testid="subsession-seq-${sub.id}"]`)?.textContent).toBe(String(idx + 1));
      });
      railView.unmount();
    } finally {
      host.remove();
    }

    // Expanded mode with 26 sessions (> SUBSESSION_BAR_MAX_EXPANDED_CARDS=24): cards (1..24) + overflow pills (25, 26)
    const expandedView = render(
      <SubSessionBar
        subSessions={twentySixSubs}
        openIds={new Set()}
        collapsed={false}
        desktopLayoutCapable
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        ws={null}
        connected
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );
    twentySixSubs.forEach((sub, idx) => {
      const badge = expandedView.getByTestId(`subsession-seq-${sub.id}`);
      expect(badge.textContent).toBe(String(idx + 1));
    });
    expect(expandedView.getByTestId('subsession-overflow-pills').querySelector('[data-testid="subsession-seq-seq-25"]')?.textContent).toBe('25');
    expect(expandedView.getByTestId('subsession-overflow-pills').querySelector('[data-testid="subsession-seq-seq-26"]')?.textContent).toBe('26');
    expandedView.unmount();
  });

  it('renders a bottom-right T subscript on compact sub-session buttons for Team members without flowing p2p-tag', () => {
    const teamSub = makeSubSession({ id: 'team-1', sessionName: 'deck_sub_team-1', label: 'coder', activeModel: 'gpt-6.1-sol' });
    const soloSub = makeSubSession({ id: 'solo-2', sessionName: 'deck_sub_solo-2', label: 'helper', activeModel: 'gpt-6.1-sol' });
    const usageMap = new Map([
      ['deck_sub_team-1', { inputTokens: 120_000, cacheTokens: 0, contextWindow: 1_000_000, model: 'gpt-6.1-sol' }],
      ['deck_sub_solo-2', { inputTokens: 120_000, cacheTokens: 0, contextWindow: 1_000_000, model: 'gpt-6.1-sol' }],
    ]);
    const p2pSet = new Set([teamSub.sessionName]);

    const cssPath = join(process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web'), 'src/styles.css');
    const css = readFileSync(cssPath, 'utf8');
    const cardCssRules = [
      css.match(/\.subsession-card\s*\{[^}]*\}/)?.[0],
      css.match(/\.subsession-card-seq\s*\{[^}]*\}/)?.[0],
      css.match(/\.subsession-card-team\s*\{[^}]*\}/)?.[0],
      css.match(/\.subsession-card-rail\s*\{[^}]*\}/)?.[0],
    ].filter(Boolean).join('\n');
    const styleEl = document.createElement('style');
    styleEl.textContent = cardCssRules;
    document.head.appendChild(styleEl);
    try {
      // 1. Collapsed bottom bar (includes mobile class, seq badge, and ctx bar)
      const collapsedView = render(
        <SubSessionBar
          subSessions={[teamSub, soloSub]}
          openIds={new Set()}
          collapsed
          desktopLayoutCapable={false}
          onOpen={vi.fn()}
          onClose={vi.fn()}
          onRestart={vi.fn()}
          ws={null}
          connected
          onDiff={vi.fn()}
          onHistory={vi.fn()}
          p2pSessionLabels={p2pSet}
          subUsages={usageMap}
          sharedSubSessionStates={new Map([[teamSub.id, 'running' as any]])}
        />,
      );

      const teamBtn = collapsedView.container.querySelector('[data-sub-id="team-1"]') as HTMLButtonElement;
      const soloBtn = collapsedView.container.querySelector('[data-sub-id="solo-2"]') as HTMLButtonElement;
      expect(teamBtn).toBeTruthy();
      expect(soloBtn).toBeTruthy();

      // Team subscript replaces in-flow .p2p-tag on the button while keeping seq + ctx + accessibility labels
      expect(teamBtn.querySelector('.p2p-tag')).toBeNull();
      expect(soloBtn.querySelector('.p2p-tag')).toBeNull();
      const teamBadge = teamBtn.querySelector('[data-testid="subsession-team-team-1"]') as HTMLElement;
      expect(teamBadge).toBeTruthy();
      expect(teamBadge.tagName).toBe('SUB');
      expect(teamBadge.classList.contains('subsession-card-team')).toBe(true);
      expect(teamBadge.textContent?.trim()).toBe('T');
      expect(teamBadge.getAttribute('aria-hidden')).toBe('true');
      expect(soloBtn.querySelector('[data-testid="subsession-team-solo-2"]')).toBeNull();
      expect(teamBtn.querySelector('[data-testid="subsession-seq-team-1"]')?.textContent).toBe('1');
      expect(teamBtn.querySelector('.subsession-card-ctx')).toBeTruthy();
      expect(teamBtn.title).toContain('session.p2p_tag');
      expect(teamBtn.getAttribute('aria-label')).toContain('session.p2p_tag');
      expect(soloBtn.title).not.toContain('session.p2p_tag');

      // Computed style parity: Team subscript is out-of-flow (position: absolute) with zero card minHeight/padding delta
      const teamComputed = window.getComputedStyle(teamBtn);
      const soloComputed = window.getComputedStyle(soloBtn);
      const teamBadgeComputed = window.getComputedStyle(teamBadge);
      expect(teamBadgeComputed.position).toBe('absolute');
      expect(teamBadgeComputed.bottom).toBe('-4px');
      expect(teamBadgeComputed.right).toBe('-3px');
      expect(teamComputed.minHeight).toBe('54px');
      expect(teamComputed.minHeight).toBe(soloComputed.minHeight);
      expect(teamComputed.paddingTop).toBe(soloComputed.paddingTop);
      expect(teamComputed.paddingBottom).toBe(soloComputed.paddingBottom);
      expect(teamBtn.style.height).toBe('');
      expect(teamBtn.style.minHeight).toBe('');
      expect(teamBtn.style.padding).toBe('');
      expect(teamBtn.getAttribute('style')).toMatch(/^--subsession-accent-color:\s*#[0-9a-f]+;$/i);
      expect(soloBtn.getAttribute('style')).toMatch(/^--subsession-accent-color:\s*#[0-9a-f]+;$/i);
      expect(teamBtn.className).toBe(soloBtn.className);

      // Rerendering without p2p membership removes the T badge cleanly
      collapsedView.rerender(
        <SubSessionBar
          subSessions={[teamSub, soloSub]}
          openIds={new Set()}
          collapsed
          desktopLayoutCapable={false}
          onOpen={vi.fn()}
          onClose={vi.fn()}
          onRestart={vi.fn()}
          ws={null}
          connected
          onDiff={vi.fn()}
          onHistory={vi.fn()}
          p2pSessionLabels={new Set()}
          subUsages={usageMap}
        />,
      );
      expect(teamBtn.querySelector('[data-testid="subsession-team-team-1"]')).toBeNull();
      expect(teamBtn.getAttribute('aria-label')).toBeNull();
      collapsedView.unmount();

      // 2. Desktop vertical rail reuses CollapsedSubSessionButtonImpl (.subsession-card-rail)
      const railHost = document.createElement('aside');
      document.body.append(railHost);
      try {
        const railView = render(
          <SubSessionBar
            subSessions={[teamSub, soloSub]}
            openIds={new Set()}
            collapsed
            desktopLayoutCapable
            desktopLayout={SUBSESSION_DESKTOP_LAYOUT.VERTICAL}
            verticalRailHost={railHost}
            onOpen={vi.fn()}
            onClose={vi.fn()}
            onRestart={vi.fn()}
            ws={null}
            connected
            onDiff={vi.fn()}
            onHistory={vi.fn()}
            p2pSessionLabels={p2pSet}
            subUsages={usageMap}
          />,
        );
        const railTeamBtn = railHost.querySelector('[data-sub-id="team-1"]') as HTMLButtonElement;
        const railSoloBtn = railHost.querySelector('[data-sub-id="solo-2"]') as HTMLButtonElement;
        expect(railTeamBtn.classList.contains('subsession-card-rail')).toBe(true);
        expect(railTeamBtn.querySelector('.p2p-tag')).toBeNull();
        expect(railTeamBtn.querySelector('.subsession-card-team')?.textContent?.trim()).toBe('T');
        expect(railSoloBtn.querySelector('.subsession-card-team')).toBeNull();
        expect(railTeamBtn.className).toBe(railSoloBtn.className);
        const railTeamComputed = window.getComputedStyle(railTeamBtn);
        const railSoloComputed = window.getComputedStyle(railSoloBtn);
        expect(railTeamComputed.minHeight).toBe('48px');
        expect(railTeamComputed.minHeight).toBe(railSoloComputed.minHeight);
        expect(railTeamComputed.paddingTop).toBe(railSoloComputed.paddingTop);
        expect(railTeamComputed.paddingBottom).toBe(railSoloComputed.paddingBottom);
        railView.unmount();
      } finally {
        railHost.remove();
      }

      // 3. Expanded mode keeps overflow pill button compact with T, while placeholder cards retain .p2p-tag
      const twentySixSubs = Array.from({ length: 26 }, (_, idx) => makeSubSession({
        id: `exp-${idx + 1}`,
        sessionName: `deck_sub_exp-${idx + 1}`,
        label: `w-${idx + 1}`,
      }));
      const expandedView = render(
        <SubSessionBar
          subSessions={twentySixSubs}
          openIds={new Set(['exp-1'])}
          collapsed={false}
          desktopLayoutCapable
          onOpen={vi.fn()}
          onClose={vi.fn()}
          onRestart={vi.fn()}
          ws={null}
          connected
          onDiff={vi.fn()}
          onHistory={vi.fn()}
          p2pSessionLabels={new Set(['deck_sub_exp-24', 'deck_sub_exp-25'])}
        />,
      );
      const overflowBar = expandedView.getByTestId('subsession-overflow-pills');
      const overflowTeamBtn = overflowBar.querySelector('[data-sub-id="exp-25"]') as HTMLButtonElement;
      expect(overflowTeamBtn.querySelector('.p2p-tag')).toBeNull();
      expect(overflowTeamBtn.querySelector('.subsession-card-team')?.textContent?.trim()).toBe('T');
      expect(overflowBar.querySelector('[data-sub-id="exp-26"] .subsession-card-team')).toBeNull();
      // Placeholder card (non-button, unhydrated slot #24) still uses .p2p-tag
      const placeholder = expandedView.container.querySelector('.subcard-preview-placeholder .p2p-tag');
      expect(placeholder?.textContent).toBe('session.p2p_tag');
      expandedView.unmount();
    } finally {
      styleEl.remove();
    }
  });

  it('renders centered mobile footer status + build version below sub-sessions on mobile only and hides on desktop', () => {
    const prevBuildTime = (globalThis as { __BUILD_TIME__?: string }).__BUILD_TIME__;
    const sampleDate = new Date(2026, 10, 14, 22, 5, 0);
    Object.defineProperty(globalThis, '__BUILD_TIME__', {
      configurable: true,
      writable: true,
      value: sampleDate.toISOString(),
    });
    const sub = makeSubSession({ id: 'sub-footer', sessionName: 'deck_sub_footer', label: 'worker' });

    try {
      // 1. Mobile collapsed with sub-sessions -> footer renders after .subsession-row-with-close
      const collapsedMobile = render(
        <SubSessionBar
          subSessions={[sub]}
          openIds={new Set()}
          collapsed
          desktopLayoutCapable={false}
          daemonBadgeState="online"
          onOpen={vi.fn()}
          onClose={vi.fn()}
          onRestart={vi.fn()}
          ws={null}
          connected
          onDiff={vi.fn()}
          onHistory={vi.fn()}
        />,
      );
      const mobileBar = collapsedMobile.container.querySelector('.subcard-bar')!;
      expect(mobileBar.classList.contains('subcard-bar-mobile')).toBe(true);
      const row = mobileBar.querySelector('.subsession-row-with-close')!;
      const footer = collapsedMobile.getByTestId('mobile-subsession-footer-status');
      expect(footer.classList.contains('subcard-mobile-footer-status-inline')).toBe(false);
      expect(row.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const badge = collapsedMobile.getByTestId('mobile-subsession-footer-badge');
      expect(badge.classList.contains('badge-online')).toBe(true);
      expect(badge.textContent).toBe('● Online');
      expect(collapsedMobile.getByTestId('mobile-subsession-footer-version').textContent).toBe('v11/14 22:05');

      // Connecting & offline state transitions; collapsed empty embeds inline inside .subcard-toolbar
      collapsedMobile.rerender(
        <SubSessionBar
          subSessions={[sub]}
          openIds={new Set()}
          collapsed
          desktopLayoutCapable={false}
          daemonBadgeState="connecting"
          onOpen={vi.fn()}
          onClose={vi.fn()}
          onRestart={vi.fn()}
          ws={null}
          connected={false}
          onDiff={vi.fn()}
          onHistory={vi.fn()}
        />,
      );
      expect(collapsedMobile.getByTestId('mobile-subsession-footer-badge').classList.contains('badge-connecting')).toBe(true);
      expect(collapsedMobile.getByTestId('mobile-subsession-footer-badge').textContent).toContain('Connecting');

      collapsedMobile.rerender(
        <SubSessionBar
          subSessions={[]}
          openIds={new Set()}
          collapsed
          desktopLayoutCapable={false}
          daemonBadgeState="offline"
          onNew={vi.fn()}
          onOpen={vi.fn()}
          onClose={vi.fn()}
          onRestart={vi.fn()}
          ws={null}
          connected={false}
          onDiff={vi.fn()}
          onHistory={vi.fn()}
        />,
      );
      const emptyCollapsedFooter = collapsedMobile.getByTestId('mobile-subsession-footer-status');
      expect(emptyCollapsedFooter.classList.contains('subcard-mobile-footer-status-inline')).toBe(true);
      expect(collapsedMobile.container.querySelector('.subcard-toolbar')?.contains(emptyCollapsedFooter)).toBe(true);
      expect(collapsedMobile.getByTestId('mobile-subsession-footer-badge').classList.contains('badge-offline')).toBe(true);
      expect(collapsedMobile.getByTestId('mobile-subsession-footer-badge').textContent).toContain('Daemon Offline');

      // Expanded empty with onNew keeps .subcard-empty-state and renders centered bottom footer below it
      collapsedMobile.rerender(
        <SubSessionBar
          subSessions={[]}
          openIds={new Set()}
          collapsed={false}
          desktopLayoutCapable={false}
          daemonBadgeState="offline"
          onNew={vi.fn()}
          onOpen={vi.fn()}
          onClose={vi.fn()}
          onRestart={vi.fn()}
          ws={null}
          connected={false}
          onDiff={vi.fn()}
          onHistory={vi.fn()}
        />,
      );
      const emptyExpandedFooter = collapsedMobile.getByTestId('mobile-subsession-footer-status');
      expect(emptyExpandedFooter.classList.contains('subcard-mobile-footer-status-inline')).toBe(false);
      const emptyHint = collapsedMobile.container.querySelector('.subcard-empty-state')!;
      expect(emptyHint.compareDocumentPosition(emptyExpandedFooter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      collapsedMobile.unmount();

      // 2. Desktop horizontal & vertical rail -> never renders mobile footer status
      const desktopView = render(
        <SubSessionBar
          subSessions={[sub]}
          openIds={new Set()}
          collapsed={false}
          desktopLayoutCapable
          desktopLayout={SUBSESSION_DESKTOP_LAYOUT.HORIZONTAL}
          daemonBadgeState="online"
          onOpen={vi.fn()}
          onClose={vi.fn()}
          onRestart={vi.fn()}
          ws={null}
          connected
          onDiff={vi.fn()}
          onHistory={vi.fn()}
        />,
      );
      expect(desktopView.container.querySelector('.subcard-bar-mobile')).toBeNull();
      expect(desktopView.queryByTestId('mobile-subsession-footer-status')).toBeNull();
      desktopView.unmount();
    } finally {
      if (prevBuildTime === undefined) {
        delete (globalThis as { __BUILD_TIME__?: string }).__BUILD_TIME__;
      } else {
        Object.defineProperty(globalThis, '__BUILD_TIME__', {
          configurable: true,
          writable: true,
          value: prevBuildTime,
        });
      }
    }
  });

  it('adds .incognito class on SubSessionBar buttons and applies dashed border + distinct incognito control styles in CSS', () => {
    const cssPath = join(process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web'), 'src/styles.css');
    const css = readFileSync(cssPath, 'utf8');
    expect(css).toContain('.tab.incognito');
    expect(css).toContain('border-style: dashed');
    expect(css).toContain('.subsession-card.incognito');
    expect(css).toContain('.subsession-window.incognito');
    expect(css).toContain('.incognito-toggle-btn');
    expect(css).toContain('.incognito-launch-btn');

    const subs = [
      makeSubSession({ id: 'priv-bar', sessionName: 'deck_sub_priv-bar', label: 'priv-bar', incognito: true }),
      makeSubSession({ id: 'norm-bar', sessionName: 'deck_sub_norm-bar', label: 'norm-bar', incognito: false }),
    ];
    const view = render(
      <SubSessionBar
        subSessions={subs}
        openIds={new Set(['priv-bar'])}
        focusedSubId="priv-bar"
        collapsed={true}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        ws={null}
        connected
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );
    const privBtn = view.container.querySelector('.subsession-card[data-sub-id="priv-bar"]');
    const normBtn = view.container.querySelector('.subsession-card[data-sub-id="norm-bar"]');
    expect(privBtn?.classList.contains('incognito')).toBe(true);
    expect(privBtn?.classList.contains('open')).toBe(true);
    expect(privBtn?.classList.contains('focused')).toBe(true);
    expect(normBtn?.classList.contains('incognito')).toBe(false);
  });
});
