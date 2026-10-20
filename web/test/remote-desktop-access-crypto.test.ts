import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  generateRemoteDesktopBrowserKeyPair,
  generateRemoteDesktopRawInvite,
  getOrCreateRemoteDesktopInviteBinding,
  isRemoteDesktopBrowserKeyNonExportable,
  loadRemoteDesktopInviteBinding,
  signRemoteDesktopClaim,
} from '../src/remote-desktop-access-crypto.js';
import {
  REMOTE_DESKTOP_BROWSER_CLAIM,
  REMOTE_DESKTOP_LINK_TOKEN,
} from '../../shared/remote-desktop-access.js';

const B64_32 = 'A'.repeat(REMOTE_DESKTOP_BROWSER_CLAIM.CHALLENGE_ID_ENCODED_LENGTH);

describe('remote desktop browser access crypto', () => {
  beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });
  it('generates a one-time raw invite and only exposes a bounded hash for storage', async () => {
    const invite = await generateRemoteDesktopRawInvite();
    expect(invite.token).toHaveLength(REMOTE_DESKTOP_LINK_TOKEN.ENCODED_LENGTH);
    expect(invite.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(invite.tokenHash).not.toContain(invite.token);
  });

  it('keeps the P-256 private key non-exportable and signs canonical claim bytes', async () => {
    const key = await generateRemoteDesktopBrowserKeyPair();
    expect(key.publicKeySpki).toHaveLength(REMOTE_DESKTOP_BROWSER_CLAIM.PUBLIC_KEY_SPKI_ENCODED_LENGTH);
    expect(key.thumbprint).toHaveLength(REMOTE_DESKTOP_BROWSER_CLAIM.THUMBPRINT_ENCODED_LENGTH);
    expect(isRemoteDesktopBrowserKeyNonExportable(key.privateKey)).toBe(true);
    await expect(crypto.subtle.exportKey('pkcs8', key.privateKey)).rejects.toThrow();
    const signature = await signRemoteDesktopClaim({
      challengeId: B64_32,
      challenge: B64_32,
      browserKeyThumbprint: key.thumbprint,
      privateKey: key.privateKey,
    });
    expect(signature).toHaveLength(REMOTE_DESKTOP_BROWSER_CLAIM.SIGNATURE_ENCODED_LENGTH);
  });

  it('reuses one non-exportable key and decrypts the original bearer across page reloads', async () => {
    const invite = await generateRemoteDesktopRawInvite();
    const first = await getOrCreateRemoteDesktopInviteBinding(invite.token);
    const reopened = await getOrCreateRemoteDesktopInviteBinding(invite.token);
    const refreshed = await loadRemoteDesktopInviteBinding(invite.tokenHash);

    expect(first.tokenHash).toBe(invite.tokenHash);
    expect(reopened.browserKey.thumbprint).toBe(first.browserKey.thumbprint);
    expect(refreshed?.browserKey.thumbprint).toBe(first.browserKey.thumbprint);
    expect(refreshed?.browserKey.privateKey.extractable).toBe(false);
    expect(refreshed?.token).toBe(invite.token);

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('imcodes-remote-desktop-invite-keys-v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stored = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const request = db.transaction('invite-keys').objectStore('invite-keys').get(invite.tokenHash);
      request.onsuccess = () => resolve(request.result as Record<string, unknown>);
      request.onerror = () => reject(request.error);
    });
    expect(JSON.stringify(stored)).not.toContain(invite.token);
    expect(stored).not.toHaveProperty('token');
    expect(stored.privateKey).toBeInstanceOf(CryptoKey);
    expect(stored.tokenEncryptionKey).toBeInstanceOf(CryptoKey);
    expect((stored.tokenEncryptionKey as CryptoKey).extractable).toBe(false);
    expect((stored.tokenEncryptionKey as CryptoKey).algorithm.name).toBe('AES-GCM');
    expect(Object.prototype.toString.call(stored.tokenCiphertext)).toBe('[object ArrayBuffer]');
    expect(new TextDecoder().decode(stored.tokenCiphertext as ArrayBuffer)).not.toBe(invite.token);
    db.close();
  });
});
