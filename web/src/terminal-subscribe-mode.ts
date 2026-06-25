import { getSessionRuntimeType } from '@shared/agent-types.js';

export type TerminalSubscribeViewMode = 'terminal' | 'chat';

export function shouldSubscribeTerminalRaw(activeSurface: boolean, viewMode: TerminalSubscribeViewMode): boolean {
  return activeSurface && viewMode === 'terminal';
}

type RuntimeAwareTarget = {
  runtimeType?: 'process' | 'transport' | null;
  agentType?: string | null;
  type?: string | null;
};

type NamedSessionTarget = RuntimeAwareTarget & {
  name: string;
};

type NamedSubSessionTarget = RuntimeAwareTarget & {
  id: string;
  sessionName: string;
};

export interface TerminalResubscribeItem {
  name: string;
  mode?: TerminalSubscribeViewMode;
}

type TransportNamedSessionTarget = RuntimeAwareTarget & {
  name: string;
};

type TransportNamedSubSessionTarget = RuntimeAwareTarget & {
  sessionName: string;
};

function resolveTargetRuntimeType(target: RuntimeAwareTarget): 'process' | 'transport' | undefined {
  if (target.runtimeType === 'process' || target.runtimeType === 'transport') {
    return target.runtimeType;
  }
  const agentType = target.agentType ?? target.type;
  return typeof agentType === 'string' && agentType.length > 0
    ? getSessionRuntimeType(agentType)
    : undefined;
}

function isTransportTarget(target: RuntimeAwareTarget): boolean {
  return resolveTargetRuntimeType(target) === 'transport';
}

function isShellLikeTarget(target: RuntimeAwareTarget): boolean {
  const agentType = target.agentType ?? target.type;
  return agentType === 'shell' || agentType === 'script';
}

function isPassiveTerminalTarget(target: RuntimeAwareTarget): boolean {
  return !isTransportTarget(target) && !isShellLikeTarget(target);
}

function isActiveTerminalTarget(target: RuntimeAwareTarget, mode: TerminalSubscribeViewMode | undefined): boolean {
  if (isTransportTarget(target)) return false;
  if (isShellLikeTarget(target)) return mode === 'terminal';
  return true;
}

export function listPassiveTerminalSubscriptionNames<T extends NamedSessionTarget>(targets: readonly T[]): string[] {
  return targets
    .filter(isPassiveTerminalTarget)
    .map((target) => target.name);
}

export function listPassiveTerminalSubSessionNames<T extends NamedSubSessionTarget>(targets: readonly T[]): string[] {
  return targets
    .filter(isPassiveTerminalTarget)
    .map((target) => target.sessionName);
}

export function listGlobalTransportSubscriptionNames<T extends TransportNamedSessionTarget>(targets: readonly T[]): string[] {
  return targets
    .filter(isTransportTarget)
    .map((target) => target.name);
}

export function listGlobalTransportSubSessionNames<T extends TransportNamedSubSessionTarget>(targets: readonly T[]): string[] {
  return targets
    .filter(isTransportTarget)
    .map((target) => target.sessionName);
}

export function buildTerminalResubscribePlan(params: {
  activeName?: string | null;
  activeMode?: TerminalSubscribeViewMode;
  focusedSubId?: string | null;
  sessions: readonly NamedSessionTarget[];
  subSessions: readonly NamedSubSessionTarget[];
}): TerminalResubscribeItem[] {
  const {
    activeName,
    activeMode,
    focusedSubId,
    sessions,
    subSessions,
  } = params;

  const activeSession = activeName ? sessions.find((session) => session.name === activeName) : undefined;
  const focusedSub = focusedSubId ? subSessions.find((sub) => sub.id === focusedSubId) : undefined;

  return [
    ...(activeName && activeSession && isActiveTerminalTarget(activeSession, activeMode)
      ? [{ name: activeName, mode: activeMode }]
      : []),
    ...(focusedSubId
      ? (() => {
          return focusedSub && isActiveTerminalTarget(focusedSub, 'chat')
            ? [{ name: focusedSub.sessionName, mode: 'chat' as const }]
            : [];
        })()
      : []),
    ...sessions
      .filter((session) => session.name !== activeName && isPassiveTerminalTarget(session))
      .map((session) => ({ name: session.name, mode: 'chat' as const })),
    ...subSessions
      .filter(isPassiveTerminalTarget)
      .map((sub) => ({ name: sub.sessionName, mode: 'chat' as const })),
  ];
}
