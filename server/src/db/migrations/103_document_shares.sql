-- 103_document_shares.sql
-- Folder-level and single-file document sharing with internal user/team grants,
-- single-file permission override over inherited folders, and 3-in-1 key-free external grants
-- (external_link with optional access code + first-device/Passkey lock, and one-time magic_invite).

CREATE TABLE IF NOT EXISTS document_shares (
  id                  TEXT PRIMARY KEY,
  server_id           TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  target_kind         TEXT NOT NULL CHECK (target_kind IN ('file', 'folder')),
  target_path         TEXT NOT NULL,
  label               TEXT,
  share_mode          TEXT NOT NULL DEFAULT 'user' CHECK (share_mode IN ('user', 'team', 'external_link', 'magic_invite')),
  target_user_id      TEXT NOT NULL,
  participant_label   TEXT,
  share_token_hash    TEXT UNIQUE,
  access_code_hash    TEXT,
  device_lock_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  bound_device_hash   TEXT,
  redeemed_by_user_id TEXT,
  redeemed_at         BIGINT,
  role                TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  allow_download      BOOLEAN NOT NULL DEFAULT TRUE,
  created_by          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL,
  expires_at          BIGINT,
  revoked_at          BIGINT,
  UNIQUE (server_id, target_path, target_user_id)
);

CREATE INDEX IF NOT EXISTS idx_document_shares_server_revoked
  ON document_shares (server_id, revoked_at);

CREATE INDEX IF NOT EXISTS idx_document_shares_user_revoked
  ON document_shares (target_user_id, revoked_at);

CREATE INDEX IF NOT EXISTS idx_document_shares_token_hash
  ON document_shares (share_token_hash);

-- Authoritative ONLYOFFICE collaborative room state and commit intent WAL
CREATE TABLE IF NOT EXISTS onlyoffice_rooms (
  server_id              TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  normalized_path        TEXT NOT NULL,
  current_confirmed_hash TEXT NOT NULL,
  committed_hash         TEXT NOT NULL,
  last_force_saved_hash  TEXT,
  active_key             TEXT NOT NULL,
  session_epoch          INTEGER NOT NULL DEFAULT 0,
  commit_seq             INTEGER NOT NULL DEFAULT 0,
  active                 BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at             BIGINT NOT NULL,
  PRIMARY KEY (server_id, normalized_path)
);

CREATE TABLE IF NOT EXISTS onlyoffice_commit_journal (
  server_id              TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  normalized_path        TEXT NOT NULL,
  room_key               TEXT NOT NULL,
  target_hash            TEXT NOT NULL,
  session_epoch          INTEGER NOT NULL,
  phase                  TEXT NOT NULL DEFAULT 'intent',
  owner_token            TEXT NOT NULL DEFAULT '',
  expected_seq           INTEGER NOT NULL DEFAULT 0,
  updated_at             BIGINT NOT NULL,
  PRIMARY KEY (server_id, normalized_path)
);

CREATE INDEX IF NOT EXISTS idx_onlyoffice_rooms_lookup
  ON onlyoffice_rooms (server_id, normalized_path);

CREATE INDEX IF NOT EXISTS idx_onlyoffice_journal_lookup
  ON onlyoffice_commit_journal (server_id, normalized_path);
