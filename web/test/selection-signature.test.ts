/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { selectionSignature } from '../src/util/selection-signature.js';

function selectRange(node: Text, start: number, end: number): Selection | null {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return selection;
}

describe('selectionSignature', () => {
  it('stays stable for unchanged selections and changes when offsets move', () => {
    const root = document.createElement('div');
    root.textContent = 'hello world';
    document.body.appendChild(root);
    const node = root.firstChild as Text;

    const first = selectionSignature(selectRange(node, 0, 5));
    const same = selectionSignature(selectRange(node, 0, 5));
    const moved = selectionSignature(selectRange(node, 0, 7));

    expect(first).toBeTruthy();
    expect(same).toBe(first);
    expect(moved).not.toBe(first);
  });
});
