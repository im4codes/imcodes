import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

const childProcessMock = vi.hoisted(() => {
  type Request = { id?: number; method?: string; params?: Record<string, any> };
  type ChildRecord = {
    child: EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: Writable;
      killed: boolean;
      kill: (signal?: string) => boolean;
    };
    requests: Request[];
    emits: (msg: Record<string, any>) => void;
  };

  const children: ChildRecord[] = [];

  const spawn = vi.fn(() => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let childRecord!: ChildRecord;
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          const msg = JSON.parse(line) as Request;
          childRecord.requests.push(msg);
          if (msg.method === 'initialize' && typeof msg.id === 'number') {
            childRecord.emits({ id: msg.id, result: { userAgent: 'test' } });
          }
          if (msg.method === 'account/rateLimits/read' && typeof msg.id === 'number') {
            childRecord.emits({
              id: msg.id,
              result: {
                rateLimits: {
                  planType: 'pro',
                  primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_750_000_000_000 },
                },
              },
            });
          }
          if (msg.method === 'model/list' && typeof msg.id === 'number') {
            if (msg.params?.cursor === 'page-2') {
              childRecord.emits({
                id: msg.id,
                result: {
                  data: [
                    {
                      id: 'mod-2',
                      model: 'gpt-5.4-mini',
                      displayName: 'GPT-5.4 Mini',
                      supportedReasoningEfforts: [],
                      isDefault: false,
                    },
                  ],
                  nextCursor: null,
                },
              });
            } else {
              childRecord.emits({
                id: msg.id,
                result: {
                  data: [
                    {
                      id: 'mod-1',
                      model: 'gpt-5.5',
                      displayName: 'GPT-5.5',
                      supportedReasoningEfforts: ['low', 'medium', 'high'],
                      isDefault: true,
                    },
                  ],
                  nextCursor: 'page-2',
                },
              });
            }
          }
        }
        cb();
      },
    });
    const child = new EventEmitter() as ChildRecord['child'];
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = stdin;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      child.emit('exit', 0);
      return true;
    };
    childRecord = {
      child,
      requests: [],
      emits: (msg: Record<string, any>) => {
        stdout.write(`${JSON.stringify(msg)}\n`);
      },
    };
    children.push(childRecord);
    return child;
  });

  return { spawn, children };
});

const providerRegistryMock = vi.hoisted(() => ({
  getProvider: vi.fn(() => undefined),
}));

const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(async (_path: string, _enc?: string) => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
}));

vi.mock('node:child_process', () => ({
  spawn: childProcessMock.spawn,
}));

vi.mock('node:fs/promises', () => ({
  readFile: fsMock.readFile,
}));

vi.mock('../../src/util/kill-process-tree.js', () => ({
  killProcessTree: vi.fn(),
}));

vi.mock('../../src/agent/provider-registry.js', () => ({
  getProvider: providerRegistryMock.getProvider,
}));

import { getCodexRuntimeConfig, getCodexBaseInstructions } from '../../src/agent/codex-runtime-config.js';

describe('getCodexRuntimeConfig', () => {
  beforeEach(() => {
    childProcessMock.spawn.mockClear();
    childProcessMock.children.length = 0;
    providerRegistryMock.getProvider.mockReset();
    providerRegistryMock.getProvider.mockReturnValue(undefined);
    fsMock.readFile.mockReset();
    fsMock.readFile.mockImplementation(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
  });

  it('discovers codex models through app-server pagination and exposes a default model', async () => {
    const config = await getCodexRuntimeConfig(true);
    expect(config.availableModels).toEqual(['gpt-5.5', 'gpt-5.4-mini']);
    expect(config.defaultModel).toBe('gpt-5.5');
    expect(config.models).toEqual([
      { id: 'gpt-5.5', name: 'GPT-5.5', supportsReasoningEffort: true, isDefault: true },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
    ]);
    expect(config.planLabel).toBe('Pro');
    expect(config.isAuthenticated).toBe(true);
    expect(childProcessMock.spawn).toHaveBeenCalledTimes(2);
  });

  it('returns codex-cached base_instructions on exact slug match', async () => {
    fsMock.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('models_cache.json')) {
        return JSON.stringify({
          fetched_at: '2026-04-27T14:27:08.608161Z',
          models: [
            { slug: 'gpt-5.5', base_instructions: 'You are Codex (5.5 prompt) ...' },
            { slug: 'gpt-5.4', base_instructions: 'You are Codex (5.4 prompt) ...' },
            { slug: 'broken-no-prompt', base_instructions: '' },
          ],
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    expect(await getCodexBaseInstructions('gpt-5.5')).toBe('You are Codex (5.5 prompt) ...');
    expect(await getCodexBaseInstructions('GPT-5.4')).toBe('You are Codex (5.4 prompt) ...');
  });

  it('falls back to the newest cached prompt when the requested model is not yet in the catalog', async () => {
    // Simulates a brand-new model (e.g. `gpt-5.6`) that codex CLI has not
    // refreshed the catalog for yet. Rather than dropping to a 200-char
    // provider-neutral fallback, we reuse the newest known prompt
    // (models[0] — codex orders newest first) so quality stays close.
    fsMock.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('models_cache.json')) {
        return JSON.stringify({
          fetched_at: '2026-04-27T14:27:08.608161Z',
          models: [
            { slug: 'gpt-5.5', base_instructions: 'You are Codex (5.5 prompt) ...' },
            { slug: 'gpt-5.4', base_instructions: 'You are Codex (5.4 prompt) ...' },
          ],
        });
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    expect(await getCodexBaseInstructions('gpt-5.6')).toBe('You are Codex (5.5 prompt) ...');
    expect(await getCodexBaseInstructions('codex-MiniMax-M2.5'))
      .toBe('You are Codex (5.5 prompt) ...');
    expect(await getCodexBaseInstructions(undefined)).toBe('You are Codex (5.5 prompt) ...');
    expect(await getCodexBaseInstructions('broken-no-prompt'))
      .toBe('You are Codex (5.5 prompt) ...');
  });

  it('returns undefined for every model when models_cache.json is missing or unreadable', async () => {
    // Advance time past the in-memory TTL (30s) so the cache from the
    // previous test does not leak across tests.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_000);
    try {
      expect(await getCodexBaseInstructions('gpt-5.5')).toBeUndefined();
      expect(await getCodexBaseInstructions('gpt-5.4')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses the connected singleton provider when available', async () => {
    providerRegistryMock.getProvider.mockReturnValue({
      readModelList: vi.fn().mockResolvedValue([
        { id: 'gpt-5.5', name: 'GPT-5.5', isDefault: true },
        { id: 'gpt-5.4-mini' },
      ]),
      readRateLimits: vi.fn().mockResolvedValue({
        planType: 'enterprise',
      }),
    });

    const config = await getCodexRuntimeConfig(true);
    expect(config.availableModels).toEqual(['gpt-5.5', 'gpt-5.4-mini']);
    expect(config.defaultModel).toBe('gpt-5.5');
    expect(config.planLabel).toBe('Enterprise');
    expect(childProcessMock.spawn).not.toHaveBeenCalled();
  });
});
