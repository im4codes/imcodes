import { afterEach, describe, expect, it, vi } from 'vitest';

const pgMock = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  class Client {
    static instances: Client[] = [];
    readonly handlers = new Map<string, Handler[]>();
    readonly query = vi.fn(async () => ({ rows: [] }));
    readonly connect = vi.fn(async () => undefined);
    readonly end = vi.fn(async () => undefined);

    constructor(readonly options: { connectionString: string }) {
      Client.instances.push(this);
    }

    on(event: string, handler: Handler): this {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
      return this;
    }

    emit(event: string, value?: unknown): void {
      for (const handler of this.handlers.get(event) ?? []) handler(value);
    }
  }
  return { Client };
});

vi.mock('pg', () => ({ default: { Client: pgMock.Client } }));

import {
  PostgresRemoteDesktopGuestOutboxListener,
} from '../src/services/remote-desktop-guest-outbox-worker.js';
import {
  REMOTE_DESKTOP_GUEST_OUTBOX_CHANNEL,
} from '../src/services/remote-desktop-guest-authority.js';

describe('remote desktop guest outbox LISTEN connection', () => {
  afterEach(() => {
    vi.useRealTimers();
    pgMock.Client.instances.length = 0;
  });

  it('uses a dedicated client, filters the channel and reconnects without disabling polling', async () => {
    vi.useFakeTimers();
    const wake = vi.fn();
    const onError = vi.fn();
    const listener = new PostgresRemoteDesktopGuestOutboxListener(
      'postgres://listener-only', 100,
    );
    await listener.start(wake, onError);
    const first = pgMock.Client.instances[0]!;
    expect(first.options).toEqual({ connectionString: 'postgres://listener-only' });
    expect(first.connect).toHaveBeenCalledOnce();
    expect(first.query).toHaveBeenCalledWith(`LISTEN ${REMOTE_DESKTOP_GUEST_OUTBOX_CHANNEL}`);

    first.emit('notification', { channel: 'other_channel' });
    expect(wake).not.toHaveBeenCalled();
    first.emit('notification', { channel: REMOTE_DESKTOP_GUEST_OUTBOX_CHANNEL });
    expect(wake).toHaveBeenCalledOnce();

    first.emit('error', new Error('listener connection lost'));
    await vi.advanceTimersByTimeAsync(100);
    expect(onError).toHaveBeenCalledOnce();
    expect(first.end).toHaveBeenCalledOnce();
    expect(pgMock.Client.instances).toHaveLength(2);
    expect(pgMock.Client.instances[1]?.query)
      .toHaveBeenCalledWith(`LISTEN ${REMOTE_DESKTOP_GUEST_OUTBOX_CHANNEL}`);

    await listener.stop();
    expect(pgMock.Client.instances[1]?.end).toHaveBeenCalledOnce();
  });
});
