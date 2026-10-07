import { describe, expect, it } from 'vitest';
import { createConcurrencyGate } from '../../src/util/concurrency.js';

describe('createConcurrencyGate', () => {
  it('keeps the total in flight at the limit across independent callers, and serves the rest first come first served', async () => {
    const gate = createConcurrencyGate(2);
    let maxActive = 0;
    const order: number[] = [];
    const releases: Array<() => void> = [];
    const job = (id: number) => gate.run(async () => {
      order.push(id);
      maxActive = Math.max(maxActive, gate.active);
      await new Promise<void>((resolve) => { releases.push(resolve); });
    });
    const runs = [0, 1, 2, 3, 4].map((id) => job(id));
    await Promise.resolve();
    expect(order).toEqual([0, 1]);
    expect(gate.active).toBe(2);
    while (releases.length > 0) {
      releases.shift()!();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await Promise.all(runs);
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(maxActive).toBe(2);
    expect(gate.active).toBe(0);
  });

  it('a run that throws gives its slot back and rejects only its own caller', async () => {
    const gate = createConcurrencyGate(1);
    const failing = gate.run(async () => { throw new Error('boom'); });
    const next = gate.run(async () => 'ok');
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
    expect(gate.active).toBe(0);
  });

  it('clamps a nonsensical limit to one', async () => {
    const gate = createConcurrencyGate(0);
    let maxActive = 0;
    await Promise.all([1, 2, 3].map(() => gate.run(async () => { maxActive = Math.max(maxActive, gate.active); await new Promise((resolve) => setImmediate(resolve)); })));
    expect(maxActive).toBe(1);
  });
});
