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

vi.mock('node:child_process', () => ({
  spawn: childProcessMock.spawn,
}));

vi.mock('../../src/util/kill-process-tree.js', () => ({
  killProcessTree: vi.fn(),
}));

vi.mock('../../src/agent/provider-registry.js', () => ({
  getProvider: providerRegistryMock.getProvider,
}));

import { getCodexRuntimeConfig } from '../../src/agent/codex-runtime-config.js';

describe('getCodexRuntimeConfig', () => {
  beforeEach(() => {
    childProcessMock.spawn.mockClear();
    childProcessMock.children.length = 0;
    providerRegistryMock.getProvider.mockReset();
    providerRegistryMock.getProvider.mockReturnValue(undefined);
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
