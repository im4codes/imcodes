/**
 * The Windows panel window host sidecar refresh: an independent, failure-proof install that never touches the transactional self-upgrade.
 * Real temp directories; the network, Authenticode and icacls are injected, everything else (staging, verification order, swap, rollback,
 * back-off) is the product code.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AIDESK_LOCAL_UI_MANIFEST_FILENAME,
  AIDESK_LOCAL_UI_NOTICES_FILENAME,
  aideskLocalUiExecutableFileName,
} from '../../shared/aidesk-local-ui-artifact.js';
import { CONTROLLED_NODE_ARTIFACT_ASSETS } from '../../shared/controlled-node-artifacts.js';
import {
  AIDESK_LOCAL_UI_REFRESH_REASON,
  AIDESK_LOCAL_UI_REFRESH_SCHEDULE,
  nextAideskLocalUiRefreshDelayMs,
  refreshAideskLocalUiSidecar,
  startAideskLocalUiSidecarRefresh,
} from '../../src/node/aidesk-local-ui-sidecar.js';
import { resolveVerifiedAideskLocalUi } from '../../src/node/aidesk-local-ui-artifact.js';

const SIGNER = 'cd'.repeat(32);
const temps: string[] = [];
const temp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'aidesk-sidecar-')); temps.push(dir); return dir; };
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Published { exe: Buffer; version: string; manifest?: Record<string, unknown> }
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const manifestFor = (p: Published): Record<string, unknown> => ({
  schemaVersion: 1, artifact: 'aidesk-local-ui.exe', os: 'win32', arch: 'x64', version: p.version, size: p.exe.length, sha256: sha(p.exe), signerSha256: SIGNER, ...p.manifest,
});

/** A fake of the server's three fixed files; `undefined` = nothing published (404 => the download helper answers undefined). */
function fakeDownload(published: Published | undefined, calls: string[]) {
  return async (input: { dir: string; asset: string; expectedFileName: string; maxBytes: number }) => {
    calls.push(input.asset);
    if (!published) return undefined;
    const bytes = input.asset === CONTROLLED_NODE_ARTIFACT_ASSETS.AIDESK_LOCAL_UI
      ? published.exe
      : input.asset === CONTROLLED_NODE_ARTIFACT_ASSETS.AIDESK_LOCAL_UI_MANIFEST
        ? Buffer.from(JSON.stringify(manifestFor(published)))
        : Buffer.from('WebView2 licence');
    if (bytes.length > input.maxBytes) throw new Error('artifact_too_large');
    mkdirSync(input.dir, { recursive: true });
    const artifactPath = join(input.dir, input.expectedFileName);
    writeFileSync(artifactPath, bytes);
    return { artifactPath, sha256: sha(bytes), sizeBytes: bytes.length };
  };
}

function setup(published: Published | undefined) {
  const root = temp();
  const calls: string[] = [];
  const locked: string[] = [];
  const deps = {
    credential: { serverId: 's', token: 't', serverUrl: 'https://example.test' },
    platform: 'win32' as NodeJS.Platform,
    arch: 'x64',
    root,
    fetchImpl: (() => { throw new Error('network must not be used directly'); }) as unknown as typeof fetch,
    download: fakeDownload(published, calls) as never,
    lockDown: async (directory: string) => { locked.push(directory); },
    // the REAL verification rules, with Authenticode stubbed to "signed by the trusted release signer"
    verify: (directory: string) => resolveVerifiedAideskLocalUi({
      execPath: join(directory, 'imcodes-node.exe'), platform: 'win32', arch: 'x64', trustedWindowsSignerSha256: SIGNER, verifySigners: async () => true,
    }),
  };
  const finalDirectory = join(root, 'aidesk-local-ui', 'win32-x64');
  return { root, calls, locked, deps, finalDirectory };
}

describe('refreshAideskLocalUiSidecar', () => {
  it('installs a verified, locked-down copy atomically and leaves no staging directory behind', async () => {
    const v1: Published = { exe: Buffer.from('MZ-host-v1'), version: '2026.10.1' };
    const { root, deps, finalDirectory, locked, calls } = setup(v1);
    const result = await refreshAideskLocalUiSidecar(deps);
    expect(result).toMatchObject({ updated: true, reason: 'updated', targetVersion: '2026.10.1' });
    expect(readdirSync(finalDirectory).sort()).toEqual([AIDESK_LOCAL_UI_MANIFEST_FILENAME, AIDESK_LOCAL_UI_NOTICES_FILENAME, aideskLocalUiExecutableFileName('win32')].sort());
    expect(readFileSync(join(finalDirectory, 'aidesk-local-ui.exe'))).toEqual(v1.exe);
    // the manifest was fetched first, the executable only after it, and everything was locked down BEFORE the swap
    expect(calls).toEqual(['aidesk-local-ui-manifest', 'aidesk-local-ui', 'aidesk-local-ui-notices']);
    expect(locked.length).toBeGreaterThanOrEqual(2);
    expect(readdirSync(root).filter((name) => name.startsWith('.aidesk-local-ui-refresh-'))).toEqual([]);
    // what is installed is what the node's own launch-time verification accepts
    expect(await deps.verify(root)).toBe(join(finalDirectory, 'aidesk-local-ui.exe'));
  });

  it('is a no-op when the installed copy is already that build, and repairs it when the installed file no longer verifies', async () => {
    const v1: Published = { exe: Buffer.from('MZ-host-v1'), version: '2026.10.1' };
    const { deps, finalDirectory, calls } = setup(v1);
    await refreshAideskLocalUiSidecar(deps);
    calls.length = 0;
    expect(await refreshAideskLocalUiSidecar(deps)).toMatchObject({ updated: false, reason: 'current' });
    expect(calls).toEqual(['aidesk-local-ui-manifest']); // nothing but the small manifest was downloaded
    writeFileSync(join(finalDirectory, 'aidesk-local-ui.exe'), 'MZ-tampered!!');
    calls.length = 0;
    expect(await refreshAideskLocalUiSidecar(deps)).toMatchObject({ updated: true, reason: 'updated' });
    expect(readFileSync(join(finalDirectory, 'aidesk-local-ui.exe'))).toEqual(v1.exe);
  });

  it('updates to a newer build keeping the previous directory, and refuses a downgrade', async () => {
    const v1: Published = { exe: Buffer.from('MZ-host-v1'), version: '2026.10.1' };
    const first = setup(v1);
    await refreshAideskLocalUiSidecar(first.deps);
    const v2: Published = { exe: Buffer.from('MZ-host-v2-longer'), version: '2026.10.2' };
    const updated = await refreshAideskLocalUiSidecar({ ...first.deps, download: fakeDownload(v2, []) as never });
    expect(updated).toMatchObject({ updated: true, installedVersion: '2026.10.1', targetVersion: '2026.10.2' });
    expect(readFileSync(join(first.finalDirectory, 'aidesk-local-ui.exe'))).toEqual(v2.exe);
    expect(readFileSync(join(first.finalDirectory + '.previous', 'aidesk-local-ui.exe'))).toEqual(v1.exe);
    const older = await refreshAideskLocalUiSidecar({ ...first.deps, download: fakeDownload({ exe: Buffer.from('MZ-old'), version: '2026.9.9' }, []) as never });
    expect(older).toMatchObject({ updated: false, reason: 'downgrade_rejected' });
    expect(readFileSync(join(first.finalDirectory, 'aidesk-local-ui.exe'))).toEqual(v2.exe);
  });

  it('installs nothing for a bad manifest, a wrong hash, a wrong signer or an unverifiable file; an installed copy is never replaced by a bad one', async () => {
    const good: Published = { exe: Buffer.from('MZ-host-v1'), version: '2026.10.1' };
    const base = setup(good);
    await refreshAideskLocalUiSidecar(base.deps);
    const cases: Array<[string, Published, string]> = [
      ['a hash that is not the file\'s', { exe: Buffer.from('MZ-host-v2'), version: '2026.10.2', manifest: { sha256: 'ab'.repeat(32) } }, 'verification_failed'],
      // a manifest that promises fewer bytes than the file has: the download is capped at the promise and refuses the larger file
      ['a size smaller than the file\'s', { exe: Buffer.from('MZ-host-v2'), version: '2026.10.2', manifest: { size: 3 } }, 'download_failed'],
      ['a size larger than the file\'s', { exe: Buffer.from('MZ-host-v2'), version: '2026.10.2', manifest: { size: 300 } }, 'verification_failed'],
      ['another signer', { exe: Buffer.from('MZ-host-v2'), version: '2026.10.2', manifest: { signerSha256: 'ee'.repeat(32) } }, 'verification_failed'],
      ['an unknown extra field', { exe: Buffer.from('MZ-host-v2'), version: '2026.10.2', manifest: { extra: 1 } }, 'manifest_invalid'],
      ['a manifest of another platform', { exe: Buffer.from('MZ-host-v2'), version: '2026.10.2', manifest: { os: 'linux' } }, 'manifest_invalid'],
    ];
    for (const [label, published, reason] of cases) {
      const result = await refreshAideskLocalUiSidecar({ ...base.deps, download: fakeDownload(published, []) as never });
      expect(result, label).toMatchObject({ updated: false, reason });
      expect(readFileSync(join(base.finalDirectory, 'aidesk-local-ui.exe')), label).toEqual(good.exe);
    }
    // Authenticode refusing the staged file
    const unsigned = await refreshAideskLocalUiSidecar({
      ...base.deps,
      download: fakeDownload({ exe: Buffer.from('MZ-host-v3'), version: '2026.10.3' }, []) as never,
      verify: (directory: string) => resolveVerifiedAideskLocalUi({ execPath: join(directory, 'imcodes-node.exe'), platform: 'win32', arch: 'x64', trustedWindowsSignerSha256: SIGNER, verifySigners: async () => false }),
    });
    expect(unsigned).toMatchObject({ updated: false, reason: 'verification_failed' });
    expect(readFileSync(join(base.finalDirectory, 'aidesk-local-ui.exe'))).toEqual(good.exe);
    expect(readdirSync(base.root).filter((name) => name.startsWith('.aidesk-local-ui-refresh-'))).toEqual([]);
  });

  it('skew: nothing published (older server / not built) skips quietly and installs nothing; other platforms do nothing at all', async () => {
    const none = setup(undefined);
    expect(await refreshAideskLocalUiSidecar(none.deps)).toMatchObject({ updated: false, reason: 'not_published' });
    expect(existsSync(none.finalDirectory)).toBe(false);
    expect(none.calls).toEqual(['aidesk-local-ui-manifest']);
    for (const platform of ['linux', 'darwin'] as const) {
      const other = setup({ exe: Buffer.from('MZ'), version: '1' });
      expect(await refreshAideskLocalUiSidecar({ ...other.deps, platform })).toMatchObject({ updated: false, reason: 'unsupported_platform' });
      expect(other.calls).toEqual([]);
    }
    expect(await refreshAideskLocalUiSidecar({ ...setup({ exe: Buffer.from('MZ'), version: '1' }).deps, arch: 'arm64' })).toMatchObject({ reason: 'unsupported_platform' });
  });

  it('a failing lock-down installs nothing; a failing swap puts the previous directory back (a running host keeps its directory locked)', async () => {
    const v1: Published = { exe: Buffer.from('MZ-host-v1'), version: '2026.10.1' };
    const fresh = setup(v1);
    const refused = await refreshAideskLocalUiSidecar({ ...fresh.deps, lockDown: async () => { throw new Error('icacls failed'); } });
    expect(refused).toMatchObject({ updated: false, reason: 'acl_failed' });
    expect(existsSync(fresh.finalDirectory)).toBe(false);

    const base = setup(v1);
    await refreshAideskLocalUiSidecar(base.deps);
    const v2: Published = { exe: Buffer.from('MZ-host-v2-xx'), version: '2026.10.2' };
    let renames = 0;
    const result = await refreshAideskLocalUiSidecar({
      ...base.deps,
      download: fakeDownload(v2, []) as never,
      rename: (async (from: string, to: string) => {
        renames += 1;
        // the first rename (final -> .previous) works, the second (staged -> final) fails like a locked directory
        if (renames === 2) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
        const { rename } = await import('node:fs/promises');
        return rename(from, to);
      }) as never,
    });
    expect(result).toMatchObject({ updated: false, reason: 'host_in_use' });
    expect(readFileSync(join(base.finalDirectory, 'aidesk-local-ui.exe'))).toEqual(v1.exe); // restored
  });

  it('an unexpected error (the network) is a reason, not a throw, and cleans up its staging', async () => {
    const base = setup({ exe: Buffer.from('MZ'), version: '1' });
    const result = await refreshAideskLocalUiSidecar({ ...base.deps, download: (async () => { throw new Error('download_failed_500'); }) as never });
    expect(result).toMatchObject({ updated: false, reason: 'download_failed' });
    expect(readdirSync(base.root).filter((name) => name.startsWith('.aidesk-local-ui-refresh-'))).toEqual([]);
  });
});

describe('the refresh schedule', () => {
  it('settled outcomes recur every six hours; failures back off 15 min, 30 min, 1 h, 2 h, 4 h and never exceed the settled interval (no restart loops)', () => {
    const settled = AIDESK_LOCAL_UI_REFRESH_SCHEDULE.settledIntervalMs;
    for (const reason of ['updated', 'current', 'not_published', 'unsupported_platform', 'downgrade_rejected'] as const) expect(nextAideskLocalUiRefreshDelayMs(reason, 0)).toBe(settled);
    const minutes = [1, 2, 3, 4, 5, 6, 7].map((failures) => nextAideskLocalUiRefreshDelayMs(AIDESK_LOCAL_UI_REFRESH_REASON.DOWNLOAD_FAILED, failures) / 60_000);
    expect(minutes).toEqual([15, 30, 60, 120, 240, 360, 360]);
  });

  it('starts on Windows x64 only, first after a delay, re-arms after each run with the right delay, survives a throwing refresh, and stops', async () => {
    const armed: Array<{ ms: number; run: () => void }> = [];
    const cleared: unknown[] = [];
    const schedule = (run: () => void, ms: number) => { const handle = { unref() {} }; armed.push({ ms, run }); return handle; };
    const outcomes: Array<'throw' | 'fail' | 'ok'> = ['throw', 'fail', 'ok'];
    const refresh = async () => {
      const next = outcomes.shift();
      if (next === 'throw') throw new Error('boom');
      return next === 'fail' ? { updated: false, reason: 'download_failed' as const } : { updated: true, reason: 'updated' as const };
    };
    const deps = { credential: { serverId: 's', token: 't', serverUrl: 'https://example.test' }, platform: 'win32' as NodeJS.Platform, arch: 'x64' };
    const stop = startAideskLocalUiSidecarRefresh(deps, { refresh: refresh as never, schedule, clear: (handle) => cleared.push(handle) });
    expect(armed.map((entry) => entry.ms)).toEqual([AIDESK_LOCAL_UI_REFRESH_SCHEDULE.initialDelayMs]);
    armed[0]!.run(); await new Promise((r) => setTimeout(r, 0));
    armed[1]!.run(); await new Promise((r) => setTimeout(r, 0));
    armed[2]!.run(); await new Promise((r) => setTimeout(r, 0));
    expect(armed.map((entry) => entry.ms / 60_000)).toEqual([1.5, 15, 30, 360]); // throw -> 15, second failure -> 30, success -> 6 h
    stop();
    expect(cleared.length).toBe(1);
    const other = startAideskLocalUiSidecarRefresh({ ...deps, platform: 'linux' }, { refresh: refresh as never, schedule });
    expect(armed.length).toBe(4); // nothing armed for another platform
    other();
  });
});
