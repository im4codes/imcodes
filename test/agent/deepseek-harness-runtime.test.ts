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
});
