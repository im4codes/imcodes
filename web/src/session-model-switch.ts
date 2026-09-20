import { getSessionRuntimeType } from '@shared/agent-types.js';
export interface SessionModelSwitchTarget {
  sessionName: string;
  agentType: string;
  model: string;
  cwd?: string | null;
  subSession?: boolean;
}

export interface SessionModelSwitchCommands {
  sendMessage: (text: string) => unknown;
  setSubSessionModel: (sessionName: string, model: string, cwd?: string) => unknown;
}

/**
 * Dispatch a model change through the same provider-native command path used
 * by the composer shortcut. Process Codex sub-sessions retain their structured
 * command because they do not own an independent composer transport.
 */
export function dispatchSessionModelSwitch(commands: SessionModelSwitchCommands, target: SessionModelSwitchTarget): void {
  const model = target.model.trim();
  if (!model) throw new Error('model_required');

  if (
    target.agentType === 'codex'
    && getSessionRuntimeType(target.agentType) === 'process'
    && target.subSession === true
  ) {
    commands.setSubSessionModel(target.sessionName, model, target.cwd ?? undefined);
    return;
  }

  const suffix = target.agentType === 'codex' ? ' medium' : '';
  commands.sendMessage(`/model ${model}${suffix}`);
}
