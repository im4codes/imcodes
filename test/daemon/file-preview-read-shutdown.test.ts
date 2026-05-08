import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PreviewReadDrainController } from '../../src/daemon/file-preview-read-shutdown.js';

class FakeClock {
  current = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + delayMs, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(timer: ReturnType<typeof setTimeout>): void {
    this.timers.delete(timer as unknown as number);
  }

  advance(ms: number): void {
    this.current += ms;
    for (const [id, timer] of [...this.timers.entries()]) {
      if (timer.at > this.current) continue;
      this.timers.delete(id);
      timer.callback();
    }
  }
}

describe('PreviewReadDrainController', () => {
  it('sends unavailable responses within a bounded shutdown budget', async () => {
    const clock = new FakeClock();
    const drain = new PreviewReadDrainController({ clock, budgetMs: 10 });
    const sent: string[] = [];

    const result = await drain.drain(['a', 'b'], (requestId) => {
      sent.push(requestId);
    });

    expect(result).toEqual({ attempted: 2, completed: 2, timedOut: false });
    expect(sent).toEqual(['a', 'b']);
  });

  it('stops waiting when a send exceeds the remaining budget', async () => {
    const clock = new FakeClock();
    const drain = new PreviewReadDrainController({ clock, budgetMs: 5 });
    const never = new Promise<void>(() => {});

    const resultPromise = drain.drain(['a', 'b'], () => never);
    clock.advance(6);
    const result = await resultPromise;

    expect(result).toEqual({ attempted: 1, completed: 0, timedOut: true });
  });
});

describe('daemon lifecycle preview-read shutdown hook', () => {
  it('drains the default preview coordinator before disconnecting serverLink', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const source = readFileSync(resolve(repoRoot, 'src/daemon/lifecycle.ts'), 'utf8');

    const drainIndex = source.indexOf('shutdownDefaultPreviewReadCoordinatorForDaemon');
    const disconnectIndex = source.indexOf('serverLink?.disconnect');

    expect(drainIndex).toBeGreaterThanOrEqual(0);
    expect(disconnectIndex).toBeGreaterThanOrEqual(0);
    expect(drainIndex).toBeLessThan(disconnectIndex);
  });
});
