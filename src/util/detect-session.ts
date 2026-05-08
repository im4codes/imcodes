/**
 * Auto-detect the sender's session identity from environment variables.
 *
 * Priority:
 *   1. $IMCODES_SESSION — universal, injected by the daemon at session launch
 *   2. $IMCODES_SESSION_LABEL — SDK/transport fallback; hook server resolves it
 *      only when it is unique
 *   3. $WEZTERM_PANE — lookup paneId in session store (stub for now)
 *   4. $TMUX_PANE — query tmux for the session name of that pane
 */

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { IMCODES_SESSION_ENV, IMCODES_SESSION_LABEL_ENV } from '../../shared/imcodes-send.js';

const execFile = promisify(execFileCb);

/**
 * Detect the current session name from the environment.
 * Throws if no session identity can be determined.
 */
export async function detectSenderSession(): Promise<string> {
  // 1. Explicit env var (set by daemon at launch)
  if (process.env[IMCODES_SESSION_ENV]) {
    return process.env[IMCODES_SESSION_ENV];
  }

  // 2. SDK/transport fallback label. Prefer IMCODES_SESSION whenever present:
  // labels are human-facing and can be duplicated, while session names are stable.
  if (process.env[IMCODES_SESSION_LABEL_ENV]) {
    return process.env[IMCODES_SESSION_LABEL_ENV];
  }

  // 3. WezTerm pane lookup (stub — future WezTerm backend support)
  if (process.env.WEZTERM_PANE) {
    // TODO: lookup paneId in session store once WezTerm backend is implemented
    throw new Error(
      'WezTerm pane detection not yet implemented. Set $IMCODES_SESSION.',
    );
  }

  // 4. tmux pane → query tmux for the session name
  if (process.env.TMUX_PANE) {
    try {
      const { stdout } = await execFile('tmux', [
        'display-message',
        '-t',
        process.env.TMUX_PANE,
        '-p',
        '#{session_name}',
      ]);
      const sessionName = stdout.trim();
      if (sessionName) return sessionName;
    } catch {
      // tmux query failed — fall through to error
    }
  }

  throw new Error(
    'Cannot detect session identity. Set $IMCODES_SESSION (preferred) or $IMCODES_SESSION_LABEL, or run from within a managed session.',
  );
}
