/**
 * Daemon-side single source of truth for the runtime `P2pStaticPolicy`.
 *
 * The smart-p2p-upgrade spec (`design.md` §Static Policy + §Capabilities)
 * requires every advanced launch and every dangerous-node recheck to read
 * policy from one place rather than constructing ad-hoc permissive overrides
 * at the call site.
 *
 * Design choices for v1a:
 * - The policy's allow-flags (`allowOpenSpecArtifacts`,
 *   `allowImplementationPermission`, `allowInterpreterScripts`) are derived
 *   from the daemon's currently advertised workflow capabilities — this way
 *   `daemon.hello` capabilities and the `P2pStaticPolicy` cannot drift apart.
 * - `allowedExecutables` is empty by default. The actual allowlist is
 *   carried by the launch envelope (`P2pWorkflowLaunchEnvelope.allowedExecutables`)
 *   which is configured in the web UI (`P2pConfigPanel`) — IM.codes is a
 *   UI-driven product, requiring users to hand-edit a host JSON file to
 *   enable script execution would be off-product. `prepareAdvancedWorkflowLaunch`
 *   merges the envelope-supplied allowlist into the policy snapshot used for
 *   bind validation.
 * - The `concurrency` cap is taken from `DEFAULT_P2P_STATIC_POLICY` (which
 *   in turn comes from `P2P_WORKFLOW_MAX_ACTIVE_RUNS` /
 *   `P2P_WORKFLOW_MAX_ACTIVE_SCRIPTS`).
 * - Fail-closed: when the daemon cannot enumerate its capabilities (`serverLink`
 *   without `getP2pWorkflowCapabilities`), this returns the strictest policy
 *   (`[]` capabilities, all dangerous flags off). The launch path will then
 *   reject with `missing_required_capability` rather than silently granting
 *   `IMPLEMENTATION` access — see also `recheckDangerousNodeCapabilities`.
 */

import {
  P2P_WORKFLOW_CAPABILITY_V1,
  P2P_WORKFLOW_OPENSPEC_ARTIFACTS_CAPABILITY_V1,
  P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1,
  P2P_WORKFLOW_SCRIPT_INTERPRETER_CAPABILITY_V1,
} from '../../shared/p2p-workflow-constants.js';
import { buildDefaultP2pStaticPolicy } from '../../shared/p2p-workflow-policy.js';
import type { P2pStaticPolicy } from '../../shared/p2p-workflow-types.js';
import type { ServerLink } from './server-link.js';

/**
 * Daemon capability accessor. Exposed as a function rather than a method so
 * tests can supply a hostile mock that omits `getP2pWorkflowCapabilities` and
 * verify the fail-closed behavior.
 *
 * v1a fail-closed policy: when the link does not expose
 * `getP2pWorkflowCapabilities`, return `[]` (NOT a hardcoded permissive
 * fallback that would grant OpenSpec / implementation access). The advanced
 * launch path will then reject with `missing_required_capability` per the
 * spec, instead of fail-OPEN. See `audit:N-H2` in the discussion file.
 */
export function getCurrentDaemonWorkflowCapabilities(serverLink: ServerLink): string[] {
  if (typeof serverLink.getP2pWorkflowCapabilities === 'function') {
    return [...serverLink.getP2pWorkflowCapabilities()].sort();
  }
  return [];
}

/**
 * Snapshot of the daemon's most recent `daemon.hello` send. Used by bind to
 * record an audit-quality `capabilitySnapshot` for projection rather than
 * synthesising `helloEpoch: 0` / `sentAt: Date.now()` placeholders.
 *
 * The shape mirrors `P2pBindRuntimeContext.capabilitySnapshot`. When the
 * underlying `serverLink` does not expose hello-state accessors (mocks /
 * legacy test harnesses), we fall back to deterministic placeholders that
 * still validate but obviously came from a non-hello source.
 */
export function readCachedHelloSnapshot(serverLink: ServerLink): {
  daemonId: string;
  capabilities: string[];
  helloEpoch: number;
  sentAt: number;
} {
  const capabilities = getCurrentDaemonWorkflowCapabilities(serverLink);
  const daemonId = typeof serverLink.getServerId === 'function'
    ? serverLink.getServerId()
    : 'local-daemon';
  const helloEpoch = typeof serverLink.getHelloEpoch === 'function'
    ? serverLink.getHelloEpoch()
    : 0;
  const sentAt = typeof serverLink.getHelloSentAt === 'function'
    ? serverLink.getHelloSentAt()
    : 0;
  return { daemonId, capabilities, helloEpoch, sentAt };
}

/**
 * Single entry point for "what is the daemon's current static policy?". All
 * compile / bind / recheck call sites MUST go through this function so that
 * a future change (read from disk / env / config service) only touches one
 * place. The reverse-regression suite enforces that the launch path reads
 * `staticPolicy.concurrency.maxAdvancedRuns` and that this function never
 * hardcodes dangerous allow-flags as permissive defaults.
 */
export function loadDaemonP2pStaticPolicy(serverLink: ServerLink): P2pStaticPolicy {
  const caps = new Set(getCurrentDaemonWorkflowCapabilities(serverLink));
  // Audit:R3 PR-β / A3 / V-5 — interpreter execution is a DISTINCT security
  // boundary from argv execution (interpreter loads user-controlled script
  // files; argv invokes a fixed allowlisted binary). The previous derivation
  // OR'd ARGV into `allowInterpreterScripts`, silently upgrading argv-only
  // capability to interpreter authority. Now interpreter authority strictly
  // requires the interpreter capability.
  //
  // R3 PR-α follow-up — `allowedExecutables` is intentionally empty here.
  // The authoritative list is configured in the web UI (`P2pConfigPanel`),
  // carried by `P2pWorkflowLaunchEnvelope.allowedExecutables`, and merged
  // into the launch policy snapshot by `prepareAdvancedWorkflowLaunch`.
  // Daemon-side hand-edited config (e.g., `~/.imcodes/p2p-policy.json`) is
  // explicitly NOT supported — IM.codes is UI-driven; allowlist edits
  // belong in the same surface where users configure their workflows.
  return buildDefaultP2pStaticPolicy({
    allowedExecutables: [],
    allowOpenSpecArtifacts: caps.has(P2P_WORKFLOW_OPENSPEC_ARTIFACTS_CAPABILITY_V1),
    allowImplementationPermission: caps.has(P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1),
    allowInterpreterScripts: caps.has(P2P_WORKFLOW_SCRIPT_INTERPRETER_CAPABILITY_V1),
  });
}

/**
 * Convenience predicate used by daemon admission / executor branches that
 * only need to know whether the base workflow capability is present.
 */
export function daemonAdvertisesBaseWorkflowCapability(serverLink: ServerLink): boolean {
  return getCurrentDaemonWorkflowCapabilities(serverLink).includes(P2P_WORKFLOW_CAPABILITY_V1);
}
