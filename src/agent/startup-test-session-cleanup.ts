import { getPaneCwd, killSession, listSessions as listTerminalSessions } from './tmux.js';
import { isKnownTestSessionLike } from '../../shared/test-session-guard.js';
import logger from '../util/logger.js';

export interface KnownTestTerminalSession {
  name: string;
  cwd?: string;
}

export async function listKnownTestTerminalSessions(): Promise<KnownTestTerminalSession[]> {
  const sessions = await listTerminalSessions();
  const matches: KnownTestTerminalSession[] = [];

  for (const name of sessions) {
    let cwd: string | undefined;
    try {
      cwd = await getPaneCwd(name);
    } catch {
      cwd = undefined;
    }

    if (!isKnownTestSessionLike({ name, cwd, projectDir: cwd })) continue;
    matches.push({ name, cwd });
  }

  return matches;
}

export async function cleanupKnownTestTerminalSessions(): Promise<string[]> {
  const matches = await listKnownTestTerminalSessions();
  if (matches.length === 0) return [];

  const killed: string[] = [];
  for (const match of matches) {
    try {
      await killSession(match.name);
      killed.push(match.name);
    } catch (err) {
      logger.warn({ err, sessionName: match.name }, 'Failed to clean leaked test terminal session');
    }
  }

  if (killed.length > 0) {
    logger.info({ count: killed.length, sessions: killed }, 'Cleaned leaked test terminal sessions on startup');
  }

  return killed;
}
