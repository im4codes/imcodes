/**
 * Server-synchronized voice hotwords endpoint (`/api/voice-hotwords`).
 *
 * Reuses `user_preferences` (`VOICE_HOTWORDS_PREF_KEY`) with per-user advisory
 * transaction locking, null-prototype project dictionaries, per-scope LWW timestamps
 * with clock-skew clamping, atomic merge/replace writes, tombstone preservation,
 * and participant-turn denial.
 */

import { Hono } from 'hono';
import type { Env } from '../env.js';
import { getUserPref } from '../db/queries.js';
import { requireAuth } from '../security/authorization.js';
import { daemonScopeFailure, resolveDaemonCallerAuthority } from '../security/daemon-scope.js';
import { SERVER_ID_HEADER } from '../../../shared/http-header-names.js';
import {
  VOICE_HOTWORDS_CAPACITY_ERRORS,
  VOICE_HOTWORDS_MAX_CLOCK_SKEW_MS,
  VOICE_HOTWORDS_MAX_ENTRIES,
  VOICE_HOTWORDS_MAX_RAW_CHARS,
  VOICE_HOTWORDS_MAX_STORAGE_BYTES,
  VOICE_HOTWORDS_PREF_KEY,
  canStoreVoiceHotwordProjectKey,
  coerceVoiceHotwordsSyncRecord,
  createNullProtoDict,
  decodeVoiceHotwordProjectKey,
  encodeVoiceHotwordProjectKey,
  entriesToVoiceHotwordRawText,
  getOwnDictValue,
  hasOwnDictKey,
  isValidVoiceHotwordProjectKey,
  mergeVoiceHotwordRawText,
  mergeVoiceHotwords,
  normalizeVoiceHotwordProjectKey,
  normalizeVoiceHotwordRawText,
  setOwnDictValue,
  type VoiceHotwordsAppliedScopes,
  type VoiceHotwordsScopePatch,
  type VoiceHotwordsScopeState,
  type VoiceHotwordsSharePatch,
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

function assertAllowedKeys(obj: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      throw new VoiceHotwordsValidationError(400, 'unknown_field');
    }
  }
}

function parseTimestamp(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new VoiceHotwordsValidationError(400, 'invalid_timestamp');
  }
  return value;
}

function parseMode(value: unknown, defaultMode: 'replace' | 'merge' = 'replace'): 'replace' | 'merge' {
  if (value === undefined) return defaultMode;
  if (value === 'replace' || value === 'merge') return value;
  throw new VoiceHotwordsValidationError(400, 'invalid_mode');
}

function parseWriteId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new VoiceHotwordsValidationError(400, 'invalid_write_id');
  }
  return value;
}

function resolveRawInput(raw: unknown, entries: unknown): string {
  const hasRaw = raw !== undefined;
  const hasEntries = entries !== undefined;
  if (hasRaw && hasEntries) {
    throw new VoiceHotwordsValidationError(400, 'conflicting_fields');
  }
  if (!hasRaw && !hasEntries) {
    throw new VoiceHotwordsValidationError(400, 'missing_hotwords');
  }
  if (hasRaw) {
    if (typeof raw !== 'string') {
      throw new VoiceHotwordsValidationError(400, 'invalid_raw');
    }
    if (raw.length > VOICE_HOTWORDS_MAX_RAW_CHARS) {
      throw new VoiceHotwordsValidationError(400, 'raw_too_long');
    }
    return raw;
  }
  if (!Array.isArray(entries)) {
    throw new VoiceHotwordsValidationError(400, 'invalid_entries');
  }
  if (entries.length > VOICE_HOTWORDS_MAX_ENTRIES) {
    throw new VoiceHotwordsValidationError(400, 'too_many_entries');
  }
  for (const item of entries) {
    if (typeof item !== 'string') {
      throw new VoiceHotwordsValidationError(400, 'invalid_entries');
    }
  }
  const joined = entriesToVoiceHotwordRawText(entries);
  if (joined.length > VOICE_HOTWORDS_MAX_RAW_CHARS) {
    throw new VoiceHotwordsValidationError(400, 'raw_too_long');
  }
  return joined;
}

function resolveProjectTargetFromParams(params: {
  projectKey?: unknown;
  projectName?: unknown;
  serverId?: unknown;
}): string {
  const hasKey = params.projectKey !== undefined;
  const hasName = params.projectName !== undefined;
  const hasServer = params.serverId !== undefined;

  if (hasKey && typeof params.projectKey !== 'string') {
    throw new VoiceHotwordsValidationError(400, 'invalid_project_key');
  }
  if (hasName && typeof params.projectName !== 'string') {
    throw new VoiceHotwordsValidationError(400, 'invalid_project_key');
  }
  if (hasServer && typeof params.serverId !== 'string') {
    throw new VoiceHotwordsValidationError(400, 'invalid_project_key');
  }

  let fromKey: string | null = null;
  if (hasKey) {
    fromKey = normalizeVoiceHotwordProjectKey(params.projectKey as string);
    if (!fromKey || !isValidVoiceHotwordProjectKey(fromKey)) {
      throw new VoiceHotwordsValidationError(400, 'invalid_project_key');
    }
  }

  let fromName: string | null = null;
  if (hasName) {
    fromName = encodeVoiceHotwordProjectKey(
      params.projectName as string,
      hasServer ? (params.serverId as string) : null,
    );
    if (!fromName || !isValidVoiceHotwordProjectKey(fromName)) {
      throw new VoiceHotwordsValidationError(400, 'invalid_project_key');
    }
  } else if (hasServer && !hasKey) {
    throw new VoiceHotwordsValidationError(400, 'missing_project_name');
  }

  if (fromKey && fromName && fromKey !== fromName) {
    throw new VoiceHotwordsValidationError(400, 'conflicting_project_target');
  }
  if (fromKey && hasServer && !hasName) {
    const decoded = decodeVoiceHotwordProjectKey(fromKey);
    const cleanServer = (params.serverId as string).trim();
    if (cleanServer && decoded?.serverId !== cleanServer) {
      throw new VoiceHotwordsValidationError(400, 'conflicting_project_target');
    }
  }

  const resolved = fromKey ?? fromName;
  if (!resolved) {
    throw new VoiceHotwordsValidationError(400, 'invalid_project_key');
  }
  return resolved;
}

function parseScopePatch(rawPatch: unknown, allowProjectFields = false): VoiceHotwordsScopePatch {
  if (!isPlainObject(rawPatch)) {
    throw new VoiceHotwordsValidationError(400, 'invalid_patch');
  }
  assertAllowedKeys(
    rawPatch,
    allowProjectFields
      ? ['projectKey', 'serverId', 'projectName', 'raw', 'entries', 'mode', 'clientUpdatedAt', 'baseUpdatedAt', 'writeId']
      : ['raw', 'entries', 'mode', 'clientUpdatedAt', 'baseUpdatedAt', 'writeId'],
  );
  const raw = resolveRawInput(rawPatch.raw, rawPatch.entries);
  const mode = parseMode(rawPatch.mode);
  const clientUpdatedAt = parseTimestamp(rawPatch.clientUpdatedAt);
  const baseUpdatedAt = parseTimestamp(rawPatch.baseUpdatedAt);
  const writeId = parseWriteId(rawPatch.writeId);
  return {
    raw,
    mode,
    ...(clientUpdatedAt !== undefined ? { clientUpdatedAt } : {}),
    ...(baseUpdatedAt !== undefined ? { baseUpdatedAt } : {}),
    ...(writeId !== undefined ? { writeId } : {}),
  };
}

function applyScopePatch(
  existing: VoiceHotwordsScopeState,
  patch: VoiceHotwordsScopePatch,
  source: VoiceHotwordsSource,
  now: number,
): { next: VoiceHotwordsScopeState; changed: boolean; applied: boolean } {
  const incomingRaw = normalizeVoiceHotwordRawText(patch.raw);
  const nextRaw = patch.mode === 'merge'
    ? mergeVoiceHotwordRawText(existing.raw, incomingRaw)
    : incomingRaw;
  if (nextRaw.length > VOICE_HOTWORDS_MAX_RAW_CHARS) {
    throw new VoiceHotwordsValidationError(400, 'raw_too_long');
  }

  if (patch.baseUpdatedAt !== undefined) {
    if (patch.baseUpdatedAt !== existing.updatedAt) {
      if (patch.writeId && existing.lastWriteId === patch.writeId) {
        return { next: existing, changed: false, applied: true };
      }
      return { next: existing, changed: false, applied: false };
    }
    if (patch.mode === 'merge' && !incomingRaw && existing.updatedAt > 0 && nextRaw === existing.raw) {
      return { next: existing, changed: false, applied: true };
    }
    return {
      next: {
        raw: nextRaw,
        updatedAt: Math.max(existing.updatedAt + 1, now),
        source,
        ...(patch.writeId ? { lastWriteId: patch.writeId } : {}),
      },
      changed: true,
      applied: true,
    };
  }

  if (patch.writeId && existing.lastWriteId === patch.writeId) {
    return { next: existing, changed: false, applied: true };
  }

  const cappedIncoming = patch.clientUpdatedAt !== undefined
    ? Math.min(patch.clientUpdatedAt, now + VOICE_HOTWORDS_MAX_CLOCK_SKEW_MS)
    : undefined;

  if (cappedIncoming !== undefined && existing.updatedAt > 0 && cappedIncoming <= existing.updatedAt) {
    // Strictly stale or tie: server wins
    return { next: existing, changed: false, applied: false };
  }

  if (patch.mode === 'merge' && !incomingRaw && existing.updatedAt > 0 && nextRaw === existing.raw) {
    return { next: existing, changed: false, applied: true };
  }

  const nextUpdatedAt = cappedIncoming !== undefined
    ? Math.max(existing.updatedAt + 1, cappedIncoming || now)
    : Math.max(existing.updatedAt + 1, now);

  return {
    next: {
      raw: nextRaw,
      updatedAt: nextUpdatedAt,
      source,
      ...(patch.writeId ? { lastWriteId: patch.writeId } : {}),
    },
    changed: true,
    applied: true,
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

interface ParsedPutPlan {
  reqScope?: 'user' | 'project' | 'share' | 'sync';
  singleProjectKey?: string;
  user?: VoiceHotwordsScopePatch;
  projects: Record<string, VoiceHotwordsScopePatch>;
  shareWithOthers?: VoiceHotwordsSharePatch;
}

function parsePutRequest(body: Record<string, unknown>): ParsedPutPlan {
  const projects = createNullProtoDict<VoiceHotwordsScopePatch>();
  if (Object.keys(body).length === 0) {
    throw new VoiceHotwordsValidationError(400, 'empty_patch');
  }

  if (body.scope !== undefined) {
    if (body.scope === 'user') {
      assertAllowedKeys(body, ['scope', 'raw', 'entries', 'mode', 'clientUpdatedAt', 'baseUpdatedAt', 'writeId']);
      const baseUpdatedAt = parseTimestamp(body.baseUpdatedAt);
      const clientUpdatedAt = parseTimestamp(body.clientUpdatedAt);
      const writeId = parseWriteId(body.writeId);
      return {
        reqScope: 'user',
        user: {
          raw: resolveRawInput(body.raw, body.entries),
          mode: parseMode(body.mode),
          ...(clientUpdatedAt !== undefined ? { clientUpdatedAt } : {}),
          ...(baseUpdatedAt !== undefined ? { baseUpdatedAt } : {}),
          ...(writeId !== undefined ? { writeId } : {}),
        },
        projects,
      };
    }

    if (body.scope === 'project') {
      assertAllowedKeys(body, ['scope', 'projectKey', 'serverId', 'projectName', 'raw', 'entries', 'mode', 'clientUpdatedAt', 'baseUpdatedAt', 'writeId']);
      const key = resolveProjectTargetFromParams({
        projectKey: body.projectKey,
        projectName: body.projectName,
        serverId: body.serverId,
      });
      const baseUpdatedAt = parseTimestamp(body.baseUpdatedAt);
      const clientUpdatedAt = parseTimestamp(body.clientUpdatedAt);
      const writeId = parseWriteId(body.writeId);
      setOwnDictValue(projects, key, {
        raw: resolveRawInput(body.raw, body.entries),
        mode: parseMode(body.mode),
        ...(clientUpdatedAt !== undefined ? { clientUpdatedAt } : {}),
        ...(baseUpdatedAt !== undefined ? { baseUpdatedAt } : {}),
        ...(writeId !== undefined ? { writeId } : {}),
      });
      return {
        reqScope: 'project',
        singleProjectKey: key,
        projects,
      };
    }

    if (body.scope === 'share') {
      assertAllowedKeys(body, ['scope', 'enabled', 'clientUpdatedAt', 'baseUpdatedAt', 'writeId']);
      if (typeof body.enabled !== 'boolean') {
        throw new VoiceHotwordsValidationError(400, 'invalid_share_patch');
      }
      const clientUpdatedAt = parseTimestamp(body.clientUpdatedAt);
      const baseUpdatedAt = parseTimestamp(body.baseUpdatedAt);
      const writeId = parseWriteId(body.writeId);
      return {
        reqScope: 'share',
        projects,
        shareWithOthers: {
          enabled: body.enabled,
          ...(clientUpdatedAt !== undefined ? { clientUpdatedAt } : {}),
          ...(baseUpdatedAt !== undefined ? { baseUpdatedAt } : {}),
          ...(writeId !== undefined ? { writeId } : {}),
        },
      };
    }

    if (body.scope !== 'sync') {
      throw new VoiceHotwordsValidationError(400, 'invalid_scope');
    }
    assertAllowedKeys(body, ['scope', 'user', 'project', 'projects', 'shareWithOthers']);
  } else {
    assertAllowedKeys(body, ['user', 'project', 'projects', 'shareWithOthers']);
  }

  const plan: ParsedPutPlan = {
    ...(body.scope === 'sync' ? { reqScope: 'sync' as const } : {}),
    projects,
  };
  let hasAnyNested = false;

  if (body.user !== undefined) {
    plan.user = parseScopePatch(body.user, false);
    hasAnyNested = true;
  }
  if (body.project !== undefined) {
    if (!isPlainObject(body.project)) {
      throw new VoiceHotwordsValidationError(400, 'invalid_project_patch');
    }
    const key = resolveProjectTargetFromParams({
      projectKey: body.project.projectKey,
      projectName: body.project.projectName,
      serverId: body.project.serverId,
    });
    setOwnDictValue(projects, key, parseScopePatch(body.project, true));
    plan.singleProjectKey = key;
    hasAnyNested = true;
  }
  if (body.projects !== undefined) {
    if (!isPlainObject(body.projects)) {
      throw new VoiceHotwordsValidationError(400, 'invalid_projects_map');
    }
    for (const [rawKey, val] of Object.entries(body.projects)) {
      const normalizedKey = normalizeVoiceHotwordProjectKey(rawKey);
      if (!normalizedKey || !isValidVoiceHotwordProjectKey(normalizedKey)) {
        throw new VoiceHotwordsValidationError(400, 'invalid_project_key');
      }
      setOwnDictValue(projects, normalizedKey, parseScopePatch(val, false));
    }
    hasAnyNested = true;
  }
  if (body.shareWithOthers !== undefined) {
    if (!isPlainObject(body.shareWithOthers) || typeof body.shareWithOthers.enabled !== 'boolean') {
      throw new VoiceHotwordsValidationError(400, 'invalid_share_patch');
    }
    assertAllowedKeys(body.shareWithOthers, ['enabled', 'clientUpdatedAt', 'baseUpdatedAt', 'writeId']);
    const clientUpdatedAt = parseTimestamp(body.shareWithOthers.clientUpdatedAt);
    const baseUpdatedAt = parseTimestamp(body.shareWithOthers.baseUpdatedAt);
    const writeId = parseWriteId(body.shareWithOthers.writeId);
    plan.shareWithOthers = {
      enabled: body.shareWithOthers.enabled,
      ...(clientUpdatedAt !== undefined ? { clientUpdatedAt } : {}),
      ...(baseUpdatedAt !== undefined ? { baseUpdatedAt } : {}),
      ...(writeId !== undefined ? { writeId } : {}),
    };
    hasAnyNested = true;
  }

  if (!hasAnyNested) {
    throw new VoiceHotwordsValidationError(400, 'empty_patch');
  }
  if (body.projects !== undefined) {
    delete plan.singleProjectKey;
  }
  return plan;
}

/** GET /api/voice-hotwords?projectKey=... or ?serverId=...&projectName=... */
voiceHotwordsRoutes.get('/', async (c) => {
  const userId = c.get('userId' as never) as string;
  const rawProjectKey = c.req.query('projectKey');
  const rawProjectName = c.req.query('projectName');
  const rawServerId = c.req.query('serverId');

  let projectKey: string | undefined;
  if (rawProjectKey !== undefined || rawProjectName !== undefined || rawServerId !== undefined) {
    try {
      projectKey = resolveProjectTargetFromParams({
        projectKey: rawProjectKey,
        projectName: rawProjectName,
        serverId: rawServerId,
      });
    } catch (err) {
      if (err instanceof VoiceHotwordsValidationError) {
        return c.json({ error: err.code }, err.status);
      }
      throw err;
    }
  }

  const record = await readUserHotwordsRecord(c.env.DB, userId);
  if (!projectKey) {
    return c.json({ record });
  }
  const project = getOwnDictValue(record.projects, projectKey) ?? { raw: '', updatedAt: 0 };
  const compiled = mergeVoiceHotwords({
    projectRaw: project.raw,
    globalRaw: record.user.raw,
  });
  return c.json({
    record,
    projectKey,
    project,
    compiled,
  });
});

/** PUT /api/voice-hotwords */
voiceHotwordsRoutes.put('/', async (c) => {
  const userId = c.get('userId' as never) as string;

  const rawBodyText = await c.req.text();
  if (Buffer.byteLength(rawBodyText, 'utf8') > VOICE_HOTWORDS_MAX_STORAGE_BYTES) {
    return c.json({ error: 'payload_too_large' }, 400);
  }

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBodyText);
    if (!isPlainObject(parsed)) {
      return c.json({ error: 'invalid_payload' }, 400);
    }
    body = parsed;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  let plan: ParsedPutPlan;
  try {
    plan = parsePutRequest(body);
  } catch (err) {
    if (err instanceof VoiceHotwordsValidationError) {
      return c.json({ error: err.code }, err.status);
    }
    throw err;
  }

  const source: VoiceHotwordsSource = c.req.header(SERVER_ID_HEADER) ? 'mcp' : 'web';

  try {
    const { record: resultRecord, appliedScopes } = await c.env.DB.transaction(async (tx) => {
      await tx.queryOne(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify([userId, VOICE_HOTWORDS_PREF_KEY])],
      );

      const current = await readUserHotwordsRecord(tx, userId);
      const now = Date.now();
      let changed = false;
      const appliedScopes: VoiceHotwordsAppliedScopes = {};

      let nextUser = current.user;
      if (plan.user) {
        const res = applyScopePatch(current.user, plan.user, source, now);
        nextUser = res.next;
        appliedScopes.user = res.applied;
        if (res.changed) changed = true;
      }

      const nextProjects = createNullProtoDict<VoiceHotwordsScopeState>();
      for (const key of Object.keys(current.projects)) {
        const existingVal = getOwnDictValue(current.projects, key);
        if (existingVal) setOwnDictValue(nextProjects, key, existingVal);
      }

      const projectKeys = Object.keys(plan.projects);
      if (projectKeys.length > 0) {
        const appliedProjects = createNullProtoDict<boolean>();
        for (const projectKey of projectKeys) {
          const patch = getOwnDictValue(plan.projects, projectKey);
          if (!patch) continue;
          if (!canStoreVoiceHotwordProjectKey(nextProjects, projectKey)) {
            throw new VoiceHotwordsValidationError(400, VOICE_HOTWORDS_CAPACITY_ERRORS.TOO_MANY_PROJECTS);
          }
          const existingScope = hasOwnDictKey(nextProjects, projectKey)
            ? (getOwnDictValue(nextProjects, projectKey) ?? { raw: '', updatedAt: 0 })
            : { raw: '', updatedAt: 0 };
          const res = applyScopePatch(existingScope, patch, source, now);
          setOwnDictValue(appliedProjects, projectKey, res.applied);
          if (res.changed) {
            setOwnDictValue(nextProjects, projectKey, res.next);
            changed = true;
          }
        }
        appliedScopes.projects = appliedProjects;
      }

      let nextShare = current.shareWithOthers;
      if (plan.shareWithOthers) {
        const sharePatch = plan.shareWithOthers;
        let shareApplied = false;
        if (sharePatch.baseUpdatedAt !== undefined) {
          if (sharePatch.baseUpdatedAt === current.shareWithOthers.updatedAt) {
            nextShare = {
              enabled: sharePatch.enabled,
              updatedAt: Math.max(current.shareWithOthers.updatedAt + 1, now),
              ...(sharePatch.writeId ? { lastWriteId: sharePatch.writeId } : {}),
            };
            changed = true;
            shareApplied = true;
          } else if (sharePatch.writeId && current.shareWithOthers.lastWriteId === sharePatch.writeId) {
            shareApplied = true;
          }
        } else if (sharePatch.writeId && current.shareWithOthers.lastWriteId === sharePatch.writeId) {
          shareApplied = true;
        } else {
          const cappedShareTs = sharePatch.clientUpdatedAt !== undefined
            ? Math.min(sharePatch.clientUpdatedAt, now + VOICE_HOTWORDS_MAX_CLOCK_SKEW_MS)
            : undefined;
          if (cappedShareTs === undefined || current.shareWithOthers.updatedAt === 0 || cappedShareTs > current.shareWithOthers.updatedAt) {
            const nextTs = cappedShareTs !== undefined
              ? Math.max(current.shareWithOthers.updatedAt + 1, cappedShareTs || now)
              : Math.max(current.shareWithOthers.updatedAt + 1, now);
            nextShare = {
              enabled: sharePatch.enabled,
              updatedAt: nextTs,
              ...(sharePatch.writeId ? { lastWriteId: sharePatch.writeId } : {}),
            };
            changed = true;
            shareApplied = true;
          }
        }
        appliedScopes.shareWithOthers = shareApplied;
      }

      const nextRecord = {
        version: 1 as const,
        user: nextUser,
        projects: nextProjects,
        shareWithOthers: nextShare,
      };

      const serialized = JSON.stringify(nextRecord);
      if (Buffer.byteLength(serialized, 'utf8') > VOICE_HOTWORDS_MAX_STORAGE_BYTES) {
        throw new VoiceHotwordsValidationError(400, VOICE_HOTWORDS_CAPACITY_ERRORS.PAYLOAD_TOO_LARGE);
      }

      if (changed) {
        await tx.execute(
          'INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
          [userId, VOICE_HOTWORDS_PREF_KEY, serialized, now],
        );
      }

      return { record: nextRecord, appliedScopes };
    });

    const topApplied = plan.reqScope === 'user'
      ? appliedScopes.user
      : plan.reqScope === 'share'
        ? appliedScopes.shareWithOthers
        : plan.singleProjectKey
          ? (appliedScopes.projects ? getOwnDictValue(appliedScopes.projects, plan.singleProjectKey) : undefined)
          : undefined;

    if (plan.singleProjectKey) {
      const proj = getOwnDictValue(resultRecord.projects, plan.singleProjectKey) ?? { raw: '', updatedAt: 0 };
      return c.json({
        ok: true,
        record: resultRecord,
        ...(topApplied !== undefined ? { applied: topApplied } : {}),
        appliedScopes,
        projectKey: plan.singleProjectKey,
        project: proj,
        compiled: mergeVoiceHotwords({
          projectRaw: proj.raw,
          globalRaw: resultRecord.user.raw,
        }),
      });
    }
    if (plan.reqScope === 'user') {
      return c.json({
        ok: true,
        record: resultRecord,
        ...(topApplied !== undefined ? { applied: topApplied } : {}),
        appliedScopes,
        compiled: mergeVoiceHotwords({
          projectRaw: '',
          globalRaw: resultRecord.user.raw,
        }),
      });
    }
    return c.json({
      ok: true,
      record: resultRecord,
      ...(topApplied !== undefined ? { applied: topApplied } : {}),
      appliedScopes,
    });
  } catch (err) {
    if (err instanceof VoiceHotwordsValidationError) {
      return c.json({ error: err.code }, err.status);
    }
    throw err;
  }
});
