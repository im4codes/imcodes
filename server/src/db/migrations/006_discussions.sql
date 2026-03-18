-- Discussions: multi-agent structured discussions with rounds and verdict.

CREATE TABLE IF NOT EXISTS discussions (
  id           TEXT PRIMARY KEY,
  server_id    TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  topic        TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'setup',     -- setup | running | verdict | done | failed
  max_rounds   INTEGER NOT NULL DEFAULT 3,
  file_path    TEXT,                               -- path to discussion markdown file
  conclusion   TEXT,                               -- verdict summary (first 500 chars)
  file_content TEXT,                               -- full markdown file content
  error        TEXT,
  started_at   BIGINT NOT NULL,
  finished_at  BIGINT,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discussions_server ON discussions(server_id);

CREATE TABLE IF NOT EXISTS discussion_rounds (
  id              TEXT PRIMARY KEY,
  discussion_id   TEXT NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
  round           INTEGER NOT NULL,
  speaker_role    TEXT NOT NULL,
  speaker_agent   TEXT NOT NULL,                   -- agent type
  speaker_model   TEXT,
  response        TEXT NOT NULL,
  created_at      BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discussion_rounds_discussion ON discussion_rounds(discussion_id);
