-- Guard external-CLI restricted cron provenance against legacy-server cleanup
-- or downgrade (e.g. an un-upgraded server's owner PUT deleting provenance
-- or a shared PUT replacing creator_user_id), while preserving normal jobs
-- and ON DELETE CASCADE when the parent cron_jobs row itself is deleted.

UPDATE cron_job_provenance
   SET shared = TRUE
 WHERE creator_user_id = '__imcodes_external_cli__'
   AND shared = FALSE;

CREATE OR REPLACE FUNCTION protect_external_cli_cron_provenance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.creator_user_id = '__imcodes_external_cli__'
       AND NEW.shared IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'external_cli_cron_provenance_requires_shared'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.creator_user_id = '__imcodes_external_cli__' THEN
      IF NEW.creator_user_id IS DISTINCT FROM OLD.creator_user_id
         OR NEW.shared IS DISTINCT FROM TRUE
         OR NEW.job_id IS DISTINCT FROM OLD.job_id
         OR NEW.server_id IS DISTINCT FROM OLD.server_id THEN
        RAISE EXCEPTION 'external_cli_cron_provenance_immutable'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW.creator_user_id = '__imcodes_external_cli__'
       AND NEW.shared IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'external_cli_cron_provenance_requires_shared'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- Allow FK ON DELETE CASCADE when the parent cron_jobs row is gone,
    -- but reject direct deletes (such as legacy owner PUT cleanup) while cron_jobs exists.
    IF OLD.creator_user_id = '__imcodes_external_cli__'
       AND EXISTS (SELECT 1 FROM cron_jobs WHERE id = OLD.job_id) THEN
      RAISE EXCEPTION 'external_cli_cron_provenance_protected'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_external_cli_cron_provenance ON cron_job_provenance;
CREATE TRIGGER trg_protect_external_cli_cron_provenance
  BEFORE INSERT OR UPDATE OR DELETE ON cron_job_provenance
  FOR EACH ROW
  EXECUTE FUNCTION protect_external_cli_cron_provenance();
