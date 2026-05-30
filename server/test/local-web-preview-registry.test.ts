import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LocalWebPreviewRegistry,
  setPreviewActiveRelayHook,
  setPreviewEvictedHook,
} from '../src/preview/registry.js';
import { PREVIEW_LIMITS } from '../../shared/preview-types.js';

describe('LocalWebPreviewRegistry', () => {
  let now = 1_700_000_000_000;

  function getRegistry() {
    return LocalWebPreviewRegistry.get(`srv-preview-test-${Math.random().toString(36).slice(2)}`);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates hex preview ids and updates access time on get', () => {
    const registry = getRegistry();
    const { preview, accessToken } = registry.create('user1', 3000, '/docs');

    expect(preview.id).toMatch(/^[a-f0-9]{48}$/);
    expect(accessToken).toMatch(/^[a-f0-9]{48}$/);

    vi.setSystemTime(now + 5_000);
    const loaded = registry.get(preview.id);
    expect(loaded?.lastAccessAt).toBe(now + 5_000);
  });

  it('enforces max active previews per user per server', () => {
    const registry = getRegistry();
    for (let i = 0; i < PREVIEW_LIMITS.MAX_ACTIVE_PREVIEWS_PER_USER_PER_SERVER; i++) {
      registry.create('user1', 3000 + i, '/');
    }
    expect(() => registry.create('user1', 9999, '/')).toThrow('preview_limit_exceeded');
  });

  it('expires previews by ttl and idle timeout', () => {
    const registry = getRegistry();
    const ttlPreview = registry.create('user1', 3000, '/').preview;
    vi.setSystemTime(now + PREVIEW_LIMITS.DEFAULT_TTL_MS + 1);
    expect(registry.get(ttlPreview.id)).toBeNull();

    const idlePreview = registry.create('user1', 3001, '/').preview;
    const idleCreatedAt = now + PREVIEW_LIMITS.DEFAULT_TTL_MS + 1;
    vi.setSystemTime(idleCreatedAt + PREVIEW_LIMITS.DEFAULT_IDLE_TTL_MS + 1);
    registry.cleanup();
    expect(registry.get(idlePreview.id)).toBeNull();
  });

  it('only allows owner to close preview', () => {
    const registry = getRegistry();
    const { preview } = registry.create('user1', 3000, '/');
    expect(registry.close(preview.id, 'user2')).toBe(false);
    expect(registry.close(preview.id, 'user1')).toBe(true);
    expect(registry.get(preview.id)).toBeNull();
  });

  it('authorizes access with the preview access token', () => {
    const registry = getRegistry();
    const { preview, accessToken } = registry.create('user1', 3000, '/');

    expect(registry.authorizeWithAccessToken(preview.id, accessToken)?.id).toBe(preview.id);
    expect(registry.authorizeWithAccessToken(preview.id, 'wrong-token')).toBeNull();
  });

  it('peek/peekWithAccessToken are pure (do not move lastAccessAt)', () => {
    const registry = getRegistry();
    const { preview, accessToken } = registry.create('user1', 3000, '/');
    const lastAccess = registry.peek(preview.id)!.lastAccessAt;

    vi.setSystemTime(now + 30_000);
    expect(registry.peek(preview.id)!.lastAccessAt).toBe(lastAccess);
    expect(registry.peekWithAccessToken(preview.id, accessToken)!.lastAccessAt).toBe(lastAccess);
    expect(registry.peekWithAccessToken(preview.id, 'nope')).toBeNull();
  });

  // ── V-ttl-slide (run 8a975732-23a P1.3.4) ────────────────────────────────────
  it('V-ttl-slide: touch slides expiresAt so an actively-touched preview survives past idle TTL', () => {
    const registry = getRegistry();
    const { preview } = registry.create('user1', 3000, '/');

    // Touch every 5 min for 30 min total → never idle, expiresAt keeps sliding.
    for (let elapsed = 5 * 60_000; elapsed <= 30 * 60_000; elapsed += 5 * 60_000) {
      vi.setSystemTime(now + elapsed);
      expect(registry.touch(preview.id)).toBe(true);
      registry.cleanup();
      expect(registry.peek(preview.id)).not.toBeNull();
    }
    // Final expiresAt was slid to (last touch + DEFAULT_TTL_MS).
    const lastTouchAt = now + 30 * 60_000;
    expect(registry.peek(preview.id)!.expiresAt).toBe(lastTouchAt + PREVIEW_LIMITS.DEFAULT_TTL_MS);
  });

  // ── V-ttl-hard (run 8a975732-23a P1.3.4) ─────────────────────────────────────
  it('V-ttl-hard: sliding renewal never crosses createdAt + PREVIEW_MAX_LIFETIME_HARD_MS', () => {
    const registry = getRegistry();
    const { preview } = registry.create('user1', 3000, '/');
    const createdAt = now;
    const hardCap = createdAt + PREVIEW_LIMITS.PREVIEW_MAX_LIFETIME_HARD_MS;

    // Simulate a continuously-active stream: touch every (DEFAULT_TTL_MS / 2) so
    // the preview never expires between touches, sliding expiresAt forward each
    // time but clamped by the hard ceiling.
    const step = Math.floor(PREVIEW_LIMITS.DEFAULT_TTL_MS / 2);
    for (let t = createdAt + step; t < hardCap; t += step) {
      vi.setSystemTime(t);
      expect(registry.touch(preview.id)).toBe(true);
      // expiresAt slides to min(t + DEFAULT_TTL_MS, hardCap) — never past the cap.
      expect(registry.peek(preview.id)!.expiresAt).toBe(Math.min(t + PREVIEW_LIMITS.DEFAULT_TTL_MS, hardCap));
    }

    // Past the ceiling: cleanup evicts even though it was actively touched.
    vi.setSystemTime(hardCap + 1);
    registry.cleanup();
    expect(registry.peek(preview.id)).toBeNull();
  });

  // ── V-cleanup-skip (run 8a975732-23a P1.4.3) ─────────────────────────────────
  it('V-cleanup-skip: an idle preview WITH an active relay is NOT evicted; eviction fires the hook only for evicted ids', () => {
    const registry = getRegistry();
    const live = registry.create('user1', 3000, '/').preview;
    const dead = registry.create('user1', 3001, '/').preview;

    const evicted: string[] = [];
    setPreviewActiveRelayHook((_sid, previewId) => previewId === live.id);
    setPreviewEvictedHook((_sid, previewId) => { evicted.push(previewId); });
    try {
      // Both idle past the idle TTL but still inside the hard ceiling.
      vi.setSystemTime(now + PREVIEW_LIMITS.DEFAULT_IDLE_TTL_MS + 1);
      registry.cleanup();

      // live (active relay) survives; dead (no relay) is evicted + hook fired.
      expect(registry.peek(live.id)).not.toBeNull();
      expect(registry.peek(dead.id)).toBeNull();
      expect(evicted).toEqual([dead.id]);
    } finally {
      setPreviewActiveRelayHook(null);
      setPreviewEvictedHook(null);
    }
  });
});
