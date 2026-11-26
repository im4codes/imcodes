/**
 * Live participant presentation (label / model / running-idle-offline state)
 * for the supervision console rows.
 *
 * A console snapshot or replay projects hundreds of assignments, and each live
 * state read builds that session's full transport-queue snapshot, so reads are
 * memoized per session for a short TTL. The memo exists for those BULK passes.
 * It must never serve a read that follows a change we were told about: the
 * pair-row refresh a session event schedules runs ~250 ms later, always inside
 * the TTL of the read made while the session was still streaming, so without
 * {@link SupervisionSessionPresentationResolver.invalidate} the refresh re-read
 * the pre-change state, found the row unchanged, sent no delta - and the panel
 * kept showing "running" for a session that had gone idle until some unrelated
 * event happened to touch the pair.
 */
import type { SupervisionConsoleSessionState, SupervisionConsoleSessionStateSource } from '../../shared/supervision-task-console.js';

export const SUPERVISION_LIVE_STATE_CACHE_MS = 1_000;
const MAX_CACHED_SESSIONS = 4_096;

export interface SupervisionSessionPresentation {
  label?: string;
  model?: string;
  thinking?: string;
  state: SupervisionConsoleSessionState;
  source: SupervisionConsoleSessionStateSource;
  observedAt: number;
}

/** What the resolver needs to know about one stored session. */
export interface SupervisionPresentationSessionRecord {
  label?: string | null;
  activeModel?: string | null;
  requestedModel?: string | null;
  effort?: string | null;
  updatedAt: number;
}

export interface SupervisionSessionPresentationSources<Record extends SupervisionPresentationSessionRecord, Observed extends string> {
  getSession(sessionName: string): Record | undefined;
  isWaitingForUserInput(sessionName: string): boolean;
  /** The authoritative list state of the session ('running' | 'queued' | 'idle' | 'error' | 'stopped' | ...). */
  observeListState(record: Record): Observed;
  isSessionWorking(sessionName: string): boolean;
  resolveMissing(durableObservedAt: number): SupervisionSessionPresentation;
  now?: () => number;
}

export interface SupervisionSessionPresentationResolver {
  resolve(sessionName: string, durableObservedAt: number): SupervisionSessionPresentation;
  /** Forget the memoized live state of one session (call on every event that may have changed it). */
  invalidate(sessionName: string): void;
}

export function createSupervisionSessionPresentationResolver<Record extends SupervisionPresentationSessionRecord, Observed extends string>(
  sources: SupervisionSessionPresentationSources<Record, Observed>,
): SupervisionSessionPresentationResolver {
  const now = sources.now ?? Date.now;
  const liveStateCache = new Map<string, { at: number; observed: Observed; working: boolean }>();
  return {
    invalidate(sessionName) {
      liveStateCache.delete(sessionName);
    },
    resolve(sessionName, durableObservedAt) {
      const record = sources.getSession(sessionName);
      if (!record) return sources.resolveMissing(durableObservedAt);
      const label = record.label ?? undefined;
      const model = record.activeModel?.trim() || record.requestedModel?.trim() || undefined;
      const thinking = record.effort ?? undefined;
      if (sources.isWaitingForUserInput(sessionName)) {
        return { label, model, thinking, state: 'needs_input', source: 'supervision', observedAt: record.updatedAt };
      }
      const at = now();
      let live = liveStateCache.get(sessionName);
      if (!live || at - live.at >= SUPERVISION_LIVE_STATE_CACHE_MS) {
        live = {
          at,
          observed: sources.observeListState(record),
          working: sources.isSessionWorking(sessionName),
        };
        if (liveStateCache.size >= MAX_CACHED_SESSIONS) liveStateCache.clear();
        liveStateCache.set(sessionName, live);
      }
      const { observed, working } = live;
      const observedState = observed as string;
      return {
        label,
        model,
        thinking,
        state: working || observedState === 'running' || observedState === 'queued'
          ? 'running'
          : observedState === 'idle'
            ? 'idle'
            : observedState === 'error' || observedState === 'stopped'
              ? 'offline'
              : 'unknown',
        source: observedState === 'running' || observedState === 'queued' || observedState === 'idle'
          ? 'runtime'
          : 'registry',
        observedAt: record.updatedAt,
      };
    },
  };
}
