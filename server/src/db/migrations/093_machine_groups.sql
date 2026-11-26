-- A machine belongs to any number of groups.
--
-- `servers.team_id` could hold one, which forced a machine into a single group
-- and made "also share this with the ops group" impossible without taking it
-- out of the one it was in. Group membership moves to its own table so it can
-- be many, and so that deleting a group actually clears the membership rather
-- than leaving a dangling id behind: that column carries no foreign key, so a
-- deleted group left every machine in it pointing at nothing.

CREATE TABLE IF NOT EXISTS machine_groups (
  server_id TEXT   NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  team_id   TEXT   NOT NULL REFERENCES teams(id)   ON DELETE CASCADE,
  added_at  BIGINT NOT NULL,
  PRIMARY KEY (server_id, team_id)
);

-- Admission asks "which groups is this machine in" on every access check, and
-- the group panel asks "which machines are in this group". The primary key
-- serves the first; this index serves the second.
CREATE INDEX IF NOT EXISTS idx_machine_groups_team ON machine_groups(team_id, server_id);

-- Carry over what the single column held. Rows whose group no longer exists are
-- skipped rather than restored: the FK above is the point, and a membership
-- pointing at a deleted group was never real access.
INSERT INTO machine_groups (server_id, team_id, added_at)
SELECT s.id, s.team_id, s.created_at
  FROM servers s
  JOIN teams t ON t.id = s.team_id
 WHERE s.team_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- `servers.team_id` is deliberately left in place and simply stops being read.
-- Dropping it in the same migration that starts using the new table would make
-- a rollback lose the membership it was backfilled from.
