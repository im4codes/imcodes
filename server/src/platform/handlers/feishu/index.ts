import type { BotConfig, InboundMessage, OutboundMessage, PlatformCapabilities, PlatformHandler } from '../../types.js';
import { splitMessage } from '../../validator.js';

export class FeishuHandler implements PlatformHandler {
  getCapabilities(): PlatformCapabilities {
    return {
      maxMessageLength: 4000,
      supportsThreadedReplies: true,
      supportsMarkdown: false,
      supportsCodeBlocks: true,
      rateLimitPerMin: 30,
      requiredConfigKeys: ['appId', 'appSecret', 'encryptKey'],
    };
  }

  async verifyInbound(req: Request, config: BotConfig): Promise<boolean> {
    const body = await req.clone().text();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body);
    } catch {
      return false;
    }

    // Feishu challenge (webhook registration) — always allowed
    if (parsed.type === 'url_verification') return true;

    const encryptKey = config.config.encryptKey;
    if (!encryptKey) return false;

    // Feishu signature: SHA-256(encrypt_key + timestamp + nonce + body)
    const timestamp = req.headers.get('X-Lark-Request-Timestamp') ?? '';
    const nonce = req.headers.get('X-Lark-Request-Nonce') ?? '';
    const signature = req.headers.get('X-Lark-Signature') ?? '';

    if (!timestamp || !nonce || !signature) return false;

    // Reject stale requests (replay protection — 5 minute window)
    const tsSeconds = parseInt(timestamp, 10);
    if (isNaN(tsSeconds) || Math.abs(Date.now() / 1000 - tsSeconds) > 300) return false;

    const raw = encryptKey + timestamp + nonce + body;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    const computed = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    return computed === signature;
  }

  async normalizeInbound(req: Request, config: BotConfig): Promise<InboundMessage> {
    const body = await req.json() as FeishuEvent;

    if (body.type === 'url_verification') {
      return {
        platform: 'feishu',
        botId: config.botId,
        channelId: 'challenge',
        userId: 'feishu',
        content: '__challenge__',
        isCommand: false,
        raw: body,
      };
    }

    const event = body.event ?? {};
    const message = event.message ?? {};
    const sender = event.sender ?? {};

    const channelId = message.chat_id ?? '';
    const userId = sender.sender_id?.open_id ?? sender.sender_id?.user_id ?? '';
    const messageId = message.message_id ?? '';

    let text = '';
    try {
      const content = JSON.parse(message.content ?? '{}');
      text = content.text ?? '';
    } catch {
      text = message.content ?? '';
    }

    const cmdMatch = text.match(/^\/([a-z0-9_]+)(?:\s+(.*))?$/i);
    if (cmdMatch) {
      const command = cmdMatch[1].toLowerCase();
      const argStr = (cmdMatch[2] ?? '').trim();
      const args = argStr ? argStr.split(/\s+/) : [];
      return {
        platform: 'feishu',
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
      platform: 'feishu',
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
    const token = await this.getAccessToken(config);
    const caps = this.getCapabilities();
    const chunks = splitMessage(msg.content, caps.maxMessageLength);

    for (const chunk of chunks) {
      const content = msg.formatting === 'code'
        ? JSON.stringify({ zh_cn: { title: '', content: [[{ tag: 'code_block', language: 'plaintext', text: chunk }]] } })
        : JSON.stringify({ text: chunk });

      const msgType = msg.formatting === 'code' ? 'post' : 'text';

      const payload: Record<string, unknown> = {
        receive_id: msg.channelId,
        msg_type: msgType,
        content,
      };

      const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Feishu API error ${res.status}: ${err}`);
      }
    }
  }

  private async getAccessToken(config: BotConfig): Promise<string> {
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: config.config.appId, app_secret: config.config.appSecret }),
    });

    if (!res.ok) throw new Error(`Feishu auth failed: ${res.status}`);
    const data = await res.json() as { tenant_access_token: string };
    return data.tenant_access_token;
  }
}

// ── Feishu API types (minimal) ────────────────────────────────────────────────

interface FeishuEvent {
  type?: string;
  challenge?: string;
  token?: string;
  event?: {
    message?: {
      message_id?: string;
      chat_id?: string;
      message_type?: string;
      content?: string;
    };
    sender?: {
      sender_id?: {
        open_id?: string;
        user_id?: string;
      };
    };
  };
}
