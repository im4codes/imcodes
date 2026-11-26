import { WebSocket } from 'ws';
import { deriveDisplayName } from '../../../shared/machine-reference.js';
import {
  REMOTE_VOICE_ERROR_CODES,
  REMOTE_VOICE_HTTP_ASR_MAX_AUDIO_BYTES,
  REMOTE_VOICE_HTTP_ASR_MAX_RESPONSE_BYTES,
  REMOTE_VOICE_HTTP_ASR_TIMEOUT_MS,
  REMOTE_VOICE_MAX_SESSION_DURATION_MS,
  REMOTE_VOICE_MODEL_LABELS,
  REMOTE_VOICE_PROVIDER_NICKNAMES_PREF_KEY,
  REMOTE_VOICE_SERVER_SHARED_SETTING_KEY,
  REMOTE_VOICE_SESSION_IDLE_TIMEOUT_MS,
  REMOTE_VOICE_SESSION_READY_TIMEOUT_MS,
  formatDefaultRemoteVoiceNickname,
  isValidRemoteVoiceModelRegistration,
  parseProviderNicknamesPref,
  parseRemoteVoiceInboundFrame,
  parseServerSharedProvidersSetting,
  resolveOpenAiTranscriptionEndpoint,
  sanitizeAsrRepetitionLoop,
  sanitizeCrossAccountOwnerLabel,
  sanitizeRemoteVoiceDeviceName,
  sanitizeRemoteVoiceNickname,
  sanitizeRemoteVoiceProviderErrorCode,
  type RemoteVoiceErrorCode,
  type RemoteVoiceModelId,
  type RemoteVoiceModelLabel,
  type RemoteVoiceProviderInfo,
  type RemoteVoiceProviderRegisterFrame,
  type RemoteVoiceServerFrame,
  type RemoteVoiceServerSharedEntry,
} from '../../../shared/remote-voice.js';
import type { Database } from '../db/client.js';
import { getSetting, getUserById, getUserPref } from '../db/queries.js';
import {
  encodePcm16MonoToWav,
  loadRuntimeServerAsrServices,
  normalizeAsrLanguage,
  readAsrResponseTextBounded,
  type RuntimeServerAsrService,
  type ServerAsrEnvInput,
} from './remote-voice-asr.js';

export interface OwnerServerMachineEntry {
  id: string;
  name: string | null;
  displayName: string | null;
  refName: string | null;
  hostServerId: string | null;
  nodeRole: string | null;
  os?: string | null;
}

interface ProviderConnection {
  ws: WebSocket;
  userId: string;
  info: {
    deviceId: string;
    deviceName?: string;
    hostname?: string;
    localServerId?: string;
    model: RemoteVoiceModelId;
    modelLabel: RemoteVoiceModelLabel;
    ready: boolean;
  };
  reportedBusy: boolean;
  activeSessionId: string | null;
  lastAppSeenAt: number;
  lastTransportSeenAt: number;
  supportsAppProbe: boolean;
  readyProbeTimer: ReturnType<typeof setTimeout> | null;
}

interface OwnerMetaCacheEntry {
  displayName: string | null;
  username: string | null;
  nicknames: Record<string, string>;
  machines: OwnerServerMachineEntry[];
}

function pickOwnerMachineDisplayLabel(machine: OwnerServerMachineEntry): string | null {
  return sanitizeRemoteVoiceNickname(machine.displayName) || sanitizeRemoteVoiceNickname(machine.name) || null;
}

/**
 * Resolve an owner's IM.codes machine display label from active `servers` rows.
 * Priority: exact `localServerId` (`id` or `host_server_id`), then unambiguous `hostname`/`deviceName`
 * match against `ref_name`/`name`/`display_name`. Never guesses across ambiguous rows.
 */
export function resolveDbMachineNameForProvider(
  machines: readonly OwnerServerMachineEntry[],
  info: Pick<ProviderConnection['info'], 'localServerId' | 'hostname' | 'deviceName'>,
): string | null {
  if (!machines || machines.length === 0) return null;

  if (info.localServerId) {
    const exactMatches = machines.filter(
      (m) => m.id === info.localServerId || m.hostServerId === info.localServerId,
    );
    if (exactMatches.length > 0) {
      for (const m of exactMatches) {
        const displayLabel = sanitizeRemoteVoiceNickname(m.displayName);
        if (displayLabel) return displayLabel;
      }
      for (const m of exactMatches) {
        const nameLabel = sanitizeRemoteVoiceNickname(m.name);
        if (nameLabel) return nameLabel;
      }
    }
  }

  const candidates: string[] = [];
  for (const rawCandidate of [info.hostname, info.deviceName]) {
    const clean = sanitizeRemoteVoiceDeviceName(rawCandidate)?.toLowerCase();
    if (clean && !candidates.includes(clean)) {
      candidates.push(clean);
    }
  }
  if (candidates.length === 0) return null;

  const matchesCandidate = (rawField: string | null): boolean => {
    if (!rawField) return false;
    const norm = sanitizeRemoteVoiceDeviceName(rawField)?.toLowerCase()
      ?? rawField.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!norm) return false;
    return candidates.some(
      (cand) => norm === cand
        || (norm.startsWith(`${cand}-`) && /^[a-f0-9]{4,}$/i.test(norm.slice(cand.length + 1))),
    );
  };

  const matchedRows = machines.filter((m) => {
    if (matchesCandidate(m.refName) || matchesCandidate(m.name) || matchesCandidate(m.displayName)) {
      return true;
    }
    if (m.nodeRole === 'controlled' && !m.refName && m.os && m.name) {
      const storedNameLower = m.name.trim().toLowerCase();
      if (!storedNameLower) return false;
      if (candidates.some((cand) => deriveDisplayName(cand, m.os!).trim().toLowerCase() === storedNameLower)) {
        return true;
      }
      const normalizedOs = m.os.normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim().toLowerCase();
      if (normalizedOs) {
        const osSuffix = ` (${normalizedOs})`;
        const trimmedName = m.name.trim();
        if (trimmedName.toLowerCase().endsWith(osSuffix)) {
          const rawHost = trimmedName.slice(0, trimmedName.length - osSuffix.length).trim();
          const normalizedHost = sanitizeRemoteVoiceDeviceName(rawHost)?.toLowerCase();
          if (normalizedHost && candidates.includes(normalizedHost)) {
            return true;
          }
        }
      }
    }
    return false;
  });
  if (matchedRows.length === 0) return null;

  // Collapse co-located host daemon row when its linked controlled-node child also matched.
  const linkedHostIds = new Set(
    matchedRows.map((m) => m.hostServerId).filter((id): id is string => Boolean(id)),
  );
  const collapsed = matchedRows.filter((m) => !linkedHostIds.has(m.id));
  const targetRows = collapsed.length > 0 ? collapsed : matchedRows;

  const distinctLabels = new Set<string>();
  for (const m of targetRows) {
    const label = pickOwnerMachineDisplayLabel(m);
    if (label) distinctLabels.add(label);
  }
  return distinctLabels.size === 1 ? [...distinctLabels][0]! : null;
}

interface ActiveVoiceSession {
  sessionId: string;
  kind: 'pc_app' | 'http_asr';
  clientUserId: string;
  providerUserId: string;
  providerDeviceId: string;
  providerWs: WebSocket | null;
  clientWs: WebSocket;
  ready: boolean;
  createdAt: number;
  readyTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  durationTimer: ReturnType<typeof setTimeout> | null;
  locale?: string;
  sampleRate?: number;
  audioChunks?: Buffer[];
  totalAudioBytes?: number;
  stopping?: boolean;
  abortController?: AbortController;
}

export interface RemoteVoiceHubOptions {
  readyTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxSessionDurationMs?: number;
  httpAsrTimeoutMs?: number;
  providerLivenessIntervalMs?: number;
  providerStaleTimeoutMs?: number;
  readyProbeGraceMs?: number;
  fetchFn?: typeof fetch;
}

const DEFAULT_PROVIDER_LIVENESS_INTERVAL_MS = 30_000;
const DEFAULT_PROVIDER_STALE_TIMEOUT_MS = 75_000;
const DEFAULT_READY_PROBE_GRACE_MS = 5_000;

const SERVER_ASR_PROVIDER_USER_ID = '__server_asr__';

function safeSendWs(ws: WebSocket, frame: RemoteVoiceServerFrame): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // Socket closed between check and send; close handler cleans up.
  }
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
  return timer;
}

function sharedKey(ownerUserId: string, deviceId: string): string {
  return `${ownerUserId}\0${deviceId}`;
}

export class RemoteVoiceHub {
  private readonly readyTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxSessionDurationMs: number;
  private readonly httpAsrTimeoutMs: number;
  private readonly providerLivenessIntervalMs: number;
  private readonly providerStaleTimeoutMs: number;
  private readonly readyProbeGraceMs: number;
  private readonly fetchFn: typeof fetch;

  private readonly userSockets = new Map<string, Set<WebSocket>>();
  private readonly socketProviderKeys = new Map<WebSocket, { userId: string; deviceId: string }>();
  private readonly providers = new Map<string, Map<string, ProviderConnection>>();
  private readonly sessions = new Map<string, ActiveVoiceSession>();
  private readonly ownerMetaCache = new Map<string, OwnerMetaCacheEntry>();
  private serverSharedEntries = new Map<string, RemoteVoiceServerSharedEntry>();
  private serverAsrServices = new Map<string, RuntimeServerAsrService>();
  private providerLivenessTimer: ReturnType<typeof setInterval> | null = null;
  private envConfig: ServerAsrEnvInput | undefined;
  private db: Database | undefined;

  constructor(options: RemoteVoiceHubOptions = {}) {
    this.readyTimeoutMs = options.readyTimeoutMs ?? REMOTE_VOICE_SESSION_READY_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? REMOTE_VOICE_SESSION_IDLE_TIMEOUT_MS;
    this.maxSessionDurationMs = options.maxSessionDurationMs ?? REMOTE_VOICE_MAX_SESSION_DURATION_MS;
    this.httpAsrTimeoutMs = options.httpAsrTimeoutMs ?? REMOTE_VOICE_HTTP_ASR_TIMEOUT_MS;
    this.providerLivenessIntervalMs = options.providerLivenessIntervalMs ?? DEFAULT_PROVIDER_LIVENESS_INTERVAL_MS;
    this.providerStaleTimeoutMs = options.providerStaleTimeoutMs ?? DEFAULT_PROVIDER_STALE_TIMEOUT_MS;
    this.readyProbeGraceMs = options.readyProbeGraceMs ?? DEFAULT_READY_PROBE_GRACE_MS;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  private getServerSharedEntry(ownerUserId: string, deviceId: string): RemoteVoiceServerSharedEntry | undefined {
    return this.serverSharedEntries.get(sharedKey(ownerUserId, deviceId));
  }

  private isServerShared(ownerUserId: string, deviceId: string): boolean {
    return this.serverSharedEntries.has(sharedKey(ownerUserId, deviceId));
  }

  setOwnerMeta(
    userId: string,
    displayName: string | null,
    nicknames: Record<string, string>,
    username: string | null = null,
    machines?: OwnerServerMachineEntry[],
  ): void {
    const existingMachines = this.ownerMetaCache.get(userId)?.machines ?? [];
    this.ownerMetaCache.set(userId, {
      displayName,
      username,
      nicknames: { ...nicknames },
      machines: machines !== undefined ? [...machines] : [...existingMachines],
    });
  }

  broadcastProvidersForOwnerChange(ownerUserId: string): void {
    const own = this.providers.get(ownerUserId);
    let anyServerShared = false;
    if (own) {
      for (const conn of own.values()) {
        if (this.isServerShared(ownerUserId, conn.info.deviceId)) {
          anyServerShared = true;
          break;
        }
      }
    }
    if (anyServerShared) {
      this.broadcastProvidersUpdatedAll();
    } else {
      this.broadcastProvidersUpdated(ownerUserId);
    }
  }

  setServerSharedProviders(
    entries: readonly RemoteVoiceServerSharedEntry[],
    revokedTarget?: RemoteVoiceServerSharedEntry,
  ): void {
    const next = new Map<string, RemoteVoiceServerSharedEntry>();
    for (const entry of entries) {
      if (entry.ownerUserId && entry.deviceId) {
        next.set(sharedKey(entry.ownerUserId, entry.deviceId), entry);
      }
    }
    this.serverSharedEntries = next;

    if (revokedTarget) {
      for (const [sessionId, session] of [...this.sessions]) {
        if (
          session.providerUserId === revokedTarget.ownerUserId
          && session.providerDeviceId === revokedTarget.deviceId
          && session.clientUserId !== revokedTarget.ownerUserId
        ) {
          if (session.providerWs) {
            safeSendWs(session.providerWs, { type: 'voice.session.abort', sessionId });
          }
          this.failSession(sessionId, REMOTE_VOICE_ERROR_CODES.PROVIDER_OFFLINE, 'Server sharing disabled');
        }
      }
    }

    this.broadcastProvidersUpdatedAll();
  }

  async refreshServerSharedProviders(db: Database): Promise<RemoteVoiceServerSharedEntry[]> {
    this.db = db;
    const raw = await getSetting(db, REMOTE_VOICE_SERVER_SHARED_SETTING_KEY);
    const entries = parseServerSharedProvidersSetting(raw);
    const next = new Map<string, RemoteVoiceServerSharedEntry>();
    for (const entry of entries) {
      next.set(sharedKey(entry.ownerUserId, entry.deviceId), entry);
    }
    this.serverSharedEntries = next;
    return entries;
  }

  setServerAsrServices(
    services: readonly RuntimeServerAsrService[],
    broadcast: boolean = true,
  ): void {
    const next = new Map<string, RuntimeServerAsrService>();
    for (const svc of services) {
      if (svc.id) {
        next.set(svc.id, svc);
      }
    }
    this.serverAsrServices = next;

    for (const [sessionId, session] of [...this.sessions]) {
      if (session.kind !== 'http_asr') continue;
      const activeSvc = next.get(session.providerDeviceId);
      if (!activeSvc || !activeSvc.enabled) {
        session.abortController?.abort();
        this.failSession(sessionId, REMOTE_VOICE_ERROR_CODES.PROVIDER_OFFLINE, 'Speech service unavailable');
      }
    }

    if (broadcast) {
      this.broadcastProvidersUpdatedAll();
    }
  }

  async refreshServerAsrServices(
    db: Database,
    env?: ServerAsrEnvInput | null,
  ): Promise<RuntimeServerAsrService[]> {
    this.db = db;
    if (env !== undefined && env !== null) {
      this.envConfig = env;
    }
    const services = await loadRuntimeServerAsrServices(db, env ?? this.envConfig);
    this.setServerAsrServices(services, false);
    return services;
  }

  isDeviceOwnedByAnotherOnlineUser(callerUserId: string, deviceId: string): boolean {
    for (const [ownerUserId, byDevice] of this.providers) {
      if (ownerUserId !== callerUserId && byDevice.has(deviceId)) {
        return true;
      }
    }
    return false;
  }

  private async loadOwnerMetaFromDb(db: Database, userId: string): Promise<OwnerMetaCacheEntry> {
    const [user, rawNicknames] = await Promise.all([
      getUserById(db, userId),
      getUserPref(db, userId, REMOTE_VOICE_PROVIDER_NICKNAMES_PREF_KEY),
    ]);
    let machines: OwnerServerMachineEntry[] = [];
    try {
      const rows = await db.query<{
        id: unknown;
        name: unknown;
        display_name: unknown;
        ref_name: unknown;
        host_server_id: unknown;
        node_role: unknown;
        os: unknown;
      }>(
        `SELECT id, name, display_name, ref_name, host_server_id, node_role, os
           FROM servers
          WHERE user_id = $1 AND revoked_at IS NULL
          ORDER BY created_at DESC`,
        [userId],
      );
      if (Array.isArray(rows)) {
        machines = rows
          .filter((r) => r && typeof r.id === 'string' && r.id.trim())
          .map((r) => ({
            id: String(r.id).trim(),
            name: typeof r.name === 'string' ? r.name.trim() || null : null,
            displayName: typeof r.display_name === 'string' ? r.display_name.trim() || null : null,
            refName: typeof r.ref_name === 'string' ? r.ref_name.trim() || null : null,
            hostServerId: typeof r.host_server_id === 'string' ? r.host_server_id.trim() || null : null,
            nodeRole: typeof r.node_role === 'string' ? r.node_role.trim() || null : null,
            os: typeof r.os === 'string' ? r.os.trim() || null : null,
          }));
      }
    } catch {
      // Minimal test mock DBs may not implement servers table queries.
    }
    const displayName = user?.display_name?.trim() || null;
    const username = user?.username?.trim() || null;
    const nicknames = parseProviderNicknamesPref(rawNicknames);
    const entry: OwnerMetaCacheEntry = { displayName, username, nicknames, machines };
    this.ownerMetaCache.set(userId, entry);
    return entry;
  }

  private formatProviderInfo(conn: ProviderConnection, isOwnDevice: boolean): RemoteVoiceProviderInfo {
    const sharedEntry = this.getServerSharedEntry(conn.userId, conn.info.deviceId);
    const ownerMeta = this.ownerMetaCache.get(conn.userId);
    const modelLabel = REMOTE_VOICE_MODEL_LABELS[conn.info.model];
    const customNickname = ownerMeta?.nicknames[conn.info.deviceId] ?? sharedEntry?.nickname ?? null;
    const crossAccountNickname = sharedEntry?.nickname ?? null;
    const ownerName = isOwnDevice
      ? (ownerMeta?.displayName || ownerMeta?.username || 'Desktop')
      : sanitizeCrossAccountOwnerLabel(ownerMeta?.displayName, ownerMeta?.username);
    const dbMachineName = isOwnDevice
      ? resolveDbMachineNameForProvider(ownerMeta?.machines ?? [], conn.info)
      : null;
    const resolvedOwnDeviceLabel = dbMachineName ?? conn.info.deviceName;
    const displayName = isOwnDevice
      ? (customNickname ?? formatDefaultRemoteVoiceNickname(ownerName, modelLabel, resolvedOwnDeviceLabel))
      : (crossAccountNickname ?? formatDefaultRemoteVoiceNickname(ownerName, modelLabel));
    return {
      deviceId: conn.info.deviceId,
      ...(isOwnDevice && resolvedOwnDeviceLabel ? { deviceName: resolvedOwnDeviceLabel } : {}),
      displayName,
      model: conn.info.model,
      modelLabel,
      ready: conn.info.ready,
      busy: conn.activeSessionId !== null || conn.reportedBusy,
      shareScope: sharedEntry ? 'server' : 'account',
      isOwnDevice,
      ...(isOwnDevice ? { customNickname } : {}),
    };
  }

  private disambiguateOwnProviderDisplayNames(ownProviders: RemoteVoiceProviderInfo[]): RemoteVoiceProviderInfo[] {
    const byName = new Map<string, RemoteVoiceProviderInfo[]>();
    for (const provider of ownProviders) {
      let group = byName.get(provider.displayName);
      if (!group) {
        group = [];
        byName.set(provider.displayName, group);
      }
      group.push(provider);
    }

    const tags = new Map<string, string>();
    for (const group of byName.values()) {
      if (group.length < 2) continue;
      const prefixes = group.map((p) => (p.deviceId.length <= 8 ? p.deviceId : p.deviceId.slice(0, 6)));
      const usePrefix = new Set(prefixes).size === group.length;
      const suffixes = group.map((p) => (p.deviceId.length <= 8 ? p.deviceId : p.deviceId.slice(-6)));
      const useSuffix = !usePrefix && new Set(suffixes).size === group.length;
      group.forEach((p, idx) => {
        const tag = usePrefix ? prefixes[idx]! : useSuffix ? suffixes[idx]! : p.deviceId;
        tags.set(p.deviceId, tag);
      });
    }

    if (tags.size === 0) return ownProviders;
    return ownProviders.map((provider) => {
      const tag = tags.get(provider.deviceId);
      return tag ? { ...provider, displayName: `${provider.displayName} · #${tag}` } : provider;
    });
  }

  listProviders(userId: string): RemoteVoiceProviderInfo[] {
    const ownProviders: RemoteVoiceProviderInfo[] = [];

    const own = this.providers.get(userId);
    if (own) {
      for (const conn of own.values()) {
        ownProviders.push(this.formatProviderInfo(conn, true));
      }
    }

    const out: RemoteVoiceProviderInfo[] = this.disambiguateOwnProviderDisplayNames(ownProviders);

    for (const [ownerUserId, byDevice] of this.providers) {
      if (ownerUserId === userId) continue;
      for (const conn of byDevice.values()) {
        if (!this.isServerShared(ownerUserId, conn.info.deviceId)) continue;
        out.push(this.formatProviderInfo(conn, false));
      }
    }

    for (const svc of this.serverAsrServices.values()) {
      if (!svc.enabled) continue;
      out.push({
        deviceId: svc.id,
        displayName: svc.name,
        model: svc.model,
        modelLabel: svc.model,
        ready: true,
        busy: false,
        shareScope: 'server',
        providerKind: 'http_asr',
        isOwnDevice: false,
      });
    }

    return out;
  }

  async listProvidersHydrated(
    db: Database,
    userId: string,
    env?: ServerAsrEnvInput | null,
  ): Promise<RemoteVoiceProviderInfo[]> {
    this.db = db;
    if (env !== undefined && env !== null) {
      this.envConfig = env;
    }
    await Promise.all([
      this.refreshServerSharedProviders(db),
      this.refreshServerAsrServices(db, env ?? this.envConfig),
    ]);

    const ownerIdsToLoad = new Set<string>();
    if (this.providers.has(userId)) {
      ownerIdsToLoad.add(userId);
    }
    for (const [ownerUserId, byDevice] of this.providers) {
      if (ownerUserId === userId) continue;
      for (const conn of byDevice.values()) {
        if (this.isServerShared(ownerUserId, conn.info.deviceId)) {
          ownerIdsToLoad.add(ownerUserId);
          break;
        }
      }
    }
    await Promise.all([...ownerIdsToLoad].map((id) => this.loadOwnerMetaFromDb(db, id)));
    return this.listProviders(userId);
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  collectLiveUserIds(out: Set<string>): void {
    for (const [userId, sockets] of this.userSockets) {
      if (sockets.size > 0) out.add(userId);
    }
  }

  closeInactiveUserSockets(inactiveUserIds: ReadonlySet<string>): number {
    let closed = 0;
    for (const userId of inactiveUserIds) {
      const sockets = this.userSockets.get(userId);
      if (!sockets) continue;
      for (const ws of [...sockets]) {
        this.teardownSocket(ws, userId, REMOTE_VOICE_ERROR_CODES.UNAUTHORIZED);
        try {
          ws.close(1008, 'account_inactive');
        } catch {
          // Ignore close errors.
        }
        closed += 1;
      }
    }
    return closed;
  }

  stop(): void {
    if (this.providerLivenessTimer) {
      clearInterval(this.providerLivenessTimer);
      this.providerLivenessTimer = null;
    }
    for (const byDevice of this.providers.values()) {
      for (const conn of byDevice.values()) {
        if (conn.readyProbeTimer) {
          clearTimeout(conn.readyProbeTimer);
          conn.readyProbeTimer = null;
        }
      }
    }
    for (const [sessionId, session] of [...this.sessions]) {
      session.abortController?.abort();
      this.cleanupSession(sessionId);
    }
    for (const [userId, sockets] of [...this.userSockets]) {
      for (const ws of [...sockets]) {
        this.teardownSocket(ws, userId, REMOTE_VOICE_ERROR_CODES.PROVIDER_OFFLINE);
        try {
          ws.close(1001, 'server shutting down');
        } catch {
          // Ignore close errors.
        }
      }
    }
    this.userSockets.clear();
    this.providers.clear();
    this.socketProviderKeys.clear();
    this.sessions.clear();
    this.serverSharedEntries.clear();
    this.serverAsrServices.clear();
    this.ownerMetaCache.clear();
    this.envConfig = undefined;
    this.db = undefined;
  }

  handleConnection(ws: WebSocket, userId: string, db?: Database, env?: ServerAsrEnvInput): void {
    if (db) {
      this.db = db;
    }
    if (env) {
      this.envConfig = env;
    }
    if (db) {
      if (!this.ownerMetaCache.has(userId)) {
        void this.loadOwnerMetaFromDb(db, userId).then(() => {
          this.broadcastProvidersForOwnerChange(userId);
        }).catch(() => {});
      }
    }
    let sockets = this.userSockets.get(userId);
    if (!sockets) {
      sockets = new Set<WebSocket>();
      this.userSockets.set(userId, sockets);
    }
    sockets.add(ws);

    ws.on('message', (data) => {
      const raw = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      void this.handleRawMessage(ws, userId, raw);
    });

    if (typeof (ws as { on?: (ev: string, cb: () => void) => void }).on === 'function') {
      ws.on('pong', () => {
        this.recordProviderActivity(ws, 'transport');
      });
    }

    ws.on('close', () => {
      this.teardownSocket(ws, userId, REMOTE_VOICE_ERROR_CODES.PROVIDER_OFFLINE);
    });

    ws.on('error', () => {
      this.teardownSocket(ws, userId, REMOTE_VOICE_ERROR_CODES.PROVIDER_OFFLINE);
    });
  }

  private async handleRawMessage(ws: WebSocket, userId: string, raw: string): Promise<void> {
    const parsed = parseRemoteVoiceInboundFrame(raw);
    if (!parsed.ok) {
      this.recordProviderActivity(ws, 'app');
      if (parsed.sessionId) {
        const session = this.sessions.get(parsed.sessionId);
        if (session && session.clientUserId === userId && session.clientWs === ws) {
          safeSendWs(ws, {
            type: 'voice.session.error',
            sessionId: parsed.sessionId,
            code: parsed.code,
            message: parsed.message,
          });
          if (parsed.code === REMOTE_VOICE_ERROR_CODES.CHUNK_TOO_LARGE) {
            if (session.providerWs) {
              safeSendWs(session.providerWs, { type: 'voice.session.abort', sessionId: parsed.sessionId });
            }
            session.abortController?.abort();
            this.cleanupSession(parsed.sessionId);
          }
          return;
        }
        safeSendWs(ws, {
          type: 'voice.session.error',
          sessionId: parsed.sessionId,
          code: parsed.code,
          message: parsed.message,
        });
      }
      return;
    }

    const frame = parsed.frame;
    this.recordProviderActivity(ws, 'app', frame.type === 'voice.provider.pong');
    switch (frame.type) {
      case 'ping':
        safeSendWs(ws, { type: 'pong' });
        return;
      case 'voice.provider.pong':
        return;
      case 'voice.provider.register':
        this.registerProvider(ws, userId, frame);
        return;
      case 'voice.session.start':
        await this.startSession(ws, userId, frame);
        return;
      case 'voice.session.audio':
        this.forwardAudio(ws, userId, frame.sessionId, frame.pcmBase64);
        return;
      case 'voice.session.stop':
      case 'voice.session.abort':
        this.forwardClientControl(ws, userId, frame.sessionId, frame.type);
        return;
      case 'voice.session.ready':
        this.handleProviderReady(ws, userId, frame.sessionId);
        return;
      case 'voice.session.result':
        this.handleProviderResult(ws, userId, frame.sessionId, frame.text, frame.isFinal);
        return;
      case 'voice.session.end':
        this.handleProviderTerminal(ws, userId, frame.sessionId, { type: 'voice.session.end', sessionId: frame.sessionId });
        return;
      case 'voice.session.error':
        this.handleProviderTerminal(ws, userId, frame.sessionId, {
          type: 'voice.session.error',
          sessionId: frame.sessionId,
          code: sanitizeRemoteVoiceProviderErrorCode(frame.code),
        });
        return;
    }
  }

  private registerProvider(ws: WebSocket, userId: string, frame: RemoteVoiceProviderRegisterFrame): void {
    if (!isValidRemoteVoiceModelRegistration(frame.model, frame.modelLabel)) {
      return;
    }
    const canonicalLabel = REMOTE_VOICE_MODEL_LABELS[frame.model];

    const prevKey = this.socketProviderKeys.get(ws);
    if (prevKey && (prevKey.userId !== userId || prevKey.deviceId !== frame.deviceId)) {
      const prevMap = this.providers.get(prevKey.userId);
      const prevEntry = prevMap?.get(prevKey.deviceId);
      if (prevEntry && prevEntry.ws === ws) {
        if (prevEntry.readyProbeTimer) {
          clearTimeout(prevEntry.readyProbeTimer);
          prevEntry.readyProbeTimer = null;
        }
        prevMap?.delete(prevKey.deviceId);
        if (prevMap && prevMap.size === 0) {
          this.providers.delete(prevKey.userId);
        }
        if (prevEntry.activeSessionId) {
          this.failSession(prevEntry.activeSessionId, REMOTE_VOICE_ERROR_CODES.PROVIDER_OFFLINE);
        }
      }
    }

    let byDevice = this.providers.get(userId);
    if (!byDevice) {
      byDevice = new Map<string, ProviderConnection>();
      this.providers.set(userId, byDevice);
    }

    const existing = byDevice.get(frame.deviceId);
    if (existing && existing.ws !== ws) {
      if (existing.readyProbeTimer) {
        clearTimeout(existing.readyProbeTimer);
        existing.readyProbeTimer = null;
      }
      if (existing.activeSessionId) {
        this.failSession(existing.activeSessionId, REMOTE_VOICE_ERROR_CODES.PROVIDER_OFFLINE);
      }
      this.socketProviderKeys.delete(existing.ws);
      byDevice.delete(frame.deviceId);
      try {
        existing.ws.close(1000, 'replaced_by_new_connection');
      } catch {
        // Ignore close errors.
      }
    }

    const activeSessionId = existing && existing.ws === ws ? existing.activeSessionId : null;
    if (existing && existing.ws === ws && existing.readyProbeTimer) {
      clearTimeout(existing.readyProbeTimer);
      existing.readyProbeTimer = null;
    }
    const now = Date.now();
    const conn: ProviderConnection = {
      ws,
      userId,
      info: {
        deviceId: frame.deviceId,
        ...(frame.deviceName ? { deviceName: frame.deviceName } : {}),
        ...(frame.hostname ? { hostname: frame.hostname } : {}),
        ...(frame.localServerId ? { localServerId: frame.localServerId } : {}),
        model: frame.model,
        modelLabel: canonicalLabel,
        ready: frame.ready,
      },
      reportedBusy: frame.busy === true,
      activeSessionId,
      lastAppSeenAt: now,
      lastTransportSeenAt: now,
      supportsAppProbe: existing?.ws === ws ? existing.supportsAppProbe : false,
      readyProbeTimer: null,
    };
    byDevice.set(frame.deviceId, conn);
    this.socketProviderKeys.set(ws, { userId, deviceId: frame.deviceId });
    this.ensureProviderLivenessTimer();
    safeSendWs(ws, { type: 'voice.provider.ping' });

    if (this.isServerShared(userId, frame.deviceId)) {
      this.broadcastProvidersUpdatedAll();
    } else {
      this.broadcastProvidersUpdated(userId);
    }
  }

  private async resolveTargetProvider(
    callerUserId: string,
    targetDeviceId: string,
  ): Promise<
    | { kind: 'pc_app'; provider: ProviderConnection }
    | { kind: 'http_asr'; service: RuntimeServerAsrService }
    | undefined
  > {
    const own = this.providers.get(callerUserId)?.get(targetDeviceId);
    if (own) return { kind: 'pc_app', provider: own };

    if (this.db) {
      await Promise.all([
        this.refreshServerSharedProviders(this.db),
        this.refreshServerAsrServices(this.db, this.envConfig),
      ]);
    }
    for (const [ownerUserId, byDevice] of this.providers) {
      if (ownerUserId === callerUserId) continue;
      if (!this.isServerShared(ownerUserId, targetDeviceId)) continue;
      const candidate = byDevice.get(targetDeviceId);
      if (candidate) return { kind: 'pc_app', provider: candidate };
    }
    const asrSvc = this.serverAsrServices.get(targetDeviceId);
    if (asrSvc && asrSvc.enabled) {
      return { kind: 'http_asr', service: asrSvc };
    }
    return undefined;
  }

  private async startSession(
    clientWs: WebSocket,
    clientUserId: string,
    frame: { sessionId: string; targetDeviceId: string; locale?: string; sampleRate: number },
  ): Promise<void> {
    if (this.sessions.has(frame.sessionId)) {
      safeSendWs(clientWs, {
        type: 'voice.session.error',
        sessionId: frame.sessionId,
        code: REMOTE_VOICE_ERROR_CODES.INVALID_FRAME,
        message: 'Duplicate sessionId',
      });
      return;
    }

    const resolved = await this.resolveTargetProvider(clientUserId, frame.targetDeviceId);
    if (!resolved) {
      safeSendWs(clientWs, {
        type: 'voice.session.error',
        sessionId: frame.sessionId,
        code: REMOTE_VOICE_ERROR_CODES.PROVIDER_OFFLINE,
      });
      return;
    }

    if (resolved.kind === 'http_asr') {
      const svc = resolved.service;
      const session: ActiveVoiceSession = {
        sessionId: frame.sessionId,
        kind: 'http_asr',
        clientUserId,
        providerUserId: SERVER_ASR_PROVIDER_USER_ID,
        providerDeviceId: svc.id,
        providerWs: null,
        clientWs,
        ready: true,
        createdAt: Date.now(),
        readyTimer: null,
        idleTimer: null,
        durationTimer: null,
        locale: frame.locale,
        sampleRate: frame.sampleRate,
        audioChunks: [],
        totalAudioBytes: 0,
        stopping: false,
        abortController: new AbortController(),
      };
      this.sessions.set(frame.sessionId, session);
      this.resetIdleTimer(session);
      session.durationTimer = unrefTimer(setTimeout(() => {
        const current = this.sessions.get(frame.sessionId);
        if (!current) return;
        current.abortController?.abort();
        this.failSession(frame.sessionId, REMOTE_VOICE_ERROR_CODES.SESSION_TIMEOUT, 'Session exceeded maximum duration');
      }, this.maxSessionDurationMs));

      safeSendWs(clientWs, { type: 'voice.session.ready', sessionId: frame.sessionId });
      return;
    }

    const provider = resolved.provider;
    if (provider.ws.readyState !== WebSocket.OPEN) {
      safeSendWs(clientWs, {
        type: 'voice.session.error',
        sessionId: frame.sessionId,
        code: REMOTE_VOICE_ERROR_CODES.PROVIDER_OFFLINE,
      });
      return;
    }
    if (!provider.info.ready) {
      safeSendWs(clientWs, {
        type: 'voice.session.error',
        sessionId: frame.sessionId,
        code: REMOTE_VOICE_ERROR_CODES.PROVIDER_NOT_READY,
      });
      return;
    }
    if (provider.activeSessionId !== null || provider.reportedBusy) {
      safeSendWs(clientWs, {
        type: 'voice.session.error',
        sessionId: frame.sessionId,
        code: REMOTE_VOICE_ERROR_CODES.PROVIDER_BUSY,
      });
      return;
    }

    const session: ActiveVoiceSession = {
      sessionId: frame.sessionId,
      kind: 'pc_app',
      clientUserId,
      providerUserId: provider.userId,
      providerDeviceId: provider.info.deviceId,
      providerWs: provider.ws,
      clientWs,
      ready: false,
      createdAt: Date.now(),
      readyTimer: null,
      idleTimer: null,
      durationTimer: null,
    };
    provider.activeSessionId = frame.sessionId;
    this.sessions.set(frame.sessionId, session);

    session.readyTimer = unrefTimer(setTimeout(() => {
      const current = this.sessions.get(frame.sessionId);
      if (!current || current.ready) return;
      if (current.providerWs) {
        safeSendWs(current.providerWs, { type: 'voice.session.abort', sessionId: frame.sessionId });
        this.armProviderReadyProbe(current.providerUserId, current.providerDeviceId, current.providerWs);
      }
      this.failSession(frame.sessionId, REMOTE_VOICE_ERROR_CODES.SESSION_TIMEOUT, 'Provider failed to become ready in time');
    }, this.readyTimeoutMs));

    this.resetIdleTimer(session);

    session.durationTimer = unrefTimer(setTimeout(() => {
      if (!this.sessions.has(frame.sessionId)) return;
      if (session.providerWs) {
        safeSendWs(session.providerWs, { type: 'voice.session.abort', sessionId: frame.sessionId });
      }
      this.failSession(frame.sessionId, REMOTE_VOICE_ERROR_CODES.SESSION_TIMEOUT, 'Session exceeded maximum duration');
    }, this.maxSessionDurationMs));

    safeSendWs(provider.ws, {
      type: 'voice.session.start',
      sessionId: frame.sessionId,
      ...(frame.locale ? { locale: frame.locale } : {}),
      sampleRate: frame.sampleRate,
    });
  }

  private resetIdleTimer(session: ActiveVoiceSession): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }
    session.idleTimer = unrefTimer(setTimeout(() => {
      if (!this.sessions.has(session.sessionId)) return;
      if (session.providerWs) {
        safeSendWs(session.providerWs, { type: 'voice.session.abort', sessionId: session.sessionId });
      }
      session.abortController?.abort();
      this.failSession(session.sessionId, REMOTE_VOICE_ERROR_CODES.SESSION_TIMEOUT, 'Session idle timeout');
    }, this.idleTimeoutMs));
  }

  private forwardAudio(clientWs: WebSocket, clientUserId: string, sessionId: string, pcmBase64: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.clientUserId !== clientUserId || session.clientWs !== clientWs) {
      safeSendWs(clientWs, {
        type: 'voice.session.error',
        sessionId,
        code: REMOTE_VOICE_ERROR_CODES.SESSION_NOT_FOUND,
      });
      return;
    }

    if (session.kind === 'http_asr') {
      if (session.stopping) return;
      const chunk = Buffer.from(pcmBase64, 'base64');
      const nextBytes = (session.totalAudioBytes ?? 0) + chunk.length;
      if (nextBytes > REMOTE_VOICE_HTTP_ASR_MAX_AUDIO_BYTES) {
        this.failSession(sessionId, REMOTE_VOICE_ERROR_CODES.CHUNK_TOO_LARGE, 'Audio buffer exceeds max size');
        return;
      }
      session.audioChunks ??= [];
      session.audioChunks.push(chunk);
      session.totalAudioBytes = nextBytes;
      this.resetIdleTimer(session);
      return;
    }

    this.resetIdleTimer(session);
    if (session.providerWs) {
      safeSendWs(session.providerWs, {
        type: 'voice.session.audio',
        sessionId,
        pcmBase64,
      });
    }
  }

  private forwardClientControl(
    clientWs: WebSocket,
    clientUserId: string,
    sessionId: string,
    type: 'voice.session.stop' | 'voice.session.abort',
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.clientUserId !== clientUserId || session.clientWs !== clientWs) {
      return;
    }

    if (session.kind === 'http_asr') {
      if (type === 'voice.session.abort') {
        session.abortController?.abort();
        this.cleanupSession(sessionId);
        return;
      }
      if (session.stopping) return;
      session.stopping = true;
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
        session.idleTimer = null;
      }
      const svc = this.serverAsrServices.get(session.providerDeviceId);
      if (!svc || !svc.enabled) {
        this.failSession(sessionId, REMOTE_VOICE_ERROR_CODES.PROVIDER_OFFLINE, 'Speech service unavailable');
        return;
      }
      void this.runHttpAsrTranscription(session, svc);
      return;
    }

    this.resetIdleTimer(session);
    if (session.providerWs) {
      safeSendWs(session.providerWs, { type, sessionId });
    }
    if (type === 'voice.session.abort') {
      if (session.kind === 'pc_app' && !session.ready && session.providerWs) {
        this.armProviderReadyProbe(session.providerUserId, session.providerDeviceId, session.providerWs);
      }
      this.cleanupSession(sessionId);
    }
  }

  private async runHttpAsrTranscription(
    session: ActiveVoiceSession,
    svc: RuntimeServerAsrService,
  ): Promise<void> {
    const chunks = session.audioChunks ?? [];
    const totalBytes = session.totalAudioBytes ?? 0;
    const pcmBuffer = totalBytes > 0 ? Buffer.concat(chunks, totalBytes) : Buffer.alloc(0);
    session.audioChunks = [];
    session.totalAudioBytes = 0;

    if (pcmBuffer.length === 0) {
      if (this.sessions.get(session.sessionId) === session) {
        safeSendWs(session.clientWs, { type: 'voice.session.end', sessionId: session.sessionId });
        this.cleanupSession(session.sessionId);
      }
      return;
    }

    let endpoint: string;
    try {
      endpoint = resolveOpenAiTranscriptionEndpoint(svc.baseUrl);
    } catch {
      if (this.sessions.get(session.sessionId) === session) {
        this.failSession(session.sessionId, REMOTE_VOICE_ERROR_CODES.UPSTREAM_ERROR, 'Speech recognition upstream error');
      }
      return;
    }

    const wavBuffer = encodePcm16MonoToWav(pcmBuffer, session.sampleRate);
    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(wavBuffer)], { type: 'audio/wav' }), 'audio.wav');
    formData.append('model', svc.model);
    formData.append('response_format', 'json');
    const lang = normalizeAsrLanguage(session.locale);
    if (lang) {
      formData.append('language', lang);
    }

    const abortController = session.abortController ?? new AbortController();
    let timedOut = false;
    const timeoutHandle = unrefTimer(setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, this.httpAsrTimeoutMs));

    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (svc.apiKey) {
        headers.Authorization = `Bearer ${svc.apiKey}`;
      }
      const res = await this.fetchFn(endpoint, {
        method: 'POST',
        headers,
        body: formData,
        redirect: 'error',
        signal: abortController.signal,
      });

      if (this.sessions.get(session.sessionId) !== session || abortController.signal.aborted) {
        if (timedOut && this.sessions.get(session.sessionId) === session) {
          this.failSession(session.sessionId, REMOTE_VOICE_ERROR_CODES.UPSTREAM_ERROR, 'Speech recognition upstream timeout');
        }
        return;
      }

      if (!res.ok) {
        this.failSession(session.sessionId, REMOTE_VOICE_ERROR_CODES.UPSTREAM_ERROR, 'Speech recognition upstream error');
        return;
      }

      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      const rawText = await readAsrResponseTextBounded(res, REMOTE_VOICE_HTTP_ASR_MAX_RESPONSE_BYTES);
      if (this.sessions.get(session.sessionId) !== session || abortController.signal.aborted) {
        if (timedOut && this.sessions.get(session.sessionId) === session) {
          this.failSession(session.sessionId, REMOTE_VOICE_ERROR_CODES.UPSTREAM_ERROR, 'Speech recognition upstream timeout');
        }
        return;
      }

      let transcript: string | null = null;
      if (contentType.includes('text/plain')) {
        transcript = rawText.trim();
      } else {
        try {
          const parsed = JSON.parse(rawText) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const textVal = (parsed as Record<string, unknown>).text;
            if (typeof textVal === 'string') {
              transcript = textVal.trim();
            }
          }
        } catch {
          transcript = null;
        }
      }

      if (transcript === null) {
        this.failSession(session.sessionId, REMOTE_VOICE_ERROR_CODES.UPSTREAM_ERROR, 'Speech recognition upstream error');
        return;
      }

      const sanitized = sanitizeAsrRepetitionLoop(transcript);
      if (sanitized.length > 0) {
        safeSendWs(session.clientWs, {
          type: 'voice.session.result',
          sessionId: session.sessionId,
          text: sanitized,
          isFinal: true,
        });
      }
      safeSendWs(session.clientWs, { type: 'voice.session.end', sessionId: session.sessionId });
      this.cleanupSession(session.sessionId);
    } catch {
      if (this.sessions.get(session.sessionId) !== session) {
        return;
      }
      const message = timedOut ? 'Speech recognition upstream timeout' : 'Speech recognition upstream error';
      this.failSession(session.sessionId, REMOTE_VOICE_ERROR_CODES.UPSTREAM_ERROR, message);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private handleProviderReady(providerWs: WebSocket, providerUserId: string, sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.providerUserId !== providerUserId || session.providerWs !== providerWs) return;
    session.ready = true;
    if (session.readyTimer) {
      clearTimeout(session.readyTimer);
      session.readyTimer = null;
    }
    this.resetIdleTimer(session);
    safeSendWs(session.clientWs, { type: 'voice.session.ready', sessionId });
  }

  private handleProviderResult(
    providerWs: WebSocket,
    providerUserId: string,
    sessionId: string,
    text: string,
    isFinal: boolean,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.providerUserId !== providerUserId || session.providerWs !== providerWs) return;
    this.resetIdleTimer(session);
    const sanitized = sanitizeAsrRepetitionLoop(text);
    if (!isFinal && sanitized.length === 0) {
      return;
    }
    safeSendWs(session.clientWs, {
      type: 'voice.session.result',
      sessionId,
      text: sanitized,
      isFinal,
    });
  }

  private handleProviderTerminal(
    providerWs: WebSocket,
    providerUserId: string,
    sessionId: string,
    frame: { type: 'voice.session.end'; sessionId: string } | { type: 'voice.session.error'; sessionId: string; code: RemoteVoiceErrorCode },
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.providerUserId !== providerUserId || session.providerWs !== providerWs) return;
    if (frame.type === 'voice.session.error') {
      safeSendWs(session.clientWs, {
        type: 'voice.session.error',
        sessionId: frame.sessionId,
        code: sanitizeRemoteVoiceProviderErrorCode(frame.code),
      });
    } else {
      safeSendWs(session.clientWs, frame);
    }
    this.cleanupSession(sessionId);
  }

  private failSession(sessionId: string, code: RemoteVoiceErrorCode, message?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    safeSendWs(session.clientWs, {
      type: 'voice.session.error',
      sessionId,
      code,
      ...(message ? { message } : {}),
    });
    this.cleanupSession(sessionId);
  }

  private cleanupSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    if (session.readyTimer) clearTimeout(session.readyTimer);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (session.durationTimer) clearTimeout(session.durationTimer);
    if (session.audioChunks) {
      session.audioChunks = [];
      session.totalAudioBytes = 0;
    }

    if (session.kind === 'pc_app') {
      const provider = this.providers.get(session.providerUserId)?.get(session.providerDeviceId);
      if (provider && provider.activeSessionId === sessionId) {
        provider.activeSessionId = null;
      }
    }
  }

  private teardownSocket(ws: WebSocket, userId: string, disconnectErrorCode: RemoteVoiceErrorCode): void {
    const sockets = this.userSockets.get(userId);
    if (sockets) {
      sockets.delete(ws);
      if (sockets.size === 0) {
        this.userSockets.delete(userId);
      }
    }

    const providerKey = this.socketProviderKeys.get(ws);
    if (providerKey) {
      this.socketProviderKeys.delete(ws);
      const byDevice = this.providers.get(providerKey.userId);
      const conn = byDevice?.get(providerKey.deviceId);
      if (conn && conn.ws === ws) {
        if (conn.readyProbeTimer) {
          clearTimeout(conn.readyProbeTimer);
          conn.readyProbeTimer = null;
        }
        byDevice!.delete(providerKey.deviceId);
        if (byDevice!.size === 0) {
          this.providers.delete(providerKey.userId);
        }
        this.stopProviderLivenessTimerIfIdle();
        if (conn.activeSessionId) {
          this.failSession(conn.activeSessionId, disconnectErrorCode);
        }
        if (this.isServerShared(providerKey.userId, providerKey.deviceId)) {
          this.broadcastProvidersUpdatedAll();
        } else {
          this.broadcastProvidersUpdated(providerKey.userId);
        }
      }
    }

    for (const [sessionId, session] of [...this.sessions]) {
      if (session.clientWs === ws) {
        if (session.providerWs) {
          safeSendWs(session.providerWs, { type: 'voice.session.abort', sessionId });
          if (session.kind === 'pc_app' && !session.ready) {
            this.armProviderReadyProbe(session.providerUserId, session.providerDeviceId, session.providerWs);
          }
        }
        session.abortController?.abort();
        this.cleanupSession(sessionId);
      } else if (session.providerWs && session.providerWs === ws) {
        this.failSession(sessionId, disconnectErrorCode);
      }
    }
  }

  private recordProviderActivity(ws: WebSocket, kind: 'app' | 'transport', isAppProbePong = false): void {
    const providerKey = this.socketProviderKeys.get(ws);
    if (!providerKey) return;
    const conn = this.providers.get(providerKey.userId)?.get(providerKey.deviceId);
    if (!conn || conn.ws !== ws) return;
    const now = Date.now();
    conn.lastTransportSeenAt = now;
    if (kind === 'app') {
      conn.lastAppSeenAt = now;
    }
    if (isAppProbePong) {
      conn.supportsAppProbe = true;
    }
    if (conn.readyProbeTimer && (kind === 'app' || !conn.supportsAppProbe)) {
      clearTimeout(conn.readyProbeTimer);
      conn.readyProbeTimer = null;
    }
  }

  private ensureProviderLivenessTimer(): void {
    if (this.providerLivenessTimer !== null || this.providers.size === 0) return;
    this.providerLivenessTimer = unrefTimer(setInterval(() => {
      this.sweepStaleProviders();
    }, this.providerLivenessIntervalMs));
  }

  private stopProviderLivenessTimerIfIdle(): void {
    if (this.providers.size > 0 || this.providerLivenessTimer === null) return;
    clearInterval(this.providerLivenessTimer);
    this.providerLivenessTimer = null;
  }

  private evictUnresponsiveProvider(conn: ProviderConnection, expectedWs: WebSocket, reason: string): void {
    const current = this.providers.get(conn.userId)?.get(conn.info.deviceId);
    if (!current || current.ws !== expectedWs) return;
    if (current.readyProbeTimer) {
      clearTimeout(current.readyProbeTimer);
      current.readyProbeTimer = null;
    }
    try {
      const terminable = expectedWs as { terminate?: () => void };
      if (typeof terminable.terminate === 'function') {
        terminable.terminate();
      } else {
        expectedWs.close(1001, reason);
      }
    } catch {
      // Ignore terminate/close errors; teardownSocket still removes the zombie provider.
    }
    this.teardownSocket(expectedWs, current.userId, REMOTE_VOICE_ERROR_CODES.PROVIDER_OFFLINE);
  }

  private sweepStaleProviders(): void {
    const now = Date.now();
    for (const byDevice of [...this.providers.values()]) {
      for (const conn of [...byDevice.values()]) {
        if (
          now - conn.lastAppSeenAt >= this.providerStaleTimeoutMs
          || now - conn.lastTransportSeenAt >= this.providerStaleTimeoutMs
        ) {
          this.evictUnresponsiveProvider(conn, conn.ws, 'provider_heartbeat_timeout');
          continue;
        }
        const pingable = conn.ws as { ping?: () => void };
        if (typeof pingable.ping === 'function' && conn.ws.readyState === WebSocket.OPEN) {
          try {
            pingable.ping();
          } catch {
            // Ignore transient ping send errors; close/next sweep handles eviction.
          }
        }
        if (conn.supportsAppProbe) {
          safeSendWs(conn.ws, { type: 'voice.provider.ping' });
        }
      }
    }
    this.stopProviderLivenessTimerIfIdle();
  }

  private armProviderReadyProbe(providerUserId: string, providerDeviceId: string, expectedWs: WebSocket): void {
    const conn = this.providers.get(providerUserId)?.get(providerDeviceId);
    if (!conn || conn.ws !== expectedWs || conn.readyProbeTimer !== null) return;
    const armedAtAppSeen = conn.lastAppSeenAt;
    const armedAtTransportSeen = conn.lastTransportSeenAt;
    // Arm the timer BEFORE sending pings so synchronous test/local replies clear readyProbeTimer
    // even when Date.now() does not advance between register and probe response.
    const probeTimer = unrefTimer(setTimeout(() => {
      const current = this.providers.get(providerUserId)?.get(providerDeviceId);
      if (!current || current.ws !== expectedWs || current.readyProbeTimer !== probeTimer) return;
      current.readyProbeTimer = null;
      const alive = current.supportsAppProbe
        ? current.lastAppSeenAt > armedAtAppSeen
        : current.lastTransportSeenAt > armedAtTransportSeen || current.lastAppSeenAt > armedAtAppSeen;
      if (alive) return;
      this.evictUnresponsiveProvider(current, expectedWs, 'provider_ready_probe_timeout');
    }, this.readyProbeGraceMs));
    conn.readyProbeTimer = probeTimer;
    const pingable = expectedWs as { ping?: () => void };
    if (typeof pingable.ping === 'function' && expectedWs.readyState === WebSocket.OPEN) {
      try {
        pingable.ping();
      } catch {
        // Ignore ping send errors; probe grace timer will evict if unresponsive.
      }
    }
    safeSendWs(expectedWs, { type: 'voice.provider.ping' });
  }

  private broadcastProvidersUpdated(userId: string): void {
    const sockets = this.userSockets.get(userId);
    if (!sockets || sockets.size === 0) return;
    const providers = this.listProviders(userId);
    for (const ws of sockets) {
      safeSendWs(ws, { type: 'voice.providers.updated', providers });
    }
  }

  private broadcastProvidersUpdatedAll(): void {
    for (const userId of this.userSockets.keys()) {
      this.broadcastProvidersUpdated(userId);
    }
  }
}

export const remoteVoiceHub = new RemoteVoiceHub();
