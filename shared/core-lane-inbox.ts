import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type CoreLaneInboundRecord = {
  id: string;
  commandId: string;
  session: string;
  payload: string;
  ts: number;
};

type DiskRecord =
  | { kind: 'entry'; entry: CoreLaneInboundRecord }
  | { kind: 'ack'; id: string };

/** Small crash-safe inbox used by the link worker before it emits a receipt. */
export class CoreLaneInboundInbox {
  private readonly filePath: string;
  private readonly entries = new Map<string, CoreLaneInboundRecord>();

  constructor(filePath = join(homedir(), '.imcodes', 'core-lane-inbound.jsonl')) {
    this.filePath = filePath;
    mkdirSync(join(filePath, '..'), { recursive: true });
    this.load();
  }

  pending(): CoreLaneInboundRecord[] {
    return [...this.entries.values()].sort((a, b) => a.ts - b.ts);
  }

  append(entry: CoreLaneInboundRecord): void {
    this.entries.set(entry.id, entry);
    this.appendDurable({ kind: 'entry', entry });
  }

  acknowledge(id: string): void {
    if (!this.entries.delete(id)) return;
    this.appendDurable({ kind: 'ack', id });
    if (this.entries.size === 0) this.compact();
  }

  private load(): void {
    let text = '';
    try { text = readFileSync(this.filePath, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const record = JSON.parse(line) as DiskRecord;
        if (record.kind === 'entry' && record.entry?.id) this.entries.set(record.entry.id, record.entry);
        else if (record.kind === 'ack' && record.id) this.entries.delete(record.id);
      } catch { /* ignore a torn final line; entries are retried from the last fsync */ }
    }
  }

  private appendDurable(record: DiskRecord): void {
    const fd = openSync(this.filePath, 'a');
    try {
      writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private compact(): void {
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    const body = [...this.entries.values()].map((entry) => JSON.stringify({ kind: 'entry', entry })).join('\n');
    writeFileSync(tmp, body ? `${body}\n` : '', 'utf8');
    // Windows rejects fsync on a read-only descriptor (EPERM).  Open the
    // freshly-written file read/write so the durability barrier is portable.
    const fd = openSync(tmp, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.filePath);
  }
}

export function replayCoreLaneInbound(entries: readonly CoreLaneInboundRecord[], emit: (entry: CoreLaneInboundRecord) => void): void {
  for (const entry of entries) emit(entry);
}
