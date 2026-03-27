/**
 * Format a session/channel label for display.
 *
 * OpenClaw channel labels come as "platform:numericId#channelName" (e.g.
 * "discord:1476187408042033309#general"). The numeric ID is meaningless to
 * the user — strip it and show "discord#general" instead.
 *
 * Also handles colon-separated variant "platform:id:name" → "platform:name".
 */
export function formatLabel(label: string): string {
  // Match "platform:id#name" or "platform:id:name" — strip the numeric ID
  const match = label.match(/^([^:]+):\d+([#:].+)$/);
  if (match) return `${match[1]}${match[2]}`;
  return label;
}
