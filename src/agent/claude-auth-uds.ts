import { lstat, access } from 'node:fs/promises';
import { constants as fsConstants, lstatSync } from 'node:fs';
import { createConnection } from 'node:net';
import { basename } from 'node:path';

/** Claude Code's documented child-process variable for its local inbox. */
export const CLAUDE_CODE_MESSAGING_SOCKET = 'CLAUDE_CODE_MESSAGING_SOCKET' as const;
/** Per-session token used by Claude Code children when posting to that inbox. */
export const CLAUDE_CODE_MESSAGING_TOKEN = 'CLAUDE_CODE_MESSAGING_TOKEN' as const;
/** Optional IM.codes-only spelling for a status-panel `uds:` address. */
export const IMCODES_CLAUDE_AUTH_UDS = 'IMCODES_CLAUDE_AUTH_UDS' as const;

const UDS_ROOT = '/tmp/cc-socks/';
const UDS_ADDRESS_PREFIX = `uds:${UDS_ROOT}`;
const SOCKET_NAME = /^[A-Za-z0-9._-]+\.sock$/;
const PROBE_TIMEOUT_MS = 750;

export interface ClaudeAuthUdsContext {
  address: string;
  socketPath: string;
  /** Only the approved Claude UDS variables; never an API key or credentials file. */
  env: Record<string, string>;
}

export interface ClaudeAuthUdsCheck {
  context?: ClaudeAuthUdsContext;
  reason?: string;
}

function socketPathFromValue(raw: string): string | undefined {
  const value = raw.trim();
  const path = value.startsWith(UDS_ADDRESS_PREFIX) ? value.slice('uds:'.length) : value;
  if (!path.startsWith(UDS_ROOT) || !SOCKET_NAME.test(basename(path))) return undefined;
  // Reject nested paths, traversal and alternate spellings. The auth contract is
  // deliberately narrower than Claude's general peer-address parser.
  if (path.slice(UDS_ROOT.length).includes('/')) return undefined;
  return path;
}

function contextFromEnv(env: NodeJS.ProcessEnv): ClaudeAuthUdsCheck {
  const raw = env[IMCODES_CLAUDE_AUTH_UDS] ?? env[CLAUDE_CODE_MESSAGING_SOCKET];
  if (!raw?.trim()) return { reason: `${CLAUDE_CODE_MESSAGING_SOCKET} is not set` };
  const socketPath = socketPathFromValue(raw);
  if (!socketPath) return { reason: 'Claude auth UDS must match uds:/tmp/cc-socks/<name>.sock' };
  try {
    const stat = lstatSync(socketPath);
    if (!stat.isSocket()) return { reason: `Claude auth UDS is not a socket: ${socketPath}` };
    if ((stat.mode & 0o077) !== 0) return { reason: `Claude auth UDS permissions are too broad: ${socketPath}` };
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid !== undefined && stat.uid !== uid) return { reason: `Claude auth UDS owner mismatch: ${socketPath}` };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return { reason: `Claude auth UDS is unavailable${code ? ` (${code})` : ''}: ${socketPath}` };
  }
  const token = env[CLAUDE_CODE_MESSAGING_TOKEN]?.trim();
  if (!token) return { reason: `${CLAUDE_CODE_MESSAGING_TOKEN} is missing for the Claude auth UDS` };
  return {
    context: {
      address: `uds:${socketPath}`,
      socketPath,
      env: {
        [CLAUDE_CODE_MESSAGING_SOCKET]: socketPath,
        ...(token ? { [CLAUDE_CODE_MESSAGING_TOKEN]: token } : {}),
      },
    },
  };
}

/**
 * Resolve the only auth context this provider is allowed to reuse. This is a
 * reachability/auth-socket check, not a credentials-file or API-key probe.
 */
export async function checkClaudeAuthUds(env: NodeJS.ProcessEnv = process.env): Promise<ClaudeAuthUdsCheck> {
  const parsed = contextFromEnv(env);
  if (!parsed.context) return parsed;
  try {
    await lstat(parsed.context.socketPath);
    await access(parsed.context.socketPath, fsConstants.R_OK | fsConstants.W_OK);
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(parsed.context!.socketPath);
      let settled = false;
      let response = '';
      let timer: ReturnType<typeof setTimeout>;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve();
      };
      timer = setTimeout(() => {
        finish(new Error('timeout'));
      }, PROBE_TIMEOUT_MS);
      timer.unref?.();
      socket.once('connect', () => {
        // Send only Claude Code's documented auth frame. No user message is
        // posted and the token is never persisted or transformed.
        socket.write(`${JSON.stringify({ type: 'auth', token: parsed.context!.env[CLAUDE_CODE_MESSAGING_TOKEN] })}\n`);
      });
      socket.on('data', (chunk: Buffer) => {
        response += chunk.toString('utf8');
        const newline = response.indexOf('\n');
        if (newline < 0) return;
        const line = response.slice(0, newline).trim();
        let frame: unknown;
        try { frame = JSON.parse(line); } catch { finish(new Error('invalid auth response')); return; }
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
          finish(new Error('invalid auth response'));
          return;
        }
        const type = (frame as { type?: unknown }).type;
        if (type === 'auth_ok') finish();
        else if (type === 'auth_error' || type === 'error') finish(new Error('auth rejected'));
        else finish(new Error('unverifiable auth response'));
      });
      socket.once('error', (error) => {
        finish(error);
      });
      socket.once('close', () => {
        if (!settled) finish(new Error('auth response ended before auth_ok'));
      });
    });
    return parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return { reason: `Claude auth UDS handshake failed${code ? ` (${code})` : ''}: ${parsed.context.socketPath}` };
  }
}

/** Synchronous child-env projection used on every SDK query and CLI/tmux launch. */
export function claudeAuthUdsEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return contextFromEnv(env).context?.env ?? {};
}
