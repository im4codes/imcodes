#!/usr/bin/env node
/**
 * Published-tarball postinstall: self-heal a half-installed sharp subtree
 * after `npm install -g imcodes` (or `imcodes@dev`).
 *
 * Why this exists
 * ───────────────
 * On the daemon-side auto-upgrade path we run
 *   npm install -g --ignore-scripts --prefer-online imcodes@…
 * and then run an inline bash sharp-repair block (see
 * `src/util/sharp-repair-script.ts`). That path is safe.
 *
 * The HUMAN-side path is `npm install -g imcodes@dev` with no extra flags.
 * That triggers sharp's `install` lifecycle:
 *   node install/check.js || npm run build
 * On npm 11 + global install + nested-deps, sharp can extract without its
 * `install/` subdir — `install/check.js` is missing, the fallback
 * `npm run build` walks UP the script-resolution chain, finds imcodes's
 * own `"build": "tsc"`, tsc isn't on the install-context PATH, exits 127,
 * and the whole `npm i -g imcodes` aborts. Real-world hit on big@213.
 *
 * The prepack hook already neutralizes every imcodes lifecycle script
 * to `echo …` so that fallback-up no longer explodes — but a SUCCESSFUL
 * sharp install is no guarantee that all of sharp's transitive deps
 * actually got extracted. The same npm-global empty-dir bug we fixed on
 * the daemon side leaves placeholders for {detect-libc, semver,
 * @img/colour}. Without those the daemon crashes on first
 * `@huggingface/transformers` import and sticky-disables semantic search.
 *
 * Strategy
 * ────────
 * Same as the daemon-side bash repair: check each of SHARP_REQUIRED_DEPS
 * for a `package.json`. If any are missing, run
 *   npm install --no-save --ignore-scripts sharp@0.34.5
 * inside the imcodes package dir. The nested install does not hit the
 * same edge case as the top-level global install and reconciles every
 * sharp transitive dep at once.
 *
 * Constraints
 * ───────────
 * - **Never fail npm install.** Wrap everything in try/catch and exit 0
 *   no matter what. A failed postinstall can leave the user with a
 *   half-installed package that they then can't upgrade away from
 *   without manual intervention; the cost of skipping the repair is
 *   merely that semantic search degrades, which is recoverable.
 * - **No imcodes runtime imports.** This file runs with possibly-broken
 *   node_modules. Stick to Node built-ins + the sibling
 *   `sharp-repair-script.js` (constant-only import).
 * - **Idempotent.** Safe to re-run. The check short-circuits when every
 *   dep is already present.
 * - **No-op on git checkouts / dev installs.** When the imcodes repo
 *   itself runs `npm install`, the postinstall fires too. We detect dev
 *   by checking for a `.git` parent or absence of a global-install
 *   marker, and skip repair in that case so dev environments aren't
 *   forcibly reset to sharp@0.34.5.
 */
import { existsSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SHARP_REQUIRED_DEPS } from './sharp-repair-script.js';

const TAG = '[imcodes:postinstall]';

/**
 * Run the repair. Returns true if a repair was attempted (regardless of
 * outcome), false if no repair was needed.
 */
function runRepair(): boolean {
  // npm sets cwd to the package being installed for postinstall scripts,
  // so process.cwd() === the imcodes package root. Resolve to absolute
  // for safer logging / spawn semantics.
  const pkgRoot = resolve(process.cwd());

  // Dev-checkout guard: if a `.git` directory lives at or above the
  // package root we're almost certainly running inside the imcodes git
  // worktree (`npm install` for development). Skip repair — the
  // developer has their own deps under control and we shouldn't
  // forcibly install sharp@0.34.5 on top of whatever they're testing.
  if (isInsideGitWorktree(pkgRoot)) {
    console.log(`${TAG} dev checkout detected — skipping sharp repair`);
    return false;
  }

  // Quick sanity check: only run the repair when imcodes is actually
  // installed. If we can't see our own dist/ we're being run in some
  // unexpected context (e.g. published-but-not-yet-extracted) — bail.
  if (!existsSync(join(pkgRoot, 'dist'))) {
    console.log(`${TAG} no dist/ at cwd=${pkgRoot} — skipping`);
    return false;
  }

  const missing: string[] = [];
  for (const dep of SHARP_REQUIRED_DEPS) {
    const depPkg = join(pkgRoot, 'node_modules', dep, 'package.json');
    if (!existsSync(depPkg)) {
      missing.push(dep);
    }
  }

  if (missing.length === 0) {
    // Common case on a clean install — silent so we don't spam npm output.
    return false;
  }

  console.error(`${TAG} sharp subtree broken (missing: ${missing.join(', ')}) — running nested repair`);

  // Wipe any empty placeholders so the nested install repopulates them
  // cleanly. `rmdirSync` only removes empty dirs — exactly what we want
  // for the npm-global empty-placeholder case. A partially-extracted-
  // but-real install will throw ENOTEMPTY which we silently swallow.
  for (const dep of missing) {
    const depDir = join(pkgRoot, 'node_modules', dep);
    if (existsSync(depDir)) {
      try {
        rmdirSync(depDir);
      } catch {
        // Non-empty or already gone — fine either way.
      }
    }
  }

  // Resolve npm. `npm_execpath` is set by npm for every lifecycle script,
  // and per npm convention points at the JS entrypoint (npm-cli.js or
  // similar). To launch it we re-invoke our own Node binary with that
  // script as its first argv. If npm_execpath happens to be a native
  // shim (uncommon, but valid per the spec), invoke it directly. If it's
  // not set at all (run by a tool that doesn't set npm_*), fall back to
  // `npm` / `npm.cmd` on PATH.
  //
  // Using a fully-resolved argv (no `shell: true`) sidesteps the quoting
  // hazard where a JS execpath gets concatenated with the args and then
  // re-parsed by /bin/sh into a single non-existent binary path.
  const npmExec = process.env.npm_execpath;
  const installArgs = ['install', '--no-save', '--ignore-scripts', 'sharp@0.34.5'];
  let cmd: string;
  let argv: string[];
  let useShell = false;
  if (npmExec && /\.(c|m)?js$/i.test(npmExec)) {
    cmd = process.execPath;
    argv = [npmExec, ...installArgs];
  } else if (npmExec) {
    cmd = npmExec;
    argv = installArgs;
    // npm on Windows occasionally exposes npm_execpath as the .cmd / .bat
    // shim itself rather than the JS entrypoint. Node's spawn will not
    // launch a .cmd shim without going through the shell, so detect by
    // extension and route through cmd.exe.
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(npmExec)) {
      useShell = true;
    }
  } else {
    cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    argv = installArgs;
    // PATH lookup of `npm.cmd` on Windows requires the shell.
    useShell = process.platform === 'win32';
  }
  const result = spawnSync(cmd, argv, {
    cwd: pkgRoot,
    stdio: 'inherit',
    shell: useShell,
    env: { ...process.env },
  });

  if (result.status === 0) {
    console.error(`${TAG} sharp repair succeeded`);
  } else {
    // Non-fatal — log loudly and let the install finish.
    console.error(
      `${TAG} sharp repair FAILED (exit ${result.status ?? 'unknown'}). ` +
        `Run manually: cd "$(npm root -g)/imcodes" && ` +
        `npm install --no-save --ignore-scripts sharp@0.34.5`,
    );
  }
  return true;
}

/**
 * Walk up from `start` looking for a `.git` marker. Used to detect dev
 * checkouts so we don't forcibly reset their sharp version.
 *
 * Bounded to 8 levels — plenty for any reasonable project layout and
 * cheap if the marker is absent.
 */
function isInsideGitWorktree(start: string): boolean {
  let cur = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cur, '.git'))) return true;
    const parent = resolve(cur, '..');
    if (parent === cur) break;
    cur = parent;
  }
  return false;
}

// Top-level guard: this script must NEVER cause `npm install` to fail.
// Anything thrown synchronously gets swallowed; we always exit 0.
try {
  runRepair();
} catch (err) {
  console.error(`${TAG} unexpected error during sharp repair (non-fatal):`, err);
}
process.exit(0);
