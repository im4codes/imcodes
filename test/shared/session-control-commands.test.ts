import { describe, expect, it } from 'vitest';
import {
  classifySessionControlCommand,
  getSessionControlTimelineFeedback,
  getSessionControlTimelineFeedbackById,
  isDaemonHandledSessionControlSend,
  isSessionModelSwitchCommandText,
  isSessionControlCommandText,
  SESSION_CONTROL_TIMELINE_REASON_USER_COMPACT,
  SESSION_CONTROL_TIMELINE_STATE_COMPACTING,
  SESSION_CONTROL_TIMELINE_REASON_USER_CANCEL,
  SESSION_CONTROL_TIMELINE_STATE_STOPPING,
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
      timelineFeedback: {
        state: SESSION_CONTROL_TIMELINE_STATE_COMPACTING,
        reason: SESSION_CONTROL_TIMELINE_REASON_USER_COMPACT,
      },
      daemonHandledReceiptAck: false,
      resetsProcessPreferenceContext: true,
      resetsTransportPreferenceContextOnSend: true,
    });
    expect(getSessionControlTimelineFeedback('/compact')).toEqual({
      state: SESSION_CONTROL_TIMELINE_STATE_COMPACTING,
      reason: SESSION_CONTROL_TIMELINE_REASON_USER_COMPACT,
    });
    expect(getSessionControlTimelineFeedbackById('compact')).toEqual({
      state: SESSION_CONTROL_TIMELINE_STATE_COMPACTING,
      reason: SESSION_CONTROL_TIMELINE_REASON_USER_COMPACT,
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
      timelineFeedback: null,
      daemonHandledReceiptAck: true,
      resetsProcessPreferenceContext: true,
      resetsTransportPreferenceContextOnSend: false,
    });
    expect(isDaemonHandledSessionControlSend('/clear')).toBe(true);
    expect(shouldHideTimelineUserMessageForSessionControl('/clear')).toBe(false);
    expect(shouldHideOptimisticUserMessageForSessionControl('/clear')).toBe(false);
  });

  it('models /stop as hidden user text with explicit timeline feedback', () => {
    expect(classifySessionControlCommand('/stop')).toMatchObject({
      id: 'stop',
      handling: 'daemon-managed',
      timelineUserMessage: 'hidden',
      optimisticUserMessage: 'hidden',
      timelineFeedback: {
        state: SESSION_CONTROL_TIMELINE_STATE_STOPPING,
        reason: SESSION_CONTROL_TIMELINE_REASON_USER_CANCEL,
      },
      daemonHandledReceiptAck: true,
      resetsProcessPreferenceContext: false,
      resetsTransportPreferenceContextOnSend: false,
    });
    expect(getSessionControlTimelineFeedback('/stop')).toEqual({
      state: SESSION_CONTROL_TIMELINE_STATE_STOPPING,
      reason: SESSION_CONTROL_TIMELINE_REASON_USER_CANCEL,
    });
    expect(getSessionControlTimelineFeedbackById('stop')).toEqual({
      state: SESSION_CONTROL_TIMELINE_STATE_STOPPING,
      reason: SESSION_CONTROL_TIMELINE_REASON_USER_CANCEL,
    });
    expect(shouldHideTimelineUserMessageForSessionControl('/stop')).toBe(true);
    expect(shouldHideOptimisticUserMessageForSessionControl('/stop')).toBe(true);
  });

  it('only matches exact control commands, not slash commands with arguments', () => {
    expect(isSessionControlCommandText('/compact now', 'compact')).toBe(false);
    expect(classifySessionControlCommand('/clear please')).toBeNull();
    expect(shouldResetProcessPreferenceContextForSessionControl('/model gpt-5.4')).toBe(false);
  });

  it('recognizes complete model-switch commands without matching ordinary prose', () => {
    expect(isSessionModelSwitchCommandText('/model gpt-5.4')).toBe(true);
    expect(isSessionModelSwitchCommandText('  /model anthropic/claude-sonnet-4-5  ')).toBe(true);
    expect(isSessionModelSwitchCommandText('/model\tgpt-5.4')).toBe(true);
    expect(isSessionModelSwitchCommandText('/model')).toBe(false);
    expect(isSessionModelSwitchCommandText('/modelfoo')).toBe(false);
    expect(isSessionModelSwitchCommandText('Please run /model gpt-5.4')).toBe(false);
  });
});
