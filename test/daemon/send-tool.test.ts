import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SessionRecord } from '../../src/store/session-store.js';
import {
  SEND_MCP_DISPATCH_FEATURE_FLAG,
  clearSendIdempotencyCacheForTests,
  dispatchCronSend,
  dispatchSendMessage,
  listSendTargets,
} from '../../src/daemon/send-tool.js';
import { isSendDispatchId, isSendMessageId } from '../../shared/send-message-id.js';

function session(overrides: Partial<SessionRecord> & Pick<SessionRecord, 'name' | 'projectName' | 'role'>): SessionRecord {
  return {
    agentType: 'codex',
    projectDir: `/work/${overrides.projectName}`,
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  } as SessionRecord;
}

const caller = {
  userId: 'user-1',
  sessionName: 'deck_alpha_brain',
  projectName: 'alpha',
  projectRoot: '/work/alpha',
};

describe('send-tool', () => {
  beforeEach(() => {
    clearSendIdempotencyCacheForTests();
    vi.clearAllMocks();
  });

  it('lists only caller project siblings with safe fields', () => {
    const result = listSendTargets(caller, {}, {
      listSessions: () => [
        session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain', label: 'Brain' }),
        session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', label: 'Coder', agentType: 'codex', updatedAt: 20 }),
        session({ name: 'deck_beta_w1', projectName: 'beta', role: 'w1', label: 'Other', projectDir: '/work/beta' }),
      ],
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.items).toEqual([
      {
        target: 'deck_alpha_w1',
        label: 'Coder',
        sessionName: 'deck_alpha_w1',
        role: 'w1',
        agentType: 'codex',
        status: 'idle',
        lastActiveAt: 20,
      },
    ]);
    expect(result.items[0]).not.toHaveProperty('projectDir');
  });

  it('rejects unscoped list and disabled list without target lookup', () => {
    const listSessions = vi.fn(() => []);

    expect(listSendTargets({ ...caller, sessionName: null }, {}, { listSessions }).status).toBe('error');
    expect(listSendTargets(caller, {}, { listSessions, isDispatchEnabled: () => false })).toEqual({
      status: 'disabled',
      reason: 'feature_disabled',
      disabledFlag: SEND_MCP_DISPATCH_FEATURE_FLAG,
      items: [],
    });
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('dispatches to a sibling and returns shared ids', async () => {
    const dispatchMessage = vi.fn().mockResolvedValue(undefined);
    const result = await dispatchSendMessage(caller, { target: 'Coder', message: 'hello' }, {
      listSessions: () => [
        session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
        session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', label: 'Coder' }),
      ],
      dispatchMessage,
    });

    expect(result.status).toBe('accepted');
    if (result.status !== 'accepted') throw new Error('expected accepted');
    expect(isSendDispatchId(result.dispatchId)).toBe(true);
    expect(isSendMessageId(result.messageId)).toBe(true);
    expect(result.deliveries).toHaveLength(1);
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    expect(dispatchMessage.mock.calls[0][1]).toBe('hello');
  });

  it('treats sub-sessions as siblings of their parent project for target listing and dispatch', async () => {
    const sessions = [
      session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
      session({
        name: 'deck_sub_worker',
        projectName: 'deck_sub_worker',
        role: 'w1',
        label: 'Sub Worker',
        parentSession: 'deck_alpha_brain',
      }),
      session({ name: 'deck_alpha_w2', projectName: 'alpha', role: 'w2', label: 'Peer' }),
      session({ name: 'deck_beta_w1', projectName: 'beta', role: 'w1', projectDir: '/work/beta' }),
    ];
    const subCaller = {
      ...caller,
      sessionName: 'deck_sub_worker',
      projectName: 'deck_sub_worker',
    };
    const dispatchMessage = vi.fn().mockResolvedValue(undefined);

    const targets = listSendTargets(subCaller, {}, { listSessions: () => sessions });
    const sent = await dispatchSendMessage(subCaller, { target: 'Peer', message: 'hello' }, {
      listSessions: () => sessions,
      dispatchMessage,
    });

    expect(targets.status).toBe('ok');
    if (targets.status !== 'ok') throw new Error('expected ok');
    expect(targets.items.map((item) => item.sessionName)).toEqual(['deck_alpha_brain', 'deck_alpha_w2']);
    expect(sent).toMatchObject({ status: 'accepted' });
    expect(dispatchMessage.mock.calls[0][0]).toMatchObject({ name: 'deck_alpha_w2' });
  });

  it('rejects cross-project targets with identity_rejected', async () => {
    const dispatchMessage = vi.fn().mockResolvedValue(undefined);
    const result = await dispatchSendMessage(caller, { target: 'deck_beta_w1', message: 'hello' }, {
      listSessions: () => [
        session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
        session({ name: 'deck_beta_w1', projectName: 'beta', role: 'w1', projectDir: '/work/beta' }),
      ],
      dispatchMessage,
    });

    expect(result).toMatchObject({ status: 'error', reason: 'identity_rejected' });
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('rejects unscoped reply and broadcast without dispatching', async () => {
    const dispatchMessage = vi.fn().mockResolvedValue(undefined);

    const reply = await dispatchSendMessage({ ...caller, sessionName: null }, { target: 'deck_alpha_w1', message: 'hello', reply: true }, { dispatchMessage });
    const broadcast = await dispatchSendMessage({ ...caller, projectName: null }, { message: 'hello', broadcast: true }, { dispatchMessage });

    expect(reply).toMatchObject({ status: 'error', reason: 'scope_forbidden' });
    expect(broadcast).toMatchObject({ status: 'error', reason: 'scope_forbidden' });
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('sanitizes file path references and never reads file bytes', async () => {
    const dispatchMessage = vi.fn().mockResolvedValue(undefined);
    const result = await dispatchSendMessage(caller, {
      target: 'deck_alpha_w1',
      message: 'review',
      files: ['src/a.ts', '/work/alpha/src/b.ts'],
    }, {
      listSessions: () => [
        session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
        session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1' }),
      ],
      dispatchMessage,
    });

    expect(result.status).toBe('accepted');
    expect(dispatchMessage.mock.calls[0][1]).toContain('Referenced files:\n- src/a.ts\n- src/b.ts');
    expect(dispatchMessage.mock.calls[0][1]).not.toContain('file contents');
  });

  it('rejects outside-root file paths before dispatch', async () => {
    const dispatchMessage = vi.fn().mockResolvedValue(undefined);
    const result = await dispatchSendMessage(caller, {
      target: 'deck_alpha_w1',
      message: 'review',
      files: ['../secret.txt'],
    }, {
      listSessions: () => [
        session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1' }),
      ],
      dispatchMessage,
    });

    expect(result).toMatchObject({ status: 'error', reason: 'scope_forbidden' });
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('returns original ids for 5 second idempotent replay and dispatches once', async () => {
    let now = 1000;
    const dispatchMessage = vi.fn().mockResolvedValue(undefined);
    const deps = {
      now: () => now,
      listSessions: () => [session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1' })],
      dispatchMessage,
    };

    const first = await dispatchSendMessage(caller, { target: 'deck_alpha_w1', message: 'hello', idempotencyKey: 'same' }, deps);
    now += 4_999;
    const second = await dispatchSendMessage(caller, { target: 'deck_alpha_w1', message: 'hello again', idempotencyKey: 'same' }, deps);

    expect(first.status).toBe('accepted');
    expect(second.status).toBe('accepted');
    if (first.status !== 'accepted' || second.status !== 'accepted') throw new Error('expected accepted');
    expect(second.idempotentReplay).toBe(true);
    expect(second.dispatchId).toBe(first.dispatchId);
    expect(second.messageId).toBe(first.messageId);
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('reports partial failures without caching idempotency replays', async () => {
    let now = 1000;
    const dispatchMessage = vi.fn(async (target: SessionRecord) => {
      if (target.name === 'deck_alpha_w2') throw new Error('Bearer secret-token failed');
    });
    const deps = {
      now: () => now,
      listSessions: () => [
        session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
        session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1' }),
        session({ name: 'deck_alpha_w2', projectName: 'alpha', role: 'w2' }),
      ],
      dispatchMessage,
    };

    const first = await dispatchSendMessage(caller, { message: 'hello', broadcast: true, idempotencyKey: 'partial' }, deps);
    now += 1_000;
    const second = await dispatchSendMessage(caller, { message: 'hello again', broadcast: true, idempotencyKey: 'partial' }, deps);

    expect(first).toMatchObject({
      status: 'accepted',
      partial: true,
      deliveries: [
        { target: 'deck_alpha_w1', status: 'delivered' },
        { target: 'deck_alpha_w2', status: 'failed', error: 'Bearer [redacted] failed' },
      ],
    });
    expect(second.status).toBe('accepted');
    if (second.status !== 'accepted') throw new Error('expected accepted');
    expect(second.idempotentReplay).toBeUndefined();
    expect(dispatchMessage).toHaveBeenCalledTimes(4);
  });

  it('rejects control-character file references and oversized send inputs', async () => {
    const dispatchMessage = vi.fn().mockResolvedValue(undefined);
    const deps = {
      listSessions: () => [session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1' })],
      dispatchMessage,
    };

    await expect(dispatchSendMessage(caller, {
      target: 'deck_alpha_w1',
      message: 'review',
      files: ['src/a.ts\n- injected'],
    }, deps)).resolves.toMatchObject({ status: 'error', reason: 'validation_failed' });

    await expect(dispatchSendMessage(caller, {
      target: 'deck_alpha_w1',
      message: 'x'.repeat(64 * 1024 + 1),
    }, deps)).resolves.toMatchObject({ status: 'error', reason: 'write_quota_exceeded' });

    await expect(dispatchSendMessage(caller, {
      target: 'deck_alpha_w1',
      message: 'review',
      files: Array.from({ length: 33 }, (_, index) => `src/${index}.ts`),
    }, deps)).resolves.toMatchObject({ status: 'error', reason: 'write_quota_exceeded' });

    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('can require exact session targets for MCP without removing hook label compatibility', async () => {
    const dispatchMessage = vi.fn().mockResolvedValue(undefined);
    const deps = {
      listSessions: () => [
        session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
        session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1', label: 'Coder' }),
      ],
      dispatchMessage,
    };

    await expect(dispatchSendMessage(caller, { target: 'Coder', message: 'hello' }, {
      ...deps,
      exactTargetOnly: true,
    })).resolves.toMatchObject({ status: 'error', reason: 'validation_failed' });
    await expect(dispatchSendMessage(caller, { target: 'deck_alpha_w1', message: 'hello' }, {
      ...deps,
      exactTargetOnly: true,
    })).resolves.toMatchObject({ status: 'accepted' });
  });

  it('surfaces cron structured send partial deliveries', async () => {
    const dispatchMessage = vi.fn(async (target: SessionRecord) => {
      if (target.name === 'deck_alpha_w2') throw new Error('transport failed');
    });

    const result = await dispatchCronSend({
      fromSessionName: 'deck_alpha_brain',
      message: 'hello',
      target: '',
      broadcast: true,
    }, {
      getSession: (name) => session({ name, projectName: 'alpha', role: 'brain' }),
      listSessions: () => [
        session({ name: 'deck_alpha_brain', projectName: 'alpha', role: 'brain' }),
        session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1' }),
        session({ name: 'deck_alpha_w2', projectName: 'alpha', role: 'w2' }),
      ],
      dispatchMessage,
    });

    expect(result.status).toBe('partial');
    expect(result.deliveries).toEqual([
      expect.objectContaining({ target: 'deck_alpha_w1', status: 'delivered' }),
      expect.objectContaining({ target: 'deck_alpha_w2', status: 'failed', error: 'transport failed' }),
    ]);
  });

  it('adds no-reply callback instructions when reply is requested', async () => {
    const dispatchMessage = vi.fn().mockResolvedValue(undefined);
    await dispatchSendMessage(caller, { target: 'deck_alpha_w1', message: 'do it', reply: true }, {
      listSessions: () => [session({ name: 'deck_alpha_w1', projectName: 'alpha', role: 'w1' })],
      dispatchMessage,
    });

    expect(dispatchMessage.mock.calls[0][1]).toContain('imcodes send --no-reply "deck_alpha_brain" "Task: <brief summary of the request>\\nResult: <your response>"');
  });
});
