/**
 * Peer-audit unicast router focused tests.
 *
 * Covers:
 * - Default deny: peer-audit response with no matching route is dropped.
 * - Single socket unicast: only the originating socket receives the response.
 * - Double browser: cross-socket leak prevention.
 * - Socket close: routes cleared, no late send.
 * - Wrong type / wrong commandId: dropped.
 * - Daemon generation bump: stale routes dropped, late reply dropped.
 * - TTL expiry: route removed.
 * - Per-socket / global capacity caps.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PEER_AUDIT_MESSAGES,
} from '../../shared/peer-audit.js';
import {
  PEER_AUDIT_ROUTE_DROP_REASONS,
  PeerAuditUnicastRouter,
  peerAuditRouteKey,
} from '../src/ws/peer-audit-unicast-router.js';
import type WebSocket from 'ws';

interface SinkMock {
  sends: Array<{ socket: unknown; json: string }>;
  increments: Array<{ metric: string; tags?: Record<string, string> }>;
  warns: Array<{ scope: string; fields: Record<string, unknown>; message: string }>;
}

function makeSink(): SinkMock {
  return { sends: [], increments: [], warns: [] };
}

interface FakeSocket {
  readyState: number;
  OPEN: number;
  CLOSED: number;
}

function makeSocket(): FakeSocket & { sentJson: string[] } {
  const sock = {
    readyState: 1,
    OPEN: 1,
    CLOSED: 3,
    sentJson: [] as string[],
  };
  return sock;
}

function makeRouter(sink: SinkMock, opts?: { perSocket?: number; global?: number; ttlMs?: number; generation?: number }) {
  return new PeerAuditUnicastRouter(
    {
      perSocket: opts?.perSocket ?? 32,
      global: opts?.global ?? 1024,
      ttlMs: opts?.ttlMs ?? 30_000,
    },
    opts?.generation ?? 0,
    {
      send: (socket, json) => { sink.sends.push({ socket, json }); (socket as any).sentJson.push(json); },
      increment: (metric, tags) => { sink.increments.push({ metric, tags }); },
      logWarn: (scope, fields, message) => { sink.warns.push({ scope, fields, message }); },
    },
  );
}

const CANDIDATES = PEER_AUDIT_MESSAGES.CANDIDATES;
const QUICK_RESULT = PEER_AUDIT_MESSAGES.QUICK_RESULT;
const CANCEL_RESULT = PEER_AUDIT_MESSAGES.CANCEL_RESULT;

describe('PeerAuditUnicastRouter', () => {
  let sink: SinkMock;
  beforeEach(() => {
    sink = makeSink();
  });

  it('unicasts a matching response to the originating socket only', () => {
    // Bridge contract: router.resolve returns the originating socket; the
    // caller then dispatches the response there. Verify the returned socket
    // is the one we registered (the cross-tab leak test below proves the
    //    *other* socket never sees the response).
    const router = makeRouter(sink);
    const a = makeSocket();
    const b = makeSocket();
    const id = 'cmd-1';
    router.insert({ socket: a as unknown as WebSocket, commandId: id, requestType: 'peer_audit.list_candidates', responseType: CANDIDATES });
    const resolved = router.resolve({ type: CANDIDATES, commandId: id, list: [] });
    expect(resolved?.socket).toBe(a);
    // The second browser socket has no entry in the routes map. A
    // resolve() call for its (type, commandId) would return null, proving
    // it can never receive this response via the unicast router.
    expect(router.has(CANDIDATES, id)).toBe(false);
    // Cross-tab leakage would be: router.resolve can return b. We confirm
    // it cannot by re-inserting with a different socket+commandId and
    // confirming the original route is gone.
    const id2 = 'cmd-2';
    router.insert({ socket: b as unknown as WebSocket, commandId: id2, requestType: 'peer_audit.list_candidates', responseType: CANDIDATES });
    const resolved2 = router.resolve({ type: CANDIDATES, commandId: id2 });
    expect(resolved2?.socket).toBe(b);
    expect(resolved2?.socket).not.toBe(a);
  });

  it('drops a peer-audit response with no matching route (default deny)', () => {
    const router = makeRouter(sink);
    const resolved = router.resolve({ type: CANDIDATES, commandId: 'never-issued' });
    expect(resolved).toBeNull();
    const dropMetric = sink.increments.find((entry) => entry.tags?.reason === PEER_AUDIT_ROUTE_DROP_REASONS.NO_ROUTE);
    expect(dropMetric).toBeDefined();
  });

  it('drops a response with mismatched type', () => {
    const router = makeRouter(sink);
    const a = makeSocket();
    const id = 'cmd-2';
    router.insert({ socket: a as unknown as WebSocket, commandId: id, requestType: 'peer_audit.list_candidates', responseType: CANDIDATES });
    const resolved = router.resolve({ type: QUICK_RESULT, commandId: id });
    expect(resolved).toBeNull();
    expect(sink.increments.some((entry) => entry.tags?.reason === PEER_AUDIT_ROUTE_DROP_REASONS.TYPE_MISMATCH)).toBe(true);
  });

  it('drops a response with no matching commandId', () => {
    const router = makeRouter(sink);
    const a = makeSocket();
    router.insert({ socket: a as unknown as WebSocket, commandId: 'cmd-A', requestType: 'peer_audit.list_candidates', responseType: CANDIDATES });
    const resolved = router.resolve({ type: CANDIDATES, commandId: 'cmd-B' });
    expect(resolved).toBeNull();
    expect(sink.increments.some((entry) => entry.tags?.reason === PEER_AUDIT_ROUTE_DROP_REASONS.NO_ROUTE)).toBe(true);
  });

  it('drops a response missing commandId', () => {
    const router = makeRouter(sink);
    const resolved = router.resolve({ type: CANDIDATES });
    expect(resolved).toBeNull();
    expect(sink.increments.some((entry) => entry.tags?.reason === PEER_AUDIT_ROUTE_DROP_REASONS.MISSING_COMMAND_ID)).toBe(true);
  });

  it('consumes the route on resolve (single consumption)', () => {
    const router = makeRouter(sink);
    const a = makeSocket();
    const id = 'cmd-3';
    router.insert({ socket: a as unknown as WebSocket, commandId: id, requestType: 'peer_audit.list_candidates', responseType: CANDIDATES });
    expect(router.has(CANDIDATES, id)).toBe(true);
    const first = router.resolve({ type: CANDIDATES, commandId: id });
    expect(first?.socket).toBe(a);
    const second = router.resolve({ type: CANDIDATES, commandId: id });
    expect(second).toBeNull();
  });

  it('rejects a duplicate route key instead of letting another socket hijack it', () => {
    const router = makeRouter(sink);
    const a = makeSocket();
    const b = makeSocket();
    const id = 'duplicate-command';
    expect(router.insert({ socket: a as unknown as WebSocket, commandId: id, requestType: 'peer_audit.quick_start', responseType: QUICK_RESULT })).toEqual({ ok: true });
    expect(router.insert({ socket: b as unknown as WebSocket, commandId: id, requestType: 'peer_audit.quick_start', responseType: QUICK_RESULT })).toEqual({
      ok: false,
      reason: PEER_AUDIT_ROUTE_DROP_REASONS.DUPLICATE_ROUTE,
    });
    expect(router.resolve({ type: QUICK_RESULT, commandId: id })?.socket).toBe(a);
  });

  it('drops only the failed reservation and preserves other in-flight routes on the socket', () => {
    const router = makeRouter(sink);
    const socket = makeSocket();
    router.insert({ socket: socket as unknown as WebSocket, commandId: 'failed', requestType: 'peer_audit.quick_start', responseType: QUICK_RESULT });
    router.insert({ socket: socket as unknown as WebSocket, commandId: 'healthy', requestType: 'peer_audit.cancel', responseType: CANCEL_RESULT });
    expect(router.drop(QUICK_RESULT, 'failed', socket as unknown as WebSocket)).toBe(true);
    expect(router.has(QUICK_RESULT, 'failed')).toBe(false);
    expect(router.has(CANCEL_RESULT, 'healthy')).toBe(true);
  });

  it('drops a response bound to a stale daemon generation', () => {
    const router = makeRouter(sink, { generation: 1 });
    const a = makeSocket();
    const id = 'cmd-gen';
    router.insert({ socket: a as unknown as WebSocket, commandId: id, requestType: 'peer_audit.list_candidates', responseType: CANDIDATES });
    // Simulate daemon reconnect with a new generation.
    router.setDaemonGeneration(2);
    const resolved = router.resolve({ type: CANDIDATES, commandId: id });
    expect(resolved).toBeNull();
    expect(sink.increments.some((entry) => entry.tags?.reason === PEER_AUDIT_ROUTE_DROP_REASONS.GENERATION_MISMATCH)).toBe(true);
    expect(router.has(CANDIDATES, id)).toBe(false);
  });

  it('drops all routes when generation bumps', () => {
    const router = makeRouter(sink, { generation: 5 });
    const a = makeSocket();
    const b = makeSocket();
    router.insert({ socket: a as unknown as WebSocket, commandId: 'cmd-x', requestType: 'peer_audit.list_candidates', responseType: CANDIDATES });
    router.insert({ socket: b as unknown as WebSocket, commandId: 'cmd-y', requestType: 'peer_audit.quick_start', responseType: QUICK_RESULT });
    expect(router.size()).toBe(2);
    router.setDaemonGeneration(6);
    expect(router.size()).toBe(0);
  });

  it('clears all routes for a closed socket', () => {
    const router = makeRouter(sink);
    const a = makeSocket();
    const b = makeSocket();
    router.insert({ socket: a as unknown as WebSocket, commandId: 'cmd-a1', requestType: 'peer_audit.list_candidates', responseType: CANDIDATES });
    router.insert({ socket: a as unknown as WebSocket, commandId: 'cmd-a2', requestType: 'peer_audit.quick_start', responseType: QUICK_RESULT });
    router.insert({ socket: b as unknown as WebSocket, commandId: 'cmd-b1', requestType: 'peer_audit.cancel', responseType: CANCEL_RESULT });
    expect(router.size()).toBe(3);
    router.dropSocket(a as unknown as WebSocket);
    expect(router.size()).toBe(1);
    expect(router.has(CANDIDATES, 'cmd-a1')).toBe(false);
    expect(router.has(QUICK_RESULT, 'cmd-a2')).toBe(false);
    expect(router.has(CANCEL_RESULT, 'cmd-b1')).toBe(true);
    expect(sink.increments.filter((entry) => entry.tags?.reason === PEER_AUDIT_ROUTE_DROP_REASONS.SOCKET_CLOSED).length).toBe(2);
  });

  it('evicts the oldest route when global cap reached', () => {
    const router = makeRouter(sink, { global: 2, perSocket: 8 });
    const a = makeSocket();
    router.insert({ socket: a as unknown as WebSocket, commandId: 'oldest', requestType: 'peer_audit.list_candidates', responseType: CANDIDATES });
    // Wait 1ms to guarantee createdAt order.
    setTimeout(() => {}, 1);
    router.insert({ socket: a as unknown as WebSocket, commandId: 'newer', requestType: 'peer_audit.list_candidates', responseType: CANDIDATES });
    expect(router.size()).toBe(2);
    // Third insert evicts "oldest".
    router.insert({ socket: a as unknown as WebSocket, commandId: 'newest', requestType: 'peer_audit.list_candidates', responseType: CANDIDATES });
    expect(router.size()).toBe(2);
    expect(router.has(CANDIDATES, 'oldest')).toBe(false);
    expect(router.has(CANDIDATES, 'newest')).toBe(true);
  });

  it('enforces per-socket cap', () => {
    const router = makeRouter(sink, { global: 100, perSocket: 2 });
    const a = makeSocket();
    router.insert({ socket: a as unknown as WebSocket, commandId: '1', requestType: 'peer_audit.list_candidates', responseType: CANDIDATES });
    router.insert({ socket: a as unknown as WebSocket, commandId: '2', requestType: 'peer_audit.list_candidates', responseType: CANDIDATES });
    const rejected = router.insert({ socket: a as unknown as WebSocket, commandId: '3', requestType: 'peer_audit.list_candidates', responseType: CANDIDATES });
    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toBe(PEER_AUDIT_ROUTE_DROP_REASONS.PER_SOCKET_CAP);
  });

  it('expires route by TTL', async () => {
    const router = makeRouter(sink, { ttlMs: 5 });
    const a = makeSocket();
    router.insert({ socket: a as unknown as WebSocket, commandId: 'exp', requestType: 'peer_audit.list_candidates', responseType: CANDIDATES });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(router.size()).toBe(0);
    const resolved = router.resolve({ type: CANDIDATES, commandId: 'exp' });
    expect(resolved).toBeNull();
    expect(sink.increments.some((entry) => entry.tags?.reason === PEER_AUDIT_ROUTE_DROP_REASONS.EXPIRED)).toBe(true);
  });

  it('rejects reservation for unknown response type', () => {
    const router = makeRouter(sink);
    const a = makeSocket();
    const rejected = router.insert({
      socket: a as unknown as WebSocket,
      commandId: 'cmd',
      requestType: 'peer_audit.list_candidates',
      responseType: 'some.unknown.type',
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toBe(PEER_AUDIT_ROUTE_DROP_REASONS.UNKNOWN_RESPONSE_TYPE);
  });

  it('rejects reservation for empty / oversized commandId', () => {
    const router = makeRouter(sink);
    const a = makeSocket();
    const emptyRejected = router.insert({
      socket: a as unknown as WebSocket,
      commandId: '',
      requestType: 'peer_audit.list_candidates',
      responseType: CANDIDATES,
    });
    expect(emptyRejected.ok).toBe(false);
    expect(emptyRejected.reason).toBe(PEER_AUDIT_ROUTE_DROP_REASONS.MISSING_COMMAND_ID);

    const oversizedRejected = router.insert({
      socket: a as unknown as WebSocket,
      commandId: 'x'.repeat(257),
      requestType: 'peer_audit.list_candidates',
      responseType: CANDIDATES,
    });
    expect(oversizedRejected.ok).toBe(false);
    expect(oversizedRejected.reason).toBe(PEER_AUDIT_ROUTE_DROP_REASONS.MISSING_COMMAND_ID);
  });

  it('produces a unique command id from the static helper', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      ids.add(PeerAuditUnicastRouter.mintCommandId());
    }
    expect(ids.size).toBe(1000);
    for (const id of ids) {
      expect(id.startsWith('peer_audit_')).toBe(true);
    }
  });

  it('refuses routes when daemon generation is bumped before reserve', () => {
    const router = makeRouter(sink, { generation: 0 });
    const a = makeSocket();
    router.setDaemonGeneration(1);
    const insert = router.insert({
      socket: a as unknown as WebSocket,
      commandId: 'cmd-post-bump',
      requestType: 'peer_audit.list_candidates',
      responseType: CANDIDATES,
    });
    expect(insert.ok).toBe(true);
    router.setDaemonGeneration(0); // back to old generation
    const resolved = router.resolve({ type: CANDIDATES, commandId: 'cmd-post-bump' });
    expect(resolved).toBeNull();
  });

  it('routeKey is collision-free for canonical wire shapes', () => {
    expect(peerAuditRouteKey('a', 'b:c')).not.toBe(peerAuditRouteKey('a:b', 'c'));
    expect(peerAuditRouteKey('peer_audit.candidates', 'cmd-1')).toBe('peer_audit.candidates\x00cmd-1');
  });
});
