import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import logger from '../util/logger.js';
import type { TimelineEvent } from './timeline-event.js';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

export interface OpenCodeSessionSummary {
  id: string;
  title: string;
  updated: number;
  created: number;
  projectId?: string;
  directory?: string;
}

export interface OpenCodeExportMessage {
  info: Record<string, unknown>;
  parts: Record<string, unknown>[];
}

export interface OpenCodeExportData {
  info: Record<string, unknown>;
  messages: OpenCodeExportMessage[];
}

function normalizeDirectoryPath(input?: string): string | undefined {
  if (!input) return undefined;
  const normalized = input.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return normalized[0].toLowerCase() + normalized.slice(1);
  }
  return normalized;
}

function stableEventId(sessionName: string, key: string): string {
  return createHash('sha1')
    .update(`${sessionName}\0${key}`)
    .digest('hex')
    .slice(0, 24);
}

async function runOpenCode(projectDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('opencode', args, {
    cwd: projectDir,
    timeout: DEFAULT_TIMEOUT_MS,
    maxBuffer: DEFAULT_MAX_BUFFER,
  });
  return stdout;
}

export async function getOpenCodeDbPath(projectDir: string): Promise<string> {
  return (await runOpenCode(projectDir, ['db', 'path'])).trim();
}

export async function listOpenCodeSessions(
  projectDir: string,
  maxCount = 20,
): Promise<OpenCodeSessionSummary[]> {
  const raw = await runOpenCode(projectDir, ['session', 'list', '--format', 'json', '--max-count', String(maxCount)]);
  const parsed = JSON.parse(raw) as OpenCodeSessionSummary[];
  return Array.isArray(parsed) ? parsed : [];
}

function matchesDiscoveryFilters(
  session: OpenCodeSessionSummary,
  opts?: { updatedAfter?: number; exactDirectory?: string },
): boolean {
  const exactDirectory = normalizeDirectoryPath(opts?.exactDirectory);
  const sessionDirectory = normalizeDirectoryPath(session.directory);
  if (!session?.id) return false;
  if (exactDirectory && sessionDirectory && sessionDirectory !== exactDirectory) return false;
  if (opts?.updatedAfter && session.updated < opts.updatedAfter) return false;
  return true;
}

export function discoverOpenCodeSessionIdFromList(
  sessions: OpenCodeSessionSummary[],
  opts?: {
    updatedAfter?: number;
    exactDirectory?: string;
    knownSessionIds?: Iterable<string>;
  },
): string | undefined {
  const known = opts?.knownSessionIds ? new Set(opts.knownSessionIds) : new Set<string>();

  const fresh = sessions.find((session) => !known.has(session.id) && matchesDiscoveryFilters(session, opts));
  if (fresh) return fresh.id;

  const fallback = sessions.find((session) => matchesDiscoveryFilters(session, opts));
  return fallback?.id;
}

export async function discoverLatestOpenCodeSessionId(
  projectDir: string,
  opts?: { updatedAfter?: number; exactDirectory?: string; maxCount?: number; knownSessionIds?: Iterable<string> },
): Promise<string | undefined> {
  const sessions = await listOpenCodeSessions(projectDir, opts?.maxCount ?? 20);
  return discoverOpenCodeSessionIdFromList(sessions, {
    updatedAfter: opts?.updatedAfter,
    exactDirectory: opts?.exactDirectory ?? projectDir,
    knownSessionIds: opts?.knownSessionIds,
  });
}

export async function waitForOpenCodeSessionId(
  projectDir: string,
  opts?: {
    updatedAfter?: number;
    exactDirectory?: string;
    attempts?: number;
    delayMs?: number;
    knownSessionIds?: Iterable<string>;
  },
): Promise<string | undefined> {
  const attempts = Math.max(1, opts?.attempts ?? 10);
  const delayMs = Math.max(50, opts?.delayMs ?? 500);

  for (let i = 0; i < attempts; i++) {
    try {
      const id = await discoverLatestOpenCodeSessionId(projectDir, opts);
      if (id) return id;
    } catch (err) {
      logger.debug({ err, projectDir, attempt: i + 1 }, 'OpenCode session discovery failed');
    }
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return undefined;
}

export async function exportOpenCodeSession(
  projectDir: string,
  sessionId: string,
): Promise<OpenCodeExportData> {
  const raw = await runOpenCode(projectDir, ['export', sessionId]);
  return JSON.parse(raw) as OpenCodeExportData;
}

export function buildTimelineEventsFromOpenCodeExport(
  sessionName: string,
  data: OpenCodeExportData,
  epoch: number,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  let seq = 0;

  const push = (
    type: TimelineEvent['type'],
    payload: Record<string, unknown>,
    ts: number,
    key: string,
  ) => {
    seq += 1;
    events.push({
      eventId: stableEventId(sessionName, key),
      sessionId: sessionName,
      ts,
      seq,
      epoch,
      source: 'daemon',
      confidence: 'medium',
      type,
      payload,
    });
  };

  for (const message of data.messages ?? []) {
    const info = message.info as Record<string, unknown>;
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const messageId = String(info.id ?? '');
    const role = String(info.role ?? '');
    const createdTs = Number((info.time as Record<string, unknown> | undefined)?.created ?? Date.now());

    if (role === 'user') {
      const text = parts
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => String(part.text))
        .join('\n')
        .trim();
      if (text) push('user.message', { text }, createdTs, `${messageId}:user`);
      continue;
    }

    for (const part of parts) {
      const partId = String(part.id ?? `${messageId}:${part.type ?? 'part'}`);
      if (part.type === 'text' && typeof part.text === 'string') {
        const ts = Number((part.time as Record<string, unknown> | undefined)?.end ?? createdTs);
        const text = String(part.text).trim();
        if (text) push('assistant.text', { text, streaming: false }, ts, `${messageId}:${partId}:text`);
        continue;
      }
      if (part.type === 'reasoning' && typeof part.text === 'string') {
        const ts = Number((part.time as Record<string, unknown> | undefined)?.end ?? createdTs);
        const text = String(part.text).trim();
        push('assistant.thinking', { text }, ts, `${messageId}:${partId}:thinking`);
        continue;
      }
      if (part.type === 'tool' && typeof part.tool === 'string') {
        const state = (part.state ?? {}) as Record<string, unknown>;
        const time = (state.time ?? {}) as Record<string, unknown>;
        const startTs = Number(time.start ?? createdTs);
        const endTs = Number(time.end ?? startTs);
        push('tool.call', {
          tool: String(part.tool),
          ...(state.input ? { input: state.input } : {}),
        }, startTs, `${messageId}:${partId}:tool.call`);
        if (state.status === 'completed' || state.status === 'error') {
          push('tool.result', {
            ...(state.status === 'error' && state.error ? { error: state.error } : {}),
          }, endTs, `${messageId}:${partId}:tool.result`);
        }
      }
    }
  }

  return events;
}
