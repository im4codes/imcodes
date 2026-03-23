import type { AgentDriver, LaunchOptions, DeleteBufferFn } from './base.js';
import type { AgentStatus } from '../detect.js';
import { detectStatus } from '../detect.js';

const OVERLAY_PATTERNS = [
  /Allow|Deny/,
  /\[Y\/n\]/i,
  /Do you want to/i,
  /Press Enter to/i,
  /─{10,}/, // CC uses box-drawing chars for dialogs
];

// Startup dialogs to auto-dismiss after launch
const STARTUP_PROMPTS: Array<{
  pattern: RegExp;
  keys: string[]; // tmux key names to send in sequence
  label: string;
}> = [
  // "Security guide" / "Do you trust the files in this folder?" — select "Yes, I trust"
  // Newer CC versions use a numbered menu (1=Yes, 2=No); older use Enter for default.
  // Sending "1" then Enter covers both: numbered picks option 1, legacy confirms default.
  { pattern: /security guide|trust.*folder|do you trust/i, keys: ['1', 'Enter'], label: 'trust-folder' },
  // Update available / Press enter to continue
  { pattern: /update available|press enter to continue/i, keys: ['Enter'], label: 'update' },
  // "Bypass Permissions mode" dialog — "No, exit" is selected, Down selects "Yes, I accept"
  // Pattern matches "bypass" alone since tmux may split "Bypass\nPermissions" across lines
  { pattern: /yes.*i accept|no.*exit.*bypass|bypass/i, keys: ['Down', 'Enter'], label: 'bypass-perms' },
  // "Files with errors are skipped" / settings dialog — "Exit and fix" selected, Down → "Continue without these settings"
  { pattern: /continue without these settings|files with errors are skipped|invalid settings/i, keys: ['Down', 'Enter'], label: 'settings-error' },
  // Generic "[Y/n]" confirmation — Enter for default yes
  { pattern: /\[Y\/n\]/i, keys: ['Enter'], label: 'confirm' },
];

export class ClaudeCodeDriver implements AgentDriver {
  readonly type = 'claude-code' as const;
  readonly promptChar = '❯';
  readonly spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  buildLaunchCommand(_sessionName: string, opts?: LaunchOptions): string {
    const cwd = opts?.cwd ? `cd ${JSON.stringify(opts.cwd)} && ` : '';
    if (opts?.ccSessionId) {
      // Sub-session: use deterministic session ID, always fresh start for that UUID
      return `${cwd}claude --dangerously-skip-permissions --trust-workspace --session-id ${opts.ccSessionId}`;
    }
    if (opts?.fresh) {
      return `${cwd}claude --dangerously-skip-permissions --trust-workspace`;
    }
    // Default: resume last conversation; fall back to fresh if no history
    return `${cwd}claude --dangerously-skip-permissions --trust-workspace -c || claude --dangerously-skip-permissions --trust-workspace`;
  }

  buildResumeCommand(_sessionName: string, opts?: LaunchOptions): string {
    const cwd = opts?.cwd ? `cd ${JSON.stringify(opts.cwd)} && ` : '';
    if (opts?.ccSessionId) {
      // Resume specific session by UUID
      return `${cwd}claude --dangerously-skip-permissions --trust-workspace --resume ${opts.ccSessionId}`;
    }
    return this.buildLaunchCommand(_sessionName, opts);
  }

  async postLaunch(
    capturePane: () => Promise<string[]>,
    sendKey: (key: string) => Promise<void>,
  ): Promise<void> {
    const POLL_INTERVAL_MS = 1_500;
    const MAX_POLLS = 12; // up to 18 seconds total

    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      let lines: string[];
      try {
        lines = await capturePane();
      } catch {
        continue; // session may not be ready yet
      }

      const screen = lines.join('\n');

      // Check startup prompts FIRST — dialogs contain ❯ in their menu cursors,
      // so checking for idle ❯ before this would cause a false-positive early exit.
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
        continue; // re-poll — may be more dialogs, or idle prompt
      }

      // No dialog matched — check if agent is idle
      if (screen.includes(this.promptChar)) return;
    }
  }

  detectStatus(lines: string[]): AgentStatus {
    return detectStatus(lines, 'claude-code');
  }

  isOverlay(lines: string[]): boolean {
    const tail = lines.slice(-5).join('\n');
    return OVERLAY_PATTERNS.some((p) => p.test(tail));
  }

  async captureLastResponse(
    capturePane: () => Promise<string[]>,
    sendKeys: (keys: string) => Promise<void>,
    showBuffer: () => Promise<string>,
    deleteBuffer?: DeleteBufferFn,
  ): Promise<string> {
    // Always local — use /copy for clean output
    try {
      await sendKeys('/copy');
      await new Promise((r) => setTimeout(r, 2000));
      const buf = await showBuffer();
      if (buf.trim()) {
        // Immediately clear the buffer — task 12.15 clipboard cleanup
        await deleteBuffer?.();
        return buf;
      }
    } catch {
      // fall through to capture-pane
    }
    const lines = await capturePane();
    return lines.join('\n');
  }
}
