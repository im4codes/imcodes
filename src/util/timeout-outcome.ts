export type TimeoutOutcome<T> =
  | { timedOut: false; value: T }
  | { timedOut: true };

/**
 * Race `promise` against `timeoutMs`. A timeout resolves `{ timedOut: true }`
 * WITHOUT cancelling the promise (the caller decides whether late completion
 * matters); a rejection still rejects. A non-positive / non-finite timeout
 * means "no bound".
 */
export function withTimeoutOutcome<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<TimeoutOutcome<T>> {
  if (!timeoutMs || timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    return promise.then((value) => ({ timedOut: false, value }));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<TimeoutOutcome<T>>((resolve, reject) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        if (timer) clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      },
    );
  });
}
