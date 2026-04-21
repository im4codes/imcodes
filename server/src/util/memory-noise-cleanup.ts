import type { Database } from '../db/client.js';
import { isMemoryNoiseSummary } from '../../../shared/memory-noise-patterns.js';

function placeholders(count: number, offset = 0): string {
  return Array.from({ length: count }, (_, index) => `$${index + 1 + offset}`).join(', ');
}

export async function purgeRemoteMemoryNoiseProjections(db: Database): Promise<number> {
  const rows = await db.query<{ id: string; summary: string }>(
    'SELECT id, summary FROM shared_context_projections WHERE summary IS NOT NULL AND summary != \'\'',
  );
  const badIds = rows.filter((row) => isMemoryNoiseSummary(row.summary)).map((row) => row.id);
  if (badIds.length === 0) return 0;

  const idsSql = placeholders(badIds.length);
  await db.execute(
    `DELETE FROM shared_context_embeddings WHERE source_kind = 'projection' AND source_id IN (${idsSql})`,
    badIds,
  );
  await db.execute(
    `DELETE FROM shared_context_projections WHERE id IN (${idsSql})`,
    badIds,
  );
  return badIds.length;
}
