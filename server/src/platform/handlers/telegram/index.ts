import type { BotConfig, InboundMessage, OutboundMessage, PlatformCapabilities, PlatformHandler } from '../../types.js';
import { splitMessage } from '../../validator.js';

export class TelegramHandler implements PlatformHandler {
  getCapabilities(): PlatformCapabilities {
    return {
      maxMessageLength: 4096,
      supportsThreadedReplies: true,
      supportsMarkdown: true,
      supportsCodeBlocks: true,
      rateLimitPerMin: 30,
      requiredConfigKeys: ['botToken', 'webhookSecret'],
    };
  }

  async verifyInbound(req: Request, config: BotConfig): Promise<boolean> {
    const secret = req.headers.get('X-Telegram-Bot-Api-Secret-Token');
    const expected = config.config.webhookSecret;
    if (!secret || !expected) return false;

    // Timing-safe comparison
    const a = new TextEncoder().encode(secret);
    const b = new TextEncoder().encode(expected);
    if (a.length !== b.length) return false;

    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a[i] ^ b[i];
    }
    return result === 0;
  }

  async normalizeInbound(req: Request, config: BotConfig): Promise<InboundMessage> {
    const body = await req.json() as TelegramUpdate;

    const message = body.message ?? body.edited_message ?? body.channel_post;
    if (!message) {
      return {
        platform: 'telegram',
        botId: config.botId,
        channelId: String(body.message?.chat?.id ?? 'unknown'),
        userId: 'unknown',
        content: '',
        isCommand: false,
        raw: body,
      };
    }

    const channelId = String(message.chat.id);
    const userId = String(message.from?.id ?? message.chat.id);
    const text = message.text ?? message.caption ?? '';
    const messageId = String(message.message_id);

    // Detect commands: /command[@botname] args
    const cmdMatch = text.match(/^\/([a-z0-9_]+)(?:@\S+)?(?:\s+(.*))?$/i);
    if (cmdMatch) {
      const command = cmdMatch[1].toLowerCase();
      const argStr = (cmdMatch[2] ?? '').trim();
      const args = argStr ? argStr.split(/\s+/) : [];
      return {
        platform: 'telegram',
        botId: config.botId,
        channelId,
        userId,
        content: argStr,
        messageId,
        isCommand: true,
        command,
        args,
        raw: body,
      };
    }

    return {
      platform: 'telegram',
      botId: config.botId,
      channelId,
      userId,
      content: text,
      messageId,
      isCommand: false,
      raw: body,
    };
  }

  async sendOutbound(msg: OutboundMessage, config: BotConfig): Promise<void> {
    const botToken = config.config.botToken;
    const caps = this.getCapabilities();
    const chunks = splitMessage(msg.content, caps.maxMessageLength);
    const parseMode = msg.formatting === 'markdown' || msg.formatting === 'code' ? 'MarkdownV2' : undefined;

    for (const chunk of chunks) {
      const payload: Record<string, unknown> = {
        chat_id: msg.channelId,
        text: parseMode ? escapeMarkdownV2(chunk) : chunk,
      };
      if (parseMode) payload.parse_mode = parseMode;
      if (msg.replyToId) payload.reply_to_message_id = msg.replyToId;

      const res = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Telegram API error ${res.status}: ${err}`);
      }
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!\\\-]/g, '\\$&');
}

// ── Telegram API types (minimal) ──────────────────────────────────────────────

interface TelegramMessage {
  message_id: number;
  from?: { id: number; username?: string };
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
}
