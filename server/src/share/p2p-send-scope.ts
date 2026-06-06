import type { ShareDenialReason, ShareTarget } from '../../../shared/tab-sharing.js';

export interface P2pSendTargets {
  hasP2pRouting: boolean;
  hasUnboundedExpansion: boolean;
  sessions: string[];
}

export function extractP2pSendTargets(msg: Record<string, unknown>): P2pSendTargets {
  const sessions = new Set<string>();
  let hasP2pRouting = false;
  let hasUnboundedExpansion = false;
  let requestedAllExpansion = false;

  const directTargetSession = typeof msg.directTargetSession === 'string' ? msg.directTargetSession.trim() : '';
  if (directTargetSession) {
    hasP2pRouting = true;
    if (directTargetSession === '__all__') requestedAllExpansion = true;
    else sessions.add(directTargetSession);
  }

  const atTargets = Array.isArray(msg.p2pAtTargets) ? msg.p2pAtTargets : [];
  for (const target of atTargets) {
    if (!target || typeof target !== 'object') continue;
    const session = (target as Record<string, unknown>).session;
    if (typeof session !== 'string' || !session.trim()) continue;
    hasP2pRouting = true;
    if (session.trim() === '__all__') requestedAllExpansion = true;
    else sessions.add(session.trim());
  }

  let configEnabledCount = 0;
  const config = msg.p2pSessionConfig && typeof msg.p2pSessionConfig === 'object' && !Array.isArray(msg.p2pSessionConfig)
    ? msg.p2pSessionConfig as Record<string, unknown>
    : null;
  if (config) {
    hasP2pRouting = true;
    for (const [sessionName, entry] of Object.entries(config)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (record.enabled === true && record.mode !== 'skip') {
        sessions.add(sessionName);
        configEnabledCount += 1;
      }
    }
  }

  if (typeof msg.p2pMode === 'string' && msg.p2pMode.trim()) {
    hasP2pRouting = true;
    if (sessions.size === 0) hasUnboundedExpansion = true;
  }
  if (requestedAllExpansion && configEnabledCount === 0) hasUnboundedExpansion = true;

  return { hasP2pRouting, hasUnboundedExpansion, sessions: [...sessions] };
}

export function evaluateP2pSendTargetScope(params: {
  msg: Record<string, unknown>;
  target: ShareTarget;
  coversSession: (sessionName: string) => boolean;
}): ShareDenialReason | null {
  const targets = extractP2pSendTargets(params.msg);
  if (!targets.hasP2pRouting) return null;
  if (params.target.kind === 'server') return null;
  if (targets.hasUnboundedExpansion) return 'share-direct-surface-denied';
  if (targets.sessions.some((name) => !params.coversSession(name))) {
    return 'share-direct-surface-denied';
  }
  return null;
}
