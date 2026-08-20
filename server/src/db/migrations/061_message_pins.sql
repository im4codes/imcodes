CREATE TABLE IF NOT EXISTS message_pins (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id     TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  session_name  TEXT NOT NULL CHECK (char_length(session_name) BETWEEN 1 AND 255),
  event_id      TEXT NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 512),
  event_ts      BIGINT NOT NULL CHECK (event_ts >= 0),
  event_type    TEXT NOT NULL CHECK (event_type IN ('user.message', 'assistant.text')),
  text_snapshot TEXT NOT NULL CHECK (char_length(text_snapshot) BETWEEN 1 AND 20000),
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  UNIQUE (user_id, server_id, session_name, event_id)
);

CREATE INDEX IF NOT EXISTS idx_message_pins_session_list
  ON message_pins (user_id, server_id, session_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_message_pins_server_list
  ON message_pins (user_id, server_id, created_at DESC);
