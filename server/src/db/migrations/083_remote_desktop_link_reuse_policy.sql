-- Invitation links can either bind to one browser for their lifetime or be
-- reused by multiple trusted browsers until expiry/revocation.  Existing
-- links become reusable because the pre-080 UI presented their duration as the
-- complete validity boundary and did not offer a one-browser-only choice.

ALTER TABLE remote_desktop_guest_links
  ADD COLUMN IF NOT EXISTS use_policy TEXT NOT NULL DEFAULT 'reusable';

ALTER TABLE remote_desktop_guest_links
  DROP CONSTRAINT IF EXISTS rd_guest_link_use_policy;
ALTER TABLE remote_desktop_guest_links
  ADD CONSTRAINT rd_guest_link_use_policy
  CHECK (use_policy IN ('single_use', 'reusable'));

-- One link may now have one claim per browser key.  A single-use link is kept
-- to one row transactionally by the service while holding the link row lock.
ALTER TABLE remote_desktop_guest_browser_claims
  DROP CONSTRAINT IF EXISTS remote_desktop_guest_browser_claims_pkey;
DROP INDEX IF EXISTS idx_rd_guest_browser_claim_key;
ALTER TABLE remote_desktop_guest_browser_claims
  ADD PRIMARY KEY (link_id, browser_key_hash);
CREATE INDEX IF NOT EXISTS idx_rd_guest_browser_claim_key
  ON remote_desktop_guest_browser_claims(browser_key_hash);

-- Reusable links may have independent live routes in different browsers, but
-- one browser key cannot acquire two concurrent PeerConnection authorities.
DROP INDEX IF EXISTS idx_rd_guest_sessions_one_live_link;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rd_guest_sessions_one_live_link_browser
  ON remote_desktop_guest_sessions(link_id, browser_key_hash)
  WHERE link_id IS NOT NULL
    AND browser_key_hash IS NOT NULL
    AND state IN ('admitting', 'active');
