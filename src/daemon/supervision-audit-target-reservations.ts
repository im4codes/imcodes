/**
 * Short-lived claims on a ready auditor session, so two routes cannot pick it.
 *
 * Automatic audit selection reads `listSendTargets`, whose `dispatchMode` comes
 * from the target's live availability. That signal is authoritative but it
 * LAGS: a session does not report busy until the work it was just given
 * actually starts. Four audits dispatched in the same tick therefore all saw
 * the same session as `new_work` and all routed to it, which is exactly the
 * pile-up this exists to prevent -- three of them queued behind one peer while
 * other ready peers sat idle.
 *
 * A reservation bridges only that gap. It is deliberately NOT a scheduler, a
 * capacity model, or an invented agent cap: it holds a name for as long as it
 * takes the real availability signal to catch up, and then gets out of the way.
 *
 * A claim is therefore held in two very different conditions, and conflating
 * them is what made this process-local and TTL-fragile:
 *
 *   SPECULATIVE  reserved during selection, before any durable record of the
 *                audit exists. It lives only in this process and only until
 *                the dispatch either produces an assignment or fails, so a TTL
 *                is the only thing that can bound it -- a route that died
 *                between the two leaves nothing else to clear it.
 *   AUTHORITATIVE  the supervision registry holds a live auditor assignment
 *                bound to that session. THAT is the durable fact; this map is
 *                only a cache of it. It is rebuilt by reconciliation on every
 *                selection, so a daemon restart does not hand the same auditor
 *                out twice, and it must never be dropped merely because a
 *                timer elapsed -- the readiness signal it is bridging can lag
 *                for longer than any TTL, and expiring then is precisely the
 *                double-booking this prevents.
 *
 * Release is otherwise structural rather than event-driven, which is what makes
 * it survive a daemon restart and a lost terminal event alike:
 *   - the owner releases explicitly when its dispatch fails;
 *   - the claim is dropped as soon as the target stops reporting ready, because
 *     from then on the listing itself keeps it out of the ready set;
 *   - and an authoritative claim ends when its assignment leaves the live set.
 * When an audit finishes or is cancelled the session goes back to ready and is
 * immediately selectable again -- no terminal hook needed to give it back.
 */

/**
 * Bounds a SPECULATIVE claim only. An authoritative claim is bounded by its
 * assignment's own lifecycle instead; see `reconcileAuditTargetReservations`.
 */
export const AUDIT_TARGET_RESERVATION_TTL_MS = 60_000;

/** One durable "this session is auditing" fact, as the registry records it. */
export interface AuditTargetClaim {
  target: string;
  ownerKey: string;
}

interface AuditTargetReservation {
  ownerKey: string;
  reservedAt: number;
  /** Backed by a live auditor assignment, so no longer merely speculative. */
  authoritative: boolean;
}

const reservations = new Map<string, AuditTargetReservation>();

function expired(reservation: AuditTargetReservation, now: number): boolean {
  if (reservation.authoritative) return false;
  return now - reservation.reservedAt >= AUDIT_TARGET_RESERVATION_TTL_MS;
}

/**
 * Claim a ready target. Returns false when someone else holds it.
 *
 * Re-claiming as the same owner succeeds and does not extend the lease, so a
 * retried or replayed route keeps its original bound instead of renewing itself
 * indefinitely.
 */
export function reserveAuditTarget(target: string, ownerKey: string, now: number): boolean {
  const held = reservations.get(target);
  if (held && held.ownerKey !== ownerKey && !expired(held, now)) return false;
  if (held?.ownerKey === ownerKey) return true;
  reservations.set(target, { ownerKey, reservedAt: now, authoritative: false });
  return true;
}

/** Give back whatever this owner holds. Safe to call when it holds nothing. */
export function releaseAuditTarget(ownerKey: string): void {
  for (const [target, reservation] of reservations) {
    if (reservation.ownerKey === ownerKey) reservations.delete(target);
  }
}

/** Is this target claimed by somebody other than `ownerKey` right now? */
export function isAuditTargetReservedByOther(
  target: string,
  ownerKey: string,
  now: number,
): boolean {
  const held = reservations.get(target);
  return Boolean(held && held.ownerKey !== ownerKey && !expired(held, now));
}

/**
 * Rebuild this cache from the durable record, then drop what it no longer needs.
 *
 * `readyTargets` MUST be the complete live-ready pool, not one route's filtered
 * candidate set. Pruning against a filtered set deleted claims belonging to
 * OTHER routes purely because this route could not consider them -- a session
 * reserved as task A's auditor and excluded from task B's pool for being B's
 * own implementer was released by B, and then handed to C.
 *
 * `authoritativeClaims` are reconstructed from the supervision registry's live
 * auditor assignments. Adopting them here is what makes a claim survive a
 * daemon restart: the in-memory map starts empty, but the durable assignment
 * still says which session is auditing, so the first selection after a restart
 * sees the same exclusions the previous process did. The registry also WINS
 * over a conflicting speculative claim, because a bound assignment is a fact
 * and a speculative claim is only an intention.
 */
export function reconcileAuditTargetReservations(input: {
  now: number;
  readyTargets: ReadonlySet<string>;
  authoritativeClaims?: readonly AuditTargetClaim[];
}): void {
  const authoritativeByTarget = new Map<string, string>();
  for (const claim of input.authoritativeClaims ?? []) {
    const target = claim.target.trim();
    const ownerKey = claim.ownerKey.trim();
    // A claim on a target that is not ready needs no reservation: the listing
    // already keeps it out of the ready set, which is the stronger exclusion.
    if (!target || !ownerKey || !input.readyTargets.has(target)) continue;
    authoritativeByTarget.set(target, ownerKey);
  }
  // A caller that could not read the durable record passes nothing, which is
  // NOT the same as "there are no live audits". Erring toward holding a claim
  // costs one peer for a while; erring toward dropping it double-books an
  // auditor, so an unknown durable state must never demote a confirmed claim.
  const claimsKnown = input.authoritativeClaims !== undefined;
  for (const [target, reservation] of reservations) {
    const authoritativeOwner = authoritativeByTarget.get(target);
    if (authoritativeOwner) {
      reservations.set(target, {
        ownerKey: authoritativeOwner,
        // Keep the original instant when the durable record merely confirms the
        // claim this process already made, so confirmation is not a renewal.
        reservedAt: reservation.ownerKey === authoritativeOwner ? reservation.reservedAt : input.now,
        authoritative: true,
      });
      continue;
    }
    if (reservation.authoritative) {
      // Confirmed before, unlisted now: the assignment that owned this session
      // has left the live set, so the audit is over and the name goes back --
      // no terminal event required. While the durable state is unknown the
      // readiness signal remains the only bound we are willing to act on.
      if (claimsKnown || !input.readyTargets.has(target)) reservations.delete(target);
      continue;
    }
    // Speculative: reserved during selection, with no durable record yet. The
    // ready signal releases it normally; the TTL is the only thing that can
    // clear a route which died between reserving and being recorded.
    if (expired(reservation, input.now) || !input.readyTargets.has(target)) {
      reservations.delete(target);
    }
  }
  // Claims this process never made -- the restart case -- are adopted whole.
  for (const [target, ownerKey] of authoritativeByTarget) {
    if (reservations.has(target)) continue;
    reservations.set(target, { ownerKey, reservedAt: input.now, authoritative: true });
  }
}

export function __resetAuditTargetReservationsForTests(): void {
  reservations.clear();
}

export function __auditTargetReservationsForTests(): Array<{ target: string; ownerKey: string }> {
  return [...reservations].map(([target, reservation]) => ({
    target,
    ownerKey: reservation.ownerKey,
  }));
}
