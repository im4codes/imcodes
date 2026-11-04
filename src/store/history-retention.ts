import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveImcodesHome } from '../util/windows-daemon-lock.js';
import { assertNotRealImcodesPathInTests } from '../util/test-home-guard.js';

/** Passed to the raw-TS worker so it needs no runtime local imports. */
export const HISTORY_RETENTION = {
  fileName: 'history-retention.json',
  dayMs: 86_400_000,
  maxDays: 100_000_000, // Date's entire supported range; multiplication stays exact/safe.
  retryMs: 60_000,
  batchSize: 500,
} as const;

export function historyRetentionPath(): string {
  const path = join(resolveImcodesHome(), HISTORY_RETENTION.fileName);
  assertNotRealImcodesPathInTests(path, 'history retention settings');
  return path;
}

export function parseHistoryKeep(value: string): number | null {
  if (value === 'off') return null;
  const days = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(days) || days > HISTORY_RETENTION.maxDays) {
    throw new Error(`Expected off or a positive integer number of days (1..${HISTORY_RETENTION.maxDays}).`);
  }
  return days;
}

export function getHistoryKeep(): number | null {
  try {
    const raw = JSON.parse(readFileSync(historyRetentionPath(), 'utf8'));
    if (raw.keepDays === null) return null;
    if (typeof raw.keepDays !== 'number') throw new Error('Invalid history retention config');
    return parseHistoryKeep(String(raw.keepDays));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err; // Invalid config is never silently enabled or overwritten on query.
  }
}

export function setHistoryKeep(value: string): number | null {
  const keepDays = parseHistoryKeep(value); // validate before touching any files
  const path = historyRetentionPath();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    let enabledAt = Date.now();
    try {
      const previous = JSON.parse(readFileSync(path, 'utf8'));
      if (previous.keepDays === keepDays) return keepDays;
      if (Number.isSafeInteger(previous.enabledAt)) {
        enabledAt = previous.keepDays !== null ? previous.enabledAt : Math.max(enabledAt, previous.enabledAt + 1);
      }
    } catch { /* missing or invalid prior config is replaced by the explicit setting */ }
    writeFileSync(temp, `${JSON.stringify({ keepDays, enabledAt })}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch { /* renamed or write failed */ }
  }
  return keepDays;
}
