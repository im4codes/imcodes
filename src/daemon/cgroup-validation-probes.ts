import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const CGROUP_VALIDATION_ROLES = ['session', 'mcp', 'browser', 'container'] as const;
export type CgroupValidationRole = typeof CGROUP_VALIDATION_ROLES[number];

interface ProbeProcess {
  role: CgroupValidationRole;
  child: ChildProcess;
}

export interface CgroupValidationProbeController {
  readonly daemonPid: number;
  readonly probes: ReadonlyArray<{ role: CgroupValidationRole; pid: number }>;
  markReady(): void;
  stopPhase(role: CgroupValidationRole): Promise<void>;
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
}

export function renderCgroupValidationProbeCommand(
  role: CgroupValidationRole,
  hangPhase: string | undefined,
): string {
  const ignoreOrderedStop = hangPhase === role;
  return `trap '' TERM; ${ignoreOrderedStop ? "trap '' USR2; " : ''}exec -a imcodes-${role}-cgroup-probe sleep 3600`;
}

/**
 * Opt-in production validation seam. The real daemon, rather than an
 * ExecStartPost sibling, owns these descendants so cgroup evidence proves the
 * same parent/child boundary used by sessions, MCP, browser, and containers.
 */
export function startDaemonCgroupValidationProbes(
  env: NodeJS.ProcessEnv = process.env,
): CgroupValidationProbeController | null {
  const evidencePath = env.IMCODES_CGROUP_VALIDATION_PROBE_FILE;
  if (!evidencePath) return null;
  if (process.platform !== 'linux') throw new Error('cgroup validation probes require Linux');

  const children: ProbeProcess[] = [];
  const childEnv = { ...env };
  delete childEnv.IMCODES_CGROUP_VALIDATION_PROBE_FILE;
  for (const role of CGROUP_VALIDATION_ROLES) {
    // Shell traps establish ignored signal dispositions before exec. Unlike a
    // runtime-level handler, this has no startup race with systemd's cgroup
    // SIGTERM and therefore makes the timeout fallback fault deterministic.
    const command = renderCgroupValidationProbeCommand(role, env.IMCODES_CGROUP_VALIDATION_HANG_PHASE);
    const child = spawn('/bin/bash', ['-c', command], {
      detached: false,
      env: childEnv,
      stdio: 'ignore',
    });
    if (!child.pid) {
      for (const started of children) started.child.kill('SIGKILL');
      throw new Error(`failed to spawn ${role} cgroup validation descendant`);
    }
    children.push({ role, child });
  }

  const probes = children.map(({ role, child }) => ({ role, pid: child.pid! }));
  const writeEvidence = (ready: boolean) => {
    mkdirSync(dirname(evidencePath), { recursive: true });
    const temporary = `${evidencePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({
      version: 1,
      daemonPid: process.pid,
      ready,
      probes,
    })}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, evidencePath);
  };
  writeEvidence(false);

  return {
    daemonPid: process.pid,
    probes,
    markReady() {
      writeEvidence(true);
    },
    async stopPhase(role) {
      const probe = children.find((candidate) => candidate.role === role);
      if (!probe || probe.child.exitCode !== null || probe.child.signalCode !== null) return;
      probe.child.kill('SIGUSR2');
      await waitForExit(probe.child);
    },
  };
}
