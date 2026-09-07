import { describe, expect, it, vi } from 'vitest';
import { syncSessionIdentities } from '../../src/daemon/session-identity-sync.js';
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
});
