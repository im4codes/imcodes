import { describe, it, expect, vi, beforeEach } from 'vitest';

const childProcessMock = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: childProcessMock.execFile,
}));

vi.mock('node:fs/promises', () => ({
  readFile: fsMock.readFile,
}));

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { getQwenRuntimeConfig } from '../../src/agent/qwen-runtime-config.js';
import { QWEN_AUTH_TYPES } from '../../shared/qwen-auth.js';

describe('getQwenRuntimeConfig', () => {
  beforeEach(() => {
    childProcessMock.execFile.mockReset();
    fsMock.readFile.mockReset();
  });

  it('detects Qwen OAuth from settings with coder-model only', async () => {
    childProcessMock.execFile.mockImplementation((...args: any[]) => {
      const cb = args.at(-1);
      cb?.(new Error('status unavailable'), '', '');
      return {} as never;
    });
    fsMock.readFile.mockResolvedValue(JSON.stringify({
      security: { auth: { selectedType: 'qwen-oauth' } },
    }));

    const config = await getQwenRuntimeConfig(true);
    expect(config.authType).toBe(QWEN_AUTH_TYPES.OAUTH);
    expect(config.availableModels).toEqual(['coder-model']);
  });

  it('detects Coding Plan from settings and returns Coding Plan models', async () => {
    childProcessMock.execFile.mockImplementation((...args: any[]) => {
      const cb = args.at(-1);
      cb?.(new Error('status unavailable'), '', '');
      return {} as never;
    });
    fsMock.readFile.mockResolvedValue(JSON.stringify({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: {
        openai: [
          { id: 'qwen3-coder-plus', envKey: 'BAILIAN_CODING_PLAN_API_KEY', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1' },
        ],
      },
    }));

    const config = await getQwenRuntimeConfig(true);
    expect(config.authType).toBe(QWEN_AUTH_TYPES.CODING_PLAN);
    expect(config.availableModels).toContain('qwen3-coder-plus');
    expect(config.availableModels).toContain('glm-4.7');
  });

  it('falls back to settings.json for API-key model lists', async () => {
    childProcessMock.execFile.mockImplementation((...args: any[]) => {
      const cb = args.at(-1);
      cb?.(new Error('status unavailable'), '', '');
      return {} as never;
    });
    fsMock.readFile.mockResolvedValue(JSON.stringify({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: {
        openai: [
          { id: 'gpt-4.1', envKey: 'OPENAI_API_KEY' },
          { id: 'qwen3-coder-plus', envKey: 'DASHSCOPE_API_KEY' },
        ],
      },
    }));

    const config = await getQwenRuntimeConfig(true);
    expect(config.authType).toBe(QWEN_AUTH_TYPES.API_KEY);
    expect(config.availableModels).toEqual(['gpt-4.1', 'qwen3-coder-plus']);
  });

  it('reads auth limit from qwen auth status output', async () => {
    childProcessMock.execFile.mockImplementation((...args: any[]) => {
      const cb = args.at(-1);
      cb?.(null, [
        'Authentication Method: Qwen OAuth',
        'Type: Free tier',
        'Limit: Up to 1,000 requests/day',
      ].join('\n'), '');
      return {} as never;
    });
    fsMock.readFile.mockResolvedValue(JSON.stringify({
      security: { auth: { selectedType: 'qwen-oauth' } },
    }));

    const config = await getQwenRuntimeConfig(true);
    expect(config.authType).toBe(QWEN_AUTH_TYPES.OAUTH);
    expect(config.authLimit).toBe('Up to 1,000 requests/day');
  });
});
