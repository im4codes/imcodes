import { cwdPrefix, type AgentDriver, type LaunchOptions } from './base.js';
import type { AgentStatus } from '../detect.js';
import { detectStatus } from '../detect.js';
import { buildShellHistoryLaunchArgs, resolveShellBin } from '../shell-history.js';

export class ShellDriver implements AgentDriver {
  readonly type = 'shell' as const;
  readonly promptChar = '$';
  readonly spinnerChars: string[] = [];

  buildLaunchCommand(_sessionName: string, opts?: LaunchOptions): string {
    const bin = resolveShellBin(opts?.shellBin);
    const cwd = cwdPrefix(opts?.cwd);
    const quotedBin = process.platform === 'win32' && /\s/.test(bin) ? `"${bin}"` : bin;
    const rcArgs = buildShellHistoryLaunchArgs(bin);
    return `${cwd}${quotedBin}${rcArgs}`;
  }

  buildResumeCommand(sessionName: string, opts?: LaunchOptions): string {
    return this.buildLaunchCommand(sessionName, opts);
  }

  detectStatus(lines: string[]): AgentStatus {
    return detectStatus(lines, 'shell');
  }

  isOverlay(_lines: string[]): boolean {
    return false;
  }

  async captureLastResponse(capturePane: () => Promise<string[]>): Promise<string> {
    return (await capturePane()).join('\n');
  }
}
