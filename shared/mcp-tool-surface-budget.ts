/**
 * Dual budget for the published MCP tools/list surface.
 *
 * Two numbers, because they answer different questions:
 *
 * - AUTHORED: the bytes we actually write and control — every tool description,
 *   schema, and enum. This is the number a reviewer can act on, and the one that
 *   must not silently drift upward.
 * - RAW: the literal tools/list payload on the wire, including framing that the
 *   MCP SDK and the JSON Schema dialect inject for us and that `registerTool`
 *   offers no supported way to suppress. It is bounded too, so protocol growth
 *   cannot hide behind the authored figure.
 *
 * The authored projection excludes ONLY the two injected shapes named below.
 * That exactness is the whole point: a projection allowed to drop arbitrary
 * fields would let real authored bytes vanish from the budget, which is exactly
 * the "make the number go down" failure this is meant to prevent. Callers get
 * the removal log back so a test can assert nothing else was ever dropped.
 */

/** Emitted per-schema by zod-to-json-schema; a dialect declaration, not content. */
export const MCP_INJECTED_SCHEMA_DIALECT = 'http://json-schema.org/draft-07/schema#';

/** Injected per-tool by the MCP SDK. `forbidden` is already the protocol default. */
export const MCP_INJECTED_EXECUTION_BLOCK = Object.freeze({ taskSupport: 'forbidden' });

export const MCP_TOOL_SURFACE_AUTHORED_BUDGET_BYTES = 40_000;
export const MCP_TOOL_SURFACE_RAW_BUDGET_BYTES = 45_000;
/**
 * Default model-visible surface: the discovery tool plus the core delegation /
 * supervision-task / memory tools listed in MCP_TOOL_DISCOVERY_DEFAULT_ACTIVE.
 *
 * Core tools are deliberately NOT lazy: hiding them would make every agent
 * depend on a discovery round-trip first, and any client holding a cached tool
 * list would get `Tool <name> disabled` instead. Memory, aliases and cron are core too, so the
 * default set is 39 tools measuring 27,117 bytes against a 36,700 full catalog:
 * a 26% reduction, not the 69% a minimal core would give. That trade is
 * deliberate -- a half-lazy memory or scheduling API is worse than none, because
 * the model cannot tell which half it currently has.
 */
export const MCP_TOOL_SURFACE_BOOTSTRAP_BUDGET_BYTES = 28_000;

export interface McpSurfaceRemoval {
  /** Dotted path of the containing object, for diagnosis when an assert fails. */
  path: string;
  key: string;
  value: unknown;
}

export interface McpSurfaceProjection {
  authored: unknown;
  removed: McpSurfaceRemoval[];
}

function isInjectedExecutionBlock(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== 'taskSupport') return false;
  return (value as { taskSupport?: unknown }).taskSupport === MCP_INJECTED_EXECUTION_BLOCK.taskSupport;
}

/**
 * Strip ONLY the two injected shapes, recording every removal.
 *
 * A `$schema` whose value is not the known dialect, or an `execution` block with
 * any other shape, is deliberately KEPT — an unrecognised variant is authored
 * content until proven otherwise.
 */
export function projectAuthoredMcpToolSurface(tools: unknown): McpSurfaceProjection {
  const removed: McpSurfaceRemoval[] = [];
  const walk = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) return node.map((item, index) => walk(item, `${path}[${index}]`));
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$schema' && value === MCP_INJECTED_SCHEMA_DIALECT) {
        removed.push({ path, key, value });
        continue;
      }
      if (key === 'execution' && isInjectedExecutionBlock(value)) {
        removed.push({ path, key, value });
        continue;
      }
      out[key] = walk(value, path ? `${path}.${key}` : key);
    }
    return out;
  };
  return { authored: walk(tools, ''), removed };
}

export function mcpToolSurfaceBytes(value: unknown): number {
  return JSON.stringify(value).length;
}
