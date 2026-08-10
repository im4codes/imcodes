import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createUser } from '../src/db/queries.js';
import { deleteMessagePin, listMessagePins, upsertMessagePin } from '../src/db/message-pins.js';
import { randomHex, sha256Hex } from '../src/security/crypto.js';

let db: Database;
let userId: string;
let serverId: string;

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
  userId = randomHex(16);
  serverId = randomHex(16);
  await createUser(db, userId, `message-pins-${userId}`);
  await createServer(db, serverId, userId, 'message-pins-server', sha256Hex(randomHex(32)));
});

afterAll(async () => {
  await db.execute('DELETE FROM message_pins WHERE user_id = $1', [userId]);
  await db.close();
});

describe('message pin PostgreSQL persistence', () => {
  it('round-trips current/all scopes, updates idempotently, and deletes by original session', async () => {
    const first = await upsertMessagePin(db, {
      userId,
      serverId,
      sessionName: 'deck_pin_main',
      pin: { eventId: 'event-1', eventTs: 100, eventType: 'user.message', text: 'first' },
      now: 1_000,
    });
    const second = await upsertMessagePin(db, {
      userId,
      serverId,
      sessionName: 'deck_pin_other',
      pin: { eventId: 'event-2', eventTs: 200, eventType: 'assistant.text', text: 'second' },
      now: 2_000,
    });
    expect(first.status).toBe('ok');
    expect(second.status).toBe('ok');
    if (first.status !== 'ok' || second.status !== 'ok') throw new Error('unexpected pin limit');

    const updated = await upsertMessagePin(db, {
      userId,
      serverId,
      sessionName: 'deck_pin_main',
      pin: { eventId: 'event-1', eventTs: 101, eventType: 'user.message', text: 'first updated' },
      now: 3_000,
    });
    expect(updated.status).toBe('ok');
    if (updated.status !== 'ok') throw new Error('unexpected pin limit');
    expect(updated.pin.id).toBe(first.pin.id);

    const current = await listMessagePins(db, { userId, serverId, sessionName: 'deck_pin_main' });
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ text: 'first updated', eventTs: 101 });
    const all = await listMessagePins(db, { userId, serverId });
    expect(all.map((pin) => pin.sessionName)).toEqual(['deck_pin_other', 'deck_pin_main']);

    await expect(deleteMessagePin(db, {
      id: first.pin.id,
      userId,
      serverId,
      sessionName: 'deck_pin_other',
    })).resolves.toBe(false);
    await expect(deleteMessagePin(db, {
      id: first.pin.id,
      userId,
      serverId,
      sessionName: 'deck_pin_main',
    })).resolves.toBe(true);
  });
});
