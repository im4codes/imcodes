/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, cleanup } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const parts = key.split('.');
      return parts[parts.length - 1];
    },
  }),
}));

vi.mock('../../src/components/FileBrowser.js', () => ({
  FileBrowser: () => null,
}));

import { StartSubSessionDialog } from '../../src/components/StartSubSessionDialog.js';

const makeWs = () => ({
  onMessage: vi.fn().mockReturnValue(() => {}),
  subSessionDetectShells: vi.fn(),
  send: vi.fn(),
});

describe('StartSubSessionDialog', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows claude-code-sdk and codex-sdk options', () => {
    render(
      <StartSubSessionDialog
        ws={makeWs() as any}
        defaultCwd="/tmp"
        isProviderConnected={() => false}
        getRemoteSessions={() => []}
        refreshSessions={vi.fn()}
        onStart={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /claude_code_sdk/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /codex_sdk/i })).toBeDefined();
  });
});
