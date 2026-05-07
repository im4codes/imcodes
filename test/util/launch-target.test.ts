/**
 * Tests for `src/util/launch-target.ts`.
 *
 * Pins the contract: when a global install ships
 * `bin/imcodes-launch.sh`, systemd ExecStart and launchctl
 * ProgramArguments MUST point at that launcher (not at node directly).
 * If the launcher is missing — older installs / source checkouts
 * without `bin/` — the helper transparently falls back to direct node
 * invocation so we never break versions that pre-date the launcher.
 *
 * This is the regression surface for the "half-finished `npm install -g
 * imcodes` wedges the daemon in a Restart=always crash loop" class of
 * incidents (212/213/215).
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveDaemonLaunchTarget,
  renderSystemdExecStart,
  renderPlistProgramArguments,
} from '../../src/util/launch-target.js';

function makeFakeInstall(opts: { withLauncher: boolean }): { dir: string; entry: string } {
  const dir = mkdtempSync(join(tmpdir(), 'launch-target-'));
  const distDir = join(dir, 'dist', 'src');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'index.js'), '#!/usr/bin/env node\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'imcodes', version: '1.0.0' }));
  if (opts.withLauncher) {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'imcodes-launch.sh'), '#!/usr/bin/env bash\n');
  }
  return { dir, entry: join(distDir, 'index.js') };
}

describe('resolveDaemonLaunchTarget', () => {
  it('points at imcodes-launch.sh when the install ships it', () => {
    const { dir, entry } = makeFakeInstall({ withLauncher: true });
    try {
      const target = resolveDaemonLaunchTarget(entry, '/usr/bin/node');
      expect(target.program).toBe(join(dir, 'bin/imcodes-launch.sh'));
      expect(target.args).toEqual(['start', '--foreground']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to direct node invocation when bin/imcodes-launch.sh is absent', () => {
    // Older installs (pre-launcher) and source checkouts without `bin/`
    // must keep working — the launcher is opt-in by file presence.
    const { dir, entry } = makeFakeInstall({ withLauncher: false });
    try {
      const target = resolveDaemonLaunchTarget(entry, '/usr/bin/node');
      expect(target.program).toBe('/usr/bin/node');
      expect(target.args).toEqual([entry, 'start', '--foreground']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not return a launcher path that exists without a sibling package.json', () => {
    // Defensive: if someone created `bin/imcodes-launch.sh` somewhere
    // up the tree (unrelated tooling) but there's no package.json
    // alongside it, that's not OUR launcher — fall back to direct node
    // so we never exec a stranger's script.
    const dir = mkdtempSync(join(tmpdir(), 'launch-target-stray-'));
    try {
      const distDir = join(dir, 'dist', 'src');
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, 'index.js'), '#!/usr/bin/env node\n');
      // No package.json at any level + no bin/ → must fall back.
      const target = resolveDaemonLaunchTarget(join(distDir, 'index.js'), '/usr/bin/node');
      expect(target.program).toBe('/usr/bin/node');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('renderSystemdExecStart', () => {
  it('joins program + args with single spaces (matches ExecStart= format)', () => {
    expect(renderSystemdExecStart({ program: '/x/launch', args: ['start', '--foreground'] }))
      .toBe('/x/launch start --foreground');
  });
});

describe('renderPlistProgramArguments', () => {
  it('renders a plist <string> array body for ProgramArguments', () => {
    const out = renderPlistProgramArguments({
      program: '/x/launch',
      args: ['start', '--foreground'],
    });
    expect(out).toBe(
      '    <string>/x/launch</string>\n'
      + '    <string>start</string>\n'
      + '    <string>--foreground</string>',
    );
  });
});
