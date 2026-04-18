import { describe, expect, it } from 'vitest';

import {
  buildTerminalResubscribePlan,
  listGlobalTransportSubSessionNames,
  listGlobalTransportSubscriptionNames,
  listPassiveTerminalSubSessionNames,
  listPassiveTerminalSubscriptionNames,
  shouldSubscribeTerminalRaw,
} from '../src/terminal-subscribe-mode.js';

describe('shouldSubscribeTerminalRaw', () => {
  it('keeps passive surfaces non-raw', () => {
    expect(shouldSubscribeTerminalRaw(false, 'chat')).toBe(false);
    expect(shouldSubscribeTerminalRaw(false, 'terminal')).toBe(false);
  });

  it('keeps active chat surfaces non-raw', () => {
    expect(shouldSubscribeTerminalRaw(true, 'chat')).toBe(false);
  });

  it('enables raw only for active terminal surfaces', () => {
    expect(shouldSubscribeTerminalRaw(true, 'terminal')).toBe(true);
  });

  it('REGRESSION GUARD: transport/sdk sessions must remain in passive global subscriptions and this test must not be deleted', () => {
    expect(listPassiveTerminalSubscriptionNames([
      { name: 'deck_proc_brain', runtimeType: 'process' as const },
      { name: 'deck_sdk_brain', runtimeType: 'transport' as const },
    ])).toEqual(['deck_proc_brain', 'deck_sdk_brain']);

    expect(listPassiveTerminalSubSessionNames([
      { id: 'sub-proc', sessionName: 'deck_sub_proc', runtimeType: 'process' as const },
      { id: 'sub-sdk', sessionName: 'deck_sub_sdk', runtimeType: 'transport' as const },
    ])).toEqual(['deck_sub_proc', 'deck_sub_sdk']);
  });

  it('REGRESSION GUARD: copilot/cursor sdk sessions must remain in global transport subscriptions and this test must not be deleted', () => {
    expect(listGlobalTransportSubscriptionNames([
      { name: 'deck_proc_brain', runtimeType: 'process' as const },
      { name: 'deck_copilot_brain', runtimeType: 'transport' as const },
      { name: 'deck_cursor_brain', runtimeType: 'transport' as const },
    ])).toEqual(['deck_copilot_brain', 'deck_cursor_brain']);

    expect(listGlobalTransportSubSessionNames([
      { sessionName: 'deck_sub_proc', runtimeType: 'process' as const },
      { sessionName: 'deck_sub_copilot', runtimeType: 'transport' as const },
      { sessionName: 'deck_sub_cursor', runtimeType: 'transport' as const },
    ])).toEqual(['deck_sub_copilot', 'deck_sub_cursor']);
  });

  it('REGRESSION GUARD: transport/sdk sessions must remain in daemon reconnect resubscribe plan and this test must not be deleted', () => {
    expect(buildTerminalResubscribePlan({
      activeName: 'deck_sdk_brain',
      activeMode: 'chat',
      focusedSubId: 'sub-sdk',
      sessions: [
        { name: 'deck_sdk_brain', runtimeType: 'transport' as const },
        { name: 'deck_proc_brain', runtimeType: 'process' as const },
      ],
      subSessions: [
        { id: 'sub-sdk', sessionName: 'deck_sub_sdk', runtimeType: 'transport' as const },
        { id: 'sub-proc', sessionName: 'deck_sub_proc', runtimeType: 'process' as const },
      ],
    })).toEqual([
      { name: 'deck_sdk_brain', mode: 'chat' },
      { name: 'deck_sub_sdk', mode: 'chat' },
      { name: 'deck_proc_brain', mode: 'chat' },
      { name: 'deck_sub_sdk', mode: 'chat' },
      { name: 'deck_sub_proc', mode: 'chat' },
    ]);
  });
});
