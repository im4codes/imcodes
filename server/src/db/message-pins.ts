import { randomUUID } from 'node:crypto';
import {
  MESSAGE_PIN_LIMITS,
  type CreateMessagePinInput,
  type MessagePin,
  type MessagePinEventType,
} from '../../../shared/message-pins.js';
import type { Database } from './client.js';

interface MessagePinRow {
  id: string;
  server_id: string;
  session_name: string;
  event_id: string;
  event_ts: number;
  event_type: MessagePinEventType;
  text_snapshot: string;
  created_at: number;
  updated_at: number;
}

export type UpsertMessagePinResult =
  | { status: 'ok'; pin: MessagePin }
  | { status: 'limit_reached' };

function toMessagePin(row: MessagePinRow): MessagePin {
  return {
    id: row.id,
    serverId: row.server_id,
    sessionName: row.session_name,
    eventId: row.event_id,
    eventTs: row.event_ts,
    eventType: row.event_type,
    text: row.text_snapshot,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const MESSAGE_PIN_COLUMNS = `
  id, server_id, session_name, event_id, event_ts, event_type,
  text_snapshot, created_at, updated_at
`;

export async function listMessagePins(
  db: Database,
  params: { userId: string; serverId: string; sessionName?: string },
): Promise<MessagePin[]> {
  const sessionClause = params.sessionName ? ' AND session_name = $3' : '';
  const values = params.sessionName
    ? [params.userId, params.serverId, params.sessionName]
    : [params.userId, params.serverId];
  const rows = await db.query<MessagePinRow>(`
    SELECT ${MESSAGE_PIN_COLUMNS}
    FROM message_pins
    WHERE user_id = $1 AND server_id = $2${sessionClause}
    ORDER BY created_at DESC, id DESC
  `, values);
  return rows.map(toMessagePin);
}

export async function upsertMessagePin(
  db: Database,
  params: { userId: string; serverId: string; sessionName: string; pin: CreateMessagePinInput; now?: number },
): Promise<UpsertMessagePinResult> {
  const now = params.now ?? Date.now();
  return db.transaction(async (tx) => {
    // Serialize the count+insert decision per user/session so concurrent pins
    // cannot race past the bounded PostgreSQL footprint.
    await tx.queryOne(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [JSON.stringify([params.userId, params.serverId, params.sessionName])],
    );

    const existing = await tx.queryOne<{ id: string }>(`
      SELECT id FROM message_pins
      WHERE user_id = $1 AND server_id = $2 AND session_name = $3 AND event_id = $4
    `, [params.userId, params.serverId, params.sessionName, params.pin.eventId]);

    if (!existing) {
      const countRow = await tx.queryOne<{ count: number }>(`
        SELECT COUNT(*)::int AS count FROM message_pins
        WHERE user_id = $1 AND server_id = $2 AND session_name = $3
      `, [params.userId, params.serverId, params.sessionName]);
      if ((countRow?.count ?? 0) >= MESSAGE_PIN_LIMITS.PER_SESSION) {
        return { status: 'limit_reached' };
      }
    }

    const row = await tx.queryOne<MessagePinRow>(`
      INSERT INTO message_pins (
        id, user_id, server_id, session_name, event_id, event_ts,
        event_type, text_snapshot, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
      ON CONFLICT (user_id, server_id, session_name, event_id)
      DO UPDATE SET
        event_ts = EXCLUDED.event_ts,
        event_type = EXCLUDED.event_type,
        text_snapshot = EXCLUDED.text_snapshot,
        updated_at = EXCLUDED.updated_at
      RETURNING ${MESSAGE_PIN_COLUMNS}
    `, [
      existing?.id ?? randomUUID(),
      params.userId,
      params.serverId,
      params.sessionName,
      params.pin.eventId,
      params.pin.eventTs,
      params.pin.eventType,
      params.pin.text,
      now,
    ]);
    if (!row) throw new Error('message_pin_upsert_returned_no_row');
    return { status: 'ok', pin: toMessagePin(row) };
  });
}

export async function deleteMessagePin(
  db: Database,
  params: { id: string; userId: string; serverId: string; sessionName: string },
): Promise<boolean> {
  const result = await db.execute(`
    DELETE FROM message_pins
    WHERE id = $1 AND user_id = $2 AND server_id = $3 AND session_name = $4
  `, [params.id, params.userId, params.serverId, params.sessionName]);
  return result.changes > 0;
}
