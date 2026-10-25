/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import {
  captureSelectionOffsets,
  isDictationInputType,
  restoreSelectionOffsets,
} from '../src/dictation-test-input.js';

describe('Dictation event fixtures', () => {
  it('recognizes only explicit browser Dictation/replacement input types', () => {
    expect(isDictationInputType('insertFromDictation')).toBe(true);
    expect(isDictationInputType('insertReplacementText')).toBe(true);
    expect(isDictationInputType('insertCompositionText')).toBe(false);
    expect(isDictationInputType('insertText')).toBe(false);
    expect(isDictationInputType('insertFromPaste')).toBe(false);
    expect(isDictationInputType('unknown')).toBe(false);
  });

  it('captures and restores an existing contenteditable selection by text offset', () => {
    const root = document.createElement('div');
    root.contentEditable = 'true';
    root.textContent = 'old selection';
    document.body.append(root);
    const text = root.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 4);
    range.setEnd(text, 12);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const offsets = captureSelectionOffsets(root);
    root.textContent = 'old selection';
    restoreSelectionOffsets(root, offsets);
    expect(window.getSelection()?.anchorOffset).toBe(4);
    expect(window.getSelection()?.focusOffset).toBe(12);
    root.remove();
  });
});
