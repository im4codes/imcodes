// ── Per-user bot configuration ─────────────────────────────────────────────

/**
 * Credentials for a single user-registered bot, loaded from platform_bots table.
 * Each platform uses different keys inside `config`:
 *
 *   telegram: { botToken, webhookSecret }
 *   discord:  { botToken, publicKey, appId }
 *   feishu:   { appId, appSecret, encryptKey }
 */
export interface BotConfig {
  botId: string;
  userId: string;
  platform: string;
  config: Record<string, string>;
}

// ── Canonical message types ────────────────────────────────────────────────

export interface InboundMessage {
  platform: string;
  botId: string;
  channelId: string;
  userId: string;
  content: string;
  messageId?: string;
  isCommand: boolean;
  command?: string;
  args?: string[];
  raw: unknown;
}

export interface OutboundMessage {
  platform: string;
  botId: string;
  channelId: string;
  content: string;
  replyToId?: string;
  formatting?: 'plain' | 'markdown' | 'code';
}

// ── Handler contract ──────────────────────────────────────────────────────

export interface PlatformCapabilities {
  maxMessageLength: number;
  supportsThreadedReplies: boolean;
  supportsMarkdown: boolean;
  supportsCodeBlocks: boolean;
  rateLimitPerMin: number;
  requiredConfigKeys: string[];
}

export interface PlatformHandler {
  verifyInbound(req: Request, config: BotConfig): Promise<boolean>;
  normalizeInbound(req: Request, config: BotConfig): Promise<InboundMessage>;
  sendOutbound(msg: OutboundMessage, config: BotConfig): Promise<void>;
  getCapabilities(): PlatformCapabilities;
}
