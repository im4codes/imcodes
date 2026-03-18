-- Users and platform identities
CREATE TABLE users (
  id TEXT PRIMARY KEY,                -- UUID v4
  created_at INTEGER NOT NULL
);

CREATE TABLE platform_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  platform TEXT NOT NULL,             -- 'discord', 'telegram', 'feishu'
  platform_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(platform, platform_user_id)
);

-- Servers (daemons) bound to the platform
CREATE TABLE servers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT,                       -- nullable, set when shared with a team
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,           -- bcrypt hash of daemon auth token
  last_heartbeat_at INTEGER,
  status TEXT NOT NULL DEFAULT 'offline',  -- 'online', 'offline'
  created_at INTEGER NOT NULL
);

-- Bind codes (short-lived pairing codes)
CREATE TABLE pending_binds (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  server_name TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Sessions (tracked by daemon, synced to D1 for web/mobile)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id),
  name TEXT NOT NULL,                 -- tmux session name e.g. deck_myapp_w1
  project_name TEXT NOT NULL,
  role TEXT NOT NULL,                 -- 'brain', 'w1', 'w2', ...
  agent_type TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'stopped',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Channel bindings (Discord channel → session/brain/project)
CREATE TABLE channel_bindings (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id),
  platform TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  binding_type TEXT NOT NULL,        -- 'session', 'brain', 'project'
  target TEXT NOT NULL,              -- session name, 'brain', or project name
  created_at INTEGER NOT NULL,
  UNIQUE(platform, channel_id, server_id)
);

-- Cron jobs
CREATE TABLE cron_jobs (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  cron_expr TEXT NOT NULL,
  action TEXT NOT NULL,              -- JSON action payload
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER,
  created_at INTEGER NOT NULL
);

-- Audit log
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  server_id TEXT,
  action TEXT NOT NULL,
  details TEXT NOT NULL,             -- JSON
  ip_address TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE INDEX idx_audit_log_user ON audit_log(user_id, timestamp);
CREATE INDEX idx_sessions_server ON sessions(server_id);
CREATE INDEX idx_channel_bindings_platform ON channel_bindings(platform, channel_id);
