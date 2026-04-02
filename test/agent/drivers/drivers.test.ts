import { describe, it, expect, vi } from 'vitest';
import { ClaudeCodeDriver } from '../../../src/agent/drivers/claude-code.js';
import { CodexDriver } from '../../../src/agent/drivers/codex.js';
import { OpenCodeDriver } from '../../../src/agent/drivers/opencode.js';
import { ShellDriver } from '../../../src/agent/drivers/shell.js';

// ── Claude Code ───────────────────────────────────────────────────────────────

describe('ClaudeCodeDriver', () => {
  const driver = new ClaudeCodeDriver();

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
