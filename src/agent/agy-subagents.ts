import type { ToolCallEvent } from '../../shared/agent-message.js';
import { SDK_SUBAGENT_DETAIL_KIND, SDK_SUBAGENT_PROVIDERS, SDK_SUBAGENT_PROVIDER_KINDS,
  SDK_SUBAGENT_SCHEMA_VERSION, SDK_SUBAGENT_STATUS, buildSdkSubagentSafeDetail, makeAgySubagentCanonicalKey,
  type SdkSubagentNormalizedStatus } from '../../shared/sdk-subagent-status.js';

const record = (v: unknown): Record<string, unknown> => {
  if (typeof v === 'string') { try { return record(JSON.parse(v)); } catch { return {}; } }
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
};
const string = (...values: unknown[]): string | undefined => values.find(v => typeof v === 'string' && v.trim()) as string | undefined;
export function normalizeAgyToolName(name: string): string {
  // Some ACP builds include the invocation JSON in the display title.
  return name.trim().split(/\s*[\[({]/, 1)[0].toLowerCase().replace(/^run\s+/, '').replace(/[-_\s]/g, '');
}
function toolInput(tool: ToolCallEvent): Record<string, unknown> {
  if (tool.input != null) return record(tool.input);
  const start = tool.name.indexOf('{');
  return start < 0 ? {} : record(tool.name.slice(start));
}
function textLaunchResult(text: string): unknown {
  const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
  // Only a launch result may supply a bare UUID. UUIDs in unrelated prose
  // (request ids, paths, diagnostics) are not child-conversation authority.
  const bare = new RegExp(`^${uuid}$`, 'i').exec(text.trim());
  const labelled = new RegExp(`\\b(?:conversation[ _-]*id|subagent(?:[ _-]*id)?)\\s*[:=]\\s*["'\\x60]?(${uuid})(?![0-9a-f-])`, 'i').exec(text);
  const id = bare?.[0] ?? labelled?.[1];
  return id ? { conversationId: id } : undefined;
}
export function isAgySubagentTool(name: string): boolean {
  return /^(invokesubagent|browsersubagent|managesubagents|definesubagent|swarm|sendmessage|subagent|agent)$/.test(normalizeAgyToolName(name));
}
export function isAgyInteractiveTool(name: string): boolean {
  return /^(askquestion|askuserquestion|askuser)$/.test(normalizeAgyToolName(name));
}
function status(value: unknown): SdkSubagentNormalizedStatus | undefined {
  const v = typeof value === 'string' ? value.toLowerCase() : '';
  if (/^(complete|completed|done|success|idle|finished)$/.test(v)) return SDK_SUBAGENT_STATUS.COMPLETE;
  if (/^(error|failed|failure|errored)$/.test(v)) return SDK_SUBAGENT_STATUS.ERROR;
  if (/^(cancelled|canceled|interrupted|killed|stopped)$/.test(v)) return SDK_SUBAGENT_STATUS.INTERRUPTED;
  if (/^(running|active|pending|queued|in_progress|working|thinking)$/.test(v)) return SDK_SUBAGENT_STATUS.RUNNING;
  return undefined;
}
const extractToolTarget = (row: Record<string, unknown>): string | undefined => string(
  row.conversationId, row.conversation_id, row.ConversationId,
  row.agentId, row.agent_id, row.agentPath, row.agent_path,
  row.id, row.target, row.targetId, row.target_id, row.recipient, row.Recipient,
);

interface Child { key: string; id: string; name?: string; model?: string; prompt?: string; started: number; state: SdkSubagentNormalizedStatus; toolId?: string; }

/** Shared AG tool/snapshot adapter. Parent tool completion is not proof that a
 * background child completed; explicit native child state/kill is authoritative.
 * Definition/list operations do not invent an active execution. */
export class AgySubagentTracker {
  private children = new Map<string, Child>();
  private unbound = new Set<string>();
  private nativeChildren = new Set<string>();
  private toolChildren = new Map<string, string[]>();
  constructor(private parent: string) {}

  isNativeChild(id: string): boolean { return this.nativeChildren.has(id); }

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
        let parsed = false;
        for (const [open,close] of [['{','}'],['[',']']]) {
          const start = text.indexOf(open), end = text.lastIndexOf(close);
          if (start < 0 || end < start) continue;
          try { value = JSON.parse(text.slice(start,end+1)); parsed = true; break; } catch { /* try the array snapshot */ }
        }
        if (!parsed) {
          value = defaultState ? textLaunchResult(text) : undefined;
          if (!value) return [];
        }
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
      let slots = toolId ? this.toolChildren.get(toolId) : undefined;
      if (!slots && toolId && defaultState) { slots = []; this.toolChildren.set(toolId, slots); }
      const role = string(row.role, row.Role, row.name, row.TypeName);
      // Prefer native identity, then role, then complete batch position, then
      // the next unbound launch slot (single-result updates may arrive apart).
      let slot = slots?.indexOf(id) ?? -1;
      if (slot < 0 && role) slot = slots?.findIndex(key => this.unbound.has(key) && this.children.get(key)?.name === role) ?? -1;
      if (slot < 0 && slots?.length === rows.length && this.unbound.has(slots[index])) slot = index;
      if (slot < 0) slot = slots?.findIndex(key => this.unbound.has(key)) ?? -1;
      const placeholder = slot >= 0 ? slots?.[slot] : undefined;
      const previous = this.children.get(id) ?? (placeholder ? this.children.get(placeholder) : undefined);
      // Unversioned late list snapshots must not revive a terminal child. A
      // new explicit send/add/invoke is handled by tool() and can start work.
      if (previous && previous.state !== SDK_SUBAGENT_STATUS.RUNNING && normalized === SDK_SUBAGENT_STATUS.RUNNING) continue;
      const child: Child = { key: previous?.key ?? makeAgySubagentCanonicalKey(this.parent, id), id,
        name: string(row.role, row.Role, row.name, row.TypeName) ?? previous?.name,
        model: string(row.model, row.Model) ?? previous?.model, prompt: previous?.prompt,
        started: previous?.started ?? Date.now(), state: normalized, toolId: previous?.toolId ?? toolId };
      if (placeholder && placeholder !== id) this.children.delete(placeholder);
      if (placeholder) this.unbound.delete(placeholder);
      if (slots) { if (slot >= 0) slots[slot] = id; else if (!slots.includes(id)) slots.push(id); }
      this.nativeChildren.add(id);
      this.children.set(id, child);
      result.push(this.emit(child, action, string(row.stateDetail, row.state_detail)));
    }
    return result;
  }

  tool(tool: ToolCallEvent): ToolCallEvent[] {
    if (!isAgySubagentTool(tool.name)) return [];
    const input = toolInput(tool);
    const name = normalizeAgyToolName(tool.name);
    const action = string(input.action, input.Action, input.command, input.Command) ?? name;
    const candidates = Array.isArray(input.Subagents) ? input.Subagents : Array.isArray(input.agents) ? input.agents : [input];
    const definition = name === 'definesubagent';
    const launch = name === 'invokesubagent' || name === 'browsersubagent' || name === 'subagent' || name === 'agent' || (name === 'swarm' && /^(add|start|create)$/.test(action));
    const kill = /^(kill|stop|cancel|terminate)$/.test(action);
    // send_message can only message an already-tracked child sub-agent; calls
    // targeting external/IM.codes sessions (e.g. deck_sub_*) or unlaunched IDs
    // must never invent a bogus Antigravity sub-agent entry.
    if (name === 'sendmessage' && !candidates.some((entry) => {
      const target = extractToolTarget(record(entry));
      return Boolean(target && this.children.has(target));
    })) {
      return [];
    }
    const launchResult = /^(invokesubagent|browsersubagent)$/.test(name) || name === 'swarm' && /^(add|start|create)$/.test(action);
    const snapshot = this.snapshot(tool.output, action, tool.id, launchResult ? tool.status === 'error' ? SDK_SUBAGENT_STATUS.ERROR : SDK_SUBAGENT_STATUS.RUNNING : undefined);
    if (snapshot.length) return snapshot;
    const result: ToolCallEvent[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const row = record(candidates[i]);
      const target = extractToolTarget(row);
      if (!launch && !definition && (!target || !this.children.has(target))) continue;
      if (definition && tool.status === 'running') continue;
      const id = target ?? this.toolChildren.get(tool.id)?.[i] ?? `${definition ? 'definition:' : ''}${tool.id}${candidates.length > 1 ? `:${i}` : ''}`;
      if (!target && !this.toolChildren.get(tool.id)?.[i]) this.unbound.add(id);
      const previous = this.children.get(id);
      const child: Child = { key: previous?.key ?? makeAgySubagentCanonicalKey(this.parent, id), id,
        name: string(row.Role, row.role, row.name, row.TypeName, row.type) ?? previous?.name,
        model: string(row.Model, row.model) ?? previous?.model,
        prompt: string(row.Prompt, row.prompt, row.description) ?? previous?.prompt,
        started: previous?.started ?? Date.now(), state: tool.status === 'error' ? SDK_SUBAGENT_STATUS.ERROR
          : kill && tool.status === 'complete' ? SDK_SUBAGENT_STATUS.INTERRUPTED
          : definition || (name === 'browsersubagent' && tool.status === 'complete') ? SDK_SUBAGENT_STATUS.COMPLETE
          : previous?.state ?? SDK_SUBAGENT_STATUS.RUNNING, toolId: tool.id };
      if (tool.status === 'running' && (launch || name === 'sendmessage')
        && (!previous || previous.toolId !== tool.id)) child.state = SDK_SUBAGENT_STATUS.RUNNING;
      this.children.set(id, child);
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
