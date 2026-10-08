/**
 * Step 3.5 of the POSIX upgrade script (the launch chain): on macOS it must hand the decision to the package it just installed, so a
 * launch agent never ends up starting a script, and a package too old for the helper still gets node + its entry. The REAL generated
 * function runs in bash against a fake HOME with `uname` and `plutil` shimmed.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPosixUpgradeScript } from '../../src/util/posix-upgrade-script.js';

const describeUnix = process.platform === 'win32' ? describe.skip : describe;
let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'upgrade-launch-chain-'))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function generated(): string {
  return buildPosixUpgradeScript({
    logFile: join(root, 'upgrade.log'), scriptDir: root, statusFile: join(root, 'status.json'), registryArg: '',
    pkgSpec: 'imcodes@2.0.0', targetVer: '2.0.0', currentVer: '1.0.0', oldDaemonPid: null, restartCmd: 'true',
    cleanupAfterSec: 3600, stateDir: join(root, 'state'), nodeBin: '/usr/bin/node', nodeDir: '/usr/bin',
    atomicInstallerPath: join(root, 'staged-package-install.mjs'),
  });
}

function functionBody(text: string): string {
  const start = text.indexOf('regenerate_launch_chain() {');
  const end = text.indexOf('\nregenerate_launch_chain\n');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

let runs = 0;
function runChain(options: { os: 'Darwin' | 'Linux'; withCli: boolean; withLauncher?: boolean }): { calls: string[]; plist: string; unit: string } {
  runs += 1;
  const base = join(root, `run${runs}`);
  mkdirSync(base, { recursive: true });
  const global = join(base, 'global');
  const pkg = join(global, 'imcodes');
  mkdirSync(join(pkg, 'dist', 'src', 'util'), { recursive: true });
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'dist', 'src', 'index.js'), '');
  if (options.withLauncher !== false) writeFileSync(join(pkg, 'bin', 'imcodes-launch.sh'), '#!/usr/bin/env bash\n');
  const calls = join(base, 'calls.log');
  const cli = join(pkg, 'dist', 'src', 'util', 'macos-launch-agent-cli.js');
  if (options.withCli) writeFileSync(cli, `require('fs').appendFileSync(${JSON.stringify(calls)}, 'cli ' + process.argv.slice(2).join(' ') + '\\n');\n`);
  const home = join(base, 'home');
  const plist = join(home, 'Library', 'LaunchAgents', 'imcodes.daemon.plist');
  const unit = join(home, '.config', 'systemd', 'user', 'imcodes.service');
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(plist, 'PLIST-ORIGINAL');
  writeFileSync(unit, '[Service]\nExecStart=/old/node /old/index.js start\n');
  const shims = join(base, 'shims');
  mkdirSync(shims, { recursive: true });
  const shim = (name: string, body: string): void => { writeFileSync(join(shims, name), `#!/bin/sh\n${body}\n`); chmodSync(join(shims, name), 0o755); };
  shim('uname', `echo ${options.os}`);
  shim('plutil', `echo "plutil $*" >> ${JSON.stringify(calls)}`);
  shim('systemctl', 'exit 0');
  const body = functionBody(generated());
  const run = spawnSync('/bin/bash', ['-c', `LOG="$1"; SKIP_LAUNCH_CHAIN=0
log() { echo "$*" >> "$LOG"; }
NODE=/usr/local/bin/node
GLOBAL_ROOT="$2"
NEW_IMCODES_SCRIPT="$GLOBAL_ROOT/imcodes/dist/src/index.js"
NEW_LAUNCHER="$GLOBAL_ROOT/imcodes/bin/imcodes-launch.sh"
NEW_LAUNCH_AGENT_CLI="$GLOBAL_ROOT/imcodes/dist/src/util/macos-launch-agent-cli.js"
${body}
regenerate_launch_chain`, 'bash', join(base, 'chain.log'), global], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PATH: `${shims}:${process.env.PATH}`, NODE: process.execPath },
  });
  expect(run.status).toBe(0);
  return {
    calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [],
    plist: readFileSync(plist, 'utf8'),
    unit: readFileSync(unit, 'utf8'),
  };
}

describeUnix('upgrade script step 3.5', () => {
  it('macOS with a package that ships the helper: the helper decides (regenerate mode, this package\'s entry, this node); no plutil, no script', () => {
    const result = runChain({ os: 'Darwin', withCli: true });
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatch(/^cli ensure --plist .*\/Library\/LaunchAgents\/imcodes\.daemon\.plist --entry .*\/imcodes\/dist\/src\/index\.js --node \S+ --mode regenerate$/u);
    expect(result.plist).toBe('PLIST-ORIGINAL');
  });

  it('macOS with a package too old for the helper: node + its entry, never the shell supervisor, even though that package ships one', () => {
    const result = runChain({ os: 'Darwin', withCli: false, withLauncher: true });
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toContain('plutil -replace ProgramArguments -json');
    expect(result.calls[0]).toContain('/usr/local/bin/node');
    expect(result.calls[0]).toContain('/dist/src/index.js');
    expect(result.calls[0]).not.toContain('imcodes-launch.sh');
  });

  it('Linux is unchanged: the systemd ExecStart still points at the shell supervisor when the package ships it, node + entry when not', () => {
    expect(runChain({ os: 'Linux', withCli: true }).unit).toMatch(/ExecStart=.*\/imcodes\/bin\/imcodes-launch\.sh start --foreground/u);
    expect(runChain({ os: 'Linux', withCli: true, withLauncher: false }).unit).toMatch(/ExecStart=\/usr\/local\/bin\/node .*\/dist\/src\/index\.js start --foreground/u);
  });
});
