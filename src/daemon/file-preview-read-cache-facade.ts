import { resolve } from 'node:path';
import type {
  PreviewReadSnapshotSuccess,
  PreviewReadWorkerSuccess,
} from './file-preview-read-types.js';

export const DEFAULT_PREVIEW_READ_CACHE_TTL_MS = 5_000;

export interface PreviewReadCacheClock {
  now(): number;
}

export interface PreviewReadCachedSnapshot {
  realPath: string;
  signature: string;
  generation: number;
  expiresAt: number;
  value: PreviewReadSnapshotSuccess;
}

export interface PreviewReadCacheFacadeOptions {
  ttlMs?: number;
  clock?: PreviewReadCacheClock;
}

const realClock: PreviewReadCacheClock = { now: () => Date.now() };

export class PreviewReadCacheFacade {
  private readonly ttlMs: number;
  private readonly clock: PreviewReadCacheClock;
  private readonly fsReadCache = new Map<string, PreviewReadCachedSnapshot>();
  private readonly fsReadInflight = new Map<string, unknown>();
  private readonly fsReadGenerations = new Map<string, number>();

  constructor(options: PreviewReadCacheFacadeOptions = {}) {
    this.ttlMs = Math.max(0, Math.trunc(options.ttlMs ?? DEFAULT_PREVIEW_READ_CACHE_TTL_MS));
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
    const normalized = this.normalizePath(realPath);
    const cached = this.fsReadCache.get(normalized);
    if (!cached) return null;
    if (cached.expiresAt <= this.clock.now()) {
      this.fsReadCache.delete(normalized);
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
    if (!this.isWritebackEligible({
      realPath: value.realPath,
      generation,
      startSignature: value.startSignature,
      endSignature: value.endSignature,
    })) {
      return false;
    }
    const normalized = this.normalizePath(value.realPath);
    this.fsReadCache.set(normalized, {
      realPath: normalized,
      signature: value.startSignature,
      generation,
      expiresAt: this.clock.now() + this.ttlMs,
      value,
    });
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
    this.fsReadCache.delete(normalized);
    for (const key of this.fsReadInflight.keys()) {
      if (key.startsWith(`${normalized}::`)) this.fsReadInflight.delete(key);
    }
  }

  clear(): void {
    this.fsReadCache.clear();
    this.fsReadInflight.clear();
    this.fsReadGenerations.clear();
  }

  cacheSize(): number {
    return this.fsReadCache.size;
  }

  inflightSize(): number {
    return this.fsReadInflight.size;
  }
}

export function isPreviewReadSnapshotSuccess(value: PreviewReadWorkerSuccess): value is PreviewReadSnapshotSuccess {
  return value.phase === 'snapshot';
}
