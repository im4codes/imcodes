import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  browserExecutableCandidatesForTest,
  browserAutomationEndpointForTest,
  browserLaunchArgsForTest,
  browserSnapshotPayloadForTest,
  captureBrowserViewportForTest,
  isFastWindowsCoordinatePointerActionForTest,
  normalizeBrowserUserAgent,
  normalizeComputerUseErrorForTest,
  normalizeOpenComputerUseParsedResult,
  openComputerUseCallArgs,
  openComputerUseCandidateBinariesForTest,
  openComputerUseEnv,
  resolveOpenComputerUseBinaryForCurrentProcessForTest,
  resolveOpenComputerUseBinaryForTest,
  selectOpenComputerUseBinaryForTest,
  verifyOpenComputerUseBinaryForLaunchForTest,
} from '../../src/node/computer-use-runner.js';

describe('computer use runner open-computer-use CLI', () => {
  it('uses the supported JSON argument form without unsupported timeout flags', () => {
    expect(openComputerUseCallArgs('list_apps', '{}')).toEqual(['call', 'list_apps', '--args', '{}']);
  });

  it('preflights coordinate GUI actions but does not forward internal return options', () => {
    expect(openComputerUseCallArgs('click', '{"app":"explorer","x":225,"y":385,"clicks":2,"includeImage":true,"includeState":true,"imageQuality":40}')).toEqual([
      'call',
      '--calls',
      JSON.stringify([
        { tool: 'get_app_state', args: { app: 'explorer', text_limit: 1_000, max_tree_nodes: 1_500, max_tree_depth: 80 } },
        { tool: 'click', args: { app: 'explorer', x: 225, y: 385, clicks: 2 } },
      ]),
    ]);
  });

  it('keeps drag duration internal to the Windows pointer wrapper', () => {
    expect(openComputerUseCallArgs('drag', '{"app":"explorer","from_x":10,"from_y":20,"to_x":30,"to_y":40,"duration_ms":4000}')).toEqual([
      'call',
      '--calls',
      JSON.stringify([
        { tool: 'get_app_state', args: { app: 'explorer', text_limit: 1_000, max_tree_nodes: 1_500, max_tree_depth: 80 } },
        { tool: 'drag', args: { app: 'explorer', from_x: 10, from_y: 20, to_x: 30, to_y: 40 } },
      ]),
    ]);
  });

  it('preflights element-index GUI actions in one process so element indexes are valid', () => {
    expect(openComputerUseCallArgs('set_value', '{"app":"msedge","element_index":"18","value":"about:blank"}')).toEqual([
      'call',
      '--calls',
      JSON.stringify([
        { tool: 'get_app_state', args: { app: 'msedge', text_limit: 1_000, max_tree_nodes: 1_500, max_tree_depth: 80 } },
        { tool: 'set_value', args: { app: 'msedge', element_index: '18', value: 'about:blank' } },
      ]),
    ]);
  });


  it('omits action state and image content by default while keeping a concise success result', async () => {
    const result = await normalizeOpenComputerUseParsedResult('click', { app: 'chrome', x: 1, y: 2 }, {
      content: [
        { type: 'text', text: 'App=chrome\\nvery large accessibility tree' },
        { type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png' },
      ],
    });
    expect(result).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: 'click completed' }],
    });
  });

  it('returns action state only when explicitly requested', async () => {
    const result = await normalizeOpenComputerUseParsedResult('click', { app: 'chrome', x: 1, y: 2, includeState: true }, {
      content: [{ type: 'text', text: 'App=chrome\\nstate tree' }],
    });
    expect(result).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: 'App=chrome\\nstate tree' }],
    });
  });



  it('searches packaged daemon and sidecar helper locations before PATH fallback', () => {
    const previousExe = process.env.IMCODES_COMPUTER_USE_EXE;
    const previousDir = process.env.IMCODES_COMPUTER_USE_HELPER_DIR;
    delete process.env.IMCODES_COMPUTER_USE_EXE;
    const fakeHelperDir = resolve('/tmp/imcodes-helper-env');
    process.env.IMCODES_COMPUTER_USE_HELPER_DIR = fakeHelperDir;
    try {
      const fakeModulePath = resolve('/tmp/imcodes-fixture/dist/src/node/computer-use-runner.js');
      const fakeDistRoot = resolve('/tmp/imcodes-fixture/dist');
      const candidates = openComputerUseCandidateBinariesForTest(fakeModulePath);
      expect(candidates[0]).toContain(fakeHelperDir);
      expect(candidates.some((candidate) => candidate.startsWith(resolve(fakeDistRoot, 'computer-use-helper')))).toBe(true);
      expect(candidates.some((candidate) => candidate === 'open-computer-use' || candidate === 'open-computer-use.exe')).toBe(true);
    } finally {
      if (previousExe === undefined) delete process.env.IMCODES_COMPUTER_USE_EXE;
      else process.env.IMCODES_COMPUTER_USE_EXE = previousExe;
      if (previousDir === undefined) delete process.env.IMCODES_COMPUTER_USE_HELPER_DIR;
      else process.env.IMCODES_COMPUTER_USE_HELPER_DIR = previousDir;
    }
  });

  it('resolves the signed packaged macOS app from the module layout when PATH has no helper', async () => {
    const packaged = resolve('/tmp/imcodes-fixture/dist/computer-use-helper/darwin-arm64/Open Computer Use.app/Contents/MacOS/OpenComputerUse');
    const verify = vi.fn(async (candidate: string) => candidate === packaged);

    await expect(resolveOpenComputerUseBinaryForTest({
      platform: 'darwin',
      arch: 'arm64',
      moduleFilePath: resolve('/tmp/imcodes-fixture/dist/src/node/computer-use-runner.js'),
      entryFilePath: resolve('/tmp/unrelated/imcodes'),
      env: { PATH: '/usr/bin:/bin' },
      cwd: '/tmp/unrelated',
      fileExists: async (candidate) => candidate === packaged,
      verifyTrustedArtifact: verify,
    })).resolves.toBe(packaged);
    expect(verify).toHaveBeenCalledWith(packaged);
  });

  it('wires the running module location into production resolution instead of relying on cwd or PATH', async () => {
    const packaged = resolve('dist/computer-use-helper/darwin-arm64/Open Computer Use.app/Contents/MacOS/OpenComputerUse');
    const exists = vi.fn(async (candidate: string) => candidate === packaged);
    const verify = vi.fn(async (candidate: string) => exists(candidate));

    const selected = await resolveOpenComputerUseBinaryForCurrentProcessForTest({
      platform: 'darwin',
      arch: 'arm64',
      entryFilePath: '/tmp/unrelated/imcodes',
      env: { PATH: '/usr/bin:/bin' },
      cwd: '/tmp/unrelated',
      fileExists: exists,
      verifyTrustedArtifact: verify,
    });
    expect(selected).toBe(packaged);
  });

  it('uses the verified persistent macOS runtime after restart without PATH fallback', async () => {
    const runtime = '/Library/Application Support/imcodes-node-computer-use/Open Computer Use.app/Contents/MacOS/OpenComputerUse';
    const verify = vi.fn(async (candidate: string) => candidate === runtime);
    const options = {
      platform: 'darwin' as const,
      arch: 'arm64',
      moduleFilePath: resolve('/tmp/missing/dist/src/node/computer-use-runner.js'),
      entryFilePath: resolve('/tmp/missing/imcodes'),
      env: { PATH: '/usr/bin:/bin' },
      cwd: '/tmp/missing',
      fileExists: async (candidate: string) => candidate === runtime,
      verifyTrustedArtifact: verify,
    };

    await expect(resolveOpenComputerUseBinaryForTest(options)).resolves.toBe(runtime);
    await expect(resolveOpenComputerUseBinaryForTest(options)).resolves.toBe(runtime);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('fails with a typed actionable macOS error when packaged candidates are missing or corrupt', async () => {
    const app = resolve('/tmp/imcodes-fixture/dist/computer-use-helper/darwin-arm64/Open Computer Use.app/Contents/MacOS/OpenComputerUse');
    const base = {
      platform: 'darwin' as const,
      arch: 'arm64',
      moduleFilePath: resolve('/tmp/imcodes-fixture/dist/src/node/computer-use-runner.js'),
      entryFilePath: resolve('/tmp/unrelated/imcodes'),
      env: { PATH: '/usr/bin:/bin' },
      cwd: '/tmp/unrelated',
    };
    await expect(resolveOpenComputerUseBinaryForTest({
      ...base,
      fileExists: async () => false,
      verifyTrustedArtifact: async () => true,
    })).rejects.toThrow('signed_macos_open_computer_use_helper_unavailable');
    await expect(resolveOpenComputerUseBinaryForTest({
      ...base,
      fileExists: async (candidate) => candidate === app,
      verifyTrustedArtifact: async () => false,
    })).rejects.toThrow('signed_macos_open_computer_use_helper_unavailable');
  });

  it('re-verifies the selected macOS app at every helper process start', async () => {
    const binary = '/signed/Open Computer Use.app/Contents/MacOS/OpenComputerUse';
    const verify = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('signature changed'));

    await expect(verifyOpenComputerUseBinaryForLaunchForTest(binary, 'darwin', verify))
      .resolves.toBeUndefined();
    await expect(verifyOpenComputerUseBinaryForLaunchForTest(binary, 'darwin', verify))
      .rejects.toThrow('signature changed');
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('production Windows selection rejects PATH and unsigned helpers before choosing the anchored candidate', async () => {
    const exists = vi.fn(async (path: string) => path !== 'C:\\missing.exe');
    const verify = vi.fn(async (path: string) => path === 'C:\\signed.exe');
    await expect(selectOpenComputerUseBinaryForTest([
      'open-computer-use.exe',
      'C:\\missing.exe',
      'C:\\tampered.exe',
      'C:\\signed.exe',
    ], {
      requireReleaseSignature: true,
      fileExists: exists,
      verifySignature: verify,
    })).resolves.toBe('C:\\signed.exe');
    expect(verify).toHaveBeenCalledWith('C:\\tampered.exe');
    expect(verify).toHaveBeenCalledWith('C:\\signed.exe');
    expect(verify).not.toHaveBeenCalledWith('open-computer-use.exe');
  });

  it('production Windows selection fails closed when no helper has the release signer', async () => {
    await expect(selectOpenComputerUseBinaryForTest(['C:\\tampered.exe', 'open-computer-use.exe'], {
      requireReleaseSignature: true,
      fileExists: async () => true,
      verifySignature: async () => false,
    })).rejects.toThrow('signed_open_computer_use_helper_unavailable');
  });

  it('enables the Windows text fallback only for type_text on Windows', () => {
    expect(openComputerUseEnv('type_text', { PATH: 'x' }, 'win32')).toMatchObject({
      PATH: 'x',
      OPEN_COMPUTER_USE_WINDOWS_ALLOW_UIA_TEXT_FALLBACK: '1',
    });
    expect(openComputerUseEnv('click', { PATH: 'x' }, 'win32')).toBeUndefined();
    expect(openComputerUseEnv('type_text', { PATH: 'x' }, 'darwin')).toBeUndefined();
  });

  it('turns the typed macOS helper failure into an actionable unavailable state', () => {
    expect(normalizeComputerUseErrorForTest(
      'list_apps',
      'signed_macos_open_computer_use_helper_unavailable',
      'darwin',
    ).error).toContain('signed Open Computer Use app is unavailable');
  });

  it('makes Windows fast coordinate pointer actions per-monitor DPI-aware before geometry calls', () => {
    const source = readFileSync('src/node/computer-use-runner.ts', 'utf8');
    const setAwareness = source.indexOf('[void][ImcodesFastPointer]::SetProcessDpiAwareness(2)');
    const ready = source.indexOf('[Console]::Out.WriteLine(\'{"ready":true}\')');
    const windowRectUse = source.indexOf('[ImcodesFastPointer]::GetWindowRect($p.MainWindowHandle');

    expect(source).toContain('[DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int awareness);');
    expect(setAwareness).toBeGreaterThan(-1);
    expect(setAwareness).toBeLessThan(ready);
    expect(setAwareness).toBeLessThan(windowRectUse);
    expect(source).toContain("action: 'drag'");
    expect(source).toContain("if ([string]$payload.action -eq 'drag')");
    expect(source).toContain('[ImcodesFastPointer]::SetCursorPos($x, $y)');
    expect(source).toContain('[ImcodesFastPointer]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)');
    expect(source).toContain('$stepDelayMs = [int][Math]::Max(1, [Math]::Round($durationMs / $steps))');
    expect(isFastWindowsCoordinatePointerActionForTest('drag', {
      app: 'TabFlow64',
      from_x: 500,
      from_y: 437,
      to_x: 500,
      to_y: 395,
      duration_ms: 4000,
    }, 'win32')).toBe(true);
    expect(isFastWindowsCoordinatePointerActionForTest('drag', {
      app: 'TabFlow64',
      from_x: 500,
      from_y: 437,
      to_x: 500,
      to_y: 395,
      includeState: true,
    }, 'win32')).toBe(true);
  });

  it('selects browser executables across Windows, macOS, and Linux with channel filtering', () => {
    expect(browserExecutableCandidatesForTest({}, 'win32').join('\n')).toContain('msedge.exe');
    expect(browserExecutableCandidatesForTest({}, 'darwin').join('\n')).toContain('Google Chrome.app');
    expect(browserExecutableCandidatesForTest({}, 'linux')).toEqual(expect.arrayContaining(['google-chrome', 'chromium', 'microsoft-edge']));
    expect(browserExecutableCandidatesForTest({ channel: 'chromium' }, 'linux')).toEqual(expect.arrayContaining(['chromium-browser', 'chromium']));
    expect(browserExecutableCandidatesForTest({ channel: 'chromium' }, 'linux')).not.toContain('google-chrome');
  });

  it('turns a missing browser executable into an actionable install prompt without mentioning OCU', () => {
    const result = normalizeComputerUseErrorForTest('browser_open', 'browser_executable_not_found', 'linux');
    expect(result).toEqual({
      error: 'No supported browser is installed on this machine. Install Google Chrome, Chromium, or Microsoft Edge, then retry the browser request.',
      truncated: false,
    });
    expect(result.error).not.toMatch(/OCU|Open Computer Use|AT-SPI/i);
  });

  it('hides Linux AT-SPI tracebacks behind a desktop-specific prerequisite message', () => {
    const result = normalizeComputerUseErrorForTest(
      'list_apps',
      'Linux runtime failed:\nTraceback...\nValueError: Namespace Atspi not available',
      'linux',
    );
    expect(result.error).toContain('Desktop app control is unavailable');
    expect(result.error).toContain('Browser automation is separate');
    expect(result.error).toContain('install Google Chrome, Chromium, or Microsoft Edge');
    expect(result.error).not.toContain('Traceback');
  });

  it('uses Linux-safe headless browser launch defaults without forcing headless on desktop platforms', () => {
    expect(browserLaunchArgsForTest('/tmp/profile', {}, 'linux', {})).toEqual(expect.arrayContaining([
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ]));
    expect(browserLaunchArgsForTest('/tmp/profile', { noSandbox: false }, 'linux', {})).not.toContain('--no-sandbox');
    expect(browserLaunchArgsForTest('/tmp/profile', {}, 'darwin', {})).not.toContain('--headless=new');
    expect(browserLaunchArgsForTest('/tmp/profile', { headless: true }, 'win32', {})).toContain('--headless=new');
  });

  it('pins the CDP port instead of relying on the DevToolsActivePort handshake', () => {
    // `--remote-debugging-port=0` reports the chosen port ONLY through
    // `<user-data-dir>/DevToolsActivePort`, which a confined browser (snap,
    // flatpak, container) writes into its own private /tmp namespace — the
    // launcher then polls a host path that never appears. Pinning a real port
    // removes that dependency, so the arg must never be 0 again.
    const args = browserLaunchArgsForTest('/tmp/profile', {}, 'linux', {}, 45123);
    expect(args).toContain('--remote-debugging-port=45123');
    expect(args).toContain('--remote-debugging-address=127.0.0.1');
    expect(args).not.toContain('--remote-debugging-port=0');
  });

  it('publishes a loopback CDP endpoint that external scripts can reuse', () => {
    expect(browserAutomationEndpointForTest('http://127.0.0.1:45123')).toEqual({
      cdpEndpoint: 'http://127.0.0.1:45123',
      cdpHost: '127.0.0.1',
      cdpPort: 45123,
    });
    expect(browserAutomationEndpointForTest(null)).toBeUndefined();
    expect(browserAutomationEndpointForTest('http://127.0.0.1')).toBeUndefined();
    expect(browserSnapshotPayloadForTest(
      { url: 'https://example.com', title: 'Example' },
      'http://127.0.0.1:45123',
    )).toEqual({
      url: 'https://example.com',
      title: 'Example',
      automation: {
        cdpEndpoint: 'http://127.0.0.1:45123',
        cdpHost: '127.0.0.1',
        cdpPort: 45123,
      },
    });
  });

  it('captures a bounded model-visible browser viewport image when requested', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { pageX: 2, pageY: 3, clientWidth: 1600, clientHeight: 900 } };
      }
      if (method === 'Page.captureScreenshot') return { data: 'aW1hZ2U=' };
      throw new Error(`unexpected method: ${method}`);
    });

    await expect(captureBrowserViewportForTest({ call }, { includeImage: true }, 5_000)).resolves.toEqual({
      item: { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/jpeg' },
      truncated: false,
    });
    expect(call).toHaveBeenNthCalledWith(2, 'Page.captureScreenshot', expect.objectContaining({
      format: 'jpeg',
      quality: 60,
      captureBeyondViewport: false,
      clip: { x: 2, y: 3, width: 1600, height: 900, scale: 0.8 },
    }), 5_000);
  });

  it('keeps browser screenshots disabled by default', async () => {
    const call = vi.fn();
    await expect(captureBrowserViewportForTest({ call }, {})).resolves.toEqual({ truncated: false });
    expect(call).not.toHaveBeenCalled();
  });

  it('drops the navigator.webdriver automation tell on every platform', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(browserLaunchArgsForTest('/tmp/profile', {}, platform, {}, 1234))
        .toContain('--disable-blink-features=AutomationControlled');
    }
  });

  it('pins an explicit user agent at launch, normalized, so no target can miss it', () => {
    // Known before launch => set at the process level, where it covers every
    // target/request from the first byte (a CDP override is per-session only).
    expect(browserLaunchArgsForTest('/tmp/profile', { userAgent: 'Custom/1.0' }, 'linux', {}, 1))
      .toContain('--user-agent=Custom/1.0');
    // A caller-supplied headless UA must NOT be able to reintroduce the tell.
    expect(browserLaunchArgsForTest('/tmp/profile', { userAgent: 'HeadlessChrome/150.0.0.0' }, 'linux', {}, 1))
      .toContain('--user-agent=Chrome/150.0.0.0');
    // Without an explicit UA the launch stays clean; the normalized browser UA
    // is applied over CDP once the real version is known.
    expect(browserLaunchArgsForTest('/tmp/profile', {}, 'linux', {}, 1).join(' ')).not.toContain('--user-agent=');
  });
});

describe('computer use runner browser user agent', () => {
  it('rewrites the HeadlessChrome automation tell while keeping the real version', () => {
    expect(normalizeBrowserUserAgent(
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/150.0.0.0 Safari/537.36',
    )).toBe(
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    );
    // The version must survive verbatim — a hardcoded UA would go stale on upgrade.
    expect(normalizeBrowserUserAgent('HeadlessChrome/151.2.3.4')).toBe('Chrome/151.2.3.4');
  });

  it('leaves an already-normal user agent untouched', () => {
    const normal = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
    expect(normalizeBrowserUserAgent(normal)).toBe(normal);
    expect(normalizeBrowserUserAgent('')).toBe('');
  });
});
