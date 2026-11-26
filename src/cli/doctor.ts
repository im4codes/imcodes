/**
 * `imcodes doctor` -- checks that need the person's attention, in plain words.
 *
 * macOS: can the daemon, and the agent sessions it starts, read protected folders (Full Disk Access)? The daemon probes itself each
 * time it starts and writes the answer (src/util/macos-full-disk-access.ts); this command reads it and says exactly which Node binary
 * to grant. It must not probe from here: this process runs in the person's terminal and has the terminal's permissions, not the
 * daemon's.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { MACOS_LAUNCH_PROGRAM_KIND, parsePlistProgramArguments } from '../../shared/macos-daemon-launch.js';
import { buildMacosFdaReport, type MacosFdaReport, type MacosFdaStatusRecord } from '../../shared/macos-full-disk-access.js';
import { describeExistingMacosLaunch } from '../util/macos-launch-agent.js';
import { readMacosFdaStatus } from '../util/macos-full-disk-access.js';
import { resolvePosixDaemonServicePaths } from '../util/posix-daemon-service.js';

export interface DoctorResult {
  platform: NodeJS.Platform;
  needsAction: boolean;
  lines: string[];
  macosFullDiskAccess?: { record?: MacosFdaStatusRecord; plistNodePath?: string; plistRunsScript: boolean };
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export function collectDoctorResult(platform: NodeJS.Platform = process.platform): DoctorResult {
  if (platform !== 'darwin') {
    return { platform, needsAction: false, lines: ['Nothing to check on this platform.'] };
  }
  const service = resolvePosixDaemonServicePaths();
  let plistNodePath: string | undefined;
  let plistRunsScript = false;
  if (existsSync(service.launchAgentPath)) {
    const args = parsePlistProgramArguments(readFileSync(service.launchAgentPath, 'utf8'));
    if (args && args.length > 0) {
      const existing = describeExistingMacosLaunch(args);
      plistRunsScript = existing.kind === MACOS_LAUNCH_PROGRAM_KIND.SCRIPT;
      if (existing.kind === MACOS_LAUNCH_PROGRAM_KIND.NODE) {
        try { plistNodePath = realpathSync(args[0]!); } catch { plistNodePath = args[0]; }
      }
    }
  }
  const record = readMacosFdaStatus(service.stateHome);
  const report: MacosFdaReport = buildMacosFdaReport({
    record,
    recordProcessAlive: record !== undefined && processAlive(record.pid),
    plistNodePath,
    plistRunsScript,
  });
  return { platform, needsAction: report.needsAction, lines: report.lines, macosFullDiskAccess: { record, plistNodePath, plistRunsScript } };
}

export function runDoctor(options: { json?: boolean }, write: (line: string) => void = (line) => console.log(line), platform: NodeJS.Platform = process.platform): number {
  const result = collectDoctorResult(platform);
  if (options.json) write(JSON.stringify(result));
  else for (const line of result.lines) write(line);
  return result.needsAction ? 1 : 0;
}
