import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installGlobalZoomedInputCaretFix,
  isZoomCaretTargetInput,
  placeContentEditableCaretAtPoint,
  resolveContentEditableCaretAtPoint,
  resolveTextInputCaretAtPoint,
} from '../src/zoom-caret.js';
import { applyUiScale } from '../src/ui-scale.js';

function makeRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * Install deterministic Range.getClientRects geometry for a `Text` node in jsdom,
 * scaling rects cleanly by `rectScale` (`1` on iOS WebKit, `zoom` on Chromium).
 */
function mockTextNodeRangeGeometry(
  root: HTMLElement,
  textNode: Text,
  options: {
    originLeft: number;
    originTop: number;
    lineHeight: number;
    lineGap?: number;
    charWidth?: number;
    rectScale: number;
  },
): () => void {
  const { originLeft, originTop, lineHeight, lineGap = 4, charWidth = 10, rectScale } = options;
  const text = textNode.data;
  const origCreateRange = document.createRange.bind(document);

  // Split text into lines using `\n`
  const lineRanges: Array<{ start: number; end: number; lineIdx: number }> = [];
  let lineStart = 0;
  let lineIdx = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      lineRanges.push({ start: lineStart, end: i, lineIdx });
      lineStart = i + 1;
      lineIdx += 1;
    }
  }
  lineRanges.push({ start: lineStart, end: text.length, lineIdx });

  const charRectAt = (idx: number): DOMRect => {
    let targetLine = lineRanges[lineRanges.length - 1];
    for (const lr of lineRanges) {
      if (idx <= lr.end) {
        targetLine = lr;
        break;
      }
    }
    const col = idx - targetLine.start;
    const isNewline = text[idx] === '\n';
    const x = originLeft + col * charWidth;
    const y = originTop + targetLine.lineIdx * (lineHeight + lineGap);
    const w = isNewline ? 0 : charWidth;
    return makeRect(x * rectScale, y * rectScale, w * rectScale, lineHeight * rectScale);
  };

  root.getBoundingClientRect = () => makeRect(
    (originLeft - 11) * rectScale,
    (originTop - 7) * rectScale,
    300 * rectScale,
    100 * rectScale,
  );

  const spy = vi.spyOn(document, 'createRange').mockImplementation(() => {
    const r = origCreateRange();
    r.getClientRects = (() => {
      if (r.startContainer === textNode && r.endContainer === textNode) {
        const s = r.startOffset;
        const e = r.endOffset;
        if (s === 0 && e === text.length) {
          return lineRanges.map((lr) => {
            const cols = Math.max(0, lr.end - lr.start);
            const y = originTop + lr.lineIdx * (lineHeight + lineGap);
            return makeRect(
              originLeft * rectScale,
              y * rectScale,
              cols * charWidth * rectScale,
              lineHeight * rectScale,
            );
          }) as unknown as DOMRectList;
        }
        if (e > s) {
          return [charRectAt(s)] as unknown as DOMRectList;
        }
      }
      if (r.startContainer.nodeType === Node.ELEMENT_NODE) {
        const el = r.startContainer as HTMLElement;
        const br = el.childNodes[r.startOffset];
        if (br && (br as HTMLElement).tagName === 'BR') {
          const rect = (br as HTMLElement).getBoundingClientRect();
          return (rect.height > 0 ? [rect] : []) as unknown as DOMRectList;
        }
      }
      return [] as unknown as DOMRectList;
    }) as unknown as () => DOMRectList;
    return r;
  });

  return () => spy.mockRestore();
}

describe('zoom-caret calibrated hit-testing', () => {
  afterEach(() => {
    applyUiScale(100);
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('returns null fast-path when UI zoom is 100%', () => {
    applyUiScale(100);
    const el = document.createElement('div');
    el.contentEditable = 'true';
    el.textContent = 'hello';
    document.body.appendChild(el);
    expect(resolveContentEditableCaretAtPoint(el, 20, 20)).toBeNull();
    expect(placeContentEditableCaretAtPoint(el, 20, 20)).toBe(false);
  });

  it('places caret accurately under BOTH iOS WebKit (rectPerCss=1) and Chromium (rectPerCss=zoom) coordinate models across scales', () => {
    const line1 = 'hello world';
    const line2 = '测试中文 😀 emoji';
    const content = `${line1}\n\n${line2}`;

    for (const model of ['webkit', 'chromium'] as const) {
      for (const pct of [60, 75, 85, 125, 150]) {
        const zoom = pct / 100;
        applyUiScale(pct);

        const el = document.createElement('div');
        el.contentEditable = 'true';
        const tn = document.createTextNode(content);
        el.appendChild(tn);
        document.body.appendChild(el);

        const rectScale = model === 'webkit' ? 1 : zoom;
        const restore = mockTextNodeRangeGeometry(el, tn, {
          originLeft: 20,
          originTop: 100,
          lineHeight: 20,
          lineGap: 4,
          charWidth: 10,
          rectScale,
        });

        const metrics = {
          cssZoom: zoom,
          rectIsZoomed: model === 'chromium',
          clientPerRect: model === 'webkit' ? zoom : 1,
          rectPerCss: rectScale,
        };

        // Click line 1 character index 4 ('o', left edge at unzoomed x=60, mid=65 -> viewport = x * zoom)
        const tap1 = resolveContentEditableCaretAtPoint(el, 62 * zoom, 110 * zoom, metrics);
        expect(tap1).toEqual({ node: tn, offset: 4 });

        // Click past right edge of short line 1 -> stays at newline offset 11 (end of line 1, NOT line 2)
        const tapEndLine1 = resolveContentEditableCaretAtPoint(el, 250 * zoom, 110 * zoom, metrics);
        expect(tapEndLine1).toEqual({ node: tn, offset: line1.length });

        // Click empty line 2 (index 12, second '\n' at y=124..144)
        const tapEmptyLine2 = resolveContentEditableCaretAtPoint(el, 150 * zoom, 132 * zoom, metrics);
        expect(tapEmptyLine2).toEqual({ node: tn, offset: line1.length + 1 });

        // Click line 3 before/after surrogate pair emoji 😀 (at col 5..6 in line 3 -> offset line1.length + 2 + 5)
        const line3Base = line1.length + 2;
        // '测'(0) '试'(1) '中'(2) '文'(3) ' '(4) '😀'(5..6, surrogate pair spans offsets 5..7)
        const emojiStartOffset = line3Base + 5;
        const tapEmojiLeft = resolveContentEditableCaretAtPoint(
          el,
          (20 + 5 * 10 + 2) * zoom,
          (100 + 2 * 24 + 10) * zoom,
          metrics,
        );
        expect(tapEmojiLeft).toEqual({ node: tn, offset: emojiStartOffset });

        const tapEmojiRight = resolveContentEditableCaretAtPoint(
          el,
          (20 + 5 * 10 + 8) * zoom,
          (100 + 2 * 24 + 10) * zoom,
          metrics,
        );
        // Never splits the surrogate pair (must jump to +2 = emojiStartOffset + 2)
        expect(tapEmojiRight).toEqual({ node: tn, offset: emojiStartOffset + 2 });

        // placeContentEditableCaretAtPoint applies selection cleanly when collapsed
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        const applied = placeContentEditableCaretAtPoint(el, 62 * zoom, 110 * zoom, metrics);
        expect(applied).toBe(true);
        expect(sel.isCollapsed).toBe(true);
        expect(sel.anchorNode).toBe(tn);
        expect(sel.anchorOffset).toBe(4);

        restore();
        el.remove();
      }
    }
  });

  it('preserves non-collapsed drag selections and skips contenteditable=false nodes', () => {
    applyUiScale(125);
    const el = document.createElement('div');
    el.contentEditable = 'true';
    const robot = document.createElement('span');
    robot.setAttribute('contenteditable', 'false');
    robot.dataset.inlineVoiceRobot = 'true';
    robot.textContent = 'ROBOT';
    const tn = document.createTextNode('abcdef');
    el.append(tn, robot);
    document.body.appendChild(el);

    const restore = mockTextNodeRangeGeometry(el, tn, {
      originLeft: 20,
      originTop: 100,
      lineHeight: 20,
      charWidth: 10,
      rectScale: 1,
    });

    // Non-collapsed selection MUST NOT be collapsed or overwritten
    const sel = window.getSelection()!;
    const dragRange = document.createRange();
    dragRange.setStart(tn, 1);
    dragRange.setEnd(tn, 4);
    sel.removeAllRanges();
    sel.addRange(dragRange);
    const applied = placeContentEditableCaretAtPoint(el, 25 * 1.25, 110 * 1.25, {
      cssZoom: 1.25,
      rectIsZoomed: false,
      clientPerRect: 1.25,
      rectPerCss: 1,
    });
    expect(applied).toBe(false);
    expect(sel.isCollapsed).toBe(false);
    expect(sel.toString()).toBe('bcd');

    restore();
  });

  it('resolves empty <br> lines cleanly', () => {
    applyUiScale(75);
    const el = document.createElement('div');
    el.contentEditable = 'true';
    const tn1 = document.createTextNode('abc');
    const br = document.createElement('br');
    const tn2 = document.createTextNode('xyz');
    el.append(tn1, br, tn2);
    document.body.appendChild(el);

    el.getBoundingClientRect = () => makeRect(0, 0, 200, 100);
    br.getBoundingClientRect = () => makeRect(20, 44, 0, 20);
    const origCreateRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const r = origCreateRange();
      r.getClientRects = (() => {
        if (r.startContainer === tn1 && r.endContainer === tn1) {
          if (r.startOffset === 0 && r.endOffset === 3) return [makeRect(20, 20, 30, 20)] as unknown as DOMRectList;
          return [makeRect(20 + r.startOffset * 10, 20, 10, 20)] as unknown as DOMRectList;
        }
        if (r.startContainer === tn2 && r.endContainer === tn2) {
          if (r.startOffset === 0 && r.endOffset === 3) return [makeRect(20, 68, 30, 20)] as unknown as DOMRectList;
          return [makeRect(20 + r.startOffset * 10, 68, 10, 20)] as unknown as DOMRectList;
        }
        if (r.startContainer === el && el.childNodes[r.startOffset] === br) {
          return [makeRect(20, 44, 0, 20)] as unknown as DOMRectList;
        }
        return [] as unknown as DOMRectList;
      }) as unknown as () => DOMRectList;
      return r;
    });

    const hit = resolveContentEditableCaretAtPoint(el, 80 * 0.75, 52 * 0.75, {
      cssZoom: 0.75,
      rectIsZoomed: false,
      clientPerRect: 0.75,
      rectPerCss: 1,
    });
    expect(hit).toEqual({ node: el, offset: 1 });
  });

  it('corrects <textarea> / <input> caret on WebKit (!rectIsZoomed) while skipping Chromium, password fields, drags, and 100% zoom', () => {
    const ta = document.createElement('textarea');
    ta.value = 'abcdefghij';
    document.body.appendChild(ta);

    const pw = document.createElement('input');
    pw.type = 'password';
    pw.value = 'secret';
    document.body.appendChild(pw);

    expect(isZoomCaretTargetInput(ta)).toBe(true);
    expect(isZoomCaretTargetInput(pw)).toBe(false);

    // Chromium (rectIsZoomed = true): fast-path returns null
    expect(resolveTextInputCaretAtPoint(ta, 50, 20, {
      cssZoom: 1.25,
      rectIsZoomed: true,
      clientPerRect: 1,
      rectPerCss: 1.25,
    })).toBeNull();

    // WebKit (rectIsZoomed = false, zoom = 1.25): calibrate through mirror text geometry
    ta.getBoundingClientRect = () => makeRect(10, 10, 200, 60);
    const origCreateElement = document.createElement.bind(document);
    const origCreateRange = document.createRange.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string, options?: ElementCreationOptions) => {
      const created = origCreateElement(tag, options);
      if (tag.toLowerCase() === 'div') {
        created.getBoundingClientRect = () => makeRect(0, 0, 200, 60);
      }
      return created;
    });
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const r = origCreateRange();
      r.getClientRects = (() => {
        if (r.startContainer.nodeType === Node.TEXT_NODE) {
          const t = r.startContainer as Text;
          if (t.data === 'abcdefghij') {
            if (r.startOffset === 0 && r.endOffset === 10) {
              return [makeRect(0, 0, 100, 20)] as unknown as DOMRectList;
            }
            return [makeRect(r.startOffset * 10, 0, 10, 20)] as unknown as DOMRectList;
          }
        }
        return [] as unknown as DOMRectList;
      }) as unknown as () => DOMRectList;
      return r;
    });

    // Viewport click at left = 10*1.25 + 62*1.25 = 90 -> localX = 62 -> between index 6 and 7 -> 6
    const offset = resolveTextInputCaretAtPoint(ta, (10 + 62) * 1.25, (10 + 10) * 1.25, {
      cssZoom: 1.25,
      rectIsZoomed: false,
      clientPerRect: 1.25,
      rectPerCss: 1,
    });
    expect(offset).toBe(6);

    // Global click handler sets selectionRange cleanly under WebKit rect mismatch
    applyUiScale(125);
    Object.defineProperty(ta, 'clientWidth', { value: 200, configurable: true });
    ta.focus();
    ta.setSelectionRange(0, 0);
    document.documentElement.getBoundingClientRect = () => makeRect(0, 0, 800, 600);
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });

    const cleanup = installGlobalZoomedInputCaretFix(document);
    try {
      ta.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        clientX: (10 + 62) * 1.25,
        clientY: (10 + 10) * 1.25,
        detail: 1,
      }));
      expect(ta.selectionStart).toBe(6);
      expect(ta.selectionEnd).toBe(6);

      // Non-collapsed selection MUST NOT be collapsed on click
      ta.setSelectionRange(1, 5);
      ta.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        clientX: (10 + 62) * 1.25,
        clientY: (10 + 10) * 1.25,
        detail: 1,
      }));
      expect(ta.selectionStart).toBe(1);
      expect(ta.selectionEnd).toBe(5);
    } finally {
      cleanup();
    }
  });

  it('skips caret calibration during active IME composition per element for both <input> and <textarea> and resumes after compositionend', () => {
    const ta = document.createElement('textarea');
    ta.value = 'abcdefghij';
    const inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.value = 'abcdefghij';
    document.body.append(ta, inputEl);

    applyUiScale(125);
    document.documentElement.getBoundingClientRect = () => makeRect(0, 0, 800, 600);
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });

    for (const el of [ta, inputEl]) {
      Object.defineProperty(el, 'clientWidth', { value: 200, configurable: true });
      el.getBoundingClientRect = () => makeRect(10, 10, 200, 40);
    }

    const origCreateElement = document.createElement.bind(document);
    const origCreateRange = document.createRange.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string, options?: ElementCreationOptions) => {
      const created = origCreateElement(tag, options);
      if (tag.toLowerCase() === 'div') {
        created.getBoundingClientRect = () => makeRect(0, 0, 200, 40);
      }
      return created;
    });
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const r = origCreateRange();
      r.getClientRects = (() => {
        if (r.startContainer.nodeType === Node.TEXT_NODE) {
          const t = r.startContainer as Text;
          if (t.data === 'abcdefghij') {
            if (r.startOffset === 0 && r.endOffset === 10) {
              return [makeRect(0, 0, 100, 20)] as unknown as DOMRectList;
            }
            return [makeRect(r.startOffset * 10, 0, 10, 20)] as unknown as DOMRectList;
          }
        }
        return [] as unknown as DOMRectList;
      }) as unknown as () => DOMRectList;
      return r;
    });

    const cleanup = installGlobalZoomedInputCaretFix(document);
    try {
      // 1. Both <textarea> and <input>: active compositionstart protects caret against collapsed click;
      // after compositionend, click calibrates accurately to offset 6.
      for (const target of [ta, inputEl]) {
        target.focus();
        target.setSelectionRange(2, 2);
        target.dispatchEvent(new Event('compositionstart', { bubbles: true }));
        target.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          clientX: (10 + 62) * 1.25,
          clientY: (10 + 10) * 1.25,
          detail: 1,
        }));
        expect(target.selectionStart).toBe(2);
        expect(target.selectionEnd).toBe(2);

        target.dispatchEvent(new Event('compositionend', { bubbles: true }));
        target.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          clientX: (10 + 62) * 1.25,
          clientY: (10 + 10) * 1.25,
          detail: 1,
        }));
        expect(target.selectionStart).toBe(6);
        expect(target.selectionEnd).toBe(6);
      }

      // 2. Per-element isolation: ta composing must NOT block calibration on inputEl
      ta.setSelectionRange(1, 1);
      inputEl.setSelectionRange(0, 0);
      ta.dispatchEvent(new Event('compositionstart', { bubbles: true }));
      inputEl.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        clientX: (10 + 62) * 1.25,
        clientY: (10 + 10) * 1.25,
        detail: 1,
      }));
      expect(inputEl.selectionStart).toBe(6);
      ta.dispatchEvent(new Event('compositionend', { bubbles: true }));
    } finally {
      cleanup();
    }
  });
});
