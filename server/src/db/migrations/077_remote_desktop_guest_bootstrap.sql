-- Post-proof sticky bootstrap tickets.
--
-- A guest proves a link token or node password against a flat public endpoint
-- that discloses nothing on failure. Only after proof succeeds does the Server
-- hand back the internal `serverId` as a routing key plus one short-lived,
-- single-use bootstrap. The browser then opens the ordinary signalling route
-- with `?serverId=`, and the pod that owns that daemon redeems the bootstrap
-- before admission.
--
-- The ticket is stored hash-only for the same reason link bearers are: a
-- database read must not yield a usable credential.
--
-- `serverId` alone is not authority. Redemption requires the exact ticket, the
-- exact browser key, the exact actor generation and the owning pod, so a
-- leaked routing key cannot list metadata, dispatch PREPARE or mint a lease.
CREATE TABLE IF NOT EXISTS remote_desktop_guest_bootstraps (
  ticket_hash              TEXT PRIMARY KEY CHECK (ticket_hash ~ '^[0-9a-f]{64}$'),
  ticket_hash_version      TEXT NOT NULL DEFAULT 'v1' CHECK (ticket_hash_version = 'v1'),
  host_id                  TEXT NOT NULL REFERENCES remote_desktop_hosts(id) ON DELETE CASCADE,
  -- Null for a node-password actor, which has no link row.
  link_id                  TEXT REFERENCES remote_desktop_guest_links(id) ON DELETE CASCADE,
  -- The exact execution endpoint this ticket is valid at. A ticket redeemed
  -- against any other endpoint is refused without dispatch.
  target_server_id         TEXT NOT NULL,
  actor_source             TEXT NOT NULL
                           CHECK (actor_source IN ('account', 'attended_link', 'unattended_link', 'node_password')),
  mode                     TEXT NOT NULL CHECK (mode IN ('view', 'control')),
  -- Bound at issue time. A later Control-to-View reduction or password rotation
  -- advances these, which strands an in-flight ticket rather than letting it
  -- redeem under superseded authority.
  authority_generation     BIGINT NOT NULL CHECK (authority_generation > 0),
  expiry_revision          BIGINT CHECK (expiry_revision IS NULL OR expiry_revision > 0),
  credential_generation    BIGINT NOT NULL CHECK (credential_generation >= 0),
  -- Hash of the browser's non-exportable key thumbprint; another browser
  -- holding the ticket still cannot redeem it.
  browser_key_hash         TEXT NOT NULL,
  -- Canonical 91-byte SPKI, base64url. Public data by definition, and the only
  -- way redemption can demand a private-key possession proof: the owning pod
  -- verifies the P1363 signature against this exact key before consuming the
  -- ticket. Copying serverId + ticket without the key therefore fails and does
  -- not burn the legitimate holder's single use.
  browser_public_key_spki  TEXT NOT NULL
                           CHECK (char_length(browser_public_key_spki) = 122),
  -- Set when the ticket resumes one exact existing session rather than opening
  -- a new one.
  resume_session_id        TEXT REFERENCES remote_desktop_guest_sessions(id) ON DELETE SET NULL,
  expires_at               BIGINT NOT NULL,
  created_at               BIGINT NOT NULL,
  -- Single use. Redemption stamps both columns in the same transaction that
  -- admits the route, so a replay finds them already set.
  redeemed_at              BIGINT,
  redeemed_by_server_id    TEXT,
  CHECK ((redeemed_at IS NULL) = (redeemed_by_server_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_rd_guest_bootstraps_expiry
  ON remote_desktop_guest_bootstraps(expires_at)
  WHERE redeemed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_rd_guest_bootstraps_host
  ON remote_desktop_guest_bootstraps(host_id, created_at DESC);

-- Owner link mutations that have no delivery target.
--
-- A Control-to-View reduction with no live route still changes durable
-- authority, but the shared outbox contract only permits a host-scoped
-- `terminal` effect — there is deliberately no host-scoped `downgrade`. Rather
-- than fabricate a route-scoped row with an invented target, the reduction is
-- recorded here so the authority change stays auditable and a later reconnect
-- can be checked against it.
CREATE TABLE IF NOT EXISTS remote_desktop_link_authority_log (
  id                       TEXT PRIMARY KEY,
  link_id                  TEXT NOT NULL REFERENCES remote_desktop_guest_links(id) ON DELETE CASCADE,
  host_id                  TEXT NOT NULL REFERENCES remote_desktop_hosts(id) ON DELETE CASCADE,
  owner_user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mutation                 TEXT NOT NULL
                           CHECK (mutation IN ('set_label', 'reduce_to_view', 'shorten_expiry', 'revoke')),
  authority_generation     BIGINT NOT NULL CHECK (authority_generation > 0),
  expiry_revision          BIGINT NOT NULL CHECK (expiry_revision > 0),
  commit_revision          BIGINT NOT NULL CHECK (commit_revision > 0),
  -- How many outbox effects this mutation actually produced. Zero is a valid,
  -- explicit outcome; it must never be confused with "delivery pending".
  effects_emitted          INTEGER NOT NULL DEFAULT 0 CHECK (effects_emitted >= 0),
  step_up_request_id       TEXT NOT NULL,
  created_at               BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rd_link_authority_log_link
  ON remote_desktop_link_authority_log(link_id, created_at DESC);

-- One-use browser-claim challenges.
--
-- A challenge is minted for EVERY canonical bearer request, including one whose
-- token resolves to nothing. `link_id` is therefore nullable and never leaves
-- the Server: the browser sees only `challengeId`/`challenge`, so the response
-- to an unknown bearer is byte-shaped identically to the response for a real
-- one. Deciding existence is deferred to signature proof, where the answer is
-- the same generic unavailable body.
--
-- Only hashes are stored. A database read yields no challenge a caller could
-- sign against.
CREATE TABLE IF NOT EXISTS remote_desktop_guest_claim_challenges (
  challenge_id_hash        TEXT PRIMARY KEY CHECK (challenge_id_hash ~ '^[0-9a-f]{64}$'),
  challenge_hash           TEXT NOT NULL CHECK (challenge_hash ~ '^[0-9a-f]{64}$'),
  challenge_hash_version   TEXT NOT NULL DEFAULT 'v1' CHECK (challenge_hash_version = 'v1'),
  -- Null when the presented bearer resolved to nothing. The row still exists so
  -- that issuing is not itself an existence oracle.
  link_id                  TEXT REFERENCES remote_desktop_guest_links(id) ON DELETE CASCADE,
  expires_at               BIGINT NOT NULL,
  created_at               BIGINT NOT NULL,
  -- Single use. Consumed in the same transaction that verifies the signature,
  -- so a replayed proof finds it already spent.
  consumed_at              BIGINT
);

CREATE INDEX IF NOT EXISTS idx_rd_guest_claim_challenges_expiry
  ON remote_desktop_guest_claim_challenges(expires_at)
  WHERE consumed_at IS NULL;

-- The claim binding records the browser's PUBLIC key alongside the thumbprint
-- hash. The Server never holds the private half; possession is proved by
-- signature, never by presenting a thumbprint.
ALTER TABLE remote_desktop_guest_browser_claims
  ADD COLUMN IF NOT EXISTS browser_public_key_spki TEXT;

ALTER TABLE remote_desktop_guest_browser_claims
  DROP CONSTRAINT IF EXISTS rd_guest_browser_claim_spki_len;
ALTER TABLE remote_desktop_guest_browser_claims
  ADD CONSTRAINT rd_guest_browser_claim_spki_len
  CHECK (browser_public_key_spki IS NULL OR char_length(browser_public_key_spki) = 122);
