import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadMemoryConfig, DEFAULT_MEMORY_CONFIG } from '../../src/context/memory-config.js';
import { getCounter, resetMetricsForTests } from '../../src/util/metrics.js';
import { resetRateLimitedWarnForTests } from '../../src/util/rate-limited-warn.js';
import { redactSensitiveText } from '../../src/util/redact-secrets.js';

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), `memory-config-${process.pid}-`));
}

describe('memory config', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    resetMetricsForTests();
    resetRateLimitedWarnForTests();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('uses defaults when no .imc/memory.yaml exists', async () => {
    const dir = await tempProject();
    dirs.push(dir);
    expect(loadMemoryConfig(dir)).toMatchObject(DEFAULT_MEMORY_CONFIG);
  });

  it('walks upward and applies numeric overrides plus extra redaction patterns', async () => {
    const dir = await tempProject();
    dirs.push(dir);
    await mkdir(join(dir, '.imc'), { recursive: true });
    await mkdir(join(dir, 'packages', 'app'), { recursive: true });
    await writeFile(join(dir, '.imc', 'memory.yaml'), 'autoTriggerTokens: 1234\nminEventCount: 2\narchiveRetentionDays: -1\nredactPatterns:\n  - custom-secret-[0-9]+\n', 'utf8');
    const cfg = loadMemoryConfig(join(dir, 'packages', 'app'));
    expect(cfg.autoTriggerTokens).toBe(1234);
    expect(cfg.minEventCount).toBe(2);
    expect(cfg.archiveRetentionDays).toBe(-1);
    expect(redactSensitiveText('custom-secret-42', cfg.extraRedactPatterns)).toContain('[REDACTED:custom]');
  });

  it('warns, increments diagnostics, and falls back to defaults on malformed yaml', async () => {
    const dir = await tempProject();
    dirs.push(dir);
    await mkdir(join(dir, '.imc'), { recursive: true });
    await writeFile(join(dir, '.imc', 'memory.yaml'), 'autoTriggerTokens: [unterminated', 'utf8');
    const cfg = loadMemoryConfig(dir);
    expect(cfg.autoTriggerTokens).toBe(DEFAULT_MEMORY_CONFIG.autoTriggerTokens);
    expect(getCounter('mem.startup.silent_failure', { source: 'memory-config' })).toBe(1);
  });
});
