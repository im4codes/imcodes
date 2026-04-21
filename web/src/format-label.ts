/**
 * Format a session/channel label for display.
 *
 * OpenClaw channel labels come as "platform:numericId#channelName" (e.g.
 * "discord:1476187408042033309#general"). The numeric ID is meaningless to
 * the user — strip it and show "discord#general" instead.
 *
 * Also handles colon-separated variant "platform:id:name" → "platform:name".
 */
import { normalizeLegacyAutoSessionLabel } from './agent-display.js';

export function formatLabel(label: string): string {
  // Match "platform:id#name" or "platform:id:name" — strip the numeric ID
  const match = label.match(/^([^:]+):\d+([#:].+)$/);
  const normalized = match ? `${match[1]}${match[2]}` : label;
  return normalizeLegacyAutoSessionLabel(normalized);
}
