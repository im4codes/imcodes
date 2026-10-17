import { describe, expect, it } from 'vitest';
import { TOOL_COLLAPSED_PREVIEW_MAX_CHARS, toolFoldDisplayText } from '../src/chat-render-limits.js';

describe('collapsed tool rendering bound', () => {
  it('leaves empty, short and exact-boundary text unchanged', () => {
    for (const text of ['', 'ok\n完整原文', 'x'.repeat(TOOL_COLLAPSED_PREVIEW_MAX_CHARS)]) expect(toolFoldDisplayText(text, false)).toBe(text);
    expect(toolFoldDisplayText(null, false)).toBe('');
    expect(toolFoldDisplayText(undefined, false)).toBe('');
  });
  it('marks only the preview as shortened and preserves full expanded text', () => {
    const text = 'x'.repeat(300000) + 'TAIL';
    expect(toolFoldDisplayText(text, false)).toBe('x'.repeat(TOOL_COLLAPSED_PREVIEW_MAX_CHARS) + '…');
    expect(toolFoldDisplayText(text, true)).toBe(text);
  });
  it('does not split a Unicode surrogate pair', () => {
    const text = 'x'.repeat(TOOL_COLLAPSED_PREVIEW_MAX_CHARS - 1) + '😀tail';
    expect(toolFoldDisplayText(text, false)).toBe('x'.repeat(TOOL_COLLAPSED_PREVIEW_MAX_CHARS - 1) + '…');
    expect(toolFoldDisplayText(text, true)).toBe(text);
  });
});
