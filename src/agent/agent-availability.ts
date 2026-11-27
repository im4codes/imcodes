import { access, stat } from 'node:fs/promises';
import { constants as fsConstants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentAvailabilityEntry, AgentAvailabilityMap } from '../../shared/agent-availability.js';
import { CLAUDE_CODE_CLI_SDK_AGENT_TYPE, SESSION_AGENT_TYPES, type SessionAgentType } from '../../shared/agent-types.js';
import { AGY_SDK_PROVIDER_ID } from '../../shared/agy-agent.js';
import { CODEBUDDY_CLI_PATH_ENVIRONMENT_VARIABLE, CODEBUDDY_PROVIDER_IDS } from '../../shared/codebuddy.js';
import { HERMES_AGENT_PROVIDER_ID } from '../../shared/hermes-agent.js';
import { resolveImcodesHome } from '../util/windows-daemon-lock.js';
import { resolveCopilotExplicitBinaryPath, resolveCopilotRuntimePlatform } from './copilot-runtime-config.js';
import { getProvider } from './provider-registry.js';
import { DSH_BINARY_ENV, DSH_DEFAULT_BINARY } from './providers/deepseek-harness/runtime.js';
import { GROK_CLI_BINARY, GROK_CLI_PATH_ENV } from './providers/grok-sdk.js';
import { PI_BINARY_ENV, PI_DEFAULT_BINARY } from './providers/pi/runtime.js';
import {
  getBundledClaudeBinaryCandidates,
  getSupportedCursorWindowsExts,
  getUnixCursorCandidateDirs,
  getWindowsCursorSearchDirs,
  resolveCursorCmdLauncherPlan,
  resolveNodePackageRoot,
} from './transport-paths.js';

const CACHE_TTL_MS = 60_000;
const DEFAULT_PER_AGENT_TIMEOUT_MS = 3_000;
const WIN_DELIMITER = ';';
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

export interface AgentAvailabilityProbeDeps {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture | string;
  isMusl?: boolean;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  imcodesHomeDir: string;
  isExecutableFile(filePath: string): Promise<boolean>;
  fileExists(filePath: string): Promise<boolean>;
  resolvePackageRoot(specifier: string, packageName?: string): string | null;
  isProviderConnected(id: string): boolean;
}

export interface DetectInstalledAgentsOptions {
  forceRefresh?: boolean;
  now?: number;
  timeoutMs?: number;
  deps?: Partial<AgentAvailabilityProbeDeps>;
}

export interface DetectInstalledAgentsResult {
  agents: AgentAvailabilityMap;
  epoch: number;
  checkedAt: number;
}

let probeEpoch = 0;
let cachedResult: { epoch: number; checkedAt: number; agents: AgentAvailabilityMap } | null = null;
let activeProbe: { epoch: number; forced: boolean; promise: Promise<AgentAvailabilityMap> } | null = null;

export function __resetAgentAvailabilityCacheForTests(): void {
  probeEpoch = 0;
  cachedResult = null;
  activeProbe = null;
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.trim().length > 0))];
}

function pathModuleFor(platform: NodeJS.Platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function defaultIsLinuxMusl(platform: NodeJS.Platform): boolean {
  if (platform !== 'linux' || process.platform !== 'linux') return false;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: unknown } } | undefined;
  return report?.header !== undefined && report.header.glibcVersionRuntime === undefined;
}

async function defaultIsExecutableFile(filePath: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    if (platform === 'win32') return true;
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultFileExists(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

function buildDefaultDeps(overrides?: Partial<AgentAvailabilityProbeDeps>): AgentAvailabilityProbeDeps {
  const platform = overrides?.platform ?? process.platform;
  const env = overrides?.env ?? process.env;
  return {
    platform,
    arch: overrides?.arch ?? process.arch,
    ...(overrides?.isMusl !== undefined ? { isMusl: overrides.isMusl } : {}),
    env,
    homeDir: overrides?.homeDir ?? homedir(),
    imcodesHomeDir: overrides?.imcodesHomeDir ?? resolveImcodesHome(),
    isExecutableFile: overrides?.isExecutableFile ?? ((filePath) => defaultIsExecutableFile(filePath, platform)),
    fileExists: overrides?.fileExists ?? defaultFileExists,
    resolvePackageRoot: overrides?.resolvePackageRoot ?? resolveNodePackageRoot,
    isProviderConnected: overrides?.isProviderConnected ?? ((id) => Boolean(getProvider(id))),
  };
}

function getWindowsGlobalCliDirs(deps: AgentAvailabilityProbeDeps): string[] {
  const p = pathModuleFor(deps.platform);
  return uniqueNonEmpty([
    deps.env.APPDATA ? p.join(deps.env.APPDATA, 'npm') : undefined,
    deps.env.USERPROFILE ? p.join(deps.env.USERPROFILE, 'AppData', 'Roaming', 'npm') : undefined,
  ]);
}

function getUnixAcpPreferredDirs(deps: AgentAvailabilityProbeDeps): string[] {
  const p = pathModuleFor(deps.platform);
  return uniqueNonEmpty([
    deps.homeDir ? p.join(deps.homeDir, '.local', 'bin') : undefined,
    deps.homeDir ? p.join(deps.homeDir, '.gemini', 'antigravity-cli', 'bin') : undefined,
    deps.homeDir ? p.join(deps.homeDir, '.npm-global', 'bin') : undefined,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ]);
}

interface BinaryResolveOptions {
  /** Candidate directories searched BEFORE PATH (e.g. provider explicit per-user dirs). */
  leadingDirs?: string[];
  /** Candidate directories searched AFTER PATH (e.g. fallback dirs or Windows global npm dir). */
  trailingDirs?: string[];
  /** Search PATH itself (`env.PATH`). True for almost all launchers except `muse` on Unix (`existsSync(resolveMuseCodePathForSdk())`). */
  searchEnvPath?: boolean;
  /** On Windows, include `getWindowsGlobalCliDirs()` matching `resolveBinaryOnWindows()`. */
  includeWindowsGlobalNpmDirs?: boolean;
}

async function resolveCommandExecutable(
  binOrPath: string,
  opts: BinaryResolveOptions,
  deps: AgentAvailabilityProbeDeps,
): Promise<string | null> {
  const trimmed = binOrPath.trim();
  if (!trimmed) return null;
  const p = pathModuleFor(deps.platform);
  const hasSeparator = trimmed.includes('/') || trimmed.includes('\\');
  const pathext = deps.platform === 'win32'
    ? uniqueNonEmpty(
        (deps.env.PATHEXT ?? DEFAULT_PATHEXT)
          .split(WIN_DELIMITER)
          .flatMap((ext) => [ext.toLowerCase(), ext]),
      )
    : [];

  const candidateNames = (baseName: string): string[] => {
    if (deps.platform !== 'win32') return [baseName];
    const hasKnownExt = pathext.some((ext) => baseName.toLowerCase().endsWith(ext.toLowerCase()));
    return hasKnownExt ? [baseName] : [...pathext.map((ext) => `${baseName}${ext}`), baseName];
  };

  if (p.isAbsolute(trimmed) || hasSeparator) {
    for (const candidate of candidateNames(trimmed)) {
      if (await deps.isExecutableFile(candidate)) return candidate;
    }
    return null;
  }

  const envPathEntries = opts.searchEnvPath === false
    ? []
    : (deps.env.PATH ?? '').split(deps.platform === 'win32' ? WIN_DELIMITER : ':');
  const winGlobalDirs = deps.platform === 'win32' && opts.includeWindowsGlobalNpmDirs !== false
    ? getWindowsGlobalCliDirs(deps)
    : [];
  const searchDirs = uniqueNonEmpty([
    ...(opts.leadingDirs ?? []),
    ...envPathEntries,
    ...winGlobalDirs,
    ...(opts.trailingDirs ?? []),
  ]);
  for (const dir of searchDirs) {
    for (const fileName of candidateNames(trimmed)) {
      const candidate = p.join(dir, fileName);
      if (await deps.isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

async function probeBinary(
  deps: AgentAvailabilityProbeDeps,
  binOrPath: string,
  opts: BinaryResolveOptions,
  missingReason: string,
): Promise<AgentAvailabilityEntry> {
  const resolved = await resolveCommandExecutable(binOrPath, opts, deps);
  return resolved ? { installed: true } : { installed: false, reason: missingReason };
}

function getWindowsClaudeDirs(deps: AgentAvailabilityProbeDeps): string[] {
  const p = pathModuleFor(deps.platform);
  return uniqueNonEmpty([
    ...getWindowsGlobalCliDirs(deps),
    deps.env.LOCALAPPDATA ? p.join(deps.env.LOCALAPPDATA, 'Programs', 'Claude') : undefined,
    deps.env.LOCALAPPDATA ? p.join(deps.env.LOCALAPPDATA, 'Programs', 'Claude Code') : undefined,
    deps.env.ProgramFiles ? p.join(deps.env.ProgramFiles, 'Claude') : undefined,
    deps.env.ProgramFiles ? p.join(deps.env.ProgramFiles, 'Claude Code') : undefined,
    deps.env['ProgramFiles(x86)'] ? p.join(deps.env['ProgramFiles(x86)'], 'Claude') : undefined,
    deps.env['ProgramFiles(x86)'] ? p.join(deps.env['ProgramFiles(x86)'], 'Claude Code') : undefined,
  ]);
}

function getUnixClaudeDirs(deps: AgentAvailabilityProbeDeps): string[] {
  const p = pathModuleFor(deps.platform);
  return uniqueNonEmpty([
    deps.homeDir ? p.join(deps.homeDir, '.local', 'bin') : undefined,
    deps.homeDir ? p.join(deps.homeDir, '.claude', 'local') : undefined,
    deps.homeDir ? p.join(deps.homeDir, '.npm-global', 'bin') : undefined,
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ]);
}

async function hasBundledClaudeBinary(deps: AgentAvailabilityProbeDeps): Promise<boolean> {
  const candidates = getBundledClaudeBinaryCandidates({
    platform: deps.platform,
    arch: deps.arch,
    env: deps.env,
    resolvePackageRoot: deps.resolvePackageRoot,
  });
  for (const candidate of candidates) {
    if (await deps.isExecutableFile(candidate)) return true;
  }
  return false;
}

async function probeClaudeSdk(deps: AgentAvailabilityProbeDeps): Promise<AgentAvailabilityEntry> {
  if (await hasBundledClaudeBinary(deps)) {
    return { installed: true };
  }
  // Matches `resolveClaudeCodePathForSdk('claude')`: platform candidates first, then PATH.
  return probeBinary(
    deps,
    'claude',
    {
      leadingDirs: deps.platform === 'win32' ? getWindowsClaudeDirs(deps) : getUnixClaudeDirs(deps),
    },
    'Claude Code binary not found',
  );
}

async function probeClaudeCli(deps: AgentAvailabilityProbeDeps): Promise<AgentAvailabilityEntry> {
  // Matches `ClaudeCodeDriver`: executes bare `claude` on PATH (and Windows global npm dirs via PATH/ConPTY).
  return probeBinary(
    deps,
    'claude',
    { includeWindowsGlobalNpmDirs: false },
    'claude CLI not found',
  );
}

async function probeAgy(deps: AgentAvailabilityProbeDeps): Promise<AgentAvailabilityEntry> {
  const p = pathModuleFor(deps.platform);
  const configured = deps.env.AGY_CLI_PATH?.trim() || 'agy';
  // Matches `resolveAgyPathForSdk` + `AgySdkProvider.spawnEnv()`.
  const platformDirs = deps.platform === 'win32'
    ? uniqueNonEmpty([
        ...getWindowsGlobalCliDirs(deps),
        deps.env.LOCALAPPDATA ? p.join(deps.env.LOCALAPPDATA, 'Programs', 'antigravity', 'bin') : undefined,
        deps.env.LOCALAPPDATA ? p.join(deps.env.LOCALAPPDATA, 'antigravity-cli', 'bin') : undefined,
        deps.env.LOCALAPPDATA ? p.join(deps.env.LOCALAPPDATA, 'bin') : undefined,
        deps.homeDir ? p.join(deps.homeDir, '.gemini', 'antigravity-cli', 'bin') : undefined,
        deps.homeDir ? p.join(deps.homeDir, '.local', 'bin') : undefined,
      ])
    : uniqueNonEmpty([
        deps.homeDir ? p.join(deps.homeDir, '.local', 'bin') : undefined,
        deps.homeDir ? p.join(deps.homeDir, '.gemini', 'antigravity-cli', 'bin') : undefined,
        deps.homeDir ? p.join(deps.homeDir, '.gemini', 'antigravity', 'bin') : undefined,
        deps.homeDir ? p.join(deps.homeDir, '.npm-global', 'bin') : undefined,
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/usr/bin',
        '/bin',
      ]);
  return probeBinary(deps, configured, { leadingDirs: platformDirs }, 'agy CLI not found');
}

async function probeQoderSdk(deps: AgentAvailabilityProbeDeps): Promise<AgentAvailabilityEntry> {
  const p = pathModuleFor(deps.platform);
  const pkgRoot = deps.resolvePackageRoot('@qoder-ai/qoder-agent-sdk');
  if (!pkgRoot) return { installed: false, reason: '@qoder-ai/qoder-agent-sdk package not installed' };

  // Matches `QoderSdkProvider.connect()` + `inspectQoderSdkPackage()`.
  const qoderCliName = deps.platform === 'win32' ? 'qodercli.exe' : 'qodercli';
  if (await deps.isExecutableFile(p.join(pkgRoot, 'dist', '_bundled', qoderCliName))) {
    return { installed: true };
  }
  if (
    (await deps.fileExists(p.join(pkgRoot, 'dist', '_worker', 'qoder-worker-runtime.obf.mjs')))
    || (await deps.fileExists(p.join(pkgRoot, 'dist', '_worker', 'qoder-worker-runtime.mjs')))
  ) {
    return { installed: true };
  }
  const configured = deps.env.QODERCLI_PATH?.trim();
  if (configured && (await deps.isExecutableFile(configured))) return { installed: true };
  return { installed: false, reason: 'Qoder runtime/CLI not found' };
}

async function probeCopilotSdk(deps: AgentAvailabilityProbeDeps): Promise<AgentAvailabilityEntry> {
  const p = pathModuleFor(deps.platform);
  const sdkRoot = deps.resolvePackageRoot('@microsoft/copilot-sdk');
  if (!sdkRoot) return { installed: false, reason: '@microsoft/copilot-sdk package not installed' };

  // Shared selection rule with `CopilotSdkProvider.resolveBinaryPath()`:
  // an explicit absolute executable (or `.js`) via `COPILOT_CLI_PATH` uses
  // `RuntimeConnection.forSpawnedStdio`, so it does not depend on platform prebuilds.
  const explicitCli = await resolveCopilotExplicitBinaryPath({
    env: deps.env,
    platform: deps.platform,
    isValidFile: async (filePath) => (
      filePath.toLowerCase().endsWith('.js')
        ? deps.fileExists(filePath)
        : deps.isExecutableFile(filePath)
    ),
  });
  if (explicitCli) return { installed: true };

  // Otherwise v2 uses the bundled runtime in `@microsoft/copilot-sdk-<platform>`,
  // matching `dist/runtimeArtifacts.js#ensureRuntimeBundle` (`COPILOT_CLI_USE_NPM_PACKAGE = false`,
  // exact host platform/libc only, and requiring both the wrapper executable and `runtime.node`).
  const isMusl = deps.isMusl ?? defaultIsLinuxMusl(deps.platform);
  const runtimePlatform = resolveCopilotRuntimePlatform(deps.platform, deps.arch, isMusl);
  if (!runtimePlatform) {
    return { installed: false, reason: `Unsupported Copilot runtime platform: ${deps.platform}-${deps.arch}` };
  }
  const sdkPlatformRoot = deps.resolvePackageRoot(`@microsoft/copilot-sdk-${runtimePlatform}`);
  if (!sdkPlatformRoot) {
    return { installed: false, reason: 'Copilot CLI/runtime not found' };
  }
  const wrapperName = deps.platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime';
  const prebuildDir = p.join(sdkPlatformRoot, 'prebuilds', runtimePlatform);
  if (
    (await deps.fileExists(p.join(prebuildDir, wrapperName)))
    && (await deps.fileExists(p.join(prebuildDir, 'runtime.node')))
  ) {
    return { installed: true };
  }

  return { installed: false, reason: 'Copilot CLI/runtime not found' };
}

async function probeCursorHeadless(deps: AgentAvailabilityProbeDeps): Promise<AgentAvailabilityEntry> {
  const p = pathModuleFor(deps.platform);
  if (deps.platform !== 'win32') {
    // Matches `resolveCursorPathForSdk()` candidate dirs and order: PATH first, then candidate dirs for `cursor-agent` then `agent`.
    const trailingDirs = getUnixCursorCandidateDirs(deps.homeDir || undefined, p.join);
    for (const bin of ['cursor-agent', 'agent']) {
      const resolved = await resolveCommandExecutable(bin, { trailingDirs, includeWindowsGlobalNpmDirs: false }, deps);
      if (resolved) return { installed: true };
    }
    return { installed: false, reason: 'cursor-agent / agent CLI not found' };
  }
  const winDirs = getWindowsCursorSearchDirs(deps.env, deps.homeDir || undefined, p.join);
  const searchDirs = uniqueNonEmpty([
    ...(deps.env.PATH ?? '').split(WIN_DELIMITER),
    ...winDirs,
  ]);
  const pathext = getSupportedCursorWindowsExts(deps.env.PATHEXT);
  // Only accept supported executable Windows extensions (.com/.exe/.bat/.cmd) — never extensionless POSIX scripts or raw .ps1.
  // For .cmd/.bat wrappers present on disk, verify Cursor wrapper resolution succeeds before reporting installed.
  for (const bin of ['cursor-agent', 'agent']) {
    const fileNames = pathext.some((ext) => bin.toLowerCase().endsWith(ext.toLowerCase()))
      ? [bin]
      : pathext.map((ext) => `${bin}${ext}`);
    for (const dir of searchDirs) {
      for (const fileName of fileNames) {
        const candidate = p.join(dir, fileName);
        if (!(await deps.isExecutableFile(candidate))) continue;
        if (/\.(cmd|bat)$/i.test(candidate)) {
          const diskCandidate = process.platform !== 'win32' && (candidate.startsWith('/') || /^\\[^\\]/.test(candidate))
            ? candidate.replace(/\\/g, '/')
            : candidate;
          let isRealDiskFile = false;
          try {
            isRealDiskFile = statSync(diskCandidate).isFile();
          } catch {
            isRealDiskFile = false;
          }
          if (isRealDiskFile && !resolveCursorCmdLauncherPlan(diskCandidate)) continue;
        }
        return { installed: true };
      }
    }
  }
  return { installed: false, reason: 'cursor-agent / agent CLI not found' };
}

async function probeOpenCode(deps: AgentAvailabilityProbeDeps, requireSdkPackage: boolean): Promise<AgentAvailabilityEntry> {
  if (requireSdkPackage) {
    const rootMain = deps.resolvePackageRoot('@opencode-ai/sdk', '@opencode-ai/sdk');
    const rootV2 = deps.resolvePackageRoot('@opencode-ai/sdk/v2/client', '@opencode-ai/sdk');
    if (!rootMain || !rootV2) {
      return { installed: false, reason: '@opencode-ai/sdk package not installed' };
    }
  }
  // Matches `@opencode-ai/sdk` `createOpencodeServer()` (`cross-spawn('opencode')`) and `OpenCodeDriver`: PATH only.
  return probeBinary(deps, 'opencode', { includeWindowsGlobalNpmDirs: false }, 'opencode CLI not found');
}

async function probeGrokSdk(deps: AgentAvailabilityProbeDeps): Promise<AgentAvailabilityEntry> {
  const p = pathModuleFor(deps.platform);
  const configured = deps.env[GROK_CLI_PATH_ENV]?.trim() || GROK_CLI_BINARY;
  const grokHome = deps.env.GROK_HOME?.trim();
  // Matches `resolveGrokPathForSdk()` + `KimiSdkProvider` ACP `normalizeAcpPosixPath()`.
  if (deps.platform === 'win32') {
    const winDirs = uniqueNonEmpty([
      ...getWindowsGlobalCliDirs(deps),
      grokHome ? p.join(grokHome, 'bin') : undefined,
      deps.homeDir ? p.join(deps.homeDir, '.grok', 'bin') : undefined,
      deps.env.LOCALAPPDATA ? p.join(deps.env.LOCALAPPDATA, 'Programs', 'grok', 'bin') : undefined,
      deps.env.LOCALAPPDATA ? p.join(deps.env.LOCALAPPDATA, 'Programs', 'grok') : undefined,
      deps.env.LOCALAPPDATA ? p.join(deps.env.LOCALAPPDATA, 'grok', 'bin') : undefined,
      deps.homeDir ? p.join(deps.homeDir, '.local', 'bin') : undefined,
    ]);
    return probeBinary(deps, configured, { leadingDirs: winDirs }, 'grok CLI not found');
  }
  const unixDirs = uniqueNonEmpty([
    grokHome ? p.join(grokHome, 'bin') : undefined,
    deps.homeDir ? p.join(deps.homeDir, '.grok', 'bin') : undefined,
    ...getUnixAcpPreferredDirs(deps),
  ]);
  return probeBinary(deps, configured, { leadingDirs: unixDirs }, 'grok CLI not found');
}

async function probeMuseCodeSdk(deps: AgentAvailabilityProbeDeps): Promise<AgentAvailabilityEntry> {
  const p = pathModuleFor(deps.platform);
  if (deps.platform === 'win32') {
    return probeBinary(deps, 'muse', { includeWindowsGlobalNpmDirs: true }, 'muse CLI not found');
  }
  // Matches `MuseCodeSdkProvider.connect()`: `resolveMuseCodePathForSdk()` + `existsSync(resolved.executable)`.
  const unixDirs = uniqueNonEmpty([
    deps.homeDir ? p.join(deps.homeDir, '.local', 'bin') : undefined,
    deps.homeDir ? p.join(deps.homeDir, '.muse', 'bin') : undefined,
    deps.homeDir ? p.join(deps.homeDir, '.npm-global', 'bin') : undefined,
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
  ]);
  return probeBinary(deps, 'muse', { leadingDirs: unixDirs, searchEnvPath: false }, 'muse CLI not found');
}

async function probeHermes(deps: AgentAvailabilityProbeDeps): Promise<AgentAvailabilityEntry> {
  const p = pathModuleFor(deps.platform);
  const configured = deps.env.HERMES_CLI_PATH?.trim() || 'hermes';
  if (deps.platform === 'win32') {
    const winDirs = uniqueNonEmpty([
      deps.homeDir ? p.join(deps.homeDir, '.hermes', 'hermes-agent', 'venv', 'Scripts') : undefined,
      deps.homeDir ? p.join(deps.homeDir, '.hermes', 'bin') : undefined,
      deps.homeDir ? p.join(deps.homeDir, '.local', 'bin') : undefined,
    ]);
    return probeBinary(deps, configured, { leadingDirs: winDirs }, 'hermes CLI not found');
  }
  const unixDirs = uniqueNonEmpty([
    deps.homeDir ? p.join(deps.homeDir, '.hermes', 'bin') : undefined,
    deps.homeDir ? p.join(deps.homeDir, '.local', 'bin') : undefined,
    deps.homeDir ? p.join(deps.homeDir, '.hermes', 'hermes-agent', 'venv', 'bin') : undefined,
    ...getUnixAcpPreferredDirs(deps),
  ]);
  return probeBinary(deps, configured, { leadingDirs: unixDirs }, 'hermes CLI not found');
}

async function probeCodeBuddy(deps: AgentAvailabilityProbeDeps, chinaRegion: boolean): Promise<AgentAvailabilityEntry> {
  const p = pathModuleFor(deps.platform);
  const configured = deps.env[CODEBUDDY_CLI_PATH_ENVIRONMENT_VARIABLE]?.trim();
  if (configured) {
    return probeBinary(
      deps,
      configured,
      { trailingDirs: deps.platform === 'win32' ? [] : getUnixAcpPreferredDirs(deps) },
      'codebuddy CLI not found',
    );
  }
  if (chinaRegion) {
    if (deps.platform === 'darwin') {
      const macBundled = '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy';
      if (await deps.isExecutableFile(macBundled)) return { installed: true };
    } else if (deps.platform === 'win32' && deps.env.LOCALAPPDATA?.trim()) {
      const localAppData = deps.env.LOCALAPPDATA.trim();
      const winBundled = [
        p.join(localAppData, 'Programs', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy.exe'),
        p.join(localAppData, 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy.exe'),
      ];
      for (const candidate of winBundled) {
        if (await deps.isExecutableFile(candidate)) return { installed: true };
      }
    }
  }
  if (deps.platform === 'win32') {
    const winInstalled = deps.homeDir ? p.join(deps.homeDir, '.local', 'bin', 'codebuddy.exe') : undefined;
    if (winInstalled && (await deps.isExecutableFile(winInstalled))) return { installed: true };
    return probeBinary(deps, 'codebuddy', { includeWindowsGlobalNpmDirs: true }, 'codebuddy CLI not found');
  }
  return probeBinary(deps, 'codebuddy', { trailingDirs: getUnixAcpPreferredDirs(deps) }, 'codebuddy CLI not found');
}

async function probeOpenClaw(deps: AgentAvailabilityProbeDeps): Promise<AgentAvailabilityEntry> {
  if (deps.isProviderConnected('openclaw')) return { installed: true };
  if (deps.env.OPENCLAW_GATEWAY_TOKEN?.trim()) return { installed: true };
  const p = pathModuleFor(deps.platform);
  if (await deps.fileExists(p.join(deps.imcodesHomeDir, 'openclaw.json'))) return { installed: true };
  if (await deps.fileExists(p.join(deps.homeDir, '.openclaw', 'openclaw.json'))) return { installed: true };
  return { installed: false, reason: 'OpenClaw gateway config not found' };
}

async function probeAgentType(agentType: SessionAgentType, deps: AgentAvailabilityProbeDeps): Promise<AgentAvailabilityEntry> {
  switch (agentType) {
    case AGY_SDK_PROVIDER_ID:
      return probeAgy(deps);
    case 'claude-code-sdk':
    case CLAUDE_CODE_CLI_SDK_AGENT_TYPE:
      return probeClaudeSdk(deps);
    case 'claude-code':
      return probeClaudeCli(deps);
    case 'codex-sdk':
      return probeBinary(deps, 'codex', { includeWindowsGlobalNpmDirs: true }, 'codex CLI not found');
    case 'codex':
      return probeBinary(deps, 'codex', { includeWindowsGlobalNpmDirs: false }, 'codex CLI not found');
    case 'qoder-sdk':
      return probeQoderSdk(deps);
    case 'copilot-sdk':
      return probeCopilotSdk(deps);
    case 'cursor-headless':
      return probeCursorHeadless(deps);
    case 'opencode-sdk':
      return probeOpenCode(deps, true);
    case 'opencode':
      return probeOpenCode(deps, false);
    case 'grok-sdk':
      return probeGrokSdk(deps);
    case 'kimi-sdk':
      return probeBinary(
        deps,
        'kimi',
        { trailingDirs: deps.platform === 'win32' ? [] : getUnixAcpPreferredDirs(deps) },
        'kimi CLI not found',
      );
    case 'muse-code-sdk':
      return probeMuseCodeSdk(deps);
    case HERMES_AGENT_PROVIDER_ID:
      return probeHermes(deps);
    case 'deepseek-harness':
      return probeBinary(
        deps,
        deps.env[DSH_BINARY_ENV]?.trim() || DSH_DEFAULT_BINARY,
        { includeWindowsGlobalNpmDirs: true },
        'dsh CLI not found',
      );
    case 'pi':
      return probeBinary(
        deps,
        deps.env[PI_BINARY_ENV]?.trim() || PI_DEFAULT_BINARY,
        { includeWindowsGlobalNpmDirs: true },
        'pi CLI not found',
      );
    case CODEBUDDY_PROVIDER_IDS.CHINA:
      return probeCodeBuddy(deps, true);
    case CODEBUDDY_PROVIDER_IDS.INTERNATIONAL:
      return probeCodeBuddy(deps, false);
    case 'qwen':
      return probeBinary(deps, 'qwen', { includeWindowsGlobalNpmDirs: true }, 'qwen CLI not found');
    case 'openclaw':
      return probeOpenClaw(deps);
    case 'shell':
    case 'script':
      return { installed: true };
  }
}

function withProbeTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  if (!(ms > 0)) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(onTimeout());
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function runAgentAvailabilityProbe(deps: AgentAvailabilityProbeDeps, timeoutMs: number): Promise<AgentAvailabilityMap> {
  const entries = await Promise.all(
    SESSION_AGENT_TYPES.map(async (agentType) => {
      const entry = await withProbeTimeout(
        probeAgentType(agentType, deps),
        timeoutMs,
        () => ({ installed: false, reason: 'Probe timed out' }),
      );
      return [agentType, entry] as const;
    }),
  );
  return Object.fromEntries(entries) as AgentAvailabilityMap;
}

/** Probe installed agents with cache, epoch ordering, and timeout metadata. */
export async function detectInstalledAgentsWithMetadata(
  options: DetectInstalledAgentsOptions = {},
): Promise<DetectInstalledAgentsResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PER_AGENT_TIMEOUT_MS;
  if (options.deps) {
    const epoch = ++probeEpoch;
    const agents = await runAgentAvailabilityProbe(buildDefaultDeps(options.deps), timeoutMs);
    return { agents, epoch, checkedAt: options.now ?? Date.now() };
  }

  const now = options.now ?? Date.now();
  const forceRefresh = options.forceRefresh === true;

  // Coalesce normal requests onto any active probe (even if a stale TTL cache exists),
  // and coalesce concurrent forceRefresh requests onto an already-running forced probe.
  if (activeProbe && (!forceRefresh || activeProbe.forced)) {
    const targetEpoch = activeProbe.epoch;
    const agents = await activeProbe.promise;
    if (cachedResult && cachedResult.epoch >= targetEpoch) {
      return {
        agents: cachedResult.agents,
        epoch: cachedResult.epoch,
        checkedAt: cachedResult.checkedAt,
      };
    }
    return { agents, epoch: targetEpoch, checkedAt: options.now ?? Date.now() };
  }

  if (!forceRefresh && cachedResult && now - cachedResult.checkedAt < CACHE_TTL_MS) {
    return {
      agents: cachedResult.agents,
      epoch: cachedResult.epoch,
      checkedAt: cachedResult.checkedAt,
    };
  }

  const myEpoch = ++probeEpoch;
  const promise = runAgentAvailabilityProbe(buildDefaultDeps(), timeoutMs)
    .then((agents) => {
      // Never let a slower earlier probe overwrite a newer probe in cache.
      if (myEpoch === probeEpoch) {
        cachedResult = { epoch: myEpoch, checkedAt: options.now ?? Date.now(), agents };
      }
      return cachedResult && cachedResult.epoch > myEpoch ? cachedResult.agents : agents;
    })
    .finally(() => {
      if (activeProbe?.epoch === myEpoch) {
        activeProbe = null;
      }
    });

  activeProbe = { epoch: myEpoch, forced: forceRefresh, promise };
  const agents = await promise;
  if (cachedResult && cachedResult.epoch >= myEpoch) {
    return {
      agents: cachedResult.agents,
      epoch: cachedResult.epoch,
      checkedAt: cachedResult.checkedAt,
    };
  }
  return {
    agents,
    epoch: myEpoch,
    checkedAt: options.now ?? Date.now(),
  };
}

/** Probe which selectable agent SDKs and CLIs are installed/available on the host. */
export async function detectInstalledAgents(options: DetectInstalledAgentsOptions = {}): Promise<AgentAvailabilityMap> {
  const result = await detectInstalledAgentsWithMetadata(options);
  return result.agents;
}
