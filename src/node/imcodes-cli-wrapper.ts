import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  renderPosixImcodesCliWrapper,
  renderWindowsImcodesCliWrapper,
  resolveImcodesCliTarget,
  type DesktopInstallerPlatform,
  type ResolvedImcodesCliTarget,
} from '../../shared/desktop-installer-compatibility.js';
import { compareImcodesVersions, parseImcodesVersion } from '../../shared/imcodes-version.js';
import { IMCODES_STATE_DIR_NAME } from '../util/imcodes-state-dir.js';
import { assertSafeNodeIsolatedTargetPath, isPathInsideGitCheckout } from './desktop-installer-probe.js';

export interface InstallImcodesCliWrapperOptions {
  platform: DesktopInstallerPlatform;
  wrapperPath: string;
  runtimeRoot?: string;
  relativeRuntimeSubpath?: string;
  userStateDirName?: string;
  forceTakeover?: boolean;
  allowSystemRoot?: boolean;
  isolatedRoot?: string;
  realHomeDir?: string;
}

export interface InstallImcodesCliWrapperResult {
  status: 'installed' | 'preserved_dev_symlink';
  wrapperPath: string;
  resolvedTarget?: string;
}

/**
 * Install the thin `imcodes` CLI forwarder while honoring Scenario 3 (developer symlink exemption).
 * Uses atomic same-directory temp write + rename so any pre-existing non-dev symlink is replaced
 * cleanly without overwriting or corrupting the symlink target in place.
 */
export function installImcodesCliWrapper(
  options: InstallImcodesCliWrapperOptions,
): InstallImcodesCliWrapperResult {
  if (options.isolatedRoot && options.allowSystemRoot) {
    throw new Error('unsafe_allow_system_root_with_isolated_root');
  }
  const wrapperPath = resolve(options.wrapperPath);
  if (!options.allowSystemRoot || options.isolatedRoot) {
    assertSafeNodeIsolatedTargetPath(wrapperPath, options.platform, options.realHomeDir, options.isolatedRoot, 'entry');
  }

  let existingLstat = null;
  try {
    existingLstat = lstatSync(wrapperPath);
  } catch {
    existingLstat = null;
  }

  if (existingLstat && !options.forceTakeover) {
    let real = wrapperPath;
    try {
      real = realpathSync(wrapperPath);
    } catch {
      real = wrapperPath;
    }
    if (isPathInsideGitCheckout(real)) {
      return { status: 'preserved_dev_symlink', wrapperPath, resolvedTarget: real };
    }
    if (existingLstat.isFile()) {
      try {
        const text = readFileSync(wrapperPath, 'utf8');
        const refMatch = text.match(/([/\\][^\s"']+dist[/\\]src[/\\]index\.js)/u);
        if (refMatch && isPathInsideGitCheckout(refMatch[1])) {
          return { status: 'preserved_dev_symlink', wrapperPath, resolvedTarget: refMatch[1] };
        }
      } catch {
        // ignore binary
      }
    }
  }

  mkdirSync(dirname(wrapperPath), { recursive: true });
  const userStateDirName = options.userStateDirName ?? IMCODES_STATE_DIR_NAME;
  const content =
    options.platform === 'win32'
      ? renderWindowsImcodesCliWrapper({
          runtimeRoot: options.runtimeRoot,
          relativeRuntimeSubpath: options.relativeRuntimeSubpath,
          userStateDirName,
        })
      : renderPosixImcodesCliWrapper({
          platform: options.platform,
          runtimeRoot: options.runtimeRoot,
          relativeRuntimeSubpath: options.relativeRuntimeSubpath,
          userStateDirName,
        });
  const tmpWrapperPath = join(
    dirname(wrapperPath),
    `.${basename(wrapperPath)}.tmp.${process.pid}.${Date.now()}`,
  );
  try {
    writeFileSync(tmpWrapperPath, content, 'utf8');
    if (options.platform !== 'win32') {
      chmodSync(tmpWrapperPath, 0o755);
    }
    renameSync(tmpWrapperPath, wrapperPath);
  } catch (err) {
    rmSync(tmpWrapperPath, { force: true });
    throw err;
  }
  return { status: 'installed', wrapperPath };
}

function readBundledLayoutVersion(layoutDir: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(layoutDir, 'package', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Inspect local filesystem paths to determine which `imcodes` runtime target would execute.
 * When `userRuntimeRoot` is provided, compares user-level and system `daemon-runtime` candidates
 * and prefers the strictly higher valid version (`userRuntimeRoot` wins ties).
 */
export function inspectImcodesCliResolution(options: {
  platform: DesktopInstallerPlatform;
  runtimeRoot: string;
  userRuntimeRoot?: string;
  wrapperPath?: string;
  devEntryOverride?: string;
  npmFallbackEntry?: string;
  npmFallbackExecutable?: string;
}): ResolvedImcodesCliTarget | null {
  const nodeRel = options.platform === 'win32' ? 'node.exe' : join('bin', 'node');
  const roots = options.userRuntimeRoot ? [options.userRuntimeRoot, options.runtimeRoot] : [options.runtimeRoot];
  const candidates: Array<{
    kind: 'current' | 'direct';
    nodePath: string;
    entryPath: string;
    version?: string;
  }> = [];

  for (const root of roots) {
    const currentDir = join(root, 'current');
    const currentNode = join(currentDir, nodeRel);
    const currentEntry = join(currentDir, 'package', 'dist', 'src', 'index.js');
    if (existsSync(currentNode) && existsSync(currentEntry)) {
      candidates.push({
        kind: 'current',
        nodePath: currentNode,
        entryPath: currentEntry,
        version: readBundledLayoutVersion(currentDir),
      });
      continue;
    }
    const directNode = join(root, nodeRel);
    const directEntry = join(root, 'package', 'dist', 'src', 'index.js');
    if (existsSync(directNode) && existsSync(directEntry)) {
      candidates.push({
        kind: 'direct',
        nodePath: directNode,
        entryPath: directEntry,
        version: readBundledLayoutVersion(root),
      });
    }
  }

  let bestBundled: (typeof candidates)[number] | undefined;
  for (const cand of candidates) {
    if (!bestBundled) {
      bestBundled = cand;
      continue;
    }
    if (cand.version && parseImcodesVersion(cand.version)) {
      if (!bestBundled.version || !parseImcodesVersion(bestBundled.version)) {
        bestBundled = cand;
      } else {
        const cmp = compareImcodesVersions(cand.version, bestBundled.version);
        if (cmp !== null && cmp > 0) bestBundled = cand;
      }
    }
  }

  let selfIsDevSymlink = false;
  let selfRealEntryPath: string | undefined;
  if (options.wrapperPath && existsSync(options.wrapperPath)) {
    try {
      const real = realpathSync(options.wrapperPath);
      if (isPathInsideGitCheckout(real)) {
        selfIsDevSymlink = true;
        selfRealEntryPath = real;
      }
    } catch {
      // ignore
    }
  }

  const npmExec = options.npmFallbackExecutable ?? (options.platform === 'win32' ? 'node.exe' : 'node');
  const isSelfPath = Boolean(
    options.wrapperPath &&
      options.npmFallbackExecutable &&
      resolve(options.wrapperPath) === resolve(options.npmFallbackExecutable),
  );

  return resolveImcodesCliTarget({
    platform: options.platform,
    devEntryPath: options.devEntryOverride,
    devOverrideExists: Boolean(options.devEntryOverride && existsSync(options.devEntryOverride)),
    selfIsDevSymlink,
    selfRealEntryPath,
    bundledCurrent:
      bestBundled?.kind === 'current'
        ? {
            exists: true,
            nodePath: bestBundled.nodePath,
            entryPath: bestBundled.entryPath,
          }
        : undefined,
    bundledDirect:
      bestBundled?.kind === 'direct'
        ? {
            exists: true,
            nodePath: bestBundled.nodePath,
            entryPath: bestBundled.entryPath,
          }
        : undefined,
    npmFallback: {
      exists: Boolean(
        (options.npmFallbackEntry && existsSync(options.npmFallbackEntry)) ||
          (options.npmFallbackExecutable && existsSync(options.npmFallbackExecutable)),
      ),
      entryPath: options.npmFallbackEntry,
      executablePath: npmExec,
      isSelfPath,
    },
  });
}
