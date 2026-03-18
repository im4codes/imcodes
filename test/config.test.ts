import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { vi } from 'vitest';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'deck-config-test-'));
  vi.stubEnv('HOME', tempDir);
  vi.resetModules();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('loadConfig()', () => {
  it('loads defaults when no user config exists', async () => {
    const { loadConfig } = await import('../src/config.js');
    const config = await loadConfig();
    expect(config).toBeDefined();
    // Default config should have some known keys
    expect(typeof config).toBe('object');
  });

  it('expands ${ENV_VAR} in config values', async () => {
    vi.stubEnv('MY_TEST_TOKEN', 'test-value-123');
    mkdirSync(join(tempDir, '.imcodes'), { recursive: true });
    writeFileSync(
      join(tempDir, '.imcodes', 'config.yaml'),
      'cf:\n  apiKey: ${MY_TEST_TOKEN}\n',
    );
    const { loadConfig } = await import('../src/config.js');
    const config = await loadConfig();
    expect(config.cf?.apiKey).toBe('test-value-123');
  });

  it('expands ${ENV_VAR:-default} with default value', async () => {
    // Ensure var is not set
    vi.stubEnv('UNSET_VAR_XYZ', '');
    delete process.env['UNSET_VAR_XYZ'];

    mkdirSync(join(tempDir, '.imcodes'), { recursive: true });
    writeFileSync(
      join(tempDir, '.imcodes', 'config.yaml'),
      'cf:\n  workerUrl: ${UNSET_VAR_XYZ:-https://fallback.workers.dev}\n',
    );

    const { loadConfig } = await import('../src/config.js');
    const config = await loadConfig();
    expect(config.cf?.workerUrl).toBe('https://fallback.workers.dev');
  });

  it('expands ~/ paths to home directory', async () => {
    mkdirSync(join(tempDir, '.imcodes'), { recursive: true });
    writeFileSync(
      join(tempDir, '.imcodes', 'config.yaml'),
      'someDir: ~/mydir\n',
    );
    const { loadConfig } = await import('../src/config.js');
    const config = await loadConfig();
    expect((config as Record<string, unknown>).someDir).toContain(tempDir);
  });

  it('deep merges user config over defaults', async () => {
    mkdirSync(join(tempDir, '.imcodes'), { recursive: true });
    writeFileSync(
      join(tempDir, '.imcodes', 'config.yaml'),
      'cf:\n  workerUrl: https://my.workers.dev\n',
    );
    const { loadConfig } = await import('../src/config.js');
    const config = await loadConfig();
    expect(config.cf?.workerUrl).toBe('https://my.workers.dev');
  });

  it('handles missing config file gracefully', async () => {
    // No config file — should use defaults
    const { loadConfig } = await import('../src/config.js');
    await expect(loadConfig()).resolves.not.toThrow();
  });
});
