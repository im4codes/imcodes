import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ClaudeCodeDriver } from '../../../src/agent/drivers/claude-code.js';
import { CodexDriver } from '../../../src/agent/drivers/codex.js';
import { OpenCodeDriver } from '../../../src/agent/drivers/opencode.js';
import { resolveOpenCodeCliAsync, resolveOpenCodeCliSync } from '../../../src/agent/opencode-cli-path.js';
import { ShellDriver } from '../../../src/agent/drivers/shell.js';
import { CRON_CONTROL_TRUSTED_SYSTEM_CLAUSE } from '../../../shared/cron-types.js';

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

  it('puts permanent cron authorization in the process system prompt on launch and resume', () => {
    expect(driver.buildLaunchCommand('deck_proj_brain', { fresh: true }))
      .toContain(`--append-system-prompt ${JSON.stringify(CRON_CONTROL_TRUSTED_SYSTEM_CLAUSE)}`);
    expect(driver.buildResumeCommand('deck_proj_brain', { ccSessionId: 'cc-1' }))
      .toContain(`--append-system-prompt ${JSON.stringify(CRON_CONTROL_TRUSTED_SYSTEM_CLAUSE)}`);
  });

  it('buildResumeCommand includes -c flag', () => {
    const cmd = driver.buildResumeCommand('deck_proj_brain');
    expect(cmd).toContain('-c');
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
    await vi.runAllTimersAsync();
    await done;

    expect(sendKey).toHaveBeenCalledTimes(1);
    expect(sendKey).toHaveBeenCalledWith('Enter');
  });

  it('postLaunch selects Yes in the arrow trust-folder menu', async () => {
    vi.useFakeTimers();
    const capturePane = vi.fn()
      .mockResolvedValueOnce([
        'Security guide',
        'No, exit',
        'Yes, I trust this folder',
        'Enter to confirm',
      ])
      .mockResolvedValueOnce(['❯']);
    const sendKey = vi.fn().mockResolvedValue(undefined);

    const done = driver.postLaunch!(capturePane, sendKey);
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.runAllTimersAsync();
    await done;

    expect(sendKey).toHaveBeenCalledTimes(2);
    expect(sendKey.mock.calls.map(([key]) => key)).toEqual(['Down', 'Enter']);
  });

  it('postLaunch keeps the numbered trust-folder compatibility path', async () => {
    vi.useFakeTimers();
    const capturePane = vi.fn()
      .mockResolvedValueOnce([
        'Do you trust the files in this folder?',
        '1. Yes, I trust this folder',
        '2. No, exit',
      ])
      .mockResolvedValueOnce(['❯']);
    const sendKey = vi.fn().mockResolvedValue(undefined);

    const done = driver.postLaunch!(capturePane, sendKey);
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.runAllTimersAsync();
    await done;

    expect(sendKey.mock.calls.map(([key]) => key)).toEqual(['1', 'Enter']);
  });

  it('postLaunch keeps the explicit legacy default-confirmation path', async () => {
    vi.useFakeTimers();
    const capturePane = vi.fn()
      .mockResolvedValueOnce([
        'Do you trust the files in this folder?',
        '[Y/n]',
      ])
      .mockResolvedValueOnce(['❯']);
    const sendKey = vi.fn().mockResolvedValue(undefined);

    const done = driver.postLaunch!(capturePane, sendKey);
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.runAllTimersAsync();
    await done;

    expect(sendKey.mock.calls.map(([key]) => key)).toEqual(['Enter']);
  });

  it('postLaunch does not authorize unrelated security text or an incomplete menu', async () => {
    vi.useFakeTimers();
    const capturePane = vi.fn()
      .mockResolvedValueOnce(['Security guide', 'Do you trust the files in this folder?', 'No, exit'])
      .mockResolvedValueOnce(['❯']);
    const sendKey = vi.fn().mockResolvedValue(undefined);

    const done = driver.postLaunch!(capturePane, sendKey);
    await vi.advanceTimersByTimeAsync(1_500);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_500);
    await done;

    expect(sendKey).not.toHaveBeenCalled();
  });

  it('postLaunch matches arrow trust text across lines and whitespace', async () => {
    vi.useFakeTimers();
    const capturePane = vi.fn()
      .mockResolvedValueOnce([
        'NO,   EXIT',
        'Yes, I trust',
        'this',
        'folder',
      ])
      .mockResolvedValueOnce(['❯']);
    const sendKey = vi.fn().mockResolvedValue(undefined);

    const done = driver.postLaunch!(capturePane, sendKey);
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.runAllTimersAsync();
    await done;

    expect(sendKey.mock.calls.map(([key]) => key)).toEqual(['Down', 'Enter']);
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

  it('puts permanent cron authorization in process developer instructions on launch and resume', () => {
    const expected = JSON.stringify(`developer_instructions=${JSON.stringify(CRON_CONTROL_TRUSTED_SYSTEM_CLAUSE)}`);
    expect(driver.buildLaunchCommand('deck_proj_w1', { fresh: true })).toContain(`-c ${expected}`);
    expect(driver.buildResumeCommand('deck_proj_w1', { codexSessionId: 'codex-1' })).toContain(`-c ${expected}`);
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

  it('executes launch/resume from spaced ~/.opencode/bin under sparse PATH, prefers PATH when present, and refuses elevated home fallback', async () => {
    const tempHome = mkdtempSync(path.join(tmpdir(), 'imcodes oc home '));
    const pathBinDir = mkdtempSync(path.join(tmpdir(), 'imcodes-oc-path-'));
    try {
      const homeBinDir = path.join(tempHome, '.opencode', 'bin');
      mkdirSync(homeBinDir, { recursive: true });
      const homeBin = path.join(homeBinDir, 'opencode');
      writeFileSync(homeBin, '#!/bin/sh\necho "HOME_OC:$*"\n', 'utf8');
      chmodSync(homeBin, 0o755);

      const sparseEnv = { PATH: '/usr/bin' };
      const launchCmd = driver.buildLaunchCommand('deck_proj_w1', { env: sparseEnv, homeDir: tempHome, isElevated: false });
      const resumeIdCmd = driver.buildResumeCommand('deck_proj_w1', {
        opencodeSessionId: 'oc-123',
        env: sparseEnv,
        homeDir: tempHome,
        isElevated: false,
      });
      const resumeFallbackCmd = driver.buildResumeCommand('deck_proj_w1', {
        env: sparseEnv,
        homeDir: tempHome,
        isElevated: false,
      });

      const r1 = spawnSync('/bin/sh', ['-c', launchCmd], { env: sparseEnv, encoding: 'utf8' });
      const r2 = spawnSync('/bin/sh', ['-c', resumeIdCmd], { env: sparseEnv, encoding: 'utf8' });
      const r3 = spawnSync('/bin/sh', ['-c', resumeFallbackCmd], { env: sparseEnv, encoding: 'utf8' });
      expect(r1.status).toBe(0);
      expect(r1.stdout.trim()).toBe('HOME_OC:');
      expect(r2.status).toBe(0);
      expect(r2.stdout.trim()).toBe('HOME_OC:-s oc-123');
      expect(r3.status).toBe(0);
      expect(r3.stdout.trim()).toBe('HOME_OC:-c');

      // PATH-installed opencode takes precedence over ~/.opencode/bin
      const pathBin = path.join(pathBinDir, 'opencode');
      writeFileSync(pathBin, '#!/bin/sh\necho "PATH_OC:$*"\n', 'utf8');
      chmodSync(pathBin, 0o755);
      const pathEnv = { PATH: `${pathBinDir}:/usr/bin` };
      const launchOnPath = driver.buildLaunchCommand('deck_proj_w1', { env: pathEnv, homeDir: tempHome, isElevated: false });
      expect(launchOnPath).toBe('opencode');
      const rPath = spawnSync('/bin/sh', ['-c', launchOnPath], { env: pathEnv, encoding: 'utf8' });
      expect(rPath.status).toBe(0);
      expect(rPath.stdout.trim()).toBe('PATH_OC:');

      // Elevated caller (Windows admin/SYSTEM or POSIX root with non-/root home) refuses user-writable home fallback
      expect(resolveOpenCodeCliSync({ env: sparseEnv, homeDir: tempHome, platform: 'linux', isElevated: true }).source).toBe('missing');
      const winResolved = await resolveOpenCodeCliAsync({
        platform: 'win32',
        env: { PATH: 'C:\\Windows\\System32' },
        homeDir: 'C:\\Users\\Alice Smith',
        isElevated: true,
        isExecutableFile: async (p) => p === 'C:\\Users\\Alice Smith\\.opencode\\bin\\opencode.exe',
      });
      expect(winResolved.source).toBe('missing');

      const winNonElev = await resolveOpenCodeCliAsync({
        platform: 'win32',
        env: { PATH: 'C:\\Windows\\System32' },
        homeDir: 'C:\\Users\\Alice Smith',
        isElevated: false,
        isExecutableFile: async (p) => p === 'C:\\Users\\Alice Smith\\.opencode\\bin\\opencode.exe',
      });
      expect(winNonElev).toEqual({
        executable: 'C:\\Users\\Alice Smith\\.opencode\\bin\\opencode.exe',
        resolvedPath: 'C:\\Users\\Alice Smith\\.opencode\\bin\\opencode.exe',
        source: 'home_bin',
      });
      void execFileSync;
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
      rmSync(pathBinDir, { recursive: true, force: true });
    }
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
