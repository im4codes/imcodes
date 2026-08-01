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
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  if (npmCommand && isAbsolute(npmCommand)) roots.unshift(dirname(npmCommand));
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

function verify(packageRoot) {
  const result = run(process.execPath, [
    '-e',
    "import('node-datachannel').then(() => process.exit(0)).catch(() => process.exit(1))",
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
  const runNpm = (args) => npmCli
    ? run(process.execPath, [npmCli, ...args], { cwd: packageRoot, timeout: REPAIR_TIMEOUT_MS })
    : run(npmCommand, args, { cwd: packageRoot, timeout: REPAIR_TIMEOUT_MS });
  const dependencySpec = readDependencySpec(packageRoot);
  if (!dependencySpec) return { available: false, attempted: false, repaired: false, reason: 'not_declared' };
  if (verify(packageRoot)) return { available: true, attempted: false, repaired: false };

  const dependencyDir = join(packageRoot, 'node_modules', 'node-datachannel');
  let attempted = false;
  if (existsSync(join(dependencyDir, 'package.json'))) {
    attempted = true;
    log('node-datachannel native addon unavailable — rebuilding with lifecycle scripts enabled');
    const rebuild = runNpm([
      'rebuild', '--global=false', '--prefix', packageRoot,
      'node-datachannel', '--ignore-scripts=false', '--foreground-scripts',
    ]);
    if (rebuild.status !== 0) {
      log(`node-datachannel rebuild returned non-zero [exit ${rebuild.status} signal ${rebuild.signal ?? 'none'}]; trying clean dependency reinstall`);
    }
  } else {
    log('node-datachannel package missing or incomplete — trying clean dependency reinstall');
  }

  if (!verify(packageRoot)) {
    attempted = true;
    try { rmSync(dependencyDir, { recursive: true, force: true }); } catch { /* npm reports the failure below */ }
    const reinstall = runNpm([
      'install', '--global=false', '--prefix', packageRoot,
      '--no-save', '--ignore-scripts=false', '--foreground-scripts',
      `node-datachannel@${dependencySpec}`,
    ]);
    if (reinstall.status !== 0) {
      log(`node-datachannel clean reinstall returned non-zero [exit ${reinstall.status} signal ${reinstall.signal ?? 'none'}]`);
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
