import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ClaudeCodeDriver } from '../../../src/agent/drivers/claude-code.js';
import { CodexDriver } from '../../../src/agent/drivers/codex.js';
import { OpenCodeDriver } from '../../../src/agent/drivers/opencode.js';
import { resolveOpenCodeVersion } from '../../../src/agent/agent-version.js';
import {
  __resetOpenCodeElevationCacheForTests,
  isOpenCodeCallerElevated,
  isOpenCodeCallerElevatedAsync,
  OPENCODE_PRIVILEGE_PROBE_TIMEOUT_MS,
  resolveOpenCodeCliAsync,
  resolveOpenCodeCliSync,
} from '../../../src/agent/opencode-cli-path.js';
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

  it('shell-quotes requestedModel literally on launch and resume so spaces, quotes, and expansions are never interpreted', () => {
    const trickyModel = `m'2 "$HOME" \`id\` $(whoami) v1`;
    const launchCmd = driver.buildLaunchCommand('deck_proj_brain', {
      ccSessionId: 'cc-1',
      requestedModel: trickyModel,
      platform: 'linux',
    });
    const resumeCmd = driver.buildResumeCommand('deck_proj_brain', {
      ccSessionId: 'cc-1',
      requestedModel: trickyModel,
      platform: 'linux',
    });
    const expectedFlag = ` --model 'm'\\''2 "$HOME" \`id\` $(whoami) v1' `;
    expect(launchCmd).toContain(expectedFlag);
    expect(resumeCmd).toContain(expectedFlag);
  });

  it('passes literal tricky requestedModel argv through real sh -c and Windows ConPTY .cmd shim resolution without %VAR% expansion', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const { resolveWindowsExecutableForConpty } = await import('../../../src/agent/win-launch.js');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imcodes-driver-argv-'));
    try {
      const trickyModel = `m'2 "quoted" %TEMP% $HOME \`id\` & v1`;
      // 1) Real POSIX sh -c execution probe with executable binary capturing process.argv
      const binDir = path.join(tmpDir, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const probeJs = path.join(tmpDir, 'argv-probe.mjs');
      fs.writeFileSync(probeJs, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n', 'utf8');
      const claudeBin = path.join(binDir, 'claude');
      fs.writeFileSync(claudeBin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(probeJs)} "$@"\n`, 'utf8');
      fs.chmodSync(claudeBin, 0o755);

      const posixLaunch = driver.buildLaunchCommand('deck_proj_brain', {
        ccSessionId: 'cc-1',
        requestedModel: trickyModel,
        platform: 'linux',
      });
      const posixResume = driver.buildResumeCommand('deck_proj_brain', {
        ccSessionId: 'cc-1',
        requestedModel: trickyModel,
        platform: 'linux',
      });
      for (const cmd of [posixLaunch, posixResume]) {
        const stdout = execFileSync('sh', ['-c', cmd], {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`, TEMP: '/SHOULD_NOT_EXPAND' },
          encoding: 'utf8',
        });
        const argv = JSON.parse(stdout.trim()) as string[];
        const idx = argv.indexOf('--model');
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(argv[idx + 1]).toBe(trickyModel);
      }

      // 2) Windows npm .cmd shim resolution bypasses cmd.exe and preserves literal %TEMP%, quotes, spaces & ampersand
      const npmDir = path.join(tmpDir, 'npm');
      const pkgBinDir = path.join(npmDir, 'node_modules', '@anthropic-ai', 'claude-code');
      fs.mkdirSync(pkgBinDir, { recursive: true });
      const shimTarget = path.join(pkgBinDir, 'cli.js');
      fs.writeFileSync(shimTarget, 'console.log(JSON.stringify(process.argv.slice(2)));\n', 'utf8');
      fs.writeFileSync(
        path.join(npmDir, 'claude.cmd'),
        `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`,
        'utf8',
      );

      for (const spec of [
        driver.buildWinLaunchSpec('deck_proj_brain', { ccSessionId: 'cc-1', requestedModel: trickyModel }),
        driver.buildWinResumeSpec('deck_proj_brain', { ccSessionId: 'cc-1', requestedModel: trickyModel }),
      ]) {
        const resolved = resolveWindowsExecutableForConpty(
          spec.primary,
          { PATH: npmDir, PATHEXT: '.COM;.EXE;.BAT;.CMD', TEMP: '/SHOULD_NOT_EXPAND' },
          'win32',
        );
        expect(resolved.kind).toBe('direct');
        if (resolved.kind === 'direct') {
          const out = execFileSync(resolved.file, resolved.args, {
            env: { ...process.env, TEMP: '/SHOULD_NOT_EXPAND' },
            encoding: 'utf8',
          });
          const argv = JSON.parse(out.trim()) as string[];
          const idx = argv.indexOf('--model');
          expect(idx).toBeGreaterThanOrEqual(0);
          expect(argv[idx + 1]).toBe(trickyModel);
        }
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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

  it('never unwraps Windows .cmd shims to .js in PTY launch/resume commands', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'codex-drv-win-'));
    const origPlatform = process.platform;
    const origPath = process.env.PATH;
    const origPathext = process.env.PATHEXT;
    try {
      const npmBin = path.join(tmpDir, 'npm-bin');
      const pkgDir = path.join(npmBin, 'node_modules', '@openai', 'codex', 'bin');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(path.join(pkgDir, 'codex.js'), 'console.log("ok");\n');
      writeFileSync(
        path.join(npmBin, 'codex.cmd'),
        `@ECHO off\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`,
      );
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      process.env.PATH = npmBin;
      process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';

      const launchCmd = driver.buildLaunchCommand('deck_proj_w1', { fresh: true });
      const resumeCmd = driver.buildResumeCommand('deck_proj_w1', { codexSessionId: 'codex-1' });
      expect(launchCmd).toMatch(/^codex -m |^codex -c /);
      expect(launchCmd).not.toContain('codex.js');
      expect(resumeCmd).not.toContain('codex.js');
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
      if (origPath === undefined) delete process.env.PATH; else process.env.PATH = origPath;
      if (origPathext === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = origPathext;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('shell-quotes codexModel literally on launch and resume across POSIX and win32', () => {
    const trickyModel = `codex 'm' "$PATH" \`uname\` 1`;
    const launchCmd = driver.buildLaunchCommand('deck_proj_w1', {
      fresh: true,
      codexModel: trickyModel,
      platform: 'linux',
    });
    const resumeCmd = driver.buildResumeCommand('deck_proj_w1', {
      codexSessionId: 'codex-1',
      codexModel: trickyModel,
      platform: 'linux',
    });
    const expectedFlag = ` -m 'codex '\\''m'\\'' "$PATH" \`uname\` 1' `;
    expect(launchCmd).toContain(expectedFlag);
    expect(resumeCmd).toContain(expectedFlag);

    const winCmd = driver.buildLaunchCommand('deck_proj_w1', {
      fresh: true,
      codexModel: 'gpt "5" %TEMP%',
      platform: 'win32',
    });
    expect(winCmd).toContain(' -m "gpt \\"5\\" %%TEMP%%" ');
  });

  it('passes literal tricky codexModel argv through real sh -c and Windows ConPTY .cmd shim resolution', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const { resolveWindowsExecutableForConpty } = await import('../../../src/agent/win-launch.js');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imcodes-codex-argv-'));
    try {
      const trickyModel = `codex 'm' "q" %TEMP% $PATH & 1`;
      const binDir = path.join(tmpDir, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const probeJs = path.join(tmpDir, 'argv-probe.mjs');
      fs.writeFileSync(probeJs, 'console.log(JSON.stringify(process.argv.slice(2)));\n', 'utf8');
      const codexBin = path.join(binDir, 'codex');
      fs.writeFileSync(codexBin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(probeJs)} "$@"\n`, 'utf8');
      fs.chmodSync(codexBin, 0o755);

      const posixLaunch = driver.buildLaunchCommand('deck_proj_w1', {
        fresh: true,
        codexModel: trickyModel,
        platform: 'linux',
      });
      const posixResume = driver.buildResumeCommand('deck_proj_w1', {
        codexSessionId: 'codex-1',
        codexModel: trickyModel,
        platform: 'linux',
      });
      for (const cmd of [posixLaunch, posixResume]) {
        const stdout = execFileSync('sh', ['-c', cmd], {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`, TEMP: '/SHOULD_NOT_EXPAND' },
          encoding: 'utf8',
        });
        const argv = JSON.parse(stdout.trim()) as string[];
        const idx = argv.indexOf('-m');
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(argv[idx + 1]).toBe(trickyModel);
      }

      // Windows npm .cmd shim resolution for codex passes trickyModel untouched without cmd.exe
      const npmDir = path.join(tmpDir, 'npm');
      const pkgBinDir = path.join(npmDir, 'node_modules', '@openai', 'codex', 'bin');
      fs.mkdirSync(pkgBinDir, { recursive: true });
      fs.writeFileSync(path.join(pkgBinDir, 'codex.js'), 'console.log(JSON.stringify(process.argv.slice(2)));\n', 'utf8');
      fs.writeFileSync(
        path.join(npmDir, 'codex.cmd'),
        `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`,
        'utf8',
      );

      for (const spec of [
        driver.buildWinLaunchSpec('deck_proj_w1', { fresh: true, codexModel: trickyModel }),
        driver.buildWinResumeSpec('deck_proj_w1', { codexSessionId: 'codex-1', codexModel: trickyModel }),
      ]) {
        const resolved = resolveWindowsExecutableForConpty(
          spec.primary,
          { PATH: npmDir, PATHEXT: '.COM;.EXE;.BAT;.CMD', TEMP: '/SHOULD_NOT_EXPAND' },
          'win32',
        );
        expect(resolved.kind).toBe('direct');
        if (resolved.kind === 'direct') {
          const out = execFileSync(resolved.file, resolved.args, {
            env: { ...process.env, TEMP: '/SHOULD_NOT_EXPAND' },
            encoding: 'utf8',
          });
          const argv = JSON.parse(out.trim()) as string[];
          const idx = argv.indexOf('-m');
          expect(idx).toBeGreaterThanOrEqual(0);
          expect(argv[idx + 1]).toBe(trickyModel);
        }
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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
      if (process.platform === 'win32') {
        const homeBinDir = path.join(tempHome, '.opencode', 'bin');
        mkdirSync(homeBinDir, { recursive: true });
        const homeBin = path.join(homeBinDir, 'opencode.exe');
        writeFileSync(homeBin, '@rem mock opencode exe\r\n', 'utf8');

        const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
        const sparseEnv: NodeJS.ProcessEnv = {
          PATH: path.join(systemRoot, 'System32'),
          PATHEXT: '.EXE;.CMD;.BAT',
          SystemRoot: systemRoot,
        };
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

        expect(launchCmd).toBe(`"${homeBin}"`);
        expect(resumeIdCmd).toBe(`"${homeBin}" -s "oc-123"`);
        expect(resumeFallbackCmd).toBe(`"${homeBin}" -c || "${homeBin}"`);
        expect(resolveOpenCodeCliSync({ env: sparseEnv, homeDir: tempHome, platform: 'win32', isElevated: false }).source).toBe('home_bin');

        // Elevated caller refuses existing ~/.opencode/bin/opencode.exe fallback under sparse PATH
        const elevatedLaunchCmd = driver.buildLaunchCommand('deck_proj_w1', { env: sparseEnv, homeDir: tempHome, isElevated: true });
        expect(elevatedLaunchCmd).toBe('opencode');
        expect(resolveOpenCodeCliSync({ env: sparseEnv, homeDir: tempHome, platform: 'win32', isElevated: true }).source).toBe('missing');

        // PATH-installed opencode takes precedence over ~/.opencode/bin
        const pathBin = path.join(pathBinDir, 'opencode.cmd');
        writeFileSync(pathBin, '@echo off\r\necho PATH_OC:%*\r\n', 'utf8');
        const pathEnv: NodeJS.ProcessEnv = {
          ...sparseEnv,
          PATH: `${pathBinDir};${sparseEnv.PATH}`,
        };
        const launchOnPath = driver.buildLaunchCommand('deck_proj_w1', { env: pathEnv, homeDir: tempHome, isElevated: false });
        expect(launchOnPath).toBe('opencode');
        const comSpec = process.env.ComSpec || 'cmd.exe';
        const rPath = spawnSync(comSpec, ['/d', '/s', '/c', launchOnPath], { env: pathEnv, encoding: 'utf8' });
        expect(rPath.status).toBe(0);
        expect(rPath.stdout.trim()).toBe('PATH_OC:');
      } else {
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
      }

      // Elevated caller (Windows admin/SYSTEM or POSIX root with non-/root home) refuses user-writable home fallback
      expect(resolveOpenCodeCliSync({ env: { PATH: '/usr/bin' }, homeDir: tempHome, platform: 'linux', isElevated: true }).source).toBe('missing');
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

  it('fails closed on unconfirmed Windows privilege probes, uses trusted System32 PowerShell with timeout, and skips probe when PATH resolves', async () => {
    __resetOpenCodeElevationCacheForTests();
    const env = { SystemRoot: 'C:\\WinCustom', PATH: 'C:\\Windows\\System32' };
    const expectedPs = 'C:\\WinCustom\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const expectedHomeBin = 'C:\\Users\\Alice Smith\\.opencode\\bin\\opencode.exe';

    for (const badOutput of ['', '   \r\n', 'maybe', 'error: access denied']) {
      const seenFiles: string[] = [];
      const seenTimeouts: number[] = [];
      expect(isOpenCodeCallerElevated('win32', {
        env,
        runPrivilegeProbeSync: (file, _args, timeoutMs) => {
          seenFiles.push(file);
          seenTimeouts.push(timeoutMs);
          return badOutput;
        },
      })).toBe(true);
      expect(seenFiles).toEqual([expectedPs]);
      expect(seenTimeouts).toEqual([OPENCODE_PRIVILEGE_PROBE_TIMEOUT_MS]);

      await expect(isOpenCodeCallerElevatedAsync('win32', {
        env,
        runPrivilegeProbeAsync: async (file, _args, timeoutMs) => {
          expect(file).toBe(expectedPs);
          expect(timeoutMs).toBe(OPENCODE_PRIVILEGE_PROBE_TIMEOUT_MS);
          return badOutput;
        },
      })).resolves.toBe(true);
    }

    expect(isOpenCodeCallerElevated('win32', {
      env,
      runPrivilegeProbeSync: () => {
        throw new Error('ETIMEDOUT');
      },
    })).toBe(true);

    await expect(isOpenCodeCallerElevatedAsync('win32', {
      env,
      runPrivilegeProbeAsync: async () => {
        throw new Error('ETIMEDOUT');
      },
    })).resolves.toBe(true);

    expect(isOpenCodeCallerElevated('win32', { env, runPrivilegeProbeSync: () => '  False \r\n' })).toBe(false);
    expect(isOpenCodeCallerElevated('win32', { env, runPrivilegeProbeSync: () => 'True\r\n' })).toBe(true);
    await expect(isOpenCodeCallerElevatedAsync('win32', { env, runPrivilegeProbeAsync: async () => 'False\r\n' })).resolves.toBe(false);

    // Ambiguous probe denies home_bin; explicit 'False' grants home_bin
    expect(resolveOpenCodeCliSync({
      platform: 'win32',
      env,
      homeDir: 'C:\\Users\\Alice Smith',
      isExecutableFileSync: (p) => p === expectedHomeBin,
      runPrivilegeProbeSync: () => '',
    }).source).toBe('missing');

    await expect(resolveOpenCodeCliAsync({
      platform: 'win32',
      env,
      homeDir: 'C:\\Users\\Alice Smith',
      isExecutableFile: async (p) => p === expectedHomeBin,
      runPrivilegeProbeAsync: async () => '',
    })).resolves.toEqual({ executable: 'opencode', source: 'missing' });

    await expect(resolveOpenCodeCliAsync({
      platform: 'win32',
      env,
      homeDir: 'C:\\Users\\Alice Smith',
      isExecutableFile: async (p) => p === expectedHomeBin,
      runPrivilegeProbeAsync: async () => 'False\r\n',
    })).resolves.toEqual({
      executable: expectedHomeBin,
      resolvedPath: expectedHomeBin,
      source: 'home_bin',
    });

    // PATH hit bypasses privilege probe completely
    const syncProbeSpy = vi.fn(() => 'True');
    const asyncProbeSpy = vi.fn(async () => 'True');
    const npmEnv = { ...env, PATH: 'C:\\Users\\Alice Smith\\AppData\\Roaming\\npm', PATHEXT: '.EXE;.CMD' };
    expect(resolveOpenCodeCliSync({
      platform: 'win32',
      env: npmEnv,
      homeDir: 'C:\\Users\\Alice Smith',
      isExecutableFileSync: (p) => p === 'C:\\Users\\Alice Smith\\AppData\\Roaming\\npm\\opencode.cmd',
      runPrivilegeProbeSync: syncProbeSpy,
    })).toEqual({
      executable: 'opencode',
      resolvedPath: 'C:\\Users\\Alice Smith\\AppData\\Roaming\\npm\\opencode.cmd',
      source: 'path',
    });
    expect(syncProbeSpy).not.toHaveBeenCalled();

    await expect(resolveOpenCodeCliAsync({
      platform: 'win32',
      env: npmEnv,
      homeDir: 'C:\\Users\\Alice Smith',
      isExecutableFile: async (p) => p === 'C:\\Users\\Alice Smith\\AppData\\Roaming\\npm\\opencode.cmd',
      runPrivilegeProbeAsync: asyncProbeSpy,
    })).resolves.toEqual({
      executable: 'opencode',
      resolvedPath: 'C:\\Users\\Alice Smith\\AppData\\Roaming\\npm\\opencode.cmd',
      source: 'path',
    });
    expect(asyncProbeSpy).not.toHaveBeenCalled();
  });

  it('resolves opencode version across Windows PATH .cmd shims and home_bin native executables', async () => {
    const shellCalls: string[] = [];
    const fileCalls: Array<{ file: string; args: readonly string[]; verbatim?: boolean }> = [];

    // 1. Windows PATH .cmd shim (e.g. npm install -g opencode-ai) uses shell lookup, never direct execFile
    const pathVersion = await resolveOpenCodeVersion({
      platform: 'win32',
      resolveCli: async () => ({
        executable: 'opencode',
        resolvedPath: 'C:\\Users\\Alice\\AppData\\Roaming\\npm\\opencode.cmd',
        source: 'path',
      }),
      execShell: async (cmd) => {
        shellCalls.push(cmd);
        return { stdout: '1.2.3\r\n', stderr: '' };
      },
      execFileFn: async () => {
        throw new Error('EINVAL: direct execFile cannot launch .cmd without shell');
      },
    });
    expect(pathVersion).toBe('1.2.3');
    expect(shellCalls).toEqual(['opencode --version']);

    // 2. Native Windows home_bin executable with spaces executes directly without shell
    const homeExe = 'C:\\Users\\Alice Smith\\.opencode\\bin\\opencode.exe';
    const homeExeVersion = await resolveOpenCodeVersion({
      platform: 'win32',
      resolveCli: async () => ({ executable: homeExe, resolvedPath: homeExe, source: 'home_bin' }),
      execShell: async () => {
        throw new Error('should not use shell for home_bin native executable');
      },
      execFileFn: async (file, args, opts) => {
        fileCalls.push({ file, args, verbatim: opts.windowsVerbatimArguments });
        return { stdout: '1.2.4\n', stderr: '' };
      },
    });
    expect(homeExeVersion).toBe('1.2.4');
    expect(fileCalls).toEqual([{ file: homeExe, args: ['--version'], verbatim: undefined }]);

    // 3. Windows home_bin .cmd shim invokes explicit cmd.exe /d /s /c with verbatim quoting
    const homeCmd = 'C:\\Users\\Alice Smith\\.opencode\\bin\\opencode.cmd';
    const homeCmdVersion = await resolveOpenCodeVersion({
      platform: 'win32',
      env: { ComSpec: 'C:\\WinCustom\\System32\\cmd.exe' },
      resolveCli: async () => ({ executable: homeCmd, resolvedPath: homeCmd, source: 'home_bin' }),
      execFileFn: async (file, args, opts) => ({
        stdout: file === 'C:\\WinCustom\\System32\\cmd.exe'
          && args.join(' ') === `/d /s /c ""${homeCmd}" --version"`
          && opts.windowsVerbatimArguments === true
          ? '1.2.5\n'
          : '',
        stderr: '',
      }),
    });
    expect(homeCmdVersion).toBe('1.2.5');
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
