#!/usr/bin/env node
/**
 * Verify and repair node-datachannel after script-suppressed global installs.
 *
 * Pure Node built-ins only: this runs precisely when an optional native
 * dependency may be incomplete. It is shared by upgrade runners and launch
 * preflights so the first upgrade from an older daemon can self-heal before
 * the newly installed daemon starts.
 */
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const DEFAULT_PACKAGE_ROOT = resolve(dirname(SELF), '..', '..', '..');
const REPAIR_TIMEOUT_MS = 5 * 60_000;
const VERIFY_TIMEOUT_MS = 60_000;

export function isDirectInvocation(entryPath, selfPath = SELF) {
  if (!entryPath) return false;
  try {
    return realpathSync(entryPath) === realpathSync(selfPath);
  } catch {
    return resolve(entryPath) === resolve(selfPath);
  }
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: options.timeout,
    shell: false,
  });
}

function resolveCommandOnPath(commandName, env = process.env) {
  if (!commandName || isAbsolute(commandName)) return commandName;
  const pathValue = env.PATH ?? env.Path ?? '';
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, commandName);
    if (existsSync(candidate)) return candidate;
  }
  return commandName;
}

export function resolveNpmCliJs(npmCommand, nodeExecPath = process.execPath, env = process.env) {
  const candidates = [];
  if (
    typeof env.npm_execpath === 'string'
    && isAbsolute(env.npm_execpath)
    && basename(env.npm_execpath).toLowerCase() === 'npm-cli.js'
  ) {
    candidates.push(env.npm_execpath);
  }
  const roots = [dirname(nodeExecPath)];
  const resolvedNpm = resolveCommandOnPath(npmCommand, env);
  if (resolvedNpm && isAbsolute(resolvedNpm)) roots.unshift(dirname(resolvedNpm));
  for (const root of roots) {
    candidates.push(
      join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      join(root, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    );
  }
  for (const candidate of new Set(candidates)) {
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

function resolveLocalNodeDatachannelEntry(packageRoot) {
  const dependencyDir = join(packageRoot, 'node_modules', 'node-datachannel');
  try {
    const manifest = JSON.parse(readFileSync(join(dependencyDir, 'package.json'), 'utf8'));
    const rootExport = manifest?.exports?.['.'] ?? manifest?.exports;
    const target = typeof rootExport === 'string'
      ? rootExport
      : rootExport?.import ?? rootExport?.default ?? rootExport?.require ?? manifest?.main ?? './index.js';
    if (typeof target !== 'string' || target.length === 0) return '';
    const entry = resolve(dependencyDir, target);
    const root = resolve(dependencyDir);
    const separator = process.platform === 'win32' ? '\\' : '/';
    return entry === root || entry.startsWith(`${root}${separator}`) ? entry : '';
  } catch {
    return '';
  }
}

function verify(packageRoot) {
  // Do not use a bare package import: Node walks parent node_modules folders,
  // so a shared /tmp/node_modules or global test dependency can make a missing
  // package appear healthy after a half-install removed the local copy.
  const entry = resolveLocalNodeDatachannelEntry(packageRoot);
  if (!entry || !existsSync(entry)) return false;
  const moduleUrl = pathToFileURL(entry).href;
  const result = run(process.execPath, [
    '-e',
    `import(${JSON.stringify(moduleUrl)}).then(() => process.exit(0)).catch(() => process.exit(1))`,
  ], {
    cwd: packageRoot,
    stdio: 'ignore',
    timeout: VERIFY_TIMEOUT_MS,
  });
  return result.status === 0;
}

function readDependencySpec(packageRoot) {
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    return typeof manifest?.optionalDependencies?.['node-datachannel'] === 'string'
      ? manifest.optionalDependencies['node-datachannel']
      : '';
  } catch {
    return '';
  }
}

function isDirWritable(dirPath) {
  try {
    accessSync(dirPath, constants.W_OK);
  } catch {
    return false;
  }
  // Probe file creation/removal to catch EROFS or Windows ACL restrictions
  // without ever leaving stray files behind.
  const probePath = join(dirPath, `.imcodes-write-probe-${process.pid}-${Date.now()}`);
  let fd = null;
  try {
    fd = openSync(probePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try { unlinkSync(probePath); } catch { /* ignore */ }
  }
}

function isTargetWritable(packageRoot, dependencyDir) {
  const nodeModulesDir = join(packageRoot, 'node_modules');
  const writeBase = existsSync(nodeModulesDir) ? nodeModulesDir : packageRoot;
  if (!isDirWritable(writeBase)) return false;
  if (existsSync(dependencyDir) && !isDirWritable(dependencyDir)) return false;
  return true;
}

function restoreBackupIfNeeded(backupDir, dependencyDir) {
  if (backupDir && existsSync(backupDir) && !existsSync(dependencyDir)) {
    try { renameSync(backupDir, dependencyDir); } catch { /* best-effort restore */ }
  }
}

export function repairNodeDatachannel(options = {}) {
  const packageRoot = resolve(options.packageRoot ?? DEFAULT_PACKAGE_ROOT);
  const npmCommand = options.npmCommand
    ?? process.env.IMCODES_NPM_BIN
    ?? (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const configuredNpmCli = options.npmCli ?? process.env.IMCODES_NPM_CLI ?? '';
  const npmCli = configuredNpmCli || (
    process.platform === 'win32' ? resolveNpmCliJs(npmCommand) : ''
  );
  const log = options.log ?? (() => {});
  const runNpm = (args, cwd = packageRoot) => npmCli
    ? run(process.execPath, [npmCli, ...args], { cwd, timeout: REPAIR_TIMEOUT_MS })
    : run(npmCommand, args, { cwd, timeout: REPAIR_TIMEOUT_MS });
  const dependencySpec = readDependencySpec(packageRoot);
  if (!dependencySpec) return { available: false, attempted: false, repaired: false, reason: 'not_declared' };
  if (verify(packageRoot)) return { available: true, attempted: false, repaired: false };

  const nodeModulesDir = join(packageRoot, 'node_modules');
  const dependencyDir = join(nodeModulesDir, 'node-datachannel');
  if (!isTargetWritable(packageRoot, dependencyDir)) {
    log(`node_modules directory is not writable (${nodeModulesDir}) — skipping repair; relay remains enabled`);
    return { available: false, attempted: false, repaired: false, reason: 'not_writable' };
  }

  let attempted = false;
  let rebuildSnapshotDir = '';
  try {
    if (existsSync(join(dependencyDir, 'package.json'))) {
      attempted = true;
      log('node-datachannel native addon unavailable — rebuilding with lifecycle scripts enabled');
      try {
        rebuildSnapshotDir = join(nodeModulesDir, `.node-datachannel-rebuild-snapshot-${process.pid}-${Date.now()}`);
        cpSync(dependencyDir, rebuildSnapshotDir, { recursive: true, dereference: true });
      } catch (snapshotErr) {
        if (rebuildSnapshotDir && existsSync(rebuildSnapshotDir)) {
          try { rmSync(rebuildSnapshotDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        rebuildSnapshotDir = '';
        log(`node-datachannel rebuild snapshot failed: ${snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr)}`);
      }
      const rebuild = runNpm([
        'rebuild', '--global=false', '--prefix', packageRoot,
        'node-datachannel', '--ignore-scripts=false', '--foreground-scripts',
      ], packageRoot);
      if (verify(packageRoot)) {
        log('node-datachannel repair succeeded');
        return { available: true, attempted, repaired: true };
      }
      if (rebuild.status !== 0) {
        log(`node-datachannel rebuild returned non-zero [exit ${rebuild.status} signal ${rebuild.signal ?? 'none'}]; trying isolated dependency reinstall`);
      } else {
        log('node-datachannel rebuild completed but verification failed; trying isolated dependency reinstall');
      }
      // Restore the pre-rebuild snapshot before isolated reinstall so any in-place
      // lifecycle script writes never remain if isolated reinstall fails.
      if (rebuildSnapshotDir && existsSync(rebuildSnapshotDir)) {
        let failedRebuildDir = '';
        try {
          if (existsSync(dependencyDir)) {
            failedRebuildDir = join(nodeModulesDir, `.node-datachannel-failed-rebuild-${process.pid}-${Date.now()}`);
            renameSync(dependencyDir, failedRebuildDir);
          }
          renameSync(rebuildSnapshotDir, dependencyDir);
          rebuildSnapshotDir = '';
          if (failedRebuildDir && existsSync(failedRebuildDir)) {
            try { rmSync(failedRebuildDir, { recursive: true, force: true }); } catch { /* best-effort */ }
          }
        } catch (restoreErr) {
          if (failedRebuildDir && existsSync(failedRebuildDir) && !existsSync(dependencyDir)) {
            try { renameSync(failedRebuildDir, dependencyDir); } catch { /* best-effort */ }
          }
          log(`node-datachannel rebuild snapshot restore failed: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`);
        }
      }
    } else {
      log('node-datachannel package missing or incomplete — trying isolated dependency reinstall');
    }
  } finally {
    if (rebuildSnapshotDir && existsSync(rebuildSnapshotDir)) {
      try { rmSync(rebuildSnapshotDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }

  if (!verify(packageRoot)) {
    attempted = true;
    const stagingRoot = realpathSync(mkdtempSync(join(tmpdir(), 'imcodes-ndc-repair-')));
    let siblingStagingDir = '';
    let backupDir = '';
    try {
      writeFileSync(
        join(stagingRoot, 'package.json'),
        JSON.stringify({ name: 'imcodes-ndc-repair', private: true }),
      );
      // Install strictly in an isolated staging dir so npm Arborist never reifies
      // or mutates sibling packages (e.g. pino) inside the live packageRoot.
      const reinstall = runNpm([
        'install', '--global=false', '--prefix', stagingRoot,
        '--no-save', '--no-audit', '--no-fund', '--ignore-scripts=false', '--foreground-scripts',
        `node-datachannel@${dependencySpec}`,
      ], stagingRoot);
      if (reinstall.status !== 0) {
        log(`node-datachannel isolated reinstall returned non-zero [exit ${reinstall.status} signal ${reinstall.signal ?? 'none'}]`);
      } else if (!verify(stagingRoot)) {
        log('node-datachannel staging verification FAILED — leaving installed node_modules untouched');
      } else {
        const stagedDepDir = join(stagingRoot, 'node_modules', 'node-datachannel');
        mkdirSync(nodeModulesDir, { recursive: true });
        siblingStagingDir = join(nodeModulesDir, `.node-datachannel-staging-${process.pid}-${Date.now()}`);
        // Stage on the target filesystem before renaming so cross-device tmpdir() never fails with EXDEV.
        cpSync(stagedDepDir, siblingStagingDir, { recursive: true, dereference: true });
        if (existsSync(dependencyDir)) {
          backupDir = join(nodeModulesDir, `.node-datachannel-backup-${process.pid}-${Date.now()}`);
          renameSync(dependencyDir, backupDir);
        }
        try {
          renameSync(siblingStagingDir, dependencyDir);
          siblingStagingDir = '';
        } catch (swapError) {
          restoreBackupIfNeeded(backupDir, dependencyDir);
          throw swapError;
        }
        if (backupDir && existsSync(backupDir)) {
          try { rmSync(backupDir, { recursive: true, force: true }); } catch { /* best-effort */ }
          backupDir = '';
        }
      }
    } catch (error) {
      restoreBackupIfNeeded(backupDir, dependencyDir);
      log(`node-datachannel isolated reinstall error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (siblingStagingDir && existsSync(siblingStagingDir)) {
        try { rmSync(siblingStagingDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
      if (backupDir && existsSync(backupDir) && existsSync(dependencyDir)) {
        try { rmSync(backupDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
      try { rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }

  if (verify(packageRoot)) {
    log('node-datachannel repair succeeded');
    return { available: true, attempted, repaired: true };
  }
  log('node-datachannel repair FAILED verification — direct transfer unavailable; relay remains enabled');
  return { available: false, attempted, repaired: false, reason: 'verification_failed' };
}

if (isDirectInvocation(process.argv[1])) {
  const result = repairNodeDatachannel({
    packageRoot: process.argv[2] || DEFAULT_PACKAGE_ROOT,
    log: (line) => process.stderr.write(`[node-datachannel-repair] ${line}\n`),
  });
  process.exitCode = result.available || result.reason === 'not_declared' ? 0 : 1;
}
