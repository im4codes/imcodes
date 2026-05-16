export const IMCODES_DAEMON_USER_ID_ENV = 'IMCODES_DAEMON_USER_ID';
export const IMCODES_DAEMON_NAMESPACE_ENV = 'IMCODES_DAEMON_NAMESPACE';
export const IMCODES_DAEMON_SESSION_NAME_ENV = 'IMCODES_DAEMON_SESSION_NAME';
export const IMCODES_DAEMON_PROJECT_NAME_ENV = 'IMCODES_DAEMON_PROJECT_NAME';
export const IMCODES_DAEMON_PROJECT_ROOT_ENV = 'IMCODES_DAEMON_PROJECT_ROOT';
export const IMCODES_DAEMON_SERVER_ID_ENV = 'IMCODES_DAEMON_SERVER_ID';

export const MEMORY_MCP_ENV_KEYS = {
  USER_ID: IMCODES_DAEMON_USER_ID_ENV,
  NAMESPACE: IMCODES_DAEMON_NAMESPACE_ENV,
  SESSION_NAME: IMCODES_DAEMON_SESSION_NAME_ENV,
  PROJECT_NAME: IMCODES_DAEMON_PROJECT_NAME_ENV,
  PROJECT_ROOT: IMCODES_DAEMON_PROJECT_ROOT_ENV,
  SERVER_ID: IMCODES_DAEMON_SERVER_ID_ENV,
} as const;

export const MEMORY_MCP_IDENTITY_ENV_KEYS = [
  IMCODES_DAEMON_USER_ID_ENV,
  IMCODES_DAEMON_NAMESPACE_ENV,
  IMCODES_DAEMON_SESSION_NAME_ENV,
  IMCODES_DAEMON_PROJECT_NAME_ENV,
  IMCODES_DAEMON_PROJECT_ROOT_ENV,
  IMCODES_DAEMON_SERVER_ID_ENV,
] as const;

export type MemoryMcpIdentityEnvKey = typeof MEMORY_MCP_IDENTITY_ENV_KEYS[number];
export type MemoryMcpEnvSource = Record<string, string | undefined>;

const SAFE_PASSTHROUGH_ENV_KEYS = ['PATH', 'HOME', 'NODE_OPTIONS'] as const;

export type MemoryMcpEnvInput = Partial<Record<MemoryMcpIdentityEnvKey, string | null | undefined>>;

function assignIfPresent(target: Record<string, string>, key: string, value: string | null | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) target[key] = trimmed;
}

export function buildMemoryMcpServerEnv(
  identity: MemoryMcpEnvInput,
  sourceEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_PASSTHROUGH_ENV_KEYS) {
    assignIfPresent(env, key, sourceEnv[key]);
  }
  for (const key of MEMORY_MCP_IDENTITY_ENV_KEYS) {
    assignIfPresent(env, key, identity[key]);
  }
  return env;
}

export function isMemoryMcpAllowedEnvKey(key: string): boolean {
  return (SAFE_PASSTHROUGH_ENV_KEYS as readonly string[]).includes(key)
    || (MEMORY_MCP_IDENTITY_ENV_KEYS as readonly string[]).includes(key);
}
