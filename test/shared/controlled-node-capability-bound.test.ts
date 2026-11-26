import { describe, expect, it } from 'vitest';
import {
  CONTROLLED_NODE_ADVERTISED_MAX_ITEMS_FOR_OLDER_SERVERS,
  CONTROLLED_NODE_CAPABILITIES,
  CONTROLLED_NODE_CAPABILITY_MAX_ITEMS,
  parseAdvertisedControlledNodeCapabilities,
} from '../../shared/controlled-node-capabilities.js';

// A controlled node sends its capability list in the auth frame. A server that
// predates CONTROLLED_NODE_CAPABILITY_MAX_ITEMS = 40 enforced 32 and answered a
// longer list by closing the connection (`invalid_capabilities`, code 4002): the
// node could not connect at all until that server was upgraded. The registry is
// longer than any one node's advertisement because it lists every platform's
// entries (Windows, macOS and Linux each have their own), so the bound that
// matters is per platform.
const OTHER_PLATFORMS: Record<string, string[]> = {
  windows: ['.macos.', '.linux.', 'macos', 'linux'],
  macos: ['.windows.', '.linux.', 'windows', 'linux'],
  linux: ['.windows.', '.macos.', 'windows', 'macos'],
};

describe('controlled node capability advertisement bound', () => {
  it('no platform advertises more than older servers accept', () => {
    for (const [platform, excluded] of Object.entries(OTHER_PLATFORMS)) {
      const advertised = CONTROLLED_NODE_CAPABILITIES.filter((capability) => !excluded.some((marker) => capability.includes(marker)));
      expect(
        advertised.length,
        `A ${platform} node would advertise ${advertised.length} capabilities. Servers older than the ${CONTROLLED_NODE_CAPABILITY_MAX_ITEMS}-item bound `
        + `close the connection above ${CONTROLLED_NODE_ADVERTISED_MAX_ITEMS_FOR_OLDER_SERVERS} (invalid_capabilities, 4002), locking the node out. `
        + 'Do not add a capability past that: fold it into an existing one, or retire one, or first make sure no such server is still deployed.',
      ).toBeLessThanOrEqual(CONTROLLED_NODE_ADVERTISED_MAX_ITEMS_FOR_OLDER_SERVERS);
    }
  });

  it('keeps the receiver bound at or above the registry, and above what older servers accept', () => {
    expect(CONTROLLED_NODE_CAPABILITIES.length).toBeLessThanOrEqual(CONTROLLED_NODE_CAPABILITY_MAX_ITEMS);
    expect(CONTROLLED_NODE_CAPABILITY_MAX_ITEMS).toBeGreaterThan(CONTROLLED_NODE_ADVERTISED_MAX_ITEMS_FOR_OLDER_SERVERS);
  });

  it('a server still accepts the longest real advertisement (the registry share of the busiest platform)', () => {
    const windows = CONTROLLED_NODE_CAPABILITIES.filter((capability) => !OTHER_PLATFORMS.windows!.some((marker) => capability.includes(marker)));
    expect(parseAdvertisedControlledNodeCapabilities(windows)).toEqual({ ok: true, value: windows });
  });
});
