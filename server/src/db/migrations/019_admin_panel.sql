-- Admin panel: user governance + server-wide settings

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

-- Mark the default admin user
UPDATE users SET is_admin = TRUE WHERE username = 'admin';

-- Server-wide settings (key-value)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at BIGINT NOT NULL DEFAULT 0
);

INSERT INTO settings (key, value, updated_at) VALUES
  ('registration_enabled', 'true', 0),
  ('require_approval', 'false', 0)
ON CONFLICT DO NOTHING;
