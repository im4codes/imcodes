export const REMOTE_DESKTOP_WALL_QUALIFICATION_BASELINE = {
  name: 'chromium-desktop-16stream-v1',
  browser: 'production Chromium',
  minimumLogicalCpu: 8,
  minimumRamGiB: 16,
  viewport: { width: 1920, height: 1080 },
  hardwareVideoDecode: true,
  steadyStateWindowMs: 5 * 60_000,
  tileProfile: { width: 640, height: 360, fps: 5 },
  promotedProfile: { width: 1280, height: 720, fps: 15 },
  minimumVisiblePaintedFps: 2,
  maximumFrameGapMs: 2_000,
  promotionDeadlineMs: 3_000,
  allTurnAggregateReceiveBitrateBps: 24_000_000,
  browserRssLimitBytes: Math.floor(1.5 * 1024 * 1024 * 1024),
  retainedHeapGrowthLimitBytes: 128 * 1024 * 1024,
  p95LongTaskLimitMs: 100,
  longTasksPerMinuteLimit: 10,
  maxSources: 16,
} as const;

export type RemoteDesktopWallRouteMode = 'direct' | 'all_turn';
export type RemoteDesktopWallRunKind = 'deterministic_fake_media' | 'real_browser_network';
export type QualificationGateStatus = 'passed' | 'failed' | 'unavailable';

export interface TileSourceMetric {
  hostId: string;
  visible: boolean;
  healthy: boolean;
  reportedLive: boolean;
  paintedFps: number;
  maxFrameGapMs: number;
  width: number;
  height: number;
  sourceFps: number;
  receiveBitrateBps: number;
  connectionCreations: number;
  pressurePaused: boolean;
}

export interface PromotionMetric {
  hostId: string;
  reachedAtMs: number;
  width: number;
  height: number;
  paintedFps: number;
  sessionCreations: number;
}

export interface ResourceMetric {
  browserRssBytes: number;
  retainedHeapGrowthBytes: number;
  longTaskDurationsMs: readonly number[];
}

export interface LifecycleEventMetric {
  kind: 'disconnect' | 'reconnect' | 'revoke' | 'cas_layout_change';
  hostId?: string;
  affectedHostIds: readonly string[];
  stoppedHostIds: readonly string[];
  activeConnectionCountByHost: Readonly<Record<string, number>>;
}

export interface WallQualificationRun {
  kind: RemoteDesktopWallRunKind;
  baselineName: typeof REMOTE_DESKTOP_WALL_QUALIFICATION_BASELINE.name;
  routeMode: RemoteDesktopWallRouteMode;
  durationMs: number;
  sources: readonly TileSourceMetric[];
  promotion: PromotionMetric;
  resources: ResourceMetric;
  lifecycleEvents: readonly LifecycleEventMetric[];
}

export interface QualificationGateResult {
  id: string;
  status: QualificationGateStatus;
  details: string;
}

export interface WallQualificationEvaluation {
  status: QualificationGateStatus;
  gates: readonly QualificationGateResult[];
  issues: readonly string[];
}

export interface RealEnvironmentProbe {
  chromiumBaselineName?: string;
  controlledSourceCount?: number;
  turnForced?: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
  logicalCpuCount?: number;
  ramGiB?: number;
  hardwareVideoDecode?: boolean;
}

function p95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

function gate(id: string, passed: boolean, details: string): QualificationGateResult {
  return { id, status: passed ? 'passed' : 'failed', details };
}

export function evaluateRemoteDesktopWallQualification(
  run: WallQualificationRun,
): WallQualificationEvaluation {
  const baseline = REMOTE_DESKTOP_WALL_QUALIFICATION_BASELINE;
  const gates: QualificationGateResult[] = [];
  const healthyVisible = run.sources.filter((source) => source.healthy && source.visible);
  const aggregateBitrate = run.sources.reduce((sum, source) => sum + source.receiveBitrateBps, 0);
  const longTaskP95 = p95(run.resources.longTaskDurationsMs);
  const longTaskRate = run.resources.longTaskDurationsMs.length / (run.durationMs / 60_000);

  gates.push(gate(
    'baseline.named_chromium',
    run.baselineName === baseline.name && run.durationMs >= baseline.steadyStateWindowMs,
    `${run.baselineName}, duration=${run.durationMs}ms`,
  ));
  gates.push(gate(
    'sources.count',
    [1, 4, 16].includes(run.sources.length),
    `sources=${run.sources.length}`,
  ));

  for (const source of healthyVisible) {
    gates.push(gate(
      `tile.${source.hostId}.painted_fps`,
      source.paintedFps >= baseline.minimumVisiblePaintedFps,
      `${source.paintedFps} painted FPS`,
    ));
    gates.push(gate(
      `tile.${source.hostId}.frame_gap`,
      source.maxFrameGapMs <= baseline.maximumFrameGapMs,
      `${source.maxFrameGapMs}ms max frame gap`,
    ));
    gates.push(gate(
      `tile.${source.hostId}.live_truthfulness`,
      !source.reportedLive || source.maxFrameGapMs <= baseline.maximumFrameGapMs,
      `reportedLive=${source.reportedLive}, maxFrameGapMs=${source.maxFrameGapMs}`,
    ));
    gates.push(gate(
      `tile.${source.hostId}.pressure_pause`,
      !source.pressurePaused,
      `pressurePaused=${source.pressurePaused}`,
    ));
    gates.push(gate(
      `tile.${source.hostId}.single_connection`,
      source.connectionCreations === 1,
      `connectionCreations=${source.connectionCreations}`,
    ));
  }

  gates.push(gate(
    'promotion.profile',
    run.promotion.reachedAtMs <= baseline.promotionDeadlineMs
      && run.promotion.width >= baseline.promotedProfile.width
      && run.promotion.height >= baseline.promotedProfile.height
      && run.promotion.paintedFps >= baseline.promotedProfile.fps,
    `reachedAtMs=${run.promotion.reachedAtMs}, ${run.promotion.width}x${run.promotion.height}@${run.promotion.paintedFps}`,
  ));
  gates.push(gate(
    'promotion.no_second_session',
    run.promotion.sessionCreations === 1,
    `sessionCreations=${run.promotion.sessionCreations}`,
  ));

  if (run.routeMode === 'all_turn') {
    gates.push(gate(
      'turn.all_16_sources_present',
      run.sources.length === baseline.maxSources && healthyVisible.length === baseline.maxSources,
      `sources=${run.sources.length}, healthyVisible=${healthyVisible.length}`,
    ));
    gates.push(gate(
      'turn.aggregate_receive_bitrate',
      aggregateBitrate <= baseline.allTurnAggregateReceiveBitrateBps,
      `${aggregateBitrate}bps`,
    ));
  }

  gates.push(gate(
    'resources.browser_rss',
    run.resources.browserRssBytes <= baseline.browserRssLimitBytes,
    `${run.resources.browserRssBytes} bytes`,
  ));
  gates.push(gate(
    'resources.retained_heap_growth',
    run.resources.retainedHeapGrowthBytes <= baseline.retainedHeapGrowthLimitBytes,
    `${run.resources.retainedHeapGrowthBytes} bytes`,
  ));
  gates.push(gate(
    'resources.long_task_p95',
    longTaskP95 <= baseline.p95LongTaskLimitMs,
    `${longTaskP95}ms`,
  ));
  gates.push(gate(
    'resources.long_tasks_per_minute',
    longTaskRate <= baseline.longTasksPerMinuteLimit,
    `${longTaskRate}/min`,
  ));

  for (const event of run.lifecycleEvents) {
    const stoppedUnexpectedHost = event.stoppedHostIds.find((hostId) => !event.affectedHostIds.includes(hostId));
    gates.push(gate(
      `lifecycle.${event.kind}.${event.hostId ?? 'wall'}.no_cross_host_teardown`,
      stoppedUnexpectedHost === undefined,
      stoppedUnexpectedHost === undefined ? 'no sibling stopped' : `unexpected stop: ${stoppedUnexpectedHost}`,
    ));
    const duplicate = Object.entries(event.activeConnectionCountByHost).find(([, count]) => count > 1);
    gates.push(gate(
      `lifecycle.${event.kind}.${event.hostId ?? 'wall'}.no_duplicate_connection`,
      duplicate === undefined,
      duplicate === undefined ? 'no duplicate active connection' : `${duplicate[0]}=${duplicate[1]}`,
    ));
  }

  const issues = gates
    .filter((entry) => entry.status === 'failed')
    .map((entry) => `${entry.id}: ${entry.details}`);
  return {
    status: issues.length === 0 ? 'passed' : 'failed',
    gates,
    issues,
  };
}

export function deterministicWallQualificationRun(options: {
  sourceCount: 1 | 4 | 16;
  routeMode: RemoteDesktopWallRouteMode;
}): WallQualificationRun {
  const baseline = REMOTE_DESKTOP_WALL_QUALIFICATION_BASELINE;
  const perSourceBitrate = options.routeMode === 'all_turn' ? 1_250_000 : 900_000;
  const sources = Array.from({ length: options.sourceCount }, (_, index): TileSourceMetric => ({
    hostId: `host-${String(index + 1).padStart(2, '0')}`,
    visible: true,
    healthy: true,
    reportedLive: true,
    paintedFps: 4.6,
    maxFrameGapMs: 1_000,
    width: baseline.tileProfile.width,
    height: baseline.tileProfile.height,
    sourceFps: baseline.tileProfile.fps,
    receiveBitrateBps: perSourceBitrate,
    connectionCreations: 1,
    pressurePaused: false,
  }));
  const activeConnectionCountByHost = Object.fromEntries(sources.map((source) => [source.hostId, 1]));
  return {
    kind: 'deterministic_fake_media',
    baselineName: baseline.name,
    routeMode: options.routeMode,
    durationMs: baseline.steadyStateWindowMs,
    sources,
    promotion: {
      hostId: sources[0]?.hostId ?? 'host-01',
      reachedAtMs: 2_400,
      width: baseline.promotedProfile.width,
      height: baseline.promotedProfile.height,
      paintedFps: baseline.promotedProfile.fps,
      sessionCreations: 1,
    },
    resources: {
      browserRssBytes: 1_120_000_000,
      retainedHeapGrowthBytes: 72 * 1024 * 1024,
      longTaskDurationsMs: [24, 31, 42, 57, 63, 72, 88, 92, 95, 96],
    },
    lifecycleEvents: [
      {
        kind: 'disconnect',
        hostId: 'host-03',
        affectedHostIds: ['host-03'],
        stoppedHostIds: [],
        activeConnectionCountByHost,
      },
      {
        kind: 'reconnect',
        hostId: 'host-03',
        affectedHostIds: ['host-03'],
        stoppedHostIds: [],
        activeConnectionCountByHost,
      },
      {
        kind: 'revoke',
        hostId: 'host-05',
        affectedHostIds: options.sourceCount >= 5 ? ['host-05'] : [],
        stoppedHostIds: options.sourceCount >= 5 ? ['host-05'] : [],
        activeConnectionCountByHost: options.sourceCount >= 5
          ? { ...activeConnectionCountByHost, 'host-05': 0 }
          : activeConnectionCountByHost,
      },
      {
        kind: 'cas_layout_change',
        affectedHostIds: [],
        stoppedHostIds: [],
        activeConnectionCountByHost,
      },
    ],
  };
}

export function evaluateRealQualificationEnvironment(
  probe: RealEnvironmentProbe,
  routeMode: RemoteDesktopWallRouteMode,
): QualificationGateResult {
  const baseline = REMOTE_DESKTOP_WALL_QUALIFICATION_BASELINE;
  const missing: string[] = [];
  if (probe.chromiumBaselineName !== baseline.name) missing.push(`baseline=${probe.chromiumBaselineName ?? 'unset'}`);
  if ((probe.controlledSourceCount ?? 0) < baseline.maxSources) missing.push(`controlledSourceCount=${probe.controlledSourceCount ?? 0}`);
  if (routeMode === 'all_turn' && probe.turnForced !== true) missing.push('turnForced=false');
  if ((probe.viewportWidth ?? 0) < baseline.viewport.width || (probe.viewportHeight ?? 0) < baseline.viewport.height) {
    missing.push(`viewport=${probe.viewportWidth ?? 0}x${probe.viewportHeight ?? 0}`);
  }
  if ((probe.logicalCpuCount ?? 0) < baseline.minimumLogicalCpu) missing.push(`logicalCpu=${probe.logicalCpuCount ?? 0}`);
  if ((probe.ramGiB ?? 0) < baseline.minimumRamGiB) missing.push(`ramGiB=${probe.ramGiB ?? 0}`);
  if (probe.hardwareVideoDecode !== true) missing.push('hardwareVideoDecode=false');
  return missing.length === 0
    ? { id: `real.${routeMode}.environment`, status: 'passed', details: 'required baseline inputs present' }
    : { id: `real.${routeMode}.environment`, status: 'unavailable', details: missing.join(', ') };
}
