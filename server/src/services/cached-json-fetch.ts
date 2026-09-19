/**
 * Small helpers for the server's lookups in public directories (skills.sh,
 * the MCP Registry): a bounded time-to-live cache and a JSON GET with a time
 * limit. Whatever comes back is the caller's to validate.
 */
export type Fetch = typeof fetch;

const CACHE_ENTRIES = 200;

export class TtlCache<T> {
  private readonly entries = new Map<string, { at: number; value: T }>();
  constructor(private readonly ttlMs: number) {}

  get(key: string, now: number): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (now - entry.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, now: number): void {
    if (this.entries.size >= CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { at: now, value });
  }
}

/** GET `url` as JSON within `timeoutMs`; throws on any failure or non-2xx status. */
export async function getJsonWithin(fetchImpl: Fetch, url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`directory_status_${response.status}`);
  return await response.json() as unknown;
}

/** The process's fetch, resolved per call so a replaced global is the one used. */
export const processFetch: Fetch = (input, init) => fetch(input, init);
