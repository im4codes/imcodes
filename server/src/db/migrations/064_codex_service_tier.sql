-- Codex keeps its service tier on the thread, so a session switched to the
-- "Fast" (priority) tier stays there across every resume. Persisting the tier
-- is what lets a viewer be warned that a session is spending plan usage faster
-- than intended, and lets that warning survive a reconnect.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS service_tier TEXT;
ALTER TABLE sub_sessions ADD COLUMN IF NOT EXISTS service_tier TEXT;
