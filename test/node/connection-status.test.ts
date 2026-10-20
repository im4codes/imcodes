import { describe, expect, it } from 'vitest';
import { emptyEndpointState, ControlledNodeEndpointSelector } from '../../src/node/server-endpoints.js';
import {
  CONTROLLED_NODE_FAILURE_CLASS as C,
  ControlledNodeConnectionTracker,
  classifyConnectionFailure,
} from '../../src/node/connection-status.js';

const PRIMARY = 'https://im.zhinet.work';
const PROXY = 'https://im-proxy.koca.win:8443';

function rig(advertised: string[] = []) {
  let clock = 1_800_000_000_000;
  const persisted: unknown[] = [];
  const selector = new ControlledNodeEndpointSelector(PRIMARY, { ...emptyEndpointState(), advertised }, {
    now: () => clock, persist: (state) => { persisted.push(state); },
  });
  const tracker = new ControlledNodeConnectionTracker({ primary: PRIMARY, selector, now: () => clock });
  return { tracker, selector, persisted, advance: (ms: number) => { clock += ms; } };
}
const lost = (reason: string, errorCode?: string) => ({ type: 'socket_lost' as const, reason: reason as never, ...(errorCode ? { errorCode } : {}) });

describe('failure classification', () => {
  it.each([
    ['connect_timeout', undefined, C.TCP_TIMEOUT],
    ['socket_error', 'ETIMEDOUT', C.TCP_TIMEOUT],
    ['socket_error', 'ECONNREFUSED', C.REFUSED],
    ['socket_error', 'ENOTFOUND', C.DNS],
    ['socket_error', 'EAI_AGAIN', C.DNS],
    ['socket_error', 'ECONNRESET', C.RESET],
    ['socket_error', 'CERT_HAS_EXPIRED', C.TLS],
    ['socket_error', 'ERR_TLS_CERT_ALTNAME_INVALID', C.TLS],
    ['socket_error', 'DEPTH_ZERO_SELF_SIGNED_CERT', C.TLS],
    ['socket_error', undefined, C.OTHER],
    ['authentication_failed', undefined, C.REJECTED],
    ['credential_revoked', undefined, C.REJECTED],
  ])('%s / %s -> %s', (reason, code, expected) => {
    expect(classifyConnectionFailure(reason as never, code)).toBe(expected);
  });
});

describe('connection tracker', () => {
  it('is "connecting" before anything failed and "connected" after an authenticated ack', () => {
    const { tracker } = rig();
    expect(tracker.status()).toEqual({ state: 'connecting', target: 'im.zhinet.work', consecutiveFailures: 0 });
    tracker.onAuthenticatedAck({ type: 'heartbeat_ack' });
    expect(tracker.status().state).toBe('connected');
  });

  it('reports an unreachable server with the host, the class and when it began (no URL path, no secret)', () => {
    const { tracker, advance } = rig();
    tracker.onDiagnostic(lost('connect_timeout'));
    advance(30_000);
    tracker.onDiagnostic(lost('connect_timeout'));
    const status = tracker.status();
    expect(status).toMatchObject({ state: 'unreachable', target: 'im.zhinet.work', failureClass: C.TCP_TIMEOUT, consecutiveFailures: 2 });
    expect(status.since).toBe(1_800_000_000_000);
    expect(JSON.stringify(status)).not.toMatch(/https?:|token/i);
  });

  it('moves to the advertised origin after three failures in a row and returns to "connected" there', () => {
    const { tracker, persisted } = rig([PROXY]);
    for (let i = 0; i < 3; i += 1) tracker.onDiagnostic(lost('connect_timeout'));
    expect(tracker.currentOrigin()).toBe(PROXY);
    expect(tracker.status().target).toBe('im-proxy.koca.win:8443');
    tracker.onDiagnostic({ type: 'socket_opened' });
    tracker.onAuthenticatedAck({ type: 'heartbeat_ack' });
    expect(tracker.status()).toMatchObject({ state: 'connected', target: 'im-proxy.koca.win:8443' });
    expect(persisted.at(-1)).toMatchObject({ lastGood: PROXY });
  });

  it('records the origins the authenticated server advertises, and ignores a malformed field', () => {
    const { tracker, selector } = rig();
    tracker.onAuthenticatedAck({ type: 'heartbeat_ack', serverUrls: [PROXY, 'http://evil.example', 5] });
    expect(selector.snapshot().advertised).toEqual([PROXY]);
    tracker.onAuthenticatedAck({ type: 'heartbeat_ack', serverUrls: 'not a list' });
    expect(selector.snapshot().advertised).toEqual([PROXY]);
    tracker.onAuthenticatedAck({ type: 'heartbeat_ack' }); // an older server says nothing: nothing changes
    expect(selector.snapshot().advertised).toEqual([PROXY]);
  });

  it('a drop of an authenticated connection is not a failed attempt; a close before any ack is', () => {
    const { tracker } = rig();
    tracker.onDiagnostic({ type: 'socket_opened' });
    tracker.onAuthenticatedAck({ type: 'heartbeat_ack' });
    tracker.onDiagnostic(lost('socket_close'));
    expect(tracker.status().consecutiveFailures).toBe(0);
    tracker.onDiagnostic({ type: 'socket_opened' });
    tracker.onDiagnostic(lost('socket_close'));
    expect(tracker.status()).toMatchObject({ state: 'unreachable', consecutiveFailures: 1 });
  });

  it('a deliberate reconnect or a resume is neither a failure nor a rotation', () => {
    const { tracker } = rig([PROXY]);
    for (let i = 0; i < 9; i += 1) {
      tracker.onDiagnostic(lost('manual_reconnect'));
      tracker.onDiagnostic(lost('system_resume_or_clock_change'));
    }
    expect(tracker.currentOrigin()).toBe(PRIMARY);
    expect(tracker.status().consecutiveFailures).toBe(0);
  });

  it('an alternate that rejects the credential is dropped and the node goes back to the enrolled address', () => {
    const { tracker, selector } = rig([PROXY]);
    for (let i = 0; i < 3; i += 1) tracker.onDiagnostic(lost('connect_timeout'));
    expect(tracker.currentOrigin()).toBe(PROXY);
    tracker.onDiagnostic(lost('authentication_failed'));
    expect(tracker.currentOrigin()).toBe(PRIMARY);
    expect(selector.candidates()).toEqual([PRIMARY]);
    expect(tracker.status().failureClass).toBe(C.REJECTED);
  });

  it('an ack that names another server ID drops that alternate for a day and counts for nothing', () => {
    let clock = 1_800_000_000_000;
    const selector = new ControlledNodeEndpointSelector(PRIMARY, { ...emptyEndpointState(), advertised: [PROXY] }, { now: () => clock });
    const tracker = new ControlledNodeConnectionTracker({ primary: PRIMARY, serverId: 'srv-1', selector, now: () => clock });
    for (let i = 0; i < 3; i += 1) tracker.onDiagnostic(lost('connect_timeout'));
    expect(tracker.currentOrigin()).toBe(PROXY);
    expect(tracker.onAuthenticatedAck({ type: 'heartbeat_ack', serverId: 'someone-else', serverUrls: ['https://elsewhere.example'] })).toBe(false);
    expect(tracker.currentOrigin()).toBe(PRIMARY);
    expect(tracker.status().state).not.toBe('connected');
    expect(selector.candidates()).toEqual([PRIMARY]);
    expect(selector.snapshot().advertised).toEqual([PROXY]); // what that ack advertised was not taken either
    clock += 24 * 3_600_000 + 1;
    expect(selector.candidates()).toEqual([PRIMARY, PROXY]);
  });

  it('an ack with this server ID (or none: nodes without a public ID get none) is accepted', () => {
    const selector = new ControlledNodeEndpointSelector(PRIMARY, emptyEndpointState(), {});
    const tracker = new ControlledNodeConnectionTracker({ primary: PRIMARY, serverId: 'srv-1', selector });
    expect(tracker.onAuthenticatedAck({ type: 'heartbeat_ack', serverId: 'srv-1' })).toBe(true);
    expect(tracker.status().state).toBe('connected');
    expect(tracker.onAuthenticatedAck({ type: 'heartbeat_ack' })).toBe(true);
    expect(tracker.status().state).toBe('connected');
  });

  it('works without a selector: the enrolled address only, status still reported', () => {
    const tracker = new ControlledNodeConnectionTracker({ primary: PRIMARY, selector: null });
    for (let i = 0; i < 10; i += 1) tracker.onDiagnostic(lost('connect_timeout'));
    expect(tracker.currentOrigin()).toBe(PRIMARY);
    expect(tracker.status()).toMatchObject({ state: 'unreachable', consecutiveFailures: 10 });
    tracker.onAuthenticatedAck({ type: 'heartbeat_ack', serverUrls: [PROXY] });
    expect(tracker.currentOrigin()).toBe(PRIMARY);
  });
});
