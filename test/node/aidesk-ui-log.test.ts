/** `imcodes-node --aidesk-ui-log`: the aiDesk app's diagnostics log of the user running it. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AIDESK_UI_LOG } from '../../shared/aidesk-ui-log.js';
import { aideskUiLogPath, describeAideskUiLog } from '../../src/node/aidesk-ui-log.js';

let home: string;
beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), 'aidesk-ui-log-'))); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function write(file: string, text: string): void {
  mkdirSync(join(home, AIDESK_UI_LOG.DIRECTORY), { recursive: true });
  writeFileSync(join(home, AIDESK_UI_LOG.DIRECTORY, file), text);
}

describe('describeAideskUiLog', () => {
  it('the log lives where the app writes it', () => {
    expect(aideskUiLogPath(home)).toBe(join(home, 'Library', 'Logs', 'IM.codes', 'aidesk-ui.log'));
  });

  it('prints the moved-aside file before the current one, and only the newest lines', () => {
    write(`${AIDESK_UI_LOG.FILE}.1`, '1 old role=ui\n');
    write(AIDESK_UI_LOG.FILE, `${Array.from({ length: 300 }, (_, index) => `${index} event role=ui`).join('\n')}\n`);
    const lines = describeAideskUiLog(home, 'darwin').split('\n');
    expect(lines).toHaveLength(AIDESK_UI_LOG.CLI_TAIL_LINES);
    expect(lines.at(-1)).toBe('299 event role=ui');
    expect(describeAideskUiLog(home, 'darwin')).not.toContain('old');
  });

  it('says so when there is no log yet, and that it exists on macOS only elsewhere', () => {
    expect(describeAideskUiLog(home, 'darwin')).toContain('no aiDesk UI log yet');
    expect(describeAideskUiLog(home, 'linux')).toContain('macOS only');
  });
});
