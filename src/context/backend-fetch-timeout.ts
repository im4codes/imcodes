/**
 * Backend (control-plane) calls made while assembling session context must never hang: a
 * stalled connection would otherwise hold a session launch / send for as long as the socket
 * stays open. Callers on the launch path pass a tighter `timeoutMs` that fits inside the
 * transport context budget; everything else gets this generous default.
 */
export const BACKEND_CONTEXT_FETCH_DEFAULT_TIMEOUT_MS = 10_000;

export function backendContextFetchSignal(timeoutMs?: number): AbortSignal {
  return AbortSignal.timeout(
    timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : BACKEND_CONTEXT_FETCH_DEFAULT_TIMEOUT_MS,
  );
}
