/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { act, cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({ renders: 0, props: null as Record<string, unknown> | null }));
vi.mock('../src/components/SessionControls.js', () => ({
  SessionControls: (props: Record<string, unknown>) => {
    probe.renders += 1;
    probe.props = props;
    return <div data-testid="controls" />;
  },
}));

import { StableSessionControls } from '../src/components/StableSessionControls.js';
import { collectSettledQueuedIds } from '../src/session-controls-queue.js';
import { useStableCallbacks } from '../src/hooks/useStableCallbacks.js';

const inputRef = { current: null };
const session = { name: 'deck_sub_a', project: 'p', role: 'w1', agentType: 'codex-sdk', state: 'idle' } as never;
const userMessage = (id: string, clientMessageId: string) => ({
  eventId: id, type: 'user.message', sessionId: 'deck_sub_a', ts: 1, epoch: 1, seq: 1, source: 'daemon', confidence: 'high',
  payload: { text: 'hi', clientMessageId, commandId: `cmd-${id}` },
}) as never;
const assistant = (id: string) => ({
  eventId: id, type: 'assistant.text', sessionId: 'deck_sub_a', ts: 2, epoch: 1, seq: 2, source: 'daemon', confidence: 'high',
  payload: { text: id, streaming: false },
}) as never;

function Parent(props: { events: unknown[]; onSend: (text: string) => void; extra?: Record<string, unknown> }) {
  return (
    <StableSessionControls
      {...({ ws: null, activeSession: session, connected: true, inputRef, activeThinking: false } as never)}
      // fresh inline handlers on every parent render, like the real parents
      onAfterAction={() => undefined}
      onSend={(_name: string, text: string) => props.onSend(text)}
      transportTimelineEvents={props.events as never}
      {...(props.extra as never)}
    />
  );
}

describe('StableSessionControls', () => {
  afterEach(() => { cleanup(); probe.renders = 0; probe.props = null; });

  it('does not re-render the real component when only fresh inline handlers / unrelated timeline events arrive', () => {
    const view = render(<Parent events={[userMessage('u1', 'c1')]} onSend={() => undefined} />);
    expect(probe.renders).toBe(1);
    // new handlers, a longer timeline whose relevant content (settled ids) is unchanged
    view.rerender(<Parent events={[userMessage('u1', 'c1'), assistant('a1')]} onSend={() => undefined} />);
    view.rerender(<Parent events={[userMessage('u1', 'c1'), assistant('a1'), assistant('a2')]} onSend={() => undefined} />);
    expect(probe.renders, 'unchanged inputs must not re-render the big component').toBe(1);
  });

  // Counterexamples: everything it displays still updates it.
  it('re-renders when a new settled queued id appears', () => {
    const view = render(<Parent events={[userMessage('u1', 'c1')]} onSend={() => undefined} />);
    view.rerender(<Parent events={[userMessage('u1', 'c1'), userMessage('u2', 'c2')]} onSend={() => undefined} />);
    expect(probe.renders).toBe(2);
    expect([...(probe.props!.timelineSettledQueuedIds as Set<string>)].sort()).toEqual(['c1', 'c2', 'cmd-u1', 'cmd-u2']);
  });

  it('re-renders when a data prop changes', () => {
    const view = render(<Parent events={[]} onSend={() => undefined} />);
    view.rerender(<Parent events={[]} onSend={() => undefined} extra={{ connected: false }} />);
    expect(probe.renders).toBe(2);
    expect(probe.props!.connected).toBe(false);
  });

  it('a stable handler always calls the LATEST closure', () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = render(<Parent events={[]} onSend={first} />);
    const handler = probe.props!.onSend as (n: string, t: string) => void;
    view.rerender(<Parent events={[]} onSend={second} />);
    expect(probe.props!.onSend, 'identity is stable across renders').toBe(handler);
    handler('deck_sub_a', 'hello');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('hello');
  });
});

describe('useStableCallbacks', () => {
  afterEach(() => cleanup());

  it('keeps undefined handlers undefined and passes non-functions through untouched', () => {
    let seen: Record<string, unknown> = {};
    function C(props: Record<string, unknown>) { seen = useStableCallbacks(props); return null; }
    const data = { a: 1 };
    const view = render(<C onA={() => 1} data={data} onMissing={undefined} />);
    expect(seen.data).toBe(data);
    expect('onMissing' in seen && seen.onMissing === undefined).toBe(true);
    const wrapper = seen.onA;
    view.rerender(<C onA={() => 2} data={data} onMissing={undefined} />);
    expect(seen.onA).toBe(wrapper);
    expect((seen.onA as () => number)()).toBe(2);
  });
});

describe('collectSettledQueuedIds', () => {
  it('collects ids of committed user messages for that session only, and shares one empty set', () => {
    expect([...collectSettledQueuedIds([userMessage('u1', 'c1')], 'deck_sub_a')].sort()).toEqual(['c1', 'cmd-u1']);
    expect(collectSettledQueuedIds([userMessage('u1', 'c1')], 'deck_sub_other').size).toBe(0);
    expect(collectSettledQueuedIds([], 'deck_sub_a')).toBe(collectSettledQueuedIds(undefined, undefined));
  });
});
