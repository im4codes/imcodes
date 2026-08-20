/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (key === 'chat.tool_activity_label') return 'Tools';
      if (key === 'chat.tool_activity_summary') {
        return `${vars?.total} tools: ${vars?.completed} completed, ${vars?.running} running, ${vars?.failed} failed`;
      }
      if (key === 'chat.tool_activity_expand') return 'Expand tool details';
      if (key === 'chat.tool_activity_collapse') return 'Collapse tool details';
      if (key === 'chat.tool_peek_command') return 'Command';
      if (key === 'chat.tool_peek_output') return 'Output';
      if (key === 'chat.tool_peek_running') return 'Running';
      if (key === 'chat.tool_peek_done') return 'Done';
      if (key === 'chat.tool_peek_failed') return 'Failed';
      if (key === 'chat.tool_peek_waiting') return 'Waiting for output…';
      return key.split('.').pop() ?? key;
    },
  }),
}));

vi.mock('../src/components/FileBrowser.js', () => ({
  FileBrowser: () => null,
}));

vi.mock('../src/api.js', () => ({
  downloadAttachment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/hooks/usePref.js', () => ({
  parseBooleanish: (raw: unknown) => (raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : null),
  usePref: () => ({
    value: false,
    rawValue: false,
    loaded: true,
    loading: false,
    stale: false,
    error: null,
    save: async () => undefined,
    set: () => undefined,
    reload: async () => true,
  }),
}));

import { ChatView } from '../src/components/ChatView.js';
import type { TimelineEvent } from '../src/ws-client.js';

function makeEvent(
  eventId: string,
  type: string,
  payload: Record<string, unknown>,
  seq: number,
): TimelineEvent {
  return {
    eventId,
    sessionId: 'tool-activity-test',
    ts: 1_000 + seq,
    seq,
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
    type,
    payload,
  } as TimelineEvent;
}

/** jsdom has no matchMedia; the peek is gated on a real hover pointer. */
function stubHover(hover: boolean) {
  const impl = ((query: string) => ({
    matches: query.includes('hover: hover') ? hover : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  vi.stubGlobal('matchMedia', impl);
  window.matchMedia = impl;
}

describe('ChatView compact tool activity', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows live aggregate counts and expands exact tool details on demand', () => {
    const readCall = makeEvent('read-call', 'tool.call', {
      tool: 'Read',
      input: { file_path: 'README.md' },
    }, 1);
    const readResult = makeEvent('read-result', 'tool.result', {
      output: 'contents',
    }, 2);
    const assistantProgress = makeEvent('assistant-progress', 'assistant.text', {
      text: 'Checking the result before continuing.',
    }, 3);
    const bashCall = makeEvent('bash-call', 'tool.call', {
      tool: 'Bash',
      input: { command: 'npm test' },
    }, 4);

    const { container, rerender } = render(
      <ChatView events={[readCall, readResult, assistantProgress, bashCall]} loading={false} />,
    );

    expect(container.querySelectorAll('.chat-tool-activity')).toHaveLength(1);
    const activity = container.querySelector('.chat-tool-activity') as HTMLButtonElement | null;
    expect(activity).not.toBeNull();
    expect(activity?.getAttribute('aria-expanded')).toBe('false');
    expect(activity?.getAttribute('aria-label')).toContain('2 tools: 1 completed, 1 running, 0 failed');
    expect(container.querySelector('.chat-tool-activity-total')?.textContent).toBe('2');
    expect(container.querySelector('.chat-tool-activity-stat.is-complete')?.textContent).toBe('✓1');
    expect(container.querySelector('.chat-tool-activity-stat.is-running')?.textContent).toBe('●1');
    expect(container.querySelectorAll('.chat-tool-activity-segment')).toHaveLength(2);
    expect(container.querySelector('.chat-tool')).toBeNull();

    fireEvent.click(activity!);

    expect(activity?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.chat-tool-activity-details')).not.toBeNull();
    expect(container.textContent).toContain('Read');
    expect(container.textContent).toContain('Bash');
    expect(container.textContent).toContain('README.md');
    expect(container.textContent).toContain('npm test');

    const bashResult = makeEvent('bash-result', 'tool.result', {
      output: 'passed',
    }, 5);
    rerender(<ChatView events={[readCall, readResult, assistantProgress, bashCall, bashResult]} loading={false} />);

    expect(container.querySelector('.chat-tool-activity-total')?.textContent).toBe('2');
    expect(container.querySelector('.chat-tool-activity-stat.is-complete')?.textContent).toBe('✓2');
    expect(container.querySelector('.chat-tool-activity-stat.is-running')).toBeNull();
    expect(container.querySelectorAll('.chat-tool-activity-segment')).toHaveLength(1);
  });

  it('provides a full-width collapse bar after the expanded tool group', () => {
    const call = makeEvent('bottom-collapse-call', 'tool.call', {
      tool: 'Bash',
      input: { command: 'npm test' },
    }, 1);
    const result = makeEvent('bottom-collapse-result', 'tool.result', {
      output: 'passed',
    }, 2);

    const { container } = render(<ChatView events={[call, result]} loading={false} />);
    const activity = container.querySelector('.chat-tool-activity') as HTMLButtonElement;

    fireEvent.click(activity);

    const footer = container.querySelector<HTMLButtonElement>('.chat-tool-activity-collapse-footer');
    expect(container.querySelector('.chat-tool-activity-details')).not.toBeNull();
    expect(footer).not.toBeNull();
    expect(footer?.getAttribute('aria-expanded')).toBe('true');
    expect(footer?.getAttribute('aria-label')).toBe('Collapse tool details');
    expect(footer?.textContent).toContain('Tools');
    expect(footer?.textContent).toContain('Collapse tool details');

    fireEvent.click(footer!);

    expect(activity.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.chat-tool-activity-details')).toBeNull();
    expect(container.querySelector('.chat-tool-activity-collapse-footer')).toBeNull();
  });

  it('keeps failed tools visible in the compact rail', () => {
    const call = makeEvent('failed-call', 'tool.call', {
      tool: 'Write',
      input: { file_path: 'locked.txt' },
    }, 1);
    const result = makeEvent('failed-result', 'tool.result', {
      error: 'permission denied',
    }, 2);

    const { container } = render(<ChatView events={[call, result]} loading={false} />);

    const activity = container.querySelector('.chat-tool-activity');
    expect(activity?.classList.contains('has-error')).toBe(true);
    expect(activity?.getAttribute('aria-label')).toContain('1 tools: 0 completed, 0 running, 1 failed');
    expect(container.querySelector('.chat-tool-activity-stat.is-complete')?.textContent).toBe('✓0');
    expect(container.querySelector('.chat-tool-activity-stat.is-failed')?.textContent).toBe('×1');
    expect(container.querySelector('.chat-tool-activity-segment.is-failed')).not.toBeNull();
    expect(container.querySelector('.chat-tool')).toBeNull();
  });

  it('does not reveal or count hidden tool events in Simple view', () => {
    const visibleCall = makeEvent('visible-call', 'tool.call', {
      tool: 'Read',
      input: { file_path: 'visible.txt' },
    }, 1);
    const visibleResult = makeEvent('visible-result', 'tool.result', {
      output: 'visible contents',
    }, 2);
    const hiddenCall = {
      ...makeEvent('hidden-call', 'tool.call', {
        tool: 'Edit',
        input: { file_path: 'hidden.ts' },
      }, 3),
      hidden: true,
    } as TimelineEvent;
    const hiddenResult = {
      ...makeEvent('hidden-result', 'tool.result', {
        output: 'hidden result',
      }, 4),
      hidden: true,
    } as TimelineEvent;

    const { container, rerender } = render(
      <ChatView events={[hiddenCall, hiddenResult]} loading={false} />,
    );

    expect(container.querySelector('.chat-tool-activity')).toBeNull();
    expect(container.textContent).not.toContain('Edit');
    expect(container.textContent).not.toContain('hidden.ts');

    rerender(
      <ChatView
        events={[visibleCall, visibleResult, hiddenCall, hiddenResult]}
        loading={false}
      />,
    );

    const activity = container.querySelector('.chat-tool-activity') as HTMLButtonElement | null;
    expect(activity).not.toBeNull();
    expect(container.querySelector('.chat-tool-activity-total')?.textContent).toBe('1');
    expect(activity?.getAttribute('aria-label')).toContain('1 tools: 1 completed, 0 running, 0 failed');

    fireEvent.click(activity!);
    expect(container.textContent).toContain('Read');
    expect(container.textContent).toContain('visible.txt');
    expect(container.textContent).not.toContain('Edit');
    expect(container.textContent).not.toContain('hidden.ts');
    expect(container.textContent).not.toContain('hidden result');
  });
  // The counters answer "how many", not "what is it stuck on" — the question
  // during a long wait. These cover the wiring, not just the formatter.
  it('shows live elapsed time and what the running tool is doing', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const bashCall = makeEvent('bash-call', 'tool.call', {
      tool: 'Bash',
      input: { command: 'npm run build' },
    }, 1);
    // Started 42s before "now".
    (bashCall as { ts: number }).ts = 1_000_000 - 42_000;

    const { container } = render(<ChatView events={[bashCall]} loading={false} />);

    expect(container.querySelector('.chat-tool-activity-time')?.textContent).toBe('42s');
    expect(container.querySelector('.chat-tool-activity-time')?.className).toContain('is-running');
    expect(container.querySelector('.chat-tool-activity-last')?.textContent).toContain('npm run build');

    // Ticks while the tool keeps running, or a long wait would look frozen.
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(container.querySelector('.chat-tool-activity-time')?.textContent).toBe('45s');

    vi.useRealTimers();
  });

  it('reports how long a finished tool took, not how long ago it started', () => {
    const call = makeEvent('c', 'tool.call', { tool: 'Read', input: { file_path: 'a.md' } }, 1);
    (call as { ts: number }).ts = 5_000;
    const result = makeEvent('r', 'tool.result', { output: 'ok' }, 2);
    (result as { ts: number }).ts = 6_500;

    const { container } = render(<ChatView events={[call, result]} loading={false} />);

    // 1.5s of actual work — not the age of the event.
    expect(container.querySelector('.chat-tool-activity-time')?.textContent).toBe('1.5s');
    expect(container.querySelector('.chat-tool-activity-time')?.className).not.toContain('is-running');
  });

  it('describes the newest tool, not the first one in the group', () => {
    const readCall = makeEvent('rc', 'tool.call', { tool: 'Read', input: { file_path: 'old.md' } }, 1);
    const readResult = makeEvent('rr', 'tool.result', { output: 'x' }, 2);
    const grepCall = makeEvent('gc', 'tool.call', { tool: 'Grep', input: { pattern: 'needle' } }, 3);

    const { container } = render(<ChatView events={[readCall, readResult, grepCall]} loading={false} />);

    const label = container.querySelector('.chat-tool-activity-last')?.textContent ?? '';
    expect(label).toContain('needle');
    expect(label).not.toContain('old.md');
  });

  it('keeps the status glyph out of the descriptor, since the counters show it', () => {
    const call = makeEvent('c2', 'tool.call', { tool: 'Bash', input: { command: 'ls' } }, 1);
    const result = makeEvent('r2', 'tool.result', { output: 'ok' }, 2);

    const { container } = render(<ChatView events={[call, result]} loading={false} />);

    expect(container.querySelector('.chat-tool-activity-last')?.textContent).not.toContain('✓');
  });
  // Regressions from the first cut of this chip: the last event in a group is
  // often a standalone tool.result (its call fell outside the merge window),
  // and reading it directly produced a bare input dump with no name, no time.
  it('names the tool, not just its arguments', () => {
    const call = makeEvent('n1', 'tool.call', { tool: 'Grep', input: { pattern: 'needle' } }, 1);
    const { container } = render(<ChatView events={[call]} loading={false} />);
    expect(container.querySelector('.chat-tool-activity-last-name')?.textContent).toBe('Grep');
  });

  it('falls back past a standalone trailing result to the call that names the tool', () => {
    // The merge window pairs a call with the FIRST result after it, so a second
    // unpaired result stays in the group and lands last. Reading that directly
    // is what produced a bare argument dump with no name and no duration.
    const call = makeEvent('c3', 'tool.call', { tool: 'Bash', input: { command: 'npm ci' } }, 1);
    (call as { ts: number }).ts = 10_000;
    const pairedResult = makeEvent('r3', 'tool.result', { output: 'done' }, 2);
    (pairedResult as { ts: number }).ts = 12_000;
    const strayResult = makeEvent('r4', 'tool.result', { output: 'stray' }, 3);
    (strayResult as { ts: number }).ts = 13_000;

    const { container } = render(
      <ChatView events={[call, pairedResult, strayResult]} loading={false} />,
    );

    expect(container.querySelector('.chat-tool-activity-last-name')?.textContent).toBe('Bash');
    expect(container.querySelector('.chat-tool-activity-last-input')?.textContent).toContain('npm ci');
    // Timed call → paired result (2.0s), not call → stray result (3.0s).
    expect(container.querySelector('.chat-tool-activity-time')?.textContent).toBe('2.0s');
  });

  it('uses the result args when a streamed call arrived without input', () => {
    // Transport SDKs emit tool.call before the arguments finish streaming; the
    // full row recovers them from the result, and the chip must do the same or
    // it shows a bare tool name.
    const call = makeEvent('s1', 'tool.call', { tool: 'Grep' }, 1);
    const result = makeEvent('s2', 'tool.result', {
      output: 'hit',
      detail: { input: { pattern: 'from-result' } },
    }, 2);

    const { container } = render(<ChatView events={[call, result]} loading={false} />);

    expect(container.querySelector('.chat-tool-activity-last-input')?.textContent).toContain('from-result');
  });

  it('renders the descriptor on narrow screens too, not only desktop', () => {
    // The chip goes full width and ellipses; dropping it on mobile would remove
    // the only answer to "what is it doing".
    const call = makeEvent('m1', 'tool.call', { tool: 'Bash', input: { command: 'npm run build' } }, 1);
    const { container } = render(<ChatView events={[call]} loading={false} />);
    const last = container.querySelector('.chat-tool-activity-last') as HTMLElement | null;
    expect(last).not.toBeNull();
    // No JS media gate: presence must not depend on viewport width.
    expect(last?.style.display).not.toBe('none');
  });
  it('shows only the first line of a multi-line command', () => {
    // The chip is one row tall; a heredoc or multi-line script must not drag
    // the rest of its body into the status strip.
    const call = makeEvent('ml1', 'tool.call', {
      tool: 'Bash',
      input: { command: 'set -e\nnpm ci\nnpm test' },
    }, 1);

    const { container } = render(<ChatView events={[call]} loading={false} />);

    const input = container.querySelector('.chat-tool-activity-last-input')?.textContent ?? '';
    expect(input).toContain('set -e');
    expect(input).not.toContain('npm test');
  });
  it('pairs concurrent tools by correlation id, not by adjacency', async () => {
    // Real interleaving is callA, callB, resultA, resultB. The adjacency scan
    // stopped at the next call, so A never merged (counted "running" forever,
    // holding the 1s ticker) and B was merged with A's result — wrong args,
    // wrong duration, wrong finish time.
    const callA = makeEvent('a-call', 'tool.call', {
      tool: 'Bash', toolCallId: 'call-a', input: { command: 'slow-a' },
    }, 1);
    const callB = makeEvent('b-call', 'tool.call', {
      tool: 'Grep', toolCallId: 'call-b', input: { pattern: 'fast-b' },
    }, 2);
    const resultA = makeEvent('a-result', 'tool.result', {
      toolCallId: 'call-a', output: 'A done',
    }, 3);
    const resultB = makeEvent('b-result', 'tool.result', {
      toolCallId: 'call-b', output: 'B done',
    }, 4);

    const { container } = render(
      <ChatView events={[callA, callB, resultA, resultB]} loading={false} />,
    );

    // Both tools finished: nothing may be left counted as running.
    expect(container.querySelector('.chat-tool-activity-stat.is-running')).toBeNull();
    expect(container.querySelector('.chat-tool-activity-stat.is-complete')?.textContent).toBe('✓2');

    // The newest tool is B, and it must show B's own arguments.
    const label = container.querySelector('.chat-tool-activity-last')?.textContent ?? '';
    expect(label).toContain('Grep');
    expect(label).toContain('fast-b');
    expect(label).not.toContain('slow-a');
  });

  it('pairs an id-bearing call with an adjacent result that carries no id', async () => {
    // Mixed shape: the call has a correlation id, its result does not. The
    // result lands in no bucket, and the adjacency fallback used to be gated on
    // the call ALSO having no id — so this pair never merged and the tool sat
    // "running" forever with the peek stuck on "waiting for output".
    stubHover(true);
    const call = makeEvent('mixed-call', 'tool.call', {
      tool: 'Bash', toolCallId: 'call-1', input: { command: 'npm run build' },
    }, 1);
    const result = makeEvent('mixed-result', 'tool.result', { output: 'built ok' }, 2);

    const { container } = render(<ChatView events={[call, result]} loading={false} />);

    expect(container.querySelector('.chat-tool-activity.is-running')).toBeNull();
    expect(container.querySelector('.chat-tool-activity-stat.is-complete')?.textContent).toBe('✓1');

    fireEvent.mouseEnter(container.querySelector('.chat-tool-activity') as HTMLElement);
    const peek = document.querySelector('.chat-tool-peek');
    expect(peek?.classList.contains('is-running')).toBe(false);
    expect(peek?.textContent).toContain('built ok');
  });

  it('refuses to let an id-bearing call steal a result owned by another call', async () => {
    // The fallback must stay narrow: a result carrying a DIFFERENT id belongs to
    // someone else, and matching it would reintroduce the concurrent cross-talk
    // the correlation path exists to prevent.
    const callA = makeEvent('own-a', 'tool.call', {
      tool: 'Bash', toolCallId: 'call-a', input: { command: 'a' },
    }, 1);
    const resultB = makeEvent('own-rb', 'tool.result', { toolCallId: 'call-b', output: 'B done' }, 2);

    const { container } = render(<ChatView events={[callA, resultB]} loading={false} />);

    // call-a must stay running — resultB is not its result.
    expect(container.querySelector('.chat-tool-activity-stat.is-running')?.textContent).toBe('●1');
  });

  it('still pairs by adjacency when no correlation id is present', async () => {
    // Older events and providers that omit the id must keep the previous
    // behaviour rather than silently stop merging.
    const call = makeEvent('legacy-call', 'tool.call', { tool: 'Bash', input: { command: 'ls' } }, 1);
    const result = makeEvent('legacy-result', 'tool.result', { output: 'ok' }, 2);

    const { container } = render(<ChatView events={[call, result]} loading={false} />);

    expect(container.querySelector('.chat-tool-activity-stat.is-running')).toBeNull();
    expect(container.querySelector('.chat-tool-activity-stat.is-complete')?.textContent).toBe('✓1');
  });
  it('separates a call and result more than ten events apart, given ids', async () => {
    // The old scan gave up after ten events. With a correlation id that window
    // is meaningless — a slow tool's result legitimately lands much later.
    const call = makeEvent('far-call', 'tool.call', {
      tool: 'Bash', toolCallId: 'call-far', input: { command: 'slow' },
    }, 1);
    const filler = Array.from({ length: 14 }, (_, n) => makeEvent(
      `filler-${n}`, 'assistant.text', { text: `chatter ${n}` }, n + 2,
    ));
    const result = makeEvent('far-result', 'tool.result', {
      toolCallId: 'call-far', output: 'finally',
    }, 20);

    const { container } = render(<ChatView events={[call, ...filler, result]} loading={false} />);

    expect(container.querySelector('.chat-tool-activity-stat.is-running')).toBeNull();
  });

  it('does not let two calls consume the same result when an id repeats', async () => {
    // A reused id must not merge twice; the second call stays unmerged rather
    // than stealing the first call's result.
    const callA = makeEvent('dup-a', 'tool.call', { tool: 'Bash', toolCallId: 'dup', input: { command: 'a' } }, 1);
    const callB = makeEvent('dup-b', 'tool.call', { tool: 'Bash', toolCallId: 'dup', input: { command: 'b' } }, 2);
    const only = makeEvent('dup-r', 'tool.result', { toolCallId: 'dup', output: 'one' }, 3);

    const { container } = render(<ChatView events={[callA, callB, only]} loading={false} />);

    // Exactly one completed, exactly one still running — never two completions
    // from a single result.
    expect(container.querySelector('.chat-tool-activity-stat.is-complete')?.textContent).toBe('✓1');
    expect(container.querySelector('.chat-tool-activity-stat.is-running')?.textContent).toBe('●1');
  });

  it('still mispairs nothing when NO ids are present and tools run in parallel', async () => {
    // The fallback is adjacency, which cannot pair callA/resultA across callB.
    // Locking current behaviour so the producers that now emit ids are the fix,
    // not a silent change here.
    const callA = makeEvent('nid-a', 'tool.call', { tool: 'Bash', input: { command: 'a' } }, 1);
    const callB = makeEvent('nid-b', 'tool.call', { tool: 'Grep', input: { pattern: 'b' } }, 2);
    const resultA = makeEvent('nid-ra', 'tool.result', { output: 'A' }, 3);
    const resultB = makeEvent('nid-rb', 'tool.result', { output: 'B' }, 4);

    const { container } = render(<ChatView events={[callA, callB, resultA, resultB]} loading={false} />);

    // Documents the known limit of the id-less path: one call cannot pair.
    expect(container.querySelector('.chat-tool-activity-stat.is-running')?.textContent).toBe('●1');
  });

  it('reveals the whole last command and its output on hover, not the one-line preview', () => {
    stubHover(true);
    const call = makeEvent('peek-call', 'tool.call', {
      tool: 'Bash',
      input: { command: 'npm run build \\\n  --workspace web' },
    }, 1);
    const result = makeEvent('peek-result', 'tool.result', {
      output: 'built in 4.2s\n  dist/index.js  120kb',
    }, 2);

    const { container } = render(<ChatView events={[call, result]} loading={false} />);

    // The chip itself stays one line — the peek is what carries the detail.
    expect(container.querySelector('.chat-tool-activity-last-input')?.textContent)
      .toBe('npm run build \\');
    expect(document.querySelector('.chat-tool-peek')).toBeNull();

    fireEvent.mouseEnter(container.querySelector('.chat-tool-activity') as HTMLElement);

    const peek = document.querySelector('.chat-tool-peek');
    expect(peek).not.toBeNull();
    expect(peek?.textContent).toContain('Bash');
    expect(peek?.textContent).toContain('Done');
    // Both lines of the command, and the real output — neither is truncated.
    expect(peek?.textContent).toContain('npm run build \\\n  --workspace web');
    expect(peek?.textContent).toContain('built in 4.2s\n  dist/index.js  120kb');

    fireEvent.mouseLeave(container.querySelector('.chat-tool-activity') as HTMLElement);
    expect(document.querySelector('.chat-tool-peek')).toBeNull();
  });

  it('updates an open peek when the running tool produces its result', () => {
    stubHover(true);
    const call = makeEvent('live-call', 'tool.call', {
      tool: 'Bash',
      input: { command: 'sleep 1' },
    }, 1);

    const { container, rerender } = render(<ChatView events={[call]} loading={false} />);
    fireEvent.mouseEnter(container.querySelector('.chat-tool-activity') as HTMLElement);

    expect(document.querySelector('.chat-tool-peek')?.classList.contains('is-running')).toBe(true);
    expect(document.querySelector('.chat-tool-peek')?.textContent).toContain('Waiting for output…');
    expect(document.querySelector('.chat-tool-peek-pending')).not.toBeNull();

    const result = makeEvent('live-result', 'tool.result', { output: 'slept' }, 2);
    rerender(<ChatView events={[call, result]} loading={false} />);

    // Same hover, no re-enter: the panel tracks the live event stream.
    const peek = document.querySelector('.chat-tool-peek');
    expect(peek?.classList.contains('is-running')).toBe(false);
    expect(document.querySelector('.chat-tool-peek-pending')).toBeNull();
    expect(peek?.textContent).toContain('slept');
  });

  it('surfaces the failure text instead of an empty output block', () => {
    stubHover(true);
    const call = makeEvent('fail-call', 'tool.call', {
      tool: 'Write',
      input: { file_path: 'locked.txt' },
    }, 1);
    const result = makeEvent('fail-result', 'tool.result', { error: 'EACCES: permission denied' }, 2);

    const { container } = render(<ChatView events={[call, result]} loading={false} />);
    fireEvent.mouseEnter(container.querySelector('.chat-tool-activity') as HTMLElement);

    const peek = document.querySelector('.chat-tool-peek');
    expect(peek?.classList.contains('is-failed')).toBe(true);
    expect(peek?.textContent).toContain('Failed');
    expect(peek?.textContent).toContain('EACCES: permission denied');
  });

  it('opens on keyboard focus even where the pointer gate would refuse', () => {
    // A device that reports no hover can still have a keyboard. Gating focus on
    // hover capability made the panel unreachable for those users.
    stubHover(false);
    const call = makeEvent('kbd-call', 'tool.call', { tool: 'Bash', input: { command: 'ls' } }, 1);
    const result = makeEvent('kbd-result', 'tool.result', { output: 'a b c' }, 2);

    const { container } = render(<ChatView events={[call, result]} loading={false} />);
    const chip = container.querySelector('.chat-tool-activity') as HTMLElement;

    fireEvent.mouseEnter(chip);
    expect(document.querySelector('.chat-tool-peek')).toBeNull(); // pointer still gated

    // Real DOM focus (a synthetic `focus` event does not reach this button's
    // handler), wrapped in act so the resulting state update is flushed before
    // the assertion reads the DOM.
    act(() => { chip.focus(); });
    const peek = document.querySelector('.chat-tool-peek');
    expect(peek).not.toBeNull();
    // The open panel must be announced, not just painted.
    expect(chip.getAttribute('aria-describedby')).toBe(peek?.id);

    act(() => { chip.blur(); });
    expect(document.querySelector('.chat-tool-peek')).toBeNull();
  });

  it('carries no native title that would stack on top of the peek', () => {
    stubHover(true);
    const call = makeEvent('title-call', 'tool.call', { tool: 'Bash', input: { command: 'ls' } }, 1);
    const result = makeEvent('title-result', 'tool.result', { output: 'ok' }, 2);

    const { container } = render(<ChatView events={[call, result]} loading={false} />);

    expect(container.querySelector('.chat-tool-activity')?.getAttribute('title')).toBeNull();
    expect(container.querySelector('.chat-tool-activity-last')?.getAttribute('title')).toBeNull();
  });

  it('refuses adjacency when the result declares a different owner', () => {
    // Reverse mixed shape: the CALL has no id, the RESULT does. The result has
    // already named its owner, so adjacency must not claim it — otherwise
    // concurrent tools cross-talk in exactly the direction the correlation map
    // exists to prevent.
    const call = makeEvent('rev-call', 'tool.call', { tool: 'Bash', input: { command: 'a' } }, 1);
    const result = makeEvent('rev-result', 'tool.result', { toolCallId: 'someone-else', output: 'B' }, 2);

    const { container } = render(<ChatView events={[call, result]} loading={false} />);

    // The idless call must stay running: that result is not its result.
    expect(container.querySelector('.chat-tool-activity-stat.is-running')?.textContent).toBe('●1');
  });

  it('closes the peek when the chip scrolls off the side, not just the top', () => {
    stubHover(true);
    const call = makeEvent('side-call', 'tool.call', { tool: 'Bash', input: { command: 'ls' } }, 1);
    const result = makeEvent('side-result', 'tool.result', { output: 'ok' }, 2);
    const { container } = render(<ChatView events={[call, result]} loading={false} />);
    const chip = container.querySelector('.chat-tool-activity') as HTMLElement;

    fireEvent.mouseEnter(chip);
    expect(document.querySelector('.chat-tool-peek')).not.toBeNull();

    // Horizontal scroll carries the chip out to the left. Checking only
    // top/bottom left the panel pinned to the screen edge with nothing to anchor.
    chip.getBoundingClientRect = () => ({
      top: 100, bottom: 130, left: -400, right: -200, width: 200, height: 30, x: -400, y: 100,
      toJSON: () => ({}),
    }) as DOMRect;
    act(() => { window.dispatchEvent(new Event('scroll')); });

    expect(document.querySelector('.chat-tool-peek')).toBeNull();
  });

  it('stays closed on touch clients, where hover would fight the expand tap', () => {
    stubHover(false);
    const call = makeEvent('touch-call', 'tool.call', { tool: 'Bash', input: { command: 'ls' } }, 1);
    const result = makeEvent('touch-result', 'tool.result', { output: 'a b c' }, 2);

    const { container } = render(<ChatView events={[call, result]} loading={false} />);
    const chip = container.querySelector('.chat-tool-activity') as HTMLElement;

    fireEvent.mouseEnter(chip);
    expect(document.querySelector('.chat-tool-peek')).toBeNull();

    // The tap still toggles the existing details, unchanged.
    fireEvent.click(chip);
    expect(container.querySelector('.chat-tool-activity-details')).not.toBeNull();
  });
});
