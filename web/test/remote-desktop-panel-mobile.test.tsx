/** @vitest-environment jsdom */
import { act, cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_CAPABILITY,
  REMOTE_DESKTOP_LIMITS,
  REMOTE_DESKTOP_STATE,
  REMOTE_DESKTOP_TERMINAL_REASON,
} from '@shared/remote-desktop.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const pointerButton = vi.fn(() => true);
const pointerMove = vi.fn();
const wheel = vi.fn(() => true);
const releaseAll = vi.fn();
const releasePointerButtons = vi.fn();
const acknowledgePresentedFrame = vi.fn(() => true);
const setDisplayMode = vi.fn(() => true);
const setDisplayScale = vi.fn(() => true);
const setMode = vi.fn(() => true);
const key = vi.fn(() => true);
const text = vi.fn(() => true);
const requestRemoteClipboard = vi.fn(async () => 'selected remotely');
const selectDisplay = vi.fn(() => true);
const stop = vi.fn();
const { uploadFileWithDirectFallback } = vi.hoisted(() => ({
  uploadFileWithDirectFallback: vi.fn(),
}));
const clientHooks: Array<{ onSnapshot(value: unknown): void }> = [];
const clientStarts: number[] = [];

vi.mock('../src/remote-desktop-client.js', () => ({
  RemoteDesktopClient: class {
    constructor(_serverId: string, hooks: { onSnapshot(value: unknown): void }) {
      clientHooks.push(hooks);
      queueMicrotask(() => hooks.onSnapshot({
        state: REMOTE_DESKTOP_STATE.DIRECT,
        mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
        inputEpoch: 1,
        inputEnabled: true,
        route: 'direct',
        displays: [
          {
            id: 'display-primary', label: 'Display 1', primary: true, available: true,
            width: 1920, height: 1080, dpiScale: 2.25, rotation: 0,
          },
          {
            id: 'display-second', label: 'Display 2', primary: false, available: true,
            width: 2560, height: 1440, dpiScale: 1.5, rotation: 0,
          },
        ],
        selectedDisplayId: 'display-primary',
        layoutRevision: 1,
        stream: null,
      }));
    }
    start = vi.fn(async (reconnectAttempt = 0) => { clientStarts.push(reconnectAttempt); });
    stop = stop;
    releaseAll = releaseAll;
    releasePointerButtons = releasePointerButtons;
    acknowledgePresentedFrame = acknowledgePresentedFrame;
    pointerButton = pointerButton;
    pointerMove = pointerMove;
    wheel = wheel;
    key = key;
    text = text;
    setMode = setMode;
    selectDisplay = selectDisplay;
    setDisplayMode = setDisplayMode;
    setDisplayScale = setDisplayScale;
    requestRemoteClipboard = requestRemoteClipboard;
  },
}));

vi.mock('../src/api.js', () => ({
  downloadAttachment: vi.fn(),
}));

vi.mock('../src/direct-file-transfer.js', () => ({
  uploadFileWithDirectFallback,
  isFileUploadCanceled: (error: unknown) => (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  ),
}));

vi.mock('../src/api/machines.js', () => ({
  createMachineFileHandle: vi.fn(),
  listMachineDirectories: vi.fn(),
}));

import { RemoteDesktopPanel } from '../src/components/RemoteDesktopPanel.js';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  clientHooks.length = 0;
  clientStarts.length = 0;
  localStorage.removeItem('rcc_float_remote-desktop-server-1');
});

function pointer(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  values: { pointerId: number; clientX: number; clientY: number },
): void {
  const eventName = type === 'pointerdown' && !('onpointerdown' in target)
    ? 'PointerDown'
    : type === 'pointermove' && !('onpointermove' in target)
      ? 'PointerMove'
      : type === 'pointerup' && !('onpointerup' in target)
        ? 'PointerUp'
        : type;
  const event = new MouseEvent(eventName, {
    bubbles: true,
    cancelable: true,
    clientX: values.clientX,
    clientY: values.clientY,
  });
  Object.defineProperties(event, {
    pointerId: { value: values.pointerId },
    pointerType: { value: 'touch' },
    button: { value: 0 },
  });
  target.dispatchEvent(event);
}

function mousePointer(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'pointerenter' | 'pointerleave' | 'lostpointercapture',
  values: { pointerId: number; clientX: number; clientY: number; button?: number; metaKey?: boolean },
): void {
  const eventName = type === 'pointerdown' && !('onpointerdown' in target)
    ? 'PointerDown'
    : type === 'pointermove' && !('onpointermove' in target)
      ? 'PointerMove'
    : type === 'pointerup' && !('onpointerup' in target)
      ? 'PointerUp'
      : type === 'pointerenter' && !('onpointerenter' in target)
        ? 'PointerEnter'
        : type === 'pointerleave' && !('onpointerleave' in target)
          ? 'PointerLeave'
      : type === 'pointercancel' && !('onpointercancel' in target)
        ? 'PointerCancel'
        : type === 'lostpointercapture' && !('onlostpointercapture' in target)
          ? 'LostPointerCapture'
      : type;
  const event = new MouseEvent(eventName, {
    bubbles: true,
    cancelable: true,
    clientX: values.clientX,
    clientY: values.clientY,
    button: values.button ?? 0,
    metaKey: values.metaKey ?? false,
  });
  Object.defineProperties(event, {
    pointerId: { value: values.pointerId },
    pointerType: { value: 'mouse' },
  });
  target.dispatchEvent(event);
}

async function renderPanel(
  ws?: { targetsServer(serverId: string): boolean },
  capabilities: string[] = [REMOTE_DESKTOP_CAPABILITY],
  panelProps: {
    minimized?: boolean;
    allowStandaloneWindow?: boolean;
    onMinimize?: () => void;
    onRestore?: () => void;
    onClose?: () => void;
  } = {},
) {
  const result = render(<RemoteDesktopPanel
    machine={{
      serverId: 'server-1',
      refName: 'controlled-1',
      displayName: 'Windows',
      os: 'win',
      online: true,
      execEnabled: true,
      accessRole: 'owner',
      capabilities,
    }}
    ws={ws as never}
    onClose={panelProps.onClose ?? vi.fn()}
    minimized={panelProps.minimized}
    allowStandaloneWindow={panelProps.allowStandaloneWindow}
    onMinimize={panelProps.onMinimize}
    onRestore={panelProps.onRestore}
  />);
  await act(async () => { await Promise.resolve(); });
  const stage = result.container.querySelector('.remote-desktop-stage') as HTMLDivElement;
  const video = result.container.querySelector('video') as HTMLVideoElement;
  Object.defineProperties(stage, {
    clientWidth: { value: 400, configurable: true },
    clientHeight: { value: 300, configurable: true },
  });
  Object.defineProperties(video, {
    offsetWidth: { value: 400, configurable: true },
    offsetHeight: { value: 300, configurable: true },
    videoWidth: { value: 1920, configurable: true },
    videoHeight: { value: 1080, configurable: true },
  });
  stage.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300,
    width: 400, height: 300, toJSON: () => ({}),
  });
  video.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300,
    width: 400, height: 300, toJSON: () => ({}),
  });
  return { ...result, stage, video };
}

describe('RemoteDesktopPanel mobile gestures', () => {
  it('opens the same controlled machine in an independent browser window', async () => {
    const opened = { opener: window } as unknown as Window;
    const open = vi.spyOn(window, 'open').mockReturnValue(opened);
    const onClose = vi.fn();
    const result = await renderPanel(undefined, [REMOTE_DESKTOP_CAPABILITY], {
      allowStandaloneWindow: true,
      onClose,
    });

    act(() => (result.getByRole('button', {
      name: 'remote_desktop.open_new_window',
    }) as HTMLButtonElement).click());

    expect(open).toHaveBeenCalledTimes(1);
    const [url, target, features] = open.mock.calls[0] ?? [];
    expect(new URL(String(url)).searchParams.get('remoteDesktopServer')).toBe('server-1');
    expect(target).toBe('_blank');
    expect(features).toContain('popup');
    expect(opened.opener).toBeNull();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the current desktop connected when the standalone popup is blocked', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const onClose = vi.fn();
    const result = await renderPanel(undefined, [REMOTE_DESKTOP_CAPABILITY], {
      allowStandaloneWindow: true,
      onClose,
    });

    act(() => (result.getByRole('button', {
      name: 'remote_desktop.open_new_window',
    }) as HTMLButtonElement).click());

    expect(stop).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not offer standalone windows on mobile', async () => {
    const result = await renderPanel();

    expect(result.queryByRole('button', {
      name: 'remote_desktop.open_new_window',
    })).toBeNull();
  });

  it('uses shared window controls and minimizes without stopping the live desktop', async () => {
    const onMinimize = vi.fn();
    const onRestore = vi.fn();
    const onClose = vi.fn();
    const result = await renderPanel(undefined, [REMOTE_DESKTOP_CAPABILITY], {
      onMinimize,
      onRestore,
      onClose,
    });

    const maximize = result.getByRole('button', { name: 'window.maximize' });
    expect(maximize.classList.contains('subsession-minimize-btn')).toBe(true);
    act(() => (maximize as HTMLButtonElement).click());
    expect(result.getByRole('button', { name: 'window.restore' })).toBeTruthy();

    const minimize = result.getByRole('button', { name: 'window.minimize' });
    expect(minimize.classList.contains('subsession-minimize-btn')).toBe(true);
    act(() => (minimize as HTMLButtonElement).click());
    expect(releaseAll).toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(onMinimize).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    result.rerender(<RemoteDesktopPanel
      machine={{
        serverId: 'server-1',
        refName: 'controlled-1',
        displayName: 'Windows',
        os: 'win',
        online: true,
        execEnabled: true,
        accessRole: 'owner',
        capabilities: [REMOTE_DESKTOP_CAPABILITY],
      }}
      minimized
      onMinimize={onMinimize}
      onRestore={onRestore}
      onClose={onClose}
    />);
    expect(result.container.querySelector('.remote-desktop-window-host')?.hasAttribute('hidden')).toBe(true);
    act(() => (result.getByRole('button', { name: 'remote_desktop.title' }) as HTMLButtonElement).click());
    expect(onRestore).toHaveBeenCalledTimes(1);

    const stopButton = result.container.querySelector('.remote-desktop-stop');
    expect(stopButton?.classList.contains('subsession-close-btn')).toBe(true);
  });

  it('uses the shared desktop window chrome for header drag and eight-way resize', async () => {
    Object.defineProperties(window, {
      innerWidth: { value: 1600, configurable: true },
      innerHeight: { value: 1000, configurable: true },
    });
    const { container, getByTestId } = await renderPanel();
    const shell = getByTestId('floating-panel-remote-desktop-server-1') as HTMLDivElement;
    const header = container.querySelector('.remote-desktop-header') as HTMLElement;
    const initialLeft = Number.parseFloat(String(shell.style.left));
    const initialTop = Number.parseFloat(String(shell.style.top));
    const initialWidth = Number.parseFloat(String(shell.style.width));

    act(() => {
      header.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, clientX: 200, clientY: 100,
      }));
      document.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: 260, clientY: 140,
      }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    expect(Number.parseFloat(String(shell.style.left))).toBe(initialLeft + 60);
    expect(Number.parseFloat(String(shell.style.top))).toBe(initialTop + 40);

    const southeast = getByTestId('floating-resize-se');
    act(() => {
      southeast.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, clientX: 0, clientY: 0,
      }));
      document.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: 80, clientY: 60,
      }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    expect(Number.parseFloat(String(shell.style.width))).toBe(initialWidth + 80);
    expect(container.querySelectorAll('[data-testid^="floating-resize-"]')).toHaveLength(8);
  });

  it('reuses direct file transfer progress/mode and cancels without touching the desktop peer', async () => {
    uploadFileWithDirectFallback.mockImplementation(async (options: {
      onMode?(mode: string): void;
      onProgress?(progress: number): void;
      signal: AbortSignal;
    }) => {
      options.onMode?.('direct');
      options.onProgress?.(33);
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          reject(new DOMException('upload_canceled', 'AbortError'));
        }, { once: true });
      });
    });
    const ws = { targetsServer: vi.fn(() => true) };
    const { container, getByRole } = await renderPanel(ws);
    act(() => { (getByRole('button', { name: 'remote_desktop.files' }) as HTMLButtonElement).click(); });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['payload'], 'report.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    act(() => input.dispatchEvent(new Event('change', { bubbles: true })));

    await vi.waitFor(() => expect(container.textContent).toContain('upload.transport.direct'));
    expect((container.querySelector('progress') as HTMLProgressElement).value).toBe(33);
    expect(ws.targetsServer).toHaveBeenCalledWith('server-1');
    expect(pointerMove).not.toHaveBeenCalled();

    act(() => (getByRole('button', { name: 'remote_desktop.cancel_transfer' }) as HTMLButtonElement).click());
    await vi.waitFor(() => expect(container.textContent).toContain('remote_desktop.transfer_status_canceled'));
  });

  it('keeps relay fallback visible in the remote-panel transfer row', async () => {
    uploadFileWithDirectFallback.mockImplementation(async (options: {
      onMode?(mode: string): void;
      onProgress?(progress: number): void;
    }) => {
      options.onMode?.('falling_back');
      options.onMode?.('relay');
      options.onProgress?.(100);
      return { ok: true, attachment: { id: 'attachment-1' } };
    });
    const { container, getByRole } = await renderPanel();
    act(() => { (getByRole('button', { name: 'remote_desktop.files' }) as HTMLButtonElement).click(); });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [new File(['payload'], 'relay.txt')],
      configurable: true,
    });
    act(() => input.dispatchEvent(new Event('change', { bubbles: true })));
    await vi.waitFor(() => expect(container.textContent).toContain('upload.transport.relay'));
    await vi.waitFor(() => expect(container.textContent).toContain('remote_desktop.transfer_status_done'));
  });

  it('shows bounded connection diagnostics without rendering signaling or authority secrets', async () => {
    const { container } = await renderPanel();
    act(() => clientHooks[0]!.onSnapshot({
      state: REMOTE_DESKTOP_STATE.DIRECT,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      inputEnabled: true,
      route: 'relay',
      displays: [{
        id: 'display-primary', label: 'Display 1', primary: true, available: true,
        width: 1920, height: 1080, dpiScale: 1.5, rotation: 0,
      }],
      selectedDisplayId: 'display-primary',
      layoutRevision: 1,
      quality: {
        preset: '1080p30', encoderClass: 'software', width: 1920, height: 1080,
        fps: 29, bitrateBps: 4_200_000, droppedFrames: 3, rttMs: 24,
      },
      stream: null,
      durationMs: 12_000,
      reconnectCount: 2,
      capabilityVersion: REMOTE_DESKTOP_CAPABILITY,
      // These are deliberately outside the snapshot contract and therefore
      // must not become a rendering escape hatch for sensitive diagnostics.
      sdp: 'secret-sdp-marker',
      iceCredential: 'secret-turn-marker',
      rawCapability: 'secret-capability-marker',
      inputHistory: 'KeyA',
    }));
    const diagnostics = container.querySelector('.remote-desktop-diagnostics');
    expect(diagnostics?.textContent).toContain('1920×1080');
    expect(diagnostics?.textContent).toContain('29 FPS');
    expect(diagnostics?.textContent).toContain('4.2 Mbps · 24 ms');
    expect(diagnostics?.textContent).not.toContain('secret-sdp-marker');
    expect(diagnostics?.textContent).not.toContain('secret-turn-marker');
    expect(diagnostics?.textContent).not.toContain('secret-capability-marker');
    expect(diagnostics?.textContent).not.toContain('KeyA');
  });

  it('shows each handshake and media step while the desktop connection advances', async () => {
    const { container } = await renderPanel();
    const snapshot = {
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 0,
      inputEnabled: false,
      displays: [],
      layoutRevision: 1,
      stream: null,
    };
    const assertCurrentStep = (key: string) => {
      const progress = container.querySelector('.remote-desktop-connection-progress');
      expect(progress?.querySelectorAll('li')).toHaveLength(4);
      expect(progress?.querySelector('[aria-current="step"]')?.textContent).toContain(key);
    };

    act(() => clientHooks[0]!.onSnapshot({ ...snapshot, state: REMOTE_DESKTOP_STATE.AUTHORIZING }));
    assertCurrentStep('remote_desktop.connection_steps.authorize');
    act(() => clientHooks[0]!.onSnapshot({ ...snapshot, state: REMOTE_DESKTOP_STATE.PREPARING }));
    assertCurrentStep('remote_desktop.connection_steps.worker');
    act(() => clientHooks[0]!.onSnapshot({ ...snapshot, state: REMOTE_DESKTOP_STATE.CONNECTING }));
    assertCurrentStep('remote_desktop.connection_steps.negotiate');
    act(() => clientHooks[0]!.onSnapshot({ ...snapshot, state: REMOTE_DESKTOP_STATE.DIRECT, route: 'direct' }));
    assertCurrentStep('remote_desktop.connection_steps.media');

    const stream = {} as MediaStream;
    act(() => clientHooks[0]!.onSnapshot({
      ...snapshot,
      state: REMOTE_DESKTOP_STATE.DIRECT,
      route: 'direct',
      stream,
    }));
    assertCurrentStep('remote_desktop.connection_steps.media');
    act(() => {
      (container.querySelector('video') as HTMLVideoElement)
        .dispatchEvent(new Event('loadeddata'));
    });
    expect(container.querySelector('.remote-desktop-connection-progress')).toBeNull();
  });

  it('keeps monitor and mode controls keyboard-focusable while viewing', async () => {
    const { getByRole } = await renderPanel();
    act(() => clientHooks[0]!.onSnapshot({
      state: REMOTE_DESKTOP_STATE.DIRECT,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 2,
      inputEnabled: false,
      route: 'direct',
      displays: [{
        id: 'display-primary', label: 'Display 1', primary: true, available: true,
        width: 1920, height: 1080, dpiScale: 1.5, rotation: 0,
      }],
      selectedDisplayId: 'display-primary',
      layoutRevision: 2,
      stream: null,
    }));

    const displayTab = getByRole('tab', { name: 'Display 1' });
    const controlButton = getByRole('button', { name: 'remote_desktop.control_mode' });
    displayTab.focus();
    expect(document.activeElement).toBe(displayTab);
    controlButton.focus();
    expect(document.activeElement).toBe(controlButton);
    expect((controlButton as HTMLButtonElement).disabled).toBe(false);
  });

  it('opens each display resolution menu by context gesture and switches a fixed 720p-4K mode', async () => {
    const { getByRole, getAllByRole } = await renderPanel();
    const displayTab = getByRole('tab', { name: 'Display 1' });
    act(() => {
      displayTab.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 50,
      }));
    });
    expect(getByRole('menu')).not.toBeNull();
    const modes = getAllByRole('menuitemradio').filter((mode) => (
      mode.textContent?.includes('×')
    ));
    expect(modes.map((mode) => mode.textContent)).toEqual([
      '720p1280×720',
      '1080p1920×1080',
      '1440p2560×1440',
      '4K3840×2160',
    ]);
    act(() => { (modes[3] as HTMLButtonElement).click(); });
    expect(setDisplayMode).toHaveBeenCalledWith('display-primary', 3840, 2160);

    act(() => {
      displayTab.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 50,
      }));
    });
    act(() => { (getByRole('menuitemradio', { name: '150% DPI' }) as HTMLButtonElement).click(); });
    expect(setDisplayScale).toHaveBeenCalledWith('display-primary', 150);

    const secondDisplayTab = getByRole('tab', { name: 'Display 2' });
    act(() => {
      secondDisplayTab.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 80,
        clientY: 50,
      }));
    });
    const secondModes = getAllByRole('menuitemradio').filter((mode) => (
      mode.textContent?.includes('×')
    ));
    act(() => { (secondModes[0] as HTMLButtonElement).click(); });
    expect(setDisplayMode).toHaveBeenCalledWith('display-second', 1280, 720);
  });

  it('focuses the stage for physical keyboard input and supports explicit copy and paste', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: vi.fn(async () => 'local clipboard'),
        writeText: vi.fn(async () => {}),
      },
    });
    const { stage, getByRole } = await renderPanel();
    mousePointer(stage, 'pointerdown', {
      pointerId: 60, clientX: 200, clientY: 150,
    });
    expect(document.activeElement).toBe(stage);
    act(() => stage.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'KeyA',
      key: 'a',
    })));
    expect(key).toHaveBeenCalledWith('KeyA', 'a', true, false, {
      control: false,
      alt: false,
    });

    key.mockClear();
    const selectAll = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'KeyA',
      key: 'a',
      ctrlKey: true,
    });
    act(() => stage.dispatchEvent(selectAll));
    expect(selectAll.defaultPrevented).toBe(true);
    expect(key).toHaveBeenCalledWith('KeyA', 'a', true, false, {
      control: true,
      alt: false,
    });

    key.mockClear();
    const escape = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'Escape',
      key: 'Escape',
    });
    act(() => stage.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(key).toHaveBeenCalledWith('Escape', 'Escape', true, false, {
      control: false,
      alt: false,
    });
    expect(setMode).not.toHaveBeenCalled();

    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { getData: vi.fn(() => 'pasted from event') },
    });
    act(() => stage.dispatchEvent(pasteEvent));
    expect(text).toHaveBeenCalledWith('pasted from event');

    await act(async () => {
      (getByRole('button', { name: 'remote_desktop.paste_local_clipboard' }) as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(text).toHaveBeenCalledWith('local clipboard');

    await act(async () => {
      (getByRole('button', { name: 'remote_desktop.copy_remote_selection' }) as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(requestRemoteClipboard).toHaveBeenCalledTimes(1);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('selected remotely');
  });

  it('opens an icon-only mobile IME surface and sends common shortcut chords', async () => {
    const { container, getByRole } = await renderPanel();
    const keyboardButton = getByRole('button', { name: 'remote_desktop.mobile_keyboard' });
    expect(keyboardButton.textContent).toBe('⌨');
    act(() => { (keyboardButton as HTMLButtonElement).click(); });

    const input = getByRole('textbox', { name: 'remote_desktop.mobile_text_input' }) as HTMLTextAreaElement;
    input.focus();
    expect(document.activeElement).toBe(input);
    input.value = '你好';
    act(() => input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '你好' })));
    expect(text).toHaveBeenCalledWith('你好');

    key.mockClear();
    act(() => {
      (getByRole('button', { name: 'remote_desktop.shortcut_select_all' }) as HTMLButtonElement).click();
    });
    expect(key.mock.calls).toEqual([
      ['ControlLeft', 'Control', true, false, { control: true, alt: false }],
      ['KeyA', 'a', true, false, { control: true, alt: false }],
      ['KeyA', 'a', false, false, { control: true, alt: false }],
      ['ControlLeft', 'Control', false, false, { control: true, alt: false }],
    ]);
    expect(container.querySelector('.remote-desktop-mobile-keyboard')).not.toBeNull();
  });

  it('opens the focused display resolution menu from the keyboard context-menu gesture', async () => {
    const { getByRole } = await renderPanel();
    const displayTab = getByRole('tab', { name: 'Display 1' });
    displayTab.focus();
    act(() => {
      displayTab.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'F10',
        shiftKey: true,
      }));
    });
    expect(getByRole('menu')).not.toBeNull();
    expect(document.activeElement).toBe(displayTab);
  });

  it('opens the same per-display resolution menu on a mobile long press without selecting the tab', async () => {
    vi.useFakeTimers();
    const { getByRole } = await renderPanel();
    const displayTab = getByRole('tab', { name: 'Display 1' });
    act(() => {
      pointer(displayTab, 'pointerdown', { pointerId: 44, clientX: 80, clientY: 60 });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(550); });
    expect(getByRole('menu')).not.toBeNull();
    act(() => {
      pointer(displayTab, 'pointerup', { pointerId: 44, clientX: 80, clientY: 60 });
      (displayTab as HTMLButtonElement).click();
    });
    expect(setDisplayMode).not.toHaveBeenCalled();
  });

  it('does not leave a stale click suppression behind when a long press emits no click', async () => {
    vi.useFakeTimers();
    const { getByRole } = await renderPanel();
    const displayTab = getByRole('tab', { name: 'Display 2' });
    act(() => {
      pointer(displayTab, 'pointerdown', { pointerId: 45, clientX: 100, clientY: 60 });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_551); });
    act(() => { (displayTab as HTMLButtonElement).click(); });
    expect(selectDisplay).toHaveBeenCalledWith('display-second');
  });

  it('turns a touch tap into one remote left click without DPI multiplication', async () => {
    const { stage } = await renderPanel();
    pointer(stage, 'pointerdown', { pointerId: 1, clientX: 200, clientY: 150 });
    pointer(stage, 'pointerup', { pointerId: 1, clientX: 200, clientY: 150 });
    expect(pointerButton).toHaveBeenNthCalledWith(1, 'left', true, 0.5, 0.5);
    expect(pointerButton).toHaveBeenNthCalledWith(2, 'left', false, 0.5, 0.5);
  });

  it('releases a captured mouse button even when pointer-up is outside video content', async () => {
    const { stage } = await renderPanel();
    mousePointer(stage, 'pointerdown', {
      pointerId: 7, clientX: 200, clientY: 150,
    });
    mousePointer(stage, 'pointerup', {
      pointerId: 7, clientX: 500, clientY: 350,
    });
    mousePointer(stage, 'lostpointercapture', {
      pointerId: 7, clientX: 500, clientY: 350,
    });
    expect(pointerButton).toHaveBeenNthCalledWith(1, 'left', true, 0.5, 0.5);
    expect(pointerButton).toHaveBeenNthCalledWith(2, 'left', false, undefined, undefined);
    expect(releasePointerButtons).toHaveBeenCalledTimes(1);
    expect(releaseAll).not.toHaveBeenCalled();
  });

  it('releases only pointer buttons on pointer cancellation so held modifiers survive', async () => {
    const { stage } = await renderPanel();
    mousePointer(stage, 'pointerdown', {
      pointerId: 8, clientX: 200, clientY: 150,
    });
    mousePointer(stage, 'pointercancel', {
      pointerId: 8, clientX: 200, clientY: 150,
    });
    expect(releasePointerButtons).toHaveBeenCalledTimes(1);
    expect(releaseAll).not.toHaveBeenCalled();
  });

  it('maps Mac Command drag to a pure Windows middle-button drag', async () => {
    const originalPlatform = navigator.platform;
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'MacIntel',
    });
    try {
      const { stage } = await renderPanel();
      act(() => stage.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'MetaLeft',
        key: 'Meta',
        metaKey: true,
      })));
      expect(key).toHaveBeenCalledWith('ControlLeft', 'Control', true, false, {
        control: true,
        alt: false,
      });

      mousePointer(stage, 'pointerdown', {
        pointerId: 19, clientX: 200, clientY: 150, metaKey: true,
      });
      mousePointer(stage, 'pointermove', {
        pointerId: 19, clientX: 300, clientY: 150, metaKey: true,
      });
      mousePointer(stage, 'pointerup', {
        pointerId: 19, clientX: 300, clientY: 150, metaKey: false,
      });
      act(() => stage.dispatchEvent(new KeyboardEvent('keyup', {
        bubbles: true,
        cancelable: true,
        code: 'MetaLeft',
        key: 'Meta',
      })));

      expect(pointerButton).toHaveBeenNthCalledWith(1, 'middle', true, 0.5, 0.5);
      expect(pointerButton).toHaveBeenNthCalledWith(2, 'middle', false, expect.any(Number), 0.5);
      expect(pointerButton.mock.calls[1]?.[2]).toBeCloseTo(0.75, 4);
      expect(pointerMove).toHaveBeenCalledWith(expect.any(Number), 0.5);
      expect(pointerMove.mock.calls[0]?.[0]).toBeCloseTo(0.75, 4);
      expect(key.mock.calls).toEqual([
        ['ControlLeft', 'Control', true, false, { control: true, alt: false }],
        ['ControlLeft', 'Control', false, false, { control: false, alt: false }],
      ]);
      expect(pointerButton).not.toHaveBeenCalledWith('left', true, expect.anything(), expect.anything());
    } finally {
      Object.defineProperty(navigator, 'platform', {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it('sends the real remote pointer and keeps a sticky target zone at every video edge', async () => {
    const { container, stage } = await renderPanel();
    pointerMove.mockClear();
    act(() => {
      mousePointer(stage, 'pointermove', {
        pointerId: 18, clientX: 4, clientY: 150,
      });
      mousePointer(stage, 'pointermove', {
        pointerId: 18, clientX: 396, clientY: 150,
      });
    });

    expect(pointerMove.mock.calls).toEqual([[0, 0.5], [1, 0.5]]);
    expect(container.querySelector('.remote-desktop-pointer-follow')).toBeNull();
    expect(getComputedStyle(stage).cursor).not.toBe('none');
  });

  it('acknowledges only a browser-presented decoded video frame', async () => {
    let presentedCallback: VideoFrameRequestCallback | undefined;
    const requestFrame = vi.fn((callback: VideoFrameRequestCallback) => {
      presentedCallback = callback;
      return 41;
    });
    const cancelFrame = vi.fn();
    Object.defineProperties(HTMLVideoElement.prototype, {
      requestVideoFrameCallback: { configurable: true, value: requestFrame },
      cancelVideoFrameCallback: { configurable: true, value: cancelFrame },
    });
    const rendered = await renderPanel();
    expect(requestFrame).toHaveBeenCalledTimes(1);
    act(() => presentedCallback?.(0, {} as VideoFrameCallbackMetadata));
    expect(acknowledgePresentedFrame).toHaveBeenCalledWith(1920, 1080);
    expect(requestFrame).toHaveBeenCalledTimes(2);
    rendered.unmount();
    expect(cancelFrame).toHaveBeenCalledWith(41);
    delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback;
    delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).cancelVideoFrameCallback;
  });

  it('releases all remote input when the panel loses browser focus', async () => {
    await renderPanel();
    act(() => window.dispatchEvent(new Event('blur')));
    expect(releaseAll).toHaveBeenCalledTimes(1);
  });

  it('uses drag/pinch for the local viewport and never sends an accidental click', async () => {
    const { stage, video } = await renderPanel();
    act(() => {
      pointer(stage, 'pointerdown', { pointerId: 1, clientX: 120, clientY: 150 });
      pointer(stage, 'pointerdown', { pointerId: 2, clientX: 280, clientY: 150 });
      pointer(stage, 'pointermove', { pointerId: 2, clientX: 360, clientY: 150 });
    });
    expect(video.style.transform).not.toContain('scale(1)');
    act(() => {
      pointer(stage, 'pointerup', { pointerId: 2, clientX: 360, clientY: 150 });
      pointer(stage, 'pointermove', { pointerId: 1, clientX: 180, clientY: 150 });
      pointer(stage, 'pointerup', { pointerId: 1, clientX: 180, clientY: 150 });
    });
    expect(pointerButton).not.toHaveBeenCalled();
  });

  it('maps a tap through the transformed video rect after mobile zoom', async () => {
    const { stage, video } = await renderPanel();
    act(() => {
      pointer(stage, 'pointerdown', { pointerId: 1, clientX: 120, clientY: 150 });
      pointer(stage, 'pointerdown', { pointerId: 2, clientX: 280, clientY: 150 });
      pointer(stage, 'pointermove', { pointerId: 2, clientX: 440, clientY: 150 });
      pointer(stage, 'pointerup', { pointerId: 2, clientX: 440, clientY: 150 });
      pointer(stage, 'pointerup', { pointerId: 1, clientX: 120, clientY: 150 });
    });
    expect(video.style.transform).toContain('scale(2)');
    // At 2x, the 400x300 element has this transformed client rect. The 16:9
    // video content occupies y=-75..375; this tap is source point 75%,25%.
    video.getBoundingClientRect = () => ({
      x: -200, y: -150, left: -200, top: -150, right: 600, bottom: 450,
      width: 800, height: 600, toJSON: () => ({}),
    });
    pointer(stage, 'pointerdown', { pointerId: 3, clientX: 400, clientY: 37.5 });
    pointer(stage, 'pointerup', { pointerId: 3, clientX: 400, clientY: 37.5 });
    expect(pointerButton).toHaveBeenNthCalledWith(1, 'left', true, 0.75, 0.25);
    expect(pointerButton).toHaveBeenNthCalledWith(2, 'left', false, 0.75, 0.25);
  });

  it('turns a long press into right-click and snaps a nearby double tap to one Windows target', async () => {
    const { stage } = await renderPanel();
    pointerButton.mockClear();
    vi.useFakeTimers();

    pointer(stage, 'pointerdown', { pointerId: 40, clientX: 200, clientY: 150 });
    act(() => { vi.advanceTimersByTime(550); });
    pointer(stage, 'pointerup', { pointerId: 40, clientX: 200, clientY: 150 });
    expect(pointerButton.mock.calls).toEqual([
      ['right', true, 0.5, 0.5],
      ['right', false, 0.5, 0.5],
    ]);

    pointerButton.mockClear();
    pointer(stage, 'pointerdown', { pointerId: 41, clientX: 200, clientY: 150 });
    pointer(stage, 'pointerup', { pointerId: 41, clientX: 200, clientY: 150 });
    act(() => { vi.advanceTimersByTime(180); });
    pointer(stage, 'pointerdown', { pointerId: 42, clientX: 218, clientY: 158 });
    pointer(stage, 'pointerup', { pointerId: 42, clientX: 218, clientY: 158 });
    expect(pointerButton.mock.calls).toEqual([
      ['left', true, 0.5, 0.5],
      ['left', false, 0.5, 0.5],
      ['left', true, 0.5, 0.5],
      ['left', false, 0.5, 0.5],
    ]);
  });

  it('offers a dedicated touch-mode right-click button at the last touch position', async () => {
    const { stage, getByRole } = await renderPanel();
    pointer(stage, 'pointerdown', { pointerId: 43, clientX: 300, clientY: 150 });
    pointer(stage, 'pointerup', { pointerId: 43, clientX: 300, clientY: 150 });
    pointerButton.mockClear();
    const rightClick = getByRole('button', { name: 'remote_desktop.touch_right_click' });
    pointer(rightClick, 'pointerdown', { pointerId: 44, clientX: 360, clientY: 260 });
    pointer(rightClick, 'pointerup', { pointerId: 44, clientX: 360, clientY: 260 });
    expect(pointerButton.mock.calls).toEqual([
      ['right', true, 0.75, 0.5],
      ['right', false, 0.75, 0.5],
    ]);
  });

  it('provides a readable auto-zoomed virtual mouse with buttons, wheel, and edge pan', async () => {
    const { container, stage, video, getByRole } = await renderPanel();
    act(() => {
      (getByRole('button', { name: 'remote_desktop.mouse_mode' }) as HTMLButtonElement).click();
    });
    expect(video.style.transform).toContain('scale(3.2)');

    for (const [name, button] of [
      ['remote_desktop.mouse_left', 'left'],
      ['remote_desktop.mouse_right', 'right'],
    ] as const) {
      const target = getByRole('button', { name });
      pointer(target, 'pointerdown', { pointerId: 10, clientX: 200, clientY: 150 });
      pointer(target, 'pointerup', { pointerId: 10, clientX: 200, clientY: 150 });
      expect(pointerButton).toHaveBeenCalledWith(button, true, 0.5, 0.5);
      expect(pointerButton).toHaveBeenCalledWith(button, false, 0.5, 0.5);
    }

    const wheelControl = getByRole('button', { name: 'remote_desktop.mouse_wheel' });
    act(() => {
      pointer(wheelControl, 'pointerdown', { pointerId: 20, clientX: 200, clientY: 220 });
      pointer(wheelControl, 'pointermove', { pointerId: 20, clientX: 200, clientY: 250 });
      pointer(wheelControl, 'pointerup', { pointerId: 20, clientX: 200, clientY: 250 });
    });
    expect(wheel).toHaveBeenCalledWith(0, 240, 0.5, 0.5);

    const handle = getByRole('button', { name: 'remote_desktop.mouse_drag' });
    act(() => {
      pointer(handle, 'pointerdown', { pointerId: 30, clientX: 200, clientY: 250 });
      pointer(handle, 'pointermove', { pointerId: 30, clientX: 400, clientY: 250 });
      pointer(handle, 'pointerup', { pointerId: 30, clientX: 400, clientY: 250 });
    });
    expect(pointerMove).toHaveBeenCalled();
    expect(pointerMove).toHaveBeenCalledWith(1, 0.5);
    expect(video.style.transform).toMatch(/translate3d\(-/);
    expect(container.querySelector('.remote-desktop-virtual-pointer')).not.toBeNull();
    expect(stage.textContent).toContain('remote_desktop.mouse_hint');
  });

  it('recomputes readable mouse zoom when the selected display changes resolution in place', async () => {
    const { video, getByRole } = await renderPanel();
    act(() => {
      (getByRole('button', { name: 'remote_desktop.mouse_mode' }) as HTMLButtonElement).click();
    });
    expect(video.style.transform).toContain('scale(3.2)');

    act(() => clientHooks[0]!.onSnapshot({
      state: REMOTE_DESKTOP_STATE.DIRECT,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      inputEnabled: true,
      route: 'direct',
      displays: [{
        id: 'display-primary', label: 'Display 1', primary: true, available: true,
        width: 3840, height: 2160, dpiScale: 2.25, rotation: 0,
      }],
      selectedDisplayId: 'display-primary',
      layoutRevision: 2,
      stream: null,
    }));

    expect(video.style.transform).toContain('scale(4)');
  });

  it('recomputes readable mouse zoom when the mobile viewport resizes', async () => {
    const { stage, video, getByRole } = await renderPanel();
    act(() => {
      (getByRole('button', { name: 'remote_desktop.mouse_mode' }) as HTMLButtonElement).click();
    });
    expect(video.style.transform).toContain('scale(3.2)');

    Object.defineProperties(stage, {
      clientWidth: { value: 800, configurable: true },
      clientHeight: { value: 300, configurable: true },
    });
    act(() => window.dispatchEvent(new Event('resize')));
    expect(video.style.transform).toContain('scale(2.4)');
  });

  it('bounds transient reconnects and creates a fresh-authority client', async () => {
    vi.useFakeTimers();
    const { container } = await renderPanel();
    expect(clientHooks).toHaveLength(1);
    act(() => clientHooks[0]!.onSnapshot({
      state: REMOTE_DESKTOP_STATE.FAILED,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      inputEnabled: false,
      displays: [],
      layoutRevision: 1,
      stream: null,
      terminalReason: REMOTE_DESKTOP_TERMINAL_REASON.PEER_FAILED,
    }));
    expect(container.textContent).toContain('remote_desktop.state.reconnecting');
    // The closing client may publish another terminal snapshot after the retry
    // timer was armed. It must not replace the recovery UI with worker_failed.
    act(() => clientHooks[0]!.onSnapshot({
      state: REMOTE_DESKTOP_STATE.FAILED,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      inputEnabled: false,
      displays: [],
      layoutRevision: 1,
      stream: null,
      terminalReason: REMOTE_DESKTOP_TERMINAL_REASON.WORKER_FAILED,
    }));
    expect(container.textContent).toContain('remote_desktop.state.reconnecting');
    expect(container.textContent).not.toContain('remote_desktop.failed');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        REMOTE_DESKTOP_LIMITS.RECONNECT_BACKOFF_BASE_MS - 1,
      );
    });
    expect(clientHooks).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(clientHooks).toHaveLength(2);
  });

  it('renews the bounded retry budget after a stable recovered connection', async () => {
    vi.useFakeTimers();
    const { container } = await renderPanel();
    const failed = {
      state: REMOTE_DESKTOP_STATE.FAILED,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      inputEnabled: false,
      displays: [],
      layoutRevision: 1,
      stream: null,
      terminalReason: REMOTE_DESKTOP_TERMINAL_REASON.PEER_FAILED,
    };
    act(() => clientHooks[0]!.onSnapshot(failed));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_DESKTOP_LIMITS.RECONNECT_BACKOFF_BASE_MS);
    });
    expect(clientHooks).toHaveLength(2);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_DESKTOP_LIMITS.RECONNECT_STABILITY_RESET_MS);
    });
    expect(container.textContent).toContain('remote_desktop.reconnects');
    act(() => clientHooks[1]!.onSnapshot(failed));
    expect(container.textContent).toContain('remote_desktop.state.reconnecting');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_DESKTOP_LIMITS.RECONNECT_BACKOFF_BASE_MS);
    });
    expect(clientHooks).toHaveLength(3);
  });

  it('stops retrying after the bounded budget for one continuous outage', async () => {
    vi.useFakeTimers();
    const { container, getByRole } = await renderPanel();
    const failed = {
      state: REMOTE_DESKTOP_STATE.FAILED,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      inputEnabled: false,
      displays: [],
      layoutRevision: 1,
      stream: null,
      terminalReason: REMOTE_DESKTOP_TERMINAL_REASON.PEER_FAILED,
    };

    for (let attempt = 0; attempt < REMOTE_DESKTOP_LIMITS.MAX_RECONNECT_ATTEMPTS; attempt++) {
      act(() => clientHooks[attempt]!.onSnapshot(failed));
      expect(container.textContent).toContain('remote_desktop.state.reconnecting');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          REMOTE_DESKTOP_LIMITS.RECONNECT_BACKOFF_BASE_MS * (2 ** attempt),
        );
      });
      expect(clientHooks).toHaveLength(attempt + 2);
    }

    act(() => clientHooks[REMOTE_DESKTOP_LIMITS.MAX_RECONNECT_ATTEMPTS]!
      .onSnapshot(failed));
    expect(container.textContent).toContain('remote_desktop.failed');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        REMOTE_DESKTOP_LIMITS.RECONNECT_BACKOFF_BASE_MS
          * (2 ** REMOTE_DESKTOP_LIMITS.MAX_RECONNECT_ATTEMPTS),
      );
    });
    expect(clientHooks).toHaveLength(REMOTE_DESKTOP_LIMITS.MAX_RECONNECT_ATTEMPTS + 1);

    act(() => {
      (getByRole('button', { name: 'remote_desktop.retry' }) as HTMLButtonElement).click();
    });
    expect(clientHooks).toHaveLength(REMOTE_DESKTOP_LIMITS.MAX_RECONNECT_ATTEMPTS + 2);
    expect(clientStarts.at(-1)).toBe(1);
    expect(container.textContent).toContain('remote_desktop.state.reconnecting');
  });

  it('treats a local-user Stop as terminal instead of reconnecting', async () => {
    vi.useFakeTimers();
    const { container } = await renderPanel();
    expect(clientHooks).toHaveLength(1);
    act(() => clientHooks[0]!.onSnapshot({
      state: REMOTE_DESKTOP_STATE.FAILED,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      inputEnabled: false,
      displays: [],
      layoutRevision: 1,
      stream: null,
      terminalReason: REMOTE_DESKTOP_TERMINAL_REASON.STOPPED_BY_LOCAL_USER,
    }));
    expect(container.textContent).toContain('remote_desktop.failed');
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(clientHooks).toHaveLength(1);
  });
});
