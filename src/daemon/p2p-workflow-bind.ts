import { P2P_WORKFLOW_CAPABILITY_V1 } from '../../shared/p2p-workflow-constants.js';
import { makeP2pWorkflowDiagnostic, type P2pWorkflowDiagnostic } from '../../shared/p2p-workflow-diagnostics.js';
import type {
  P2pBindResult,
  P2pBindRuntimeContext,
  P2pBoundWorkflow,
  P2pCompiledWorkflow,
} from '../../shared/p2p-workflow-types.js';

/**
 * Audit:R3 PR-β / V-6 — daemon-side helper that enforces the FULL
 * `P2pStaticPolicy` against the compiled workflow at bind time. compile is
 * intentionally pure-shared and only derives capability requirements; this
 * helper is the daemon-owned authority layer that:
 *
 *  - rejects `permissionScope: 'implementation'` nodes when policy disallows
 *  - rejects `openspec_convention` artifacts when policy disallows
 *  - rejects `commandKind: 'interpreter'` script nodes when policy disallows
 *  - rejects script `argv[0]` not in `allowedExecutables` (when allowlist non-empty;
 *    empty allowlist means "no script execution allowed", which is the v1a default
 *    until a daemon explicitly configures executables)
 *
 * Returned diagnostics use existing diagnostic codes:
 *  - `script_executable_denied` for executable / interpreter rejections
 *  - `missing_required_capability` for implementation / artifact rejections
 *
 * The helper degrades gracefully when policy is not yet supplied (callers that
 * still build legacy bind contexts without `policySnapshot`); but the v1a
 * launch path always passes a `policySnapshot` from `loadDaemonP2pStaticPolicy`.
 */
export function validateCompiledWorkflowAgainstBindPolicy(
  compiled: Pick<P2pCompiledWorkflow, 'nodes'>,
  bindContext: Pick<P2pBindRuntimeContext, 'policySnapshot' | 'runId'>,
): P2pWorkflowDiagnostic[] {
  const diagnostics: P2pWorkflowDiagnostic[] = [];
  const policy = bindContext.policySnapshot;
  if (!policy) return diagnostics;
  const allowedExecutables = new Set(policy.allowedExecutables);

  for (const node of compiled.nodes) {
    if (node.permissionScope === 'implementation' && !policy.allowImplementationPermission) {
      diagnostics.push(makeP2pWorkflowDiagnostic('missing_required_capability', 'bind', {
        runId: bindContext.runId,
        nodeId: node.id,
        fieldPath: `nodes.${node.id}.permissionScope`,
        summary: 'Daemon policy does not allow implementation permission.',
      }));
    }
    if (node.artifacts.some((artifact) => artifact.convention === 'openspec_convention') && !policy.allowOpenSpecArtifacts) {
      diagnostics.push(makeP2pWorkflowDiagnostic('missing_required_capability', 'bind', {
        runId: bindContext.runId,
        nodeId: node.id,
        fieldPath: `nodes.${node.id}.artifacts`,
        summary: 'Daemon policy does not allow OpenSpec artifact writes.',
      }));
    }
    if (node.script) {
      if (node.script.commandKind === 'interpreter' && !policy.allowInterpreterScripts) {
        diagnostics.push(makeP2pWorkflowDiagnostic('script_executable_denied', 'bind', {
          runId: bindContext.runId,
          nodeId: node.id,
          fieldPath: `nodes.${node.id}.script.commandKind`,
          summary: 'Daemon policy does not allow interpreter scripts.',
        }));
      }
      const executable = node.script.commandKind === 'interpreter'
        ? node.script.interpreter
        : node.script.argv[0];
      // Empty allowlist means script execution is not yet enabled by daemon
      // policy (v1a fail-closed default). Reject all script nodes.
      if (!executable || !allowedExecutables.has(executable)) {
        diagnostics.push(makeP2pWorkflowDiagnostic('script_executable_denied', 'bind', {
          runId: bindContext.runId,
          nodeId: node.id,
          fieldPath: `nodes.${node.id}.script.argv[0]`,
          summary: `Executable ${executable ?? '<missing>'} is not allowlisted by daemon policy.`,
        }));
      }
    }
  }
  return diagnostics;
}

export function getMissingP2pWorkflowCapabilities(
  compiled: Pick<P2pCompiledWorkflow, 'derivedRequiredCapabilities'>,
  bindContext: Pick<P2pBindRuntimeContext, 'capabilitySnapshot'>,
): string[] {
  // Audit:R3 PR-α — read capabilities from `capabilitySnapshot` (the
  // canonical `daemon.hello` advertisement) instead of the ad-hoc
  // `currentDaemonPolicy.capabilities` subset that no longer exists.
  const available = new Set(bindContext.capabilitySnapshot.capabilities);
  const required = new Set([
    P2P_WORKFLOW_CAPABILITY_V1,
    ...compiled.derivedRequiredCapabilities,
  ]);

  return [...required].filter((capability) => !available.has(capability));
}

export function bindP2pCompiledWorkflow(
  compiled: P2pCompiledWorkflow,
  bindContext: P2pBindRuntimeContext,
): P2pBindResult {
  const diagnostics = compiled.diagnostics.map((diagnostic) => ({ ...diagnostic }));

  if (!bindContext.concurrencyAdmission.accepted) {
    diagnostics.push(makeP2pWorkflowDiagnostic('daemon_busy', 'bind', {
      runId: bindContext.runId,
      summary: bindContext.concurrencyAdmission.reason ?? 'daemon_busy',
    }));
    return { ok: false, reason: 'daemon_busy', diagnostics };
  }

  const missingCapabilities = getMissingP2pWorkflowCapabilities(compiled, bindContext);
  if (missingCapabilities.length > 0) {
    diagnostics.push(makeP2pWorkflowDiagnostic('missing_required_capability', 'bind', {
      runId: bindContext.runId,
      fieldPath: 'capabilitySnapshot.capabilities',
      summary: `Missing required capabilities: ${missingCapabilities.join(', ')}`,
    }));
    return { ok: false, reason: 'missing_required_capability', diagnostics };
  }

  // Audit:R3 PR-β / V-6 — daemon-side policy authority. compile only derives
  // capability requirements; bind enforces the FULL P2pStaticPolicy (allow
  // flags + executable allowlist). Any error severity here halts bind.
  const policyDiagnostics = validateCompiledWorkflowAgainstBindPolicy(compiled, bindContext);
  diagnostics.push(...policyDiagnostics);
  if (policyDiagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    const reason = 'missing_required_capability' as const;
    return { ok: false, reason, diagnostics };
  }

  const bound: P2pBoundWorkflow = {
    compiled: structuredClone(compiled),
    bindContext: structuredClone(bindContext),
    diagnostics,
  };
  return { ok: true, bound, diagnostics };
}
