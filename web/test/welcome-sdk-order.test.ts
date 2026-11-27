import { describe, expect, it } from 'vitest';
import {
  WELCOME_FALLBACK_PROVIDER_ID,
  WELCOME_SDK_PROBE_ORDER,
} from '@shared/welcome-sdk-order.js';
import { getSessionAgentGroups } from '../src/components/session-agent-options.js';

describe('welcome-sdk-order UI alignment', () => {
  it('matches the exact visible New Session dialog transport SDK order (excluding OpenCode fallback and OpenClaw)', () => {
    const transportGroup = getSessionAgentGroups('new-session').find((group) => group.id === 'transport');
    expect(transportGroup).toBeDefined();

    const uiSdkOrder = transportGroup!.items
      .filter((item) => !item.hidden && item.id !== WELCOME_FALLBACK_PROVIDER_ID && item.id !== 'openclaw')
      .map((item) => item.id);

    expect([...WELCOME_SDK_PROBE_ORDER]).toEqual(uiSdkOrder);
    expect(WELCOME_SDK_PROBE_ORDER).not.toContain(WELCOME_FALLBACK_PROVIDER_ID);
    expect(WELCOME_SDK_PROBE_ORDER).not.toContain('openclaw');
  });
});
