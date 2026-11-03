import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REMOTE_DESKTOP_TRAFFIC, RemoteDesktopTrafficCounter, formatRemoteDesktopBytes } from '../../shared/remote-desktop-traffic.js';
import { RemoteDesktopTrafficLedger } from '../../src/node/remote-desktop-traffic-ledger.js';
import { RemoteDesktopWorkerHostCore } from '../../src/node/remote-desktop-worker-host-core.js';
import { REMOTE_DESKTOP_MSG, REMOTE_DESKTOP_ACCESS_MODE, REMOTE_DESKTOP_STATE, type RemoteDesktopPrepare } from '../../shared/remote-desktop.js';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
describe('remote desktop measured traffic', () => {
  it('counts each transport once, retains totals over ICE changes, resets and peer replacements', () => {
    const counter = new RemoteDesktopTrafficCounter();
    counter.observe('dtls-1', { bytesSent: 20, bytesReceived: 100 });
    counter.observe('dtls-1', { bytesSent: 20, bytesReceived: 100 });
    counter.observe('dtls-2', { bytesSent: 10, bytesReceived: 50 });
    counter.observe('dtls-1', { bytesSent: 25, bytesReceived: 150 });
    expect(counter.total).toEqual({ bytesSent: 35, bytesReceived: 200 });
    counter.observe('dtls-1', { bytesSent: 2, bytesReceived: 5 });
    counter.nextPeer();
    counter.observe('dtls-1', { bytesSent: 3, bytesReceived: 10 });
    expect(counter.total).toEqual({ bytesSent: 40, bytesReceived: 215 });
    counter.observe('bad', { bytesSent: NaN, bytesReceived: -1 });
    expect(counter.total.bytesSent).toBe(40);
    counter.observe('large', { bytesSent: Number.MAX_SAFE_INTEGER, bytesReceived: Number.MAX_SAFE_INTEGER });
    expect(counter.total.bytesSent).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('ignores late cached stats instead of counting an older sample as a counter reset', () => {
    const counter = new RemoteDesktopTrafficCounter();
    counter.observe('dtls', { bytesSent: 100, bytesReceived: 200 }, 20);
    counter.observe('dtls', { bytesSent: 50, bytesReceived: 100 }, 10);
    counter.observe('dtls', { bytesSent: 110, bytesReceived: 220 }, 30);
    expect(counter.total).toEqual({ bytesSent: 110, bytesReceived: 220 });
  });
  it('keeps the local native telemetry type aligned', async () => {
    const header = await readFile(new URL('../../native/remote-desktop-common/traffic_stats.h', import.meta.url), 'utf8');
    expect(header).toContain(JSON.stringify(REMOTE_DESKTOP_TRAFFIC.WORKER_MESSAGE));
  });
  it('formats zero and large real byte values without using bitrate', () => {
    expect(formatRemoteDesktopBytes(0)).toBe('0 B');
    expect(formatRemoteDesktopBytes(1024)).toBe('1.0 KiB');
    expect(formatRemoteDesktopBytes(2 ** 40)).toBe('1.0 TiB');
    expect(formatRemoteDesktopBytes(-1)).toBe('—');
  });
  it('records concurrent connections, ends and real disk restart, without double counting snapshots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-test-traffic-')); dirs.push(dir);
    const path = join(dir, REMOTE_DESKTOP_TRAFFIC.STORE_FILE);
    let now = 10_000;
    const ledger = new RemoteDesktopTrafficLedger(path, () => now);
    ledger.start('first', '#1', now);
    ledger.start('second', '#2', now);
    ledger.observe('first', { bytesSent: 100, bytesReceived: 20 });
    ledger.observe('first', { bytesSent: 100, bytesReceived: 20 });
    ledger.observe('second', { bytesSent: 10, bytesReceived: 30 });
    now = 12_000;
    ledger.end('first');
    await ledger.flush();
    expect(ledger.snapshot().total).toEqual({ bytesSent: 110, bytesReceived: 50 });
    const restarted = new RemoteDesktopTrafficLedger(path, () => now);
    expect(restarted.snapshot().total).toEqual(ledger.snapshot().total);
    expect(restarted.snapshot().connections.every((r) => r.endedAt === now)).toBe(true);
    restarted.start('third', '#3', now);
    restarted.observe('third', { bytesSent: 5, bytesReceived: 7 });
    await restarted.flush();
    expect(JSON.parse(await readFile(path, 'utf8')).total).toEqual({ bytesSent: 115, bytesReceived: 57 });
  });
  it('bounds history without losing lifetime totals and distinguishes unmeasured from zero', () => {
    const ledger = new RemoteDesktopTrafficLedger();
    ledger.start('unknown', '#1', 1);
    ledger.end('unknown');
    expect(ledger.snapshot().connections[0]?.measured).toBe(false);
    for (let i = 0; i < 205; i++) {
      ledger.start(`row-${i}`, `#${i + 2}`, i);
      ledger.observe(`row-${i}`, { bytesSent: 1, bytesReceived: 2 });
      ledger.end(`row-${i}`);
    }
    expect(ledger.snapshot().connections).toHaveLength(200);
    expect(ledger.snapshot().total).toEqual({ bytesSent: 205, bytesReceived: 410 });
    ledger.start('long-lived', '#208', 300);
    for (let i = 0; i < 205; i++) {
      ledger.start(`later-${i}`, `#${i + 209}`, 400 + i);
      ledger.end(`later-${i}`);
    }
    ledger.observe('long-lived', { bytesSent: 10, bytesReceived: 20 });
    expect(ledger.snapshot().connections.find((r) => r.id === 'long-lived')?.bytesSent).toBe(10);
    expect(ledger.snapshot().connections).toHaveLength(200);
  });
  it('preserves an unreadable history file and reports persistence errors instead of inventing a zero baseline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-test-traffic-')); dirs.push(dir);
    const path = join(dir, 'history.json');
    await writeFile(path, 'broken');
    const ledger = new RemoteDesktopTrafficLedger(path);
    ledger.start('row', '#1', 1);
    ledger.end('row');
    await ledger.flush();
    expect(ledger.snapshot().persistenceError).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('broken');
  });
  it('accepts only current authenticated local telemetry; temporary disconnect preserves the same connection', () => {
    const core = new RemoteDesktopWorkerHostCore<null>({ nonce: 'nonce', onWatchdogTimeout() {} });
    const generation = core.beginConnection();
    const prepare: RemoteDesktopPrepare = { type: REMOTE_DESKTOP_MSG.PREPARE, requestId: 'request_traffic_123', sessionId: 'session_traffic_123', capability: 'a'.repeat(43), expiresAt: Date.now() + 60_000, leaseExpiresAt: Date.now() + 60_000, daemonGeneration: 1, mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW, inputEpoch: 0, iceServers: [] };
    core.track(prepare, null);
    const status = (peerConnected: boolean) => ({ type: REMOTE_DESKTOP_MSG.STATUS, requestId: prepare.requestId, sessionId: prepare.sessionId, capability: prepare.capability, mode: prepare.mode, inputEpoch: 0, state: REMOTE_DESKTOP_STATE.RELAYED, route: 'relay', inputEnabled: false, peerConnected });
    const push = (frame: unknown, gen = generation) => core.pushInbound(JSON.stringify(frame) + '\n', gen);
    push(status(true));
    const id = core.activeConnections()[0]!.id;
    const sample = { type: REMOTE_DESKTOP_TRAFFIC.WORKER_MESSAGE, requestId: prepare.requestId, sessionId: prepare.sessionId, capability: prepare.capability, transportId: 'dtls', bytesSent: 100, bytesReceived: 20 };
    expect(push(sample).events).toEqual([]); // never leaks local telemetry onto server signaling
    push({ ...sample, capability: 'b'.repeat(43), bytesSent: 500 });
    push({ ...sample, requestId: 'wrong', bytesSent: 500 });
    push({ ...sample, bytesSent: -1 });
    push({ ...sample, bytesSent: 999 }, generation + 1);
    expect(core.activeConnections()[0]?.traffic).toEqual({ bytesSent: 100, bytesReceived: 20 });
    push(status(false));
    expect(core.activeConnections()).toEqual([]);
    push(status(true));
    push({ ...sample, bytesSent: 150 });
    expect(core.activeConnections()[0]?.id).toBe(id);
    expect(core.traffic.snapshot().total.bytesSent).toBe(150);
    core.untrack(prepare.sessionId);
    push({ ...sample, bytesSent: 999 });
    expect(core.traffic.snapshot().total.bytesSent).toBe(150);
    expect(core.traffic.snapshot().connections[0]?.endedAt).toBeDefined();
    core.track(prepare, null);
    push(status(true));
    expect(core.activeConnections()).toHaveLength(1);
    core.finishLocalConnections();
    expect(core.activeConnections()).toEqual([]);
    expect(core.traffic.snapshot().connections.every((row) => row.endedAt !== undefined)).toBe(true);
  });
});
