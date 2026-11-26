import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Database } from '../src/db/client.js';
import {
  issueNodePasswordBootstrap,
  redeemBootstrap,
} from '../src/services/remote-desktop-guest-bootstrap.js';
import { hashBrowserKey } from '../src/services/remote-desktop-guest-links.js';
import { remoteDesktopBootstrapSignaturePreimage } from '../../shared/remote-desktop-access.js';
import { REMOTE_DESKTOP_CAPABILITY } from '../../shared/remote-desktop.js';

const NOW = 1_900_000_000_000;
const TICKET = Buffer.alloc(32, 7).toString('base64url');
const KEY_PAIR = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const SPKI = (KEY_PAIR.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64url');
const THUMBPRINT = createHash('sha256').update(Buffer.from(SPKI, 'base64url')).digest('base64url');
const SIGNATURE = sign(
  'sha256',
  remoteDesktopBootstrapSignaturePreimage(
    Buffer.from(TICKET, 'base64url'),
    Buffer.from(THUMBPRINT, 'base64url'),
  ),
  { key: KEY_PAIR.privateKey, dsaEncoding: 'ieee-p1363' },
).toString('base64url');

class PasswordBootstrapDb {
  currentGeneration = 5;
  disabledAt: number | null = null;
  consumed = false;

  async queryOne<T>(sql: string): Promise<T | null> {
    const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
    if (normalized.includes('from remote_desktop_guest_bootstraps')) {
      if (this.consumed) return null;
      return {
        host_id: 'host-password-1',
        link_id: null,
        target_server_id: 'server-password-1',
        actor_source: 'node_password',
        mode: 'control',
        authority_generation: 5,
        expiry_revision: null,
        credential_generation: 5,
        browser_key_hash: hashBrowserKey(THUMBPRINT),
        browser_public_key_spki: SPKI,
        resume_session_id: null,
        expires_at: NOW + 30_000,
        redeemed_at: null,
      } as T;
    }
    if (normalized.includes('from remote_desktop_unattended_passwords')) {
      return { generation: this.currentGeneration, disabled_at: this.disabledAt } as T;
    }
    throw new Error(`Unhandled queryOne: ${normalized}`);
  }

  async execute(sql: string): Promise<{ changes: number }> {
    const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalized.startsWith('update remote_desktop_guest_bootstraps')) {
      throw new Error(`Unhandled execute: ${normalized}`);
    }
    if (this.consumed) return { changes: 0 };
    this.consumed = true;
    return { changes: 1 };
  }

  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    return fn(this as unknown as Database);
  }

  asDatabase(): Database {
    return this as unknown as Database;
  }
}

class PasswordBootstrapIssueDb {
  currentGeneration = 5;
  activePublicNodeId = '5837462190';
  privacyPhase = 'idle';
  admissionOpen = true;
  insertedParams: unknown[] | null = null;

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
    if (normalized.includes('from remote_desktop_unattended_passwords')) {
      return { generation: this.currentGeneration, disabled_at: null } as T;
    }
    if (normalized.includes('from remote_desktop_public_ids')) {
      if (normalized.includes('public_id = $1')) {
        return params[0] === this.activePublicNodeId && params[1] === 'host-password-1'
          ? { public_id: this.activePublicNodeId } as T
          : null;
      }
      return params[0] === 'host-password-1'
        ? { public_id: this.activePublicNodeId } as T
        : null;
    }
    if (normalized.includes('from remote_desktop_management_privacy')) {
      return { phase: this.privacyPhase, admission_open: this.admissionOpen } as T;
    }
    if (normalized.includes('from remote_desktop_hosts')) return { merge_state: 'resolved' } as T;
    throw new Error(`Unhandled queryOne: ${normalized}`);
  }

  async query<T>(sql: string): Promise<T[]> {
    const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
    if (normalized.includes('from remote_desktop_host_endpoints')) {
      return [{
        server_id: 'server-password-1',
        host_id: 'host-password-1',
        endpoint_role: 'controlled',
        controlled_capabilities: [REMOTE_DESKTOP_CAPABILITY],
      }] as T[];
    }
    throw new Error(`Unhandled query: ${normalized}`);
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalized.startsWith('insert into remote_desktop_guest_bootstraps')) {
      throw new Error(`Unhandled execute: ${normalized}`);
    }
    this.insertedParams = params;
    return { changes: 1 };
  }

  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    return fn(this as unknown as Database);
  }

  asDatabase(): Database {
    return this as unknown as Database;
  }
}

const proof = { ticket: TICKET, browserKeyThumbprint: THUMBPRINT, signature: SIGNATURE };

describe('unattended password bootstrap generation binding', () => {
  it('rechecks generation and persists the public SPKI in the same issue transaction', async () => {
    const db = new PasswordBootstrapIssueDb();
    await expect(issueNodePasswordBootstrap(db.asDatabase(), {
      hostId: 'host-password-1',
      publicNodeId: '5837462190',
      credentialGeneration: 5,
      browserPublicKeySpki: SPKI,
      browserKeyThumbprint: THUMBPRINT,
      now: NOW,
    })).resolves.toMatchObject({
      ok: true,
      serverId: 'server-password-1',
      source: 'node_password',
      mode: 'control',
    });
    expect(db.insertedParams).toEqual(expect.arrayContaining([
      'host-password-1',
      'server-password-1',
      'node_password',
      'control',
      5,
      SPKI,
    ]));
    expect(db.insertedParams).not.toContain(KEY_PAIR.privateKey);

    const raced = new PasswordBootstrapIssueDb();
    raced.currentGeneration = 6;
    await expect(issueNodePasswordBootstrap(raced.asDatabase(), {
      hostId: 'host-password-1',
      publicNodeId: '5837462190',
      credentialGeneration: 5,
      browserPublicKeySpki: SPKI,
      browserKeyThumbprint: THUMBPRINT,
      now: NOW,
    })).resolves.toBeNull();
    expect(raced.insertedParams).toBeNull();

    const rotated = new PasswordBootstrapIssueDb();
    rotated.activePublicNodeId = '5987654321';
    await expect(issueNodePasswordBootstrap(rotated.asDatabase(), {
      hostId: 'host-password-1',
      publicNodeId: '5837462190',
      credentialGeneration: 5,
      browserPublicKeySpki: SPKI,
      browserKeyThumbprint: THUMBPRINT,
      now: NOW,
    })).resolves.toBeNull();
    expect(rotated.insertedParams).toBeNull();

    const shielded = new PasswordBootstrapIssueDb();
    shielded.privacyPhase = 'active';
    shielded.admissionOpen = false;
    await expect(issueNodePasswordBootstrap(shielded.asDatabase(), {
      hostId: 'host-password-1',
      publicNodeId: '5837462190',
      credentialGeneration: 5,
      browserPublicKeySpki: SPKI,
      browserKeyThumbprint: THUMBPRINT,
      now: NOW,
    })).resolves.toBeNull();
    expect(shielded.insertedParams).toBeNull();
  });

  it('redeems only with the current password generation and the bound non-exportable-key proof', async () => {
    const db = new PasswordBootstrapDb();
    await expect(redeemBootstrap(db.asDatabase(), {
      proof,
      redeemingServerId: 'server-password-1',
      now: NOW,
    })).resolves.toMatchObject({
      actorSource: 'node_password',
      mode: 'control',
      credentialGeneration: 5,
      browserPublicKeySpki: SPKI,
      browserKeyThumbprint: THUMBPRINT,
    });
    expect(db.consumed).toBe(true);
  });

  it('does not revive a ticket after password change or emergency disable', async () => {
    for (const state of [
      { generation: 6, disabledAt: null },
      { generation: 5, disabledAt: NOW - 1 },
    ]) {
      const db = new PasswordBootstrapDb();
      db.currentGeneration = state.generation;
      db.disabledAt = state.disabledAt;
      await expect(redeemBootstrap(db.asDatabase(), {
        proof,
        redeemingServerId: 'server-password-1',
        now: NOW,
      })).resolves.toBeNull();
      expect(db.consumed).toBe(false);
    }
  });
});
