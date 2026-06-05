import { randomHex, sha256Hex } from '../security/crypto.js';
import { PREVIEW_LIMITS, type PreviewRecord } from '../../../shared/preview-types.js';

type InternalPreviewRecord = PreviewRecord & {
  accessTokenHash: string;
};

function normalizePreviewPath(path: string | undefined): string {
  if (!path || path.trim() === '') return '/';
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  return withSlash.replace(/\/+/g, '/');
}

/**
 * Predicate the bridge installs so registry cleanup knows which previews still
 * have an active relay (HTTP stream or WS tunnel) and MUST NOT be evicted
 * (run 8a975732-23a P1.4 — no half-dead SSE / 404 sub-resources). serverId →
 * (previewId → boolean). Defined as a module-level hook (not a constructor
 * dependency) because the bridge is created lazily/independently from the
 * registry and we must avoid a circular import between bridge.ts and
 * registry.ts.
 */
let hasActiveRelayHook: ((serverId: string, previewId: string) => boolean) | null = null;

/** Install (or clear) the active-relay predicate used by cleanup. Bridge calls this. */
export function setPreviewActiveRelayHook(
  hook: ((serverId: string, previewId: string) => boolean) | null,
): void {
  hasActiveRelayHook = hook;
}

/**
 * Eviction callback (run 8a975732-23a P1.4.2). The registry invokes this the
 * moment it evicts a previewId via cleanup (idle or hard-lifetime) so the bridge
 * can deterministically tear down any relay that survived the cleanup race: it
 * MUST abort all pending HTTP relays and close the WS tunnels (NON-silent — the
 * client sees a deterministic terminal, never a half-dead SSE or a silent 404
 * on a new sub-resource). Module-level hook to avoid a circular import.
 */
let onPreviewEvictedHook: ((serverId: string, previewId: string) => void) | null = null;

/** Install (or clear) the eviction callback used by cleanup. Bridge calls this. */
export function setPreviewEvictedHook(
  hook: ((serverId: string, previewId: string) => void) | null,
): void {
  onPreviewEvictedHook = hook;
}

export class LocalWebPreviewRegistry {
  private static instances = new Map<string, LocalWebPreviewRegistry>();
  private previews = new Map<string, InternalPreviewRecord>();

  private static cleanupHandle: ReturnType<typeof setInterval> | null = null;

  static get(serverId: string): LocalWebPreviewRegistry {
    let instance = this.instances.get(serverId);
    if (!instance) {
      instance = new LocalWebPreviewRegistry(serverId);
      this.instances.set(serverId, instance);
    }
    // Start periodic cleanup sweep (shared across all registries)
    if (!this.cleanupHandle) {
      this.cleanupHandle = setInterval(() => {
        for (const registry of LocalWebPreviewRegistry.instances.values()) {
          registry.cleanup();
        }
      }, 5 * 60 * 1000); // every 5 minutes
      this.cleanupHandle.unref?.();
    }
    return instance;
  }

  private constructor(private readonly serverId: string) {}

  create(userId: string, port: number, path?: string): { preview: PreviewRecord; accessToken: string } {
    this.cleanup();
    const activeCount = [...this.previews.values()].filter((p) => p.userId === userId).length;
    if (activeCount >= PREVIEW_LIMITS.MAX_ACTIVE_PREVIEWS_PER_USER_PER_SERVER) {
      throw new Error('preview_limit_exceeded');
    }
    const now = Date.now();
    const accessToken = randomHex(24);
    const preview: InternalPreviewRecord = {
      id: randomHex(24),
      serverId: this.serverId,
      userId,
      port,
      path: normalizePreviewPath(path),
      createdAt: now,
      expiresAt: now + PREVIEW_LIMITS.DEFAULT_TTL_MS,
      lastAccessAt: now,
      accessTokenHash: sha256Hex(accessToken),
    };
    this.previews.set(preview.id, preview);
    return {
      preview: this.toPreviewRecord(preview),
      accessToken,
    };
  }

  /**
   * Pure existence/expiry check — NO side effects (run 8a975732-23a P0.1).
   * Does NOT update `lastAccessAt` and does NOT slide `expiresAt`; it only drops
   * a hard-expired entry (GC, not a renewal). Used by the authorization
   * peek/verify path which MUST be side-effect free until owner+role+token all
   * pass. The committing `touch()` is the only place renewal happens.
   */
  peek(id: string): PreviewRecord | null {
    const preview = this.previews.get(id) ?? null;
    if (!preview) return null;
    if (preview.expiresAt <= Date.now()) {
      this.previews.delete(id);
      return null;
    }
    return this.toPreviewRecord(preview);
  }

  /**
   * Pure token verification — NO side effects (run 8a975732-23a P0.1).
   * Mirrors `peek()` plus a constant-key hash compare; never touches/renews.
   */
  peekWithAccessToken(id: string, accessToken: string): PreviewRecord | null {
    const preview = this.previews.get(id) ?? null;
    if (!preview) return null;
    if (preview.expiresAt <= Date.now()) {
      this.previews.delete(id);
      return null;
    }
    if (sha256Hex(accessToken) !== preview.accessTokenHash) return null;
    return this.toPreviewRecord(preview);
  }

  get(id: string): PreviewRecord | null {
    const preview = this.previews.get(id) ?? null;
    if (!preview) return null;
    if (preview.expiresAt <= Date.now()) {
      this.previews.delete(id);
      return null;
    }
    preview.lastAccessAt = Date.now();
    return this.toPreviewRecord(preview);
  }

  authorizeWithAccessToken(id: string, accessToken: string): PreviewRecord | null {
    const preview = this.previews.get(id) ?? null;
    if (!preview) return null;
    if (preview.expiresAt <= Date.now()) {
      this.previews.delete(id);
      return null;
    }
    if (sha256Hex(accessToken) !== preview.accessTokenHash) return null;
    preview.lastAccessAt = Date.now();
    return this.toPreviewRecord(preview);
  }

  /**
   * Touch a preview's activity, sliding its TTL forward (run 8a975732-23a P1.3).
   *
   * Called on each streaming chunk / WS tunnel frame and on every committed
   * authorized HTTP access. Sliding renewal keeps a long-running dev session
   * (active SSE > 10min) alive, but is clamped by the absolute lifetime hard
   * ceiling so a single stream is never unbounded (the byte-cap-exemption × TTL
   * coupling guard):
   *
   *   expiresAt = min( max(expiresAt, now + DEFAULT_TTL_MS),
   *                    createdAt + PREVIEW_MAX_LIFETIME_HARD_MS )
   *
   * Returns false if the preview is expired or not found.
   */
  touch(id: string): boolean {
    const preview = this.previews.get(id);
    if (!preview) return false;
    const now = Date.now();
    if (preview.expiresAt <= now) {
      this.previews.delete(id);
      return false;
    }
    preview.lastAccessAt = now;
    const slid = Math.max(preview.expiresAt, now + PREVIEW_LIMITS.DEFAULT_TTL_MS);
    const hardCap = preview.createdAt + PREVIEW_LIMITS.PREVIEW_MAX_LIFETIME_HARD_MS;
    preview.expiresAt = Math.min(slid, hardCap);
    return true;
  }

  close(id: string, userId: string): boolean {
    const preview = this.previews.get(id);
    if (!preview || preview.userId !== userId) return false;
    this.previews.delete(id);
    return true;
  }

  /**
   * Periodic sweep (run 8a975732-23a P1.4). Evicts a preview when:
   *   - its absolute lifetime hard ceiling has passed (`expiresAt <= now`,
   *     after sliding clamps to `createdAt + PREVIEW_MAX_LIFETIME_HARD_MS`), OR
   *   - it is `preview_session_idle` (no activity for DEFAULT_IDLE_TTL_MS) AND
   *     has NO active relay.
   *
   * A preview with an active relay (live HTTP stream or WS tunnel) is treated as
   * non-idle and is NOT evicted on the idle branch — but the hard-lifetime
   * branch still evicts it (the byte-cap-exemption × TTL coupling guard). The
   * bridge installs `setPreviewActiveRelayHook` so cleanup can ask whether a
   * previewId is live; when no hook is installed (e.g. registry-only tests) we
   * fall back to the pure time-based rule.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [id, preview] of this.previews) {
      if (preview.expiresAt <= now) {
        this.previews.delete(id);
        // Hard-lifetime (or otherwise expired) eviction may race a still-live
        // relay — tell the bridge to tear it down deterministically (P1.4.2).
        onPreviewEvictedHook?.(this.serverId, id);
        continue;
      }
      const idle = now - preview.lastAccessAt > PREVIEW_LIMITS.DEFAULT_IDLE_TTL_MS;
      if (!idle) continue;
      const hasActiveRelay = hasActiveRelayHook?.(this.serverId, id) ?? false;
      if (hasActiveRelay) continue;
      this.previews.delete(id);
      onPreviewEvictedHook?.(this.serverId, id);
    }
  }

  private toPreviewRecord(preview: InternalPreviewRecord): PreviewRecord {
    return {
      id: preview.id,
      serverId: preview.serverId,
      userId: preview.userId,
      port: preview.port,
      path: preview.path,
      createdAt: preview.createdAt,
      expiresAt: preview.expiresAt,
      lastAccessAt: preview.lastAccessAt,
    };
  }
}

export function normalizeLocalPreviewPath(path: string | undefined): string {
  return normalizePreviewPath(path);
}
