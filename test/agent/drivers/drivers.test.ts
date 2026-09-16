import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';
import { ClaudeCodeDriver } from '../../../src/agent/drivers/claude-code.js';
import { CodexDriver } from '../../../src/agent/drivers/codex.js';
import { OpenCodeDriver } from '../../../src/agent/drivers/opencode.js';
import { ShellDriver } from '../../../src/agent/drivers/shell.js';

// ── Claude Code ───────────────────────────────────────────────────────────────

describe('ClaudeCodeDriver', () => {
  const driver = new ClaudeCodeDriver();

  afterEach(() => {
    vi.useRealTimers();
  });

  it('type is claude-code', () => {
    expect(driver.type).toBe('claude-code');
  });

  it('buildLaunchCommand includes --dangerously-skip-permissions', () => {
    const cmd = driver.buildLaunchCommand('deck_proj_brain');
    expect(cmd).toContain('claude');
    expect(cmd).toContain('--dangerously-skip-permissions');
  });

  it('buildLaunchCommand with cwd changes directory first', () => {
    const cmd = driver.buildLaunchCommand('deck_proj_brain', { cwd: '/home/user/proj' });
    expect(cmd).toContain('cd');
    expect(cmd).toContain('/home/user/proj');
  });

  it('buildResumeCommand includes -c flag', () => {
    const cmd = driver.buildResumeCommand('deck_proj_brain');
    expect(cmd).toContain('-c');
  });

  // Sparse-PATH hardening: the daemon's own environment (which tmux inherits
  // when it spawns the session's shell) may be too sparse to resolve a bare
  // `claude`, exactly like the "spawn claude ENOENT" bug already fixed for
  // the SDK-transport path. buildLaunchCommand/buildResumeCommand now embed
  // an absolute path when resolution finds one.
  describe('sparse-PATH binary resolution', () => {
    let origHome: string | undefined;
    let origPath: string | undefined;
    let origClaudeEnv: string | undefined;
    let origPlatform: string;
    let tmpDir: string;

    beforeEach(() => {
      origHome = process.env.HOME;
      origPath = process.env.PATH;
      origClaudeEnv = process.env.IMCODES_CLAUDE_BINARY_PATH;
      origPlatform = process.platform;
      delete process.env.IMCODES_CLAUDE_BINARY_PATH;
      // No fixed candidate covers this HOME, so resolution must fall through
      // to the PATH walk to find anything at all.
      process.env.HOME = '/tmp/imcodes-fake-home-drivers-test-xyz';
      tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'claude-driver-path-test-'));
    });
    afterEach(() => {
      if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
      if (origPath === undefined) delete process.env.PATH; else process.env.PATH = origPath;
      if (origClaudeEnv === undefined) delete process.env.IMCODES_CLAUDE_BINARY_PATH; else process.env.IMCODES_CLAUDE_BINARY_PATH = origClaudeEnv;
      Object.defineProperty(process, 'platform', { value: origPlatform });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('buildLaunchCommand embeds the absolute path when PATH-walk finds claude, not the bare name', () => {
      if (process.platform === 'win32') return;
      const claudePath = path.join(tmpDir, 'claude');
      fs.writeFileSync(claudePath, '#!/bin/sh\necho fake claude\n');
      process.env.PATH = tmpDir;

      const cmd = driver.buildLaunchCommand('deck_proj_brain');
      expect(cmd).toContain(claudePath);
      // Every occurrence of the binary in the retry-fallback command is the
      // resolved path, not a lingering bare 'claude' from only some of them
      // having been substituted.
      expect(cmd.split(claudePath).length - 1).toBe(2);
    });

    it('buildLaunchCommand(fresh) and buildResumeCommand(ccSessionId) also embed the resolved path', () => {
      if (process.platform === 'win32') return;
      const claudePath = path.join(tmpDir, 'claude');
      fs.writeFileSync(claudePath, '#!/bin/sh\necho fake claude\n');
      process.env.PATH = tmpDir;

      expect(driver.buildLaunchCommand('deck_proj_brain', { fresh: true })).toContain(claudePath);
      expect(driver.buildLaunchCommand('deck_proj_brain', { ccSessionId: 'abc' })).toContain(claudePath);
      expect(driver.buildResumeCommand('deck_proj_brain', { ccSessionId: 'abc' })).toContain(claudePath);
    });

    it('falls back to the bare name (unchanged pre-hardening behavior) when nothing resolves', () => {
      if (process.platform === 'win32') return;
      process.env.PATH = '/does/not/exist';
      const cmd = driver.buildLaunchCommand('deck_proj_brain');
      expect(cmd).toContain('claude --dangerously-skip-permissions');
    });

    it('does not touch the command string on win32 — ConPTY embedding is out of scope', () => {
      const claudePath = path.join(tmpDir, 'claude');
      fs.writeFileSync(claudePath, '#!/bin/sh\necho fake claude\n');
      process.env.PATH = tmpDir;
      Object.defineProperty(process, 'platform', { value: 'win32' });

      const cmd = driver.buildLaunchCommand('deck_proj_brain');
      expect(cmd).not.toContain(claudePath);
      expect(cmd).toContain('claude --dangerously-skip-permissions');
    });
  });

  it('isOverlay detects permission dialog', () => {
    const lines = ['', '  Allow | Deny', '  Do you want to proceed?'];
    expect(driver.isOverlay(lines)).toBe(true);
  });

  it('isOverlay returns false for normal output', () => {
    const lines = ['  Some output', '  From the agent', '❯'];
    expect(driver.isOverlay(lines)).toBe(false);
  });

  it('captureLastResponse uses /copy and deleteBuffer', async () => {
    const capturePane = vi.fn().mockResolvedValue(['line1', 'line2']);
    const sendKeys = vi.fn().mockResolvedValue(undefined);
    const showBuffer = vi.fn().mockResolvedValue('Buffer content');
    const deleteBuffer = vi.fn().mockResolvedValue(undefined);

    const result = await driver.captureLastResponse(capturePane, sendKeys, showBuffer, deleteBuffer);

    expect(sendKeys).toHaveBeenCalledWith('/copy');
    expect(showBuffer).toHaveBeenCalled();
    expect(deleteBuffer).toHaveBeenCalled(); // task 12.15
    expect(result).toBe('Buffer content');
  });

  it('captureLastResponse falls back to capture-pane if buffer empty', async () => {
    const capturePane = vi.fn().mockResolvedValue(['fallback line']);
    const sendKeys = vi.fn().mockResolvedValue(undefined);
    const showBuffer = vi.fn().mockResolvedValue('');

    const result = await driver.captureLastResponse(capturePane, sendKeys, showBuffer);
    expect(result).toContain('fallback line');
  });

  it('postLaunch confirms the summary resume chooser with Enter', async () => {
    vi.useFakeTimers();
    const capturePane = vi.fn()
      .mockResolvedValueOnce([
        '1. Resume from summary (recommended)',
        '2. Resume full session as-is',
        "3. Don't ask me again",
        'Enter to confirm · Esc to cancel',
      ])
      .mockResolvedValueOnce(['❯']);
    const sendKey = vi.fn().mockResolvedValue(undefined);

    const done = driver.postLaunch!(capturePane, sendKey);
    await vi.advanceTimersByTimeAsync(1_500);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(700);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_500);
    await done;

    expect(sendKey).toHaveBeenCalledTimes(1);
    expect(sendKey).toHaveBeenCalledWith('Enter');
  });
});

// ── Codex ─────────────────────────────────────────────────────────────────────

describe('CodexDriver', () => {
  const driver = new CodexDriver();

  it('type is codex', () => {
    expect(driver.type).toBe('codex');
  });

  it('buildLaunchCommand includes codex', () => {
    const cmd = driver.buildLaunchCommand('deck_proj_w1');
    expect(cmd).toContain('codex');
  });

  it('buildResumeCommand returns resume command', () => {
    const cmd = driver.buildResumeCommand('deck_proj_w1');
    expect(cmd).toBeTruthy();
  });

  it('captureLastResponse uses capture-pane (no /copy)', async () => {
    const capturePane = vi.fn().mockResolvedValue(['response line']);
    const sendKeys = vi.fn().mockResolvedValue(undefined);
    const showBuffer = vi.fn().mockResolvedValue('');

    const result = await driver.captureLastResponse(capturePane, sendKeys, showBuffer);
    expect(capturePane).toHaveBeenCalled();
    expect(result).toContain('response line');
  });
});

// ── OpenCode ──────────────────────────────────────────────────────────────────

describe('OpenCodeDriver', () => {
  const driver = new OpenCodeDriver();

  it('type is opencode', () => {
    expect(driver.type).toBe('opencode');
  });

  it('buildLaunchCommand includes opencode', () => {
    const cmd = driver.buildLaunchCommand('deck_proj_w1');
    expect(cmd).toContain('opencode');
    expect(cmd).not.toContain(' -c ');
  });

  it('buildResumeCommand returns a resume command', () => {
    const cmd = driver.buildResumeCommand('deck_proj_w1');
    expect(cmd).toBeTruthy();
    expect(cmd).toContain('opencode -c || opencode');
  });

  it('prefers explicit opencodeSessionId when provided', () => {
    const cmd = driver.buildResumeCommand('deck_proj_w1', { opencodeSessionId: 'oc-session-123', cwd: '/tmp/proj' });
    expect(cmd).toContain('opencode -s');
    expect(cmd).toContain('oc-session-123');
  });
});

// ── Shell ─────────────────────────────────────────────────────────────────────

describe('ShellDriver', () => {
  const driver = new ShellDriver();

  it('type is shell', () => {
    expect(driver.type).toBe('shell');
  });

  it('buildLaunchCommand uses provided shellBin', () => {
    const cmd = driver.buildLaunchCommand('deck_sub_abc', { shellBin: '/opt/homebrew/bin/fish' } as never);
    expect(cmd).toContain('/opt/homebrew/bin/fish');
  });

  it('buildLaunchCommand falls back to SHELL env', () => {
    const original = process.env.SHELL;
    process.env.SHELL = '/bin/zsh';
    const cmd = driver.buildLaunchCommand('deck_sub_abc');
    expect(cmd).toContain('/bin/zsh');
    process.env.SHELL = original;
  });

  it('buildLaunchCommand prepends cd when cwd provided', () => {
    const cmd = driver.buildLaunchCommand('deck_sub_abc', { cwd: '/home/user/proj', shellBin: '/bin/bash' } as never);
    expect(cmd).toContain('cd');
    expect(cmd).toContain('/home/user/proj');
    expect(cmd).toContain('/bin/bash');
  });

  it('quotes Windows shellBin paths with spaces', () => {
    const origPlatform = process.platform;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const cmd = driver.buildLaunchCommand('deck_sub_abc', { shellBin: 'C:\\Program Files\\Git\\bin\\bash.exe' } as never);
      expect(cmd).toContain('"C:\\Program Files\\Git\\bin\\bash.exe"');
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });

  it('buildResumeCommand returns same as buildLaunchCommand', () => {
    expect(driver.buildResumeCommand('x')).toBe(driver.buildLaunchCommand('x'));
  });

  it('isOverlay always returns false', () => {
    expect(driver.isOverlay(['anything'])).toBe(false);
  });

  it('detectStatus returns idle on $ prompt', () => {
    expect(driver.detectStatus(['user@host:~$ '])).toBe('idle');
  });

  it('detectStatus returns idle on % prompt', () => {
    expect(driver.detectStatus(['~/proj %'])).toBe('idle');
  });

  it('captureLastResponse joins pane lines', async () => {
    const capturePane = vi.fn().mockResolvedValue(['line1', 'line2', '$ ']);
    const result = await driver.captureLastResponse(capturePane);
    expect(result).toContain('line1');
    expect(result).toContain('line2');
  });
});
