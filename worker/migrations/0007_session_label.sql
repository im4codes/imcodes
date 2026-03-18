-- Add user-defined display label for sessions (for tab rename feature)
ALTER TABLE sessions ADD COLUMN label TEXT;
