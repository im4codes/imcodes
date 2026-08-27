/**
 * The daemon's virtual-display proxy.
 *
 * A worker never speaks to the resident agent. It asks the daemon, over the IPC
 * socket the daemon already authenticated it on, and the daemon forwards a
 * request it AUTHORS ITSELF onto the one long-lived agent lease.
 *
 * WHY AUTHORED, NOT FORWARDED
 *
 * Forwarding the worker's own control line would let a worker name any route
 * generation it liked, including one belonging to another session. The daemon
 * therefore builds the line from the generation it AUTHENTICATED at hello time
 * and discards whatever the frame claimed. A worker cannot ask about a route it
 * does not own because there is no field in which to ask.
 *
 * WHAT NEVER CROSSES
 *
 * The helper's descriptor, epoch and cookie seed. Those belong to the agent's
 * private channel to the supervised helper. What a worker receives is a ROUTE
 * capability -- a different epoch and a different seed, for a credential the
 * agent can revoke without touching the helper.
 *
 * READINESS IS ZERO MUTATION. The status question asks the agent what it
 * already knows. It cannot hold, enable, create or spawn, and there is no
 * request shape in which it could: `readiness` carries a nonce and nothing else.
 */

import type { Socket } from 'node:net';

/** Mirrors kVirtualDisplayControlMaxBytes in the native control protocol. */
export const MACOS_VIRTUAL_DISPLAY_PROXY_MAX_LINE_BYTES = 512 as const;
/** Bounded wait for one agent round trip. A silent agent is a false answer. */
export const MACOS_VIRTUAL_DISPLAY_PROXY_TIMEOUT_MS = 5_000 as const;

export const MACOS_VIRTUAL_DISPLAY_PROXY_OP = Object.freeze({
  /** Zero-mutation status question. Carries a nonce and nothing else. */
  READINESS: 'readiness',
  /** Ask the agent for this route's capability. */
  ROUTE: 'route',
  /** Semantic display actions, authenticated by the route capability. */
  HOLD: 'hold',
  ENABLE: 'enable',
  STATUS: 'status',
  DISABLE: 'disable',
} as const);

export type MacosVirtualDisplayProxyOp =
  typeof MACOS_VIRTUAL_DISPLAY_PROXY_OP[keyof typeof MACOS_VIRTUAL_DISPLAY_PROXY_OP];

const RELAY_OPS: ReadonlySet<string> = new Set([
  MACOS_VIRTUAL_DISPLAY_PROXY_OP.HOLD,
  MACOS_VIRTUAL_DISPLAY_PROXY_OP.ENABLE,
  MACOS_VIRTUAL_DISPLAY_PROXY_OP.STATUS,
  MACOS_VIRTUAL_DISPLAY_PROXY_OP.DISABLE,
]);

const MAX_UINT32 = 0xffff_fffe;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export interface MacosVirtualDisplayProxyRequest {
  readonly op: MacosVirtualDisplayProxyOp;
  /** READINESS only. Echoed back so an answer cannot be replayed as fresh. */
  readonly nonce?: number;
  /** Relay only: the ROUTE capability the agent issued to this generation. */
  readonly routeEpoch?: number;
  readonly routeCookie?: number;
  readonly requestIndex?: number;
  /** ENABLE and DISABLE name a display; HOLD and STATUS do not. */
  readonly displayId?: number;
  /** ENABLE only, in exact units. */
  readonly pixelsWide?: number;
  readonly pixelsHigh?: number;
  readonly refreshMilliHertz?: number;
  readonly scalePercent?: number;
}

export interface MacosVirtualDisplayProxyReply {
  readonly ok: boolean;
  readonly error?: string;
  readonly nonce?: number;
  readonly qualifiedToCreate?: boolean;
  readonly displayControlAdmitted?: boolean;
  readonly routeGeneration?: number;
  readonly routeEpoch?: number;
  readonly cookieSeed?: number;
  readonly uid?: number;
  readonly displayId?: number;
  readonly admitted?: boolean;
  readonly presence?: string;
}

function positiveSafe(value: unknown, maximum = MAX_SAFE): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value > 0 && value <= maximum;
}

function absent(value: unknown): boolean {
  return value === undefined;
}

/**
 * Refuses any key the op does not define.
 *
 * Checking only that the KNOWN fields are absent is not enough: an unrecognised
 * key slips through, and a peer that described something we did not understand
 * has been acted on anyway. A `routeGeneration` field smuggled onto a route
 * request was accepted and silently ignored until this existed -- which reads,
 * to whoever sent it, exactly like it was honoured.
 */
function hasExactKeys(
  record: Record<string, unknown>, allowed: readonly string[],
): boolean {
  const keys = Object.keys(record);
  if (keys.length > allowed.length) return false;
  return keys.every((key) => allowed.includes(key));
}

/**
 * Refuses a request whose fields do not belong to its op.
 *
 * Carrying a field the op has no meaning for is a peer describing an action the
 * daemon will not take; silently dropping the description is how a mode
 * selection is lost without anyone being told.
 */
export function validateVirtualDisplayProxyRequest(
  value: unknown,
): MacosVirtualDisplayProxyRequest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  const op = request.op;
  if (typeof op !== 'string') return null;

  if (op === MACOS_VIRTUAL_DISPLAY_PROXY_OP.READINESS) {
    // A nonce and NOTHING else. There is no shape in which readiness could ask
    // for a mutation, which is stronger than checking that it did not.
    if (!hasExactKeys(request, ['op', 'nonce'])) return null;
    if (!positiveSafe(request.nonce)) return null;
    return { op, nonce: request.nonce };
  }

  if (op === MACOS_VIRTUAL_DISPLAY_PROXY_OP.ROUTE) {
    // Asking for a capability carries no credential: the peer has none yet.
    // The route generation is NOT taken from here -- it is the one the daemon
    // authenticated at hello time.
    if (!hasExactKeys(request, ['op'])) return null;
    return { op };
  }

  if (!RELAY_OPS.has(op)) return null;
  if (!positiveSafe(request.routeEpoch) || !positiveSafe(request.routeCookie)
    || !positiveSafe(request.requestIndex) || !absent(request.nonce)) return null;

  const relay = {
    op: op as MacosVirtualDisplayProxyOp,
    routeEpoch: request.routeEpoch,
    routeCookie: request.routeCookie,
    requestIndex: request.requestIndex,
  };

  if (op === MACOS_VIRTUAL_DISPLAY_PROXY_OP.ENABLE) {
    if (!hasExactKeys(request, ['op', 'routeEpoch', 'routeCookie', 'requestIndex',
                                'displayId', 'pixelsWide', 'pixelsHigh',
                                'refreshMilliHertz', 'scalePercent'])) return null;
    if (!positiveSafe(request.displayId, MAX_UINT32)
      || !positiveSafe(request.pixelsWide, 16_384)
      || !positiveSafe(request.pixelsHigh, 16_384)
      || !positiveSafe(request.refreshMilliHertz, 240_000)
      || !positiveSafe(request.scalePercent, 400)) return null;
    return {
      ...relay,
      displayId: request.displayId,
      pixelsWide: request.pixelsWide,
      pixelsHigh: request.pixelsHigh,
      refreshMilliHertz: request.refreshMilliHertz,
      scalePercent: request.scalePercent,
    };
  }
  if (op === MACOS_VIRTUAL_DISPLAY_PROXY_OP.DISABLE) {
    if (!hasExactKeys(request, ['op', 'routeEpoch', 'routeCookie', 'requestIndex',
                                'displayId'])) return null;
    if (!positiveSafe(request.displayId, MAX_UINT32)) return null;
    return { ...relay, displayId: request.displayId };
  }
  // HOLD and STATUS address no display and carry no mode.
  if (!hasExactKeys(request, ['op', 'routeEpoch', 'routeCookie', 'requestIndex']))
    return null;
  return relay;
}

/**
 * Builds the control line the agent will see.
 *
 * `routeGeneration` comes from the AUTHENTICATED session, never from the
 * request. That single substitution is what stops a worker asking about a route
 * it does not own -- there is no field in which to ask.
 */
export function authorVirtualDisplayControlLine(
  request: MacosVirtualDisplayProxyRequest,
  routeGeneration: number,
): string | null {
  if (!positiveSafe(routeGeneration)) return null;
  const parts: string[] = ['ctl1'];
  switch (request.op) {
    case MACOS_VIRTUAL_DISPLAY_PROXY_OP.READINESS:
      parts.push('verb=ready', `nonce=${request.nonce}`);
      break;
    case MACOS_VIRTUAL_DISPLAY_PROXY_OP.ROUTE:
      parts.push('verb=route', `rgen=${routeGeneration}`);
      break;
    default: {
      parts.push('verb=relay', `rgen=${routeGeneration}`,
        `repoch=${request.routeEpoch}`, `rcookie=${request.routeCookie}`,
        `ridx=${request.requestIndex}`, `op=${request.op}`);
      if (request.displayId !== undefined) parts.push(`display=${request.displayId}`);
      if (request.op === MACOS_VIRTUAL_DISPLAY_PROXY_OP.ENABLE) {
        parts.push(`w=${request.pixelsWide}`, `h=${request.pixelsHigh}`,
          `hz=${request.refreshMilliHertz}`, `scale=${request.scalePercent}`);
      }
      break;
    }
  }
  const line = parts.join(' ');
  // Refused rather than truncated: a truncated control line is a different
  // request, and the agent would answer that one instead.
  return line.length > MACOS_VIRTUAL_DISPLAY_PROXY_MAX_LINE_BYTES ? null : line;
}

/**
 * The only presence values the control protocol defines.
 *
 * Mirrors `IsPresenceToken` in macos_virtual_display_control_protocol.cc. An
 * unrecognised presence is refused rather than passed through: a caller that
 * switches on it would fall to its default branch, and the default branch of a
 * display-state question is the one that reads as "not shown".
 */
const PRESENCE_TOKENS: ReadonlySet<string> = new Set(['absent', 'inactive', 'active']);

/** Exactly the keys each op's answer may carry. Anything else is a refusal. */
const REPLY_SHAPE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [MACOS_VIRTUAL_DISPLAY_PROXY_OP.READINESS]: ['ok', 'nonce', 'qualified', 'admittedctl'],
  [MACOS_VIRTUAL_DISPLAY_PROXY_OP.ROUTE]: ['ok', 'rgen', 'repoch', 'seed', 'uid'],
  [MACOS_VIRTUAL_DISPLAY_PROXY_OP.HOLD]: ['ok', 'display', 'admitted', 'presence'],
  [MACOS_VIRTUAL_DISPLAY_PROXY_OP.ENABLE]: ['ok', 'display', 'admitted', 'presence'],
  [MACOS_VIRTUAL_DISPLAY_PROXY_OP.STATUS]: ['ok', 'display', 'admitted', 'presence'],
  [MACOS_VIRTUAL_DISPLAY_PROXY_OP.DISABLE]: ['ok', 'display', 'admitted', 'presence'],
});

/**
 * Parses one `ctl1r ...` reply against the canonical shape for its op.
 *
 * The op is REQUIRED. A parser that could be called without one is exactly the
 * hole this closes: the previous version accepted any key set, so a readiness
 * answer carrying route capability fields, or a route answer carrying no
 * capability at all, both read as success.
 *
 * Booleans are `0` or `1` and nothing else. Treating every non-`1` value as
 * false silently converts a malformed `qualified=2` into a definite negative,
 * which is an answer this daemon never actually received.
 */
export function parseVirtualDisplayControlReply(
  line: string,
  op: MacosVirtualDisplayProxyOp,
  authoredRouteGeneration?: number,
): MacosVirtualDisplayProxyReply {
  const refused = (error: string): MacosVirtualDisplayProxyReply => ({ ok: false, error });
  if (typeof line !== 'string' || line.length === 0
    || line.length > MACOS_VIRTUAL_DISPLAY_PROXY_MAX_LINE_BYTES) {
    return refused('agent_frame_unusable');
  }
  if (!line.startsWith('ctl1r ')) return refused('agent_frame_unusable');
  const allowed = REPLY_SHAPE[op];
  if (allowed === undefined) return refused('agent_frame_unusable');

  const fields = new Map<string, string>();
  for (const token of line.slice('ctl1r '.length).split(' ')) {
    const separator = token.indexOf('=');
    if (separator <= 0) return refused('agent_frame_unusable');
    const key = token.slice(0, separator);
    if (fields.has(key)) return refused('agent_frame_unusable');
    fields.set(key, token.slice(separator + 1));
  }

  const ok = fields.get('ok');
  if (ok !== '0' && ok !== '1') return refused('agent_frame_unusable');

  if (ok === '0') {
    // A refusal is exactly `ok=0 error=<token>`. Extra fields on a refusal are
    // a frame we do not understand, and understanding half of a refusal is how
    // a reason gets attributed to the wrong request.
    if (fields.size !== 2) return refused('agent_frame_unusable');
    const error = fields.get('error');
    if (error === undefined || error.length === 0 || error.length > 64
      || !/^[a-z0-9_]+$/u.test(error)) {
      return refused('agent_frame_unusable');
    }
    return refused(error);
  }

  for (const key of fields.keys()) {
    if (!allowed.includes(key)) return refused('agent_frame_unusable');
  }

  const flag = (key: string): boolean | null => {
    const raw = fields.get(key);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return null;
  };
  const number = (key: string): number | null => {
    const raw = fields.get(key);
    if (raw === undefined) return null;
    // No leading zero run: `042` and `42` must not both parse to 42, or two
    // different frames correlate to one request.
    if (!/^(?:0|[1-9]\d*)$/u.test(raw)) return null;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };

  if (op === MACOS_VIRTUAL_DISPLAY_PROXY_OP.READINESS) {
    const nonce = number('nonce');
    const qualified = flag('qualified');
    const admittedControl = flag('admittedctl');
    if (nonce === null || nonce <= 0 || qualified === null || admittedControl === null) {
      return refused('agent_frame_unusable');
    }
    return {
      ok: true,
      nonce,
      qualifiedToCreate: qualified,
      displayControlAdmitted: admittedControl,
    };
  }

  if (op === MACOS_VIRTUAL_DISPLAY_PROXY_OP.ROUTE) {
    const routeGeneration = number('rgen');
    const routeEpoch = number('repoch');
    const cookieSeed = number('seed');
    const uid = number('uid');
    // A route answer without a capability is not a route answer. Accepting it
    // produced a "successful" grant the worker could never authenticate with.
    if (routeGeneration === null || routeGeneration <= 0
      || routeEpoch === null || routeEpoch <= 0
      || cookieSeed === null || cookieSeed <= 0
      || uid === null || uid <= 0) {
      return refused('agent_frame_unusable');
    }
    // The generation must be the one the daemon authored. An agent answering
    // about a different route is answering a question nobody asked.
    if (authoredRouteGeneration !== undefined
      && routeGeneration !== authoredRouteGeneration) {
      return refused('agent_answered_another_route');
    }
    return { ok: true, routeGeneration, routeEpoch, cookieSeed, uid };
  }

  const admitted = flag('admitted');
  const presence = fields.get('presence');
  if (admitted === null || presence === undefined || !PRESENCE_TOKENS.has(presence)) {
    return refused('agent_frame_unusable');
  }
  const displayId = fields.has('display') ? number('display') : undefined;
  if (displayId === null || (displayId !== undefined && displayId <= 0)) {
    return refused('agent_frame_unusable');
  }
  return { ok: true, admitted, presence, ...(displayId === undefined ? {} : { displayId }) };
}

export interface MacosVirtualDisplayProxyLease {
  readonly socket: Socket;
  readonly serviceGeneration: number;
  readonly auditSessionId: number;
}

export interface MacosVirtualDisplayProxySeams {
  /** One bounded request line out, one bounded reply line back. */
  readonly exchange: (
    lease: MacosVirtualDisplayProxyLease, line: string, timeoutMs: number,
  ) => Promise<string | null>;
}

/**
 * Proxies one worker request onto the agent lease.
 *
 * FAIL CLOSED, ALWAYS. No lease, a timeout, an unparseable answer, a nonce that
 * does not match: every one of them is a refusal, never a default of "probably
 * fine". A readiness answer that guessed would advertise a display this machine
 * may not have.
 */
export async function proxyVirtualDisplayRequest(
  lease: MacosVirtualDisplayProxyLease | null,
  request: MacosVirtualDisplayProxyRequest,
  routeGeneration: number,
  seams: MacosVirtualDisplayProxySeams,
): Promise<MacosVirtualDisplayProxyReply> {
  // No authenticated agent means no display authority. Reported as such rather
  // than as an error the caller might retry into existence.
  if (lease === null) return { ok: false, error: 'agent_unavailable' };
  const line = authorVirtualDisplayControlLine(request, routeGeneration);
  if (line === null) return { ok: false, error: 'request_not_expressible' };

  const answered = await seams.exchange(
    lease, line, MACOS_VIRTUAL_DISPLAY_PROXY_TIMEOUT_MS,
  ).catch(() => null);
  if (answered === null) return { ok: false, error: 'agent_did_not_answer' };

  const reply = parseVirtualDisplayControlReply(answered, request.op, routeGeneration);
  if (!reply.ok) return reply;

  // The nonce must come back. Without it a status reply proves only that
  // SOMETHING answered, not that it answered THIS question -- a stale frame
  // still in the buffer would otherwise read as a live admission.
  if (request.op === MACOS_VIRTUAL_DISPLAY_PROXY_OP.READINESS
    && reply.nonce !== request.nonce) {
    return { ok: false, error: 'agent_answered_another_question' };
  }
  return reply;
}
