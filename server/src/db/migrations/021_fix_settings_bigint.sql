-- Fix settings.updated_at column type: INTEGER → BIGINT
-- Date.now() timestamps exceed INT4 max (2147483647) since ~2038,
-- and are already >1.7B in 2025+. The original CREATE TABLE used BIGINT
-- but some deployments may have the table from an earlier INTEGER migration.
ALTER TABLE settings ALTER COLUMN updated_at TYPE BIGINT USING updated_at::bigint;
