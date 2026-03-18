/** Cryptographic helpers for the CF Worker (Web Crypto API) */

export function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function signJwt(payload: Record<string, unknown>, signingKey: string, expiresInSecs: number): Promise<string> {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=/g, '');
  const claims = btoa(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + expiresInSecs })).replace(/=/g, '');
  const signingInput = `${header}.${claims}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${signingInput}.${sigB64}`;
}

export async function verifyJwt(token: string, signingKey: string): Promise<Record<string, unknown> | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, claims, sig] = parts;
    const signingInput = `${header}.${claims}`;

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(signingKey),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const sigBytes = Uint8Array.from(atob(sig.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(signingInput));
    if (!valid) return null;

    const payload = JSON.parse(atob(claims)) as Record<string, unknown>;
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Bot config encryption (AES-256-GCM) ──────────────────────────────────────
// Format: base64(iv[12] || ciphertext || authTag[16])
// Throws on missing key or decryption failure — no silent plaintext fallback.

async function importAesKey(rawKey: string): Promise<CryptoKey> {
  const keyBytes = new TextEncoder().encode(rawKey);
  // Derive a 256-bit key via SHA-256 so any-length string works as a key
  const digest = await crypto.subtle.digest('SHA-256', keyBytes);
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Encrypt a bot config object. Returns base64(iv||ciphertext||authTag).
 * Throws if encryptionKey is empty.
 */
export async function encryptBotConfig(config: Record<string, string>, encryptionKey: string): Promise<string> {
  if (!encryptionKey) throw new Error('BOT_ENCRYPTION_KEY is required');
  const key = await importAesKey(encryptionKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(config));
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  // iv (12) + ciphertext + authTag (16, appended by AES-GCM)
  const combined = new Uint8Array(iv.byteLength + cipherBuf.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipherBuf), iv.byteLength);
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a bot config blob produced by encryptBotConfig.
 * Throws if encryptionKey is empty or decryption fails (wrong key / corrupted data).
 */
export async function decryptBotConfig(encrypted: string, encryptionKey: string): Promise<Record<string, string>> {
  if (!encryptionKey) throw new Error('BOT_ENCRYPTION_KEY is required');
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const key = await importAesKey(encryptionKey);
  let plainBuf: ArrayBuffer;
  try {
    plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  } catch {
    throw new Error('Bot config decryption failed — wrong key or corrupted data');
  }
  return JSON.parse(new TextDecoder().decode(plainBuf)) as Record<string, string>;
}

/** Constant-time string comparison to prevent timing attacks */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
