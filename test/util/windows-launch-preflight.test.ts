/**
 * Tests for `src/util/windows-launch-preflight.mjs` — the Windows-side
 * counterpart of `bin/imcodes-launch.sh`. Same self-heal contract: detect
 * half-installed `node_modules`, reinstall the pinned version, never
 * roll forward, never wedge the watchdog on a failed npm.
 *
 * Each test materialises a fake "global install" tree under a tmpdir so
 * the preflight's package-root resolution (`SELF/../../../..`) lands
 * inside the sandbox. We stub `npm.cmd` (Windows) / `npm` (POSIX) by
 * placing a shell shim at the front of PATH that records argv to a
 * file. Real npm is never invoked.
 *
 * Runs on every platform — `windows-launch-preflight.mjs` itself uses
 * only Node built-ins. The Windows-specific name is about its CALLER
 * (the .cmd watchdog), not the script's runtime.
 */
import { describe, expect, it } from 'vitest';
import {
  mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const PREFLIGHT_SRC = join(process.cwd(), 'src', 'util', 'windows-launch-preflight.mjs');

interface Sandbox {
  root: string;
  pkgRoot: string;
  preflight: string;       // copy of the preflight at <pkg>/dist/src/util/
  shimDir: string;
  homeDir: string;
  npmCallLog: string;
  repairLog: string;
}

function makeSandbox(opts: {
  withDist?: boolean;
  halfInstalledDeps?: string[];
  npmExitCode?: number;
  pinnedVersion?: string;
}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'win-preflight-'));
  const pkgRoot = join(root, 'lib', 'node_modules', 'imcodes');
  const distSrcUtil = join(pkgRoot, 'dist', 'src', 'util');
  const shimDir = join(root, 'shims');
  const homeDir = join(root, 'home');
  const npmCallLog = join(root, 'npm-calls.log');
  const repairLog = join(homeDir, '.imcodes', 'launch-repair.log');

  mkdirSync(distSrcUtil, { recursive: true });
  mkdirSync(shimDir, { recursive: true });
  mkdirSync(join(homeDir, '.imcodes'), { recursive: true });

  // package.json with pinned version (default 1.2.3, override per test).
  writeFileSync(
    join(pkgRoot, 'package.json'),
    JSON.stringify({ name: 'imcodes', version: opts.pinnedVersion ?? '1.2.3' }),
  );

  // dist/src/index.js (optional).
  if (opts.withDist !== false) {
    writeFileSync(
      join(pkgRoot, 'dist', 'src', 'index.js'),
      '#!/usr/bin/env node\nconsole.log("entry-ok");\n',
    );
  }

  // node_modules: critical deps healthy except those in halfInstalledDeps.
  const allCritical = ['commander', 'ws', 'cors', 'body-parser', 'hono', '@huggingface/transformers'];
  const half = new Set(opts.halfInstalledDeps ?? []);
  for (const dep of allCritical) {
    const depDir = join(pkgRoot, 'node_modules', dep);
    mkdirSync(depDir, { recursive: true });
    if (!half.has(dep)) {
      writeFileSync(join(depDir, 'package.json'), JSON.stringify({ name: dep, version: '0.0.0' }));
    }
  }

  // Copy preflight into sandbox so its `import.meta.url`-based root
  // resolution (`SELF → util/ → src/ → dist/ → PKG_ROOT`) lands here.
  const preflight = join(distSrcUtil, 'windows-launch-preflight.mjs');
  writeFileSync(preflight, readFileSync(PREFLIGHT_SRC, 'utf8'));

  // npm shim — captures argv. Both `npm` and `npm.cmd` so the
  // platform-conditional in the preflight resolves to the right name.
  const shimBody = `#!/usr/bin/env bash
echo "$@" >> "${npmCallLog}"
exit ${opts.npmExitCode ?? 0}
`;
  for (const name of ['npm', 'npm.cmd']) {
    const p = join(shimDir, name);
    writeFileSync(p, shimBody, { mode: 0o755 });
  }

  return { root, pkgRoot, preflight, shimDir, homeDir, npmCallLog, repairLog };
}

function runPreflight(sb: Sandbox): { stderr: string; status: number | null } {
  const r = spawnSync(process.execPath, [sb.preflight], {
    env: {
      ...process.env,
      PATH: `${sb.shimDir}:${process.env.PATH ?? ''}`,
      HOME: sb.homeDir,
      USERPROFILE: sb.homeDir,        // Windows env name; preflight uses homedir() either way
      IMCODES_HOME: sb.homeDir,
      IMCODES_LAUNCH_REPAIR_LOG: sb.repairLog,
    },
    encoding: 'utf8',
    timeout: 15_000,
  });
  return { stderr: r.stderr ?? '', status: r.status };
}

describe('src/util/windows-launch-preflight.mjs', () => {
  it('healthy install: exits 0 without invoking npm', () => {
    const sb = makeSandbox({});
    try {
      const r = runPreflight(sb);
      expect(r.status).toBe(0);
      expect(existsSync(sb.npmCallLog)).toBe(false);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  it('half-installed deps: invokes npm install -g --ignore-scripts imcodes@<pinned>', () => {
    const sb = makeSandbox({ halfInstalledDeps: ['commander', 'hono'] });
    try {
      const r = runPreflight(sb);
      expect(r.status).toBe(0);
      expect(existsSync(sb.npmCallLog)).toBe(true);
      const npmLog = readFileSync(sb.npmCallLog, 'utf8');
      expect(npmLog).toContain('install -g');
      expect(npmLog).toContain('--ignore-scripts');
      expect(npmLog).toContain('--prefer-online');
      expect(npmLog).toContain('imcodes@1.2.3');
      expect(r.stderr).toMatch(/half-installed/);
      expect(r.stderr).toMatch(/commander/);
      expect(r.stderr).toMatch(/hono/);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  it('missing dist/src/index.js: triggers reinstall', () => {
    const sb = makeSandbox({ withDist: false });
    try {
      runPreflight(sb);
      expect(existsSync(sb.npmCallLog)).toBe(true);
      const npmLog = readFileSync(sb.npmCallLog, 'utf8');
      expect(npmLog).toContain('imcodes@1.2.3');
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  it('repair install fails: exits 0 anyway (so the watchdog retries)', () => {
    // Watchdog must NOT get wedged on a failed npm. Next loop iteration
    // re-runs the preflight; converges as soon as one install succeeds.
    const sb = makeSandbox({ halfInstalledDeps: ['commander'], npmExitCode: 1 });
    try {
      const r = runPreflight(sb);
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/self-repair FAILED/);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  it('does NOT roll forward — repair targets the package.json pinned version', () => {
    const sb = makeSandbox({ halfInstalledDeps: ['ws'], pinnedVersion: '99.88.77-dev.42' });
    try {
      runPreflight(sb);
      const npmLog = readFileSync(sb.npmCallLog, 'utf8');
      expect(npmLog).toContain('imcodes@99.88.77-dev.42');
      expect(npmLog).not.toContain('@latest');
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  it('clears stale upgrade.lock.d/ (older than threshold) before checking deps', () => {
    const sb = makeSandbox({});
    try {
      // Plant an upgrade.lock.d/ with an old mtime. Preflight must
      // delete it because age > IMCODES_LAUNCH_LOCK_STALE_AFTER_SEC.
      const lockDir = join(sb.homeDir, '.imcodes', 'upgrade.lock.d');
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, 'started'), '0');
      // Force old mtime: utimes via fs.
      const past = new Date(Date.now() - 2 * 3600 * 1000); // 2 hours ago
      const fs = require('node:fs');
      fs.utimesSync(lockDir, past, past);
      const r = runPreflight(sb);
      expect(r.status).toBe(0);
      expect(existsSync(lockDir)).toBe(false);
      expect(r.stderr).toMatch(/clearing stale upgrade lock/);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  it('does NOT clear a fresh upgrade.lock.d/ (an in-flight upgrade really is running)', () => {
    const sb = makeSandbox({});
    try {
      const lockDir = join(sb.homeDir, '.imcodes', 'upgrade.lock.d');
      mkdirSync(lockDir, { recursive: true });
      // Default mtime is now → age ≈ 0 → must stay.
      runPreflight(sb);
      expect(existsSync(lockDir)).toBe(true);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });
});
