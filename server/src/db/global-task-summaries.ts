import {
  GLOBAL_TASK_NOTIFY_CHANNEL,
  GLOBAL_TASK_RECENT_FINISHED_LIMIT,
  isGlobalTaskAttentionNeeded,
  isGlobalTaskTerminalStatus,
  normalizeGlobalChecklist,
  type GlobalTaskBrainSummary,
  type GlobalTaskChecklistProgress,
  type GlobalTaskServerSummary,
  type GlobalTaskSnapshotResponse,
  type GlobalTaskSummaryRow,
} from '../../../shared/global-task-mode.js';
import { NODE_ROLE } from '../../../shared/remote-exec.js';
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
  auditor?: string;
  liveSummary?: string;
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
  auditor: string | null;
  live_summary: string | null;
  is_terminal: boolean | number;
  needs_attention: boolean | number;
  created_at: number | string;
  updated_at: number | string;
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

function mapRawSummaryRow(
  row: RawSummaryRow,
  serverMeta: { name: string; online: boolean },
  brainLabelFallback?: string,
): GlobalTaskSummaryRow {
  const flags = parseFlagsJson(row.flags_json);
  const status = String(row.status || '');
  const brainSession = String(row.brain_session || '');
  const brainLabel = cleanStr(row.brain_label) || cleanStr(brainLabelFallback) || brainSession;
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
    ...(cleanOptionalStr(row.executor_label) ? { executorLabel: cleanOptionalStr(row.executor_label) } : {}),
    ...(cleanOptionalStr(row.auditor_label) ? { auditorLabel: cleanOptionalStr(row.auditor_label) } : {}),
    ...(cleanOptionalStr(row.auditor) ? { auditor: cleanOptionalStr(row.auditor) } : {}),
    ...(cleanOptionalStr(row.live_summary) ? { liveSummary: cleanOptionalStr(row.live_summary) } : {}),
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

export async function upsertGlobalTaskSummary(
  db: Database,
  input: GlobalTaskSummaryUpsertInput,
): Promise<GlobalTaskSummaryRow | null> {
  const serverId = cleanStr(input.serverId);
  const taskId = cleanStr(input.taskId);
  const status = cleanStr(input.status);
  if (!serverId || !taskId || !status) return null;

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
  const liveSummary = cleanOptionalStr(input.liveSummary) ?? '';
  const isTerminal = isGlobalTaskTerminalStatus(status);
  const statusNeedsAttention = isGlobalTaskAttentionNeeded(status, cleanFlags);
  const now = Date.now();
  const createdAt = Math.max(0, Math.floor(Number(input.createdAt ?? 0) || 0));
  const updatedAt = Math.max(0, Math.floor(Number(input.updatedAt ?? now) || now));

  await db.execute(
    `INSERT INTO global_task_pair_summaries (
      server_id, task_id, project_name, brain_session, brain_label, title,
      status, flags_json, round,
      checklist_total, checklist_implemented, checklist_audited,
      executor_label, auditor_label, auditor, live_summary,
      is_terminal, needs_attention, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, CASE WHEN $8 = '' THEN '[]' ELSE $8 END, $9,
      $10, $11, $12,
      NULLIF($13, ''), NULLIF($14, ''), NULLIF($15, ''), NULLIF($16, ''),
      $17, $18, $19, $20
    )
    ON CONFLICT (server_id, task_id) DO UPDATE SET
      project_name = CASE WHEN excluded.project_name <> '' THEN excluded.project_name ELSE global_task_pair_summaries.project_name END,
      brain_session = CASE WHEN excluded.brain_session <> '' THEN excluded.brain_session ELSE global_task_pair_summaries.brain_session END,
      brain_label = CASE WHEN excluded.brain_label <> '' THEN excluded.brain_label ELSE global_task_pair_summaries.brain_label END,
      title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE global_task_pair_summaries.title END,
      status = excluded.status,
      flags_json = CASE WHEN $8 <> '' THEN excluded.flags_json ELSE global_task_pair_summaries.flags_json END,
      round = CASE WHEN excluded.round > 0 OR global_task_pair_summaries.round = 0 THEN excluded.round ELSE global_task_pair_summaries.round END,
      checklist_total = CASE WHEN excluded.checklist_total > 0 THEN excluded.checklist_total ELSE global_task_pair_summaries.checklist_total END,
      checklist_implemented = CASE WHEN excluded.checklist_total > 0 THEN excluded.checklist_implemented ELSE global_task_pair_summaries.checklist_implemented END,
      checklist_audited = CASE WHEN excluded.checklist_total > 0 THEN excluded.checklist_audited ELSE global_task_pair_summaries.checklist_audited END,
      executor_label = COALESCE(excluded.executor_label, global_task_pair_summaries.executor_label),
      auditor_label = COALESCE(excluded.auditor_label, global_task_pair_summaries.auditor_label),
      auditor = COALESCE(excluded.auditor, global_task_pair_summaries.auditor),
      live_summary = COALESCE(excluded.live_summary, global_task_pair_summaries.live_summary),
      is_terminal = excluded.is_terminal,
      needs_attention = CASE
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
    ],
  );

  return getGlobalTaskSummaryForServerTask(db, serverId, taskId);
}

export async function upsertGlobalTaskSummariesBatch(
  db: Database,
  serverId: string,
  rows: readonly GlobalTaskSummaryUpsertInput[],
): Promise<GlobalTaskSummaryRow[]> {
  if (rows.length === 0) return [];
  const results: GlobalTaskSummaryRow[] = [];
  for (const row of rows) {
    const updated = await upsertGlobalTaskSummary(db, { ...row, serverId });
    if (updated) results.push(updated);
  }
  return results;
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
  if (row.brain_session) {
    const sess = await db.queryOne<{ label: string | null }>(
      'SELECT label FROM sessions WHERE server_id = $1 AND name = $2',
      [serverId, row.brain_session],
    );
    if (sess?.label) brainLabelFallback = sess.label;
  }

  return mapRawSummaryRow(row, serverMeta, brainLabelFallback);
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
    return { tasks: [], brains: [], servers, ts };
  }

  const serverPlaceholders = activeServerIds.map((_, idx) => `$${idx + 1}`).join(', ');
  const sessionRows = await db.query<Pick<DbSession, 'server_id' | 'name' | 'project_name' | 'label' | 'state' | 'agent_type'>>(
    `SELECT server_id, name, project_name, label, state, agent_type
       FROM sessions
      WHERE server_id IN (${serverPlaceholders})
      ORDER BY created_at ASC`,
    activeServerIds,
  );

  const brainLabelByKey = new Map<string, string>();
  const brains: GlobalTaskBrainSummary[] = [];
  for (const sess of sessionRows) {
    if (!sess.name || sess.name.startsWith('deck_sub_')) continue;
    const meta = serverMetaById.get(sess.server_id);
    if (!meta) continue;
    const label = cleanStr(sess.label) || sess.name;
    brainLabelByKey.set(`${sess.server_id}\u0000${sess.name}`, label);
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
      ORDER BY updated_at DESC
      LIMIT $${activeServerIds.length + 1}`,
    [...activeServerIds, GLOBAL_TASK_RECENT_FINISHED_LIMIT],
  );

  const tasks: GlobalTaskSummaryRow[] = [];
  for (const row of [...activeTaskRows, ...recentTerminalRows]) {
    const meta = serverMetaById.get(row.server_id);
    if (!meta) continue;
    const brainFallback = row.brain_session
      ? brainLabelByKey.get(`${row.server_id}\u0000${row.brain_session}`)
      : undefined;
    tasks.push(mapRawSummaryRow(row, meta, brainFallback));
  }

  return { tasks, brains, servers, ts };
}
