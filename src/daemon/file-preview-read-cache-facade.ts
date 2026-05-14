import { resolve } from 'node:path';
import type {
  PreviewReadSnapshotSuccess,
  PreviewReadWorkerSuccess,
} from './file-preview-read-types.js';

export const DEFAULT_PREVIEW_READ_CACHE_TTL_MS = 5_000;
export const DEFAULT_PREVIEW_READ_CACHE_MAX_ENTRIES = 64;
export const DEFAULT_PREVIEW_READ_CACHE_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_PREVIEW_READ_CACHE_MAX_ENTRY_BYTES = 2 * 1024 * 1024;

export interface PreviewReadCacheClock {
  now(): number;
}

export interface PreviewReadCachedSnapshot {
  realPath: string;
  signature: string;
  generation: number;
  expiresAt: number;
  bytes: number;
  value: PreviewReadSnapshotSuccess;
}

export interface PreviewReadCacheFacadeOptions {
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
  clock?: PreviewReadCacheClock;
}

const realClock: PreviewReadCacheClock = { now: () => Date.now() };

export class PreviewReadCacheFacade {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  private readonly clock: PreviewReadCacheClock;
  private readonly fsReadCache = new Map<string, PreviewReadCachedSnapshot>();
  private readonly fsReadInflight = new Map<string, unknown>();
  private readonly fsReadGenerations = new Map<string, number>();
  private fsReadCacheBytes = 0;

  constructor(options: PreviewReadCacheFacadeOptions = {}) {
    this.ttlMs = Math.max(0, Math.trunc(options.ttlMs ?? DEFAULT_PREVIEW_READ_CACHE_TTL_MS));
    this.maxEntries = Math.max(0, Math.trunc(options.maxEntries ?? DEFAULT_PREVIEW_READ_CACHE_MAX_ENTRIES));
    this.maxBytes = Math.max(0, Math.trunc(options.maxBytes ?? DEFAULT_PREVIEW_READ_CACHE_MAX_BYTES));
    this.maxEntryBytes = Math.max(0, Math.trunc(options.maxEntryBytes ?? DEFAULT_PREVIEW_READ_CACHE_MAX_ENTRY_BYTES));
    this.clock = options.clock ?? realClock;
  }

  normalizePath(value: string): string {
    return resolve(value);
  }

  getGeneration(realPath: string): number {
    return this.fsReadGenerations.get(this.normalizePath(realPath)) ?? 0;
  }

  bumpGeneration(realPath: string): number {
    const normalized = this.normalizePath(realPath);
    const next = this.getGeneration(normalized) + 1;
    this.fsReadGenerations.set(normalized, next);
    return next;
  }

  makeSnapshotKey(realPath: string, signature: string, resourceGeneration = this.getGeneration(realPath)): string {
    return `${this.normalizePath(realPath)}::${signature}::${resourceGeneration}`;
  }

  getCached(realPath: string, signature: string): PreviewReadSnapshotSuccess | null {
    this.sweepExpired();
    const normalized = this.normalizePath(realPath);
    const cached = this.fsReadCache.get(normalized);
    if (!cached) return null;
    if (cached.expiresAt <= this.clock.now()) {
      this.deleteCached(normalized);
      return null;
    }
    if (cached.signature !== signature) return null;
    if (cached.generation !== this.getGeneration(normalized)) return null;
    return cached.value;
  }

  isWritebackEligible(input: {
    realPath: string;
    generation: number;
    startSignature: string;
    endSignature: string;
  }): boolean {
    return input.startSignature === input.endSignature
      && this.getGeneration(input.realPath) === input.generation;
  }

  writeSnapshot(value: PreviewReadSnapshotSuccess, generation = this.getGeneration(value.realPath)): boolean {
    this.sweepExpired();
    if (!this.isWritebackEligible({
      realPath: value.realPath,
      generation,
      startSignature: value.startSignature,
      endSignature: value.endSignature,
    })) {
      return false;
    }
    const normalized = this.normalizePath(value.realPath);
    const bytes = estimateSnapshotBytes(value);
    if (bytes > this.maxEntryBytes || this.maxEntries === 0 || this.maxBytes === 0) return false;
    this.deleteCached(normalized);
    this.fsReadCache.set(normalized, {
      realPath: normalized,
      signature: value.startSignature,
      generation,
      expiresAt: this.clock.now() + this.ttlMs,
      bytes,
      value,
    });
    this.fsReadCacheBytes += bytes;
    this.evictOverLimit();
    return true;
  }

  getInflight<T>(key: string): T | null {
    return (this.fsReadInflight.get(key) as T | undefined) ?? null;
  }

  setInflight<T>(key: string, value: T): void {
    this.fsReadInflight.set(key, value);
  }

  deleteInflight(key: string): void {
    this.fsReadInflight.delete(key);
  }

  invalidatePath(realPath: string): void {
    const normalized = this.normalizePath(realPath);
    this.bumpGeneration(normalized);
    this.deleteCached(normalized);
    for (const key of this.fsReadInflight.keys()) {
      if (key.startsWith(`${normalized}::`)) this.fsReadInflight.delete(key);
    }
  }

  clear(): void {
    this.fsReadCache.clear();
    this.fsReadInflight.clear();
    this.fsReadGenerations.clear();
    this.fsReadCacheBytes = 0;
  }

  cacheSize(): number {
    return this.fsReadCache.size;
  }

  cacheBytes(): number {
    return this.fsReadCacheBytes;
  }

  inflightSize(): number {
    return this.fsReadInflight.size;
  }

  private deleteCached(normalizedPath: string): void {
    const cached = this.fsReadCache.get(normalizedPath);
    if (!cached) return;
    this.fsReadCache.delete(normalizedPath);
    this.fsReadCacheBytes = Math.max(0, this.fsReadCacheBytes - cached.bytes);
  }

  private sweepExpired(): void {
    const now = this.clock.now();
    for (const [key, cached] of this.fsReadCache) {
      if (cached.expiresAt <= now) this.deleteCached(key);
    }
  }

  private evictOverLimit(): void {
    while (this.fsReadCache.size > this.maxEntries || this.fsReadCacheBytes > this.maxBytes) {
      const oldestKey = this.fsReadCache.keys().next().value as string | undefined;
      if (!oldestKey) return;
      this.deleteCached(oldestKey);
    }
  }
}

export function isPreviewReadSnapshotSuccess(value: PreviewReadWorkerSuccess): value is PreviewReadSnapshotSuccess {
  return value.phase === 'snapshot';
}

function estimateSnapshotBytes(value: PreviewReadSnapshotSuccess): number {
  const payload = value.payload;
  const baseBytes = Buffer.byteLength(value.realPath) + Buffer.byteLength(value.fileName) + 256;
  switch (payload.mode) {
    case 'text':
      return baseBytes + Buffer.byteLength(payload.content);
    case 'base64':
      return baseBytes + Buffer.byteLength(payload.content);
    case 'stream':
    case 'unavailable':
      return baseBytes;
  }
}
