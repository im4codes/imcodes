export const SESSION_COMPACT_COMMAND = '/compact' as const;
export const SESSION_CLEAR_COMMAND = '/clear' as const;
export const SESSION_STOP_COMMAND = '/stop' as const;
export const SESSION_CONTROL_METADATA_COMMAND_FIELD = 'controlCommand' as const;

export type SessionControlCommandId = 'compact' | 'clear' | 'stop';
export type SessionControlHandling = 'provider-dispatched' | 'daemon-managed';
export type SessionControlVisibility = 'visible' | 'hidden';

export interface SessionControlCommandDefinition {
  id: SessionControlCommandId;
  command: `/${string}`;
  handling: SessionControlHandling;
  timelineUserMessage: SessionControlVisibility;
  optimisticUserMessage: SessionControlVisibility;
  daemonHandledReceiptAck: boolean;
  resetsProcessPreferenceContext: boolean;
  resetsTransportPreferenceContextOnSend: boolean;
}

export const SESSION_CONTROL_COMMANDS = [
  {
    id: 'compact',
    command: SESSION_COMPACT_COMMAND,
    handling: 'provider-dispatched',
    timelineUserMessage: 'hidden',
    optimisticUserMessage: 'hidden',
    daemonHandledReceiptAck: false,
    resetsProcessPreferenceContext: true,
    resetsTransportPreferenceContextOnSend: true,
  },
  {
    id: 'clear',
    command: SESSION_CLEAR_COMMAND,
    handling: 'daemon-managed',
    timelineUserMessage: 'visible',
    optimisticUserMessage: 'visible',
    daemonHandledReceiptAck: true,
    resetsProcessPreferenceContext: true,
    resetsTransportPreferenceContextOnSend: false,
  },
  {
    id: 'stop',
    command: SESSION_STOP_COMMAND,
    handling: 'daemon-managed',
    timelineUserMessage: 'hidden',
    optimisticUserMessage: 'hidden',
    daemonHandledReceiptAck: true,
    resetsProcessPreferenceContext: false,
    resetsTransportPreferenceContextOnSend: false,
  },
] as const satisfies readonly SessionControlCommandDefinition[];

export type KnownSessionControlCommand = typeof SESSION_CONTROL_COMMANDS[number];

export function classifySessionControlCommand(text: string): KnownSessionControlCommand | null {
  const normalized = text.trim();
  return SESSION_CONTROL_COMMANDS.find((command) => command.command === normalized) ?? null;
}

export function isSessionControlCommandText(text: string, id: SessionControlCommandId): boolean {
  return classifySessionControlCommand(text)?.id === id;
}

export function isSessionCompactCommandText(text: string): boolean {
  return isSessionControlCommandText(text, 'compact');
}

export function isSessionClearCommandText(text: string): boolean {
  return isSessionControlCommandText(text, 'clear');
}

export function isDaemonHandledSessionControlSend(text: string): boolean {
  return classifySessionControlCommand(text)?.daemonHandledReceiptAck === true;
}

export function shouldHideTimelineUserMessageForSessionControl(text: string): boolean {
  return classifySessionControlCommand(text)?.timelineUserMessage === 'hidden';
}

export function shouldHideOptimisticUserMessageForSessionControl(text: string): boolean {
  return classifySessionControlCommand(text)?.optimisticUserMessage === 'hidden';
}

export function shouldResetProcessPreferenceContextForSessionControl(text: string): boolean {
  return classifySessionControlCommand(text)?.resetsProcessPreferenceContext === true;
}

export function shouldResetTransportPreferenceContextForSessionControl(text: string): boolean {
  return classifySessionControlCommand(text)?.resetsTransportPreferenceContextOnSend === true;
}
