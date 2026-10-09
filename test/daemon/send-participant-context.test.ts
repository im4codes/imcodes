/**
 * tsk_854675e1e2: a shared-session participant's message makes the owner's agent run a turn under restricted authority. The agent could
 * previously `send_message` ANY sibling session and that session ran the request as an ordinary owner turn (no stamp, and the delivery
 * could be appended into an owner turn already running). The sender's participant context now travels with the message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../src/store/session-store.js';

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, unknown>(),
  runtimes: new Map<string, unknown>(),
  processSend: vi.fn(async (_name: string, _text: string, options?: { onTyped?: () => void }) => { options?.onTyped?.(); }),
}));

vi.mock('../../src/daemon/command-handler.js', () => ({
  clearTransportConversation: vi.fn(),
  supportsTransportClear: () => true,
  switchSessionModelNow: vi.fn(),
  sendProcessSessionMessageForAutomation: mocks.processSend,
}));
vi.mock('../../src/agent/session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTransportRuntime: (name: string) => mocks.runtimes.get(name),
}));
vi.mock('../../src/store/session-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSession: (name: string) => mocks.sessions.get(name),
}));

// session-dispatch first: it and session-manager import each other, and the mocked session-manager must be what both bind to.
const { buildServerMemberSharedActorOption, dispatchSessionMessage } = await import('../../src/daemon/session-dispatch.js');
const { readSenderParticipantTurn, AMBIGUOUS_PARTICIPANT_ACTOR } = await import('../../src/daemon/sender-participant-turn.js');
const { bindProcessSharedMachineActivity, clearProcessSharedMachineAuthoritiesForTests, readProcessSharedMachineAuthority } =
  await import('../../src/daemon/shared-machine-authority-context.js');
const { SHARED_MACHINE_ACTIVITY_KIND } = await import('../../shared/shared-machine-authority.js');
const { MEMORY_MCP_SEND_DELIVERY_MODES } = await import('../../shared/memory-mcp-contracts.js');

function record(name: string, patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name, projectName: 'proj', projectDir: '/repo', role: 'w1', agentType: 'codex-sdk', runtimeType: 'transport', state: 'idle',
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 1, sessionInstanceId: `inst-${name}`, runtimeEpoch: `epoch-${name}`, ...patch,
  } as SessionRecord;
}

/** A sender runtime whose active turn was started by `actors` (empty = an owner turn). */
function senderRuntime(actors: string[], authority: string | null) {
  return {
    requiresSharedMachineAuthority: () => actors.length > 0,
    getActiveSharedMachineAuthority: () => (actors.length > 0 ? authority : null),
    activeDispatchEntries: actors.map((actorUserId) => ({ sharedActor: { actorUserId, effectiveActorRole: 'participant' } })),
  };
}

beforeEach(() => {
  mocks.sessions.clear();
  mocks.runtimes.clear();
  mocks.processSend.mockClear();
  clearProcessSharedMachineAuthoritiesForTests();
});
afterEach(() => clearProcessSharedMachineAuthoritiesForTests());

describe('readSenderParticipantTurn', () => {
  it('reads a transport sender: the single participant and token, a placeholder and no token when several', () => {
    mocks.sessions.set('deck_proj_brain', record('deck_proj_brain'));
    mocks.runtimes.set('deck_proj_brain', senderRuntime(['participant-1'], 'jwt-1'));
    expect(readSenderParticipantTurn('deck_proj_brain')).toEqual({ actorUserId: 'participant-1', authority: 'jwt-1' });
    mocks.runtimes.set('deck_proj_brain', senderRuntime(['participant-1', 'participant-2'], null));
    expect(readSenderParticipantTurn('deck_proj_brain')).toEqual({ actorUserId: AMBIGUOUS_PARTICIPANT_ACTOR, authority: null });
  });

  it('is null for an owner turn, an unknown session and no sender', () => {
    mocks.sessions.set('deck_proj_brain', record('deck_proj_brain'));
    mocks.runtimes.set('deck_proj_brain', senderRuntime([], null));
    expect(readSenderParticipantTurn('deck_proj_brain')).toBeNull();
    expect(readSenderParticipantTurn('deck_proj_nobody')).toBeNull();
    expect(readSenderParticipantTurn(null)).toBeNull();
  });

  it('reads a process sender from its participant window', () => {
    const sender = record('deck_proj_w2', { runtimeType: 'process', agentType: 'claude-code' });
    mocks.sessions.set(sender.name, sender);
    bindProcessSharedMachineActivity(sender.name, { sessionInstanceId: sender.sessionInstanceId!, runtimeEpoch: sender.runtimeEpoch! },
      { kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT, actorUserId: 'participant-9', authority: 'jwt-9' });
    expect(readSenderParticipantTurn(sender.name)).toEqual({ actorUserId: 'participant-9', authority: 'jwt-9' });
  });
});

describe('the actor stamp of an agent-to-agent message', () => {
  const caller = { userId: 'owner', sessionName: 'deck_proj_brain', projectName: 'proj', projectRoot: '/repo' };

  it('carries the participant, their authority, and waits for its own turn when the sender is in a participant turn', () => {
    const sender = record('deck_proj_brain', { runtimeType: 'transport' });
    mocks.sessions.set(sender.name, sender);
    mocks.runtimes.set(sender.name, senderRuntime(['participant-1'], 'jwt-1'));
    const target = record('deck_proj_w1', { runtimeType: 'process', agentType: 'claude-code' });
    const stamp = buildServerMemberSharedActorOption(caller, sender, target, 'msg-1', 1000);
    expect(stamp.sharedActor).toMatchObject({ actorUserId: 'participant-1', effectiveActorRole: 'participant' });
    expect(stamp.sharedMachineAuthority).toBe('jwt-1');
    expect(stamp.deliveryMode).toBe(MEMORY_MCP_SEND_DELIVERY_MODES.QUEUE);
  });

  it('keeps the ordinary stamp for an owner turn (no participant claim, no forced queue)', () => {
    const sender = record('deck_sub_abc');
    mocks.sessions.set(sender.name, sender);
    mocks.runtimes.set(sender.name, senderRuntime([], null));
    const target = record('deck_proj_w1');
    const stamp = buildServerMemberSharedActorOption({ ...caller, sessionName: 'deck_sub_abc' }, sender, target, 'msg-2', 1000);
    expect(stamp.sharedActor).toMatchObject({ effectiveActorRole: 'server-member' });
    expect(stamp.sharedMachineAuthority).toBeUndefined();
    expect(stamp.deliveryMode).toBeUndefined();
  });
});

describe('dispatch of a participant-stamped message', () => {
  const stamped = (sender: string, target: SessionRecord) => buildServerMemberSharedActorOption(
    { userId: 'owner', sessionName: sender, projectName: 'proj', projectRoot: '/repo' },
    mocks.sessions.get(sender) as SessionRecord, target, 'msg-x', 1000,
  );

  it('binds a PROCESS target to the participant: its next turn is restricted and carries the participant\'s authority', async () => {
    const sender = record('deck_proj_brain');
    mocks.sessions.set(sender.name, sender);
    mocks.runtimes.set(sender.name, senderRuntime(['participant-1'], 'jwt-1'));
    const target = record('deck_proj_w1', { runtimeType: 'process', agentType: 'claude-code' });
    mocks.sessions.set(target.name, target);
    expect(readProcessSharedMachineAuthority(target.name, { sessionInstanceId: target.sessionInstanceId!, runtimeEpoch: target.runtimeEpoch! }))
      .toEqual({ required: false, authority: null });

    await dispatchSessionMessage(target, 'run exec_remote on the build machine', {
      dispatchId: 'd1' as never, messageId: 'm1' as never, ...stamped(sender.name, target),
    } as never);

    expect(mocks.processSend).toHaveBeenCalledTimes(1);
    expect(readProcessSharedMachineAuthority(target.name, { sessionInstanceId: target.sessionInstanceId!, runtimeEpoch: target.runtimeEpoch! }))
      .toEqual({ required: true, authority: 'jwt-1' });
  });

  it('does not bind a process target for an owner-authored message', async () => {
    const target = record('deck_proj_w3', { runtimeType: 'process', agentType: 'claude-code' });
    await dispatchSessionMessage(target, 'ordinary', { dispatchId: 'd2' as never, messageId: 'm2' as never } as never);
    expect(readProcessSharedMachineAuthority(target.name, { sessionInstanceId: target.sessionInstanceId!, runtimeEpoch: target.runtimeEpoch! }))
      .toEqual({ required: false, authority: null });
  });

  it('hands a TRANSPORT target the stamp and the token, and never appends it into a running turn', async () => {
    const sender = record('deck_proj_brain');
    mocks.sessions.set(sender.name, sender);
    mocks.runtimes.set(sender.name, senderRuntime(['participant-1'], 'jwt-1'));
    const send = vi.fn((): 'sent' => 'sent');
    const appendExternalMessageToActiveTurn = vi.fn(async () => 'appended');
    const target = record('deck_proj_w2');
    mocks.runtimes.set(target.name, { providerSessionId: 'provider-1', send, appendExternalMessageToActiveTurn });

    await dispatchSessionMessage(target, 'do the thing', {
      dispatchId: 'd3' as never, messageId: 'm3' as never, ...stamped(sender.name, target),
    } as never);

    expect(appendExternalMessageToActiveTurn).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    const metadata = (send.mock.calls[0] as unknown[])[4] as { sharedActor?: { effectiveActorRole: string; actorUserId: string }; sharedMachineAuthority?: string };
    expect(metadata.sharedActor).toMatchObject({ effectiveActorRole: 'participant', actorUserId: 'participant-1' });
    expect(metadata.sharedMachineAuthority).toBe('jwt-1');
  });
});
