import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VerifiedMacosRemoteDesktopComponent } from '../../src/node/macos-remote-desktop-artifact.js';
import {
  executeMacosAideskAppCommand,
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
      designatedRequirement: 'identifier "cc.imcodes.node.remote-desktop-worker" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = M675E26Q67',
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

  describe('the app\'s own self-contained commands (executeMacosAideskAppCommand)', () => {
    it('verifies only the app\'s signed identity, then launches the app through LaunchServices and returns what it printed', async () => {
      const value = await fixture();
      const calls: Array<{ executable: string; args: readonly string[] }> = [];
      const executeFile = outputWriter({ stdout: 'IMCODES-FS-V1\nerror not_found\n', stderr: '' }, calls);

      await expect(executeMacosAideskAppCommand({
        user: value.user,
        args: ['--aidesk-fs-request', '/private/var/run/imcodes-node/fs-delegate/501/x.req'],
        appPath: value.appPath,
        timeoutMs: 5_000,
        maxBufferBytes: 16 * 1024,
      }, { executeFile })).resolves.toEqual({ stdout: 'IMCODES-FS-V1\nerror not_found\n', stderr: '' });

      // exactly one signature check (the app's), no component check, then the same LaunchServices launch the helpers use
      expect(calls.map((call) => call.executable)).toEqual(['/usr/bin/codesign', '/bin/launchctl']);
      expect(calls[0]!.args).toEqual(expect.arrayContaining([`-R=${MACOS_REMOTE_DESKTOP_RESPONSIBLE_APP_REQUIREMENT}`, value.appPath]));
      expect(calls[1]!.args).toEqual(expect.arrayContaining([
        '/usr/bin/open', '-W', '-n', '-g', value.appPath, '--args', '--aidesk-fs-request', '/private/var/run/imcodes-node/fs-delegate/501/x.req',
      ]));
    });

    it('does not start anything when the app\'s signature does not match', async () => {
      const value = await fixture();
      const executeFile = vi.fn(async () => { throw new Error('requirement failed'); });
      await expect(executeMacosAideskAppCommand({
        user: value.user, args: ['--aidesk-fs-request', '/x'], appPath: value.appPath, timeoutMs: 5_000, maxBufferBytes: 16 * 1024,
      }, { executeFile })).rejects.toThrow('macos_remote_desktop_responsible_app_identity_mismatch');
      expect(executeFile).toHaveBeenCalledTimes(1);
    });

    it('refuses output larger than the cap', async () => {
      const value = await fixture();
      const executeFile = outputWriter({ stdout: 'x'.repeat(2_000), stderr: '' }, []);
      await expect(executeMacosAideskAppCommand({
        user: value.user, args: ['--aidesk-fs-request', '/x'], appPath: value.appPath, timeoutMs: 5_000, maxBufferBytes: 1_024,
      }, { executeFile })).rejects.toThrow('macos_remote_desktop_native_command_output_too_large');
    });

    it('reaps orphaned processes when executeMacosAideskAppCommand times out', async () => {
      const value = await fixture();
      let capturedDir = '';
      const reapTimedOutCommand = vi.fn(async (context) => {
        capturedDir = context.output.directory;
        expect(await lstat(context.output.stdout)).toBeTruthy();
      });
      const executeFile = vi.fn(async (executable: string) => {
        if (executable === '/bin/launchctl') throw new Error('ETIMEDOUT');
        return { stdout: '', stderr: '' };
      });

      await expect(executeMacosAideskAppCommand({
        user: value.user,
        args: ['--aidesk-fs-request', '/x'],
        appPath: value.appPath,
        timeoutMs: 5_000,
        maxBufferBytes: 16 * 1024,
      }, { executeFile, reapTimedOutCommand })).rejects.toThrow('ETIMEDOUT');

      expect(reapTimedOutCommand).toHaveBeenCalledTimes(1);
      await expect(lstat(capturedDir)).rejects.toThrow();
    });
  });

  describe('timed-out command orphan process cleanup', () => {
    it('reaps leaked child worker and parent aidesk-agent via lsof/ps before deleting output directory', async () => {
      const value = await fixture();
      let stdoutPath = '';
      let stderrPath = '';
      let outputDir = '';
      let dirExistedDuringPs = false;
      const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
      const waited: number[] = [];

      const executeFile = vi.fn(async (executable: string, args: readonly string[]) => {
        if (executable === '/bin/launchctl') {
          const outIdx = args.indexOf('--stdout');
          const errIdx = args.indexOf('--stderr');
          stdoutPath = args[outIdx + 1]!;
          stderrPath = args[errIdx + 1]!;
          outputDir = value.user.tempDir;
          throw Object.assign(new Error('Command timed out'), { killed: true, code: null });
        }
        if (executable === '/usr/sbin/lsof') {
          expect(args.slice(0, 2)).toEqual(['-t', '--']);
          expect(args.slice(2)).toContain(await realpath(stdoutPath));
          expect(args.slice(2)).toContain(await realpath(stderrPath));
          // Child worker holds output.stdout/stderr open while its parent aidesk-agent
          // (PPID=1) did not hold the FD open directly.
          return { stdout: '75009\n', stderr: '' };
        }
        if (executable === '/bin/ps') {
          dirExistedDuringPs = Boolean(await lstat(stdoutPath).catch(() => null));
          outputDir = await realpath(join(stdoutPath, '..'));
          return {
            stdout: [
              '    1     0 /sbin/launchd',
              ` ${process.pid}     1 node vitest`,
              `75008     1 ${value.appPath}/Contents/MacOS/aidesk-agent --aidesk-component-dir=/store --imcodes-readiness-v1`,
              '75009 75008 /store/imcodes-remote-desktop-worker --imcodes-readiness-v1',
              '75010 75009 /usr/libexec/nested-helper',
              `88001     1 ${value.appPath}/Contents/MacOS/aidesk-agent --macos-remote-desktop-launch-agent`,
              `88002     1 ${value.appPath}/Contents/MacOS/aidesk-agent --aidesk-background`,
              '88003     1 /usr/local/bin/imcodes-node-macos daemon',
            ].join('\n'),
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      });

      await expect(executeMacosRemoteDesktopResponsibleCommand({
        user: value.user,
        component: value.component,
        args: ['--imcodes-readiness-v1'],
        appPath: value.appPath,
        timeoutMs: 5_000,
        maxBufferBytes: 16 * 1024,
      }, {
        executeFile,
        signalProcess: (pid, signal) => { signals.push({ pid, signal }); },
        waitMs: async (ms) => { waited.push(ms); },
      })).rejects.toThrow('Command timed out');

      expect(dirExistedDuringPs).toBe(true);
      await expect(lstat(outputDir)).rejects.toThrow();
      expect(waited).toEqual([250]);
      // Descendants (75010, 75009) and parent (75008) are reaped; protected PIDs are never touched.
      expect(signals).toEqual([
        { pid: 75010, signal: 'SIGTERM' },
        { pid: 75009, signal: 'SIGTERM' },
        { pid: 75008, signal: 'SIGTERM' },
        { pid: 75010, signal: 'SIGKILL' },
        { pid: 75009, signal: 'SIGKILL' },
        { pid: 75008, signal: 'SIGKILL' },
      ]);
    });

    it('never kills PID 1, current PID, launch-agent, background app, or node daemon even if returned by inspection', async () => {
      const value = await fixture();
      const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

      const executeFile = vi.fn(async (executable: string) => {
        if (executable === '/bin/launchctl') throw new Error('ETIMEDOUT');
        if (executable === '/usr/sbin/lsof') {
          return { stdout: `1\n${process.pid}\n91001\n91002\n91003\n91004\n`, stderr: '' };
        }
        if (executable === '/bin/ps') {
          return {
            stdout: [
              '    1     0 /sbin/launchd',
              ` ${process.pid}     1 node vitest`,
              `91001     1 ${value.appPath}/Contents/MacOS/aidesk-agent --macos-remote-desktop-launch-agent`,
              `91002     1 ${value.appPath}/Contents/MacOS/aidesk-agent --aidesk-background`,
              '91003     1 /usr/local/bin/imcodes-node-macos daemon',
              `91004     1 ${value.appPath}/Contents/MacOS/aidesk-agent --imcodes-readiness-v1`,
            ].join('\n'),
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      });

      await expect(executeMacosRemoteDesktopResponsibleCommand({
        user: value.user,
        component: value.component,
        args: ['--imcodes-readiness-v1'],
        appPath: value.appPath,
        timeoutMs: 5_000,
        maxBufferBytes: 16 * 1024,
      }, {
        executeFile,
        signalProcess: (pid, signal) => { signals.push({ pid, signal }); },
        waitMs: async () => {},
      })).rejects.toThrow('ETIMEDOUT');

      expect(signals).toEqual([
        { pid: 91004, signal: 'SIGTERM' },
        { pid: 91004, signal: 'SIGKILL' },
      ]);
    });

    it('handles lsof exit code 1 (no open handles) as a clean no-op without calling ps or waitMs', async () => {
      const value = await fixture();
      const called: string[] = [];
      const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
      const waitMs = vi.fn(async () => {});

      const executeFile = vi.fn(async (executable: string) => {
        called.push(executable);
        if (executable === '/bin/launchctl') throw new Error('ETIMEDOUT');
        if (executable === '/usr/sbin/lsof') {
          throw Object.assign(new Error('lsof exited 1'), { code: 1, stdout: '', stderr: '' });
        }
        return { stdout: '', stderr: '' };
      });

      await expect(executeMacosRemoteDesktopResponsibleCommand({
        user: value.user,
        component: value.component,
        args: ['--imcodes-readiness-v1'],
        appPath: value.appPath,
        timeoutMs: 5_000,
        maxBufferBytes: 16 * 1024,
      }, {
        executeFile,
        signalProcess: (pid, signal) => { signals.push({ pid, signal }); },
        waitMs,
      })).rejects.toThrow('ETIMEDOUT');

      expect(called).not.toContain('/bin/ps');
      expect(waitMs).not.toHaveBeenCalled();
      expect(signals).toEqual([]);
    });

    it('swallows cleanup errors without masking the original error and still deletes output directory', async () => {
      const value = await fixture();
      let capturedDir = '';
      const reapTimedOutCommand = vi.fn(async (context) => {
        capturedDir = context.output.directory;
        throw new Error('reaper_failed');
      });
      const executeFile = vi.fn(async (executable: string) => {
        if (executable === '/bin/launchctl') throw new Error('ORIGINAL_TIMEOUT_ERROR');
        return { stdout: '', stderr: '' };
      });

      await expect(executeMacosRemoteDesktopResponsibleCommand({
        user: value.user,
        component: value.component,
        args: ['--imcodes-readiness-v1'],
        appPath: value.appPath,
        timeoutMs: 5_000,
        maxBufferBytes: 16 * 1024,
      }, { executeFile, reapTimedOutCommand })).rejects.toThrow('ORIGINAL_TIMEOUT_ERROR');

      expect(reapTimedOutCommand).toHaveBeenCalledTimes(1);
      await expect(lstat(capturedDir)).rejects.toThrow();
    });

    it('does not invoke orphan cleanup on successful or detached invocations', async () => {
      const value = await fixture();
      const reapTimedOutCommand = vi.fn(async () => {});
      const calls: Array<{ executable: string; args: readonly string[] }> = [];
      const successExecutor = outputWriter({ stdout: '{"ready":true}\n', stderr: '' }, calls);

      await expect(executeMacosRemoteDesktopResponsibleCommand({
        user: value.user,
        component: value.component,
        args: ['--imcodes-readiness-v1'],
        appPath: value.appPath,
        timeoutMs: 5_000,
        maxBufferBytes: 16 * 1024,
      }, { executeFile: successExecutor, reapTimedOutCommand })).resolves.toEqual({
        stdout: '{"ready":true}\n',
        stderr: '',
      });
      expect(reapTimedOutCommand).not.toHaveBeenCalled();

      const detachedFailExecutor = vi.fn(async (executable: string) => {
        if (executable === '/bin/launchctl') throw new Error('detached_launch_failed');
        return { stdout: '', stderr: '' };
      });
      await expect(executeMacosRemoteDesktopResponsibleCommand({
        user: value.user,
        component: value.component,
        args: ['--imcodes-onboard-v1'],
        appPath: value.appPath,
        timeoutMs: 5_000,
        maxBufferBytes: 16 * 1024,
        detached: true,
      }, { executeFile: detachedFailExecutor, reapTimedOutCommand })).rejects.toThrow('detached_launch_failed');
      expect(reapTimedOutCommand).not.toHaveBeenCalled();
    });
  });
});
