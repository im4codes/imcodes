/**
 * Local HTTP server for agent hook callbacks.
 *
 * POST /notify  { event: "idle"|"notification"|"tool_start"|"tool_end", session, ... }
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
import { getSession, upsertSession } from '../store/session-store.js';

export const DEFAULT_HOOK_PORT = 51913;
const PORT_FILE = path.join(os.homedir(), '.imcodes', 'hook-port');

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

export async function startHookServer(onHook: HookCallback): Promise<{ server: http.Server; port: number }> {
  const preferredPort = await loadSavedPort();

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/notify') {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const msg = JSON.parse(body) as Record<string, unknown>;
        const event = msg['event'] as string | undefined;
        const session = msg['session'] as string | undefined;

        if (!event || !session) {
          res.writeHead(400);
          res.end('missing event or session');
          return;
        }

        if (event === 'idle') {
          const agentType = (msg['agentType'] as string | undefined) ?? 'unknown';
          logger.info({ session, agentType }, 'Hook: session idle');
          onHook({ event: 'idle', session, agentType });
          timelineEmitter.emit(session, 'session.state', { state: 'idle' }, { source: 'hook' });
          const sess = getSession(session);
          if (sess) upsertSession({ ...sess, state: 'idle', updatedAt: Date.now() });
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
