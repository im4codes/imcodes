import type { ContextMemoryProjectView, ContextMemoryView } from '../../../shared/context-types.js';
import { computeRelevanceScore, type MemoryScoringWeights, type ProjectionClass } from '../../../shared/memory-scoring.js';
import {
  REPLICABLE_SHARED_PROJECTION_SCOPES,
  type SharedContextProjectionScope,
} from '../../../shared/memory-scope.js';
import type { Database } from '../db/client.js';
import { embeddingToSql, generateEmbedding } from './embedding.js';
import { isMemoryNoiseSummary } from '../../../shared/memory-noise-patterns.js';

type MemoryScope = 'personal' | 'enterprise';
type ProjectionClassFilter = 'recent_summary' | 'durable_memory_candidate' | 'master_summary';
type ProjectionScope = SharedContextProjectionScope;
type ProjectionStatus = 'active' | 'archived' | 'archived_dedup';

export interface SemanticMemoryViewInput {
  db: Database;
  userId: string;
  scope: MemoryScope;
  query: string;
  projectId?: string;
  projectionClass?: ProjectionClassFilter;
  limit?: number;
  enterpriseId?: string;
  scoringWeights?: Partial<MemoryScoringWeights>;
}

interface ScopedMemoryRow {
  id: string;
  scope: ProjectionScope;
  project_id: string;
  projection_class: ProjectionClassFilter;
  source_event_ids_json: string | string[];
  summary: string;
  updated_at: number;
  hit_count?: number | null;
  last_used_at?: number | null;
  status?: ProjectionStatus | null;
  enterprise_id?: string | null;
  similarity: number;
}

interface ScopedStatsRow {
  total_records: number;
  recent_summary_count: number;
  durable_candidate_count: number;
  project_count: number;
}

interface ScopedProjectStatsRow {
  project_id: string;
  total_records: number;
  recent_summary_count: number;
  durable_candidate_count: number;
  updated_at: number;
}

function parseSourceEventCount(sourceEventIds: string | string[]): number {
  if (Array.isArray(sourceEventIds)) return sourceEventIds.length;
  try {
    const parsed = JSON.parse(sourceEventIds || '[]');
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export function buildScopedWhereClause(input: SemanticMemoryViewInput, includeAliases = false): { clause: string; params: unknown[] } {
  const params: unknown[] = [];
  const p = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const alias = includeAliases ? 'p.' : '';
  const conditions: string[] = [
    `COALESCE(${alias}status, 'active') = 'active'`,
  ];

  if (input.scope === 'personal') {
    conditions.push(`${alias}scope = 'personal'`);
    conditions.push(`${alias}user_id = ${p(input.userId)}`);
  } else {
    if (!input.enterpriseId) throw new Error('enterpriseId is required for enterprise semantic memory search');
    const sharedScopePlaceholders = REPLICABLE_SHARED_PROJECTION_SCOPES.map((scope) => p(scope)).join(', ');
    conditions.push(`${alias}scope IN (${sharedScopePlaceholders})`);
    conditions.push(`${alias}enterprise_id = ${p(input.enterpriseId)}`);
  }

  if (input.projectId) {
    conditions.push(`${alias}project_id = ${p(input.projectId)}`);
  }
  if (input.projectionClass) {
    conditions.push(`${alias}projection_class = ${p(input.projectionClass)}`);
  }

  return {
    clause: conditions.join(' AND '),
    params,
  };
}

async function loadScopedStats(db: Database, input: SemanticMemoryViewInput): Promise<ScopedStatsRow> {
  const { clause, params } = buildScopedWhereClause(input, false);
  const row = await db.queryOne<ScopedStatsRow>(
    `SELECT COUNT(*)::int AS total_records,
            COUNT(*) FILTER (WHERE projection_class = 'recent_summary')::int AS recent_summary_count,
            COUNT(*) FILTER (WHERE projection_class = 'durable_memory_candidate')::int AS durable_candidate_count,
            COUNT(DISTINCT project_id)::int AS project_count
       FROM shared_context_projections
      WHERE ${clause}`,
    params,
  );

  return row ?? {
    total_records: 0,
    recent_summary_count: 0,
    durable_candidate_count: 0,
    project_count: 0,
  };
}

async function loadScopedProjectRows(db: Database, input: SemanticMemoryViewInput): Promise<ContextMemoryProjectView[]> {
  const { clause, params } = buildScopedWhereClause(input, false);
  const rows = await db.query<ScopedProjectStatsRow>(
    `SELECT project_id,
            COUNT(*)::int AS total_records,
            COUNT(*) FILTER (WHERE projection_class = 'recent_summary')::int AS recent_summary_count,
            COUNT(*) FILTER (WHERE projection_class = 'durable_memory_candidate')::int AS durable_candidate_count,
            MAX(updated_at) AS updated_at
       FROM shared_context_projections
      WHERE ${clause}
      GROUP BY project_id
      ORDER BY MAX(updated_at) DESC
      LIMIT 200`,
    params,
  );
  return rows
    .filter((row) => row.project_id)
    .map((row) => ({
      projectId: row.project_id,
      displayName: row.project_id,
      totalRecords: row.total_records,
      recentSummaryCount: row.recent_summary_count,
      durableCandidateCount: row.durable_candidate_count,
      updatedAt: row.updated_at,
    }));
}

async function loadScopedVectorRows(db: Database, input: SemanticMemoryViewInput, queryEmbeddingSql: string, candidateLimit: number): Promise<ScopedMemoryRow[]> {
  const { clause, params } = buildScopedWhereClause(input, true);
  const vectorParam = `$${params.length + 1}`;
  const limitParam = `$${params.length + 2}`;
  return db.query<ScopedMemoryRow>(
    `SELECT p.id, p.scope, p.project_id, p.projection_class, p.source_event_ids_json, p.summary, p.updated_at,
            p.hit_count, p.last_used_at, p.status, p.enterprise_id,
            1 - (e.embedding <=> ${vectorParam}::vector) AS similarity
       FROM shared_context_projections p
       JOIN shared_context_embeddings e ON e.source_id = p.id AND e.source_kind = 'projection'
      WHERE ${clause}
      ORDER BY e.embedding <=> ${vectorParam}::vector
      LIMIT ${limitParam}`,
    [...params, queryEmbeddingSql, candidateLimit],
  );
}

export async function searchSemanticMemoryView(input: SemanticMemoryViewInput): Promise<ContextMemoryView | null> {
  const queryText = input.query.trim();
  if (!queryText) return null;

  const embedding = await generateEmbedding(queryText);
  if (!embedding) return null;

  const limit = Math.max(1, Math.min(100, input.limit ?? 20));
  const candidateLimit = Math.max(limit * 4, 20);
  const rows = await loadScopedVectorRows(input.db, input, embeddingToSql(embedding), candidateLimit);
  if (rows.length === 0) return null;

  const [stats, projects] = await Promise.all([
    loadScopedStats(input.db, input),
    loadScopedProjectRows(input.db, input),
  ]);
  const currentProjectId = input.projectId ?? '__unknown_current_project__';
  const ranked = rows
    .filter((row) => !isMemoryNoiseSummary(row.summary))
    .map((row) => ({
      row,
      score: computeRelevanceScore({
        similarity: Number(row.similarity) || 0,
        lastUsedAt: row.last_used_at ?? row.updated_at,
        hitCount: row.hit_count ?? 0,
        projectionClass: row.projection_class as ProjectionClass,
        memoryProjectId: row.project_id,
        currentProjectId,
        memoryEnterpriseId: row.enterprise_id ?? undefined,
        currentEnterpriseId: input.scope === 'enterprise' ? input.enterpriseId : undefined,
      }, input.scoringWeights),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ row }) => row);

  return {
    stats: {
      totalRecords: stats.total_records,
      matchedRecords: ranked.length,
      recentSummaryCount: stats.recent_summary_count,
      durableCandidateCount: stats.durable_candidate_count,
      projectCount: stats.project_count,
      stagedEventCount: 0,
      dirtyTargetCount: 0,
      pendingJobCount: 0,
    },
    records: ranked.map((row) => ({
      id: row.id,
      scope: row.scope,
      projectId: row.project_id,
      summary: row.summary,
      projectionClass: row.projection_class,
      sourceEventCount: parseSourceEventCount(row.source_event_ids_json),
      updatedAt: row.updated_at,
      hitCount: row.hit_count ?? 0,
      lastUsedAt: row.last_used_at ?? undefined,
      status: row.status ?? 'active',
    })),
    projects,
  };
}
