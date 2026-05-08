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
 *   - launcher present  → `imcodes-launch.sh start --foreground`
 *   - launcher missing  → `node dist/src/index.js start --foreground`
 *
 * The fallback exists so older installs that pre-date the launcher still
 * generate working units. They lose self-healing (their next half-upgrade
 * still wedges them) but the FIRST upgrade lands the launcher and from
 * that point on they're auto-recoverable.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface DaemonLaunchTarget {
  /** Absolute path to the program systemd/launchctl should exec. */
  program: string;
  /** CLI args for that program (excluding the program itself). */
  args: string[];
}

/**
 * @param entry  Path to `dist/src/index.js` (or whatever the install
 *               surfaced as `process.argv[1]` at install time). Defaults
 *               to the running daemon's own `process.argv[1]`.
 * @param node   Absolute path to the node binary. Defaults to
 *               `process.execPath`.
 */
export function resolveDaemonLaunchTarget(
  entry: string = process.argv[1],
  node: string = process.execPath,
): DaemonLaunchTarget {
  // Walk up from the entry path looking for a sibling `bin/` containing
  // `imcodes-launch.sh`. Capped at 8 levels to bound the search on weird
  // installs (we expect the launcher exactly 2 levels up from
  // `dist/src/index.js`, but global installs vs nvm vs source checkouts
  // all nest slightly differently).
  let dir = resolve(entry);
  for (let i = 0; i < 8; i++) {
    dir = dirname(dir);
    if (!dir || dir === '/' || dir === '.') break;
    const launcher = resolve(dir, 'bin/imcodes-launch.sh');
    const pkg = resolve(dir, 'package.json');
    if (existsSync(launcher) && existsSync(pkg)) {
      return { program: launcher, args: ['start', '--foreground'] };
    }
  }
  return { program: node, args: [entry, 'start', '--foreground'] };
}

/** Render `args` as a `<string>` array for an Apple plist body. */
export function renderPlistProgramArguments(target: DaemonLaunchTarget): string {
  const parts = [target.program, ...target.args].map(
    (s) => `    <string>${s}</string>`,
  );
  return parts.join('\n');
}

/** Render an `ExecStart=` line value for a systemd unit. */
export function renderSystemdExecStart(target: DaemonLaunchTarget): string {
  return [target.program, ...target.args].join(' ');
}
