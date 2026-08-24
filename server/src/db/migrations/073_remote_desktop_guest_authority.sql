-- Durable remote-desktop guest authority, expiry delivery and management
-- privacy state. This migration is additive and does not enable guest routes;
-- admission remains disabled until the corresponding services are qualified.

CREATE TABLE IF NOT EXISTS remote_desktop_guest_links (
  id                       TEXT PRIMARY KEY,
  host_id                  TEXT NOT NULL REFERENCES remote_desktop_hosts(id) ON DELETE CASCADE,
  owner_user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash_version       TEXT NOT NULL CHECK (token_hash_version = 'v1'),
  token_hash               TEXT NOT NULL UNIQUE,
  creation_request_id      TEXT NOT NULL,
  normalized_policy_hash   TEXT NOT NULL,
  label                    TEXT NOT NULL DEFAULT '',
  attendance               TEXT NOT NULL CHECK (attendance IN ('attended', 'unattended')),
  access_mode              TEXT NOT NULL CHECK (access_mode IN ('view', 'control')),
  expires_at               BIGINT,
  authority_generation     BIGINT NOT NULL DEFAULT 1 CHECK (authority_generation > 0),
  expiry_revision          BIGINT NOT NULL DEFAULT 1 CHECK (expiry_revision > 0),
  commit_revision          BIGINT NOT NULL DEFAULT 1 CHECK (commit_revision > 0),
  state                    TEXT NOT NULL DEFAULT 'active'
                           CHECK (state IN ('active', 'revoked', 'expired')),
  created_at               BIGINT NOT NULL,
  updated_at               BIGINT NOT NULL,
  revoked_at               BIGINT,
  expired_at               BIGINT,
  UNIQUE (owner_user_id, host_id, creation_request_id),
  CHECK ((attendance = 'unattended') = (expires_at IS NOT NULL)),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK ((state = 'expired') = (expired_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_rd_guest_links_host_state
  ON remote_desktop_guest_links(host_id, state, created_at DESC);

CREATE TABLE IF NOT EXISTS remote_desktop_guest_browser_claims (
  link_id                  TEXT PRIMARY KEY REFERENCES remote_desktop_guest_links(id) ON DELETE CASCADE,
  browser_key_hash         TEXT NOT NULL,
  browser_key_hash_version TEXT NOT NULL DEFAULT 'v1'
                           CHECK (browser_key_hash_version = 'v1'),
  claimed_at               BIGINT NOT NULL,
  last_proved_at           BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rd_guest_browser_claim_key
  ON remote_desktop_guest_browser_claims(browser_key_hash);

CREATE TABLE IF NOT EXISTS remote_desktop_guest_sessions (
  id                       TEXT PRIMARY KEY,
  link_id                  TEXT REFERENCES remote_desktop_guest_links(id) ON DELETE CASCADE,
  host_id                  TEXT NOT NULL REFERENCES remote_desktop_hosts(id) ON DELETE CASCADE,
  browser_key_hash         TEXT,
  actor_kind               TEXT NOT NULL CHECK (actor_kind IN ('attended_link', 'unattended_link', 'node_password')),
  route_id                 TEXT,
  route_generation         BIGINT,
  authority_generation     BIGINT NOT NULL CHECK (authority_generation > 0),
  expiry_revision          BIGINT CHECK (expiry_revision IS NULL OR expiry_revision > 0),
  password_generation      BIGINT CHECK (password_generation IS NULL OR password_generation > 0),
  absolute_expires_at      BIGINT,
  state                    TEXT NOT NULL CHECK (state IN ('admitting', 'active', 'closed')),
  created_at               BIGINT NOT NULL,
  updated_at               BIGINT NOT NULL,
  closed_at                BIGINT,
  CHECK ((actor_kind = 'node_password') = (link_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rd_guest_sessions_one_live_link
  ON remote_desktop_guest_sessions(link_id)
  WHERE link_id IS NOT NULL AND state IN ('admitting', 'active');

CREATE INDEX IF NOT EXISTS idx_rd_guest_sessions_host_live
  ON remote_desktop_guest_sessions(host_id, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS remote_desktop_guest_expiry_due (
  link_id                  TEXT NOT NULL REFERENCES remote_desktop_guest_links(id) ON DELETE CASCADE,
  expiry_revision          BIGINT NOT NULL CHECK (expiry_revision > 0),
  expires_at               BIGINT NOT NULL,
  state                    TEXT NOT NULL DEFAULT 'pending'
                           CHECK (state IN ('pending', 'claimed', 'completed', 'stale')),
  claimed_by               TEXT,
  claim_expires_at         BIGINT,
  created_at               BIGINT NOT NULL,
  updated_at               BIGINT NOT NULL,
  PRIMARY KEY (link_id, expiry_revision),
  CHECK ((state = 'claimed') = (claimed_by IS NOT NULL AND claim_expires_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_rd_guest_expiry_due_ready
  ON remote_desktop_guest_expiry_due(expires_at, link_id)
  WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS remote_desktop_host_effect_sequences (
  host_id                  TEXT PRIMARY KEY REFERENCES remote_desktop_hosts(id) ON DELETE CASCADE,
  next_sequence            BIGINT NOT NULL DEFAULT 1 CHECK (next_sequence > 0)
);

CREATE TABLE IF NOT EXISTS remote_desktop_guest_outbox (
  id                       TEXT PRIMARY KEY,
  idempotency_key          TEXT NOT NULL UNIQUE,
  host_id                  TEXT NOT NULL REFERENCES remote_desktop_hosts(id) ON DELETE CASCADE,
  -- Route-scoped rows carry both projections. Host-scoped natural-expiry rows
  -- carry neither and are resolved only by a pod currently owning this host.
  target_server_id         TEXT,
  target_route_id          TEXT,
  target_route_generation  BIGINT CHECK (target_route_generation >= 0),
  sequence                 BIGINT NOT NULL CHECK (sequence > 0),
  effect_type              TEXT NOT NULL
                           CHECK (effect_type IN ('terminal', 'downgrade', 'deadline_update')),
  -- Exact serialized shared RemoteDesktopOutboxEvent. Routing columns above
  -- are indexed projections and MUST match the duplicated event fields.
  payload                  JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  state                    TEXT NOT NULL DEFAULT 'pending'
                           CHECK (state IN ('pending', 'acknowledged')),
  created_at               BIGINT NOT NULL,
  available_at             BIGINT NOT NULL,
  -- Delivery SLO anchor is storage metadata, not part of the shared event:
  -- explicit mutations use commit time; natural expiry uses expires_at.
  slo_anchor_at            BIGINT NOT NULL,
  acknowledged_at          BIGINT,
  retain_until             BIGINT NOT NULL,
  CHECK (slo_anchor_at <= created_at),
  CHECK ((state = 'acknowledged') = (acknowledged_at IS NOT NULL)),
  CHECK ((target_server_id IS NULL) = (target_route_generation IS NULL)),
  UNIQUE (host_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_rd_guest_outbox_delivery
  ON remote_desktop_guest_outbox(state, available_at, host_id, sequence);
CREATE INDEX IF NOT EXISTS idx_rd_guest_outbox_retention
  ON remote_desktop_guest_outbox(retain_until);

CREATE TABLE IF NOT EXISTS remote_desktop_management_privacy (
  host_id                  TEXT PRIMARY KEY REFERENCES remote_desktop_hosts(id) ON DELETE CASCADE,
  epoch_id                 TEXT,
  revision                 BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  -- Phase vocabulary is the shared contract's REMOTE_DESKTOP_PRIVACY_PHASE
  -- (starting / active / ending / recovery_required) plus the database-only
  -- 'idle', which represents "no epoch" and therefore has no wire counterpart.
  phase                    TEXT NOT NULL DEFAULT 'idle'
                           CHECK (phase IN ('idle', 'starting', 'active', 'ending', 'recovery_required')),
  admission_open           BOOLEAN NOT NULL DEFAULT TRUE,
  -- REMOTE_DESKTOP_PRESENTATION_SOURCE.
  presentation_source      TEXT CHECK (presentation_source IN ('management_web', 'signed_shell')),
  initiating_session_hash  TEXT,
  execution_server_id      TEXT,
  daemon_generation        BIGINT,
  worker_generation        BIGINT,
  route_snapshot           JSONB NOT NULL DEFAULT '[]'::jsonb,
  acknowledged_routes      JSONB NOT NULL DEFAULT '[]'::jsonb,
  lease_expires_at         BIGINT,
  deadline                 BIGINT,
  recovery_reason          TEXT,
  fresh_frame_generation   BIGINT,
  created_at               BIGINT NOT NULL,
  updated_at               BIGINT NOT NULL,
  CHECK (
    (phase = 'idle' AND admission_open = TRUE AND epoch_id IS NULL)
    OR (phase <> 'idle' AND admission_open = FALSE AND epoch_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_rd_management_privacy_recovery
  ON remote_desktop_management_privacy(phase, lease_expires_at)
  WHERE phase <> 'idle';

CREATE TABLE IF NOT EXISTS remote_desktop_unattended_passwords (
  host_id                  TEXT PRIMARY KEY REFERENCES remote_desktop_hosts(id) ON DELETE CASCADE,
  verifier_version         TEXT NOT NULL CHECK (verifier_version = 'scrypt-v1'),
  -- Only derived verifier material is durable. scrypt uses an independent
  -- 32-byte random salt; the server-side pepper is referenced by version.
  verifier                 TEXT NOT NULL CHECK (verifier ~ '^[0-9a-f]{128}$'),
  salt                     TEXT NOT NULL CHECK (salt ~ '^[0-9a-f]{64}$'),
  pepper_version           TEXT NOT NULL CHECK (octet_length(pepper_version) BETWEEN 1 AND 64),
  generation               BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
  changed_at               BIGINT NOT NULL CHECK (changed_at >= 0),
  disabled_at              BIGINT,
  CHECK (disabled_at IS NULL OR disabled_at >= changed_at)
);

-- Distributed anonymous-password abuse budgets. Raw source addresses, public
-- IDs and host IDs never enter this table; budget_key_hash is a keyed HMAC.
CREATE TABLE IF NOT EXISTS remote_desktop_password_rate_limits (
  budget_class             TEXT NOT NULL
                           CHECK (budget_class IN ('source', 'target', 'pair', 'host', 'global', 'dummy_work')),
  budget_key_hash          TEXT NOT NULL CHECK (budget_key_hash ~ '^[0-9a-f]{64}$'),
  window_started_at        BIGINT NOT NULL,
  attempt_count            INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  cooldown_level           INTEGER NOT NULL DEFAULT 0 CHECK (cooldown_level >= 0),
  cooldown_until           BIGINT,
  expires_at               BIGINT NOT NULL,
  updated_at               BIGINT NOT NULL,
  PRIMARY KEY (budget_class, budget_key_hash),
  CHECK (cooldown_until IS NULL OR cooldown_until >= window_started_at),
  CHECK (expires_at >= updated_at)
);

CREATE INDEX IF NOT EXISTS idx_rd_password_rate_limits_expiry
  ON remote_desktop_password_rate_limits(expires_at);

CREATE TABLE IF NOT EXISTS remote_desktop_guest_audit (
  id                       TEXT PRIMARY KEY,
  host_id                  TEXT REFERENCES remote_desktop_hosts(id) ON DELETE SET NULL,
  actor_kind               TEXT NOT NULL,
  actor_reference_hash     TEXT,
  event_type               TEXT NOT NULL,
  mode                     TEXT CHECK (mode IN ('view', 'control')),
  source                   TEXT CHECK (source IN ('web_owner', 'controlled_host', 'guest', 'system')),
  metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rd_guest_audit_host_time
  ON remote_desktop_guest_audit(host_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Canonical-host route registry.
--
-- The privacy barrier must see every remote route on a desktop, not just the
-- guest ones. Authenticated Owner/Participant routes live in the Router's
-- process memory, which is invisible to another pod and lost on restart, so
-- classification cannot be built on it.
--
-- This table is the single durable, actor-neutral answer to "is anything
-- capturing this desktop right now". Actor kind is recorded for audit, but the
-- privacy policy never branches on it: an authenticated route blocks
-- management-Web secret UI exactly like a guest route does.
--
-- Routes on different execution endpoints of one canonical host land in one
-- host-scoped set, which is what makes a FULL daemon and its hosted controlled
-- endpoint share one barrier.
CREATE TABLE IF NOT EXISTS remote_desktop_host_routes (
  route_id                 TEXT NOT NULL,
  -- Bumped on reconnect / new daemon generation. A new generation has not
  -- proven the privacy frame, so it re-enters the barrier as its own row.
  route_generation         BIGINT NOT NULL CHECK (route_generation >= 0),
  host_id                  TEXT NOT NULL REFERENCES remote_desktop_hosts(id) ON DELETE CASCADE,
  -- REMOTE_DESKTOP_ACTOR_SOURCE. 'account' is an authenticated Owner or
  -- Participant; the rest are guest authorities.
  actor_source             TEXT NOT NULL
                           CHECK (actor_source IN ('account', 'attended_link', 'unattended_link', 'node_password')),
  -- Stable audit identity only. Never a bearer, password, verifier or key.
  actor_audit_id           TEXT,
  -- Which endpoint of the canonical host is executing this route.
  execution_server_id      TEXT REFERENCES servers(id) ON DELETE SET NULL,
  -- 'admitting' = reserved, pre-PREPARE, holds no Worker authority.
  -- 'active'    = holds Worker authority and is capturing.
  state                    TEXT NOT NULL CHECK (state IN ('admitting', 'active', 'closed')),
  -- Optional back-reference for guest routes; authenticated routes have none.
  guest_session_id         TEXT REFERENCES remote_desktop_guest_sessions(id) ON DELETE SET NULL,
  reserved_at              BIGINT NOT NULL,
  activated_at             BIGINT,
  closed_at                BIGINT,
  updated_at               BIGINT NOT NULL,
  PRIMARY KEY (route_id, route_generation),
  CHECK ((state = 'closed') = (closed_at IS NOT NULL)),
  CHECK (state <> 'active' OR activated_at IS NOT NULL)
);

-- One live generation per route. A reconnect must close the old generation
-- before the new one is reserved, so the barrier can never be asked to shield
-- two concurrent generations of the same route.
CREATE UNIQUE INDEX IF NOT EXISTS idx_rd_host_routes_one_live_generation
  ON remote_desktop_host_routes(route_id)
  WHERE state <> 'closed';

-- The classification read path.
CREATE INDEX IF NOT EXISTS idx_rd_host_routes_host_live
  ON remote_desktop_host_routes(host_id, state)
  WHERE state <> 'closed';

CREATE INDEX IF NOT EXISTS idx_rd_host_routes_guest_session
  ON remote_desktop_host_routes(guest_session_id)
  WHERE guest_session_id IS NOT NULL;
