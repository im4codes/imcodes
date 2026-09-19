/**
 * Lifecycle for in-flight virtual-display requests.
 *
 * The daemon relays one worker request onto one agent lease and answers on the
 * socket the request arrived on. Both sides can change underneath a request
 * that is already in flight, and every one of those changes has a way of
 * looking like success if nobody is tracking it:
 *
 *   * A request times out, the worker asks again, and the FIRST answer arrives
 *     afterwards. Correlating by request id alone matches it to the retry.
 *   * The agent lease is replaced. An answer authored by the previous agent is
 *     still well-formed and still carries the right request id.
 *   * The worker is superseded by a new generation. A reply addressed to the
 *     old one is not stale in shape, only in ownership.
 *
 * So a request is admitted against an IDENTITY -- worker generation, audit
 * session, agent service generation and the exact lease -- and settled only if
 * that identity is still the live one. Anything else is dropped, not applied.
 *
 * Request ids never repeat within a generation. The floor advances past every
 * id that is settled or failed, so an id that was already answered cannot be
 * admitted a second time and a late duplicate has nothing to correlate to.
 */

/** Bounded because an unbounded queue is a memory the peer controls. */
export const MACOS_VIRTUAL_DISPLAY_MAX_PENDING = 4 as const;

export const MACOS_VIRTUAL_DISPLAY_PENDING_ERROR = Object.freeze({
  DUPLICATE: 'virtual_display_duplicate_request',
  FULL: 'virtual_display_pending_full',
  NOT_FRESH: 'virtual_display_request_not_fresh',
  IDENTITY_CHANGED: 'virtual_display_identity_changed',
  TERMINAL: 'virtual_display_channel_terminal',
} as const);

export type MacosVirtualDisplayPendingError =
  typeof MACOS_VIRTUAL_DISPLAY_PENDING_ERROR[
    keyof typeof MACOS_VIRTUAL_DISPLAY_PENDING_ERROR];

/**
 * Everything a reply must still match to be applied.
 *
 * All four together, not any one of them: the worker generation alone does not
 * notice a replaced agent, and the lease alone does not notice a superseded
 * worker.
 */
export interface MacosVirtualDisplayChannelIdentity {
  readonly workerGeneration: number;
  readonly auditSessionId: number;
  readonly serviceGeneration: number;
  /** Identity of the exact agent connection. A reconnect is a different lease. */
  readonly leaseId: number;
}

export type MacosVirtualDisplayAdmission =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: MacosVirtualDisplayPendingError };

function sameIdentity(
  left: MacosVirtualDisplayChannelIdentity,
  right: MacosVirtualDisplayChannelIdentity,
): boolean {
  return left.workerGeneration === right.workerGeneration
    && left.auditSessionId === right.auditSessionId
    && left.serviceGeneration === right.serviceGeneration
    && left.leaseId === right.leaseId;
}

function isPositiveSafe(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isMacosVirtualDisplayChannelIdentity(
  value: MacosVirtualDisplayChannelIdentity | null | undefined,
): value is MacosVirtualDisplayChannelIdentity {
  return value !== null && value !== undefined
    && isPositiveSafe(value.workerGeneration)
    && isPositiveSafe(value.auditSessionId)
    && isPositiveSafe(value.serviceGeneration)
    && isPositiveSafe(value.leaseId);
}

export class MacosVirtualDisplayPendingRegistry {
  private identity: MacosVirtualDisplayChannelIdentity | null = null;
  private readonly outstanding = new Set<number>();
  /** Every id at or below this has been used up and can never return. */
  private floor = 0;
  private terminal = false;

  constructor(private readonly maxPending = MACOS_VIRTUAL_DISPLAY_MAX_PENDING) {}

  /**
   * Binds the channel to one identity.
   *
   * A different identity fails every request still in flight rather than
   * carrying them across: those requests were asked of a principal that is no
   * longer there, and answering them from the new one would be a silent
   * rebind. Re-binding the SAME identity is a no-op so an idempotent caller
   * cannot cancel its own live requests.
   */
  bind(identity: MacosVirtualDisplayChannelIdentity): void {
    if (!isMacosVirtualDisplayChannelIdentity(identity)) {
      this.close();
      return;
    }
    if (this.identity !== null && sameIdentity(this.identity, identity)) return;
    this.failAll();
    this.identity = identity;
    this.terminal = false;
    this.floor = 0;
  }

  /** Terminal. Nothing is admitted again until a fresh bind. */
  close(): number {
    const failed = this.failAll();
    this.identity = null;
    this.terminal = true;
    return failed;
  }

  private failAll(): number {
    const failed = this.outstanding.size;
    for (const id of this.outstanding) {
      // The floor must pass every failed id too. Otherwise a request that
      // timed out could be re-admitted and then settled by the ORIGINAL late
      // answer, which is the exact A/late-A/B confusion this prevents.
      if (id > this.floor) this.floor = id;
    }
    this.outstanding.clear();
    return failed;
  }

  admit(
    identity: MacosVirtualDisplayChannelIdentity, requestId: number,
  ): MacosVirtualDisplayAdmission {
    if (this.terminal || this.identity === null) {
      return { ok: false, error: MACOS_VIRTUAL_DISPLAY_PENDING_ERROR.TERMINAL };
    }
    if (!isMacosVirtualDisplayChannelIdentity(identity)
      || !sameIdentity(this.identity, identity)) {
      return {
        ok: false, error: MACOS_VIRTUAL_DISPLAY_PENDING_ERROR.IDENTITY_CHANGED,
      };
    }
    if (!isPositiveSafe(requestId)) {
      return { ok: false, error: MACOS_VIRTUAL_DISPLAY_PENDING_ERROR.NOT_FRESH };
    }
    if (this.outstanding.has(requestId)) {
      return { ok: false, error: MACOS_VIRTUAL_DISPLAY_PENDING_ERROR.DUPLICATE };
    }
    // Strictly above the floor: an id that has already been settled or failed
    // is spent for this generation.
    if (requestId <= this.floor) {
      return { ok: false, error: MACOS_VIRTUAL_DISPLAY_PENDING_ERROR.NOT_FRESH };
    }
    if (this.outstanding.size >= this.maxPending) {
      return { ok: false, error: MACOS_VIRTUAL_DISPLAY_PENDING_ERROR.FULL };
    }
    this.outstanding.add(requestId);
    return { ok: true };
  }

  /**
   * Whether this reply may be applied, consuming the request if so.
   *
   * Re-verifies the identity at SETTLE time, not only at admit time: the whole
   * point is that the lease or the generation may have changed while the
   * request was in flight.
   */
  settle(
    identity: MacosVirtualDisplayChannelIdentity, requestId: number,
  ): boolean {
    if (this.terminal || this.identity === null) return false;
    if (!isMacosVirtualDisplayChannelIdentity(identity)
      || !sameIdentity(this.identity, identity)) {
      return false;
    }
    if (!this.outstanding.delete(requestId)) return false;
    if (requestId > this.floor) this.floor = requestId;
    return true;
  }

  /** Gives up on one request without accepting an answer for it. */
  abandon(requestId: number): void {
    if (this.outstanding.delete(requestId) && requestId > this.floor) {
      this.floor = requestId;
    }
  }

  get pending(): number { return this.outstanding.size; }
  get isTerminal(): boolean { return this.terminal; }
  get boundIdentity(): MacosVirtualDisplayChannelIdentity | null {
    return this.identity;
  }
}
