import type { SessionState } from './session-store.js';

export type SessionStateProbeObserver = (
  sessionName: string,
  state: Extract<SessionState, 'idle' | 'running'>,
) => void;

let observer: SessionStateProbeObserver | undefined;

/** Keep startup-probe notifications on a leaf module with no daemon imports. */
export function registerSessionStateProbeObserver(
  nextObserver: SessionStateProbeObserver,
): () => void {
  const previous = observer;
  observer = nextObserver;
  return () => {
    if (observer === nextObserver) observer = previous;
  };
}

export function emitSessionStateProbeCorrection(
  sessionName: string,
  state: Extract<SessionState, 'idle' | 'running'>,
): void {
  try { observer?.(sessionName, state); } catch { /* observer is best-effort */ }
}
