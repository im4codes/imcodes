-- Password-proofed remote desktops saved by an authenticated guest user.
-- This is a locator, not a share: it never grants server access by itself.
CREATE TABLE IF NOT EXISTS remote_desktop_saved_devices (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host_id              TEXT NOT NULL REFERENCES remote_desktop_hosts(id) ON DELETE CASCADE,
  public_node_id       TEXT NOT NULL,
  password_generation  BIGINT NOT NULL CHECK (password_generation > 0),
  created_at           BIGINT NOT NULL,
  updated_at           BIGINT NOT NULL,
  UNIQUE (user_id, host_id, public_node_id)
);

CREATE INDEX IF NOT EXISTS idx_rd_saved_devices_user
  ON remote_desktop_saved_devices (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_rd_saved_devices_host
  ON remote_desktop_saved_devices (host_id, password_generation);
