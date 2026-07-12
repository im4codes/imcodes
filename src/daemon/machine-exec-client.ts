// Source-side client for the machine-exec relay (core of MCP tools 5.2). A FULL
// daemon calls these with ITS OWN serverId + token; the server resolves the
// target independently and enforces authz. Returns the end-to-end outcome union
// (never collapsed), so the agent tool can distinguish "did not run" (retry-safe)
// from "indeterminate" from a real command result.
import type { RemoteExecOutcome, RemoteExecShell, MachineSummary } from '../../shared/remote-exec.js';

export interface ExecRemoteOptions {
  serverUrl: string;
  sourceServerId: string;
  sourceToken: string;
  targetServerId: string;
  command: string;
  shell?: RemoteExecShell;
  timeoutMs?: number;
  idempotencyKey?: string;
  fetchImpl?: typeof fetch;
}

export interface ExecRemoteResult {
  outcome: RemoteExecOutcome;
  ok?: boolean;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  truncated?: boolean;
  durationMs?: number;
  error?: string;
}

function authHeaders(sourceServerId: string, sourceToken: string): Record<string, string> {
  return { 'X-Server-Id': sourceServerId, authorization: `Bearer ${sourceToken}` };
}

/** Run a one-shot command on a controlled target via the relay. Never throws on a well-formed HTTP error. */
export async function execRemote(opts: ExecRemoteOptions): Promise<ExecRemoteResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.serverUrl.replace(/\/+$/, '');
  const url = `${base}/api/machine/exec?serverId=${encodeURIComponent(opts.targetServerId)}`;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { ...authHeaders(opts.sourceServerId, opts.sourceToken), 'content-type': 'application/json' },
      body: JSON.stringify({
        command: opts.command,
        ...(opts.shell ? { shell: opts.shell } : {}),
        ...(typeof opts.timeoutMs === 'number' ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      }),
    });
  } catch (err) {
    // The relay was unreachable → the command definitively did not run.
    return { outcome: 'not_dispatched', error: `relay_unreachable: ${(err as Error).message}` };
  }
  const data = (await res.json().catch(() => ({}))) as Partial<ExecRemoteResult> & { reason?: string; error?: string };
  // Authz / validation failures are transport-level "did not run" (retry-safe).
  if (res.status >= 400 && !data.outcome) {
    return { outcome: 'not_dispatched', error: data.reason ?? data.error ?? `http_${res.status}` };
  }
  return { outcome: data.outcome ?? 'dispatched_no_result', ...data };
}

/** List the account's controllable machines with DB-backed presence. */
export async function listMachines(opts: {
  serverUrl: string; sourceServerId: string; sourceToken: string; includeOffline?: boolean; fetchImpl?: typeof fetch;
}): Promise<(MachineSummary & { refName: string; displayName: string; execEnabled: boolean })[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.serverUrl.replace(/\/+$/, '');
  const res = await doFetch(`${base}/api/machines`, { headers: authHeaders(opts.sourceServerId, opts.sourceToken) });
  if (!res.ok) return [];
  const data = (await res.json().catch(() => ({}))) as { machines?: (MachineSummary & { refName: string; displayName: string; execEnabled: boolean })[] };
  const machines = data.machines ?? [];
  // Agent-facing list excludes offline + exec-disabled unless explicitly asked (spec).
  return opts.includeOffline ? machines : machines.filter((m) => m.online && m.execEnabled);
}
