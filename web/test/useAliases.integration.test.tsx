/**
 * @vitest-environment jsdom
 *
 * Integration coverage for the REAL `useAliases` hook (audit finding Cx1-4 +
 * Cx1-5). The network is mocked at the `apiFetch` layer — NOT the hook — so the
 * hook's own error/loading/stale bookkeeping and the shared-resource fetch cycle
 * are exercised end-to-end:
 *
 *  - a successful load exposes the list with `loaded` true and `error` null;
 *  - a list-fetch FAILURE surfaces `error` (no longer swallowed into an empty
 *    list) while keeping any previously loaded value;
 *  - a loading race: while the first fetch is in flight, `loading` is true and
 *    the list is not yet `loaded`, then it settles.
 */
import { render, cleanup, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AliasEntry } from '@shared/alias-types.js';

// Mock ONLY the network primitive; keep the real ApiError + everything else so
// the alias API client and useAliases run for real.
const apiFetchMock = vi.fn();
vi.mock('../src/api.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/api.js')>();
  return { ...orig, apiFetch: (...args: unknown[]) => apiFetchMock(...args) };
});

import { useAliases, __resetAliasesForTests, type UseAliasesResult } from '../src/hooks/useAliases.js';
import { ApiError } from '../src/api.js';

function entry(name: string, value: string): AliasEntry {
  return { name, value, tags: [], createdAt: '', updatedAt: '', source: 'web' };
}

/** Mount the real hook and expose its latest snapshot to assertions. */
function mountHook(): { latest: () => UseAliasesResult } {
  let latest: UseAliasesResult | null = null;
  function Probe() {
    latest = useAliases();
    return null;
  }
  render(<Probe />);
  return { latest: () => latest as UseAliasesResult };
}

afterEach(() => { cleanup(); vi.clearAllMocks(); __resetAliasesForTests(); });

describe('useAliases (real hook, apiFetch mocked) — Cx1-4', () => {
  it('exposes the loaded list with error null on a successful fetch', async () => {
    apiFetchMock.mockResolvedValue({ aliases: [entry('deploy', 'ssh root@host')] });
    const { latest } = mountHook();

    await waitFor(() => expect(latest().loaded).toBe(true));
    expect(latest().aliases.map((a) => a.name)).toEqual(['deploy']);
    expect(latest().error).toBeNull();
    expect(latest().loading).toBe(false);
  });

  it('surfaces `error` when the list fetch fails instead of masking it as an empty list', async () => {
    // Server 500 → apiFetch throws ApiError → listAliases rethrows AliasApiError.
    apiFetchMock.mockRejectedValue(new ApiError(500, '{"error":"boom"}'));
    const { latest } = mountHook();

    await waitFor(() => expect(latest().error).not.toBeNull());
    // The failure is observable — callers can distinguish "load failed" from
    // "no aliases". The pre-fix behavior swallowed this into loaded+empty.
    expect(latest().loaded).toBe(false);
    expect(latest().loading).toBe(false);
  });

  it('reports a loading race: loading before the fetch settles, then loaded', async () => {
    let resolveFetch!: (v: { aliases: AliasEntry[] }) => void;
    apiFetchMock.mockImplementation(() => new Promise((res) => { resolveFetch = res as typeof resolveFetch; }));
    const { latest } = mountHook();

    // Mid-flight: loading true, not yet loaded.
    await waitFor(() => expect(latest().loading).toBe(true));
    expect(latest().loaded).toBe(false);

    resolveFetch({ aliases: [entry('winbox', '10.0.0.9')] });
    await waitFor(() => expect(latest().loaded).toBe(true));
    expect(latest().loading).toBe(false);
    expect(latest().error).toBeNull();
    expect(latest().aliases.map((a) => a.name)).toEqual(['winbox']);
  });
});
