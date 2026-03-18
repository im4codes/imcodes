import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramHandler } from '../../../src/platform/handlers/telegram/index.js';
import type { BotConfig } from '../../../src/platform/types.js';

const makeBotConfig = (overrides: Partial<Record<string, string>> = {}): BotConfig => ({
  botId: 'bot-tg',
  userId: 'user-1',
  platform: 'telegram',
  config: {
    botToken: 'tg-bot-token',
    webhookSecret: 'super-secret',
    ...overrides,
  },
});

describe('TelegramHandler', () => {
  let handler: TelegramHandler;

  beforeEach(() => {
    handler = new TelegramHandler();
  });

  describe('getCapabilities()', () => {
    it('returns valid capabilities', () => {
      const caps = handler.getCapabilities();
      expect(caps.maxMessageLength).toBe(4096);
      expect(caps.requiredConfigKeys).toContain('botToken');
      expect(caps.requiredConfigKeys).toContain('webhookSecret');
    });
  });

  describe('verifyInbound()', () => {
    it('accepts request with correct secret', async () => {
      const req = new Request('https://x', {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': 'super-secret' },
        body: '{}',
      });
      expect(await handler.verifyInbound(req, makeBotConfig())).toBe(true);
    });

    it('rejects request with wrong secret', async () => {
      const req = new Request('https://x', {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret' },
        body: '{}',
      });
      expect(await handler.verifyInbound(req, makeBotConfig())).toBe(false);
    });

    it('rejects request with no secret header', async () => {
      const req = new Request('https://x', { method: 'POST', body: '{}' });
      expect(await handler.verifyInbound(req, makeBotConfig())).toBe(false);
    });

    it('rejects when config has no webhookSecret', async () => {
      const req = new Request('https://x', {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': 'some-secret' },
        body: '{}',
      });
      expect(await handler.verifyInbound(req, makeBotConfig({ webhookSecret: '' }))).toBe(false);
    });
  });

  describe('normalizeInbound()', () => {
    it('normalizes a plain text message', async () => {
      const req = new Request('https://x', {
        method: 'POST',
        body: JSON.stringify({
          update_id: 1,
          message: { message_id: 42, from: { id: 111 }, chat: { id: -100, type: 'group' }, text: 'hello world' },
        }),
        headers: { 'Content-Type': 'application/json' },
      });
      const msg = await handler.normalizeInbound(req, makeBotConfig());
      expect(msg.platform).toBe('telegram');
      expect(msg.botId).toBe('bot-tg');
      expect(msg.channelId).toBe('-100');
      expect(msg.userId).toBe('111');
      expect(msg.content).toBe('hello world');
      expect(msg.isCommand).toBe(false);
    });

    it('detects /commands', async () => {
      const req = new Request('https://x', {
        method: 'POST',
        body: JSON.stringify({
          update_id: 2,
          message: { message_id: 43, from: { id: 222 }, chat: { id: 999, type: 'private' }, text: '/start my-project' },
        }),
        headers: { 'Content-Type': 'application/json' },
      });
      const msg = await handler.normalizeInbound(req, makeBotConfig());
      expect(msg.isCommand).toBe(true);
      expect(msg.command).toBe('start');
      expect(msg.args).toEqual(['my-project']);
    });
  });

  describe('sendOutbound()', () => {
    it('calls Telegram Bot API', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await handler.sendOutbound(
        { platform: 'telegram', botId: 'bot-tg', channelId: '-100', content: 'hi' },
        makeBotConfig(),
      );

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('api.telegram.org/bot');
      expect(url).toContain('/sendMessage');
      vi.unstubAllGlobals();
    });
  });
});
