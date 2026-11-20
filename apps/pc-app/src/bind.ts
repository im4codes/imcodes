import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeServerOrigin } from './servers.js';

/** Matches shared/cookie-names.ts COOKIE_SESSION without breaking pc-app's rootDir. */
export const COOKIE_SESSION = 'rcc_session';

export interface ServerCredentials {
  serverId: string;
  token: string;
  workerUrl: string;
  serverName: string;
  boundAt: number;
}

export interface BoundServerSummary {
  serverName: string;
  workerUrl: string;
}

export interface CookieLike {
  name: string;
  value?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
}

export interface CookiesChangeEventLike {
  on(
    event: 'changed',
    listener: (
      event: unknown,
      cookie: CookieLike,
      cause: unknown,
      removed: boolean,
    ) => void,
  ): unknown;
  get(filter: { url: string; name: string }): Promise<CookieLike[]>;
}

export interface BindMessageBoxOptions {
  type: 'info' | 'question' | 'warning' | 'error';
  title: string;
  message: string;
  detail?: string;
  buttons: string[];
  defaultId?: number;
  cancelId?: number;
}

export type BindErrorKind =
  | 'mint_key_unknown'
  | 'mint_key_rejected'
  | 'cli_failed_revoked'
  | 'cli_failed_uncertain';

export class BindError extends Error {
  readonly kind: BindErrorKind;
  readonly keyId?: string;
  readonly manualCommand?: string;
  readonly stderr?: string;

  constructor(
    kind: BindErrorKind,
    message: string,
    extra?: { keyId?: string; manualCommand?: string; stderr?: string },
  ) {
    super(message);
    this.name = 'BindError';
    this.kind = kind;
    this.keyId = extra?.keyId;
    this.manualCommand = extra?.manualCommand;
    this.stderr = extra?.stderr;
  }
}

export interface CliRunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type CliRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<CliRunResult>;

export type TmuxProbe = (env: NodeJS.ProcessEnv) => Promise<boolean> | boolean;

export interface BindCoordinatorDeps {
  platform: NodeJS.Platform;
  getCurrentTrustedOrigin: () => string | null;
  onDidNavigateTrustedOrigin: (listener: (origin: string) => void) => () => void;
  showMessageBox: (options: BindMessageBoxOptions) => Promise<{ response: number }>;
  showNotification: (options: { title: string; body: string }) => void;
  onStateChanged?: () => void;
  hostname?: () => string;
  imcodesHome?: string;
  plistPath?: string;
  resourcesPath?: string;
  imcodesBinPath?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  existsSync?: (filePath: string) => boolean;
  readFileSync?: (filePath: string, encoding: 'utf8') => string;
  probeSystemTmux?: TmuxProbe;
  runCli?: CliRunner;
  mintTimeoutMs?: number;
  cliTimeoutMs?: number;
  keptBindingStorePath?: string;
}

export function tryNormalizeServerOrigin(raw: string): string | null {
  try {
    return normalizeServerOrigin(raw);
  } catch {
    return null;
  }
}

export interface BundledTmuxEnvResult {
  env: NodeJS.ProcessEnv;
  usedBundledTmux: boolean;
  bundledBinDir?: string;
  terminfoDirs?: string;
}

export interface LaunchAgentIssue {
  status: 'ok' | 'not_installed' | 'skipped_non_darwin' | 'invalid_plist' | 'missing_paths';
  missingPrograms: string[];
  missingBundledPaths: string[];
  warningTitle?: string;
  warningMessage?: string;
  warningDetail?: string;
  rebindRequested?: boolean;
}

export interface BindAttemptOutcome {
  status:
    | 'bound'
    | 'untrusted'
    | 'in_flight'
    | 'no_cookie'
    | 'already_asked'
    | 'kept_existing'
    | 'failed';
  error?: BindError;
}

export function resolveImcodesHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const configured = env.IMCODES_HOME?.trim();
  return configured || path.join(homeDir, '.imcodes');
}

export function resolveDefaultLaunchAgentPlistPath(
  homeDir: string = os.homedir(),
): string {
  return path.join(homeDir, 'Library', 'LaunchAgents', 'imcodes.daemon.plist');
}

export function resolveImcodesBinPath(options: {
  platform: NodeJS.Platform;
  imcodesBinPath?: string;
  resourcesPath?: string;
  env?: NodeJS.ProcessEnv;
  existsSync?: (filePath: string) => boolean;
}): string {
  const env = options.env ?? process.env;
  const checkExists = options.existsSync ?? existsSync;
  const explicit = options.imcodesBinPath?.trim() || env.IMCODES_BIN_PATH?.trim();
  if (explicit) return explicit;

  const exeName = options.platform === 'win32' ? 'imcodes.exe' : 'imcodes';
  if (options.resourcesPath) {
    const direct = path.join(options.resourcesPath, exeName);
    if (checkExists(direct)) return direct;
    const nested = path.join(options.resourcesPath, 'bin', exeName);
    if (checkExists(nested)) return nested;
  }
  return exeName;
}

/**
 * Verify a cookie event belongs strictly to `origin` and matches COOKIE_SESSION (`rcc_session`).
 */
export function sameOriginCookie(cookie: CookieLike, origin: string): boolean {
  if (cookie.name !== COOKIE_SESSION) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return false;
  }
  if (cookie.secure === true && parsed.protocol !== 'https:') {
    return false;
  }
  const rawDomain = cookie.domain?.trim().toLowerCase() ?? '';
  if (!rawDomain) return false;
  const domain = rawDomain.startsWith('.') ? rawDomain.slice(1) : rawDomain;
  if (!domain) return false;

  const host = parsed.hostname.toLowerCase();
  const hostMatches = host === domain || host.endsWith(`.${domain}`);
  if (!hostMatches) return false;

  const cookiePath = cookie.path && cookie.path.startsWith('/') ? cookie.path : '/';
  if (cookiePath === '/') return true;
  return (
    parsed.pathname === cookiePath ||
    parsed.pathname.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`)
  );
}

export function readServerJsonOrNull(
  imcodesHome: string,
  fsDeps?: {
    existsSync?: (filePath: string) => boolean;
    readFileSync?: (filePath: string, encoding: 'utf8') => string;
  },
): ServerCredentials | null {
  const checkExists = fsDeps?.existsSync ?? existsSync;
  const read = fsDeps?.readFileSync ?? readFileSync;
  const serverJsonPath = path.join(imcodesHome, 'server.json');
  if (!checkExists(serverJsonPath)) return null;
  let raw: string;
  try {
    raw = read(serverJsonPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ServerCredentials> | null;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.workerUrl !== 'string' ||
      !parsed.workerUrl ||
      typeof parsed.serverName !== 'string' ||
      !parsed.serverName
    ) {
      return null;
    }
    return {
      serverId: typeof parsed.serverId === 'string' ? parsed.serverId : '',
      token: typeof parsed.token === 'string' ? parsed.token : '',
      workerUrl: parsed.workerUrl,
      serverName: parsed.serverName,
      boundAt: typeof parsed.boundAt === 'number' ? parsed.boundAt : 0,
    };
  } catch {
    return null;
  }
}

export function serverJsonExistsOnDisk(
  imcodesHome: string,
  checkExists: (filePath: string) => boolean = existsSync,
): boolean {
  return checkExists(path.join(imcodesHome, 'server.json'));
}

async function defaultProbeSystemTmux(env: NodeJS.ProcessEnv): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    execFile('tmux', ['-V'], { env, timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

async function defaultRunCli(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve) => {
    const spawnOpts: SpawnOptions = {
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    let child;
    try {
      child = spawn(command, args, spawnOpts);
    } catch (err) {
      resolve({
        status: null,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore already-exited child.
      }
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: null,
        signal: null,
        timedOut,
        stdout,
        stderr,
        error: err,
      });
    });
    child.on('close', (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status,
        signal,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

/**
 * §4.5: Check system `tmux -V` on untouched user PATH first. If present, leave PATH
 * untouched. Only when missing on macOS and bundled `Contents/Resources/bin/tmux` exists,
 * prepend bundled bin dir to PATH and set `TERMINFO_DIRS` when bundled terminfo exists.
 */
export async function ensureBundledTmuxEnv(options: {
  platform: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string;
  existsSync?: (filePath: string) => boolean;
  probeSystemTmux?: TmuxProbe;
}): Promise<BundledTmuxEnvResult> {
  const baseEnv: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  const probe = options.probeSystemTmux ?? defaultProbeSystemTmux;
  const checkExists = options.existsSync ?? existsSync;

  const hasSystemTmux = await probe(baseEnv);
  if (hasSystemTmux) {
    return { env: baseEnv, usedBundledTmux: false };
  }

  if (options.platform === 'darwin' && options.resourcesPath) {
    const binDir = path.join(options.resourcesPath, 'bin');
    const bundledTmux = path.join(binDir, 'tmux');
    if (checkExists(bundledTmux)) {
      const nextPath = baseEnv.PATH ? `${binDir}:${baseEnv.PATH}` : binDir;
      const nextEnv: NodeJS.ProcessEnv = {
        ...baseEnv,
        PATH: nextPath,
      };
      const terminfoDir = path.join(options.resourcesPath, 'terminfo');
      let terminfoDirs: string | undefined;
      if (checkExists(terminfoDir)) {
        const extra = baseEnv.TERMINFO_DIRS?.trim();
        terminfoDirs = extra
          ? `${terminfoDir}:${extra}:/usr/share/terminfo`
          : `${terminfoDir}:/usr/share/terminfo`;
        nextEnv.TERMINFO_DIRS = terminfoDirs;
      }
      return {
        env: nextEnv,
        usedBundledTmux: true,
        bundledBinDir: binDir,
        ...(terminfoDirs ? { terminfoDirs } : {}),
      };
    }
  }

  return { env: baseEnv, usedBundledTmux: false };
}

function xmlUnescape(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

export function parseLaunchAgentPlistPaths(xml: string): {
  programArguments: string[] | null;
  pathEnv: string | null;
} {
  const progMatch = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(xml);
  const programArguments = progMatch
    ? [...progMatch[1]!.matchAll(/<string>([\s\S]*?)<\/string>/gu)].map((m) =>
        xmlUnescape(m[1]!.trim()),
      )
    : null;

  const envMatch = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/u.exec(xml);
  let pathEnv: string | null = null;
  if (envMatch) {
    const pathMatch = /<key>PATH<\/key>\s*<string>([\s\S]*?)<\/string>/u.exec(envMatch[1]!);
    if (pathMatch) {
      pathEnv = xmlUnescape(pathMatch[1]!.trim());
    }
  }
  return { programArguments, pathEnv };
}

/**
 * §4.5: Inspect existing `~/Library/LaunchAgents/imcodes.daemon.plist` on macOS startup.
 * Validates BOTH `ProgramArguments` target files and any bundled `Contents/Resources/bin`
 * entry in `EnvironmentVariables.PATH`, issuing distinct warnings without modifying the plist.
 */
export function inspectMacosLaunchAgentPlist(options: {
  platform: NodeJS.Platform;
  plistPath: string;
  existsSync?: (filePath: string) => boolean;
  readFileSync?: (filePath: string, encoding: 'utf8') => string;
}): LaunchAgentIssue {
  if (options.platform !== 'darwin') {
    return {
      status: 'skipped_non_darwin',
      missingPrograms: [],
      missingBundledPaths: [],
    };
  }
  const checkExists = options.existsSync ?? existsSync;
  const read = options.readFileSync ?? readFileSync;
  if (!checkExists(options.plistPath)) {
    return {
      status: 'not_installed',
      missingPrograms: [],
      missingBundledPaths: [],
    };
  }

  let xml: string;
  try {
    xml = read(options.plistPath, 'utf8');
  } catch {
    return {
      status: 'invalid_plist',
      missingPrograms: [],
      missingBundledPaths: [],
      warningTitle: 'Daemon LaunchAgent Unreadable',
      warningMessage: 'Existing macOS LaunchAgent configuration could not be read.',
      warningDetail: `Inspect ${options.plistPath} or choose Rebind Now from the Server menu to regenerate it.`,
    };
  }

  const { programArguments, pathEnv } = parseLaunchAgentPlistPaths(xml);
  const missingPrograms: string[] = [];
  if (programArguments && programArguments.length > 0) {
    const executable = programArguments[0]!;
    if (executable && !checkExists(executable)) {
      missingPrograms.push(executable);
    }
    const entryArg = programArguments[1];
    if (entryArg && entryArg.includes('/') && !checkExists(entryArg)) {
      missingPrograms.push(entryArg);
    }
  }

  const missingBundledPaths: string[] = [];
  if (pathEnv) {
    for (const dir of pathEnv.split(':')) {
      const trimmed = dir.trim();
      if (!trimmed) continue;
      if (trimmed.includes('Contents/Resources/bin') && !checkExists(trimmed)) {
        missingBundledPaths.push(trimmed);
      }
    }
  }

  if (missingPrograms.length === 0 && missingBundledPaths.length === 0) {
    return { status: 'ok', missingPrograms: [], missingBundledPaths: [] };
  }

  let warningMessage: string;
  const detailParts: string[] = [];
  if (missingPrograms.length > 0 && missingBundledPaths.length > 0) {
    warningMessage =
      'Background daemon cannot start and cannot find bundled tmux because paths in the LaunchAgent no longer exist.';
    detailParts.push(`Missing daemon program path(s):\n  ${missingPrograms.join('\n  ')}`);
    detailParts.push(`Missing bundled tmux PATH entry:\n  ${missingBundledPaths.join('\n  ')}`);
  } else if (missingPrograms.length > 0) {
    warningMessage =
      'Background daemon cannot start because the ProgramArguments target in LaunchAgent no longer exists.';
    detailParts.push(`Missing daemon program path(s):\n  ${missingPrograms.join('\n  ')}`);
  } else {
    warningMessage =
      'Background daemon cannot find bundled tmux because the bundled PATH entry in LaunchAgent no longer exists.';
    detailParts.push(`Missing bundled tmux PATH entry:\n  ${missingBundledPaths.join('\n  ')}`);
  }
  detailParts.push(
    'This typically happens after moving or uninstalling IM.codes.app. Choose Rebind Now to update the LaunchAgent safely.',
  );

  return {
    status: 'missing_paths',
    missingPrograms,
    missingBundledPaths,
    warningTitle: 'Daemon Startup Configuration Needs Rebind',
    warningMessage,
    warningDetail: detailParts.join('\n\n'),
  };
}

export class BindCoordinator {
  private readonly inFlight = new Set<string>();
  private readonly askedThisLogin = new Set<string>();
  private readonly clearEpochs = new Map<string, number>();
  private readonly attachedSessions = new WeakSet<object>();
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly checkExists: (filePath: string) => boolean;
  private readonly readFile: (filePath: string, encoding: 'utf8') => string;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly imcodesHome: string;
  private readonly plistPath: string;
  private readonly getHostname: () => string;
  private readonly runCli: CliRunner;
  private readonly mintTimeoutMs: number;
  private readonly cliTimeoutMs: number;
  private readonly keptBindingStorePath: string | null;
  private keptBindings: Record<string, string>;

  constructor(private readonly deps: BindCoordinatorDeps) {
    this.baseEnv = deps.env ?? process.env;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.checkExists = deps.existsSync ?? existsSync;
    this.readFile = deps.readFileSync ?? readFileSync;
    this.imcodesHome = deps.imcodesHome ?? resolveImcodesHomeDir(this.baseEnv);
    this.plistPath = deps.plistPath ?? resolveDefaultLaunchAgentPlistPath();
    this.getHostname = deps.hostname ?? (() => os.hostname());
    this.runCli = deps.runCli ?? defaultRunCli;
    this.mintTimeoutMs = deps.mintTimeoutMs ?? 15_000;
    this.cliTimeoutMs = deps.cliTimeoutMs ?? 120_000;
    this.keptBindingStorePath = deps.keptBindingStorePath?.trim() || null;
    this.keptBindings = this.loadPersistedKeptBindings();

    deps.onDidNavigateTrustedOrigin((origin) => {
      void this.maybeBind(origin);
    });
  }

  private loadPersistedKeptBindings(): Record<string, string> {
    if (!this.keptBindingStorePath) return {};
    try {
      if (!this.checkExists(this.keptBindingStorePath)) return {};
      const raw = this.readFile(this.keptBindingStorePath, 'utf8');
      const parsed = JSON.parse(raw) as { version?: unknown; kept?: unknown } | null;
      if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !parsed.kept || typeof parsed.kept !== 'object') {
        return {};
      }
      const result: Record<string, string> = {};
      for (const [targetOrigin, existingOrigin] of Object.entries(parsed.kept as Record<string, unknown>)) {
        if (typeof targetOrigin === 'string' && targetOrigin && typeof existingOrigin === 'string' && existingOrigin) {
          result[targetOrigin] = existingOrigin;
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  private persistKeptBindings(): void {
    if (!this.keptBindingStorePath) return;
    const dir = path.dirname(this.keptBindingStorePath);
    const tmpPath = `${this.keptBindingStorePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(
        tmpPath,
        JSON.stringify({ version: 1, kept: this.keptBindings }, null, 2),
        { encoding: 'utf8', mode: 0o600 },
      );
      renameSync(tmpPath, this.keptBindingStorePath);
    } catch {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // Ignore cleanup failure when storage dir is unwritable.
      }
    }
  }

  private hasPersistedKeptBinding(existingKey: string, targetOrigin: string): boolean {
    if (!this.keptBindingStorePath) return false;
    return this.keptBindings[targetOrigin] === existingKey;
  }

  private recordPersistedKeptBinding(existingKey: string, targetOrigin: string): void {
    if (!this.keptBindingStorePath) return;
    this.keptBindings[targetOrigin] = existingKey;
    this.persistKeptBindings();
  }

  private clearPersistedKeptBinding(targetOrigin: string): void {
    if (!this.keptBindingStorePath) return;
    if (!(targetOrigin in this.keptBindings)) return;
    delete this.keptBindings[targetOrigin];
    this.persistKeptBindings();
  }

  getBoundSummary(): BoundServerSummary | null {
    const existing = readServerJsonOrNull(this.imcodesHome, {
      existsSync: this.checkExists,
      readFileSync: this.readFile,
    });
    if (!existing) return null;
    return {
      serverName: existing.serverName,
      workerUrl: existing.workerUrl,
    };
  }

  clearAskedState(origin: string): void {
    this.clearEpochs.set(origin, (this.clearEpochs.get(origin) ?? 0) + 1);
    this.askedThisLogin.delete(origin);
    const targetOrigin = tryNormalizeServerOrigin(origin) ?? origin;
    this.clearPersistedKeptBinding(targetOrigin);
  }

  hasAskedThisLogin(origin: string): boolean {
    return this.askedThisLogin.has(origin);
  }

  isInFlight(origin: string): boolean {
    return this.inFlight.has(origin);
  }

  private cookiesRef: CookiesChangeEventLike | null = null;

  attachCookies(cookies: CookiesChangeEventLike): void {
    this.cookiesRef = cookies;
    if (this.attachedSessions.has(cookies)) return;
    this.attachedSessions.add(cookies);

    cookies.on('changed', (_event, cookie, cause, removed) => {
      const origin = this.deps.getCurrentTrustedOrigin();
      if (!origin) return;
      if (!sameOriginCookie(cookie, origin)) return;
      if (removed) {
        // Chromium dispatches (removed: true, cause: 'overwrite') right before
        // (removed: false, cause: 'explicit') on sliding Set-Cookie renewals.
        if (cause !== 'overwrite') {
          this.clearAskedState(origin);
        }
        return;
      }
      void this.maybeBind(origin, cookies);
    });
  }

  async maybeBind(
    origin: string,
    cookiesOverride?: CookiesChangeEventLike,
  ): Promise<BindAttemptOutcome> {
    return this.runBindFlow(origin, {
      cookies: cookiesOverride ?? this.cookiesRef,
      manual: false,
    });
  }

  async triggerManualBind(
    cookiesOverride?: CookiesChangeEventLike,
  ): Promise<BindAttemptOutcome> {
    const origin = this.deps.getCurrentTrustedOrigin();
    if (!origin) {
      await this.deps.showMessageBox({
        type: 'info',
        title: 'Bind This Machine',
        message: 'Select a saved server before binding this machine.',
        buttons: ['OK'],
        defaultId: 0,
      });
      return { status: 'untrusted' };
    }
    return this.runBindFlow(origin, {
      cookies: cookiesOverride ?? this.cookiesRef,
      manual: true,
    });
  }

  private async runBindFlow(
    origin: string,
    opts: { cookies: CookiesChangeEventLike | null; manual: boolean },
  ): Promise<BindAttemptOutcome> {
    // §4.2 Single-flight invariant: check and mark BEFORE any await (especially cookies.get).
    if (this.inFlight.has(origin)) {
      return { status: 'in_flight' };
    }
    this.inFlight.add(origin);
    try {
      if (!opts.cookies) {
        if (opts.manual) {
          await this.deps.showMessageBox({
            type: 'warning',
            title: 'Bind This Machine',
            message: 'Browser session cookies are unavailable in this window.',
            buttons: ['OK'],
            defaultId: 0,
          });
        }
        return { status: 'no_cookie' };
      }

      const found = await opts.cookies.get({ url: origin, name: COOKIE_SESSION });
      const authoritative = found.find((c) => c.name === COOKIE_SESSION && Boolean(c.value));
      if (!authoritative || !authoritative.value) {
        if (opts.manual) {
          await this.deps.showMessageBox({
            type: 'info',
            title: 'Sign In Required',
            message: `Sign in to ${origin} first to bind this machine.`,
            buttons: ['OK'],
            defaultId: 0,
          });
        }
        return { status: 'no_cookie' };
      }

      const existing = readServerJsonOrNull(this.imcodesHome, {
        existsSync: this.checkExists,
        readFileSync: this.readFile,
      });

      const targetOrigin = tryNormalizeServerOrigin(origin) ?? origin;
      if (existing) {
        const existingOrigin = tryNormalizeServerOrigin(existing.workerUrl);
        if (!opts.manual && existingOrigin !== null && existingOrigin === targetOrigin) {
          return { status: 'kept_existing' };
        }
        const existingKey = existingOrigin ?? existing.workerUrl;
        if (
          !opts.manual &&
          (this.askedThisLogin.has(origin) || this.hasPersistedKeptBinding(existingKey, targetOrigin))
        ) {
          return { status: 'already_asked' };
        }
        const clearEpochAtPrompt = this.clearEpochs.get(origin) ?? 0;
        const replace = await this.askReplaceBinding(existing, origin);
        // Only record asked state if a logout (`removed: true`, non-overwrite) did not clear this login meanwhile.
        if ((this.clearEpochs.get(origin) ?? 0) === clearEpochAtPrompt) {
          this.askedThisLogin.add(origin);
          if (!replace) {
            this.recordPersistedKeptBinding(existingKey, targetOrigin);
          }
        }
        if (!replace) {
          return { status: 'kept_existing' };
        }
      }

      await this.performBind(origin, authoritative.value);
      this.clearPersistedKeptBinding(targetOrigin);
      return { status: 'bound' };
    } catch (err) {
      const bindErr =
        err instanceof BindError
          ? err
          : new BindError('cli_failed_uncertain', err instanceof Error ? err.message : String(err));
      await this.presentBindFailure(origin, bindErr);
      return { status: 'failed', error: bindErr };
    } finally {
      this.inFlight.delete(origin);
    }
  }

  private async askReplaceBinding(existing: ServerCredentials, targetOrigin: string): Promise<boolean> {
    const { response } = await this.deps.showMessageBox({
      type: 'question',
      title: 'Replace Existing Server Binding?',
      message: 'This machine is already bound to an IM.codes server.',
      detail: [
        `Currently bound to:\n  ${existing.serverName} · ${existing.workerUrl}`,
        `Signed in to:\n  ${targetOrigin}`,
        'Keep existing does nothing. Choose Replace to bind this machine to the current server.',
      ].join('\n\n'),
      buttons: ['Keep Existing', 'Replace'],
      defaultId: 0,
      cancelId: 0,
    });
    return response === 1;
  }

  /**
   * Unified execution path (§4.2 + §4.5): all three entry points (unbound auto-bind,
   * bound replace confirmation, and manual menu trigger) converge here.
   */
  async performBind(origin: string, sessionValue: string): Promise<void> {
    const host = this.getHostname();
    const { env: preparedEnv } = await ensureBundledTmuxEnv({
      platform: this.deps.platform,
      env: this.baseEnv,
      resourcesPath: this.deps.resourcesPath,
      existsSync: this.checkExists,
      probeSystemTmux: this.deps.probeSystemTmux,
    });

    const { id: keyId, apiKey } = await this.mintBindKey(origin, sessionValue, host);
    const manualCommand = `imcodes bind ${origin}/bind/<api-key> ${host}`;
    const imcodesPath = resolveImcodesBinPath({
      platform: this.deps.platform,
      imcodesBinPath: this.deps.imcodesBinPath,
      resourcesPath: this.deps.resourcesPath,
      env: preparedEnv,
      existsSync: this.checkExists,
    });

    const result = await this.runCli(
      imcodesPath,
      ['bind', `${origin}/bind/${apiKey}`, host],
      { env: preparedEnv, timeoutMs: this.cliTimeoutMs },
    );

    if (result.status === 0 && !result.timedOut && !result.signal && !result.error) {
      const updated = readServerJsonOrNull(this.imcodesHome, {
        existsSync: this.checkExists,
        readFileSync: this.readFile,
      });
      const serverName = updated?.serverName ?? host;
      this.deps.onStateChanged?.();
      this.deps.showNotification({
        title: 'IM.codes Machine Bound',
        body: `Bound to ${serverName}. Background service installed and will auto-start on login.`,
      });
      return;
    }

    const stderrText = (result.stderr || result.error?.message || '').trim();
    const serverJsonPresent = serverJsonExistsOnDisk(this.imcodesHome, this.checkExists);
    const normalNonZeroExit =
      result.error == null &&
      typeof result.status === 'number' &&
      result.status !== 0 &&
      !result.timedOut &&
      result.signal === null;
    const deterministicNotCommitted = normalNonZeroExit && !serverJsonPresent;

    if (deterministicNotCommitted) {
      await this.revokeMintedKey(origin, sessionValue, keyId);
      throw new BindError(
        'cli_failed_revoked',
        stderrText || `imcodes bind exited with status ${String(result.status)}`,
        { keyId, manualCommand, stderr: stderrText },
      );
    }

    const uncertainReason = result.timedOut
      ? 'imcodes bind timed out before completion'
      : result.signal
        ? `imcodes bind terminated with signal ${result.signal}`
        : result.error != null || result.status === null
          ? `imcodes bind failed to execute cleanly (${result.error?.message ?? 'no exit status'})`
          : `imcodes bind exited with status ${String(result.status)} after server.json appeared`;

    throw new BindError(
      'cli_failed_uncertain',
      stderrText ? `${uncertainReason}: ${stderrText}` : uncertainReason,
      { keyId, manualCommand, stderr: stderrText },
    );
  }

  private async mintBindKey(
    origin: string,
    sessionValue: string,
    host: string,
  ): Promise<{ id: string; apiKey: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.mintTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${origin}/api/auth/user/me/keys`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `${COOKIE_SESSION}=${sessionValue}`,
        },
        body: JSON.stringify({ label: `PC App · ${host}` }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new BindError(
        'mint_key_unknown',
        err instanceof Error ? err.message : String(err),
        { manualCommand: `imcodes bind ${origin}/bind/<api-key> ${host}` },
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status !== 201) {
      throw new BindError('mint_key_rejected', `Key creation rejected with HTTP ${response.status}`, {
        manualCommand: `imcodes bind ${origin}/bind/<api-key> ${host}`,
      });
    }

    const body = (await response.json().catch(() => null)) as
      | { id?: unknown; apiKey?: unknown }
      | null;
    if (
      !body ||
      typeof body.id !== 'string' ||
      body.id.length === 0 ||
      typeof body.apiKey !== 'string' ||
      !body.apiKey.startsWith('deck_')
    ) {
      throw new BindError('mint_key_unknown', 'Unexpected response shape from key creation endpoint', {
        manualCommand: `imcodes bind ${origin}/bind/<api-key> ${host}`,
      });
    }

    return { id: body.id, apiKey: body.apiKey };
  }

  private async revokeMintedKey(
    origin: string,
    sessionValue: string,
    keyId: string,
  ): Promise<void> {
    try {
      await this.fetchImpl(`${origin}/api/auth/user/me/keys/${encodeURIComponent(keyId)}`, {
        method: 'DELETE',
        headers: {
          cookie: `${COOKIE_SESSION}=${sessionValue}`,
        },
      });
    } catch {
      // Best-effort cleanup only; never retry or trigger another bind.
    }
  }

  private async presentBindFailure(origin: string, err: BindError): Promise<void> {
    const manualHint = err.manualCommand
      ? `Manual command:\n  ${err.manualCommand}`
      : `Retry via Server -> Bind This Machine or run:\n  imcodes bind ${origin}/bind/<api-key> ${this.getHostname()}`;

    if (err.kind === 'mint_key_unknown') {
      await this.deps.showMessageBox({
        type: 'warning',
        title: 'Machine Bind Status Uncertain',
        message: 'Could not confirm whether a new API key was created on the server.',
        detail: [
          err.message,
          `Please check your API keys in the ${origin} web dashboard before retrying.`,
          manualHint,
        ].join('\n\n'),
        buttons: ['OK'],
        defaultId: 0,
      });
      return;
    }

    if (err.kind === 'cli_failed_uncertain') {
      await this.deps.showMessageBox({
        type: 'warning',
        title: 'Machine Bind Status Uncertain',
        message: 'The bind command did not finish cleanly; the minted API key was kept for safety.',
        detail: [
          err.stderr || err.message,
          `Please check ${origin} to verify whether this machine appears online or revoke unused keys.`,
          manualHint,
        ].join('\n\n'),
        buttons: ['OK'],
        defaultId: 0,
      });
      return;
    }

    await this.deps.showMessageBox({
      type: 'error',
      title: 'Machine Bind Failed',
      message:
        err.kind === 'mint_key_rejected'
          ? `Server refused to create a bind key (${err.message}).`
          : 'Failed to bind this machine via imcodes CLI.',
      detail: [err.stderr || err.message, manualHint].join('\n\n'),
      buttons: ['OK'],
      defaultId: 0,
    });
  }

  async checkLaunchAgentOnStartup(): Promise<LaunchAgentIssue> {
    const check = inspectMacosLaunchAgentPlist({
      platform: this.deps.platform,
      plistPath: this.plistPath,
      existsSync: this.checkExists,
      readFileSync: this.readFile,
    });

    if (check.status !== 'missing_paths' && check.status !== 'invalid_plist') {
      return check;
    }

    const { response } = await this.deps.showMessageBox({
      type: 'warning',
      title: check.warningTitle ?? 'Daemon Startup Check',
      message: check.warningMessage ?? 'LaunchAgent configuration needs attention.',
      detail: check.warningDetail,
      buttons: ['Later', 'Rebind Now'],
      defaultId: 1,
      cancelId: 0,
    });

    if (response === 1) {
      check.rebindRequested = true;
      await this.triggerManualBind();
    } else {
      check.rebindRequested = false;
    }
    return check;
  }
}
