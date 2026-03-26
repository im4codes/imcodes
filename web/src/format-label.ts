/**
 * Format a session/channel label for display.
 *
 * OpenClaw channel labels come as "platform:numericId:channelName" (e.g.
 * "discord:1234567890:general"). The numeric ID is meaningless to the user —
 * strip it and show "discord:general" instead.
 */
export function formatLabel(label: string): string {
  // Match "platform:id:name" pattern — strip the middle segment (ID)
  const match = label.match(/^([^:]+):[^:]+:(.+)$/);
  if (match) return `${match[1]}:${match[2]}`;
  return label;
}
