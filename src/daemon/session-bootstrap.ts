import type { SessionRecord } from '../store/session-store.js';

export interface WorkerSessionSnapshot {
  name: string;
  project_name: string;
  role: string;
  agent_type: string;
  project_dir: string;
  state: string;
  label?: string | null;
  requested_model?: string | null;
  active_model?: string | null;
  effort?: SessionRecord['effort'] | null;
  transport_config?: Record<string, unknown> | string | null;
}

export interface WorkerSessionPersistBody {
  projectName: string;
  projectRole: string;
  agentType: string;
  agentVersion: string | null;
  projectDir: string;
  state: string;
  label: string | null;
  runtimeType: string | null;
  providerId: string | null;
  providerSessionId: string | null;
  description: string | null;
  requestedModel: string | null;
  activeModel: string | null;
  effort: SessionRecord['effort'] | null;
  transportConfig: Record<string, unknown> | null;
}

export function buildWorkerSessionPersistBody(record: SessionRecord): WorkerSessionPersistBody {
  return {
    projectName: record.projectName,
    projectRole: record.role,
    agentType: record.agentType,
    agentVersion: record.agentVersion ?? null,
    projectDir: record.projectDir,
    state: record.state,
    label: record.label ?? null,
    runtimeType: record.runtimeType ?? null,
    providerId: record.providerId ?? null,
    providerSessionId: record.providerSessionId ?? null,
    description: record.description ?? null,
    requestedModel: record.requestedModel ?? null,
    activeModel: record.activeModel ?? record.modelDisplay ?? null,
    effort: record.effort ?? null,
    transportConfig: record.transportConfig ?? null,
  };
}

export function mergeWorkerSessionSnapshot(
  existing: SessionRecord | undefined,
  snapshot: WorkerSessionSnapshot,
): SessionRecord {
  return {
    ...(existing ?? {}),
    name: snapshot.name,
    projectName: snapshot.project_name,
    role: snapshot.role as 'brain' | `w${number}`,
    agentType: snapshot.agent_type,
    projectDir: snapshot.project_dir,
    state: snapshot.state as SessionRecord['state'],
    label: snapshot.label ?? undefined,
    requestedModel: snapshot.requested_model ?? existing?.requestedModel,
    activeModel: snapshot.active_model ?? existing?.activeModel,
    modelDisplay: snapshot.active_model ?? existing?.modelDisplay,
    effort: snapshot.effort ?? existing?.effort,
    transportConfig: (typeof snapshot.transport_config === 'string'
      ? JSON.parse(snapshot.transport_config)
      : (snapshot.transport_config ?? existing?.transportConfig)) as Record<string, unknown> | undefined,
    restarts: existing?.restarts ?? 0,
    restartTimestamps: existing?.restartTimestamps ?? [],
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
}
