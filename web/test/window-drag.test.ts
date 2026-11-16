/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { h } from 'preact';
import { cleanup, fireEvent, render } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import {
  WINDOW_DRAGGING_CLASS,
  acquireWindowPointerInteractionGuard,
  startFloatingWindowDrag,
  startFloatingWindowResize,
} from '../src/components/window-drag.js';
import { FloatingPanel } from '../src/components/FloatingPanel.js';

describe('window-drag interaction guard and GPU transform lifecycle', () => {
  let rafQueue: FrameRequestCallback[];
  let nextRafId: number;

  beforeEach(() => {
    rafQueue = [];
    nextRafId = 1;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return nextRafId++;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
      rafQueue = [];
    });
  });

  afterEach(() => {
    cleanup();
    document.documentElement.classList.remove(WINDOW_DRAGGING_CLASS);
    window.getSelection()?.removeAllRanges();
    vi.restoreAllMocks();
  });

  const flushRaf = (ts = 16) => {
    const callbacks = rafQueue.splice(0, rafQueue.length);
    for (const cb of callbacks) cb(ts);
  };

  it('ref-counts imcodes-window-dragging and releases idempotently', () => {
    const rel1 = acquireWindowPointerInteractionGuard();
    const rel2 = acquireWindowPointerInteractionGuard();
    expect(document.documentElement.classList.contains(WINDOW_DRAGGING_CLASS)).toBe(true);

    rel1();
    rel1(); // idempotent repeat release must not decrement twice
    expect(document.documentElement.classList.contains(WINDOW_DRAGGING_CLASS)).toBe(true);

    rel2();
    expect(document.documentElement.classList.contains(WINDOW_DRAGGING_CLASS)).toBe(false);
  });

  it('blocks selectstart and clears non-editable selection while preserving editable selection', () => {
    const chatDiv = document.createElement('div');
    chatDiv.textContent = 'chat bubble text';
    const input = document.createElement('input');
    input.value = 'draft prompt';
    document.body.appendChild(chatDiv);
    document.body.appendChild(input);

    // Pre-existing non-editable selection in chat DOM
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(chatDiv);
    sel.removeAllRanges();
    sel.addRange(range);
    expect(sel.rangeCount).toBe(1);

    const release = acquireWindowPointerInteractionGuard();
    expect(sel.rangeCount).toBe(0);

    // selectstart is prevented while guard is active
    const ssEvent = new Event('selectstart', { bubbles: true, cancelable: true });
    chatDiv.dispatchEvent(ssEvent);
    expect(ssEvent.defaultPrevented).toBe(true);

    // Re-selecting non-editable text triggers selectionchange cleanup
    sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    expect(sel.rangeCount).toBe(0);

    // Editable selection inside focused input is preserved
    input.focus();
    const selSpy = vi.spyOn(sel, 'removeAllRanges');
    document.dispatchEvent(new Event('selectionchange'));
    expect(selSpy).not.toHaveBeenCalled();

    release();

    // After release, selectstart is no longer blocked
    const ssAfter = new Event('selectstart', { bubbles: true, cancelable: true });
    chatDiv.dispatchEvent(ssAfter);
    expect(ssAfter.defaultPrevented).toBe(false);

    chatDiv.remove();
    input.remove();
  });

  it('coalesces drag moves with translate3d and commits synchronously on mouseup without clobbering on synthetic mouseup', () => {
    const el = document.createElement('div');
    const onCommit = vi.fn();
    const cancel = startFloatingWindowDrag({
      element: el,
      startX: 100,
      startY: 50,
      origin: { x: 200, y: 120, w: 500, h: 400 },
      clampPos: (x, y) => ({ x: Math.max(0, x), y: Math.max(10, y) }),
      onCommit,
    });

    expect(document.documentElement.classList.contains(WINDOW_DRAGGING_CLASS)).toBe(true);
    expect(el.style.willChange).toBe('transform');

    // Burst of 3 mousemoves in same frame coalesces to last coordinates on rAF
    fireEvent.mouseMove(document, { clientX: 130, clientY: 80 });
    fireEvent.mouseMove(document, { clientX: 160, clientY: 95 });
    fireEvent.mouseMove(document, { clientX: 185, clientY: 110 });
    expect(onCommit).not.toHaveBeenCalled();
    expect(el.style.transform).toBe('');

    flushRaf();
    expect(el.style.transform).toBe('translate3d(85px, 60px, 0)');
    expect(onCommit).not.toHaveBeenCalled();

    // Synthetic mouseup with default (0,0) coordinates commits last moved position
    fireEvent.mouseUp(document);
    expect(el.style.transform).toBe('');
    expect(el.style.willChange).toBe('');
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(285, 180);
    expect(document.documentElement.classList.contains(WINDOW_DRAGGING_CLASS)).toBe(false);

    cancel(); // safe after finish
  });

  it('commits on window blur and skips commit on click without mousemove or on cancel', () => {
    const el = document.createElement('div');
    const onCommitClick = vi.fn();
    startFloatingWindowDrag({
      element: el,
      startX: 10,
      startY: 10,
      origin: { x: 100, y: 100, w: 400, h: 300 },
      clampPos: (x, y) => ({ x, y }),
      onCommit: onCommitClick,
    });
    fireEvent.mouseUp(document);
    expect(onCommitClick).not.toHaveBeenCalled();

    const onCommitBlur = vi.fn();
    startFloatingWindowDrag({
      element: el,
      startX: 10,
      startY: 10,
      origin: { x: 100, y: 100, w: 400, h: 300 },
      clampPos: (x, y) => ({ x, y }),
      onCommit: onCommitBlur,
    });
    fireEvent.mouseMove(document, { clientX: 40, clientY: 50 });
    window.dispatchEvent(new Event('blur'));
    expect(onCommitBlur).toHaveBeenCalledTimes(1);
    expect(onCommitBlur).toHaveBeenCalledWith(130, 140);
    expect(el.style.transform).toBe('');

    const onCommitCancel = vi.fn();
    const cancel = startFloatingWindowDrag({
      element: el,
      startX: 10,
      startY: 10,
      origin: { x: 100, y: 100, w: 400, h: 300 },
      clampPos: (x, y) => ({ x, y }),
      onCommit: onCommitCancel,
    });
    fireEvent.mouseMove(document, { clientX: 60, clientY: 60 });
    cancel();
    expect(onCommitCancel).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains(WINDOW_DRAGGING_CLASS)).toBe(false);
    expect(el.style.transform).toBe('');
    expect(el.style.willChange).toBe('');
  });

  it('coalesces resize updates via rAF and commits final bounds synchronously on mouseup', () => {
    const onUpdate = vi.fn();
    const onEnd = vi.fn();
    startFloatingWindowResize({
      startX: 200,
      startY: 200,
      computeGeometry: (dx, dy) => ({ x: 50, y: 50, w: 400 + dx, h: 300 + dy }),
      onUpdate,
      onEnd,
    });

    expect(document.documentElement.classList.contains(WINDOW_DRAGGING_CLASS)).toBe(true);
    fireEvent.mouseMove(document, { clientX: 220, clientY: 210 });
    fireEvent.mouseMove(document, { clientX: 260, clientY: 245 });
    expect(onUpdate).not.toHaveBeenCalled();

    flushRaf();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenLastCalledWith({ x: 50, y: 50, w: 460, h: 345 });

    fireEvent.mouseMove(document, { clientX: 290, clientY: 270 });
    fireEvent.mouseUp(document);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenLastCalledWith({ x: 50, y: 50, w: 490, h: 370 });
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains(WINDOW_DRAGGING_CLASS)).toBe(false);
  });

  it('cleans up FloatingPanel mid-drag guard if panel unmounts before mouseup', () => {
    const { container, unmount } = render(
      h(
        FloatingPanel,
        {
          id: 'test-drag-panel',
          title: 'Repository',
          onClose: () => {},
          zIndex: 20,
          getDefaultGeometry: () => ({ x: 40, y: 60, w: 400, h: 360 }),
        },
        h('div', null, 'panel body'),
      ),
    );

    const titlebar = container.querySelector('.floating-panel-titlebar') as HTMLElement;
    expect(titlebar).toBeTruthy();

    fireEvent.mouseDown(titlebar, { clientX: 100, clientY: 70 });
    expect(document.documentElement.classList.contains(WINDOW_DRAGGING_CLASS)).toBe(true);

    unmount();
    expect(document.documentElement.classList.contains(WINDOW_DRAGGING_CLASS)).toBe(false);
  });

  it('keeps WebKit selection-lock CSS rules in styles.css', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
    expect(css).toContain('html.imcodes-window-dragging');
    expect(css).toContain('-webkit-user-select: none !important;');
    expect(css).toContain('-webkit-touch-callout: none !important;');
    expect(css).toContain('.subsession-header *');
    expect(css).toContain('.floating-panel-titlebar');
  });
});
