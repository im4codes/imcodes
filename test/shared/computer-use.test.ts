import { describe, expect, it } from 'vitest';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import { COMPUTER_USE_DOC_TOPICS, COMPUTER_USE_TOOLS, computerUseDocs, validateComputerUseResultFrame } from '../../shared/computer-use.js';

describe('computer use protocol', () => {
  it.each(['image/png', 'image/jpeg', 'image/webp'] as const)('accepts compressed %s image content', (mimeType) => {
    expect(validateComputerUseResultFrame({
      type: DAEMON_MSG.COMPUTER_USE_RESULT,
      correlationId: 'corr-12345678',
      ok: true,
      tool: 'get_app_state',
      content: [{ type: 'image', data: 'ZmFrZQ==', mimeType }],
      durationMs: 1,
    })).toMatchObject({ ok: true });
  });

  it('exposes Browser Use docs only as an on-demand Computer Use doc topic', () => {
    expect(COMPUTER_USE_DOC_TOPICS).toContain('browser');
    expect(COMPUTER_USE_TOOLS).toEqual(expect.arrayContaining([
      'browser_open',
      'browser_snapshot',
      'browser_click',
      'browser_fill',
      'browser_evaluate',
    ]));
    expect(computerUseDocs('browser')).toContain('Chrome DevTools Protocol');
  });
});
