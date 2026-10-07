/**
 * The shipped native aiDesk window: its manifest contract, the build scripts that write/verify it, the pinned-source fetch, and the node
 * check that refuses anything unverified. Real files in temp directories; only the OS signature checks are injected.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AIDESK_LOCAL_UI_MANIFEST_FILENAME,
  AIDESK_LOCAL_UI_MANIFEST_SCHEMA_VERSION,
  aideskLocalUiArtifactRelativeDirectory,
  aideskLocalUiExecutableFileName,
  validateAideskLocalUiManifest,
} from '../../shared/aidesk-local-ui-artifact.js';
import { readAideskLocalUiExpectedSha256, resolveVerifiedAideskLocalUi } from '../../src/node/aidesk-local-ui-artifact.js';
// @ts-expect-error plain .mjs build script
import * as artifactScript from '../../scripts/aidesk-ui-artifact.mjs';
// @ts-expect-error plain .mjs build script

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'imcodes-localpanel-tsk_7263ca54b1-')); roots.push(dir); return dir; };
const SIGNER = 'ab'.repeat(32);

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

describe('the hash the launch script re-checks', () => {
  it('is the manifest\'s sha256 for the installed executable, and nothing when the manifest is missing, unreadable or invalid', () => {
    const ok = install('win32');
    const wanted = createHash('sha256').update('MZ-fake-executable').digest('hex');
    expect(readAideskLocalUiExpectedSha256(ok.executable, { platform: 'win32', arch: 'x64' })).toBe(wanted);
    expect(readAideskLocalUiExpectedSha256(ok.executable, { platform: 'linux', arch: 'x64' })).toBeUndefined(); // a manifest of another platform
    expect(readAideskLocalUiExpectedSha256(join(temp(), 'aidesk-local-ui.exe'), { platform: 'win32', arch: 'x64' })).toBeUndefined();
    writeFileSync(join(ok.directory, 'aidesk-local-ui.manifest.json'), '{"not":"a manifest"}');
    expect(readAideskLocalUiExpectedSha256(ok.executable, { platform: 'win32', arch: 'x64' })).toBeUndefined();
  });
});

describe('the node only uses a native window that verifies', () => {
  const base = { platform: 'linux' as NodeJS.Platform, arch: 'x64' };

  it('Linux: a matching executable + manifest verifies; nothing, a tampered file, a different size, a symlink or a wrong-platform manifest do not', async () => {
    const ok = install('linux');
    expect(await resolveVerifiedAideskLocalUi({ ...base, execPath: ok.execPath })).toBe(ok.executable);
    expect(await resolveVerifiedAideskLocalUi({ ...base, execPath: join(temp(), 'imcodes-node-linux') })).toBeUndefined();
    writeFileSync(ok.executable, 'MZ-fake-executable-TAMPERED');
    expect(await resolveVerifiedAideskLocalUi({ ...base, execPath: ok.execPath })).toBeUndefined();
    const sameSizeTamper = install('linux');
    writeFileSync(sameSizeTamper.executable, 'XX-fake-executable');
    expect(await resolveVerifiedAideskLocalUi({ ...base, execPath: sameSizeTamper.execPath })).toBeUndefined();
    const linked = install('linux');
    rmSync(linked.executable);
    writeFileSync(join(linked.directory, 'real'), 'MZ-fake-executable');
    symlinkSync(join(linked.directory, 'real'), linked.executable);
    expect(await resolveVerifiedAideskLocalUi({ ...base, execPath: linked.execPath })).toBeUndefined();
    const wrongPlatform = install('linux');
    const manifestPath = join(wrongPlatform.directory, AIDESK_LOCAL_UI_MANIFEST_FILENAME);
    writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace('"linux"', '"darwin"'));
    expect(await resolveVerifiedAideskLocalUi({ ...base, execPath: wrongPlatform.execPath })).toBeUndefined();
    const garbage = install('linux');
    writeFileSync(join(garbage.directory, AIDESK_LOCAL_UI_MANIFEST_FILENAME), 'not json');
    expect(await resolveVerifiedAideskLocalUi({ ...base, execPath: garbage.execPath })).toBeUndefined();
    expect(await resolveVerifiedAideskLocalUi({ platform: 'linux', arch: 'ia32', execPath: ok.execPath })).toBeUndefined();
    expect(await resolveVerifiedAideskLocalUi({ platform: 'freebsd', arch: 'x64', execPath: ok.execPath })).toBeUndefined();
  });

  it('Windows additionally needs the release signer: a dev runtime (no trust anchor), a different signer or a failing Authenticode check refuse it', async () => {
    const installed = install('win32');
    const win = { platform: 'win32' as NodeJS.Platform, arch: 'x64', execPath: installed.execPath };
    expect(await resolveVerifiedAideskLocalUi({ ...win, trustedWindowsSignerSha256: SIGNER, verifySigners: async () => true })).toBe(installed.executable);
    expect(await resolveVerifiedAideskLocalUi({ ...win, trustedWindowsSignerSha256: '', verifySigners: async () => true })).toBeUndefined();
    expect(await resolveVerifiedAideskLocalUi({ ...win, trustedWindowsSignerSha256: 'cd'.repeat(32), verifySigners: async () => true })).toBeUndefined();
    expect(await resolveVerifiedAideskLocalUi({ ...win, trustedWindowsSignerSha256: SIGNER, verifySigners: async () => false })).toBeUndefined();
    expect(await resolveVerifiedAideskLocalUi({ ...win, trustedWindowsSignerSha256: SIGNER, verifySigners: async () => { throw new Error('powershell failed'); } })).toBeUndefined();
  });

  it('macOS: the helper inside the signed app, and only when its code signature verifies', async () => {
    const helper = join(temp(), 'aidesk-local-ui');
    writeFileSync(helper, 'x');
    const mac = { platform: 'darwin' as NodeJS.Platform, arch: 'arm64', macosHelperPath: helper };
    expect(await resolveVerifiedAideskLocalUi({ ...mac, codesignVerifies: async () => true })).toBe(helper);
    expect(await resolveVerifiedAideskLocalUi({ ...mac, codesignVerifies: async () => false })).toBeUndefined();
    expect(await resolveVerifiedAideskLocalUi({ ...mac, macosHelperPath: join(temp(), 'missing'), codesignVerifies: async () => true })).toBeUndefined();
  });
});
