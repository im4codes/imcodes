import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { countTokensFallback } from '../context/tokenizer.js';

/** Per-native-conversation, read-only incremental transcript cursor. Ordinary
 * sends stat once and read no old bytes. Only completed USER_INPUT summaries
 * count: an assistant quoting a summary is NOT a compaction notification. */
export class AgyCompactionWatermark {
  private file?: string;
  private inode?: number;
  private offset = 0;
  private mtime = 0;
  private partial = '';
  private decoder = new StringDecoder('utf8');
  private marker?: string;
  private checking?: Promise<boolean>;
  summaryTokens = 0;

  check(home: string | undefined, conversationId: string | undefined): Promise<boolean> {
    if (!home || !path.isAbsolute(home) || !conversationId || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(conversationId)) return Promise.resolve(false);
    const file = path.join(home, '.gemini', 'antigravity-cli', 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl');
    // One cursor per captured provider owner; concurrent sends share this read.
    return this.checking ??= this.read(file).finally(() => { this.checking = undefined; });
  }

  private async read(file: string): Promise<boolean> {
    try {
      const info = await stat(file);
      if (this.file === file && this.inode === info.ino && this.offset === info.size && this.mtime === info.mtimeMs) return false;
      const reset = this.file !== file || this.inode !== info.ino || info.size < this.offset
        || (info.size === this.offset && this.mtime !== info.mtimeMs);
      let partial = reset ? '' : this.partial;
      let latest = this.marker;
      let summaryTokens = this.summaryTokens;
      const start = reset ? 0 : this.offset;
      if (reset) this.decoder = new StringDecoder('utf8');
      const consume = (text: string) => {
        partial += text;
        let newline: number;
        while ((newline = partial.indexOf('\n')) >= 0) {
          const line = partial.slice(0, newline);
          partial = partial.slice(newline + 1);
          try {
            const row = JSON.parse(line);
            if (row.status !== 'DONE' || !Number.isSafeInteger(row.step_index) || typeof row.created_at !== 'string'
              || typeof row.content !== 'string') continue;
            const summary = row.type === 'USER_INPUT' && row.source === 'USER_EXPLICIT'
              && row.content.trimStart().startsWith('<CONTEXT_SUMMARY>');
            // AG 1.5.6 /compact uses a native SYSTEM checkpoint, verified on
            // a real isolated login. Older automatic compaction uses USER_INPUT.
            const checkpoint = row.type === 'CHECKPOINT' && row.source === 'SYSTEM'
              && row.content.trimStart().startsWith('# Resuming from a compaction');
            if (!summary && !checkpoint) continue;
            latest = JSON.stringify([row.step_index, row.created_at]);
            summaryTokens = countTokensFallback(row.content);
          } catch { /* A diagnostic/non-JSON line is not a summary. */ }
        }
      };
      if (info.size > start) {
        for await (const chunk of createReadStream(file, { start, end: info.size - 1, highWaterMark: 64 * 1024 })) consume(this.decoder.write(chunk as Buffer));
      }
      const changed = latest !== undefined && latest !== this.marker;
      this.file = file; this.inode = info.ino; this.offset = info.size; this.mtime = info.mtimeMs;
      this.partial = partial; this.marker = latest; this.summaryTokens = summaryTokens;
      return changed;
    } catch {
      // Missing/not-yet-created transcript or transient rotation: no invented
      // compaction, and do not advance the cursor so the next send can retry.
      this.file = undefined; // A failed read may have advanced the UTF-8 decoder; rescan on retry.
      return false;
    }
  }
}
