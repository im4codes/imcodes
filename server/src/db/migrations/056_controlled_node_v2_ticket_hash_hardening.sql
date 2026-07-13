-- Hardening for partially-upgraded `controlled_node_enrollments_v2` tables.
--
-- 052's compatibility branch (ADD COLUMN IF NOT EXISTS ticket_hash) leaves three
-- defects on a DB that had run an older 052 without ticket_hash, and one on a
-- fresh DB:
--   (a) NULL ticket_hash: pre-ticket rows get ticket_hash added as NULLABLE with
--       no backfill and no NOT NULL — an unusable, non-uniquely-keyed ticket row.
--   (b) duplicate UNIQUE(ticket_hash): a FRESH 052 creates BOTH the inline
--       `..._ticket_hash_key` (from `TEXT NOT NULL UNIQUE`) AND the compat-branch
--       `..._ticket_hash_unique` (from the name-checked ADD CONSTRAINT) — two
--       unique constraints/indexes on the same column.
--   (c) abnormal ticket TTL: the same pre-ticket partial rows had
--       `ticket_expires_at` backfilled to the (long) enrollment `expires_at`,
--       widening a short download-ticket TTL to the enrollment lifetime.
--
-- This additive migration is the authoritative fix (052 may already have run in
-- live/test PostgreSQL; editing 052 would only affect fresh DBs and diverge
-- environments). It is name-agnostic (catalog-driven) and idempotent.
--
-- (a) NULL ticket_hash rows are BLOCKED with a counted error — NEVER auto-deleted.
--     These are the same pre-ticket partial rows that carry the abnormal (c) TTL,
--     so gating them removes the abnormal-TTL rows together. Operators invalidate
--     / re-mint these unreleased tickets manually, then re-run.
-- (b) Duplicate UNIQUE(ticket_hash) constraints are deduplicated to exactly one.
-- (c) Subsumed by (a): 052 adds `ticket_hash` AND `ticket_expires_at` in the SAME
--     compat branch, so a row predating one predates both — every abnormal-TTL
--     partial row (ticket_expires_at backfilled = expires_at) necessarily ALSO has
--     ticket_hash IS NULL and is therefore caught by the (a) gate. A row with a
--     real (NON-NULL) ticket_hash can never carry a backfilled TTL. This
--     coincidence is asserted by a test (partial rows tripping the abnormal TTL
--     also trip the NULL gate). No heuristic TTL rewrite is performed — it would
--     risk clobbering legitimately-minted tickets whose TTL is validly long.
--
-- ATOMICITY CONTRACT (the runner does NOT wrap the file + its _migrations INSERT
-- in one transaction, so this file must be self-atomic):
--   * The entire migration is ONE `DO` block = a single SQL statement. In
--     autocommit mode PostgreSQL runs it in an implicit transaction, and DDL is
--     transactional, so ANY error inside the block rolls the WHOLE block back
--     (all-or-nothing) — there is never a half-applied schema.
--   * The preflight `RAISE EXCEPTION` (NULL ticket_hash gate) is the FIRST action,
--     before ANY `ALTER`/`DROP` mutation, so a failed migration makes ZERO changes.
--   * We deliberately do NOT add explicit `BEGIN`/`COMMIT`: the runner executes on
--     a POOLED connection, and an explicit `BEGIN` left aborted on `RAISE` (the
--     trailing `COMMIT` never runs under the simple-query protocol) would poison
--     the next pool user. The single atomic `DO` block is the correct equivalent.

DO $$
DECLARE
  v_null_count bigint;
  v_con record;
  v_kept text := NULL;
  v_ticket_hash_attnum smallint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'controlled_node_enrollments_v2'
  ) THEN
    RETURN;
  END IF;

  -- (a) fail closed on NULL ticket_hash partial rows (no automatic delete).
  SELECT count(*) INTO v_null_count
    FROM controlled_node_enrollments_v2
    WHERE ticket_hash IS NULL;
  IF v_null_count > 0 THEN
    RAISE EXCEPTION
      'controlled_node_enrollments_v2 has % row(s) with NULL ticket_hash from a partial 052 upgrade; manual remediation required (no automatic delete). Invalidate/re-mint these unreleased tickets, then re-run migration 056.',
      v_null_count;
  END IF;

  -- (b) deduplicate UNIQUE constraints on exactly (ticket_hash); keep one.
  SELECT attnum INTO v_ticket_hash_attnum
    FROM pg_attribute
    WHERE attrelid = 'controlled_node_enrollments_v2'::regclass
      AND attname = 'ticket_hash'
      AND NOT attisdropped;

  FOR v_con IN
    SELECT con.conname
      FROM pg_constraint con
      WHERE con.conrelid = 'controlled_node_enrollments_v2'::regclass
        AND con.contype = 'u'
        AND con.conkey = ARRAY[v_ticket_hash_attnum]::smallint[]
      ORDER BY con.conname
  LOOP
    IF v_kept IS NULL THEN
      v_kept := v_con.conname;   -- keep the first (deterministic by name)
    ELSE
      EXECUTE format(
        'ALTER TABLE controlled_node_enrollments_v2 DROP CONSTRAINT %I',
        v_con.conname);
    END IF;
  END LOOP;

  -- Defensive: drop any duplicate standalone UNIQUE INDEX on (ticket_hash) that is
  -- not backing a constraint (052 uses constraints, but stay catalog-driven).
  FOR v_con IN
    SELECT ix.relname AS conname
      FROM pg_index idx
      JOIN pg_class ix ON ix.oid = idx.indexrelid
      WHERE idx.indrelid = 'controlled_node_enrollments_v2'::regclass
        AND idx.indisunique
        AND idx.indnatts = 1
        AND idx.indkey[0] = v_ticket_hash_attnum
        AND NOT EXISTS (
          SELECT 1 FROM pg_constraint c WHERE c.conindid = idx.indexrelid)
      ORDER BY ix.relname
  LOOP
    IF v_kept IS NULL THEN
      v_kept := v_con.conname;
    ELSE
      EXECUTE format('DROP INDEX IF EXISTS %I', v_con.conname);
    END IF;
  END LOOP;

  -- If a partial table has NO unique on ticket_hash at all (v_kept still NULL),
  -- CREATE one — the bearer-hash uniqueness invariant must hold, and dedup alone
  -- would otherwise leave a non-unique ticket_hash column. Fails closed if
  -- duplicate ticket_hash values exist (uniqueness cannot be enforced on dirty
  -- data — that is a correct hard stop, not a silent pass).
  IF v_kept IS NULL THEN
    ALTER TABLE controlled_node_enrollments_v2
      ADD CONSTRAINT controlled_node_enrollments_v2_ticket_hash_key UNIQUE (ticket_hash);
  END IF;

  -- (c)/(a): now that no NULL ticket_hash rows exist, enforce NOT NULL. Idempotent
  -- (no-op when already NOT NULL on a fresh table).
  ALTER TABLE controlled_node_enrollments_v2
    ALTER COLUMN ticket_hash SET NOT NULL;
END $$;
