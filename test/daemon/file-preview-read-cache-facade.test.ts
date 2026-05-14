import { describe, expect, it } from 'vitest';
import { PreviewReadCacheFacade } from '../../src/daemon/file-preview-read-cache-facade.js';
import type { PreviewReadSnapshotSuccess } from '../../src/daemon/file-preview-read-types.js';

class FakeClock {
  current = 0;
  now(): number {
    return this.current;
  }
}

function snapshot(realPath: string, startSignature: string, endSignature = startSignature): PreviewReadSnapshotSuccess {
  return {
    phase: 'snapshot',
    workerRequestId: 1,
    workerSlotId: 1,
    workerGeneration: 1,
    kind: 'success',
    realPath,
    startSignature,
    endSignature,
    size: 5,
    mtimeMs: 10,
    fileName: 'a.txt',
    classification: { previewKind: 'text', sizeLimitBytes: 100 },
    payload: { mode: 'text', content: 'hello' },
  };
}

describe('PreviewReadCacheFacade', () => {
  it('keys snapshots by real path, signature, and resource generation', () => {
    const cache = new PreviewReadCacheFacade();

    expect(cache.makeSnapshotKey('/tmp/a.txt', '10:5')).toBe('/tmp/a.txt::10:5::0');
    cache.bumpGeneration('/tmp/a.txt');
    expect(cache.makeSnapshotKey('/tmp/a.txt', '10:5')).toBe('/tmp/a.txt::10:5::1');
  });

  it('writes and reads only freshness-matching snapshots inside the TTL', () => {
    const clock = new FakeClock();
    const cache = new PreviewReadCacheFacade({ clock, ttlMs: 50 });
    const value = snapshot('/tmp/a.txt', '10:5');

    expect(cache.writeSnapshot(value)).toBe(true);
    expect(cache.getCached('/tmp/a.txt', '10:5')).toBe(value);
    expect(cache.getCached('/tmp/a.txt', '11:5')).toBeNull();

    clock.current = 51;
    expect(cache.getCached('/tmp/a.txt', '10:5')).toBeNull();
  });

  it('rejects stale writeback when signatures differ or generation changed', () => {
    const cache = new PreviewReadCacheFacade();

    expect(cache.writeSnapshot(snapshot('/tmp/a.txt', '10:5', '11:5'))).toBe(false);
    const generation = cache.getGeneration('/tmp/a.txt');
    cache.bumpGeneration('/tmp/a.txt');
    expect(cache.writeSnapshot(snapshot('/tmp/a.txt', '10:5'), generation)).toBe(false);
  });

  it('invalidates cache and matching inflight keys', () => {
    const cache = new PreviewReadCacheFacade();
    const key = cache.makeSnapshotKey('/tmp/a.txt', '10:5');
    cache.setInflight(key, { active: true });
    cache.writeSnapshot(snapshot('/tmp/a.txt', '10:5'));

    cache.invalidatePath('/tmp/a.txt');

    expect(cache.getCached('/tmp/a.txt', '10:5')).toBeNull();
    expect(cache.getInflight(key)).toBeNull();
    expect(cache.getGeneration('/tmp/a.txt')).toBe(1);
  });

  it('sweeps expired entries for unrelated paths', () => {
    const clock = new FakeClock();
    const cache = new PreviewReadCacheFacade({ clock, ttlMs: 10 });
    cache.writeSnapshot(snapshot('/tmp/a.txt', '10:5'));
    cache.writeSnapshot(snapshot('/tmp/b.txt', '10:5'));

    clock.current = 11;
    expect(cache.getCached('/tmp/c.txt', '10:5')).toBeNull();

    expect(cache.cacheSize()).toBe(0);
    expect(cache.cacheBytes()).toBe(0);
  });

  it('evicts oldest entries by count and byte caps', () => {
    const byCount = new PreviewReadCacheFacade({ maxEntries: 1 });
    const a = snapshot('/tmp/a.txt', '10:5');
    const b = snapshot('/tmp/b.txt', '10:5');
    byCount.writeSnapshot(a);
    byCount.writeSnapshot(b);
    expect(byCount.getCached('/tmp/a.txt', '10:5')).toBeNull();
    expect(byCount.getCached('/tmp/b.txt', '10:5')).toBe(b);

    const byBytes = new PreviewReadCacheFacade({ maxBytes: 400 });
    byBytes.writeSnapshot(snapshot('/tmp/large-a.txt', '10:5'));
    byBytes.writeSnapshot(snapshot('/tmp/large-b.txt', '10:5'));
    expect(byBytes.cacheBytes()).toBeLessThanOrEqual(400);
  });

  it('does not cache snapshots over the per-entry byte cap', () => {
    const cache = new PreviewReadCacheFacade({ maxEntryBytes: 8 });
    const value = snapshot('/tmp/a.txt', '10:5');

    expect(cache.writeSnapshot(value)).toBe(false);
    expect(cache.getCached('/tmp/a.txt', '10:5')).toBeNull();
  });
});
