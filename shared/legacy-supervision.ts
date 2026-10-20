/**
 * The legacy supervision system's periodic work: ONE reversible switch.
 *
 * The legacy system is the task registry (`supervision-state.sqlite`, `supervision_*` tables) with its per-minute implementation
 * watchdog, its lifecycle-convergence / audit re-dispatch tick, the boot sweep and the scheduled worktree GC. The pairs engine
 * (src/daemon/task-pairs) replaced it: `TASK_PAIR_ENGINES` has the single value `pairs`, so no project can be in the state the legacy
 * watchdog was written for (the watchdog loop skipped every task, yet read and parsed the whole registry every minute). The owner has
 * abandoned it ("没有了 放弃 supervision, 先关闭"), and on a machine with a large legacy registry its passes held the daemon main thread
 * for seconds.
 *
 * Default OFF. Nothing is deleted: the code, the tools and the data stay, and turning the flag on restores the previous behaviour, so the
 * full removal can be a separate, reviewed step. Every legacy entry point that SCHEDULES or RUNS periodic legacy work asks this module.
 * What is NOT behind the switch: the pairs engine and its heartbeat, the pair console and projection, `imcodes send` / the MCP tools, the
 * one-time legacy import at daemon start, the session-mode supervision (wait states, mode control).
 */

/** Environment variable that turns the legacy periodic passes back on (`1`, `true`, `on`, `yes`). */
export const LEGACY_SUPERVISION_PERIODIC_ENV = 'IMCODES_LEGACY_SUPERVISION' as const;

/** The shipped default: the legacy periodic passes do not run. */
export const LEGACY_SUPERVISION_PERIODIC_DEFAULT_ENABLED = false;

const TRUTHY = new Set(['1', 'true', 'on', 'yes']);
const FALSY = new Set(['0', 'false', 'off', 'no']);

/** True when the legacy supervision periodic passes may be scheduled or run. A pure function of `env`. */
export function isLegacySupervisionPeriodicEnabled(
  env: Readonly<Record<string, string | undefined>> = typeof process !== 'undefined' ? process.env : {},
): boolean {
  const raw = env[LEGACY_SUPERVISION_PERIODIC_ENV]?.trim().toLowerCase();
  if (raw && TRUTHY.has(raw)) return true;
  if (raw && FALSY.has(raw)) return false;
  return LEGACY_SUPERVISION_PERIODIC_DEFAULT_ENABLED;
}
