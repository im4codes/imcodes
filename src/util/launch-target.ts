/**
 * Resolves the launch chain (program + args) that systemd ExecStart /
 * launchctl ProgramArguments should use to start the daemon.
 *
 * Why this exists: when an `imcodes upgrade` (or any `npm install -g
 * imcodes@…`) gets killed mid-write — power loss, OOM-kill, ssh disconnect
 * — npm leaves CRITICAL_DEPS in `node_modules/` as empty placeholder
 * directories. The next daemon start hits ERR_MODULE_NOT_FOUND on the
 * first import, exits 1, systemd Restart=always thrashes forever. There
 * is no Node-side fix — the failure is at module-load time, before any
 * application code runs.
 *
 * The pure-bash supervisor at `bin/imcodes-launch.sh` solves this from
 * outside the Node process: it pre-flight-checks `node_modules`, detects
 * the half-install signature, re-installs the same pinned version, then
 * exec's the real Node entry. systemd / launchctl never has to know.
 *
 * This helper picks the right launch target:
 *   - launcher present  → `imcodes-launch.sh start --foreground`  (Linux systemd; the macOS plist runs node, see above)
 *   - launcher missing  → `node dist/src/index.js start --foreground`
 *
 * The fallback exists so older installs that pre-date the launcher still
 * generate working units. They lose self-healing (their next half-upgrade
 * still wedges them) but the FIRST upgrade lands the launcher and from
 * that point on they're auto-recoverable.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MACOS_DAEMON_LAUNCH } from '../../shared/macos-daemon-launch.js';

export interface DaemonLaunchTarget {
  /** Absolute path to the program systemd/launchctl should exec. */
  program: string;
  /** CLI args for that program (excluding the program itself). */
  args: string[];
}

/**
 * The package root (the directory holding `bin/` and `package.json`) above an entry path, or undefined. Walks up from the entry
 * path capped at 8 levels to bound the search on weird installs (we expect the root exactly 2 levels up from `dist/src/index.js`,
 * but global installs vs nvm vs source checkouts all nest slightly differently).
 */
export function findDaemonPackageRoot(entry: string = process.argv[1]): string | undefined {
  let dir = resolve(entry);
  for (let i = 0; i < 8; i++) {
    dir = dirname(dir);
    if (!dir || dir === '/' || dir === '.') break;
    if (existsSync(resolve(dir, MACOS_DAEMON_LAUNCH.PREFLIGHT_RELATIVE)) && existsSync(resolve(dir, 'package.json'))) return dir;
  }
  return undefined;
}

/**
 * The Linux (systemd) launch target. macOS does NOT use this: its launch agent runs node itself
 * (shared/macos-daemon-launch.ts, src/util/macos-launch-agent.ts) so that Full Disk Access is attributed to node.
 *
 * @param entry  Path to `dist/src/index.js` (or whatever the install surfaced as `process.argv[1]` at install time).
 * @param node   Absolute path to the node binary. Defaults to `process.execPath`.
 */
export function resolveDaemonLaunchTarget(
  entry: string = process.argv[1],
  node: string = process.execPath,
): DaemonLaunchTarget {
  const root = findDaemonPackageRoot(entry);
  if (root) return { program: resolve(root, MACOS_DAEMON_LAUNCH.PREFLIGHT_RELATIVE), args: [...MACOS_DAEMON_LAUNCH.START_ARGS] };
  return { program: node, args: [entry, ...MACOS_DAEMON_LAUNCH.START_ARGS] };
}

/** Render an `ExecStart=` line value for a systemd unit. */
export function renderSystemdExecStart(target: DaemonLaunchTarget): string {
  return [target.program, ...target.args].join(' ');
}
