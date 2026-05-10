/**
 * R3 PR-α follow-up — UI-driven `allowedExecutables`.
 *
 * The previous `~/.imcodes/p2p-policy.json` daemon-side reader has been
 * removed; the allowlist now travels with `P2pWorkflowLaunchEnvelope.allowedExecutables`
 * (configured in the web UI's `P2pConfigPanel` → "Allowed executables").
 *
 * These tests pin the new contract from the daemon side:
 *   - `loadDaemonP2pStaticPolicy` returns an empty allowlist (no host-file
 *     fallback). The bind validator therefore rejects every script
 *     executable unless the launch envelope supplies one.
 *   - The envelope validator enforces shape (visible-ASCII, ≤256 bytes per
 *     entry, ≤64 entries, no duplicates).
 *   - The end-to-end semantic is exercised in
 *     `test/daemon/p2p-workflow-launch-envelope-allowlist.test.ts` (envelope
 *     → bind path); this file keeps the layer-isolated unit tests.
 */

import { describe, expect, it } from 'vitest';

import { loadDaemonP2pStaticPolicy } from '../../src/daemon/p2p-workflow-static-policy.js';
import { validateP2pWorkflowLaunchEnvelope } from '../../shared/p2p-workflow-validators.js';
import { P2P_WORKFLOW_SCHEMA_VERSION } from '../../shared/p2p-workflow-constants.js';
import type { P2pWorkflowLaunchEnvelope } from '../../shared/p2p-workflow-types.js';

function envelope(overrides: Partial<P2pWorkflowLaunchEnvelope> = {}): P2pWorkflowLaunchEnvelope {
  return {
    workflowSchemaVersion: P2P_WORKFLOW_SCHEMA_VERSION,
    workflowKind: 'advanced',
    advancedDraft: {
      schemaVersion: P2P_WORKFLOW_SCHEMA_VERSION,
      id: 'wf-test',
      title: 'Test',
      nodes: [{ id: 'n1', title: 'Discuss', nodeKind: 'llm', preset: 'discuss', permissionScope: 'analysis_only' }],
      edges: [],
    },
    ...overrides,
  };
}

describe('loadDaemonP2pStaticPolicy — UI-driven allowlist (no host JSON)', () => {
  it('returns an empty allowedExecutables (envelope is the source of truth)', () => {
    const policy = loadDaemonP2pStaticPolicy({} as never);
    expect(policy.allowedExecutables).toEqual([]);
  });

  it('does not export the historic JSON loader symbol', async () => {
    // Use dynamic import + reflection so a future regression that re-adds
    // a `loadAllowedExecutables` export (or `~/.imcodes/p2p-policy.json`
    // env override) trips this guard. Strings are intentionally string
    // literals so a textual rename also surfaces.
    const mod = await import('../../src/daemon/p2p-workflow-static-policy.js');
    expect(Object.keys(mod)).not.toContain('loadAllowedExecutables');
    expect(Object.keys(mod)).not.toContain('P2P_DAEMON_POLICY_FILE_ENV');
  });
});

describe('validateP2pWorkflowLaunchEnvelope.allowedExecutables', () => {
  it('accepts a small visible-ASCII allowlist', () => {
    const result = validateP2pWorkflowLaunchEnvelope(envelope({ allowedExecutables: ['/usr/bin/jq', '/bin/echo'] }));
    expect(result.ok).toBe(true);
  });

  it('rejects non-array allowedExecutables', () => {
    const result = validateP2pWorkflowLaunchEnvelope(envelope({ allowedExecutables: 'jq' as unknown as string[] }));
    expect(result.ok).toBe(false);
  });

  it('rejects too many entries (>64)', () => {
    const huge = Array.from({ length: 65 }, (_, index) => `/bin/cmd-${index}`);
    const result = validateP2pWorkflowLaunchEnvelope(envelope({ allowedExecutables: huge }));
    expect(result.ok).toBe(false);
  });

  it('rejects per-entry length > 256', () => {
    const result = validateP2pWorkflowLaunchEnvelope(envelope({ allowedExecutables: ['/bin/' + 'x'.repeat(260)] }));
    expect(result.ok).toBe(false);
  });

  it('rejects multi-byte / non-visible-ASCII entries', () => {
    const result = validateP2pWorkflowLaunchEnvelope(envelope({ allowedExecutables: ['/usr/bin/中文'] }));
    expect(result.ok).toBe(false);
  });

  it('rejects whitespace-bearing entries (visible-ASCII only)', () => {
    const result = validateP2pWorkflowLaunchEnvelope(envelope({ allowedExecutables: ['/usr/bin/with space'] }));
    expect(result.ok).toBe(false);
  });

  it('rejects duplicate entries with explicit fieldPath', () => {
    const result = validateP2pWorkflowLaunchEnvelope(envelope({ allowedExecutables: ['/bin/echo', '/bin/echo'] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const dup = result.diagnostics.find((d) => d.fieldPath === 'allowedExecutables[1]');
      expect(dup?.summary).toMatch(/Duplicate/i);
    }
  });

  it('rejects empty-string entries', () => {
    const result = validateP2pWorkflowLaunchEnvelope(envelope({ allowedExecutables: ['/bin/echo', ''] }));
    expect(result.ok).toBe(false);
  });
});

describe('envelope.allowedExecutables → bind policy (UI-driven allowlist)', () => {
  // The full envelope→compile→bind path is exercised by the orchestrator
  // tests; here we focus on the bind validator directly. The contract is:
  //  - daemon-side default `allowedExecutables` is `[]`
  //  - merging in envelope entries produces a policy that bind validates against
  it('script binds successfully when the envelope-derived policy lists the executable', async () => {
    const { buildDefaultP2pStaticPolicy } = await import('../../shared/p2p-workflow-policy.js');
    const { validateCompiledWorkflowAgainstBindPolicy } = await import('../../src/daemon/p2p-workflow-bind.js');
    const compiled = {
      schemaVersion: 1 as const,
      workflowId: 'wf-1',
      rootNodeId: 'n1',
      nodes: [{
        id: 'n1',
        nodeKind: 'script' as const,
        preset: 'discuss' as const,
        permissionScope: 'analysis_only' as const,
        routingAuthority: { kind: 'none' as const },
        artifacts: [],
        script: { commandKind: 'argv' as const, argv: ['/usr/bin/jq', '.'], env: { mode: 'allowlist' as const, allowed: [] } },
      }],
      edges: [],
      variables: [],
      loopBudgets: {},
      derivedRequiredCapabilities: [],
      staticPolicyHash: 'h',
      workflowContractHash: 'c',
      diagnostics: [],
    };
    const bindContext = {
      runId: 'run-1',
      requestId: 'req-1',
      repoRoot: '/repo',
      participants: [{ sessionName: 'deck_proj_brain' }],
      launchScope: { sessionName: 'deck_proj_brain' },
      capabilitySnapshot: {
        daemonId: 'd-1',
        capabilities: ['p2p.workflow.v1', 'p2p.workflow.script.argv.v1'],
        helloEpoch: 1,
        sentAt: 1,
      },
      policySnapshot: buildDefaultP2pStaticPolicy({ allowedExecutables: ['/usr/bin/jq'] }),
      concurrencyAdmission: { accepted: true as const },
    };
    const diagnostics = validateCompiledWorkflowAgainstBindPolicy(compiled, bindContext);
    expect(diagnostics.find((d) => d.code === 'script_executable_denied')).toBeUndefined();
  });

  it('script bind rejects when the merged policy has an empty allowlist', async () => {
    const { buildDefaultP2pStaticPolicy } = await import('../../shared/p2p-workflow-policy.js');
    const { validateCompiledWorkflowAgainstBindPolicy } = await import('../../src/daemon/p2p-workflow-bind.js');
    const compiled = {
      schemaVersion: 1 as const,
      workflowId: 'wf-1',
      rootNodeId: 'n1',
      nodes: [{
        id: 'n1',
        nodeKind: 'script' as const,
        preset: 'discuss' as const,
        permissionScope: 'analysis_only' as const,
        routingAuthority: { kind: 'none' as const },
        artifacts: [],
        script: { commandKind: 'argv' as const, argv: ['/usr/bin/jq', '.'], env: { mode: 'allowlist' as const, allowed: [] } },
      }],
      edges: [],
      variables: [],
      loopBudgets: {},
      derivedRequiredCapabilities: [],
      staticPolicyHash: 'h',
      workflowContractHash: 'c',
      diagnostics: [],
    };
    const bindContext = {
      runId: 'run-1',
      requestId: 'req-1',
      repoRoot: '/repo',
      participants: [{ sessionName: 'deck_proj_brain' }],
      launchScope: { sessionName: 'deck_proj_brain' },
      capabilitySnapshot: {
        daemonId: 'd-1',
        capabilities: ['p2p.workflow.v1', 'p2p.workflow.script.argv.v1'],
        helloEpoch: 1,
        sentAt: 1,
      },
      policySnapshot: buildDefaultP2pStaticPolicy({ allowedExecutables: [] }),
      concurrencyAdmission: { accepted: true as const },
    };
    const diagnostics = validateCompiledWorkflowAgainstBindPolicy(compiled, bindContext);
    expect(diagnostics.find((d) => d.code === 'script_executable_denied')).toBeDefined();
  });
});
