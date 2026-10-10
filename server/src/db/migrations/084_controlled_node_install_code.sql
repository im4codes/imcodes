-- One-line install command for controlled nodes.
--
-- The pasted command carries a short code rather than the 64-hex download
-- ticket: a ticket is unreadable off a phone screen and impossible to dictate,
-- which is exactly how a remote install tends to be handed over. The code is a
-- second lookup key onto the same enrolment row, so it inherits the existing
-- lease, consume-budget and audit path unchanged.
--
-- Nullable because only tickets minted for the install_command delivery have
-- one. Unique so two enrolments can never answer to the same code.
ALTER TABLE controlled_node_enrollments_v2
  ADD COLUMN IF NOT EXISTS install_code_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollments_v2_install_code_hash
  ON controlled_node_enrollments_v2(install_code_hash)
  WHERE install_code_hash IS NOT NULL;
