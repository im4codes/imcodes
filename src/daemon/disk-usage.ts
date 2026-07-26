/**
 * Cross-platform disk-capacity collection for the `daemon.stats` status bar.
 *
 * Efficiency: uses the `fs.statfs` syscall (libuv → statvfs / GetDiskFreeSpaceEx)
 * — no `df`/`wmic` subprocess. Mount enumeration is a cheap file read on Linux
 * (/proc/self/mounts), a readdir on macOS (/Volumes), and 26 fail-fast statfs
 * probes on Windows (drive letters). Results are cached with a short TTL and
 * refreshed in the background so the synchronous send path never blocks.
 */
import { statfs, readFile, readdir } from 'node:fs/promises';
import type { DiskUsage } from '../../shared/disk-usage.js';
import logger from '../util/logger.js';

// Pseudo / virtual filesystems to skip on Linux (fstype column of /proc/self/mounts).
const LINUX_PSEUDO_FSTYPES = new Set([
  'proc', 'sysfs', 'devtmpfs', 'devpts', 'tmpfs', 'ramfs', 'securityfs', 'pstore',
  'bpf', 'cgroup', 'cgroup2', 'autofs', 'mqueue', 'debugfs', 'tracefs', 'hugetlbfs',
  'fusectl', 'configfs', 'binfmt_misc', 'nsfs', 'overlay', 'squashfs', 'efivarfs',
  'rpc_pipefs', 'selinuxfs', 'fuse.gvfsd-fuse', 'fuse.portal', 'fuse.snapfuse',
  'fuse.snapd', 'ramfs', 'devfs',
]);

const DISK_CACHE_TTL_MS = 15_000;
// A statfs on a wedged network mount (e.g. a stale SMB/NFS volume under macOS
// /Volumes) can hang indefinitely; cap it so one bad mount can't stall the
// whole refresh (which would otherwise leave `refreshing` stuck and freeze the
// snapshot forever). Linux already excludes network fs (non-/dev/ devices).
const STATFS_TIMEOUT_MS = 2_000;
let cache: { at: number; disks: DiskUsage[] } | null = null;
let refreshing = false;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

async function usageForMount(mount: string): Promise<DiskUsage | null> {
  try {
    const s = await withTimeout(statfs(mount), STATFS_TIMEOUT_MS);
    if (!s) return null;
    const bsize = Number(s.bsize);
    const totalBytes = Number(s.blocks) * bsize;
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
    const usedBytes = Math.max(0, totalBytes - Number(s.bfree) * bsize);
    const usedPercent = Math.min(100, Math.max(0, Math.round((usedBytes / totalBytes) * 100)));
    return { mount, totalBytes, usedBytes, usedPercent };
  } catch {
    // Non-existent drive letter (Windows), unmounted volume, permission — skip.
    return null;
  }
}

async function enumerateMounts(): Promise<string[]> {
  if (process.platform === 'linux') {
    const txt = await readFile('/proc/self/mounts', 'utf8').catch(() => '');
    const mounts: string[] = [];
    const seenDev = new Set<string>();
    for (const line of txt.split('\n')) {
      const parts = line.split(' ');
      const dev = parts[0];
      const mount = parts[1];
      const fstype = parts[2];
      if (!dev || !mount || !fstype) continue;
      if (!dev.startsWith('/dev/')) continue;          // real block devices only
      if (LINUX_PSEUDO_FSTYPES.has(fstype)) continue;
      if (seenDev.has(dev)) continue;                  // one entry per device (skip bind mounts)
      seenDev.add(dev);
      mounts.push(mount.replace(/\\040/g, ' '));       // /proc escapes spaces as \040
    }
    return mounts.length ? mounts : ['/'];
  }
  if (process.platform === 'darwin') {
    // No /proc on macOS. Root plus mounted volumes covers real disks; firmlink
    // duplicates (/, /System/Volumes/Data) collapse in the dedupe below.
    const mounts = ['/'];
    const vols = await readdir('/Volumes').catch(() => [] as string[]);
    for (const v of vols) mounts.push(`/Volumes/${v}`);
    return mounts;
  }
  if (process.platform === 'win32') {
    const drives: string[] = [];
    for (let c = 65; c <= 90; c += 1) drives.push(`${String.fromCharCode(c)}:\\`);
    return drives; // statfs fails fast for absent drives; usageForMount filters them out
  }
  return ['/'];
}

/** Refresh the cached disk snapshot via fast statfs syscalls. Never throws. */
export async function refreshDiskUsage(): Promise<DiskUsage[]> {
  if (refreshing) return cache?.disks ?? [];
  refreshing = true;
  try {
    const mounts = await enumerateMounts();
    const results = await Promise.all(mounts.map(usageForMount));
    const disks: DiskUsage[] = [];
    const seen = new Set<string>();
    for (const d of results) {
      if (!d) continue;
      // Collapse duplicates — macOS firmlinks and bind mounts report the same
      // size+used against the same physical volume.
      const key = `${d.totalBytes}:${d.usedBytes}`;
      if (seen.has(key)) continue;
      seen.add(key);
      disks.push(d);
    }
    disks.sort((a, b) => b.usedPercent - a.usedPercent || b.totalBytes - a.totalBytes);
    cache = { at: Date.now(), disks };
    return disks;
  } catch (err) {
    logger.debug({ err }, 'disk-usage: refresh failed');
    return cache?.disks ?? [];
  } finally {
    refreshing = false;
  }
}

/**
 * Non-blocking accessor for the synchronous stats send path. Returns the cached
 * snapshot and kicks off a background refresh when it's stale (or absent). The
 * first call returns [] and warms the cache; the next stats tick carries data.
 * Call `refreshDiskUsage()` once at startup to populate the first message.
 */
export function getDiskUsage(): DiskUsage[] {
  if (!cache || Date.now() - cache.at > DISK_CACHE_TTL_MS) {
    void refreshDiskUsage();
  }
  return cache?.disks ?? [];
}
