import { afterEach, describe, expect, it, vi } from 'vitest';
import { presignR2, r2RelayConfig, r2StagingKey, sweepR2Staging, startR2RelayCleanup } from '../src/services/r2-relay.js';
import { createR2Progress, R2_RELAY_LIMITS } from '../../shared/r2-relay.js';
const config = { accountId: 'a'.repeat(32), bucket: 'private-staging', accessKeyId: 'access-test', secretAccessKey: 'secret-test' };
const env = { USE_R2_RELAY: 'true', R2_ACCOUNT_ID: config.accountId, R2_BUCKET: config.bucket,
  R2_ACCESS_KEY_ID: config.accessKeyId, R2_SECRET_ACCESS_KEY: config.secretAccessKey };
const now = Date.parse('2026-11-13T00:00:00Z');
const key = `staging/2026-11-12/${'b'.repeat(32)}-hello & 世界.txt`;
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('R2 signing and lifecycle', () => {
  it('requires explicit opt-in plus complete config and emits no disabled cleanup requests', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(r2RelayConfig(env)).toEqual(config);
    for (const invalid of [{ ...env, USE_R2_RELAY: undefined }, { ...env, USE_R2_RELAY: 'false' },
      { ...env, R2_SECRET_ACCESS_KEY: undefined }, { ...env, R2_ACCOUNT_ID: '../evil' }]) {
      expect(r2RelayConfig(invalid)).toBeNull(); expect(startR2RelayCleanup(invalid)).toBeUndefined();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('signs exact method/path/expiry without leaking secret and rejects keys outside staging', () => {
    const url = new URL(presignR2(config, 'PUT', key, {}, now));
    expect(url.hostname).toBe(`${config.accountId}.r2.cloudflarestorage.com`);
    expect(decodeURIComponent(url.pathname)).toBe(`/${config.bucket}/${key}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Date')).toBe('20261113T000000Z');
    expect(url.searchParams.get('X-Amz-Credential')).toBe('access-test/20261113/auto/s3/aws4_request');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
    expect(presignR2(config, 'PUT', key, {}, now)).toBe(url.href);
    expect(presignR2(config, 'GET', key, {}, now)).not.toBe(url.href);
    expect(url.href).not.toContain(config.secretAccessKey);
    expect(() => presignR2(config, 'PUT', '../secret')).toThrow('invalid_staging_key');
    expect(() => presignR2(config, 'PUT', `staging/2026-11-13/${'b'.repeat(32)}-../secret`)).toThrow();
    expect(() => presignR2(config, 'PUT', r2StagingKey('x'.repeat(159) + '😀', now))).not.toThrow();
    expect(r2StagingKey('../../hello.txt', now)).toMatch(/^staging\/2026-11-13\/[a-f0-9]{32}-[^/]+$/);
  });
  it('sweeps at exactly 12h, survives restart by listing storage and paginates only staging', async () => {
    const fresh = key.replace('hello', 'fresh'); const other = 'durable/keep';
    const block = (k: string, date: number) => `<Contents><Key>${k.replace(/&/g, '&amp;').replace('世界', '&#x4e16;&#30028;')}</Key><LastModified>${new Date(date).toISOString()}</LastModified></Contents>`;
    const fetch = vi.fn().mockResolvedValueOnce(new Response(`<ListBucketResult>${block(key, now - R2_RELAY_LIMITS.OBJECT_TTL_MS)}${block(fresh, now - R2_RELAY_LIMITS.OBJECT_TTL_MS + 1)}${block(other, 0)}<NextContinuationToken>next&amp;page</NextContinuationToken></ListBucketResult>`))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response('<ListBucketResult></ListBucketResult>'));
    vi.stubGlobal('fetch', fetch);
    expect(await sweepR2Staging(config, now)).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    const urls = fetch.mock.calls.map((call) => new URL(call[0]));
    expect(urls[0]!.searchParams.get('prefix')).toBe('staging/');
    expect(decodeURIComponent(urls[1]!.pathname)).toContain(key);
    expect(fetch.mock.calls[1]![1].method).toBe('DELETE');
    expect(urls[2]!.searchParams.get('continuation-token')).toBe('next&page');
  });
  it('does not let one failed deletion strand other expired objects, and retries storage inventory next sweep', async () => {
    const other = key.replace('hello', 'other');
    const xml = `<ListBucketResult>${[key, other].map((k) => `<Contents><Key>${k.replace(/&/g, '&amp;').replace('世界', '&#x4e16;&#30028;')}</Key><LastModified>${new Date(now - R2_RELAY_LIMITS.OBJECT_TTL_MS).toISOString()}</LastModified></Contents>`).join('')}</ListBucketResult>`;
    const fetch = vi.fn().mockResolvedValueOnce(new Response(xml)).mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(new Response(xml))
      .mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    expect(await sweepR2Staging(config, now)).toBe(1);
    expect(await sweepR2Staging(config, now)).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it('surfaces failed sweeps for retry rather than treating an HTTP error as an empty listing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 403 })));
    await expect(sweepR2Staging(config, now)).rejects.toThrow('r2_status_403');
  });
  it('uses EWMA, clamps monotonic byte counts, handles zero-size and unknown initial ETA', () => {
    const progress = createR2Progress(1000, 0);
    expect(progress(0, 0).etaSeconds).toBeNull();
    expect(progress(100, 1000).speedBps).toBe(100);
    expect(progress(500, 2000).speedBps).toBe(190);
    expect(progress(400, 3000).loadedBytes).toBe(500);
    expect(progress(2000, 4000)).toMatchObject({ loadedBytes: 1000, etaSeconds: 0 });
    expect(createR2Progress(0, 0)(0, 0).etaSeconds).toBe(0);
  });
});
