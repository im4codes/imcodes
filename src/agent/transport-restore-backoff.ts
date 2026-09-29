import type { SessionRecord } from '../store/session-store.js';
import { canonicalizeTransportCwd } from './transport-paths.js';

/**
 * Per-session negative cache for transport restores that can never succeed as
 * things stand (the provider cannot list sessions, so a durable provider id can
 * never be recovered; or the record has no usable project directory). Without
 * it every on-demand caller (the 5 s durable-queue sweep, sends, supervision,
 * cron, delegation replies) re-runs the whole restore and re-logs the same
 * warning forever.
 *
 * In-memory only: a daemon restart starts empty, so the first attempt after
 * boot always runs. Only PERMANENT-by-construction outcomes are recorded here;
 * a thrown error (network, provider RPC) is a transient failure and never
 * enters this cache.
 */
export const TRANSPORT_RESTORE_BACKOFF_STEPS_MS = [5_000, 60_000, 300_000] as const;

export type TransportRestoreUnboundReason =
  | 'provider_cannot_list_sessions'
  | 'project_directory_required';

interface BackoffEntry {
  providerId: string;
  fingerprint: string;
  attempts: number;
  until: number;
  reason: TransportRestoreUnboundReason;
}

const entries = new Map<string, BackoffEntry>();

/**
 * Everything the permanent outcomes above depend on. Any change (provider id
 * bound, session relaunched, project dir or transport config edited) yields a
 * different fingerprint, which invalidates the entry without needing a hook.
 */
export function transportRestoreFingerprint(
  record: Pick<SessionRecord,
    'sessionInstanceId' | 'runtimeEpoch' | 'providerId' | 'agentType' | 'providerSessionId'
    | 'providerResumeId' | 'projectDir' | 'transportConfig'>,
): string {
  return JSON.stringify([
    record.sessionInstanceId ?? '',
    record.runtimeEpoch ?? '',
    record.providerId ?? record.agentType,
    record.agentType,
    record.providerSessionId ?? '',
    record.providerResumeId ?? '',
    canonicalizeTransportCwd(record.projectDir) ?? '',
    record.transportConfig ?? null,
  ]);
}

/** True while a recorded permanent failure for THIS record state is still inside its window. */
export function isTransportRestoreBackedOff(
  sessionName: string,
  fingerprint: string,
  now: number = Date.now(),
): boolean {
  const entry = entries.get(sessionName);
  if (!entry) return false;
  if (entry.fingerprint !== fingerprint) {
    entries.delete(sessionName);
    return false;
  }
  return entry.until > now;
}

export interface TransportRestoreBackoffNote {
  /** True when this call started a new backoff step: the one moment a warn is due. */
  logNow: boolean;
  attempts: number;
  retryInMs: number;
}

/**
 * Record a permanent restore failure. A call made while the window is still
 * open (a send that deliberately bypassed the cache) neither advances the
 * schedule nor asks for another warn.
 */
export function noteTransportRestoreUnbound(
  sessionName: string,
  providerId: string,
  fingerprint: string,
  reason: TransportRestoreUnboundReason,
  now: number = Date.now(),
): TransportRestoreBackoffNote {
  const existing = entries.get(sessionName);
  if (existing && existing.fingerprint === fingerprint && existing.until > now) {
    return { logNow: false, attempts: existing.attempts, retryInMs: existing.until - now };
  }
  const attempts = existing && existing.fingerprint === fingerprint ? existing.attempts + 1 : 1;
  const step = TRANSPORT_RESTORE_BACKOFF_STEPS_MS[Math.min(attempts, TRANSPORT_RESTORE_BACKOFF_STEPS_MS.length) - 1]!;
  entries.set(sessionName, { providerId, fingerprint, attempts, until: now + step, reason });
  return { logNow: true, attempts, retryInMs: step };
}

export function clearTransportRestoreBackoff(sessionName: string): void {
  entries.delete(sessionName);
}

/** Provider reconnected: whatever it could not do before, it may be able to do now. */
export function clearTransportRestoreBackoffForProvider(providerId: string): void {
  for (const [name, entry] of entries) {
    if (entry.providerId === providerId) entries.delete(name);
  }
}

/** Drop entries whose session no longer exists (deleted while backed off). */
export function pruneTransportRestoreBackoff(isLive: (sessionName: string) => boolean): void {
  for (const name of entries.keys()) {
    if (!isLive(name)) entries.delete(name);
  }
}

export function transportRestoreBackoffSize(): number {
  return entries.size;
}

export function resetTransportRestoreBackoffForTests(): void {
  entries.clear();
}
