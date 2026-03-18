CREATE TABLE IF NOT EXISTS user_quick_data (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  data    TEXT    NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
