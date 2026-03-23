import type { PgDatabase } from './client.js';

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
  created_at: number;
}

export interface DbChannelBinding {
  id: string;
  server_id: string;
  platform: string;
  channel_id: string;
  binding_type: string;
  target: string;
  created_at: number;
}

export interface DbCronJob {
  id: string;
  server_id: string;
  user_id: string;
  name: string;
  cron_expr: string;
  action: string;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
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

export async function createUser(db: PgDatabase, id: string): Promise<DbUser> {
  const now = Date.now();
  await db.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').bind(id, now).run();
  return { id, created_at: now, username: null, password_hash: null, display_name: null, password_must_change: null, is_admin: false, status: 'active' };
}

export async function getUserById(db: PgDatabase, id: string): Promise<DbUser | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<DbUser>();
}

export async function getUserByUsername(db: PgDatabase, username: string): Promise<DbUser | null> {
  return db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<DbUser>();
}

export async function listAllUsers(db: PgDatabase): Promise<DbUser[]> {
  const result = await db.prepare('SELECT * FROM users ORDER BY created_at ASC').bind().all<DbUser>();
  return result.results ?? [];
}

export async function updateUserStatus(db: PgDatabase, userId: string, status: 'active' | 'pending' | 'disabled'): Promise<void> {
  await db.prepare('UPDATE users SET status = ? WHERE id = ?').bind(status, userId).run();
}

export async function deleteUser(db: PgDatabase, userId: string): Promise<void> {
  // Cascade: revoke all auth artifacts before deleting user
  await db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').bind(userId).run();
  await db.prepare('UPDATE api_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(Date.now(), userId).run();
  await db.prepare('DELETE FROM passkey_credentials WHERE user_id = ?').bind(userId).run();
  await db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
}

export async function countActiveAdmins(db: PgDatabase): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) as cnt FROM users WHERE is_admin = TRUE AND status = 'active'").bind().first<{ cnt: number }>();
  return Number(row?.cnt ?? 0);
}

export async function getSetting(db: PgDatabase, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: PgDatabase, key: string, value: string): Promise<void> {
  await db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(key, value, Date.now()).run();
}

export async function getAllSettings(db: PgDatabase): Promise<Record<string, string>> {
  const result = await db.prepare('SELECT key, value FROM settings').bind().all<{ key: string; value: string }>();
  const map: Record<string, string> = {};
  for (const row of result.results ?? []) map[row.key] = row.value;
  return map;
}

// ── Platform identities ───────────────────────────────────────────────────

export async function upsertPlatformIdentity(
  db: PgDatabase,
  id: string,
  userId: string,
  platform: string,
  platformUserId: string,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO platform_identities (id, user_id, platform, platform_user_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(platform, platform_user_id) DO NOTHING',
    )
    .bind(id, userId, platform, platformUserId, Date.now())
    .run();
}

export async function getUserByPlatformId(
  db: PgDatabase,
  platform: string,
  platformUserId: string,
): Promise<DbUser | null> {
  const row = await db
    .prepare('SELECT u.* FROM users u JOIN platform_identities pi ON u.id = pi.user_id WHERE pi.platform = ? AND pi.platform_user_id = ?')
    .bind(platform, platformUserId)
    .first<DbUser>();
  return row ?? null;
}

// ── Servers ───────────────────────────────────────────────────────────────

export async function createServer(
  db: PgDatabase,
  id: string,
  userId: string,
  name: string,
  tokenHash: string,
  keyId?: string,
): Promise<DbServer> {
  const now = Date.now();
  await db
    .prepare('INSERT INTO servers (id, user_id, name, token_hash, status, created_at, bound_with_key_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, userId, name, tokenHash, 'offline', now, keyId ?? null)
    .run();
  return { id, user_id: userId, team_id: null, name, token_hash: tokenHash, last_heartbeat_at: null, status: 'offline', daemon_version: null, created_at: now };
}

export async function getServerById(db: PgDatabase, id: string): Promise<DbServer | null> {
  return db.prepare('SELECT * FROM servers WHERE id = ?').bind(id).first<DbServer>();
}

export async function updateServerHeartbeat(db: PgDatabase, id: string, daemonVersion?: string | null): Promise<void> {
  if (daemonVersion) {
    await db.prepare('UPDATE servers SET last_heartbeat_at = ?, status = ?, daemon_version = ? WHERE id = ?').bind(Date.now(), 'online', daemonVersion, id).run();
  } else {
    await db.prepare('UPDATE servers SET last_heartbeat_at = ?, status = ? WHERE id = ?').bind(Date.now(), 'online', id).run();
  }
}

export async function updateServerStatus(db: PgDatabase, id: string, status: string): Promise<void> {
  await db.prepare('UPDATE servers SET status = ? WHERE id = ?').bind(status, id).run();
}

export async function updateServerName(db: PgDatabase, id: string, userId: string, name: string): Promise<boolean> {
  const result = await db.prepare('UPDATE servers SET name = ? WHERE id = ? AND user_id = ?').bind(name, id, userId).run();
  return (result.changes ?? 0) > 0;
}

export async function updateServerToken(db: PgDatabase, id: string, userId: string, tokenHash: string, name: string, keyId?: string): Promise<boolean> {
  const result = await db.prepare('UPDATE servers SET token_hash = ?, name = ?, bound_with_key_id = ? WHERE id = ? AND user_id = ?').bind(tokenHash, name, keyId ?? null, id, userId).run();
  return (result.changes ?? 0) > 0;
}

export async function deleteServer(db: PgDatabase, id: string, userId: string): Promise<boolean> {
  // Delete dependent rows first, then the server row (no FK cascade in SQLite)
  await db.prepare('DELETE FROM channel_bindings WHERE server_id = ?').bind(id).run();
  await db.prepare('DELETE FROM sessions WHERE server_id = ?').bind(id).run();
  const result = await db.prepare('DELETE FROM servers WHERE id = ? AND user_id = ?').bind(id, userId).run();
  return (result.changes ?? 0) > 0;
}

export async function getServersByUserId(db: PgDatabase, userId: string): Promise<DbServer[]> {
  const ownResult = await db.prepare(
    'SELECT * FROM servers WHERE user_id = ? ORDER BY created_at DESC',
  ).bind(userId).all<DbServer>();

  const teamResult = await db.prepare(
    `SELECT s.* FROM servers s
     JOIN team_members tm ON s.team_id = tm.team_id
     WHERE tm.user_id = ? AND s.user_id != ?
     ORDER BY s.created_at DESC`,
  ).bind(userId, userId).all<DbServer>();

  const seen = new Set<string>();
  const servers: DbServer[] = [];
  for (const s of [...ownResult.results, ...teamResult.results]) {
    if (!seen.has(s.id)) {
      seen.add(s.id);
      servers.push(s);
    }
  }
  return servers;
}

// ── Channel bindings ──────────────────────────────────────────────────────

export async function upsertChannelBinding(
  db: PgDatabase,
  id: string,
  serverId: string,
  platform: string,
  channelId: string,
  bindingType: string,
  target: string,
  botId: string,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO channel_bindings (id, server_id, platform, channel_id, binding_type, target, bot_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(platform, channel_id, bot_id) DO UPDATE SET binding_type = excluded.binding_type, target = excluded.target, server_id = excluded.server_id',
    )
    .bind(id, serverId, platform, channelId, bindingType, target, botId, Date.now())
    .run();
}

export async function getChannelBinding(
  db: PgDatabase,
  platform: string,
  channelId: string,
  serverId: string,
): Promise<DbChannelBinding | null> {
  return db
    .prepare('SELECT * FROM channel_bindings WHERE platform = ? AND channel_id = ? AND server_id = ?')
    .bind(platform, channelId, serverId)
    .first<DbChannelBinding>();
}

export async function findChannelBindingByPlatformChannel(
  db: PgDatabase,
  platform: string,
  channelId: string,
  botId: string,
): Promise<DbChannelBinding | null> {
  return db
    .prepare(
      'SELECT * FROM channel_bindings WHERE platform = ? AND channel_id = ? AND bot_id = ?',
    )
    .bind(platform, channelId, botId)
    .first<DbChannelBinding>();
}

// ── Sessions ──────────────────────────────────────────────────────────────

export async function getDbSessionsByServer(db: PgDatabase, serverId: string): Promise<DbSession[]> {
  const result = await db
    .prepare('SELECT * FROM sessions WHERE server_id = ? ORDER BY created_at ASC')
    .bind(serverId)
    .all<DbSession>();
  return result.results;
}

export async function upsertDbSession(
  db: PgDatabase,
  id: string,
  serverId: string,
  name: string,
  projectName: string,
  role: string,
  agentType: string,
  projectDir: string,
  state: string,
  agentVersion?: string | null,
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO sessions (id, server_id, name, project_name, role, agent_type, agent_version, project_dir, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(server_id, name) DO UPDATE SET
         role = excluded.role,
         agent_type = excluded.agent_type,
         agent_version = excluded.agent_version,
         project_dir = excluded.project_dir,
         state = excluded.state,
         updated_at = excluded.updated_at`,
    )
    .bind(id, serverId, name, projectName, role, agentType, agentVersion ?? null, projectDir, state, now, now)
    .run();
}

export async function deleteDbSession(db: PgDatabase, serverId: string, name: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE server_id = ? AND name = ?').bind(serverId, name).run();
}

export async function updateSessionLabel(db: PgDatabase, serverId: string, name: string, label: string | null): Promise<void> {
  await db
    .prepare('UPDATE sessions SET label = ?, updated_at = ? WHERE server_id = ? AND name = ?')
    .bind(label, Date.now(), serverId, name)
    .run();
}

export async function updateProjectName(db: PgDatabase, serverId: string, sessionName: string, projectName: string): Promise<void> {
  await db
    .prepare('UPDATE sessions SET project_name = ?, updated_at = ? WHERE server_id = ? AND name = ?')
    .bind(projectName, Date.now(), serverId, sessionName)
    .run();
}

// ── Quick data ────────────────────────────────────────────────────────────

const EMPTY_QUICK_DATA: QuickData = { history: [], sessionHistory: {}, commands: [], phrases: [] };

export async function getQuickData(db: PgDatabase, userId: string): Promise<QuickData> {
  const row = await db.prepare('SELECT data FROM user_quick_data WHERE user_id = ?').bind(userId).first<{ data: string }>();
  if (!row) return { ...EMPTY_QUICK_DATA };
  try {
    return JSON.parse(row.data) as QuickData;
  } catch {
    return { ...EMPTY_QUICK_DATA };
  }
}

export async function upsertQuickData(db: PgDatabase, userId: string, data: QuickData): Promise<void> {
  await db
    .prepare(
      'INSERT INTO user_quick_data (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
    )
    .bind(userId, JSON.stringify(data), Date.now())
    .run();
}

// ── Cron jobs ─────────────────────────────────────────────────────────────

export async function getDueCronJobs(db: PgDatabase): Promise<DbCronJob[]> {
  const now = Date.now();
  const result = await db.prepare('SELECT * FROM cron_jobs WHERE enabled = 1 AND next_run_at <= ?').bind(now).all<DbCronJob>();
  return result.results;
}

export async function updateCronJobRun(db: PgDatabase, id: string, lastRunAt: number, nextRunAt: number): Promise<void> {
  await db.prepare('UPDATE cron_jobs SET last_run_at = ?, next_run_at = ? WHERE id = ?').bind(lastRunAt, nextRunAt, id).run();
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
}

export async function getSubSessionsByServer(db: PgDatabase, serverId: string): Promise<DbSubSession[]> {
  const result = await db
    .prepare('SELECT * FROM sub_sessions WHERE server_id = ? AND closed_at IS NULL ORDER BY sort_order ASC NULLS LAST, created_at ASC')
    .bind(serverId)
    .all<DbSubSession>();
  return result.results;
}

export async function getSubSessionById(db: PgDatabase, id: string, serverId: string): Promise<DbSubSession | null> {
  return db
    .prepare('SELECT * FROM sub_sessions WHERE id = ? AND server_id = ?')
    .bind(id, serverId)
    .first<DbSubSession>();
}

export async function createSubSession(
  db: PgDatabase,
  id: string,
  serverId: string,
  type: string,
  shellBin: string | null,
  cwd: string | null,
  label: string | null,
  ccSessionId: string | null,
  geminiSessionId: string | null = null,
  parentSession: string | null = null,
): Promise<DbSubSession> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO sub_sessions (id, server_id, type, shell_bin, cwd, label, closed_at, cc_session_id, gemini_session_id, parent_session, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
       ON CONFLICT (id, server_id) DO UPDATE SET type = EXCLUDED.type, shell_bin = EXCLUDED.shell_bin, cwd = EXCLUDED.cwd, label = EXCLUDED.label, closed_at = NULL, cc_session_id = EXCLUDED.cc_session_id, gemini_session_id = EXCLUDED.gemini_session_id, parent_session = EXCLUDED.parent_session, updated_at = EXCLUDED.updated_at`,
    )
    .bind(id, serverId, type, shellBin, cwd, label, ccSessionId, geminiSessionId, parentSession, now, now)
    .run();
  return { id, server_id: serverId, type, shell_bin: shellBin, cwd, label, closed_at: null, cc_session_id: ccSessionId, gemini_session_id: geminiSessionId, parent_session: parentSession, sort_order: null, created_at: now, updated_at: now };
}

export async function updateSubSession(
  db: PgDatabase,
  id: string,
  serverId: string,
  fields: { label?: string | null; closed_at?: number | null; gemini_session_id?: string | null; sort_order?: number | null },
): Promise<void> {
  const parts: string[] = [];
  const vals: unknown[] = [];
  if ('label' in fields) { parts.push('label = ?'); vals.push(fields.label ?? null); }
  if ('closed_at' in fields) { parts.push('closed_at = ?'); vals.push(fields.closed_at ?? null); }
  if ('gemini_session_id' in fields) { parts.push('gemini_session_id = ?'); vals.push(fields.gemini_session_id ?? null); }
  if ('sort_order' in fields) { parts.push('sort_order = ?'); vals.push(fields.sort_order ?? null); }
  if (parts.length === 0) return;
  parts.push('updated_at = ?');
  vals.push(Date.now(), id, serverId);
  await db
    .prepare(`UPDATE sub_sessions SET ${parts.join(', ')} WHERE id = ? AND server_id = ?`)
    .bind(...vals)
    .run();
}

export async function reorderSubSessions(db: PgDatabase, serverId: string, ids: string[]): Promise<void> {
  const now = Date.now();
  for (let i = 0; i < ids.length; i++) {
    await db
      .prepare('UPDATE sub_sessions SET sort_order = ?, updated_at = ? WHERE id = ? AND server_id = ?')
      .bind(i, now, ids[i], serverId)
      .run();
  }
}

export async function deleteSubSession(db: PgDatabase, id: string, serverId: string): Promise<void> {
  await db.prepare('DELETE FROM sub_sessions WHERE id = ? AND server_id = ?').bind(id, serverId).run();
}

// ── User preferences ──────────────────────────────────────────────────────

export async function getUserPref(db: PgDatabase, userId: string, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM user_preferences WHERE user_id = ? AND key = ?')
    .bind(userId, key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setUserPref(db: PgDatabase, userId: string, key: string, value: string): Promise<void> {
  await db
    .prepare(
      'INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    )
    .bind(userId, key, value, Date.now())
    .run();
}

export async function deleteUserPref(db: PgDatabase, userId: string, key: string): Promise<void> {
  await db.prepare('DELETE FROM user_preferences WHERE user_id = ? AND key = ?').bind(userId, key).run();
}

// ── Discussions ───────────────────────────────────────────────────────────

export interface DbDiscussion {
  id: string;
  server_id: string;
  topic: string;
  state: string;
  max_rounds: number;
  current_round: number;
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
  round: number;
  speaker_role: string;
  speaker_agent: string;
  speaker_model: string | null;
  response: string;
  created_at: number;
}

export async function getDiscussionsByServer(db: PgDatabase, serverId: string): Promise<DbDiscussion[]> {
  const rows = await db
    .prepare('SELECT * FROM discussions WHERE server_id = ? ORDER BY created_at DESC LIMIT 50')
    .bind(serverId)
    .all<DbDiscussion>();
  return rows.results ?? [];
}

export async function getDiscussionById(db: PgDatabase, id: string, serverId: string): Promise<DbDiscussion | null> {
  return db.prepare('SELECT * FROM discussions WHERE id = ? AND server_id = ?').bind(id, serverId).first<DbDiscussion>();
}

export async function upsertDiscussion(
  db: PgDatabase,
  d: {
    id: string;
    serverId: string;
    topic: string;
    state: string;
    maxRounds: number;
    currentRound?: number;
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
  await db
    .prepare(
      `INSERT INTO discussions (id, server_id, topic, state, max_rounds, current_round, current_speaker, participants, file_path, conclusion, file_content, error, started_at, finished_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id, server_id) DO UPDATE SET
         state = excluded.state,
         current_round = excluded.current_round,
         current_speaker = excluded.current_speaker,
         participants = excluded.participants,
         file_path = excluded.file_path,
         conclusion = excluded.conclusion,
         file_content = excluded.file_content,
         error = excluded.error,
         finished_at = excluded.finished_at,
         updated_at = excluded.updated_at`,
    )
    .bind(
      d.id, d.serverId, d.topic, d.state, d.maxRounds,
      d.currentRound ?? 0, d.currentSpeaker ?? null, d.participants ?? null,
      d.filePath ?? null, d.conclusion ?? null, d.fileContent ?? null, d.error ?? null,
      d.startedAt, d.finishedAt ?? null, now, now,
    )
    .run();
}

export async function insertDiscussionRound(
  db: PgDatabase,
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
  await db
    .prepare(
      'INSERT INTO discussion_rounds (id, discussion_id, server_id, round, speaker_role, speaker_agent, speaker_model, response, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(r.id, r.discussionId, r.serverId, r.round, r.speakerRole, r.speakerAgent, r.speakerModel ?? null, r.response, Date.now())
    .run();
}

export async function getDiscussionRounds(db: PgDatabase, discussionId: string, serverId: string): Promise<DbDiscussionRound[]> {
  const rows = await db
    .prepare('SELECT * FROM discussion_rounds WHERE discussion_id = ? AND server_id = ? ORDER BY round, created_at')
    .bind(discussionId, serverId)
    .all<DbDiscussionRound>();
  return rows.results ?? [];
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

export async function upsertOrchestrationRun(db: PgDatabase, r: DbOrchestrationRun): Promise<void> {
  await db.prepare(`
    INSERT INTO discussion_orchestration_runs
      (id, discussion_id, server_id, main_session, initiator_session, current_target_session, final_return_session,
       remaining_targets, mode_key, status, request_message_id, callback_message_id, context_ref, timeout_ms,
       result_summary, error, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id, server_id) DO UPDATE SET
      current_target_session = EXCLUDED.current_target_session,
      remaining_targets = EXCLUDED.remaining_targets,
      status = EXCLUDED.status,
      callback_message_id = EXCLUDED.callback_message_id,
      result_summary = EXCLUDED.result_summary,
      error = EXCLUDED.error,
      updated_at = EXCLUDED.updated_at,
      completed_at = EXCLUDED.completed_at
  `).bind(
    r.id, r.discussion_id, r.server_id, r.main_session, r.initiator_session, r.current_target_session, r.final_return_session,
    r.remaining_targets, r.mode_key, r.status, r.request_message_id, r.callback_message_id, r.context_ref, r.timeout_ms,
    r.result_summary, r.error, r.created_at, r.updated_at, r.completed_at,
  ).run();
}

export async function getOrchestrationRunsByDiscussion(db: PgDatabase, discussionId: string): Promise<DbOrchestrationRun[]> {
  const rows = await db
    .prepare('SELECT * FROM discussion_orchestration_runs WHERE discussion_id = ? ORDER BY created_at DESC')
    .bind(discussionId)
    .all<DbOrchestrationRun>();
  return rows.results ?? [];
}

export async function getOrchestrationRunById(db: PgDatabase, id: string, serverId: string): Promise<DbOrchestrationRun | null> {
  return db.prepare('SELECT * FROM discussion_orchestration_runs WHERE id = ? AND server_id = ?').bind(id, serverId).first<DbOrchestrationRun>();
}

export async function getActiveOrchestrationRuns(db: PgDatabase, serverId: string): Promise<DbOrchestrationRun[]> {
  const rows = await db
    .prepare("SELECT * FROM discussion_orchestration_runs WHERE server_id = ? AND status IN ('dispatched','running','awaiting_next_hop','queued')")
    .bind(serverId)
    .all<DbOrchestrationRun>();
  return rows.results ?? [];
}

export async function getRecentOrchestrationRuns(db: PgDatabase, serverId: string, limit = 50): Promise<DbOrchestrationRun[]> {
  const rows = await db
    .prepare('SELECT * FROM discussion_orchestration_runs WHERE server_id = ? ORDER BY updated_at DESC LIMIT ?')
    .bind(serverId, limit)
    .all<DbOrchestrationRun>();
  return rows.results ?? [];
}

// ── Audit log ─────────────────────────────────────────────────────────────

export async function writeAuditLog(
  db: PgDatabase,
  id: string,
  userId: string,
  serverId: string | null,
  action: string,
  details: unknown,
  ipAddress: string,
): Promise<void> {
  await db
    .prepare('INSERT INTO audit_log (id, user_id, server_id, action, details, ip_address, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, userId, serverId, action, JSON.stringify(details), ipAddress, Date.now())
    .run();
}
