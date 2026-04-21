import type { Database } from '../db/client.js';

async function deleteProjectionAndEmbedding(tx: Database, projectionId: string): Promise<void> {
  await tx.execute(
    `DELETE FROM shared_context_embeddings
      WHERE source_kind = 'projection'
        AND source_id = $1`,
    [projectionId],
  );
  await tx.execute(
    'DELETE FROM shared_context_projections WHERE id = $1',
    [projectionId],
  );
}

export async function deletePersonalMemoryProjection(db: Database, userId: string, projectionId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const row = await tx.queryOne<{ id: string }>(
      `SELECT id
         FROM shared_context_projections
        WHERE id = $1
          AND scope = 'personal'
          AND user_id = $2`,
      [projectionId, userId],
    );
    if (!row) return false;
    await deleteProjectionAndEmbedding(tx, projectionId);
    return true;
  });
}

export async function deleteEnterpriseMemoryProjection(db: Database, enterpriseId: string, projectionId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const row = await tx.queryOne<{ id: string }>(
      `SELECT id
         FROM shared_context_projections
        WHERE id = $1
          AND enterprise_id = $2
          AND scope IN ('project_shared', 'workspace_shared', 'org_shared')`,
      [projectionId, enterpriseId],
    );
    if (!row) return false;
    await deleteProjectionAndEmbedding(tx, projectionId);
    return true;
  });
}
