import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
// A STATIC import, on purpose: it is evaluated when this file loads, which is
// the moment src/util/logger.ts computes LOG_DIR from homedir() and opens
// daemon.log. Only isolation that already happened by then can redirect it, so
// this import is the assertion that the harness acts at the earliest point.
import staticallyImportedLogger from '../../src/util/logger.js';

/**
 * Tests must not write into the developer's real ~/.imcodes.
 *
 * Production incident: 1558 lines in a real daemon.log came from test fixtures,
 * 48 of them stamped with a mocked clock, and they distorted the analysis of an
 * unrelated production incident. The mechanism is one line in
 * src/util/logger.ts:
 *
 *   const LOG_DIR = join(homedir(), '.imcodes', 'logs');
 *
 * evaluated at MODULE IMPORT time, and `buildLogger()` runs at import too. Under
 * vitest process.stdout.isTTY is false, so the logger takes its daemon branch
 * and immediately mkdirs and opens that path for append. Importing anything that
 * transitively imports the logger is therefore enough to append to the real
 * daemon.log — no test needs to log on purpose.
 *
 * Filtering the log after the write cannot fix this: by then the bytes are in
 * the production file and indistinguishable from daemon output. The home has to
 * be isolated before the first import evaluates a path.
 */

// From passwd, NOT from $HOME — so it still names the real user home after the
// harness has overridden the environment variable.
const REAL_HOME = userInfo().homedir;
const REAL_IMCODES_HOME = join(REAL_HOME, '.imcodes');
const REAL_DAEMON_LOG = join(REAL_IMCODES_HOME, 'logs', 'daemon.log');

/** Read the real daemon.log if it exists. Read-only: never created here. */
function realDaemonLog(): string {
  try {
    return existsSync(REAL_DAEMON_LOG) ? readFileSync(REAL_DAEMON_LOG, 'utf8') : '';
  } catch {
    return '';
  }
}

describe('daemon test workers run in an isolated home', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('does not inherit the real home or a production IMCODES_HOME', () => {
    expect(process.env.HOME, 'HOME is unset, so os.homedir() falls back to passwd').toBeTruthy();
    expect(process.env.HOME, 'the worker inherited the real user home').not.toBe(REAL_HOME);
    // os.homedir() must follow it, because that is what all 190 call sites use.
    expect(homedir()).toBe(process.env.HOME);

    expect(process.env.IMCODES_HOME, 'IMCODES_HOME is unset in the worker').toBeTruthy();
    expect(process.env.IMCODES_HOME, 'the worker inherited the production IMCODES_HOME')
      .not.toBe(REAL_IMCODES_HOME);
    // Not merely different — outside the real home entirely, so no code path can
    // walk into it.
    expect(process.env.IMCODES_HOME?.startsWith(REAL_HOME + '/')).toBe(false);
    expect(process.env.HOME?.startsWith(REAL_HOME + '/')).toBe(false);
  });

  it('sends an imported logger into the isolated home and leaves the real log alone', async () => {
    // Checked BEFORE anything is written: if the harness is not isolating the
    // home, this test must fail without appending a single line to the real
    // daemon.log. A RED that pollutes the file it is protecting is not a RED.
    expect(process.env.HOME, 'refusing to log: HOME is the real user home').not.toBe(REAL_HOME);

    const isolatedHome = process.env.HOME!;
    const marker = `isolated-home-guard-${randomUUID()}`;
    const before = realDaemonLog();

    const { default: logger } = await import('../../src/util/logger.js');
    logger.info({ marker }, 'isolated home guard');
    // pino's file destination is async; flush before reading.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const isolatedLog = join(isolatedHome, '.imcodes', 'logs', 'daemon.log');
    expect(existsSync(isolatedLog), 'the logger did not write inside the isolated home').toBe(true);
    expect(readFileSync(isolatedLog, 'utf8')).toContain(marker);

    // The real log gained nothing: not the marker, and not any new bytes from us.
    const after = realDaemonLog();
    expect(after).not.toContain(marker);
    expect(after.length).toBeGreaterThanOrEqual(before.length);
  });

  it('keeps mocked-clock log lines out of the real log', async () => {
    expect(process.env.HOME, 'refusing to log: HOME is the real user home').not.toBe(REAL_HOME);

    // The 48 lines that distorted the incident timeline looked like this: a test
    // with a frozen clock logged, and pino stamped the fake time into the real
    // production log.
    const frozen = new Date('2001-02-03T04:05:06.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(frozen);

    const marker = `mocked-clock-guard-${randomUUID()}`;
    const { default: logger } = await import('../../src/util/logger.js');
    logger.info({ marker }, 'mocked clock guard');
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const isolatedLog = join(process.env.HOME!, '.imcodes', 'logs', 'daemon.log');
    const isolated = readFileSync(isolatedLog, 'utf8');
    expect(isolated).toContain(marker);
    // The fake timestamp is real evidence of the mechanism: it landed in the
    // isolated log, which is exactly where such a line belongs.
    expect(isolated).toContain(`"time":${frozen.getTime()}`);
    expect(realDaemonLog()).not.toContain(marker);
  });

  it('redirects a logger that was imported at file load, before any hook ran', async () => {
    expect(process.env.HOME, 'refusing to log: HOME is the real user home').not.toBe(REAL_HOME);

    // If the home were switched in a beforeAll/beforeEach instead of a setup
    // file, LOG_DIR would already have been bound to the real home by the time
    // this static import was evaluated, and the line below would land in the
    // production log.
    const marker = `static-import-guard-${randomUUID()}`;
    staticallyImportedLogger.info({ marker }, 'static import guard');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const isolatedLog = join(process.env.HOME!, '.imcodes', 'logs', 'daemon.log');
    expect(readFileSync(isolatedLog, 'utf8')).toContain(marker);
    expect(realDaemonLog()).not.toContain(marker);
  });

  it('shows the mechanism: the logger follows HOME at import time', () => {
    // A stand-in for the real home, so this demonstrates the defect without
    // writing anywhere near it. Pre-fix, the runner's HOME was the real home and
    // this is precisely what happened to it.
    const standInHome = mkdtempSync(join(tmpdir(), 'imcodes-stand-in-home-'));
    try {
      const result = spawnSync(
        process.execPath,
        [
          '--import', 'tsx',
          '-e',
          "const m = await import('./src/util/logger.ts'); m.default.info('stand-in probe');"
            + ' await new Promise(r => setTimeout(r, 50));',
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, HOME: standInHome, IMCODES_HOME: join(standInHome, '.imcodes') },
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      // No isolation inside that process: the log lands under whatever HOME it
      // inherited. Nothing else in the codebase stands between a test import and
      // the real daemon.log.
      expect(existsSync(join(standInHome, '.imcodes', 'logs', 'daemon.log'))).toBe(true);
    } finally {
      rmSync(standInHome, { recursive: true, force: true });
    }
  }, 90_000);
});

describe('isolated home ownership and overrides', () => {
  it('removes only the root it owns', async () => {
    const setup = await import('./isolated-home.js');
    const { ISOLATED_HOME_RUN_ROOT_ENV } = await import('./isolated-home-global.js');
    const runRoot = process.env[ISOLATED_HOME_RUN_ROOT_ENV];

    // Two layers: the run owns one directory, each worker owns a subdirectory of
    // it named after its own pid and worker id.
    expect(setup.RUN_SCOPED, 'globalSetup did not provide a run root').toBe(true);
    expect(runRoot).toBe(join(tmpdir(), `imcodes-test-homes-${process.ppid}`));
    // A unique directory per setup-file invocation: the owner names it, it does
    // not identify it. Sharing one directory per worker leaks disk state between
    // the files that worker runs.
    expect(setup.ISOLATED_HOME.startsWith(join(runRoot!, `w-${process.pid}-${process.env.VITEST_WORKER_ID ?? '0'}-`)))
      .toBe(true);
    expect(setup.ISOLATED_HOME)
      .not.toBe(join(runRoot!, `w-${process.pid}-${process.env.VITEST_WORKER_ID ?? '0'}`));

    // A sibling belonging to some other worker of the SAME run, which this
    // worker must never touch.
    const otherWorkersRoot = join(runRoot!, 'w-999999-other');
    const otherWorkersFile = join(otherWorkersRoot, '.imcodes', 'keep-me');
    mkdirSync(join(otherWorkersRoot, '.imcodes'), { recursive: true });
    writeFileSync(otherWorkersFile, 'still in use');

    try {
      setup.removeIsolatedHomeRootForTests();
      expect(existsSync(setup.ISOLATED_HOME), 'own root survived cleanup').toBe(false);
      expect(existsSync(otherWorkersFile), 'cleanup crossed into another worker root').toBe(true);
    } finally {
      rmSync(otherWorkersRoot, { recursive: true, force: true });
      // Restore this worker's root for the remaining tests and the afterAll.
      mkdirSync(setup.ISOLATED_IMCODES_HOME, { recursive: true });
    }
  });

  it('lets a test supply its own home without interference', () => {
    // 19 daemon test files already do exactly this. setupFiles runs before the
    // test file, so an explicit override is always the later write and wins.
    const ownHome = mkdtempSync(join(tmpdir(), 'imcodes-test-own-home-'));
    const previousHome = process.env.HOME;
    const previousImcodesHome = process.env.IMCODES_HOME;
    try {
      process.env.HOME = ownHome;
      process.env.IMCODES_HOME = join(ownHome, '.imcodes');
      expect(homedir()).toBe(ownHome);
      // And it is still not the real home, so the guard stays satisfied.
      expect(ownHome).not.toBe(REAL_HOME);
    } finally {
      process.env.HOME = previousHome;
      process.env.IMCODES_HOME = previousImcodesHome;
      rmSync(ownHome, { recursive: true, force: true });
    }
  });
});

describe('the guard fails a test file that points the home back at the real one', () => {
  it('fails the run and names the leak', () => {
    // Proving the wiring, not just the predicate: this runs vitest against a
    // probe that leaks HOME, through a throwaway config that uses the very same
    // setup file, and requires the run to fail.
    // The throwaway config lives beside the probe rather than in tmpdir, because
    // a config outside the repo cannot resolve `vitest/config`. It is a
    // *.config.ts, so it is not a test file and the suite never picks it up, and
    // it is removed in the finally below.
    const configPath = join(process.cwd(), 'test', 'setup', 'fixtures', `guard-probe.${randomUUID()}.config.ts`);
    writeFileSync(configPath, `import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: ${JSON.stringify(process.cwd())},
  test: {
    name: 'guard-probe',
    include: ['test/setup/fixtures/leaks-real-home.integration.test.ts'],
    environment: 'node',
    globals: false,
    setupFiles: ['./test/setup/isolated-home.ts'],
  },
});
`);
    try {
      const result = spawnSync(
        join(process.cwd(), 'node_modules', '.bin', 'vitest'),
        ['run', '--config', configPath],
        { cwd: process.cwd(), encoding: 'utf8', timeout: 180_000, env: { ...process.env, CI: '1' } },
      );
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      expect(result.status, `guard did not fail the run:\n${output}`).not.toBe(0);
      expect(output).toContain('leaked to the real user home');
      expect(output).toContain('writing under the real ~/.imcodes');
    } finally {
      rmSync(configPath, { force: true });
    }
  }, 240_000);
});

describe('parallel workers leave nothing behind and never touch the inherited home', () => {
  it('gives each test file its own home when one worker runs them back to back', () => {
    // The leak this pins: a home derived from pid + worker id is SHARED by every
    // file that worker runs, so file B starts inside the tree file A left behind.
    // singleFork + fileParallelism:false is the shape that holds pid and worker
    // id constant across files, which is exactly when the old naming collided.
    // Only the environment was ever reset per file; the filesystem was not.
    const ownedTmp = mkdtempSync(join(tmpdir(), 'imcodes-sequential-tmp-'));
    const standInHome = mkdtempSync(join(tmpdir(), 'imcodes-stand-in-home-'));
    const configPath = join(process.cwd(), 'test', 'setup', 'fixtures', `sequential-probe.${randomUUID()}.config.ts`);
    writeFileSync(configPath, `import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: ${JSON.stringify(process.cwd())},
  test: {
    name: 'sequential-probe',
    include: [
      'test/setup/fixtures/writes-home-a.integration.test.ts',
      'test/setup/fixtures/writes-home-b.integration.test.ts',
    ],
    environment: 'node',
    globals: false,
    fileParallelism: false,
    poolOptions: { forks: { singleFork: true } },
    setupFiles: ['./test/setup/isolated-home.ts'],
    globalSetup: ['./test/setup/isolated-home-global.ts'],
  },
});
`);
    try {
      const result = spawnSync(
        join(process.cwd(), 'node_modules', '.bin', 'vitest'),
        ['run', '--config', configPath],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 300_000,
          env: { ...process.env, CI: '1', TMPDIR: ownedTmp, HOME: standInHome, IMCODES_HOME: join(standInHome, '.imcodes') },
        },
      );
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      expect(result.status, `sequential run failed:\n${output}`).toBe(0);
      expect(output).toContain('2 passed');
      expect(output).not.toContain('state leaked from a previous test file');
      // Same worker, both files: pid and worker id were constant, so only a
      // per-invocation directory can have kept them apart.
      expect(readdirSync(ownedTmp).filter((entry) => entry.startsWith('imcodes-test-home'))).toEqual([]);
      expect(existsSync(join(standInHome, '.imcodes'))).toBe(false);
    } finally {
      rmSync(configPath, { force: true });
      rmSync(ownedTmp, { recursive: true, force: true });
      rmSync(standInHome, { recursive: true, force: true });
    }
  }, 360_000);

  it('cleans every worker root after a parallel run, and writes nothing to the run home', () => {
    // Two things are proven in one nested run:
    //  1. cleanup ownership under PARALLEL workers. Per-worker cleanup was not
    //     enough: 15 roots survived a real `--maxWorkers=4` daemon run, because a
    //     worker can be killed and because a subprocess can re-create the tree
    //     after that worker's afterAll. Probe B spawns exactly such a child.
    //  2. zero writes to the home the run inherited. The child run gets
    //     HOME=<stand-in>, which is what the real ~/ is from its point of view;
    //     if isolation ever failed, .imcodes would appear there.
    // TMPDIR is redirected to a directory this test owns, so "nothing left
    // behind" is an exact statement about this run and cannot see any other.
    const ownedTmp = mkdtempSync(join(tmpdir(), 'imcodes-parallel-tmp-'));
    const standInHome = mkdtempSync(join(tmpdir(), 'imcodes-stand-in-home-'));
    const configPath = join(process.cwd(), 'test', 'setup', 'fixtures', `parallel-probe.${randomUUID()}.config.ts`);
    writeFileSync(configPath, `import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: ${JSON.stringify(process.cwd())},
  test: {
    name: 'parallel-probe',
    include: [
      'test/setup/fixtures/writes-home-a.integration.test.ts',
      'test/setup/fixtures/writes-home-b.integration.test.ts',
    ],
    environment: 'node',
    globals: false,
    fileParallelism: true,
    maxWorkers: 2,
    minWorkers: 2,
    setupFiles: ['./test/setup/isolated-home.ts'],
    globalSetup: ['./test/setup/isolated-home-global.ts'],
  },
});
`);
    try {
      const result = spawnSync(
        join(process.cwd(), 'node_modules', '.bin', 'vitest'),
        ['run', '--config', configPath],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 300_000,
          env: { ...process.env, CI: '1', TMPDIR: ownedTmp, HOME: standInHome, IMCODES_HOME: join(standInHome, '.imcodes') },
        },
      );
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      expect(result.status, `probe run failed:\n${output}`).toBe(0);
      // Both probes ran, i.e. both workers really did write into their homes.
      expect(output).toContain('2 passed');

      // 1. Nothing survives: no run root, no worker directory, nothing.
      const leftovers = readdirSync(ownedTmp).filter((entry) => entry.startsWith('imcodes-test-home'));
      expect(leftovers, `isolated roots survived a parallel run: ${leftovers.join(', ')}`).toEqual([]);

      // 2. The inherited home was never written to — no .imcodes at all, so no
      //    logs and no state.
      expect(existsSync(join(standInHome, '.imcodes')), 'the run wrote into the home it inherited').toBe(false);
      expect(readdirSync(standInHome)).toEqual([]);
    } finally {
      rmSync(configPath, { force: true });
      rmSync(ownedTmp, { recursive: true, force: true });
      rmSync(standInHome, { recursive: true, force: true });
    }
  }, 360_000);
});

describe('harness-owned probe fixtures never leak into a standing Vitest config', () => {
  // CI run 34745118391: `npm run test:integration` collected the probes below
  // because they end in `.integration.test.ts`, the very suffix that kept them
  // out of the daemon project. Outside their harness IMCODES_HOME is unset, so
  // both write probes threw ERR_INVALID_ARG_TYPE. Every standing config must
  // exclude them by LOCATION; only the throwaway configs above may run them.
  const repoRoot = process.cwd();
  const fixturesDir = join(repoRoot, 'test', 'setup', 'fixtures');
  const vitestBin = join(repoRoot, 'node_modules', '.bin', 'vitest');
  // Discovered, not hard-coded, so a config added later is guarded automatically.
  // Configs under web/ and server/ are rooted in those directories and cannot
  // reach test/setup; the root config still loads web's as one of its projects.
  const standingConfigs = readdirSync(repoRoot)
    .filter((name) => /^vitest(?:\.[\w-]+)?\.config\.(?:ts|mts|js|mjs)$/u.test(name))
    .sort();

  function collectedFiles(configPath: string): string[] {
    const result = spawnSync(vitestBin, ['list', '--filesOnly', '--json', '--config', configPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, CI: '1' },
    });
    expect(result.status, `vitest list failed for ${configPath}:\n${result.stderr}`).toBe(0);
    return (JSON.parse(result.stdout) as Array<{ file: string }>).map((entry) => entry.file);
  }

  it('guards every repo-root Vitest config, including the integration one', () => {
    expect(standingConfigs).toEqual(expect.arrayContaining(['vitest.config.ts', 'vitest.integration.config.ts']));
  });

  it.each(standingConfigs.map((name) => [name]))(
    '%s collects no probe fixture, whatever the fixture is named',
    (name) => {
      // A probe that does NOT carry the integration suffix: if only the filename
      // kept fixtures out, this one would be collected by the daemon project.
      const ordinaryProbe = join(fixturesDir, `leak-canary.${randomUUID()}.test.ts`);
      writeFileSync(ordinaryProbe, "import { it } from 'vitest';\nit('is never collected by a standing config', () => {});\n");
      try {
        const files = collectedFiles(join(repoRoot, name));
        expect(files.length, `${name} collected nothing; the listing itself is broken`).toBeGreaterThan(0);
        expect(files.filter((file) => file.startsWith(`${fixturesDir}/`)), `${name} collected harness-owned probes`)
          .toEqual([]);
      } finally {
        rmSync(ordinaryProbe, { force: true });
      }
    },
    180_000,
  );

  it('still lets the owning harness collect the probes it runs', () => {
    // The exclusion must not reach the throwaway configs: they name the probes
    // explicitly and carry no exclude, which is how the tests above run them.
    const configPath = join(fixturesDir, `collection-probe.${randomUUID()}.config.ts`);
    writeFileSync(configPath, `import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: ${JSON.stringify(repoRoot)},
  test: {
    name: 'collection-probe',
    include: [
      'test/setup/fixtures/writes-home-a.integration.test.ts',
      'test/setup/fixtures/writes-home-b.integration.test.ts',
      'test/setup/fixtures/leaks-real-home.integration.test.ts',
    ],
  },
});
`);
    try {
      expect(collectedFiles(configPath).map((file) => file.slice(fixturesDir.length + 1)).sort()).toEqual([
        'leaks-real-home.integration.test.ts',
        'writes-home-a.integration.test.ts',
        'writes-home-b.integration.test.ts',
      ]);
    } finally {
      rmSync(configPath, { force: true });
    }
  }, 180_000);
});
