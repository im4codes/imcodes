import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { statfsMock, readFileMock, readdirMock } = vi.hoisted(() => ({
  statfsMock: vi.fn(),
  readFileMock: vi.fn(),
  readdirMock: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  statfs: statfsMock,
  readFile: readFileMock,
  readdir: readdirMock,
}));
vi.mock('../../src/util/logger.js', () => ({
  default: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { refreshDiskUsage } from '../../src/daemon/disk-usage.js';

const originalPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

/** bfree defaults to bavail; used = (blocks - bfree) * bsize. */
function mockStatfs(map: Record<string, { bsize: number; blocks: number; bfree: number }>) {
  statfsMock.mockImplementation(async (mount: string) => {
    const s = map[mount];
    if (!s) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { type: 0, bsize: s.bsize, blocks: s.blocks, bfree: s.bfree, bavail: s.bfree, files: 0, ffree: 0 };
  });
}

describe('disk-usage collector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform('linux');
  });
  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('parses /proc/mounts, skips pseudo fs, dedups by device, sorts fullest first, computes usage', async () => {
    readFileMock.mockResolvedValue([
      'proc /proc proc rw 0 0',
      'sysfs /sys sysfs rw 0 0',
      'tmpfs /run tmpfs rw 0 0',
      'cgroup2 /sys/fs/cgroup cgroup2 rw 0 0',
      '/dev/sda1 / ext4 rw 0 0',
      '/dev/sda1 /var/lib/docker ext4 rw 0 0', // same device — bind mount, deduped
      '/dev/sdb1 /data ext4 rw 0 0',
      '',
    ].join('\n'));
    mockStatfs({
      '/': { bsize: 4096, blocks: 1000, bfree: 100 },      // 90% used
      '/data': { bsize: 4096, blocks: 2000, bfree: 1000 }, // 50% used
    });

    const disks = await refreshDiskUsage();

    expect(disks).toHaveLength(2);                           // pseudo skipped, device deduped
    expect(disks[0]).toMatchObject({ mount: '/', usedPercent: 90 });     // fullest first
    expect(disks[1]).toMatchObject({ mount: '/data', usedPercent: 50 });
    expect(disks[0].totalBytes).toBe(4096 * 1000);
    expect(disks[0].usedBytes).toBe(4096 * 900);
  });

  it('collapses distinct devices that report identical size+used (macOS firmlinks)', async () => {
    readFileMock.mockResolvedValue([
      '/dev/disk1 / apfs rw 0 0',
      '/dev/disk2 /System/Volumes/Data apfs rw 0 0',
      '',
    ].join('\n'));
    mockStatfs({
      '/': { bsize: 4096, blocks: 1000, bfree: 100 },
      '/System/Volumes/Data': { bsize: 4096, blocks: 1000, bfree: 100 },
    });

    const disks = await refreshDiskUsage();
    expect(disks).toHaveLength(1);
  });

  it('drops mounts whose statfs fails and clamps a 0/undefined total away', async () => {
    readFileMock.mockResolvedValue([
      '/dev/sda1 / ext4 rw 0 0',
      '/dev/sdc1 /broken ext4 rw 0 0',
      '/dev/sdd1 /zero ext4 rw 0 0',
      '',
    ].join('\n'));
    statfsMock.mockImplementation(async (mount: string) => {
      if (mount === '/') return { type: 0, bsize: 4096, blocks: 500, bfree: 250, bavail: 250, files: 0, ffree: 0 };
      if (mount === '/zero') return { type: 0, bsize: 4096, blocks: 0, bfree: 0, bavail: 0, files: 0, ffree: 0 };
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });

    const disks = await refreshDiskUsage();
    expect(disks).toHaveLength(1);
    expect(disks[0]).toMatchObject({ mount: '/', usedPercent: 50 });
  });

  it('falls back to root when /proc/mounts is empty on linux', async () => {
    readFileMock.mockResolvedValue('');
    mockStatfs({ '/': { bsize: 4096, blocks: 100, bfree: 40 } }); // 60% used

    const disks = await refreshDiskUsage();
    expect(disks).toEqual([{ mount: '/', totalBytes: 4096 * 100, usedBytes: 4096 * 60, usedPercent: 60 }]);
  });

  it('skips a mount whose statfs hangs and still returns the healthy ones', async () => {
    vi.useFakeTimers();
    try {
      readFileMock.mockResolvedValue([
        '/dev/sda1 / ext4 rw 0 0',
        '/dev/sde1 /hung ext4 rw 0 0',
        '',
      ].join('\n'));
      statfsMock.mockImplementation((mount: string) =>
        mount === '/'
          ? Promise.resolve({ type: 0, bsize: 4096, blocks: 100, bfree: 50, bavail: 50, files: 0, ffree: 0 })
          : new Promise(() => {}), // never resolves — a wedged network mount
      );
      const pending = refreshDiskUsage();
      await vi.advanceTimersByTimeAsync(2100); // past STATFS_TIMEOUT_MS
      const disks = await pending;
      expect(disks).toHaveLength(1);
      expect(disks[0].mount).toBe('/');
    } finally {
      vi.useRealTimers();
    }
  });
});
