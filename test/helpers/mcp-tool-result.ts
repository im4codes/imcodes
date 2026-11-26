/** Read an SDK result without assuming a typed tool's error fits its success schema. */
export function mcpToolPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error('missing MCP tool result');
  const result = value as { structuredContent?: unknown; content?: unknown };
  if (result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)) {
    return result.structuredContent as Record<string, unknown>;
  }
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      try {
        const parsed: unknown = JSON.parse(block.text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch { /* Human-readable SDK validation errors are not typed payloads. */ }
    }
  }
  throw new Error('MCP tool result has no structured object or parseable JSON text');
}
