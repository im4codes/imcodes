import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, constants as fsConstants, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { bindSharedProviderProcessResource, type AgentProcessResource } from './agent-process-resource.js';
import { parseNpmCmdShim, resolveBinaryOnWindows } from '../transport-paths.js';
import { PROVIDER_ERROR_CODES, type ProviderConfig, type ProviderError } from '../transport-provider.js';
import { killProcessTree } from '../../util/kill-process-tree.js';
import logger from '../../util/logger.js';
import type {
  OpenCodeClientLike,
  OpenCodeMcpServerSpec,
  OpenCodeSdkRuntimeStartResult,
  OpenCodeSdkStartOptions,
} from './opencode-sdk.js';

const execFileP = promisify(execFile);

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_CLI_PROBE_TIMEOUT_MS = 3_000;
const PLUGIN_WARMUP_POLL_MS = 75;
const OPENCODE_SERVER_USERNAME = 'opencode';

export const OPENCODE_TRANSPORT_MODES = {
  HOOK_OVERRIDE: 'hook-override',
  EMBEDDED: 'embedded',
  V2_CLI: 'v2-cli',
  V1_CLI: 'v1-cli',
} as const;

export type OpenCodeTransportMode = typeof OPENCODE_TRANSPORT_MODES[keyof typeof OPENCODE_TRANSPORT_MODES];
export type OpenCodeCliFamily = 'v1' | 'v2';

export interface OpenCodeCliLaunchPlan {
  resolvedPath: string;
  executable: string;
  prependArgs: string[];
  shell?: boolean;
}

export interface OpenCodeCliProbeResult {
  binaryPath: string;
  launchPlan: OpenCodeCliLaunchPlan;
  version: string;
  major: number;
  family: OpenCodeCliFamily;
}

export type OpenCodeTransportResolution =
  | { mode: typeof OPENCODE_TRANSPORT_MODES.HOOK_OVERRIDE; reason: string }
  | { mode: typeof OPENCODE_TRANSPORT_MODES.EMBEDDED; reason: string }
  | { mode: typeof OPENCODE_TRANSPORT_MODES.V2_CLI; cli: OpenCodeCliProbeResult }
  | { mode: typeof OPENCODE_TRANSPORT_MODES.V1_CLI; cli: OpenCodeCliProbeResult };

interface CachedProbeEntry {
  mtimeMs: number;
  size: number;
  launchKey: string;
  result: OpenCodeCliProbeResult;
}

const probeCache = new Map<string, CachedProbeEntry>();

export function resetOpenCodeCliCache(): void {
  probeCache.clear();
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function configError(message: string): ProviderError {
  return { code: PROVIDER_ERROR_CODES.CONFIG_ERROR, message, recoverable: false };
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

export function redactSecretText(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('[REDACTED]');
    const encoded = Buffer.from(`${OPENCODE_SERVER_USERNAME}:${secret}`).toString('base64');
    if (encoded) out = out.split(encoded).join('[REDACTED]');
  }
  out = out.replace(/Basic\s+[A-Za-z0-9+/=]{8,}/g, 'Basic [REDACTED]');
  return out;
}

function isExecutableFile(filePath: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return false;
    if (platform === 'win32') return true;
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function windowsPathExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  const list = raw
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));
  return list.length > 0 ? list : ['.EXE', '.CMD', '.BAT', '.COM'];
}

function resolveCandidateFile(candidate: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  if (!candidate) return null;
  if (platform === 'win32') {
    if (extname(candidate)) {
      return isExecutableFile(candidate, platform) ? resolve(candidate) : null;
    }
    for (const ext of windowsPathExtensions(env)) {
      const withExt = `${candidate}${ext.toLowerCase()}`;
      if (isExecutableFile(withExt, platform)) return resolve(withExt);
      const withUpperExt = `${candidate}${ext}`;
      if (withUpperExt !== withExt && isExecutableFile(withUpperExt, platform)) return resolve(withUpperExt);
    }
    return isExecutableFile(candidate, platform) ? resolve(candidate) : null;
  }
  return isExecutableFile(candidate, platform) ? resolve(candidate) : null;
}

function resolveCommandInDirs(
  name: string,
  dirs: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  for (const dir of dirs) {
    const trimmedDir = dir.trim().replace(/^"(.*)"$/, '$1');
    if (!trimmedDir) continue;
    const resolved = resolveCandidateFile(join(trimmedDir, name), env, platform);
    if (resolved) return resolved;
  }
  return null;
}

function resolveExplicitCandidate(
  spec: string | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  const trimmed = safeString(spec);
  if (!trimmed) return null;
  if (isAbsolute(trimmed) || trimmed.includes('/') || trimmed.includes('\\')) {
    return resolveCandidateFile(trimmed, env, platform);
  }
  const pathVar = env.PATH ?? env.Path ?? '';
  const pathDirs = pathVar.split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  return resolveCommandInDirs(trimmed, pathDirs, env, platform);
}

/** Parse additional Windows .cmd/.bat shim variants referencing %~dp0 / %dp0% script entrypoints. */
function parseWindowsCmdShimTarget(cmdPath: string): string | null {
  const parsed = parseNpmCmdShim(cmdPath);
  if (parsed && isExecutableFile(parsed, 'win32')) return parsed;
  let content: string;
  try {
    content = readFileSync(cmdPath, 'utf8');
  } catch {
    return parsed;
  }
  const dp0 = dirname(cmdPath);
  const altMatch = content.match(/"%(?:~)?dp0%?[\\/]([^"]+\.(?:js|mjs|cjs))"/i)
    ?? content.match(/%(?:~)?dp0%?[\\/]([^\s"]+\.(?:js|mjs|cjs))/i);
  if (!altMatch?.[1]) return parsed;
  const inner = altMatch[1].split(/[\\/]/).join(sep);
  return normalize(join(dp0, inner));
}

export function buildOpenCodeCliLaunchPlan(
  resolvedPath: string,
  options: { platform?: NodeJS.Platform; nodeExecutable?: string } = {},
): OpenCodeCliLaunchPlan {
  const platform = options.platform ?? process.platform;
  const nodeExe = options.nodeExecutable ?? process.execPath;
  const abs = resolve(resolvedPath);
  if (/\.(?:js|mjs|cjs)$/i.test(abs)) {
    return { resolvedPath: abs, executable: nodeExe, prependArgs: [abs] };
  }
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(abs)) {
    const scriptPath = parseWindowsCmdShimTarget(abs);
    if (scriptPath && isExecutableFile(scriptPath, platform)) {
      return { resolvedPath: abs, executable: nodeExe, prependArgs: [resolve(scriptPath)] };
    }
    return { resolvedPath: abs, executable: abs, prependArgs: [], shell: true };
  }
  return { resolvedPath: abs, executable: abs, prependArgs: [] };
}

export function resolveOpenCodeCliBinary(options: {
  binaryPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
} = {}): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = safeString(options.homeDir)
    ?? safeString(platform === 'win32' ? (env.USERPROFILE ?? env.HOME) : env.HOME)
    ?? homedir();

  // If explicit binaryPath is provided, it is authoritative (do not silently fall back to another binary).
  const explicitBinary = safeString(options.binaryPath);
  if (explicitBinary) {
    return resolveExplicitCandidate(explicitBinary, env, platform);
  }

  // If OPENCODE_BIN is explicitly provided, it is authoritative over PATH/defaults.
  const envBinary = safeString(env.OPENCODE_BIN);
  if (envBinary) {
    return resolveExplicitCandidate(envBinary, env, platform);
  }

  // 3. PATH lookup (with Windows PATHEXT support)
  const pathVar = env.PATH ?? env.Path ?? '';
  const pathDirs = pathVar.split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  const fromPath = resolveCommandInDirs('opencode', pathDirs, env, platform);
  if (fromPath) return fromPath;

  if (platform === 'win32' && !options.env && !options.platform) {
    const winResolved = resolveBinaryOnWindows('opencode');
    if (isAbsolute(winResolved) && isExecutableFile(winResolved, platform)) {
      return resolve(winResolved);
    }
  }

  // 4. Per-user / common install locations for sparse launchd / systemd PATHs
  const fallbackCandidates = platform === 'win32'
    ? [
        join(home, '.opencode', 'bin', 'opencode.exe'),
        ...(safeString(env.LOCALAPPDATA) ? [join(env.LOCALAPPDATA!.trim(), 'opencode', 'opencode.exe')] : []),
        join(home, 'AppData', 'Local', 'opencode', 'opencode.exe'),
      ]
    : [
        join(home, '.opencode', 'bin', 'opencode'),
        join(home, '.local', 'bin', 'opencode'),
        '/opt/homebrew/bin/opencode',
        '/usr/local/bin/opencode',
      ];

  for (const candidate of fallbackCandidates) {
    const found = resolveCandidateFile(candidate, env, platform);
    if (found) return found;
  }
  return null;
}

export function resolveOpenCodeCliLaunchPlan(options: {
  binaryPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  nodeExecutable?: string;
} = {}): OpenCodeCliLaunchPlan | null {
  const resolved = resolveOpenCodeCliBinary(options);
  if (!resolved) return null;
  return buildOpenCodeCliLaunchPlan(resolved, {
    platform: options.platform,
    nodeExecutable: options.nodeExecutable,
  });
}

export function classifyOpenCodeVersion(rawOutput: string): {
  version: string;
  major: number;
  family: OpenCodeCliFamily;
} | null {
  const match = rawOutput.match(/(?:^|[^\d.])v?(\d+)\.(\d+)\.(\d+(?:[-+][^\s]+)?)/i);
  if (!match) return null;
  const major = Number(match[1]);
  if (!Number.isInteger(major) || major < 0) return null;
  const version = `${match[1]}.${match[2]}.${match[3]}`;
  return {
    version,
    major,
    family: major >= 2 ? 'v2' : 'v1',
  };
}

export async function probeOpenCodeCli(
  target: string | OpenCodeCliLaunchPlan,
  options: {
    timeoutMs?: number;
    platform?: NodeJS.Platform;
    execProbe?: (executable: string, args: string[], timeoutMs: number, launchPlan: OpenCodeCliLaunchPlan) => Promise<string>;
  } = {},
): Promise<OpenCodeCliProbeResult | null> {
  const launchPlan = typeof target === 'string'
    ? buildOpenCodeCliLaunchPlan(target, { platform: options.platform })
    : target;

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(launchPlan.resolvedPath);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }

  const launchKey = JSON.stringify([launchPlan.executable, launchPlan.prependArgs, Boolean(launchPlan.shell)]);
  const cached = probeCache.get(launchPlan.resolvedPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.launchKey === launchKey) {
    return cached.result;
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_PROBE_TIMEOUT_MS;
  const probeArgs = [...launchPlan.prependArgs, '--version'];
  try {
    const rawOutput = options.execProbe
      ? await options.execProbe(launchPlan.executable, probeArgs, timeoutMs, launchPlan)
      : await (async () => {
          const { stdout, stderr } = await execFileP(launchPlan.executable, probeArgs, {
            timeout: timeoutMs,
            windowsHide: true,
            ...(launchPlan.shell ? { shell: true } : {}),
          });
          return `${stdout ?? ''}\n${stderr ?? ''}`;
        })();
    const classified = classifyOpenCodeVersion(rawOutput);
    if (!classified) return null;
    const result: OpenCodeCliProbeResult = {
      binaryPath: launchPlan.resolvedPath,
      launchPlan,
      ...classified,
    };
    probeCache.set(launchPlan.resolvedPath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      launchKey,
      result,
    });
    return result;
  } catch (error) {
    logger.warn({ provider: 'opencode-sdk', binaryPath: launchPlan.resolvedPath, error }, 'OpenCode CLI --version probe failed');
    return null;
  }
}

export async function resolveOpenCodeTransport(options: {
  hookOverridden: boolean;
  config?: ProviderConfig;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  timeoutMs?: number;
  execProbe?: NonNullable<Parameters<typeof probeOpenCodeCli>[1]>['execProbe'];
}): Promise<OpenCodeTransportResolution> {
  if (options.hookOverridden) {
    return { mode: OPENCODE_TRANSPORT_MODES.HOOK_OVERRIDE, reason: 'runtime-hook-override' };
  }
  const env = options.env ?? process.env;
  const explicitTransport = (
    safeString(options.config?.transport) ?? safeString(env.IMCODES_OPENCODE_TRANSPORT)
  )?.toLowerCase();

  const databasePath = safeString(options.config?.databasePath) ?? safeString(env.IMCODES_OPENCODE_DB_PATH);
  if (explicitTransport === 'embedded') {
    return { mode: OPENCODE_TRANSPORT_MODES.EMBEDDED, reason: 'explicit-embedded' };
  }
  if (databasePath && (!explicitTransport || explicitTransport === 'auto')) {
    return { mode: OPENCODE_TRANSPORT_MODES.EMBEDDED, reason: 'database-path' };
  }
  if (
    explicitTransport
    && explicitTransport !== 'auto'
    && explicitTransport !== 'cli'
    && explicitTransport !== OPENCODE_TRANSPORT_MODES.V1_CLI
    && explicitTransport !== OPENCODE_TRANSPORT_MODES.V2_CLI
  ) {
    throw configError(`Unsupported OpenCode transport setting: ${explicitTransport}`);
  }

  const explicitBinary = safeString(options.config?.binaryPath) ?? safeString(env.OPENCODE_BIN);
  const cliForced = Boolean(
    explicitBinary
    || explicitTransport === 'cli'
    || explicitTransport === OPENCODE_TRANSPORT_MODES.V1_CLI
    || explicitTransport === OPENCODE_TRANSPORT_MODES.V2_CLI,
  );

  const launchPlan = resolveOpenCodeCliLaunchPlan({
    binaryPath: safeString(options.config?.binaryPath),
    env,
    platform: options.platform,
    homeDir: options.homeDir,
  });
  if (!launchPlan) {
    if (cliForced) {
      throw configError(
        explicitBinary
          ? `Configured OpenCode CLI binary was not found or is not executable: ${explicitBinary}`
          : 'OpenCode CLI transport was requested, but no opencode CLI executable was found.',
      );
    }
    return { mode: OPENCODE_TRANSPORT_MODES.EMBEDDED, reason: 'cli-not-found' };
  }

  const probed = await probeOpenCodeCli(launchPlan, {
    timeoutMs: options.timeoutMs,
    platform: options.platform,
    execProbe: options.execProbe,
  });
  if (!probed) {
    if (cliForced) {
      throw configError(`OpenCode CLI --version probe failed for ${launchPlan.resolvedPath}`);
    }
    return { mode: OPENCODE_TRANSPORT_MODES.EMBEDDED, reason: 'cli-probe-failed' };
  }

  if (explicitTransport === OPENCODE_TRANSPORT_MODES.V1_CLI && probed.family !== 'v1') {
    throw configError(`Requested OpenCode v1-cli transport, but ${probed.binaryPath} reported v${probed.version}`);
  }
  if (explicitTransport === OPENCODE_TRANSPORT_MODES.V2_CLI && probed.family !== 'v2') {
    throw configError(`Requested OpenCode v2-cli transport, but ${probed.binaryPath} reported v${probed.version}`);
  }

  return probed.family === 'v2'
    ? { mode: OPENCODE_TRANSPORT_MODES.V2_CLI, cli: probed }
    : { mode: OPENCODE_TRANSPORT_MODES.V1_CLI, cli: probed };
}

function buildSanitizedCliConfig(rawConfig: Record<string, unknown> | undefined): string | undefined {
  if (!rawConfig) return undefined;
  const filtered = Object.fromEntries(
    Object.entries(rawConfig).filter(([key]) => key !== 'mcp' && key !== 'permissions'),
  );
  if (Object.keys(filtered).length === 0) return undefined;
  return JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...filtered });
}

function canonicalMcpIdentityKey(mcpServers: Record<string, OpenCodeMcpServerSpec> | undefined): string {
  if (!mcpServers || Object.keys(mcpServers).length === 0) return 'base';
  const sorted = Object.keys(mcpServers).sort().map((name) => {
    const spec = mcpServers[name]!;
    const sortedEnv = Object.keys(spec.environment ?? {}).sort().map((k) => [k, spec.environment[k]]);
    return [name, spec.type, spec.command, spec.disabled, sortedEnv];
  });
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    timer.unref?.();
  });
}

function createBoundedOperationSignal(
  parentSignal: AbortSignal,
  deadlineMs: number,
  timeoutMessage: string,
): { signal: AbortSignal; cleanup: () => void; errorForAbort: () => Error } {
  const controller = new AbortController();
  let timedOut = false;
  const remaining = Math.max(0, deadlineMs - Date.now());
  const onParentAbort = () => controller.abort();
  if (parentSignal.aborted) {
    controller.abort();
  } else {
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = remaining <= 0
    ? (() => {
        timedOut = true;
        controller.abort();
        return null;
      })()
    : (() => {
        const t = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, remaining);
        t.unref?.();
        return t;
      })();

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);
    },
    errorForAbort: () => {
      if (parentSignal.aborted) {
        const err = new Error('OpenCode startup aborted');
        err.name = 'AbortError';
        return err;
      }
      if (timedOut) {
        return new Error(timeoutMessage);
      }
      const err = new Error('OpenCode startup aborted');
      err.name = 'AbortError';
      return err;
    },
  };
}

function adaptOpenCodeV2PromiseClient(
  rawClient: Awaited<ReturnType<typeof import('@opencode/client/promise')['OpenCode']['make']>>,
): OpenCodeClientLike {
  const base = rawClient as unknown as Record<string, unknown>;
  return {
    ...(base as unknown as OpenCodeClientLike),
    sessions: {
      create: rawClient.session.create as unknown as OpenCodeClientLike['sessions']['create'],
      get: rawClient.session.get as unknown as OpenCodeClientLike['sessions']['get'],
      prompt: rawClient.session.prompt as unknown as OpenCodeClientLike['sessions']['prompt'],
    },
    model: {
      list: rawClient.model.list as unknown as OpenCodeClientLike['model']['list'],
      default: rawClient.model.default as unknown as OpenCodeClientLike['model']['default'],
    },
    provider: {
      list: rawClient.provider.list as unknown as OpenCodeClientLike['provider']['list'],
    },
    events: {
      subscribe: (_options, requestOptions) => rawClient.event.subscribe(
        requestOptions?.signal ? { signal: requestOptions.signal } : undefined,
      ) as unknown as ReturnType<OpenCodeClientLike['events']['subscribe']>,
    },
  };
}

interface SharedV2CliHostEntry {
  key: string;
  url: string;
  password: string;
  child: ChildProcess;
  processResource: AgentProcessResource;
  client: OpenCodeClientLike;
  rawClient: Awaited<ReturnType<typeof import('@opencode/client/promise')['OpenCode']['make']>>;
  sessionMcpBindings: Map<string, { directory: string; servers: Map<string, string> }>;
  mcpLock: Promise<void>;
  eventConsumers: Map<symbol, {
    listener: (event: Record<string, any>) => void;
    onError: (error: unknown) => void;
  }>;
  eventAbort: AbortController | null;
  eventLoop: Promise<void> | null;
  eventStartPromise: Promise<void> | null;
  refCount: number;
  closed: boolean;
  closePromise: Promise<void> | null;
}

const sharedV2CliHosts = new Map<string, SharedV2CliHostEntry>();
const sharedV2CliLocks = new Map<string, Promise<void>>();

async function withSharedV2CliLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = sharedV2CliLocks.get(key) ?? Promise.resolve();
  let releaseLock!: () => void;
  const gate = new Promise<void>((resolveLock) => {
    releaseLock = resolveLock;
  });
  const chained = prev.catch(() => {}).then(() => gate);
  sharedV2CliLocks.set(key, chained);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    releaseLock();
    if (sharedV2CliLocks.get(key) === chained) {
      sharedV2CliLocks.delete(key);
    }
  }
}

async function terminateCliChild(child: ChildProcess, processResource: AgentProcessResource): Promise<void> {
  await killProcessTree(child).catch(() => {});
  await processResource.release().catch(() => {});
}

async function spawnV2ServeProcess(options: {
  launchPlan: OpenCodeCliLaunchPlan;
  hostname: string;
  port: number;
  deadlineMs: number;
  signal: AbortSignal;
  configJson?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  url: string;
  password: string;
  child: ChildProcess;
  processResource: AgentProcessResource;
}> {
  if (!isLoopbackHostname(options.hostname)) {
    throw new Error(`OpenCode CLI serve refused non-loopback hostname: ${options.hostname}`);
  }
  const remaining = Math.max(0, options.deadlineMs - Date.now());
  if (options.signal.aborted) {
    const abortErr = new Error('OpenCode CLI v2 startup aborted');
    abortErr.name = 'AbortError';
    throw abortErr;
  }
  if (remaining <= 0) {
    throw new Error('Timed out waiting for OpenCode CLI v2 serve');
  }

  const password = randomBytes(24).toString('base64url');
  const spawnEnv: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    OPENCODE_SERVER_USERNAME,
    OPENCODE_SERVER_PASSWORD: password,
    ...(options.configJson ? { OPENCODE_CONFIG_CONTENT: options.configJson } : {}),
  };

  const args = [
    ...options.launchPlan.prependArgs,
    'serve',
    '--hostname',
    options.hostname,
    '--port',
    String(options.port),
  ];
  const child = spawn(
    options.launchPlan.executable,
    args,
    {
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(options.launchPlan.shell ? { shell: true } : {}),
    },
  );
  const processResource = bindSharedProviderProcessResource('opencode-sdk', child);

  const serverUrl = await new Promise<string>((resolveUrl, rejectUrl) => {
    let settled = false;
    let output = '';
    const cleanupListeners = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onChunk);
      child.stderr?.off('data', onChunk);
      child.off('exit', onExit);
      child.off('error', onError);
      options.signal.removeEventListener('abort', onAbort);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      void terminateCliChild(child, processResource).finally(() => {
        rejectUrl(err);
      });
    };
    const onAbort = () => {
      const abortErr = new Error('OpenCode CLI v2 startup aborted');
      abortErr.name = 'AbortError';
      fail(abortErr);
    };
    const onError = (err: Error) => {
      fail(new Error(redactSecretText(`OpenCode CLI v2 failed to start: ${err.message}`, [password])));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const tail = redactSecretText(output.trim().slice(-400), [password]);
      fail(new Error(`OpenCode CLI v2 exited before ready (code=${code ?? 'null'}, signal=${signal ?? 'null'})${tail ? `: ${tail}` : ''}`));
    };
    const onChunk = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.length > 16_384) output = output.slice(-8_192);
      const match = output.match(/listening on (https?:\/\/[^\s]+)/i)
        ?? output.match(/(https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+)/i);
      if (!match) return;
      const candidate = match[1]!;
      let parsed: URL;
      try {
        parsed = new URL(candidate);
      } catch {
        return;
      }
      if (!isLoopbackHostname(parsed.hostname)) {
        fail(new Error(`OpenCode CLI v2 server bound to non-loopback host: ${parsed.hostname}`));
        return;
      }
      settled = true;
      cleanupListeners();
      resolveUrl(parsed.origin);
    };

    if (options.signal.aborted) {
      onAbort();
      return;
    }
    const timer = setTimeout(() => {
      const tail = redactSecretText(output.trim().slice(-400), [password]);
      fail(new Error(`Timed out waiting for OpenCode CLI v2 serve (${remaining}ms)${tail ? `: ${tail}` : ''}`));
    }, remaining);
    timer.unref?.();

    options.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.once('error', onError);
    child.once('exit', onExit);
  });

  return { url: serverUrl, password, child, processResource };
}

export async function startOpenCodeV2CliHost(
  options: OpenCodeSdkStartOptions & {
    binaryPath: string;
    launchPlan?: OpenCodeCliLaunchPlan;
    env?: NodeJS.ProcessEnv;
  },
): Promise<OpenCodeSdkRuntimeStartResult> {
  if (options.signal.aborted) {
    const abortErr = new Error('OpenCode startup aborted');
    abortErr.name = 'AbortError';
    throw abortErr;
  }

  const launchPlan = options.launchPlan ?? buildOpenCodeCliLaunchPlan(options.binaryPath);
  const mcpIdentityKey = canonicalMcpIdentityKey(options.mcpServers);
  const hostKey = `v2-cli:${launchPlan.resolvedPath}:${options.hostGroupKey?.trim() || 'default'}:${mcpIdentityKey}`;
  const configJson = buildSanitizedCliConfig(options.config);
  const timeout = options.timeout || 10_000;
  const deadlineMs = Date.now() + timeout;

  const entry = await withSharedV2CliLock(hostKey, async () => {
    if (options.signal.aborted) {
      const abortErr = new Error('OpenCode startup aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    const existing = sharedV2CliHosts.get(hostKey);
    if (existing) {
      if (existing.closePromise) {
        await existing.closePromise.catch(() => {});
        if (sharedV2CliHosts.get(hostKey) === existing) {
          sharedV2CliHosts.delete(hostKey);
        }
      } else if (!existing.closed && existing.child.exitCode === null && existing.child.signalCode === null) {
        existing.refCount += 1;
        return existing;
      } else {
        sharedV2CliHosts.delete(hostKey);
      }
    }

    const spawned = await spawnV2ServeProcess({
      launchPlan,
      hostname: options.hostname || LOOPBACK_HOST,
      port: options.port || 0,
      deadlineMs,
      signal: options.signal,
      configJson,
      env: options.env,
    });

    const { OpenCode } = await import('@opencode/client/promise');
    const authHeader = `Basic ${Buffer.from(`${OPENCODE_SERVER_USERNAME}:${spawned.password}`).toString('base64')}`;
    const rawClient = OpenCode.make({
      baseUrl: spawned.url,
      headers: { Authorization: authHeader },
    });

    const infoOp = createBoundedOperationSignal(
      options.signal,
      deadlineMs,
      `Timed out waiting for OpenCode CLI v2 server.info (${timeout}ms)`,
    );
    try {
      const info = await rawClient.server.info({ signal: infoOp.signal });
      if (infoOp.signal.aborted) throw infoOp.errorForAbort();
      if (info && Array.isArray(info.urls) && info.urls.length > 0) {
        for (const u of info.urls) {
          const parsed = new URL(u);
          if (!isLoopbackHostname(parsed.hostname)) {
            throw new Error(`OpenCode CLI v2 reported non-loopback URL: ${parsed.hostname}`);
          }
        }
      }
    } catch (error) {
      await terminateCliChild(spawned.child, spawned.processResource);
      if (infoOp.signal.aborted) throw infoOp.errorForAbort();
      const msg = redactSecretText(error instanceof Error ? error.message : String(error), [spawned.password]);
      throw new Error(`OpenCode CLI v2 server health verification failed: ${msg}`);
    } finally {
      infoOp.cleanup();
    }

    const client = adaptOpenCodeV2PromiseClient(rawClient);
    const created: SharedV2CliHostEntry = {
      key: hostKey,
      url: spawned.url,
      password: spawned.password,
      child: spawned.child,
      processResource: spawned.processResource,
      client,
      rawClient,
      sessionMcpBindings: new Map(),
      mcpLock: Promise.resolve(),
      eventConsumers: new Map(),
      eventAbort: null,
      eventLoop: null,
      eventStartPromise: null,
      refCount: 1,
      closed: false,
      closePromise: null,
    };

    spawned.child.once('exit', (code, signal) => {
      if (created.closed || created.closePromise) return;
      created.closed = true;
      if (sharedV2CliHosts.get(hostKey) === created) {
        sharedV2CliHosts.delete(hostKey);
      }
      created.eventAbort?.abort();
      const err = new Error(`OpenCode CLI v2 server exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      for (const consumer of [...created.eventConsumers.values()]) {
        try {
          consumer.onError(err);
        } catch {
          // ignore consumer failure during teardown
        }
      }
      created.eventConsumers.clear();
    });

    sharedV2CliHosts.set(hostKey, created);
    return created;
  });

  const stopHostEvents = async (): Promise<void> => {
    const pendingStart = entry.eventStartPromise;
    const abort = entry.eventAbort;
    const loop = entry.eventLoop;
    entry.eventStartPromise = null;
    entry.eventAbort = null;
    entry.eventLoop = null;
    abort?.abort();
    if (pendingStart) await pendingStart.catch(() => {});
    if (loop) await loop.catch(() => {});
  };

  const ensureHostEventLoop = async (): Promise<void> => {
    if (entry.closed) throw new Error('OpenCode CLI v2 server is closed');
    if (entry.eventLoop && entry.eventAbort && !entry.eventAbort.signal.aborted) return;
    if (entry.eventStartPromise) {
      await entry.eventStartPromise;
      return;
    }
    const eventAbort = new AbortController();
    entry.eventAbort = eventAbort;
    const startPromise = (async () => {
      const subscription = await entry.client.events.subscribe({}, { signal: eventAbort.signal });
      if (eventAbort.signal.aborted || entry.eventConsumers.size === 0) {
        const earlyStream = 'stream' in subscription ? subscription.stream : subscription;
        void earlyStream[Symbol.asyncIterator]().return?.().catch(() => {});
        return;
      }
      const stream = 'stream' in subscription ? subscription.stream : subscription;
      entry.eventLoop = (async () => {
        const iterator = stream[Symbol.asyncIterator]();
        let abortListener: (() => void) | null = null;
        try {
          const abortPromise = new Promise<{ aborted: true }>((resolveAbort) => {
            if (eventAbort.signal.aborted) {
              resolveAbort({ aborted: true });
              return;
            }
            abortListener = () => {
              void iterator.return?.().catch(() => {});
              resolveAbort({ aborted: true });
            };
            eventAbort.signal.addEventListener('abort', abortListener, { once: true });
          });

          while (!eventAbort.signal.aborted) {
            const step = await Promise.race([
              iterator.next().then((result: IteratorResult<Record<string, any>>) => ({ aborted: false as const, result })),
              abortPromise,
            ]);
            if (step.aborted || eventAbort.signal.aborted) return;
            if (step.result.done) {
              throw new Error('OpenCode CLI v2 event stream ended');
            }
            for (const consumer of [...entry.eventConsumers.values()]) {
              try {
                consumer.listener(step.result.value);
              } catch (listenerError) {
                logger.warn({ provider: 'opencode-sdk', error: listenerError }, 'OpenCode event consumer listener threw');
              }
            }
          }
        } catch (error) {
          if (eventAbort.signal.aborted) return;
          const redacted = new Error(redactSecretText(error instanceof Error ? error.message : String(error), [entry.password]));
          for (const consumer of [...entry.eventConsumers.values()]) {
            consumer.onError(redacted);
          }
        } finally {
          if (abortListener) eventAbort.signal.removeEventListener('abort', abortListener);
          if (eventAbort.signal.aborted) {
            void iterator.return?.().catch(() => {});
          }
          if (entry.eventAbort === eventAbort) {
            entry.eventAbort = null;
            entry.eventLoop = null;
          }
          if (!eventAbort.signal.aborted && !entry.closed && !entry.closePromise && entry.eventConsumers.size > 0) {
            void ensureHostEventLoop().catch((recoverError) => {
              logger.debug({ provider: 'opencode-sdk', error: recoverError }, 'OpenCode CLI v2 event feed reconnect deferred');
            });
          }
        }
      })();
    })().catch((error) => {
      if (entry.eventAbort === eventAbort) {
        entry.eventAbort = null;
        entry.eventLoop = null;
      }
      throw new Error(redactSecretText(error instanceof Error ? error.message : String(error), [entry.password]));
    }).finally(() => {
      if (entry.eventStartPromise === startPromise) {
        entry.eventStartPromise = null;
      }
    });
    entry.eventStartPromise = startPromise;
    await startPromise;
  };

  const subscribeEvents: NonNullable<OpenCodeSdkRuntimeStartResult['subscribeEvents']> = async (
    consumerId,
    listener,
    onError,
  ) => {
    entry.eventConsumers.set(consumerId, { listener, onError });
    try {
      await ensureHostEventLoop();
    } catch (error) {
      entry.eventConsumers.delete(consumerId);
      if (entry.eventConsumers.size === 0) await stopHostEvents();
      throw error;
    }
    return async () => {
      entry.eventConsumers.delete(consumerId);
      if (entry.eventConsumers.size === 0) {
        await stopHostEvents();
      }
    };
  };

  const withMcpLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = entry.mcpLock;
    let release!: () => void;
    entry.mcpLock = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
    }
  };

  const bindSessionMcp: NonNullable<OpenCodeSdkRuntimeStartResult['bindSessionMcp']> = async (
    providerSessionId,
    directory,
    mcpServers,
  ) => {
    await withMcpLock(async () => {
      if (entry.closed) return;
      const dirKey = resolve(directory);
      const prevBinding = entry.sessionMcpBindings.get(providerSessionId);
      const nextServers = new Map<string, string>();
      for (const [server, serverConfig] of Object.entries(mcpServers)) {
        const signature = JSON.stringify(serverConfig);
        nextServers.set(server, signature);
        const alreadySame = prevBinding?.directory === dirKey && prevBinding.servers.get(server) === signature;
        if (!alreadySame && entry.rawClient.experimental?.mcp?.add) {
          await entry.rawClient.experimental.mcp.add({
            server,
            location: { directory: dirKey },
            config: { ...serverConfig },
          });
        }
      }
      if (prevBinding) {
        for (const oldServer of prevBinding.servers.keys()) {
          if (prevBinding.directory === dirKey && nextServers.has(oldServer)) continue;
          const stillUsedElsewhere = [...entry.sessionMcpBindings.entries()].some(
            ([sid, b]) => sid !== providerSessionId && b.directory === prevBinding.directory && b.servers.has(oldServer),
          );
          if (!stillUsedElsewhere && entry.rawClient.experimental?.mcp?.remove) {
            await entry.rawClient.experimental.mcp.remove({
              server: oldServer,
              location: { directory: prevBinding.directory },
            }).catch(() => {});
          }
        }
      }
      entry.sessionMcpBindings.set(providerSessionId, { directory: dirKey, servers: nextServers });
    });
  };

  const unbindSessionMcp: NonNullable<OpenCodeSdkRuntimeStartResult['unbindSessionMcp']> = async (
    providerSessionId,
  ) => {
    await withMcpLock(async () => {
      const existing = entry.sessionMcpBindings.get(providerSessionId);
      if (!existing) return;
      entry.sessionMcpBindings.delete(providerSessionId);
      if (entry.closed) return;
      for (const server of existing.servers.keys()) {
        const stillUsed = [...entry.sessionMcpBindings.values()].some(
          (b) => b.directory === existing.directory && b.servers.has(server),
        );
        if (!stillUsed && entry.rawClient.experimental?.mcp?.remove) {
          await entry.rawClient.experimental.mcp.remove({
            server,
            location: { directory: existing.directory },
          }).catch(() => {});
        }
      }
    });
  };

  let releasePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (releasePromise) return releasePromise;
    releasePromise = withSharedV2CliLock(hostKey, async () => {
      if (entry.closePromise) {
        await entry.closePromise.catch(() => {});
        return;
      }
      entry.refCount = Math.max(0, entry.refCount - 1);
      if (entry.refCount > 0 || entry.closed) return;
      entry.closed = true;
      const closing = (async () => {
        entry.eventConsumers.clear();
        entry.sessionMcpBindings.clear();
        await stopHostEvents();
        await terminateCliChild(entry.child, entry.processResource);
      })().finally(() => {
        if (sharedV2CliHosts.get(hostKey) === entry) {
          sharedV2CliHosts.delete(hostKey);
        }
      });
      entry.closePromise = closing;
      await closing;
    });
    return releasePromise;
  };

  if (options.signal.aborted) {
    await close();
    const abortErr = new Error('OpenCode startup aborted');
    abortErr.name = 'AbortError';
    throw abortErr;
  }
  options.signal.addEventListener('abort', () => {
    void close();
  }, { once: true });

  if (options.warmupCatalog && Date.now() < deadlineMs) {
    const warmupLocation = { directory: safeString(options.directory) ?? process.cwd() };
    while (Date.now() < deadlineMs && !options.signal.aborted) {
      const op = createBoundedOperationSignal(
        options.signal,
        deadlineMs,
        `Timed out waiting for OpenCode CLI v2 catalog warmup (${timeout}ms)`,
      );
      try {
        const [providersRes, modelsRes] = await Promise.all([
          entry.rawClient.provider.list({ location: warmupLocation }, { signal: op.signal }),
          entry.rawClient.model.list({ location: warmupLocation }, { signal: op.signal }),
        ]);
        if (op.signal.aborted) throw op.errorForAbort();
        if ((providersRes?.data?.length ?? 0) > 0 && (modelsRes?.data?.length ?? 0) > 0) break;
      } catch (err) {
        if (op.signal.aborted) {
          op.cleanup();
          await close();
          throw op.errorForAbort();
        }
        op.cleanup();
        break;
      }
      op.cleanup();
      if (Date.now() >= deadlineMs || options.signal.aborted) break;
      await sleep(Math.min(PLUGIN_WARMUP_POLL_MS, Math.max(0, deadlineMs - Date.now())));
    }
    if (options.signal.aborted) {
      await close();
      const abortErr = new Error('OpenCode startup aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
  }

  return {
    client: entry.client,
    server: { url: entry.url, close },
    subscribeEvents,
    ensureEvents: ensureHostEventLoop,
    bindSessionMcp,
    unbindSessionMcp,
  };
}

function collectErrorExplicitProvider(error: unknown): string | undefined {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  for (let depth = 0; pending.length > 0 && depth < 8; depth++) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const rec = current as Record<string, unknown>;
    const providerId = safeString(rec.providerID ?? rec.providerId);
    if (providerId) return providerId.toLowerCase();
    if (rec.data !== undefined) pending.push(rec.data);
    if (rec.cause !== undefined) pending.push(rec.cause);
  }
  return undefined;
}

function collectErrorCode(error: unknown): string | undefined {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  for (let depth = 0; pending.length > 0 && depth < 8; depth++) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const rec = current as Record<string, unknown>;
    const code = safeString(rec.code);
    if (code) return code.toLowerCase();
    if (rec.data !== undefined) pending.push(rec.data);
    if (rec.cause !== undefined) pending.push(rec.cause);
  }
  return undefined;
}

function collectErrorStatus(error: unknown): number | undefined {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  for (let depth = 0; pending.length > 0 && depth < 8; depth++) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const rec = current as Record<string, unknown>;
    if (typeof rec.status === 'number' && Number.isFinite(rec.status)) return rec.status;
    if (typeof rec.statusCode === 'number' && Number.isFinite(rec.statusCode)) return rec.statusCode;
    if (rec.data !== undefined) pending.push(rec.data);
    if (rec.response !== undefined) pending.push(rec.response);
    if (rec.cause !== undefined) pending.push(rec.cause);
  }
  return undefined;
}

function collectErrorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return String(error);
  const parts: string[] = [];
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  for (let depth = 0; pending.length > 0 && depth < 8; depth++) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const rec = current as Record<string, unknown>;
    if (typeof rec.message === 'string') parts.push(rec.message);
    if (typeof rec.responseBody === 'string') parts.push(rec.responseBody);
    if (typeof rec.body === 'string') parts.push(rec.body);
    if (rec.data !== undefined) pending.push(rec.data);
    if (rec.cause !== undefined) pending.push(rec.cause);
  }
  return parts.join('\n');
}

export function isExpiredOpenCodeAuthError(error: unknown, sessionProviderId: string | undefined): boolean {
  const explicitProvider = collectErrorExplicitProvider(error);
  const normalizedSessionProvider = sessionProviderId?.trim().toLowerCase();
  if (normalizedSessionProvider !== undefined && normalizedSessionProvider !== 'opencode') return false;
  if (explicitProvider !== undefined && explicitProvider !== 'opencode') return false;
  if ((explicitProvider ?? normalizedSessionProvider) !== 'opencode') return false;

  const status = collectErrorStatus(error);
  if (status !== undefined && status !== 401) return false;

  const errorType = error && typeof error === 'object'
    ? safeString((error as { type?: unknown }).type)?.toLowerCase() ?? ''
    : '';
  const errorName = error && typeof error === 'object'
    ? safeString((error as { name?: unknown }).name)?.toLowerCase() ?? ''
    : '';
  const code = collectErrorCode(error);
  const combined = collectErrorText(error).toLowerCase();

  const is401 = status === 401;
  const isStatuslessSdkAuth = status === undefined && (errorType === 'provider.auth' || errorName.includes('providerautherror'));
  const hasExpiredKeyMarker = code === 'api_key_expired'
    || /\bapi_key_expired\b/.test(combined)
    || /\bapi[_ ]?key[^a-z0-9]{1,8}expired\b/.test(combined);
  return (is401 || isStatuslessSdkAuth) && hasExpiredKeyMarker;
}

export async function hasSessionInOpenCodeSqliteDb(
  sessionId: string,
  dbPaths: readonly string[],
): Promise<boolean> {
  if (!sessionId.trim() || dbPaths.length === 0) return false;
  let DatabaseSyncCtor: typeof import('node:sqlite')['DatabaseSync'];
  try {
    ({ DatabaseSync: DatabaseSyncCtor } = await import('node:sqlite'));
  } catch {
    return false;
  }
  for (const dbFile of dbPaths) {
    let db: import('node:sqlite').DatabaseSync | null = null;
    try {
      db = new DatabaseSyncCtor(dbFile, { readOnly: true });
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session', 'session_v2')").all() as Array<{ name: string }>)
          .map((t) => t.name),
      );
      if (tables.has('session_v2')) {
        const foundV2 = db.prepare('SELECT 1 AS found FROM session_v2 WHERE id = ? LIMIT 1').get(sessionId) as { found?: number } | undefined;
        if (foundV2) return true;
      }
      if (tables.has('session')) {
        const foundV1 = db.prepare('SELECT 1 AS found FROM session WHERE id = ? LIMIT 1').get(sessionId) as { found?: number } | undefined;
        if (foundV1) return true;
      }
    } catch {
      // Ignore corrupt/unreadable candidate and continue searching
    } finally {
      try {
        db?.close();
      } catch {
        // ignore close errors
      }
    }
  }
  return false;
}
