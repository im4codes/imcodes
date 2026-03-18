import type { AgentDriver, LaunchOptions } from './base.js';
import type { AgentStatus } from '../detect.js';
import { detectStatus } from '../detect.js';

// Startup prompts to auto-dismiss after launch
const STARTUP_PROMPTS: Array<{
  pattern: RegExp;
  keys: string[];
  label: string;
}> = [
  // "Update available! X.Y.Z -> A.B.C" — select "Skip until next version" (option 3: Down Down Enter)
  { pattern: /update available.*->|skip until next version/i, keys: ['Down', 'Down', 'Enter'], label: 'update' },
];

export class CodexDriver implements AgentDriver {
  readonly type = 'codex' as const;
  readonly promptChar = '›';
  readonly spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'];

  buildLaunchCommand(_sessionName: string, opts?: LaunchOptions): string {
    const cwd = opts?.cwd ? `cd ${JSON.stringify(opts.cwd)} && ` : '';
    const modelFlag = opts?.codexModel ? ` -m ${JSON.stringify(opts.codexModel)}` : '';
    if (opts?.codexSessionId) {
      return `${cwd}codex${modelFlag} -s danger-full-access resume ${opts.codexSessionId}`;
    }
    if (opts?.fresh) {
      return `${cwd}codex${modelFlag} -s danger-full-access`;
    }
    // Default: resume last session; fall back to fresh if no history
    return `${cwd}codex${modelFlag} -s danger-full-access resume --last || codex${modelFlag} -s danger-full-access`;
  }

  buildResumeCommand(_sessionName: string, opts?: LaunchOptions): string {
    return this.buildLaunchCommand(_sessionName, opts);
  }

  async postLaunch(
    capturePane: () => Promise<string[]>,
    sendKey: (key: string) => Promise<void>,
  ): Promise<void> {
    const POLL_INTERVAL_MS = 1_500;
    const MAX_POLLS = 10; // up to 15 seconds

    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      let lines: string[];
      try {
        lines = await capturePane();
      } catch {
        continue;
      }

      const screen = lines.join('\n');

      let handled = false;
      for (const { pattern, keys } of STARTUP_PROMPTS) {
        if (pattern.test(screen)) {
          for (const key of keys) {
            await sendKey(key);
            await new Promise((r) => setTimeout(r, 200));
          }
          handled = true;
          break;
        }
      }

      if (handled) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      // No dialog — check if agent is at its idle prompt
      if (screen.includes(this.promptChar)) return;
    }
  }

  detectStatus(lines: string[]): AgentStatus {
    return detectStatus(lines, 'codex');
  }

  isOverlay(lines: string[]): boolean {
    // Codex shows context menu overlays when mid-action
    const tail = lines.slice(-5).join('\n');
    return /\[ESC\]|\[q\]/.test(tail);
  }

  async captureLastResponse(
    capturePane: () => Promise<string[]>,
    _sendKeys: (keys: string) => Promise<void>,
    _showBuffer: () => Promise<string>,
  ): Promise<string> {
    // Codex has no /copy equivalent — always use capture-pane
    const lines = await capturePane();
    return lines.join('\n');
  }
}
