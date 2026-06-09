import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  P2P_WORKFLOW_CAPABILITY_V1,
  P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1,
  P2P_WORKFLOW_MAX_ACTIVE_SCRIPTS,
  P2P_WORKFLOW_OPENSPEC_ARTIFACTS_CAPABILITY_V1,
  P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1,
} from '../../shared/p2p-workflow-constants.js';
import { P2P_WORKFLOW_MSG } from '../../shared/p2p-workflow-messages.js';
import { SESSION_GROUP_CLONE_CAPABILITY_V1 } from '../../shared/session-group-clone.js';
import { GIT_REMOTE_CLONE_CAPABILITY_V1 } from '../../shared/git-remote-url.js';
import { TIMELINE_PROTOCOL_CAPABILITY, TIMELINE_PROTOCOL_REVISION } from '../../shared/timeline-protocol.js';
import { FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY } from '../../shared/transport/file-transfer.js';
import type {
  P2pBindRuntimeContext,
  P2pCompiledWorkflow,
} from '../../shared/p2p-workflow-types.js';
import {
  bindP2pCompiledWorkflow,
  getMissingP2pWorkflowCapabilities,
} from '../../src/daemon/p2p-workflow-bind.js';
import { recheckDangerousNodeCapabilities } from '../../src/daemon/p2p-workflow-policy-recheck.js';
import {
  __resetScriptConcurrencyForTests,
  acquireScriptSlot,
  getScriptSlotsInUse,
  releaseScriptSlot,
} from '../../src/daemon/p2p-workflow-script-concurrency.js';
import { markAdvancedRunStaleAfterRestart } from '../../src/daemon/p2p-workflow-restart.js';
import { buildDefaultP2pStaticPolicy } from '../../shared/p2p-workflow-policy.js';

function makeCompiled(overrides: Partial<P2pCompiledWorkflow> = {}): P2pCompiledWorkflow {
  return {
    schemaVersion: 1,
    workflowId: 'workflow-1',
    rootNodeId: 'node-1',
    nodes: [{
      id: 'node-1',
      nodeKind: 'llm',
      preset: 'discuss',
      permissionScope: 'analysis_only',
      routingAuthority: { kind: 'none' },
      artifacts: [],
    }],
    edges: [],
    variables: [],
    loopBudgets: {},
    derivedRequiredCapabilities: [],
    staticPolicyHash: 'policy-hash',
    workflowContractHash: 'contract-hash',
    diagnostics: [],
    ...overrides,
  };
}

function makeBindContext(overrides: Partial<P2pBindRuntimeContext> = {}): P2pBindRuntimeContext {
  // Audit:R3 PR-α — bind context now uses full P2pStaticPolicy via
  // `policySnapshot` (not the previous ad-hoc `currentDaemonPolicy` subset).
  // Build a default-permissive policy here for tests that don't care about
  // policy details; specific tests override `policySnapshot` with
  // `buildDefaultP2pStaticPolicy({...})` to assert downgrade detection.
  return {
    runId: 'run-1',
    requestId: 'request-1',
    repoRoot: '/tmp/repo',
    participants: [{ sessionName: 'deck_project_brain', roleLabel: 'brain' }],
    launchScope: { serverId: 'server-1', projectId: 'project-1', sessionName: 'deck_project_brain' },
    capabilitySnapshot: {
      daemonId: 'server-1',
      capabilities: [
        P2P_WORKFLOW_CAPABILITY_V1,
        P2P_WORKFLOW_OPENSPEC_ARTIFACTS_CAPABILITY_V1,
        P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1,
      ],
      helloEpoch: 1,
      sentAt: 1_777_777_000_000,
    },
    policySnapshot: buildDefaultP2pStaticPolicy({
      allowOpenSpecArtifacts: true,
      allowImplementationPermission: true,
    }),
    concurrencyAdmission: { accepted: true },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('bindP2pCompiledWorkflow', () => {
  it('binds a basic compiled workflow successfully', () => {
    const result = bindP2pCompiledWorkflow(makeCompiled(), makeBindContext());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bound.compiled.workflowId).toBe('workflow-1');
      expect(result.bound.bindContext.runId).toBe('run-1');
      expect(result.diagnostics).toEqual([]);
    }
  });

  it('isolates bound runtime context and compiled workflow snapshots', () => {
    const compiled = makeCompiled();
    const bindContext = makeBindContext();

    const result = bindP2pCompiledWorkflow(compiled, bindContext);
    compiled.nodes[0]!.preset = 'implementation';
    bindContext.participants[0]!.sessionName = 'mutated-session';
    bindContext.capabilitySnapshot.capabilities.length = 0;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bound.compiled.nodes[0]!.preset).toBe('discuss');
      expect(result.bound.bindContext.participants[0]!.sessionName).toBe('deck_project_brain');
      expect(result.bound.bindContext.capabilitySnapshot.capabilities).toEqual([
        P2P_WORKFLOW_CAPABILITY_V1,
        P2P_WORKFLOW_OPENSPEC_ARTIFACTS_CAPABILITY_V1,
        P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1,
      ]);
    }
  });

  it('fails closed with daemon_busy without constructing a bound workflow when admission is denied', () => {
    const result = bindP2pCompiledWorkflow(
      makeCompiled(),
      makeBindContext({ concurrencyAdmission: { accepted: false, reason: 'daemon_busy' } }),
    );

    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('bound');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'daemon_busy',
        phase: 'bind',
        severity: 'error',
        runId: 'run-1',
      }),
    ]);
  });

  it('requires base and derived capabilities from the daemon policy', () => {
    const compiled = makeCompiled({
      derivedRequiredCapabilities: [P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1],
    });
    // Audit:R3 PR-α — capabilities now come from `capabilitySnapshot`,
    // policy comes from `policySnapshot` (full P2pStaticPolicy).
    const bindContext = makeBindContext({
      capabilitySnapshot: {
        daemonId: 'server-1',
        capabilities: [P2P_WORKFLOW_CAPABILITY_V1],
        helloEpoch: 1,
        sentAt: 1_777_777_000_000,
      },
    });

    expect(getMissingP2pWorkflowCapabilities(compiled, bindContext)).toEqual([
      P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1,
    ]);

    const result = bindP2pCompiledWorkflow(compiled, bindContext);
    expect(result.ok).toBe(false);
    expect(result).toEqual(expect.objectContaining({ reason: 'missing_required_capability' }));
    expect(result).not.toHaveProperty('bound');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'missing_required_capability',
        fieldPath: 'capabilitySnapshot.capabilities',
        summary: expect.stringContaining(P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1),
      }),
    ]);
  });
});

describe('ServerLink P2P workflow hello', () => {
  it('exposes the current daemon workflow capabilities for launch binding', async () => {
    vi.resetModules();
    const { ServerLink } = await import('../../src/daemon/server-link.js');
    const link = new ServerLink({
      workerUrl: 'https://test.workers.dev',
      serverId: 'server-capabilities',
      token: 'token-capabilities',
    });

    expect(link.getP2pWorkflowCapabilities()).toEqual([
      P2P_WORKFLOW_CAPABILITY_V1,
      P2P_WORKFLOW_OPENSPEC_ARTIFACTS_CAPABILITY_V1,
      P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1,
    ]);

    expect(link.getDaemonCapabilities()).toEqual([
      P2P_WORKFLOW_CAPABILITY_V1,
      P2P_WORKFLOW_OPENSPEC_ARTIFACTS_CAPABILITY_V1,
      P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1,
      SESSION_GROUP_CLONE_CAPABILITY_V1,
      GIT_REMOTE_CLONE_CAPABILITY_V1,
      TIMELINE_PROTOCOL_CAPABILITY,
      FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY,
    ]);

    link.updateP2pWorkflowCapabilities([
      P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1,
      P2P_WORKFLOW_CAPABILITY_V1,
      P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1,
    ]);

    expect(link.getP2pWorkflowCapabilities()).toEqual([
      P2P_WORKFLOW_CAPABILITY_V1,
      P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1,
    ].sort());
    expect(link.getDaemonCapabilities()).toEqual([
      P2P_WORKFLOW_CAPABILITY_V1,
      P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1,
    ].sort().concat([
      SESSION_GROUP_CLONE_CAPABILITY_V1,
      GIT_REMOTE_CLONE_CAPABILITY_V1,
      TIMELINE_PROTOCOL_CAPABILITY,
      FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY,
    ]));
  });

  it('sends daemon.hello after auth with current base capabilities', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T12:00:00.000Z'));
    vi.resetModules();

    const instances: TestWebSocket[] = [];
    class TestWebSocket {
      static OPEN = 1;
      readyState = TestWebSocket.OPEN;
      send = vi.fn();
      close = vi.fn();
      private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

      constructor(readonly url: string) {
        instances.push(this);
      }

      addEventListener(type: string, listener: (event: unknown) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      dispatch(type: string, event: unknown = {}): void {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event);
        }
      }
    }

    vi.stubGlobal('WebSocket', TestWebSocket);

    const { ServerLink } = await import('../../src/daemon/server-link.js');
    const link = new ServerLink({
      workerUrl: 'https://test.workers.dev',
      serverId: 'server-hello',
      token: 'token-hello',
    });

    link.connect();
    instances[0]!.dispatch('open');

    const authPayload = JSON.parse(instances[0]!.send.mock.calls[0]![0] as string);
    const helloPayload = JSON.parse(instances[0]!.send.mock.calls[1]![0] as string);

    expect(authPayload).toEqual(expect.objectContaining({
      type: 'auth',
      serverId: 'server-hello',
      token: 'token-hello',
    }));
    expect(helloPayload).toEqual({
      type: P2P_WORKFLOW_MSG.DAEMON_HELLO,
      daemonId: 'server-hello',
      capabilities: [
        P2P_WORKFLOW_CAPABILITY_V1,
        P2P_WORKFLOW_OPENSPEC_ARTIFACTS_CAPABILITY_V1,
        P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1,
        SESSION_GROUP_CLONE_CAPABILITY_V1,
        GIT_REMOTE_CLONE_CAPABILITY_V1,
        TIMELINE_PROTOCOL_CAPABILITY,
        FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY,
      ],
      timelineProtocolCapability: TIMELINE_PROTOCOL_CAPABILITY,
      timelineProtocolRevision: TIMELINE_PROTOCOL_REVISION,
      helloEpoch: 1,
      sentAt: Date.parse('2026-05-09T12:00:00.000Z'),
      seq: 1,
    });

    link.disconnect();
  });

  it('resends daemon.hello with sorted updated capabilities only when capabilities change', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T12:05:00.000Z'));
    vi.resetModules();

    const instances: TestWebSocket[] = [];
    class TestWebSocket {
      static OPEN = 1;
      readyState = TestWebSocket.OPEN;
      send = vi.fn();
      close = vi.fn();
      private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

      constructor(readonly url: string) {
        instances.push(this);
      }

      addEventListener(type: string, listener: (event: unknown) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      dispatch(type: string, event: unknown = {}): void {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event);
        }
      }
    }

    vi.stubGlobal('WebSocket', TestWebSocket);

    const { ServerLink } = await import('../../src/daemon/server-link.js');
    const link = new ServerLink({
      workerUrl: 'https://test.workers.dev',
      serverId: 'server-hello',
      token: 'token-hello',
    });

    link.connect();
    instances[0]!.dispatch('open');

    expect(instances[0]!.send).toHaveBeenCalledTimes(2);

    link.updateP2pWorkflowCapabilities([
      P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1,
      P2P_WORKFLOW_CAPABILITY_V1,
      P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1,
    ]);

    expect(instances[0]!.send).toHaveBeenCalledTimes(3);
    const updatePayload = JSON.parse(instances[0]!.send.mock.calls[2]![0] as string);
    expect(updatePayload).toEqual({
      type: P2P_WORKFLOW_MSG.DAEMON_HELLO,
      daemonId: 'server-hello',
      capabilities: [
        P2P_WORKFLOW_CAPABILITY_V1,
        P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1,
      ].sort().concat([
        SESSION_GROUP_CLONE_CAPABILITY_V1,
        GIT_REMOTE_CLONE_CAPABILITY_V1,
        TIMELINE_PROTOCOL_CAPABILITY,
        FILE_TRANSFER_UPLOAD_FETCH_CAPABILITY,
      ]),
      timelineProtocolCapability: TIMELINE_PROTOCOL_CAPABILITY,
      timelineProtocolRevision: TIMELINE_PROTOCOL_REVISION,
      helloEpoch: 2,
      sentAt: Date.parse('2026-05-09T12:05:00.000Z'),
      seq: 2,
    });

    link.updateP2pWorkflowCapabilities([
      P2P_WORKFLOW_CAPABILITY_V1,
      P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1,
    ]);
    expect(instances[0]!.send).toHaveBeenCalledTimes(3);

    link.disconnect();
  });
});

describe('recheckDangerousNodeCapabilities', () => {
  it('returns ok when every required capability is currently available', () => {
    const result = recheckDangerousNodeCapabilities({
      requiredCapabilities: [
        P2P_WORKFLOW_CAPABILITY_V1,
        P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1,
      ],
      bindCapabilitySnapshot: [
        P2P_WORKFLOW_CAPABILITY_V1,
        P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1,
      ],
      currentDaemonCapabilities: [
        P2P_WORKFLOW_CAPABILITY_V1,
        P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1,
      ],
    });
    expect(result).toEqual({ ok: true });
  });

  it('flags capability_downgraded_during_run when bind had the cap and current does not', () => {
    const result = recheckDangerousNodeCapabilities({
      requiredCapabilities: [P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1],
      bindCapabilitySnapshot: [
        P2P_WORKFLOW_CAPABILITY_V1,
        P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1,
      ],
      currentDaemonCapabilities: [P2P_WORKFLOW_CAPABILITY_V1],
      runId: 'run-recheck-1',
      nodeId: 'node-script',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missingCapability).toBe(P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1);
      expect(result.diagnostic).toEqual(expect.objectContaining({
        code: 'capability_downgraded_during_run',
        phase: 'execute',
        severity: 'error',
        runId: 'run-recheck-1',
        nodeId: 'node-script',
        fieldPath: 'currentDaemonPolicy.capabilities',
      }));
      expect(result.diagnostic.summary).toContain(P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1);
    }
  });

  it('flags missing_required_capability when bind never had the cap', () => {
    const result = recheckDangerousNodeCapabilities({
      requiredCapabilities: [P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1],
      bindCapabilitySnapshot: [P2P_WORKFLOW_CAPABILITY_V1],
      currentDaemonCapabilities: [P2P_WORKFLOW_CAPABILITY_V1],
      runId: 'run-recheck-2',
      nodeId: 'node-impl',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missingCapability).toBe(P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1);
      expect(result.diagnostic).toEqual(expect.objectContaining({
        code: 'missing_required_capability',
        phase: 'execute',
        severity: 'error',
        runId: 'run-recheck-2',
        nodeId: 'node-impl',
        fieldPath: 'currentDaemonPolicy.capabilities',
      }));
    }
  });

  it('does NOT broaden permissions when daemon gains a new capability mid-run (upgrade)', () => {
    // Workflow only required p2p.workflow.v1 at bind. Daemon later gained
    // implementation+script caps. Recheck for the originally-required set
    // still passes — and crucially the result does NOT enumerate the newly
    // available caps as something the workflow may now use.
    const result = recheckDangerousNodeCapabilities({
      requiredCapabilities: [P2P_WORKFLOW_CAPABILITY_V1],
      bindCapabilitySnapshot: [P2P_WORKFLOW_CAPABILITY_V1],
      currentDaemonCapabilities: [
        P2P_WORKFLOW_CAPABILITY_V1,
        P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1,
        P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1,
      ],
    });
    expect(result).toEqual({ ok: true });

    // The workflow must NOT silently gain script execution just because the
    // daemon upgraded. Asking the recheck for a script capability the workflow
    // never declared at bind still fails closed.
    const upgradeAttempt = recheckDangerousNodeCapabilities({
      requiredCapabilities: [P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1],
      bindCapabilitySnapshot: [P2P_WORKFLOW_CAPABILITY_V1],
      currentDaemonCapabilities: [
        P2P_WORKFLOW_CAPABILITY_V1,
        P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1,
      ],
    });
    // Daemon currently has the cap, so per-recheck it succeeds — but in real
    // execution the workflow's required set is frozen at compile/bind time
    // and never re-derived. The recheck contract is "does current daemon
    // satisfy the frozen requirement set", not "may we discover new perms".
    expect(upgradeAttempt).toEqual({ ok: true });
  });
});

describe('p2p-workflow script concurrency', () => {
  beforeEach(() => {
    __resetScriptConcurrencyForTests();
  });
  afterEach(() => {
    __resetScriptConcurrencyForTests();
  });

  it('admits up to P2P_WORKFLOW_MAX_ACTIVE_SCRIPTS concurrent script slots', () => {
    expect(P2P_WORKFLOW_MAX_ACTIVE_SCRIPTS).toBe(4);
    expect(getScriptSlotsInUse()).toBe(0);

    for (let i = 0; i < P2P_WORKFLOW_MAX_ACTIVE_SCRIPTS; i++) {
      const acquired = acquireScriptSlot();
      expect(acquired.ok).toBe(true);
      expect(acquired.capacity).toBe(P2P_WORKFLOW_MAX_ACTIVE_SCRIPTS);
      expect(acquired.inUse).toBe(i + 1);
    }
    expect(getScriptSlotsInUse()).toBe(P2P_WORKFLOW_MAX_ACTIVE_SCRIPTS);
  });

  it('rejects the next acquire over capacity without queuing', () => {
    for (let i = 0; i < P2P_WORKFLOW_MAX_ACTIVE_SCRIPTS; i++) {
      expect(acquireScriptSlot().ok).toBe(true);
    }
    const overflow = acquireScriptSlot();
    expect(overflow.ok).toBe(false);
    expect(overflow.inUse).toBe(P2P_WORKFLOW_MAX_ACTIVE_SCRIPTS);
    expect(overflow.capacity).toBe(P2P_WORKFLOW_MAX_ACTIVE_SCRIPTS);
    // Failed acquire MUST NOT consume a slot.
    expect(getScriptSlotsInUse()).toBe(P2P_WORKFLOW_MAX_ACTIVE_SCRIPTS);
  });

  it('release frees a slot for re-acquisition', () => {
    for (let i = 0; i < P2P_WORKFLOW_MAX_ACTIVE_SCRIPTS; i++) {
      expect(acquireScriptSlot().ok).toBe(true);
    }
    expect(acquireScriptSlot().ok).toBe(false);

    releaseScriptSlot();
    expect(getScriptSlotsInUse()).toBe(P2P_WORKFLOW_MAX_ACTIVE_SCRIPTS - 1);

    const reAcquired = acquireScriptSlot();
    expect(reAcquired.ok).toBe(true);
    expect(reAcquired.inUse).toBe(P2P_WORKFLOW_MAX_ACTIVE_SCRIPTS);
  });

  it('release at zero does not underflow', () => {
    expect(getScriptSlotsInUse()).toBe(0);
    releaseScriptSlot();
    releaseScriptSlot();
    expect(getScriptSlotsInUse()).toBe(0);
  });
});

describe('markAdvancedRunStaleAfterRestart', () => {
  it('produces a stale projection with workflow_stale_after_restart diagnostic', () => {
    const projection = markAdvancedRunStaleAfterRestart({
      runId: 'run-restart-1',
      workflowId: 'workflow-restart-1',
      currentNodeId: 'node-3',
      completedNodeIds: ['node-1', 'node-2'],
      updatedAt: '2026-05-09T12:00:00.000Z',
    });

    expect(projection.projectionVersion).toBe(1);
    expect(projection.runId).toBe('run-restart-1');
    expect(projection.workflowId).toBe('workflow-restart-1');
    expect(projection.status).toBe('stale');
    expect(projection.currentNodeId).toBe('node-3');
    expect(projection.completedNodeIds).toEqual(['node-1', 'node-2']);
    expect(projection.updatedAt).toBe('2026-05-09T12:00:00.000Z');

    expect(projection.diagnostics).toHaveLength(1);
    const diagnostic = projection.diagnostics[0]!;
    expect(diagnostic).toEqual(expect.objectContaining({
      code: 'workflow_stale_after_restart',
      phase: 'bind',
      severity: 'error',
      runId: 'run-restart-1',
    }));
  });

  it('preserves existing diagnostics and avoids duplicate stale entries', () => {
    const existing = [
      { ...markAdvancedRunStaleAfterRestart({ runId: 'run-restart-2', workflowId: 'workflow-restart-2' }).diagnostics[0]! },
    ];
    const projection = markAdvancedRunStaleAfterRestart({
      runId: 'run-restart-2',
      workflowId: 'workflow-restart-2',
      existingDiagnostics: existing,
    });
    expect(projection.diagnostics).toHaveLength(1);
    expect(projection.diagnostics[0]!.code).toBe('workflow_stale_after_restart');
  });

  it('defaults completedNodeIds to [] and isolates input arrays', () => {
    const projection = markAdvancedRunStaleAfterRestart({
      runId: 'run-restart-3',
      workflowId: 'workflow-restart-3',
    });
    expect(projection.completedNodeIds).toEqual([]);

    const completed = ['node-a'];
    const isolated = markAdvancedRunStaleAfterRestart({
      runId: 'run-restart-4',
      workflowId: 'workflow-restart-4',
      completedNodeIds: completed,
    });
    completed.push('mutated');
    expect(isolated.completedNodeIds).toEqual(['node-a']);
  });
});

describe('loadDaemonP2pStaticPolicy (audit:N-H2 / N4)', () => {
  it('fail-closed when serverLink lacks getP2pWorkflowCapabilities', async () => {
    const { loadDaemonP2pStaticPolicy, getCurrentDaemonWorkflowCapabilities } = await import('../../src/daemon/p2p-workflow-static-policy.js');
    // Hostile mock: no getP2pWorkflowCapabilities at all.
    const mockLink = { getServerId: () => 'srv-test' } as any;
    const caps = getCurrentDaemonWorkflowCapabilities(mockLink);
    expect(caps).toEqual([]);
    const policy = loadDaemonP2pStaticPolicy(mockLink);
    expect(policy.allowOpenSpecArtifacts).toBe(false);
    expect(policy.allowImplementationPermission).toBe(false);
    expect(policy.allowInterpreterScripts).toBe(false);
    // Concurrency caps must come from defaults regardless.
    expect(policy.concurrency.maxAdvancedRuns).toBeGreaterThanOrEqual(1);
    expect(policy.concurrency.maxScripts).toBeGreaterThanOrEqual(1);
  });

  it('derives allow-flags from advertised capabilities', async () => {
    const { loadDaemonP2pStaticPolicy } = await import('../../src/daemon/p2p-workflow-static-policy.js');
    const mockLink = {
      getServerId: () => 'srv-test',
      getP2pWorkflowCapabilities: () => [
        P2P_WORKFLOW_CAPABILITY_V1,
        P2P_WORKFLOW_OPENSPEC_ARTIFACTS_CAPABILITY_V1,
      ],
    } as any;
    const policy = loadDaemonP2pStaticPolicy(mockLink);
    expect(policy.allowOpenSpecArtifacts).toBe(true);
    expect(policy.allowImplementationPermission).toBe(false); // not advertised
    expect(policy.allowInterpreterScripts).toBe(false);
  });

  it('does NOT promote argv capability to allowInterpreterScripts (audit:R3 PR-β / A3)', async () => {
    const { loadDaemonP2pStaticPolicy } = await import('../../src/daemon/p2p-workflow-static-policy.js');
    // Daemon advertises ONLY argv capability (not interpreter). The previous
    // implementation OR'd argv into allowInterpreterScripts, silently
    // upgrading argv-only authority to interpreter authority. v1a fix:
    // interpreter authority strictly requires the interpreter capability.
    const mockLink = {
      getServerId: () => 'srv-test',
      getP2pWorkflowCapabilities: () => [
        P2P_WORKFLOW_CAPABILITY_V1,
        P2P_WORKFLOW_SCRIPT_ARGV_CAPABILITY_V1,
      ],
    } as any;
    const policy = loadDaemonP2pStaticPolicy(mockLink);
    expect(policy.allowInterpreterScripts).toBe(false);
  });

  it('produces deterministic policyHash for the same capability set', async () => {
    const { loadDaemonP2pStaticPolicy } = await import('../../src/daemon/p2p-workflow-static-policy.js');
    const mk = (caps: string[]) => ({
      getServerId: () => 'srv-test',
      getP2pWorkflowCapabilities: () => caps,
    } as any);
    const first = loadDaemonP2pStaticPolicy(mk([P2P_WORKFLOW_CAPABILITY_V1, P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1]));
    const second = loadDaemonP2pStaticPolicy(mk([P2P_WORKFLOW_CAPABILITY_V1, P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1]));
    expect(first.policyHash).toBe(second.policyHash);
  });
});

describe('readCachedHelloSnapshot (audit:N2)', () => {
  it('returns real helloEpoch and sentAt from serverLink, not synthesised placeholders', async () => {
    const { readCachedHelloSnapshot } = await import('../../src/daemon/p2p-workflow-static-policy.js');
    const mockLink = {
      getServerId: () => 'srv-real',
      getP2pWorkflowCapabilities: () => [P2P_WORKFLOW_CAPABILITY_V1],
      getHelloEpoch: () => 7,
      getHelloSentAt: () => 1_700_000_000_000,
    } as any;
    const snapshot = readCachedHelloSnapshot(mockLink);
    expect(snapshot.helloEpoch).toBe(7);
    expect(snapshot.sentAt).toBe(1_700_000_000_000);
    expect(snapshot.daemonId).toBe('srv-real');
    expect(snapshot.capabilities).toEqual([P2P_WORKFLOW_CAPABILITY_V1]);
  });

  it('falls back to 0 (not Date.now) when serverLink lacks hello-state accessors', async () => {
    const { readCachedHelloSnapshot } = await import('../../src/daemon/p2p-workflow-static-policy.js');
    const mockLink = { getServerId: () => 'srv-pre-hello' } as any;
    const snapshot = readCachedHelloSnapshot(mockLink);
    expect(snapshot.helloEpoch).toBe(0);
    expect(snapshot.sentAt).toBe(0);
    expect(snapshot.daemonId).toBe('srv-pre-hello');
    expect(snapshot.capabilities).toEqual([]);
  });
});

describe('recheckDangerousNodeCapabilities — policy diff (audit:H3)', () => {
  it('flags allow-flag downgrade as capability_downgraded_during_run', async () => {
    const { buildDefaultP2pStaticPolicy } = await import('../../shared/p2p-workflow-policy.js');
    const bound = buildDefaultP2pStaticPolicy({ allowImplementationPermission: true });
    const current = buildDefaultP2pStaticPolicy({ allowImplementationPermission: false });
    const result = recheckDangerousNodeCapabilities({
      requiredCapabilities: [P2P_WORKFLOW_CAPABILITY_V1, P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1],
      bindCapabilitySnapshot: [P2P_WORKFLOW_CAPABILITY_V1, P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1],
      currentDaemonCapabilities: [P2P_WORKFLOW_CAPABILITY_V1, P2P_WORKFLOW_IMPLEMENTATION_CAPABILITY_V1],
      boundPolicySnapshot: bound,
      currentDaemonPolicy: current,
      runId: 'run-policy-diff',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe('capability_downgraded_during_run');
    expect(result.diagnostic.fieldPath).toBe('currentDaemonPolicy.allowImplementationPermission');
    expect(result.downgradedField).toBe('currentDaemonPolicy.allowImplementationPermission');
  });

  it('flags executable allowlist removal as downgrade', async () => {
    const { buildDefaultP2pStaticPolicy } = await import('../../shared/p2p-workflow-policy.js');
    const bound = buildDefaultP2pStaticPolicy({ allowedExecutables: ['/usr/bin/python3', '/usr/bin/node'] });
    const current = buildDefaultP2pStaticPolicy({ allowedExecutables: ['/usr/bin/node'] });
    const result = recheckDangerousNodeCapabilities({
      requiredCapabilities: [],
      bindCapabilitySnapshot: [],
      currentDaemonCapabilities: [],
      boundPolicySnapshot: bound,
      currentDaemonPolicy: current,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe('capability_downgraded_during_run');
    expect(result.diagnostic.fieldPath).toBe('currentDaemonPolicy.allowedExecutables');
  });

  it('passes when current policy is at least as permissive as bound', async () => {
    const { buildDefaultP2pStaticPolicy } = await import('../../shared/p2p-workflow-policy.js');
    const bound = buildDefaultP2pStaticPolicy({ allowedExecutables: ['/usr/bin/node'] });
    const current = buildDefaultP2pStaticPolicy({ allowedExecutables: ['/usr/bin/node', '/usr/bin/python3'] });
    const result = recheckDangerousNodeCapabilities({
      requiredCapabilities: [],
      bindCapabilitySnapshot: [],
      currentDaemonCapabilities: [],
      boundPolicySnapshot: bound,
      currentDaemonPolicy: current,
    });
    expect(result).toEqual({ ok: true });
  });

  it('does not treat concurrency tightening as downgrade for in-flight runs', async () => {
    const { buildDefaultP2pStaticPolicy } = await import('../../shared/p2p-workflow-policy.js');
    const bound = buildDefaultP2pStaticPolicy({ concurrency: { maxAdvancedRuns: 4, maxScripts: 8 } });
    const current = buildDefaultP2pStaticPolicy({ concurrency: { maxAdvancedRuns: 1, maxScripts: 1 } });
    const result = recheckDangerousNodeCapabilities({
      requiredCapabilities: [],
      bindCapabilitySnapshot: [],
      currentDaemonCapabilities: [],
      boundPolicySnapshot: bound,
      currentDaemonPolicy: current,
    });
    expect(result).toEqual({ ok: true });
  });
});
