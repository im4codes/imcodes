import {
  GLOBAL_TASK_NOTIFY_CHANNEL,
  GLOBAL_TASK_RECENT_FINISHED_LIMIT,
  GLOBAL_TASK_STATS_MAX_WINDOW_MS,
  GLOBAL_TASK_TERMINAL_WINDOW_MS,
  computeGlobalTaskCompletionStats,
  emptyGlobalTaskCompletionStats,
  isGlobalTaskAttentionNeeded,
  isGlobalTaskTerminalStatus,
  isGlobalTaskWithinSyncWindow,
  isNoAuditorSentinel,
  normalizeGlobalChecklist,
  normalizeGlobalTaskAuditSummary,
  type GlobalTaskAuditSummary,
  type GlobalTaskBrainSummary,
  type GlobalTaskChecklistProgress,
  type GlobalTaskServerSummary,
  type GlobalTaskSnapshotResponse,
  type GlobalTaskSummaryRow,
} from '../../../shared/global-task-mode.js';
import { NODE_ROLE } from '../../../shared/remote-exec.js';
import { TASK_PAIR_NO_AUDITOR } from '../../../shared/task-pair.js';
import {
  fallbackReadableSessionDisplay,
  isInternalSessionDisplayValue,
  pickReadableSessionDisplay,
} from '../../../shared/session-display.js';
import type { Database } from './client.js';
import { getFullServersByUserId, type DbServer, type DbSession } from './queries.js';

export interface GlobalTaskSummaryUpsertInput {
  serverId: string;
  taskId: string;
  projectName?: string;
  brainSession?: string;
  brainLabel?: string;
  title?: string;
  status: string;
  flags?: readonly string[];
  round?: number;
  checklist?: Partial<GlobalTaskChecklistProgress> | null;
  executorLabel?: string;
  auditorLabel?: string;
  executorModel?: string;
  auditorModel?: string;
  auditor?: string;
  liveSummary?: string;
  lastAudit?: GlobalTaskAuditSummary | null;
  startedAt?: number;
  endedAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

interface RawSummaryRow {
  server_id: string;
  task_id: string;
  project_name: string;
  brain_session: string;
  brain_label: string;
  title: string;
  status: string;
  flags_json: string;
  round: number;
  checklist_total: number;
  checklist_implemented: number;
  checklist_audited: number;
  executor_label: string | null;
  auditor_label: string | null;
  executor_model?: string | null;
  auditor_model?: string | null;
  auditor: string | null;
  live_summary: string | null;
  last_audit_json?: string | null;
  is_terminal: boolean | number;
  needs_attention: boolean | number;
  started_at?: number | string | null;
  ended_at?: number | string | null;
  created_at: number | string;
  updated_at: number | string;
}

function parseLastAuditJson(raw: string | null | undefined): GlobalTaskAuditSummary | undefined {
  if (!raw) return undefined;
  try {
    return normalizeGlobalTaskAuditSummary(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function parseFlagsJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  } catch {
    return [];
  }
}

function cleanStr(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanOptionalStr(value: string | null | undefined): string | undefined {
  const trimmed = cleanStr(value);
  return trimmed ? trimmed : undefined;
}

function cleanModelOptional(value: string | null | undefined): string | undefined {
  const trimmed = cleanOptionalStr(value);
  if (!trimmed || isNoAuditorSentinel(trimmed)) return undefined;
  return trimmed;
}

function mapRawSummaryRow(
  row: RawSummaryRow,
  serverMeta: { name: string; online: boolean },
  brainLabelFallback?: string,
  brainProjectFallback?: string,
): GlobalTaskSummaryRow {
  const flags = parseFlagsJson(row.flags_json);
  const status = String(row.status || '');
  const brainSession = String(row.brain_session || '');
  const brainLabel = pickReadableSessionDisplay(
    [brainLabelFallback, row.brain_label, brainProjectFallback, row.project_name],
    brainSession,
  ) ?? fallbackReadableSessionDisplay(brainSession, { defaultLabel: 'Brain', workerLabel: 'Worker' });
  const rawExecutorLabel = cleanOptionalStr(row.executor_label);
  const executorLabel = rawExecutorLabel && !isInternalSessionDisplayValue(rawExecutorLabel)
    ? rawExecutorLabel
    : undefined;
  const auditor = cleanOptionalStr(row.auditor);
  const rawAuditorLabel = cleanOptionalStr(row.auditor_label);
  const auditorLabel = rawAuditorLabel && !isInternalSessionDisplayValue(rawAuditorLabel, auditor)
    ? rawAuditorLabel
    : undefined;
  const executorModel = cleanModelOptional(row.executor_model);
  const auditorModel = isNoAuditorSentinel(auditor) ? undefined : cleanModelOptional(row.auditor_model);
  const startedAt = typeof row.started_at === 'number' || (typeof row.started_at === 'string' && row.started_at !== '')
    ? (Number(row.started_at) || 0)
    : 0;
  const endedAt = typeof row.ended_at === 'number' || (typeof row.ended_at === 'string' && row.ended_at !== '')
    ? (Number(row.ended_at) || 0)
    : 0;
  const lastAudit = parseLastAuditJson(row.last_audit_json);
  return {
    serverId: String(row.server_id),
    serverName: serverMeta.name,
    serverOnline: serverMeta.online,
    projectName: String(row.project_name || ''),
    brainSession,
    brainLabel,
    taskId: String(row.task_id),
    title: String(row.title || ''),
    status,
    flags,
    round: Math.max(0, Number(row.round ?? 0) || 0),
    checklist: normalizeGlobalChecklist({
      total: Number(row.checklist_total ?? 0),
      implemented: Number(row.checklist_implemented ?? 0),
      audited: Number(row.checklist_audited ?? 0),
    }),
    ...(executorLabel ? { executorLabel } : {}),
    ...(auditorLabel ? { auditorLabel } : {}),
    ...(executorModel ? { executorModel } : {}),
    ...(auditorModel ? { auditorModel } : {}),
    ...(auditor ? { auditor } : {}),
    ...(cleanOptionalStr(row.live_summary) ? { liveSummary: cleanOptionalStr(row.live_summary) } : {}),
    ...(lastAudit ? { lastAudit } : {}),
    ...(startedAt > 0 ? { startedAt } : {}),
    ...(endedAt > 0 ? { endedAt } : {}),
    createdAt: Number(row.created_at ?? 0) || 0,
    updatedAt: Number(row.updated_at ?? 0) || 0,
    isTerminal: row.is_terminal === true || row.is_terminal === 1 || isGlobalTaskTerminalStatus(status),
    needsAttention: row.needs_attention === true || row.needs_attention === 1 || isGlobalTaskAttentionNeeded(status, flags),
  };
}

export async function emitGlobalTaskPgNotify(db: Database | null | undefined, payloadJson: string): Promise<void> {
  if (!db) return;
  try {
    await db.execute('SELECT pg_notify($1, $2)', [GLOBAL_TASK_NOTIFY_CHANNEL, payloadJson]);
  } catch {
    // Non-PostgreSQL or embedded test databases degrade cleanly to in-process dispatch.
  }
}

export async function resolveAuthorizedFullServersForUser(db: Database, userId: string): Promise<DbServer[]> {
  const servers = await getFullServersByUserId(db, userId);
  return servers.filter((server) => server.revoked_at == null && server.node_role !== NODE_ROLE.CONTROLLED);
}

export async function getServerMetaForGlobalTask(
  db: Database,
  serverId: string,
): Promise<{ id: string; name: string; online: boolean } | null> {
  const row = await db.queryOne<{ id: string; name: string; status: string; node_role?: string | null; revoked_at?: number | null }>(
    'SELECT id, name, status, node_role, revoked_at FROM servers WHERE id = $1',
    [serverId],
  );
  if (!row || row.revoked_at != null || row.node_role === NODE_ROLE.CONTROLLED) return null;
  return {
    id: row.id,
    name: row.name || row.id,
    online: row.status === 'online',
  };
}

export function hasGlobalTaskSummaryChanged(
  prev: GlobalTaskSummaryRow | null,
  next: GlobalTaskSummaryRow,
): boolean {
  if (!prev) return true;
  if (
    prev.status !== next.status
    || prev.round !== next.round
    || prev.title !== next.title
    || prev.projectName !== next.projectName
    || prev.brainSession !== next.brainSession
    || prev.brainLabel !== next.brainLabel
    || prev.liveSummary !== next.liveSummary
    || prev.executorLabel !== next.executorLabel
    || prev.auditorLabel !== next.auditorLabel
    || prev.executorModel !== next.executorModel
    || prev.auditorModel !== next.auditorModel
    || prev.auditor !== next.auditor
    || prev.isTerminal !== next.isTerminal
    || prev.needsAttention !== next.needsAttention
    || prev.startedAt !== next.startedAt
    || prev.endedAt !== next.endedAt
    || prev.updatedAt !== next.updatedAt
    || prev.checklist.total !== next.checklist.total
    || prev.checklist.implemented !== next.checklist.implemented
    || prev.checklist.audited !== next.checklist.audited
    || JSON.stringify(prev.lastAudit ?? null) !== JSON.stringify(next.lastAudit ?? null)
  ) {
    return true;
  }
  if (prev.flags.length !== next.flags.length) return true;
  for (let i = 0; i < prev.flags.length; i += 1) {
    if (prev.flags[i] !== next.flags[i]) return true;
  }
  return false;
}

export async function upsertGlobalTaskSummaryWithChange(
  db: Database,
  input: GlobalTaskSummaryUpsertInput,
): Promise<{ row: GlobalTaskSummaryRow | null; changed: boolean }> {
  const serverId = cleanStr(input.serverId);
  const taskId = cleanStr(input.taskId);
  const status = cleanStr(input.status);
  if (!serverId || !taskId || !status) return { row: null, changed: false };

  const prev = await getGlobalTaskSummaryForServerTask(db, serverId, taskId);

  const projectName = cleanStr(input.projectName);
  const brainSession = cleanStr(input.brainSession);
  const brainLabel = cleanStr(input.brainLabel);
  const title = cleanStr(input.title);
  const hasFlags = input.flags !== undefined;
  const cleanFlags = hasFlags
    ? [...new Set((input.flags ?? []).map((f) => cleanStr(f)).filter(Boolean))]
    : [];
  const flagsJson = hasFlags ? JSON.stringify(cleanFlags) : '';
  const round = Math.max(0, Math.floor(Number(input.round ?? 0) || 0));
  const checklist = normalizeGlobalChecklist(input.checklist);
  const hasChecklist = checklist.total > 0;
  const checklistTotal = hasChecklist ? checklist.total : 0;
  const checklistImplemented = hasChecklist ? checklist.implemented : 0;
  const checklistAudited = hasChecklist ? checklist.audited : 0;
  const executorLabel = cleanOptionalStr(input.executorLabel) ?? '';
  const auditorLabel = cleanOptionalStr(input.auditorLabel) ?? '';
  const auditor = cleanOptionalStr(input.auditor) ?? '';
  const executorModel = cleanModelOptional(input.executorModel) ?? '';
  const auditorModel = isNoAuditorSentinel(auditor) ? '' : (cleanModelOptional(input.auditorModel) ?? '');
  const liveSummary = cleanOptionalStr(input.liveSummary) ?? '';
  const normalizedLastAudit = input.lastAudit === undefined
    ? undefined
    : (input.lastAudit === null ? null : (normalizeGlobalTaskAuditSummary(input.lastAudit) ?? null));
  const lastAuditParam = normalizedLastAudit === undefined
    ? ''
    : (normalizedLastAudit === null ? '__NULL__' : JSON.stringify(normalizedLastAudit));
  const isTerminal = isGlobalTaskTerminalStatus(status);
  const statusNeedsAttention = isGlobalTaskAttentionNeeded(status, cleanFlags);
  const now = Date.now();
  const createdAt = Math.max(0, Math.floor(Number(input.createdAt ?? 0) || 0));
  const startedAt = typeof input.startedAt === 'number' && Number.isFinite(input.startedAt) && input.startedAt > 0
    ? Math.floor(input.startedAt)
    : 0;
  const endedAt = typeof input.endedAt === 'number' && Number.isFinite(input.endedAt) && input.endedAt > 0
    ? Math.floor(input.endedAt)
    : 0;
  const hasExplicitUpdatedAt = typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt) && input.updatedAt > 0;
  const updatedAt = hasExplicitUpdatedAt
    ? Math.floor(input.updatedAt as number)
    : (prev && prev.status === status && prev.updatedAt > 0 ? prev.updatedAt : now);

  if (
    isTerminal
    && (!prev || prev.isTerminal)
    && !isGlobalTaskWithinSyncWindow({ isTerminal: true, status, updatedAt }, now)
  ) {
    return { row: null, changed: false };
  }

  await db.execute(
    `INSERT INTO global_task_pair_summaries (
      server_id, task_id, project_name, brain_session, brain_label, title,
      status, flags_json, round,
      checklist_total, checklist_implemented, checklist_audited,
      executor_label, auditor_label, auditor, live_summary,
      is_terminal, needs_attention, created_at, updated_at, started_at, ended_at,
      executor_model, auditor_model, last_audit_json
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, CASE WHEN $8 = '' THEN '[]' ELSE $8 END, $9,
      $10, $11, $12,
      NULLIF($13, ''), NULLIF($14, ''), NULLIF($15, ''), NULLIF($16, ''),
      $17, $18, $19, $20, $21, $22,
      NULLIF($23, ''), NULLIF($24, ''),
      CASE WHEN $25 = '' OR $25 = '__NULL__' THEN NULL ELSE $25 END
    )
    ON CONFLICT (server_id, task_id) DO UPDATE SET
      project_name = CASE WHEN excluded.project_name <> '' THEN excluded.project_name ELSE global_task_pair_summaries.project_name END,
      brain_session = CASE WHEN excluded.brain_session <> '' THEN excluded.brain_session ELSE global_task_pair_summaries.brain_session END,
      brain_label = CASE WHEN excluded.brain_label <> '' THEN excluded.brain_label ELSE global_task_pair_summaries.brain_label END,
      title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE global_task_pair_summaries.title END,
      status = CASE WHEN excluded.updated_at >= global_task_pair_summaries.updated_at THEN excluded.status ELSE global_task_pair_summaries.status END,
      flags_json = CASE WHEN excluded.updated_at >= global_task_pair_summaries.updated_at AND $8 <> '' THEN excluded.flags_json ELSE global_task_pair_summaries.flags_json END,
      round = CASE WHEN excluded.updated_at >= global_task_pair_summaries.updated_at AND (excluded.round > 0 OR global_task_pair_summaries.round = 0) THEN excluded.round ELSE global_task_pair_summaries.round END,
      checklist_total = CASE WHEN excluded.updated_at >= global_task_pair_summaries.updated_at AND excluded.checklist_total > 0 THEN excluded.checklist_total ELSE global_task_pair_summaries.checklist_total END,
      checklist_implemented = CASE WHEN excluded.updated_at >= global_task_pair_summaries.updated_at AND excluded.checklist_total > 0 THEN excluded.checklist_implemented ELSE global_task_pair_summaries.checklist_implemented END,
      checklist_audited = CASE WHEN excluded.updated_at >= global_task_pair_summaries.updated_at AND excluded.checklist_total > 0 THEN excluded.checklist_audited ELSE global_task_pair_summaries.checklist_audited END,
      executor_label = COALESCE(excluded.executor_label, global_task_pair_summaries.executor_label),
      auditor_label = COALESCE(excluded.auditor_label, global_task_pair_summaries.auditor_label),
      auditor = COALESCE(excluded.auditor, global_task_pair_summaries.auditor),
      executor_model = COALESCE(excluded.executor_model, global_task_pair_summaries.executor_model),
      auditor_model = CASE
        WHEN excluded.auditor IN ('${TASK_PAIR_NO_AUDITOR}', '__none__') THEN NULL
        ELSE COALESCE(excluded.auditor_model, global_task_pair_summaries.auditor_model)
      END,
      live_summary = CASE WHEN excluded.updated_at >= global_task_pair_summaries.updated_at THEN COALESCE(excluded.live_summary, global_task_pair_summaries.live_summary) ELSE global_task_pair_summaries.live_summary END,
      last_audit_json = CASE
        WHEN excluded.updated_at < global_task_pair_summaries.updated_at THEN global_task_pair_summaries.last_audit_json
        WHEN $25 = '__NULL__' THEN NULL
        WHEN $25 <> '' THEN $25
        ELSE global_task_pair_summaries.last_audit_json
      END,
      is_terminal = CASE WHEN excluded.updated_at >= global_task_pair_summaries.updated_at THEN excluded.is_terminal ELSE global_task_pair_summaries.is_terminal END,
      needs_attention = CASE
        WHEN excluded.updated_at < global_task_pair_summaries.updated_at THEN global_task_pair_summaries.needs_attention
        WHEN $8 <> '' THEN excluded.needs_attention
        WHEN excluded.is_terminal THEN FALSE
        WHEN excluded.needs_attention THEN TRUE
        ELSE global_task_pair_summaries.needs_attention
      END,
      created_at = CASE
        WHEN global_task_pair_summaries.created_at > 0 AND excluded.created_at > 0
          THEN CASE WHEN excluded.created_at < global_task_pair_summaries.created_at THEN excluded.created_at ELSE global_task_pair_summaries.created_at END
        WHEN excluded.created_at > 0 THEN excluded.created_at
        ELSE global_task_pair_summaries.created_at
      END,
      updated_at = CASE
        WHEN excluded.updated_at > global_task_pair_summaries.updated_at THEN excluded.updated_at
        ELSE global_task_pair_summaries.updated_at
      END,
      started_at = COALESCE(global_task_pair_summaries.started_at, excluded.started_at),
      ended_at = CASE
        WHEN excluded.updated_at < global_task_pair_summaries.updated_at THEN global_task_pair_summaries.ended_at
        WHEN excluded.is_terminal THEN COALESCE(excluded.ended_at, global_task_pair_summaries.ended_at)
        ELSE NULL
      END`,
    [
      serverId,
      taskId,
      projectName,
      brainSession,
      brainLabel,
      title,
      status,
      flagsJson,
      round,
      checklistTotal,
      checklistImplemented,
      checklistAudited,
      executorLabel,
      auditorLabel,
      auditor,
      liveSummary,
      isTerminal,
      statusNeedsAttention,
      createdAt || updatedAt,
      updatedAt,
      startedAt > 0 ? startedAt : null,
      endedAt > 0 ? endedAt : null,
      executorModel,
      auditorModel,
      lastAuditParam,
    ],
  );

  const next = await getGlobalTaskSummaryForServerTask(db, serverId, taskId);
  if (!next) return { row: null, changed: false };
  return { row: next, changed: hasGlobalTaskSummaryChanged(prev, next) };
}

export async function upsertGlobalTaskSummary(
  db: Database,
  input: GlobalTaskSummaryUpsertInput,
): Promise<GlobalTaskSummaryRow | null> {
  const { row } = await upsertGlobalTaskSummaryWithChange(db, input);
  return row;
}

export async function upsertGlobalTaskSummariesBatchChanges(
  db: Database,
  serverId: string,
  rows: readonly GlobalTaskSummaryUpsertInput[],
): Promise<{ saved: GlobalTaskSummaryRow[]; changed: GlobalTaskSummaryRow[] }> {
  if (rows.length === 0) return { saved: [], changed: [] };
  const saved: GlobalTaskSummaryRow[] = [];
  const changed: GlobalTaskSummaryRow[] = [];
  for (const row of rows) {
    const res = await upsertGlobalTaskSummaryWithChange(db, { ...row, serverId });
    if (res.row) {
      saved.push(res.row);
      if (res.changed) changed.push(res.row);
    }
  }
  return { saved, changed };
}

export async function upsertGlobalTaskSummariesBatch(
  db: Database,
  serverId: string,
  rows: readonly GlobalTaskSummaryUpsertInput[],
): Promise<GlobalTaskSummaryRow[]> {
  const { saved } = await upsertGlobalTaskSummariesBatchChanges(db, serverId, rows);
  return saved;
}

export async function getGlobalTaskSummaryForServerTask(
  db: Database,
  serverId: string,
  taskId: string,
): Promise<GlobalTaskSummaryRow | null> {
  const row = await db.queryOne<RawSummaryRow>(
    'SELECT * FROM global_task_pair_summaries WHERE server_id = $1 AND task_id = $2',
    [serverId, taskId],
  );
  if (!row) return null;

  const serverMeta = await getServerMetaForGlobalTask(db, serverId);
  if (!serverMeta) return null;

  let brainLabelFallback: string | undefined;
  let brainProjectFallback: string | undefined;
  if (row.brain_session) {
    const sess = await db.queryOne<{ label: string | null; project_name: string | null }>(
      'SELECT label, project_name FROM sessions WHERE server_id = $1 AND name = $2',
      [serverId, row.brain_session],
    );
    if (sess) {
      brainLabelFallback = cleanOptionalStr(sess.label);
      brainProjectFallback = cleanOptionalStr(sess.project_name);
    }
  }

  return mapRawSummaryRow(row, serverMeta, brainLabelFallback, brainProjectFallback);
}

export async function listGlobalTaskSnapshotForUser(
  db: Database,
  userId: string,
  mutedServerIds?: readonly string[],
): Promise<GlobalTaskSnapshotResponse> {
  const authorizedServers = await resolveAuthorizedFullServersForUser(db, userId);
  const servers: GlobalTaskServerSummary[] = authorizedServers.map((s) => ({
    id: s.id,
    name: s.name || s.id,
    online: s.status === 'online',
  }));
  const serverMetaById = new Map(servers.map((s) => [s.id, { name: s.name, online: s.online }]));

  const mutedSet = new Set((mutedServerIds ?? []).map((id) => cleanStr(id)).filter(Boolean));
  const activeServerIds = servers.filter((s) => !mutedSet.has(s.id)).map((s) => s.id);
  const ts = Date.now();

  if (activeServerIds.length === 0) {
    return { tasks: [], brains: [], servers, stats: emptyGlobalTaskCompletionStats(), ts };
  }

  const serverPlaceholders = activeServerIds.map((_, idx) => `$${idx + 1}`).join(', ');
  const sessionRows = await db.query<Pick<DbSession, 'server_id' | 'name' | 'project_name' | 'label' | 'state' | 'agent_type'>>(
    `SELECT server_id, name, project_name, label, state, agent_type
       FROM sessions
      WHERE server_id IN (${serverPlaceholders})
      ORDER BY created_at ASC`,
    activeServerIds,
  );

  const liveSessionLabelByKey = new Map<string, string>();
  const liveSessionProjectByKey = new Map<string, string>();
  const brains: GlobalTaskBrainSummary[] = [];
  for (const sess of sessionRows) {
    if (!sess.name || sess.name.startsWith('deck_sub_')) continue;
    const meta = serverMetaById.get(sess.server_id);
    if (!meta) continue;
    const key = `${sess.server_id}\u0000${sess.name}`;
    const explicitLabel = cleanOptionalStr(sess.label);
    const projectFallback = cleanOptionalStr(sess.project_name);
    if (explicitLabel) liveSessionLabelByKey.set(key, explicitLabel);
    if (projectFallback) liveSessionProjectByKey.set(key, projectFallback);
    const label = pickReadableSessionDisplay([explicitLabel, projectFallback], sess.name)
      ?? fallbackReadableSessionDisplay(sess.name, { defaultLabel: 'Brain', workerLabel: 'Worker' });
    brains.push({
      serverId: sess.server_id,
      serverName: meta.name,
      serverOnline: meta.online,
      sessionName: sess.name,
      projectName: sess.project_name || '',
      label,
      state: sess.state || 'unknown',
      agentType: sess.agent_type || '',
    });
  }

  const activeTaskRows = await db.query<RawSummaryRow>(
    `SELECT * FROM global_task_pair_summaries
      WHERE server_id IN (${serverPlaceholders})
        AND is_terminal = FALSE
      ORDER BY updated_at DESC`,
    activeServerIds,
  );

  const recentTerminalRows = await db.query<RawSummaryRow>(
    `SELECT * FROM global_task_pair_summaries
      WHERE server_id IN (${serverPlaceholders})
        AND is_terminal = TRUE
        AND updated_at >= $${activeServerIds.length + 1}
      ORDER BY updated_at DESC
      LIMIT $${activeServerIds.length + 2}`,
    [...activeServerIds, ts - GLOBAL_TASK_TERMINAL_WINDOW_MS, GLOBAL_TASK_RECENT_FINISHED_LIMIT],
  );

  const statsRows = await db.query<Pick<RawSummaryRow, 'status' | 'started_at' | 'ended_at' | 'created_at' | 'updated_at'>>(
    `SELECT status, started_at, ended_at, created_at, updated_at
       FROM global_task_pair_summaries
      WHERE server_id IN (${serverPlaceholders})
        AND status = 'done'
        AND updated_at >= $${activeServerIds.length + 1}`,
    [...activeServerIds, ts - GLOBAL_TASK_STATS_MAX_WINDOW_MS],
  );
  const stats = computeGlobalTaskCompletionStats(
    statsRows.map((row) => ({
      status: String(row.status || ''),
      startedAt: Number(row.started_at ?? 0) || 0,
      endedAt: Number(row.ended_at ?? 0) || 0,
      createdAt: Number(row.created_at ?? 0) || 0,
      updatedAt: Number(row.updated_at ?? 0) || 0,
    })),
    ts,
  );

  const tasks: GlobalTaskSummaryRow[] = [];
  for (const row of [...activeTaskRows, ...recentTerminalRows]) {
    const meta = serverMetaById.get(row.server_id);
    if (!meta) continue;
    const brainKey = row.brain_session ? `${row.server_id}\u0000${row.brain_session}` : '';
    const brainFallback = brainKey ? liveSessionLabelByKey.get(brainKey) : undefined;
    const projectFallback = brainKey ? liveSessionProjectByKey.get(brainKey) : undefined;
    tasks.push(mapRawSummaryRow(row, meta, brainFallback, projectFallback));
  }

  return { tasks, brains, servers, stats, ts };
}
