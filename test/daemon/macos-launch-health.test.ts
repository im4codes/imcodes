/**
 * Daemon start on macOS: heal a launch agent that still starts a script (once, with a brake), then probe Full Disk Access.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const warnings: Array<{ fields: unknown; message: string }> = [];
vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: () => undefined,
    warn: (fields: unknown, message: string) => { warnings.push({ fields, message }); },
    error: () => undefined,
    debug: () => undefined,
  },
}));

import { MACOS_LAUNCH_MIGRATION_MIN_SPACING_MS, runMacosLaunchHealth } from '../../src/daemon/macos-launch-health.js';
import { MACOS_FDA_PANE_STATE, MACOS_FDA_STATE, MACOS_NODE_INSTALL_KIND, type MacosFdaStatusRecord } from '../../shared/macos-full-disk-access.js';
import { parsePlistProgramArguments } from '../../shared/macos-daemon-launch.js';

let home: string;
let plist: string;
const label = 'imcodes.daemon';

beforeEach(() => {
  warnings.length = 0;
  home = realpathSync(mkdtempSync(join(tmpdir(), 'macos-launch-health-')));
  vi.stubEnv('HOME', home);
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  plist = join(home, 'Library', 'LaunchAgents', `${label}.plist`);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

/** A package + node that look right to the classifier, wired as the running process (the entry is argv[1]). */
function installPackage(): { entry: string; launcher: string; bootstrap: string; node: string } {
  const pkg = join(home, 'lib', 'node_modules', 'imcodes');
  mkdirSync(join(pkg, 'dist', 'src'), { recursive: true });
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), '{"name":"imcodes"}');
  const entry = join(pkg, 'dist', 'src', 'index.js');
  writeFileSync(entry, '');
  const launcher = join(pkg, 'bin', 'imcodes-launch.sh');
  writeFileSync(launcher, '#!/usr/bin/env bash\n', { mode: 0o755 });
  const bootstrap = join(pkg, 'bin', 'imcodes-launch.mjs');
  writeFileSync(bootstrap, '');
  const node = join(home, 'bin', 'node');
  mkdirSync(join(home, 'bin'), { recursive: true });
  writeFileSync(node, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
  chmodSync(node, 0o755);
  vi.spyOn(process, 'argv', 'get').mockReturnValue([node, entry]);
  vi.spyOn(process, 'execPath', 'get').mockReturnValue(node);
  return { entry, launcher, bootstrap, node };
}

const writePlist = (args: string[]): void => writeFileSync(plist, `<plist><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${a}</string>`).join('')}</array></dict></plist>`);
const record = (over: Partial<MacosFdaStatusRecord> = {}): MacosFdaStatusRecord => ({
  version: 1, checkedAtMs: 1, pid: 1, nodePath: '/n/node', nodeKind: MACOS_NODE_INSTALL_KIND.OTHER,
  daemon: MACOS_FDA_STATE.GRANTED, pane: MACOS_FDA_PANE_STATE.NO_SERVER, ...over,
});
const jobEnv = { HOME: '', XPC_SERVICE_NAME: label } as NodeJS.ProcessEnv;

describe('runMacosLaunchHealth', () => {
  it('other platforms: does nothing at all', async () => {
    const record = vi.fn();
    expect(await runMacosLaunchHealth({ platform: 'linux', record })).toEqual({ migrated: false });
    expect(record).not.toHaveBeenCalled();
  });

  it('the first start after an upgrade that wrote the script back: rewrites the plist to node + bootstrap, asks for ONE relaunch, writes the brake, and skips the probe', async () => {
    const { launcher, bootstrap, node } = installPackage();
    writePlist([launcher, 'start', '--foreground']);
    const restart = vi.fn();
    const probe = vi.fn();
    const result = await runMacosLaunchHealth({ platform: 'darwin', env: { ...jobEnv, HOME: home }, now: () => 1_000, restart, record: probe });
    expect(result).toEqual({ migrated: true });
    expect(parsePlistProgramArguments(readFileSync(plist, 'utf8'))).toEqual([node, bootstrap, 'start', '--foreground']);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledWith(plist);
    expect(probe).not.toHaveBeenCalled();
    expect(existsSync(join(home, '.imcodes', 'launch-target-migration.json'))).toBe(true);
  });

  it('the brake: if something keeps putting the script back, it is not rewritten more often than the spacing', async () => {
    const { launcher } = installPackage();
    writePlist([launcher, 'start', '--foreground']);
    const restart = vi.fn();
    const probe = vi.fn(async () => record());
    await runMacosLaunchHealth({ platform: 'darwin', env: { ...jobEnv, HOME: home }, now: () => 1_000, restart, record: probe });
    writePlist([launcher, 'start', '--foreground']);
    const second = await runMacosLaunchHealth({ platform: 'darwin', env: { ...jobEnv, HOME: home }, now: () => 1_000 + MACOS_LAUNCH_MIGRATION_MIN_SPACING_MS - 1, restart, record: probe });
    expect(second.migrated).toBe(false);
    expect(restart).toHaveBeenCalledTimes(1);
    const later = await runMacosLaunchHealth({ platform: 'darwin', env: { ...jobEnv, HOME: home }, now: () => 1_000 + MACOS_LAUNCH_MIGRATION_MIN_SPACING_MS, restart, record: probe });
    expect(later.migrated).toBe(true);
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it('a daemon that is not the launchd job (started by hand), and a plist already running node, are left alone', async () => {
    const { launcher, node, entry } = installPackage();
    writePlist([launcher, 'start', '--foreground']);
    const restart = vi.fn();
    const probe = vi.fn(async () => record());
    await runMacosLaunchHealth({ platform: 'darwin', env: { HOME: home }, restart, record: probe });
    expect(parsePlistProgramArguments(readFileSync(plist, 'utf8'))![0]).toBe(launcher);
    writePlist([node, entry, 'start', '--foreground']);
    const direct = await runMacosLaunchHealth({ platform: 'darwin', env: { ...jobEnv, HOME: home }, restart, record: probe });
    expect(direct.migrated).toBe(false);
    expect(restart).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('a scoped home owns no launch agent: never rewritten, still probed', async () => {
    const { launcher } = installPackage();
    writePlist([launcher, 'start', '--foreground']);
    const restart = vi.fn();
    const probe = vi.fn(async () => record());
    await runMacosLaunchHealth({ platform: 'darwin', env: { ...jobEnv, HOME: home, IMCODES_HOME: join(home, 'scoped-home') }, restart, record: probe });
    expect(restart).not.toHaveBeenCalled();
    expect(parsePlistProgramArguments(readFileSync(plist, 'utf8'))![0]).toBe(launcher);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('warns once with the next step when access is denied, or when only the running tmux server is behind; silent when granted', async () => {
    const env = { HOME: home } as NodeJS.ProcessEnv;
    await runMacosLaunchHealth({ platform: 'darwin', env, record: async () => record({ daemon: MACOS_FDA_STATE.DENIED }) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('imcodes doctor');
    await runMacosLaunchHealth({ platform: 'darwin', env, record: async () => record({ pane: MACOS_FDA_PANE_STATE.DENIED }) });
    expect(warnings).toHaveLength(2);
    expect(warnings[1]!.message).toContain('tmux server predates');
    await runMacosLaunchHealth({ platform: 'darwin', env, record: async () => record() });
    await runMacosLaunchHealth({ platform: 'darwin', env, record: async () => undefined });
    expect(warnings).toHaveLength(2);
  });
});
