import { watch, type FSWatcher, createReadStream, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export interface AgyTranscriptRow {
  step_index: number; type: string; status: string; source?: string; content?: string;
  tool_calls?: Array<{ name?: string; args?: unknown }>;
  input_tokens?: number; output_tokens?: number; cache_read_tokens?: number;
}
const BACKGROUND_TASK_RUNNING_RE = /Tool is running as a background task with task id:/i;
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
  private parsedBytes = 0;
  private inode?: number;
  private partial = '';
  private decoder = new StringDecoder('utf8');
  private lastStep = -1;
  private watched?: { dir: string; ino: number; dev: number };

  constructor(readonly file: string, private readonly onRow: (row: AgyTranscriptRow, byteOffset?: number) => void) {}
  get isClosed(): boolean { return this.closed; }
  currentFileSize(): number {
    try { return statSync(this.file).size; } catch { return 0; }
  }
  async resume(): Promise<void> { this.closed = false; await this.flush(); }

  async start(replayExisting = false): Promise<void> {
    // Baseline is read once (without replay callbacks) so rotation cannot
    // replay an old SYSTEM_MESSAGE from a restored conversation.
    await this.run(!replayExisting);
  }

  private async arm(): Promise<void> {
    const target = path.dirname(this.file);
    while (!this.closed) {
      // Native session/new can return before its logs directory exists. Watch
      // the nearest existing ancestor until creation, then narrow the watcher.
      let dir = target;
      let identity: Awaited<ReturnType<typeof stat>> | undefined;
      while (true) {
        try { const info = await stat(dir); if (info.isDirectory()) { identity = info; break; } } catch { /* descend on the next creation event */ }
        const parent = path.dirname(dir); if (parent === dir) return; dir = parent;
      }
      if (this.closed || !identity) return;
      if (dir === this.watched?.dir && identity.ino === this.watched.ino && identity.dev === this.watched.dev) return;
      this.watcher?.close(); this.watched = { dir, ino: Number(identity.ino), dev: Number(identity.dev) };
      try {
        this.watcher = watch(
          dir,
          { persistent: false, recursive: process.platform === 'darwin' || process.platform === 'win32' },
          () => this.schedule(),
        );
        this.watcher.on('error', () => { this.watcher?.close(); this.watched = undefined; });
        this.schedule();
      } catch { this.watched = undefined; return; }
      if (dir === target) return;
    }
  }
  private schedule(): void {
    if (this.closed || this.timer) return;
    // Event coalescing gives native ACP frames precedence, not a polling loop.
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 60);
    this.timer.unref?.();
  }
  flush(): Promise<void> {
    return this.run(false);
  }
  private run(baseline: boolean): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.reading) {
      if (!baseline) this.again = true;
      return this.reading;
    }
    let first = baseline;
    this.reading = (async () => {
      do {
        this.again = false;
        const isBaseline = first;
        first = false;
        await this.arm();
        await this.read(isBaseline);
      } while (this.again && !this.closed);
    })().finally(() => { this.reading = undefined; });
    return this.reading;
  }
  private async read(baseline = false): Promise<void> {
    try {
      const s = await stat(this.file);
      if (this.inode !== s.ino || s.size < this.offset) {
        this.offset = 0; this.parsedBytes = 0; this.partial = ''; this.decoder = new StringDecoder('utf8');
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
          const rowByteEnd = this.parsedBytes + Buffer.byteLength(line, 'utf8') + 1;
          this.parsedBytes = rowByteEnd;
          let row: AgyTranscriptRow;
          try { row = JSON.parse(line) as AgyTranscriptRow; } catch { continue; }
          if (!Number.isSafeInteger(row.step_index) || row.step_index <= this.lastStep) continue;
          const allowRunningBackgroundTask = row.type === 'GENERIC'
            && row.status === 'RUNNING'
            && BACKGROUND_TASK_RUNNING_RE.test(row.content ?? '');
          if (row.status !== 'DONE' && !allowRunningBackgroundTask) continue;
          this.lastStep = row.step_index;
          if (!this.closed && !baseline) this.onRow(row, rowByteEnd);
        }
      }
      this.offset = end;
    } catch {
      // Missing during creation/rotation is retried only on a filesystem event
      // or explicit native boundary; no timer retry and no invented output.
    }
  }
  close(): void {
    this.closed = true; this.watcher?.close(); this.watcher = undefined; this.watched = undefined;
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
  }
}
