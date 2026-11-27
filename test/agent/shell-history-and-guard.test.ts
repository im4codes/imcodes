import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmuxMocks = vi.hoisted(() => ({
  newSession: vi.fn(async () => {}),
  killSession: vi.fn(async () => {}),
  sessionExists: vi.fn(async () => false),
  isPaneAlive: vi.fn(async () => true),
  respawnPane: vi.fn(async () => {}),
  listSessions: vi.fn(async () => []),
  sendKeys: vi.fn(async () => {}),
  sendKey: vi.fn(async () => {}),
  capturePane: vi.fn(async () => []),
  showBuffer: vi.fn(async () => ''),
  getPaneId: vi.fn(async () => '%1'),
  getPaneCwd: vi.fn(async () => '/tmp'),
  getPaneStartCommand: vi.fn(async () => 'bash'),
  cleanupOrphanFifos: vi.fn(async () => {}),
}));

const storeMocks = vi.hoisted(() => {
  const records = new Map<string, any>();
  return {
    records,
    getSession: vi.fn((name: string) => records.get(name) ?? null),
    upsertSession: vi.fn((rec: any) => { records.set(rec.name, rec); }),
    removeSession: vi.fn((name: string) => { records.delete(name); }),
    listSessions: vi.fn(() => [...records.values()]),
    updateSessionState: vi.fn(),
  };
});

const identityResolverMock = vi.hoisted(() => ({
  resolveEffectiveIdentityPrompt: vi.fn(async () => 'X'.repeat(320) + '\nUser contract rule'),
}));

const commandHandlerMocks = vi.hoisted(() => ({
  privateWrite: vi.fn(),
  prepareProcessSessionPrivateWriter: vi.fn(async () => commandHandlerMocks.privateWrite),
  runWithProcessSessionSendLock: vi.fn(async (_name: string, fn: () => Promise<any>) => fn()),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  BACKEND: 'tmux',
  ...tmuxMocks,
}));

vi.mock('../../src/store/session-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/store/session-store.js')>();
  return {
    ...actual,
    getSession: storeMocks.getSession,
    upsertSession: storeMocks.upsertSession,
    removeSession: storeMocks.removeSession,
    listSessions: storeMocks.listSessions,
    updateSessionState: storeMocks.updateSessionState,
  };
});

vi.mock('../../src/daemon/session-identity-resolver.js', () => identityResolverMock);

vi.mock('../../src/daemon/command-handler.js', () => ({
  prepareProcessSessionPrivateWriter: commandHandlerMocks.prepareProcessSessionPrivateWriter,
  runWithProcessSessionSendLock: commandHandlerMocks.runWithProcessSessionSendLock,
}));

vi.mock('../../src/daemon/terminal-streamer.js', () => ({
  terminalStreamer: {
    rebindSession: vi.fn(async () => {}),
    stopSession: vi.fn(),
  },
}));

vi.mock('../../src/daemon/session-resource-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/daemon/session-resource-service.js')>();
  return {
    ...actual,
    registerTmuxSessionResource: vi.fn(async () => {}),
    releaseSessionResources: vi.fn(async () => ({ released: 0, failed: 0 })),
    releaseSessionChildResources: vi.fn(async () => ({ released: 0, failed: 0 })),
  };
});

vi.mock('../../src/daemon/cross-vendor-handoff.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/daemon/cross-vendor-handoff.js')>();
  return {
    ...actual,
    buildCrossVendorHandoffPack: vi.fn(async () => ({
      text: 'HANDOFF_PACK_CONTENT',
      sourceAgentType: 'claude-code',
      sourceRuntimeType: 'process',
      cutoff: { epoch: 1, seq: 2, ts: 1000 },
      createdAt: 1000,
      tokenCount: 10,
    })),
  };
});

import {
  cleanupShellHistoryFile,
  isShellLikeAgentType,
  resolveShellBin,
  resolveShellHistoryDir,
  resolveShellHistoryFilePath,
  sanitizeShellHistorySessionName,
  shellHistoryEnv,
} from '../../src/agent/shell-history.js';
import { ShellDriver } from '../../src/agent/drivers/shell.js';
import { ProcessSessionRuntime } from '../../src/agent/process-session-runtime.js';
import {
  launchSession,
  relaunchSessionWithSettings,
  respawnSession,
  restartSession,
  stopProject,
} from '../../src/agent/session-manager.js';

describe('shell history isolation & prompt-injection guard', () => {
  let stateDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    storeMocks.records.clear();
    tmuxMocks.sessionExists.mockResolvedValue(false);
    stateDir = mkdtempSync(join(tmpdir(), 'imcodes-shell-hist-'));
    vi.stubEnv('IMCODES_HOME', stateDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('resolves distinct, path-confined HISTFILE paths only for POSIX shell sessions and shares resolveShellBin with ShellDriver', () => {
    const dir = resolveShellHistoryDir();
    expect(dir).toBe(join(stateDir, 'shell-history'));

    const env1 = shellHistoryEnv('deck_sub_sh1', 'shell', '/bin/bash');
    const env2 = shellHistoryEnv('deck_sub_sh2', 'shell', '/bin/bash');
    expect(env1.HISTFILE).toBe(join(dir, 'deck_sub_sh1.history'));
    expect(env1.IMCODES_SHELL_HISTFILE).toBe(join(dir, 'deck_sub_sh1.history'));
    expect(env2.HISTFILE).toBe(join(dir, 'deck_sub_sh2.history'));
    expect(env1.HISTFILE).not.toBe(env2.HISTFILE);
    expect(existsSync(join(dir, 'bash-rc.sh'))).toBe(true);

    // Repeating for the same session yields the exact same file path across restarts
    expect(shellHistoryEnv('deck_sub_sh1', 'shell', '/bin/bash').HISTFILE).toBe(env1.HISTFILE);

    // Zsh gets isolated ZDOTDIR wrapper preserving IMCODES_ORIG_ZDOTDIR
    vi.stubEnv('ZDOTDIR', '/tmp/custom-zdotdir');
    const zshEnv = shellHistoryEnv('deck_sub_zsh1', 'shell', '/bin/zsh');
    expect(zshEnv.HISTFILE).toBe(join(dir, 'deck_sub_zsh1.history'));
    expect(zshEnv.IMCODES_SHELL_HISTFILE).toBe(zshEnv.HISTFILE);
    expect(zshEnv.ZDOTDIR).toBe(join(dir, 'zdotdir'));
    expect(zshEnv.IMCODES_ORIG_ZDOTDIR).toBe('/tmp/custom-zdotdir');
    expect(existsSync(join(dir, 'zdotdir', '.zshrc'))).toBe(true);

    // Shared resolveShellBin on Windows picks process.env.SHELL POSIX shells too
    const origPlatform = process.platform;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      vi.stubEnv('SHELL', 'C:\\Program Files\\Git\\bin\\bash.exe');
      expect(resolveShellBin()).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
      const winPosix = shellHistoryEnv('deck_sub_win_bash', 'shell');
      expect(winPosix.HISTFILE).toBe(join(dir, 'deck_sub_win_bash.history'));

      // Native Windows shells keep {}
      vi.stubEnv('SHELL', '');
      vi.stubEnv('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
      expect(shellHistoryEnv('deck_sub_cmd_default', 'shell')).toEqual({});
      expect(shellHistoryEnv('deck_sub_pwsh', 'shell', 'powershell.exe')).toEqual({});
      expect(shellHistoryEnv('deck_sub_pwsh7', 'shell', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toEqual({});
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }

    // Non-shell agent sessions receive no HISTFILE override
    expect(shellHistoryEnv('deck_proj_brain', 'claude-code')).toEqual({});
    expect(shellHistoryEnv('deck_sub_codex', 'codex')).toEqual({});
    expect(shellHistoryEnv('deck_sub_oc', 'opencode')).toEqual({});
    expect(shellHistoryEnv('deck_sub_script', 'script')).toEqual({});
    expect(isShellLikeAgentType('shell')).toBe(true);
    expect(isShellLikeAgentType('script')).toBe(true);
    expect(isShellLikeAgentType('claude-code')).toBe(false);
  });

  it('sanitizes traversal and unusual session names without collisions', () => {
    const dir = resolve(resolveShellHistoryDir());
    const weirdNames = ['../../.ssh/authorized_keys', '..', '.', 'foo/bar', 'foo..bar', '中文 session!'];
    const paths = weirdNames.map((name) => resolveShellHistoryFilePath(name)!);

    for (const target of paths) {
      expect(target).toBeTruthy();
      const rel = relative(dir, target);
      expect(rel.startsWith('..')).toBe(false);
      expect(rel.includes('/')).toBe(false);
      expect(rel.includes('\\')).toBe(false);
      expect(basename(target).startsWith('.')).toBe(false);
    }
    expect(new Set(paths).size).toBe(weirdNames.length);
    expect(resolveShellHistoryFilePath('')).toBeUndefined();
    expect(resolveShellHistoryFilePath('   ')).toBeUndefined();
    expect(sanitizeShellHistorySessionName('../../etc/passwd')).not.toContain('..');
  });

  it('cleanupShellHistoryFile removes only target file, tolerates ENOENT and non-ENOENT I/O errors cleanly during stopProject', async () => {
    const env1 = shellHistoryEnv('deck_proj_sh1', 'shell', '/bin/bash');
    const env2 = shellHistoryEnv('deck_other_sh2', 'shell', '/bin/bash');
    writeFileSync(env1.HISTFILE, 'ls -la\n', 'utf8');
    writeFileSync(env2.HISTFILE, 'pwd\n', 'utf8');

    cleanupShellHistoryFile('deck_proj_sh1');
    expect(existsSync(env1.HISTFILE)).toBe(false);
    expect(existsSync(env2.HISTFILE)).toBe(true);
    expect(readFileSync(env2.HISTFILE, 'utf8')).toBe('pwd\n');

    // Missing file is a no-op
    expect(() => cleanupShellHistoryFile('deck_sub_nonexistent')).not.toThrow();

    // Non-ENOENT error (EISDIR at history file path) logs warning and must NOT break stopProject / removeSession
    mkdirSync(env1.HISTFILE);
    storeMocks.records.set('deck_proj_sh1', {
      name: 'deck_proj_sh1',
      projectName: 'proj',
      role: 'w1',
      agentType: 'shell',
      projectDir: stateDir,
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const stopRes = await stopProject('proj');
    expect(stopRes.ok).toBe(true);
    expect(stopRes.failed).toEqual([]);
    expect(storeMocks.records.has('deck_proj_sh1')).toBe(false);
    expect(readFileSync(env2.HISTFILE, 'utf8')).toBe('pwd\n');
  });

  it('ProcessSessionRuntime sends verbatim:true for shell/script and preserves default for agent sessions', async () => {
    const longCmd = 'echo ' + 'a'.repeat(250);
    const shellRt = new ProcessSessionRuntime('deck_sub_sh1', 'shell');
    const scriptRt = new ProcessSessionRuntime('deck_sub_sc1', 'script');
    const claudeRt = new ProcessSessionRuntime('deck_proj_w1', 'claude-code');

    await shellRt.send(longCmd);
    await scriptRt.send(longCmd);
    await claudeRt.send('hello');

    expect(tmuxMocks.sendKeys).toHaveBeenNthCalledWith(1, 'deck_sub_sh1', longCmd, { verbatim: true });
    expect(tmuxMocks.sendKeys).toHaveBeenNthCalledWith(2, 'deck_sub_sc1', longCmd, { verbatim: true });
    expect(tmuxMocks.sendKeys).toHaveBeenNthCalledWith(3, 'deck_proj_w1', 'hello');
  });

  it('launchSession persists shellBin, restartSession/respawnSession preserve shellBin & isolated HISTFILE, and pending/cross-vendor handoff never injects into shell/script', async () => {
    const projectDir = join(stateDir, 'proj');
    mkdirSync(projectDir, { recursive: true });

    // Pre-existing pending cross-vendor handoff on a session later launched as shell MUST NOT be injected
    storeMocks.records.set('deck_proj_sh1', {
      name: 'deck_proj_sh1',
      projectName: 'proj',
      role: 'w1',
      agentType: 'claude-code',
      projectDir,
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      crossVendorHandoff: {
        pending: {
          text: 'DO_NOT_INJECT_PENDING_HANDOFF',
          sourceAgentType: 'claude-code',
          sourceRuntimeType: 'process',
          cutoff: { epoch: 1, seq: 1, ts: 100 },
          createdAt: 100,
          tokenCount: 5,
        },
      },
    });

    await launchSession({
      name: 'deck_proj_sh1',
      projectName: 'proj',
      role: 'w1',
      agentType: 'shell',
      projectDir,
      shellBin: '/bin/zsh',
      description: 'Agent-style description that must never enter shell',
      identityPrompt: 'Identity contract line\n'.repeat(20),
    });
    await new Promise((r) => setTimeout(r, 30));

    const expectedHist = join(stateDir, 'shell-history', 'deck_proj_sh1.history');
    expect(tmuxMocks.newSession).toHaveBeenCalledWith(
      'deck_proj_sh1',
      expect.stringContaining('/bin/zsh'),
      expect.objectContaining({
        env: expect.objectContaining({ HISTFILE: expectedHist, ZDOTDIR: join(stateDir, 'shell-history', 'zdotdir') }),
      }),
    );
    expect(tmuxMocks.sendKeys).not.toHaveBeenCalled();
    expect(commandHandlerMocks.prepareProcessSessionPrivateWriter).not.toHaveBeenCalled();
    expect(commandHandlerMocks.privateWrite).not.toHaveBeenCalled();

    const stored = storeMocks.records.get('deck_proj_sh1');
    expect(stored?.shellBin).toBe('/bin/zsh');
    expect(stored?.appliedIdentityHash).toBeUndefined();
    expect(stored?.crossVendorHandoff?.pending).toBeUndefined();

    // restartSession forwards persisted shellBin & isolated HISTFILE without injecting context
    await restartSession(stored);
    await new Promise((r) => setTimeout(r, 20));
    expect(tmuxMocks.newSession.mock.calls[1]?.[1]).toContain('/bin/zsh');
    expect((tmuxMocks.newSession.mock.calls[1] as any)?.[2]?.env?.HISTFILE).toBe(expectedHist);
    expect(tmuxMocks.sendKeys).not.toHaveBeenCalled();

    // respawnSession preserves shellBin & HISTFILE and never calls identity resolver
    writeFileSync(expectedHist, 'echo first-run\n', 'utf8');
    await respawnSession(storeMocks.records.get('deck_proj_sh1'));
    await new Promise((r) => setTimeout(r, 20));
    expect(tmuxMocks.respawnPane).toHaveBeenCalledWith(
      'deck_proj_sh1',
      expect.stringContaining(`export HISTFILE='${expectedHist}'`),
    );
    expect(tmuxMocks.respawnPane.mock.calls[0]?.[1]).toContain('/bin/zsh');
    expect(tmuxMocks.sendKeys).not.toHaveBeenCalled();
    expect(identityResolverMock.resolveEffectiveIdentityPrompt).not.toHaveBeenCalled();
    expect(readFileSync(expectedHist, 'utf8')).toBe('echo first-run\n');

    // relaunchSessionWithSettings switching FROM claude-code TO shell (even with handoff:true) MUST NOT build or inject handoff
    storeMocks.records.set('deck_switch_proj_w1', {
      name: 'deck_switch_proj_w1',
      projectName: 'switch_proj',
      role: 'w1',
      agentType: 'claude-code',
      projectDir,
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      crossVendorHandoff: {
        pending: {
          text: 'STALE_PENDING',
          sourceAgentType: 'claude-code',
          sourceRuntimeType: 'process',
          cutoff: { epoch: 1, seq: 1, ts: 100 },
          createdAt: 100,
          tokenCount: 4,
        },
      },
    });
    await relaunchSessionWithSettings(storeMocks.records.get('deck_switch_proj_w1'), {
      agentType: 'shell',
      handoff: true,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(commandHandlerMocks.prepareProcessSessionPrivateWriter).not.toHaveBeenCalled();
    expect(commandHandlerMocks.privateWrite).not.toHaveBeenCalled();
    expect(storeMocks.records.get('deck_switch_proj_w1')?.crossVendorHandoff?.pending).toBeUndefined();

    // Positive control: claude-code -> codex relaunch still delivers handoff via private writer,
    // and launching claude-code still injects [Context — absorb silently...]
    storeMocks.records.set('deck_cc_to_codex_w1', {
      name: 'deck_cc_to_codex_w1',
      projectName: 'cc_to_codex',
      role: 'w1',
      agentType: 'claude-code',
      projectDir,
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    tmuxMocks.capturePane.mockResolvedValue(['❯ ']);
    await relaunchSessionWithSettings(storeMocks.records.get('deck_cc_to_codex_w1'), {
      agentType: 'codex',
      handoff: true,
    });
    await vi.waitFor(() => {
      expect(commandHandlerMocks.prepareProcessSessionPrivateWriter).toHaveBeenCalledWith('deck_cc_to_codex_w1');
      expect(commandHandlerMocks.privateWrite).toHaveBeenCalledWith('HANDOFF_PACK_CONTENT');
      expect(identityResolverMock.resolveEffectiveIdentityPrompt).toHaveBeenCalled();
    }, { timeout: 3000 });
  });

  it('real interactive bash with synthetic .bashrc resetting HISTFILE keeps sh1/sh2/shared completely isolated', () => {
    const fakeHome = join(stateDir, 'fake-home');
    mkdirSync(fakeHome, { recursive: true });
    const sharedHist = join(fakeHome, '.bash_history');
    writeFileSync(sharedHist, 'echo SHARED_UNTOUCHED\n', 'utf8');
    // Hostile .bashrc tries to force HISTFILE back to shared ~/.bash_history and exports a marker proving RC loaded
    writeFileSync(join(fakeHome, '.bashrc'), `export HISTFILE="${sharedHist}"\nexport RC_LOADED_MARKER=yes\n`, 'utf8');

    const driver = new ShellDriver();
    const cmd1 = driver.buildLaunchCommand('deck_sub_real1', { shellBin: '/bin/bash' });
    const cmd2 = driver.buildLaunchCommand('deck_sub_real2', { shellBin: '/bin/bash' });
    const env1 = shellHistoryEnv('deck_sub_real1', 'shell', '/bin/bash');
    const env2 = shellHistoryEnv('deck_sub_real2', 'shell', '/bin/bash');

    const runInteractiveBash = (launchCmd: string, extraEnv: Record<string, string>, scriptInput: string) => {
      const py = [
        'import os, pty, select, subprocess, sys, time',
        'cmd, script_in = sys.argv[1], sys.argv[2]',
        'm, s = pty.openpty()',
        'p = subprocess.Popen(["/bin/sh", "-c", f"{cmd} -i"], stdin=s, stdout=s, stderr=s, close_fds=True)',
        'os.close(s)',
        'time.sleep(0.25)',
        'os.write(m, script_in.encode())',
        'out = bytearray()',
        'deadline = time.time() + 5.0',
        'while p.poll() is None and time.time() < deadline:',
        '    r, _, _ = select.select([m], [], [], 0.05)',
        '    if r:',
        '        try:',
        '            chunk = os.read(m, 4096)',
        '            if chunk: out.extend(chunk)',
        '        except OSError: break',
        'p.wait(timeout=5)',
        'while True:',
        '    try:',
        '        chunk = os.read(m, 4096)',
        '        if not chunk: break',
        '        out.extend(chunk)',
        '    except OSError: break',
        'os.close(m)',
        'sys.stdout.write(out.decode(errors="replace"))',
      ].join('\n');
      const res = spawnSync('python3', ['-c', py, launchCmd, scriptInput], {
        env: { ...process.env, HOME: fakeHome, ...extraEnv },
        encoding: 'utf8',
      });
      expect(res.status).toBe(0);
      return res.stdout;
    };

    const out1 = runInteractiveBash(cmd1, env1, 'echo RC=$RC_LOADED_MARKER\necho ONLY_IN_SH1_TOKEN\nexit\n');
    const out2 = runInteractiveBash(cmd2, env2, 'history\necho ONLY_IN_SH2_TOKEN\nexit\n');
    const out1Restart = runInteractiveBash(cmd1, env1, 'history\nexit\n');

    expect(out1).toContain('RC=yes');
    expect(out2).not.toContain('SHARED_UNTOUCHED');
    expect(out2).not.toContain('ONLY_IN_SH1_TOKEN');
    expect(out1Restart).toContain('ONLY_IN_SH1_TOKEN');
    expect(out1Restart).not.toContain('SHARED_UNTOUCHED');
    expect(out1Restart).not.toContain('ONLY_IN_SH2_TOKEN');
    expect(readFileSync(sharedHist, 'utf8')).toBe('echo SHARED_UNTOUCHED\n');
    expect(readFileSync(env1.HISTFILE, 'utf8')).toContain('ONLY_IN_SH1_TOKEN');
    expect(readFileSync(env1.HISTFILE, 'utf8')).not.toContain('ONLY_IN_SH2_TOKEN');
    expect(readFileSync(env2.HISTFILE, 'utf8')).toContain('ONLY_IN_SH2_TOKEN');
    expect(readFileSync(env2.HISTFILE, 'utf8')).not.toContain('ONLY_IN_SH1_TOKEN');
  });
});
