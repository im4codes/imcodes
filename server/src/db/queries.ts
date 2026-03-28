import type { Database } from './client.js';

// ── Types ─────────────────────────────────────────────────────────────────

export interface DbUser {
  id: string;
  created_at: number;
  username: string | null;
  password_hash: string | null;
  display_name: string | null;
  password_must_change: boolean | null;
  is_admin: boolean;
  status: 'active' | 'pending' | 'disabled';
}

export interface DbPlatformIdentity {
  id: string;
  user_id: string;
  platform: string;
  platform_user_id: string;
  created_at: number;
}

export interface DbServer {
  id: string;
  user_id: string;
  team_id: string | null;
  name: string;
  token_hash: string;
  last_heartbeat_at: number | null;
  status: string;
  daemon_version: string | null;
  bound_with_key_id: string | null;
  created_at: number;
}

export interface DbChannelBinding {
  id: string;
  server_id: string;
  platform: string;
  channel_id: string;
  binding_type: string;
  target: string;
  bot_id: string | null;
  created_at: number;
}

export interface DbCronJob {
  id: string;
  server_id: string;
  user_id: string;
  name: string;
  cron_expr: string;
  action: string;
  project_name: string | null;
  target_role: string;
  status: string;
  last_run_at: number | null;
  next_run_at: number | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number | null;
}

export interface DbSession {
  id: string;
  server_id: string;
  name: string;
  project_name: string;
  role: string;
  agent_type: string;
  agent_version: string | null;
  project_dir: string;
  state: string;
  label: string | null;
  runtime_type: string | null;
  provider_id: string | null;
  provider_session_id: string | null;
  description: string | null;
  created_at: number;
  updated_at: number;
}

export interface QuickData {
  history: string[];
  sessionHistory?: Record<string, string[]>;
  commands: string[];
  phrases: string[];
}

// ── Users ─────────────────────────────────────────────────────────────────

export async function createUser(db: Database, id: string): Promise<DbUser> {
  const now = Date.now();
  await db.execute('INSERT INTO users (id, created_at) VALUES ($1, $2)', [id, now]);
  return { id, created_at: now, username: null, password_hash: null, display_name: null, password_must_change: null, is_admin: false, status: 'active' };
}

export async function getUserById(db: Database, id: string): Promise<DbUser | null> {
  return db.queryOne<DbUser>('SELECT * FROM users WHERE id = $1', [id]);
}

export async function getUserByUsername(db: Database, username: string): Promise<DbUser | null> {
  return db.queryOne<DbUser>('SELECT * FROM users WHERE username = $1', [username]);
}

export async function listAllUsers(db: Database): Promise<DbUser[]> {
  return db.query<DbUser>('SELECT * FROM users ORDER BY created_at ASC');
}

export async function updateUserStatus(db: Database, userId: string, status: 'active' | 'pending' | 'disabled'): Promise<void> {
  await db.execute('UPDATE users SET status = $1 WHERE id = $2', [status, userId]);
}

export async function deleteUser(db: Database, userId: string): Promise<void> {
  // Cascade: revoke all auth artifacts before deleting user
  await db.execute('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
  await db.execute('UPDATE api_keys SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL', [Date.now(), userId]);
  await db.execute('DELETE FROM passkey_credentials WHERE user_id = $1', [userId]);
  await db.execute('DELETE FROM users WHERE id = $1', [userId]);
}

export async function countActiveAdmins(db: Database): Promise<number> {
  const row = await db.queryOne<{ cnt: number }>("SELECT COUNT(*) as cnt FROM users WHERE is_admin = TRUE AND status = 'active'");
  return Number(row?.cnt ?? 0);
}

export async function getSetting(db: Database, key: string): Promise<string | null> {
  const row = await db.queryOne<{ value: string }>('SELECT value FROM settings WHERE key = $1', [key]);
  return row?.value ?? null;
}

export async function setSetting(db: Database, key: string, value: string): Promise<void> {
  await db.execute(
    'INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    [key, value, Date.now()],
  );
}

export async function getAllSettings(db: Database): Promise<Record<string, string>> {
  const rows = await db.query<{ key: string; value: string }>('SELECT key, value FROM settings');
  const map: Record<string, string> = {};
  for (const row of rows) map[row.key] = row.value;
  return map;
}

// ── Platform identities ───────────────────────────────────────────────────

export async function upsertPlatformIdentity(
  db: Database,
  id: string,
  userId: string,
  platform: string,
  platformUserId: string,
): Promise<void> {
  await db.execute(
    'INSERT INTO platform_identities (id, user_id, platform, platform_user_id, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT(platform, platform_user_id) DO NOTHING',
    [id, userId, platform, platformUserId, Date.now()],
  );
}

export async function getUserByPlatformId(
  db: Database,
  platform: string,
  platformUserId: string,
): Promise<DbUser | null> {
  return db.queryOne<DbUser>(
    'SELECT u.* FROM users u JOIN platform_identities pi ON u.id = pi.user_id WHERE pi.platform = $1 AND pi.platform_user_id = $2',
    [platform, platformUserId],
  );
}

// ── Servers ───────────────────────────────────────────────────────────────

export async function createServer(
  db: Database,
  id: string,
  userId: string,
  name: string,
  tokenHash: string,
  keyId?: string,
): Promise<DbServer> {
  const now = Date.now();
  await db.execute(
    'INSERT INTO servers (id, user_id, name, token_hash, status, created_at, bound_with_key_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [id, userId, name, tokenHash, 'offline', now, keyId ?? null],
  );
  return { id, user_id: userId, team_id: null, name, token_hash: tokenHash, last_heartbeat_at: null, status: 'offline', daemon_version: null, bound_with_key_id: keyId ?? null, created_at: now };
}

export async function getServerById(db: Database, id: string): Promise<DbServer | null> {
  return db.queryOne<DbServer>('SELECT * FROM servers WHERE id = $1', [id]);
}

export async function updateServerHeartbeat(db: Database, id: string, daemonVersion?: string | null): Promise<void> {
  if (daemonVersion) {
    await db.execute('UPDATE servers SET last_heartbeat_at = $1, status = $2, daemon_version = $3 WHERE id = $4', [Date.now(), 'online', daemonVersion, id]);
  } else {
    await db.execute('UPDATE servers SET last_heartbeat_at = $1, status = $2 WHERE id = $3', [Date.now(), 'online', id]);
  }
}

export async function updateServerStatus(db: Database, id: string, status: string): Promise<void> {
  await db.execute('UPDATE servers SET status = $1 WHERE id = $2', [status, id]);
}

export async function updateProviderStatus(db: Database, serverId: string, providerId: string, connected: boolean): Promise<void> {
  if (connected) {
    await db.execute(
      `UPDATE servers SET connected_providers = coalesce(connected_providers, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
      [JSON.stringify({ [providerId]: true }), serverId],
    );
  } else {
    await db.execute(
      `UPDATE servers SET connected_providers = coalesce(connected_providers, '{}'::jsonb) - $1 WHERE id = $2`,
      [providerId, serverId],
    );
  }
}

export async function clearProviderStatus(db: Database, serverId: string): Promise<void> {
  await db.execute(`UPDATE servers SET connected_providers = '{}'::jsonb WHERE id = $1`, [serverId]);
}

export async function getProviderStatus(db: Database, serverId: string): Promise<Record<string, boolean>> {
  const row = await db.queryOne<{ connected_providers: Record<string, boolean> | string }>(
    'SELECT connected_providers FROM servers WHERE id = $1',
    [serverId],
  );
  if (!row) return {};
  const val = row.connected_providers;
  if (typeof val === 'string') return JSON.parse(val);
  return val ?? {};
}

export async function updateProviderRemoteSessions(
  db: Database,
  serverId: string,
  providerId: string,
  sessions: unknown[],
): Promise<void> {
  await db.execute(
    `UPDATE servers SET provider_remote_sessions = coalesce(provider_remote_sessions, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
    [JSON.stringify({ [providerId]: sessions }), serverId],
  );
}

export async function getProviderRemoteSessions(
  db: Database,
  serverId: string,
): Promise<Record<string, unknown[]>> {
  const row = await db.queryOne<{ provider_remote_sessions: Record<string, unknown[]> | string }>(
    'SELECT provider_remote_sessions FROM servers WHERE id = $1',
    [serverId],
  );
  if (!row) return {};
  const val = row.provider_remote_sessions;
  if (typeof val === 'string') return JSON.parse(val);
  return val ?? {};
}

export async function updateServerName(db: Database, id: string, userId: string, name: string): Promise<boolean> {
  const result = await db.execute('UPDATE servers SET name = $1 WHERE id = $2 AND user_id = $3', [name, id, userId]);
  return (result.changes ?? 0) > 0;
}

export async function updateServerToken(db: Database, id: string, userId: string, tokenHash: string, name: string, keyId?: string): Promise<boolean> {
  const result = await db.execute('UPDATE servers SET token_hash = $1, name = $2, bound_with_key_id = $3 WHERE id = $4 AND user_id = $5', [tokenHash, name, keyId ?? null, id, userId]);
  return (result.changes ?? 0) > 0;
}

export async function deleteServer(db: Database, id: string, userId: string): Promise<boolean> {
  await db.execute('DELETE FROM channel_bindings WHERE server_id = $1', [id]);
  await db.execute('DELETE FROM sessions WHERE server_id = $1', [id]);
  const result = await db.execute('DELETE FROM servers WHERE id = $1 AND user_id = $2', [id, userId]);
  return (result.changes ?? 0) > 0;
}

export async function getServersByUserId(db: Database, userId: string): Promise<DbServer[]> {
  const ownRows = await db.query<DbServer>(
    'SELECT * FROM servers WHERE user_id = $1 ORDER BY created_at DESC',
    [userId],
  );

  const teamRows = await db.query<DbServer>(
    `SELECT s.* FROM servers s
     JOIN team_members tm ON s.team_id = tm.team_id
     WHERE tm.user_id = $1 AND s.user_id != $2
     ORDER BY s.created_at DESC`,
    [userId, userId],
  );

  const seen = new Set<string>();
  const servers: DbServer[] = [];
  for (const s of [...ownRows, ...teamRows]) {
    if (!seen.has(s.id)) {
      seen.add(s.id);
      servers.push(s);
    }
  }
  return servers;
}

// ── Channel bindings ──────────────────────────────────────────────────────

export async function upsertChannelBinding(
  db: Database,
  id: string,
  serverId: string,
  platform: string,
  channelId: string,
  bindingType: string,
  target: string,
  botId: string,
): Promise<void> {
  await db.execute(
    'INSERT INTO channel_bindings (id, server_id, platform, channel_id, binding_type, target, bot_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT(platform, channel_id, bot_id) DO UPDATE SET binding_type = excluded.binding_type, target = excluded.target, server_id = excluded.server_id',
    [id, serverId, platform, channelId, bindingType, target, botId, Date.now()],
  );
}

export async function getChannelBinding(
  db: Database,
  platform: string,
  channelId: string,
  serverId: string,
): Promise<DbChannelBinding | null> {
  return db.queryOne<DbChannelBinding>(
    'SELECT * FROM channel_bindings WHERE platform = $1 AND channel_id = $2 AND server_id = $3',
    [platform, channelId, serverId],
  );
}

export async function findChannelBindingByPlatformChannel(
  db: Database,
  platform: string,
  channelId: string,
  botId: string,
): Promise<DbChannelBinding | null> {
  return db.queryOne<DbChannelBinding>(
    'SELECT * FROM channel_bindings WHERE platform = $1 AND channel_id = $2 AND bot_id = $3',
    [platform, channelId, botId],
  );
}

// ── Sessions ──────────────────────────────────────────────────────────────

export async function getDbSessionsByServer(db: Database, serverId: string): Promise<DbSession[]> {
  return db.query<DbSession>(
    'SELECT * FROM sessions WHERE server_id = $1 ORDER BY created_at ASC',
    [serverId],
  );
}

export async function upsertDbSession(
  db: Database,
  id: string,
  serverId: string,
  name: string,
  projectName: string,
  role: string,
  agentType: string,
  projectDir: string,
  state: string,
  agentVersion?: string | null,
  runtimeType?: string | null,
  providerId?: string | null,
  providerSessionId?: string | null,
  description?: string | null,
): Promise<void> {
  const now = Date.now();
  await db.execute(
    `INSERT INTO sessions (id, server_id, name, project_name, role, agent_type, agent_version, project_dir, state, runtime_type, provider_id, provider_session_id, description, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT(server_id, name) DO UPDATE SET
       role = excluded.role,
       agent_type = excluded.agent_type,
       agent_version = excluded.agent_version,
       project_dir = excluded.project_dir,
       state = excluded.state,
       runtime_type = excluded.runtime_type,
       provider_id = excluded.provider_id,
       provider_session_id = excluded.provider_session_id,
       description = excluded.description,
       updated_at = excluded.updated_at`,
    [id, serverId, name, projectName, role, agentType, agentVersion ?? null, projectDir, state, runtimeType ?? null, providerId ?? null, providerSessionId ?? null, description ?? null, now, now],
  );
}

export async function deleteDbSession(db: Database, serverId: string, name: string): Promise<void> {
  await db.execute('DELETE FROM sessions WHERE server_id = $1 AND name = $2', [serverId, name]);
}

export async function updateSessionLabel(db: Database, serverId: string, name: string, label: string | null): Promise<void> {
  await db.execute(
    'UPDATE sessions SET label = $1, updated_at = $2 WHERE server_id = $3 AND name = $4',
    [label, Date.now(), serverId, name],
  );
}

export async function updateProjectName(db: Database, serverId: string, sessionName: string, projectName: string): Promise<void> {
  await db.execute(
    'UPDATE sessions SET project_name = $1, updated_at = $2 WHERE server_id = $3 AND name = $4',
    [projectName, Date.now(), serverId, sessionName],
  );
}

export async function updateSession(
  db: Database,
  serverId: string,
  name: string,
  fields: { label?: string | null; description?: string | null; project_dir?: string | null },
): Promise<void> {
  const parts: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;
  if ('label' in fields) { parts.push(`label = $${idx++}`); vals.push(fields.label ?? null); }
  if ('description' in fields) { parts.push(`description = $${idx++}`); vals.push(fields.description ?? null); }
  if ('project_dir' in fields) { parts.push(`project_dir = $${idx++}`); vals.push(fields.project_dir ?? null); }
  if (parts.length === 0) return;
  parts.push(`updated_at = $${idx++}`);
  vals.push(Date.now());
  vals.push(serverId, name);
  await db.execute(
    `UPDATE sessions SET ${parts.join(', ')} WHERE server_id = $${idx++} AND name = $${idx++}`,
    vals,
  );
}

// ── Quick data ────────────────────────────────────────────────────────────

const EMPTY_QUICK_DATA: QuickData = { history: [], sessionHistory: {}, commands: [], phrases: [] };

export async function getQuickData(db: Database, userId: string): Promise<QuickData> {
  const row = await db.queryOne<{ data: string }>('SELECT data FROM user_quick_data WHERE user_id = $1', [userId]);
  if (!row) return { ...EMPTY_QUICK_DATA };
  try {
    return JSON.parse(row.data) as QuickData;
  } catch {
    return { ...EMPTY_QUICK_DATA };
  }
}

export async function upsertQuickData(db: Database, userId: string, data: QuickData): Promise<void> {
  await db.execute(
    'INSERT INTO user_quick_data (user_id, data, updated_at) VALUES ($1, $2, $3) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
    [userId, JSON.stringify(data), Date.now()],
  );
}

// ── Sub-sessions ──────────────────────────────────────────────────────────

export interface DbSubSession {
  id: string;
  server_id: string;
  type: string;
  shell_bin: string | null;
  cwd: string | null;
  label: string | null;
  closed_at: number | null;
  created_at: number;
  updated_at: number;
  cc_session_id: string | null;
  gemini_session_id: string | null;
  parent_session: string | null;
  sort_order: number | null;
  runtime_type: string | null;
  provider_id: string | null;
  provider_session_id: string | null;
  description: string | null;
}

export async function getSubSessionsByServer(db: Database, serverId: string): Promise<DbSubSession[]> {
  return db.query<DbSubSession>(
    'SELECT * FROM sub_sessions WHERE server_id = $1 AND closed_at IS NULL ORDER BY sort_order ASC NULLS LAST, created_at ASC',
    [serverId],
  );
}

export async function getSubSessionByProviderSessionId(
  db: Database,
  serverId: string,
  providerSessionId: string,
): Promise<DbSubSession | null> {
  return db.queryOne<DbSubSession>(
    'SELECT * FROM sub_sessions WHERE server_id = $1 AND provider_session_id = $2 AND closed_at IS NULL',
    [serverId, providerSessionId],
  );
}

export async function getSubSessionById(db: Database, id: string, serverId: string): Promise<DbSubSession | null> {
  return db.queryOne<DbSubSession>(
    'SELECT * FROM sub_sessions WHERE id = $1 AND server_id = $2',
    [id, serverId],
  );
}

export async function createSubSession(
  db: Database,
  id: string,
  serverId: string,
  type: string,
  shellBin: string | null,
  cwd: string | null,
  label: string | null,
  ccSessionId: string | null,
  geminiSessionId: string | null = null,
  parentSession: string | null = null,
  runtimeType: string | null = null,
  providerId: string | null = null,
  providerSessionId: string | null = null,
  description: string | null = null,
): Promise<DbSubSession> {
  const now = Date.now();
  await db.execute(
    `INSERT INTO sub_sessions (id, server_id, type, shell_bin, cwd, label, closed_at, cc_session_id, gemini_session_id, parent_session, runtime_type, provider_id, provider_session_id, description, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (id, server_id) DO UPDATE SET type = EXCLUDED.type, shell_bin = EXCLUDED.shell_bin, cwd = EXCLUDED.cwd, label = COALESCE(EXCLUDED.label, sub_sessions.label), closed_at = NULL, cc_session_id = EXCLUDED.cc_session_id, gemini_session_id = EXCLUDED.gemini_session_id, parent_session = EXCLUDED.parent_session, runtime_type = EXCLUDED.runtime_type, provider_id = EXCLUDED.provider_id, provider_session_id = EXCLUDED.provider_session_id, description = EXCLUDED.description, updated_at = EXCLUDED.updated_at`,
    [id, serverId, type, shellBin, cwd, label, ccSessionId, geminiSessionId, parentSession, runtimeType, providerId, providerSessionId, description, now, now],
  );
  return { id, server_id: serverId, type, shell_bin: shellBin, cwd, label, closed_at: null, cc_session_id: ccSessionId, gemini_session_id: geminiSessionId, parent_session: parentSession, sort_order: null, runtime_type: runtimeType, provider_id: providerId, provider_session_id: providerSessionId, description, created_at: now, updated_at: now };
}

export async function updateSubSession(
  db: Database,
  id: string,
  serverId: string,
  fields: { label?: string | null; closed_at?: number | null; gemini_session_id?: string | null; sort_order?: number | null; description?: string | null; cwd?: string | null },
): Promise<void> {
  const parts: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;
  if ('label' in fields) { parts.push(`label = $${idx++}`); vals.push(fields.label ?? null); }
  if ('closed_at' in fields) { parts.push(`closed_at = $${idx++}`); vals.push(fields.closed_at ?? null); }
  if ('gemini_session_id' in fields) { parts.push(`gemini_session_id = $${idx++}`); vals.push(fields.gemini_session_id ?? null); }
  if ('sort_order' in fields) { parts.push(`sort_order = $${idx++}`); vals.push(fields.sort_order ?? null); }
  if ('description' in fields) { parts.push(`description = $${idx++}`); vals.push(fields.description ?? null); }
  if ('cwd' in fields) { parts.push(`cwd = $${idx++}`); vals.push(fields.cwd ?? null); }
  if (parts.length === 0) return;
  parts.push(`updated_at = $${idx++}`);
  vals.push(Date.now());
  vals.push(id, serverId);
  await db.execute(
    `UPDATE sub_sessions SET ${parts.join(', ')} WHERE id = $${idx++} AND server_id = $${idx++}`,
    vals,
  );
}

export async function reorderSubSessions(db: Database, serverId: string, ids: string[]): Promise<void> {
  const now = Date.now();
  for (let i = 0; i < ids.length; i++) {
    await db.execute(
      'UPDATE sub_sessions SET sort_order = $1, updated_at = $2 WHERE id = $3 AND server_id = $4',
      [i, now, ids[i], serverId],
    );
  }
}

export async function deleteSubSession(db: Database, id: string, serverId: string): Promise<void> {
  await db.execute('DELETE FROM sub_sessions WHERE id = $1 AND server_id = $2', [id, serverId]);
}

// ── User preferences ──────────────────────────────────────────────────────

export async function getUserPref(db: Database, userId: string, key: string): Promise<string | null> {
  const row = await db.queryOne<{ value: string }>(
    'SELECT value FROM user_preferences WHERE user_id = $1 AND key = $2',
    [userId, key],
  );
  return row?.value ?? null;
}

export async function setUserPref(db: Database, userId: string, key: string, value: string): Promise<void> {
  await db.execute(
    'INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    [userId, key, value, Date.now()],
  );
}

export async function deleteUserPref(db: Database, userId: string, key: string): Promise<void> {
  await db.execute('DELETE FROM user_preferences WHERE user_id = $1 AND key = $2', [userId, key]);
}

// ── Discussions ───────────────────────────────────────────────────────────

export interface DbDiscussion {
  id: string;
  server_id: string;
  topic: string;
  state: string;
  max_rounds: number;
  current_round: number;
  total_rounds: number;
  completed_hops: number;
  total_hops: number;
  current_speaker: string | null;
  participants: string | null;
  file_path: string | null;
  conclusion: string | null;
  file_content: string | null;
  error: string | null;
  started_at: number;
  finished_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface DbDiscussionRound {
  id: string;
  discussion_id: string;
  server_id: string;
  round: number;
  speaker_role: string;
  speaker_agent: string;
  speaker_model: string | null;
  response: string;
  created_at: number;
}

export async function getDiscussionsByServer(db: Database, serverId: string): Promise<DbDiscussion[]> {
  return db.query<DbDiscussion>(
    'SELECT * FROM discussions WHERE server_id = $1 ORDER BY created_at DESC LIMIT 50',
    [serverId],
  );
}

export async function getDiscussionById(db: Database, id: string, serverId: string): Promise<DbDiscussion | null> {
  return db.queryOne<DbDiscussion>('SELECT * FROM discussions WHERE id = $1 AND server_id = $2', [id, serverId]);
}

export async function upsertDiscussion(
  db: Database,
  d: {
    id: string;
    serverId: string;
    topic: string;
    state: string;
    maxRounds: number;
    currentRound?: number;
    totalRounds?: number;
    completedHops?: number;
    totalHops?: number;
    currentSpeaker?: string | null;
    participants?: string | null;
    filePath?: string | null;
    conclusion?: string | null;
    fileContent?: string | null;
    error?: string | null;
    startedAt: number;
    finishedAt?: number | null;
  },
): Promise<void> {
  const now = Date.now();
  await db.execute(
    `INSERT INTO discussions (id, server_id, topic, state, max_rounds, current_round, total_rounds, completed_hops, total_hops, current_speaker, participants, file_path, conclusion, file_content, error, started_at, finished_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     ON CONFLICT(id, server_id) DO UPDATE SET
       state = excluded.state,
       current_round = excluded.current_round,
       total_rounds = excluded.total_rounds,
       completed_hops = excluded.completed_hops,
       total_hops = excluded.total_hops,
       current_speaker = excluded.current_speaker,
       participants = excluded.participants,
       file_path = excluded.file_path,
       conclusion = excluded.conclusion,
       file_content = excluded.file_content,
       error = excluded.error,
       finished_at = excluded.finished_at,
       updated_at = excluded.updated_at`,
    [
      d.id, d.serverId, d.topic, d.state, d.maxRounds,
      d.currentRound ?? 0, d.totalRounds ?? 1, d.completedHops ?? 0, d.totalHops ?? 0,
      d.currentSpeaker ?? null, d.participants ?? null,
      d.filePath ?? null, d.conclusion ?? null, d.fileContent ?? null, d.error ?? null,
      d.startedAt, d.finishedAt ?? null, now, now,
    ],
  );
}

export async function insertDiscussionRound(
  db: Database,
  r: {
    id: string;
    discussionId: string;
    serverId: string;
    round: number;
    speakerRole: string;
    speakerAgent: string;
    speakerModel?: string | null;
    response: string;
  },
): Promise<void> {
  await db.execute(
    'INSERT INTO discussion_rounds (id, discussion_id, server_id, round, speaker_role, speaker_agent, speaker_model, response, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [r.id, r.discussionId, r.serverId, r.round, r.speakerRole, r.speakerAgent, r.speakerModel ?? null, r.response, Date.now()],
  );
}

export async function getDiscussionRounds(db: Database, discussionId: string, serverId: string): Promise<DbDiscussionRound[]> {
  return db.query<DbDiscussionRound>(
    'SELECT * FROM discussion_rounds WHERE discussion_id = $1 AND server_id = $2 ORDER BY round, created_at',
    [discussionId, serverId],
  );
}

// ── P2P orchestration runs ────────────────────────────────────────────────

export interface DbOrchestrationRun {
  id: string;
  discussion_id: string;
  server_id: string;
  main_session: string;
  initiator_session: string;
  current_target_session: string | null;
  final_return_session: string;
  remaining_targets: string; // JSON
  mode_key: string;
  status: string;
  request_message_id: string | null;
  callback_message_id: string | null;
  context_ref: string; // JSON
  timeout_ms: number;
  result_summary: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export async function upsertOrchestrationRun(db: Database, r: DbOrchestrationRun): Promise<void> {
  await db.execute(`
    INSERT INTO discussion_orchestration_runs
      (id, discussion_id, server_id, main_session, initiator_session, current_target_session, final_return_session,
       remaining_targets, mode_key, status, request_message_id, callback_message_id, context_ref, timeout_ms,
       result_summary, error, created_at, updated_at, completed_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, $19)
    ON CONFLICT (id, server_id) DO UPDATE SET
      current_target_session = EXCLUDED.current_target_session,
      remaining_targets = EXCLUDED.remaining_targets,
      status = EXCLUDED.status,
      callback_message_id = EXCLUDED.callback_message_id,
      result_summary = EXCLUDED.result_summary,
      error = EXCLUDED.error,
      updated_at = EXCLUDED.updated_at,
      completed_at = EXCLUDED.completed_at
  `, [
    r.id, r.discussion_id, r.server_id, r.main_session, r.initiator_session, r.current_target_session, r.final_return_session,
    r.remaining_targets, r.mode_key, r.status, r.request_message_id, r.callback_message_id, r.context_ref, r.timeout_ms,
    r.result_summary, r.error, r.created_at, r.updated_at, r.completed_at,
  ]);
}

export async function getOrchestrationRunsByDiscussion(db: Database, discussionId: string, serverId: string): Promise<DbOrchestrationRun[]> {
  return db.query<DbOrchestrationRun>(
    'SELECT * FROM discussion_orchestration_runs WHERE discussion_id = $1 AND server_id = $2 ORDER BY created_at DESC',
    [discussionId, serverId],
  );
}

export async function getOrchestrationRunById(db: Database, id: string, serverId: string): Promise<DbOrchestrationRun | null> {
  return db.queryOne<DbOrchestrationRun>('SELECT * FROM discussion_orchestration_runs WHERE id = $1 AND server_id = $2', [id, serverId]);
}

export async function getActiveOrchestrationRuns(db: Database, serverId: string): Promise<DbOrchestrationRun[]> {
  return db.query<DbOrchestrationRun>(
    "SELECT * FROM discussion_orchestration_runs WHERE server_id = $1 AND status IN ('dispatched','running','awaiting_next_hop','queued')",
    [serverId],
  );
}

export async function getRecentOrchestrationRuns(db: Database, serverId: string, limit = 50): Promise<DbOrchestrationRun[]> {
  return db.query<DbOrchestrationRun>(
    'SELECT * FROM discussion_orchestration_runs WHERE server_id = $1 ORDER BY updated_at DESC LIMIT $2',
    [serverId, limit],
  );
}

// ── Audit log ─────────────────────────────────────────────────────────────

export async function writeAuditLog(
  db: Database,
  id: string,
  userId: string,
  serverId: string | null,
  action: string,
  details: unknown,
  ipAddress: string,
): Promise<void> {
  await db.execute(
    'INSERT INTO audit_log (id, user_id, server_id, action, details, ip, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [id, userId, serverId, action, JSON.stringify(details), ipAddress, Date.now()],
  );
}
