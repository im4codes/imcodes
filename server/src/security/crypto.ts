/**
 * Cryptographic helpers using Node.js `node:crypto`.
 * Drop-in replacement for the CF Worker Web Crypto implementation.
 * AES-256-GCM format is compatible: base64(iv[12] || ciphertext || authTag[16]).
 */

import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual as nodeTimingSafeEqual, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scryptCb);

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// ── JWT ───────────────────────────────────────────────────────────────────────

function b64url(buf: Buffer | string): string {
  const b64 = Buffer.isBuffer(buf) ? buf.toString('base64') : Buffer.from(buf).toString('base64');
  return b64.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function signJwt(payload: Record<string, unknown>, signingKey: string, expiresInSecs: number): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const nowSec = Math.floor(Date.now() / 1000);
  const claims = b64url(JSON.stringify({
    ...payload,
    iat: typeof payload.iat === 'number' ? payload.iat : nowSec,
    exp: typeof payload.exp === 'number' ? payload.exp : nowSec + expiresInSecs,
  }));
  const signingInput = `${header}.${claims}`;
  const sig = createHmac('sha256', signingKey).update(signingInput).digest();
  return `${signingInput}.${b64url(sig)}`;
}

export function verifyJwt(token: string, signingKey: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, claims, sigB64] = parts;
    const signingInput = `${header}.${claims}`;

    const expected = createHmac('sha256', signingKey).update(signingInput).digest();
    const actual = Buffer.from(sigB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

    if (expected.length !== actual.length) return null;
    if (!nodeTimingSafeEqual(expected, actual)) return null;

    const payload = JSON.parse(Buffer.from(claims, 'base64').toString('utf8')) as Record<string, unknown>;
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── AES-256-GCM bot config encryption ─────────────────────────────────────────
// Format: base64(iv[12] || ciphertext || authTag[16])
// Compatible with Web Crypto format produced by the CF Worker implementation.

function deriveAesKey(rawKey: string): Buffer {
  return createHash('sha256').update(rawKey, 'utf8').digest();
}

/**
 * Encrypt a bot config object. Returns base64(iv||ciphertext||authTag).
 */
export function encryptBotConfig(config: Record<string, string>, encryptionKey: string): string {
  if (!encryptionKey) throw new Error('BOT_ENCRYPTION_KEY is required');
  const key = deriveAesKey(encryptionKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify(config);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag(); // 16 bytes
  // Matches Web Crypto layout: iv(12) || ciphertext || authTag(16)
  const combined = Buffer.concat([iv, ciphertext, authTag]);
  return combined.toString('base64');
}

/**
 * Decrypt a bot config blob produced by encryptBotConfig (or the Web Crypto implementation).
 */
export function decryptBotConfig(encrypted: string, encryptionKey: string): Record<string, string> {
  if (!encryptionKey) throw new Error('BOT_ENCRYPTION_KEY is required');
  const combined = Buffer.from(encrypted, 'base64');
  if (combined.length < 12 + 16) throw new Error('Bot config decryption failed — data too short');

  const iv = combined.subarray(0, 12);
  const authTag = combined.subarray(combined.length - 16);
  const ciphertext = combined.subarray(12, combined.length - 16);

  const key = deriveAesKey(encryptionKey);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as Record<string, string>;
  } catch {
    throw new Error('Bot config decryption failed — wrong key or corrupted data');
  }
}

// ── AES-256-GCM user alias field encryption ──────────────────────────────────
// Uses a domain-separated 256-bit key derived from BOT_ENCRYPTION_KEY via HMAC-SHA256
// and binds AAD to (user_id, field) so ciphertexts cannot be replayed across users
// or swapped between `value` and `description`.
// Format: base64(iv[12] || ciphertext || authTag[16])

const ALIAS_KEY_DOMAIN = 'imcodes:user_aliases:v1';

export type AliasEncryptedField = 'value' | 'description';

function deriveAliasAesKey(encryptionKey: string): Buffer {
  if (!encryptionKey || !encryptionKey.trim()) {
    throw new Error('alias_encryption_unavailable');
  }
  return createHmac('sha256', encryptionKey).update(ALIAS_KEY_DOMAIN, 'utf8').digest();
}

function aliasFieldAad(userId: string, field: AliasEncryptedField): Buffer {
  if (!userId) throw new Error('alias_encryption_unavailable');
  return Buffer.from(`user_aliases:v1:${userId}:${field}`, 'utf8');
}

/**
 * Encrypt a single user alias field (`value` or `description`) with AES-256-GCM,
 * fresh 12-byte random IV, and AAD bound to `(userId, field)`.
 */
export function encryptAliasField(
  plaintext: string,
  encryptionKey: string,
  userId: string,
  field: AliasEncryptedField,
): string {
  const key = deriveAliasAesKey(encryptionKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aliasFieldAad(userId, field));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, authTag]).toString('base64');
}

/**
 * Decrypt a single user alias field (`value` or `description`) encrypted by
 * {@link encryptAliasField}. Fails closed on missing key, wrong key, wrong AAD,
 * or tampered/corrupted ciphertext.
 */
export function decryptAliasField(
  encoded: string,
  encryptionKey: string,
  userId: string,
  field: AliasEncryptedField,
): string {
  const key = deriveAliasAesKey(encryptionKey);
  const combined = Buffer.from(encoded, 'base64');
  if (combined.length < 12 + 16) {
    throw new Error('alias_decryption_failed');
  }
  const iv = combined.subarray(0, 12);
  const authTag = combined.subarray(combined.length - 16);
  const ciphertext = combined.subarray(12, combined.length - 16);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aliasFieldAad(userId, field));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    throw new Error('alias_decryption_failed');
  }
}

/** Constant-time string comparison */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return nodeTimingSafeEqual(bufA, bufB);
}

// ── Password hashing (scrypt) ───────────────────────────────────────────────
// Format: salt_hex:derived_hex  (32-byte salt, 64-byte derived key)

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(32);
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, derivedHex] = stored.split(':');
  if (!saltHex || !derivedHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(derivedHex, 'hex');
  const actual = (await scryptAsync(password, salt, 64)) as Buffer;
  if (expected.length !== actual.length) return false;
  return nodeTimingSafeEqual(expected, actual);
}
