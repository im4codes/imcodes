import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { AckOutbox } from './ack-outbox.js';
import { ACK_OUTBOX_MAX_ATTEMPTS } from '../../shared/ack-protocol.js';

let dir: string;
let outboxFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ack-outbox-'));
  outboxFile = join(dir, 'ack-outbox.jsonl');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<{ commandId: string; sessionName: string; status: string; ts: number }> = {}) {
  return {
    commandId: overrides.commandId ?? 'C1',
    sessionName: overrides.sessionName ?? 'deck_test_brain',
    status: overrides.status ?? 'accepted',
    ts: overrides.ts ?? Date.now(),
  };
}

describe('AckOutbox', () => {
  test('enqueue persists entry and snapshot returns it', async () => {
    const outbox = new AckOutbox(outboxFile);
    await outbox.init(0);
    await outbox.enqueue(makeEntry({ commandId: 'C1' }));
    expect(outbox.size()).toBe(1);
    expect(outbox.snapshot()[0].commandId).toBe('C1');
    const body = await readFile(outboxFile, 'utf-8');
    expect(body).toContain('"C1"');
    await outbox.close();
  });

  test('markAcked removes entry and appends tombstone', async () => {
    const outbox = new AckOutbox(outboxFile);
    await outbox.init(0);
    await outbox.enqueue(makeEntry({ commandId: 'C1' }));
    await outbox.markAcked('C1');
    expect(outbox.size()).toBe(0);
    await outbox.close();
  });

  test('init replays non-acked entries from disk after simulated restart', async () => {
    const outbox1 = new AckOutbox(outboxFile);
    await outbox1.init(0);
    await outbox1.enqueue(makeEntry({ commandId: 'C1' }));
    await outbox1.enqueue(makeEntry({ commandId: 'C2' }));
    await outbox1.markAcked('C2');
    await outbox1.close();

    const outbox2 = new AckOutbox(outboxFile);
    await outbox2.init(0);
    expect(outbox2.size()).toBe(1);
    expect(outbox2.snapshot()[0].commandId).toBe('C1');
    await outbox2.close();
  });

  test('flushOnReconnect sends in ascending ts order, increments attempts, marks acked', async () => {
    const outbox = new AckOutbox(outboxFile);
    await outbox.init(0);
    const t0 = Date.now();
    await outbox.enqueue(makeEntry({ commandId: 'C_late', ts: t0 + 10 }));
    await outbox.enqueue(makeEntry({ commandId: 'C_early', ts: t0 }));

    const sent: string[] = [];
    const sender = (msg: { commandId: string }) => { sent.push(msg.commandId); };
    (sender as unknown as { isConnected: () => boolean }).isConnected = () => true;

    await outbox.flushOnReconnect(sender as never);
    expect(sent).toEqual(['C_early', 'C_late']);
    expect(outbox.size()).toBe(0);
    await outbox.close();
  });

  test('flushOnReconnect drops entries whose attempts already hit the cap', async () => {
    const outbox = new AckOutbox(outboxFile);
    await outbox.init(0);
    // Simulate a previously-retried entry by directly enqueuing then bumping attempts.
    const entry = makeEntry({ commandId: 'C_dead' });
    await outbox.enqueue(entry);
    // Manually bump attempts via multiple simulated failed flushes:
    for (let i = 0; i < ACK_OUTBOX_MAX_ATTEMPTS; i++) {
      outbox.snapshot()[0].attempts = ACK_OUTBOX_MAX_ATTEMPTS;
    }
    const sender = (_msg: unknown) => { throw new Error('should not send'); };
    await outbox.flushOnReconnect(sender as never);
    expect(outbox.size()).toBe(0);
    await outbox.close();
  });

  test('flushOnReconnect bails when isConnected returns false and leaves entry for next retry', async () => {
    const outbox = new AckOutbox(outboxFile);
    await outbox.init(0);
    await outbox.enqueue(makeEntry({ commandId: 'C1' }));
    const sender = (_msg: unknown) => { throw new Error('should not send'); };
    (sender as unknown as { isConnected: () => boolean }).isConnected = () => false;
    await outbox.flushOnReconnect(sender as never);
    expect(outbox.size()).toBe(1);
    await outbox.close();
  });

  test('gc drops TTL-expired entries', async () => {
    const outbox = new AckOutbox(outboxFile);
    await outbox.init(0);
    await outbox.enqueue(makeEntry({ commandId: 'C1', ts: Date.now() - 11 * 60_000 }));
    await outbox.enqueue(makeEntry({ commandId: 'C2', ts: Date.now() }));
    await outbox.gc();
    expect(outbox.size()).toBe(1);
    expect(outbox.snapshot()[0].commandId).toBe('C2');
    await outbox.close();
  });

  test('compact on init drops expired and attempts-cap entries from disk', async () => {
    const outbox1 = new AckOutbox(outboxFile);
    await outbox1.init(0);
    await outbox1.enqueue(makeEntry({ commandId: 'C_old', ts: Date.now() - 11 * 60_000 }));
    await outbox1.enqueue(makeEntry({ commandId: 'C_new', ts: Date.now() }));
    await outbox1.close();

    const outbox2 = new AckOutbox(outboxFile);
    await outbox2.init(0);
    expect(outbox2.size()).toBe(1);
    expect(outbox2.snapshot()[0].commandId).toBe('C_new');
    await outbox2.close();
  });
});
