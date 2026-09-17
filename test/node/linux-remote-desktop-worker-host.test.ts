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
import { resolveRemoteDesktopSessionProfile } from '../../shared/remote-desktop-platform.js';
import { REMOTE_DESKTOP_CAPABILITY } from '../../shared/remote-desktop.js';

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
   * Linux". This must never be advertised: a Linux controlled node's
   * session would look like a Windows one to every downstream consumer of
   * profile.platform/profile.capture. The full v3 token set below is the
   * correct advertisement instead -- see sessionCapabilities()'s own
   * comment for why it is honest despite this worker having no
   * per-machine readiness probe yet.
   */
  it('advertises the full v3 profile, not the bare legacy capability, once available', () => {
    const { host } = makeHost({ workerExists: true });
    expect(host.available()).toBe(true);
    const capabilities = host.sessionCapabilities();
    expect(capabilities).not.toContain(REMOTE_DESKTOP_CAPABILITY);
    const profile = resolveRemoteDesktopSessionProfile(capabilities);
    expect(profile).not.toBeNull();
    expect(profile?.kind).toBe('common_v3');
    expect(profile?.platform).toBe('linux');
    expect(profile?.capture).toBe('linux_x11');
    expect(profile?.encoder).toBe('h264');
    expect(profile?.localDisclosure).toBe(true);
    // Honest View-only: the data-channel wire protocol for pointer/keyboard/
    // clipboard is not wired to the input adapters yet.
    expect(profile?.input).toBe(false);
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
