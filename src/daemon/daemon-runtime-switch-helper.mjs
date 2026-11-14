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
import {
  defaultDaemonLockMetadataPath,
  ownerMatchesLiveProcess,
  ownerRemainsAuthoritative,
  probeProcessLiveness,
  probeProcessStartToken,
  readInstanceLockMetadata,
} from './daemon-lock-identity.mjs';

export { probeProcessLiveness, probeProcessStartToken };

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
  if (!pid || pid <= 1) return true;
  const liveness = probeProcessLiveness(pid);
  if (liveness.status === 'reclaimable') return true;
  if (typeof owner.startToken === 'string' && owner.startToken.length > 0) {
    if (!ownerRemainsAuthoritative({ startToken: owner.startToken }, liveness)) {
      return true;
    }
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

export function readVerifiedDaemonIdentity(stateDir, platform = process.platform, options = {}) {
  const resolvedState = resolve(stateDir);
  const lockMeta = readInstanceLockMetadata(defaultDaemonLockMetadataPath(resolvedState));
  const runtimeMeta = readJsonSafe(join(resolvedState, 'daemon-runtime.json'));

  if (!lockMeta || !Number.isInteger(lockMeta.pid) || lockMeta.pid <= 1) {
    return null;
  }

  const probe = typeof options.probeLiveness === 'function'
    ? options.probeLiveness
    : (pid) => probeProcessLiveness(pid, platform);
  const liveness = probe(lockMeta.pid);
  if (!ownerMatchesLiveProcess(lockMeta, liveness)) {
    return null;
  }

  return {
    pid: lockMeta.pid,
    startToken: lockMeta.startToken,
    source: 'daemon_lock',
    socketPath: lockMeta.socketPath,
    version: runtimeMeta && typeof runtimeMeta.version === 'string' ? runtimeMeta.version.trim() : null,
    startedAt: runtimeMeta && typeof runtimeMeta.startedAt === 'number' ? runtimeMeta.startedAt : null,
  };
}

export function stopVerifiedDaemon(identity, options = {}) {
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 1) return false;
  if (typeof identity.startToken !== 'string' || !identity.startToken) return false;
  const platform = options.platform ?? process.platform;
  const pid = identity.pid;
  const probe = typeof options.probeLiveness === 'function'
    ? options.probeLiveness
    : (targetPid) => probeProcessLiveness(targetPid, platform);

  // Fail-closed: only signal a PID when live liveness positively matches the recorded startToken.
  if (!ownerMatchesLiveProcess(identity, probe(pid))) {
    return false;
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
    const liveAfterGrace = probe(pid);
    if (!ownerMatchesLiveProcess(identity, liveAfterGrace)) {
      return liveAfterGrace.status === 'reclaimable';
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

function cleanupTransientCurrentEntries(resolvedRoot) {
  try {
    for (const entry of readdirSync(resolvedRoot)) {
      if (entry.startsWith('.current-next-') || entry.startsWith('.current-prev-')) {
        rmSync(join(resolvedRoot, entry), { recursive: true, force: true });
      }
    }
  } catch {
    // ignore missing runtime root
  }
}

export function writeSwitchStateRecord(resolvedRoot, record) {
  writeFileAtomicSync(
    join(resolvedRoot, DAEMON_RUNTIME_SWITCH_STATE_FILE),
    JSON.stringify(record, null, 2),
    'utf8',
  );
}

/**
 * Recover an interrupted `daemon-runtime` switch transaction before inspecting or
 * mutating `current` (notably crashes between rename #1 and rename #2 where
 * `current` is absent/dangling while `.switch-state.json` records `switching`).
 */
export function recoverInterruptedDaemonRuntimeSwitch(runtimeRoot, platform = process.platform, options = {}) {
  const resolvedRoot = resolve(runtimeRoot);
  if (!existsSync(resolvedRoot)) return { recovered: false };

  const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
  const currentLink = join(resolvedRoot, 'current');
  const switchState = readJsonSafe(join(resolvedRoot, DAEMON_RUNTIME_SWITCH_STATE_FILE));
  const prevState = readPreviousStateFile(resolvedRoot);

  let currentSt = null;
  try {
    currentSt = lstatSync(currentLink);
  } catch {
    currentSt = null;
  }

  const currentDanglingSymlink = Boolean(currentSt && currentSt.isSymbolicLink() && !existsSync(currentLink));
  const currentMissingOrDangling = !currentSt || currentDanglingSymlink;

  const candidatePrev =
    (switchState && typeof switchState.previousTarget === 'string' && switchState.previousTarget.trim()
      ? switchState.previousTarget.trim()
      : undefined)
    ?? prevState.previousTarget;
  const prevVer =
    (switchState && typeof switchState.previousVersion === 'string' && switchState.previousVersion.trim()
      ? switchState.previousVersion.trim()
      : undefined)
    ?? prevState.previousVersion;

  if (currentMissingOrDangling) {
    // Look first for an orphaned Windows `.current-prev-*` backup directory if `previousTarget` is absent.
    let backupPrevEntry = null;
    try {
      const backups = readdirSync(resolvedRoot).filter((name) => name.startsWith('.current-prev-'));
      if (backups.length > 0) backupPrevEntry = join(resolvedRoot, backups[0]);
    } catch {
      backupPrevEntry = null;
    }

    const resolvedPrev = candidatePrev ? resolve(candidatePrev) : null;
    if (resolvedPrev && resolvedPrev !== resolve(currentLink) && existsSync(resolvedPrev)) {
      if (currentDanglingSymlink) {
        try { unlinkSync(currentLink); } catch {}
      }
      const nonce = `${process.pid}-${randomBytes(4).toString('hex')}`;
      const tempRestore = join(resolvedRoot, `.current-next-${nonce}`);
      symlinkSync(resolvedPrev, tempRestore, platform === 'win32' ? 'junction' : 'dir');
      renameSync(tempRestore, currentLink);
      cleanupTransientCurrentEntries(resolvedRoot);
      writeSwitchStateRecord(resolvedRoot, {
        phase: 'recovered',
        recoveredFromPhase: switchState?.phase ?? 'missing_current',
        restoredTarget: resolvedPrev,
        previousTarget: resolvedPrev,
        previousVersion: prevVer ?? readPackageVersionSync(resolvedPrev) ?? null,
        recoveredAt: nowMs,
      });
      return {
        recovered: true,
        restoredTarget: resolvedPrev,
        ...(prevVer ? { previousVersion: prevVer } : {}),
      };
    }

    if (backupPrevEntry && existsSync(backupPrevEntry)) {
      if (currentDanglingSymlink) {
        try { unlinkSync(currentLink); } catch {}
      }
      renameSync(backupPrevEntry, currentLink);
      cleanupTransientCurrentEntries(resolvedRoot);
      const ptr = readCurrentPointerTarget(resolvedRoot);
      writeSwitchStateRecord(resolvedRoot, {
        phase: 'recovered',
        recoveredFromPhase: switchState?.phase ?? 'missing_current_backup',
        restoredTarget: ptr.targetPath ?? resolve(currentLink),
        recoveredAt: nowMs,
      });
      return {
        recovered: true,
        restoredTarget: ptr.targetPath ?? resolve(currentLink),
        ...(ptr.version ? { previousVersion: ptr.version } : {}),
      };
    }
  }

  if (options.rollbackUnconfirmed === true && switchState && (switchState.phase === 'switching' || switchState.phase === 'switched')) {
    const resolvedPrev = candidatePrev ? resolve(candidatePrev) : null;
    if (resolvedPrev && resolvedPrev !== resolve(currentLink) && existsSync(resolvedPrev)) {
      const nonce = `${process.pid}-${randomBytes(4).toString('hex')}`;
      const tempRestore = join(resolvedRoot, `.current-next-${nonce}`);
      symlinkSync(resolvedPrev, tempRestore, platform === 'win32' ? 'junction' : 'dir');
      if (platform === 'win32' && currentSt) {
        const backup = join(resolvedRoot, `.current-prev-${nonce}`);
        renameSync(currentLink, backup);
        renameSync(tempRestore, currentLink);
        rmSync(backup, { recursive: true, force: true });
      } else {
        renameSync(tempRestore, currentLink);
      }
      cleanupTransientCurrentEntries(resolvedRoot);
      writeSwitchStateRecord(resolvedRoot, {
        phase: 'recovered',
        recoveredFromPhase: switchState.phase,
        restoredTarget: resolvedPrev,
        previousTarget: resolvedPrev,
        previousVersion: prevVer ?? readPackageVersionSync(resolvedPrev) ?? null,
        recoveredAt: nowMs,
      });
      return {
        recovered: true,
        restoredTarget: resolvedPrev,
        ...(prevVer ? { previousVersion: prevVer } : {}),
      };
    }
  }

  cleanupTransientCurrentEntries(resolvedRoot);
  return { recovered: false };
}

export function switchDaemonRuntimeCurrentPointer(runtimeRoot, releaseDir, platform = process.platform, nowMs = Date.now()) {
  const resolvedRoot = resolve(runtimeRoot);
  const resolvedRelease = resolve(releaseDir);
  const currentLink = join(resolvedRoot, 'current');
  if (resolvedRelease === resolve(currentLink)) {
    throw new Error('daemon_runtime_invalid_self_target');
  }
  mkdirSync(resolvedRoot, { recursive: true });
  recoverInterruptedDaemonRuntimeSwitch(resolvedRoot, platform, { nowMs });

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

  writeSwitchStateRecord(resolvedRoot, {
    phase: 'switching',
    targetRelease: resolvedRelease,
    previousTarget: previousTarget ?? null,
    previousVersion: prevVersion ?? null,
    previousWasRealDir,
    startedAt: nowMs,
  });

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
  } else {
    try {
      unlinkSync(join(resolvedRoot, DAEMON_RUNTIME_PREVIOUS_STATE_FILE));
    } catch {
      // ignore absent
    }
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

  writeSwitchStateRecord(resolvedRoot, {
    phase: 'switched',
    targetRelease: resolvedRelease,
    previousTarget: previousTarget ?? null,
    previousVersion: prevVersion ?? null,
    previousWasRealDir,
    switchedAt: nowMs,
  });

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
  recoverInterruptedDaemonRuntimeSwitch(resolvedRoot, platform, { nowMs });
  const switchState = readJsonSafe(join(resolvedRoot, DAEMON_RUNTIME_SWITCH_STATE_FILE));
  const candidate =
    previousTarget
    ?? readPreviousStateFile(resolvedRoot).previousTarget
    ?? (switchState && typeof switchState.previousTarget === 'string' ? switchState.previousTarget : undefined);

  const resolvedPrev = candidate ? resolve(candidate) : undefined;
  if (resolvedPrev && resolvedPrev !== currentLink && existsSync(resolvedPrev)) {
    const prevVersion = readPackageVersionSync(resolvedPrev);
    switchDaemonRuntimeCurrentPointer(resolvedRoot, resolvedPrev, platform, nowMs);
    writeSwitchStateRecord(resolvedRoot, {
      phase: 'rolled_back',
      restoredTarget: resolvedPrev,
      previousVersion: prevVersion ?? null,
      rolledBackAt: nowMs,
    });
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
  writeSwitchStateRecord(resolvedRoot, {
    phase: 'rolled_back',
    restoredTarget: null,
    rolledBackAt: nowMs,
  });
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
    const versionOk = expectedVersion
      ? typeof runtimeStatus.version === 'string' && versionsMatch(runtimeStatus.version, expectedVersion)
      : typeof runtimeStatus.version === 'string' && runtimeStatus.version.trim().length > 0;
    if (!versionOk) {
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
    const settledVersionOk = expectedVersion
      ? settledStatus && versionsMatch(settledStatus.version, expectedVersion)
      : Boolean(settledStatus && typeof settledStatus.version === 'string' && settledStatus.version.trim().length > 0);
    if (
      settled
      && settled.pid === identity.pid
      && Boolean(identity.startToken && settled.startToken && settled.startToken === identity.startToken)
      && settledStatus
      && settledStatus.pid === settled.pid
      && settledVersionOk
    ) {
      return {
        pid: settled.pid,
        version: settledStatus.version,
        startToken: settled.startToken,
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
  const resolvedRoot = resolve(cfg.runtimeRoot);
  if (cfg && cfg.envOverrides && typeof cfg.envOverrides === 'object') {
    for (const [k, v] of Object.entries(cfg.envOverrides)) {
      if (typeof v === 'string' && v.length > 0) {
        process.env[k] = v;
      }
    }
  }
  const writeSwitchResult = (payload) => {
    if (!cfg?.resultFile) return;
    try {
      writeFileAtomicSync(cfg.resultFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch {
      // best effort
    }
  };
  let ownedToken = cfg.lockOwnerToken || null;
  let launchBackup = null;
  let switched = false;
  let oldIdentity = null;
  let effectivePreviousTarget = cfg.previousTarget || null;
  let effectivePreviousVersion = cfg.previousVersion || null;
  let txResultPayload = { status: 'failed', error: 'unknown_termination', finishedAt: Date.now() };

  const restoreAll = (oldIdentityForRollback) => {
    const rollbackBeganAtMs = Date.now();
    const preRbIdentity = readVerifiedDaemonIdentity(stateDir, cfg.platform);
    try {
      log(`rolling back current -> ${effectivePreviousTarget || 'system/default fallback'}`);
      rollbackDaemonRuntimeCurrentPointer(cfg.runtimeRoot, effectivePreviousTarget || undefined, cfg.platform);
    } catch (rbErr) {
      log(`pointer rollback failed: ${rbErr instanceof Error ? rbErr.message : String(rbErr)}`);
    }
    if (launchBackup) {
      restoreServiceLaunchTarget(launchBackup);
      launchBackup = null;
    }

    const candidatePrevNode = effectivePreviousTarget
      ? join(effectivePreviousTarget, cfg.platform === 'win32' ? 'node.exe' : join('bin', 'node'))
      : null;
    const candidatePrevEntry = effectivePreviousTarget
      ? join(effectivePreviousTarget, 'package', 'dist', 'src', 'index.js')
      : null;
    const prevNode = candidatePrevNode && existsSync(candidatePrevNode)
      ? candidatePrevNode
      : (cfg.previousNodePath ?? candidatePrevNode ?? undefined);
    const prevEntry = candidatePrevEntry && existsSync(candidatePrevEntry)
      ? candidatePrevEntry
      : (cfg.previousEntryPath ?? candidatePrevEntry ?? undefined);
    const rbOldIdentity = preRbIdentity ?? oldIdentityForRollback;
    const wasRunningBeforeRollback = cfg.wasRunning !== false || Boolean(rbOldIdentity) || Boolean(launchBackup);

    const rbRestartRes = restartDaemonService({
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
      oldIdentity: rbOldIdentity,
      wasRunning: wasRunningBeforeRollback,
      log,
    });

    if (!rbRestartRes.ok) {
      log(`rollback restart failed: ${rbRestartRes.mode}`);
      writeSwitchStateRecord(resolvedRoot, {
        phase: 'rollback_failed',
        restoredTarget: effectivePreviousTarget,
        previousVersion: effectivePreviousVersion,
        error: `daemon_rollback_restart_failed:${rbRestartRes.mode}`,
        failedAt: Date.now(),
      });
      return false;
    }

    if (wasRunningBeforeRollback || rbRestartRes.mode !== 'noop_stopped') {
      try {
        const rbHealth = waitForHealthyTargetDaemon({
          stateDir,
          expectedVersion: effectivePreviousVersion || undefined,
          oldIdentity: rbOldIdentity,
          restartBeganAtMs: rollbackBeganAtMs,
          platform: cfg.platform,
          timeoutMs: cfg.healthCheckTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
          settleMs: cfg.settleMs ?? DEFAULT_SETTLE_MS,
        });
        log(`rollback health verified: pid=${rbHealth.pid} version=${rbHealth.version}`);
        writeSwitchStateRecord(resolvedRoot, {
          phase: 'rolled_back',
          restoredTarget: effectivePreviousTarget,
          previousVersion: rbHealth.version,
          pid: rbHealth.pid,
          rolledBackAt: Date.now(),
        });
        return true;
      } catch (rbHealthErr) {
        const msg = rbHealthErr instanceof Error ? rbHealthErr.message : String(rbHealthErr);
        log(`rollback health check failed: ${msg}`);
        writeSwitchStateRecord(resolvedRoot, {
          phase: 'rollback_failed',
          restoredTarget: effectivePreviousTarget,
          previousVersion: effectivePreviousVersion,
          error: msg,
          failedAt: Date.now(),
        });
        return false;
      }
    }

    return true;
  };

  try {
    if (ownedToken) {
      claimHandoffRuntimeUpgradeLock(stateDir, ownedToken, { mode: 'detached_runner' });
    } else {
      const acquired = acquireRuntimeUpgradeLock(stateDir, { mode: 'detached_runner', waitMs: 5_000 });
      ownedToken = acquired.ownerToken;
    }

    recoverInterruptedDaemonRuntimeSwitch(cfg.runtimeRoot, cfg.platform);
    oldIdentity = readVerifiedDaemonIdentity(stateDir, cfg.platform);
    if (!effectivePreviousVersion) {
      const ptrBefore = readCurrentPointerTarget(cfg.runtimeRoot);
      effectivePreviousVersion = ptrBefore.version ?? oldIdentity?.version ?? null;
    }

    log(`switching current -> ${cfg.stagedReleaseDir}`);
    const switchRes = switchDaemonRuntimeCurrentPointer(cfg.runtimeRoot, cfg.stagedReleaseDir, cfg.platform);
    switched = true;

    const prevStateFile = readPreviousStateFile(cfg.runtimeRoot);
    effectivePreviousTarget = switchRes.previousTarget ?? effectivePreviousTarget ?? prevStateFile.previousTarget ?? null;
    effectivePreviousVersion = switchRes.previousVersion ?? effectivePreviousVersion ?? prevStateFile.previousVersion ?? null;

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
      wasRunning: cfg.wasRunning !== false,
      log,
    });

    if (!restartRes.ok) {
      throw new Error(`daemon_restart_failed:${restartRes.mode}`);
    }

    let health = null;
    if (cfg.wasRunning !== false || restartRes.mode !== 'noop_stopped') {
      health = waitForHealthyTargetDaemon({
        stateDir,
        expectedVersion: cfg.targetVersion,
        oldIdentity,
        restartBeganAtMs,
        platform: cfg.platform,
        timeoutMs: cfg.healthCheckTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
        settleMs: cfg.settleMs ?? DEFAULT_SETTLE_MS,
      });
      log(`post-restart health passed: pid=${health.pid} version=${health.version}`);
    } else {
      log(`post-restart health check skipped (daemon stopped and mode=${restartRes.mode})`);
    }
    writeUpgradeCooldownSentinel(stateDir);
    writeSwitchStateRecord(resolvedRoot, {
      phase: 'completed',
      targetRelease: resolve(cfg.stagedReleaseDir),
      targetVersion: cfg.targetVersion,
      previousTarget: effectivePreviousTarget,
      previousVersion: effectivePreviousVersion,
      pid: health?.pid ?? null,
      completedAt: Date.now(),
    });

    const keepTargets = Array.isArray(cfg.keepTargets) ? [...cfg.keepTargets] : [];
    const cur = readCurrentPointerTarget(cfg.runtimeRoot);
    if (cur.targetPath) keepTargets.push(cur.targetPath);
    if (effectivePreviousTarget) keepTargets.push(effectivePreviousTarget);
    const persistedPrev = readPreviousStateFile(cfg.runtimeRoot).previousTarget;
    if (persistedPrev) keepTargets.push(persistedPrev);
    pruneOldDaemonRuntimeReleases(cfg.runtimeRoot, keepTargets);

    txResultPayload = {
      status: 'ok',
      targetVersion: cfg.targetVersion,
      pid: health?.pid ?? null,
      completedAt: Date.now(),
    };
    return true;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`switch transaction failed: ${err && err.stack ? err.stack : errMsg}`);
    let rolledBackOk = false;
    if (switched) {
      rolledBackOk = restoreAll(oldIdentity);
    } else if (launchBackup) {
      restoreServiceLaunchTarget(launchBackup);
    }
    txResultPayload = {
      status: rolledBackOk ? 'rolled_back' : 'failed',
      error: errMsg,
      finishedAt: Date.now(),
    };
    return false;
  } finally {
    releaseRuntimeUpgradeLock(stateDir, ownedToken);
    writeSwitchResult(txResultPayload);
    if (cfg?.transientTaskXmlPath) {
      try { unlinkSync(cfg.transientTaskXmlPath); } catch {}
    }
    if (cfg?.transientWindowsTask) {
      try {
        spawnSync(cfg.schtasksExe || 'schtasks', ['/Delete', '/TN', cfg.transientWindowsTask, '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 10_000,
        });
      } catch {
        // best effort cleanup of one-shot Windows switch task
      }
    }
    if (cfg?.transientLaunchAgentPlist) {
      try { unlinkSync(cfg.transientLaunchAgentPlist); } catch {}
    }
    if (cfg?.transientLaunchAgentDomain && cfg?.transientLaunchAgentLabel) {
      try {
        const cleanupChild = spawn(
          '/bin/sh',
          ['-c', 'sleep 1; launchctl bootout "$1" >/dev/null 2>&1 || true', 'imcodes-switch-cleanup', `${cfg.transientLaunchAgentDomain}/${cfg.transientLaunchAgentLabel}`],
          { detached: true, stdio: 'ignore' },
        );
        cleanupChild.unref();
      } catch {
        // best effort cleanup of transient launchd job
      }
    }
  }
}
