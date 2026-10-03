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

const FULL_SNAPSHOT_RETRY_MIN_MS = 1_000;
const FULL_SNAPSHOT_RETRY_MAX_MS = 30_000;
const INVALID_OWNER_REPAIR_KEY = '<invalid-owner>';
const AUTHORITY_REPAIR_DIMENSION = 'authority';
const STATE_REPAIR_DIMENSION = 'state';

interface RepairState {
  attempt: number;
  fingerprint: string;
  nextRequestAt: number;
}

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

function frameFingerprint(frame: Record<string, unknown>): string {
  const revision = Number.isSafeInteger(frame.revision) ? String(frame.revision) : '?';
  const digest = typeof frame.digest === 'string' && frame.digest.length <= 128 ? frame.digest : '?';
  return `${String(frame.type)}\u0000${revision}\u0000${digest}`;
}

function repairKeyForFrame(ownerId: string, type: unknown): string {
  const dimension = type === CAPABILITY_SYNC_MSG.AUTHORITY
    ? AUTHORITY_REPAIR_DIMENSION
    : STATE_REPAIR_DIMENSION;
  return `${ownerId}\u0000${dimension}`;
}

export class CapabilitySyncFrameHandler {
  private readonly ownerQueues = new Map<string, Promise<void>>();
  private readonly repairs = new Map<string, RepairState>();
  private repairRequestInFlight = false;
  private repairTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: CapabilitySyncFrameHandlerOptions) {}

  private clearRepair(repairKey: string): void {
    this.repairs.delete(repairKey);
    if (this.repairs.size === 0 && this.repairTimer) {
      clearTimeout(this.repairTimer);
      this.repairTimer = undefined;
    }
  }

  private scheduleRepairRequest(): void {
    if (this.repairRequestInFlight || this.repairTimer || this.repairs.size === 0) return;
    const now = Date.now();
    const nextRequestAt = Math.min(...[...this.repairs.values()].map((state) => state.nextRequestAt));
    if (nextRequestAt <= now) {
      void this.requestRepairSnapshot();
      return;
    }
    this.repairTimer = setTimeout(() => {
      this.repairTimer = undefined;
      void this.requestRepairSnapshot();
    }, nextRequestAt - now);
    this.repairTimer.unref?.();
  }

  private async requestRepairSnapshot(): Promise<void> {
    if (this.repairRequestInFlight || this.repairs.size === 0) return;
    this.repairRequestInFlight = true;
    const requestedAt = Date.now();
    try {
      await this.options.requestFullSnapshot();
    } catch (error) {
      this.options.onError?.(error, {
        type: CAPABILITY_SYNC_MSG.REQUEST,
        requestFull: false,
      });
    } finally {
      this.repairRequestInFlight = false;
      const completedAt = Date.now();
      for (const state of this.repairs.values()) {
        if (state.nextRequestAt > requestedAt) continue;
        state.attempt += 1;
        state.nextRequestAt = completedAt + Math.min(
          FULL_SNAPSHOT_RETRY_MAX_MS,
          FULL_SNAPSHOT_RETRY_MIN_MS * (2 ** Math.min(state.attempt - 1, 8)),
        );
      }
      this.scheduleRepairRequest();
    }
  }

  private beginRepair(
    ownerId: string | undefined,
    fingerprint: string,
    error: unknown,
    type: unknown,
  ): void {
    const repairKey = ownerId ? repairKeyForFrame(ownerId, type) : INVALID_OWNER_REPAIR_KEY;
    const active = this.repairs.get(repairKey);
    if (active) {
      active.fingerprint = fingerprint;
      return;
    }
    this.repairs.set(repairKey, { attempt: 0, fingerprint, nextRequestAt: 0 });
    this.options.onError?.(error, {
      type,
      ...(ownerId ? { ownerId } : {}),
      requestFull: true,
    });
    this.scheduleRepairRequest();
  }

  async handle(value: unknown): Promise<boolean> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const frame = value as Record<string, unknown>;
    if (!isSyncFrameType(frame.type)) return false;
    const ownerId = ownerFromFrame(frame);
    const fingerprint = frameFingerprint(frame);
    if (!ownerId) {
      this.beginRepair(
        undefined,
        fingerprint,
        new CapabilitySyncError(CAPABILITY_SYNC_ERROR.INVALID_FRAME),
        frame.type,
      );
      return true;
    }
    const repairKey = repairKeyForFrame(ownerId, frame.type);
    const previous = this.ownerQueues.get(ownerId) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(async () => {
      if (this.repairs.get(repairKey)?.fingerprint === fingerprint) return;
      try {
        await this.options.serviceForOwner(ownerId).apply(frame);
        this.clearRepair(repairKey);
        this.clearRepair(INVALID_OWNER_REPAIR_KEY);
      } catch (error) {
        const requestFull = error instanceof CapabilitySyncError && REQUIRES_FULL_SNAPSHOT.has(error.code);
        if (requestFull) this.beginRepair(ownerId, fingerprint, error, frame.type);
        else this.options.onError?.(error, { type: frame.type, ownerId, requestFull: false });
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
  FULL_SNAPSHOT_RETRY_MAX_MS,
  FULL_SNAPSHOT_RETRY_MIN_MS,
  frameFingerprint,
  isSyncFrameType,
  ownerFromFrame,
};
