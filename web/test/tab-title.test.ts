import { describe, expect, it } from 'vitest';
import { APP_TITLE, buildDocumentTitle, getSessionTitleLabel } from '../src/tab-title.js';
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
    expect(buildDocumentTitle(null, null)).toBe('IM.codes — AI Force Workbench · Your Dedicated AI Squad');
  });

  it('shows the connected server when no active session exists', () => {
    expect(buildDocumentTitle('prod-server', null)).toBe('prod-server · IM.codes — AI Force Workbench · Your Dedicated AI Squad');
  });

  it('prefers the session label for the active session title part', () => {
    expect(
      buildDocumentTitle('prod-server', makeSession({ label: 'Todo Main', project: 'todo' })),
    ).toBe('prod-server · Todo Main · IM.codes — AI Force Workbench · Your Dedicated AI Squad');
  });

  it('falls back to project when the session has no label', () => {
    expect(getSessionTitleLabel(makeSession({ label: null, project: 'todo' }))).toBe('todo');
  });

  it('falls back to session name when label and project are missing', () => {
    expect(
      getSessionTitleLabel(makeSession({ label: null, project: '' })),
    ).toBe('deck_demo_brain');
  });

  it('uses custom localized appTitle when provided', () => {
    expect(buildDocumentTitle(null, null, 'IM.codes — AI 全栈工作台 · 你的专属 AI 战队'))
      .toBe('IM.codes — AI 全栈工作台 · 你的专属 AI 战队');
    expect(buildDocumentTitle('prod-server', makeSession({ label: 'Todo Main' }), 'IM.codes — AI 全栈工作台 · 你的专属 AI 战队'))
      .toBe('prod-server · Todo Main · IM.codes — AI 全栈工作台 · 你的专属 AI 战队');
  });

  it('safely falls back to default app title when custom title is blank or whitespace', () => {
    expect(buildDocumentTitle(null, null, '')).toBe(APP_TITLE);
    expect(buildDocumentTitle(null, null, '   ')).toBe(APP_TITLE);
    expect(buildDocumentTitle('prod-server', null, '   ')).toBe(`prod-server · ${APP_TITLE}`);
  });
});
