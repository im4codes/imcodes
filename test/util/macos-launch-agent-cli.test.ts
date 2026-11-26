/** What the upgrade script runs from the package it just installed, and `imcodes doctor`. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePlistProgramArguments } from '../../shared/macos-daemon-launch.js';
import { MACOS_FDA_PANE_STATE, MACOS_FDA_STATE, MACOS_FDA_STATUS_FILE, MACOS_NODE_INSTALL_KIND } from '../../shared/macos-full-disk-access.js';
import { collectDoctorResult, runDoctor } from '../../src/cli/doctor.js';
import { runMacosLaunchAgentCli } from '../../src/util/macos-launch-agent-cli.js';

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'macos-launch-cli-'))); vi.stubEnv('HOME', root); vi.stubEnv('IMCODES_HOME', join(root, '.imcodes')); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function layout(): { entry: string; bootstrap: string; node: string; launcher: string; plist: string } {
  const pkg = join(root, 'pkg');
  mkdirSync(join(pkg, 'dist', 'src'), { recursive: true });
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), '{"name":"imcodes"}');
  const entry = join(pkg, 'dist', 'src', 'index.js');
  writeFileSync(entry, '');
  const launcher = join(pkg, 'bin', 'imcodes-launch.sh');
  writeFileSync(launcher, '#!/usr/bin/env bash\n', { mode: 0o755 });
  const bootstrap = join(pkg, 'bin', 'imcodes-launch.mjs');
  writeFileSync(bootstrap, '');
  const node = join(root, 'bin', 'node');
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(node, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
  chmodSync(node, 0o755);
  mkdirSync(join(root, 'Library', 'LaunchAgents'), { recursive: true });
  return { entry, bootstrap, node, launcher, plist: join(root, 'Library', 'LaunchAgents', 'imcodes.daemon.plist') };
}

const plistXml = (args: string[]): string => `<plist><dict><key>Label</key><string>imcodes.daemon</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${a}</string>`).join('')}</array></dict></plist>`;

describe('runMacosLaunchAgentCli (what step 3.5 of the upgrade script runs)', () => {
  it('ensure: rewrites a plist that starts the script and prints one JSON line; exit 0', () => {
    const { entry, bootstrap, node, launcher, plist } = layout();
    writeFileSync(plist, plistXml([launcher, 'start', '--foreground']));
    const lines: string[] = [];
    const code = runMacosLaunchAgentCli(['ensure', '--plist', plist, '--entry', entry, '--node', node, '--mode', 'regenerate'], (line) => lines.push(line));
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ changed: true, reason: 'rewritten' });
    expect(parsePlistProgramArguments(readFileSync(plist, 'utf8'))).toEqual([node, bootstrap, 'start', '--foreground']);
  });

  it('a plist that is left alone (or absent) is not an error; a bad command line is exit 2', () => {
    const { entry, node, plist } = layout();
    const lines: string[] = [];
    expect(runMacosLaunchAgentCli(['ensure', '--plist', plist, '--entry', entry, '--node', node], (line) => lines.push(line))).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ changed: false, reason: 'no_plist' });
    expect(runMacosLaunchAgentCli(['ensure', '--plist', plist], () => undefined)).toBe(2);
    expect(runMacosLaunchAgentCli(['nope'], () => undefined)).toBe(2);
    expect(runMacosLaunchAgentCli(['ensure', '--plist', plist, '--entry', entry, '--mode', 'bogus'], () => undefined)).toBe(2);
  });
});

describe('imcodes doctor (macOS)', () => {
  const writeRecord = (over: Record<string, unknown> = {}): void => {
    mkdirSync(join(root, '.imcodes'), { recursive: true });
    writeFileSync(join(root, '.imcodes', MACOS_FDA_STATUS_FILE), JSON.stringify({
      version: 1, checkedAtMs: 1, pid: process.pid, nodePath: '/opt/homebrew/Cellar/node/25.5.0/bin/node', nodeKind: MACOS_NODE_INSTALL_KIND.HOMEBREW,
      daemon: MACOS_FDA_STATE.DENIED, pane: MACOS_FDA_PANE_STATE.NO_SERVER, ...over,
    }));
  };

  it('other platforms: nothing to check', () => {
    expect(collectDoctorResult('linux')).toMatchObject({ needsAction: false, lines: ['Nothing to check on this platform.'] });
  });

  it('denied: names the binary, exit status 1, and --json carries the same facts', () => {
    const { entry, node, plist } = layout();
    writeFileSync(plist, plistXml([node, entry, 'start', '--foreground']));
    writeRecord();
    const lines: string[] = [];
    expect(runDoctor({}, (line) => lines.push(line), 'darwin')).toBe(1);
    expect(lines.join('\n')).toContain('/opt/homebrew/Cellar/node/25.5.0/bin/node');
    const json: string[] = [];
    runDoctor({ json: true }, (line) => json.push(line), 'darwin');
    expect(JSON.parse(json[0]!)).toMatchObject({ platform: 'darwin', needsAction: true, macosFullDiskAccess: { plistNodePath: node, plistRunsScript: false } });
  });

  it('granted: exit status 0; a plist that still starts the script: says to restart; no record yet: still names the node the plist runs', () => {
    const { entry, node, launcher, plist } = layout();
    writeFileSync(plist, plistXml([node, entry, 'start', '--foreground']));
    writeRecord({ daemon: MACOS_FDA_STATE.GRANTED });
    expect(runDoctor({}, () => undefined, 'darwin')).toBe(0);
    rmSync(join(root, '.imcodes', MACOS_FDA_STATUS_FILE));
    expect(collectDoctorResult('darwin').lines.join('\n')).toContain(node);
    writeFileSync(plist, plistXml([launcher, 'start', '--foreground']));
    const script = collectDoctorResult('darwin');
    expect(script.needsAction).toBe(true);
    expect(script.lines.join('\n')).toContain('imcodes restart');
  });
});
