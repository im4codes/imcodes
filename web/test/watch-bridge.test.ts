import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isNative: vi.fn(),
  syncSnapshot: vi.fn(),
  pushDurableEvent: vi.fn(),
  addListener: vi.fn(),
}));

describe('watch bridge wrappers', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.isNative.mockReset();
    mocks.syncSnapshot.mockReset();
    mocks.pushDurableEvent.mockReset();
    mocks.addListener.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function importWatchBridge() {
    vi.doMock('../src/native.js', () => ({
      isNative: mocks.isNative,
    }));
    vi.doMock('../src/plugins/watch-bridge.js', () => ({
      default: {
        syncSnapshot: mocks.syncSnapshot,
        pushDurableEvent: mocks.pushDurableEvent,
        addListener: mocks.addListener,
      },
    }));
    return import('../src/watch-bridge.js');
  }

  it('calls plugin on all platforms (try/catch handles non-native gracefully)', async () => {
    mocks.isNative.mockReturnValue(false);
    const { syncSnapshotToWatch, pushDurableEventToWatch } = await importWatchBridge();

    await syncSnapshotToWatch({
      v: 1,
      snapshotStatus: 'fresh',
      generatedAt: 1,
      currentServerId: 'srv-1',
      servers: [],
      sessions: [],
      apiKey: null,
    });

    await pushDurableEventToWatch({ type: 'session.error', project: 'proj', message: 'boom' });

    // Plugin is called — on real web it would throw (caught silently), on native it goes through
    expect(mocks.syncSnapshot).toHaveBeenCalled();
    expect(mocks.pushDurableEvent).toHaveBeenCalled();
  });

  it('loads the native plugin lazily and forwards snapshot/event calls', async () => {
    mocks.isNative.mockReturnValue(true);
    const remove = vi.fn().mockResolvedValue(undefined);
    const handler = vi.fn();
    mocks.addListener.mockResolvedValue({ remove });
    const { syncSnapshotToWatch, pushDurableEventToWatch, onWatchCommand } = await importWatchBridge();

    await syncSnapshotToWatch({
      v: 1,
      snapshotStatus: 'fresh',
      generatedAt: 10,
      currentServerId: 'srv-1',
      servers: [{ id: 'srv-1', name: 'Main', baseUrl: 'https://example.test' }],
      sessions: [],
      apiKey: 'watch-key',
    });

    await pushDurableEventToWatch({ type: 'session.notification', session: 'deck_sub_1', title: 'Hello', message: 'World' });

    const cleanup = await onWatchCommand(handler);
    expect(mocks.syncSnapshot).toHaveBeenCalledWith({
      context: {
        v: 1,
        snapshotStatus: 'fresh',
        generatedAt: 10,
        currentServerId: 'srv-1',
        servers: [{ id: 'srv-1', name: 'Main', baseUrl: 'https://example.test' }],
        sessions: [],
        apiKey: 'watch-key',
      },
    });
    expect(mocks.pushDurableEvent).toHaveBeenCalledWith({
      event: { type: 'session.notification', session: 'deck_sub_1', title: 'Hello', message: 'World' },
    });
    expect(mocks.addListener).toHaveBeenCalledWith('watchCommand', expect.any(Function));

    const listener = mocks.addListener.mock.calls[0]?.[1] as (command: { action: string }) => void;
    listener({ action: 'refresh' });
    expect(handler).toHaveBeenCalledWith({ action: 'refresh' });

    listener({ action: 'switchServer', serverId: 'srv-2' });
    expect(handler).toHaveBeenCalledWith({ action: 'switchServer', serverId: 'srv-2' });

    cleanup();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
