import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';

import {
  normalizeTransportCwd,
  resolveBinaryOnWindows,
  parseNpmCmdShim,
  resolveExecutableForSpawn,
  resolveClaudeCodePathForSdk,
  getUnixCliInstallCandidates,
  walkPathForBinary,
  resolveCliPathForSdk,
  resolveCodexPathForSdk,
  IMCODES_CODEX_BINARY_PATH_ENV,
  resolveClaudeCodePathForTmux,
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

describe('getUnixCliInstallCandidates (generalized, any CLI binary)', () => {
  let origHome: string | undefined;
  const FAKE_HOME = '/tmp/imcodes-fake-home-for-tests';

  beforeEach(() => {
    origHome = process.env.HOME;
    process.env.HOME = FAKE_HOME;
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  });

  it.each([
    ['~/.local/bin', path.join(FAKE_HOME, '.local', 'bin', 'codex')],
    ['~/.npm-global/bin', path.join(FAKE_HOME, '.npm-global', 'bin', 'codex')],
    ['~/bin (XDG user bin)', path.join(FAKE_HOME, 'bin', 'codex')],
    ['~/.bun/bin (Bun)', path.join(FAKE_HOME, '.bun', 'bin', 'codex')],
    ['~/.cargo/bin (rustup/cargo)', path.join(FAKE_HOME, '.cargo', 'bin', 'codex')],
    ['~/.yarn/bin (Yarn)', path.join(FAKE_HOME, '.yarn', 'bin', 'codex')],
    ['~/.asdf/shims (asdf)', path.join(FAKE_HOME, '.asdf', 'shims', 'codex')],
    ['~/.local/share/<bin>/<bin>', path.join(FAKE_HOME, '.local', 'share', 'codex', 'codex')],
    ['/usr/local/bin', path.join('/usr/local/bin', 'codex')],
    ['/opt/homebrew/bin', path.join('/opt/homebrew/bin', 'codex')],
    ['/opt/<bin>/bin/<bin>', path.join('/opt', 'codex', 'bin', 'codex')],
    ['/snap/bin', path.join('/snap/bin', 'codex')],
    ['/var/lib/snapd/snap/bin', path.join('/var/lib/snapd/snap/bin', 'codex')],
    ['/nix/var/nix/profiles/default/bin', path.join('/nix/var/nix/profiles/default/bin', 'codex')],
  ])('includes the %s candidate for an arbitrary binary name', (_label, expected) => {
    expect(getUnixCliInstallCandidates('codex')).toContain(expected);
  });

  it('substitutes the binary name consistently across every candidate (no hardcoded "claude")', () => {
    const candidates = getUnixCliInstallCandidates('opencode');
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(path.basename(candidate)).toBe('opencode');
      expect(candidate).not.toContain('claude');
    }
  });

  it('appends extraHomeRelative and extraAbsolute candidates when provided', () => {
    const candidates = getUnixCliInstallCandidates('claude', {
      extraHomeRelative: [path.join('.claude', 'local', 'claude')],
      extraAbsolute: ['/custom/claude-root/claude'],
    });
    expect(candidates).toContain(path.join(FAKE_HOME, '.claude', 'local', 'claude'));
    expect(candidates).toContain('/custom/claude-root/claude');
  });

  it('omits every HOME-relative candidate when HOME is unset, without throwing', () => {
    delete process.env.HOME;
    const candidates = getUnixCliInstallCandidates('codex');
    expect(candidates.every((c) => !c.includes(FAKE_HOME))).toBe(true);
    expect(candidates).toContain(path.join('/usr/local/bin', 'codex'));
  });
});

describe('walkPathForBinary', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'agent-path-walk-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds an executable on a PATH directory the fixed candidate list does not cover', () => {
    const binPath = path.join(tmpDir, 'codex');
    fs.writeFileSync(binPath, '#!/bin/sh\necho fake codex\n');
    const fakePath = ['/does/not/exist', tmpDir, '/also/does/not/exist'].join(path.delimiter);
    expect(walkPathForBinary('codex', fakePath)).toBe(binPath);
  });

  it('returns undefined when no PATH directory has the binary', () => {
    const fakePath = ['/does/not/exist', '/also/does/not/exist'].join(path.delimiter);
    expect(walkPathForBinary('codex', fakePath)).toBeUndefined();
  });

  it('returns undefined for an explicitly empty PATH instead of throwing', () => {
    expect(walkPathForBinary('codex', '')).toBeUndefined();
  });

  it('skips empty PATH segments (e.g. a leading/trailing/doubled delimiter)', () => {
    const binPath = path.join(tmpDir, 'codex');
    fs.writeFileSync(binPath, '#!/bin/sh\necho fake codex\n');
    const fakePath = ['', tmpDir, ''].join(path.delimiter);
    expect(walkPathForBinary('codex', fakePath)).toBe(binPath);
  });
});

describe('resolveCliPathForSdk (generic resolver)', () => {
  let origHome: string | undefined;
  let tmpDir: string;

  beforeEach(() => {
    origHome = process.env.HOME;
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'resolve-cli-path-test-'));
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('honours an explicit caller-provided name/path unchanged, without touching the env override', () => {
    if (process.platform === 'win32') return;
    const overridePath = path.join(tmpDir, 'widget');
    fs.writeFileSync(overridePath, '#!/bin/sh\n');
    const origEnv = process.env.IMCODES_WIDGET_BINARY_PATH;
    process.env.IMCODES_WIDGET_BINARY_PATH = overridePath;
    try {
      expect(resolveCliPathForSdk('widget', '/explicit/widget-canary', { envOverrideVar: 'IMCODES_WIDGET_BINARY_PATH' }))
        .toBe('/explicit/widget-canary');
    } finally {
      if (origEnv === undefined) delete process.env.IMCODES_WIDGET_BINARY_PATH; else process.env.IMCODES_WIDGET_BINARY_PATH = origEnv;
    }
  });

  it('applies the env override for the default name only, before candidates/PATH-walk', () => {
    if (process.platform === 'win32') return;
    const overridePath = path.join(tmpDir, 'widget');
    fs.writeFileSync(overridePath, '#!/bin/sh\n');
    process.env.HOME = '/tmp/imcodes-nonexistent-home-xyz';
    const origEnv = process.env.IMCODES_WIDGET_BINARY_PATH;
    process.env.IMCODES_WIDGET_BINARY_PATH = overridePath;
    try {
      expect(resolveCliPathForSdk('widget', 'widget', { envOverrideVar: 'IMCODES_WIDGET_BINARY_PATH' })).toBe(overridePath);
    } finally {
      if (origEnv === undefined) delete process.env.IMCODES_WIDGET_BINARY_PATH; else process.env.IMCODES_WIDGET_BINARY_PATH = origEnv;
    }
  });

  it('falls back to bundled → candidates → PATH-walk → bare name when no override is configured', () => {
    if (process.platform === 'win32') return;
    process.env.HOME = '/tmp/imcodes-nonexistent-home-xyz';
    expect(resolveCliPathForSdk('widget-not-a-real-binary-xyz')).toBe('widget-not-a-real-binary-xyz');
  });

  it('prefers resolveBundled over fixed candidates and PATH-walk when provided', () => {
    if (process.platform === 'win32') return;
    const bundledPath = path.join(tmpDir, 'widget');
    fs.writeFileSync(bundledPath, '#!/bin/sh\n');
    expect(resolveCliPathForSdk('widget', 'widget', { resolveBundled: () => bundledPath })).toBe(bundledPath);
  });
});

describe('resolveCodexPathForSdk', () => {
  let origHome: string | undefined;
  let origEnv: string | undefined;
  let tmpDir: string;

  beforeEach(() => {
    origHome = process.env.HOME;
    origEnv = process.env[IMCODES_CODEX_BINARY_PATH_ENV];
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'codex-path-test-'));
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origEnv === undefined) delete process.env[IMCODES_CODEX_BINARY_PATH_ENV]; else process.env[IMCODES_CODEX_BINARY_PATH_ENV] = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses IMCODES_CODEX_BINARY_PATH as the env override variable', () => {
    expect(IMCODES_CODEX_BINARY_PATH_ENV).toBe('IMCODES_CODEX_BINARY_PATH');
  });

  it('resolves the env override for the default name', () => {
    if (process.platform === 'win32') return;
    const overridePath = path.join(tmpDir, 'codex');
    fs.writeFileSync(overridePath, '#!/bin/sh\n');
    process.env[IMCODES_CODEX_BINARY_PATH_ENV] = overridePath;
    expect(resolveCodexPathForSdk()).toBe(overridePath);
  });

  it('finds codex via a fixed per-user candidate under a HOME override', () => {
    if (process.platform === 'win32') return;
    delete process.env[IMCODES_CODEX_BINARY_PATH_ENV];
    process.env.HOME = tmpDir;
    const candidatePath = path.join(tmpDir, '.local', 'bin', 'codex');
    fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
    fs.writeFileSync(candidatePath, '#!/bin/sh\n');
    expect(resolveCodexPathForSdk()).toBe(candidatePath);
  });

  it('does NOT override an explicit caller-provided path (regression guard)', () => {
    if (process.platform === 'win32') return;
    const overridePath = path.join(tmpDir, 'codex');
    fs.writeFileSync(overridePath, '#!/bin/sh\n');
    process.env[IMCODES_CODEX_BINARY_PATH_ENV] = overridePath;
    expect(resolveCodexPathForSdk('/explicit/custom/codex-canary')).toBe('/explicit/custom/codex-canary');
  });
});

describe('resolveClaudeCodePathForTmux', () => {
  let origHome: string | undefined;
  let origEnv: string | undefined;
  let tmpDir: string;

  beforeEach(() => {
    origHome = process.env.HOME;
    origEnv = process.env.IMCODES_CLAUDE_BINARY_PATH;
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'claude-tmux-path-test-'));
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origEnv === undefined) delete process.env.IMCODES_CLAUDE_BINARY_PATH; else process.env.IMCODES_CLAUDE_BINARY_PATH = origEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the bare name unchanged on win32 (ConPTY command-string embedding is out of scope)', () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(resolveClaudeCodePathForTmux()).toBe('claude');
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }
  });

  it('finds claude via a fixed per-user candidate under a HOME override, on non-Windows', () => {
    if (process.platform === 'win32') return;
    delete process.env.IMCODES_CLAUDE_BINARY_PATH;
    process.env.HOME = tmpDir;
    const candidatePath = path.join(tmpDir, '.local', 'bin', 'claude');
    fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
    fs.writeFileSync(candidatePath, '#!/bin/sh\n');
    expect(resolveClaudeCodePathForTmux()).toBe(candidatePath);
  });

  it('finds claude via the claude-specific ~/.claude/local/claude extra candidate', () => {
    if (process.platform === 'win32') return;
    delete process.env.IMCODES_CLAUDE_BINARY_PATH;
    process.env.HOME = tmpDir;
    const candidatePath = path.join(tmpDir, '.claude', 'local', 'claude');
    fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
    fs.writeFileSync(candidatePath, '#!/bin/sh\n');
    expect(resolveClaudeCodePathForTmux()).toBe(candidatePath);
  });

  it('respects IMCODES_CLAUDE_BINARY_PATH, the same env var the SDK-transport resolver uses', () => {
    if (process.platform === 'win32') return;
    const overridePath = path.join(tmpDir, 'claude');
    fs.writeFileSync(overridePath, '#!/bin/sh\n');
    process.env.IMCODES_CLAUDE_BINARY_PATH = overridePath;
    expect(resolveClaudeCodePathForTmux()).toBe(overridePath);
  });

  it('does NOT override an explicit caller-provided path (regression guard)', () => {
    if (process.platform === 'win32') return;
    process.env.IMCODES_CLAUDE_BINARY_PATH = path.join(tmpDir, 'claude');
    fs.writeFileSync(process.env.IMCODES_CLAUDE_BINARY_PATH, '#!/bin/sh\n');
    expect(resolveClaudeCodePathForTmux('/explicit/custom/claude-canary')).toBe('/explicit/custom/claude-canary');
  });

  it('falls through to the bare name when nothing resolves, reproducing pre-hardening behavior', () => {
    if (process.platform === 'win32') return;
    delete process.env.IMCODES_CLAUDE_BINARY_PATH;
    process.env.HOME = '/tmp/imcodes-nonexistent-home-xyz-tmux';
    const origPath = process.env.PATH;
    process.env.PATH = '/does/not/exist';
    try {
      expect(resolveClaudeCodePathForTmux()).toBe('claude');
    } finally {
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
