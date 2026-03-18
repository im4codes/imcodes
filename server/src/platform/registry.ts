import type { PlatformHandler } from './types.js';
import { DiscordHandler } from './handlers/discord/index.js';
import { TelegramHandler } from './handlers/telegram/index.js';
import { FeishuHandler } from './handlers/feishu/index.js';

// Static map — all handlers bundled at deploy time
const HANDLERS: Record<string, PlatformHandler> = {
  discord: new DiscordHandler(),
  telegram: new TelegramHandler(),
  feishu: new FeishuHandler(),
};

/**
 * Returns the handler for the given platform key, or undefined if not found.
 */
export function getHandler(platform: string): PlatformHandler | undefined {
  return HANDLERS[platform.toLowerCase()];
}

/**
 * Returns all registered platform keys.
 */
export function listPlatforms(): string[] {
  return Object.keys(HANDLERS);
}
