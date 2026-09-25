export const SESSION_RESOURCE_KIND = {
  MCP: 'mcp',
  TMUX: 'tmux',
  BROWSER: 'browser',
  CONTAINER: 'container',
  /**
   * A session-owned agent CLI process that leads its own POSIX process group.
   *
   * Deliberately NOT reusing MCP: the memory-MCP CPU sweeper only inspects
   * MCP-kind records and can release them as PROCESS_MISSING, which for a
   * long-running agent CLI would be a wrong kill. A distinct kind keeps the
   * startup fingerprint sweep while staying out of that sampler.
   */
  AGENT: 'agent',
} as const;

export type SessionResourceKind = typeof SESSION_RESOURCE_KIND[keyof typeof SESSION_RESOURCE_KIND];

export interface SessionResourceOwnerIdentity {
  sessionName: string;
  sessionInstanceId: string;
  runtimeEpoch: string;
}

export function isSessionResourceOwnerIdentity(value: unknown): value is SessionResourceOwnerIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  return ['sessionName', 'sessionInstanceId', 'runtimeEpoch'].every((key) => (
    typeof owner[key] === 'string'
    && owner[key].length > 0
    && new TextEncoder().encode(owner[key] as string).byteLength <= 512
  )) && Object.keys(owner).every((key) => (
    key === 'sessionName' || key === 'sessionInstanceId' || key === 'runtimeEpoch'
  ));
}

/**
 * Who bounds a resource's life.
 *
 * RUNTIME (the default when absent): the resource belongs to one runtime epoch
 * of its owner session, so relaunch child-cleanup and the orphan sweep may reap
 * it.
 *
 * PROVIDER_HOST: an MCP stdio process spawned by a provider process that is
 * SHARED across sessions and OUTLIVES a session relaunch -- a codex-sdk
 * thread's MCP server, which is a child of the one Codex app-server. Codex
 * keeps the thread loaded across our relaunch and a `thread/resume` of a loaded
 * thread never restarts its MCP servers, so reaping this process by owner/epoch
 * leaves the live thread bound to a closed pipe ("Transport closed") until an
 * explicit MCP reload. Its lifetime is bound to its host instead: the stdio
 * lifecycle guard exits it on EOF or when the host process goes away.
 */
export const SESSION_RESOURCE_LIFETIME = {
  RUNTIME: 'runtime',
  PROVIDER_HOST: 'provider_host',
} as const;

export type SessionResourceLifetime = typeof SESSION_RESOURCE_LIFETIME[keyof typeof SESSION_RESOURCE_LIFETIME];

/** Env through which a provider declares a hosted MCP server's lifetime. */
export const IMCODES_MCP_HOST_LIFETIME_ENV = 'IMCODES_MCP_HOST_LIFETIME';

export function sessionResourceLifetimeFromEnv(
  env: Record<string, string | undefined>,
): SessionResourceLifetime | undefined {
  return env[IMCODES_MCP_HOST_LIFETIME_ENV]?.trim() === SESSION_RESOURCE_LIFETIME.PROVIDER_HOST
    ? SESSION_RESOURCE_LIFETIME.PROVIDER_HOST
    : undefined;
}

export const SESSION_RESOURCE_HANDLE_TYPE = {
  PID: 'pid',
  TMUX: 'tmux',
  PODMAN: 'podman',
} as const;

export const SESSION_RESOURCE_RELEASE_REASON = {
  SESSION_COMPLETED: 'session_completed',
  ORPHANED: 'orphaned',
  TTL_EXPIRED: 'ttl_expired',
  IDLE_EXPIRED: 'idle_expired',
  PROCESS_MISSING: 'process_missing',
  SUSTAINED_CPU: 'sustained_cpu',
} as const;

export const SESSION_RESOURCE_DEFAULTS = {
  ORPHAN_GRACE_MS: 60_000,
  BROWSER_TTL_MS: 60 * 60_000,
  BROWSER_IDLE_TIMEOUT_MS: 15 * 60_000,
  CONTAINER_TTL_MS: 2 * 60 * 60_000,
  CONTAINER_IDLE_TIMEOUT_MS: 30 * 60_000,
} as const;

export const SESSION_RESOURCE_OWNER_ENV = {
  SESSION_INSTANCE_ID: 'IMCODES_RESOURCE_SESSION_INSTANCE_ID',
  RUNTIME_EPOCH: 'IMCODES_RESOURCE_RUNTIME_EPOCH',
} as const;

export const MEMORY_MCP_RESOURCE_ERROR = {
  CONCURRENCY_LIMIT: 'memory_mcp_concurrency_limit',
  CPU_OVERLOAD: 'memory_mcp_cpu_overload',
  MEMORY_LIMIT: 'memory_mcp_memory_limit',
  REQUEST_TIMEOUT: 'memory_mcp_request_timeout',
} as const;

export const MEMORY_MCP_WATCHDOG = {
  SAMPLE_INTERVAL_MS: 10_000,
  CPU_RATIO_THRESHOLD: 0.9,
  CPU_STRIKE_LIMIT: 6,
  CPU_RECOVERY_WINDOW_LIMIT: 2,
} as const;

export const TASK_ADMISSION = {
  ACCEPT: 'accept',
  QUEUE: 'queue',
  REJECT: 'reject',
} as const;

export const TASK_ADMISSION_OPERATION = {
  ACQUIRE: 'acquire',
  RELEASE: 'release',
} as const;

export const TASK_ADMISSION_HOOK_PATH = '/resource-admission';

export type TaskAdmission = typeof TASK_ADMISSION[keyof typeof TASK_ADMISSION];

export const TASK_ADMISSION_QUEUE_RATIO = 0.85;

const SESSION_LAUNCH_IDENTITY_MARKER = Symbol.for('imcodes.session-launch-identity');

/** Marks a freshly minted identity without widening persisted SessionRecord JSON. */
export function markSessionLaunchIdentity<T extends object>(record: T): T {
  Object.defineProperty(record, SESSION_LAUNCH_IDENTITY_MARKER, { value: true, enumerable: false });
  return record;
}

export function isMarkedSessionLaunchIdentity(record: object): boolean {
  return (record as Record<symbol, unknown>)[SESSION_LAUNCH_IDENTITY_MARKER] === true;
}
