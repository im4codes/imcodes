/**
 * Daemon command.ack outbox — crash-safe persistence for unacknowledged acks.
 *
 * Problem: `serverLink.send(command.ack)` is best-effort; when the WS is not
 * OPEN the send silently drops. Previously this was swallowed in a
 * `try/catch {}` and the ack was lost forever, leaving the browser in a
 * 30-second spinner.
 *
 * Solution: before sending, enqueue the ack into this outbox (backed by an
 * append-only JSONL file so daemon process restarts don't lose it). On a
 * successful send, mark the entry acked (tombstone). On every successful WS
 * reconnect + auth, flush any non-acked entries in order. Entries past TTL or
 * `ACK_OUTBOX_MAX_ATTEMPTS` are dropped with an error log.
 *
 * Server side dedups via `seenCommandAcks` LRU, so outbox replay is safe.
 */

import { mkdir, readFile, writeFile, appendFile, rename } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import logger from '../util/logger.js';
import {
  ACK_OUTBOX_MAX_ATTEMPTS,
  ACK_OUTBOX_TTL_MS,
  MSG_COMMAND_ACK,
} from '../../shared/ack-protocol.js';

/** On-disk / in-memory shape. */
export interface AckOutboxEntry {
  commandId: string;
  sessionName: string;
  status: string;             // 'accepted' | 'accepted_legacy' | 'error' | ...
  error?: string;             // populated when status === 'error'
  ts: number;                 // enqueue time
  attempts: number;           // # of send attempts so far
}

/** On-disk record wrapper: either an entry or a tombstone. */
type DiskRecord =
  | { kind: 'entry'; entry: AckOutboxEntry }
  | { kind: 'ack'; commandId: string };

export interface AckOutboxSender {
  (msg: {
    type: typeof MSG_COMMAND_ACK;
    commandId: string;
    status: string;
    session: string;
    error?: string;
  }): void;
  isConnected?: () => boolean;
}

const DEFAULT_DIR = join(homedir(), '.imcodes');
const DEFAULT_FILE = join(DEFAULT_DIR, 'ack-outbox.jsonl');

export class AckOutbox {
  private entries = new Map<string, AckOutboxEntry>();
  private filePath: string;
  private initialized = false;
  private writing: Promise<void> = Promise.resolve();
  private gcTimer?: ReturnType<typeof setInterval>;

  constructor(filePath: string = DEFAULT_FILE) {
    this.filePath = filePath;
  }

  /** Read existing file, compact, and start periodic GC. Idempotent. */
  async init(gcIntervalMs = 60_000): Promise<void> {
    if (this.initialized) return;
    await mkdir(join(this.filePath, '..'), { recursive: true });

    const existing = await this.loadFromDisk();
    for (const [id, entry] of existing) this.entries.set(id, entry);

    // Compact on startup: rewrite file from scratch with only live (non-acked,
    // non-expired, attempts-OK) entries. This also discards tombstones.
    await this.rewriteAll();

    this.initialized = true;

    if (gcIntervalMs > 0) {
      this.gcTimer = setInterval(() => this.gc(), gcIntervalMs);
      this.gcTimer.unref?.();
    }
  }

  /** Stop GC timer. Useful in tests. */
  async close(): Promise<void> {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = undefined;
    }
    await this.writing;
  }

  /**
   * Enqueue an ack before attempting to send. The in-memory map is updated
   * synchronously (so flushOnReconnect / snapshot reflect it immediately);
   * disk persistence runs fire-and-forget through the serialized `writing`
   * promise chain. Callers MUST NOT await this if they hold a lock — the
   * actual durability is best-effort by design.
   *
   * Returns a promise that resolves once the disk append has completed,
   * for tests that need to assert the file contents.
   */
  enqueue(entry: Omit<AckOutboxEntry, 'attempts'> & { attempts?: number }): Promise<void> {
    const full: AckOutboxEntry = { ...entry, attempts: entry.attempts ?? 0 };
    this.entries.set(full.commandId, full);
    return this.appendRecord({ kind: 'entry', entry: full });
  }

  /**
   * Mark an ack as successfully delivered. Memory update is synchronous;
   * disk tombstone is fire-and-forget (serialized via `writing`).
   */
  markAcked(commandId: string): Promise<void> {
    if (!this.entries.delete(commandId)) return Promise.resolve();
    return this.appendRecord({ kind: 'ack', commandId });
  }

  /**
   * Replay all non-acked entries through `send`, in ascending sentAt order.
   * Increments `attempts` per entry. Entries exceeding MAX_ATTEMPTS are
   * dropped with a logger.error.
   */
  async flushOnReconnect(send: AckOutboxSender): Promise<void> {
    const ordered = [...this.entries.values()].sort((a, b) => a.ts - b.ts);
    for (const entry of ordered) {
      if (entry.attempts >= ACK_OUTBOX_MAX_ATTEMPTS) {
        logger.error(
          { commandId: entry.commandId, attempts: entry.attempts },
          'AckOutbox: attempts cap exceeded, dropping entry',
        );
        await this.markAcked(entry.commandId);
        continue;
      }

      if (send.isConnected && !send.isConnected()) {
        // Bail early; remaining entries will flush on next reconnect.
        return;
      }

      entry.attempts += 1;
      try {
        send({
          type: MSG_COMMAND_ACK,
          commandId: entry.commandId,
          status: entry.status,
          session: entry.sessionName,
          ...(entry.error ? { error: entry.error } : {}),
        });
        // Successful enqueue-for-send; server dedup handles duplicate receipt.
        // We do NOT immediately markAcked — that is done in the normal path by
        // the caller when send() succeeds. For flushOnReconnect we optimistically
        // treat send() returning without throwing as delivered (server has LRU).
        await this.markAcked(entry.commandId);
      } catch (err) {
        // Keep entry; persist incremented attempts so we honor the cap after
        // process restart.
        await this.appendRecord({ kind: 'entry', entry });
        logger.warn(
          { commandId: entry.commandId, attempts: entry.attempts, err },
          'AckOutbox: flush retry failed, will retry next reconnect',
        );
        // Link likely broken — stop iterating; next reconnect picks up.
        return;
      }
    }
  }

  /** Drop TTL-expired / over-attempt entries. Called periodically. */
  async gc(): Promise<void> {
    const now = Date.now();
    const drop: string[] = [];
    for (const [id, entry] of this.entries) {
      if (now - entry.ts > ACK_OUTBOX_TTL_MS) drop.push(id);
      else if (entry.attempts >= ACK_OUTBOX_MAX_ATTEMPTS) drop.push(id);
    }
    for (const id of drop) {
      const entry = this.entries.get(id);
      if (entry) {
        logger.warn(
          { commandId: id, ageMs: now - entry.ts, attempts: entry.attempts },
          'AckOutbox: GC dropping entry',
        );
      }
      this.entries.delete(id);
      await this.appendRecord({ kind: 'ack', commandId: id });
    }
  }

  /** Number of outstanding (non-acked) entries. Mainly for tests. */
  size(): number {
    return this.entries.size;
  }

  /** Snapshot of current outstanding entries. Mainly for tests. */
  snapshot(): AckOutboxEntry[] {
    return [...this.entries.values()];
  }

  // ── internal ────────────────────────────────────────────────────────────

  private async loadFromDisk(): Promise<Map<string, AckOutboxEntry>> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw err;
    }
    const now = Date.now();
    const live = new Map<string, AckOutboxEntry>();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec: DiskRecord;
      try {
        rec = JSON.parse(line) as DiskRecord;
      } catch {
        continue;
      }
      if (rec.kind === 'entry') {
        if (now - rec.entry.ts > ACK_OUTBOX_TTL_MS) continue;
        if (rec.entry.attempts >= ACK_OUTBOX_MAX_ATTEMPTS) continue;
        live.set(rec.entry.commandId, rec.entry);
      } else if (rec.kind === 'ack') {
        live.delete(rec.commandId);
      }
    }
    return live;
  }

  private async rewriteAll(): Promise<void> {
    const tmp = `${this.filePath}.tmp`;
    const body = [...this.entries.values()]
      .map((entry) => JSON.stringify({ kind: 'entry', entry } satisfies DiskRecord))
      .join('\n');
    await writeFile(tmp, body ? body + '\n' : '', 'utf-8');
    await rename(tmp, this.filePath);
  }

  private appendRecord(rec: DiskRecord): Promise<void> {
    // Serialize writes to avoid interleaved appends under concurrency.
    this.writing = this.writing.then(
      () => appendFile(this.filePath, JSON.stringify(rec) + '\n', 'utf-8'),
      () => appendFile(this.filePath, JSON.stringify(rec) + '\n', 'utf-8'),
    );
    return this.writing;
  }
}

// ── Module-level singleton (optional convenience for daemon wiring) ────────

let defaultOutbox: AckOutbox | null = null;

/** Lazily create / return the process-wide default outbox. */
export function getDefaultAckOutbox(): AckOutbox {
  if (!defaultOutbox) defaultOutbox = new AckOutbox();
  return defaultOutbox;
}

/** Reset the module singleton — for tests only. */
export function __resetDefaultAckOutboxForTests(): void {
  defaultOutbox = null;
}
