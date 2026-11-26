/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en', changeLanguage: () => Promise.resolve() } }),
  Trans: ({ children }: { children?: unknown }) => children,
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

const { __chatLocalImagePreviewCacheInternals: cache, __clearChatLocalImagePreviewCacheForTests } =
  await import('../../src/components/ChatView.js');

// tsk_5rf R2 / Cx P1-2. A streamed preview caches a download-handle URL whose
// handle expires server-side (4h). The cache was an LRU with NO expiry, so a
// dead URL was replayed forever and a retry could never mint a fresh handle.
beforeEach(() => { __clearChatLocalImagePreviewCacheForTests(); });

describe('chat local image preview cache boundary (tsk_5rf R2)', () => {
  it('reuses a fresh entry but re-loads once the entry outlives its TTL', async () => {
    const load = vi.fn(async () => ({ dataUrl: 'https://host/dl/1' }));
    const t0 = 1_000_000;

    await cache.get('k', load, t0);
    await cache.get('k', load, t0 + cache.ttlMs - 1);
    expect(load, 'a fresh entry must be reused').toHaveBeenCalledTimes(1);

    await cache.get('k', load, t0 + cache.ttlMs + 1);
    expect(load, 'an expired entry must mint a fresh handle').toHaveBeenCalledTimes(2);
  });

  it('re-loads after a reported load failure instead of replaying the dead URL', async () => {
    const load = vi.fn(async () => ({ dataUrl: 'https://host/dl/1' }));
    const t0 = 1_000_000;

    await cache.get('k', load, t0);
    expect(load).toHaveBeenCalledTimes(1);

    // The <img> failed: the component reports it, the entry must be dropped.
    cache.invalidate('k');

    await cache.get('k', load, t0 + 1);
    expect(load, 'a failed URL must never be replayed from cache').toHaveBeenCalledTimes(2);
  });

  it('keeps the TTL safely under the server-side handle lifetime', () => {
    const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
    expect(cache.ttlMs).toBeLessThan(FOUR_HOURS_MS);
  });
});
