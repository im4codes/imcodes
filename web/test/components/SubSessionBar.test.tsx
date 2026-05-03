/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (key === 'subsessionBar.subs_count') return `Subs (${vars?.count ?? 0})`;
      return key;
    },
  }),
}));

vi.mock('../../src/components/SubSessionCard.js', () => ({
  SubSessionCard: () => null,
}));

vi.mock('../../src/components/P2pProgressCard.js', () => ({
  P2pProgressCard: ({ hidden, onToggleHide }: { hidden?: boolean; onToggleHide?: () => void }) => (
    <div>
      <span data-testid="p2p-hidden-state">{hidden ? 'hidden' : 'visible'}</span>
      {onToggleHide && <button onClick={onToggleHide}>toggle-p2p-hide</button>}
    </div>
  ),
}));

vi.mock('../../src/api.js', () => ({
  reorderSubSessions: vi.fn(),
}));

import { SubSessionBar } from '../../src/components/SubSessionBar.js';
import type { SubSession } from '../../src/hooks/useSubSessions.js';

function makeSubSession(overrides: Partial<SubSession> = {}): SubSession {
  return {
    id: 'sub-1',
    serverId: 'srv-1',
    type: 'codex',
    shellBin: null,
    cwd: '/tmp',
    label: 'worker',
    ccSessionId: null,
    geminiSessionId: null,
    parentSession: 'deck_proj_brain',
    ccPresetId: null,
    sessionName: 'deck_sub_sub-1',
    state: 'idle',
    ...overrides,
  };
}

describe('SubSessionBar', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('only applies the running pulse to collapsed mini cards while the sub-session is running', () => {
    const idleView = render(
      <SubSessionBar
        subSessions={[makeSubSession({ state: 'idle' })]}
        openIds={new Set()}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    fireEvent.click(idleView.container.querySelector('.subcard-toolbar-btn') as HTMLButtonElement);
    const idleCard = idleView.container.querySelector('.subsession-card') as HTMLButtonElement;
    expect(idleCard.className).not.toContain('subcard-running-pulse');
    idleView.unmount();

    const runningView = render(
      <SubSessionBar
        subSessions={[makeSubSession({ state: 'running' })]}
        openIds={new Set()}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    if (!runningView.container.querySelector('.subsession-bar')) {
      fireEvent.click(runningView.container.querySelector('.subcard-toolbar-btn') as HTMLButtonElement);
    }
    const runningCard = runningView.container.querySelector('.subsession-card') as HTMLButtonElement;
    expect(runningCard.className).toContain('subcard-running-pulse');
  });

  it('shows idle flash on collapsed buttons only when the token increments after mount', () => {
    const view = render(
      <SubSessionBar
        subSessions={[makeSubSession({ state: 'idle' })]}
        openIds={new Set()}
        idleFlashTokens={new Map([['deck_sub_sub-1', 1]])}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    fireEvent.click(view.container.querySelector('.subcard-toolbar-btn') as HTMLButtonElement);
    expect(view.container.querySelector('.idle-flash-layer--frame')).toBeNull();

    view.rerender(
      <SubSessionBar
        subSessions={[makeSubSession({ state: 'idle' })]}
        openIds={new Set()}
        idleFlashTokens={new Map([['deck_sub_sub-1', 2]])}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    expect(view.container.querySelector('.idle-flash-layer--frame')).not.toBeNull();
  });

  it('registers a non-passive touchmove guard for the horizontal cards strip', () => {
    const addSpy = vi.spyOn(HTMLDivElement.prototype, 'addEventListener');

    render(
      <SubSessionBar
        subSessions={[makeSubSession({ state: 'idle' })]}
        openIds={new Set()}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    expect(addSpy.mock.calls.some(([type, , options]) => type === 'touchmove' && typeof options === 'object' && (options as AddEventListenerOptions).passive === false)).toBe(true);
  });

  it('persists the collapsed toolbar state locally', () => {
    const first = render(
      <SubSessionBar
        subSessions={[makeSubSession({ state: 'idle' })]}
        openIds={new Set()}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    fireEvent.click(first.container.querySelector('.subcard-toolbar-btn') as HTMLButtonElement);
    first.unmount();

    const second = render(
      <SubSessionBar
        subSessions={[makeSubSession({ state: 'idle' })]}
        openIds={new Set()}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
      />,
    );

    expect(second.container.querySelector('.subsession-bar')).not.toBeNull();
  });

  it('uses saved codex preference as legacy fallback for collapsed model-less codex-sdk sessions', () => {
    localStorage.setItem('imcodes-codex-model:deck_sub_sub-1', 'gpt-5.5');
    const view = render(
      <SubSessionBar
        subSessions={[makeSubSession({ type: 'codex-sdk' } as any)]}
        openIds={new Set()}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
        subUsages={new Map([[
          'deck_sub_sub-1',
          { inputTokens: 166_000, cacheTokens: 0, contextWindow: 258_400, contextWindowSource: 'provider' },
        ]]) as any}
      />,
    );

    fireEvent.click(view.container.querySelector('.subcard-toolbar-btn') as HTMLButtonElement);
    const card = view.container.querySelector('.subsession-card') as HTMLButtonElement;
    expect(card.title).toContain('gpt-5.5');
    expect(card.title).toContain('ctx 18%');
    expect(card.title).not.toContain('ctx 64%');
  });

  it('uses sub-session model metadata when collapsed usage omits model but provider window is stale', () => {
    const view = render(
      <SubSessionBar
        subSessions={[makeSubSession({ type: 'codex-sdk', activeModel: 'gpt-5.5' } as any)]}
        openIds={new Set()}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRestart={vi.fn()}
        onNew={vi.fn()}
        ws={null}
        connected={true}
        onDiff={vi.fn()}
        onHistory={vi.fn()}
        subUsages={new Map([[
          'deck_sub_sub-1',
          { inputTokens: 100_000, cacheTokens: 0, contextWindow: 258_400, contextWindowSource: 'provider' },
        ]]) as any}
      />,
    );

    fireEvent.click(view.container.querySelector('.subcard-toolbar-btn') as HTMLButtonElement);
    const card = view.container.querySelector('.subsession-card') as HTMLButtonElement;
    expect(card.title).toContain('gpt-5.5');
    expect(card.title).toContain('ctx 11%');
    expect(card.title).not.toContain('ctx 39%');
  });

});
