import { MAX_P2P_PARTICIPANTS, P2P_CONFIG_ERROR, type P2pConfigErrorType } from '../../shared/p2p-config-events.js';
import { P2P_CONFIG_MODE, type P2pSessionConfig } from '../../shared/p2p-modes.js';
import { getSession, listSessions } from '../store/session-store.js';
import { getSavedP2pConfig } from '../store/p2p-config-store.js';
import { getP2pConfigStoreScope } from './session-group-clone.js';
import type { ServerLink } from './server-link.js';
import type { P2pTarget } from './p2p-orchestrator.js';

export interface P2pTargetSelectionResult {
  ok: true;
  targets: P2pTarget[];
  sessionConfig?: P2pSessionConfig;
}

export interface P2pTargetSelectionFailure {
  ok: false;
  error: P2pConfigErrorType | 'no_sessions';
}

export type P2pTargetSelection = P2pTargetSelectionResult | P2pTargetSelectionFailure;

const NON_DISCUSSABLE_AGENT_TYPES = new Set(['shell', 'script']);

export function resolveP2pConfigScopeSession(sessionName: string): string {
  if (!sessionName.startsWith('deck_sub_')) return sessionName;
  const record = getSession(sessionName);
  return record?.parentSession ?? sessionName;
}

export async function resolveStructuredP2pSessionConfig(
  sessionName: string,
  serverLink: ServerLink,
  clientConfig?: P2pSessionConfig,
): Promise<P2pSessionConfig | undefined> {
  const scopeSession = resolveP2pConfigScopeSession(sessionName);
  const storeScope = getP2pConfigStoreScope(serverLink, scopeSession);
  const saved = await getSavedP2pConfig(storeScope);
  if (saved?.sessions && typeof saved.sessions === 'object') return saved.sessions;
  if (storeScope !== scopeSession) {
    const legacySaved = await getSavedP2pConfig(scopeSession);
    if (legacySaved?.sessions && typeof legacySaved.sessions === 'object') return legacySaved.sessions;
  }
  return clientConfig;
}

export function expandP2pTargets(
  initiatorName: string,
  mode: string,
  excludeSameType = false,
  sessionConfig?: P2pSessionConfig,
): P2pTarget[] {
  const initiator = getSession(initiatorName);
  const targets: P2pTarget[] = [];

  for (const session of listSessions()) {
    if (session.name === initiatorName) continue;
    if (session.state === 'stopped') continue;
    if (NON_DISCUSSABLE_AGENT_TYPES.has(session.agentType ?? '')) continue;
    if (excludeSameType && initiator?.agentType && session.agentType === initiator.agentType) continue;

    let inDomain = false;
    if (initiatorName.startsWith('deck_sub_')) {
      const isSibling = session.parentSession && session.parentSession === initiator?.parentSession;
      const isParent = session.name === initiator?.parentSession;
      inDomain = !!(isSibling || isParent);
    } else {
      const isChild = session.parentSession === initiatorName;
      const isSameProject = !session.name.startsWith('deck_sub_')
        && initiator?.projectName
        && session.projectName === initiator.projectName;
      inDomain = !!(isChild || isSameProject);
    }

    if (!inDomain) continue;

    if (sessionConfig) {
      const entry = sessionConfig[session.name];
      if (!entry || entry.enabled !== true || entry.mode === 'skip') continue;
      targets.push({ session: session.name, mode: mode === P2P_CONFIG_MODE ? entry.mode : mode });
    } else {
      targets.push({ session: session.name, mode });
    }
  }

  targets.sort((a, b) => a.session.localeCompare(b.session));
  return targets;
}

export async function resolveConfiguredP2pTargets(
  input: {
    initiatorSession: string;
    mode: string;
    serverLink: ServerLink;
    clientConfig?: P2pSessionConfig;
    excludeSameType?: boolean;
  },
): Promise<P2pTargetSelection> {
  const sessionConfig = await resolveStructuredP2pSessionConfig(
    input.initiatorSession,
    input.serverLink,
    input.clientConfig,
  );
  if (!sessionConfig || typeof sessionConfig !== 'object') {
    return { ok: false, error: P2P_CONFIG_ERROR.NO_SAVED_CONFIG };
  }

  const enabledNames = Object.entries(sessionConfig)
    .filter(([, entry]) => entry && entry.enabled === true && entry.mode !== 'skip')
    .map(([name]) => name);
  if (enabledNames.length === 0) {
    return { ok: false, error: P2P_CONFIG_ERROR.NO_ENABLED_PARTICIPANTS };
  }
  if (enabledNames.length > MAX_P2P_PARTICIPANTS) {
    return { ok: false, error: P2P_CONFIG_ERROR.TOO_MANY_PARTICIPANTS };
  }

  const targets = expandP2pTargets(
    input.initiatorSession,
    input.mode,
    !!input.excludeSameType,
    sessionConfig,
  );
  if (targets.length === 0) {
    const unfilteredTargets = expandP2pTargets(input.initiatorSession, input.mode, !!input.excludeSameType);
    return {
      ok: false,
      error: unfilteredTargets.length > 0 ? P2P_CONFIG_ERROR.NO_CONFIGURED_TARGETS : 'no_sessions',
    };
  }

  return { ok: true, targets, sessionConfig };
}
