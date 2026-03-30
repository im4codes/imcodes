import { spawn } from 'child_process';
import { cwdPrefix, type AgentDriver, type LaunchOptions, type DeleteBufferFn } from './base.js';
import type { AgentStatus } from '../detect.js';
import { detectStatus } from '../detect.js';

// Startup prompts to auto-dismiss after launch
const STARTUP_PROMPTS: Array<{
  pattern: RegExp;
  keys: string[];
  label: string;
}> = [
  // "Do you trust the files in this folder?" — Enter to accept
  { pattern: /trust.*folder|do you trust/i, keys: ['Enter'], label: 'trust-folder' },
  // Update available
  { pattern: /update available|press enter to continue/i, keys: ['Enter'], label: 'update' },
  // Generic [Y/n]
  { pattern: /\[Y\/n\]/i, keys: ['Enter'], label: 'confirm' },
];

const OVERLAY_PATTERNS = [
  /Allow|Deny/,
  /\[Y\/n\]/i,
  /Do you want to/i,
];

// Serialize resolveSessionId calls — concurrent Gemini CLI spawns cause timeouts
let _resolveQueue: Promise<void> = Promise.resolve();

export class GeminiDriver implements AgentDriver {
  readonly type = 'gemini' as const;
  readonly promptChar = '>';
  readonly spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  /**
   * Run gemini once in stream-json mode to obtain a fresh session UUID from
   * the `init` event, then kill the process.  The UUID can then be passed to
   * subsequent launches via `--resume <uuid>` so the session is deterministic.
   *
   * Calls are serialized: only one Gemini CLI process runs at a time to avoid
   * contention/timeouts when starting multiple Gemini sub-sessions.
   */
  async resolveSessionId(cwd?: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      _resolveQueue = _resolveQueue
        .then(() => this._doResolveSessionId(cwd))
        .then(resolve, reject);
    });
  }

  private async _doResolveSessionId(cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('gemini', ['-y', '-p', 'hi', '-o', 'stream-json'], {
        cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error('Gemini session ID discovery timed out'));
      }, 30_000);

      let buf = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as { type: string; session_id?: string };
            if (event.type === 'init' && event.session_id) {
              clearTimeout(timeout);
              proc.kill();
              resolve(event.session_id);
            }
          } catch {
            // not JSON yet, keep buffering
          }
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== null && code !== 0 && code !== null) {
          reject(new Error(`Gemini exited with code ${code} before emitting session_id`));
        }
      });
    });
  }

  buildLaunchCommand(_sessionName: string, opts?: LaunchOptions): string {
    const cwd = cwdPrefix(opts?.cwd);
    if (opts?.geminiSessionId) {
      return `${cwd}gemini --yolo --resume ${opts.geminiSessionId}`;
    }
    // Always launch fresh when no UUID — never use --resume latest
    return `${cwd}gemini --yolo`;
  }

  buildResumeCommand(_sessionName: string, opts?: LaunchOptions): string {
    return this.buildLaunchCommand(_sessionName, opts);
  }

  async postLaunch(
    capturePane: () => Promise<string[]>,
    sendKey: (key: string) => Promise<void>,
  ): Promise<void> {
    const POLL_INTERVAL_MS = 1_500;
    const MAX_POLLS = 12; // up to 18 seconds

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

      if (screen.includes(this.promptChar) || screen.includes('>')) return;
    }
  }

  detectStatus(lines: string[]): AgentStatus {
    return detectStatus(lines, 'gemini');
  }

  isOverlay(lines: string[]): boolean {
    const tail = lines.slice(-5).join('\n');
    return OVERLAY_PATTERNS.some((p) => p.test(tail));
  }

  async captureLastResponse(
    capturePane: () => Promise<string[]>,
    _sendKeys: (keys: string) => Promise<void>,
    _showBuffer: () => Promise<string>,
    _deleteBuffer?: DeleteBufferFn,
  ): Promise<string> {
    // Gemini has no /copy equivalent — use capture-pane
    const lines = await capturePane();
    return lines.join('\n');
  }
}
