import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  browserExecutableCandidatesForTest,
  browserLaunchArgsForTest,
  normalizeOpenComputerUseParsedResult,
  openComputerUseCallArgs,
  openComputerUseCandidateBinariesForTest,
  openComputerUseEnv,
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

  it('enables the Windows text fallback only for type_text on Windows', () => {
    expect(openComputerUseEnv('type_text', { PATH: 'x' }, 'win32')).toMatchObject({
      PATH: 'x',
      OPEN_COMPUTER_USE_WINDOWS_ALLOW_UIA_TEXT_FALLBACK: '1',
    });
    expect(openComputerUseEnv('click', { PATH: 'x' }, 'win32')).toBeUndefined();
    expect(openComputerUseEnv('type_text', { PATH: 'x' }, 'darwin')).toBeUndefined();
  });

  it('selects browser executables across Windows, macOS, and Linux with channel filtering', () => {
    expect(browserExecutableCandidatesForTest({}, 'win32').join('\n')).toContain('msedge.exe');
    expect(browserExecutableCandidatesForTest({}, 'darwin').join('\n')).toContain('Google Chrome.app');
    expect(browserExecutableCandidatesForTest({}, 'linux')).toEqual(expect.arrayContaining(['google-chrome', 'chromium', 'microsoft-edge']));
    expect(browserExecutableCandidatesForTest({ channel: 'chromium' }, 'linux')).toEqual(expect.arrayContaining(['chromium-browser', 'chromium']));
    expect(browserExecutableCandidatesForTest({ channel: 'chromium' }, 'linux')).not.toContain('google-chrome');
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
});
