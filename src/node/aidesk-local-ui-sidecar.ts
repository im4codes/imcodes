/**
 * Keeps the Windows panel window host (aidesk-local-ui.exe, a WebView2 window) installed and current on a controlled node.
 *
 * It is an INDEPENDENT sidecar, like the remote-desktop worker refresh: it never touches the transactional self-upgrade (so an older
 * upgrade script that knows nothing of this directory is unaffected, and a node rolled back by that script simply ignores the
 * directory), and nothing here can fail the node: every outcome is a reason code in the log, failures back off (never a restart loop),
 * and a bad download never replaces a working install.
 *
 *   <execDir>/aidesk-local-ui/win32-x64/{aidesk-local-ui.exe, aidesk-local-ui.manifest.json, THIRD-PARTY-NOTICES.txt}
 *
 * A candidate is downloaded into a staging directory next to the final one, verified with the very rules the node applies before it
 * ever launches the host (manifest size + sha256 + the release Authenticode signer: resolveVerifiedAideskLocalUi), locked down so only
 * SYSTEM and Administrators can write it (ordinary users may read and run it, which the user-session launch needs, but cannot swap the
 * verified file), and only then swapped in by rename, keeping the previous directory until the next successful refresh.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  AIDESK_LOCAL_UI_MANIFEST_FILENAME,
  AIDESK_LOCAL_UI_MANIFEST_MAX_BYTES,
  AIDESK_LOCAL_UI_MAX_BYTES,
  AIDESK_LOCAL_UI_NOTICES_FILENAME,
  AIDESK_LOCAL_UI_NOTICES_MAX_BYTES,
  AIDESK_LOCAL_UI_SIDECAR_TARGET,
  aideskLocalUiArtifactRelativeDirectory,
  aideskLocalUiExecutableFileName,
  validateAideskLocalUiManifest,
  type AideskLocalUiManifest,
} from '../../shared/aidesk-local-ui-artifact.js';
import { CONTROLLED_NODE_ARTIFACT_ASSETS } from '../../shared/controlled-node-artifacts.js';
import { compareImcodesVersions } from '../../shared/imcodes-version.js';
import logger from '../util/logger.js';
import { resolveVerifiedAideskLocalUi, resolveVerifiedAideskLocalUiDetailed, type VerifiedAideskLocalUi } from './aidesk-local-ui-artifact.js';
import { windowsComputerUseHelperAclCommands } from './installer.js';
import { downloadControlledNodeAideskLocalUiFile, type ArtifactDownloadCredential } from './self-upgrade.js';

const execFileAsync = promisify(execFile);

/** Every way a refresh can end; the log line of each run carries exactly one. */
export const AIDESK_LOCAL_UI_REFRESH_REASON = Object.freeze({
  UPDATED: 'updated',
  CURRENT: 'current',
  UNSUPPORTED_PLATFORM: 'unsupported_platform',
  NOT_PUBLISHED: 'not_published',
  MANIFEST_INVALID: 'manifest_invalid',
  DOWNGRADE_REJECTED: 'downgrade_rejected',
  VERIFICATION_FAILED: 'verification_failed',
  ACL_FAILED: 'acl_failed',
  HOST_IN_USE: 'host_in_use',
  DOWNLOAD_FAILED: 'download_failed',
} as const);
export type AideskLocalUiRefreshReason = typeof AIDESK_LOCAL_UI_REFRESH_REASON[keyof typeof AIDESK_LOCAL_UI_REFRESH_REASON];

export interface AideskLocalUiRefreshResult {
  updated: boolean;
  reason: AideskLocalUiRefreshReason;
  installedVersion?: string;
  targetVersion?: string;
}

export interface AideskLocalUiRefreshDeps {
  credential: ArtifactDownloadCredential;
  platform?: NodeJS.Platform;
  arch?: string;
  /** The controlled-node executable's directory (default: this process's). */
  root?: string;
  fetchImpl?: typeof fetch;
  download?: typeof downloadControlledNodeAideskLocalUiFile;
  /** The verified executable in `<directory>/aidesk-local-ui/win32-x64` (default: the very rules the node applies before launching it). */
  verify?: (directory: string) => Promise<string | undefined>;
  /** Locks `directory` down to SYSTEM/Administrators write, authenticated users read+execute. */
  lockDown?: (directory: string) => Promise<void>;
  rename?: typeof rename;
}

async function readManifest(directory: string): Promise<AideskLocalUiManifest | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(directory, AIDESK_LOCAL_UI_MANIFEST_FILENAME), 'utf8')) as unknown;
    return validateAideskLocalUiManifest(raw, AIDESK_LOCAL_UI_SIDECAR_TARGET) ?? undefined;
  } catch {
    return undefined;
  }
}

async function icaclsAsync(directory: string): Promise<void> {
  // The same ACL the computer-use helper root gets; the commands are applied one by one without blocking the event loop.
  for (const args of windowsComputerUseHelperAclCommands(directory)) await execFileAsync('icacls', [...args], { windowsHide: true });
}

export async function refreshAideskLocalUiSidecar(deps: AideskLocalUiRefreshDeps): Promise<AideskLocalUiRefreshResult> {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const target = AIDESK_LOCAL_UI_SIDECAR_TARGET;
  if (platform !== target.os || arch !== target.arch) return { updated: false, reason: AIDESK_LOCAL_UI_REFRESH_REASON.UNSUPPORTED_PLATFORM };
  const root = deps.root ?? dirname(process.execPath);
  const relative = aideskLocalUiArtifactRelativeDirectory(target.os, target.arch); // aidesk-local-ui/win32-x64
  const finalDirectory = join(root, ...relative.split('/'));
  const parentDirectory = dirname(finalDirectory);
  const download = deps.download ?? downloadControlledNodeAideskLocalUiFile;
  const verify = deps.verify ?? ((directory: string) => resolveVerifiedAideskLocalUi({ execPath: join(directory, 'imcodes-node.exe'), platform: target.os, arch: target.arch }));
  const lockDown = deps.lockDown ?? icaclsAsync;
  const renameImpl = deps.rename ?? rename;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const installed = await readManifest(finalDirectory);
  let stagingRoot: string | undefined;
  try {
    await mkdir(root, { recursive: true });
    stagingRoot = await mkdtemp(join(root, '.aidesk-local-ui-refresh-'));
    const stagedDirectory = join(stagingRoot, ...relative.split('/'));
    await mkdir(stagedDirectory, { recursive: true });
    const common = { credential: deps.credential, dir: stagedDirectory, fetchImpl };

    // 1. The small manifest first: nothing else is fetched when the installed copy is already that version.
    const manifestDownload = await download({
      ...common,
      asset: CONTROLLED_NODE_ARTIFACT_ASSETS.AIDESK_LOCAL_UI_MANIFEST,
      expectedFileName: AIDESK_LOCAL_UI_MANIFEST_FILENAME,
      maxBytes: AIDESK_LOCAL_UI_MANIFEST_MAX_BYTES,
    });
    if (!manifestDownload) return { updated: false, reason: AIDESK_LOCAL_UI_REFRESH_REASON.NOT_PUBLISHED, ...(installed ? { installedVersion: installed.version } : {}) };
    const wanted = await readManifest(stagedDirectory);
    if (!wanted) return { updated: false, reason: AIDESK_LOCAL_UI_REFRESH_REASON.MANIFEST_INVALID };
    const base = { ...(installed ? { installedVersion: installed.version } : {}), targetVersion: wanted.version };

    if (installed) {
      if (installed.sha256 === wanted.sha256) {
        // Same build recorded: current, unless the installed file no longer verifies (damaged, removed, tampered) -- then it is repaired.
        if (await verify(root).catch(() => undefined)) return { updated: false, reason: AIDESK_LOCAL_UI_REFRESH_REASON.CURRENT, ...base };
      } else if ((compareImcodesVersions(installed.version, wanted.version) ?? 0) > 0) {
        return { updated: false, reason: AIDESK_LOCAL_UI_REFRESH_REASON.DOWNGRADE_REJECTED, ...base };
      }
    }

    // 2. The executable and the notices, into staging only.
    const exe = await download({
      ...common,
      asset: CONTROLLED_NODE_ARTIFACT_ASSETS.AIDESK_LOCAL_UI,
      expectedFileName: aideskLocalUiExecutableFileName(target.os),
      maxBytes: Math.min(AIDESK_LOCAL_UI_MAX_BYTES, wanted.size),
    });
    if (!exe) return { updated: false, reason: AIDESK_LOCAL_UI_REFRESH_REASON.NOT_PUBLISHED, ...base };
    const notices = await download({
      ...common,
      asset: CONTROLLED_NODE_ARTIFACT_ASSETS.AIDESK_LOCAL_UI_NOTICES,
      expectedFileName: AIDESK_LOCAL_UI_NOTICES_FILENAME,
      maxBytes: AIDESK_LOCAL_UI_NOTICES_MAX_BYTES,
    });
    if (!notices) return { updated: false, reason: AIDESK_LOCAL_UI_REFRESH_REASON.NOT_PUBLISHED, ...base };

    // 3. Verified exactly as it will be before every launch (size, sha256, release signer); a failure here installs nothing.
    if (!await verify(stagingRoot).catch(() => undefined)) {
      return { updated: false, reason: AIDESK_LOCAL_UI_REFRESH_REASON.VERIFICATION_FAILED, ...base };
    }

    // 4. Not writable by ordinary users, so the verified file cannot be swapped for another one afterwards.
    try {
      await lockDown(join(stagingRoot, relative.split('/')[0]!));
      await lockDown(stagedDirectory);
    } catch (error) {
      logger.warn({ err: error }, 'aidesk-local-ui sidecar: could not lock the staged directory down');
      return { updated: false, reason: AIDESK_LOCAL_UI_REFRESH_REASON.ACL_FAILED, ...base };
    }

    // 5. Swap. The previous directory is kept (the next successful refresh removes it) and put back if the swap fails midway.
    await mkdir(parentDirectory, { recursive: true });
    await lockDown(parentDirectory).catch(() => undefined);
    const backup = `${finalDirectory}.previous`;
    await rm(backup, { recursive: true, force: true });
    let movedAside = false;
    try {
      if (installed || await readManifest(finalDirectory)) {
        await renameImpl(finalDirectory, backup);
        movedAside = true;
      }
      await renameImpl(stagedDirectory, finalDirectory);
    } catch (error) {
      if (movedAside) await renameImpl(backup, finalDirectory).catch(() => undefined);
      // A running host keeps its own directory locked on Windows: the swap is simply tried again later.
      logger.info({ err: error }, 'aidesk-local-ui sidecar: could not swap the directory (host in use?)');
      return { updated: false, reason: AIDESK_LOCAL_UI_REFRESH_REASON.HOST_IN_USE, ...base };
    }
    return { updated: true, reason: AIDESK_LOCAL_UI_REFRESH_REASON.UPDATED, ...base };
  } catch (error) {
    logger.warn({ err: error }, 'aidesk-local-ui sidecar refresh failed');
    return { updated: false, reason: AIDESK_LOCAL_UI_REFRESH_REASON.DOWNLOAD_FAILED, ...(installed ? { installedVersion: installed.version } : {}) };
  } finally {
    if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Reasons after which trying again soon is pointless or harmful: the normal cadence applies. */
const SETTLED: ReadonlySet<AideskLocalUiRefreshReason> = new Set([
  AIDESK_LOCAL_UI_REFRESH_REASON.UPDATED,
  AIDESK_LOCAL_UI_REFRESH_REASON.CURRENT,
  AIDESK_LOCAL_UI_REFRESH_REASON.UNSUPPORTED_PLATFORM,
  AIDESK_LOCAL_UI_REFRESH_REASON.NOT_PUBLISHED,
  AIDESK_LOCAL_UI_REFRESH_REASON.DOWNGRADE_REJECTED,
]);

export const AIDESK_LOCAL_UI_REFRESH_SCHEDULE = Object.freeze({
  /** After the node started: never in the way of startup. */
  initialDelayMs: 90_000,
  /** The first check is moved by up to this much either way, so a fleet restarted together does not ask the server at the same moment. */
  initialJitterMs: 30_000,
  /** A settled outcome (updated, current, nothing published) is re-checked this often. */
  settledIntervalMs: 6 * 60 * 60 * 1000,
  /** A failure retries after this and doubles each time, up to the settled interval: no tight loops, no restarts. */
  failureBaseMs: 15 * 60 * 1000,
});

/** The delay before the next refresh after `reason`; `failures` is how many failures came in a row (0 after a settled outcome). */
export function nextAideskLocalUiRefreshDelayMs(reason: AideskLocalUiRefreshReason, failures: number): number {
  if (SETTLED.has(reason)) return AIDESK_LOCAL_UI_REFRESH_SCHEDULE.settledIntervalMs;
  const delay = AIDESK_LOCAL_UI_REFRESH_SCHEDULE.failureBaseMs * (2 ** Math.max(0, failures - 1));
  return Math.min(AIDESK_LOCAL_UI_REFRESH_SCHEDULE.settledIntervalMs, delay);
}

/** Starts the periodic refresh (Windows x64 only; elsewhere it does nothing). Returns the function that stops it. */
export function startAideskLocalUiSidecarRefresh(
  deps: AideskLocalUiRefreshDeps,
  options: { refresh?: typeof refreshAideskLocalUiSidecar; schedule?: (callback: () => void, ms: number) => { unref?: () => void }; clear?: (handle: unknown) => void; random?: () => number } = {},
): () => void {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  if (platform !== AIDESK_LOCAL_UI_SIDECAR_TARGET.os || arch !== AIDESK_LOCAL_UI_SIDECAR_TARGET.arch) return () => undefined;
  const refresh = options.refresh ?? refreshAideskLocalUiSidecar;
  const schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms));
  const clear = options.clear ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  let stopped = false;
  let failures = 0;
  let handle: { unref?: () => void } | undefined;
  const arm = (ms: number): void => {
    if (stopped) return;
    handle = schedule(() => { void run(); }, ms);
    handle.unref?.();
  };
  const run = async (): Promise<void> => {
    if (stopped) return;
    let reason: AideskLocalUiRefreshReason;
    try {
      const result = await refresh(deps);
      reason = result.reason;
      logger.info({ reason: result.reason, installedVersion: result.installedVersion, targetVersion: result.targetVersion }, 'aidesk-local-ui sidecar refresh');
    } catch (error) {
      reason = AIDESK_LOCAL_UI_REFRESH_REASON.DOWNLOAD_FAILED;
      logger.warn({ err: error }, 'aidesk-local-ui sidecar refresh threw');
    }
    failures = SETTLED.has(reason) ? 0 : failures + 1;
    arm(nextAideskLocalUiRefreshDelayMs(reason, failures));
  };
  const random = options.random ?? Math.random;
  arm(AIDESK_LOCAL_UI_REFRESH_SCHEDULE.initialDelayMs + Math.round((random() * 2 - 1) * AIDESK_LOCAL_UI_REFRESH_SCHEDULE.initialJitterMs));
  return () => { stopped = true; if (handle) clear(handle); };
}

/** How long after the node started the installed host is verified in the background (long enough not to compete with startup). */
export const AIDESK_LOCAL_UI_WARM_DELAY_MS = 20_000;

/**
 * Verifies the installed host once, in the background, so the first click after a node start (or after an update that did not come
 * through the refresh above) finds the proof of that verification instead of paying for it: hashing the executable and validating
 * its Authenticode chain take seconds on a slow or offline PC. Windows x64 only; nothing here can fail the node. Returns the stop function.
 */
export function warmAideskLocalUiVerification(
  options: {
    platform?: NodeJS.Platform;
    arch?: string;
    delayMs?: number;
    resolve?: () => Promise<VerifiedAideskLocalUi | undefined>;
    schedule?: (callback: () => void, ms: number) => { unref?: () => void };
    clear?: (handle: unknown) => void;
  } = {},
): () => void {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== AIDESK_LOCAL_UI_SIDECAR_TARGET.os || arch !== AIDESK_LOCAL_UI_SIDECAR_TARGET.arch) return () => undefined;
  const resolve = options.resolve ?? (() => resolveVerifiedAideskLocalUiDetailed());
  const schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms));
  const clear = options.clear ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const handle = schedule(() => {
    void resolve()
      .then((host) => logger.info({ verified: host !== undefined, source: host?.source }, 'aidesk-local-ui verification warmed'))
      .catch((error) => logger.warn({ err: error }, 'aidesk-local-ui verification warm-up failed'));
  }, options.delayMs ?? AIDESK_LOCAL_UI_WARM_DELAY_MS);
  handle.unref?.();
  return () => clear(handle);
}
