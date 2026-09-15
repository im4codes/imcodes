-- Owner-visible guest-link connection audit. The source address is captured
-- from the Server's trusted proxy chain at anonymous WebSocket upgrade; it is
-- never accepted from a browser payload. A connection counts only after the
-- durable route reaches active, and closed_at provides its final duration.

ALTER TABLE remote_desktop_guest_sessions
  ADD COLUMN IF NOT EXISTS source_ip INET,
  ADD COLUMN IF NOT EXISTS connected_at BIGINT;

CREATE INDEX IF NOT EXISTS idx_rd_guest_sessions_link_connection_audit
  ON remote_desktop_guest_sessions(link_id, connected_at DESC)
  WHERE link_id IS NOT NULL AND connected_at IS NOT NULL;
