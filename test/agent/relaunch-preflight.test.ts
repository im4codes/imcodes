import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { spawnMock, mockPty } = vi.hoisted(() => {
  const pty = {
    pid: 9191,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
  };
  return {
    mockPty: pty,
    spawnMock: vi.fn(() => pty),
  };
});

const { homeDirRef } = vi.hoisted(() => ({ homeDirRef: { dir: '' } }));
const { resolveIdentityHook } = vi.hoisted(() => ({
  resolveIdentityHook: { fn: null as null | (() => Promise<void>) },
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => homeDirRef.dir || actual.homedir(),
  };
});

vi.mock('node-pty', () => ({
  spawn: spawnMock,
}));

vi.mock('../../src/agent/signal.js', () => ({
  setupCCStopHook: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/daemon/session-identity-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/daemon/session-identity-resolver.js')>();
  return {
    ...actual,
    resolveEffectiveIdentityPrompt: vi.fn(async () => {
      if (resolveIdentityHook.fn) await resolveIdentityHook.fn();
      return undefined;
    }),
  };
});
vi.mock('../../src/agent/notify-setup.js', () => ({
  setupCodexNotify: vi.fn().mockResolvedValue(undefined),
  setupOpenCodePlugin: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/daemon/jsonl-watcher.js', () => ({
  startWatching: vi.fn().mockResolvedValue(undefined),
  startWatchingFile: vi.fn().mockResolvedValue(undefined),
  stopWatching: vi.fn(),
  isWatching: vi.fn(() => false),
  findJsonlPathBySessionId: vi.fn().mockResolvedValue(null),
  reserveSessionFile: vi.fn(),
  reassignSessionFile: vi.fn(),
}));
vi.mock('../../src/agent/detect.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/detect.js')>();
  return {
    ...actual,
    getAgentVersion: vi.fn().mockResolvedValue('2.0.0'),
  };
});

process.env.IMCODES_MUX = 'conpty';
process.env.IMCODES_TEST = '1';

describe('Windows ConPTY preflight before session teardown', () => {
  const tempDirs: string[] = [];
  let origPath: string | undefined;
  let origPathExt: string | undefined;

  beforeEach(() => {
    origPath = process.env.PATH;
    origPathExt = process.env.PATHEXT;
    homeDirRef.dir = mkdtempSync(join(tmpdir(), 'imcodes-relaunch-home-'));
    tempDirs.push(homeDirRef.dir);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    resolveIdentityHook.fn = null;
    const { invalidateCache } = await import('../../src/daemon/cc-presets.js');
    invalidateCache();
    const { conptyKillSession, conptyListSessions } = await import('../../src/agent/conpty.js');
    for (const name of conptyListSessions()) {
      await conptyKillSession(name).catch(() => {});
    }
    if (origPath === undefined) delete process.env.PATH;
    else process.env.PATH = origPath;
    if (origPathExt === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = origPathExt;
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unparseable batch-wrapper model switches in relaunchSessionWithSettings and respawnSession without stopping the running session', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'imcodes-win-batch-bin-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'imcodes-win-batch-proj-'));
    tempDirs.push(binDir, projectDir);
    writeFileSync(join(binDir, 'claude.cmd'), '@echo off\r\ncustom-claude.exe %*\r\n', 'utf8');
    process.env.PATH = binDir;
    process.env.PATHEXT = '.CMD';

    const { launchSession, relaunchSessionWithSettings, respawnSession } = await import('../../src/agent/session-manager.js');
    const { conptyIsPaneAlive } = await import('../../src/agent/conpty.js');
    const { getSession } = await import('../../src/store/session-store.js');

    const sessionName = 'deck_sub_winlivebatch';
    await launchSession({
      name: sessionName,
      projectName: 'proj',
      role: 'w1',
      agentType: 'claude-code',
      projectDir,
      ccSessionId: '11111111-1111-4111-8111-111111111111',
    });

    expect(conptyIsPaneAlive(sessionName)).toBe(true);
    const liveBefore = getSession(sessionName);
    expect(liveBefore).not.toBeNull();
    expect(liveBefore?.requestedModel ?? null).toBeNull();
    const spawnCallsBefore = spawnMock.mock.calls.length;

    await expect(
      relaunchSessionWithSettings(liveBefore!, {
        agentType: 'claude-code',
        requestedModel: 'm %TEMP%',
        ccPreset: null,
      }),
    ).rejects.toThrow(/Cannot safely forward model/i);

    expect(conptyIsPaneAlive(sessionName)).toBe(true);
    expect(mockPty.kill).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(spawnCallsBefore);
    expect(getSession(sessionName)?.requestedModel ?? null).toBeNull();
    expect(getSession(sessionName)?.state).toBe('idle');

    // Same preflight protection on process respawnSession
    await expect(
      respawnSession({
        ...liveBefore!,
        requestedModel: 'm %TEMP%',
      }),
    ).rejects.toThrow(/Cannot safely forward model/i);
    expect(conptyIsPaneAlive(sessionName)).toBe(true);
    expect(mockPty.kill).not.toHaveBeenCalled();
  });

  it('binds preflight-validated preset snapshot and resolved Windows launch target across post-preflight mutation, and aborts cleanly on deadline before teardown', async () => {
    const { mkdirSync } = await import('node:fs');
    const binDir = mkdtempSync(join(tmpdir(), 'imcodes-win-snapshot-bin-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'imcodes-win-snapshot-proj-'));
    tempDirs.push(binDir, projectDir);
    const pkgDir = join(binDir, 'node_modules', 'probe');
    mkdirSync(pkgDir, { recursive: true });
    const shimJs = join(pkgDir, 'cli.js');
    writeFileSync(shimJs, 'console.log("ok");\n', 'utf8');
    const claudeCmd = join(binDir, 'claude.cmd');
    writeFileSync(claudeCmd, '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\probe\\cli.js" %*\r\n', 'utf8');
    process.env.PATH = binDir;
    process.env.PATHEXT = '.CMD';
    process.env.IMCODES_HOME = homeDirRef.dir;

    const { invalidateCache, savePresets } = await import('../../src/daemon/cc-presets.js');
    invalidateCache();
    await savePresets([
      {
        name: 'PresetSnap',
        env: {
          ANTHROPIC_BASE_URL: 'https://preflight-snapshot.example/anthropic',
          ANTHROPIC_API_KEY: 'sk-snapshot',
          ANTHROPIC_MODEL: 'm-snap',
        },
        defaultModel: 'm-snap',
        availableModels: [{ id: 'm-snap' }],
        contextWindow: 256_000,
      },
    ]);

    const { launchSession, relaunchSessionWithSettings, RestartBeforeStartTimeoutError } = await import('../../src/agent/session-manager.js');
    const { conptyIsPaneAlive } = await import('../../src/agent/conpty.js');
    const { getSession } = await import('../../src/store/session-store.js');

    const sessionName = 'deck_sub_winsnap';
    await launchSession({
      name: sessionName,
      projectName: 'proj',
      role: 'w1',
      agentType: 'claude-code',
      projectDir,
      ccSessionId: '22222222-2222-4222-8222-222222222222',
    });
    expect(conptyIsPaneAlive(sessionName)).toBe(true);

    // 1) If deadline expires between preflight and teardown, abort without stopping live PTY
    resolveIdentityHook.fn = async () => {
      await new Promise((r) => setTimeout(r, 25));
    };
    await expect(
      relaunchSessionWithSettings(
        getSession(sessionName)!,
        { agentType: 'claude-code', ccPreset: 'PresetSnap', requestedModel: 'm-snap' },
        { deadlineAt: Date.now() + 5 },
      ),
    ).rejects.toBeInstanceOf(RestartBeforeStartTimeoutError);
    expect(conptyIsPaneAlive(sessionName)).toBe(true);
    expect(mockPty.kill).not.toHaveBeenCalled();

    // 2) Mutate BOTH the saved preset AND replace PATH wrapper with unparseable batch AFTER preflight:
    // actual launch MUST reuse preflight snapshot env/model AND preflight-resolved shim target.
    resolveIdentityHook.fn = async () => {
      await savePresets([
        {
          name: 'PresetSnap',
          env: {
            ANTHROPIC_BASE_URL: 'https://mutated-after-preflight.invalid',
            ANTHROPIC_API_KEY: 'sk-mutated',
            ANTHROPIC_MODEL: 'm-mutated',
          },
          defaultModel: 'm-mutated',
          availableModels: [{ id: 'm-mutated' }],
          contextWindow: 128_000,
        },
      ]);
      writeFileSync(claudeCmd, '@echo off\r\ncustom-unparseable.exe %*\r\n', 'utf8');
    };

    await relaunchSessionWithSettings(getSession(sessionName)!, {
      agentType: 'claude-code',
      ccPreset: 'PresetSnap',
      requestedModel: 'm-snap',
    });

    const [launchFile, launchArgs, launchSpawnOpts] = spawnMock.mock.calls.at(-1) as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(launchFile).toBe(process.execPath);
    expect(launchArgs[0]).toBe(shimJs);
    expect(launchArgs).toContain('m-snap');
    expect(launchArgs).not.toContain('m-mutated');
    expect(launchSpawnOpts.env.ANTHROPIC_BASE_URL).toBe('https://preflight-snapshot.example/anthropic');
    expect(launchSpawnOpts.env.ANTHROPIC_MODEL).toBe('m-snap');
  });
});
