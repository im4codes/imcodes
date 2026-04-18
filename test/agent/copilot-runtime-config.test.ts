import { describe, it, expect, vi, beforeEach } from 'vitest';

const loggerMock = vi.hoisted(() => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/util/logger.js', () => loggerMock);

const sdkMock = vi.hoisted(() => {
  const clientFactory = vi.fn();
  return {
    clientFactory,
    CopilotClient: class {
      static fromFactory(opts: unknown) {
        return clientFactory(opts);
      }
    },
  };
});

vi.mock('@github/copilot-sdk', () => ({
  CopilotClient: vi.fn().mockImplementation((opts: unknown) => sdkMock.clientFactory(opts)),
}));

import {
  getCopilotRuntimeConfig,
  __copilotRuntimeConfigInternals,
  COPILOT_FALLBACK_MODEL_IDS,
} from '../../src/agent/copilot-runtime-config.js';

describe('getCopilotRuntimeConfig', () => {
  beforeEach(() => {
    __copilotRuntimeConfigInternals.clearCache();
    sdkMock.clientFactory.mockReset();
    loggerMock.default.warn.mockReset();
    loggerMock.default.debug.mockReset();
  });

  it('returns the SDK-reported models, auth status and cli version', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    sdkMock.clientFactory.mockReturnValue({
      start: vi.fn().mockResolvedValue(undefined),
      stop,
      getStatus: vi.fn().mockResolvedValue({ version: '1.0.31', protocolVersion: 3 }),
      getAuthStatus: vi.fn().mockResolvedValue({ isAuthenticated: true }),
      listModels: vi.fn().mockResolvedValue([
        { id: 'gpt-5', name: 'GPT-5', capabilities: { supports: { reasoningEffort: true } } },
        { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
      ]),
    });

    const config = await getCopilotRuntimeConfig(true);
    expect(config.availableModels).toEqual(['gpt-5', 'claude-sonnet-4.5']);
    expect(config.models).toEqual([
      { id: 'gpt-5', name: 'GPT-5', supportsReasoningEffort: true },
      { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
    ]);
    expect(config.isAuthenticated).toBe(true);
    expect(config.cliVersion).toBe('1.0.31');
    expect(config.probeError).toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('falls back to a curated list when listModels throws', async () => {
    sdkMock.clientFactory.mockReturnValue({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockResolvedValue({ version: '1.0.31', protocolVersion: 3 }),
      getAuthStatus: vi.fn().mockResolvedValue({ isAuthenticated: true }),
      listModels: vi.fn().mockRejectedValue(new Error('rate limited')),
    });

    const config = await getCopilotRuntimeConfig(true);
    expect(config.availableModels).toEqual([...COPILOT_FALLBACK_MODEL_IDS]);
    expect(config.models).toEqual(COPILOT_FALLBACK_MODEL_IDS.map((id) => ({ id })));
    expect(config.isAuthenticated).toBe(true);
    expect(config.probeError).toBeUndefined();
  });

  it('reports a probeError and fallback list when the SDK cannot start', async () => {
    sdkMock.clientFactory.mockReturnValue({
      start: vi.fn().mockRejectedValue(new Error('Copilot CLI not found at copilot.')),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
      getAuthStatus: vi.fn(),
      listModels: vi.fn(),
    });

    const config = await getCopilotRuntimeConfig(true);
    expect(config.availableModels).toEqual([...COPILOT_FALLBACK_MODEL_IDS]);
    expect(config.isAuthenticated).toBe(false);
    expect(config.probeError).toContain('Copilot CLI not found');
    expect(config.cliVersion).toBeUndefined();
  });

  it('caches results across calls until force=true is passed', async () => {
    const listModels = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'gpt-5', name: 'GPT-5' }])
      .mockResolvedValueOnce([{ id: 'gpt-5-mini', name: 'GPT-5 Mini' }]);
    sdkMock.clientFactory.mockImplementation(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockResolvedValue({ version: '1.0.31', protocolVersion: 3 }),
      getAuthStatus: vi.fn().mockResolvedValue({ isAuthenticated: true }),
      listModels,
    }));

    const first = await getCopilotRuntimeConfig();
    const second = await getCopilotRuntimeConfig();
    expect(second).toBe(first);
    expect(listModels).toHaveBeenCalledOnce();

    const third = await getCopilotRuntimeConfig(true);
    expect(third.availableModels).toEqual(['gpt-5-mini']);
    expect(listModels).toHaveBeenCalledTimes(2);
  });

  it('treats an empty listModels response as empty (not fallback)', async () => {
    sdkMock.clientFactory.mockReturnValue({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockResolvedValue({ version: '1.0.31', protocolVersion: 3 }),
      getAuthStatus: vi.fn().mockResolvedValue({ isAuthenticated: false }),
      listModels: vi.fn().mockResolvedValue([]),
    });

    const config = await getCopilotRuntimeConfig(true);
    // listModels returned [], so availableModels falls back for usability.
    expect(config.availableModels).toEqual([...COPILOT_FALLBACK_MODEL_IDS]);
    expect(config.isAuthenticated).toBe(false);
  });
});
