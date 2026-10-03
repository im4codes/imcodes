/**
 * Make a PARTIAL streamed Markdown text safe to render.
 *
 * A reply that is still arriving usually ends inside an inline span
 * ("**深夜的便", "`npm run"). Rendered as-is, the marker shows up literally and
 * turns into bold/code the moment its closer arrives: the bubble changes shape
 * mid-stream. Closing the dangling spans up front renders the same structure the
 * finished text will have, so only the text grows.
 *
 * Only the last paragraph can be open (a blank line ends inline spans), and an
 * open fenced code block is left alone: the Markdown parser already renders an
 * unterminated fence as a code block running to the end of the text.
 */
/**
 * A streaming block re-parses its Markdown at most this often (10 Hz), so a
 * chunk reaches the DOM within this interval, not synchronously. The one place
 * this is defined: ChatMarkdown throttles with it and the perf guard
 * (web/e2e/chat-timeline-scaling.perf.spec.ts) asserts text arrival against it.
 */
export const STREAMING_MARKDOWN_REFRESH_MS = 100;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function repairStreamingMarkdown(text: string): string {
  if (!text) return text;
  const lines = text.split('\n');
  let fence: string | null = null;
  let paragraphStart = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = FENCE.exec(line);
    if (fence === null) {
      if (match) { fence = match[1]![0]!; paragraphStart = index + 1; continue; }
      if (line.trim() === '') paragraphStart = index + 1;
    } else if (match && match[1]![0] === fence) {
      fence = null;
      paragraphStart = index + 1;
    }
  }
  if (fence !== null) return text;
  const paragraph = lines.slice(paragraphStart).join('\n');
  const open: string[] = [];
  let inCode = false;
  for (let i = 0; i < paragraph.length; i += 1) {
    const ch = paragraph[i]!;
    if (ch === '\\') { i += 1; continue; }
    if (ch === '`') {
      inCode = !inCode;
      if (inCode) open.push('`'); else open.pop();
      continue;
    }
    if (inCode) continue;
    const pair = ch + (paragraph[i + 1] ?? '');
    if (pair === '**' || pair === '~~') {
      if (open[open.length - 1] === pair) open.pop(); else open.push(pair);
      i += 1;
    }
  }
  if (open.length === 0) return text;
  // A marker with nothing after it yet ("... **") would close onto itself:
  // leave the trailing opener out instead of rendering an empty span.
  let base = text;
  const last = open[open.length - 1]!;
  if (base.endsWith(last)) { base = base.slice(0, -last.length); open.pop(); }
  return base + open.reverse().join('');
}
