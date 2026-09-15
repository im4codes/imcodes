import {
  COMPUTER_USE_HTTP_RESPONSE_MAX_BYTES,
  decodeComputerUseHttpEnvelope,
  type ComputerUseHttpReason,
  type ComputerUseOutcome,
  type ComputerUseResult,
  type ComputerUseToolName,
} from '../../shared/computer-use.js';
import type { SessionResourceOwnerIdentity } from '../../shared/session-resource-lifecycle.js';
import { SHARED_MACHINE_AUTHORITY_HEADER } from '../../shared/shared-machine-authority.js';

export interface ComputerUseRemoteOptions {
  serverUrl: string;
  sourceServerId: string;
  sourceToken: string;
  sharedMachineAuthority?: string;
  targetServerId: string;
  tool: ComputerUseToolName;
  arguments?: Record<string, unknown>;
  timeoutMs?: number;
  resourceOwner?: SessionResourceOwnerIdentity;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface ComputerUseRemoteResult {
  outcome: ComputerUseOutcome;
  result?: ComputerUseResult;
  reason?: ComputerUseHttpReason;
  error?: string;
}

function authHeaders(sourceServerId: string, sourceToken: string, sharedMachineAuthority?: string): Record<string, string> {
  return {
    'X-Server-Id': sourceServerId,
    authorization: `Bearer ${sourceToken}`,
    ...(sharedMachineAuthority ? { [SHARED_MACHINE_AUTHORITY_HEADER]: sharedMachineAuthority } : {}),
  };
}

async function readBoundedText(res: Response, maxBytes: number): Promise<string | null> {
  const reader = res.body?.getReader?.();
  if (reader) {
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) { await reader.cancel().catch(() => {}); return null; }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks).toString('utf8');
    } catch { return null; }
  }
  try {
    const text = await res.text();
    return Buffer.byteLength(text, 'utf8') > maxBytes ? null : text;
  } catch { return null; }
}

export async function computerUseCall(opts: ComputerUseRemoteOptions): Promise<ComputerUseRemoteResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.serverUrl.replace(/\/+$/, '');
  let res: Response;
  try {
    res = await doFetch(`${base}/api/machine/computer-use?serverId=${encodeURIComponent(opts.targetServerId)}`, {
      method: 'POST',
      headers: { ...authHeaders(opts.sourceServerId, opts.sourceToken, opts.sharedMachineAuthority), 'content-type': 'application/json' },
      body: JSON.stringify({
        tool: opts.tool,
        ...(opts.arguments ? { arguments: opts.arguments } : {}),
        ...(typeof opts.timeoutMs === 'number' ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.resourceOwner ? { resourceOwner: opts.resourceOwner } : {}),
      }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch {
    return { outcome: 'dispatched_no_result' };
  }
  const text = await readBoundedText(res, COMPUTER_USE_HTTP_RESPONSE_MAX_BYTES);
  if (text === null) return { outcome: 'dispatched_no_result' };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { outcome: 'dispatched_no_result' }; }
  const decoded = decodeComputerUseHttpEnvelope(parsed);
  if (!decoded.ok) return { outcome: 'dispatched_no_result' };
  return {
    outcome: decoded.value.outcome,
    ...(decoded.value.result ? { result: decoded.value.result } : {}),
    ...(decoded.value.reason ? { reason: decoded.value.reason } : {}),
  };
}
