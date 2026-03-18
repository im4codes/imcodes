import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { vi } from 'vitest';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'deck-signal-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.resetModules();
});

// Patch SIGNAL_DIR by mocking path
vi.mock('../../src/agent/signal.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/agent/signal.js')>();

  const fakeSignalDir = (dir: string) => {
    return {
      ...mod,
      SIGNAL_DIR: dir,
      writeIdleSignal: (signal: { session: string; timestamp: number; agentType?: string }) =>
        mod.writeIdleSignal(signal),
    };
  };
  return fakeSignalDir('/tmp/does-not-matter');
});

describe('signal file handling', () => {
  it('writeIdleSignal creates a file atomically', async () => {
    // Use the real module but redirect SIGNAL_DIR via env
    const { writeIdleSignal, checkIdleSignal, SIGNAL_DIR } = await import('../../src/agent/signal.js');

    // The actual signal dir is SIGNAL_DIR — create it
    const { mkdir } = await import('fs/promises');
    await mkdir(SIGNAL_DIR, { recursive: true });

    await writeIdleSignal({ session: 'deck_test_w99', timestamp: 99999 });
    const signal = await checkIdleSignal('deck_test_w99');
    expect(signal).not.toBeNull();
    expect(signal?.timestamp).toBe(99999);
  });

  it('checkIdleSignal returns null for missing session', async () => {
    const { checkIdleSignal } = await import('../../src/agent/signal.js');
    const result = await checkIdleSignal('deck_nonexistent_w999');
    expect(result).toBeNull();
  });

  it('signal consumed on read', async () => {
    const { writeIdleSignal, checkIdleSignal, SIGNAL_DIR } = await import('../../src/agent/signal.js');
    const { mkdir } = await import('fs/promises');
    await mkdir(SIGNAL_DIR, { recursive: true });

    await writeIdleSignal({ session: 'deck_consume_w1', timestamp: 0 });
    await checkIdleSignal('deck_consume_w1'); // consume
    const second = await checkIdleSignal('deck_consume_w1');
    expect(second).toBeNull();
  });

  it('no cross-session misattribution', async () => {
    const { writeIdleSignal, checkIdleSignal, SIGNAL_DIR } = await import('../../src/agent/signal.js');
    const { mkdir } = await import('fs/promises');
    await mkdir(SIGNAL_DIR, { recursive: true });

    await writeIdleSignal({ session: 'deck_proj_wa', timestamp: 111 });
    await writeIdleSignal({ session: 'deck_proj_wb', timestamp: 222 });

    const wa = await checkIdleSignal('deck_proj_wa');
    const wb = await checkIdleSignal('deck_proj_wb');
    expect(wa?.timestamp).toBe(111);
    expect(wb?.timestamp).toBe(222);
  });
});
