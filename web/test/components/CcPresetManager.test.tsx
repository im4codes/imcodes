/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CC_PRESET_MSG, RETIRED_DEFAULT_CC_PRESET_INIT_MESSAGE, type CcPreset } from '@shared/cc-presets.js';
import { DAEMON_MSG } from '@shared/daemon-events.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => (opts ? `${k}:${JSON.stringify(opts)}` : k),
  }),
}));

import { CcPresetEditorPanel, CcPresetManagerDialog } from '../../src/components/CcPresetManager.js';
import { CC_PRESET_REQUEST_TIMEOUT_MS, useCcPresets } from '../../src/hooks/useCcPresets.js';

function makeWs(initialConnected = true) {
  const listeners = new Set<(msg: unknown) => void>();
  const ws = {
    connected: initialConnected,
    send: vi.fn((msg: Record<string, unknown>) => {
      if (!ws.connected) return;
      if (msg.type === CC_PRESET_MSG.SAVE) {
        // Tests that want async/rejected save can spy/override ws.send
      }
    }),
    onMessage: vi.fn((cb: (msg: unknown) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    emit: (msg: unknown) => {
      for (const cb of listeners) cb(msg);
    },
  };
  return ws as any;
}

describe('CcPresetManagerDialog', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('requests presets, creates/edits/deletes presets, discovers models, and closes on Escape', async () => {
    const ws = makeWs();
    const onClose = vi.fn();
    const onToast = vi.fn();

    render(<CcPresetManagerDialog ws={ws} onClose={onClose} onToast={onToast} />);

    expect(screen.getByTestId('cc-preset-manager-dialog')).toBeDefined();
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: CC_PRESET_MSG.LIST,
      requestId: expect.any(String),
    }));
    const listCall1 = ws.send.mock.calls.find((call: any[]) => call[0]?.type === CC_PRESET_MSG.LIST)![0];

    // Confirm authoritative empty list before mutations are allowed
    ws.emit({ type: CC_PRESET_MSG.LIST_RESPONSE, requestId: listCall1.requestId, presets: [] });

    // Create an OpenAI-compatible preset (new draft has no retired DuckDuckGo default initMessage)
    fireEvent.click(screen.getByLabelText('ccPreset.protocolOpenAi'));
    fireEvent.input(screen.getByPlaceholderText('ccPreset.namePlaceholder'), { target: { value: 'DeepSeek-V3' } });
    fireEvent.input(screen.getByPlaceholderText('ccPreset.apiKeyPlaceholder'), { target: { value: 'sk-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'ccPreset.savePresetButton' }));

    const saveCall = ws.send.mock.calls.find((call: any[]) => call[0]?.type === CC_PRESET_MSG.SAVE)?.[0];
    expect(saveCall).toMatchObject({
      type: CC_PRESET_MSG.SAVE,
      requestId: expect.any(String),
      presets: [
        expect.objectContaining({
          name: 'DeepSeek-V3',
          authType: 'openai',
          env: expect.objectContaining({
            OPENAI_API_KEY: 'sk-123',
          }),
        }),
      ],
    });
    expect(saveCall.presets[0].initMessage).toBeUndefined();

    // Confirmed only after SAVE_RESPONSE
    ws.emit({ type: CC_PRESET_MSG.SAVE_RESPONSE, requestId: saveCall.requestId, ok: true });

    // Row renders and supports Edit -> Discover -> Delete
    await waitFor(() => {
      expect(document.querySelector('[data-cc-preset-row="DeepSeek-V3"]')).not.toBeNull();
    });
    fireEvent.click(screen.getByRole('button', { name: 'ccPreset.editButton' }));
    fireEvent.click(screen.getByRole('button', { name: 'ccPreset.discoverModels' }));

    await waitFor(() => {
      const saveCalls = ws.send.mock.calls.filter((call: any[]) => call[0]?.type === CC_PRESET_MSG.SAVE);
      expect(saveCalls.length).toBeGreaterThanOrEqual(2);
    });
    const discoverSaveCall = ws.send.mock.calls.filter((call: any[]) => call[0]?.type === CC_PRESET_MSG.SAVE).at(-1)![0];
    ws.emit({ type: CC_PRESET_MSG.SAVE_RESPONSE, requestId: discoverSaveCall.requestId, ok: true });

    await waitFor(() => {
      expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
        type: CC_PRESET_MSG.DISCOVER_MODELS,
        presetName: 'DeepSeek-V3',
      }));
    });
    const discoverCall = ws.send.mock.calls.find((call: any[]) => call[0]?.type === CC_PRESET_MSG.DISCOVER_MODELS)![0];

    ws.emit({
      type: CC_PRESET_MSG.DISCOVER_MODELS_RESPONSE,
      requestId: discoverCall.requestId,
      presetName: 'DeepSeek-V3',
      ok: true,
      preset: {
        name: 'DeepSeek-V3',
        authType: 'openai',
        env: { OPENAI_BASE_URL: 'https://api.minimax.chat/v1', OPENAI_API_KEY: 'sk-123', OPENAI_MODEL: 'MiniMax-Text-01' },
        availableModels: [{ id: 'MiniMax-Text-01' }, { id: 'MiniMax-M2.7' }],
        defaultModel: 'MiniMax-Text-01',
      },
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue(/MiniMax-Text-01/i)).toBeDefined();
    });

    // Delete preset emits SAVE and waits for SAVE_RESPONSE before showing empty notice
    fireEvent.click(screen.getByRole('button', { name: 'ccPreset.deleteButton' }));
    const deleteCall = ws.send.mock.calls.filter((call: any[]) => call[0]?.type === CC_PRESET_MSG.SAVE).at(-1)![0];
    ws.emit({ type: CC_PRESET_MSG.SAVE_RESPONSE, requestId: deleteCall.requestId, ok: true });
    await waitFor(() => {
      expect(screen.getByTestId('cc-preset-empty')).toBeDefined();
    });

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('uses a single ws subscription across hook consumers, refreshes on reopen/reconnect, and guards SAVE before LIST_RESPONSE or on failure', async () => {
    const ws = makeWs();
    function Consumer({ id }: { id: string }) {
      const { presets } = useCcPresets(ws, { enabled: true });
      return <div data-testid={id}>{presets.map((p) => p.name).join(',')}</div>;
    }

    const view = render(
      <>
        <CcPresetManagerDialog ws={ws} onClose={vi.fn()} />
        <Consumer id="peer-consumer" />
      </>,
    );

    // Single shared ws.onMessage listener across both hook consumers
    expect(ws.onMessage).toHaveBeenCalledTimes(1);
    const listCallsInitial = ws.send.mock.calls.filter((call: any[]) => call[0]?.type === CC_PRESET_MSG.LIST);
    expect(listCallsInitial).toHaveLength(1);

    // Attempting to save BEFORE initial LIST_RESPONSE MUST NOT send SAVE or overwrite remote presets, and preserves draft
    fireEvent.input(screen.getByPlaceholderText('ccPreset.namePlaceholder'), { target: { value: 'DraftEarly' } });
    fireEvent.click(screen.getByRole('button', { name: 'ccPreset.savePresetButton' }));
    expect(ws.send.mock.calls.some((call: any[]) => call[0]?.type === CC_PRESET_MSG.SAVE)).toBe(false);
    expect((screen.getByPlaceholderText('ccPreset.namePlaceholder') as HTMLInputElement).value).toBe('DraftEarly');
    expect(screen.getByRole('alert').textContent).toBe('ccPreset.notLoadedError');

    // Now authoritative LIST_RESPONSE arrives with an existing remote preset
    const existing: CcPreset = {
      name: 'ExistingRemote',
      env: { ANTHROPIC_BASE_URL: 'https://example.com/anthropic', ANTHROPIC_MODEL: 'm1' },
      initMessage: RETIRED_DEFAULT_CC_PRESET_INIT_MESSAGE,
    };
    ws.emit({ type: CC_PRESET_MSG.LIST_RESPONSE, requestId: listCallsInitial[0][0].requestId, presets: [existing] });

    await waitFor(() => {
      expect(screen.getByTestId('peer-consumer').textContent).toBe('ExistingRemote');
    });

    // Editing legacy preset strips retired DuckDuckGo initMessage while preserving custom text later
    fireEvent.click(screen.getByRole('button', { name: 'ccPreset.editButton' }));
    const textareas = document.querySelectorAll('textarea');
    expect((textareas[0] as HTMLTextAreaElement).value).toBe('');

    // Daemon SAVE_RESPONSE failure preserves confirmed presets and retains form draft
    fireEvent.input(screen.getByPlaceholderText('ccPreset.namePlaceholder'), { target: { value: 'NewOne' } });
    fireEvent.click(screen.getByRole('button', { name: 'ccPreset.savePresetButton' }));
    const saveReq = ws.send.mock.calls.filter((call: any[]) => call[0]?.type === CC_PRESET_MSG.SAVE).at(-1)![0];
    expect(saveReq.presets.map((p: CcPreset) => p.name)).toEqual(['ExistingRemote', 'NewOne']);
    ws.emit({ type: CC_PRESET_MSG.SAVE_RESPONSE, requestId: saveReq.requestId, ok: false, error: 'disk readonly' });

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('disk readonly');
    });
    expect(screen.getByTestId('peer-consumer').textContent).toBe('ExistingRemote');
    expect((screen.getByPlaceholderText('ccPreset.namePlaceholder') as HTMLInputElement).value).toBe('NewOne');

    // Offline mutation rejects without sending SAVE and retains draft + confirmed presets
    ws.connected = false;
    fireEvent.click(screen.getByRole('button', { name: 'ccPreset.savePresetButton' }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('new_session.daemon_offline');
    });
    expect(ws.send.mock.calls.filter((call: any[]) => call[0]?.type === CC_PRESET_MSG.SAVE)).toHaveLength(1);
    expect((screen.getByPlaceholderText('ccPreset.namePlaceholder') as HTMLInputElement).value).toBe('NewOne');

    // Reconnect triggers fresh LIST
    ws.connected = true;
    ws.emit({ type: 'session_list', sessions: [] });
    await waitFor(() => {
      const listCalls = ws.send.mock.calls.filter((call: any[]) => call[0]?.type === CC_PRESET_MSG.LIST);
      expect(listCalls.length).toBeGreaterThanOrEqual(2);
    });
    const listReconnectCall = ws.send.mock.calls.filter((call: any[]) => call[0]?.type === CC_PRESET_MSG.LIST).at(-1)![0];
    ws.emit({
      type: CC_PRESET_MSG.LIST_RESPONSE,
      requestId: listReconnectCall.requestId,
      presets: [existing, { name: 'AddedElsewhere', env: { ANTHROPIC_BASE_URL: 'https://x.test', ANTHROPIC_MODEL: 'x1' }, initMessage: 'Custom keep' }],
    });
    await waitFor(() => {
      expect(screen.getByTestId('peer-consumer').textContent).toBe('ExistingRemote,AddedElsewhere');
    });

    // Closing & reopening manager refreshes list even when already loaded once
    view.unmount();
    render(<CcPresetManagerDialog ws={ws} onClose={vi.fn()} />);
    await waitFor(() => {
      const listCalls = ws.send.mock.calls.filter((call: any[]) => call[0]?.type === CC_PRESET_MSG.LIST);
      expect(listCalls.length).toBeGreaterThanOrEqual(3);
    });
  });

  it('blocks saving stale cached list while refresh is in flight, blocks concurrent double-save, handles version conflict, and keeps newer draft edits', async () => {
    const ws = makeWs();
    const presetA: CcPreset = { name: 'PresetA', env: { ANTHROPIC_BASE_URL: 'https://a.test', ANTHROPIC_MODEL: 'a1' } };
    const presetB: CcPreset = { name: 'PresetB', env: { ANTHROPIC_BASE_URL: 'https://b.test', ANTHROPIC_MODEL: 'b1' } };

    const firstMount = render(<CcPresetManagerDialog ws={ws} onClose={vi.fn()} />);
    const list1 = ws.send.mock.calls.filter((call: any[]) => call[0]?.type === CC_PRESET_MSG.LIST).at(-1)![0];
    ws.emit({ type: CC_PRESET_MSG.LIST_RESPONSE, requestId: list1.requestId, version: 'v1', presets: [presetA] });
    await waitFor(() => expect(document.querySelector('[data-cc-preset-row="PresetA"]')).not.toBeNull());
    firstMount.unmount();

    // Device B added PresetB while A was closed; A reopens -> refresh LIST is in-flight over cached [A]
    render(<CcPresetManagerDialog ws={ws} onClose={vi.fn()} />);
    const list2 = ws.send.mock.calls.filter((call: any[]) => call[0]?.type === CC_PRESET_MSG.LIST).at(-1)![0];
    expect(list2.requestId).toEqual(expect.any(String));

    fireEvent.input(screen.getByPlaceholderText('ccPreset.namePlaceholder'), { target: { value: 'PresetC' } });
    fireEvent.click(screen.getByRole('button', { name: 'ccPreset.savePresetButton' }));

    // Must NOT send stale [A, C] while refresh is in-flight!
    expect(ws.send.mock.calls.some((call: any[]) => call[0]?.type === CC_PRESET_MSG.SAVE)).toBe(false);
    expect(screen.getByRole('alert').textContent).toBe('ccPreset.syncingError');
    expect((screen.getByPlaceholderText('ccPreset.namePlaceholder') as HTMLInputElement).value).toBe('PresetC');

    // Fresh LIST_RESPONSE arrives with [PresetA, PresetB] at v2
    ws.emit({ type: CC_PRESET_MSG.LIST_RESPONSE, requestId: list2.requestId, version: 'v2', presets: [presetA, presetB] });
    await waitFor(() => expect(document.querySelector('[data-cc-preset-row="PresetB"]')).not.toBeNull());

    // Now Save C sends expectedVersion 'v2' with [A, B, C]
    fireEvent.click(screen.getByRole('button', { name: 'ccPreset.savePresetButton' }));
    const save1 = ws.send.mock.calls.filter((call: any[]) => call[0]?.type === CC_PRESET_MSG.SAVE).at(-1)![0];
    expect(save1.expectedVersion).toBe('v2');
    expect(save1.presets.map((p: CcPreset) => p.name)).toEqual(['PresetA', 'PresetB', 'PresetC']);

    // While save1 is in-flight, user continues editing to DraftD -> earlier save1 completion must NOT wipe DraftD!
    fireEvent.input(screen.getByPlaceholderText('ccPreset.namePlaceholder'), { target: { value: 'PresetD' } });
    ws.emit({ type: CC_PRESET_MSG.SAVE_RESPONSE, requestId: save1.requestId, ok: true, version: 'v3', presets: save1.presets });
    await waitFor(() => expect(document.querySelector('[data-cc-preset-row="PresetC"]')).not.toBeNull());
    expect((screen.getByPlaceholderText('ccPreset.namePlaceholder') as HTMLInputElement).value).toBe('PresetD');

    // Save PresetD -> simulate daemon version conflict (v4 has PresetX), verify conflict refresh & retry preserves all
    const presetX: CcPreset = { name: 'PresetX', env: { ANTHROPIC_BASE_URL: 'https://x.test', ANTHROPIC_MODEL: 'x1' } };
    fireEvent.click(screen.getByRole('button', { name: 'ccPreset.savePresetButton' }));
    const save2 = ws.send.mock.calls.filter((call: any[]) => call[0]?.type === CC_PRESET_MSG.SAVE).at(-1)![0];
    ws.emit({
      type: CC_PRESET_MSG.SAVE_RESPONSE,
      requestId: save2.requestId,
      ok: false,
      conflict: true,
      version: 'v4',
      presets: [presetA, presetB, presetCOrKeep(presetA), presetX].slice(0, 2).concat([presetX]),
    });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('ccPreset.conflictError'));
    expect((screen.getByPlaceholderText('ccPreset.namePlaceholder') as HTMLInputElement).value).toBe('PresetD');
    expect(document.querySelector('[data-cc-preset-row="PresetB"]')).not.toBeNull();
    expect(document.querySelector('[data-cc-preset-row="PresetX"]')).not.toBeNull();

    function presetCOrKeep(p: CcPreset) { return p; }
  });

  it('recovers cleanly when ws.connected stays true across DAEMON_MSG.DISCONNECTED / RECONNECTED and bounded timeouts', async () => {
    vi.useFakeTimers();
    try {
      const ws = makeWs(true);
      render(<CcPresetManagerDialog ws={ws} onClose={vi.fn()} />);

      const list1 = ws.send.mock.calls.find((call: any[]) => call[0]?.type === CC_PRESET_MSG.LIST)![0];
      ws.emit({ type: CC_PRESET_MSG.LIST_RESPONSE, requestId: list1.requestId, version: 'v1', presets: [] });

      fireEvent.input(screen.getByPlaceholderText('ccPreset.namePlaceholder'), { target: { value: 'GenOneDraft' } });
      fireEvent.click(screen.getByRole('button', { name: 'ccPreset.savePresetButton' }));
      const saveReq1 = ws.send.mock.calls.filter((call: any[]) => call[0]?.type === CC_PRESET_MSG.SAVE).at(-1)![0];
      expect((screen.getByRole('button', { name: 'ccPreset.savingButton' }) as HTMLButtonElement).disabled).toBe(true);

      // Daemon restarts while browser WebSocket stays connected (ws.connected === true)
      await act(async () => { ws.emit({ type: DAEMON_MSG.DISCONNECTED }); });
      expect(screen.getByRole('button', { name: 'ccPreset.savePresetButton' })).toBeDefined();
      expect((screen.getByPlaceholderText('ccPreset.namePlaceholder') as HTMLInputElement).value).toBe('GenOneDraft');

      // Late response from dead generation must be ignored
      await act(async () => {
        ws.emit({ type: CC_PRESET_MSG.SAVE_RESPONSE, requestId: saveReq1.requestId, ok: true, version: 'v-old', presets: [{ name: 'Wrong', env: {} }] });
      });
      expect(document.querySelector('[data-cc-preset-row="Wrong"]')).toBeNull();

      // Daemon reconnects -> refreshes list -> retry succeeds -> timeout recovery also works if response is dropped
      await act(async () => { ws.emit({ type: DAEMON_MSG.RECONNECTED }); });
      const listCalls = ws.send.mock.calls.filter((call: any[]) => call[0]?.type === CC_PRESET_MSG.LIST);
      expect(listCalls.length).toBeGreaterThanOrEqual(2);
      const list2 = listCalls.at(-1)![0];
      await act(async () => {
        ws.emit({ type: CC_PRESET_MSG.LIST_RESPONSE, requestId: list2.requestId, version: 'v2', presets: [] });
      });
      expect(screen.queryByTestId('cc-preset-loading')).toBeNull();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'ccPreset.savePresetButton' }));
      });
      // Drop SAVE_RESPONSE completely and advance past CC_PRESET_REQUEST_TIMEOUT_MS
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CC_PRESET_REQUEST_TIMEOUT_MS);
      });
      expect(screen.getByRole('alert').textContent).toBe('ccPreset.timeoutError');
      expect((screen.getByPlaceholderText('ccPreset.namePlaceholder') as HTMLInputElement).value).toBe('GenOneDraft');
      expect((screen.getByRole('button', { name: 'ccPreset.savePresetButton' }) as HTMLButtonElement).disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores untagged LIST_RESPONSE while activeListRequest is in flight and updates snapshot version on DISCOVER_MODELS_RESPONSE', async () => {
    const ws = makeWs(true);
    const presetA: CcPreset = { name: 'PresetA', env: { ANTHROPIC_BASE_URL: 'https://a.test', ANTHROPIC_MODEL: 'a1' }, defaultModel: 'a1' };
    const presetB: CcPreset = { name: 'PresetB', env: { ANTHROPIC_BASE_URL: 'https://b.test', ANTHROPIC_MODEL: 'b1' }, defaultModel: 'b1' };
    render(<CcPresetManagerDialog ws={ws} onClose={vi.fn()} />);

    const list1 = ws.send.mock.calls.filter((call: any[]) => call[0]?.type === CC_PRESET_MSG.LIST).at(-1)![0];
    // Untagged stale LIST_RESPONSE while list1 is active must be ignored
    ws.emit({ type: CC_PRESET_MSG.LIST_RESPONSE, presets: [{ name: 'StaleUntagged', env: {} }] });
    expect(document.querySelector('[data-cc-preset-row="StaleUntagged"]')).toBeNull();

    // Matching requestId unlocks authoritative list v1
    ws.emit({ type: CC_PRESET_MSG.LIST_RESPONSE, requestId: list1.requestId, version: 'v1', presets: [presetA] });
    await waitFor(() => expect(document.querySelector('[data-cc-preset-row="PresetA"]')).not.toBeNull());

    // Discover models returns merged [PresetA(models), PresetB] + version 'v3'
    fireEvent.click(screen.getByRole('button', { name: 'ccPreset.editButton' }));
    fireEvent.click(screen.getByRole('button', { name: 'ccPreset.discoverModels' }));
    const discoverSave = ws.send.mock.calls.filter((call: any[]) => call[0]?.type === CC_PRESET_MSG.SAVE).at(-1)![0];
    ws.emit({ type: CC_PRESET_MSG.SAVE_RESPONSE, requestId: discoverSave.requestId, ok: true, version: 'v2', presets: discoverSave.presets });
    await waitFor(() => expect(ws.send.mock.calls.some((call: any[]) => call[0]?.type === CC_PRESET_MSG.DISCOVER_MODELS)).toBe(true));
    const discoverReq = ws.send.mock.calls.filter((call: any[]) => call[0]?.type === CC_PRESET_MSG.DISCOVER_MODELS).at(-1)![0];
    const discoveredA: CcPreset = { ...presetA, availableModels: [{ id: 'a1' }, { id: 'a2' }] };
    ws.emit({
      type: CC_PRESET_MSG.DISCOVER_MODELS_RESPONSE,
      requestId: discoverReq.requestId,
      presetName: 'PresetA',
      ok: true,
      preset: discoveredA,
      presets: [discoveredA, presetB],
      version: 'v3',
    });

    await waitFor(() => expect(document.querySelector('[data-cc-preset-row="PresetB"]')).not.toBeNull());

    // Immediate Save right after DISCOVER_MODELS_RESPONSE must send expectedVersion 'v3' without conflict retry
    fireEvent.input(screen.getByPlaceholderText('ccPreset.namePlaceholder'), { target: { value: 'PresetC' } });
    fireEvent.click(screen.getByRole('button', { name: 'ccPreset.savePresetButton' }));
    const immediateSave = ws.send.mock.calls.filter((call: any[]) => call[0]?.type === CC_PRESET_MSG.SAVE).at(-1)![0];
    expect(immediateSave.expectedVersion).toBe('v3');
    expect(immediateSave.presets.map((p: CcPreset) => p.name)).toEqual(['PresetA', 'PresetB', 'PresetC']);
  });

  it('renders Sci-Fi Tech UI classes, protocol pills, env chips, custom env rows, context badge, and row editing state in standalone mode', async () => {
    const ws = makeWs(true);
    const savedPreset: CcPreset = {
      name: 'DeepSeek-Gateway',
      authType: 'openai',
      env: {
        OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
        OPENAI_API_KEY: 'sk-ds-1234',
        OPENAI_MODEL: 'deepseek-chat',
      },
      customEnv: [{ key: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '1' }],
      contextWindow: 200000,
    };

    const { container } = render(<CcPresetManagerDialog ws={ws} onClose={() => {}} />);
    const listCall = ws.send.mock.calls.find((call: any[]) => call[0]?.type === CC_PRESET_MSG.LIST)![0];

    act(() => {
      ws.emit({
        type: CC_PRESET_MSG.LIST_RESPONSE,
        requestId: listCall.requestId,
        presets: [savedPreset],
        version: 'v1',
      });
    });

    await waitFor(() => expect(container.querySelector('[data-cc-preset-row="DeepSeek-Gateway"]')).not.toBeNull());

    expect(container.querySelector('.cc-preset-manager-overlay')).not.toBeNull();
    expect(container.querySelector('.cc-preset-manager-dialog')).not.toBeNull();
    expect(container.querySelector('.cc-preset-editor.cc-preset-editor-standalone')).not.toBeNull();
    expect(container.querySelector('.cc-preset-field-row-2col')).not.toBeNull();

    // Default Anthropic protocol pill is active and shows ANTHROPIC_* env key chips
    const pills = Array.from(container.querySelectorAll('.cc-preset-protocol-pill'));
    expect(pills).toHaveLength(2);
    expect(pills[0].classList.contains('is-active')).toBe(true);
    expect(pills[1].classList.contains('is-active')).toBe(false);
    expect(Array.from(container.querySelectorAll('.cc-preset-env-key')).map((el) => el.textContent)).toEqual([
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_MODEL',
    ]);

    // Switching to OpenAI updates active pill and env key chips
    fireEvent.click(screen.getByLabelText('ccPreset.protocolOpenAi'));
    expect(pills[0].classList.contains('is-active')).toBe(false);
    expect(pills[1].classList.contains('is-active')).toBe(true);
    expect(Array.from(container.querySelectorAll('.cc-preset-env-key')).map((el) => el.textContent)).toEqual([
      'OPENAI_BASE_URL',
      'OPENAI_API_KEY',
      'OPENAI_MODEL',
    ]);

    // Context window badge renders formatted size (e.g. 200K)
    fireEvent.input(screen.getByPlaceholderText('1000000'), { target: { value: '200000' } });
    expect(container.querySelector('.cc-preset-context-badge')?.textContent).toBe('200K');

    // Add custom env row appends a row with dedicated key/value inputs and remove button
    const initialEnvRows = container.querySelectorAll('.cc-preset-env-row').length;
    fireEvent.click(screen.getByRole('button', { name: 'ccPreset.addEnvVar' }));
    expect(container.querySelectorAll('.cc-preset-env-row')).toHaveLength(initialEnvRows + 1);
    expect(container.querySelector('.cc-preset-env-key-input')).not.toBeNull();
    expect(container.querySelector('.cc-preset-env-val-input')).not.toBeNull();
    expect(container.querySelector('.cc-preset-env-remove-btn')).not.toBeNull();

    // Saved preset row keeps [Edit, Delete, Export] button order and marks row .is-editing when Edit is clicked
    const row = container.querySelector('[data-cc-preset-row="DeepSeek-Gateway"]')!;
    expect(row.querySelector('.cc-preset-row-name')?.textContent).toBe('DeepSeek-Gateway');
    expect(row.querySelector('.cc-preset-row-proto')?.textContent).toBe('OpenAI');
    expect(row.querySelector('.cc-preset-row-model')?.textContent).toBe('deepseek-chat');
    const rowButtons = Array.from(row.querySelectorAll('button'));
    expect(rowButtons.map((b) => b.textContent)).toEqual([
      'ccPreset.editButton',
      'ccPreset.deleteButton',
      'new_session.api_provider_export_json',
    ]);
    expect(row.classList.contains('is-editing')).toBe(false);
    fireEvent.click(rowButtons[0]);
    expect(row.classList.contains('is-editing')).toBe(true);
  });

  it('renders embedded compact mode with .is-compact and omits standalone empty box when presets are empty', () => {
    const { container } = render(
      <CcPresetEditorPanel
        compact
        presets={[]}
        loaded
        loading={false}
        refreshing={false}
        saving={false}
        discovering={false}
        error={null}
        onClearError={() => {}}
        onError={() => {}}
        onSave={async () => true}
        onDiscoverModels={async () => null}
      />,
    );

    const editor = container.querySelector('.cc-preset-editor');
    expect(editor).not.toBeNull();
    expect(editor!.classList.contains('is-compact')).toBe(true);
    expect(editor!.classList.contains('cc-preset-editor-standalone')).toBe(false);
    expect(container.querySelector('.cc-preset-field-row-2col')).not.toBeNull();
    expect(container.querySelector('[data-testid="cc-preset-empty"]')).toBeNull();
    expect(Array.from(container.querySelectorAll('.cc-preset-env-key')).map((el) => el.textContent)).toEqual([
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_MODEL',
    ]);
  });
});
