import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSendDispatchId, isSendMessageId } from '../../shared/send-message-id.js';
import { printDirectSendResult, printSendResult } from '../../src/cli/send-output.js';

describe('CLI send id output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints hook-server dispatch and message ids when present', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    printSendResult({
      ok: true,
      delivered: true,
      target: 'deck_alpha_w1',
      dispatchId: 'send_dispatch_11111111-1111-4111-8111-111111111111',
      messageId: 'send_message_22222222-2222-4222-8222-222222222222',
    });

    expect(log.mock.calls.flat()).toContain('Sent to deck_alpha_w1.');
    expect(log.mock.calls.flat()).toContain('dispatchId: send_dispatch_11111111-1111-4111-8111-111111111111');
    expect(log.mock.calls.flat()).toContain('messageId: send_message_22222222-2222-4222-8222-222222222222');
  });

  it('prints per-target message ids for broadcast hook responses', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    printSendResult({
      ok: true,
      delivered: ['deck_alpha_w1', 'deck_alpha_w2'],
      queued: [],
      dispatchId: 'send_dispatch_33333333-3333-4333-8333-333333333333',
      messages: [
        { target: 'deck_alpha_w1', messageId: 'send_message_44444444-4444-4444-8444-444444444444' },
        { target: 'deck_alpha_w2', messageId: 'send_message_55555555-5555-4555-8555-555555555555' },
      ],
    });

    expect(log.mock.calls.flat()).toContain('dispatchId: send_dispatch_33333333-3333-4333-8333-333333333333');
    expect(log.mock.calls.flat()).toContain('deck_alpha_w1 messageId: send_message_44444444-4444-4444-8444-444444444444');
    expect(log.mock.calls.flat()).toContain('deck_alpha_w2 messageId: send_message_55555555-5555-4555-8555-555555555555');
  });

  it('direct tmux fallback output generates and prints shared ids', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    printDirectSendResult('deck_alpha_w1');

    const lines = log.mock.calls.flat().map(String);
    const dispatchId = lines.find((line) => line.startsWith('dispatchId: '))?.replace('dispatchId: ', '');
    const messageId = lines.find((line) => line.startsWith('messageId: '))?.replace('messageId: ', '');
    expect(lines).toContain('Sent to deck_alpha_w1.');
    expect(isSendDispatchId(dispatchId)).toBe(true);
    expect(isSendMessageId(messageId)).toBe(true);
  });
});
