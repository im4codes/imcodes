import { describe, expect, it } from 'vitest';
import { terminalInputNeedsSessionMutex } from '../../src/daemon/terminal-input.js';
import { shouldReportBootstrapStall } from '../../src/daemon/terminal-streamer.js';

describe('Windows terminal input/readiness guards', () => {
  it('does not serialize ConPTY keystrokes behind the process mutex', () => {
    expect(terminalInputNeedsSessionMutex('conpty')).toBe(false);
    expect(terminalInputNeedsSessionMutex('tmux')).toBe(true);
    expect(terminalInputNeedsSessionMutex('wezterm')).toBe(true);
  });

  it('does not report a bootstrap stall for a live ConPTY', () => {
    expect(shouldReportBootstrapStall('conpty', true)).toBe(false);
    expect(shouldReportBootstrapStall('conpty', false)).toBe(true);
    expect(shouldReportBootstrapStall('tmux', true)).toBe(true);
  });
});
