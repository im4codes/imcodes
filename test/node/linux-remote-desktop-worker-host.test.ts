/**
 * Focused unit coverage for LinuxRemoteDesktopWorkerHost's own logic --
 * sidecar discovery, availability, and what it advertises. The actual
 * protocol/spawn behavior is exercised for real by
 * test/spec/linux-remote-desktop-worker-qualification.cc (fork/exec against
 * the real native binary, real stdin/stdout, real decoded video), which this
 * TypeScript layer has no way to reproduce in a unit test.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { Writable } from 'node:stream';
import {
  LinuxRemoteDesktopWorkerHost,
  checkLinuxWorkerLibraries,
  resolveLinuxRemoteDesktopWorkerPath,
  resolveWorkerAudioEnv,
  resolveWorkerDisplayEnv,
  resolveWorkerRuntimeEnv,
} from '../../src/node/linux-remote-desktop-worker-host.js';
import { resolveRemoteDesktopSessionProfile } from '../../shared/remote-desktop-platform.js';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_CAPABILITY,
  REMOTE_DESKTOP_LIMITS,
  REMOTE_DESKTOP_MSG,
  REMOTE_DESKTOP_TERMINAL_REASON,
} from '../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_INPUT_CAPABILITY,
  REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
} from '../../shared/remote-desktop-access.js';

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

  it('advertises nothing and reports libraries missing when checkLibraries returns false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-linux-worker-host-test-'));
    cleanupDirs.push(dir);
    const workerPath = join(dir, 'imcodes-linux-remote-desktop-worker');
    writeFileSync(workerPath, '#!/bin/sh\nexit 0\n');
    chmodSync(workerPath, 0o755);

    const host = new LinuxRemoteDesktopWorkerHost(() => {}, {
      workerPath,
      checkLibraries: () => false,
    });
    expect(host.available()).toBe(true);
    expect(host.librariesAvailable()).toBe(false);
    expect(host.sessionCapabilities()).toEqual([]);
    expect(host.adapterCapabilities()).toEqual([]);
  });

  it('checkLinuxWorkerLibraries detects missing shared libraries via output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-linux-worker-host-test-'));
    cleanupDirs.push(dir);
    const workerPath = join(dir, 'worker');
    writeFileSync(workerPath, 'dummy');

    const okMockExec = () => 'libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6\nlibX11.so.6 => /lib/libX11.so.6';
    expect(checkLinuxWorkerLibraries(workerPath, okMockExec as never)).toBe(true);

    const missingMockExec = () => 'libc.so.6 => /lib/libc.so.6\nlibXtst.so.6 => not found';
    expect(checkLinuxWorkerLibraries(workerPath, missingMockExec as never)).toBe(false);

    const throwingMockExec = () => { throw new Error('ldd not found'); };
    expect(checkLinuxWorkerLibraries(workerPath, throwingMockExec as never)).toBe(false);

    expect(checkLinuxWorkerLibraries('/nonexistent/worker/path')).toBe(false);
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
   *
   * Combines sessionCapabilities() with adapterCapabilities() before
   * resolving, exactly as runtime.ts's refreshRemoteDesktopCapabilityState
   * does (profile = resolveRemoteDesktopSessionProfile([...session,
   * ...adapter])). Resolving from sessionCapabilities() alone previously
   * passed this test while the real auth frame advertised nothing at all,
   * because LOCAL_DISCLOSURE lived in sessionCapabilities() -- where
   * runtime.ts's session-side filter (REMOTE_DESKTOP_SESSION_PROFILE_
   * CAPABILITIES) silently drops it -- instead of adapterCapabilities(),
   * where runtime.ts actually looks for adapter tokens.
   */
  it('advertises the full v3 profile, not the bare legacy capability, once available', () => {
    const { host } = makeHost({ workerExists: true });
    expect(host.available()).toBe(true);
    const capabilities = [...host.sessionCapabilities(), ...host.adapterCapabilities()];
    expect(capabilities).not.toContain(REMOTE_DESKTOP_CAPABILITY);
    const profile = resolveRemoteDesktopSessionProfile(capabilities);
    expect(profile).not.toBeNull();
    expect(profile?.kind).toBe('common_v3');
    expect(profile?.platform).toBe('linux');
    expect(profile?.capture).toBe('linux_x11');
    expect(profile?.encoder).toBe('h264');
    expect(profile?.localDisclosure).toBe(true);
    // Real now: linux_remote_desktop_session.cc registers a webrtc::
    // DataChannelObserver on every channel and dispatches pointer/keyboard
    // through SessionCore/InputLedger to the already-qualified
    // X11InputAdapter.
    expect(profile?.input).toBe(true);
    // Real too: the worker answers copy_selection from the X11 selection and
    // types pasted text through the same input adapter.
    expect(profile?.explicitClipboard).toBe(true);
  });

  /**
   * sessionCapabilities() alone must NOT resolve a profile: it is
   * deliberately missing the adapter-side LOCAL_DISCLOSURE token that the
   * v3 profile requires. Pinning this the other way (sessionCapabilities()
   * alone resolving successfully) is exactly the shape of the production
   * bug this file's other test above documents -- session and adapter
   * capabilities must both be present, from their own respective methods.
   */
  it('resolves no profile from sessionCapabilities() alone, without adapterCapabilities()', () => {
    const { host } = makeHost({ workerExists: true });
    expect(resolveRemoteDesktopSessionProfile(host.sessionCapabilities())).toBeNull();
  });

  it('advertises the real on-screen disclosure adapter and input once available, nothing when missing', () => {
    const { host: availableHost } = makeHost({ workerExists: true });
    expect(availableHost.adapterCapabilities()).toEqual([
      REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
      REMOTE_DESKTOP_INPUT_CAPABILITY,
    ]);
    const { host: missingHost } = makeHost({ workerExists: false });
    expect(missingHost.adapterCapabilities()).toEqual([]);
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

/**
 * Regression coverage for a production bug: imcodes-node.service has no
 * `Environment=DISPLAY=...` line (unlike scripts/install-linux-desktop-
 * environment.sh's own x11vnc unit, which sets one on itself for exactly
 * this reason), so the worker this host spawns inherited an unset $DISPLAY
 * and could never open the X server -- even with a real Xvfb running and
 * every capability correctly advertised. Observed as a session that never
 * left its first "connecting" step. resolveWorkerDisplayEnv is what
 * ensureSpawned() now passes as the spawned child's env.
 */
describe('resolveWorkerDisplayEnv', () => {
  const socketDirs: string[] = [];
  afterEach(() => {
    while (socketDirs.length > 0) {
      rmSync(socketDirs.pop()!, { recursive: true, force: true });
    }
  });

  function makeSocketDir(names: readonly string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-x11-unix-test-'));
    socketDirs.push(dir);
    for (const name of names) writeFileSync(join(dir, name), '');
    return dir;
  }

  it('never overrides an already-set DISPLAY, even with live sockets present', () => {
    const socketDir = makeSocketDir(['X0', 'X99']);
    const env = resolveWorkerDisplayEnv({ DISPLAY: ':7' }, socketDir);
    expect(env.DISPLAY).toBe(':7');
  });

  it('targets the lowest-numbered live X11 socket when DISPLAY is unset', () => {
    const socketDir = makeSocketDir(['X99', 'X0', 'X12']);
    const env = resolveWorkerDisplayEnv({}, socketDir);
    expect(env.DISPLAY).toBe(':0');
  });

  it('falls back to the install script default when no socket exists at all', () => {
    const socketDir = makeSocketDir([]);
    expect(resolveWorkerDisplayEnv({}, socketDir).DISPLAY).toBe(':99');
  });

  it('falls back to the install script default when the socket directory does not exist', () => {
    expect(resolveWorkerDisplayEnv({}, '/nonexistent/x11-unix-dir').DISPLAY).toBe(':99');
  });

  it('ignores unrelated files in the socket directory', () => {
    const socketDir = makeSocketDir(['.X11-lock', 'X42', 'not-a-socket']);
    expect(resolveWorkerDisplayEnv({}, socketDir).DISPLAY).toBe(':42');
  });

  it('preserves the rest of the environment unchanged', () => {
    const socketDir = makeSocketDir(['X5']);
    const env = resolveWorkerDisplayEnv({ PATH: '/usr/bin', LANG: 'en_US.UTF-8' }, socketDir);
    expect(env).toEqual({ PATH: '/usr/bin', LANG: 'en_US.UTF-8', DISPLAY: ':5' });
  });

  it('prefers managed desktop display or default :99 over empty/demo high-numbered Xvfbs like :97/:98', () => {
    const socketDir = makeSocketDir(['X0', 'X97', 'X98', 'X99']);
    const accessible = [97, 98, 99];

    // Without host marker (or on default :99 heuristic), prefers :99 over :97/:98
    expect(resolveWorkerDisplayEnv({}, socketDir, accessible).DISPLAY).toBe(':99');

    // Explicit desktop-display marker selects custom managed display :50 over :40 and :99
    const customDir = makeSocketDir(['X40', 'X50', 'X99']);
    const markerDir = makeSocketDir([]);
    const markerPath = join(markerDir, 'desktop-display');
    writeFileSync(markerPath, ':50\n');
    expect(
      resolveWorkerDisplayEnv({}, customDir, [40, 50, 99], { displayMarkerPath: markerPath }).DISPLAY,
    ).toBe(':50');

    // Explicit env.DISPLAY always wins even when managed display :99 is accessible
    expect(
      resolveWorkerDisplayEnv({ DISPLAY: ':7' }, socketDir, accessible, { displayMarkerPath: markerPath }).DISPLAY,
    ).toBe(':7');
  });

  it('falls back from corrupt/missing desktop-display marker to legacy imcodes-desktop-session.sh without throwing', () => {
    const socketDir = makeSocketDir(['X40', 'X50', 'X99']);
    const metaDir = makeSocketDir([]);
    const markerPath = join(metaDir, 'desktop-display');
    const scriptPath = join(metaDir, 'imcodes-desktop-session.sh');
    writeFileSync(markerPath, 'not-a-display\n');
    writeFileSync(scriptPath, '#!/usr/bin/env bash\nset -euo pipefail\nexport DISPLAY=":50"\n');

    expect(
      resolveWorkerDisplayEnv({}, socketDir, [40, 50, 99], {
        displayMarkerPath: markerPath,
        sessionScriptPath: scriptPath,
      }).DISPLAY,
    ).toBe(':50');

    // Corrupted/unreadable files fall through cleanly to :99 preference or usable[0]
    writeFileSync(scriptPath, 'corrupt');
    expect(
      resolveWorkerDisplayEnv({}, socketDir, [40, 50, 99], {
        displayMarkerPath: join(metaDir, 'missing'),
        sessionScriptPath: scriptPath,
      }).DISPLAY,
    ).toBe(':99');
  });

  it('keeps physical X11 display (<10) priority when no managed desktop is selected, and falls back when managed display is stopped', () => {
    const socketDir = makeSocketDir(['X0', 'X97', 'X99']);
    expect(resolveWorkerDisplayEnv({}, socketDir, [0, 97, 99]).DISPLAY).toBe(':0');

    // Stopped managed display :50 (not in accessible) falls back to accessible :97/:98
    const metaDir = makeSocketDir([]);
    const markerPath = join(metaDir, 'desktop-display');
    writeFileSync(markerPath, ':50\n');
    const noDefaultDir = makeSocketDir(['X97', 'X98']);
    expect(
      resolveWorkerDisplayEnv({}, noDefaultDir, [97, 98], { displayMarkerPath: markerPath }).DISPLAY,
    ).toBe(':97');
  });

  it('preserves Linux worker sessions across transient disconnect/reconnect, translates LEASE generation, and fails closed after grace', async () => {
    vi.useFakeTimers();
    const baseNow = 1_800_000_000_000;
    vi.setSystemTime(baseNow);
    const workerDir = makeSocketDir([]);
    const workerPath = join(workerDir, 'imcodes-linux-remote-desktop-worker');
    writeFileSync(workerPath, '#!/usr/bin/env node\nprocess.stdin.resume();\n');
    chmodSync(workerPath, 0o755);

    const messages: Array<Record<string, unknown>> = [];
    const host = new LinuxRemoteDesktopWorkerHost((msg) => messages.push(msg as unknown as Record<string, unknown>), {
      workerPath,
      checkLibraries: () => true,
    });
    const workerCommands: Array<Record<string, unknown>> = [];
    try {
      await expect(host.start()).resolves.toBeUndefined();
      const child = (host as unknown as { child: { stdin: Writable } }).child;
      expect(child).toBeTruthy();
      vi.spyOn(child.stdin, 'write').mockImplementation(((chunk: unknown) => {
        for (const line of String(chunk).split('\n')) {
          if (line.trim()) workerCommands.push(JSON.parse(line) as Record<string, unknown>);
        }
        return true;
      }) as Writable['write']);

      const requestId = 'request_linux_grace_1';
      const sessionId = 'session_linux_grace_1';
      const capability = 'l'.repeat(43);
      await expect(host.handle({
        type: REMOTE_DESKTOP_MSG.PREPARE,
        requestId,
        sessionId,
        capability,
        expiresAt: baseNow + 180_000,
        leaseExpiresAt: baseNow + 60_000,
        daemonGeneration: 5,
        mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        inputEpoch: 1,
        iceServers: [],
      })).resolves.toBe(true);

      expect(workerCommands.at(-1)).toMatchObject({ type: REMOTE_DESKTOP_MSG.PREPARE, daemonGeneration: 5 });

      host.onDaemonDisconnected();
      expect(host.hasTrackedSessions()).toBe(true);
      expect(host.activeRouteAuthorities()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(workerCommands.some((c) => c.type === REMOTE_DESKTOP_MSG.STOP)).toBe(false);

      host.onDaemonReconnected();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(workerCommands.some((c) => c.type === REMOTE_DESKTOP_MSG.STOP)).toBe(false);

      await expect(host.handle({
        type: REMOTE_DESKTOP_MSG.LEASE,
        requestId,
        sessionId,
        capability,
        leaseExpiresAt: baseNow + 120_000,
        daemonGeneration: 1,
        mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        inputEpoch: 1,
      })).resolves.toBe(true);
      expect(workerCommands.at(-1)).toMatchObject({
        type: REMOTE_DESKTOP_MSG.LEASE,
        sessionId,
        daemonGeneration: 5,
      });

      host.onDaemonDisconnected();
      await vi.advanceTimersByTimeAsync(85_000);
      expect(workerCommands.at(-1)).toEqual({
        type: REMOTE_DESKTOP_MSG.STOP,
        requestId,
        sessionId,
        capability,
      });
      expect(messages).toContainEqual({
        type: REMOTE_DESKTOP_MSG.TERMINAL,
        requestId,
        sessionId,
        capability,
        reason: REMOTE_DESKTOP_TERMINAL_REASON.LEASE_EXPIRED,
      });
      expect(host.hasTrackedSessions()).toBe(false);
    } finally {
      host.close();
      vi.useRealTimers();
    }
  });

  it('expires earlier multi-session leases individually during disconnect grace without killing live sessions, and enforces global 5-minute deadline without reset', async () => {
    vi.useFakeTimers();
    const baseNow = 1_800_000_000_000;
    vi.setSystemTime(baseNow);
    const workerDir = makeSocketDir([]);
    const workerPath = join(workerDir, 'imcodes-linux-remote-desktop-worker');
    writeFileSync(workerPath, '#!/usr/bin/env node\nprocess.stdin.resume();\n');
    chmodSync(workerPath, 0o755);

    const messages: Array<Record<string, unknown>> = [];
    const host = new LinuxRemoteDesktopWorkerHost((msg) => messages.push(msg as unknown as Record<string, unknown>), {
      workerPath,
      checkLibraries: () => true,
    });
    const workerCommands: Array<Record<string, unknown>> = [];
    try {
      await expect(host.start()).resolves.toBeUndefined();
      const child = (host as unknown as { child: { stdin: Writable } }).child;
      vi.spyOn(child.stdin, 'write').mockImplementation(((chunk: unknown) => {
        for (const line of String(chunk).split('\n')) {
          if (line.trim()) workerCommands.push(JSON.parse(line) as Record<string, unknown>);
        }
        return true;
      }) as Writable['write']);

      const capA = 'a'.repeat(43);
      const capB = 'b'.repeat(43);
      const capC = 'c'.repeat(43);
      await host.handle({
        type: REMOTE_DESKTOP_MSG.PREPARE,
        requestId: 'request_linux_a_1',
        sessionId: 'session_linux_a_1',
        capability: capA,
        expiresAt: baseNow + 10_000,
        leaseExpiresAt: baseNow + 10_000,
        daemonGeneration: 5,
        mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        inputEpoch: 1,
        iceServers: [],
      });
      await host.handle({
        type: REMOTE_DESKTOP_MSG.PREPARE,
        requestId: 'request_linux_b_1',
        sessionId: 'session_linux_b_1',
        capability: capB,
        expiresAt: baseNow + 60_000,
        leaseExpiresAt: baseNow + 60_000,
        daemonGeneration: 5,
        mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        inputEpoch: 1,
        iceServers: [],
      });
      await host.handle({
        type: REMOTE_DESKTOP_MSG.PREPARE,
        requestId: 'request_linux_c_1',
        sessionId: 'session_linux_c_1',
        capability: capC,
        expiresAt: baseNow + 600_000,
        leaseExpiresAt: baseNow + 600_000,
        daemonGeneration: 5,
        mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        inputEpoch: 1,
        iceServers: [],
      });

      host.onDaemonDisconnected();

      // Advance +10s: only A expires with LEASE_EXPIRED; B and C stay tracked/busy.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(messages.filter((m) => m.type === REMOTE_DESKTOP_MSG.TERMINAL)).toEqual([{
        type: REMOTE_DESKTOP_MSG.TERMINAL,
        requestId: 'request_linux_a_1',
        sessionId: 'session_linux_a_1',
        capability: capA,
        reason: REMOTE_DESKTOP_TERMINAL_REASON.LEASE_EXPIRED,
      }]);
      expect(workerCommands.filter((c) => c.type === REMOTE_DESKTOP_MSG.STOP)).toEqual([{
        type: REMOTE_DESKTOP_MSG.STOP,
        requestId: 'request_linux_a_1',
        sessionId: 'session_linux_a_1',
        capability: capA,
      }]);
      expect(host.hasTrackedSessions()).toBe(true);
      expect(host.activeRouteAuthorities().map((r) => r.sessionId)).toEqual(['session_linux_b_1', 'session_linux_c_1']);

      // Advance to +60s: B expires individually while C remains live.
      await vi.advanceTimersByTimeAsync(50_000);
      expect(messages.filter((m) => m.type === REMOTE_DESKTOP_MSG.TERMINAL).map((m) => m.sessionId)).toEqual([
        'session_linux_a_1',
        'session_linux_b_1',
      ]);
      expect(host.hasTrackedSessions()).toBe(true);
      expect(host.activeRouteAuthorities().map((r) => r.sessionId)).toEqual(['session_linux_c_1']);

      // Re-arming disconnect before reconnect must NOT reset the global 5-minute deadline.
      host.onDaemonDisconnected();
      await vi.advanceTimersByTimeAsync(REMOTE_DESKTOP_LIMITS.SIGNALING_RECONNECT_GRACE_MS - 60_000);
      expect(messages.filter((m) => m.type === REMOTE_DESKTOP_MSG.TERMINAL)).toHaveLength(3);
      expect(messages.at(-1)).toMatchObject({
        type: REMOTE_DESKTOP_MSG.TERMINAL,
        sessionId: 'session_linux_c_1',
        reason: REMOTE_DESKTOP_TERMINAL_REASON.LEASE_EXPIRED,
      });
      expect(host.hasTrackedSessions()).toBe(false);

      // Reconnecting before global deadline clears the entire disconnect schedule.
      const capD = 'd'.repeat(43);
      await host.handle({
        type: REMOTE_DESKTOP_MSG.PREPARE,
        requestId: 'request_linux_d_1',
        sessionId: 'session_linux_d_1',
        capability: capD,
        expiresAt: baseNow + 900_000,
        leaseExpiresAt: baseNow + 900_000,
        daemonGeneration: 5,
        mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        inputEpoch: 1,
        iceServers: [],
      });
      host.onDaemonDisconnected();
      await vi.advanceTimersByTimeAsync(50_000);
      host.onDaemonReconnected();
      await vi.advanceTimersByTimeAsync(REMOTE_DESKTOP_LIMITS.SIGNALING_RECONNECT_GRACE_MS);
      expect(host.hasTrackedSessions()).toBe(true);
    } finally {
      host.close();
      vi.useRealTimers();
    }
  });

  it('resolves managed desktop audio runtime dir and identity from normal worker startup env, respecting explicit operator config and failing closed on mismatch', () => {
    const root = makeSocketDir(['X99', 'X0']);
    const metaDir = join(root, 'meta');
    const runDir = join(root, 'run');
    const runUserDir = join(root, 'run-user');
    mkdirSync(metaDir, { recursive: true });
    mkdirSync(join(runDir, 'imcodes-desktop', 'pulse'), { recursive: true });
    mkdirSync(join(runUserDir, '1002', 'pulse'), { recursive: true });

    const markerPath = join(metaDir, 'desktop-display');
    const servicePath = join(metaDir, 'imcodes-desktop-session.service');
    const passwdPath = join(metaDir, 'passwd');

    writeFileSync(markerPath, ':99\n');
    writeFileSync(
      servicePath,
      [
        '[Unit]',
        'Description=IM.codes desktop session',
        '[Service]',
        'Type=simple',
        'User=k',
        'Group=k',
        'RuntimeDirectory=imcodes-desktop',
        'RuntimeDirectoryMode=0700',
        'ExecStart=/usr/local/lib/imcodes/imcodes-desktop-session.sh',
      ].join('\n'),
    );
    writeFileSync(
      passwdPath,
      [
        'root:x:0:0:root:/root:/bin/bash',
        'k:x:1000:1000:k:/home/k:/bin/bash',
        'other:x:1002:1002:other:/home/other:/bin/bash',
      ].join('\n'),
    );

    const managedRuntimeDir = join(runDir, 'imcodes-desktop');
    const managedSocket = join(managedRuntimeDir, 'pulse', 'native');
    const matchingStat = (path: string) => {
      if (path === managedRuntimeDir) return { uid: 1000, gid: 1000, isDirectory: true, isSocket: false };
      if (path === managedSocket) return { uid: 1000, gid: 1000, isDirectory: false, isSocket: true };
      return null;
    };

    // Normal systemd imcodes-node environment: only DISPLAY=:99 (all 3 Pulse/XDG keys missing)
    const resolved = resolveWorkerRuntimeEnv(
      { PATH: '/usr/bin', DISPLAY: ':99' },
      root,
      [0, 99],
      { displayMarkerPath: markerPath },
      {
        displayMarkerPath: markerPath,
        sessionServicePath: servicePath,
        runtimeRootDir: runDir,
        passwdPath,
        runUserDir,
        stat: matchingStat,
        currentUid: 0,
      },
    );
    expect(resolved).toMatchObject({
      DISPLAY: ':99',
      IMCODES_RD_AUDIO_POLICY: 'managed',
      XDG_RUNTIME_DIR: managedRuntimeDir,
      PULSE_SERVER: `unix:${managedSocket}`,
      IMCODES_RD_AUDIO_RUNTIME_DIR: managedRuntimeDir,
      IMCODES_RD_AUDIO_SOCKET: managedSocket,
      IMCODES_RD_AUDIO_UID: '1000',
      IMCODES_RD_AUDIO_GID: '1000',
      IMCODES_RD_AUDIO_HOME: '/home/k',
    });

    // Respects explicit operator config without overwriting
    const explicit = resolveWorkerAudioEnv(
      { DISPLAY: ':99', PULSE_SERVER: 'unix:/tmp/custom-pulse', XDG_RUNTIME_DIR: '/tmp/custom-xdg' },
      {
        displayMarkerPath: markerPath,
        sessionServicePath: servicePath,
        runtimeRootDir: runDir,
        passwdPath,
        stat: matchingStat,
        currentUid: 0,
      },
    );
    expect(explicit.PULSE_SERVER).toBe('unix:/tmp/custom-pulse');
    expect(explicit.XDG_RUNTIME_DIR).toBe('/tmp/custom-xdg');
    expect(explicit.IMCODES_RD_AUDIO_UID).toBeUndefined();
    expect(explicit.IMCODES_RD_AUDIO_POLICY).toBeUndefined();

    // Inherited XDG_RUNTIME_DIR alone does NOT count as an explicit audio override:
    // matched managed desktop overrides it, and mismatched/unmatched fails closed.
    const inheritedXdgMatched = resolveWorkerAudioEnv(
      { DISPLAY: ':99', XDG_RUNTIME_DIR: '/tmp/stale-inherited-xdg' },
      {
        displayMarkerPath: markerPath,
        sessionServicePath: servicePath,
        runtimeRootDir: runDir,
        passwdPath,
        stat: matchingStat,
        currentUid: 0,
      },
    );
    expect(inheritedXdgMatched).toMatchObject({
      IMCODES_RD_AUDIO_POLICY: 'managed',
      XDG_RUNTIME_DIR: managedRuntimeDir,
      PULSE_SERVER: `unix:${managedSocket}`,
      IMCODES_RD_AUDIO_UID: '1000',
    });

    const inheritedXdgMismatch = resolveWorkerAudioEnv(
      { DISPLAY: ':0', XDG_RUNTIME_DIR: '/tmp/stale-inherited-xdg' },
      {
        displayMarkerPath: markerPath,
        sessionServicePath: servicePath,
        runtimeRootDir: runDir,
        passwdPath,
        stat: matchingStat,
        currentUid: 0,
      },
    );
    expect(inheritedXdgMismatch.IMCODES_RD_AUDIO_POLICY).toBe('disabled');
    expect(inheritedXdgMismatch.PULSE_SERVER).toBeUndefined();

    // Display mismatch (session resolved to :0 while managed desktop is :99): denies implicit Pulse discovery
    const displayMismatch = resolveWorkerAudioEnv(
      { DISPLAY: ':0' },
      {
        displayMarkerPath: markerPath,
        sessionServicePath: servicePath,
        runtimeRootDir: runDir,
        passwdPath,
        stat: matchingStat,
        currentUid: 0,
      },
    );
    expect(displayMismatch.PULSE_SERVER).toBeUndefined();
    expect(displayMismatch.IMCODES_RD_AUDIO_UID).toBeUndefined();
    expect(displayMismatch.IMCODES_RD_AUDIO_POLICY).toBe('disabled');

    // Wrong socket ownership (owned by 1002 instead of unit User=k uid 1000): fails closed with disabled policy
    const wrongOwner = resolveWorkerAudioEnv(
      { DISPLAY: ':99' },
      {
        displayMarkerPath: markerPath,
        sessionServicePath: servicePath,
        runtimeRootDir: runDir,
        passwdPath,
        stat: (path: string) => {
          if (path === managedRuntimeDir) return { uid: 1000, gid: 1000, isDirectory: true, isSocket: false };
          if (path === managedSocket) return { uid: 1002, gid: 1002, isDirectory: false, isSocket: true };
          return null;
        },
        currentUid: 0,
      },
    );
    expect(wrongOwner.PULSE_SERVER).toBeUndefined();
    expect(wrongOwner.IMCODES_RD_AUDIO_UID).toBeUndefined();
    expect(wrongOwner.IMCODES_RD_AUDIO_POLICY).toBe('disabled');

    // Socket/dir not created yet at worker startup (worker starts before desktop session): still passes stable managed target
    const pendingSocket = resolveWorkerAudioEnv(
      { DISPLAY: ':99' },
      {
        displayMarkerPath: markerPath,
        sessionServicePath: servicePath,
        runtimeRootDir: runDir,
        passwdPath,
        stat: () => null,
        currentUid: 0,
      },
    );
    expect(pendingSocket).toMatchObject({
      IMCODES_RD_AUDIO_POLICY: 'managed',
      PULSE_SERVER: `unix:${managedSocket}`,
      IMCODES_RD_AUDIO_SOCKET: managedSocket,
      IMCODES_RD_AUDIO_UID: '1000',
    });

    // Missing desktop service (no managed desktop): denies implicit Pulse discovery
    const noDesktop = resolveWorkerAudioEnv(
      { DISPLAY: ':99' },
      {
        displayMarkerPath: markerPath,
        sessionServicePath: join(metaDir, 'missing.service'),
        runtimeRootDir: runDir,
        passwdPath,
        stat: () => null,
        currentUid: 0,
      },
    );
    expect(noDesktop.PULSE_SERVER).toBeUndefined();
    expect(noDesktop.IMCODES_RD_AUDIO_POLICY).toBe('disabled');

    // Non-root user matching /run/user/<uid>/pulse/native
    const userRuntimeDir = join(runUserDir, '1002');
    const userSocket = join(userRuntimeDir, 'pulse', 'native');
    const nonRoot = resolveWorkerAudioEnv(
      { DISPLAY: ':0' },
      {
        displayMarkerPath: markerPath,
        sessionServicePath: servicePath,
        runtimeRootDir: runDir,
        passwdPath,
        runUserDir,
        stat: (path: string) => {
          if (path === userRuntimeDir) return { uid: 1002, gid: 1002, isDirectory: true, isSocket: false };
          if (path === userSocket) return { uid: 1002, gid: 1002, isDirectory: false, isSocket: true };
          return null;
        },
        currentUid: 1002,
      },
    );
    expect(nonRoot.IMCODES_RD_AUDIO_POLICY).toBe('user');
    expect(nonRoot.XDG_RUNTIME_DIR).toBe(userRuntimeDir);
    expect(nonRoot.PULSE_SERVER).toBe(`unix:${userSocket}`);
    expect(nonRoot.IMCODES_RD_AUDIO_UID).toBeUndefined();
  });
});
