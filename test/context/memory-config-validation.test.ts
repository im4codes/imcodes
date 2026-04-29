import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadMemoryConfig, DEFAULT_MEMORY_CONFIG } from '../../src/context/memory-config.js';
import { getCounter, resetMetricsForTests } from '../../src/util/metrics.js';
import { resetRateLimitedWarnForTests } from '../../src/util/rate-limited-warn.js';

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), `memory-config-validation-${process.pid}-`));
}

async function writeYaml(dir: string, body: string): Promise<void> {
  await mkdir(join(dir, '.imc'), { recursive: true });
  await writeFile(join(dir, '.imc', 'memory.yaml'), body, 'utf8');
}

describe('memory config domain validation (P1)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    resetMetricsForTests();
    resetRateLimitedWarnForTests();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('rejects archiveRetentionDays: 0 and falls back to default while warning', async () => {
    const dir = await tempProject();
    dirs.push(dir);
    await writeYaml(dir, 'archiveRetentionDays: 0\n');
    const cfg = loadMemoryConfig(dir);
    expect(cfg.archiveRetentionDays).toBe(DEFAULT_MEMORY_CONFIG.archiveRetentionDays);
    expect(getCounter('mem.config.invalid_value', { field: 'archiveRetentionDays' })).toBe(1);
  });

  it('rejects archiveRetentionDays: -2 (non-sentinel negative) and falls back', async () => {
    const dir = await tempProject();
    dirs.push(dir);
    await writeYaml(dir, 'archiveRetentionDays: -2\n');
    const cfg = loadMemoryConfig(dir);
    expect(cfg.archiveRetentionDays).toBe(DEFAULT_MEMORY_CONFIG.archiveRetentionDays);
    expect(getCounter('mem.config.invalid_value', { field: 'archiveRetentionDays' })).toBe(1);
  });

  it('preserves the -1 disable sentinel', async () => {
    const dir = await tempProject();
    dirs.push(dir);
    await writeYaml(dir, 'archiveRetentionDays: -1\n');
    const cfg = loadMemoryConfig(dir);
    expect(cfg.archiveRetentionDays).toBe(-1);
    expect(getCounter('mem.config.invalid_value', { field: 'archiveRetentionDays' })).toBe(0);
  });

  it('accepts a valid positive archiveRetentionDays', async () => {
    const dir = await tempProject();
    dirs.push(dir);
    await writeYaml(dir, 'archiveRetentionDays: 7\n');
    const cfg = loadMemoryConfig(dir);
    expect(cfg.archiveRetentionDays).toBe(7);
    expect(getCounter('mem.config.invalid_value', { field: 'archiveRetentionDays' })).toBe(0);
  });

  it('rejects below-min idleMs and uses default', async () => {
    const dir = await tempProject();
    dirs.push(dir);
    await writeYaml(dir, 'idleMs: 100\n'); // below 1000ms floor
    const cfg = loadMemoryConfig(dir);
    expect(cfg.idleMs).toBe(DEFAULT_MEMORY_CONFIG.idleMs);
    expect(getCounter('mem.config.invalid_value', { field: 'idleMs' })).toBe(1);
  });

  it('rejects negative maxBatchTokens', async () => {
    const dir = await tempProject();
    dirs.push(dir);
    await writeYaml(dir, 'maxBatchTokens: -100\n');
    const cfg = loadMemoryConfig(dir);
    expect(cfg.maxBatchTokens).toBe(DEFAULT_MEMORY_CONFIG.maxBatchTokens);
    expect(getCounter('mem.config.invalid_value', { field: 'maxBatchTokens' })).toBe(1);
  });

  it('accepts target-token sentinel 0 (proportional) without warning', async () => {
    const dir = await tempProject();
    dirs.push(dir);
    await writeYaml(dir, 'autoMaterializationTargetTokens: 0\nmanualCompactTargetTokens: 0\n');
    const cfg = loadMemoryConfig(dir);
    expect(cfg.autoMaterializationTargetTokens).toBe(0);
    expect(cfg.manualCompactTargetTokens).toBe(0);
    expect(getCounter('mem.config.invalid_value', { field: 'autoMaterializationTargetTokens' })).toBe(0);
    expect(getCounter('mem.config.invalid_value', { field: 'manualCompactTargetTokens' })).toBe(0);
  });

  it('rejects negative target-token overrides and falls back to sentinel default', async () => {
    const dir = await tempProject();
    dirs.push(dir);
    await writeYaml(dir, 'autoMaterializationTargetTokens: -5\n');
    const cfg = loadMemoryConfig(dir);
    expect(cfg.autoMaterializationTargetTokens).toBe(DEFAULT_MEMORY_CONFIG.autoMaterializationTargetTokens);
    expect(getCounter('mem.config.invalid_value', { field: 'autoMaterializationTargetTokens' })).toBe(1);
  });

  it('emits a counter for invalid user redact patterns', async () => {
    const dir = await tempProject();
    dirs.push(dir);
    await writeYaml(dir, 'redactPatterns:\n  - "(unclosed"\n  - "valid-[0-9]+"\n');
    const cfg = loadMemoryConfig(dir);
    // Valid pattern still compiles; invalid one is reported via counter.
    expect(cfg.extraRedactPatterns.length).toBe(1);
    expect(getCounter('mem.config.invalid_redact_pattern')).toBe(1);
  });
});
