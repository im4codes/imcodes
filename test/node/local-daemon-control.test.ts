import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REMOTE_DESKTOP_LOCAL_DAEMON_ACTION,
  REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART,
  REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE,
  REMOTE_DESKTOP_LOCAL_DAEMON_REASON,
  REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE,
} from '../../shared/remote-desktop-local-management.js';
import { resolvePosixDaemonServicePaths } from '../../src/util/posix-daemon-service.js';
import {
  CODING_DAEMON_LOG_MAX_BYTES,
  createLocalDaemonController,
  discoverCodingDaemonRuntime,
  redactDaemonSecrets,
  type ActiveDesktopUser,
} from '../../src/node/local-daemon-control.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'imcodes-daemon-ctl-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createFakeBundle(rootDir: string, version = '1.2.3', platform: NodeJS.Platform = 'linux'): string {
  const bundleDir = join(rootDir, 'daemon-runtime');
  const nodeBin = platform === 'win32'
    ? join(bundleDir, 'node.exe')
    : join(bundleDir, 'bin', 'node');
  const entry = join(bundleDir, 'package', 'dist', 'src', 'index.js');
  mkdirSync(join(bundleDir, 'bin'), { recursive: true });
  mkdirSync(join(bundleDir, 'package', 'dist', 'src'), { recursive: true });
  writeFileSync(nodeBin, '#!/bin/sh\n', { mode: 0o755 });
  chmodSync(nodeBin, 0o755);
  writeFileSync(entry, 'export {};\n');
  writeFileSync(join(bundleDir, 'package', 'package.json'), JSON.stringify({ name: 'imcodes', version }));
  return bundleDir;
}

function createFakeCli(rootDir: string, version = '0.9.8'): string {
  const pkgRoot = join(rootDir, 'cli-root');
  const binDir = join(pkgRoot, 'bin');
  const libPkg = join(pkgRoot, 'lib', 'node_modules', 'imcodes');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(libPkg, { recursive: true });
  writeFileSync(join(libPkg, 'package.json'), JSON.stringify({ name: 'imcodes', version }));
  const cliPath = join(binDir, 'imcodes');
  writeFileSync(cliPath, '#!/bin/sh\n', { mode: 0o755 });
  chmodSync(cliPath, 0o755);
  return cliPath;
}

const safeExecText = vi.fn(async () => ({ stdout: '', stderr: '' }));
const safeKillProcess = vi.fn(() => {});
const safeSpawnDetached = vi.fn(() => {});

afterEach(() => {
  safeExecText.mockClear();
  safeKillProcess.mockClear();
  safeSpawnDetached.mockClear();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('discoverCodingDaemonRuntime', () => {
  it('prefers Phase 1 daemon-runtime bundle over legacy imcodes CLI installs', () => {
    const root = makeTempDir();
    const bundleDir = createFakeBundle(root, '2.0.0', 'linux');
    const cliPath = createFakeCli(root, '0.1.0');

    const discovered = discoverCodingDaemonRuntime({
      platform: 'linux',
      env: {},
      execPath: join(root, 'aidesk-bin'),
      bundleDirs: [bundleDir],
      cliCandidates: [cliPath],
    });

    expect(discovered).not.toBeNull();
    expect(discovered?.source).toBe(REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE.BUNDLE);
    expect(discovered?.version).toBe('2.0.0');
    expect(discovered?.executable).toBe(join(bundleDir, 'bin', 'node'));
    expect(discovered?.foregroundArgs).toEqual([
      join(bundleDir, 'package', 'dist', 'src', 'index.js'),
      'start',
      '--foreground',
    ]);
  });

  it('falls back to legacy imcodes CLI when bundle is absent', () => {
    const root = makeTempDir();
    const cliPath = createFakeCli(root, '0.8.5');

    const discovered = discoverCodingDaemonRuntime({
      platform: 'linux',
      env: {},
      execPath: join(root, 'nowhere', 'aidesk-bin'),
      bundleDirs: [join(root, 'missing-bundle')],
      cliCandidates: [cliPath],
    });

    expect(discovered).not.toBeNull();
    expect(discovered?.source).toBe(REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE.CLI);
    expect(discovered?.version).toBe('0.8.5');
    expect(discovered?.executable).toBe(cliPath);
    expect(discovered?.foregroundArgs).toEqual(['start', '--foreground']);
  });

  it('returns null when neither bundle nor CLI is installed', () => {
    const root = makeTempDir();
    const discovered = discoverCodingDaemonRuntime({
      platform: 'linux',
      env: {},
      execPath: join(root, 'nowhere', 'aidesk-bin'),
      bundleDirs: [join(root, 'missing-bundle')],
      cliCandidates: [join(root, 'missing-cli')],
    });
    expect(discovered).toBeNull();
  });
});

describe('createLocalDaemonController status & logs', () => {
  it('reports unavailable cleanly when no interactive desktop user is signed in', async () => {
    const root = makeTempDir();
    const bundleDir = createFakeBundle(root, '1.4.0');
    const ctl = createLocalDaemonController({
      platform: 'darwin',
      bundleDirs: [bundleDir],
      activeUser: null,
      env: {},
      execText: safeExecText,
      killProcess: safeKillProcess,
      spawnDetached: safeSpawnDetached,
    });

    const status = await ctl.status();
    expect(status).toMatchObject({
      available: false,
      installed: true,
      bound: false,
      running: false,
      reason: REMOTE_DESKTOP_LOCAL_DAEMON_REASON.NO_ACTIVE_USER,
      canControl: false,
      canBind: false,
      canViewLogs: false,
      runtimeSource: REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE.BUNDLE,
      version: '1.4.0',
    });
    expect(status.userName).toBeUndefined();
  });

  it('ignores stale daemon.pid, redacts tokens from errors/status, and omits secret fields from server.json', async () => {
    const root = makeTempDir();
    const home = join(root, 'home');
    const stateDir = join(home, '.imcodes');
    mkdirSync(stateDir, { recursive: true });
    const bundleDir = createFakeBundle(root, '1.5.0', 'linux');

    writeFileSync(join(stateDir, 'server.json'), JSON.stringify({
      serverId: 'srv_123',
      token: 'super-secret-daemon-token-do-not-leak',
      workerUrl: 'https://deck.example.test:8443/some/ignored/path?token=leaked',
      serverName: 'devbox',
    }));
    writeFileSync(join(stateDir, 'daemon.pid'), '999999\n');
    writeFileSync(join(stateDir, 'daemon-runtime.json'), JSON.stringify({
      pid: 999999,
      startedAt: Date.now() - 5000,
      updatedAt: Date.now(),
      restartCount: 0,
      serverLink: {
        state: 'connected',
        updatedAt: Date.now(),
        lastError: 'Bearer secret_abc failed at /bind/xyz123',
      },
    }));

    const user: ActiveDesktopUser = { platform: 'linux', username: 'alice', home, uid: 1000, gid: 1000 };
    const ctl = createLocalDaemonController({
      platform: 'linux',
      env: {},
      bundleDirs: [bundleDir],
      activeUser: user,
      isPidAlive: () => false,
      execText: async () => {
        throw Object.assign(new Error('disabled'), { stdout: 'disabled', stderr: '' });
      },
      killProcess: safeKillProcess,
      spawnDetached: safeSpawnDetached,
    });

    const status = await ctl.status();
    expect(status.running).toBe(false);
    expect(status.pid).toBeUndefined();
    expect(status.connectionState).toBe(REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE.DISCONNECTED);
    expect(status.serverId).toBe('srv_123');
    expect(status.serverHost).toBe('deck.example.test:8443');
    expect(status.serverOrigin).toBe('https://deck.example.test:8443');
    expect(status.lastError).not.toContain('secret_abc');
    expect(status.lastError).not.toContain('xyz123');
    expect(JSON.stringify(status)).not.toContain('super-secret-daemon-token-do-not-leak');
  });

  it('reads bounded <= 64 KiB sanitized daemon logs and rejects outside symlinks', async () => {
    const root = makeTempDir();
    const home = join(root, 'home');
    const stateDir = join(home, '.imcodes');
    const logsDir = join(stateDir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    const outsideSecret = join(root, 'outside.txt');
    writeFileSync(outsideSecret, 'TOP SECRET OUTSIDE\n');

    const user: ActiveDesktopUser = { platform: 'linux', username: 'alice', home, uid: 1000, gid: 1000 };
    const ctl = createLocalDaemonController({
      platform: 'linux',
      env: {},
      activeUser: user,
      execText: safeExecText,
      killProcess: safeKillProcess,
      spawnDetached: safeSpawnDetached,
    });

    // 1) Symlink escape is skipped cleanly.
    symlinkSync(outsideSecret, join(logsDir, 'daemon.log'));
    const escapedLogs = await ctl.logs();
    expect(escapedLogs.text).toBe('');

    // 2) Real oversized log is bounded to <= 64 KiB, control chars stripped, tokens redacted.
    rmSync(join(logsDir, 'daemon.log'));
    const prefixChunk = 'old-line-0123456789abcdef\n'.repeat(3200); // > 80 KiB
    const tailLine = '\u001b[31mWARN\u001b[0m Bearer my_bearer_tok token=inline_tok_99 /bind/bindkey_88 \u0007hello\n';
    writeFileSync(join(logsDir, 'daemon.log'), prefixChunk + tailLine);

    const bounded = await ctl.logs();
    expect(bounded.truncated).toBe(true);
    expect(Buffer.byteLength(bounded.text, 'utf8')).toBeLessThanOrEqual(CODING_DAEMON_LOG_MAX_BYTES);
    expect(bounded.text).toContain('WARN');
    expect(bounded.text).toContain('hello');
    expect(bounded.text).not.toContain('\u001b');
    expect(bounded.text).not.toContain('\u0007');
    expect(bounded.text).not.toContain('my_bearer_tok');
    expect(bounded.text).not.toContain('inline_tok_99');
    expect(bounded.text).not.toContain('bindkey_88');
  });
});

describe('createLocalDaemonController user-session lifecycle & bind', () => {
  it('manages macOS LaunchAgent inside gui/<uid> without root domain', async () => {
    const root = makeTempDir();
    const home = join(root, 'Users', 'alice');
    const stateDir = join(home, '.imcodes');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'server.json'), JSON.stringify({
      serverId: 'srv_mac',
      token: 'tok',
      workerUrl: 'https://app.example.test',
    }));
    const bundleDir = createFakeBundle(root, '1.2.0', 'darwin');
    const calls: Array<{ file: string; args: readonly string[] }> = [];

    const ctl = createLocalDaemonController({
      platform: 'darwin',
      env: {},
      bundleDirs: [bundleDir],
      currentUid: () => 0,
      currentGid: () => 0,
      activeUser: { platform: 'darwin', username: 'alice', home, uid: 501, gid: 20, tempDir: root },
      isPidAlive: () => false,
      execText: async (file, args) => {
        calls.push({ file, args });
        return { stdout: '', stderr: '' };
      },
      killProcess: safeKillProcess,
      spawnDetached: safeSpawnDetached,
    });

    const autoRes = await ctl.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.ENABLE_AUTOSTART);
    expect(autoRes.ok).toBe(true);
    const plistPath = join(home, 'Library', 'LaunchAgents', 'imcodes.daemon.plist');
    const plistContent = readFileSync(plistPath, 'utf8');
    expect(plistContent).toContain('<key>RunAtLoad</key>');
    expect(plistContent).toContain('<true/>');
    expect(plistContent).toContain(join(bundleDir, 'bin', 'node'));
    expect(calls.some((c) => c.args[0] === 'enable' && c.args[1] === 'gui/501/imcodes.daemon')).toBe(true);
    expect(calls.some((c) => c.args[0] === 'bootstrap' && c.args[1] === 'gui/501')).toBe(true);

    calls.length = 0;
    const disableRes = await ctl.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.DISABLE_AUTOSTART);
    expect(disableRes.ok).toBe(true);
    expect(disableRes.status?.autostart).toBe(REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.DISABLED);
    expect(readFileSync(plistPath, 'utf8')).toContain('<false/>');
    expect(calls.some((c) => c.args[0] === 'disable')).toBe(false);

    // Manual start & restart after disabling autostart keeps autostart disabled while bootstrapping & kickstarting.
    calls.length = 0;
    const startRes = await ctl.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.START);
    expect(startRes.ok).toBe(true);
    expect(startRes.status?.autostart).toBe(REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.DISABLED);
    expect(calls.some((c) => c.args[0] === 'enable' && c.args[1] === 'gui/501/imcodes.daemon')).toBe(true);
    expect(calls.some((c) => c.args[0] === 'bootstrap' && c.args[1] === 'gui/501')).toBe(true);
    expect(calls.some((c) => c.args[0] === 'kickstart' && c.args[2] === 'gui/501/imcodes.daemon')).toBe(true);

    const restartRes = await ctl.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.RESTART);
    expect(restartRes.ok).toBe(true);
    expect(restartRes.status?.autostart).toBe(REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.DISABLED);

    const reEnableRes = await ctl.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.ENABLE_AUTOSTART);
    expect(reEnableRes.ok).toBe(true);
    expect(reEnableRes.status?.autostart).toBe(REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.ENABLED);
  });

  it('manages Linux systemd user service as uid/gid and falls back to detached non-root spawn', async () => {
    const root = makeTempDir();
    const home = join(root, 'home', 'bob');
    const stateDir = join(home, '.imcodes');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'server.json'), JSON.stringify({
      serverId: 'srv_lin',
      token: 'tok',
      workerUrl: 'https://app.example.test',
    }));
    const bundleDir = createFakeBundle(root, '1.3.0', 'linux');

    const execCalls: Array<{ file: string; args: readonly string[]; uid?: number; gid?: number }> = [];
    const spawnCalls: Array<{ file: string; args: readonly string[]; uid?: number; gid?: number }> = [];

    // Case 1: systemd --user available
    const ctlSystemd = createLocalDaemonController({
      platform: 'linux',
      env: {},
      bundleDirs: [bundleDir],
      currentUid: () => 0,
      currentGid: () => 0,
      activeUser: { platform: 'linux', username: 'bob', home, uid: 1001, gid: 1001 },
      isPidAlive: () => false,
      execText: async (file, args, opts) => {
        execCalls.push({ file, args, uid: opts?.uid, gid: opts?.gid });
        return { stdout: 'enabled', stderr: '' };
      },
      killProcess: safeKillProcess,
      spawnDetached: safeSpawnDetached,
    });
    const startSystemd = await ctlSystemd.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.START);
    expect(startSystemd.ok).toBe(true);
    expect(execCalls.some((c) => c.file === 'systemctl' && c.args.includes('start') && c.uid === 1001 && c.gid === 1001)).toBe(true);

    // Case 2: systemd unavailable -> detached spawn strictly with uid/gid 1001 (never root!)
    const ctlDetached = createLocalDaemonController({
      platform: 'linux',
      env: {},
      bundleDirs: [bundleDir],
      currentUid: () => 0,
      currentGid: () => 0,
      activeUser: { platform: 'linux', username: 'bob', home, uid: 1001, gid: 1001 },
      isPidAlive: () => false,
      execText: async () => {
        throw new Error('no dbus');
      },
      killProcess: safeKillProcess,
      spawnDetached: (file, args, opts) => {
        spawnCalls.push({ file, args, uid: opts.uid, gid: opts.gid });
      },
    });
    const startDetached = await ctlDetached.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.START);
    expect(startDetached.ok).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].uid).toBe(1001);
    expect(spawnCalls[0].gid).toBe(1001);
    expect(spawnCalls[0].args).toContain('start');
  });

  it('handles Windows user startup toggle and bind flow without exposing secrets in CLI argv', async () => {
    const root = makeTempDir();
    const home = join(root, 'Users', 'carol');
    const stateDir = join(home, '.imcodes');
    mkdirSync(stateDir, { recursive: true });
    const bundleDir = createFakeBundle(root, '1.6.0', 'win32');

    const spawnCalls: Array<{ file: string; args: readonly string[] }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://app.example.test/api/bind/direct');
      expect((init?.headers as Record<string, string>)?.Authorization).toBe('Bearer secret_bind_key_42');
      return new Response(JSON.stringify({ serverId: 'srv_win_9', token: 'issued_secret_tok_9' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const ctl = createLocalDaemonController({
      platform: 'win32',
      env: { USERNAME: 'carol', USERPROFILE: home },
      bundleDirs: [bundleDir],
      activeUser: { platform: 'win32', username: 'carol', home },
      hostName: () => 'win-workstation',
      isPidAlive: () => false,
      execText: async () => {
        throw new Error('not found');
      },
      killProcess: safeKillProcess,
      spawnDetached: (file, args) => {
        spawnCalls.push({ file, args });
      },
      fetchImpl: fetchMock,
    });

    // Rejects unsafe/invalid bind URLs cleanly.
    const badScheme = await ctl.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.BIND, {
      bindUrl: 'ftp://app.example.test/bind/key1234',
    });
    expect(badScheme.ok).toBe(false);
    expect(badScheme.statusCode).toBe(400);

    const missingKey = await ctl.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.BIND, {
      bindUrl: 'https://app.example.test/not-bind',
    });
    expect(missingKey.ok).toBe(false);
    expect(missingKey.statusCode).toBe(400);

    // Valid bind writes 0600 server.json and restarts daemon without putting secrets in argv.
    const goodBind = await ctl.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.BIND, {
      bindUrl: 'https://app.example.test/bind/secret_bind_key_42',
    });
    expect(goodBind.ok).toBe(true);
    expect(goodBind.status?.bound).toBe(true);
    expect(goodBind.status?.serverId).toBe('srv_win_9');
    expect(goodBind.status?.serverHost).toBe('app.example.test');
    expect(JSON.stringify(goodBind)).not.toContain('secret_bind_key_42');
    expect(JSON.stringify(goodBind)).not.toContain('issued_secret_tok_9');

    const saved = JSON.parse(readFileSync(join(stateDir, 'server.json'), 'utf8')) as {
      serverId: string;
      token: string;
      workerUrl: string;
      serverName: string;
    };
    expect(saved.serverId).toBe('srv_win_9');
    expect(saved.token).toBe('issued_secret_tok_9');
    expect(saved.workerUrl).toBe('https://app.example.test');
    expect(saved.serverName).toBe('win-workstation');
    if (process.platform !== 'win32') {
      expect(statSync(join(stateDir, 'server.json')).mode & 0o777).toBe(0o600);
    }

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args.join(' ')).not.toContain('secret_bind_key_42');
    expect(spawnCalls[0].args.join(' ')).not.toContain('issued_secret_tok_9');

    // Toggle autostart in Windows Startup folder.
    const autoOn = await ctl.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.ENABLE_AUTOSTART);
    expect(autoOn.ok).toBe(true);
    expect(autoOn.status?.autostart).toBe(REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.ENABLED);

    const autoOff = await ctl.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.DISABLE_AUTOSTART);
    expect(autoOff.ok).toBe(true);
    expect(autoOff.status?.autostart).toBe(REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.DISABLED);
  });
});

describe('local-daemon-control F1-F5 security & lifecycle boundaries', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('../../src/node/user-session-launcher.js');
    vi.doUnmock('../../src/node/windows-user-session.js');
    vi.resetModules();
  });

  it('F1: rejects ancestor symlinked logs dir, symlinked server.json targets, and fail-closed chown failures', async () => {
    const root = makeTempDir();
    const home = join(root, 'home');
    const stateDir = join(home, '.imcodes');
    mkdirSync(stateDir, { recursive: true });
    const outsideDir = join(root, 'outside-dir');
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'daemon.log'), 'OUTSIDE DIRECTORY SECRET\n');

    // Ancestor symlink logs -> outsideDir must be rejected cleanly
    symlinkSync(outsideDir, join(stateDir, 'logs'));
    const user: ActiveDesktopUser = { platform: 'linux', username: 'alice', home, uid: 1000, gid: 1000 };
    const ctlLogs = createLocalDaemonController({
      platform: 'linux',
      env: {},
      activeUser: user,
      execText: safeExecText,
      killProcess: safeKillProcess,
      spawnDetached: safeSpawnDetached,
    });
    expect((await ctlLogs.logs()).text).toBe('');

    // Symlinked server.json pointing outside stateDir must neither read nor overwrite target
    const outsideTarget = join(root, 'outside-server.json');
    writeFileSync(outsideTarget, 'ORIGINAL_OUTSIDE_CONTENT');
    symlinkSync(outsideTarget, join(stateDir, 'server.json'));
    const bundleDir = createFakeBundle(root, '1.2.3', 'linux');
    const ctlBind = createLocalDaemonController({
      platform: 'linux',
      env: {},
      bundleDirs: [bundleDir],
      activeUser: user,
      isPidAlive: () => false,
      execText: safeExecText,
      killProcess: safeKillProcess,
      spawnDetached: safeSpawnDetached,
      fetchImpl: (async () => new Response(JSON.stringify({ serverId: 'srv_x', token: 'tok_x' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    });
    expect((await ctlBind.status()).bound).toBe(false);
    const bindSymlink = await ctlBind.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.BIND, {
      bindUrl: 'https://app.example.test/bind/key1234',
    });
    expect(bindSymlink.ok).toBe(false);
    expect(readFileSync(outsideTarget, 'utf8')).toBe('ORIGINAL_OUTSIDE_CONTENT');

    // Fail-closed fchown rejection when running privileged (currentUid === 0)
    rmSync(join(stateDir, 'server.json'), { force: true });
    const ctlChownFail = createLocalDaemonController({
      platform: 'linux',
      env: {},
      bundleDirs: [bundleDir],
      currentUid: () => 0,
      currentGid: () => 0,
      activeUser: user,
      isPidAlive: () => false,
      execText: safeExecText,
      killProcess: safeKillProcess,
      spawnDetached: safeSpawnDetached,
      fchown: () => {
        throw Object.assign(new Error('fchown EPERM'), { code: 'EPERM' });
      },
      fetchImpl: (async () => new Response(JSON.stringify({ serverId: 'srv_x', token: 'tok_x' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    });
    const chownFailRes = await ctlChownFail.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.BIND, {
      bindUrl: 'https://app.example.test/bind/key1234',
    });
    expect(chownFailRes.ok).toBe(false);
    expect(existsSync(join(stateDir, 'server.json'))).toBe(false);
  });

  it('F1+F3: never escalates failed macOS/Linux user stop to host root kill and aborts STOP/RESTART truthfully', async () => {
    const root = makeTempDir();
    const home = join(root, 'Users', 'alice');
    const stateDir = join(home, '.imcodes');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'server.json'), JSON.stringify({
      serverId: 'srv_mac',
      token: 'tok',
      workerUrl: 'https://app.example.test',
    }));
    writeFileSync(join(stateDir, 'daemon.pid'), '424242\n');
    const bundleDir = createFakeBundle(root, '1.2.3', 'darwin');

    vi.resetModules();
    vi.doMock('../../src/node/user-session-launcher.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/node/user-session-launcher.js')>(
        '../../src/node/user-session-launcher.js',
      );
      return {
        ...actual,
        runMacosUserSessionCommand: vi.fn(async () => {
          throw new Error('user session kill rejected');
        }),
      };
    });

    const { createLocalDaemonController: createIsolatedCtl } = await import('../../src/node/local-daemon-control.js');
    const rootKills: number[] = [];
    const startedCommands: string[][] = [];
    const ctl = createIsolatedCtl({
      platform: 'darwin',
      env: {},
      bundleDirs: [bundleDir],
      currentUid: () => 0,
      currentGid: () => 0,
      activeUser: { platform: 'darwin', username: 'alice', home, uid: 501, gid: 20, tempDir: root },
      isPidAlive: () => true,
      killProcess: (pid) => {
        rootKills.push(pid);
      },
      execText: async (file, args) => {
        startedCommands.push([...args]);
        if (file === 'ps') return { stdout: '501 /opt/imcodes/bin/imcodes start --foreground\n', stderr: '' };
        if (args[0] === 'bootout') throw new Error('bootout failed');
        return { stdout: '', stderr: '' };
      },
      spawnDetached: safeSpawnDetached,
      sleep: async () => {},
    });

    const stopRes = await ctl.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.STOP);
    expect(stopRes.ok).toBe(false);
    expect(stopRes.statusCode).toBe(500);
    expect(stopRes.error).toBe('stop_failed');
    expect(rootKills).toEqual([]);
    expect(readFileSync(join(stateDir, 'daemon.pid'), 'utf8')).toBe('424242\n');

    startedCommands.length = 0;
    const restartRes = await ctl.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.RESTART);
    expect(restartRes.ok).toBe(false);
    expect(restartRes.statusCode).toBe(500);
    expect(restartRes.error).toBe('stop_failed');
    expect(rootKills).toEqual([]);
    expect(startedCommands.some((args) => args[0] === 'bootstrap')).toBe(false);

    // Linux: privileged stop uses /bin/kill with uid/gid drop on verified daemon PID, never host killProcess
    const linuxStateDir = join(root, 'lin-home', '.imcodes');
    mkdirSync(linuxStateDir, { recursive: true });
    writeFileSync(join(linuxStateDir, 'server.json'), JSON.stringify({
      serverId: 'srv_lin',
      token: 'tok',
      workerUrl: 'https://app.example.test',
    }));
    const realUid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    const realGid = typeof process.getgid === 'function' ? process.getgid() : 1000;
    const dummyDaemon = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)', 'imcodes-daemon-dummy'], {
      stdio: 'ignore',
    });
    try {
      const dummyPid = dummyDaemon.pid!;
      writeFileSync(join(linuxStateDir, 'daemon.pid'), `${dummyPid}\n`);
      const linuxKillCalls: Array<{ file: string; args: readonly string[]; uid?: number; gid?: number }> = [];
      let linuxAlive = true;
      const ctlLin = createLocalDaemonController({
        platform: 'linux',
        env: {},
        bundleDirs: [bundleDir],
        currentUid: () => 0,
        currentGid: () => 0,
        activeUser: { platform: 'linux', username: 'bob', home: join(root, 'lin-home'), uid: realUid, gid: realGid },
        isPidAlive: () => linuxAlive,
        killProcess: (pid) => {
          rootKills.push(pid);
        },
        execText: async (file, args, opts) => {
          if (file === '/bin/kill' || file === 'kill') {
            linuxKillCalls.push({ file, args, uid: opts?.uid, gid: opts?.gid });
            linuxAlive = false;
          }
          return { stdout: '', stderr: '' };
        },
        spawnDetached: safeSpawnDetached,
        sleep: async () => {},
      });
      const linStop = await ctlLin.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.STOP);
      expect(linStop.ok).toBe(true);
      expect(rootKills).toEqual([]);
      expect(linuxKillCalls).toHaveLength(1);
      expect(linuxKillCalls[0]?.uid).toBe(realUid);
      expect(linuxKillCalls[0]?.gid).toBe(realGid);
    } finally {
      dummyDaemon.kill('SIGKILL');
    }
  });

  it('F2: redacts JSON, quoted, KV, Bearer, and bind secrets while preserving benign words', () => {
    const sample = [
      'tokenizer ready; token count: 42',
      'auth header Bearer eyJhbGciOiJIUzI1NiJ9.secret_sig',
      'url https://app.example.test/bind/secret-bind-key-99?token=query_secret_1',
      '{"token":"json-tok-secret","apiKey":"json-key-secret","bindKey":"bk-secret","access_token":"at-secret"}',
      "kv api_key='single_quoted_secret' secret=raw_secret_val",
    ].join('\n');

    const redacted = redactDaemonSecrets(sample);
    expect(redacted).toContain('tokenizer ready; token count: 42');
    expect(redacted).not.toContain('secret_sig');
    expect(redacted).not.toContain('secret-bind-key-99');
    expect(redacted).not.toContain('query_secret_1');
    expect(redacted).not.toContain('json-tok-secret');
    expect(redacted).not.toContain('json-key-secret');
    expect(redacted).not.toContain('bk-secret');
    expect(redacted).not.toContain('at-secret');
    expect(redacted).not.toContain('single_quoted_secret');
    expect(redacted).not.toContain('raw_secret_val');
  });

  it('F3: surfaces delayed async Windows SYSTEM launch failures and aborts hung binds while releasing mutex', async () => {
    const root = makeTempDir();
    const home = join(root, 'Users', 'carol');
    const stateDir = join(home, '.imcodes');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'server.json'), JSON.stringify({
      serverId: 'srv_win',
      token: 'tok',
      workerUrl: 'https://app.example.test',
    }));
    const bundleDir = createFakeBundle(root, '1.6.0', 'win32');

    vi.resetModules();
    vi.doMock('../../src/node/windows-user-session.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/node/windows-user-session.js')>(
        '../../src/node/windows-user-session.js',
      );
      return {
        ...actual,
        launchWindowsActiveUserCommand: vi.fn((...args: unknown[]) => {
          const onFailure = args[6] as ((detail: string) => void) | undefined;
          setTimeout(() => onFailure?.('CreateProcessAsUser failed'), 10);
        }),
      };
    });

    const { createLocalDaemonController: createIsolatedCtl } = await import('../../src/node/local-daemon-control.js');
    const ctlWinFail = createIsolatedCtl({
      platform: 'win32',
      env: { USERNAME: 'SYSTEM', USERPROFILE: 'C:\\Windows\\System32\\config\\systemprofile' },
      bundleDirs: [bundleDir],
      activeUser: { platform: 'win32', username: 'carol', home },
      isPidAlive: () => false,
      execText: safeExecText,
      killProcess: safeKillProcess,
      spawnDetached: safeSpawnDetached,
      windowsLaunchSettleMs: 50,
    });
    const startFail = await ctlWinFail.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.START);
    expect(startFail.ok).toBe(false);
    expect(startFail.statusCode).toBe(500);

    // Hung fetch bind must time out cleanly and unblock subsequent actions
    const linHome = join(root, 'lin-bind-home');
    const linStateDir = join(linHome, '.imcodes');
    mkdirSync(linStateDir, { recursive: true });
    const linBundle = createFakeBundle(join(root, 'lin-b'), '1.6.0', 'linux');
    const ctlHung = createLocalDaemonController({
      platform: 'linux',
      env: {},
      bundleDirs: [linBundle],
      activeUser: { platform: 'linux', username: 'bob', home: linHome, uid: 1000, gid: 1000 },
      isPidAlive: () => false,
      execText: safeExecText,
      killProcess: safeKillProcess,
      spawnDetached: safeSpawnDetached,
      bindTimeoutMs: 40,
      fetchImpl: (() => new Promise<Response>(() => {})) as unknown as typeof fetch,
    });
    const hungRes = await ctlHung.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.BIND, {
      bindUrl: 'https://app.example.test/bind/key_hung_1',
    });
    expect(hungRes.ok).toBe(false);
    expect(hungRes.statusCode).toBe(504);
    expect(hungRes.error).toBe('bind_timeout');

    const followUp = await ctlHung.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.STOP);
    expect(followUp.ok).toBe(true);
  });

  it('F4: supports scoped IMCODES_HOME LaunchAgent label & systemd unit without hardcoded service names', async () => {
    const root = makeTempDir();
    const home = join(root, 'home');
    const customState = join(root, 'scoped-state');
    mkdirSync(customState, { recursive: true });
    writeFileSync(join(customState, 'server.json'), JSON.stringify({
      serverId: 'srv_scoped',
      token: 'tok',
      workerUrl: 'https://app.example.test',
    }));
    const env = { IMCODES_HOME: customState };
    const expected = resolvePosixDaemonServicePaths({ ...env, HOME: home });
    expect(expected.scoped).toBe(true);

    // macOS scoped lifecycle
    const macCalls: string[][] = [];
    const macBundle = createFakeBundle(join(root, 'mac'), '1.2.0', 'darwin');
    const ctlMac = createLocalDaemonController({
      platform: 'darwin',
      env,
      bundleDirs: [macBundle],
      currentUid: () => 501,
      currentGid: () => 20,
      activeUser: { platform: 'darwin', username: 'alice', home, uid: 501, gid: 20, tempDir: root },
      isPidAlive: () => false,
      execText: async (_file, args) => {
        macCalls.push([...args]);
        return { stdout: '', stderr: '' };
      },
      killProcess: safeKillProcess,
      spawnDetached: safeSpawnDetached,
    });

    const macAutoOn = await ctlMac.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.ENABLE_AUTOSTART);
    expect(macAutoOn.ok).toBe(true);
    expect(macAutoOn.status?.autostart).toBe(REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.ENABLED);
    const macPlistPath = join(home, 'Library', 'LaunchAgents', `${expected.launchAgentLabel}.plist`);
    const plistText = readFileSync(macPlistPath, 'utf8');
    expect(plistText).toContain(`<string>${expected.launchAgentLabel}</string>`);
    expect(plistText).not.toContain('<string>imcodes.daemon</string>');
    expect(macCalls.some((a) => a[0] === 'enable' && a[1] === `gui/501/${expected.launchAgentLabel}`)).toBe(true);

    // Linux scoped lifecycle
    const linCalls: string[][] = [];
    const linBundle = createFakeBundle(join(root, 'lin'), '1.2.0', 'linux');
    const ctlLin = createLocalDaemonController({
      platform: 'linux',
      env,
      bundleDirs: [linBundle],
      currentUid: () => 1001,
      currentGid: () => 1001,
      activeUser: { platform: 'linux', username: 'bob', home, uid: 1001, gid: 1001 },
      isPidAlive: () => false,
      execText: async (_file, args) => {
        linCalls.push([...args]);
        return { stdout: args[1] === 'is-enabled' ? 'enabled' : '', stderr: '' };
      },
      killProcess: safeKillProcess,
      spawnDetached: safeSpawnDetached,
    });
    const linStart = await ctlLin.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.START);
    expect(linStart.ok).toBe(true);
    expect(linStart.status?.autostart).toBe(REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART.ENABLED);
    expect(linCalls.some((a) => a[1] === 'start' && a[2] === expected.systemdUnitName)).toBe(true);
  });

  it('F5: prioritizes userHome npm over SYSTEM %APPDATA%, preserves NVM bin PATH, and quotes paths with spaces', async () => {
    const root = makeTempDir();
    // 1) Windows SYSTEM %APPDATA% shadowing prevention
    const winUserHome = join(root, 'Users', 'Carol User');
    const winUserNpm = join(winUserHome, 'AppData', 'Roaming', 'npm');
    const systemAppData = join(root, 'Windows', 'System32', 'config', 'systemprofile', 'AppData', 'Roaming');
    mkdirSync(join(winUserNpm, 'node_modules', 'imcodes', 'dist', 'src'), { recursive: true });
    mkdirSync(join(systemAppData, 'npm'), { recursive: true });
    writeFileSync(join(winUserNpm, 'imcodes.cmd'), '@echo off\r\n');
    writeFileSync(join(winUserNpm, 'node_modules', 'imcodes', 'package.json'), JSON.stringify({ name: 'imcodes', version: '3.1.0' }));
    writeFileSync(join(winUserNpm, 'node_modules', 'imcodes', 'dist', 'src', 'index.js'), 'export {};\n');
    writeFileSync(join(systemAppData, 'npm', 'imcodes.cmd'), '@echo off\r\n');

    const discoveredWin = discoverCodingDaemonRuntime({
      platform: 'win32',
      env: { APPDATA: systemAppData, USERNAME: 'SYSTEM', USERPROFILE: 'C:\\Windows\\System32\\config\\systemprofile' },
      userHome: winUserHome,
      execPath: join(root, 'aidesk.exe'),
      bundleDirs: [join(root, 'no-bundle')],
    });
    expect(discoveredWin?.source).toBe(REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE.CLI);
    expect(discoveredWin?.version).toBe('3.1.0');
    expect(discoveredWin?.foregroundArgs.join(' ')).toContain(winUserNpm);
    expect(discoveredWin?.foregroundArgs.join(' ')).not.toContain('systemprofile');

    // 2) POSIX NVM CLI bin dir prepended to service PATH + space quoting in systemd unit
    const spacedHome = join(root, 'home', 'Alice Smith');
    const nvmBin = join(spacedHome, '.nvm', 'versions', 'node', 'v22.12.0', 'bin');
    const nvmPkg = join(spacedHome, '.nvm', 'versions', 'node', 'v22.12.0', 'lib', 'node_modules', 'imcodes');
    mkdirSync(nvmBin, { recursive: true });
    mkdirSync(nvmPkg, { recursive: true });
    writeFileSync(join(nvmPkg, 'package.json'), JSON.stringify({ name: 'imcodes', version: '2.4.0' }));
    const nvmCli = join(nvmBin, 'imcodes');
    writeFileSync(nvmCli, '#!/usr/bin/env node\n', { mode: 0o755 });
    chmodSync(nvmCli, 0o755);

    const linState = join(spacedHome, '.imcodes');
    mkdirSync(linState, { recursive: true });
    writeFileSync(join(linState, 'server.json'), JSON.stringify({
      serverId: 'srv_nvm',
      token: 'tok',
      workerUrl: 'https://app.example.test',
    }));
    const ctlLinNvm = createLocalDaemonController({
      platform: 'linux',
      env: {},
      bundleDirs: [join(root, 'no-bundle')],
      currentUid: () => 1000,
      currentGid: () => 1000,
      activeUser: { platform: 'linux', username: 'Alice Smith', home: spacedHome, uid: 1000, gid: 1000 },
      isPidAlive: () => false,
      execText: async () => ({ stdout: 'enabled', stderr: '' }),
      killProcess: safeKillProcess,
      spawnDetached: safeSpawnDetached,
    });
    const linRes = await ctlLinNvm.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.START);
    expect(linRes.ok).toBe(true);
    const unitText = readFileSync(join(spacedHome, '.config', 'systemd', 'user', 'imcodes.service'), 'utf8');
    expect(unitText).toContain(`ExecStart="${nvmCli}" start --foreground`);
    expect(unitText).toContain(`Environment="HOME=${spacedHome}"`);
    expect(unitText).toContain(`Environment="PATH=${nvmBin}:`);
  });

  it('VITEST guard: refuses default real execText/killProcess/spawnDetached when mocks are omitted', async () => {
    const root = makeTempDir();
    const home = join(root, 'lin-guard-home');
    const stateDir = join(home, '.imcodes');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'server.json'), JSON.stringify({
      serverId: 'srv_guard',
      token: 'tok',
      workerUrl: 'https://app.example.test',
    }));
    writeFileSync(join(stateDir, 'daemon.pid'), '999998\n');
    const linBundle = createFakeBundle(join(root, 'lin-g'), '1.0.0', 'linux');
    // Intentionally omit execText / killProcess / spawnDetached to verify fail-closed VITEST guard
    const ctlNoMocks = createLocalDaemonController({
      platform: 'linux',
      env: {},
      bundleDirs: [linBundle],
      currentUid: () => 1000,
      currentGid: () => 1000,
      activeUser: { platform: 'linux', username: 'bob', home, uid: 1000, gid: 1000 },
      isPidAlive: () => true,
      stopWaitMs: 10,
    });
    const res = await ctlNoMocks.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.STOP);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('stop_failed');
  });

  it('F1-R2(a): resolves daemon PID identity (match/mismatch/unknown) consistently across status, START, STOP, RESTART, and BIND', async () => {
    const root = makeTempDir();
    const home = join(root, 'Users', 'alice');
    const stateDir = join(home, '.imcodes');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'server.json'), JSON.stringify({
      serverId: 'srv_id',
      token: 'tok',
      workerUrl: 'https://app.example.test',
    }));
    const bundleDir = createFakeBundle(join(root, 'mac'), '1.4.0', 'darwin');
    const commands: string[][] = [];
    const kills: number[] = [];
    let psLine = '501 /usr/bin/sleep 60\n';

    const makeMacCtl = (aliveFn: (pid: number) => boolean) => createLocalDaemonController({
      platform: 'darwin',
      env: {},
      bundleDirs: [bundleDir],
      currentUid: () => 501,
      currentGid: () => 20,
      activeUser: { platform: 'darwin', username: 'alice', home, uid: 501, gid: 20, tempDir: root },
      isPidAlive: aliveFn,
      killProcess: (pid) => { kills.push(pid); },
      execText: async (file, args) => {
        commands.push([file, ...args]);
        if (file === 'ps') return { stdout: psLine, stderr: '' };
        return { stdout: '', stderr: '' };
      },
      spawnDetached: safeSpawnDetached,
      fetchImpl: (async () => new Response(JSON.stringify({ serverId: 'srv_new', token: 'tok_new' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
      sleep: async () => {},
    });

    // 1) Mismatch: live unrelated process (sleep) at stale daemon.pid must NOT look running, must NOT be killed, and must NOT block START/RESTART/BIND
    writeFileSync(join(stateDir, 'daemon.pid'), '424242\n');
    const ctlMismatch = makeMacCtl((pid) => pid === 424242);
    const mismatchStatus = await ctlMismatch.status();
    expect(mismatchStatus.running).toBe(false);
    expect(mismatchStatus.pid).toBeUndefined();

    const startFromMismatch = await ctlMismatch.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.START);
    expect(startFromMismatch.ok).toBe(true);
    expect(kills).toEqual([]);
    expect(commands.some((c) => c[1] === 'bootstrap')).toBe(true);
    expect(existsSync(join(stateDir, 'daemon.pid'))).toBe(false);

    commands.length = 0;
    writeFileSync(join(stateDir, 'daemon.pid'), '424242\n');
    const restartFromMismatch = await ctlMismatch.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.RESTART);
    expect(restartFromMismatch.ok).toBe(true);
    expect(kills).toEqual([]);
    expect(commands.some((c) => c[1] === 'bootstrap')).toBe(true);

    // 2) Match positive control + fallback from dead/mismatched daemon.pid to live matching daemon-runtime.json PID
    psLine = '501 /opt/imcodes/daemon-runtime/bin/node /opt/imcodes/package/dist/src/index.js start --foreground\n';
    writeFileSync(join(stateDir, 'daemon.pid'), '999991\n'); // dead filePid
    writeFileSync(join(stateDir, 'daemon-runtime.json'), JSON.stringify({
      pid: 313131,
      startedAt: Date.now() - 1_000,
      updatedAt: Date.now(),
      restartCount: 0,
      serverLink: { state: 'connected', updatedAt: Date.now() },
    }));
    const ctlMatch = createLocalDaemonController({
      platform: 'darwin',
      env: {},
      bundleDirs: [bundleDir],
      currentUid: () => 501,
      currentGid: () => 20,
      activeUser: { platform: 'darwin', username: 'alice', home, uid: 501, gid: 20, tempDir: root },
      isPidAlive: (pid) => pid === 313131,
      killProcess: (pid) => { kills.push(pid); },
      execText: async (file, args) => {
        commands.push([file, ...args]);
        if (file === 'ps') return { stdout: psLine, stderr: '' };
        return { stdout: '', stderr: '' };
      },
      spawnDetached: safeSpawnDetached,
      sleep: async () => {},
    });
    const matchStatus = await ctlMatch.status();
    expect(matchStatus.running).toBe(true);
    expect(matchStatus.pid).toBe(313131);

    commands.length = 0;
    const startWhenRunning = await ctlMatch.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.START);
    expect(startWhenRunning.ok).toBe(true);
    expect(commands.some((c) => c[1] === 'bootstrap')).toBe(false);

    // 3) Unknown: unverified live PID returns conservative diagnostic & blocks duplicate START without killing PID
    writeFileSync(join(stateDir, 'daemon.pid'), '555555\n');
    psLine = '';
    commands.length = 0;
    const ctlUnknown = makeMacCtl((pid) => pid === 555555);
    const unknownStatus = await ctlUnknown.status();
    expect(unknownStatus.running).toBe(false);
    expect(unknownStatus.pid).toBeUndefined();
    expect(unknownStatus.connectionState).toBe(REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE.UNKNOWN);
    expect(unknownStatus.lastError).toContain('daemon_pid_unverified');

    const startUnknown = await ctlUnknown.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.START);
    expect(startUnknown.ok).toBe(false);
    expect(startUnknown.statusCode).toBe(409);
    expect(startUnknown.error).toBe('daemon_pid_unverified');
    expect(commands.some((c) => c[1] === 'bootstrap')).toBe(false);

    const stopUnknown = await ctlUnknown.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.STOP);
    expect(stopUnknown.ok).toBe(false);
    expect(kills).toEqual([]);

    // 4) Linux real /proc mismatch: current test node PID is alive & owned by user, NOT imcodes daemon
    const linHome = join(root, 'lin-proc-home');
    const linState = join(linHome, '.imcodes');
    mkdirSync(linState, { recursive: true });
    writeFileSync(join(linState, 'server.json'), JSON.stringify({
      serverId: 'srv_lin_p',
      token: 'tok',
      workerUrl: 'https://app.example.test',
    }));
    writeFileSync(join(linState, 'daemon.pid'), `${process.pid}\n`);
    const linSpawned: string[] = [];
    const linBundle = createFakeBundle(join(root, 'lin-p'), '1.4.0', 'linux');
    const ctlLinProc = createLocalDaemonController({
      platform: 'linux',
      env: {},
      bundleDirs: [linBundle],
      currentUid: () => process.getuid!(),
      currentGid: () => process.getgid!(),
      activeUser: { platform: 'linux', username: 'alice', home: linHome, uid: process.getuid!(), gid: process.getgid!() },
      isPidAlive: (pid) => pid === process.pid,
      execText: async (file, args) => {
        if (file === 'systemctl' && args[1] === 'show-environment') throw new Error('no systemd');
        return { stdout: '', stderr: '' };
      },
      killProcess: (pid) => { kills.push(pid); },
      spawnDetached: (file) => { linSpawned.push(file); },
    });
    expect((await ctlLinProc.status()).running).toBe(false);
    const linStartMismatch = await ctlLinProc.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.START);
    expect(linStartMismatch.ok).toBe(true);
    expect(linSpawned).toHaveLength(1);
    expect(kills).toEqual([]);
  });

  it('F1-R2(b): binds file/dir/log ownership to open validated fds and rejects tmp swap, log symlink, and runtime status symlink', async () => {
    const root = makeTempDir();
    const home = join(root, 'home');
    const stateDir = join(home, '.imcodes');
    mkdirSync(stateDir, { recursive: true });
    const outsideTarget = join(root, 'outside-protected');
    writeFileSync(outsideTarget, 'OUTSIDE_UNTOUCHED');
    const bundleDir = createFakeBundle(join(root, 'b'), '1.5.0', 'linux');

    // 1) Even if an external actor swaps the .tmp file inside stateDir for an outside symlink during fchown,
    //    ownership is bound to the open fd (never outsideTarget) and rename aborts fail-closed.
    const fchownFds: number[] = [];
    let swapped = false;
    const legacyChown = vi.fn();
    const ctlSwap = createLocalDaemonController({
      platform: 'linux',
      env: {},
      bundleDirs: [bundleDir],
      currentUid: () => 0,
      currentGid: () => 0,
      activeUser: { platform: 'linux', username: 'alice', home, uid: process.getuid!(), gid: process.getgid!() },
      isPidAlive: () => false,
      execText: async () => ({ stdout: 'enabled', stderr: '' }),
      killProcess: safeKillProcess,
      spawnDetached: safeSpawnDetached,
      chown: legacyChown,
      fchown: (fd) => {
        fchownFds.push(fd);
        if (!swapped) {
          const entries = readdirSync(stateDir);
          const tmpName = entries.find((n) => n.startsWith('server.json.') && n.endsWith('.tmp'));
          if (tmpName) {
            swapped = true;
            rmSync(join(stateDir, tmpName));
            symlinkSync(outsideTarget, join(stateDir, tmpName));
          }
        }
      },
      fetchImpl: (async () => new Response(JSON.stringify({ serverId: 'srv_swap', token: 'tok_swap' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    });
    const swapBind = await ctlSwap.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.BIND, {
      bindUrl: 'https://app.example.test/bind/key_swap_1',
    });
    expect(swapBind.ok).toBe(false);
    expect(swapped).toBe(true);
    expect(legacyChown).not.toHaveBeenCalled();
    expect(readFileSync(outsideTarget, 'utf8')).toBe('OUTSIDE_UNTOUCHED');
    expect(existsSync(join(stateDir, 'server.json'))).toBe(false);

    // 2) Outside symlink on daemon-runtime.json must not bypass readSafeDaemonRuntimeStatus
    const outsideRuntime = join(root, 'outside-runtime.json');
    writeFileSync(outsideRuntime, JSON.stringify({
      pid: 777777,
      startedAt: Date.now() - 1000,
      updatedAt: Date.now(),
      restartCount: 0,
      serverLink: { state: 'connected', updatedAt: Date.now(), lastError: 'LEAKED_OUTSIDE_RUNTIME' },
    }));
    symlinkSync(outsideRuntime, join(stateDir, 'daemon-runtime.json'));
    const statusWithSymlinkRuntime = await ctlSwap.status();
    expect(statusWithSymlinkRuntime.lastError).toBeUndefined();

    // 3) Outside symlink on fallback daemon.log must abort START cleanly; valid daemon.log uses fd-bound fchown only
    rmSync(join(stateDir, 'daemon-runtime.json'), { force: true });
    writeFileSync(join(stateDir, 'server.json'), JSON.stringify({
      serverId: 'srv_log',
      token: 'tok',
      workerUrl: 'https://app.example.test',
    }));
    symlinkSync(outsideTarget, join(stateDir, 'daemon.log'));
    const fallbackFchownFds: number[] = [];
    const fallbackSpawned: string[] = [];
    const ctlLog = createLocalDaemonController({
      platform: 'linux',
      env: {},
      bundleDirs: [bundleDir],
      currentUid: () => 0,
      currentGid: () => 0,
      activeUser: { platform: 'linux', username: 'alice', home, uid: process.getuid!(), gid: process.getgid!() },
      isPidAlive: () => false,
      execText: async (file, args) => {
        if (file === 'systemctl' && args[1] === 'show-environment') throw new Error('no systemd');
        return { stdout: '', stderr: '' };
      },
      killProcess: safeKillProcess,
      spawnDetached: (file) => { fallbackSpawned.push(file); },
      chown: legacyChown,
      fchown: (fd) => { fallbackFchownFds.push(fd); },
    });
    const logSymlinkStart = await ctlLog.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.START);
    expect(logSymlinkStart.ok).toBe(false);
    expect(fallbackSpawned).toEqual([]);
    expect(readFileSync(outsideTarget, 'utf8')).toBe('OUTSIDE_UNTOUCHED');

    // Positive control: normal fallback log creation uses fd ownership and launches cleanly
    rmSync(join(stateDir, 'daemon.log'), { force: true });
    fallbackFchownFds.length = 0;
    const logOkStart = await ctlLog.performAction(REMOTE_DESKTOP_LOCAL_DAEMON_ACTION.START);
    expect(logOkStart.ok).toBe(true);
    expect(fallbackFchownFds.length).toBeGreaterThanOrEqual(1);
    expect(legacyChown).not.toHaveBeenCalled();
    expect(fallbackSpawned).toHaveLength(1);
  });
});
