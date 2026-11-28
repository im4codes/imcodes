import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { spawnMock, exitListeners } = vi.hoisted(() => {
  const listeners: Array<(e: { exitCode: number }) => void> = [];
  const spawn = vi.fn(() => ({
    pid: 4242,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn((cb: (e: { exitCode: number }) => void) => {
      listeners.push(cb);
    }),
  }));
  return { spawnMock: spawn, exitListeners: listeners };
});

vi.mock('node-pty', () => ({
  spawn: spawnMock,
}));

import { ClaudeCodeDriver } from '../../src/agent/drivers/claude-code.js';
import { CodexDriver } from '../../src/agent/drivers/codex.js';
import { conptyKillSession, conptyNewSession, conptyRespawnPane, conptyIsPaneAlive } from '../../src/agent/conpty.js';
import { resolveWindowsExecutableForConpty } from '../../src/agent/win-launch.js';
import { getWindowsClaudeInstallCandidates } from '../../src/agent/transport-paths.js';

describe('Windows ConPTY direct argv launch', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    delete process.env.IMCODES_MUX;
    for (const s of ['win-test-cc', 'win-test-codex', 'win-test-fallback', 'win-test-native', 'win-test-batch']) {
      await conptyKillSession(s).catch(() => {});
    }
    spawnMock.mockClear();
    exitListeners.length = 0;
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createFakeNpmDualShims(cmdName: string): { npmDir: string; appDataDir: string; cmdPath: string; shimJs: string } {
    const root = mkdtempSync(join(tmpdir(), 'imcodes-conpty-shim-'));
    tempDirs.push(root);
    const npmDir = join(root, 'npm');
    const pkgDir = join(npmDir, 'node_modules', 'probe');
    mkdirSync(pkgDir, { recursive: true });
    const shimJs = join(pkgDir, 'cli.js');
    writeFileSync(shimJs, 'console.log(JSON.stringify(process.argv.slice(2)));\n', 'utf8');
    // Standard npm on Windows writes BOTH the extensionless Unix shell script AND `<name>.cmd`.
    writeFileSync(join(npmDir, cmdName), '#!/bin/sh\necho SHOULD_NOT_RUN_UNIX_SHIM\n', 'utf8');
    const cmdPath = join(npmDir, `${cmdName}.cmd`);
    writeFileSync(
      cmdPath,
      `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\probe\\cli.js" %*\r\n`,
      'utf8',
    );
    return { npmDir, appDataDir: root, cmdPath, shimJs };
  }

  it('prefers .cmd over coexisting extensionless Unix shim in both APPDATA\\npm and PATH for Claude & Codex launch/resume', async () => {
    process.env.IMCODES_MUX = 'conpty';
    const ccDual = createFakeNpmDualShims('claude');
    const cxDual = createFakeNpmDualShims('codex');
    const trickyModel = `m'2 "quoted" %TEMP% & whoami`;
    const ccDriver = new ClaudeCodeDriver();
    const cxDriver = new CodexDriver();

    // Even when PATH is sparse and APPDATA\npm has BOTH `claude` and `claude.cmd`, candidates must exclude extensionless `claude`.
    const claudeCandidates = getWindowsClaudeInstallCandidates('claude', { APPDATA: ccDual.appDataDir });
    expect(claudeCandidates.some((c) => /claude$/i.test(c))).toBe(false);

    const launchSpec = ccDriver.buildWinLaunchSpec('win-test-cc', {
      ccSessionId: 'cc-win-1',
      requestedModel: trickyModel,
    });
    const resumeSpec = ccDriver.buildWinResumeSpec('win-test-cc', {
      ccSessionId: 'cc-win-1',
      requestedModel: trickyModel,
    });

    for (const spec of [launchSpec, resumeSpec]) {
      // Both sparse-PATH (APPDATA fallback) and populated-PATH resolve to claude.cmd -> node + cli.js
      for (const env of [
        { APPDATA: ccDual.appDataDir, PATHEXT: '.COM;.EXE;.BAT;.CMD', TEMP: '/SHOULD_NOT_EXPAND' },
        { PATH: ccDual.npmDir, PATHEXT: '.COM;.EXE;.BAT;.CMD', TEMP: '/SHOULD_NOT_EXPAND' },
      ]) {
        const plan = resolveWindowsExecutableForConpty(spec.primary, env, 'win32');
        expect(plan.kind).toBe('direct');
        if (plan.kind === 'direct') {
          expect(plan.file).toBe(process.execPath);
          expect(plan.args[0]).toBe(ccDual.shimJs);
          const out = execFileSync(plan.file, plan.args, { env: { ...process.env, TEMP: '/SHOULD_NOT_EXPAND' }, encoding: 'utf8' });
          const childArgv = JSON.parse(out.trim()) as string[];
          expect(childArgv[childArgv.indexOf('--model') + 1]).toBe(trickyModel);
        }
      }
    }

    await conptyNewSession('win-test-cc', 'claude --ignored', {
      cwd: ccDual.npmDir,
      env: { PATH: ccDual.npmDir, PATHEXT: '.COM;.EXE;.BAT;.CMD', TEMP: '/SHOULD_NOT_EXPAND' },
      winLaunch: launchSpec,
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [file0, args0] = spawnMock.mock.calls[0] as [string, string[]];
    expect(file0).toBe(process.execPath);
    expect(args0[0]).toBe(ccDual.shimJs);
    expect(args0[args0.indexOf('--model') + 1]).toBe(trickyModel);

    // Codex dual shim with fallback and respawn
    const cxSpec = cxDriver.buildWinResumeSpec('win-test-fallback', { codexModel: `codex "5" %TEMP% & echo` });
    await conptyNewSession('win-test-fallback', 'codex --ignored', {
      cwd: cxDual.npmDir,
      env: { PATH: cxDual.npmDir, PATHEXT: '.COM;.EXE;.BAT;.CMD', TEMP: '/SHOULD_NOT_EXPAND' },
      winLaunch: cxSpec,
    });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect((spawnMock.mock.calls[1] as [string, string[]])[1][0]).toBe(cxDual.shimJs);

    // Non-zero exit on `codex resume --last` triggers fallback direct launch
    exitListeners[1]({ exitCode: 1 });
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(conptyIsPaneAlive('win-test-fallback')).toBe(true);
    expect((spawnMock.mock.calls[2] as [string, string[]])[1]).not.toContain('resume');

    await conptyRespawnPane('win-test-fallback', 'codex --ignored', {
      env: { PATH: cxDual.npmDir, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      winLaunch: cxDriver.buildWinResumeSpec('win-test-fallback', {
        codexSessionId: 'cx-uuid-1',
        codexModel: `codex "5" %TEMP% & echo`,
      }),
    });
    expect(spawnMock).toHaveBeenCalledTimes(4);
    expect((spawnMock.mock.calls[3] as [string, string[]])[1]).toContain('cx-uuid-1');
  });

  it('spawns native .exe executables directly bypassing cmd.exe on launch and resume', async () => {
    process.env.IMCODES_MUX = 'conpty';
    const root = mkdtempSync(join(tmpdir(), 'imcodes-conpty-exe-'));
    tempDirs.push(root);
    const claudeExe = join(root, 'claude.exe');
    const codexExe = join(root, 'codex.exe');
    writeFileSync(claudeExe, 'MZ', 'utf8');
    writeFileSync(codexExe, 'MZ', 'utf8');

    const ccDriver = new ClaudeCodeDriver();
    const cxDriver = new CodexDriver();
    const trickyModel = `native "m" %TEMP% & 1`;

    await conptyNewSession('win-test-native', 'claude --ignored', {
      cwd: root,
      env: { PATH: root, PATHEXT: '.EXE;.CMD', TEMP: '/SHOULD_NOT_EXPAND' },
      winLaunch: ccDriver.buildWinLaunchSpec('win-test-native', { ccSessionId: 'cc-n1', requestedModel: trickyModel }),
    });
    const [exeFile, exeArgs] = spawnMock.mock.calls[0] as [string, string[]];
    expect(exeFile).toBe(claudeExe);
    expect(exeArgs[exeArgs.indexOf('--model') + 1]).toBe(trickyModel);

    await conptyRespawnPane('win-test-native', 'codex --ignored', {
      env: { PATH: root, PATHEXT: '.EXE;.CMD', TEMP: '/SHOULD_NOT_EXPAND' },
      winLaunch: cxDriver.buildWinResumeSpec('win-test-native', { codexSessionId: 'cx-n1', codexModel: trickyModel }),
    });
    const [cxExeFile, cxExeArgs] = spawnMock.mock.calls[1] as [string, string[]];
    expect(cxExeFile).toBe(codexExe);
    expect(cxExeArgs[cxExeArgs.indexOf('-m') + 1]).toBe(trickyModel);
  });

  it('keeps cmd.exe compatibility for unparseable batch wrappers when no user model is passed, and fails loudly when a model is passed', async () => {
    process.env.IMCODES_MUX = 'conpty';
    const root = mkdtempSync(join(tmpdir(), 'imcodes-conpty-batch-'));
    tempDirs.push(root);
    const batchPath = join(root, 'claude.cmd');
    writeFileSync(batchPath, '@echo off\r\ncustom-binary.exe %*\r\n', 'utf8');

    const ccDriver = new ClaudeCodeDriver();
    const cxDriver = new CodexDriver();

    // 1) No user model flag -> compatible cmd.exe /d /s /c path succeeds
    await conptyNewSession('win-test-batch', 'claude --ignored', {
      cwd: root,
      env: { PATH: root, PATHEXT: '.CMD' },
      winLaunch: ccDriver.buildWinLaunchSpec('win-test-batch', { ccSessionId: 'cc-b1' }),
    });
    const [cmdFile, cmdArgs] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmdFile).toMatch(/cmd\.exe$/i);
    expect(cmdArgs[0]).toBe('/d');
    expect(cmdArgs[1]).toBe('/s');
    expect(cmdArgs[2]).toBe('/c');

    // 2) Explicit user model flag against unparseable .cmd -> recoverable error without spawning cmd.exe
    const codexBatch = join(root, 'codex.bat');
    writeFileSync(codexBatch, '@echo off\r\ncustom-codex.exe %*\r\n', 'utf8');
    await expect(
      conptyNewSession('win-test-batch-fail', 'codex --ignored', {
        cwd: root,
        env: { PATH: root, PATHEXT: '.BAT;.CMD' },
        winLaunch: cxDriver.buildWinLaunchSpec('win-test-batch-fail', {
          fresh: true,
          codexModel: `m'2 "q" %TEMP%`,
        }),
      }),
    ).rejects.toThrow(/Cannot safely forward model/i);
    expect(conptyIsPaneAlive('win-test-batch-fail')).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // 3) Same on Claude resume path — live running session MUST stay alive when rejected!
    await expect(
      conptyRespawnPane('win-test-batch', 'claude --ignored', {
        env: { PATH: root, PATHEXT: '.CMD' },
        winLaunch: ccDriver.buildWinResumeSpec('win-test-batch', {
          ccSessionId: 'cc-b1',
          requestedModel: `m %TEMP%`,
        }),
      }),
    ).rejects.toThrow(/Cannot safely forward model/i);
    expect(conptyIsPaneAlive('win-test-batch')).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('handles case-insensitive Windows env keys (Path/Pathext/AppData/UserProfile/LocalAppData/ProgramFiles) across path resolution and conpty spawn', async () => {
    process.env.IMCODES_MUX = 'conpty';
    const ccDual = createFakeNpmDualShims('claude');
    const staleAppData = createFakeNpmDualShims('claude');
    const customNodeDir = mkdtempSync(join(tmpdir(), 'imcodes-custom-node-'));
    tempDirs.push(customNodeDir);
    const localProgramsDir = join(customNodeDir, 'Programs', 'Claude');
    mkdirSync(localProgramsDir, { recursive: true });
    const localClaudeExe = join(localProgramsDir, 'claude.exe');
    writeFileSync(localClaudeExe, 'MZ', 'utf8');

    const ccDriver = new ClaudeCodeDriver();
    const spec = ccDriver.buildWinLaunchSpec('win-test-cc', {
      ccSessionId: 'cc-case-1',
      requestedModel: 'claude-sonnet-4',
    });

    // 1) Mixed-case Path + Pathext + IMCODES_NODE_BIN resolves when binary only lives on Path, beating AppData\npm
    const directPlan = resolveWindowsExecutableForConpty(
      spec.primary,
      {
        Path: ccDual.npmDir,
        Pathext: '.cmd',
        AppData: staleAppData.appDataDir,
        IMCODES_NODE_BIN: process.execPath,
      },
      'win32',
    );
    expect(directPlan).toEqual({
      kind: 'direct',
      file: process.execPath,
      args: [ccDual.shimJs, ...spec.primary.args],
    });

    // 2) Mixed-case AppData / UserProfile / LocalAppData fallback candidates when Path is absent
    expect(getWindowsClaudeInstallCandidates('claude', { LocalAppData: customNodeDir })).toContain(localClaudeExe);
    const appDataPlan = resolveWindowsExecutableForConpty(
      spec.primary,
      { Path: '', AppData: ccDual.appDataDir, Pathext: '.cmd' },
      'win32',
    );
    expect(appDataPlan).toEqual({
      kind: 'direct',
      file: process.execPath,
      args: [ccDual.shimJs, ...spec.primary.args],
    });

    // 3) conptyNewSession overrides inherited uppercase process.env.PATH when caller passes lowercase/mixed-case Path
    await conptyNewSession('win-test-cc', 'claude --ignored', {
      cwd: ccDual.npmDir,
      env: { Path: ccDual.npmDir, Pathext: '.cmd', AppData: staleAppData.appDataDir },
      winLaunch: spec,
    });
    const [spawnFile, spawnArgs, spawnOpts] = spawnMock.mock.calls.at(-1) as [string, string[], { env: Record<string, string> }];
    expect(spawnFile).toBe(process.execPath);
    expect(spawnArgs[0]).toBe(ccDual.shimJs);
    expect(spawnOpts.env.Path).toContain(ccDual.npmDir);
    expect(spawnOpts.env).not.toHaveProperty('PATH');
  });
});
