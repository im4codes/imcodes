-- Account-authenticated controlled-shell OAuth foundation and sensitive-action
-- step-up grants. Raw authorization codes, shell sessions, and grants are never
-- persisted; only domain-separated SHA-256 hashes are stored.

CREATE TABLE IF NOT EXISTS remote_desktop_web_session_revocations (
  session_hash TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revoked_at   BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rd_web_session_revocations_expiry
  ON remote_desktop_web_session_revocations(expires_at);

CREATE TABLE IF NOT EXISTS remote_desktop_native_auth_codes (
  id                 TEXT PRIMARY KEY,
  code_hash          TEXT NOT NULL UNIQUE,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_session_id TEXT NOT NULL,
  client_id          TEXT NOT NULL,
  redirect_uri       TEXT NOT NULL,
  code_challenge     TEXT NOT NULL,
  state_hash         TEXT NOT NULL,
  issuer             TEXT NOT NULL,
  audience           TEXT NOT NULL,
  expires_at         BIGINT NOT NULL,
  created_at         BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rd_native_auth_codes_expiry
  ON remote_desktop_native_auth_codes(expires_at);

CREATE TABLE IF NOT EXISTS remote_desktop_native_sessions (
  id                        TEXT PRIMARY KEY,
  session_hash              TEXT NOT NULL UNIQUE,
  user_id                   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  originating_session_id    TEXT NOT NULL,
  client_id                 TEXT NOT NULL,
  issuer                    TEXT NOT NULL,
  audience                  TEXT NOT NULL,
  expires_at                BIGINT NOT NULL,
  revoked_at                BIGINT,
  created_at                BIGINT NOT NULL,
  last_used_at              BIGINT
);

CREATE INDEX IF NOT EXISTS idx_rd_native_sessions_user
  ON remote_desktop_native_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_rd_native_sessions_expiry
  ON remote_desktop_native_sessions(expires_at);

CREATE TABLE IF NOT EXISTS remote_desktop_step_up_challenges (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_session_kind   TEXT NOT NULL CHECK (account_session_kind IN ('web', 'native')),
  account_session_id     TEXT NOT NULL,
  canonical_host_id      TEXT NOT NULL,
  action_digest          TEXT NOT NULL,
  request_id             TEXT NOT NULL,
  challenge              TEXT NOT NULL,
  rp_id                   TEXT NOT NULL,
  origin                  TEXT NOT NULL,
  deadline                BIGINT NOT NULL,
  expires_at              BIGINT NOT NULL,
  created_at              BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rd_step_up_challenges_expiry
  ON remote_desktop_step_up_challenges(expires_at);

CREATE TABLE IF NOT EXISTS remote_desktop_step_up_grants (
  id                     TEXT PRIMARY KEY,
  grant_hash             TEXT NOT NULL UNIQUE,
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_session_kind   TEXT NOT NULL CHECK (account_session_kind IN ('web', 'native')),
  account_session_id     TEXT NOT NULL,
  canonical_host_id      TEXT NOT NULL,
  action_digest          TEXT NOT NULL,
  request_id             TEXT NOT NULL,
  deadline               BIGINT NOT NULL,
  expires_at             BIGINT NOT NULL,
  consumed_at            BIGINT,
  result_json            TEXT,
  created_at             BIGINT NOT NULL,
  UNIQUE(user_id, canonical_host_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_rd_step_up_grants_expiry
  ON remote_desktop_step_up_grants(expires_at);
