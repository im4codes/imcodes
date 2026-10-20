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

// A streamed assistant.text delta carries the CUMULATIVE text and is emitted up
// to ~25 times a second; re-scanning the whole growing text for every delta is
// O(n^2) main-thread work (7 s of a 17 s busy window in a 120 s daemon
// profile). Streamed deltas are therefore scanned at most once per interval
// per session; the final (non-streaming) text always is, so no grant is lost.
export const FILE_READ_GRANT_STREAM_SCAN_INTERVAL_MS = 1_000;
const streamScanAt = new Map<string, number>();

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

export function recordAssistantFileReadGrants(
  sessionName: string,
  text: string,
  opts?: { streaming?: boolean },
): void {
  if (opts?.streaming === true) {
    const now = Date.now();
    const last = streamScanAt.get(sessionName);
    if (last !== undefined && now >= last && now - last < FILE_READ_GRANT_STREAM_SCAN_INTERVAL_MS) return;
    streamScanAt.set(sessionName, now);
  }
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
  streamScanAt.clear();
  loadedSessions.clear();
  loadInflight.clear();
}
