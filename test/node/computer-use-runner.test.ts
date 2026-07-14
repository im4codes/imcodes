import { describe, expect, it } from 'vitest';
import { openComputerUseCallArgs, openComputerUseEnv } from '../../src/node/computer-use-runner.js';

describe('computer use runner open-computer-use CLI', () => {
  it('uses the supported JSON argument form without unsupported timeout flags', () => {
    expect(openComputerUseCallArgs('list_apps', '{}')).toEqual(['call', 'list_apps', '--args', '{}']);
  });

  it('preflights GUI actions in one process so element indexes are valid', () => {
    expect(openComputerUseCallArgs('set_value', '{"app":"msedge","element_index":"18","value":"about:blank"}')).toEqual([
      'call',
      '--calls',
      JSON.stringify([
        { tool: 'get_app_state', args: { app: 'msedge', text_limit: 1_000, max_tree_nodes: 1_500, max_tree_depth: 80 } },
        { tool: 'set_value', args: { app: 'msedge', element_index: '18', value: 'about:blank' } },
      ]),
    ]);
  });

  it('enables the Windows text fallback only for type_text on Windows', () => {
    expect(openComputerUseEnv('type_text', { PATH: 'x' }, 'win32')).toMatchObject({
      PATH: 'x',
      OPEN_COMPUTER_USE_WINDOWS_ALLOW_UIA_TEXT_FALLBACK: '1',
    });
    expect(openComputerUseEnv('click', { PATH: 'x' }, 'win32')).toBeUndefined();
    expect(openComputerUseEnv('type_text', { PATH: 'x' }, 'darwin')).toBeUndefined();
  });
});
