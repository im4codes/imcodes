/**
 * Daemon start on macOS: (1) make sure the launch agent starts node itself, (2) probe Full Disk Access and record the answer.
 *
 * (1) matters for the first start after an upgrade from an older daemon: the upgrade script of THAT daemon wrote the old script launch
 * target back. Fixing it here means the first start of the new daemon heals it, once, without the user doing anything. The plist is
 * rewritten and launchd is asked to read it again (a detached helper, because that ends this process); a marker file stops it from
 * ever repeating more often than every few minutes if something keeps undoing the rewrite.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import logger from '../util/logger.js';
import { resolvePosixDaemonServicePaths } from '../util/posix-daemon-service.js';
import { ensureMacosLaunchAgentTarget, restartMacosLaunchAgentDetached, MACOS_LAUNCH_ENSURE_REASON } from '../util/macos-launch-agent.js';
import { recordMacosFdaStatus } from '../util/macos-full-disk-access.js';
import { MACOS_LAUNCH_MIGRATION_MODE } from '../../shared/macos-daemon-launch.js';
import { MACOS_FDA_PANE_STATE, MACOS_FDA_STATE } from '../../shared/macos-full-disk-access.js';

const MIGRATION_MARKER_FILE = 'launch-target-migration.json';
/** A rewrite that is undone is not tried again sooner than this. */
export const MACOS_LAUNCH_MIGRATION_MIN_SPACING_MS = 15 * 60 * 1000;

export interface MacosLaunchHealthDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  restart?: (plistPath: string) => void;
  record?: typeof recordMacosFdaStatus;
}

function readMarkerAt(path: string): number | undefined {
  try {
    const value = (JSON.parse(readFileSync(path, 'utf8')) as { atMs?: unknown }).atMs;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function runMacosLaunchHealth(deps: MacosLaunchHealthDeps = {}): Promise<{ migrated: boolean }> {
  if ((deps.platform ?? process.platform) !== 'darwin') return { migrated: false };
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const service = resolvePosixDaemonServicePaths(env);

  // Only the job that is running THIS daemon is looked at: a daemon started by hand, or a scoped test home, owns no launch agent.
  if (!service.scoped && env.XPC_SERVICE_NAME === service.launchAgentLabel) {
    const markerPath = join(service.stateHome, MIGRATION_MARKER_FILE);
    const last = readMarkerAt(markerPath);
    if (last === undefined || now() - last >= MACOS_LAUNCH_MIGRATION_MIN_SPACING_MS) {
      const result = ensureMacosLaunchAgentTarget({ plistPath: service.launchAgentPath, mode: MACOS_LAUNCH_MIGRATION_MODE.STARTUP });
      if (result.changed) {
        try {
          mkdirSync(service.stateHome, { recursive: true });
          writeFileSync(markerPath, `${JSON.stringify({ atMs: now(), from: result.from, to: result.to })}\n`, { mode: 0o600 });
        } catch { /* the marker is only a brake */ }
        logger.info({ reason: result.reason, from: result.from, to: result.to }, 'launch agent now starts node directly (Full Disk Access applies to it); restarting once to use it');
        (deps.restart ?? restartMacosLaunchAgentDetached)(service.launchAgentPath);
        return { migrated: true };
      }
      if (result.reason === MACOS_LAUNCH_ENSURE_REASON.WRITE_FAILED) {
        logger.warn({ reason: result.reason, plist: service.launchAgentPath }, 'launch agent could not be rewritten to start node directly');
      }
    }
  }

  const record = await (deps.record ?? recordMacosFdaStatus)(service.stateHome, now);
  if (record?.daemon === MACOS_FDA_STATE.DENIED) {
    logger.warn({ nodePath: record.nodePath }, 'Full Disk Access is not granted to this daemon (agent sessions cannot read Desktop, Documents, Downloads, /Volumes); run "imcodes doctor"');
  } else if (record?.daemon === MACOS_FDA_STATE.GRANTED && record.pane === MACOS_FDA_PANE_STATE.DENIED) {
    logger.warn({ nodePath: record.nodePath }, 'Full Disk Access is granted, but the running tmux server predates it, so agent shells are still denied; run "imcodes doctor"');
  }
  return { migrated: false };
}
