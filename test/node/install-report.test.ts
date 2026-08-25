import { describe, expect, it } from 'vitest';
import {
  CONSOLE_HOLD,
  INSTALL_FAILURE_CAUSE,
  consoleHoldCountdown,
  consoleHoldMode,
  classifyInstallFailure,
  consoleHoldPrompt,
  controlledNodeInstallStatus,
  formatInstallFailure,
  formatInstallSuccess,
  isInstallerLaunch,
} from '../../src/node/install-report.js';

describe('controlled-node install reporting', () => {
  it('treats a source outside the staged path as an installer launch on all three platforms', () => {
    expect(isInstallerLaunch(
      'win32',
      'C:\\Users\\test\\Downloads\\imcodes-node.exe',
      'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
    )).toBe(true);
    expect(isInstallerLaunch(
      'darwin',
      '/Users/test/Downloads/imcodes-node-macos',
      '/Library/Application Support/imcodes-node/imcodes-node-macos',
    )).toBe(true);
    expect(isInstallerLaunch(
      'linux',
      '/tmp/imcodes-node',
      '/var/lib/imcodes-node/imcodes-node-linux',
    )).toBe(true);
  });

  it('never treats the staged background service as an installer launch', () => {
    // Windows compares case-insensitively; POSIX must not, because POSIX paths
    // are case-sensitive and two differently-cased paths are two files.
    expect(isInstallerLaunch(
      'win32',
      'c:\\programdata\\imcodes-node\\IMCODES-NODE.EXE',
      'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
    )).toBe(false);
    expect(isInstallerLaunch(
      'linux',
      '/var/lib/imcodes-node/./imcodes-node-linux',
      '/var/lib/imcodes-node/imcodes-node-linux',
    )).toBe(false);
    expect(isInstallerLaunch(
      'darwin',
      '/Library/Application Support/imcodes-node/IMCODES-NODE-MACOS',
      '/Library/Application Support/imcodes-node/imcodes-node-macos',
    )).toBe(true);
  });

  it('uses a concise localized status without exposing implementation details', () => {
    expect(controlledNodeInstallStatus('zh-CN')).toBe('IM.codes 安装中，请稍候...');
    expect(controlledNodeInstallStatus('en-US')).toBe('Installing IM.codes, please wait...');
    expect(consoleHoldPrompt('zh-CN')).toContain('回车');
    expect(consoleHoldPrompt('en-US')).toContain('Enter');
  });

  it('classifies the failures a human can actually act on', () => {
    expect(classifyInstallFailure(new Error(
      'controlled node installation requires Administrator/root; rerun this executable with elevated privileges',
    ))).toBe(INSTALL_FAILURE_CAUSE.NOT_ELEVATED);
    expect(classifyInstallFailure(new Error('missing enrollment blob in executable')))
      .toBe(INSTALL_FAILURE_CAUSE.ENROLLMENT_MISSING);
    expect(classifyInstallFailure(new Error('enrollment redeem failed: redeem_failed')))
      .toBe(INSTALL_FAILURE_CAUSE.ENROLLMENT_REJECTED);
    expect(classifyInstallFailure(new Error('getaddrinfo ENOTFOUND im.zhinet.work')))
      .toBe(INSTALL_FAILURE_CAUSE.SERVER_UNREACHABLE);
    expect(classifyInstallFailure(new Error('controlled node install journal is corrupt; manual recovery required')))
      .toBe(INSTALL_FAILURE_CAUSE.JOURNAL_RECOVERY);
    expect(classifyInstallFailure(new Error('something nobody predicted')))
      .toBe(INSTALL_FAILURE_CAUSE.UNKNOWN);
  });

  it('gives each platform its own elevation instruction', () => {
    const win = formatInstallFailure('zh-CN', 'win32', new Error('requires Administrator/root'));
    const mac = formatInstallFailure('en-US', 'darwin', new Error('requires Administrator/root'));
    const linux = formatInstallFailure('en-US', 'linux', new Error('requires Administrator/root'));
    expect(win).toContain('以管理员身份运行');
    expect(mac).toContain('sudo ./imcodes-node-macos');
    expect(linux).toContain('sudo ./imcodes-node-linux');
    // A POSIX user must never be told to right-click.
    expect(mac).not.toMatch(/administrator"/i);
  });

  it('always shows the raw error verbatim, because the hint is only a guess', () => {
    const raw = 'totally unrecognized failure 0x8007000E';
    for (const locale of ['zh-CN', 'en-US']) {
      const block = formatInstallFailure(locale, 'win32', new Error(raw));
      expect(block).toContain(raw);
      expect(block).toMatch(/❌/);
    }
  });

  it('holds the console so the result is readable, and never for the service', () => {
    // The whole point: a double-clicked installer destroys its console on exit.
    expect(consoleHoldMode({ installerLaunch: true, stdinIsTty: true, stdoutIsTty: true }))
      .toBe('keypress');
    // Console exists but stdin is not readable — there is no key to wait for,
    // yet exiting immediately would still destroy the only copy of the result.
    expect(consoleHoldMode({ installerLaunch: true, stdinIsTty: false, stdoutIsTty: true }))
      .toBe('countdown');
    // Output is being captured elsewhere; blocking would hang a script.
    expect(consoleHoldMode({ installerLaunch: true, stdinIsTty: false, stdoutIsTty: false }))
      .toBe('none');
    // The background service must never block on a console it does not own.
    for (const stdinIsTty of [true, false]) {
      for (const stdoutIsTty of [true, false]) {
        expect(consoleHoldMode({ installerLaunch: false, stdinIsTty, stdoutIsTty })).toBe('none');
      }
    }
  });

  it('bounds every hold so an unattended install still terminates', () => {
    expect(CONSOLE_HOLD.KEYPRESS_TIMEOUT_MS).toBeGreaterThan(0);
    expect(CONSOLE_HOLD.COUNTDOWN_MS).toBeGreaterThan(0);
    // A keypress hold may be generous; an unreadable console must not be.
    expect(CONSOLE_HOLD.COUNTDOWN_MS).toBeLessThan(CONSOLE_HOLD.KEYPRESS_TIMEOUT_MS);
    expect(consoleHoldCountdown('zh-CN', 60)).toContain('60');
    expect(consoleHoldCountdown('en-US', 60)).toContain('60');
  });

  it('reports success with the name the machine will show in the web app', () => {
    const zh = formatInstallSuccess('zh-CN', {
      displayName: 'MRBIG-PC', refName: 'mrbig_pc', serverUrl: 'https://im.zhinet.work',
    });
    expect(zh).toContain('注册成功');
    expect(zh).toContain('MRBIG-PC');
    expect(zh).toContain('https://im.zhinet.work');

    const en = formatInstallSuccess('en-US', { serverUrl: 'https://im.zhinet.work' });
    expect(en).toContain('registered successfully');
    // No name available must not print an empty labelled row.
    expect(en).not.toMatch(/Device:\s*$/m);
  });
});
