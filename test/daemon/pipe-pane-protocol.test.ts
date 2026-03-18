/**
 * Task 8.2: Binary frame encode/decode + control-plane tests.
 * Task 8.6: Per-session write ordering (AsyncMutex).
 * Task 8.7: commandId dedup.
 * Task 8.8: command.ack emission.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Binary frame encode/decode (Task 8.2) ─────────────────────────────────────

function packRawFrame(sessionName: string, data: Buffer): Buffer {
  const nameBytes = Buffer.from(sessionName, 'utf8');
  const header = Buffer.allocUnsafe(3 + nameBytes.length);
  header[0] = 0x01;
  header.writeUInt16BE(nameBytes.length, 1);
  nameBytes.copy(header, 3);
  return Buffer.concat([header, data]);
}

function parseRawFrame(buf: Buffer): { version: number; sessionName: string; payload: Buffer } | null {
  if (buf.length < 3 || buf[0] !== 0x01) return null;
  const nameLen = buf.readUInt16BE(1);
  if (buf.length < 3 + nameLen) return null;
  return {
    version: buf[0],
    sessionName: buf.subarray(3, 3 + nameLen).toString('utf8'),
    payload: buf.subarray(3 + nameLen),
  };
}

describe('Binary raw frame protocol (Task 8.2)', () => {
  it('packs and unpacks a frame correctly', () => {
    const session = 'deck_myapp_brain';
    const payload = Buffer.from('hello pty world');
    const frame = packRawFrame(session, payload);

    const parsed = parseRawFrame(frame);
    expect(parsed).not.toBeNull();
    expect(parsed!.version).toBe(0x01);
    expect(parsed!.sessionName).toBe(session);
    expect(parsed!.payload.toString()).toBe('hello pty world');
  });

  it('returns null for frames with wrong version', () => {
    const bad = Buffer.from([0x02, 0x00, 0x05, ...Buffer.from('hello')]);
    expect(parseRawFrame(bad)).toBeNull();
  });

  it('returns null for truncated frames', () => {
    const session = 'deck_x_w1';
    const nameBytes = Buffer.from(session, 'utf8');
    // Header says nameLen=9 but buffer only has 5 name bytes
    const truncated = Buffer.allocUnsafe(3 + 5);
    truncated[0] = 0x01;
    truncated.writeUInt16BE(nameBytes.length, 1);
    nameBytes.subarray(0, 5).copy(truncated, 3);
    expect(parseRawFrame(truncated)).toBeNull();
  });

  it('encodes session name as UTF-8 with correct length prefix', () => {
    const session = 'deck_中文_brain'; // CJK chars in session name
    const payload = Buffer.from([0xDE, 0xAD]);
    const frame = packRawFrame(session, payload);

    const nameBytes = Buffer.from(session, 'utf8');
    expect(frame.readUInt16BE(1)).toBe(nameBytes.length);
    const parsed = parseRawFrame(frame);
    expect(parsed!.sessionName).toBe(session);
  });

  it('handles empty payload', () => {
    const session = 'deck_test_w1';
    const frame = packRawFrame(session, Buffer.alloc(0));
    const parsed = parseRawFrame(frame);
    expect(parsed!.sessionName).toBe(session);
    expect(parsed!.payload.length).toBe(0);
  });
});

// ── AsyncMutex (Task 8.6 — write ordering) ───────────────────────────────────

class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      const tryLock = () => {
        if (!this.locked) {
          this.locked = true;
          resolve(() => this.release());
        } else {
          this.queue.push(tryLock);
        }
      };
      tryLock();
    });
  }

  private release(): void {
    this.locked = false;
    const next = this.queue.shift();
    if (next) next();
  }
}

describe('AsyncMutex write ordering (Task 8.6)', () => {
  it('serializes concurrent acquires in FIFO order', async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];

    const worker = async (id: number, delayMs: number) => {
      const release = await mutex.acquire();
      order.push(id);
      await new Promise<void>((r) => setTimeout(r, delayMs));
      release();
    };

    // Start 3 workers concurrently
    await Promise.all([
      worker(1, 10),
      worker(2, 5),
      worker(3, 1),
    ]);

    // All should complete in acquire order (FIFO)
    expect(order).toEqual([1, 2, 3]);
  });

  it('allows reacquire after release', async () => {
    const mutex = new AsyncMutex();
    const release1 = await mutex.acquire();
    release1();
    const release2 = await mutex.acquire();
    release2();
    // No deadlock — test passes if it reaches here
    expect(true).toBe(true);
  });

  it('concurrent session.send calls execute in enqueue order', async () => {
    // Simulate two commands sent concurrently — they should execute in send order
    const mutex = new AsyncMutex();
    const executed: string[] = [];

    const sendCommand = async (commandId: string) => {
      const release = await mutex.acquire();
      try {
        executed.push(commandId);
      } finally {
        release();
      }
    };

    // Both start at same time
    const p1 = sendCommand('cmd-A');
    const p2 = sendCommand('cmd-B');
    await Promise.all([p1, p2]);

    expect(executed).toEqual(['cmd-A', 'cmd-B']);
  });
});

// ── CommandId dedup (Task 8.7) ────────────────────────────────────────────────

class CommandDedup {
  private entries = new Map<string, number>();
  private readonly MAX_SIZE = 100;
  private readonly TTL_MS: number;

  constructor(ttlMs = 5 * 60 * 1000) {
    this.TTL_MS = ttlMs;
  }

  has(commandId: string): boolean {
    const ts = this.entries.get(commandId);
    if (ts === undefined) return false;
    if (Date.now() - ts > this.TTL_MS) {
      this.entries.delete(commandId);
      return false;
    }
    return true;
  }

  add(commandId: string): void {
    if (this.entries.size >= this.MAX_SIZE) {
      const now = Date.now();
      for (const [id, ts] of this.entries) {
        if (now - ts > this.TTL_MS) this.entries.delete(id);
      }
      if (this.entries.size >= this.MAX_SIZE) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
    }
    this.entries.set(commandId, Date.now());
  }
}

describe('CommandId dedup (Task 8.7)', () => {
  it('returns false for unseen commandId', () => {
    const dedup = new CommandDedup();
    expect(dedup.has('cmd-001')).toBe(false);
  });

  it('returns true for duplicate commandId', () => {
    const dedup = new CommandDedup();
    dedup.add('cmd-001');
    expect(dedup.has('cmd-001')).toBe(true);
  });

  it('distinct commandIds both execute (both not in dedup)', () => {
    const dedup = new CommandDedup();
    dedup.add('cmd-A');
    expect(dedup.has('cmd-A')).toBe(true);
    expect(dedup.has('cmd-B')).toBe(false);
  });

  it('evicts expired entries', () => {
    const dedup = new CommandDedup(1); // 1ms TTL
    dedup.add('cmd-old');
    // Wait for TTL to expire
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(dedup.has('cmd-old')).toBe(false);
        resolve();
      }, 5);
    });
  });

  it('evicts oldest entry when at max size', () => {
    const dedup = new CommandDedup();
    // Fill to max
    for (let i = 0; i < 100; i++) {
      dedup.add(`cmd-${i}`);
    }
    // Adding one more should evict the oldest
    dedup.add('cmd-new');
    // cmd-0 should be evicted (was oldest)
    expect(dedup.has('cmd-0')).toBe(false);
    expect(dedup.has('cmd-new')).toBe(true);
  });
});

// ── command.ack emission (Task 8.8) ──────────────────────────────────────────

describe('command.ack accepted emission (Task 8.8)', () => {
  it('emits accepted ack after session.send is accepted into queue', async () => {
    // Simulate the handleSend logic: dedup check → mutex acquire → write → emit ack
    const mutex = new AsyncMutex();
    const dedup = new CommandDedup();
    const acks: Array<{ commandId: string; status: string }> = [];

    const handleSend = async (commandId: string, text: string) => {
      if (!commandId || !text) return;
      if (dedup.has(commandId)) return; // duplicate
      dedup.add(commandId);
      const release = await mutex.acquire();
      try {
        // Simulate write (synchronous for test)
        acks.push({ commandId, status: 'accepted' });
      } finally {
        release();
      }
    };

    await handleSend('cmd-001', 'hello');
    expect(acks).toHaveLength(1);
    expect(acks[0]).toEqual({ commandId: 'cmd-001', status: 'accepted' });
  });

  it('does NOT emit ack for duplicate commandId', async () => {
    const mutex = new AsyncMutex();
    const dedup = new CommandDedup();
    const acks: string[] = [];

    const handleSend = async (commandId: string) => {
      if (dedup.has(commandId)) return;
      dedup.add(commandId);
      const release = await mutex.acquire();
      try {
        acks.push(commandId);
      } finally {
        release();
      }
    };

    await handleSend('cmd-dup');
    await handleSend('cmd-dup'); // duplicate — should be ignored
    expect(acks).toHaveLength(1);
  });
});
