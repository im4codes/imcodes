-- Auto unlock is configured on the node itself: the sign-in secret is encrypted
-- machine-scoped through DPAPI in a LOCAL_SYSTEM-only file there and never
-- reaches this database. This column records only whether the node confirmed it
-- holds one, so the list page can show the state and mark the node.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS auto_unlock_configured BOOLEAN NOT NULL DEFAULT FALSE;
