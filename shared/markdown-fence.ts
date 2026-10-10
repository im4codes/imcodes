/**
 * Line-level Markdown fence tracking shared by every assistant-authored marker
 * scanner. Marker lines inside a fenced code block are examples, never protocol.
 */
export interface MarkdownFenceState {
  delimiter: '`' | '~';
  length: number;
}

const MARKDOWN_FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/**
 * Advance the fence state by one line. `fenced` is true when the line itself
 * is a fence delimiter or lies inside a fenced block, i.e. is not authored text.
 */
export function advanceMarkdownFence(
  line: string,
  fence: MarkdownFenceState | undefined,
): { fence: MarkdownFenceState | undefined; fenced: boolean } {
  const fenceMatch = line.match(MARKDOWN_FENCE_OPEN_RE)?.[1];
  if (fence) {
    const closes = fenceMatch?.[0] === fence.delimiter && fenceMatch.length >= fence.length;
    return { fence: closes ? undefined : fence, fenced: true };
  }
  if (fenceMatch) {
    return { fence: { delimiter: fenceMatch[0] as '`' | '~', length: fenceMatch.length }, fenced: true };
  }
  return { fence: undefined, fenced: false };
}
