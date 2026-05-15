import { describe, expect, it } from 'vitest';
import {
  SEND_DISPATCH_ID_PREFIX,
  SEND_MESSAGE_ID_PREFIX,
  createSendDispatchId,
  createSendMessageId,
  isSendDispatchId,
  isSendMessageId,
} from '../../shared/send-message-id.js';

describe('send message ids', () => {
  it('creates dispatch ids with the canonical prefix and UUID payload', () => {
    const id = createSendDispatchId();

    expect(id.startsWith(SEND_DISPATCH_ID_PREFIX)).toBe(true);
    expect(isSendDispatchId(id)).toBe(true);
    expect(isSendMessageId(id)).toBe(false);
  });

  it('creates message ids with the canonical prefix and UUID payload', () => {
    const id = createSendMessageId();

    expect(id.startsWith(SEND_MESSAGE_ID_PREFIX)).toBe(true);
    expect(isSendMessageId(id)).toBe(true);
    expect(isSendDispatchId(id)).toBe(false);
  });

  it('rejects malformed ids', () => {
    expect(isSendDispatchId('send_dispatch_not-a-uuid')).toBe(false);
    expect(isSendMessageId('send_message_00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(isSendMessageId(null)).toBe(false);
  });
});
