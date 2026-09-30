/**
 * `imcodes upgrade` (Linux/macOS) hands the install to the detached upgrade
 * script and follows its log (tsk_cd_upgrade_atomic_install). Killing the CLI --
 * an SSH session that ends, a closed terminal -- must not stop the install or
 * leave a half-replaced package.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeUpgradeResult, runDetachedPosixUpgrade, UPGRADE_RESULTS, type DetachedUpgradeInput } from '../../src/cli/upgrade-detached.js';
import { launchPosixUpgrade } from '../../src/util/posix-upgrade-script.js';
import {
  START_NEW_DAEMON, createFixture, destroyFixture, startDaemon, treeHash, type Fixture,
} from '../helpers/posix-upgrade-fixture.js';

let fixture: Fixture;
const children: ChildProcess[] = [];
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['FAKE_PREFIX', 'FAKE_NPM_MODE', 'FAKE_STARTED_FILE', 'FAKE_INSTALL_DELAY_MS', 'HOME', 'IMCODES_HOME'];

beforeEach(() => {
  fixture = createFixture();
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.FAKE_PREFIX = fixture.prefix;
  process.env.HOME = fixture.home;
  delete process.env.FAKE_NPM_MODE;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  destroyFixture(fixture, children);
});

const input = (overrides: Partial<DetachedUpgradeInput> = {}): DetachedUpgradeInput => ({
  pkgSpec: 'imcodes@2.0.0', targetVer: '2.0.0', registry: null, currentVer: '1.0.0', platform: 'linux', stateDir: fixture.stateDir, home: fixture.home,
  ...overrides,
});

/** The CLI's launch, pointed at the fixture (its node/npm, no real service, short waits). */
const fixtureLaunch: typeof launchPosixUpgrade = (params) => launchPosixUpgrade({
  ...params,
  nodeBin: join(fixture.nodeDir, 'node'),
  nodeDir: fixture.nodeDir,
  stateDir: fixture.stateDir,
  restartCmd: START_NEW_DAEMON(fixture.stateDir),
  skipLaunchChain: true,
  cleanupAfterSec: 3600,
  timing: { settleSec: 0, healthFirstWaitSec: 3, healthExtendedWaitSec: 3 },
});

const liveVersion = () => JSON.parse(readFileSync(join(fixture.livePackage, 'package.json'), 'utf8')).version as string;

describe('runDetachedPosixUpgrade', () => {
  it('starts the detached script, streams its log, and returns 0 when the upgrade completes', async () => {
    startDaemon(fixture, children);
    const lines: string[] = [];
    const code = await runDetachedPosixUpgrade(input(), { launch: fixtureLaunch, write: (line) => { lines.push(line); }, pollMs: 100 });
    expect(code).toBe(0);
    expect(liveVersion()).toBe('2.0.0');
    const text = lines.join('\n');
    expect(text).toContain('Upgrade started in the background');
    expect(text).toContain('[step 2] staged install succeeded');
    expect(text).toContain('[step 3.4] switching');
    expect(text).toContain('Upgrade complete');
  }, 60_000);

  it('returns non-zero and says the previous install was left in place when the install fails', async () => {
    startDaemon(fixture, children);
    process.env.FAKE_NPM_MODE = 'fail-mid';
    const before = treeHash(fixture.livePackage);
    const lines: string[] = [];
    const code = await runDetachedPosixUpgrade(input(), { launch: fixtureLaunch, write: (line) => { lines.push(line); }, pollMs: 100 });
    expect(code).toBe(1);
    expect(treeHash(fixture.livePackage)).toBe(before);
    expect(lines.join('\n')).toContain('Upgrade failed; the previous install was left in place');
    expect(lines.join('\n')).toContain('injected failure halfway through the install');
  }, 120_000);

  it('an explicitly requested older version is installed, not refused as a downgrade (only automatic upgrades refuse)', async () => {
    startDaemon(fixture, children);
    const code = await runDetachedPosixUpgrade(input({ pkgSpec: 'imcodes@0.5.0', targetVer: '0.5.0' }), { launch: fixtureLaunch, write: () => undefined, pollMs: 100 });
    expect(code).toBe(0);
    expect(liveVersion()).toBe('0.5.0');
  }, 60_000);

  it('reports a no-op, a refusal, a concurrent upgrade and a rollback each with its own message and exit code', () => {
    expect(UPGRADE_RESULTS).toEqual(['ok', 'noop', 'refused', 'skipped', 'rolled_back', 'failed']);
    const log = '/tmp/x/upgrade.log';
    expect(describeUpgradeResult('ok', log).code).toBe(0);
    expect(describeUpgradeResult('noop', log)).toMatchObject({ code: 0, message: expect.stringContaining('Already up to date') });
    expect(describeUpgradeResult('refused', log).code).toBe(0);
    expect(describeUpgradeResult('skipped', log)).toMatchObject({ code: 1, message: expect.stringContaining('already running') });
    expect(describeUpgradeResult('rolled_back', log)).toMatchObject({ code: 1, message: expect.stringContaining('previous version was restored') });
    expect(describeUpgradeResult('failed', log)).toMatchObject({ code: 1, message: expect.stringContaining(log) });
  });

  it('KILLING THE CLI PROCESS mid-upgrade (SIGKILL, like a dropped SSH session): the install completes and the daemon runs afterwards', async () => {
    const oldPid = startDaemon(fixture, children);
    const started = join(fixture.root, 'npm-started');
    const overrides = {
      nodeBin: join(fixture.nodeDir, 'node'), nodeDir: fixture.nodeDir, stateDir: fixture.stateDir,
      restartCmd: START_NEW_DAEMON(fixture.stateDir), skipLaunchChain: true, cleanupAfterSec: 3600,
      timing: { settleSec: 0, healthFirstWaitSec: 3, healthExtendedWaitSec: 3 },
    };
    const script = `
      const { runDetachedPosixUpgrade } = await import(process.env.CLI_MODULE);
      const launcher = await import(process.env.SCRIPT_MODULE);
      const overrides = JSON.parse(process.env.OVERRIDES);
      await runDetachedPosixUpgrade(
        { pkgSpec: 'imcodes@2.0.0', targetVer: '2.0.0', registry: null, currentVer: '1.0.0', platform: 'linux', stateDir: overrides.stateDir, home: process.env.HOME },
        { launch: (params) => launcher.launchPosixUpgrade({ ...params, ...overrides }), pollMs: 100 },
      );
    `;
    const cli = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      env: {
        ...process.env, FAKE_STARTED_FILE: started, FAKE_INSTALL_DELAY_MS: '3000',
        CLI_MODULE: new URL('../../src/cli/upgrade-detached.ts', import.meta.url).href,
        SCRIPT_MODULE: new URL('../../src/util/posix-upgrade-script.ts', import.meta.url).href,
        OVERRIDES: JSON.stringify(overrides),
      },
      stdio: 'ignore',
    });
    children.push(cli);
    const deadline = Date.now() + 40_000;
    while (!existsSync(started) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(started)).toBe(true); // npm is mid-install right now
    cli.kill('SIGKILL');
    await new Promise((resolve) => cli.on('exit', resolve));
    // The package is whole at every instant: still the old one while npm works in the stage.
    expect(liveVersion()).toBe('1.0.0');

    const pidFile = join(fixture.stateDir, 'daemon.pid');
    const waitUntil = Date.now() + 60_000;
    while (Date.now() < waitUntil) {
      if (liveVersion() === '2.0.0' && existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8')) !== oldPid) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(liveVersion()).toBe('2.0.0');
    expect(spawnSync(process.execPath, [join(fixture.livePackage, 'dist', 'src', 'index.js'), '--version'], { encoding: 'utf8' }).stdout.trim()).toBe('2.0.0');
    const newPid = Number(readFileSync(pidFile, 'utf8'));
    expect(newPid).not.toBe(oldPid);
    expect(() => process.kill(newPid, 0)).not.toThrow(); // the daemon runs afterwards
  }, 150_000);
});
