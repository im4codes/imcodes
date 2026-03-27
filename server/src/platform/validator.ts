/**
 * Zod schema validation for InboundMessage and OutboundMessage.
 * Used by handlers to validate normalized payloads before routing.
 */
import { z } from 'zod';
import type { InboundMessage, OutboundMessage } from './types.js';

export const InboundMessageSchema = z.object({
  platform: z.string().min(1),
  channelId: z.string().min(1),
  userId: z.string().min(1),
  content: z.string(),
  messageId: z.string().optional(),
  isCommand: z.boolean(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  raw: z.unknown(),
});

export const OutboundMessageSchema = z.object({
  platform: z.string().min(1),
  channelId: z.string().min(1),
  content: z.string().min(1),
  replyToId: z.string().optional(),
  formatting: z.enum(['plain', 'markdown', 'code']).optional(),
});

export function validateInbound(data: unknown): InboundMessage {
  return InboundMessageSchema.parse(data) as InboundMessage;
}

export function validateOutbound(data: unknown): OutboundMessage {
  return OutboundMessageSchema.parse(data) as OutboundMessage;
}

/**
 * Split a long message into chunks respecting a platform's max length.
 * Splits on newlines where possible.
 */
export function splitMessage(content: string, maxLength: number): string[] {
  if (content.length <= maxLength) return [content];

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split on a newline within the window
    const window = remaining.slice(0, maxLength);
    const lastNewline = window.lastIndexOf('\n');
    const splitAt = lastNewline > maxLength / 2 ? lastNewline + 1 : maxLength;

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks.filter((c) => c.length > 0);
}
