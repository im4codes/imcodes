/**
 * Calibrated caret hit-testing under whole-page CSS `zoom` (`html { zoom: z }`).
 *
 * On iOS WebKit / Safari / WKWebView, `Element.getBoundingClientRect()` and
 * `Range.getClientRects()` report pre-zoom CSS layout coordinates (`rectPerCss = 1`)
 * while `PointerEvent.clientX/Y` are viewport coordinates (`clientPerRect = cssZoom`),
 * causing native text hit-testing inside `contenteditable`, `<textarea>`, and `<input>`
 * to drift when `cssZoom !== 1`.
 *
 * Uses `resolveCssZoomMetrics` + `clientPointToRectSpace` so coordinate conversion works
 * identically across both WebKit (`clientPerRect = cssZoom`) and Chromium (`clientPerRect = 1`).
 */
import {
  clientPointToRectSpace,
  resolveCssZoomMetrics,
  type CssZoomMetrics,
} from './remote-desktop-coords.js';

const ZOOM_EPSILON = 0.0005;
const LINE_BAND_TOLERANCE_PX = 2;
const DRAG_SLOP_PX = 6;

const SUPPORTED_TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'url', 'email', 'tel']);

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function snapCodePointStart(text: string, idx: number): number {
  const clamped = Math.max(0, Math.min(idx, text.length));
  if (
    clamped > 0
    && clamped < text.length
    && isLowSurrogate(text.charCodeAt(clamped))
    && isHighSurrogate(text.charCodeAt(clamped - 1))
  ) {
    return clamped - 1;
  }
  return clamped;
}

function nextCodePointEnd(text: string, idx: number): number {
  if (idx >= text.length) return text.length;
  if (
    idx + 1 < text.length
    && isHighSurrogate(text.charCodeAt(idx))
    && isLowSurrogate(text.charCodeAt(idx + 1))
  ) {
    return idx + 2;
  }
  return idx + 1;
}

function verticalDistance(y: number, top: number, bottom: number): number {
  if (y < top) return top - y;
  if (y > bottom) return y - bottom;
  return 0;
}

function horizontalDistance(x: number, left: number, right: number): number {
  if (x < left) return left - x;
  if (x > right) return x - right;
  return 0;
}

function getValidRects(range: Range): DOMRect[] {
  if (typeof range.getClientRects !== 'function') return [];
  const raw = range.getClientRects();
  const out: DOMRect[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const r = raw[i];
    if (r && r.height > 0.5) out.push(r);
  }
  return out;
}

interface Band {
  top: number;
  bottom: number;
  dy: number;
}

interface TextCandidate {
  kind: 'text';
  node: Text;
  lineRects: DOMRect[];
}

interface BrCandidate {
  kind: 'br';
  element: Element;
  rect: DOMRect;
}

type EditableCandidate = TextCandidate | BrCandidate;

function collectEditableCandidates(root: HTMLElement, doc: Document): EditableCandidate[] {
  const out: EditableCandidate[] = [];
  const range = doc.createRange();

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const textNode = node as Text;
      if (textNode.data.length === 0) return;
      range.setStart(textNode, 0);
      range.setEnd(textNode, textNode.data.length);
      const rects = getValidRects(range);
      if (rects.length > 0) {
        out.push({ kind: 'text', node: textNode, lineRects: rects });
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el !== root) {
      if (el.getAttribute('contenteditable') === 'false' || el.dataset?.inlineVoiceRobot === 'true') {
        return;
      }
    }
    if (el.tagName === 'BR') {
      range.setStartBefore(el);
      range.setEndAfter(el);
      const rects = getValidRects(range);
      const fallback = rects[0] ?? el.getBoundingClientRect?.();
      if (fallback && fallback.height > 0.5) {
        out.push({ kind: 'br', element: el, rect: fallback });
      }
      return;
    }
    for (let i = 0; i < el.childNodes.length; i += 1) {
      walk(el.childNodes[i]);
    }
  };

  walk(root);
  return out;
}

function measureGlyphRect(range: Range, node: Text, start: number, end: number): DOMRect | null {
  range.setStart(node, start);
  range.setEnd(node, end);
  const rects = getValidRects(range);
  return rects[0] ?? null;
}

function findBestOffsetInTextNode(
  node: Text,
  ptX: number,
  ptY: number,
  targetBand: Band,
  range: Range,
): { offset: number; dx: number; dy: number } | null {
  const text = node.data;
  const len = text.length;
  if (len === 0) return null;

  let best: { offset: number; dx: number; dy: number } | null = null;
  const record = (offset: number, rect: DOMRect): void => {
    const dy = verticalDistance(ptY, rect.top, rect.bottom);
    const dx = horizontalDistance(ptX, rect.left, rect.right);
    if (
      !best
      || dy < best.dy - 0.5
      || (Math.abs(dy - best.dy) <= 0.5 && dx < best.dx)
    ) {
      best = { offset, dx, dy };
    }
  };

  let lo = 0;
  let hi = len;
  let guard = 0;
  while (lo < hi && guard++ < 64) {
    const midRaw = lo + ((hi - lo) >> 1);
    let start = snapCodePointStart(text, midRaw);
    if (start < lo) start = lo;
    let end = nextCodePointEnd(text, start);
    if (end > hi) end = hi;

    let rect = measureGlyphRect(range, node, start, end);
    // Defensively probe adjacent code point if browser returns empty rect for a boundary char.
    if (!rect && end < hi) {
      const nextEnd = nextCodePointEnd(text, end);
      const nextRect = measureGlyphRect(range, node, end, nextEnd);
      if (nextRect) {
        start = end;
        end = nextEnd;
        rect = nextRect;
      }
    }
    if (!rect) break;

    if (rect.bottom <= targetBand.top + 1) {
      if (end <= lo) break;
      lo = end;
      continue;
    }
    if (rect.top >= targetBand.bottom - 1) {
      if (start >= hi) break;
      hi = start;
      continue;
    }

    if (text[start] === '\n') {
      // A newline slot marks the end of its line (or start of an empty line):
      // never advance past `\n` onto the next visual line when clicking right of line text.
      record(start, rect);
      if (ptX < rect.left && start < hi) {
        hi = start;
      } else {
        if (end <= lo) break;
        lo = end;
      }
      continue;
    }

    const midX = (rect.left + rect.right) / 2;
    const chosenOffset = ptX < midX ? start : end;
    record(chosenOffset, rect);

    if (ptX < midX) {
      if (start >= hi) break;
      hi = start;
    } else {
      if (end <= lo) break;
      lo = end;
    }
  }

  // Final neighborhood refinement at the converged boundary in case of kerning/width rounding.
  const center = snapCodePointStart(text, Math.min(lo, len));
  let probe = center;
  for (let back = 0; back < 2 && probe > 0; back += 1) {
    probe = snapCodePointStart(text, probe - 1);
  }
  for (let step = 0; step < 4 && probe < len; step += 1) {
    const probeEnd = nextCodePointEnd(text, probe);
    const rect = measureGlyphRect(range, node, probe, probeEnd);
    if (rect && rect.bottom > targetBand.top + 1 && rect.top < targetBand.bottom - 1) {
      if (text[probe] === '\n') {
        record(probe, rect);
      } else {
        const midX = (rect.left + rect.right) / 2;
        record(ptX < midX ? probe : probeEnd, rect);
      }
    }
    probe = probeEnd;
  }

  return best;
}

/**
 * Resolve exact `(node, offset)` inside a `contenteditable` element for viewport `(clientX, clientY)`
 * under active CSS `zoom`, converting coordinates cleanly across WebKit and Chromium.
 * Returns `null` when zoom is `1` or layout rects are absent (e.g. jsdom).
 */
export function resolveContentEditableCaretAtPoint(
  root: HTMLElement | null,
  clientX: number,
  clientY: number,
  metrics?: CssZoomMetrics,
): { node: Node; offset: number } | null {
  if (!root || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const doc = root.ownerDocument;
  const win = doc?.defaultView;
  if (!doc || typeof doc.createRange !== 'function') return null;

  const resolvedMetrics = metrics ?? resolveCssZoomMetrics(doc, win ?? undefined, root);
  if (Math.abs(resolvedMetrics.cssZoom - 1) < ZOOM_EPSILON) return null;

  const rootRect = root.getBoundingClientRect?.();
  if (!rootRect || (rootRect.width <= 0 && rootRect.height <= 0)) return null;

  const pt = clientPointToRectSpace(clientX, clientY, resolvedMetrics);
  const candidates = collectEditableCandidates(root, doc);
  if (candidates.length === 0) return null;

  let minDy = Infinity;
  let bestBand: Band | null = null;
  for (const cand of candidates) {
    if (cand.kind === 'text') {
      for (const rect of cand.lineRects) {
        const dy = verticalDistance(pt.y, rect.top, rect.bottom);
        if (dy < minDy) {
          minDy = dy;
          bestBand = { top: rect.top, bottom: rect.bottom, dy };
        }
      }
    } else {
      const dy = verticalDistance(pt.y, cand.rect.top, cand.rect.bottom);
      if (dy < minDy) {
        minDy = dy;
        bestBand = { top: cand.rect.top, bottom: cand.rect.bottom, dy };
      }
    }
  }
  if (!bestBand) return null;

  const searchRange = doc.createRange();
  let bestChoice: { node: Node; offset: number; dx: number; dy: number; isBr: boolean } | null = null;

  for (const cand of candidates) {
    if (cand.kind === 'text') {
      const overlapsBand = cand.lineRects.some((rect) => (
        verticalDistance(pt.y, rect.top, rect.bottom) <= minDy + LINE_BAND_TOLERANCE_PX
      ));
      if (!overlapsBand) continue;
      const hit = findBestOffsetInTextNode(cand.node, pt.x, pt.y, bestBand, searchRange);
      if (!hit) continue;
      if (
        !bestChoice
        || hit.dy < bestChoice.dy - 0.5
        || (Math.abs(hit.dy - bestChoice.dy) <= 0.5 && (
          hit.dx < bestChoice.dx - 0.25
          || (Math.abs(hit.dx - bestChoice.dx) <= 0.25 && bestChoice.isBr)
        ))
      ) {
        bestChoice = { node: cand.node, offset: hit.offset, dx: hit.dx, dy: hit.dy, isBr: false };
      }
    } else {
      const dy = verticalDistance(pt.y, cand.rect.top, cand.rect.bottom);
      if (dy > minDy + LINE_BAND_TOLERANCE_PX) continue;
      const parent = cand.element.parentNode;
      if (!parent) continue;
      const childIndex = Array.prototype.indexOf.call(parent.childNodes, cand.element);
      if (childIndex < 0) continue;
      const dx = horizontalDistance(pt.x, cand.rect.left, cand.rect.right);
      if (
        !bestChoice
        || dy < bestChoice.dy - 0.5
        || (Math.abs(dy - bestChoice.dy) <= 0.5 && dx < bestChoice.dx - 0.25)
      ) {
        bestChoice = { node: parent, offset: childIndex, dx, dy, isBr: true };
      }
    }
  }

  return bestChoice ? { node: bestChoice.node, offset: bestChoice.offset } : null;
}

/**
 * Apply a pre-resolved `{ node, offset }` collapsed caret inside `root`, verifying
 * `node` is still contained in `root` and any active selection is collapsed.
 * Safe when layout shifts between pre-focus hit-testing and post-focus selection placement.
 */
export function applyContentEditableCaretTarget(
  root: HTMLElement | null,
  target: { node: Node; offset: number } | null,
): boolean {
  if (!root || !target || !target.node || !root.contains(target.node)) return false;
  const doc = root.ownerDocument;
  const win = doc?.defaultView;
  if (!doc || !win || typeof win.getSelection !== 'function' || typeof doc.createRange !== 'function') {
    return false;
  }
  const sel = win.getSelection();
  if (!sel || (sel.rangeCount > 0 && !sel.isCollapsed)) return false;

  const clampedOffset = target.node.nodeType === Node.TEXT_NODE
    ? snapCodePointStart((target.node as Text).data, target.offset)
    : Math.max(0, Math.min(target.offset, target.node.childNodes.length));

  try {
    const range = doc.createRange();
    range.setStart(target.node, clampedOffset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  } catch {
    return false;
  }
}

/**
 * Place the collapsed caret inside `root` (`contenteditable="true"`) from viewport `(clientX, clientY)`
 * when CSS zoom is active. Returns `true` if a calibrated caret range was applied.
 */
export function placeContentEditableCaretAtPoint(
  root: HTMLElement | null,
  clientX: number,
  clientY: number,
  metrics?: CssZoomMetrics,
): boolean {
  if (!root) return false;
  const doc = root.ownerDocument;
  const win = doc?.defaultView;
  if (!win || typeof win.getSelection !== 'function') return false;
  const sel = win.getSelection();
  if (!sel || (sel.rangeCount > 0 && !sel.isCollapsed)) return false;

  const target = resolveContentEditableCaretAtPoint(root, clientX, clientY, metrics);
  return applyContentEditableCaretTarget(root, target);
}

let cachedMirrorEl: HTMLDivElement | null = null;

function getOrCreateMirror(doc: Document): HTMLDivElement | null {
  if (!doc.body) return null;
  if (cachedMirrorEl && cachedMirrorEl.ownerDocument === doc && cachedMirrorEl.isConnected) {
    return cachedMirrorEl;
  }
  const el = doc.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  el.style.position = 'fixed';
  el.style.left = '0px';
  el.style.top = '0px';
  el.style.visibility = 'hidden';
  el.style.pointerEvents = 'none';
  el.style.zIndex = '-1';
  doc.body.appendChild(el);
  cachedMirrorEl = el;
  return el;
}

const MIRRORED_STYLE_PROPS = [
  'boxSizing',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontVariant',
  'letterSpacing',
  'wordSpacing',
  'lineHeight',
  'textTransform',
  'textIndent',
  'textAlign',
  'direction',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'wordBreak',
  'overflowWrap',
  'tabSize',
] as const;

export function isZoomCaretTargetInput(el: EventTarget | null): el is HTMLTextAreaElement | HTMLInputElement {
  if (!el || typeof el !== 'object') return false;
  const node = el as HTMLElement;
  if (node.tagName === 'TEXTAREA') {
    return !(node as HTMLTextAreaElement).disabled;
  }
  if (node.tagName === 'INPUT') {
    const input = node as HTMLInputElement;
    if (input.disabled) return false;
    return SUPPORTED_TEXT_INPUT_TYPES.has((input.type || '').toLowerCase());
  }
  return false;
}

/**
 * Resolve exact character offset inside `<textarea>` or text `<input>` for viewport `(clientX, clientY)`
 * when WebKit's unzoomed-rect CSS-zoom mismatch (`!metrics.rectIsZoomed && metrics.cssZoom !== 1`) is active.
 */
export function resolveTextInputCaretAtPoint(
  input: HTMLTextAreaElement | HTMLInputElement,
  clientX: number,
  clientY: number,
  metrics?: CssZoomMetrics,
): number | null {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY) || input.value.length === 0) return null;
  const doc = input.ownerDocument;
  const win = doc?.defaultView;
  if (!doc || !win || typeof win.getComputedStyle !== 'function') return null;

  const resolvedMetrics = metrics ?? resolveCssZoomMetrics(doc, win, input);
  if (Math.abs(resolvedMetrics.cssZoom - 1) < ZOOM_EPSILON || resolvedMetrics.rectIsZoomed) {
    return null;
  }

  const inputRect = input.getBoundingClientRect?.();
  if (!inputRect || (inputRect.width <= 0 && inputRect.height <= 0)) return null;

  const mirror = getOrCreateMirror(doc);
  if (!mirror) return null;

  const cs = win.getComputedStyle(input);
  for (const prop of MIRRORED_STYLE_PROPS) {
    (mirror.style as unknown as Record<string, string>)[prop] = cs[prop];
  }
  mirror.style.borderStyle = 'solid';
  mirror.style.borderColor = 'transparent';
  mirror.style.width = `${input.offsetWidth || input.clientWidth}px`;
  mirror.style.height = `${input.offsetHeight || input.clientHeight}px`;
  mirror.style.overflow = 'hidden';
  mirror.style.whiteSpace = input.tagName === 'TEXTAREA' ? 'pre-wrap' : 'pre';

  const textNode = doc.createTextNode(input.value);
  mirror.replaceChildren(textNode);

  try {
    const mirrorRect = mirror.getBoundingClientRect();
    if (mirrorRect.width <= 0 && mirrorRect.height <= 0) return null;
    const pt = clientPointToRectSpace(clientX, clientY, resolvedMetrics);
    const localX = mirrorRect.left + (pt.x - inputRect.left) + (input.scrollLeft || 0) * resolvedMetrics.rectPerCss;
    const localY = mirrorRect.top + (pt.y - inputRect.top) + (input.scrollTop || 0) * resolvedMetrics.rectPerCss;

    const range = doc.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, textNode.data.length);
    const lineRects = getValidRects(range);
    if (lineRects.length === 0) return null;

    let bestBand: Band | null = null;
    for (const rect of lineRects) {
      const dy = verticalDistance(localY, rect.top, rect.bottom);
      if (!bestBand || dy < bestBand.dy) {
        bestBand = { top: rect.top, bottom: rect.bottom, dy };
      }
    }
    if (!bestBand) return null;

    const hit = findBestOffsetInTextNode(textNode, localX, localY, bestBand, range);
    return hit ? hit.offset : null;
  } finally {
    mirror.replaceChildren();
  }
}

const installedDocuments = new WeakSet<Document>();

/**
 * Install an idempotent document-level click fix for `<textarea>` and text `<input>` controls
 * on WebKit/Safari under active CSS zoom (`!metrics.rectIsZoomed && metrics.cssZoom !== 1`).
 * Safe no-op on Chromium and at 100% zoom.
 */
export function installGlobalZoomedInputCaretFix(
  doc: Document | undefined = typeof document !== 'undefined' ? document : undefined,
): () => void {
  if (!doc || installedDocuments.has(doc)) return () => {};
  installedDocuments.add(doc);

  let downTarget: EventTarget | null = null;
  let downX = 0;
  let downY = 0;
  let dragMoved = false;
  const composingInputs = new WeakSet<EventTarget>();

  const onCompositionStart = (event: CompositionEvent) => {
    if (isZoomCaretTargetInput(event.target)) {
      composingInputs.add(event.target);
    }
  };

  const onCompositionEnd = (event: Event) => {
    if (event.target) {
      composingInputs.delete(event.target);
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== undefined && event.button !== 0) {
      downTarget = null;
      return;
    }
    downTarget = event.target;
    downX = event.clientX;
    downY = event.clientY;
    dragMoved = false;
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!downTarget || dragMoved) return;
    if (Math.hypot(event.clientX - downX, event.clientY - downY) > DRAG_SLOP_PX) {
      dragMoved = true;
    }
  };

  const onClick = (event: MouseEvent) => {
    const moved = dragMoved;
    const sameTarget = downTarget === event.target;
    downTarget = null;
    dragMoved = false;

    if (moved || event.shiftKey || event.detail > 1) return;
    if (event.clientX === 0 && event.clientY === 0 && event.detail === 0 && !sameTarget) return;
    if (!isZoomCaretTargetInput(event.target)) return;
    if (composingInputs.has(event.target)) return;

    const input = event.target;
    if (input.selectionStart !== null && input.selectionEnd !== null && input.selectionStart !== input.selectionEnd) {
      return;
    }

    const offset = resolveTextInputCaretAtPoint(input, event.clientX, event.clientY);
    if (offset === null) return;
    try {
      input.setSelectionRange(offset, offset);
    } catch {
      /* ignore inputs whose type doesn't support selection range */
    }
  };

  doc.addEventListener('compositionstart', onCompositionStart, true);
  doc.addEventListener('compositionend', onCompositionEnd, true);
  doc.addEventListener('blur', onCompositionEnd, true);
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('pointermove', onPointerMove, true);
  doc.addEventListener('click', onClick, true);

  return () => {
    installedDocuments.delete(doc);
    doc.removeEventListener('compositionstart', onCompositionStart, true);
    doc.removeEventListener('compositionend', onCompositionEnd, true);
    doc.removeEventListener('blur', onCompositionEnd, true);
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('pointermove', onPointerMove, true);
    doc.removeEventListener('click', onClick, true);
  };
}
