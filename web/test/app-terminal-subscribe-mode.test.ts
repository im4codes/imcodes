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

  it('REGRESSION GUARD: shell/script sessions must not enter passive terminal subscriptions and this test must not be deleted', () => {
    expect(listPassiveTerminalSubscriptionNames([
      { name: 'deck_proc_brain', runtimeType: 'process' as const },
      { name: 'deck_sdk_brain', runtimeType: 'transport' as const },
      { name: 'deck_shell_brain', runtimeType: 'process' as const, agentType: 'shell' },
      { name: 'deck_script_brain', runtimeType: 'process' as const, agentType: 'script' },
    ])).toEqual(['deck_proc_brain', 'deck_sdk_brain']);

    expect(listPassiveTerminalSubSessionNames([
      { id: 'sub-proc', sessionName: 'deck_sub_proc', runtimeType: 'process' as const },
      { id: 'sub-sdk', sessionName: 'deck_sub_sdk', runtimeType: 'transport' as const },
      { id: 'sub-shell', sessionName: 'deck_sub_shell', runtimeType: 'process' as const, type: 'shell' },
      { id: 'sub-script', sessionName: 'deck_sub_script', runtimeType: 'process' as const, type: 'script' },
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

  it('REGRESSION GUARD: sdk sessions must infer global transport subscriptions when runtimeType is missing and this test must not be deleted', () => {
    expect(listGlobalTransportSubscriptionNames([
      { name: 'deck_proc_brain', agentType: 'claude-code' },
      { name: 'deck_codex_sdk_brain', agentType: 'codex-sdk' },
      { name: 'deck_copilot_sdk_brain', agentType: 'copilot-sdk', runtimeType: null },
      { name: 'deck_explicit_proc_brain', agentType: 'codex-sdk', runtimeType: 'process' as const },
    ])).toEqual(['deck_codex_sdk_brain', 'deck_copilot_sdk_brain']);

    expect(listGlobalTransportSubSessionNames([
      { sessionName: 'deck_sub_proc', type: 'codex' },
      { sessionName: 'deck_sub_codex_sdk', type: 'codex-sdk' },
      { sessionName: 'deck_sub_cursor', type: 'cursor-headless', runtimeType: null },
      { sessionName: 'deck_sub_explicit_proc', type: 'copilot-sdk', runtimeType: 'process' as const },
    ])).toEqual(['deck_sub_codex_sdk', 'deck_sub_cursor']);
  });

  it('REGRESSION GUARD: transport/sdk sessions must remain in daemon reconnect resubscribe plan and this test must not be deleted', () => {
    expect(buildTerminalResubscribePlan({
      activeName: 'deck_sdk_brain',
      activeMode: 'chat',
      focusedSubId: 'sub-sdk',
      sessions: [
        { name: 'deck_sdk_brain', runtimeType: 'transport' as const },
        { name: 'deck_proc_brain', runtimeType: 'process' as const },
        { name: 'deck_shell_brain', runtimeType: 'process' as const, agentType: 'shell' },
      ],
      subSessions: [
        { id: 'sub-sdk', sessionName: 'deck_sub_sdk', runtimeType: 'transport' as const },
        { id: 'sub-proc', sessionName: 'deck_sub_proc', runtimeType: 'process' as const },
        { id: 'sub-shell', sessionName: 'deck_sub_shell', runtimeType: 'process' as const, type: 'shell' },
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
