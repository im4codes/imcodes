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

export function listPassiveTerminalSubscriptionNames<T extends NamedSessionTarget>(targets: readonly T[]): string[] {
  return targets.map((target) => target.name);
}

export function listPassiveTerminalSubSessionNames<T extends NamedSubSessionTarget>(targets: readonly T[]): string[] {
  return targets.map((target) => target.sessionName);
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

  return [
    ...(activeName && sessions.some((session) => session.name === activeName)
      ? [{ name: activeName, mode: activeMode }]
      : []),
    ...(focusedSubId
      ? (() => {
          const focusedSub = subSessions.find((sub) => sub.id === focusedSubId);
          return focusedSub
            ? [{ name: focusedSub.sessionName, mode: 'chat' as const }]
            : [];
        })()
      : []),
    ...sessions
      .filter((session) => session.name !== activeName)
      .map((session) => ({ name: session.name, mode: 'chat' as const })),
    ...subSessions.map((sub) => ({ name: sub.sessionName, mode: 'chat' as const })),
  ];
}
