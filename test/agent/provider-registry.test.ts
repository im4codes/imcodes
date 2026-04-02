import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { mockConnect, mockDisconnect, MockOpenClawProvider, MockQwenProvider } = vi.hoisted(() => {
  const mockConnect = vi.fn().mockResolvedValue(undefined);
  const mockDisconnect = vi.fn().mockResolvedValue(undefined);
  const MockOpenClawProvider = vi.fn().mockImplementation(() => ({
    id: 'openclaw',
    connectionMode: 'persistent',
    sessionOwnership: 'provider',
    capabilities: {
      streaming: true,
      toolCalling: true,
      approval: true,
      sessionRestore: true,
      multiTurn: true,
      attachments: false,
    },
    connect: mockConnect,
    disconnect: mockDisconnect,
    send: vi.fn().mockResolvedValue(undefined),
    onDelta: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
    createSession: vi.fn().mockResolvedValue('session-1'),
    endSession: vi.fn().mockResolvedValue(undefined),
  }));
  const MockQwenProvider = vi.fn().mockImplementation(() => ({
    id: 'qwen',
    connectionMode: 'local-sdk',
    sessionOwnership: 'shared',
    capabilities: {
      streaming: true,
      toolCalling: false,
      approval: false,
      sessionRestore: true,
      multiTurn: true,
      attachments: false,
    },
    connect: mockConnect,
    disconnect: mockDisconnect,
    send: vi.fn().mockResolvedValue(undefined),
    onDelta: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
    createSession: vi.fn().mockResolvedValue('session-1'),
    endSession: vi.fn().mockResolvedValue(undefined),
  }));
  return { mockConnect, mockDisconnect, MockOpenClawProvider, MockQwenProvider };
});

vi.mock('../../src/agent/providers/openclaw.js', () => ({
  OpenClawProvider: MockOpenClawProvider,
}));

vi.mock('../../src/agent/providers/qwen.js', () => ({
  QwenProvider: MockQwenProvider,
}));

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  getProvider,
  getAllProviders,
  connectProvider,
  disconnectProvider,
  disconnectAll,
} from '../../src/agent/provider-registry.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const CONFIG = { url: 'ws://localhost:4000', apiKey: 'test-key' };

// Clean registry state between tests by disconnecting anything connected.
beforeEach(async () => {
  await disconnectAll();
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getProvider', () => {
  it('returns undefined before any provider is connected', () => {
    expect(getProvider('openclaw')).toBeUndefined();
  });

  it('returns the provider after connectProvider()', async () => {
    await connectProvider('openclaw', CONFIG);
    const provider = getProvider('openclaw');
    expect(provider).toBeDefined();
    expect(provider!.id).toBe('openclaw');
  });

  it('returns qwen after connectProvider()', async () => {
    await connectProvider('qwen', CONFIG);
    const provider = getProvider('qwen');
    expect(provider).toBeDefined();
    expect(provider!.id).toBe('qwen');
  });

  it('returns undefined for an unknown id', () => {
    expect(getProvider('minimax')).toBeUndefined();
  });
});

describe('connectProvider', () => {
  it('instantiates OpenClawProvider and calls connect()', async () => {
    await connectProvider('openclaw', CONFIG);
    expect(MockOpenClawProvider).toHaveBeenCalledOnce();
    expect(mockConnect).toHaveBeenCalledOnce();
    expect(mockConnect).toHaveBeenCalledWith(CONFIG);
  });

  it('instantiates QwenProvider and calls connect()', async () => {
    await connectProvider('qwen', CONFIG);
    expect(MockQwenProvider).toHaveBeenCalledOnce();
    expect(mockConnect).toHaveBeenCalledWith(CONFIG);
  });

  it('throws for an unknown provider id', async () => {
    await expect(connectProvider('unknown-provider', CONFIG)).rejects.toThrow(
      'Unknown provider: unknown-provider',
    );
  });

  it('disconnects the existing instance when connecting the same id twice', async () => {
    await connectProvider('openclaw', CONFIG);
    expect(MockOpenClawProvider).toHaveBeenCalledTimes(1);

    await connectProvider('openclaw', CONFIG);
    // First instance should have been disconnected before the second was created
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    // Two instances created in total
    expect(MockOpenClawProvider).toHaveBeenCalledTimes(2);
    // connect() called once per instance
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });
});

describe('getAllProviders', () => {
  it('returns an empty array when nothing is connected', () => {
    expect(getAllProviders()).toEqual([]);
  });

  it('returns all connected providers', async () => {
    await connectProvider('openclaw', CONFIG);
    const all = getAllProviders();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('openclaw');
  });
});

describe('disconnectProvider', () => {
  it('calls disconnect() and removes the provider from the registry', async () => {
    await connectProvider('openclaw', CONFIG);
    expect(getProvider('openclaw')).toBeDefined();

    await disconnectProvider('openclaw');
    expect(mockDisconnect).toHaveBeenCalledOnce();
    expect(getProvider('openclaw')).toBeUndefined();
  });

  it('is a no-op when the provider is not registered', async () => {
    // Should not throw
    await expect(disconnectProvider('openclaw')).resolves.toBeUndefined();
    expect(mockDisconnect).not.toHaveBeenCalled();
  });
});

describe('disconnectAll', () => {
  it('disconnects every connected provider', async () => {
    await connectProvider('openclaw', CONFIG);
    expect(getAllProviders()).toHaveLength(1);

    await disconnectAll();
    expect(mockDisconnect).toHaveBeenCalledOnce();
    expect(getAllProviders()).toHaveLength(0);
  });

  it('is safe to call when nothing is connected', async () => {
    await expect(disconnectAll()).resolves.toBeUndefined();
  });
});
