import { describe, it, expect } from 'vitest';
import {
  readDelegationDispatchFact,
  projectDelegationClaim,
  readDelegationClaim,
  isDelegationDispatchTool,
  DELEGATION_AUTHORITY_MCP_SERVER,
  DELEGATION_CLAIM_METADATA_FIELD,
} from '../../shared/delegation-claim.js';

const ACCEPTED_OUTPUT = {
  status: 'accepted',
  dispatchId: 'send_dispatch_806104d8',
  messageId: 'send_message_4772bca6',
  deliveries: [{ target: 'deck_cd_brain', messageId: 'send_message_4772bca6', status: 'delivered' }],
};
const TASK_ARGS = { task: { taskId: 'tsk_5gi', assignmentId: 'asg_5gl' } };

describe('delegation dispatch facts', () => {
  it('binds a real dispatch to its exact authority ids', () => {
    const fact = readDelegationDispatchFact(
      DELEGATION_AUTHORITY_MCP_SERVER, 'send_message', TASK_ARGS, ACCEPTED_OUTPUT,
    );
    expect(fact).toEqual({
      dispatchId: 'send_dispatch_806104d8',
      taskId: 'tsk_5gi',
      assignmentId: 'asg_5gl',
      deliveries: [{ target: 'deck_cd_brain', messageId: 'send_message_4772bca6', status: 'delivered' }],
    });
  });

  it('refuses a native collaboration send_message that shares the short name', () => {
    // Codex's own send_message carries no IM.codes authority. Distinguishing by
    // tool name alone is exactly how a non-durable native call could have been
    // counted as an authoritative dispatch.
    expect(isDelegationDispatchTool('codex-native', 'send_message')).toBe(false);
    expect(readDelegationDispatchFact('codex-native', 'send_message', TASK_ARGS, ACCEPTED_OUTPUT))
      .toBeNull();
  });

  it('refuses an accepted dispatch that reached nobody', () => {
    const fact = readDelegationDispatchFact(
      DELEGATION_AUTHORITY_MCP_SERVER, 'send_message', TASK_ARGS,
      { ...ACCEPTED_OUTPUT, deliveries: [] },
    );
    expect(fact, 'acceptance is not delivery').toBeNull();
  });

  it('refuses a dispatch with no dispatchId', () => {
    const { dispatchId: _omitted, ...noId } = ACCEPTED_OUTPUT;
    expect(readDelegationDispatchFact(
      DELEGATION_AUTHORITY_MCP_SERVER, 'send_message', TASK_ARGS, noId,
    )).toBeNull();
  });

  it('refuses a non-accepted status', () => {
    expect(readDelegationDispatchFact(
      DELEGATION_AUTHORITY_MCP_SERVER, 'send_message', TASK_ARGS,
      { ...ACCEPTED_OUTPUT, status: 'error' },
    )).toBeNull();
  });

  it('drops delivery legs missing a target or status rather than counting them', () => {
    const fact = readDelegationDispatchFact(
      DELEGATION_AUTHORITY_MCP_SERVER, 'send_message', TASK_ARGS,
      { ...ACCEPTED_OUTPUT, deliveries: [{ target: 'deck_cd_brain' }, { status: 'queued' }] },
    );
    expect(fact, 'no complete delivery leg means no substantiation').toBeNull();
  });
});

describe('authority requires exact ids and a real delivery leg (R3)', () => {
  it('requires BOTH taskId and assignmentId, not just one', () => {
    // A dispatch that names no task/assignment cannot be checked against the
    // registry, so it cannot substantiate "assigned/queued/recovered".
    expect(readDelegationDispatchFact(
      DELEGATION_AUTHORITY_MCP_SERVER, 'send_message',
      { task: { assignmentId: 'asg_5gl' } }, ACCEPTED_OUTPUT,
    ), 'missing taskId').toBeNull();
    expect(readDelegationDispatchFact(
      DELEGATION_AUTHORITY_MCP_SERVER, 'send_message',
      { task: { taskId: 'tsk_5gi' } }, ACCEPTED_OUTPUT,
    ), 'missing assignmentId').toBeNull();
    expect(readDelegationDispatchFact(
      DELEGATION_AUTHORITY_MCP_SERVER, 'send_message', {}, ACCEPTED_OUTPUT,
    ), 'an ordinary send with no task binding').toBeNull();
  });

  it('refuses a dispatch whose only delivery legs failed', () => {
    expect(readDelegationDispatchFact(
      DELEGATION_AUTHORITY_MCP_SERVER, 'send_message', TASK_ARGS,
      { ...ACCEPTED_OUTPUT, deliveries: [{ target: 'deck_sub_w1', status: 'failed' }] },
    ), 'a failed delivery reached nobody').toBeNull();
  });

  it('refuses unknown or empty delivery statuses rather than trusting non-emptiness', () => {
    for (const status of ['', '   ', 'pending', 'accepted', 'unknown', 'sent']) {
      expect(readDelegationDispatchFact(
        DELEGATION_AUTHORITY_MCP_SERVER, 'send_message', TASK_ARGS,
        { ...ACCEPTED_OUTPUT, deliveries: [{ target: 'deck_sub_w1', status }] },
      ), `status ${JSON.stringify(status)} must not substantiate`).toBeNull();
    }
  });

  it('keeps a mixed dispatch, but only its genuinely reached legs', () => {
    const fact = readDelegationDispatchFact(
      DELEGATION_AUTHORITY_MCP_SERVER, 'send_message', TASK_ARGS,
      { ...ACCEPTED_OUTPUT, deliveries: [
        { target: 'deck_sub_dead', status: 'failed' },
        { target: 'deck_sub_w1', status: 'delivered' },
      ] },
    );
    expect(fact?.deliveries.map((leg) => leg.target)).toEqual(['deck_sub_w1']);
    expect(fact?.deliveries, 'a failed leg must not be reported as reached')
      .not.toContainEqual(expect.objectContaining({ target: 'deck_sub_dead' }));
  });

  it('accepts delivered and queued as real outcomes (controls)', () => {
    for (const status of ['delivered', 'queued']) {
      const fact = readDelegationDispatchFact(
        DELEGATION_AUTHORITY_MCP_SERVER, 'send_message', TASK_ARGS,
        { ...ACCEPTED_OUTPUT, deliveries: [{ target: 'deck_sub_w1', status }] },
      );
      expect(fact, `${status} is a real outcome`).not.toBeNull();
      expect(fact?.taskId).toBe('tsk_5gi');
      expect(fact?.assignmentId).toBe('asg_5gl');
    }
  });
});

describe('delegation claim projection', () => {
  it('is unsubstantiated with an empty dispatch list when nothing was dispatched', () => {
    const projection = projectDelegationClaim([]);
    expect(projection.status).toBe('unsubstantiated');
    expect(
      projection.dispatches,
      'a consumer must have no dispatch data it could render as assigned/queued',
    ).toEqual([]);
  });

  it('is substantiated and carries the exact ids when a dispatch happened', () => {
    const fact = readDelegationDispatchFact(
      DELEGATION_AUTHORITY_MCP_SERVER, 'send_message', TASK_ARGS, ACCEPTED_OUTPUT,
    )!;
    const projection = projectDelegationClaim([fact]);
    expect(projection.status).toBe('substantiated');
    expect(projection.dispatches).toHaveLength(1);
    expect(projection.dispatches[0].dispatchId).toBe('send_dispatch_806104d8');
    expect(projection.dispatches[0].taskId).toBe('tsk_5gi');
    expect(projection.dispatches[0].assignmentId).toBe('asg_5gl');
  });

  it('round-trips through message metadata', () => {
    const projection = projectDelegationClaim([]);
    const metadata = { [DELEGATION_CLAIM_METADATA_FIELD]: projection };
    expect(readDelegationClaim(metadata)).toEqual(projection);
    expect(readDelegationClaim(undefined)).toBeNull();
    expect(readDelegationClaim({ other: 1 })).toBeNull();
  });
});
