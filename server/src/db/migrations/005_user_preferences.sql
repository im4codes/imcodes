CREATE TABLE IF NOT EXISTS user_preferences (
  user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,  -- JSON string
  updated_at BIGINT  NOT NULL,
  PRIMARY KEY (user_id, key)
);
