import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VerifiedMacosRemoteDesktopComponent } from '../../src/node/macos-remote-desktop-artifact.js';
import {
  executeMacosRemoteDesktopResponsibleCommand,
  MACOS_REMOTE_DESKTOP_RESPONSIBLE_APP_REQUIREMENT,
  macosRemoteDesktopResponsibleCommandInvocation,
  type MacosRemoteDesktopResponsibleCommandResult,
} from '../../src/node/macos-remote-desktop-responsible-spawn.js';
import type { MacosUserSession } from '../../src/node/user-session-launcher.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  root: string;
  appPath: string;
  component: VerifiedMacosRemoteDesktopComponent;
  user: MacosUserSession;
}> {
  const root = await mkdtemp(join(tmpdir(), 'imcodes-responsible-spawn-test-'));
  roots.push(root);
  const appPath = join(root, 'aiDesk.to by IM.codes.app');
  const helperDirectory = join(appPath, 'Contents', 'Helpers');
  await mkdir(helperDirectory, { recursive: true });
  const bytes = Buffer.from('signed exact worker');
  const fileName = 'imcodes-remote-desktop-worker';
  await writeFile(join(helperDirectory, fileName), bytes, { mode: 0o755 });
  return {
    root,
    appPath: await realpath(appPath),
    component: {
      kind: 'worker',
      executablePath: join(root, 'verified-release', fileName),
      fileName,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bundleIdentifier: 'cc.imcodes.node.remote-desktop-worker',
      designatedRequirement: 'identifier "cc.imcodes.node.remote-desktop-worker" and anchor apple generic and certificate leaf[subject.OU] = "M675E26Q67"',
    },
    user: {
      name: 'desktop-user',
      uid: process.getuid?.() ?? 501,
      gid: process.getgid?.() ?? 20,
      home: root,
      tempDir: root,
    },
  };
}

function outputWriter(
  result: MacosRemoteDesktopResponsibleCommandResult,
  calls: Array<{ executable: string; args: readonly string[] }>,
) {
  return vi.fn(async (executable: string, args: readonly string[]) => {
    calls.push({ executable, args });
    if (executable === '/bin/launchctl') {
      const stdoutIndex = args.indexOf('--stdout');
      const stderrIndex = args.indexOf('--stderr');
      await writeFile(args[stdoutIndex + 1]!, result.stdout);
      await writeFile(args[stderrIndex + 1]!, result.stderr);
    }
    return { stdout: '', stderr: '' };
  });
}

describe('macOS responsibility-safe remote desktop command launcher', () => {
  it('launches the byte-exact signed helper through the signed app and captures output', async () => {
    const value = await fixture();
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const executeFile = outputWriter({ stdout: '{"ready":true}\n', stderr: '' }, calls);

    await expect(executeMacosRemoteDesktopResponsibleCommand({
      user: value.user,
      component: value.component,
      args: ['--imcodes-readiness-v1'],
      appPath: value.appPath,
      timeoutMs: 5_000,
      maxBufferBytes: 16 * 1024,
    }, { executeFile })).resolves.toEqual({ stdout: '{"ready":true}\n', stderr: '' });

    expect(calls[0]).toMatchObject({
      executable: '/usr/bin/codesign',
      args: expect.arrayContaining([
        `-R=${MACOS_REMOTE_DESKTOP_RESPONSIBLE_APP_REQUIREMENT}`,
        value.appPath,
      ]),
    });
    expect(calls[1]).toMatchObject({
      executable: '/usr/bin/codesign',
      args: expect.arrayContaining([
        `-R=${value.component.designatedRequirement}`,
        join(value.appPath, 'Contents', 'Helpers', value.component.fileName),
      ]),
    });
    expect(calls[2]!.executable).toBe('/bin/launchctl');
    expect(calls[2]!.args).toEqual(expect.arrayContaining([
      '/usr/bin/open',
      '-W',
      '-n',
      '-g',
      value.appPath,
      '--args',
      '--imcodes-readiness-v1',
    ]));
    expect(JSON.stringify(calls[2])).not.toMatch(/credential|node.?token|bearer|secret/iu);
  });

  it('refuses helper byte drift before LaunchServices receives a command', async () => {
    const value = await fixture();
    const executeFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await writeFile(
      join(value.appPath, 'Contents', 'Helpers', value.component.fileName),
      'different helper bytes',
    );

    await expect(executeMacosRemoteDesktopResponsibleCommand({
      user: value.user,
      component: value.component,
      args: ['--imcodes-readiness-v1'],
      appPath: value.appPath,
      timeoutMs: 5_000,
      maxBufferBytes: 16 * 1024,
    }, { executeFile })).rejects.toThrow('macos_remote_desktop_responsible_helper_hash_mismatch');
    expect(executeFile).not.toHaveBeenCalled();
  });

  it('fails closed on app identity mismatch and on launch timeout', async () => {
    const identity = await fixture();
    const identityExecutor = vi.fn(async () => {
      throw new Error('requirement failed');
    });
    await expect(executeMacosRemoteDesktopResponsibleCommand({
      user: identity.user,
      component: identity.component,
      args: ['--imcodes-readiness-v1'],
      appPath: identity.appPath,
      timeoutMs: 5_000,
      maxBufferBytes: 16 * 1024,
    }, { executeFile: identityExecutor })).rejects
      .toThrow('macos_remote_desktop_responsible_app_identity_mismatch');

    const helperIdentity = await fixture();
    let signatureCheck = 0;
    const helperIdentityExecutor = vi.fn(async () => {
      signatureCheck += 1;
      if (signatureCheck === 2) throw new Error('helper requirement failed');
      return { stdout: '', stderr: '' };
    });
    await expect(executeMacosRemoteDesktopResponsibleCommand({
      user: helperIdentity.user,
      component: helperIdentity.component,
      args: ['--imcodes-readiness-v1'],
      appPath: helperIdentity.appPath,
      timeoutMs: 5_000,
      maxBufferBytes: 16 * 1024,
    }, { executeFile: helperIdentityExecutor })).rejects
      .toThrow('macos_remote_desktop_responsible_helper_identity_mismatch');

    const timeout = await fixture();
    const timeoutExecutor = vi.fn(async (executable: string) => {
      if (executable === '/bin/launchctl') throw new Error('ETIMEDOUT');
      return { stdout: '', stderr: '' };
    });
    await expect(executeMacosRemoteDesktopResponsibleCommand({
      user: timeout.user,
      component: timeout.component,
      args: ['--imcodes-readiness-v1'],
      appPath: timeout.appPath,
      timeoutMs: 5_000,
      maxBufferBytes: 16 * 1024,
    }, { executeFile: timeoutExecutor })).rejects.toThrow('ETIMEDOUT');
  });

  it('builds only a LaunchServices app invocation for the exact native argv', () => {
    const user: MacosUserSession = {
      name: 'desktop-user',
      uid: 501,
      gid: 20,
      home: '/Users/desktop-user',
      tempDir: '/private/var/folders/test/T/',
    };
    const invocation = macosRemoteDesktopResponsibleCommandInvocation(
      user,
      '/verified/aiDesk.to by IM.codes.app',
      ['--imcodes-stop-capture-v1', '--generation', '9'],
      { stdout: '/private/tmp/o', stderr: '/private/tmp/e' },
    );
    expect(invocation.executable).toBe('/bin/launchctl');
    expect(invocation.args).toEqual(expect.arrayContaining([
      '/usr/bin/open',
      '/verified/aiDesk.to by IM.codes.app',
      '--args',
      '--imcodes-stop-capture-v1',
      '--generation',
      '9',
    ]));
    expect(invocation.args).not.toContain('/verified/release/imcodes-remote-desktop-launch-agent');
    expect(invocation.env).toEqual({});
  });
});
