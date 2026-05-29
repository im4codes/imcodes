/**
 * Node's built-in `node:sqlite` emits a process `ExperimentalWarning`
 * ("SQLite is an experimental feature and might change at any time") the first
 * time it is loaded in EVERY thread — the daemon main thread plus each SQLite
 * worker (timeline projection, timeline history). On a busy daemon that
 * repeatedly (re)spawns workers this floods `daemon.log` with hundreds of
 * identical, non-actionable lines (both Node's default printer AND the
 * daemon's own `process.on('warning')` logger emit it).
 *
 * The bundled SQLite version is already current (3.51.x as of 2026), so the
 * warning carries no operational signal for us — it's pure noise.
 *
 * This installs a one-time `process.emitWarning` shim that drops ONLY that
 * specific warning and forwards every other warning (deprecations, other
 * experimental features, MaxListenersExceeded, custom warnings) untouched.
 * Intercepting at `emitWarning` suppresses BOTH Node's default stderr printer
 * and any `process.on('warning')` listeners, because both are downstream of it.
 *
 * Call this IMMEDIATELY BEFORE `require('node:sqlite')` in each module/thread
 * that loads it, so the shim is in place before the warning fires. It is
 * idempotent and per-thread (each worker thread installs its own shim once).
 */
let installed = false;
let preInstallEmitWarning: typeof process.emitWarning | null = null;

export function suppressSqliteExperimentalWarning(): void {
  if (installed) return;
  installed = true;

  preInstallEmitWarning = process.emitWarning;
  const original = process.emitWarning.bind(process);

  const isSqliteExperimentalWarning = (warning: string | Error, rest: unknown[]): boolean => {
    const message = typeof warning === 'string' ? warning : (warning?.message ?? '');
    if (!/SQLite is an experimental feature/i.test(message)) return false;
    // `type` may arrive as a positional string (process.emitWarning(msg, 'ExperimentalWarning', code))
    // or inside an options object (process.emitWarning(msg, { type: 'ExperimentalWarning' })).
    const first = rest[0];
    let type: string | undefined;
    if (typeof first === 'string') type = first;
    else if (first && typeof first === 'object' && 'type' in first) {
      type = (first as { type?: unknown }).type as string | undefined;
    }
    // Be lenient: the message match alone is specific enough, but prefer the
    // ExperimentalWarning type when present.
    return type === undefined || type === 'ExperimentalWarning';
  };

  // Preserve the original overload signatures via a passthrough cast.
  process.emitWarning = function patchedEmitWarning(
    warning: string | Error,
    ...rest: unknown[]
  ): void {
    if (isSqliteExperimentalWarning(warning, rest)) return;
    (original as (warning: string | Error, ...args: unknown[]) => void)(warning, ...rest);
  } as typeof process.emitWarning;
}

/** Test-only: uninstall the shim and restore the prior `process.emitWarning`. */
export function __resetSqliteWarningSuppressionForTests(): void {
  if (preInstallEmitWarning) process.emitWarning = preInstallEmitWarning;
  preInstallEmitWarning = null;
  installed = false;
}
