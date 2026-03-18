import { describe, it, expect } from 'vitest';
import { sha256Hex, randomHex } from '../../src/security/crypto.js';
import { bindRoutes } from '../../src/routes/bind.js';
import { Hono } from 'hono';

describe('bindRoutes', () => {
  it('is a Hono instance', () => {
    expect(bindRoutes).toBeInstanceOf(Hono);
  });

  it('has POST /initiate route registered', () => {
    const routes = bindRoutes.routes;
    const initiateRoute = routes.find(
      (r) => r.method === 'POST' && r.path === '/initiate',
    );
    expect(initiateRoute).toBeDefined();
  });

  it('has POST /confirm route registered', () => {
    const routes = bindRoutes.routes;
    const confirmRoute = routes.find(
      (r) => r.method === 'POST' && r.path === '/confirm',
    );
    expect(confirmRoute).toBeDefined();
  });

  it('has POST /verify route registered', () => {
    const routes = bindRoutes.routes;
    const verifyRoute = routes.find(
      (r) => r.method === 'POST' && r.path === '/verify',
    );
    expect(verifyRoute).toBeDefined();
  });
});

describe('sha256Hex', () => {
  it('returns a 64-character hex string', async () => {
    const result = await sha256Hex('hello');
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it('produces a known hash for empty string', async () => {
    const result = await sha256Hex('');
    // SHA-256 of empty string
    expect(result).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('produces consistent output for same input', async () => {
    const a = await sha256Hex('consistent');
    const b = await sha256Hex('consistent');
    expect(a).toBe(b);
  });

  it('produces different hashes for different inputs', async () => {
    const a = await sha256Hex('input-a');
    const b = await sha256Hex('input-b');
    expect(a).not.toBe(b);
  });
});

describe('randomHex', () => {
  it('returns hex string of correct length for given byte count', () => {
    const result = randomHex(4);
    expect(result).toHaveLength(8); // 4 bytes = 8 hex chars
  });

  it('returns only hex characters', () => {
    const result = randomHex(16);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it('generates unique values on each call', () => {
    const a = randomHex(16);
    const b = randomHex(16);
    expect(a).not.toBe(b);
  });

  it('respects byte length: 32 bytes → 64 hex chars (token length used in confirm)', () => {
    const token = randomHex(32);
    expect(token).toHaveLength(64);
  });

  it('bind code is 8 chars (4 bytes)', () => {
    const code = randomHex(4).toUpperCase();
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^[0-9A-F]+$/);
  });
});
