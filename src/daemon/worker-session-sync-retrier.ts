export interface WorkerSessionSyncRetryOutcome {
  ok: boolean;
  retryable?: boolean;
  reason?: string;
}

export interface WorkerSessionSyncRetrierOptions<TOutcome extends WorkerSessionSyncRetryOutcome> {
  sync: () => Promise<TOutcome>;
  onRecovered?: (outcome: TOutcome) => Promise<void> | void;
  logger?: {
    info?: (obj: Record<string, unknown>, msg: string) => void;
    warn?: (obj: Record<string, unknown>, msg: string) => void;
  };
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
}

export interface WorkerSessionSyncRetrier {
  start(reason: string): void;
  stop(): void;
  isScheduled(): boolean;
  isInFlight(): boolean;
}

const DEFAULT_INITIAL_DELAY_MS = 10_000;
const DEFAULT_MAX_DELAY_MS = 5 * 60_000;
const DEFAULT_JITTER_RATIO = 0.2;

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(1, Math.trunc(value));
}

function withJitter(delayMs: number, jitterRatio: number): number {
  if (jitterRatio <= 0) return delayMs;
  const ratio = Math.max(0, jitterRatio);
  const multiplier = 1 + (Math.random() - 0.5) * ratio;
  return Math.max(0, Math.round(delayMs * multiplier));
}

export function createWorkerSessionSyncRetrier<TOutcome extends WorkerSessionSyncRetryOutcome>(
  options: WorkerSessionSyncRetrierOptions<TOutcome>,
): WorkerSessionSyncRetrier {
  const initialDelayMs = clampPositiveInt(options.initialDelayMs, DEFAULT_INITIAL_DELAY_MS);
  const maxDelayMs = Math.max(initialDelayMs, clampPositiveInt(options.maxDelayMs, DEFAULT_MAX_DELAY_MS));
  const jitterRatio = Math.max(0, options.jitterRatio ?? DEFAULT_JITTER_RATIO);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let inFlight = false;
  let nextDelayMs = initialDelayMs;

  const schedule = (reason: string, delayMs = nextDelayMs): void => {
    if (stopped || timer) return;
    const actualDelayMs = withJitter(delayMs, jitterRatio);
    options.logger?.warn?.(
      { reason, delayMs: actualDelayMs, nextBackoffMs: nextDelayMs },
      'worker session sync retry scheduled',
    );
    timer = setTimeout(() => {
      timer = null;
      void run('retry_timer');
    }, actualDelayMs);
    timer.unref?.();
  };

  const run = async (source: string): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const outcome = await options.sync();
      if (outcome.retryable ?? !outcome.ok) {
        const reason = outcome.reason ?? 'sync_failed';
        const delayForThisFailure = nextDelayMs;
        nextDelayMs = Math.min(nextDelayMs * 2, maxDelayMs);
        schedule(reason, delayForThisFailure);
        return;
      }
      await options.onRecovered?.(outcome);
      nextDelayMs = initialDelayMs;
      options.logger?.info?.({ source }, 'worker session sync recovered');
    } catch (err) {
      const delayForThisFailure = nextDelayMs;
      nextDelayMs = Math.min(nextDelayMs * 2, maxDelayMs);
      schedule(err instanceof Error ? err.message : 'sync_exception', delayForThisFailure);
    } finally {
      inFlight = false;
    }
  };

  return {
    start(reason: string): void {
      stopped = false;
      schedule(reason);
    },
    stop(): void {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    isScheduled(): boolean {
      return timer !== null;
    },
    isInFlight(): boolean {
      return inFlight;
    },
  };
}
