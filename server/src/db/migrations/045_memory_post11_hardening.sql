-- Post-1.1 implementation hardening: close owner-private contracts,
-- prevent shared-table owner-private pollution, and backfill persistent
-- projection content_hash for citation drift.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DELETE FROM shared_context_records WHERE scope = 'user_private';
DELETE FROM shared_context_projections WHERE scope = 'user_private';

UPDATE shared_context_projections
SET content_hash = encode(
  digest('projection-content:v1:' || btrim(summary) || E'\n' || COALESCE(content_json::text, 'null'), 'sha256'),
  'hex'
)
WHERE content_hash IS NULL OR content_hash = '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'owner_private_memories_kind_check'
  ) THEN
    ALTER TABLE owner_private_memories
      ADD CONSTRAINT owner_private_memories_kind_check
      CHECK (kind IN ('fact', 'decision', 'bugfix', 'feature', 'refactor', 'discovery', 'preference', 'skill_candidate', 'workflow', 'code_pattern', 'note')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'owner_private_memories_origin_check'
  ) THEN
    ALTER TABLE owner_private_memories
      ADD CONSTRAINT owner_private_memories_origin_check
      CHECK (origin IN ('chat_compacted', 'user_note', 'skill_import', 'manual_pin', 'agent_learned', 'md_ingest')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'owner_private_memories_size_check'
  ) THEN
    ALTER TABLE owner_private_memories
      ADD CONSTRAINT owner_private_memories_size_check
      CHECK (octet_length(text) <= 32768 AND octet_length(content_json::text) <= 131072) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shared_context_records_scope_no_user_private'
  ) THEN
    ALTER TABLE shared_context_records
      ADD CONSTRAINT shared_context_records_scope_no_user_private
      CHECK (scope IN ('personal', 'project_shared', 'workspace_shared', 'org_shared')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shared_context_projections_personal_identity_check'
  ) THEN
    ALTER TABLE shared_context_projections
      ADD CONSTRAINT shared_context_projections_personal_identity_check
      CHECK (
        scope <> 'personal'
        OR (user_id IS NOT NULL AND enterprise_id IS NULL AND workspace_id IS NULL)
      ) NOT VALID;
  END IF;
END
$$;
