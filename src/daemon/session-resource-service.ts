import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { readProcessCpuMillis } from '../util/process-start.js';
import type { SessionRecord } from '../store/session-store.js';
import {
  SESSION_RESOURCE_DEFAULTS,
  SESSION_RESOURCE_HANDLE_TYPE,
  SESSION_RESOURCE_KIND,
  SESSION_RESOURCE_OWNER_ENV,
  SESSION_RESOURCE_RELEASE_REASON,
  MEMORY_MCP_WATCHDOG,
  type SessionResourceLifetime,
} from '../../shared/session-resource-lifecycle.js';
import {
  PROVIDER_HOSTED_RELEASE,
  SessionResourceRegistry,
  sessionResourcePidHandleIsCurrent,
  type OrphanSweepSummary,
  type ReleaseSummary,
  type SessionResourceOwner,
  type SessionResourceRecord,
} from './session-resource-registry.js';

const registry = new SessionResourceRegistry({
  isTmuxHandleCurrent: async (name, paneId) => {
    const { isTmuxSessionResourceHandleCurrent } = await import('../agent/tmux.js');
    return isTmuxSessionResourceHandleCurrent(name, paneId);
  },
});
const execFile = promisify(execFileCallback);
let stopExpirySweep: (() => void) | null = null;
const mcpCpuSamples = new Map<string, {
  cpuMs: number;
  sampledAt: number;
  strikes: number;
  pressureReported: boolean;
}>();
const MCP_CPU_SAMPLE_CONCURRENCY = 8;

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

async function resolveTmuxServerId(name: string): Promise<string | undefined> {
  if (process.platform === 'win32') return undefined;
  try {
    const [pid, started] = await Promise.all([
      execFile('tmux', ['display-message', '-p', '-t', name, '#{pid}'], { timeout: 2_000 }),
      execFile('tmux', ['display-message', '-p', '-t', name, '#{start_time}'], { timeout: 2_000 }),
    ]);
    const serverPid = pid.stdout.trim();
    const serverStart = started.stdout.trim();
    return serverPid && serverStart ? `${serverPid}:${serverStart}` : undefined;
  } catch {
    // Marker capture is additive; registry liveness remains fail-closed when
    // tmux is unavailable or a non-tmux backend owns this session.
    return undefined;
  }
}

export async function registerTmuxSessionResource(record: SessionRecord): Promise<void> {
  const owner = sessionResourceOwner(record);
  if (!owner) throw new Error('session_resource_owner_missing');
  if (!record.paneId) throw new Error('session_resource_tmux_identity_unavailable');
  // Capture the tmux server lifetime alongside `%N`. Pane ids are reused by
  // a fresh server, so the registry must be able to distinguish a recycled
  // pane from the old owner during restore. If the bounded probe is
  // unavailable, keep the legacy pane-only handle and fail closed as before.
  const serverId = await resolveTmuxServerId(record.name);
  await registry.register({
    resourceId: `tmux:${record.name}`,
    kind: SESSION_RESOURCE_KIND.TMUX,
    owner,
    handle: {
      type: SESSION_RESOURCE_HANDLE_TYPE.TMUX,
      name: record.name,
      paneId: record.paneId,
      ...(serverId ? { serverId } : {}),
    },
  });
}

export async function registerMcpProcessResource(
  owner: SessionResourceOwner,
  pid = process.pid,
  killTree = false,
  resourcePrefix = 'mcp',
  lifetime?: SessionResourceLifetime,
): Promise<string> {
  const resourceId = `${resourcePrefix}:${owner.runtimeEpoch}:${pid}`;
  await registry.register({
    resourceId,
    kind: SESSION_RESOURCE_KIND.MCP,
    owner,
    handle: { type: SESSION_RESOURCE_HANDLE_TYPE.PID, pid, ...(killTree ? { killTree: true } : {}) },
    ...(lifetime ? { lifetime } : {}),
  });
  return resourceId;
}

/**
 * Register a session-owned agent CLI that leads its own process group.
 *
 * `killTree: true` makes the registry signal the GROUP (negative pid), and
 * `register()` stamps the process start time so the startup sweep can prove
 * the pid is still the same process before signalling anything. That is the
 * authority: an identity fingerprint, never command text.
 *
 * Only per-session children belong here. Providers that share one process
 * across every session (gemini-sdk, codex-sdk, kimi-sdk) must NOT be
 * registered under a single session's owner, or one session's teardown would
 * reap another session's live agent.
 */
export async function registerAgentProcessResource(
  owner: SessionResourceOwner,
  pid: number,
): Promise<string> {
  const resourceId = `agent:${owner.runtimeEpoch}:${pid}`;
  await registry.register({
    resourceId,
    kind: SESSION_RESOURCE_KIND.AGENT,
    owner,
    handle: { type: SESSION_RESOURCE_HANDLE_TYPE.PID, pid, killTree: true },
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

/**
 * Child cleanup when a session's runtime is replaced in place.
 *
 * `providerThreadContinues` is the caller's statement that the new runtime
 * resumes the SAME provider thread (e.g. a non-fresh codex-sdk relaunch: Codex
 * keeps that thread loaded and never respawns its MCP server). Only then are
 * provider-hosted MCP children kept; otherwise they are reaped at every epoch
 * of this instance, so an abandoned thread's server cannot leak.
 */
export async function releaseSessionChildResources(
  record: SessionRecord,
  options: { providerThreadContinues: boolean },
): Promise<ReleaseSummary> {
  const owner = sessionResourceOwner(record);
  if (!owner) return { released: 0, failed: 0 };
  return registry.releaseOwnerKinds(owner, [
    SESSION_RESOURCE_KIND.MCP,
    SESSION_RESOURCE_KIND.BROWSER,
    SESSION_RESOURCE_KIND.CONTAINER,
    SESSION_RESOURCE_KIND.AGENT,
  ], SESSION_RESOURCE_RELEASE_REASON.SESSION_COMPLETED, options.providerThreadContinues
    ? PROVIDER_HOSTED_RELEASE.KEEP
    : PROVIDER_HOSTED_RELEASE.REAP_ALL_EPOCHS);
}

export async function sweepOrphanedSessionResources(records: readonly SessionRecord[]): Promise<OrphanSweepSummary> {
  // The durable local session store is the authority boundary for destructive
  // cleanup. An unknown owner may be a live remote session whose resource was
  // registered by a controlled-node process, so age alone cannot prove it is
  // orphaned. Preserve unknown owners; explicit session shutdown/restart owns
  // their normal cleanup path.
  const eligibleOwners = records
    .map(sessionResourceOwner)
    .filter((owner): owner is SessionResourceOwner => owner !== null);
  const activeOwners = activeSessionResourceRecords(records)
    .map(sessionResourceOwner)
    .filter((owner): owner is SessionResourceOwner => owner !== null);
  return registry.sweepOrphans(activeOwners, {
    eligibleOwners,
    minimumAgeMs: SESSION_RESOURCE_DEFAULTS.ORPHAN_GRACE_MS,
  });
}

type PidResourceRecord = SessionResourceRecord & {
  handle: Extract<SessionResourceRecord['handle'], { type: typeof SESSION_RESOURCE_HANDLE_TYPE.PID }>;
};

interface MemoryMcpWatchdogDependencies {
  listResources: () => Promise<SessionResourceRecord[]>;
  /** One batched read for every MCP pid of a tick; a pid that is gone or unreadable is absent from the map. */
  sampleCpuMillisBatch: (pids: readonly number[]) => Promise<ReadonlyMap<number, number>>;
  pidHandleIsCurrent: typeof sessionResourcePidHandleIsCurrent;
  releaseResource: typeof releaseSessionResource;
  reportSustainedCpu?: (record: SessionResourceRecord, cpuRatio: number) => void;
}

const memoryMcpWatchdogDependencies: MemoryMcpWatchdogDependencies = {
  listResources: () => registry.list(),
  sampleCpuMillisBatch: readProcessCpuMillis,
  pidHandleIsCurrent: sessionResourcePidHandleIsCurrent,
  releaseResource: releaseSessionResource,
  reportSustainedCpu: (record, cpuRatio) => {
    process.stderr.write(
      `[memory-mcp] sustained CPU for ${record.resourceId}: ratio=${cpuRatio.toFixed(2)}; preserving live stdio generation\n`,
    );
  },
};

export async function sweepMemoryMcpCpu(
  now = Date.now(),
  dependencies: MemoryMcpWatchdogDependencies = memoryMcpWatchdogDependencies,
): Promise<void> {
  const records = await dependencies.listResources();
  const liveIds = new Set<string>();
  const sampleRecord = async (record: SessionResourceRecord, sampledCpuMs: number | undefined): Promise<void> => {
    if (record.kind !== SESSION_RESOURCE_KIND.MCP || record.handle.type !== SESSION_RESOURCE_HANDLE_TYPE.PID) return;
    liveIds.add(record.resourceId);
    if (record.handle.pid === process.pid) return;
    const cpuMs = sampledCpuMs ?? null;
    if (cpuMs === null) {
      mcpCpuSamples.delete(record.resourceId);
      // CPU sampling can fail transiently (ps timeout/format/permission). It is
      // not proof that the process vanished. Releasing here would make cleanup
      // SIGTERM a healthy MCP and then relaunch the whole owner session, leaving
      // the active host bound to a closed stdio generation. Only an exact PID +
      // process-start observation may authorize that destructive recovery.
      const exactProcessCurrent = await dependencies.pidHandleIsCurrent(record.handle);
      if (exactProcessCurrent !== false) return;
      // The MCP stdio process is already gone. Restarting its owner cannot
      // reconnect the current host to that closed transport generation; it
      // only kills otherwise healthy agent work. Drop the stale registry row
      // and let the MCP host own child-process reconnection/relaunch.
      await dependencies.releaseResource(
        record.resourceId,
        record.owner,
        SESSION_RESOURCE_RELEASE_REASON.PROCESS_MISSING,
      );
      return;
    }
    const previous = mcpCpuSamples.get(record.resourceId);
    if (!previous) {
      mcpCpuSamples.set(record.resourceId, {
        cpuMs, sampledAt: now, strikes: 0, pressureReported: false,
      });
      return;
    }
    const wallMs = now - previous.sampledAt;
    const cpuRatio = wallMs > 0 ? Math.max(0, cpuMs - previous.cpuMs) / wallMs : 0;
    const overThreshold = cpuRatio >= MEMORY_MCP_WATCHDOG.CPU_RATIO_THRESHOLD;
    const strikes = overThreshold
      ? Math.min(previous.strikes + 1, MEMORY_MCP_WATCHDOG.CPU_STRIKE_LIMIT)
      : 0;
    const pressureReported = overThreshold
      && (previous.pressureReported || strikes >= MEMORY_MCP_WATCHDOG.CPU_STRIKE_LIMIT);
    mcpCpuSamples.set(record.resourceId, {
      cpuMs, sampledAt: now, strikes, pressureReported,
    });
    if (pressureReported && !previous.pressureReported) {
      if (record.resourceId.startsWith('mcp-backend:')) {
        // The stable bootstrap owns this generation and will replace it while
        // keeping the SDK's stdio transport/catalog alive. This is the first
        // safe point at which the observed CPU spinner can be terminated
        // rather than logged forever.
        await dependencies.releaseResource(
          record.resourceId,
          record.owner,
          SESSION_RESOURCE_RELEASE_REASON.SUSTAINED_CPU,
        );
        mcpCpuSamples.delete(record.resourceId);
      } else {
        // Rollout compatibility: a legacy direct stdio generation has no
        // supervisor to reconnect its host, so terminating it would strand the
        // session. Report but preserve only that old shape.
        dependencies.reportSustainedCpu?.(record, cpuRatio);
      }
    }
  };
  const candidates = records.filter((record): record is PidResourceRecord =>
    record.kind === SESSION_RESOURCE_KIND.MCP
      && record.handle.type === SESSION_RESOURCE_HANDLE_TYPE.PID,
  );
  // Every pid of the tick is sampled by ONE batched read (a /proc read each on
  // Linux, otherwise a single `ps`/PowerShell spawn) instead of one child
  // process per MCP. What each record then does with its sample (identity
  // recheck, release) still runs in bounded parallel groups.
  const sampledPids = candidates.map((record) => record.handle.pid).filter((pid) => pid !== process.pid);
  const sampled = sampledPids.length > 0 ? await dependencies.sampleCpuMillisBatch(sampledPids) : new Map<number, number>();
  for (let offset = 0; offset < candidates.length; offset += MCP_CPU_SAMPLE_CONCURRENCY) {
    const batch = candidates.slice(offset, offset + MCP_CPU_SAMPLE_CONCURRENCY);
    await Promise.all(batch.map((record) => sampleRecord(record, sampled.get(record.handle.pid))));
  }
  for (const resourceId of mcpCpuSamples.keys()) {
    if (!liveIds.has(resourceId)) mcpCpuSamples.delete(resourceId);
  }
}

interface SessionResourceSweepDependencies {
  sweepExpired: () => Promise<unknown>;
  sweepCpu: () => Promise<unknown>;
  orphanSweep?: {
    listSessions: () => SessionRecord[] | Promise<SessionRecord[]>;
    sweepOrphans: (records: readonly SessionRecord[]) => Promise<unknown>;
  };
  reportError?: (pass: 'expired' | 'orphan' | 'cpu', error: unknown) => void;
}

const sessionResourceSweepDependencies: SessionResourceSweepDependencies = {
  sweepExpired: () => registry.sweepExpired(),
  sweepCpu: sweepMemoryMcpCpu,
  reportError: (pass, error) => {
    process.stderr.write(`[session-resource] ${pass} sweep failed; preserving resources: ${error instanceof Error ? error.message : String(error)}\n`);
  },
};

export function activeSessionResourceRecords(records: readonly SessionRecord[]): SessionRecord[] {
  return records.filter((record) => record.state !== 'stopped' && record.state !== 'error');
}

export function startSessionResourceExpirySweep(
  intervalMs = MEMORY_MCP_WATCHDOG.SAMPLE_INTERVAL_MS,
  dependencies: SessionResourceSweepDependencies = sessionResourceSweepDependencies,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    // Keep destructive passes ordered. A failure in one pass is fail-soft and
    // must never suppress the remaining maintenance work.
    void (async () => {
      try {
        await dependencies.sweepExpired();
      } catch (error) {
        dependencies.reportError?.('expired', error);
      }
      if (dependencies.orphanSweep) {
        try {
          // Only a daemon-owned, already-loaded session store is authority for
          // this pass. Shared/node callers omit orphanSweep entirely.
          const records = await dependencies.orphanSweep.listSessions();
          await dependencies.orphanSweep.sweepOrphans(records);
        } catch (error) {
          // An unavailable/unloaded store is uncertainty, never evidence that
          // all owners died. Preserve every resource and continue the tick.
          dependencies.reportError?.('orphan', error);
        }
      }
      try {
        await dependencies.sweepCpu();
      } catch (error) {
        dependencies.reportError?.('cpu', error);
      }
    })()
      .finally(() => { running = false; });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function initializeSessionResourceLifecycle(
  records: readonly SessionRecord[],
  options: {
    listSessionsForOrphanSweep?: () => SessionRecord[] | Promise<SessionRecord[]>;
  } = {},
): Promise<OrphanSweepSummary> {
  let swept: OrphanSweepSummary = { released: 0, preserved: 0, failed: 0 };
  if (options.listSessionsForOrphanSweep) {
    try {
      swept = await sweepOrphanedSessionResources(await options.listSessionsForOrphanSweep());
    } catch (error) {
      sessionResourceSweepDependencies.reportError?.('orphan', error);
    }
  }
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
  stopExpirySweep = startSessionResourceExpirySweep(
    MEMORY_MCP_WATCHDOG.SAMPLE_INTERVAL_MS,
    options.listSessionsForOrphanSweep
      ? {
        ...sessionResourceSweepDependencies,
        orphanSweep: {
          listSessions: options.listSessionsForOrphanSweep,
          sweepOrphans: sweepOrphanedSessionResources,
        },
      }
      : sessionResourceSweepDependencies,
  );
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
