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

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
