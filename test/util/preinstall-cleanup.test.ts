/**
 * Tests for `src/util/preinstall-cleanup.mjs` — runs at the very start of
 * `npm install -g imcodes@…` (via the published-tarball preinstall hook
 * that strip-onnxruntime-gpu.mjs injects at pack time).
 *
 * Pinned behaviour:
 *   1. Removes `.imcodes-XXXXX` siblings npm leaves behind from a killed
 *      atomic-rename.
 *   2. Removes a stale `~/.imcodes/upgrade.lock.d/` (>30 min).
 *   3. Aborts with exit 1 + a clear stdout message when a CONCURRENT
 *      `imcodes-upgrade` script is running (would otherwise produce a
 *      confusing ENOTEMPTY when the two npm runs collide).
 *   4. Does NOT abort when invoked FROM INSIDE the daemon's own
 *      upgrade.sh (the upgrade is its own grandparent process — must
 *      be excluded via ancestry walk, not a flat PID/PPID check).
 *
 * Each test materialises a fake global prefix + fake $HOME so the
 * preinstall's resolution lands inside the sandbox and never touches
 * the developer's real install.
 */
import { describe, expect, it } from 'vitest';
import {
  mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const PREINSTALL_SRC = join(process.cwd(), 'src', 'util', 'preinstall-cleanup.mjs');
const skipOnWindows = process.platform === 'win32';
const describeUnix = skipOnWindows ? describe.skip : describe;

interface Sandbox {
  root: string;
  prefix: string;
  globalNodeModules: string;
  homeDir: string;
  shimDir: string;
  pgrepLog: string;
}

function makeSandbox(opts: {
  imcodesLeftovers?: string[];          // .imcodes-XXX dirs to plant
  staleLockSec?: number | 'fresh' | null; // age in seconds, or 'fresh' (now), or null (no lock)
  pgrepStdout?: string;                  // what `pgrep -af ...` should emit
}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'preinstall-'));
  const prefix = join(root, 'prefix');
  const globalNodeModules = join(prefix, 'lib', 'node_modules');
  const homeDir = join(root, 'home');
  const shimDir = join(root, 'shims');
  const pgrepLog = join(root, 'pgrep.log');
  mkdirSync(globalNodeModules, { recursive: true });
  mkdirSync(join(homeDir, '.imcodes'), { recursive: true });
  mkdirSync(shimDir, { recursive: true });

  // Plant `.imcodes-XXXXX` leftovers if requested.
  for (const name of opts.imcodesLeftovers ?? []) {
    const dir = join(globalNodeModules, name);
    mkdirSync(dir, { recursive: true });
    // Plant a file inside so a naive `rmdir` would fail — proves we
    // recursively `rmSync` properly.
    writeFileSync(join(dir, 'leftover.txt'), 'stale');
  }

  // Plant upgrade.lock.d/ with the requested age, if any.
  if (opts.staleLockSec != null) {
    const lockDir = join(homeDir, '.imcodes', 'upgrade.lock.d');
    mkdirSync(lockDir);
    const startedFile = join(lockDir, 'started');
    if (opts.staleLockSec === 'fresh') {
      writeFileSync(startedFile, String(Math.floor(Date.now() / 1000)));
    } else {
      const ageSec = opts.staleLockSec as number;
      writeFileSync(startedFile, String(Math.floor(Date.now() / 1000) - ageSec));
    }
  }

  // Stub `npm` and `pgrep` shims on PATH.
  // `npm prefix -g` → echo our sandbox prefix.
  writeFileSync(
    join(shimDir, 'npm'),
    `#!/usr/bin/env bash
case "$1 $2" in
  "prefix -g") echo "${prefix}" ;;
  *) echo "npm shim: unhandled args: $@" >&2; exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  // pgrep -af PATTERN → emit a controllable stdout. The script also
  // does `|| true` so a non-zero exit means "no matches".
  const pgrepShim = `#!/usr/bin/env bash
echo "$@" >> "${pgrepLog}"
${opts.pgrepStdout ? `cat <<'__EOF__'\n${opts.pgrepStdout}\n__EOF__` : 'exit 1'}
`;
  writeFileSync(join(shimDir, 'pgrep'), pgrepShim, { mode: 0o755 });

  return { root, prefix, globalNodeModules, homeDir, shimDir, pgrepLog };
}

function runPreinstall(sb: Sandbox, env: Record<string, string | null> = {}): {
  stdout: string; stderr: string; status: number | null;
} {
  // `null` in the override map = "delete this key from inherited env". We
  // need this so the "npm_config_prefix missing" case can scrub a value
  // that may already be set in the developer's / CI's shell.
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') baseEnv[k] = v;
  }
  const finalEnv: Record<string, string> = {
    ...baseEnv,
    PATH: `${sb.shimDir}:${process.env.PATH ?? ''}`,
    HOME: sb.homeDir,
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === null) {
      delete finalEnv[k];
    } else {
      finalEnv[k] = v;
    }
  }
  const r = spawnSync(process.execPath, [PREINSTALL_SRC], {
    env: finalEnv,
    encoding: 'utf8',
    timeout: 15_000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

describeUnix('src/util/preinstall-cleanup.mjs', () => {
  it('clean install: exits 0 with no work', () => {
    const sb = makeSandbox({});
    try {
      const r = runPreinstall(sb, { npm_config_prefix: sb.prefix });
      expect(r.status).toBe(0);
      // No leftovers planted → no removal logs.
      expect(r.stdout).not.toMatch(/removing leftover/);
      expect(r.stdout).not.toMatch(/clearing stale/);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  it('removes `.imcodes-XXXXX` siblings (npm atomic-rename leftovers)', () => {
    const sb = makeSandbox({
      imcodesLeftovers: ['.imcodes-Vuo7WXWs', '.imcodes-aaaaaaaa'],
    });
    try {
      const r = runPreinstall(sb, { npm_config_prefix: sb.prefix });
      expect(r.status).toBe(0);
      expect(existsSync(join(sb.globalNodeModules, '.imcodes-Vuo7WXWs'))).toBe(false);
      expect(existsSync(join(sb.globalNodeModules, '.imcodes-aaaaaaaa'))).toBe(false);
      expect(r.stdout).toMatch(/removing leftover/);
      expect(r.stdout).toMatch(/\.imcodes-Vuo7WXWs/);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  it('does NOT touch dirs that don\'t match `.imcodes-` prefix', () => {
    const sb = makeSandbox({});
    try {
      // Plant some unrelated dirs that would be catastrophic to nuke.
      mkdirSync(join(sb.globalNodeModules, 'imcodes'), { recursive: true });
      mkdirSync(join(sb.globalNodeModules, 'npm'), { recursive: true });
      mkdirSync(join(sb.globalNodeModules, 'something-else'), { recursive: true });
      runPreinstall(sb, { npm_config_prefix: sb.prefix });
      expect(existsSync(join(sb.globalNodeModules, 'imcodes'))).toBe(true);
      expect(existsSync(join(sb.globalNodeModules, 'npm'))).toBe(true);
      expect(existsSync(join(sb.globalNodeModules, 'something-else'))).toBe(true);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  it('clears stale upgrade.lock.d/ (older than threshold)', () => {
    const sb = makeSandbox({ staleLockSec: 7200 });  // 2 hours old
    try {
      const r = runPreinstall(sb, { npm_config_prefix: sb.prefix });
      expect(r.status).toBe(0);
      expect(existsSync(join(sb.homeDir, '.imcodes', 'upgrade.lock.d'))).toBe(false);
      expect(r.stdout).toMatch(/clearing stale upgrade.lock.d/);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  it('does NOT clear a fresh upgrade.lock.d/ (an in-flight upgrade is real)', () => {
    const sb = makeSandbox({ staleLockSec: 'fresh' });
    try {
      const r = runPreinstall(sb, { npm_config_prefix: sb.prefix });
      // Fresh lock + no concurrent upgrade detected → exits 0, lock stays.
      expect(r.status).toBe(0);
      expect(existsSync(join(sb.homeDir, '.imcodes', 'upgrade.lock.d'))).toBe(true);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  it('aborts with exit 1 + clear message when a concurrent imcodes-upgrade is running', () => {
    // Daemon-triggered upgrade still going. User runs `npm i -g imcodes@dev`
    // in parallel → we DETECT this and abort before npm collides.
    const sb = makeSandbox({
      pgrepStdout: '99999 /bin/bash /tmp/imcodes-upgrade-zLrgli/upgrade.sh',
    });
    try {
      const r = runPreinstall(sb, { npm_config_prefix: sb.prefix });
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/Another `imcodes upgrade` is already running/);
      expect(r.stdout).toMatch(/imcodes-upgrade-zLrgli/);
      // Hint for user: how to recover.
      expect(r.stdout).toMatch(/pkill -f imcodes-upgrade/);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  it('does NOT abort when running INSIDE the daemon\'s own upgrade.sh (PID is our ancestor)', () => {
    // The bash upgrade.sh runs `npm install -g imcodes@…`, which runs our
    // preinstall, which would naively pgrep and find ITSELF (its own
    // grandparent process). The ancestry walk must filter that out.
    //
    // We simulate this by making pgrep return a PID that IS our actual
    // process's ancestor — process.ppid (npm wrapper's parent in the
    // test runner). It's not actually an upgrade.sh, but the script
    // doesn't validate the command — it only checks the PID isn't an
    // ancestor.
    const sb = makeSandbox({
      pgrepStdout: `${process.ppid} /bin/bash /tmp/imcodes-upgrade-self/upgrade.sh`,
    });
    try {
      const r = runPreinstall(sb, { npm_config_prefix: sb.prefix });
      // Should NOT abort — the only "upgrade" pgrep sees is our ancestor.
      expect(r.status).toBe(0);
      expect(r.stdout).not.toMatch(/Another `imcodes upgrade` is already running/);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  it('respects IMCODES_PREINSTALL_SKIP_CONCURRENT_CHECK=1 env override', () => {
    // Escape hatch for environments where pgrep is unreliable (e.g. CI
    // containers with weird process namespacing). Operator can opt out
    // of the concurrent check while keeping the residue cleanup.
    const sb = makeSandbox({
      pgrepStdout: '99999 /bin/bash /tmp/imcodes-upgrade-XXX/upgrade.sh',
    });
    try {
      const r = runPreinstall(sb, {
        npm_config_prefix: sb.prefix,
        IMCODES_PREINSTALL_SKIP_CONCURRENT_CHECK: '1',
      });
      expect(r.status).toBe(0);
      expect(r.stdout).not.toMatch(/Another `imcodes upgrade`/);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  it('falls back to `npm prefix -g` when npm_config_prefix is missing', () => {
    // Some npm versions don't set npm_config_prefix during preinstall on
    // global installs. The script must still find the prefix via the
    // npm shim invocation. Use the shim PATH only — no env var.
    const sb = makeSandbox({
      imcodesLeftovers: ['.imcodes-shim-test'],
    });
    try {
      // Explicitly scrub npm_config_prefix in case the test runner's
      // shell had it set — we WANT to exercise the fallback path.
      const r = runPreinstall(sb, { npm_config_prefix: null });
      expect(r.status).toBe(0);
      expect(existsSync(join(sb.globalNodeModules, '.imcodes-shim-test'))).toBe(false);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  it('clears stale lock dir based on dir mtime when `started` file is missing', () => {
    // Older daemons may have created upgrade.lock.d/ without writing
    // a `started` file. Fall back to the dir's mtime.
    const sb = makeSandbox({});
    try {
      const lockDir = join(sb.homeDir, '.imcodes', 'upgrade.lock.d');
      mkdirSync(lockDir);
      // No `started` file — backdate dir mtime to 2 hours ago.
      const past = new Date(Date.now() - 7200 * 1000);
      utimesSync(lockDir, past, past);
      const r = runPreinstall(sb, { npm_config_prefix: sb.prefix });
      expect(r.status).toBe(0);
      expect(existsSync(lockDir)).toBe(false);
      expect(r.stdout).toMatch(/clearing stale upgrade.lock.d/);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });
});
