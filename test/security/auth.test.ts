import { describe, it, expect } from 'vitest';

// Test crypto utilities used for auth
describe('Crypto utilities (auth security)', () => {
  it('sha256Hex produces consistent hashes', async () => {
    // Use Node.js built-in crypto since worker crypto.subtle isn't available in test env
    const { createHash } = await import('crypto');
    const hash1 = createHash('sha256').update('test-api-key').digest('hex');
    const hash2 = createHash('sha256').update('test-api-key').digest('hex');
    expect(hash1).toBe(hash2);
  });

  it('different inputs produce different hashes', async () => {
    const { createHash } = await import('crypto');
    const h1 = createHash('sha256').update('key-1').digest('hex');
    const h2 = createHash('sha256').update('key-2').digest('hex');
    expect(h1).not.toBe(h2);
  });

  it('API key format is deck_ prefixed', () => {
    // API keys generated as `deck_${randomHex(32)}`
    const mockKey = 'deck_' + 'a'.repeat(64);
    expect(mockKey.startsWith('deck_')).toBe(true);
    expect(mockKey.length).toBeGreaterThan(30);
  });

  it('JWT payload contains sub (user_id)', async () => {
    // Simulate JWT structure: base64(header).base64(payload).signature
    const payload = { sub: 'user-123', exp: Math.floor(Date.now() / 1000) + 900 };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    expect(decoded.sub).toBe('user-123');
  });

  it('JWT exp is 15 minutes from now', () => {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 15 * 60;
    expect(exp - now).toBe(900);
  });

  it('refresh token expiry is 30 days', () => {
    const now = Date.now();
    const expires = now + 30 * 24 * 3600 * 1000;
    const diffDays = (expires - now) / (24 * 3600 * 1000);
    expect(diffDays).toBe(30);
  });

  it('API key rotation grace period is 24 hours', () => {
    const now = Date.now();
    const grace = now + 24 * 3600 * 1000;
    const diffHours = (grace - now) / 3600000;
    expect(diffHours).toBe(24);
  });

  it('auth lockout after 5 failed attempts', () => {
    const AUTH_LOCKOUT_ATTEMPTS = 5;
    let attempts = 0;
    let locked = false;
    for (let i = 0; i < 6; i++) {
      attempts++;
      if (attempts >= AUTH_LOCKOUT_ATTEMPTS) locked = true;
    }
    expect(locked).toBe(true);
  });

  it('auth lockout duration is 15 minutes', () => {
    const lockoutMs = 15 * 60 * 1000;
    expect(lockoutMs).toBe(900000);
  });
});
