/**
 * The macOS launch agent files: render it, and bring an existing one to the launch target Full Disk Access can reach.
 * Real files in a temp directory; nothing here starts a process or touches launchd.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MACOS_LAUNCH_MIGRATION_MODE, parsePlistProgramArguments } from '../../shared/macos-daemon-launch.js';
import {
  MACOS_LAUNCH_BACKUP_SUFFIX,
  MACOS_LAUNCH_ENSURE_REASON,
  describeExistingMacosLaunch,
  ensureMacosLaunchAgentTarget,
  planMacosPlistProgramArguments,
  renderMacosLaunchAgentPlist,
  resolveMacosDaemonLaunchFacts,
  resolveStableNodePath,
  restartMacosLaunchAgentDetached,
} from '../../src/util/macos-launch-agent.js';

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'macos-launch-agent-'))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** A file that looks like a binary to the classifier (no interpreter line). */
function fakeNode(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0]));
  chmodSync(path, 0o755);
  return path;
}

function fakePackage(options: { bootstrap?: boolean } = {}): { pkg: string; entry: string; launcher: string; bootstrap: string } {
  const pkg = join(root, 'lib', 'node_modules', 'imcodes');
  mkdirSync(join(pkg, 'dist', 'src'), { recursive: true });
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'imcodes', version: '1.0.0' }));
  const entry = join(pkg, 'dist', 'src', 'index.js');
  writeFileSync(entry, 'export {};\n');
  const launcher = join(pkg, 'bin', 'imcodes-launch.sh');
  writeFileSync(launcher, '#!/usr/bin/env bash\nexec node "$@"\n', { mode: 0o755 });
  const bootstrap = join(pkg, 'bin', 'imcodes-launch.mjs');
  if (options.bootstrap !== false) writeFileSync(bootstrap, 'export {};\n');
  return { pkg, entry, launcher, bootstrap };
}

function plistWith(programArguments: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>imcodes.daemon</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((arg) => `    <string>${arg}</string>`).join('\n')}
  </array>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>`;
}

describe('resolveStableNodePath', () => {
  it('prefers the name on PATH that is the very binary running (it survives an upgrade); else the real path', () => {
    const real = fakeNode(join(root, 'Cellar', 'node', '25.5.0', 'bin', 'node'));
    mkdirSync(join(root, 'bin'), { recursive: true });
    symlinkSync(real, join(root, 'bin', 'node'));
    expect(resolveStableNodePath(real, `${join(root, 'empty')}:${join(root, 'bin')}`)).toBe(join(root, 'bin', 'node'));
    expect(resolveStableNodePath(real, join(root, 'empty'))).toBe(real);
    // a different node on PATH is not "the same binary"
    const other = fakeNode(join(root, 'other', 'node'));
    expect(resolveStableNodePath(real, join(root, 'other'))).toBe(real);
    expect(other).toBeTruthy();
    // a relative PATH entry is never used
    expect(resolveStableNodePath(real, 'bin:.')).toBe(real);
  });
});

describe('the launch target of a fresh install', () => {
  it('runs node then the bootstrap; the shell supervisor is not in it, and the program is not a script', () => {
    const { entry, bootstrap, launcher } = fakePackage();
    const node = fakeNode(join(root, 'bin', 'node'));
    const facts = resolveMacosDaemonLaunchFacts({ entry, node, pathEnv: join(root, 'bin') });
    const args = planMacosPlistProgramArguments(facts);
    expect(args).toEqual([node, bootstrap, 'start', '--foreground']);
    expect(args).not.toContain(launcher);
    expect(describeExistingMacosLaunch(args).kind).toBe('node');
  });

  it('an install whose package predates the bootstrap still gets node + entry (no grant is lost, healing waits for the next upgrade)', () => {
    const { entry } = fakePackage({ bootstrap: false });
    const node = fakeNode(join(root, 'bin', 'node'));
    const args = planMacosPlistProgramArguments(resolveMacosDaemonLaunchFacts({ entry, node, pathEnv: '' }));
    expect(args).toEqual([node, entry, 'start', '--foreground']);
  });

  it('finds the package from the npm bin symlink the CLI was started by', () => {
    const { entry, bootstrap } = fakePackage();
    mkdirSync(join(root, 'bin'), { recursive: true });
    symlinkSync(entry, join(root, 'bin', 'imcodes'));
    const node = fakeNode(join(root, 'nodebin', 'node'));
    const facts = resolveMacosDaemonLaunchFacts({ entry: join(root, 'bin', 'imcodes'), node, pathEnv: '' });
    expect(facts.entry).toBe(entry);
    expect(facts.bootstrap).toBe(bootstrap);
  });

  it('a re-bind keeps the node the existing plist runs', () => {
    const { entry } = fakePackage();
    const mine = fakeNode(join(root, 'mine', 'node'));
    const current = fakeNode(join(root, 'current', 'node'));
    const existing = plistWith([mine, entry, 'start', '--foreground']);
    const args = planMacosPlistProgramArguments(resolveMacosDaemonLaunchFacts({ entry, node: current, pathEnv: '' }), existing);
    expect(args[0]).toBe(mine);
  });
});

describe('renderMacosLaunchAgentPlist', () => {
  const input = {
    label: 'imcodes.daemon', programArguments: ['/usr/local/bin/node', '/p/bin/imcodes-launch.mjs', 'start', '--foreground'],
    logPath: '/Users/a&b/.imcodes/daemon.log', pathEnv: '/usr/bin:/opt/homebrew/bin', home: '/Users/a&b', nodeOptions: '--expose-gc',
  };

  it('is a launch agent that runs the given program with KeepAlive, escaped, and parses back to the same arguments', () => {
    const xml = renderMacosLaunchAgentPlist(input);
    expect(parsePlistProgramArguments(xml)).toEqual(input.programArguments);
    expect(xml).toContain('<key>KeepAlive</key>');
    expect(xml).toContain('/Users/a&amp;b/.imcodes/daemon.log');
    expect(xml).not.toContain('IMCODES_HOME');
  });

  it('a scoped home adds its two environment variables', () => {
    const xml = renderMacosLaunchAgentPlist({ ...input, scoped: { stateHome: '/s/home', defaultHomeParent: '/s' } });
    expect(xml).toContain('<key>IMCODES_HOME</key>');
    expect(xml).toContain('<string>/s/home</string>');
  });
});

describe('ensureMacosLaunchAgentTarget', () => {
  it('at daemon start a plist that runs the shell supervisor is rewritten to node + bootstrap, once, keeping everything else and a backup', () => {
    const { entry, bootstrap, launcher } = fakePackage();
    const node = fakeNode(join(root, 'bin', 'node'));
    const plistPath = join(root, 'imcodes.daemon.plist');
    const original = plistWith([launcher, 'start', '--foreground']);
    writeFileSync(plistPath, original);
    const result = ensureMacosLaunchAgentTarget({ plistPath, mode: MACOS_LAUNCH_MIGRATION_MODE.STARTUP, entry, node, pathEnv: '' });
    expect(result).toMatchObject({ changed: true, reason: MACOS_LAUNCH_ENSURE_REASON.REWRITTEN, from: [launcher, 'start', '--foreground'], to: [node, bootstrap, 'start', '--foreground'] });
    const rewritten = readFileSync(plistPath, 'utf8');
    expect(parsePlistProgramArguments(rewritten)).toEqual([node, bootstrap, 'start', '--foreground']);
    expect(rewritten).toContain('<key>KeepAlive</key>');
    expect(readFileSync(`${plistPath}${MACOS_LAUNCH_BACKUP_SUFFIX}`, 'utf8')).toBe(original);
    // idempotent: the second look finds nothing to do and keeps the FIRST backup
    expect(ensureMacosLaunchAgentTarget({ plistPath, mode: MACOS_LAUNCH_MIGRATION_MODE.STARTUP, entry, node, pathEnv: '' })).toMatchObject({ changed: false, reason: MACOS_LAUNCH_ENSURE_REASON.UNCHANGED });
    expect(readFileSync(`${plistPath}${MACOS_LAUNCH_BACKUP_SUFFIX}`, 'utf8')).toBe(original);
  });

  it('the plist of the manual fix on pro (node + entry) is not touched at daemon start, and keeps its node when regenerated', () => {
    const { entry, bootstrap } = fakePackage();
    const proNode = fakeNode(join(root, 'usr-local', 'bin', 'node'));
    const current = fakeNode(join(root, 'bin', 'node'));
    const plistPath = join(root, 'imcodes.daemon.plist');
    const handMade = plistWith([proNode, entry, 'start', '--foreground']);
    writeFileSync(plistPath, handMade);
    expect(ensureMacosLaunchAgentTarget({ plistPath, mode: MACOS_LAUNCH_MIGRATION_MODE.STARTUP, entry, node: current, pathEnv: '' })).toMatchObject({ changed: false, reason: MACOS_LAUNCH_ENSURE_REASON.UNCHANGED });
    expect(readFileSync(plistPath, 'utf8')).toBe(handMade);
    const regenerated = ensureMacosLaunchAgentTarget({ plistPath, mode: MACOS_LAUNCH_MIGRATION_MODE.REGENERATE, entry, node: current, pathEnv: '' });
    expect(regenerated.changed).toBe(true);
    expect(parsePlistProgramArguments(readFileSync(plistPath, 'utf8'))).toEqual([proNode, bootstrap, 'start', '--foreground']);
  });

  it('a node that no longer exists is replaced by the running one; somebody else\'s wrapper script is never touched', () => {
    const { entry, bootstrap } = fakePackage();
    const node = fakeNode(join(root, 'bin', 'node'));
    const plistPath = join(root, 'imcodes.daemon.plist');
    writeFileSync(plistPath, plistWith([join(root, 'gone', 'v20', 'bin', 'node'), entry, 'start', '--foreground']));
    expect(ensureMacosLaunchAgentTarget({ plistPath, mode: MACOS_LAUNCH_MIGRATION_MODE.STARTUP, entry, node, pathEnv: '' }).to).toEqual([node, bootstrap, 'start', '--foreground']);

    const wrapper = join(root, 'my-wrapper.sh');
    writeFileSync(wrapper, '#!/bin/sh\nexec node "$@"\n', { mode: 0o755 });
    const custom = plistWith([wrapper, 'start']);
    writeFileSync(plistPath, custom);
    expect(ensureMacosLaunchAgentTarget({ plistPath, mode: MACOS_LAUNCH_MIGRATION_MODE.REGENERATE, entry, node, pathEnv: '' })).toMatchObject({ changed: false, reason: MACOS_LAUNCH_ENSURE_REASON.CUSTOM_PROGRAM });
    expect(readFileSync(plistPath, 'utf8')).toBe(custom);
    // a wrapper that is gone is somebody's too
    writeFileSync(plistPath, plistWith([join(root, 'gone-wrapper.sh'), 'start']));
    expect(ensureMacosLaunchAgentTarget({ plistPath, mode: MACOS_LAUNCH_MIGRATION_MODE.STARTUP, entry, node, pathEnv: '' }).reason).toBe(MACOS_LAUNCH_ENSURE_REASON.CUSTOM_PROGRAM);
  });

  it('nothing to do without a plist or without ProgramArguments; a write that fails is reported, not thrown', () => {
    const { entry } = fakePackage();
    const node = fakeNode(join(root, 'bin', 'node'));
    expect(ensureMacosLaunchAgentTarget({ plistPath: join(root, 'absent.plist'), mode: MACOS_LAUNCH_MIGRATION_MODE.REGENERATE, entry, node }).reason).toBe(MACOS_LAUNCH_ENSURE_REASON.NO_PLIST);
    const bare = join(root, 'bare.plist');
    writeFileSync(bare, '<plist><dict><key>Label</key><string>x</string></dict></plist>');
    expect(ensureMacosLaunchAgentTarget({ plistPath: bare, mode: MACOS_LAUNCH_MIGRATION_MODE.REGENERATE, entry, node }).reason).toBe(MACOS_LAUNCH_ENSURE_REASON.NO_PROGRAM_ARGUMENTS);
    const dirPlist = join(root, 'dir.plist');
    writeFileSync(dirPlist, plistWith([join(root, 'gone', 'node')]));
    chmodSync(root, 0o500);
    try {
      const result = ensureMacosLaunchAgentTarget({ plistPath: dirPlist, mode: MACOS_LAUNCH_MIGRATION_MODE.STARTUP, entry, node, pathEnv: '' });
      // running as root (some CI containers) can still write: then it simply succeeded
      expect([MACOS_LAUNCH_ENSURE_REASON.WRITE_FAILED, MACOS_LAUNCH_ENSURE_REASON.REWRITTEN]).toContain(result.reason);
    } finally {
      chmodSync(root, 0o700);
    }
  });
});

describe('restartMacosLaunchAgentDetached', () => {
  it('hands launchd the plist through a helper that outlives this job (own session), and never waits for it', () => {
    const calls: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    let unref = 0;
    restartMacosLaunchAgentDetached('/Users/a b/Library/LaunchAgents/imcodes.daemon.plist', ((file: string, args: readonly string[], options: Record<string, unknown>) => {
      calls.push({ file, args, options });
      return { unref: () => { unref += 1; } };
    }) as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe('/bin/sh');
    expect(calls[0]!.options).toMatchObject({ detached: true, stdio: 'ignore' });
    // the path is an argument, never spliced into the script text (spaces, quotes)
    expect(calls[0]!.args.at(-1)).toBe('/Users/a b/Library/LaunchAgents/imcodes.daemon.plist');
    expect(calls[0]!.args[1]).toContain('launchctl unload "$1"');
    expect(calls[0]!.args[1]).toContain('launchctl load -w "$1"');
    expect(unref).toBe(1);
    expect(existsSync('/bin/sh')).toBe(true);
  });
});
