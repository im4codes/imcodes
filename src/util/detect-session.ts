/**
 * Auto-detect the sender's session identity from environment variables.
 *
 * Priority:
 *   1. $IMCODES_SESSION — universal, injected by the daemon at session launch
 *   2. $WEZTERM_PANE — lookup paneId in session store (stub for now)
 *   3. $TMUX_PANE — query tmux for the session name of that pane
 */

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

/**
 * Detect the current session name from the environment.
 * Throws if no session identity can be determined.
 */
export async function detectSenderSession(): Promise<string> {
  // 1. Explicit env var (set by daemon at launch)
  if (process.env.IMCODES_SESSION) {
    return process.env.IMCODES_SESSION;
  }

  // 2. WezTerm pane lookup (stub — future WezTerm backend support)
  if (process.env.WEZTERM_PANE) {
    // TODO: lookup paneId in session store once WezTerm backend is implemented
    throw new Error(
      'WezTerm pane detection not yet implemented. Set $IMCODES_SESSION.',
    );
  }

  // 3. tmux pane → query tmux for the session name
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
    'Cannot detect session identity. Set $IMCODES_SESSION or run from within a managed session.',
  );
}
