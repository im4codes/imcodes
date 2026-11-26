-- 108_cleanup_non_onlyoffice_md_recent_documents.sql
-- Track whether a recent_documents entry was opened via ONLYOFFICE and remove
-- pre-existing unverified Markdown entries polluted by plain/fallback previews.

ALTER TABLE recent_documents
  ADD COLUMN IF NOT EXISTS opened_with_onlyoffice BOOLEAN NOT NULL DEFAULT FALSE;

DELETE FROM recent_documents
WHERE opened_with_onlyoffice = FALSE
  AND (
    LOWER(COALESCE(file_path, '')) LIKE '%.md'
    OR LOWER(COALESCE(title, '')) LIKE '%.md'
    OR LOWER(COALESCE(mime_type, '')) LIKE 'text/markdown%'
  );
