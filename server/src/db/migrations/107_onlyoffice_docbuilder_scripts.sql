-- 107_onlyoffice_docbuilder_scripts.sql
-- Shared TTL-backed ephemeral ONLYOFFICE DocBuilder script store across server replicas.

CREATE TABLE IF NOT EXISTS onlyoffice_docbuilder_scripts (
  id         TEXT PRIMARY KEY,
  script     TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_onlyoffice_docbuilder_scripts_expires
  ON onlyoffice_docbuilder_scripts (expires_at);
