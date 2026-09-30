/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { act, cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

const renders = vi.hoisted(() => ({ pane: {} as Record<string, number>, window: {} as Record<string, number>, lastPane: {} as Record<string, Record<string, unknown>> }));
vi.mock('../src/components/SessionPane.js', () => ({
  SessionPane: (props: { session: { name: string; state: string } } & Record<string, unknown>) => {
    renders.pane[props.session.name] = (renders.pane[props.session.name] ?? 0) + 1;
    renders.lastPane[props.session.name] = props;
    return <div data-testid={`pane-${props.session.name}`} data-state={props.session.state} />;
  },
}));
vi.mock('../src/components/SubSessionWindow.js', () => ({
  SubSessionWindow: (props: { sub: { id: string; state: string } }) => {
    renders.window[props.sub.id] = (renders.window[props.sub.id] ?? 0) + 1;
    return <div data-testid={`win-${props.sub.id}`} data-state={props.sub.state} />;
  },
}));

import { StableSessionPane } from '../src/components/StableSessionPane.js';
import { StableSubSessionWindow } from '../src/components/StableSubSessionWindow.js';

type S = { name: string; state: string };

/** Like App: re-renders as a whole, hands each pane a fresh inline handler every time. */
function App(props: { sessions: S[]; tick: number; log: string[] }) {
  return (
    <div data-tick={props.tick}>
      {props.sessions.map((s) => (
        <StableSessionPane
          key={s.name}
          {...({ session: s, isActive: s.name === 'a', viewMode: 'chat', connected: true } as never)}
          onRestart={() => props.log.push(`${s.name}@${props.tick}`)}
          onFitFn={(() => undefined) as never}
        />
      ))}
    </div>
  );
}

describe('per-session isolation through the stable pane boundary', () => {
  afterEach(() => { cleanup(); for (const k of Object.keys(renders.pane)) delete renders.pane[k]; for (const k of Object.keys(renders.window)) delete renders.window[k]; });

  it('re-rendering the parent (a frame for ANOTHER session, fresh handlers) does not re-render unchanged panes', () => {
    const a = { name: 'a', state: 'idle' };
    const b = { name: 'b', state: 'idle' };
    const c = { name: 'c', state: 'idle' };
    const log: string[] = [];
    const view = render(<App sessions={[a, b, c]} tick={0} log={log} />);
    expect(renders.pane).toEqual({ a: 1, b: 1, c: 1 });
    for (let tick = 1; tick <= 20; tick += 1) view.rerender(<App sessions={[a, b, c]} tick={tick} log={log} />);
    expect(renders.pane, '20 parent renders with nothing changed').toEqual({ a: 1, b: 1, c: 1 });
  });

  // Counterexample: a pane DOES re-render when its own session changes, and only that pane.
  it('a change to one session re-renders exactly that pane', () => {
    const a = { name: 'a', state: 'idle' };
    const b = { name: 'b', state: 'idle' };
    const c = { name: 'c', state: 'idle' };
    const log: string[] = [];
    const view = render(<App sessions={[a, b, c]} tick={0} log={log} />);
    const b2 = { name: 'b', state: 'running' };
    view.rerender(<App sessions={[a, b2, c]} tick={1} log={log} />);
    expect(renders.pane).toEqual({ a: 1, b: 2, c: 1 });
    expect(document.querySelector('[data-testid="pane-b"]')?.getAttribute('data-state')).toBe('running');
    expect(document.querySelector('[data-testid="pane-a"]')?.getAttribute('data-state')).toBe('idle');
  });

  it('a stale pane still runs the LATEST handler closure (no stale-tick bug)', () => {
    const a = { name: 'a', state: 'idle' };
    const log: string[] = [];
    const view = render(<App sessions={[a]} tick={0} log={log} />);
    view.rerender(<App sessions={[a]} tick={7} log={log} />);
    expect(renders.pane.a).toBe(1); // not re-rendered...
    (renders.lastPane.a!.onRestart as () => void)(); // ...but its handler reflects tick 7
    expect(log).toEqual(['a@7']);
  });

  it('sub-session windows: same isolation and same counterexample', () => {
    const w1 = { id: 'w1', state: 'idle' };
    const w2 = { id: 'w2', state: 'idle' };
    function Windows(props: { subs: Array<{ id: string; state: string }>; tick: number }) {
      return <div>{props.subs.map((sub) => <StableSubSessionWindow key={sub.id} {...({ sub, ws: null, connected: true, active: false, visible: true } as never)} onClose={() => props.tick} />)}</div>;
    }
    const view = render(<Windows subs={[w1, w2]} tick={0} />);
    for (let tick = 1; tick <= 10; tick += 1) view.rerender(<Windows subs={[w1, w2]} tick={tick} />);
    expect(renders.window).toEqual({ w1: 1, w2: 1 });
    view.rerender(<Windows subs={[w1, { id: 'w2', state: 'running' }]} tick={11} />);
    expect(renders.window).toEqual({ w1: 1, w2: 2 });
    void act;
  });
});
