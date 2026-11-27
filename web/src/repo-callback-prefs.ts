import {
  REPO_CALLBACK_PREF_KEYS,
  createDefaultRepoCallbackConfig,
  normalizeRepoCallbackGlobalPrefs,
  normalizeRepoCallbackLookbackWindow,
  normalizeRepoCallbackServerPrefs,
  repoCallbackServerPrefKey,
  resolveRepoCallbackSinceAtMsForSave,
  type RepoCallbackGlobalPrefs,
  type RepoCallbackRepoConfig,
  type RepoCallbackServerPrefs,
  type RepoCallbackTemplate,
} from '@shared/repo-callback.js';
import { getUserPref, saveUserPref } from './api.js';

export interface LoadedRepoCallbackPrefs {
  globalPrefs: RepoCallbackGlobalPrefs;
  serverPrefs: RepoCallbackServerPrefs;
  repoConfig: RepoCallbackRepoConfig;
  hasSavedConfig: boolean;
}

export function normalizeRepoCallbackProjectDir(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^\/+$/.test(trimmed)) return '/';
  if (/^[A-Za-z]:[\\/]+$/.test(trimmed)) {
    return `${trimmed[0]!.toUpperCase()}:/`;
  }
  if (/^[A-Za-z]:$/.test(trimmed)) return trimmed.toUpperCase();
  return trimmed.replace(/[\\/]+$/, '');
}

export function findRepoCallbackConfigKey(
  repos: Record<string, RepoCallbackRepoConfig>,
  projectDir: string,
): string | null {
  if (Object.prototype.hasOwnProperty.call(repos, projectDir)) return projectDir;
  const normalized = normalizeRepoCallbackProjectDir(projectDir);
  if (!normalized) return null;
  for (const key of Object.keys(repos)) {
    if (normalizeRepoCallbackProjectDir(key) === normalized) return key;
  }
  return null;
}

export function resolveFloatingRepoPanelScope(params: {
  repoPanelTarget: { sessionId?: string | null; projectDir?: string | null; parentSubId?: string | null } | null;
  activeSession: string | null | undefined;
  activeSessionProjectDir: string | null | undefined;
  isTabShare: boolean;
  sessionRootPath: string;
}): { sessionId: string | null; projectDir: string | undefined; parentSubId: string | null } {
  const parentSubId = params.repoPanelTarget?.parentSubId ?? null;
  const followActive = !parentSubId;
  const sessionId = followActive
    ? (params.activeSession ?? params.repoPanelTarget?.sessionId ?? null)
    : (params.repoPanelTarget?.sessionId ?? params.activeSession ?? null);
  const projectDir = params.isTabShare
    ? params.sessionRootPath
    : followActive
      ? (params.activeSessionProjectDir ?? params.repoPanelTarget?.projectDir ?? undefined)
      : (params.repoPanelTarget?.projectDir ?? params.activeSessionProjectDir ?? undefined);
  return { sessionId, projectDir, parentSubId };
}

export async function loadRepoCallbackPrefs(
  serverId: string | null | undefined,
  projectDir: string,
): Promise<LoadedRepoCallbackPrefs> {
  const [rawGlobal, rawServer] = await Promise.all([
    getUserPref(REPO_CALLBACK_PREF_KEYS.GLOBAL_TEMPLATES, { strict: true }),
    serverId ? getUserPref(repoCallbackServerPrefKey(serverId), { strict: true }) : Promise.resolve(null),
  ]);
  const globalPrefs = normalizeRepoCallbackGlobalPrefs(rawGlobal);
  const serverPrefs = normalizeRepoCallbackServerPrefs(rawServer);
  const matchedKey = findRepoCallbackConfigKey(serverPrefs.repos, projectDir);
  const hasSavedConfig = matchedKey !== null;
  const repoConfig = matchedKey ? serverPrefs.repos[matchedKey] : createDefaultRepoCallbackConfig(projectDir);
  return { globalPrefs, serverPrefs, repoConfig, hasSavedConfig };
}

export async function saveRepoCallbackGlobalTemplates(
  templates: RepoCallbackTemplate[],
): Promise<RepoCallbackGlobalPrefs> {
  const normalized = normalizeRepoCallbackGlobalPrefs({ version: 1, templates });
  await saveUserPref(REPO_CALLBACK_PREF_KEYS.GLOBAL_TEMPLATES, normalized);
  return normalized;
}

export async function saveRepoCallbackRepoConfig(
  serverId: string,
  config: RepoCallbackRepoConfig,
): Promise<RepoCallbackServerPrefs> {
  const existingRaw = await getUserPref(repoCallbackServerPrefKey(serverId), { strict: true });
  const current = normalizeRepoCallbackServerPrefs(existingRaw);
  const nowMs = Date.now();
  const existingKey = findRepoCallbackConfigKey(current.repos, config.projectDir);
  const targetKey = existingKey ?? config.projectDir;
  const prevConfig = existingKey ? current.repos[existingKey] : undefined;
  const nextDraft: RepoCallbackRepoConfig = {
    ...config,
    projectDir: targetKey,
    lookbackWindow: normalizeRepoCallbackLookbackWindow(config.lookbackWindow),
    updatedAt: nowMs,
  };
  const sinceAtMs = resolveRepoCallbackSinceAtMsForSave(prevConfig, nextDraft, nowMs);
  if (sinceAtMs === undefined) {
    delete nextDraft.sinceAtMs;
  } else {
    nextDraft.sinceAtMs = sinceAtMs;
  }
  const next = normalizeRepoCallbackServerPrefs({
    version: 1,
    repos: {
      ...current.repos,
      [targetKey]: nextDraft,
    },
  });
  await saveUserPref(repoCallbackServerPrefKey(serverId), next);
  return next;
}

export function buildRepoCallbackTargetOptions(
  projectDir: string | undefined,
  sessions?: Array<{ name: string; role?: string; label?: string | null; project?: string; state?: string; projectDir?: string }>,
  subSessions?: Array<{
    sessionName: string;
    type?: string;
    cwd?: string | null;
    label?: string | null;
    closedAt?: number | null;
    parentSession?: string | null;
    state?: string;
    executionCloneKind?: string | null;
    parentRunId?: string | null;
  }>,
): Array<{ sessionName: string; label: string; state?: string }> {
  const targetDir = normalizeRepoCallbackProjectDir(projectDir);
  if (!targetDir) return [];
  const projectSessionNames = new Set(
    (sessions ?? [])
      .filter((s) => normalizeRepoCallbackProjectDir(s.projectDir) === targetDir)
      .map((s) => s.name),
  );
  const brainOut: Array<{ sessionName: string; label: string; state?: string }> = [];
  const workerOut: Array<{ sessionName: string; label: string; state?: string }> = [];
  const subOut: Array<{ sessionName: string; label: string; state?: string }> = [];
  const seen = new Set<string>();

  for (const s of sessions ?? []) {
    if (normalizeRepoCallbackProjectDir(s.projectDir) !== targetDir || s.state === 'stopped') continue;
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    const option = {
      sessionName: s.name,
      label: s.label ? `${s.label} (${s.name})` : s.project ? `${s.project} (${s.name})` : s.name,
      state: s.state,
    };
    if (s.role === 'brain') {
      brainOut.push(option);
    } else {
      workerOut.push(option);
    }
  }

  for (const sub of subSessions ?? []) {
    if (sub.closedAt != null || sub.state === 'stopped') continue;
    if (sub.executionCloneKind || sub.parentRunId) continue;
    const belongs = normalizeRepoCallbackProjectDir(sub.cwd) === targetDir
      || (sub.parentSession ? projectSessionNames.has(sub.parentSession) : false);
    if (!belongs || seen.has(sub.sessionName)) continue;
    seen.add(sub.sessionName);
    subOut.push({
      sessionName: sub.sessionName,
      label: sub.label ? `${sub.label}${sub.type ? ` (${sub.type})` : ''}` : sub.sessionName,
      state: sub.state,
    });
  }

  return [...brainOut, ...workerOut, ...subOut];
}
