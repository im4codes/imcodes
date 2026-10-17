import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const detectRepoMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/repo/detector.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/repo/detector.js')>();
  return { ...actual, detectRepo: detectRepoMock };
});

import {
  ORIGIN_URL_CACHE_TTL_MS,
  __clearOriginUrlCacheForTests,
  resolveCachedOriginUrl,
} from '../../src/agent/runtime-context-bootstrap.js';
import { bumpRepoGeneration, __resetRepoGenerationsForTests } from '../../src/repo/generation.js';

const repoWith = (remoteUrl: string) => ({ info: { remoteUrl }, status: 'ok' });

describe('bootstrap origin URL cache (a send must not re-run git)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T00:00:00Z'));
    detectRepoMock.mockReset();
    __clearOriginUrlCacheForTests();
    __resetRepoGenerationsForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs detectRepo once for a burst of sends to the same project and serves the rest from the cache', async () => {
    detectRepoMock.mockResolvedValue(repoWith('git@github.com:acme/repo.git'));
    const urls = [];
    for (let i = 0; i < 25; i += 1) urls.push(await resolveCachedOriginUrl('/work/a'));
    expect(new Set(urls)).toEqual(new Set(['git@github.com:acme/repo.git']));
    expect(detectRepoMock).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent first lookups into one detectRepo', async () => {
    let release!: (value: unknown) => void;
    detectRepoMock.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const lookups = Array.from({ length: 8 }, () => resolveCachedOriginUrl('/work/a'));
    release(repoWith('https://gitlab.com/acme/repo.git'));
    expect(await Promise.all(lookups)).toEqual(Array(8).fill('https://gitlab.com/acme/repo.git'));
    expect(detectRepoMock).toHaveBeenCalledTimes(1);
  });

  it('keeps projects independent', async () => {
    detectRepoMock.mockImplementation(async (dir: string) => repoWith(`https://example.com/${dir.slice(1)}.git`));
    expect(await resolveCachedOriginUrl('/work/a')).toBe('https://example.com/work/a.git');
    expect(await resolveCachedOriginUrl('/work/b')).toBe('https://example.com/work/b.git');
    expect(await resolveCachedOriginUrl('/work/a')).toBe('https://example.com/work/a.git');
    expect(detectRepoMock).toHaveBeenCalledTimes(2);
  });

  it('expires after the TTL so an outside `git remote set-url` is picked up', async () => {
    detectRepoMock.mockResolvedValueOnce(repoWith('https://example.com/old.git'));
    expect(await resolveCachedOriginUrl('/work/a')).toBe('https://example.com/old.git');
    vi.advanceTimersByTime(ORIGIN_URL_CACHE_TTL_MS - 1);
    expect(await resolveCachedOriginUrl('/work/a')).toBe('https://example.com/old.git');
    expect(detectRepoMock).toHaveBeenCalledTimes(1);
    detectRepoMock.mockResolvedValueOnce(repoWith('https://example.com/new.git'));
    vi.advanceTimersByTime(2);
    expect(await resolveCachedOriginUrl('/work/a')).toBe('https://example.com/new.git');
    expect(detectRepoMock).toHaveBeenCalledTimes(2);
  });

  it('is invalidated at once by a repo generation bump (explicit repo refresh), for that project only', async () => {
    detectRepoMock.mockResolvedValue(repoWith('https://example.com/one.git'));
    await resolveCachedOriginUrl('/work/a');
    await resolveCachedOriginUrl('/work/b');
    bumpRepoGeneration('/work/a');
    detectRepoMock.mockResolvedValue(repoWith('https://example.com/two.git'));
    expect(await resolveCachedOriginUrl('/work/a')).toBe('https://example.com/two.git');
    expect(await resolveCachedOriginUrl('/work/b')).toBe('https://example.com/one.git');
    expect(detectRepoMock).toHaveBeenCalledTimes(3);
  });

  it('caches a non-repo and a failure as null for the TTL, and never throws', async () => {
    detectRepoMock.mockResolvedValueOnce({ info: null, status: 'no_repo' });
    expect(await resolveCachedOriginUrl('/work/none')).toBeNull();
    expect(await resolveCachedOriginUrl('/work/none')).toBeNull();
    expect(detectRepoMock).toHaveBeenCalledTimes(1);
    detectRepoMock.mockRejectedValueOnce(new Error('git exploded'));
    await expect(resolveCachedOriginUrl('/work/boom')).resolves.toBeNull();
    await expect(resolveCachedOriginUrl('/work/boom')).resolves.toBeNull();
    expect(detectRepoMock).toHaveBeenCalledTimes(2);
  });
});
