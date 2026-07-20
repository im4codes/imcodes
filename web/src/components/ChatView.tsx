/**
 * ChatView — renders TimelineEvent[] as a chat-style view.
 * Merges consecutive streaming assistant.text events into single blocks.
 * Supports basic Markdown rendering (code blocks, inline code, bold).
 */
import { h } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from 'preact/hooks';
import { memo } from 'preact/compat';
import { useTranslation } from 'react-i18next';
import type {
  TimelineEvent,
  WsClient,
  MemoryContextTimelinePayload,
  MemoryContextTimelineItem,
  MemoryContextTimelinePreferenceItem,
} from '../ws-client.js';
import type { FileChangeBatch, FileChangePatch } from '@shared/file-change.js';
import { FS_READ_ERROR_CODES } from '@shared/fs-read-error-codes.js';
import {
  SDK_SUBAGENT_DETAIL_KIND,
  SDK_SUBAGENT_DIAGNOSTIC,
  SDK_SUBAGENT_PROVIDERS,
  SDK_SUBAGENT_STATUS,
} from '@shared/sdk-subagent-status.js';
import { parseUnifiedDiff } from '@shared/unified-diff.js';
import { isHtmlPreviewPath, type HtmlPreviewViewMode } from '@shared/html-preview.js';
import { FileBrowser, type FileBrowserPreviewRequest } from './file-browser-lazy.js';
import { ChatMarkdown } from './ChatMarkdown.js';
import { AgentTodoList } from './AgentTodoList.js';
import { computeFollowThresholds } from './chat-follow-thresholds.js';
import type { ChatLocalImagePreviewLoader, ChatLocalImagePreviewResult } from './ChatLocalImagePreview.js';
import { HtmlFullscreenPreview, openHtmlPreviewInNewWindow, type HtmlFullscreenPreviewState } from './HtmlFullscreenPreview.js';
import { isLikelyDomainPath, renderChatPathActions, type ChatPathDownloadHandler } from '../chat-path-actions.js';
import { FontPrefsDropdown, useFontPrefs, DEFAULT_CHAT_FONT } from './FontPrefsDropdown.js';
import { SessionRepoBranchSummary } from './SessionRepoBranchSummary.js';
import { usePref, parseBooleanish } from '../hooks/usePref.js';
import { PREF_KEY_SHOW_TOOL_CALLS } from '../constants/prefs.js';
import type { TimelineHistoryStatus, TimelineHistoryStepKey } from '../hooks/useTimeline.js';
import { positionChatActionMenu } from '../chat-action-menu-position.js';
import { splitTextByHttpUrls } from '../link-detection.js';
import {
  CHAT_INITIAL_RENDER_ITEM_LIMIT,
  CHAT_RENDER_ITEM_INCREMENT,
  PREVIEW_EVENT_TAIL_LIMIT,
  PREVIEW_RENDER_ITEM_LIMIT,
  shouldSkipRichTextEnhancement,
} from '../chat-render-limits.js';
import { domNodeToPlainText, selectionToPlainText } from '../util/dom-to-text.js';
import { selectionSignature } from '../util/selection-signature.js';
import { ZoomedTextDialog } from './ZoomedTextDialog.js';
import { formatSharedActorLabel } from '../tab-sharing-ui.js';
import { deriveSessionLiveStatus } from '../session-live-status.js';
import { isWorkingSessionState } from '@shared/session-activity-types.js';
import { isPeerAuditRuntimeDisposition } from '@shared/peer-audit.js';
import {
  deriveSdkSubagentStatusRows,
  type SdkSubagentDiagnostic,
  type SdkSubagentStatusRow,
} from '../timeline/sdk-subagent-aggregator.js';

interface Props {
  events: TimelineEvent[];
  loading: boolean;
  /** True while gap-filling new events after a cache hit */
  refreshing?: boolean;
  /** Per-session force-sync for the chat ↻ button — a visible HTTP backfill of
   *  THIS session's timeline. Provided by the parent that owns the useTimeline
   *  hook (main pane, sub-session window/card). The button only renders when
   *  this is provided. */
  onForceSync?: () => void;
  /** Visible history-fetch progress shown as a non-layout overlay. */
  historyStatus?: TimelineHistoryStatus | null;
  /** True while loading older events via backward pagination */
  loadingOlder?: boolean;
  /** False when no more history is available */
  hasOlderHistory?: boolean;
  /** Called when user wants to load older messages */
  onLoadOlder?: () => void;
  sessionState?: string;
  sessionId?: string | null;
  /** Receives a function that forces the chat list to scroll to the bottom. */
  onScrollBottomFn?: (fn: () => void) => void;
  /** When true, render as a non-interactive preview (no scroll button, no status bar) */
  preview?: boolean;
  /** When provided, clicking file paths opens the shared floating preview host. */
  onPreviewFile?: (request: FileBrowserPreviewRequest) => void;
  /** When provided, the right-side file panel is available. */
  ws?: WsClient | null;
  /** Called when user inserts a path via the FileBrowser opened from a chat message */
  onInsertPath?: (path: string) => void;
  /** Session working directory — used to resolve relative paths clicked in chat */
  workdir?: string | null;
  /** Opens the repository view for this session/project. */
  onViewRepo?: () => void;
  /** Called when user quotes selected text. */
  onQuote?: (text: string) => void;
  agentType?: string | null;
  /** Server ID for file transfer download API. */
  serverId?: string;
  /** Retry a failed optimistic send — called with the original commandId and text. */
  onResendFailed?: (commandId: string, text: string) => void;
}

/** A merged view item — either a single event, merged assistant text, or collapsed tool group. */
interface ViewItem {
  key: string;
  type: 'event' | 'assistant-block' | 'tool-group';
  event?: TimelineEvent;
  /** Merged text for assistant-block */
  text?: string;
  assistantAutomation?: boolean;
  /** All events in a collapsed tool group (first, middle..., last) */
  toolEvents?: TimelineEvent[];
  /** memory.context events linked to this event via relatedToEventId */
  linkedEvents?: TimelineEvent[];
  ts?: number;
  lastTs?: number;
}

type ChatHtmlFullscreenPreviewState =
  | (HtmlFullscreenPreviewState & { status: 'loading'; requestId: string })
  | Extract<HtmlFullscreenPreviewState, { status: 'ok' | 'error' }>;

interface AssistantBlockProps {
  text: string;
  automation?: boolean;
  ts: number;
  /** Stable identifier for this merged block. Wired through to a
   *  `data-event-id` attribute so the mobile double-tap detector can pair
   *  taps by event id instead of HTMLElement reference — DOM nodes are
   *  recycled by Preact when the merged block grows, which would otherwise
   *  break a `===` comparison between consecutive taps. */
  eventId?: string;
  onPathClick?: (p: string) => void;
  onUrlClick?: (url: string) => void;
  onDownload?: ChatPathDownloadHandler;
  onHtmlPreview?: (path: string) => void;
  onImagePreview?: ChatLocalImagePreviewLoader;
}

const USER_MESSAGE_COLLAPSE_LINE_LIMIT = 10;
const CHAT_LOCAL_IMAGE_PREVIEW_CACHE_LIMIT = 256;
const chatLocalImagePreviewCache = new Map<string, Promise<ChatLocalImagePreviewResult>>();

function getCachedChatLocalImagePreview(
  cacheKey: string,
  load: () => Promise<ChatLocalImagePreviewResult>,
): Promise<ChatLocalImagePreviewResult> {
  const existing = chatLocalImagePreviewCache.get(cacheKey);
  if (existing) {
    chatLocalImagePreviewCache.delete(cacheKey);
    chatLocalImagePreviewCache.set(cacheKey, existing);
    return existing;
  }

  const pending = load().catch((err) => {
    if (chatLocalImagePreviewCache.get(cacheKey) === pending) {
      chatLocalImagePreviewCache.delete(cacheKey);
    }
    throw err;
  });
  chatLocalImagePreviewCache.set(cacheKey, pending);
  while (chatLocalImagePreviewCache.size > CHAT_LOCAL_IMAGE_PREVIEW_CACHE_LIMIT) {
    const oldestKey = chatLocalImagePreviewCache.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    chatLocalImagePreviewCache.delete(oldestKey);
  }
  return pending;
}

export function __clearChatLocalImagePreviewCacheForTests() {
  chatLocalImagePreviewCache.clear();
}

/** Extract a chat event's visible text while preserving block/list/code
 *  formatting. Uses `domNodeToPlainText` rather than `textContent` so that
 *  copying a multi-paragraph assistant message keeps its paragraph and list
 *  structure — `textContent` would flatten "foo\n\nbar" into "foobar". The
 *  ignore-list inside `dom-to-text.ts` already drops timestamps, copy
 *  buttons, and other UI chrome so we don't need to scrub them here. */
function extractChatEventText(target: HTMLElement): string {
  return domNodeToPlainText(target);
}

function isAbsolutePreviewPath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:[/\\]/.test(path);
}

function resolvePreviewPath(path: string, workdir: string | null | undefined): string {
  const cleaned = path.replace(/^`+|`+$/g, '');
  if (isAbsolutePreviewPath(cleaned)) return cleaned;
  const root = (workdir && workdir.trim()) || '~';
  return `${root.replace(/[/\\]+$/, '')}/${cleaned.replace(/^[/\\]+/, '')}`;
}

function formatMemoryContextScore(score: number | undefined): string | null {
  if (typeof score !== 'number' || Number.isNaN(score)) return null;
  return score >= 1 ? score.toFixed(2) : score.toFixed(3);
}

function formatMemoryContextTimestamp(ts: number | undefined): string | null {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatChatDateTime(ts: number, now = Date.now()): string {
  const date = new Date(ts);
  const today = new Date(now);
  const timeOptions: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  };
  const isToday = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
  return isToday
    ? date.toLocaleTimeString([], timeOptions)
    : date.toLocaleString([], { month: 'short', day: 'numeric', ...timeOptions });
}

type MemoryContextSection =
  | {
    key: string;
    titleKey: string;
    preferenceItems: MemoryContextTimelinePreferenceItem[];
    items?: never;
  }
  | {
    key: string;
    titleKey: string;
    items: MemoryContextTimelineItem[];
    preferenceItems?: never;
  };

function normalizeMemoryContextPreferenceItems(
  payload: MemoryContextTimelinePayload,
): MemoryContextTimelinePreferenceItem[] {
  if (!Array.isArray(payload.preferenceItems)) return [];
  return payload.preferenceItems
    .map((item, index) => ({
      id: typeof item.id === 'string' && item.id.trim() ? item.id : `preference-${index + 1}`,
      text: typeof item.text === 'string' ? item.text.trim() : '',
    }))
    .filter((item) => item.text);
}

function getMemoryContextSections(
  items: MemoryContextTimelineItem[],
  preferenceItems: MemoryContextTimelinePreferenceItem[],
): MemoryContextSection[] {
  const sections: MemoryContextSection[] = [];
  if (preferenceItems.length > 0) {
    sections.push({
      key: 'preferences',
      titleKey: 'chat.memory_context_section_preferences',
      preferenceItems,
    });
  }

  const durable = items.filter((item) => item.projectionClass === 'durable_memory_candidate');
  const recent = items.filter((item) => item.projectionClass === 'recent_summary');
  const master = items.filter((item) => item.projectionClass === 'master_summary');
  const other = items.filter((item) => {
    const projectionClass = item.projectionClass;
    return !projectionClass
      || (
        projectionClass !== 'durable_memory_candidate'
        && projectionClass !== 'recent_summary'
        && projectionClass !== 'master_summary'
      );
  });
  const buckets: Array<[string, string, MemoryContextTimelineItem[]]> = [
    ['durable', 'chat.memory_context_section_durable', durable],
    ['recent', 'chat.memory_context_section_recent', recent],
    ['master', 'chat.memory_context_section_master', master],
    ['other', 'chat.memory_context_section_other', other],
  ];
  for (const [key, titleKey, bucketItems] of buckets) {
    if (bucketItems.length > 0) sections.push({ key, titleKey, items: bucketItems });
  }
  return sections;
}

function getMemoryContextStatusSummary(
  t: (key: string, options?: Record<string, unknown>) => string,
  payload: MemoryContextTimelinePayload,
  itemCount: number,
): string {
  switch (payload.status) {
    case 'no_matches':
      return t('chat.memory_context_status_no_matches');
    case 'deduped_recently':
      return t('chat.memory_context_status_deduped_recently', { count: payload.matchedCount ?? 0 });
    case 'skipped_template_prompt':
      return t('chat.memory_context_status_skipped_template_prompt');
    case 'skipped_short_prompt':
      return t('chat.memory_context_status_skipped_short_prompt');
    case 'skipped_control_message':
      return t('chat.memory_context_status_skipped_control_message');
    case 'failed':
      return t('chat.memory_context_status_failed');
    default:
      return t('chat.memory_context_summary', { count: itemCount });
  }
}

function getMemoryContextStatusDetail(
  t: (key: string, options?: Record<string, unknown>) => string,
  payload: MemoryContextTimelinePayload,
): string | null {
  switch (payload.status) {
    case 'deduped_recently':
      return t('chat.memory_context_status_deduped_recently_detail', {
        count: payload.matchedCount ?? 0,
        deduped: payload.dedupedCount ?? payload.matchedCount ?? 0,
      });
    case 'skipped_template_prompt':
      return t('chat.memory_context_status_skipped_template_prompt_detail');
    case 'skipped_short_prompt':
      return t('chat.memory_context_status_skipped_short_prompt_detail');
    case 'skipped_control_message':
      return t('chat.memory_context_status_skipped_control_message_detail');
    case 'failed':
      return t('chat.memory_context_status_failed_detail');
    default:
      return null;
  }
}

const TOOL_INPUT_SUMMARY_KEYS = [
  'query',
  'command',
  'cmd',
  'path',
  'file_path',
  'filePath',
  'url',
  'input',
  'text',
  'prompt',
  'objective',
  'description',
  'name',
] as const;
const TOOL_SUMMARY_MAX_CHARS = 240;
const TOOL_SUMMARY_SCAN_CHARS = 4_096;
const TOOL_SUMMARY_ARRAY_ITEMS = 8;

type GroupedFileChange = {
  filePath: string;
  patches: FileChangePatch[];
};

function isFileChangeEvent(event: TimelineEvent): event is TimelineEvent & { payload: { batch?: FileChangeBatch } } {
  return event.type === 'file.change' && !!event.payload && typeof event.payload === 'object';
}

function getFileChangeBatch(event: TimelineEvent): FileChangeBatch | null {
  if (!isFileChangeEvent(event)) return null;
  const batch = event.payload.batch;
  if (!batch || typeof batch !== 'object') return null;
  const payload = batch as FileChangeBatch;
  if (!Array.isArray(payload.patches)) return null;
  return payload;
}

function truncateToolText(text: string, max = TOOL_SUMMARY_MAX_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function normalizeToolSummaryText(text: string, max = TOOL_SUMMARY_MAX_CHARS): string {
  let out = '';
  let pendingSpace = false;
  let sawText = false;
  const scanLength = Math.min(text.length, TOOL_SUMMARY_SCAN_CHARS);
  for (let i = 0; i < scanLength; i += 1) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      if (sawText) pendingSpace = true;
      continue;
    }
    if (pendingSpace && out.length > 0) {
      out += ' ';
      pendingSpace = false;
    }
    out += ch;
    sawText = true;
    if (out.length >= max) return truncateToolText(out, max);
  }
  return truncateToolText(out.trim(), max);
}

function formatToolObjectSummary(record: Record<string, unknown>): string {
  const entries = Object.entries(record);
  if (entries.length === 0) return '';
  const parts = entries.slice(0, 4).map(([key, value]) => {
    const formatted = formatToolPayloadValue(value);
    return formatted ? `${key}: ${formatted}` : key;
  });
  if (entries.length > 4) parts.push('…');
  return truncateToolText(`{${parts.join(', ')}}`);
}

function formatToolPayloadValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return normalizeToolSummaryText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.slice(0, TOOL_SUMMARY_ARRAY_ITEMS).map((item) => formatToolPayloadValue(item)).filter(Boolean);
    if (value.length > TOOL_SUMMARY_ARRAY_ITEMS) parts.push('…');
    if (parts.length === 0) return '';
    return truncateToolText(parts.join(', '));
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length === 0) return '';
    for (const key of TOOL_INPUT_SUMMARY_KEYS) {
      const candidate = record[key];
      if (candidate === undefined) continue;
      const formatted = formatToolPayloadValue(candidate);
      if (formatted) return formatted;
    }
    const entries = Object.entries(record);
    if (entries.length === 1) {
      return formatToolPayloadValue(entries[0][1]);
    }
    return formatToolObjectSummary(record);
  }
  return truncateToolText(String(value));
}

function summarizeToolInput(
  input: unknown,
  detail: unknown,
): string {
  const direct = formatToolPayloadValue(input);
  if (direct) return direct;
  if (!detail || typeof detail !== 'object') return '';
  const record = detail as Record<string, unknown>;
  const fromDetailInput = formatToolPayloadValue(record.input);
  if (fromDetailInput) return fromDetailInput;
  const raw = record.raw;
  if (!raw || typeof raw !== 'object') return '';
  const rawRecord = raw as Record<string, unknown>;
  const fromRawArgs = formatToolPayloadValue(rawRecord.args);
  if (fromRawArgs) return fromRawArgs;
  return formatToolPayloadValue(rawRecord.input);
}

function isGenericWebSearchLabel(value: string | undefined): boolean {
  if (!value) return false;
  return /^\((?:other|open_page|find_in_page|search|web_search)\)$/i.test(value.trim());
}

function pickMergedToolInput(
  toolName: string,
  callInput: string,
  resultInput: string,
): string {
  if (toolName === 'WebSearch') {
    const callGeneric = !callInput || isGenericWebSearchLabel(callInput);
    const resultGeneric = !resultInput || isGenericWebSearchLabel(resultInput);
    // Reasoning-model web search sometimes reports `action: { type: 'other' }`
    // with an empty query — codex/OpenAI withholds the actual query, so there
    // is nothing to show. Drop the cryptic "(other)" token and render a bare
    // "WebSearch" row instead of leaking the raw enum to the user.
    if (callGeneric && resultGeneric) return '';
    if (callGeneric) return resultInput;
    return callInput;
  }
  return callInput || resultInput;
}

function pickMergedToolDetailInput(
  toolName: string,
  callDetail: unknown,
  resultDetail: unknown,
): unknown {
  const callInput = summarizeToolInput(undefined, callDetail);
  const resultInput = summarizeToolInput((resultDetail as any)?.input, resultDetail);
  if (toolName === 'WebSearch' && resultInput) {
    if (!callInput || isGenericWebSearchLabel(callInput)) return (resultDetail as any)?.input;
  }
  return (callDetail as any)?.input ?? (resultDetail as any)?.input;
}

function pickMergedToolDetailMeta(
  toolName: string,
  callDetail: unknown,
  resultDetail: unknown,
): unknown {
  const callInput = summarizeToolInput(undefined, callDetail);
  const resultInput = summarizeToolInput((resultDetail as any)?.input, resultDetail);
  if (toolName === 'WebSearch' && resultInput) {
    if (!callInput || isGenericWebSearchLabel(callInput)) return (resultDetail as any)?.meta ?? (callDetail as any)?.meta;
  }
  return (callDetail as any)?.meta ?? (resultDetail as any)?.meta;
}

function formatToolDetailJson(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ToolDetailSection({
  label,
  value,
}: {
  label: string;
  value: unknown;
}) {
  const text = formatToolDetailJson(value);
  if (!text) return null;
  return (
    <div class="chat-tool-detail-section">
      <div class="chat-tool-detail-label">{label}</div>
      <pre class="chat-tool-detail-pre">{text}</pre>
    </div>
  );
}

function MergedToolDetailPanel({
  toolName,
  callDetail,
  resultDetail,
}: {
  toolName: string;
  callDetail: unknown;
  resultDetail: unknown;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!callDetail && !resultDetail) return null;
  const detailInput = useMemo(() => (
    open ? pickMergedToolDetailInput(toolName, callDetail, resultDetail) : undefined
  ), [callDetail, open, resultDetail, toolName]);
  const detailMeta = useMemo(() => (
    open ? pickMergedToolDetailMeta(toolName, callDetail, resultDetail) : undefined
  ), [callDetail, open, resultDetail, toolName]);
  const rawDetail = open ? (callDetail as any)?.raw ?? (resultDetail as any)?.raw : undefined;
  return (
    <details
      class="chat-tool-detail"
      onToggle={(event: Event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary class="chat-tool-detail-summary" onClick={() => setOpen(true)}>{t('chat.tool_detail_toggle')}</summary>
      {open && (
        <>
          <ToolDetailSection label={t('chat.tool_detail_input')} value={detailInput} />
          <ToolDetailSection label={t('chat.tool_detail_output')} value={(resultDetail as any)?.output} />
          <ToolDetailSection label={t('chat.tool_detail_meta')} value={detailMeta} />
          <ToolDetailSection label={t('chat.tool_detail_raw')} value={rawDetail} />
        </>
      )}
    </details>
  );
}

function ToolResultDetailPanel({ detail }: { detail: unknown }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!detail) return null;
  return (
    <details
      class="chat-tool-detail"
      onToggle={(event: Event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary class="chat-tool-detail-summary" onClick={() => setOpen(true)}>{t('chat.tool_detail_toggle')}</summary>
      {open && (
        <>
          <ToolDetailSection label={t('chat.tool_detail_output')} value={(detail as any).output} />
          <ToolDetailSection label={t('chat.tool_detail_meta')} value={(detail as any).meta} />
          <ToolDetailSection label={t('chat.tool_detail_raw')} value={(detail as any).raw} />
        </>
      )}
    </details>
  );
}

/** Merge consecutive assistant.text events into blocks for display.
 *  Also:
 *  - Merge consecutive tool.call + tool.result pairs into compact single lines
 *  - Deduplicate consecutive session.state events with same state (keep last)
 */
/**
 * Event types that the show_tool_calls preference governs.
 *
 * When the preference is off (Simple view), the chat shows only natural-
 * language turn content — `user.message`, `assistant.text`, plus errors and
 * `ask.question` events that require user response. Everything in this set
 * is debug/work-in-progress detail that a non-dev user does not want to
 * see by default:
 *
 *   - `tool.call` / `tool.result` — every Bash/Read/etc. invocation the
 *     agent makes (also implicitly hides the `tool-group` collapse UI).
 *   - `file.change`              — the file-diff cards rendered for
 *                                  apply_patch / file_change events.
 *   - `memory.context`           — "Related history" recall results that
 *                                  appear above user messages; useful for
 *                                  agent introspection, noisy in casual
 *                                  chat.
 *   - `assistant.thinking`       — reasoning/progress details. The wrench
 *                                  defaults ON for undecided users, and a
 *                                  click turns these details off.
 */
const TOOL_LIKE_EVENT_TYPES = new Set<string>([
  'tool.call',
  'tool.result',
  'file.change',
  'memory.context',
  'assistant.thinking',
]);

function isVisibleChatTimelineEvent(event: TimelineEvent, showToolCalls: boolean): boolean {
  // Filter out transient/noisy event types that don't belong in the chat log:
  // - agent.status, usage.update: stats, not chat content
  // - mode.state: shown elsewhere (tabs/header)
  // - command.ack, terminal.snapshot: internal plumbing
  // - session.state running/idle/queued: live status belongs in footer/header/queue UI, not chat history
  // - TOOL_LIKE_EVENT_TYPES: optional developer details — hidden only when
  //   the user has explicitly turned the wrench preference off. Undecided
  //   users default to ON and see the first-run prompt.
  return (
    !event.hidden &&
    event.type !== 'agent.status' &&
    event.type !== 'usage.update' &&
    event.type !== 'mode.state' &&
    event.type !== 'command.ack' &&
    event.type !== 'terminal.snapshot' &&
    !(event.type === 'session.state'
      && (isWorkingSessionState(event.payload.state) || event.payload.state === 'idle')
      && !getSessionStateDetail(event)) &&
    (showToolCalls || !TOOL_LIKE_EVENT_TYPES.has(event.type))
  );
}

function getSessionStateDetail(event: TimelineEvent): string {
  if (event.type !== 'session.state') return '';
  for (const key of ['error', 'message', 'errorReason'] as const) {
    const value = event.payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function getFinalVisibleEventIds(events: TimelineEvent[], showToolCalls: boolean): string[] {
  const visible = events.filter((event) => isVisibleChatTimelineEvent(event, showToolCalls));
  const lastByEventId = new Map<string, number>();
  for (let i = 0; i < visible.length; i++) {
    lastByEventId.set(visible[i].eventId, i);
  }
  const ids: string[] = [];
  for (let i = 0; i < visible.length; i++) {
    const event = visible[i];
    if (lastByEventId.get(event.eventId) !== i) continue;
    if (event.payload.streaming === true || event.payload.pending === true) continue;
    ids.push(event.eventId);
  }
  return ids;
}

function buildViewItems(events: TimelineEvent[], showToolCalls: boolean): ViewItem[] {
  const visible = events.filter((event) => isVisibleChatTimelineEvent(event, showToolCalls));

  // Pre-pass: merge tool.call+tool.result pairs, dedup session.state,
  // and dedup stable-eventId streaming events (keep last occurrence only)
  const consolidated: TimelineEvent[] = [];
  // Track tool.result eventIds that have been consumed by a preceding tool.call merge
  const consumedIds = new Set<string>();

  // Dedup: for events sharing a stable eventId (streaming deltas), keep only the last
  const lastByEventId = new Map<string, number>();
  for (let i = 0; i < visible.length; i++) {
    lastByEventId.set(visible[i].eventId, i);
  }

  for (let i = 0; i < visible.length; i++) {
    const ev = visible[i];

    // Skip earlier occurrences of duplicate eventIds (streaming delta updates — keep last only)
    if (lastByEventId.get(ev.eventId) !== i) continue;

    // Skip already-consumed tool.result events
    if (consumedIds.has(ev.eventId)) continue;

    // Merge tool.call with its matching tool.result.
    // Scan forward up to 10 events to find the tool.result — user.message /
    // command.ack etc. can land between them during a long-running tool.
    if (ev.type === 'tool.call') {
      let resultIdx = -1;
      for (let j = i + 1; j <= Math.min(i + 10, visible.length - 1); j++) {
        if (visible[j].type === 'tool.result') { resultIdx = j; break; }
        if (visible[j].type === 'tool.call') break; // another call started, stop
      }
      if (resultIdx !== -1) {
        const next = visible[resultIdx];
        consumedIds.add(next.eventId); // mark tool.result as consumed
        const toolName = String(ev.payload.tool ?? 'tool');
        // tool.call from transport SDK may have no input yet (streamed incrementally).
        // Fall back to the result's detail.input which has the complete args.
        const callInput = summarizeToolInput(ev.payload.input, ev.payload.detail);
        const resultInput = summarizeToolInput((next.payload.detail as any)?.input, next.payload.detail);
        const inputText = pickMergedToolInput(toolName, callInput, resultInput);
        const input = inputText ? ` ${inputText}` : '';
        const status = next.payload.error ? `✗ ${String(next.payload.error)}` : '✓';
        const output = !next.payload.error ? formatToolPayloadValue(next.payload.output) : undefined;
        consolidated.push({
          ...ev,
          type: 'tool.call',
          payload: {
            ...ev.payload,
            tool: toolName,
            input: `${input} ${status}`.trim(),
            _merged: true,
            ...(output ? { _output: output } : {}),
            ...(ev.payload.detail ? { _callDetail: ev.payload.detail } : {}),
            ...(next.payload.detail ? { _resultDetail: next.payload.detail } : {}),
          },
        });
        continue;
      }
    }

    // Deduplicate consecutive session.state events with the same state — keep last
    if (ev.type === 'session.state') {
      const next = visible[i + 1];
      if (next && next.type === 'session.state' && String(next.payload.state) === String(ev.payload.state)) {
        continue; // skip — keep the next (checked again on next iteration)
      }
    }

    consolidated.push(ev);
  }

  const linkedMemoryEvents = new Map<string, TimelineEvent[]>();
  const attachableEventIds = new Set(
    consolidated
      .filter((event) => event.type === 'user.message')
      .map((event) => event.eventId),
  );
  const renderable = consolidated.filter((event) => {
    if (event.type !== 'memory.context') return true;
    const relatedToEventId = typeof event.payload.relatedToEventId === 'string'
      ? event.payload.relatedToEventId
      : undefined;
    if (!relatedToEventId || !attachableEventIds.has(relatedToEventId)) return true;
    const group = linkedMemoryEvents.get(relatedToEventId) ?? [];
    group.push(event);
    linkedMemoryEvents.set(relatedToEventId, group);
    return false;
  });

  // Main pass: merge assistant.text blocks + group consecutive tool.call runs
  const items: ViewItem[] = [];
  let pendingText: string[] = [];
  let pendingFirstTs = 0;
  let pendingLastTs = 0;
  let pendingKey = '';
  let pendingAssistantAutomation = false;
  let pendingTools: TimelineEvent[] = [];
  let deferredEvents: TimelineEvent[] = [];

  const flushPending = () => {
    if (pendingText.length > 0) {
      items.push({
        key: pendingKey,
        type: 'assistant-block',
        text: pendingText.join('\n'),
        assistantAutomation: pendingAssistantAutomation,
        ts: pendingFirstTs,
        lastTs: pendingLastTs,
      });
      pendingText = [];
      pendingAssistantAutomation = false;
    }
  };

  const flushTools = () => {
    if (pendingTools.length === 0) return;
    if (pendingTools.length === 1) {
      items.push({ key: pendingTools[0].eventId, type: 'event', event: pendingTools[0] });
    } else {
      // 2+ consecutive tool events → collapsible group
      items.push({
        key: `tg_${pendingTools[0].eventId}`,
        type: 'tool-group',
        toolEvents: [...pendingTools],
      });
    }
    pendingTools = [];
    // Flush any session.state events that were deferred to avoid breaking the group
    for (const ev of deferredEvents) items.push({ key: ev.eventId, type: 'event', event: ev });
    deferredEvents = [];
  };

  for (const event of renderable) {
    if (event.type === 'assistant.text') {
      flushTools();
      // Trim and collapse 3+ consecutive blank lines to 1 (CC output often has many trailing newlines)
      const text = String(event.payload.text ?? '').trim().replace(/\n{3,}/g, '\n\n');
      if (!text) continue;
      const assistantAutomation = event.payload.automation === true;
      if (pendingText.length > 0 && pendingAssistantAutomation !== assistantAutomation) {
        flushPending();
      }
      if (pendingText.length === 0) {
        pendingKey = event.eventId;
        pendingFirstTs = event.ts;
        pendingAssistantAutomation = assistantAutomation;
      }
      pendingLastTs = event.ts;
      pendingText.push(text);
    } else if (event.type === 'tool.call' || event.type === 'tool.result') {
      flushPending();
      pendingTools.push(event);
    } else if (event.type === 'assistant.thinking' && pendingTools.length > 0) {
      // Thinking events between tool calls — defer to render after the tool group
      deferredEvents.push(event);
    } else if (event.type === 'session.state' && pendingTools.length > 0) {
      // session.state hooks can fire between tool calls (e.g. CC notification hook).
      // Defer: render after the tool group closes.
      deferredEvents.push(event);
    } else {
      flushPending();
      flushTools();
      items.push({
        key: event.eventId,
        type: 'event',
        event,
        ...(event.type === 'user.message' && linkedMemoryEvents.has(event.eventId)
          ? { linkedEvents: linkedMemoryEvents.get(event.eventId) }
          : {}),
      });
    }
  }
  flushPending();
  flushTools();

  return items;
}

function textRevision(text: string | undefined): string {
  const value = text ?? '';
  return `${value.length}:${value.slice(-48)}`;
}

function eventRevision(event: TimelineEvent): string {
  const text = typeof event.payload.text === 'string' ? textRevision(event.payload.text) : '';
  const state = typeof event.payload.state === 'string' ? event.payload.state : '';
  return [
    event.eventId,
    event.type,
    event.ts,
    event.seq,
    event.payload.streaming === true ? 'streaming' : '',
    event.payload.pending === true ? 'pending' : '',
    event.payload.failed === true ? 'failed' : '',
    state,
    text,
  ].join(':');
}

function viewItemRevision(item: ViewItem): string {
  if (item.type === 'assistant-block') {
    return [
      item.key,
      item.type,
      item.ts ?? 0,
      item.lastTs ?? 0,
      item.assistantAutomation === true ? 'automation' : '',
      textRevision(item.text),
    ].join(':');
  }
  if (item.type === 'tool-group') {
    return `${item.key}:tool-group:${(item.toolEvents ?? []).map(eventRevision).join('|')}`;
  }
  const linked = item.linkedEvents?.map(eventRevision).join('|') ?? '';
  return `${item.key}:event:${item.event ? eventRevision(item.event) : ''}:${linked}`;
}

function getRenderedViewRevision(items: ViewItem[]): string {
  return items.map(viewItemRevision).join('\n');
}

interface SelectionMenu {
  x: number;
  y: number;
  anchorClientX: number;
  anchorClientY: number;
  text: string;
  /** eventId of the message the menu was opened on, if any — enables "Delete message". */
  eventId?: string;
}

const FILE_PANEL_MIN = 220;
const FILE_PANEL_MAX_RATIO = 0.6; // 60% of viewport width
const FILE_PANEL_DEFAULT = 340;
/** Two short taps within this many ms on the same chat bubble open the zoom
 *  modal. 500ms is wider than the strict iOS double-click window because
 *  fingers on a phone are slower than mouse buttons, and we want this to
 *  feel forgiving — single taps still don't pair because the chat view
 *  has no other tap action that would accidentally satisfy the predicate. */
const DOUBLE_TAP_THRESHOLD_MS = 500;
/** A touch this much movement (px) from the start point still counts as a
 *  tap (rather than a scroll). 15px gives finger-tremor headroom; smaller
 *  values miss double-taps where the second tap drifted slightly. */
const TAP_MOVE_TOLERANCE_PX = 15;
const TOUCH_GESTURE_MEDIA_QUERY = '(pointer: coarse)';

/** Track whether the current primary pointer is coarse so chat gestures
 *  (long-press menu, double-tap zoom) flip on/off when the input mode changes.
 *  Do not include viewport width here: desktop users can run narrow windows,
 *  and they still expect native selection plus the Copy/Quote popup.
 *  Falls back to plain `'ontouchstart' in window` when matchMedia isn't
 *  available (older browsers / non-DOM test environments). */
function useTouchChatGestures(): boolean {
  const compute = (): boolean => {
    if (typeof window === 'undefined') return false;
    if (typeof window.matchMedia === 'function') {
      return window.matchMedia(TOUCH_GESTURE_MEDIA_QUERY).matches;
    }
    return 'ontouchstart' in window;
  };
  const [isMobile, setIsMobile] = useState(compute);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(TOUCH_GESTURE_MEDIA_QUERY);
    const onChange = () => setIsMobile(mq.matches);
    // Safari < 14 only supports the legacy `addListener` API.
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);
  return isMobile;
}
/** Long-press timer for the mobile Copy/Quote context menu. Matches the
 *  iOS callout heuristic so users with muscle memory from native chat
 *  apps see the menu at the expected moment. */
const LONG_PRESS_MS = 400;
const panelWidthKey = (id: string | null | undefined) => `chatFilePanelWidth:${id ?? '_'}`;
const panelOpenKey  = (id: string | null | undefined) => `chatFilePanelOpen:${id ?? '_'}`;
// SDK agents panel toggle. GLOBAL within a device class — one switch shared by
// every chat window + tab, synced live — but SEPARATE for touch/phone vs desktop
// (the key is suffixed by platform) so "手机开关手机, 电脑开关电脑". Default OPEN
// until the user closes it; only an explicit '0' counts as closed.
const SDK_AGENTS_OPEN_KEY = 'chatSdkAgentsPanelOpen';
const SDK_AGENTS_OPEN_EVENT = 'deck:sdk-agents-panel-open-changed';
function sdkAgentsOpenKey(): string {
  let platform = 'desktop';
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        && window.matchMedia(TOUCH_GESTURE_MEDIA_QUERY).matches) {
      platform = 'mobile';
    }
  } catch { /* ignore — fall back to desktop */ }
  return `${SDK_AGENTS_OPEN_KEY}:${platform}`;
}

function readPanelWidth(id: string | null | undefined): number {
  try { return parseInt(localStorage.getItem(panelWidthKey(id)) ?? String(FILE_PANEL_DEFAULT), 10); } catch { return FILE_PANEL_DEFAULT; }
}
function readPanelOpen(id: string | null | undefined): boolean {
  try { return localStorage.getItem(panelOpenKey(id)) === '1'; } catch { return false; }
}
function readSdkAgentsOpen(): boolean {
  // Default OPEN when never set; only an explicit '0' means the user closed it.
  try { return localStorage.getItem(sdkAgentsOpenKey()) !== '0'; } catch { return true; }
}
function writeSdkAgentsOpen(next: boolean): void {
  try { localStorage.setItem(sdkAgentsOpenKey(), next ? '1' : '0'); } catch { /* ignore */ }
  try { window.dispatchEvent(new CustomEvent(SDK_AGENTS_OPEN_EVENT)); } catch { /* ignore */ }
}

/** Find a chat event element by its eventId without relying on CSS.escape —
 *  our eventIds contain `:` and `-` chars that are illegal in CSS selectors,
 *  and `CSS.escape` isn't polyfilled in jsdom so `querySelector` blows up in
 *  tests. A direct DOM walk with `dataset.eventId` comparison is trivially
 *  fast for the few dozen elements involved. */
function findEventElement(root: ParentNode, eventId: string): HTMLElement | null {
  const candidates = root.querySelectorAll('[data-event-id]');
  for (const el of Array.from(candidates)) {
    if ((el as HTMLElement).dataset.eventId === eventId) return el as HTMLElement;
  }
  return null;
}

/** Walk up the DOM from `start` and return the nearest ancestor that actually
 *  scrolls (overflow-y is `auto` or `scroll` AND the element has extra scroll
 *  height beyond its clientHeight). Used by the pinned-last-sent banner to
 *  find the real scroll viewport — in the sub-session card, `.chat-view` is
 *  nested inside `.subcard-preview` which holds the scrollbar, and observing
 *  `.chat-view` there would never fire "out of viewport". Returns the
 *  starting element if no scrolling ancestor exists (fallback to the
 *  component's own bounds). */
function findScrollParent(start: HTMLElement): HTMLElement {
  let node: HTMLElement | null = start;
  while (node) {
    const style = window.getComputedStyle(node);
    const overflowY = style.overflowY;
    const isScrollable = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
    // Ignore ancestors that declare scrollability but don't actually have
    // scroll height (e.g. an overflow:auto container that always fits its
    // content). Otherwise we'd incorrectly pick a sibling that never scrolls.
    if (isScrollable && node.scrollHeight > node.clientHeight + 1) {
      return node;
    }
    node = node.parentElement;
  }
  return start;
}

type ChatTranslate = (key: string, options?: Record<string, unknown>) => string;

function sdkAgentsProviderLabel(t: ChatTranslate, row: Pick<SdkSubagentStatusRow | SdkSubagentDiagnostic, 'provider'>): string {
  switch (row.provider) {
    case SDK_SUBAGENT_PROVIDERS.CLAUDE_CODE_SDK:
      return t('chat.sdk_agents_provider_claude');
    case SDK_SUBAGENT_PROVIDERS.CODEX_SDK:
      return t('chat.sdk_agents_provider_codex');
    case SDK_SUBAGENT_PROVIDERS.QWEN:
      return t('chat.sdk_agents_provider_qwen');
    case SDK_SUBAGENT_PROVIDERS.GEMINI_SDK:
      return t('chat.sdk_agents_provider_gemini');
    default:
      return t('chat.sdk_agents_provider_unknown');
  }
}

function sdkAgentsStatusLabel(t: ChatTranslate, status: SdkSubagentStatusRow['normalizedStatus'] | SdkSubagentDiagnostic['normalizedStatus']): string {
  switch (status) {
    case SDK_SUBAGENT_STATUS.PENDING:
      return t('chat.sdk_agents_status_pending');
    case SDK_SUBAGENT_STATUS.RUNNING:
      return t('chat.sdk_agents_status_running');
    case SDK_SUBAGENT_STATUS.COMPLETE:
      return t('chat.sdk_agents_status_complete');
    case SDK_SUBAGENT_STATUS.ERROR:
      return t('chat.sdk_agents_status_error');
    case SDK_SUBAGENT_STATUS.INTERRUPTED:
      return t('chat.sdk_agents_status_interrupted');
    case SDK_SUBAGENT_STATUS.STALE:
      return t('chat.sdk_agents_status_stale');
    case SDK_SUBAGENT_STATUS.UNKNOWN:
    default:
      return t('chat.sdk_agents_status_unknown');
  }
}

function sdkAgentsDiagnosticLabel(t: ChatTranslate, diagnostic: SdkSubagentDiagnostic): string {
  switch (diagnostic.diagnosticCode) {
    case SDK_SUBAGENT_DIAGNOSTIC.UNSUPPORTED_RUNTIME:
      return t('chat.sdk_agents_diagnostic_unsupported_runtime');
    case SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_RUNTIME_SUPPORT:
      return t('chat.sdk_agents_diagnostic_unknown_runtime_support');
    case SDK_SUBAGENT_DIAGNOSTIC.MALFORMED_PAYLOAD:
      return t('chat.sdk_agents_diagnostic_malformed_payload');
    case SDK_SUBAGENT_DIAGNOSTIC.MISSING_ID:
      return t('chat.sdk_agents_diagnostic_missing_id');
    case SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_STATE:
      return t('chat.sdk_agents_diagnostic_unknown_state');
    case SDK_SUBAGENT_DIAGNOSTIC.STALE_WITHOUT_TERMINAL:
      return t('chat.sdk_agents_diagnostic_stale_without_terminal');
    case SDK_SUBAGENT_DIAGNOSTIC.SNAPSHOT_ONLY:
      return t('chat.sdk_agents_diagnostic_snapshot_only');
    default:
      return t('chat.sdk_agents_diagnostic_generic');
  }
}

function sdkAgentsRowSummary(row: SdkSubagentStatusRow): string {
  return row.summary
    || row.agentName
    || row.childStatusSummary
    || row.rawStatus
    || row.agentPath
    || row.receiverThreadId
    || row.taskId
    || row.parentItemId
    || row.canonicalKey;
}

function sdkAgentsDiagnosticSummary(diagnostic: SdkSubagentDiagnostic): string | null {
  return diagnostic.summary || diagnostic.childStatusSummary || diagnostic.rawStatus || diagnostic.canonicalKey || null;
}

function sdkAgentsStatusClass(status: SdkSubagentStatusRow['normalizedStatus'] | SdkSubagentDiagnostic['normalizedStatus']): string {
  switch (status) {
    case SDK_SUBAGENT_STATUS.PENDING:
      return 'pending';
    case SDK_SUBAGENT_STATUS.RUNNING:
      return 'running';
    case SDK_SUBAGENT_STATUS.COMPLETE:
      return 'complete';
    case SDK_SUBAGENT_STATUS.ERROR:
      return 'error';
    case SDK_SUBAGENT_STATUS.INTERRUPTED:
      return 'interrupted';
    case SDK_SUBAGENT_STATUS.STALE:
      return 'stale';
    default:
      return 'unknown';
  }
}

function formatSdkAgentClockTime(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatSdkAgentDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatSdkAgentTokenCount(tokens: number): string {
  return new Intl.NumberFormat().format(Math.max(0, Math.floor(tokens)));
}

function SdkAgentsGlyph() {
  return (
    <svg
      class="chat-sdk-agents-glyph"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 7.5v3.2" />
      <path d="M7.7 14.2l2.8-2" />
      <path d="M16.3 14.2l-2.8-2" />
      <circle cx="12" cy="5.2" r="2.4" />
      <circle cx="5.8" cy="16" r="2.4" />
      <circle cx="18.2" cy="16" r="2.4" />
      <path d="M9.1 20.4h5.8" />
    </svg>
  );
}

function hasSdkSubagentTimelineEvent(events: readonly TimelineEvent[]): boolean {
  return events.some((event) => {
    if (event.type !== 'tool.call' && event.type !== 'tool.result') return false;
    const detail = event.payload?.detail;
    return Boolean(detail && typeof detail === 'object' && !Array.isArray(detail)
      && (detail as { kind?: unknown }).kind === SDK_SUBAGENT_DETAIL_KIND);
  });
}

function SdkAgentsPanel({
  rows,
  diagnostics,
  runningCount,
  now,
  onClose,
}: {
  rows: SdkSubagentStatusRow[];
  diagnostics: SdkSubagentDiagnostic[];
  runningCount: number;
  now: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const activeRows = rows.filter((row) => row.active);
  const terminalRows = rows.filter((row) => !row.active);
  return (
    <div class="chat-sdk-agents-panel" role="region" aria-label={t('chat.sdk_agents_panel_title')}>
      <div class="chat-sdk-agents-header">
        <div class="chat-sdk-agents-heading">
          <span class="chat-sdk-agents-title">{t('chat.sdk_agents_panel_title')}</span>
          <span class="chat-sdk-agents-subtitle">{t('chat.sdk_agents_running_count', { count: runningCount })}</span>
        </div>
        <button
          type="button"
          class="chat-sdk-agents-close"
          onClick={onClose}
          aria-label={t('chat.sdk_agents_close')}
          title={t('chat.sdk_agents_close')}
        >
          ×
        </button>
      </div>
      <div class="chat-sdk-agents-body">
        {/* No "Active" title — running agents are the panel's default; the
            header subtitle already shows the running count. Saves a row. */}
        {activeRows.length > 0 && (
          <section class="chat-sdk-agents-section" aria-label={t('chat.sdk_agents_active_section')}>
            {activeRows.map((row) => (
              <SdkAgentsRow key={row.canonicalKey} row={row} now={now} />
            ))}
          </section>
        )}
        {terminalRows.length > 0 && (
          <section class="chat-sdk-agents-section" aria-label={t('chat.sdk_agents_recent_section')}>
            <div class="chat-sdk-agents-section-title">{t('chat.sdk_agents_recent_section')}</div>
            {terminalRows.map((row) => (
              <SdkAgentsRow key={row.canonicalKey} row={row} now={now} />
            ))}
          </section>
        )}
        {diagnostics.length > 0 && (
          <section class="chat-sdk-agents-section" aria-label={t('chat.sdk_agents_diagnostics_section')}>
            <div class="chat-sdk-agents-section-title">{t('chat.sdk_agents_diagnostics_section')}</div>
            {diagnostics.map((diagnostic) => (
              <SdkAgentsDiagnosticRow key={diagnostic.id} diagnostic={diagnostic} />
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

function SdkAgentsRow({ row, now }: { row: SdkSubagentStatusRow; now: number }) {
  const { t } = useTranslation();
  const statusClass = sdkAgentsStatusClass(row.normalizedStatus);
  const statusLabel = sdkAgentsStatusLabel(t, row.normalizedStatus);
  const summary = sdkAgentsRowSummary(row);
  const durationMs = row.active ? now - row.startTs : row.ts - row.startTs;
  return (
    <div class={`chat-sdk-agent-row ${row.active ? 'active' : 'terminal'} status-${statusClass}`}>
      <div class="chat-sdk-agent-row-top">
        <span class="chat-sdk-agent-provider">{sdkAgentsProviderLabel(t, row)}</span>
        <span class="chat-sdk-agent-status">{statusLabel}</span>
      </div>
      <div class="chat-sdk-agent-summary">{summary}</div>
      {/* Short stats flow inline and wrap (use the width) instead of one tall
          full-width row each. */}
      <div class="chat-sdk-agent-stats">
        {(row.agentPath || row.taskId || row.parentItemId) && (
          <div class="chat-sdk-agent-detail chat-sdk-agent-stat">
            <span class="chat-sdk-agent-detail-label">{t('chat.sdk_agents_id')}</span>
            <span class="chat-sdk-agent-detail-value">{row.agentPath || row.taskId || row.parentItemId}</span>
          </div>
        )}
        {row.model && (
          <div class="chat-sdk-agent-detail chat-sdk-agent-stat">
            <span class="chat-sdk-agent-detail-label">{t('chat.sdk_agents_model')}</span>
            <span class="chat-sdk-agent-detail-value">{row.model}</span>
          </div>
        )}
        <div class="chat-sdk-agent-detail chat-sdk-agent-stat">
          <span class="chat-sdk-agent-detail-label">{t('chat.sdk_agents_started_at')}</span>
          <span class="chat-sdk-agent-detail-value">{formatSdkAgentClockTime(row.startTs)}</span>
        </div>
        <div class="chat-sdk-agent-detail chat-sdk-agent-stat">
          <span class="chat-sdk-agent-detail-label">{t('chat.sdk_agents_duration')}</span>
          <span class="chat-sdk-agent-detail-value">{formatSdkAgentDuration(durationMs)}</span>
        </div>
        {typeof row.usageTotalTokens === 'number' && Number.isFinite(row.usageTotalTokens) && (
          <div class="chat-sdk-agent-detail chat-sdk-agent-stat">
            <span class="chat-sdk-agent-detail-label">{t('chat.sdk_agents_tokens')}</span>
            <span class="chat-sdk-agent-detail-value">{formatSdkAgentTokenCount(row.usageTotalTokens)}</span>
          </div>
        )}
      </div>
      {row.description && (
        <div class="chat-sdk-agent-detail">
          <span class="chat-sdk-agent-detail-label">{t('chat.sdk_agents_prompt')}</span>
          <span class="chat-sdk-agent-detail-value">{row.description}</span>
        </div>
      )}
      {row.output && row.terminal && (
        <div class="chat-sdk-agent-detail">
          <span class="chat-sdk-agent-detail-label">{t('chat.sdk_agents_result')}</span>
          <span class="chat-sdk-agent-detail-value">{row.output}</span>
        </div>
      )}
      <div class="chat-sdk-agent-meta">
        {row.active && typeof row.runningChildCount === 'number' && (
          <span>{t('chat.sdk_agents_running_children', { count: row.runningChildCount })}</span>
        )}
        {typeof row.receiverCount === 'number' && (
          <span>{t('chat.sdk_agents_receiver_count', { count: row.receiverCount })}</span>
        )}
      </div>
    </div>
  );
}

function SdkAgentsDiagnosticRow({ diagnostic }: { diagnostic: SdkSubagentDiagnostic }) {
  const { t } = useTranslation();
  const statusClass = sdkAgentsStatusClass(diagnostic.normalizedStatus);
  const summary = sdkAgentsDiagnosticSummary(diagnostic);
  return (
    <div class={`chat-sdk-agent-row diagnostic status-${statusClass}`}>
      <div class="chat-sdk-agent-row-top">
        <span class="chat-sdk-agent-provider">{sdkAgentsProviderLabel(t, diagnostic)}</span>
        <span class="chat-sdk-agent-status">{sdkAgentsDiagnosticLabel(t, diagnostic)}</span>
      </div>
      {summary && <div class="chat-sdk-agent-summary">{summary}</div>}
    </div>
  );
}

export function ChatView({ events, loading, refreshing = false, historyStatus, loadingOlder, hasOlderHistory = true, onLoadOlder, sessionState, sessionId, onScrollBottomFn, preview, onPreviewFile, ws, onInsertPath, workdir, onViewRepo, serverId, onQuote, agentType: _agentType, onResendFailed, onForceSync }: Props) {
  const { t } = useTranslation();
  const [syncDisabled, setSyncDisabled] = useState(false);
  const handleForceSync = useCallback(() => {
    if (syncDisabled || !onForceSync) return;
    // Per-session visible backfill: sets `refreshing` → the refreshing overlay
    // (full views) / button spin (compact cards) is the feedback, so no toast
    // is needed. 10s cooldown prevents spam.
    onForceSync();
    setSyncDisabled(true);
    setTimeout(() => setSyncDisabled(false), 10000);
  }, [syncDisabled, onForceSync]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [selMenu, setSelMenu] = useState<SelectionMenu | null>(null);
  const selMenuRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [htmlFullscreenPreview, setHtmlFullscreenPreview] = useState<ChatHtmlFullscreenPreviewState | null>(null);
  const [highlightEl, setHighlightEl] = useState<HTMLElement | null>(null);
  const highlightElRef = useRef(highlightEl);
  highlightElRef.current = highlightEl;
  const [ctxMenu, setCtxMenu] = useState<SelectionMenu | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const [revealingOlder, setRevealingOlder] = useState(false);
  const revealingOlderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timestamp when ctx menu was opened — clicks within 400ms are synthetic (from long-press release)
  const menuOpenedAtRef = useRef(0);
  // Zoomed text modal — opened by double-tap on a chat bubble on touch devices.
  // The chat view sets `user-select: none` on mobile so that long-press fires
  // our custom Copy/Quote menu rather than the native callout; this modal
  // gives users a place to re-enable native selection and pick out exactly
  // the portion they want to copy.
  const [zoomText, setZoomText] = useState<string | null>(null);
  const [renderItemLimit, setRenderItemLimit] = useState(CHAT_INITIAL_RENDER_ITEM_LIMIT);

  const autoScrollRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const lastScrollTopRef = useRef(0);
  // Y of the active touch's start, for detecting an explicit finger-down
  // (content scrolls up) gesture that should pause follow-mode immediately.
  const touchStartYRef = useRef(0);
  // Epoch ms of the last "LAST SENT" pin-banner show/hide. The banner is a
  // flow sibling of `.chat-view`, so toggling it resizes the scroll area by
  // ~60px and fires the ResizeObserver — which must NOT re-pin to bottom (the
  // banner only appears because the user scrolled UP). Used to suppress that
  // observer's re-pin for a short window after a banner toggle, so the height
  // oscillation can't snap the user back to the bottom (works for any input
  // method, including scrollbar drag that emits no wheel/touch).
  const bannerToggleAtRef = useRef(0);
  const suppressLoadOlderUntilRef = useRef(0);
  // ── Programmatic-scroll guard ────────────────────────────────────────────
  // `scrollToBottom` writes `el.scrollTop` directly, which fires a synthetic
  // `scroll` event. Without disambiguation, `handleScroll` sees that synthetic
  // event and recomputes `autoScrollRef.current = atBottom`, which usually
  // happens to be true and is harmless — but during in-flight user scrolling
  // the synthetic event can race against the user's real scroll, causing the
  // follow state to flip in ways the user did not request. The guard ignores
  // exactly ONE synthetic scroll event after a programmatic write, with a
  // 200 ms watchdog so a missed/throttled event never swallows real input.
  const programmaticIgnoreCountRef = useRef(0);
  const programmaticIgnoreUntilRef = useRef(0);
  // ── New-message counter while paused ──────────────────────────────────────
  // When the user has scrolled up and follow is paused, the floating "↓"
  // button surfaces an unread count so the paused state stays observable.
  // Resets to 0 on re-engagement (manual click, scroll back near bottom,
  // session switch).
  const newSinceUnfollowRef = useRef(0);
  const [newSinceUnfollow, setNewSinceUnfollow] = useState(0);
  const countedFinalEventIdsRef = useRef<Set<string>>(new Set());

  // ── Pinned last-sent user message (appears only when scrolled off top) ──
  // When the user scrolls back through a long chat we want them to see what
  // they last said without hunting for it. But while the real bubble is still
  // on screen we don't want a redundant banner — so the pin flips on only
  // when an IntersectionObserver says the bubble has left the viewport by
  // the TOP edge (i.e. pushed upward by new content), and flips off as soon
  // as the bubble comes back into view.
  const [pinnedAboveViewport, setPinnedAboveViewport] = useState(false);
  const [pinnedExpanded, setPinnedExpanded] = useState(false);
  const lastSentUserMessage = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type !== 'user.message') continue;
      const p = e.payload as Record<string, unknown>;
      if (p.pending === true || p.failed === true) continue;
      const text = typeof p.text === 'string' ? p.text : '';
      if (!text.trim()) continue;
      return { eventId: e.eventId, text, ts: e.ts, actorLabel: formatSharedActorLabel(t, p.sharedActor) };
    }
    return null;
  }, [events, t]);
  // Reset the expand state whenever the pinned target changes so a new
  // message never inherits the expanded state of an older one.
  useEffect(() => { setPinnedExpanded(false); }, [lastSentUserMessage?.eventId]);

  const suppressLoadOlder = useCallback((durationMs = 1200) => {
    suppressLoadOlderUntilRef.current = Date.now() + durationMs;
  }, []);

  // Track tool.call and normalized file.change events to trigger file panel refresh
  const [filePanelRefreshTrigger, setFilePanelRefreshTrigger] = useState(0);
  const lastToolCallTsRef = useRef(0);
  useEffect(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === 'tool.call' || e.type === 'file.change') {
        if (e.ts > lastToolCallTsRef.current) {
          lastToolCallTsRef.current = e.ts;
          const id = setTimeout(() => setFilePanelRefreshTrigger((n) => n + 1), 1000);
          return () => clearTimeout(id);
        }
        break;
      }
    }
  }, [events]);

  // Split-screen file panel — width and open state are per-session
  const [showFilePanel, setShowFilePanel] = useState(() => readPanelOpen(sessionId));
  const [filePanelWidth, setFilePanelWidth] = useState(() => readPanelWidth(sessionId));
  // GLOBAL toggle (not per-session): defaults open, synced across windows/tabs.
  const [desiredAgentsOpen, setDesiredAgentsOpen] = useState(readSdkAgentsOpen);
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const filePanelWidthRef = useRef(filePanelWidth);
  filePanelWidthRef.current = filePanelWidth;
  // Keep this window's toggle in sync when the global switch flips elsewhere
  // (another open chat window, or another browser tab).
  useEffect(() => {
    const onChange = () => setDesiredAgentsOpen(readSdkAgentsOpen());
    window.addEventListener(SDK_AGENTS_OPEN_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(SDK_AGENTS_OPEN_EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);

  // Re-load per-session values when sessionId changes
  const prevSessionIdRef = useRef(sessionId);
  useEffect(() => {
    if (sessionId === prevSessionIdRef.current) return;
    prevSessionIdRef.current = sessionId;
    setShowFilePanel(readPanelOpen(sessionId));
    setFilePanelWidth(readPanelWidth(sessionId));
  }, [sessionId]);

  const toggleFilePanel = useCallback(() => {
    setShowFilePanel((v) => {
      const next = !v;
      try { localStorage.setItem(panelOpenKey(sessionId), next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, [sessionId]);

  const setDesiredAgentsPanelOpen = useCallback((next: boolean) => {
    // Persist + broadcast; every window's listener (incl. this one) updates state.
    writeSdkAgentsOpen(next);
  }, []);

  const toggleAgentsPanel = useCallback(() => {
    setDesiredAgentsPanelOpen(!desiredAgentsOpen);
  }, [desiredAgentsOpen, setDesiredAgentsPanelOpen]);

  const onDragStart = useCallback((e: MouseEvent) => {
    e.preventDefault();
    dragStateRef.current = { startX: e.clientX, startWidth: filePanelWidthRef.current };
    const onMove = (ev: MouseEvent) => {
      if (!dragStateRef.current) return;
      const delta = dragStateRef.current.startX - ev.clientX;
      const maxW = Math.floor(window.innerWidth * FILE_PANEL_MAX_RATIO);
      const newW = Math.max(FILE_PANEL_MIN, Math.min(maxW, dragStateRef.current.startWidth + delta));
      setFilePanelWidth(newW);
    };
    const onUp = () => {
      try { localStorage.setItem(panelWidthKey(sessionId), String(filePanelWidthRef.current)); } catch { /* ignore */ }
      dragStateRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [sessionId]);

  const openFilePreview = useCallback((
    path: string,
    preferDiff = false,
    previewViewMode?: HtmlPreviewViewMode,
  ) => {
    if (!onPreviewFile) return;
    const resolvedPath = resolvePreviewPath(path, workdir);
    const viewMode = previewViewMode ?? (preferDiff ? 'diff' : 'source');
    onPreviewFile({
      path: resolvedPath,
      sessionName: sessionId ?? undefined,
      preferDiff: viewMode === 'diff' && preferDiff,
      previewViewMode: viewMode,
      preview: { status: 'loading', path: resolvedPath },
      rootPath: workdir ?? undefined,
      sourcePreviewLive: false,
    });
  }, [onPreviewFile, workdir]);

  const handlePathClick = useCallback((path: string) => {
    openFilePreview(path, false);
  }, [openFilePreview]);

  const handleFileChangeOpen = useCallback((path: string, preferDiff = false) => {
    openFilePreview(path, preferDiff);
  }, [openFilePreview]);

  const mapPreviewDispatchError = useCallback((err: unknown): string => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('WebSocket not connected') || msg.includes('daemon_offline') || msg.includes('503')) {
      return t('upload.daemon_offline');
    }
    return t('file_browser.preview_error');
  }, [t]);

  const handleHtmlPreview = useCallback((path: string) => {
    const resolvedPath = resolvePreviewPath(path, workdir);
    if (!ws || typeof ws.fsReadFile !== 'function') {
      setHtmlFullscreenPreview({
        status: 'error',
        path: resolvedPath,
        error: t('file_browser.preview_error'),
      });
      return;
    }
    try {
      const requestId = ws.fsReadFile(resolvedPath);
      setHtmlFullscreenPreview({ status: 'loading', path: resolvedPath, requestId });
    } catch (err) {
      setHtmlFullscreenPreview({
        status: 'error',
        path: resolvedPath,
        error: mapPreviewDispatchError(err),
      });
    }
  }, [mapPreviewDispatchError, t, workdir, ws]);

  const closeHtmlFullscreenPreview = useCallback(() => {
    setHtmlFullscreenPreview(null);
  }, []);

  useEffect(() => {
    if (!ws || typeof ws.onMessage !== 'function') return undefined;
    return ws.onMessage((msg) => {
      if (msg.type !== 'fs.read_response') return;
      setHtmlFullscreenPreview((current) => {
        if (!current || current.status !== 'loading' || current.requestId !== msg.requestId) return current;
        if (msg.status === 'error') {
          const error = msg.error === FS_READ_ERROR_CODES.FILE_TOO_LARGE
            ? t('chat.html_preview_too_large', 'HTML file is too large to render safely.')
            : t('file_browser.preview_error', 'Preview unavailable');
          return { status: 'error', path: current.path, error };
        }
        const next = { status: 'ok' as const, path: current.path, content: msg.content ?? '' };
        return openHtmlPreviewInNewWindow(next) ? null : next;
      });
    });
  }, [t, ws]);

  const handleUrlClick = useCallback((url: string) => {
    setPendingUrl(url);
  }, []);

  const mapDownloadError = useCallback((err: unknown): string => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('daemon_offline') || msg.includes('503')) return t('upload.daemon_offline');
    if (msg.includes('410') || msg.includes('expired') || msg.includes('not_found') || msg.includes('404')) return t('upload.download_expired');
    if (msg.includes('504') || msg.includes('timeout')) return t('upload.download_timeout');
    return t('upload.download_failed');
  }, [t]);

  const requestPathDownloadId = useCallback((path: string): Promise<string> => (
    new Promise((resolve, reject) => {
      if (!ws) {
        reject(new Error(t('upload.daemon_offline')));
        return;
      }
      let unsub: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        unsub?.();
      };
      try {
        const reqId = ws.fsReadFile(path);
        timer = setTimeout(() => {
          cleanup();
          reject(new Error(t('upload.download_timeout')));
        }, 30_000);
        unsub = ws.onMessage((msg) => {
          if (msg.type !== 'fs.read_response' || msg.requestId !== reqId) return;
          cleanup();
          if (typeof msg.downloadId === 'string' && msg.downloadId.trim()) {
            resolve(msg.downloadId);
            return;
          }
          if (msg.status === 'error') {
            reject(new Error(mapDownloadError(new Error(String(msg.error ?? 'download_failed')))));
            return;
          }
          reject(new Error(t('upload.download_failed')));
        });
      } catch (err) {
        cleanup();
        reject(new Error(mapDownloadError(err)));
      }
    })
  ), [mapDownloadError, t, ws]);

  const handleImagePreview = useCallback<ChatLocalImagePreviewLoader>((path: string) => (
    new Promise((resolve, reject) => {
      if (!ws || typeof ws.fsReadFile !== 'function' || typeof ws.onMessage !== 'function') {
        reject(new Error(t('file_browser.preview_error')));
        return;
      }

      let unsub: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const resolvedPath = resolvePreviewPath(path, workdir);
      const cacheScope = serverId ? `server:${serverId}` : `session:${sessionId ?? 'unknown'}`;
      const cacheKey = `${cacheScope}\0${resolvedPath}`;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        unsub?.();
      };

      getCachedChatLocalImagePreview(cacheKey, () => new Promise<ChatLocalImagePreviewResult>((resolveCached, rejectCached) => {
        try {
          const reqId = ws.fsReadFile(resolvedPath);
          timer = setTimeout(() => {
            cleanup();
            rejectCached(new Error(t('upload.download_timeout')));
          }, 30_000);
          unsub = ws.onMessage((msg) => {
            if (msg.type !== 'fs.read_response' || msg.requestId !== reqId) return;
            cleanup();
            if (msg.status === 'error') {
              rejectCached(new Error(t('file_browser.preview_error')));
              return;
            }
            if (msg.encoding === 'base64' && typeof msg.mimeType === 'string' && msg.mimeType.startsWith('image/')) {
              resolveCached({
                dataUrl: `data:${msg.mimeType};base64,${msg.content ?? ''}`,
                alt: resolvedPath.split(/[/\\]/).pop() || resolvedPath,
              });
              return;
            }
            rejectCached(new Error(t('file_browser.preview_error')));
          });
        } catch (err) {
          cleanup();
          rejectCached(err instanceof Error ? err : new Error(String(err)));
        }
      })).then(resolve, reject);
    })
  ), [serverId, sessionId, t, workdir, ws]);

  const handleDownload = useCallback<ChatPathDownloadHandler>(async (path: string) => {
    if (!serverId) throw new Error(t('upload.daemon_offline'));
    const resolvedPath = resolvePreviewPath(path, workdir);
    let downloadId = await requestPathDownloadId(resolvedPath);
    const { downloadAttachment } = await import('../api.js');
    try {
      await downloadAttachment(serverId, downloadId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isStaleHandle = msg.includes('410') || msg.includes('expired') || msg.includes('not_found') || msg.includes('404');
      if (!isStaleHandle) throw new Error(mapDownloadError(err));
      downloadId = await requestPathDownloadId(resolvedPath);
      try {
        await downloadAttachment(serverId, downloadId);
      } catch (retryErr) {
        throw new Error(mapDownloadError(retryErr));
      }
    }
  }, [mapDownloadError, requestPathDownloadId, serverId, t, workdir]);

  const pathClickHandler = ws && !preview ? handlePathClick : undefined;
  const htmlPreviewHandler = ws && typeof ws.fsReadFile === 'function' && !preview ? handleHtmlPreview : undefined;
  const imagePreviewHandler = ws && typeof ws.fsReadFile === 'function' && !preview ? handleImagePreview : undefined;
  const fileChangeOpenHandler = ws && !preview && onPreviewFile ? handleFileChangeOpen : undefined;
  const urlClickHandler = !preview ? handleUrlClick : undefined;
  const downloadHandler = serverId && ws ? handleDownload : undefined;

  // Tool-call/detail visibility preference (shared cache via usePref). Tri-state:
  //   value === true  → developer view, show tool/file/thinking rows
  //   value === false → simple chat, hide them
  //   value === null  → undecided (first run); show by default and surface a
  //                     one-time chooser banner above the timeline if the
  //                     user has actually generated developer-detail events.
  const showToolCallsPref = usePref<boolean>(PREF_KEY_SHOW_TOOL_CALLS, { parse: parseBooleanish });
  const showToolCalls = showToolCallsPref.value !== false;
  const showToolCallsUndecided = showToolCallsPref.loaded && showToolCallsPref.value === null;
  // Only show the chooser banner when the user has events the toggle would
  // actually affect. If the timeline has no tool/file/memory rows, the
  // choice is hypothetical and the prompt would be confusing. Mirrors the
  // exact set the show_tool_calls preference governs in `buildViewItems`.
  const hasToolEvents = useMemo(
    () => events.some((e) => TOOL_LIKE_EVENT_TYPES.has(e.type)),
    [events],
  );
  const showFirstTimeChooser = showToolCallsUndecided && hasToolEvents && !preview;
  const handleChooserPickDeveloper = useCallback(() => {
    void showToolCallsPref.save(true);
  }, [showToolCallsPref]);
  const handleChooserPickSimple = useCallback(() => {
    void showToolCallsPref.save(false);
  }, [showToolCallsPref]);
  const [sdkAgentsNow, setSdkAgentsNow] = useState(() => Date.now());
  const hasSdkAgentEvents = useMemo(() => hasSdkSubagentTimelineEvent(events), [events]);
  useEffect(() => {
    if (!hasSdkAgentEvents) return;
    setSdkAgentsNow(Date.now());
  }, [hasSdkAgentEvents, events]);
  const sdkAgentsStatus = useMemo(
    () => deriveSdkSubagentStatusRows(events, sdkAgentsNow),
    [events, sdkAgentsNow],
  );
  const hasAgentsStatusRows = sdkAgentsStatus.rows.length > 0 || sdkAgentsStatus.diagnostics.length > 0;
  useEffect(() => {
    if (preview || !hasAgentsStatusRows) return undefined;
    const timer = window.setInterval(() => setSdkAgentsNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasAgentsStatusRows, preview]);
  const canShowAgentsControl = !preview;
  // Keep the panel mounted for every retained sub-agent row, not only while at
  // least one child is currently running. Otherwise a just-finished child (or
  // a provider diagnostic) makes the entire list disappear even though the
  // aggregator still has authoritative status to show.
  const showAgentsPane = canShowAgentsControl && desiredAgentsOpen && hasAgentsStatusRows;

  // Preview cards (SubSessionCard) are small thumbnails; slice events to a
  // bounded tail BEFORE buildViewItems so it doesn't walk thousands of items
  // every time a sub-session card mounts/updates. Normal chat (the active
  // session pane / sub-session window) keeps the full list so "load older"
  // and infinite scroll-back continue to work — only the rendered slice is
  // capped further down (`renderedViewItems`).
  const sourceEvents = useMemo(
    () => (preview && events.length > PREVIEW_EVENT_TAIL_LIMIT
      ? events.slice(-PREVIEW_EVENT_TAIL_LIMIT)
      : events),
    [preview, events],
  );
  const viewItems = useMemo(() => buildViewItems(sourceEvents, showToolCalls), [sourceEvents, showToolCalls]);
  const finalVisibleEventIds = useMemo(
    () => getFinalVisibleEventIds(sourceEvents, showToolCalls),
    [sourceEvents, showToolCalls],
  );
  const effectiveRenderLimit = preview ? PREVIEW_RENDER_ITEM_LIMIT : renderItemLimit;
  const hiddenRenderedItemCount = Math.max(0, viewItems.length - effectiveRenderLimit);
  const renderedViewItems = useMemo(
    () => (hiddenRenderedItemCount > 0 ? viewItems.slice(-effectiveRenderLimit) : viewItems),
    [hiddenRenderedItemCount, effectiveRenderLimit, viewItems],
  );
  const renderedRevision = useMemo(
    () => getRenderedViewRevision(renderedViewItems),
    [renderedViewItems],
  );

  useEffect(() => {
    if (revealingOlderTimerRef.current) {
      clearTimeout(revealingOlderTimerRef.current);
      revealingOlderTimerRef.current = null;
    }
    setRevealingOlder(false);
    setRenderItemLimit(CHAT_INITIAL_RENDER_ITEM_LIMIT);
  }, [sessionId]);

  useEffect(() => () => {
    if (revealingOlderTimerRef.current) clearTimeout(revealingOlderTimerRef.current);
  }, []);

  const markProgrammaticScroll = () => {
    // Bounded one-shot: skip exactly one upcoming synthetic scroll event.
    programmaticIgnoreCountRef.current = 1;
    // Watchdog: if the synthetic event is throttled or never fires, release
    // the guard after 200ms so legitimate user input never gets swallowed.
    programmaticIgnoreUntilRef.current = Date.now() + 200;
  };

  const revealHiddenOlderItems = () => {
    if (revealingOlderTimerRef.current) clearTimeout(revealingOlderTimerRef.current);
    setRevealingOlder(true);
    setRenderItemLimit((limit) => limit + CHAT_RENDER_ITEM_INCREMENT);
    revealingOlderTimerRef.current = setTimeout(() => {
      revealingOlderTimerRef.current = null;
      setRevealingOlder(false);
    }, 450);
  };

  // Pure motion + optional policy. Default `engageFollow=true` preserves the
  // public contract used by `onScrollBottomFn` parents (SessionPane,
  // SubSessionWindow), which intentionally call this after the user sends a
  // message and expect "force jump + re-engage".
  const scrollToBottom = (engageFollow: boolean = true) => {
    const el = scrollRef.current;
    if (!el) return;
    if (engageFollow) {
      autoScrollRef.current = true;
      newSinceUnfollowRef.current = 0;
      setNewSinceUnfollow(0);
      countedFinalEventIdsRef.current = new Set(finalVisibleEventIds);
    }
    suppressLoadOlder();
    markProgrammaticScroll();
    el.scrollTop = el.scrollHeight;
    lastScrollTopRef.current = el.scrollTop;
  };

  // (No `followIfEngaged` helper: the two callsites that need it are also
  // preview-aware, and inlining `if (preview || autoScrollRef.current)`
  // there reads more clearly than threading preview-awareness through a
  // helper that would otherwise have to capture the prop.)

  // On session change, reset scroll position to bottom
  useEffect(() => {
    autoScrollRef.current = true;
    hasInitialScrolledRef.current = false;
    newSinceUnfollowRef.current = 0;
    setNewSinceUnfollow(0);
    countedFinalEventIdsRef.current = new Set(finalVisibleEventIds);
    setShowScrollBtn(false);
    // Force scroll to bottom on tab switch — the auto-scroll effect may not fire
    // if no new events arrived while this tab was inactive.
    requestAnimationFrame(() => scrollToBottom(true));
  }, [sessionId]);

  // On mobile: when keyboard opens, viewport shrinks and scrollTop can reset to 0.
  // Save the relative bottom offset on focusin, then restore against the new layout
  // when visualViewport height decreases (keyboard appeared). Using absolute scrollTop
  // is brittle on iOS and can replay a stale 0 value, snapping the chat to the top.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let savedBottomOffset = 0;
    let savedWasNearBottom = true;
    let prevHeight = vv.height;
    const onFocusIn = () => {
      const el = scrollRef.current;
      if (!el) return;
      savedBottomOffset = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
      savedWasNearBottom = savedBottomOffset < 150;
      suppressLoadOlder();
    };
    const onResize = () => {
      const el = scrollRef.current;
      if (!el) return;
      if (vv.height !== prevHeight) {
        suppressLoadOlder();
        if (savedWasNearBottom || autoScrollRef.current) {
          requestAnimationFrame(() => scrollToBottom());
        } else if (vv.height < prevHeight) {
          const targetTop = Math.max(0, el.scrollHeight - el.clientHeight - savedBottomOffset);
          el.scrollTop = targetTop;
          lastScrollTopRef.current = el.scrollTop;
        }
      }
      prevHeight = vv.height;
    };
    vv.addEventListener('resize', onResize);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      vv.removeEventListener('resize', onResize);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, []);

  // Expose scroll-to-bottom fn to parent (stable when parent uses useCallback).
  useEffect(() => {
    onScrollBottomFn?.(scrollToBottom);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onScrollBottomFn]);

  // Scroll to bottom once on mount (e.g. when switching terminal→chat).
  // Keep separate from fn-registration so parent re-renders don't re-trigger.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { scrollToBottom(); }, []);

  // Track whether the last sent user bubble is above/below/inside the
  // viewport. Only "above" flips the pin on — that's when new assistant
  // output has pushed the user's last prompt off the top and they'd
  // otherwise have to scroll up to re-read it. Below / intersecting cases
  // both leave the pin hidden.
  useEffect(() => {
    // Preview mode (sub-session card) never renders the pinned banner — it
    // sits in `.chat-main`'s normal flow as a sibling of `.chat-view`, so its
    // appearance/disappearance shifts content height by ~60 px. Inside the
    // small preview card the user's last bubble can be just outside the
    // viewport top by ≤60 px; banner-shows pushes the bubble down into the
    // viewport, IO fires `isIntersecting=true`, banner-hides pulls the
    // bubble back above viewport, IO fires again — infinite oscillation
    // around ~50–100 px from bottom. Bail in preview so neither the banner
    // nor the observer can run.
    if (preview) {
      setPinnedAboveViewport(false);
      return;
    }
    if (!lastSentUserMessage) {
      setPinnedAboveViewport(false);
      return;
    }
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    // jsdom (unit tests) and a small long tail of old WebKit versions don't
    // ship IntersectionObserver. Bail before touching it — no pin is better
    // than a blow-up rendering any chat view at all.
    if (typeof IntersectionObserver === 'undefined') {
      setPinnedAboveViewport(false);
      return;
    }
    const target = findEventElement(scrollEl, lastSentUserMessage.eventId);
    if (!target) {
      // Target not mounted yet (virtualization, pagination) — treat as above
      // viewport ONLY if the user isn't sitting at the bottom of the scroll
      // (i.e. they're reading older history). Otherwise keep the pin hidden
      // so a bubble that never actually rendered doesn't cause a ghost pin.
      const atBottom = Math.abs(scrollEl.scrollHeight - scrollEl.clientHeight - scrollEl.scrollTop) < 40;
      setPinnedAboveViewport(!atBottom);
      return;
    }

    // In sub-session cards the .chat-view doesn't actually scroll — its
    // parent .subcard-preview holds the scrollbar and .chat-view just grows
    // with content. Observing .chat-view as root would therefore never fire
    // an above-viewport event. Detect the real scrolling ancestor and use
    // that instead. For main pane + sub-session window this naturally
    // resolves back to .chat-view itself.
    const root = findScrollParent(scrollEl);
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.target !== target) continue;
        if (entry.isIntersecting) {
          setPinnedAboveViewport(false);
          continue;
        }
        // Above viewport: the bubble's bottom edge is above the root's top.
        // Below viewport is the opposite — we leave the pin off in that case
        // because the user just scrolled up and the real bubble is still
        // within easy scroll reach, not "lost".
        const rootBounds = entry.rootBounds;
        const rect = entry.boundingClientRect;
        if (rootBounds && rect.bottom <= rootBounds.top) {
          setPinnedAboveViewport(true);
        } else {
          setPinnedAboveViewport(false);
        }
      }
    }, { root, threshold: [0, 1] });
    observer.observe(target);
    return () => observer.disconnect();
  }, [lastSentUserMessage?.eventId, preview]);

  // Stamp when the pin banner toggles so the ResizeObserver can tell its own
  // ~60px height shift apart from a genuine viewport resize (sub-session bar,
  // keyboard) and skip re-pinning to bottom for the former. See bannerToggleAtRef.
  useEffect(() => {
    bannerToggleAtRef.current = Date.now();
  }, [pinnedAboveViewport]);

  // Auto-scroll only on visible new events — agent.status / assistant.thinking / usage.update
  // events are filtered from the chat view but still part of `events`, so using the raw last ts
  // would trigger spurious scrolls while the agent is running without any new visible content.
  const lastVisibleTs = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (!e.hidden && e.type !== 'agent.status' && e.type !== 'usage.update') {
        return e.ts;
      }
    }
    return 0;
  }, [events]);
  const prevVisibleTsRef = useRef(lastVisibleTs);
  const hasInitialScrolledRef = useRef(false);
  const layoutHandledVisibleTsRef = useRef(lastVisibleTs);
  const prevRenderedRevisionRef = useRef(renderedRevision);
  const prevLoadingRef = useRef(loading);

  // Synchronous scroll-to-bottom BEFORE paint on initial history load.
  // useLayoutEffect runs after DOM mutation but before the browser paints,
  // so the user never sees content at the top position.
  useLayoutEffect(() => {
    if (preview) return;
    if (!hasInitialScrolledRef.current && lastVisibleTs > 0) {
      hasInitialScrolledRef.current = true;
      // Use the non-engaging variant. autoScrollRef is initialised to true,
      // so on the genuine first mount this still scrolls. On rerenders that
      // happen while the user has scrolled away (autoScrollRef=false), the
      // session-change effect's reset of hasInitialScrolledRef can cause
      // this branch to re-fire when lastVisibleTs next advances; in that
      // window we MUST NOT engage follow because the user did not request
      // it. The session-change effect itself already schedules an explicit
      // force-jump rAF so the genuine session-switch case still re-engages.
      if (autoScrollRef.current) scrollToBottom(false);
    }
  }, [lastVisibleTs]);

  // Any visible content update should follow IFF the user is currently
  // engaged with auto-follow. Preview mode keeps its existing "always follow"
  // contract because it is a tiny live monitor, not a reading surface.
  // Skip while prepending older history so anchor restoration can preserve position.
  useLayoutEffect(() => {
    const revisionChanged = renderedRevision !== prevRenderedRevisionRef.current;
    const contentBecameVisible = prevLoadingRef.current && !loading;
    prevRenderedRevisionRef.current = renderedRevision;
    prevLoadingRef.current = loading;
    if (!revisionChanged && !contentBecameVisible) return;
    if (loadingOlder || scrollAnchorRef.current) return;
    const shouldFollow = preview || autoScrollRef.current;
    if (!shouldFollow) {
      // User is reading older content; do not yank the viewport. Surface the
      // arrival via the unread counter on the "↓" affordance. Count only
      // newly-finalized visible events: streaming updates for the same
      // eventId should not inflate the badge on every chunk.
      let addedFinalEvents = 0;
      const nextCounted = new Set(countedFinalEventIdsRef.current);
      for (const eventId of finalVisibleEventIds) {
        if (nextCounted.has(eventId)) continue;
        nextCounted.add(eventId);
        addedFinalEvents += 1;
      }
      countedFinalEventIdsRef.current = nextCounted;
      if (addedFinalEvents > 0) {
        newSinceUnfollowRef.current += addedFinalEvents;
        setNewSinceUnfollow(newSinceUnfollowRef.current);
      }
      layoutHandledVisibleTsRef.current = lastVisibleTs;
      return;
    }
    scrollToBottom(false);
    layoutHandledVisibleTsRef.current = lastVisibleTs;
  }, [preview, renderedRevision, loading, loadingOlder, lastVisibleTs, finalVisibleEventIds]);

  // Restore scroll position after Load Older prepends events
  useLayoutEffect(() => {
    const anchor = scrollAnchorRef.current;
    if (!anchor) return;
    const el = scrollRef.current;
    if (!el) return;
    const delta = el.scrollHeight - anchor.scrollHeight;
    if (delta > 0) el.scrollTop += delta;
    scrollAnchorRef.current = null;
  }, [events, renderItemLimit]);

  // Fallback for timestamp-based message additions. The layout effect above handles
  // streaming edits and other view changes that do not advance timestamps.
  useEffect(() => {
    const changed = lastVisibleTs !== prevVisibleTsRef.current;
    prevVisibleTsRef.current = lastVisibleTs;
    if (!changed && !preview) return;
    if (layoutHandledVisibleTsRef.current === lastVisibleTs) return;
    requestAnimationFrame(() => {
      // Re-check inside the rAF callback so a state flip during the frame
      // window (e.g. a user scroll-up that lands between schedule and fire)
      // is honoured. Preview always follows by design.
      if (preview || autoScrollRef.current) scrollToBottom(false);
    });
  }, [lastVisibleTs, preview]);

  const lastScrollActivityRef = useRef(Date.now());
  // (Previously SCROLL_IDLE_RESUME_MS = 60_000 drove a setInterval that
  // unilaterally re-engaged auto-follow + snapped to bottom 60s after the
  // last scroll activity. That interval has been removed because it was
  // exactly the "auto-update fights scroll experience" complaint that
  // motivated this fix. Re-engagement now happens only via explicit user
  // intent: scrolling back near the bottom (`reengageThreshold`), clicking
  // the "↓" button, pressing the End key, switching sessions, or sending a
  // new message.)

  // Scroll auto-trigger for Load Older
  const lastLoadOlderAtRef = useRef(0);
  const LOAD_OLDER_COOLDOWN_MS = 1000;
  // Scroll anchor preservation: save scrollHeight before prepend, restore after
  const scrollAnchorRef = useRef<{ scrollHeight: number } | null>(null);

  // Pause "stick to bottom" follow mode. Shared by handleScroll's distance
  // threshold and the explicit wheel/touch up-gesture handlers below.
  const disengageFollow = () => {
    if (!autoScrollRef.current) return;
    autoScrollRef.current = false;
    newSinceUnfollowRef.current = 0;
    setNewSinceUnfollow(0);
    countedFinalEventIdsRef.current = new Set(finalVisibleEventIds);
    setShowScrollBtn(true);
    lastScrollActivityRef.current = Date.now();
  };

  // An explicit upward wheel/touch gesture is unambiguous "stop following"
  // intent. Honour it the instant it happens — BEFORE the next programmatic
  // `scrollToBottom` (streaming, ResizeObserver, the "LAST SENT" pin banner
  // toggling height) can re-pin the view. The distance-threshold path in
  // handleScroll loses this race at certain heights in Safari, where only a
  // large fast swipe escapes; this path makes a gentle scroll-up reliable.
  // These events are never synthesised by scrollToBottom, so they can't
  // false-trigger. Re-engagement stays distance-based (scroll back to bottom).
  const handleUserScrollUpIntent = () => {
    if (preview || !autoScrollRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.clientHeight < 8) return; // nothing to scroll into
    disengageFollow();
  };
  const handleWheel = (e: WheelEvent) => {
    if (e.deltaY < 0) handleUserScrollUpIntent();
  };
  const handleTouchStart = (e: TouchEvent) => {
    touchStartYRef.current = e.touches[0]?.clientY ?? 0;
  };
  const handleTouchMove = (e: TouchEvent) => {
    const y = e.touches[0]?.clientY ?? 0;
    // Finger moving DOWN (clientY increases) drags content UP toward older
    // history. 6px deadzone avoids reacting to taps / micro-jitter.
    if (y - touchStartYRef.current > 6) handleUserScrollUpIntent();
  };

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Programmatic-scroll guard: if a recent `scrollToBottom(...)` call
    // marked an upcoming synthetic event AND the resulting scrollTop is
    // actually at the bottom (i.e. our write succeeded), swallow exactly
    // one event. Position-aware so iOS layout shifts that reset scrollTop
    // to 0 still reach the transient-top-jump recovery branch below.
    if (
      programmaticIgnoreCountRef.current > 0
      && Date.now() < programmaticIgnoreUntilRef.current
      && el.scrollHeight - el.scrollTop - el.clientHeight < 50
    ) {
      programmaticIgnoreCountRef.current -= 1;
      return;
    }
    programmaticIgnoreCountRef.current = 0;
    const scrollTop = el.scrollTop;
    const scrollHeight = el.scrollHeight;
    const clientHeight = el.clientHeight;
    const wasAutoFollowing = autoScrollRef.current;
    const transientTopJump = wasAutoFollowing
      && scrollTop < 100
      && lastScrollTopRef.current > 100
      && Date.now() < suppressLoadOlderUntilRef.current;
    if (transientTopJump) {
      setShowScrollBtn(false);
      requestAnimationFrame(() => scrollToBottom(true));
      return;
    }
    // Adaptive + hysteresis thresholds (avoid boundary flicker during streaming
    // layout; avoid mobile over-engagement), with a short-content guard so
    // follow-mode is always escapable by scrolling up even when the content
    // barely overflows the viewport. See chat-follow-thresholds.ts. This is the
    // secondary disengage path; the primary is the wheel/touch gesture handler.
    const distance = scrollHeight - scrollTop - clientHeight;
    const { disengageThreshold, reengageThreshold } = computeFollowThresholds(clientHeight, scrollHeight);
    if (wasAutoFollowing && distance > disengageThreshold) {
      disengageFollow();
    } else if (!wasAutoFollowing && distance < reengageThreshold) {
      autoScrollRef.current = true;
      newSinceUnfollowRef.current = 0;
      setNewSinceUnfollow(0);
      countedFinalEventIdsRef.current = new Set(finalVisibleEventIds);
    }
    setShowScrollBtn(!autoScrollRef.current);
    if (!autoScrollRef.current) lastScrollActivityRef.current = Date.now();
    lastScrollTopRef.current = scrollTop;
    // Auto-trigger load older when scrolled near top. Skip in preview mode —
    // preview cards have a fixed render tail (PREVIEW_RENDER_ITEM_LIMIT) and
    // should never expand their event budget from a tiny thumbnail scroll.
    if (!preview && scrollTop < 100 && (hiddenRenderedItemCount > 0 || (onLoadOlder && hasOlderHistory)) && !loadingOlder && !loading) {
      const now = Date.now();
      if (now - lastLoadOlderAtRef.current >= LOAD_OLDER_COOLDOWN_MS) {
        lastLoadOlderAtRef.current = now;
        if (hiddenRenderedItemCount > 0) {
          revealHiddenOlderItems();
        } else {
          scrollAnchorRef.current = { scrollHeight };
          onLoadOlder?.();
        }
      }
    }
  };

  // (Removed: the 60-s idle-resume timer. See the comment near
  // `lastScrollActivityRef` above for rationale.)

  // Keep the active chat pinned to bottom when layout changes reduce available height
  // (for example, when the sub-session bar appears after tab switch).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    let prevClientHeight = el.clientHeight;
    const ro = new ResizeObserver(() => {
      const nextClientHeight = el.clientHeight;
      if (nextClientHeight === prevClientHeight) return;
      prevClientHeight = nextClientHeight;
      if (preview) return;
      // If this resize was the pin banner toggling its own ~60px height, do NOT
      // re-pin — the banner only appears because the user scrolled UP, so
      // re-pinning would snap them back and (since that re-hides the banner)
      // start the height-oscillation jitter loop. A genuine viewport resize
      // (sub-session bar, keyboard) has no recent banner toggle and still pins.
      if (Date.now() - bannerToggleAtRef.current < 300) return;
      // Re-check follow state INSIDE the rAF: a user scroll-up that disengages
      // during the frame gap must still win, or we'd snap them back against
      // their intent.
      requestAnimationFrame(() => {
        if (autoScrollRef.current) scrollToBottom();
      });
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, [preview]);

  // Touch gesture mode is based on pointer coarseness only. Narrow desktop
  // windows still need native selection and the Copy/Quote popup.
  const isTouchDevice = useTouchChatGestures();
  const getActionMenuContainerRect = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return null;
    const mainEl = container.closest('.chat-main') as HTMLElement | null;
    return (mainEl ?? container).getBoundingClientRect();
  }, []);

  useLayoutEffect(() => {
    if (!selMenu || !selMenuRef.current) return;
    const containerRect = getActionMenuContainerRect();
    if (!containerRect) return;
    const menuRect = selMenuRef.current.getBoundingClientRect();
    const next = positionChatActionMenu(
      selMenu.anchorClientX,
      selMenu.anchorClientY,
      containerRect,
      { width: menuRect.width, height: menuRect.height },
    );
    if (Math.abs(selMenu.x - next.x) < 0.5 && Math.abs(selMenu.y - next.y) < 0.5) return;
    setSelMenu({ ...selMenu, ...next });
  }, [getActionMenuContainerRect, selMenu]);

  useLayoutEffect(() => {
    if (!ctxMenu || !ctxMenuRef.current) return;
    const containerRect = getActionMenuContainerRect();
    if (!containerRect) return;
    const menuRect = ctxMenuRef.current.getBoundingClientRect();
    const next = positionChatActionMenu(
      ctxMenu.anchorClientX,
      ctxMenu.anchorClientY,
      containerRect,
      { width: menuRect.width, height: menuRect.height },
    );
    if (Math.abs(ctxMenu.x - next.x) < 0.5 && Math.abs(ctxMenu.y - next.y) < 0.5) return;
    setCtxMenu({ ...ctxMenu, ...next });
  }, [ctxMenu, getActionMenuContainerRect]);

  // Desktop: show selection popup menu when text is selected within the chat view
  useEffect(() => {
    if (isTouchDevice) return; // mobile uses long-press instead
    let lastSelectionSignature = '';
    const onSelChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        lastSelectionSignature = '';
        setSelMenu(null);
        return;
      }
      const signature = selectionSignature(sel);
      if (signature && signature === lastSelectionSignature) return;
      const range = sel.getRangeAt(0);
      const container = scrollRef.current;
      if (!container || !container.contains(range.commonAncestorContainer)) {
        lastSelectionSignature = '';
        setSelMenu(null);
        return;
      }
      lastSelectionSignature = signature;
      // Use our DOM-walker rather than `sel.toString()` so that the captured
      // text preserves paragraph/list/code-block boundaries. Browsers disagree
      // on what `Selection.toString()` does at block boundaries (Safari often
      // flattens), which is the bug that was dropping newlines from copied
      // multi-paragraph assistant messages.
      const text = selectionToPlainText(sel) || sel.toString().trim();
      if (!text) { setSelMenu(null); return; }
      const selRect = typeof range.getBoundingClientRect === 'function'
        ? range.getBoundingClientRect()
        : null;
      const mainEl = container.closest('.chat-main') as HTMLElement | null;
      const mainRect = (mainEl ?? container).getBoundingClientRect();
      const anchorClientX = selRect && selRect.width > 0
        ? selRect.left + selRect.width / 2
        : mainRect.left + mainRect.width / 2;
      const anchorClientY = selRect && selRect.height > 0
        ? selRect.top
        : mainRect.top + 12;
      const position = positionChatActionMenu(anchorClientX, anchorClientY, mainRect);
      setSelMenu({
        ...position,
        anchorClientX,
        anchorClientY,
        text,
      });
      setCopied(false);
    };
    document.addEventListener('selectionchange', onSelChange);
    return () => document.removeEventListener('selectionchange', onSelChange);
  }, [isTouchDevice]);

  // Show custom context menu (Copy/Quote) at given position for given target element.
  const openCtxMenu = useCallback((target: HTMLElement, clientX: number, clientY: number) => {
    if (highlightElRef.current) highlightElRef.current.classList.remove('chat-highlight');
    target.classList.add('chat-highlight');
    setHighlightEl(target);
    const text = extractChatEventText(target);
    if (!text) return;
    const mainRect = getActionMenuContainerRect();
    if (!mainRect) return;
    const position = positionChatActionMenu(clientX, clientY, mainRect);
    menuOpenedAtRef.current = Date.now();
    // Resolve the message this menu was opened on so we can offer "Delete message".
    // The id lives on the `.chat-event` wrapper (user msgs) or a descendant (assistant block).
    const eventId = target.getAttribute('data-event-id')
      ?? target.querySelector('[data-event-id]')?.getAttribute('data-event-id')
      ?? undefined;
    setCtxMenu({
      ...position,
      anchorClientX: clientX,
      anchorClientY: clientY,
      text,
      eventId,
    });
  }, [getActionMenuContainerRect]);

  // Desktop: right-click → contextmenu event → custom menu
  const handleContextMenu = useCallback((e: Event) => {
    if (preview) return;
    e.preventDefault();
    const target = (e.target as HTMLElement)?.closest?.('.chat-event') as HTMLElement | null;
    if (!target) return;
    const me = e as MouseEvent;
    openCtxMenu(target, me.clientX ?? 0, me.clientY ?? 0);
  }, [preview, openCtxMenu]);

  // Mobile: touch timer long-press → custom menu.
  // Native contextmenu doesn't fire on iOS when user-select:none + touch-callout:none are set.
  //
  // Double-tap on a `.chat-assistant` / `.chat-user` bubble opens the
  // ZoomedTextDialog so the user can re-enable native selection and copy a
  // specific portion. We detect the second tap on the synthetic `click`
  // event rather than `touchend` because:
  //   * iOS Safari reliably fires `click` on a short tap (viewport
  //     `user-scalable=no` removes the 300 ms double-tap probe delay);
  //   * if long-press fires, the one-shot `cancelEvent` on touchend
  //     `preventDefault`s, which suppresses the synthetic click;
  //   * pairing by `data-event-id` (a string) survives Preact re-renders
  //     of streaming assistant blocks — a DOM-ref `===` check would lose
  //     the pairing whenever the merged bubble grew between taps.
  useEffect(() => {
    if (!isTouchDevice || preview) return;
    const container = scrollRef.current;
    if (!container) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let startX = 0, startY = 0;
    let startTarget: HTMLElement | null = null;
    let lastTapEventId = '';
    let lastTapTs = 0;

    // Telegram pattern: eat the touchend + subsequent click after menu opens
    const cancelEvent = (e: Event) => { e.preventDefault(); e.stopPropagation(); };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length > 1) {
        // multi-touch → cancel any in-flight tap tracking; this is a pinch/scroll
        if (timer) { clearTimeout(timer); timer = null; }
        return;
      }
      const t = e.touches[0];
      startX = t.clientX; startY = t.clientY;
      startTarget = e.target as HTMLElement;
      timer = setTimeout(() => {
        timer = null;
        const chatEvent = startTarget?.closest?.('.chat-event') as HTMLElement | null;
        if (!chatEvent) return;
        openCtxMenu(chatEvent, startX, startY);
        // One-shot: eat the touchend that follows to prevent synthetic click from closing menu
        container.addEventListener('touchend', cancelEvent, { once: true, capture: true });
      }, LONG_PRESS_MS);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!timer) return;
      const t = e.touches[0];
      if (Math.abs(t.clientX - startX) > TAP_MOVE_TOLERANCE_PX || Math.abs(t.clientY - startY) > TAP_MOVE_TOLERANCE_PX) {
        clearTimeout(timer); timer = null;
      }
    };

    const onTouchEnd = () => {
      // Long-press fired or finger moved? clear timer; double-tap pairing
      // is handled in onClick (which won't fire if cancelEvent ran).
      if (timer) { clearTimeout(timer); timer = null; }
    };

    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const bubble = target?.closest?.('.chat-assistant, .chat-user') as HTMLElement | null;
      if (!bubble) {
        lastTapEventId = ''; lastTapTs = 0;
        return;
      }
      // Fall back to a positional fingerprint when data-event-id is absent
      // (defensive — both bubble flavours now carry it, but a stale build
      // or an unwired sub-component shouldn't break the zoom path).
      const id = bubble.dataset.eventId || `pos:${Math.round(bubble.getBoundingClientRect().top)}`;
      const now = Date.now();
      if (lastTapEventId === id && now - lastTapTs < DOUBLE_TAP_THRESHOLD_MS) {
        const text = extractChatEventText(bubble);
        if (text) setZoomText(text);
        lastTapEventId = ''; lastTapTs = 0;
      } else {
        lastTapEventId = id; lastTapTs = now;
      }
    };

    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: true });
    container.addEventListener('touchend', onTouchEnd, { passive: true });
    container.addEventListener('touchcancel', onTouchEnd, { passive: true });
    container.addEventListener('click', onClick);
    return () => {
      if (timer) clearTimeout(timer);
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
      container.removeEventListener('click', onClick);
      container.removeEventListener('touchend', cancelEvent, { capture: true } as EventListenerOptions);
    };
  }, [isTouchDevice, preview, openCtxMenu]);

  const canShowFilePanel = !preview && !!ws;
  const hasRightPanel = showAgentsPane || (canShowFilePanel && showFilePanel);
  // Per-machine chat-window font preference (family + size). Stored in
  // localStorage under `imcodes_fontPrefs:chat`; not synced across devices,
  // because each machine's display, OS font availability, and viewing
  // distance differ. Surfaced via the title-bar dropdown on every platform
  // — phones included — so users can pick the font that reads best for them.
  const [chatFontPrefs, setChatFontPrefs] = useFontPrefs('chat', DEFAULT_CHAT_FONT);
  const chatFontStyle = !preview
    ? { fontSize: `${chatFontPrefs.size}px`, fontFamily: chatFontPrefs.family }
    : undefined;
  const historySteps = useMemo(() => {
    if (!historyStatus || historyStatus.phase === 'idle') return [];
    const order: TimelineHistoryStepKey[] = ['cache', 'textTail', 'daemon', 'http', 'older'];
    return order
      .map((key) => ({ key, state: historyStatus.steps[key] }))
      .filter((step) => step.state !== 'skipped')
      .map((step) => ({
        ...step,
        label: step.key === 'cache'
          ? t('session.history_step_cache')
          : step.key === 'textTail'
            ? t('session.history_step_text_tail')
            : step.key === 'daemon'
              ? t('session.history_step_daemon')
              : step.key === 'http'
                ? t('session.history_step_http')
                : t('session.history_step_older'),
      }));
  }, [historyStatus, t]);
  const showHistoryProgress = !preview && historySteps.some((step) => step.state === 'pending' || step.state === 'running');
  const showRefreshOverlay = !preview && (showHistoryProgress || refreshing);
  return (
    <div class={`chat-view-wrap${hasRightPanel ? ' chat-split' : ''}`}>
      {(canShowAgentsControl || onForceSync || canShowFilePanel) && (
        <div class="chat-top-actions">
          {onForceSync && (
            <button
              class={`chat-panel-toggle chat-sync-btn${refreshing ? ' spinning' : ''}`}
              onClick={handleForceSync}
              disabled={syncDisabled}
              title={t('chat.sync_history')}
              aria-label={t('chat.sync_history')}
            >
              ↻
            </button>
          )}
          {canShowAgentsControl && (
            <button
              type="button"
              class={`chat-panel-toggle chat-sdk-agents-toggle${desiredAgentsOpen ? ' active' : ''}`}
              onClick={toggleAgentsPanel}
              title={t('chat.sdk_agents_toggle')}
              aria-label={t('chat.sdk_agents_toggle_aria', { count: sdkAgentsStatus.runningCount })}
              aria-expanded={showAgentsPane}
            >
              <SdkAgentsGlyph />
              {/* Always show the count badge — including 0 — so the toggle reads
                  as a status indicator (its green `.active` frame already shows
                  open/closed). The 0 state is muted so it doesn't imply running. */}
              <span
                class={`chat-sdk-agents-badge${sdkAgentsStatus.runningCount === 0 ? ' chat-sdk-agents-badge-zero' : ''}`}
                aria-label={t('chat.sdk_agents_badge_aria', { count: sdkAgentsStatus.runningCount })}
              >
                {sdkAgentsStatus.runningCount}
              </span>
            </button>
          )}
          {canShowFilePanel && (
            <button
              class={`chat-panel-toggle${showFilePanel ? ' active' : ''}`}
              onClick={toggleFilePanel}
              title={showFilePanel ? t('chat.hide_file_panel') : t('chat.show_file_panel')}
            >
              ⊞
            </button>
          )}
        </div>
      )}
      <div class="chat-main">
        {!preview && (
          <div
            class="chat-titlebar"
            style={{
              display: 'flex',
              alignItems: 'center',
              // Left-align the font dropdown so it doesn't collide with the
              // absolutely-positioned `chat-panel-toggle` (⊞) at top:6/right:8.
              // The two controls now sit at opposite ends and never overlap.
              justifyContent: 'flex-start',
              gap: 6,
              padding: '4px 8px',
              minHeight: 30,
              flexShrink: 0,
              borderBottom: '1px solid rgba(51,65,85,0.5)',
              background: 'rgba(15,23,42,0.35)',
            }}
          >
            <FontPrefsDropdown
              prefs={chatFontPrefs}
              onChange={setChatFontPrefs}
              variant="compact"
            />
            <SessionRepoBranchSummary
              sessionId={sessionId}
              projectDir={workdir}
              onOpenRepo={onViewRepo}
              className="session-repo-branch-summary-chat-titlebar"
            />
          </div>
        )}
        {showRefreshOverlay && (
          <div
            class={`chat-history-overlay${showHistoryProgress ? ' has-steps' : ''}`}
            aria-label={t('chat.refreshing_history', 'Updating history')}
            title={t('chat.refreshing_history', 'Updating history')}
          >
            <span class="chat-refreshing-spinner" aria-hidden="true" />
            {showHistoryProgress && (
              <>
                <span class="chat-history-overlay-label">{t('session.history_loading_label')}</span>
                <span class="chat-history-overlay-steps">
                  {historySteps.map((step) => (
                    <span key={step.key} class={`chat-history-step ${step.state}`}>
                      <span class="chat-history-step-icon" aria-hidden="true">
                        {step.state === 'done' ? '✓' : step.state === 'running' ? '…' : '○'}
                      </span>
                      {step.label}
                    </span>
                  ))}
                </span>
              </>
            )}
          </div>
        )}
        {!preview && pinnedAboveViewport && lastSentUserMessage && (
          <div
            class={`chat-pinned-last-sent${pinnedExpanded ? ' chat-pinned-expanded' : ''}`}
            role="button"
            tabIndex={0}
            aria-label={t('chat.pinned_last_sent_aria', 'Jump to your last sent message')}
            onClick={() => {
              // Tap once → toggle 2-line clamp; tap again (while expanded)
              // behaves like a jump-to-message. Holds the expand state so a
              // long message can be read without hunting for it.
              if (!pinnedExpanded) { setPinnedExpanded(true); return; }
              const root = scrollRef.current;
              if (!root) return;
              const target = findEventElement(root, lastSentUserMessage.eventId);
              if (target) {
                // Respect the OS reduced-motion preference — smooth scrolling
                // is a vestibular-trigger axis for some users.
                const reducedMotion = typeof window !== 'undefined'
                  && window.matchMedia
                  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
                target.scrollIntoView({
                  behavior: reducedMotion ? 'auto' : 'smooth',
                  block: 'center',
                });
              }
            }}
          >
            <span class="chat-pinned-last-sent-meta">
              <span class="chat-pinned-last-sent-label">{t('chat.pinned_last_sent_label', 'Last sent')}</span>
              {lastSentUserMessage.actorLabel && (
                <span class="chat-pinned-last-sent-actor">{lastSentUserMessage.actorLabel}</span>
              )}
              <span class="chat-pinned-last-sent-time">{formatChatDateTime(lastSentUserMessage.ts)}</span>
            </span>
            <span class="chat-pinned-last-sent-text">{lastSentUserMessage.text}</span>
          </div>
        )}
        <div class={`chat-view${preview ? ' chat-view-preview' : ''}`} ref={scrollRef} style={chatFontStyle} onScroll={preview ? undefined : handleScroll}
          onWheel={preview ? undefined : handleWheel}
          onTouchStart={preview ? undefined : handleTouchStart}
          onTouchMove={preview ? undefined : handleTouchMove}
          // Keyboard parity for the floating "↓" button: End force-engages
          // follow and jumps to bottom. tabIndex={-1} keeps it scriptable
          // without inserting it into the natural tab order.
          tabIndex={preview ? undefined : -1}
          onKeyDown={preview ? undefined : (e: KeyboardEvent) => {
            if (e.key === 'End') {
              e.preventDefault();
              scrollToBottom(true);
            }
          }}
          onContextMenu={!preview && !isTouchDevice ? handleContextMenu : undefined}
          onClick={(highlightEl || ctxMenu) ? () => {
            // Ignore synthetic click from long-press release (within 400ms of menu opening)
            if (Date.now() - menuOpenedAtRef.current < 400) return;
            if (highlightEl) { highlightEl.classList.remove('chat-highlight'); setHighlightEl(null); }
            setCtxMenu(null);
          } : undefined}
        >
          {!preview && <AgentTodoList events={events} sessionState={sessionState} />}
          {loading ? (
            <div class="chat-loading">{t('chat.loading')}</div>
          ) : viewItems.length === 0 ? (
            // Suppress the "no events" placeholder while history bootstrap
            // is in flight: SubSessionWindow forces `loading={false}` to
            // avoid flicker on minimize/restore, so when a freshly-opened
            // sub-session has no cached snapshot, this branch used to flash
            // "暂无消息" on top of the still-spinning 历史 → 本地缓存 → daemon
            // overlay. Defer the placeholder until the overlay has cleared.
            (historyStatus
              && historyStatus.phase === 'bootstrap'
              && (historyStatus.steps.cache === 'running' || historyStatus.steps.cache === 'pending'
                || historyStatus.steps.daemon === 'running' || historyStatus.steps.daemon === 'pending'
                || historyStatus.steps.http === 'running' || historyStatus.steps.http === 'pending'))
              ? null
              : (
                <div class="chat-loading">
                  {sessionState ? t('chat.session_state', { state: sessionState }) : t('chat.no_events')}
                </div>
              )
          ) : null}
          {/* First-time tool-call view chooser. Renders only when the user
           *  has never picked AND the current timeline has tool events to
           *  toggle. Picking either button writes the show_tool_calls
           *  preference and removes the banner from every subscribed view
           *  (same-tab fan-out via SharedResource). */}
          {showFirstTimeChooser && (
            <div
              class="chat-tool-chooser"
              role="region"
              aria-label={t('chat.tool_chooser_title')}
            >
              <div class="chat-tool-chooser-title">{t('chat.tool_chooser_title')}</div>
              <div class="chat-tool-chooser-subtitle">{t('chat.tool_chooser_subtitle')}</div>
              <div class="chat-tool-chooser-actions">
                <button
                  type="button"
                  class="chat-tool-chooser-btn chat-tool-chooser-btn-simple"
                  onClick={handleChooserPickSimple}
                >
                  <span class="chat-tool-chooser-btn-icon" aria-hidden="true">💬</span>
                  <span class="chat-tool-chooser-btn-label">{t('chat.tool_chooser_simple_label')}</span>
                  <span class="chat-tool-chooser-btn-hint">{t('chat.tool_chooser_simple_hint')}</span>
                </button>
                <button
                  type="button"
                  class="chat-tool-chooser-btn chat-tool-chooser-btn-developer"
                  onClick={handleChooserPickDeveloper}
                >
                  <span class="chat-tool-chooser-btn-icon" aria-hidden="true">🛠</span>
                  <span class="chat-tool-chooser-btn-label">{t('chat.tool_chooser_developer_label')}</span>
                  <span class="chat-tool-chooser-btn-hint">{t('chat.tool_chooser_developer_hint')}</span>
                </button>
              </div>
              <div class="chat-tool-chooser-footnote">{t('chat.tool_chooser_footnote')}</div>
            </div>
          )}
          {!loading && !preview && viewItems.length > 0 && (loadingOlder || revealingOlder) && (
            <div class="chat-load-older-status" role="status" aria-live="polite">
              <span class="chat-refreshing-spinner" aria-hidden="true" />
              <span>{t('chat.loading_older')}</span>
            </div>
          )}
          {!loading && !preview && viewItems.length > 0 && (hiddenRenderedItemCount > 0 || (!loadingOlder && onLoadOlder && hasOlderHistory)) && (
            <div style={{ textAlign: 'center', padding: '8px 0' }}>
              <button
                class="btn btn-sm"
                style={{ fontSize: 11, opacity: 0.7 }}
                onClick={() => {
                  const el = scrollRef.current;
                  if (hiddenRenderedItemCount > 0) {
                    revealHiddenOlderItems();
                  } else {
                    if (el) scrollAnchorRef.current = { scrollHeight: el.scrollHeight };
                    onLoadOlder?.();
                  }
                }}
              >
                {t('chat.load_older')}
              </button>
            </div>
          )}
          {!loading && renderedViewItems.map((item) => {
            if (item.type === 'assistant-block') {
              return (
                <AssistantBlock
                  key={item.key}
                  eventId={item.key}
                  text={item.text!}
                  automation={item.assistantAutomation === true}
                  ts={item.lastTs ?? item.ts ?? 0}
                  onPathClick={pathClickHandler}
                  onUrlClick={urlClickHandler}
                  onDownload={downloadHandler}
                  onHtmlPreview={htmlPreviewHandler}
                  onImagePreview={imagePreviewHandler}
                />
              );
            }
            if (item.type === 'tool-group') {
              return <ToolCallGroup key={item.key} events={item.toolEvents!} onPathClick={pathClickHandler} onUrlClick={urlClickHandler} onDownload={downloadHandler} onHtmlPreview={htmlPreviewHandler} onImagePreview={imagePreviewHandler} serverId={serverId} />;
            }
            const linkedEvents = item.linkedEvents ?? [];
            if (linkedEvents.length === 0) {
              return <ChatEvent key={item.key} event={item.event!} onPathClick={pathClickHandler} onUrlClick={urlClickHandler} onFileChangeOpen={fileChangeOpenHandler} onDownload={downloadHandler} onHtmlPreview={htmlPreviewHandler} onImagePreview={imagePreviewHandler} serverId={serverId} onResendFailed={onResendFailed} />;
            }
            return (
              <div key={item.key} class="chat-linked-event-group">
                <ChatEvent event={item.event!} onPathClick={pathClickHandler} onUrlClick={urlClickHandler} onFileChangeOpen={fileChangeOpenHandler} onDownload={downloadHandler} onHtmlPreview={htmlPreviewHandler} onImagePreview={imagePreviewHandler} serverId={serverId} onResendFailed={onResendFailed} />
                {linkedEvents.map((linkedEvent) => (
                  <ChatEvent
                    key={linkedEvent.eventId}
                    event={linkedEvent}
                    onPathClick={pathClickHandler}
                    onUrlClick={urlClickHandler}
                    onFileChangeOpen={fileChangeOpenHandler}
                    onDownload={downloadHandler}
                    onHtmlPreview={htmlPreviewHandler}
                    onImagePreview={imagePreviewHandler}
                    serverId={serverId}
                    onResendFailed={onResendFailed}
                  />
                ))}
              </div>
            );
          })}
          {!loading && <div ref={bottomRef} />}
        </div>
        {!preview && showScrollBtn && (
          <button
            class="chat-scroll-btn"
            onClick={() => {
              setShowScrollBtn(false);
              scrollToBottom(true);
            }}
            aria-label={
              newSinceUnfollow > 0
                ? `Jump to bottom (${newSinceUnfollow} new)`
                : 'Jump to bottom'
            }
          >
            ↓{newSinceUnfollow > 0 ? ` ${newSinceUnfollow}` : ''}
          </button>
        )}
        {selMenu && !preview && (
          <div
            ref={selMenuRef}
            class="chat-sel-menu"
            style={{ left: `${selMenu.x}px`, top: `${selMenu.y}px` }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <button
              class={`chat-sel-btn${copied ? ' copied' : ''}`}
              onClick={() => {
                navigator.clipboard.writeText(selMenu.text).then(() => {
                  setCopied(true);
                  setTimeout(() => {
                    setSelMenu(null);
                    setCopied(false);
                  }, 1000);
                });
              }}
            >
              {copied ? t('common.copied') : t('common.copy')}
            </button>
            {onQuote && (
              <button
                class="chat-sel-btn"
                onClick={() => {
                  onQuote(selMenu.text);
                  setSelMenu(null);
                  window.getSelection()?.removeAllRanges();
                }}
              >
                {t('common.quote', 'Quote')}
              </button>
            )}
          </div>
        )}
        {ctxMenu && !preview && (
          <div
            ref={ctxMenuRef}
            class="chat-sel-menu"
            style={{ left: `${ctxMenu.x}px`, top: `${ctxMenu.y}px` }}
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              class={`chat-sel-btn${copied ? ' copied' : ''}`}
              onClick={() => {
                navigator.clipboard.writeText(ctxMenu.text).then(() => {
                  setCopied(true);
                  setTimeout(() => { setCtxMenu(null); setCopied(false); if (highlightEl) { highlightEl.classList.remove('chat-highlight'); setHighlightEl(null); } }, 800);
                });
              }}
            >
              {copied ? t('common.copied') : t('common.copy')}
            </button>
            {onQuote && (
              <>
              <button
                class="chat-sel-btn"
                onClick={() => {
                  onQuote(ctxMenu.text);
                  setCtxMenu(null);
                  if (highlightEl) { highlightEl.classList.remove('chat-highlight'); setHighlightEl(null); }
                }}
              >
                {t('common.quote', 'Quote')}
              </button>
              <button
                class="chat-sel-btn"
                onClick={() => {
                  onQuote(ctxMenu.text);
                  setCtxMenu(null);
                  if (highlightEl) { highlightEl.classList.remove('chat-highlight'); setHighlightEl(null); }
                }}
              >
                {t('common.quote_block', 'Quote All')}
              </button>
              </>
            )}
            {ctxMenu.eventId && ws && sessionId && (
              <button
                class="chat-sel-btn"
                style={{ color: '#e5484d' }}
                onClick={() => {
                  const eid = ctxMenu.eventId;
                  if (!eid || !sessionId || !ws) return;
                  // Destructive + global → keep an explicit confirmation (no click-to-delete).
                  if (!window.confirm(t('chat.delete_message_confirm'))) return;
                  try {
                    ws.deleteTimelineMessage(sessionId, eid);
                  } catch (err) {
                    console.warn('delete timeline message failed', err);
                  }
                  setCtxMenu(null);
                  if (highlightEl) { highlightEl.classList.remove('chat-highlight'); setHighlightEl(null); }
                }}
              >
                {t('chat.delete_message')}
              </button>
            )}
          </div>
        )}
      </div>
      {showAgentsPane && (
        <SdkAgentsPanel
          rows={sdkAgentsStatus.rows}
          diagnostics={sdkAgentsStatus.diagnostics}
          runningCount={sdkAgentsStatus.runningCount}
          now={sdkAgentsNow}
          onClose={() => setDesiredAgentsPanelOpen(false)}
        />
      )}
      {canShowFilePanel && showFilePanel && ws && (
        <>
          <div class="chat-panel-drag" onMouseDown={onDragStart} />
          <div class="chat-file-panel" style={{ width: `${filePanelWidth}px`, flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px', background: '#1e293b', borderBottom: '1px solid #334155' }}>
              <span style={{ flex: 1, fontSize: 11, color: '#64748b' }}>{t('picker.files')}</span>
              <button onClick={() => { setShowFilePanel(false); try { localStorage.setItem(panelOpenKey(sessionId), '0'); } catch { /* ignore */ } }} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 14, padding: '2px 6px' }}>✕</button>
            </div>
            <FileBrowser
              ws={ws}
              serverId={serverId}
              sessionName={sessionId ?? undefined}
              mode="file-single"
              layout="panel"
              initialPath={workdir ?? '~'}
              hideFooter
              changesRootPath={workdir ?? undefined}
              refreshTrigger={filePanelRefreshTrigger}
              onConfirm={(paths) => {
                if (paths[0]) onInsertPath?.(paths[0]);
              }}
              onInsertPath={onInsertPath}
              onPreviewFile={onPreviewFile ? (request) => onPreviewFile({
                ...request,
                rootPath: request.rootPath ?? workdir ?? undefined,
                sourcePreviewLive: false,
              }) : undefined}
            />
          </div>
        </>
      )}
      {/* Zoomed text dialog — opened by double-tap on a chat bubble on touch
          devices, so the user can re-enable native text selection and copy a
          specific portion. */}
      {zoomText && (
        <ZoomedTextDialog text={zoomText} onClose={() => setZoomText(null)} onQuote={onQuote} />
      )}
      <HtmlFullscreenPreview preview={htmlFullscreenPreview} onClose={closeHtmlFullscreenPreview} />
      {/* External link confirm dialog */}
      {pendingUrl && (
        <div class="dialog-overlay external-link-overlay" onClick={() => setPendingUrl(null)}>
          <div
            class="external-link-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="external-link-dialog-title"
            onClick={(e: Event) => e.stopPropagation()}
          >
            <div class="external-link-heading">
              <span class="external-link-icon" aria-hidden="true">↗</span>
              <div class="external-link-title" id="external-link-dialog-title">{t('chat.external_link_title')}</div>
            </div>
            <div class="external-link-url" title={pendingUrl}>{pendingUrl}</div>
            <div class="external-link-warning">{t('chat.external_link_warning')}</div>
            <div class="external-link-actions">
              <button class="external-link-btn" onClick={() => setPendingUrl(null)}>{t('chat.external_link_cancel')}</button>
              <button class="external-link-btn external-link-btn-primary" onClick={() => {
                window.open(pendingUrl, '_blank', 'noopener,noreferrer');
                setPendingUrl(null);
              }}>{t('chat.external_link_open')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Unified tool block fold — collapses any tool content exceeding ~3 lines (54px). */
function ToolBlockFold({ children }: { children: preact.ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation();

  useEffect(() => {
    if (!ref.current) return;
    setOverflows(ref.current.scrollHeight > 60);
  }, [children]);

  return (
    <div class={`chat-tool-block-fold${!expanded && overflows ? ' collapsed' : ''}`}>
      <div ref={ref} class="chat-tool-block-fold-content" style={!expanded && overflows ? { maxHeight: 54, overflow: 'hidden' } : undefined}>
        {children}
      </div>
      {overflows && !expanded && (
        <button class="chat-tool-fold-btn" onClick={() => setExpanded(true)}>
          {'··· more'}
        </button>
      )}
      {overflows && expanded && (
        <button class="chat-tool-fold-btn" onClick={() => setExpanded(false)}>
          {t('chat.tool_fold_collapse')}
        </button>
      )}
    </div>
  );
}

/** Collapsible group of consecutive tool events. Shows first and last, folds middle. */
function ToolCallGroup({
  events,
  onPathClick,
  onUrlClick,
  onDownload,
  onHtmlPreview,
  onImagePreview,
  serverId,
}: {
  events: TimelineEvent[];
  onPathClick?: (p: string) => void;
  onUrlClick?: (url: string) => void;
  onDownload?: ChatPathDownloadHandler;
  onHtmlPreview?: (path: string) => void;
  onImagePreview?: ChatLocalImagePreviewLoader;
  serverId?: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const first = events[0];
  const last = events.length > 1 ? events[events.length - 1] : null;
  const middle = events.slice(1, last ? -1 : undefined);

  // Defensive: an empty consolidated group would crash ChatEvent on
  // `event.type` and take the whole session pane down with it.
  if (!first) return null;

  return (
    <div class="chat-tool-group">
      <ChatEvent event={first} onPathClick={onPathClick} onUrlClick={onUrlClick} onDownload={onDownload} onHtmlPreview={onHtmlPreview} onImagePreview={onImagePreview} serverId={serverId} />
      <div class="chat-tool-group-indent">
        {middle.length > 0 && (
          expanded ? (
            middle.map((ev) => <ChatEvent key={ev.eventId} event={ev} onPathClick={onPathClick} onUrlClick={onUrlClick} onDownload={onDownload} onHtmlPreview={onHtmlPreview} onImagePreview={onImagePreview} serverId={serverId} />)
          ) : (
            <button class="chat-tool-fold-btn" onClick={() => setExpanded(true)}>
              {t('chat.tool_group_more', { count: middle.length })}
            </button>
          )
        )}
        {last && <ChatEvent event={last} onPathClick={onPathClick} onUrlClick={onUrlClick} onDownload={onDownload} onHtmlPreview={onHtmlPreview} onImagePreview={onImagePreview} serverId={serverId} showTime />}
        {expanded && middle.length > 0 && (
          <button class="chat-tool-fold-btn" onClick={() => setExpanded(false)}>
            {t('chat.tool_group_collapse')}
          </button>
        )}
      </div>
    </div>
  );
}

// ToolInputFold removed — replaced by unified ToolBlockFold (CSS max-height based)

const AssistantBlock = memo(function AssistantBlock({
  text,
  automation,
  ts,
  eventId,
  onPathClick,
  onUrlClick,
  onDownload,
  onHtmlPreview,
  onImagePreview,
}: AssistantBlockProps) {
  return (
    <div
      class={`chat-event chat-assistant${automation ? ' chat-assistant-automation' : ''}`}
      data-event-id={eventId}
    >
      <ChatMarkdown text={text} onPathClick={onPathClick} onUrlClick={onUrlClick} onDownload={onDownload} onHtmlPreview={onHtmlPreview} onImagePreview={onImagePreview} />
      <ChatTime ts={ts} />
    </div>
  );
});

function AttachmentDownloadButton({
  att,
  serverId,
  onPathClick,
  onHtmlPreview,
}: {
  att: { id: string; originalName?: string; size?: number; daemonPath?: string };
  serverId: string;
  onPathClick?: (p: string) => void;
  onHtmlPreview?: (p: string) => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const label = att.originalName || att.id;
  const sizeLabel = att.size ? ` (${(att.size / 1024).toFixed(0)}KB)` : '';

  const handleError = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('daemon_offline') || msg.includes('503')) setError(t('upload.daemon_offline'));
    else if (msg.includes('410') || msg.includes('expired')) setError(t('upload.download_expired'));
    else if (msg.includes('404')) setError(t('upload.download_expired'));
    else setError(t('upload.upload_failed'));
    setTimeout(() => setError(null), 5000);
  };

  return (
    <span class="chat-attachment-row" style={error ? { color: '#ef4444' } : undefined}>
      <button
        class="chat-attachment-dl"
        onClick={() => {
          setError(null);
          // If file has a daemon path, open in file browser floating panel
          if (att.daemonPath && onPathClick) {
            onPathClick(att.daemonPath);
            return;
          }
          import('../api.js').then(({ previewAttachment }) => {
            previewAttachment(serverId, att.id).catch(handleError);
          });
        }}
        title={error || label}
      >
        {error ? `\u{26A0} ${error}` : `\u{1F4CE} ${label}${sizeLabel}`}
      </button>
      <button
        class="chat-attachment-dl-btn"
        onClick={() => {
          setError(null);
          import('../api.js').then(({ downloadAttachment }) => {
            downloadAttachment(serverId, att.id).catch(handleError);
          });
        }}
        title={t('upload.download_file')}
        aria-label={t('upload.download_file')}
      >
        ⬇
      </button>
      {att.daemonPath && onHtmlPreview && isHtmlPreviewPath(att.daemonPath) && (
        <button
          type="button"
          class="chat-attachment-dl-btn chat-html-preview-btn"
          onClick={() => {
            setError(null);
            onHtmlPreview(att.daemonPath!);
          }}
          title={t('chat.html_preview', 'Render HTML')}
          aria-label={t('chat.html_preview', 'Render HTML')}
        >
          👁
        </button>
      )}
    </span>
  );
}

const ChatEvent = memo(function ChatEvent({
  event,
  onPathClick,
  onUrlClick,
  onFileChangeOpen,
  onDownload,
  onHtmlPreview,
  onImagePreview,
  serverId,
  onResendFailed,
  showTime,
}: {
  event: TimelineEvent;
  onPathClick?: (p: string) => void;
  onUrlClick?: (url: string) => void;
  onFileChangeOpen?: (path: string, preferDiff?: boolean) => void;
  onDownload?: ChatPathDownloadHandler;
  onHtmlPreview?: (path: string) => void;
  onImagePreview?: ChatLocalImagePreviewLoader;
  serverId?: string;
  onResendFailed?: (commandId: string, text: string) => void;
  showTime?: boolean;
}) {
  const { t } = useTranslation();
  switch (event.type) {
    case 'user.message': {
      let userText = String(event.payload.text ?? '');
      const attachments = event.payload.attachments as Array<{ id: string; originalName?: string; mime?: string; size?: number; daemonPath?: string }> | undefined;
      // Strip @path references from text when they're shown as attachment badges
      if (attachments && attachments.length > 0) {
        for (const att of attachments) {
          if (att.daemonPath) userText = userText.split(`@${att.daemonPath}`).join('').trim();
        }
      }
      const isPending = !!event.payload.pending;
      const isFailed = !!event.payload.failed;
      const commandId = typeof event.payload.commandId === 'string' ? event.payload.commandId : undefined;
      const failureReason = typeof event.payload.failureReason === 'string' ? event.payload.failureReason : undefined;
      const stateClass = isPending ? ' chat-pending' : isFailed ? ' chat-failed' : '';
      const sharedActorLabel = formatSharedActorLabel(t, event.payload.sharedActor);
      return (
        // data-event-id lets the pinned-last-message banner target this bubble
        // with an IntersectionObserver so the banner only shows when the real
        // bubble has scrolled off the top of the viewport.
        <div class={`chat-event chat-user${stateClass}`} data-event-id={event.eventId}>
          {sharedActorLabel && (
            <div class="chat-shared-actor-label" title={sharedActorLabel}>
              {sharedActorLabel}
            </div>
          )}
          {attachments && serverId && attachments.map((att) => (
            <AttachmentDownloadButton key={att.id} att={att} serverId={serverId} onPathClick={onPathClick} onHtmlPreview={onHtmlPreview} />
          ))}
          {userText && (
            <UserMessageText
              text={userText}
              onPathClick={onPathClick}
              onUrlClick={onUrlClick}
              onDownload={onDownload}
              onHtmlPreview={onHtmlPreview}
              onImagePreview={onImagePreview}
            />
          )}
          {isPending && (
            <span
              class="chat-user-status chat-user-status-pending"
              aria-label={t('chat.sendingLabel', 'Sending')}
              title={t('chat.sendingLabel', 'Sending')}
            />
          )}
          {isFailed && (
            <div class="chat-user-status chat-user-status-failed">
              <span
                class="chat-user-status-icon"
                aria-label={t('chat.sendFailedLabel', 'Send failed')}
                title={failureReason ?? t('chat.sendFailedLabel', 'Send failed')}
              >!</span>
              {commandId && onResendFailed && (
                <button
                  type="button"
                  class="chat-user-retry-btn"
                  onClick={() => onResendFailed(commandId, String(event.payload.text ?? ''))}
                >
                  {t('chat.retrySend', 'Retry')}
                </button>
              )}
            </div>
          )}
          {!isPending && !isFailed && <ChatTime ts={event.ts} />}
        </div>
      );
    }

    case 'peer_audit.result': {
      const outcome = String(event.payload.outcome ?? 'target_unavailable');
      const outcomeKey = outcome === 'pass'
        ? 'result_pass'
        : outcome === 'rework'
          ? 'result_rework'
          : outcome === 'timeout'
            ? 'result_timeout'
            : outcome === 'cancelled'
              ? 'result_cancelled'
              : 'result_unavailable';
      const auditor = String(event.payload.auditorLabel ?? event.payload.auditorSessionName ?? '—');
      const elapsedMs = typeof event.payload.elapsedMs === 'number' ? event.payload.elapsedMs : 0;
      const findingsPreview = typeof event.payload.findingsPreview === 'string'
        ? event.payload.findingsPreview
        : '';
      const disposition = isPeerAuditRuntimeDisposition(event.payload.disposition)
        ? event.payload.disposition
        : null;
      return (
        <section class="chat-event chat-system peer-audit-result-card" data-event-id={event.eventId}>
          <strong>{t('peerAuditResult.title')}</strong>
          <div>{t('peerAuditResult.attributionAuditor', { auditor })}</div>
          <div>{t('peerAuditResult.elapsedMs', { seconds: Math.round(elapsedMs / 1000) })}</div>
          <div>{t(`peerAuditQuick.${outcomeKey}`)}</div>
          {disposition && (
            <div>{t(`peerAuditQuick.disposition.${disposition}`)}</div>
          )}
          {findingsPreview && (
            <details>
              <summary>{t('peerAuditResult.findingsPreview')}</summary>
              <ChatMarkdown text={findingsPreview} />
            </details>
          )}
          <ChatTime ts={event.ts} />
        </section>
      );
    }

    case 'peer_audit.status':
      return null;

    case 'tool.call': {
      const toolName = String(event.payload.tool ?? 'tool');
      const callDetail = event.payload._callDetail ?? event.payload.detail;
      const resultDetail = event.payload._resultDetail;
      const shouldShowTime = showTime || event.payload._merged === true;
      // Fall back to result detail for input — transport SDK tool.call may arrive without input
      const callInput = summarizeToolInput(event.payload.input, callDetail);
      const resultInput = summarizeToolInput((resultDetail as any)?.input, resultDetail);
      const toolInput = pickMergedToolInput(toolName, callInput, resultInput);
      const toolOutput = event.payload._output ? String(event.payload._output) : undefined;
      return (
        <ToolBlockFold>
          <div class="chat-event chat-tool">
            <span class="chat-tool-icon">{'>'}</span>
            <span class="chat-tool-name">{toolName}</span>
            {toolInput && <span class="chat-tool-input">{' '}{splitPathsAndUrls(toolInput, onPathClick, onUrlClick, onDownload, onHtmlPreview, onImagePreview, t('upload.download_file'), t('chat.html_preview', 'Render HTML'))}</span>}
            {shouldShowTime && <span class="chat-bubble-time" style={{ display: 'inline', margin: 0 }}>{formatChatDateTime(event.ts)}</span>}
          </div>
          {toolOutput && (
            <div class="chat-event chat-tool chat-tool-result-preview">
              <span class="chat-tool-output">{splitPathsAndUrls(toolOutput, onPathClick, onUrlClick, onDownload, onHtmlPreview, onImagePreview, t('upload.download_file'), t('chat.html_preview', 'Render HTML'))}</span>
            </div>
          )}
          <MergedToolDetailPanel toolName={toolName} callDetail={callDetail} resultDetail={resultDetail} />
        </ToolBlockFold>
      );
    }

    case 'tool.result': {
      // Standalone tool.result (not merged) — still rendered for cases without a preceding call
      const error = event.payload.error;
      const output = formatToolPayloadValue(event.payload.output);
      const detail = event.payload.detail;
      return (
        <ToolBlockFold>
          <div class="chat-event chat-tool">
            <span class="chat-tool-icon">{'<'}</span>
            {error ? (
            <span class="chat-tool-error">{`error: ${String(error)}`}</span>
          ) : output ? (
              <span class="chat-tool-output">{splitPathsAndUrls(output, onPathClick, onUrlClick, onDownload, onHtmlPreview, onImagePreview, t('upload.download_file'), t('chat.html_preview', 'Render HTML'))}</span>
            ) : (
              <span class="chat-tool-output">done</span>
            )}
            {showTime && <span class="chat-bubble-time" style={{ display: 'inline', margin: 0 }}>{formatChatDateTime(event.ts)}</span>}
          </div>
          <ToolResultDetailPanel detail={detail} />
        </ToolBlockFold>
      );
    }

    case 'mode.state':
      return (
        <div class="chat-event">
          <span class="chat-mode">{String(event.payload.mode ?? event.payload.state ?? '')}</span>
        </div>
      );

    case 'session.state': {
      const state = String(event.payload.state ?? '');
      const errorDetail = getSessionStateDetail(event);
      const liveStatus = deriveSessionLiveStatus({
        sessionState: state,
        sessionStateReason: typeof event.payload.reason === 'string' ? event.payload.reason : null,
        sessionStateError: errorDetail,
      });
      const stateLabel: Record<string, string> = {
        idle: t('session.state_idle'),
        running: t('session.state_running'),
        started: t('session.state_started'),
        starting: t('session.state_starting'),
        compacting: t('session.state_compacting'),
        stopping: t('session.state_stopping'),
        stopped: t('session.state_stopped'),
      };
      const label = liveStatus.controlFeedback === 'stop_requested'
        ? t('session.state_stop_requested')
        : liveStatus.controlFeedback === 'compact_requested'
          ? t('session.state_compacting')
          : (stateLabel[state] ?? state);
      const displayLabel = (liveStatus.mode === 'error' || liveStatus.mode === 'cancelled') && liveStatus.errorDetail
        ? t('session.state_error_detail', {
            error: liveStatus.errorDetail,
            defaultValue: 'Error: {{error}}',
          })
        : label;
      const inline = state === 'idle' || state === 'running';
      return (
        <div class="chat-event chat-system" style={inline ? { display: 'flex', alignItems: 'center', gap: 8 } : undefined}>
          <span>{displayLabel}</span>
          {inline
            ? <span class="chat-bubble-time" style={{ display: 'inline', margin: 0 }}>{formatChatDateTime(event.ts)}</span>
            : <ChatTime ts={event.ts} />}
        </div>
      );
    }

    case 'assistant.thinking':
      // Per user preference: thinking events are hidden entirely from the
      // timeline (both the live "thinking…" indicator and the finished
      // "Thought for Xs" summary). The agent's running state and the memory
      // context card already give enough signal that work is happening.
      return null;

    case 'memory.context':
      return <MemoryContextEvent event={event} />;

    case 'terminal.snapshot':
      return <SnapshotEvent event={event} />;

    case 'file.change':
      return <FileChangeCard event={event} onOpenFile={onFileChangeOpen} />;

    default:
      return null;
  }
});

function groupFileChangePatches(batch: FileChangeBatch): GroupedFileChange[] {
  const groups = new Map<string, GroupedFileChange>();
  const order: string[] = [];
  for (const patch of batch.patches ?? []) {
    if (!patch?.filePath) continue;
    let group = groups.get(patch.filePath);
    if (!group) {
      group = { filePath: patch.filePath, patches: [] };
      groups.set(patch.filePath, group);
      order.push(patch.filePath);
    }
    group.patches.push(patch);
  }
  return order.map((filePath) => groups.get(filePath)!).filter(Boolean);
}

function fileChangeOperationKey(operation: string): string {
  switch (operation) {
    case 'create': return 'chat.file_change_operation_create';
    case 'update': return 'chat.file_change_operation_update';
    case 'delete': return 'chat.file_change_operation_delete';
    case 'rename': return 'chat.file_change_operation_rename';
    default: return 'chat.file_change_operation_unknown';
  }
}

function fileChangeConfidenceKey(confidence: string): string {
  switch (confidence) {
    case 'exact': return 'chat.file_change_confidence_exact';
    case 'derived': return 'chat.file_change_confidence_derived';
    default: return 'chat.file_change_confidence_coarse';
  }
}

type FileChangePreviewLine = { text: string; lineNumber?: number };

function extractStackedPreviewFromUnifiedDiff(
  diff: string,
): { before: FileChangePreviewLine[]; after: FileChangePreviewLine[] } | null {
  const beforeLines: FileChangePreviewLine[] = [];
  const afterLines: FileChangePreviewLine[] = [];
  for (const line of parseUnifiedDiff(diff)) {
    if (line.kind === 'del') {
      beforeLines.push({ text: line.text, lineNumber: line.oldLineNumber });
      continue;
    }
    if (line.kind === 'add') {
      afterLines.push({ text: line.text, lineNumber: line.newLineNumber });
    }
  }
  if (beforeLines.length === 0 && afterLines.length === 0) return null;
  return { before: beforeLines, after: afterLines };
}

function buildPlainPreviewLines(text: string): FileChangePreviewLine[] {
  if (!text) return [];
  return text.replace(/\r\n/g, '\n').split('\n').map((line) => ({ text: line }));
}

function FileChangePreviewBlock({
  marker,
  markerTitle,
  lines,
  emptyText,
  className,
}: {
  marker: string;
  markerTitle: string;
  lines: FileChangePreviewLine[];
  emptyText: string;
  className: string;
}) {
  const visibleLines = lines.length > 0 ? lines : [{ text: emptyText }];
  const preClass = className.includes('added') ? 'chat-file-change-diff-pre-added' : 'chat-file-change-diff-pre-removed';
  return (
    <div class="chat-file-change-diff-block">
      {/* Kept for screen readers — hidden visually via CSS since each row now
          prefixes its own +/- sign. */}
      <div class={className} title={markerTitle} aria-label={markerTitle}>{marker}</div>
      <div class={`chat-file-change-diff-pre ${preClass}`}>
        {visibleLines.map((line, index) => (
          <div class="chat-file-change-diff-row" key={`${marker}:${line.lineNumber ?? 'na'}:${index}`}>
            <span class="chat-file-change-diff-sign" aria-hidden="true">{marker}</span>
            <span class="chat-file-change-diff-ln">{line.lineNumber ?? ''}</span>
            <span class="chat-file-change-diff-code">{line.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const FileChangeCard = memo(function FileChangeCard({
  event,
  onOpenFile,
}: {
  event: TimelineEvent;
  onOpenFile?: (path: string, preferDiff?: boolean) => void;
}) {
  const { t } = useTranslation();
  const batch = getFileChangeBatch(event);
  if (!batch) return null;
  const fileGroups = groupFileChangePatches(batch);
  if (fileGroups.length === 0) return null;

  return (
    <div class="chat-event chat-file-change">
      <div class="chat-file-change-header">
        <div class="chat-file-change-title">
          {t('chat.file_change_title', { count: fileGroups.length })}
        </div>
        <div class="chat-file-change-meta">
          {batch.title && <span class="chat-file-change-chip chat-file-change-chip-muted">{batch.title}</span>}
        </div>
      </div>
      <div class="chat-file-change-body">
        {fileGroups.map((group) => {
          const operations = Array.from(new Set(group.patches.map((patch) => patch.operation)));
          const confidences = Array.from(new Set(group.patches.map((patch) => patch.confidence)));
          const first = group.patches[0];
          const hasExactPreview = group.patches.some((patch) => patch.confidence === 'exact' && (patch.beforeText || patch.afterText || patch.unifiedDiff));
          const fileLabel = first?.oldPath && first.oldPath !== group.filePath
            ? `${first.oldPath} → ${group.filePath}`
            : group.filePath;
          return (
            <div class="chat-file-change-file" key={group.filePath}>
              <div
                class="chat-file-change-path"
                role="button"
                tabIndex={0}
                onClick={() => onOpenFile?.(group.filePath, hasExactPreview)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') onOpenFile?.(group.filePath, hasExactPreview);
                }}
                title={group.filePath}
              >
                {fileLabel}
              </div>
              <div class="chat-file-change-badges">
                <span class="chat-file-change-chip">{operations.length === 1 ? t(fileChangeOperationKey(operations[0])) : t('chat.file_change_operation_mixed')}</span>
                <span class="chat-file-change-chip chat-file-change-chip-muted">{confidences.length === 1 ? t(fileChangeConfidenceKey(confidences[0])) : t('chat.file_change_confidence_mixed')}</span>
                <span class="chat-file-change-chip chat-file-change-chip-muted">{t('chat.file_change_patch_count', { count: group.patches.length })}</span>
              </div>
              <div class="chat-file-change-patches">
                {group.patches.map((patch, idx) => (
                  <div class="chat-file-change-patch" key={`${group.filePath}:${idx}`}>
                    {patch.confidence === 'exact' ? (
                      <ExactFilePatch patch={patch} />
                    ) : patch.confidence === 'derived' ? (
                      <DerivedFilePatch patch={patch} />
                    ) : (
                      <CoarseFilePatch patch={patch} />
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});

function ExactFilePatch({ patch }: { patch: FileChangePatch }) {
  const { t } = useTranslation();
  const unifiedPreview = patch.unifiedDiff ? extractStackedPreviewFromUnifiedDiff(patch.unifiedDiff) : null;
  const beforeLines = unifiedPreview?.before ?? buildPlainPreviewLines(patch.beforeText ?? '');
  const afterLines = unifiedPreview?.after ?? buildPlainPreviewLines(patch.afterText ?? '');
  const showRemoved = patch.operation !== 'create' || beforeLines.length > 0;
  const showAdded = patch.operation !== 'delete' || afterLines.length > 0;
  return (
    <div class="chat-file-change-diff">
      {showRemoved && (
        <FileChangePreviewBlock
          marker="-"
          markerTitle={t('chat.file_change_removed')}
          lines={beforeLines}
          emptyText={t('chat.file_change_no_before')}
          className="chat-file-change-diff-label chat-file-change-diff-label-removed"
        />
      )}
      {showAdded && (
        <FileChangePreviewBlock
          marker="+"
          markerTitle={t('chat.file_change_added')}
          lines={afterLines}
          emptyText={t('chat.file_change_no_after')}
          className="chat-file-change-diff-label chat-file-change-diff-label-added"
        />
      )}
    </div>
  );
}

function DerivedFilePatch({ patch }: { patch: FileChangePatch }) {
  const { t } = useTranslation();
  const preview = patch.afterText ?? patch.beforeText ?? patch.unifiedDiff ?? t('chat.file_change_derived_no_preview');
  return (
    <div class="chat-file-change-diff">
      <div class="chat-file-change-diff-label">{t('chat.file_change_confidence_derived')}</div>
      <pre class="chat-file-change-diff-pre">{preview}</pre>
    </div>
  );
}

function CoarseFilePatch({ patch }: { patch: FileChangePatch }) {
  const { t } = useTranslation();
  return (
    <div class="chat-file-change-diff chat-file-change-diff-coarse">
      <div class="chat-file-change-diff-label">{t('chat.file_change_confidence_coarse')}</div>
      <div class="chat-file-change-coarse-text">
        {patch.oldPath && patch.oldPath !== patch.filePath
          ? t('chat.file_change_renamed_from', { oldPath: patch.oldPath, newPath: patch.filePath })
          : t('chat.file_change_coarse_hint')}
      </div>
    </div>
  );
}

const MemoryContextEvent = memo(function MemoryContextEvent({ event }: { event: TimelineEvent }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const payload = event.payload as unknown as MemoryContextTimelinePayload;
  const items = Array.isArray(payload.items) ? payload.items as MemoryContextTimelineItem[] : [];
  const preferenceItems = normalizeMemoryContextPreferenceItems(payload);
  const sections = getMemoryContextSections(items, preferenceItems);
  const query = typeof payload.query === 'string' ? payload.query : '';
  const reason = payload.reason ?? 'message';
  const contextItemCount = items.length + preferenceItems.length;
  const statusSummary = getMemoryContextStatusSummary(t, payload, contextItemCount);
  const statusDetail = getMemoryContextStatusDetail(t, payload);
  const isStatusOnly = contextItemCount === 0 && !!payload.status;
  // The startup-memory dump and the per-message recall both render as
  // memory-context cards, but they're conceptually different things:
  //   - startup: a one-shot "pre-loaded project history" preamble
  //   - message: memories related to the current prompt
  // Using a different title for startup makes the distinction legible
  // at a glance and stops users from reading a restored-session card as a
  // fresh recall (see the daemon-restart dedup fix that pairs with this).
  const titleKey = reason === 'startup'
    ? 'chat.memory_context_startup_title'
    : 'chat.memory_context_title';

  if (isStatusOnly) {
    // Skipped/empty recall cards were showing title + summary + query + detail
    // stacked at once. The query is just the prompt the user already sees one
    // bubble above — redundant noise. Collapse to a single-line summary with
    // a caret to expand when the user actually wants the detail.
    const hasDetail = !!statusDetail;
    return (
      <div class="chat-event chat-memory-context chat-memory-context-status" data-related-to={String(payload.relatedToEventId ?? '')}>
        {hasDetail ? (
          <button
            type="button"
            class="chat-memory-context-toggle chat-memory-context-status-toggle"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
          >
            <span class="chat-memory-context-status-title">{t(titleKey)}</span>
            <span class="chat-memory-context-status-summary">{statusSummary}</span>
            <span class="chat-memory-context-caret">{expanded ? '▲' : '▼'}</span>
          </button>
        ) : (
          <div class="chat-memory-context-status-row">
            <span class="chat-memory-context-status-title">{t(titleKey)}</span>
            <span class="chat-memory-context-status-summary">{statusSummary}</span>
          </div>
        )}
        {expanded && hasDetail && (
          <div class="chat-memory-context-status-detail">{statusDetail}</div>
        )}
      </div>
    );
  }

  return (
    <div class="chat-event chat-memory-context" data-related-to={String(payload.relatedToEventId ?? '')}>
      <button class="chat-memory-context-toggle" onClick={() => setExpanded((value) => !value)}>
        <span class="chat-memory-context-title">{t(titleKey)}</span>
        <span class="chat-memory-context-summary">{statusSummary}</span>
        <span class="chat-memory-context-caret">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div class="chat-memory-context-body">
          {reason === 'startup' ? (
            <div class="chat-memory-context-query">{t('chat.memory_context_startup_reason')}</div>
          ) : null}
          {query && (
            <div class="chat-memory-context-query">{t('chat.memory_context_query', { query })}</div>
          )}
          <div class="chat-memory-context-list">
            {sections.map((section) => (
              <div key={section.key} class="chat-memory-context-section">
                <div class="chat-memory-context-section-title">
                  {t(section.titleKey, {
                    count: section.preferenceItems ? section.preferenceItems.length : section.items.length,
                  })}
                </div>
                {section.preferenceItems ? section.preferenceItems.map((item) => (
                  <div key={item.id} class="chat-memory-context-item chat-memory-context-preference-item">
                    <div class="chat-memory-context-item-summary">{item.text}</div>
                  </div>
                )) : section.items.map((item) => {
                  const score = formatMemoryContextScore(item.relevanceScore);
                  const recalledAt = formatMemoryContextTimestamp(item.lastUsedAt);
                  return (
                    <div key={item.id} class="chat-memory-context-item">
                      <div class="chat-memory-context-item-summary">{item.summary}</div>
                      <div class="chat-memory-context-item-meta">
                        <span class="chat-memory-context-chip">{item.projectId}</span>
                        {score && <span class="chat-memory-context-chip">{t('chat.memory_context_score', { score })}</span>}
                        {typeof item.hitCount === 'number' && item.hitCount > 0 ? (
                          <span class="chat-memory-context-chip">{t('sharedContext.management.memoryRecalls', { count: item.hitCount })}</span>
                        ) : null}
                        <span class="chat-memory-context-chip chat-memory-context-chip-muted">
                          {recalledAt
                            ? t('sharedContext.management.memoryLastRecalled', { time: recalledAt })
                            : t('sharedContext.management.memoryNeverRecalled')}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <button class="chat-memory-context-collapse-bottom" onClick={() => setExpanded(false)}>
            {t('chat.memory_context_collapse_bottom')}
          </button>
        </div>
      )}
    </div>
  );
});

function SnapshotEvent({ event }: { event: TimelineEvent }) {
  const [expanded, setExpanded] = useState(false);
  const lines = (event.payload.lines as string[] | undefined) ?? [];

  return (
    <div class="chat-event chat-system">
      <button
        class="chat-snapshot-toggle"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? '[-] Terminal snapshot' : '[+] Terminal snapshot'}
      </button>
      {expanded && (
        <pre class="chat-snapshot-content">
          {lines.join('\n')}
        </pre>
      )}
    </div>
  );
}

function countHardLines(text: string): number {
  if (!text) return 0;
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').length;
}

function UserMessageText({
  text,
  onPathClick,
  onUrlClick,
  onDownload,
  onHtmlPreview,
  onImagePreview,
}: {
  text: string;
  onPathClick?: (p: string) => void;
  onUrlClick?: (url: string) => void;
  onDownload?: ChatPathDownloadHandler;
  onHtmlPreview?: (path: string) => void;
  onImagePreview?: ChatLocalImagePreviewLoader;
}) {
  const { t } = useTranslation();
  const lineCount = countHardLines(text);
  const shouldFold = lineCount > USER_MESSAGE_COLLAPSE_LINE_LIMIT;
  const [expanded, setExpanded] = useState(false);
  const folded = shouldFold && !expanded;

  return (
    <div class={`chat-user-message-fold${shouldFold ? ' is-foldable' : ''}${folded ? ' is-folded' : ''}`}>
      <div class={`chat-bubble-content chat-user-message-fold-content${folded ? ' is-folded' : ''}`}>
        {splitPathsAndUrls(text, onPathClick, onUrlClick, onDownload, onHtmlPreview, onImagePreview, t('upload.download_file'), t('chat.html_preview', 'Render HTML'))}
      </div>
      {shouldFold && (
        <button
          type="button"
          class="chat-user-message-fold-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t('chat.user_message_collapse') : t('chat.user_message_expand')}
        </button>
      )}
    </div>
  );
}

const ChatTime = memo(function ChatTime({ ts }: { ts: number }) {
  return (
    <div class="chat-bubble-time">
      {formatChatDateTime(ts)}
    </div>
  );
});

// ── Markdown rendering delegated to ChatMarkdown.tsx ──────────────────────

// ── URL detection (must run BEFORE path detection) ────────────────────────
// Matches absolute paths (/foo/bar) and relative paths (docs/file.md, src/components/Foo.tsx).
const PATH_REGEX = /(\\\\[\w.$ -]+\\[\w.$ \\-]+|[A-Za-z]:\\(?:[\w.$ -]+\\)*[\w.$ -]+|\.{1,2}\/[\w\p{L}.\-~/]+|\/[\w\p{L}.\-~][\w\p{L}.\-~/]*|(?<![:/\w\p{L}])[a-zA-Z_~][\w\p{L}.\-~]*(?:\/[\w\p{L}.\-~]+)+)/gu;

/** Split a plain-text segment into URL tokens, path tokens, and plain text. */
function splitPathsAndUrls(
  text: string,
  onPathClick?: (p: string) => void,
  onUrlClick?: (url: string) => void,
  onDownload?: ChatPathDownloadHandler,
  onHtmlPreview?: (path: string) => void,
  onImagePreview?: ChatLocalImagePreviewLoader,
  downloadLabel = '',
  htmlPreviewLabel = '',
): h.JSX.Element[] {
  if (!onPathClick && !onUrlClick && !onDownload && !onHtmlPreview && !onImagePreview) return [<span>{text}</span>];
  if (shouldSkipRichTextEnhancement(text)) return [<span>{text}</span>];

  // Step 1: Split by URLs first (URLs take priority over path detection)
  const parts: preact.JSX.Element[] = [];
  const chunks = splitTextByHttpUrls(text);

  // Step 2: For text chunks, apply path detection. URL chunks render as links.
  for (const chunk of chunks) {
    if (chunk.type === 'url') {
      parts.push(
        <a
          key={`u${chunk.start}`}
          class="chat-external-link"
          href={chunk.value}
          title={chunk.value}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e: Event) => {
            if (!onUrlClick) return;
            e.preventDefault();
            onUrlClick(chunk.value);
          }}
        >
          {chunk.value}
        </a>,
      );
    } else if (onPathClick || onImagePreview) {
      // Apply path detection only on non-URL text
      let pathLast = 0;
      PATH_REGEX.lastIndex = 0;
      let pm: RegExpExecArray | null;
      while ((pm = PATH_REGEX.exec(chunk.value)) !== null) {
        const path = pm[1];
        if (path.length < 3) continue;
        if (isLikelyDomainPath(path)) continue;
        if (pm.index > pathLast) parts.push(<span key={`t${chunk.start + pathLast}`}>{chunk.value.slice(pathLast, pm.index)}</span>);
        parts.push(renderChatPathActions({
          key: `p${chunk.start + pm.index}`,
          path,
          labels: { download: downloadLabel, htmlPreview: htmlPreviewLabel },
          handlers: { onPathClick, onDownload, onHtmlPreview, onImagePreview },
        }));
        pathLast = pm.index + pm[0].length;
      }
      if (pathLast < chunk.value.length) parts.push(<span key={`t${chunk.start + pathLast}`}>{chunk.value.slice(pathLast)}</span>);
    } else {
      parts.push(<span key={`t${chunk.start}`}>{chunk.value}</span>);
    }
  }

  return parts.length ? parts : [<span>{text}</span>];
}
