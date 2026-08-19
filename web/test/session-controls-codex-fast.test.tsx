/**
 * @vitest-environment jsdom
 *
 * Codex keeps its "Fast" tier on the thread, so a session switched to it stays
 * there through every resume. The viewer had no way to see that and no way back
 * off, which is the reported "send /fast once and it can never be turned off".
 */
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODEX_FAST_OFF_COMMAND, CODEX_SERVICE_TIER } from '@shared/codex-service-tier.js';
import type { UseQuickDataResult } from '../src/components/QuickInputPanel.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}));

import { SessionControls } from '../src/components/SessionControls.js';

const quickData: UseQuickDataResult = {
  data: { history: [], sessionHistory: {}, commands: [], phrases: [] },
  loaded: true,
  recordHistory: vi.fn(), addCommand: vi.fn(), addPhrase: vi.fn(),
  removeCommand: vi.fn(), removePhrase: vi.fn(), removeHistory: vi.fn(),
  removeSessionHistory: vi.fn(), clearHistory: vi.fn(), clearSessionHistory: vi.fn(),
};

function makeWs() {
  return {
    connected: true,
    sendSessionCommand: vi.fn(),
    sendSessionCommandUrgent: vi.fn(),
    send: vi.fn(),
    sendInput: vi.fn(),
    onMessage: vi.fn(() => () => {}),
  } as any;
}

function renderControls(session: Record<string, unknown>) {
  const ws = makeWs();
  const { container } = render(
    <SessionControls
      ws={ws}
      activeSession={{
        name: 'deck_app_brain',
        project: 'app',
        role: 'brain',
        state: 'idle',
        projectDir: '/work/app',
        ...session,
      } as never}
      quickData={quickData}
      serverId="srv1"
      sessions={[]}
      subSessions={[]}
      onSend={vi.fn()}
    />,
  );
  return { ws, container, chip: container.querySelector('.shortcut-btn-fast-warning') as HTMLButtonElement | null };
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Codex Fast mode warning', () => {
  it('warns while the session is on the tier that spends plan usage faster', () => {
    const { chip } = renderControls({ agentType: 'codex-sdk', serviceTier: CODEX_SERVICE_TIER.FAST });
    expect(chip).not.toBeNull();
  });

  it('stays out of the way on the ordinary tier', () => {
    expect(renderControls({ agentType: 'codex-sdk', serviceTier: CODEX_SERVICE_TIER.DEFAULT }).chip).toBeNull();
    expect(renderControls({ agentType: 'codex-sdk' }).chip).toBeNull();
  });

  it('does not claim a tier for agents that have none', () => {
    const { chip } = renderControls({ agentType: 'claude-code', serviceTier: CODEX_SERVICE_TIER.FAST });
    expect(chip).toBeNull();
  });

  it('is itself the way out: one click sends the off switch', () => {
    const { ws, chip } = renderControls({ agentType: 'codex-sdk', serviceTier: CODEX_SERVICE_TIER.FAST });
    fireEvent.click(chip!);
    const sent = [...ws.sendSessionCommand.mock.calls, ...ws.send.mock.calls]
      .map((call) => JSON.stringify(call));
    expect(sent.some((call) => call.includes(CODEX_FAST_OFF_COMMAND))).toBe(true);
  });
});
