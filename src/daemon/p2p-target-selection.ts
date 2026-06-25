import { MAX_P2P_PARTICIPANTS, P2P_CONFIG_ERROR, type P2pConfigErrorType } from '../../shared/p2p-config-events.js';
import {
  getEnabledP2pMemberNames,
  isP2pMemberEligibleSession,
  P2P_CONFIG_MODE,
  sanitizeP2pSavedConfig,
  sanitizeP2pSessionConfig,
  type P2pSavedConfig,
  type P2pSessionConfig,
} from '../../shared/p2p-modes.js';
import { getSession, listSessions } from '../store/session-store.js';
import { getSavedP2pConfig } from '../store/p2p-config-store.js';
import { getP2pConfigStoreScope } from './session-group-clone.js';
import type { ServerLink } from './server-link.js';
import type { P2pTarget } from './p2p-orchestrator.js';

export interface P2pTargetSelectionResult {
  ok: true;
  targets: P2pTarget[];
  sessionConfig?: P2pSessionConfig;
  savedConfig?: P2pSavedConfig;
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

export async function resolveSavedP2pConfig(
  sessionName: string,
  serverLink: ServerLink,
): Promise<P2pSavedConfig | undefined> {
  const scopeSession = resolveP2pConfigScopeSession(sessionName);
  const storeScope = getP2pConfigStoreScope(serverLink, scopeSession);
  const saved = await getSavedP2pConfig(storeScope);
  if (saved?.sessions && typeof saved.sessions === 'object') {
    return sanitizeP2pSavedConfig(saved, { scopeSession });
  }
  if (storeScope !== scopeSession) {
    const legacySaved = await getSavedP2pConfig(scopeSession);
    if (legacySaved?.sessions && typeof legacySaved.sessions === 'object') {
      return sanitizeP2pSavedConfig(legacySaved, { scopeSession });
    }
  }
  return undefined;
}

export async function resolveStructuredP2pSessionConfig(
  sessionName: string,
  serverLink: ServerLink,
  clientConfig?: P2pSessionConfig,
): Promise<P2pSessionConfig | undefined> {
  const saved = await resolveSavedP2pConfig(sessionName, serverLink);
  if (saved?.sessions && typeof saved.sessions === 'object') return saved.sessions;
  if (!clientConfig) return undefined;
  return sanitizeP2pSessionConfig(clientConfig, { scopeSession: resolveP2pConfigScopeSession(sessionName) });
}

export function expandP2pTargets(
  initiatorName: string,
  mode: string,
  excludeSameType = false,
  sessionConfig?: P2pSessionConfig,
): P2pTarget[] {
  const initiator = getSession(initiatorName);
  const scopeSession = resolveP2pConfigScopeSession(initiatorName);
  const targets: P2pTarget[] = [];

  for (const session of listSessions()) {
    if (session.name === initiatorName) continue;
    if (session.state === 'stopped') continue;
    if (NON_DISCUSSABLE_AGENT_TYPES.has(session.agentType ?? '')) continue;
    if (!isP2pMemberEligibleSession(session.name, { scopeSession, role: session.role })) continue;
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
  const savedConfig = await resolveSavedP2pConfig(
    input.initiatorSession,
    input.serverLink,
  );
  const scopeSession = resolveP2pConfigScopeSession(input.initiatorSession);
  const sessionConfig = savedConfig?.sessions ?? (input.clientConfig
    ? sanitizeP2pSessionConfig(input.clientConfig, { scopeSession })
    : undefined);
  if (!sessionConfig || typeof sessionConfig !== 'object') {
    return { ok: false, error: P2P_CONFIG_ERROR.NO_SAVED_CONFIG };
  }

  const enabledNames = getEnabledP2pMemberNames(sessionConfig, { scopeSession });
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

  return { ok: true, targets, sessionConfig, savedConfig };
}
