import { describe, expect, it, vi } from 'vitest';
import { dispatchSessionModelSwitch } from '../src/session-model-switch.js';

function commands() {
  return { sendMessage: vi.fn(), setSubSessionModel: vi.fn() };
}

describe('dispatchSessionModelSwitch', () => {
  it('uses the common runtime model command for transport sessions', () => {
    const api = commands();
    dispatchSessionModelSwitch(api, {
      sessionName: 'deck_project_brain', agentType: 'codex-sdk', model: 'gpt-5.6',
    });
    expect(api.sendMessage).toHaveBeenCalledWith('/model gpt-5.6');
    expect(api.setSubSessionModel).not.toHaveBeenCalled();
  });

  it('preserves the process Codex main-session effort suffix', () => {
    const api = commands();
    dispatchSessionModelSwitch(api, {
      sessionName: 'deck_project_brain', agentType: 'codex', model: 'gpt-5.6',
    });
    expect(api.sendMessage).toHaveBeenCalledWith('/model gpt-5.6 medium');
  });

  it('uses the structured command only for process Codex sub-sessions', () => {
    const api = commands();
    dispatchSessionModelSwitch(api, {
      sessionName: 'deck_sub_worker', agentType: 'codex', model: 'gpt-5.6',
      cwd: '/repo', subSession: true,
    });
    expect(api.setSubSessionModel).toHaveBeenCalledWith('deck_sub_worker', 'gpt-5.6', '/repo');
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it('fails closed for an empty model', () => {
    const api = commands();
    expect(() => dispatchSessionModelSwitch(api, {
      sessionName: 'deck_project_brain', agentType: 'qwen', model: '  ',
    })).toThrow('model_required');
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.setSubSessionModel).not.toHaveBeenCalled();
  });
});
