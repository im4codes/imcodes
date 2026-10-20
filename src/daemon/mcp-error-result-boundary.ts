import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { safeParseAsync } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const installed = new WeakSet<McpServer>();

/**
 * The SDK server skips output validation for isError, but its Client validates
 * every present structuredContent against the advertised outputSchema. Preserve
 * errors the schema can represent; carry other typed refusals as JSON text only.
 * Successes, untyped tools, schemas and SDK validation are deliberately untouched.
 */
async function compatibleErrorResult(result: unknown, schema: RegisteredTool['outputSchema']): Promise<unknown> {
  if (!schema || !result || typeof result !== 'object' || Array.isArray(result)) return result;
  const value = result as CallToolResult;
  if (value.isError !== true || value.structuredContent === undefined) return result;
  if ((await safeParseAsync(schema, value.structuredContent)).success) return result;

  const { structuredContent, ...error } = value;
  const text = JSON.stringify(structuredContent);
  // Existing result helpers already emit this block. Preserve other content,
  // adding the typed JSON only if a handler did not put it in text itself.
  if (!error.content.some((block) => block.type === 'text' && block.text === text)) {
    error.content = [...error.content, { type: 'text', text }];
  }
  return error;
}

/**
 * Install BEFORE registration guards so their refusals cross this same boundary.
 * The returned RegisteredTool.handler is adapted too: exact discovery fallback
 * cannot bypass it. Read the registered schema at call time (including updates).
 * Idempotent for both the aggregate server and independently used registrars.
 */
export function installMcpErrorResultBoundary(server: McpServer): void {
  if (installed.has(server)) return;
  installed.add(server);
  const original = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: unknown, callback: (...args: unknown[]) => unknown) => {
    let tool: RegisteredTool;
    const adapted = async (...args: unknown[]) => compatibleErrorResult(await callback(...args), tool.outputSchema);
    tool = original(name, config as Parameters<typeof original>[1], adapted as Parameters<typeof original>[2]);
    return tool;
  }) as typeof server.registerTool;
}
