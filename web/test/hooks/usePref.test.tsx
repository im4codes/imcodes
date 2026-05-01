/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { act, cleanup, render, screen, waitFor } from '@testing-library/preact';
import { usePref, parseString, parseOptionalString, parseBooleanish, parseJsonValue, __resetPrefCacheForTests } from '../../src/hooks/usePref.js';
import { __resetSharedResourcesForTests } from '../../src/stores/shared-resource.js';
import type { UserPrefChangedMeta } from '../../src/api.js';

const getUserPrefMock = vi.fn();
const saveUserPrefMock = vi.fn();
let prefListeners: Array<(key: string, value: unknown, meta: UserPrefChangedMeta) => void> = [];
const onUserPrefChangedMock = vi.fn((cb: (key: string, value: unknown, meta: UserPrefChangedMeta) => void) => {
  prefListeners.push(cb);
  return () => { prefListeners = prefListeners.filter((entry) => entry !== cb); };
});

vi.mock('../../src/api.js', () => ({
  getUserPref: (...args: unknown[]) => getUserPrefMock(...args),
  saveUserPref: (...args: unknown[]) => saveUserPrefMock(...args),
  onUserPrefChanged: (...args: unknown[]) => onUserPrefChangedMock(...args as [(key: string, value: unknown, meta: UserPrefChangedMeta) => void]),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function Probe({ prefKey, label = 'value', legacyKey }: { prefKey: string | null; label?: string; legacyKey?: string }) {
  const pref = usePref<string>(prefKey, { parse: parseString, legacyKey });
  return (
    <div>
      <div data-testid={label}>{String(pref.value ?? '')}:{String(pref.loaded)}</div>
      <button data-testid={`${label}-save`} onClick={() => { void pref.save('saved').catch(() => undefined); }}>save</button>
      <button data-testid={`${label}-set`} onClick={() => pref.set('set-local')}>set</button>
      <button data-testid={`${label}-reload`} onClick={() => { void pref.reload().catch(() => undefined); }}>reload</button>
    </div>
  );
}

function NullableProbe({ prefKey, legacyKey }: { prefKey: string; legacyKey?: string }) {
  const pref = usePref<string | null>(prefKey, { parse: parseOptionalString, legacyKey });
  return (
    <div>
      <div data-testid="nullable">{pref.rawValue == null ? 'null' : String(pref.rawValue)}:{String(pref.loaded)}</div>
      <button data-testid="nullable-save-null" onClick={() => { void pref.save(null).catch(() => undefined); }}>save-null</button>
      <button data-testid="nullable-set-null" onClick={() => pref.set(null)}>set-null</button>
    </div>
  );
}

function JsonProbe({ prefKey, label = 'json' }: { prefKey: string; label?: string }) {
  const pref = usePref<{ enabled: boolean }>(prefKey, {
    parse: (raw) => parseJsonValue(raw, (value) => (
      value && typeof value === 'object' && typeof (value as { enabled?: unknown }).enabled === 'boolean'
        ? value as { enabled: boolean }
        : null
    )),
    serialize: (value) => JSON.stringify(value),
  });
  return (
    <div>
      <div data-testid={label}>{pref.value ? String(pref.value.enabled) : 'null'}:{String(pref.loaded)}</div>
      <button data-testid={`${label}-save`} onClick={() => { void pref.save({ enabled: false }).catch(() => undefined); }}>save-json</button>
    </div>
  );
}

function SwitchingProbe() {
  const [prefKey, setPrefKey] = useState<'a' | 'b'>('a');
  const pref = usePref<string>(prefKey, { parse: parseString });
  return (
    <div>
      <div data-testid="switching">{prefKey}:{String(pref.value ?? '')}</div>
      <button data-testid="switch-key" onClick={() => setPrefKey('b')}>switch</button>
    </div>
  );
}

function emitPrefChanged(key: string, value: unknown, source: UserPrefChangedMeta['source'] = 'local'): void {
  act(() => prefListeners[0]?.(key, value, { source }));
}

beforeEach(() => {
  getUserPrefMock.mockResolvedValue(null);
  saveUserPrefMock.mockResolvedValue(undefined);
  prefListeners = [];
});

afterEach(() => {
  cleanup();
  __resetPrefCacheForTests();
  __resetSharedResourcesForTests();
  vi.clearAllMocks();
});

describe('usePref', () => {
  it('shares one GET across consumers and supports event mutation without refetch', async () => {
    getUserPrefMock.mockResolvedValue('initial');
    render(<><Probe prefKey="k" label="a" /><Probe prefKey="k" label="b" /></>);
    await screen.findAllByText('initial:true');
    expect(getUserPrefMock).toHaveBeenCalledTimes(1);
    emitPrefChanged('k', 'event', 'broadcast');
    expect(screen.getByTestId('a').textContent).toBe('event:true');
    expect(getUserPrefMock).toHaveBeenCalledTimes(1);
    expect(onUserPrefChangedMock).toHaveBeenCalledTimes(1);
  });

  it('handles nullable keys without network IO', () => {
    render(<Probe prefKey={null} />);
    expect(screen.getByTestId('value').textContent).toBe(':false');
    expect(getUserPrefMock).not.toHaveBeenCalled();
  });

  it('saves optimistically and propagates failure without rollback', async () => {
    saveUserPrefMock.mockRejectedValueOnce(new Error('down'));
    render(<Probe prefKey="k" />);
    await screen.findByText(':true');
    await act(async () => { screen.getByTestId('value-save').click(); await Promise.resolve(); });
    expect(screen.getByTestId('value').textContent).toBe('saved:true');
    expect(saveUserPrefMock).toHaveBeenCalledWith('k', 'saved');
  });

  it('parses raw JSON per consumer and serializes typed saves', async () => {
    getUserPrefMock.mockResolvedValue(JSON.stringify({ enabled: true }));
    render(<JsonProbe prefKey="json-key" />);
    await screen.findByText('true:true');
    await act(async () => { screen.getByTestId('json-save').click(); await Promise.resolve(); });
    expect(screen.getByTestId('json').textContent).toBe('false:true');
    expect(saveUserPrefMock).toHaveBeenCalledWith('json-key', JSON.stringify({ enabled: false }));
  });

  it('isolates parser rejection to the rejecting consumer without clearing raw cache', async () => {
    getUserPrefMock.mockResolvedValue('not-json');
    render(<><Probe prefKey="shared" label="string" /><JsonProbe prefKey="shared" /></>);
    await screen.findByText('not-json:true');
    expect(screen.getByTestId('json').textContent).toBe('null:true');
    expect(getUserPrefMock).toHaveBeenCalledTimes(1);
  });

  it('resubscribes when a nullable/session-derived key changes later', async () => {
    getUserPrefMock.mockImplementation(async (key: string) => key === 'a' ? 'value-a' : 'value-b');
    render(<SwitchingProbe />);
    await screen.findByText('a:value-a');
    await act(async () => { screen.getByTestId('switch-key').click(); await Promise.resolve(); });
    await screen.findByText('b:value-b');
    expect(getUserPrefMock).toHaveBeenCalledWith('a');
    expect(getUserPrefMock).toHaveBeenCalledWith('b');
  });

  it('detaches the single dispatcher on reset so a later cache installs a fresh one', async () => {
    getUserPrefMock.mockResolvedValue('initial');
    const first = render(<Probe prefKey="k" />);
    await screen.findByText('initial:true');
    expect(onUserPrefChangedMock).toHaveBeenCalledTimes(1);
    first.unmount();
    __resetPrefCacheForTests();
    render(<Probe prefKey="k" />);
    await screen.findByText('initial:true');
    expect(onUserPrefChangedMock).toHaveBeenCalledTimes(2);
  });

  it('runs legacy fallback when a legacy key is attached after a null primary load', async () => {
    getUserPrefMock.mockImplementation(async (key: string) => {
      if (key === 'primary') return null;
      if (key === 'legacy') return 'legacy-late';
      return null;
    });
    const view = render(<Probe prefKey="primary" />);
    await screen.findByText(':true');
    expect(getUserPrefMock).toHaveBeenCalledWith('primary');
    expect(getUserPrefMock).not.toHaveBeenCalledWith('legacy');

    view.rerender(<Probe prefKey="primary" legacyKey="legacy" />);
    await screen.findByText('legacy-late:true');
    expect(getUserPrefMock).toHaveBeenCalledWith('legacy');
    expect(saveUserPrefMock).toHaveBeenCalledWith('primary', 'legacy-late');
  });

  it('does not run late legacy fallback after the primary is already authoritative', async () => {
    getUserPrefMock.mockImplementation(async (key: string) => {
      if (key === 'primary') return 'primary-value';
      if (key === 'legacy') return 'legacy-value';
      return null;
    });
    const view = render(<Probe prefKey="primary" />);
    await screen.findByText('primary-value:true');

    view.rerender(<Probe prefKey="primary" legacyKey="legacy" />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getUserPrefMock).not.toHaveBeenCalledWith('legacy');
    expect(saveUserPrefMock).not.toHaveBeenCalledWith('primary', 'legacy-value');
    expect(screen.getByTestId('value').textContent).toBe('primary-value:true');
  });

  it('migrates legacy key once and ignores legacy event after primary save', async () => {
    getUserPrefMock.mockImplementation(async (key: string) => key === 'primary' ? null : 'legacy');
    render(<Probe prefKey="primary" legacyKey="legacy" />);
    await screen.findByText('legacy:true');
    expect(saveUserPrefMock).toHaveBeenCalledWith('primary', 'legacy');
    await act(async () => { screen.getByTestId('value-save').click(); await Promise.resolve(); });
    emitPrefChanged('legacy', 'old-legacy');
    expect(screen.getByTestId('value').textContent).toBe('saved:true');
  });

  it('ignores legacy events after a non-null primary value has loaded', async () => {
    getUserPrefMock.mockImplementation(async (key: string) => key === 'primary' ? 'primary-value' : 'legacy-value');
    render(<Probe prefKey="primary" legacyKey="legacy" />);
    await screen.findByText('primary-value:true');
    emitPrefChanged('legacy', 'legacy-event');
    expect(screen.getByTestId('value').textContent).toBe('primary-value:true');
    expect(saveUserPrefMock).not.toHaveBeenCalledWith('primary', 'legacy-event');
  });

  it('ignores older save echoes after a newer save', async () => {
    render(<Probe prefKey="k" />);
    await screen.findByText(':true');
    await act(async () => { screen.getByTestId('value-save').click(); await Promise.resolve(); });
    function Saver() {
      const pref = usePref<string>('k', { parse: parseString });
      return <button data-testid="save-newer" onClick={() => { void pref.save('newer').catch(() => undefined); }}>{pref.value}</button>;
    }
    render(<Saver />);
    await act(async () => { screen.getByTestId('save-newer').click(); await Promise.resolve(); });
    emitPrefChanged('k', 'saved');
    expect(screen.getByTestId('value').textContent).toBe('newer:true');
  });

  it('ignores older save echoes after a newer local set', async () => {
    render(<Probe prefKey="k" />);
    await screen.findByText(':true');
    await act(async () => { screen.getByTestId('value-save').click(); await Promise.resolve(); });
    act(() => { screen.getByTestId('value-set').click(); });
    emitPrefChanged('k', 'saved');
    expect(screen.getByTestId('value').textContent).toBe('set-local:true');
  });

  it('lets a primary save win over in-flight legacy migration and delayed migration echo', async () => {
    getUserPrefMock.mockImplementation((key: string) => {
      if (key === 'primary') return Promise.resolve(null);
      if (key === 'legacy') return Promise.resolve('legacy-value');
      return Promise.resolve(null);
    });
    const migrationSave = deferred<void>();
    saveUserPrefMock.mockReturnValueOnce(migrationSave.promise).mockResolvedValue(undefined);
    render(<Probe prefKey="primary" legacyKey="legacy" />);
    await screen.findByText('legacy-value:true');
    expect(saveUserPrefMock).toHaveBeenCalledWith('primary', 'legacy-value');
    await act(async () => { screen.getByTestId('value-save').click(); await Promise.resolve(); });
    emitPrefChanged('primary', 'legacy-value');
    expect(screen.getByTestId('value').textContent).toBe('saved:true');
  });

  it('applies unknown cross-tab primary events without refetching', async () => {
    render(<Probe prefKey="k" />);
    await screen.findByText(':true');
    getUserPrefMock.mockClear();
    emitPrefChanged('k', 'external', 'broadcast');
    expect(screen.getByTestId('value').textContent).toBe('external:true');
    expect(getUserPrefMock).not.toHaveBeenCalled();
  });

  it('applies repeated-value cross-tab events even when they match older local writes', async () => {
    render(<Probe prefKey="k" />);
    await screen.findByText(':true');
    await act(async () => { screen.getByTestId('value-save').click(); await Promise.resolve(); });
    function Saver() {
      const pref = usePref<string>('k', { parse: parseString });
      return <button data-testid="save-newer" onClick={() => { void pref.save('newer').catch(() => undefined); }}>{pref.value}</button>;
    }
    render(<Saver />);
    await act(async () => { screen.getByTestId('save-newer').click(); await Promise.resolve(); });
    emitPrefChanged('k', 'saved', 'broadcast');
    expect(screen.getByTestId('value').textContent).toBe('saved:true');
  });

  it('ignores evicted old local echoes after a burst of newer writes', async () => {
    function Burst() {
      const pref = usePref<string>('k', { parse: parseString });
      return (
        <div>
          <div data-testid="burst-value">{String(pref.value ?? '')}</div>
          <button
            data-testid="burst"
            onClick={() => {
              void pref.save('old').catch(() => undefined);
              for (let index = 0; index < 25; index += 1) {
                void pref.save(`new-${index}`).catch(() => undefined);
              }
            }}
          >
            burst
          </button>
        </div>
      );
    }
    render(<Burst />);
    await waitFor(() => expect(getUserPrefMock).toHaveBeenCalledWith('k'));
    await act(async () => { screen.getByTestId('burst').click(); await Promise.resolve(); });
    expect(screen.getByTestId('burst-value').textContent).toBe('new-24');
    emitPrefChanged('k', 'old');
    expect(screen.getByTestId('burst-value').textContent).toBe('new-24');
  });

  it('treats legacy null events as migration attempted without saving primary', async () => {
    const primary = deferred<unknown | null>();
    getUserPrefMock.mockReturnValue(primary.promise);
    render(<Probe prefKey="primary" legacyKey="legacy" />);
    await waitFor(() => expect(onUserPrefChangedMock).toHaveBeenCalledTimes(1));
    saveUserPrefMock.mockClear();
    emitPrefChanged('legacy', null);
    expect(saveUserPrefMock).not.toHaveBeenCalled();
    primary.resolve(null);
    await screen.findByText(':true');
    expect(getUserPrefMock).not.toHaveBeenCalledWith('legacy');
    expect(screen.getByTestId('value').textContent).toBe(':true');
  });

  it('treats a persisted primary null as authoritative against later legacy events', async () => {
    render(<NullableProbe prefKey="primary" legacyKey="legacy" />);
    await screen.findByText('null:true');
    await act(async () => { screen.getByTestId('nullable-save-null').click(); await Promise.resolve(); });
    expect(saveUserPrefMock).toHaveBeenCalledWith('primary', null);
    emitPrefChanged('legacy', 'legacy-value');
    expect(screen.getByTestId('nullable').textContent).toBe('null:true');
  });

  it('keeps local set(null) ephemeral so a later legacy event can repopulate', async () => {
    render(<NullableProbe prefKey="primary" legacyKey="legacy" />);
    await screen.findByText('null:true');
    act(() => { screen.getByTestId('nullable-set-null').click(); });
    emitPrefChanged('legacy', 'legacy-value');
    expect(screen.getByTestId('nullable').textContent).toBe('legacy-value:true');
  });

  it('does not let a failed primary save permanently block later eligible legacy events', async () => {
    saveUserPrefMock.mockRejectedValueOnce(new Error('down')).mockResolvedValue(undefined);
    render(<Probe prefKey="primary" legacyKey="legacy" />);
    await screen.findByText(':true');
    await act(async () => { screen.getByTestId('value-save').click(); await Promise.resolve(); });
    expect(screen.getByTestId('value').textContent).toBe('saved:true');
    emitPrefChanged('legacy', 'legacy-after-failure');
    expect(screen.getByTestId('value').textContent).toBe('legacy-after-failure:true');
    expect(saveUserPrefMock).toHaveBeenCalledWith('primary', 'legacy-after-failure');
  });

  it('keeps prior primary authority when a later primary save fails', async () => {
    saveUserPrefMock.mockRejectedValueOnce(new Error('down'));
    getUserPrefMock.mockImplementation(async (key: string) => key === 'primary' ? 'persisted-primary' : null);
    render(<Probe prefKey="primary" legacyKey="legacy" />);
    await screen.findByText('persisted-primary:true');
    await act(async () => { screen.getByTestId('value-save').click(); await Promise.resolve(); });
    expect(screen.getByTestId('value').textContent).toBe('saved:true');
    emitPrefChanged('legacy', 'legacy-after-failure');
    expect(screen.getByTestId('value').textContent).toBe('saved:true');
    expect(saveUserPrefMock).not.toHaveBeenCalledWith('primary', 'legacy-after-failure');
  });

  it('protects a newer local set from legacy migration events', async () => {
    render(<Probe prefKey="primary" legacyKey="legacy" />);
    await screen.findByText(':true');
    act(() => { screen.getByTestId('value-set').click(); });
    emitPrefChanged('legacy', 'legacy-after-set');
    expect(screen.getByTestId('value').textContent).toBe('set-local:true');
    expect(saveUserPrefMock).not.toHaveBeenCalledWith('primary', 'legacy-after-set');
  });

  it('parses booleanish values', () => {
    expect(parseBooleanish(true)).toBe(true);
    expect(parseBooleanish('true')).toBe(true);
    expect(parseBooleanish(false)).toBe(false);
  });
});
