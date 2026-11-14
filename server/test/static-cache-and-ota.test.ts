import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'test',
    JWT_SIGNING_KEY: 'test-jwt-key-minimum-32-chars-long',
    BOT_ENCRYPTION_KEY: '0'.repeat(64),
    DB: {
      query: async () => [],
      execute: async () => ({ rowCount: 0 }),
    } as never,
    ...overrides,
  };
}

describe('static asset cache, landing cache, path traversal guard, and OTA streaming', () => {
  afterEach(() => {
    delete process.env.WEB_DIST_PATH;
    delete process.env.LANDING_DIST_PATH;
    delete process.env.UPDATES_DIST_PATH;
    vi.resetModules();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolveSafeAssetPath blocks directory traversal, backslashes, NUL bytes, and malformed encodings', async () => {
    const { resolveSafeAssetPath } = await import('../src/index.js');
    const root = makeTempDir('imcodes-safe-path-');

    expect(resolveSafeAssetPath(root, '/')).toBe(join(root, 'index.html'));
    expect(resolveSafeAssetPath(root, '/assets/app-abc.js')).toBe(join(root, 'assets', 'app-abc.js'));
    expect(resolveSafeAssetPath(root, '/../secret.txt')).toBeNull();
    expect(resolveSafeAssetPath(root, '/%2e%2e/secret.txt')).toBeNull();
    expect(resolveSafeAssetPath(root, '/assets/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
    expect(resolveSafeAssetPath(root, '/foo%00bar.js')).toBeNull();
    expect(resolveSafeAssetPath(root, '/foo%5cbar.js')).toBeNull();
    expect(resolveSafeAssetPath(root, '/%ZZ')).toBeNull();
  }, 15_000);

  it('StaticAssetCache enforces maxEntries + maxTotalBytes LRU eviction and handles disk deletion', async () => {
    const { StaticAssetCache } = await import('../src/index.js');
    const dir = makeTempDir('imcodes-cache-lru-');
    const f1 = join(dir, 'a.bin');
    const f2 = join(dir, 'b.bin');
    const f3 = join(dir, 'c.bin');
    const big = join(dir, 'too-big.bin');
    writeFileSync(f1, Buffer.alloc(40, 1));
    writeFileSync(f2, Buffer.alloc(40, 2));
    writeFileSync(f3, Buffer.alloc(40, 3));
    writeFileSync(big, Buffer.alloc(120, 4));

    const cache = new StaticAssetCache({ maxEntries: 2, maxTotalBytes: 90, maxCacheableFileBytes: 200 });
    await cache.resolve(f1, { immutable: false });
    await cache.resolve(f2, { immutable: false });
    expect(cache.size).toBe(2);
    expect(cache.byteSize).toBe(80);

    // Touch f1 so f2 becomes LRU, then insert f3 -> f2 is evicted
    await cache.resolve(f1, { immutable: false });
    await cache.resolve(f3, { immutable: false });
    expect(cache.size).toBe(2);
    expect(cache.byteSize).toBe(80);

    // Oversized against maxTotalBytes must not wipe existing cache
    const huge = await cache.resolve(big, { immutable: false });
    expect(huge?.kind).toBe('cached');
    expect(cache.size).toBe(2);
    expect(cache.byteSize).toBe(80);

    // Deleting f3 evicts its entry on next mutable resolve
    unlinkSync(f3);
    expect(await cache.resolve(f3, { immutable: false })).toBeNull();
    expect(cache.size).toBe(1);
    expect(cache.byteSize).toBe(40);
  });

  it('serves /assets/* as immutable with ETag, 304, gzip+Vary, and zero-disk-read immutable hits', async () => {
    const webDist = makeTempDir('imcodes-web-immutable-');
    mkdirSync(join(webDist, 'assets'), { recursive: true });
    writeFileSync(join(webDist, 'index.html'), '<html><body>app</body></html>');
    const jsPayload = `export const banner = "${'imcodes-static-cache-'.repeat(80)}";\n`;
    const assetFile = join(webDist, 'assets', 'index-Hash123.js');
    writeFileSync(assetFile, jsPayload);

    process.env.WEB_DIST_PATH = webDist;
    vi.resetModules();
    const { buildApp } = await import('../src/index.js');
    const app = buildApp(makeEnv() as never);

    // Identity request
    const res1 = await app.request('http://localhost/assets/index-Hash123.js');
    expect(res1.status).toBe(200);
    expect(res1.headers.get('content-type')).toBe('application/javascript');
    expect(res1.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res1.headers.get('vary')).toBe('Accept-Encoding');
    expect(res1.headers.get('content-encoding')).toBeNull();
    const etag = res1.headers.get('etag');
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(await res1.text()).toBe(jsPayload);

    // Gzip request
    const resGz = await app.request('http://localhost/assets/index-Hash123.js', {
      headers: { 'Accept-Encoding': 'gzip, deflate' },
    });
    expect(resGz.status).toBe(200);
    expect(resGz.headers.get('content-encoding')).toBe('gzip');
    expect(resGz.headers.get('vary')).toBe('Accept-Encoding');
    const gzEtag = resGz.headers.get('etag');
    expect(gzEtag).toBe(`W/${etag}`);
    const inflated = gunzipSync(Buffer.from(await resGz.arrayBuffer())).toString('utf8');
    expect(inflated).toBe(jsPayload);

    // 304 Not Modified for both ETags
    const res304 = await app.request('http://localhost/assets/index-Hash123.js', {
      headers: { 'If-None-Match': etag! },
    });
    expect(res304.status).toBe(304);
    expect(await res304.text()).toBe('');
    expect(res304.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    const resGz304 = await app.request('http://localhost/assets/index-Hash123.js', {
      headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': gzEtag! },
    });
    expect(resGz304.status).toBe(304);
    expect(await resGz304.text()).toBe('');

    // Delete file on disk: immutable cached asset continues serving 200 from memory
    unlinkSync(assetFile);
    const resMem = await app.request('http://localhost/assets/index-Hash123.js');
    expect(resMem.status).toBe(200);
    expect(await resMem.text()).toBe(jsPayload);
  });

  it('revalidates non-hashed index.html, SPA fallback, and /api/app-build on disk updates, preserves CSP, and blocks traversal', async () => {
    const parent = makeTempDir('imcodes-web-parent-');
    const webDist = join(parent, 'dist');
    mkdirSync(webDist, { recursive: true });
    writeFileSync(join(parent, 'secret.txt'), 'TOP_SECRET');

    const htmlV1 = '<!doctype html><html><body>v1</body></html>';
    const buildV1 = JSON.stringify({ buildId: 'build-1' });
    writeFileSync(join(webDist, 'index.html'), htmlV1);
    writeFileSync(join(webDist, 'app-build.json'), buildV1);

    process.env.WEB_DIST_PATH = webDist;
    vi.resetModules();
    const { buildApp } = await import('../src/index.js');
    const app = buildApp(makeEnv() as never);

    // Initial index + SPA fallback + /api/app-build
    const idx1 = await app.request('http://localhost/');
    expect(idx1.status).toBe(200);
    expect(idx1.headers.get('content-type')).toBe('text/html');
    expect(idx1.headers.get('cache-control')).toBe('no-cache');
    expect(idx1.headers.get('x-frame-options')).toBe('DENY');
    expect(idx1.headers.get('content-security-policy')).toContain("default-src 'self'");
    const etagV1 = idx1.headers.get('etag')!;
    expect(etagV1).toBeTruthy();
    expect(await idx1.text()).toBe(htmlV1);

    const spa304 = await app.request('http://localhost/session/demo-123', {
      headers: { 'If-None-Match': etagV1 },
    });
    expect(spa304.status).toBe(304);
    expect(spa304.headers.get('x-frame-options')).toBe('DENY');

    const apiBuild1 = await app.request('http://localhost/api/app-build');
    expect(apiBuild1.status).toBe(200);
    expect(apiBuild1.headers.get('cache-control')).toBe('no-store');
    expect(await apiBuild1.text()).toBe(buildV1);

    // Traversal must never leak files outside webDist:
    // - %5c / %00 sequences reach resolveSafeAssetPath and return 404 directly (never SPA fallback)
    // - %2e%2e is normalized by WHATWG URL before routing, and never reads parent/secret.txt
    const trav1 = await app.request('http://localhost/%5c..%5csecret.txt');
    expect(trav1.status).toBe(404);
    expect(await trav1.text()).not.toContain('TOP_SECRET');

    const trav2 = await app.request('http://localhost/assets/%5c..%5c..%5csecret.txt');
    expect(trav2.status).toBe(404);

    const travNull = await app.request('http://localhost/index.html%00.txt');
    expect(travNull.status).toBe(404);

    const travDot = await app.request('http://localhost/%2e%2e/secret.txt');
    expect(await travDot.text()).not.toContain('TOP_SECRET');

    // Update non-hashed files on disk -> mtimeNs/size change triggers immediate cache refresh
    const htmlV2 = '<!doctype html><html><body>v2-updated</body></html>';
    const buildV2 = JSON.stringify({ buildId: 'build-2-longer' });
    writeFileSync(join(webDist, 'index.html'), htmlV2);
    writeFileSync(join(webDist, 'app-build.json'), buildV2);
    const future = new Date(Date.now() + 5000);
    utimesSync(join(webDist, 'index.html'), future, future);
    utimesSync(join(webDist, 'app-build.json'), future, future);

    const idx2 = await app.request('http://localhost/', {
      headers: { 'If-None-Match': etagV1 },
    });
    expect(idx2.status).toBe(200);
    expect(await idx2.text()).toBe(htmlV2);
    expect(idx2.headers.get('etag')).not.toBe(etagV1);

    const apiBuild2 = await app.request('http://localhost/api/app-build');
    expect(apiBuild2.status).toBe(200);
    expect(await apiBuild2.text()).toBe(buildV2);
  });

  it('streams oversized files above maxCacheableFileBytes with ETag and 304 without caching in RAM', async () => {
    const webDist = makeTempDir('imcodes-web-stream-');
    const largeAsset = Buffer.alloc(1024, 0x61);
    mkdirSync(join(webDist, 'assets'), { recursive: true });
    writeFileSync(join(webDist, 'assets', 'big-chunk.js'), largeAsset);

    process.env.WEB_DIST_PATH = webDist;
    vi.resetModules();
    const { buildApp, StaticAssetCache } = await import('../src/index.js');
    const cache = new StaticAssetCache({ maxCacheableFileBytes: 256 });
    const app = buildApp(makeEnv() as never, { staticCache: cache });

    const res = await app.request('http://localhost/assets/big-chunk.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('1024');
    const etag = res.headers.get('etag');
    expect(etag).toBeTruthy();
    expect(Buffer.from(await res.arrayBuffer()).equals(largeAsset)).toBe(true);
    expect(cache.size).toBe(0);

    const res304 = await app.request('http://localhost/assets/big-chunk.js', {
      headers: { 'If-None-Match': etag! },
    });
    expect(res304.status).toBe(304);
  });

  it('caches Landing host responses with no-cache, ETag, 304, gzip, CSP headers, and blocks traversal', async () => {
    const parent = makeTempDir('imcodes-landing-parent-');
    const landingDist = join(parent, 'landing');
    mkdirSync(landingDist, { recursive: true });
    writeFileSync(join(parent, 'secret.txt'), 'LANDING_SECRET');

    const landingHtml = `<html><body><h1>Welcome</h1><p>${'hero-copy '.repeat(150)}</p></body></html>`;
    const installScript = '#!/bin/sh\necho "install imcodes"\n';
    writeFileSync(join(landingDist, 'index.html'), landingHtml);
    writeFileSync(join(landingDist, 'install.sh'), installScript);

    process.env.LANDING_DIST_PATH = landingDist;
    vi.resetModules();
    const { buildApp } = await import('../src/index.js');
    const app = buildApp(makeEnv({ LANDING_HOST: 'im.codes' }) as never);

    const res = await app.request('http://im.codes/', {
      headers: { Host: 'im.codes', 'Accept-Encoding': 'gzip' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('vary')).toBe('Accept-Encoding');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    const etag = res.headers.get('etag')!;
    expect(gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8')).toBe(landingHtml);

    const res304 = await app.request('http://im.codes/', {
      headers: { Host: 'im.codes', 'If-None-Match': etag },
    });
    expect(res304.status).toBe(304);
    expect(res304.headers.get('x-frame-options')).toBe('DENY');

    const scriptRes = await app.request('http://im.codes/install.sh', {
      headers: { Host: 'im.codes' },
    });
    expect(scriptRes.status).toBe(200);
    expect(scriptRes.headers.get('cache-control')).toBe('no-cache');
    expect(await scriptRes.text()).toBe(installScript);

    const travRes = await app.request('http://im.codes/%5c..%5csecret.txt', {
      headers: { Host: 'im.codes' },
    });
    expect(travRes.status).toBe(404);
    expect(await travRes.text()).not.toContain('LANDING_SECRET');

    const travDotRes = await app.request('http://im.codes/%2e%2e/secret.txt', {
      headers: { Host: 'im.codes' },
    });
    expect(await travDotRes.text()).not.toContain('LANDING_SECRET');
  });

  it('streams /api/updates/:file with ETag, Last-Modified, Content-Length, and 304 support', async () => {
    const updatesDist = makeTempDir('imcodes-updates-');
    const manifest = JSON.stringify({ version: '1.2.3' });
    const bundle = Buffer.from('PK\x03\x04dummy-zip-payload-0123456789');
    writeFileSync(join(updatesDist, 'manifest.json'), manifest);
    writeFileSync(join(updatesDist, 'bundle.zip'), bundle);

    process.env.UPDATES_DIST_PATH = updatesDist;
    vi.resetModules();
    const { buildApp } = await import('../src/index.js');
    const app = buildApp(makeEnv() as never);

    const res = await app.request('http://localhost/api/updates/bundle.zip');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('content-length')).toBe(String(bundle.byteLength));
    const etag = res.headers.get('etag')!;
    const lastModified = res.headers.get('last-modified')!;
    expect(etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    expect(Date.parse(lastModified)).not.toBeNaN();
    expect(Buffer.from(await res.arrayBuffer()).equals(bundle)).toBe(true);

    // 304 via If-None-Match
    const res304Etag = await app.request('http://localhost/api/updates/bundle.zip', {
      headers: { 'If-None-Match': etag },
    });
    expect(res304Etag.status).toBe(304);
    expect(await res304Etag.text()).toBe('');

    // 304 via If-Modified-Since
    const res304Ims = await app.request('http://localhost/api/updates/bundle.zip', {
      headers: { 'If-Modified-Since': lastModified },
    });
    expect(res304Ims.status).toBe(304);

    // Reject disallowed filenames
    const badFile = await app.request('http://localhost/api/updates/other.bin');
    expect(badFile.status).toBe(404);

    // Overwriting bundle invalidates ETag
    const bundleV2 = Buffer.from('PK\x03\x04updated-zip-payload-v2');
    writeFileSync(join(updatesDist, 'bundle.zip'), bundleV2);
    const future = new Date(Date.now() + 5000);
    utimesSync(join(updatesDist, 'bundle.zip'), future, future);

    const resUpdated = await app.request('http://localhost/api/updates/bundle.zip', {
      headers: { 'If-None-Match': etag },
    });
    expect(resUpdated.status).toBe(200);
    expect(resUpdated.headers.get('etag')).not.toBe(etag);
    expect(Buffer.from(await resUpdated.arrayBuffer()).equals(bundleV2)).toBe(true);
  });
});
