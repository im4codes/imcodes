import { describe, expect, it } from 'vitest';
import {
  classifySessionControlCommand,
  isDaemonHandledSessionControlSend,
  isSessionControlCommandText,
  shouldHideOptimisticUserMessageForSessionControl,
  shouldHideTimelineUserMessageForSessionControl,
  shouldResetProcessPreferenceContextForSessionControl,
  shouldResetTransportPreferenceContextForSessionControl,
} from '../../shared/session-control-commands.js';

describe('session control command abstraction', () => {
  it('models /compact as a provider-dispatched command hidden from user message surfaces', () => {
    expect(classifySessionControlCommand('  /compact  ')).toMatchObject({
      id: 'compact',
      handling: 'provider-dispatched',
      timelineUserMessage: 'hidden',
      optimisticUserMessage: 'hidden',
      daemonHandledReceiptAck: false,
      resetsProcessPreferenceContext: true,
      resetsTransportPreferenceContextOnSend: true,
    });
    expect(shouldHideTimelineUserMessageForSessionControl('/compact')).toBe(true);
    expect(shouldHideOptimisticUserMessageForSessionControl('/compact')).toBe(true);
    expect(shouldResetTransportPreferenceContextForSessionControl('/compact')).toBe(true);
  });

  it('models /clear as daemon-managed and still visible as a control message', () => {
    expect(classifySessionControlCommand('/clear')).toMatchObject({
      id: 'clear',
      handling: 'daemon-managed',
      timelineUserMessage: 'visible',
      optimisticUserMessage: 'visible',
      daemonHandledReceiptAck: true,
      resetsProcessPreferenceContext: true,
      resetsTransportPreferenceContextOnSend: false,
    });
    expect(isDaemonHandledSessionControlSend('/clear')).toBe(true);
    expect(shouldHideTimelineUserMessageForSessionControl('/clear')).toBe(false);
    expect(shouldHideOptimisticUserMessageForSessionControl('/clear')).toBe(false);
  });

  it('only matches exact control commands, not slash commands with arguments', () => {
    expect(isSessionControlCommandText('/compact now', 'compact')).toBe(false);
    expect(classifySessionControlCommand('/clear please')).toBeNull();
    expect(shouldResetProcessPreferenceContextForSessionControl('/model gpt-5.4')).toBe(false);
  });
});
