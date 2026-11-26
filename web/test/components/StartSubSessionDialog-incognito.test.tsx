/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { SESSION_INCOGNITO_CAPABILITY } from '../../../shared/session-incognito-types.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../src/components/FileBrowser.js', () => ({
  FileBrowser: () => null,
}));

import { StartSubSessionDialog } from '../../src/components/StartSubSessionDialog.js';

function makeWs(caps: string[]) {
  return {
    connected: true,
    onMessage: vi.fn().mockReturnValue(() => {}),
    subSessionDetectShells: vi.fn(),
    send: vi.fn(),
    getDaemonCapabilitySnapshot: vi.fn(() => ({
      daemonId: 'daemon-1',
      capabilities: caps,
      helloEpoch: 1,
      sentAt: Date.now(),
      observedAt: Date.now(),
    })),
    isDaemonCapabilityStale: vi.fn(() => false),
  };
}

describe('StartSubSessionDialog incognito mode', () => {
  afterEach(() => {
    localStorage.clear();
    cleanup();
  });

  it('disables incognito toggle when daemon lacks capability and collapses explanation until toggled', () => {
    const view = render(
      <StartSubSessionDialog
        ws={makeWs([]) as any}
        defaultCwd="/tmp"
        isProviderConnected={() => false}
        getRemoteSessions={() => []}
        refreshSessions={vi.fn()}
        onStart={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const option = view.container.querySelector('.incognito-create-option') as HTMLElement | null;
    const toggle = view.container.querySelector('.incognito-create-option .incognito-toggle-btn') as HTMLElement | null;
    const helpBtn = view.container.querySelector('.incognito-create-option .incognito-help-toggle') as HTMLButtonElement | null;
    expect(option).toBeTruthy();
    expect(toggle).toBeTruthy();
    expect(helpBtn).toBeTruthy();
    expect(helpBtn!.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelector('.incognito-create-option .incognito-help-body')).toBeNull();
    expect(view.container.querySelector('.incognito-create-option [role="status"]')).toBeNull();

    const checkbox = view.container.querySelector('.incognito-create-option input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);

    fireEvent.click(helpBtn!);
    expect(helpBtn!.getAttribute('aria-expanded')).toBe('true');
    expect(view.container.querySelector('.incognito-create-option .incognito-help-body')?.textContent).toContain('session.incognito_available');
    expect(view.container.querySelector('.incognito-create-option [role="status"]')?.textContent).toBe('session.incognito_unsupported');

    fireEvent.click(helpBtn!);
    expect(helpBtn!.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelector('.incognito-create-option .incognito-help-body')).toBeNull();
  });

  it('toggles active styling, disables non-SDK runtimes, keeps details collapsed unless opened, and passes incognito:true on launch', async () => {
    const onStart = vi.fn();
    const view = render(
      <StartSubSessionDialog
        ws={makeWs([SESSION_INCOGNITO_CAPABILITY]) as any}
        defaultCwd="/tmp/sub"
        isProviderConnected={() => false}
        getRemoteSessions={() => []}
        refreshSessions={vi.fn()}
        onStart={onStart}
        onClose={vi.fn()}
      />,
    );

    const option = view.container.querySelector('.incognito-create-option')!;
    const toggle = view.container.querySelector('.incognito-create-option .incognito-toggle-btn')!;
    const helpBtn = view.container.querySelector('.incognito-create-option .incognito-help-toggle') as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    expect(option.classList.contains('is-active')).toBe(false);
    expect(toggle.classList.contains('is-active')).toBe(false);
    expect(helpBtn.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelector('.incognito-create-option p')).toBeNull();
    expect(view.container.querySelector('.dialog-footer .btn-primary.incognito-launch-btn')).toBeNull();

    const checkbox = view.container.querySelector('.incognito-create-option input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(option.classList.contains('is-active')).toBe(true);
    expect(toggle.classList.contains('is-active')).toBe(true);
    expect(helpBtn.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelector('.incognito-create-option .incognito-help-body')).toBeNull();

    fireEvent.click(helpBtn);
    expect(helpBtn.getAttribute('aria-expanded')).toBe('true');
    expect(view.container.querySelector('.incognito-create-option .incognito-help-body')?.textContent).toContain('session.incognito_hint');
    fireEvent.click(helpBtn);
    expect(helpBtn.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelector('.incognito-create-option .incognito-help-body')).toBeNull();

    const launchBtn = view.container.querySelector('.dialog-footer .btn-primary') as HTMLButtonElement;
    expect(launchBtn.classList.contains('incognito-launch-btn')).toBe(true);

    const shellBtn = view.container.querySelector('[data-agent-type="shell"]') as HTMLButtonElement | null;
    if (shellBtn) expect(shellBtn.disabled).toBe(true);
    const claudeCliBtn = view.container.querySelector('[data-agent-type="claude-code"]') as HTMLButtonElement | null;
    if (claudeCliBtn) expect(claudeCliBtn.disabled).toBe(true);
    const codexSdkBtn = view.container.querySelector('[data-agent-type="codex-sdk"]') as HTMLButtonElement | null;
    expect(codexSdkBtn).toBeTruthy();
    expect(codexSdkBtn!.disabled).toBe(false);

    fireEvent.click(codexSdkBtn!);
    fireEvent.click(launchBtn);

    await waitFor(() => {
      expect(onStart).toHaveBeenCalledWith(
        'codex-sdk',
        undefined,
        '/tmp/sub',
        undefined,
        expect.objectContaining({ incognito: true }),
      );
    });
  });
});
