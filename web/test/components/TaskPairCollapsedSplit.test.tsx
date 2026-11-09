import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TaskPairEventChip } from '../../src/components/TaskPairEventChip.js';
import { bindTaskPairDecisions, receiveTaskPairDecision } from '../../src/task-pair-decisions.js';
const device = vi.hoisted(() => ({ mobile: false }));
vi.mock('../../src/mobile-device.js', () => ({ isMobileLayout: () => device.mobile }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const payload = { taskId: 'split-task', title: 'Same display task', verb: 'WORKING', toStatus: 'working', executor: 'deck_sub_canonical_exec', auditor: 'deck_sub_canonical_audit', executorLabel: 'Same display', auditorLabel: 'Same display' };
const originalMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
beforeEach(() => Object.defineProperty(window, 'matchMedia', { configurable: true, value: (media: string) => ({ matches: media.includes('hover'), media, addEventListener() {}, removeEventListener() {} }) }));
let unbind: (() => void) | undefined;
afterEach(() => { if (originalMedia) Object.defineProperty(window, 'matchMedia', originalMedia); else delete (window as any).matchMedia; cleanup(); unbind?.(); unbind = undefined; device.mobile = false; delete (window as any).__imcodesActiveSplitTaskId; vi.restoreAllMocks(); });
it('opens the canonical pair directly from the collapsed header without toggling, bubbling or decision IO', () => {
  const outer = vi.fn(), split = vi.fn(), reads = vi.fn();
  const listener = (event: Event) => split((event as CustomEvent).detail); window.addEventListener('deck:pair-split', listener);
  unbind = bindTaskPairDecisions(reads);
  try {
    const view = render(<div onClick={outer}><TaskPairEventChip eventId="event-a" payload={payload} /></div>);
    const toggle = view.container.querySelector('.task-pair-card-toggle')!;
    const button = view.container.querySelector<HTMLButtonElement>('.task-pair-card-head > .task-pair-split-btn')!;
    expect(button).not.toBeNull(); expect(toggle.contains(button)).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('taskPair.panel_open_split'); expect(button.title).toBe('taskPair.panel_open_split');
    fireEvent.focus(button); fireEvent.click(button);
    expect(split.mock.calls).toEqual([[{ taskId: payload.taskId, title: payload.title, executor: payload.executor, auditor: payload.auditor, action: 'open' }]]);
    expect(toggle.getAttribute('aria-expanded')).toBe('false'); expect(view.container.querySelector('.task-pair-card-body')).toBeNull();
    expect(view.container.querySelector('.task-pair-card-hover-preview')).toBeNull();
    expect(outer).not.toHaveBeenCalled(); expect(reads).not.toHaveBeenCalled();
    expect(view.container.querySelector('button button')).toBeNull();
  } finally { window.removeEventListener('deck:pair-split', listener); }
});
it('has exactly one open entry in both collapsed and expanded cards, never a close control', () => {
  const reads = vi.fn(frame => receiveTaskPairDecision(frame.requestId, { ok: true, decisions: [] })); unbind = bindTaskPairDecisions(reads);
  const view = render(<TaskPairEventChip eventId="event-a" payload={payload} />);
  expect(view.container.querySelectorAll('.task-pair-split-btn')).toHaveLength(1);
  fireEvent.click(view.container.querySelector('.task-pair-card-toggle')!);
  expect(view.container.querySelectorAll('.task-pair-split-btn')).toHaveLength(1);
  expect(view.container.querySelector('.task-pair-card-body .task-pair-split-btn')).toBeNull();
  expect(view.container.textContent).not.toContain('taskPair.panel_close_split');
});
it.each([
  { executor: undefined }, { executor: '' }, { executor: 'none' }, { executor: 123 },
  { auditor: undefined }, { auditor: '' }, { auditor: 'none' }, { auditor: 123 },
])('retains the old two-role eligibility for %j', patch => {
  const view = render(<TaskPairEventChip eventId="event-a" payload={{ ...payload, ...patch }} />);
  expect(view.container.querySelector('.task-pair-split-btn')).toBeNull();
  fireEvent.click(view.container.querySelector('.task-pair-card-toggle')!);
  expect(view.container.querySelector('.task-pair-split-btn')).toBeNull();
});
it('keeps mobile excluded and responds to the existing responsive state updates', () => {
  device.mobile = true;
  const view = render(<TaskPairEventChip eventId="event-a" payload={payload} />);
  expect(view.container.querySelector('.task-pair-split-btn')).toBeNull();
  device.mobile = false; act(() => window.dispatchEvent(new Event('resize')));
  expect(view.container.querySelector('.task-pair-split-btn')).not.toBeNull();
  device.mobile = true; act(() => window.dispatchEvent(new Event('resize')));
  expect(view.container.querySelector('.task-pair-split-btn')).toBeNull();
});
it('hides the active task only and restores independent/repeated cards after close', () => {
  (window as any).__imcodesActiveSplitTaskId = payload.taskId;
  const view = render(<><TaskPairEventChip eventId="a" payload={payload} /><TaskPairEventChip eventId="b" payload={payload} /><TaskPairEventChip eventId="c" payload={{ ...payload, taskId: 'other-task' }} /></>);
  expect(view.container.querySelectorAll('.task-pair-split-btn')).toHaveLength(1);
  act(() => window.dispatchEvent(new CustomEvent('deck:pair-split-state', { detail: { activeTaskId: 'other-task' } })));
  expect(view.container.querySelectorAll('.task-pair-split-btn')).toHaveLength(2);
  act(() => window.dispatchEvent(new CustomEvent('deck:pair-split-state', { detail: { activeTaskId: null } })));
  expect(view.container.querySelectorAll('.task-pair-split-btn')).toHaveLength(3);
});
