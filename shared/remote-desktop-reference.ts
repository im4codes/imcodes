export const REMOTE_DESKTOP_CITATION_PREFIX = '[RemoteDesktop:' as const;
export const REMOTE_DESKTOP_CHAT_CITATION_PATTERN = '[RemoteDesktop: <name> | id=<id>]' as const;

const REMOTE_DESKTOP_CITATION_MAX_BODY_CHARS = 512;

export interface RemoteDesktopTextSegment {
  type: 'text' | 'remote_desktop';
  value: string;
  start: number;
  end: number;
  targetId?: string;
  label?: string;
}

export function sanitizeRemoteDesktopCitationName(raw: string): string {
  const cleaned = raw
    .replace(/[\r\n\t\x00-\x1f\x7f\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, ' ')
    .replace(/[[\]|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'Remote Desktop';
}

export function sanitizeRemoteDesktopCitationId(raw: string): string {
  return raw.replace(/[\r\n\t\x00-\x1f\x7f\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF[\]|\s]+/g, '').trim();
}

/**
 * Format the canonical chat citation token `[RemoteDesktop: <name> | id=<id>]`
 * shared across agent output contracts, mini-chat quote pills, and clickable chat tokens.
 */
export function formatRemoteDesktopCitation(name: string | undefined | null, id: string): string {
  const cleanName = sanitizeRemoteDesktopCitationName(typeof name === 'string' ? name : '');
  const cleanId = sanitizeRemoteDesktopCitationId(id);
  return cleanId ? `${REMOTE_DESKTOP_CITATION_PREFIX} ${cleanName} | id=${cleanId}]` : cleanName;
}

function parseRemoteDesktopCitationBody(body: string): { targetId: string; name: string } | null {
  if (!body || body.includes('\n') || body.includes('\r') || body.includes('[') || body.includes(']')) return null;
  const pipeIdx = body.indexOf('|');
  if (pipeIdx <= 0) return null;
  // Reject nested pipes inside an unescaped/unformatted token so `[a | b | id=c]` does not misbind.
  if (body.indexOf('|', pipeIdx + 1) !== -1) return null;
  const name = body.slice(0, pipeIdx).trim();
  const rhs = body.slice(pipeIdx + 1).trim();
  if (!name || !rhs.startsWith('id=')) return null;
  const targetId = rhs.slice(3).trim();
  if (!targetId || /\s/.test(targetId)) return null;
  return { targetId, name };
}

/** Parse an exact `[RemoteDesktop: <name> | id=<id>]` citation token (optionally surrounded by whitespace). */
export function parseRemoteDesktopCitationTag(text: string): { targetId: string; name: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(REMOTE_DESKTOP_CITATION_PREFIX) || !trimmed.endsWith(']')) return null;
  const body = trimmed.slice(REMOTE_DESKTOP_CITATION_PREFIX.length, -1);
  if (body.includes(REMOTE_DESKTOP_CITATION_PREFIX)) return null;
  return parseRemoteDesktopCitationBody(body);
}

/**
 * Split text by `[RemoteDesktop: <name> | id=<id>]` tokens in strict O(n) linear time
 * with zero regex backtracking.
 */
export function splitTextByRemoteDesktopCitations(text: string): RemoteDesktopTextSegment[] {
  if (!text) return [];
  if (!text.includes(REMOTE_DESKTOP_CITATION_PREFIX)) {
    return [{ type: 'text', value: text, start: 0, end: text.length }];
  }

  const segments: RemoteDesktopTextSegment[] = [];
  let lastEmit = 0;
  let scanFrom = 0;

  while (scanFrom < text.length) {
    const start = text.indexOf(REMOTE_DESKTOP_CITATION_PREFIX, scanFrom);
    if (start === -1) break;

    const bodyStart = start + REMOTE_DESKTOP_CITATION_PREFIX.length;
    const windowEnd = Math.min(text.length, bodyStart + REMOTE_DESKTOP_CITATION_MAX_BODY_CHARS);
    const window = text.slice(bodyStart, windowEnd);

    const closeRel = window.indexOf(']');
    if (closeRel === -1) {
      const nextPrefixRel = window.indexOf(REMOTE_DESKTOP_CITATION_PREFIX);
      scanFrom = nextPrefixRel !== -1 ? bodyStart + nextPrefixRel : windowEnd;
      continue;
    }

    const nextPrefixRel = window.indexOf(REMOTE_DESKTOP_CITATION_PREFIX);
    if (nextPrefixRel !== -1 && nextPrefixRel < closeRel) {
      scanFrom = bodyStart + nextPrefixRel;
      continue;
    }

    const body = window.slice(0, closeRel);
    const parsed = parseRemoteDesktopCitationBody(body);
    if (!parsed) {
      scanFrom = bodyStart;
      continue;
    }

    const end = bodyStart + closeRel + 1;
    if (start > lastEmit) {
      segments.push({ type: 'text', value: text.slice(lastEmit, start), start: lastEmit, end: start });
    }
    segments.push({
      type: 'remote_desktop',
      value: text.slice(start, end),
      start,
      end,
      targetId: parsed.targetId,
      label: parsed.name,
    });
    lastEmit = end;
    scanFrom = end;
  }

  if (lastEmit < text.length) {
    segments.push({ type: 'text', value: text.slice(lastEmit), start: lastEmit, end: text.length });
  }
  return segments;
}
