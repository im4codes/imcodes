/**
 * `imcodes-node --aidesk-ui-log` (macOS): the aiDesk app's own diagnostics log of the user running the command -- the phases of the
 * panel opening and every time the app's main thread was late (see native/macos-remote-desktop/aidesk_ui_support.h). Event and phase
 * names and numbers only; the app bounds the file.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AIDESK_UI_LOG } from '../../shared/aidesk-ui-log.js';

export function aideskUiLogPath(home: string = homedir()): string {
  return join(home, AIDESK_UI_LOG.DIRECTORY, AIDESK_UI_LOG.FILE);
}

/** The newest lines of the log (the moved-aside file first, when there is one); a sentence when there is nothing yet. */
export function describeAideskUiLog(home: string = homedir(), platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'darwin') return 'the aiDesk UI log exists on macOS only';
  const read = (path: string): string => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
  const path = aideskUiLogPath(home);
  const lines = `${read(`${path}.1`)}${read(path)}`.split('\n').filter((line) => line !== '');
  if (lines.length === 0) return `no aiDesk UI log yet (${path})`;
  return lines.slice(-AIDESK_UI_LOG.CLI_TAIL_LINES).join('\n');
}
