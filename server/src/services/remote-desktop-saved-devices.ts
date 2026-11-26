import { randomUUID } from 'node:crypto';
import type { Database } from '../db/client.js';
import { isRemoteDesktopId } from '../../../shared/remote-desktop-contract-primitives.js';
import { isRemoteDesktopPublicNodeId } from '../../../shared/remote-desktop-access.js';
import { hashBootstrapTicket } from './remote-desktop-guest-bootstrap.js';
import { hashBrowserKey } from './remote-desktop-guest-links.js';
import { REMOTE_DESKTOP_ACTOR_SOURCE } from '../../../shared/remote-desktop-access.js';

export interface SavedRemoteDesktopDevice {
  id: string;
  hostId: string;
  publicNodeId: string;
  displayName: string;
  savedAt: number;
}

interface SavedDeviceRow {
  id: string;
  host_id: string;
  public_id: string;
  display_name: string | null;
  created_at: number;
}

/**
 * A saved device is deliberately not a server_share. It is only a convenient
 * locator for a user who already proved the current unattended password; every
 * reconnect must return through the existing public-ID/password proof route.
 */
export async function saveRemoteDesktopDevice(db: Database, input: {
  userId: string;
  publicNodeId: string;
  bootstrapTicket: string;
  browserKeyThumbprint: string;
  now: number;
}): Promise<SavedRemoteDesktopDevice | null> {
  if (!input.userId || !isRemoteDesktopPublicNodeId(Number(input.publicNodeId))
    || input.bootstrapTicket.length < 20 || input.browserKeyThumbprint.length < 16) return null;
  return db.transaction(async (tx) => {
    const proof = await tx.queryOne<{
      host_id: string;
      credential_generation: number;
      browser_key_hash: string;
      expires_at: number;
      redeemed_at: number | null;
      session_id: string | null;
      session_state: string | null;
      session_browser_key_hash: string | null;
      session_password_generation: number | null;
      actor_source: string;
      public_id: string;
    }>(
      `SELECT b.host_id, b.credential_generation, b.browser_key_hash,
              b.expires_at, b.redeemed_at, b.resume_session_id AS session_id,
              b.actor_source, i.public_id,
              s.state AS session_state, s.browser_key_hash AS session_browser_key_hash,
              s.password_generation AS session_password_generation
         FROM remote_desktop_guest_bootstraps b
         JOIN remote_desktop_public_ids i
           ON i.host_id = b.host_id AND i.status = 'active'
         LEFT JOIN remote_desktop_guest_sessions s ON s.id = b.resume_session_id
        WHERE b.ticket_hash = $1
        FOR UPDATE OF b`,
      [hashBootstrapTicket(input.bootstrapTicket)],
    );
    if (!proof
      || proof.actor_source !== REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD
      || proof.public_id !== input.publicNodeId
      || (proof.browser_key_hash !== hashBrowserKey(input.browserKeyThumbprint)
        && proof.session_browser_key_hash !== hashBrowserKey(input.browserKeyThumbprint))) return null;
    const freshTicket = proof.redeemed_at === null && proof.expires_at > input.now;
    const liveSession = proof.session_state === 'admitting' || proof.session_state === 'active';
    if (!freshTicket && !(liveSession && proof.session_password_generation === proof.credential_generation)) return null;
    const credential = await tx.queryOne<{ generation: number; disabled_at: number | null }>(
      `SELECT generation, disabled_at
         FROM remote_desktop_unattended_passwords
        WHERE host_id = $1
        FOR UPDATE`,
      [proof.host_id],
    );
    if (!credential || credential.disabled_at !== null || credential.generation !== proof.credential_generation) return null;
    const id = randomUUID();
    await tx.execute(
      `INSERT INTO remote_desktop_saved_devices
         (id, user_id, host_id, public_node_id, password_generation, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (user_id, host_id, public_node_id) DO UPDATE SET
         password_generation = EXCLUDED.password_generation,
         updated_at = EXCLUDED.updated_at`,
      [id, input.userId, proof.host_id, proof.public_id, proof.credential_generation, input.now],
    );
    const row = await tx.queryOne<SavedDeviceRow>(
      `SELECT d.id, d.host_id, d.public_node_id AS public_id, d.created_at,
              (SELECT COALESCE(s.display_name, s.ref_name, s.id)
                 FROM remote_desktop_host_endpoints e
                 JOIN servers s ON s.id = e.server_id
                WHERE e.host_id = d.host_id
                ORDER BY (e.endpoint_role = 'controlled') DESC, s.id
                LIMIT 1) AS display_name
         FROM remote_desktop_saved_devices d
         JOIN remote_desktop_public_ids i
           ON i.host_id = d.host_id AND i.public_id = d.public_node_id AND i.status = 'active'
        WHERE d.user_id = $1 AND d.host_id = $2`,
      [input.userId, proof.host_id],
    );
    return row ? mapSavedDevice(row) : null;
  });
}

export async function listSavedRemoteDesktopDevices(
  db: Database,
  userId: string,
  _now: number,
): Promise<SavedRemoteDesktopDevice[]> {
  if (!userId) return [];
  return db.transaction(async (tx) => {
    const rows = await tx.query<SavedDeviceRow>(
      `SELECT d.id, d.host_id, d.public_node_id AS public_id,
              d.created_at,
              (SELECT COALESCE(s.display_name, s.ref_name, s.id)
                 FROM remote_desktop_host_endpoints e
                 JOIN servers s ON s.id = e.server_id
                WHERE e.host_id = d.host_id
                ORDER BY (e.endpoint_role = 'controlled') DESC, s.id
                LIMIT 1) AS display_name
         FROM remote_desktop_saved_devices d
         JOIN remote_desktop_unattended_passwords p
           ON p.host_id = d.host_id AND p.generation = d.password_generation AND p.disabled_at IS NULL
         JOIN remote_desktop_public_ids i
           ON i.host_id = d.host_id AND i.public_id = d.public_node_id AND i.status = 'active'
        WHERE d.user_id = $1
        ORDER BY d.updated_at DESC, d.id`,
      [userId],
    );
    return rows.map(mapSavedDevice);
  });
}

export async function removeSavedRemoteDesktopDevice(
  db: Database,
  userId: string,
  id: string,
): Promise<boolean> {
  if (!userId || !isRemoteDesktopId(id)) return false;
  const result = await db.execute(
    'DELETE FROM remote_desktop_saved_devices WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  return result.changes === 1;
}

function mapSavedDevice(row: SavedDeviceRow): SavedRemoteDesktopDevice {
  return {
    id: row.id,
    hostId: row.host_id,
    publicNodeId: row.public_id,
    displayName: row.display_name?.trim() || row.public_id,
    savedAt: row.created_at,
  };
}
