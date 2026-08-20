/**
 * Overlay file lifecycle for the DeepSeek Harness launch plumbing.
 *
 * The overlay embeds the session's memory-MCP identity env, so it must be
 * removed with the session rather than accumulating one stale file per session
 * for the lifetime of the machine.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DSH_AGENT_DEFAULT_MODEL_ROW_ID,
  DSH_LLM_PI_AI_ROW_ID,
  DSH_PROVIDER_API_KEY_ENV,
} from '../../shared/deepseek-harness.js';

const state = vi.hoisted(() => ({ home: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => state.home };
});

describe('dsh overlay files', () => {
  beforeEach(async () => {
    state.home = await mkdtemp(join(tmpdir(), 'dsh-overlay-'));
  });

  afterEach(async () => {
    if (state.home) await rm(state.home, { recursive: true, force: true });
    state.home = '';
    vi.resetModules();
  });

  it('writes an overlay under the daemon home and removes it again', async () => {
    const runtime = await import('../../src/agent/providers/deepseek-harness/runtime.js');
    const path = await runtime.writeDshOverlay({ sessionKey: 'route-1' });

    expect(path.startsWith(join(state.home, '.imcodes', 'dsh'))).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8'))).toBeInstanceOf(Array);

    await runtime.removeDshOverlay('route-1');
    await expect(access(path)).rejects.toThrow();
  });

  it('sanitizes the session key so an odd route cannot escape the overlay dir', async () => {
    const runtime = await import('../../src/agent/providers/deepseek-harness/runtime.js');
    const path = await runtime.writeDshOverlay({ sessionKey: '../../etc/passwd' });

    const dir = join(state.home, '.imcodes', 'dsh');
    expect(path.startsWith(dir)).toBe(true);
    expect(path).not.toContain('..');
    // Remove must resolve to the same sanitized name, or the file would leak.
    await runtime.removeDshOverlay('../../etc/passwd');
    await expect(access(path)).rejects.toThrow();
  });

  it('stores only a credential reference for a third-party provider route', async () => {
    const runtime = await import('../../src/agent/providers/deepseek-harness/runtime.js');
    const path = await runtime.writeDshOverlay({
      sessionKey: 'route-secret',
      llm: {
        provider: 'minimax',
        model: 'MiniMax-M3',
        baseUrl: 'https://api.minimax.io/anthropic',
        apiKey: 'sk-must-not-touch-disk',
        contextWindow: 1_000_000,
      },
    });
    const raw = await readFile(path, 'utf8');
    const rows = JSON.parse(raw) as Array<{ id?: string; config?: Record<string, unknown> }>;

    expect(raw).not.toContain('sk-must-not-touch-disk');
    expect(rows.find((row) => row.id === DSH_LLM_PI_AI_ROW_ID)?.config).toEqual({
      providers: {
        minimax: {
          api: 'anthropic-messages',
          baseURL: 'https://api.minimax.io/anthropic',
          apiKeyEnv: DSH_PROVIDER_API_KEY_ENV,
          models: [{ id: 'MiniMax-M3', contextWindow: 1_000_000 }],
        },
      },
    });
    expect(rows.find((row) => row.id === DSH_AGENT_DEFAULT_MODEL_ROW_ID)?.config).toEqual({
      provider: 'minimax',
      model: 'MiniMax-M3',
    });
  });
});

describe('dsh launch guidance', () => {
  it('turns a missing external dsh binary into an actionable install prompt', async () => {
    const runtime = await import('../../src/agent/providers/deepseek-harness/runtime.js');
    const error = Object.assign(new Error('spawn dsh ENOENT'), { code: 'ENOENT' });

    expect(runtime.formatDshLaunchError(error)).toBe(
      `DeepSeek Harness (dsh) is not installed on this daemon host. Install it, then retry: ${runtime.DSH_INSTALL_COMMAND}`,
    );
    expect(runtime.DSH_INSTALL_COMMAND).toBe('npm install -g @deepseek-ai/dsh@0.1.0-rc.7');
  });

  it('preserves non-missing launch failures for diagnostics', async () => {
    const runtime = await import('../../src/agent/providers/deepseek-harness/runtime.js');

    expect(runtime.formatDshLaunchError(new Error('permission denied'), '/opt/dsh')).toBe(
      'failed to launch /opt/dsh: permission denied',
    );
  });
});
