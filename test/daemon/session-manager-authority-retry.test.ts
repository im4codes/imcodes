import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  store: new Map<string, Record<string, any>>(),
  deliveries: [] as Array<{ text: string; clientMessageId?: string }>,
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: vi.fn(() => [...harness.store.values()]),
  getSession: vi.fn((name: string) => harness.store.get(name) ?? null),
  upsertSession: vi.fn((record: Record<string, any>) => {
    if (record.name) harness.store.set(record.name, record);
  }),
  removeSession: vi.fn((name: string) => harness.store.delete(name)),
  updateSessionState: vi.fn(),
}));

vi.mock('../../src/agent/provider-registry.js', () => ({
  ensureProviderConnected: vi.fn(async () => ({ id: 'retry-test-provider' })),
  registerProviderRoute: vi.fn(),
  unregisterProviderRoute: vi.fn(),
  getProvider: vi.fn(),
}));

vi.mock('../../src/agent/transport-session-runtime.js', () => ({
  TransportSessionRuntime: class FakeTransportSessionRuntime {
    providerSessionId: string | null = null;
    readonly recipientIdentity: { sessionInstanceId: string; runtimeEpoch: string } | null;
    pendingCount = 0;
    pendingVersion = 0;
    sending = false;
    queueRecipientRecoveryChanged = false;
    onStatusChange?: (status: string) => void;
    onDrain?: (...args: any[]) => void;
    onActiveAppend?: (...args: any[]) => void;
    onSessionInfoChange?: (...args: any[]) => void;
    onStartupMemoryInjected?: (...args: any[]) => void;
    onProviderSessionReady?: () => void;
    pendingDrainAdmission?: (...args: any[]) => unknown;

    constructor(
      _provider: unknown,
      _sessionName: string,
      recipientIdentity: { sessionInstanceId: string; runtimeEpoch: string } | null,
    ) {
      this.recipientIdentity = recipientIdentity;
    }

    setContextBootstrapResolver(): void {}
    setSupervisionSnapshotResolver(): void {}
    async initialize(input: { sessionKey?: string }): Promise<void> {
      this.providerSessionId = input.sessionKey ?? 'retry-test-route';
    }
    adoptOrRebindQueueRecipient(): boolean { return true; }
    rebindQueueRecipient(): boolean { return true; }
    discardDurableQueueStateForRecipientConflict(): number { return 0; }
    rehydratePendingFromStore(): number { return 0; }
    drainPendingIfIdle(): void {}
    getSessionInfo(): Record<string, never> { return {}; }
    getStatus(): string { return 'idle'; }
    getDiagnosticSnapshot(): { completedTurn: null } { return { completedTurn: null }; }
    async appendExternalMessageToActiveTurn(
      text: string,
      clientMessageId?: string,
    ): Promise<'sent'> {
      harness.deliveries.push({ text, clientMessageId });
      return 'sent';
    }
    send(
      text: string,
      clientMessageId?: string,
    ): 'sent' {
      harness.deliveries.push({ text, clientMessageId });
      return 'sent';
    }
  },
}));

vi.mock('../../src/agent/runtime-context-bootstrap.js', () => ({
  resolveTransportContextBootstrap: vi.fn(async () => ({
    namespace: undefined,
    diagnostics: undefined,
    remoteProcessedFreshness: undefined,
    localProcessedFreshness: undefined,
    retryExhausted: false,
    sharedPolicyOverride: undefined,
  })),
}));

vi.mock('../../src/daemon/session-resource-service.js', () => ({
  registerTmuxSessionResource: vi.fn().mockResolvedValue(undefined),
  releaseSessionChildResources: vi.fn().mockResolvedValue({ released: 0, failed: 0 }),
  releaseSessionResources: vi.fn().mockResolvedValue({ released: 0, failed: 0 }),
  resourceOwnerEnv: vi.fn(() => ({})),
  initializeSessionResourceLifecycle: vi.fn().mockResolvedValue({ released: 0, preserved: 0, failed: 0 }),
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: vi.fn(), on: vi.fn(() => () => {}), epoch: 0, replay: vi.fn(() => ({ events: [], truncated: false })) },
}));

vi.mock('../../src/daemon/timeline-store.js', () => ({
  timelineStore: { readByTypesPreferred: vi.fn(async () => []) },
}));

vi.mock('../../src/util/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/agent/brain-dispatcher.js', () => ({
  BrainDispatcher: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

import { launchTransportSession, stopTransportRuntimeSession } from '../../src/agent/session-manager.js';
import {
  clearAllResend,
  enqueueResend,
  getResendCount,
} from '../../src/daemon/transport-resend-queue.js';
import { getTransportQueueStore, resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';
import {
  getSupervisionTaskRegistry,
  resetSupervisionTaskRegistryForTests,
} from '../../src/daemon/supervision-state-store.js';

function seedAuthorityOutage(input: {
  sessionName: string;
  taskId: string;
  assignmentId: string;
  revision: string;
}) {
  const registry = getSupervisionTaskRegistry();
  const brain = harness.store.get(input.sessionName)!;
  const brainIdentity = {
    sessionName: input.sessionName,
    sessionInstanceId: String(brain.sessionInstanceId),
    runtimeEpoch: String(brain.runtimeEpoch),
    agentType: String(brain.agentType),
    providerFamily: 'openai',
  };
  expect(registry.createOrGet({
    taskId: input.taskId,
    projectName: String(brain.projectName),
    classification: 'independent_top_level',
    objective: 'retry a durable wake after transient registry outage',
    currentRevision: input.revision,
  })).toMatchObject({ ok: true });
  expect(registry.createAssignment({
    taskId: input.taskId,
    role: 'coordinator',
    required: false,
    identity: brainIdentity,
    auditRevision: input.revision,
  } as never)).toMatchObject({ ok: true });
  expect(registry.createAssignment({
    taskId: input.taskId,
    assignmentId: input.assignmentId,
    role: 'implementer',
    identity: {
      sessionName: `${input.sessionName}_worker`,
      sessionInstanceId: `${input.assignmentId}-instance`,
      runtimeEpoch: `${input.assignmentId}-epoch`,
      agentType: 'codex-sdk',
      providerFamily: 'openai',
    },
    auditRevision: input.revision,
  })).toMatchObject({ ok: true });
  expect(registry.updateTask({
    taskId: input.taskId,
    status: 'ready_for_audit',
    currentRevision: input.revision,
  })).toMatchObject({ ok: true });
  expect(registry.updateAssignment({
    assignmentId: input.assignmentId,
    identity: registry.getAssignment(input.assignmentId)!.identity,
    status: 'ready_for_audit',
  })).toMatchObject({ ok: true });
  const exactError = 'missing_current_revision';
  const blocker = JSON.stringify({
    kind: 'automatic_audit_routing',
    taskId: input.taskId,
    assignmentId: input.assignmentId,
    revision: input.revision,
    exactError,
  });
  expect(registry.recordAutomaticAuditRoutingBlocker({
    taskId: input.taskId,
    assignmentId: input.assignmentId,
    blocker,
  })).toMatchObject({ ok: true });

  const originalGetTaskRecord = registry.getTaskRecord.bind(registry);
  let unavailable = true;
  let attempts = 0;
  const getTaskRecord = vi.spyOn(registry, 'getTaskRecord').mockImplementation((taskId) => {
    if (taskId === input.taskId) {
      attempts += 1;
      if (unavailable) throw new Error('transient registry outage');
    }
    return originalGetTaskRecord(taskId);
  });
  return {
    supervisionReference: {
      kind: 'implementation_blocker' as const,
      taskId: input.taskId,
      assignmentId: input.assignmentId,
      revision: input.revision,
      exactError,
    },
    recover: () => { unavailable = false; },
    attempts: () => attempts,
    restore: () => getTaskRecord.mockRestore(),
  };
}

function seedBrain(sessionName: string): { sessionInstanceId: string; runtimeEpoch: string } {
  const recipient = {
    sessionInstanceId: `${sessionName}-instance`,
    runtimeEpoch: `${sessionName}-epoch`,
  };
  harness.store.set(sessionName, {
    name: sessionName,
    ...recipient,
    projectName: 'sessionmanagerretry',
    role: 'brain',
    agentType: 'codex-sdk',
    projectDir: '/tmp/session-manager-authority-retry',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    runtimeType: 'transport',
    providerId: 'retry-test-provider',
    providerSessionId: `${sessionName}-route`,
  });
  return recipient;
}

describe('session-manager bounded supervision authority retry', () => {
  beforeEach(() => {
    harness.store.clear();
    harness.deliveries.length = 0;
    clearAllResend();
    resetTransportQueueStoreForTests();
    resetSupervisionTaskRegistryForTests();
  });

  afterEach(async () => {
    for (const name of harness.store.keys()) await stopTransportRuntimeSession(name).catch(() => {});
    vi.clearAllMocks();
    clearAllResend();
    resetTransportQueueStoreForTests();
    resetSupervisionTaskRegistryForTests();
  });

  it('redrains after transient authority recovery without traffic or ordinary-message head-of-line blocking', async () => {
    const sessionName = 'deck_session_manager_retry_brain';
    const supervisionId = 'session-manager-authority-retry';
    const recipient = seedBrain(sessionName);
    const authority = seedAuthorityOutage({
      sessionName,
      taskId: 'tsk-session-manager-retry',
      assignmentId: 'asg-session-manager-retry',
      revision: 'r1',
    });
    enqueueResend(sessionName, {
      text: 'transient supervision wake',
      commandId: supervisionId,
      clientMessageId: supervisionId,
      queuedAt: Date.now(),
      recipient,
      supervisionReference: authority.supervisionReference,
    });
    enqueueResend(sessionName, {
      text: 'ordinary tail must not wait',
      commandId: 'ordinary-tail',
      clientMessageId: 'ordinary-tail',
      queuedAt: Date.now(),
      recipient,
    });

    try {
      await launchTransportSession({
        name: sessionName,
        projectName: 'sessionmanagerretry',
        role: 'brain',
        agentType: 'codex-sdk',
        projectDir: '/tmp/session-manager-authority-retry',
      });
      expect(harness.deliveries.filter((entry) => entry.clientMessageId === 'ordinary-tail')).toHaveLength(1);
      expect(getResendCount(sessionName)).toBe(1);
      expect(getTransportQueueStore().hasDeliveryTombstone(sessionName, supervisionId)).toBe(false);

      authority.recover();
      await vi.waitFor(() => expect(getResendCount(sessionName)).toBe(0), { timeout: 1_000 });
      expect(harness.deliveries.filter((entry) => entry.clientMessageId === supervisionId)).toHaveLength(1);
      expect(getTransportQueueStore().hasDeliveryTombstone(sessionName, supervisionId)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(harness.deliveries.filter((entry) => entry.clientMessageId === supervisionId)).toHaveLength(1);
    } finally {
      authority.restore();
    }
  });

  it('caps authority retries at six exponential-backoff attempts', async () => {
    vi.useFakeTimers();
    const sessionName = 'deck_session_manager_retry_bound_brain';
    const supervisionId = 'session-manager-authority-retry-bound';
    const recipient = seedBrain(sessionName);
    const authority = seedAuthorityOutage({
      sessionName,
      taskId: 'tsk-session-manager-retry-bound',
      assignmentId: 'asg-session-manager-retry-bound',
      revision: 'r1',
    });
    enqueueResend(sessionName, {
      text: 'bounded transient supervision wake',
      commandId: supervisionId,
      clientMessageId: supervisionId,
      queuedAt: Date.now(),
      recipient,
      supervisionReference: authority.supervisionReference,
    });

    try {
      await launchTransportSession({
        name: sessionName,
        projectName: 'sessionmanagerretry',
        role: 'brain',
        agentType: 'codex-sdk',
        projectDir: '/tmp/session-manager-authority-retry',
      });
      const initialAttempts = authority.attempts();
      expect(initialAttempts).toBeGreaterThanOrEqual(1);
      await vi.advanceTimersByTimeAsync(5_100);
      expect(authority.attempts()).toBe(initialAttempts + 6);
      expect(getResendCount(sessionName)).toBe(1);
      expect(getTransportQueueStore().hasDeliveryTombstone(sessionName, supervisionId)).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(authority.attempts()).toBe(initialAttempts + 6);
    } finally {
      authority.restore();
      vi.useRealTimers();
    }
  });
});
