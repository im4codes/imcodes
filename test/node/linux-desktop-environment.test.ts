import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LINUX_DESKTOP_PROVISION_FAILURE,
  linuxGraphicalDisplayAvailable,
  pickLinuxDesktopUser,
  provisionLinuxDesktopEnvironment,
} from '../../src/node/linux-desktop-environment.js';
import { desktopShellFixture } from './linux-desktop-shell-fixture.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(process.platform === 'win32')('real Bash desktop installer (no host commands)', () => {
  const script = join(__dirname, '../../scripts/install-linux-desktop-environment.sh');

  it.each([
    ['default automatic', ['--no-firefox'], false],
    ['optional VNC', ['--no-firefox', '--with-vnc', '--vnc-port', '5999'], true],
    ['existing Firefox', [], false],
  ] as const)('exits zero after %s success', async (_, args, vnc) => {
    const fixture = await desktopShellFixture(dirs, { firefox: true });
    const result = await fixture.run(script, args);
    expect(result.code).toBe(0);
    expect(result.output).toContain('== done ==');
    expect(result.output).toContain('DISPLAY=:99 as user ai');
    expect(result.output.includes('x11vnc listening on 127.0.0.1:5999')).toBe(vnc);
    const calls = await fixture.calls();
    expect(calls).toContain('apt-get install -y -qq xvfb x11-xserver-utils dbus-x11 xfce4 xfce4-whiskermenu-plugin fonts-noto-core fonts-noto-color-emoji pulseaudio');
    expect(calls.includes('x11vnc')).toBe(vnc);
    expect(calls).not.toContain('curl');
    expect(calls).not.toContain('install -y -qq firefox');
    expect(calls).toContain('modprobe snd-dummy'); // Explicit best effort stays non-fatal.
    expect(await readFile(join(fixture.root, 'etc/systemd/system/imcodes-desktop-session.service'), 'utf8'))
      .toContain('User=ai\nGroup=ai');
    const session = await readFile(join(fixture.root, 'usr/local/lib/imcodes/imcodes-desktop-session.sh'), 'utf8');
    expect(session.includes('firefox &')).toBe(args.length === 0);
    if (args.length === 0) expect(result.output).toContain('firefox already installed');
  });

  it('retains user/display/resolution arguments and succeeds on the last display probe', async () => {
    const fixture = await desktopShellFixture(dirs, { readyAt: 20 });
    expect((await fixture.run(script, ['--user', 'ai', '--display', ':101', '--resolution', '1280x720x24', '--no-firefox'])).code).toBe(0);
    expect(await readFile(join(fixture.root, 'probes'), 'utf8')).toBe('20');
    expect((await fixture.calls()).match(/sleep 0.5/g)).toHaveLength(19);
    expect(await readFile(join(fixture.root, 'etc/systemd/system/imcodes-desktop-xvfb.service'), 'utf8'))
      .toContain('ExecStart=/usr/bin/Xvfb :101 -screen 0 1280x720x24 -nolisten tcp -ac');
  });

  it.each(['apt-get update', 'apt-get install', 'systemctl daemon-reload',
    'systemctl enable --now imcodes-desktop-xvfb.service',
    'systemctl enable --now imcodes-desktop-session.service',
    'systemctl enable --now imcodes-desktop-vnc.service'])('does not mask %s failure', async (fail) => {
    const fixture = await desktopShellFixture(dirs, { fail });
    const result = await fixture.run(script, ['--no-firefox', '--with-vnc']);
    expect(result.code).toBe(fail.startsWith('apt') ? 100 : 7);
    expect(result.output).not.toContain('== done ==');
  });

  it('fails after the bounded display readiness retries without starting a session', async () => {
    const fixture = await desktopShellFixture(dirs, { readyAt: 21 });
    const result = await fixture.run(script, ['--no-firefox']);
    expect(result.code).toBe(1);
    expect(result.output).toContain('Xvfb did not become ready on display :99');
    expect(result.output).not.toContain('== done ==');
    expect(await readFile(join(fixture.root, 'probes'), 'utf8')).toBe('20');
    expect((await fixture.calls()).match(/sleep 0.5/g)).toHaveLength(20);
    expect(await fixture.calls()).not.toContain('enable --now imcodes-desktop-session');
  });

  it.each([
    [{ apt: false }, [], 'apt-based'],
    [{ euid: 1000 }, [], 'must run as root'],
    [{}, ['--user', 'missing'], 'no such user'],
    [{}, ['--display', '99'], '--display must look like'],
    [{}, ['--unknown'], 'unknown argument'],
    [{}, ['--user'], 'parameter'],
  ])('keeps preflight/argument errors fatal (%s %s)', async (options, args, diagnostic) => {
    const fixture = await desktopShellFixture(dirs, options);
    const result = await fixture.run(script, args);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain(diagnostic);
    expect(await fixture.calls()).not.toContain('apt-get update');
  });

  it.each([undefined, 'apt-get install', 'systemctl enable --now imcodes-desktop-session.service'])
    ('maps actual bundled shell exit to provider result (%s)', async (fail) => {
      const fixture = await desktopShellFixture(dirs, { fail });
      const result = await provisionLinuxDesktopEnvironment({
        supported: () => true, readPasswd: () => PASSWD, pickUser: () => 'ai',
        run: fixture.run,
      });
      expect(result).toMatchObject(fail
        ? { ok: false, reason: LINUX_DESKTOP_PROVISION_FAILURE.INSTALL_FAILED }
        : { ok: true, user: 'ai' });
    });
});

const PASSWD = [
  'root:x:0:0:root:/root:/bin/bash',
  'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
  'svc:x:998:998::/var/lib/svc:/bin/bash',
  'ghost:x:1000:1000::/home/ghost:/bin/bash',
  'ai:x:1001:1001::/home/ai:/bin/bash',
  'locked:x:1002:1002::/home/locked:/usr/sbin/nologin',
  'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin',
].join('\n');

describe('linux basic desktop environment', () => {
  it('sees a display only when an X server socket exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-x11-'));
    dirs.push(dir);
    expect(linuxGraphicalDisplayAvailable(dir)).toBe(false);
    await writeFile(join(dir, 'not-a-display'), '');
    expect(linuxGraphicalDisplayAvailable(dir)).toBe(false);
    await writeFile(join(dir, 'X99'), '');
    expect(linuxGraphicalDisplayAvailable(dir)).toBe(true);
    expect(linuxGraphicalDisplayAvailable(join(dir, 'missing'))).toBe(false);
  });

  it('runs the desktop as the primary human login, never root or a service account', () => {
    const homes = new Set(['/home/ai', '/home/locked']);
    expect(pickLinuxDesktopUser(PASSWD, (path) => homes.has(path))).toBe('ai');
    expect(pickLinuxDesktopUser(PASSWD, (path) => path === '/home/ghost' || path === '/home/ai')).toBe('ghost');
    expect(pickLinuxDesktopUser('root:x:0:0:root:/root:/bin/bash', () => true)).toBeNull();
  });

  it('installs the bundled recipe for that user, without Firefox', async () => {
    let scriptText = '';
    const run = vi.fn(async (scriptPath: string) => {
      scriptText = await readFile(scriptPath, 'utf8');
      return { code: 0, output: '== done ==' };
    });
    const result = await provisionLinuxDesktopEnvironment({
      supported: () => true,
      readPasswd: () => PASSWD,
      pickUser: () => 'ai',
      run,
    });
    expect(result).toEqual({ ok: true, user: 'ai' });
    expect(run).toHaveBeenCalledWith(expect.any(String), ['--user', 'ai', '--no-firefox']);
    // Byte for byte the operator script: one recipe, not a copy.
    expect(scriptText).toBe(await readFile(join(__dirname, '../../scripts/install-linux-desktop-environment.sh'), 'utf8'));
  });

  it('says why it could not', async () => {
    await expect(provisionLinuxDesktopEnvironment({ supported: () => false }))
      .resolves.toEqual({ ok: false, reason: LINUX_DESKTOP_PROVISION_FAILURE.UNSUPPORTED_DISTRO });
    await expect(provisionLinuxDesktopEnvironment({
      supported: () => true, readPasswd: () => PASSWD, pickUser: () => null,
    })).resolves.toEqual({ ok: false, reason: LINUX_DESKTOP_PROVISION_FAILURE.NO_DESKTOP_USER });
    await expect(provisionLinuxDesktopEnvironment({
      supported: () => true,
      readPasswd: () => PASSWD,
      pickUser: () => 'ai',
      run: async () => ({ code: 100, output: 'E: Unable to locate package xfce4' }),
    })).resolves.toMatchObject({
      ok: false,
      reason: LINUX_DESKTOP_PROVISION_FAILURE.INSTALL_FAILED,
      detail: expect.stringContaining('xfce4'),
    });
  });
});
