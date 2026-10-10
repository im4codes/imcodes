-- PROJECT/SESSION identity content moves to the owning daemon's local disk;
-- the server keeps only the hash/length/revision projection in
-- session_identity_metadata (096). Once a row's content is migrated and
-- hash-confirmed by its daemon, the server clears content here -- so it must
-- be nullable. USER-scope rows keep their content (that scope stays
-- server-stored) and are never nulled.
ALTER TABLE session_identity_profiles ALTER COLUMN content DROP NOT NULL;
