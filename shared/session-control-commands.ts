export const SESSION_COMPACT_COMMAND = '/compact' as const;
export const SESSION_CLEAR_COMMAND = '/clear' as const;
export const SESSION_STOP_COMMAND = '/stop' as const;
export const SESSION_MODEL_COMMAND = '/model' as const;
export const SESSION_CONTROL_METADATA_COMMAND_FIELD = 'controlCommand' as const;
export const SESSION_CONTROL_TIMELINE_STATE_COMPACTING = 'compacting' as const;
export const SESSION_CONTROL_TIMELINE_REASON_USER_COMPACT = 'user_compact' as const;
export const SESSION_CONTROL_TIMELINE_STATE_STOPPING = 'stopping' as const;
export const SESSION_CONTROL_TIMELINE_REASON_USER_CANCEL = 'user_cancel' as const;

export type SessionControlCommandId = 'compact' | 'clear' | 'stop';
export type SessionControlHandling = 'provider-dispatched' | 'daemon-managed';
export type SessionControlVisibility = 'visible' | 'hidden';
export type SessionControlTimelineFeedback =
  | {
      state: typeof SESSION_CONTROL_TIMELINE_STATE_COMPACTING;
      reason: typeof SESSION_CONTROL_TIMELINE_REASON_USER_COMPACT;
    }
  | {
      state: typeof SESSION_CONTROL_TIMELINE_STATE_STOPPING;
      reason: typeof SESSION_CONTROL_TIMELINE_REASON_USER_CANCEL;
    }
  | null;

export interface SessionControlCommandDefinition {
  id: SessionControlCommandId;
  command: `/${string}`;
  handling: SessionControlHandling;
  timelineUserMessage: SessionControlVisibility;
  optimisticUserMessage: SessionControlVisibility;
  timelineFeedback: SessionControlTimelineFeedback;
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
    timelineFeedback: {
      state: SESSION_CONTROL_TIMELINE_STATE_COMPACTING,
      reason: SESSION_CONTROL_TIMELINE_REASON_USER_COMPACT,
    },
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
    timelineFeedback: null,
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
    timelineFeedback: {
      state: SESSION_CONTROL_TIMELINE_STATE_STOPPING,
      reason: SESSION_CONTROL_TIMELINE_REASON_USER_CANCEL,
    },
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

/** Match a complete model-switch command while leaving ordinary prose untouched. */
export function isSessionModelSwitchCommandText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized.startsWith(SESSION_MODEL_COMMAND)) return false;
  const argumentsText = normalized.slice(SESSION_MODEL_COMMAND.length);
  return /^\s+\S+(?:\s+.*)?$/.test(argumentsText);
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

export function getSessionControlTimelineFeedbackById(
  id: SessionControlCommandId,
): SessionControlTimelineFeedback {
  return SESSION_CONTROL_COMMANDS.find((command) => command.id === id)?.timelineFeedback ?? null;
}

export function getSessionControlTimelineFeedback(text: string): SessionControlTimelineFeedback {
  return classifySessionControlCommand(text)?.timelineFeedback ?? null;
}

export function shouldResetProcessPreferenceContextForSessionControl(text: string): boolean {
  return classifySessionControlCommand(text)?.resetsProcessPreferenceContext === true;
}

export function shouldResetTransportPreferenceContextForSessionControl(text: string): boolean {
  return classifySessionControlCommand(text)?.resetsTransportPreferenceContextOnSend === true;
}
