import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser, createServer } from '../src/db/queries.js';
import { sha256Hex, randomHex } from '../src/security/crypto.js';
import { notifyRemoteDesktopAutoUnlock } from '../src/services/remote-desktop-auto-unlock-notification.js';
import type { RemoteDesktopAutoUnlockEvent } from '../src/ws/remote-desktop-router.js';
import { REMOTE_DESKTOP_AUDIT_EVENT } from '../../shared/remote-desktop.js';
import { REMOTE_DESKTOP_ACTOR_SOURCE, type RemoteDesktopActor } from '../../shared/remote-desktop-access.js';

let db: Database;
let ownerId: string;
let serverId: string;
const env = () => ({ DB: db }) as never;

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
  ownerId = randomHex(16);
  serverId = randomHex(16);
  await createUser(db, ownerId, 'rd-auto-unlock-owner');
  await db.execute('UPDATE users SET display_name = $1 WHERE id = $2', ['Ada', ownerId]);
  await createServer(db, serverId, ownerId, 'office-workstation', sha256Hex(randomHex(32)));
});

afterAll(async () => {
  await db.close();
});

function event(overrides: Partial<RemoteDesktopAutoUnlockEvent> = {}): RemoteDesktopAutoUnlockEvent {
  return {
    serverId,
    sessionId: randomHex(12),
    actor: { source: REMOTE_DESKTOP_ACTOR_SOURCE.ACCOUNT, auditId: 'audit', hostId: 'host' } as RemoteDesktopActor,
    userId: ownerId,
    ...overrides,
  };
}

describe('remote desktop auto-unlock owner notification', () => {
  it('sends one ordinary push to the machine owner naming the machine and actor', async () => {
    const dispatchPush = vi.fn(async () => {});
    await expect(notifyRemoteDesktopAutoUnlock(db, env(), event(), { dispatchPush })).resolves.toBe(true);
    expect(dispatchPush).toHaveBeenCalledTimes(1);
    const [payload] = dispatchPush.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(payload).toMatchObject({
      userId: ownerId,
      data: { serverId, type: REMOTE_DESKTOP_AUDIT_EVENT.AUTO_UNLOCK_SUCCEEDED },
    });
    expect(String(payload.body)).toContain('office-workstation');
    expect(String(payload.body)).toContain('Ada');
  });

  it('sends nothing for a machine without an owner row and never throws on dispatch failure', async () => {
    const dispatchPush = vi.fn(async () => { throw new Error('provider down'); });
    await expect(notifyRemoteDesktopAutoUnlock(db, env(), event({ serverId: randomHex(16) }), { dispatchPush }))
      .resolves.toBe(false);
    expect(dispatchPush).not.toHaveBeenCalled();
    await expect(notifyRemoteDesktopAutoUnlock(db, env(), event(), { dispatchPush })).resolves.toBe(false);
  });
});
