-- 105_cloud_docs_and_recent_documents.sql
-- Independent per-user Cloud Docs library (folders + documents backed by server persistent volume)
-- and cross-device Recent Documents history (both server files and cloud documents).

CREATE TABLE IF NOT EXISTS cloud_doc_folders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES cloud_doc_folders(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_doc_folders_user_parent
  ON cloud_doc_folders (user_id, parent_id);

CREATE TABLE IF NOT EXISTS cloud_docs (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id      TEXT REFERENCES cloud_doc_folders(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  ext            TEXT NOT NULL,
  mime_type      TEXT NOT NULL,
  size_bytes     BIGINT NOT NULL,
  content_sha256 TEXT NOT NULL DEFAULT '',
  storage_key    TEXT NOT NULL UNIQUE,
  doc_version    INTEGER NOT NULL DEFAULT 1,
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT NOT NULL,
  last_opened_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_cloud_docs_user_folder_updated
  ON cloud_docs (user_id, folder_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS recent_documents (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_kind    TEXT NOT NULL CHECK (source_kind IN ('server_file', 'cloud_doc')),
  source_key     TEXT NOT NULL,
  server_id      TEXT,
  server_name    TEXT,
  session_name   TEXT,
  file_path      TEXT,
  cloud_doc_id   TEXT REFERENCES cloud_docs(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  mime_type      TEXT NOT NULL,
  open_mode      TEXT NOT NULL DEFAULT 'edit' CHECK (open_mode IN ('view', 'edit')),
  open_count     INTEGER NOT NULL DEFAULT 1,
  last_opened_at BIGINT NOT NULL,
  created_at     BIGINT NOT NULL,
  UNIQUE (user_id, source_key)
);

CREATE INDEX IF NOT EXISTS idx_recent_documents_user_opened
  ON recent_documents (user_id, last_opened_at DESC);

CREATE TABLE IF NOT EXISTS cloud_doc_shares (
  id             TEXT PRIMARY KEY,
  target_kind    TEXT NOT NULL CHECK (target_kind IN ('doc', 'folder')),
  target_id      TEXT NOT NULL,
  share_mode     TEXT NOT NULL CHECK (share_mode IN ('team', 'user')),
  target_team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  target_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  role           TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  allow_download BOOLEAN NOT NULL DEFAULT TRUE,
  created_by     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT NOT NULL,
  revoked_at     BIGINT,
  CHECK (
    (share_mode = 'team' AND target_team_id IS NOT NULL AND target_user_id IS NULL) OR
    (share_mode = 'user' AND target_user_id IS NOT NULL AND target_team_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_cloud_doc_shares_target
  ON cloud_doc_shares (target_kind, target_id) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cloud_doc_shares_team
  ON cloud_doc_shares (target_team_id) WHERE revoked_at IS NULL AND share_mode = 'team';

CREATE INDEX IF NOT EXISTS idx_cloud_doc_shares_user
  ON cloud_doc_shares (target_user_id) WHERE revoked_at IS NULL AND share_mode = 'user';

CREATE UNIQUE INDEX IF NOT EXISTS uq_cloud_doc_shares_active_team
  ON cloud_doc_shares (target_kind, target_id, target_team_id)
  WHERE revoked_at IS NULL AND share_mode = 'team';

CREATE UNIQUE INDEX IF NOT EXISTS uq_cloud_doc_shares_active_user
  ON cloud_doc_shares (target_kind, target_id, target_user_id)
  WHERE revoked_at IS NULL AND share_mode = 'user';
