import type { WorkspaceBounds, WindowGeometry } from './desktop-window-maximize.js';
import { getFrontmostSubSessionId, type MutableDesktopWindowStack } from './window-stack.js';
import {
  formatCloudDocCitation,
  sanitizeCloudDocCitationId,
  sanitizeCloudDocQuoteName,
} from '../../shared/cloud-docs.js';

export { sanitizeCloudDocQuoteName };

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

export function getCloudDocQuoteKey(target: CloudDocQuoteTarget): string {
  if (target.kind === 'cloud_doc') {
    return `cloud_doc:${sanitizeCloudDocCitationId(target.docId)}`;
  }
  return `server_file:${target.serverId ?? ''}:${sanitizeCloudDocCitationId(target.path)}`;
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
    return formatCloudDocCitation(target.name, target.docId);
  }
  const cleanPath = sanitizeCloudDocCitationId(target.path);
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

export interface CloudDocTextSegment {
  type: 'text' | 'cloud_doc';
  value: string;
  start: number;
  end: number;
  docId?: string;
  label?: string;
  kind?: 'quote' | 'id' | 'paired_file';
}

const CLOUD_DOC_ID_BODY = 'cdoc_[A-Za-z0-9_-]{4,}';
const CLOUD_DOC_QUOTE_TAG_EXACT_RE = /^\s*\[CloudDoc:\s*([^\]|\n]+?)\s*\|\s*id=([^\]\s]+)\]\s*$/;
const CLOUD_DOC_QUOTE_TAG_GLOBAL_RE = /\[CloudDoc:\s*([^\]|\n]+?)\s*\|\s*id=([^\]\s]+)\]/g;
const CLOUD_DOC_ID_EXACT_RE = new RegExp(`^\\s*(?:id\\s*=\\s*)?(${CLOUD_DOC_ID_BODY})\\s*$`);
const CLOUD_DOC_ID_GLOBAL_RE = new RegExp(`(?<![A-Za-z0-9_])(?:id\\s*=\\s*)?(${CLOUD_DOC_ID_BODY})(?![A-Za-z0-9_-])`, 'g');
const CLOUD_DOC_FIRST_ID_RE = new RegExp(`(?<![A-Za-z0-9_])(?:id\\s*=\\s*)?(${CLOUD_DOC_ID_BODY})(?![A-Za-z0-9_-])`);
const CLOUD_DOC_TRAILING_CANDIDATE_FILE_RE = /(?:\\\\[\w.$ -]+\\[\w.$ \\-]+|[A-Za-z]:\\(?:[\w.$ -]+\\)*[\w.$ -]+|(?:\.{1,2}[/\\]|~[/\\]|[/\\])?[^\s`'"<>()[\]{}（）【】《》「」『』,，;；:：!?！？。]+\.[A-Za-z0-9]{1,10})/g;
const CLOUD_DOC_GAP_OPEN_RE = /^[ \t]*(?:[`*_]+[ \t]*)?[（([【:：,，—-]/;
const CLOUD_DOC_GAP_DIRECT_ID_RE = /^[ \t]*(?:[`*_]+[ \t]*)?(?:id[ \t]*=[ \t]*)?$/;
const CLOUD_DOC_GAP_FORBIDDEN_RE = /[\r\n)）\]】。；;！？!?]|\.[A-Za-z0-9]{1,10}(?![A-Za-z0-9])/;

/** Parse an exact `[CloudDoc: <name> | id=<docId>]` quote token. */
export function parseCloudDocQuoteTag(text: string): { docId: string; name: string } | null {
  const match = CLOUD_DOC_QUOTE_TAG_EXACT_RE.exec(text);
  if (!match) return null;
  const name = match[1]!.trim();
  const docId = match[2]!.trim();
  if (!name || !docId) return null;
  return { docId, name };
}

/** Extract an exact `cdoc_...` or `id=cdoc_...` token (trimmed). */
export function extractCloudDocIdToken(text: string): { docId: string; raw: string } | null {
  const match = CLOUD_DOC_ID_EXACT_RE.exec(text);
  if (!match) return null;
  return { docId: match[1]!, raw: text.trim() };
}

/**
 * Determine whether text immediately following a file reference pairs that file
 * with a `cdoc_...` Cloud Doc ID on the same clause/line.
 */
export function findPairedCloudDocIdInTrailingText(followingText: string): string | null {
  if (!followingText) return null;
  const newlineIdx = followingText.search(/[\r\n]/);
  const sameLine = newlineIdx >= 0 ? followingText.slice(0, newlineIdx) : followingText;
  const window = sameLine.slice(0, 120);
  const idMatch = CLOUD_DOC_FIRST_ID_RE.exec(window);
  if (!idMatch || idMatch.index === undefined) return null;
  const gap = window.slice(0, idMatch.index);
  if (gap.length > 80) return null;
  if (!CLOUD_DOC_GAP_OPEN_RE.test(gap) && !CLOUD_DOC_GAP_DIRECT_ID_RE.test(gap)) {
    return null;
  }
  if (CLOUD_DOC_GAP_FORBIDDEN_RE.test(gap)) return null;
  return idMatch[1]!;
}

/** Split text by `[CloudDoc: <name> | id=<docId>]` quote tags first (before URL/path parsing). */
export function splitTextByCloudDocQuoteTags(text: string): CloudDocTextSegment[] {
  if (!text.includes('[CloudDoc:')) {
    return text ? [{ type: 'text', value: text, start: 0, end: text.length }] : [];
  }
  const segments: CloudDocTextSegment[] = [];
  let last = 0;
  CLOUD_DOC_QUOTE_TAG_GLOBAL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CLOUD_DOC_QUOTE_TAG_GLOBAL_RE.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (start > last) {
      segments.push({ type: 'text', value: text.slice(last, start), start: last, end: start });
    }
    const name = match[1]!.trim();
    const docId = match[2]!.trim();
    segments.push({
      type: 'cloud_doc',
      value: match[0],
      start,
      end,
      docId,
      label: name,
      kind: 'quote',
    });
    last = end;
  }
  if (last < text.length) {
    segments.push({ type: 'text', value: text.slice(last), start: last, end: text.length });
  }
  return segments;
}

/**
 * Split a non-URL plain-text segment into `cdoc_...` references, paired filename+cdoc_...
 * references, and plain text. Unpaired ordinary file paths remain in `'text'` segments.
 */
export function splitPlainTextByCloudDocIds(text: string): CloudDocTextSegment[] {
  if (!text || !text.includes('cdoc_')) {
    return text ? [{ type: 'text', value: text, start: 0, end: text.length }] : [];
  }

  const idMatches: Array<{ start: number; end: number; raw: string; docId: string }> = [];
  CLOUD_DOC_ID_GLOBAL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLOUD_DOC_ID_GLOBAL_RE.exec(text)) !== null) {
    idMatches.push({
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
      docId: m[1]!,
    });
  }
  if (idMatches.length === 0) {
    return [{ type: 'text', value: text, start: 0, end: text.length }];
  }

  const cloudSpans: CloudDocTextSegment[] = [];
  let searchFloor = 0;
  for (const idHit of idMatches) {
    const windowStart = Math.max(searchFloor, idHit.start - 120);
    const prefix = text.slice(windowStart, idHit.start);
    let lastCand: { start: number; end: number; raw: string } | null = null;
    CLOUD_DOC_TRAILING_CANDIDATE_FILE_RE.lastIndex = 0;
    let fm: RegExpExecArray | null;
    while ((fm = CLOUD_DOC_TRAILING_CANDIDATE_FILE_RE.exec(prefix)) !== null) {
      lastCand = {
        start: windowStart + fm.index,
        end: windowStart + fm.index + fm[0].length,
        raw: fm[0],
      };
    }
    if (lastCand && findPairedCloudDocIdInTrailingText(text.slice(lastCand.end)) === idHit.docId) {
      cloudSpans.push({
        type: 'cloud_doc',
        value: lastCand.raw,
        start: lastCand.start,
        end: lastCand.end,
        docId: idHit.docId,
        label: lastCand.raw,
        kind: 'paired_file',
      });
    }
    cloudSpans.push({
      type: 'cloud_doc',
      value: idHit.raw,
      start: idHit.start,
      end: idHit.end,
      docId: idHit.docId,
      label: idHit.raw,
      kind: 'id',
    });
    searchFloor = idHit.end;
  }

  const out: CloudDocTextSegment[] = [];
  let cursor = 0;
  for (const span of cloudSpans) {
    if (span.start < cursor) continue;
    if (span.start > cursor) {
      out.push({ type: 'text', value: text.slice(cursor, span.start), start: cursor, end: span.start });
    }
    out.push(span);
    cursor = span.end;
  }
  if (cursor < text.length) {
    out.push({ type: 'text', value: text.slice(cursor), start: cursor, end: text.length });
  }
  return out;
}
