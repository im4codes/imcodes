import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuHandler } from '../../../src/platform/handlers/feishu/index.js';
import type { BotConfig } from '../../../src/platform/types.js';

const makeBotConfig = (overrides: Partial<Record<string, string>> = {}): BotConfig => ({
  botId: 'bot-fs',
  userId: 'user-1',
  platform: 'feishu',
  config: {
    appId: 'app-id',
    appSecret: 'app-secret',
    encryptKey: 'encrypt-key',
    ...overrides,
  },
});

describe('FeishuHandler', () => {
  let handler: FeishuHandler;

  beforeEach(() => {
    handler = new FeishuHandler();
  });

  describe('getCapabilities()', () => {
    it('returns valid capabilities', () => {
      const caps = handler.getCapabilities();
      expect(caps.maxMessageLength).toBe(4000);
      expect(caps.requiredConfigKeys).toContain('appId');
      expect(caps.requiredConfigKeys).toContain('appSecret');
      expect(caps.requiredConfigKeys).toContain('encryptKey');
    });
  });

  describe('verifyInbound()', () => {
    it('accepts url_verification challenge without signature', async () => {
      const req = new Request('https://x', {
        method: 'POST',
        body: JSON.stringify({ type: 'url_verification', challenge: 'abc' }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(await handler.verifyInbound(req, makeBotConfig())).toBe(true);
    });

    it('rejects non-challenge request without signature headers', async () => {
      const req = new Request('https://x', {
        method: 'POST',
        body: JSON.stringify({ schema: '2.0', header: {}, event: {} }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(await handler.verifyInbound(req, makeBotConfig())).toBe(false);
    });
  });

  describe('normalizeInbound()', () => {
    it('returns challenge message for url_verification', async () => {
      const req = new Request('https://x', {
        method: 'POST',
        body: JSON.stringify({ type: 'url_verification', challenge: 'test-challenge' }),
        headers: { 'Content-Type': 'application/json' },
      });
      const msg = await handler.normalizeInbound(req, makeBotConfig());
      expect(msg.platform).toBe('feishu');
      expect(msg.botId).toBe('bot-fs');
      expect(msg.content).toBe('__challenge__');
      expect(msg.channelId).toBe('challenge');
    });

    it('normalizes a text message event', async () => {
      const req = new Request('https://x', {
        method: 'POST',
        body: JSON.stringify({
          schema: '2.0',
          event: {
            message: { message_id: 'om_abc', chat_id: 'oc_group1', message_type: 'text', content: JSON.stringify({ text: 'hello feishu' }) },
            sender: { sender_id: { open_id: 'ou_user1' } },
          },
        }),
        headers: { 'Content-Type': 'application/json' },
      });
      const msg = await handler.normalizeInbound(req, makeBotConfig());
      expect(msg.platform).toBe('feishu');
      expect(msg.botId).toBe('bot-fs');
      expect(msg.channelId).toBe('oc_group1');
      expect(msg.userId).toBe('ou_user1');
      expect(msg.content).toBe('hello feishu');
      expect(msg.isCommand).toBe(false);
    });

    it('detects /commands in message text', async () => {
      const req = new Request('https://x', {
        method: 'POST',
        body: JSON.stringify({
          schema: '2.0',
          event: {
            message: { message_id: 'om_cmd', chat_id: 'oc_group2', message_type: 'text', content: JSON.stringify({ text: '/send hello world' }) },
            sender: { sender_id: { open_id: 'ou_user2' } },
          },
        }),
        headers: { 'Content-Type': 'application/json' },
      });
      const msg = await handler.normalizeInbound(req, makeBotConfig());
      expect(msg.isCommand).toBe(true);
      expect(msg.command).toBe('send');
      expect(msg.args).toEqual(['hello', 'world']);
    });
  });

  describe('sendOutbound()', () => {
    it('fetches tenant token then sends message', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ tenant_access_token: 'tok-123' }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0 }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await handler.sendOutbound(
        { platform: 'feishu', botId: 'bot-fs', channelId: 'oc_group1', content: 'hello' },
        makeBotConfig(),
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [authUrl] = fetchMock.mock.calls[0];
      expect(authUrl).toContain('tenant_access_token/internal');
      const [msgUrl, msgOpts] = fetchMock.mock.calls[1];
      expect(msgUrl).toContain('/im/v1/messages');
      expect(JSON.parse((msgOpts as RequestInit).body as string).receive_id).toBe('oc_group1');
      vi.unstubAllGlobals();
    });
  });
});
