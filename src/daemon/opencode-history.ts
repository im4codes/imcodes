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

export interface OpenCodeMessageRow {
  id: string;
  time_created: number;
  data: string;
}

export interface OpenCodePartRow {
  id: string;
  message_id: string;
  time_created: number;
  data: string;
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

async function runSqliteJson<T>(dbPath: string, sql: string): Promise<T> {
  const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath, sql], {
    timeout: DEFAULT_TIMEOUT_MS,
    maxBuffer: DEFAULT_MAX_BUFFER,
  });
  return JSON.parse(stdout || 'null') as T;
}

function quoteSqlString(input: string): string {
  return input.replace(/'/g, "''");
}

function parseJsonPayload(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Empty OpenCode output');
  const objectStart = trimmed.indexOf('{');
  const arrayStart = trimmed.indexOf('[');
  let start = -1;
  if (objectStart >= 0 && arrayStart >= 0) start = Math.min(objectStart, arrayStart);
  else start = Math.max(objectStart, arrayStart);
  const candidate = start > 0 ? trimmed.slice(start) : trimmed;
  return JSON.parse(candidate);
}

export async function getOpenCodeDbPath(projectDir: string): Promise<string> {
  return (await runOpenCode(projectDir, ['db', 'path'])).trim();
}

export async function listOpenCodeSessions(
  projectDir: string,
  maxCount = 20,
): Promise<OpenCodeSessionSummary[]> {
  try {
    const dbPath = await getOpenCodeDbPath(projectDir);
    const rows = await runSqliteJson<Array<{
      id: string;
      title: string;
      time_updated: number;
      time_created: number;
      project_id?: string | null;
      directory?: string | null;
    }>>(dbPath, `select id, title, time_updated, time_created, project_id, directory from session order by time_updated desc limit ${Math.max(1, Math.trunc(maxCount))}`);
    if (Array.isArray(rows)) {
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        updated: Number(row.time_updated ?? 0),
        created: Number(row.time_created ?? 0),
        ...(row.project_id ? { projectId: row.project_id } : {}),
        ...(row.directory ? { directory: row.directory } : {}),
      }));
    }
  } catch (err) {
    logger.debug({ err, projectDir }, 'Failed to list OpenCode sessions from sqlite; falling back to CLI');
  }

  const raw = await runOpenCode(projectDir, ['session', 'list', '--format', 'json', '--max-count', String(maxCount)]);
  const parsed = parseJsonPayload(raw) as OpenCodeSessionSummary[];
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
  try {
    const dbPath = await getOpenCodeDbPath(projectDir);
    const quotedSessionId = quoteSqlString(sessionId);
    const sessionRows = await runSqliteJson<Array<Record<string, unknown>>>(dbPath, `select id, title, directory, time_created, time_updated from session where id = '${quotedSessionId}' limit 1`);
    const messageRows = await runSqliteJson<OpenCodeMessageRow[]>(dbPath, `select id, time_created, data from message where session_id = '${quotedSessionId}' order by time_created asc, id asc`);
    const partRows = await runSqliteJson<OpenCodePartRow[]>(dbPath, `select id, message_id, time_created, data from part where session_id = '${quotedSessionId}' order by time_created asc, id asc`);

    if (Array.isArray(messageRows) && messageRows.length > 0) {
      return {
        info: Array.isArray(sessionRows) && sessionRows[0] ? sessionRows[0] : { id: sessionId },
        messages: buildOpenCodeMessagesFromRows(messageRows, partRows ?? []),
      };
    }
  } catch (err) {
    logger.debug({ err, projectDir, sessionId }, 'Failed to read OpenCode session from sqlite; falling back to CLI export');
  }

  const raw = await runOpenCode(projectDir, ['export', sessionId]);
  return parseJsonPayload(raw) as OpenCodeExportData;
}

export function buildOpenCodeMessagesFromRows(
  messageRows: OpenCodeMessageRow[],
  partRows: OpenCodePartRow[],
): OpenCodeExportMessage[] {
  const partsByMessage = new Map<string, Record<string, unknown>[]>();
  for (const row of partRows ?? []) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const next = { id: row.id, ...parsed };
    const bucket = partsByMessage.get(row.message_id);
    if (bucket) bucket.push(next); else partsByMessage.set(row.message_id, [next]);
  }

  return messageRows.map((row) => {
    const parsed = JSON.parse(row.data) as Record<string, unknown>;
    return {
      info: { id: row.id, ...parsed },
      parts: partsByMessage.get(row.id) ?? [],
    };
  });
}

export async function getLatestOpenCodeMessageCursor(
  projectDir: string,
  sessionId: string,
): Promise<{ timeCreated: number; messageId: string } | null> {
  const dbPath = await getOpenCodeDbPath(projectDir);
  const quotedSessionId = quoteSqlString(sessionId);
  const rows = await runSqliteJson<Array<{ id: string; time_created: number }>>(
    dbPath,
    `select id, time_created from message where session_id = '${quotedSessionId}' order by time_created desc, id desc limit 1`,
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return { timeCreated: Number(rows[0].time_created ?? 0), messageId: rows[0].id };
}

export async function readOpenCodeSessionMessagesSince(
  projectDir: string,
  sessionId: string,
  cursor?: { timeCreated?: number; messageId?: string },
): Promise<OpenCodeExportMessage[]> {
  const dbPath = await getOpenCodeDbPath(projectDir);
  const quotedSessionId = quoteSqlString(sessionId);
  const afterTime = Number(cursor?.timeCreated ?? 0);
  const afterId = quoteSqlString(cursor?.messageId ?? '');
  const where = afterTime > 0
    ? `and (time_created > ${afterTime} or (time_created = ${afterTime} and id > '${afterId}'))`
    : '';
  const messageRows = await runSqliteJson<OpenCodeMessageRow[]>(
    dbPath,
    `select id, time_created, data from message where session_id = '${quotedSessionId}' ${where} order by time_created asc, id asc`,
  );
  if (!Array.isArray(messageRows) || messageRows.length === 0) return [];
  const messageIds = messageRows.map((row) => `'${quoteSqlString(row.id)}'`).join(',');
  const partRows = await runSqliteJson<OpenCodePartRow[]>(
    dbPath,
    `select id, message_id, time_created, data from part where session_id = '${quotedSessionId}' and message_id in (${messageIds}) order by time_created asc, id asc`,
  );
  return buildOpenCodeMessagesFromRows(messageRows, partRows ?? []);
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
