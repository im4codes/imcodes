/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import {
  SUBSESSION_ENTRY_DOUBLE_CLICK_DELAY_MS,
  SUBSESSION_ENTRY_IGNORE_SELECTOR,
  createSubSessionEntryGestureController,
  getSubSessionEntryAction,
  shouldIgnoreSubSessionEntryGestureTarget,
  type SubSessionEntryGestureCallbacks,
  type SubSessionEntryState,
} from '../../src/subsession-entry-gesture.js';
import { SubSessionBar } from '../../src/components/SubSessionBar.js';
import type { SubSession } from '../../src/hooks/useSubSessions.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (
      key === 'subsessionBar.subs_count' ? `${vars?.count ?? 0}` : key
    ),
  }),
}));

vi.mock('../../src/api.js', () => ({
  reorderSubSessions: vi.fn(),
}));

vi.mock('../../src/components/SubSessionCard.js', () => ({
  SubSessionCard: ({ sub }: { sub: SubSession }) => (
    <div data-testid={`subsession-card-preview-${sub.id}`}>{sub.label}</div>
  ),
}));

vi.mock('../../src/components/P2pProgressCard.js', () => ({
  P2pProgressCard: () => null,
}));

vi.mock('../../src/components/IdleFlashLayer.js', () => ({
  IdleFlashLayer: () => null,
}));

vi.mock('../../src/components/EmbeddingStatusIcon.js', () => ({
  EmbeddingStatusIcon: () => null,
}));

function makeActions(log: string[]): SubSessionEntryGestureCallbacks {
  return {
    openNormal: () => log.push('openNormal'),
    closeNormal: () => log.push('closeNormal'),
    restoreThenClose: () => log.push('restoreThenClose'),
    openMaximized: () => log.push('openMaximized'),
    maximize: () => log.push('maximize'),
    restore: () => log.push('restore'),
  };
}

function makeMouseEvent(target: Element): Event {
  const event = new MouseEvent('click', { bubbles: true });
  Object.defineProperty(event, 'target', { configurable: true, value: target });
  return event;
}

describe('sub-session entry gesture helper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('delays single-click actions with one shared timeout', () => {
    const log: string[] = [];
    const root = document.createElement('div');
    const controller = createSubSessionEntryGestureController({
      getState: () => ({ isOpen: false, isMaximized: false }),
      actions: makeActions(log),
    });

    controller.handleClick(makeMouseEvent(root), root);
    vi.advanceTimersByTime(SUBSESSION_ENTRY_DOUBLE_CLICK_DELAY_MS - 1);
    expect(log).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(log).toEqual(['openNormal']);
  });

  it('cancels the pending single-click when a desktop double-click arrives', () => {
    const log: string[] = [];
    const state: SubSessionEntryState = { isOpen: false, isMaximized: false };
    const root = document.createElement('div');
    const controller = createSubSessionEntryGestureController({
      getState: () => state,
      actions: makeActions(log),
    });

    controller.handlePointerDown({ pointerType: 'mouse' });
    controller.handleClick(makeMouseEvent(root), root);
    vi.advanceTimersByTime(SUBSESSION_ENTRY_DOUBLE_CLICK_DELAY_MS - 20);
    controller.handleClick(makeMouseEvent(root), root);
    controller.handleDoubleClick(makeMouseEvent(root), root);
    vi.advanceTimersByTime(SUBSESSION_ENTRY_DOUBLE_CLICK_DELAY_MS);

    expect(log).toEqual(['openMaximized']);
  });

  it('maps all open/maximized states to the canonical single and double-click actions', () => {
    expect(getSubSessionEntryAction({ isOpen: false, isMaximized: false }, 'single')).toBe('open-normal');
    expect(getSubSessionEntryAction({ isOpen: true, isMaximized: false }, 'single')).toBe('close-normal');
    expect(getSubSessionEntryAction({ isOpen: true, isMaximized: true }, 'single')).toBe('restore-then-close');
    expect(getSubSessionEntryAction({ isOpen: false, isMaximized: false }, 'double')).toBe('open-maximized');
    expect(getSubSessionEntryAction({ isOpen: true, isMaximized: false }, 'double')).toBe('maximize');
    expect(getSubSessionEntryAction({ isOpen: true, isMaximized: true }, 'double')).toBe('restore');
  });

  it('ignores interactive descendants and drag/reorder handles', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    const cases = [
      '<button>button</button>',
      '<a href="#">link</a>',
      '<input />',
      '<textarea></textarea>',
      '<select><option>one</option></select>',
      '<div contenteditable="true">edit</div>',
      '<div role="button">role button</div>',
      '<span data-no-subsession-toggle>disabled</span>',
      '<span data-subsession-drag-handle>drag</span>',
      '<span data-subsession-reorder-handle>reorder</span>',
      '<span data-drag-handle>drag</span>',
      '<span data-reorder-handle>reorder</span>',
      '<span class="subcard-resize-handle"></span>',
      '<span class="subcard-drag-handle"></span>',
      '<span class="subsession-drag-icon"></span>',
    ];

    for (const markup of cases) {
      root.innerHTML = markup;
      expect(shouldIgnoreSubSessionEntryGestureTarget(root.firstElementChild, root), markup).toBe(true);
    }

    root.innerHTML = '<span>entry text</span>';
    expect(shouldIgnoreSubSessionEntryGestureTarget(root.firstElementChild, root)).toBe(false);
    expect(SUBSESSION_ENTRY_IGNORE_SELECTOR).toContain('[data-no-subsession-toggle]');
  });

  it('does not treat the entry root itself as an ignored button', () => {
    const root = document.createElement('button');
    const child = document.createElement('span');
    root.appendChild(child);

    expect(shouldIgnoreSubSessionEntryGestureTarget(child, root)).toBe(false);
  });

  it('suppresses pending and future actions while drag or reorder is active', () => {
    const log: string[] = [];
    const root = document.createElement('div');
    let suppressed = false;
    const controller = createSubSessionEntryGestureController({
      getState: () => ({ isOpen: true, isMaximized: false }),
      actions: makeActions(log),
      isGestureSuppressed: () => suppressed,
    });

    controller.handleClick(makeMouseEvent(root), root);
    suppressed = true;
    vi.advanceTimersByTime(SUBSESSION_ENTRY_DOUBLE_CLICK_DELAY_MS);
    controller.handleDoubleClick(makeMouseEvent(root), root);

    expect(log).toEqual([]);
  });

  it('does not run desktop double-click maximize for touch pointers', () => {
    const log: string[] = [];
    const root = document.createElement('div');
    const controller = createSubSessionEntryGestureController({
      getState: () => ({ isOpen: false, isMaximized: false }),
      actions: makeActions(log),
    });

    controller.handlePointerDown({ pointerType: 'touch' });
    controller.handleClick(makeMouseEvent(root), root);
    controller.handleDoubleClick(makeMouseEvent(root), root);
    vi.advanceTimersByTime(SUBSESSION_ENTRY_DOUBLE_CLICK_DELAY_MS);

    expect(log).toEqual(['openNormal']);
  });

  it('does not run desktop double-click maximize when desktop gestures are disabled', () => {
    const log: string[] = [];
    const root = document.createElement('div');
    const controller = createSubSessionEntryGestureController({
      getState: () => ({ isOpen: false, isMaximized: false }),
      actions: makeActions(log),
      isDesktopDoubleClickEnabled: () => false,
    });

    controller.handlePointerDown({ pointerType: 'mouse' });
    controller.handleClick(makeMouseEvent(root), root);
    controller.handleDoubleClick(makeMouseEvent(root), root);
    vi.advanceTimersByTime(SUBSESSION_ENTRY_DOUBLE_CLICK_DELAY_MS);

    expect(log).toEqual(['openNormal']);
  });
});

function makeSubSession(overrides: Partial<SubSession> = {}): SubSession {
  return {
    id: 'sub-1',
    serverId: 'srv-1',
    type: 'shell',
    runtimeType: 'process' as any,
    shellBin: 'bash',
    cwd: '/tmp',
    ccSessionId: null,
    geminiSessionId: null,
    parentSession: 'deck_project_brain',
    label: 'worker',
    ccPresetId: null,
    sessionName: 'deck_sub_sub-1',
    state: 'idle',
    ...overrides,
  };
}

function renderBar(props: Partial<Parameters<typeof SubSessionBar>[0]> = {}) {
  const subSessions = props.subSessions ?? [makeSubSession()];
  return render(
    <SubSessionBar
      subSessions={subSessions}
      openIds={props.openIds ?? new Set()}
      maximizedIds={props.maximizedIds}
      idleFlashTokens={new Map()}
      onOpen={props.onOpen ?? vi.fn()}
      onClose={props.onClose ?? vi.fn()}
      onOpenMaximized={props.onOpenMaximized}
      onMaximize={props.onMaximize}
      onRestore={props.onRestore}
      onRestoreThenClose={props.onRestoreThenClose}
      onRestart={props.onRestart ?? vi.fn()}
      onNew={props.onNew ?? vi.fn()}
      ws={null}
      connected={false}
      onDiff={vi.fn()}
      onHistory={vi.fn()}
      desktopLayoutCapable={props.desktopLayoutCapable}
    />,
  );
}

describe('SubSessionBar component entry gestures', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    localStorage.setItem('rcc_subcard_collapsed', 'true');
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs collapsed entry single-click open only after the shared delay', () => {
    const onOpen = vi.fn();
    renderBar({ onOpen });

    const entry = screen.getByRole('button', { name: /worker/ });
    fireEvent.pointerDown(entry, { pointerType: 'mouse' });
    fireEvent.click(entry);

    vi.advanceTimersByTime(SUBSESSION_ENTRY_DOUBLE_CLICK_DELAY_MS - 1);
    expect(onOpen).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onOpen).toHaveBeenCalledWith('sub-1');
  });

  it('uses the shared controller so double-click opens closed entries maximized and cancels pending single-click', () => {
    const onOpen = vi.fn();
    const onOpenMaximized = vi.fn();
    renderBar({ onOpen, onOpenMaximized });

    const entry = screen.getByRole('button', { name: /worker/ });
    fireEvent.pointerDown(entry, { pointerType: 'mouse' });
    fireEvent.click(entry);
    fireEvent.click(entry);
    fireEvent.dblClick(entry);
    vi.advanceTimersByTime(SUBSESSION_ENTRY_DOUBLE_CLICK_DELAY_MS);

    expect(onOpen).not.toHaveBeenCalled();
    expect(onOpenMaximized).toHaveBeenCalledWith('sub-1');
  });

  it('single-clicks an open maximized entry through restore-then-close', () => {
    const onRestoreThenClose = vi.fn();
    renderBar({
      openIds: new Set(['sub-1']),
      maximizedIds: new Set(['sub-1']),
      onRestoreThenClose,
    });

    const entry = screen.getByRole('button', { name: /worker/ });
    fireEvent.pointerDown(entry, { pointerType: 'mouse' });
    fireEvent.click(entry);
    vi.advanceTimersByTime(SUBSESSION_ENTRY_DOUBLE_CLICK_DELAY_MS);

    expect(onRestoreThenClose).toHaveBeenCalledWith('sub-1');
  });

  it('does not run desktop double-click maximize when desktop layout capability is disabled', () => {
    const onOpen = vi.fn();
    const onOpenMaximized = vi.fn();
    renderBar({ desktopLayoutCapable: false, onOpen, onOpenMaximized });

    const entry = screen.getByRole('button', { name: /worker/ });
    fireEvent.pointerDown(entry, { pointerType: 'mouse' });
    fireEvent.click(entry);
    fireEvent.dblClick(entry);
    vi.advanceTimersByTime(SUBSESSION_ENTRY_DOUBLE_CLICK_DELAY_MS);

    expect(onOpenMaximized).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith('sub-1');
  });
});
