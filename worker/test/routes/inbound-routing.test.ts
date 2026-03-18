/**
 * Tests for inbound routing (routeInbound) and replay protection.
 * Covers the regressions identified in issue review:
 *   1. routeInbound must use findChannelBindingByPlatformChannel (no serverId)
 *   2. Discord timestamp staleness rejects replayed requests
 *   3. Feishu timestamp staleness rejects replayed requests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { routeInbound } from '../../src/routes/outbound.js';
import { DiscordHandler } from '../../src/platform/handlers/discord/index.js';
import { FeishuHandler } from '../../src/platform/handlers/feishu/index.js';
import type { InboundMessage } from '../../src/platform/types.js';
import type { BotConfig } from '../../src/platform/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'telegram',
    botId: 'bot-1',
    channelId: 'ch-1',
    userId: 'u-1',
    content: 'hello',
    isCommand: false,
    ...overrides,
  };
}

function makeDiscordConfig(overrides: Partial<Record<string, string>> = {}): BotConfig {
  return {
    botId: 'bot-discord',
    userId: 'user-1',
    platform: 'discord',
    config: {
      botToken: 'Bot tok',
      publicKey: 'aabbccdd'.repeat(8),
      ...overrides,
    },
  };
}

function makeFeishuConfig(overrides: Partial<Record<string, string>> = {}): BotConfig {
  return {
    botId: 'bot-fs',
    userId: 'user-1',
    platform: 'feishu',
    config: {
      appId: 'app-id',
      appSecret: 'app-secret',
      encryptKey: 'enc-key',
      ...overrides,
    },
  };
}

// ── routeInbound: uses platform+channelId+botId for deterministic routing ─────

describe('routeInbound()', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('scopes binding lookup by platform + channelId + botId (deterministic routing)', async () => {
    const binding = { id: 'b1', server_id: 'srv-1', platform: 'telegram', channel_id: 'ch-1', bot_id: 'bot-1' };
    const mockFirst = vi.fn().mockResolvedValue(binding);
    const mockBind = vi.fn().mockReturnValue({ first: mockFirst });
    const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind });
    const mockFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    const env = {
      DB: { prepare: mockPrepare } as unknown as D1Database,
      DAEMON_BRIDGE: {
        idFromName: vi.fn().mockReturnValue('do-id'),
        get: vi.fn().mockReturnValue({ fetch: mockFetch }),
      } as unknown as DurableObjectNamespace,
    };

    await routeInbound(makeMsg({ botId: 'bot-1' }), env as never, 'bot-1');

    // DB query must use botId for deterministic binding resolution
    expect(mockBind).toHaveBeenCalledWith('telegram', 'ch-1', 'bot-1');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('silently returns when no binding found for this bot', async () => {
    const mockFirst = vi.fn().mockResolvedValue(null);
    const mockBind = vi.fn().mockReturnValue({ first: mockFirst });
    const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind });
    const mockFetch = vi.fn();

    const env = {
      DB: { prepare: mockPrepare } as unknown as D1Database,
      DAEMON_BRIDGE: { idFromName: vi.fn(), get: vi.fn() } as unknown as DurableObjectNamespace,
    };

    await routeInbound(makeMsg({ botId: 'bot-1' }), env as never, 'bot-1');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── Discord replay protection ─────────────────────────────────────────────────

describe('DiscordHandler replay protection', () => {
  let handler: DiscordHandler;

  beforeEach(() => {
    handler = new DiscordHandler();
    vi.unstubAllGlobals();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('rejects request with timestamp older than 5 minutes', async () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - 400); // 400s ago
    vi.stubGlobal('crypto', {
      subtle: {
        importKey: vi.fn().mockResolvedValue({}),
        verify: vi.fn().mockResolvedValue(true), // valid sig, but stale
      },
      getRandomValues: crypto.getRandomValues.bind(crypto),
    });
    const req = new Request('https://x', {
      method: 'POST',
      headers: { 'X-Signature-Ed25519': 'aabbccdd'.repeat(8), 'X-Signature-Timestamp': staleTs },
      body: '{"type":1}',
    });
    expect(await handler.verifyInbound(req, makeDiscordConfig())).toBe(false);
  });

  it('accepts request with timestamp within 5 minutes', async () => {
    const freshTs = String(Math.floor(Date.now() / 1000) - 60); // 60s ago
    vi.stubGlobal('crypto', {
      subtle: {
        importKey: vi.fn().mockResolvedValue({}),
        verify: vi.fn().mockResolvedValue(true),
      },
      getRandomValues: crypto.getRandomValues.bind(crypto),
    });
    const req = new Request('https://x', {
      method: 'POST',
      headers: { 'X-Signature-Ed25519': 'aabbccdd'.repeat(8), 'X-Signature-Timestamp': freshTs },
      body: '{"type":1}',
    });
    expect(await handler.verifyInbound(req, makeDiscordConfig())).toBe(true);
  });

  it('rejects non-numeric timestamp', async () => {
    const req = new Request('https://x', {
      method: 'POST',
      headers: { 'X-Signature-Ed25519': 'aabbccdd'.repeat(8), 'X-Signature-Timestamp': 'not-a-number' },
      body: '{}',
    });
    expect(await handler.verifyInbound(req, makeDiscordConfig())).toBe(false);
  });
});

// ── Feishu replay protection ──────────────────────────────────────────────────

describe('FeishuHandler replay protection', () => {
  let handler: FeishuHandler;

  beforeEach(() => { handler = new FeishuHandler(); });

  it('rejects request with timestamp older than 5 minutes', async () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - 400);
    const req = new Request('https://x', {
      method: 'POST',
      headers: {
        'X-Lark-Request-Timestamp': staleTs,
        'X-Lark-Request-Nonce': 'nonce123',
        'X-Lark-Signature': 'any-sig',
      },
      body: JSON.stringify({ schema: '2.0', header: {} }),
    });
    // Stale timestamp should be rejected before sig check
    expect(await handler.verifyInbound(req, makeFeishuConfig())).toBe(false);
  });

  it('rejects non-numeric timestamp', async () => {
    const req = new Request('https://x', {
      method: 'POST',
      headers: {
        'X-Lark-Request-Timestamp': 'bad-ts',
        'X-Lark-Request-Nonce': 'nonce',
        'X-Lark-Signature': 'sig',
      },
      body: '{}',
    });
    expect(await handler.verifyInbound(req, makeFeishuConfig())).toBe(false);
  });
});
