import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseAgyUsageTsv,
  fetchAgyUsageQuota,
  recordAgyQuotaActivity,
  peekAgyUsageQuotaCached,
  setAgyUsageExecFn,
  __resetAgyUsageQuotaCache,
  type AgyUsageQuota,
} from '../../src/agent/agy-usage-quota.js';
import { AGY_USAGE_CACHE_FILE_NAME, AGY_USAGE_CACHE_TTL_MS, AGY_USAGE_FAILURE_BACKOFF_MS, AGY_USAGE_IDLE_SUPPRESS_MS, AGY_USAGE_MAX_PERSISTED_AGE_MS } from '../../shared/agy-usage.js';
import { AGY_CLI_PATH_ENV } from '../../shared/agy-agent.js';
import { formatProviderQuotaLabel } from '../../shared/provider-quota.js';
import { imcodesStateDir, imcodesStatePath } from '../../src/util/imcodes-state-dir.js';

const SAMPLE_PATH = join(__dirname, '../fixtures/agy-usage/sample.tsv');
const SAMPLE_TSV = readFileSync(SAMPLE_PATH, 'utf8');

describe('parseAgyUsageTsv', () => {
  it('parses the 4-line happy path sample.tsv with exact inverted percent and epoch seconds', () => {
    const meta = parseAgyUsageTsv(SAMPLE_TSV);
    expect(meta).toBeDefined();
    expect(meta?.primary).toBeUndefined();
    expect(meta?.secondary).toBeUndefined();
    expect(meta?.groups).toHaveLength(2);

    const [gemini, claudeGpt] = meta!.groups!;

    // Gemini Models
    expect(gemini.id).toBe('gemini');
    expect(gemini.label).toBe('Gemini');
    expect(gemini.primary).toEqual({
      windowDurationMins: 300,
      usedPercent: 6, // 100 - 94%
      percentPrecision: 2,
      resetsAt: 1791666877, // 2026-10-10T21:14:37Z
    });
    expect(gemini.secondary).toEqual({
      windowDurationMins: 10080,
      usedPercent: 0, // 100 - 100%
      percentPrecision: 2,
      resetsAt: 1792253677, // 2026-10-17T16:14:37Z
    });

    // Claude and GPT models
    expect(claudeGpt.id).toBe('claude-gpt');
    expect(claudeGpt.label).toBe('Claude/GPT');
    expect(claudeGpt.primary).toEqual({
      windowDurationMins: 300,
      usedPercent: 20, // 100 - 80%
      percentPrecision: 2,
      resetsAt: 1791666997, // 2026-10-10T21:16:37Z
    });
    expect(claudeGpt.secondary).toEqual({
      windowDurationMins: 10080,
      usedPercent: 11, // 100 - 89%
      percentPrecision: 2,
      resetsAt: 1792253797, // 2026-10-17T16:16:37Z
    });
  });

  it('preserves up to 2 decimal places and formats with 2 decimal places', () => {
    const decimalTsv = 'Gemini Models\tFive Hour Limit Remaining\t94.55%\t2026-10-10T21:14:37Z\n';
    const meta = parseAgyUsageTsv(decimalTsv);
    expect(meta?.groups?.[0].primary?.usedPercent).toBe(5.45);
    expect(meta?.groups?.[0].primary?.percentPrecision).toBe(2);
    const label = formatProviderQuotaLabel(meta);
    expect(label).toContain('5.45%');
  });

  it('handles CRLF line endings identically to LF', () => {
    const crlfTsv = SAMPLE_TSV.replace(/\n/g, '\r\n');
    const meta = parseAgyUsageTsv(crlfTsv);
    expect(meta?.groups).toHaveLength(2);
    expect(meta?.groups?.[0].primary?.usedPercent).toBe(6);
    expect(meta?.groups?.[1].primary?.usedPercent).toBe(20);
  });

  it('ignores garbage and error lines mixed into the output', () => {
    const noisyTsv = [
      'error getting token source: You are not logged into Antigravity',
      'Quota:',
      'Gemini Models\tWeekly Limit Remaining\t100%\t2026-10-17T16:14:37Z',
      'random single column line',
      'two\tcolumns',
      'three\tcolumns\there',
      'five\tcolumns\there\ttoo\tmany',
      'Gemini Models\tFive Hour Limit Remaining\t94%\t2026-10-10T21:14:37Z',
      'error: Eligibility check failed... i/o timeout',
    ].join('\n');

    const meta = parseAgyUsageTsv(noisyTsv);
    expect(meta?.groups).toHaveLength(1);
    const gemini = meta!.groups![0];
    expect(gemini.id).toBe('gemini');
    expect(gemini.primary?.usedPercent).toBe(6);
    expect(gemini.secondary?.usedPercent).toBe(0);
  });

  it('handles a free-tier missing weekly window', () => {
    const freeTierTsv = 'Gemini Models\tFive Hour Limit Remaining\t94%\t2026-10-10T21:14:37Z\n';
    const meta = parseAgyUsageTsv(freeTierTsv);
    expect(meta?.groups).toHaveLength(1);
    expect(meta?.groups?.[0].primary).toEqual({
      windowDurationMins: 300,
      usedPercent: 6,
      percentPrecision: 2,
      resetsAt: 1791666877,
    });
    expect(meta?.groups?.[0].secondary).toBeUndefined();
  });

  it('handles missing Claude tier', () => {
    const onlyGeminiTsv = [
      'Gemini Models\tWeekly Limit Remaining\t100%\t2026-10-17T16:14:37Z',
      'Gemini Models\tFive Hour Limit Remaining\t94%\t2026-10-10T21:14:37Z',
    ].join('\n');
    const meta = parseAgyUsageTsv(onlyGeminiTsv);
    expect(meta?.groups).toHaveLength(1);
    expect(meta?.groups?.[0].id).toBe('gemini');
  });

  it('parses real multi-space column aligned output with local timezone and banner', () => {
    const realOutput = [
      'Quota:',
      'Gemini Models          Weekly Limit Remaining     99%  2026-10-18 00:14 CST',
      'Gemini Models          Five Hour Limit Remaining  89%  2026-10-11 05:14 CST',
      'Claude and GPT models  Weekly Limit Remaining     84%  2026-10-18 00:16 CST',
      'Claude and GPT models  Five Hour Limit Remaining  68%  2026-10-11 05:16 CST',
    ].join('\n');
    const meta = parseAgyUsageTsv(realOutput);
    expect(meta).toBeDefined();
    expect(meta?.groups).toHaveLength(2);
    const [gemini, claudeGpt] = meta!.groups!;
    expect(gemini.id).toBe('gemini');
    expect(gemini.secondary?.usedPercent).toBe(1);
    expect(gemini.primary?.usedPercent).toBe(11);
    expect(gemini.primary?.resetsAt).toBeDefined();
    expect(claudeGpt.id).toBe('claude-gpt');
    expect(claudeGpt.secondary?.usedPercent).toBe(16);
    expect(claudeGpt.primary?.usedPercent).toBe(32);
    expect(claudeGpt.primary?.resetsAt).toBeDefined();
  });

  it('appends unknown tiers after known groups in encounter order with slug ids', () => {
    const customTsv = [
      'Custom Reasoning Models\tFive Hour Limit Remaining\t50%\t2026-10-10T21:14:37Z',
      'Claude and GPT models\tFive Hour Limit Remaining\t80%\t2026-10-10T21:16:37Z',
      'Another Tier\tWeekly Limit Remaining\t70%\t2026-10-17T16:14:37Z',
      'Gemini Models\tFive Hour Limit Remaining\t94%\t2026-10-10T21:14:37Z',
    ].join('\n');

    const meta = parseAgyUsageTsv(customTsv);
    expect(meta?.groups).toHaveLength(4);
    // Known groups appear first in canonical order: Gemini, then Claude/GPT
    expect(meta?.groups?.[0].id).toBe('gemini');
    expect(meta?.groups?.[1].id).toBe('claude-gpt');
    // Unknown groups appended in encounter order
    expect(meta?.groups?.[2].id).toBe('custom-reasoning-models');
    expect(meta?.groups?.[2].label).toBe('Custom Reasoning Models');
    expect(meta?.groups?.[2].primary?.usedPercent).toBe(50);
    expect(meta?.groups?.[3].id).toBe('another-tier');
    expect(meta?.groups?.[3].label).toBe('Another Tier');
    expect(meta?.groups?.[3].secondary?.usedPercent).toBe(30);
  });

  it('returns undefined for empty, undefined, or whitespace-only input', () => {
    expect(parseAgyUsageTsv('')).toBeUndefined();
    expect(parseAgyUsageTsv('   \n  \t  ')).toBeUndefined();
    expect(parseAgyUsageTsv(undefined)).toBeUndefined();
    expect(parseAgyUsageTsv(null)).toBeUndefined();
    expect(parseAgyUsageTsv('only errors\nand nothing valid\n')).toBeUndefined();
  });
});

describe('fetchAgyUsageQuota fetcher & cache logic', () => {
  let tempStateDir: string;
  let originalImcodesHome: string | undefined;

  beforeEach(() => {
    originalImcodesHome = process.env.IMCODES_HOME;
    tempStateDir = mkdtempSync(join(tmpdir(), 'agy-quota-test-'));
    process.env.IMCODES_HOME = tempStateDir;
    __resetAgyUsageQuotaCache();
  });

  afterEach(() => {
    __resetAgyUsageQuotaCache();
    if (tempStateDir && existsSync(tempStateDir)) {
      rmSync(tempStateDir, { recursive: true, force: true });
    }
    if (originalImcodesHome === undefined) {
      delete process.env.IMCODES_HOME;
    } else {
      process.env.IMCODES_HOME = originalImcodesHome;
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('single-flight: 3 concurrent callers share 1 exec call', async () => {
    recordAgyQuotaActivity(Date.now());
    let execCount = 0;
    const mockExec = vi.fn(async () => {
      execCount += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { stdout: SAMPLE_TSV, stderr: '' };
    });

    const [r1, r2, r3] = await Promise.all([
      fetchAgyUsageQuota({ execFn: mockExec }),
      fetchAgyUsageQuota({ execFn: mockExec }),
      fetchAgyUsageQuota({ execFn: mockExec }),
    ]);

    expect(execCount).toBe(1);
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(r1?.quotaMeta.groups).toHaveLength(2);
    expect(r2).toBe(r1);
    expect(r3).toBe(r1);
  });

  it('serves from TTL cache without executing when fresh', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    recordAgyQuotaActivity(now);

    const mockExec = vi.fn(async () => ({ stdout: SAMPLE_TSV, stderr: '' }));

    const first = await fetchAgyUsageQuota({ execFn: mockExec });
    expect(mockExec).toHaveBeenCalledTimes(1);

    // Advance 5 minutes (still within 15 min TTL)
    vi.setSystemTime(now + 5 * 60 * 1000);
    const second = await fetchAgyUsageQuota({ execFn: mockExec });
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('forceRefresh bypasses TTL cache, backoff, and idle suppression', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    // Not active (idle suppression would normally trigger)

    const mockExec = vi.fn(async () => ({ stdout: SAMPLE_TSV, stderr: '' }));

    const r = await fetchAgyUsageQuota({ forceRefresh: true, execFn: mockExec });
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(r?.quotaMeta.groups).toHaveLength(2);
  });

  it('failure backoff prevents retry storms within 5 minutes', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    recordAgyQuotaActivity(now);

    let calls = 0;
    const mockExec = vi.fn(async () => {
      calls += 1;
      throw new Error('network down');
    });

    const first = await fetchAgyUsageQuota({ execFn: mockExec });
    expect(first).toBeNull();
    expect(calls).toBe(1);

    // Call again after 2 minutes — backoff (5 min) suppresses the execution
    vi.setSystemTime(now + 2 * 60 * 1000);
    const second = await fetchAgyUsageQuota({ execFn: mockExec });
    expect(second).toBeNull();
    expect(calls).toBe(1);

    // Advance past failure backoff (6 minutes)
    vi.setSystemTime(now + 6 * 60 * 1000);
    recordAgyQuotaActivity(now + 6 * 60 * 1000);
    await fetchAgyUsageQuota({ execFn: mockExec });
    expect(calls).toBe(2);
  });

  it('idle suppression serves persisted snapshot without probing', async () => {
    // Seed persisted snapshot on disk
    mkdirSync(imcodesStateDir(), { recursive: true });
    const cachePath = imcodesStatePath(AGY_USAGE_CACHE_FILE_NAME);
    const meta = parseAgyUsageTsv(SAMPLE_TSV)!;
    const persistedEntry = {
      at: Date.now() - 30 * 60 * 1000, // 30 min old (>15m TTL)
      value: { quotaMeta: meta, quotaLabel: 'persisted-agy-label' },
    };
    writeFileSync(cachePath, JSON.stringify(persistedEntry), 'utf8');

    // Idle: no recent activity recorded
    const mockExec = vi.fn(async () => ({ stdout: SAMPLE_TSV, stderr: '' }));
    const result = await fetchAgyUsageQuota({ execFn: mockExec });

    expect(mockExec).not.toHaveBeenCalled();
    expect(result?.quotaLabel).toBe('persisted-agy-label');
  });

  it('persisted snapshot older than 24h is dropped', async () => {
    mkdirSync(imcodesStateDir(), { recursive: true });
    const cachePath = imcodesStatePath(AGY_USAGE_CACHE_FILE_NAME);
    const meta = parseAgyUsageTsv(SAMPLE_TSV)!;
    const expiredEntry = {
      at: Date.now() - (AGY_USAGE_MAX_PERSISTED_AGE_MS + 1000),
      value: { quotaMeta: meta, quotaLabel: 'ancient-label' },
    };
    writeFileSync(cachePath, JSON.stringify(expiredEntry), 'utf8');

    expect(peekAgyUsageQuotaCached()).toBeNull();
  });

  it('exec failure returns last good value and never throws', async () => {
    recordAgyQuotaActivity(Date.now());
    const mockExecSuccess = vi.fn(async () => ({ stdout: SAMPLE_TSV, stderr: '' }));
    const initial = await fetchAgyUsageQuota({ execFn: mockExecSuccess });
    expect(initial?.quotaMeta.groups).toHaveLength(2);

    // Now fail on forceRefresh
    const mockExecFailure = vi.fn(async () => {
      throw new Error('dial tcp timeout');
    });
    const fallback = await fetchAgyUsageQuota({ forceRefresh: true, execFn: mockExecFailure });
    // Returns last good cached value without throwing
    expect(fallback).toEqual(initial);
  });
});

describe('fake agy script integration via real execFile', () => {
  let tempDir: string;
  let fakeAgyPath: string;

  beforeEach(() => {
    __resetAgyUsageQuotaCache();
    tempDir = mkdtempSync(join(tmpdir(), 'agy-quota-test-'));
    fakeAgyPath = join(tempDir, 'fake-agy');
    const fakeScript = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--print' && args[1] === '/usage') {
  process.stdout.write(${JSON.stringify(SAMPLE_TSV)});
  process.exit(0);
}
process.exit(1);
`;
    writeFileSync(fakeAgyPath, fakeScript, { mode: 0o755 });
    chmodSync(fakeAgyPath, 0o755);
    process.env[AGY_CLI_PATH_ENV] = fakeAgyPath;
  });

  afterEach(() => {
    delete process.env[AGY_CLI_PATH_ENV];
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    __resetAgyUsageQuotaCache();
  });

  it('spawns fake agy script, parses TSV, and produces formatted one-line label', async () => {
    const quota = await fetchAgyUsageQuota({ forceRefresh: true });
    expect(quota).toBeDefined();
    expect(quota?.quotaMeta.groups).toHaveLength(2);
    expect(quota?.quotaLabel).toBeDefined();
    // One line label containing Gemini and Claude/GPT groups separated by ' | '
    expect(quota?.quotaLabel).toMatch(/^Gemini 5h 6\.00% .* · 7d 0\.00% .* \| Claude\/GPT 5h 20\.00% .* · 7d 11\.00% /);
  });
});
