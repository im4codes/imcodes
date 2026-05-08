export const SUBSESSION_ENTRY_DOUBLE_CLICK_DELAY_MS = 220;

export const SUBSESSION_ENTRY_IGNORE_SELECTOR = [
  'button',
  'a',
  'input',
  'textarea',
  'select',
  '[contenteditable]',
  '[role="button"]',
  '[data-no-subsession-toggle]',
  '[data-subsession-drag-handle]',
  '[data-subsession-reorder-handle]',
  '[data-drag-handle]',
  '[data-reorder-handle]',
  '.subcard-resize-handle',
  '.subcard-drag-handle',
  '.subsession-drag-icon',
].join(',');

export type SubSessionEntryGestureKind = 'single' | 'double';

export interface SubSessionEntryState {
  isOpen: boolean;
  isMaximized: boolean;
}

export type SubSessionEntryAction =
  | 'open-normal'
  | 'close-normal'
  | 'restore-then-close'
  | 'open-maximized'
  | 'maximize'
  | 'restore';

export interface SubSessionEntryGestureCallbacks {
  openNormal: () => void;
  closeNormal: () => void;
  restoreThenClose: () => void;
  openMaximized: () => void;
  maximize: () => void;
  restore: () => void;
}

export interface SubSessionEntryGestureControllerOptions {
  getState: () => SubSessionEntryState;
  actions: SubSessionEntryGestureCallbacks;
  delayMs?: number;
  isGestureSuppressed?: () => boolean;
  isDesktopDoubleClickEnabled?: () => boolean;
}

export interface SubSessionEntryGestureController {
  handlePointerDown: (event: Pick<PointerEvent, 'pointerType'>) => void;
  handleClick: (event: Event, root?: Element | null) => void;
  handleDoubleClick: (event: Event, root?: Element | null) => void;
  cancelPendingSingleClick: () => void;
  dispose: () => void;
}

export function getSubSessionEntryAction(
  state: SubSessionEntryState,
  gesture: SubSessionEntryGestureKind,
): SubSessionEntryAction {
  if (gesture === 'single') {
    if (!state.isOpen) return 'open-normal';
    return state.isMaximized ? 'restore-then-close' : 'close-normal';
  }

  if (!state.isOpen) return 'open-maximized';
  return state.isMaximized ? 'restore' : 'maximize';
}

export function runSubSessionEntryAction(
  action: SubSessionEntryAction,
  callbacks: SubSessionEntryGestureCallbacks,
): void {
  switch (action) {
    case 'open-normal':
      callbacks.openNormal();
      return;
    case 'close-normal':
      callbacks.closeNormal();
      return;
    case 'restore-then-close':
      callbacks.restoreThenClose();
      return;
    case 'open-maximized':
      callbacks.openMaximized();
      return;
    case 'maximize':
      callbacks.maximize();
      return;
    case 'restore':
      callbacks.restore();
      return;
  }
}

export function shouldIgnoreSubSessionEntryGestureTarget(
  target: EventTarget | null,
  root?: Element | null,
  selector = SUBSESSION_ENTRY_IGNORE_SELECTOR,
): boolean {
  if (!(target instanceof Element)) return false;

  let node: Element | null = target;
  while (node && node !== root) {
    if (node.matches(selector)) return true;
    node = node.parentElement;
  }

  return false;
}

export function createSubSessionEntryGestureController(
  options: SubSessionEntryGestureControllerOptions,
): SubSessionEntryGestureController {
  const delayMs = options.delayMs ?? SUBSESSION_ENTRY_DOUBLE_CLICK_DELAY_MS;
  let pendingSingleClick: ReturnType<typeof setTimeout> | null = null;
  let lastPointerType: string | null = null;

  const cancelPendingSingleClick = () => {
    if (!pendingSingleClick) return;
    clearTimeout(pendingSingleClick);
    pendingSingleClick = null;
  };

  const isSuppressed = () => options.isGestureSuppressed?.() === true;

  const shouldIgnoreEvent = (event: Event, root?: Element | null) => {
    return isSuppressed() || shouldIgnoreSubSessionEntryGestureTarget(event.target, root);
  };

  const run = (gesture: SubSessionEntryGestureKind) => {
    runSubSessionEntryAction(getSubSessionEntryAction(options.getState(), gesture), options.actions);
  };

  const handleClick = (event: Event, root?: Element | null) => {
    if (shouldIgnoreEvent(event, root)) {
      cancelPendingSingleClick();
      return;
    }

    cancelPendingSingleClick();
    pendingSingleClick = setTimeout(() => {
      pendingSingleClick = null;
      if (isSuppressed()) return;
      run('single');
    }, delayMs);
  };

  const handleDoubleClick = (event: Event, root?: Element | null) => {
    if (shouldIgnoreEvent(event, root)) {
      cancelPendingSingleClick();
      return;
    }

    if (lastPointerType === 'touch' || options.isDesktopDoubleClickEnabled?.() === false) {
      return;
    }

    cancelPendingSingleClick();
    run('double');
  };

  return {
    handlePointerDown(event) {
      lastPointerType = event.pointerType || null;
      if (isSuppressed()) cancelPendingSingleClick();
    },
    handleClick,
    handleDoubleClick,
    cancelPendingSingleClick,
    dispose: cancelPendingSingleClick,
  };
}
