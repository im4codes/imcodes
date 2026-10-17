-- Disabling a user must end their logins for good. Access tokens are stateless JWTs, so "revoke" cannot delete them: the admin disable
-- route stamps this column and every login token minted before the stamp (its `iat`) is refused, even after the account is enabled again.
-- Enabling restores the account, never the sessions that were ended. 0 = no session was ever ended.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS sessions_valid_after BIGINT NOT NULL DEFAULT 0;
