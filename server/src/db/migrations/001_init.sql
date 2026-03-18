-- Consolidated PostgreSQL migration (from worker/migrations/0001-0009)
-- Converts: INTEGER timestamps → BIGINT, INSERT OR REPLACE → ON CONFLICT ... DO UPDATE,
--           INSERT OR IGNORE → ON CONFLICT DO NOTHING, removes SQLite-isms.

-- ── Users ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_identities (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  platform         TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  created_at       BIGINT NOT NULL,
  UNIQUE(platform, platform_user_id)
);

-- ── Servers ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS servers (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  team_id           TEXT,
  name              TEXT NOT NULL,
  token_hash        TEXT NOT NULL,
  last_heartbeat_at BIGINT,
  status            TEXT NOT NULL DEFAULT 'offline',
  created_at        BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_servers_user   ON servers(user_id);
CREATE INDEX IF NOT EXISTS idx_servers_team   ON servers(team_id);

-- ── Bind codes ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pending_binds (
  code        TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  server_name TEXT NOT NULL,
  expires_at  BIGINT NOT NULL,
  created_at  BIGINT NOT NULL
);

-- ── Sessions ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  server_id    TEXT NOT NULL REFERENCES servers(id),
  name         TEXT NOT NULL,
  project_name TEXT NOT NULL,
  project_dir  TEXT NOT NULL DEFAULT '',
  label        TEXT,
  role         TEXT NOT NULL,
  agent_type   TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'stopped',
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_server ON sessions(server_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_server_name ON sessions(server_id, name);

-- ── Platform bots ─────────────────────────────────────────────────────────────
-- Must be defined before channel_bindings which references it.

CREATE TABLE IF NOT EXISTS platform_bots (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  platform         TEXT NOT NULL,
  label            TEXT,
  config_encrypted TEXT NOT NULL,
  created_at       BIGINT NOT NULL,
  updated_at       BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_bots_user_idx     ON platform_bots(user_id);
CREATE INDEX IF NOT EXISTS platform_bots_platform_idx ON platform_bots(platform);

-- ── Channel bindings ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS channel_bindings (
  id           TEXT PRIMARY KEY,
  server_id    TEXT NOT NULL REFERENCES servers(id),
  platform     TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  binding_type TEXT NOT NULL,
  target       TEXT NOT NULL,
  bot_id       TEXT REFERENCES platform_bots(id),
  created_at   BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_bindings_bot ON channel_bindings(platform, channel_id, bot_id);
CREATE INDEX IF NOT EXISTS idx_channel_bindings_platform   ON channel_bindings(platform, channel_id, bot_id);

-- ── Cron jobs ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cron_jobs (
  id          TEXT PRIMARY KEY,
  server_id   TEXT NOT NULL REFERENCES servers(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,
  cron_expr   TEXT NOT NULL,
  action      TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'active',
  last_run_at BIGINT,
  next_run_at BIGINT,
  created_at  BIGINT NOT NULL
);

-- ── Audit log ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  server_id  TEXT,
  action     TEXT NOT NULL,
  details    TEXT,
  ip         TEXT,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id, created_at);

-- ── Teams ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS teams (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   TEXT NOT NULL REFERENCES users(id),
  plan       TEXT NOT NULL DEFAULT 'free',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id   TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member',
  joined_at BIGINT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS team_invites (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email      TEXT,
  token      TEXT NOT NULL UNIQUE,
  role       TEXT NOT NULL DEFAULT 'member',
  invited_by TEXT NOT NULL REFERENCES users(id),
  expires_at BIGINT NOT NULL,
  used_at    BIGINT,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_team_members_user  ON team_members(user_id);
CREATE INDEX IF NOT EXISTS idx_team_members_team  ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_invites_token ON team_invites(token);
CREATE INDEX IF NOT EXISTS idx_team_invites_team  ON team_invites(team_id);

-- ── Security ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS api_keys (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  key_hash         TEXT NOT NULL UNIQUE,
  label            TEXT,
  revoked_at       BIGINT,
  grace_expires_at BIGINT,
  created_at       BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user_id  ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  family_id  TEXT NOT NULL,
  used_at    BIGINT,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id   ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family_id ON refresh_tokens(family_id);

CREATE TABLE IF NOT EXISTS idempotency_records (
  key             TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  response_status INTEGER NOT NULL,
  response_body   TEXT NOT NULL,
  created_at      BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_records_user_id    ON idempotency_records(user_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_records_created_at ON idempotency_records(created_at);

CREATE TABLE IF NOT EXISTS auth_lockouts (
  identity       TEXT PRIMARY KEY,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until   BIGINT,
  last_attempt_at BIGINT NOT NULL
);

-- ── Push notifications ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  endpoint   TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

-- ── Quick data ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_quick_data (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),
  data       TEXT NOT NULL DEFAULT '{}',
  updated_at BIGINT NOT NULL
);
