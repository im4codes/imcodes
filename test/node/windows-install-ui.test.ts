import { describe, expect, it } from 'vitest';
import {
  controlledNodeInstallStatus,
  isWindowsInstallerLaunch,
} from '../../src/node/windows-install-ui.js';

describe('controlled-node Windows install UI', () => {
  it('shows install status only for a Windows source executable outside the stable path', () => {
    expect(isWindowsInstallerLaunch(
      'win32',
      'C:\\Users\\test\\Downloads\\imcodes-node.exe',
      'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
    )).toBe(true);
    expect(isWindowsInstallerLaunch(
      'win32',
      'c:\\programdata\\imcodes-node\\IMCODES-NODE.EXE',
      'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
    )).toBe(false);
    expect(isWindowsInstallerLaunch(
      'linux',
      '/tmp/imcodes-node',
      '/var/lib/imcodes-node/imcodes-node-linux',
    )).toBe(false);
  });

  it('uses a concise localized status without exposing implementation details', () => {
    expect(controlledNodeInstallStatus('zh-CN')).toBe('IM.codes 安装中，请稍候...');
    expect(controlledNodeInstallStatus('en-US')).toBe('Installing IM.codes, please wait...');
  });
});
