import { describe, it, expect } from 'vitest';
import { sha256Hex, randomHex, signJwt, verifyJwt, encryptBotConfig, decryptBotConfig, timingSafeEqual } from '../src/security/crypto.js';

const KEY = 'test-signing-key-32-bytes-xxxxxxx';
const ENC_KEY = 'test-encryption-key-32-bytes-xxx';

describe('sha256Hex', () => {
  it('produces correct digest', () => {
    // Known SHA-256 of "hello"
    expect(sha256Hex('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});

describe('randomHex', () => {
  it('returns correct length', () => {
    expect(randomHex(16)).toHaveLength(32);
    expect(randomHex(32)).toHaveLength(64);
  });
  it('returns different values each call', () => {
    expect(randomHex(16)).not.toBe(randomHex(16));
  });
});

describe('JWT', () => {
  it('sign and verify roundtrip', () => {
    const token = signJwt({ sub: 'u1', type: 'access' }, KEY, 3600);
    const payload = verifyJwt(token, KEY);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe('u1');
    expect(payload!.type).toBe('access');
  });

  it('returns null for expired token', () => {
    const token = signJwt({ sub: 'u1' }, KEY, -1); // already expired
    expect(verifyJwt(token, KEY)).toBeNull();
  });

  it('returns null for tampered payload', () => {
    const token = signJwt({ sub: 'u1' }, KEY, 3600);
    const parts = token.split('.');
    // Encode different payload
    const tamperedClaims = Buffer.from(JSON.stringify({ sub: 'evil', exp: 9999999999 })).toString('base64url');
    const tampered = `${parts[0]}.${tamperedClaims}.${parts[2]}`;
    expect(verifyJwt(tampered, KEY)).toBeNull();
  });

  it('returns null for wrong key', () => {
    const token = signJwt({ sub: 'u1' }, KEY, 3600);
    expect(verifyJwt(token, 'wrong-key')).toBeNull();
  });
});

describe('AES-256-GCM', () => {
  const config = { botToken: 'secret123', webhookSecret: 'abc' };

  it('encrypt/decrypt roundtrip', () => {
    const encrypted = encryptBotConfig(config, ENC_KEY);
    const decrypted = decryptBotConfig(encrypted, ENC_KEY);
    expect(decrypted).toEqual(config);
  });

  it('throws on wrong key', () => {
    const encrypted = encryptBotConfig(config, ENC_KEY);
    expect(() => decryptBotConfig(encrypted, 'wrong-key')).toThrow();
  });

  it('produces different ciphertext each call (random IV)', () => {
    const a = encryptBotConfig(config, ENC_KEY);
    const b = encryptBotConfig(config, ENC_KEY);
    expect(a).not.toBe(b);
  });

  it('ciphertext format: base64(iv[12] || ciphertext || authTag[16])', () => {
    const plaintext = JSON.stringify(config);
    const encrypted = encryptBotConfig(config, ENC_KEY);
    const combined = Buffer.from(encrypted, 'base64');
    // minimum: iv(12) + at least 1 byte ciphertext + authTag(16)
    expect(combined.length).toBeGreaterThan(12 + 16);
    // ciphertext portion length = plaintext bytes (AES-GCM no padding)
    expect(combined.length - 12 - 16).toBe(Buffer.byteLength(plaintext, 'utf8'));
  });
});

describe('timingSafeEqual', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
  });

  it('returns false for different strings', () => {
    expect(timingSafeEqual('abc', 'xyz')).toBe(false);
  });

  it('returns false for different length strings', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});
