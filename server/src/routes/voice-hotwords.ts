/**
 * Server-synchronized voice hotwords endpoint (`/api/voice-hotwords`).
 *
 * Reuses `user_preferences` (`VOICE_HOTWORDS_PREF_KEY`) with per-user advisory
 * transaction locking, per-scope LWW timestamps, atomic merge/replace writes,
 * empty-string deletion tombstones, and participant-turn denial.
 */

import { Hono } from 'hono';
import type { Env } from '../env.js';
import { getUserPref } from '../db/queries.js';
import { requireAuth } from '../security/authorization.js';
import { daemonScopeFailure, resolveDaemonCallerAuthority } from '../security/daemon-scope.js';
import { SERVER_ID_HEADER } from '../../../shared/http-header-names.js';
import {
  VOICE_HOTWORDS_MAX_PROJECTS,
  VOICE_HOTWORDS_MAX_RAW_CHARS,
  VOICE_HOTWORDS_MAX_STORAGE_BYTES,
  VOICE_HOTWORDS_PREF_KEY,
  coerceVoiceHotwordsSyncRecord,
  compactVoiceHotwordsProjects,
  isValidVoiceHotwordProjectKey,
  mergeVoiceHotwordRawText,
  normalizeVoiceHotwordProjectKey,
  normalizeVoiceHotwordRawText,
  type VoiceHotwordsPutRequest,
  type VoiceHotwordsScopePatch,
  type VoiceHotwordsScopeState,
  type VoiceHotwordsSource,
} from '../../../shared/voice-hotwords.js';

export const voiceHotwordsRoutes = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

voiceHotwordsRoutes.use('/*', requireAuth());
voiceHotwordsRoutes.use('/*', async (c, next) => {
  const authority = await resolveDaemonCallerAuthority(c, { denyParticipant: true });
  if (!authority.ok) return daemonScopeFailure(c, authority);
  await next();
  return;
});

class VoiceHotwordsValidationError extends Error {
  constructor(
    readonly status: 400,
    readonly code: string,
  ) {
    super(code);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseTimestamp(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new VoiceHotwordsValidationError(400, 'invalid_timestamp');
  }
  return Math.floor(value);
}

function parseMode(value: unknown): 'replace' | 'merge' {
  if (value === undefined || value === 'replace') return 'replace';
  if (value === 'merge') return 'merge';
  throw new VoiceHotwordsValidationError(400, 'invalid_mode');
}

function parseScopePatch(rawPatch: unknown): VoiceHotwordsScopePatch {
  if (!isPlainObject(rawPatch)) {
    throw new VoiceHotwordsValidationError(400, 'invalid_patch');
  }
  if (typeof rawPatch.raw !== 'string') {
    throw new VoiceHotwordsValidationError(400, 'invalid_raw');
  }
  if (rawPatch.raw.length > VOICE_HOTWORDS_MAX_RAW_CHARS) {
    throw new VoiceHotwordsValidationError(400, 'raw_too_long');
  }
  const mode = parseMode(rawPatch.mode);
  const clientUpdatedAt = parseTimestamp(rawPatch.clientUpdatedAt);
  return {
    raw: rawPatch.raw,
    mode,
    ...(clientUpdatedAt !== undefined ? { clientUpdatedAt } : {}),
  };
}

function applyScopePatch(
  existing: VoiceHotwordsScopeState,
  patch: VoiceHotwordsScopePatch,
  source: VoiceHotwordsSource,
  now: number,
): { next: VoiceHotwordsScopeState; changed: boolean } {
  if (patch.clientUpdatedAt !== undefined && patch.clientUpdatedAt <= existing.updatedAt) {
    return { next: existing, changed: false };
  }
  const incomingRaw = normalizeVoiceHotwordRawText(patch.raw);
  const nextRaw = patch.mode === 'merge'
    ? mergeVoiceHotwordRawText(existing.raw, incomingRaw)
    : incomingRaw;
  if (nextRaw.length > VOICE_HOTWORDS_MAX_RAW_CHARS) {
    throw new VoiceHotwordsValidationError(400, 'raw_too_long');
  }
  const isInitialExplicitClear = existing.updatedAt === 0 && nextRaw === '' && patch.mode === 'replace';
  if (nextRaw === existing.raw && (existing.updatedAt > 0 || !isInitialExplicitClear)) {
    return { next: existing, changed: false };
  }
  const nextUpdatedAt = patch.clientUpdatedAt !== undefined
    ? patch.clientUpdatedAt
    : Math.max(existing.updatedAt + 1, now);
  return {
    next: {
      raw: nextRaw,
      updatedAt: nextUpdatedAt,
      source,
    },
    changed: true,
  };
}

async function readUserHotwordsRecord(db: Env['DB'], userId: string) {
  const raw = await getUserPref(db, userId, VOICE_HOTWORDS_PREF_KEY);
  if (!raw) return coerceVoiceHotwordsSyncRecord(null);
  try {
    return coerceVoiceHotwordsSyncRecord(JSON.parse(raw));
  } catch {
    return coerceVoiceHotwordsSyncRecord(null);
  }
}

/** GET /api/voice-hotwords?projectKey=... */
voiceHotwordsRoutes.get('/', async (c) => {
  const userId = c.get('userId' as never) as string;
  const rawProjectKey = c.req.query('projectKey');
  let projectKey: string | undefined;
  if (rawProjectKey !== undefined) {
    const normalized = normalizeVoiceHotwordProjectKey(rawProjectKey);
    if (!normalized || !isValidVoiceHotwordProjectKey(normalized)) {
      return c.json({ error: 'invalid_project_key' }, 400);
    }
    projectKey = normalized;
  }

  const record = await readUserHotwordsRecord(c.env.DB, userId);
  return c.json({
    record,
    ...(projectKey
      ? {
          projectKey,
          project: record.projects[projectKey] ?? { raw: '', updatedAt: 0 },
        }
      : {}),
  });
});

/** PUT /api/voice-hotwords */
voiceHotwordsRoutes.put('/', async (c) => {
  const userId = c.get('userId' as never) as string;

  let body: Record<string, unknown>;
  try {
    const parsed = await c.req.json();
    if (!isPlainObject(parsed)) {
      return c.json({ error: 'invalid_payload' }, 400);
    }
    body = parsed;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  let reqPatch: VoiceHotwordsPutRequest;
  try {
    const parsed: VoiceHotwordsPutRequest = {};
    if (body.user !== undefined) {
      parsed.user = parseScopePatch(body.user);
    }
    if (body.project !== undefined) {
      if (!isPlainObject(body.project)) {
        throw new VoiceHotwordsValidationError(400, 'invalid_project_patch');
      }
      const normalizedKey = typeof body.project.projectKey === 'string'
        ? normalizeVoiceHotwordProjectKey(body.project.projectKey)
        : null;
      if (!normalizedKey || !isValidVoiceHotwordProjectKey(normalizedKey)) {
        throw new VoiceHotwordsValidationError(400, 'invalid_project_key');
      }
      parsed.project = {
        projectKey: normalizedKey,
        ...parseScopePatch(body.project),
      };
    }
    if (body.projects !== undefined) {
      if (!isPlainObject(body.projects)) {
        throw new VoiceHotwordsValidationError(400, 'invalid_projects_map');
      }
      const normalizedProjects: Record<string, VoiceHotwordsScopePatch> = {};
      for (const [rawKey, val] of Object.entries(body.projects)) {
        const normalizedKey = normalizeVoiceHotwordProjectKey(rawKey);
        if (!normalizedKey || !isValidVoiceHotwordProjectKey(normalizedKey)) {
          throw new VoiceHotwordsValidationError(400, 'invalid_project_key');
        }
        normalizedProjects[normalizedKey] = parseScopePatch(val);
      }
      parsed.projects = normalizedProjects;
    }
    if (body.shareWithOthers !== undefined) {
      if (!isPlainObject(body.shareWithOthers) || typeof body.shareWithOthers.enabled !== 'boolean') {
        throw new VoiceHotwordsValidationError(400, 'invalid_share_patch');
      }
      const clientUpdatedAt = parseTimestamp(body.shareWithOthers.clientUpdatedAt);
      parsed.shareWithOthers = {
        enabled: body.shareWithOthers.enabled,
        ...(clientUpdatedAt !== undefined ? { clientUpdatedAt } : {}),
      };
    }
    reqPatch = parsed;
  } catch (err) {
    if (err instanceof VoiceHotwordsValidationError) {
      return c.json({ error: err.code }, err.status);
    }
    throw err;
  }

  const source: VoiceHotwordsSource = c.req.header(SERVER_ID_HEADER) ? 'mcp' : 'web';

  try {
    const resultRecord = await c.env.DB.transaction(async (tx) => {
      await tx.queryOne(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify([userId, VOICE_HOTWORDS_PREF_KEY])],
      );

      const current = await readUserHotwordsRecord(tx, userId);
      const now = Date.now();
      let changed = false;

      let nextUser = current.user;
      if (reqPatch.user) {
        const applied = applyScopePatch(current.user, reqPatch.user, source, now);
        nextUser = applied.next;
        if (applied.changed) changed = true;
      }

      let nextProjects = { ...current.projects };
      const projectEntries: Array<[string, VoiceHotwordsScopePatch]> = [];
      if (reqPatch.projects) {
        for (const [key, patch] of Object.entries(reqPatch.projects)) {
          projectEntries.push([key, patch]);
        }
      }
      if (reqPatch.project) {
        projectEntries.push([reqPatch.project.projectKey, reqPatch.project]);
      }

      for (const [projectKey, patch] of projectEntries) {
        const existingScope = nextProjects[projectKey] ?? { raw: '', updatedAt: 0 };
        const applied = applyScopePatch(existingScope, patch, source, now);
        if (applied.changed) {
          nextProjects[projectKey] = applied.next;
          changed = true;
        }
      }

      nextProjects = compactVoiceHotwordsProjects(nextProjects, VOICE_HOTWORDS_MAX_PROJECTS);
      if (Object.keys(nextProjects).length > VOICE_HOTWORDS_MAX_PROJECTS) {
        throw new VoiceHotwordsValidationError(400, 'too_many_projects');
      }

      let nextShare = current.shareWithOthers;
      if (reqPatch.shareWithOthers) {
        const incomingTs = reqPatch.shareWithOthers.clientUpdatedAt;
        if (incomingTs === undefined || incomingTs > current.shareWithOthers.updatedAt) {
          const isInitialExplicitFalse = current.shareWithOthers.updatedAt === 0 && !reqPatch.shareWithOthers.enabled && incomingTs !== undefined && incomingTs > 0;
          if (reqPatch.shareWithOthers.enabled !== current.shareWithOthers.enabled || current.shareWithOthers.updatedAt === 0 || isInitialExplicitFalse) {
            nextShare = {
              enabled: reqPatch.shareWithOthers.enabled,
              updatedAt: incomingTs ?? Math.max(current.shareWithOthers.updatedAt + 1, now),
            };
            changed = true;
          }
        }
      }

      const nextRecord = {
        version: 1 as const,
        user: nextUser,
        projects: nextProjects,
        shareWithOthers: nextShare,
      };

      const serialized = JSON.stringify(nextRecord);
      if (Buffer.byteLength(serialized, 'utf8') > VOICE_HOTWORDS_MAX_STORAGE_BYTES) {
        throw new VoiceHotwordsValidationError(400, 'payload_too_large');
      }

      if (changed) {
        await tx.execute(
          'INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
          [userId, VOICE_HOTWORDS_PREF_KEY, serialized, now],
        );
      }

      return nextRecord;
    });

    return c.json({ ok: true, record: resultRecord });
  } catch (err) {
    if (err instanceof VoiceHotwordsValidationError) {
      return c.json({ error: err.code }, err.status);
    }
    throw err;
  }
});
