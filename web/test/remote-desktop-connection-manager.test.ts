import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_ERROR,
  REMOTE_DESKTOP_LIMITS,
  REMOTE_DESKTOP_STATE,
  type RemoteDesktopAccessMode,
} from '@shared/remote-desktop.js';
import {
  RemoteDesktopConnectionManager,
  remoteDesktopHostKey,
} from '../src/remote-desktop-connection-manager.js';
import type {
  RemoteDesktopClientHooks,
  RemoteDesktopSnapshot,
} from '../src/remote-desktop-client.js';

function snapshot(
  patch: Partial<RemoteDesktopSnapshot> = {},
): RemoteDesktopSnapshot {
  return {
    state: REMOTE_DESKTOP_STATE.AUTHORIZING,
    mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
    inputEpoch: 0,
    inputEnabled: false,
    displays: [],
    layoutRevision: 1,
    stream: null,
    durationMs: 0,
    reconnectCount: 0,
    ...patch,
  };
}

class FakeConnectionClient {
  readonly startAttempts: number[] = [];
  readonly lifecycle: string[] = [];
  readonly input: string[] = [];
  private value = snapshot();

  constructor(private readonly hooks: RemoteDesktopClientHooks) {}

  current(): Readonly<RemoteDesktopSnapshot> { return this.value; }
  async start(reconnectAttempt = 0): Promise<void> { this.startAttempts.push(reconnectAttempt); }
  emit(patch: Partial<RemoteDesktopSnapshot>): void {
    this.value = snapshot({ ...this.value, ...patch });
    this.hooks.onSnapshot(this.value);
  }
  setMode(_mode: RemoteDesktopAccessMode): void {}
  selectDisplay(_displayId: string): boolean { return true; }
  setDisplayMode(_displayId: string, _width: number, _height: number): boolean { return true; }
  setDisplayScale(_displayId: string, _dpiScalePercent: number): boolean { return true; }
  requestUnlock(): boolean { return true; }
  async requestRemoteClipboard(): Promise<string | null> { return null; }
  acknowledgePresentedFrame(_frameWidth: number, _frameHeight: number): boolean { return true; }
  pointerMove(_x: number, _y: number): void { this.input.push('pointer_move'); }
  pointerButton(
    _button: 'left' | 'middle' | 'right' | 'back' | 'forward',
    _down: boolean,
    _x?: number,
    _y?: number,
  ): boolean { this.input.push('pointer_button'); return true; }
  pointerClick(
    _button: 'left' | 'middle' | 'right' | 'back' | 'forward',
    _x?: number,
    _y?: number,
  ): boolean { this.input.push('pointer_click'); return true; }
  wheel(_deltaX: number, _deltaY: number, _x?: number, _y?: number): boolean { this.input.push('wheel'); return true; }
  key(
    _code: string,
    _key: string,
    _down: boolean,
    _repeat: boolean,
    _modifiers: { control: boolean; alt: boolean },
  ): boolean { this.input.push('key'); return true; }
  text(_value: string): boolean { this.input.push('text'); return true; }
  releaseAll(): void { this.lifecycle.push('release_all'); }
  releasePointerButtons(): void {}
  stop(): void {
    this.lifecycle.push('release_all', 'stop');
  }
}

function setupManager(): {
  manager: RemoteDesktopConnectionManager;
  clients: FakeConnectionClient[];
  peerAllocations: { current: number };
} {
  const clients: FakeConnectionClient[] = [];
  const peerAllocations = { current: 0 };
  const manager = new RemoteDesktopConnectionManager({
    createClient: (_serverId, hooks) => {
      // Each RemoteDesktopClient is the sole object that can allocate a peer.
      peerAllocations.current += 1;
      const client = new FakeConnectionClient(hooks);
      clients.push(client);
      return client;
    },
  });
  return { manager, clients, peerAllocations };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RemoteDesktopConnectionManager', () => {
  it('reuses one owner, start, and peer allocation when the same host is reopened', async () => {
    const { manager, clients, peerAllocations } = setupManager();
    const first = manager.connection({ serverId: 'endpoint-a', remoteDesktopHostId: 'host-1' });
    const reopened = manager.connection({ serverId: 'endpoint-a', remoteDesktopHostId: 'host-1' });
    await first.start();
    await reopened.start();

    expect(reopened).toBe(first);
    expect(peerAllocations.current).toBe(1);
    expect(clients[0].startAttempts).toEqual([0]);
  });

  it('uses canonical host identity and replaces a changed execution endpoint without overlap', async () => {
    const { manager, clients, peerAllocations } = setupManager();
    const first = manager.connection({
      serverId: 'endpoint-a',
      remoteDesktopHostId: 'host-canonical',
    });
    await first.start();
    const linkedEndpoint = manager.connection({
      serverId: 'endpoint-b',
      remoteDesktopHostId: 'host-canonical',
    });

    expect(first).toBe(linkedEndpoint);
    expect(first.serverId).toBe('endpoint-b');
    await linkedEndpoint.start();

    expect(peerAllocations.current).toBe(2);
    expect(clients).toHaveLength(2);
    expect(clients[0].startAttempts).toEqual([0]);
    expect(clients[0].lifecycle).toEqual(['release_all', 'stop']);
    expect(clients[1].startAttempts).toEqual([0]);
    expect(clients[1].lifecycle).toEqual([]);
    expect(remoteDesktopHostKey({ serverId: 'fallback' })).toBe('fallback');
  });

  it('survives presentation unmount and remount without renegotiating', async () => {
    const { manager, clients } = setupManager();
    const connection = manager.connection({ serverId: 'server-a' });
    const firstSnapshots: RemoteDesktopSnapshot[] = [];
    const firstPresentation = {};
    const detachFirst = connection.subscribe(
      firstPresentation,
      (value) => { firstSnapshots.push(value); },
      { controlsInput: true },
    );
    await connection.start();
    clients[0].emit({
      state: REMOTE_DESKTOP_STATE.DIRECT,
      inputEnabled: true,
    });

    detachFirst();
    const remountedSnapshots: RemoteDesktopSnapshot[] = [];
    const detachRemounted = connection.subscribe(
      {},
      (value) => { remountedSnapshots.push(value); },
      { controlsInput: true },
    );
    await connection.start();

    expect(clients).toHaveLength(1);
    expect(clients[0].startAttempts).toEqual([0]);
    expect(clients[0].lifecycle).toEqual(['release_all']);
    expect(firstSnapshots.at(-1)?.state).toBe(REMOTE_DESKTOP_STATE.DIRECT);
    expect(remountedSnapshots[0]?.state).toBe(REMOTE_DESKTOP_STATE.DIRECT);
    detachRemounted();
  });

  it('reconnects one host in place while leaving sibling hosts untouched', async () => {
    vi.useFakeTimers();
    const { manager, clients } = setupManager();
    const first = manager.connection({ serverId: 'server-a' });
    const sibling = manager.connection({ serverId: 'server-b' });
    const observed: RemoteDesktopSnapshot[] = [];
    first.subscribe({}, (value) => observed.push(value));
    await first.start();
    await sibling.start();

    clients[0].emit({
      state: REMOTE_DESKTOP_STATE.FAILED,
      error: REMOTE_DESKTOP_ERROR.DAEMON_OFFLINE,
    });
    expect(observed.at(-1)).toMatchObject({
      state: REMOTE_DESKTOP_STATE.RECONNECTING,
      reconnectCount: 1,
    });

    await vi.advanceTimersByTimeAsync(REMOTE_DESKTOP_LIMITS.RECONNECT_BACKOFF_BASE_MS);

    expect(clients).toHaveLength(3);
    expect(clients[0].lifecycle).toEqual(['release_all', 'stop']);
    expect(clients[1].lifecycle).toEqual([]);
    expect(clients[1].startAttempts).toEqual([0]);
    expect(clients[2].startAttempts).toEqual([1]);
    clients[0].emit({ state: REMOTE_DESKTOP_STATE.DIRECT });
    expect(observed.at(-1)?.state).toBe(REMOTE_DESKTOP_STATE.RECONNECTING);
    clients[2].emit({ state: REMOTE_DESKTOP_STATE.RELAYED });
    expect(observed.at(-1)?.state).toBe(REMOTE_DESKTOP_STATE.RELAYED);
  });

  it('replaces a failed generation once and keeps the presentation subscription', async () => {
    const { manager, clients } = setupManager();
    const connection = manager.connection({ serverId: 'server-a' });
    const observed: RemoteDesktopSnapshot[] = [];
    connection.subscribe({}, (value) => observed.push(value));
    await connection.start();

    connection.retry();
    connection.retry();

    expect(clients).toHaveLength(3);
    expect(clients[0].lifecycle).toEqual(['release_all', 'stop']);
    expect(clients[1].lifecycle).toEqual(['release_all', 'stop']);
    expect(clients[2].startAttempts).toEqual([1]);
    clients[1].emit({ state: REMOTE_DESKTOP_STATE.DIRECT });
    expect(observed.at(-1)?.state).toBe(REMOTE_DESKTOP_STATE.RECONNECTING);
    clients[2].emit({ state: REMOTE_DESKTOP_STATE.DIRECT });
    expect(observed.at(-1)?.state).toBe(REMOTE_DESKTOP_STATE.DIRECT);
  });

  it('releases held input exactly before presentation ownership moves', () => {
    const { manager, clients } = setupManager();
    const connection = manager.connection({ serverId: 'server-a' });
    const firstPresentation = {};
    const secondPresentation = {};
    const detachFirst = connection.subscribe(firstPresentation, () => {}, {
      controlsInput: true,
    });

    const detachSecond = connection.subscribe(secondPresentation, () => {}, {
      controlsInput: true,
    });
    expect(clients[0].lifecycle).toEqual(['release_all']);

    detachFirst();
    expect(clients[0].lifecycle).toEqual(['release_all']);
    detachSecond();
    expect(clients[0].lifecycle).toEqual(['release_all', 'release_all']);
  });

  it('rejects background-tab input through presentation-scoped handles', () => {
    const { manager, clients } = setupManager();
    const firstPresentation = {};
    const secondPresentation = {};
    const first = manager.presentation({ serverId: 'server-a' }, firstPresentation);
    const second = manager.presentation({ serverId: 'server-a' }, secondPresentation);
    const detachFirst = first.subscribe(firstPresentation, () => {}, { controlsInput: true });
    first.pointerMove(0.1, 0.2);
    const detachSecond = second.subscribe(secondPresentation, () => {}, { controlsInput: true });

    first.pointerMove(0.3, 0.4);
    expect(first.text('hidden')).toBe(false);
    expect(second.text('active')).toBe(true);
    expect(clients[0].input).toEqual(['pointer_move', 'text']);
    expect(clients[0].lifecycle).toEqual(['release_all']);

    detachFirst();
    detachSecond();
  });

  it('releases the active input ledger once before a workspace tab switch', () => {
    const { manager, clients } = setupManager();
    const presentation = {};
    const connection = manager.presentation({ serverId: 'server-a' }, presentation);
    const detach = connection.subscribe(presentation, () => {}, { controlsInput: true });

    manager.releaseInput('server-a');
    detach();

    expect(clients[0].lifecycle).toEqual(['release_all']);
    expect(connection.text('background')).toBe(false);
  });

  it('owns exact release_all and Stop cleanup for each host', async () => {
    const { manager, clients } = setupManager();
    const connection = manager.connection({ serverId: 'server-a' });
    await connection.start();

    connection.stop();
    connection.stop();
    manager.stop({ serverId: 'server-a' });

    expect(clients[0].lifecycle).toEqual(['release_all', 'stop']);
    expect(manager.connection({ serverId: 'server-a' })).not.toBe(connection);
    expect(clients).toHaveLength(2);
  });
});
