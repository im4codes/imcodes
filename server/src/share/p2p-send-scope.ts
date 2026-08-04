import type { ShareDenialReason, ShareTarget } from '../../../shared/tab-sharing.js';
import { collectP2pRoutedSessionNames } from '../../../shared/p2p-routing-fields.js';

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
  // Sweep every routing field for session names, not just the four this file
  // parses by hand. `p2pWorkflowLaunchEnvelope` nests its targets under
  // `participants[].sessionName`, so the hand-parsed set reported "no P2P
  // routing" and the send was allowed through unscoped. The sweep is driven by
  // the shared field list, so a new routing field is covered on both sides at
  // once instead of silently only on the daemon's.
  const sweptSessions = collectP2pRoutedSessionNames(params.msg);
  if (!targets.hasP2pRouting && sweptSessions.length === 0) return null;
  if (params.target.kind === 'server') return null;
  if (targets.hasUnboundedExpansion) return 'share-direct-surface-denied';
  const routed = new Set([...targets.sessions, ...sweptSessions]);
  for (const name of routed) {
    if (!params.coversSession(name)) return 'share-direct-surface-denied';
  }
  return null;
}
