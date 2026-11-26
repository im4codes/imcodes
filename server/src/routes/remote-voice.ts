import { Hono } from 'hono';
import {
  REMOTE_VOICE_ENV_ASR_DEVICE_ID,
  REMOTE_VOICE_MAX_SERVER_ASR_SERVICES,
  REMOTE_VOICE_PRIMARY_PROVIDER_PREF_KEY,
  REMOTE_VOICE_PROVIDER_NICKNAMES_PREF_KEY,
  REMOTE_VOICE_SERVER_ASR_SERVICES_SETTING_KEY,
  REMOTE_VOICE_SERVER_SHARED_SETTING_KEY,
  REMOTE_VOICE_WS_TICKET_TYPE,
  isValidRemoteVoiceId,
  parseProviderNicknamesPref,
  parseServerSharedProvidersSetting,
  validatePrimaryProviderBody,
  validateProviderNicknameBody,
  validateServerAsrServiceBody,
  validateServerSharedProviderBody,
  type RemoteVoiceServerSharedEntry,
} from '../../../shared/remote-voice.js';
import { isUserStatusActive, userStatusDenialCode } from '../../../shared/user-status.js';
import type { Database } from '../db/client.js';
import { getSetting, getUserById, getUserPref, setSetting, setUserPref } from '../db/queries.js';
import type { Env } from '../env.js';
import { logAudit } from '../security/audit.js';
import { requireAuth } from '../security/authorization.js';
import { randomHex, signJwt } from '../security/crypto.js';
import { alignedSessionIssuedAt, evaluateUserAccess, loadUserAccess } from '../security/user-status.js';
import {
  encryptServerAsrApiKey,
  parseStoredServerAsrServices,
  readEnvServerAsrService,
  resolveRuntimeServerAsrServices,
  toPublicServerAsrService,
  type StoredServerAsrServiceRecord,
} from '../services/remote-voice-asr.js';
import { remoteVoiceHub } from '../services/remote-voice-hub.js';

export const remoteVoiceRoutes = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

remoteVoiceRoutes.use('/*', requireAuth({ refuseDaemonCredential: true }));

function parseStoredPrimaryDeviceId(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isValidRemoteVoiceId(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** POST /api/voice/ws-ticket — issue a 30-second single-use WebSocket ticket */
remoteVoiceRoutes.post('/ws-ticket', async (c) => {
  const userId = c.get('userId' as never) as string;
  const callerIssuedAt = c.get('authIssuedAt' as never) as number | undefined;
  const access = await loadUserAccess(c.env.DB, userId);
  const decision = evaluateUserAccess(access, callerIssuedAt);
  if (!decision.ok) {
    return c.json({ error: decision.code }, 403);
  }
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const jti = randomHex(16);
  const ticket = signJwt(
    {
      sub: userId,
      type: REMOTE_VOICE_WS_TICKET_TYPE,
      jti,
      iat: alignedSessionIssuedAt(access!.sessionsValidAfter, nowMs),
      exp: nowSec + 30,
      sva: access!.sessionsValidAfter,
    },
    c.env.JWT_SIGNING_KEY,
    30,
  );
  return c.json({ ticket });
});

/** GET /api/voice/providers — list account-scoped and manually server-shared voice providers */
remoteVoiceRoutes.get('/providers', async (c) => {
  const userId = c.get('userId' as never) as string;
  const [rawPrimary, user] = await Promise.all([
    getUserPref(c.env.DB, userId, REMOTE_VOICE_PRIMARY_PROVIDER_PREF_KEY),
    getUserById(c.env.DB, userId),
  ]);
  const providers = await remoteVoiceHub.listProvidersHydrated(c.env.DB, userId, c.env);
  const primaryDeviceId = parseStoredPrimaryDeviceId(rawPrimary);
  const canManageServerSharing = Boolean(user && user.is_admin && isUserStatusActive(user.status));
  const canShareOwnProviderToServer = Boolean(user && isUserStatusActive(user.status));
  return c.json({ primaryDeviceId, canManageServerSharing, canShareOwnProviderToServer, providers });
});

async function updateServerSharedProvidersSetting(
  db: Database,
  mutate: (currentEntries: RemoteVoiceServerSharedEntry[]) => RemoteVoiceServerSharedEntry[] | null,
): Promise<{ changed: boolean; entries: RemoteVoiceServerSharedEntry[] }> {
  return db.transaction(async (tx) => {
    await tx.execute(
      'INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT(key) DO NOTHING',
      [REMOTE_VOICE_SERVER_SHARED_SETTING_KEY, '[]', Date.now()],
    );
    const row = await tx.queryOne<{ value: string }>(
      'SELECT value FROM settings WHERE key = $1 FOR UPDATE',
      [REMOTE_VOICE_SERVER_SHARED_SETTING_KEY],
    );
    const currentEntries = parseServerSharedProvidersSetting(row?.value ?? null);
    const nextEntries = mutate(currentEntries);
    if (!nextEntries) {
      return { changed: false, entries: currentEntries };
    }
    await setSetting(tx, REMOTE_VOICE_SERVER_SHARED_SETTING_KEY, JSON.stringify(nextEntries));
    return { changed: true, entries: nextEntries };
  });
}

/** PUT /api/voice/primary-provider — set or clear primary remote voice provider deviceId */
remoteVoiceRoutes.put('/primary-provider', async (c) => {
  const userId = c.get('userId' as never) as string;
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const validated = validatePrimaryProviderBody(rawBody);
  if (!validated.ok) {
    return c.json({ error: validated.error }, 400);
  }
  await setUserPref(
    c.env.DB,
    userId,
    REMOTE_VOICE_PRIMARY_PROVIDER_PREF_KEY,
    JSON.stringify(validated.primaryDeviceId),
  );
  return c.json({ ok: true, primaryDeviceId: validated.primaryDeviceId });
});

/** PUT /api/voice/provider-nickname — set or clear custom nickname for own PC App voice device */
remoteVoiceRoutes.put('/provider-nickname', async (c) => {
  const userId = c.get('userId' as never) as string;
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const validated = validateProviderNicknameBody(rawBody);
  if (!validated.ok) {
    return c.json({ error: validated.error }, 400);
  }
  if (remoteVoiceHub.isDeviceOwnedByAnotherOnlineUser(userId, validated.deviceId)) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const [user, rawNicknames] = await Promise.all([
    getUserById(c.env.DB, userId),
    getUserPref(c.env.DB, userId, REMOTE_VOICE_PROVIDER_NICKNAMES_PREF_KEY),
  ]);

  const nicknames = parseProviderNicknamesPref(rawNicknames);
  if (validated.nickname === null) {
    delete nicknames[validated.deviceId];
  } else {
    nicknames[validated.deviceId] = validated.nickname;
  }
  await setUserPref(
    c.env.DB,
    userId,
    REMOTE_VOICE_PROVIDER_NICKNAMES_PREF_KEY,
    JSON.stringify(nicknames),
  );

  // Keep server-shared entry nickname synced if this device is server-shared.
  const sharedUpdate = await updateServerSharedProvidersSetting(c.env.DB, (currentEntries) => {
    let sharedChanged = false;
    const nextEntries = currentEntries.map((entry) => {
      if (entry.ownerUserId !== userId || entry.deviceId !== validated.deviceId) {
        return entry;
      }
      sharedChanged = true;
      return {
        ownerUserId: entry.ownerUserId,
        deviceId: entry.deviceId,
        ...(validated.nickname ? { nickname: validated.nickname } : {}),
      };
    });
    return sharedChanged ? nextEntries : null;
  });
  if (sharedUpdate.changed) {
    const latestEntries = parseServerSharedProvidersSetting(
      await getSetting(c.env.DB, REMOTE_VOICE_SERVER_SHARED_SETTING_KEY),
    );
    remoteVoiceHub.setServerSharedProviders(latestEntries);
  }

  const displayName = user?.display_name?.trim() || null;
  const username = user?.username?.trim() || null;
  remoteVoiceHub.setOwnerMeta(userId, displayName, nicknames, username);
  remoteVoiceHub.broadcastProvidersForOwnerChange(userId);

  return c.json({ ok: true, deviceId: validated.deviceId, nickname: validated.nickname });
});

/** PUT /api/voice/server-shared-providers — active user manual toggle for sharing own PC App voice server-wide */
remoteVoiceRoutes.put('/server-shared-providers', async (c) => {
  const userId = c.get('userId' as never) as string;
  const user = await getUserById(c.env.DB, userId);
  if (!user) {
    return c.json({ error: 'forbidden' }, 403);
  }
  if (!isUserStatusActive(user.status)) {
    return c.json({ error: userStatusDenialCode(user.status) }, 403);
  }

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const validated = validateServerSharedProviderBody(rawBody);
  if (!validated.ok) {
    return c.json({ error: validated.error }, 400);
  }

  // Any active user can only publish/toggle their own device, never another user's online device.
  if (validated.shared && remoteVoiceHub.isDeviceOwnedByAnotherOnlineUser(userId, validated.deviceId)) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const rawNicknames = await getUserPref(c.env.DB, userId, REMOTE_VOICE_PROVIDER_NICKNAMES_PREF_KEY);
  const nicknames = parseProviderNicknamesPref(rawNicknames);
  if (validated.nickname !== undefined) {
    if (validated.nickname === null) {
      delete nicknames[validated.deviceId];
    } else {
      nicknames[validated.deviceId] = validated.nickname;
    }
    await setUserPref(
      c.env.DB,
      userId,
      REMOTE_VOICE_PROVIDER_NICKNAMES_PREF_KEY,
      JSON.stringify(nicknames),
    );
  }

  const effectiveNickname = validated.nickname !== undefined
    ? validated.nickname
    : (nicknames[validated.deviceId] ?? null);

  await updateServerSharedProvidersSetting(c.env.DB, (currentEntries) => {
    const filtered = currentEntries.filter(
      (entry) => !(entry.ownerUserId === userId && entry.deviceId === validated.deviceId),
    );
    return validated.shared
      ? [
          ...filtered,
          {
            ownerUserId: userId,
            deviceId: validated.deviceId,
            ...(effectiveNickname ? { nickname: effectiveNickname } : {}),
          },
        ]
      : filtered;
  });

  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';
  await logAudit(
    {
      userId,
      action: validated.shared ? 'remote_voice.enable_server_sharing' : 'remote_voice.disable_server_sharing',
      ip,
      details: {
        deviceId: validated.deviceId,
        shared: validated.shared,
        ...(effectiveNickname ? { nickname: effectiveNickname } : {}),
      },
    },
    c.env.DB,
  );

  const latestEntries = parseServerSharedProvidersSetting(
    await getSetting(c.env.DB, REMOTE_VOICE_SERVER_SHARED_SETTING_KEY),
  );
  const displayName = user.display_name?.trim() || null;
  const username = user.username?.trim() || null;
  remoteVoiceHub.setOwnerMeta(userId, displayName, nicknames, username);
  remoteVoiceHub.setServerSharedProviders(
    latestEntries,
    validated.shared ? undefined : { ownerUserId: userId, deviceId: validated.deviceId },
  );

  return c.json({ ok: true, deviceId: validated.deviceId, shared: validated.shared, nickname: effectiveNickname });
});

async function requireActiveAdmin(
  c: { env: Env; get: (k: never) => unknown; json: (data: unknown, status?: number) => Response },
): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
  const userId = c.get('userId' as never) as string;
  const user = await getUserById(c.env.DB, userId);
  if (!user || !user.is_admin) {
    return { ok: false, response: c.json({ error: 'forbidden' }, 403) };
  }
  if (!isUserStatusActive(user.status)) {
    return { ok: false, response: c.json({ error: userStatusDenialCode(user.status) }, 403) };
  }
  return { ok: true, userId };
}

function buildServerAsrAdminPayload(
  stored: readonly StoredServerAsrServiceRecord[],
  env: Env,
) {
  const envSvc = readEnvServerAsrService(env);
  return {
    services: stored.map((svc) => toPublicServerAsrService(svc, env.BOT_ENCRYPTION_KEY)),
    envDefault: envSvc ? toPublicServerAsrService(envSvc) : null,
    encryptionAvailable: Boolean((env.BOT_ENCRYPTION_KEY ?? '').trim()),
  };
}

/** GET /api/voice/server-asr-services — admin-only list of server-configured OpenAI-compatible ASR services */
remoteVoiceRoutes.get('/server-asr-services', async (c) => {
  const auth = await requireActiveAdmin(c as never);
  if (!auth.ok) return auth.response;

  const raw = await getSetting(c.env.DB, REMOTE_VOICE_SERVER_ASR_SERVICES_SETTING_KEY);
  const stored = parseStoredServerAsrServices(raw);
  return c.json(buildServerAsrAdminPayload(stored, c.env), 200, { 'Cache-Control': 'no-store' });
});

/** POST /api/voice/server-asr-services — admin-only create server OpenAI-compatible ASR service */
remoteVoiceRoutes.post('/server-asr-services', async (c) => {
  const auth = await requireActiveAdmin(c as never);
  if (!auth.ok) return auth.response;

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const validated = validateServerAsrServiceBody(rawBody, { partial: false });
  if (!validated.ok) {
    return c.json({ error: validated.error }, 400);
  }

  const rawExisting = await getSetting(c.env.DB, REMOTE_VOICE_SERVER_ASR_SERVICES_SETTING_KEY);
  const current = parseStoredServerAsrServices(rawExisting);
  if (current.length >= REMOTE_VOICE_MAX_SERVER_ASR_SERVICES) {
    return c.json({ error: 'max_services_reached' }, 400);
  }

  let apiKeyEncrypted: string | null = null;
  if (validated.data.apiKey) {
    try {
      apiKeyEncrypted = encryptServerAsrApiKey(validated.data.apiKey, c.env.BOT_ENCRYPTION_KEY);
    } catch {
      return c.json({ error: 'encryption_not_configured' }, 503);
    }
  }

  const created: StoredServerAsrServiceRecord = {
    id: `asr_${randomHex(6)}`,
    name: validated.data.name!,
    baseUrl: validated.data.baseUrl!,
    apiKeyEncrypted,
    model: validated.data.model!,
    enabled: validated.data.enabled ?? true,
  };
  const next = [...current, created];
  await setSetting(c.env.DB, REMOTE_VOICE_SERVER_ASR_SERVICES_SETTING_KEY, JSON.stringify(next));

  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';
  await logAudit(
    {
      userId: auth.userId,
      action: 'remote_voice.create_server_asr_service',
      ip,
      details: {
        serviceId: created.id,
        name: created.name,
        model: created.model,
        enabled: created.enabled,
      },
    },
    c.env.DB,
  );

  remoteVoiceHub.setServerAsrServices(resolveRuntimeServerAsrServices(next, c.env));
  return c.json(
    {
      ok: true,
      service: toPublicServerAsrService(created, c.env.BOT_ENCRYPTION_KEY),
      ...buildServerAsrAdminPayload(next, c.env),
    },
    201,
    { 'Cache-Control': 'no-store' },
  );
});

/** PUT /api/voice/server-asr-services/:id — admin-only update server OpenAI-compatible ASR service */
remoteVoiceRoutes.put('/server-asr-services/:id', async (c) => {
  const auth = await requireActiveAdmin(c as never);
  if (!auth.ok) return auth.response;

  const id = c.req.param('id');
  if (!isValidRemoteVoiceId(id)) {
    return c.json({ error: 'invalid_id' }, 400);
  }
  if (id === REMOTE_VOICE_ENV_ASR_DEVICE_ID) {
    return c.json({ error: 'env_service_readonly' }, 400);
  }

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const validated = validateServerAsrServiceBody(rawBody, { partial: true });
  if (!validated.ok) {
    return c.json({ error: validated.error }, 400);
  }

  const rawExisting = await getSetting(c.env.DB, REMOTE_VOICE_SERVER_ASR_SERVICES_SETTING_KEY);
  const current = parseStoredServerAsrServices(rawExisting);
  const idx = current.findIndex((svc) => svc.id === id);
  if (idx === -1) {
    return c.json({ error: 'not_found' }, 404);
  }

  const existing = current[idx]!;
  let nextApiKeyEncrypted = existing.apiKeyEncrypted ?? null;
  if (validated.data.apiKey !== undefined) {
    if (validated.data.apiKey === '') {
      nextApiKeyEncrypted = null;
    } else {
      try {
        nextApiKeyEncrypted = encryptServerAsrApiKey(validated.data.apiKey, c.env.BOT_ENCRYPTION_KEY);
      } catch {
        return c.json({ error: 'encryption_not_configured' }, 503);
      }
    }
  }

  const updated: StoredServerAsrServiceRecord = {
    id: existing.id,
    name: validated.data.name ?? existing.name,
    baseUrl: validated.data.baseUrl ?? existing.baseUrl,
    apiKeyEncrypted: nextApiKeyEncrypted,
    model: validated.data.model ?? existing.model,
    enabled: validated.data.enabled ?? existing.enabled,
  };
  const next = current.map((svc, i) => (i === idx ? updated : svc));
  await setSetting(c.env.DB, REMOTE_VOICE_SERVER_ASR_SERVICES_SETTING_KEY, JSON.stringify(next));

  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';
  await logAudit(
    {
      userId: auth.userId,
      action: 'remote_voice.update_server_asr_service',
      ip,
      details: {
        serviceId: updated.id,
        name: updated.name,
        model: updated.model,
        enabled: updated.enabled,
      },
    },
    c.env.DB,
  );

  remoteVoiceHub.setServerAsrServices(resolveRuntimeServerAsrServices(next, c.env));
  return c.json(
    {
      ok: true,
      service: toPublicServerAsrService(updated, c.env.BOT_ENCRYPTION_KEY),
      ...buildServerAsrAdminPayload(next, c.env),
    },
    200,
    { 'Cache-Control': 'no-store' },
  );
});

/** DELETE /api/voice/server-asr-services/:id — admin-only delete server OpenAI-compatible ASR service */
remoteVoiceRoutes.delete('/server-asr-services/:id', async (c) => {
  const auth = await requireActiveAdmin(c as never);
  if (!auth.ok) return auth.response;

  const id = c.req.param('id');
  if (!isValidRemoteVoiceId(id)) {
    return c.json({ error: 'invalid_id' }, 400);
  }
  if (id === REMOTE_VOICE_ENV_ASR_DEVICE_ID) {
    return c.json({ error: 'env_service_readonly' }, 400);
  }

  const rawExisting = await getSetting(c.env.DB, REMOTE_VOICE_SERVER_ASR_SERVICES_SETTING_KEY);
  const current = parseStoredServerAsrServices(rawExisting);
  const idx = current.findIndex((svc) => svc.id === id);
  if (idx === -1) {
    return c.json({ error: 'not_found' }, 404);
  }

  const removed = current[idx]!;
  const next = current.filter((svc) => svc.id !== id);
  await setSetting(c.env.DB, REMOTE_VOICE_SERVER_ASR_SERVICES_SETTING_KEY, JSON.stringify(next));

  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';
  await logAudit(
    {
      userId: auth.userId,
      action: 'remote_voice.delete_server_asr_service',
      ip,
      details: {
        serviceId: removed.id,
        name: removed.name,
      },
    },
    c.env.DB,
  );

  remoteVoiceHub.setServerAsrServices(resolveRuntimeServerAsrServices(next, c.env));
  return c.json(
    {
      ok: true,
      deletedId: id,
      ...buildServerAsrAdminPayload(next, c.env),
    },
    200,
    { 'Cache-Control': 'no-store' },
  );
});
