-- Per-user remote desktop wall layout. Only canonical host membership and
-- layout state belong here: credentials, routes, media state and secrets never
-- cross this persistence boundary.
CREATE TABLE IF NOT EXISTS remote_desktop_walls (
  user_id   TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  host_ids  JSONB NOT NULL DEFAULT '[]'::jsonb
            CHECK (jsonb_typeof(host_ids) = 'array'),
  layout    TEXT NOT NULL DEFAULT 'grid' CHECK (layout = 'grid'),
  revision  BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at BIGINT NOT NULL
);
