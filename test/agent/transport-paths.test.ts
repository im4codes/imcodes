import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';

import {
  normalizeTransportCwd,
  resolveBinaryOnWindows,
  parseNpmCmdShim,
  resolveExecutableForSpawn,
  resolveClaudeCodePathForSdk,
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
