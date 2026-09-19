import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { DirectFileTransferRouter } from '../src/ws/direct-file-transfer-router.js';
import { createTurnIceServerAuthority } from '../src/ws/turn-credentials.js';
import logger from '../src/util/logger.js';
import { getCounter, resetMetricsForTests, snapshotCounters } from '../src/util/metrics.js';
import {
  DIRECT_FILE_TRANSFER_DIRECTION,
  DIRECT_FILE_TRANSFER_ERROR,
  DIRECT_FILE_TRANSFER_ERROR_SCOPE,
  DIRECT_FILE_TRANSFER_LIMITS,
  DIRECT_FILE_TRANSFER_MSG,
  DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
  DIRECT_FILE_TRANSFER_TERMINAL_STATE,
  DIRECT_FILE_TRANSFER_OPERATION_STATE,
  validateDirectFileTransferServerMessage,
  type DirectFileTransferLeaseReady,
} from '../../shared/direct-file-transfer.js';

const SERVER_ID = 'server-1';
const TAB_A = 'browser-tab-a1';
const LEASE_REQUEST = 'lease-request-1';
const OPERATION_ID = 'operation-id-1';
const ATTEMPT_ID = 'attempt-id-1';
const ATTEMPT_REQUEST = 'attempt-request-1';

function fixture() {
  const browserA = {} as WebSocket;
  const browserB = {} as WebSocket;
  const browserMessages = new Map<WebSocket, Array<Record<string, unknown>>>();
  const daemonMessages: Array<Record<string, unknown>> = [];
  let generation = 3;
  let available = true;
  let supported = true;
  const sendDaemon = vi.fn((message: Record<string, unknown>, expectedGeneration: number) => {
    if (!available || expectedGeneration !== generation) return false;
    daemonMessages.push(message);
    return true;
  });
  const router = new DirectFileTransferRouter({
    serverId: () => SERVER_ID,
    daemonAvailable: () => available,
    daemonSupportsDirect: () => supported,
    daemonGeneration: () => generation,
    resumeTicketSigningKey: () => 'test-direct-file-transfer-resume-signing-key',
    sendDaemon,
    sendBrowser: (socket, message) => {
      const rows = browserMessages.get(socket) ?? [];
      rows.push(message);
      browserMessages.set(socket, rows);
    },
  });
  return {
    router,
    browserA,
    browserB,
    daemonMessages,
    sendDaemon,
    messages: (socket: WebSocket) => browserMessages.get(socket) ?? [],
    setGeneration: (value: number) => { generation = value; router.setDaemonGeneration(value); },
    setAvailable: (value: boolean) => { available = value; },
    setSupported: (value: boolean) => { supported = value; },
  };
}

function leaseInit(requestId = LEASE_REQUEST, browserTabId = TAB_A) {
  return {
    type: DIRECT_FILE_TRANSFER_MSG.LEASE_INIT,
    protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
    requestId,
    serverId: SERVER_ID,
    browserTabId,
  } as const;
}

function readyLease(f: ReturnType<typeof fixture>, socket = f.browserA, userId = 'user-a') {
  expect(f.router.handleBrowser(socket, userId, leaseInit())).toBe(true);
  const prepare = f.daemonMessages.at(-1)!;
  expect(prepare).toMatchObject({
    type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARE,
    requestId: LEASE_REQUEST,
    serverId: SERVER_ID,
    browserTabId: TAB_A,
  });
  expect(f.messages(socket)).toHaveLength(0);
  f.router.handleDaemon({
    type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED,
    protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
    requestId: LEASE_REQUEST,
    serverId: SERVER_ID,
    browserTabId: TAB_A,
    leaseId: prepare.leaseId,
    leaseGeneration: prepare.leaseGeneration,
    daemonGeneration: prepare.daemonGeneration,
  }, prepare.daemonGeneration as number);
  const ready = f.messages(socket).at(-1) as DirectFileTransferLeaseReady;
  expect(ready).toMatchObject({ type: DIRECT_FILE_TRANSFER_MSG.LEASE_READY, requestId: LEASE_REQUEST });
  return ready;
}

function uploadInit(lease: DirectFileTransferLeaseReady, overrides: Record<string, unknown> = {}) {
  return {
    type: DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT,
    protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
    serverId: SERVER_ID,
    browserTabId: TAB_A,
    leaseId: lease.leaseId,
    leaseGeneration: lease.leaseGeneration,
    daemonGeneration: lease.daemonGeneration,
    requestId: ATTEMPT_REQUEST,
    attemptId: ATTEMPT_ID,
    attempt: 1,
    direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
    operationId: OPERATION_ID,
    clientUploadId: OPERATION_ID,
    filename: 'large.bin',
    size: 9,
    sessionName: 'deck_project_brain',
    ...overrides,
  };
}

function downloadInit(lease: DirectFileTransferLeaseReady, overrides: Record<string, unknown> = {}) {
  return {
    type: DIRECT_FILE_TRANSFER_MSG.OPERATION_INIT,
    protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
    serverId: SERVER_ID,
    browserTabId: TAB_A,
    leaseId: lease.leaseId,
    leaseGeneration: lease.leaseGeneration,
    daemonGeneration: lease.daemonGeneration,
    requestId: ATTEMPT_REQUEST,
    attemptId: ATTEMPT_ID,
    attempt: 1,
    direction: DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD,
    operationId: OPERATION_ID,
    clientDownloadId: OPERATION_ID,
    previewHandle: 'preview-handle-1',
    sessionName: 'deck_project_brain',
    ...overrides,
  };
}

describe('DirectFileTransferRouter v2', () => {
  beforeEach(() => {
    resetMetricsForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });


  it('P4: a not_found status reaches the browser as a VALID frame', () => {
    // daemon -> router -> shared validator, end to end. `not_found` discharges
    // an attempt, so the daemon settles its obligation on it -- but its STATUS
    // is NOT terminal-shaped: isServerStatus forbids idleExpiresAt on it.
    // Reusing the discharge predicate as a wire-shape predicate made the router
    // append that field, the frame failed validation, and the browser dropped
    // it in parseMatchingControl before it could reach its own non-retryable
    // OPERATION_NOT_FOUND branch -- leaving recovery to a 15s deadline.
    const f = fixture();
    const lease = readyLease(f);
    expect(f.router.handleBrowser(f.browserA, 'user-a', uploadInit(lease))).toBe(true);
    const authorized = f.daemonMessages.at(-1)!;

    const before = f.messages(f.browserA).length;
    f.router.handleDaemon({
      type: DIRECT_FILE_TRANSFER_MSG.STATUS,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      daemonGeneration: lease.daemonGeneration,
      requestId: authorized.requestId,
      attemptId: ATTEMPT_ID,
      attempt: 1,
      direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
      operationId: OPERATION_ID,
      state: DIRECT_FILE_TRANSFER_OPERATION_STATE.NOT_FOUND,
    }, lease.daemonGeneration);

    const routed = f.messages(f.browserA).slice(before)
      .find((message) => message.type === DIRECT_FILE_TRANSFER_MSG.STATUS);
    expect(routed, 'the not_found status must reach the browser at all').toBeDefined();
    expect(routed, 'a not_found STATUS may not carry idleExpiresAt').not.toHaveProperty('idleExpiresAt');
    expect(
      validateDirectFileTransferServerMessage(routed).ok,
      'the browser drops anything the shared validator rejects',
    ).toBe(true);
  });

  it('P4: not_found releases its attempt route, so the next operation is still authorized', () => {
    // Wire validity is not lifecycle discharge. The router released an attempt
    // only for TERMINAL / ERROR / committed|canceled|failed -- an INLINE copy
    // of the terminal-SHAPE set deciding a lifecycle question. `not_found` ends
    // an operation, but its route survived until the two-hour authority timer,
    // counting against MAX_ACTIVE_CHANNELS_PER_LEASE the whole time. The
    // previous regression checked only that the frame validated, so it could
    // not see this.
    const f = fixture();
    const lease = readyLease(f);
    const cap = DIRECT_FILE_TRANSFER_LIMITS.MAX_ACTIVE_CHANNELS_PER_LEASE;

    for (let i = 0; i < cap; i += 1) {
      expect(
        f.router.handleBrowser(f.browserA, 'user-a', uploadInit(lease, {
          requestId: `not-found-attempt-request-${i}`,
          attemptId: `not-found-attempt-${i}`,
          operationId: `not-found-operation-${i}`,
          clientUploadId: `not-found-operation-${i}`,
        })),
        `operation ${i} must be authorized`,
      ).toBe(true);
      const authorized = f.daemonMessages.at(-1)!;
      f.router.handleDaemon({
        type: DIRECT_FILE_TRANSFER_MSG.STATUS,
        protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
        serverId: SERVER_ID,
        browserTabId: TAB_A,
        leaseId: lease.leaseId,
        leaseGeneration: lease.leaseGeneration,
        daemonGeneration: lease.daemonGeneration,
        requestId: authorized.requestId,
        attemptId: `not-found-attempt-${i}`,
        attempt: 1,
        direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
        operationId: `not-found-operation-${i}`,
        state: DIRECT_FILE_TRANSFER_OPERATION_STATE.NOT_FOUND,
      }, lease.daemonGeneration);
    }

    // Every route must have been released; a further distinct operation is
    // admitted rather than refused as too_many_channels.
    const before = f.messages(f.browserA).length;
    expect(
      f.router.handleBrowser(f.browserA, 'user-a', uploadInit(lease, {
        requestId: 'after-not-found-request',
        attemptId: 'after-not-found-attempt',
        operationId: 'after-not-found-operation',
        clientUploadId: 'after-not-found-operation',
      })),
      'four ended operations must not keep the lease at its channel ceiling',
    ).toBe(true);
    expect(
      f.messages(f.browserA).slice(before).filter((message) => (
        message.type === DIRECT_FILE_TRANSFER_MSG.ERROR
      )),
      'no too_many_channels refusal',
    ).toEqual([]);
  });

  it('P4: a committed status still carries idleExpiresAt and still validates', () => {
    // The boundary assertion the consumer-impact checklist requires: narrowing
    // the shape predicate must not stop terminal-SHAPED outcomes from carrying
    // the field the validator requires of them.
    const f = fixture();
    const lease = readyLease(f);
    expect(f.router.handleBrowser(f.browserA, 'user-a', uploadInit(lease))).toBe(true);
    const authorized = f.daemonMessages.at(-1)!;

    const before = f.messages(f.browserA).length;
    f.router.handleDaemon({
      type: DIRECT_FILE_TRANSFER_MSG.STATUS,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      daemonGeneration: lease.daemonGeneration,
      requestId: authorized.requestId,
      attemptId: ATTEMPT_ID,
      attempt: 1,
      direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
      operationId: OPERATION_ID,
      state: DIRECT_FILE_TRANSFER_TERMINAL_STATE.CANCELED,
    }, lease.daemonGeneration);

    const routed = f.messages(f.browserA).slice(before)
      .find((message) => message.type === DIRECT_FILE_TRANSFER_MSG.STATUS);
    expect(routed).toBeDefined();
    expect(routed, 'a terminal-shaped STATUS must carry it').toHaveProperty('idleExpiresAt');
    expect(validateDirectFileTransferServerMessage(routed).ok).toBe(true);
  });

  it('P4: routes a lost-lease notice to exactly its own lease socket', () => {
    const f = fixture();
    const leaseA = readyLease(f, f.browserA, 'user-a');

    // A second live lease on another socket. LEASE_LOST carries no requestId,
    // so nothing but the lease id can decide where it goes; cross-talk here
    // would tear down a lease whose peer is perfectly healthy.
    expect(f.router.handleBrowser(f.browserB, 'user-b', {
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_INIT,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: 'lease-request-2',
      serverId: SERVER_ID,
      browserTabId: 'browser-tab-b1',
    })).toBe(true);
    const prepareB = f.daemonMessages.at(-1)!;
    f.router.handleDaemon({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: 'lease-request-2',
      serverId: SERVER_ID,
      browserTabId: 'browser-tab-b1',
      leaseId: prepareB.leaseId,
      leaseGeneration: prepareB.leaseGeneration,
      daemonGeneration: prepareB.daemonGeneration,
    }, prepareB.daemonGeneration as number);

    const beforeB = f.messages(f.browserB).length;
    expect(f.router.handleDaemon({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_LOST,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: leaseA.leaseId,
      leaseGeneration: leaseA.leaseGeneration,
      daemonGeneration: leaseA.daemonGeneration,
    }, leaseA.daemonGeneration)).toBe(true);

    expect(f.messages(f.browserA).at(-1)).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_LOST,
      leaseId: leaseA.leaseId,
      leaseGeneration: leaseA.leaseGeneration,
      daemonGeneration: leaseA.daemonGeneration,
    });
    expect(f.messages(f.browserB), 'another lease must not be disturbed').toHaveLength(beforeB);
  });

  it('P4: drops a lost-lease notice for an unknown or superseded lease', () => {
    const f = fixture();
    const leaseA = readyLease(f, f.browserA, 'user-a');
    const before = f.messages(f.browserA).length;
    const lost = (overrides: Record<string, unknown>) => ({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_LOST,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: leaseA.leaseId,
      leaseGeneration: leaseA.leaseGeneration,
      daemonGeneration: leaseA.daemonGeneration,
      ...overrides,
    });
    f.router.handleDaemon(lost({ leaseId: 'lease-that-never-existed' }), leaseA.daemonGeneration);
    f.router.handleDaemon(lost({ browserTabId: 'browser-tab-b1' }), leaseA.daemonGeneration);
    f.router.handleDaemon(lost({ leaseGeneration: leaseA.leaseGeneration + 1 }), leaseA.daemonGeneration);
    // A notice stamped by a daemon generation this Server pod has moved past
    // must not reach the browser either.
    f.router.handleDaemon(lost({}), leaseA.daemonGeneration - 1);
    expect(f.messages(f.browserA)).toHaveLength(before);
  });

  it('waits for daemon LEASE_PREPARED before ready or lease-scoped signaling', () => {
    const f = fixture();
    expect(f.router.handleBrowser(f.browserA, 'user-a', leaseInit())).toBe(true);
    const prepare = f.daemonMessages[0]!;
    expect(prepare.type).toBe(DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARE);
    expect(f.messages(f.browserA)).toEqual([]);

    const earlyOffer = {
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: 'offer-request-1',
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: prepare.leaseId,
      leaseGeneration: prepare.leaseGeneration,
      daemonGeneration: prepare.daemonGeneration,
      sdp: 'v=0\r\no=browser 1 1 IN IP4 127.0.0.1',
    };
    f.router.handleBrowser(f.browserA, 'user-a', earlyOffer);
    expect(f.daemonMessages).toHaveLength(1);
    // A signal from the bound lease before PREPARE completes is not an
    // authority forgery. It must be retryable so the browser reaches the
    // guaranteed retry-then-HTTP fallback instead of terminally stalling.
    expect(f.messages(f.browserA).at(-1)).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      scope: DIRECT_FILE_TRANSFER_ERROR_SCOPE.LEASE,
      error: DIRECT_FILE_TRANSFER_ERROR.STALE_DAEMON_GENERATION,
      retryable: true,
    });

    f.router.handleDaemon({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: LEASE_REQUEST,
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: prepare.leaseId,
      leaseGeneration: prepare.leaseGeneration,
      daemonGeneration: prepare.daemonGeneration,
    }, 3);
    const ready = f.messages(f.browserA).at(-1) as DirectFileTransferLeaseReady;
    expect(ready.type).toBe(DIRECT_FILE_TRANSFER_MSG.LEASE_READY);

    f.router.handleBrowser(f.browserA, 'user-a', earlyOffer);
    expect(f.daemonMessages).toHaveLength(2);
    expect(f.daemonMessages.at(-1)).toMatchObject({ type: DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER, sdp: earlyOffer.sdp });
    expect(f.daemonMessages.at(-1)).not.toHaveProperty('authority');
  });

  it('re-prepares an existing Server route before declaring it reusable', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const f = fixture();
    const original = readyLease(f);

    // Browser socket loss extends only the Server route. The daemon does not
    // observe that event and will independently evict its peer at the original
    // idle deadline. A later LEASE_INIT must therefore prove the daemon peer
    // exists again instead of returning an immediately-stale LEASE_READY.
    vi.advanceTimersByTime(DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS - 1_000);
    f.router.dropSocket(f.browserA);
    vi.advanceTimersByTime(2_000);

    const daemonCount = f.daemonMessages.length;
    f.router.handleBrowser(f.browserB, 'user-a', leaseInit('lease-request-reuse-1'));
    expect(f.daemonMessages).toHaveLength(daemonCount + 1);
    const prepare = f.daemonMessages.at(-1)!;
    expect(prepare).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARE,
      requestId: 'lease-request-reuse-1',
      leaseId: original.leaseId,
    });
    expect(f.messages(f.browserB)).toEqual([]);

    f.router.handleDaemon({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: 'lease-request-reuse-1',
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: prepare.leaseId,
      leaseGeneration: prepare.leaseGeneration,
      daemonGeneration: prepare.daemonGeneration,
    }, prepare.daemonGeneration as number);
    expect(f.messages(f.browserB).at(-1)).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_READY,
      requestId: 'lease-request-reuse-1',
      leaseId: original.leaseId,
    });
  });

  it('routes a daemon missing-lease signal error back to the exact browser offer', () => {
    const f = fixture();
    const lease = readyLease(f);
    const offer = {
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: 'missing-lease-offer-1',
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      daemonGeneration: lease.daemonGeneration,
      sdp: 'v=0\r\no=browser 1 1 IN IP4 127.0.0.1',
    } as const;
    f.router.handleBrowser(f.browserA, 'user-a', offer);

    f.router.handleDaemon({
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      scope: DIRECT_FILE_TRANSFER_ERROR_SCOPE.LEASE,
      requestId: offer.requestId,
      error: DIRECT_FILE_TRANSFER_ERROR.LEASE_EXPIRED,
      retryable: true,
    }, lease.daemonGeneration);

    expect(f.messages(f.browserA).at(-1)).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      scope: DIRECT_FILE_TRANSFER_ERROR_SCOPE.LEASE,
      requestId: offer.requestId,
      error: DIRECT_FILE_TRANSFER_ERROR.LEASE_EXPIRED,
      retryable: true,
    });
  });

  it('renews an attached prepared lease on Server even when the browser timer is suspended', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const f = fixture();
    const lease = readyLease(f);
    const daemonCount = f.daemonMessages.length;
    const browserCount = f.messages(f.browserA).length;

    vi.advanceTimersByTime(
      DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS
        - DIRECT_FILE_TRANSFER_LIMITS.LEASE_RENEW_LEAD_MS + 1,
    );

    expect(f.daemonMessages).toHaveLength(daemonCount + 1);
    const renewal = f.daemonMessages.at(-1)!;
    expect(renewal).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARE,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      daemonGeneration: lease.daemonGeneration,
    });
    expect(renewal.requestId).not.toBe(LEASE_REQUEST);
    expect(f.messages(f.browserA)).toHaveLength(browserCount);

    f.router.handleDaemon({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: renewal.requestId,
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: renewal.leaseId,
      leaseGeneration: renewal.leaseGeneration,
      daemonGeneration: renewal.daemonGeneration,
    }, renewal.daemonGeneration as number);

    // Server-owned keepalive refreshes daemon state only. The browser gets a
    // rotated ticket on its next normal INIT/REBIND, not an unsolicited frame.
    expect(f.messages(f.browserA)).toHaveLength(browserCount);
  });

  it('stops Server-owned renewal as soon as the browser socket is gone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const f = fixture();
    readyLease(f);
    const daemonCount = f.daemonMessages.length;

    f.router.dropSocket(f.browserA);
    vi.advanceTimersByTime(
      DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS
        - DIRECT_FILE_TRANSFER_LIMITS.LEASE_RENEW_LEAD_MS + 1,
    );

    expect(f.daemonMessages).toHaveLength(daemonCount);
  });

  it('marks matching lease signaling during daemon rebind as retryable without forwarding it', () => {
    const f = fixture();
    const lease = readyLease(f);
    f.setGeneration((lease.daemonGeneration ?? 0) + 1);
    const staleOffer = {
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: 'offer-during-rebind',
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      daemonGeneration: lease.daemonGeneration,
      sdp: 'v=0\r\no=browser 1 1 IN IP4 127.0.0.1',
    } as const;
    const daemonCount = f.daemonMessages.length;
    f.router.handleBrowser(f.browserA, 'user-a', staleOffer);

    expect(f.daemonMessages).toHaveLength(daemonCount);
    expect(f.messages(f.browserA).at(-1)).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      scope: DIRECT_FILE_TRANSFER_ERROR_SCOPE.LEASE,
      requestId: staleOffer.requestId,
      error: DIRECT_FILE_TRANSFER_ERROR.STALE_DAEMON_GENERATION,
      retryable: true,
    });
  });

  it('relays validated lease answer only to the bound browser socket', () => {
    const f = fixture();
    const lease = readyLease(f);
    f.router.handleDaemon({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_ANSWER,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: 'answer-request-1',
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      daemonGeneration: lease.daemonGeneration,
      sdp: 'v=0\r\no=daemon 1 1 IN IP4 127.0.0.1',
    }, lease.daemonGeneration);
    expect(f.messages(f.browserA).at(-1)).toMatchObject({ type: DIRECT_FILE_TRANSFER_MSG.LEASE_ANSWER });
    expect(f.messages(f.browserB)).toEqual([]);
  });

  it('maps a stable upload operation to a fresh exact authority without carrying bytes', () => {
    const f = fixture();
    const lease = readyLease(f);
    f.router.handleBrowser(f.browserA, 'user-a', uploadInit(lease, {
      destinationDirectory: 'C:\\Users\\admin\\Desktop',
    }));
    const prepare = f.daemonMessages.at(-1)!;
    const authorized = f.messages(f.browserA).at(-1)!;
    expect(prepare).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.PREPARE,
      direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
      operationId: OPERATION_ID,
      clientUploadId: OPERATION_ID,
      destinationDirectory: 'C:\\Users\\admin\\Desktop',
    });
    expect(authorized).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.AUTHORIZED,
      authority: expect.any(String),
      destinationDirectory: 'C:\\Users\\admin\\Desktop',
    });
    for (const frame of [prepare, authorized]) {
      expect(frame).not.toHaveProperty('chunk');
      expect(frame).not.toHaveProperty('content');
      expect(frame).not.toHaveProperty('bytes');
    }

    f.router.handleBrowser(f.browserB, 'user-a', uploadInit(lease));
    expect(f.messages(f.browserB).at(-1)).toMatchObject({ error: DIRECT_FILE_TRANSFER_ERROR.INVALID_AUTHORITY });
  });

  it('emits bounded redacted lifecycle telemetry for cancel and retry exhaustion', () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const f = fixture();
    const lease = readyLease(f);
    f.router.handleBrowser(f.browserA, 'user-a', uploadInit(lease));
    const authorized = f.messages(f.browserA).at(-1)!;
    expect(getCounter('direct_file_transfer_lease_total', { event: 'created' })).toBe(1);
    expect(getCounter('direct_file_transfer_lease_total', { event: 'ready' })).toBe(1);
    expect(getCounter('direct_file_transfer_attempt_total', {
      event: 'authorized', direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD, attempt: '1',
    })).toBe(1);

    f.router.handleBrowser(f.browserA, 'user-a', {
      type: DIRECT_FILE_TRANSFER_MSG.CANCEL,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      daemonGeneration: lease.daemonGeneration,
      requestId: ATTEMPT_REQUEST,
      attemptId: ATTEMPT_ID,
      attempt: 1,
      direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
      operationId: OPERATION_ID,
      authority: authorized.authority as string,
      reason: DIRECT_FILE_TRANSFER_ERROR.CANCELED,
    });
    expect(getCounter('direct_file_transfer_attempt_total', {
      event: 'canceled', direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD, attempt: '1',
    })).toBe(1);
    expect(getCounter('direct_file_transfer_control_relay_total', {
      direction: 'browser_to_daemon', family: 'cancel',
    })).toBe(1);

    const exhausted = uploadInit(lease, {
      requestId: 'attempt-request-2',
      attemptId: 'attempt-id-2',
      attempt: DIRECT_FILE_TRANSFER_LIMITS.MAX_ATTEMPTS,
      operationId: 'operation-id-2',
      clientUploadId: 'operation-id-2',
    });
    f.router.handleBrowser(f.browserA, 'user-a', exhausted);
    f.router.handleDaemon({
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      scope: DIRECT_FILE_TRANSFER_ERROR_SCOPE.OPERATION,
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      daemonGeneration: lease.daemonGeneration,
      requestId: 'attempt-request-2',
      attemptId: 'attempt-id-2',
      attempt: DIRECT_FILE_TRANSFER_LIMITS.MAX_ATTEMPTS,
      direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
      operationId: 'operation-id-2',
      error: DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED,
      retryable: true,
    }, lease.daemonGeneration);
    expect(getCounter('direct_file_transfer_attempt_total', {
      event: 'retry_exhausted',
      direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
      attempt: String(DIRECT_FILE_TRANSFER_LIMITS.MAX_ATTEMPTS),
    })).toBe(1);

    const metricKeys = Object.keys(snapshotCounters()).join('\n');
    expect(metricKeys).not.toContain(lease.leaseId);
    expect(metricKeys).not.toContain(OPERATION_ID);
    expect(metricKeys).not.toContain(ATTEMPT_REQUEST);
    expect(metricKeys).not.toContain('large.bin');
    expect(metricKeys).not.toContain('deck_project_brain');
    expect(metricKeys).not.toContain(authorized.authority as string);

    const logContexts = infoSpy.mock.calls.map(([context]) => context);
    const logText = JSON.stringify(logContexts);
    expect(logContexts).toContainEqual({ event: 'created' });
    expect(logText).not.toContain(lease.leaseId);
    expect(logText).not.toContain(OPERATION_ID);
    expect(logText).not.toContain(ATTEMPT_REQUEST);
    expect(logText).not.toContain('large.bin');
    expect(logText).not.toContain('deck_project_brain');
    expect(logText).not.toContain(authorized.authority as string);
  });

  it('does not arm or churn an idle expiry timer while an attempt is active', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const f = fixture();
    const lease = readyLease(f);
    f.router.handleBrowser(f.browserA, 'user-a', uploadInit(lease));
    const callsWhileActive = timeoutSpy.mock.calls.length;
    // The only remaining timer is the authority deadline; the five-minute
    // lease idle deadline must not keep rescheduling while this attempt lives.
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS * 3);

    expect(timeoutSpy).toHaveBeenCalledTimes(callsWhileActive);
    expect(vi.getTimerCount()).toBe(1);
    expect(f.messages(f.browserA).at(-1)).toMatchObject({ type: DIRECT_FILE_TRANSFER_MSG.AUTHORIZED });
  });

  it('keeps init/rebind idle deadlines fixed across delayed peer preparation and lease signaling', () => {
    vi.useFakeTimers();
    const startedAt = new Date('2025-01-01T00:00:00.000Z').valueOf();
    vi.setSystemTime(startedAt);
    const f = fixture();
    f.router.handleBrowser(f.browserA, 'user-a', leaseInit());
    const initialPrepare = f.daemonMessages.at(-1)!;

    vi.advanceTimersByTime(DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS - 60_000);
    f.router.handleDaemon({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: LEASE_REQUEST,
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: initialPrepare.leaseId,
      leaseGeneration: initialPrepare.leaseGeneration,
      daemonGeneration: initialPrepare.daemonGeneration,
    }, initialPrepare.daemonGeneration as number);
    const ready = f.messages(f.browserA).at(-1) as DirectFileTransferLeaseReady;
    expect(ready.idleExpiresAt).toBe(startedAt + DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS);

    const offer = {
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: 'offer-request-1',
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: ready.leaseId,
      leaseGeneration: ready.leaseGeneration,
      daemonGeneration: ready.daemonGeneration,
      sdp: 'v=0\r\no=browser 1 1 IN IP4 127.0.0.1',
    } as const;
    f.router.handleBrowser(f.browserA, 'user-a', offer);
    f.router.handleDaemon({
      ...offer,
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_ANSWER,
      sdp: 'v=0\r\no=daemon 1 1 IN IP4 127.0.0.1',
    }, ready.daemonGeneration);

    // Lease-only SDP exchange is not activity. At the original deadline the
    // lease expires instead of acquiring another five-minute window.
    vi.advanceTimersByTime(60_000);
    const daemonCountBeforeNewInit = f.daemonMessages.length;
    f.router.handleBrowser(f.browserA, 'user-a', leaseInit('lease-request-2'));
    expect(f.daemonMessages).toHaveLength(daemonCountBeforeNewInit + 1);
    expect(f.daemonMessages.at(-1)).toMatchObject({ type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARE });

    f.router.handleBrowser(f.browserB, 'user-a', {
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_REBIND,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: 'rebind-request-4',
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: ready.leaseId,
      leaseGeneration: ready.leaseGeneration,
      resumeTicket: ready.resumeTicket,
    });
    const rebindPrepare = f.daemonMessages.at(-1)!;
    const rebindAt = Date.now();
    vi.advanceTimersByTime(DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS - 60_000);
    f.router.handleDaemon({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: 'rebind-request-4',
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: ready.leaseId,
      leaseGeneration: ready.leaseGeneration,
      daemonGeneration: rebindPrepare.daemonGeneration,
    }, rebindPrepare.daemonGeneration as number);
    expect(f.messages(f.browserB).at(-1)).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_REBOUND,
      idleExpiresAt: rebindAt + DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS,
    });
  });

  it('restarts a fresh authoritative five-minute idle window after the last terminal attempt', () => {
    vi.useFakeTimers();
    const startedAt = new Date('2025-01-01T00:00:00.000Z').valueOf();
    vi.setSystemTime(startedAt);
    const f = fixture();
    const lease = readyLease(f);
    expect(lease.idleExpiresAt).toBe(startedAt + DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS);

    f.router.handleBrowser(f.browserA, 'user-a', uploadInit(lease));
    vi.advanceTimersByTime(DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS - 1_000);
    f.router.handleDaemon({
      type: DIRECT_FILE_TRANSFER_MSG.TERMINAL,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      daemonGeneration: lease.daemonGeneration,
      requestId: ATTEMPT_REQUEST,
      attemptId: ATTEMPT_ID,
      attempt: 1,
      direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
      operationId: OPERATION_ID,
      state: DIRECT_FILE_TRANSFER_TERMINAL_STATE.FAILED,
    }, lease.daemonGeneration);
    expect(f.messages(f.browserA).at(-1)).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.TERMINAL,
      idleExpiresAt: startedAt
        + (DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS - 1_000)
        + DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS,
    });

    const daemonCountBeforeReuse = f.daemonMessages.length;
    // This crosses the old authorization-time deadline. The terminal must
    // instead have armed a fresh 5-minute idle window at its own timestamp.
    vi.advanceTimersByTime(DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS - 1);
    f.router.handleBrowser(f.browserA, 'user-a', leaseInit('lease-request-2'));

    // The attached socket also drives one Server-owned three-minute renewal
    // while this post-terminal idle window remains open.
    expect(f.daemonMessages).toHaveLength(daemonCountBeforeReuse + 2);
    const reusePrepare = f.daemonMessages.at(-1)!;
    expect(reusePrepare).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARE,
      requestId: 'lease-request-2',
      leaseId: lease.leaseId,
    });
    f.router.handleDaemon({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: 'lease-request-2',
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: reusePrepare.leaseId,
      leaseGeneration: reusePrepare.leaseGeneration,
      daemonGeneration: reusePrepare.daemonGeneration,
    }, reusePrepare.daemonGeneration as number);
    expect(f.messages(f.browserA).at(-1)).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_READY,
      requestId: 'lease-request-2',
      idleExpiresAt: Date.now() + DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS,
    });
  });

  it('propagates a fresh idle deadline on daemon error when its later terminal is dropped', () => {
    vi.useFakeTimers();
    const startedAt = new Date('2025-01-01T00:00:00.000Z').valueOf();
    vi.setSystemTime(startedAt);
    const f = fixture();
    const lease = readyLease(f);
    f.router.handleBrowser(f.browserA, 'user-a', uploadInit(lease));

    vi.advanceTimersByTime(DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS - 1_000);
    const error = {
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      scope: DIRECT_FILE_TRANSFER_ERROR_SCOPE.OPERATION,
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      daemonGeneration: lease.daemonGeneration,
      requestId: ATTEMPT_REQUEST,
      attemptId: ATTEMPT_ID,
      attempt: 1,
      direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
      operationId: OPERATION_ID,
      error: DIRECT_FILE_TRANSFER_ERROR.CONNECTION_FAILED,
      retryable: true,
    } as const;
    f.router.handleDaemon(error, lease.daemonGeneration);
    const deadline = startedAt
      + (DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS - 1_000)
      + DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS;
    const browserError = f.messages(f.browserA).at(-1)!;
    expect(browserError).toMatchObject({
      ...error,
      idleExpiresAt: deadline,
    });
    expect(validateDirectFileTransferServerMessage(browserError).ok).toBe(true);

    const messageCountAfterError = f.messages(f.browserA).length;
    f.router.handleDaemon({
      ...error,
      type: DIRECT_FILE_TRANSFER_MSG.TERMINAL,
      state: DIRECT_FILE_TRANSFER_TERMINAL_STATE.FAILED,
    }, lease.daemonGeneration);
    // ERROR terminally removes the route. A late daemon TERMINAL is inert, so
    // the error frame must have carried the only fresh authoritative deadline.
    expect(f.messages(f.browserA)).toHaveLength(messageCountAfterError);

    const daemonCountBeforeReuse = f.daemonMessages.length;
    vi.advanceTimersByTime(DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS - 1);
    f.router.handleBrowser(f.browserA, 'user-a', leaseInit('lease-request-2'));
    expect(f.daemonMessages).toHaveLength(daemonCountBeforeReuse + 2);
    const reusePrepare = f.daemonMessages.at(-1)!;
    expect(reusePrepare).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARE,
      requestId: 'lease-request-2',
      leaseId: lease.leaseId,
    });
    f.router.handleDaemon({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: 'lease-request-2',
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: reusePrepare.leaseId,
      leaseGeneration: reusePrepare.leaseGeneration,
      daemonGeneration: reusePrepare.daemonGeneration,
    }, reusePrepare.daemonGeneration as number);
    expect(f.messages(f.browserA).at(-1)).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_READY,
      requestId: 'lease-request-2',
    });
  });

  it('synthesizes a canceled terminal with the fresh lease deadline before a late daemon acknowledgement', () => {
    vi.useFakeTimers();
    const startedAt = new Date('2025-01-01T00:00:00.000Z').valueOf();
    vi.setSystemTime(startedAt);
    const f = fixture();
    const lease = readyLease(f);
    f.router.handleBrowser(f.browserA, 'user-a', uploadInit(lease));
    const authorized = f.messages(f.browserA).at(-1)!;

    vi.advanceTimersByTime(DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS - 1_000);
    const cancel = {
      type: DIRECT_FILE_TRANSFER_MSG.CANCEL,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      daemonGeneration: lease.daemonGeneration,
      requestId: ATTEMPT_REQUEST,
      attemptId: ATTEMPT_ID,
      attempt: 1,
      direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
      operationId: OPERATION_ID,
      authority: authorized.authority as string,
      reason: DIRECT_FILE_TRANSFER_ERROR.CANCELED,
    } as const;
    f.router.handleBrowser(f.browserA, 'user-a', cancel);
    const deadline = startedAt
      + (DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS - 1_000)
      + DIRECT_FILE_TRANSFER_LIMITS.LEASE_IDLE_TTL_MS;
    expect(f.daemonMessages.at(-1)).toMatchObject(cancel);
    const browserTerminal = f.messages(f.browserA).at(-1)!;
    expect(browserTerminal).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.TERMINAL,
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      daemonGeneration: lease.daemonGeneration,
      requestId: ATTEMPT_REQUEST,
      attemptId: ATTEMPT_ID,
      attempt: 1,
      direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
      operationId: OPERATION_ID,
      state: DIRECT_FILE_TRANSFER_TERMINAL_STATE.CANCELED,
      idleExpiresAt: deadline,
    });
    expect(validateDirectFileTransferServerMessage(browserTerminal).ok).toBe(true);

    const messageCountAfterCancel = f.messages(f.browserA).length;
    f.router.handleDaemon({
      ...cancel,
      type: DIRECT_FILE_TRANSFER_MSG.TERMINAL,
      state: DIRECT_FILE_TRANSFER_TERMINAL_STATE.CANCELED,
    }, lease.daemonGeneration);
    expect(f.messages(f.browserA)).toHaveLength(messageCountAfterCancel);
  });

  it('accepts a surviving active attempt terminal on its immutable generation after lease rebind', () => {
    const f = fixture();
    const lease = readyLease(f);
    f.router.handleBrowser(f.browserA, 'user-a', uploadInit(lease));
    const originalGeneration = lease.daemonGeneration;

    f.setGeneration(originalGeneration + 1);
    f.router.handleBrowser(f.browserA, 'user-a', {
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_REBIND,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: 'rebind-request-active-1',
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      resumeTicket: lease.resumeTicket,
    });
    const prepare = f.daemonMessages.at(-1)!;
    expect(prepare).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARE,
      daemonGeneration: originalGeneration + 1,
    });
    f.router.handleDaemon({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: 'rebind-request-active-1',
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      daemonGeneration: originalGeneration + 1,
    }, originalGeneration + 1);

    f.router.handleDaemon({
      type: DIRECT_FILE_TRANSFER_MSG.TERMINAL,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      // This is the generation in which the still-open data authority was
      // minted, not the newly rebound control generation.
      daemonGeneration: originalGeneration,
      requestId: ATTEMPT_REQUEST,
      attemptId: ATTEMPT_ID,
      attempt: 1,
      direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
      operationId: OPERATION_ID,
      state: DIRECT_FILE_TRANSFER_TERMINAL_STATE.FAILED,
    }, originalGeneration + 1);
    expect(f.messages(f.browserA).at(-1)).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.TERMINAL,
      daemonGeneration: originalGeneration,
      state: DIRECT_FILE_TRANSFER_TERMINAL_STATE.FAILED,
      idleExpiresAt: expect.any(Number),
    });
  });

  it('accepts an old-generation active terminal while the lease rebind is still pending', () => {
    const f = fixture();
    const lease = readyLease(f);
    f.router.handleBrowser(f.browserA, 'user-a', uploadInit(lease));
    const originalGeneration = lease.daemonGeneration;
    f.setGeneration(originalGeneration + 1);

    f.router.handleDaemon({
      type: DIRECT_FILE_TRANSFER_MSG.TERMINAL,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      daemonGeneration: originalGeneration,
      requestId: ATTEMPT_REQUEST,
      attemptId: ATTEMPT_ID,
      attempt: 1,
      direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
      operationId: OPERATION_ID,
      state: DIRECT_FILE_TRANSFER_TERMINAL_STATE.FAILED,
    }, originalGeneration + 1);
    expect(f.messages(f.browserA).at(-1)).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.TERMINAL,
      daemonGeneration: originalGeneration,
      state: DIRECT_FILE_TRANSFER_TERMINAL_STATE.FAILED,
      idleExpiresAt: expect.any(Number),
    });
  });

  it('relays cancel for an active pre-rebind authority over the current control generation', () => {
    const f = fixture();
    const lease = readyLease(f);
    f.router.handleBrowser(f.browserA, 'user-a', uploadInit(lease));
    const authorized = f.messages(f.browserA).at(-1)!;
    const originalGeneration = lease.daemonGeneration;

    f.setGeneration(originalGeneration + 1);

    const cancel = {
      type: DIRECT_FILE_TRANSFER_MSG.CANCEL,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      daemonGeneration: originalGeneration,
      requestId: ATTEMPT_REQUEST,
      attemptId: ATTEMPT_ID,
      attempt: 1,
      direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
      operationId: OPERATION_ID,
      authority: authorized.authority as string,
      reason: DIRECT_FILE_TRANSFER_ERROR.CANCELED,
    } as const;
    // New operation/status work is gated while REBINDING, but a stop must
    // still settle this already-authorized old-generation data attempt.
    f.router.handleBrowser(f.browserA, 'user-a', cancel);
    expect(f.daemonMessages.at(-1)).toMatchObject(cancel);
    expect(f.sendDaemon.mock.calls.at(-1)?.[1]).toBe(originalGeneration + 1);
    expect(f.messages(f.browserA).at(-1)).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.TERMINAL,
      daemonGeneration: originalGeneration,
      state: DIRECT_FILE_TRANSFER_TERMINAL_STATE.CANCELED,
      idleExpiresAt: expect.any(Number),
    });
  });

  it('accepts handle-only download init and rejects a browser path before daemon dispatch', () => {
    const f = fixture();
    const lease = readyLease(f);
    f.router.handleBrowser(f.browserA, 'user-a', downloadInit(lease));
    expect(f.daemonMessages.at(-1)).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.PREPARE,
      direction: DIRECT_FILE_TRANSFER_DIRECTION.DOWNLOAD,
      previewHandle: 'preview-handle-1',
    });
    expect(f.daemonMessages.at(-1)).not.toHaveProperty('path');

    const before = f.daemonMessages.length;
    f.router.handleBrowser(f.browserA, 'user-a', downloadInit(lease, {
      requestId: 'attempt-request-2',
      attemptId: 'attempt-id-2',
      path: '/etc/shadow',
    }));
    expect(f.daemonMessages).toHaveLength(before);
    expect(f.messages(f.browserA).at(-1)).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      scope: DIRECT_FILE_TRANSFER_ERROR_SCOPE.LEASE,
      error: DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST,
    });
  });

  it('rebinds a signed ticket only for the exact user/tab/server/lease binding', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const first = fixture();
    const lease = readyLease(first);
    first.router.dropSocket(first.browserA);
    vi.advanceTimersByTime(1_000);

    const recovered = fixture();
    recovered.router.handleBrowser(recovered.browserA, 'user-a', {
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_REBIND,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: 'rebind-request-1',
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      resumeTicket: lease.resumeTicket,
    });
    // The persistent signing key makes rebind work after a fresh pod-local map.
    const rebind = recovered.daemonMessages.at(-1)!;
    expect(rebind).toMatchObject({ type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARE, leaseId: lease.leaseId });
    recovered.router.handleDaemon({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: 'rebind-request-1',
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      daemonGeneration: 3,
    }, 3);
    const rebound = recovered.messages(recovered.browserA).at(-1) as DirectFileTransferLeaseReady;
    expect(rebound).toMatchObject({ type: DIRECT_FILE_TRANSFER_MSG.LEASE_REBOUND });
    expect(rebound.resumeTicket).not.toBe(lease.resumeTicket);
    expect(rebound.expiresAt).toBeGreaterThan(lease.expiresAt);

    const forged = fixture();
    forged.router.handleBrowser(forged.browserA, 'other-user', {
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_REBIND,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: 'rebind-request-2',
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      resumeTicket: lease.resumeTicket,
    });
    expect(forged.daemonMessages).toEqual([]);
    expect(forged.messages(forged.browserA).at(-1)).toMatchObject({ error: DIRECT_FILE_TRANSFER_ERROR.LEASE_REBIND_FAILED });
  });

  it('keeps a retained route renewable after its original resume ticket expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const f = fixture();
    const original = readyLease(f);

    const renew = (requestId: string, ready: DirectFileTransferLeaseReady) => {
      f.router.handleBrowser(f.browserA, 'user-a', {
        type: DIRECT_FILE_TRANSFER_MSG.LEASE_REBIND,
        protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
        requestId,
        serverId: SERVER_ID,
        browserTabId: TAB_A,
        leaseId: ready.leaseId,
        leaseGeneration: ready.leaseGeneration,
        resumeTicket: ready.resumeTicket,
      });
      const prepare = f.daemonMessages.at(-1)!;
      expect(prepare).toMatchObject({ type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARE, requestId });
      f.router.handleDaemon({
        type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED,
        protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
        requestId,
        serverId: SERVER_ID,
        browserTabId: TAB_A,
        leaseId: ready.leaseId,
        leaseGeneration: ready.leaseGeneration,
        daemonGeneration: prepare.daemonGeneration,
      }, prepare.daemonGeneration as number);
      return f.messages(f.browserA).at(-1) as DirectFileTransferLeaseReady;
    };

    vi.advanceTimersByTime(4 * 60 * 1000);
    const first = renew('rebind-request-1', original);
    vi.advanceTimersByTime(4 * 60 * 1000);
    const second = renew('rebind-request-2', first);
    vi.advanceTimersByTime(4 * 60 * 1000);

    // The original ten-minute ticket is now stale, but the last rotated ticket
    // still authorizes this exact live route and advances it another window.
    const beforeExpired = f.daemonMessages.length;
    f.router.handleBrowser(f.browserA, 'user-a', {
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_REBIND,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: 'expired-ticket-request',
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: original.leaseId,
      leaseGeneration: original.leaseGeneration,
      resumeTicket: original.resumeTicket,
    });
    expect(f.daemonMessages).toHaveLength(beforeExpired);
    expect(f.messages(f.browserA).at(-1)).toMatchObject({ error: DIRECT_FILE_TRANSFER_ERROR.LEASE_REBIND_FAILED });

    const third = renew('rebind-request-3', second);
    expect(third.resumeTicket).not.toBe(second.resumeTicket);
    expect(third.expiresAt).toBeGreaterThan(second.expiresAt);
  });

  it('forwards an exact status query after Server-memory-loss rebind to the daemon ledger', () => {
    const first = fixture();
    const lease = readyLease(first);
    first.router.dropSocket(first.browserA);

    const recovered = fixture();
    recovered.router.handleBrowser(recovered.browserA, 'user-a', {
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_REBIND,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: 'rebind-request-3',
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      resumeTicket: lease.resumeTicket,
    });
    const prepare = recovered.daemonMessages.at(-1)!;
    recovered.router.handleDaemon({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: 'rebind-request-3',
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      daemonGeneration: prepare.daemonGeneration,
    }, prepare.daemonGeneration as number);
    expect(recovered.messages(recovered.browserA).at(-1)).toMatchObject({ type: DIRECT_FILE_TRANSFER_MSG.LEASE_REBOUND });

    const query = {
      type: DIRECT_FILE_TRANSFER_MSG.STATUS_QUERY,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: lease.leaseId,
      leaseGeneration: lease.leaseGeneration,
      daemonGeneration: prepare.daemonGeneration,
      requestId: ATTEMPT_REQUEST,
      attemptId: ATTEMPT_ID,
      attempt: 1,
      direction: DIRECT_FILE_TRANSFER_DIRECTION.UPLOAD,
      operationId: OPERATION_ID,
    } as const;
    recovered.router.handleBrowser(recovered.browserA, 'user-a', query);
    expect(recovered.daemonMessages.at(-1)).toEqual(query);
    expect(getCounter('direct_file_transfer_status_recovery_total', { event: 'queried' })).toBe(1);

    recovered.router.handleDaemon({
      ...query,
      type: DIRECT_FILE_TRANSFER_MSG.STATUS,
      state: 'committed',
    }, prepare.daemonGeneration as number);
    expect(recovered.messages(recovered.browserA).at(-1)).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.STATUS,
      state: 'committed',
      operationId: OPERATION_ID,
      idleExpiresAt: expect.any(Number),
    });
    expect(getCounter('direct_file_transfer_status_recovery_total', { event: 'responded' })).toBe(1);
    expect(getCounter('direct_file_transfer_control_relay_total', {
      direction: 'daemon_to_browser', family: 'status',
    })).toBe(1);
  });

  it('blocks new operation authorization after daemon generation changes until rebind', () => {
    const f = fixture();
    const lease = readyLease(f);
    f.setGeneration(4);
    f.router.handleBrowser(f.browserA, 'user-a', uploadInit(lease, { daemonGeneration: 4 }));
    expect(f.messages(f.browserA).at(-1)).toMatchObject({
      type: DIRECT_FILE_TRANSFER_MSG.ERROR,
      scope: DIRECT_FILE_TRANSFER_ERROR_SCOPE.OPERATION,
      error: DIRECT_FILE_TRANSFER_ERROR.STALE_DAEMON_GENERATION,
      retryable: true,
    });
  });

  it('rejects unknown and legacy direct frames without any daemon dispatch', () => {
    const f = fixture();
    f.router.handleBrowser(f.browserA, 'user-a', {
      type: 'direct_file.init',
      requestId: 'legacy-request-1',
    });
    f.router.handleBrowser(f.browserA, 'user-a', {
      ...leaseInit('lease-request-2'),
      iceServers: ['stun:attacker.invalid'],
    });
    expect(f.daemonMessages).toEqual([]);
    expect(f.messages(f.browserA)).toHaveLength(2);
    expect(f.messages(f.browserA).every((message) => message.error === DIRECT_FILE_TRANSFER_ERROR.INVALID_REQUEST)).toBe(true);
  });

  it('does not grant a lease when the direct v2 capability set is unavailable', () => {
    const f = fixture();
    f.setSupported(false);
    f.router.handleBrowser(f.browserA, 'user-a', leaseInit());
    expect(f.daemonMessages).toEqual([]);
    expect(f.messages(f.browserA).at(-1)).toMatchObject({
      error: DIRECT_FILE_TRANSFER_ERROR.CAPABILITY_UNAVAILABLE,
      retryable: true,
    });
  });
});

/**
 * One production-shaped environment, both surfaces. im.zhinet.work publishes
 * relay UDP 49201-50200; the runtime rejected that span and served STUN only,
 * so neither feature could ever gather a relay candidate. The secret is a
 * correct-LENGTH placeholder: range validation never needs the real one.
 */
const PRODUCTION_TURN_ENV = {
  TURN_ENABLED: 'true',
  TURN_HOST: 'im.zhinet.work',
  TURN_PORT: '3480',
  TURN_EXTERNAL_IP: '43.248.99.95',
  TURN_SHARED_SECRET: 'x'.repeat(64),
  TURN_CREDENTIAL_TTL_SECONDS: '86400',
  TURN_RELAY_MIN_PORT: '49201',
  TURN_RELAY_MAX_PORT: '50200',
} as const;

const relayUrls = (servers: readonly unknown[]): string[] => servers
  .filter((entry): entry is { urls: string[] } => typeof entry === 'object' && entry !== null)
  .flatMap((entry) => entry.urls)
  .filter((url) => url.startsWith('turn:') || url.startsWith('turns:'));

describe('a relay-required browser receives real relay material', () => {
  it('hands the lease UDP + TCP TURN from the production relay range', () => {
    const browser = {} as WebSocket;
    const messages: Array<Record<string, unknown>> = [];
    const daemonMessages: Array<Record<string, unknown>> = [];
    const router = new DirectFileTransferRouter({
      serverId: () => SERVER_ID,
      daemonAvailable: () => true,
      daemonSupportsDirect: () => true,
      daemonGeneration: () => 3,
      resumeTicketSigningKey: () => 'test-direct-file-transfer-resume-signing-key',
      // The REAL authority, exactly as bridge.ts wires it.
      iceServers: (userId) => createTurnIceServerAuthority(userId, { env: PRODUCTION_TURN_ENV }),
      sendDaemon: (message) => { daemonMessages.push(message as Record<string, unknown>); return true; },
      sendBrowser: (_socket, message) => { messages.push(message as Record<string, unknown>); },
    });

    expect(router.handleBrowser(browser, 'user-mobile', leaseInit())).toBe(true);
    const prepare = daemonMessages.at(-1)!;
    router.handleDaemon({
      type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED,
      protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
      requestId: LEASE_REQUEST,
      serverId: SERVER_ID,
      browserTabId: TAB_A,
      leaseId: prepare.leaseId,
      leaseGeneration: prepare.leaseGeneration,
      daemonGeneration: prepare.daemonGeneration,
    }, prepare.daemonGeneration as number);
    const ready = messages.find((message) => message.type === DIRECT_FILE_TRANSFER_MSG.LEASE_READY);
    expect(ready, 'the lease never became ready').toBeDefined();
    expect(relayUrls(ready!.iceServers as unknown[])).toEqual([
      'turn:im.zhinet.work:3480?transport=udp',
      'turn:im.zhinet.work:3480?transport=tcp',
    ]);
    expect(JSON.stringify(messages)).not.toContain(PRODUCTION_TURN_ENV.TURN_SHARED_SECRET);
  });
});
