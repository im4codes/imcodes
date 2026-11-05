/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskPairStatusPanel } from '../../src/components/TaskPairStatusPanel.js';
import { TASK_PAIR_PANEL_WIDTH_KEY, readTaskPairPanelWidth, taskPairPanelWidthBounds } from '../../src/task-pair-panel-width.js';
import { resetTaskPairPanelMemoryForTests } from '../../src/task-pair-panel-state.js';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const events = [{ eventId: 'width-event', type: 'task_pair.event', ts: 1, payload: { taskId: 'width-task', title: 'Width task', toStatus: 'working', executor: 'deck_sub_width' } }] as never[];
const pointerDownDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'onpointerdown');
let available = 1280;
class TestPointerEvent extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
}
function mount() {
  return render(<div class="chat-view-wrap"><TaskPairStatusPanel events={events} serverId="width-server" /></div>);
}
const separator = (container: HTMLElement) => container.querySelector('[role="separator"]') as HTMLElement;
const pointer = (target: EventTarget, type: string, x: number, id = 1) => act(() => { target.dispatchEvent(new TestPointerEvent(type, { bubbles: true, clientX: x, pointerId: id, button: 0 })); });
const width = (container: HTMLElement) => container.querySelector<HTMLElement>('.chat-view-wrap')!.style.getPropertyValue('--task-pair-panel-width');
beforeEach(() => {
  localStorage.clear(); resetTaskPairPanelMemoryForTests(); available = 1280;
  delete (window as Window & { __imcodesTaskPairSnapshot?: unknown }).__imcodesTaskPairSnapshot;
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  // Older jsdom has no pointer event handler property. Preact uses this native
  // capability to normalize onPointerDown to the browser's lowercase event.
  Object.defineProperty(HTMLElement.prototype, 'onpointerdown', { configurable: true, writable: true, value: null });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1280);
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width: available, height: 800, x: 0, y: 0, top: 0, left: 0, right: available, bottom: 800, toJSON() {} }));
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (pointerDownDescriptor) Object.defineProperty(HTMLElement.prototype, 'onpointerdown', pointerDownDescriptor);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).onpointerdown;
});

describe('desktop pair panel width', () => {
  it('drags left to grow, writes only on release and remembers across server/session remounts', () => {
    const view = mount(); const handle = separator(view.container);
    expect(width(view.container)).toBe('300px');
    pointer(handle, 'pointerdown', 900); pointer(window, 'pointermove', 700);
    expect(width(view.container)).toBe('500px'); expect(localStorage.getItem(TASK_PAIR_PANEL_WIDTH_KEY)).toBeNull();
    pointer(window, 'pointerup', 700);
    expect(localStorage.getItem(TASK_PAIR_PANEL_WIDTH_KEY)).toBe('500');
    cleanup(); const restored = mount(); expect(width(restored.container)).toBe('500px');
    fireEvent.click(restored.container.querySelector('.task-pair-status-toggle')!);
    expect(separator(restored.container)).toBeNull(); expect(width(restored.container)).toBe('');
    fireEvent.click(restored.container.querySelector('.task-pair-status-toggle')!);
    expect(width(restored.container)).toBe('500px');
  });
  it('a click without dragging does not overwrite a temporarily clamped preference', () => {
    localStorage.setItem(TASK_PAIR_PANEL_WIDTH_KEY, '700'); available = 500; const view = mount();
    const handle = separator(view.container); pointer(handle, 'pointerdown', 900); pointer(window, 'pointerup', 900);
    expect(width(view.container)).toBe('325px'); expect(localStorage.getItem(TASK_PAIR_PANEL_WIDTH_KEY)).toBe('700');
  });
  it('clamps to the pane without overwriting a larger preference on viewport resize', () => {
    localStorage.setItem(TASK_PAIR_PANEL_WIDTH_KEY, '700'); const view = mount();
    available = 500; act(() => { window.dispatchEvent(new Event('resize')); });
    expect(width(view.container)).toBe('325px'); expect(localStorage.getItem(TASK_PAIR_PANEL_WIDTH_KEY)).toBe('700');
    available = 1280; act(() => { window.dispatchEvent(new Event('resize')); }); expect(width(view.container)).toBe('700px');
    fireEvent.keyDown(separator(view.container), { key: 'Home' }); expect(width(view.container)).toBe('240px');
    fireEvent.keyDown(separator(view.container), { key: 'ArrowRight' }); expect(width(view.container)).toBe('240px');
    fireEvent.keyDown(separator(view.container), { key: 'End' }); expect(width(view.container)).toBe('720px');
    fireEvent.keyDown(separator(view.container), { key: 'ArrowLeft' }); expect(width(view.container)).toBe('720px');
    fireEvent.keyDown(separator(view.container), { key: 'ArrowRight' }); expect(width(view.container)).toBe('696px');
  });
  it.each(['pointercancel', 'lostpointercapture', 'blur'])('cancels %s without persisting and ignores another pointer', (kind) => {
    const view = mount(); const handle = separator(view.container);
    pointer(handle, 'pointerdown', 900); pointer(window, 'pointermove', 700, 2); expect(width(view.container)).toBe('300px');
    pointer(window, 'pointermove', 700); expect(width(view.container)).toBe('500px');
    if (kind === 'blur') act(() => { window.dispatchEvent(new Event('blur')); });
    else pointer(kind === 'lostpointercapture' ? handle : window, kind, 700);
    expect(width(view.container)).toBe('300px'); pointer(window, 'pointerup', 600);
    expect(localStorage.getItem(TASK_PAIR_PANEL_WIDTH_KEY)).toBeNull();
  });
  it('cleans a drag on unmount and works when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const view = mount(); pointer(separator(view.container), 'pointerdown', 900); pointer(window, 'pointerup', 700);
    expect(width(view.container)).toBe('500px'); pointer(separator(view.container), 'pointerdown', 700);
    view.unmount(); pointer(window, 'pointermove', 500); pointer(window, 'pointerup', 500);
    expect(document.querySelector('[role="separator"]')).toBeNull();
  });
  it('shares committed widths locally and handles storage events, not per-server preferences', () => {
    const a = mount(); const b = mount(); fireEvent.keyDown(separator(a.container), { key: 'ArrowLeft' });
    expect(width(a.container)).toBe('324px'); expect(width(b.container)).toBe('324px');
    localStorage.setItem(TASK_PAIR_PANEL_WIDTH_KEY, '450');
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: TASK_PAIR_PANEL_WIDTH_KEY })); });
    expect(width(a.container)).toBe('450px'); expect(width(b.container)).toBe('450px');
  });
  it('does not expose a resize handle or apply desktop widths on mobile', () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
    localStorage.setItem(TASK_PAIR_PANEL_WIDTH_KEY, '700'); const view = mount();
    fireEvent.click(view.container.querySelector('.task-pair-status-toggle')!);
    expect(separator(view.container)).toBeNull(); expect(width(view.container)).toBe(''); expect(localStorage.getItem(TASK_PAIR_PANEL_WIDTH_KEY)).toBe('700');
  });
  it.each(['', 'garbage', 'null', 'Infinity', '-10', '0'])('safely defaults invalid storage %j', (raw) => {
    localStorage.setItem(TASK_PAIR_PANEL_WIDTH_KEY, raw); expect(readTaskPairPanelWidth()).toBe(300);
  });
  it('keeps minimum/maximum bounded even in a very narrow split pane', () => {
    expect(taskPairPanelWidthBounds(100)).toEqual({ min: 65, max: 65 });
    expect(taskPairPanelWidthBounds(1280)).toEqual({ min: 240, max: 720 });
  });
});
