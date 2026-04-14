-- Shared agent context control-plane storage.
-- Teams remain the enterprise membership source; these tables add workspaces,
-- repository alias governance, shared project enrollment, policy overrides,
-- and authored knowledge document metadata/bindings.

CREATE TABLE IF NOT EXISTS shared_context_workspaces (
  id            TEXT PRIMARY KEY,
  enterprise_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shared_context_workspaces_enterprise
  ON shared_context_workspaces(enterprise_id);

CREATE TABLE IF NOT EXISTS shared_context_repository_aliases (
  id                TEXT PRIMARY KEY,
  enterprise_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  canonical_repo_id TEXT NOT NULL,
  alias_repo_id     TEXT NOT NULL,
  reason            TEXT NOT NULL,
  created_by        TEXT NOT NULL REFERENCES users(id),
  created_at        BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_context_repository_aliases_unique
  ON shared_context_repository_aliases(enterprise_id, alias_repo_id);

CREATE TABLE IF NOT EXISTS shared_project_enrollments (
  id                        TEXT PRIMARY KEY,
  enterprise_id             TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  workspace_id              TEXT REFERENCES shared_context_workspaces(id) ON DELETE SET NULL,
  canonical_repo_id         TEXT NOT NULL,
  display_name              TEXT,
  scope                     TEXT NOT NULL,
  status                    TEXT NOT NULL,
  auto_enabled_for_members  BOOLEAN NOT NULL DEFAULT TRUE,
  member_opt_out_allowed    BOOLEAN NOT NULL DEFAULT FALSE,
  created_by                TEXT NOT NULL REFERENCES users(id),
  created_at                BIGINT NOT NULL,
  updated_at                BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shared_project_enrollments_enterprise
  ON shared_project_enrollments(enterprise_id);

CREATE INDEX IF NOT EXISTS idx_shared_project_enrollments_repo
  ON shared_project_enrollments(canonical_repo_id);

CREATE TABLE IF NOT EXISTS shared_project_members (
  enrollment_id TEXT NOT NULL REFERENCES shared_project_enrollments(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'member',
  added_by      TEXT NOT NULL REFERENCES users(id),
  created_at    BIGINT NOT NULL,
  PRIMARY KEY (enrollment_id, user_id)
);

CREATE TABLE IF NOT EXISTS shared_scope_policy_overrides (
  id                               TEXT PRIMARY KEY,
  enterprise_id                    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  enrollment_id                    TEXT NOT NULL UNIQUE REFERENCES shared_project_enrollments(id) ON DELETE CASCADE,
  allow_degraded_provider_support  BOOLEAN NOT NULL DEFAULT FALSE,
  allow_local_fallback             BOOLEAN NOT NULL DEFAULT FALSE,
  require_full_provider_support    BOOLEAN NOT NULL DEFAULT FALSE,
  created_by                       TEXT NOT NULL REFERENCES users(id),
  created_at                       BIGINT NOT NULL,
  updated_at                       BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS shared_context_documents (
  id            TEXT PRIMARY KEY,
  enterprise_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS shared_context_document_versions (
  id            TEXT PRIMARY KEY,
  document_id    TEXT NOT NULL REFERENCES shared_context_documents(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  label          TEXT,
  content_md     TEXT NOT NULL,
  status         TEXT NOT NULL,
  created_by     TEXT NOT NULL REFERENCES users(id),
  created_at     BIGINT NOT NULL,
  activated_at   BIGINT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_context_document_versions_number
  ON shared_context_document_versions(document_id, version_number);

CREATE TABLE IF NOT EXISTS shared_context_document_bindings (
  id                         TEXT PRIMARY KEY,
  enterprise_id              TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  workspace_id               TEXT REFERENCES shared_context_workspaces(id) ON DELETE SET NULL,
  enrollment_id              TEXT REFERENCES shared_project_enrollments(id) ON DELETE SET NULL,
  document_id                TEXT NOT NULL REFERENCES shared_context_documents(id) ON DELETE CASCADE,
  version_id                 TEXT NOT NULL REFERENCES shared_context_document_versions(id) ON DELETE CASCADE,
  binding_mode               TEXT NOT NULL,
  applicability_repo_id      TEXT,
  applicability_language     TEXT,
  applicability_path_pattern TEXT,
  status                     TEXT NOT NULL,
  created_by                 TEXT NOT NULL REFERENCES users(id),
  created_at                 BIGINT NOT NULL,
  deactivated_at             BIGINT
);

CREATE INDEX IF NOT EXISTS idx_shared_context_document_bindings_enterprise
  ON shared_context_document_bindings(enterprise_id);
