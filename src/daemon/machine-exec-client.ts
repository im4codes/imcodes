// Source-side client for the machine-exec relay (core of MCP tools 5.2). A FULL
// daemon calls these with ITS OWN serverId + token; the server resolves the
// target independently and enforces authz. Returns the end-to-end outcome union
// (never collapsed), so the agent tool can distinguish "did not run" (retry-safe)
// from "indeterminate" from a real command result.
//
// Trust-boundary rules (controlled-node-remote-exec, transport safety):
//   * The exec response is decoded by the SHARED strict decoder
//     (`decodeMachineExecHttpEnvelope`: protocol + version + outcome + reason +
//     unknown-key + cross-field). ANY ambiguity — fetch rejection, non-2xx body,
//     wrong protocol/version, illegal outcome/reason, forbidden/missing result
//     fields, oversized body — maps to `dispatched_no_result` (INDETERMINATE),
//     never `not_dispatched`, because the command MAY already have run.
//   * Bodies are read with the shared escaping-aware byte cap
//     (`MACHINE_EXEC_HTTP_RESPONSE_MAX_BYTES`) so a mis-routed/compromised
//     endpoint cannot make a FULL daemon buffer unbounded output.
//   * `listMachines` throws a typed `MachineControlPlaneError` (kind `unbound` /
//     `transport` / `http_status` / `malformed`) on any failure — only a valid,
//     bounded `{machines:[...]}` with canonical items is a real account list.
import {
  canonicalMachineOs,
  decodeMachineExecHttpEnvelope,
  MACHINE_EXEC_HTTP_RESPONSE_MAX_BYTES,
  MACHINE_LIST_MAX_ITEMS,
  NODE_ROLE,
  type RemoteExecOutcome,
  type RemoteExecShell,
  type MachineSummary,
} from '../../shared/remote-exec.js';

export interface ExecRemoteOptions {
  serverUrl: string;
  sourceServerId: string;
  sourceToken: string;
  targetServerId: string;
  command: string;
  shell?: RemoteExecShell;
  timeoutMs?: number;
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

/** Machine control-plane call failed or returned an unusable response (distinct from "no machines"). */
export class MachineControlPlaneError extends Error {
  constructor(
    public readonly kind: 'unbound' | 'transport' | 'http_status' | 'malformed',
    message: string,
  ) {
    super(message);
    this.name = 'MachineControlPlaneError';
  }
}

/** List responses are small JSON; bound independently of the exec output envelope. */
const MAX_LIST_RESPONSE_BYTES = 1_000_000;

function authHeaders(sourceServerId: string, sourceToken: string): Record<string, string> {
  return { 'X-Server-Id': sourceServerId, authorization: `Bearer ${sourceToken}` };
}

/**
 * Read a response body as UTF-8 with a hard byte cap. Prefers streaming so an
 * over-cap body is cancelled without full buffering; falls back to text/json for
 * injected mocks. Returns null on over-cap or any read error.
 */
async function readBoundedText(res: Response, maxBytes: number): Promise<string | null> {
  const anyRes = res as unknown as {
    body?: { getReader?: () => ReadableStreamDefaultReader<Uint8Array> };
    text?: () => Promise<string>;
    json?: () => Promise<unknown>;
  };
  const reader = anyRes.body?.getReader?.();
  if (reader) {
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > maxBytes) { await reader.cancel().catch(() => {}); return null; }
          chunks.push(Buffer.from(value));
        }
      }
    } catch { return null; }
    return Buffer.concat(chunks).toString('utf8');
  }
  try {
    if (typeof anyRes.text === 'function') {
      const t = await anyRes.text();
      return Buffer.byteLength(t, 'utf8') > maxBytes ? null : t;
    }
    if (typeof anyRes.json === 'function') {
      const t = JSON.stringify(await anyRes.json());
      return Buffer.byteLength(t, 'utf8') > maxBytes ? null : t;
    }
  } catch { return null; }
  return null;
}

/** Run a one-shot command on a controlled target via the relay. Never throws; ambiguity → indeterminate. */
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
      }),
    });
  } catch {
    // Transport failed AFTER the request may have been sent → indeterminate.
    return { outcome: 'dispatched_no_result' };
  }
  const text = await readBoundedText(res, MACHINE_EXEC_HTTP_RESPONSE_MAX_BYTES);
  if (text === null) return { outcome: 'dispatched_no_result' };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { outcome: 'dispatched_no_result' }; }
  const decoded = decodeMachineExecHttpEnvelope(parsed);
  if (!decoded.ok) return { outcome: 'dispatched_no_result' };
  const e = decoded.value;
  return {
    outcome: e.outcome,
    ...(e.ok !== undefined ? { ok: e.ok } : {}),
    ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
    ...(e.stdout !== undefined ? { stdout: e.stdout } : {}),
    ...(e.stderr !== undefined ? { stderr: e.stderr } : {}),
    ...(e.timedOut !== undefined ? { timedOut: e.timedOut } : {}),
    ...(e.truncated !== undefined ? { truncated: e.truncated } : {}),
    ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
    ...(e.error !== undefined ? { error: e.error } : {}),
  };
}

type MachineListItem = MachineSummary & { refName: string; displayName: string; execEnabled: boolean };

const MACHINE_LIST_ITEM_KEYS: ReadonlySet<string> = new Set([
  'serverId', 'name', 'refName', 'displayName', 'online', 'nodeRole', 'execEnabled', 'os', 'lastSeenMs',
]);

/** Strict per-item validation: known keys only, controlled role, canonical OS (or absent). */
function isValidMachineListItem(v: unknown): v is MachineListItem {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  for (const key of Object.keys(m)) if (!MACHINE_LIST_ITEM_KEYS.has(key)) return false;
  if (typeof m.serverId !== 'string' || m.serverId.length === 0
    || typeof m.name !== 'string' || m.name.length === 0
    || typeof m.refName !== 'string' || m.refName.length === 0
    || typeof m.displayName !== 'string') return false;
  if (typeof m.online !== 'boolean' || typeof m.execEnabled !== 'boolean') return false;
  if (m.nodeRole !== NODE_ROLE.CONTROLLED) return false;
  if (m.os !== undefined && canonicalMachineOs(m.os) === undefined) return false;
  if (m.lastSeenMs !== undefined && (typeof m.lastSeenMs !== 'number' || !Number.isFinite(m.lastSeenMs))) return false;
  return true;
}

/**
 * List the account's controllable machines with DB-backed presence. Throws a
 * `MachineControlPlaneError` on any non-2xx / malformed / over-limit response;
 * only a valid, bounded `{machines:[...]}` is a real (possibly empty) list.
 */
export async function listMachines(opts: {
  serverUrl: string; sourceServerId: string; sourceToken: string; includeOffline?: boolean; fetchImpl?: typeof fetch;
}): Promise<MachineListItem[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.serverUrl.replace(/\/+$/, '');
  let res: Response;
  try {
    res = await doFetch(`${base}/api/machines`, { headers: authHeaders(opts.sourceServerId, opts.sourceToken) });
  } catch (err) {
    throw new MachineControlPlaneError('transport', `machines API unreachable: ${(err as Error).message}`);
  }
  if (!res.ok) throw new MachineControlPlaneError('http_status', `machines API returned http_${res.status}`);
  const text = await readBoundedText(res, MAX_LIST_RESPONSE_BYTES);
  if (text === null) throw new MachineControlPlaneError('malformed', 'machines API response exceeded byte cap or was unreadable');
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new MachineControlPlaneError('malformed', 'machines API response was not valid JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || Object.keys(data as Record<string, unknown>).some((key) => key !== 'machines')) {
    throw new MachineControlPlaneError('malformed', 'machines API response had an invalid envelope');
  }
  const machines = (data as { machines?: unknown }).machines;
  if (!Array.isArray(machines)) throw new MachineControlPlaneError('malformed', 'machines API response had no machines array');
  if (machines.length > MACHINE_LIST_MAX_ITEMS) throw new MachineControlPlaneError('malformed', `machines API returned more than ${MACHINE_LIST_MAX_ITEMS} items`);
  if (!machines.every(isValidMachineListItem)) throw new MachineControlPlaneError('malformed', 'machines API returned an item failing strict validation');
  const items = machines as MachineListItem[];
  // Agent-facing list excludes offline + exec-disabled unless explicitly asked (spec).
  return opts.includeOffline ? items : items.filter((m) => m.online && m.execEnabled);
}
