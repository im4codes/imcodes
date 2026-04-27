/**
 * Shared embedding status type — emitted by the daemon in `daemon.stats`,
 * forwarded by the server's WS bridge, rendered by the web UI as a tiny
 * status icon + tooltip. Single source of truth for the wire format.
 *
 * Keep the union string-narrow so adding a new state requires updating
 * every renderer (no silent fall-through to a default icon).
 */

export type EmbeddingState =
  /** Daemon hasn't tried to embed yet — pipeline not loaded. */
  | 'idle'
  /** First load is in flight (model download / pipeline init). */
  | 'loading'
  /** Local pipeline is loaded and serving requests. */
  | 'ready'
  /** Local pipeline sticky-disabled but server fallback is still eligible. */
  | 'fallback'
  /** Both local and server fallback are dead. Semantic search returns null. */
  | 'unavailable';

export interface EmbeddingStatus {
  state: EmbeddingState;
  /**
   * Underlying error code from the local pipeline (e.g. 'MODULE_NOT_FOUND',
   * 'ERR_DLOPEN_FAILED'). Populated whenever the local pipeline has
   * sticky-failed, even when state === 'fallback' (so the UI can explain
   * WHY we're routing through the server).
   */
  reason: string | null;
}

/** Stable default returned when status data is unavailable (older daemon, missing field). */
export const EMBEDDING_STATUS_UNKNOWN: EmbeddingStatus = { state: 'idle', reason: null };
