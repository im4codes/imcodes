import type { BotConfig, InboundMessage, OutboundMessage, PlatformCapabilities, PlatformHandler } from '../../types.js';
import { splitMessage } from '../../validator.js';

// Discord interaction types
const PING = 1;
const APPLICATION_COMMAND = 2;

// Discord response types
const PONG = 1;
const CHANNEL_MESSAGE_WITH_SOURCE = 4;

void PONG; void CHANNEL_MESSAGE_WITH_SOURCE; void APPLICATION_COMMAND;

export class DiscordHandler implements PlatformHandler {
  getCapabilities(): PlatformCapabilities {
    return {
      maxMessageLength: 2000,
      supportsThreadedReplies: true,
      supportsMarkdown: true,
      supportsCodeBlocks: true,
      rateLimitPerMin: 30,
      requiredConfigKeys: ['botToken', 'publicKey'],
    };
  }

  async verifyInbound(req: Request, config: BotConfig): Promise<boolean> {
    const signature = req.headers.get('X-Signature-Ed25519');
    const timestamp = req.headers.get('X-Signature-Timestamp');

    if (!signature || !timestamp) return false;

    // Reject stale requests (replay protection — 5 minute window)
    const tsSeconds = parseInt(timestamp, 10);
    if (isNaN(tsSeconds) || Math.abs(Date.now() / 1000 - tsSeconds) > 300) return false;

    const publicKey = config.config.publicKey;
    if (!publicKey) return false;

    const body = await req.clone().text();
    const message = timestamp + body;

    try {
      const publicKeyBytes = hexToBytes(publicKey);
      const signatureBytes = hexToBytes(signature);
      const messageBytes = new TextEncoder().encode(message);

      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        publicKeyBytes,
        { name: 'Ed25519' },
        false,
        ['verify'],
      );

      return await crypto.subtle.verify('Ed25519', cryptoKey, signatureBytes, messageBytes);
    } catch {
      return false;
    }
  }

  async normalizeInbound(req: Request, config: BotConfig): Promise<InboundMessage> {
    const body = await req.json<DiscordInteraction>();

    // Discord sends a PING during webhook registration
    if (body.type === PING) {
      return {
        platform: 'discord',
        botId: config.botId,
        channelId: 'ping',
        userId: 'discord',
        content: '__ping__',
        isCommand: false,
        raw: body,
      };
    }

    const channelId = body.channel_id ?? body.channel?.id ?? '';
    const userId = body.member?.user?.id ?? body.user?.id ?? '';
    const guildId = body.guild_id;

    if (body.type === 2 /* APPLICATION_COMMAND */) {
      const cmdName = body.data?.name ?? '';
      const options = body.data?.options ?? [];
      const args = options.map((o: { value: unknown }) => String(o.value));
      const content = args.join(' ');

      return {
        platform: 'discord',
        botId: config.botId,
        channelId: guildId ? `${guildId}:${channelId}` : channelId,
        userId,
        content,
        messageId: body.id,
        isCommand: true,
        command: cmdName,
        args,
        raw: body,
      };
    }

    const content = body.data?.custom_id ?? body.message?.content ?? '';
    return {
      platform: 'discord',
      botId: config.botId,
      channelId: guildId ? `${guildId}:${channelId}` : channelId,
      userId,
      content,
      messageId: body.id,
      isCommand: false,
      raw: body,
    };
  }

  async sendOutbound(msg: OutboundMessage, config: BotConfig): Promise<void> {
    const channelId = msg.channelId.includes(':') ? msg.channelId.split(':')[1] : msg.channelId;
    const caps = this.getCapabilities();
    const chunks = splitMessage(msg.content, caps.maxMessageLength);

    for (const chunk of chunks) {
      const payload: Record<string, unknown> = { content: chunk };
      if (msg.replyToId) {
        payload.message_reference = { message_id: msg.replyToId };
      }

      const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${config.config.botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Discord API error ${res.status}: ${err}`);
      }
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const len = hex.length / 2;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ── Discord API types (minimal) ───────────────────────────────────────────────

interface DiscordInteraction {
  id: string;
  type: number;
  guild_id?: string;
  channel_id?: string;
  channel?: { id: string };
  member?: { user?: { id: string } };
  user?: { id: string };
  message?: { content: string };
  data?: {
    name?: string;
    custom_id?: string;
    options?: Array<{ name: string; value: unknown }>;
  };
}
