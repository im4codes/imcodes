/** The probe itself: what a denied, granted or odd system looks like to it, and the record on disk. */
import { mkdtempSync, rmSync, writeFileSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MACOS_FDA_PANE_STATE, MACOS_FDA_STATE, MACOS_FDA_STATUS_FILE } from '../../shared/macos-full-disk-access.js';
import { probeFullDiskAccess, probeTmuxPaneFullDiskAccess, readMacosFdaStatus, recordMacosFdaStatus, runningNodeIdentity } from '../../src/util/macos-full-disk-access.js';

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'macos-fda-'))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('probeFullDiskAccess', () => {
  it('a readable file is granted, a missing one is no verdict', () => {
    const file = join(root, 'probe');
    writeFileSync(file, 'x');
    expect(probeFullDiskAccess(file)).toBe(MACOS_FDA_STATE.GRANTED);
    expect(probeFullDiskAccess(join(root, 'absent'))).toBe(MACOS_FDA_STATE.UNKNOWN);
  });
});

describe('probeTmuxPaneFullDiskAccess', () => {
  const answering = (reply: string | Error) => async (_file: string, args: readonly string[]): Promise<string> => {
    if (args[0] === 'list-sessions') return '0: 1 windows\n';
    if (reply instanceof Error) throw reply;
    return reply;
  };

  it('asks the SERVER to run the check (run-shell), so the answer is the attribution every pane inherits', async () => {
    const calls: string[][] = [];
    const exec = async (_file: string, args: readonly string[]): Promise<string> => { calls.push([...args]); return args[0] === 'run-shell' ? 'imcodes-fda-granted\n' : ''; };
    expect(await probeTmuxPaneFullDiskAccess(exec, "/p/it's/TCC.db")).toBe(MACOS_FDA_PANE_STATE.GRANTED);
    expect(calls.map((call) => call[0])).toEqual(['list-sessions', 'run-shell']);
    expect(calls[1]![1]).toContain("'/p/it'\\''s/TCC.db'");
  });

  it('maps the server\'s answer, a server that is not there, and anything odd', async () => {
    expect(await probeTmuxPaneFullDiskAccess(answering('imcodes-fda-denied\n'))).toBe(MACOS_FDA_PANE_STATE.DENIED);
    expect(await probeTmuxPaneFullDiskAccess(answering('something else'))).toBe(MACOS_FDA_PANE_STATE.UNKNOWN);
    expect(await probeTmuxPaneFullDiskAccess(answering(new Error('boom')))).toBe(MACOS_FDA_PANE_STATE.UNKNOWN);
    const noServer = async (): Promise<string> => { throw Object.assign(new Error('failed'), { stderr: 'no server running on /private/tmp/tmux-501/default' }); };
    expect(await probeTmuxPaneFullDiskAccess(noServer)).toBe(MACOS_FDA_PANE_STATE.NO_SERVER);
    const noTmux = async (): Promise<string> => { throw Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }); };
    expect(await probeTmuxPaneFullDiskAccess(noTmux)).toBe(MACOS_FDA_PANE_STATE.UNKNOWN);
  });
});

describe('the record', () => {
  it('names the REAL path of the running node (what the grant is keyed to) and round-trips through the file', async () => {
    const identity = runningNodeIdentity();
    expect(identity.nodePath).toBe(realpathSync(process.execPath));
    const written = await recordMacosFdaStatus(root, () => 123);
    expect(written).toMatchObject({ version: 1, checkedAtMs: 123, pid: process.pid, nodePath: identity.nodePath });
    expect(readMacosFdaStatus(root)).toEqual(written);
    expect(readFileSync(join(root, MACOS_FDA_STATUS_FILE), 'utf8').endsWith('\n')).toBe(true);
    expect(readMacosFdaStatus(join(root, 'nowhere'))).toBeUndefined();
  });

  it('a record that cannot be written is no error for the daemon', async () => {
    writeFileSync(join(root, 'file'), '');
    expect(await recordMacosFdaStatus(join(root, 'file', 'sub'))).toBeUndefined();
  });
});
