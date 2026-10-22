import { access, readFile, stat } from 'node:fs/promises';
import { constants as fsConstants, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isClaudeCodeFamily, isCodexFamily } from '../../shared/agent-types.js';
import { claudeAuthUdsEnv, checkClaudeAuthUds } from './claude-auth-uds.js';
import { MEMORY_MCP_PROVIDER_IDS } from '../../shared/memory-ws.js';

/** Providers currently constructible by provider-registry.  Entries without
 * a proven local auth protocol must still return an explicit unsupported
 * context rather than silently bypassing the shared contract. */
const REGISTRY_PROVIDER_IDS = new Set([
  'openclaw', ...MEMORY_MCP_PROVIDER_IDS,
]);

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
    const parsed = JSON.parse(await readFile(authPath, 'utf8')) as Record<string, unknown>;
    const token = [parsed.access_token, parsed.id_token, parsed.token].find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (!token) return unsupported(providerId, `Codex auth file has no usable token: ${authPath}`);
    const jwtParts = token.split('.');
    if (jwtParts.length === 3) {
      try {
        const payload = JSON.parse(Buffer.from(jwtParts[1]!, 'base64url').toString('utf8')) as { exp?: unknown };
        if (typeof payload.exp === 'number' && payload.exp <= Date.now() / 1000) return unsupported(providerId, `Codex auth token is expired: ${authPath}`);
      } catch {
        return unsupported(providerId, `Codex auth token is malformed: ${authPath}`);
      }
    }
    return { providerId, method: 'credential-file', source: authPath, authenticated: true, reusable: true, env: {} };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return unsupported(providerId, `Codex auth context unavailable${code ? ` (${code})` : ''}`);
  }
}

async function jsonCredentialAuth(providerId: string, authPath: string): Promise<LocalAuthContext> {
  try {
    const metadata = await stat(authPath);
    if (!metadata.isFile() || metadata.size <= 0) return unsupported(providerId, `Credential file is unusable: ${authPath}`);
    const parsed = JSON.parse(await readFile(authPath, 'utf8')) as Record<string, unknown>;
    const findToken = (value: unknown, hinted = false): string | undefined => {
      if (typeof value === 'string' && hinted && value.trim()) return value.trim();
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const found = findToken(child, hinted || /token|key|oauth|credential/i.test(key));
        if (found) return found;
      }
      return undefined;
    };
    const token = findToken(parsed);
    if (!token) return unsupported(providerId, `Credential file has no verifiable token: ${authPath}`);
    // Credential files are only reusable when their token format and lifetime
    // are verifiable.  Do not treat arbitrary fixture strings or provider-
    // specific opaque values as proof of an authenticated session.
    const parts = token.split('.');
    if (parts.length !== 3) return unsupported(providerId, `Credential token format is unverifiable: ${authPath}`);
    let payload: { exp?: unknown };
    try {
      payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { exp?: unknown };
    } catch {
      return unsupported(providerId, `Credential token is malformed: ${authPath}`);
    }
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= Date.now() / 1000) {
      return unsupported(providerId, `Credential token is expired or has no verifiable expiry: ${authPath}`);
    }
    return { providerId, method: 'credential-file', source: authPath, authenticated: true, reusable: true, env: {} };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return unsupported(providerId, `Credential context unavailable${code ? ` (${code})` : ''}`);
  }
}

async function configuredProviderAuth(providerId: string, env: NodeJS.ProcessEnv): Promise<LocalAuthContext> {
  const envKeys: Record<string, string[]> = {
    'gemini-sdk': ['GEMINI_API_KEY'],
    'grok-sdk': ['XAI_API_KEY'],
    'copilot-sdk': ['GITHUB_TOKEN', 'GH_TOKEN'],
    qwen: ['QWEN_API_KEY'],
    'kimi-sdk': ['KIMI_API_KEY'],
    'muse-code-sdk': ['MUSE_API_KEY'],
  };
  for (const key of envKeys[providerId] ?? []) {
    const found = envToken(providerId, key, env);
    if (found) return found;
  }
  const home = env.HOME?.trim();
  const knownFiles: Record<string, string> = {
    'gemini-sdk': '.gemini/oauth_creds.json',
    'grok-sdk': '.grok/auth.json',
  };
  const relative = knownFiles[providerId];
  if (home && relative) return jsonCredentialAuth(providerId, join(home, relative));
  if (REGISTRY_PROVIDER_IDS.has(providerId)) {
    return unsupported(providerId, `No verified local auth adapter is defined for provider ${providerId}; provider-native auth remains provider-owned`);
  }
  return unsupported(providerId, `Unknown provider ${providerId} has no local auth adapter`);
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
  return configuredProviderAuth(providerId, env);
}

/** Synchronous projection for launch environments; detection remains authoritative. */
export function localAuthContextEnv(providerId: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (isClaudeCodeFamily(providerId)) return claudeAuthUdsEnv(env);
  if (isCodexFamily(providerId)) {
    const value = env.OPENAI_API_KEY?.trim();
    return value ? { OPENAI_API_KEY: value } : {};
  }
  const envKeys: Record<string, string[]> = {
    'gemini-sdk': ['GEMINI_API_KEY'],
    'grok-sdk': ['XAI_API_KEY'],
    'copilot-sdk': ['GITHUB_TOKEN', 'GH_TOKEN'],
    qwen: ['QWEN_API_KEY'],
    'kimi-sdk': ['KIMI_API_KEY'],
    'muse-code-sdk': ['MUSE_API_KEY'],
  };
  for (const key of envKeys[providerId] ?? []) {
    const value = env[key]?.trim();
    if (value) return { [key]: value };
  }
  return {};
}

/** True only when the caller supplied a provider auth candidate we must verify. */
export function hasLocalAuthCandidate(providerId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (isClaudeCodeFamily(providerId)) {
    return Boolean(env.CLAUDE_CODE_MESSAGING_SOCKET?.trim() || env.IMCODES_CLAUDE_AUTH_UDS?.trim());
  }
  if (isCodexFamily(providerId)) return Boolean(env.OPENAI_API_KEY?.trim() || env.CODEX_HOME?.trim() || (env.HOME && existsSync(join(env.HOME, '.codex', 'auth.json'))));
  const candidates: Record<string, string[]> = {
    'gemini-sdk': ['GEMINI_API_KEY'],
    'grok-sdk': ['XAI_API_KEY'],
    'copilot-sdk': ['GITHUB_TOKEN', 'GH_TOKEN'],
    qwen: ['QWEN_API_KEY'],
    'kimi-sdk': ['KIMI_API_KEY'],
    'muse-code-sdk': ['MUSE_API_KEY'],
  };
  if ((candidates[providerId] ?? []).some((key) => Boolean(env[key]?.trim()))) return true;
  const home = env.HOME?.trim();
  const knownFiles: Record<string, string> = {
    'gemini-sdk': '.gemini/oauth_creds.json',
    'grok-sdk': '.grok/auth.json',
  };
  return Boolean(home && knownFiles[providerId] && existsSync(join(home, knownFiles[providerId])));
}
