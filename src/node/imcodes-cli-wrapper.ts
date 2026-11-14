import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  renderPosixImcodesCliWrapper,
  renderWindowsImcodesCliWrapper,
  resolveImcodesCliTarget,
  type DesktopInstallerPlatform,
  type ResolvedImcodesCliTarget,
} from '../../shared/desktop-installer-compatibility.js';
import { assertSafeNodeIsolatedTargetPath, isPathInsideGitCheckout } from './desktop-installer-probe.js';

export interface InstallImcodesCliWrapperOptions {
  platform: DesktopInstallerPlatform;
  wrapperPath: string;
  runtimeRoot?: string;
  relativeRuntimeSubpath?: string;
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
  const content =
    options.platform === 'win32'
      ? renderWindowsImcodesCliWrapper({
          runtimeRoot: options.runtimeRoot,
          relativeRuntimeSubpath: options.relativeRuntimeSubpath,
        })
      : renderPosixImcodesCliWrapper({
          platform: options.platform,
          runtimeRoot: options.runtimeRoot,
          relativeRuntimeSubpath: options.relativeRuntimeSubpath,
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

/**
 * Inspect local filesystem paths to determine which `imcodes` runtime target would execute.
 */
export function inspectImcodesCliResolution(options: {
  platform: DesktopInstallerPlatform;
  runtimeRoot: string;
  wrapperPath?: string;
  devEntryOverride?: string;
  npmFallbackEntry?: string;
  npmFallbackExecutable?: string;
}): ResolvedImcodesCliTarget | null {
  const nodeRel = options.platform === 'win32' ? 'node.exe' : join('bin', 'node');
  const currentDir = join(options.runtimeRoot, 'current');
  const currentNode = join(currentDir, nodeRel);
  const currentEntry = join(currentDir, 'package', 'dist', 'src', 'index.js');
  const directNode = join(options.runtimeRoot, nodeRel);
  const directEntry = join(options.runtimeRoot, 'package', 'dist', 'src', 'index.js');

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
    bundledCurrent: {
      exists: existsSync(currentNode) && existsSync(currentEntry),
      nodePath: currentNode,
      entryPath: currentEntry,
    },
    bundledDirect: {
      exists: existsSync(directNode) && existsSync(directEntry),
      nodePath: directNode,
      entryPath: directEntry,
    },
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
