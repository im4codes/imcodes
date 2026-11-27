import {
  SESSION_IDENTITY_SCOPES,
  SESSION_IDENTITY_SCOPE_LIST,
  renderSessionIdentityProfiles,
  sessionIdentityProjectKey,
  sessionIdentitySessionKey,
  type SessionIdentityProfile,
} from '../../shared/session-identity.js';
import { identityPromptHash } from '../util/identity-prompt-hash.js';
import { incrementCounter } from '../util/metrics.js';
import logger from '../util/logger.js';
import {
  getLocalSessionIdentityProfilesByKeys,
  listLocalSessionIdentityMetadata,
  putLocalSessionIdentityProfile,
  withLocalSessionIdentityReadSnapshot,
  type SessionIdentityProfileKey,
  type SessionIdentityProfileMeta,
} from './session-identity-local-store.js';

/**
 * The ONE place a session's effective identity prompt is derived.
 *
 * The prompt is not session state and is never stored with the session: it is the deterministic rendering of the
 * user / project / session identity profiles (the daemon-local identity store), computed when a session launches, is
 * restored or has its identity refreshed. Storing a copy only made the session database grow by 250-550 KB per
 * session, go stale the moment an identity was edited, and spread the text over rows, snapshots and exports.
 *
 * Importing this module must stay cheap and cycle-free (session-manager.ts imports it): the server-link credentials
 * are loaded lazily.
 */

/** What identifies a session's profiles: its name (SESSION scope), its project (PROJECT scope), the server it is bound to. */
export interface IdentitySessionRef {
  name: string;
  projectName?: string;
  contextNamespace?: { projectId?: unknown } | null;
  pairTaskId?: string;
}

export interface IdentityDriftSessionRef extends IdentitySessionRef {
  appliedIdentityHash?: string;
}

export interface ResolvedIdentity {
  /** The rendered contract, or undefined when no profile applies. */
  prompt: string | undefined;
  /** Digest of `prompt` (identityPromptHash); undefined with no prompt. This is all a session record keeps of it. */
  hash: string | undefined;
}

export interface IdentityPersistDeps {
  putProfile?: typeof putLocalSessionIdentityProfile;
  boundServerId?: () => Promise<string | undefined>;
}

export interface IdentityResolverDeps {
  listProfiles?: () => Promise<readonly SessionIdentityProfile[]>;
  listMetadata?: () => Promise<readonly SessionIdentityProfileMeta[]>;
  getProfilesByKeys?: (keys: readonly SessionIdentityProfileKey[]) => Promise<readonly SessionIdentityProfile[]>;
  /** This daemon's bound serverId (the SESSION-scope key is `<serverId>:<sessionName>`). */
  boundServerId?: () => Promise<string | undefined>;
  pairTaskIdForSession?: (sessionName: string) => string | undefined;
}

const SHARE_KEY_HASH_CACHE_MAX = 2048;
/** Bounded LRU cache mapping `shareKey` -> rendered `hash` ONLY (never caches large `content`/`prompt` strings). */
const shareKeyHashCache = new Map<string, string | undefined>();

function getCachedShareHash(shareKey: string): { hit: boolean; hash: string | undefined } {
  if (!shareKeyHashCache.has(shareKey)) return { hit: false, hash: undefined };
  const hash = shareKeyHashCache.get(shareKey);
  shareKeyHashCache.delete(shareKey);
  shareKeyHashCache.set(shareKey, hash);
  return { hit: true, hash };
}

function setCachedShareHash(shareKey: string, hash: string | undefined): void {
  if (shareKeyHashCache.has(shareKey)) {
    shareKeyHashCache.delete(shareKey);
  }
  shareKeyHashCache.set(shareKey, hash);
  while (shareKeyHashCache.size > SHARE_KEY_HASH_CACHE_MAX) {
    const oldest = shareKeyHashCache.keys().next().value;
    if (oldest === undefined) break;
    shareKeyHashCache.delete(oldest);
  }
}

export function resetSessionIdentityResolverCacheForTests(): void {
  shareKeyHashCache.clear();
}

export function identityResolverCacheStatsForTests(): { size: number; max: number } {
  return { size: shareKeyHashCache.size, max: SHARE_KEY_HASH_CACHE_MAX };
}

async function defaultBoundServerId(): Promise<string | undefined> {
  try {
    const { loadCredentials } = await import('../bind/bind-flow.js');
    return (await loadCredentials())?.serverId;
  } catch {
    return undefined;
  }
}

export async function defaultActivePairTaskIdForSession(sessionName: string): Promise<string | undefined> {
  try {
    const { getTaskPairStore } = await import('./task-pairs/store.js');
    const { taskPairFocusOf } = await import('./task-pairs/focus.js');
    const { TASK_PAIR_PARTICIPANT_STATUSES } = await import('../../shared/task-pair.js');
    const candidates: string[] = [];
    for (const stored of getTaskPairStore().pairsForSession(sessionName)) {
      const pair = stored.state;
      if (!TASK_PAIR_PARTICIPANT_STATUSES.includes(pair.status)) continue;
      const role = pair.executor === sessionName ? 'executor' : pair.auditor === sessionName ? 'auditor' : undefined;
      if (!role || pair.brain === sessionName) continue;
      candidates.push(pair.taskId);
    }
    if (candidates.length === 0) {
      const { getSession } = await import('../store/session-store.js');
      const session = getSession(sessionName);
      if (session?.pairCreatedMetadata?.pairTaskId) {
        return session.pairCreatedMetadata.pairTaskId;
      }
      return undefined;
    }
    const focus = taskPairFocusOf(sessionName);
    if (focus && candidates.includes(focus)) return focus;
    return candidates[0];
  } catch {
    return undefined;
  }
}

async function resolvePairTaskId(
  session: IdentitySessionRef,
  deps: IdentityResolverDeps,
): Promise<string | undefined> {
  if (session.pairTaskId) return session.pairTaskId;
  if (deps.pairTaskIdForSession) return deps.pairTaskIdForSession(session.name);
  return defaultActivePairTaskIdForSession(session.name);
}

export function profilesForSession<T extends SessionIdentityProfileMeta>(
  profiles: readonly T[],
  session: IdentitySessionRef,
  serverId: string,
  pairTaskId?: string,
): T[] {
  const sessionKey = sessionIdentitySessionKey(serverId, session.name);
  const projectKey = sessionIdentityProjectKey({
    contextNamespace: session.contextNamespace,
    project: session.projectName,
  });
  const effectivePairTaskId = (pairTaskId ?? session.pairTaskId)?.trim();
  return profiles.filter((profile) => (
    (profile.scope === SESSION_IDENTITY_SCOPES.USER && profile.scopeKey === '')
    || (profile.scope === SESSION_IDENTITY_SCOPES.PROJECT && profile.scopeKey === projectKey)
    || (profile.scope === SESSION_IDENTITY_SCOPES.PAIR && Boolean(effectivePairTaskId) && profile.scopeKey === effectivePairTaskId)
    || (profile.scope === SESSION_IDENTITY_SCOPES.SESSION && profile.scopeKey === sessionKey)
  ));
}

interface SessionWithResolvedKeys<T extends IdentitySessionRef> {
  session: T;
  pairTaskId?: string;
}

const MAX_SPLIT_CONSISTENCY_ATTEMPTS = 3;

async function resolveAllSessionKeys<T extends IdentitySessionRef>(
  sessions: readonly T[],
  deps: IdentityResolverDeps,
): Promise<{ serverId: string; entries: SessionWithResolvedKeys<T>[] }> {
  const serverId = (await (deps.boundServerId ?? defaultBoundServerId)()) ?? '';
  const entries: SessionWithResolvedKeys<T>[] = [];
  for (const session of sessions) {
    const pairTaskId = await resolvePairTaskId(session, deps);
    entries.push({ session, pairTaskId });
  }
  return { serverId, entries };
}

function shareKeyForProfiles(applicable: readonly SessionIdentityProfileMeta[]): string {
  const ordered = [...applicable].sort((a, b) => (
    (SESSION_IDENTITY_SCOPE_LIST.indexOf(a.scope) - SESSION_IDENTITY_SCOPE_LIST.indexOf(b.scope))
    || (a.scopeKey < b.scopeKey ? -1 : a.scopeKey > b.scopeKey ? 1 : 0)
  ));
  return ordered.map((profile) => `${profile.scope}\0${profile.scopeKey}\0${profile.contentHash}`).join('\n');
}

function profileMapKey(scope: SessionIdentityProfileMeta['scope'], scopeKey: string): string {
  return `${scope}\0${scopeKey}`;
}

function collectGroupKeys(groups: ReadonlyMap<string, SessionIdentityProfileMeta[]>): SessionIdentityProfileKey[] {
  const neededKeys: SessionIdentityProfileKey[] = [];
  const seenKeyIds = new Set<string>();
  for (const applicable of groups.values()) {
    for (const meta of applicable) {
      const id = profileMapKey(meta.scope, meta.scopeKey);
      if (seenKeyIds.has(id)) continue;
      seenKeyIds.add(id);
      neededKeys.push({ scope: meta.scope, scopeKey: meta.scopeKey });
    }
  }
  return neededKeys;
}

function assembleConsistentGroups(
  groups: ReadonlyMap<string, SessionIdentityProfileMeta[]>,
  fetched: readonly SessionIdentityProfile[],
): { rendered: Map<string, ResolvedIdentity>; inconsistentShareKeys: Set<string> } {
  const byKey = new Map<string, SessionIdentityProfile>();
  for (const profile of fetched) {
    byKey.set(profileMapKey(profile.scope, profile.scopeKey), profile);
  }
  const rendered = new Map<string, ResolvedIdentity>();
  const inconsistentShareKeys = new Set<string>();
  for (const [shareKey, applicable] of groups) {
    const resolvedProfiles: SessionIdentityProfile[] = [];
    let consistent = true;
    for (const meta of applicable) {
      const loaded = byKey.get(profileMapKey(meta.scope, meta.scopeKey));
      if (!loaded || loaded.contentHash !== meta.contentHash) {
        consistent = false;
        break;
      }
      resolvedProfiles.push(loaded);
    }
    if (!consistent) {
      // Never render partial/missing layers or populate cache from a torn snapshot.
      inconsistentShareKeys.add(shareKey);
      continue;
    }
    const prompt = renderSessionIdentityProfiles(resolvedProfiles);
    const resolved: ResolvedIdentity = { prompt, hash: identityPromptHash(prompt) };
    rendered.set(shareKey, resolved);
    setCachedShareHash(shareKey, resolved.hash);
  }
  return { rendered, inconsistentShareKeys };
}

function evaluateDriftPlan(
  entries: readonly SessionWithResolvedKeys<IdentityDriftSessionRef>[],
  metadata: readonly SessionIdentityProfileMeta[],
  serverId: string,
): {
  candidates: Array<{ session: IdentityDriftSessionRef; shareKey: string }>;
  groupsToLoad: Map<string, SessionIdentityProfileMeta[]>;
  emptyDrifted: Array<{ name: string; resolved: ResolvedIdentity }>;
} {
  const candidates: Array<{ session: IdentityDriftSessionRef; shareKey: string }> = [];
  const groupsToLoad = new Map<string, SessionIdentityProfileMeta[]>();
  const emptyDrifted: Array<{ name: string; resolved: ResolvedIdentity }> = [];

  for (const { session, pairTaskId } of entries) {
    const applicable = profilesForSession(metadata, session, serverId, pairTaskId);
    const shareKey = shareKeyForProfiles(applicable);
    const cached = getCachedShareHash(shareKey);
    if (cached.hit && session.appliedIdentityHash === cached.hash) {
      continue;
    }
    if (applicable.length === 0) {
      setCachedShareHash(shareKey, undefined);
      if (session.appliedIdentityHash !== undefined) {
        emptyDrifted.push({ name: session.name, resolved: { prompt: undefined, hash: undefined } });
      }
      continue;
    }
    candidates.push({ session, shareKey });
    if (!groupsToLoad.has(shareKey)) {
      groupsToLoad.set(shareKey, applicable);
    }
  }
  return { candidates, groupsToLoad, emptyDrifted };
}

function finalizeDriftedMap(
  emptyDrifted: ReadonlyArray<{ name: string; resolved: ResolvedIdentity }>,
  candidates: ReadonlyArray<{ session: IdentityDriftSessionRef; shareKey: string }>,
  rendered: ReadonlyMap<string, ResolvedIdentity>,
): Map<string, ResolvedIdentity> {
  const out = new Map<string, ResolvedIdentity>();
  for (const { name, resolved } of emptyDrifted) {
    out.set(name, resolved);
  }
  for (const { session, shareKey } of candidates) {
    const resolved = rendered.get(shareKey);
    if (resolved && session.appliedIdentityHash !== resolved.hash) {
      out.set(session.name, resolved);
    }
  }
  return out;
}

/**
 * Resolve the effective identity of many sessions in one pass. Sessions that share the same set of profiles (the
 * 117 sessions of one user contract) share one rendering. Throws when the identity store cannot be read: a caller that
 * would APPLY the result (the periodic sync) must not mistake an unreadable store for "no identity".
 */
export async function resolveEffectiveIdentities(
  sessions: readonly IdentitySessionRef[],
  deps: IdentityResolverDeps = {},
): Promise<Map<string, ResolvedIdentity>> {
  if (deps.listProfiles) {
    const [profiles, { serverId, entries }] = await Promise.all([
      deps.listProfiles(),
      resolveAllSessionKeys(sessions, deps),
    ]);
    const rendered = new Map<string, ResolvedIdentity>();
    const out = new Map<string, ResolvedIdentity>();
    for (const { session, pairTaskId } of entries) {
      const applicable = profilesForSession(profiles, session, serverId, pairTaskId);
      const shareKey = shareKeyForProfiles(applicable);
      let resolved = rendered.get(shareKey);
      if (!resolved) {
        const prompt = renderSessionIdentityProfiles(applicable);
        resolved = { prompt, hash: identityPromptHash(prompt) };
        rendered.set(shareKey, resolved);
      }
      out.set(session.name, resolved);
    }
    return out;
  }

  // Resolve all async server/pair keys BEFORE entering the SQLite read snapshot so
  // concurrent add+delete updates during async awaits never split the store read.
  const { serverId, entries } = await resolveAllSessionKeys(sessions, deps);

  const buildGroups = (metadata: readonly SessionIdentityProfileMeta[]) => {
    const groups = new Map<string, SessionIdentityProfileMeta[]>();
    const sessionShareKeys: Array<{ name: string; shareKey: string }> = [];
    for (const { session, pairTaskId } of entries) {
      const applicable = profilesForSession(metadata, session, serverId, pairTaskId);
      const shareKey = shareKeyForProfiles(applicable);
      sessionShareKeys.push({ name: session.name, shareKey });
      if (!groups.has(shareKey)) {
        groups.set(shareKey, applicable);
      }
    }
    return { groups, sessionShareKeys };
  };

  if (!deps.listMetadata && !deps.getProfilesByKeys) {
    return withLocalSessionIdentityReadSnapshot((reader) => {
      const { groups, sessionShareKeys } = buildGroups(reader.listMetadata());
      const keys = collectGroupKeys(groups);
      const fetched = keys.length > 0 ? reader.getProfilesByKeys(keys) : [];
      const { rendered, inconsistentShareKeys } = assembleConsistentGroups(groups, fetched);
      if (inconsistentShareKeys.size > 0) {
        throw new Error('identity_store_snapshot_inconsistent');
      }
      const out = new Map<string, ResolvedIdentity>();
      for (const { name, shareKey } of sessionShareKeys) {
        const resolved = rendered.get(shareKey);
        if (resolved) out.set(name, resolved);
      }
      return out;
    });
  }

  const listMetadataFn = deps.listMetadata ?? listLocalSessionIdentityMetadata;
  const getByKeysFn = deps.getProfilesByKeys ?? getLocalSessionIdentityProfilesByKeys;
  for (let attempt = 1; attempt <= MAX_SPLIT_CONSISTENCY_ATTEMPTS; attempt += 1) {
    const { groups, sessionShareKeys } = buildGroups(await listMetadataFn());
    const keys = collectGroupKeys(groups);
    const fetched = keys.length > 0 ? await getByKeysFn(keys) : [];
    const { rendered, inconsistentShareKeys } = assembleConsistentGroups(groups, fetched);
    if (inconsistentShareKeys.size === 0) {
      const out = new Map<string, ResolvedIdentity>();
      for (const { name, shareKey } of sessionShareKeys) {
        const resolved = rendered.get(shareKey);
        if (resolved) out.set(name, resolved);
      }
      return out;
    }
  }
  throw new Error('identity_store_snapshot_inconsistent');
}

/**
 * Metadata-first drift detection for periodic sync:
 * resolves server/pair keys first, then reads lightweight covering-index metadata
 * and any needed PK content inside one synchronous SQLite WAL read snapshot
 * (zero `await` inside), hitting `shareKey -> hash` cache in steady state with
 * zero content reads. Propagates store read errors (fail-closed).
 */
export async function resolveDriftedSessionIdentities(
  sessions: readonly IdentityDriftSessionRef[],
  deps: IdentityResolverDeps = {},
): Promise<Map<string, ResolvedIdentity>> {
  if (deps.listProfiles) {
    const [profiles, { serverId, entries }] = await Promise.all([
      deps.listProfiles(),
      resolveAllSessionKeys(sessions, deps),
    ]);
    const rendered = new Map<string, ResolvedIdentity>();
    const out = new Map<string, ResolvedIdentity>();
    for (const { session, pairTaskId } of entries) {
      const applicable = profilesForSession(profiles, session, serverId, pairTaskId);
      const shareKey = shareKeyForProfiles(applicable);
      let resolved = rendered.get(shareKey);
      if (!resolved) {
        const prompt = renderSessionIdentityProfiles(applicable);
        resolved = { prompt, hash: identityPromptHash(prompt) };
        rendered.set(shareKey, resolved);
      }
      if (session.appliedIdentityHash !== resolved.hash) {
        out.set(session.name, resolved);
      }
    }
    return out;
  }

  const { serverId, entries } = await resolveAllSessionKeys(sessions, deps);

  if (!deps.listMetadata && !deps.getProfilesByKeys) {
    return withLocalSessionIdentityReadSnapshot((reader) => {
      const { candidates, groupsToLoad, emptyDrifted } = evaluateDriftPlan(
        entries,
        reader.listMetadata(),
        serverId,
      );
      if (candidates.length === 0) {
        return finalizeDriftedMap(emptyDrifted, candidates, new Map());
      }
      const keys = collectGroupKeys(groupsToLoad);
      const fetched = keys.length > 0 ? reader.getProfilesByKeys(keys) : [];
      const { rendered } = assembleConsistentGroups(groupsToLoad, fetched);
      return finalizeDriftedMap(emptyDrifted, candidates, rendered);
    });
  }

  const listMetadataFn = deps.listMetadata ?? listLocalSessionIdentityMetadata;
  const getByKeysFn = deps.getProfilesByKeys ?? getLocalSessionIdentityProfilesByKeys;
  for (let attempt = 1; attempt <= MAX_SPLIT_CONSISTENCY_ATTEMPTS; attempt += 1) {
    const { candidates, groupsToLoad, emptyDrifted } = evaluateDriftPlan(
      entries,
      await listMetadataFn(),
      serverId,
    );
    if (candidates.length === 0) {
      return finalizeDriftedMap(emptyDrifted, candidates, new Map());
    }
    const keys = collectGroupKeys(groupsToLoad);
    const fetched = keys.length > 0 ? await getByKeysFn(keys) : [];
    const { rendered, inconsistentShareKeys } = assembleConsistentGroups(groupsToLoad, fetched);
    if (inconsistentShareKeys.size === 0 || attempt === MAX_SPLIT_CONSISTENCY_ATTEMPTS) {
      // If an injected split reader remains torn across all attempts, inconsistentShareKeys are
      // omitted from `rendered` so affected sessions keep their running `appliedIdentityHash`.
      return finalizeDriftedMap(emptyDrifted, candidates, rendered);
    }
  }
  return new Map();
}

/**
 * The effective identity prompt of one session, for a launch or restore. Never throws: a launch must not fail because
 * the identity store is unavailable. It then proceeds WITHOUT an identity (not with a stale copy), says so in the log
 * (names only, never content) and counts it; the periodic sync applies the identity as soon as the store is readable.
 */
export async function resolveEffectiveIdentityPrompt(
  session: IdentitySessionRef,
  deps: IdentityResolverDeps = {},
): Promise<string | undefined> {
  try {
    return (await resolveEffectiveIdentities([session], deps)).get(session.name)?.prompt;
  } catch (error) {
    incrementCounter('identity.resolve_failed');
    logger.warn(
      { session: session.name, reason: error instanceof Error ? error.name : 'unknown' },
      'Session identity could not be resolved; the session proceeds without an identity until the next identity sync',
    );
    return undefined;
  }
}

/**
 * An identity chosen when a session is CREATED (session.start: a selected file or inline text) is stored in the identity
 * store's SESSION scope -- where every later launch, restart, restore and identity sync derives it from -- never in the session
 * record. Without this the first prompt had it (it is handed to the launch) but a restart or the 60 s sync, which derive from
 * the store, would drop it. Best effort by design: a failure is logged (names only) and counted, the session still launches with the
 * identity it was created with, and the sync then applies what the store holds.
 */
export async function persistExplicitSessionIdentity(
  sessionName: string,
  content: string,
  deps: IdentityPersistDeps = {},
): Promise<boolean> {
  try {
    const serverId = (await (deps.boundServerId ?? defaultBoundServerId)()) ?? '';
    await (deps.putProfile ?? putLocalSessionIdentityProfile)({
      scope: SESSION_IDENTITY_SCOPES.SESSION,
      scopeKey: sessionIdentitySessionKey(serverId, sessionName),
      content,
      source: 'web',
    });
    return true;
  } catch (error) {
    incrementCounter('identity.persist_failed');
    logger.warn(
      { session: sessionName, reason: error instanceof Error ? error.name : 'unknown' },
      'The identity chosen at session start could not be saved to the identity store; it applies to this run only',
    );
    return false;
  }
}
