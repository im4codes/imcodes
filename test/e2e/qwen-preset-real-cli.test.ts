/**
 * Integration test: verifies the real qwen CLI accepts the env+settings produced
 * by getQwenPresetTransportConfig for a minimax-style anthropic-compatible preset.
 *
 * Run with: npx vitest run test/e2e/qwen-preset-real-cli.test.ts
 *
 * This test is slow (spawns the real qwen CLI) so it is NOT included in the
 * default test run. Pass --ui or --coverage to include it, or run it manually.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:util';
import { spawn } from 'node:child_process';

const execFileAsync = execFile as (file: string, args: string[], options?: Record<string, unknown>) => Promise<[string, string, number]>;

const flushAsync = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => process.nextTick(r));
};

describe('qwen preset real CLI integration', () => {
  const state = vi.hoisted(() => ({
    home: '',
  }));

  vi.mock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>();
    return { ...actual, homedir: () => state.home };
  });

  beforeEach(async () => {
    state.home = await mkdtemp(join(tmpdir(), 'imcodes-qwen-preset-real-'));
    await mkdir(join(state.home, '.imcodes'), { recursive: true });
    await writeFile(
      join(state.home, '.imcodes', 'cc-presets.json'),
      JSON.stringify([
        {
          name: 'minimax',
          env: {
            ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic',
            ANTHROPIC_AUTH_TOKEN: 'sk-test-token-for-integration',
            ANTHROPIC_MODEL: 'MiniMax-M2.7',
          },
          contextWindow: 200000,
        },
      ]),
      'utf8',
    );
  });

  afterEach(async () => {
    vi.resetModules();
    if (state.home) await rm(state.home, { recursive: true, force: true });
    state.home = '';
  });

  it('real qwen CLI accepts OPENAI_API_KEY + OPENAI_BASE_URL + --auth-type anthropic and uses the correct model', async () => {
    // This test verifies the exact env/shell flow that getQwenPresetTransportConfig produces
    // gets accepted by the real qwen CLI.  It does NOT make real API calls (the
    // test-token is invalid) but confirms the qwen CLI correctly parses our config
    // and selects the correct model before failing on auth.
    const { getQwenPresetTransportConfig } = await import('../../src/daemon/cc-presets.js');

    const config = await getQwenPresetTransportConfig('minimax');

    // Verify the env has both ANTHROPIC_* (for compatibility) and OPENAI_*
    // (which the qwen CLI actually reads for --auth-type anthropic).
    expect(config.env.ANTHROPIC_BASE_URL).toBe('https://api.minimax.io/anthropic');
    expect(config.env.ANTHROPIC_API_KEY).toBe('sk-test-token-for-integration');
    expect(config.env.ANTHROPIC_MODEL).toBe('MiniMax-M2.7');
    expect(config.env.OPENAI_BASE_URL).toBe('https://api.minimax.io/anthropic');
    expect(config.env.OPENAI_API_KEY).toBe('sk-test-token-for-integration');
    expect(config.model).toBe('MiniMax-M2.7');

    // Write settings file (simulating what the qwen provider does via ensureSettingsPath)
    const settingsPath = join(tmpdir(), `qwen-settings-${Date.now()}.json`);
    const settingsPayload = JSON.stringify({
      ...config.settings,
      model: {
        name: 'MiniMax-M2.7',
        generationConfig: {
          contextWindowSize: 200000,
        },
      },
    });
    await writeFile(settingsPath, settingsPayload, 'utf8');

    try {
      // Spawn real qwen CLI with the exact env + settings the provider passes
      const child = spawn('qwen', [
        '-p', 'hello',
        '--output-format', 'stream-json',
        '--auth-type', 'anthropic',
        '--model', 'MiniMax-M2.7',
        '--approval-mode', 'yolo',
      ], {
        cwd: tmpdir(),
        env: {
          ...process.env,
          OPENAI_API_KEY: config.env.OPENAI_API_KEY!,
          OPENAI_BASE_URL: config.env.OPENAI_BASE_URL!,
          QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsPath,
        },
      });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      const exitCode = await new Promise<number>((resolve) => {
        child.on('close', (code) => resolve(code ?? 1));
        // Safety timeout
        setTimeout(() => {
          child.kill();
          resolve(124);
        }, 30_000);
      });

      // The CLI should produce JSON output.  With an invalid test-token it will fail
      // with an auth error, but it should parse the config and select the correct model
      // BEFORE hitting the auth failure.  We verify the model appears in the output.
      const lines = stdout.split('\n').filter(Boolean);
      const initLine = lines.find((l) => {
        try { return JSON.parse(l).type === 'system' && (JSON.parse(l).subtype === 'init' || JSON.parse(l).model); } catch { return false; }
      });
      const init = initLine ? JSON.parse(initLine) : null;

      // The init system event should contain the correct model.
      // We also print stderr for debugging.
      if (stderr) {
        console.warn('[qwen stderr]', stderr.slice(0, 200));
      }

      // The init message (or any JSON line) should reference MiniMax-M2.7 as the model
      // If the CLI had rejected our env/settings, it would fail to parse or not use the model.
      const modelLine = lines.find((l) => l.includes('MiniMax-M2.7'));
      expect(modelLine, `qwen CLI should reference MiniMax-M2.7 in output. Got: ${lines.slice(0, 3).join('\n')}`).toBeTruthy();

      // Verify the init system event contains the correct model
      if (init?.model) {
        expect(init.model).toBe('MiniMax-M2.7');
      }
      if (init?.message?.model) {
        expect(init.message.model).toBe('MiniMax-M2.7');
      }
    } finally {
      await rm(settingsPath, { force: true });
    }
  });
});
