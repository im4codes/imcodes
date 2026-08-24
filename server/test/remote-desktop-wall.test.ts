import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Database } from '../src/db/client.js';
import {
  REMOTE_DESKTOP_WALL_OPERATION,
} from '../../shared/remote-desktop-access.js';
import {
  getRemoteDesktopWall,
  mutateRemoteDesktopWall,
  RemoteDesktopWallAuthorizationError,
  RemoteDesktopWallConflictError,
  RemoteDesktopWallMutationError,
} from '../src/services/remote-desktop-wall.js';

interface StoredWall { hostIds: string[]; revision: number; }
interface HostFixture { hostId: string; serverId: string; accessible: boolean; }
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

function fakeDb(initial: StoredWall, fixtures: HostFixture[]): { db: Database; wall: StoredWall } {
  const wall = initial;
  const normalize = (sql: string) => sql.toLowerCase().replace(/\s+/g, ' ').trim();
  const db = {
    queryOne: async <T>(sql: string, params: unknown[] = []): Promise<T | null> => {
      const normalized = normalize(sql);
      if (normalized.includes('select host_ids, revision from remote_desktop_walls')) {
        return { host_ids: [...wall.hostIds], revision: wall.revision } as T;
      }
      if (normalized.includes('from remote_desktop_hosts h')) {
        const identity = String(params[1]);
        const fixture = fixtures.find((entry) => entry.accessible
          && (entry.hostId === identity || entry.serverId === identity));
        if (!fixture) return null;
        return {
          host_id: fixture.hostId,
          server_id: fixture.serverId,
          ref_name: fixture.serverId,
          display_name: fixture.hostId,
          status: 'online',
          last_heartbeat_at: Number(params[2]) - 100,
          exec_enabled: true,
          os: 'win',
          node_role: 'controlled',
          access_role: 'owner',
          controlled_capabilities: ['remote.desktop.windows.h264.v2'],
        } as T;
      }
      if (normalized.startsWith('update remote_desktop_walls')) {
        if (wall.revision !== params[1]) return null;
        wall.hostIds = JSON.parse(String(params[2])) as string[];
        wall.revision += 1;
        return { revision: wall.revision } as T;
      }
      throw new Error(`Unhandled queryOne: ${normalized}`);
    },
    execute: async () => ({ changes: 1 }),
    transaction: async <T>(fn: (tx: Database) => Promise<T>) => fn(db as Database),
  };
  return { db: db as Database, wall };
}

describe('remote desktop wall persistence', () => {
  it('CAS-mutates an ordered canonical membership and returns an authoritative conflict snapshot', async () => {
    const fixture = fakeDb({ hostIds: [], revision: 0 }, [
      { hostId: id(1), serverId: id(101), accessible: true },
      { hostId: id(2), serverId: id(102), accessible: true },
    ]);
    const first = await mutateRemoteDesktopWall(fixture.db, 'user-1', {
      operation: REMOTE_DESKTOP_WALL_OPERATION.ADD,
      expectedRevision: 0,
      hostIds: [id(101)],
    }, 10_000);
    expect(first).toMatchObject({ revision: 1, hostIds: [id(1)] });

    await expect(mutateRemoteDesktopWall(fixture.db, 'user-1', {
      operation: REMOTE_DESKTOP_WALL_OPERATION.ADD,
      expectedRevision: 0,
      hostIds: [id(1), id(2)],
    }, 10_001)).rejects.toMatchObject<Partial<RemoteDesktopWallConflictError>>({
      snapshot: expect.objectContaining({ revision: 1, hostIds: [id(1)] }),
    });
    expect(fixture.wall.hostIds).toEqual([id(1)]);
  });

  it('deduplicates two endpoint identities for one canonical host without advancing revision', async () => {
    const fixture = fakeDb({ hostIds: [id(1)], revision: 4 }, [
      { hostId: id(1), serverId: id(101), accessible: true },
    ]);
    const snapshot = await mutateRemoteDesktopWall(fixture.db, 'user-1', {
      operation: REMOTE_DESKTOP_WALL_OPERATION.ADD,
      expectedRevision: 4,
      hostIds: [id(1), id(101)],
    }, 20_000);
    expect(snapshot).toMatchObject({ revision: 4, hostIds: [id(1)] });
  });

  it('makes authorization loss win by compacting the snapshot before stale mutation', async () => {
    const hosts = [
      { hostId: id(1), serverId: id(101), accessible: true },
      { hostId: id(2), serverId: id(102), accessible: false },
    ];
    const fixture = fakeDb({ hostIds: [id(1), id(2)], revision: 8 }, hosts);
    const compacted = await getRemoteDesktopWall(fixture.db, 'user-1', 30_000);
    expect(compacted).toMatchObject({ revision: 9, hostIds: [id(1)] });
    await expect(mutateRemoteDesktopWall(fixture.db, 'user-1', {
      operation: REMOTE_DESKTOP_WALL_OPERATION.REORDER,
      expectedRevision: 8,
      hostIds: [id(2), id(1)],
    }, 30_001)).rejects.toBeInstanceOf(RemoteDesktopWallConflictError);
  });

  it('rejects a seventeenth membership before any database mutation', async () => {
    const fixture = fakeDb({ hostIds: [], revision: 0 }, []);
    await expect(mutateRemoteDesktopWall(fixture.db, 'user-1', {
      operation: REMOTE_DESKTOP_WALL_OPERATION.ADD,
      expectedRevision: 0,
      hostIds: Array.from({ length: 17 }, (_, index) => id(index + 1)),
    })).rejects.toBeInstanceOf(RemoteDesktopWallMutationError);
    expect(fixture.wall).toEqual({ hostIds: [], revision: 0 });
  });

  it('persists and restores sixteen distinct memberships in order across clients', async () => {
    const hosts = Array.from({ length: 16 }, (_, index) => ({
      hostId: id(index + 1),
      serverId: id(index + 101),
      accessible: true,
    }));
    const fixture = fakeDb({ hostIds: [], revision: 0 }, hosts);
    for (let index = 0; index < hosts.length; index += 1) {
      await mutateRemoteDesktopWall(fixture.db, 'user-1', {
        operation: REMOTE_DESKTOP_WALL_OPERATION.ADD,
        expectedRevision: index,
        hostIds: hosts.slice(0, index + 1).map((host) => host.serverId),
      }, 40_000 + index);
    }
    const restoredInAnotherBrowser = await getRemoteDesktopWall(fixture.db, 'user-1', 50_000);
    expect(restoredInAnotherBrowser.revision).toBe(16);
    expect(restoredInAnotherBrowser.hostIds).toEqual(hosts.map((host) => host.hostId));
    expect(restoredInAnotherBrowser.hosts).toHaveLength(16);
  });

  it('keeps the migration credential-free and bounded to layout membership', () => {
    const sql = readFileSync(new URL('../src/db/migrations/076_remote_desktop_wall.sql', import.meta.url), 'utf8');
    const schema = sql.replace(/^--.*$/gm, '');
    expect(sql).toContain('user_id   TEXT PRIMARY KEY');
    expect(sql).toContain('host_ids  JSONB');
    expect(sql).toContain("layout    TEXT NOT NULL DEFAULT 'grid'");
    expect(sql).toContain('revision  BIGINT');
    expect(schema).not.toMatch(/password|credential|token|secret/i);
  });
});
