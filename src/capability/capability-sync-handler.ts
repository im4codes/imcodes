import {
  CAPABILITY_LIMITS,
  CAPABILITY_SYNC_MSG,
} from '../../shared/capability-management.js';
import {
  CAPABILITY_SYNC_ERROR,
  CapabilitySyncError,
  type CapabilitySyncErrorCode,
  type CapabilitySyncService,
} from './capability-sync-service.js';

export interface CapabilitySyncFrameHandlerOptions {
  serviceForOwner(ownerId: string): CapabilitySyncService;
  requestFullSnapshot(): void | Promise<void>;
  onError?(error: unknown, context: { type: unknown; ownerId?: string; requestFull: boolean }): void;
}

const REQUIRES_FULL_SNAPSHOT = new Set<CapabilitySyncErrorCode>([
  CAPABILITY_SYNC_ERROR.INVALID_FRAME,
  CAPABILITY_SYNC_ERROR.OWNER_MISMATCH,
  CAPABILITY_SYNC_ERROR.DIGEST_MISMATCH,
  CAPABILITY_SYNC_ERROR.STALE_REVISION,
  CAPABILITY_SYNC_ERROR.REVISION_GAP,
]);

function isSyncFrameType(type: unknown): boolean {
  return type === CAPABILITY_SYNC_MSG.SNAPSHOT
    || type === CAPABILITY_SYNC_MSG.DELTA
    || type === CAPABILITY_SYNC_MSG.TOMBSTONE
    || type === CAPABILITY_SYNC_MSG.AUTHORITY;
}

function ownerFromFrame(value: Record<string, unknown>): string | undefined {
  return typeof value.ownerId === 'string'
    && value.ownerId.length > 0
    && Buffer.byteLength(value.ownerId, 'utf8') <= CAPABILITY_LIMITS.SOURCE_CHARS
    ? value.ownerId
    : undefined;
}

export class CapabilitySyncFrameHandler {
  private readonly ownerQueues = new Map<string, Promise<void>>();

  constructor(private readonly options: CapabilitySyncFrameHandlerOptions) {}

  async handle(value: unknown): Promise<boolean> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const frame = value as Record<string, unknown>;
    if (!isSyncFrameType(frame.type)) return false;
    const ownerId = ownerFromFrame(frame);
    if (!ownerId) {
      await this.options.requestFullSnapshot();
      this.options.onError?.(new CapabilitySyncError(CAPABILITY_SYNC_ERROR.INVALID_FRAME), {
        type: frame.type,
        requestFull: true,
      });
      return true;
    }
    const previous = this.ownerQueues.get(ownerId) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(async () => {
      try {
        await this.options.serviceForOwner(ownerId).apply(frame);
      } catch (error) {
        const requestFull = error instanceof CapabilitySyncError && REQUIRES_FULL_SNAPSHOT.has(error.code);
        this.options.onError?.(error, { type: frame.type, ownerId, requestFull });
        if (requestFull) await this.options.requestFullSnapshot();
      }
    });
    this.ownerQueues.set(ownerId, work);
    try {
      await work;
    } finally {
      if (this.ownerQueues.get(ownerId) === work) this.ownerQueues.delete(ownerId);
    }
    return true;
  }
}

export const CAPABILITY_SYNC_FRAME_HANDLER_TESTING = {
  isSyncFrameType,
  ownerFromFrame,
};
