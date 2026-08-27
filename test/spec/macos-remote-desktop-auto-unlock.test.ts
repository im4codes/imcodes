import { runNative } from './support/native-exec.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  MACOS_AUTO_UNLOCK_LIMITS,
  MACOS_AUTO_UNLOCK_POLICY,
  MACOS_AUTO_UNLOCK_REFUSAL,
  MACOS_AUTO_UNLOCK_SURFACE,
} from '../../src/node/macos-remote-desktop-auto-unlock.js';

const ROOT = resolve(__dirname, '..', '..');
const NATIVE = resolve(ROOT, 'native/macos-remote-desktop');

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

describe('macOS remote-desktop automatic unlock (native)', () => {
  const controller = read('native/macos-remote-desktop/macos_auto_unlock_controller.h');
  const keychain = read('native/macos-remote-desktop/macos_auto_unlock_keychain.mm');

  it('mirrors the TypeScript policy contract token for token', async () => {
    // Two copies of one security decision is a liability; pin them together
    // rather than trusting prose.
    for (const value of Object.values(MACOS_AUTO_UNLOCK_POLICY)) {
      expect(controller, value).toContain(`"${value}"`);
    }
    for (const value of Object.values(MACOS_AUTO_UNLOCK_SURFACE)) {
      expect(controller, value).toContain(`"${value}"`);
    }
    for (const value of Object.values(MACOS_AUTO_UNLOCK_REFUSAL)) {
      expect(controller, value).toContain(`"${value}"`);
    }
    expect(controller).toContain(
      `kAutoUnlockMaxAttempts = ${MACOS_AUTO_UNLOCK_LIMITS.MAX_ATTEMPTS}`,
    );
    expect(controller).toContain(
      `kAutoUnlockLockoutMs = ${MACOS_AUTO_UNLOCK_LIMITS.LOCKOUT_MS / 60_000} * 60 * 1000`,
    );
  });

  it('names only the System keychain and verifies the signer before the ACL', async () => {
    const header = read('native/macos-remote-desktop/macos_auto_unlock_keychain.h');
    expect(header).toContain('kSystemKeychainPath[] = "/Library/Keychains/System.keychain"');
    // And the implementation must use that constant rather than any other path.
    expect(keychain).toContain('kSystemKeychainPath');
    // A login-keychain fallback would put the credential where the logged-in
    // user can read it.
    expect(keychain).not.toMatch(/login\.keychain/u);
    expect(header).not.toMatch(/login\.keychain/u);
    const verifyAt = keychain.indexOf('AgentSatisfiesDesignatedRequirement(\n          agent_path');
    const aclAt = keychain.indexOf('CreateSingleApplicationAccess(agent_path');
    expect(verifyAt).toBeGreaterThan(0);
    expect(aclAt).toBeGreaterThan(0);
    // Creating the ACL first and validating afterwards would leave a window in
    // which a broad item exists on disk.
    expect(verifyAt).toBeLessThan(aclAt);
    expect(keychain).toContain('SecStaticCodeCheckValidity');
    expect(keychain).toContain('SecTrustedApplicationCreateFromPath');
  });

  it('has no path that returns the credential to a caller', async () => {
    const header = read('native/macos-remote-desktop/macos_auto_unlock_keychain.h');
    // Consumption is a bounded callback; there must be no getter overload.
    expect(header).toContain('AutoUnlockCredentialConsumer');
    expect(header).not.toMatch(/std::string\s+(Read|Get|Copy)\w*Credential/u);
    expect(keychain).toContain('memset_s');
  });

  it('compiles the keychain layer against Security.framework', async () => {
    if (process.platform !== 'darwin') return;
    const directory = mkdtempSync(resolve(tmpdir(), 'imcodes-macos-au-'));
    try {
      const compile = await runNative('xcrun', [
        '--sdk', 'macosx', 'clang++', '-std=c++20', '-fobjc-arc', '-c',
        '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=13.0',
        '-I', NATIVE,
        resolve(NATIVE, 'macos_auto_unlock_keychain.mm'),
        '-o', resolve(directory, 'keychain.o'),
      ], { encoding: 'utf8' });
      expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs the controller counterfactual under ASan and UBSan', async () => {
    if (process.platform !== 'darwin') return;
    const directory = mkdtempSync(resolve(tmpdir(), 'imcodes-macos-au-san-'));
    try {
      const output = resolve(directory, 'auto-unlock');
      const compile = await runNative('xcrun', [
        'clang++', '-std=c++20',
        '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
        '-Wall', '-Wextra', '-Werror',
        '-I', NATIVE,
        resolve(NATIVE, 'macos_auto_unlock_controller.cc'),
        resolve(ROOT, 'test/spec/macos-remote-desktop-auto-unlock-test.cc'),
        '-o', output,
      ], { encoding: 'utf8' });
      expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
      const run = await runNative(output, [], {
        env: {
          ...process.env,
          ASAN_OPTIONS: 'halt_on_error=1:abort_on_error=1',
          UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1',
        },
      });
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain('macos auto unlock controller counterfactual ok');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
