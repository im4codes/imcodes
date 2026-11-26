/**
 * Routing policy for recovering ONE orphaned automatic auditor on the SAME
 * task, assignment, audit attempt and revision.
 *
 * An orphaned auditor's historical target can stop being usable (dead, or
 * still live but no longer selected by the project's execution pool). The
 * project Brain names a replacement target; this decides whether that target
 * is admissible for the task's audit policy, and what routing statement the
 * same assignment must durably carry afterwards. The Brain recovery ingress
 * (which observes live sessions and pool selection) and the registry
 * transaction (which owns the durable write) apply this ONE rule, so the two
 * boundaries cannot disagree.
 *
 * - A cross-vendor target is admissible whatever the task's policy (a task
 *   without an automatic policy included), exactly as before.
 * - `auto_strict_cross_vendor` never admits a same-family target.
 * - `auto_allow_degraded` admits a same-family target ONLY when no
 *   cross-vendor target is currently usable (selected, live, reply-capable
 *   transport); the same assignment then records `same_family_degraded` and
 *   the concrete degraded reason. A usable cross-vendor target always wins.
 * - A same-family target under any other or no policy, or when availability
 *   could not be established, refuses.
 */
import type { SupervisionTaskAuditPolicy } from './supervision-config.js';
import {
  SUPERVISION_AUDIT_DEGRADED_REASONS,
  type SupervisionAuditDegradedReason,
  type SupervisionAuditRoutingReason,
} from './supervision-execution-pool.js';

export const SUPERVISION_AUDITOR_RECOVERY_REFUSALS = {
  /** The task requires a cross-vendor auditor and the target shares the audited provider family. */
  STRICT_CROSS_VENDOR_REQUIRED: 'strict_cross_vendor_required',
  /** A usable cross-vendor target exists, so a same-family target is not a degradation. */
  CROSS_VENDOR_TARGET_AVAILABLE: 'cross_vendor_target_available',
  /** Cross-vendor availability could not be established; a degradation is never assumed. */
  CROSS_VENDOR_AVAILABILITY_UNKNOWN: 'cross_vendor_availability_unknown',
  /** A same-family target needs `auto_allow_degraded`; this task carries no policy that permits it. */
  AUDIT_POLICY_UNSUPPORTED: 'audit_policy_unsupported',
} as const;
export type SupervisionAuditorRecoveryRefusal =
  typeof SUPERVISION_AUDITOR_RECOVERY_REFUSALS[keyof typeof SUPERVISION_AUDITOR_RECOVERY_REFUSALS];

/** Whether any cross-vendor auditor target is usable right now, and if not, why. */
export type SupervisionAuditorRecoveryCrossVendorAvailability =
  | { available: true }
  | { available: false; degradedReason: SupervisionAuditDegradedReason };

export type SupervisionAuditorRecoveryRouting =
  | { auditRoutingReason: Extract<SupervisionAuditRoutingReason, 'cross_vendor_preferred'>; auditDegradedReason?: undefined }
  | {
    auditRoutingReason: Extract<SupervisionAuditRoutingReason, 'same_family_degraded'>;
    auditDegradedReason: SupervisionAuditDegradedReason;
  };

export type SupervisionAuditorRecoveryRoutingDecision =
  | ({ ok: true } & SupervisionAuditorRecoveryRouting)
  | { ok: false; refusal: SupervisionAuditorRecoveryRefusal };

const DEGRADED_REASONS: ReadonlySet<string> = new Set(SUPERVISION_AUDIT_DEGRADED_REASONS);
const STRICT_POLICY: SupervisionTaskAuditPolicy = 'auto_strict_cross_vendor';
const DEGRADED_POLICY: SupervisionTaskAuditPolicy = 'auto_allow_degraded';

export function isSupervisionAuditDegradedReason(value: unknown): value is SupervisionAuditDegradedReason {
  return typeof value === 'string' && DEGRADED_REASONS.has(value);
}

/**
 * Decide one orphaned-auditor recovery target. `crossVendor` is consulted only
 * for a same-family target under `auto_allow_degraded`, and must then be
 * supplied from live, pool-aware facts.
 */
export function evaluateSupervisionAuditorRecoveryRouting(input: {
  auditPolicy: unknown;
  auditedProviderFamily: string;
  targetProviderFamily: string;
  crossVendor?: SupervisionAuditorRecoveryCrossVendorAvailability;
}): SupervisionAuditorRecoveryRoutingDecision {
  if (input.targetProviderFamily !== input.auditedProviderFamily) {
    return { ok: true, auditRoutingReason: 'cross_vendor_preferred' };
  }
  if (input.auditPolicy === STRICT_POLICY) {
    return { ok: false, refusal: SUPERVISION_AUDITOR_RECOVERY_REFUSALS.STRICT_CROSS_VENDOR_REQUIRED };
  }
  if (input.auditPolicy !== DEGRADED_POLICY) {
    return { ok: false, refusal: SUPERVISION_AUDITOR_RECOVERY_REFUSALS.AUDIT_POLICY_UNSUPPORTED };
  }
  const crossVendor = input.crossVendor;
  if (!crossVendor || (!crossVendor.available && !isSupervisionAuditDegradedReason(crossVendor.degradedReason))) {
    return { ok: false, refusal: SUPERVISION_AUDITOR_RECOVERY_REFUSALS.CROSS_VENDOR_AVAILABILITY_UNKNOWN };
  }
  if (crossVendor.available) {
    return { ok: false, refusal: SUPERVISION_AUDITOR_RECOVERY_REFUSALS.CROSS_VENDOR_TARGET_AVAILABLE };
  }
  return { ok: true, auditRoutingReason: 'same_family_degraded', auditDegradedReason: crossVendor.degradedReason };
}

/**
 * Is a routing statement consistent with the policy for this family pairing?
 * The registry cannot observe live pool availability, so it re-checks
 * everything the durable record can prove: the policy, the family pairing,
 * and that a same-family rebind carries an explicit degraded reason.
 */
export function isSupervisionAuditorRecoveryRoutingConsistent(input: {
  auditPolicy: unknown;
  auditedProviderFamily: string;
  targetProviderFamily: string;
  routing: { auditRoutingReason?: unknown; auditDegradedReason?: unknown };
}): boolean {
  if (input.targetProviderFamily !== input.auditedProviderFamily) {
    return input.routing.auditRoutingReason === 'cross_vendor_preferred'
      && input.routing.auditDegradedReason === undefined;
  }
  return input.auditPolicy === DEGRADED_POLICY
    && input.routing.auditRoutingReason === 'same_family_degraded'
    && isSupervisionAuditDegradedReason(input.routing.auditDegradedReason);
}
