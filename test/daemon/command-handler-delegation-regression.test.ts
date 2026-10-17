import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearProcessSharedMachineAuthoritiesForTests,
  readProcessSharedMachineAuthority,
  releaseProcessSharedMachineAuthority,
} from '../../src/daemon/shared-machine-authority-context.js';

const {
  dispatchDelegatedSessionSendMock,
  getSessionMock,
  timelineEmitMock,
  outboxEnqueueMock,
  outboxMarkAckedMock,
} = vi.hoisted(() => ({
  dispatchDelegatedSessionSendMock: vi.fn(),
  getSessionMock: vi.fn(),
  timelineEmitMock: vi.fn(),
  outboxEnqueueMock: vi.fn(async () => undefined),
  outboxMarkAckedMock: vi.fn(async () => undefined),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: vi.fn(() => []),
  getSession: getSessionMock,
  upsertSession: vi.fn(),
  removeSession: vi.fn(),
  updateSessionState: vi.fn(),
}));

vi.mock('../../src/daemon/session-dispatch.js', () => ({
  dispatchDelegatedSessionSend: dispatchDelegatedSessionSendMock,
}));

vi.mock('../../src/daemon/ack-outbox.js', () => ({
  getDefaultAckOutbox: () => ({
    enqueue: outboxEnqueueMock,
    markAcked: outboxMarkAckedMock,
  }),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  startProject: vi.fn(),
  stopProject: vi.fn(),
  teardownProject: vi.fn(),
  getTransportRuntime: vi.fn(() => undefined),
  launchTransportSession: vi.fn(),
  isProviderSessionBound: vi.fn(() => false),
  persistSessionRecord: vi.fn(),
  relaunchSessionWithSettings: vi.fn(),
  stopTransportRuntimeSession: vi.fn(),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  BACKEND: 'tmux',
  preparePrivateInputWriter: vi.fn(),
  sendKeys: vi.fn(),
  sendKeysDelayedEnter: vi.fn(),
  sendRawInput: vi.fn(),
  resizeSession: vi.fn(),
  sendKey: vi.fn(),
  getPaneStartCommand: vi.fn(),
}));

vi.mock('../../src/router/message-router.js', () => ({ routeMessage: vi.fn() }));
vi.mock('../../src/daemon/terminal-streamer.js', () => ({ terminalStreamer: { subscribe: vi.fn(), unsubscribe: vi.fn(), start: vi.fn(), stop: vi.fn(), requestSnapshot: vi.fn(), invalidateSize: vi.fn() } }));
vi.mock('../../src/daemon/timeline-emitter.js', () => ({ timelineEmitter: { emit: timelineEmitMock, on: vi.fn(() => () => {}), off: vi.fn(), epoch: 0, replay: vi.fn(() => ({ events: [], truncated: false })) } }));
vi.mock('../../src/daemon/timeline-store.js', () => ({ timelineStore: { append: vi.fn(), read: vi.fn(() => []), clear: vi.fn() } }));
vi.mock('../../src/daemon/subsession-manager.js', () => ({ startSubSession: vi.fn(), stopSubSession: vi.fn(), rebuildSubSessions: vi.fn(), detectShells: vi.fn().mockResolvedValue([]), readSubSessionResponse: vi.fn(), subSessionName: (id: string) => `deck_sub_${id}` }));
vi.mock('../../src/daemon/p2p-orchestrator.js', () => ({ startP2pRun: vi.fn(), cancelP2pRun: vi.fn(), getP2pRun: vi.fn(() => undefined), listP2pRuns: vi.fn(() => []), serializeP2pRun: vi.fn() }));
vi.mock('../../src/daemon/session-list.js', () => ({ buildSessionList: vi.fn(async () => []) }));
vi.mock('../../src/daemon/repo-handler.js', () => ({ handleRepoCommand: vi.fn() }));
vi.mock('../../src/daemon/file-transfer-handler.js', () => ({ handleFileUpload: vi.fn(), handleFileUploadFetch: vi.fn(), handleFileDownload: vi.fn(), createProjectFileHandle: vi.fn(), createProjectFileHandleFromValidatedPath: vi.fn(), tryCreateProjectFileHandle: vi.fn(), lookupAttachment: vi.fn(() => undefined) }));
vi.mock('../../src/daemon/preview-relay.js', () => ({ handlePreviewCommand: vi.fn() }));
vi.mock('../../src/daemon/provider-sessions.js', () => ({ listProviderSessions: vi.fn(() => []) }));
vi.mock('../../src/util/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/util/imc-dir.js', () => ({ ensureImcDir: vi.fn().mockResolvedValue('/tmp/imc'), imcSubDir: vi.fn((dir: string, sub: string) => `${dir}/.imc/${sub}`) }));
vi.mock('../../src/daemon/supervision-broker.js', () => ({ supervisionBroker: { decide: vi.fn() } }));
vi.mock('../../src/daemon/supervision-automation.js', () => ({ supervisionAutomation: { init: vi.fn(), setServerLink: vi.fn(), cancelSession: vi.fn(), queueTaskIntent: vi.fn(), updateQueuedTaskIntent: vi.fn(), removeQueuedTaskIntent: vi.fn(), registerTaskIntent: vi.fn(), applySnapshotUpdate: vi.fn() } }));
vi.mock('../../src/daemon/git-remote-clone.js', () => ({ maybeCloneGitRemoteToDirectory: vi.fn(async ({ targetDir }: { targetDir: string }) => targetDir) }));

const { handleWebCommand } = await import('../../src/daemon/command-handler.js');
const { sendKeysDelayedEnter } = await import('../../src/agent/tmux.js');

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function serverLink() {
  return {
    send: vi.fn(),
    trySend: vi.fn(() => true),
    sendBinary: vi.fn(),
    sendTimelineEvent: vi.fn(),
    daemonVersion: '0.1.0',
  };
}

describe('command-handler delegation routing behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearProcessSharedMachineAuthoritiesForTests();
    getSessionMock.mockReturnValue({
      name: 'deck_proj_brain',
      projectName: 'proj',
      projectDir: '/repo',
      role: 'brain',
      agentType: 'codex',
      state: 'idle',
    });
    dispatchDelegatedSessionSendMock.mockResolvedValue({
      status: 'accepted',
      target: 'deck_proj_w1',
      contextStatus: 'ok',
      dispatchId: 'snd_dispatch_test',
      messageId: 'snd_msg_test',
    });
  });

  it('binds a participant session.send authority to the exact process runtime before agent dispatch', async () => {
    const identity = { sessionInstanceId: 'instance-shared-1', runtimeEpoch: 'epoch-shared-1' };
    getSessionMock.mockReturnValue({
      name: 'deck_proj_brain',
      projectName: 'proj',
      projectDir: '/repo',
      role: 'brain',
      agentType: 'codex',
      runtimeType: 'process',
      state: 'idle',
      ...identity,
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_proj_brain',
      text: 'use Computer Use locally',
      commandId: 'shared-local-1',
      sharedActor: {
        actorUserId: 'participant-1',
        effectiveActorRole: 'participant',
        actionId: 'action-1',
      },
      sharedMachineAuthority: 'server-minted-shared-authority',
    }, serverLink() as any);
    await flushAsync();

    expect(readProcessSharedMachineAuthority('deck_proj_brain', identity)).toEqual({
      required: true,
      authority: 'server-minted-shared-authority',
    });
    expect(readProcessSharedMachineAuthority('deck_proj_brain', {
      ...identity,
      runtimeEpoch: 'epoch-stale',
    })).toEqual({ required: true, authority: null });
  });

  it('retains a deny marker when participant session.send loses its minted authority', async () => {
    const identity = { sessionInstanceId: 'instance-shared-2', runtimeEpoch: 'epoch-shared-2' };
    getSessionMock.mockReturnValue({
      name: 'deck_proj_brain', projectName: 'proj', projectDir: '/repo', role: 'brain',
      agentType: 'codex', runtimeType: 'process', state: 'idle', ...identity,
    });

    handleWebCommand({
      type: 'session.send', session: 'deck_proj_brain', text: 'must fail closed', commandId: 'shared-local-2',
      sharedActor: { actorUserId: 'participant-1', effectiveActorRole: 'participant', actionId: 'action-2' },
    }, serverLink() as any);
    await flushAsync();

    expect(readProcessSharedMachineAuthority('deck_proj_brain', identity))
      .toEqual({ required: true, authority: null });
  });

  describe('process session: who fed the terminal / agent in this turn', () => {
    const identity = { sessionInstanceId: 'instance-shared-3', runtimeEpoch: 'epoch-shared-3' };
    const participantActor = { actorUserId: 'participant-1', effectiveActorRole: 'participant', actionId: 'action-3' };
    beforeEach(() => {
      getSessionMock.mockReturnValue({
        name: 'deck_proj_brain', projectName: 'proj', projectDir: '/repo', role: 'brain',
        agentType: 'shell', runtimeType: 'process', state: 'idle', ...identity,
      });
    });
    const input = (extra: Record<string, unknown> = {}) => handleWebCommand({
      type: 'session.input', sessionName: 'deck_proj_brain', data: 'echo hi\r', ...extra,
    }, serverLink() as any);
    const send = (extra: Record<string, unknown> = {}) => handleWebCommand({
      type: 'session.send', session: 'deck_proj_brain', text: 'hello', commandId: `cmd-${Math.random()}`, ...extra,
    }, serverLink() as any);
    const hook = () => readProcessSharedMachineAuthority('deck_proj_brain', identity);

    it('D3/D6: participant keystrokes bind the participant context even when the last admitted turn was the owner\'s', async () => {
      await send();
      await flushAsync();
      expect(hook()).toEqual({ required: false, authority: null });
      input({ sharedActor: participantActor, sharedMachineAuthority: 'input-token' });
      await flushAsync();
      // Owner turn + participant keystrokes in one running turn: closed, never the owner's authority.
      expect(hook()).toEqual({ required: true, authority: null });
    });

    it('participant keystrokes alone are bound to that participant; with no token they fail closed', async () => {
      input({ sharedActor: participantActor, sharedMachineAuthority: 'input-token' });
      await flushAsync();
      expect(hook()).toEqual({ required: true, authority: 'input-token' });
      clearProcessSharedMachineAuthoritiesForTests();
      input({ sharedActor: participantActor });
      await flushAsync();
      expect(hook()).toEqual({ required: true, authority: null });
    });

    it('D2: an owner message after a participant message does not clear the restriction', async () => {
      await send({ sharedActor: participantActor, sharedMachineAuthority: 'send-token' });
      await flushAsync();
      expect(hook()).toEqual({ required: true, authority: 'send-token' });
      await send();
      await flushAsync();
      expect(hook()).toEqual({ required: true, authority: null });
    });

    describe('turns that can still run: queued in the TUI, in flight, or not typed yet (one idle edge ends one turn)', () => {
      let edgeAt = 0;
      const idleEdge = () => releaseProcessSharedMachineAuthority('deck_proj_brain', Date.now() + (edgeAt += 60_000));
      const typedCount = () => vi.mocked(sendKeysDelayedEnter).mock.calls.length;
      /** Wait until `n` messages were written to the terminal (after memory recall and the delivery lock). */
      const waitTyped = async (n: number) => {
        const deadline = Date.now() + 8_000;
        while (typedCount() < n && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 5));
        await flushAsync();
        expect(typedCount()).toBeGreaterThanOrEqual(n);
      };
      const record = (state: string) => getSessionMock.mockReturnValue({
        name: 'deck_proj_brain', projectName: 'proj', projectDir: '/repo', role: 'brain',
        agentType: 'claude-code', runtimeType: 'process', state, ...identity,
      });
      beforeEach(() => record('idle'));

      it('A: a second participant message sent while the first turn runs is still bound after the first idle', async () => {
        record('running');
        await send({ sharedActor: participantActor, sharedMachineAuthority: 'tok-1' });
        await send({ sharedActor: participantActor, sharedMachineAuthority: 'tok-2' });
        await waitTyped(2);
        idleEdge(); // the turn the daemon never saw (running record) ends
        expect(hook()).toEqual({ required: true, authority: 'tok-2' });
        idleEdge(); // first participant turn ends; the queued one starts
        expect(hook()).toEqual({ required: true, authority: 'tok-2' });
        idleEdge();
        expect(hook()).toEqual({ required: false, authority: null });
      });

      it('P0-a: a participant message while a turn the daemon never tracked is running (empty window) outlives the first idle', async () => {
        record('running');
        await send({ sharedActor: participantActor, sharedMachineAuthority: 'tok-1' });
        await waitTyped(1);
        idleEdge(); // T0 ends, the queued participant turn starts
        expect(hook()).toEqual({ required: true, authority: 'tok-1' });
        idleEdge();
        expect(hook()).toEqual({ required: false, authority: null });
      });

      it('regression: the same message on an idle record is released by its own idle edge', async () => {
        await send({ sharedActor: participantActor, sharedMachineAuthority: 'tok-1' });
        await waitTyped(1);
        idleEdge();
        expect(hook()).toEqual({ required: false, authority: null });
      });

      it('P0-b: owner A, owner B queued, idle, participant C queued behind B, idle: C is still bound', async () => {
        await send();
        await send();
        await waitTyped(2);
        idleEdge(); // A ends; B runs
        await send({ sharedActor: participantActor, sharedMachineAuthority: 'tok-c' });
        await waitTyped(3);
        idleEdge(); // B ends; C runs
        expect(hook()).toEqual({ required: true, authority: 'tok-c' });
        idleEdge();
        expect(hook()).toEqual({ required: false, authority: null });
      });

      it('B: a participant message queued behind an owner turn runs bound after the idle edge', async () => {
        await send();
        await send({ sharedActor: participantActor, sharedMachineAuthority: 'tok-q' });
        await waitTyped(2);
        expect(hook()).toEqual({ required: true, authority: null });
        idleEdge();
        expect(hook()).toEqual({ required: true, authority: 'tok-q' });
        idleEdge();
        expect(hook()).toEqual({ required: false, authority: null });
      });

      it('delivery gap: an idle edge that arrives before the bound message is typed does not release it', async () => {
        record('running');
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        vi.mocked(sendKeysDelayedEnter).mockImplementationOnce(() => gate as never);
        await send({ sharedActor: participantActor, sharedMachineAuthority: 'tok-gap' });
        // The delivery is held (recall / delivery lock): nothing typed yet. T0 (running record) ends meanwhile.
        for (let i = 0; i < 20 && typedCount() < 1; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 5));
        idleEdge();
        expect(hook()).toEqual({ required: true, authority: 'tok-gap' });
        release();
        await flushAsync();
        idleEdge(); // now the participant's own turn ends
        expect(hook()).toEqual({ required: false, authority: null });
      });

      it('a send that fails before it is typed leaves no phantom turn', async () => {
        await send({ sharedActor: participantActor, sharedMachineAuthority: 'tok-1' });
        await waitTyped(1);
        vi.mocked(sendKeysDelayedEnter).mockRejectedValueOnce(new Error('tmux gone'));
        await send({ sharedActor: participantActor, sharedMachineAuthority: 'tok-2' });
        await flushAsync();
        idleEdge();
        expect(hook()).toEqual({ required: false, authority: null });
      });

      it('submitted terminal lines count as queued turns; plain typing does not', async () => {
        input({ sharedActor: participantActor, sharedMachineAuthority: 'k1', data: 'abc' });
        input({ sharedActor: participantActor, sharedMachineAuthority: 'k2', data: 'def\r' });
        await flushAsync();
        idleEdge();
        expect(hook()).toEqual({ required: false, authority: null });
        input({ sharedActor: participantActor, sharedMachineAuthority: 'k3', data: 'one\r' });
        input({ sharedActor: participantActor, sharedMachineAuthority: 'k4', data: 'two\r' });
        await flushAsync();
        idleEdge();
        expect(hook()).toEqual({ required: true, authority: 'k4' });
        idleEdge();
        expect(hook()).toEqual({ required: false, authority: null });
      });
    });

    it('owner-only keystrokes and messages keep the unrestricted path', async () => {
      input();
      await send();
      await flushAsync();
      expect(hook()).toEqual({ required: false, authority: null });
    });

    it('a forged sharedActor on a participant-less (owner) frame cannot widen anything: it is only ever a restriction', async () => {
      input({ sharedActor: { actorUserId: 'x', effectiveActorRole: 'owner' }, sharedMachineAuthority: 'ignored-for-owner' });
      await flushAsync();
      expect(hook()).toEqual({ required: false, authority: null });
    });
  });

  it('dispatches valid delegation once and emits delegated ack metadata through timeline and reliable ack', async () => {
    const link = serverLink();
    handleWebCommand({
      type: 'session.send',
      session: 'deck_proj_brain',
      text: 'do the task',
      commandId: 'delegate-ok-1',
      delegateTarget: { session: 'deck_proj_w1' },
    }, link as any);
    await flushAsync();

    expect(dispatchDelegatedSessionSendMock).toHaveBeenCalledTimes(1);
    expect(dispatchDelegatedSessionSendMock.mock.calls[0][0]).toMatchObject({
      targetSession: 'deck_proj_w1',
      message: 'do the task',
      caller: {
        sessionName: 'deck_proj_brain',
        projectName: 'proj',
        projectRoot: '/repo',
      },
    });
    expect(timelineEmitMock).toHaveBeenCalledWith('deck_proj_brain', 'command.ack', expect.objectContaining({
      commandId: 'delegate-ok-1',
      status: 'accepted',
      delegated: true,
      targetSession: 'deck_proj_w1',
      delegationContextStatus: 'ok',
    }));
    expect(link.trySend).toHaveBeenCalledWith(expect.objectContaining({
      type: 'command.ack',
      commandId: 'delegate-ok-1',
      status: 'accepted',
      delegated: true,
      targetSession: 'deck_proj_w1',
      delegationContextStatus: 'ok',
    }));
    expect(outboxEnqueueMock).toHaveBeenCalledWith(expect.objectContaining({
      commandId: 'delegate-ok-1',
      extras: expect.objectContaining({
        delegated: true,
        targetSession: 'deck_proj_w1',
        delegationContextStatus: 'ok',
      }),
    }));
  });

  it('replays the delegated terminal ack for bridge retry without dispatching again', async () => {
    const link = serverLink();
    const cmd = {
      type: 'session.send',
      session: 'deck_proj_brain',
      text: 'retry-safe task',
      commandId: 'delegate-ok-retry-1',
      delegateTarget: { session: 'deck_proj_w1' },
    };
    handleWebCommand(cmd, link as any);
    await flushAsync();
    handleWebCommand({ ...cmd, __bridgeRetry: true }, link as any);
    await flushAsync();

    expect(dispatchDelegatedSessionSendMock).toHaveBeenCalledTimes(1);
    const acks = link.trySend.mock.calls
      .map((call) => call[0])
      .filter((msg) => msg.commandId === 'delegate-ok-retry-1');
    expect(acks).toHaveLength(2);
    expect(acks[1]).toMatchObject({
      delegated: true,
      targetSession: 'deck_proj_w1',
      delegationContextStatus: 'ok',
      status: 'accepted',
    });
  });

  it('replays a delegated error ack for bridge retry instead of converting it to accepted', async () => {
    const link = serverLink();
    dispatchDelegatedSessionSendMock.mockResolvedValueOnce({
      status: 'error',
      error: 'delegation_target_unavailable',
      detail: 'target not found',
    });
    const cmd = {
      type: 'session.send',
      session: 'deck_proj_brain',
      text: 'bad task',
      commandId: 'delegate-error-retry-1',
      delegateTarget: { session: 'deck_proj_w404' },
    };
    handleWebCommand(cmd, link as any);
    await flushAsync();
    handleWebCommand({ ...cmd, __bridgeRetry: true }, link as any);
    await flushAsync();

    expect(dispatchDelegatedSessionSendMock).toHaveBeenCalledTimes(1);
    const acks = link.trySend.mock.calls
      .map((call) => call[0])
      .filter((msg) => msg.commandId === 'delegate-error-retry-1');
    expect(acks).toHaveLength(2);
    expect(acks[0]).toMatchObject({
      status: 'error',
      error: 'delegation_target_unavailable: target not found',
      delegated: true,
      targetSession: 'deck_proj_w404',
    });
    expect(acks[1]).toMatchObject(acks[0]);
  });

  it('rejects mixed P2P fields, forbidden fields, and slash controls before dispatch', async () => {
    const link = serverLink();
    handleWebCommand({
      type: 'session.send',
      session: 'deck_proj_brain',
      text: 'mixed',
      commandId: 'delegate-mixed-1',
      delegateTarget: { session: 'deck_proj_w1' },
      p2pExcludeSameType: true,
    }, link as any);
    handleWebCommand({
      type: 'session.send',
      session: 'deck_proj_brain',
      text: 'forbidden',
      commandId: 'delegate-forbidden-1',
      delegateTarget: { session: 'deck_proj_w1' },
      origin: 'deck_other_brain',
    }, link as any);
    handleWebCommand({
      type: 'session.send',
      session: 'deck_proj_brain',
      text: '/stop',
      commandId: 'delegate-control-1',
      delegateTarget: { session: 'deck_proj_w1' },
    }, link as any);
    await flushAsync();

    expect(dispatchDelegatedSessionSendMock).not.toHaveBeenCalled();
    expect(link.trySend).toHaveBeenCalledWith(expect.objectContaining({
      commandId: 'delegate-mixed-1',
      status: 'error',
      error: 'mixed_delegation_p2p_fields',
      delegated: true,
    }));
    expect(link.trySend).toHaveBeenCalledWith(expect.objectContaining({
      commandId: 'delegate-forbidden-1',
      status: 'error',
      error: 'delegation_unsupported_input',
      delegated: true,
    }));
    expect(link.trySend).toHaveBeenCalledWith(expect.objectContaining({
      commandId: 'delegate-control-1',
      status: 'error',
      error: 'delegation_unsupported_input',
      delegated: true,
    }));
  });
});
