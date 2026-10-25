export const DICTATION_INPUT_TYPES = new Set([
  'insertFromDictation',
  'insertReplacementText',
]);

export function isDictationInputType(inputType: string | null | undefined): boolean {
  return !!inputType && DICTATION_INPUT_TYPES.has(inputType);
}

export interface SelectionOffsets {
  start: number;
  end: number;
}

function pointOffset(root: Node, node: Node, offset: number): number {
  let total = 0;
  let found = false;
  const walk = (current: Node): void => {
    if (found) return;
    if (current === node) {
      found = true;
      if (current.nodeType === Node.TEXT_NODE) {
        total += offset;
      } else {
        const children = Array.from(current.childNodes);
        for (let i = 0; i < Math.min(offset, children.length); i++) {
          total += children[i].textContent?.length ?? 0;
        }
      }
      return;
    }
    current.childNodes.forEach((child) => {
      if (!found) {
        walk(child);
        if (!found) total += child.textContent?.length ?? 0;
      }
    });
  };
  walk(root);
  return total;
}

export function captureSelectionOffsets(root: HTMLElement): SelectionOffsets | null {
  if (typeof window === 'undefined') return null;
  const selection = window.getSelection();
  if (!selection || typeof selection.getRangeAt !== 'function' || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  return {
    start: pointOffset(root, range.startContainer, range.startOffset),
    end: pointOffset(root, range.endContainer, range.endOffset),
  };
}

function findPoint(root: Node, target: number): { node: Node; offset: number } {
  let remaining = Math.max(0, target);
  let lastText: Node = root;
  const walk = (current: Node): { node: Node; offset: number } | null => {
    if (current.nodeType === Node.TEXT_NODE) {
      lastText = current;
      const length = current.textContent?.length ?? 0;
      if (remaining <= length) return { node: current, offset: remaining };
      remaining -= length;
      return null;
    }
    for (const child of Array.from(current.childNodes)) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(root) ?? { node: lastText, offset: lastText.textContent?.length ?? 0 };
}

export function restoreSelectionOffsets(root: HTMLElement, offsets: SelectionOffsets | null): void {
  if (!offsets || typeof window === 'undefined' || typeof document === 'undefined') return;
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  const start = findPoint(root, offsets.start);
  const end = findPoint(root, offsets.end);
  range.setStart(start.node, Math.min(start.offset, start.node.textContent?.length ?? start.offset));
  range.setEnd(end.node, Math.min(end.offset, end.node.textContent?.length ?? end.offset));
  selection.removeAllRanges();
  selection.addRange(range);
}
