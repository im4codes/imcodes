import {
  chatPathHasFileExtension,
  extractChatFileReferences,
  normalizeChatFileReference,
} from '../../shared/chat-local-path.js';
import type { TimelineEvent } from './timeline-event.js';

type GrantLoader = () => Promise<TimelineEvent[]>;

const grantsBySession = new Map<string, Set<string>>();
const loadedSessions = new Set<string>();
const loadInflight = new Map<string, Promise<void>>();

// ChatMarkdown turns file_output_v1 Markdown destinations, inline-code local
// paths, and standalone path lines into file-preview actions. Keep daemon
// authorization aligned with that trusted presentation contract: an
// assistant-authored path grants one exact read only in one of those explicit
// forms. Only assistant.text is ingested; user/tool text, rejected remote/UNC
// links, extensionless prefixes, and parent directories never grant access.
function normalizedGrantReference(value: string): string | null {
  const normalized = normalizeChatFileReference(value);
  return normalized && chatPathHasFileExtension(normalized) ? normalized : null;
}

export function extractAssistantFileReadGrants(text: string): string[] {
  const paths = new Set<string>();
  for (const reference of extractChatFileReferences(text)) {
    const normalized = normalizedGrantReference(reference);
    if (normalized) paths.add(normalized);
  }
  return [...paths];
}

export function recordAssistantFileReadGrants(sessionName: string, text: string): void {
  const extracted = extractAssistantFileReadGrants(text);
  if (extracted.length === 0) return;
  let grants = grantsBySession.get(sessionName);
  if (!grants) {
    grants = new Set<string>();
    grantsBySession.set(sessionName, grants);
  }
  for (const filePath of extracted) grants.add(filePath);
}

function ingestTimelineEvents(sessionName: string, events: TimelineEvent[]): void {
  for (const event of events) {
    if (event.sessionId !== sessionName || event.type !== 'assistant.text' || event.hidden === true) continue;
    const text = typeof event.payload?.text === 'string' ? event.payload.text : '';
    if (text) recordAssistantFileReadGrants(sessionName, text);
  }
}

async function ensureLoaded(sessionName: string, loader: GrantLoader): Promise<void> {
  if (loadedSessions.has(sessionName)) return;
  const existing = loadInflight.get(sessionName);
  if (existing) return await existing;
  const load = (async () => {
    try {
      ingestTimelineEvents(sessionName, await loader());
      loadedSessions.add(sessionName);
    } finally {
      loadInflight.delete(sessionName);
    }
  })();
  loadInflight.set(sessionName, load);
  await load;
}

export async function hasAssistantFileReadGrant(
  sessionName: string,
  candidatePath: string,
  loader: GrantLoader,
): Promise<boolean> {
  await ensureLoaded(sessionName, loader);
  const normalized = normalizedGrantReference(candidatePath);
  return !!normalized && grantsBySession.get(sessionName)?.has(normalized) === true;
}

export function __resetSessionFileReadGrantsForTests(): void {
  grantsBySession.clear();
  loadedSessions.clear();
  loadInflight.clear();
}
