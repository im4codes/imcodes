import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { win32 } from 'node:path';
import {
  CONTROLLED_NODE_SERVICE,
  CONTROLLED_NODE_WINDOWS_LEGACY_UPGRADE_RESCUE_DIR,
} from '../../shared/controlled-node-service.js';

function execFileResult(file: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 15_000 }, (error) => resolve(!error));
  });
}

/**
 * A replacement node calls this only after its first authenticated health ACK.
 * At that point the independent first-hop rescue is no longer needed; removing
 * the task before its protected files prevents a dangling SYSTEM action.
 */
export async function cleanupLegacyWindowsUpgradeRescue(input: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: (file: string, args: string[]) => Promise<boolean>;
  removeDir?: (path: string) => Promise<void>;
} = {}): Promise<void> {
  const platform = input.platform ?? process.platform;
  if (platform !== 'win32') return;
  const env = input.env ?? process.env;
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
  const programData = env.ProgramData ?? env.PROGRAMDATA;
  if (!systemRoot || !programData) throw new Error('legacy_upgrade_rescue_windows_paths_unavailable');
  const schtasks = win32.join(systemRoot, 'System32', 'schtasks.exe');
  const run = input.run ?? execFileResult;
  const task = CONTROLLED_NODE_SERVICE.WINDOWS_LEGACY_UPGRADE_RESCUE_TASK;
  await run(schtasks, ['/End', '/TN', task]);
  const deleted = await run(schtasks, ['/Delete', '/TN', task, '/F']);
  if (!deleted) {
    const stillExists = await run(schtasks, ['/Query', '/TN', task]);
    if (stillExists) throw new Error('legacy_upgrade_rescue_task_cleanup_failed');
  }
  const rescueRoot = win32.join(programData, CONTROLLED_NODE_WINDOWS_LEGACY_UPGRADE_RESCUE_DIR);
  const removeDir = input.removeDir ?? ((path: string) => rm(path, { recursive: true, force: true }));
  await removeDir(rescueRoot);
}
