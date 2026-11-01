import { readFile } from 'node:fs/promises';
import { parseMcpRuntimeCallerFromEnv } from '../../../src/daemon/memory-mcp-caller.js';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_CLI_SDK_AGENT_TYPE,
  PROCESS_SESSION_AGENT_TYPES,
  TRANSPORT_SESSION_AGENT_TYPES,
} from '../../../shared/agent-types.js';
import { AGY_SDK_PROVIDER_ID } from '../../../shared/agy-agent.js';
import { IMCODES_SESSION_ENV } from '../../../shared/imcodes-send.js';
import {
  buildMemoryMcpServerEnv,
  IMCODES_DAEMON_NAMESPACE_ENV,
  IMCODES_DAEMON_PROJECT_NAME_ENV,
  IMCODES_DAEMON_PROJECT_ROOT_ENV,
  IMCODES_DAEMON_PROVIDER_ID_ENV,
  IMCODES_DAEMON_SERVER_ID_ENV,
  IMCODES_DAEMON_SESSION_NAME_ENV,
  IMCODES_DAEMON_SOURCE_SESSION_NAME_ENV,
  IMCODES_DAEMON_USER_ID_ENV,
  IMCODES_MCP_TOOL_CATALOG_MODE_ENV,
  isMemoryMcpAllowedEnvKey,
} from '../../../shared/memory-mcp-env.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../../shared/memory-mcp-server-name.js';
import {
  MEMORY_MCP_PROVIDER_ID,
  MEMORY_MCP_PROVIDER_IDS,
} from '../../../shared/memory-ws.js';
import { getDefaultCodexMcpArgs, getCodexAppServerArgs } from '../../../src/agent/providers/getDefaultCodexMcpArgs.js';
import {
  getDefaultAcpMcpServers,
  getDefaultMcpServers,
  withMemoryMcpSessionEnv,
  IMCODES_MEMORY_MCP_ARGS,
  IMCODES_MEMORY_MCP_COMMAND,
  IMCODES_MEMORY_MCP_LAUNCH_ARGS,
  IMCODES_MEMORY_MCP_LAUNCH_COMMAND,
} from '../../../src/agent/providers/getDefaultMcpServers.js';
import { IMCODES_MCP_PARENT_PID_ENV } from '../../../src/daemon/mcp-stdio-lifecycle.js';
import { MCP_TOOL_CATALOG_MODES } from '../../../shared/mcp-tool-discovery.js';
import { SESSION_RESOURCE_OWNER_ENV } from '../../../shared/session-resource-lifecycle.js';

const sessionConfig = {
  sessionKey: 'route-1',
  sessionName: 'deck_alpha_worker',
  sessionInstanceId: 'instance-bound',
  runtimeEpoch: 'epoch-bound',
  projectName: 'alpha',
  serverId: 'srv-bound',
  providerId: 'codex-sdk',
  cwd: '/tmp/project',
  env: {
    [IMCODES_SESSION_ENV]: 'deck_alpha_worker',
    [IMCODES_DAEMON_SOURCE_SESSION_NAME_ENV]: 'deck_sub_supervision_alpha',
    IMCODES_SERVER_TOKEN: 'server-secret',
    OAUTH_TOKEN: 'oauth-secret',
  },
  contextNamespace: {
    scope: 'user_private' as const,
    userId: 'user-secret-ish',
    projectId: 'github.com/acme/project',
  },
};

describe('managed provider MCP registration helpers', () => {
  it.each([...MEMORY_MCP_PROVIDER_IDS, AGY_SDK_PROVIDER_ID])('retains all identity fields through %s session-state rebuilds without borrowing the parent identity', (providerId) => {
    const input = { ...sessionConfig, providerId, sessionName: 'deck_alpha_brain', env: { ...sessionConfig.env, [IMCODES_SESSION_ENV]: 'deck_alpha_brain' } };
    const normalized = withMemoryMcpSessionEnv(input);
    expect(input.env).not.toHaveProperty(SESSION_RESOURCE_OWNER_ENV.RUNTIME_EPOCH);
    const rebuilt = getDefaultMcpServers({ sessionKey: 'opaque-native-route', cwd: input.cwd, env: normalized.env })[IMCODES_MEMORY_MCP_SERVER_NAME];
    const env = rebuilt.env;
    expect(env[IMCODES_DAEMON_SESSION_NAME_ENV]).toBe(input.sessionName);
    expect(parseMcpRuntimeCallerFromEnv(env)).toMatchObject({ sessionName: input.sessionName, namespace: input.contextNamespace, serverId: input.serverId, providerId });
    expect(env[SESSION_RESOURCE_OWNER_ENV.SESSION_INSTANCE_ID]).toBe(input.sessionInstanceId);
    expect(env[SESSION_RESOURCE_OWNER_ENV.RUNTIME_EPOCH]).toBe(input.runtimeEpoch);
    expect(env[IMCODES_DAEMON_PROVIDER_ID_ENV]).toBe(providerId);
    expect(env[IMCODES_DAEMON_SERVER_ID_ENV]).toBe(input.serverId);
    expect(JSON.parse(env[IMCODES_DAEMON_NAMESPACE_ENV])).toEqual(input.contextNamespace);
    expect(normalized.env?.IMCODES_SERVER_TOKEN).toBe('server-secret');
    expect(env.IMCODES_SERVER_TOKEN).toBeUndefined();
    const [acp] = getDefaultAcpMcpServers({ cwd: input.cwd, env: normalized.env });
    expect(Object.fromEntries(acp.env.map(({ name, value }) => [name, value]))).toEqual(env);
  });

  it('explicit current runtime identity replaces stale stored env fields without leaking into another session', () => {
    const a = withMemoryMcpSessionEnv(sessionConfig);
    const b = withMemoryMcpSessionEnv({ ...sessionConfig, sessionName: 'deck_beta_worker', sessionInstanceId: 'new-instance', runtimeEpoch: 'new-epoch', env: a.env });
    expect(b.env?.[IMCODES_DAEMON_SESSION_NAME_ENV]).toBe('deck_beta_worker');
    expect(b.env?.[IMCODES_SESSION_ENV]).toBe('deck_beta_worker');
    expect(b.env?.[SESSION_RESOURCE_OWNER_ENV.SESSION_INSTANCE_ID]).toBe('new-instance');
    expect(b.env?.[SESSION_RESOURCE_OWNER_ENV.RUNTIME_EPOCH]).toBe('new-epoch');
    expect(a.env?.[IMCODES_DAEMON_SESSION_NAME_ENV]).toBe(sessionConfig.sessionName);
    expect(a.env?.[SESSION_RESOURCE_OWNER_ENV.RUNTIME_EPOCH]).toBe(sessionConfig.runtimeEpoch);
  });
  it('pins the exact sixteen managed provider matrix and excludes process/OpenClaw providers', () => {
    expect(MEMORY_MCP_PROVIDER_IDS).toEqual([
      MEMORY_MCP_PROVIDER_ID.CLAUDE_CODE_SDK,
      MEMORY_MCP_PROVIDER_ID.GEMINI_SDK,
      MEMORY_MCP_PROVIDER_ID.GROK_SDK,
      MEMORY_MCP_PROVIDER_ID.KIMI_SDK,
      MEMORY_MCP_PROVIDER_ID.HERMES_AGENT,
      MEMORY_MCP_PROVIDER_ID.COPILOT_SDK,
      MEMORY_MCP_PROVIDER_ID.CODEX_SDK,
      MEMORY_MCP_PROVIDER_ID.QODER_SDK,
      MEMORY_MCP_PROVIDER_ID.CURSOR_HEADLESS,
      MEMORY_MCP_PROVIDER_ID.OPENCODE_SDK,
      MEMORY_MCP_PROVIDER_ID.QWEN,
      MEMORY_MCP_PROVIDER_ID.DEEPSEEK_HARNESS,
      MEMORY_MCP_PROVIDER_ID.PI,
      MEMORY_MCP_PROVIDER_ID.MUSE_CODE_SDK,
      MEMORY_MCP_PROVIDER_ID.CODEBUDDY_CHINA,
      MEMORY_MCP_PROVIDER_ID.CODEBUDDY_INTERNATIONAL,
    ]);

    expect(TRANSPORT_SESSION_AGENT_TYPES.filter((agentType) => (
      !MEMORY_MCP_PROVIDER_IDS.includes(agentType as (typeof MEMORY_MCP_PROVIDER_IDS)[number])
    ))).toEqual([AGY_SDK_PROVIDER_ID, CLAUDE_CODE_CLI_SDK_AGENT_TYPE, 'openclaw']);
    expect(PROCESS_SESSION_AGENT_TYPES.some((agentType) => (
      MEMORY_MCP_PROVIDER_IDS.includes(agentType as (typeof MEMORY_MCP_PROVIDER_IDS)[number])
    ))).toBe(false);
  });

  it('builds a minimal stdio server config without forwarding daemon secrets', () => {
    const servers = getDefaultMcpServers(sessionConfig);
    const server = servers[IMCODES_MEMORY_MCP_SERVER_NAME];

    expect(server).toMatchObject({
      type: 'stdio',
      command: IMCODES_MEMORY_MCP_LAUNCH_COMMAND,
      args: [...IMCODES_MEMORY_MCP_LAUNCH_ARGS],
    });
    expect(server.env[IMCODES_DAEMON_USER_ID_ENV]).toBe('user-secret-ish');
    expect(JSON.parse(server.env[IMCODES_DAEMON_NAMESPACE_ENV])).toEqual({
      scope: 'user_private',
      userId: 'user-secret-ish',
      projectId: 'github.com/acme/project',
    });
    expect(server.env[IMCODES_DAEMON_SESSION_NAME_ENV]).toBe('deck_alpha_worker');
    expect(server.env[IMCODES_DAEMON_SOURCE_SESSION_NAME_ENV]).toBe('deck_sub_supervision_alpha');
    expect(server.env[IMCODES_DAEMON_PROJECT_NAME_ENV]).toBe('alpha');
    expect(server.env[IMCODES_DAEMON_PROJECT_ROOT_ENV]).toBe('/tmp/project');
    expect(server.env[IMCODES_DAEMON_SERVER_ID_ENV]).toBe('srv-bound');
    expect(server.env[IMCODES_DAEMON_PROVIDER_ID_ENV]).toBe('codex-sdk');
    expect(server.env[SESSION_RESOURCE_OWNER_ENV.SESSION_INSTANCE_ID]).toBe('instance-bound');
    expect(server.env[SESSION_RESOURCE_OWNER_ENV.RUNTIME_EPOCH]).toBe('epoch-bound');
    expect(server.env[IMCODES_MCP_TOOL_CATALOG_MODE_ENV]).toBe(MCP_TOOL_CATALOG_MODES.STATIC_FULL);
    expect(server.env.IMCODES_SERVER_TOKEN).toBeUndefined();
    expect(server.env.OAUTH_TOKEN).toBeUndefined();
    expect(Object.keys(server.env).every(isMemoryMcpAllowedEnvKey)).toBe(true);
  });

  it('requires an explicit proven client opt-in before using dynamic publication', () => {
    const server = getDefaultMcpServers(sessionConfig, {
      toolCatalogMode: MCP_TOOL_CATALOG_MODES.DYNAMIC,
    })[IMCODES_MEMORY_MCP_SERVER_NAME];

    expect(server.env[IMCODES_MCP_TOOL_CATALOG_MODE_ENV]).toBe(MCP_TOOL_CATALOG_MODES.DYNAMIC);
  });

  it('fills daemon-local identity for local personal namespaces without user ids', () => {
    const servers = getDefaultMcpServers({
      ...sessionConfig,
      contextNamespace: {
        scope: 'personal',
        projectId: 'github.com/acme/project',
      },
    });
    const server = servers[IMCODES_MEMORY_MCP_SERVER_NAME];

    expect(server.env[IMCODES_DAEMON_USER_ID_ENV]).toBe('daemon-local');
    expect(JSON.parse(server.env[IMCODES_DAEMON_NAMESPACE_ENV])).toEqual({
      scope: 'personal',
      userId: 'daemon-local',
      projectId: 'github.com/acme/project',
    });
  });

  it('allow-lists MCP child env even when the source process env has secrets', () => {
    const env = buildMemoryMcpServerEnv({
      [IMCODES_DAEMON_USER_ID_ENV]: 'user-1',
      [IMCODES_DAEMON_NAMESPACE_ENV]: '{"scope":"personal","userId":"user-1"}',
    }, {
      PATH: '/bin',
      HOME: '/tmp/home',
      NODE_OPTIONS: '--no-warnings',
      IMCODES_SERVER_TOKEN: 'server-secret',
      OPENAI_API_KEY: 'api-secret',
      RANDOM_ENV: 'nope',
    });

    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/tmp/home',
      NODE_OPTIONS: '--no-warnings',
      [IMCODES_DAEMON_USER_ID_ENV]: 'user-1',
      [IMCODES_DAEMON_NAMESPACE_ENV]: '{"scope":"personal","userId":"user-1"}',
    });
  });

  it('builds ACP-shaped env entries for Gemini user sessions', () => {
    const [server] = getDefaultAcpMcpServers(sessionConfig);

    expect(server.name).toBe(IMCODES_MEMORY_MCP_SERVER_NAME);
    expect(server.command).toBe(IMCODES_MEMORY_MCP_LAUNCH_COMMAND);
    expect(server.args).toEqual([...IMCODES_MEMORY_MCP_LAUNCH_ARGS]);
    expect(server.env).toContainEqual({ name: IMCODES_DAEMON_USER_ID_ENV, value: 'user-secret-ish' });
    expect(server.env).toContainEqual({
      name: IMCODES_MCP_TOOL_CATALOG_MODE_ENV,
      value: MCP_TOOL_CATALOG_MODES.STATIC_FULL,
    });
    expect(server.env.some((entry) => entry.name === 'IMCODES_SERVER_TOKEN')).toBe(false);
  });

  it('uses explicit sub-session identity and parent project instead of inferring project from deck_sub names or labels', () => {
    const servers = getDefaultMcpServers({
      ...sessionConfig,
      sessionKey: 'route-sub',
      sessionName: 'deck_sub_abc123',
      projectName: 'alpha',
      label: 'friendly-worker',
      env: {},
    });
    const server = servers[IMCODES_MEMORY_MCP_SERVER_NAME];

    expect(server.env[IMCODES_DAEMON_SESSION_NAME_ENV]).toBe('deck_sub_abc123');
    expect(server.env[IMCODES_DAEMON_PROJECT_NAME_ENV]).toBe('alpha');
    expect(server.env[IMCODES_DAEMON_SESSION_NAME_ENV]).not.toBe('friendly-worker');
  });

  it('does not mistake a provider resume key for an IM.codes session identity', () => {
    const server = getDefaultMcpServers({
      sessionKey: 'ef801947-be9a-4bb7-966d-87be08a40015',
      bindExistingKey: 'provider-resume-key',
      contextNamespace: { scope: 'user_private', userId: 'user-1' },
    })[IMCODES_MEMORY_MCP_SERVER_NAME];
    expect(server.env[IMCODES_DAEMON_SESSION_NAME_ENV]).toBeUndefined();
  });

  it('keeps Codex app-server startup argv free of daemon identity values', () => {
    const args = getDefaultCodexMcpArgs();
    const serialized = JSON.stringify(args);

    expect(serialized).toContain(IMCODES_MEMORY_MCP_SERVER_NAME);
    expect(serialized).toContain('imcodes');
    expect(serialized).toContain('memory');
    expect(serialized).not.toContain(IMCODES_DAEMON_USER_ID_ENV);
    expect(serialized).not.toContain(IMCODES_DAEMON_NAMESPACE_ENV);
    expect(serialized).not.toContain('user-secret-ish');
    expect(serialized).not.toContain('github.com/acme/project');
    expect(serialized).toContain('IMCODES_MCP_TOOL_CATALOG_MODE');
    expect(serialized).toContain('static_full');
  });

  it('keeps native multi-agent collaboration available at app-server process start', () => {
    // The app-server is shared by every session. Disabling a feature here would
    // hide native collaboration from analysis and non-Brain sessions too; Brain
    // task participation is enforced by the daemon relay instead.
    const args = getCodexAppServerArgs();
    expect(args, 'no process-wide feature may be disabled').not.toContain('--disable');
    expect(JSON.stringify(args)).not.toContain('multi_agent');
    expect(args.at(-1)).toBe('app-server');
    // The IM MCP catalog must stay intact so send_message/supervision still work.
    const serialized = JSON.stringify(args);
    expect(serialized).toContain('IMCODES_MCP_TOOL_CATALOG_MODE');
    expect(serialized).toContain('static_full');
  });

  it('pins Gemini model-list probe as MCP-free', async () => {
    const source = await readFile(new URL('../../../src/agent/providers/gemini-sdk.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/listModels[\s\S]*newSession\(\{\s*cwd:[\s\S]*mcpServers:\s*\[\]/);
  });
});

describe('production parent-identity injection', () => {
  it('declares the host parent pid on every real POSIX launch, exec-preserving', () => {
    // R2 shipped the `expectedParentPid` check with NO producer: the only
    // setter anywhere in the repository was a test, so the mechanism protected
    // nothing real. This pins the declaration to the launch shape MCP clients
    // actually run, rather than to a helper or a test-supplied env.
    if (process.platform === 'win32') {
      // Windows has no `exec`: a wrapper would leave an intermediate process
      // between client and server and break signal/exit-code fidelity, so this
      // platform keeps the direct launch and is deliberately not narrowed.
      expect(IMCODES_MEMORY_MCP_LAUNCH_COMMAND).toBe(IMCODES_MEMORY_MCP_COMMAND);
      expect([...IMCODES_MEMORY_MCP_LAUNCH_ARGS]).toEqual([...IMCODES_MEMORY_MCP_ARGS]);
      return;
    }
    expect(IMCODES_MEMORY_MCP_LAUNCH_COMMAND).toBe('sh');
    const script = IMCODES_MEMORY_MCP_LAUNCH_ARGS[1] ?? '';
    expect(script, 'the wrapper must declare its own parent').toContain(`${IMCODES_MCP_PARENT_PID_ENV}=$PPID`);
    expect(script, 'exec: no shell survives, so stdio/exit/signals are unchanged').toContain('exec "$0" "$@"');
    expect(
      [...IMCODES_MEMORY_MCP_LAUNCH_ARGS].slice(2),
      'the wrapped command is the real server, unchanged',
    ).toEqual([IMCODES_MEMORY_MCP_COMMAND, ...IMCODES_MEMORY_MCP_ARGS]);
  });

  it('routes the stdio and Codex consumers through that same shape', () => {
    // One source of truth. A consumer left on the bare command would spawn a
    // server with no declared parent and silently lose the protection.
    const server = getDefaultMcpServers(sessionConfig)[IMCODES_MEMORY_MCP_SERVER_NAME];
    expect(server.command).toBe(IMCODES_MEMORY_MCP_LAUNCH_COMMAND);
    expect(server.args).toEqual([...IMCODES_MEMORY_MCP_LAUNCH_ARGS]);
    const codex = getDefaultCodexMcpArgs(sessionConfig).join(' ');
    expect(codex).toContain(`command=${JSON.stringify(IMCODES_MEMORY_MCP_LAUNCH_COMMAND)}`);
  });
});
