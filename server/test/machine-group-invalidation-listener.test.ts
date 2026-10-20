import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/client.js';
import type { MachineGroupInvalidationRuntime } from '../src/services/machine-group-invalidation.js';
import { MACHINE_GROUP_INVALIDATION as POLICY } from '../../shared/machine-group-invalidation.js';

const runtimes: MachineGroupInvalidationRuntime[] = [];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

class Client extends EventEmitter {
  static instances: Client[] = [];
  connect = vi.fn(async () => {});
  query = vi.fn(async (_sql: string) => {});
  end = vi.fn(async () => {});
  constructor(readonly options: { connectionString: string; application_name: string }) {
    super();
    Client.instances.push(this);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  Client.instances = [];
});
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  expect(vi.getTimerCount()).toBe(0);
  vi.doUnmock('pg');
  vi.useRealTimers();
});

async function fixture() {
  const db = {
    execute: vi.fn(async () => ({ changes: 1 })),
    query: vi.fn(async () => []),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  } as unknown as Database;
  const { MachineGroupInvalidationRuntime, machineGroupInvalidationReady } =
    await import('../src/services/machine-group-invalidation.js');
  const fenced = vi.fn();
  const runtime = new MachineGroupInvalidationRuntime(db, async () => {}, fenced, 'postgres://test-only');
  runtimes.push(runtime);
  return { runtime, db, fenced, ready: () => machineGroupInvalidationReady(db) };
}

it('loads the driver only for LISTEN, preserves notification wake and retries connection failure', async () => {
  const loaded = vi.fn(() => ({ default: { Client } }));
  vi.doMock('pg', loaded);
  const { runtime, db, ready } = await fixture();
  expect(loaded).not.toHaveBeenCalled();
  await runtime.start();
  await vi.waitFor(() => expect(Client.instances[0]?.query).toHaveBeenCalledWith(`LISTEN ${POLICY.CHANNEL}`));
  expect(ready()).toBe(true);
  expect(Client.instances[0].options.application_name).toBe(`${POLICY.LISTENER_APPLICATION_PREFIX}${runtime.receiverId}`);
  const before = vi.mocked(db.query).mock.calls.length;
  Client.instances[0].emit('notification', { channel: POLICY.CHANNEL });
  await vi.waitFor(() => expect(vi.mocked(db.query).mock.calls.length).toBeGreaterThan(before));
  Client.instances[0].emit('error', new Error('connection lost'));
  await vi.advanceTimersByTimeAsync(POLICY.POLL_MS);
  await vi.waitFor(() => expect(Client.instances[1]?.query).toHaveBeenCalledWith(`LISTEN ${POLICY.CHANNEL}`));
  expect(Client.instances[0].end).toHaveBeenCalled();
});

it('contains driver import rejection while durable polling remains authoritative and stop cancels retry', async () => {
  const attempted = deferred();
  vi.doMock('pg', () => { attempted.resolve(); throw new Error('driver unavailable'); });
  const { runtime, db, ready } = await fixture();
  await runtime.start();
  await attempted.promise;
  await vi.waitFor(() => expect(vi.getTimerCount()).toBe(2));
  expect(ready()).toBe(true);
  const before = vi.mocked(db.query).mock.calls.length;
  await vi.advanceTimersByTimeAsync(POLICY.POLL_MS);
  expect(vi.mocked(db.query).mock.calls.length).toBeGreaterThan(before);
  expect(Client.instances).toEqual([]);
  await runtime.stop();
  await vi.advanceTimersByTimeAsync(POLICY.POLL_MS * 2);
  expect(ready()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not create a client when stop wins the asynchronous import', async () => {
  const entered = deferred(), release = deferred();
  vi.doMock('pg', async () => { entered.resolve(); await release.promise; return { default: { Client } }; });
  const { runtime, ready } = await fixture();
  await runtime.start();
  await entered.promise;
  try { await runtime.stop(); expect(ready()).toBe(false); }
  finally { release.resolve(); }
  await vi.advanceTimersByTimeAsync(POLICY.POLL_MS * 2);
  expect(Client.instances).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it('discards an old import after stop/start rather than installing two listeners', async () => {
  const entered = deferred(), release = deferred();
  vi.doMock('pg', async () => { entered.resolve(); await release.promise; return { default: { Client } }; });
  const { runtime, ready } = await fixture();
  await runtime.start();
  await entered.promise;
  try { await runtime.stop(); await runtime.start(); }
  finally { release.resolve(); }
  await vi.waitFor(() => expect(Client.instances[0]?.query).toHaveBeenCalledWith(`LISTEN ${POLICY.CHANNEL}`));
  expect(Client.instances).toHaveLength(1);
  expect(ready()).toBe(true);
  expect(vi.getTimerCount()).toBe(1);
});

it('contains a failed connect and retains the bounded notification retry', async () => {
  class FailingClient extends Client {
    override connect = vi.fn(async () => { throw new Error('connection unavailable'); });
  }
  vi.doMock('pg', () => ({ default: { Client: FailingClient } }));
  const { runtime, ready } = await fixture();
  await runtime.start();
  await vi.waitFor(() => expect(Client.instances[0]?.end).toHaveBeenCalled());
  expect(Client.instances[0].query).not.toHaveBeenCalled();
  expect(ready()).toBe(true);
  await vi.advanceTimersByTimeAsync(POLICY.POLL_MS);
  await vi.waitFor(() => expect(Client.instances[1]?.end).toHaveBeenCalled());
  expect(Client.instances).toHaveLength(2);
  await runtime.stop();
  await vi.advanceTimersByTimeAsync(POLICY.POLL_MS * 2);
  expect(Client.instances).toHaveLength(2);
});

it('closes a client but never starts LISTEN or retry when stop wins connect', async () => {
  const entered = deferred(), release = deferred();
  class SlowClient extends Client {
    override connect = vi.fn(async () => { entered.resolve(); await release.promise; });
  }
  vi.doMock('pg', () => ({ default: { Client: SlowClient } }));
  const { runtime, ready } = await fixture();
  await runtime.start();
  await entered.promise;
  try { await runtime.stop(); }
  finally { release.resolve(); }
  await vi.advanceTimersByTimeAsync(POLICY.POLL_MS * 2);
  expect(ready()).toBe(false);
  expect(Client.instances).toHaveLength(1);
  expect(Client.instances[0].end).toHaveBeenCalled();
  expect(Client.instances[0].query).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
