import {
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  buildAbortSignal,
  clearMacosQuarantineBestEffort,
  collectConfiguredNonLoopbackUrls,
  createProxyAwareFetch,
  defaultCheckFileExecutable,
  defaultIsLinuxMusl,
  defaultVerifyVersion,
  downloadResponseToFileWithIntegrity,
  encodeNpmPackageName,
  ensureExecutablePermission,
  ensureSafePathWithinHome,
  extractSingleBinaryFromTarGzFile,
  extractVendorSubtreeFromTarGzFile,
  filterCandidatesForIsolation,
  findCommandInEnvPath,
  getPathModule,
  normalizeRegistryUrl,
  parseBooleanEnv,
  readEnvCaseInsensitive,
  resolveCandidateNpmRegistries,
  validateDownloadUrl,
  fetchWithSafeRedirects,
  type CliInstallLogger,
  type InstallCliResult,
  type NpmDistMetadata,
} from './cli-install-helpers.js';
import { installOpenCodeCli } from './install-opencode-cli.js';

export const AGY_OFFICIAL_MANIFEST_BASE_URL = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app';

const DEFAULT_METADATA_TIMEOUT_MS = 10_000;
const DEFAULT_AGY_METADATA_TIMEOUT_MS = 8_000;
const DEFAULT_NPM_TARBALL_TIMEOUT_MS = 120_000;
const DEFAULT_AGY_DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_VERSION_TIMEOUT_MS = 5_000;

const MAX_CODEX_TARBALL_BYTES = 450 * 1024 * 1024;
const MAX_CLAUDE_TARBALL_BYTES = 350 * 1024 * 1024;
const MAX_AGY_DOWNLOAD_BYTES = 200 * 1024 * 1024;

export type DefaultAgentCliId = 'opencode' | 'codex' | 'claude' | 'agy';

export interface InstallSingleCliOptions {
  homeDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  isMusl?: boolean;
  env?: NodeJS.ProcessEnv;
  skip?: boolean;
  registry?: string;
  registries?: string[];
  agyManifestBaseUrl?: string;
  agyManifestBaseUrls?: string[];
  noFallback?: boolean;
  isolatedTest?: boolean;
  metadataTimeoutMs?: number;
  tarballTimeoutMs?: number;
  versionTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  checkFileExecutable?: (filePath: string) => Promise<boolean>;
  verifyVersion?: (binPath: string, timeoutMs: number) => string | undefined;
  linkFile?: (existingPath: string, newPath: string) => void;
  logger?: CliInstallLogger;
}

export interface InstallDefaultAgentClisOptions extends InstallSingleCliOptions {
  only?: DefaultAgentCliId[];
  skipOpenCode?: boolean;
  skipCodex?: boolean;
  skipClaude?: boolean;
  skipAgy?: boolean;
}

export interface InstallDefaultAgentClisResult {
  results: Partial<Record<DefaultAgentCliId, InstallCliResult>>;
}

export function isAgentCliOptedOut(
  specificEnvKey: string,
  opts: { skip?: boolean; env?: NodeJS.ProcessEnv } = {},
): boolean {
  if (opts.skip) return true;
  const env = opts.env ?? process.env;
  return parseBooleanEnv(env.IMCODES_SKIP_AGENT_CLIS) || parseBooleanEnv(env[specificEnvKey]);
}

export function resolveCodexPlatformSuffix(opts: {
  platform?: NodeJS.Platform;
  arch?: string;
} = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  if (platform === 'darwin') {
    if (arch === 'arm64') return 'darwin-arm64';
    if (arch === 'x64') return 'darwin-x64';
    return null;
  }
  if (platform === 'linux') {
    if (arch === 'x64') return 'linux-x64';
    if (arch === 'arm64') return 'linux-arm64';
    return null;
  }
  if (platform === 'win32') {
    if (arch === 'x64') return 'win32-x64';
    if (arch === 'arm64') return 'win32-arm64';
    return null;
  }
  return null;
}

export function resolveClaudePlatformPackage(opts: {
  platform?: NodeJS.Platform;
  arch?: string;
  isMusl?: boolean;
} = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  if (platform === 'darwin') {
    if (arch === 'arm64') return '@anthropic-ai/claude-code-darwin-arm64';
    if (arch === 'x64') return '@anthropic-ai/claude-code-darwin-x64';
    return null;
  }
  if (platform === 'linux') {
    const musl = opts.isMusl ?? defaultIsLinuxMusl(platform);
    if (arch === 'x64') return musl ? '@anthropic-ai/claude-code-linux-x64-musl' : '@anthropic-ai/claude-code-linux-x64';
    if (arch === 'arm64') return musl ? '@anthropic-ai/claude-code-linux-arm64-musl' : '@anthropic-ai/claude-code-linux-arm64';
    return null;
  }
  if (platform === 'win32') {
    if (arch === 'x64') return '@anthropic-ai/claude-code-win32-x64';
    if (arch === 'arm64') return '@anthropic-ai/claude-code-win32-arm64';
    return null;
  }
  return null;
}

export function resolveAgyManifestPlatform(opts: {
  platform?: NodeJS.Platform;
  arch?: string;
  isMusl?: boolean;
} = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  if (platform === 'darwin') {
    if (arch === 'arm64') return 'darwin_arm64';
    if (arch === 'x64') return 'darwin_amd64';
    return null;
  }
  if (platform === 'linux') {
    const musl = opts.isMusl ?? defaultIsLinuxMusl(platform);
    if (arch === 'x64') return musl ? 'linux_amd64_musl' : 'linux_amd64';
    if (arch === 'arm64') return musl ? 'linux_arm64_musl' : 'linux_arm64';
    return null;
  }
  if (platform === 'win32') {
    if (arch === 'x64') return 'windows_amd64';
    if (arch === 'arm64') return 'windows_arm64';
    return null;
  }
  return null;
}

async function checkHomeCandidates(
  candidates: readonly string[],
  isExec: (filePath: string) => Promise<boolean>,
): Promise<string | null> {
  for (const candidate of candidates) {
    if (await isExec(candidate)) return candidate;
  }
  return null;
}

export async function isCodexAlreadyInstalled(opts: {
  homeDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  checkFileExecutable?: (filePath: string) => Promise<boolean>;
} = {}): Promise<string | null> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? homedir();
  const pathMod = getPathModule(platform, homeDir);
  const isExec = opts.checkFileExecutable ?? ((filePath: string) => defaultCheckFileExecutable(filePath, platform));
  const binName = platform === 'win32' ? 'codex.exe' : 'codex';

  if (homeDir && platform === process.platform) {
    ensureSafePathWithinHome(homeDir, ['.codex', 'bin'], binName, platform, false);
  }

  for (const candidate of findCommandInEnvPath(['codex'], platform, env)) {
    if (await isExec(candidate)) return candidate;
  }

  const homeCandidates: string[] = [];
  if (homeDir) {
    homeCandidates.push(
      pathMod.join(homeDir, '.codex', 'bin', binName),
      pathMod.join(homeDir, '.local', 'bin', binName),
    );
  }
  if (platform === 'win32') {
    const appData = readEnvCaseInsensitive(env, 'APPDATA');
    if (appData) {
      homeCandidates.push(pathMod.join(appData, 'npm', 'codex.cmd'), pathMod.join(appData, 'npm', 'codex.exe'));
    }
  }
  return await checkHomeCandidates(homeCandidates, isExec);
}

export async function isClaudeAlreadyInstalled(opts: {
  homeDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  checkFileExecutable?: (filePath: string) => Promise<boolean>;
} = {}): Promise<string | null> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? homedir();
  const pathMod = getPathModule(platform, homeDir);
  const isExec = opts.checkFileExecutable ?? ((filePath: string) => defaultCheckFileExecutable(filePath, platform));
  const binName = platform === 'win32' ? 'claude.exe' : 'claude';

  if (homeDir && platform === process.platform) {
    ensureSafePathWithinHome(homeDir, ['.local', 'bin'], binName, platform, false);
  }

  for (const candidate of findCommandInEnvPath(['claude'], platform, env)) {
    if (await isExec(candidate)) return candidate;
  }

  const homeCandidates: string[] = [];
  if (homeDir) {
    homeCandidates.push(
      pathMod.join(homeDir, '.local', 'bin', binName),
      pathMod.join(homeDir, '.claude', 'local', binName),
    );
  }
  if (platform === 'win32') {
    const localAppData = readEnvCaseInsensitive(env, 'LOCALAPPDATA');
    const appData = readEnvCaseInsensitive(env, 'APPDATA');
    if (localAppData) {
      homeCandidates.push(pathMod.join(localAppData, 'Programs', 'Claude', 'claude.exe'));
    }
    if (appData) {
      homeCandidates.push(pathMod.join(appData, 'npm', 'claude.cmd'), pathMod.join(appData, 'npm', 'claude.exe'));
    }
  }
  return await checkHomeCandidates(homeCandidates, isExec);
}

export async function isAgyAlreadyInstalled(opts: {
  homeDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  checkFileExecutable?: (filePath: string) => Promise<boolean>;
} = {}): Promise<string | null> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? homedir();
  const pathMod = getPathModule(platform, homeDir);
  const isExec = opts.checkFileExecutable ?? ((filePath: string) => defaultCheckFileExecutable(filePath, platform));
  const binName = platform === 'win32' ? 'agy.exe' : 'agy';

  if (homeDir && platform === process.platform) {
    ensureSafePathWithinHome(homeDir, ['.local', 'bin'], binName, platform, false);
  }

  for (const candidate of findCommandInEnvPath(['agy'], platform, env)) {
    if (await isExec(candidate)) return candidate;
  }

  const homeCandidates: string[] = [];
  if (homeDir) {
    homeCandidates.push(
      pathMod.join(homeDir, '.local', 'bin', binName),
      pathMod.join(homeDir, '.gemini', 'antigravity-cli', 'bin', binName),
    );
  }
  if (platform === 'win32') {
    const localAppData = readEnvCaseInsensitive(env, 'LOCALAPPDATA');
    if (localAppData) {
      homeCandidates.push(
        pathMod.join(localAppData, 'agy', 'bin', 'agy.exe'),
        pathMod.join(localAppData, 'antigravity-cli', 'bin', 'agy.exe'),
      );
    }
  }
  return await checkHomeCandidates(homeCandidates, isExec);
}

function makeUniqueSuffix(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function rollbackCreatedArtifacts(createdFiles: readonly string[], createdDirs: readonly string[]): void {
  for (let i = createdFiles.length - 1; i >= 0; i -= 1) {
    try {
      rmSync(createdFiles[i]!, { force: true });
    } catch {
      // ignore rollback cleanup failure
    }
  }
  for (let i = createdDirs.length - 1; i >= 0; i -= 1) {
    try {
      rmdirSync(createdDirs[i]!);
    } catch {
      // ignore non-empty or already removed directory
    }
  }
}

function trackMissingDirsBeforeCreate(
  baseDir: string,
  relSegments: readonly string[],
  platform: NodeJS.Platform,
  createdDirs: string[],
): void {
  const pathMod = getPathModule(platform, baseDir);
  let cur = baseDir;
  for (const seg of relSegments) {
    cur = pathMod.join(cur, seg);
    if (createdDirs.includes(cur)) continue;
    try {
      lstatSync(cur);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        createdDirs.push(cur);
      }
    }
  }
}

function publishStagedDirectorySiblings(
  stagedRoot: string,
  targetRoot: string,
  skipRelPath: string,
  homeDir: string,
  platform: NodeJS.Platform,
  linkFn: (existingPath: string, newPath: string) => void,
  createdFiles: string[],
  createdDirs: string[],
): void {
  const pathMod = getPathModule(platform, homeDir);
  const walk = (relParts: string[]): void => {
    const srcDir = relParts.length === 0 ? stagedRoot : pathMod.join(stagedRoot, ...relParts);
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      const nextParts = [...relParts, entry.name];
      const relPosix = nextParts.join('/');
      if (relPosix === skipRelPath) continue;
      const srcPath = pathMod.join(stagedRoot, ...nextParts);
      if (entry.isDirectory()) {
        trackMissingDirsBeforeCreate(homeDir, ['.codex', ...nextParts], platform, createdDirs);
        if (platform === process.platform) {
          ensureSafePathWithinHome(homeDir, ['.codex', ...nextParts], undefined, platform, true);
        } else {
          mkdirSync(pathMod.join(targetRoot, ...nextParts), { recursive: true });
        }
        walk(nextParts);
      } else if (entry.isFile()) {
        const parentRel = ['.codex', ...relParts];
        trackMissingDirsBeforeCreate(homeDir, parentRel, platform, createdDirs);
        if (platform === process.platform) {
          ensureSafePathWithinHome(homeDir, parentRel, entry.name, platform, true);
        } else {
          mkdirSync(pathMod.join(targetRoot, ...relParts), { recursive: true });
        }
        const destFile = pathMod.join(targetRoot, ...nextParts);
        try {
          const existingStat = lstatSync(destFile);
          if (existingStat.isSymbolicLink()) {
            throw new Error(`unsafe_symlink_target:${entry.name}`);
          }
          // Preserve pre-existing sibling files untouched without overwriting or tracking them for rollback.
          continue;
        } catch (statErr: unknown) {
          if ((statErr as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
            throw statErr;
          }
        }
        try {
          linkFn(srcPath, destFile);
          createdFiles.push(destFile);
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException | undefined)?.code;
          if (code === 'EEXIST') continue;
          if (code === 'EXDEV' || code === 'EPERM') {
            try {
              copyFileSync(srcPath, destFile, fsConstants.COPYFILE_EXCL);
            } catch (copyErr: unknown) {
              if ((copyErr as NodeJS.ErrnoException | undefined)?.code === 'EEXIST') continue;
              throw copyErr;
            }
            createdFiles.push(destFile);
            if (platform !== 'win32') {
              chmodSync(destFile, lstatSync(srcPath).mode & 0o777);
            }
          } else {
            throw err;
          }
        }
      }
    }
  };
  walk([]);
}

function resolveCodexSubpackageVersion(
  meta: { version?: unknown; optionalDependencies?: unknown },
  npmSuffix: string,
): string | null {
  const depKey = `@openai/codex-${npmSuffix}`;
  if (meta.optionalDependencies && typeof meta.optionalDependencies === 'object') {
    const rawSpec = (meta.optionalDependencies as Record<string, unknown>)[depKey];
    if (typeof rawSpec === 'string') {
      const prefix = 'npm:@openai/codex@';
      if (rawSpec.startsWith(prefix)) {
        const ver = rawSpec.slice(prefix.length).trim();
        if (ver) return ver;
      }
      if (/^[0-9].*-/.test(rawSpec.trim())) {
        return rawSpec.trim();
      }
    }
  }
  if (typeof meta.version === 'string' && meta.version.trim()) {
    return `${meta.version.trim()}-${npmSuffix}`;
  }
  return null;
}

export async function installCodexCli(opts: InstallSingleCliOptions = {}): Promise<InstallCliResult> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const homeDir = opts.homeDir ?? homedir();
  const pathMod = getPathModule(platform, homeDir);
  const fetchFn = opts.fetchImpl ?? fetch;
  const verifyVer = opts.verifyVersion ?? defaultVerifyVersion;
  const linkFn = opts.linkFile ?? linkSync;
  const metadataTimeoutMs = opts.metadataTimeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS;
  const tarballTimeoutMs = opts.tarballTimeoutMs ?? DEFAULT_NPM_TARBALL_TIMEOUT_MS;
  const versionTimeoutMs = opts.versionTimeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS;
  const isolatedTest = Boolean(opts.isolatedTest || parseBooleanEnv(env.IMCODES_OPENCODE_ISOLATED_TEST));

  if (isAgentCliOptedOut('IMCODES_SKIP_CODEX', { skip: opts.skip, env })) {
    opts.logger?.info?.('skipping Codex CLI install (IMCODES_SKIP_CODEX / --skip)');
    return { status: 'skipped' };
  }

  let existing: string | null;
  try {
    existing = await isCodexAlreadyInstalled({
      homeDir,
      platform,
      env,
      checkFileExecutable: opts.checkFileExecutable,
    });
  } catch (pathErr) {
    const reason = pathErr instanceof Error ? pathErr.message : String(pathErr);
    opts.logger?.warn?.(`unsafe Codex target path: ${reason}`);
    return { status: 'failed', reason };
  }
  if (existing) {
    opts.logger?.info?.(`found existing codex CLI at ${existing} — keeping existing install`);
    return { status: 'existing', path: existing };
  }

  const suffix = resolveCodexPlatformSuffix({ platform, arch });
  if (!suffix) {
    opts.logger?.info?.(`Codex CLI binary unavailable for ${platform}/${arch}; skipping`);
    return { status: 'unsupported', reason: `unsupported_platform:${platform}/${arch}` };
  }

  const registries = resolveCandidateNpmRegistries({
    registry: opts.registry,
    registries: opts.registries,
    customEnvKey: 'IMCODES_CODEX_REGISTRY',
    env,
    homeDir,
    noFallback: opts.noFallback,
    isolatedTest,
  });
  if (registries.length === 0) {
    const rejected = isolatedTest
      ? collectConfiguredNonLoopbackUrls([
          ...(opts.registries ?? []),
          opts.registry,
          env.IMCODES_CODEX_REGISTRY,
        ])
      : [];
    return {
      status: 'failed',
      packageName: '@openai/codex',
      reason: rejected.length > 0 ? `disallowed_non_loopback_isolated_origin:${rejected[0]}` : 'no_valid_registry',
    };
  }

  const binaryName = platform === 'win32' ? 'codex.exe' : 'codex';
  const codexBaseDir = pathMod.join(homeDir, '.codex');
  const binDir = pathMod.join(codexBaseDir, 'bin');
  const destPath = pathMod.join(binDir, binaryName);
  const proxy = await createProxyAwareFetch(fetchFn, env, { isolatedTest });

  let lastReason = 'unknown_error';
  try {
    for (const registry of registries) {
      const suffixTag = makeUniqueSuffix();
      const tmpTgz = pathMod.join(codexBaseDir, `.tmp-codex-${suffixTag}.tgz`);
      const stageDir = pathMod.join(codexBaseDir, `.tmp-codex-stage-${suffixTag}`);
      const createdFiles: string[] = [];
      const createdDirs: string[] = [];

      try {
        const regUrl = new URL(registry);
        const regProto = regUrl.protocol;
        const strictOrigin = isolatedTest ? regUrl.origin : undefined;

        const encodedPkg = encodeNpmPackageName('@openai/codex');
        const rootMetaUrl = `${registry}/${encodedPkg}/latest`;
        const rootMetaRes = await fetchWithSafeRedirects(proxy.fetchFn, rootMetaUrl, {
          headers: { accept: 'application/json' },
          signal: buildAbortSignal(metadataTimeoutMs),
          allowedProto: regProto,
          strictOrigin,
          isolatedTest,
        });
        if (!rootMetaRes.ok) {
          throw new Error(`metadata_http_${rootMetaRes.status}`);
        }
        const rootMeta = await rootMetaRes.json() as { version?: unknown; optionalDependencies?: unknown };
        const subVersion = resolveCodexSubpackageVersion(rootMeta, suffix);
        if (!subVersion) {
          throw new Error(`missing_codex_platform_version:${suffix}`);
        }

        const subMetaUrl = `${registry}/${encodedPkg}/${encodeURIComponent(subVersion)}`;
        const subMetaRes = await fetchWithSafeRedirects(proxy.fetchFn, subMetaUrl, {
          headers: { accept: 'application/json' },
          signal: buildAbortSignal(metadataTimeoutMs),
          allowedProto: regProto,
          strictOrigin,
          isolatedTest,
        });
        if (!subMetaRes.ok) {
          throw new Error(`metadata_http_${subMetaRes.status}`);
        }
        const subMeta = await subMetaRes.json() as { version?: unknown; dist?: NpmDistMetadata };
        const dist = subMeta?.dist;
        const tarballUrl = typeof dist?.tarball === 'string' ? dist.tarball.trim() : '';
        if (!tarballUrl) throw new Error('missing_tarball_url');
        validateDownloadUrl(tarballUrl, regProto, strictOrigin, isolatedTest);

        if (platform === process.platform) {
          ensureSafePathWithinHome(homeDir, ['.codex', 'bin'], binaryName, platform, true);
        } else {
          mkdirSync(binDir, { recursive: true });
        }

        const tarRes = await fetchWithSafeRedirects(proxy.fetchFn, tarballUrl, {
          signal: buildAbortSignal(tarballTimeoutMs),
          allowedProto: regProto,
          strictOrigin,
          isolatedTest,
        });
        if (!tarRes.ok) {
          throw new Error(`tarball_http_${tarRes.status}`);
        }

        await downloadResponseToFileWithIntegrity(tarRes, tmpTgz, {
          maxBytes: MAX_CODEX_TARBALL_BYTES,
          dist,
        });

        await extractVendorSubtreeFromTarGzFile(tmpTgz, stageDir, {
          prefixRegex: /^package\/vendor\/([^/]+)\/(.+)$/,
          requiredRelPaths: [`bin/${binaryName}`],
          platform,
        });

        const stagedBin = pathMod.join(stageDir, 'bin', binaryName);
        if (platform !== 'win32') {
          chmodSync(stagedBin, 0o755);
        }
        clearMacosQuarantineBestEffort(stagedBin, platform);

        let detectedVersion: string | undefined;
        const metaVersion = typeof rootMeta.version === 'string' ? rootMeta.version.trim() : subVersion;
        try {
          detectedVersion = verifyVer(stagedBin, versionTimeoutMs);
        } catch (verErr) {
          const msg = verErr instanceof Error ? verErr.message : String(verErr);
          opts.logger?.warn?.(`staged Codex CLI version probe failed: ${msg}`);
          return {
            status: 'unverified',
            version: metaVersion,
            packageName: `@openai/codex@${subVersion}`,
            registry,
            reason: msg,
          };
        }

        // Check concurrent destination binary BEFORE publishing siblings.
        try {
          const existingStat = lstatSync(destPath);
          if (existingStat.isSymbolicLink()) {
            throw new Error(`unsafe_symlink_target:${binaryName}`);
          }
          opts.logger?.info?.(`found concurrent codex CLI at ${destPath} — keeping existing install`);
          return {
            status: 'existing',
            path: destPath,
            version: detectedVersion || metaVersion,
            packageName: `@openai/codex@${subVersion}`,
            registry,
          };
        } catch (destStatErr: unknown) {
          if ((destStatErr as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
            throw destStatErr;
          }
        }

        // Publish required siblings BEFORE making the main codex binary visible; rollback any
        // newly created siblings/directories on failure or concurrent binary publish race.
        publishStagedDirectorySiblings(
          stageDir,
          codexBaseDir,
          `bin/${binaryName}`,
          homeDir,
          platform,
          linkFn,
          createdFiles,
          createdDirs,
        );

        let publishedAsExisting = false;
        try {
          linkFn(stagedBin, destPath);
        } catch (linkErr: unknown) {
          const code = (linkErr as NodeJS.ErrnoException | undefined)?.code;
          if (code === 'EEXIST') {
            publishedAsExisting = true;
          } else {
            throw linkErr;
          }
        }

        if (publishedAsExisting) {
          rollbackCreatedArtifacts(createdFiles, createdDirs);
          opts.logger?.info?.(`found concurrent codex CLI at ${destPath} — keeping existing install`);
          return {
            status: 'existing',
            path: destPath,
            version: detectedVersion || metaVersion,
            packageName: `@openai/codex@${subVersion}`,
            registry,
          };
        }

        ensureExecutablePermission(destPath, platform);

        const finalVersion = detectedVersion || metaVersion;
        opts.logger?.info?.(`installed codex CLI${finalVersion ? ` (${finalVersion})` : ''} at ${destPath}`);
        return {
          status: 'installed',
          path: destPath,
          version: finalVersion,
          packageName: `@openai/codex@${subVersion}`,
          registry,
        };
      } catch (err) {
        rollbackCreatedArtifacts(createdFiles, createdDirs);
        lastReason = err instanceof Error ? err.message : String(err);
        opts.logger?.warn?.(`codex install attempt from ${registry} failed (${lastReason})`);
      } finally {
        rmSync(tmpTgz, { force: true });
        rmSync(stageDir, { recursive: true, force: true });
      }
    }
  } finally {
    await proxy.close();
  }

  return {
    status: 'failed',
    packageName: `@openai/codex-${suffix}`,
    reason: lastReason,
  };
}

export async function installClaudeCli(opts: InstallSingleCliOptions = {}): Promise<InstallCliResult> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const homeDir = opts.homeDir ?? homedir();
  const pathMod = getPathModule(platform, homeDir);
  const fetchFn = opts.fetchImpl ?? fetch;
  const verifyVer = opts.verifyVersion ?? defaultVerifyVersion;
  const linkFn = opts.linkFile ?? linkSync;
  const metadataTimeoutMs = opts.metadataTimeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS;
  const tarballTimeoutMs = opts.tarballTimeoutMs ?? DEFAULT_NPM_TARBALL_TIMEOUT_MS;
  const versionTimeoutMs = opts.versionTimeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS;
  const isolatedTest = Boolean(opts.isolatedTest || parseBooleanEnv(env.IMCODES_OPENCODE_ISOLATED_TEST));

  if (isAgentCliOptedOut('IMCODES_SKIP_CLAUDE', { skip: opts.skip, env })) {
    opts.logger?.info?.('skipping Claude Code CLI install (IMCODES_SKIP_CLAUDE / --skip)');
    return { status: 'skipped' };
  }

  let existing: string | null;
  try {
    existing = await isClaudeAlreadyInstalled({
      homeDir,
      platform,
      env,
      checkFileExecutable: opts.checkFileExecutable,
    });
  } catch (pathErr) {
    const reason = pathErr instanceof Error ? pathErr.message : String(pathErr);
    opts.logger?.warn?.(`unsafe Claude Code target path: ${reason}`);
    return { status: 'failed', reason };
  }
  if (existing) {
    opts.logger?.info?.(`found existing claude CLI at ${existing} — keeping existing install`);
    return { status: 'existing', path: existing };
  }

  const packageName = resolveClaudePlatformPackage({ platform, arch, isMusl: opts.isMusl });
  if (!packageName) {
    opts.logger?.info?.(`Claude Code CLI binary unavailable for ${platform}/${arch}; skipping`);
    return { status: 'unsupported', reason: `unsupported_platform:${platform}/${arch}` };
  }

  const registries = resolveCandidateNpmRegistries({
    registry: opts.registry,
    registries: opts.registries,
    customEnvKey: 'IMCODES_CLAUDE_REGISTRY',
    env,
    homeDir,
    noFallback: opts.noFallback,
    isolatedTest,
  });
  if (registries.length === 0) {
    const rejected = isolatedTest
      ? collectConfiguredNonLoopbackUrls([
          ...(opts.registries ?? []),
          opts.registry,
          env.IMCODES_CLAUDE_REGISTRY,
        ])
      : [];
    return {
      status: 'failed',
      packageName,
      reason: rejected.length > 0 ? `disallowed_non_loopback_isolated_origin:${rejected[0]}` : 'no_valid_registry',
    };
  }

  const binaryName = platform === 'win32' ? 'claude.exe' : 'claude';
  const entryCandidates = [`package/${binaryName}`];
  const binDir = pathMod.join(homeDir, '.local', 'bin');
  const destPath = pathMod.join(binDir, binaryName);
  const proxy = await createProxyAwareFetch(fetchFn, env, { isolatedTest });

  let lastReason = 'unknown_error';
  try {
    for (const registry of registries) {
      const suffixTag = makeUniqueSuffix();
      const tmpTgz = pathMod.join(binDir, `.tmp-claude-${suffixTag}.tgz`);
      const tmpBin = pathMod.join(binDir, `.tmp-claude-${suffixTag}-${binaryName}`);

      try {
        const regUrl = new URL(registry);
        const regProto = regUrl.protocol;
        const strictOrigin = isolatedTest ? regUrl.origin : undefined;

        const metaUrl = `${registry}/${encodeNpmPackageName(packageName)}/latest`;
        const metaRes = await fetchWithSafeRedirects(proxy.fetchFn, metaUrl, {
          headers: { accept: 'application/json' },
          signal: buildAbortSignal(metadataTimeoutMs),
          allowedProto: regProto,
          strictOrigin,
          isolatedTest,
        });
        if (!metaRes.ok) {
          throw new Error(`metadata_http_${metaRes.status}`);
        }
        const meta = await metaRes.json() as { version?: unknown; dist?: NpmDistMetadata };
        const dist = meta?.dist;
        const tarballUrl = typeof dist?.tarball === 'string' ? dist.tarball.trim() : '';
        if (!tarballUrl) throw new Error('missing_tarball_url');
        validateDownloadUrl(tarballUrl, regProto, strictOrigin, isolatedTest);

        if (platform === process.platform) {
          ensureSafePathWithinHome(homeDir, ['.local', 'bin'], binaryName, platform, true);
        } else {
          mkdirSync(binDir, { recursive: true });
        }

        const tarRes = await fetchWithSafeRedirects(proxy.fetchFn, tarballUrl, {
          signal: buildAbortSignal(tarballTimeoutMs),
          allowedProto: regProto,
          strictOrigin,
          isolatedTest,
        });
        if (!tarRes.ok) {
          throw new Error(`tarball_http_${tarRes.status}`);
        }

        await downloadResponseToFileWithIntegrity(tarRes, tmpTgz, {
          maxBytes: MAX_CLAUDE_TARBALL_BYTES,
          dist,
        });

        await extractSingleBinaryFromTarGzFile(tmpTgz, entryCandidates, tmpBin, { platform });

        if (platform !== 'win32') {
          chmodSync(tmpBin, 0o755);
        }
        clearMacosQuarantineBestEffort(tmpBin, platform);

        const metaVersion = typeof meta.version === 'string' ? meta.version.trim() : undefined;
        let detectedVersion: string | undefined;
        try {
          detectedVersion = verifyVer(tmpBin, versionTimeoutMs);
        } catch (verErr) {
          const msg = verErr instanceof Error ? verErr.message : String(verErr);
          opts.logger?.warn?.(`staged Claude Code CLI version probe failed: ${msg}`);
          return {
            status: 'unverified',
            version: metaVersion,
            packageName,
            registry,
            reason: msg,
          };
        }

        let publishedAsExisting = false;
        try {
          linkFn(tmpBin, destPath);
        } catch (linkErr: unknown) {
          const code = (linkErr as NodeJS.ErrnoException | undefined)?.code;
          if (code === 'EEXIST') {
            publishedAsExisting = true;
          } else {
            throw linkErr;
          }
        }

        if (publishedAsExisting) {
          opts.logger?.info?.(`found concurrent claude CLI at ${destPath} — keeping existing install`);
          return {
            status: 'existing',
            path: destPath,
            version: detectedVersion || metaVersion,
            packageName,
            registry,
          };
        }

        ensureExecutablePermission(destPath, platform);
        const finalVersion = detectedVersion || metaVersion;
        opts.logger?.info?.(`installed claude CLI${finalVersion ? ` (${finalVersion})` : ''} at ${destPath}`);
        return {
          status: 'installed',
          path: destPath,
          version: finalVersion,
          packageName,
          registry,
        };
      } catch (err) {
        lastReason = err instanceof Error ? err.message : String(err);
        opts.logger?.warn?.(`claude install attempt from ${registry} failed (${lastReason})`);
      } finally {
        rmSync(tmpTgz, { force: true });
        rmSync(tmpBin, { force: true });
      }
    }
  } finally {
    await proxy.close();
  }

  return {
    status: 'failed',
    packageName,
    reason: lastReason,
  };
}

export function resolveCandidateAgyManifestBases(opts: {
  agyManifestBaseUrl?: string;
  agyManifestBaseUrls?: string[];
  env?: NodeJS.ProcessEnv;
  noFallback?: boolean;
  isolatedTest?: boolean;
} = {}): string[] {
  const env = opts.env ?? process.env;
  const isolatedTest = opts.isolatedTest || parseBooleanEnv(env.IMCODES_OPENCODE_ISOLATED_TEST);
  const noFallback = opts.noFallback || parseBooleanEnv(env.IMCODES_OPENCODE_NO_FALLBACK);

  if (Array.isArray(opts.agyManifestBaseUrls) && opts.agyManifestBaseUrls.length > 0) {
    return filterCandidatesForIsolation(
      [...new Set(opts.agyManifestBaseUrls.map((u) => normalizeRegistryUrl(u)).filter((v): v is string => Boolean(v)))],
      Boolean(isolatedTest),
    );
  }

  const candidates: Array<string | null> = [
    normalizeRegistryUrl(opts.agyManifestBaseUrl),
    normalizeRegistryUrl(env.IMCODES_AGY_MANIFEST_BASE_URL),
  ];
  if (!isolatedTest && !noFallback) {
    candidates.push(AGY_OFFICIAL_MANIFEST_BASE_URL);
  }
  return filterCandidatesForIsolation(
    [...new Set(candidates.filter((v): v is string => Boolean(v)))],
    Boolean(isolatedTest),
  );
}

function isGzipArchiveFile(filePath: string, urlStr: string): boolean {
  if (/\.tar\.gz(?:[?#]|$)|\.tgz(?:[?#]|$)/i.test(urlStr)) return true;
  try {
    const header = readFileSync(filePath).subarray(0, 2);
    return header.length >= 2 && header[0] === 0x1f && header[1] === 0x8b;
  } catch {
    return false;
  }
}

export async function installAgyCli(opts: InstallSingleCliOptions = {}): Promise<InstallCliResult> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const homeDir = opts.homeDir ?? homedir();
  const pathMod = getPathModule(platform, homeDir);
  const fetchFn = opts.fetchImpl ?? fetch;
  const verifyVer = opts.verifyVersion ?? defaultVerifyVersion;
  const linkFn = opts.linkFile ?? linkSync;
  const metadataTimeoutMs = opts.metadataTimeoutMs ?? DEFAULT_AGY_METADATA_TIMEOUT_MS;
  const downloadTimeoutMs = opts.tarballTimeoutMs ?? DEFAULT_AGY_DOWNLOAD_TIMEOUT_MS;
  const versionTimeoutMs = opts.versionTimeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS;
  const isolatedTest = Boolean(opts.isolatedTest || parseBooleanEnv(env.IMCODES_OPENCODE_ISOLATED_TEST));

  if (isAgentCliOptedOut('IMCODES_SKIP_AGY', { skip: opts.skip, env })) {
    opts.logger?.info?.('skipping Antigravity CLI install (IMCODES_SKIP_AGY / --skip)');
    return { status: 'skipped' };
  }

  let existing: string | null;
  try {
    existing = await isAgyAlreadyInstalled({
      homeDir,
      platform,
      env,
      checkFileExecutable: opts.checkFileExecutable,
    });
  } catch (pathErr) {
    const reason = pathErr instanceof Error ? pathErr.message : String(pathErr);
    opts.logger?.warn?.(`unsafe Antigravity target path: ${reason}`);
    return { status: 'failed', reason };
  }
  if (existing) {
    opts.logger?.info?.(`found existing agy CLI at ${existing} — keeping existing install`);
    return { status: 'existing', path: existing };
  }

  const manifestPlatform = resolveAgyManifestPlatform({ platform, arch, isMusl: opts.isMusl });
  if (!manifestPlatform) {
    opts.logger?.info?.(`Antigravity CLI binary unavailable for ${platform}/${arch}; skipping`);
    return { status: 'unsupported', reason: `unsupported_platform:${platform}/${arch}` };
  }

  const bases = resolveCandidateAgyManifestBases({
    agyManifestBaseUrl: opts.agyManifestBaseUrl,
    agyManifestBaseUrls: opts.agyManifestBaseUrls,
    env,
    noFallback: opts.noFallback,
    isolatedTest,
  });
  if (bases.length === 0) {
    const rejected = isolatedTest
      ? collectConfiguredNonLoopbackUrls([
          ...(opts.agyManifestBaseUrls ?? []),
          opts.agyManifestBaseUrl,
          env.IMCODES_AGY_MANIFEST_BASE_URL,
        ])
      : [];
    return {
      status: 'failed',
      packageName: `agy:${manifestPlatform}`,
      reason: rejected.length > 0 ? `disallowed_non_loopback_isolated_origin:${rejected[0]}` : 'no_valid_manifest_base',
    };
  }

  const binaryName = platform === 'win32' ? 'agy.exe' : 'agy';
  const entryCandidates = platform === 'win32'
    ? ['antigravity.exe', 'agy.exe', 'bin/agy.exe', 'bin/antigravity.exe']
    : ['antigravity', 'agy', 'bin/agy', 'bin/antigravity'];
  const binDir = pathMod.join(homeDir, '.local', 'bin');
  const destPath = pathMod.join(binDir, binaryName);
  const proxy = await createProxyAwareFetch(fetchFn, env, { isolatedTest });

  let lastReason = 'unknown_error';
  try {
    for (const baseUrl of bases) {
      const suffixTag = makeUniqueSuffix();
      const tmpPayload = pathMod.join(binDir, `.tmp-agy-payload-${suffixTag}`);
      const tmpBin = pathMod.join(binDir, `.tmp-agy-${suffixTag}-${binaryName}`);

      try {
        const parsedBase = new URL(baseUrl);
        const baseProto = parsedBase.protocol;
        const strictOrigin = isolatedTest ? parsedBase.origin : undefined;

        const manifestUrl = `${baseUrl}/manifests/${manifestPlatform}.json`;
        const manifestRes = await fetchWithSafeRedirects(proxy.fetchFn, manifestUrl, {
          headers: { accept: 'application/json' },
          signal: buildAbortSignal(metadataTimeoutMs),
          allowedProto: baseProto,
          strictOrigin,
          isolatedTest,
        });
        if (!manifestRes.ok) {
          throw new Error(`manifest_http_${manifestRes.status}`);
        }
        const manifest = await manifestRes.json() as { version?: unknown; url?: unknown; sha512?: unknown };
        const downloadUrl = typeof manifest?.url === 'string' ? manifest.url.trim() : '';
        const sha512 = typeof manifest?.sha512 === 'string' ? manifest.sha512.trim() : '';
        if (!downloadUrl) throw new Error('missing_manifest_download_url');
        if (!sha512) throw new Error('missing_manifest_sha512');
        validateDownloadUrl(downloadUrl, baseProto, strictOrigin, isolatedTest);

        if (platform === process.platform) {
          ensureSafePathWithinHome(homeDir, ['.local', 'bin'], binaryName, platform, true);
        } else {
          mkdirSync(binDir, { recursive: true });
        }

        const payloadRes = await fetchWithSafeRedirects(proxy.fetchFn, downloadUrl, {
          signal: buildAbortSignal(downloadTimeoutMs),
          allowedProto: baseProto,
          strictOrigin,
          isolatedTest,
        });
        if (!payloadRes.ok) {
          throw new Error(`download_http_${payloadRes.status}`);
        }

        await downloadResponseToFileWithIntegrity(payloadRes, tmpPayload, {
          maxBytes: MAX_AGY_DOWNLOAD_BYTES,
          expectedSha512Hex: sha512,
        });

        let stagedPath = tmpPayload;
        if (isGzipArchiveFile(tmpPayload, downloadUrl)) {
          await extractSingleBinaryFromTarGzFile(tmpPayload, entryCandidates, tmpBin, { platform });
          stagedPath = tmpBin;
        }

        if (platform !== 'win32') {
          chmodSync(stagedPath, 0o755);
        }
        clearMacosQuarantineBestEffort(stagedPath, platform);

        const metaVersion = typeof manifest.version === 'string' ? manifest.version.trim() : undefined;
        let detectedVersion: string | undefined;
        try {
          detectedVersion = verifyVer(stagedPath, versionTimeoutMs);
        } catch (verErr) {
          const msg = verErr instanceof Error ? verErr.message : String(verErr);
          opts.logger?.warn?.(`staged Antigravity CLI version probe failed: ${msg}`);
          return {
            status: 'unverified',
            version: metaVersion,
            packageName: `agy:${manifestPlatform}`,
            registry: baseUrl,
            reason: msg,
          };
        }

        let publishedAsExisting = false;
        try {
          linkFn(stagedPath, destPath);
        } catch (linkErr: unknown) {
          const code = (linkErr as NodeJS.ErrnoException | undefined)?.code;
          if (code === 'EEXIST') {
            publishedAsExisting = true;
          } else {
            throw linkErr;
          }
        }

        if (publishedAsExisting) {
          opts.logger?.info?.(`found concurrent agy CLI at ${destPath} — keeping existing install`);
          return {
            status: 'existing',
            path: destPath,
            version: detectedVersion || metaVersion,
            packageName: `agy:${manifestPlatform}`,
            registry: baseUrl,
          };
        }

        ensureExecutablePermission(destPath, platform);
        const finalVersion = detectedVersion || metaVersion;
        opts.logger?.info?.(`installed agy CLI${finalVersion ? ` (${finalVersion})` : ''} at ${destPath}`);
        return {
          status: 'installed',
          path: destPath,
          version: finalVersion,
          packageName: `agy:${manifestPlatform}`,
          registry: baseUrl,
        };
      } catch (err) {
        lastReason = err instanceof Error ? err.message : String(err);
        opts.logger?.warn?.(`agy install attempt from ${baseUrl} failed (${lastReason})`);
      } finally {
        rmSync(tmpPayload, { force: true });
        rmSync(tmpBin, { force: true });
      }
    }
  } finally {
    await proxy.close();
  }

  return {
    status: 'failed',
    packageName: `agy:${manifestPlatform}`,
    reason: lastReason,
  };
}

export async function installDefaultAgentClis(
  opts: InstallDefaultAgentClisOptions = {},
): Promise<InstallDefaultAgentClisResult> {
  const allIds: DefaultAgentCliId[] = ['opencode', 'codex', 'claude', 'agy'];
  const selected = opts.only && opts.only.length > 0
    ? allIds.filter((id) => opts.only!.includes(id))
    : allIds;

  const env = opts.env ?? process.env;
  const globalSkip = Boolean(opts.skip || parseBooleanEnv(env.IMCODES_SKIP_AGENT_CLIS));

  const runOne = async (id: DefaultAgentCliId): Promise<[DefaultAgentCliId, InstallCliResult]> => {
    try {
      switch (id) {
        case 'opencode': {
          const res = await installOpenCodeCli({
            ...opts,
            skip: Boolean(globalSkip || opts.skipOpenCode),
          });
          return [id, res];
        }
        case 'codex': {
          const res = await installCodexCli({
            ...opts,
            skip: Boolean(globalSkip || opts.skipCodex),
          });
          return [id, res];
        }
        case 'claude': {
          const res = await installClaudeCli({
            ...opts,
            skip: Boolean(globalSkip || opts.skipClaude),
          });
          return [id, res];
        }
        case 'agy': {
          const res = await installAgyCli({
            ...opts,
            skip: Boolean(globalSkip || opts.skipAgy),
          });
          return [id, res];
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      opts.logger?.warn?.(`${id} install unexpected failure: ${reason}`);
      return [id, { status: 'failed', reason }];
    }
  };

  const pairs = await Promise.all(selected.map((id) => runOne(id)));
  return {
    results: Object.fromEntries(pairs) as Partial<Record<DefaultAgentCliId, InstallCliResult>>,
  };
}

const VALID_CLI_IDS = new Set<DefaultAgentCliId>(['opencode', 'codex', 'claude', 'agy']);

function parseCliArgs(argv: string[]): {
  homeDir?: string;
  registry?: string;
  agyManifestBaseUrl?: string;
  only?: DefaultAgentCliId[];
  skip: boolean;
  skipOpenCode: boolean;
  skipCodex: boolean;
  skipClaude: boolean;
  skipAgy: boolean;
  noFallback: boolean;
  isolatedTest: boolean;
  strict: boolean;
  quiet: boolean;
  timeoutMs?: number;
} {
  const out: ReturnType<typeof parseCliArgs> = {
    skip: false,
    skipOpenCode: false,
    skipCodex: false,
    skipClaude: false,
    skipAgy: false,
    noFallback: false,
    isolatedTest: false,
    strict: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--home' && i + 1 < argv.length) {
      out.homeDir = argv[++i];
    } else if (arg === '--registry' && i + 1 < argv.length) {
      out.registry = argv[++i];
    } else if (arg === '--agy-manifest-base-url' && i + 1 < argv.length) {
      out.agyManifestBaseUrl = argv[++i];
    } else if (arg === '--only' && i + 1 < argv.length) {
      const items = argv[++i]
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s): s is DefaultAgentCliId => VALID_CLI_IDS.has(s as DefaultAgentCliId));
      if (items.length > 0) out.only = items;
    } else if (arg === '--timeout-ms' && i + 1 < argv.length) {
      const parsed = Number.parseInt(argv[++i], 10);
      if (Number.isFinite(parsed) && parsed > 0) out.timeoutMs = parsed;
    } else if (arg === '--skip') {
      out.skip = true;
    } else if (arg === '--skip-opencode') {
      out.skipOpenCode = true;
    } else if (arg === '--skip-codex') {
      out.skipCodex = true;
    } else if (arg === '--skip-claude') {
      out.skipClaude = true;
    } else if (arg === '--skip-agy') {
      out.skipAgy = true;
    } else if (arg === '--no-fallback') {
      out.noFallback = true;
    } else if (arg === '--isolated-test') {
      out.isolatedTest = true;
      out.noFallback = true;
    } else if (arg === '--strict') {
      out.strict = true;
    } else if (arg === '--quiet') {
      out.quiet = true;
    }
  }
  return out;
}

export async function runInstallDefaultAgentClis(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseCliArgs(argv);
  const logger: CliInstallLogger = args.quiet
    ? {}
    : {
        info: (msg: string) => console.log(`[agent-clis] ${msg}`),
        warn: (msg: string) => console.error(`[agent-clis] WARNING: ${msg}`),
      };
  try {
    const { results } = await installDefaultAgentClis({
      ...(args.homeDir ? { homeDir: args.homeDir } : {}),
      ...(args.registry ? { registry: args.registry } : {}),
      ...(args.agyManifestBaseUrl ? { agyManifestBaseUrl: args.agyManifestBaseUrl } : {}),
      ...(args.only ? { only: args.only } : {}),
      ...(args.skip ? { skip: true } : {}),
      ...(args.skipOpenCode ? { skipOpenCode: true } : {}),
      ...(args.skipCodex ? { skipCodex: true } : {}),
      ...(args.skipClaude ? { skipClaude: true } : {}),
      ...(args.skipAgy ? { skipAgy: true } : {}),
      ...(args.noFallback ? { noFallback: true } : {}),
      ...(args.isolatedTest ? { isolatedTest: true } : {}),
      ...(args.timeoutMs ? { metadataTimeoutMs: args.timeoutMs, tarballTimeoutMs: args.timeoutMs } : {}),
      logger,
    });
    const summaryParts = Object.entries(results).map(([id, res]) => {
      if (!res) return `${id}:none`;
      return res.path ? `${id}:${res.status}(${res.path})` : `${id}:${res.status}${res.reason ? `(${res.reason})` : ''}`;
    });
    logger.info?.(summaryParts.join(' | '));
    const hasFailure = Object.values(results).some((r) => r && (r.status === 'failed' || r.status === 'unverified'));
    return hasFailure && args.strict ? 1 : 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!args.quiet) console.error(`[agent-clis] WARNING: ${msg}`);
    return args.strict ? 1 : 0;
  }
}

function isMainModule(): boolean {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const code = await runInstallDefaultAgentClis(process.argv.slice(2));
  process.exitCode = code;
}
