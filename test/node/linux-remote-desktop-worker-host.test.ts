/**
 * Focused unit coverage for LinuxRemoteDesktopWorkerHost's own logic --
 * sidecar discovery, availability, and what it advertises. The actual
 * protocol/spawn behavior is exercised for real by
 * test/spec/linux-remote-desktop-worker-qualification.cc (fork/exec against
 * the real native binary, real stdin/stdout, real decoded video), which this
 * TypeScript layer has no way to reproduce in a unit test.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  LinuxRemoteDesktopWorkerHost,
  resolveLinuxRemoteDesktopWorkerPath,
} from '../../src/node/linux-remote-desktop-worker-host.js';

describe('resolveLinuxRemoteDesktopWorkerPath', () => {
  it('resolves the worker sidecar next to the controlled-node executable', () => {
    const execPath = '/opt/imcodes-node/imcodes-node-linux';
    expect(resolveLinuxRemoteDesktopWorkerPath(execPath)).toBe(
      join(dirname(execPath), 'remote-desktop-worker', 'linux-x64', 'imcodes-linux-remote-desktop-worker'),
    );
  });
});

describe('LinuxRemoteDesktopWorkerHost', () => {
  const cleanupDirs: string[] = [];
  afterEach(() => {
    while (cleanupDirs.length > 0) {
      rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
    }
  });

  function makeHost(options: { workerExists: boolean }) {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-linux-worker-host-test-'));
    cleanupDirs.push(dir);
    const workerPath = join(dir, 'imcodes-linux-remote-desktop-worker');
    if (options.workerExists) {
      // A real executable is not needed for available()/sessionCapabilities();
      // only its presence on disk is observed.
      writeFileSync(workerPath, '#!/bin/sh\nexit 0\n');
      chmodSync(workerPath, 0o755);
    }
    const messages: unknown[] = [];
    const host = new LinuxRemoteDesktopWorkerHost((message) => messages.push(message), { workerPath });
    return { host, messages, workerPath };
  }

  it('is unavailable and advertises nothing when the sidecar binary is missing', () => {
    const { host } = makeHost({ workerExists: false });
    expect(host.available()).toBe(false);
    expect(host.sessionCapabilities()).toEqual([]);
  });

  it('is available once the sidecar binary exists on disk', () => {
    const { host } = makeHost({ workerExists: true });
    expect(host.available()).toBe(true);
  });

  /**
   * Pinned deliberately: a bare REMOTE_DESKTOP_CAPABILITY token is the
   * LEGACY v2 profile shape, and resolveRemoteDesktopSessionProfile
   * (shared/remote-desktop-platform.ts) hard-codes that shape to
   * `platform: 'windows', capture: 'windows_dxgi'` -- there is no "legacy
   * Linux". Advertising it here would make a Linux controlled node's
   * session look like a Windows one to every downstream consumer of
   * profile.platform/profile.capture. The correct v3 advertisement also
   * requires a local on-screen disclosure component this worker does not
   * have yet, so the honest advertisement today is nothing at all -- even
   * though the worker binary is present and handle() will really spawn it.
   */
  it('never advertises the bare legacy capability, even when available', () => {
    const { host } = makeHost({ workerExists: true });
    expect(host.available()).toBe(true);
    expect(host.sessionCapabilities()).toEqual([]);
  });

  it('refuses every command when the sidecar binary is missing', async () => {
    const { host } = makeHost({ workerExists: false });
    await expect(host.handle({ type: 'remote_desktop.prepare' })).resolves.toBe(false);
  });

  it('close() is safe with no worker ever spawned', () => {
    const { host, messages } = makeHost({ workerExists: true });
    expect(() => host.close()).not.toThrow();
    expect(messages).toEqual([]);
  });
});
