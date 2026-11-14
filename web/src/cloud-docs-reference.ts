import type { WorkspaceBounds, WindowGeometry } from './desktop-window-maximize.js';
import { getFrontmostSubSessionId, type MutableDesktopWindowStack } from './window-stack.js';

export type CloudDocQuoteTarget =
  | {
      kind: 'cloud_doc';
      docId: string;
      name: string;
      mimeType?: string;
    }
  | {
      kind: 'server_file';
      path: string;
      name: string;
      serverId?: string;
    };

export type ResolvedQuoteDestination =
  | { kind: 'sub'; subId: string; sessionName: string; label?: string | null }
  | { kind: 'main'; sessionName: string };

const DEFAULT_DOCK_MIN_W = 420;
const DEFAULT_DOCK_MIN_H = 360;
const DEFAULT_DOCK_GAP_ABOVE_COMPOSER_PX = 12;
const DEFAULT_DOCK_EDGE_PADDING_PX = 8;
const DEFAULT_FALLBACK_COMPOSER_RESERVE_PX = 140;

export function sanitizeCloudDocQuoteName(raw: string): string {
  const cleaned = raw
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ')
    .replace(/[|\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'Untitled';
}

function sanitizeCloudDocQuoteIdOrPath(raw: string): string {
  return raw.replace(/[\r\n\t\x00-\x1f\x7f]/g, '').trim();
}

export function getCloudDocQuoteKey(target: CloudDocQuoteTarget): string {
  if (target.kind === 'cloud_doc') {
    return `cloud_doc:${sanitizeCloudDocQuoteIdOrPath(target.docId)}`;
  }
  return `server_file:${target.serverId ?? ''}:${sanitizeCloudDocQuoteIdOrPath(target.path)}`;
}

/**
 * Formats an inline quote reference for composer insertion.
 * Ends with a trailing space and intentionally avoids leading inline triggers (`@`, `;`, `^`, `%`, `/`)
 * on cloud_doc references so composer popups do not open unexpectedly.
 */
export function formatCloudDocQuoteText(target: CloudDocQuoteTarget): string {
  return `${formatCloudDocQuoteBadge(target)} `;
}

/**
 * Formats a compact, self-identifying quote string for SessionControls `quotes` pills.
 */
export function formatCloudDocQuoteBadge(target: CloudDocQuoteTarget): string {
  if (target.kind === 'cloud_doc') {
    const cleanName = sanitizeCloudDocQuoteName(target.name);
    const cleanId = sanitizeCloudDocQuoteIdOrPath(target.docId);
    return `[CloudDoc: ${cleanName} | id=${cleanId}]`;
  }
  const cleanPath = sanitizeCloudDocQuoteIdOrPath(target.path);
  return cleanPath.startsWith('@') ? cleanPath : `@${cleanPath}`;
}

export interface ResolveCloudDocQuoteTargetInput {
  openSubIds: ReadonlySet<string>;
  stack?: MutableDesktopWindowStack | null;
  focusedSubId?: string | null;
  subSessions: ReadonlyArray<{ id: string; sessionName: string; label?: string | null }>;
  activeSession: string | null | undefined;
}

export function resolveCloudDocQuoteTarget(
  input: ResolveCloudDocQuoteTargetInput,
): ResolvedQuoteDestination | null {
  const findOpenSub = (id: string | null | undefined) => {
    if (!id || !input.openSubIds.has(id)) return null;
    const sub = input.subSessions.find((item) => item.id === id);
    return sub?.sessionName
      ? ({ kind: 'sub', subId: sub.id, sessionName: sub.sessionName, label: sub.label } as const)
      : null;
  };

  const stackFrontmost = input.stack
    ? findOpenSub(getFrontmostSubSessionId(input.stack, input.openSubIds))
    : null;
  if (stackFrontmost) return stackFrontmost;

  const focusedSub = findOpenSub(input.focusedSubId);
  if (focusedSub) return focusedSub;

  for (const sub of input.subSessions) {
    if (input.openSubIds.has(sub.id) && sub.sessionName) {
      return { kind: 'sub', subId: sub.id, sessionName: sub.sessionName, label: sub.label };
    }
  }

  if (input.activeSession) {
    return { kind: 'main', sessionName: input.activeSession };
  }
  return null;
}

export interface ComputeRightHalfCloudDocsGeometryInput {
  workspaceBounds: WorkspaceBounds;
  composerTopPx?: number | null;
  minW?: number;
  minH?: number;
  gapAboveComposerPx?: number;
  edgePaddingPx?: number;
}

/**
 * Docks Cloud Docs to the right half of the workspace with its bottom edge
 * positioned above the active main session's bottom composer bar.
 */
export function computeRightHalfUnobstructedCloudDocsGeometry(
  input: ComputeRightHalfCloudDocsGeometryInput,
): WindowGeometry {
  const { workspaceBounds } = input;
  const minW = Math.max(240, input.minW ?? DEFAULT_DOCK_MIN_W);
  const minH = Math.max(240, input.minH ?? DEFAULT_DOCK_MIN_H);
  const gap = Math.max(0, input.gapAboveComposerPx ?? DEFAULT_DOCK_GAP_ABOVE_COMPOSER_PX);
  const pad = Math.max(0, input.edgePaddingPx ?? DEFAULT_DOCK_EDGE_PADDING_PX);

  const boundsX = Number.isFinite(workspaceBounds.x) ? workspaceBounds.x : 0;
  const boundsY = Number.isFinite(workspaceBounds.y) ? workspaceBounds.y : 0;
  const boundsW = Math.max(minW, Number.isFinite(workspaceBounds.w) ? workspaceBounds.w : minW);
  const boundsH = Math.max(minH, Number.isFinite(workspaceBounds.h) ? workspaceBounds.h : minH);

  const halfW = Math.floor(boundsW / 2) - pad;
  const w = Math.round(Math.min(boundsW, Math.max(minW, halfW)));
  const rightPadding = w + pad <= boundsW ? pad : Math.max(0, boundsW - w);
  const x = Math.round(Math.max(boundsX, boundsX + boundsW - w - rightPadding));

  const boundsBottom = boundsY + boundsH;
  const rawBottomLimit = input.composerTopPx != null && Number.isFinite(input.composerTopPx)
    ? input.composerTopPx - gap
    : boundsBottom - DEFAULT_FALLBACK_COMPOSER_RESERVE_PX;
  const clampedBottom = Math.min(boundsBottom, rawBottomLimit);
  const availableAboveComposer = clampedBottom - boundsY;
  const y = Math.round(boundsY + Math.min(pad, Math.max(0, availableAboveComposer - minH)));
  const maxHeightAboveComposer = Math.max(200, Math.floor(clampedBottom - y));
  const h = Math.round(Math.min(boundsH, Math.max(Math.min(minH, maxHeightAboveComposer), maxHeightAboveComposer)));

  return { x, y, w, h };
}

/**
 * Formats the text segment to append to an existing composer value so it separates cleanly with one space when needed.
 */
export function formatCloudDocQuoteAppendText(existing: string, quoteText: string): string {
  const needsGap = existing.length > 0 && !/[\s\n]$/.test(existing);
  return `${needsGap ? ' ' : ''}${quoteText}`;
}

/**
 * Joins existing composer text with a newly quoted CloudDoc/file reference using a single separator space when needed.
 */
export function mergeCloudDocQuoteText(existing: string, quoteText: string): string {
  return `${existing}${formatCloudDocQuoteAppendText(existing, quoteText)}`;
}

export interface ExecuteCloudDocQuoteInput {
  target: CloudDocQuoteTarget;
  openSubIds: ReadonlySet<string>;
  stack?: MutableDesktopWindowStack | null;
  focusedSubId?: string | null;
  subSessions: ReadonlyArray<{ id: string; sessionName: string; label?: string | null }>;
  activeSession: string | null | undefined;
  isMobile: boolean;
  showCloudDocs: boolean;
  getInputElement: (sessionName: string) => HTMLDivElement | null;
  getWorkspaceBounds: () => WorkspaceBounds | null;
  bringSubToFront: (subId: string) => void;
  setShowCloudDocs: (open: boolean) => void;
  setDesktopCloudDocsMaximized: (maximized: boolean) => void;
  requestCloudDocsGeometry: (geometry: WindowGeometry) => void;
  appendComposerText: (inputEl: HTMLDivElement, text: string) => void;
  focusComposer: (inputEl: HTMLDivElement) => void;
  appendPendingPrefill: (sessionName: string, quoteText: string) => void;
  scheduleFrame?: (cb: () => void) => void;
}

/**
 * Routes a Cloud Docs quote action to the frontmost open sub-session or active main session,
 * unmaximizing and docking the desktop Cloud Docs FloatingPanel on the right half above the composer
 * whenever the destination is the desktop main session.
 */
export function executeCloudDocQuote(input: ExecuteCloudDocQuoteInput): ResolvedQuoteDestination | null {
  const destination = resolveCloudDocQuoteTarget({
    openSubIds: input.openSubIds,
    stack: input.stack,
    focusedSubId: input.focusedSubId,
    subSessions: input.subSessions,
    activeSession: input.activeSession,
  });
  if (!destination) return null;

  const quoteText = formatCloudDocQuoteText(input.target);
  const inputEl = input.getInputElement(destination.sessionName);

  if (destination.kind === 'sub') {
    if (!input.isMobile) {
      input.bringSubToFront(destination.subId);
    } else {
      input.setShowCloudDocs(false);
    }
  } else if (input.isMobile) {
    input.setShowCloudDocs(false);
  } else if (input.showCloudDocs) {
    const workspaceBounds = input.getWorkspaceBounds();
    if (workspaceBounds) {
      const composerHost = inputEl?.closest<HTMLElement>('.controls-wrapper') ?? inputEl;
      const composerRect = composerHost?.getBoundingClientRect();
      const composerTopPx = composerRect && composerRect.height > 0 ? composerRect.top : null;
      const dockedGeometry = computeRightHalfUnobstructedCloudDocsGeometry({
        workspaceBounds,
        composerTopPx,
        minW: DEFAULT_DOCK_MIN_W,
        minH: DEFAULT_DOCK_MIN_H,
      });
      input.setDesktopCloudDocsMaximized(false);
      input.requestCloudDocsGeometry(dockedGeometry);
    } else {
      input.setDesktopCloudDocsMaximized(false);
    }
  }

  const runAfterFrame = input.scheduleFrame
    ?? (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null);

  if (inputEl && inputEl.isConnected) {
    input.appendComposerText(inputEl, formatCloudDocQuoteAppendText(inputEl.textContent ?? '', quoteText));
    if (runAfterFrame) {
      runAfterFrame(() => {
        if (destination.kind === 'sub' && !input.isMobile) {
          input.bringSubToFront(destination.subId);
        }
        const liveEl = input.getInputElement(destination.sessionName);
        if (liveEl && liveEl.isConnected) {
          input.focusComposer(liveEl);
        }
      });
    }
  } else {
    input.appendPendingPrefill(destination.sessionName, quoteText);
    if (destination.kind === 'sub' && !input.isMobile && runAfterFrame) {
      runAfterFrame(() => {
        input.bringSubToFront(destination.subId);
      });
    }
  }

  return destination;
}
