/**
 * Browser possession proofs for guest access.
 *
 * A thumbprint is not a credential. It is a public identifier that travels with
 * every request, so anyone who observes one can replay it. The only thing that
 * distinguishes the legitimate browser is the private half of a non-exportable
 * WebCrypto key, and the only way to demand it is a signature over bytes the
 * Server chose.
 *
 * Both proofs below therefore follow the same shape: recompute the thumbprint
 * from the presented SPKI (so the caller cannot pair someone else's identifier
 * with its own key), pin the curve, and verify a raw IEEE-P1363 signature over
 * the exact domain-separated preimage frozen in `shared/`.
 *
 * Every function here returns a boolean and never throws on attacker-controlled
 * input: a malformed key, a truncated signature and a wrong signature must all
 * be indistinguishable to the caller.
 */

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import {
  REMOTE_DESKTOP_BROWSER_CLAIM,
  REMOTE_DESKTOP_BOOTSTRAP_PROOF,
  remoteDesktopBootstrapSignaturePreimage,
  remoteDesktopBrowserClaimSignaturePreimage,
} from '../../../shared/remote-desktop-access.js';
import type { RemoteDesktopClaimProof } from '../../../shared/remote-desktop-access.js';

/** Node's name for NIST P-256. A key on any other curve is rejected. */
const REQUIRED_CURVE = 'prime256v1';

function decodeFixed(value: string, bytes: number): Buffer | null {
  let raw: Buffer;
  try {
    raw = Buffer.from(value, 'base64url');
  } catch {
    return null;
  }
  return raw.length === bytes ? raw : null;
}

/**
 * Import a canonical P-256 SPKI.
 *
 * The byte-length check is not cosmetic: an uncompressed P-256 SPKI is exactly
 * 91 bytes, so anything else is either a different curve, a compressed point or
 * a padded forgery attempt. The curve is then re-checked after import because
 * DER parsing alone would happily accept P-384.
 */
function importBrowserKey(spki: string): ReturnType<typeof createPublicKey> | null {
  const der = decodeFixed(spki, REMOTE_DESKTOP_BROWSER_CLAIM.PUBLIC_KEY_SPKI_BYTES);
  if (!der) return null;
  try {
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec') return null;
    if (key.asymmetricKeyDetails?.namedCurve !== REQUIRED_CURVE) return null;
    return key;
  } catch {
    return null;
  }
}

/**
 * The thumbprint must be derived from the presented key, not asserted alongside
 * it. Without this, an attacker could sign with its own key while quoting the
 * victim's thumbprint and satisfy both the signature check and the claim lookup.
 */
function thumbprintMatchesKey(spki: string, thumbprint: string): boolean {
  const der = decodeFixed(spki, REMOTE_DESKTOP_BROWSER_CLAIM.PUBLIC_KEY_SPKI_BYTES);
  const presented = decodeFixed(thumbprint, REMOTE_DESKTOP_BROWSER_CLAIM.THUMBPRINT_BYTES);
  if (!der || !presented) return false;
  const computed = createHash('sha256').update(der).digest();
  return computed.equals(presented);
}

/** Structural P-256 import plus exact SHA-256(SPKI) binding, without proof. */
export function isRemoteDesktopBrowserKeyBindingValid(input: {
  browserPublicKeySpki: string;
  browserKeyThumbprint: string;
}): boolean {
  return importBrowserKey(input.browserPublicKeySpki) !== null
    && thumbprintMatchesKey(input.browserPublicKeySpki, input.browserKeyThumbprint);
}

function verifyP1363(
  key: ReturnType<typeof createPublicKey>,
  preimage: Uint8Array,
  signature: Buffer,
): boolean {
  try {
    return verifySignature('sha256', preimage, { key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    return false;
  }
}

/**
 * Verify a browser-claim proof against the challenge the Server issued.
 *
 * `expectedChallengeId`/`expectedChallenge` come from the consumed durable row,
 * so a proof cannot be replayed against a challenge of the caller's choosing.
 */
export function verifyBrowserClaimProof(input: {
  proof: RemoteDesktopClaimProof;
  expectedChallengeId: string;
  expectedChallenge: string;
}): boolean {
  const { proof } = input;
  if (proof.keyAlgorithm !== REMOTE_DESKTOP_BROWSER_CLAIM.KEY_ALGORITHM) return false;
  if (proof.challengeId !== input.expectedChallengeId) return false;
  if (proof.challenge !== input.expectedChallenge) return false;
  if (!thumbprintMatchesKey(proof.browserPublicKeySpki, proof.browserKeyThumbprint)) return false;

  const challengeId = decodeFixed(proof.challengeId, REMOTE_DESKTOP_BROWSER_CLAIM.CHALLENGE_ID_BYTES);
  const challenge = decodeFixed(proof.challenge, REMOTE_DESKTOP_BROWSER_CLAIM.CHALLENGE_BYTES);
  const thumbprint = decodeFixed(proof.browserKeyThumbprint, REMOTE_DESKTOP_BROWSER_CLAIM.THUMBPRINT_BYTES);
  const signature = decodeFixed(proof.signature, REMOTE_DESKTOP_BROWSER_CLAIM.SIGNATURE_BYTES);
  if (!challengeId || !challenge || !thumbprint || !signature) return false;

  const key = importBrowserKey(proof.browserPublicKeySpki);
  if (!key) return false;

  let preimage: Uint8Array;
  try {
    preimage = remoteDesktopBrowserClaimSignaturePreimage(challengeId, challenge, thumbprint);
  } catch {
    return false;
  }
  return verifyP1363(key, preimage, signature);
}

/**
 * Verify a bootstrap redemption against the SPKI stored when the ticket issued.
 *
 * This is what makes a stolen `serverId` + ticket pair inert: the redeeming
 * caller must sign with the private key that was bound at issue time. The check
 * runs before the single-use consume, so a failed forgery does not spend the
 * legitimate holder's ticket.
 */
export function verifyBootstrapProof(input: {
  ticket: string;
  browserKeyThumbprint: string;
  signature: string;
  storedSpki: string;
}): boolean {
  if (!thumbprintMatchesKey(input.storedSpki, input.browserKeyThumbprint)) return false;

  const ticket = decodeFixed(input.ticket, REMOTE_DESKTOP_BOOTSTRAP_PROOF.TICKET_BYTES);
  const thumbprint = decodeFixed(
    input.browserKeyThumbprint,
    REMOTE_DESKTOP_BROWSER_CLAIM.THUMBPRINT_BYTES,
  );
  const signature = decodeFixed(input.signature, REMOTE_DESKTOP_BOOTSTRAP_PROOF.SIGNATURE_BYTES);
  if (!ticket || !thumbprint || !signature) return false;

  const key = importBrowserKey(input.storedSpki);
  if (!key) return false;

  let preimage: Uint8Array;
  try {
    preimage = remoteDesktopBootstrapSignaturePreimage(ticket, thumbprint);
  } catch {
    return false;
  }
  return verifyP1363(key, preimage, signature);
}

/** Challenges are stored hashed, like every other guest secret. */
export function hashChallengeMaterial(domain: string, value: string): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update(Buffer.from([REMOTE_DESKTOP_BROWSER_CLAIM.SIGNATURE_DOMAIN_SEPARATOR_BYTE]))
    .update(value, 'utf8')
    .digest('hex');
}

export const CHALLENGE_HASH_DOMAIN = {
  ID: 'imcodes.remote-desktop.claim-challenge-id.v1',
  VALUE: 'imcodes.remote-desktop.claim-challenge.v1',
} as const;
