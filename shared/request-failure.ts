const TRANSIENT_REQUEST_FAILURE_RE = /(\bconnection error\b|\bfetch failed\b|\bfailed to fetch\b|\bnetwork request failed\b|\b(?:econnreset|econnrefused|enotfound|etimedout|eai_again|ehostunreach|enetunreach)\b|\b(?:dns lookup failed|socket hang up|network socket disconnected)\b)/i;

/**
 * Conservative transport-failure classifier shared by provider retry and
 * memory-noise filtering. It follows nested Error.cause chains because Node's
 * fetch commonly keeps the actionable socket code on the cause.
 */
export function isTransientRequestFailure(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  for (let depth = 0; pending.length > 0 && depth < 8; depth++) {
    const current = pending.shift();
    if (typeof current === 'string') {
      if (TRANSIENT_REQUEST_FAILURE_RE.test(current)) return true;
      continue;
    }
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    for (const candidate of [record.message, record.code, record.name]) {
      if (typeof candidate === 'string' && TRANSIENT_REQUEST_FAILURE_RE.test(candidate)) return true;
    }
    if (record.cause !== undefined) pending.push(record.cause);
  }
  return false;
}
