/**
 * Tests for `bin/imcodes-launch.sh` — the pure-bash self-healing
 * supervisor that fronts the Node daemon for systemd / launchctl.
 *
 * We can't run the launcher's real npm install path in CI (it would
 * actually try to install imcodes globally), so the tests stub `node`
 * and `npm` with shell shims placed earlier on PATH, then assert the
 * launcher's branching behavior:
 *
 *   1. Healthy install → exec's the entry (no repair, exit 0).
 *   2. Half-installed deps → triggers `npm install -g …@<pinned>`.
 *   3. `dist/src/index.js` missing → also triggers reinstall.
 *   4. Repair fail (npm exits 1) → still exec's the entry (so systemd's
 *      Restart=always doesn't get stuck on the repair shim, and the
 *      next boot retries from scratch).
 *   5. Doesn't roll forward — pinned version comes from package.json.
 *
 * Each test materialises a fake "global install" tree under a tmpdir
 * so the launcher's `readlink -f $0` walk lands inside our sandbox.
 *
 * Skipped on Windows — bash isn't ambient there. The Linux+macOS
 * launcher path is what we need to pin; Windows has its own watchdog
 * (windows-upgrade-script.ts) that solves the same problem differently.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const LAUNCHER_SRC = resolve(REPO_ROOT, 'bin/imcodes-launch.sh');

const skip = process.platform === 'win32';
const describeUnix = skip ? describe.skip : describe;

interface Sandbox {
  root: string;          // tmpdir base
  pkgRoot: string;       // .../lib/node_modules/imcodes/
  binDir: string;        // shim dir on PATH
  launcher: string;      // copy of imcodes-launch.sh inside pkgRoot/bin/
  homeDir: string;       // fake $HOME / $IMCODES_HOME
  npmCallLog: string;    // file shim writes argv to
}

/**
 * Build a fake global install tree:
 *   <root>/lib/node_modules/imcodes/
 *     package.json (version: 1.2.3)
 *     dist/src/index.js (optional, see opts.withDist)
 *     bin/imcodes-launch.sh (the real launcher under test)
 *     node_modules/<deps>/  — half-installed iff opts.halfInstalledDeps lists them
 *   <root>/shims/
 *     node     — wrapper that prints args + exits with `nodeExitCode` (default 0)
 *     npm      — wrapper that records args to npmCallLog + exits with `npmExitCode`
 *   <root>/home/.imcodes/
 */
function makeSandbox(opts: {
  withDist?: boolean;
  halfInstalledDeps?: string[];
  nodeExitCode?: number;
  npmExitCode?: number;
}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'imcodes-launch-'));
  const pkgRoot = join(root, 'lib', 'node_modules', 'imcodes');
  const binDir = join(root, 'shims');
  const homeDir = join(root, 'home');
  const npmCallLog = join(root, 'npm-calls.log');
  mkdirSync(pkgRoot, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(homeDir, '.imcodes'), { recursive: true });

  // package.json with a known pinned version.
  writeFileSync(
    join(pkgRoot, 'package.json'),
    JSON.stringify({ name: 'imcodes', version: '1.2.3' }),
  );

  // dist/src/index.js (optional).
  if (opts.withDist !== false) {
    mkdirSync(join(pkgRoot, 'dist', 'src'), { recursive: true });
    writeFileSync(
      join(pkgRoot, 'dist', 'src', 'index.js'),
      '#!/usr/bin/env node\nconsole.log("entry-ok");\n',
    );
  }

  // node_modules: by default ALL CRITICAL_DEPS are healthy; opts.halfInstalledDeps
  // marks specific ones as empty placeholders (the real failure mode).
  const allCritical = ['commander', 'ws', 'cors', 'body-parser', 'hono', '@huggingface/transformers'];
  const half = new Set(opts.halfInstalledDeps ?? []);
  for (const dep of allCritical) {
    const depDir = join(pkgRoot, 'node_modules', dep);
    mkdirSync(depDir, { recursive: true });
    if (!half.has(dep)) {
      writeFileSync(join(depDir, 'package.json'), JSON.stringify({ name: dep, version: '0.0.0' }));
    }
    // half-installed deps: dir exists, package.json missing.
  }

  // Copy the real launcher into the sandbox bin dir so its `readlink -f $0`
  // resolves to a sandbox path (and finds package.json/dist/node_modules
  // beside it).
  const launcher = join(pkgRoot, 'bin', 'imcodes-launch.sh');
  mkdirSync(join(pkgRoot, 'bin'), { recursive: true });
  const launcherBody = readFileSync(LAUNCHER_SRC, 'utf8');
  writeFileSync(launcher, launcherBody, { mode: 0o755 });

  // node shim — prints args, exits with the configured code. The launcher
  // calls node TWO ways: (1) `node -e ...require(package.json)...` to read
  // pinned version, (2) `exec node entry start --foreground` as the final
  // hand-off. We need (1) to actually parse JSON, so the shim falls
  // through to a built-in JSON.parse for the `-e` path.
  const nodeShim = `#!/usr/bin/env bash
# Test shim for the real \`node\`. Forwards \`-e\` to the real node so the
# launcher can read the pinned version from package.json. Anything else
# (the daemon hand-off) just records args and exits with a configured code.
if [ "$1" = "-e" ]; then
  exec ${process.execPath} "$@"
fi
echo "node-shim called with: $@" >> "${join(root, 'node-calls.log')}"
exit ${opts.nodeExitCode ?? 0}
`;
  writeFileSync(join(binDir, 'node'), nodeShim, { mode: 0o755 });

  // npm shim — records argv so we can assert the launcher attempted the
  // exact `npm install -g imcodes@<pinned>` call.
  const npmShim = `#!/usr/bin/env bash
echo "npm $@" >> "${npmCallLog}"
exit ${opts.npmExitCode ?? 0}
`;
  writeFileSync(join(binDir, 'npm'), npmShim, { mode: 0o755 });

  return { root, pkgRoot, binDir, launcher, homeDir, npmCallLog };
}

function runLauncher(sb: Sandbox): { stdout: string; stderr: string; status: number | null } {
  // systemd ExecStart / launchctl ProgramArguments ALWAYS pass
  // "start --foreground" — that's what the unit/plist generators write
  // (see `src/util/launch-target.ts`). Replicate that calling convention
  // here so the launcher's `exec "$NODE" "$ENTRY" "$@"` sees real args.
  const r = spawnSync(sb.launcher, ['start', '--foreground'], {
    env: {
      ...process.env,
      // PATH: shims first so `command -v node`/`command -v npm` resolve to the shims.
      PATH: `${sb.binDir}:${process.env.PATH ?? ''}`,
      HOME: sb.homeDir,
      IMCODES_HOME: sb.homeDir,
      // Repair log goes inside the sandbox so the assertion file lookups
      // don't depend on the real $HOME.
      IMCODES_LAUNCH_REPAIR_LOG: join(sb.homeDir, '.imcodes', 'launch-repair.log'),
    },
    encoding: 'utf8',
    timeout: 15_000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

describeUnix('bin/imcodes-launch.sh', () => {
  it('healthy install: exec\'s the entry without repairing', () => {
    const sb = makeSandbox({});
    try {
      const r = runLauncher(sb);
      expect(r.status).toBe(0);
      // Repair must NOT have been attempted.
      expect(existsSync(sb.npmCallLog)).toBe(false);
      // node shim was called with the entry path + args.
      const nodeLog = readFileSync(join(sb.root, 'node-calls.log'), 'utf8');
      expect(nodeLog).toContain(`${sb.pkgRoot}/dist/src/index.js`);
      expect(nodeLog).toContain('start');
      expect(nodeLog).toContain('--foreground');
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  it('half-installed deps: triggers npm install -g imcodes@<pinned> and still exec\'s the entry', () => {
    // Simulate the real failure mode: `commander/` and `ws/` exist but are
    // empty (no package.json). Daemon would crash on import; launcher
    // should detect this BEFORE handing off and reinstall.
    const sb = makeSandbox({ halfInstalledDeps: ['commander', 'ws'] });
    try {
      const r = runLauncher(sb);
      expect(r.status).toBe(0);
      expect(existsSync(sb.npmCallLog)).toBe(true);
      const npmLog = readFileSync(sb.npmCallLog, 'utf8');
      // Pinned version comes from sandbox package.json (1.2.3).
      // --ignore-scripts mirrors the manual recovery procedure used on
      // 212/213/215 (and the daemon's own upgrade script step 2).
      expect(npmLog).toContain('install -g');
      expect(npmLog).toContain('--ignore-scripts');
      expect(npmLog).toContain('imcodes@1.2.3');
      // Stderr must surface what was missing — operators rely on this
      // log line when diagnosing why a server self-repaired.
      expect(r.stderr).toMatch(/half-installed/);
      expect(r.stderr).toMatch(/commander/);
      // After repair the launcher still hands off to node so the daemon
      // actually starts (with the freshly-repaired install).
      const nodeLog = readFileSync(join(sb.root, 'node-calls.log'), 'utf8');
      expect(nodeLog).toContain('start');
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  it('missing dist/src/index.js: triggers reinstall', () => {
    const sb = makeSandbox({ withDist: false });
    try {
      runLauncher(sb);
      expect(existsSync(sb.npmCallLog)).toBe(true);
      const npmLog = readFileSync(sb.npmCallLog, 'utf8');
      expect(npmLog).toContain('imcodes@1.2.3');
      // The summary in stderr names the missing path so operators can
      // distinguish "deps half-extracted" from "package files wiped".
      // (Both signal "reinstall" but they're different incidents.)
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  it('repair install fails: launcher still exec\'s the entry (don\'t wedge systemd on the repair shim)', () => {
    // If npm repair returns non-zero (e.g. transient network failure), we
    // still hand off to the real node entry. Daemon will fail to import
    // and exit 1; systemd Restart=always retries; next boot the launcher
    // tries the repair again. This loop converges as soon as npm
    // succeeds even once — vs. blocking forever on the failed shim.
    const sb = makeSandbox({ halfInstalledDeps: ['commander'], npmExitCode: 1 });
    try {
      const r = runLauncher(sb);
      expect(r.stderr).toMatch(/self-repair FAILED/);
      // Despite repair failure, the entry was still invoked.
      const nodeLog = readFileSync(join(sb.root, 'node-calls.log'), 'utf8');
      expect(nodeLog).toContain('start');
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  it('clears stale upgrade.lock.d/ (older than threshold) at every launch', () => {
    // The lock isn't a daemon-blocker on Linux/macOS, but a stuck lock
    // surprises operators — and the bash upgrade script's own 30 min
    // stale watchdog only fires when a new upgrade is initiated. The
    // launcher acts as a continuous sweeper: any stale lock gets cleared
    // on the next daemon start, even with no upgrade attempt in sight.
    const sb = makeSandbox({});
    try {
      const lockDir = join(sb.homeDir, '.imcodes', 'upgrade.lock.d');
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, 'started'), '0');  // epoch 1970 → very stale
      runLauncher(sb);
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  it('does NOT clear a fresh upgrade.lock.d/ (an in-flight upgrade really is running)', () => {
    const sb = makeSandbox({});
    try {
      const lockDir = join(sb.homeDir, '.imcodes', 'upgrade.lock.d');
      mkdirSync(lockDir, { recursive: true });
      const now = Math.floor(Date.now() / 1000);
      writeFileSync(join(lockDir, 'started'), String(now));
      runLauncher(sb);
      expect(existsSync(lockDir)).toBe(true);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  it('does not roll forward versions — repair targets the pinned version, not @latest', () => {
    // Operators rely on the launcher being a SAFETY NET, not an upgrade
    // path. If a half-install left the daemon broken on v1.2.3, the
    // launcher must restore v1.2.3 — not jump them to whatever
    // `npm view imcodes version` returns today. Surprise version
    // changes during automated recovery were how 78 ended up with a
    // stale-path ExecStart for 988 minutes.
    const sb = makeSandbox({ halfInstalledDeps: ['commander'] });
    try {
      // Edit package.json mid-flight to a non-default version so we know
      // the assertion isn't passing by the default.
      writeFileSync(
        join(sb.pkgRoot, 'package.json'),
        JSON.stringify({ name: 'imcodes', version: '99.88.77-dev.42' }),
      );
      runLauncher(sb);
      const npmLog = readFileSync(sb.npmCallLog, 'utf8');
      expect(npmLog).toContain('imcodes@99.88.77-dev.42');
      expect(npmLog).not.toContain('@latest');
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });
});
