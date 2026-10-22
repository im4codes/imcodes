import { access, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { isClaudeCodeFamily, isCodexFamily } from '../../shared/agent-types.js';
import { claudeAuthUdsEnv, checkClaudeAuthUds } from './claude-auth-uds.js';

export type LocalAuthMethod = 'uds' | 'env-token' | 'credential-file' | 'cli-session' | 'unsupported';

export interface LocalAuthContext {
  providerId: string;
  method: LocalAuthMethod;
  source: string;
  authenticated: boolean;
  reusable: boolean;
  /** Environment values required by a child process; never raw file contents. */
  env: Record<string, string>;
  reason?: string;
}

function unsupported(providerId: string, reason: string): LocalAuthContext {
  return { providerId, method: 'unsupported', source: 'none', authenticated: false, reusable: false, env: {}, reason };
}

function envToken(providerId: string, key: string, env: NodeJS.ProcessEnv): LocalAuthContext | undefined {
  const value = env[key]?.trim();
  if (!value) return undefined;
  return {
    providerId,
    method: 'env-token',
    source: `env:${key}`,
    authenticated: true,
    reusable: true,
    env: { [key]: value },
  };
}

async function codexAuth(providerId: string, env: NodeJS.ProcessEnv): Promise<LocalAuthContext> {
  const key = envToken(providerId, 'OPENAI_API_KEY', env);
  if (key) return key;
  const home = env.CODEX_HOME?.trim() || env.HOME?.trim();
  if (!home) return unsupported(providerId, 'Codex HOME/CODEX_HOME is not set');
  const authPath = env.CODEX_HOME?.trim() ? join(home, 'auth.json') : join(home, '.codex', 'auth.json');
  try {
    await access(authPath, fsConstants.R_OK);
    const metadata = await stat(authPath);
    if (!metadata.isFile() || metadata.size <= 0) return unsupported(providerId, `Codex auth file is unusable: ${authPath}`);
    return { providerId, method: 'credential-file', source: authPath, authenticated: true, reusable: true, env: {} };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return unsupported(providerId, `Codex auth context unavailable${code ? ` (${code})` : ''}`);
  }
}

/** Detect only provider mechanisms with a known, testable protocol or file contract. */
export async function detectLocalAuthContext(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalAuthContext> {
  if (isClaudeCodeFamily(providerId)) {
    const result = await checkClaudeAuthUds(env);
    return result.context
      ? {
          providerId,
          method: 'uds',
          source: result.context.address,
          authenticated: true,
          reusable: true,
          env: result.context.env,
        }
      : unsupported(providerId, result.reason ?? 'Claude auth UDS unavailable');
  }
  if (isCodexFamily(providerId)) return codexAuth(providerId, env);
  return unsupported(providerId, `No verified local auth adapter for provider ${providerId}`);
}

/** Synchronous projection for launch environments; detection remains authoritative. */
export function localAuthContextEnv(providerId: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (isClaudeCodeFamily(providerId)) return claudeAuthUdsEnv(env);
  if (isCodexFamily(providerId)) {
    const value = env.OPENAI_API_KEY?.trim();
    return value ? { OPENAI_API_KEY: value } : {};
  }
  return {};
}
