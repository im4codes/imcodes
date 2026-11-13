import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HOOK_SESSION_CREDENTIAL_ENV, hookCredentialHeaders } from '../../shared/hook-session-credential.js';
import { IMCODES_DAEMON_SESSION_NAME_ENV } from '../../shared/memory-mcp-env.js';
import { IMCODES_SESSION_ENV } from '../../shared/imcodes-send.js';
import { SESSION_RESOURCE_OWNER_ENV } from '../../shared/session-resource-lifecycle.js';
import {
  SHARED_MACHINE_AUTHORITY_HOOK_PATH,
  SHARED_MACHINE_AUTHORITY_STALE_RUNTIME_ERROR,
} from '../../shared/shared-machine-authority.js';
import type { SessionRecord } from '../store/session-store.js';
import { getSession, loadStore } from '../store/session-store.js';
import {
  SESSION_DB_FILE,
  SESSION_DB_LEGACY_IMPORT_DONE,
  SESSION_DB_META_LEGACY_IMPORT,
  closeSessionDb,
  openSessionDbReadOnly,
  readSessionDbMeta,
  readSessionStoreSnapshot,
} from '../store/session-store-db.js';
import { imcodesStateDir } from '../util/imcodes-state-dir.js';
import { HookAuthorityUnavailableError, resolveHookAuthority } from './hook-port.js';
import type { SessionResourceOwner } from './session-resource-registry.js';
import { sessionResourceOwnerFromEnv } from './session-resource-service.js';

export class HookRateLimitError extends Error {
  readonly name = 'HookRateLimitError';
  readonly statusCode = 429;
  readonly retryAfterMs?: number;
  readonly retryAt?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
    this.retryAt = retryAfterMs === undefined ? undefined : Date.now() + retryAfterMs;
  }
}

export async function postHookSend(
  port: number,
  body: Record<string, unknown>,
  hookPath = '/send',
  senderSessionName?: string,
  timeoutMs?: number,
  acceptStructuredError = false,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: hookPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(senderSessionName ? { 'x-imcodes-session': senderSessionName, ...hookCredentialHeaders(env) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
          const statusCode = res.statusCode ?? 500;
          const retryAfterHeader = res.headers['retry-after'];
          const retryAfterSeconds = typeof retryAfterHeader === 'string'
            ? Number(retryAfterHeader)
            : Number(Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : NaN);
          const retryAfterMs = statusCode === 429 && Number.isFinite(retryAfterSeconds)
            ? Math.max(0, Math.ceil(retryAfterSeconds * 1000))
            : typeof parsed.retryAfterMs === 'number' ? parsed.retryAfterMs : undefined;
          if (retryAfterMs !== undefined) parsed.retryAfterMs = retryAfterMs;
          if ((statusCode >= 400 || parsed.ok === false) && !acceptStructuredError) {
            if (statusCode === 429) {
              const error = new HookRateLimitError(
                typeof parsed.error === 'string' ? parsed.error : 'rate limit exceeded',
                retryAfterMs,
              );
              reject(error);
              return;
            }
            reject(new Error(typeof parsed.error === 'string' ? parsed.error : `hook send failed with status ${res.statusCode ?? 0}`));
            return;
          }
          resolve(parsed);
        } catch (err) {
          reject(err);
        }
      });
    });
    if (timeoutMs && timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`hook request timed out after ${timeoutMs}ms`));
      });
    }
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function readSessionRecordForHome(
  homeDir: string,
  sessionName: string,
): Promise<Pick<SessionRecord, 'state' | 'sessionInstanceId' | 'runtimeEpoch'> | undefined> {
  if (homeDir === imcodesStateDir(process.env)) {
    await loadStore();
    return getSession(sessionName);
  }
  const dbFile = join(homeDir, SESSION_DB_FILE);
  const reader = openSessionDbReadOnly(dbFile);
  try {
    if (reader && readSessionDbMeta(reader, SESSION_DB_META_LEGACY_IMPORT) === SESSION_DB_LEGACY_IMPORT_DONE) {
      const snapshot = readSessionStoreSnapshot(reader);
      const raw = snapshot.payloads.get(sessionName);
      if (!raw) return undefined;
      return JSON.parse(raw) as Pick<SessionRecord, 'state' | 'sessionInstanceId' | 'runtimeEpoch'>;
    }
  } finally {
    closeSessionDb(reader);
  }
  try {
    const rawJson = await readFile(join(homeDir, 'sessions.json'), 'utf8');
    const parsed = JSON.parse(rawJson) as { sessions?: Record<string, Pick<SessionRecord, 'state' | 'sessionInstanceId' | 'runtimeEpoch'>> };
    return parsed?.sessions?.[sessionName];
  } catch {
    return undefined;
  }
}

/**
 * Post a resource-owner-bound hook request, refreshing only a bumped epoch for
 * the exact session instance that owns this child.  A stale response is
 * retried only after the on-disk record proves the same instance still owns the
 * named session; never adopt a replacement that reuses the name.
 */
export function createResourceOwnerHookWithEpochRefresh(options: {
  resourceOwner: SessionResourceOwner;
  callerSessionName: string;
  hookPath: string;
  timeoutMs?: number;
  body?: Record<string, unknown>;
  staleRuntimeError: string;
  rejectStopped?: boolean;
  env?: NodeJS.ProcessEnv;
  requireHookPort: (operation: string) => Promise<number>;
}): ((body?: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  const env = options.env ?? process.env;
  let runtimeEpoch = options.resourceOwner.runtimeEpoch;
  return async (body = {}) => {
    const sendOnce = () => options.requireHookPort(options.hookPath).then((port) => postHookSend(
      port,
      {
        ...body,
        sessionInstanceId: options.resourceOwner.sessionInstanceId,
        runtimeEpoch,
      },
      options.hookPath,
      options.callerSessionName,
      options.timeoutMs,
      false,
      env,
    ));

    try {
      return await sendOnce();
    } catch (err) {
      if (!(err instanceof Error) || err.message !== options.staleRuntimeError) throw err;
      const fresh = await readSessionRecordForHome(imcodesStateDir(env), options.callerSessionName);
      if (!fresh
        || (options.rejectStopped && fresh.state === 'stopped')
        || fresh.sessionInstanceId !== options.resourceOwner.sessionInstanceId
        || !fresh.runtimeEpoch) {
        throw err;
      }
      runtimeEpoch = fresh.runtimeEpoch;
      return sendOnce();
    }
  };
}

/** Node access alone requires an explicit, coherent hook answer; an unknown reply must never borrow the daemon owner. */
export function sharedMachineAuthorityFromHookResponse(answer: Record<string, unknown>): string | null {
  if (answer.ok !== true || typeof answer.required !== 'boolean') throw new Error('shared_machine_authority_invalid_response');
  if (answer.required === false && answer.authority == null) return null;
  if (answer.required === true && typeof answer.authority === 'string' && answer.authority) return answer.authority;
  throw new Error('shared_machine_authority_invalid_response');
}

export function hasSessionContextEnv(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(
    env[IMCODES_SESSION_ENV]?.trim()
    || env[IMCODES_DAEMON_SESSION_NAME_ENV]?.trim()
    || env[SESSION_RESOURCE_OWNER_ENV.SESSION_INSTANCE_ID]?.trim()
    || env[SESSION_RESOURCE_OWNER_ENV.RUNTIME_EPOCH]?.trim()
    || env[HOOK_SESSION_CREDENTIAL_ENV]?.trim(),
  );
}

/**
 * Shared CLI + MCP default resolver for `X-IMCodes-Shared-Machine-Authority`.
 * - Outside any managed session context: returns `null` (explicit owner operation).
 * - Inside a session/delegation context: fails closed if sessionInstanceId/runtimeEpoch
 *   are missing, if daemon hook authority lookup fails, if the session is stopped, or
 *   if the daemon returns an invalid authority reply.
 */
export function createSessionSharedMachineAuthorityLoader(options: {
  env?: Record<string, string | undefined>;
  callerSessionName?: string | null;
  resourceOwner?: SessionResourceOwner | null;
  resolveHookAuthority?: typeof resolveHookAuthority;
  requireHookPort?: (operation: string) => Promise<number>;
} = {}): () => Promise<string | null> {
  const env = (options.env ?? process.env) as NodeJS.ProcessEnv;
  const effectiveOwner = options.resourceOwner !== undefined
    ? options.resourceOwner
    : sessionResourceOwnerFromEnv(env);
  const callerName = options.callerSessionName?.trim() || effectiveOwner?.sessionName || '';
  const inSessionContext = Boolean(effectiveOwner || callerName || hasSessionContextEnv(env));

  if (!inSessionContext) {
    return async () => null;
  }

  if (!effectiveOwner || !callerName) {
    return async () => {
      throw new Error('shared_machine_authority_incomplete_session_context');
    };
  }

  const resolveAuthority = options.resolveHookAuthority ?? resolveHookAuthority;
  const requireHookPort = options.requireHookPort ?? (async (operation: string): Promise<number> => {
    const resolution = await resolveAuthority({ home: imcodesStateDir(env) });
    if (resolution.ok) return resolution.port;
    throw new HookAuthorityUnavailableError(resolution.reason, operation, resolution.detail);
  });

  const postHook = createResourceOwnerHookWithEpochRefresh({
    resourceOwner: effectiveOwner,
    callerSessionName: callerName,
    hookPath: SHARED_MACHINE_AUTHORITY_HOOK_PATH,
    timeoutMs: 2_000,
    staleRuntimeError: SHARED_MACHINE_AUTHORITY_STALE_RUNTIME_ERROR,
    rejectStopped: true,
    env,
    requireHookPort,
  });

  return async () => sharedMachineAuthorityFromHookResponse(await postHook());
}
