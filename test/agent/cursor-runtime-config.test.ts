import { describe, it, expect, vi, beforeEach } from 'vitest';

const childProcessMock = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  ...childProcessMock,
  default: childProcessMock,
}));

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const transportPathsMock = vi.hoisted(() => ({
  resolveCursorPathForSdk: vi.fn((bin = 'cursor-agent') => bin),
  resolveCursorLaunchPlan: vi.fn((bin = 'cursor-agent') => ({ direct: { executable: bin, prependArgs: [] } })),
  hasPendingCursorStagedUpdate: vi.fn(() => false),
  resolveCursorExecutableForSpawn: vi.fn((bin = 'cursor-agent') => ({ executable: bin, prependArgs: [] })),
  resolveExecutableForSpawn: vi.fn((bin: string) => ({ executable: bin, prependArgs: [] })),
}));

// Stabilize the transport-paths resolution so tests don't depend on PATH lookups.
vi.mock('../../src/agent/transport-paths.js', () => transportPathsMock);

import {
  getCursorRuntimeConfig,
  __cursorRuntimeConfigInternals,
} from '../../src/agent/cursor-runtime-config.js';

const { parseListModelsOutput, parseStatusOutput } = __cursorRuntimeConfigInternals;

describe('cursor-runtime-config parsers', () => {
  beforeEach(() => {
    __cursorRuntimeConfigInternals.clearCache();
    childProcessMock.execFile.mockReset();
    transportPathsMock.resolveCursorPathForSdk.mockImplementation((bin = 'cursor-agent') => bin);
    transportPathsMock.resolveCursorLaunchPlan.mockImplementation((bin = 'cursor-agent') => ({
      direct: { executable: bin, prependArgs: [] },
    }));
    transportPathsMock.hasPendingCursorStagedUpdate.mockImplementation(() => false);
  });

  describe('parseListModelsOutput', () => {
    it('extracts model ids and the default model from raw CLI output', () => {
      const raw = [
        'Available models',
        '',
        'auto - Auto',
        'composer-2-fast - Composer 2 Fast  (default)',
        'composer-2 - Composer 2',
        'gpt-5.2 - GPT-5.2',
        'claude-4.5-sonnet - Sonnet 4.5 1M',
        '',
        'Tip: use --model <id>',
      ].join('\n');
      const parsed = parseListModelsOutput(raw);
      expect(parsed.availableModels).toEqual([
        'auto',
        'composer-2-fast',
        'composer-2',
        'gpt-5.2',
        'claude-4.5-sonnet',
      ]);
      expect(parsed.defaultModel).toBe('composer-2-fast');
    });

    it('strips ANSI escape sequences before parsing', () => {
      const raw = '\x1B[2K\x1B[GAvailable models\n\nauto - Auto\ngpt-5.2 - GPT-5.2  (default)\n';
      const parsed = parseListModelsOutput(raw);
      expect(parsed.availableModels).toEqual(['auto', 'gpt-5.2']);
      expect(parsed.defaultModel).toBe('gpt-5.2');
    });

    it('returns an empty list when the CLI output is unrecognizable', () => {
      const parsed = parseListModelsOutput('something went wrong');
      expect(parsed.availableModels).toEqual([]);
      expect(parsed.defaultModel).toBeUndefined();
    });

    it('parses Cursor 2026.06 bare ids, slash/bracket ids, and (current, default) flags while skipping headers', () => {
      const raw = [
        'Available models',
        'No models available for this account.',
        'Loading models...',
        'Error: partial fetch',
        'auto (current)',
        'composer-2.5-fast  (current, default)',
        'claude-4.5-sonnet[1m] - Sonnet 4.5 1M',
        'anthropic/claude-opus-4.6 - Claude Opus 4.6',
      ].join('\n');
      const parsed = parseListModelsOutput(raw);
      expect(parsed.availableModels).toEqual([
        'auto',
        'composer-2.5-fast',
        'claude-4.5-sonnet[1m]',
        'anthropic/claude-opus-4.6',
      ]);
      expect(parsed.defaultModel).toBe('composer-2.5-fast');
    });
  });

  describe('parseStatusOutput', () => {
    it('marks the user authenticated when CLI reports logged in with email', () => {
      const raw = '\x1B[2K\x1B[G\n ✓ Logged in as user@example.com\n';
      const parsed = parseStatusOutput(raw);
      expect(parsed.isAuthenticated).toBe(true);
      expect(parsed.loggedInAs).toBe('user@example.com');
    });

    it('detects generic "authenticated" phrasing without an email', () => {
      const parsed = parseStatusOutput('Status: authenticated\nVersion: 1.2.3');
      expect(parsed.isAuthenticated).toBe(true);
      expect(parsed.loggedInAs).toBeUndefined();
    });

    it('flags not-logged-in output as unauthenticated', () => {
      const parsed = parseStatusOutput('You are not logged in. Please sign in.');
      expect(parsed.isAuthenticated).toBe(false);
      expect(parsed.loggedInAs).toBeUndefined();
    });

    it('returns unauthenticated for empty output', () => {
      const parsed = parseStatusOutput('');
      expect(parsed.isAuthenticated).toBe(false);
    });
  });

  describe('getCursorRuntimeConfig', () => {
    it('returns a passive fallback without spawning cursor-agent when probing is disabled', async () => {
      const config = await getCursorRuntimeConfig({ probe: false });
      expect(config).toEqual({
        availableModels: [],
        isAuthenticated: false,
        isColdFallback: true,
      });
      expect(childProcessMock.execFile).not.toHaveBeenCalled();
    });

    it('combines probe outputs into a runtime config and closes child stdin', async () => {
      const endFn = vi.fn();
      childProcessMock.execFile.mockImplementation((...args: any[]) => {
        const cliArgs = args[1] as string[];
        const cb = args.at(-1);
        if (cliArgs.includes('--list-models')) {
          cb?.(null, 'auto - Auto\ncomposer-2.5-fast  (current, default)\n', '');
        } else if (cliArgs.includes('status')) {
          cb?.(null, ' ✓ Logged in as tester@example.com\n', '');
        } else {
          cb?.(new Error(`unexpected args: ${cliArgs.join(' ')}`), '', '');
        }
        return { stdin: { end: endFn } } as never;
      });

      const config = await getCursorRuntimeConfig(true);
      expect(config.availableModels).toEqual(['auto', 'composer-2.5-fast']);
      expect(config.defaultModel).toBe('composer-2.5-fast');
      expect(config.isAuthenticated).toBe(true);
      expect(config.loggedInAs).toBe('tester@example.com');
      expect(config.isColdFallback).toBeUndefined();
      expect(endFn).toHaveBeenCalledTimes(2);
    });

    it('returns a safe fallback when both probes fail', async () => {
      childProcessMock.execFile.mockImplementation((...args: any[]) => {
        const cb = args.at(-1);
        cb?.(new Error('ENOENT: cursor-agent not found'), '', '');
        return {} as never;
      });

      const config = await getCursorRuntimeConfig(true);
      expect(config.availableModels).toEqual([]);
      expect(config.isAuthenticated).toBe(false);
      expect(config.loggedInAs).toBeUndefined();
      expect(config.defaultModel).toBeUndefined();
      expect(config.isColdFallback).toBeUndefined();
    });

    it('returns empty runtime config without probing .new when staged promote fails or does not activate a version', async () => {
      const promoteStep = {
        executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        prependArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\cursor\\cursor-agent.ps1'],
      };
      transportPathsMock.hasPendingCursorStagedUpdate.mockReturnValue(true);
      transportPathsMock.resolveCursorLaunchPlan.mockReturnValue({
        direct: null,
        promoteStep,
        stagedVersionsDir: 'C:\\cursor\\versions',
      });

      const calls: Array<{ file: string; args: string[] }> = [];
      childProcessMock.execFile.mockImplementation((...args: any[]) => {
        const file = args[0] as string;
        const cliArgs = args[1] as string[];
        const cb = args.at(-1);
        calls.push({ file, args: cliArgs });
        cb?.(new Error('promote failed non-zero'), '', 'promote error');
        return { stdin: { end: vi.fn() } } as never;
      });

      const failedPromoteConfig = await getCursorRuntimeConfig(true);
      expect(failedPromoteConfig).toEqual({
        availableModels: [],
        isAuthenticated: false,
      });
      expect(calls).toEqual([{
        file: promoteStep.executable,
        args: [...promoteStep.prependArgs, '--version'],
      }]);

      // Even if promote exits 0 without creating an active non-.new directory, model/status probes do NOT run.
      calls.length = 0;
      childProcessMock.execFile.mockImplementation((...args: any[]) => {
        const file = args[0] as string;
        const cliArgs = args[1] as string[];
        const cb = args.at(-1);
        calls.push({ file, args: cliArgs });
        cb?.(null, '2026.12.01-f1e2d3c\n', '');
        return { stdin: { end: vi.fn() } } as never;
      });

      const unpromotedConfig = await getCursorRuntimeConfig(true);
      expect(unpromotedConfig).toEqual({
        availableModels: [],
        isAuthenticated: false,
      });
      expect(calls).toEqual([{
        file: promoteStep.executable,
        args: [...promoteStep.prependArgs, '--version'],
      }]);
    });

    it('falls back safely to healthy old active entrypoint when staged promote fails during probe', async () => {
      const oldDirect = { executable: 'C:\\cursor\\versions\\2026.05.05\\node.exe', prependArgs: ['C:\\cursor\\versions\\2026.05.05\\index.js'] };
      const promoteStep = {
        executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        prependArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\cursor\\cursor-agent.ps1'],
      };
      transportPathsMock.hasPendingCursorStagedUpdate.mockReturnValue(true);
      transportPathsMock.resolveCursorLaunchPlan.mockReturnValue({
        direct: oldDirect,
        promoteStep,
        stagedVersionsDir: 'C:\\cursor\\versions',
      });

      const calls: Array<{ file: string; args: string[] }> = [];
      childProcessMock.execFile.mockImplementation((...args: any[]) => {
        const file = args[0] as string;
        const cliArgs = args[1] as string[];
        const cb = args.at(-1);
        calls.push({ file, args: cliArgs });
        if (file === promoteStep.executable) {
          cb?.(new Error('promote timeout'), '', '');
        } else if (cliArgs.includes('--list-models')) {
          cb?.(null, 'auto - Auto\ncomposer-2.5  (current, default)\n', '');
        } else if (cliArgs.includes('status')) {
          cb?.(null, 'Logged in as fallback@example.com\n', '');
        }
        return { stdin: { end: vi.fn() } } as never;
      });

      const config = await getCursorRuntimeConfig(true);
      expect(config).toEqual({
        availableModels: ['auto', 'composer-2.5'],
        defaultModel: 'composer-2.5',
        loggedInAs: 'fallback@example.com',
        isAuthenticated: true,
      });
      expect(calls[0]?.file).toBe(promoteStep.executable);
      expect(calls[1]?.file).toBe(oldDirect.executable);
      expect(calls[2]?.file).toBe(oldDirect.executable);
    });
  });
});
