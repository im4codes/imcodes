import { describe, expect, it } from 'vitest';
import { buildDocumentTitle, getSessionTitleLabel } from '../src/tab-title.js';
import type { SessionInfo } from '../src/types.js';

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    name: 'deck_demo_brain',
    project: 'demo',
    role: 'brain',
    agentType: 'claude-code',
    state: 'idle',
    ...overrides,
  };
}

describe('tab title helpers', () => {
  it('falls back to app title when no server or session is selected', () => {
    expect(buildDocumentTitle(null, null)).toBe('IM.codes — The IM for agents');
  });

  it('shows the connected server when no active session exists', () => {
    expect(buildDocumentTitle('prod-server', null)).toBe('prod-server · IM.codes — The IM for agents');
  });

  it('prefers the session label for the active session title part', () => {
    expect(
      buildDocumentTitle('prod-server', makeSession({ label: 'Todo Main', project: 'todo' })),
    ).toBe('prod-server · Todo Main · IM.codes — The IM for agents');
  });

  it('falls back to project when the session has no label', () => {
    expect(getSessionTitleLabel(makeSession({ label: null, project: 'todo' }))).toBe('todo');
  });

  it('falls back to session name when label and project are missing', () => {
    expect(
      getSessionTitleLabel(makeSession({ label: null, project: '' })),
    ).toBe('deck_demo_brain');
  });
});
