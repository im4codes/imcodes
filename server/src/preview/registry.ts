import { randomHex } from '../security/crypto.js';
import { PREVIEW_LIMITS, type PreviewRecord } from '../../../shared/preview-types.js';

function normalizePreviewPath(path: string | undefined): string {
  if (!path || path.trim() === '') return '/';
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  return withSlash.replace(/\/+/g, '/');
}

export class LocalWebPreviewRegistry {
  private static instances = new Map<string, LocalWebPreviewRegistry>();
  private previews = new Map<string, PreviewRecord>();

  static get(serverId: string): LocalWebPreviewRegistry {
    let instance = this.instances.get(serverId);
    if (!instance) {
      instance = new LocalWebPreviewRegistry(serverId);
      this.instances.set(serverId, instance);
    }
    return instance;
  }

  private constructor(private readonly serverId: string) {}

  create(userId: string, port: number, path?: string): PreviewRecord {
    this.cleanup();
    const activeCount = [...this.previews.values()].filter((p) => p.userId === userId).length;
    if (activeCount >= PREVIEW_LIMITS.MAX_ACTIVE_PREVIEWS_PER_USER_PER_SERVER) {
      throw new Error('preview_limit_exceeded');
    }
    const now = Date.now();
    const preview: PreviewRecord = {
      id: randomHex(24),
      serverId: this.serverId,
      userId,
      port,
      path: normalizePreviewPath(path),
      createdAt: now,
      expiresAt: now + PREVIEW_LIMITS.DEFAULT_TTL_MS,
      lastAccessAt: now,
    };
    this.previews.set(preview.id, preview);
    return preview;
  }

  get(id: string): PreviewRecord | null {
    const preview = this.previews.get(id) ?? null;
    if (!preview) return null;
    if (preview.expiresAt <= Date.now()) {
      this.previews.delete(id);
      return null;
    }
    preview.lastAccessAt = Date.now();
    return preview;
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
}

export function normalizeLocalPreviewPath(path: string | undefined): string {
  return normalizePreviewPath(path);
}
