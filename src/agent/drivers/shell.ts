import type { AgentDriver, LaunchOptions } from './base.js';
import type { AgentStatus } from '../detect.js';
import { detectStatus } from '../detect.js';

export class ShellDriver implements AgentDriver {
  readonly type = 'shell' as const;
  readonly promptChar = '$';
  readonly spinnerChars: string[] = [];

  buildLaunchCommand(_sessionName: string, opts?: LaunchOptions): string {
    const bin = (opts as { shellBin?: string } | undefined)?.shellBin
      ?? process.env.SHELL
      ?? '/bin/bash';
    const cwd = opts?.cwd ? `cd ${JSON.stringify(opts.cwd)} && ` : '';
    return `${cwd}${bin}`;
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
