import { watch, type FSWatcher, createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export interface AgyTranscriptRow {
  step_index: number; type: string; status: string; source?: string; content?: string;
  tool_calls?: Array<{ name?: string; args?: unknown }>;
  input_tokens?: number; output_tokens?: number; cache_read_tokens?: number;
}
export function agyTranscriptFile(home: string, id: string): string | undefined {
  if (!path.isAbsolute(home) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(id)) return;
  return path.join(home, '.gemini/antigravity-cli/brain', id, '.system_generated/logs/transcript_full.jsonl');
}

/** AG 1.5 ACP ends its stdout subscription at prompt RPC completion, even
 * though its native engine keeps executing reactive child wakeups. Watch only
 * this known owner's file; never poll or start a second native prompt. */
export class AgyTranscriptBridge {
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private reading?: Promise<void>;
  private again = false;
  private offset = 0;
  private inode?: number;
  private partial = '';
  private decoder = new StringDecoder('utf8');
  private lastStep = -1;
  private watched?: string;

  constructor(readonly file: string, private readonly onRow: (row: AgyTranscriptRow) => void) {}
  async start(replayExisting = false): Promise<void> {
    // Baseline is read once (without replay callbacks) so rotation cannot
    // replay an old SYSTEM_MESSAGE from a restored conversation.
    await this.arm();
    if (replayExisting) await this.flush();
    else await this.read(true);
  }

  private async arm(): Promise<void> {
    if (this.closed) return;
    // Native session/new can return before its logs directory exists. Watch
    // the nearest existing ancestor until creation, then narrow the watcher.
    let dir = path.dirname(this.file);
    while (true) {
      try { if ((await stat(dir)).isDirectory()) break; } catch { /* descend on the next creation event */ }
      const parent = path.dirname(dir); if (parent === dir) return; dir = parent;
    }
    if (this.closed || dir === this.watched) return;
    this.watcher?.close(); this.watched = dir;
    try {
      this.watcher = watch(dir, { persistent: false }, () => this.schedule());
      this.watcher.on('error', () => { this.watcher?.close(); this.watched = undefined; });
    } catch { this.watched = undefined; }
  }
  private schedule(): void {
    if (this.closed || this.timer) return;
    // Event coalescing gives native ACP frames precedence, not a polling loop.
    this.timer = setTimeout(() => { this.timer = undefined; void this.arm().then(() => this.flush()); }, 60);
    this.timer.unref?.();
  }
  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.reading) { this.again = true; return this.reading; }
    this.reading = (async () => {
      do { this.again = false; await this.read(); } while (this.again && !this.closed);
    })().finally(() => { this.reading = undefined; });
    return this.reading;
  }
  private async read(baseline = false): Promise<void> {
    try {
      const s = await stat(this.file);
      if (this.inode !== s.ino || s.size < this.offset) {
        this.offset = 0; this.partial = ''; this.decoder = new StringDecoder('utf8');
      }
      this.inode = s.ino;
      if (s.size <= this.offset) return;
      const end = s.size;
      for await (const bytes of createReadStream(this.file, { start: this.offset, end: end - 1, highWaterMark: 64 * 1024 })) {
        if (this.closed) return;
        this.partial += this.decoder.write(bytes as Buffer);
        let lineEnd: number;
        while ((lineEnd = this.partial.indexOf('\n')) >= 0) {
          const line = this.partial.slice(0, lineEnd); this.partial = this.partial.slice(lineEnd + 1);
          let row: AgyTranscriptRow;
          try { row = JSON.parse(line) as AgyTranscriptRow; } catch { continue; }
          if (!Number.isSafeInteger(row.step_index) || row.step_index <= this.lastStep || row.status !== 'DONE') continue;
          this.lastStep = row.step_index;
          if (!this.closed && !baseline) this.onRow(row);
        }
      }
      this.offset = end;
    } catch {
      // Missing during creation/rotation is retried only on a filesystem event
      // or explicit native boundary; no timer retry and no invented output.
    }
  }
  close(): void {
    this.closed = true; this.watcher?.close(); this.watcher = undefined;
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
  }
}
