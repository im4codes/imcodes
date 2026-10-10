import { afterEach, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import type { Database } from '../src/db/client.js';
import { SHARE_MESSAGE_LANE_MAX_PENDING } from '../src/ws/share-lanes.js';
import { ControlledBrowserReadGate } from '../src/ws/controlled-browser-read-gate.js';
afterEach(() => vi.useRealTimers());
const socket = () => ({ readyState: 1, send: vi.fn() }) as unknown as WebSocket;

it('a revoke fences an in-flight SQL snapshot; a valid replacement read share keeps the same subscription', async () => {
  let release!: (rows: unknown) => void; let granted = true;
  const query = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockImplementation(async () => granted ? [{ actor_id: 'actor' }] : []);
  const invalid = vi.fn((ws: WebSocket) => gate.remove(ws));
  const gate = new ControlledBrowserReadGate('node', () => ({ query }) as unknown as Database, invalid);
  const ws = socket(); gate.register(ws, 'actor'); gate.send(ws, 'old-snapshot');
  await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
  const refreshed = gate.revalidate('actor'); granted = false; release([{ actor_id: 'actor' }]);
  await refreshed; expect(ws.send).not.toHaveBeenCalled(); expect(invalid).toHaveBeenCalledWith(ws);
  granted = true; gate.register(ws, 'actor'); gate.send(ws, 'valid-snapshot'); await gate.revalidate('actor');
  expect(ws.send).toHaveBeenCalledWith('valid-snapshot'); expect(query.mock.calls[0]![1]).toEqual(['node', ['actor'], expect.any(Number), 'controlled']);
});

it('slow or unavailable authority never sends metadata and has a two-second bound', async () => {
  vi.useFakeTimers();
  const gate = new ControlledBrowserReadGate('node', () => ({ query: () => new Promise(() => {}) }) as unknown as Database, invalid);
  const ws = socket(); function invalid(socket: WebSocket) { gate.remove(socket); }
  const other = socket(); gate.register(ws, 'actor'); gate.register(other, 'other');
  gate.send(ws, 'secret'); gate.send(other, 'also-secret'); const done = gate.revalidate();
  await vi.advanceTimersByTimeAsync(2001); await done;
  expect(ws.send).not.toHaveBeenCalled(); expect(other.send).not.toHaveBeenCalled();
});

it('queued metadata remains in original order and is authorized per packet, with no actor substitution', async () => {
  const query = vi.fn(async () => [{ actor_id: 'actor' }]);
  const gate = new ControlledBrowserReadGate('node', () => ({ query }) as unknown as Database, socket => gate.remove(socket));
  const ws = socket(); gate.register(ws, 'actor');
  for (const data of ['hello', 'refresh', 'upgrade']) gate.broadcast(data);
  await gate.revalidate();
  expect(ws.send.mock.calls.map(([data]) => data)).toEqual(['hello', 'refresh', 'upgrade']);
  expect(query).toHaveBeenCalledTimes(4);
});

it('queue overflow is bounded and invalidates only registered controlled readers', async () => {
  const query = vi.fn(async () => [{ actor_id: 'actor' }]);
  const invalid = vi.fn((ws: WebSocket) => gate.remove(ws));
  const gate = new ControlledBrowserReadGate('node', () => ({ query }) as unknown as Database, invalid);
  const ws = socket(); gate.register(ws, 'actor');
  for (let i = 0; i <= SHARE_MESSAGE_LANE_MAX_PENDING; i++) gate.broadcast('bounded');
  await gate.revalidate(); await Promise.resolve();
  expect(invalid).toHaveBeenCalledTimes(1); expect(ws.send).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
});

it('fleet authority failure/stop fences an old allowed snapshot and never touches unregistered FULL readers', async () => {
  let release!: (rows: unknown) => void;
  let ready = true;
  const query = vi.fn(() => new Promise(resolve => { release = resolve; }));
  const invalid = vi.fn((ws: WebSocket) => gate.remove(ws));
  const gate = new ControlledBrowserReadGate('node', () => ({ query }) as unknown as Database, invalid, () => ready);
  const ws = socket(), full = socket(); gate.register(ws, 'actor'); gate.send(ws, 'old-snapshot');
  await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
  ready = false; release([{ actor_id: 'actor' }]);
  await gate.revalidate();
  expect(ws.send).not.toHaveBeenCalled(); expect(invalid).toHaveBeenCalledWith(ws);
  expect(invalid).not.toHaveBeenCalledWith(full);
  gate.register(ws, 'actor'); gate.invalidateAll();
  expect(invalid).toHaveBeenCalledTimes(2); expect(invalid).not.toHaveBeenCalledWith(full);
});

it('a durable revision fences stale SQL even before this pod receives any notification', async () => {
  let release!: (rows: unknown) => void;
  let revision = 0;
  const query = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockResolvedValue([]);
  const invalid = vi.fn((ws: WebSocket) => gate.remove(ws));
  const gate = new ControlledBrowserReadGate('node', () => ({ query }) as unknown as Database, invalid, () => true, async () => revision);
  const ws = socket(); gate.register(ws, 'actor'); gate.send(ws, 'old-snapshot');
  await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
  revision++; release([{ actor_id: 'actor' }]);
  await vi.waitFor(() => expect(invalid).toHaveBeenCalledWith(ws));
  expect(ws.send).not.toHaveBeenCalled(); expect(query).toHaveBeenCalledTimes(2);
});
