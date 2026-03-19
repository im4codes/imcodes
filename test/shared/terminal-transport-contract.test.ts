import { describe, it, expectTypeOf } from 'vitest';
import type { TerminalDiff as SharedTerminalDiff } from '../../src/shared/transport/terminal.js';
import type { TerminalDiff as WebTerminalDiff } from '../../web/src/types.js';
import type { TerminalDiff as DaemonTerminalDiff } from '../../src/daemon/terminal-streamer.js';

describe('shared terminal transport contract', () => {
  it('web TerminalDiff matches shared contract', () => {
    expectTypeOf<WebTerminalDiff>().toEqualTypeOf<SharedTerminalDiff>();
  });

  it('daemon TerminalDiff matches shared contract', () => {
    expectTypeOf<DaemonTerminalDiff>().toEqualTypeOf<SharedTerminalDiff>();
  });
});
