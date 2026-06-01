import { describe, expect, it, vi } from 'vitest';
import { resolveLiveHookPort, DEFAULT_HOOK_PORT } from '../../src/daemon/hook-port.js';

describe('resolveLiveHookPort', () => {
  it('returns the saved port when it is alive (no scan, no heal)', async () => {
    const probe = vi.fn(async (p: number) => p === 51947);
    const write = vi.fn();
    const port = await resolveLiveHookPort({ readSaved: () => 51947, probe, write });
    expect(port).toBe(51947);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(51947);
    expect(write).not.toHaveBeenCalled();
  });

  it('scans the range and heals the file when the saved port is dead', async () => {
    // Saved 51950 is dead; the live server is on 51947.
    const probe = vi.fn(async (p: number) => p === 51947);
    const write = vi.fn();
    const port = await resolveLiveHookPort({ readSaved: () => 51950, probe, write });
    expect(port).toBe(51947);
    expect(write).toHaveBeenCalledWith(51947); // self-healed
  });

  it('scans from DEFAULT_HOOK_PORT when there is no saved port', async () => {
    const probe = vi.fn(async (p: number) => p === DEFAULT_HOOK_PORT);
    const write = vi.fn();
    const port = await resolveLiveHookPort({ readSaved: () => null, probe, write });
    expect(port).toBe(DEFAULT_HOOK_PORT);
    expect(write).toHaveBeenCalledWith(DEFAULT_HOOK_PORT);
  });

  it('does not probe the saved port twice during the scan', async () => {
    const probed: number[] = [];
    const probe = vi.fn(async (p: number) => { probed.push(p); return p === 51947; });
    await resolveLiveHookPort({ readSaved: () => 51915, probe, write: vi.fn() });
    // 51915 probed first (dead), then scan DEFAULT..+SPAN skipping the repeat of 51915.
    expect(probed[0]).toBe(51915);
    expect(probed.filter((p) => p === 51915)).toHaveLength(1);
  });

  it('returns null when nothing answers', async () => {
    const write = vi.fn();
    const port = await resolveLiveHookPort({ readSaved: () => 51950, probe: async () => false, write });
    expect(port).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });
});
