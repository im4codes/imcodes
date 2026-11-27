import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const store = new Map<string, any>();
  return {
    store,
    upsertSession: vi.fn((r: any) => { store.set(r.name, r); }),
    getSession: vi.fn((name: string) => store.get(name) ?? null),
    removeSession: vi.fn((name: string) => { store.delete(name); }),
    newSession: vi.fn(async () => {}),
    killSession: vi.fn(async () => {}),
    sessionExists: vi.fn(async () => false),
    getPaneId: vi.fn(async () => '%99'),
    capturePane: vi.fn(async () => []),
    sendKey: vi.fn(async () => {}),
    sendKeys: vi.fn(async () => {}),
    sendKeysDelayedEnter: vi.fn(async () => {}),
    resolveEffectiveIdentityPrompt: vi.fn(async () => 'User identity instruction\n'.repeat(18)),
  };
});

vi.mock('../../src/store/session-store.js', () => ({
  upsertSession: mocks.upsertSession,
  getSession: mocks.getSession,
  removeSession: mocks.removeSession,
  createRuntimeEpoch: vi.fn(() => 'epoch-1'),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  newSession: mocks.newSession,
  killSession: mocks.killSession,
  sessionExists: mocks.sessionExists,
  capturePane: mocks.capturePane,
  sendKey: mocks.sendKey,
  sendKeys: mocks.sendKeys,
  sendKeysDelayedEnter: mocks.sendKeysDelayedEnter,
  getPanePids: vi.fn(async () => []),
  getPaneId: mocks.getPaneId,
}));

vi.mock('../../src/daemon/session-identity-resolver.js', () => ({
  resolveEffectiveIdentityPrompt: mocks.resolveEffectiveIdentityPrompt,
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  getDriver: vi.fn(() => ({
    buildLaunchCommand: vi.fn(() => '/bin/bash'),
    buildResumeCommand: vi.fn(() => '/bin/bash'),
    postLaunch: undefined,
  })),
  launchTransportSession: vi.fn(async () => {}),
  getTransportRuntime: vi.fn(() => null),
  stopTransportRuntimeSession: vi.fn(async () => {}),
}));

vi.mock('../../src/agent/agent-version.js', () => ({
  getAgentVersion: vi.fn(async () => undefined),
}));

vi.mock('../../src/daemon/terminal-streamer.js', () => ({
  terminalStreamer: { rebindSession: vi.fn(async () => {}), stopSession: vi.fn() },
}));

vi.mock('../../src/daemon/session-resource-service.js', () => ({
  registerTmuxSessionResource: vi.fn(async () => {}),
  releaseSessionResources: vi.fn(async () => ({ released: 0, failed: 0 })),
  resourceOwnerEnv: vi.fn(() => ({})),
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: { emit: vi.fn(), on: vi.fn(() => () => {}), epoch: 0, replay: vi.fn(() => ({ events: [], truncated: false })), forgetSession: vi.fn() },
}));

vi.mock('../../src/daemon/jsonl-watcher.js', () => ({
  reserveSessionFile: vi.fn(), reassignSessionFile: vi.fn(),
  startWatchingFile: vi.fn(async () => {}), startWatching: vi.fn(async () => {}),
  stopWatching: vi.fn(), isWatching: vi.fn(() => false), preClaimFile: vi.fn(),
  claudeProjectDir: (d: string) => d, findJsonlPathBySessionId: (d: string, id: string) => `${d}/${id}.jsonl`,
  ensureClaudeSessionFile: vi.fn(async () => '/tmp/seed.jsonl'),
}));

vi.mock('../../src/daemon/codex-watcher.js', () => ({
  ensureSessionFile: vi.fn(async () => '/tmp/rollout.jsonl'),
  startWatching: vi.fn(async () => {}), startWatchingSpecificFile: vi.fn(async () => {}),
  startWatchingById: vi.fn(async () => {}), stopWatching: vi.fn(),
  isWatching: vi.fn(() => false), isFileClaimedByOther: vi.fn(() => false),
  findRolloutPathByUuid: vi.fn(async () => null),
}));

vi.mock('../../src/daemon/opencode-watcher.js', () => ({
  startWatching: vi.fn(async () => {}), stopWatching: vi.fn(), isWatching: vi.fn(() => false),
}));

import { startSubSession, stopSubSession } from '../../src/daemon/subsession-manager.js';
import { startDiscussion } from '../../src/daemon/discussion-orchestrator.js';

describe('subsession-manager shell/script prompt guard, HISTFILE isolation, and discussion guard', () => {
  let stateDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.clear();
    mocks.sessionExists.mockResolvedValue(false);
    stateDir = mkdtempSync(join(tmpdir(), 'imcodes-sub-shell-'));
    vi.stubEnv('IMCODES_HOME', stateDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('never injects identity/description prompts into shell or script sub-sessions', async () => {
    await startSubSession({
      id: 'sh1',
      type: 'shell',
      cwd: '/tmp',
      description: 'Sub-session agent description',
      identityPrompt: 'Explicit sub-session identity',
      parentSession: 'deck_proj_brain',
    });
    await startSubSession({
      id: 'sc1',
      type: 'script',
      cwd: '/tmp',
      description: 'Script description',
      identityPrompt: 'Script identity',
      parentSession: 'deck_proj_brain',
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(mocks.resolveEffectiveIdentityPrompt).not.toHaveBeenCalled();
    expect(mocks.sendKeys).not.toHaveBeenCalled();
    expect(mocks.store.get('deck_sub_sh1')?.appliedIdentityHash).toBeUndefined();
    expect(mocks.store.get('deck_sub_sc1')?.appliedIdentityHash).toBeUndefined();

    // Non-shell agent sub-session still receives context prompt and gets no HISTFILE
    await startSubSession({
      id: 'cc1',
      type: 'claude-code',
      cwd: '/tmp',
      description: 'Coder description',
      parentSession: 'deck_proj_brain',
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(mocks.resolveEffectiveIdentityPrompt).toHaveBeenCalledWith({
      name: 'deck_sub_cc1',
      projectName: 'deck_proj_brain',
    });
    expect(mocks.sendKeys).toHaveBeenCalledWith(
      'deck_sub_cc1',
      expect.stringContaining('[Context — absorb silently, do not respond to this message]'),
    );
    const ccEnv = (mocks.newSession.mock.calls[2] as any)?.[2]?.env;
    expect(ccEnv?.HISTFILE).toBeUndefined();
  });

  it('assigns distinct HISTFILE paths across concurrent shell sub-sessions, preserves on restart, and commits close even if history unlink hits non-ENOENT I/O error', async () => {
    await startSubSession({ id: 'sh1', type: 'shell', cwd: '/tmp', shellBin: '/bin/bash' });
    await startSubSession({ id: 'sh2', type: 'shell', cwd: '/tmp', shellBin: '/bin/bash' });

    const expected1 = join(stateDir, 'shell-history', 'deck_sub_sh1.history');
    const expected2 = join(stateDir, 'shell-history', 'deck_sub_sh2.history');
    expect((mocks.newSession.mock.calls[0] as any)?.[2]?.env?.HISTFILE).toBe(expected1);
    expect((mocks.newSession.mock.calls[1] as any)?.[2]?.env?.HISTFILE).toBe(expected2);
    expect(expected1).not.toBe(expected2);

    writeFileSync(expected1, 'echo sh1\n', 'utf8');
    writeFileSync(expected2, 'echo sh2\n', 'utf8');

    // Simulated daemon-restart rebuild keeps sh1 history
    await startSubSession({ id: 'sh1', type: 'shell', cwd: '/tmp', shellBin: '/bin/bash' });
    expect((mocks.newSession.mock.calls[2] as any)?.[2]?.env?.HISTFILE).toBe(expected1);
    expect(readFileSync(expected1, 'utf8')).toBe('echo sh1\n');

    // Close removes sh1 cleanly
    const closeRes = await stopSubSession('deck_sub_sh1');
    expect(closeRes.ok).toBe(true);
    expect(existsSync(expected1)).toBe(false);
    expect(existsSync(expected2)).toBe(true);

    // Real non-ENOENT EISDIR unlink failure on sh3 must NOT roll back close or fail stopSubSession
    await startSubSession({ id: 'sh3', type: 'shell', cwd: '/tmp', shellBin: '/bin/bash' });
    const expected3 = join(stateDir, 'shell-history', 'deck_sub_sh3.history');
    mkdirSync(expected3);
    const serverMessages: any[] = [];
    const closeRes3 = await stopSubSession('deck_sub_sh3', { send: (m) => serverMessages.push(m) });
    expect(closeRes3.ok).toBe(true);
    expect(closeRes3.failed).toEqual([]);
    expect(mocks.store.has('deck_sub_sh3')).toBe(false);
    expect(serverMessages).toContainEqual({ type: 'subsession.closed', id: 'sh3', sessionName: 'deck_sub_sh3' });
    expect(readFileSync(expected2, 'utf8')).toBe('echo sh2\n');
  });

  it('rejects discussion participants targeting shell/script sessions by agentType or live store record before prompting', async () => {
    mocks.store.set('deck_sub_live_shell', { name: 'deck_sub_live_shell', agentType: 'shell', state: 'idle' });
    mocks.store.set('deck_sub_live_script', { name: 'deck_sub_live_script', agentType: 'script', state: 'idle' });

    await expect(startDiscussion({
      id: 'disc-1',
      serverId: 'srv-1',
      topic: 'Should reject shell',
      cwd: stateDir,
      participants: [{ agentType: 'shell', roleId: 'critic' }],
    }, vi.fn())).rejects.toThrow(/shell/);

    await expect(startDiscussion({
      id: 'disc-2',
      serverId: 'srv-1',
      topic: 'Should reject script',
      cwd: stateDir,
      participants: [{ agentType: 'script', roleId: 'critic' }],
    }, vi.fn())).rejects.toThrow(/script/);

    // Reused session claiming agentType='claude-code' while live store record is actually shell/script MUST still reject
    await expect(startDiscussion({
      id: 'disc-3',
      serverId: 'srv-1',
      topic: 'Should reject spoofed reused shell',
      cwd: stateDir,
      participants: [{ agentType: 'claude-code', sessionName: 'deck_sub_live_shell', roleId: 'critic' }],
    }, vi.fn())).rejects.toThrow(/shell/);

    await expect(startDiscussion({
      id: 'disc-4',
      serverId: 'srv-1',
      topic: 'Should reject spoofed reused script',
      cwd: stateDir,
      participants: [{ agentType: 'codex', sessionName: 'deck_sub_live_script', roleId: 'critic' }],
    }, vi.fn())).rejects.toThrow(/script/);

    expect(mocks.sendKeysDelayedEnter).not.toHaveBeenCalled();
  });
});
