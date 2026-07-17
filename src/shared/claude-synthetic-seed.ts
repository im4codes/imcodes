export const CLAUDE_SYNTHETIC_SEED_MODEL = '<synthetic>';
export const CLAUDE_SYNTHETIC_SEED_TEXT = 'No response requested.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSyntheticSeedContent(content: unknown): boolean {
  if (content === CLAUDE_SYNTHETIC_SEED_TEXT) return true;
  if (!Array.isArray(content) || content.length !== 1) return false;
  const block = content[0];
  return isRecord(block)
    && block.type === 'text'
    && block.text === CLAUDE_SYNTHETIC_SEED_TEXT;
}

/**
 * IM.codes creates a minimal Claude transcript seed so `claude --resume <uuid>`
 * has a valid landing point before the first real turn.  That line is for the
 * Claude CLI only and must never be projected as a user-visible assistant turn.
 */
export function isClaudeSyntheticSeedAssistant(raw: Record<string, unknown>): boolean {
  if (raw.type !== 'assistant') return false;
  const message = raw.message;
  if (!isRecord(message)) return false;
  return message.model === CLAUDE_SYNTHETIC_SEED_MODEL
    && isSyntheticSeedContent(message.content);
}

/**
 * Compatibility filter for already-persisted transport/timeline rows emitted
 * before the JSONL parser learned to suppress the synthetic seed line.
 */
export function isClaudeSyntheticSeedAssistantTextEvent(event: Record<string, unknown>): boolean {
  if (event.type !== 'assistant.text') return false;
  const directText = event.text;
  const payload = event.payload;
  const payloadText = isRecord(payload) ? payload.text : undefined;
  const text = typeof directText === 'string' ? directText : payloadText;
  if (text !== CLAUDE_SYNTHETIC_SEED_TEXT) return false;
  const streaming = isRecord(payload) ? payload.streaming : event.streaming;
  return streaming !== true;
}
