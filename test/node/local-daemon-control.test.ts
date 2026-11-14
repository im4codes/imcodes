import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REMOTE_DESKTOP_LOCAL_DAEMON_ACTION,
  REMOTE_DESKTOP_LOCAL_DAEMON_AUTOSTART,
  REMOTE_DESKTOP_LOCAL_DAEMON_CONNECTION_STATE,
  REMOTE_DESKTOP_LOCAL_DAEMON_REASON,
  REMOTE_DESKTOP_LOCAL_DAEMON_RUNTIME_SOURCE,
} from '../../shared/remote-desktop-local-management.js';
import {
  CODING_DAEMON_LOG_MAX_BYTES,
  createLocalDaemonController,
  discoverCodingDaemonRuntime,
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

afterEach(() => {
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
    const ctl = createLocalDaemonController({ platform: 'linux', env: {}, activeUser: user });

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
    expect(readFileSync(plistPath, 'utf8')).toContain('<false/>');
    expect(calls.some((c) => c.args[0] === 'disable' && c.args[1] === 'gui/501/imcodes.daemon')).toBe(true);
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
