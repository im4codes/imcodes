import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertNoCgroupSurvivors,
  assertDaemonDescendants,
  assertOrderedShutdownLog,
  assertPidsInControlGroup,
  assertSystemdShutdownAuthority,
} from '../../src/util/systemd-cgroup-validation.js';

const live = {
  killMode: 'control-group', sendSigkill: 'yes', timeoutStopUs: '45s',
  controlGroup: '/user.slice/imcodes.service', mainPid: 42,
};

describe('systemd cgroup production evidence validation', () => {
  it('binds the 100-cycle production evidence to canonical node 211', () => {
    const evidence = JSON.parse(readFileSync(resolve(
      __dirname,
      '..',
      'fixtures',
      'daemon-cgroup-validation-node-211.json',
    ), 'utf8')) as {
      nodeId: string;
      cycles: number;
      normalCycles: Array<{ cycle: number; mainPid: number; descendantPids: number[] }>;
      timeoutFallback: { elapsedMs: number; descendantPids: number[] };
      restoredInitialState: boolean;
    };
    expect(evidence.nodeId).toBe('9535523706');
    expect(evidence.cycles).toBe(100);
    expect(evidence.normalCycles).toHaveLength(100);
    expect(evidence.normalCycles.map(({ cycle }) => cycle)).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
    expect(new Set(evidence.normalCycles.map(({ mainPid }) => mainPid)).size).toBe(100);
    expect(evidence.normalCycles.every(({ descendantPids }) => descendantPids.length === 4)).toBe(true);
    expect(evidence.timeoutFallback.elapsedMs).toBeGreaterThanOrEqual(1_500);
    expect(evidence.timeoutFallback.elapsedMs).toBeLessThanOrEqual(10_000);
    expect(evidence.timeoutFallback.descendantPids).toHaveLength(4);
    expect(evidence.restoredInitialState).toBe(true);
  });

  it('rejects compile-clean process and mixed KillMode mutants', () => {
    for (const killMode of ['process', 'mixed']) {
      expect(() => assertSystemdShutdownAuthority({ ...live, killMode })).toThrow(/KillMode/);
    }
  });

  it('rejects a session, MCP, browser, or container descendant outside the daemon cgroup', () => {
    const pids = [101, 102, 103, 104];
    const memberships = new Map(pids.map((pid) => [pid, `0::${live.controlGroup}`]));
    assertPidsInControlGroup(live.controlGroup, pids, memberships);
    memberships.set(103, '0::/user.slice/escaped.scope');
    expect(() => assertPidsInControlGroup(live.controlGroup, pids, memberships)).toThrow(/escaped/);
  });

  it('rejects a launcher sibling falsely presented as a daemon descendant', () => {
    const parents = new Map([[101, 42], [102, 101], [103, 7]]);
    assertDaemonDescendants(42, [101, 102], parents);
    expect(() => assertDaemonDescendants(42, [101, 102, 103], parents)).toThrow(/not a descendant/);
  });

  it('rejects any orphan PID or non-empty cgroup after stop', () => {
    assertNoCgroupSurvivors([101, 102], new Set(), []);
    expect(() => assertNoCgroupSurvivors([101, 102], new Set([102]), [])).toThrow(/leaked/);
    expect(() => assertNoCgroupSurvivors([101, 102], new Set(), [999])).toThrow(/leaked/);
  });

  it('requires session → MCP → browser → container in production logs', () => {
    const ordered = [
      'Daemon shutdown phase session started',
      'Daemon shutdown phase MCP started',
      'Daemon shutdown phase browser started',
      'Daemon shutdown phase container started',
    ].join('\n');
    assertOrderedShutdownLog(ordered);
    expect(() => assertOrderedShutdownLog(ordered.replace(
      'Daemon shutdown phase MCP started\nDaemon shutdown phase browser started',
      'Daemon shutdown phase browser started\nDaemon shutdown phase MCP started',
    ))).toThrow(/out of order|missing/);
  });
});
