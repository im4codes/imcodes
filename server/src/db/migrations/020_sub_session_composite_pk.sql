-- Fix primary keys: nanoid(8) can collide across servers.
-- The correct logical identity is (id, server_id) for multi-tenant tables.

-- ── sub_sessions ──
ALTER TABLE sub_sessions DROP CONSTRAINT sub_sessions_pkey;
ALTER TABLE sub_sessions ADD PRIMARY KEY (id, server_id);

-- ── discussions ──
-- Drop FKs referencing discussions(id) first
ALTER TABLE discussion_rounds DROP CONSTRAINT IF EXISTS discussion_rounds_discussion_id_fkey;
ALTER TABLE discussion_orchestration_runs DROP CONSTRAINT IF EXISTS discussion_orchestration_runs_discussion_id_fkey;
ALTER TABLE discussions DROP CONSTRAINT discussions_pkey;
ALTER TABLE discussions ADD PRIMARY KEY (id, server_id);

-- ── discussion_orchestration_runs ──
ALTER TABLE discussion_orchestration_runs DROP CONSTRAINT discussion_orchestration_runs_pkey;
ALTER TABLE discussion_orchestration_runs ADD PRIMARY KEY (id, server_id);

-- Re-add composite FK from discussion_orchestration_runs → discussions
ALTER TABLE discussion_orchestration_runs
  ADD CONSTRAINT discussion_orchestration_runs_discussion_fk
  FOREIGN KEY (discussion_id, server_id) REFERENCES discussions(id, server_id) ON DELETE CASCADE;

-- ── discussion_rounds: add server_id column + composite FK ──
ALTER TABLE discussion_rounds ADD COLUMN IF NOT EXISTS server_id TEXT;
-- Backfill server_id from parent discussion
UPDATE discussion_rounds dr
  SET server_id = d.server_id
  FROM discussions d
  WHERE dr.discussion_id = d.id AND dr.server_id IS NULL;
-- Make NOT NULL after backfill
ALTER TABLE discussion_rounds ALTER COLUMN server_id SET NOT NULL;
-- Add composite FK
ALTER TABLE discussion_rounds
  ADD CONSTRAINT discussion_rounds_discussion_fk
  FOREIGN KEY (discussion_id, server_id) REFERENCES discussions(id, server_id) ON DELETE CASCADE;
