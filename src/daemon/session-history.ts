import type { ContextNamespace, ProcessedContextProjection } from '../../shared/context-types.js';
import { getContextStoreClient } from '../store/context-store-worker-client.js';
import { SESSION_HISTORY_TOOL_EVENT_TYPES, SESSION_TEXT_HISTORY_DEFAULT_LIMIT, SESSION_TEXT_HISTORY_MAX_CHARS, SESSION_TEXT_HISTORY_MAX_LIMIT, type SessionTextMessage } from '../../shared/session-history.js';
import { redactSensitiveText } from '../../shared/redact-secrets.js';
import { timelineStore } from './timeline-store.js';
import type { SessionRecord } from '../store/session-store.js';
import type { TimelineTextTailOptions } from './timeline-projection-types.js';

/** The same canonical text-only reader serves MCP and cross-provider handoffs. */
export async function readSessionTextMessages(sessionName: string, limit = SESSION_TEXT_HISTORY_DEFAULT_LIMIT, through?: TimelineTextTailOptions['through'], redact = true): Promise<SessionTextMessage[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > SESSION_TEXT_HISTORY_MAX_LIMIT) throw new Error(`limit must be 1..${SESSION_TEXT_HISTORY_MAX_LIMIT}`);
  const events = await timelineStore.readCompletedTextTail(sessionName, limit, { visibleOnly: true, ...(through ? { through } : {}) });
  const budget = Math.floor(SESSION_TEXT_HISTORY_MAX_CHARS / Math.max(1, events.length));
  return events.filter((event) => event.type === 'user.message' || (event.type === 'assistant.text' && event.payload.streaming !== true))
    .filter((event) => event.hidden !== true && event.payload.hidden !== true)
    .map((event) => {
      const raw = event.payload.text ?? event.payload.content ?? event.payload.message;
      const text = typeof raw === 'string' ? (redact ? redactSensitiveText(raw) : raw) : '';
      return { eventId: event.eventId, role: event.type === 'user.message' ? 'user' as const : 'assistant' as const, text: text.slice(0, budget), ts: event.ts, truncated: text.length > budget };
    }).filter((event) => event.text.trim().length > 0);
}

/** Reuse the processed-summary store's indexed namespace+session filter. */
export async function readSessionSummaries(sessionName: string, namespace: ContextNamespace, limit = SESSION_TEXT_HISTORY_DEFAULT_LIMIT, redact = true) {
  if (!Number.isInteger(limit) || limit < 1 || limit > SESSION_TEXT_HISTORY_MAX_LIMIT) throw new Error(`limit must be 1..${SESSION_TEXT_HISTORY_MAX_LIMIT}`);
  const groups = await Promise.all(['recent_summary', 'master_summary'].map((kind) =>
    getContextStoreClient().run<ProcessedContextProjection[]>('listProcessedProjections', [namespace, kind, { sessionName, excludeArchived: true, limit }])));
  const rows = groups.flat().filter((row) => row.content?.sessionName === sessionName && row.status !== 'archived' && row.status !== 'archived_dedup')
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, limit);
  const budget = Math.floor(SESSION_TEXT_HISTORY_MAX_CHARS / Math.max(1, rows.length));
  return rows.map((row) => {
    const summary = redact ? redactSensitiveText(row.summary) : row.summary;
    return { id: row.id, summary: summary.slice(0, budget), updatedAt: row.updatedAt, truncated: summary.length > budget,
      sourceLookup: { kind: 'projection' as const, projectionId: row.id } };
  });
}

/** Resolve only exact persisted IDs on this daemon; never labels or filesystem paths.
 * A canonical name wins over backend IDs, which may collide across providers.
 */
export function resolveHistorySession(sessions: readonly SessionRecord[], id: string): SessionRecord[] {
  const named = sessions.find((session) => session.name === id);
  if (named) return [named];
  return sessions.filter((session) => [session.sessionInstanceId, session.providerSessionId,
    session.providerResumeId, session.ccSessionId, session.codexSessionId,
    session.geminiSessionId, session.opencodeSessionId].includes(id));
}

/** Bounded raw tool call/result payloads; IDs survive even when the payload is truncated. */
export async function readSessionToolEvents(sessionName: string, limit = SESSION_TEXT_HISTORY_DEFAULT_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1 || limit > SESSION_TEXT_HISTORY_MAX_LIMIT) throw new Error(`limit must be 1..${SESSION_TEXT_HISTORY_MAX_LIMIT}`);
  const events = (await timelineStore.readByTypesPreferred(sessionName, [...SESSION_HISTORY_TOOL_EVENT_TYPES], { limit }))
    .filter((event) => (SESSION_HISTORY_TOOL_EVENT_TYPES as readonly string[]).includes(event.type)
      && event.hidden !== true && event.payload.hidden !== true);
  const budget = Math.floor(SESSION_TEXT_HISTORY_MAX_CHARS / Math.max(1, events.length));
  return events.map((event) => {
    const payload = JSON.stringify(event.payload);
    return { eventId: event.eventId, type: event.type, ts: event.ts,
      toolCallId: typeof event.payload.toolCallId === 'string' ? event.payload.toolCallId : null,
      payload: payload.slice(0, budget), truncated: payload.length > budget };
  });
}

/** Parent links, not project names/labels, define the conversation boundary. */
export function canReadSessionHistory(callerName: string, targetName: string, sessions: readonly SessionRecord[]): boolean {
  const byName = new Map(sessions.map((session) => [session.name, session]));
  if (!byName.has(callerName) || !byName.has(targetName)) return false;
  if (callerName === targetName) return true;
  const root = (name: string): string | null => {
    const seen = new Set<string>();
    let current = byName.get(name);
    while (current) {
      if (seen.has(current.name)) return null;
      seen.add(current.name);
      if (!current.parentSession) return current.name;
      current = byName.get(current.parentSession);
    }
    return null;
  };
  const callerRoot = root(callerName);
  return callerRoot !== null && callerRoot === root(targetName);
}
