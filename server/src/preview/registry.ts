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
   * Touch a preview's idle TTL, resetting lastAccessAt to now.
   * Called when WS tunnel traffic is active so HMR connections keep the preview alive.
   * Returns false if the preview is expired or not found.
   */
  touch(id: string): boolean {
    const preview = this.previews.get(id);
    if (!preview) return false;
    if (preview.expiresAt <= Date.now()) {
      this.previews.delete(id);
      return false;
    }
    preview.lastAccessAt = Date.now();
    return true;
  }

  close(id: string, userId: string): boolean {
    const preview = this.previews.get(id);
    if (!preview || preview.userId !== userId) return false;
    this.previews.delete(id);
    return true;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [id, preview] of this.previews) {
      if (preview.expiresAt <= now || now - preview.lastAccessAt > PREVIEW_LIMITS.DEFAULT_IDLE_TTL_MS) {
        this.previews.delete(id);
      }
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
