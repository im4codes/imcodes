import { describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../src/store/session-store.js';
import type { TimelineEvent } from '../../src/daemon/timeline-event.js';
import {
  buildDelegationContextTail,
  dispatchDelegatedSessionSend,
  resolveExactDelegationTarget,
} from '../../src/daemon/session-dispatch.js';
import {
  AGENT_DELEGATION_CONTEXT_OMITTED_MARKER,
  AGENT_DELEGATION_CONTEXT_TRUNCATED_MARKER,
} from '../../shared/agent-delegation.js';
import { EXECUTION_CLONE_KIND } from '../../shared/execution-clone.js';

function session(name: string, patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name,
    projectName: 'proj',
    projectDir: '/repo',
    role: name.endsWith('_brain') ? 'brain' : 'w1',
    agentType: 'codex',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  } as SessionRecord;
}

function event(type: TimelineEvent['type'], text: string, patch: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    eventId: Math.random().toString(36),
    sessionId: 'deck_proj_brain',
    ts: 1,
    seq: 1,
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
    type,
    payload: { text, streaming: false },
    ...patch,
  } as TimelineEvent;
}

describe('daemon delegation dispatch helper', () => {
  it('resolves only same-project exact reply-capable agent targets', () => {
    const all = [session('deck_proj_brain'), session('deck_proj_w1'), session('deck_other_w1', { projectName: 'other' })];
    expect(resolveExactDelegationTarget({ caller: { userId: 'web', sessionName: 'deck_proj_brain', projectName: 'proj' }, targetSession: 'deck_proj_w1', allSessions: all }).ok).toBe(true);
    expect(resolveExactDelegationTarget({ caller: { userId: 'web', sessionName: 'deck_proj_brain', projectName: 'proj' }, targetSession: 'deck_proj_brain', allSessions: all })).toMatchObject({ ok: false, error: 'delegation_self_target' });
    expect(resolveExactDelegationTarget({ caller: { userId: 'web', sessionName: 'deck_proj_brain', projectName: 'proj' }, targetSession: 'deck_other_w1', allSessions: all })).toMatchObject({ ok: false, error: 'delegation_target_forbidden' });
    expect(resolveExactDelegationTarget({ caller: { userId: 'web', sessionName: 'deck_proj_brain', projectName: 'proj' }, targetSession: 'codex', allSessions: all })).toMatchObject({ ok: false, error: 'delegation_target_unavailable' });
    expect(resolveExactDelegationTarget({ caller: { userId: 'web', sessionName: 'deck_proj_brain', projectName: 'proj' }, targetSession: 'deck_proj_w2', allSessions: [...all, session('deck_proj_w2', { agentType: 'shell' })] })).toMatchObject({ ok: false, error: 'delegation_target_not_reply_capable' });
    expect(resolveExactDelegationTarget({ caller: { userId: 'web', sessionName: 'deck_proj_brain', projectName: 'proj' }, targetSession: 'deck_proj_w3', allSessions: [...all, session('deck_proj_w3', { runtimeType: 'transport', agentType: 'codex-sdk' })] })).toMatchObject({ ok: true, target: expect.objectContaining({ name: 'deck_proj_w3' }) });
    expect(resolveExactDelegationTarget({ caller: { userId: 'web', sessionName: 'deck_proj_brain', projectName: 'proj' }, targetSession: 'deck_proj_w4', allSessions: [...all, session('deck_proj_w4', { executionCloneMetadata: { kind: EXECUTION_CLONE_KIND } as any })] })).toMatchObject({ ok: false, error: 'delegation_target_forbidden' });
  });

  it('builds bounded safe context from user and completed assistant text only', async () => {
    const context = await buildDelegationContextTail({
      sessionName: 'deck_proj_brain',
      turnCap: 3,
      byteCap: 400,
      readTimeline: () => [
        event('system' as TimelineEvent['type'], 'ignore'),
        event('user.message', 'keep one @@all(plan)'),
        event('assistant.text', 'streaming ignore', { payload: { text: 'streaming ignore', streaming: true } }),
        event('tool.result', 'secret'),
        event('assistant.text', 'After completing the above task, send your response using: imcodes send --no-reply "deck_x_brain" "x"\n\nkeep two'),
        event('user.message', 'keep three'),
      ],
    });
    expect(context.status).toBe('ok');
    expect(context.text).toContain('User: keep one');
    expect(context.text).toContain('Assistant: keep two');
    expect(context.text).toContain('User: keep three');
    expect(context.text).not.toContain('tool');
    expect(context.text).not.toContain('imcodes send --no-reply');
    expect(context.text).not.toContain('@@all');
  });

  it('redacts secrets, skips forwarded payloads, and reports truncation status', async () => {
    const large = `password=supersecret ${'x'.repeat(300)}`;
    const context = await buildDelegationContextTail({
      sessionName: 'deck_proj_brain',
      turnCap: 12,
      byteCap: 48,
      readTimeline: () => [
        event('user.message', 'prior A'),
        event('assistant.text', `${AGENT_DELEGATION_CONTEXT_OMITTED_MARKER} old forwarded context`),
        event('user.message', 'memory should skip', { payload: { text: 'memory should skip', memoryExcluded: true } }),
        event('assistant.text', large),
      ],
    });
    expect(context.status).toBe('truncated');
    expect(context.text).toContain('[REDACTED:password]');
    expect(context.text).not.toContain('supersecret');
    expect(context.text).not.toContain('old forwarded context');
    expect(context.text).not.toContain('memory should skip');
  });

  it('dispatches accepted delegation with clean task, context, and reply instruction without waiting for reply', async () => {
    const target = session('deck_proj_w1');
    const dispatched: string[] = [];
    const result = await dispatchDelegatedSessionSend({
      caller: { userId: 'web', sessionName: 'deck_proj_brain', projectName: 'proj', projectRoot: '/repo' },
      targetSession: target.name,
      message: 'please do it',
    }, {
      listSessions: () => [session('deck_proj_brain'), target],
      getSession: (name) => session(name),
      readTimeline: () => [event('user.message', 'prior context')],
      dispatchMessage: vi.fn(async (_target, message) => { dispatched.push(message); }),
    });
    expect(result.status).toBe('accepted');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toContain('please do it');
    expect(dispatched[0]).toContain('prior context');
    expect(dispatched[0]).toContain('imcodes send --no-reply');
    expect(dispatched[0]).toContain('deck_proj_brain');
  });

  it('fails open when context read fails', async () => {
    const sent: string[] = [];
    const result = await dispatchDelegatedSessionSend({
      caller: { userId: 'web', sessionName: 'deck_proj_brain', projectName: 'proj' },
      targetSession: 'deck_proj_w1',
      message: 'task',
    }, {
      listSessions: () => [session('deck_proj_brain'), session('deck_proj_w1')],
      readTimeline: () => { throw new Error('boom'); },
      dispatchMessage: vi.fn(async (_target, message) => { sent.push(message); }),
    });
    expect(result).toMatchObject({ status: 'accepted', contextOmitted: true, contextStatus: 'omitted' });
    expect(sent[0]).toContain('task');
    expect(sent[0]).toContain('[delegation-context-omitted]');
  });

  it('marks delegated dispatch messages when context is truncated', async () => {
    const sent: string[] = [];
    const result = await dispatchDelegatedSessionSend({
      caller: { userId: 'web', sessionName: 'deck_proj_brain', projectName: 'proj' },
      targetSession: 'deck_proj_w1',
      message: 'task',
    }, {
      listSessions: () => [session('deck_proj_brain'), session('deck_proj_w1')],
      readTimeline: () => [event('user.message', `${'long '.repeat(4000)}`)],
      dispatchMessage: vi.fn(async (_target, message) => { sent.push(message); }),
    });
    expect(result).toMatchObject({ status: 'accepted', contextStatus: 'truncated' });
    expect(sent[0]).toContain(AGENT_DELEGATION_CONTEXT_TRUNCATED_MARKER);
    expect(sent[0]).toContain('imcodes send --no-reply');
  });
});
