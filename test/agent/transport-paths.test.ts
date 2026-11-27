import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';

import {
  normalizeTransportCwd,
  resolveBinaryOnWindows,
  parseNpmCmdShim,
  resolveExecutableForSpawn,
  resolveClaudeCodePathForSdk,
  resolveAgyPathForSdk,
  resolveGrokPathForSdk,
  resolveCursorPathForSdk,
  resolveCursorExecutableForSpawn,
  resolveCursorCmdLauncher,
} from '../../src/agent/transport-paths.js';

describe('normalizeTransportCwd', () => {
  it('returns an absolute cwd on non-Windows hosts', () => {
    const result = normalizeTransportCwd('test/fixtures');
    expect(result).toBeDefined();
    expect(result).not.toBe('test/fixtures');
  });

  it('normalizes backslashes to forward slashes on Windows', () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });

    try {
      expect(normalizeTransportCwd('C:\\Users\\admin\\project')).toBe('C:/Users/admin/project');
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });
});

describe('resolveClaudeCodePathForSdk (macOS/Linux bundled-binary resolution)', () => {
  it('resolves the SDK-bundled claude binary to an absolute path (not bare "claude") so a sparse-PATH daemon works', () => {
    if (process.platform === 'win32') return; // Windows path is covered by its own tests
    const platformBinary = path.join(
      'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, 'claude',
    );
    const resolved = resolveClaudeCodePathForSdk('claude');
    if (fs.existsSync(platformBinary)) {
      // The bundled binary is installed (it is in this repo) → MUST resolve to an
      // absolute existing path, never bare 'claude' (which a systemd/launchd
      // daemon's sparse PATH cannot find). Regression guard for the old
      // non-Windows pass-through.
      expect(path.isAbsolute(resolved)).toBe(true);
      expect(fs.existsSync(resolved)).toBe(true);
      expect(path.basename(resolved)).toBe('claude');
    } else {
      // Platform binary genuinely not installed here → PATH fallback is acceptable.
      expect(resolved).toBe('claude');
    }
  });

  it('honours an explicit caller-provided binary path/name unchanged', () => {
    if (process.platform === 'win32') return;
    expect(resolveClaudeCodePathForSdk('/custom/bin/claude')).toBe('/custom/bin/claude');
    expect(resolveClaudeCodePathForSdk('claude-canary')).toBe('claude-canary');
  });
});

describe('resolveAgyPathForSdk (per-user and system candidate resolution)', () => {
  it('honours an explicit caller-provided binary path unchanged', () => {
    if (process.platform === 'win32') return;
    expect(resolveAgyPathForSdk('/custom/bin/agy')).toBe('/custom/bin/agy');
  });

  it('resolves agy from candidates or falls back gracefully', () => {
    if (process.platform === 'win32') return;
    const resolved = resolveAgyPathForSdk('agy');
    expect(typeof resolved).toBe('string');
    expect(resolved.length).toBeGreaterThan(0);
  });
});

describe('resolveGrokPathForSdk (per-user and system candidate resolution)', () => {
  it('honours an explicit caller-provided binary path unchanged', () => {
    if (process.platform === 'win32') return;
    expect(resolveGrokPathForSdk('/custom/bin/grok')).toBe('/custom/bin/grok');
  });

  it('resolves grok from candidates or falls back gracefully', () => {
    if (process.platform === 'win32') return;
    const resolved = resolveGrokPathForSdk('grok');
    expect(typeof resolved).toBe('string');
    expect(resolved.length).toBeGreaterThan(0);
  });

  it('resolves grok from GROK_HOME candidate when configured', () => {
    if (process.platform === 'win32') return;
    const origHome = process.env.GROK_HOME;
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'grok-home-'));
    try {
      const binDir = path.join(tmpDir, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const fakeGrok = path.join(binDir, 'grok');
      fs.writeFileSync(fakeGrok, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(fakeGrok, 0o755);

      process.env.GROK_HOME = tmpDir;
      expect(resolveGrokPathForSdk('grok')).toBe(fakeGrok);
    } finally {
      if (origHome === undefined) {
        delete process.env.GROK_HOME;
      } else {
        process.env.GROK_HOME = origHome;
      }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });
});

describe('resolveCursorPathForSdk (cursor-agent and agent resolution)', () => {
  it('honours an explicit caller-provided binary path unchanged', () => {
    if (process.platform === 'win32') return;
    expect(resolveCursorPathForSdk('/custom/bin/agent')).toBe('/custom/bin/agent');
  });

  it('prefers PATH cursor-agent and falls back to ~/.local/bin/agent on sparse daemon PATH', () => {
    if (process.platform === 'win32') return;
    const origHome = process.env.HOME;
    const origPath = process.env.PATH;
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cursor-home-'));
    try {
      const localBin = path.join(tmpDir, '.local', 'bin');
      const customPathBin = path.join(tmpDir, 'path-bin');
      fs.mkdirSync(localBin, { recursive: true });
      fs.mkdirSync(customPathBin, { recursive: true });

      const fakeAgent = path.join(localBin, 'agent');
      fs.writeFileSync(fakeAgent, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(fakeAgent, 0o755);

      process.env.HOME = tmpDir;
      process.env.PATH = '/nonexistent';
      expect(resolveCursorPathForSdk('cursor-agent')).toBe(fakeAgent);

      const fakePathCursor = path.join(customPathBin, 'cursor-agent');
      fs.writeFileSync(fakePathCursor, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(fakePathCursor, 0o755);

      process.env.PATH = customPathBin;
      expect(resolveCursorPathForSdk('cursor-agent')).toBe(fakePathCursor);
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      if (origPath === undefined) delete process.env.PATH;
      else process.env.PATH = origPath;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('skips non-executable 0644 cursor-agent files in PATH and picks downstream executable cursor-agent or agent', () => {
    if (process.platform === 'win32') return;
    const origHome = process.env.HOME;
    const origPath = process.env.PATH;
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cursor-exec-'));
    try {
      const badDir = path.join(tmpDir, 'bad-bin');
      const goodDir = path.join(tmpDir, 'good-bin');
      const localBin = path.join(tmpDir, '.local', 'bin');
      fs.mkdirSync(badDir, { recursive: true });
      fs.mkdirSync(goodDir, { recursive: true });
      fs.mkdirSync(localBin, { recursive: true });

      // Non-executable 0644 file shadowing PATH
      const nonExecCursor = path.join(badDir, 'cursor-agent');
      fs.writeFileSync(nonExecCursor, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(nonExecCursor, 0o644);

      process.env.HOME = tmpDir;
      process.env.PATH = badDir;
      expect(resolveCursorPathForSdk('cursor-agent')).toBe('cursor-agent');

      // Fallback executable agent in ~/.local/bin wins over non-executable PATH entry
      const localAgent = path.join(localBin, 'agent');
      fs.writeFileSync(localAgent, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(localAgent, 0o755);
      expect(resolveCursorPathForSdk('cursor-agent')).toBe(localAgent);

      // Downstream executable cursor-agent in PATH wins over fallback agent
      const execCursor = path.join(goodDir, 'cursor-agent');
      fs.writeFileSync(execCursor, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(execCursor, 0o755);
      process.env.PATH = `${badDir}:${goodDir}`;
      expect(resolveCursorPathForSdk('cursor-agent')).toBe(execCursor);
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      if (origPath === undefined) delete process.env.PATH;
      else process.env.PATH = origPath;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('resolves official Windows cursor-agent.cmd -> .ps1 launcher, respects active.txt and fixed argv, and rejects ungrounded wrappers without affecting non-Cursor shims', () => {
    const origPlatform = process.platform;
    const origPath = process.env.PATH;
    const origPathExt = process.env.PATHEXT;
    const origLocalAppData = process.env.LOCALAPPDATA;
    const origUserProfile = process.env.USERPROFILE;
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cursor-win-cmd-'));
    try {
      const badDir = path.join(tmpDir, 'bad-path');
      const goodDir = path.join(tmpDir, 'good-path');
      const vOld = path.join(goodDir, 'versions', '2026.05.05-a1b2c3d');
      const vNew = path.join(goodDir, 'versions', '2026.11.22-e9042b2');
      fs.mkdirSync(badDir, { recursive: true });
      fs.mkdirSync(vOld, { recursive: true });
      fs.mkdirSync(vNew, { recursive: true });

      const oldNode = path.join(vOld, 'node.exe');
      const oldIndex = path.join(vOld, 'index.js');
      const newNode = path.join(vNew, 'node.exe');
      const newIndex = path.join(vNew, 'index.js');
      fs.writeFileSync(oldNode, 'old node');
      fs.writeFileSync(oldIndex, 'console.log("old");\n');
      fs.writeFileSync(newNode, 'new node');
      fs.writeFileSync(newIndex, 'console.log("new");\n');

      // Dir 1 shadows cursor-agent with BOTH an extensionless POSIX script AND a broken unlaunchable .cmd
      fs.writeFileSync(path.join(badDir, 'cursor-agent'), '#!/bin/sh\n');
      fs.writeFileSync(path.join(badDir, 'cursor-agent.cmd'), '@echo off\r\necho broken wrapper\r\n');

      // Dir 2 has the real Windows release package launcher (`agent.cmd` -> `cursor-agent.ps1`)
      const agentCmd = path.join(goodDir, 'agent.cmd');
      const agentPs1 = path.join(goodDir, 'cursor-agent.ps1');
      fs.writeFileSync(agentCmd, [
        '@echo off',
        'rem cursor-agent-promote-staged',
        'if exist "%~dp0versions\\promote-staged.cmd" call "%~dp0versions\\promote-staged.cmd"',
        'if errorlevel 1 exit /b 1',
        'setlocal enabledelayedexpansion',
        'set "CURSOR_INVOKED_AS=%~nx0"',
        'set "SCRIPT_DIR=%~dp0"',
        'if "%SCRIPT_DIR:~-1%"=="\\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"',
        '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\\cursor-agent.ps1" %*',
      ].join('\r\n'));
      fs.writeFileSync(agentPs1, [
        '$scriptPath = Split-Path -parent $MyInvocation.MyCommand.Definition',
        'function Parse-VersionString { param([string]$versionString) $p = $versionString.Split("-")[0].Split("."); return [int]($p[0] + $p[1].PadLeft(2,"0") + $p[2].PadLeft(2,"0")) }',
        '$versionDir = Get-ChildItem -Path "$scriptPath\\versions" -Directory | Where-Object { $_.Name -match \'^\\d{4}\\.\\d{1,2}\\.\\d{1,2}(-\\d{2}-\\d{2}-\\d{2})?-[a-f0-9]+$\' } | Sort-Object { Parse-VersionString $_.Name } -Descending | Select-Object -First 1',
        '$versionName = $versionDir.Name',
        '$nodePath = "$scriptPath\\versions\\$versionName\\node.exe"',
        '& "$nodePath" "$scriptPath\\versions\\$versionName\\index.js" $args',
      ].join('\n'));

      Object.defineProperty(process, 'platform', { value: 'win32' });
      process.env.PATH = `${badDir};${goodDir}`;
      process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
      process.env.LOCALAPPDATA = tmpDir;
      process.env.USERPROFILE = tmpDir;

      // Skips dir1 POSIX cursor-agent + broken cursor-agent.cmd, picks dir2 official agent.cmd -> powershell.exe -File cursor-agent.ps1
      const expectedPsSpec = {
        executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        prependArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', agentPs1],
      };
      expect(resolveCursorPathForSdk('cursor-agent')).toBe(agentCmd);
      expect(resolveCursorExecutableForSpawn('cursor-agent')).toEqual(expectedPsSpec);

      // When installer staged 2026.11.new alongside 2026.05 with promote-staged hook, official PowerShell entrypoint is preserved
      const stagedNewDir = path.join(goodDir, 'versions', '2026.12.01-f1e2d3c.new');
      fs.mkdirSync(stagedNewDir, { recursive: true });
      fs.writeFileSync(path.join(stagedNewDir, 'node.exe'), 'staged node');
      fs.writeFileSync(path.join(stagedNewDir, 'index.js'), 'console.log("staged");\n');
      fs.writeFileSync(path.join(goodDir, 'versions', 'promote-staged.cmd'), '@echo off\r\nexit /b 0\r\n');
      const ps1WithHook = [
        '# cursor-agent-promote-staged',
        '$promoteStaged = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Definition) "versions\\promote-staged.cmd"',
        'if (Test-Path -LiteralPath $promoteStaged) { & $promoteStaged }',
        fs.readFileSync(agentPs1, 'utf8'),
      ].join('\n');
      fs.writeFileSync(agentPs1, ps1WithHook);
      expect(resolveCursorExecutableForSpawn('cursor-agent')).toEqual(expectedPsSpec);

      // Even if active.txt points to a missing version, static .ps1 launchability fails closed -> bad wrapper rejected
      const activeTxt = path.join(goodDir, 'versions', 'active.txt');
      fs.writeFileSync(activeTxt, '2099.01.01-missing\n');
      expect(resolveCursorCmdLauncher(agentCmd)).toBeNull();
      fs.unlinkSync(activeTxt);

      // PATHEXT=.PS1;.EXE;.CMD with standalone cursor-agent.ps1 (no .cmd/.exe) must ignore .ps1 and match downstream agent.exe
      const ps1OnlyDir = path.join(tmpDir, 'ps1-only');
      const exeFallbackDir = path.join(tmpDir, 'exe-fallback');
      fs.mkdirSync(ps1OnlyDir, { recursive: true });
      fs.mkdirSync(exeFallbackDir, { recursive: true });
      fs.writeFileSync(path.join(ps1OnlyDir, 'cursor-agent.ps1'), 'Write-Output "ps1"\n');
      const fallbackExe = path.join(exeFallbackDir, 'agent.exe');
      fs.writeFileSync(fallbackExe, 'fake exe');
      process.env.PATHEXT = '.PS1;.EXE;.CMD';
      process.env.PATH = ps1OnlyDir;
      process.env.LOCALAPPDATA = path.join(tmpDir, 'empty-local');
      process.env.USERPROFILE = path.join(tmpDir, 'empty-profile');
      expect(resolveCursorPathForSdk('cursor-agent')).toBe('cursor-agent');
      expect(resolveCursorExecutableForSpawn('cursor-agent')).toEqual({
        executable: 'cursor-agent',
        prependArgs: [],
      });
      process.env.PATH = `${ps1OnlyDir};${exeFallbackDir}`;
      expect(resolveCursorPathForSdk('cursor-agent')).toBe(fallbackExe);
      expect(resolveCursorExecutableForSpawn('cursor-agent')).toEqual({
        executable: fallbackExe,
        prependArgs: [],
      });

      // Explicit missing bundled node.exe (even with existing index.js) must reject the broken .cmd and continue search
      const missingNodeDir = path.join(tmpDir, 'missing-node-cmd');
      fs.mkdirSync(missingNodeDir, { recursive: true });
      fs.writeFileSync(path.join(missingNodeDir, 'index.js'), 'console.log("orphan");\n');
      const missingNodeCmd = path.join(missingNodeDir, 'cursor-agent.cmd');
      fs.writeFileSync(missingNodeCmd, '"%~dp0missing\\node.exe" "%~dp0index.js" %*\r\n');
      expect(resolveCursorCmdLauncher(missingNodeCmd)).toBeNull();
      process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
      process.env.PATH = `${missingNodeDir};${exeFallbackDir}`;
      expect(resolveCursorPathForSdk('cursor-agent')).toBe(fallbackExe);
      expect(resolveCursorExecutableForSpawn('cursor-agent')).toEqual({
        executable: fallbackExe,
        prependArgs: [],
      });

      // Preserves fixed argv flags (e.g. --use-system-ca) in native Cursor launcher without dropping them
      const fixedCmd = path.join(goodDir, 'agent-fixed.cmd');
      fs.writeFileSync(fixedCmd, [
        '@echo off',
        'rem cursor-agent-promote-staged',
        'if exist "%~dp0versions\\promote-staged.cmd" call "%~dp0versions\\promote-staged.cmd"',
        'set "NODE_BIN=%~dp0versions\\2026.11.22-e9042b2\\node.exe"',
        'set "ENTRY=%~dp0versions\\2026.11.22-e9042b2\\index.js"',
        '"%NODE_BIN%" --use-system-ca "%ENTRY%" %*',
      ].join('\r\n'));
      expect(resolveCursorExecutableForSpawn(fixedCmd)).toEqual({
        executable: newNode,
        prependArgs: ['--use-system-ca', newIndex],
      });

      // Ungrounded random .cmd alongside versions/ must NOT guess latest versions/* dir
      const bogusCmd = path.join(goodDir, 'bogus.cmd');
      fs.writeFileSync(bogusCmd, '@echo off\r\necho not a valid launcher\r\n');
      expect(resolveCursorCmdLauncher(bogusCmd)).toBeNull();

      // Shared non-Cursor resolveExecutableForSpawn must keep npm shim semantics even if preflight.exe exists
      const npmRoot = path.join(tmpDir, 'npm-codex');
      const codexJsDir = path.join(npmRoot, 'node_modules', '@openai', 'codex', 'bin');
      fs.mkdirSync(codexJsDir, { recursive: true });
      const codexJs = path.join(codexJsDir, 'codex.js');
      const preflightExe = path.join(npmRoot, 'preflight.exe');
      fs.writeFileSync(codexJs, 'console.log("codex");\n');
      fs.writeFileSync(preflightExe, 'fake preflight');
      const codexCmd = path.join(npmRoot, 'codex.cmd');
      fs.writeFileSync(codexCmd, [
        '@ECHO off',
        'if exist "%dp0%\\preflight.exe" "%dp0%\\preflight.exe" --check',
        'SET dp0=%~dp0',
        '"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
      ].join('\r\n'));
      expect(resolveExecutableForSpawn(codexCmd)).toEqual({
        executable: process.execPath,
        prependArgs: [codexJs],
      });
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
      process.env.PATH = origPath;
      if (origPathExt === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = origPathExt;
      if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = origLocalAppData;
      if (origUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = origUserProfile;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });
});

describe('parseNpmCmdShim', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'shim-test-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('extracts the underlying .js path from an npm-style cmd shim', () => {
    const shim = path.join(tmpDir, 'codex.cmd');
    fs.writeFileSync(shim,
      '@ECHO off\r\n' +
      'GOTO start\r\n' +
      ':find_dp0\r\n' +
      'SET dp0=%~dp0\r\n' +
      'EXIT /b\r\n' +
      ':start\r\n' +
      'SETLOCAL\r\n' +
      'CALL :find_dp0\r\n' +
      'IF EXIST "%dp0%\\node.exe" (\r\n' +
      '  SET "_prog=%dp0%\\node.exe"\r\n' +
      ') ELSE (\r\n' +
      '  SET "_prog=node"\r\n' +
      ')\r\n' +
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
    const scriptPath = parseNpmCmdShim(shim);
    expect(scriptPath).toBeTruthy();
    expect(scriptPath?.replace(/\\/g, '/')).toContain('node_modules/@openai/codex/bin/codex.js');
  });

  it('returns null for files that are not npm shims', () => {
    const notShim = path.join(tmpDir, 'random.cmd');
    fs.writeFileSync(notShim, '@echo hello\r\n');
    expect(parseNpmCmdShim(notShim)).toBeNull();
  });

  it('returns null for non-existent files', () => {
    expect(parseNpmCmdShim(path.join(tmpDir, 'does-not-exist.cmd'))).toBeNull();
  });
});

describe('resolveBinaryOnWindows', () => {
  it('returns input unchanged on non-Windows', () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      expect(resolveBinaryOnWindows('claude')).toBe('claude');
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });

  it('returns input unchanged when binary is not found on PATH', () => {
    const origPlatform = process.platform;
    const origPath = process.env.PATH;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.PATH = '';
    try {
      expect(resolveBinaryOnWindows('xyz-not-real-bin')).toBe('xyz-not-real-bin');
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
      process.env.PATH = origPath;
    }
  });

  it('prefers .cmd over extensionless Unix shim', () => {
    const origPlatform = process.platform;
    const origPath = process.env.PATH;
    const origPathExt = process.env.PATHEXT;
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'resolve-test-'));
    fs.writeFileSync(path.join(tmpDir, 'tool'), '#!/bin/sh\necho hi\n');
    fs.writeFileSync(path.join(tmpDir, 'tool.cmd'), '@echo off\r\necho hi\r\n');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.PATH = tmpDir;
    // Lowercase PATHEXT — Linux test runners are case-sensitive and the file
    // we created above is `tool.cmd`. On real Windows the FS is
    // case-insensitive so this works there too.
    process.env.PATHEXT = '.com;.exe;.bat;.cmd';
    try {
      const resolved = resolveBinaryOnWindows('tool');
      expect(resolved.toLowerCase().endsWith('.cmd')).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
      process.env.PATH = origPath;
      if (origPathExt === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = origPathExt;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('falls back to APPDATA npm shims when PATH is missing', () => {
    const origPlatform = process.platform;
    const origPath = process.env.PATH;
    const origAppData = process.env.APPDATA;
    const origPathExt = process.env.PATHEXT;
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'resolve-appdata-test-'));
    const npmDir = path.join(tmpDir, 'npm');
    fs.mkdirSync(npmDir, { recursive: true });
    fs.writeFileSync(path.join(npmDir, 'claude.cmd'), '@echo off\r\necho hi\r\n');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.PATH = '';
    process.env.APPDATA = tmpDir;
    process.env.PATHEXT = '.com;.exe;.bat;.cmd';
    try {
      const resolved = resolveBinaryOnWindows('claude');
      expect(resolved.toLowerCase().endsWith(path.join('npm', 'claude.cmd').toLowerCase())).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
      process.env.PATH = origPath;
      if (origAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = origAppData;
      if (origPathExt === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = origPathExt;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('resolveExecutableForSpawn', () => {
  it('returns input unchanged on non-Windows', () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const r = resolveExecutableForSpawn('claude');
      expect(r.executable).toBe('claude');
      expect(r.prependArgs).toEqual([]);
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });

  it('returns .exe paths unchanged with no prepended args', () => {
    const origPlatform = process.platform;
    const origPath = process.env.PATH;
    const origPathExt = process.env.PATHEXT;
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'spawn-exe-test-'));
    fs.writeFileSync(path.join(tmpDir, 'tool.exe'), 'fake exe');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.PATH = tmpDir;
    process.env.PATHEXT = '.com;.exe;.bat;.cmd';
    try {
      const r = resolveExecutableForSpawn('tool');
      expect(r.executable.toLowerCase().endsWith('.exe')).toBe(true);
      expect(r.prependArgs).toEqual([]);
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
      process.env.PATH = origPath;
      if (origPathExt === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = origPathExt;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('parses npm .cmd shim and returns (node.exe, [scriptPath])', () => {
    const origPlatform = process.platform;
    const origPath = process.env.PATH;
    const origPathExt = process.env.PATHEXT;
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'spawn-shim-test-'));
    const scriptDir = path.join(tmpDir, 'node_modules', '@scope', 'pkg', 'bin');
    fs.mkdirSync(scriptDir, { recursive: true });
    fs.writeFileSync(path.join(scriptDir, 'cli.js'), '#!/usr/bin/env node\n');
    const shim = path.join(tmpDir, 'mytool.cmd');
    fs.writeFileSync(shim,
      '@ECHO off\r\n' +
      'CALL :find_dp0\r\n' +
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@scope\\pkg\\bin\\cli.js" %*\r\n');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.PATH = tmpDir;
    process.env.PATHEXT = '.com;.exe;.bat;.cmd';
    try {
      const r = resolveExecutableForSpawn('mytool');
      // executable should be node.exe (process.execPath)
      expect(r.executable.toLowerCase()).toContain('node');
      // prependArgs should contain the .js path
      expect(r.prependArgs).toHaveLength(1);
      expect(r.prependArgs[0].replace(/\\/g, '/')).toContain('node_modules/@scope/pkg/bin/cli.js');
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
      process.env.PATH = origPath;
      if (origPathExt === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = origPathExt;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('falls back to passthrough for unknown extensions', () => {
    const origPlatform = process.platform;
    const origPath = process.env.PATH;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.PATH = '';
    try {
      const r = resolveExecutableForSpawn('xyz-not-real');
      expect(r.executable).toBe('xyz-not-real');
      expect(r.prependArgs).toEqual([]);
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
      process.env.PATH = origPath;
    }
  });
});

describe('resolveClaudeCodePathForSdk', () => {
  it('returns the underlying js entrypoint for npm cmd shims', () => {
    const origPlatform = process.platform;
    const origPath = process.env.PATH;
    const origPathExt = process.env.PATHEXT;
    const origAppData = process.env.APPDATA;
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'claude-sdk-path-test-'));
    const npmDir = path.join(tmpDir, 'npm');
    const scriptDir = path.join(npmDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
    fs.mkdirSync(scriptDir, { recursive: true });
    fs.writeFileSync(path.join(scriptDir, 'claude.js'), '#!/usr/bin/env node\n');
    fs.writeFileSync(
      path.join(npmDir, 'claude.cmd'),
      '@ECHO off\r\n' +
      'CALL :find_dp0\r\n' +
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.js" %*\r\n',
    );
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.PATH = '';
    process.env.APPDATA = tmpDir;
    process.env.PATHEXT = '.com;.exe;.bat;.cmd';
    try {
      const resolved = resolveClaudeCodePathForSdk();
      expect(resolved.replace(/\\/g, '/')).toContain('node_modules/@anthropic-ai/claude-code/bin/claude.js');
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
      process.env.PATH = origPath;
      if (origAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = origAppData;
      if (origPathExt === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = origPathExt;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
