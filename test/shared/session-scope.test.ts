import { describe, expect, it } from 'vitest';
import { isValidImcodesSessionName, resolveEffectiveProjectName, resolveRuntimeScope } from '../../shared/session-scope.js';

describe('session scope helpers', () => {
  it('uses a parent main session project for sub-session effective scope', () => {
    const sessions = [
      { name: 'deck_alpha_brain', projectName: 'alpha', projectDir: '/work/alpha' },
      { name: 'deck_sub_worker', projectName: 'deck_sub_worker', projectDir: '/work/alpha', parentSession: 'deck_alpha_brain' },
    ];

    expect(resolveEffectiveProjectName(sessions[1], sessions)).toBe('alpha');
    expect(resolveRuntimeScope({
      sessionName: 'deck_sub_worker',
      projectName: 'deck_sub_worker',
      projectRoot: '/wrong',
      serverId: 'srv-1',
    }, sessions)).toEqual({
      sessionName: 'deck_sub_worker',
      projectName: 'alpha',
      projectRoot: '/work/alpha',
      serverId: 'srv-1',
    });
  });

  it('validates managed IM.codes session names used in MCP identity', () => {
    expect(isValidImcodesSessionName('deck_alpha_brain')).toBe(true);
    expect(isValidImcodesSessionName('deck_alpha_w12')).toBe(true);
    expect(isValidImcodesSessionName('deck_sub_worker-1')).toBe(true);
    expect(isValidImcodesSessionName('deck_sub_$(whoami)')).toBe(false);
    expect(isValidImcodesSessionName('friendly label')).toBe(false);
  });
});
