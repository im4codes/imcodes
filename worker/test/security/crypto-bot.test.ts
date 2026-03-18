import { describe, it, expect } from 'vitest';
import { encryptBotConfig, decryptBotConfig } from '../../src/security/crypto.js';

const KEY = 'test-encryption-key-for-unit-tests';
const CONFIG = { botToken: 'abc123', webhookSecret: 'supersecret' };

describe('encryptBotConfig / decryptBotConfig', () => {
  it('round-trips a config object', async () => {
    const encrypted = await encryptBotConfig(CONFIG, KEY);
    const decrypted = await decryptBotConfig(encrypted, KEY);
    expect(decrypted).toEqual(CONFIG);
  });

  it('produces different ciphertext each call (random IV)', async () => {
    const a = await encryptBotConfig(CONFIG, KEY);
    const b = await encryptBotConfig(CONFIG, KEY);
    expect(a).not.toBe(b);
  });

  it('throws on wrong decryption key', async () => {
    const encrypted = await encryptBotConfig(CONFIG, KEY);
    await expect(decryptBotConfig(encrypted, 'wrong-key')).rejects.toThrow();
  });

  it('throws when encryptionKey is empty string on encrypt', async () => {
    await expect(encryptBotConfig(CONFIG, '')).rejects.toThrow('BOT_ENCRYPTION_KEY is required');
  });

  it('throws when encryptionKey is empty string on decrypt', async () => {
    const encrypted = await encryptBotConfig(CONFIG, KEY);
    await expect(decryptBotConfig(encrypted, '')).rejects.toThrow('BOT_ENCRYPTION_KEY is required');
  });

  it('throws on corrupted ciphertext', async () => {
    await expect(decryptBotConfig('not-valid-base64!!', KEY)).rejects.toThrow();
  });

  it('preserves all config keys including nested values', async () => {
    const full = { botToken: 'tok', webhookSecret: 'sec', publicKey: 'pub', appId: 'app' };
    const enc = await encryptBotConfig(full, KEY);
    const dec = await decryptBotConfig(enc, KEY);
    expect(dec).toEqual(full);
  });
});
