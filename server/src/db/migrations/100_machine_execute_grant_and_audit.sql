-- Operating a controlled device is no longer executing on it (shared/machine-access-policy.ts).
--
-- 1. An explicit EXECUTE grant lives on the per-device share row. It is set by the device owner only, defaults to FALSE (every existing
--    share therefore means "no execute"), and only a `participant` share can carry it -- a viewer never executes, and a group never
--    grants it (group membership has no row to carry the flag).
ALTER TABLE server_shares ADD COLUMN IF NOT EXISTS exec_granted BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'server_shares_exec_granted_requires_participant'
  ) THEN
    ALTER TABLE server_shares
      ADD CONSTRAINT server_shares_exec_granted_requires_participant
      CHECK (NOT exec_granted OR role = 'participant');
  END IF;
END $$;

-- 2. New nodes are NOT executable until their owner switches execution on. Migration 058 flipped the default to true; this flips it
--    back for rows created from now on. Existing rows are deliberately untouched: a stored value may be an owner decision.
ALTER TABLE servers ALTER COLUMN exec_enabled SET DEFAULT false;

-- 3. The durable machine audit also records REFUSED attempts, for every execute-class action (exec, shell, GUI input, file send/fetch),
--    with the reason, the actor, the delegated (participant) actor and where the access came from. Never the command text.
--    `authorized` = admitted, and the action's result is not tracked row-by-row (file endpoints); `denied` = refused before dispatch.
ALTER TABLE machine_exec_audit ADD COLUMN IF NOT EXISTS action TEXT NOT NULL DEFAULT 'exec';
ALTER TABLE machine_exec_audit ADD COLUMN IF NOT EXISTS decision TEXT NOT NULL DEFAULT 'allowed';
ALTER TABLE machine_exec_audit ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE machine_exec_audit ADD COLUMN IF NOT EXISTS delegated_actor_user_id TEXT;
ALTER TABLE machine_exec_audit ADD COLUMN IF NOT EXISTS access_source TEXT;

DO $$
DECLARE
  c record;
BEGIN
  -- The outcome CHECK of 053 is anonymous: drop every CHECK on the table that mentions the outcome list, then add the wider one.
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'machine_exec_audit'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%dispatched_no_result%'
  LOOP
    EXECUTE format('ALTER TABLE machine_exec_audit DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'machine_exec_audit_outcome_check_v2') THEN
    ALTER TABLE machine_exec_audit ADD CONSTRAINT machine_exec_audit_outcome_check_v2
      CHECK (outcome IN ('pending', 'not_dispatched', 'dispatched_no_result', 'completed', 'node_timeout', 'spawn_error', 'denied', 'authorized'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'machine_exec_audit_decision_check') THEN
    ALTER TABLE machine_exec_audit ADD CONSTRAINT machine_exec_audit_decision_check
      CHECK (decision IN ('allowed', 'denied'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_machine_exec_audit_target_decision
  ON machine_exec_audit(target_server_id, decision, created_at DESC);
