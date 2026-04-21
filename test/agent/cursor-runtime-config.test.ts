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

// Stabilize the transport-paths resolution so tests don't depend on PATH lookups.
vi.mock('../../src/agent/transport-paths.js', () => ({
  resolveExecutableForSpawn: (bin: string) => ({ executable: bin, prependArgs: [] }),
}));

import {
  getCursorRuntimeConfig,
  __cursorRuntimeConfigInternals,
} from '../../src/agent/cursor-runtime-config.js';

const { parseListModelsOutput, parseStatusOutput } = __cursorRuntimeConfigInternals;

describe('cursor-runtime-config parsers', () => {
  beforeEach(() => {
    __cursorRuntimeConfigInternals.clearCache();
    childProcessMock.execFile.mockReset();
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
    it('combines probe outputs into a runtime config', async () => {
      childProcessMock.execFile.mockImplementation((...args: any[]) => {
        const cliArgs = args[1] as string[];
        const cb = args.at(-1);
        if (cliArgs.includes('--list-models')) {
          cb?.(null, 'auto - Auto\ngpt-5.2 - GPT-5.2  (default)\n', '');
        } else if (cliArgs.includes('status')) {
          cb?.(null, ' ✓ Logged in as tester@example.com\n', '');
        } else {
          cb?.(new Error(`unexpected args: ${cliArgs.join(' ')}`), '', '');
        }
        return {} as never;
      });

      const config = await getCursorRuntimeConfig(true);
      expect(config.availableModels).toEqual(['auto', 'gpt-5.2']);
      expect(config.defaultModel).toBe('gpt-5.2');
      expect(config.isAuthenticated).toBe(true);
      expect(config.loggedInAs).toBe('tester@example.com');
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
    });
  });
});
