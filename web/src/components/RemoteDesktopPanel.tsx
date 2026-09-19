import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useTranslation } from 'react-i18next';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_CAPABILITY,
  REMOTE_DESKTOP_COMMON_DISPLAY_MODES,
  REMOTE_DESKTOP_DPI_SCALE_PERCENTS,
  REMOTE_DESKTOP_ERROR,
  REMOTE_DESKTOP_QUALITY_MAX_FPS,
  REMOTE_DESKTOP_QUALITY_MAX_HEIGHTS,
  REMOTE_DESKTOP_QUALITY_MODE,
  REMOTE_DESKTOP_QUALITY_PRIORITY,
  REMOTE_DESKTOP_ROUTE,
  REMOTE_DESKTOP_STATE,
  REMOTE_DESKTOP_STOP_ORIGIN,
  REMOTE_DESKTOP_TERMINAL_REASON,
  mapRemoteDesktopVideoPoint,
  type RemoteDesktopNormalizedPoint,
  type RemoteDesktopQualityMode,
  type RemoteDesktopQualityPreference,
} from '@shared/remote-desktop.js';
import {
  FILE_TRANSFER_DIRECTORY_CAPABILITY,
  FILE_TRANSFER_DIRECTORY_PATH,
  isFileTransferWellKnownDirectoryPath,
  FILE_TRANSFER_PATH_HANDLE_CAPABILITY,
} from '@shared/transport/file-transfer.js';
import {
  isPointOverRemoteDesktopOverlay,
  REMOTE_DESKTOP_OVERLAY_CLASS,
} from '../remote-desktop-pointer-overlay.js';
import { downloadAttachment } from '../api.js';
import {
  canRevealSavedDownload,
  revealSavedDownload,
  savedDownloadFileHandle,
  type SavedDownloadFileHandle,
} from '../download-file-actions.js';
import { createMachineFileHandle, type MachineListItem } from '../api/machines.js';
import { MachineDirectoryWsAdapter } from '../machine-directory-ws-adapter.js';
import {
  FILE_DOWNLOAD_TRANSPORT_MODE,
  FILE_UPLOAD_TRANSPORT_MODE,
  downloadPreviewWithDirectFallback,
  isFileUploadCanceled,
  selectPreviewDownloadDestination,
  uploadFileWithDirectFallback,
  type FileDownloadTransportMode,
  type FileUploadTransportMode,
} from '../direct-file-transfer.js';
import type { RemoteDesktopSnapshot } from '../remote-desktop-client.js';
import {
  RemoteDesktopConnectionManager,
  remoteDesktopHostKey,
  type RemoteDesktopManagedConnection,
} from '../remote-desktop-connection-manager.js';
import {
  REMOTE_DESKTOP_COMPUTER_CASE_KEY,
  REMOTE_DESKTOP_COMPUTER_KEYBOARD_PAGES,
  remoteDesktopComputerKeyChord,
  remoteDesktopComputerUpperKey,
  detectRemoteDesktopClipboardShortcut,
  focusRemoteDesktopMobileInput,
  isAppleControllerPlatform,
  mapRemoteDesktopKeyboardEvent,
  readControllerPlatform,
  remoteDesktopCommandBridge,
  remoteDesktopComputerKeyLabel,
  REMOTE_DESKTOP_CLIPBOARD_SHORTCUT,
  isRemoteDesktopMobileLineBreak,
  remoteDesktopMobileDeletionKey,
  remoteDesktopMobileEditingKey,
  remoteDesktopMobileShortcutKeys,
  sendRemoteDesktopChord,
  shouldForwardRemoteDesktopCopyKeystroke,
  splitRemoteDesktopMobileTextEnter,
  translateRemoteDesktopShortcut,
  type RemoteDesktopChordKey,
  type RemoteDesktopComputerKeySpec,
} from '../remote-desktop-keyboard.js';
import { resolveRemoteDesktopSessionProfile } from '@shared/remote-desktop-platform.js';
import { formatByteRate, formatByteSize } from '../util/byte-size.js';
import { copyToClipboardWhenReady } from '../util/clipboard.js';
import type { WsClient } from '../ws-client.js';
import { openRemoteDesktopWindow } from '../remote-desktop-window.js';
import { useFullscreen } from '../hooks/useFullscreen.js';
import {
  REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT,
  recordRemoteDesktopBrowserDiagnostic,
  type RemoteDesktopBrowserDiagnosticEvent,
} from '../remote-desktop-browser-diagnostics.js';
import { FloatingPanel } from './FloatingPanel.js';
import { DesktopWindowMaximizeButton } from './DesktopWindowMaximizeButton.js';
import { FileBrowser } from './FileBrowser.js';
import {
  EMPTY_QUICK_DATA,
  QuickInputPanel,
  type UseQuickDataResult,
} from './QuickInputPanel.js';
import { remoteDesktopDisplayName } from '../remote-desktop-display-name.js';
import {
  INITIAL_REMOTE_DESKTOP_VIEWPORT,
  clampRemoteDesktopViewport,
  panRemoteDesktopViewportAtEdge,
  remoteDesktopMouseModeViewport,
  REMOTE_DESKTOP_MAX_ZOOM,
  REMOTE_DESKTOP_MIN_ZOOM,
  REMOTE_DESKTOP_POINTER_EDGE_STICKY_RATIO,
  REMOTE_DESKTOP_POINTER_EDGE_STICKY_RATIO_PRECISE,
  stickRemoteDesktopPointerToEdges,
  viewportFromRemoteDesktopPinch,
  type RemoteDesktopViewport,
} from '../remote-desktop-viewport.js';
import {
  loadRemoteDesktopZoomPreference,
  saveRemoteDesktopZoomPreference,
} from '../remote-desktop-zoom-preference.js';
import {
  REMOTE_DESKTOP_QUALITY_BITRATE_OPTIONS,
  loadRemoteDesktopQualityChoice,
  resolveRemoteDesktopQualityPreference,
  saveRemoteDesktopQualityChoice,
  type RemoteDesktopQualityChoice,
} from '../remote-desktop-quality-preference.js';

/** Menu order of the quality modes. */
const QUALITY_MODES: readonly RemoteDesktopQualityMode[] = [
  REMOTE_DESKTOP_QUALITY_MODE.SMOOTH,
  REMOTE_DESKTOP_QUALITY_MODE.BALANCED,
  REMOTE_DESKTOP_QUALITY_MODE.SHARP,
  REMOTE_DESKTOP_QUALITY_MODE.ULTRA,
  REMOTE_DESKTOP_QUALITY_MODE.SAVER,
  REMOTE_DESKTOP_QUALITY_MODE.CUSTOM,
];
const QUALITY_PRIORITIES = Object.values(REMOTE_DESKTOP_QUALITY_PRIORITY);

/** A phone-keyboard editing key and its own input event arrive together. */
const MOBILE_EDITING_KEY_DEDUPE_MS = 150;

type ViewScale = 'fit' | 'actual';
type MobileInputMode = 'touch' | 'mouse';
type MobileKeyboardTab = 'ime' | 'keys';
type ClipboardStatus = 'idle' | 'copying' | 'copied' | 'pasting' | 'pasted' | 'empty' | 'failed';
type DesktopPointerMoveSource =
  | 'window-mouse'
  | 'window-pointer'
  | 'stage-mouse'
  | 'stage-pointer'
  | 'surface-mouse'
  | 'surface-pointer';

const NOOP_QUICK_DATA: UseQuickDataResult = {
  data: EMPTY_QUICK_DATA,
  loaded: true,
  recordHistory: () => {},
  addCommand: () => {},
  addPhrase: () => {},
  removeCommand: () => {},
  removePhrase: () => {},
  removeHistory: () => {},
  removeSessionHistory: () => {},
  clearHistory: () => {},
  clearSessionHistory: () => {},
};

interface TouchPoint {
  x: number;
  y: number;
}

type TouchSingleGesture = {
  kind: 'single';
  pointerId: number;
  start: TouchPoint;
  startedAt: number;
  moved: boolean;
  longPressFired: boolean;
  longPressTimer: ReturnType<typeof setTimeout> | null;
  viewport: RemoteDesktopViewport;
};

/**
 * A two-finger touch starts ambiguous ('pending') and resolves to exactly
 * one of the other two phases on the first move past a small jitter
 * threshold: fingers moving apart/together (distance changing) means
 * pinch-to-zoom the local view, same as before; fingers moving together
 * (center moving, distance roughly constant) means scroll the remote
 * content instead. Once resolved the gesture stays that way for its whole
 * duration -- re-deciding on every move would flip modes mid-drag.
 */
type TouchTwoFingerGesture = {
  kind: 'two-finger';
  phase: 'pending' | 'pinch' | 'scroll';
  initialCenter: TouchPoint;
  initialDistance: number;
  viewport: RemoteDesktopViewport;
  lastCenter: TouchPoint;
};

type TouchGesture = TouchSingleGesture | TouchTwoFingerGesture;

type VirtualMouseDrag = {
  kind: 'move';
  pointerId: number;
  start: TouchPoint;
  origin: TouchPoint;
} | {
  kind: 'wheel';
  pointerId: number;
  lastY: number;
};

type VirtualMouseButton = 'left' | 'middle' | 'right';
type DesktopPointerButton = VirtualMouseButton | 'back' | 'forward';

/**
 * Touch-mode's draggable cursor ring: press-drag moves the remote cursor
 * relatively (like the mouse-mode handle) and a plain tap-without-drag left
 * clicks where it sits. Holding it arms it (`is-right`): dragging from there
 * holds the left button down for a real remote drag, and lifting without
 * dragging right clicks.
 */
interface TouchRingPress {
  pointerId: number;
  start: TouchPoint;
  /** Where the finger is now; a held ring starts its drag from here. */
  last: TouchPoint;
  moved: boolean;
  longPressFired: boolean;
  /** Held, then moved: the left button is down on the remote. */
  dragging: boolean;
  longPressTimer: ReturnType<typeof setTimeout> | null;
}

interface DesktopPointerPress {
  button: DesktopPointerButton;
  clientPoint: TouchPoint;
  normalized: TouchPoint;
  snappedDoubleClick: boolean;
}

interface DisplayModeMenuState {
  displayId: string;
  x: number;
  y: number;
}

interface DisplayTabLongPress {
  displayId: string;
  pointerId: number;
  start: TouchPoint;
  timer: ReturnType<typeof setTimeout>;
}

const INITIAL_SNAPSHOT: RemoteDesktopSnapshot = {
  state: REMOTE_DESKTOP_STATE.AUTHORIZING,
  mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
  inputEpoch: 0,
  inputEnabled: false,
  displays: [],
  layoutRevision: 1,
  stream: null,
  durationMs: 0,
  reconnectCount: 0,
  capabilityVersion: REMOTE_DESKTOP_CAPABILITY,
};

/**
 * The resolutions to offer for a display: the ones its driver reported, or the
 * common sizes when the node is too old to report any. A node that reports them
 * decides on its own — offering a size its driver lacks is a control that can
 * only ever do nothing.
 */
function displayModeOptions(
  display: RemoteDesktopSnapshot['displays'][number],
): Array<{ width: number; height: number; label?: string }> {
  if (!display.modes?.length) return [...REMOTE_DESKTOP_COMMON_DISPLAY_MODES];
  const labels = new Map<string, string>(REMOTE_DESKTOP_COMMON_DISPLAY_MODES.map((mode) => (
    [`${mode.width}x${mode.height}`, mode.label] as [string, string]
  )));
  return display.modes.map((mode) => ({
    width: mode.width,
    height: mode.height,
    ...(labels.has(`${mode.width}x${mode.height}`)
      ? { label: labels.get(`${mode.width}x${mode.height}`) }
      : {}),
  }));
}

/** How long a refused-command notice stays up before it fades on its own. */
const CONTROL_NOTICE_MS = 6_000;
/** How long the clipboard toast stays up before it fades on its own. */
const CLIPBOARD_STATUS_TOAST_MS = 1_800;
const REMOTE_DESKTOP_QUICK_INPUT_Z_INDEX = 10_050;
const TOUCH_LONG_PRESS_MS = 550;
const TOUCH_DOUBLE_TAP_MS = 400;
const DESKTOP_DOUBLE_CLICK_MS = 500;
// CSS pixels on the controller, not remote 4K pixels. A tiny local hand
// movement can otherwise expand beyond Windows' double-click rectangle after
// scaling and turn an intended double-click into two singles.
const DESKTOP_DOUBLE_CLICK_DISTANCE_PX = 8;
const TOUCH_DOUBLE_TAP_DISTANCE_PX = 32;
// The ring is drawn below the actual cursor position, not on top of it -- a
// fingertip dragging the ring would otherwise sit directly on top of
// whatever it is about to click, hiding the one thing the user needs to see
// to aim it. The cursor marker itself stays exactly where clicks land.
const TOUCH_RING_OFFSET_Y_PX = 72;
// How far a two-finger touch has to move, in either the finger-to-finger
// distance or the pair's center, before it commits to pinch vs. scroll --
// below this it is still just jitter from two fingers landing imperfectly
// together.
const TOUCH_TWO_FINGER_CLASSIFY_PX = 8;
// Matches the virtual-mouse wheel handle's own gain (below), so two-finger
// scroll on the video and dragging that handle feel the same.
const TOUCH_TWO_FINGER_SCROLL_GAIN = 8;
// Same jitter-filter idea as the two-finger video gesture above, for
// swiping between computer-keyboard pages: how far a drag has to move
// before it commits to being a swipe, and what fraction of the page's own
// width it then has to cross to flip pages instead of springing back.
const COMPUTER_KEYBOARD_SWIPE_JITTER_PX = 8;
const COMPUTER_KEYBOARD_SWIPE_COMMIT_RATIO = 0.2;
// An upward drag on a key that carries a shift-layer glyph this far sends the
// glyph; a tap under it stays the plain key. Clicks that follow the swipe are
// ignored for this long (the browser still fires one when the finger lifts on
// the same cap).
const COMPUTER_KEY_SWIPE_UP_PX = 14;
const COMPUTER_KEY_SWIPE_CLICK_GUARD_MS = 400;
const REMOTE_DESKTOP_CONNECTION_STEPS = [
  'authorize',
  'worker',
  'negotiate',
  'media',
] as const;

function activeRemoteDesktopConnectionStep(
  snapshot: RemoteDesktopSnapshot,
  mediaPresented: boolean,
): number {
  if (snapshot.stream && mediaPresented) return REMOTE_DESKTOP_CONNECTION_STEPS.length;
  switch (snapshot.state) {
    case REMOTE_DESKTOP_STATE.PREPARING:
      return 1;
    case REMOTE_DESKTOP_STATE.CONNECTING:
      return 2;
    case REMOTE_DESKTOP_STATE.DIRECT:
    case REMOTE_DESKTOP_STATE.RELAYED:
    case REMOTE_DESKTOP_STATE.SWITCHING_DISPLAY:
      return 3;
    case REMOTE_DESKTOP_STATE.RECONNECTING:
    case REMOTE_DESKTOP_STATE.STOPPING:
    case REMOTE_DESKTOP_STATE.STOPPED:
    case REMOTE_DESKTOP_STATE.FAILED:
      return -1;
    case REMOTE_DESKTOP_STATE.AUTHORIZING:
    default:
      return 0;
  }
}

export function remoteDesktopQuickInputHistoryKey(hostKey: string): string {
  return `remote-desktop:${hostKey}`;
}

export interface RemoteDesktopPanelProps {
  machine: MachineListItem;
  connectionManager?: RemoteDesktopConnectionManager;
  ws?: WsClient | null;
  standalone?: boolean;
  allowStandaloneWindow?: boolean;
  /** Render inside the single remote-desktop workspace root, without another floating shell. */
  embedded?: boolean;
  /** Presentation visibility inside the workspace. The connection remains mounted while hidden. */
  active?: boolean;
  /** Only the active ordinary host tab may own keyboard/pointer input. */
  inputActive?: boolean;
  onClose(): void;
  /** Clear protected workspace metadata when Server authority is terminally lost. */
  onAuthorityLost?(): void;
  /**
   * Managed desktop-stack z-index. Without it the panel sat at a hardcoded
   * 10020, above every stack-managed window, so no other window could ever be
   * raised over it however the user clicked.
   */
  zIndex?: number;
  /** Raise this window. Wired to a mousedown anywhere inside the panel. */
  onFocus?(): void;
  /** Account-scoped quick-input state shared with chat and every desktop host. */
  quickData?: UseQuickDataResult;
}

interface RemoteDesktopTransferRow {
  id: string;
  name: string;
  direction: 'send' | 'fetch';
  sourcePath: string;
  destinationPath: string;
  progress: number;
  transport: FileUploadTransportMode | FileDownloadTransportMode;
  status: 'transferring' | 'done' | 'canceled' | 'error';
  /** Known for a file being sent; a fetch learns it only on completion. */
  sizeBytes?: number;
  /** Smoothed, so the number is readable rather than twitching every tick. */
  bytesPerSecond?: number;
  sampledAt?: number;
  sampledBytes?: number;
}

/** Aggregate ring value for the minimized badge: 0 when nothing is running. */
function activeTransferProgress(rows: readonly RemoteDesktopTransferRow[]): {
  active: number;
  progress: number;
} {
  const running = rows.filter((row) => row.status === 'transferring');
  if (running.length === 0) return { active: 0, progress: 0 };
  const total = running.reduce((sum, row) => sum + row.progress, 0);
  return { active: running.length, progress: Math.round(total / running.length) };
}

export function RemoteDesktopPanel({
  machine,
  connectionManager,
  ws = null,
  standalone = false,
  allowStandaloneWindow = false,
  embedded = false,
  active = true,
  inputActive = true,
  onClose,
  onAuthorityLost,
  zIndex,
  onFocus,
  quickData,
}: RemoteDesktopPanelProps) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<RemoteDesktopSnapshot>(INITIAL_SNAPSHOT);
  // Computed once, lazily, rather than on every render: what this machine's
  // display scale was left at last time, if anything was ever saved for it.
  const [storedZoomPreference] = useState(() => loadRemoteDesktopZoomPreference(machine.serverId));
  // Fit by default: the whole remote screen scaled to the visible window is
  // what makes a session usable at a glance, especially on a phone where
  // "actual size" at native desktop pixels shows only a small cropped
  // fraction of the screen. "Actual size" stays one toolbar tap away. A
  // remembered preference for this machine overrides the default so a
  // session doesn't reset to it every time.
  const [viewScale, setViewScale] = useState<ViewScale>(() => storedZoomPreference?.viewScale ?? 'fit');
  const [mobileInputMode, setMobileInputMode] = useState<MobileInputMode>('touch');
  const [viewport, setViewport] = useState<RemoteDesktopViewport>(() => (
    storedZoomPreference
      ? {
        ...INITIAL_REMOTE_DESKTOP_VIEWPORT,
        scale: Math.max(
          REMOTE_DESKTOP_MIN_ZOOM,
          Math.min(REMOTE_DESKTOP_MAX_ZOOM, storedZoomPreference.scale),
        ),
      }
      : INITIAL_REMOTE_DESKTOP_VIEWPORT
  ));
  const [virtualMouse, setVirtualMouse] = useState<TouchPoint>({ x: 0, y: 0 });
  // Brief visual confirmation that a long-press on the touch-mode ring just
  // fired a right-click -- cleared a moment later by touchRingArmedTimerRef,
  // not by the next gesture, so it reads as a flash rather than a mode a user
  // has to remember to back out of.
  const [touchRingArmed, setTouchRingArmed] = useState(false);
  const [viewportGeometryRevision, setViewportGeometryRevision] = useState(0);
  /**
   * How many hover/drag moves this panel actually received from the browser,
   * next to how many the client managed to send. Reported side by side because
   * "the cursor does not follow" has two unrelated causes -- the move never
   * reaching this handler, or reaching it and never leaving -- and the two are
   * indistinguishable from the outside. Sampled, not rendered per event.
   */
  const [pointerMovesSeen, setPointerMovesSeen] = useState(0);
  const pointerMovesSeenRef = useRef(0);
  const pointerMovesUnmappedRef = useRef(0);
  const pointerMovesIngressRef = useRef(0);
  const pointerMovesOutsideRef = useRef(0);
  const pointerMoveIngressBySourceRef = useRef<Record<DesktopPointerMoveSource, number>>({
    'window-mouse': 0,
    'window-pointer': 0,
    'stage-mouse': 0,
    'stage-pointer': 0,
    'surface-mouse': 0,
    'surface-pointer': 0,
  });
  const lastDesktopPointerMoveRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const [pointerMovesUnmapped, setPointerMovesUnmapped] = useState(0);
  const [pointerMovesIngress, setPointerMovesIngress] = useState(0);
  const [pointerMovesOutside, setPointerMovesOutside] = useState(0);
  const [pointerMoveIngressBySource, setPointerMoveIngressBySource] = useState(
    pointerMoveIngressBySourceRef.current,
  );
  const [transfers, setTransfers] = useState<RemoteDesktopTransferRow[]>([]);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [filePanelOpen, setFilePanelOpen] = useState(false);
  const [fileDrawerMinimized, setFileDrawerMinimized] = useState(false);
  const [destinationDirectory, setDestinationDirectory] = useState('');
  const [selectedLocalFiles, setSelectedLocalFiles] = useState<File[]>([]);
  const [selectedRemoteFile, setSelectedRemoteFile] = useState('');
  const [legacyFetchPath, setLegacyFetchPath] = useState('');
  const [fileDropActive, setFileDropActive] = useState(false);
  const [mobileTextOpen, setMobileTextOpen] = useState(false);
  const [mobileKeyboardTab, setMobileKeyboardTab] = useState<MobileKeyboardTab>('ime');
  const [comboMode, setComboMode] = useState(false);
  // Modifiers latched down in combo mode, waiting for either a second tap
  // (release) or a non-modifier key tap (fire the chord, then auto-release).
  const [heldComboKeys, setHeldComboKeys] = useState<readonly RemoteDesktopChordKey[]>([]);
  // Which computer-keyboard page (modifiers/F-keys/navigation, or the full
  // alphanumeric layout) is showing. A latched combo modifier survives a
  // swipe between pages on purpose -- holding Control on page one, then
  // swiping to page two to tap a letter, is a real way to build a chord.
  const [computerKeyboardPage, setComputerKeyboardPage] = useState(0);
  const [computerKeyboardCapitals, setComputerKeyboardCapitals] = useState(false);
  // Live horizontal drag offset (px) while a page swipe is in progress;
  // reset to 0 once the drag commits or cancels, at which point
  // `computerKeyboardPage` alone drives the resting position.
  const [computerKeyboardSwipeOffset, setComputerKeyboardSwipeOffset] = useState(0);
  const computerKeyboardSwipeRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    dragging: boolean;
    deltaX: number;
  } | null>(null);
  const computerKeyboardPagesViewportRef = useRef<HTMLDivElement | null>(null);
  // Per-key upward-swipe tracking (number / punctuation keys), and the time
  // of the last swipe so its trailing click is not also sent as a tap.
  const computerKeyPressRef = useRef<{ pointerId: number; startX: number; startY: number } | null>(null);
  const computerKeySwipedAtRef = useRef(0);
  // How far the OS on-screen keyboard currently eats into the layout
  // viewport from the bottom. The docked keyboard panel normally just sits
  // in its own grid row, but a phone's own keyboard resizes only the visual
  // viewport (not the layout viewport this panel is sized against), so the
  // browser instead scrolls the focused textarea into view -- carrying the
  // panel's own tab switcher, which sits above that textarea, off the top
  // of the screen along with it. Tracking the inset lets the panel pin
  // itself directly above the OS keyboard instead of riding along with that
  // scroll.
  const [mobileKeyboardViewportInset, setMobileKeyboardViewportInset] = useState(0);
  // Pinning the panel (above) takes it out of the grid flow entirely --
  // `position: fixed` items are not grid items at all -- so without this the
  // stage's grid row (minmax(0, 1fr)) would expand to reclaim the vacated
  // row and grow well past where the video actually still fits above the OS
  // keyboard, leaving a tall black gap with the video squeezed to the
  // bottom of it. A same-height spacer left behind in the panel's normal
  // grid slot keeps that row's space reserved while the real, pinned panel
  // renders on top of the keyboard.
  const [quickInputOpen, setQuickInputOpen] = useState(false);
  const [quickInputPortalContainer, setQuickInputPortalContainer] = useState<Element | null>(null);
  const [displayModeMenu, setDisplayModeMenu] = useState<DisplayModeMenuState | null>(null);
  const [clipboardStatus, setClipboardStatus] = useState<ClipboardStatus>('idle');
  const [mediaPresented, setMediaPresented] = useState(false);
  const [mediaRecovering, setMediaRecovering] = useState(false);
  const [hasCachedFrame, setHasCachedFrame] = useState(false);
  const [desktopMaximized, setDesktopMaximized] = useState(false);
  const [nerdStatsOpen, setNerdStatsOpen] = useState(false);
  const [controlNotice, setControlNotice] = useState<{ id: number; text: string } | null>(null);
  const clientRef = useRef<RemoteDesktopManagedConnection | null>(null);
  const ownedConnectionManagerRef = useRef<RemoteDesktopConnectionManager | null>(null);
  const presentationRef = useRef<object>({});
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastFrameCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const quickInputTriggerRef = useRef<HTMLDivElement | null>(null);
  const quickInputSentRef = useRef(false);
  const quickInputBindingRef = useRef<{
    hostKey: string;
    inputEpoch: number;
    client: RemoteDesktopManagedConnection;
  } | null>(null);
  // Shared with the workspace chrome, so that Esc, a second fullscreen
  // elsewhere on the page, and a browser that refuses outright all behave the
  // same wherever the button appears.
  const fullscreen = useFullscreen(panelRef);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mobileTextInputRef = useRef<HTMLTextAreaElement | null>(null);
  const mobileTextComposingRef = useRef(false);
  const mobileEditingKeySentRef = useRef<{ code: string; at: number } | null>(null);
  const mobileTextLastCompositionCommitRef = useRef<string | null>(null);
  const machineDirectoryAdapter = useMemo(
    () => new MachineDirectoryWsAdapter(machine.serverId),
    [machine.serverId],
  );
  const displayModeMenuRef = useRef<HTMLDivElement | null>(null);
  // Seeded from viewport's own (possibly restored) initial value, not the
  // bare default -- they must never start out of sync with each other.
  const viewportRef = useRef<RemoteDesktopViewport>(viewport);
  // The mode/display viewport-reset effect below must not discard a scale
  // just restored from this machine's saved preference on its very first
  // (mount-time) run -- only real, later display/mode changes should reset
  // it back to the plain default.
  const hasResetViewportOnMountRef = useRef(false);
  const virtualMouseRef = useRef<TouchPoint>({ x: 0, y: 0 });
  const virtualMouseDragRef = useRef<VirtualMouseDrag | null>(null);
  const virtualMouseEdgePointRef = useRef<TouchPoint | null>(null);
  const virtualMouseEdgeFrameRef = useRef<number | null>(null);
  const heldVirtualButtonsRef = useRef(new Map<number, VirtualMouseButton>());
  const desktopPointerPressesRef = useRef(new Map<number, DesktopPointerPress>());
  const lastDesktopClickRef = useRef<{
    at: number;
    button: DesktopPointerButton;
    point: TouchPoint;
    normalized: TouchPoint;
  } | null>(null);
  const touchPointsRef = useRef(new Map<number, TouchPoint>());
  const touchGestureRef = useRef<TouchGesture | null>(null);
  const lastTouchTapRef = useRef<{
    at: number;
    point: TouchPoint;
    normalized: TouchPoint;
  } | null>(null);
  const lastTouchRemotePointRef = useRef<TouchPoint>({ x: 0.5, y: 0.5 });
  const touchRingPressRef = useRef<TouchRingPress | null>(null);
  const touchRingArmedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transferControllersRef = useRef(new Map<string, AbortController>());
  /**
   * The saved file behind each finished fetch that has one. Only a fetch
   * written through the save picker does; one handed to the browser's download
   * manager is invisible to the page and gets no "Show in folder" button.
   */
  const savedFetchFilesRef = useRef(new Map<string, SavedDownloadFileHandle>());
  const displayTabLongPressRef = useRef<DisplayTabLongPress | null>(null);
  const suppressDisplayTabClickRef = useRef(false);
  const suppressDisplayTabClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousInputEnabledRef = useRef(false);
  const mediaPresentedRef = useRef(false);
  const mediaRecoveringRef = useRef(false);
  const hasCachedFrameRef = useRef(false);
  const lastCachedFrameAtRef = useRef(Number.NEGATIVE_INFINITY);
  const lastVideoDiagnosticAtRef = useRef(Number.NEGATIVE_INFINITY);
  const forwardedCommandCodesRef = useRef(new Set<string>());
  const suppressedCommandCodesRef = useRef(new Set<string>());
  const syntheticCommandControlRef = useRef(false);
  const commandMiddleDragPointerRef = useRef<number | null>(null);
  const forwardedPasteShortcutAtRef = useRef(0);
  // Keys whose press was tapped on the remote as a translated shortcut; their
  // release has nothing left to deliver.
  const translatedKeyCodesRef = useRef(new Set<string>());

  const recordVideoDiagnostic = useCallback((
    type: RemoteDesktopBrowserDiagnosticEvent,
    callbackNowMs?: number,
    metadata?: VideoFrameCallbackMetadata,
  ) => {
    const video = videoRef.current;
    recordRemoteDesktopBrowserDiagnostic(machine.serverId, {
      type,
      videoReadyState: video?.readyState,
      videoNetworkState: video?.networkState,
      videoCurrentTimeMs: video && Number.isFinite(video.currentTime)
        ? Math.max(0, Math.round(video.currentTime * 1_000))
        : undefined,
      videoWidth: video?.videoWidth,
      videoHeight: video?.videoHeight,
      callbackNowMs: callbackNowMs === undefined ? undefined : Math.round(callbackNowMs),
      mediaTimeMs: metadata && Number.isFinite(metadata.mediaTime)
        ? Math.max(0, Math.round(metadata.mediaTime * 1_000))
        : undefined,
      presentedFrames: metadata && Number.isFinite(metadata.presentedFrames)
        ? Math.max(0, Math.round(metadata.presentedFrames))
        : undefined,
      documentVisible: document.visibilityState === 'visible',
    });
  }, [machine.serverId]);

  const clearCachedFrame = useCallback(() => {
    const canvas = lastFrameCanvasRef.current;
    const hadFrame = hasCachedFrameRef.current;
    if (canvas && hadFrame) {
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      // Resetting the backing store releases the pixel buffer immediately;
      // hiding a canvas alone would retain the last remote desktop in memory.
      canvas.width = 1;
      canvas.height = 1;
    }
    hasCachedFrameRef.current = false;
    const wasRecovering = mediaRecoveringRef.current;
    mediaRecoveringRef.current = false;
    lastCachedFrameAtRef.current = Number.NEGATIVE_INFINITY;
    if (hadFrame) setHasCachedFrame(false);
    if (wasRecovering) setMediaRecovering(false);
    if (hadFrame) {
      recordVideoDiagnostic(REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.VIDEO_FALLBACK_CLEARED);
    }
  }, [recordVideoDiagnostic]);

  const showCachedFrame = useCallback((type: RemoteDesktopBrowserDiagnosticEvent) => {
    recordVideoDiagnostic(type);
    if (!hasCachedFrameRef.current || mediaRecoveringRef.current) return;
    mediaRecoveringRef.current = true;
    setMediaRecovering(true);
    recordVideoDiagnostic(REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.VIDEO_FALLBACK_SHOWN);
  }, [recordVideoDiagnostic]);

  const cachePresentedFrame = useCallback((
    video: HTMLVideoElement,
    callbackNowMs: number,
    metadata: VideoFrameCallbackMetadata,
  ) => {
    if (video.videoWidth <= 0 || video.videoHeight <= 0) return;
    if (!hasCachedFrameRef.current
      || callbackNowMs - lastCachedFrameAtRef.current >= 250) {
      const canvas = lastFrameCanvasRef.current;
      const context = canvas?.getContext('2d');
      if (canvas && context) {
        const scale = Math.min(1, 1_280 / video.videoWidth, 720 / video.videoHeight);
        const width = Math.max(1, Math.round(video.videoWidth * scale));
        const height = Math.max(1, Math.round(video.videoHeight * scale));
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        try {
          context.drawImage(video, 0, 0, width, height);
          lastCachedFrameAtRef.current = callbackNowMs;
          if (!hasCachedFrameRef.current) {
            hasCachedFrameRef.current = true;
            setHasCachedFrame(true);
          }
        } catch {
          // A browser may temporarily refuse a draw while the decoder changes
          // surfaces. Keep the already cached frame; never replace it with
          // blank pixels merely because this refresh failed.
        }
      }
    }
    if (callbackNowMs - lastVideoDiagnosticAtRef.current >= 1_000) {
      lastVideoDiagnosticAtRef.current = callbackNowMs;
      recordVideoDiagnostic(
        REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.VIDEO_FRAME,
        callbackNowMs,
        metadata,
      );
    }
    if (mediaRecoveringRef.current) {
      mediaRecoveringRef.current = false;
      setMediaRecovering(false);
      recordVideoDiagnostic(REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.VIDEO_FALLBACK_HIDDEN);
    }
  }, [recordVideoDiagnostic]);
  const supportsDirectoryTransfer = Boolean(machine.capabilities?.includes(FILE_TRANSFER_DIRECTORY_CAPABILITY));
  const supportsPathHandleTransfer = Boolean(machine.capabilities?.includes(FILE_TRANSFER_PATH_HANDLE_CAPABILITY));
  // Descriptive OS metadata (machine.os) is deliberately not authority here,
  // matching the rest of the remote-desktop stack: this is the same
  // capability-resolved platform the readiness/profile resolver already
  // uses to decide what the session can do, now also used to decide what an
  // Apple controller's Command key means on the wire for THIS target.
  const targetPlatform = useMemo(
    () => resolveRemoteDesktopSessionProfile(machine.capabilities)?.platform ?? null,
    [machine.capabilities],
  );
  const commandBridge = useMemo(
    () => remoteDesktopCommandBridge(readControllerPlatform(), targetPlatform),
    [targetPlatform],
  );
  const fetchSourcePath = supportsPathHandleTransfer
    ? (supportsDirectoryTransfer ? selectedRemoteFile : legacyFetchPath.trim())
    : '';
  const handleRemotePathChange = useCallback((path: string) => {
    // A sentinel is a REQUEST, not a location. The browser publishes it the
    // instant navigation starts and only rewrites it to the daemon's
    // `resolvedPath` once the listing lands, so accepting it here would briefly
    // advertise ":downloads:" as the send destination -- and a send in that
    // window would target a directory that does not exist.
    const isUnresolved = path === FILE_TRANSFER_DIRECTORY_PATH.WINDOWS_DRIVES
      || path === FILE_TRANSFER_DIRECTORY_PATH.WINDOWS_DRIVES_ROOT
      || isFileTransferWellKnownDirectoryPath(path)
      || path === t('file_browser.this_pc');
    setDestinationDirectory(isUnresolved ? '' : path);
    setSelectedRemoteFile('');
  }, [t]);
  const handleRemoteSelectionChange = useCallback((path: string | null, isDirectory: boolean) => {
    if (!path) {
      setSelectedRemoteFile('');
      return;
    }
    if (isDirectory) {
      setDestinationDirectory(path);
      setSelectedRemoteFile('');
      return;
    }
    setSelectedRemoteFile(path);
  }, []);
  if (!connectionManager && !ownedConnectionManagerRef.current) {
    ownedConnectionManagerRef.current = new RemoteDesktopConnectionManager();
  }
  const manager = connectionManager ?? ownedConnectionManagerRef.current!;
  const hostKey = remoteDesktopHostKey(machine);
  const resolvedQuickData = quickData ?? NOOP_QUICK_DATA;
  const quickInputContextRef = useRef({ active, inputActive, hostKey });
  // Event handlers retained by a just-detached portal must consult the latest
  // presentation, not the render in which the picker opened.
  quickInputContextRef.current = { active, inputActive, hostKey };

  useEffect(() => () => machineDirectoryAdapter.destroy(), [machineDirectoryAdapter]);

  // This viewer's stream quality for this machine. Per viewer: every viewer
  // has their own encoder on the node, so one person's choice never changes
  // what anyone else watching the same desktop receives.
  // Remembered per server in this browser. Keyed by the server it was loaded
  // for, so a panel re-pointed at another server (same component, new
  // machine prop) picks up THAT server's choice instead of carrying this one.
  const [storedQuality, setStoredQuality] = useState<{ serverId: string; choice: RemoteDesktopQualityChoice }>(
    () => ({ serverId: machine.serverId, choice: loadRemoteDesktopQualityChoice(machine.serverId) }),
  );
  const qualityChoice = storedQuality.serverId === machine.serverId
    ? storedQuality.choice
    : loadRemoteDesktopQualityChoice(machine.serverId);
  useEffect(() => {
    if (storedQuality.serverId !== machine.serverId) {
      setStoredQuality({ serverId: machine.serverId, choice: loadRemoteDesktopQualityChoice(machine.serverId) });
    }
  }, [machine.serverId, storedQuality.serverId]);
  const [qualityCustomOpen, setQualityCustomOpen] = useState(false);
  const qualityCustomRef = useRef<HTMLDivElement | null>(null);
  const qualityTriggerRef = useRef<HTMLButtonElement | null>(null);
  const qualityPopoverRef = useRef<HTMLDivElement | null>(null);
  const [qualityPopoverPosition, setQualityPopoverPosition] = useState<{
    left: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const updateQualityChoice = useCallback((next: RemoteDesktopQualityChoice) => {
    setStoredQuality({ serverId: machine.serverId, choice: next });
    saveRemoteDesktopQualityChoice(machine.serverId, next);
  }, [machine.serverId]);
  const updateCustomQuality = useCallback((patch: Partial<RemoteDesktopQualityPreference>) => {
    updateQualityChoice({
      mode: REMOTE_DESKTOP_QUALITY_MODE.CUSTOM,
      custom: { ...qualityChoice.custom, ...patch },
    });
  }, [qualityChoice.custom, updateQualityChoice]);
  const relayCapBps = snapshot.route === REMOTE_DESKTOP_ROUTE.RELAY ? snapshot.relayBitrateCapBps : undefined;
  const relayCapped = !!relayCapBps;
  const relayCapText = relayCapBps
    ? t('remote_desktop.quality_relay_cap', {
      mbps: (relayCapBps / 1_000_000).toFixed(relayCapBps < 1_000_000 ? 1 : 0),
    })
    : '';
  useEffect(() => {
    if (!qualityCustomOpen) return;
    // The toolbar groups clip their contents, so the popover lives in a portal
    // pinned to the ⚙ segment; above it when the toolbar sits near the bottom.
    const place = () => {
      const rect = qualityTriggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = 260;
      const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
      setQualityPopoverPosition(rect.bottom + 300 < window.innerHeight
        ? { left, top: rect.bottom + 6 }
        : { left, bottom: window.innerHeight - rect.top + 6 });
    };
    place();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (qualityCustomRef.current?.contains(target) || qualityPopoverRef.current?.contains(target)) return;
      setQualityCustomOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setQualityCustomOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      setQualityPopoverPosition(null);
    };
  }, [qualityCustomOpen]);

  useEffect(() => {
    const connection = manager.presentation(machine, presentationRef.current);
    clientRef.current = connection;
    const unsubscribe = connection.subscribe(
      presentationRef.current,
      setSnapshot,
      { controlsInput: inputActive },
    );
    void connection.start();
    return () => {
      unsubscribe();
      if (clientRef.current === connection) clientRef.current = null;
    };
  }, [hostKey, inputActive, machine.serverId, manager]);

  // Declared after the connection effect so a fresh connection already sits in
  // clientRef; the client remembers it and re-sends on every worker session.
  useEffect(() => {
    clientRef.current?.setQualityPreference?.(
      resolveRemoteDesktopQualityPreference(qualityChoice),
      // Presets get the latency guard; a hand-tuned custom cap is respected as is.
      { latencyGuard: qualityChoice.mode !== REMOTE_DESKTOP_QUALITY_MODE.CUSTOM },
    );
  }, [qualityChoice, hostKey, inputActive, machine.serverId, manager]);

  const hasQuickInputAuthority = useCallback((
    connection: RemoteDesktopManagedConnection | null,
    expected?: { hostKey: string; inputEpoch: number; client: RemoteDesktopManagedConnection } | null,
  ): connection is RemoteDesktopManagedConnection => {
    const context = quickInputContextRef.current;
    if (!context.active || !context.inputActive || !connection) return false;
    const current = connection.current();
    if (current.state !== REMOTE_DESKTOP_STATE.DIRECT
      && current.state !== REMOTE_DESKTOP_STATE.RELAYED) return false;
    if (current.mode !== REMOTE_DESKTOP_ACCESS_MODE.CONTROL || !current.inputEnabled) return false;
    return !expected || (
      expected.client === connection
      && expected.hostKey === context.hostKey
      && expected.inputEpoch === current.inputEpoch
    );
  }, []);

  useEffect(() => {
    if (quickInputOpen && !hasQuickInputAuthority(
      clientRef.current,
      quickInputBindingRef.current,
    )) {
      quickInputBindingRef.current = null;
      quickInputSentRef.current = false;
      setQuickInputOpen(false);
    }
  }, [active, hasQuickInputAuthority, hostKey, inputActive, quickInputOpen, snapshot.inputEnabled, snapshot.inputEpoch, snapshot.mode, snapshot.state]);

  useEffect(() => {
    if (!quickInputOpen) return;
    const syncPortalContainer = () => {
      const fullscreenElement = document.fullscreenElement;
      setQuickInputPortalContainer(
        fullscreenElement && panelRef.current && fullscreenElement.contains(panelRef.current)
          ? fullscreenElement
          : null,
      );
    };
    syncPortalContainer();
    document.addEventListener('fullscreenchange', syncPortalContainer);
    return () => document.removeEventListener('fullscreenchange', syncPortalContainer);
  }, [quickInputOpen]);

  useEffect(() => {
    quickInputBindingRef.current = null;
    quickInputSentRef.current = false;
    setQuickInputOpen(false);
  }, [hostKey]);

  useEffect(() => () => {
    if (!connectionManager) manager.stopAll(REMOTE_DESKTOP_STOP_ORIGIN.PANEL_UNMOUNT);
  }, [connectionManager, manager]);

  useEffect(() => {
    const authorityLost = snapshot.terminalReason === REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_REVOKED
      || snapshot.terminalReason === REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_EXPIRED
      || snapshot.error === REMOTE_DESKTOP_ERROR.INVALID_AUTHORITY
      || snapshot.error === REMOTE_DESKTOP_ERROR.AUTHORITY_EXPIRED
      || snapshot.error === REMOTE_DESKTOP_ERROR.ACCESS_DENIED;
    if (authorityLost) onAuthorityLost?.();
  }, [onAuthorityLost, snapshot.error, snapshot.terminalReason]);

  useEffect(() => () => {
    for (const controller of transferControllersRef.current.values()) controller.abort();
    transferControllersRef.current.clear();
    if (virtualMouseEdgeFrameRef.current !== null) {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(virtualMouseEdgeFrameRef.current);
      } else {
        window.clearTimeout(virtualMouseEdgeFrameRef.current);
      }
      virtualMouseEdgeFrameRef.current = null;
    }
    heldVirtualButtonsRef.current.clear();
    desktopPointerPressesRef.current.clear();
    lastDesktopClickRef.current = null;
    if (touchGestureRef.current?.kind === 'single' && touchGestureRef.current.longPressTimer) {
      clearTimeout(touchGestureRef.current.longPressTimer);
    }
    touchGestureRef.current = null;
    if (touchRingPressRef.current?.longPressTimer) {
      clearTimeout(touchRingPressRef.current.longPressTimer);
    }
    touchRingPressRef.current = null;
    if (touchRingArmedTimerRef.current) {
      clearTimeout(touchRingArmedTimerRef.current);
      touchRingArmedTimerRef.current = null;
    }
    if (displayTabLongPressRef.current) clearTimeout(displayTabLongPressRef.current.timer);
    displayTabLongPressRef.current = null;
    if (suppressDisplayTabClickTimerRef.current) {
      clearTimeout(suppressDisplayTabClickTimerRef.current);
      suppressDisplayTabClickTimerRef.current = null;
    }
  }, []);

  // A refused layout command is the only outcome the picture cannot show: the
  // desktop keeps streaming unchanged. Surface the node's reason and let it
  // fade, so a second attempt with the same reason still announces itself.
  useEffect(() => {
    const rejection = snapshot.controlRejection;
    if (!rejection) return;
    setControlNotice({
      id: rejection.id,
      text: t(`remote_desktop.control_rejected.${rejection.reason}`),
    });
    const timer = setTimeout(() => {
      setControlNotice((current) => (current?.id === rejection.id ? null : current));
    }, CONTROL_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [snapshot.controlRejection?.id, t]);

  // A finished clipboard action (copied/pasted/empty/failed) is a toast, not a
  // permanent toolbar fixture: fade it back to idle on its own so the button
  // group never keeps a stale result around, and never reserves layout space
  // for it while nothing is showing.
  useEffect(() => {
    if (clipboardStatus === 'idle' || clipboardStatus === 'copying' || clipboardStatus === 'pasting') return;
    const timer = setTimeout(() => {
      setClipboardStatus((current) => (
        current === 'idle' || current === 'copying' || current === 'pasting' ? current : 'idle'
      ));
    }, CLIPBOARD_STATUS_TOAST_MS);
    return () => clearTimeout(timer);
  }, [clipboardStatus]);

  useEffect(() => {
    if (!displayModeMenu) return;
    const closeOutside = (event: PointerEvent) => {
      if (!displayModeMenuRef.current?.contains(event.target as Node)) {
        setDisplayModeMenu(null);
      }
    };
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDisplayModeMenu(null);
    };
    const closeOnResize = () => setDisplayModeMenu(null);
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnKey);
    window.addEventListener('resize', closeOnResize);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnKey);
      window.removeEventListener('resize', closeOnResize);
    };
  }, [displayModeMenu]);

  useEffect(() => {
    // A new MediaStream can represent another execution route. Never carry a
    // cached screen across that authority boundary, even if both routes point
    // at the same display.
    clearCachedFrame();
    mediaPresentedRef.current = false;
    setMediaPresented(false);
    if (videoRef.current && videoRef.current.srcObject !== snapshot.stream) {
      videoRef.current.srcObject = snapshot.stream;
    }
    const track = snapshot.stream
      && typeof snapshot.stream.getVideoTracks === 'function'
      ? snapshot.stream.getVideoTracks()[0]
      : undefined;
    if (!track) return;
    const onMute = () => showCachedFrame(REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.VIDEO_WAITING);
    const onEnded = () => clearCachedFrame();
    track.addEventListener('mute', onMute);
    track.addEventListener('ended', onEnded);
    return () => {
      track.removeEventListener('mute', onMute);
      track.removeEventListener('ended', onEnded);
    };
  }, [clearCachedFrame, showCachedFrame, snapshot.stream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onWaiting = () => showCachedFrame(REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.VIDEO_WAITING);
    const onStalled = () => showCachedFrame(REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.VIDEO_STALLED);
    const onEmptied = () => snapshot.stream
      ? showCachedFrame(REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.VIDEO_EMPTIED)
      : clearCachedFrame();
    const onPlaying = () => recordVideoDiagnostic(
      REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.VIDEO_PLAYING,
    );
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('stalled', onStalled);
    video.addEventListener('emptied', onEmptied);
    video.addEventListener('playing', onPlaying);
    return () => {
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('stalled', onStalled);
      video.removeEventListener('emptied', onEmptied);
      video.removeEventListener('playing', onPlaying);
    };
  }, [clearCachedFrame, recordVideoDiagnostic, showCachedFrame, snapshot.stream]);

  useEffect(() => {
    if (snapshot.state === REMOTE_DESKTOP_STATE.STOPPING
      || snapshot.state === REMOTE_DESKTOP_STATE.STOPPED
      || snapshot.state === REMOTE_DESKTOP_STATE.FAILED
      || snapshot.terminalReason === REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_REVOKED
      || snapshot.terminalReason === REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_EXPIRED
      || snapshot.error === REMOTE_DESKTOP_ERROR.INVALID_AUTHORITY
      || snapshot.error === REMOTE_DESKTOP_ERROR.AUTHORITY_EXPIRED
      || snapshot.error === REMOTE_DESKTOP_ERROR.ACCESS_DENIED) {
      clearCachedFrame();
    }
  }, [clearCachedFrame, snapshot.error, snapshot.state, snapshot.terminalReason]);

  useEffect(() => () => clearCachedFrame(), [clearCachedFrame]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || typeof video.requestVideoFrameCallback !== 'function') return;
    let disposed = false;
    let callbackId: number | null = null;
    const onPresentedFrame: VideoFrameRequestCallback = (now, metadata) => {
      if (disposed) return;
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        cachePresentedFrame(video, now, metadata);
        if (!mediaPresentedRef.current) {
          mediaPresentedRef.current = true;
          setMediaPresented(true);
        }
        clientRef.current?.acknowledgePresentedFrame(video.videoWidth, video.videoHeight);
      }
      callbackId = video.requestVideoFrameCallback(onPresentedFrame);
    };
    callbackId = video.requestVideoFrameCallback(onPresentedFrame);
    return () => {
      disposed = true;
      if (callbackId !== null) video.cancelVideoFrameCallback?.(callbackId);
    };
  }, [cachePresentedFrame]);

  useEffect(() => {
    const refresh = () => setViewportGeometryRevision((current) => current + 1);
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(refresh)
      : null;
    if (stageRef.current) observer?.observe(stageRef.current);
    if (videoRef.current) observer?.observe(videoRef.current);
    window.addEventListener('resize', refresh);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', refresh);
    };
  }, []);

  useEffect(() => {
    const release = () => clientRef.current?.releaseAll();
    const visibility = () => { if (document.visibilityState !== 'visible') release(); };
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  useEffect(() => {
    const wasEnabled = previousInputEnabledRef.current;
    previousInputEnabledRef.current = snapshot.inputEnabled;
    if (snapshot.inputEnabled || !wasEnabled) return;
    clientRef.current?.releaseAll();
    forwardedCommandCodesRef.current.clear();
    suppressedCommandCodesRef.current.clear();
    syntheticCommandControlRef.current = false;
    commandMiddleDragPointerRef.current = null;
    heldVirtualButtonsRef.current.clear();
    desktopPointerPressesRef.current.clear();
    lastDesktopClickRef.current = null;
    touchPointsRef.current.clear();
    if (touchGestureRef.current?.kind === 'single' && touchGestureRef.current.longPressTimer) {
      clearTimeout(touchGestureRef.current.longPressTimer);
    }
    touchGestureRef.current = null;
    virtualMouseDragRef.current = null;
    stopVirtualMouseEdgePan();
    if (touchRingPressRef.current?.longPressTimer) {
      clearTimeout(touchRingPressRef.current.longPressTimer);
    }
    touchRingPressRef.current = null;
    if (touchRingArmedTimerRef.current) {
      clearTimeout(touchRingArmedTimerRef.current);
      touchRingArmedTimerRef.current = null;
    }
    setTouchRingArmed(false);
  }, [snapshot.inputEnabled]);

  useEffect(() => {
    const stage = stageRef.current;
    const video = videoRef.current;
    const display = snapshot.displays.find((candidate) => (
      candidate.id === snapshot.selectedDisplayId
    ));
    const geometry = stage && video ? {
      stageWidth: stage.clientWidth,
      stageHeight: stage.clientHeight,
      contentWidth: video.offsetWidth,
      contentHeight: video.offsetHeight,
    } : null;
    // "Mount" isn't just this effect's very first run: a fresh connection's
    // own snapshot lands asynchronously, so the run that first sees a real
    // selected display (not the earlier one with none yet) is the one that
    // marks initialization done -- only after that does a later run mean a
    // real, later display/mode change that should reset to the default.
    const isMountRun = !hasResetViewportOnMountRef.current;
    if (display) hasResetViewportOnMountRef.current = true;
    const nextViewport = mobileInputMode === 'mouse' && geometry && display
      ? remoteDesktopMouseModeViewport(display, geometry)
      // Mount already seeded viewportRef with any remembered scale for this
      // machine; only a later, real display/mode change resets to default.
      : isMountRun ? viewportRef.current : INITIAL_REMOTE_DESKTOP_VIEWPORT;
    viewportRef.current = nextViewport;
    setViewport(nextViewport);
    if (stage) {
      const nextMouse = { x: stage.clientWidth / 2, y: stage.clientHeight / 2 };
      virtualMouseRef.current = nextMouse;
      setVirtualMouse(nextMouse);
    }
    touchPointsRef.current.clear();
    if (touchGestureRef.current?.kind === 'single' && touchGestureRef.current.longPressTimer) {
      clearTimeout(touchGestureRef.current.longPressTimer);
    }
    touchGestureRef.current = null;
    virtualMouseDragRef.current = null;
    virtualMouseEdgePointRef.current = null;
    if (touchRingPressRef.current?.longPressTimer) {
      clearTimeout(touchRingPressRef.current.longPressTimer);
    }
    touchRingPressRef.current = null;
  }, [
    snapshot.selectedDisplayId,
    snapshot.layoutRevision,
    viewScale,
    mobileInputMode,
    viewportGeometryRevision,
  ]);

  // Remembers this machine's display scale locally, debounced so a live
  // pinch gesture doesn't write on every frame -- only once it settles.
  // Skips its own first run so it doesn't immediately write back the value
  // it (or the default) was just seeded with on mount.
  const skipFirstZoomPersistRef = useRef(true);
  useEffect(() => {
    if (skipFirstZoomPersistRef.current) {
      skipFirstZoomPersistRef.current = false;
      return;
    }
    const timer = setTimeout(() => {
      saveRemoteDesktopZoomPreference(machine.serverId, { viewScale, scale: viewport.scale });
    }, 400);
    return () => clearTimeout(timer);
  }, [machine.serverId, viewScale, viewport.scale]);

  const normalizedClientPoint = useCallback((clientX: number, clientY: number) => {
    const video = videoRef.current;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) return null;
    const rect = video.getBoundingClientRect();
    return mapRemoteDesktopVideoPoint({
      clientX,
      clientY,
      viewportLeft: rect.left,
      viewportTop: rect.top,
      viewportWidth: rect.width,
      viewportHeight: rect.height,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
    });
  }, []);

  const normalizedPoint = useCallback((event: PointerEvent | WheelEvent) => (
    normalizedClientPoint(event.clientX, event.clientY)
  ), [normalizedClientPoint]);

  const normalizedDesktopPointerPoint = useCallback((event: PointerEvent) => {
    const point = normalizedClientPoint(event.clientX, event.clientY);
    if (!point) return null;
    // A mouse lands where it is pointed; only a finger needs the wide edge
    // tolerance, which on a mouse swallowed every click near a border.
    return stickRemoteDesktopPointerToEdges(
      point,
      event.pointerType === 'touch'
        ? REMOTE_DESKTOP_POINTER_EDGE_STICKY_RATIO
        : REMOTE_DESKTOP_POINTER_EDGE_STICKY_RATIO_PRECISE,
    );
  }, [normalizedClientPoint]);

  const setMode = (mode: typeof REMOTE_DESKTOP_ACCESS_MODE[keyof typeof REMOTE_DESKTOP_ACCESS_MODE]) => {
    clientRef.current?.setMode(mode);
  };

  const retryConnection = () => {
    clientRef.current?.retry();
  };

  /**
   * Why the input-gated controls are greyed. The node reports what it is
   * waiting on; without this the whole toolbar simply goes dead and looks
   * broken — which is exactly how it was reported.
   */
  const inputBlockedHint = (): string | undefined => {
    if (snapshot.inputEnabled) return undefined;
    if (snapshot.mode !== REMOTE_DESKTOP_ACCESS_MODE.CONTROL) {
      return t('remote_desktop.input_blocked.no_control');
    }
    return t(`remote_desktop.input_blocked.${snapshot.inputBlocked ?? 'channels'}`);
  };

  const openDisplayModeMenu = (
    displayId: string,
    target: HTMLElement,
    clientX?: number,
    clientY?: number,
  ) => {
    const rect = target.getBoundingClientRect();
    const requestedX = clientX && clientX > 0 ? clientX : rect.left;
    const requestedY = clientY && clientY > 0 ? clientY : rect.bottom;
    setDisplayModeMenu({
      displayId,
      x: Math.max(8, Math.min(requestedX, window.innerWidth - 224)),
      y: Math.max(8, Math.min(requestedY, window.innerHeight - 460)),
    });
  };

  const clearDisplayTabLongPress = (pointerId?: number) => {
    const pending = displayTabLongPressRef.current;
    if (!pending || (pointerId !== undefined && pending.pointerId !== pointerId)) return;
    clearTimeout(pending.timer);
    displayTabLongPressRef.current = null;
  };

  const beginDisplayTabLongPress = (event: PointerEvent, displayId: string) => {
    if (event.pointerType !== 'touch') return;
    clearDisplayTabLongPress();
    const target = event.currentTarget as HTMLElement;
    const start = { x: event.clientX, y: event.clientY };
    const pointerId = event.pointerId;
    const timer = setTimeout(() => {
      const pending = displayTabLongPressRef.current;
      if (!pending || pending.pointerId !== pointerId || pending.displayId !== displayId) return;
      displayTabLongPressRef.current = null;
      suppressDisplayTabClickRef.current = true;
      if (suppressDisplayTabClickTimerRef.current) {
        clearTimeout(suppressDisplayTabClickTimerRef.current);
      }
      suppressDisplayTabClickTimerRef.current = setTimeout(() => {
        suppressDisplayTabClickRef.current = false;
        suppressDisplayTabClickTimerRef.current = null;
      }, 1_000);
      openDisplayModeMenu(displayId, target, start.x, start.y);
    }, 550);
    displayTabLongPressRef.current = { displayId, pointerId, start, timer };
  };

  const moveDisplayTabLongPress = (event: PointerEvent) => {
    const pending = displayTabLongPressRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - pending.start.x, event.clientY - pending.start.y) > 10) {
      clearDisplayTabLongPress(event.pointerId);
    }
  };

  const viewportGeometry = () => {
    const stage = stageRef.current;
    const video = videoRef.current;
    if (!stage || !video) return null;
    return {
      stageWidth: stage.clientWidth,
      stageHeight: stage.clientHeight,
      contentWidth: video.offsetWidth,
      contentHeight: video.offsetHeight,
    };
  };

  const commitViewport = (next: RemoteDesktopViewport) => {
    viewportRef.current = next;
    setViewport(next);
  };

  const commitVirtualMouse = (next: TouchPoint) => {
    virtualMouseRef.current = next;
    setVirtualMouse(next);
  };

  const virtualMouseClientPoint = (point = virtualMouseRef.current): TouchPoint | null => {
    const stage = stageRef.current;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    return { x: rect.left + point.x, y: rect.top + point.y };
  };

  const sendVirtualMouseMove = (point = virtualMouseRef.current) => {
    const clientPoint = virtualMouseClientPoint(point);
    if (!clientPoint) return;
    const normalized = normalizedClientPoint(clientPoint.x, clientPoint.y);
    if (normalized) clientRef.current?.pointerMove(normalized.x, normalized.y);
  };

  const scheduleAnimationFrame = (callback: FrameRequestCallback): number => {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
    return window.setTimeout(() => callback(performance.now()), 16);
  };

  const cancelScheduledAnimationFrame = (handle: number) => {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
    else window.clearTimeout(handle);
  };

  const stopVirtualMouseEdgePan = () => {
    if (virtualMouseEdgeFrameRef.current !== null) {
      cancelScheduledAnimationFrame(virtualMouseEdgeFrameRef.current);
      virtualMouseEdgeFrameRef.current = null;
    }
    virtualMouseEdgePointRef.current = null;
  };

  const startVirtualMouseEdgePan = () => {
    if (virtualMouseEdgeFrameRef.current !== null) return;
    let previous = performance.now();
    const tick: FrameRequestCallback = (now) => {
      virtualMouseEdgeFrameRef.current = null;
      const drag = virtualMouseDragRef.current;
      const point = virtualMouseEdgePointRef.current;
      const geometry = viewportGeometry();
      if (!drag || drag.kind !== 'move' || !point || !geometry) return;
      const result = panRemoteDesktopViewportAtEdge(
        viewportRef.current,
        point,
        now - previous,
        geometry,
      );
      previous = now;
      if (result.active) {
        commitViewport(result.viewport);
      }
      // Send once more after the viewport reaches its clamp. The previous
      // frame's transform is then visible in the DOM, so source coordinates
      // can reach the exact 0/1 edges instead of stopping a few pixels short.
      sendVirtualMouseMove(point);
      if (result.active) {
        virtualMouseEdgeFrameRef.current = scheduleAnimationFrame(tick);
      }
    };
    virtualMouseEdgeFrameRef.current = scheduleAnimationFrame(tick);
  };

  const localTouchPoint = (event: PointerEvent): TouchPoint | null => {
    const stage = stageRef.current;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const sendTouchClick = (
    button: DesktopPointerButton,
    point: RemoteDesktopNormalizedPoint,
  ): boolean => {
    const client = clientRef.current;
    if (!client) return false;
    if (snapshot.atomicButtonClick) {
      return client.pointerClick(button, point.x, point.y);
    }
    if (!client.pointerButton(button, true, point.x, point.y)) return false;
    if (client.pointerButton(button, false, point.x, point.y)) return true;
    client.releasePointerButtons();
    return false;
  };

  const beginVirtualMouseMove = (event: PointerEvent) => {
    const point = localTouchPoint(event);
    if (!point || !snapshot.inputEnabled) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    virtualMouseDragRef.current = {
      kind: 'move',
      pointerId: event.pointerId,
      start: point,
      origin: virtualMouseRef.current,
    };
  };

  const beginVirtualMouseWheel = (event: PointerEvent) => {
    const point = localTouchPoint(event);
    if (!point || !snapshot.inputEnabled) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    virtualMouseDragRef.current = {
      kind: 'wheel',
      pointerId: event.pointerId,
      lastY: point.y,
    };
  };

  const onVirtualMouseMove = (event: PointerEvent) => {
    const drag = virtualMouseDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = localTouchPoint(event);
    const stage = stageRef.current;
    if (!point || !stage) return;
    event.preventDefault();
    event.stopPropagation();
    if (drag.kind === 'wheel') {
      const delta = point.y - drag.lastY;
      drag.lastY = point.y;
      if (Math.abs(delta) >= 0.5) {
        const clientPoint = virtualMouseClientPoint();
        const normalized = clientPoint
          ? normalizedClientPoint(clientPoint.x, clientPoint.y)
          : null;
        if (normalized) clientRef.current?.wheel(0, delta * 8, normalized.x, normalized.y);
      }
      return;
    }
    const next = {
      x: Math.max(0, Math.min(stage.clientWidth,
        drag.origin.x + point.x - drag.start.x)),
      y: Math.max(0, Math.min(stage.clientHeight,
        drag.origin.y + point.y - drag.start.y)),
    };
    commitVirtualMouse(next);
    virtualMouseEdgePointRef.current = next;
    sendVirtualMouseMove(next);
    const geometry = viewportGeometry();
    if (geometry) {
      const edge = panRemoteDesktopViewportAtEdge(
        viewportRef.current,
        next,
        16,
        geometry,
      );
      if (edge.active) commitViewport(edge.viewport);
    }
    startVirtualMouseEdgePan();
  };

  const endVirtualMouseDrag = (event: PointerEvent) => {
    const drag = virtualMouseDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    virtualMouseDragRef.current = null;
    stopVirtualMouseEdgePan();
  };

  const onVirtualMouseButton = (
    event: PointerEvent,
    button: VirtualMouseButton,
    down: boolean,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (down) {
      if (heldVirtualButtonsRef.current.has(event.pointerId)) return;
      const clientPoint = virtualMouseClientPoint();
      const normalized = clientPoint
        ? normalizedClientPoint(clientPoint.x, clientPoint.y)
        : null;
      if (normalized && clientRef.current?.pointerButton(
        button,
        true,
        normalized.x,
        normalized.y,
      )) {
        heldVirtualButtonsRef.current.set(event.pointerId, button);
        (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      }
      return;
    }
    const held = heldVirtualButtonsRef.current.get(event.pointerId);
    if (!held) return;
    heldVirtualButtonsRef.current.delete(event.pointerId);
    const clientPoint = virtualMouseClientPoint();
    const normalized = clientPoint
      ? normalizedClientPoint(clientPoint.x, clientPoint.y)
      : null;
    clientRef.current?.pointerButton(
      held,
      false,
      normalized?.x,
      normalized?.y,
    );
  };

  const cancelVirtualMousePointer = (event: PointerEvent) => {
    endVirtualMouseDrag(event);
    onVirtualMouseButton(event, 'left', false);
  };

  /**
   * Fires `button` wherever the ring/virtual-mouse currently sits -- shared
   * by a plain tap (left) and a long-press (right) so both click exactly
   * where the ring is visually resting, not wherever the finger first
   * touched down.
   */
  const sendVirtualMouseClick = (button: DesktopPointerButton) => {
    const clientPoint = virtualMouseClientPoint();
    const normalized = clientPoint ? normalizedClientPoint(clientPoint.x, clientPoint.y) : null;
    if (normalized) sendTouchClick(button, normalized);
  };

  /** Brief ring flash confirming a long-press just fired the right click --
   * cleared on a timer, not by the next gesture, so it always reads as a
   * momentary confirmation rather than a mode the user has to back out of. */
  const flashTouchRingArmed = () => {
    if (touchRingArmedTimerRef.current) clearTimeout(touchRingArmedTimerRef.current);
    setTouchRingArmed(true);
    touchRingArmedTimerRef.current = setTimeout(() => {
      touchRingArmedTimerRef.current = null;
      setTouchRingArmed(false);
    }, 380);
  };

  // Touch mode's draggable cursor ring. A press on the ring always starts a
  // relative move (identical math to the mouse-mode handle, via
  // beginVirtualMouseMove/onVirtualMouseMove/endVirtualMouseDrag) plus a
  // long-press timer. Movement before the timer is a plain cursor move; the
  // timer arms the ring, after which movement drags with the left button
  // held and a release without movement right-clicks; a tap that did
  // neither left-clicks.
  const beginTouchRing = (event: PointerEvent) => {
    if (!snapshot.inputEnabled) return;
    const point = localTouchPoint(event);
    if (!point) return;
    beginVirtualMouseMove(event);
    const press: TouchRingPress = {
      pointerId: event.pointerId,
      start: point,
      last: point,
      moved: false,
      longPressFired: false,
      dragging: false,
      longPressTimer: null,
    };
    press.longPressTimer = setTimeout(() => {
      if (touchRingPressRef.current !== press || press.moved) return;
      press.longPressFired = true;
      // Armed for as long as it is held, not a momentary flash.
      if (touchRingArmedTimerRef.current) clearTimeout(touchRingArmedTimerRef.current);
      touchRingArmedTimerRef.current = null;
      setTouchRingArmed(true);
    }, TOUCH_LONG_PRESS_MS);
    touchRingPressRef.current = press;
  };

  /** Presses or releases the left button where the ring's cursor sits. */
  const sendTouchRingLeftButton = (down: boolean): boolean => {
    const clientPoint = virtualMouseClientPoint();
    const normalized = clientPoint ? normalizedClientPoint(clientPoint.x, clientPoint.y) : null;
    if (down && !normalized) return false;
    return Boolean(clientRef.current?.pointerButton('left', down, normalized?.x, normalized?.y));
  };

  const onTouchRingMove = (event: PointerEvent) => {
    const press = touchRingPressRef.current;
    if (press && press.pointerId === event.pointerId) {
      const point = localTouchPoint(event);
      if (point && !press.longPressFired && !press.moved
        && Math.hypot(point.x - press.start.x, point.y - press.start.y) > 6) {
        press.moved = true;
        if (press.longPressTimer) clearTimeout(press.longPressTimer);
      } else if (point && press.longPressFired && !press.dragging
        && Math.hypot(point.x - press.last.x, point.y - press.last.y) > 6) {
        // Held, then moved: press the left button where the cursor rests
        // before it moves, so the remote sees a drag from that spot.
        press.dragging = sendTouchRingLeftButton(true);
      }
      if (point && !press.longPressFired) press.last = point;
    }
    onVirtualMouseMove(event);
  };

  const endTouchRing = (event: PointerEvent) => {
    const press = touchRingPressRef.current;
    if (press?.longPressTimer) clearTimeout(press.longPressTimer);
    touchRingPressRef.current = null;
    endVirtualMouseDrag(event);
    if (!press || press.pointerId !== event.pointerId) return;
    if (press.longPressFired) setTouchRingArmed(false);
    if (press.dragging) {
      sendTouchRingLeftButton(false);
    } else if (press.longPressFired) {
      sendVirtualMouseClick('right');
      flashTouchRingArmed();
    } else if (!press.moved) {
      sendVirtualMouseClick('left');
    }
  };

  const cancelTouchRing = (event: PointerEvent) => {
    const press = touchRingPressRef.current;
    if (press?.longPressTimer) clearTimeout(press.longPressTimer);
    touchRingPressRef.current = null;
    endVirtualMouseDrag(event);
    if (!press || press.pointerId !== event.pointerId) return;
    if (press.longPressFired) setTouchRingArmed(false);
    // A drag the browser took away still ends: never leave the button down.
    if (press.dragging) sendTouchRingLeftButton(false);
  };

  const beginTwoFingerGesture = () => {
    if (touchGestureRef.current?.kind === 'single' && touchGestureRef.current.longPressTimer) {
      clearTimeout(touchGestureRef.current.longPressTimer);
    }
    const points = [...touchPointsRef.current.values()];
    if (points.length < 2) return;
    const [first, second] = points;
    const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    touchGestureRef.current = {
      kind: 'two-finger',
      phase: 'pending',
      initialCenter: center,
      initialDistance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
      viewport: viewportRef.current,
      lastCenter: center,
    };
  };

  /** Two-finger scroll: send the center point's frame-to-frame movement to
   * the remote as wheel deltas, the same "content follows the finger"
   * direction touch panning already uses elsewhere in this file -- drag up,
   * the remote scrolls down (revealing what is below), like scrolling a
   * page directly with a finger rather than a trackpad's inverted wheel. */
  const sendTwoFingerScroll = (gesture: TouchTwoFingerGesture, center: TouchPoint) => {
    const dx = center.x - gesture.lastCenter.x;
    const dy = center.y - gesture.lastCenter.y;
    gesture.lastCenter = center;
    if (!snapshot.inputEnabled || (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5)) return;
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const normalized = normalizedClientPoint(rect.left + center.x, rect.top + center.y);
    if (!normalized) return;
    clientRef.current?.wheel(
      -dx * TOUCH_TWO_FINGER_SCROLL_GAIN,
      -dy * TOUCH_TWO_FINGER_SCROLL_GAIN,
      normalized.x,
      normalized.y,
    );
  };

  const onTouchDown = (event: PointerEvent) => {
    const point = localTouchPoint(event);
    if (!point) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    touchPointsRef.current.set(event.pointerId, point);
    if (touchPointsRef.current.size === 1) {
      const gesture: TouchSingleGesture = {
        kind: 'single',
        pointerId: event.pointerId,
        start: point,
        startedAt: performance.now(),
        moved: false,
        longPressFired: false,
        longPressTimer: null,
        viewport: viewportRef.current,
      };
      gesture.longPressTimer = setTimeout(() => {
        const current = touchGestureRef.current;
        const stage = stageRef.current;
        if (current !== gesture || current.moved || !stage || !snapshot.inputEnabled) return;
        const rect = stage.getBoundingClientRect();
        const normalized = normalizedClientPoint(
          rect.left + current.start.x,
          rect.top + current.start.y,
        );
        if (!normalized) return;
        current.longPressFired = true;
        lastTouchTapRef.current = null;
        lastTouchRemotePointRef.current = normalized;
        sendTouchClick('right', normalized);
        // The ring is the touch-mode cursor now, not just the drag handle --
        // a long-press anywhere on the screen right-clicks there, so the ring
        // needs to jump there too, with the same brief confirmation flash a
        // long-press directly on the ring gives.
        commitVirtualMouse(current.start);
        flashTouchRingArmed();
      }, TOUCH_LONG_PRESS_MS);
      touchGestureRef.current = gesture;
    } else {
      beginTwoFingerGesture();
    }
  };

  const onTouchMove = (event: PointerEvent) => {
    const point = localTouchPoint(event);
    if (!point || !touchPointsRef.current.has(event.pointerId)) return;
    event.preventDefault();
    touchPointsRef.current.set(event.pointerId, point);
    const geometry = viewportGeometry();
    const gesture = touchGestureRef.current;
    if (!geometry || !gesture) return;
    const points = [...touchPointsRef.current.values()];
    if (points.length >= 2 && gesture.kind === 'two-finger') {
      const [first, second] = points;
      const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
      const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };

      if (gesture.phase === 'pending') {
        const distanceDelta = Math.abs(distance - gesture.initialDistance);
        const centerDelta = Math.hypot(
          center.x - gesture.initialCenter.x,
          center.y - gesture.initialCenter.y,
        );
        if (distanceDelta < TOUCH_TWO_FINGER_CLASSIFY_PX && centerDelta < TOUCH_TWO_FINGER_CLASSIFY_PX) {
          return; // Still just two fingers landing imperfectly together.
        }
        gesture.phase = distanceDelta > centerDelta ? 'pinch' : 'scroll';
        if (gesture.phase === 'scroll') {
          // This move becomes the scroll baseline; deltas start from the next one.
          gesture.lastCenter = center;
          return;
        }
      }

      if (gesture.phase === 'pinch') {
        commitViewport(viewportFromRemoteDesktopPinch(
          gesture.viewport,
          gesture.initialCenter,
          center,
          gesture.viewport.scale * distance / gesture.initialDistance,
          geometry,
        ));
        return;
      }

      sendTwoFingerScroll(gesture, center);
    } else if (points.length === 1 && gesture.kind === 'single'
      && gesture.pointerId === event.pointerId) {
      const dx = point.x - gesture.start.x;
      const dy = point.y - gesture.start.y;
      if (Math.hypot(dx, dy) > 6 && !gesture.moved) {
        gesture.moved = true;
        if (gesture.longPressTimer) clearTimeout(gesture.longPressTimer);
      }
      if (gesture.moved) {
        commitViewport(clampRemoteDesktopViewport({
          ...gesture.viewport,
          x: gesture.viewport.x + dx,
          y: gesture.viewport.y + dy,
        }, geometry));
      }
    }
  };

  const onTouchEnd = (event: PointerEvent, canceled = false) => {
    const point = localTouchPoint(event);
    const gesture = touchGestureRef.current;
    if (gesture?.kind === 'single' && gesture.longPressTimer) {
      clearTimeout(gesture.longPressTimer);
    }
    const shouldClick = !canceled && point && gesture?.kind === 'single'
      && gesture.pointerId === event.pointerId
      && !gesture.moved
      && !gesture.longPressFired
      && performance.now() - gesture.startedAt <= 600;
    touchPointsRef.current.delete(event.pointerId);
    if (shouldClick) {
      const normalized = normalizedPoint(event);
      if (normalized) {
        const now = performance.now();
        const previous = lastTouchTapRef.current;
        const doubleTap = previous
          && now - previous.at <= TOUCH_DOUBLE_TAP_MS
          && Math.hypot(point.x - previous.point.x, point.y - previous.point.y)
            <= TOUCH_DOUBLE_TAP_DISTANCE_PX;
        const target = doubleTap ? previous.normalized : normalized;
        lastTouchRemotePointRef.current = target;
        sendTouchClick('left', target);
        // Tapping the screen moves the mouse there too -- the ring should
        // land on whichever point actually got clicked, which on a
        // double-tap is the first tap's position, not this second one.
        commitVirtualMouse(doubleTap ? previous.point : point);
        lastTouchTapRef.current = doubleTap ? null : {
          at: now,
          point,
          normalized,
        };
      }
    }
    const remaining = [...touchPointsRef.current.entries()];
    if (remaining.length === 1) {
      const [pointerId, remainingPoint] = remaining[0];
      touchGestureRef.current = {
        kind: 'single',
        pointerId,
        start: remainingPoint,
        startedAt: performance.now(),
        moved: true,
        longPressFired: false,
        longPressTimer: null,
        viewport: viewportRef.current,
      };
    } else if (remaining.length >= 2) {
      beginTwoFingerGesture();
    } else {
      touchGestureRef.current = null;
    }
  };

  const onTouchRightButton = (event: PointerEvent, down: boolean) => {
    event.preventDefault();
    event.stopPropagation();
    const point = lastTouchRemotePointRef.current;
    if (down) {
      if (!snapshot.inputEnabled || heldVirtualButtonsRef.current.has(event.pointerId)) return;
      if (clientRef.current?.pointerButton('right', true, point.x, point.y)) {
        heldVirtualButtonsRef.current.set(event.pointerId, 'right');
        (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      }
      return;
    }
    if (heldVirtualButtonsRef.current.get(event.pointerId) !== 'right') return;
    heldVirtualButtonsRef.current.delete(event.pointerId);
    clientRef.current?.pointerButton('right', false, point.x, point.y);
  };

  const changeZoom = (delta: number) => {
    const geometry = viewportGeometry();
    if (!geometry) return;
    const current = viewportRef.current;
    commitViewport(clampRemoteDesktopViewport({
      ...current,
      scale: current.scale + delta,
    }, geometry));
  };

  useEffect(() => {
    const timer = setInterval(() => {
      // Only on change. An idle panel that re-rendered every second kept
      // scheduling render work forever, for a number nobody was watching move.
      setPointerMovesSeen((current) => (
        current === pointerMovesSeenRef.current ? current : pointerMovesSeenRef.current
      ));
      setPointerMovesUnmapped((current) => (
        current === pointerMovesUnmappedRef.current ? current : pointerMovesUnmappedRef.current
      ));
      setPointerMovesIngress((current) => (
        current === pointerMovesIngressRef.current ? current : pointerMovesIngressRef.current
      ));
      setPointerMovesOutside((current) => (
        current === pointerMovesOutsideRef.current ? current : pointerMovesOutsideRef.current
      ));
      setPointerMoveIngressBySource((current) => {
        const next = pointerMoveIngressBySourceRef.current;
        return (Object.keys(next) as DesktopPointerMoveSource[]).every(
          (source) => current[source] === next[source],
        ) ? current : { ...next };
      });
    }, 1_000);
    return () => clearInterval(timer);
  }, []);

  const sendDesktopPointerMove = useCallback((
    clientX: number,
    clientY: number,
    source: DesktopPointerMoveSource,
  ) => {
    pointerMovesIngressRef.current += 1;
    pointerMoveIngressBySourceRef.current[source] += 1;
    const now = performance.now();
    const lastMove = lastDesktopPointerMoveRef.current;
    if (lastMove && lastMove.x === clientX && lastMove.y === clientY && now - lastMove.at < 16) {
      return;
    }
    lastDesktopPointerMoveRef.current = { x: clientX, y: clientY, at: now };
    const stage = stageRef.current;
    if (!stage) return;
    const stageRect = stage.getBoundingClientRect();
    if (clientX < stageRect.left || clientY < stageRect.top
      || clientX > stageRect.right || clientY > stageRect.bottom) {
      pointerMovesOutsideRef.current += 1;
      return;
    }
    // The file window floats ON TOP of the desktop, so being inside the stage
    // rect no longer means the pointer is on the desktop. Dragging or resizing
    // that window was also driving the remote cursor, which is what made the
    // remote screen flicker and the drag feel like it kept breaking.
    //
    // Hit-testing rather than `event.target` on purpose: pointer capture
    // retargets events to the dragged window even when the pointer is over the
    // desktop, which is why target ownership was rejected here originally.
    // `elementFromPoint` is pure geometry, so it answers the occlusion
    // question without inheriting that problem.
    if (filePanelOpen && !fileDrawerMinimized
      && isPointOverRemoteDesktopOverlay(clientX, clientY)) {
      pointerMovesOutsideRef.current += 1;
      return;
    }
    pointerMovesSeenRef.current += 1;
    const normalized = normalizedClientPoint(clientX, clientY);
    const point = normalized && stickRemoteDesktopPointerToEdges(
      normalized,
      REMOTE_DESKTOP_POINTER_EDGE_STICKY_RATIO_PRECISE,
    );
    if (!point) {
      pointerMovesUnmappedRef.current += 1;
      return;
    }
    clientRef.current?.pointerMove(point.x, point.y);
    // The window-open flags are read above, so they must be dependencies:
    // without them the effect below keeps the FIRST closure and the guard
    // would still see the window as closed after it is opened.
  }, [normalizedClientPoint, filePanelOpen, fileDrawerMinimized]);

  useEffect(() => {
    const onWindowMouseMove = (event: globalThis.MouseEvent) => {
      sendDesktopPointerMove(event.clientX, event.clientY, 'window-mouse');
    };
    const onWindowPointerMove = (event: globalThis.PointerEvent) => {
      if (event.pointerType === 'touch') return;
      sendDesktopPointerMove(event.clientX, event.clientY, 'window-pointer');
    };
    // Capture before floating-window drag/gesture owners or descendants can
    // stop propagation. Coordinates, not event.target ownership, decide
    // whether the pointer is over the presented desktop.
    window.addEventListener('mousemove', onWindowMouseMove, {
      capture: true,
      passive: true,
    });
    window.addEventListener('pointermove', onWindowPointerMove, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener('mousemove', onWindowMouseMove, true);
      window.removeEventListener('pointermove', onWindowPointerMove, true);
    };
  }, [sendDesktopPointerMove]);

  const onStagePointerMove = (event: PointerEvent) => {
    if (event.pointerType === 'touch') {
      onTouchMove(event);
      return;
    }
    // The stage owns ordinary desktop hover. Some WebKit/native-wrapper
    // combinations only deliver window-level pointer/mouse moves while a
    // button is captured, which made hover stop while drag still worked.
    sendDesktopPointerMove(event.clientX, event.clientY, 'stage-pointer');
  };

  const onStageMouseMove = (event: MouseEvent) => {
    sendDesktopPointerMove(event.clientX, event.clientY, 'stage-mouse');
  };

  const onInputSurfacePointerMove = (event: PointerEvent) => {
    if (event.pointerType === 'touch') {
      onTouchMove(event);
    } else {
      sendDesktopPointerMove(event.clientX, event.clientY, 'surface-pointer');
    }
    // This is the browser hit surface above the native video compositor. Own
    // the target phase here; window capture remains a fallback and the stage
    // must not consume the same compatibility event a third time.
    event.stopPropagation();
  };

  const onInputSurfaceMouseMove = (event: MouseEvent) => {
    sendDesktopPointerMove(event.clientX, event.clientY, 'surface-mouse');
    event.stopPropagation();
  };

  const suppressCommandControlForMiddleDrag = () => {
    const client = clientRef.current;
    if (!client) return;
    const commandCodes = new Set(forwardedCommandCodesRef.current);
    if (syntheticCommandControlRef.current) commandCodes.add(commandBridge.code);
    let released = true;
    for (const code of commandCodes) {
      suppressedCommandCodesRef.current.add(code);
      if (!client.key(code, commandBridge.key, false, false, { control: false, alt: false })) {
        released = false;
      }
    }
    forwardedCommandCodesRef.current.clear();
    syntheticCommandControlRef.current = false;
    if (!released) client.releaseAll();
  };

  // A failed release send (channel transiently not open) must not be treated
  // as done: the client's own contract says a failed up can be retried, and
  // the caller here has no future retry point since syntheticCommandControlRef
  // is what gates whether the command code is still considered forwarded. Fall
  // back to releaseAll() -- exactly the same rescue suppressCommandControlForMiddleDrag
  // uses above -- so a dropped release message cannot leave Control (or, on a
  // macOS target, Command) physically stuck down on the remote host for the
  // rest of the session.
  const releaseSyntheticCommandControl = (altKey: boolean) => {
    const client = clientRef.current;
    if (!client) return;
    const released = client.key(commandBridge.code, commandBridge.key, false, false, { control: false, alt: altKey });
    syntheticCommandControlRef.current = false;
    if (!released) client.releaseAll();
  };

  const onPointerButton = (event: PointerEvent, down: boolean) => {
    if (down && snapshot.inputEnabled) {
      stageRef.current?.focus({ preventScroll: true });
    }
    if (event.pointerType === 'touch') {
      if (down) onTouchDown(event);
      else onTouchEnd(event);
      return;
    }
    // Release before interpreting the changed button. Pointer Events says
    // pointerup should carry the changed button, but compatibility layers have
    // emitted -1 here. Returning first leaves capture stuck on the desktop
    // stage, which suppresses hover hit-testing everywhere else in Blink and
    // WebKit until another interaction happens.
    if (!down) {
      const target = event.currentTarget as HTMLElement;
      try {
        if (target.hasPointerCapture?.(event.pointerId)) {
          target.releasePointerCapture?.(event.pointerId);
        }
      } catch {
        // Pointer capture may already have been released implicitly.
      }
    }
    const startsCommandMiddleDrag = down
      && event.button === 0
      && event.metaKey
      && commandBridge.appleController;
    const continuingCommandMiddleDrag = !down
      && commandMiddleDragPointerRef.current === event.pointerId;
    const eventButton: DesktopPointerButton | null = startsCommandMiddleDrag || continuingCommandMiddleDrag ? 'middle'
      : event.button === 0 ? 'left'
      : event.button === 1 ? 'middle'
        : event.button === 2 ? 'right'
          : event.button === 3 ? 'back'
            : event.button === 4 ? 'forward'
              : null;
    const activePress = down
      ? undefined
      : desktopPointerPressesRef.current.get(event.pointerId);
    const button = activePress?.button ?? eventButton;
    if (!button) {
      if (!down && desktopPointerPressesRef.current.delete(event.pointerId)) {
        lastDesktopClickRef.current = null;
        clientRef.current?.releasePointerButtons();
      }
      return;
    }
    const point = normalizedDesktopPointerPoint(event);
    if (down && !point) return;
    const now = performance.now();
    const clientPoint = { x: event.clientX, y: event.clientY };
    const previous = lastDesktopClickRef.current;
    const snappedDoubleClick = Boolean(down && point && previous
      && previous.button === button
      && now - previous.at <= DESKTOP_DOUBLE_CLICK_MS
      && Math.hypot(
        clientPoint.x - previous.point.x,
        clientPoint.y - previous.point.y,
      ) <= DESKTOP_DOUBLE_CLICK_DISTANCE_PX);
    const sendPoint = activePress?.snappedDoubleClick
      ? activePress.normalized
      : snappedDoubleClick
        ? previous!.normalized
        : point;
    event.preventDefault();
    if (down) {
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      if (startsCommandMiddleDrag) {
        suppressCommandControlForMiddleDrag();
        commandMiddleDragPointerRef.current = event.pointerId;
      }
    }
    // The first click has already completed. Finish the recognized double
    // click as one native down/up batch so SCTP scheduling or a late hover
    // packet cannot split its second half. Its physical pointer-up is then a
    // local lifecycle event only.
    const sent = down && snappedDoubleClick && snapshot.atomicButtonClick
      ? (clientRef.current?.pointerClick(button, sendPoint?.x, sendPoint?.y) ?? false)
      : !down && activePress?.snappedDoubleClick && snapshot.atomicButtonClick
        ? true
        : (clientRef.current?.pointerButton(
            button,
            down,
            sendPoint?.x,
            sendPoint?.y,
          ) ?? false);
    if (down && sent && sendPoint) {
      desktopPointerPressesRef.current.set(event.pointerId, {
        button,
        clientPoint,
        normalized: sendPoint,
        snappedDoubleClick,
      });
      if (snappedDoubleClick) lastDesktopClickRef.current = null;
    }
    if (!down) {
      desktopPointerPressesRef.current.delete(event.pointerId);
      if (sent && activePress) {
        const stayedNearTarget = Math.hypot(
          clientPoint.x - activePress.clientPoint.x,
          clientPoint.y - activePress.clientPoint.y,
        ) <= DESKTOP_DOUBLE_CLICK_DISTANCE_PX;
        lastDesktopClickRef.current = !activePress.snappedDoubleClick && stayedNearTarget
          ? {
              at: now,
              button: activePress.button,
              point: activePress.clientPoint,
              normalized: activePress.normalized,
            }
          : null;
      }
    }
    if (startsCommandMiddleDrag && !sent) commandMiddleDragPointerRef.current = null;
    if (continuingCommandMiddleDrag) commandMiddleDragPointerRef.current = null;
  };

  const onWheel = (event: WheelEvent) => {
    const point = normalizedPoint(event);
    if (!point) return;
    event.preventDefault();
    clientRef.current?.wheel(event.deltaX, event.deltaY, point.x, point.y);
  };

  const onKey = (event: KeyboardEvent, down: boolean) => {
    if (!snapshot.inputEnabled) return;
    // The stage owns physical keyboard input while control is active. Without
    // this boundary the same key bubbles into App's document-level keyboard
    // passthrough, which focuses a chat composer and inserts the character a
    // second time (observed consistently in Safari).
    event.stopPropagation();
    const client = clientRef.current;
    const mapped = mapRemoteDesktopKeyboardEvent(event, undefined, targetPlatform);
    if (!client || !mapped) return;
    // Copy and paste are answered by the clipboard bridge rather than forwarded
    // blind: the two machines have separate clipboards, so the keystroke alone
    // copies where the operator cannot reach and pastes what they never copied.
    // Copy still reaches the remote — the bridge sends it there to make the
    // selection — so an interrupt in a remote console keeps working.
    const clipboardShortcut = detectRemoteDesktopClipboardShortcut(event, undefined, targetPlatform);
    if (clipboardShortcut === REMOTE_DESKTOP_CLIPBOARD_SHORTCUT.PASTE
      && (!navigator.clipboard?.readText || isAppleControllerPlatform(readControllerPlatform()))) {
      // No clipboard read here: leave the key alone so the browser raises its
      // own native paste event instead, which carries the text without going
      // through navigator.clipboard.readText(). Two cases need this, for
      // different reasons:
      //  - Firefox and non-secure contexts: readText() isn't available at all.
      //  - Safari/WebKit (macOS, and especially iOS/iPadOS): it IS available,
      //    but calling it -- even synchronously inside this keydown's own
      //    handler -- makes WebKit show its own "Paste" confirmation callout
      //    every single time, which a real Cmd+V/Ctrl+V never needs. Letting
      //    the OS's own paste gesture reach the browser natively (handled by
      //    onPaste below) avoids that callout entirely.
      // Not forwarding the keystroke to the remote either way keeps it from
      // pasting its own clipboard on top once this one lands.
      return;
    }
    if (clipboardShortcut && shouldForwardRemoteDesktopCopyKeystroke(event, undefined, targetPlatform)) {
      // A PC operator's Control+C on Linux: take the selection AND let the
      // keystroke through below -- it interrupts a remote terminal.
      if (down) void copyRemoteSelection();
    } else if (clipboardShortcut) {
      event.preventDefault();
      if (!down) return;
      if (clipboardShortcut === REMOTE_DESKTOP_CLIPBOARD_SHORTCUT.COPY) {
        void copyRemoteSelection();
      } else if (clipboardShortcut === REMOTE_DESKTOP_CLIPBOARD_SHORTCUT.CUT) {
        void cutRemoteSelection();
      } else {
        void pasteLocalClipboard();
      }
      return;
    }
    // Shortcuts the target spells differently (Command+Left is Home on a PC,
    // Home is Command+Left on a Mac, ...) are tapped whole on the remote.
    const translated = down ? translateRemoteDesktopShortcut(event, undefined, targetPlatform) : null;
    if (translated) {
      event.preventDefault();
      translatedKeyCodesRef.current.add(event.code);
      client.tapChords(translated);
      return;
    }
    if (translatedKeyCodesRef.current.delete(event.code) && !down) {
      event.preventDefault();
      return;
    }
    const commandEvent = event.code === 'MetaLeft' || event.code === 'MetaRight';
    if (mapped.usesCommandBridge && commandEvent
      && suppressedCommandCodesRef.current.has(mapped.code)
      && !syntheticCommandControlRef.current) {
      if (!down) suppressedCommandCodesRef.current.delete(mapped.code);
      event.preventDefault();
      return;
    }
    if (mapped.usesCommandBridge && commandEvent) {
      if (down) forwardedCommandCodesRef.current.add(mapped.code);
      else forwardedCommandCodesRef.current.delete(mapped.code);
      if (!down && syntheticCommandControlRef.current) {
        releaseSyntheticCommandControl(event.altKey);
      }
    } else if (mapped.usesCommandBridge && event.metaKey
      && forwardedCommandCodesRef.current.size === 0
      && !syntheticCommandControlRef.current) {
      suppressedCommandCodesRef.current.clear();
      syntheticCommandControlRef.current = client.key(
        commandBridge.code,
        commandBridge.key,
        true,
        false,
        { control: commandBridge.translateToControl, alt: event.altKey },
      );
    } else if (mapped.usesCommandBridge && !event.metaKey && syntheticCommandControlRef.current) {
      releaseSyntheticCommandControl(event.altKey);
    }
    const sent = client.key(mapped.code, mapped.key, down, event.repeat, mapped.modifiers);
    if (sent) {
      if (down && mapped.code === 'KeyV' && mapped.modifiers.control) {
        forwardedPasteShortcutAtRef.current = Date.now();
      }
      event.preventDefault();
    }
    if (mapped.usesCommandBridge && !commandEvent && !down && event.metaKey
      && forwardedCommandCodesRef.current.size === 0 && syntheticCommandControlRef.current) {
      releaseSyntheticCommandControl(event.altKey);
    }
  };

  const releaseCapturedInput = () => {
    translatedKeyCodesRef.current.clear();
    forwardedCommandCodesRef.current.clear();
    suppressedCommandCodesRef.current.clear();
    syntheticCommandControlRef.current = false;
    commandMiddleDragPointerRef.current = null;
    forwardedPasteShortcutAtRef.current = 0;
    clientRef.current?.releaseAll();
  };

  const openQuickInput = () => {
    const client = clientRef.current;
    if (!hasQuickInputAuthority(client)) return;
    const current = client.current();
    quickInputBindingRef.current = {
      hostKey,
      inputEpoch: current.inputEpoch,
      client,
    };
    const fullscreenElement = document.fullscreenElement;
    setQuickInputPortalContainer(
      fullscreenElement && panelRef.current && fullscreenElement.contains(panelRef.current)
        ? fullscreenElement
        : null,
    );
    quickInputSentRef.current = false;
    setQuickInputOpen(true);
  };

  const sendQuickInputText = (value: string) => {
    const binding = quickInputBindingRef.current;
    const client = clientRef.current;
    const sent = Boolean(
      value
      && binding
      && hasQuickInputAuthority(client, binding)
      && binding.client.text(value),
    );
    quickInputSentRef.current = sent;
    if (sent) {
      resolvedQuickData.recordHistory(value, remoteDesktopQuickInputHistoryKey(hostKey));
    }
  };

  const closeQuickInput = () => {
    const sent = quickInputSentRef.current;
    quickInputBindingRef.current = null;
    quickInputSentRef.current = false;
    setQuickInputOpen(false);
    setQuickInputPortalContainer(null);
    requestAnimationFrame(() => {
      const context = quickInputContextRef.current;
      if (!context.active || !context.inputActive) return;
      if (sent && hasQuickInputAuthority(clientRef.current)) {
        stageRef.current?.focus({ preventScroll: true });
      } else {
        quickInputTriggerRef.current?.querySelector<HTMLButtonElement>('button')
          ?.focus({ preventScroll: true });
      }
    });
  };

  const sendPastedText = (text: string): boolean => {
    if (!snapshot.inputEnabled || !text) return false;
    const sent = clientRef.current?.text(text) ?? false;
    if (sent) stageRef.current?.focus({ preventScroll: true });
    return sent;
  };

  const pasteLocalClipboard = async () => {
    if (!snapshot.inputEnabled) return;
    setClipboardStatus('pasting');
    try {
      const text = await navigator.clipboard?.readText?.();
      if (!text) {
        setClipboardStatus('empty');
        return;
      }
      setClipboardStatus(sendPastedText(text) ? 'pasted' : 'failed');
    } catch {
      setClipboardStatus('failed');
    }
  };

  const copyRemoteSelection = async () => {
    if (!snapshot.inputEnabled) return;
    setClipboardStatus('copying');
    // Engage the clipboard with the promise, inside the tap. Waiting for the
    // remote machine to answer and only then writing is refused on iOS, where
    // the write is only allowed while the tap still counts.
    const pending = Promise.resolve(clientRef.current?.requestRemoteClipboard())
      .then((text) => text ?? '');
    const copied = new Promise<boolean>((resolve) => {
      copyToClipboardWhenReady(pending, () => resolve(true), () => resolve(false));
    });
    const text = await pending;
    if (!text) {
      setClipboardStatus('empty');
      return;
    }
    setClipboardStatus(await copied ? 'copied' : 'failed');
  };

  // The selection leaves the remote only once it is safely in the local
  // clipboard: the Windows and Mac workers copy by pressing their own copy
  // shortcut, which finds nothing left to copy after a cut.
  const cutRemoteSelection = async () => {
    await copyRemoteSelection();
    clientRef.current?.tapChords([remoteDesktopMobileShortcutKeys('cut', targetPlatform)]);
  };

  const stopAndClose = () => {
    clientRef.current?.stop(REMOTE_DESKTOP_STOP_ORIGIN.USER_CLOSE);
    onClose();
  };


  const updateTransfer = (id: string, patch: Partial<RemoteDesktopTransferRow>) => {
    setTransfers((current) => current.map((row) => (
      row.id === id ? { ...row, ...patch } : row
    )));
  };

  /**
   * Turn the percentage the upload reports into a rate. Only a file whose size
   * is known can produce one; a fetch reports progress without a size and
   * simply shows none rather than an invented number.
   */
  const updateTransferProgress = (id: string, progress: number) => {
    setTransfers((current) => current.map((row) => {
      if (row.id !== id) return row;
      const now = Date.now();
      if (!row.sizeBytes) return { ...row, progress };
      const bytes = row.sizeBytes * (progress / 100);
      const elapsed = now - (row.sampledAt ?? now);
      if (elapsed < 250) return { ...row, progress };
      const delta = bytes - (row.sampledBytes ?? 0);
      const instant = delta > 0 ? (delta * 1000) / elapsed : 0;
      // Smoothed so the figure is readable instead of twitching every tick.
      const smoothed = row.bytesPerSecond
        ? row.bytesPerSecond * 0.6 + instant * 0.4
        : instant;
      return {
        ...row,
        progress,
        bytesPerSecond: smoothed,
        sampledAt: now,
        sampledBytes: bytes,
      };
    }));
  };

  const updateDownloadTransferProgress = (id: string, loadedBytes: number, totalBytes: number | null) => {
    setTransfers((current) => current.map((row) => {
      if (row.id !== id) return row;
      const now = Date.now();
      const progress = totalBytes && totalBytes > 0
        ? Math.min(99, Math.round((loadedBytes / totalBytes) * 100))
        : row.progress;
      const elapsed = now - (row.sampledAt ?? now);
      const delta = loadedBytes - (row.sampledBytes ?? 0);
      const instant = elapsed >= 250 && delta > 0 ? (delta * 1000) / elapsed : 0;
      return {
        ...row,
        progress,
        ...(totalBytes && totalBytes > 0 ? { sizeBytes: totalBytes } : {}),
        ...(instant > 0 ? {
          bytesPerSecond: row.bytesPerSecond ? row.bytesPerSecond * 0.6 + instant * 0.4 : instant,
          sampledAt: now,
          sampledBytes: loadedBytes,
        } : {}),
      };
    }));
  };

  const sendFile = async (file: File) => {
    const id = crypto.randomUUID();
    const controller = new AbortController();
    transferControllersRef.current.set(id, controller);
    setTransfers((current) => [...current, {
      id,
      name: file.name || 'file',
      direction: 'send',
      sourcePath: file.name || 'file',
      destinationPath: destinationDirectory || t('remote_desktop.compatible_upload_location'),
      progress: 0,
      transport: FILE_UPLOAD_TRANSPORT_MODE.CONNECTING,
      status: 'transferring',
      sizeBytes: file.size,
      sampledAt: Date.now(),
      sampledBytes: 0,
    }]);
    setTransferError(null);
    try {
      await uploadFileWithDirectFallback({
        ws: ws?.targetsServer(machine.serverId) ? ws : null,
        serverId: machine.serverId,
        file,
        ...(supportsDirectoryTransfer && destinationDirectory ? { destinationDirectory } : {}),
        signal: controller.signal,
        onProgress: (progress) => updateTransferProgress(id, progress),
        onMode: (transport) => updateTransfer(id, { transport }),
      });
      updateTransfer(id, { progress: 100, status: 'done', bytesPerSecond: undefined });
    } catch (error) {
      if (isFileUploadCanceled(error)) {
        updateTransfer(id, { status: 'canceled' });
        return;
      }
      updateTransfer(id, { status: 'error' });
      setTransferError(t('remote_desktop.file_transfer_failed'));
    } finally {
      transferControllersRef.current.delete(id);
    }
  };

  const sendFiles = async (files: readonly File[]) => {
    for (const file of files) {
      await sendFile(file);
    }
  };

  const stageLocalFiles = (files: readonly File[]) => {
    setSelectedLocalFiles((current) => {
      const next = [...current];
      const known = new Set(current.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
      for (const file of files) {
        const key = `${file.name}:${file.size}:${file.lastModified}`;
        if (known.has(key)) continue;
        known.add(key);
        next.push(file);
      }
      return next;
    });
  };

  const sendSelectedFiles = () => {
    if (selectedLocalFiles.length === 0) return;
    const files = selectedLocalFiles;
    setSelectedLocalFiles([]);
    void sendFiles(files);
  };

  const openMobileKeyboard = () => {
    if (!snapshot.inputEnabled) return;
    setMobileKeyboardTab('ime');
    setComputerKeyboardPage(0);
    setMobileTextOpen(true);
    requestAnimationFrame(() => focusRemoteDesktopMobileInput(mobileTextInputRef.current));
  };

  // Re-measure whenever the panel is open: the OS keyboard can come and go
  // (switching tabs, or the textarea losing/regaining focus) without the
  // panel itself closing.
  //
  // What matters is how far the panel's own container reaches below the part
  // of the page the person can actually see, not how the window happens to
  // report its height. iOS and Android leave the layout viewport alone and
  // shrink only the visual one, while some webviews resize both -- measuring
  // the container against the visual viewport's bottom edge is right in every
  // case, and comes out as 0 when the page already resized itself.
  useEffect(() => {
    if (!mobileTextOpen || typeof window === 'undefined' || !window.visualViewport) return;
    const viewport = window.visualViewport;
    const recompute = () => {
      const rect = panelRef.current?.parentElement?.getBoundingClientRect();
      // No laid-out container to measure (or nothing rendered yet): fall back
      // to the window, which is what an unmeasurable panel fills anyway.
      const bottomEdge = rect && rect.height > 0 ? rect.bottom : window.innerHeight;
      setMobileKeyboardViewportInset(Math.max(0, Math.round(
        bottomEdge - (viewport.height + viewport.offsetTop),
      )));
    };
    recompute();
    viewport.addEventListener('resize', recompute);
    viewport.addEventListener('scroll', recompute);
    window.addEventListener('resize', recompute);
    return () => {
      viewport.removeEventListener('resize', recompute);
      viewport.removeEventListener('scroll', recompute);
      window.removeEventListener('resize', recompute);
      setMobileKeyboardViewportInset(0);
    };
  }, [mobileTextOpen]);

  const comboModifierFlags = (keys: readonly RemoteDesktopChordKey[]) => ({
    control: keys.some((k) => k.code === 'ControlLeft' || k.code === 'ControlRight'),
    alt: keys.some((k) => k.code === 'AltLeft' || k.code === 'AltRight'),
  });

  /** Release every latched combo modifier, innermost (most recently pressed) first. */
  const releaseHeldComboKeys = () => {
    const client = clientRef.current;
    if (client) {
      let remaining = heldComboKeys;
      for (const held of [...heldComboKeys].reverse()) {
        remaining = remaining.filter((k) => k.code !== held.code);
        client.key(held.code, held.key, false, false, comboModifierFlags(remaining));
      }
    }
    if (heldComboKeys.length > 0) setHeldComboKeys([]);
  };

  const toggleComboMode = () => {
    if (comboMode) releaseHeldComboKeys();
    setComboMode((prev) => !prev);
  };

  const switchMobileKeyboardTab = (tab: MobileKeyboardTab) => {
    if (mobileKeyboardTab === 'keys' && tab !== 'keys') releaseHeldComboKeys();
    setMobileKeyboardTab(tab);
    if (tab === 'ime') requestAnimationFrame(() => focusRemoteDesktopMobileInput(mobileTextInputRef.current));
  };

  const closeMobileKeyboard = () => {
    releaseHeldComboKeys();
    setMobileTextOpen(false);
  };

  /**
   * A tap on the "computer keyboard" grid. Outside combo mode -- or on a
   * non-modifier key with nothing latched -- this is just a standalone
   * press+release. In combo mode, tapping a modifier latches/unlatches it
   * (held down on the remote the whole time, so its own effect, e.g. Shift
   * changing what a later tap types, is visible immediately); tapping a
   * non-modifier while modifiers are latched fires the whole chord once and
   * releases the modifiers, ready for the next chord.
   */
  const pressComputerKey = (spec: RemoteDesktopComputerKeySpec) => {
    if (spec.code === REMOTE_DESKTOP_COMPUTER_CASE_KEY.code) {
      setComputerKeyboardCapitals((capitals) => !capitals);
      return;
    }
    const client = clientRef.current;
    if (!client || !snapshot.inputEnabled) return;
    // A capital letter or a special character is Shift plus the key, exactly
    // as a real keyboard sends it.
    const chord = remoteDesktopComputerKeyChord(spec, computerKeyboardCapitals);
    if (comboMode && spec.modifier) {
      const isHeld = heldComboKeys.some((k) => k.code === spec.code);
      if (isHeld) {
        const remaining = heldComboKeys.filter((k) => k.code !== spec.code);
        client.key(spec.code, spec.key, false, false, comboModifierFlags(remaining));
        setHeldComboKeys(remaining);
      } else {
        const next = [...heldComboKeys, { code: spec.code, key: spec.key }];
        client.key(spec.code, spec.key, true, false, comboModifierFlags(next));
        setHeldComboKeys(next);
      }
      return;
    }
    if (comboMode && heldComboKeys.length > 0) {
      const flags = comboModifierFlags(heldComboKeys);
      if (chord.length === 2) {
        const [shift, target] = chord;
        const shifted = { ...flags, shift: true };
        client.key(shift!.code, shift!.key, true, false, shifted);
        client.key(target!.code, target!.key, true, false, shifted);
        client.key(target!.code, target!.key, false, false, shifted);
        client.key(shift!.code, shift!.key, false, false, flags);
      } else {
        client.key(spec.code, spec.key, true, false, flags);
        client.key(spec.code, spec.key, false, false, flags);
      }
      releaseHeldComboKeys();
      return;
    }
    sendRemoteDesktopChord(
      chord,
      (code, keyName, down, repeat, modifiers) => client.key(code, keyName, down, repeat, modifiers),
      () => client.releaseAll(),
    );
  };

  const onComputerKeyPointerDown = (event: PointerEvent) => {
    event.preventDefault();
    computerKeyPressRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
  };

  const onComputerKeyPointerUp = (event: PointerEvent, spec: RemoteDesktopComputerKeySpec) => {
    const press = computerKeyPressRef.current;
    computerKeyPressRef.current = null;
    const upper = remoteDesktopComputerUpperKey(spec);
    if (!press || press.pointerId !== event.pointerId || !upper) return;
    const dx = event.clientX - press.startX;
    const up = press.startY - event.clientY;
    if (up < COMPUTER_KEY_SWIPE_UP_PX || up <= Math.abs(dx)) return;
    computerKeySwipedAtRef.current = Date.now();
    pressComputerKey(upper);
  };

  const onComputerKeyClick = (spec: RemoteDesktopComputerKeySpec) => {
    if (Date.now() - computerKeySwipedAtRef.current < COMPUTER_KEY_SWIPE_CLICK_GUARD_MS) {
      computerKeySwipedAtRef.current = 0;
      return;
    }
    pressComputerKey(spec);
  };

  // Horizontal swipe between computer-keyboard pages. Deliberately its own
  // gesture handling rather than reusing the video stage's touch code above:
  // this operates on the key-grid buttons, not the remote pointer, and a
  // committed page change only needs to beat a fraction of the viewport
  // width, not track a pinch/scroll ambiguity.
  const onComputerKeyboardPagesPointerDown = (event: PointerEvent) => {
    if (computerKeyboardSwipeRef.current) return;
    computerKeyboardSwipeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      deltaX: 0,
    };
  };

  const onComputerKeyboardPagesPointerMove = (event: PointerEvent) => {
    const drag = computerKeyboardSwipeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.dragging) {
      if (Math.abs(dx) < COMPUTER_KEYBOARD_SWIPE_JITTER_PX && Math.abs(dy) < COMPUTER_KEYBOARD_SWIPE_JITTER_PX) return;
      if (Math.abs(dy) >= Math.abs(dx)) {
        // Vertical intent (scrolling the docked panel itself) -- not a page swipe.
        computerKeyboardSwipeRef.current = null;
        return;
      }
      drag.dragging = true;
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    }
    event.preventDefault();
    drag.deltaX = dx;
    setComputerKeyboardSwipeOffset(dx);
  };

  const onComputerKeyboardPagesPointerUp = (event: PointerEvent) => {
    const drag = computerKeyboardSwipeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    computerKeyboardSwipeRef.current = null;
    if (drag.dragging) {
      const pageWidth = computerKeyboardPagesViewportRef.current?.clientWidth || 1;
      const commitDistance = pageWidth * COMPUTER_KEYBOARD_SWIPE_COMMIT_RATIO;
      if (drag.deltaX <= -commitDistance && computerKeyboardPage < REMOTE_DESKTOP_COMPUTER_KEYBOARD_PAGES.length - 1) {
        setComputerKeyboardPage((page) => page + 1);
      } else if (drag.deltaX >= commitDistance && computerKeyboardPage > 0) {
        setComputerKeyboardPage((page) => page - 1);
      }
    }
    setComputerKeyboardSwipeOffset(0);
  };

  const submitMobileText = (value: string) => {
    if (!value || !snapshot.inputEnabled) return;
    const input = mobileTextInputRef.current;
    // The textarea is cleared unconditionally, not only when client.text()
    // reports success. It used to be gated on that success -- an uncontrolled
    // <textarea> whose value survives a failed send (data channel
    // momentarily not open, a protocol_error fail(), or any other transient
    // client.text() false) keeps re-submitting the SAME stale value on every
    // later keystroke (onInput reads the accumulated DOM value, not just what
    // was newly typed), and if every resend keeps failing the same way,
    // typing never reaches the remote session again for the rest of the
    // session -- indistinguishable from a full input freeze, recoverable
    // only by reconnecting. There is no retry queue for a dropped composed
    // string either way; not clearing on failure does not preserve it for a
    // retry, it only poisons every subsequent attempt.
    clientRef.current?.text(value);
    if (input) {
      input.value = '';
      if (document.activeElement !== input) {
        input.focus({ preventScroll: true });
      }
    }
  };

  const sendMobileShortcut = (keys: readonly { code: string; key: string }[]) => {
    const client = clientRef.current;
    if (!client || !snapshot.inputEnabled) return;
    sendRemoteDesktopChord(
      keys,
      (code, key, down, repeat, modifiers) => client.key(code, key, down, repeat, modifiers),
      () => client.releaseAll(),
    );
    focusRemoteDesktopMobileInput(mobileTextInputRef.current);
  };

  /**
   * Same as `submitMobileText`, but first extracts a trailing Enter -- see
   * `splitRemoteDesktopMobileTextEnter`'s own doc comment for the full
   * reasoning. Every mobile-IME commit path (composition end, plain
   * non-composing input) must go through this instead of calling
   * `submitMobileText` directly, or Return silently stops reaching the
   * remote target again exactly as before this fix.
   */
  const submitMobileTextAndEnter = (value: string) => {
    const { text, enter } = splitRemoteDesktopMobileTextEnter(value);
    if (text) submitMobileText(text);
    if (enter) {
      sendMobileShortcut([{ code: 'Enter', key: 'Enter' }]);
      // `submitMobileText` above only clears the field on its own successful
      // send, which never runs at all when `text` is empty (Enter with
      // nothing ahead of it) -- left alone, the DOM value would still hold
      // the very "\n" this function exists to strip out.
      const input = mobileTextInputRef.current;
      if (input) input.value = '';
    }
  };

  const fetchFile = async (requestedPath: string) => {
    const path = requestedPath.trim();
    if (!path) return;
    let destination;
    try {
      destination = await selectPreviewDownloadDestination(path.split(/[/\\]/).pop() || undefined);
    } catch (error) {
      if (isFileUploadCanceled(error)) return;
      setTransferError(t('remote_desktop.file_transfer_failed'));
      return;
    }
    const id = crypto.randomUUID();
    const controller = new AbortController();
    transferControllersRef.current.set(id, controller);
    setTransfers((current) => [...current, {
      id,
      name: path.split(/[/\\]/).pop() || path,
      direction: 'fetch',
      sourcePath: path,
      destinationPath: t('remote_desktop.browser_downloads'),
      progress: 0,
      transport: FILE_DOWNLOAD_TRANSPORT_MODE.CONNECTING,
      status: 'transferring',
      sampledAt: Date.now(),
      sampledBytes: 0,
    }]);
    setTransferError(null);
    let handedOffToBrowser = false;
    try {
      const attachment = await createMachineFileHandle(machine.serverId, path, controller.signal);
      const transferWs = ws?.targetsServer(machine.serverId) ? ws : null;
      if (transferWs) {
        await downloadPreviewWithDirectFallback({
          ws: transferWs,
          serverId: machine.serverId,
          previewHandle: attachment.id,
          suggestedName: path.split(/[/\\]/).pop() || undefined,
          destination,
          httpFallback: () => downloadAttachment(machine.serverId, attachment.id, undefined, controller.signal),
          signal: controller.signal,
          onMode: (transport) => {
            if (transport === FILE_DOWNLOAD_TRANSPORT_MODE.BROWSER) handedOffToBrowser = true;
            updateTransfer(id, { transport });
          },
          onProgress: ({ loadedBytes, totalBytes }) => updateDownloadTransferProgress(id, loadedBytes, totalBytes),
        });
      } else {
        handedOffToBrowser = true;
        updateTransfer(id, { transport: FILE_DOWNLOAD_TRANSPORT_MODE.BROWSER });
        await downloadAttachment(machine.serverId, attachment.id, undefined, controller.signal);
      }
      const savedFile = handedOffToBrowser ? null : savedDownloadFileHandle(destination?.handle);
      // Recorded before the status flips so the finished row renders its buttons.
      if (savedFile) savedFetchFilesRef.current.set(id, savedFile);
      updateTransfer(id, { progress: 100, status: 'done' });
    } catch (error) {
      if (isFileUploadCanceled(error)) {
        updateTransfer(id, { status: 'canceled' });
        return;
      }
      updateTransfer(id, { status: 'error' });
      setTransferError(t('remote_desktop.file_transfer_failed'));
    } finally {
      transferControllersRef.current.delete(id);
    }
  };

  const cancelTransfer = (id: string) => {
    transferControllersRef.current.get(id)?.abort();
  };

  const connected = snapshot.state === REMOTE_DESKTOP_STATE.DIRECT
    || snapshot.state === REMOTE_DESKTOP_STATE.RELAYED;
  const selectedDisplay = snapshot.displays.find((display) => display.id === snapshot.selectedDisplayId);
  const currentStreamPresented = Boolean(snapshot.stream
    && mediaPresented
    && videoRef.current?.srcObject === snapshot.stream);
  const activeConnectionStep = activeRemoteDesktopConnectionStep(snapshot, currentStreamPresented);
  const controllerCount = snapshot.controllerCount ?? (
    snapshot.mode === REMOTE_DESKTOP_ACCESS_MODE.CONTROL ? 1 : 0
  );
  const viewerCount = Math.max(0, (snapshot.viewerCount ?? 1) - controllerCount);

  const panelBody = (
      <div
        ref={panelRef}
        class={`remote-desktop-panel${snapshot.route === 'direct' ? ' is-direct' : ''}${standalone ? ' is-standalone' : ''}`}
        role={embedded ? 'tabpanel' : 'dialog'}
        aria-modal="false"
        aria-label={t('remote_desktop.title', { machine: machine.displayName })}
        hidden={embedded && !active}
        // The phone's keyboard overlays the page rather than resizing it
        // (iOS): end the panel at the keyboard's top edge, so the remote
        // screen is pushed up above it -- re-fitted into what stays visible --
        // instead of being covered.
        // `max-height` as well as `height`: inside the remote-desktop workspace
        // the panel is a `flex: 1` item, whose height is decided by the flex
        // algorithm and ignores `height` -- only a max-height clamps it.
        style={mobileKeyboardViewportInset > 0
          ? {
            height: `calc(100% - ${mobileKeyboardViewportInset}px)`,
            maxHeight: `calc(100% - ${mobileKeyboardViewportInset}px)`,
          }
          : undefined}
      >
        <div class="remote-desktop-toolbar">
          <div class="remote-desktop-display-tabs" role="tablist" aria-label={t('remote_desktop.displays')}>
            {snapshot.displays.map((display) => (
              <button
                key={display.id}
                type="button"
                role="tab"
                aria-selected={display.id === snapshot.selectedDisplayId}
                aria-haspopup="menu"
                title={`${display.label}\n${t('remote_desktop.resolution_hint')}`}
                disabled={!display.available}
                onClick={() => {
                  if (suppressDisplayTabClickRef.current) {
                    suppressDisplayTabClickRef.current = false;
                    if (suppressDisplayTabClickTimerRef.current) {
                      clearTimeout(suppressDisplayTabClickTimerRef.current);
                      suppressDisplayTabClickTimerRef.current = null;
                    }
                    return;
                  }
                  clientRef.current?.selectDisplay(display.id);
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  openDisplayModeMenu(display.id, event.currentTarget);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openDisplayModeMenu(display.id, event.currentTarget, event.clientX, event.clientY);
                }}
                onPointerDown={(event) => beginDisplayTabLongPress(event, display.id)}
                onPointerMove={moveDisplayTabLongPress}
                onPointerUp={(event) => clearDisplayTabLongPress(event.pointerId)}
                onPointerCancel={(event) => clearDisplayTabLongPress(event.pointerId)}
              >
                {remoteDesktopDisplayName(t, snapshot.displays, display)}
              </button>
            ))}
          </div>
          <div class="remote-desktop-mode-switch" role="group" aria-label={t('remote_desktop.mode_label')}>
            <button
              type="button"
              aria-pressed={snapshot.mode === REMOTE_DESKTOP_ACCESS_MODE.VIEW}
              onClick={() => setMode(REMOTE_DESKTOP_ACCESS_MODE.VIEW)}
            >{t('remote_desktop.view_mode')}</button>
            <button
              type="button"
              aria-pressed={snapshot.mode === REMOTE_DESKTOP_ACCESS_MODE.CONTROL}
              disabled={!connected}
              onClick={() => setMode(REMOTE_DESKTOP_ACCESS_MODE.CONTROL)}
            >{t('remote_desktop.control_mode')}</button>
          </div>
          <div class="remote-desktop-view-switch" role="group" aria-label={t('remote_desktop.scale_label')}>
            <button type="button" aria-pressed={viewScale === 'fit'} onClick={() => setViewScale('fit')}>{t('remote_desktop.fit')}</button>
            <button type="button" aria-pressed={viewScale === 'actual'} onClick={() => setViewScale('actual')}>{t('remote_desktop.actual_size')}</button>
            {fullscreen.supported && (
              <button
                type="button"
                aria-pressed={fullscreen.active}
                onClick={() => { void fullscreen.toggle(); }}
              >{t(fullscreen.active ? 'remote_desktop.exit_fullscreen' : 'remote_desktop.fullscreen')}</button>
            )}
          </div>
          <div class="remote-desktop-clipboard-switch" role="group" aria-label={t('remote_desktop.clipboard_label')}>
            <button
              type="button"
              disabled={!snapshot.inputEnabled || clipboardStatus === 'copying'}
              title={inputBlockedHint()}
              onClick={() => { void copyRemoteSelection(); }}
            >{t('common.copy')}</button>
            <button
              type="button"
              disabled={!snapshot.inputEnabled || clipboardStatus === 'pasting'}
              title={inputBlockedHint()}
              onClick={() => { void pasteLocalClipboard(); }}
            >{t('remote_desktop.paste_local_clipboard')}</button>
            {clipboardStatus !== 'idle' && (
              <span class="remote-desktop-clipboard-toast" role="status" aria-live="polite">
                {t(`remote_desktop.clipboard_${clipboardStatus}`)}
              </span>
            )}
          </div>
          <div class="remote-desktop-quality-switch" ref={qualityCustomRef}>
            <button
              ref={qualityTriggerRef}
              type="button"
              class={`remote-desktop-quality-trigger${relayCapped ? ' is-relay-capped' : ''}`}
              aria-haspopup="dialog"
              aria-expanded={qualityCustomOpen}
              aria-label={`${t('remote_desktop.quality_label')}: ${t(`remote_desktop.quality_short_${qualityChoice.mode}`)}`}
              disabled={snapshot.qualityPreferenceSupported === false}
              title={snapshot.qualityPreferenceSupported === false
                ? t('remote_desktop.quality_unsupported')
                : relayCapped ? relayCapText : t('remote_desktop.quality_label')}
              onClick={() => setQualityCustomOpen((open) => !open)}
            >
              <span>{t(`remote_desktop.quality_short_${qualityChoice.mode}`)}</span>
              <span class="remote-desktop-quality-caret" aria-hidden="true">▾</span>
            </button>
            {qualityCustomOpen && qualityPopoverPosition && createPortal((
              <div
                ref={qualityPopoverRef}
                class="remote-desktop-quality-popover"
                role="dialog"
                aria-label={t('remote_desktop.quality_label')}
                style={qualityPopoverPosition}
              >
                <div class="remote-desktop-quality-popover-title">{t('remote_desktop.quality_label')}</div>
                <div class="remote-desktop-quality-modes" role="radiogroup" aria-label={t('remote_desktop.quality_label')}>
                  {QUALITY_MODES.map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={qualityChoice.mode === mode}
                      class="remote-desktop-quality-mode"
                      onClick={() => {
                        updateQualityChoice({ ...qualityChoice, mode });
                        // A preset is a one-tap choice; custom stays open to tune.
                        if (mode !== REMOTE_DESKTOP_QUALITY_MODE.CUSTOM) setQualityCustomOpen(false);
                      }}
                    >
                      <span class="remote-desktop-quality-mode-name">{t(`remote_desktop.quality_short_${mode}`)}</span>
                      <span class="remote-desktop-quality-mode-hint">{t(`remote_desktop.quality_hint_${mode}`)}</span>
                    </button>
                  ))}
                </div>
                {qualityChoice.mode === REMOTE_DESKTOP_QUALITY_MODE.CUSTOM && (
                  <div class="remote-desktop-quality-custom">
                    <label>
                      <span>{t('remote_desktop.quality_resolution')}</span>
                      <select
                        value={String(qualityChoice.custom.maxHeight)}
                        onChange={(event) => updateCustomQuality({
                          maxHeight: Number((event.target as HTMLSelectElement).value) as RemoteDesktopQualityPreference['maxHeight'],
                        })}
                      >
                        {REMOTE_DESKTOP_QUALITY_MAX_HEIGHTS.map((height) => (
                          <option key={height} value={String(height)}>
                            {height === 0
                              ? t('remote_desktop.quality_resolution_native')
                              : height === 2160 ? t('remote_desktop.quality_resolution_4k') : `${height}p`}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>{t('remote_desktop.quality_fps')}</span>
                      <select
                        value={String(qualityChoice.custom.maxFps)}
                        onChange={(event) => updateCustomQuality({
                          maxFps: Number((event.target as HTMLSelectElement).value) as RemoteDesktopQualityPreference['maxFps'],
                        })}
                      >
                        {REMOTE_DESKTOP_QUALITY_MAX_FPS.map((fps) => (
                          <option key={fps} value={String(fps)}>{`${fps} fps`}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>{t('remote_desktop.quality_bitrate')}</span>
                      <select
                        value={String(qualityChoice.custom.maxBitrateBps)}
                        onChange={(event) => updateCustomQuality({
                          maxBitrateBps: Number((event.target as HTMLSelectElement).value),
                        })}
                      >
                        {REMOTE_DESKTOP_QUALITY_BITRATE_OPTIONS.map((bps) => (
                          <option key={bps} value={String(bps)}>
                            {bps === 0 ? t('remote_desktop.quality_bitrate_unlimited') : `${bps / 1_000_000} Mbps`}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>{t('remote_desktop.quality_priority')}</span>
                      <select
                        value={qualityChoice.custom.priority}
                        onChange={(event) => updateCustomQuality({
                          priority: (event.target as HTMLSelectElement).value as RemoteDesktopQualityPreference['priority'],
                        })}
                      >
                        {QUALITY_PRIORITIES.map((priority) => (
                          <option key={priority} value={priority}>{t(`remote_desktop.quality_priority_${priority}`)}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
                {relayCapped && (
                  <p class="remote-desktop-quality-relay-cap">
                    {relayCapText} · {t('remote_desktop.quality_relay_cap_hint')}
                  </p>
                )}
                <p class="remote-desktop-quality-popover-note">{t('remote_desktop.quality_latency_guard_note')}</p>
              </div>
            // In fullscreen only the fullscreen element's subtree is painted.
            ), document.fullscreenElement ?? document.body)}
          </div>
          <div class="remote-desktop-zoom-switch" role="group" aria-label={t('remote_desktop.zoom_label')}>
            <button type="button" aria-label={t('remote_desktop.zoom_out')} disabled={viewport.scale <= 1} onClick={() => changeZoom(-0.5)}>−</button>
            <button type="button" aria-label={t('remote_desktop.zoom_reset')} disabled={viewport.scale === 1 && viewport.x === 0 && viewport.y === 0} onClick={() => commitViewport(INITIAL_REMOTE_DESKTOP_VIEWPORT)}>{Math.round(viewport.scale * 100)}%</button>
            <button type="button" aria-label={t('remote_desktop.zoom_in')} disabled={viewport.scale >= 4} onClick={() => changeZoom(0.5)}>+</button>
          </div>
          <div class="remote-desktop-mobile-input-switch" role="group" aria-label={t('remote_desktop.mobile_input_mode')}>
            <button
              type="button"
              aria-pressed={mobileInputMode === 'touch'}
              onClick={() => setMobileInputMode('touch')}
            >{t('remote_desktop.touch_mode')}</button>
            <button
              type="button"
              aria-pressed={mobileInputMode === 'mouse'}
              onClick={() => setMobileInputMode('mouse')}
            >{t('remote_desktop.mouse_mode')}</button>
            <button
              type="button"
              class="remote-desktop-keyboard-trigger"
              aria-label={t('remote_desktop.mobile_keyboard')}
              aria-expanded={mobileTextOpen}
              aria-pressed={mobileTextOpen}
              disabled={!snapshot.inputEnabled}
              onClick={openMobileKeyboard}
            ><span aria-hidden="true">⌨</span></button>
          </div>
          {snapshot.signInScreen && (
            <button
              type="button"
              class="remote-desktop-unlock-trigger"
              disabled={!snapshot.inputEnabled || !snapshot.unlockAvailable}
              title={inputBlockedHint()
                ?? (snapshot.unlockAvailable
                  ? t('remote_desktop.unlock_hint')
                  : t('remote_desktop.unlock_unconfigured'))}
              onClick={() => { clientRef.current?.requestUnlock(); }}
            >{t('remote_desktop.unlock')}</button>
          )}
          <div class="remote-desktop-quick-input" ref={quickInputTriggerRef}>
            <button
              type="button"
              aria-haspopup="dialog"
              aria-label={t('remote_desktop.quick_input')}
              aria-expanded={quickInputOpen}
              disabled={!hasQuickInputAuthority(clientRef.current)}
              title={inputBlockedHint()}
              onClick={() => quickInputOpen ? closeQuickInput() : openQuickInput()}
            >{t('remote_desktop.quick_input')}</button>
            <QuickInputPanel
              open={quickInputOpen}
              onClose={closeQuickInput}
              onSelect={sendQuickInputText}
              onSend={sendQuickInputText}
              agentType="claude-code"
              sessionName={remoteDesktopQuickInputHistoryKey(hostKey)}
              data={resolvedQuickData.data}
              loaded={resolvedQuickData.loaded}
              onAddCommand={resolvedQuickData.addCommand}
              onAddPhrase={resolvedQuickData.addPhrase}
              onRemoveCommand={resolvedQuickData.removeCommand}
              onRemovePhrase={resolvedQuickData.removePhrase}
              onRemoveHistory={resolvedQuickData.removeHistory}
              onRemoveSessionHistory={resolvedQuickData.removeSessionHistory}
              onClearHistory={resolvedQuickData.clearHistory}
              onClearSessionHistory={resolvedQuickData.clearSessionHistory}
              anchorRef={quickInputTriggerRef}
              quickOnly
              portalZIndex={REMOTE_DESKTOP_QUICK_INPUT_Z_INDEX}
              portalContainer={quickInputPortalContainer}
            />
          </div>
          <button
            type="button"
            class="remote-desktop-files-trigger"
            aria-expanded={filePanelOpen}
            aria-pressed={filePanelOpen}
            onClick={() => setFilePanelOpen((open) => !open)}
          >{t('remote_desktop.files')}</button>
          {!embedded && (
            <div class="remote-desktop-window-actions">
              {!standalone && allowStandaloneWindow && (
                <button
                  type="button"
                  class="subsession-minimize-btn remote-desktop-open-window"
                  aria-label={t('remote_desktop.open_new_window')}
                  title={t('remote_desktop.open_new_window')}
                  onClick={() => {
                    if (openRemoteDesktopWindow(machine.serverId)) stopAndClose();
                  }}
                >↗</button>
              )}
              {/* Nothing to maximise into when the window IS the panel. */}
              {!standalone && (
                <DesktopWindowMaximizeButton
                  maximized={desktopMaximized}
                  class="subsession-minimize-btn remote-desktop-maximize"
                  onClick={() => setDesktopMaximized((current) => !current)}
                />
              )}
              <button
                type="button"
                class="subsession-close-btn remote-desktop-stop"
                aria-label={t('remote_desktop.stop')}
                title={t('remote_desktop.stop')}
                onClick={stopAndClose}
              >×</button>
            </div>
          )}
        </div>

        {controlNotice && (
          <div class="remote-desktop-control-notice" role="alert">{controlNotice.text}</div>
        )}

        {displayModeMenu && (() => {
          const display = snapshot.displays.find((candidate) => candidate.id === displayModeMenu.displayId);
          if (!display?.available) return null;
          return (
            <div
              ref={displayModeMenuRef}
              class="remote-desktop-resolution-menu"
              role="menu"
              aria-label={t('remote_desktop.resolution_menu', { display: remoteDesktopDisplayName(t, snapshot.displays, display) })}
              style={{ left: `${displayModeMenu.x}px`, top: `${displayModeMenu.y}px` }}
            >
              <strong>{t('remote_desktop.resolution_menu', { display: remoteDesktopDisplayName(t, snapshot.displays, display) })}</strong>
              {displayModeOptions(display).map((mode) => (
                <button
                  key={`${mode.width}x${mode.height}`}
                  type="button"
                  role="menuitemradio"
                  aria-checked={display.width === mode.width && display.height === mode.height}
                  // Clickable whenever this viewer holds control: when input is
                  // not ready the click still gets an explanation, which beats a
                  // grey button that never says why.
                  disabled={snapshot.mode !== REMOTE_DESKTOP_ACCESS_MODE.CONTROL}
                  onClick={() => {
                    clientRef.current?.setDisplayMode(display.id, mode.width, mode.height);
                    setDisplayModeMenu(null);
                  }}
                >
                  <span>{mode.label ?? `${mode.width}×${mode.height}`}</span>
                  <small>{mode.label ? `${mode.width}×${mode.height}` : ''}</small>
                </button>
              ))}
              {display.modes === undefined && (
                <small class="remote-desktop-resolution-note">
                  {t('remote_desktop.resolution_unreported')}
                </small>
              )}
              <strong>{t('remote_desktop.dpi_menu')}</strong>
              <div class="remote-desktop-dpi-options" role="group" aria-label={t('remote_desktop.dpi_menu')}>
                {REMOTE_DESKTOP_DPI_SCALE_PERCENTS.map((dpiScalePercent) => (
                  <button
                    key={dpiScalePercent}
                    type="button"
                    role="menuitemradio"
                    aria-label={`${dpiScalePercent}% DPI`}
                    aria-checked={Math.round(display.dpiScale * 100) === dpiScalePercent}
                    disabled={snapshot.mode !== REMOTE_DESKTOP_ACCESS_MODE.CONTROL}
                    onClick={() => {
                      clientRef.current?.setDisplayScale(display.id, dpiScalePercent);
                      setDisplayModeMenu(null);
                    }}
                  >{dpiScalePercent}%</button>
                ))}
              </div>
            </div>
          );
        })()}

        <div
          ref={stageRef}
          class={`remote-desktop-stage is-${viewScale} ${snapshot.inputEnabled ? 'is-controlling' : 'is-viewing'}`}
          aria-busy={mediaRecovering || undefined}
          tabIndex={snapshot.inputEnabled ? 0 : -1}
          onPointerMove={onStagePointerMove}
          onMouseMove={onStageMouseMove}
          onMouseEnter={onStageMouseMove}
          onPointerDown={(event) => onPointerButton(event, true)}
          onPointerUp={(event) => onPointerButton(event, false)}
          onPointerCancel={(event) => {
            if (event.pointerType === 'touch') onTouchEnd(event, true);
            if (event.pointerType !== 'touch'
              && desktopPointerPressesRef.current.delete(event.pointerId)) {
              lastDesktopClickRef.current = null;
            }
            if (commandMiddleDragPointerRef.current === event.pointerId) {
              commandMiddleDragPointerRef.current = null;
            }
            clientRef.current?.releasePointerButtons();
          }}
          onLostPointerCapture={(event) => {
            if (event.pointerType === 'touch' && touchPointsRef.current.has(event.pointerId)) {
              onTouchEnd(event, true);
            }
            if (event.pointerType !== 'touch'
              && desktopPointerPressesRef.current.delete(event.pointerId)) {
              lastDesktopClickRef.current = null;
            }
            if (commandMiddleDragPointerRef.current === event.pointerId) {
              commandMiddleDragPointerRef.current = null;
            }
            clientRef.current?.releasePointerButtons();
          }}
          onWheel={onWheel}
          onKeyDown={(event) => onKey(event, true)}
          onKeyUp={(event) => onKey(event, false)}
          onBlur={releaseCapturedInput}
          // A remote screen: the browser's own menu (copy, save video, select)
          // is meaningless on it whether or not this session controls it.
          onContextMenu={(event) => event.preventDefault()}
          onCompositionEnd={(event) => {
            if (snapshot.inputEnabled) clientRef.current?.text((event as CompositionEvent).data);
          }}
          onPaste={(event) => {
            if (!snapshot.inputEnabled) return;
            if (Date.now() - forwardedPasteShortcutAtRef.current < 750) {
              forwardedPasteShortcutAtRef.current = 0;
              event.preventDefault();
              return;
            }
            const text = (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
            if (sendPastedText(text)) {
              event.preventDefault();
              setClipboardStatus('pasted');
            }
          }}
        >
          <video
            ref={videoRef}
            autoplay
            playsInline
            muted
            draggable={false}
            onLoadedData={() => {
              recordVideoDiagnostic(
                REMOTE_DESKTOP_BROWSER_DIAGNOSTIC_EVENT.VIDEO_LOADED_DATA,
              );
              if (!mediaPresentedRef.current) {
                mediaPresentedRef.current = true;
                setMediaPresented(true);
              }
            }}
            style={{
              ...(viewScale === 'actual' && selectedDisplay
                ? { width: `${selectedDisplay.width}px`, height: `${selectedDisplay.height}px` }
                : {}),
              transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.scale})`,
              transformOrigin: 'center center',
            }}
            aria-label={t('remote_desktop.video_label', { machine: machine.displayName })}
          />
          <canvas
            ref={lastFrameCanvasRef}
            class={`remote-desktop-last-frame ${mediaRecovering && hasCachedFrame ? 'is-visible' : ''}`.trim()}
            style={{
              ...(viewScale === 'actual' && selectedDisplay
                ? { width: `${selectedDisplay.width}px`, height: `${selectedDisplay.height}px` }
                : {}),
              transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.scale})`,
              transformOrigin: 'center center',
            }}
            aria-hidden="true"
          />
          {mediaRecovering && hasCachedFrame && (
            <div class="remote-desktop-media-recovery" role="status" aria-live="polite">
              {t('remote_desktop.media_recovering')}
            </div>
          )}
          {currentStreamPresented && !mediaRecovering && (
            <div
              class="remote-desktop-input-surface"
              data-testid="remote-desktop-input-surface"
              aria-hidden="true"
              onPointerMove={onInputSurfacePointerMove}
              onMouseMove={onInputSurfaceMouseMove}
              onMouseEnter={onInputSurfaceMouseMove}
            />
          )}
          {mobileInputMode === 'mouse' && (
            <>
              <div
                class="remote-desktop-virtual-pointer"
                aria-hidden="true"
                style={{ left: `${virtualMouse.x}px`, top: `${virtualMouse.y}px` }}
              />
              <div
                class="remote-desktop-virtual-mouse"
                role="group"
                aria-label={t('remote_desktop.mouse_controls')}
                onPointerMove={onVirtualMouseMove}
                onPointerUp={endVirtualMouseDrag}
                onPointerCancel={cancelVirtualMousePointer}
                onLostPointerCapture={cancelVirtualMousePointer}
              >
                <div class="remote-desktop-virtual-mouse-buttons">
                  {(['left', 'right'] as const).map((button) => (
                    <button
                      key={button}
                      type="button"
                      aria-label={t(`remote_desktop.mouse_${button}`)}
                      disabled={!snapshot.inputEnabled}
                      onPointerDown={(event) => onVirtualMouseButton(event, button, true)}
                      onPointerUp={(event) => onVirtualMouseButton(event, button, false)}
                      onPointerCancel={(event) => onVirtualMouseButton(event, button, false)}
                      onLostPointerCapture={(event) => onVirtualMouseButton(event, button, false)}
                    >{t(`remote_desktop.mouse_${button}_short`)}</button>
                  ))}
                  <button
                    type="button"
                    class="remote-desktop-virtual-wheel"
                    aria-label={t('remote_desktop.mouse_wheel')}
                    disabled={!snapshot.inputEnabled}
                    onPointerDown={beginVirtualMouseWheel}
                  ><span aria-hidden="true" /></button>
                </div>
                <button
                  type="button"
                  class="remote-desktop-virtual-mouse-handle"
                  aria-label={t('remote_desktop.mouse_drag')}
                  disabled={!snapshot.inputEnabled}
                  onPointerDown={beginVirtualMouseMove}
                ><span aria-hidden="true">✥</span></button>
              </div>
            </>
          )}
          {mobileInputMode === 'touch' && snapshot.inputEnabled && (
            <>
              {/* The actual cursor position -- exactly where a click lands --
                  stays uncovered by the finger, which sits on the ring below
                  it instead. is-touch-ring-marker keeps this hidden outside
                  a coarse (touch) pointer, matching the ring itself -- touch
                  mode is the default even on a desktop app driven by a real
                  mouse, where this would otherwise render as a stray cursor
                  frozen at the stage center. */}
              <div
                class="remote-desktop-virtual-pointer is-touch-ring-marker"
                aria-hidden="true"
                style={{ left: `${virtualMouse.x}px`, top: `${virtualMouse.y}px` }}
              />
              <button
                type="button"
                class={`remote-desktop-touch-ring ${touchRingArmed ? 'is-right' : ''}`.trim()}
                aria-label={t('remote_desktop.touch_ring')}
                style={{
                  left: `${virtualMouse.x}px`,
                  top: `${virtualMouse.y + TOUCH_RING_OFFSET_Y_PX}px`,
                }}
                onPointerDown={beginTouchRing}
                onPointerMove={onTouchRingMove}
                onPointerUp={endTouchRing}
                onPointerCancel={cancelTouchRing}
                onLostPointerCapture={cancelTouchRing}
              />
            </>
          )}
          {mobileInputMode === 'touch' && snapshot.inputEnabled && (
            <button
              type="button"
              class="remote-desktop-touch-right-button"
              aria-label={t('remote_desktop.touch_right_click')}
              onPointerDown={(event) => onTouchRightButton(event, true)}
              onPointerUp={(event) => onTouchRightButton(event, false)}
              onPointerCancel={(event) => onTouchRightButton(event, false)}
              onLostPointerCapture={(event) => onTouchRightButton(event, false)}
            >{t('remote_desktop.mouse_right_short')}</button>
          )}
          {!currentStreamPresented && (
            <div class="remote-desktop-stage-placeholder" role="status">
              {snapshot.state === REMOTE_DESKTOP_STATE.FAILED ? (
                <>
                  <span>
                    {snapshot.terminalReason === REMOTE_DESKTOP_TERMINAL_REASON.SESSION_LIMIT
                      ? t('remote_desktop.session_in_use')
                      : t('remote_desktop.failed', { reason: snapshot.error ?? snapshot.terminalReason ?? '' })}
                  </span>
                  <button type="button" onClick={retryConnection}>
                    {t('remote_desktop.retry')}
                  </button>
                </>
              ) : (
                <div class="remote-desktop-connection-progress">
                  <strong>
                    {snapshot.state === REMOTE_DESKTOP_STATE.RECONNECTING
                      ? t('remote_desktop.connection_retrying', { count: Math.max(1, snapshot.reconnectCount ?? 1) })
                      : t('remote_desktop.connection_optimizing')}
                  </strong>
                  {snapshot.state === REMOTE_DESKTOP_STATE.RECONNECTING
                    && (snapshot.terminalReason ?? snapshot.error) && (
                    // A reconnect with no reason is the same silent failure as
                    // a click that does nothing: the viewer cannot tell a lost
                    // network from a node that refused, and neither can anyone
                    // they report it to.
                    <small class="remote-desktop-retry-reason">
                      {t('remote_desktop.connection_retrying_reason', {
                        reason: snapshot.terminalReason ?? snapshot.error,
                      })}
                    </small>
                  )}
                  {/* Four dots, one per stage. The stage names stay in the DOM
                      for screen readers -- dropping them would leave a
                      non-sighted user with four unlabelled shapes and no way to
                      tell which part of connecting is slow. */}
                  <ol
                    class="remote-desktop-connection-dots"
                    aria-label={t('remote_desktop.connection_progress')}
                  >
                    {REMOTE_DESKTOP_CONNECTION_STEPS.map((step, index) => {
                      const complete = index < activeConnectionStep;
                      const current = index === activeConnectionStep;
                      return (
                        <li
                          key={step}
                          class={complete ? 'is-complete' : current ? 'is-current' : 'is-pending'}
                          aria-current={current ? 'step' : undefined}
                          title={t(`remote_desktop.connection_steps.${step}`)}
                        >
                          <span class="remote-desktop-connection-dot" aria-hidden="true" />
                          <span class="remote-desktop-connection-step-label">
                            {t(`remote_desktop.connection_steps.${step}`)}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              )}
            </div>
          )}
          <div class="remote-desktop-touch-hint">
            {t(mobileInputMode === 'mouse'
              ? 'remote_desktop.mouse_hint'
              : 'remote_desktop.touch_hint')}
          </div>
        </div>

        {/* Docked below the stage in normal flow (a grid row of its own, not an
            overlay on top of the video) so opening it shrinks the visible
            remote screen instead of covering it -- the previous floating panel
            sat on top of the video and, combined with the OS's own on-screen
            keyboard underneath it, could blot out most of a phone screen.
            While the OS keyboard is up the whole panel ends at its top edge
            (see the panel's own height above), so this row still sits
            directly on the keyboard and the stage is re-fitted above it. */}
        {mobileTextOpen && (<>
          <div
            class="remote-desktop-mobile-keyboard"
            role="group"
            aria-label={t('remote_desktop.mobile_keyboard')}
          >
            <div class="remote-desktop-mobile-keyboard-head">
              <div class="remote-desktop-mobile-keyboard-tabs" role="tablist" aria-label={t('remote_desktop.mobile_keyboard')}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mobileKeyboardTab === 'ime'}
                  class={mobileKeyboardTab === 'ime' ? 'is-active' : ''}
                  onClick={() => switchMobileKeyboardTab('ime')}
                >{t('remote_desktop.mobile_keyboard_tab_ime')}</button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mobileKeyboardTab === 'keys'}
                  class={mobileKeyboardTab === 'keys' ? 'is-active' : ''}
                  onClick={() => switchMobileKeyboardTab('keys')}
                >{t('remote_desktop.mobile_keyboard_tab_keys')}</button>
              </div>
              <button
                type="button"
                aria-label={t('remote_desktop.close_mobile_keyboard')}
                onClick={closeMobileKeyboard}
              >×</button>
            </div>

            {mobileKeyboardTab === 'ime' && (
              <>
                {/* Not a compose box the operator reads back -- what they type
                    lands directly on the remote screen, which is the only
                    place it needs to be visible. This element exists purely
                    to hold focus and capture keystrokes/IME composition so
                    the OS keyboard has something to type into; it is never
                    shown. */}
                <textarea
                  ref={mobileTextInputRef}
                  class="remote-desktop-mobile-hidden-input"
                  rows={1}
                  inputMode="text"
                  enterkeyhint="enter"
                  autocapitalize="none"
                  autocomplete="off"
                  spellcheck={false}
                  aria-label={t('remote_desktop.mobile_text_input')}
                  onCompositionStart={(event) => {
                    event.stopPropagation();
                    mobileTextComposingRef.current = true;
                    mobileTextLastCompositionCommitRef.current = null;
                  }}
                  onCompositionEnd={(event) => {
                    event.stopPropagation();
                    mobileTextComposingRef.current = false;
                    const value = (event.currentTarget as HTMLTextAreaElement).value;
                    if (value && mobileTextLastCompositionCommitRef.current !== value) {
                      mobileTextLastCompositionCommitRef.current = value;
                      submitMobileTextAndEnter(value);
                    }
                  }}
                  onBeforeInput={(event) => {
                    event.stopPropagation();
                    const input = event.currentTarget as HTMLTextAreaElement;
                    if (mobileTextComposingRef.current || event.isComposing || input.value) return;
                    const editingKey = isRemoteDesktopMobileLineBreak(event.inputType)
                      ? { code: 'Enter', key: 'Enter' }
                      : remoteDesktopMobileDeletionKey(event.inputType);
                    if (!editingKey) return;
                    event.preventDefault();
                    // Already sent from its keydown, which not every engine
                    // cancels the input for.
                    const sent = mobileEditingKeySentRef.current;
                    mobileEditingKeySentRef.current = null;
                    if (sent && sent.code === editingKey.code
                      && Date.now() - sent.at < MOBILE_EDITING_KEY_DEDUPE_MS) return;
                    sendMobileShortcut([editingKey]);
                  }}
                  onInput={(event) => {
                    event.stopPropagation();
                    if (mobileTextComposingRef.current || event.isComposing) return;
                    const input = event.currentTarget as HTMLTextAreaElement;
                    const lastCompositionCommit = mobileTextLastCompositionCommitRef.current;
                    if (lastCompositionCommit !== null
                      && (input.value === '' || input.value === lastCompositionCommit)) {
                      input.value = '';
                      return;
                    }
                    mobileTextLastCompositionCommitRef.current = null;
                    submitMobileTextAndEnter(input.value);
                  }}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (mobileTextComposingRef.current || event.isComposing) return;
                    // Text still pending goes out through the input path first,
                    // a trailing Return included.
                    if ((event.currentTarget as HTMLTextAreaElement).value) return;
                    const editingKey = remoteDesktopMobileEditingKey(event.key, event.keyCode);
                    if (!editingKey) return;
                    event.preventDefault();
                    mobileEditingKeySentRef.current = { code: editingKey.code, at: Date.now() };
                    sendMobileShortcut([editingKey]);
                  }}
                  onKeyUp={(event) => event.stopPropagation()}
                />
              </>
            )}

            {mobileKeyboardTab === 'keys' && (
              <div class="remote-desktop-computer-keyboard">
                <label class="remote-desktop-combo-toggle">
                  <input type="checkbox" checked={comboMode} onChange={toggleComboMode} />
                  {t('remote_desktop.combo_mode')}
                </label>
                <div
                  class="remote-desktop-computer-keyboard-pages"
                  ref={computerKeyboardPagesViewportRef}
                  onPointerDown={onComputerKeyboardPagesPointerDown}
                  onPointerMove={onComputerKeyboardPagesPointerMove}
                  onPointerUp={onComputerKeyboardPagesPointerUp}
                  onPointerCancel={onComputerKeyboardPagesPointerUp}
                >
                  <div
                    class="remote-desktop-computer-keyboard-track"
                    style={{
                      width: `${REMOTE_DESKTOP_COMPUTER_KEYBOARD_PAGES.length * 100}%`,
                      transform: `translateX(calc(${-computerKeyboardPage * (100 / REMOTE_DESKTOP_COMPUTER_KEYBOARD_PAGES.length)}% + ${computerKeyboardSwipeOffset}px))`,
                      transition: computerKeyboardSwipeOffset === 0 ? 'transform 0.2s ease' : 'none',
                    }}
                  >
                    {REMOTE_DESKTOP_COMPUTER_KEYBOARD_PAGES.map((page, pageIndex) => (
                      <div
                        class="remote-desktop-computer-keyboard-page"
                        style={{ width: `${100 / REMOTE_DESKTOP_COMPUTER_KEYBOARD_PAGES.length}%` }}
                        key={pageIndex}
                      >
                        {page.map((row, rowIndex) => (
                          <div
                            class="remote-desktop-computer-keyboard-row"
                            style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` }}
                            key={rowIndex}
                          >
                            {row.map((spec) => {
                              const label = remoteDesktopComputerKeyLabel(spec, targetPlatform, computerKeyboardCapitals);
                              const caseKey = spec.code === REMOTE_DESKTOP_COMPUTER_CASE_KEY.code;
                              const held = caseKey
                                ? computerKeyboardCapitals
                                : heldComboKeys.some((k) => k.code === spec.code);
                              return (
                                <button
                                  key={`${spec.code}${spec.shifted ? '+shift' : ''}`}
                                  type="button"
                                  class={`${held ? 'is-held' : ''}${spec.upper ? ' has-upper' : ''}`.trim()}
                                  aria-label={caseKey
                                    ? t('remote_desktop.computer_key_case')
                                    : t('remote_desktop.computer_key', { key: label })}
                                  aria-pressed={spec.modifier || caseKey ? held : undefined}
                                  disabled={!snapshot.inputEnabled}
                                  onPointerDown={onComputerKeyPointerDown}
                                  onPointerUp={(event) => onComputerKeyPointerUp(event, spec)}
                                  onPointerCancel={() => { computerKeyPressRef.current = null; }}
                                  onClick={() => onComputerKeyClick(spec)}
                                >
                                  {spec.upper && <span class="remote-desktop-computer-key-upper" aria-hidden="true">{spec.upper}</span>}
                                  {label}
                                </button>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
                {REMOTE_DESKTOP_COMPUTER_KEYBOARD_PAGES.length > 1 && (
                  <div class="remote-desktop-computer-keyboard-dots" role="tablist" aria-label={t('remote_desktop.computer_keyboard_pages')}>
                    {REMOTE_DESKTOP_COMPUTER_KEYBOARD_PAGES.map((_, pageIndex) => (
                      <button
                        key={pageIndex}
                        type="button"
                        role="tab"
                        aria-selected={computerKeyboardPage === pageIndex}
                        class={computerKeyboardPage === pageIndex ? 'is-active' : ''}
                        aria-label={t('remote_desktop.computer_keyboard_page', { page: pageIndex + 1 })}
                        onClick={() => setComputerKeyboardPage(pageIndex)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </>)}

        {filePanelOpen && fileDrawerMinimized && (() => {
          // Minimized to the corner of the window it belongs to, still showing
          // what it is doing: a ring rather than a number, because the point of
          // minimizing is to stop reading and keep watching.
          const { active, progress } = activeTransferProgress(transfers);
          const circumference = 2 * Math.PI * 13;
          return (
            <button
              type="button"
              class="remote-desktop-file-badge"
              aria-label={active > 0
                ? t('remote_desktop.transfers_running', { count: active, progress })
                : t('remote_desktop.restore_files')}
              title={active > 0
                ? t('remote_desktop.transfers_running', { count: active, progress })
                : t('remote_desktop.restore_files')}
              onClick={() => setFileDrawerMinimized(false)}
            >
              <svg viewBox="0 0 32 32" aria-hidden="true">
                <circle class="remote-desktop-file-badge-track" cx="16" cy="16" r="13" />
                {active > 0 && (
                  <circle
                    class="remote-desktop-file-badge-ring"
                    cx="16"
                    cy="16"
                    r="13"
                    style={{
                      strokeDasharray: `${circumference}`,
                      strokeDashoffset: `${circumference * (1 - progress / 100)}`,
                    }}
                  />
                )}
              </svg>
              <span aria-hidden="true">{active > 0 ? `${progress}%` : '⇱'}</span>
            </button>
          );
        })()}

        {filePanelOpen && !fileDrawerMinimized && (
          // Covers the whole remote desktop window rather than floating over it.
          // A draggable window here fought the desktop for pointer input at its
          // edges and could not move anyway once it was this large, so the size
          // that makes it useful is the size that makes a window pointless.
          <aside
            class={`remote-desktop-file-drawer ${REMOTE_DESKTOP_OVERLAY_CLASS}`}
            aria-label={t('remote_desktop.files')}
          >
            <div class="remote-desktop-file-drawer-head">
              <div class="remote-desktop-file-drawer-copy">
                <strong>{t('remote_desktop.files')}</strong>
                <span>{t('remote_desktop.file_transfer_hint')}</span>
              </div>
              <div class="remote-desktop-file-drawer-actions">
                <button
                  type="button"
                  class="remote-desktop-file-control"
                  aria-label={t('remote_desktop.minimize_files')}
                  title={t('remote_desktop.minimize_files')}
                  onClick={() => setFileDrawerMinimized(true)}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3.5 8h9" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="remote-desktop-file-control is-close"
                  aria-label={t('remote_desktop.close_files')}
                  title={t('remote_desktop.close_files')}
                  onClick={() => setFilePanelOpen(false)}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="m4.5 4.5 7 7m0-7-7 7" />
                  </svg>
                </button>
              </div>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              hidden
              multiple
              onChange={(event) => {
                const files = Array.from((event.currentTarget as HTMLInputElement).files ?? []);
                if (files.length > 0) stageLocalFiles(files);
                (event.currentTarget as HTMLInputElement).value = '';
              }}
            />
            <div class="remote-desktop-file-explorer">
              <section class="remote-desktop-file-pane remote-desktop-file-pane-local" aria-label={t('remote_desktop.local_files')}>
                <div class="remote-desktop-file-pane-head">
                  <div>
                    <span>{t('remote_desktop.local_badge')}</span>
                    <strong>{t('remote_desktop.local_files')}</strong>
                  </div>
                  <div class="remote-desktop-file-pane-actions">
                    <button type="button" onClick={() => fileInputRef.current?.click()}>
                      {t('remote_desktop.choose_local_files')}
                    </button>
                    <button
                      type="button"
                      disabled={selectedLocalFiles.length === 0}
                      onClick={() => setSelectedLocalFiles([])}
                    >{t('remote_desktop.clear_selection')}</button>
                  </div>
                </div>
                <div class="remote-desktop-file-path">{t('remote_desktop.browser_selected_files')}</div>
                <div
                  class={`remote-desktop-local-file-list${fileDropActive ? ' is-active' : ''}`}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    setFileDropActive(true);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
                    setFileDropActive(true);
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFileDropActive(false);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setFileDropActive(false);
                    stageLocalFiles(Array.from(event.dataTransfer?.files ?? []));
                  }}
                >
                  {selectedLocalFiles.length === 0 ? (
                    <button type="button" class="remote-desktop-file-empty" onClick={() => fileInputRef.current?.click()}>
                      <strong>{t('remote_desktop.drop_files_here')}</strong>
                      <small>{t('remote_desktop.local_selection_hint')}</small>
                    </button>
                  ) : selectedLocalFiles.map((file) => (
                    <div class="remote-desktop-local-file-row" key={`${file.name}:${file.size}:${file.lastModified}`}>
                      <span title={file.name}>{file.name}</span>
                      <small>{formatByteSize(file.size)}</small>
                      <button
                        type="button"
                        aria-label={t('remote_desktop.remove_selected_file', { name: file.name })}
                        onClick={() => setSelectedLocalFiles((current) => current.filter((candidate) => candidate !== file))}
                      >{t('remote_desktop.remove_file')}</button>
                    </div>
                  ))}
                </div>
              </section>

              <div class="remote-desktop-file-direction-actions" aria-label={t('remote_desktop.transfer_actions')}>
                <button
                  type="button"
                  aria-label={t('remote_desktop.send_to_remote')}
                  disabled={selectedLocalFiles.length === 0 || (supportsDirectoryTransfer && !destinationDirectory)}
                  onClick={sendSelectedFiles}
                >
                  <strong>{t('remote_desktop.send_to_remote')}</strong>
                  <small>{selectedLocalFiles.length > 0
                    ? t('remote_desktop.selected_files_count', { count: selectedLocalFiles.length })
                    : t('remote_desktop.select_local_files')}</small>
                </button>
                <button
                  type="button"
                  aria-label={t('remote_desktop.fetch_to_local')}
                  disabled={!fetchSourcePath}
                  onClick={() => { void fetchFile(fetchSourcePath); }}
                >
                  <strong>{t('remote_desktop.fetch_to_local')}</strong>
                  <small>{fetchSourcePath
                    ? fetchSourcePath.split(/[/\\]/).pop()
                    : t('remote_desktop.select_remote_file')}</small>
                </button>
              </div>

              <section class="remote-desktop-file-pane remote-desktop-file-pane-remote" aria-label={t('remote_desktop.remote_files')}>
                <div class="remote-desktop-file-pane-head">
                  <div>
                    <span class="is-remote">{t('remote_desktop.remote_badge')}</span>
                    <strong>{machine.displayName}</strong>
                  </div>
                  <small>{supportsDirectoryTransfer
                    ? t('remote_desktop.remote_folder_ready')
                    : supportsPathHandleTransfer
                      ? t('remote_desktop.fetch_path')
                      : t('remote_desktop.file_destination_upgrade_hint')}</small>
                </div>
                <div
                  class="remote-desktop-file-path"
                  title={(supportsDirectoryTransfer ? destinationDirectory : fetchSourcePath) || undefined}
                >
                  {supportsDirectoryTransfer
                    ? destinationDirectory || t('remote_desktop.choose_destination_folder')
                    : fetchSourcePath || t('remote_desktop.fetch_path')}
                </div>
                <div class="remote-desktop-remote-browser">
                  {supportsDirectoryTransfer ? (
                    <FileBrowser
                      ws={machineDirectoryAdapter.asWsClient()}
                      mode="file-single"
                      layout="panel"
                      initialPath={FILE_TRANSFER_DIRECTORY_PATH.WINDOWS_DRIVES}
                      serverId={machine.serverId}
                      readOnly
                      hideFooter
                      hideBreadcrumbConfirm
                      quickAccess
                      onCurrentPathChange={handleRemotePathChange}
                      onSelectedPathChange={handleRemoteSelectionChange}
                      onPreviewFile={() => {}}
                      onConfirm={(paths) => setSelectedRemoteFile(paths[0] ?? '')}
                    />
                  ) : supportsPathHandleTransfer ? (
                    <label class="remote-desktop-legacy-fetch">
                      <span>{t('remote_desktop.fetch_path')}</span>
                      <input
                        value={legacyFetchPath}
                        onInput={(event) => setLegacyFetchPath((event.currentTarget as HTMLInputElement).value)}
                        placeholder={t('remote_desktop.fetch_path')}
                        aria-label={t('remote_desktop.fetch_path')}
                        autoComplete="off"
                        spellcheck={false}
                      />
                      <small>{t('remote_desktop.file_destination_upgrade_hint')}</small>
                    </label>
                  ) : (
                    <div class="remote-desktop-file-empty is-compatibility">
                      <strong>{t('remote_desktop.file_destination_upgrade_hint')}</strong>
                    </div>
                  )}
                </div>
              </section>
            </div>

            <section class="remote-desktop-transfer-queue" aria-label={t('remote_desktop.transfer_queue')}>
              <div class="remote-desktop-transfer-queue-head">
                <div>
                  <strong>{t('remote_desktop.transfer_queue')}</strong>
                  <span>{t('remote_desktop.transfer_queue_count', { count: transfers.length })}</span>
                </div>
                <button
                  type="button"
                  disabled={!transfers.some((transfer) => transfer.status !== 'transferring')}
                  onClick={() => setTransfers((current) => {
                    for (const transfer of current) {
                      if (transfer.status !== 'transferring') savedFetchFilesRef.current.delete(transfer.id);
                    }
                    return current.filter((transfer) => transfer.status === 'transferring');
                  })}
                >{t('remote_desktop.clear_completed_transfers')}</button>
              </div>
              <div class="remote-desktop-transfer-list" aria-live="polite">
                {transfers.length === 0 ? (
                  <div class="remote-desktop-transfer-empty">{t('remote_desktop.no_transfer_tasks')}</div>
                ) : transfers.map((transfer) => (
                  <div class="remote-desktop-transfer-row" key={transfer.id}>
                    <span class="remote-desktop-transfer-name">{transfer.name}</span>
                    <span class={`remote-desktop-transfer-direction is-${transfer.direction}`}>
                      {t(`remote_desktop.transfer_direction_${transfer.direction}`)}
                    </span>
                    <span>{t(`upload.transport.${transfer.transport}`)}</span>
                    <progress
                      value={transfer.progress}
                      max={100}
                      aria-label={t('remote_desktop.transfer_progress', { progress: transfer.progress })}
                    />
                    <span class="remote-desktop-transfer-meta">
                      {transfer.progress}%
                      {transfer.status === 'transferring' && transfer.bytesPerSecond
                        ? ` · ${formatByteRate(transfer.bytesPerSecond)}`
                        : ''}
                      {transfer.sizeBytes ? ` · ${formatByteSize(transfer.sizeBytes)}` : ''}
                    </span>
                    <span class="remote-desktop-transfer-paths" title={`${transfer.sourcePath} → ${transfer.destinationPath}`}>
                      {transfer.sourcePath} → {transfer.destinationPath}
                    </span>
                    <span>{t(`remote_desktop.transfer_status_${transfer.status}`)}</span>
                    {transfer.status === 'transferring' && (
                      <button
                        type="button"
                        aria-label={t('remote_desktop.cancel_transfer', { name: transfer.name })}
                        onClick={() => cancelTransfer(transfer.id)}
                      >{t('upload.cancel')}</button>
                    )}
                    {transfer.direction === 'fetch' && transfer.status === 'done'
                      && savedFetchFilesRef.current.has(transfer.id) && canRevealSavedDownload() && (
                      <button
                        type="button"
                        title={t('downloads.open_folder_hint')}
                        onClick={() => {
                          const savedFile = savedFetchFilesRef.current.get(transfer.id);
                          if (savedFile) revealSavedDownload(savedFile);
                        }}
                      >{t('downloads.open_folder')}</button>
                    )}
                  </div>
                ))}
              </div>
              {transferError && <span role="alert">{transferError}</span>}
            </section>
          </aside>
        )}

        <footer class="remote-desktop-footer">
          {/* Always on: the facts you read while judging whether the session is
              usable -- who is on it, over which link, at what resolution, frame
              rate, bitrate and loss, and for how long. The nerd toggle keeps the
              counters that only matter once something is already wrong. */}
          <div class="remote-desktop-connection-summary">
            <div class="remote-desktop-stats" aria-label={t('remote_desktop.diagnostics')}>
              <span class="remote-desktop-diagnostic-machine">{machine.displayName}</span>
              <span>{t(`remote_desktop.state.${snapshot.state}`)}</span>
              <span aria-live="polite" data-viewer-count={viewerCount}>{t('remote_desktop.viewers', { count: viewerCount })}</span>
              <span aria-live="polite" data-controller-count={controllerCount}>{t('remote_desktop.controllers', { count: controllerCount })}</span>
              <span>{t('remote_desktop.route', { route: snapshot.route ?? '—' })}</span>
              {selectedDisplay && <span>{selectedDisplay.width}×{selectedDisplay.height} · {Math.round(selectedDisplay.dpiScale * 100)}% DPI</span>}
              {snapshot.quality && (
                <>
                  <span>{snapshot.quality.width}×{snapshot.quality.height} · {snapshot.quality.fps.toFixed(0)} FPS</span>
                  <span>{(snapshot.quality.bitrateBps / 1_000_000).toFixed(1)} Mbps · {snapshot.quality.rttMs.toFixed(0)} ms</span>
                  {snapshot.quality.encoderClass && (
                    <span>{t('remote_desktop.encoder', { encoder: snapshot.quality.encoderClass })}</span>
                  )}
                  {snapshot.quality.preset && (
                    <span>{t('remote_desktop.quality', { preset: snapshot.quality.preset })}</span>
                  )}
                  <span>{t('remote_desktop.dropped_frames', { count: snapshot.quality.droppedFrames })}</span>
                </>
              )}
              <span>{t('remote_desktop.duration', { seconds: Math.floor((snapshot.durationMs ?? 0) / 1000) })}</span>
            </div>
            <button
              type="button"
              class="remote-desktop-nerd-toggle"
              aria-label={t(nerdStatsOpen
                ? 'remote_desktop.nerd_stats_hide'
                : 'remote_desktop.nerd_stats_show')}
              aria-expanded={nerdStatsOpen}
              aria-controls={`remote-desktop-diagnostics-${machine.serverId}`}
              onClick={() => setNerdStatsOpen((open) => !open)}
            >{t('remote_desktop.nerd_stats')}</button>
          </div>
          {nerdStatsOpen && (
            <div
              id={`remote-desktop-diagnostics-${machine.serverId}`}
              class="remote-desktop-diagnostics"
              aria-label={t('remote_desktop.diagnostics')}
            >
              {snapshot.pointerMovesSent !== undefined && (
                <span>{t('remote_desktop.pointer_move_connection', {
                  calls: snapshot.pointerMoveCalls ?? 0,
                  sent: snapshot.pointerMovesSent,
                  mirrored: snapshot.pointerMovesMirrored ?? 0,
                  gate: snapshot.pointerMoveGateRejected ?? 0,
                  channel: snapshot.pointerMoveChannelUnavailable ?? 0,
                  backpressure: snapshot.pointerMoveBackpressureDrops ?? 0,
                  failed: snapshot.pointerMoveSendFailures ?? 0,
                })}</span>
              )}
              <span title={`window mouse ${pointerMoveIngressBySource['window-mouse']} · window pointer ${pointerMoveIngressBySource['window-pointer']} · stage mouse ${pointerMoveIngressBySource['stage-mouse']} · stage pointer ${pointerMoveIngressBySource['stage-pointer']}`}>
                {t('remote_desktop.pointer_move_browser', {
                  ingress: pointerMovesIngress,
                  accepted: pointerMovesSeen,
                  unmapped: pointerMovesUnmapped,
                  outside: pointerMovesOutside,
                })}
              </span>
              {inputBlockedHint() && (
                <span class="remote-desktop-input-blocked">{inputBlockedHint()}</span>
              )}
              <span>{t('remote_desktop.reconnects', { count: snapshot.reconnectCount ?? 0 })}</span>
              <span>{t('remote_desktop.capability', { version: snapshot.capabilityVersion ?? REMOTE_DESKTOP_CAPABILITY })}</span>
            </div>
          )}
        </footer>
      </div>
  );

  if (embedded) return panelBody;

  // A window of its own is already the right size. Wrapping it in a draggable
  // 1200x760 panel meant every tear-off opened small inside an empty window and
  // had to be maximised by hand -- and a floating panel that fills its own
  // window can only be moved off its own edges.
  if (standalone) return panelBody;

  return (
    <FloatingPanel
      id={`remote-desktop-${machine.serverId}`}
      title={t('remote_desktop.title', { machine: machine.displayName })}
      onClose={stopAndClose}
      zIndex={zIndex ?? 10020}
      onFocus={onFocus}
      defaultW={1200}
      defaultH={760}
      minW={640}
      minH={420}
      enableMaximize
      isMaximized={desktopMaximized}
      onToggleMaximized={() => setDesktopMaximized((current) => !current)}
      className="remote-desktop-floating-shell"
      hideTitleBar
      dragHandleSelector=".remote-desktop-toolbar"
    >
      {panelBody}
    </FloatingPanel>
  );
}
