import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REMOTE_DESKTOP_WALL_QUALIFICATION_BASELINE,
  deterministicWallQualificationRun,
  evaluateRealQualificationEnvironment,
  evaluateRemoteDesktopWallQualification,
  type WallQualificationRun,
} from './remote-desktop-wall-qualification-harness.js';

function cloneRun(run: WallQualificationRun): WallQualificationRun {
  return structuredClone(run) as WallQualificationRun;
}

describe('remote desktop wall qualification harness mechanics', () => {
  it.each([
    [1, 'direct'],
    [4, 'direct'],
    [16, 'direct'],
    [16, 'all_turn'],
  ] as const)('passes deterministic fake-media mechanics for %i %s source(s)', (sourceCount, routeMode) => {
    const run = deterministicWallQualificationRun({ sourceCount, routeMode });
    const result = evaluateRemoteDesktopWallQualification(run);
    expect(result.status).toBe('passed');
    expect(result.issues).toEqual([]);
  });

  it('pins the normative Chromium baseline and resource/SLO thresholds', () => {
    expect(REMOTE_DESKTOP_WALL_QUALIFICATION_BASELINE).toMatchObject({
      name: 'chromium-desktop-16stream-v1',
      browser: 'production Chromium',
      viewport: { width: 1920, height: 1080 },
      minimumLogicalCpu: 8,
      minimumRamGiB: 16,
      hardwareVideoDecode: true,
      steadyStateWindowMs: 300_000,
      tileProfile: { width: 640, height: 360, fps: 5 },
      promotedProfile: { width: 1280, height: 720, fps: 15 },
      minimumVisiblePaintedFps: 2,
      maximumFrameGapMs: 2_000,
      promotionDeadlineMs: 3_000,
      allTurnAggregateReceiveBitrateBps: 24_000_000,
      retainedHeapGrowthLimitBytes: 128 * 1024 * 1024,
      p95LongTaskLimitMs: 100,
      longTasksPerMinuteLimit: 10,
    });
  });

  it('keeps real direct/TURN qualification unavailable when controlled devices or named baseline are absent', () => {
    expect(evaluateRealQualificationEnvironment({}, 'direct')).toEqual({
      id: 'real.direct.environment',
      status: 'unavailable',
      details: expect.stringContaining('controlledSourceCount=0'),
    });
    expect(evaluateRealQualificationEnvironment({}, 'all_turn')).toEqual({
      id: 'real.all_turn.environment',
      status: 'unavailable',
      details: expect.stringContaining('turnForced=false'),
    });
  });

  it('records a checked-in result artifact without claiming unavailable real network gates passed', () => {
    const artifact = JSON.parse(readFileSync(
      resolve(process.cwd(), 'test/qualification/remote-desktop-wall-qualification-results.json'),
      'utf8',
    )) as {
      deterministicFakeMedia: { status: string; routeModes: readonly string[] };
      realDirect16: { status: string };
      realAllTurn16: { status: string };
    };
    expect(artifact.deterministicFakeMedia).toMatchObject({
      status: 'passed',
      routeModes: ['direct', 'all_turn'],
    });
    expect(artifact.realDirect16.status).toBe('unavailable');
    expect(artifact.realAllTurn16.status).toBe('unavailable');
  });
});

describe('remote desktop wall qualification mutation gates', () => {
  it('fails when promotion opens a second session or a tile allocates a duplicate connection', () => {
    const run = cloneRun(deterministicWallQualificationRun({ sourceCount: 16, routeMode: 'direct' }));
    run.promotion.sessionCreations = 2;
    run.sources[0] = { ...run.sources[0]!, connectionCreations: 2 };
    const result = evaluateRemoteDesktopWallQualification(run);
    expect(result.status).toBe('failed');
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.stringContaining('promotion.no_second_session'),
      expect.stringContaining('tile.host-01.single_connection'),
    ]));
  });

  it('fails when a healthy tile is pressure-paused or stale frames are reported live', () => {
    const run = cloneRun(deterministicWallQualificationRun({ sourceCount: 16, routeMode: 'direct' }));
    run.sources[2] = { ...run.sources[2]!, pressurePaused: true };
    run.sources[4] = { ...run.sources[4]!, maxFrameGapMs: 2_500, reportedLive: true };
    const result = evaluateRemoteDesktopWallQualification(run);
    expect(result.status).toBe('failed');
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.stringContaining('tile.host-03.pressure_pause'),
      expect.stringContaining('tile.host-05.frame_gap'),
      expect.stringContaining('tile.host-05.live_truthfulness'),
    ]));
  });

  it('fails on resource and TURN SLO threshold violations', () => {
    const run = cloneRun(deterministicWallQualificationRun({ sourceCount: 16, routeMode: 'all_turn' }));
    for (const source of run.sources) source.receiveBitrateBps = 2_000_000;
    run.resources.browserRssBytes = REMOTE_DESKTOP_WALL_QUALIFICATION_BASELINE.browserRssLimitBytes + 1;
    run.resources.retainedHeapGrowthBytes = REMOTE_DESKTOP_WALL_QUALIFICATION_BASELINE.retainedHeapGrowthLimitBytes + 1;
    run.resources.longTaskDurationsMs = Array.from({ length: 60 }, () => 120);
    const result = evaluateRemoteDesktopWallQualification(run);
    expect(result.status).toBe('failed');
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.stringContaining('turn.aggregate_receive_bitrate'),
      expect.stringContaining('resources.browser_rss'),
      expect.stringContaining('resources.retained_heap_growth'),
      expect.stringContaining('resources.long_task_p95'),
      expect.stringContaining('resources.long_tasks_per_minute'),
    ]));
  });

  it('fails when disconnect/reconnect/revoke/CAS changes tear down an unrelated host', () => {
    const run = cloneRun(deterministicWallQualificationRun({ sourceCount: 16, routeMode: 'direct' }));
    run.lifecycleEvents[0] = {
      ...run.lifecycleEvents[0]!,
      stoppedHostIds: ['host-02'],
    };
    run.lifecycleEvents[3] = {
      ...run.lifecycleEvents[3]!,
      activeConnectionCountByHost: { ...run.lifecycleEvents[3]!.activeConnectionCountByHost, 'host-04': 2 },
    };
    const result = evaluateRemoteDesktopWallQualification(run);
    expect(result.status).toBe('failed');
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.stringContaining('lifecycle.disconnect.host-03.no_cross_host_teardown'),
      expect.stringContaining('lifecycle.cas_layout_change.wall.no_duplicate_connection'),
    ]));
  });
});
