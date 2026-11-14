import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const DAEMON_RUNTIME_STAGING_PREFIX = '.staging-';
export const DAEMON_RUNTIME_PREVIOUS_STATE_FILE = '.previous-target.json';
export const DAEMON_RUNTIME_SWITCH_STATE_FILE = '.switch-state.json';
export const DAEMON_RUNTIME_LOCK_DIR_NAME = 'daemon-runtime-upgrade.lock.d';
export const DAEMON_RUNTIME_LOCK_OWNER_FILE = 'owner.json';
export const UPGRADE_COOLDOWN_SENTINEL_FILE = 'last-upgrade-at';
export const WINDOWS_TRANSIENT_UPGRADE_LOCK_FILE = 'upgrade.lock';

const DEFAULT_LOCK_STALE_MS = 30 * 60_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 20_000;
const DEFAULT_SETTLE_MS = 1_000;
const SAFE_BASENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.trunc(ms));
}

function writeFileAtomicSync(filePath, content, encoding) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmpPath, content, encoding ? { encoding } : undefined);
  renameSync(tmpPath, filePath);
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

export function probeProcessStartToken(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  if (platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const rparen = stat.lastIndexOf(')');
      if (rparen === -1) return null;
      const fields = stat.slice(rparen + 2).trim().split(/\s+/u);
      // field 22 in /proc/<pid>/stat is index 19 after ') state'
      return fields[19] || null;
    } catch {
      return null;
    }
  }
  if (platform === 'darwin') {
    try {
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
      }).trim();
      return out || null;
    } catch {
      return null;
    }
  }
  return null;
}

export function readPackageVersionSync(layoutDir) {
  try {
    const raw = JSON.parse(readFileSync(join(layoutDir, 'package', 'package.json'), 'utf8'));
    if (raw && typeof raw.version === 'string' && raw.version.trim().length > 0) {
      return raw.version.trim();
    }
  } catch {
    // ignore missing or malformed package.json
  }
  return undefined;
}

function normalizeVersionTag(ver) {
  return String(ver || '').trim().replace(/^v/iu, '');
}

function versionsMatch(a, b) {
  return Boolean(a && b) && normalizeVersionTag(a) === normalizeVersionTag(b);
}

function readJsonSafe(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readLockOwnerRecord(lockDir) {
  return readJsonSafe(join(lockDir, DAEMON_RUNTIME_LOCK_OWNER_FILE));
}

function isLockOwnerStale(owner, staleMs) {
  if (!owner || typeof owner !== 'object') return true;
  if (owner.handoffPending === true) {
    const deadline = typeof owner.handoffDeadlineAt === 'number' ? owner.handoffDeadlineAt : 0;
    if (Date.now() < deadline) return false;
    return true;
  }
  const pid = typeof owner.pid === 'number' ? owner.pid : null;
  if (!pid || !isProcessAlive(pid)) return true;
  if (typeof owner.startToken === 'string' && owner.startToken.length > 0) {
    const liveToken = probeProcessStartToken(pid);
    if (liveToken && liveToken !== owner.startToken) return true;
  }
  if (typeof owner.acquiredAt === 'number' && Date.now() - owner.acquiredAt > staleMs) {
    return true;
  }
  return false;
}

export function acquireRuntimeUpgradeLock(stateDir, options = {}) {
  const resolvedState = resolve(stateDir);
  mkdirSync(resolvedState, { recursive: true });
  const lockDir = join(resolvedState, DAEMON_RUNTIME_LOCK_DIR_NAME);
  const ownerPath = join(lockDir, DAEMON_RUNTIME_LOCK_OWNER_FILE);
  const waitMs = typeof options.waitMs === 'number' ? Math.max(0, options.waitMs) : 0;
  const staleMs = typeof options.staleMs === 'number' ? Math.max(1_000, options.staleMs) : DEFAULT_LOCK_STALE_MS;
  const deadline = Date.now() + waitMs;

  while (true) {
    try {
      mkdirSync(lockDir);
      const ownerToken = randomBytes(16).toString('hex');
      const now = Date.now();
      const record = {
        ownerToken,
        pid: process.pid,
        startToken: probeProcessStartToken(process.pid),
        acquiredAt: now,
        updatedAt: now,
        mode: options.mode ?? 'in_process',
        handoffPending: false,
      };
      writeFileAtomicSync(ownerPath, JSON.stringify(record, null, 2), 'utf8');
      return { lockDir, ownerPath, ownerToken };
    } catch (err) {
      if (!err || typeof err !== 'object' || !('code' in err) || err.code !== 'EEXIST') {
        throw err;
      }

      // Owner file creation right after mkdir is tiny but non-zero; wait briefly if missing.
      let owner = readLockOwnerRecord(lockDir);
      if (!owner) {
        for (let i = 0; i < 10 && !owner; i += 1) {
          sleepSync(25);
          owner = readLockOwnerRecord(lockDir);
        }
      }

      if (isLockOwnerStale(owner, staleMs)) {
        const expectedStaleToken = owner && typeof owner.ownerToken === 'string' ? owner.ownerToken : null;
        const currentOwner = readLockOwnerRecord(lockDir);
        const stillSameOwner =
          (!expectedStaleToken && !currentOwner)
          || (currentOwner && currentOwner.ownerToken === expectedStaleToken);
        if (stillSameOwner) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      }

      if (Date.now() < deadline) {
        sleepSync(100);
        continue;
      }
      const holderPid = owner && typeof owner.pid === 'number' ? owner.pid : 'unknown';
      throw new Error(`daemon_runtime_upgrade_in_progress:pid_${holderPid}`);
    }
  }
}

export function transferRuntimeUpgradeLock(stateDir, expectedOwnerToken, patch = {}) {
  const lockDir = join(resolve(stateDir), DAEMON_RUNTIME_LOCK_DIR_NAME);
  const ownerPath = join(lockDir, DAEMON_RUNTIME_LOCK_OWNER_FILE);
  const owner = readLockOwnerRecord(lockDir);
  if (!owner || owner.ownerToken !== expectedOwnerToken) {
    throw new Error('daemon_runtime_upgrade_lock_not_owned');
  }
  const now = Date.now();
  const handoffTimeoutMs = typeof patch.handoffTimeoutMs === 'number' ? Math.max(5_000, patch.handoffTimeoutMs) : 30_000;
  const next = {
    ...owner,
    ...patch,
    ownerToken: expectedOwnerToken,
    handoffPending: true,
    handoffDeadlineAt: now + handoffTimeoutMs,
    updatedAt: now,
  };
  writeFileAtomicSync(ownerPath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function claimHandoffRuntimeUpgradeLock(stateDir, expectedOwnerToken, patch = {}) {
  const lockDir = join(resolve(stateDir), DAEMON_RUNTIME_LOCK_DIR_NAME);
  const ownerPath = join(lockDir, DAEMON_RUNTIME_LOCK_OWNER_FILE);
  const owner = readLockOwnerRecord(lockDir);
  if (!owner || owner.ownerToken !== expectedOwnerToken) {
    throw new Error('daemon_runtime_upgrade_lock_handoff_invalid');
  }
  const now = Date.now();
  const next = {
    ...owner,
    ...patch,
    ownerToken: expectedOwnerToken,
    pid: process.pid,
    startToken: probeProcessStartToken(process.pid),
    handoffPending: false,
    updatedAt: now,
  };
  delete next.handoffDeadlineAt;
  writeFileAtomicSync(ownerPath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function releaseRuntimeUpgradeLock(stateDir, expectedOwnerToken) {
  if (!expectedOwnerToken) return false;
  const lockDir = join(resolve(stateDir), DAEMON_RUNTIME_LOCK_DIR_NAME);
  const owner = readLockOwnerRecord(lockDir);
  if (!owner || owner.ownerToken !== expectedOwnerToken) {
    return false;
  }
  rmSync(lockDir, { recursive: true, force: true });
  return true;
}

export function writeUpgradeCooldownSentinel(stateDir, nowMs = Date.now()) {
  const sentinelPath = join(resolve(stateDir), UPGRADE_COOLDOWN_SENTINEL_FILE);
  writeFileAtomicSync(sentinelPath, `${Math.trunc(nowMs)}\n`, 'utf8');
  return sentinelPath;
}

export function readVerifiedDaemonIdentity(stateDir, platform = process.platform) {
  const resolvedState = resolve(stateDir);
  const lockMeta = readJsonSafe(join(resolvedState, 'instance-lock.json'));
  const runtimeMeta = readJsonSafe(join(resolvedState, 'daemon-runtime.json'));

  let pid = null;
  let startToken = null;
  let source = null;

  if (lockMeta && typeof lockMeta === 'object' && typeof lockMeta.pid === 'number' && Number.isInteger(lockMeta.pid) && lockMeta.pid > 1) {
    pid = lockMeta.pid;
    startToken = typeof lockMeta.startToken === 'string' && lockMeta.startToken.length > 0 ? lockMeta.startToken : null;
    source = 'instance_lock';
  } else {
    try {
      const rawPid = Number(readFileSync(join(resolvedState, 'daemon.pid'), 'utf8').trim());
      if (Number.isInteger(rawPid) && rawPid > 1) {
        pid = rawPid;
        source = 'daemon_pid';
      }
    } catch {
      pid = null;
    }
  }

  if (!pid || !isProcessAlive(pid)) return null;
  if (startToken) {
    const actualToken = probeProcessStartToken(pid, platform);
    if (actualToken && actualToken !== startToken) {
      return null;
    }
  }

  return {
    pid,
    startToken,
    source,
    version: runtimeMeta && typeof runtimeMeta.version === 'string' ? runtimeMeta.version.trim() : null,
    startedAt: runtimeMeta && typeof runtimeMeta.startedAt === 'number' ? runtimeMeta.startedAt : null,
  };
}

export function stopVerifiedDaemon(identity, options = {}) {
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 1) return false;
  const platform = options.platform ?? process.platform;
  const pid = identity.pid;
  if (!isProcessAlive(pid)) return false;

  if (identity.startToken) {
    const liveToken = probeProcessStartToken(pid, platform);
    if (liveToken && liveToken !== identity.startToken) {
      return false;
    }
  }

  if (platform === 'win32') {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 10_000,
      });
    } catch {
      // ignore if already exited
    }
    return true;
  }

  try { process.kill(pid, 'SIGTERM'); } catch { return false; }
  const graceMs = typeof options.graceMs === 'number' ? options.graceMs : 5_000;
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    sleepSync(100);
  }
  if (isProcessAlive(pid)) {
    if (identity.startToken) {
      const liveToken = probeProcessStartToken(pid, platform);
      if (liveToken && liveToken !== identity.startToken) {
        return true;
      }
    }
    try { process.kill(pid, 'SIGKILL'); } catch {}
    sleepSync(200);
  }
  return !isProcessAlive(pid);
}

function readPreviousStateFile(runtimeRoot) {
  const parsed = readJsonSafe(join(runtimeRoot, DAEMON_RUNTIME_PREVIOUS_STATE_FILE));
  if (!parsed || typeof parsed !== 'object') return {};
  return {
    previousTarget: typeof parsed.previousTarget === 'string' ? parsed.previousTarget : undefined,
    previousVersion: typeof parsed.previousVersion === 'string' ? parsed.previousVersion : undefined,
  };
}

export function readCurrentPointerTarget(runtimeRoot) {
  const currentPath = join(runtimeRoot, 'current');
  if (!existsSync(currentPath)) return {};
  try {
    const st = lstatSync(currentPath);
    const targetPath = st.isSymbolicLink()
      ? resolve(dirname(currentPath), readlinkSync(currentPath))
      : resolve(currentPath);
    const version = readPackageVersionSync(targetPath) ?? basename(targetPath);
    return {
      targetPath,
      version,
      isSymbolicLink: st.isSymbolicLink(),
      isDirectory: st.isDirectory(),
    };
  } catch {
    return {};
  }
}

function choosePreservedRealDirDestination(resolvedRoot, resolvedRelease, prevVersion, nonce) {
  const releasesDir = join(resolvedRoot, 'releases');
  mkdirSync(releasesDir, { recursive: true });
  if (prevVersion && SAFE_BASENAME_RE.test(prevVersion)) {
    const cleanCandidate = join(releasesDir, prevVersion);
    if (resolve(cleanCandidate) !== resolve(resolvedRelease) && !existsSync(cleanCandidate)) {
      return cleanCandidate;
    }
  }
  const safeTag = prevVersion && SAFE_BASENAME_RE.test(prevVersion) ? prevVersion : 'legacy';
  return join(releasesDir, `.prev-${safeTag}-${nonce}`);
}

export function switchDaemonRuntimeCurrentPointer(runtimeRoot, releaseDir, platform = process.platform, nowMs = Date.now()) {
  const resolvedRoot = resolve(runtimeRoot);
  const resolvedRelease = resolve(releaseDir);
  const currentLink = join(resolvedRoot, 'current');
  if (resolvedRelease === resolve(currentLink)) {
    throw new Error('daemon_runtime_invalid_self_target');
  }
  mkdirSync(resolvedRoot, { recursive: true });

  const nonce = `${process.pid}-${randomBytes(4).toString('hex')}`;
  let existingSt = null;
  try {
    existingSt = lstatSync(currentLink);
  } catch {
    existingSt = null;
  }

  const prevVersion = existingSt ? readPackageVersionSync(currentLink) : undefined;
  let previousTarget;
  let previousWasRealDir = false;

  if (existingSt && existingSt.isSymbolicLink()) {
    const rawTarget = resolve(dirname(currentLink), readlinkSync(currentLink));
    if (rawTarget !== resolve(currentLink)) {
      previousTarget = rawTarget;
    }
  } else if (existingSt && existingSt.isDirectory()) {
    previousWasRealDir = true;
    previousTarget = choosePreservedRealDirDestination(resolvedRoot, resolvedRelease, prevVersion, nonce);
  }

  writeFileAtomicSync(
    join(resolvedRoot, DAEMON_RUNTIME_SWITCH_STATE_FILE),
    JSON.stringify({
      phase: 'switching',
      targetRelease: resolvedRelease,
      previousTarget: previousTarget ?? null,
      previousVersion: prevVersion ?? null,
      previousWasRealDir,
      startedAt: nowMs,
    }, null, 2),
    'utf8',
  );

  if (previousTarget && previousTarget !== resolve(currentLink)) {
    writeFileAtomicSync(
      join(resolvedRoot, DAEMON_RUNTIME_PREVIOUS_STATE_FILE),
      JSON.stringify({
        previousTarget,
        previousVersion: prevVersion ?? null,
        switchedAt: nowMs,
      }, null, 2),
      'utf8',
    );
  }

  const tempLink = join(resolvedRoot, `.current-next-${nonce}`);
  symlinkSync(resolvedRelease, tempLink, platform === 'win32' ? 'junction' : 'dir');

  if (previousWasRealDir && previousTarget) {
    let movedRealDir = false;
    try {
      mkdirSync(dirname(previousTarget), { recursive: true });
      renameSync(currentLink, previousTarget);
      movedRealDir = true;
      renameSync(tempLink, currentLink);
    } catch (err) {
      rmSync(tempLink, { recursive: true, force: true });
      if (movedRealDir && !existsSync(currentLink) && existsSync(previousTarget)) {
        try {
          renameSync(previousTarget, currentLink);
        } catch {
          // best effort restore of real directory
        }
      }
      throw err;
    }
  } else if (platform === 'win32') {
    const backupLink = join(resolvedRoot, `.current-prev-${nonce}`);
    let movedExisting = false;
    try {
      if (existingSt) {
        renameSync(currentLink, backupLink);
        movedExisting = true;
      }
      renameSync(tempLink, currentLink);
      if (movedExisting) {
        rmSync(backupLink, { recursive: true, force: true });
      }
    } catch (err) {
      rmSync(tempLink, { recursive: true, force: true });
      if (movedExisting && !existsSync(currentLink) && existsSync(backupLink)) {
        try {
          renameSync(backupLink, currentLink);
        } catch {
          // best effort restore
        }
      }
      throw err;
    }
  } else {
    try {
      renameSync(tempLink, currentLink);
    } catch (err) {
      rmSync(tempLink, { recursive: true, force: true });
      throw err;
    }
  }

  writeFileAtomicSync(
    join(resolvedRoot, DAEMON_RUNTIME_SWITCH_STATE_FILE),
    JSON.stringify({
      phase: 'switched',
      targetRelease: resolvedRelease,
      previousTarget: previousTarget ?? null,
      previousVersion: prevVersion ?? null,
      previousWasRealDir,
      switchedAt: nowMs,
    }, null, 2),
    'utf8',
  );

  return {
    currentLink,
    ...(previousTarget ? { previousTarget } : {}),
    ...(prevVersion ? { previousVersion: prevVersion } : {}),
    previousWasRealDir,
  };
}

export function rollbackDaemonRuntimeCurrentPointer(
  runtimeRoot,
  previousTarget,
  platform = process.platform,
  nowMs = Date.now(),
) {
  const resolvedRoot = resolve(runtimeRoot);
  const currentLink = resolve(join(resolvedRoot, 'current'));
  const switchState = readJsonSafe(join(resolvedRoot, DAEMON_RUNTIME_SWITCH_STATE_FILE));
  const candidate =
    previousTarget
    ?? readPreviousStateFile(resolvedRoot).previousTarget
    ?? (switchState && typeof switchState.previousTarget === 'string' ? switchState.previousTarget : undefined);

  const resolvedPrev = candidate ? resolve(candidate) : undefined;
  if (resolvedPrev && resolvedPrev !== currentLink && existsSync(resolvedPrev)) {
    switchDaemonRuntimeCurrentPointer(resolvedRoot, resolvedPrev, platform, nowMs);
    return { restoredTarget: resolvedPrev };
  }

  try {
    if (lstatSync(currentLink)) {
      rmSync(currentLink, { recursive: true, force: true });
    }
  } catch {
    // already absent
  }
  try {
    unlinkSync(join(resolvedRoot, DAEMON_RUNTIME_PREVIOUS_STATE_FILE));
  } catch {
    // ignore
  }
  return {};
}

export function pruneOldDaemonRuntimeReleases(runtimeRoot, keepTargets = []) {
  const releasesDir = join(resolve(runtimeRoot), 'releases');
  if (!existsSync(releasesDir)) return [];
  const keepSet = new Set();
  for (const target of keepTargets) {
    if (!target) continue;
    keepSet.add(resolve(target));
    try {
      keepSet.add(realpathSync(target));
    } catch {
      // ignore dangling path
    }
  }
  const removed = [];
  for (const name of readdirSync(releasesDir)) {
    const entryPath = join(releasesDir, name);
    const resolvedEntry = resolve(entryPath);
    if (name.startsWith(DAEMON_RUNTIME_STAGING_PREFIX) || !keepSet.has(resolvedEntry)) {
      rmSync(entryPath, { recursive: true, force: true });
      removed.push(entryPath);
    }
  }
  return removed;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function updateSystemdExecStartContent(existingContent, newExecStart) {
  const eol = existingContent.includes('\r\n') ? '\r\n' : '\n';
  const lines = existingContent.split(/\r?\n/u);
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (!replaced && /^ExecStart=/u.test(line)) {
      replaced = true;
      return `ExecStart=${newExecStart}`;
    }
    return line;
  });
  if (!replaced) {
    const serviceIdx = nextLines.findIndex((line) => /^\[Service\]\s*$/u.test(line.trim()));
    if (serviceIdx >= 0) {
      nextLines.splice(serviceIdx + 1, 0, `ExecStart=${newExecStart}`);
    } else {
      nextLines.push(`ExecStart=${newExecStart}`);
    }
  }
  return nextLines.join(eol);
}

export function updateLaunchdProgramArgsPlist(existingXml, programArgs) {
  const arrayBody = programArgs.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n');
  const replacement = `<key>ProgramArguments</key>\n  <array>\n${arrayBody}\n  </array>`;
  if (/<key>ProgramArguments<\/key>\s*<array>[\s\S]*?<\/array>/u.test(existingXml)) {
    return existingXml.replace(/<key>ProgramArguments<\/key>\s*<array>[\s\S]*?<\/array>/u, replacement);
  }
  if (/<dict>/u.test(existingXml)) {
    return existingXml.replace(/<dict>/u, `<dict>\n  ${replacement}`);
  }
  throw new Error('launchd_plist_missing_dict');
}

function runSystemdDaemonReload() {
  try {
    spawnSync('systemctl', ['--user', 'daemon-reload'], {
      stdio: 'ignore',
      timeout: 10_000,
    });
  } catch {
    // ignore in environments without systemd dbus
  }
}

export function prepareServiceLaunchTarget(spec) {
  if (!spec || spec.kind === 'none') return null;

  const filePath = spec.filePath;
  const existed = existsSync(filePath);
  const previousBytesBase64 = existed ? readFileSync(filePath).toString('base64') : null;

  if (spec.kind === 'systemd') {
    if (!existed) {
      if (!spec.createIfMissing || !spec.defaultUnitContent) {
        return null;
      }
      writeFileAtomicSync(filePath, spec.defaultUnitContent, 'utf8');
      runSystemdDaemonReload();
      return { kind: 'systemd', filePath, existed: false, previousBytesBase64: null };
    }
    const existingText = readFileSync(filePath, 'utf8');
    const updatedText = updateSystemdExecStartContent(existingText, spec.execStart);
    if (updatedText === existingText) {
      return null;
    }
    writeFileAtomicSync(filePath, updatedText, 'utf8');
    runSystemdDaemonReload();
    return { kind: 'systemd', filePath, existed: true, previousBytesBase64 };
  }

  if (spec.kind === 'launchd') {
    if (!existed) {
      if (!spec.createIfMissing || !spec.defaultPlistContent) {
        return null;
      }
      writeFileAtomicSync(filePath, spec.defaultPlistContent, 'utf8');
      return { kind: 'launchd', filePath, existed: false, previousBytesBase64: null };
    }
    const existingBuf = readFileSync(filePath);
    const existingText = existingBuf.toString('utf8');
    if (existingText.trimStart().startsWith('<?xml') || existingText.includes('<plist')) {
      const updated = updateLaunchdProgramArgsPlist(existingText, spec.programArguments);
      if (updated === existingText) return null;
      writeFileAtomicSync(filePath, updated, 'utf8');
    } else {
      execFileSync('plutil', ['-replace', 'ProgramArguments', '-json', JSON.stringify(spec.programArguments), filePath], {
        stdio: 'pipe',
        timeout: 10_000,
      });
    }
    return { kind: 'launchd', filePath, existed: true, previousBytesBase64 };
  }

  if (spec.kind === 'windows_watchdog') {
    if (!existed && !spec.createIfMissing) {
      return null;
    }
    const nextContent = spec.watchdogContent;
    if (typeof nextContent !== 'string' || !nextContent) return null;
    if (existed) {
      const prevText = readFileSync(filePath, 'utf8');
      if (prevText === nextContent) return null;
    }
    // Always write BOM-free UTF-8 for cmd.exe
    writeFileAtomicSync(filePath, nextContent, 'utf8');
    return { kind: 'windows_watchdog', filePath, existed, previousBytesBase64 };
  }

  return null;
}

export function restoreServiceLaunchTarget(backup) {
  if (!backup || !backup.filePath) return false;
  try {
    if (backup.existed && typeof backup.previousBytesBase64 === 'string') {
      writeFileAtomicSync(backup.filePath, Buffer.from(backup.previousBytesBase64, 'base64'));
    } else if (!backup.existed && existsSync(backup.filePath)) {
      unlinkSync(backup.filePath);
    }
    if (backup.kind === 'systemd') {
      runSystemdDaemonReload();
    }
    return true;
  } catch {
    return false;
  }
}

function spawnDetachedForegroundDaemon({ nodePath, entryPath, stateDir, platform }) {
  mkdirSync(resolve(stateDir), { recursive: true });
  const logFile = join(resolve(stateDir), 'daemon.log');
  const logFd = openSync(logFile, 'a');
  try {
    const child = spawn(nodePath, [entryPath, 'start', '--foreground'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: platform === 'win32',
      env: {
        ...process.env,
        IMCODES_HOME: resolve(stateDir),
      },
    });
    child.unref();
    return child.pid ?? null;
  } finally {
    try { closeSync(logFd); } catch {}
  }
}

export function restartDaemonService(spec) {
  const {
    platform = process.platform,
    stateDir,
    nodePath,
    entryPath,
    systemdUnitPath,
    systemdUnitName,
    launchAgentPath,
    windowsTask,
    vbsPath,
    restartCommand,
    oldIdentity,
    wasRunning = Boolean(oldIdentity),
    log = () => {},
  } = spec;

  if (restartCommand) {
    const res = spawnSync('/bin/bash', ['-lc', restartCommand], { stdio: 'pipe', encoding: 'utf8' });
    if (res.status !== 0) {
      log(`restart stderr: ${(res.stderr || '').trim()}`);
      return { ok: false, mode: 'custom_command' };
    }
    return { ok: true, mode: 'custom_command' };
  }

  if (platform === 'linux') {
    if (systemdUnitPath && existsSync(systemdUnitPath)) {
      const unitName = systemdUnitName || basename(systemdUnitPath);
      const res = spawnSync('systemctl', ['--user', 'restart', unitName], { stdio: 'pipe', encoding: 'utf8' });
      if (res.status === 0) {
        return { ok: true, mode: 'systemd' };
      }
      log(`systemctl restart failed (${res.status}): ${(res.stderr || '').trim()}`);
      return { ok: false, mode: 'systemd' };
    }
    if (oldIdentity) {
      stopVerifiedDaemon(oldIdentity, { platform });
    }
    if (wasRunning && nodePath && entryPath) {
      const spawnedPid = spawnDetachedForegroundDaemon({ nodePath, entryPath, stateDir, platform });
      return { ok: Boolean(spawnedPid), mode: 'detached_spawn', spawnedPid };
    }
    return { ok: true, mode: 'noop_stopped' };
  }

  if (platform === 'darwin') {
    if (launchAgentPath && existsSync(launchAgentPath)) {
      spawnSync('launchctl', ['unload', launchAgentPath], { stdio: 'pipe', encoding: 'utf8' });
      if (oldIdentity) {
        stopVerifiedDaemon(oldIdentity, { platform, graceMs: 3_000 });
      }
      const res = spawnSync('launchctl', ['load', '-w', launchAgentPath], { stdio: 'pipe', encoding: 'utf8' });
      if (res.status !== 0) {
        log(`launchctl load failed (${res.status}): ${(res.stderr || '').trim()}`);
        return { ok: false, mode: 'launchd' };
      }
      return { ok: true, mode: 'launchd' };
    }
    if (oldIdentity) {
      stopVerifiedDaemon(oldIdentity, { platform });
    }
    if (wasRunning && nodePath && entryPath) {
      const spawnedPid = spawnDetachedForegroundDaemon({ nodePath, entryPath, stateDir, platform });
      return { ok: Boolean(spawnedPid), mode: 'detached_spawn', spawnedPid };
    }
    return { ok: true, mode: 'noop_stopped' };
  }

  if (platform === 'win32') {
    const resolvedState = resolve(stateDir);
    const transientLockPath = join(resolvedState, WINDOWS_TRANSIENT_UPGRADE_LOCK_FILE);
    let createdTransientLock = false;
    try {
      mkdirSync(resolvedState, { recursive: true });
      writeFileSync(transientLockPath, `${process.pid}\n`, 'utf8');
      createdTransientLock = true;
      if (oldIdentity) {
        stopVerifiedDaemon(oldIdentity, { platform });
      }
    } finally {
      if (createdTransientLock) {
        try { unlinkSync(transientLockPath); } catch {}
      }
    }

    if (windowsTask) {
      const taskRes = spawnSync('schtasks', ['/Run', '/TN', windowsTask], {
        stdio: 'pipe',
        encoding: 'utf8',
        windowsHide: true,
      });
      if (taskRes.status === 0) {
        return { ok: true, mode: 'windows_schtasks' };
      }
      log(`schtasks /Run failed (${taskRes.status}): ${(taskRes.stderr || '').trim()}`);
    }
    if (vbsPath && existsSync(vbsPath)) {
      const child = spawn('wscript.exe', [vbsPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      return { ok: true, mode: 'windows_vbs', spawnedPid: child.pid ?? null };
    }
    if (wasRunning && nodePath && entryPath) {
      const spawnedPid = spawnDetachedForegroundDaemon({ nodePath, entryPath, stateDir, platform });
      return { ok: Boolean(spawnedPid), mode: 'detached_spawn', spawnedPid };
    }
    return { ok: true, mode: 'noop_stopped' };
  }

  return { ok: false, mode: 'unsupported' };
}

export function waitForHealthyTargetDaemon({
  stateDir,
  expectedVersion,
  oldIdentity,
  restartBeganAtMs,
  platform = process.platform,
  timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  settleMs = DEFAULT_SETTLE_MS,
}) {
  const resolvedState = resolve(stateDir);
  const deadline = Date.now() + timeoutMs;
  let lastReason = 'no_live_daemon_detected';

  while (Date.now() < deadline) {
    const identity = readVerifiedDaemonIdentity(resolvedState, platform);
    if (!identity) {
      lastReason = 'daemon_pid_missing_or_dead';
      sleepSync(250);
      continue;
    }

    const samePid = Boolean(oldIdentity && identity.pid === oldIdentity.pid);
    const sameStartToken = Boolean(
      oldIdentity?.startToken
      && identity.startToken
      && oldIdentity.startToken === identity.startToken,
    );
    if (samePid && (!oldIdentity?.startToken || !identity.startToken || sameStartToken)) {
      lastReason = 'daemon_still_old_process';
      sleepSync(250);
      continue;
    }

    const runtimeStatus = readJsonSafe(join(resolvedState, 'daemon-runtime.json'));
    if (!runtimeStatus || typeof runtimeStatus !== 'object') {
      lastReason = 'missing_daemon_runtime_json';
      sleepSync(250);
      continue;
    }
    if (runtimeStatus.pid !== identity.pid) {
      lastReason = `daemon_runtime_pid_mismatch:${runtimeStatus.pid}_vs_${identity.pid}`;
      sleepSync(250);
      continue;
    }
    if (typeof runtimeStatus.version !== 'string' || !versionsMatch(runtimeStatus.version, expectedVersion)) {
      lastReason = `daemon_runtime_version_mismatch:expected_${expectedVersion}_got_${String(runtimeStatus.version)}`;
      sleepSync(250);
      continue;
    }
    if (typeof runtimeStatus.startedAt !== 'number' || runtimeStatus.startedAt < restartBeganAtMs - 2_000) {
      lastReason = 'daemon_runtime_stale_startedAt';
      sleepSync(250);
      continue;
    }

    // Settle check: daemon must stay alive and keep matching identity/version.
    sleepSync(settleMs);
    const settled = readVerifiedDaemonIdentity(resolvedState, platform);
    const settledStatus = readJsonSafe(join(resolvedState, 'daemon-runtime.json'));
    if (
      settled
      && settled.pid === identity.pid
      && (!identity.startToken || !settled.startToken || settled.startToken === identity.startToken)
      && settledStatus
      && settledStatus.pid === settled.pid
      && versionsMatch(settledStatus.version, expectedVersion)
    ) {
      return {
        pid: settled.pid,
        version: settledStatus.version,
        startToken: settled.startToken ?? null,
      };
    }
    lastReason = 'daemon_exited_during_settle_window';
  }

  throw new Error(`post_restart_health_check_failed:${lastReason}`);
}

export function runDetachedSwitchTransaction(cfg) {
  const log = (msg) => {
    if (!cfg?.logFile) return;
    try {
      appendFileSync(cfg.logFile, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {
      // ignore log write failures
    }
  };

  const stateDir = resolve(cfg.stateDir);
  let ownedToken = cfg.lockOwnerToken || null;
  let launchBackup = null;
  let switched = false;

  const restoreAll = (oldIdentityForRollback) => {
    try {
      log(`rolling back current -> ${cfg.previousTarget || 'system/default fallback'}`);
      rollbackDaemonRuntimeCurrentPointer(cfg.runtimeRoot, cfg.previousTarget || undefined, cfg.platform);
    } catch (rbErr) {
      log(`pointer rollback failed: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`);
    }
    if (launchBackup) {
      restoreServiceLaunchTarget(launchBackup);
      launchBackup = null;
    }
    const postRbIdentity = readVerifiedDaemonIdentity(stateDir, cfg.platform);
    const prevNode = cfg.previousTarget
      ? join(cfg.previousTarget, cfg.platform === 'win32' ? 'node.exe' : join('bin', 'node'))
      : cfg.previousNodePath;
    const prevEntry = cfg.previousTarget
      ? join(cfg.previousTarget, 'package', 'dist', 'src', 'index.js')
      : cfg.previousEntryPath;
    restartDaemonService({
      platform: cfg.platform,
      stateDir,
      nodePath: prevNode,
      entryPath: prevEntry,
      systemdUnitPath: cfg.systemdUnitPath,
      systemdUnitName: cfg.systemdUnitName,
      launchAgentPath: cfg.launchAgentPath,
      windowsTask: cfg.windowsTask,
      vbsPath: cfg.vbsPath,
      restartCommand: cfg.rollbackRestartCommand ?? cfg.restartCommand,
      oldIdentity: postRbIdentity ?? oldIdentityForRollback,
      wasRunning: true,
      log,
    });
  };

  try {
    if (ownedToken) {
      claimHandoffRuntimeUpgradeLock(stateDir, ownedToken, { mode: 'detached_runner' });
    } else {
      const acquired = acquireRuntimeUpgradeLock(stateDir, { mode: 'detached_runner', waitMs: 5_000 });
      ownedToken = acquired.ownerToken;
    }

    const oldIdentity = readVerifiedDaemonIdentity(stateDir, cfg.platform);
    log(`switching current -> ${cfg.stagedReleaseDir}`);
    switchDaemonRuntimeCurrentPointer(cfg.runtimeRoot, cfg.stagedReleaseDir, cfg.platform);
    switched = true;

    if (cfg.launchTargetSpec) {
      launchBackup = prepareServiceLaunchTarget(cfg.launchTargetSpec);
    }

    const restartBeganAtMs = Date.now();
    const restartRes = restartDaemonService({
      platform: cfg.platform,
      stateDir,
      nodePath: cfg.targetNodePath,
      entryPath: cfg.targetEntryPath,
      systemdUnitPath: cfg.systemdUnitPath,
      systemdUnitName: cfg.systemdUnitName,
      launchAgentPath: cfg.launchAgentPath,
      windowsTask: cfg.windowsTask,
      vbsPath: cfg.vbsPath,
      restartCommand: cfg.restartCommand,
      oldIdentity,
      wasRunning: true,
      log,
    });

    if (!restartRes.ok) {
      throw new Error(`daemon_restart_failed:${restartRes.mode}`);
    }

    const health = waitForHealthyTargetDaemon({
      stateDir,
      expectedVersion: cfg.targetVersion,
      oldIdentity,
      restartBeganAtMs,
      platform: cfg.platform,
      timeoutMs: cfg.healthCheckTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
      settleMs: cfg.settleMs ?? DEFAULT_SETTLE_MS,
    });

    log(`post-restart health passed: pid=${health.pid} version=${health.version}`);
    writeUpgradeCooldownSentinel(stateDir);

    const keepTargets = Array.isArray(cfg.keepTargets) ? [...cfg.keepTargets] : [];
    const cur = readCurrentPointerTarget(cfg.runtimeRoot);
    if (cur.targetPath) keepTargets.push(cur.targetPath);
    if (cfg.previousTarget) keepTargets.push(cfg.previousTarget);
    pruneOldDaemonRuntimeReleases(cfg.runtimeRoot, keepTargets);

    return true;
  } catch (err) {
    log(`switch transaction failed: ${err && err.stack ? err.stack : String(err)}`);
    if (switched) {
      restoreAll(null);
    } else if (launchBackup) {
      restoreServiceLaunchTarget(launchBackup);
    }
    return false;
  } finally {
    releaseRuntimeUpgradeLock(stateDir, ownedToken);
  }
}
