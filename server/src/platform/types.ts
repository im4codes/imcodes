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
  platform: string;          // 'discord' | 'telegram' | 'feishu'
  botId: string;             // which registered bot received this (for outbound routing)
  channelId: string;         // channel/chat/group identifier
  userId: string;            // platform user id
  content: string;           // plain text message
  messageId?: string;        // platform message id (for threading)
  isCommand: boolean;        // true for slash commands
  command?: string;          // command name without slash
  args?: string[];           // command arguments
  raw: unknown;              // original platform payload
}

export interface OutboundMessage {
  platform: string;
  botId: string;             // which registered bot to send via
  channelId: string;
  content: string;
  replyToId?: string;        // for threaded replies
  formatting?: 'plain' | 'markdown' | 'code';
}

// ── Handler contract ──────────────────────────────────────────────────────

export interface PlatformCapabilities {
  maxMessageLength: number;
  supportsThreadedReplies: boolean;
  supportsMarkdown: boolean;
  supportsCodeBlocks: boolean;
  rateLimitPerMin: number;
  requiredConfigKeys: string[];  // keys required in BotConfig.config
}

export interface PlatformHandler {
  /** Verify the inbound request signature using per-bot credentials. Returns false → 401. */
  verifyInbound(req: Request, config: BotConfig): Promise<boolean>;

  /** Normalize platform payload into canonical InboundMessage. */
  normalizeInbound(req: Request, config: BotConfig): Promise<InboundMessage>;

  /** Deliver an OutboundMessage to the platform REST API using per-bot credentials. */
  sendOutbound(msg: OutboundMessage, config: BotConfig): Promise<void>;

  /** Declare handler capabilities and required config keys. */
  getCapabilities(): PlatformCapabilities;
}
