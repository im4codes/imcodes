-- Controlled-node Desk (team) scope.
--
-- A controlled node is a personal/SYSTEM-capable machine. Before this migration
-- its authorization was owner-or-direct-share: `servers.user_id` plus any
-- `server_shares` row naming a globally-resolved user. `servers.team_id` existed
-- and was indexed, but NOTHING in the codebase ever wrote it, so every server
-- row carried NULL and the team-scoped read paths were dead. There was
-- therefore no Desk boundary to fail closed on.
--
-- This migration adds only the persistence needed to bind a controlled node to
-- exactly one Desk. It deliberately does NOT backfill.
--
-- NO BACKFILL, ON PURPOSE: historical `servers.team_id IS NULL` rows stay NULL.
-- Inferring a Desk from "the owner's only team" would silently widen access for
-- machines whose owner happens to belong to a team, which is the opposite of
-- fail-closed and is exactly the kind of guess a security boundary must not
-- make. Unbound machines stay owner-only until their owner explicitly binds
-- them, and their pre-existing share rows are retained but grant nothing.

-- Desk chosen at ticket-mint time and verified again at redeem, so a controlled
-- node can never be created without an explicit, membership-checked Desk.
ALTER TABLE controlled_node_enrollments_v2
  ADD COLUMN IF NOT EXISTS desk_team_id TEXT REFERENCES teams(id) ON DELETE CASCADE;

-- Admission now answers "is this user a member of this machine's Desk?" on
-- every controlled-node access check. The team_members primary key is
-- (team_id, user_id), which cannot serve a user-first probe; without this index
-- each check degrades to a scan of the membership table.
CREATE INDEX IF NOT EXISTS idx_team_members_user
  ON team_members(user_id, team_id);

-- Desk-scoped controlled-node discovery reads team_id for controlled rows only.
CREATE INDEX IF NOT EXISTS idx_servers_controlled_team
  ON servers(team_id)
  WHERE node_role = 'controlled' AND team_id IS NOT NULL;
