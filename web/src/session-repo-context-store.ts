import { useEffect, useState } from 'preact/hooks';
import { FS_SESSION_ROOT_PATH } from '../../src/shared/transport/fs.js';

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
  serverId?: string;
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
  serverId?: string | null;
  context: unknown;
}

type Listener = () => void;

const SESSION_REPO_CONTEXT_MAX_ENTRIES = 60;
const contextsByKey = new Map<string, SessionRepoContextSnapshot>();
const listenersByKey = new Map<string, Set<Listener>>();
const globalListeners = new Set<Listener>();

export function makeSessionRepoContextKey(
  sessionId: string | null | undefined,
  projectDir: string,
  serverId?: string | null,
): string {
  const session = sessionId?.trim() || PROJECT_REPO_CONTEXT_SESSION_ID;
  const server = serverId?.trim();
  return server ? `${server}::${session}::${projectDir}` : `${session}::${projectDir}`;
}

function setContextEntry(key: string, snapshot: SessionRepoContextSnapshot): void {
  contextsByKey.delete(key);
  contextsByKey.set(key, snapshot);
  while (contextsByKey.size > SESSION_REPO_CONTEXT_MAX_ENTRIES) {
    const oldestKey = contextsByKey.keys().next().value;
    if (oldestKey === undefined) break;
    contextsByKey.delete(oldestKey);
  }
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
  serverId?: string | null,
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
  const trimmedServerId = serverId?.trim() || undefined;
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
    ...(trimmedServerId ? { serverId: trimmedServerId } : {}),
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
  if ((existing.serverId ?? '') !== (incoming.serverId ?? '')) return false;
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
  const serverId = input.serverId?.trim() || undefined;
  const incoming = normalizeSessionRepoContext(sessionId, input.projectDir, input.context, serverId);
  const key = makeSessionRepoContextKey(sessionId, input.projectDir, serverId);
  const projectKey = makeSessionRepoContextKey(PROJECT_REPO_CONTEXT_SESSION_ID, input.projectDir, serverId);
  const existing = contextsByKey.get(key);
  if (isStale(existing, incoming)) return false;
  if (sessionId !== PROJECT_REPO_CONTEXT_SESSION_ID && input.projectDir !== FS_SESSION_ROOT_PATH) {
    const projectExisting = contextsByKey.get(projectKey);
    if (isStale(projectExisting, incoming)) return false;
  }
  setContextEntry(key, incoming);
  notify(key);

  if (sessionId !== PROJECT_REPO_CONTEXT_SESSION_ID) {
    if (input.projectDir !== FS_SESSION_ROOT_PATH) {
      const projectExisting = contextsByKey.get(projectKey);
      if (!isStale(projectExisting, { ...incoming, sessionId: PROJECT_REPO_CONTEXT_SESSION_ID })) {
        setContextEntry(projectKey, { ...incoming, sessionId: PROJECT_REPO_CONTEXT_SESSION_ID });
        notify(projectKey);
      }
      notify(makeSessionRepoContextKey(sessionId, FS_SESSION_ROOT_PATH, serverId));
    } else {
      const prefix = serverId ? `${serverId}::${sessionId}::` : `${sessionId}::`;
      for (const existingKey of contextsByKey.keys()) {
        if (existingKey.startsWith(prefix) && !existingKey.endsWith(`::${FS_SESSION_ROOT_PATH}`)) {
          notify(existingKey);
        }
      }
    }
  }

  return true;
}

export function getSessionRepoContext(
  sessionId: string | null | undefined,
  projectDir: string | null | undefined,
  serverId?: string | null,
): SessionRepoContextSnapshot | null {
  if (!projectDir) return null;
  const trimmedServer = serverId?.trim() || undefined;
  const exact = contextsByKey.get(makeSessionRepoContextKey(sessionId, projectDir, trimmedServer));
  const project = projectDir === FS_SESSION_ROOT_PATH
    ? undefined
    : contextsByKey.get(makeSessionRepoContextKey(PROJECT_REPO_CONTEXT_SESSION_ID, projectDir, trimmedServer));
  let best = freshestContext(exact, project);
  if (!best && sessionId && sessionId !== PROJECT_REPO_CONTEXT_SESSION_ID) {
    if (projectDir === FS_SESSION_ROOT_PATH) {
      const prefix = trimmedServer ? `${trimmedServer}::${sessionId}::` : `${sessionId}::`;
      for (const [key, ctx] of contextsByKey) {
        if (key.startsWith(prefix) && !key.endsWith(`::${FS_SESSION_ROOT_PATH}`)) {
          best = freshestContext(best ?? undefined, ctx);
        }
      }
    } else {
      const virtualContext = contextsByKey.get(makeSessionRepoContextKey(sessionId, FS_SESSION_ROOT_PATH, trimmedServer));
      best = virtualContext ?? null;
    }
  }
  return best;
}

export function subscribeSessionRepoContext(
  sessionId: string | null | undefined,
  projectDir: string,
  listener: Listener,
  serverId?: string | null,
): () => void {
  const keys = [
    makeSessionRepoContextKey(sessionId, projectDir, serverId),
    makeSessionRepoContextKey(PROJECT_REPO_CONTEXT_SESSION_ID, projectDir, serverId),
  ];
  if (sessionId && sessionId !== PROJECT_REPO_CONTEXT_SESSION_ID) {
    if (projectDir !== FS_SESSION_ROOT_PATH) {
      keys.push(makeSessionRepoContextKey(sessionId, FS_SESSION_ROOT_PATH, serverId));
    }
  }
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
  serverId?: string | null,
): SessionRepoContextSnapshot | null {
  const [snapshot, setSnapshot] = useState(() => getSessionRepoContext(sessionId, projectDir, serverId));

  useEffect(() => {
    if (!projectDir) {
      setSnapshot(null);
      return;
    }
    setSnapshot(getSessionRepoContext(sessionId, projectDir, serverId));
    return subscribeSessionRepoContext(sessionId, projectDir, () => {
      setSnapshot(getSessionRepoContext(sessionId, projectDir, serverId));
    }, serverId);
  }, [sessionId, projectDir, serverId]);

  return snapshot;
}

export function clearSessionRepoContexts(): void {
  contextsByKey.clear();
  for (const listeners of listenersByKey.values()) {
    for (const listener of listeners) listener();
  }
  for (const listener of globalListeners) listener();
}

export function __resetSessionRepoContextStoreForTests(): void {
  contextsByKey.clear();
  listenersByKey.clear();
  globalListeners.clear();
}
