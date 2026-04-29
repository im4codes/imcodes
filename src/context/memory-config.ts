import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import YAML from 'yaml';
import { warnOncePerHour } from '../util/rate-limited-warn.js';
import { incrementCounter } from '../util/metrics.js';
import { compileExtraRedactPatterns } from '../util/redact-secrets.js';

export interface MemoryConfig {
  autoTriggerTokens: number;
  minEventCount: number;
  idleMs: number;
  scheduleMs: number;
  maxBatchTokens: number;
  /** `0` = use proportional `computeTargetTokens('auto')`; positive = hard override. */
  autoMaterializationTargetTokens: number;
  /** `0` = use proportional `computeTargetTokens('manual')`; positive = hard override. */
  manualCompactTargetTokens: number;
  maxEventChars: number;
  previousSummaryMaxTokens: number;
  masterIdleHours: number;
  /** `-1` disables; positive = retention window in days. Daemon-global in Phase 1. */
  archiveRetentionDays: number;
  redactPatterns: string[];
  extraRedactPatterns: RegExp[];
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  autoTriggerTokens: 3000,
  minEventCount: 5,
  idleMs: 300_000,
  scheduleMs: 900_000,
  maxBatchTokens: 10_000,
  // Sentinel `0` = proportional `computeTargetTokens(...)` runs by default
  // (memory-system-1.1-foundations spec.md:218-223). Set a positive value
  // in `.imc/memory.yaml` to force a hard override.
  autoMaterializationTargetTokens: 0,
  manualCompactTargetTokens: 0,
  maxEventChars: 2000,
  previousSummaryMaxTokens: 1000,
  masterIdleHours: 6,
  archiveRetentionDays: 30,
  redactPatterns: [],
  extraRedactPatterns: [],
};

function findConfigPath(cwd: string): string | null {
  let dir = resolve(cwd || process.cwd());
  const root = parse(dir).root;
  while (true) {
    const candidate = join(dir, '.imc', 'memory.yaml');
    if (existsSync(candidate)) return candidate;
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Domain-validating coercion helpers
//
// `numberOverride` was permissive: it accepted any finite number, which let
// `archiveRetentionDays: 0` silently mass-delete every uncited archive row at
// the daemon's first sweep. These helpers replace it with field-aware clamps
// that warn-once + count when the YAML supplies an out-of-domain value.
// (memory-system-1.1-foundations P1)

function reportInvalid(field: string, raw: unknown, applied: number): void {
  warnOncePerHour('memory_config_invalid_value', {
    field,
    raw: typeof raw === 'number' ? raw : String(raw),
    applied,
  });
  incrementCounter('mem.config.invalid_value', { field });
}

function isFiniteNumber(raw: unknown): raw is number {
  return typeof raw === 'number' && Number.isFinite(raw);
}

/** Accept positive integers ≥ `min`. Anything else falls back + warns. */
function clampPositive(raw: unknown, fallback: number, min = 1, field?: string): number {
  if (raw === undefined || raw === null) return fallback;
  if (!isFiniteNumber(raw)) {
    if (field) reportInvalid(field, raw, fallback);
    return fallback;
  }
  if (raw < min) {
    if (field) reportInvalid(field, raw, fallback);
    return fallback;
  }
  return raw;
}

/** Accept non-negative integers ≥ `min` (used for sentinel `0` semantics). */
function clampNonNegative(raw: unknown, fallback: number, min = 0, field?: string): number {
  if (raw === undefined || raw === null) return fallback;
  if (!isFiniteNumber(raw)) {
    if (field) reportInvalid(field, raw, fallback);
    return fallback;
  }
  if (raw < min) {
    if (field) reportInvalid(field, raw, fallback);
    return fallback;
  }
  return raw;
}

/**
 * Accept either `sentinel` (e.g. -1 = disable) or any positive integer ≥ `min`.
 * `0` and other negative values are out-of-domain and fall back + warn.
 */
function clampPositiveOrSentinel(raw: unknown, fallback: number, sentinel: number, min = 1, field?: string): number {
  if (raw === undefined || raw === null) return fallback;
  if (!isFiniteNumber(raw)) {
    if (field) reportInvalid(field, raw, fallback);
    return fallback;
  }
  if (raw === sentinel) return sentinel;
  if (raw < min) {
    if (field) reportInvalid(field, raw, fallback);
    return fallback;
  }
  return raw;
}

export function loadMemoryConfig(cwd: string): MemoryConfig {
  const path = findConfigPath(cwd);
  if (!path) return { ...DEFAULT_MEMORY_CONFIG, redactPatterns: [], extraRedactPatterns: [] };
  try {
    const parsed = YAML.parse(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
    const source = parsed && typeof parsed === 'object' ? parsed : {};
    const redactPatterns = Array.isArray(source.redactPatterns)
      ? source.redactPatterns.filter((v): v is string => typeof v === 'string')
      : [];
    return {
      ...DEFAULT_MEMORY_CONFIG,
      autoTriggerTokens: clampPositive(source.autoTriggerTokens, DEFAULT_MEMORY_CONFIG.autoTriggerTokens, 1, 'autoTriggerTokens'),
      minEventCount: clampPositive(source.minEventCount, DEFAULT_MEMORY_CONFIG.minEventCount, 1, 'minEventCount'),
      idleMs: clampPositive(source.idleMs, DEFAULT_MEMORY_CONFIG.idleMs, 1000, 'idleMs'),
      scheduleMs: clampPositive(source.scheduleMs, DEFAULT_MEMORY_CONFIG.scheduleMs, 1000, 'scheduleMs'),
      maxBatchTokens: clampPositive(source.maxBatchTokens, DEFAULT_MEMORY_CONFIG.maxBatchTokens, 1, 'maxBatchTokens'),
      autoMaterializationTargetTokens: clampNonNegative(
        source.autoMaterializationTargetTokens,
        DEFAULT_MEMORY_CONFIG.autoMaterializationTargetTokens,
        0,
        'autoMaterializationTargetTokens',
      ),
      manualCompactTargetTokens: clampNonNegative(
        source.manualCompactTargetTokens,
        DEFAULT_MEMORY_CONFIG.manualCompactTargetTokens,
        0,
        'manualCompactTargetTokens',
      ),
      maxEventChars: clampPositive(source.maxEventChars, DEFAULT_MEMORY_CONFIG.maxEventChars, 1, 'maxEventChars'),
      previousSummaryMaxTokens: clampPositive(source.previousSummaryMaxTokens, DEFAULT_MEMORY_CONFIG.previousSummaryMaxTokens, 1, 'previousSummaryMaxTokens'),
      masterIdleHours: clampPositive(source.masterIdleHours, DEFAULT_MEMORY_CONFIG.masterIdleHours, 1, 'masterIdleHours'),
      archiveRetentionDays: clampPositiveOrSentinel(
        source.archiveRetentionDays,
        DEFAULT_MEMORY_CONFIG.archiveRetentionDays,
        -1,
        1,
        'archiveRetentionDays',
      ),
      redactPatterns,
      extraRedactPatterns: compileExtraRedactPatterns(redactPatterns, (pattern, error) => {
        warnOncePerHour('memory_config_invalid_redact_pattern', {
          path,
          pattern,
          error: error.message,
        });
        incrementCounter('mem.config.invalid_redact_pattern');
      }),
    };
  } catch (error) {
    incrementCounter('mem.startup.silent_failure', { source: 'memory-config' });
    warnOncePerHour('memory_config_parse_error', { path, error: error instanceof Error ? error.message : String(error) });
    return { ...DEFAULT_MEMORY_CONFIG, redactPatterns: [], extraRedactPatterns: [] };
  }
}
