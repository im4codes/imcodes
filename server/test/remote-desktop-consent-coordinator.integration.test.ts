import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createUser } from '../src/db/queries.js';
import {
  REMOTE_DESKTOP_CONSENT_CANCEL_REASON,
  REMOTE_DESKTOP_CONSENT_DECISION,
  REMOTE_DESKTOP_CONSENT_MSG,
} from '../../shared/remote-desktop-access.js';
import { REMOTE_DESKTOP_ACCESS_MODE } from '../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_CONSENT_CANCEL_TRIGGER,
  REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR,
  REMOTE_DESKTOP_CONSENT_STATE,
  RemoteDesktopConsentCoordinatorError,
  cancelAttendedConsents,
  consumeApprovedAttendedConsent,
  createRemoteDesktopConsentResultConsumer,
  getAttendedConsent,
  recordAttendedConsentNodeMessage,
  remoteDesktopConsentCancellation,
  requestAttendedConsent,
  sweepTimedOutAttendedConsents,
  type ConsumeAttendedConsentInput,
  type RemoteDesktopConsentDispatchCommand,
} from '../src/services/remote-desktop-consent-coordinator.js';

let db: Database;

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => {
  await db.close();
});

interface Fixture {
  hostId: string;
  serverId: string;
  actorAuditId: string;
  browserKeyHash: string;
  endpointGeneration: number;
  daemonGeneration: number;
}

async function fixture(): Promise<Fixture> {
  const ownerId = `owner-${randomUUID()}`;
  const serverId = `server-${randomUUID()}`;
  const hostId = `host-${randomUUID()}`;
  await createUser(db, ownerId);
  await createServer(db, serverId, ownerId, 'consent endpoint', 'token-hash');
  await db.execute(
    `INSERT INTO remote_desktop_hosts
       (id, owner_user_id, merge_state, created_at, updated_at)
     VALUES ($1, $2, 'resolved', $3, $3)`,
    [hostId, ownerId, Date.now()],
  );
  return {
    hostId,
    serverId,
    actorAuditId: `actor-${randomUUID()}`,
    browserKeyHash: 'a'.repeat(64),
    endpointGeneration: 4,
    daemonGeneration: 9,
  };
}

async function createPending(
  value: Fixture,
  options: {
    approvalId?: string;
    mode?: typeof REMOTE_DESKTOP_ACCESS_MODE.VIEW | typeof REMOTE_DESKTOP_ACCESS_MODE.CONTROL;
    dispatch?: (command: RemoteDesktopConsentDispatchCommand) => boolean;
  } = {},
) {
  const dispatch = options.dispatch ?? vi.fn(() => true);
  const consent = await requestAttendedConsent(db, {
    hostId: value.hostId,
    actorAuditId: value.actorAuditId,
    browserKeyHash: value.browserKeyHash,
    executionServerId: value.serverId,
    endpointGeneration: value.endpointGeneration,
    daemonGeneration: value.daemonGeneration,
    mode: options.mode ?? REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
    requesterLabel: 'Anonymous guest',
    deadlineAt: Date.now() + 20_000,
  }, {
    dispatch,
    ...(options.approvalId ? { approvalId: () => options.approvalId! } : {}),
  });
  return { consent, dispatch };
}

function consumeInput(
  value: Fixture,
  approvalId: string,
  sessionId = `session-${randomUUID()}`,
): ConsumeAttendedConsentInput {
  return {
    approvalId,
    hostId: value.hostId,
    actorAuditId: value.actorAuditId,
    browserKeyHash: value.browserKeyHash,
    executionServerId: value.serverId,
    endpointGeneration: value.endpointGeneration,
    daemonGeneration: value.daemonGeneration,
    mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
    sessionId,
  };
}

async function approve(value: Fixture, approvalId: string): Promise<boolean> {
  return recordAttendedConsentNodeMessage(db, {
    executionServerId: value.serverId,
    daemonGeneration: value.daemonGeneration,
    message: {
      type: REMOTE_DESKTOP_CONSENT_MSG.RESULT,
      approvalId,
      decision: REMOTE_DESKTOP_CONSENT_DECISION.APPROVED,
      daemonGeneration: value.daemonGeneration,
    },
  });
}

describe('durable attended-consent request/result boundary', () => {
  it('persists the exact bounded binding before dispatching a secret-free request', async () => {
    const value = await fixture();
    const dispatch = vi.fn(() => true);
    const { consent } = await createPending(value, { dispatch });

    expect(consent).toMatchObject({
      hostId: value.hostId,
      actorAuditId: value.actorAuditId,
      browserKeyHash: value.browserKeyHash,
      executionServerId: value.serverId,
      endpointGeneration: value.endpointGeneration,
      daemonGeneration: value.daemonGeneration,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      state: REMOTE_DESKTOP_CONSENT_STATE.PENDING,
    });
    expect(dispatch).toHaveBeenCalledWith({
      executionServerId: value.serverId,
      daemonGeneration: value.daemonGeneration,
      message: {
        type: REMOTE_DESKTOP_CONSENT_MSG.REQUEST,
        approvalId: consent.approvalId,
        hostId: value.hostId,
        mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        requesterLabel: 'Anonymous guest',
        createdAt: consent.createdAt,
        deadlineAt: consent.deadlineAt,
        daemonGeneration: value.daemonGeneration,
      },
    });
    expect(JSON.stringify(dispatch.mock.calls)).not.toMatch(
      /rawToken|password|browserPrivateKey|capability|prepare|sdp|ice/i,
    );
  });

  it('accepts one current owning-generation positive result and drops replay/stale/reverse frames', async () => {
    const value = await fixture();
    const { consent } = await createPending(value);
    const consumeNodeResult = createRemoteDesktopConsentResultConsumer(db);

    expect(await consumeNodeResult({
      executionServerId: value.serverId,
      daemonGeneration: value.daemonGeneration - 1,
      message: {
        type: REMOTE_DESKTOP_CONSENT_MSG.RESULT,
        approvalId: consent.approvalId,
        decision: REMOTE_DESKTOP_CONSENT_DECISION.APPROVED,
        daemonGeneration: value.daemonGeneration - 1,
      },
    })).toBe(false);
    expect(await consumeNodeResult({
      executionServerId: `server-${randomUUID()}`,
      daemonGeneration: value.daemonGeneration,
      message: {
        type: REMOTE_DESKTOP_CONSENT_MSG.RESULT,
        approvalId: consent.approvalId,
        decision: REMOTE_DESKTOP_CONSENT_DECISION.APPROVED,
        daemonGeneration: value.daemonGeneration,
      },
    })).toBe(false);
    expect(await consumeNodeResult({
      executionServerId: value.serverId,
      daemonGeneration: value.daemonGeneration,
      message: {
        type: REMOTE_DESKTOP_CONSENT_MSG.RESULT,
        approvalId: consent.approvalId,
        decision: REMOTE_DESKTOP_CONSENT_DECISION.APPROVED,
        daemonGeneration: value.daemonGeneration,
        rawToken: 'must-not-pass',
      },
    })).toBe(false);
    expect(await consumeNodeResult({
      executionServerId: value.serverId,
      daemonGeneration: value.daemonGeneration,
      message: {
        type: REMOTE_DESKTOP_CONSENT_MSG.REQUEST,
        approvalId: consent.approvalId,
        hostId: value.hostId,
        mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        requesterLabel: 'reverse request',
        createdAt: consent.createdAt,
        deadlineAt: consent.deadlineAt,
        daemonGeneration: value.daemonGeneration,
      },
    })).toBe(false);
    expect(await approve(value, consent.approvalId)).toBe(true);
    expect(await approve(value, consent.approvalId)).toBe(false);
    expect((await getAttendedConsent(db, consent.approvalId))?.state)
      .toBe(REMOTE_DESKTOP_CONSENT_STATE.APPROVED);
  });

  it('records deny and node cancellation as terminal outcomes without revoking link authority', async () => {
    const deniedFixture = await fixture();
    const denied = await createPending(deniedFixture);
    expect(await recordAttendedConsentNodeMessage(db, {
      executionServerId: deniedFixture.serverId,
      daemonGeneration: deniedFixture.daemonGeneration,
      message: {
        type: REMOTE_DESKTOP_CONSENT_MSG.RESULT,
        approvalId: denied.consent.approvalId,
        decision: REMOTE_DESKTOP_CONSENT_DECISION.DENIED,
        daemonGeneration: deniedFixture.daemonGeneration,
      },
    })).toBe(true);
    await expect(consumeApprovedAttendedConsent(
      db,
      consumeInput(deniedFixture, denied.consent.approvalId),
    )).rejects.toMatchObject({ code: REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR.NOT_APPROVED });

    const cancelledFixture = await fixture();
    const cancelled = await createPending(cancelledFixture);
    expect(await recordAttendedConsentNodeMessage(db, {
      executionServerId: cancelledFixture.serverId,
      daemonGeneration: cancelledFixture.daemonGeneration,
      message: {
        type: REMOTE_DESKTOP_CONSENT_MSG.CANCEL,
        approvalId: cancelled.consent.approvalId,
        reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.PROTECTED_DESKTOP,
      },
    })).toBe(true);
    expect(await getAttendedConsent(db, cancelled.consent.approvalId)).toMatchObject({
      state: REMOTE_DESKTOP_CONSENT_STATE.CANCELLED,
      nodeCancelReason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.PROTECTED_DESKTOP,
      cancelTrigger: REMOTE_DESKTOP_CONSENT_CANCEL_TRIGGER.NODE_CANCEL,
    });
  });

  it('turns a failed authenticated-channel dispatch into durable fail-closed cancellation', async () => {
    const value = await fixture();
    const approvalId = `approval-${randomUUID()}`;
    await expect(createPending(value, {
      approvalId,
      dispatch: () => false,
    })).rejects.toMatchObject({ code: REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR.DISPATCH_FAILED });
    expect(await getAttendedConsent(db, approvalId)).toMatchObject({
      state: REMOTE_DESKTOP_CONSENT_STATE.CANCELLED,
      cancelReason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LOCAL_UI_FAILED,
      cancelTrigger: REMOTE_DESKTOP_CONSENT_CANCEL_TRIGGER.CALLER_CANCEL,
    });
  });
});

describe('atomic one-session consumption and cancellation seams', () => {
  it('consumes once, permits only exact-session resume and rejects a second session', async () => {
    const value = await fixture();
    const { consent } = await createPending(value);
    await approve(value, consent.approvalId);
    const firstInput = consumeInput(value, consent.approvalId);

    expect(await consumeApprovedAttendedConsent(db, firstInput)).toMatchObject({
      consumedSessionId: firstInput.sessionId,
      exactSessionResume: false,
    });
    expect(await consumeApprovedAttendedConsent(db, firstInput)).toMatchObject({
      consumedSessionId: firstInput.sessionId,
      exactSessionResume: true,
    });
    await expect(consumeApprovedAttendedConsent(db, {
      ...firstInput,
      sessionId: `session-${randomUUID()}`,
    })).rejects.toMatchObject({ code: REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR.ALREADY_CONSUMED });
  });

  it('serializes concurrent consumers so only one new session wins', async () => {
    const value = await fixture();
    const { consent } = await createPending(value);
    await approve(value, consent.approvalId);
    const results = await Promise.allSettled([
      consumeApprovedAttendedConsent(db, consumeInput(value, consent.approvalId)),
      consumeApprovedAttendedConsent(db, consumeInput(value, consent.approvalId)),
    ]);
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
  });

  it.each([
    ['host', (input: ConsumeAttendedConsentInput) => ({ ...input, hostId: `host-${randomUUID()}` })],
    ['mode', (input: ConsumeAttendedConsentInput) => ({ ...input, mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW })],
    ['endpoint generation', (input: ConsumeAttendedConsentInput) => ({ ...input, endpointGeneration: input.endpointGeneration + 1 })],
    ['daemon generation', (input: ConsumeAttendedConsentInput) => ({ ...input, daemonGeneration: input.daemonGeneration + 1 })],
    ['browser', (input: ConsumeAttendedConsentInput) => ({ ...input, browserKeyHash: 'b'.repeat(64) })],
  ])('fails closed on wrong %s binding', async (_name, mutate) => {
    const value = await fixture();
    const { consent } = await createPending(value);
    await approve(value, consent.approvalId);
    await expect(consumeApprovedAttendedConsent(
      db,
      mutate(consumeInput(value, consent.approvalId)),
    )).rejects.toMatchObject({ code: REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR.BINDING_MISMATCH });
    expect((await getAttendedConsent(db, consent.approvalId))?.consumedAt).toBeNull();
  });

  it('cancels approved-but-unconsumed work on browser disconnect before consumption', async () => {
    const value = await fixture();
    const { consent } = await createPending(value);
    await approve(value, consent.approvalId);
    const dispatch = vi.fn(() => true);
    const cancelled = await remoteDesktopConsentCancellation.browserDisconnected(
      db,
      value.browserKeyHash,
      dispatch,
    );
    expect(cancelled.map((entry) => entry.approvalId)).toContain(consent.approvalId);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      executionServerId: value.serverId,
      daemonGeneration: value.daemonGeneration,
      message: {
        type: REMOTE_DESKTOP_CONSENT_MSG.CANCEL,
        approvalId: consent.approvalId,
        reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.BROWSER_DISCONNECTED,
      },
    }));
    await expect(consumeApprovedAttendedConsent(
      db,
      consumeInput(value, consent.approvalId),
    )).rejects.toMatchObject({ code: REMOTE_DESKTOP_CONSENT_COORDINATOR_ERROR.NOT_APPROVED });
  });

  it('exposes exact link-revoke, local-Stop and endpoint-replacement cancellation seams', async () => {
    const link = await fixture();
    const local = await fixture();
    const endpoint = await fixture();
    const linkConsent = await createPending(link);
    const localConsent = await createPending(local);
    const endpointConsent = await createPending(endpoint);

    await remoteDesktopConsentCancellation.linkRevoked(db, link.actorAuditId);
    await remoteDesktopConsentCancellation.localStop(db, local.hostId);
    await remoteDesktopConsentCancellation.endpointReplaced(
      db,
      endpoint.serverId,
      endpoint.daemonGeneration,
    );

    expect(await getAttendedConsent(db, linkConsent.consent.approvalId)).toMatchObject({
      cancelReason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LINK_REVOKED,
      cancelTrigger: REMOTE_DESKTOP_CONSENT_CANCEL_TRIGGER.LINK_REVOKE,
    });
    expect(await getAttendedConsent(db, localConsent.consent.approvalId)).toMatchObject({
      cancelReason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.LOCAL_UI_FAILED,
      cancelTrigger: REMOTE_DESKTOP_CONSENT_CANCEL_TRIGGER.LOCAL_STOP,
    });
    expect(await getAttendedConsent(db, endpointConsent.consent.approvalId)).toMatchObject({
      cancelReason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.DAEMON_GENERATION_CHANGED,
      cancelTrigger: REMOTE_DESKTOP_CONSENT_CANCEL_TRIGGER.ENDPOINT_REPLACED,
    });
  });

  it('sweeps expired pending/approved rows exactly once and emits bounded CANCEL', async () => {
    const value = await fixture();
    const { consent } = await createPending(value);
    await approve(value, consent.approvalId);
    await db.execute(
      `UPDATE remote_desktop_attended_consents
       SET deadline_at = created_at + 1
       WHERE approval_id = $1`,
      [consent.approvalId],
    );
    const dispatch = vi.fn(() => true);
    const first = await sweepTimedOutAttendedConsents(db, { dispatch });
    const second = await sweepTimedOutAttendedConsents(db, { dispatch });
    expect(first.map((entry) => entry.approvalId)).toContain(consent.approvalId);
    expect(second.map((entry) => entry.approvalId)).not.toContain(consent.approvalId);
    expect(await getAttendedConsent(db, consent.approvalId)).toMatchObject({
      state: REMOTE_DESKTOP_CONSENT_STATE.TIMED_OUT,
      cancelReason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.TIMEOUT,
      cancelTrigger: REMOTE_DESKTOP_CONSENT_CANCEL_TRIGGER.TIMEOUT,
    });
  });

  it('keeps the generic cancel API bounded and rejects malformed selectors', async () => {
    await expect(cancelAttendedConsents(db, {
      selector: { approvalId: 'short' },
      reason: REMOTE_DESKTOP_CONSENT_CANCEL_REASON.BROWSER_DISCONNECTED,
      trigger: REMOTE_DESKTOP_CONSENT_CANCEL_TRIGGER.BROWSER_DISCONNECT,
    })).rejects.toBeInstanceOf(RemoteDesktopConsentCoordinatorError);
  });
});

describe('schema secret boundary', () => {
  it('stores no raw bearer/password/private-key/capability or negotiation columns', async () => {
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'remote_desktop_attended_consents'`,
    );
    const names = columns.map((row) => row.column_name);
    expect(names).toContain('browser_key_hash');
    expect(names.join('|')).not.toMatch(
      /raw|token|password|private|capability|prepare|sdp|ice|offer/i,
    );
  });
});
