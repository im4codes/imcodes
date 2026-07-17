import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PEER_AUDIT_COMPLETED_TURN_PAYLOAD_FIELD,
  PEER_AUDIT_PROMPT_VERSION,
  PEER_AUDIT_REPLY_VERSION,
} from '../../shared/peer-audit.js';
import type { SessionRecord } from '../../src/store/session-store.js';

const dispatchMock = vi.fn();
const cancelQueuedMock = vi.fn();
const persistMock = vi.fn();
const emitResultMock = vi.fn();
const emitStatusMock = vi.fn();

vi.mock('../../src/daemon/session-dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/daemon/session-dispatch.js')>();
  return {
    ...actual,
    dispatchPeerAuditMessage: (...args: unknown[]) => dispatchMock(...args),
    cancelQueuedPeerAuditMessage: (...args: unknown[]) => cancelQueuedMock(...args),
  };
});

vi.mock('../../src/agent/session-manager.js', () => ({
  persistSessionRecord: (...args: unknown[]) => persistMock(...args),
  getTransportRuntime: vi.fn(() => undefined),
}));

vi.mock('../../src/daemon/peer-audit-result.js', () => ({
  emitPeerAuditResult: (...args: unknown[]) => emitResultMock(...args),
  emitPeerAuditStatus: (...args: unknown[]) => emitStatusMock(...args),
  peerAuditResultEventId: (attemptId: string) => `result:${attemptId}`,
}));

const { PeerAuditService } = await import('../../src/daemon/peer-audit-service.js');
const { resolvePeerAuditCandidateList } = await import('../../src/daemon/peer-audit-candidates.js');
const { getSession, removeSession, upsertSession, listSessions } = await import('../../src/store/session-store.js');
const { timelineEmitter } = await import('../../src/daemon/timeline-emitter.js');

function session(name: string, patch: Partial<SessionRecord> = {}): SessionRecord {
  const main = name.endsWith('_brain');
  return {
    name,
    sessionInstanceId: `instance-${name}`,
    runtimeEpoch: `runtime-${name}`,
    projectName: 'peer-service',
    projectDir: '/repo',
    role: main ? 'brain' : 'w1',
    parentSession: main ? undefined : 'deck_peer_service_brain',
    agentType: 'codex-sdk',
    runtimeType: 'transport',
    providerId: main ? 'openai' : 'anthropic',
    activeModel: main ? 'gpt-5' : 'claude-opus',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('PeerAuditService integration', () => {
  beforeEach(() => {
    for (const record of listSessions()) {
      if (record.projectName === 'peer-service') removeSession(record.name);
    }
    dispatchMock.mockReset();
    cancelQueuedMock.mockReset();
    persistMock.mockReset();
    emitResultMock.mockReset();
    emitStatusMock.mockReset();
    dispatchMock.mockImplementation(async ({ target }: { target: SessionRecord }) => ({
      ok: true,
      receipt: {
        disposition: 'sent',
        dispatchId: 'dispatch_1',
        messageId: 'message_1',
        targetSessionInstanceId: target.sessionInstanceId!,
        targetRuntimeEpoch: target.runtimeEpoch!,
      },
    }));
  });

  it('runs Quick from an off-mode completed baseline, persists only the target, and accepts one structured reply', async () => {
    upsertSession(session('deck_peer_service_brain', { transportConfig: { supervision: { mode: 'off' } } }));
    upsertSession(session('deck_sub_abc12345'));
    const main = getSession('deck_peer_service_brain')!;
    const peer = getSession('deck_sub_abc12345')!;
    const service = new PeerAuditService();
    const generation = service.beginTopLevelIntent(main, 'task_1', 'audit my completed change')!;
    service.recordTerminalResult({
      sessionName: main.name,
      auditedSessionInstanceId: main.sessionInstanceId!,
      auditedRuntimeEpoch: main.runtimeEpoch!,
      taskCommandId: 'task_1',
      generationOrEpoch: generation,
      assistantText: 'implemented and tested',
      completedEventId: 'event_1',
      completedAt: 100,
      terminal: true,
      topLevel: true,
    });
    service.updateWorkState(main.name, { foreground: false, background: false, pendingCompletion: false, subagent: false });
    const list = resolvePeerAuditCandidateList({ auditedSessionName: main.name, allSessions: listSessions() });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const result = await service.startQuick({
      commandId: 'command_1',
      auditedSessionName: main.name,
      auditedSessionInstanceId: main.sessionInstanceId!,
      candidateRevision: list.list.revision,
      targetConfigRevision: list.list.targetConfigRevision,
      selectionIntent: 'explicit_picker',
      target: {
        auditorSessionName: peer.name,
        auditorSessionInstanceId: peer.sessionInstanceId!,
        auditorRuntimeEpoch: peer.runtimeEpoch!,
      },
    });
    if (!result.ok) throw new Error(result.error);
    const replay = await service.startQuick({
      commandId: 'command_1',
      auditedSessionName: main.name,
      auditedSessionInstanceId: main.sessionInstanceId!,
      candidateRevision: list.list.revision,
      targetConfigRevision: list.list.targetConfigRevision,
      selectionIntent: 'explicit_picker',
      target: {
        auditorSessionName: peer.name,
        auditorSessionInstanceId: peer.sessionInstanceId!,
        auditorRuntimeEpoch: peer.runtimeEpoch!,
      },
    });
    expect(replay).toEqual(result);
    expect(result.resultEventId).toBe(`result:${result.attemptId}`);
    await flush();
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(emitStatusMock.mock.calls.map((call) => call[0]?.phase)).toEqual(['preparing', 'sent', 'waiting_reply']);
    const brief = String(dispatchMock.mock.calls[0]?.[0]?.brief);
    const capability = /--capability ([A-Za-z0-9_-]+)/.exec(brief)?.[1];
    expect(capability).toBeTruthy();
    const saved = getSession(main.name)!;
    expect(saved.transportConfig).toMatchObject({
      supervision: {
        mode: 'off',
        auditTargetSessionName: peer.name,
        peerAuditPromptVersion: PEER_AUDIT_PROMPT_VERSION,
      },
    });
    expect((saved.transportConfig?.supervision as Record<string, unknown>).auditMode).toBeUndefined();
    if (!result.ok || !capability) return;
    await expect(service.acceptReply({
      version: PEER_AUDIT_REPLY_VERSION,
      attemptId: result.attemptId,
      replyCapability: 'B'.repeat(32),
      verdict: 'PASS',
      findings: 'forged',
      validations: [],
    }, peer, Date.now())).resolves.toEqual({ ok: false, error: 'invalid_capability' });
    await expect(service.acceptReply({
      version: PEER_AUDIT_REPLY_VERSION,
      attemptId: result.attemptId,
      replyCapability: capability,
      verdict: 'PASS',
      findings: 'static review only',
      validations: [],
    }, peer, Date.now())).resolves.toEqual({ ok: false, error: 'insufficient_validation_evidence' });
    await expect(service.acceptReply({
      version: PEER_AUDIT_REPLY_VERSION,
      attemptId: result.attemptId,
      replyCapability: capability,
      verdict: 'PASS',
      findings: 'wrong sender',
      validations: [{ kind: 'test', label: 'focused', outcome: 'passed', summary: '12 passed' }],
    }, { ...peer, name: main.name }, Date.now())).resolves.toEqual({ ok: false, error: 'identity_mismatch' });
    await expect(service.acceptReply({
      version: PEER_AUDIT_REPLY_VERSION,
      attemptId: result.attemptId,
      replyCapability: capability,
      verdict: 'PASS',
      findings: 'wrong runtime identity',
      validations: [{ kind: 'test', label: 'focused', outcome: 'passed', summary: '12 passed' }],
    }, { ...peer, runtimeEpoch: 'runtime-replaced' }, Date.now())).resolves.toEqual({ ok: false, error: 'identity_mismatch' });
    await expect(service.acceptReply({
      version: PEER_AUDIT_REPLY_VERSION,
      attemptId: result.attemptId,
      replyCapability: capability,
      verdict: 'PASS',
      findings: 'Focused tests passed.',
      validations: [{ kind: 'test', label: 'focused', outcome: 'passed', summary: '12 passed' }],
    }, peer, Date.now())).resolves.toEqual({ ok: true });
    await flush();
    expect(emitResultMock).toHaveBeenCalledTimes(1);
    expect(emitResultMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'pass', trigger: 'quick' }));
    await expect(service.acceptReply({
      version: PEER_AUDIT_REPLY_VERSION,
      attemptId: result.attemptId,
      replyCapability: capability,
      verdict: 'PASS',
      findings: 'duplicate',
      validations: [{ kind: 'test', label: 'focused', outcome: 'passed', summary: '12 passed' }],
    }, peer, Date.now())).resolves.toEqual({ ok: false, error: 'invalid_capability' });
    expect(emitResultMock).toHaveBeenCalledTimes(1);
    service.shutdown();
    const restarted = new PeerAuditService();
    await expect(restarted.acceptReply({
      version: PEER_AUDIT_REPLY_VERSION,
      attemptId: result.attemptId,
      replyCapability: capability,
      verdict: 'PASS',
      findings: 'late after restart',
      validations: [{ kind: 'test', label: 'focused', outcome: 'passed', summary: '12 passed' }],
    }, peer, Date.now())).resolves.toEqual({ ok: false, error: 'invalid_capability' });
  });

  it('moves an exact queued audit delivery to waiting so cancellation does not remove an already delivered row', async () => {
    upsertSession(session('deck_peer_queue_brain', { transportConfig: { supervision: { mode: 'off' } } }));
    upsertSession(session('deck_sub_queue123', { parentSession: 'deck_peer_queue_brain' }));
    const main = getSession('deck_peer_queue_brain')!;
    const peer = getSession('deck_sub_queue123')!;
    const service = new PeerAuditService();
    service.init();
    const generation = service.beginTopLevelIntent(main, 'task_queue', 'audit queued work')!;
    service.recordTerminalResult({
      sessionName: main.name,
      auditedSessionInstanceId: main.sessionInstanceId!,
      auditedRuntimeEpoch: main.runtimeEpoch!,
      taskCommandId: 'task_queue',
      generationOrEpoch: generation,
      assistantText: 'queued result complete',
      completedEventId: 'event_queue',
      completedAt: 100,
      terminal: true,
      topLevel: true,
    });
    service.updateWorkState(main.name, { foreground: false, background: false, pendingCompletion: false, subagent: false });
    const candidates = resolvePeerAuditCandidateList({ auditedSessionName: main.name, allSessions: listSessions() });
    if (!candidates.ok) throw new Error(candidates.error);
    dispatchMock.mockResolvedValueOnce({
      ok: true,
      receipt: {
        disposition: 'queued',
        dispatchId: 'dispatch_queue',
        messageId: 'message_queue',
        queueEpoch: 'queue_epoch_1',
        targetSessionInstanceId: peer.sessionInstanceId!,
        targetRuntimeEpoch: peer.runtimeEpoch!,
      },
    });
    const result = await service.startQuick({
      commandId: 'command_queue',
      auditedSessionName: main.name,
      auditedSessionInstanceId: main.sessionInstanceId!,
      candidateRevision: candidates.list.revision,
      targetConfigRevision: candidates.list.targetConfigRevision,
      selectionIntent: 'explicit_picker',
      target: {
        auditorSessionName: peer.name,
        auditorSessionInstanceId: peer.sessionInstanceId!,
        auditorRuntimeEpoch: peer.runtimeEpoch!,
      },
    });
    if (!result.ok) throw new Error(result.error);
    await flush();
    timelineEmitter.emit(peer.name, 'transport.queue.delivery', {
      clientMessageId: 'message_queue',
      queueEpoch: 'queue_epoch_1',
    });
    expect(emitStatusMock.mock.calls.map((call) => call[0]?.phase)).toEqual(['preparing', 'queued', 'waiting_reply']);
    expect(service.cancel({
      commandId: 'cancel_queue',
      auditedSessionName: main.name,
      auditedSessionInstanceId: main.sessionInstanceId!,
      attemptId: result.attemptId,
    })).toEqual({ ok: true });
    await flush();
    expect(cancelQueuedMock).not.toHaveBeenCalled();
    service.shutdown();
  });

  it('builds an off-mode baseline from a real top-level timeline pair only after stable idle', () => {
    upsertSession(session('deck_peer_timeline_brain', { projectName: 'peer-service' }));
    const record = getSession('deck_peer_timeline_brain')!;
    const service = new PeerAuditService();
    service.init();
    timelineEmitter.emit(record.name, 'user.message', {
      text: 'verify this turn',
      clientMessageId: 'timeline_task_1',
      allowDuplicate: true,
    });
    timelineEmitter.emit(record.name, 'session.state', { state: 'running' });
    expect(service.baseline.getCompletedBaseline({
      sessionName: record.name,
      auditedSessionInstanceId: record.sessionInstanceId!,
      auditedRuntimeEpoch: record.runtimeEpoch!,
    })).toBeUndefined();
    timelineEmitter.emit(record.name, 'session.state', {
      state: 'idle',
      [PEER_AUDIT_COMPLETED_TURN_PAYLOAD_FIELD]: {
        taskCommandId: 'timeline_task_1',
        assistantText: 'turn complete',
        completedEventId: 'transport:timeline:result-1',
        completedAt: Date.now(),
        generationOrEpoch: 1,
      },
    });
    expect(service.baseline.getCompletedBaseline({
      sessionName: record.name,
      auditedSessionInstanceId: record.sessionInstanceId!,
      auditedRuntimeEpoch: record.runtimeEpoch!,
    })).toMatchObject({
      taskCommandId: 'timeline_task_1',
      userText: 'verify this turn',
      assistantText: 'turn complete',
    });
    service.shutdown();
  });

  it('binds an authoritative completion to task A even when task B was queued later', () => {
    upsertSession(session('deck_peer_timeline_brain', { projectName: 'peer-service' }));
    const record = getSession('deck_peer_timeline_brain')!;
    const service = new PeerAuditService();
    service.init();
    timelineEmitter.emit(record.name, 'user.message', {
      text: 'task A', clientMessageId: 'task_a', allowDuplicate: true,
    });
    timelineEmitter.emit(record.name, 'session.state', { state: 'running' });
    timelineEmitter.emit(record.name, 'user.message', {
      text: 'task B queued', clientMessageId: 'task_b', allowDuplicate: true,
    });
    timelineEmitter.emit(record.name, 'session.state', {
      state: 'running',
      [PEER_AUDIT_COMPLETED_TURN_PAYLOAD_FIELD]: {
        taskCommandId: 'task_a',
        assistantText: 'result A',
        completedEventId: 'transport:timeline:result-a',
        completedAt: Date.now(),
        generationOrEpoch: 1,
      },
    });
    expect(service.baseline.getCompletedBaseline({
      sessionName: record.name,
      auditedSessionInstanceId: record.sessionInstanceId!,
      auditedRuntimeEpoch: record.runtimeEpoch!,
    })).toBeUndefined();
    timelineEmitter.emit(record.name, 'session.state', {
      state: 'idle',
      [PEER_AUDIT_COMPLETED_TURN_PAYLOAD_FIELD]: {
        taskCommandId: 'task_b',
        assistantText: 'result B',
        completedEventId: 'transport:timeline:result-b',
        completedAt: Date.now(),
        generationOrEpoch: 2,
      },
    });
    expect(service.baseline.getCompletedBaseline({
      sessionName: record.name,
      auditedSessionInstanceId: record.sessionInstanceId!,
      auditedRuntimeEpoch: record.runtimeEpoch!,
    })).toMatchObject({ taskCommandId: 'task_b', userText: 'task B queued', assistantText: 'result B' });
    service.shutdown();
  });

  it('rejects a stale target-only configuration revision without overwriting another tab', async () => {
    upsertSession(session('deck_peer_service_brain', { transportConfig: { supervision: { mode: 'off' } } }));
    upsertSession(session('deck_sub_abc12345'));
    const main = getSession('deck_peer_service_brain')!;
    const peer = getSession('deck_sub_abc12345')!;
    const service = new PeerAuditService();
    const generation = service.beginTopLevelIntent(main, 'task_cas', 'audit this')!;
    service.recordTerminalResult({
      sessionName: main.name,
      auditedSessionInstanceId: main.sessionInstanceId!,
      auditedRuntimeEpoch: main.runtimeEpoch!,
      taskCommandId: 'task_cas',
      generationOrEpoch: generation,
      assistantText: 'done',
      completedEventId: 'event_cas',
      completedAt: 100,
      terminal: true,
      topLevel: true,
    });
    service.updateWorkState(main.name, { foreground: false, background: false, pendingCompletion: false, subagent: false });
    const listed = resolvePeerAuditCandidateList({ auditedSessionName: main.name, allSessions: listSessions() });
    if (!listed.ok) throw new Error(listed.error);

    upsertSession({
      ...main,
      transportConfig: {
        supervision: {
          mode: 'off',
          auditTargetSessionName: peer.name,
          auditTargetFingerprint: {
            sessionInstanceId: peer.sessionInstanceId,
            normalizedModelId: 'claude-opus',
            providerFamily: 'anthropic',
          },
          peerAuditPromptVersion: PEER_AUDIT_PROMPT_VERSION,
        },
      },
    });

    await expect(service.startQuick({
      commandId: 'command_cas',
      auditedSessionName: main.name,
      auditedSessionInstanceId: main.sessionInstanceId!,
      candidateRevision: listed.list.revision,
      targetConfigRevision: listed.list.targetConfigRevision,
      selectionIntent: 'explicit_picker',
      target: {
        auditorSessionName: peer.name,
        auditorSessionInstanceId: peer.sessionInstanceId!,
        auditorRuntimeEpoch: peer.runtimeEpoch!,
      },
    })).resolves.toEqual({ ok: false, error: 'config_conflict' });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('does not persist a different target when another peer audit is already active', async () => {
    upsertSession(session('deck_peer_service_brain', { transportConfig: { supervision: { mode: 'off' } } }));
    upsertSession(session('deck_sub_busy111'));
    upsertSession(session('deck_sub_busy222'));
    const main = getSession('deck_peer_service_brain')!;
    const firstPeer = getSession('deck_sub_busy111')!;
    const secondPeer = getSession('deck_sub_busy222')!;
    const service = new PeerAuditService();
    const generation = service.beginTopLevelIntent(main, 'task_busy', 'audit this')!;
    service.recordTerminalResult({
      sessionName: main.name,
      auditedSessionInstanceId: main.sessionInstanceId!,
      auditedRuntimeEpoch: main.runtimeEpoch!,
      taskCommandId: 'task_busy',
      generationOrEpoch: generation,
      assistantText: 'done',
      completedEventId: 'event_busy',
      completedAt: 100,
      terminal: true,
      topLevel: true,
    });
    service.updateWorkState(main.name, { foreground: false, background: false, pendingCompletion: false, subagent: false });
    const listed = resolvePeerAuditCandidateList({ auditedSessionName: main.name, allSessions: listSessions() });
    if (!listed.ok) throw new Error(listed.error);
    const first = await service.startQuick({
      commandId: 'command_busy_1',
      auditedSessionName: main.name,
      auditedSessionInstanceId: main.sessionInstanceId!,
      candidateRevision: listed.list.revision,
      targetConfigRevision: listed.list.targetConfigRevision,
      selectionIntent: 'explicit_picker',
      target: {
        auditorSessionName: firstPeer.name,
        auditorSessionInstanceId: firstPeer.sessionInstanceId!,
        auditorRuntimeEpoch: firstPeer.runtimeEpoch!,
      },
    });
    if (!first.ok) throw new Error(first.error);
    const afterFirst = getSession(main.name)!;
    const refreshed = resolvePeerAuditCandidateList({ auditedSessionName: main.name, allSessions: listSessions() });
    if (!refreshed.ok) throw new Error(refreshed.error);
    await expect(service.startQuick({
      commandId: 'command_busy_2',
      auditedSessionName: main.name,
      auditedSessionInstanceId: main.sessionInstanceId!,
      candidateRevision: refreshed.list.revision,
      targetConfigRevision: refreshed.list.targetConfigRevision,
      selectionIntent: 'explicit_picker',
      target: {
        auditorSessionName: secondPeer.name,
        auditorSessionInstanceId: secondPeer.sessionInstanceId!,
        auditorRuntimeEpoch: secondPeer.runtimeEpoch!,
      },
    })).resolves.toEqual({ ok: false, error: 'peer_audit_busy' });
    expect(getSession(main.name)?.transportConfig).toEqual(afterFirst.transportConfig);
    expect(getSession(main.name)?.transportConfig).toMatchObject({
      supervision: { auditTargetSessionName: firstPeer.name },
    });
  });

  it('invalidates an active Quick attempt when its remembered target configuration changes', async () => {
    upsertSession(session('deck_peer_service_brain', { transportConfig: { supervision: { mode: 'off' } } }));
    upsertSession(session('deck_sub_config1'));
    const main = getSession('deck_peer_service_brain')!;
    const peer = getSession('deck_sub_config1')!;
    const service = new PeerAuditService();
    const generation = service.beginTopLevelIntent(main, 'task_config', 'audit target config')!;
    service.recordTerminalResult({
      sessionName: main.name,
      auditedSessionInstanceId: main.sessionInstanceId!,
      auditedRuntimeEpoch: main.runtimeEpoch!,
      taskCommandId: 'task_config',
      generationOrEpoch: generation,
      assistantText: 'done',
      completedEventId: 'event_config',
      completedAt: 100,
      terminal: true,
      topLevel: true,
    });
    service.updateWorkState(main.name, { foreground: false, background: false, pendingCompletion: false, subagent: false });
    const listed = resolvePeerAuditCandidateList({ auditedSessionName: main.name, allSessions: listSessions() });
    if (!listed.ok) throw new Error(listed.error);
    const started = await service.startQuick({
      commandId: 'command_config',
      auditedSessionName: main.name,
      auditedSessionInstanceId: main.sessionInstanceId!,
      candidateRevision: listed.list.revision,
      targetConfigRevision: listed.list.targetConfigRevision,
      selectionIntent: 'explicit_picker',
      target: {
        auditorSessionName: peer.name,
        auditorSessionInstanceId: peer.sessionInstanceId!,
        auditorRuntimeEpoch: peer.runtimeEpoch!,
      },
    });
    if (!started.ok) throw new Error(started.error);
    await flush();
    const saved = getSession(main.name)!;
    upsertSession({ ...saved, transportConfig: { ...saved.transportConfig, supervision: { mode: 'off' } } });
    service.applyAutomaticConfiguration(main.name, false);
    await flush();
    expect(emitResultMock).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: started.attemptId,
      outcome: 'invalid_configuration',
      reason: 'target_configuration_changed',
    }));
  });

  it('retries one valid automatic waiter after Quick terminates and rejects an invalidated waiter', async () => {
    upsertSession(session('deck_sub_waiter1'));
    const peer = getSession('deck_sub_waiter1')!;
    upsertSession(session('deck_peer_service_brain', {
      transportConfig: {
        supervision: {
          mode: 'supervised_audit',
          auditTargetSessionName: peer.name,
          auditTargetFingerprint: {
            sessionInstanceId: peer.sessionInstanceId,
            normalizedModelId: 'claude-opus',
            providerFamily: 'anthropic',
          },
          peerAuditPromptVersion: PEER_AUDIT_PROMPT_VERSION,
          maxAuditLoops: 1,
        },
      },
    }));
    const main = getSession('deck_peer_service_brain')!;
    const service = new PeerAuditService();
    const generation = service.beginTopLevelIntent(main, 'task_waiter', 'audit this')!;
    service.recordTerminalResult({
      sessionName: main.name,
      auditedSessionInstanceId: main.sessionInstanceId!,
      auditedRuntimeEpoch: main.runtimeEpoch!,
      taskCommandId: 'task_waiter',
      generationOrEpoch: generation,
      assistantText: 'done',
      completedEventId: 'event_waiter',
      completedAt: 100,
      terminal: true,
      topLevel: true,
    });
    service.updateWorkState(main.name, { foreground: false, background: false, pendingCompletion: false, subagent: false });
    const listed = resolvePeerAuditCandidateList({ auditedSessionName: main.name, allSessions: listSessions() });
    if (!listed.ok) throw new Error(listed.error);
    const quick = await service.startQuick({
      commandId: 'command_waiter_quick',
      auditedSessionName: main.name,
      auditedSessionInstanceId: main.sessionInstanceId!,
      candidateRevision: listed.list.revision,
      targetConfigRevision: listed.list.targetConfigRevision,
      selectionIntent: 'explicit_picker',
      target: {
        auditorSessionName: peer.name,
        auditorSessionInstanceId: peer.sessionInstanceId!,
        auditorRuntimeEpoch: peer.runtimeEpoch!,
      },
    });
    if (!quick.ok) throw new Error(quick.error);
    const automaticTerminal = vi.fn();
    const automatic = await service.startAutomatic({
      audited: getSession(main.name)!,
      taskCommandId: 'task_waiter',
      generationOrEpoch: generation,
      userText: 'audit this',
      assistantText: 'done',
      isStillValid: () => true,
      onTerminal: automaticTerminal,
    });
    expect(automatic).toMatchObject({ ok: true, awaitingSlot: true });
    const duplicateAutomatic = await service.startAutomatic({
      audited: getSession(main.name)!,
      taskCommandId: 'task_waiter',
      generationOrEpoch: generation,
      userText: 'audit this',
      assistantText: 'done',
      isStillValid: () => true,
      onTerminal: automaticTerminal,
    });
    expect(duplicateAutomatic).toEqual(automatic);
    service.cancel({
      commandId: 'cancel_waiter_quick',
      auditedSessionName: main.name,
      auditedSessionInstanceId: main.sessionInstanceId!,
      attemptId: quick.attemptId,
    });
    await flush();
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(automaticTerminal).not.toHaveBeenCalled();

    // A second service proves the waiter is revalidated, not blindly retried.
    service.shutdown();
    const invalidService = new PeerAuditService();
    const invalidGeneration = invalidService.beginTopLevelIntent(getSession(main.name)!, 'task_waiter_2', 'audit again')!;
    invalidService.recordTerminalResult({
      sessionName: main.name,
      auditedSessionInstanceId: main.sessionInstanceId!,
      auditedRuntimeEpoch: main.runtimeEpoch!,
      taskCommandId: 'task_waiter_2',
      generationOrEpoch: invalidGeneration,
      assistantText: 'done again',
      completedEventId: 'event_waiter_2',
      completedAt: 200,
      terminal: true,
      topLevel: true,
    });
    invalidService.updateWorkState(main.name, { foreground: false, background: false, pendingCompletion: false, subagent: false });
    const invalidList = resolvePeerAuditCandidateList({ auditedSessionName: main.name, allSessions: listSessions() });
    if (!invalidList.ok) throw new Error(invalidList.error);
    const invalidQuick = await invalidService.startQuick({
      commandId: 'command_waiter_invalid_quick',
      auditedSessionName: main.name,
      auditedSessionInstanceId: main.sessionInstanceId!,
      candidateRevision: invalidList.list.revision,
      targetConfigRevision: invalidList.list.targetConfigRevision,
      selectionIntent: 'explicit_picker',
      target: {
        auditorSessionName: peer.name,
        auditorSessionInstanceId: peer.sessionInstanceId!,
        auditorRuntimeEpoch: peer.runtimeEpoch!,
      },
    });
    if (!invalidQuick.ok) throw new Error(invalidQuick.error);
    let valid = true;
    const invalidTerminal = vi.fn();
    const invalidAutomatic = await invalidService.startAutomatic({
      audited: getSession(main.name)!,
      taskCommandId: 'task_waiter_2',
      generationOrEpoch: invalidGeneration,
      userText: 'audit again',
      assistantText: 'done again',
      isStillValid: () => valid,
      onTerminal: invalidTerminal,
    });
    expect(invalidAutomatic).toMatchObject({ ok: true, awaitingSlot: true });
    valid = false;
    invalidService.cancel({
      commandId: 'cancel_waiter_invalid_quick',
      auditedSessionName: main.name,
      auditedSessionInstanceId: main.sessionInstanceId!,
      attemptId: invalidQuick.attemptId,
    });
    await flush();
    expect(invalidTerminal).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'invalid_configuration',
      reason: 'automatic_waiter_invalidated',
    }));
  });

  it('invalidates only an automatic waiter when automatic mode becomes unrunnable', async () => {
    upsertSession(session('deck_sub_modewait'));
    const peer = getSession('deck_sub_modewait')!;
    upsertSession(session('deck_peer_service_brain', {
      transportConfig: {
        supervision: {
          mode: 'supervised_audit',
          auditTargetSessionName: peer.name,
          auditTargetFingerprint: {
            sessionInstanceId: peer.sessionInstanceId,
            normalizedModelId: 'claude-opus',
            providerFamily: 'anthropic',
          },
          peerAuditPromptVersion: PEER_AUDIT_PROMPT_VERSION,
        },
      },
    }));
    const main = getSession('deck_peer_service_brain')!;
    const service = new PeerAuditService();
    const generation = service.beginTopLevelIntent(main, 'task_modewait', 'audit mode waiter')!;
    service.recordTerminalResult({
      sessionName: main.name,
      auditedSessionInstanceId: main.sessionInstanceId!,
      auditedRuntimeEpoch: main.runtimeEpoch!,
      taskCommandId: 'task_modewait',
      generationOrEpoch: generation,
      assistantText: 'done',
      completedEventId: 'event_modewait',
      completedAt: 100,
      terminal: true,
      topLevel: true,
    });
    service.updateWorkState(main.name, { foreground: false, background: false, pendingCompletion: false, subagent: false });
    const listed = resolvePeerAuditCandidateList({ auditedSessionName: main.name, allSessions: listSessions() });
    if (!listed.ok) throw new Error(listed.error);
    const quick = await service.startQuick({
      commandId: 'command_modewait_quick',
      auditedSessionName: main.name,
      auditedSessionInstanceId: main.sessionInstanceId!,
      candidateRevision: listed.list.revision,
      targetConfigRevision: listed.list.targetConfigRevision,
      selectionIntent: 'explicit_picker',
      target: {
        auditorSessionName: peer.name,
        auditorSessionInstanceId: peer.sessionInstanceId!,
        auditorRuntimeEpoch: peer.runtimeEpoch!,
      },
    });
    if (!quick.ok) throw new Error(quick.error);
    const automaticTerminal = vi.fn();
    const automatic = await service.startAutomatic({
      audited: getSession(main.name)!,
      taskCommandId: 'task_modewait',
      generationOrEpoch: generation,
      userText: 'audit mode waiter',
      assistantText: 'done',
      isStillValid: () => true,
      onTerminal: automaticTerminal,
    });
    if (!automatic.ok) throw new Error(automatic.error);
    service.applyAutomaticConfiguration(main.name, false);
    await flush();
    expect(automaticTerminal).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: automatic.attemptId,
      outcome: 'invalid_configuration',
      reason: 'automatic_mode_unrunnable',
    }));
    expect(emitResultMock).toHaveBeenCalledWith(expect.objectContaining({ attemptId: automatic.attemptId }));
    expect(service.cancel({
      commandId: 'cancel_modewait_quick',
      auditedSessionName: main.name,
      auditedSessionInstanceId: main.sessionInstanceId!,
      attemptId: quick.attemptId,
    })).toEqual({ ok: true });
  });

  it('starts automatic audit without P2P and routes REWORK through its terminal callback', async () => {
    upsertSession(session('deck_sub_abc12345'));
    const peer = getSession('deck_sub_abc12345')!;
    upsertSession(session('deck_peer_service_brain', {
      transportConfig: {
        supervision: {
          mode: 'supervised_audit',
          backend: 'codex-sdk',
          model: 'gpt-5.3-codex-spark',
          timeoutMs: 120000,
          promptVersion: 'supervision_decision_v1',
          maxParseRetries: 1,
          maxAutoContinueStreak: 2,
          maxAutoContinueTotal: 0,
          auditTargetSessionName: peer.name,
          auditTargetFingerprint: {
            sessionInstanceId: peer.sessionInstanceId,
            normalizedModelId: 'claude-opus',
            providerFamily: 'anthropic',
          },
          peerAuditPromptVersion: PEER_AUDIT_PROMPT_VERSION,
          maxAuditLoops: 1,
          taskRunPromptVersion: 'task_run_status_v1',
        },
      },
    }));
    const main = getSession('deck_peer_service_brain')!;
    expect(main.transportConfig).toMatchObject({
      supervision: {
        auditTargetSessionName: peer.name,
        auditTargetFingerprint: {
          sessionInstanceId: peer.sessionInstanceId,
          normalizedModelId: 'claude-opus',
          providerFamily: 'anthropic',
        },
        peerAuditPromptVersion: PEER_AUDIT_PROMPT_VERSION,
      },
    });
    const service = new PeerAuditService();
    const onTerminal = vi.fn();
    const result = await service.startAutomatic({
      audited: main,
      taskCommandId: 'task_2',
      generationOrEpoch: 2,
      userText: 'finish implementation',
      assistantText: 'done',
      isStillValid: () => true,
      onTerminal,
    });
    if (!result.ok) throw new Error(result.error);
    await flush();
    const brief = String(dispatchMock.mock.calls[0]?.[0]?.brief);
    const capability = /--capability ([A-Za-z0-9_-]+)/.exec(brief)?.[1];
    if (!result.ok || !capability) return;
    await service.acceptReply({
      version: PEER_AUDIT_REPLY_VERSION,
      attemptId: result.attemptId,
      replyCapability: capability,
      verdict: 'REWORK',
      findings: 'Add the missing race test.',
      validations: [],
    }, peer, Date.now());
    await flush();
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'rework', findings: 'Add the missing race test.' }));
  });
});
