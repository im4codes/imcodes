import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalWebPreviewRegistry } from '../src/preview/registry.js';
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
});
