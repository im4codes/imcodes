/**
 * Server clock estimation for peers that act on Server-stamped deadlines.
 *
 * The Server stamps remote-desktop authority with ABSOLUTE times from its own
 * clock (`expiresAt`, `leaseExpiresAt`). Every host and browser checks them
 * against its own clock, so any skew moves every deadline: a Mac 0.4 s behind
 * the Server rejected each lease renewal as "too far in the future" and lost
 * every session at its first renewal; a clock minutes off would fail outright.
 *
 * Tolerance only hides small skew. This estimates the actual offset from
 * round trips the peer already makes -- the heartbeat -- and translates Server
 * times into local ones before anything compares them.
 */

/** Wire fields. The peer stamps its send time; the Server echoes it with its own time. */
export const CLOCK_SYNC_FIELD = Object.freeze({
  /** Peer-local ms at send, on the heartbeat; echoed back unchanged on the ack. */
  SENT_AT: 'clockSentAt',
  /** Server ms when the ack was written. */
  SERVER_TIME: 'serverTime',
} as const);

/** Samples kept; the estimate is their median, so one slow round trip cannot move it. */
export const CLOCK_SYNC_MAX_SAMPLES = 9;
/** A round trip slower than this says more about the network than the clock; ignored. */
export const CLOCK_SYNC_MAX_ROUND_TRIP_MS = 10_000;

function isFiniteMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export class ServerClockEstimator {
  private readonly offsets: number[] = [];

  constructor(private readonly maxSamples = CLOCK_SYNC_MAX_SAMPLES) {}

  /**
   * One round trip: the local time the request left, the Server's time in its
   * reply, and the local time the reply arrived. Returns whether it was used.
   */
  addSample(localSentAt: unknown, serverTime: unknown, localReceivedAt: number): boolean {
    if (!isFiniteMs(localSentAt) || !isFiniteMs(serverTime) || !isFiniteMs(localReceivedAt)) return false;
    const roundTrip = localReceivedAt - localSentAt;
    if (roundTrip < 0 || roundTrip > CLOCK_SYNC_MAX_ROUND_TRIP_MS) return false;
    // The Server wrote its time roughly half way through the round trip.
    const offset = serverTime - (localSentAt + roundTrip / 2);
    this.offsets.push(offset);
    if (this.offsets.length > this.maxSamples) this.offsets.shift();
    return true;
  }

  /** Whether any usable sample exists. Without one the offset is 0 (trust the local clock). */
  get synchronized(): boolean {
    return this.offsets.length > 0;
  }

  /** Server clock minus local clock, in ms (median of recent samples). */
  offsetMs(): number {
    if (this.offsets.length === 0) return 0;
    const sorted = [...this.offsets].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 1
      ? sorted[middle]!
      : (sorted[middle - 1]! + sorted[middle]!) / 2;
    return Math.round(median);
  }

  /** A Server timestamp expressed on the local clock. */
  serverToLocal(serverMs: number): number {
    return serverMs - this.offsetMs();
  }
}

/**
 * Offset from a single message that carries the Server's current time and was
 * received just now -- for the browser, whose authorization reply is the
 * natural sample. Accuracy is bounded by one network leg, which is ample for
 * deadlines measured in minutes and hours.
 */
export function oneWayServerOffsetMs(serverTime: unknown, localReceivedAt: number): number {
  if (!isFiniteMs(serverTime) || !isFiniteMs(localReceivedAt)) return 0;
  return Math.round(serverTime - localReceivedAt);
}
