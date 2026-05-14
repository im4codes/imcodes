import { makeP2pWorkflowDiagnostic } from '../../shared/p2p-workflow-diagnostics.js';
import type { P2pWorkflowDiagnostic } from '../../shared/p2p-workflow-diagnostics.js';
import type { P2pStaticPolicy } from '../../shared/p2p-workflow-types.js';

/**
 * Result of a per-dangerous-node policy/capability recheck.
 *
 * The bound capability snapshot is audit/projection metadata only — before any
 * dangerous node (script, implementation, artifact-write) executes the daemon
 * MUST re-check current daemon policy/capabilities AND policy allowlists.
 *
 * Capability checks (audit:R1-H3):
 * - If a required capability is missing from `currentDaemonCapabilities` AND it
 *   was in `bindCapabilitySnapshot`, this is a downgrade and we emit
 *   `capability_downgraded_during_run`.
 * - If a required capability is missing from `currentDaemonCapabilities` AND it
 *   was NOT in `bindCapabilitySnapshot`, the run never had it; we emit
 *   `missing_required_capability`.
 *
 * Policy checks (audit:H3 / R2-CH1) — only when both `boundPolicySnapshot` and
 * `currentDaemonPolicy` are supplied:
 * - Any allow-flag (`allowOpenSpecArtifacts`, `allowImplementationPermission`,
 *   `allowInterpreterScripts`) that flipped `true → false` since bind triggers
 *   `capability_downgraded_during_run` — the daemon revoked permission.
 * - Any executable removed from `allowedExecutables` since bind triggers the
 *   same — script runner / implementation node would lose authorisation.
 * - Concurrency caps tightening is NOT a downgrade (it does not retract
 *   already-granted authority for an in-flight run); it only affects new launches.
 *
 * Capability "upgrade" (current ⊃ snapshot) is fine but MUST NOT broaden the
 * permission set granted to an already-running workflow. Because this helper
 * checks the requirement set against `currentDaemonCapabilities` only, an
 * upgraded daemon still satisfies the original required set; the upgrade
 * itself does not unlock anything new because the required set was frozen at
 * compile/bind time.
 */
export type P2pWorkflowPolicyRecheckResult =
  | { ok: true }
  | { ok: false; diagnostic: P2pWorkflowDiagnostic; missingCapability?: string; downgradedField?: string };

export interface P2pWorkflowPolicyRecheckArgs {
  requiredCapabilities: readonly string[];
  bindCapabilitySnapshot: readonly string[];
  currentDaemonCapabilities: readonly string[];
  /** Policy at bind time. When omitted, only capability strings are checked. */
  boundPolicySnapshot?: P2pStaticPolicy;
  /** Current daemon policy. Required when `boundPolicySnapshot` is supplied. */
  currentDaemonPolicy?: P2pStaticPolicy;
  runId?: string;
  nodeId?: string;
}

const POLICY_ALLOW_FLAG_FIELDS = [
  'allowOpenSpecArtifacts',
  'allowImplementationPermission',
  'allowInterpreterScripts',
] as const;

type PolicyAllowField = (typeof POLICY_ALLOW_FLAG_FIELDS)[number];

interface PolicyDowngradeFinding {
  field: string;
  summary: string;
}

/**
 * Compare two `P2pStaticPolicy` snapshots and return the first downgrade
 * (`true → false` allow flag, or executable removed from allowlist). Returns
 * `null` when current policy is at least as permissive as bound policy.
 */
function findPolicyDowngrade(
  bound: P2pStaticPolicy,
  current: P2pStaticPolicy,
): PolicyDowngradeFinding | null {
  for (const flag of POLICY_ALLOW_FLAG_FIELDS) {
    if (bound[flag as PolicyAllowField] && !current[flag as PolicyAllowField]) {
      return {
        field: `currentDaemonPolicy.${flag}`,
        summary: `Policy flag ${flag} was true at bind but is now false`,
      };
    }
  }
  const currentExecutables = new Set(current.allowedExecutables);
  for (const exe of bound.allowedExecutables) {
    if (!currentExecutables.has(exe)) {
      return {
        field: 'currentDaemonPolicy.allowedExecutables',
        summary: `Executable ${exe} was allowlisted at bind but is no longer allowed`,
      };
    }
  }
  return null;
}

export function recheckDangerousNodeCapabilities(
  args: P2pWorkflowPolicyRecheckArgs,
): P2pWorkflowPolicyRecheckResult {
  const current = new Set(args.currentDaemonCapabilities);
  const snapshot = new Set(args.bindCapabilitySnapshot);

  for (const required of args.requiredCapabilities) {
    if (current.has(required)) continue;
    const wasBound = snapshot.has(required);
    const code = wasBound
      ? 'capability_downgraded_during_run'
      : 'missing_required_capability';
    return {
      ok: false,
      missingCapability: required,
      diagnostic: makeP2pWorkflowDiagnostic(code, 'execute', {
        ...(args.runId !== undefined ? { runId: args.runId } : {}),
        ...(args.nodeId !== undefined ? { nodeId: args.nodeId } : {}),
        fieldPath: 'currentDaemonPolicy.capabilities',
        summary: wasBound
          ? `Capability ${required} was present at bind but is no longer available`
          : `Required capability ${required} is missing`,
      }),
    };
  }

  // Audit:H3 — capabilities can stay identical while the daemon tightens
  // executable allowlist or flips an allow flag off. Detect that here so a
  // dangerous node fails closed even when the capability advertisement is
  // unchanged.
  if (args.boundPolicySnapshot && args.currentDaemonPolicy) {
    const downgrade = findPolicyDowngrade(args.boundPolicySnapshot, args.currentDaemonPolicy);
    if (downgrade) {
      return {
        ok: false,
        downgradedField: downgrade.field,
        diagnostic: makeP2pWorkflowDiagnostic('capability_downgraded_during_run', 'execute', {
          ...(args.runId !== undefined ? { runId: args.runId } : {}),
          ...(args.nodeId !== undefined ? { nodeId: args.nodeId } : {}),
          fieldPath: downgrade.field,
          summary: downgrade.summary,
        }),
      };
    }
  }
  return { ok: true };
}
