import {
  ToolListChangedNotificationSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { MCP_TOOL_CATALOG_LIMITS } from '../../shared/mcp-tool-distribution.js';

export interface McpToolCatalogClient {
  listTools(params?: { cursor?: string }): Promise<{
    tools: Tool[];
    nextCursor?: string;
  }>;
  getServerCapabilities?(): { tools?: { listChanged?: boolean } } | undefined;
  setNotificationHandler?(
    schema: typeof ToolListChangedNotificationSchema,
    handler: () => void | Promise<void>,
  ): void;
}

export interface McpToolCatalogSubscription {
  /**
   * Future subscription/listen transports install their listener only after
   * the cold tools/list generation has been published. The callback is an
   * invalidation signal, never a schema payload.
   */
  listen(onInvalidated: () => void): void | (() => void) | Promise<void | (() => void)>;
}

export interface McpToolCatalogSnapshot {
  connectionGeneration: number;
  catalogGeneration: number;
  ready: boolean;
  tools: readonly Tool[];
  added: readonly string[];
  removed: readonly string[];
  schemaChanged: readonly string[];
  reason: string;
  error?: string;
}

export interface McpToolCatalogGenerationProof {
  connectionGeneration: number;
  catalogGeneration: number;
}

export interface McpToolCatalogOptions {
  publish(snapshot: McpToolCatalogSnapshot): void;
  subscription?: McpToolCatalogSubscription;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function toolFingerprint(tool: Tool): string {
  return stableJson({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    execution: tool.execution,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Connection-scoped MCP callable catalog.
 *
 * `notifications/tools/list_changed` is only an invalidation. Every refresh
 * completes all tools/list pages before replacing the observable catalog.
 * While a generation is missing or invalid, `ready=false` makes direct calls
 * fail closed instead of retaining stale schemas/permissions. Backend service
 * activity is deliberately outside this class: publication is not activation.
 */
export class McpToolCatalog {
  private client: McpToolCatalogClient | null = null;
  private connectionGeneration = 0;
  private catalogGeneration = 0;
  private callableReady = false;
  private catalog = new Map<string, Tool>();
  private fingerprints = new Map<string, string>();
  private refreshPromise: Promise<void> | null = null;
  private refreshAgain = false;
  private invalidationVersion = 0;
  private disposed = false;
  private stopSubscription: (() => void) | undefined;

  constructor(private readonly options: McpToolCatalogOptions) {}

  get generation(): number | undefined {
    return this.callableReady ? this.catalogGeneration : undefined;
  }

  get generationProof(): McpToolCatalogGenerationProof | undefined {
    return this.ready ? {
      connectionGeneration: this.connectionGeneration,
      catalogGeneration: this.catalogGeneration,
    } : undefined;
  }

  get ready(): boolean {
    return this.callableReady && !this.disposed;
  }

  getTool(name: string): Tool | undefined {
    return this.ready ? this.catalog.get(name) : undefined;
  }

  async connect(client: McpToolCatalogClient): Promise<void> {
    this.stopSubscription?.();
    this.stopSubscription = undefined;
    this.disposed = false;
    this.client = client;
    this.connectionGeneration += 1;
    this.invalidationVersion += 1;
    this.catalogGeneration = 0;
    this.callableReady = false;
    this.publishUnavailable('connect');

    const supportsListChanged = client.getServerCapabilities?.()?.tools?.listChanged === true;
    if (supportsListChanged && client.setNotificationHandler) {
      const connectionGeneration = this.connectionGeneration;
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        if (this.client !== client || this.connectionGeneration !== connectionGeneration) return;
        return this.invalidate('tools/list_changed');
      });
    }

    await this.refresh('connect');

    // SEP subscription/listen style transports subscribe only after the cold
    // list has been completely hydrated and atomically published.
    const subscriptionGeneration = this.connectionGeneration;
    const stop = await this.options.subscription?.listen(() => {
      if (this.connectionGeneration === subscriptionGeneration) {
        void this.invalidate('tools/subscription');
      }
    });
    this.stopSubscription = typeof stop === 'function' ? stop : undefined;
  }

  /** Manual refresh is the required path when listChanged is absent. */
  async refresh(reason = 'manual'): Promise<void> {
    if (this.disposed || !this.client) throw new Error('MCP tool catalog is not connected');
    if (this.refreshPromise) {
      this.refreshAgain = true;
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      let nextReason = reason;
      do {
        this.refreshAgain = false;
        await this.runRefresh(nextReason);
        nextReason = 'coalesced';
      } while (this.refreshAgain && !this.disposed);
    })();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  /**
   * Transport resumption is callable-ready only when the caller proves it is
   * observing this validated connection generation. A missing/stale proof
   * forces a complete refetch.
   */
  async resume(observed?: McpToolCatalogGenerationProof): Promise<void> {
    if (!observed
      || observed.connectionGeneration !== this.connectionGeneration
      || observed.catalogGeneration !== this.catalogGeneration
      || !this.ready) {
      await this.refresh('resume');
    }
  }

  async invalidate(reason: string): Promise<void> {
    if (this.disposed || !this.client) return;
    // Remove stale schemas from the current model-visible map immediately.
    // Multiple notification bursts share one in-flight refresh and at most one
    // coalesced follow-up.
    this.callableReady = false;
    this.invalidationVersion += 1;
    this.publishUnavailable(reason);
    await this.refresh(reason).catch(() => {});
  }

  disconnect(): void {
    this.disposed = true;
    this.client = null;
    this.callableReady = false;
    this.stopSubscription?.();
    this.stopSubscription = undefined;
    this.publishUnavailable('disconnect');
  }

  private async runRefresh(reason: string): Promise<void> {
    const client = this.client;
    const connectionGeneration = this.connectionGeneration;
    const invalidationVersion = this.invalidationVersion;
    if (!client) throw new Error('MCP tool catalog is not connected');

    try {
      const next = await this.listAllTools(client);
      if (this.disposed || this.client !== client || this.connectionGeneration !== connectionGeneration) return;
      // A list_changed/subscription invalidation that arrives while pagination
      // is in flight makes the completed list stale by definition. Never
      // publish that generation; the coalesced pass will fetch from page one.
      if (this.invalidationVersion !== invalidationVersion) return;

      const nextFingerprints = new Map<string, string>();
      for (const [name, tool] of next) nextFingerprints.set(name, toolFingerprint(tool));
      const added = [...next.keys()].filter((name) => !this.catalog.has(name)).sort();
      const removed = [...this.catalog.keys()].filter((name) => !next.has(name)).sort();
      const schemaChanged = [...next.keys()]
        .filter((name) => this.catalog.has(name) && this.fingerprints.get(name) !== nextFingerprints.get(name))
        .sort();

      this.catalog = next;
      this.fingerprints = nextFingerprints;
      this.catalogGeneration += 1;
      this.callableReady = true;
      this.options.publish({
        connectionGeneration,
        catalogGeneration: this.catalogGeneration,
        ready: true,
        tools: Object.freeze([...next.values()]),
        added,
        removed,
        schemaChanged,
        reason,
      });
    } catch (error) {
      // A superseded connection may fail after reconnect. It has no authority
      // over the new generation and must not abort or poison its cold hydrate.
      if (this.disposed || this.client !== client || this.connectionGeneration !== connectionGeneration) return;
      this.callableReady = false;
      this.publishUnavailable(reason, errorMessage(error));
      throw error;
    }
  }

  private async listAllTools(client: McpToolCatalogClient): Promise<Map<string, Tool>> {
    const result = new Map<string, Tool>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < MCP_TOOL_CATALOG_LIMITS.PAGES; page += 1) {
      const response = await client.listTools(cursor ? { cursor } : undefined);
      if (!response || !Array.isArray(response.tools)) throw new Error('invalid tools/list response');
      for (const tool of response.tools) {
        if (!tool || typeof tool.name !== 'string' || tool.name.length === 0) {
          throw new Error('invalid tools/list tool');
        }
        if (result.has(tool.name)) throw new Error(`ambiguous duplicate MCP tool: ${tool.name}`);
        result.set(tool.name, tool);
        if (result.size > MCP_TOOL_CATALOG_LIMITS.TOOLS) throw new Error('MCP tool catalog exceeds bounded size');
      }

      const nextCursor = response.nextCursor;
      if (nextCursor === undefined) return result;
      if (typeof nextCursor !== 'string' || nextCursor.length === 0 || seenCursors.has(nextCursor)) {
        throw new Error('invalid or repeated tools/list cursor');
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new Error('tools/list pagination exceeds bounded page count');
  }

  private publishUnavailable(reason: string, error?: string): void {
    this.options.publish({
      connectionGeneration: this.connectionGeneration,
      catalogGeneration: 0,
      ready: false,
      tools: Object.freeze([]),
      added: Object.freeze([]),
      removed: Object.freeze([...this.catalog.keys()].sort()),
      schemaChanged: Object.freeze([]),
      reason,
      ...(error ? { error } : {}),
    });
  }
}
