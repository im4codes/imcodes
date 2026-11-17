import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveImcodesHome } from '../util/windows-daemon-lock.js';
import { MCP_ERROR_REASONS, type MCPErrorReason } from '../../shared/memory-mcp-errors.js';
import type { CloudDocsHttpCredentials } from './cloud-docs-mcp-client.js';
import { loadDaemonCredential, type DaemonCredential } from './machine-mcp-deps.js';
import { createSessionSharedMachineAuthorityLoader } from './shared-machine-authority.js';

export interface CloudDocsCredentialResolutionOptions {
  serverUrl?: string;
  serverId?: string;
  token?: string;
  home?: string;
  env?: Record<string, string | undefined>;
  loadCredential?: (homeDir?: string) => Promise<DaemonCredential | null>;
  loadSharedMachineAuthority?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export type CloudDocsCredentialResolutionResult =
  | { status: 'ok'; credentials: CloudDocsHttpCredentials }
  | { status: 'error'; reason: MCPErrorReason; message: string };

export async function loadCloudDocsDaemonCredential(
  homeDir?: string,
  env: Record<string, string | undefined> = process.env,
): Promise<DaemonCredential | null> {
  const explicitHome = homeDir?.trim() || env.IMCODES_HOME?.trim();
  if (explicitHome) {
    try {
      const raw = await readFile(join(explicitHome, 'server.json'), 'utf8');
      const parsed = JSON.parse(raw) as Partial<{ serverId: string; token: string; workerUrl: string; serverUrl: string }>;
      const serverUrl = (parsed.workerUrl ?? parsed.serverUrl ?? '').trim();
      const serverId = (parsed.serverId ?? '').trim();
      const token = (parsed.token ?? '').trim();
      if (!serverId || !token || !serverUrl) return null;
      return { serverUrl, serverId, token };
    } catch {
      return null;
    }
  }
  if (env === process.env) {
    return loadDaemonCredential();
  }
  try {
    const raw = await readFile(join(resolveImcodesHome(env), 'server.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<{ serverId: string; token: string; workerUrl: string; serverUrl: string }>;
    const serverUrl = (parsed.workerUrl ?? parsed.serverUrl ?? '').trim();
    const serverId = (parsed.serverId ?? '').trim();
    const token = (parsed.token ?? '').trim();
    if (!serverId || !token || !serverUrl) return null;
    return { serverUrl, serverId, token };
  } catch {
    return null;
  }
}

/**
 * Resolve Cloud Docs HTTP credentials in strict priority order:
 * 1. Explicit CLI flags (--server-url / --server-id / --token)
 * 2. Environment variables (IMCODES_SERVER_URL / IMCODES_SERVER_ID / IMCODES_TOKEN)
 * 3. Daemon bound credential in --home / IMCODES_HOME / ~/.imcodes/server.json
 */
export async function resolveCloudDocsCredentials(
  options: CloudDocsCredentialResolutionOptions = {},
): Promise<CloudDocsCredentialResolutionResult> {
  const env = options.env ?? process.env;
  let serverUrl = options.serverUrl?.trim() || env.IMCODES_SERVER_URL?.trim() || '';
  let serverId = options.serverId?.trim() || env.IMCODES_SERVER_ID?.trim() || '';
  let token = options.token?.trim() || env.IMCODES_TOKEN?.trim() || '';

  if (!serverUrl || !serverId || !token) {
    const loader = options.loadCredential
      ?? ((homeDir?: string) => loadCloudDocsDaemonCredential(homeDir, env));
    const stored = await loader(options.home?.trim() || undefined);
    if (stored) {
      if (!serverUrl) serverUrl = stored.serverUrl.trim();
      if (!serverId) serverId = stored.serverId.trim();
      if (!token) token = stored.token.trim();
    }
  }

  const missing: string[] = [];
  if (!serverUrl) missing.push('serverUrl (--server-url / IMCODES_SERVER_URL)');
  if (!serverId) missing.push('serverId (--server-id / IMCODES_SERVER_ID)');
  if (!token) missing.push('token (--token / IMCODES_TOKEN)');
  if (missing.length > 0) {
    return {
      status: 'error',
      reason: MCP_ERROR_REASONS.FEATURE_DISABLED,
      message: `Cloud Docs credentials missing (${missing.join(', ')}) and no valid daemon binding found in server.json`,
    };
  }

  // Fail closed in any managed session/delegated context: direct shell CLI and
  // MCP passthrough share the exact same authority resolver, and explicit
  // --home / --token / env overrides must never bypass actor verification.
  const authorityLoader = options.loadSharedMachineAuthority
    ?? createSessionSharedMachineAuthorityLoader({ env: env as NodeJS.ProcessEnv });
  let sharedMachineAuthority: string | null = null;
  try {
    sharedMachineAuthority = await authorityLoader();
  } catch (err) {
    return {
      status: 'error',
      reason: MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE,
      message: err instanceof Error ? err.message : 'shared turn authority unavailable',
    };
  }

  return {
    status: 'ok',
    credentials: {
      serverUrl,
      serverId,
      token,
      ...(sharedMachineAuthority ? { sharedMachineAuthority } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  };
}

export interface CloudDocsCliExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  data?: unknown;
  errorReason?: MCPErrorReason;
}

export interface CloudDocsToolDeps {
  runCli: (argv: string[], opts?: { signal?: AbortSignal }) => Promise<CloudDocsCliExecutionResult>;
}

export interface DaemonCloudDocsToolDepsOverrides {
  loadCredential?: (homeDir?: string) => Promise<DaemonCredential | null>;
  loadSharedMachineAuthority?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

export function createDaemonCloudDocsToolDeps(
  overrides: DaemonCloudDocsToolDepsOverrides = {},
): CloudDocsToolDeps {
  return {
    async runCli(argv, opts) {
      const { runCloudDocsCli } = await import('../cli/cloud-docs.js');
      return runCloudDocsCli(argv, {
        ...(overrides.env ? { env: overrides.env } : {}),
        ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
        ...(overrides.loadCredential ? { loadCredential: overrides.loadCredential } : {}),
        ...(overrides.loadSharedMachineAuthority ? { loadSharedMachineAuthority: overrides.loadSharedMachineAuthority } : {}),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    },
  };
}
