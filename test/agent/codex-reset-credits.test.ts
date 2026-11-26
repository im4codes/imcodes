import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));
vi.mock('../../src/util/logger.js', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/agent/codex-runtime-config.js', () => ({ callCodexAppServerMethod: vi.fn() }));

import { readFile } from 'node:fs/promises';
import { callCodexAppServerMethod } from '../../src/agent/codex-runtime-config.js';
import {
  fetchCodexResetCredits,
  consumeCodexResetCredit,
  normalizeConsumeOutcome,
} from '../../src/agent/codex-reset-credits.js';

const readFileMock = vi.mocked(readFile);
const callAppServerMock = vi.mocked(callCodexAppServerMethod);

const AUTH_JSON = JSON.stringify({
  auth_mode: 'chatgpt',
  tokens: { access_token: 'SECRET_ACCESS_TOKEN', account_id: 'acct-123', id_token: 'x' },
});

describe('normalizeConsumeOutcome', () => {
  it('maps app-server camelCase outcomes to the normalized union', () => {
    expect(normalizeConsumeOutcome('reset')).toBe('reset');
    expect(normalizeConsumeOutcome('nothingToReset')).toBe('nothing_to_reset');
    expect(normalizeConsumeOutcome('alreadyRedeemed')).toBe('already_redeemed');
    expect(normalizeConsumeOutcome('noCredits')).toBe('no_credits');
    expect(normalizeConsumeOutcome('somethingUnknown')).toBe('error');
    expect(normalizeConsumeOutcome(undefined)).toBe('error');
  });
});

describe('fetchCodexResetCredits', () => {
  beforeEach(() => {
    readFileMock.mockReset();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('normalizes the wham response and sends the auth headers (no token in output)', async () => {
    readFileMock.mockResolvedValue(AUTH_JSON as never);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        credits: [
          { id: 'c1', status: 'available', granted_at: '2026-06-18T00:00:00Z', expires_at: '2026-07-18T00:00:00Z', title: 'Full reset' },
        ],
        available_count: 1,
      }),
    } as never);

    const res = await fetchCodexResetCredits();
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.list.availableCount).toBe(1);
    expect(res.list.credits).toEqual([
      { id: 'c1', status: 'available', grantedAt: '2026-06-18T00:00:00Z', expiresAt: '2026-07-18T00:00:00Z', title: 'Full reset' },
    ]);

    // Bearer token + account header are sent; the returned payload has no token.
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer SECRET_ACCESS_TOKEN');
    expect(headers['chatgpt-account-id']).toBe('acct-123');
    expect(JSON.stringify(res)).not.toContain('SECRET_ACCESS_TOKEN');
  });

  it('returns no_codex_auth when auth.json is missing / has no token', async () => {
    readFileMock.mockRejectedValue(new Error('ENOENT') as never);
    const res = await fetchCodexResetCredits();
    expect(res).toEqual({ ok: false, error: 'no_codex_auth' });
  });

  it('returns request_failed on a non-ok HTTP response', async () => {
    readFileMock.mockResolvedValue(AUTH_JSON as never);
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as never);
    const res = await fetchCodexResetCredits();
    expect(res).toEqual({ ok: false, error: 'request_failed' });
  });
});

describe('consumeCodexResetCredit', () => {
  beforeEach(() => callAppServerMock.mockReset());

  it('returns the mapped outcome on success', async () => {
    callAppServerMock.mockResolvedValue({ errored: false, outcome: 'reset' } as never);
    expect(await consumeCodexResetCredit('idem-1')).toEqual({ ok: true, outcome: 'reset' });
  });

  it('maps nothingToReset (no credit burned) through', async () => {
    callAppServerMock.mockResolvedValue({ errored: false, outcome: 'nothingToReset' } as never);
    expect(await consumeCodexResetCredit('idem-2')).toEqual({ ok: true, outcome: 'nothing_to_reset' });
  });

  it('returns app_server_timeout when the app-server call resolves undefined', async () => {
    callAppServerMock.mockResolvedValue(undefined as never);
    expect(await consumeCodexResetCredit('idem-3')).toEqual({ ok: false, error: 'app_server_timeout' });
  });

  it('rejects an empty idempotencyKey without calling the app-server', async () => {
    expect(await consumeCodexResetCredit('')).toEqual({ ok: false, error: 'invalid_params' });
    expect(callAppServerMock).not.toHaveBeenCalled();
  });
});
