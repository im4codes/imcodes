import {
  PORT_FORWARD_API_PATH,
  PORT_FORWARD_ERRORS,
  PORT_FORWARD_LIMITS,
  type PortForwardErrorCode,
  type PortForwardTransportPref,
  type PortForwardTunnelSummary,
} from '../../shared/port-forward.js';
import { SHARED_MACHINE_AUTHORITY_HEADER } from '../../shared/shared-machine-authority.js';
import { readBoundedText } from './machine-exec-client.js';

export interface PortForwardClientAuth {
  serverUrl: string;
  sourceServerId: string;
  sourceToken: string;
  sharedMachineAuthority?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface OpenPortForwardOptions extends PortForwardClientAuth {
  listenNode?: string;
  targetNode: string;
  listenPort?: number;
  targetHost?: string;
  targetPort: number;
  ttlSeconds?: number;
  transport?: PortForwardTransportPref;
  label?: string;
}

export type OpenPortForwardResponse =
  | { ok: true; tunnel: PortForwardTunnelSummary }
  | { ok: false; reason: PortForwardErrorCode; error: string };

export interface ListPortForwardsOptions extends PortForwardClientAuth {
  node?: string;
}

export type ListPortForwardsResponse =
  | { ok: true; tunnels: PortForwardTunnelSummary[] }
  | { ok: false; reason: PortForwardErrorCode; error: string };

export interface ClosePortForwardOptions extends PortForwardClientAuth {
  tunnelId?: string;
  all?: boolean;
  node?: string;
}

export type ClosePortForwardResponse =
  | { ok: true; closedCount: number; closedTunnelIds: string[] }
  | { ok: false; reason: PortForwardErrorCode; error: string };

function headersFor(opts: PortForwardClientAuth, withJson = false): Record<string, string> {
  return {
    'X-Server-Id': opts.sourceServerId,
    authorization: `Bearer ${opts.sourceToken}`,
    ...(opts.sharedMachineAuthority ? { [SHARED_MACHINE_AUTHORITY_HEADER]: opts.sharedMachineAuthority } : {}),
    ...(withJson ? { 'content-type': 'application/json' } : {}),
  };
}

function endpointUrl(serverUrl: string, suffix: string, query: Record<string, string | undefined>): string {
  const base = serverUrl.replace(/\/$/, '');
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) params.set(k, v);
  }
  const qs = params.toString();
  return `${base}${PORT_FORWARD_API_PATH}${suffix}${qs ? `?${qs}` : ''}`;
}

async function parseControlResponse(res: Response): Promise<Record<string, unknown> | null> {
  const raw = await readBoundedText(res, PORT_FORWARD_LIMITS.MAX_CONTROL_BYTES);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function errorFromPayload(
  payload: Record<string, unknown> | null,
  status: number,
  fallbackMessage: string,
): { ok: false; reason: PortForwardErrorCode; error: string } {
  const reason = typeof payload?.reason === 'string'
    ? payload.reason as PortForwardErrorCode
    : status === 401 || status === 403
      ? PORT_FORWARD_ERRORS.TARGET_FORBIDDEN
      : status === 429
        ? PORT_FORWARD_ERRORS.RATE_LIMITED
        : PORT_FORWARD_ERRORS.INTERNAL_ERROR;
  const error = typeof payload?.error === 'string' && payload.error.length > 0
    ? payload.error
    : `${fallbackMessage} (HTTP ${status})`;
  return { ok: false, reason, error };
}

export async function openPortForward(opts: OpenPortForwardOptions): Promise<OpenPortForwardResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = endpointUrl(opts.serverUrl, '', { serverId: opts.sourceServerId });
  const body = {
    ...(opts.listenNode !== undefined ? { listenNode: opts.listenNode } : {}),
    targetNode: opts.targetNode,
    ...(opts.listenPort !== undefined ? { listenPort: opts.listenPort } : {}),
    ...(opts.targetHost !== undefined ? { targetHost: opts.targetHost } : {}),
    targetPort: opts.targetPort,
    ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}),
    ...(opts.transport !== undefined ? { transport: opts.transport } : {}),
    ...(opts.label !== undefined ? { label: opts.label } : {}),
  };

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: headersFor(opts, true),
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    return {
      ok: false,
      reason: PORT_FORWARD_ERRORS.INTERNAL_ERROR,
      error: err instanceof Error ? err.message : 'port_forward_open request failed',
    };
  }

  const payload = await parseControlResponse(res);
  if (!res.ok || payload?.ok !== true || !payload.tunnel || typeof payload.tunnel !== 'object') {
    return errorFromPayload(payload, res.status, 'failed to open port forward');
  }
  return { ok: true, tunnel: payload.tunnel as PortForwardTunnelSummary };
}

export async function listPortForwards(opts: ListPortForwardsOptions): Promise<ListPortForwardsResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = endpointUrl(opts.serverUrl, '', {
    serverId: opts.sourceServerId,
    ...(opts.node !== undefined ? { node: opts.node } : {}),
  });

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: headersFor(opts),
      signal: opts.signal,
    });
  } catch (err) {
    return {
      ok: false,
      reason: PORT_FORWARD_ERRORS.INTERNAL_ERROR,
      error: err instanceof Error ? err.message : 'port_forward_list request failed',
    };
  }

  const payload = await parseControlResponse(res);
  if (!res.ok || payload?.ok !== true || !Array.isArray(payload.tunnels)) {
    return errorFromPayload(payload, res.status, 'failed to list port forwards');
  }
  return { ok: true, tunnels: payload.tunnels as PortForwardTunnelSummary[] };
}

export async function closePortForward(opts: ClosePortForwardOptions): Promise<ClosePortForwardResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const suffix = opts.tunnelId && !opts.all ? `/${encodeURIComponent(opts.tunnelId)}` : '';
  const url = endpointUrl(opts.serverUrl, suffix, {
    serverId: opts.sourceServerId,
    ...(opts.node !== undefined && !suffix ? { node: opts.node } : {}),
  });

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'DELETE',
      headers: headersFor(opts),
      signal: opts.signal,
    });
  } catch (err) {
    return {
      ok: false,
      reason: PORT_FORWARD_ERRORS.INTERNAL_ERROR,
      error: err instanceof Error ? err.message : 'port_forward_close request failed',
    };
  }

  const payload = await parseControlResponse(res);
  if (!res.ok || payload?.ok !== true || !Array.isArray(payload.closedTunnelIds)) {
    return errorFromPayload(payload, res.status, 'failed to close port forward');
  }
  return {
    ok: true,
    closedCount: typeof payload.closedCount === 'number' ? payload.closedCount : payload.closedTunnelIds.length,
    closedTunnelIds: payload.closedTunnelIds.filter((id): id is string => typeof id === 'string'),
  };
}
