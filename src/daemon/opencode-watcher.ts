import { timelineEmitter } from './timeline-emitter.js';
import { getSession, updateSessionState, upsertSession } from '../store/session-store.js';
import logger from '../util/logger.js';
import { timelineStore } from './timeline-store.js';
import {
  readOpenCodeSessionMessagesSince,
  buildTimelineEventsFromOpenCodeExport,
  discoverLatestOpenCodeSessionId,
} from './opencode-history.js';

const POLL_INTERVAL_MS = 1500;

interface WatcherState {
  projectDir: string;
  sessionId?: string;
  pollTimer?: ReturnType<typeof setInterval>;
  polling: boolean;
  initializedForSessionId?: string;
  lastTimeCreated: number;
  lastMessageId: string;
  bootstrapMissingAssistant?: boolean;
}

const watchers = new Map<string, WatcherState>();
const catchupTimers = new Map<string, ReturnType<typeof setTimeout>[]>();

function hasAssistantLikeTimeline(events: Array<{ type: string }>): boolean {
  return events.some((event) => (
    event.type === 'assistant.text'
    || event.type === 'assistant.thinking'
    || event.type === 'tool.call'
    || event.type === 'tool.result'
    || event.type === 'ask.question'
  ));
}


function getLatestStructuredTimelineTs(events: Array<{ type: string; ts?: number }>): number {
  const tsValues = events
    .filter((event) => (
      event.type === 'user.message'
      || event.type === 'assistant.text'
      || event.type === 'assistant.thinking'
      || event.type === 'tool.call'
      || event.type === 'tool.result'
      || event.type === 'ask.question'
    ) && Number.isFinite(event.ts))
    .map((event) => Number(event.ts));
  return tsValues.length > 0 ? Math.max(...tsValues) : 0;
}

function getLatestUserMessageTs(events: Array<{ type: string; ts?: number }>): number {
  const userTs = events
    .filter((event) => event.type === 'user.message' && Number.isFinite(event.ts))
    .map((event) => Number(event.ts));
  return userTs.length > 0 ? Math.max(...userTs) : 0;
}

function getBootstrapCursorTs(events: Array<{ type: string; ts?: number }>, fallbackTs: number): number {
  const earliestUserTs = events
    .filter((event) => event.type === 'user.message' && Number.isFinite(event.ts))
    .map((event) => Number(event.ts));
  const earliestAnyTs = events
    .filter((event) => Number.isFinite(event.ts))
    .map((event) => Number(event.ts));
  const candidate = earliestUserTs.length > 0
    ? Math.min(...earliestUserTs)
    : (earliestAnyTs.length > 0 ? Math.min(...earliestAnyTs) : fallbackTs);
  return Math.max(0, candidate - 1);
}

function isUserRole(message: { info?: Record<string, unknown> }): boolean {
  return String(message.info?.role ?? '') === 'user';
}

function hasProcessableAssistantParts(message: { parts?: Array<Record<string, unknown>> }): boolean {
  return (message.parts ?? []).some((part) => (
    part.type === 'text'
    || part.type === 'reasoning'
    || part.type === 'tool'
  ));
}

function hasCompletionMarker(message: { parts?: Array<Record<string, unknown>> }): boolean {
  return (message.parts ?? []).some((part) => part.type === 'step-finish');
}

function splitCommittedMessages<T extends { info?: Record<string, unknown>; parts?: Array<Record<string, unknown>> }>(
  messages: T[],
): { committed: T[]; pendingTail: T[] } {
  if (messages.length === 0) return { committed: [], pendingTail: [] };

  let cut = messages.length;
  while (cut > 0) {
    const candidate = messages[cut - 1];
    if (isUserRole(candidate)) break;
    if (hasProcessableAssistantParts(candidate) && hasCompletionMarker(candidate)) break;
    cut -= 1;
  }

  return {
    committed: messages.slice(0, cut),
    pendingTail: messages.slice(cut),
  };
}

async function pollTick(sessionName: string, state: WatcherState): Promise<void> {
  if (state.polling) return;
  state.polling = true;
  try {
    let record = getSession(sessionName);
    let sessionId = record?.opencodeSessionId;
    if (!record?.projectDir || !sessionId) return;

    const recentTimeline = await timelineStore.readPreferred(sessionName, { limit: 200 });
    const hasAssistantHistory = hasAssistantLikeTimeline(recentTimeline);
    if (!hasAssistantHistory) {
      const latestUserTs = getLatestUserMessageTs(recentTimeline);
      if (latestUserTs > 0) {
        const reboundId = await discoverLatestOpenCodeSessionId(record.projectDir, {
          updatedAfter: Math.max(0, latestUserTs - 5_000),
          exactDirectory: record.projectDir,
          maxCount: 50,
        });
        if (reboundId && reboundId !== sessionId) {
          record = { ...record, opencodeSessionId: reboundId, updatedAt: Date.now() };
          upsertSession(record);
          sessionId = reboundId;
          state.sessionId = sessionId;
          state.initializedForSessionId = undefined;
          state.lastTimeCreated = 0;
          state.lastMessageId = '';
          state.bootstrapMissingAssistant = false;
        }
      }
    }

    if (state.sessionId !== sessionId) {
      state.sessionId = sessionId;
      state.initializedForSessionId = undefined;
      state.lastTimeCreated = 0;
      state.lastMessageId = '';
      state.bootstrapMissingAssistant = false;
    }

    if (state.initializedForSessionId !== sessionId) {
      const hasAssistantHistoryNow = hasAssistantLikeTimeline(recentTimeline);
      if (hasAssistantHistoryNow) {
        state.lastTimeCreated = getLatestStructuredTimelineTs(recentTimeline);
        state.lastMessageId = '';
        state.bootstrapMissingAssistant = false;
      } else {
        state.lastTimeCreated = getBootstrapCursorTs(recentTimeline, record.createdAt ?? Date.now());
        state.lastMessageId = '';
        state.bootstrapMissingAssistant = true;
      }
      state.initializedForSessionId = sessionId;
    }

    const messages = await readOpenCodeSessionMessagesSince(record.projectDir, sessionId, {
      timeCreated: state.lastTimeCreated,
      messageId: state.lastMessageId,
    });
    if (!messages.length) return;

    const { committed, pendingTail } = splitCommittedMessages(messages);
    if (!committed.length) {
      if (pendingTail.length > 0) {
        logger.debug({ sessionName, sessionId, pendingCount: pendingTail.length }, 'opencode-watcher: pending assistant rows without parts; waiting for next poll');
      }
      return;
    }

    const events = buildTimelineEventsFromOpenCodeExport(sessionName, { info: { id: sessionId }, messages: committed }, timelineEmitter.epoch);
    let emittedAny = false;
    for (const event of events) {
      if (event.type === 'user.message') continue;
      emittedAny = true;
      timelineEmitter.emit(sessionName, event.type, event.payload, {
        source: event.source,
        confidence: event.confidence,
        eventId: event.eventId,
        ts: event.ts,
      });
    }

    const last = committed[committed.length - 1]?.info as Record<string, unknown> | undefined;
    const lastId = typeof last?.id === 'string' ? last.id : undefined;
    const lastCreated = Number((last?.time as Record<string, unknown> | undefined)?.created ?? 0);
    if (lastId) state.lastMessageId = lastId;
    if (Number.isFinite(lastCreated) && lastCreated > 0) state.lastTimeCreated = lastCreated;
    state.bootstrapMissingAssistant = false;
    if (emittedAny) updateSessionState(sessionName, 'idle');
  } catch (err) {
    logger.debug({ err, sessionName }, 'opencode-watcher poll failed');
  } finally {
    state.polling = false;
  }
}

function createWatcherState(projectDir: string, sessionId?: string): WatcherState {
  return {
    projectDir,
    sessionId,
    polling: false,
    initializedForSessionId: undefined,
    lastTimeCreated: 0,
    lastMessageId: '',
    bootstrapMissingAssistant: false,
  };
}

function clearCatchupTimers(sessionName: string): void {
  const timers = catchupTimers.get(sessionName);
  if (!timers) return;
  for (const timer of timers) clearTimeout(timer);
  catchupTimers.delete(sessionName);
}

export async function startWatching(sessionName: string, projectDir: string, sessionId?: string): Promise<void> {
  stopWatching(sessionName);
  const state = createWatcherState(projectDir, sessionId);
  state.pollTimer = setInterval(() => { void pollTick(sessionName, state); }, POLL_INTERVAL_MS);
  watchers.set(sessionName, state);
  void pollTick(sessionName, state);
  scheduleCatchup(sessionName);
}

export async function syncNow(sessionName: string): Promise<void> {
  const existing = watchers.get(sessionName);
  if (existing) {
    await pollTick(sessionName, existing);
    return;
  }
  const record = getSession(sessionName);
  if (!record?.projectDir) return;
  const ephemeral = createWatcherState(record.projectDir, record.opencodeSessionId);
  await pollTick(sessionName, ephemeral);
}

export function scheduleCatchup(sessionName: string, delaysMs: number[] = [1200, 3200, 6500]): void {
  clearCatchupTimers(sessionName);
  const timers = delaysMs.map((delay) => setTimeout(() => {
    void syncNow(sessionName);
  }, delay));
  catchupTimers.set(sessionName, timers);
}

export function stopWatching(sessionName: string): void {
  clearCatchupTimers(sessionName);
  const existing = watchers.get(sessionName);
  if (!existing) return;
  if (existing.pollTimer) clearInterval(existing.pollTimer);
  watchers.delete(sessionName);
}

export function isWatching(sessionName: string): boolean {
  return watchers.has(sessionName);
}

export const __testOnly = {
  splitCommittedMessages,
};
