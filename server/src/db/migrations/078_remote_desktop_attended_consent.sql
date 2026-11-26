-- Durable attended-consent coordination.
--
-- This table is a Server-side approval ledger only. It contains no link
-- bearer, password, browser private key, capability, SDP/ICE or PREPARE
-- material. The target pod may ask the current authenticated daemon for one
-- local decision, then atomically consume that decision for one exact remote
-- session.

CREATE TABLE IF NOT EXISTS remote_desktop_attended_consents (
  approval_id              TEXT PRIMARY KEY,
  host_id                  TEXT NOT NULL REFERENCES remote_desktop_hosts(id) ON DELETE CASCADE,
  actor_source             TEXT NOT NULL CHECK (actor_source = 'attended_link'),
  actor_audit_id           TEXT NOT NULL,
  browser_key_hash         TEXT NOT NULL CHECK (browser_key_hash ~ '^[0-9a-f]{64}$'),
  execution_server_id      TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  endpoint_generation      BIGINT NOT NULL CHECK (endpoint_generation >= 0),
  daemon_generation        BIGINT NOT NULL CHECK (daemon_generation >= 0),
  access_mode              TEXT NOT NULL CHECK (access_mode IN ('view', 'control')),
  requester_label          TEXT NOT NULL CHECK (octet_length(requester_label) BETWEEN 1 AND 128),
  state                    TEXT NOT NULL DEFAULT 'pending'
                           CHECK (state IN ('pending', 'approved', 'denied', 'cancelled', 'timed_out')),
  node_decision            TEXT CHECK (node_decision IN ('approved', 'denied')),
  node_cancel_reason       TEXT CHECK (node_cancel_reason IN (
                             'timeout', 'local_ui_failed', 'protected_desktop',
                             'non_interactive_session', 'node_restarted',
                             'daemon_generation_changed', 'browser_disconnected',
                             'link_revoked', 'mode_mismatch', 'host_mismatch'
                           )),
  node_resolved_at         BIGINT,
  cancel_reason            TEXT CHECK (cancel_reason IN (
                             'timeout', 'local_ui_failed', 'protected_desktop',
                             'non_interactive_session', 'node_restarted',
                             'daemon_generation_changed', 'browser_disconnected',
                             'link_revoked', 'mode_mismatch', 'host_mismatch'
                           )),
  cancel_trigger           TEXT CHECK (cancel_trigger IN (
                             'browser_disconnect', 'link_revoke', 'local_stop',
                             'endpoint_replaced', 'daemon_disconnect',
                             'caller_cancel', 'node_cancel', 'timeout'
                           )),
  created_at               BIGINT NOT NULL,
  deadline_at              BIGINT NOT NULL,
  resolved_at              BIGINT,
  consumed_at              BIGINT,
  consumed_session_id      TEXT,
  updated_at               BIGINT NOT NULL,
  CHECK (deadline_at > created_at),
  CHECK (
    (node_resolved_at IS NULL AND node_decision IS NULL AND node_cancel_reason IS NULL)
    OR
    (node_resolved_at IS NOT NULL AND (
      (node_decision IS NOT NULL AND node_cancel_reason IS NULL)
      OR (node_decision IS NULL AND node_cancel_reason IS NOT NULL)
    ))
  ),
  CHECK (
    (state = 'pending' AND resolved_at IS NULL AND cancel_reason IS NULL AND cancel_trigger IS NULL)
    OR (state = 'approved' AND node_decision = 'approved' AND resolved_at IS NOT NULL
        AND cancel_reason IS NULL AND cancel_trigger IS NULL)
    OR (state = 'denied' AND node_decision = 'denied' AND resolved_at IS NOT NULL
        AND cancel_reason IS NULL AND cancel_trigger IS NULL)
    OR (state IN ('cancelled', 'timed_out') AND resolved_at IS NOT NULL
        AND cancel_reason IS NOT NULL AND cancel_trigger IS NOT NULL)
  ),
  CHECK ((consumed_at IS NULL) = (consumed_session_id IS NULL)),
  CHECK (consumed_at IS NULL OR state = 'approved')
);

CREATE INDEX IF NOT EXISTS idx_rd_attended_consents_due
  ON remote_desktop_attended_consents(deadline_at, approval_id)
  WHERE state IN ('pending', 'approved') AND consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_rd_attended_consents_browser_pending
  ON remote_desktop_attended_consents(browser_key_hash, created_at)
  WHERE state IN ('pending', 'approved') AND consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_rd_attended_consents_actor_pending
  ON remote_desktop_attended_consents(actor_audit_id, created_at)
  WHERE state IN ('pending', 'approved') AND consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_rd_attended_consents_endpoint_pending
  ON remote_desktop_attended_consents(execution_server_id, daemon_generation, created_at)
  WHERE state IN ('pending', 'approved') AND consumed_at IS NULL;
