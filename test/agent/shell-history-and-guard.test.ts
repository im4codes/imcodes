import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

import {
  cleanupShellHistoryFile,
  resolveShellHistoryDir,
  resolveShellHistoryFilePath,
  sanitizeShellHistorySessionName,
  shellHistoryEnv,
} from '../../src/agent/shell-history.js';
import { ProcessSessionRuntime } from '../../src/agent/process-session-runtime.js';
import { launchSession, respawnSession, stopProject } from '../../src/agent/session-manager.js';

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

  it('resolves distinct, path-confined HISTFILE paths only for POSIX shell sessions', () => {
    const dir = resolveShellHistoryDir();
    expect(dir).toBe(join(stateDir, 'shell-history'));

    const env1 = shellHistoryEnv('deck_sub_sh1', 'shell');
    const env2 = shellHistoryEnv('deck_sub_sh2', 'shell');
    expect(env1.HISTFILE).toBe(join(dir, 'deck_sub_sh1.history'));
    expect(env2.HISTFILE).toBe(join(dir, 'deck_sub_sh2.history'));
    expect(env1.HISTFILE).not.toBe(env2.HISTFILE);
    expect(existsSync(dir)).toBe(true);

    // Repeating for the same session yields the exact same file path across restarts
    expect(shellHistoryEnv('deck_sub_sh1', 'shell').HISTFILE).toBe(env1.HISTFILE);

    // Non-shell and Windows native shells receive no HISTFILE override
    expect(shellHistoryEnv('deck_proj_brain', 'claude-code')).toEqual({});
    expect(shellHistoryEnv('deck_sub_codex', 'codex')).toEqual({});
    expect(shellHistoryEnv('deck_sub_oc', 'opencode')).toEqual({});
    expect(shellHistoryEnv('deck_sub_script', 'script')).toEqual({});
    expect(shellHistoryEnv('deck_sub_pwsh', 'shell', 'powershell.exe')).toEqual({});
    expect(shellHistoryEnv('deck_sub_pwsh7', 'shell', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toEqual({});
    expect(shellHistoryEnv('deck_sub_cmd', 'shell', 'cmd.exe')).toEqual({});
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

  it('cleanupShellHistoryFile removes only the targeted session file and tolerates ENOENT', () => {
    const env1 = shellHistoryEnv('deck_sub_sh1', 'shell');
    const env2 = shellHistoryEnv('deck_sub_sh2', 'shell');
    writeFileSync(env1.HISTFILE, 'ls -la\n', 'utf8');
    writeFileSync(env2.HISTFILE, 'pwd\n', 'utf8');

    cleanupShellHistoryFile('deck_sub_sh1');
    expect(existsSync(env1.HISTFILE)).toBe(false);
    expect(existsSync(env2.HISTFILE)).toBe(true);
    expect(readFileSync(env2.HISTFILE, 'utf8')).toBe('pwd\n');

    // Safe on missing files
    expect(() => cleanupShellHistoryFile('deck_sub_nonexistent')).not.toThrow();
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

  it('launchSession & respawnSession never inject identity prompts for shell/script and preserve isolated HISTFILE', async () => {
    const projectDir = join(stateDir, 'proj');
    mkdirSync(projectDir, { recursive: true });

    await launchSession({
      name: 'deck_proj_sh1',
      projectName: 'proj',
      role: 'w1',
      agentType: 'shell',
      projectDir,
      description: 'Agent-style description that must never enter shell',
      identityPrompt: 'Identity contract line\n'.repeat(20),
    });
    await new Promise((r) => setTimeout(r, 20));

    const expectedHist = join(stateDir, 'shell-history', 'deck_proj_sh1.history');
    expect(tmuxMocks.newSession).toHaveBeenCalledWith(
      'deck_proj_sh1',
      expect.any(String),
      expect.objectContaining({
        env: expect.objectContaining({ HISTFILE: expectedHist }),
      }),
    );
    expect(tmuxMocks.sendKeys).not.toHaveBeenCalled();

    // Persist history content, then respawn: HISTFILE is preserved and no identity/context prompt is injected
    writeFileSync(expectedHist, 'echo first-run\n', 'utf8');
    const stored = storeMocks.records.get('deck_proj_sh1');
    expect(stored).toBeTruthy();
    expect(stored.appliedIdentityHash).toBeUndefined();

    await respawnSession(stored);
    await new Promise((r) => setTimeout(r, 20));

    expect(tmuxMocks.respawnPane).toHaveBeenCalledWith(
      'deck_proj_sh1',
      expect.stringContaining(`export HISTFILE='${expectedHist}'`),
    );
    expect(tmuxMocks.sendKeys).not.toHaveBeenCalled();
    expect(identityResolverMock.resolveEffectiveIdentityPrompt).not.toHaveBeenCalled();
    expect(readFileSync(expectedHist, 'utf8')).toBe('echo first-run\n');

    // Non-shell session keeps existing behavior: no HISTFILE, identity still injected on launch
    tmuxMocks.capturePane.mockResolvedValue(['❯ ']);
    await launchSession({
      name: 'deck_proj_brain',
      projectName: 'proj',
      role: 'brain',
      agentType: 'claude-code',
      projectDir,
    });

    const ccEnv = (tmuxMocks.newSession.mock.calls[1] as any)?.[2]?.env;
    expect(ccEnv?.HISTFILE).toBeUndefined();
    await vi.waitFor(() => {
      expect(identityResolverMock.resolveEffectiveIdentityPrompt).toHaveBeenCalledTimes(1);
      expect(tmuxMocks.sendKeys).toHaveBeenCalledWith(
        'deck_proj_brain',
        expect.stringContaining('[Context — absorb silently, do not respond to this message]'),
      );
    }, { timeout: 3000 });

    // Permanent teardown via stopProject removes isolated shell history
    tmuxMocks.sessionExists.mockResolvedValue(false);
    await stopProject('proj');
    expect(existsSync(expectedHist)).toBe(false);
  });

  it('respawnSession for script also skips identity prompt and sets no HISTFILE', async () => {
    const projectDir = join(stateDir, 'proj2');
    mkdirSync(projectDir, { recursive: true });
    storeMocks.records.set('deck_proj2_w1', {
      name: 'deck_proj2_w1',
      projectName: 'proj2',
      role: 'w1',
      agentType: 'script',
      projectDir,
      state: 'idle',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      description: 'Do not inject into script pane',
    });

    await respawnSession(storeMocks.records.get('deck_proj2_w1'));
    await new Promise((r) => setTimeout(r, 20));

    expect(identityResolverMock.resolveEffectiveIdentityPrompt).not.toHaveBeenCalled();
    expect(tmuxMocks.sendKeys).not.toHaveBeenCalled();
    expect(tmuxMocks.respawnPane).toHaveBeenCalledWith(
      'deck_proj2_w1',
      expect.not.stringContaining('HISTFILE='),
    );
  });
});
