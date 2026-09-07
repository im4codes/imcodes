import { describe, expect, it, vi } from 'vitest';
import { syncSessionIdentities, syncSessionIdentitiesForCommand } from '../../src/daemon/session-identity-sync.js';
import type { SessionRecord } from '../../src/store/session-store.js';
import {
  renderSessionIdentityProfiles,
  type SessionIdentityProfile,
} from '../../shared/session-identity.js';

function session(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    name: 'deck_proj_brain',
    projectName: 'proj',
    projectDir: '/tmp/proj',
    role: 'brain',
    agentType: 'codex-sdk',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    contextNamespace: { scope: 'user_private', userId: 'u1', projectId: 'repo-1' },
    ...overrides,
  };
}

function profile(scope: SessionIdentityProfile['scope'], scopeKey: string, content: string): SessionIdentityProfile {
  return { scope, scopeKey, content, contentHash: content, revision: 1, updatedAt: 1, source: 'mcp' };
}

describe('cross-machine session identity synchronization', () => {
  it('uses one online snapshot and refreshes only sessions whose effective identity changed', async () => {
    const unchangedPrompt = renderSessionIdentityProfiles([profile('user', '', 'global')]);
    const sessions = [
      session({ name: 'deck_proj_brain', identityPrompt: unchangedPrompt }),
      session({ name: 'deck_proj_cc1' }),
      session({ name: 'deck_other_brain', projectName: 'other', identityPrompt: unchangedPrompt, contextNamespace: { scope: 'user_private', userId: 'u1', projectId: 'repo-2' } }),
      session({ name: 'deck_stopped', state: 'stopped' }),
    ];
    const listProfiles = vi.fn(async () => ({
      status: 'ok' as const,
      serverId: 'srv-9',
      profiles: [
        profile('user', '', 'global'),
        profile('project', 'repo-1', 'repo rules'),
        profile('session', 'srv-9:deck_proj_cc1', 'worker rules'),
      ],
    }));
    const applyIdentity = vi.fn(() => ({ applied: true }));

    const result = await syncSessionIdentities({}, {
      listProfiles,
      listLocalSessions: () => sessions,
      applyIdentity,
    });

    expect(result).toEqual({ status: 'ok', checked: 3, changed: 2 });
    expect(listProfiles).toHaveBeenCalledTimes(1);
    expect(applyIdentity).toHaveBeenCalledWith(
      'deck_proj_cc1',
      expect.stringMatching(/<user>[\s\S]*<project>[\s\S]*<session>/),
      { refresh: true },
    );
    expect(applyIdentity).not.toHaveBeenCalledWith('deck_stopped', expect.anything(), expect.anything());
  });

  it('joins a concurrent periodic sync instead of falsely reporting skipped before apply completes', async () => {
    let releaseSnapshot!: (value: {
      status: 'ok'; serverId: string; profiles: SessionIdentityProfile[];
    }) => void;
    const listProfiles = vi.fn(() => new Promise<{
      status: 'ok'; serverId: string; profiles: SessionIdentityProfile[];
    }>((resolve) => { releaseSnapshot = resolve; }));
    const applyIdentity = vi.fn(() => ({ applied: true }));
    const deps = {
      listProfiles,
      listLocalSessions: () => [session({ identityPrompt: undefined })],
      applyIdentity,
    };

    const periodic = syncSessionIdentities({}, deps);
    const explicit = syncSessionIdentities({}, deps);
    expect(listProfiles).toHaveBeenCalledTimes(1);
    releaseSnapshot({ status: 'ok', serverId: 'srv-9', profiles: [profile('user', '', 'global')] });

    await expect(periodic).resolves.toEqual({ status: 'ok', checked: 1, changed: 1 });
    await expect(explicit).resolves.toEqual({ status: 'ok', checked: 1, changed: 1 });
    expect(applyIdentity).toHaveBeenCalledTimes(1);
  });

  it('builds the explicit refresh ack only after convergence and carries failures', async () => {
    const runSync = vi.fn(async () => ({ status: 'ok' as const, checked: 1, changed: 1 }));
    await expect(syncSessionIdentitiesForCommand({
      commandId: 'identity-1',
      sessionName: 'deck_proj_brain',
    }, runSync)).resolves.toEqual({
      commandId: 'identity-1',
      sessionName: 'deck_proj_brain',
      status: 'ok',
    });
    await expect(syncSessionIdentitiesForCommand({
      commandId: 'identity-2',
      sessionName: 'deck_proj_brain',
    }, async () => { throw new Error('profile fetch failed'); })).resolves.toEqual({
      commandId: 'identity-2',
      sessionName: 'deck_proj_brain',
      status: 'error',
      error: 'profile fetch failed',
    });
  });
});
