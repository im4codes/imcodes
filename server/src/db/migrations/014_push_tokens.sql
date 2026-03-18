-- Push notification device tokens
CREATE TABLE IF NOT EXISTS push_tokens (
  user_id    TEXT NOT NULL REFERENCES users(id),
  token      TEXT NOT NULL,
  platform   TEXT NOT NULL DEFAULT 'ios',  -- 'ios' | 'android'
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, token)
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens(user_id);
