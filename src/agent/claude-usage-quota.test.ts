import { describe, it, expect, afterEach, vi } from 'vitest';
import { usageEndpointToQuotaMeta, getClaudeUsageQuota, setClaudeUsageQuotaOptIn, peekClaudeUsageQuotaCached, __resetClaudeUsageQuotaCache } from './claude-usage-quota.js';
import { formatProviderQuotaLabel } from '../../shared/provider-quota.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The exact /api/oauth/usage payload captured from the live endpoint:
// utilization is 0–100 PERCENT, resets_at is an ISO-8601 string.
const REAL = {
  five_hour: { utilization: 26.0, resets_at: '2026-05-30T06:40:00.613600+00:00' },
  seven_day: { utilization: 30.0, resets_at: '2026-06-02T08:00:00.613623+00:00' },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 11.0, resets_at: '2026-06-02T08:00:00.613632+00:00' },
};

describe('usageEndpointToQuotaMeta', () => {
  it('maps the real payload: five_hour→primary, seven_day→secondary', () => {
    const meta = usageEndpointToQuotaMeta(REAL);
    expect(meta?.primary).toEqual({
      windowDurationMins: 300,
      usedPercent: 26,
      resetsAt: Math.floor(Date.parse('2026-05-30T06:40:00.613600+00:00') / 1000),
    });
    expect(meta?.secondary).toEqual({
      windowDurationMins: 10080,
      usedPercent: 30,
      resetsAt: Math.floor(Date.parse('2026-06-02T08:00:00.613623+00:00') / 1000),
    });
  });

  it('keeps utilization as a 0–100 percent (no ×100 scaling)', () => {
    const meta = usageEndpointToQuotaMeta({ five_hour: { utilization: 40, resets_at: '2026-05-30T06:40:00Z' } });
    expect(meta?.primary?.usedPercent).toBe(40);
  });

  it('parses resets_at ISO → epoch seconds (cross-checks the SDK rate_limit_event value)', () => {
    const meta = usageEndpointToQuotaMeta({ five_hour: { utilization: 1, resets_at: '2026-05-30T06:40:00.613600+00:00' } });
    expect(meta?.primary?.resetsAt).toBe(1780123200); // identical to the SDK event's five_hour resetsAt
  });

  it('falls back to per-model weekly buckets when aggregate seven_day is null', () => {
    const meta = usageEndpointToQuotaMeta({ seven_day: null, seven_day_sonnet: { utilization: 12, resets_at: '2026-06-02T08:00:00Z' } });
    expect(meta?.secondary?.usedPercent).toBe(12);
    expect(meta?.secondary?.windowDurationMins).toBe(10080);
  });

  it('renders a Codex-style "5h … · 7d …" label with no NaN', () => {
    const label = formatProviderQuotaLabel(usageEndpointToQuotaMeta(REAL), Date.UTC(2026, 4, 30, 3, 0, 0));
    expect(label).toMatch(/5h/);
    expect(label).toMatch(/7d/);
    expect(label).not.toMatch(/NaN/);
  });

  it('returns undefined when no window is present', () => {
    expect(usageEndpointToQuotaMeta({})).toBeUndefined();
    expect(usageEndpointToQuotaMeta(null)).toBeUndefined();
    expect(usageEndpointToQuotaMeta({ seven_day_opus: null })).toBeUndefined();
  });
});

describe('getClaudeUsageQuota opt-in gate', () => {
  afterEach(() => { setClaudeUsageQuotaOptIn(false); __resetClaudeUsageQuotaCache(); });

  it('returns null without reading the token / network when not opted in', async () => {
    setClaudeUsageQuotaOptIn(false);
    // force=true bypasses the cache; the gate must still short-circuit to null
    // before any token read or fetch.
    expect(await getClaudeUsageQuota(true)).toBeNull();
  });
});

describe('peekClaudeUsageQuotaCached (sync source-of-truth for the real-time path)', () => {
  const cachePath = join(tmpdir(), '.imcodes', 'claude-usage-quota.json');
  afterEach(() => { setClaudeUsageQuotaOptIn(false); __resetClaudeUsageQuotaCache(); vi.restoreAllMocks(); });

  it('returns the persisted 5h+7d snapshot synchronously, without a fetch', () => {
    // This is what stops the rate_limit_event (5h-only) session-info update from
    // clobbering the 7d line: the real-time path prefers this cached 7d picture.
    mkdirSync(join(tmpdir(), '.imcodes'), { recursive: true });
    const value = { quotaMeta: usageEndpointToQuotaMeta(REAL)!, quotaLabel: '5h 26% · 7d 30%' };
    writeFileSync(cachePath, JSON.stringify({ at: Date.now(), value }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const peeked = peekClaudeUsageQuotaCached();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(peeked?.quotaMeta.secondary?.usedPercent).toBe(30); // the 7d the real-time path must preserve
    expect(peeked?.quotaLabel).toBe('5h 26% · 7d 30%');
  });

  it('returns null when nothing is cached', () => {
    expect(peekClaudeUsageQuotaCached()).toBeNull();
  });
});

describe('quota persistence + idle gate', () => {
  // IS_TEST_ENV routes the cache file under tmpdir, not the real ~/.imcodes.
  const cachePath = join(tmpdir(), '.imcodes', 'claude-usage-quota.json');
  afterEach(() => {
    setClaudeUsageQuotaOptIn(false);
    __resetClaudeUsageQuotaCache();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('serves a disk-persisted snapshot after a restart without hitting the network', async () => {
    // A snapshot persisted by a previous daemon run, <30min old.
    mkdirSync(join(tmpdir(), '.imcodes'), { recursive: true });
    const value = { quotaMeta: usageEndpointToQuotaMeta(REAL)!, quotaLabel: 'persisted-label' };
    writeFileSync(cachePath, JSON.stringify({ at: Date.now(), value }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    setClaudeUsageQuotaOptIn(true); // opt in (also marks activity)
    const q = await getClaudeUsageQuota();

    expect(fetchSpy).not.toHaveBeenCalled();      // served from disk — no /api/oauth/usage
    expect(q?.quotaLabel).toBe('persisted-label');
  });

  it('does NOT hit the network when idle >15min with no claude-code-sdk activity', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    setClaudeUsageQuotaOptIn(true);                // last activity = real now
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 16 * 60 * 1000); // 16min later, still idle (no send)
    const q = await getClaudeUsageQuota();
    expect(fetchSpy).not.toHaveBeenCalled();        // idle gate suppressed the fetch
    expect(q).toBeNull();                           // nothing cached yet → null, but no network
  });

  it('keeps serving a stale (>30min) persisted snapshot after a restart instead of blanking the 7d line', async () => {
    // Daemon restarts often (auto-upgrade); a 2h-old snapshot must still seed
    // the cache so the footer never collapses to the 5h-only rate_limit view.
    mkdirSync(join(tmpdir(), '.imcodes'), { recursive: true });
    const value = { quotaMeta: usageEndpointToQuotaMeta(REAL)!, quotaLabel: 'stale-but-served' };
    writeFileSync(cachePath, JSON.stringify({ at: Date.now() - 2 * 60 * 60 * 1000, value }));
    // The expired TTL triggers a refetch attempt; make it fail — the stale
    // snapshot must survive a failed refresh rather than blank the footer.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

    setClaudeUsageQuotaOptIn(true); // opt in (also marks activity)
    const q = await getClaudeUsageQuota();

    expect(q?.quotaLabel).toBe('stale-but-served');
  });

  it('serves the persisted snapshot BEFORE the opt-in toggle arrives after a restart (no token read, no fetch)', async () => {
    // After a restart optedIn defaults to false until the web (re)connects and
    // re-delivers the pref. The snapshot only ever exists while opted in
    // (revoking deletes it), so serving it leaks nothing — and must not touch
    // the token or the network.
    mkdirSync(join(tmpdir(), '.imcodes'), { recursive: true });
    const value = { quotaMeta: usageEndpointToQuotaMeta(REAL)!, quotaLabel: 'pre-optin-label' };
    writeFileSync(cachePath, JSON.stringify({ at: Date.now() - 2 * 60 * 60 * 1000, value }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const q = await getClaudeUsageQuota(); // optedIn is false (restart default)

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(q?.quotaLabel).toBe('pre-optin-label');
  });

  it('drops persisted snapshots older than 24h instead of showing misleading data', async () => {
    mkdirSync(join(tmpdir(), '.imcodes'), { recursive: true });
    const value = { quotaMeta: usageEndpointToQuotaMeta(REAL)!, quotaLabel: 'too-old' };
    writeFileSync(cachePath, JSON.stringify({ at: Date.now() - 25 * 60 * 60 * 1000, value }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const q = await getClaudeUsageQuota(); // optedIn is false (restart default)

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(q).toBeNull();
  });
});
