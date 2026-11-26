import { describe, expect, it } from 'vitest';
import { coreLaneReceiptFrame, coreLaneSessionAuthorized, coreLaneSessionSendReceipt } from '../../shared/core-lane-receipt.js';

describe('core-lane session.send receipt', () => {
  it('classifies a session.send and builds an immediate command.ack', () => {
    const receipt = coreLaneSessionSendReceipt({ type: 'session.send', commandId: 'cmd-1', sessionName: 'deck-a', text: 'hello' });
    expect(receipt).toEqual({ commandId: 'cmd-1', session: 'deck-a' });
    expect(JSON.parse(coreLaneReceiptFrame(receipt!, 'accepted'))).toMatchObject({
      type: 'command.ack', commandId: 'cmd-1', status: 'accepted', session: 'deck-a',
    });
  });

  it('fails closed when an authoritative session snapshot is empty', () => {
    expect(coreLaneSessionAuthorized('unknown', new Set(), true)).toBe(false);
    expect(coreLaneSessionAuthorized('unknown', new Set(), false)).toBe(true);
  });

  it('does not acknowledge malformed commands', () => {
    expect(coreLaneSessionSendReceipt({ type: 'session.send', commandId: 'cmd-1' })).toBeNull();
    expect(coreLaneSessionSendReceipt({ type: 'session.send', commandId: 'cmd-1', sessionName: 'deck-a', text: 42 })).toBeNull();
    expect(coreLaneSessionSendReceipt({ type: 'session.send', sessionName: 'deck-a' })).toBeNull();
  });
});
