import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CGROUP_VALIDATION_ROLES,
  renderCgroupValidationProbeCommand,
  startDaemonCgroupValidationProbes,
} from '../../src/daemon/cgroup-validation-probes.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe('daemon-owned cgroup validation launcher', () => {
  it('makes TERM survival universal and the timeout phase ignore ordered stop', () => {
    for (const role of CGROUP_VALIDATION_ROLES) {
      const command = renderCgroupValidationProbeCommand(role, 'container');
      expect(command).toContain("trap '' TERM");
      expect(command.includes("trap '' USR2")).toBe(role === 'container');
    }
  });

  it('is disabled unless the explicit production validation evidence path is set', () => {
    expect(startDaemonCgroupValidationProbes({})).toBeNull();
  });

  it.skipIf(process.platform !== 'linux')('spawns all role probes as daemon children and drains them by phase', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-cgroup-probes-'));
    const evidence = join(dir, 'probes.json');
    const controller = startDaemonCgroupValidationProbes({
      ...process.env,
      IMCODES_CGROUP_VALIDATION_PROBE_FILE: evidence,
    });
    expect(controller).not.toBeNull();
    cleanup.push(async () => {
      if (controller) {
        for (const role of CGROUP_VALIDATION_ROLES) {
          await controller.stopPhase(role).catch(() => {});
        }
      }
      await rm(dir, { recursive: true, force: true });
    });

    expect(existsSync(evidence)).toBe(true);
    const recorded = JSON.parse(readFileSync(evidence, 'utf8')) as {
      daemonPid: number;
      probes: Array<{ role: string; pid: number }>;
    };
    expect(recorded.daemonPid).toBe(process.pid);
    expect((recorded as { ready?: boolean }).ready).toBe(false);
    expect(recorded.probes.map(({ role }) => role)).toEqual(CGROUP_VALIDATION_ROLES);
    for (const { pid } of recorded.probes) {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      expect(Number(fields[1])).toBe(process.pid);
    }
    controller!.markReady();
    expect((JSON.parse(readFileSync(evidence, 'utf8')) as { ready: boolean }).ready).toBe(true);
    for (const role of CGROUP_VALIDATION_ROLES) await controller!.stopPhase(role);
    for (const { pid } of recorded.probes) expect(existsSync(`/proc/${pid}`)).toBe(false);
  });
});
