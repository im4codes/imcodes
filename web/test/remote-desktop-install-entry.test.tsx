/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_APP_MANIFEST_PATH } from '@shared/remote-desktop-app.js';
import { RemoteDesktopInstallEntry } from '../src/components/RemoteDesktopInstallEntry.js';
import { installPwaInstallCapture, resetPwaInstallStateForTests } from '../src/pwa-install.js';
import { stubDisplayMode, stubUserAgent } from './support/display-mode.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const EDGE = `${CHROME} Edg/151.0.0.0`;
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:156.0) Gecko/20100101 Firefox/156.0';
const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

let displayMode: ReturnType<typeof stubDisplayMode>;
let restoreUserAgent: () => void = () => {};

beforeEach(() => {
  resetPwaInstallStateForTests();
  displayMode = stubDisplayMode('browser');
  restoreUserAgent = stubUserAgent(CHROME);
  installPwaInstallCapture(window);
});
afterEach(() => {
  cleanup();
  displayMode.restore();
  restoreUserAgent();
  document.head.innerHTML = '';
});

/** The click handler is async (it awaits the browser's prompt): let its whole promise chain run before asserting. */
const settle = () => act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });

function offerInstall(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & { prompt: ReturnType<typeof vi.fn>; userChoice: Promise<{ outcome: string }> };
  event.prompt = vi.fn(async () => {});
  event.userChoice = Promise.resolve({ outcome });
  act(() => { window.dispatchEvent(event); });
  return event;
}

describe('the "install as app" entry', () => {
  it('is offered in a browser tab or pop-up, and makes the page advertise the app manifest', () => {
    render(<RemoteDesktopInstallEntry />);
    expect(screen.getByTestId('remote-desktop-install-app').textContent).toContain('remote_desktop.install_app');
    expect(document.head.querySelector('link[rel="manifest"]')?.getAttribute('href')).toBe(REMOTE_DESKTOP_APP_MANIFEST_PATH);
  });

  it('is hidden when the page already runs as an installed app, and when a fullscreen app window does', () => {
    displayMode.set('standalone');
    const first = render(<RemoteDesktopInstallEntry />);
    expect(first.container.querySelector('[data-testid="remote-desktop-install-app"]')).toBeNull();
    cleanup();
    displayMode.set('fullscreen');
    const second = render(<RemoteDesktopInstallEntry />);
    expect(second.container.querySelector('[data-testid="remote-desktop-install-app"]')).toBeNull();
  });

  it('disappears when the browser moves the page into an app window while it is open', () => {
    const { container } = render(<RemoteDesktopInstallEntry />);
    expect(container.querySelector('[data-testid="remote-desktop-install-app"]')).not.toBeNull();
    act(() => { displayMode.set('standalone'); });
    expect(container.querySelector('[data-testid="remote-desktop-install-app"]')).toBeNull();
  });

  it('disappears once the app has been installed', () => {
    const { container } = render(<RemoteDesktopInstallEntry />);
    act(() => { window.dispatchEvent(new Event('appinstalled')); });
    expect(container.querySelector('[data-testid="remote-desktop-install-app"]')).toBeNull();
  });

  it.each([
    ['Chrome', CHROME, 'chrome'],
    ['Edge', EDGE, 'edge'],
    ['Safari on a Mac', SAFARI_MAC, 'safari_mac'],
    ['Safari on an iPhone', SAFARI_IPHONE, 'safari_ios'],
    ['Firefox', FIREFOX, 'firefox'],
  ])('with no install prompt, %s gets that browser\'s own instruction', (_label, userAgent, kind) => {
    restoreUserAgent();
    restoreUserAgent = stubUserAgent(userAgent, kind === 'safari_ios' ? 5 : 0);
    render(<RemoteDesktopInstallEntry />);
    expect(screen.queryByTestId('remote-desktop-install-guide')).toBeNull();
    fireEvent.click(screen.getByTestId('remote-desktop-install-app'));
    expect(screen.getByTestId('remote-desktop-install-guide').textContent).toContain(`remote_desktop.install_guide_${kind}`);
  });

  it('closes the instruction with a second click or with its own close button', () => {
    render(<RemoteDesktopInstallEntry />);
    const button = screen.getByTestId('remote-desktop-install-app');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(button);
    expect(screen.queryByTestId('remote-desktop-install-guide')).toBeNull();
    fireEvent.click(button);
    fireEvent.click(screen.getByLabelText('remote_desktop.install_guide_close'));
    expect(screen.queryByTestId('remote-desktop-install-guide')).toBeNull();
  });

  it('starts the install with one click when the browser offered a prompt, and shows no instruction', async () => {
    render(<RemoteDesktopInstallEntry />);
    const event = offerInstall('accepted');
    fireEvent.click(screen.getByTestId('remote-desktop-install-app'));
    await settle();
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('remote-desktop-install-guide')).toBeNull();
  });

  it('does not nag with an instruction after the user declined the browser\'s own prompt', async () => {
    render(<RemoteDesktopInstallEntry />);
    offerInstall('dismissed');
    fireEvent.click(screen.getByTestId('remote-desktop-install-app'));
    await settle();
    expect(screen.queryByTestId('remote-desktop-install-guide')).toBeNull();
  });

  it('falls back to the instruction when the browser refuses to show its prompt', async () => {
    render(<RemoteDesktopInstallEntry />);
    const event = offerInstall();
    event.prompt.mockRejectedValueOnce(new Error('not allowed'));
    fireEvent.click(screen.getByTestId('remote-desktop-install-app'));
    await waitFor(() => expect(screen.getByTestId('remote-desktop-install-guide').textContent).toContain('remote_desktop.install_guide_chrome'));
  });

  it('a prompt that arrives after the entry mounted is used (the event fires once, whenever the browser decides)', async () => {
    render(<RemoteDesktopInstallEntry />);
    // the click before any prompt shows the instruction ...
    fireEvent.click(screen.getByTestId('remote-desktop-install-app'));
    expect(screen.getByTestId('remote-desktop-install-guide')).not.toBeNull();
    fireEvent.click(screen.getByTestId('remote-desktop-install-app'));
    // ... and once the browser offers one, the same button installs.
    const event = offerInstall();
    fireEvent.click(screen.getByTestId('remote-desktop-install-app'));
    await settle();
    expect(event.prompt).toHaveBeenCalledTimes(1);
  });

  it('compact mode keeps the button name for assistive technology but draws only the icon', () => {
    render(<RemoteDesktopInstallEntry compact buttonClass="remote-desktop-workspace-chrome-button" />);
    const button = screen.getByTestId('remote-desktop-install-app');
    expect(button.getAttribute('aria-label')).toBe('remote_desktop.install_app');
    expect(button.textContent).not.toContain('remote_desktop.install_app');
    expect(button.className).toContain('remote-desktop-workspace-chrome-button');
  });
});
