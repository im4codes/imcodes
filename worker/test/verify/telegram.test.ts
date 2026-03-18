import { describe, it, expect, beforeEach } from 'vitest';
import { TelegramHandler } from '../../src/platform/handlers/telegram/index.js';
import type { BotConfig } from '../../src/platform/types.js';

function makeBotConfig(overrides: Partial<Record<string, string>> = {}): BotConfig {
  return {
    botId: 'bot-tg',
    userId: 'user-1',
    platform: 'telegram',
    config: {
      botToken: 'tg-bot-token',
      webhookSecret: 'my-secret',
      ...overrides,
    },
  };
}

function makeRequest(secretHeader: string | null, body = '{}'): Request {
  const headers: Record<string, string> = {};
  if (secretHeader !== null) {
    headers['X-Telegram-Bot-Api-Secret-Token'] = secretHeader;
  }
  return new Request('https://example.com/webhook', {
    method: 'POST',
    headers,
    body,
  });
}

describe('TelegramHandler.verifyInbound', () => {
  let handler: TelegramHandler;

  beforeEach(() => {
    handler = new TelegramHandler();
  });

  it('returns true when secret matches config secret', async () => {
    const req = makeRequest('my-secret');
    const result = await handler.verifyInbound(req, makeBotConfig());
    expect(result).toBe(true);
  });

  it('returns false when secret does not match', async () => {
    const req = makeRequest('wrong-secret');
    const result = await handler.verifyInbound(req, makeBotConfig({ webhookSecret: 'correct-secret' }));
    expect(result).toBe(false);
  });

  it('returns false when header is missing', async () => {
    const req = makeRequest(null);
    const result = await handler.verifyInbound(req, makeBotConfig());
    expect(result).toBe(false);
  });

  it('returns false when config secret is not configured', async () => {
    const req = makeRequest('some-secret');
    const result = await handler.verifyInbound(req, makeBotConfig({ webhookSecret: '' }));
    expect(result).toBe(false);
  });

  it('returns false when secrets differ in length', async () => {
    const req = makeRequest('short');
    const result = await handler.verifyInbound(req, makeBotConfig({ webhookSecret: 'much-longer-secret' }));
    expect(result).toBe(false);
  });

  it('returns false for empty string secret when config has value', async () => {
    const req = makeRequest('');
    const result = await handler.verifyInbound(req, makeBotConfig());
    expect(result).toBe(false);
  });

  it('uses timing-safe comparison (same length, different content → false)', async () => {
    const req = makeRequest('aaaaaaaaa');
    const result = await handler.verifyInbound(req, makeBotConfig({ webhookSecret: 'bbbbbbbbb' }));
    expect(result).toBe(false);
  });

  it('getCapabilities returns expected Telegram config', () => {
    const caps = handler.getCapabilities();
    expect(caps.maxMessageLength).toBe(4096);
    expect(caps.requiredConfigKeys).toContain('botToken');
    expect(caps.requiredConfigKeys).toContain('webhookSecret');
  });
});
