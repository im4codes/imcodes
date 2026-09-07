import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import type { SessionRecord } from '../../src/store/session-store.js';
import type { SessionIdentityProfile } from '../../shared/session-identity.js';

const caller: McpRuntimeCaller = {
  userId: 'user-1',
  namespace: { scope: 'user_private', userId: 'user-1', projectId: 'repo-1' },
  sessionName: 'deck_proj_brain',
  projectName: 'proj',
  projectRoot: '/tmp/proj',
  serverId: 'srv-1',
  providerId: 'codex-sdk',
  transport: 'in_process',
};

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: 'deck_proj_brain',
    projectName: 'proj',
    role: 'brain',
    agentType: 'codex-sdk',
    projectDir: '/tmp/proj',
    state: 'idle',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    contextNamespace: { scope: 'user_private', userId: 'user-1', projectId: 'repo-1' },
    ...overrides,
  };
}

function identity(scope: SessionIdentityProfile['scope'], scopeKey: string, content: string): SessionIdentityProfile {
  return { scope, scopeKey, content, contentHash: `${scope}-hash`, revision: 1, updatedAt: 1, source: 'mcp' };
}

describe('session identity MCP tools', () => {
  it('refreshes an exact sibling from online scopes and requests a Codex stable-context reload', async () => {
    const sessions = [session(), session({ name: 'deck_proj_cc1', role: 'w1' })];
    const getEffectiveIdentityProfiles = vi.fn(async () => ({
      status: 'ok' as const,
      profiles: [
        identity('user', '', 'user rules'),
        identity('project', 'repo-1', 'project rules'),
        identity('session', 'srv-1:deck_proj_cc1', 'session rules'),
      ],
    }));
    const applyEffectiveIdentity = vi.fn(async () => ({ applied: true, runtimeType: 'transport' }));
    const handlers = createMemoryMcpToolHandlers(caller, {
      sendDeps: { listSessions: () => sessions },
      getEffectiveIdentityProfiles,
      applyEffectiveIdentity,
    });

    const result = await handlers[MEMORY_MCP_TOOL_NAMES.SESSION_IDENTITY_REFRESH]({ target: 'deck_proj_cc1' });

    expect(result).toMatchObject({ status: 'ok', target: 'deck_proj_cc1', codexThreadResumePending: true });
    expect(getEffectiveIdentityProfiles).toHaveBeenCalledWith({
      projectKey: 'repo-1',
      sessionKey: 'srv-1:deck_proj_cc1',
    }, {});
    expect(applyEffectiveIdentity).toHaveBeenCalledWith(
      'deck_proj_cc1',
      expect.stringMatching(/<user>[\s\S]*<project>[\s\S]*<session>/),
      { refresh: true },
    );
  });

  it('stores a session override online and refreshes only that session', async () => {
    const sessions = [session(), session({ name: 'deck_proj_cc1', role: 'w1' })];
    const setIdentityProfile = vi.fn(async (input: {
      scope: 'session'; scopeKey: string; content: string; expectedRevision?: number;
    }) => ({ status: 'ok' as const, profile: identity(input.scope, input.scopeKey, input.content) }));
    const applyEffectiveIdentity = vi.fn(async () => ({ applied: true }));
    const handlers = createMemoryMcpToolHandlers(caller, {
      sendDeps: { listSessions: () => sessions },
      setIdentityProfile: setIdentityProfile as never,
      getEffectiveIdentityProfiles: async () => ({ status: 'ok', profiles: [] }),
      applyEffectiveIdentity,
    });

    const result = await handlers[MEMORY_MCP_TOOL_NAMES.SESSION_IDENTITY_SET]({
      identityScope: 'session',
      target: 'deck_proj_cc1',
      content: 'You are the release engineer.',
      expectedRevision: 0,
    });

    expect(result).toMatchObject({ status: 'ok', saved: true, target: 'deck_proj_cc1' });
    expect(setIdentityProfile).toHaveBeenCalledWith({
      scope: 'session',
      scopeKey: 'srv-1:deck_proj_cc1',
      content: 'You are the release engineer.',
    }, {});
    expect(applyEffectiveIdentity).toHaveBeenCalledTimes(1);
  });

  it('exposes the same MCP set path for user, project, and exact-session scopes', async () => {
    const setIdentityProfile = vi.fn(async (input: {
      scope: SessionIdentityProfile['scope']; scopeKey: string; content: string;
    }) => ({ status: 'ok' as const, profile: identity(input.scope, input.scopeKey, input.content) }));
    const handlers = createMemoryMcpToolHandlers(caller, {
      sendDeps: { listSessions: () => [session()] },
      setIdentityProfile: setIdentityProfile as never,
      getEffectiveIdentityProfiles: async () => ({ status: 'ok', profiles: [] }),
      applyEffectiveIdentity: vi.fn(async () => ({ applied: true })),
    });

    for (const identityScope of ['user', 'project', 'session'] as const) {
      await expect(handlers[MEMORY_MCP_TOOL_NAMES.SESSION_IDENTITY_SET]({
        identityScope,
        content: `${identityScope} identity`,
      })).resolves.toMatchObject({ status: 'ok', saved: true });
    }

    expect(setIdentityProfile.mock.calls.map(([input]) => ({
      scope: input.scope,
      scopeKey: input.scopeKey,
    }))).toEqual([
      { scope: 'user', scopeKey: '' },
      { scope: 'project', scopeKey: 'repo-1' },
      { scope: 'session', scopeKey: 'srv-1:deck_proj_brain' },
    ]);
  });

  it('enforces the scope-specific character budget before online storage', async () => {
    const setIdentityProfile = vi.fn();
    const handlers = createMemoryMcpToolHandlers(caller, {
      sendDeps: { listSessions: () => [session()] },
      setIdentityProfile,
    });

    for (const [identityScope, length] of [
      ['user', 10_001],
      ['project', 20_001],
      ['session', 30_001],
    ] as const) {
      await expect(handlers[MEMORY_MCP_TOOL_NAMES.SESSION_IDENTITY_SET]({
        identityScope,
        content: 'x'.repeat(length),
      })).resolves.toMatchObject({
        status: 'error',
        reason: 'validation_failed',
        message: 'identity_content_too_large',
      });
    }
    expect(setIdentityProfile).not.toHaveBeenCalled();
  });

  it('allows only session scope to load an explicitly selected file outside the project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imcodes-identity-mcp-'));
    const projectDir = join(root, 'project');
    const externalPath = join(root, 'identity.md');
    await mkdir(projectDir);
    await writeFile(externalPath, 'External exact-session identity.');
    const target = session({ projectDir });
    const setIdentityProfile = vi.fn(async (input: {
      scope: 'session'; scopeKey: string; content: string;
    }) => ({ status: 'ok' as const, profile: identity(input.scope, input.scopeKey, input.content) }));
    const handlers = createMemoryMcpToolHandlers(caller, {
      sendDeps: { listSessions: () => [target] },
      setIdentityProfile: setIdentityProfile as never,
      getEffectiveIdentityProfiles: async () => ({ status: 'ok', profiles: [] }),
      applyEffectiveIdentity: vi.fn(async () => ({ applied: true })),
    });

    try {
      await expect(handlers[MEMORY_MCP_TOOL_NAMES.SESSION_IDENTITY_SET]({
        identityScope: 'session',
        filePath: externalPath,
      })).resolves.toMatchObject({ status: 'ok', saved: true });
      expect(setIdentityProfile).toHaveBeenCalledWith(expect.objectContaining({
        content: 'External exact-session identity.',
      }), {});

      await expect(handlers[MEMORY_MCP_TOOL_NAMES.SESSION_IDENTITY_SET]({
        identityScope: 'project',
        filePath: externalPath,
      })).resolves.toMatchObject({
        status: 'error',
        reason: 'validation_failed',
        message: 'identity_file_path_invalid',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps sibling and user/project writes Brain-only', async () => {
    const workerCaller = { ...caller, sessionName: 'deck_proj_cc1' };
    const sessions = [session(), session({ name: 'deck_proj_cc1', role: 'w1' })];
    const handlers = createMemoryMcpToolHandlers(workerCaller, {
      sendDeps: { listSessions: () => sessions },
    });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SESSION_IDENTITY_REFRESH]({ target: 'deck_proj_brain' }))
      .resolves.toMatchObject({ status: 'error', reason: 'scope_forbidden' });
    await expect(handlers[MEMORY_MCP_TOOL_NAMES.SESSION_IDENTITY_SET]({ identityScope: 'user', content: 'x' }))
      .resolves.toMatchObject({ status: 'error', reason: 'scope_forbidden' });
  });
});
