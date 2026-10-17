import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { REMOTE_DESKTOP_LOGIN_SCREEN_ERROR } from '../../shared/remote-desktop-login-screen.js';
import {
  controlledNodeInstallHereTarget,
  installControlledNodeHere,
  runControlledNodeInstallScriptAsAdmin,
  type ControlledNodeAdminRunOutcome,
} from '../../src/daemon/controlled-node-install-here.js';

const INSTALL_CODE = 'ABCDEFGHJKMN';
const SCRIPT = '#!/bin/sh\n# IM.codes controlled-node installer.\nimcodes_install() { :; }\nimcodes_install\n';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'imcodes-install-here-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const credential = (serverUrl = 'https://example.test') => async () => ({
  serverUrl,
  serverId: 'server_1',
  token: 'token_1',
});

function serving(body = SCRIPT, status = 200) {
  return vi.fn(async () => new Response(body, { status }));
}

describe('controlledNodeInstallHereTarget', () => {
  it('names the artifact each Linux and macOS computer needs', () => {
    expect(controlledNodeInstallHereTarget('linux', 'x64')).toEqual({ os: 'linux', arch: 'x64' });
    expect(controlledNodeInstallHereTarget('darwin', 'arm64')).toEqual({ os: 'mac', arch: 'universal' });
    expect(controlledNodeInstallHereTarget('darwin', 'x64')).toEqual({ os: 'mac', arch: 'universal' });
  });

  it('offers nothing where no artifact exists, and leaves Windows to its own install', () => {
    expect(controlledNodeInstallHereTarget('linux', 'arm64')).toBeNull();
    expect(controlledNodeInstallHereTarget('win32', 'x64')).toBeNull();
  });
});

describe('installControlledNodeHere', () => {
  it('runs the install code\'s script from this daemon\'s own server as administrator', async () => {
    const dir = await root();
    const fetchImpl = serving();
    const ran: Array<{ platform: string; script: string; body: string }> = [];
    const failure = await installControlledNodeHere({
      installCode: INSTALL_CODE,
      platform: 'linux',
      root: dir,
      loadCredential: credential(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      runAsAdmin: async (platform, script) => {
        ran.push({ platform, script, body: readFileSync(script, 'utf8') });
        return 'ok';
      },
    });

    expect(failure).toBeNull();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(`https://example.test/i/${INSTALL_CODE}`);
    // A root-executed script is never taken from a redirect.
    expect(init.redirect).toBe('error');
    expect(ran).toEqual([{ platform: 'linux', script: expect.stringMatching(/install-[0-9a-f]{16}\.sh$/), body: SCRIPT }]);
    // Nothing that ran as root is left lying around.
    expect(existsSync(ran[0]!.script)).toBe(false);
    expect(readdirSync(join(dir, 'node-install'))).toEqual([]);
  });

  it('reports an unbound daemon rather than guessing a server', async () => {
    const fetchImpl = serving();
    const failure = await installControlledNodeHere({
      installCode: INSTALL_CODE,
      platform: 'linux',
      root: await root(),
      loadCredential: async () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      runAsAdmin: async () => 'ok',
    });
    expect(failure).toBe(REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.NOT_BOUND);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never runs anything that is not the installer script', async () => {
    for (const fetchImpl of [serving(SCRIPT, 404), serving('<html>not a script</html>')]) {
      const runAsAdmin = vi.fn(async (): Promise<ControlledNodeAdminRunOutcome> => 'ok');
      const failure = await installControlledNodeHere({
        installCode: INSTALL_CODE,
        platform: 'linux',
        root: await root(),
        loadCredential: credential(),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        runAsAdmin,
      });
      expect(failure).toBe(REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.DOWNLOAD_FAILED);
      expect(runAsAdmin).not.toHaveBeenCalled();
    }
  });

  it('refuses a cleartext server that is not a local development one', async () => {
    const fetchImpl = serving();
    const failure = await installControlledNodeHere({
      installCode: INSTALL_CODE,
      platform: 'linux',
      root: await root(),
      loadCredential: credential('http://example.test'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      runAsAdmin: async () => 'ok',
    });
    expect(failure).toBe(REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.DOWNLOAD_FAILED);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('says why the administrator step did not happen', async () => {
    const expected: Array<[ControlledNodeAdminRunOutcome, string]> = [
      ['admin_required', REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.ADMIN_REQUIRED],
      ['declined', REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.ELEVATION_DECLINED],
      ['failed', REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.INSTALL_FAILED],
    ];
    for (const [outcome, error] of expected) {
      const failure = await installControlledNodeHere({
        installCode: INSTALL_CODE,
        platform: 'darwin',
        root: await root(),
        loadCredential: credential(),
        fetchImpl: serving() as unknown as typeof fetch,
        runAsAdmin: async () => outcome,
      });
      expect(failure).toBe(error);
    }
  });

  it('announces the download and the administrator step, in that order', async () => {
    const states: string[] = [];
    await installControlledNodeHere({
      installCode: INSTALL_CODE,
      platform: 'linux',
      root: await root(),
      loadCredential: credential(),
      fetchImpl: serving() as unknown as typeof fetch,
      runAsAdmin: async () => 'ok',
      onState: (state) => { states.push(state); },
    });
    expect(states).toEqual(['downloading', 'elevating']);
  });
});

describe('runControlledNodeInstallScriptAsAdmin', () => {
  function recorder(results: Record<string, 'ok' | Error>) {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const run = async (file: string, args: readonly string[]) => {
      calls.push({ file, args });
      const result = results[`${file} ${args[1] ?? args[0]}`] ?? results[file];
      if (result instanceof Error) throw result;
    };
    return { calls, run };
  }

  it('installs silently where this user may sudo without a password', async () => {
    const { calls, run } = recorder({ '/usr/bin/sudo': 'ok' });
    expect(await runControlledNodeInstallScriptAsAdmin('linux', '/tmp/install.sh', run)).toBe('ok');
    expect(calls).toEqual([
      { file: '/usr/bin/sudo', args: ['-n', 'true'] },
      { file: '/usr/bin/sudo', args: ['-n', '/bin/sh', '/tmp/install.sh'] },
    ]);
  });

  it('reports a failed installer as failed, not as a missing password', async () => {
    const { run } = recorder({ '/usr/bin/sudo true': 'ok', '/usr/bin/sudo /bin/sh': new Error('exit 1') });
    expect(await runControlledNodeInstallScriptAsAdmin('linux', '/tmp/install.sh', run)).toBe('failed');
  });

  it('on Linux, asks for the password to be typed there rather than hanging on a prompt', async () => {
    const { calls, run } = recorder({ '/usr/bin/sudo': new Error('a password is required') });
    expect(await runControlledNodeInstallScriptAsAdmin('linux', '/tmp/install.sh', run)).toBe('admin_required');
    expect(calls).toHaveLength(1);
  });

  it('on macOS, raises the system administrator prompt with the script as an argument', async () => {
    const { calls, run } = recorder({ '/usr/bin/sudo': new Error('a password is required'), '/usr/bin/osascript': 'ok' });
    expect(await runControlledNodeInstallScriptAsAdmin('darwin', "/tmp/it's here.sh", run)).toBe('ok');
    const prompt = calls[1]!;
    expect(prompt.file).toBe('/usr/bin/osascript');
    expect(prompt.args.at(-1)).toBe("/tmp/it's here.sh");
    // The path is never spliced into the AppleScript source.
    expect(prompt.args.slice(0, -1).join(' ')).not.toContain('here.sh');
  });

  it('on macOS, reports a cancelled prompt as declined', async () => {
    const cancelled = Object.assign(new Error('osascript failed'), { stderr: 'execution error: User canceled. (-128)' });
    const { run } = recorder({ '/usr/bin/sudo': new Error('a password is required'), '/usr/bin/osascript': cancelled });
    expect(await runControlledNodeInstallScriptAsAdmin('darwin', '/tmp/install.sh', run)).toBe('declined');
  });
});
