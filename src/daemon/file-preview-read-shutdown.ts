export const DEFAULT_PREVIEW_READ_SHUTDOWN_BUDGET_MS = 1_000;

export interface PreviewReadShutdownClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface PreviewReadDrainOptions {
  budgetMs?: number;
  clock?: PreviewReadShutdownClock;
}

export interface PreviewReadDrainResult {
  attempted: number;
  completed: number;
  timedOut: boolean;
}

const realClock: PreviewReadShutdownClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

export class PreviewReadDrainController {
  readonly budgetMs: number;
  private readonly clock: PreviewReadShutdownClock;

  constructor(options: PreviewReadDrainOptions = {}) {
    this.budgetMs = Math.max(0, Math.trunc(options.budgetMs ?? DEFAULT_PREVIEW_READ_SHUTDOWN_BUDGET_MS));
    this.clock = options.clock ?? realClock;
  }

  async drain<TRequestId extends string>(
    requestIds: Iterable<TRequestId>,
    sendUnavailable: (requestId: TRequestId) => void | Promise<void>,
  ): Promise<PreviewReadDrainResult> {
    const deadlineAt = this.clock.now() + this.budgetMs;
    let attempted = 0;
    let completed = 0;
    let timedOut = false;

    for (const requestId of requestIds) {
      attempted += 1;
      const remainingMs = deadlineAt - this.clock.now();
      if (remainingMs <= 0) {
        timedOut = true;
        break;
      }
      const result = await this.withBudget(Promise.resolve(sendUnavailable(requestId)), remainingMs);
      if (!result) {
        timedOut = true;
        break;
      }
      completed += 1;
    }

    return { attempted, completed, timedOut };
  }

  private async withBudget(promise: Promise<void>, budgetMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<false>((resolve) => {
      timer = this.clock.setTimeout(() => resolve(false), Math.max(0, budgetMs));
    });
    const result = await Promise.race([
      promise.then(() => true as const, () => true as const),
      timeout,
    ]);
    if (timer) this.clock.clearTimeout(timer);
    return result;
  }
}
