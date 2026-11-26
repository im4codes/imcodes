export const DAEMON_SHUTDOWN_PHASES = ['session', 'mcp', 'browser', 'container'] as const;
export type DaemonShutdownPhase = typeof DAEMON_SHUTDOWN_PHASES[number];

export interface DaemonShutdownFailure {
  phase: DaemonShutdownPhase;
  kind: 'timeout' | 'error';
  detail: string;
}

export interface DaemonShutdownResult {
  ok: boolean;
  exitCode: 0 | 1;
  failures: DaemonShutdownFailure[];
}

export type DaemonShutdownHooks = Record<DaemonShutdownPhase, () => void | Promise<void>>;

export interface DaemonShutdownOptions {
  phaseTimeoutMs?: number;
  forceKill?: (phase: DaemonShutdownPhase, failure: DaemonShutdownFailure) => void | Promise<void>;
}

class ShutdownPhaseTimeout extends Error {}

async function bounded(hook: () => void | Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(hook),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ShutdownPhaseTimeout(`timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runOrderedDaemonShutdown(
  hooks: DaemonShutdownHooks,
  options: DaemonShutdownOptions = {},
): Promise<DaemonShutdownResult> {
  const timeoutMs = Math.max(1, options.phaseTimeoutMs ?? 10_000);
  const failures: DaemonShutdownFailure[] = [];
  for (const phase of DAEMON_SHUTDOWN_PHASES) {
    try {
      await bounded(hooks[phase], timeoutMs);
    } catch (error) {
      const failure: DaemonShutdownFailure = {
        phase,
        kind: error instanceof ShutdownPhaseTimeout ? 'timeout' : 'error',
        detail: error instanceof Error ? error.message : String(error),
      };
      failures.push(failure);
      try {
        await options.forceKill?.(phase, failure);
      } catch (forceError) {
        failure.detail += `; force cleanup failed: ${forceError instanceof Error ? forceError.message : String(forceError)}`;
      }
    }
  }
  return { ok: failures.length === 0, exitCode: failures.length === 0 ? 0 : 1, failures };
}
