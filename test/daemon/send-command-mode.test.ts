import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../src/store/session-store.js';
import {
  clearSendIdempotencyCacheForTests,
  dispatchHookSend,
  dispatchSendMessage,
} from '../../src/daemon/send-tool.js';
import { buildSessionDispatchMessage } from '../../src/daemon/session-dispatch.js';
import { getDelegationReplyStore } from '../../src/daemon/delegation-reply-store.js';
import {
  AGENT_DELEGATION_CONTEXT_HEADER,
  AGENT_DELEGATION_SENDER_MARKER,
} from '../../shared/agent-delegation.js';
import { CHAT_MESSAGE_ORIGINS } from '../../shared/chat-message-origin.js';
import {
  SEND_COMMAND_ERRORS,
  sendCommandText,
  validateSendCommandRequest,
} from '../../shared/send-command-mode.js';
import { MEMORY_MCP_SEND_DELIVERY_MODES } from '../../shared/memory-mcp-contracts.js';

function session(name: string, role: SessionRecord['role'], extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name, projectName: 'cmdproj', role, agentType: 'codex', projectDir: '/work/cmdproj', state: 'idle',
    sessionInstanceId: `instance_${name}`, runtimeEpoch: `epoch_${name}`,
    restarts: 0, restartTimestamps: [], createdAt: 1, updatedAt: 2, ...extra,
  } as SessionRecord;
}

const BRAIN = 'deck_cmdproj_brain';
const W1 = 'deck_sub_cmdw1';
const W2 = 'deck_sub_cmdw2';
const SUB = 'deck_sub_cmdsub';
const caller = { userId: 'user-1', sessionName: BRAIN, projectName: 'cmdproj', projectRoot: '/work/cmdproj' };
const sessions = [
  session(BRAIN, 'brain'),
  session(W1, 'w1', { parentSession: BRAIN }),
  session(W2, 'w2', { parentSession: BRAIN, agentType: 'claude-code-sdk', runtimeType: 'transport' }),
  session(SUB, 'w3', { parentSession: BRAIN, label: 'Helper' }),
];

const dispatchMessage = vi.fn();
const cancelSession = vi.fn();
const deps = () => ({
  listSessions: () => sessions,
  getSession: (name: string) => sessions.find((entry) => entry.name === name),
  dispatchMessage,
  cancelSession,
  exactTargetOnly: true,
});

function delegationRecordCount(): number {
  return getDelegationReplyStore().listOpenByOriginSession(BRAIN).length;
}

describe('command mode: shared validator', () => {
  it('trims and accepts multi-line and non-ASCII text', () => {
    const text = '  \n第一行 ✓\n  second line with  spaces \t\n';
    expect(validateSendCommandRequest({ message: text })).toBeNull();
    expect(sendCommandText(text)).toBe('第一行 ✓\n  second line with  spaces');
  });

  it.each([
    [{ message: '' }, SEND_COMMAND_ERRORS.EMPTY],
    [{ message: ' \n\t ' }, SEND_COMMAND_ERRORS.EMPTY],
    [{ message: undefined }, SEND_COMMAND_ERRORS.EMPTY],
    [{ message: '/compact', reply: true }, SEND_COMMAND_ERRORS.WITH_REPLY],
    [{ message: '/compact', files: ['a.txt'] }, SEND_COMMAND_ERRORS.WITH_FILES],
    [{ message: '/compact', hasSendMetadata: true }, SEND_COMMAND_ERRORS.WITH_METADATA],
  ])('rejects %j', (request, error) => {
    expect(validateSendCommandRequest(request)).toBe(error);
  });

  it('allows reply=false and an empty files list', () => {
    expect(validateSendCommandRequest({ message: 'x', reply: false, files: [] })).toBeNull();
  });
});

describe('command mode: buildSessionDispatchMessage', () => {
  const everything = {
    from: BRAIN,
    fromLabel: 'Brain',
    replyTo: BRAIN,
    files: ['src/a.ts'],
    contextTail: 'User: earlier context',
    contextStatus: 'truncated' as const,
  };

  it('counterexample: without command the message is wrapped with sender, context, files and reply instruction', () => {
    const wrapped = buildSessionDispatchMessage({ message: 'run the tests', ...everything });
    expect(wrapped).toContain(AGENT_DELEGATION_SENDER_MARKER);
    expect(wrapped).toContain(AGENT_DELEGATION_CONTEXT_HEADER);
    expect(wrapped).toContain('Referenced files:');
    expect(wrapped).toContain('run the tests');
    expect(wrapped).not.toBe('run the tests');
  });

  it('command mode returns exactly the trimmed text whatever else is supplied', () => {
    expect(buildSessionDispatchMessage({ message: '  run the tests\n', command: true, ...everything })).toBe('run the tests');
    const bytes = '  多行\n  命令 — with “quotes” 🚀  ';
    expect(Buffer.from(buildSessionDispatchMessage({ message: bytes, command: true, ...everything })).equals(Buffer.from(bytes.trim())))
      .toBe(true);
  });

  it('existing auto-detected control commands stay verbatim without the flag', () => {
    for (const control of ['/compact', '/clear', '/model gpt-5.4', '  /compact  ']) {
      expect(buildSessionDispatchMessage({ message: control, ...everything })).toBe(control.trim());
    }
  });
});

describe('command mode: dispatchSendMessage (MCP send_message)', () => {
  beforeEach(() => {
    clearSendIdempotencyCacheForTests();
    dispatchMessage.mockReset().mockResolvedValue('sent');
    cancelSession.mockReset().mockResolvedValue(true);
  });

  it('delivers exactly message.trim() with no sender line, files, reply authority or delegation record', async () => {
    const before = delegationRecordCount();
    const message = '\n  Please run:\n    npm test -- --run\n第二行 ✓  \n';
    const result = await dispatchSendMessage(caller, { target: W1, message, command: true }, deps());
    expect(result).toMatchObject({ status: 'accepted', deliveries: [{ target: W1, status: 'delivered' }] });
    if (result.status !== 'accepted') throw new Error('expected accepted');
    expect(result.deliveries[0]).not.toHaveProperty('delegationId');
    expect(result.deliveries[0]).not.toHaveProperty('taskId');
    expect(result).not.toHaveProperty('taskId');
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    const [target, delivered, options] = dispatchMessage.mock.calls[0]!;
    expect(target.name).toBe(W1);
    expect(Buffer.from(delivered).equals(Buffer.from(message.trim()))).toBe(true);
    expect(delivered).not.toContain(AGENT_DELEGATION_SENDER_MARKER);
    expect(options).toMatchObject({
      command: true,
      messageOrigin: CHAT_MESSAGE_ORIGINS.AGENT,
      deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.APPEND,
    });
    expect(options).not.toHaveProperty('supervision');
    expect(delegationRecordCount()).toBe(before);
  });

  it('counterexample: the same send without command keeps the wrapping', async () => {
    await dispatchSendMessage(caller, { target: W1, message: 'run the tests' }, deps());
    const delivered = dispatchMessage.mock.calls[0]![1] as string;
    expect(delivered).toContain(AGENT_DELEGATION_SENDER_MARKER);
    expect(delivered).toContain('run the tests');
    expect(delivered).not.toBe('run the tests');
    expect(dispatchMessage.mock.calls[0]![2]).not.toHaveProperty('command');
  });

  it('counterexample: an ordinary reply-enabled send creates a delegation record, a command never does', async () => {
    const before = delegationRecordCount();
    const ordinary = await dispatchSendMessage(caller, { target: W1, message: 'review this', reply: true }, deps());
    if (ordinary.status !== 'accepted') throw new Error(JSON.stringify(ordinary));
    expect(ordinary.deliveries[0]!.delegationId).toBeTruthy();
    expect(delegationRecordCount()).toBe(before + 1);
    await dispatchSendMessage(caller, { target: W1, message: 'review this', command: true }, deps());
    expect(delegationRecordCount()).toBe(before + 1);
  });

  it('command=false is an ordinary send', async () => {
    await dispatchSendMessage(caller, { target: W1, message: 'run the tests', command: false }, deps());
    expect(dispatchMessage.mock.calls[0]![1]).toContain(AGENT_DELEGATION_SENDER_MARKER);
  });

  it('a slash command in command mode arrives unchanged, exactly as the auto-detected form does', async () => {
    await dispatchSendMessage(caller, { target: W1, message: '  /compact ', command: true }, deps());
    await dispatchSendMessage(caller, { target: W1, message: '/compact' }, deps());
    expect(dispatchMessage.mock.calls[0]![1]).toBe('/compact');
    expect(dispatchMessage.mock.calls[1]![1]).toBe('/compact');
  });

  it('honors queue delivery mode and reports a queued receipt (busy target)', async () => {
    dispatchMessage.mockResolvedValueOnce('queued');
    const result = await dispatchSendMessage(caller, { target: W2, message: 'do it', command: true, deliveryMode: 'queue' }, deps());
    expect(result).toMatchObject({ status: 'accepted', deliveries: [{ target: W2, status: 'queued' }] });
    expect(dispatchMessage.mock.calls[0]![2]).toMatchObject({ command: true, deliveryMode: 'queue' });
  });

  it('reaches a sub-session target', async () => {
    const result = await dispatchSendMessage(caller, { target: SUB, message: '/compact', command: true }, deps());
    expect(result).toMatchObject({ status: 'accepted', deliveries: [{ target: SUB, status: 'delivered' }] });
    expect(dispatchMessage.mock.calls[0]![1]).toBe('/compact');
  });

  it('broadcast is allowed: every sibling receives the identical raw text, caller excluded', async () => {
    const result = await dispatchSendMessage(caller, { broadcast: true, message: ' /compact ', command: true }, deps());
    expect(result.status).toBe('accepted');
    const targets = dispatchMessage.mock.calls.map((call) => call[0].name).sort();
    expect(targets).toEqual([W1, W2, SUB].sort());
    expect(new Set(dispatchMessage.mock.calls.map((call) => call[1]))).toEqual(new Set(['/compact']));
    expect(dispatchMessage.mock.calls.every((call) => call[2].command === true)).toBe(true);
  });

  it('replays an idempotent command without delivering twice', async () => {
    const input = { target: W1, message: 'once', command: true, idempotencyKey: 'cmd-idem-1' };
    const first = await dispatchSendMessage(caller, input, deps());
    const second = await dispatchSendMessage(caller, input, deps());
    expect(first.status).toBe('accepted');
    expect(second).toMatchObject({ status: 'accepted', idempotentReplay: true });
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('/stop in command mode takes the priority stop path and is never dispatched as a message', async () => {
    const result = await dispatchSendMessage(caller, { target: W2, message: ' /stop ', command: true }, deps());
    expect(result).toMatchObject({ status: 'accepted', deliveries: [{ target: W2, status: 'delivered' }] });
    expect(cancelSession).toHaveBeenCalledTimes(1);
    expect(cancelSession.mock.calls[0]![0].name).toBe(W2);
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('/stop in command mode reports a target that cannot be stopped', async () => {
    cancelSession.mockResolvedValueOnce(false);
    const result = await dispatchSendMessage(caller, { target: W2, message: '/stop', command: true }, deps());
    expect(result.status).toBe('error');
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  describe('invalid combinations are rejected with a clear error and deliver nothing', () => {
    it.each([
      ['reply=true', { reply: true }, SEND_COMMAND_ERRORS.WITH_REPLY],
      ['files', { files: ['src/a.ts'] }, SEND_COMMAND_ERRORS.WITH_FILES],
      ['task metadata', { task: { objective: 'x' } }, SEND_COMMAND_ERRORS.WITH_METADATA],
      ['audit metadata', { audit: { kind: 'supervision_audit', attemptId: 'a', auditedSessionName: W1 }, reply: false }, SEND_COMMAND_ERRORS.WITH_METADATA],
      ['identity', { identity: { content: 'x' } }, SEND_COMMAND_ERRORS.WITH_METADATA],
      ['clone', { clone: { kind: 'execution_clone', ephemeral: true, parentRunId: 'r', parentStage: 'generic_execution' } }, SEND_COMMAND_ERRORS.WITH_METADATA],
    ])('%s', async (_name, extra, error) => {
      const result = await dispatchSendMessage(caller, { target: W1, message: '/compact', command: true, ...extra } as never, deps());
      expect(result).toMatchObject({ status: 'error', reason: 'validation_failed', error });
      expect(dispatchMessage).not.toHaveBeenCalled();
    });

    it('empty and whitespace-only commands', async () => {
      for (const message of ['', '   \n\t']) {
        const result = await dispatchSendMessage(caller, { target: W1, message, command: true }, deps());
        expect(result).toMatchObject({ status: 'error', error: SEND_COMMAND_ERRORS.EMPTY });
      }
      expect(dispatchMessage).not.toHaveBeenCalled();
    });

    it('a missing target', async () => {
      const result = await dispatchSendMessage(caller, { message: '/compact', command: true }, deps());
      expect(result).toMatchObject({ status: 'error', error: 'target is required unless broadcast is true' });
    });

    it('an unknown deliveryMode', async () => {
      const result = await dispatchSendMessage(caller, { target: W1, message: '/compact', command: true, deliveryMode: 'later' as never }, deps());
      expect(result).toMatchObject({ status: 'error', error: 'deliveryMode is invalid' });
    });
  });
});

describe('command mode: dispatchHookSend (imcodes send --command / hook path)', () => {
  beforeEach(() => {
    dispatchMessage.mockReset().mockResolvedValue('sent');
  });

  const hookInput = (extra: Record<string, unknown> = {}) => ({
    from: BRAIN,
    targetRecords: [sessions[1]!],
    message: '  raw text\nsecond line  ',
    ...extra,
  });

  it('delivers exactly the trimmed text with no delegation record and marks the dispatch as a command', async () => {
    const before = delegationRecordCount();
    const result = await dispatchHookSend(hookInput({ command: true }) as never, deps());
    expect(result.delivered).toEqual([W1]);
    expect(result.messages[0]).not.toHaveProperty('delegationId');
    expect(dispatchMessage.mock.calls[0]![1]).toBe('raw text\nsecond line');
    expect(dispatchMessage.mock.calls[0]![2]).toMatchObject({ command: true });
    expect(delegationRecordCount()).toBe(before);
  });

  it('counterexample: the same hook send without command is wrapped', async () => {
    await dispatchHookSend(hookInput() as never, deps());
    expect(dispatchMessage.mock.calls[0]![1]).toContain(AGENT_DELEGATION_SENDER_MARKER);
    expect(dispatchMessage.mock.calls[0]![2]).not.toHaveProperty('command');
  });

  it.each([
    ['reply', { reply: true }, SEND_COMMAND_ERRORS.WITH_REPLY],
    ['files', { files: ['a.ts'] }, SEND_COMMAND_ERRORS.WITH_FILES],
    ['a supervision binding', { supervision: { taskId: 't', assignmentId: 'a' } }, SEND_COMMAND_ERRORS.WITH_METADATA],
  ])('rejects command with %s before any delivery', async (_name, extra, error) => {
    await expect(dispatchHookSend(hookInput({ command: true, ...extra }) as never, deps())).rejects.toThrow(error);
    expect(dispatchMessage).not.toHaveBeenCalled();
  });
});
