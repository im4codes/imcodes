/**
 * Shared streaming-response classifier for Local Web Preview (run 8a975732-23a
 * A2/A3/D4/D5).
 *
 * SINGLE SOURCE OF TRUTH used by BOTH the daemon (`src/daemon/preview-relay.ts`)
 * and the server (`server/src/ws/bridge.ts`) so the byte-cap-exemption decision
 * can never diverge between the two sides (CLAUDE.md: no copy across daemon/
 * server). The decision MUST be made ONCE at `RESPONSE_START` (when response
 * headers are known). A streaming response is EXEMPT from the cumulative
 * `MAX_RESPONSE_BYTES` cap and is instead bounded by stream-idle timeout + the
 * server-side unconsumed-buffer high-watermark (`MAX_PREVIEW_STREAM_BUFFER_BYTES`).
 *
 * Predicate (A3): a response is streaming iff it is NOT HTML AND one of:
 *   - content-type is `text/event-stream` (SSE), OR
 *   - content-type is `application/x-ndjson`, OR
 *   - it is chunked (`Transfer-Encoding: chunked`) AND content-type is NOT JSON.
 *
 * MIME (`text/event-stream` / `application/x-ndjson`) is INDEPENDENTLY
 * sufficient. The absence of `Content-Length` is NOT sufficient on its own
 * (it must be chunked AND non-JSON) — otherwise an ordinary dynamic JSON/text
 * response that simply omits `Content-Length` would wrongly bypass the byte cap.
 */

/** Response headers as carried on PREVIEW_MSG.RESPONSE_START (`Record<string, string | string[]>`). */
export type PreviewResponseHeaders = Record<string, string | string[]>;

/** Case-insensitive first-value header lookup over a string|string[] header map. */
function headerValue(headers: PreviewResponseHeaders, name: string): string {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      const v = headers[key];
      const raw = Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
      return raw;
    }
  }
  return '';
}

/** Lowercased media type with parameters stripped (e.g. "text/event-stream; charset=utf-8" -> "text/event-stream"). */
export function contentTypeOf(headers: PreviewResponseHeaders): string {
  const ct = headerValue(headers, 'content-type');
  const semi = ct.indexOf(';');
  return (semi === -1 ? ct : ct.slice(0, semi)).trim().toLowerCase();
}

/** HTML responses are never treated as streaming (they go through buffered HTML rewrite — see A20). */
export function isHtmlContentType(ct: string): boolean {
  return ct === 'text/html' || ct === 'application/xhtml+xml';
}

/** JSON (incl. `application/*+json`) is excluded from the chunked-streaming branch (A3). */
export function isJsonContentType(ct: string): boolean {
  return ct === 'application/json' || ct.endsWith('+json');
}

function isChunkedTransfer(headers: PreviewResponseHeaders): boolean {
  const te = headerValue(headers, 'transfer-encoding').toLowerCase();
  if (!te) return false;
  return te.split(',').some((token) => token.trim() === 'chunked');
}

/**
 * Decide (at RESPONSE_START) whether a preview response is a long-lived stream
 * that must be exempt from the cumulative byte cap. See the file header for the
 * exact predicate. Pure and side-effect free; identical result on daemon + server.
 */
export function isStreamingResponse(headers: PreviewResponseHeaders): boolean {
  const ct = contentTypeOf(headers);
  if (isHtmlContentType(ct)) return false;
  if (ct === 'text/event-stream' || ct === 'application/x-ndjson') return true;
  if (isChunkedTransfer(headers) && !isJsonContentType(ct)) return true;
  return false;
}
