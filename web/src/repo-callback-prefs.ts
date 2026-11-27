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

function normalizeRepoCallbackProjectDir(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '/') return trimmed;
  if (/^[A-Za-z]:[\\/]+$/.test(trimmed)) return trimmed.slice(0, 3);
  if (/^[A-Za-z]:$/.test(trimmed)) return trimmed;
  return trimmed.replace(/[\\/]+$/, '');
}

export async function loadRepoCallbackPrefs(
  serverId: string | null | undefined,
  projectDir: string,
): Promise<LoadedRepoCallbackPrefs> {
  const [rawGlobal, rawServer] = await Promise.all([
    getUserPref(REPO_CALLBACK_PREF_KEYS.GLOBAL_TEMPLATES),
    serverId ? getUserPref(repoCallbackServerPrefKey(serverId)) : Promise.resolve(null),
  ]);
  const globalPrefs = normalizeRepoCallbackGlobalPrefs(rawGlobal);
  const serverPrefs = normalizeRepoCallbackServerPrefs(rawServer);
  const hasSavedConfig = Object.prototype.hasOwnProperty.call(serverPrefs.repos, projectDir);
  const repoConfig = serverPrefs.repos[projectDir] ?? createDefaultRepoCallbackConfig(projectDir);
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
  const existingRaw = await getUserPref(repoCallbackServerPrefKey(serverId));
  const current = normalizeRepoCallbackServerPrefs(existingRaw);
  const nowMs = Date.now();
  const prevConfig = current.repos[config.projectDir];
  const nextDraft: RepoCallbackRepoConfig = {
    ...config,
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
      [config.projectDir]: nextDraft,
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
