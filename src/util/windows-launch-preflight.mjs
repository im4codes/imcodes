#!/usr/bin/env node
/**
 * windows-launch-preflight.mjs — Windows-side counterpart of
 * `bin/imcodes-launch.sh`.
 *
 * Invoked by `daemon-watchdog.cmd` BEFORE every daemon-launch attempt.
 * Detects the half-installed `node_modules` signature that
 * `imcodes upgrade` (or any `npm install -g imcodes@…`) leaves behind
 * when it gets killed mid-write — power loss, OOM-kill, RDP-disconnect,
 * etc. Without this, top-level deps like `commander`/`ws`/`hono` can be
 * empty placeholder dirs (no `package.json` inside), and the daemon's
 * very first import crashes with `ERR_MODULE_NOT_FOUND` → watchdog
 * restarts → same crash → infinite loop, no operator-visible recovery.
 *
 * Pure Node built-ins only (`node:fs`, `node:path`, `node:child_process`).
 * Importing anything from `node_modules/` would defeat the entire point —
 * `node_modules` being broken is exactly when this script needs to run.
 *
 * Mirrors the bash launcher's behavior verbatim:
 *   - same CRITICAL_DEPS list
 *   - same "dir exists but no package.json inside" detection
 *   - same `--ignore-scripts --prefer-online imcodes@<pinned>` reinstall
 *   - same "exit 0 even on repair failure so the watchdog retries
 *     instead of getting wedged on the repair shim"
 *
 * Idempotent: healthy install costs one stat per dep + the dist check
 * (~ms) and exits 0 with no side effects.
 */
import { existsSync, readFileSync, realpathSync, mkdirSync, appendFileSync, statSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const SELF = fileURLToPath(import.meta.url);
// Layout: <PKG_ROOT>/dist/src/util/windows-launch-preflight.mjs
//         ^^^^^^^^^^ resolve up 4 levels: util → src → dist → PKG_ROOT
const PKG_ROOT = resolve(SELF, '..', '..', '..', '..');

// Critical deps — daemon CANNOT start without these. Keep in lockstep
// with `bin/imcodes-launch.sh` so the two platforms have the same
// recovery surface.
const CRITICAL_DEPS = [
  'commander',
  'ws',
  'cors',
  'body-parser',
  'hono',
  'pino',
  '@huggingface/transformers',
];

export function isDirectInvocation(entryPath, selfPath = SELF) {
  if (!entryPath) return false;
  try {
    return realpathSync(entryPath) === realpathSync(selfPath);
  } catch {
    return resolve(entryPath) === resolve(selfPath);
  }
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
  const roots = [dirname(nodeExecPath)];
  const resolvedNpm = resolveCommandOnPath(npmCommand, env);
  if (resolvedNpm && isAbsolute(resolvedNpm)) roots.unshift(dirname(resolvedNpm));
  for (const root of roots) {
    candidates.push(
      join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      join(root, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    );
  }
  if (
    typeof env.npm_execpath === 'string'
    && isAbsolute(env.npm_execpath)
    && basename(env.npm_execpath).toLowerCase() === 'npm-cli.js'
  ) {
    candidates.push(env.npm_execpath);
  }
  for (const candidate of new Set(candidates)) {
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

export function buildNpmInvocation(
  args,
  {
    npmCommand,
    npmCli = '',
    platform = process.platform,
    nodeExecPath = process.execPath,
    env = process.env,
  },
) {
  const resolvedCli = npmCli || (platform === 'win32' ? resolveNpmCliJs(npmCommand, nodeExecPath, env) : '');
  if (resolvedCli) {
    return {
      command: nodeExecPath,
      args: [resolvedCli, ...args],
      npmCli: resolvedCli,
    };
  }
  return {
    command: npmCommand,
    args,
    npmCli: '',
  };
}

function resolveImcodesStateDir() {
  const configured = process.env.IMCODES_HOME?.trim();
  if (configured) return resolve(configured);
  const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
  return resolve(join(home, '.imcodes'));
}

const IMCODES_HOME = resolveImcodesStateDir();
const REPAIR_LOG = process.env.IMCODES_LAUNCH_REPAIR_LOG
  ?? join(IMCODES_HOME, 'launch-repair.log');

function log(line) {
  // Emit to stderr so the watchdog's `>> watchdog.log 2>&1` captures it,
  // and also append to a dedicated repair log for post-mortem.
  const stamp = new Date().toISOString();
  const msg = `[imcodes-launch ${stamp}] ${line}\n`;
  process.stderr.write(msg);
  try {
    mkdirSync(dirname(REPAIR_LOG), { recursive: true });
    appendFileSync(REPAIR_LOG, msg);
  } catch { /* best-effort */ }
}

function isHalfInstalled(depDir) {
  try {
    return existsSync(depDir) && !existsSync(join(depDir, 'package.json'));
  } catch {
    return false;
  }
}

function readPinnedVersion() {
  const pkgPath = join(PKG_ROOT, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.version === 'string' && parsed.version.length > 0
      ? parsed.version
      : null;
  } catch {
    return null;
  }
}

// Stale upgrade-lock probe — mirror the bash launcher. Windows already
// has watchdog.cmd's own 10-min stale probe; this one's 30-min and only
// fires when the launch preflight runs, so it's a defense-in-depth
// pass for cases where the watchdog probe didn't fire (e.g. lock got
// re-created right after watchdog's cleanup, or upgrade.lock.d/ from
// the Unix-style bash upgrade ended up here cross-platform).
function clearStaleUpgradeLock() {
  const lockDir = join(IMCODES_HOME, 'upgrade.lock.d');
  const lockFile = join(IMCODES_HOME, 'upgrade.lock');
  const stalenessSec = parseInt(
    process.env.IMCODES_LAUNCH_LOCK_STALE_AFTER_SEC ?? '1800',
    10,
  );
  for (const target of [lockDir, lockFile]) {
    try {
      if (!existsSync(target)) continue;
      const st = statSync(target);
      const ageSec = (Date.now() - st.mtimeMs) / 1000;
      if (ageSec > stalenessSec) {
        log(`clearing stale upgrade lock at ${target} (age ${Math.round(ageSec)}s)`);
        if (st.isDirectory()) {
          rmSync(target, { recursive: true, force: true });
        } else {
          unlinkSync(target);
        }
      }
    } catch { /* best-effort */ }
  }
}

function runPreflight() {
  clearStaleUpgradeLock();

  let needsRepair = false;
  const missing = [];

  for (const dep of CRITICAL_DEPS) {
    const depDir = join(PKG_ROOT, 'node_modules', dep);
    if (isHalfInstalled(depDir)) {
      needsRepair = true;
      missing.push(dep);
    }
  }

  const entryPath = join(PKG_ROOT, 'dist', 'src', 'index.js');
  if (!existsSync(entryPath)) {
    needsRepair = true;
    missing.push('dist/src/index.js');
  }

  // Run the newly installed package's own optional-native repair before daemon
  // launch. This closes the one-version bootstrap gap: an old daemon cannot put
  // new repair logic into the upgrade runner that installs the first fixed build.
  const npmCmd = process.env.IMCODES_NPM_BIN?.trim() || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const configuredNpmCli = process.env.IMCODES_NPM_CLI?.trim() ?? '';
  const npmCli = (configuredNpmCli && existsSync(configuredNpmCli))
    ? configuredNpmCli
    : (process.platform === 'win32' ? resolveNpmCliJs(npmCmd) : '');
  const nodeDatachannelRepair = join(PKG_ROOT, 'dist', 'src', 'util', 'node-datachannel-repair.mjs');
  const NDC_REPAIR_FAIL_MARKER = join(IMCODES_HOME, 'node-datachannel-repair-failed.txt');
  function clearNodeDatachannelFailureMarker() {
    try { unlinkSync(NDC_REPAIR_FAIL_MARKER); } catch { /* ignore */ }
  }
  function repairNodeDatachannel() {
    if (!existsSync(nodeDatachannelRepair)) return;
    const pinnedVersion = readPinnedVersion();
    const markerKey = pinnedVersion ? `${pinnedVersion}|${PKG_ROOT}` : '';
    if (markerKey) {
      try {
        if (existsSync(NDC_REPAIR_FAIL_MARKER) && readFileSync(NDC_REPAIR_FAIL_MARKER, 'utf8').trim() === markerKey) {
          log(`node-datachannel launch repair skipped (previously failed for imcodes@${pinnedVersion}) — relay remains enabled`);
          return;
        }
      } catch { /* proceed with repair attempt */ }
    }
    const repair = spawnSync(process.execPath, [nodeDatachannelRepair, PKG_ROOT], {
      env: {
        ...process.env,
        IMCODES_NPM_BIN: npmCmd,
        ...(npmCli ? { IMCODES_NPM_CLI: npmCli } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 6 * 60 * 1000,
      windowsHide: true,
    });
    if (repair.stderr) {
      try { appendFileSync(REPAIR_LOG, repair.stderr); } catch { /* ignore */ }
    }
    if (repair.status === 0) {
      clearNodeDatachannelFailureMarker();
    } else {
      log('node-datachannel launch repair unavailable — relay remains enabled');
      if (markerKey) {
        try {
          mkdirSync(IMCODES_HOME, { recursive: true });
          writeFileSync(NDC_REPAIR_FAIL_MARKER, markerKey);
        } catch { /* best-effort */ }
      }
    }
  }
  repairNodeDatachannel();

  if (!needsRepair) {
    // Healthy install — hand back to the watchdog with no action.
    return 0;
  }

  const pinned = readPinnedVersion();
  if (!pinned) {
    log(`node_modules half-installed (missing: ${missing.join(', ')}) but cannot read pinned version from ${PKG_ROOT}/package.json — handing back to watchdog without repair`);
    return 0;
  }

  log(`node_modules half-installed (missing: ${missing.join(', ')}) — reinstalling imcodes@${pinned}`);

  // Bypass cmd.exe on Windows by running npm-cli.js directly via node.exe (avoiding
  // Node 24 EINVAL on direct .cmd spawn without shell and quoting issues with spaces).
  const installInvocation = buildNpmInvocation(
    ['install', '-g', '--ignore-scripts', '--prefer-online', `imcodes@${pinned}`],
    { npmCommand: npmCmd, npmCli },
  );
  const r = spawnSync(
    installInvocation.command,
    installInvocation.args,
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 5 * 60 * 1000, // 5 min — npm install rarely takes longer; if it does, watchdog will retry next loop
      windowsHide: true,
      shell: false,
    },
  );

  if (r.stdout) {
    try { appendFileSync(REPAIR_LOG, `[npm stdout]\n${r.stdout}\n`); } catch { /* ignore */ }
  }
  if (r.stderr) {
    try { appendFileSync(REPAIR_LOG, `[npm stderr]\n${r.stderr}\n`); } catch { /* ignore */ }
  }

  if (r.status === 0) {
    log('self-repair OK');
    clearNodeDatachannelFailureMarker();
    // The global reinstall deliberately suppresses lifecycle scripts and can
    // replace a native addon repaired above. Verify/repair the freshly installed
    // tree again before handing control back to the watchdog.
    repairNodeDatachannel();
  } else {
    log(`self-repair FAILED (npm exit ${r.status}; signal ${r.signal ?? 'none'}) — see ${REPAIR_LOG}`);
  }

  // Always exit 0: even if repair failed (transient network etc.), we
  // want the watchdog to TRY launching the daemon. If it crashes again,
  // the watchdog re-enters the loop and the next iteration re-runs the
  // preflight — converges as soon as ONE npm install succeeds.
  return 0;
}

if (isDirectInvocation(process.argv[1])) {
  process.exit(runPreflight());
}
