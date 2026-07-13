-- machine_exec_audit is a durable security-audit table. The spec requires each
-- row to remain "durable ... containing source and target serverId". Migration
-- 053 declared source_server_id / target_server_id as FKs with ON DELETE SET
-- NULL, which ERASES the attribution when the referenced server (a removed /
-- deleted controlled node) is deleted — defeating the durability guarantee.
--
-- This additive migration drops BOTH server foreign keys so the columns become
-- immutable, denormalized TEXT: server deletion no longer touches the audit row,
-- and the recorded serverId text is retained forever. (053 may already have run
-- in live/test PostgreSQL, so this is an additive fix, not a 053 edit; every
-- environment converges to the same FK-less end state.)
--
-- The user_id FK (ON DELETE CASCADE) is INTENTIONALLY LEFT UNCHANGED: deleting a
-- user purges that user's exec audit rows (data-subject deletion), which is a
-- separate, deliberate policy — not the attribution-erasure defect fixed here.
-- Name-agnostic: PostgreSQL auto-names FKs, so drop every FK from
-- machine_exec_audit -> servers regardless of constraint name.
--
-- ATOMICITY: the whole migration is ONE `DO` block (a single statement); it has no
-- RAISE and only idempotent `DROP CONSTRAINT`s, so it either fully applies or (on
-- any error) rolls back wholesale — no half-applied state. No explicit
-- BEGIN/COMMIT (would leave a pooled connection aborted on failure).

DO $$
DECLARE
  fk record;
  v_erased bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'machine_exec_audit'
  ) THEN
    RETURN;
  END IF;

  -- Preflight (BEFORE any mutation): source_server_id / target_server_id are
  -- ALWAYS non-null at insert time, so a NULL in either column can ONLY be 053's
  -- ON DELETE SET NULL having ALREADY erased attribution for a deleted server.
  -- Dropping the FK cannot recover that lost attribution — FAIL CLOSED with the
  -- count so an operator is aware and decides, rather than silently retaining
  -- already-erased rows under a now-immutable schema.
  SELECT count(*) INTO v_erased
    FROM machine_exec_audit
    WHERE source_server_id IS NULL OR target_server_id IS NULL;
  IF v_erased > 0 THEN
    RAISE EXCEPTION
      'machine_exec_audit has % row(s) whose source/target serverId was already erased by 053 ON DELETE SET NULL before this migration; attribution is unrecoverable. Manual remediation required (delete or annotate these rows), then re-run migration 057.',
      v_erased;
  END IF;

  FOR fk IN
    SELECT con.conname
      FROM pg_constraint con
      WHERE con.conrelid = 'machine_exec_audit'::regclass
        AND con.contype = 'f'
        AND con.confrelid = 'servers'::regclass
  LOOP
    EXECUTE format('ALTER TABLE machine_exec_audit DROP CONSTRAINT %I', fk.conname);
  END LOOP;
END $$;
