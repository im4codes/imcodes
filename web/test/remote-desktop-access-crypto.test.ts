import { describe, expect, it } from 'vitest';
import {
  generateRemoteDesktopBrowserKeyPair,
  generateRemoteDesktopRawInvite,
  isRemoteDesktopBrowserKeyNonExportable,
  signRemoteDesktopClaim,
} from '../src/remote-desktop-access-crypto.js';
import {
  REMOTE_DESKTOP_BROWSER_CLAIM,
  REMOTE_DESKTOP_LINK_TOKEN,
} from '../../shared/remote-desktop-access.js';

const B64_32 = 'A'.repeat(REMOTE_DESKTOP_BROWSER_CLAIM.CHALLENGE_ID_ENCODED_LENGTH);

describe('remote desktop browser access crypto', () => {
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
});
