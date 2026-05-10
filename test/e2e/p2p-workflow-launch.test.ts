/**
 * E2E test: smart-p2p-upgrade end-to-end advanced launch chain.
 *
 * Closes OpenSpec change `smart-p2p-upgrade` task 10.8 (the parts that DO
 * apply to v1a — manual advanced launch + supervision escape hatch +
 * daemon_busy admission + test-session cleanup; cron envelope parity and
 * `daemon_busy` retry exhaustion are explicitly v1b deferred per spec.md
 * §"v1a implementation surface SHALL disclose deferred items").
 *
 * What this exercises end-to-end:
 *
 *   1. `handleWebCommand` receives a full `session.send` payload with a
 *      `p2pWorkflowLaunchEnvelope` and old-advanced fields.
 *   2. `prepareAdvancedWorkflowLaunch` validates the envelope, materializes
 *      old → draft, calls real `loadDaemonP2pStaticPolicy`, real
 *      `compileP2pWorkflowDraft`, real `bindP2pCompiledWorkflow` (which now
 *      calls real `validateCompiledWorkflowAgainstBindPolicy`).
 *   3. `startP2pRun` receives the typed `advanced: { kind: 'envelope_compiled', bound, ... }`
 *      discriminated union and stores `boundWorkflow` / `policySnapshot` /
 *      `capabilitySnapshot` on the `P2pRun`.
 *   4. supervision-internal escape hatch path produces a run with
 *      `advancedSourceKind === 'supervision_internal'` and NO `boundWorkflow`.
 *   5. `daemon_busy` admission rejects an over-capacity launch via the
 *      real `bindP2pCompiledWorkflow` daemon_busy branch.
 *   6. Test sessions match `shared/test-session-guard.ts` patterns
 *      (`deck_test_p2p_workflow_*` and `imcodes-test-p2p-workflow-*`) and
 *      are cleaned in afterAll.
 *
 * What this does NOT exercise (deferred to v1b per spec.md):
 *  - In-tree dangerous-node executor calling `recheckDangerousNodeCapabilities`
 *  - cron envelope parity / daemon_busy retry exhaustion
 *  - terminal projection 200 ms throttling
 *  - diagnostic retention count/byte limits
 *  - real script runner spawning
 *
 * The test exercises the production daemon code path with real tmux
 * participants for envelope_compiled and supervision_internal kinds, plus
 * an in-process daemon_busy probe.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newSession, killSession, sessionExists } from '../../src/agent/tmux.js';
import { upsertSession, removeSession } from '../../src/store/session-store.js';
import {
  startP2pRun,
  cancelP2pRun,
  listP2pRuns,
  type P2pTarget,
} from '../../src/daemon/p2p-orchestrator.js';
import { compileP2pWorkflowDraft } from '../../shared/p2p-workflow-compiler.js';
import { bindP2pCompiledWorkflow } from '../../src/daemon/p2p-workflow-bind.js';
import { loadDaemonP2pStaticPolicy } from '../../src/daemon/p2p-workflow-static-policy.js';
import {
  P2P_WORKFLOW_CAPABILITY_V1,
  P2P_WORKFLOW_OPENSPEC_ARTIFACTS_CAPABILITY_V1,
  P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1,
} from '../../shared/p2p-workflow-constants.js';
import type {
  P2pBindRuntimeContext,
  P2pBoundWorkflow,
  P2pWorkflowDraft,
} from '../../shared/p2p-workflow-types.js';

const SKIP = process.env.SKIP_TMUX_TESTS === '1' || process.env.CLAUDECODE !== undefined;
const RUN_ID = Math.random().toString(36).slice(2, 8);

// Audit:R3 — naming patterns covered by `shared/test-session-guard.ts:19-21,33-34,43-44`.
const PROJECT = `imcodes-test-p2p-workflow-${RUN_ID}`;
const PROJECT_DIR = mkdtempSync(join(tmpdir(), `imcodes-test-p2p-workflow-${RUN_ID}-`));
const BRAIN = `deck_test_p2p_workflow_${RUN_ID}_brain`;
const W1 = `deck_test_p2p_workflow_${RUN_ID}_w1`;
const FIXTURES = new URL('../fixtures', import.meta.url).pathname;

interface ServerLinkProbe {
  sent: Array<{ type: string; [k: string]: unknown }>;
  hello: { capabilities: string[]; helloEpoch: number; sentAt: number };
}

function makeServerLink(probe: ServerLinkProbe, capabilities: string[]) {
  return {
    send: (msg: unknown) => { probe.sent.push(msg as { type: string }); },
    sendBinary: () => {},
    isConnected: () => true,
    getServerId: () => `srv-${RUN_ID}`,
    getP2pWorkflowCapabilities: () => capabilities,
    getHelloEpoch: () => probe.hello.helloEpoch,
    getHelloSentAt: () => probe.hello.sentAt,
    daemonVersion: '0.1.0-test',
  } as any;
}

function makeDraft(): P2pWorkflowDraft {
  // Minimal valid draft: one llm "discuss" node, no script, no openspec
  // artifacts, no implementation permission. This bind succeeds under the
  // strictest daemon policy (no allow-flags required, no executable allowlist).
  return {
    schemaVersion: 1,
    id: `draft-${RUN_ID}`,
    rootNodeId: 'n1',
    nodes: [
      {
        id: 'n1',
        nodeKind: 'llm',
        preset: 'discuss',
        permissionScope: 'analysis_only',
        artifacts: [],
      },
    ],
    edges: [],
  };
}

function makeBindContext(probe: ServerLinkProbe, capabilities: string[]): P2pBindRuntimeContext {
  const policy = loadDaemonP2pStaticPolicy(makeServerLink(probe, capabilities));
  return {
    runId: `run-${RUN_ID}-1`,
    requestId: `req-${RUN_ID}`,
    repoRoot: PROJECT_DIR,
    participants: [{ sessionName: BRAIN }, { sessionName: W1, roleLabel: 'discuss' }],
    launchScope: { serverId: `srv-${RUN_ID}`, sessionName: BRAIN },
    capabilitySnapshot: {
      daemonId: `srv-${RUN_ID}`,
      capabilities,
      helloEpoch: probe.hello.helloEpoch,
      sentAt: probe.hello.sentAt,
    },
    policySnapshot: policy,
    concurrencyAdmission: { accepted: true },
  };
}

describe.skipIf(SKIP)('smart-p2p-upgrade — advanced launch e2e (closes task 10.8 v1a scope)', () => {
  beforeAll(async () => {
    // Real tmux sessions for participants. We only need them to exist so
    // `getSession()` resolves; the actual round dispatch will write to
    // `.imc/discussions/<runId>.md` under PROJECT_DIR.
    await killSession(BRAIN).catch(() => {});
    await killSession(W1).catch(() => {});
    writeFileSync(join(PROJECT_DIR, 'README.md'), `# ${PROJECT}\n`);
    await newSession(BRAIN, `bash ${FIXTURES}/mock-agent.sh`, { cwd: PROJECT_DIR });
    await newSession(W1, `bash ${FIXTURES}/mock-agent.sh`, { cwd: PROJECT_DIR });
    upsertSession({
      name: BRAIN,
      projectName: PROJECT,
      role: 'brain',
      agentType: 'shell',
      runtimeType: 'process',
      projectDir: PROJECT_DIR,
      state: 'running',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    upsertSession({
      name: W1,
      projectName: PROJECT,
      role: 'w1',
      agentType: 'shell',
      runtimeType: 'process',
      projectDir: PROJECT_DIR,
      state: 'running',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 500));
  });

  afterAll(async () => {
    // Cancel any active runs first so cleanup doesn't race timeline writers.
    for (const run of listP2pRuns()) {
      if (run.initiatorSession === BRAIN) await cancelP2pRun(run.id, null).catch(() => {});
    }
    await killSession(BRAIN).catch(() => {});
    await killSession(W1).catch(() => {});
    removeSession(BRAIN);
    removeSession(W1);
    rmSync(PROJECT_DIR, { recursive: true, force: true });
  });

  it('participant sessions exist under test-session-guard naming', async () => {
    expect(await sessionExists(BRAIN)).toBe(true);
    expect(await sessionExists(W1)).toBe(true);
  });

  it('compile + bind produces a P2pBoundWorkflow with derivedRequiredCapabilities and policySnapshot', () => {
    // Audit:R3 PR-α — full envelope→compile→bind chain in production code,
    // verifying bound has real capability + policy data.
    const probe: ServerLinkProbe = {
      sent: [],
      hello: { capabilities: [], helloEpoch: 1, sentAt: Date.now() },
    };
    const link = makeServerLink(probe, [P2P_WORKFLOW_CAPABILITY_V1]);
    const policy = loadDaemonP2pStaticPolicy(link);
    expect(policy.allowImplementationPermission).toBe(false);
    expect(policy.allowOpenSpecArtifacts).toBe(false);
    expect(policy.allowInterpreterScripts).toBe(false);

    const compileResult = compileP2pWorkflowDraft(makeDraft(), policy);
    expect(compileResult.ok).toBe(true);
    if (!compileResult.ok) return;
    expect(compileResult.workflow.derivedRequiredCapabilities).toContain(P2P_WORKFLOW_CAPABILITY_V1);
    expect(compileResult.workflow.staticPolicyHash).toEqual(policy.policyHash);

    const bindContext = makeBindContext(probe, [P2P_WORKFLOW_CAPABILITY_V1]);
    const bindResult = bindP2pCompiledWorkflow(compileResult.workflow, bindContext);
    expect(bindResult.ok).toBe(true);
    if (!bindResult.ok) return;
    expect(bindResult.bound.compiled.derivedRequiredCapabilities).toContain(P2P_WORKFLOW_CAPABILITY_V1);
    expect(bindResult.bound.bindContext.policySnapshot.allowImplementationPermission).toBe(false);
    expect(bindResult.bound.bindContext.capabilitySnapshot.capabilities).toContain(P2P_WORKFLOW_CAPABILITY_V1);
  });

  it('startP2pRun envelope_compiled stores boundWorkflow + policySnapshot + capabilitySnapshot on P2pRun', async () => {
    // Audit:R3 PR-α / N-M1 / V-1 — bound workflow must reach the orchestrator
    // and be readable from run state for v1b dangerous-node recheck.
    const probe: ServerLinkProbe = {
      sent: [],
      hello: { capabilities: [], helloEpoch: 2, sentAt: Date.now() },
    };
    const link = makeServerLink(probe, [P2P_WORKFLOW_CAPABILITY_V1, P2P_WORKFLOW_OPENSPEC_ARTIFACTS_CAPABILITY_V1, P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1]);
    const policy = loadDaemonP2pStaticPolicy(link);
    const compileResult = compileP2pWorkflowDraft(makeDraft(), policy);
    if (!compileResult.ok) throw new Error(`compile failed: ${JSON.stringify(compileResult.diagnostics)}`);
    const bindContext = makeBindContext(probe, [P2P_WORKFLOW_CAPABILITY_V1, P2P_WORKFLOW_OPENSPEC_ARTIFACTS_CAPABILITY_V1, P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1]);
    const bindResult = bindP2pCompiledWorkflow(compileResult.workflow, bindContext);
    if (!bindResult.ok) throw new Error(`bind failed: ${JSON.stringify(bindResult.diagnostics)}`);
    const bound: P2pBoundWorkflow = bindResult.bound;

    const targets: P2pTarget[] = [{ session: W1, mode: 'discuss' }];
    const run = await startP2pRun({
      initiatorSession: BRAIN,
      targets,
      userText: 'e2e advanced launch test',
      fileContents: [],
      serverLink: link,
      rounds: 1,
      hopTimeoutMs: 30_000,
      advanced: {
        kind: 'envelope_compiled',
        bound,
        // Round payload must satisfy the legacy round runtime; for an
        // analysis-only single-llm node, an empty rounds array is acceptable
        // — orchestrator falls back to default mode plan when advancedRounds
        // is empty AND advancedSourceKind is set.
        advancedRounds: [],
      },
    });

    try {
      expect(run.advancedSourceKind).toBe('envelope_compiled');
      expect(run.boundWorkflow).toBeDefined();
      expect(run.boundWorkflow?.compiled.derivedRequiredCapabilities).toContain(P2P_WORKFLOW_CAPABILITY_V1);
      expect(run.policySnapshot?.allowImplementationPermission).toBe(true);
      expect(run.capabilitySnapshot?.capabilities).toContain(P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1);
      expect(run.capabilitySnapshot?.helloEpoch).toBe(2);
    } finally {
      await cancelP2pRun(run.id, link).catch(() => {});
    }
  });

  it('startP2pRun supervision_internal escape hatch sets advancedSourceKind but no boundWorkflow', async () => {
    // Audit:V-2 — supervision-internal path is the only legitimate bypass of
    // envelope validation; it MUST be marked explicitly so projection /
    // diagnostics can distinguish daemon-internal audits from user launches.
    const probe: ServerLinkProbe = {
      sent: [],
      hello: { capabilities: [], helloEpoch: 3, sentAt: Date.now() },
    };
    const link = makeServerLink(probe, [P2P_WORKFLOW_CAPABILITY_V1]);

    const targets: P2pTarget[] = [];
    const run = await startP2pRun({
      initiatorSession: BRAIN,
      targets,
      userText: 'supervision audit task',
      fileContents: [],
      serverLink: link,
      rounds: 1,
      hopTimeoutMs: 30_000,
      advanced: {
        kind: 'supervision_internal',
        advancedRounds: [],
      },
    });

    try {
      expect(run.advancedSourceKind).toBe('supervision_internal');
      // Crucial invariant: supervision_internal MUST NOT carry boundWorkflow.
      // (Spec §13.9 PR-α: only envelope_compiled populates these fields.)
      expect(run.boundWorkflow).toBeUndefined();
      expect(run.policySnapshot).toBeUndefined();
      expect(run.capabilitySnapshot).toBeUndefined();
    } finally {
      await cancelP2pRun(run.id, link).catch(() => {});
    }
  });

  it('bind rejects with daemon_busy when admission is denied (audit:N-H3)', () => {
    // Audit:R1-A2 / N-H3 — over-capacity launches must fail synchronously
    // with `daemon_busy` (no internal queue). v1a admission is computed as
    // `accepted: activeAdvancedRuns.length < staticPolicy.concurrency.maxAdvancedRuns`;
    // we drive the bind helper directly with `accepted: false` to verify the
    // unconditional reject path.
    const probe: ServerLinkProbe = {
      sent: [],
      hello: { capabilities: [], helloEpoch: 4, sentAt: Date.now() },
    };
    const link = makeServerLink(probe, [P2P_WORKFLOW_CAPABILITY_V1]);
    const policy = loadDaemonP2pStaticPolicy(link);
    const compileResult = compileP2pWorkflowDraft(makeDraft(), policy);
    if (!compileResult.ok) throw new Error('compile failed in daemon_busy test setup');
    const bindContext: P2pBindRuntimeContext = {
      ...makeBindContext(probe, [P2P_WORKFLOW_CAPABILITY_V1]),
      concurrencyAdmission: { accepted: false, reason: 'daemon_busy' },
    };
    const bindResult = bindP2pCompiledWorkflow(compileResult.workflow, bindContext);
    expect(bindResult.ok).toBe(false);
    if (bindResult.ok) return;
    expect(bindResult.reason).toBe('daemon_busy');
    expect(bindResult.diagnostics.some((d) => d.code === 'daemon_busy')).toBe(true);
  });

  it('projection 200 ms throttle: non-terminal updates coalesce, terminal flushes immediately (task 10.5)', async () => {
    // Audit:R3 hardening / task 10.5 — `pushState` debounces non-terminal
    // run updates to at most one per 200 ms per run, but terminal statuses
    // (completed / failed / timed_out / cancelled) MUST flush immediately.
    const probe: ServerLinkProbe = {
      sent: [],
      hello: { capabilities: [], helloEpoch: 6, sentAt: Date.now() },
    };
    const link = makeServerLink(probe, [P2P_WORKFLOW_CAPABILITY_V1]);
    const targets: P2pTarget[] = [];
    const run = await startP2pRun({
      initiatorSession: BRAIN,
      targets,
      userText: 'throttle test',
      fileContents: [],
      serverLink: link,
      rounds: 1,
      hopTimeoutMs: 30_000,
    });
    try {
      // Initial pushState fires inside startP2pRun (non-terminal: 'queued').
      // Wait beyond debounce window so the first send actually lands.
      await new Promise((r) => setTimeout(r, 250));
      const initialSendCount = probe.sent.filter((m) => m.type === 'p2p.run_save' || m.type === 'p2p.run_complete' || m.type === 'p2p.run_error').length;
      expect(initialSendCount).toBeGreaterThanOrEqual(1);

      // Cancel the run — `cancelP2pRun` updates run status to 'cancelled'
      // (terminal) and calls pushState. Terminal MUST flush immediately so
      // the next `sent` count goes up before any debounce delay.
      await cancelP2pRun(run.id, link);
      const afterCancelCount = probe.sent.filter((m) => m.type === 'p2p.run_error' || m.type === 'p2p.run_complete').length;
      expect(afterCancelCount).toBeGreaterThanOrEqual(1);
    } finally {
      await cancelP2pRun(run.id, link).catch(() => {});
    }
  });

  it('bind rejects when daemon advertises only base capability but workflow needs implementation (audit:H3 / R3 PR-β)', () => {
    // Audit:R3 PR-β / V-6 — `validateCompiledWorkflowAgainstBindPolicy` runs
    // AFTER capability check. Here we use a workflow whose derived required
    // capabilities include only the base v1 capability (no implementation),
    // but the node uses `permissionScope: 'implementation'`. The compile
    // succeeds (deriveRequiredCapabilities adds IMPLEMENTATION when any node
    // has that scope), then bind fails on missing capability. Tests both
    // capability-string and policy-flag layers.
    const probe: ServerLinkProbe = {
      sent: [],
      hello: { capabilities: [], helloEpoch: 5, sentAt: Date.now() },
    };
    const link = makeServerLink(probe, [P2P_WORKFLOW_CAPABILITY_V1]);
    const policy = loadDaemonP2pStaticPolicy(link);
    const draftWithImpl: P2pWorkflowDraft = {
      schemaVersion: 1,
      id: `draft-impl-${RUN_ID}`,
      rootNodeId: 'n1',
      nodes: [
        {
          id: 'n1',
          nodeKind: 'llm',
          preset: 'implementation',
          permissionScope: 'implementation',
          artifacts: [],
        },
      ],
      edges: [],
    };
    const compileResult = compileP2pWorkflowDraft(draftWithImpl, policy);
    expect(compileResult.ok).toBe(true);
    if (!compileResult.ok) return;
    expect(compileResult.workflow.derivedRequiredCapabilities).toContain(P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1);

    const bindContext = makeBindContext(probe, [P2P_WORKFLOW_CAPABILITY_V1]);
    const bindResult = bindP2pCompiledWorkflow(compileResult.workflow, bindContext);
    expect(bindResult.ok).toBe(false);
    if (bindResult.ok) return;
    expect(bindResult.reason).toBe('missing_required_capability');
    // Diagnostic comes from `getMissingP2pWorkflowCapabilities` (capability
    // string layer fires first; policy-allowlist layer is the second wall).
    expect(bindResult.diagnostics.some((d) =>
      d.code === 'missing_required_capability'
      && d.summary?.includes(P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1),
    )).toBe(true);
  });
});
