export function selectionSignature(sel: Selection | null): string {
  if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
  return [
    nodeSignature(sel.anchorNode),
    sel.anchorOffset,
    nodeSignature(sel.focusNode),
    sel.focusOffset,
  ].join(':');
}

function nodeSignature(node: Node | null): string {
  if (!node) return 'null';
  const parent = node.parentNode;
  if (!parent) return node.nodeName;
  return `${node.nodeName}.${Array.prototype.indexOf.call(parent.childNodes, node)}`;
}
