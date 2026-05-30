import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkUpgradeToolchain } from '../../src/daemon/command-handler.js';

// Pre-flight toolchain check for the daemon auto-upgrade. The motivating
// incident: `apt autoremove` deleted nodejs+npm on a box while the daemon kept
// running on the now-deleted node inode. Every auto-upgrade then spawned a
// detached script that failed `npm install` with exit 127, and the daemon sat
// stuck on an old version for hours with no clear signal. nodeBinPresent=false
// is the unambiguous, fatal case (restart would exec a missing binary).

const NPM_CLI = '/usr/local/lib/node_modules/npm/bin/npm-cli.js';

describe('checkUpgradeToolchain', () => {
  it('healthy system/tarball install: node present, npm symlink resolves to npm-cli.js', () => {
    const present = new Set(['/usr/local/bin/node', '/usr/local/bin/npm', NPM_CLI]);
    const res = checkUpgradeToolchain({
      nodeBin: '/usr/local/bin/node',
      nodeDir: '/usr/local/bin',
      join,
      exists: (p) => present.has(p),
      realpath: (p) => (p === '/usr/local/bin/npm' ? NPM_CLI : present.has(p) ? p : null),
    });
    expect(res.nodeBinPresent).toBe(true);
    expect(res.npmCli).toBe(NPM_CLI);
  });

  it('deleted node (apt autoremove): nodeBin gone → nodeBinPresent=false, npmCli=null', () => {
    const res = checkUpgradeToolchain({
      nodeBin: '/usr/bin/node',
      nodeDir: '/usr/bin',
      join,
      exists: () => false, // entire toolchain removed from disk
      realpath: () => null,
    });
    expect(res.nodeBinPresent).toBe(false);
    expect(res.npmCli).toBeNull();
  });

  it('finds npm-cli.js via the relative-layout candidate when no <nodeDir>/npm symlink exists', () => {
    const present = new Set(['/usr/local/bin/node', NPM_CLI]); // note: no /usr/local/bin/npm
    const res = checkUpgradeToolchain({
      nodeBin: '/usr/local/bin/node',
      nodeDir: '/usr/local/bin',
      join,
      exists: (p) => present.has(p),
      realpath: () => null,
    });
    expect(res.nodeBinPresent).toBe(true);
    expect(res.npmCli).toBe(NPM_CLI);
  });

  it('node present but npm fully missing → nodeBinPresent=true, npmCli=null (warn, do not abort)', () => {
    const res = checkUpgradeToolchain({
      nodeBin: '/opt/node/bin/node',
      nodeDir: '/opt/node/bin',
      join,
      exists: (p) => p === '/opt/node/bin/node',
      realpath: () => null,
    });
    expect(res.nodeBinPresent).toBe(true);
    expect(res.npmCli).toBeNull();
  });

  it('ignores a <nodeDir>/npm symlink that does not resolve to npm-cli.js', () => {
    const present = new Set(['/usr/local/bin/node', '/usr/local/bin/npm']);
    const res = checkUpgradeToolchain({
      nodeBin: '/usr/local/bin/node',
      nodeDir: '/usr/local/bin',
      join,
      exists: (p) => present.has(p),
      realpath: (p) => (p === '/usr/local/bin/npm' ? '/usr/local/bin/npm-not-cli' : null),
    });
    expect(res.nodeBinPresent).toBe(true);
    expect(res.npmCli).toBeNull();
  });
});
