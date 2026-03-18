-- Track which API key was used to bind each server,
-- so revoking that key can evict the associated daemon connection.
ALTER TABLE servers ADD COLUMN bound_with_key_id TEXT REFERENCES api_keys(id);
CREATE INDEX IF NOT EXISTS idx_servers_bound_with_key_id ON servers(bound_with_key_id);
