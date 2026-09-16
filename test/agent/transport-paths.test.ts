import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';

import {
  normalizeTransportCwd,
  resolveBinaryOnWindows,
  parseNpmCmdShim,
  resolveExecutableForSpawn,
  resolveClaudeCodePathForSdk,
  getUnixClaudeInstallCandidates,
  walkPathForBinary,
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

describe('getUnixClaudeInstallCandidates', () => {
  let origHome: string | undefined;
  const FAKE_HOME = '/tmp/imcodes-fake-home-for-tests';

  beforeEach(() => {
    origHome = process.env.HOME;
    process.env.HOME = FAKE_HOME;
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  });

  // Every one of these must keep resolving under a HOME override so a
  // sparse-PATH daemon can still find claude installed via any of these
  // package/version managers, not just the original ~/.local/bin and
  // ~/.claude/local install points.
  it.each([
    ['~/bin (XDG user bin)', path.join(FAKE_HOME, 'bin', 'claude')],
    ['~/.bun/bin (Bun)', path.join(FAKE_HOME, '.bun', 'bin', 'claude')],
    ['~/.cargo/bin (rustup/cargo)', path.join(FAKE_HOME, '.cargo', 'bin', 'claude')],
    ['~/.yarn/bin (Yarn)', path.join(FAKE_HOME, '.yarn', 'bin', 'claude')],
    ['~/.asdf/shims (asdf)', path.join(FAKE_HOME, '.asdf', 'shims', 'claude')],
    ['~/.local/share/claude (native installer XDG data variant)', path.join(FAKE_HOME, '.local', 'share', 'claude', 'claude')],
  ])('includes the %s candidate', (_label, expected) => {
    expect(getUnixClaudeInstallCandidates()).toContain(expected);
  });

  it('includes the original five candidates unchanged', () => {
    const candidates = getUnixClaudeInstallCandidates();
    expect(candidates).toContain(path.join(FAKE_HOME, '.local', 'bin', 'claude'));
    expect(candidates).toContain(path.join(FAKE_HOME, '.claude', 'local', 'claude'));
    expect(candidates).toContain(path.join(FAKE_HOME, '.npm-global', 'bin', 'claude'));
    expect(candidates).toContain('/usr/local/bin/claude');
    expect(candidates).toContain('/opt/homebrew/bin/claude');
  });

  it('includes system-wide package-manager install locations', () => {
    const candidates = getUnixClaudeInstallCandidates();
    expect(candidates).toContain('/opt/claude/bin/claude');
    expect(candidates).toContain('/snap/bin/claude');
    expect(candidates).toContain('/var/lib/snapd/snap/bin/claude');
    expect(candidates).toContain('/nix/var/nix/profiles/default/bin/claude');
  });

  it('omits every HOME-relative candidate when HOME is unset, without throwing', () => {
    delete process.env.HOME;
    const candidates = getUnixClaudeInstallCandidates();
    expect(candidates.every((c) => !c.includes(FAKE_HOME))).toBe(true);
    // System-wide candidates still work with no HOME at all.
    expect(candidates).toContain('/usr/local/bin/claude');
  });
});

describe('walkPathForBinary', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'claude-path-walk-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds an executable on a PATH directory the fixed candidate list does not cover', () => {
    const claudePath = path.join(tmpDir, 'claude');
    fs.writeFileSync(claudePath, '#!/bin/sh\necho fake claude\n');
    const fakePath = ['/does/not/exist', tmpDir, '/also/does/not/exist'].join(path.delimiter);
    expect(walkPathForBinary('claude', fakePath)).toBe(claudePath);
  });

  it('returns undefined when no PATH directory has the binary', () => {
    const fakePath = ['/does/not/exist', '/also/does/not/exist'].join(path.delimiter);
    expect(walkPathForBinary('claude', fakePath)).toBeUndefined();
  });

  it('returns undefined for an explicitly empty PATH instead of throwing', () => {
    expect(walkPathForBinary('claude', '')).toBeUndefined();
  });

  it('defaults to the real process.env.PATH when no pathEnv argument is given', () => {
    const origPath = process.env.PATH;
    const claudePath = path.join(tmpDir, 'claude');
    fs.writeFileSync(claudePath, '#!/bin/sh\necho fake claude\n');
    process.env.PATH = tmpDir;
    try {
      expect(walkPathForBinary('claude')).toBe(claudePath);
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('skips empty PATH segments (e.g. a leading/trailing/doubled delimiter)', () => {
    const claudePath = path.join(tmpDir, 'claude');
    fs.writeFileSync(claudePath, '#!/bin/sh\necho fake claude\n');
    const fakePath = ['', tmpDir, ''].join(path.delimiter);
    expect(walkPathForBinary('claude', fakePath)).toBe(claudePath);
  });
});

describe('resolveClaudeCodePathForSdk — IMCODES_CLAUDE_BINARY_PATH override', () => {
  let tmpDir: string;
  let overridePath: string;
  let origEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'claude-binary-override-test-'));
    overridePath = path.join(tmpDir, 'claude');
    fs.writeFileSync(overridePath, '#!/bin/sh\necho fake claude\n');
    origEnv = process.env.IMCODES_CLAUDE_BINARY_PATH;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.IMCODES_CLAUDE_BINARY_PATH; else process.env.IMCODES_CLAUDE_BINARY_PATH = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('takes precedence over bundled-binary/candidate/PATH resolution for the default name', () => {
    process.env.IMCODES_CLAUDE_BINARY_PATH = overridePath;
    expect(resolveClaudeCodePathForSdk()).toBe(overridePath);
    expect(resolveClaudeCodePathForSdk('claude')).toBe(overridePath);
  });

  it('is ignored when it points at a path that does not exist (falls through to normal resolution)', () => {
    process.env.IMCODES_CLAUDE_BINARY_PATH = path.join(tmpDir, 'does-not-exist-claude');
    expect(resolveClaudeCodePathForSdk()).not.toBe(process.env.IMCODES_CLAUDE_BINARY_PATH);
  });

  it('does NOT override an explicit caller-provided path (regression guard)', () => {
    process.env.IMCODES_CLAUDE_BINARY_PATH = overridePath;
    // A caller that already resolved its own binary (e.g. a per-session
    // config.binaryPath) must win over the ops-level env default — the env
    // var only fills in for the *default* 'claude' lookup.
    expect(resolveClaudeCodePathForSdk('/explicit/custom/claude-canary')).toBe('/explicit/custom/claude-canary');
  });

  it('applies uniformly on Windows for the default name too', () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.IMCODES_CLAUDE_BINARY_PATH = overridePath;
    try {
      expect(resolveClaudeCodePathForSdk()).toBe(overridePath);
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });

  it('does not block Windows shim resolution for an explicit custom name (regression guard)', () => {
    // Exercises the exact ordering bug this change could have introduced:
    // gating the env-override check on `name === 'claude'` must NOT also
    // gate the existing Windows branch, which needs to run for ANY name
    // (including a custom one) to convert .cmd shims to their underlying
    // script per the function's pre-existing contract.
    const origPlatform = process.platform;
    const origPath = process.env.PATH;
    process.env.IMCODES_CLAUDE_BINARY_PATH = overridePath;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.PATH = '';
    try {
      expect(resolveClaudeCodePathForSdk('claude-canary')).toBe('claude-canary');
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
      process.env.PATH = origPath;
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
