/** The Full Disk Access probe vocabulary and the words `imcodes doctor` prints. */
import { describe, expect, it } from 'vitest';
import {
  MACOS_FDA_PANE_STATE,
  MACOS_FDA_STATE,
  MACOS_NODE_INSTALL_KIND,
  buildMacosFdaReport,
  classifyMacosNodeInstall,
  fdaStateFromOpenError,
  nodeUpgradeNeedsNewGrant,
  parseMacosFdaStatusRecord,
  type MacosFdaStatusRecord,
} from '../../shared/macos-full-disk-access.js';

const record = (over: Partial<MacosFdaStatusRecord> = {}): MacosFdaStatusRecord => ({
  version: 1, checkedAtMs: 1, pid: 42, nodePath: '/opt/homebrew/Cellar/node/25.5.0/bin/node', nodeKind: MACOS_NODE_INSTALL_KIND.HOMEBREW,
  daemon: MACOS_FDA_STATE.DENIED, pane: MACOS_FDA_PANE_STATE.NO_SERVER, ...over,
});

describe('classifyMacosNodeInstall', () => {
  it('tells Homebrew, version managers and the nodejs.org package apart by the real path', () => {
    expect(classifyMacosNodeInstall('/opt/homebrew/Cellar/node/25.5.0/bin/node')).toBe(MACOS_NODE_INSTALL_KIND.HOMEBREW);
    expect(classifyMacosNodeInstall('/usr/local/Cellar/node@22/22.1.0/bin/node')).toBe(MACOS_NODE_INSTALL_KIND.HOMEBREW);
    expect(classifyMacosNodeInstall('/Users/k/.nvm/versions/node/v22.19.0/bin/node')).toBe(MACOS_NODE_INSTALL_KIND.VERSION_MANAGER);
    expect(classifyMacosNodeInstall('/Users/k/.volta/tools/image/node/22.1.0/bin/node')).toBe(MACOS_NODE_INSTALL_KIND.VERSION_MANAGER);
    expect(classifyMacosNodeInstall('/Users/k/.local/share/mise/installs/node/22/bin/node')).toBe(MACOS_NODE_INSTALL_KIND.VERSION_MANAGER);
    expect(classifyMacosNodeInstall('/Users/k/.fnm/node-versions/v22/installation/bin/node')).toBe(MACOS_NODE_INSTALL_KIND.VERSION_MANAGER);
    expect(classifyMacosNodeInstall('/usr/local/bin/node')).toBe(MACOS_NODE_INSTALL_KIND.SYSTEM_PACKAGE);
    expect(classifyMacosNodeInstall('/Applications/Tools/node')).toBe(MACOS_NODE_INSTALL_KIND.OTHER);
  });

  it('only the signed system package keeps a grant across an in-place upgrade', () => {
    expect(nodeUpgradeNeedsNewGrant(MACOS_NODE_INSTALL_KIND.SYSTEM_PACKAGE)).toBe(false);
    for (const kind of [MACOS_NODE_INSTALL_KIND.HOMEBREW, MACOS_NODE_INSTALL_KIND.VERSION_MANAGER, MACOS_NODE_INSTALL_KIND.OTHER]) {
      expect(nodeUpgradeNeedsNewGrant(kind)).toBe(true);
    }
  });
});

describe('fdaStateFromOpenError', () => {
  it('EPERM/EACCES is denied, success is granted, anything else is not a verdict', () => {
    expect(fdaStateFromOpenError(undefined)).toBe(MACOS_FDA_STATE.GRANTED);
    expect(fdaStateFromOpenError('EPERM')).toBe(MACOS_FDA_STATE.DENIED);
    expect(fdaStateFromOpenError('EACCES')).toBe(MACOS_FDA_STATE.DENIED);
    expect(fdaStateFromOpenError('ENOENT')).toBe(MACOS_FDA_STATE.UNKNOWN);
    expect(fdaStateFromOpenError('EMFILE')).toBe(MACOS_FDA_STATE.UNKNOWN);
  });
});

describe('parseMacosFdaStatusRecord', () => {
  it('accepts what the daemon writes and nothing else', () => {
    expect(parseMacosFdaStatusRecord(JSON.stringify(record()))).toEqual(record());
    expect(parseMacosFdaStatusRecord('')).toBeUndefined();
    expect(parseMacosFdaStatusRecord('{}')).toBeUndefined();
    expect(parseMacosFdaStatusRecord(JSON.stringify({ ...record(), version: 2 }))).toBeUndefined();
    expect(parseMacosFdaStatusRecord(JSON.stringify({ ...record(), daemon: 'maybe' }))).toBeUndefined();
    expect(parseMacosFdaStatusRecord(JSON.stringify({ ...record(), nodePath: '' }))).toBeUndefined();
  });
});

describe('buildMacosFdaReport', () => {
  const base = { recordProcessAlive: true, plistRunsScript: false };

  it('denied: names the exact binary, the three steps, the restart, and what happens after a node upgrade (Homebrew)', () => {
    const report = buildMacosFdaReport({ ...base, record: record() });
    const text = report.lines.join('\n');
    expect(report.needsAction).toBe(true);
    expect(text).toContain('/opt/homebrew/Cellar/node/25.5.0/bin/node');
    expect(text).toContain('Full Disk Access');
    expect(text).toContain('imcodes restart');
    expect(text).toContain('brew upgrade node');
  });

  it('gives the matching re-grant line per install kind', () => {
    const line = (nodeKind: MacosFdaStatusRecord['nodeKind'], nodePath: string) => buildMacosFdaReport({ ...base, record: record({ nodeKind, nodePath }) }).lines.join('\n');
    expect(line(MACOS_NODE_INSTALL_KIND.VERSION_MANAGER, '/Users/k/.nvm/versions/node/v22/bin/node')).toContain('version manager');
    expect(line(MACOS_NODE_INSTALL_KIND.SYSTEM_PACKAGE, '/usr/local/bin/node')).toContain('keeps the grant');
    expect(line(MACOS_NODE_INSTALL_KIND.OTHER, '/Applications/Tools/node')).toContain('imcodes doctor');
  });

  it('granted to the daemon but denied in the running tmux server: says the server must be restarted, and that it ends sessions', () => {
    const report = buildMacosFdaReport({ ...base, record: record({ daemon: MACOS_FDA_STATE.GRANTED, pane: MACOS_FDA_PANE_STATE.DENIED }) });
    expect(report.needsAction).toBe(true);
    expect(report.lines.join('\n')).toContain('tmux kill-server');
    expect(report.lines.join('\n')).toContain('ends every session');
  });

  it('granted everywhere: nothing to do; unknown: not a problem', () => {
    const ok = buildMacosFdaReport({ ...base, record: record({ daemon: MACOS_FDA_STATE.GRANTED, pane: MACOS_FDA_PANE_STATE.GRANTED }) });
    expect(ok.needsAction).toBe(false);
    expect(ok.lines[0]).toContain('granted');
    const noServer = buildMacosFdaReport({ ...base, record: record({ daemon: MACOS_FDA_STATE.GRANTED }) });
    expect(noServer.needsAction).toBe(false);
    expect(buildMacosFdaReport({ ...base, record: record({ daemon: MACOS_FDA_STATE.UNKNOWN }) }).needsAction).toBe(false);
  });

  it('no record, or one from a daemon that is gone: asks nothing of the user and still names the node the plist runs', () => {
    const none = buildMacosFdaReport({ ...base, record: undefined, plistNodePath: '/usr/local/bin/node' });
    expect(none.needsAction).toBe(false);
    expect(none.lines.join('\n')).toContain('/usr/local/bin/node');
    expect(buildMacosFdaReport({ ...base, record: record(), recordProcessAlive: false }).needsAction).toBe(false);
  });

  it('a launch agent that still starts a script cannot be helped by any grant: says to restart so it is rewritten', () => {
    const report = buildMacosFdaReport({ ...base, record: undefined, plistRunsScript: true });
    expect(report.needsAction).toBe(true);
    expect(report.lines.join('\n')).toContain('imcodes restart');
  });

  it('never tells a machine to install anything (a daemon-only Mac has no aiDesk app and needs none)', () => {
    const everything = [
      record(), record({ daemon: MACOS_FDA_STATE.GRANTED, pane: MACOS_FDA_PANE_STATE.DENIED }), record({ daemon: MACOS_FDA_STATE.GRANTED }),
    ].flatMap((r) => buildMacosFdaReport({ ...base, record: r }).lines);
    everything.push(...buildMacosFdaReport({ ...base, record: undefined, plistRunsScript: true }).lines);
    for (const line of everything) expect(line).not.toMatch(/aidesk|\binstall|\bdownload\b/iu);
  });
});
