import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { SessionRecord } from '../store/session-store.js';
import {
  SESSION_RESOURCE_DEFAULTS,
  SESSION_RESOURCE_HANDLE_TYPE,
  SESSION_RESOURCE_KIND,
  SESSION_RESOURCE_OWNER_ENV,
  SESSION_RESOURCE_RELEASE_REASON,
  MEMORY_MCP_WATCHDOG,
} from '../../shared/session-resource-lifecycle.js';
import {
  SessionResourceRegistry,
  sessionResourcePidHandleIsCurrent,
  type OrphanSweepSummary,
  type ReleaseSummary,
  type SessionResourceOwner,
  type SessionResourceRecord,
} from './session-resource-registry.js';

const registry = new SessionResourceRegistry();
const execFile = promisify(execFileCallback);
let stopExpirySweep: (() => void) | null = null;
const mcpCpuSamples = new Map<string, { cpuMs: number; sampledAt: number; strikes: number }>();

function usable(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function sessionResourceOwner(record: Pick<SessionRecord, 'name' | 'sessionInstanceId' | 'runtimeEpoch'>): SessionResourceOwner | null {
  return usable(record.name) && usable(record.sessionInstanceId) && usable(record.runtimeEpoch)
    ? { sessionName: record.name, sessionInstanceId: record.sessionInstanceId, runtimeEpoch: record.runtimeEpoch }
    : null;
}

export function sessionResourceOwnerFromEnv(env: NodeJS.ProcessEnv = process.env): SessionResourceOwner | null {
  const sessionName = env.IMCODES_SESSION?.trim() || env.IMCODES_DAEMON_SESSION_NAME?.trim();
  const sessionInstanceId = env[SESSION_RESOURCE_OWNER_ENV.SESSION_INSTANCE_ID]?.trim();
  const runtimeEpoch = env[SESSION_RESOURCE_OWNER_ENV.RUNTIME_EPOCH]?.trim();
  return sessionName && sessionInstanceId && runtimeEpoch
    ? { sessionName, sessionInstanceId, runtimeEpoch }
    : null;
}

export function resourceOwnerEnv(owner: SessionResourceOwner | null): Record<string, string> {
  return owner ? {
    [SESSION_RESOURCE_OWNER_ENV.SESSION_INSTANCE_ID]: owner.sessionInstanceId,
    [SESSION_RESOURCE_OWNER_ENV.RUNTIME_EPOCH]: owner.runtimeEpoch,
  } : {};
}

export async function registerTmuxSessionResource(record: SessionRecord): Promise<void> {
  const owner = sessionResourceOwner(record);
  if (!owner) throw new Error('session_resource_owner_missing');
  if (!record.paneId) throw new Error('session_resource_tmux_identity_unavailable');
  await registry.register({
    resourceId: `tmux:${record.name}`,
    kind: SESSION_RESOURCE_KIND.TMUX,
    owner,
    handle: {
      type: SESSION_RESOURCE_HANDLE_TYPE.TMUX,
      name: record.name,
      paneId: record.paneId,
    },
  });
}

export async function registerMcpProcessResource(
  owner: SessionResourceOwner,
  pid = process.pid,
  killTree = false,
  resourcePrefix = 'mcp',
): Promise<string> {
  const resourceId = `${resourcePrefix}:${owner.runtimeEpoch}:${pid}`;
  await registry.register({
    resourceId,
    kind: SESSION_RESOURCE_KIND.MCP,
    owner,
    handle: { type: SESSION_RESOURCE_HANDLE_TYPE.PID, pid, ...(killTree ? { killTree: true } : {}) },
  });
  return resourceId;
}

export async function sweepComputerUseOrphanedResources(): Promise<ReleaseSummary> {
  return registry.releaseResourceIdPrefixes(
    ['browser:', 'computer-use-mcp:'],
    SESSION_RESOURCE_RELEASE_REASON.ORPHANED,
  );
}

export async function registerBrowserProcessResource(owner: SessionResourceOwner, pid: number): Promise<string> {
  const resourceId = `browser:${owner.runtimeEpoch}:${pid}`;
  await registry.register({
    resourceId,
    kind: SESSION_RESOURCE_KIND.BROWSER,
    owner,
    handle: { type: SESSION_RESOURCE_HANDLE_TYPE.PID, pid, killTree: true },
    ttlMs: SESSION_RESOURCE_DEFAULTS.BROWSER_TTL_MS,
    idleTimeoutMs: SESSION_RESOURCE_DEFAULTS.BROWSER_IDLE_TIMEOUT_MS,
  });
  return resourceId;
}

export async function registerContainerResource(
  owner: SessionResourceOwner,
  containerId: string,
): Promise<string> {
  const resourceId = `container:${containerId}`;
  await registry.register({
    resourceId,
    kind: SESSION_RESOURCE_KIND.CONTAINER,
    owner,
    handle: { type: SESSION_RESOURCE_HANDLE_TYPE.PODMAN, containerId },
    ttlMs: SESSION_RESOURCE_DEFAULTS.CONTAINER_TTL_MS,
    idleTimeoutMs: SESSION_RESOURCE_DEFAULTS.CONTAINER_IDLE_TIMEOUT_MS,
  });
  return resourceId;
}

export async function touchSessionResource(resourceId: string): Promise<boolean> {
  return registry.touch(resourceId);
}

export async function releaseSessionResource(
  resourceId: string,
  owner: SessionResourceOwner,
  reason: string = SESSION_RESOURCE_RELEASE_REASON.SESSION_COMPLETED,
): Promise<ReleaseSummary> {
  return registry.releaseResource(resourceId, owner, reason);
}

export async function releaseSessionResources(record: SessionRecord): Promise<ReleaseSummary> {
  const owner = sessionResourceOwner(record);
  if (!owner) return { released: 0, failed: 0 };
  return registry.releaseOwner(owner, SESSION_RESOURCE_RELEASE_REASON.SESSION_COMPLETED);
}

export async function releaseSessionChildResources(record: SessionRecord): Promise<ReleaseSummary> {
  const owner = sessionResourceOwner(record);
  if (!owner) return { released: 0, failed: 0 };
  return registry.releaseOwnerKinds(owner, [
    SESSION_RESOURCE_KIND.MCP,
    SESSION_RESOURCE_KIND.BROWSER,
    SESSION_RESOURCE_KIND.CONTAINER,
  ], SESSION_RESOURCE_RELEASE_REASON.SESSION_COMPLETED);
}

export async function sweepOrphanedSessionResources(records: readonly SessionRecord[]): Promise<OrphanSweepSummary> {
  const owners = records.map(sessionResourceOwner).filter((owner): owner is SessionResourceOwner => owner !== null);
  return registry.sweepOrphans(owners);
}

async function sampleProcessCpuMillis(pid: number): Promise<number | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).TotalProcessorTime.TotalMilliseconds`,
      ], { timeout: 2_000, windowsHide: true });
      const value = Number(stdout.trim());
      return Number.isFinite(value) && value >= 0 ? value : null;
    }
    const { stdout } = await execFile('ps', ['-o', 'time=', '-p', String(pid)], { timeout: 2_000 });
    const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(stdout.trim());
    if (!match) return null;
    return ((((Number(match[1] ?? 0) * 24) + Number(match[2] ?? 0)) * 60
      + Number(match[3])) * 60 + Number(match[4])) * 1_000;
  } catch {
    return null;
  }
}

interface MemoryMcpWatchdogDependencies {
  listResources: () => Promise<SessionResourceRecord[]>;
  sampleCpuMillis: (pid: number) => Promise<number | null>;
  pidHandleIsCurrent: typeof sessionResourcePidHandleIsCurrent;
  releaseResource: typeof releaseSessionResource;
}

const memoryMcpWatchdogDependencies: MemoryMcpWatchdogDependencies = {
  listResources: () => registry.list(),
  sampleCpuMillis: sampleProcessCpuMillis,
  pidHandleIsCurrent: sessionResourcePidHandleIsCurrent,
  releaseResource: releaseSessionResource,
};

export async function sweepMemoryMcpCpu(
  now = Date.now(),
  dependencies: MemoryMcpWatchdogDependencies = memoryMcpWatchdogDependencies,
): Promise<void> {
  const records = await dependencies.listResources();
  const liveIds = new Set<string>();
  for (const record of records) {
    if (record.kind !== SESSION_RESOURCE_KIND.MCP || record.handle.type !== SESSION_RESOURCE_HANDLE_TYPE.PID) continue;
    liveIds.add(record.resourceId);
    if (record.handle.pid === process.pid) continue;
    const cpuMs = await dependencies.sampleCpuMillis(record.handle.pid);
    if (cpuMs === null) {
      mcpCpuSamples.delete(record.resourceId);
      // CPU sampling can fail transiently (ps timeout/format/permission). It is
      // not proof that the process vanished. Releasing here would make cleanup
      // SIGTERM a healthy MCP and then relaunch the whole owner session, leaving
      // the active host bound to a closed stdio generation. Only an exact PID +
      // process-start observation may authorize that destructive recovery.
      const exactProcessCurrent = await dependencies.pidHandleIsCurrent(record.handle);
      if (exactProcessCurrent !== false) continue;
      // The MCP stdio process is already gone. Restarting its owner cannot
      // reconnect the current host to that closed transport generation; it
      // only kills otherwise healthy agent work. Drop the stale registry row
      // and let the MCP host own child-process reconnection/relaunch.
      await dependencies.releaseResource(
        record.resourceId,
        record.owner,
        SESSION_RESOURCE_RELEASE_REASON.PROCESS_MISSING,
      );
      continue;
    }
    const previous = mcpCpuSamples.get(record.resourceId);
    if (!previous) {
      mcpCpuSamples.set(record.resourceId, { cpuMs, sampledAt: now, strikes: 0 });
      continue;
    }
    const wallMs = now - previous.sampledAt;
    const cpuRatio = wallMs > 0 ? Math.max(0, cpuMs - previous.cpuMs) / wallMs : 0;
    const strikes = cpuRatio >= MEMORY_MCP_WATCHDOG.CPU_RATIO_THRESHOLD ? previous.strikes + 1 : 0;
    mcpCpuSamples.set(record.resourceId, { cpuMs, sampledAt: now, strikes });
    if (strikes >= MEMORY_MCP_WATCHDOG.CPU_STRIKE_LIMIT) {
      await dependencies.releaseResource(
        record.resourceId,
        record.owner,
        SESSION_RESOURCE_RELEASE_REASON.SUSTAINED_CPU,
      );
      mcpCpuSamples.delete(record.resourceId);
    }
  }
  for (const resourceId of mcpCpuSamples.keys()) {
    if (!liveIds.has(resourceId)) mcpCpuSamples.delete(resourceId);
  }
}

export function startSessionResourceExpirySweep(intervalMs = MEMORY_MCP_WATCHDOG.SAMPLE_INTERVAL_MS): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void Promise.allSettled([registry.sweepExpired(), sweepMemoryMcpCpu()])
      .finally(() => { running = false; });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function initializeSessionResourceLifecycle(
  records: readonly SessionRecord[],
): Promise<OrphanSweepSummary> {
  const swept = await sweepOrphanedSessionResources(records);
  const registrationErrors: unknown[] = [];
  for (const record of records) {
    if (record.runtimeType === 'transport') continue;
    try {
      // Imported lazily. `tmux.ts` resolves its terminal backend in a
      // module-level initializer that THROWS when none is available — on
      // Windows it requires `node-pty`. The controlled node reaches this file
      // through computer-use-ipc and bundles no terminal backend, so a static
      // import killed `imcodes-node.exe` at startup with
      // "node-pty not found. Reinstall imcodes." before it could run at all.
      // Nothing here needs a terminal until these calls actually happen.
      const { getPaneId } = await import('../agent/tmux.js');
      const paneId = await getPaneId(record.name);
      if (!paneId) throw new Error('session_resource_tmux_identity_unavailable');
      await registerTmuxSessionResource({ ...record, paneId });
    } catch (error) {
      registrationErrors.push(error);
    }
  }
  stopExpirySweep?.();
  stopExpirySweep = startSessionResourceExpirySweep();
  if (registrationErrors.length > 0) {
    throw new AggregateError(registrationErrors, 'session_resource_startup_registration_failed');
  }
  return swept;
}

interface ProcessMemoryRow {
  pid: number;
  parentPid: number;
  rssBytes: number;
}

async function processMemoryRows(): Promise<ProcessMemoryRow[] | null> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress',
      ], { timeout: 5_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      const parsed = JSON.parse(stdout) as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      return items.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const row = item as Record<string, unknown>;
        const pid = Number(row.ProcessId);
        const parentPid = Number(row.ParentProcessId);
        const rssBytes = Number(row.WorkingSetSize);
        return Number.isSafeInteger(pid) && Number.isSafeInteger(parentPid) && Number.isFinite(rssBytes)
          ? [{ pid, parentPid, rssBytes }]
          : [];
      });
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFile('ps', ['-axo', 'pid=,ppid=,rss='], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 });
    return stdout.split('\n').flatMap((line) => {
      const [pidRaw, parentRaw, rssRaw] = line.trim().split(/\s+/);
      const pid = Number(pidRaw);
      const parentPid = Number(parentRaw);
      const rssBytes = Number(rssRaw) * 1024;
      return Number.isSafeInteger(pid) && Number.isSafeInteger(parentPid) && Number.isFinite(rssBytes)
        ? [{ pid, parentPid, rssBytes }]
        : [];
    });
  } catch {
    return null;
  }
}

export async function measureSessionProcessTreeRssBytes(record: SessionRecord): Promise<number | null> {
  if (record.runtimeType === 'transport') return 0;
  const { getPanePids } = await import('../agent/tmux.js');
  const roots = new Set((await getPanePids(record.name)).map(Number).filter(Number.isSafeInteger));
  if (roots.size === 0) return null;
  const rows = await processMemoryRows();
  if (!rows || !rows.some((row) => roots.has(row.pid))) return null;
  const selected = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!selected.has(row.pid) && selected.has(row.parentPid)) {
        selected.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.reduce((sum, row) => selected.has(row.pid) ? sum + row.rssBytes : sum, 0);
}

/** Ordered-shutdown seam consumed by the daemon lifecycle owner. */
export function stopSessionResourceLifecycle(): void {
  stopExpirySweep?.();
  stopExpirySweep = null;
  mcpCpuSamples.clear();
}
