import {
  SESSION_IDENTITY_SCOPES,
  renderSessionIdentityProfiles,
  sessionIdentityProjectKey,
  sessionIdentitySessionKey,
  type SessionIdentityProfile,
} from '../../shared/session-identity.js';
import { identityPromptHash } from '../util/identity-prompt-hash.js';
import { incrementCounter } from '../util/metrics.js';
import logger from '../util/logger.js';
import { listLocalSessionIdentityProfiles, putLocalSessionIdentityProfile } from './session-identity-local-store.js';

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
  /** This daemon's bound serverId (the SESSION-scope key is `<serverId>:<sessionName>`). */
  boundServerId?: () => Promise<string | undefined>;
}

async function defaultBoundServerId(): Promise<string | undefined> {
  try {
    const { loadCredentials } = await import('../bind/bind-flow.js');
    return (await loadCredentials())?.serverId;
  } catch {
    return undefined;
  }
}

export function profilesForSession(
  profiles: readonly SessionIdentityProfile[],
  session: IdentitySessionRef,
  serverId: string,
): SessionIdentityProfile[] {
  const sessionKey = sessionIdentitySessionKey(serverId, session.name);
  const projectKey = sessionIdentityProjectKey({
    contextNamespace: session.contextNamespace,
    project: session.projectName,
  });
  return profiles.filter((profile) => (
    (profile.scope === SESSION_IDENTITY_SCOPES.USER && profile.scopeKey === '')
    || (profile.scope === SESSION_IDENTITY_SCOPES.PROJECT && profile.scopeKey === projectKey)
    || (profile.scope === SESSION_IDENTITY_SCOPES.SESSION && profile.scopeKey === sessionKey)
  ));
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
  const profiles = await (deps.listProfiles ?? listLocalSessionIdentityProfiles)();
  const serverId = (await (deps.boundServerId ?? defaultBoundServerId)()) ?? '';
  const rendered = new Map<string, ResolvedIdentity>();
  const out = new Map<string, ResolvedIdentity>();
  for (const session of sessions) {
    const applicable = profilesForSession(profiles, session, serverId);
    // The same profiles at the same revisions render the same text.
    const shareKey = applicable.map((profile) => `${profile.scope}\0${profile.scopeKey}\0${profile.contentHash}`).join('\n');
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
