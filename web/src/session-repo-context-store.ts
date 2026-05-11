import { useEffect, useState } from 'preact/hooks';

export const PROJECT_REPO_CONTEXT_SESSION_ID = '*';

export interface SessionRepoInfo {
  provider?: string;
  owner?: string;
  repo?: string;
  remoteUrl?: string;
  defaultBranch?: string;
  currentBranch?: string;
}

export interface SessionRepoContextSnapshot {
  sessionId: string;
  projectDir: string;
  status?: string;
  info: SessionRepoInfo | null;
  currentBranch?: string;
  defaultBranch?: string;
  repoGeneration?: number;
  detectedAt?: number;
  updatedAt: number;
}

export interface IngestSessionRepoContextInput {
  sessionId?: string | null;
  projectDir: string;
  context: unknown;
}

type Listener = () => void;

const contextsByKey = new Map<string, SessionRepoContextSnapshot>();
const listenersByKey = new Map<string, Set<Listener>>();
const globalListeners = new Set<Listener>();

export function makeSessionRepoContextKey(sessionId: string | null | undefined, projectDir: string): string {
  const session = sessionId?.trim() || PROJECT_REPO_CONTEXT_SESSION_ID;
  return `${session}::${projectDir}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function normalizeSessionRepoContext(
  sessionId: string | null | undefined,
  projectDir: string,
  rawContext: unknown,
): SessionRepoContextSnapshot {
  const raw = asRecord(rawContext);
  const nested = asRecord(raw.context);
  const context = raw.context && Object.keys(nested).length > 0 ? nested : raw;
  const infoRaw = asRecord(context.info);
  const provider = optionalString(context.provider) ?? optionalString(infoRaw.platform);
  const owner = optionalString(context.owner) ?? optionalString(infoRaw.owner);
  const repo = optionalString(context.repo) ?? optionalString(infoRaw.repo);
  const remoteUrl = optionalString(context.remoteUrl) ?? optionalString(infoRaw.remoteUrl);
  const defaultBranch = optionalString(context.defaultBranch) ?? optionalString(infoRaw.defaultBranch);
  const currentBranch = optionalString(context.currentBranch) ?? optionalString(infoRaw.currentBranch);
  const info = context.info === null
    ? null
    : {
        ...(provider ? { provider } : {}),
        ...(owner ? { owner } : {}),
        ...(repo ? { repo } : {}),
        ...(remoteUrl ? { remoteUrl } : {}),
        ...(defaultBranch ? { defaultBranch } : {}),
        ...(currentBranch ? { currentBranch } : {}),
      };

  return {
    sessionId: sessionId?.trim() || PROJECT_REPO_CONTEXT_SESSION_ID,
    projectDir,
    status: optionalString(context.status),
    info: info && Object.keys(info).length > 0 ? info : null,
    ...(currentBranch ? { currentBranch } : {}),
    ...(defaultBranch ? { defaultBranch } : {}),
    ...(optionalNumber(context.repoGeneration) !== undefined ? { repoGeneration: optionalNumber(context.repoGeneration) } : {}),
    ...(optionalNumber(context.detectedAt) !== undefined ? { detectedAt: optionalNumber(context.detectedAt) } : {}),
    updatedAt: Date.now(),
  };
}

function isStale(existing: SessionRepoContextSnapshot | undefined, incoming: SessionRepoContextSnapshot): boolean {
  if (!existing) return false;
  if (existing.projectDir !== incoming.projectDir) return false;
  if (typeof existing.repoGeneration === 'number') {
    if (typeof incoming.repoGeneration !== 'number') return true;
    if (incoming.repoGeneration < existing.repoGeneration) return true;
    if (
      incoming.repoGeneration === existing.repoGeneration
      && typeof existing.detectedAt === 'number'
      && typeof incoming.detectedAt === 'number'
      && incoming.detectedAt < existing.detectedAt
    ) {
      return true;
    }
  }
  if (
    typeof existing.repoGeneration !== 'number'
    && typeof incoming.repoGeneration !== 'number'
    && typeof existing.detectedAt === 'number'
    && typeof incoming.detectedAt === 'number'
    && incoming.detectedAt < existing.detectedAt
  ) {
    return true;
  }
  return false;
}

function freshestContext(
  exact: SessionRepoContextSnapshot | undefined,
  project: SessionRepoContextSnapshot | undefined,
): SessionRepoContextSnapshot | null {
  if (!exact) return project ?? null;
  if (!project) return exact;
  if (isStale(exact, project)) return exact;
  if (isStale(project, exact)) return project;
  return exact;
}

function notify(key: string): void {
  for (const listener of listenersByKey.get(key) ?? []) listener();
  for (const listener of globalListeners) listener();
}

export function ingestSessionRepoContext(input: IngestSessionRepoContextInput): boolean {
  if (!input.projectDir.trim()) return false;
  const sessionId = input.sessionId?.trim() || PROJECT_REPO_CONTEXT_SESSION_ID;
  const incoming = normalizeSessionRepoContext(sessionId, input.projectDir, input.context);
  const key = makeSessionRepoContextKey(sessionId, input.projectDir);
  const projectKey = makeSessionRepoContextKey(PROJECT_REPO_CONTEXT_SESSION_ID, input.projectDir);
  const existing = contextsByKey.get(key);
  if (isStale(existing, incoming)) return false;
  if (sessionId !== PROJECT_REPO_CONTEXT_SESSION_ID) {
    const projectExisting = contextsByKey.get(projectKey);
    if (isStale(projectExisting, incoming)) return false;
  }
  contextsByKey.set(key, incoming);
  notify(key);

  if (sessionId !== PROJECT_REPO_CONTEXT_SESSION_ID) {
    const projectExisting = contextsByKey.get(projectKey);
    if (!isStale(projectExisting, { ...incoming, sessionId: PROJECT_REPO_CONTEXT_SESSION_ID })) {
      contextsByKey.set(projectKey, { ...incoming, sessionId: PROJECT_REPO_CONTEXT_SESSION_ID });
      notify(projectKey);
    }
  }

  return true;
}

export function getSessionRepoContext(
  sessionId: string | null | undefined,
  projectDir: string | null | undefined,
): SessionRepoContextSnapshot | null {
  if (!projectDir) return null;
  const exact = contextsByKey.get(makeSessionRepoContextKey(sessionId, projectDir));
  const project = contextsByKey.get(makeSessionRepoContextKey(PROJECT_REPO_CONTEXT_SESSION_ID, projectDir));
  return freshestContext(exact, project);
}

export function subscribeSessionRepoContext(
  sessionId: string | null | undefined,
  projectDir: string,
  listener: Listener,
): () => void {
  const keys = [
    makeSessionRepoContextKey(sessionId, projectDir),
    makeSessionRepoContextKey(PROJECT_REPO_CONTEXT_SESSION_ID, projectDir),
  ];
  for (const key of keys) {
    let listeners = listenersByKey.get(key);
    if (!listeners) {
      listeners = new Set();
      listenersByKey.set(key, listeners);
    }
    listeners.add(listener);
  }
  return () => {
    for (const key of keys) {
      const listeners = listenersByKey.get(key);
      if (!listeners) continue;
      listeners.delete(listener);
      if (listeners.size === 0) listenersByKey.delete(key);
    }
  };
}

export function subscribeAllSessionRepoContexts(listener: Listener): () => void {
  globalListeners.add(listener);
  return () => {
    globalListeners.delete(listener);
  };
}

export function useSessionRepoContext(
  sessionId: string | null | undefined,
  projectDir: string | null | undefined,
): SessionRepoContextSnapshot | null {
  const [snapshot, setSnapshot] = useState(() => getSessionRepoContext(sessionId, projectDir));

  useEffect(() => {
    if (!projectDir) {
      setSnapshot(null);
      return;
    }
    setSnapshot(getSessionRepoContext(sessionId, projectDir));
    return subscribeSessionRepoContext(sessionId, projectDir, () => {
      setSnapshot(getSessionRepoContext(sessionId, projectDir));
    });
  }, [sessionId, projectDir]);

  return snapshot;
}

export function __resetSessionRepoContextStoreForTests(): void {
  contextsByKey.clear();
  listenersByKey.clear();
  globalListeners.clear();
}
