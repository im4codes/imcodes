import type { AgentDriver, LaunchOptions, DeleteBufferFn } from './base.js';
import { cwdPrefix } from './base.js';
import { claudeNativeAgentFenceFlag } from '../native-agent-fence.js';
import type { AgentStatus } from '../detect.js';
import { detectStatus } from '../detect.js';
import { CRON_CONTROL_TRUSTED_SYSTEM_CLAUSE } from '../../../shared/cron-types.js';

const OVERLAY_PATTERNS = [
  /Allow|Deny/,
  /\[Y\/n\]/i,
  /Do you want to/i,
  /Press Enter to/i,
  /─{10,}/, // CC uses box-drawing chars for dialogs
];

const CRON_TRUST_SYSTEM_PROMPT_FLAG =
  ` --append-system-prompt ${JSON.stringify(CRON_CONTROL_TRUSTED_SYSTEM_CLAUSE)}`;

// Startup dialogs to auto-dismiss after launch
const STARTUP_PROMPTS: Array<{
  pattern: RegExp;
  keys: string[]; // tmux key names to send in sequence
  label: string;
}> = [
  // "Resume from summary (recommended)" chooser shown on restart/resume.
  // The default selection is already "Resume from summary", so Enter confirms it.
  { pattern: /resume from summary|resume full session as-is|don't ask me again/i, keys: ['Enter'], label: 'resume-summary' },
  // Newer CC versions use an arrow menu with "No, exit" selected by default.
  // Require both menu entries before moving the selection so an unrelated
  // security dialog can never be accepted accidentally.
  // Numbered menus are handled first, even when they also show "No, exit".
  {
    pattern: /(?=[\s\S]*\b1[.)]\s*yes,\s*i\s*trust\s*this\s*folder\b)(?=[\s\S]*\b2[.)]\s*no,\s*exit\b)/i,
    keys: ['1', 'Enter'],
    label: 'trust-folder-numbered',
  },
  {
    pattern: /(?=[\s\S]*\bno,\s*exit\b)(?=[\s\S]*\byes,\s*i\s*trust\s*this\s*folder\b)/i,
    keys: ['Down', 'Enter'],
    label: 'trust-folder-arrow',
  },
  // Older CC versions use a numbered menu (1=Yes). Match the explicit trust
  // choice rather than the generic "Security guide" heading; sending "1"
  // then Enter keeps that compatibility path intact.
  {
    pattern: /\byes,\s*i\s*trust\s*this\s*folder\b/i,
    keys: ['1', 'Enter'],
    label: 'trust-folder',
  },
  // The legacy default-confirmation prompt has no numbered Yes row, but does
  // include an explicit confirmation affordance. Require that affordance too;
  // a question paired with only "No" must never receive an authorization key.
  {
    pattern: /\bdo\s+you\s+trust\s+(?:the\s+)?files?\s+in\s+this\s+folder\b[\s\S]*(?:\[y\/n\]|press\s+enter(?:\s+to\s+confirm)?|enter\s+to\s+confirm)/i,
    keys: ['Enter'],
    label: 'trust-folder-default',
  },
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
    const cwd = cwdPrefix(opts?.cwd);
    const fence = opts?.nativeAgentsFenced ? claudeNativeAgentFenceFlag() : '';
    if (opts?.ccSessionId) {
      return `${cwd}claude --dangerously-skip-permissions${fence}${CRON_TRUST_SYSTEM_PROMPT_FLAG} --session-id ${opts.ccSessionId}`;
    }
    if (opts?.fresh) {
      return `${cwd}claude --dangerously-skip-permissions${fence}${CRON_TRUST_SYSTEM_PROMPT_FLAG}`;
    }
    return `${cwd}claude --dangerously-skip-permissions${fence}${CRON_TRUST_SYSTEM_PROMPT_FLAG} -c || claude --dangerously-skip-permissions${fence}${CRON_TRUST_SYSTEM_PROMPT_FLAG}`;
  }

  buildResumeCommand(_sessionName: string, opts?: LaunchOptions): string {
    const cwd = cwdPrefix(opts?.cwd);
    const fence = opts?.nativeAgentsFenced ? claudeNativeAgentFenceFlag() : '';
    if (opts?.ccSessionId) {
      return `${cwd}claude --dangerously-skip-permissions${fence}${CRON_TRUST_SYSTEM_PROMPT_FLAG} --resume ${opts.ccSessionId}`;
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
