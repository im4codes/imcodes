ALTER TABLE session_identity_profiles
  ADD COLUMN IF NOT EXISTS source_file TEXT;
