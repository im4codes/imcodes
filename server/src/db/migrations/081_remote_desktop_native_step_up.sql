ALTER TABLE remote_desktop_step_up_challenges
  ADD COLUMN IF NOT EXISTS native_verified_at BIGINT;

ALTER TABLE remote_desktop_step_up_challenges
  DROP CONSTRAINT IF EXISTS chk_rd_step_up_native_verified;

ALTER TABLE remote_desktop_step_up_challenges
  ADD CONSTRAINT chk_rd_step_up_native_verified CHECK (
    native_verified_at IS NULL OR (
      account_session_kind = 'native'
      AND native_verified_at >= created_at
      AND native_verified_at < expires_at
      AND native_verified_at < deadline
    )
  );

CREATE INDEX IF NOT EXISTS idx_rd_step_up_native_verified
  ON remote_desktop_step_up_challenges(account_session_id, id)
  WHERE account_session_kind = 'native' AND native_verified_at IS NOT NULL;
