import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LINUX_DESKTOP_PROVISION_FAILURE,
  getLinuxDesktopManualInstallCommand,
  linuxGraphicalDisplayAvailable,
  pickLinuxDesktopUser,
  provisionLinuxDesktopEnvironment,
} from '../../src/node/linux-desktop-environment.js';
import { desktopShellFixture } from './linux-desktop-shell-fixture.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function resolveAndLaunchXfceHelper(root: string, url: string) {
  const helpersRc = await readFile(join(root, 'home/.config/xfce4/helpers.rc'), 'utf8');
  const match = /^WebBrowser=(.+)$/m.exec(helpersRc);
  expect(match?.[1]).toBeTruthy();
  const id = match![1].trim();
  const searchDirs = [
    join(root, 'home/.local/share/xfce4/helpers'),
    join(root, 'usr/local/share/xfce4/helpers'),
    join(root, 'usr/share/xfce4/helpers'),
  ];
  const desktopPath = searchDirs.map((dir) => join(dir, `${id}.desktop`)).find((p) => existsSync(p));
  expect(desktopPath).toBeTruthy();
  const desktop = await readFile(desktopPath!, 'utf8');
  expect(desktop).toContain('Type=X-XFCE-Helper');
  expect(desktop).toContain('X-XFCE-Category=WebBrowser');
  const binariesLine = /^X-XFCE-Binaries=(.+)$/m.exec(desktop)?.[1] ?? '';
  const commandLine = /^X-XFCE-CommandsWithParameter=(.+)$/m.exec(desktop)?.[1] ?? '';
  const binary = binariesLine.split(';').map((s) => s.trim()).find((b) => b && existsSync(join(root, 'bin', b)));
  expect(binary).toBeTruthy();
  const resolvedCmd = commandLine.replaceAll('%B', join(root, 'bin', binary!)).replaceAll('%s', url).replaceAll(';', '');
  const run = spawnSync('/bin/sh', ['-c', resolvedCmd], {
    encoding: 'utf8',
    env: { ...process.env, FIXTURE_ROOT: root },
  });
  expect(run.status).toBe(0);
  return { id, desktopPath: desktopPath!, binary: binary! };
}

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
    expect(calls).toContain('apt-get install -y -qq xvfb x11-utils x11-xserver-utils xauth dbus-x11 libx11-6 libxext6 libxtst6 libxfixes3 libxrandr2 xfce4');
    expect(calls).toContain('apt-get install -y -qq mousepad ristretto xarchiver xfce4-taskmanager xfce4-screenshooter unzip zip curl wget ca-certificates xfce4-whiskermenu-plugin fonts-noto-core fonts-noto-color-emoji -o DPkg::Lock::Timeout=180');
    expect(calls).toContain('apt-get install -y -qq pulseaudio -o DPkg::Lock::Timeout=180');
    expect(calls.includes('x11vnc')).toBe(vnc);
    expect(calls).not.toContain('curl -fsSL');
    expect(calls).not.toContain('install -y -qq firefox');
    expect(calls).toContain('modprobe snd-dummy'); // Explicit best effort stays non-fatal.
    const service = await readFile(join(fixture.root, 'etc/systemd/system/imcodes-desktop-session.service'), 'utf8');
    expect(service).toContain('User=ai\nGroup=ai\nEnvironment=XDG_SESSION_TYPE=x11');
    expect(service).not.toContain('Whisker Menu + firefox');
    const session = await readFile(join(fixture.root, 'usr/local/lib/imcodes/imcodes-desktop-session.sh'), 'utf8');
    expect(session).toContain('export XDG_SESSION_TYPE="x11"');
    expect(session).not.toContain('xfce4-panel --add');
    expect(session).not.toContain('firefox &');
    expect(session).toContain('exec startxfce4');
    expect((await readFile(join(fixture.root, 'usr/local/lib/imcodes/desktop-display'), 'utf8')).trim()).toBe(':99');
    if (args.length === 0) expect(result.output).toContain('firefox already installed');
  });

  it('installs Firefox via Mozilla APT repo with bounded curl timeouts and seeds helpers.rc as target user', async () => {
    const fixture = await desktopShellFixture(dirs, { curlOk: true, primaryGroup: 'users' });
    const result = await fixture.run(script, ['--user', 'ai']);
    expect(result.code).toBe(0);
    const calls = await fixture.calls();
    expect(calls).toContain('curl -fsSL --connect-timeout 15 --max-time 60 https://packages.mozilla.org/apt/repo-signing-key.gpg');
    expect(calls).toContain('apt-key-readable');
    expect(calls).toContain('mode=644');
    expect(calls).toContain('apt-get install -y -qq firefox');
    expect(calls).not.toContain('Dir::Etc::preferences=/dev/null');
    expect(existsSync(join(fixture.root, 'bin/firefox'))).toBe(true);
    expect(calls).toContain('runuser -u ai -g users');
    expect(calls).toContain('runuser_exec uid=1001 user=ai group=users');
    expect(calls).not.toContain('chown ai:users');
    expect(calls).not.toContain(`chmod(euid=0) ${join(fixture.root, 'home')}`); // User config writes happen only after dropping UID.
    expect(existsSync(join(fixture.root, 'etc/apt/sources.list.d/mozilla.list'))).toBe(true);
    expect(existsSync(join(fixture.root, 'etc/apt/preferences.d/mozilla'))).toBe(true);
    const helpers = await readFile(join(fixture.root, 'home/.config/xfce4/helpers.rc'), 'utf8');
    expect(helpers).toBe('WebBrowser=firefox\n');

    // Second run with Mozilla broken afterwards must still update base repos strictly and exit 0.
    await writeFile(join(fixture.root, 'mozilla-down'), '1');
    const second = await fixture.run(script, ['--user', 'ai']);
    expect(second.code).toBe(0);
    expect(second.output).toContain('firefox already installed');
    expect(await readFile(join(fixture.root, 'home/.config/xfce4/helpers.rc'), 'utf8')).toBe('WebBrowser=firefox\n');
    expect(existsSync(join(fixture.root, 'etc/apt/sources.list.d/mozilla.list'))).toBe(true);
  });

  it('cleans temp Mozilla files, registers runnable firefox-esr helper, and launches ESR when Mozilla is unreachable', async () => {
    const fixture = await desktopShellFixture(dirs, { curlOk: false });
    // Even if a system firefox.desktop exists without firefox on PATH, ESR-only must register & launch firefox-esr.
    await writeFile(
      join(fixture.root, 'usr/share/xfce4/helpers/firefox.desktop'),
      '[Desktop Entry]\nType=X-XFCE-Helper\nX-XFCE-Category=WebBrowser\nX-XFCE-Binaries=firefox;\nX-XFCE-Commands=%B;\n',
    );
    const result = await fixture.run(script, ['--user', 'ai']);
    expect(result.code).toBe(0);
    expect(result.output).toContain('firefox-esr fallback');
    const calls = await fixture.calls();
    expect(calls).toContain('curl -fsSL --connect-timeout 15 --max-time 60');
    expect(calls).toContain('apt-get install -y -qq firefox-esr');
    expect(existsSync(join(fixture.root, 'etc/apt/sources.list.d/mozilla.list'))).toBe(false);
    expect(existsSync(join(fixture.root, 'etc/apt/preferences.d/mozilla'))).toBe(false);
    expect(existsSync(join(fixture.root, 'etc/apt/keyrings/packages.mozilla.org.asc'))).toBe(false);
    const resolved = await resolveAndLaunchXfceHelper(fixture.root, 'https://example.test');
    expect(resolved.id).toBe('firefox-esr');
    expect(resolved.binary).toBe('firefox-esr');
    expect(await readFile(join(fixture.root, 'launched-browsers'), 'utf8')).toContain('launched firefox-esr https://example.test');
  });

  it('isolates pre-existing Mozilla APT repo failures and preserves admin files byte-for-byte', async () => {
    const fixture = await desktopShellFixture(dirs, { mozillaRepoDown: true });
    const adminList = '# admin custom mozilla source\ndeb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main\n';
    const adminPin = '# admin pin\nPackage: firefox*\nPin: origin packages.mozilla.org\nPin-Priority: 1005\n';
    const adminKey = 'admin-preseeded-key-bytes\n';
    await writeFile(join(fixture.root, 'etc/apt/sources.list.d/mozilla.list'), adminList);
    await writeFile(join(fixture.root, 'etc/apt/preferences.d/mozilla'), adminPin);
    await writeFile(join(fixture.root, 'etc/apt/keyrings/packages.mozilla.org.asc'), adminKey);

    const result = await fixture.run(script, ['--user', 'ai']);
    expect(result.code).toBe(0);
    const calls = await fixture.calls();
    expect(calls).toContain('apt-get install -y -qq xvfb');
    expect(calls).toContain('apt-get install -y -qq firefox-esr');
    expect(await readFile(join(fixture.root, 'etc/apt/sources.list.d/mozilla.list'), 'utf8')).toBe(adminList);
    expect(await readFile(join(fixture.root, 'etc/apt/preferences.d/mozilla'), 'utf8')).toBe(adminPin);
    expect(await readFile(join(fixture.root, 'etc/apt/keyrings/packages.mozilla.org.asc'), 'utf8')).toBe(adminKey);
  });

  it('keeps distro records in mixed .list and .sources files when Mozilla is unreachable', async () => {
    // Case A: mixed .list file (and Mozilla also in main /etc/apt/sources.list)
    const listFixture = await desktopShellFixture(dirs, { mozillaRepoDown: true });
    const mixedMain = [
      'deb http://archive.ubuntu.com/ubuntu noble main universe',
      'deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main',
      '',
    ].join('\n');
    const mixedList = [
      'deb http://security.ubuntu.com/ubuntu noble-security main',
      'deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main',
      '',
    ].join('\n');
    const mainPrefs = 'Package: *\nPin: origin security.ubuntu.com\nPin-Priority: 500\n';
    await writeFile(join(listFixture.root, 'etc/apt/sources.list'), mixedMain);
    await writeFile(join(listFixture.root, 'etc/apt/sources.list.d/mixed.list'), mixedList);
    await writeFile(join(listFixture.root, 'etc/apt/preferences'), mainPrefs);

    const resList = await listFixture.run(script, ['--user', 'ai']);
    expect(resList.code).toBe(0);
    const listUpdates = (await readFile(join(listFixture.root, 'apt-update-history'), 'utf8')).split('=== UPDATE ===\n').slice(1);
    expect(listUpdates.length).toBeGreaterThanOrEqual(2);
    expect(listUpdates[0]).toContain('http://archive.ubuntu.com/ubuntu');
    expect(listUpdates[0]).toContain('http://security.ubuntu.com/ubuntu');
    expect(listUpdates[0]).not.toContain('packages.mozilla.org');
    expect(listUpdates[1]).toContain('packages.mozilla.org');
    expect(listUpdates[1]).not.toContain('archive.ubuntu.com');
    const listCalls = await listFixture.calls();
    expect(listCalls).toContain('apt-get install -y -qq xvfb');
    expect(listCalls).toContain('apt-get install -y -qq firefox-esr');
    expect(await readFile(join(listFixture.root, 'etc/apt/sources.list'), 'utf8')).toBe(mixedMain);
    expect(await readFile(join(listFixture.root, 'etc/apt/sources.list.d/mixed.list'), 'utf8')).toBe(mixedList);
    expect(await readFile(join(listFixture.root, 'etc/apt/preferences'), 'utf8')).toBe(mainPrefs);

    // Case B: mixed deb822 .sources file with folded multi-line URIs (both orders & mixed case) + multiline Signed-By
    for (const foldedUris of [
      'URIs: https://packages.mozilla.org/apt\n http://deb.debian.org/debian',
      'URIs: http://deb.debian.org/debian\n https://packages.mozilla.org/apt',
      'URIs:\n http://deb.debian.org/debian\n https://packages.mozilla.org/apt',
      'uris: https://packages.mozilla.org/apt\n http://deb.debian.org/debian',
      'Uris:\n http://deb.debian.org/debian\n https://packages.mozilla.org/apt',
      'uRiS: http://deb.debian.org/debian\n https://packages.mozilla.org/apt',
    ]) {
      const deb822Fixture = await desktopShellFixture(dirs, { mozillaRepoDown: true });
      const mixedSources = [
        'Types: deb',
        foldedUris,
        'Suites: bookworm',
        'Components: main',
        '',
        'Types: deb',
        'URIs: https://packages.mozilla.org/apt',
        'Suites: mozilla',
        'Components: main',
        'Signed-By:',
        ' -----BEGIN PGP PUBLIC KEY BLOCK-----',
        ' .',
        ' dummybase64keyline',
        ' -----END PGP PUBLIC KEY BLOCK-----',
        '',
      ].join('\n');
      await writeFile(join(deb822Fixture.root, 'etc/apt/sources.list'), '');
      await writeFile(join(deb822Fixture.root, 'etc/apt/sources.list.d/mixed.sources'), mixedSources);

      const resDeb822 = await deb822Fixture.run(script, ['--user', 'ai']);
      expect(resDeb822.code).toBe(0);
      const deb822Updates = (await readFile(join(deb822Fixture.root, 'apt-update-history'), 'utf8')).split('=== UPDATE ===\n').slice(1);
      expect(deb822Updates.length).toBeGreaterThanOrEqual(2);
      expect(deb822Updates[0]).toContain('http://deb.debian.org/debian');
      expect(deb822Updates[0]).not.toContain('packages.mozilla.org');
      expect(deb822Updates[1]).toContain('packages.mozilla.org');
      expect(deb822Updates[1]).not.toContain('deb.debian.org');
      expect(deb822Updates[1]).toContain('-----BEGIN PGP PUBLIC KEY BLOCK-----');
      expect(deb822Updates[1]).toContain('dummybase64keyline');
      const deb822Calls = await deb822Fixture.calls();
      expect(deb822Calls).toContain('apt-get install -y -qq xvfb');
      expect(deb822Calls).toContain('apt-get install -y -qq firefox-esr');
      expect(await readFile(join(deb822Fixture.root, 'etc/apt/sources.list.d/mixed.sources'), 'utf8')).toBe(mixedSources);
    }
  });

  it('leaves no broken Mozilla files on apt firefox failure and survives missing optional tools', async () => {
    const fixture = await desktopShellFixture(dirs, {
      curlOk: true,
      failPackages: ['firefox', 'firefox-esr', 'ristretto'],
    });
    const result = await fixture.run(script, ['--user', 'ai']);
    expect(result.code).toBe(0);
    expect(existsSync(join(fixture.root, 'etc/apt/sources.list.d/mozilla.list'))).toBe(false);
    expect(existsSync(join(fixture.root, 'etc/apt/preferences.d/mozilla'))).toBe(false);
    expect(existsSync(join(fixture.root, 'etc/apt/keyrings/packages.mozilla.org.asc'))).toBe(false);
    // Per-package fallback still attempted other optional tools such as mousepad.
    expect(await fixture.calls()).toContain('apt-get install -y -qq mousepad');
    expect(existsSync(join(fixture.root, 'home/.config/xfce4/helpers.rc'))).toBe(false);
  });

  it('reuses system firefox.desktop when present and safely skips symlinked or non-regular XFCE config paths', async () => {
    const sysHelper = await desktopShellFixture(dirs);
    await writeFile(join(sysHelper.root, 'bin/firefox'), '#!/bin/sh\necho "launched firefox $*" >> "$FIXTURE_ROOT/launched-browsers"\nexit 0\n', { mode: 0o755 });
    await writeFile(
      join(sysHelper.root, 'usr/share/xfce4/helpers/firefox.desktop'),
      '[Desktop Entry]\nType=X-XFCE-Helper\nX-XFCE-Category=WebBrowser\nX-XFCE-Binaries=firefox;\nX-XFCE-Commands=%B;\nX-XFCE-CommandsWithParameter=%B "%s";\n',
    );
    expect((await sysHelper.run(script, ['--user', 'ai'])).code).toBe(0);
    expect(existsSync(join(sysHelper.root, 'home/.local/share/xfce4/helpers/firefox.desktop'))).toBe(false);
    const resolved = await resolveAndLaunchXfceHelper(sysHelper.root, 'https://system.example');
    expect(resolved.id).toBe('firefox');

    // Symlinked helpers.rc pointing outside $HOME must never overwrite or alter outside target.
    const symlinked = await desktopShellFixture(dirs, { firefox: true });
    const outsideTarget = join(symlinked.root, 'outside-secret');
    await writeFile(outsideTarget, 'OUTSIDE-SECRET\n');
    await mkdir(join(symlinked.root, 'home/.config/xfce4'), { recursive: true });
    await symlink(outsideTarget, join(symlinked.root, 'home/.config/xfce4/helpers.rc'));
    expect((await symlinked.run(script, ['--user', 'ai'])).code).toBe(0);
    expect(lstatSync(join(symlinked.root, 'home/.config/xfce4/helpers.rc')).isSymbolicLink()).toBe(true);
    expect(await readFile(outsideTarget, 'utf8')).toBe('OUTSIDE-SECRET\n');

    // Directory at helpers.rc (unexpected file type) stays intact.
    const dirTarget = await desktopShellFixture(dirs, { firefox: true });
    await mkdir(join(dirTarget.root, 'home/.config/xfce4/helpers.rc'), { recursive: true });
    expect((await dirTarget.run(script, ['--user', 'ai'])).code).toBe(0);
    expect(lstatSync(join(dirTarget.root, 'home/.config/xfce4/helpers.rc')).isDirectory()).toBe(true);
  });

  it('preserves existing WebBrowser= preference and appends cleanly when helpers.rc has other keys', async () => {
    const custom = await desktopShellFixture(dirs, { firefox: true });
    await mkdir(join(custom.root, 'home/.config/xfce4'), { recursive: true });
    await writeFile(join(custom.root, 'home/.config/xfce4/helpers.rc'), 'WebBrowser=chromium\nTerminalEmulator=xfce4-terminal\n');
    expect((await custom.run(script, ['--user', 'ai'])).code).toBe(0);
    expect(await readFile(join(custom.root, 'home/.config/xfce4/helpers.rc'), 'utf8'))
      .toBe('WebBrowser=chromium\nTerminalEmulator=xfce4-terminal\n');

    const partial = await desktopShellFixture(dirs, { firefox: true });
    await mkdir(join(partial.root, 'home/.config/xfce4'), { recursive: true });
    await writeFile(join(partial.root, 'home/.config/xfce4/helpers.rc'), 'TerminalEmulator=xfce4-terminal');
    expect((await partial.run(script, ['--user', 'ai'])).code).toBe(0);
    expect(await readFile(join(partial.root, 'home/.config/xfce4/helpers.rc'), 'utf8'))
      .toBe('TerminalEmulator=xfce4-terminal\nWebBrowser=firefox\n');
  });

  it('installs thunar, mousepad, common tools, and firefox on dnf hosts', async () => {
    const fixture = await desktopShellFixture(dirs, { pkgMgr: 'dnf' });
    const result = await fixture.run(script, ['--user', 'ai']);
    expect(result.code).toBe(0);
    const calls = await fixture.calls();
    expect(calls).toContain('dnf install -y -q xorg-x11-server-Xvfb xorg-x11-xauth xorg-x11-utils dbus-x11 xfce4-session xfwm4 xfce4-panel xfdesktop xfce4-terminal thunar');
    expect(calls).toContain('dnf install -y -q mousepad ristretto xarchiver xfce4-taskmanager xfce4-screenshooter unzip zip curl wget');
    expect(calls).toContain('dnf install -y -q firefox');
  });

  it('resolves non-matching primary group, retries transient apt locks, and skips pulseaudio when pipewire-pulse is present', async () => {
    const fixture = await desktopShellFixture(dirs, {
      primaryGroup: 'users',
      pipewirePulse: true,
      aptFailTimes: 2,
    });
    const result = await fixture.run(script, ['--user', 'ai', '--no-firefox']);
    expect(result.code).toBe(0);
    expect(await readFile(join(fixture.root, 'etc/systemd/system/imcodes-desktop-session.service'), 'utf8'))
      .toContain('User=ai\nGroup=users');
    const calls = await fixture.calls();
    expect(calls).toContain('dpkg --configure -a');
    expect(calls).not.toContain('apt-get install -y -qq pulseaudio -o DPkg::Lock::Timeout=180');
  });

  it('auto-creates imcodes-desktop when --ensure-user is passed on a root-only host', async () => {
    const fixture = await desktopShellFixture(dirs, { existingUsers: [] });
    const result = await fixture.run(script, ['--user', 'imcodes-desktop', '--ensure-user', '--no-firefox']);
    expect(result.code).toBe(0);
    expect(await fixture.calls()).toContain('useradd -m -s /bin/bash imcodes-desktop');
  });

  it('retains user/display/resolution arguments and succeeds on the last display probe', async () => {
    const fixture = await desktopShellFixture(dirs, { readyAt: 20 });
    expect((await fixture.run(script, ['--user', 'ai', '--display', ':101', '--resolution', '1280x720x24', '--no-firefox'])).code).toBe(0);
    expect(await readFile(join(fixture.root, 'probes'), 'utf8')).toBe('20');
    expect((await fixture.calls()).match(/sleep 0.5/g)).toHaveLength(19);
    expect(await readFile(join(fixture.root, 'etc/systemd/system/imcodes-desktop-xvfb.service'), 'utf8'))
      .toContain('ExecStart=/usr/bin/Xvfb :101 -screen 0 1280x720x24 -nolisten tcp -ac');
    expect((await readFile(join(fixture.root, 'usr/local/lib/imcodes/desktop-display'), 'utf8')).trim()).toBe(':101');
  });

  it.each(['apt-get update', 'apt-get install', 'systemctl daemon-reload',
    'systemctl enable imcodes-desktop-xvfb.service',
    'systemctl restart imcodes-desktop-xvfb.service',
    'systemctl enable imcodes-desktop-session.service',
    'systemctl restart imcodes-desktop-session.service',
    'systemctl is-active --quiet imcodes-desktop-session.service',
    'systemctl enable imcodes-desktop-vnc.service',
    'systemctl restart imcodes-desktop-vnc.service'])('does not mask %s failure', async (fail) => {
    const fixture = await desktopShellFixture(dirs, { fail });
    const result = await fixture.run(script, ['--no-firefox', '--with-vnc']);
    expect(result.code).toBe(fail.startsWith('apt') ? 100 : (fail.includes('is-active') ? 1 : 7));
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
    expect(await fixture.calls()).not.toContain('enable imcodes-desktop-session');
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

  it.each([undefined, 'apt-get install', 'systemctl restart imcodes-desktop-session.service', 'systemctl is-active --quiet imcodes-desktop-session.service'])
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

  it('installs the bundled recipe for that user with Firefox enabled by default', async () => {
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
    expect(run).toHaveBeenCalledWith(expect.any(String), ['--user', 'ai']);
    // Byte for byte the operator script: one recipe, not a copy.
    expect(scriptText).toBe(await readFile(join(__dirname, '../../scripts/install-linux-desktop-environment.sh'), 'utf8'));
  });

  it('provisions with imcodes-desktop fallback on root-only hosts and still surfaces distro/install errors', async () => {
    const run = vi.fn(async () => ({ code: 0, output: '== done ==' }));
    await expect(provisionLinuxDesktopEnvironment({ supported: () => false }))
      .resolves.toEqual({ ok: false, reason: LINUX_DESKTOP_PROVISION_FAILURE.UNSUPPORTED_DISTRO });
    await expect(provisionLinuxDesktopEnvironment({
      supported: () => true, readPasswd: () => PASSWD, pickUser: () => null, run,
    })).resolves.toEqual({ ok: true, user: 'imcodes-desktop' });
    expect(run).toHaveBeenCalledWith(expect.any(String), ['--user', 'imcodes-desktop', '--ensure-user']);
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
    expect(getLinuxDesktopManualInstallCommand('apt')).toContain('mousepad');
    expect(getLinuxDesktopManualInstallCommand('dnf')).toContain('thunar mousepad');
    expect(getLinuxDesktopManualInstallCommand('yum')).toContain('sudo yum install -y');
    expect(getLinuxDesktopManualInstallCommand('yum')).toContain('thunar mousepad');
  });
});
