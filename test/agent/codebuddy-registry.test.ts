import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODEBUDDY_PROVIDER_IDS } from '../../shared/codebuddy.js';

const { connect, disconnect } = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
}));

vi.mock('../../src/daemon/transport-relay.js', () => ({
  wireProviderToRelay: vi.fn(),
  broadcastProviderStatus: vi.fn(),
}));

function fakeProvider(id: string) {
  return {
    id,
    connectionMode: 'local-sdk' as const,
    sessionOwnership: 'shared' as const,
    capabilities: {
      streaming: true,
      toolCalling: true,
      approval: true,
      sessionRestore: true,
      multiTurn: true,
      attachments: false,
    },
    connect,
    disconnect,
    send: vi.fn(async () => {}),
    onDelta: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
    createSession: vi.fn(async () => 'route'),
    endSession: vi.fn(async () => {}),
  };
}

vi.mock('../../src/agent/providers/codebuddy.js', () => ({
  CodeBuddyChinaProvider: vi.fn(function CodeBuddyChinaProvider() {
    return fakeProvider(CODEBUDDY_PROVIDER_IDS.CHINA);
  }),
  CodeBuddyInternationalProvider: vi.fn(function CodeBuddyInternationalProvider() {
    return fakeProvider(CODEBUDDY_PROVIDER_IDS.INTERNATIONAL);
  }),
}));

import {
  connectProvider,
  disconnectAll,
  getProvider,
} from '../../src/agent/provider-registry.js';

afterEach(async () => {
  await disconnectAll();
  vi.clearAllMocks();
});

describe('CodeBuddy provider registry', () => {
  it.each([
    CODEBUDDY_PROVIDER_IDS.CHINA,
    CODEBUDDY_PROVIDER_IDS.INTERNATIONAL,
  ])('constructs and registers %s independently', async (providerId) => {
    await connectProvider(providerId, {});
    expect(getProvider(providerId)?.id).toBe(providerId);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
