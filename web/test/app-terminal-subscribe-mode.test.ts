import { describe, expect, it } from 'vitest';

import { shouldSubscribeTerminalRaw } from '../src/terminal-subscribe-mode.js';

describe('shouldSubscribeTerminalRaw', () => {
  it('keeps passive surfaces non-raw', () => {
    expect(shouldSubscribeTerminalRaw(false, 'chat')).toBe(false);
    expect(shouldSubscribeTerminalRaw(false, 'terminal')).toBe(false);
  });

  it('keeps active chat surfaces non-raw', () => {
    expect(shouldSubscribeTerminalRaw(true, 'chat')).toBe(false);
  });

  it('enables raw only for active terminal surfaces', () => {
    expect(shouldSubscribeTerminalRaw(true, 'terminal')).toBe(true);
  });
});
