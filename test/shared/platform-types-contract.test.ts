import { describe, it, expectTypeOf } from 'vitest';
import type {
  BotConfig,
  InboundMessage,
  OutboundMessage,
  PlatformCapabilities,
  PlatformHandler,
} from '../../src/shared/platform/types.js';
import type * as ServerTypes from '../../server/src/platform/types.js';
import type * as WorkerTypes from '../../worker/src/platform/types.js';

describe('shared platform type contract', () => {
  it('server re-exports match shared types', () => {
    expectTypeOf<ServerTypes.BotConfig>().toEqualTypeOf<BotConfig>();
    expectTypeOf<ServerTypes.InboundMessage>().toEqualTypeOf<InboundMessage>();
    expectTypeOf<ServerTypes.OutboundMessage>().toEqualTypeOf<OutboundMessage>();
    expectTypeOf<ServerTypes.PlatformCapabilities>().toEqualTypeOf<PlatformCapabilities>();
    expectTypeOf<ServerTypes.PlatformHandler>().toEqualTypeOf<PlatformHandler>();
  });

  it('worker re-exports match shared types', () => {
    expectTypeOf<WorkerTypes.BotConfig>().toEqualTypeOf<BotConfig>();
    expectTypeOf<WorkerTypes.InboundMessage>().toEqualTypeOf<InboundMessage>();
    expectTypeOf<WorkerTypes.OutboundMessage>().toEqualTypeOf<OutboundMessage>();
    expectTypeOf<WorkerTypes.PlatformCapabilities>().toEqualTypeOf<PlatformCapabilities>();
    expectTypeOf<WorkerTypes.PlatformHandler>().toEqualTypeOf<PlatformHandler>();
  });
});
