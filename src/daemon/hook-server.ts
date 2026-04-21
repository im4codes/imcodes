/**
 * Local HTTP server for agent hook callbacks.
 *
 * POST /notify  { event: "idle"|"notification"|"tool_start"|"tool_end", session, ... }
 * POST /send    { from, to, message, files?, context?, depth? }
 *
 * Port selection:
 *   1. Load persisted port from ~/.imcodes/hook-port (remembered across restarts)
 *   2. Try to bind; if EADDRINUSE, increment and retry (up to 20 attempts)
 *   3. Save the successfully bound port back to the file
 *
 * After startHookServer() resolves, `activeHookPort` holds the actual port.
 * All hook scripts and plugins read this value at write time.
 */
import http from 'http';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import logger from '../util/logger.js';
import { timelineEmitter } from './timeline-emitter.js';
import { getSession, upsertSession, listSessions } from '../store/session-store.js';
import type { SessionRecord } from '../store/session-store.js';
import { refreshSessionWatcher } from './watcher-controls.js';

export const DEFAULT_HOOK_PORT = 51913;
const PORT_FILE = path.join(os.homedir(), '.imcodes', 'hook-port');

/** Max body size: 1 MB */
const MAX_BODY_SIZE = 1024 * 1024;

/** Queue message expiry: 5 minutes */
const QUEUE_EXPIRY_MS = 5 * 60 * 1000;
/** Max send depth (circular send prevention) */
const MAX_SEND_DEPTH = 3;
/** Rate limit: max messages per source per window */
const RATE_LIMIT_MAX = 10;
/** Rate limit window: 60 seconds */
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
/** Max broadcast recipients */
const MAX_BROADCAST_RECIPIENTS = 8;

/** The port the hook server is currently listening on. Set after startHookServer() resolves. */
export let activeHookPort: number = DEFAULT_HOOK_PORT;

export type HookPayload =
  | { event: 'idle'; session: string; agentType: string }
  | { event: 'notification'; session: string; title: string; message: string }
  | { event: 'tool_start'; session: string; tool: string }
  | { event: 'tool_end'; session: string };

export type HookCallback = (payload: HookPayload) => void;

/** @deprecated Use HookCallback instead */
export type IdleCallback = (sessionName: string, agentType: string) => void;

// ─── Queue-when-busy ─────────────────────────────────────────────────────────

export interface QueuedMessage {
  from: string;
  message: string;
  queuedAt: number;
  depth: number;
}

/** In-memory queue: target session name → queued messages (FIFO) */
const messageQueue = new Map<string, QueuedMessage[]>();

/** Rate limiter: source session → timestamps of recent sends */
const rateLimiter = new Map<string, number[]>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function loadSavedPort(): Promise<number> {
  try {
    const raw = await fs.readFile(PORT_FILE, 'utf-8');
    const p = parseInt(raw.trim(), 10);
    return Number.isFinite(p) && p > 1024 && p < 65536 ? p : DEFAULT_HOOK_PORT;
  } catch {
    return DEFAULT_HOOK_PORT;
  }
}

async function savePort(port: number): Promise<void> {
  await fs.mkdir(path.dirname(PORT_FILE), { recursive: true });
  await fs.writeFile(PORT_FILE, String(port));
}

function tryBind(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function extractToolSummary(tool: string, input?: Record<string, unknown>): string {
  if (!input) return '';
  switch (tool) {
    case 'Bash': {
      const cmd = String(input['command'] ?? '');
      return cmd.split('\n').find((l) => l.trim()) ?? cmd;
    }
    case 'Read':
    case 'Write':
    case 'Edit':
      return String(input['file_path'] ?? '');
    case 'Glob':
      return String(input['pattern'] ?? '');
    case 'Grep':
      return `${input['pattern'] ?? ''}${input['path'] ? ` in ${input['path']}` : ''}`;
    case 'Agent':
      return String(input['description'] ?? '');
    default:
      return '';
  }
}

// ─── Target Resolution ───────────────────────────────────────────────────────

export type ResolveResult = {
  ok: true;
  targets: SessionRecord[];
} | {
  ok: false;
  error: string;
  available: string[];
}

/**
 * Resolve a target session name from the `to` field.
 * Priority: label (case-insensitive) → session name → agent type.
 * Scope: siblings of `from` session (same parentSession or same project).
 */
export function resolveTarget(from: string, to: string): ResolveResult {
  const fromRecord = getSession(from);
  if (!fromRecord) {
    return { ok: false, error: 'sender session not found', available: [] };
  }

  // Determine siblings: sessions sharing the same parent or project (exclude stopped)
  const allSessions = listSessions();
  const siblings = allSessions.filter((s) => {
    if (s.name === from) return false; // exclude self
    if (s.state === 'stopped') return false; // exclude stopped sessions
    // Sub-sessions: match by parentSession
    if (fromRecord.parentSession) {
      return s.parentSession === fromRecord.parentSession || s.name === fromRecord.parentSession;
    }
    // Main sessions: match by projectName
    return s.projectName === fromRecord.projectName || s.parentSession === from;
  });

  const availableNames = siblings.map((s) => s.label || s.name);

  if (to === '*' || to === '--all') {
    const targets = siblings.slice(0, MAX_BROADCAST_RECIPIENTS);
    if (targets.length === 0) {
      return { ok: false, error: 'no sibling sessions found', available: availableNames };
    }
    return { ok: true, targets };
  }

  // 1. Match by label (case-insensitive)
  const byLabel = siblings.filter((s) => s.label && s.label.toLowerCase() === to.toLowerCase());
  if (byLabel.length === 1) return { ok: true, targets: [byLabel[0]] };
  if (byLabel.length > 1) {
    return { ok: false, error: `ambiguous target "${to}" matches ${byLabel.length} sessions`, available: availableNames };
  }

  // 2. Match by session name (exact, siblings only — no cross-project)
  const byName = siblings.filter((s) => s.name === to);
  if (byName.length === 1) return { ok: true, targets: [byName[0]] };

  // 3. Match by agent type
  const byType = siblings.filter((s) => s.agentType === to);
  if (byType.length === 1) return { ok: true, targets: [byType[0]] };
  if (byType.length > 1) {
    return { ok: false, error: `ambiguous target "${to}" matches ${byType.length} sessions by agent type`, available: availableNames };
  }

  return { ok: false, error: `target "${to}" not found`, available: availableNames };
}

// ─── Message Dispatch ────────────────────────────────────────────────────────

/**
 * Send a message to a target session.
 * Process sessions: sendKeys via tmux.
 * Transport sessions: runtime.send().
 */
async function dispatchMessage(target: SessionRecord, message: string): Promise<void> {
  if (target.runtimeType === 'transport') {
    const { getTransportRuntime } = await import('../agent/session-manager.js');
    const runtime = getTransportRuntime(target.name);
    if (!runtime) throw new Error(`no transport runtime for session ${target.name}`);
    await runtime.send(message);
    return;
  }

  // Process session: route through the same session.send pipeline as the web UI
  // so CLI/hook sends keep recall, path rewriting, timeline emission, and other
  // daemon-side behaviors in sync.
  const { sendProcessSessionMessageForAutomation } = await import('./command-handler.js');
  await sendProcessSessionMessageForAutomation(target.name, message);
}

// ─── Circuit Breakers ────────────────────────────────────────────────────────

function checkRateLimit(from: string): boolean {
  const now = Date.now();
  const timestamps = rateLimiter.get(from) ?? [];
  const recent = timestamps.filter((t) => t > now - RATE_LIMIT_WINDOW_MS);
  rateLimiter.set(from, recent);
  return recent.length < RATE_LIMIT_MAX;
}

function recordSend(from: string): void {
  const timestamps = rateLimiter.get(from) ?? [];
  timestamps.push(Date.now());
  rateLimiter.set(from, timestamps);
}

/**
 * Drain queued messages for a session that just became idle.
 * Delivers FIFO, skipping expired messages.
 */
export async function drainQueue(sessionName: string): Promise<void> {
  const queue = messageQueue.get(sessionName);
  if (!queue || queue.length === 0) return;

  const now = Date.now();

  // Drain ONE message at a time. After sending, the session goes running → idle,
  // which triggers drainQueue again for the next message. This prevents burst-injecting
  // the entire backlog into a session that can only process one message at a time.
  while (queue.length > 0) {
    const msg = queue.shift()!;
    if (now - msg.queuedAt > QUEUE_EXPIRY_MS) {
      logger.debug({ target: sessionName, from: msg.from }, 'Skipping expired queued message');
      continue; // skip expired, try next
    }
    // Found a non-expired message — deliver it and stop
    const record = getSession(sessionName);
    if (!record) break;
    try {
      await dispatchMessage(record, msg.message);
      logger.info({ target: sessionName, from: msg.from }, 'Delivered queued message');
    } catch (err) {
      logger.warn({ err, target: sessionName, from: msg.from }, 'Failed to deliver queued message');
    }
    // Stop after one delivery — next idle transition will drain the next message
    break;
  }
  // Clean up empty queue entry
  if (queue.length === 0) messageQueue.delete(sessionName);
}

/** Get current queue for a target (for testing) */
export function getQueue(target: string): QueuedMessage[] {
  return messageQueue.get(target) ?? [];
}

/** Clear all queues (for testing) */
export function clearQueues(): void {
  messageQueue.clear();
  rateLimiter.clear();
}

// ─── /send Handler ───────────────────────────────────────────────────────────

interface SendRequest {
  from: string;
  to: string;
  message: string;
  files?: string[];
  context?: string;
  depth?: number;
}

async function handleSend(body: SendRequest): Promise<{ status: number; body: Record<string, unknown> }> {
  const { from, to, message, depth = 0 } = body;

  // Validate required fields
  if (!from || !to || !message) {
    return { status: 400, body: { ok: false, error: 'missing required fields: from, to, message' } };
  }

  // Reject unsupported fields until Phase 2 implementation
  if ((body.files && body.files.length > 0) || body.context) {
    return { status: 501, body: { ok: false, error: 'files and context are not yet supported — send plain message only' } };
  }

  // Circuit breaker: depth limit
  if (depth >= MAX_SEND_DEPTH) {
    return { status: 429, body: { ok: false, error: 'depth limit exceeded' } };
  }

  // Circuit breaker: rate limit
  if (!checkRateLimit(from)) {
    return { status: 429, body: { ok: false, error: 'rate limit exceeded' } };
  }

  // Resolve target
  const result = resolveTarget(from, to);
  if (!result.ok) {
    return { status: 404, body: { ok: false, error: result.error, available: result.available } };
  }

  // Record send after successful resolution (prevents invalid senders from polluting rate-limit map)
  recordSend(from);

  // Deliver to each target — always send immediately (no queue-when-busy)
  const delivered: string[] = [];
  const queued: string[] = [];
  const errors: string[] = [];

  for (const target of result.targets) {
    try {
      await dispatchMessage(target, message);
      delivered.push(target.name);
    } catch (err) {
      errors.push(`${target.name}: ${(err as Error).message}`);
    }
  }

  if (result.targets.length === 1) {
    const target = result.targets[0].name;
    if (delivered.length === 1) {
      return { status: 200, body: { ok: true, delivered: true, target } };
    }
    if (queued.length === 1) {
      return { status: 200, body: { ok: true, queued: true, target } };
    }
    return { status: 500, body: { ok: false, error: errors[0] ?? 'dispatch failed' } };
  }

  // Broadcast response
  return {
    status: 200,
    body: {
      ok: errors.length === 0,
      delivered,
      queued,
      ...(errors.length > 0 ? { errors } : {}),
    },
  };
}

// ─── Body Parser ─────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        rejected = true;
        reject(new Error('body too large'));
        req.resume(); // drain remaining data without storing
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => {
      if (!rejected) resolve(body);
    });
    req.on('error', (err) => {
      if (!rejected) reject(err);
    });
  });
}

// ─── Server ──────────────────────────────────────────────────────────────────

export async function startHookServer(onHook: HookCallback): Promise<{ server: http.Server; port: number }> {
  const preferredPort = await loadSavedPort();

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }

    const url = req.url;

    if (url === '/list') {
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as { from?: string };
        const from = parsed.from || '';
        const fromRecord = from ? getSession(from) : null;
        const allSess = listSessions();
        const siblings = fromRecord
          ? allSess.filter((s) => {
              if (s.name === from) return false;
              if (s.state === 'stopped') return false;
              if (fromRecord.parentSession) {
                return s.parentSession === fromRecord.parentSession || s.name === fromRecord.parentSession;
              }
              return s.projectName === fromRecord.projectName || s.parentSession === from;
            })
          : allSess.filter((s) => s.state !== 'stopped');
        const sessions = siblings.map((s) => ({
          name: s.name,
          label: s.label || undefined,
          agentType: s.agentType,
          state: s.state,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sessions }));
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: 'bad request' }));
      }
      return;
    }

    if (url === '/send') {
      // Content-Type validation for /send
      const contentType = req.headers['content-type'] ?? '';
      if (!contentType.includes('application/json')) {
        res.writeHead(415);
        res.end(JSON.stringify({ ok: false, error: 'Content-Type must be application/json' }));
        return;
      }

      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as SendRequest;
        const result = await handleSend(parsed);
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
      } catch (err) {
        if ((err as Error).message === 'body too large') {
          res.writeHead(413);
          res.end(JSON.stringify({ ok: false, error: 'request body too large' }));
        } else {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'bad request' }));
        }
      }
      return;
    }

    if (url === '/notify') {
      // /notify handler — existing CC hook behavior (no Content-Type enforcement)
      let body = '';
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_SIZE) {
          req.destroy();
          return;
        }
        body += chunk.toString();
      });
      req.on('end', async () => {
        try {
          const msg = JSON.parse(body) as Record<string, unknown>;
          const event = msg['event'] as string | undefined;
          const session = msg['session'] as string | undefined;

          if (!event || !session) {
            res.writeHead(400);
            res.end('missing event or session');
            return;
          }

          // Layer 2: verify session belongs to a daemon-managed CC session.
          // Hooks are global (~/.claude/settings.json) so any CC instance triggers
          // them. Without this check, a manually-started CC whose tmux pane happens
          // to live in a deck_ session would misroute events.
          const record = getSession(session);
          if (!record || record.agentType !== 'claude-code') {
            logger.debug({ session, event, agentType: record?.agentType }, 'Hook: ignored — not a managed claude-code session');
            res.writeHead(200);
            res.end('ignored');
            return;
          }

          if (event === 'idle') {
            const agentType = (msg['agentType'] as string | undefined) ?? 'unknown';
            logger.info({ session, agentType }, 'Hook: session idle');
            await refreshSessionWatcher(session);
            onHook({ event: 'idle', session, agentType });
            timelineEmitter.emit(session, 'session.state', { state: 'idle' }, { source: 'hook' });
            const sess = getSession(session);
            if (sess) upsertSession({ ...sess, state: 'idle', updatedAt: Date.now() });
            // Drain queued messages when session becomes idle
            void drainQueue(session);
          } else if (event === 'notification') {
            const title = (msg['title'] as string | undefined) ?? '';
            const message = (msg['message'] as string | undefined) ?? '';
            logger.info({ session, title }, 'Hook: CC notification');
            onHook({ event: 'notification', session, title, message });
          } else if (event === 'tool_start') {
            const tool = (msg['tool'] as string | undefined) ?? 'unknown';
            const toolInput = msg['tool_input'] as Record<string, unknown> | undefined;
            const input = extractToolSummary(tool, toolInput);
            logger.debug({ session, tool }, 'Hook: tool start');
            onHook({ event: 'tool_start', session, tool });
            timelineEmitter.emit(session, 'session.state', { state: 'running' }, { source: 'hook' });
            timelineEmitter.emit(session, 'tool.call', { tool, ...(input ? { input } : {}) }, { source: 'hook' });
          } else if (event === 'tool_end') {
            logger.debug({ session }, 'Hook: tool end');
            onHook({ event: 'tool_end', session });
            timelineEmitter.emit(session, 'tool.result', {}, { source: 'hook' });
          } else if (event === 'mode_change') {
            const mode = (msg['mode'] as string | undefined) ?? '';
            const active = msg['active'] !== false;
            logger.debug({ session, mode, active }, 'Hook: mode change');
            timelineEmitter.emit(session, 'mode.state', { mode, active }, { source: 'hook' });
          }

          res.writeHead(200);
          res.end('ok');
        } catch {
          res.writeHead(400);
          res.end('bad request');
        }
      });
      return;
    }

    // Unknown route
    res.writeHead(404);
    res.end();
  });

  // Try preferred port first, then increment on conflict
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = preferredPort + attempt;
    try {
      await tryBind(server, port);
      activeHookPort = port;
      await savePort(port);
      if (port !== preferredPort) {
        logger.info({ port, preferredPort }, 'Hook server: port conflict, using new port (saved)');
      } else {
        logger.info({ port }, 'Hook server listening');
      }
      return { server, port };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      logger.debug({ port }, 'Hook server: port in use, trying next');
    }
  }

  throw new Error(`Hook server: could not bind to any port in range ${preferredPort}–${preferredPort + 19}`);
}
