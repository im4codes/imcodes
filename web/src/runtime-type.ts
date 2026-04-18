import { getSessionRuntimeType } from '@shared/agent-types.js';
import type { SessionInfo } from './types.js';
import type { SubSession } from './hooks/useSubSessions.js';

type RuntimeTypedAgent = {
  agentType?: string | null;
  type?: string | null;
  runtimeType?: SessionInfo['runtimeType'] | null;
};

export function resolveRuntimeType(target: RuntimeTypedAgent): SessionInfo['runtimeType'] {
  if (target.runtimeType === 'transport' || target.runtimeType === 'process') {
    return target.runtimeType;
  }
  const agentType = target.agentType ?? target.type;
  return typeof agentType === 'string' && agentType.length > 0
    ? getSessionRuntimeType(agentType)
    : undefined;
}

export function isTransportRuntime(target: RuntimeTypedAgent): boolean {
  return resolveRuntimeType(target) === 'transport';
}

export function resolveSessionInfoRuntimeType(session: Pick<SessionInfo, 'agentType' | 'runtimeType'>): SessionInfo['runtimeType'] {
  return resolveRuntimeType(session);
}

export function resolveSubSessionRuntimeType(sub: Pick<SubSession, 'type' | 'runtimeType'>): SessionInfo['runtimeType'] {
  return resolveRuntimeType(sub);
}
