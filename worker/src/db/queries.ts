// ── Types ─────────────────────────────────────────────────────────────────

export interface DbUser {
  id: string;
  created_at: number;
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

// ── Users ─────────────────────────────────────────────────────────────────

export async function createUser(db: D1Database, id: string): Promise<DbUser> {
  const now = Date.now();
  await db.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').bind(id, now).run();
  return { id, created_at: now };
}

export async function getUserById(db: D1Database, id: string): Promise<DbUser | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<DbUser>();
}

// ── Platform identities ───────────────────────────────────────────────────

export async function upsertPlatformIdentity(
  db: D1Database,
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
  db: D1Database,
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
  db: D1Database,
  id: string,
  userId: string,
  name: string,
  tokenHash: string,
): Promise<DbServer> {
  const now = Date.now();
  await db
    .prepare('INSERT INTO servers (id, user_id, name, token_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, userId, name, tokenHash, 'offline', now)
    .run();
  return { id, user_id: userId, team_id: null, name, token_hash: tokenHash, last_heartbeat_at: null, status: 'offline', created_at: now };
}

export async function getServerById(db: D1Database, id: string): Promise<DbServer | null> {
  return db.prepare('SELECT * FROM servers WHERE id = ?').bind(id).first<DbServer>();
}

export async function updateServerHeartbeat(db: D1Database, id: string): Promise<void> {
  await db.prepare('UPDATE servers SET last_heartbeat_at = ?, status = ? WHERE id = ?').bind(Date.now(), 'online', id).run();
}

export async function updateServerStatus(db: D1Database, id: string, status: string): Promise<void> {
  await db.prepare('UPDATE servers SET status = ? WHERE id = ?').bind(status, id).run();
}

/**
 * Get all servers accessible to a user: owned servers + team servers, deduplicated.
 */
export async function getServersByUserId(db: D1Database, userId: string): Promise<DbServer[]> {
  // Own servers
  const ownResult = await db.prepare(
    'SELECT * FROM servers WHERE user_id = ? ORDER BY created_at DESC',
  ).bind(userId).all<DbServer>();

  // Team servers: find teams the user belongs to, then servers belonging to those teams
  const teamResult = await db.prepare(
    `SELECT s.* FROM servers s
     JOIN team_members tm ON s.team_id = tm.team_id
     WHERE tm.user_id = ? AND s.user_id != ?
     ORDER BY s.created_at DESC`,
  ).bind(userId, userId).all<DbServer>();

  // Deduplicate by id
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
  db: D1Database,
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
  db: D1Database,
  platform: string,
  channelId: string,
  serverId: string,
): Promise<DbChannelBinding | null> {
  return db
    .prepare('SELECT * FROM channel_bindings WHERE platform = ? AND channel_id = ? AND server_id = ?')
    .bind(platform, channelId, serverId)
    .first<DbChannelBinding>();
}

/**
 * Find a channel binding by platform + channelId + botId.
 * botId makes the lookup deterministic: each bot maps to exactly one binding per channel,
 * eliminating ambiguity when a user has the same channel bound to multiple servers.
 * Cross-tenant isolation is guaranteed because botId is already authenticated in webhook.ts.
 */
export async function findChannelBindingByPlatformChannel(
  db: D1Database,
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

export interface DbSession {
  id: string;
  server_id: string;
  name: string;
  project_name: string;
  role: string;
  agent_type: string;
  project_dir: string;
  state: string;
  label: string | null;
  created_at: number;
  updated_at: number;
}

export async function getDbSessionsByServer(db: D1Database, serverId: string): Promise<DbSession[]> {
  const result = await db
    .prepare('SELECT * FROM sessions WHERE server_id = ? ORDER BY created_at ASC')
    .bind(serverId)
    .all<DbSession>();
  return result.results;
}

export async function upsertDbSession(
  db: D1Database,
  id: string,
  serverId: string,
  name: string,
  projectName: string,
  role: string,
  agentType: string,
  projectDir: string,
  state: string,
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO sessions (id, server_id, name, project_name, role, agent_type, project_dir, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(server_id, name) DO UPDATE SET
         role = excluded.role,
         agent_type = excluded.agent_type,
         project_dir = excluded.project_dir,
         state = excluded.state,
         updated_at = excluded.updated_at`,
    )
    .bind(id, serverId, name, projectName, role, agentType, projectDir, state, now, now)
    .run();
}

export async function deleteDbSession(db: D1Database, serverId: string, name: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE server_id = ? AND name = ?').bind(serverId, name).run();
}

export async function updateSessionLabel(db: D1Database, serverId: string, name: string, label: string | null): Promise<void> {
  await db
    .prepare('UPDATE sessions SET label = ?, updated_at = ? WHERE server_id = ? AND name = ?')
    .bind(label, Date.now(), serverId, name)
    .run();
}

export async function updateProjectName(db: D1Database, serverId: string, sessionName: string, projectName: string): Promise<void> {
  await db
    .prepare('UPDATE sessions SET project_name = ?, updated_at = ? WHERE server_id = ? AND name = ?')
    .bind(projectName, Date.now(), serverId, sessionName)
    .run();
}

// ── Quick data ────────────────────────────────────────────────────────────

export interface QuickData {
  history: string[];
  commands: string[];
  phrases: string[];
}

const EMPTY_QUICK_DATA: QuickData = { history: [], commands: [], phrases: [] };

export async function getQuickData(db: D1Database, userId: string): Promise<QuickData> {
  const row = await db.prepare('SELECT data FROM user_quick_data WHERE user_id = ?').bind(userId).first<{ data: string }>();
  if (!row) return { ...EMPTY_QUICK_DATA };
  try {
    return JSON.parse(row.data) as QuickData;
  } catch {
    return { ...EMPTY_QUICK_DATA };
  }
}

export async function upsertQuickData(db: D1Database, userId: string, data: QuickData): Promise<void> {
  await db
    .prepare(
      'INSERT INTO user_quick_data (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
    )
    .bind(userId, JSON.stringify(data), Date.now())
    .run();
}

// ── Cron jobs ─────────────────────────────────────────────────────────────

export async function getDueCronJobs(db: D1Database): Promise<DbCronJob[]> {
  const now = Date.now();
  const result = await db.prepare('SELECT * FROM cron_jobs WHERE enabled = 1 AND next_run_at <= ?').bind(now).all<DbCronJob>();
  return result.results;
}

export async function updateCronJobRun(db: D1Database, id: string, lastRunAt: number, nextRunAt: number): Promise<void> {
  await db.prepare('UPDATE cron_jobs SET last_run_at = ?, next_run_at = ? WHERE id = ?').bind(lastRunAt, nextRunAt, id).run();
}

// ── Audit log ─────────────────────────────────────────────────────────────

export async function writeAuditLog(
  db: D1Database,
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
