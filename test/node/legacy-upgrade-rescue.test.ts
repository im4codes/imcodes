import { describe, expect, it, vi } from 'vitest';
import {
  CONTROLLED_NODE_SERVICE,
  CONTROLLED_NODE_WINDOWS_LEGACY_UPGRADE_RESCUE_DIR,
} from '../../shared/controlled-node-service.js';
import { cleanupLegacyWindowsUpgradeRescue } from '../../src/node/legacy-upgrade-rescue.js';

describe('legacy Windows upgrade rescue cleanup', () => {
  it('removes the rescue task before deleting its protected files after authenticated health', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const removeDir = vi.fn(async () => {});
    await cleanupLegacyWindowsUpgradeRescue({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows', ProgramData: 'D:\\ProgramData' },
      run: async (file, args) => {
        calls.push({ file, args });
        return true;
      },
      removeDir,
    });

    expect(calls).toEqual([
      {
        file: 'C:\\Windows\\System32\\schtasks.exe',
        args: ['/End', '/TN', CONTROLLED_NODE_SERVICE.WINDOWS_LEGACY_UPGRADE_RESCUE_TASK],
      },
      {
        file: 'C:\\Windows\\System32\\schtasks.exe',
        args: ['/Delete', '/TN', CONTROLLED_NODE_SERVICE.WINDOWS_LEGACY_UPGRADE_RESCUE_TASK, '/F'],
      },
    ]);
    expect(removeDir).toHaveBeenCalledWith(`D:\\ProgramData\\${CONTROLLED_NODE_WINDOWS_LEGACY_UPGRADE_RESCUE_DIR}`);
  });

  it('does not delete files while the scheduled rescue action still exists', async () => {
    const removeDir = vi.fn(async () => {});
    await expect(cleanupLegacyWindowsUpgradeRescue({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows', ProgramData: 'D:\\ProgramData' },
      run: async (_file, args) => args[0] === '/Query',
      removeDir,
    })).rejects.toThrow('legacy_upgrade_rescue_task_cleanup_failed');
    expect(removeDir).not.toHaveBeenCalled();
  });

  it('is a no-op off Windows', async () => {
    const run = vi.fn(async () => true);
    await cleanupLegacyWindowsUpgradeRescue({ platform: 'linux', run });
    expect(run).not.toHaveBeenCalled();
  });
});
