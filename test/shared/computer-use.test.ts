import { describe, expect, it } from 'vitest';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import { validateComputerUseResultFrame } from '../../shared/computer-use.js';

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
});
