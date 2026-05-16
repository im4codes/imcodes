import { describe, expect, it } from 'vitest';
import { MEMORY_MCP_ENV_KEYS } from '../../shared/memory-mcp-env.js';
import { deriveMemoryToolCaller, parseMcpRuntimeCallerFromEnv } from '../../src/daemon/memory-mcp-caller.js';

describe('MCP runtime caller env parsing', () => {
  it('parses provided identity and represents absent optional fields as null', () => {
    const caller = parseMcpRuntimeCallerFromEnv({
      [MEMORY_MCP_ENV_KEYS.USER_ID]: 'user-1',
      [MEMORY_MCP_ENV_KEYS.NAMESPACE]: JSON.stringify({ scope: 'personal', userId: 'user-1', projectId: 'repo' }),
    });
    expect(caller).toMatchObject({
      userId: 'user-1',
      namespace: { scope: 'personal', userId: 'user-1', projectId: 'repo' },
      sessionName: null,
      projectName: null,
      projectRoot: null,
      serverId: null,
      transport: 'stdio',
    });
    expect(Object.isFrozen(caller)).toBe(true);
    expect(deriveMemoryToolCaller(caller)).toMatchObject({ userId: 'user-1' });
  });

  it('defaults to local daemon identity when env identity is absent', () => {
    const caller = parseMcpRuntimeCallerFromEnv({});
    expect(caller).toMatchObject({
      userId: 'daemon-local',
      namespace: { scope: 'user_private', userId: 'daemon-local' },
      sessionName: null,
      projectName: null,
      projectRoot: null,
      serverId: null,
      transport: 'stdio',
    });
  });

  it('derives exact runtime session provenance for memory writes', () => {
    const caller = parseMcpRuntimeCallerFromEnv({
      [MEMORY_MCP_ENV_KEYS.USER_ID]: 'user-1',
      [MEMORY_MCP_ENV_KEYS.NAMESPACE]: JSON.stringify({ scope: 'personal', userId: 'user-1', projectId: 'repo' }),
      [MEMORY_MCP_ENV_KEYS.SESSION_NAME]: 'deck_sub_worker',
      [MEMORY_MCP_ENV_KEYS.PROJECT_NAME]: 'proj',
      [MEMORY_MCP_ENV_KEYS.SERVER_ID]: 'srv-1',
    });

    expect(deriveMemoryToolCaller(caller)).toMatchObject({
      userId: 'user-1',
      sourceSessionName: 'deck_sub_worker',
      sourceProjectName: 'proj',
      sourceServerId: 'srv-1',
    });
  });

  it('fails fast for invalid namespace or unsafe session name', () => {
    expect(() => parseMcpRuntimeCallerFromEnv({
      [MEMORY_MCP_ENV_KEYS.USER_ID]: 'user-1',
      [MEMORY_MCP_ENV_KEYS.NAMESPACE]: '{not-json',
    })).toThrow('must be valid JSON');
    expect(parseMcpRuntimeCallerFromEnv({
      [MEMORY_MCP_ENV_KEYS.USER_ID]: 'user-1',
      [MEMORY_MCP_ENV_KEYS.NAMESPACE]: JSON.stringify({ scope: 'personal', userId: 'user-2', projectId: 'repo' }),
    })).toMatchObject({ userId: 'user-2' });
    expect(() => parseMcpRuntimeCallerFromEnv({
      [MEMORY_MCP_ENV_KEYS.USER_ID]: 'user-1',
      [MEMORY_MCP_ENV_KEYS.NAMESPACE]: JSON.stringify({ scope: 'personal', userId: 'user-1', projectId: 'repo' }),
      [MEMORY_MCP_ENV_KEYS.SESSION_NAME]: 'deck_sub_$(whoami)',
    })).toThrow('IMCODES_DAEMON_SESSION_NAME is invalid');
  });
});
