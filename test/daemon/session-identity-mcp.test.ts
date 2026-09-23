import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import type { SessionRecord } from '../../src/store/session-store.js';
import {
  SESSION_IDENTITY_PROJECT_MAX_CHARS,
  SESSION_IDENTITY_SESSION_MAX_CHARS,
  SESSION_IDENTITY_USER_MAX_CHARS,
} from '../../shared/session-identity.js';
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

  it('fans a project identity change out to every project session concurrently by default', async () => {
    const sessions = [
      session(),
      session({ name: 'deck_proj_cc1', role: 'w1' }),
      session({ name: 'deck_proj_cc2', role: 'w2' }),
      session({
        name: 'deck_other_brain',
        role: 'brain',
        projectName: 'other',
        contextNamespace: { scope: 'user_private', userId: 'user-1', projectId: 'repo-2' },
      }),
    ];
    const setIdentityProfile = vi.fn(async (input: {
      scope: SessionIdentityProfile['scope']; scopeKey: string; content: string;
    }) => ({ status: 'ok' as const, profile: identity(input.scope, input.scopeKey, input.content) }));
    let inFlight = 0;
    let maxInFlight = 0;
    const applyEffectiveIdentity = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { applied: true };
    });
    const handlers = createMemoryMcpToolHandlers(caller, {
      sendDeps: { listSessions: () => sessions },
      setIdentityProfile: setIdentityProfile as never,
      getEffectiveIdentityProfiles: async () => ({ status: 'ok', profiles: [] }),
      applyEffectiveIdentity,
    });

    const result = await handlers[MEMORY_MCP_TOOL_NAMES.SESSION_IDENTITY_SET]({
      identityScope: 'project',
      content: 'Project rules.',
    });

    expect(result).toMatchObject({ status: 'ok', saved: true, all: true });
    // Every session in the project refreshes, but the sibling project's brain
    // does not -- and the three refreshes overlap instead of running in
    // sequence, one after another.
    expect(applyEffectiveIdentity).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(3);
    expect((result as { refreshed: string[] }).refreshed.sort()).toEqual(
      ['deck_proj_brain', 'deck_proj_cc1', 'deck_proj_cc2'],
    );
  });

  it('excludes a session with the same projectName but a different actual project key from the fan-out', async () => {
    const sessions = [
      session(),
      session({ name: 'deck_proj_cc1', role: 'w1' }),
      // Same displayed projectName ("proj"), but its contextNamespace resolves
      // to a DIFFERENT stored project key -- sessionIdentityProjectKey prefers
      // contextNamespace.projectId over the display name. Grouping this
      // session in with the others by projectName alone would report it as
      // refreshed while it actually read (and applied) an empty project layer.
      session({
        name: 'deck_proj_cc_other_ns',
        role: 'w2',
        contextNamespace: { scope: 'user_private', userId: 'user-1', projectId: 'repo-2' },
      }),
    ];
    const setIdentityProfile = vi.fn(async (input: {
      scope: SessionIdentityProfile['scope']; scopeKey: string; content: string;
    }) => ({ status: 'ok' as const, profile: identity(input.scope, input.scopeKey, input.content) }));
    const applyEffectiveIdentity = vi.fn(async () => ({ applied: true }));
    const handlers = createMemoryMcpToolHandlers(caller, {
      sendDeps: { listSessions: () => sessions },
      setIdentityProfile: setIdentityProfile as never,
      getEffectiveIdentityProfiles: async () => ({ status: 'ok', profiles: [] }),
      applyEffectiveIdentity,
    });

    const result = await handlers[MEMORY_MCP_TOOL_NAMES.SESSION_IDENTITY_SET]({
      identityScope: 'project',
      content: 'Project rules.',
    });

    expect(result).toMatchObject({ status: 'ok', saved: true, all: true });
    expect((result as { refreshed: string[] }).refreshed.sort()).toEqual(['deck_proj_brain', 'deck_proj_cc1']);
    expect(applyEffectiveIdentity).not.toHaveBeenCalledWith('deck_proj_cc_other_ns', expect.anything(), expect.anything());
  });

  it('lets a project identity change opt out of the fan-out with all=false', async () => {
    const sessions = [session(), session({ name: 'deck_proj_cc1', role: 'w1' })];
    const setIdentityProfile = vi.fn(async (input: {
      scope: SessionIdentityProfile['scope']; scopeKey: string; content: string;
    }) => ({ status: 'ok' as const, profile: identity(input.scope, input.scopeKey, input.content) }));
    const applyEffectiveIdentity = vi.fn(async () => ({ applied: true }));
    const handlers = createMemoryMcpToolHandlers(caller, {
      sendDeps: { listSessions: () => sessions },
      setIdentityProfile: setIdentityProfile as never,
      getEffectiveIdentityProfiles: async () => ({ status: 'ok', profiles: [] }),
      applyEffectiveIdentity,
    });

    const result = await handlers[MEMORY_MCP_TOOL_NAMES.SESSION_IDENTITY_SET]({
      identityScope: 'project',
      content: 'Project rules.',
      all: false,
    });

    expect(result).toMatchObject({ status: 'ok', saved: true, all: false });
    expect(applyEffectiveIdentity).toHaveBeenCalledTimes(1);
    expect(applyEffectiveIdentity.mock.calls[0][0]).toBe('deck_proj_brain');
  });

  it('fans a session identity change out to its own sub-sessions only when all=true', async () => {
    const sessions = [
      session(),
      session({ name: 'deck_proj_cc1', role: 'w1', parentSession: 'deck_proj_brain' }),
      session({ name: 'deck_proj_cc2', role: 'w2' }),
    ];
    const setIdentityProfile = vi.fn(async (input: {
      scope: SessionIdentityProfile['scope']; scopeKey: string; content: string;
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
      target: 'deck_proj_brain',
      content: 'Brain-specific note.',
      all: true,
    });

    expect(result).toMatchObject({ status: 'ok', saved: true, all: true });
    expect((result as { refreshed: string[] }).refreshed.sort()).toEqual(['deck_proj_brain', 'deck_proj_cc1']);
    // Session scope is keyed per exact session name (unlike user/project,
    // which share one key every affected session already reads), so `all`
    // must WRITE the same content into the sub-session's own storage slot --
    // not just refresh it, which would silently re-apply its unrelated
    // pre-existing content and report the sub-session as "updated" for free.
    expect((result as { written: string[] }).written.sort()).toEqual(['deck_proj_brain', 'deck_proj_cc1']);
    expect(setIdentityProfile).toHaveBeenCalledWith({
      scope: 'session',
      scopeKey: 'srv-1:deck_proj_brain',
      content: 'Brain-specific note.',
    }, {});
    expect(setIdentityProfile).toHaveBeenCalledWith({
      scope: 'session',
      scopeKey: 'srv-1:deck_proj_cc1',
      content: 'Brain-specific note.',
    }, {});
    // The unrelated sibling (no parentSession match) never receives the write.
    expect(setIdentityProfile).not.toHaveBeenCalledWith(
      expect.objectContaining({ scopeKey: 'srv-1:deck_proj_cc2' }),
      expect.anything(),
    );
  });

  it('fans a session identity clear out to its own sub-sessions only when all=true', async () => {
    const sessions = [
      session(),
      session({ name: 'deck_proj_cc1', role: 'w1', parentSession: 'deck_proj_brain' }),
      session({ name: 'deck_proj_cc2', role: 'w2' }),
    ];
    const clearIdentityProfile = vi.fn(async () => ({ status: 'ok' as const, deleted: true }));
    const applyEffectiveIdentity = vi.fn(async () => ({ applied: true }));
    const handlers = createMemoryMcpToolHandlers(caller, {
      sendDeps: { listSessions: () => sessions },
      clearIdentityProfile: clearIdentityProfile as never,
      getEffectiveIdentityProfiles: async () => ({ status: 'ok', profiles: [] }),
      applyEffectiveIdentity,
    });

    const result = await handlers[MEMORY_MCP_TOOL_NAMES.SESSION_IDENTITY_CLEAR]({
      identityScope: 'session',
      target: 'deck_proj_brain',
      all: true,
    });

    expect(result).toMatchObject({ status: 'ok', all: true });
    expect((result as { cleared: string[] }).cleared.sort()).toEqual(['deck_proj_brain', 'deck_proj_cc1']);
    expect(clearIdentityProfile).toHaveBeenCalledWith('session', 'srv-1:deck_proj_brain', undefined, {});
    expect(clearIdentityProfile).toHaveBeenCalledWith('session', 'srv-1:deck_proj_cc1', undefined, {});
    expect(clearIdentityProfile).not.toHaveBeenCalledWith('session', 'srv-1:deck_proj_cc2', undefined, {});
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

    // One past each scope's own cap, taken from the constants. Literals here
    // stop testing the boundary the moment a cap moves: they become an
    // in-budget value that is expected to be rejected.
    for (const [identityScope, length] of [
      ['user', SESSION_IDENTITY_USER_MAX_CHARS + 1],
      ['project', SESSION_IDENTITY_PROJECT_MAX_CHARS + 1],
      ['session', SESSION_IDENTITY_SESSION_MAX_CHARS + 1],
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
    const externalIdentity = '中'.repeat(49_323);
    await writeFile(externalPath, externalIdentity);
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
        content: externalIdentity,
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
