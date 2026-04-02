import { promises as fs } from 'fs';
import path from 'path';
import { cwdPrefix, type AgentDriver, type LaunchOptions } from './base.js';
import type { AgentStatus } from '../detect.js';
import { detectStatus } from '../detect.js';

export class OpenCodeDriver implements AgentDriver {
  readonly type = 'opencode' as const;
  readonly promptChar = '>';
  readonly spinnerChars = ['|', '/', '-', '\\'];

  buildLaunchCommand(_sessionName: string, opts?: LaunchOptions): string {
    const cwd = cwdPrefix(opts?.cwd);
    if (opts?.opencodeSessionId && !opts?.fresh) {
      return `${cwd}opencode -s ${JSON.stringify(opts.opencodeSessionId)}`;
    }
    return `${cwd}opencode`;
  }

  buildResumeCommand(_sessionName: string, opts?: LaunchOptions): string {
    const cwd = cwdPrefix(opts?.cwd);
    if (opts?.opencodeSessionId) {
      return `${cwd}opencode -s ${JSON.stringify(opts.opencodeSessionId)}`;
    }
    // Legacy fallback for pre-opencodeSessionId sessions.
    return `${cwd}opencode -c || opencode`;
  }

  detectStatus(_lines: string[]): AgentStatus {
    return detectStatus(_lines, 'opencode');
  }

  isOverlay(_lines: string[]): boolean {
    return false;
  }

  /**
   * Ensure the project directory has opencode.json with full permissions.
   * Called before launching the session.
   */
  async ensurePermissions(cwd: string): Promise<void> {
    const configPath = path.join(cwd, 'opencode.json');
    try {
      await fs.access(configPath);
    } catch {
      await fs.writeFile(
        configPath,
        JSON.stringify({ permission: { '*': 'allow' } }, null, 2)
      );
    }
  }

  async captureLastResponse(
    capturePane: () => Promise<string[]>,
    _sendKeys: (keys: string) => Promise<void>,
    _showBuffer: () => Promise<string>,
  ): Promise<string> {
    const lines = await capturePane();
    return lines.join('\n');
  }
}
