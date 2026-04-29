import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { SHARP_REQUIRED_DEPS } from '../../src/util/sharp-repair-script.js';

/**
 * Integration test for the published-tarball postinstall script. We exercise
 * the dist-emitted .js (not the .ts) because that's what npm actually runs
 * on user machines — testing the source would let TS-only fixups silently
 * regress at runtime.
 *
 * Layout each test sets up:
 *   <fakePkgRoot>/
 *     dist/                          (so dev-checkout guard passes)
 *     dist/src/util/postinstall-sharp-repair.js  (built)
 *     node_modules/<dep>/package.json (or absent, per scenario)
 *
 * We never actually want a real `npm install sharp` to run during these
 * tests — it would download ~30 MB and hit the registry. So we stub
 * `npm` by setting `npm_execpath` to a script that records its invocation
 * and exits 0 without doing anything.
 */

const POSTINSTALL_JS = join(
  process.cwd(),
  'dist',
  'src',
  'util',
  'postinstall-sharp-repair.js',
);

describe('postinstall-sharp-repair (built)', () => {
  let workdir: string;
  let stubNpmLog: string;
  let stubNpm: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'imc-postinstall-'));
    // Mark as a "published install" (has dist/), not a dev checkout.
    mkdirSync(join(workdir, 'dist'), { recursive: true });

    // Stub npm: record args + cwd to a log file, exit 0.
    stubNpmLog = join(workdir, 'npm-invocations.log');
    stubNpm = join(workdir, 'fake-npm.mjs');
    writeFileSync(
      stubNpm,
      `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(stubNpmLog)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
process.exit(0);
`,
    );
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  /** Run the published postinstall script with the given cwd + npm stub. */
  function runPostinstall(cwd: string): { status: number | null; stdout: string; stderr: string } {
    if (!existsSync(POSTINSTALL_JS)) {
      throw new Error(
        `Built postinstall script missing at ${POSTINSTALL_JS}. ` +
          `Run \`npm run build\` before \`npm test\`.`,
      );
    }
    const result = spawnSync(process.execPath, [POSTINSTALL_JS], {
      cwd,
      env: {
        ...process.env,
        // Route the script's `npm install` through our stub. Per npm's
        // convention, `npm_execpath` points at the JS entrypoint —
        // postinstall-sharp-repair sees the `.mjs` extension and re-
        // invokes Node against it, exactly like real npm.
        npm_execpath: stubNpm,
      },
      encoding: 'utf8',
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }

  /** Plant a fake package.json for one of sharp's transitive deps. */
  function plantDep(root: string, dep: string) {
    const dir = join(root, 'node_modules', dep);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: dep, version: '0.0.0-stub' }));
  }

  /** Plant an empty placeholder dir (the npm-global bug we self-heal). */
  function plantEmptyPlaceholder(root: string, dep: string) {
    mkdirSync(join(root, 'node_modules', dep), { recursive: true });
  }

  it('exits 0 even when no deps are present (must never break npm install)', () => {
    // No deps planted at all → repair should fire but our stub returns 0,
    // so overall exit must be 0.
    const result = runPostinstall(workdir);
    expect(result.status).toBe(0);
  });

  it('skips repair when every required dep already has a package.json', () => {
    for (const dep of SHARP_REQUIRED_DEPS) plantDep(workdir, dep);
    const result = runPostinstall(workdir);
    expect(result.status).toBe(0);
    // Stub log should be absent — npm install was never called.
    expect(existsSync(stubNpmLog)).toBe(false);
  });

  it('triggers nested npm install when ANY required dep is missing', () => {
    // Plant all but the first dep — the absence of just one dep must be
    // enough to trip the repair, matching the bash version's semantics.
    for (const dep of SHARP_REQUIRED_DEPS.slice(1)) plantDep(workdir, dep);

    const result = runPostinstall(workdir);
    expect(result.status).toBe(0);
    // Stub recorded one invocation.
    expect(existsSync(stubNpmLog)).toBe(true);
    const lines = readFileSync(stubNpmLog, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const { argv, cwd } = JSON.parse(lines[0]);
    expect(argv).toEqual([
      'install',
      '--no-save',
      '--ignore-scripts',
      'sharp@0.34.5',
    ]);
    // macOS resolves /var/folders/... → /private/var/folders/... when the
    // child reads cwd, so compare on canonical realpaths.
    expect(realpathSync(cwd)).toBe(realpathSync(workdir));
  });

  it('cleans up empty placeholder dirs before the nested install', () => {
    // The nested install refuses to repopulate dirs that exist with bad
    // metadata — same hazard we mitigate on the daemon-bash path.
    plantEmptyPlaceholder(workdir, 'sharp');
    plantEmptyPlaceholder(workdir, 'detect-libc');
    // Also plant a real one so we know we don't blow it away.
    plantDep(workdir, '@img/colour');
    plantDep(workdir, 'semver');

    const result = runPostinstall(workdir);
    expect(result.status).toBe(0);
    // Empty placeholders should be gone.
    expect(existsSync(join(workdir, 'node_modules', 'sharp'))).toBe(false);
    expect(existsSync(join(workdir, 'node_modules', 'detect-libc'))).toBe(false);
    // The real one is left alone.
    expect(existsSync(join(workdir, 'node_modules', '@img', 'colour', 'package.json'))).toBe(true);
  });

  it('skips entirely when running inside a git worktree (dev checkout)', () => {
    // Mark the workdir as a git checkout — dev-mode guard kicks in.
    mkdirSync(join(workdir, '.git'), { recursive: true });
    // Even with all deps missing, the script should NOT call npm.
    const result = runPostinstall(workdir);
    expect(result.status).toBe(0);
    expect(existsSync(stubNpmLog)).toBe(false);
    expect(result.stdout).toContain('dev checkout detected');
  });

  it('skips when there is no dist/ at cwd (unexpected install context)', () => {
    rmSync(join(workdir, 'dist'), { recursive: true, force: true });
    const result = runPostinstall(workdir);
    expect(result.status).toBe(0);
    expect(existsSync(stubNpmLog)).toBe(false);
    expect(result.stdout).toContain('no dist/');
  });
});
