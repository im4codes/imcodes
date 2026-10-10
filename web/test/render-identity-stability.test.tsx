/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { act, cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));
import { useStructuralIdentity } from '../src/hooks/useStructuralIdentity.js';
import { __resetQuickDataForTests, useQuickData } from '../src/components/QuickInputPanel.js';

describe('useStructuralIdentity', () => {
  afterEach(() => cleanup());

  function probe() {
    const seen: unknown[] = [];
    function C(props: { value: unknown }) { seen.push(useStructuralIdentity(props.value)); return null; }
    return { seen, C };
  }

  it('keeps the first reference while later values are structurally equal', () => {
    const { seen, C } = probe();
    const view = render(<C value={[{ n: 'a', state: 'idle' }, { n: 'b', state: 'idle' }]} />);
    view.rerender(<C value={[{ n: 'a', state: 'idle' }, { n: 'b', state: 'idle' }]} />);
    view.rerender(<C value={[{ n: 'a', state: 'idle' }, { n: 'b', state: 'idle' }]} />);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).toBe(seen[0]);
  });

  // Counterexample: a real change must produce a new reference (and then hold it).
  it('switches to the new reference when content changes, then holds it', () => {
    const { seen, C } = probe();
    const view = render(<C value={[{ n: 'a', state: 'idle' }]} />);
    view.rerender(<C value={[{ n: 'a', state: 'running' }]} />);
    view.rerender(<C value={[{ n: 'a', state: 'running' }]} />);
    expect(seen[1]).not.toBe(seen[0]);
    expect((seen[1] as Array<{ state: string }>)[0]!.state).toBe('running');
    expect(seen[2]).toBe(seen[1]);
  });
});

describe('useQuickData keeps one identity between renders', () => {
  afterEach(() => { cleanup(); __resetQuickDataForTests(); });

  it('returns the same object (and the same mutators) on every render until the data changes', async () => {
    const seen: Array<ReturnType<typeof useQuickData>> = [];
    function C() { seen.push(useQuickData()); return null; }
    const view = render(<C />);
    view.rerender(<C />);
    view.rerender(<C />);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).toBe(seen[0]);
    expect(seen[1]!.recordHistory).toBe(seen[0]!.recordHistory);
    // Counterexample: a mutation changes the data, so consumers do get a new object.
    await act(async () => { seen[0]!.addPhrase('a new phrase'); });
    const latest = seen.at(-1)!;
    expect(latest.data.phrases).toContain('a new phrase');
    expect(latest).not.toBe(seen[0]);
  });
});
