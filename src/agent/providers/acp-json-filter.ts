/**
 * ACP stdout JSON-line filter.
 *
 * `@agentclientprotocol/sdk`'s `ndJsonStream` reader does `JSON.parse(line)` on
 * every newline-delimited line coming off the agent's stdout and, on failure,
 * calls `console.error("Failed to parse JSON message:", line, err)` — it does
 * NOT throw, so we cannot try/catch it at our boundary. A chatty ACP CLI that
 * prints non-JSON to stdout (e.g. Gemini CLI's "Skipping project agents due to
 * untrusted folder." notice, deprecation banners, progress text) therefore
 * floods the daemon log and burns main-thread CPU on a hot parse-fail loop —
 * which on a busy daemon starves the event loop enough to trip the server-link
 * silent-connection watchdog.
 *
 * This interposes a line-buffering transform between the child's Node stdout and
 * the SDK's `ndJsonStream`: only lines that look like a JSON object/array reach
 * the parser; everything else is dropped (with throttled visibility via
 * `onDrop`). A misbehaving agent can no longer spam or wedge the stream.
 */
import { Transform, type Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/** True when a trimmed line begins like a JSON object/array — the only shapes
 *  the ACP ndjson protocol ever emits. */
function looksLikeJsonLine(trimmed: string): boolean {
  const first = trimmed.charCodeAt(0);
  return first === 0x7b /* { */ || first === 0x5b /* [ */;
}

/**
 * Pipe `source` (an ACP child's stdout) through a non-JSON line filter and
 * return the filtered Node `Readable` to hand to `Readable.toWeb(...)`.
 *
 * - Blank lines pass through untouched (the ndjson reader ignores them).
 * - Lines starting with `{` or `[` pass through (candidate JSON messages).
 * - Anything else is dropped; `onDrop` is invoked with the offending line and
 *   the running drop count so callers can log it at debug with throttling.
 *
 * UTF-8 is decoded with `StringDecoder` so multi-byte characters split across
 * chunk boundaries are never corrupted.
 */
export function filterAcpJsonLines(
  source: Readable,
  onDrop?: (line: string, totalDropped: number) => void,
): Readable {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let dropped = 0;

  const handleLine = (transform: Transform, line: string): void => {
    const trimmed = line.trim();
    if (!trimmed || looksLikeJsonLine(trimmed)) {
      transform.push(line);
      return;
    }
    dropped += 1;
    try {
      onDrop?.(trimmed, dropped);
    } catch {
      /* never let logging throw back into the stream */
    }
  };

  const filter = new Transform({
    transform(chunk, _enc, cb) {
      buffer += decoder.write(chunk as Buffer);
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl + 1);
        buffer = buffer.slice(nl + 1);
        handleLine(this, line);
      }
      cb();
    },
    flush(cb) {
      buffer += decoder.end();
      if (buffer) handleLine(this, buffer);
      buffer = '';
      cb();
    },
  });

  // Propagate source failure so the ACP connection tears down rather than hang.
  source.on('error', (err) => filter.destroy(err));
  source.pipe(filter);
  return filter;
}
