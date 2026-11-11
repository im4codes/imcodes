import type { ToolCallEvent } from '../../shared/agent-message.js';
import { SDK_SUBAGENT_DETAIL_KIND, SDK_SUBAGENT_PROVIDERS, SDK_SUBAGENT_PROVIDER_KINDS,
  SDK_SUBAGENT_SCHEMA_VERSION, SDK_SUBAGENT_STATUS, buildSdkSubagentSafeDetail, makeAgySubagentCanonicalKey,
  type SdkSubagentNormalizedStatus } from '../../shared/sdk-subagent-status.js';

const record = (v: unknown): Record<string, unknown> => {
  if (typeof v === 'string') { try { return record(JSON.parse(v)); } catch { return {}; } }
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
};
const string = (...values: unknown[]): string | undefined => values.find(v => typeof v === 'string' && v.trim()) as string | undefined;
function toolName(name: string): string { return name.toLowerCase().replace(/^run\s+/, '').replace(/[-_\s]/g, ''); }
export function isAgySubagentTool(name: string): boolean {
  return /^(invokesubagent|browsersubagent|managesubagents|definesubagent|swarm|sendmessage|subagent|agent)$/.test(toolName(name));
}
function status(value: unknown): SdkSubagentNormalizedStatus | undefined {
  const v = typeof value === 'string' ? value.toLowerCase() : '';
  if (/^(complete|completed|done|success|idle|finished)$/.test(v)) return SDK_SUBAGENT_STATUS.COMPLETE;
  if (/^(error|failed|failure|errored)$/.test(v)) return SDK_SUBAGENT_STATUS.ERROR;
  if (/^(cancelled|canceled|interrupted|killed|stopped)$/.test(v)) return SDK_SUBAGENT_STATUS.INTERRUPTED;
  if (/^(running|active|pending|queued|in_progress|working|thinking)$/.test(v)) return SDK_SUBAGENT_STATUS.RUNNING;
  return undefined;
}
interface Child { key: string; id: string; name?: string; model?: string; prompt?: string; started: number; state: SdkSubagentNormalizedStatus; toolId?: string; }

/** Shared AG tool/snapshot adapter. Parent tool completion is not proof that a
 * background child completed; explicit native child state/kill is authoritative.
 * Definition/list operations do not invent an active execution. */
export class AgySubagentTracker {
  private children = new Map<string, Child>();
  private toolChild = new Map<string, string>();
  private toolChildren = new Map<string, string[]>();
  constructor(private parent: string) {}

  private emit(child: Child, action: string, output?: string): ToolCallEvent {
    const active = child.state === SDK_SUBAGENT_STATUS.RUNNING;
    const detail = buildSdkSubagentSafeDetail({ kind: SDK_SUBAGENT_DETAIL_KIND,
      summary: `Antigravity sub-agent ${child.name ?? child.id}`,
      input: { action, ...(child.prompt ? { description: child.prompt } : {}) }, ...(output ? { output } : {}),
      meta: { isSdkSubagent: true, schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
        provider: SDK_SUBAGENT_PROVIDERS.AGY_SDK, providerKind: SDK_SUBAGENT_PROVIDER_KINDS.AGY_RUNTIME_AGENT,
        canonicalKey: child.key, normalizedStatus: child.state, rawStatus: child.state,
        active, terminal: !active, parentSessionId: this.parent, parentItemId: child.id,
        ...(child.toolId ? { parentToolUseId: child.toolId } : {}), agentPath: child.id,
        ...(child.name ? { agentName: child.name } : {}), ...(child.model ? { model: child.model } : {}),
        startedAtMs: child.started, backgrounded: true,
      } }, { allowRaw: false });
    return { id: child.key, name: 'Agent', status: active ? 'running' : child.state === SDK_SUBAGENT_STATUS.ERROR ? 'error' : 'complete',
      detail, ...(detail.input ? { input: detail.input } : {}), ...(output ? { output } : {}) };
  }

  snapshot(value: unknown, action = 'manage_subagents', toolId?: string, defaultState?: SdkSubagentNormalizedStatus): ToolCallEvent[] {
    if (typeof value === 'string') {
      const text = value;
      try { value = JSON.parse(text); } catch {
        // AG native tool results can wrap their JSON snapshot in prose.
        const start = text.indexOf('{'), end = text.lastIndexOf('}');
        if (start < 0 || end < start) return [];
        try { value = JSON.parse(text.slice(start,end+1)); } catch { return []; }
      }
    }
    let obj = record(value);
    for (const key of ['subagent', 'subAgent', 'agent', 'notification', 'data', 'event', 'result']) {
      if (obj[key] && typeof obj[key] === 'object') { obj = record(obj[key]); break; }
    }
    const list = Array.isArray(value) ? value : [obj.subagents, obj.agents, obj.members, obj.results].find(Array.isArray);
    const rows = list ?? [obj];
    const result: ToolCallEvent[] = [];
    for (const [index, raw] of rows.entries()) {
      const row = record(raw);
      const id = string(row.conversationId, row.conversation_id, row.ConversationId, row.agentId, row.agent_id, row.agentPath, row.agent_path, row.id);
      if (!id) continue;
      const normalized = status(row.state ?? row.status ?? row.Status) ?? defaultState;
      if (!normalized) continue;
      const placeholder = toolId ? this.toolChildren.get(toolId)?.[index] ?? (rows.length === 1 ? this.toolChild.get(toolId) : undefined) : undefined;
      const previous = this.children.get(id) ?? (placeholder ? this.children.get(placeholder) : undefined);
      // Unversioned late list snapshots must not revive a terminal child. A
      // new explicit send/add/invoke is handled by tool() and can start work.
      if (previous && previous.state !== SDK_SUBAGENT_STATUS.RUNNING && normalized === SDK_SUBAGENT_STATUS.RUNNING) continue;
      const child: Child = { key: previous?.key ?? makeAgySubagentCanonicalKey(this.parent, id), id,
        name: string(row.role, row.Role, row.name, row.TypeName) ?? previous?.name,
        model: string(row.model, row.Model) ?? previous?.model, prompt: previous?.prompt,
        started: previous?.started ?? Date.now(), state: normalized, toolId: previous?.toolId ?? toolId };
      if (placeholder && placeholder !== id) this.children.delete(placeholder);
      this.children.set(id, child);
      if (toolId) this.toolChild.set(toolId, id);
      result.push(this.emit(child, action, string(row.stateDetail, row.state_detail)));
    }
    return result;
  }

  tool(tool: ToolCallEvent): ToolCallEvent[] {
    if (!isAgySubagentTool(tool.name)) return [];
    const input = record(tool.input);
    const name = toolName(tool.name);
    const action = string(input.action, input.Action, input.command, input.Command) ?? name;
    const launchResult = /^(invokesubagent|browsersubagent)$/.test(name) || name === 'swarm' && /^(add|start|create)$/.test(action);
    const snapshot = this.snapshot(tool.output, action, tool.id, launchResult ? tool.status === 'error' ? SDK_SUBAGENT_STATUS.ERROR : SDK_SUBAGENT_STATUS.RUNNING : undefined);
    if (snapshot.length) return snapshot;
    const candidates = Array.isArray(input.Subagents) ? input.Subagents : Array.isArray(input.agents) ? input.agents : [input];
    const result: ToolCallEvent[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const row = record(candidates[i]);
      const target = string(row.conversationId, row.conversation_id, row.ConversationId, row.agentId, row.agent_id, row.agentPath, row.agent_path, row.id, row.target, row.targetId, row.target_id, row.recipient, row.Recipient);
      const definition = name === 'definesubagent';
      const launch = name === 'invokesubagent' || name === 'browsersubagent' || name === 'subagent' || name === 'agent' || (name === 'swarm' && /^(add|start|create)$/.test(action));
      const kill = /^(kill|stop|cancel|terminate)$/.test(action);
      if (!launch && !definition && !target) continue;
      if (definition && tool.status === 'running') continue;
      const id = target ?? this.toolChild.get(tool.id) ?? `${definition ? 'definition:' : ''}${tool.id}${candidates.length > 1 ? `:${i}` : ''}`;
      const previous = this.children.get(id);
      const child: Child = { key: previous?.key ?? makeAgySubagentCanonicalKey(this.parent, id), id,
        name: string(row.Role, row.role, row.name, row.TypeName, row.type) ?? previous?.name,
        model: string(row.Model, row.model) ?? previous?.model,
        prompt: string(row.Prompt, row.prompt, row.description) ?? previous?.prompt,
        started: previous?.started ?? Date.now(), state: tool.status === 'error' ? SDK_SUBAGENT_STATUS.ERROR
          : kill && tool.status === 'complete' ? SDK_SUBAGENT_STATUS.INTERRUPTED
          : definition || (name === 'browsersubagent' && tool.status === 'complete') ? SDK_SUBAGENT_STATUS.COMPLETE
          : previous?.state ?? SDK_SUBAGENT_STATUS.RUNNING, toolId: tool.id };
      if (tool.status === 'running' && (launch || name === 'sendmessage')) child.state = SDK_SUBAGENT_STATUS.RUNNING;
      this.children.set(id, child); this.toolChild.set(tool.id, id);
      const ids = this.toolChildren.get(tool.id) ?? []; ids[i] = id; this.toolChildren.set(tool.id, ids);
      result.push(this.emit(child, action, tool.output));
    }
    return result;
  }

  interrupt(): ToolCallEvent[] {
    const events: ToolCallEvent[] = [];
    for (const child of this.children.values()) {
      if (child.state !== SDK_SUBAGENT_STATUS.RUNNING) continue;
      child.state = SDK_SUBAGENT_STATUS.INTERRUPTED; events.push(this.emit(child, 'cancel'));
    }
    return events;
  }
}
