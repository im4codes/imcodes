/**
 * The shipped native aiDesk window: its manifest contract, the build scripts that write/verify it, the pinned-source fetch, and the node
 * check that refuses anything unverified. Real files in temp directories; only the OS signature checks are injected.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AIDESK_LOCAL_UI_MANIFEST_FILENAME,
  AIDESK_LOCAL_UI_MANIFEST_SCHEMA_VERSION,
  AIDESK_LOCAL_UI_VERIFIED_FILENAME,
  validateAideskLocalUiVerifiedRecord,
  wholeMillisecondsOfNanoseconds,
  aideskLocalUiArtifactRelativeDirectory,
  aideskLocalUiExecutableFileName,
  validateAideskLocalUiManifest,
} from '../../shared/aidesk-local-ui-artifact.js';
import { lstatFileIdentity, resolveVerifiedAideskLocalUi, resolveVerifiedAideskLocalUiDetailed } from '../../src/node/aidesk-local-ui-artifact.js';
// @ts-expect-error plain .mjs build script
import * as artifactScript from '../../scripts/aidesk-ui-artifact.mjs';
// @ts-expect-error plain .mjs build script

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'imcodes-localpanel-tsk_7263ca54b1-')); roots.push(dir); return dir; };
const SIGNER = 'ab'.repeat(32);
const noRecord = { writeVerifiedRecord: () => undefined };

/** <execDir>/aidesk-local-ui/<os>-<arch>/ with an executable and a manifest written by the real script. */
function install(os: 'linux' | 'win32', arch: 'x64' | 'arm64' = 'x64', content = 'MZ-fake-executable') {
  const execDir = temp();
  const directory = join(execDir, aideskLocalUiArtifactRelativeDirectory(os, arch));
  mkdirSync(directory, { recursive: true });
  const executable = join(directory, aideskLocalUiExecutableFileName(os));
  writeFileSync(executable, content);
  chmodSync(executable, 0o755);
  artifactScript.writeManifest({ dir: directory, os, arch, version: '2026.10.1', ...(os === 'win32' ? { signerSha256: SIGNER } : {}) });
  return { execDir, directory, executable, execPath: join(execDir, os === 'win32' ? 'imcodes-node.exe' : 'imcodes-node-linux') };
}

describe('manifest contract', () => {
  it('the build script mirrors the shared constants and writes a manifest the node validator accepts', () => {
    expect(artifactScript.AIDESK_LOCAL_UI_MANIFEST_FILENAME).toBe(AIDESK_LOCAL_UI_MANIFEST_FILENAME);
    expect(artifactScript.AIDESK_LOCAL_UI_MANIFEST_SCHEMA_VERSION).toBe(AIDESK_LOCAL_UI_MANIFEST_SCHEMA_VERSION);
    for (const os of ['win32', 'darwin', 'linux'] as const) expect(artifactScript.executableFileName(os)).toBe(aideskLocalUiExecutableFileName(os));
    const { directory } = install('linux');
    const manifest = JSON.parse(readFileSync(join(directory, AIDESK_LOCAL_UI_MANIFEST_FILENAME), 'utf8'));
    expect(validateAideskLocalUiManifest(manifest, { os: 'linux', arch: 'x64' })).toMatchObject({ version: '2026.10.1', artifact: 'aidesk-local-ui' });
    expect(artifactScript.verifyManifest({ dir: directory, os: 'linux', arch: 'x64', version: '2026.10.1' })).toMatchObject({ os: 'linux' });
    expect(() => artifactScript.verifyManifest({ dir: directory, os: 'linux', arch: 'x64', version: 'other' })).toThrow();
  });

  it('the validator is strict: wrong platform, extra or missing fields, bad hash, bad size and a missing Windows signer are all refused', () => {
    const good = { schemaVersion: 1, artifact: 'aidesk-local-ui', os: 'linux', arch: 'x64', version: '1.2.3', size: 10, sha256: 'a'.repeat(64) };
    expect(validateAideskLocalUiManifest(good, { os: 'linux', arch: 'x64' })).not.toBeNull();
    for (const bad of [
      { ...good, os: 'darwin' }, { ...good, arch: 'arm64' }, { ...good, extra: 1 }, { ...good, sha256: 'A'.repeat(64) }, { ...good, sha256: 'a'.repeat(63) },
      { ...good, size: 0 }, { ...good, size: -1 }, { ...good, size: 1.5 }, { ...good, size: 512 * 1024 * 1024 }, { ...good, artifact: 'other' },
      { ...good, version: '' }, { ...good, version: '../x' }, { ...good, schemaVersion: 2 }, { ...good, signerSha256: 'zz' },
    ]) expect(validateAideskLocalUiManifest(bad, { os: 'linux', arch: 'x64' }), JSON.stringify(bad)).toBeNull();
    const win = { ...good, os: 'win32', artifact: 'aidesk-local-ui.exe' };
    expect(validateAideskLocalUiManifest(win, { os: 'win32', arch: 'x64' })).toBeNull(); // no signer named
    expect(validateAideskLocalUiManifest({ ...win, signerSha256: SIGNER }, { os: 'win32', arch: 'x64' })).not.toBeNull();
    for (const junk of [null, 'x', 3, [], undefined]) expect(validateAideskLocalUiManifest(junk, { os: 'linux', arch: 'x64' })).toBeNull();
  });

  it('writing refuses a Windows build with no signer, a non-regular file and a bad target', () => {
    const directory = temp();
    writeFileSync(join(directory, 'aidesk-local-ui.exe'), 'x');
    expect(() => artifactScript.buildManifest({ dir: directory, os: 'win32', arch: 'x64', version: '1' })).toThrow();
    expect(() => artifactScript.buildManifest({ dir: directory, os: 'plan9', arch: 'x64', version: '1' })).toThrow();
    const linkDirectory = temp();
    writeFileSync(join(linkDirectory, 'real'), 'x');
    symlinkSync(join(linkDirectory, 'real'), join(linkDirectory, 'aidesk-local-ui'));
    expect(() => artifactScript.buildManifest({ dir: linkDirectory, os: 'linux', arch: 'x64', version: '1' })).toThrow();
  });
});

describe('the node only uses a native window that verifies', () => {
  const base = { platform: 'linux' as NodeJS.Platform, arch: 'x64' };

  it('Linux: a matching executable + manifest verifies; nothing, a tampered file, a different size, a symlink or a wrong-platform manifest do not', async () => {
    const ok = install('linux');
    expect(await resolveVerifiedAideskLocalUi({ ...noRecord, ...base, execPath: ok.execPath })).toBe(ok.executable);
    expect(await resolveVerifiedAideskLocalUi({ ...noRecord, ...base, execPath: join(temp(), 'imcodes-node-linux') })).toBeUndefined();
    writeFileSync(ok.executable, 'MZ-fake-executable-TAMPERED');
    expect(await resolveVerifiedAideskLocalUi({ ...noRecord, ...base, execPath: ok.execPath })).toBeUndefined();
    const sameSizeTamper = install('linux');
    writeFileSync(sameSizeTamper.executable, 'XX-fake-executable');
    expect(await resolveVerifiedAideskLocalUi({ ...noRecord, ...base, execPath: sameSizeTamper.execPath })).toBeUndefined();
    const linked = install('linux');
    rmSync(linked.executable);
    writeFileSync(join(linked.directory, 'real'), 'MZ-fake-executable');
    symlinkSync(join(linked.directory, 'real'), linked.executable);
    expect(await resolveVerifiedAideskLocalUi({ ...noRecord, ...base, execPath: linked.execPath })).toBeUndefined();
    const wrongPlatform = install('linux');
    const manifestPath = join(wrongPlatform.directory, AIDESK_LOCAL_UI_MANIFEST_FILENAME);
    writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace('"linux"', '"darwin"'));
    expect(await resolveVerifiedAideskLocalUi({ ...noRecord, ...base, execPath: wrongPlatform.execPath })).toBeUndefined();
    const garbage = install('linux');
    writeFileSync(join(garbage.directory, AIDESK_LOCAL_UI_MANIFEST_FILENAME), 'not json');
    expect(await resolveVerifiedAideskLocalUi({ ...noRecord, ...base, execPath: garbage.execPath })).toBeUndefined();
    expect(await resolveVerifiedAideskLocalUi({ ...noRecord, platform: 'linux', arch: 'ia32', execPath: ok.execPath })).toBeUndefined();
    expect(await resolveVerifiedAideskLocalUi({ ...noRecord, platform: 'freebsd', arch: 'x64', execPath: ok.execPath })).toBeUndefined();
  });

  it('Windows additionally needs the release signer: a dev runtime (no trust anchor), a different signer or a failing Authenticode check refuse it', async () => {
    const installed = install('win32');
    const win = { platform: 'win32' as NodeJS.Platform, arch: 'x64', execPath: installed.execPath };
    expect(await resolveVerifiedAideskLocalUi({ ...noRecord, ...win, trustedWindowsSignerSha256: SIGNER, verifySigners: async () => true })).toBe(installed.executable);
    expect(await resolveVerifiedAideskLocalUi({ ...noRecord, ...win, trustedWindowsSignerSha256: '', verifySigners: async () => true })).toBeUndefined();
    expect(await resolveVerifiedAideskLocalUi({ ...noRecord, ...win, trustedWindowsSignerSha256: 'cd'.repeat(32), verifySigners: async () => true })).toBeUndefined();
    expect(await resolveVerifiedAideskLocalUi({ ...noRecord, ...win, trustedWindowsSignerSha256: SIGNER, verifySigners: async () => false })).toBeUndefined();
    expect(await resolveVerifiedAideskLocalUi({ ...noRecord, ...win, trustedWindowsSignerSha256: SIGNER, verifySigners: async () => { throw new Error('powershell failed'); } })).toBeUndefined();
  });

  it('macOS: the helper inside the signed app, and only when its code signature verifies', async () => {
    const helper = join(temp(), 'aidesk-local-ui');
    writeFileSync(helper, 'x');
    const mac = { platform: 'darwin' as NodeJS.Platform, arch: 'arm64', macosHelperPath: helper };
    expect(await resolveVerifiedAideskLocalUi({ ...mac, codesignVerifies: async () => true })).toBe(helper);
    const unsigned = join(temp(), 'aidesk-local-ui');
    writeFileSync(unsigned, 'x');
    expect(await resolveVerifiedAideskLocalUi({ ...mac, macosHelperPath: unsigned, codesignVerifies: async () => false })).toBeUndefined();
    expect(await resolveVerifiedAideskLocalUi({ ...mac, macosHelperPath: join(temp(), 'missing'), codesignVerifies: async () => true })).toBeUndefined();
  });

  it('macOS: the code signature of an unchanged helper is checked once per process, and again when the helper changes', async () => {
    const helper = join(temp(), 'aidesk-local-ui');
    writeFileSync(helper, 'x');
    let checks = 0;
    const mac = { platform: 'darwin' as NodeJS.Platform, arch: 'arm64', macosHelperPath: helper, codesignVerifies: async () => { checks += 1; return true; } };
    expect(await resolveVerifiedAideskLocalUiDetailed(mac)).toMatchObject({ path: helper, source: 'full' });
    for (let click = 0; click < 4; click += 1) expect(await resolveVerifiedAideskLocalUiDetailed(mac)).toMatchObject({ source: 'record' });
    expect(checks).toBe(1);
    writeFileSync(helper, 'a different, longer helper');
    expect(await resolveVerifiedAideskLocalUiDetailed(mac)).toMatchObject({ source: 'full' });
    expect(checks).toBe(2);
    // a failed check is never remembered
    const bad = join(temp(), 'aidesk-local-ui');
    writeFileSync(bad, 'y');
    let attempts = 0;
    const failing = { ...mac, macosHelperPath: bad, codesignVerifies: async () => { attempts += 1; return false; } };
    expect(await resolveVerifiedAideskLocalUiDetailed(failing)).toBeUndefined();
    expect(await resolveVerifiedAideskLocalUiDetailed(failing)).toBeUndefined();
    expect(attempts).toBe(2);
  });
});

describe('the proof of a full verification (not repeated on every open)', () => {
  const win = (installed: ReturnType<typeof install>) => ({ platform: 'win32' as NodeJS.Platform, arch: 'x64', execPath: installed.execPath, trustedWindowsSignerSha256: SIGNER });
  /** Counts the expensive steps; the signer check can be made to fail. */
  function counters(signerOk = () => true) {
    const calls = { hash: [] as string[], signer: 0, read: [] as string[] };
    return {
      calls,
      deps: {
        hashFile: async (path: string) => { calls.hash.push(path); return createHash('sha256').update(readFileSync(path)).digest('hex'); },
        verifySigners: async () => { calls.signer += 1; return signerOk(); },
        readFile: (path: string) => { calls.read.push(path); return readFileSync(path); },
      },
    };
  }

  it('the first open verifies in full and leaves the proof; the next ones only compare size and last write time', async () => {
    const installed = install('win32');
    const { calls, deps } = counters();
    const first = await resolveVerifiedAideskLocalUiDetailed({ ...win(installed), ...deps });
    expect(first).toMatchObject({ path: installed.executable, source: 'full', size: statSync(installed.executable).size });
    expect(calls.hash).toEqual([installed.executable]);
    expect(calls.signer).toBe(1);
    const recordPath = join(installed.directory, AIDESK_LOCAL_UI_VERIFIED_FILENAME);
    expect(validateAideskLocalUiVerifiedRecord(JSON.parse(readFileSync(recordPath, 'utf8')))).toMatchObject({ signerSha256: SIGNER });
    for (let click = 0; click < 5; click += 1) {
      expect(await resolveVerifiedAideskLocalUiDetailed({ ...win(installed), ...deps })).toMatchObject({ path: installed.executable, source: 'record' });
    }
    // Five more opens: not one more hash, not one more signature check, and the executable itself was never read.
    expect(calls.hash).toHaveLength(1);
    expect(calls.signer).toBe(1);
    expect(calls.read.every((path) => path !== installed.executable)).toBe(true);
  });

  it('a changed file is verified in full again: a new last write time, a different size, other content, another manifest', async () => {
    const installed = install('win32');
    const { calls, deps } = counters();
    await resolveVerifiedAideskLocalUiDetailed({ ...win(installed), ...deps });
    // Same bytes, touched: the proof no longer describes "that file as it was verified", so it is checked again (and still passes).
    const later = new Date(Date.now() + 60_000);
    utimesSync(installed.executable, later, later);
    expect(await resolveVerifiedAideskLocalUiDetailed({ ...win(installed), ...deps })).toMatchObject({ source: 'full' });
    expect(calls.hash).toHaveLength(2);
    expect(await resolveVerifiedAideskLocalUiDetailed({ ...win(installed), ...deps })).toMatchObject({ source: 'record' });
    // Other bytes with a new time (manifest still describes the old build): refused, and the stale proof does not rescue it.
    writeFileSync(installed.executable, 'MZ-fake-executable'.replace('fake', 'evil'));
    const evenLater = new Date(Date.now() + 120_000);
    utimesSync(installed.executable, evenLater, evenLater);
    expect(await resolveVerifiedAideskLocalUiDetailed({ ...win(installed), ...deps })).toBeUndefined();
    // A new build with its own manifest: the old proof names another sha256.
    const rebuilt = install('win32', 'x64', 'MZ-a-different-build');
    writeFileSync(join(rebuilt.directory, AIDESK_LOCAL_UI_VERIFIED_FILENAME), readFileSync(join(installed.directory, AIDESK_LOCAL_UI_VERIFIED_FILENAME)));
    const rebuiltCounters = counters();
    expect(await resolveVerifiedAideskLocalUiDetailed({ ...win(rebuilt), ...rebuiltCounters.deps })).toMatchObject({ source: 'full' });
    expect(rebuiltCounters.calls.hash).toHaveLength(1);
  });

  it('a proof is never trusted beyond what it records: another trust anchor, a failing signer check, a corrupt, forged or oversized file', async () => {
    const installed = install('win32');
    await resolveVerifiedAideskLocalUiDetailed({ ...win(installed), ...counters().deps });
    const recordPath = join(installed.directory, AIDESK_LOCAL_UI_VERIFIED_FILENAME);
    // Another compiled trust anchor (the old proof was made against SIGNER): verified against the new one in full, which fails here.
    const other = counters(() => false);
    expect(await resolveVerifiedAideskLocalUiDetailed({ ...win(installed), trustedWindowsSignerSha256: 'cd'.repeat(32), ...other.deps })).toBeUndefined();
    expect(await resolveVerifiedAideskLocalUiDetailed({ ...win(installed), trustedWindowsSignerSha256: '', ...other.deps })).toBeUndefined();
    const good = readFileSync(recordPath, 'utf8');
    const failing = counters(() => false);
    for (const forged of ['not json', '{}', JSON.stringify({ ...JSON.parse(good), sha256: 'f'.repeat(64) }), JSON.stringify({ ...JSON.parse(good), size: 1 }), JSON.stringify({ ...JSON.parse(good), extra: true }), `${good}${' '.repeat(5000)}`]) {
      writeFileSync(recordPath, forged);
      // The forged proof is ignored: the full verification runs (and, with a signer check that fails, refuses).
      expect(await resolveVerifiedAideskLocalUiDetailed({ ...win(installed), ...noRecord, ...failing.deps }), forged.slice(0, 40)).toBeUndefined();
    }
    expect(failing.calls.signer).toBe(6);
    // A proof for a file whose manifest is gone or invalid is no proof either.
    writeFileSync(recordPath, good);
    writeFileSync(join(installed.directory, AIDESK_LOCAL_UI_MANIFEST_FILENAME), 'not json');
    expect(await resolveVerifiedAideskLocalUiDetailed({ ...win(installed), ...counters().deps })).toBeUndefined();
  });

  it('the executable is hashed without holding the event loop, and leaving the proof is best effort', async () => {
    const installed = install('linux', 'x64', 'x'.repeat(3 * 1024 * 1024));
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 1);
    try {
      // The default hasher streams the file: timers keep running while it reads (a synchronous 3 MiB read + hash would not yield).
      const result = await resolveVerifiedAideskLocalUiDetailed({ platform: 'linux', arch: 'x64', execPath: installed.execPath, writeVerifiedRecord: () => { throw new Error('read-only directory'); } });
      expect(result).toMatchObject({ path: installed.executable, source: 'full' });
    } finally { clearInterval(timer); }
    expect(ticks).toBeGreaterThan(0);
    expect(existsSync(join(installed.directory, AIDESK_LOCAL_UI_VERIFIED_FILENAME))).toBe(false);
    // A user process (no write access) simply verifies again next time.
    expect(await resolveVerifiedAideskLocalUiDetailed({ platform: 'linux', arch: 'x64', execPath: installed.execPath, writeVerifiedRecord: () => undefined })).toMatchObject({ source: 'full' });
  });

  it('a file swapped while it is being verified is refused and leaves no proof', async () => {
    const installed = install('linux');
    const swapped = await resolveVerifiedAideskLocalUiDetailed({
      platform: 'linux', arch: 'x64', execPath: installed.execPath,
      hashFile: async (path) => {
        const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
        const later = new Date(Date.now() + 90_000);
        utimesSync(path, later, later);
        return digest;
      },
    });
    expect(swapped).toBeUndefined();
    expect(existsSync(join(installed.directory, AIDESK_LOCAL_UI_VERIFIED_FILENAME))).toBe(false);
  });
});

describe('a file\'s write time is the same whole milliseconds for the node and for the launch script', () => {
  it('truncates the exact nanoseconds (like PowerShell truncates 100 ns ticks), never rounding up to the next millisecond', () => {
    // 123 ms and 999 999 ns: a floating-point millisecond (or a Number of the nanoseconds) rounds this to ...124, truncation does not.
    const justBelow = 1_790_000_000_123_999_999n;
    expect(wholeMillisecondsOfNanoseconds(justBelow)).toBe(1_790_000_000_123);
    expect(Math.floor(Number(justBelow) / 1e6)).toBe(1_790_000_000_124); // what the earlier, floating-point reduction produced
    // The same file as Windows stores it (100 ns ticks): ticks -> ms by integer division is exactly what ToUnixTimeMilliseconds does.
    const ticksOfFile = 17_900_000_001_239_999n; // 100 ns units since the epoch
    expect(wholeMillisecondsOfNanoseconds(ticksOfFile * 100n)).toBe(Number(ticksOfFile / 10_000n));
    expect(wholeMillisecondsOfNanoseconds(0n)).toBe(0);
    expect(wholeMillisecondsOfNanoseconds(999_999n)).toBe(0);
    expect(wholeMillisecondsOfNanoseconds(1_000_000n)).toBe(1);
  });

  it('lstat reports an integer millisecond taken from the exact stat of a real file with a sub-millisecond write time', () => {
    const dir = temp();
    const path = join(dir, 'f');
    writeFileSync(path, 'x');
    utimesSync(path, 1_790_000_000, 1_790_000_000.1239996);
    const exact = statSync(path, { bigint: true });
    const identity = lstatFileIdentity(path)!;
    expect(Number.isInteger(identity.mtimeMs)).toBe(true);
    expect(identity.mtimeMs).toBe(Number(exact.mtimeNs / 1_000_000n));
    expect(identity.size).toBe(1);
    expect(identity.isFile()).toBe(true);
    expect(lstatFileIdentity(join(dir, 'missing'))).toBeUndefined();
  });
});
