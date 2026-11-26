// Some third-party "Anthropic-compatible" reasoning models (e.g. MiniMax-M3)
// leak their chain-of-thought into the assistant TEXT as `<think>…</think>`,
// because the compatibility shim doesn't map it to a real thinking block. Real
// Claude never does this — it emits reasoning as separate thinking blocks — so
// stripping only ever affects third-party endpoints and is gated to them.
//
// Safe on PARTIAL (streaming) text: callers emit the full accumulated text each
// frame, so re-running this per frame is correct — a complete `<think>…</think>`
// block is removed, an unclosed block still mid-stream is suppressed from the
// open tag onward, and a trailing forming tag (`<t`, `<th`, … `<think`) is
// hidden until it resolves. When `</think>` finally arrives the whole block is a
// complete match and everything after it renders.

const COMPLETE_THINK = /<think>[\s\S]*?<\/think>/gi;
// A trailing partial open tag at end-of-buffer: `<t`, `<th`, `<thi`, `<thin`, `<think`
// (a lone `<` is intentionally NOT matched, so legit trailing `<` isn't hidden).
const TRAILING_FORMING_OPEN = /<t(?:h(?:i(?:n(?:k)?)?)?)?$/i;

export function stripLeakedThink(text: string): string {
  if (!text || text.indexOf('<') === -1) return text; // fast path: no tag possible
  let out = text.replace(COMPLETE_THINK, '');
  // An unclosed `<think>` (block still streaming) — drop from it to the end.
  const open = out.toLowerCase().lastIndexOf('<think>');
  if (open !== -1) out = out.slice(0, open);
  // A trailing forming open tag split across frames.
  out = out.replace(TRAILING_FORMING_OPEN, '');
  return out;
}
