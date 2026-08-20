import { describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import type { Database } from '../src/db/client.js';
import type { ControlledMachineAccessRow } from '../src/share/machine-access.js';
import { RemoteDesktopRouter } from '../src/ws/remote-desktop-router.js';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_AUDIT_EVENT,
  REMOTE_DESKTOP_CAPABILITY,
  REMOTE_DESKTOP_DATA_MSG,
  REMOTE_DESKTOP_ERROR,
  REMOTE_DESKTOP_LIMITS,
  REMOTE_DESKTOP_MSG,
  REMOTE_DESKTOP_MODE_REASON,
  REMOTE_DESKTOP_PROTOCOL_VERSION,
  REMOTE_DESKTOP_STATE,
  REMOTE_DESKTOP_TERMINAL_REASON,
} from '../../shared/remote-desktop.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';

const requestId = 'request_12345678';
const start = {
  type: REMOTE_DESKTOP_MSG.START,
  protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
  requestId,
} as const;

function validAccess(now = Date.now()): ControlledMachineAccessRow {
  return {
    id: 'controlled-win',
    user_id: 'owner-user',
    ref_name: 'winbox',
    display_name: 'Windows box',
    status: 'online',
    last_heartbeat_at: now,
    exec_enabled: true,
    os: 'win',
    revoked_at: null,
    access_role: 'owner',
    access_expires_at: null,
    controlled_capabilities: [REMOTE_DESKTOP_CAPABILITY],
    node_role: NODE_ROLE.CONTROLLED,
  };
}

/**
 * A normal Windows daemon serving remote control. None of the controlled-node
 * columns describe it: `exec_enabled` is the controlled exec switch and is
 * false on daemon rows created before its default flipped, `os` is only
 * recorded at controlled-node enrolment, and `controlled_capabilities` is
 * stored for controlled nodes alone.
 */
function daemonHostAccess(now = Date.now()): ControlledMachineAccessRow {
  return {
    ...validAccess(now),
    id: 'daemon-win',
    node_role: NODE_ROLE.FULL,
    exec_enabled: false,
    os: null,
    controlled_capabilities: null,
  };
}

function fixture(options: {
  access?: ControlledMachineAccessRow | null;
  resolveAccess?: (userId: string) => Promise<ControlledMachineAccessRow | null>;
  credentialExpiresAt?: number;
} = {}) {
  const browserA = {} as WebSocket;
  const browserB = {} as WebSocket;
  const browserMessages = new Map<WebSocket, Array<Record<string, unknown>>>();
  const daemonMessages: Array<Record<string, unknown>> = [];
  const audits: Array<{ event: string; fields: Readonly<Record<string, string | number | boolean>> }> = [];
  let generation = 7;
  let available = true;
  let supported = true;
  let featureEnabled = true;
  let access = options.access === undefined ? validAccess() : options.access;
  let resolver = options.resolveAccess ?? (async () => access);
  const router = new RemoteDesktopRouter({
    serverId: () => 'controlled-win',
    database: () => ({}) as Database,
    daemonAvailable: () => available,
    daemonSupportsRemoteDesktop: () => supported,
    featureEnabled: () => featureEnabled,
    daemonGeneration: () => generation,
    iceServers: () => ({
      iceServers: [
        'stun:stun.example.test:3478',
        { urls: ['turn:turn.example.test:3478?transport=udp'], username: 'temporary-user', credential: 'temporary-password' },
      ],
      ...(options.credentialExpiresAt === undefined ? {} : { credentialExpiresAt: options.credentialExpiresAt }),
    }),
    sendDaemon: vi.fn((message, expectedGeneration) => {
      if (!available || expectedGeneration !== generation) return false;
      daemonMessages.push(message);
      return true;
    }),
    sendBrowser: (socket, message) => {
      const messages = browserMessages.get(socket) ?? [];
      messages.push(message);
      browserMessages.set(socket, messages);
    },
    resolveAccess: async (_db, userId) => resolver(userId),
    audit: (event, fields) => { audits.push({ event, fields }); },
  });
  return {
    router,
    browserA,
    browserB,
    daemonMessages,
    audits,
    messages: (socket: WebSocket) => browserMessages.get(socket) ?? [],
    setAccess: (value: ControlledMachineAccessRow | null) => { access = value; },
    setResolver: (value: (userId: string) => Promise<ControlledMachineAccessRow | null>) => { resolver = value; },
    setAvailable: (value: boolean) => { available = value; },
    setSupported: (value: boolean) => { supported = value; },
    setFeatureEnabled: (value: boolean) => { featureEnabled = value; },
    setGeneration: (value: number) => { generation = value; router.setDaemonGeneration(value); },
  };
}

async function authorize(
  f: ReturnType<typeof fixture>,
  socket = f.browserA,
  userId = 'owner-user',
  scopedRequestId = requestId,
) {
  await f.router.handleBrowser(socket, userId, { ...start, requestId: scopedRequestId });
  const authority = f.messages(socket).at(-1)!;
  expect(authority).toMatchObject({
    type: REMOTE_DESKTOP_MSG.AUTHORIZED,
    requestId: scopedRequestId,
    daemonGeneration: 7,
    mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
    inputEpoch: 1,
  });
  return {
    requestId: authority.requestId as string,
    sessionId: authority.sessionId as string,
    capability: authority.capability as string,
  };
}

describe('RemoteDesktopRouter', () => {
  it('never forwards media or input data envelopes over the application WebSocket', async () => {
    const f = fixture();
    const authority = await authorize(f);
    const daemonCount = f.daemonMessages.length;

    expect(await f.router.handleBrowser(f.browserA, 'owner-user', {
      type: REMOTE_DESKTOP_DATA_MSG.KEYBOARD,
      ...authority,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      sequence: 1,
      layoutRevision: 1,
      inputEpoch: 1,
      kind: 'key_down',
      code: 'KeyA',
      key: 'a',
      repeat: false,
    })).toBe(true);
    expect(f.daemonMessages).toHaveLength(daemonCount);
    expect(f.messages(f.browserA).at(-1)).toMatchObject({
      type: REMOTE_DESKTOP_MSG.ERROR,
      error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST,
    });
  });

  it('keeps new starts behind the operator feature flag', async () => {
    const f = fixture();
    f.setFeatureEnabled(false);
    await f.router.handleBrowser(f.browserA, 'owner-user', start);
    expect(f.daemonMessages).toHaveLength(0);
    expect(f.messages(f.browserA)[0]).toMatchObject({
      type: REMOTE_DESKTOP_MSG.ERROR,
      error: REMOTE_DESKTOP_ERROR.CAPABILITY_UNAVAILABLE,
      retryable: false,
    });
  });

  it('bounds start attempts before authorization work and audit emission', async () => {
    const f = fixture();
    f.setFeatureEnabled(false);
    for (let index = 0; index <= REMOTE_DESKTOP_LIMITS.MAX_STARTS_PER_MINUTE; index++) {
      await f.router.handleBrowser(f.browserA, 'owner-user', {
        ...start,
        requestId: `request_rate_${String(index).padStart(4, '0')}`,
      });
    }
    expect(f.audits.filter((row) => row.event === REMOTE_DESKTOP_AUDIT_EVENT.REQUESTED))
      .toHaveLength(REMOTE_DESKTOP_LIMITS.MAX_STARTS_PER_MINUTE);
    expect(f.messages(f.browserA).at(-1)).toMatchObject({
      type: REMOTE_DESKTOP_MSG.ERROR,
      error: REMOTE_DESKTOP_ERROR.SESSION_LIMIT,
      retryable: true,
    });
  });

  it('caps audit output even when a worker churns bounded status metadata', async () => {
    const f = fixture();
    const authority = await authorize(f);
    for (let index = 0; index < REMOTE_DESKTOP_LIMITS.MAX_AUDITS_PER_MACHINE_PER_MINUTE + 20; index++) {
      f.router.handleDaemon({
        type: REMOTE_DESKTOP_MSG.STATUS,
        ...authority,
        mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        inputEpoch: 1,
        state: REMOTE_DESKTOP_STATE.DIRECT,
        route: 'direct',
        selectedDisplayId: index % 2 === 0 ? 'display_12345678' : 'display_87654321',
        layoutRevision: index + 1,
        inputEnabled: false,
      }, 7);
    }
    expect(f.audits).toHaveLength(REMOTE_DESKTOP_LIMITS.MAX_AUDITS_PER_MACHINE_PER_MINUTE);
  });

  it('forwards bounded reconnect intent only to the worker and audits aggregate bytes', async () => {
    const f = fixture();
    await f.router.handleBrowser(f.browserA, 'owner-user', {
      ...start,
      reconnectAttempt: 2,
    });
    const authority = f.messages(f.browserA).at(-1)!;
    expect(authority).not.toHaveProperty('reconnectAttempt');
    expect(f.daemonMessages[0]).toMatchObject({
      type: REMOTE_DESKTOP_MSG.PREPARE,
      reconnectAttempt: 2,
    });
    expect(f.audits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: REMOTE_DESKTOP_AUDIT_EVENT.RECONNECTING,
        fields: expect.objectContaining({ reconnectAttempt: 2 }),
      }),
    ]));
    await f.router.handleBrowser(f.browserA, 'owner-user', {
      type: REMOTE_DESKTOP_MSG.OFFER,
      requestId: authority.requestId,
      sessionId: authority.sessionId,
      capability: authority.capability,
      sdp: 'v=0\r\na=x-imcodes-secret-sdp-marker',
    });

    await f.router.handleBrowser(f.browserA, 'owner-user', {
      type: REMOTE_DESKTOP_MSG.STOP,
      requestId: authority.requestId,
      sessionId: authority.sessionId,
      capability: authority.capability,
      aggregateBytesReceived: 98_765,
    });
    expect(f.daemonMessages.at(-1)).toEqual({
      type: REMOTE_DESKTOP_MSG.STOP,
      requestId: authority.requestId,
      sessionId: authority.sessionId,
      capability: authority.capability,
    });
    expect(f.audits.at(-1)).toMatchObject({
      event: REMOTE_DESKTOP_AUDIT_EVENT.STOPPED,
      fields: expect.objectContaining({
        controllerRequested: true,
        aggregateBytesReceived: 98_765,
      }),
    });
    const serializedAudits = JSON.stringify(f.audits);
    expect(serializedAudits).not.toContain(authority.capability as string);
    expect(serializedAudits).not.toContain('x-imcodes-secret-sdp-marker');
    expect(serializedAudits).not.toContain('temporary-password');
    expect(serializedAudits).not.toContain('candidate:');
    expect(serializedAudits).not.toContain('KeyA');
  });

  it('permits one lease-revalidated ICE restart and rejects a second restart', async () => {
    const f = fixture();
    const authority = await authorize(f);
    const offer = {
      type: REMOTE_DESKTOP_MSG.OFFER,
      ...authority,
      sdp: 'v=0\r\na=ice-ufrag:first',
    } as const;
    await f.router.handleBrowser(f.browserA, 'owner-user', offer);
    expect(f.router.handleDaemon({
      type: REMOTE_DESKTOP_MSG.ANSWER,
      ...authority,
      sdp: 'v=0\r\na=ice-ufrag:answer-first',
    }, 7)).toBe(true);

    await f.router.handleBrowser(f.browserA, 'owner-user', {
      ...offer,
      sdp: 'v=0\r\na=ice-ufrag:restart-one',
    });
    expect(f.daemonMessages.at(-1)).toMatchObject({
      type: REMOTE_DESKTOP_MSG.OFFER,
      sdp: expect.stringContaining('restart-one'),
    });
    expect(f.audits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: REMOTE_DESKTOP_AUDIT_EVENT.RECONNECTING,
        fields: expect.objectContaining({ iceRestartAttempt: 1 }),
      }),
    ]));
    expect(f.router.handleDaemon({
      type: REMOTE_DESKTOP_MSG.ANSWER,
      ...authority,
      sdp: 'v=0\r\na=ice-ufrag:answer-restart',
    }, 7)).toBe(true);

    const daemonCount = f.daemonMessages.length;
    await f.router.handleBrowser(f.browserA, 'owner-user', {
      ...offer,
      sdp: 'v=0\r\na=ice-ufrag:restart-two',
    });
    expect(f.daemonMessages).toHaveLength(daemonCount);
    expect(f.messages(f.browserA).at(-1)).toMatchObject({
      type: REMOTE_DESKTOP_MSG.ERROR,
      error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST,
    });
  });

  it('records bounded signaling progress when negotiation fails', async () => {
    const f = fixture();
    const authority = await authorize(f);
    await f.router.handleBrowser(f.browserA, 'owner-user', {
      type: REMOTE_DESKTOP_MSG.OFFER,
      ...authority,
      sdp: 'v=0\r\na=ice-ufrag:diagnostic-offer',
    });
    await f.router.handleBrowser(f.browserA, 'owner-user', {
      type: REMOTE_DESKTOP_MSG.ICE,
      ...authority,
      candidate: 'candidate:browser-diagnostic',
      mid: '0',
    });
    expect(f.router.handleDaemon({
      type: REMOTE_DESKTOP_MSG.ANSWER,
      ...authority,
      sdp: 'v=0\r\na=ice-ufrag:diagnostic-answer',
    }, 7)).toBe(true);
    expect(f.router.handleDaemon({
      type: REMOTE_DESKTOP_MSG.ICE,
      ...authority,
      candidate: 'candidate:daemon-diagnostic',
      mid: '0',
    }, 7)).toBe(true);

    f.router.stopAll(REMOTE_DESKTOP_TERMINAL_REASON.NEGOTIATION_TIMEOUT);

    expect(f.audits.at(-1)).toMatchObject({
      event: REMOTE_DESKTOP_AUDIT_EVENT.FAILED,
      fields: expect.objectContaining({
        reason: REMOTE_DESKTOP_TERMINAL_REASON.NEGOTIATION_TIMEOUT,
        state: REMOTE_DESKTOP_STATE.CONNECTING,
        offerCount: 1,
        answerCount: 1,
        browserIceCandidates: 1,
        daemonIceCandidates: 1,
      }),
    });
    const serializedAudit = JSON.stringify(f.audits.at(-1));
    expect(serializedAudit).not.toContain('diagnostic-offer');
    expect(serializedAudit).not.toContain('diagnostic-answer');
    expect(serializedAudit).not.toContain('candidate:');
  });
  it('admits an exact Owner authority and singlecasts prepare/signaling/status', async () => {
    const f = fixture();
    const authority = await authorize(f);

    expect(f.daemonMessages[0]).toMatchObject({
      type: REMOTE_DESKTOP_MSG.PREPARE,
      requestId,
      sessionId: authority.sessionId,
      capability: authority.capability,
      iceServers: expect.arrayContaining([expect.stringContaining('stun:')]),
    });
    expect(f.messages(f.browserB)).toHaveLength(0);
    expect(authority.capability).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await f.router.handleBrowser(f.browserA, 'owner-user', {
      type: REMOTE_DESKTOP_MSG.OFFER,
      ...authority,
      sdp: 'v=0',
    });
    expect(f.daemonMessages.at(-1)).toMatchObject({ type: REMOTE_DESKTOP_MSG.OFFER, sdp: 'v=0' });

    expect(f.router.handleDaemon({
      type: REMOTE_DESKTOP_MSG.STATUS,
      ...authority,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      state: REMOTE_DESKTOP_STATE.DIRECT,
      route: 'direct',
      selectedDisplayId: 'display-primary',
      layoutRevision: 1,
      inputEnabled: false,
      seq: 41,
    }, 7)).toBe(true);
    expect(f.messages(f.browserA).at(-1)).toEqual({
      type: REMOTE_DESKTOP_MSG.STATUS,
      ...authority,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      state: REMOTE_DESKTOP_STATE.DIRECT,
      route: 'direct',
      selectedDisplayId: 'display-primary',
      layoutRevision: 1,
      inputEnabled: false,
      viewerCount: 1,
      controllerCount: 1,
    });
    expect(f.router.handleDaemon({
      type: REMOTE_DESKTOP_MSG.STATUS,
      ...authority,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      state: REMOTE_DESKTOP_STATE.SWITCHING_DISPLAY,
      route: 'direct',
      selectedDisplayId: 'display-secondary',
      layoutRevision: 2,
      inputEnabled: false,
      seq: 42,
    }, 7)).toBe(true);
    expect(f.router.sessionsForUser('owner-user')).toEqual([
      expect.objectContaining({
        selectedDisplayId: 'display-secondary',
        layoutRevision: 2,
      }),
    ]);
    expect(f.audits).toContainEqual(expect.objectContaining({
      event: REMOTE_DESKTOP_AUDIT_EVENT.DISPLAY_CHANGED,
      fields: expect.objectContaining({
        selectedDisplayId: 'display-secondary',
        layoutRevision: 2,
      }),
    }));
    expect(f.messages(f.browserB)).toHaveLength(0);
    expect(f.audits.flatMap((row) => Object.keys(row.fields))).not.toEqual(expect.arrayContaining([
      'capability', 'sdp', 'credential',
    ]));
  });

  it.each([
    ['viewer', { access_role: 'viewer' }, REMOTE_DESKTOP_ERROR.ACCESS_DENIED],
    ['disabled', { exec_enabled: false }, REMOTE_DESKTOP_ERROR.EXECUTION_DISABLED],
    ['non-Windows', { os: 'linux' }, REMOTE_DESKTOP_ERROR.UNSUPPORTED_PLATFORM],
    ['stale presence', { last_heartbeat_at: 1 }, REMOTE_DESKTOP_ERROR.DAEMON_OFFLINE],
    ['unknown capability', { controlled_capabilities: ['remote.desktop.windows.h264.v3'] }, REMOTE_DESKTOP_ERROR.CAPABILITY_UNAVAILABLE],
  ] as const)('rejects %s before signaling', async (_label, patch, error) => {
    const f = fixture({ access: { ...validAccess(), ...patch } as ControlledMachineAccessRow });
    await f.router.handleBrowser(f.browserA, 'owner-user', start);
    expect(f.daemonMessages).toHaveLength(0);
    expect(f.messages(f.browserA)[0]).toMatchObject({ type: REMOTE_DESKTOP_MSG.ERROR, error });
  });

  it('admits a normal Windows daemon whose controlled-node columns are unset', async () => {
    const f = fixture({ access: daemonHostAccess() });
    await f.router.handleBrowser(f.browserA, 'owner-user', start);
    expect(f.messages(f.browserA)[0]).toMatchObject({ type: REMOTE_DESKTOP_MSG.AUTHORIZED, requestId });
  });

  it.each([
    ['a revoked share', { access_role: 'viewer' }, REMOTE_DESKTOP_ERROR.ACCESS_DENIED],
    ['stale presence', { last_heartbeat_at: 1 }, REMOTE_DESKTOP_ERROR.DAEMON_OFFLINE],
  ] as const)('still rejects %s for a normal daemon', async (_label, patch, error) => {
    const f = fixture({ access: { ...daemonHostAccess(), ...patch } as ControlledMachineAccessRow });
    await f.router.handleBrowser(f.browserA, 'owner-user', start);
    expect(f.daemonMessages).toHaveLength(0);
    expect(f.messages(f.browserA)[0]).toMatchObject({ type: REMOTE_DESKTOP_MSG.ERROR, error });
  });

  it('keeps a daemon session alive across revalidation', async () => {
    // Admission and revalidation used to carry a copy each of these checks: the
    // daemon was admitted, its worker started, and the first revalidation tick
    // killed it with execution_disabled.
    const f = fixture({ access: daemonHostAccess() });
    await f.router.handleBrowser(f.browserA, 'owner-user', start);
    expect(f.messages(f.browserA)[0]).toMatchObject({ type: REMOTE_DESKTOP_MSG.AUTHORIZED });
    await f.router.revalidateUser('owner-user');
    expect(f.messages(f.browserA).some((message) => (
      message.type === REMOTE_DESKTOP_MSG.TERMINAL
    ))).toBe(false);
    expect(f.router.sessionsForUser('owner-user')).toHaveLength(1);
  });

  it('still terminates a controlled node whose exec switch is turned off', async () => {
    const f = fixture();
    await f.router.handleBrowser(f.browserA, 'owner-user', start);
    f.setAccess({ ...validAccess(), exec_enabled: false } as ControlledMachineAccessRow);
    await f.router.revalidateUser('owner-user');
    expect(f.messages(f.browserA).at(-1)).toMatchObject({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      reason: REMOTE_DESKTOP_TERMINAL_REASON.EXECUTION_DISABLED,
    });
  });

  it('does not let a controlled node borrow the daemon exemptions', async () => {
    const f = fixture({
      access: { ...validAccess(), exec_enabled: false, controlled_capabilities: null } as ControlledMachineAccessRow,
    });
    await f.router.handleBrowser(f.browserA, 'owner-user', start);
    expect(f.daemonMessages).toHaveLength(0);
    expect(f.messages(f.browserA)[0]).toMatchObject({
      type: REMOTE_DESKTOP_MSG.ERROR,
      error: REMOTE_DESKTOP_ERROR.EXECUTION_DISABLED,
    });
  });

  it('rejects a Participant grant that expires while admission is awaiting the DB', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_800_000_000_000);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const expiring = {
        ...validAccess(Date.now()),
        access_role: 'participant',
        access_expires_at: Date.now() + 100,
      } as ControlledMachineAccessRow;
      const f = fixture({ resolveAccess: async () => {
        await gate;
        return expiring;
      } });
      const admission = f.router.handleBrowser(f.browserA, 'participant-user', start);
      await Promise.resolve();
      vi.setSystemTime(Date.now() + 101);
      release();
      await admission;
      expect(f.daemonMessages).toHaveLength(0);
      expect(f.messages(f.browserA)[0]).toMatchObject({
        type: REMOTE_DESKTOP_MSG.ERROR,
        error: REMOTE_DESKTOP_ERROR.ACCESS_DENIED,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('admits concurrent Participants and keeps each view/control mode independent', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = fixture({
      resolveAccess: async () => {
        await gate;
        return { ...validAccess(), access_role: 'participant' };
      },
    });
    const first = f.router.handleBrowser(f.browserA, 'participant-user', start);
    const second = f.router.handleBrowser(f.browserB, 'participant-user', {
      ...start,
      requestId: 'request_abcdefgh',
    });
    release();
    await Promise.all([first, second]);

    expect(f.daemonMessages.filter((message) => message.type === REMOTE_DESKTOP_MSG.PREPARE)).toHaveLength(2);
    expect(f.messages(f.browserA)[0]).toMatchObject({ type: REMOTE_DESKTOP_MSG.AUTHORIZED });
    expect(f.messages(f.browserB)[0]).toMatchObject({ type: REMOTE_DESKTOP_MSG.AUTHORIZED });

    const authorityA = f.messages(f.browserA)[0];
    const authorityB = f.messages(f.browserB)[0];
    for (const [socket, userId, authority] of [
      [f.browserA, 'participant-user', authorityA],
      [f.browserB, 'participant-user', authorityB],
    ] as const) {
      await f.router.handleBrowser(socket, userId, {
        type: REMOTE_DESKTOP_MSG.MODE_SET,
        requestId: authority.requestId,
        sessionId: authority.sessionId,
        capability: authority.capability,
        mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      });
    }

    const controlStates = f.daemonMessages.filter((message) => (
      message.type === REMOTE_DESKTOP_MSG.MODE_STATE
      && message.mode === REMOTE_DESKTOP_ACCESS_MODE.CONTROL
    ));
    expect(controlStates).toHaveLength(2);
    expect(controlStates).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: authorityA.sessionId, inputEpoch: 1 }),
      expect.objectContaining({ sessionId: authorityB.sessionId, inputEpoch: 1 }),
    ]));
    expect(f.router.stats()).toMatchObject({ active: 2, controlling: 2 });

    for (const state of controlStates) expect(f.router.handleDaemon(state, 7)).toBe(true);
    expect(f.messages(f.browserA).at(-1)).toMatchObject({
      type: REMOTE_DESKTOP_MSG.MODE_STATE,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
    });
    expect(f.messages(f.browserB).at(-1)).toMatchObject({
      type: REMOTE_DESKTOP_MSG.MODE_STATE,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
    });

    for (const authority of [authorityA, authorityB]) {
      expect(f.router.handleDaemon({
        type: REMOTE_DESKTOP_MSG.STATUS,
        requestId: authority.requestId,
        sessionId: authority.sessionId,
        capability: authority.capability,
        mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        inputEpoch: 1,
        state: REMOTE_DESKTOP_STATE.DIRECT,
        route: 'direct',
        inputEnabled: true,
      }, 7)).toBe(true);
    }
    expect(f.messages(f.browserA).at(-1)).toMatchObject({ viewerCount: 2, controllerCount: 2 });
    expect(f.messages(f.browserB).at(-1)).toMatchObject({ viewerCount: 2, controllerCount: 2 });

    await f.router.handleBrowser(f.browserA, 'participant-user', {
      type: REMOTE_DESKTOP_MSG.MODE_SET,
      requestId: authorityA.requestId,
      sessionId: authorityA.sessionId,
      capability: authorityA.capability,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
    });
    const viewState = f.daemonMessages.at(-1)!;
    expect(viewState).toMatchObject({
      type: REMOTE_DESKTOP_MSG.MODE_STATE,
      sessionId: authorityA.sessionId,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 2,
      reason: REMOTE_DESKTOP_MODE_REASON.USER_SELECTED,
    });
    expect(f.router.handleDaemon(viewState, 7)).toBe(true);
    expect(f.router.stats()).toMatchObject({ active: 2, controlling: 1 });
    expect(f.messages(f.browserB).at(-1)).toMatchObject({
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      viewerCount: 2,
      controllerCount: 1,
    });
  });

  it('bounds sessions per browser, per user, and per machine without a global controller lock', async () => {
    const f = fixture();
    await authorize(f, f.browserA, 'owner-user', 'request_machine01');

    await f.router.handleBrowser(f.browserA, 'owner-user', { ...start, requestId: 'request_machine02' });
    expect(f.messages(f.browserA).at(-1)).toMatchObject({ error: REMOTE_DESKTOP_ERROR.SESSION_LIMIT });

    const secondSocket = {} as WebSocket;
    await authorize(f, secondSocket, 'owner-user', 'request_machine03');
    const thirdSameUser = {} as WebSocket;
    await f.router.handleBrowser(thirdSameUser, 'owner-user', { ...start, requestId: 'request_machine04' });
    expect(f.messages(thirdSameUser).at(-1)).toMatchObject({ error: REMOTE_DESKTOP_ERROR.SESSION_LIMIT });

    await authorize(f, {} as WebSocket, 'participant-2', 'request_machine05');
    await authorize(f, {} as WebSocket, 'participant-3', 'request_machine06');
    const overMachineLimit = {} as WebSocket;
    await f.router.handleBrowser(overMachineLimit, 'participant-4', { ...start, requestId: 'request_machine07' });
    expect(f.messages(overMachineLimit).at(-1)).toMatchObject({ error: REMOTE_DESKTOP_ERROR.SESSION_LIMIT });
    expect(f.router.stats()).toMatchObject({
      active: REMOTE_DESKTOP_LIMITS.MAX_PER_MACHINE,
      controlling: REMOTE_DESKTOP_LIMITS.MAX_PER_MACHINE,
    });
  });

  it('charges each daemon signal once against the shared machine budget', async () => {
    const f = fixture();
    const sessions = await Promise.all(Array.from(
      { length: REMOTE_DESKTOP_LIMITS.MAX_PER_MACHINE },
      async (_, index) => authorize(
        f,
        {} as WebSocket,
        `participant-signal-${index}`,
        `request_signal_${String(index).padStart(4, '0')}`,
      ),
    ));

    for (const authority of sessions) {
      for (let index = 0; index < REMOTE_DESKTOP_LIMITS.MAX_SIGNALING_PER_MINUTE; index++) {
        expect(f.router.handleDaemon({
          type: REMOTE_DESKTOP_MSG.MODE_STATE,
          ...authority,
          mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
          inputEpoch: 1,
          reason: REMOTE_DESKTOP_MODE_REASON.INITIAL,
        }, 7)).toBe(true);
      }
    }

    expect(f.router.stats()).toMatchObject({
      active: REMOTE_DESKTOP_LIMITS.MAX_PER_MACHINE,
      terminated: 0,
    });
  });

  it('immediately revalidates and terminates only the revoked participant sessions', async () => {
    const revokedUsers = new Set<string>();
    const f = fixture({
      resolveAccess: async (userId) => revokedUsers.has(userId)
        ? null
        : { ...validAccess(), user_id: userId, access_role: 'participant' },
    });
    const authorityA = await authorize(f, f.browserA, 'participant-a', 'request_revoke_a1');
    const authorityB = await authorize(f, f.browserB, 'participant-b', 'request_revoke_b1');

    const summary = f.router.sessionsForUser('participant-a');
    expect(summary).toEqual([expect.objectContaining({
      sessionId: authorityA.sessionId,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
    })]);
    expect(summary[0]).not.toHaveProperty('capability');

    revokedUsers.add('participant-a');
    await f.router.revalidateUser('participant-a');
    expect(f.messages(f.browserA).at(-1)).toMatchObject({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      sessionId: authorityA.sessionId,
      reason: REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_REVOKED,
    });
    expect(f.router.sessionsForUser('participant-a')).toEqual([]);
    expect(f.router.sessionsForUser('participant-b')).toEqual([
      expect.objectContaining({ sessionId: authorityB.sessionId }),
    ]);
    expect(f.router.stopSessionForUser('participant-a', authorityB.sessionId)).toBe(false);
    expect(f.router.stopSessionForUser('participant-b', authorityB.sessionId)).toBe(true);
    expect(f.router.stats().active).toBe(0);
  });

  it('rejects wrong socket/capability and drops stale daemon generations without broadcast', async () => {
    const f = fixture();
    const authority = await authorize(f);
    await f.router.handleBrowser(f.browserB, 'owner-user', {
      type: REMOTE_DESKTOP_MSG.OFFER,
      ...authority,
      sdp: 'forged-by-other-socket',
    });
    expect(f.messages(f.browserB).at(-1)).toMatchObject({ error: REMOTE_DESKTOP_ERROR.INVALID_AUTHORITY });

    const before = f.messages(f.browserA).length;
    f.router.handleDaemon({
      type: REMOTE_DESKTOP_MSG.ANSWER,
      ...authority,
      sdp: 'stale-answer',
    }, 6);
    expect(f.messages(f.browserA)).toHaveLength(before);

    f.router.handleDaemon({
      type: REMOTE_DESKTOP_MSG.ANSWER,
      ...authority,
      capability: 'b'.repeat(43),
      sdp: 'wrong-capability',
    }, 7);
    expect(f.messages(f.browserA)).toHaveLength(before);
    expect(f.router.stats().dropped).toBeGreaterThanOrEqual(2);
  });

  it('revalidates short leases, sends a generation-bound renewal, and fails closed on revoke', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_800_000_000_000);
      const f = fixture({ access: validAccess(Date.now()) });
      const authority = await authorize(f);

      await vi.advanceTimersByTimeAsync(REMOTE_DESKTOP_LIMITS.LEASE_RENEW_INTERVAL_MS);
      expect(f.daemonMessages.at(-1)).toMatchObject({
        type: REMOTE_DESKTOP_MSG.LEASE,
        ...authority,
        daemonGeneration: 7,
        mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        inputEpoch: 1,
      });

      f.setAccess(null);
      await vi.advanceTimersByTimeAsync(REMOTE_DESKTOP_LIMITS.LEASE_RENEW_INTERVAL_MS);
      expect(f.daemonMessages.at(-1)).toMatchObject({ type: REMOTE_DESKTOP_MSG.STOP, ...authority });
      expect(f.messages(f.browserA).at(-1)).toMatchObject({
        type: REMOTE_DESKTOP_MSG.TERMINAL,
        ...authority,
        reason: REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_REVOKED,
      });
      expect(f.router.stats().active).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps lifetime before TURN expiry and lets the worker fail closed on Server registry loss', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_800_000_000_000);
      const hardExpiry = Date.now() + 5 * 60_000;
      const f = fixture({ access: validAccess(Date.now()), credentialExpiresAt: hardExpiry });
      const authority = await authorize(f);
      const authorized = f.messages(f.browserA)[0];
      expect(authorized.expiresAt).toBe(hardExpiry - 60_000);
      expect(authorized.leaseExpiresAt).toBe(Date.now() + REMOTE_DESKTOP_LIMITS.LEASE_DURATION_MS);

      // A fresh per-pod registry cannot recognize or resurrect an old authority.
      const replacement = fixture({ access: validAccess(Date.now()) });
      await replacement.router.handleBrowser(replacement.browserA, 'owner-user', {
        type: REMOTE_DESKTOP_MSG.OFFER,
        ...authority,
        sdp: 'old-offer',
      });
      expect(replacement.daemonMessages).toHaveLength(0);
      expect(replacement.messages(replacement.browserA)[0]).toMatchObject({ error: REMOTE_DESKTOP_ERROR.INVALID_AUTHORITY });

      f.router.stopAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('tears down on daemon replacement, browser close, and malformed current-generation frames', async () => {
    const replaced = fixture();
    const firstAuthority = await authorize(replaced);
    replaced.setGeneration(8);
    expect(replaced.messages(replaced.browserA).at(-1)).toMatchObject({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      ...firstAuthority,
      reason: REMOTE_DESKTOP_TERMINAL_REASON.DAEMON_REPLACED,
    });

    const disconnected = fixture();
    const secondAuthority = await authorize(disconnected);
    disconnected.router.dropSocket(disconnected.browserA);
    expect(disconnected.daemonMessages.at(-1)).toMatchObject({ type: REMOTE_DESKTOP_MSG.STOP, ...secondAuthority });
    expect(disconnected.router.stats().active).toBe(0);

    const malformed = fixture();
    const thirdAuthority = await authorize(malformed);
    malformed.router.handleDaemon({
      type: REMOTE_DESKTOP_MSG.STATUS,
      ...thirdAuthority,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      state: REMOTE_DESKTOP_STATE.DIRECT,
      inputEnabled: false,
      seq: 'invalid-sequence-envelope',
    }, 7);
    expect(malformed.messages(malformed.browserA).at(-1)).toMatchObject({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      ...thirdAuthority,
      reason: REMOTE_DESKTOP_TERMINAL_REASON.PROTOCOL_ERROR,
    });
  });

  it('enforces bounded ICE candidates and idempotent client Stop', async () => {
    const f = fixture();
    const authority = await authorize(f);
    for (let index = 0; index <= REMOTE_DESKTOP_LIMITS.MAX_ICE_CANDIDATES; index++) {
      await f.router.handleBrowser(f.browserA, 'owner-user', {
        type: REMOTE_DESKTOP_MSG.ICE,
        ...authority,
        candidate: `candidate:${index} 1 udp 1 192.0.2.1 ${10_000 + index} typ host`,
        mid: '0',
      });
    }
    expect(f.messages(f.browserA).at(-1)).toMatchObject({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      reason: REMOTE_DESKTOP_TERMINAL_REASON.PROTOCOL_ERROR,
    });
    const stoppedCount = f.daemonMessages.filter((message) => message.type === REMOTE_DESKTOP_MSG.STOP).length;
    await f.router.handleBrowser(f.browserA, 'owner-user', {
      type: REMOTE_DESKTOP_MSG.STOP,
      ...authority,
    });
    expect(f.daemonMessages.filter((message) => message.type === REMOTE_DESKTOP_MSG.STOP)).toHaveLength(stoppedCount);
  });

  it('bounds per-session mode churn without introducing a global controller lock', async () => {
    const f = fixture();
    const authority = await authorize(f);
    for (let index = 0; index <= REMOTE_DESKTOP_LIMITS.MAX_MODE_CHANGES_PER_MINUTE; index++) {
      await f.router.handleBrowser(f.browserA, 'owner-user', {
        type: REMOTE_DESKTOP_MSG.MODE_SET,
        ...authority,
        mode: index % 2 === 0
          ? REMOTE_DESKTOP_ACCESS_MODE.CONTROL
          : REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      });
    }
    expect(f.messages(f.browserA).at(-1)).toMatchObject({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      reason: REMOTE_DESKTOP_TERMINAL_REASON.PROTOCOL_ERROR,
    });
    expect(f.router.stats().active).toBe(0);
  });
});
