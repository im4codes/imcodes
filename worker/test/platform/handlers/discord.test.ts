import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscordHandler } from '../../../src/platform/handlers/discord/index.js';
import type { BotConfig } from '../../../src/platform/types.js';

const makeBotConfig = (overrides: Partial<Record<string, string>> = {}): BotConfig => ({
  botId: 'bot-1',
  userId: 'user-1',
  platform: 'discord',
  config: {
    botToken: 'Bot test-token',
    publicKey: '4b7d8ab2f1a3c6e509b1d0e2f3a4c7b8d5e6f9a0b1c2d3e4f5a6b7c8d9e0f1a2',
    appId: '123456789',
    ...overrides,
  },
});

describe('DiscordHandler', () => {
  let handler: DiscordHandler;

  beforeEach(() => {
    handler = new DiscordHandler();
  });

  describe('getCapabilities()', () => {
    it('returns valid capabilities', () => {
      const caps = handler.getCapabilities();
      expect(caps.maxMessageLength).toBe(2000);
      expect(caps.supportsMarkdown).toBe(true);
      expect(caps.supportsThreadedReplies).toBe(true);
      expect(caps.requiredConfigKeys).toContain('publicKey');
      expect(caps.requiredConfigKeys).toContain('botToken');
    });
  });

  describe('verifyInbound()', () => {
    it('rejects request missing headers', async () => {
      const req = new Request('https://example.com/webhook/discord/bot-1', {
        method: 'POST',
        body: '{}',
      });
      const result = await handler.verifyInbound(req, makeBotConfig());
      expect(result).toBe(false);
    });

    it('rejects request with invalid signature format', async () => {
      const req = new Request('https://example.com/webhook/discord/bot-1', {
        method: 'POST',
        headers: {
          'X-Signature-Ed25519': 'not-hex',
          'X-Signature-Timestamp': '1234567890',
        },
        body: '{}',
      });
      const result = await handler.verifyInbound(req, makeBotConfig());
      expect(result).toBe(false);
    });

    it('returns false for invalid/garbage signature values', async () => {
      const req = new Request('https://example.com/webhook/discord/bot-1', {
        method: 'POST',
        headers: {
          'X-Signature-Ed25519': 'aaaa'.repeat(16),
          'X-Signature-Timestamp': '1234567890',
        },
        body: '{"type":1}',
      });
      const result = await handler.verifyInbound(req, makeBotConfig());
      expect(result).toBe(false);
    });

    it('returns true when crypto.subtle.verify returns true', async () => {
      vi.stubGlobal('crypto', {
        subtle: {
          importKey: vi.fn().mockResolvedValue({}),
          verify: vi.fn().mockResolvedValue(true),
        },
        getRandomValues: crypto.getRandomValues.bind(crypto),
      });
      const req = new Request('https://example.com/webhook/discord/bot-1', {
        method: 'POST',
        headers: {
          'X-Signature-Ed25519': 'aabbccdd'.repeat(8),
          'X-Signature-Timestamp': String(Math.floor(Date.now() / 1000)),
        },
        body: '{"type":1}',
      });
      expect(await handler.verifyInbound(req, makeBotConfig())).toBe(true);
      vi.unstubAllGlobals();
    });

    it('returns false if crypto.subtle.importKey throws', async () => {
      vi.stubGlobal('crypto', {
        subtle: {
          importKey: vi.fn().mockRejectedValue(new Error('bad key')),
          verify: vi.fn(),
        },
        getRandomValues: crypto.getRandomValues.bind(crypto),
      });
      const req = new Request('https://example.com/webhook/discord/bot-1', {
        method: 'POST',
        headers: {
          'X-Signature-Ed25519': 'aabbccdd'.repeat(8),
          'X-Signature-Timestamp': '1234567890',
        },
        body: '{}',
      });
      expect(await handler.verifyInbound(req, makeBotConfig())).toBe(false);
      vi.unstubAllGlobals();
    });
  });

  describe('normalizeInbound()', () => {
    it('returns ping message for PING type', async () => {
      const req = new Request('https://example.com', {
        method: 'POST',
        body: JSON.stringify({ type: 1, id: 'test-id' }),
        headers: { 'Content-Type': 'application/json' },
      });
      const msg = await handler.normalizeInbound(req, makeBotConfig());
      expect(msg.platform).toBe('discord');
      expect(msg.content).toBe('__ping__');
      expect(msg.botId).toBe('bot-1');
      expect(msg.isCommand).toBe(false);
    });

    it('normalizes slash command interaction', async () => {
      const req = new Request('https://example.com', {
        method: 'POST',
        body: JSON.stringify({
          type: 2,
          id: 'interaction-123',
          guild_id: 'guild-456',
          channel_id: 'channel-789',
          member: { user: { id: 'user-111' } },
          data: { name: 'send', options: [{ name: 'message', value: 'hello world' }] },
        }),
        headers: { 'Content-Type': 'application/json' },
      });
      const msg = await handler.normalizeInbound(req, makeBotConfig());
      expect(msg.isCommand).toBe(true);
      expect(msg.command).toBe('send');
      expect(msg.channelId).toBe('guild-456:channel-789');
      expect(msg.userId).toBe('user-111');
      expect(msg.botId).toBe('bot-1');
    });

    it('uses composite channelId when guild present', async () => {
      const req = new Request('https://x', {
        method: 'POST',
        body: JSON.stringify({
          type: 2, id: 'x', guild_id: 'G1', channel_id: 'C1',
          member: { user: { id: 'U1' } }, data: { name: 'status', options: [] },
        }),
        headers: { 'Content-Type': 'application/json' },
      });
      const msg = await handler.normalizeInbound(req, makeBotConfig());
      expect(msg.channelId).toBe('G1:C1');
    });
  });

  describe('sendOutbound()', () => {
    it('calls Discord API with correct endpoint', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await handler.sendOutbound(
        { platform: 'discord', botId: 'bot-1', channelId: 'channel-789', content: 'Hello!', formatting: 'plain' },
        makeBotConfig(),
      );

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toContain('discord.com/api/v10/channels/channel-789/messages');
      expect((opts as RequestInit).method).toBe('POST');
      vi.unstubAllGlobals();
    });

    it('splits long messages into multiple API calls', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await handler.sendOutbound(
        { platform: 'discord', botId: 'bot-1', channelId: 'channel-789', content: 'x'.repeat(4500) },
        makeBotConfig(),
      );

      expect(fetchMock).toHaveBeenCalledTimes(3);
      vi.unstubAllGlobals();
    });

    it('throws on API error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Forbidden', { status: 403 })));
      await expect(
        handler.sendOutbound({ platform: 'discord', botId: 'bot-1', channelId: 'c', content: 'hi' }, makeBotConfig()),
      ).rejects.toThrow('Discord API error 403');
      vi.unstubAllGlobals();
    });
  });
});
