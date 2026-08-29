import { describe, expect, it } from 'vitest';
import {
  CONTROLLED_NODE_TICKET_DELIVERY,
  CONTROLLED_NODE_TICKET_DELIVERY_VALUES,
  CONTROLLED_NODE_TICKET_TTL_MS,
  CONTROLLED_NODE_TICKET_MAX_CONSUMES,
  controlledNodeTicketMaxConsumes,
  controlledNodeTicketTtlMs,
  isControlledNodeTicketDelivery,
} from '../../shared/controlled-node-artifacts.js';

describe('controlled-node download ticket delivery', () => {
  it('keeps the browser window short and the remote link long enough to carry', () => {
    // The browser operator is standing at the machine; seconds are enough and
    // a longer window is pure exposure.
    expect(CONTROLLED_NODE_TICKET_TTL_MS[CONTROLLED_NODE_TICKET_DELIVERY.BROWSER])
      .toBe(5 * 60 * 1000);
    // The remote link has to survive being pasted into a chat and opened on the
    // target machine later. Anything under an hour reintroduces the deadlock it
    // exists to break: you cannot transfer the installer without the tool the
    // installer installs.
    expect(CONTROLLED_NODE_TICKET_TTL_MS[CONTROLLED_NODE_TICKET_DELIVERY.REMOTE_LINK])
      .toBe(24 * 60 * 60 * 1000);
    expect(CONTROLLED_NODE_TICKET_TTL_MS[CONTROLLED_NODE_TICKET_DELIVERY.REMOTE_LINK])
      .toBeGreaterThan(CONTROLLED_NODE_TICKET_TTL_MS[CONTROLLED_NODE_TICKET_DELIVERY.BROWSER]);
  });

  it('defaults an absent or unknown delivery to the short browser window', () => {
    const browser = CONTROLLED_NODE_TICKET_TTL_MS[CONTROLLED_NODE_TICKET_DELIVERY.BROWSER];
    expect(controlledNodeTicketTtlMs()).toBe(browser);
    expect(controlledNodeTicketTtlMs(CONTROLLED_NODE_TICKET_DELIVERY.BROWSER)).toBe(5 * 60 * 1000);

    // Actually pass unknown values, not just absence. The argument is typed,
    // but it originates in a request body; a caller that skipped validation
    // would otherwise index the map with a missing key, get `undefined`, and
    // compute `now + undefined` — a NaN expiry, not a short one.
    for (const bogus of ['forever', 'remote-link', '', 'BROWSER', null, 0, {}]) {
      expect(controlledNodeTicketTtlMs(bogus as never)).toBe(browser);
    }
  });

  it('recognizes exactly the declared delivery modes', () => {
    expect(isControlledNodeTicketDelivery('browser')).toBe(true);
    expect(isControlledNodeTicketDelivery('remote_link')).toBe(true);
    expect(isControlledNodeTicketDelivery('install_command')).toBe(true);
    for (const bad of ['', 'BROWSER', 'remote-link', 'forever', null, undefined, 42, {}]) {
      expect(isControlledNodeTicketDelivery(bad)).toBe(false);
    }
    expect([...CONTROLLED_NODE_TICKET_DELIVERY_VALUES].sort())
      .toEqual(['browser', 'install_command', 'remote_link']);
  });

  it('uses a real no-count-limit contract only for the 24-hour remote link', () => {
    for (const mode of CONTROLLED_NODE_TICKET_DELIVERY_VALUES) {
      expect(Number.isSafeInteger(CONTROLLED_NODE_TICKET_TTL_MS[mode])).toBe(true);
      expect(CONTROLLED_NODE_TICKET_TTL_MS[mode]).toBeGreaterThan(0);
    }
    expect(CONTROLLED_NODE_TICKET_MAX_CONSUMES[CONTROLLED_NODE_TICKET_DELIVERY.BROWSER]).toBe(3);
    expect(CONTROLLED_NODE_TICKET_MAX_CONSUMES[CONTROLLED_NODE_TICKET_DELIVERY.REMOTE_LINK]).toBeNull();
    expect(CONTROLLED_NODE_TICKET_MAX_CONSUMES[CONTROLLED_NODE_TICKET_DELIVERY.INSTALL_COMMAND]).toBe(500);
    expect(controlledNodeTicketMaxConsumes(CONTROLLED_NODE_TICKET_DELIVERY.REMOTE_LINK)).toBeNull();

    // Unknown input must still fail toward the historical browser budget, not
    // accidentally inherit the unlimited remote-link contract.
    for (const bogus of ['forever', '', null, 0, {}]) {
      expect(controlledNodeTicketMaxConsumes(bogus as never)).toBe(3);
    }
  });
});
