import type { Database } from '../db/client.js';
import { readDatabaseClock } from './remote-desktop-guest-due-worker.js';
import { sweepExpiredPrivacyEpochs } from './remote-desktop-management-privacy.js';

export const REMOTE_DESKTOP_PRIVACY_SWEEP_MS = 500;
export const REMOTE_DESKTOP_PRIVACY_SWEEP_BATCH = 100;

export type RemoteDesktopPrivacySweep = (
  db: Database,
  input: { now: number; limit?: number },
) => Promise<{ recovered: string[] }>;

export type RemoteDesktopPrivacyClock = (db: Database) => Promise<number>;

/**
 * Process-local scheduler for the durable privacy lease state. PostgreSQL is
 * authoritative: every pod may sweep, `SKIP LOCKED` selects the winner, and a
 * restart merely resumes from the same non-idle rows. A failure never reopens
 * admission; the next bounded poll retries.
 */
export class RemoteDesktopManagementPrivacyWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = true;
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly onError: (error: unknown) => void = () => undefined,
    private readonly clock: RemoteDesktopPrivacyClock = readDatabaseClock,
    private readonly sweep: RemoteDesktopPrivacySweep = sweepExpiredPrivacyEpochs,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  async runOnce(): Promise<{ recovered: string[] }> {
    const now = await this.clock(this.db);
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid_privacy_sweep_clock');
    return this.sweep(this.db, { now, limit: REMOTE_DESKTOP_PRIVACY_SWEEP_BATCH });
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const tick = this.tick();
      this.inFlight = tick;
      void tick.finally(() => {
        if (this.inFlight === tick) this.inFlight = null;
      });
    }, delay);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.onError(error);
    } finally {
      this.running = false;
      this.schedule(REMOTE_DESKTOP_PRIVACY_SWEEP_MS);
    }
  }
}
