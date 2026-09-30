#!/usr/bin/env node
/**
 * Staged, switchable install of the global `imcodes` package (Linux, macOS and Windows).
 *
 * `npm install -g` replaces the live package IN PLACE: if it is interrupted (SSH
 * drop, OOM, power loss) the package is left half-replaced and the daemon's
 * launcher is gone (production incident on 215: 203/EXEC, daemon down ~5 min).
 * This helper never touches the live package until a complete, verified copy
 * exists next to it:
 *
 *   stage     preflight (prefix writable, free disk >= 2x package), then
 *             `npm install -g --prefix <stage>` into a sibling of the global root
 *   verify    the staged (or live) package has its bin files and its entry script
 *             prints the expected version
 *   switch    two same-filesystem renames: live -> .imcodes-old.<tag>, staged -> live
 *             (rolled back at once if the second fails), then re-link the bins
 *   rollback  put .imcodes-old.<tag> back (used when the new daemon does not come up)
 *   commit    drop the old copy and the stage
 *   recover   heal an interrupted switch (live missing, an old copy present)
 *   clean     remove a tree and prove it is gone (Node 24 rmSync silently keeps non-ASCII paths on Windows)
 *
 * STANDALONE ON PURPOSE: node builtins only, no relative imports. The upgrade
 * script copies this one file into its scratch directory and runs it from there,
 * because the package it lives in is replaced while it runs (the same reason the
 * Windows upgrade runner is copied alone).
 *
 * One file, two callers: the POSIX upgrade script runs every command (npm included); the
 * Windows upgrade runner runs its own npm (it needs its cmd.exe-free spawn rules) and uses
 * `recover`, `preflight`, `verify`, `switch`, `rollback` and `commit` from here, so the swap
 * logic exists once. Windows differences: npm's global layout has no `lib/`
 * (<prefix>\node_modules\imcodes), there are .cmd shims instead of bin symlinks (the runner
 * copies those), and a directory holding a loaded native addon cannot be renamed while a
 * process has it open -- renames therefore retry with bounded backoff on EPERM/EBUSY/EACCES
 * (antivirus and indexers hold files briefly) and report exit 78 when the lock outlasts it.
 *
 * Exit codes: 0 ok, 75 install/verify failure (the old package is untouched),
 * 76 prefix not writable, 77 not enough free disk, 78 a rename stayed locked (nothing moved,
 * or what moved was put back), 2 usage.
 */
import { spawnSync } from 'node:child_process';
import {
  accessSync, appendFileSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, statfsSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

const EXIT_OK = 0;
const EXIT_INSTALL_FAILED = 75;
const EXIT_PREFIX_NOT_WRITABLE = 76;
const EXIT_LOW_DISK = 77;
const EXIT_LOCKED = 78;
const EXIT_USAGE = 2;

const PACKAGE = 'imcodes';
const OLD_PREFIX = '.imcodes-old.';
const FAILED_PREFIX = '.imcodes-failed.';
const STAGE_PREFIX = '.imcodes-stage.';
/** Conservative size assumed when the registry does not report one (bundled deps make the package large). */
const FALLBACK_PACKAGE_BYTES = 400 * 1024 * 1024;
const STALE_LEFTOVER_MS = 24 * 60 * 60 * 1000;

function say(message) {
  process.stdout.write(`[atomic-install] ${message}\n`);
}

class InstallError extends Error {
  constructor(code, message) {
    super(message);
    this.exitCode = code;
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) throw new InstallError(EXIT_USAGE, `unexpected argument ${arg}`);
    args[arg.slice(2)] = rest[i + 1] ?? '';
    i += 1;
  }
  return { command, args };
}

function need(args, name) {
  if (!args[name]) throw new InstallError(EXIT_USAGE, `missing --${name}`);
  return args[name];
}

/** The npm argv prefix: `[node, npm-cli.js]` when known, else bare `npm` (PATH already carries node). */
function npmInvocation(args) {
  if (args['npm-cli']) return { file: args.node || process.execPath, prefix: [args['npm-cli']] };
  return { file: 'npm', prefix: [] };
}

function runNpm(args, npmArgs, { timeoutMs, outputFile }) {
  const npm = npmInvocation(args);
  const result = spawnSync(npm.file, [...npm.prefix, ...npmArgs], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  if (outputFile) {
    try { appendFileSync(outputFile, `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `${result.error.message}\n` : ''}`); } catch { /* the log is best effort */ }
  }
  return result;
}

function registryArgs(args) {
  return args.registry ? ['--registry', args.registry] : [];
}

/** npm's global layout: `<prefix>\node_modules\imcodes` on Windows, `<prefix>/lib/node_modules/imcodes` elsewhere. */
function stagedPackageDir(stagePrefix) {
  const layout = process.env.IMCODES_INSTALL_LAYOUT || (process.platform === 'win32' ? 'windows' : 'posix');
  return layout === 'windows'
    ? join(stagePrefix, 'node_modules', PACKAGE)
    : join(stagePrefix, 'lib', 'node_modules', PACKAGE);
}

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let injectedRenameFailures = Number.parseInt(process.env.IMCODES_TEST_RENAME_FAIL_COUNT || '0', 10) || 0;

/**
 * rename() that survives a file lock that is about to be released. A lock that outlasts the
 * budget (default 30 s, exponential backoff capped at 2 s) is reported as EXIT_LOCKED with the
 * offending path, never retried forever. POSIX has no such locks: one attempt.
 */
function renameWithRetry(from, to) {
  const budgetMs = Number(process.env.IMCODES_RENAME_RETRY_MS || (process.platform === 'win32' || process.env.IMCODES_INSTALL_LAYOUT === 'windows' ? 30_000 : 0));
  const started = Date.now();
  let delay = 100;
  for (let attempt = 1; ; attempt += 1) {
    try {
      if (process.env.IMCODES_TEST_RENAME_FAIL_FOREVER === '1' || injectedRenameFailures > 0) {
        if (injectedRenameFailures > 0) injectedRenameFailures -= 1;
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' });
      }
      renameSync(from, to);
      if (attempt > 1) say(`rename ${from} succeeded on attempt ${attempt} after ${Date.now() - started} ms`);
      return;
    } catch (error) {
      const retryable = RETRYABLE_RENAME_CODES.has(error.code);
      if (!retryable || Date.now() - started >= budgetMs) {
        if (retryable && budgetMs > 0) {
          throw new InstallError(EXIT_LOCKED, `${from} stayed locked for ${Math.round((Date.now() - started) / 1000)} s (${error.code}); a process still has a file inside it open`);
        }
        throw error;
      }
      if (attempt === 1) say(`rename of ${from} is blocked (${error.code}); retrying with backoff for up to ${Math.round(budgetMs / 1000)} s`);
      sleepMs(Math.min(delay, 2000));
      delay = Math.min(delay * 2, 2000);
    }
  }
}

function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** Remove a file or tree the long way: entry by entry. */
function removeEntryByEntry(path) {
  let info;
  try { info = lstatSync(path); } catch { return; }
  if (info.isDirectory() && !info.isSymbolicLink()) {
    for (const name of readdirSync(path)) removeEntryByEntry(join(path, name));
    rmdirSync(path);
  } else {
    unlinkSync(path);
  }
}

/**
 * Remove a tree and PROVE it is gone. Node 24's rmSync on Windows returns success without deleting
 * when the path has non-ASCII characters (a Chinese user name in the profile is enough), so the
 * result is checked and, if the tree is still there, removed entry by entry, with a few retries
 * for a scanner or indexer that has a handle open for a moment.
 */
function removeTree(path) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* checked below */ }
    if (!existsSync(path) && !pathIsDangling(path)) return;
    try { removeEntryByEntry(path); } catch { /* checked below */ }
    if (!existsSync(path) && !pathIsDangling(path)) return;
    if (attempt < 5) sleepMs(200 * attempt);
  }
  throw new Error(`${path} is still there after removal attempts`);
}

function pathIsDangling(path) {
  try { lstatSync(path); return true; } catch { return false; }
}

function removeQuietly(path) {
  try { removeTree(path); return true; } catch (error) {
    say(`could not remove ${path}: ${error.message}`);
    return false;
  }
}

/** Free bytes on the filesystem holding `path`, or null when it cannot be read. */
function freeBytes(path) {
  try {
    const stats = statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function directoryBytes(path) {
  let total = 0;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      try {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(full);
        else total += statSync(full).size;
      } catch { /* vanished while walking */ }
    }
  };
  walk(path);
  return total;
}

function expectedPackageBytes(args, liveDir) {
  // A caller that already asked the registry (the Windows runner) passes the size.
  const given = Number.parseInt(args['expected-bytes'] || '', 10);
  if (Number.isFinite(given) && given > 0) return given;
  const view = runNpm(args, ['view', '--prefer-online', ...registryArgs(args), args.pkg, 'dist.unpackedSize', '--json'], { timeoutMs: 60_000 });
  const reported = Number.parseInt(String(view.stdout ?? '').trim().replace(/^"|"$/g, ''), 10);
  if (view.status === 0 && Number.isFinite(reported) && reported > 0) return reported;
  const live = isDirectory(liveDir) ? directoryBytes(liveDir) : 0;
  return Math.max(live, FALLBACK_PACKAGE_BYTES);
}

function preflight(args) {
  const globalRoot = need(args, 'global-root');
  if (!isDirectory(globalRoot)) throw new InstallError(EXIT_INSTALL_FAILED, `global root ${globalRoot} does not exist`);
  const parent = dirname(globalRoot);
  try {
    // A real create+delete, not access(W_OK): on Windows the permission bits say nothing about the ACL.
    for (const dir of [globalRoot, parent]) {
      accessSync(dir, constants.W_OK);
      const probe = join(dir, `.imcodes-probe.${process.pid}`);
      writeFileSync(probe, '');
      unlinkSync(probe);
    }
  } catch {
    throw new InstallError(
      EXIT_PREFIX_NOT_WRITABLE,
      `the npm global prefix (${parent}) is not writable by this user; nothing was changed. Fix the permissions, or install with an elevated user (for example: sudo npm install -g ${args.pkg ?? PACKAGE}).`,
    );
  }
  const needed = expectedPackageBytes(args, join(globalRoot, PACKAGE)) * 2;
  const free = freeBytes(globalRoot);
  if (free !== null && free < needed) {
    throw new InstallError(
      EXIT_LOW_DISK,
      `not enough free disk on ${globalRoot}: ${Math.floor(free / 1048576)} MB free, ${Math.ceil(needed / 1048576)} MB needed (2x the package); nothing was changed.`,
    );
  }
  say(`preflight ok: ${globalRoot} writable, ${free === null ? 'free space unknown' : `${Math.floor(free / 1048576)} MB free`}, ${Math.ceil(needed / 1048576)} MB required`);
}

function readPackage(packageDir) {
  return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
}

function binEntries(pkg) {
  if (!pkg.bin) return {};
  return typeof pkg.bin === 'string' ? { [pkg.name ?? PACKAGE]: pkg.bin } : pkg.bin;
}

/** Stage: preflight, then install into a sibling prefix. The live package is never touched. */
function stage(args) {
  const globalRoot = need(args, 'global-root');
  const stagePrefix = need(args, 'stage-prefix');
  const pkgSpec = need(args, 'pkg');
  preflight(args);
  removeQuietly(stagePrefix);
  mkdirSync(stagePrefix, { recursive: true });
  say(`staging ${pkgSpec} into ${stagePrefix}`);
  const result = runNpm(
    args,
    ['install', '-g', '--ignore-scripts', '--prefer-online', ...registryArgs(args), '--prefix', stagePrefix, pkgSpec],
    { timeoutMs: Number(args['timeout-ms'] || 15 * 60_000), outputFile: args['npm-output'] },
  );
  if (result.status !== 0 || result.error) {
    removeQuietly(stagePrefix);
    throw new InstallError(EXIT_INSTALL_FAILED, `npm install into the staging prefix failed (exit ${result.status ?? 'none'}${result.signal ? `, signal ${result.signal}` : ''}${result.error ? `, ${result.error.message}` : ''}); the live package at ${join(globalRoot, PACKAGE)} is untouched`);
  }
  if (!isDirectory(stagedPackageDir(stagePrefix))) {
    removeQuietly(stagePrefix);
    throw new InstallError(EXIT_INSTALL_FAILED, `npm reported success but ${stagedPackageDir(stagePrefix)} does not exist; the live package is untouched`);
  }
  say('staged install complete');
}

/** The entry script a package exposes: `dist/src/index.js`, the file every launcher execs. */
function entryScript(packageDir) {
  return join(packageDir, 'dist', 'src', 'index.js');
}

/** Verify a package directory: bins present, entry script prints the expected version. Returns the version. */
function verifyPackage(args, packageDir, expectedVersion) {
  if (!isDirectory(packageDir)) throw new InstallError(EXIT_INSTALL_FAILED, `${packageDir} is not a directory`);
  let pkg;
  try { pkg = readPackage(packageDir); } catch (error) { throw new InstallError(EXIT_INSTALL_FAILED, `${packageDir}/package.json is unreadable: ${error.message}`); }
  if (expectedVersion && expectedVersion !== 'latest' && pkg.version !== expectedVersion) {
    throw new InstallError(EXIT_INSTALL_FAILED, `installed version ${pkg.version} does not match the target ${expectedVersion}`);
  }
  for (const [name, target] of Object.entries(binEntries(pkg))) {
    if (!existsSync(join(packageDir, target))) throw new InstallError(EXIT_INSTALL_FAILED, `bin "${name}" -> ${target} is missing from the package`);
  }
  const entry = entryScript(packageDir);
  if (!existsSync(entry)) throw new InstallError(EXIT_INSTALL_FAILED, `entry script ${entry} is missing`);
  const probe = spawnSync(args.node || process.execPath, [entry, '--version'], { encoding: 'utf8', timeout: 60_000 });
  const printed = String(probe.stdout ?? '').trim();
  if (probe.status !== 0 || !printed) {
    throw new InstallError(EXIT_INSTALL_FAILED, `${basename(entry)} --version failed (exit ${probe.status ?? 'none'}): ${String(probe.stderr ?? '').trim().split('\n').slice(-3).join(' | ')}`);
  }
  if (expectedVersion && expectedVersion !== 'latest' && printed !== expectedVersion) {
    throw new InstallError(EXIT_INSTALL_FAILED, `${basename(entry)} --version printed ${printed}, expected ${expectedVersion}`);
  }
  return pkg.version;
}

function verify(args) {
  const packageDir = args['pkg-dir'] ?? stagedPackageDir(need(args, 'stage-prefix'));
  const version = verifyPackage(args, packageDir, args.target);
  say(`verified ${packageDir}: version ${version}`);
  process.stdout.write(`VERIFIED_VERSION=${version}\n`);
}

/** Make `<bin-dir>/<name>` resolve to the package's bin file (npm's own layout: a relative symlink). */
function relinkBins(binDir, packageDir) {
  if (!binDir) return;
  let pkg;
  try { pkg = readPackage(packageDir); } catch { return; }
  for (const [name, target] of Object.entries(binEntries(pkg))) {
    const wanted = join(packageDir, target);
    const link = join(binDir, name);
    try {
      let resolved = null;
      try { resolved = realpathSync(link); } catch { /* missing or dangling */ }
      if (resolved && resolved === realpathSync(wanted)) continue;
      const temporary = `${link}.imcodes-new.${process.pid}`;
      try { unlinkSync(temporary); } catch { /* none */ }
      symlinkSync(relative(binDir, wanted), temporary);
      renameSync(temporary, link);
      say(`re-linked ${link}`);
    } catch (error) {
      say(`could not re-link ${link} (non-fatal, the wrapper refresh covers it): ${error.message}`);
    }
  }
}

/** Switch: live -> .imcodes-old.<tag>, staged -> live. The second rename failing puts the first back. */
function switchInstall(args) {
  const globalRoot = need(args, 'global-root');
  const tag = need(args, 'tag');
  const staged = stagedPackageDir(need(args, 'stage-prefix'));
  const live = join(globalRoot, PACKAGE);
  const old = join(globalRoot, `${OLD_PREFIX}${tag}`);
  if (!isDirectory(staged)) throw new InstallError(EXIT_INSTALL_FAILED, `nothing staged at ${staged}`);
  let hadLive = false;
  try { lstatSync(live); hadLive = true; } catch { /* a fresh install has no live package */ }
  if (hadLive) {
    removeQuietly(old);
    // Nothing has moved yet: a lock here (EXIT_LOCKED) leaves the live package exactly as it was.
    renameWithRetry(live, old);
  }
  try {
    renameWithRetry(staged, live);
  } catch (error) {
    if (hadLive) {
      try { renameWithRetry(old, live); } catch (restoreError) { say(`RESTORE FAILED: ${restoreError.message}; the previous package is at ${old}`); }
    }
    throw new InstallError(error.exitCode ?? EXIT_INSTALL_FAILED, `could not move the staged package into place: ${error.message}; the previous package was put back`);
  }
  relinkBins(args['bin-dir'], live);
  say(`switched: ${live} is now the staged package${hadLive ? `; previous package kept at ${old}` : ''}`);
}

function rollback(args) {
  const globalRoot = need(args, 'global-root');
  const tag = need(args, 'tag');
  const live = join(globalRoot, PACKAGE);
  const old = join(globalRoot, `${OLD_PREFIX}${tag}`);
  if (!isDirectory(old)) throw new InstallError(EXIT_INSTALL_FAILED, `no previous package to roll back to at ${old}`);
  const failed = join(globalRoot, `${FAILED_PREFIX}${tag}`);
  removeQuietly(failed);
  try { renameWithRetry(live, failed); } catch (error) {
    // A locked failed package must not keep the previous one from coming back: fail loudly instead of pretending.
    if (existsSync(live)) throw error;
  }
  renameWithRetry(old, live);
  relinkBins(args['bin-dir'], live);
  say(`rolled back: ${live} is the previous package again (the failed one is at ${failed})`);
}

function commit(args) {
  const globalRoot = need(args, 'global-root');
  const tag = need(args, 'tag');
  removeQuietly(join(globalRoot, `${OLD_PREFIX}${tag}`));
  removeQuietly(join(globalRoot, `${FAILED_PREFIX}${tag}`));
  if (args['stage-prefix']) removeQuietly(args['stage-prefix']);
  say('committed: the previous package and the stage were removed');
}

/** Heal an interrupted switch, and sweep leftovers older than a day. */
function recover(args) {
  const globalRoot = need(args, 'global-root');
  const live = join(globalRoot, PACKAGE);
  let liveExists = false;
  try { lstatSync(live); liveExists = true; } catch { /* missing */ }
  const leftovers = readdirSync(globalRoot).filter((name) => name.startsWith(OLD_PREFIX) || name.startsWith(FAILED_PREFIX));
  if (!liveExists) {
    const olds = leftovers.filter((name) => name.startsWith(OLD_PREFIX))
      .map((name) => ({ name, at: statSync(join(globalRoot, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    if (olds.length > 0) {
      renameWithRetry(join(globalRoot, olds[0].name), live);
      relinkBins(args['bin-dir'], live);
      say(`recovered an interrupted switch: ${olds[0].name} is the live package again`);
    }
  }
  const now = Date.now();
  // Leftovers are named after the upgrade script that made them (its pid). One whose
  // owner is gone is an orphan (a killed or crashed run) and goes at once; one whose
  // owner still runs is left alone; anything unparseable goes after a day.
  const ownerIsGone = (name) => {
    const pid = Number.parseInt(name.slice(name.lastIndexOf('.') + 1), 10);
    if (!Number.isInteger(pid) || pid <= 1) return false;
    try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
  };
  const sweep = (dir, prefixes) => {
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
      const full = join(dir, name);
      try {
        if (ownerIsGone(name) || now - statSync(full).mtimeMs > STALE_LEFTOVER_MS) { say(`removing orphaned ${full}`); removeQuietly(full); }
      } catch { /* gone */ }
    }
  };
  sweep(globalRoot, [OLD_PREFIX, FAILED_PREFIX]);
  sweep(dirname(globalRoot), [STAGE_PREFIX]);
}

/** Remove a tree (the runner's stage and scratch directories), optionally after a delay. */
function clean(args) {
  const path = need(args, 'path');
  const delay = Number.parseInt(args['delay-ms'] || '0', 10);
  if (delay > 0) sleepMs(delay);
  removeTree(path);
  say(`removed ${path}`);
}

function preflightCommand(args) {
  preflight(args);
}

const COMMANDS = { stage, preflight: preflightCommand, verify, switch: switchInstall, rollback, commit, recover, clean };

function main() {
  let parsed;
  try { parsed = parseArgs(process.argv.slice(2)); } catch (error) {
    say(error.message);
    return EXIT_USAGE;
  }
  const run = COMMANDS[parsed.command];
  if (!run) {
    say(`unknown command ${parsed.command ?? '(none)'}; expected one of ${Object.keys(COMMANDS).join(', ')}`);
    return EXIT_USAGE;
  }
  try {
    run(parsed.args);
    return EXIT_OK;
  } catch (error) {
    say(`FAILED: ${error.message}`);
    return typeof error.exitCode === 'number' ? error.exitCode : EXIT_INSTALL_FAILED;
  }
}

// Always run: this file is only ever executed as a script (never imported). An
// "am I the entry point" guard compared argv[1] with the module URL and silently
// did NOTHING, exiting 0, whenever the two spellings of the path differed (macOS
// /var vs /private/var) -- a no-op that looked like a successful install.
process.exit(main());
