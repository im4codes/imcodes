import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { GlobalTaskSummaryRow } from '@shared/global-task-mode.js';
import {
  brainKey,
  computeDefaultMutedServerIds,
  globalTaskModeStore,
  resolveQuickDispatchBrains,
  sortGlobalTaskServers,
  taskKey,
  type GlobalTaskModeState,
  type GlobalTaskQuickDispatchBrain,
} from '../global-task-mode-store.js';
import { formatTaskPairTtsAnnouncement } from '../task-pair-tts.js';
import {
  getTtsAutoReadEnabled,
  getTtsState,
  isTtsSupported,
  prepareTextForTts,
  setTtsAutoReadEnabled,
  speakText,
  stopSpeaking,
  subscribeTtsPreferences,
  subscribeTtsState,
  type TtsPlaybackState,
} from '../tts.js';
import { TtsQuickSettingsPopover } from './TtsQuickSettingsPopover.js';
import { VoiceOverlay } from './VoiceOverlay.js';
import { useNowTicker } from '../hooks/useNowTicker.js';
import { formatTaskDuration } from '../util/tool-duration.js';

export type GlobalTaskStatusFilter = 'all' | 'attention' | 'working' | 'audit' | 'done';

export interface GlobalTaskModeViewProps {
  onExit: () => void;
  onJumpToSession: (serverId: string, sessionName: string) => void;
  pinnedServerIds?: ReadonlySet<string>;
  pinnedSessionNames?: ReadonlySet<string>;
  serverOrder?: readonly string[];
  tabOrder?: readonly string[];
}

interface TaskModeTargetSnapshot {
  serverId: string;
  serverName: string;
  sessionName: string;
  label: string;
  projectName: string;
  taskTitle?: string;
  mode: 'reply' | 'dispatch';
  initialText?: string;
}

interface PressTracker {
  key: string;
  pointerId: number;
  startX: number;
  startY: number;
  moved: boolean;
  firedLongPress: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  cleanup?: () => void;
}

const LONG_PRESS_MS = 260;
const MOVE_CANCEL_PX = 12;

export const GLOBAL_TASK_TTS_MAX_AGE_MS = 2 * 60 * 1000;
export const GLOBAL_TASK_TTS_CLOCK_SKEW_MS = 30 * 1000;
export const GLOBAL_TASK_TTS_QUEUE_CAP = 64;

export interface QueuedTaskModeTtsItem {
  text: string;
  messageId: string;
  lang: string;
  eventTs: number;
  arrivalSeq: number;
}

export function compareTaskModeTtsItems(a: QueuedTaskModeTtsItem, b: QueuedTaskModeTtsItem): number {
  if (a.eventTs !== b.eventTs) return a.eventTs - b.eventTs;
  return a.arrivalSeq - b.arrivalSeq;
}

export function enqueueChronologicalTtsItems(
  queue: QueuedTaskModeTtsItem[],
  items: readonly QueuedTaskModeTtsItem[],
  cap: number = GLOBAL_TASK_TTS_QUEUE_CAP,
): void {
  if (items.length === 0) return;
  queue.push(...items);
  queue.sort(compareTaskModeTtsItems);
  if (queue.length > cap) {
    queue.splice(0, queue.length - cap);
  }
}

export function shouldAutoSpeakTaskUpdate(input: {
  row: GlobalTaskSummaryRow;
  prev: GlobalTaskSummaryRow | undefined;
  now: number;
  mountAt: number;
}): boolean {
  const { row, prev, now, mountAt } = input;
  const updatedAt = row.updatedAt;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt <= 0) {
    return false;
  }
  if (now - updatedAt > GLOBAL_TASK_TTS_MAX_AGE_MS) {
    return false;
  }
  if (!prev) {
    return updatedAt >= mountAt - GLOBAL_TASK_TTS_CLOCK_SKEW_MS;
  }
  if (updatedAt < (prev.updatedAt || 0)) {
    return false;
  }
  const prevFlags = new Set(prev.flags ?? []);
  const newBlocked = row.flags.includes('blocked') && !prevFlags.has('blocked');
  const newNeedsInput = row.flags.includes('needs_input') && !prevFlags.has('needs_input');
  const statusChanged = prev.status !== row.status || (row.status === 'rework' && row.round !== prev.round);
  return statusChanged || newBlocked || newNeedsInput;
}

export function shouldAutoSpeakBrainText(input: {
  eventTs: number;
  now: number;
  mountAt: number;
}): boolean {
  const { eventTs, now, mountAt } = input;
  if (typeof eventTs !== 'number' || !Number.isFinite(eventTs) || eventTs <= 0) {
    return false;
  }
  if (now - eventTs > GLOBAL_TASK_TTS_MAX_AGE_MS) {
    return false;
  }
  return eventTs >= mountAt - GLOBAL_TASK_TTS_CLOCK_SKEW_MS;
}

export function TaskModeGlyphIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      class={className}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="7" height="7" rx="1.5" />
      <rect x="14" y="4" width="7" height="7" rx="1.5" />
      <rect x="3" y="13" width="7" height="7" rx="1.5" />
      <path d="M14 15h7" />
      <path d="M14 19h5" />
    </svg>
  );
}

function ReplyGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="9 14 4 9 9 4" />
      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
    </svg>
  );
}

function MicGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function SpeakerGlyph({ active, size = 13 }: { active?: boolean; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      {active ? (
        <>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </>
      ) : (
        <>
          <line x1="22" y1="9" x2="16" y2="15" />
          <line x1="16" y1="9" x2="22" y2="15" />
        </>
      )}
    </svg>
  );
}

function matchesTaskFilter(task: GlobalTaskSummaryRow, filter: GlobalTaskStatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'done') return task.isTerminal;
  if (task.isTerminal) return false;
  if (filter === 'attention') {
    return task.needsAttention || task.status === 'awaiting_brain_decision';
  }
  if (filter === 'audit') {
    return task.status === 'in_audit' || task.status === 'awaiting_audit' || task.status === 'passed';
  }
  // 'working': active non-audit non-attention execution states
  return !task.needsAttention
    && task.status !== 'awaiting_brain_decision'
    && task.status !== 'in_audit'
    && task.status !== 'awaiting_audit'
    && task.status !== 'passed';
}

function resolveStatusTone(task: GlobalTaskSummaryRow): string {
  if (task.isTerminal) return 'terminal';
  if (task.needsAttention || task.status === 'awaiting_brain_decision' || task.status === 'rework') {
    return 'attention';
  }
  if (task.status === 'in_audit' || task.status === 'awaiting_audit' || task.status === 'passed') {
    return 'audit';
  }
  if (task.status === 'queued' || task.status === 'paused') {
    return 'queued';
  }
  return 'working';
}

function formatUpdatedRelative(ts: number, locale: string): string {
  if (!ts || !Number.isFinite(ts)) return '';
  try {
    return new Date(ts).toLocaleTimeString(locale || undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function StatusFilterIcon({ filter }: { filter: GlobalTaskStatusFilter }) {
  switch (filter) {
    case 'attention':
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      );
    case 'working':
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      );
    case 'audit':
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case 'done':
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case 'all':
    default:
      return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polygon points="12 2 2 7 12 12 22 7 12 2" />
          <polyline points="2 12 12 17 22 12" />
          <polyline points="2 17 12 22 22 17" />
        </svg>
      );
  }
}

export function GlobalTaskModeView({
  onExit,
  onJumpToSession,
  pinnedServerIds,
  pinnedSessionNames,
  serverOrder,
  tabOrder,
}: GlobalTaskModeViewProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n?.resolvedLanguage || i18n?.language || (typeof document !== 'undefined' ? document.documentElement?.lang : '') || 'en';

  const [state, setState] = useState<GlobalTaskModeState>(() => globalTaskModeStore.getState());
  const [statusFilter, setStatusFilter] = useState<GlobalTaskStatusFilter>('all');
  const [finishedExpanded, setFinishedExpanded] = useState(true);
  const [expandedTaskKeys, setExpandedTaskKeys] = useState<Set<string>>(() => new Set());
  const [serverMenuOpen, setServerMenuOpen] = useState(false);

  const [ttsAutoRead, setTtsAutoRead] = useState<boolean>(() => getTtsAutoReadEnabled());
  const [ttsState, setTtsState] = useState<TtsPlaybackState>(() => getTtsState());
  const [ttsSettingsOpen, setTtsSettingsOpen] = useState(false);
  const ttsControlRef = useRef<HTMLDivElement>(null);
  const serverFilterRef = useRef<HTMLDivElement>(null);
  const serverFilterBtnRef = useRef<HTMLButtonElement>(null);
  const [serverMenuTop, setServerMenuTop] = useState<number | null>(null);

  const [composerTarget, setComposerTarget] = useState<TaskModeTargetSnapshot | null>(null);
  const [composerDraft, setComposerDraft] = useState('');
  const [composerSending, setComposerSending] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);

  const [voiceTarget, setVoiceTarget] = useState<TaskModeTargetSnapshot | null>(null);

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addServerId, setAddServerId] = useState('');
  const [addSessionName, setAddSessionName] = useState('');
  const [addMessage, setAddMessage] = useState('');
  const [addSending, setAddSending] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Refs for TTS lifecycle & press gestures
  const ttsAutoReadRef = useRef(ttsAutoRead);
  ttsAutoReadRef.current = ttsAutoRead;
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const translateRef = useRef(t);
  translateRef.current = t;
  const taskModeSpokenIdsRef = useRef<Set<string>>(new Set());
  const seenTtsKeysRef = useRef<Set<string>>(new Set());
  const pendingTtsQueueRef = useRef<QueuedTaskModeTtsItem[]>([]);
  const ttsArrivalSeqRef = useRef<number>(0);
  const mountedRef = useRef<boolean>(false);
  const inSyncTtsDispatchRef = useRef<boolean>(false);
  const drainScheduledRef = useRef<boolean>(false);
  const mountAtRef = useRef<number>(Date.now());
  const entrySnapshotSeqRef = useRef<number>(globalTaskModeStore.getState().snapshotSeq);
  const lastSnapshotSeqRef = useRef<number>(globalTaskModeStore.getState().snapshotSeq);
  const seededLifecycleRef = useRef<boolean>(false);
  const prevMutedSetRef = useRef<Set<string>>(new Set(globalTaskModeStore.getState().mutedServerIds));
  const pendingUnmuteServersRef = useRef<Set<string>>(new Set());
  const prevTasksRef = useRef<Map<string, GlobalTaskSummaryRow>>(new Map());
  const pressTrackersRef = useRef<Map<string, PressTracker>>(new Map());
  const suppressClickKeysRef = useRef<Set<string>>(new Set());

  const handleCloseTtsSettings = useCallback(() => setTtsSettingsOpen(false), []);

  // Store & TTS subscriptions + single-connection lifecycle
  useEffect(() => {
    const initial = globalTaskModeStore.getState();
    mountedRef.current = true;
    mountAtRef.current = Date.now();
    entrySnapshotSeqRef.current = initial.snapshotSeq;
    lastSnapshotSeqRef.current = initial.snapshotSeq;
    seededLifecycleRef.current = false;
    prevMutedSetRef.current = new Set(initial.mutedServerIds);
    pendingUnmuteServersRef.current.clear();
    pendingTtsQueueRef.current = [];
    prevTasksRef.current = new Map(initial.tasks.map((row) => [taskKey(row.serverId, row.taskId), row]));

    const drainPendingTts = () => {
      if (!mountedRef.current || !ttsAutoReadRef.current || !isTtsSupported()) return;
      if (inSyncTtsDispatchRef.current) return;

      while (
        pendingTtsQueueRef.current.length > 0
        && mountedRef.current
        && ttsAutoReadRef.current
        && getTtsState().status === 'idle'
      ) {
        const nextItem = pendingTtsQueueRef.current.shift()!;
        taskModeSpokenIdsRef.current.add(nextItem.messageId);
        inSyncTtsDispatchRef.current = true;
        let resultPromise: ReturnType<typeof speakText>;
        try {
          resultPromise = speakText(nextItem.text, {
            messageId: nextItem.messageId,
            lang: nextItem.lang,
            queue: true,
          });
        } finally {
          inSyncTtsDispatchRef.current = false;
        }
        void resultPromise.then((res) => {
          if (!res.started && mountedRef.current && ttsAutoReadRef.current && getTtsState().status === 'idle') {
            scheduleDrainPendingTts();
          }
        }).catch(() => {
          if (mountedRef.current && ttsAutoReadRef.current && getTtsState().status === 'idle') {
            scheduleDrainPendingTts();
          }
        });
      }
    };

    const scheduleDrainPendingTts = () => {
      if (drainScheduledRef.current) return;
      drainScheduledRef.current = true;
      queueMicrotask(() => {
        drainScheduledRef.current = false;
        drainPendingTts();
      });
    };

    const unsubStore = globalTaskModeStore.subscribe((next) => {
      setState(next);

      const mutedSet = new Set(next.mutedServerIds);
      const prevMutedSet = prevMutedSetRef.current;

      for (const id of prevMutedSet) {
        if (!mutedSet.has(id)) {
          pendingUnmuteServersRef.current.add(id);
        }
      }
      for (const id of mutedSet) {
        pendingUnmuteServersRef.current.delete(id);
      }

      const isSnapshot = next.snapshotSeq > lastSnapshotSeqRef.current;
      if (isSnapshot) {
        lastSnapshotSeqRef.current = next.snapshotSeq;
        if (!seededLifecycleRef.current) {
          // Initial post-mount snapshot: silently seed without speaking history.
          if (next.snapshotSeq > entrySnapshotSeqRef.current) {
            seededLifecycleRef.current = true;
          }
          prevMutedSetRef.current = mutedSet;
          pendingUnmuteServersRef.current.clear();
          prevTasksRef.current = new Map(next.tasks.map((row) => [taskKey(row.serverId, row.taskId), row]));
          return;
        }
      } else if (!seededLifecycleRef.current) {
        prevMutedSetRef.current = mutedSet;
        prevTasksRef.current = new Map(next.tasks.map((row) => [taskKey(row.serverId, row.taskId), row]));
        return;
      }

      const now = Date.now();
      const nextMap = new Map<string, GlobalTaskSummaryRow>();
      const candidates: QueuedTaskModeTtsItem[] = [];
      for (const row of next.tasks) {
        const key = taskKey(row.serverId, row.taskId);
        nextMap.set(key, row);
        if (mutedSet.has(row.serverId) || prevMutedSet.has(row.serverId)) continue;
        if (isSnapshot && pendingUnmuteServersRef.current.has(row.serverId)) continue;

        const prev = prevTasksRef.current.get(key);
        if (!shouldAutoSpeakTaskUpdate({ row, prev, now, mountAt: mountAtRef.current })) continue;

        const prevFlags = new Set(prev?.flags ?? []);
        const newBlocked = row.flags.includes('blocked') && !prevFlags.has('blocked');
        const newNeedsInput = row.flags.includes('needs_input') && !prevFlags.has('needs_input');

        const payload: Record<string, unknown> = {
          taskId: row.taskId,
          title: row.title,
          toStatus: row.status,
          round: row.round,
          ...(newBlocked ? { verb: 'BLOCKED' } : newNeedsInput ? { verb: 'NEEDS_INPUT' } : {}),
        };
        const announcement = formatTaskPairTtsAnnouncement(translateRef.current, payload);
        if (!announcement) continue;

        const dedupKey = `tp:${row.serverId}:${announcement.dedupKey}`;
        if (seenTtsKeysRef.current.has(dedupKey)) continue;
        seenTtsKeysRef.current.add(dedupKey);

        if (!ttsAutoReadRef.current || !isTtsSupported()) continue;
        const serverLabel = row.serverName || row.serverId;
        const spoken = translateRef.current('taskMode.tts_brain_prefix', {
          server: serverLabel,
          text: announcement.text,
        });
        if (!prepareTextForTts(spoken, localeRef.current)) continue;
        const arrivalSeq = ++ttsArrivalSeqRef.current;
        const msgId = `gt-tp:${row.serverId}:${row.taskId}:${row.status}:${row.round}:${row.updatedAt}:${arrivalSeq}`;
        candidates.push({
          text: spoken,
          messageId: msgId,
          lang: localeRef.current,
          eventTs: row.updatedAt || now,
          arrivalSeq,
        });
      }
      if (candidates.length > 0) {
        enqueueChronologicalTtsItems(pendingTtsQueueRef.current, candidates);
        scheduleDrainPendingTts();
      }
      if (isSnapshot) {
        for (const id of [...pendingUnmuteServersRef.current]) {
          if (!mutedSet.has(id)) {
            pendingUnmuteServersRef.current.delete(id);
          }
        }
      }
      prevMutedSetRef.current = mutedSet;
      prevTasksRef.current = nextMap;
    });

    const unsubBrainText = globalTaskModeStore.subscribeBrainText((event) => {
      const current = globalTaskModeStore.getState();
      if (current.mutedServerIds.includes(event.serverId)) return;
      if (!shouldAutoSpeakBrainText({ eventTs: event.ts, now: Date.now(), mountAt: mountAtRef.current })) return;
      const dedupKey = `brain:${event.eventId}`;
      if (seenTtsKeysRef.current.has(dedupKey)) return;
      seenTtsKeysRef.current.add(dedupKey);

      if (!ttsAutoReadRef.current || !isTtsSupported()) return;
      const serverLabel = event.serverName || event.serverId;
      const spoken = translateRef.current('taskMode.tts_brain_prefix', {
        server: serverLabel,
        text: event.text,
      });
      if (!prepareTextForTts(spoken, localeRef.current)) return;
      const arrivalSeq = ++ttsArrivalSeqRef.current;
      const msgId = `gt-brain:${event.eventId}`;
      enqueueChronologicalTtsItems(pendingTtsQueueRef.current, [{
        text: spoken,
        messageId: msgId,
        lang: localeRef.current,
        eventTs: event.ts,
        arrivalSeq,
      }]);
      scheduleDrainPendingTts();
    });

    const unsubTtsState = subscribeTtsState((nextTts) => {
      setTtsState(nextTts);
      if (nextTts.status === 'idle' && !inSyncTtsDispatchRef.current) {
        drainPendingTts();
      }
    });
    const unsubTtsPrefs = subscribeTtsPreferences(() => {
      const enabled = getTtsAutoReadEnabled();
      setTtsAutoRead(enabled);
      if (!enabled) {
        pendingTtsQueueRef.current.length = 0;
      }
    });

    const releaseStream = typeof globalTaskModeStore.acquire === 'function'
      ? globalTaskModeStore.acquire()
      : (() => {
        void globalTaskModeStore.start();
        return () => { globalTaskModeStore.stop(); };
      })();

    return () => {
      mountedRef.current = false;
      pendingTtsQueueRef.current.length = 0;
      pendingUnmuteServersRef.current.clear();
      for (const tracker of pressTrackersRef.current.values()) {
        if (tracker.timer) clearTimeout(tracker.timer);
        tracker.cleanup?.();
      }
      pressTrackersRef.current.clear();
      unsubStore();
      unsubBrainText();
      unsubTtsState();
      unsubTtsPrefs();
      releaseStream();

      const activeTts = getTtsState();
      if (
        activeTts.status === 'speaking'
        && activeTts.activeMessageId
        && taskModeSpokenIdsRef.current.has(activeTts.activeMessageId)
      ) {
        void stopSpeaking();
      }
      taskModeSpokenIdsRef.current.clear();
    };
  }, []);

  // Default server filter to workspace-pinned servers until the user explicitly customizes it.
  useEffect(() => {
    if (state.servers.length === 0) return;
    if (globalTaskModeStore.hasExplicitMutedServerFilter()) return;
    const defaultMuted = computeDefaultMutedServerIds(state.servers, pinnedServerIds);
    globalTaskModeStore.applyDefaultMutedServerIds(defaultMuted);
  }, [pinnedServerIds, state.servers]);

  // Close server filter menu on outside click / Escape
  useEffect(() => {
    if (!serverMenuOpen) return;
    const onPointerDown = (e: Event) => {
      const target = e.target as Node | null;
      if (target && serverFilterRef.current?.contains(target)) return;
      setServerMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setServerMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [serverMenuOpen]);

  // Keep server filter dropdown bounded within current viewport on open / resize
  useEffect(() => {
    if (!serverMenuOpen) {
      setServerMenuTop(null);
      return;
    }
    const updateMenuTop = () => {
      const rect = serverFilterBtnRef.current?.getBoundingClientRect();
      if (rect && rect.bottom > 0) {
        setServerMenuTop(Math.round(rect.bottom + 6));
      }
    };
    updateMenuTop();
    window.addEventListener('resize', updateMenuTop);
    window.visualViewport?.addEventListener('resize', updateMenuTop);
    return () => {
      window.removeEventListener('resize', updateMenuTop);
      window.visualViewport?.removeEventListener('resize', updateMenuTop);
    };
  }, [serverMenuOpen]);

  // Derived data
  const mutedSet = useMemo(() => new Set(state.mutedServerIds), [state.mutedServerIds]);
  const sortedServers = useMemo(
    () => sortGlobalTaskServers(state.servers, pinnedServerIds, serverOrder),
    [pinnedServerIds, serverOrder, state.servers],
  );
  const unmutedServers = useMemo(
    () => sortedServers.filter((s) => !mutedSet.has(s.id)),
    [sortedServers, mutedSet],
  );
  const pinnedBrainKeys = useMemo(
    () => new Set(state.pinnedBrains.map((p) => brainKey(p.serverId, p.sessionName))),
    [state.pinnedBrains],
  );

  const quickDispatchBrains = useMemo(
    () => resolveQuickDispatchBrains(
      state.pinnedBrains,
      state.recentBrains,
      state.brains,
      state.mutedServerIds,
      { pinnedServerIds, pinnedSessionNames, serverOrder, tabOrder },
    ),
    [
      pinnedServerIds,
      pinnedSessionNames,
      serverOrder,
      state.brains,
      state.mutedServerIds,
      state.pinnedBrains,
      state.recentBrains,
      tabOrder,
    ],
  );

  // Sync add-modal defaults when opened or servers/brains change
  useEffect(() => {
    if (!addModalOpen) return;
    const candidates = unmutedServers.length > 0 ? unmutedServers : sortedServers;
    const chosenServer = candidates.some((s) => s.id === addServerId)
      ? addServerId
      : (candidates[0]?.id ?? '');
    if (chosenServer !== addServerId) {
      setAddServerId(chosenServer);
    }
    const brainsForServer = state.brains.filter((b) => b.serverId === chosenServer);
    if (!brainsForServer.some((b) => b.sessionName === addSessionName)) {
      setAddSessionName(brainsForServer[0]?.sessionName ?? '');
    }
  }, [addModalOpen, addServerId, addSessionName, sortedServers, state.brains, unmutedServers]);

  const counts = useMemo(() => {
    let attention = 0;
    let working = 0;
    let audit = 0;
    let done = 0;
    for (const row of state.tasks) {
      if (matchesTaskFilter(row, 'attention')) attention += 1;
      else if (matchesTaskFilter(row, 'audit')) audit += 1;
      else if (matchesTaskFilter(row, 'working')) working += 1;
      else if (matchesTaskFilter(row, 'done')) done += 1;
    }
    return {
      all: state.tasks.length,
      attention,
      working,
      audit,
      done,
    };
  }, [state.tasks]);

  const filteredTasks = useMemo(
    () => state.tasks.filter((task) => matchesTaskFilter(task, statusFilter)),
    [state.tasks, statusFilter],
  );

  const activeTasks = useMemo(
    () => filteredTasks.filter((task) => !task.isTerminal),
    [filteredTasks],
  );

  const terminalTasks = useMemo(
    () => filteredTasks.filter((task) => task.isTerminal),
    [filteredTasks],
  );

  const hasLiveTimingTask = useMemo(
    () => activeTasks.some((task) => {
      const startTs = typeof task.startedAt === 'number' && Number.isFinite(task.startedAt) && task.startedAt > 0
        ? task.startedAt
        : (typeof task.createdAt === 'number' && Number.isFinite(task.createdAt) && task.createdAt > 0 ? task.createdAt : 0);
      return startTs > 0;
    }),
    [activeTasks],
  );
  const now = useNowTicker(hasLiveTimingTask);
  const durationUnits = useMemo(
    () => ({
      day: t('taskPair.panel_duration_day'),
      hour: t('taskPair.panel_duration_hour'),
      minute: t('taskPair.panel_duration_minute'),
      second: t('taskPair.panel_duration_second'),
      separator: t('taskPair.panel_duration_separator'),
    }),
    [t],
  );

  // Gesture helpers: tap -> quick composer, long-press (260ms) -> VoiceOverlay, scroll (>12px) -> cancelled
  const finishPressTracker = useCallback((key: string, cancelPress: boolean) => {
    const tracker = pressTrackersRef.current.get(key);
    if (!tracker) return;
    if (tracker.timer) {
      clearTimeout(tracker.timer);
      tracker.timer = null;
    }
    tracker.cleanup?.();
    if (cancelPress || tracker.moved || tracker.firedLongPress) {
      suppressClickKeysRef.current.add(key);
    }
    pressTrackersRef.current.delete(key);
  }, []);

  const bindDualActionButton = useCallback((
    key: string,
    onTap: () => void,
    onLongPress: () => void,
  ) => ({
    onPointerDown: (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      finishPressTracker(key, false);
      suppressClickKeysRef.current.delete(key);

      const handleDocMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== tracker.pointerId || tracker.moved) return;
        if (Math.hypot(moveEvent.clientX - tracker.startX, moveEvent.clientY - tracker.startY) > MOVE_CANCEL_PX) {
          tracker.moved = true;
          if (tracker.timer) {
            clearTimeout(tracker.timer);
            tracker.timer = null;
          }
        }
      };
      const handleDocUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== tracker.pointerId) return;
        finishPressTracker(key, false);
      };
      const handleDocCancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId !== tracker.pointerId) return;
        finishPressTracker(key, true);
      };

      const tracker: PressTracker = {
        key,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
        firedLongPress: false,
        timer: setTimeout(() => {
          tracker.timer = null;
          if (tracker.moved) return;
          tracker.firedLongPress = true;
          suppressClickKeysRef.current.add(key);
          onLongPress();
        }, LONG_PRESS_MS),
        cleanup: () => {
          document.removeEventListener('pointermove', handleDocMove, true);
          document.removeEventListener('pointerup', handleDocUp, true);
          document.removeEventListener('pointercancel', handleDocCancel, true);
        },
      };

      document.addEventListener('pointermove', handleDocMove, true);
      document.addEventListener('pointerup', handleDocUp, true);
      document.addEventListener('pointercancel', handleDocCancel, true);
      pressTrackersRef.current.set(key, tracker);
    },
    onPointerMove: (e: PointerEvent) => {
      const tracker = pressTrackersRef.current.get(key);
      if (!tracker || tracker.pointerId !== e.pointerId || tracker.moved) return;
      if (Math.hypot(e.clientX - tracker.startX, e.clientY - tracker.startY) > MOVE_CANCEL_PX) {
        tracker.moved = true;
        if (tracker.timer) {
          clearTimeout(tracker.timer);
          tracker.timer = null;
        }
      }
    },
    onPointerUp: (e: PointerEvent) => {
      const tracker = pressTrackersRef.current.get(key);
      if (!tracker || tracker.pointerId !== e.pointerId) return;
      finishPressTracker(key, false);
    },
    onPointerCancel: (e: PointerEvent) => {
      const tracker = pressTrackersRef.current.get(key);
      if (!tracker || tracker.pointerId !== e.pointerId) return;
      finishPressTracker(key, true);
    },
    onClick: (e: MouseEvent) => {
      e.stopPropagation();
      if (suppressClickKeysRef.current.has(key)) {
        suppressClickKeysRef.current.delete(key);
        return;
      }
      onTap();
    },
  }), [finishPressTracker]);

  const openQuickComposer = useCallback((snapshot: TaskModeTargetSnapshot) => {
    setComposerTarget(snapshot);
    setComposerDraft(snapshot.initialText ?? '');
    setComposerError(null);
  }, []);

  const openVoiceInput = useCallback((snapshot: TaskModeTargetSnapshot) => {
    setComposerTarget(null);
    setVoiceTarget(snapshot);
  }, []);

  const handleSendComposer = useCallback(async () => {
    const target = composerTarget;
    const text = composerDraft.trim();
    if (!target || !text || composerSending) return;
    setComposerSending(true);
    setComposerError(null);
    try {
      await globalTaskModeStore.sendGlobalBrainMessage({
        serverId: target.serverId,
        sessionName: target.sessionName,
        text,
        ...(target.mode === 'reply' && target.taskTitle ? { taskTitle: target.taskTitle } : {}),
        locale,
        projectName: target.projectName,
        label: target.label,
      });
      setComposerTarget(null);
      setComposerDraft('');
    } catch (err) {
      setComposerError(err instanceof Error ? err.message : t('taskMode.send_failed', 'Failed to send message'));
    } finally {
      setComposerSending(false);
    }
  }, [composerDraft, composerSending, composerTarget, locale, t]);

  const handleVoiceSend = useCallback((text: string): 'accepted' | 'pending' | 'rejected' => {
    const target = voiceTarget;
    const trimmed = text.trim();
    if (!target || !trimmed) return 'rejected';
    void globalTaskModeStore.sendGlobalBrainMessage({
      serverId: target.serverId,
      sessionName: target.sessionName,
      text: trimmed,
      ...(target.mode === 'reply' && target.taskTitle ? { taskTitle: target.taskTitle } : {}),
      locale,
      projectName: target.projectName,
      label: target.label,
    }).catch(() => {
      // Non-blocking error; voice overlay settles cleanly and store preserves recent state on success.
    });
    return 'accepted';
  }, [locale, voiceTarget]);

  const handleAddDispatch = useCallback(async () => {
    const text = addMessage.trim();
    if (!addServerId || !addSessionName || !text || addSending) return;
    const serverMeta = state.servers.find((s) => s.id === addServerId);
    const brainMeta = state.brains.find((b) => b.serverId === addServerId && b.sessionName === addSessionName);
    setAddSending(true);
    setAddError(null);
    try {
      await globalTaskModeStore.sendGlobalBrainMessage({
        serverId: addServerId,
        sessionName: addSessionName,
        text,
        locale,
        projectName: brainMeta?.projectName,
        label: brainMeta?.label ?? addSessionName,
      });
      setAddModalOpen(false);
      setAddMessage('');
      if (serverMeta && mutedSet.has(serverMeta.id)) {
        globalTaskModeStore.toggleMutedServer(serverMeta.id);
      }
    } catch (err) {
      setAddError(err instanceof Error ? err.message : t('taskMode.send_failed', 'Failed to send message'));
    } finally {
      setAddSending(false);
    }
  }, [addMessage, addSending, addServerId, addSessionName, locale, mutedSet, state.brains, state.servers, t]);

  const handleToggleManualSpeak = useCallback((task: GlobalTaskSummaryRow, previewText: string, eventId: string) => {
    const manualMsgId = `gt-manual:${task.serverId}:${task.taskId}:${eventId}`;
    pendingTtsQueueRef.current.length = 0;
    if (ttsState.status === 'speaking' && ttsState.activeMessageId === manualMsgId) {
      void stopSpeaking();
      return;
    }
    const serverLabel = task.serverName || task.serverId;
    const spoken = t('taskMode.tts_brain_prefix', { server: serverLabel, text: previewText });
    taskModeSpokenIdsRef.current.add(manualMsgId);
    void speakText(spoken, { messageId: manualMsgId, lang: locale, queue: false });
  }, [locale, t, ttsState.activeMessageId, ttsState.status]);

  const toggleExpandTask = useCallback((key: string) => {
    setExpandedTaskKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const renderTaskStatusLabel = (task: GlobalTaskSummaryRow): string => {
    if (task.flags.includes('blocked')) return t('taskPair.flag.blocked');
    if (task.flags.includes('needs_input')) return t('taskPair.flag.needs_input');
    if (task.status === 'rework' && task.round > 0) {
      return t('taskPair.status.rework_round', { round: task.round });
    }
    return t(`taskPair.status.${task.status}`, { defaultValue: task.status });
  };

  const renderTaskCard = (task: GlobalTaskSummaryRow) => {
    const key = taskKey(task.serverId, task.taskId);
    const expanded = expandedTaskKeys.has(key);
    const tone = resolveStatusTone(task);
    const latestBrainEvent = !mutedSet.has(task.serverId)
      ? state.latestBrainTexts[brainKey(task.serverId, task.brainSession)]
      : undefined;
    const manualMsgId = latestBrainEvent ? `gt-manual:${task.serverId}:${task.taskId}:${latestBrainEvent.eventId}` : '';
    const isSpeakingThisCard = Boolean(
      latestBrainEvent
      && ttsState.status === 'speaking'
      && ttsState.activeMessageId === manualMsgId,
    );

    const total = task.checklist.total;
    const implDone = Math.min(total, Math.max(0, task.checklist.implemented));
    const auditDone = Math.min(total, Math.max(0, task.checklist.audited));
    const implPct = total > 0 ? Math.round((implDone / total) * 100) : 0;
    const auditPct = total > 0 ? Math.round((auditDone / total) * 100) : 0;

    const effectiveStartTs = typeof task.startedAt === 'number' && Number.isFinite(task.startedAt) && task.startedAt > 0
      ? task.startedAt
      : (typeof task.createdAt === 'number' && Number.isFinite(task.createdAt) && task.createdAt > 0 ? task.createdAt : 0);
    const startTimeText = effectiveStartTs > 0 ? formatUpdatedRelative(effectiveStartTs, locale) : '';
    const durationText = effectiveStartTs > 0
      ? formatTaskDuration({
          startedAt: effectiveStartTs,
          endedAt: task.endedAt,
          updatedAt: task.updatedAt,
          now,
          terminal: task.isTerminal,
        }, durationUnits)
      : undefined;
    const timingEl = (startTimeText || durationText) ? (
      <span class="global-task-card-timing" data-testid={`task-mode-timing-${task.taskId}`}>
        {startTimeText && durationText
          ? `${startTimeText} · ⏱ ${durationText}`
          : (durationText ? `⏱ ${durationText}` : startTimeText)}
      </span>
    ) : null;

    const replySnapshot: TaskModeTargetSnapshot = {
      serverId: task.serverId,
      serverName: task.serverName,
      sessionName: task.brainSession,
      label: task.brainLabel || task.brainSession,
      projectName: task.projectName,
      taskTitle: task.title,
      mode: 'reply',
    };

    const replyPressProps = bindDualActionButton(
      `reply:${key}`,
      () => openQuickComposer(replySnapshot),
      () => openVoiceInput(replySnapshot),
    );

    return (
      <article
        key={key}
        class={`global-task-card is-${tone}${task.isTerminal ? ' is-terminal' : ''}${expanded ? ' is-expanded' : ''}`}
        data-testid={`task-mode-card-${task.taskId}`}
        onClick={() => toggleExpandTask(key)}
      >
        <div class="global-task-card-main">
          <div class="global-task-card-content">
            <div class="global-task-card-meta">
              <span class={`global-task-server-tag${task.serverOnline ? ' is-online' : ' is-offline'}`} title={task.serverName}>
                <span class="global-task-dot" aria-hidden="true" />
                <span class="global-task-tag-text">{task.serverName}</span>
              </span>
              <span class="global-task-brain-tag" title={task.brainLabel || task.brainSession}>{task.brainLabel || task.brainSession}</span>
              <span class={`global-task-status-badge is-${tone}`}>{renderTaskStatusLabel(task)}</span>
              {task.round > 0 && (
                <span class="global-task-round-badge">R{task.round}</span>
              )}
              <button
                type="button"
                class="global-task-reply-btn"
                data-testid={`task-mode-reply-${task.taskId}`}
                title={t('taskMode.reply_hint', 'Tap to type, hold for voice')}
                aria-label={task.isTerminal ? t('taskMode.follow_up', 'Follow up') : t('taskMode.reply', 'Reply')}
                {...replyPressProps}
              >
                <ReplyGlyph size={12} />
                <MicGlyph size={11} />
              </button>
            </div>

            <div class="global-task-card-title" title={task.title}>{task.title}</div>

            {total > 0 && (
              <div class="global-task-progress-wrap" data-testid={`task-mode-progress-${task.taskId}`}>
                <div class="global-task-progress-labels">
                  <span class="global-task-progress-impl-label" data-testid={`task-mode-impl-progress-${task.taskId}`}>
                    {t('taskMode.progress_impl', { done: implDone, total })}
                  </span>
                  <span class="global-task-progress-audit-label" data-testid={`task-mode-audit-progress-${task.taskId}`}>
                    {t('taskMode.progress_audit', { done: auditDone, total })}
                  </span>
                </div>
                <div class="global-task-progress-track" aria-hidden="true">
                  <div class="global-task-progress-impl-bar" style={{ width: `${implPct}%` }} />
                  <div class="global-task-progress-audit-bar" style={{ width: `${auditPct}%` }} />
                </div>
                {timingEl}
              </div>
            )}

            {total === 0 && timingEl && (
              <div class="global-task-timing-row">{timingEl}</div>
            )}

            {task.liveSummary && (
              <div class="global-task-live-summary" title={task.liveSummary}>{task.liveSummary}</div>
            )}

            {latestBrainEvent && (
              <div
                class="global-task-brain-preview"
                data-testid={`task-mode-brain-preview-${task.taskId}`}
                onClick={(e) => e.stopPropagation()}
              >
                <span class="global-task-brain-preview-text" title={latestBrainEvent.text}>{latestBrainEvent.text}</span>
                <button
                  type="button"
                  class={`global-task-speak-btn${isSpeakingThisCard ? ' is-speaking' : ''}`}
                  data-testid={`task-mode-speak-${task.taskId}`}
                  title={isSpeakingThisCard ? t('taskMode.stop_speak', 'Stop speaking') : t('taskMode.speak_reply', 'Read aloud')}
                  aria-label={isSpeakingThisCard ? t('taskMode.stop_speak', 'Stop speaking') : t('taskMode.speak_reply', 'Read aloud')}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggleManualSpeak(task, latestBrainEvent.text, latestBrainEvent.eventId);
                  }}
                >
                  <SpeakerGlyph active={!isSpeakingThisCard} size={13} />
                </button>
              </div>
            )}
          </div>
        </div>

        {expanded && (
          <div class="global-task-card-details" data-testid={`task-mode-details-${task.taskId}`} onClick={(e) => e.stopPropagation()}>
            <div class="global-task-detail-row">
              <span>{t('taskPair.card_executor')}: {task.executorLabel || t('taskPair.card_unassigned')}</span>
              <span>
                {t('taskPair.card_auditor')}: {task.auditor === 'none'
                  ? t('taskMode.auditor_none', 'None')
                  : (task.auditorLabel || task.auditor || t('taskPair.card_unassigned'))}
              </span>
              {task.projectName && <span>{t('taskMode.project_label', 'Project')}: {task.projectName}</span>}
              {task.updatedAt > 0 && <span>{formatUpdatedRelative(task.updatedAt, locale)}</span>}
            </div>
            {task.flags.length > 0 && (
              <div class="global-task-detail-flags">
                {task.flags.map((flag) => (
                  <span key={flag} class="global-task-flag-chip">
                    {t(`taskPair.flag.${flag}`, { defaultValue: flag })}
                  </span>
                ))}
              </div>
            )}
            <div class="global-task-detail-actions">
              <button
                type="button"
                class="global-task-jump-btn"
                data-testid={`task-mode-jump-${task.taskId}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onJumpToSession(task.serverId, task.brainSession);
                }}
              >
                {t('taskMode.enter_session', 'Open session')}
              </button>
            </div>
          </div>
        )}
      </article>
    );
  };

  const filterChips: Array<{ id: GlobalTaskStatusFilter; label: string; count: number }> = [
    { id: 'all', label: t('taskMode.filter_all', 'All'), count: counts.all },
    { id: 'attention', label: t('taskMode.filter_attention', 'Attention'), count: counts.attention },
    { id: 'working', label: t('taskMode.filter_working', 'Working'), count: counts.working },
    { id: 'audit', label: t('taskMode.filter_audit', 'Audit'), count: counts.audit },
    { id: 'done', label: t('taskMode.filter_done', 'Done'), count: counts.done },
  ];

  const totalServersCount = state.servers.length;
  const activeServersCount = state.servers.filter((s) => !mutedSet.has(s.id)).length;
  const serverFilterLabel = t('taskMode.server_filter', { active: activeServersCount, total: totalServersCount });
  const syncLabel = state.connected
    ? t('taskMode.live_sync', 'Live sync')
    : state.connecting
      ? t('common.reconnecting', 'Reconnecting…')
      : t('common.disconnected', 'Disconnected');
  const brainsForSelectedAddServer = state.brains.filter((b) => b.serverId === addServerId);
  const isAddTargetPinned = Boolean(addServerId && addSessionName && pinnedBrainKeys.has(brainKey(addServerId, addSessionName)));

  const quickReplyChips = [
    t('taskMode.quick_chip_continue', 'Continue'),
    t('taskMode.quick_chip_status', 'Report status & blockers'),
    t('taskMode.quick_chip_merge', 'Approved to merge'),
  ];

  return (
    <div class="global-task-mode-view" data-testid="global-task-mode-view">
      {/* Top Bar */}
      <header class="global-task-mode-topbar">
        <div class="global-task-mode-topbar-left">
          <div class="global-task-mode-switcher" role="tablist" aria-label={t('taskMode.title', 'Task Mode')}>
            <button
              type="button"
              class="global-task-mode-switch-btn"
              data-testid="task-mode-exit-btn"
              onClick={onExit}
            >
              {t('taskMode.workspace_tab', 'Workspace')}
            </button>
            <button
              type="button"
              class="global-task-mode-switch-btn is-active"
              aria-current="page"
            >
              {t('taskMode.title', 'Task Mode')}
            </button>
          </div>

          <div class="global-task-mode-filters" role="group" aria-label={t('taskMode.status_filter_label', 'Status filter')}>
            {filterChips.map((chip) => {
              const filterAria = `${chip.label} (${chip.count})`;
              return (
                <button
                  key={chip.id}
                  type="button"
                  class={`global-task-mode-filter-pill${statusFilter === chip.id ? ' is-active' : ''}${chip.id === 'attention' && chip.count > 0 ? ' has-attention' : ''}`}
                  data-filter={chip.id}
                  data-testid={`task-mode-filter-${chip.id}`}
                  title={filterAria}
                  aria-label={filterAria}
                  aria-pressed={statusFilter === chip.id}
                  onClick={() => setStatusFilter(chip.id)}
                >
                  <span class="global-task-mode-filter-icon" aria-hidden="true">
                    <StatusFilterIcon filter={chip.id} />
                  </span>
                  <span class="global-task-mode-filter-count">{chip.count}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div class="global-task-mode-topbar-right">
          <div
            class={`global-task-mode-sync-badge${state.connected ? ' is-connected' : state.error ? ' is-error' : ' is-connecting'}`}
            data-testid="task-mode-sync-badge"
            title={syncLabel}
            aria-label={syncLabel}
          >
            <span class="global-task-mode-sync-dot" aria-hidden="true" />
            <span class="global-task-mode-sync-label">{syncLabel}</span>
          </div>

          {/* Reused unified TTS auto-read + quick settings popover */}
          <div ref={ttsControlRef} class="chat-tts-control-wrap">
            <div class="chat-tts-control-group" data-testid="task-mode-tts-control-group">
              <button
                type="button"
                class={`chat-tts-autoread-btn${ttsAutoRead ? ' is-active' : ''}${ttsAutoRead && ttsState.status === 'speaking' ? ' is-speaking' : ''}`}
                data-testid="task-mode-tts-autoread-btn"
                title={ttsAutoRead ? t('chat.tts_autoread_off') : t('chat.tts_autoread_on')}
                aria-label={ttsAutoRead ? t('chat.tts_autoread_off') : t('chat.tts_autoread_on')}
                aria-pressed={ttsAutoRead}
                onClick={() => {
                  const next = !ttsAutoRead;
                  setTtsAutoReadEnabled(next);
                  setTtsAutoRead(next);
                  if (!next) {
                    pendingTtsQueueRef.current.length = 0;
                    void stopSpeaking();
                  }
                }}
              >
                <SpeakerGlyph active={ttsAutoRead} size={13} />
              </button>
              <button
                type="button"
                class={`chat-tts-settings-btn${ttsSettingsOpen ? ' is-open' : ''}`}
                data-testid="task-mode-tts-settings-btn"
                title={t('chat.tts_settings')}
                aria-label={t('chat.tts_settings')}
                aria-expanded={ttsSettingsOpen}
                aria-haspopup="dialog"
                onClick={() => setTtsSettingsOpen((prev) => !prev)}
              >
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
            </div>
            {ttsSettingsOpen && (
              <TtsQuickSettingsPopover
                anchorRef={ttsControlRef}
                locale={locale}
                onClose={handleCloseTtsSettings}
              />
            )}
          </div>

          {/* Server Filter Dropdown */}
          <div ref={serverFilterRef} class="global-task-server-filter-wrap">
            <button
              ref={serverFilterBtnRef}
              type="button"
              class="global-task-server-filter-btn"
              data-testid="task-mode-server-filter-btn"
              title={serverFilterLabel}
              aria-label={serverFilterLabel}
              aria-expanded={serverMenuOpen}
              onClick={() => setServerMenuOpen((prev) => !prev)}
            >
              <span class="global-task-server-filter-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="2" y="3" width="20" height="8" rx="2" />
                  <rect x="2" y="13" width="20" height="8" rx="2" />
                  <line x1="6" y1="7" x2="6.01" y2="7" />
                  <line x1="6" y1="17" x2="6.01" y2="17" />
                </svg>
              </span>
              <span class="global-task-server-filter-count">{activeServersCount}/{totalServersCount}</span>
            </button>
            {serverMenuOpen && (
              <div
                class="global-task-server-filter-menu"
                data-testid="task-mode-server-filter-menu"
                role="dialog"
                style={serverMenuTop !== null ? ({ '--filter-menu-top': `${serverMenuTop}px` } as Record<string, string>) : undefined}
              >
                <div class="global-task-server-filter-title">{t('taskMode.server_filter_heading', 'Visible Servers')}</div>
                {sortedServers.length === 0 ? (
                  <div class="global-task-server-filter-empty">{t('taskMode.no_servers', 'No servers')}</div>
                ) : (
                  <div class="global-task-server-filter-list" data-testid="task-mode-server-filter-list">
                    {sortedServers.map((server) => {
                      const enabled = !mutedSet.has(server.id);
                      return (
                        <label key={server.id} class="global-task-server-filter-item">
                          <input
                            type="checkbox"
                            checked={enabled}
                            data-testid={`task-mode-server-toggle-${server.id}`}
                            onChange={() => globalTaskModeStore.toggleMutedServer(server.id)}
                          />
                          <span class={`global-task-dot${server.online ? ' is-online' : ' is-offline'}`} aria-hidden="true" />
                          <span class="global-task-server-filter-name" title={server.name}>{server.name}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Scrollable Body */}
      <div class="global-task-mode-body">
        {/* Quick Dispatch Brain Bar */}
        <section class="global-task-quickbar" data-testid="task-mode-quickbar">
          <div class="global-task-quickbar-header">
            <span class="global-task-quickbar-label">{t('taskMode.quick_dispatch', 'Quick dispatch')}</span>
            <button
              type="button"
              class="global-task-add-btn"
              data-testid="task-mode-add-brain-btn"
              title={t('taskMode.add_or_dispatch', '+ Add / Dispatch')}
              aria-label={t('taskMode.add_or_dispatch', '+ Add / Dispatch')}
              onClick={() => {
                setAddError(null);
                setAddModalOpen(true);
              }}
            >
              +
            </button>
          </div>
          {quickDispatchBrains.length > 0 && (
            <div class="global-task-quickbar-list" data-testid="task-mode-quickbar-list">
              {quickDispatchBrains.map((brain: GlobalTaskQuickDispatchBrain) => {
                const dispatchSnapshot: TaskModeTargetSnapshot = {
                  serverId: brain.serverId,
                  serverName: brain.serverName,
                  sessionName: brain.sessionName,
                  label: brain.label,
                  projectName: brain.projectName,
                  mode: 'dispatch',
                };
                const pillLabel = `${brain.serverName} · ${brain.label}`;
                const pressProps = bindDualActionButton(
                  `brain:${brain.serverId}:${brain.sessionName}`,
                  () => openQuickComposer(dispatchSnapshot),
                  () => openVoiceInput(dispatchSnapshot),
                );
                return (
                  <div
                    key={`${brain.serverId}:${brain.sessionName}`}
                    class={`global-task-brain-pill${brain.pinned ? ' is-pinned' : ''}`}
                    data-testid={`task-mode-brain-pill-${brain.serverId}-${brain.sessionName}`}
                    role="button"
                    tabIndex={0}
                    title={pillLabel}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openQuickComposer(dispatchSnapshot);
                      }
                    }}
                    {...pressProps}
                  >
                    <button
                      type="button"
                      class={`global-task-brain-pin-btn${brain.pinned ? ' is-pinned' : ''}`}
                      data-testid={`task-mode-brain-pin-${brain.serverId}-${brain.sessionName}`}
                      aria-pressed={brain.pinned}
                      title={brain.pinned ? t('taskMode.unpin_brain', 'Unpin Brain') : t('taskMode.pin_brain', 'Pin Brain')}
                      aria-label={brain.pinned ? t('taskMode.unpin_brain', 'Unpin Brain') : t('taskMode.pin_brain', 'Pin Brain')}
                      onPointerDown={(e) => e.stopPropagation()}
                      onPointerUp={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        globalTaskModeStore.togglePinnedBrain({
                          serverId: brain.serverId,
                          sessionName: brain.sessionName,
                          label: brain.label,
                          projectName: brain.projectName,
                        });
                      }}
                    >
                      {brain.pinned ? '★' : '☆'}
                    </button>
                    <span class={`global-task-dot${brain.serverOnline ? ' is-online' : ' is-offline'}`} aria-hidden="true" />
                    <span class="global-task-brain-pill-text" title={pillLabel}>
                      {pillLabel}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Active Tasks Section */}
        {statusFilter !== 'done' && (
          <section class="global-task-section" data-testid="task-mode-active-section">
            {activeTasks.length > 0 ? (
              <div class="global-task-mode-grid">
                {activeTasks.map(renderTaskCard)}
              </div>
            ) : (
              <div class="global-task-empty-state" data-testid="task-mode-empty-active">
                {state.loading
                  ? t('common.loading', 'Loading…')
                  : t('taskMode.empty_active', 'No active tasks matching filter. Use Quick Dispatch above to start a new task anytime.')}
              </div>
            )}
          </section>
        )}

        {/* Recent Finished Section (collapsible) */}
        {(terminalTasks.length > 0 || statusFilter === 'done') && (
          <section class="global-task-section global-task-finished-section" data-testid="task-mode-finished-section">
            <button
              type="button"
              class="global-task-finished-toggle"
              data-testid="task-mode-finished-toggle"
              aria-expanded={statusFilter === 'done' ? true : finishedExpanded}
              onClick={() => setFinishedExpanded((prev) => !prev)}
            >
              <span>{t('taskMode.recent_finished', 'Recent finished')} ({terminalTasks.length})</span>
              <span aria-hidden="true">{statusFilter === 'done' || finishedExpanded ? '▾' : '▸'}</span>
            </button>
            {(statusFilter === 'done' || finishedExpanded) && (
              terminalTasks.length > 0 ? (
                <div class="global-task-mode-grid">
                  {terminalTasks.map(renderTaskCard)}
                </div>
              ) : (
                <div class="global-task-empty-state">
                  {t('taskMode.empty_done', 'No recent finished tasks')}
                </div>
              )
            )}
          </section>
        )}
      </div>

      {/* Compact Quick Reply / Dispatch Composer Popover */}
      {composerTarget && (
        <div
          class="global-task-modal-backdrop"
          data-testid="task-mode-composer-backdrop"
          onClick={() => setComposerTarget(null)}
        >
          <div
            class="global-task-composer-dialog"
            data-testid="task-mode-composer"
            role="dialog"
            aria-label={composerTarget.mode === 'reply' ? t('taskMode.reply', 'Reply') : t('taskMode.quick_dispatch', 'Quick dispatch')}
            onClick={(e) => e.stopPropagation()}
          >
            <div class="global-task-composer-header">
              <div class="global-task-composer-target">
                <span class="global-task-composer-server">{composerTarget.serverName} · {composerTarget.label}</span>
                {composerTarget.taskTitle && (
                  <span class="global-task-composer-task-title">{composerTarget.taskTitle}</span>
                )}
              </div>
              <button
                type="button"
                class="global-task-modal-close"
                aria-label={t('common.close', 'Close')}
                onClick={() => setComposerTarget(null)}
              >
                ✕
              </button>
            </div>

            {composerTarget.mode === 'reply' && (
              <div class="global-task-composer-chips">
                {quickReplyChips.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    class="global-task-composer-chip"
                    onClick={() => setComposerDraft((prev) => (prev.trim() ? `${prev.trim()} ${chip}` : chip))}
                  >
                    {chip}
                  </button>
                ))}
              </div>
            )}

            <textarea
              class="global-task-composer-input"
              data-testid="task-mode-composer-input"
              rows={3}
              value={composerDraft}
              placeholder={composerTarget.mode === 'reply'
                ? t('taskMode.reply_placeholder', 'Write instruction for this task…')
                : t('taskMode.dispatch_placeholder', 'Send new instruction to this Brain…')}
              onInput={(e) => setComposerDraft((e.currentTarget as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void handleSendComposer();
                }
              }}
            />

            {composerError && (
              <div class="global-task-error-banner">{composerError}</div>
            )}

            <div class="global-task-composer-footer">
              <button
                type="button"
                class="global-task-composer-voice-btn"
                data-testid="task-mode-composer-voice-btn"
                title={t('voice.voice_input', 'Voice input')}
                aria-label={t('voice.voice_input', 'Voice input')}
                onClick={() => openVoiceInput({ ...composerTarget, initialText: composerDraft })}
              >
                <MicGlyph size={14} />
              </button>
              <button
                type="button"
                class="global-task-composer-send-btn"
                data-testid="task-mode-composer-send-btn"
                disabled={composerSending || !composerDraft.trim()}
                onClick={() => void handleSendComposer()}
              >
                {composerSending ? t('common.loading', 'Sending…') : t('common.send', 'Send')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add / Dispatch New Task Modal */}
      {addModalOpen && (
        <div
          class="global-task-modal-backdrop"
          data-testid="task-mode-add-backdrop"
          onClick={() => setAddModalOpen(false)}
        >
          <div
            class="global-task-composer-dialog"
            data-testid="task-mode-add-modal"
            role="dialog"
            aria-label={t('taskMode.add_or_dispatch', '+ Add / Dispatch')}
            onClick={(e) => e.stopPropagation()}
          >
            <div class="global-task-composer-header">
              <strong>{t('taskMode.add_or_dispatch', '+ Add / Dispatch')}</strong>
              <button
                type="button"
                class="global-task-modal-close"
                aria-label={t('common.close', 'Close')}
                onClick={() => setAddModalOpen(false)}
              >
                ✕
              </button>
            </div>

            <div class="global-task-add-fields">
              <label class="global-task-add-field">
                <span>{t('shareTarget.server_label', 'Server')}</span>
                <select
                  data-testid="task-mode-add-server-select"
                  value={addServerId}
                  onChange={(e) => {
                    const nextServer = (e.currentTarget as HTMLSelectElement).value;
                    setAddServerId(nextServer);
                    const firstBrain = state.brains.find((b) => b.serverId === nextServer);
                    setAddSessionName(firstBrain?.sessionName ?? '');
                  }}
                >
                  {(unmutedServers.length > 0 ? unmutedServers : sortedServers).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>

              <label class="global-task-add-field">
                <span>Brain</span>
                <select
                  data-testid="task-mode-add-brain-select"
                  value={addSessionName}
                  onChange={(e) => setAddSessionName((e.currentTarget as HTMLSelectElement).value)}
                >
                  {brainsForSelectedAddServer.map((b) => (
                    <option key={b.sessionName} value={b.sessionName}>
                      {b.label}{b.projectName ? ` (${b.projectName})` : ''}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {addServerId && addSessionName && (
              <div class="global-task-add-pin-row">
                <button
                  type="button"
                  class={`global-task-pin-action-btn${isAddTargetPinned ? ' is-pinned' : ''}`}
                  data-testid="task-mode-add-pin-toggle"
                  onClick={() => {
                    const brain = brainsForSelectedAddServer.find((b) => b.sessionName === addSessionName);
                    globalTaskModeStore.togglePinnedBrain({
                      serverId: addServerId,
                      sessionName: addSessionName,
                      label: brain?.label ?? addSessionName,
                      projectName: brain?.projectName,
                    });
                  }}
                >
                  {isAddTargetPinned
                    ? `★ ${t('taskMode.pinned_brain', 'Pinned')}`
                    : `☆ ${t('taskMode.pin_brain', 'Pin Brain')}`}
                </button>
              </div>
            )}

            <textarea
              class="global-task-composer-input"
              data-testid="task-mode-add-input"
              rows={3}
              value={addMessage}
              placeholder={t('taskMode.dispatch_placeholder', 'Send new instruction to this Brain…')}
              onInput={(e) => setAddMessage((e.currentTarget as HTMLTextAreaElement).value)}
            />

            {addError && (
              <div class="global-task-error-banner">{addError}</div>
            )}

            <div class="global-task-composer-footer">
              <button
                type="button"
                class="global-task-composer-voice-btn"
                data-testid="task-mode-add-voice-btn"
                disabled={!addServerId || !addSessionName}
                title={t('voice.voice_input', 'Voice input')}
                aria-label={t('voice.voice_input', 'Voice input')}
                onClick={() => {
                  const server = state.servers.find((s) => s.id === addServerId);
                  const brain = brainsForSelectedAddServer.find((b) => b.sessionName === addSessionName);
                  setAddModalOpen(false);
                  openVoiceInput({
                    serverId: addServerId,
                    serverName: server?.name ?? addServerId,
                    sessionName: addSessionName,
                    label: brain?.label ?? addSessionName,
                    projectName: brain?.projectName ?? '',
                    mode: 'dispatch',
                    initialText: addMessage,
                  });
                }}
              >
                <MicGlyph size={14} />
              </button>
              <button
                type="button"
                class="global-task-composer-send-btn"
                data-testid="task-mode-add-submit-btn"
                disabled={addSending || !addServerId || !addSessionName || !addMessage.trim()}
                onClick={() => void handleAddDispatch()}
              >
                {addSending ? t('common.loading', 'Sending…') : t('taskMode.dispatch_now', 'Dispatch now')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Strictly reused VoiceOverlay */}
      {voiceTarget && (
        <VoiceOverlay
          open
          autoStartListening
          initialText={voiceTarget.initialText ?? ''}
          sessionLabel={voiceTarget.taskTitle
            ? `${voiceTarget.serverName} · ${voiceTarget.label} · ${voiceTarget.taskTitle}`
            : `${voiceTarget.serverName} · ${voiceTarget.label}`}
          onClose={() => setVoiceTarget(null)}
          onSend={handleVoiceSend}
        />
      )}
    </div>
  );
}
