export type TerminalSubscribeViewMode = 'terminal' | 'chat';

export function shouldSubscribeTerminalRaw(activeSurface: boolean, viewMode: TerminalSubscribeViewMode): boolean {
  return activeSurface && viewMode === 'terminal';
}

type NamedSessionTarget = {
  name: string;
  runtimeType?: 'process' | 'transport' | null;
};

type NamedSubSessionTarget = {
  id: string;
  sessionName: string;
  runtimeType?: 'process' | 'transport' | null;
};

export interface TerminalResubscribeItem {
  name: string;
  mode?: TerminalSubscribeViewMode;
}

export function listPassiveTerminalSubscriptionNames<T extends NamedSessionTarget>(targets: readonly T[]): string[] {
  return targets.map((target) => target.name);
}

export function listPassiveTerminalSubSessionNames<T extends NamedSubSessionTarget>(targets: readonly T[]): string[] {
  return targets.map((target) => target.sessionName);
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
