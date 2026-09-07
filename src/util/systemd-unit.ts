/**
 * Single source of truth for the restart-authority fragments shared by the two
 * Linux unit templates (`bind-flow` and `setup-flow`). Keeping them here means a
 * bound can never be tightened in one installer and forgotten in the other.
 */

/** Window systemd measures start attempts over. */
export const SYSTEMD_START_LIMIT_INTERVAL_SEC = 300;

/** Maximum starts inside that window before systemd gives up and fails the unit. */
export const SYSTEMD_START_LIMIT_BURST = 5;

/**
 * Bounded restart authority.
 *
 * `Restart=` on its own retries a launch that can never succeed — a missing
 * interpreter, a half-finished `npm install` — forever at `RestartSec` spacing.
 * systemd only honours these directives in `[Unit]`; placing them in `[Service]`
 * is silently ignored on systemd >= 230, which is why they are rendered as part
 * of the unit section rather than next to `Restart=`.
 */
export function renderSystemdStartLimitBlock(): string {
  return [
    `StartLimitIntervalSec=${SYSTEMD_START_LIMIT_INTERVAL_SEC}`,
    `StartLimitBurst=${SYSTEMD_START_LIMIT_BURST}`,
  ].join('\n');
}

/**
 * Terminal diagnostics for an unrecoverable launch.
 *
 * `SERVICE_RESULT`, `EXIT_CODE` and `EXIT_STATUS` are exported by systemd to
 * `ExecStopPost` only, so the give-up that follows a start-limit trip leaves an
 * actionable record instead of silence.
 */
export function renderSystemdTerminalDiagnostics(): string {
  return 'ExecStopPost=/bin/sh -c \'printf "[imcodes] unit stopped result=%s exit=%s/%s at %s\\n"'
    + ' "$SERVICE_RESULT" "$EXIT_CODE" "$EXIT_STATUS" "$(date -Is)"'
    + ' >> "$HOME/.imcodes/daemon-service.log" 2>/dev/null || true\'';
}

/**
 * Upper bound on start attempts for a launch that always fails immediately.
 *
 * Once `SYSTEMD_START_LIMIT_BURST` starts occur within
 * `SYSTEMD_START_LIMIT_INTERVAL_SEC`, systemd fails the unit and stops retrying,
 * so the total is the burst itself rather than a per-day rate.
 */
export function boundedStartAttempts(): number {
  return SYSTEMD_START_LIMIT_BURST;
}

/** Attempts an unbounded `Restart=`/`RestartSec=` pair would make in 24h. */
export function unboundedStartAttemptsPerDay(restartSec: number): number {
  return Math.floor(86_400 / restartSec);
}

/** Unit names for the shipped external recovery trigger. */
export const RECOVERY_SERVICE_UNIT = 'imcodes-recovery.service';
export const RECOVERY_TIMER_UNIT = 'imcodes-recovery.timer';

/** Spacing between recovery checks. Deliberately coarse: the check exists to
 *  break a wedged unit, not to sample health, and the recovery itself is
 *  additionally rate-limited by its own persisted stamp. */
export const RECOVERY_CHECK_INTERVAL_SEC = 120;

/** Delay before the first post-boot check, so a normal boot settles first. */
export const RECOVERY_CHECK_BOOT_DELAY_SEC = 90;

function renderSystemdExecArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value) && !value.includes('%')) return value;
  // systemd expands percent specifiers even inside quotes. Doubling percent and
  // using its C-style quoted argument grammar preserves paths byte-for-byte.
  return JSON.stringify(value.replace(/%/g, '%%'));
}

/**
 * ExecStart for the recovery check.
 *
 * Deliberately invokes node against the daemon entry directly rather than the
 * self-healing launcher: the launcher may reinstall dependencies, which is the
 * right behaviour for a long-lived daemon and the wrong behaviour for a short
 * diagnostic that runs every couple of minutes.
 */
export function renderRecoveryExecStart(node: string, entry: string): string {
  return `${renderSystemdExecArgument(node)} ${renderSystemdExecArgument(entry)} recover-service`;
}

/**
 * The oneshot unit that performs one bounded recovery attempt.
 *
 * It is intentionally a separate unit from `imcodes.service`: a process inside
 * the wedged service's own cgroup cannot be the thing that tears that cgroup
 * down, and a zombie main process cannot execute its own recovery code.
 */
export function renderRecoveryService(execStart: string): string {
  return `[Unit]
Description=IM.codes daemon false-active recovery check
${renderSystemdStartLimitBlock()}

[Service]
Type=oneshot
ExecStart=${execStart}
${renderSystemdTerminalDiagnostics()}
`;
}

/** The timer that drives the oneshot check. */
export function renderRecoveryTimer(): string {
  return `[Unit]
Description=IM.codes daemon false-active recovery check timer

[Timer]
OnBootSec=${RECOVERY_CHECK_BOOT_DELAY_SEC}
OnUnitActiveSec=${RECOVERY_CHECK_INTERVAL_SEC}
AccuracySec=30
Unit=${RECOVERY_SERVICE_UNIT}

[Install]
WantedBy=timers.target
`;
}
