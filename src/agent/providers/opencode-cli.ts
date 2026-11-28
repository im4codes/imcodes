import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { bindSharedProviderProcessResource, type AgentProcessResource } from './agent-process-resource.js';
import { resolveBinaryOnWindows } from '../transport-paths.js';
import type { ProviderConfig } from '../transport-provider.js';
import { killProcessTree } from '../../util/kill-process-tree.js';
import logger from '../../util/logger.js';
import type {
  OpenCodeClientLike,
  OpenCodeSdkRuntimeStartResult,
  OpenCodeSdkStartOptions,
} from './opencode-sdk.js';

const execFileP = promisify(execFile);

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_CLI_PROBE_TIMEOUT_MS = 3_000;
const PLUGIN_WARMUP_MAX_WAIT_MS = 4_000;
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

export interface OpenCodeCliProbeResult {
  binaryPath: string;
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
  result: OpenCodeCliProbeResult;
}

const probeCache = new Map<string, CachedProbeEntry>();

export function resetOpenCodeCliCache(): void {
  probeCache.clear();
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
      return isExecutableFile(candidate, platform) ? candidate : null;
    }
    for (const ext of windowsPathExtensions(env)) {
      const withExt = `${candidate}${ext.toLowerCase()}`;
      if (isExecutableFile(withExt, platform)) return withExt;
      const withUpperExt = `${candidate}${ext}`;
      if (withUpperExt !== withExt && isExecutableFile(withUpperExt, platform)) return withUpperExt;
    }
    return isExecutableFile(candidate, platform) ? candidate : null;
  }
  return isExecutableFile(candidate, platform) ? candidate : null;
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

  // 1. Explicit binaryPath config
  const explicit = resolveExplicitCandidate(options.binaryPath, env, platform);
  if (explicit) return explicit;

  // 2. OPENCODE_BIN environment variable
  const fromEnvVar = resolveExplicitCandidate(env.OPENCODE_BIN, env, platform);
  if (fromEnvVar) return fromEnvVar;

  // 3. PATH lookup (with Windows PATHEXT support)
  const pathVar = env.PATH ?? env.Path ?? '';
  const pathDirs = pathVar.split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  const fromPath = resolveCommandInDirs('opencode', pathDirs, env, platform);
  if (fromPath) return fromPath;

  // Use shared Windows resolver when running live on win32 without synthetic overrides.
  if (platform === 'win32' && !options.env && !options.platform) {
    const winResolved = resolveBinaryOnWindows('opencode');
    if (isAbsolute(winResolved) && isExecutableFile(winResolved, platform)) {
      return winResolved;
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
  binaryPath: string,
  options: {
    timeoutMs?: number;
    execProbe?: (bin: string, timeoutMs: number) => Promise<string>;
  } = {},
): Promise<OpenCodeCliProbeResult | null> {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(binaryPath);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }

  const cached = probeCache.get(binaryPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.result;
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_PROBE_TIMEOUT_MS;
  try {
    const rawOutput = options.execProbe
      ? await options.execProbe(binaryPath, timeoutMs)
      : await (async () => {
          const { stdout, stderr } = await execFileP(binaryPath, ['--version'], {
            timeout: timeoutMs,
            windowsHide: true,
          });
          return `${stdout ?? ''}\n${stderr ?? ''}`;
        })();
    const classified = classifyOpenCodeVersion(rawOutput);
    if (!classified) return null;
    const result: OpenCodeCliProbeResult = {
      binaryPath,
      ...classified,
    };
    probeCache.set(binaryPath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      result,
    });
    return result;
  } catch (error) {
    logger.warn({ provider: 'opencode-sdk', binaryPath, error }, 'OpenCode CLI --version probe failed');
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
}): Promise<OpenCodeTransportResolution> {
  if (options.hookOverridden) {
    return { mode: OPENCODE_TRANSPORT_MODES.HOOK_OVERRIDE, reason: 'runtime-hook-override' };
  }
  const env = options.env ?? process.env;
  const databasePath = safeString(options.config?.databasePath) ?? safeString(env.IMCODES_OPENCODE_DB_PATH);
  if (databasePath) {
    return { mode: OPENCODE_TRANSPORT_MODES.EMBEDDED, reason: 'database-path' };
  }
  const transportOverride = (
    safeString(options.config?.transport) ?? safeString(env.IMCODES_OPENCODE_TRANSPORT)
  )?.toLowerCase();
  if (transportOverride === 'embedded') {
    return { mode: OPENCODE_TRANSPORT_MODES.EMBEDDED, reason: 'explicit-embedded' };
  }

  const binaryPath = resolveOpenCodeCliBinary({
    binaryPath: safeString(options.config?.binaryPath),
    env,
    platform: options.platform,
    homeDir: options.homeDir,
  });
  if (!binaryPath) {
    return { mode: OPENCODE_TRANSPORT_MODES.EMBEDDED, reason: 'cli-not-found' };
  }

  const probed = await probeOpenCodeCli(binaryPath, { timeoutMs: options.timeoutMs });
  if (!probed) {
    return { mode: OPENCODE_TRANSPORT_MODES.EMBEDDED, reason: 'cli-probe-failed' };
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

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    timer.unref?.();
  });
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

async function spawnV2ServeProcess(options: {
  binaryPath: string;
  hostname: string;
  port: number;
  timeout: number;
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
  const password = randomBytes(24).toString('base64url');
  const spawnEnv: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    OPENCODE_SERVER_USERNAME,
    OPENCODE_SERVER_PASSWORD: password,
    ...(options.configJson ? { OPENCODE_CONFIG_CONTENT: options.configJson } : {}),
  };

  const child = spawn(
    options.binaryPath,
    ['serve', '--hostname', options.hostname, '--port', String(options.port)],
    {
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
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
      void killProcessTree(child).catch(() => {}).finally(() => {
        void processResource.release().catch(() => {});
      });
      rejectUrl(err);
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
      fail(new Error(`Timed out waiting for OpenCode CLI v2 serve (${options.timeout}ms)${tail ? `: ${tail}` : ''}`));
    }, options.timeout);
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
  options: OpenCodeSdkStartOptions & { binaryPath: string; env?: NodeJS.ProcessEnv },
): Promise<OpenCodeSdkRuntimeStartResult> {
  if (options.signal.aborted) {
    const abortErr = new Error('OpenCode startup aborted');
    abortErr.name = 'AbortError';
    throw abortErr;
  }

  const hostKey = `v2-cli:${resolve(options.binaryPath)}:${options.hostGroupKey?.trim() || 'default'}`;
  const configJson = buildSanitizedCliConfig(options.config);

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

    const timeout = options.timeout || 10_000;
    const spawned = await spawnV2ServeProcess({
      binaryPath: options.binaryPath,
      hostname: options.hostname || LOOPBACK_HOST,
      port: options.port || 0,
      timeout,
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

    try {
      const info = await rawClient.server.info();
      if (info && Array.isArray(info.urls) && info.urls.length > 0) {
        for (const u of info.urls) {
          const parsed = new URL(u);
          if (!isLoopbackHostname(parsed.hostname)) {
            throw new Error(`OpenCode CLI v2 reported non-loopback URL: ${parsed.hostname}`);
          }
        }
      }
    } catch (error) {
      await killProcessTree(spawned.child).catch(() => {});
      await spawned.processResource.release().catch(() => {});
      const msg = redactSecretText(error instanceof Error ? error.message : String(error), [spawned.password]);
      throw new Error(`OpenCode CLI v2 server health verification failed: ${msg}`);
    }

    const client = adaptOpenCodeV2PromiseClient(rawClient);
    const created: SharedV2CliHostEntry = {
      key: hostKey,
      url: spawned.url,
      password: spawned.password,
      child: spawned.child,
      processResource: spawned.processResource,
      client,
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
        await stopHostEvents();
        await killProcessTree(entry.child).catch(() => {});
        await entry.processResource.release().catch(() => {});
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

  if (options.warmupCatalog) {
    const warmupLocation = { directory: safeString(options.directory) ?? process.cwd() };
    const warmupMs = Math.min(options.timeout || 10_000, PLUGIN_WARMUP_MAX_WAIT_MS);
    const deadline = Date.now() + warmupMs;
    while (Date.now() < deadline && !options.signal.aborted) {
      try {
        const [providersRes, modelsRes] = await Promise.all([
          entry.client.provider.list({ location: warmupLocation }),
          entry.client.model.list({ location: warmupLocation }),
        ]);
        if ((providersRes?.data?.length ?? 0) > 0 && (modelsRes?.data?.length ?? 0) > 0) break;
      } catch {
        break;
      }
      await sleep(PLUGIN_WARMUP_POLL_MS);
    }
  }

  return {
    client: entry.client,
    server: { url: entry.url, close },
    subscribeEvents,
    ensureEvents: ensureHostEventLoop,
  };
}
