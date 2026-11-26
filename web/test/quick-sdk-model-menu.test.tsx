/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGY_DEFAULT_MODEL_ID, AGY_SDK_PROVIDER_ID } from '@shared/agy-agent.js';
import { TRANSPORT_MSG } from '@shared/transport-events.js';
import type { UseQuickDataResult } from '../src/components/QuickInputPanel.js';

const mockApi = vi.hoisted(() => ({
  patchSession: vi.fn(),
  patchSubSession: vi.fn(),
  saveAgyModelPreference: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => (opts ? `${k}:${JSON.stringify(opts)}` : k),
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api.js')>();
  return {
    ...actual,
    patchSession: mockApi.patchSession,
    patchSubSession: mockApi.patchSubSession,
  };
});

vi.mock('../src/agy-model-preference.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agy-model-preference.js')>();
  return {
    ...actual,
    saveAgyModelPreference: mockApi.saveAgyModelPreference,
  };
});

import { SessionControls } from '../src/components/SessionControls.js';
import {
  getQuickSwitchableSdkGroups,
  isQuickSdkSwitchAllowed,
  resolveCrossSdkModels,
  resolveEffectiveCrossSdkPreset,
  supportsQuickModelTrigger,
} from '../src/components/quick-sdk-model.js';
import {
  __clearTransportModelCacheForTests,
  writeCachedTransportModels,
} from '../src/hooks/useTransportModels.js';

const quickData: UseQuickDataResult = {
  data: { history: [], sessionHistory: {}, commands: [], phrases: [] },
  loaded: true,
  recordHistory: vi.fn(),
  addCommand: vi.fn(),
  addPhrase: vi.fn(),
  removeCommand: vi.fn(),
  removePhrase: vi.fn(),
  removeHistory: vi.fn(),
  removeSessionHistory: vi.fn(),
  clearHistory: vi.fn(),
  clearSessionHistory: vi.fn(),
};

function makeWs() {
  const listeners = new Set<(msg: unknown) => void>();
  return {
    connected: true,
    sendSessionCommand: vi.fn(),
    sendSessionCommandUrgent: vi.fn(),
    subSessionSetModel: vi.fn(),
    send: vi.fn(),
    sendInput: vi.fn(),
    onMessage: vi.fn((cb: (msg: unknown) => void) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    }),
    emitMessage: (msg: unknown) => {
      for (const cb of listeners) cb(msg);
    },
  } as any;
}

function renderSessionControls(
  sessionOverrides: Record<string, unknown> = {},
  propOverrides: Record<string, unknown> = {},
) {
  const ws = (propOverrides.ws as ReturnType<typeof makeWs> | undefined) ?? makeWs();
  const onSessionSaved = vi.fn();
  const onAfterAction = vi.fn();
  const makeProps = (sOv = sessionOverrides, pOv = propOverrides) => ({
    ws,
    connected: ws.connected,
    activeSession: {
      name: 'deck_app_brain',
      project: 'app',
      role: 'brain',
      state: 'idle',
      projectDir: '/work/app',
      agentType: 'claude-code',
      modelDisplay: 'sonnet',
      ...sOv,
    } as never,
    quickData,
    serverId: 'srv1',
    sessions: [],
    subSessions: [],
    onSend: vi.fn(),
    onAfterAction,
    onSessionSaved,
    ...pOv,
  });
  const view = render(<SessionControls {...makeProps()} />);
  return { ...view, ws, onSessionSaved, onAfterAction, makeProps };
}

beforeEach(() => {
  __clearTransportModelCacheForTests();
  mockApi.patchSession.mockResolvedValue({ ok: true });
  mockApi.patchSubSession.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('quick-sdk-model helpers', () => {
  it('enforces eligibility for incognito, shared permissions, and non-switchable runtimes', () => {
    const baseSession = {
      name: 'deck_app_brain',
      project: 'app',
      role: 'brain',
      state: 'idle',
      projectDir: '/work/app',
      agentType: 'claude-code',
    } as never;

    expect(isQuickSdkSwitchAllowed({
      activeSession: baseSession,
      serverId: 'srv1',
      activeSessionIncognito: false,
      canSharedSessionSend: true,
      modelSwitchDisabled: false,
    })).toBe(true);

    expect(isQuickSdkSwitchAllowed({
      activeSession: baseSession,
      serverId: 'srv1',
      activeSessionIncognito: true,
      canSharedSessionSend: true,
      modelSwitchDisabled: false,
    })).toBe(false);

    expect(isQuickSdkSwitchAllowed({
      activeSession: baseSession,
      serverId: null,
      activeSessionIncognito: false,
      canSharedSessionSend: true,
      modelSwitchDisabled: false,
    })).toBe(false);

    expect(isQuickSdkSwitchAllowed({
      activeSession: baseSession,
      serverId: 'srv1',
      activeSessionIncognito: false,
      canSharedSessionSend: false,
      modelSwitchDisabled: false,
    })).toBe(false);

    for (const blocked of ['shell', 'script', 'openclaw']) {
      expect(isQuickSdkSwitchAllowed({
        activeSession: { ...baseSession, agentType: blocked } as never,
        serverId: 'srv1',
        activeSessionIncognito: false,
        canSharedSessionSend: true,
        modelSwitchDisabled: false,
      })).toBe(false);
      expect(supportsQuickModelTrigger(blocked, false)).toBe(false);
    }

    expect(supportsQuickModelTrigger('opencode', true)).toBe(true);
    expect(supportsQuickModelTrigger('qoder-sdk', true)).toBe(true);
  });

  it('offers only Transport SDKs as cross-SDK destinations while retaining only the current CLI', () => {
    // From CLI claude-code: retains current claude-code + Transport SDKs, hides unsupported CLI targets (codex, opencode).
    const cliGroups = getQuickSwitchableSdkGroups('claude-code');
    const cliIds = cliGroups.flatMap((g) => g.items.map((item) => item.id));
    expect(cliIds).toContain('claude-code');
    expect(cliIds).toContain('claude-code-sdk');
    expect(cliIds).toContain('codex-sdk');
    expect(cliIds).not.toContain('codex');
    expect(cliIds).not.toContain('opencode');
    expect(cliIds).not.toContain('shell');
    expect(cliIds).not.toContain('openclaw');

    // From Transport SDK claude-code-sdk: no CLI targets appear at all.
    const sdkGroups = getQuickSwitchableSdkGroups('claude-code-sdk');
    const sdkIds = sdkGroups.flatMap((g) => g.items.map((item) => item.id));
    expect(sdkIds).toContain('claude-code-sdk');
    expect(sdkIds).toContain('codex-sdk');
    expect(sdkIds).not.toContain('claude-code');
    expect(sdkIds).not.toContain('codex');
    expect(sdkIds).not.toContain('opencode');

    expect(resolveEffectiveCrossSdkPreset('claude-code', 'claude-code-sdk', 'glm')).toBe('glm');
    expect(resolveEffectiveCrossSdkPreset('claude-code', 'codex-sdk', 'glm')).toBeNull();
    expect(resolveEffectiveCrossSdkPreset('codex', 'codex-sdk', 'custom')).toBe('custom');

    const codexCatalog = resolveCrossSdkModels({ sdk: 'codex-sdk', sessionName: 'deck_app_brain', cachedCatalog: null });
    expect(codexCatalog.models.length).toBeGreaterThan(0);
    expect(codexCatalog.defaultModel).toBeTruthy();

    const opencodeCatalog = resolveCrossSdkModels({ sdk: 'opencode-sdk', sessionName: 'deck_app_brain', cachedCatalog: null });
    expect(opencodeCatalog.models).toEqual([]);
    expect(opencodeCatalog.defaultModel).toBeNull();
  });
});

describe('QuickSdkModelMenu inside SessionControls', () => {
  it('opens two-column menu without eager multi-SDK model fetches and keeps same-SDK zero-restart path', () => {
    const { container, ws } = renderSessionControls();

    // Closed: zero transport.list_models requests on initial render.
    const initialModelQueries = ws.send.mock.calls.filter(
      (c: unknown[]) => JSON.stringify(c[0]).includes('list_models'),
    );
    expect(initialModelQueries).toHaveLength(0);

    const trigger = container.querySelector('[data-testid="session-model-trigger"]') as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    fireEvent.click(trigger);

    const split = document.body.querySelector('[data-testid="quick-sdk-model-split"]');
    expect(split).not.toBeNull();
    expect(split?.getAttribute('data-preview-sdk')).toBe('claude-code');

    // Unsupported CLI destinations are absent when starting from CLI claude-code.
    expect(document.body.querySelector('[data-sdk-id="codex"]')).toBeNull();
    expect(document.body.querySelector('[data-sdk-id="opencode"]')).toBeNull();

    const currentSdkBtn = document.body.querySelector('[data-sdk-id="claude-code"]');
    expect(currentSdkBtn?.classList.contains('is-current')).toBe(true);
    expect(currentSdkBtn?.classList.contains('is-preview')).toBe(true);
    expect(currentSdkBtn?.getAttribute('aria-pressed')).toBe('true');

    // Same-SDK open does NOT fan out transport.list_models calls across other SDKs.
    const modelQueries = ws.send.mock.calls.filter(
      (c: unknown[]) => JSON.stringify(c[0]).includes('list_models'),
    );
    expect(modelQueries).toHaveLength(0);

    // Selecting a model inside current SDK uses zero-restart command and never calls patchSession.
    const modelButtons = Array.from(document.body.querySelectorAll('.quick-sdk-model-item')) as HTMLButtonElement[];
    const haikuBtn = modelButtons.find((b) => b.textContent?.includes('Haiku'));
    expect(haikuBtn).toBeDefined();
    fireEvent.click(haikuBtn!);

    expect(mockApi.patchSession).not.toHaveBeenCalled();
    expect(mockApi.patchSubSession).not.toHaveBeenCalled();
    const sentPayloads = [
      ...ws.sendSessionCommand.mock.calls,
      ...ws.sendSessionCommandUrgent.mock.calls,
      ...ws.send.mock.calls,
    ].map((c) => JSON.stringify(c));
    expect(sentPayloads.some((p) => p.includes('/model haiku'))).toBe(true);
  });

  it('lazily queries selected cross-SDK models, clears incompatible ccPreset, and keeps compatible ccPreset', async () => {
    const { container, ws, onSessionSaved, onAfterAction } = renderSessionControls({
      agentType: 'claude-code',
      ccPreset: 'glm',
    });
    fireEvent.click(container.querySelector('[data-testid="session-model-trigger"]') as HTMLButtonElement);

    // Compatible switch: claude-code -> claude-code-sdk preserves ccPreset on query and onSessionSaved.
    const claudeSdkBtn = document.body.querySelector('[data-sdk-id="claude-code-sdk"]') as HTMLButtonElement;
    expect(claudeSdkBtn).not.toBeNull();
    fireEvent.click(claudeSdkBtn);

    await waitFor(() => {
      const listCalls = ws.send.mock.calls
        .map((c: unknown[]) => c[0] as Record<string, unknown>)
        .filter((m) => m && m.type === TRANSPORT_MSG.LIST_MODELS && m.agentType === 'claude-code-sdk');
      expect(listCalls).toHaveLength(1);
      expect(listCalls[0].ccPreset).toBe('glm');
    });

    // Switch preview to incompatible codex-sdk -> query has NO ccPreset, and optimistic save clears ccPreset: null.
    const codexBtn = document.body.querySelector('[data-sdk-id="codex-sdk"]') as HTMLButtonElement;
    expect(codexBtn).not.toBeNull();
    fireEvent.click(codexBtn);

    await waitFor(() => {
      const listCalls = ws.send.mock.calls
        .map((c: unknown[]) => c[0] as Record<string, unknown>)
        .filter((m) => m && m.type === TRANSPORT_MSG.LIST_MODELS && m.agentType === 'codex-sdk');
      expect(listCalls).toHaveLength(1);
      expect(listCalls[0].ccPreset).toBeUndefined();
    });

    const codexModelBtn = document.body.querySelector('[data-cross-model-id]') as HTMLButtonElement;
    expect(codexModelBtn).not.toBeNull();
    const chosenModel = codexModelBtn.getAttribute('data-cross-model-id');
    expect(chosenModel).toBeTruthy();

    fireEvent.click(codexModelBtn);

    await waitFor(() => {
      expect(mockApi.patchSession).toHaveBeenCalledWith('srv1', 'deck_app_brain', {
        agentType: 'codex-sdk',
        requestedModel: chosenModel,
        activeModel: null,
      });
    });

    expect(mockApi.patchSubSession).not.toHaveBeenCalled();
    expect(onSessionSaved).toHaveBeenCalledWith({
      type: 'codex-sdk',
      requestedModel: chosenModel,
      activeModel: null,
      modelDisplay: null,
      ccPreset: null,
    });
    expect(onAfterAction).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[data-testid="quick-sdk-model-split"]')).toBeNull();
  });

  it('prevents cross-SDK stale state and preset cache poisoning when switching previews', async () => {
    // 1. Seed unscoped preset cache; non-preset preview of claude-code-sdk must NEVER see it.
    writeCachedTransportModels('other-sess\0claude-code-sdk\0glm', 'claude-code-sdk', {
      models: [{ id: 'glm-poison-model' }],
      defaultModel: 'glm-poison-model',
    });

    const { container, ws } = renderSessionControls({ agentType: 'codex-sdk', modelDisplay: 'gpt-6-sol' });
    fireEvent.click(container.querySelector('[data-testid="session-model-trigger"]') as HTMLButtonElement);

    fireEvent.click(document.body.querySelector('[data-sdk-id="claude-code-sdk"]') as HTMLButtonElement);
    expect(document.body.textContent).not.toContain('glm-poison-model');

    // 2. Deliver live models for grok-sdk (A), then immediately switch preview to opencode-sdk (B) before B answers.
    fireEvent.click(document.body.querySelector('[data-sdk-id="grok-sdk"]') as HTMLButtonElement);
    await waitFor(() => {
      const grokReq = ws.send.mock.calls
        .map((c: unknown[]) => c[0] as Record<string, unknown>)
        .find((m) => m?.type === TRANSPORT_MSG.LIST_MODELS && m?.agentType === 'grok-sdk');
      expect(grokReq).toBeDefined();
    });
    const grokReq = ws.send.mock.calls
      .map((c: unknown[]) => c[0] as Record<string, unknown>)
      .find((m) => m?.type === TRANSPORT_MSG.LIST_MODELS && m?.agentType === 'grok-sdk')!;
    ws.emitMessage({
      type: TRANSPORT_MSG.MODELS_RESPONSE,
      agentType: 'grok-sdk',
      requestId: grokReq.requestId,
      models: [{ id: 'grok-live-alpha' }],
      defaultModel: 'grok-live-alpha',
    });
    await waitFor(() => {
      expect(document.body.querySelector('[data-cross-model-id="grok-live-alpha"]')).not.toBeNull();
    });

    // Switch to opencode-sdk (no reply yet): grok-live-alpha and its default MUST disappear synchronously.
    fireEvent.click(document.body.querySelector('[data-sdk-id="opencode-sdk"]') as HTMLButtonElement);
    expect(document.body.querySelector('[data-cross-model-id="grok-live-alpha"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="quick-sdk-default-switch"]')?.textContent).not.toContain('grok-live-alpha');

    // A late grok-sdk broadcast while previewing opencode-sdk must be ignored.
    ws.emitMessage({
      type: TRANSPORT_MSG.MODELS_RESPONSE,
      agentType: 'grok-sdk',
      models: [{ id: 'grok-late-stale' }],
      defaultModel: 'grok-late-stale',
    });
    expect(document.body.querySelector('[data-cross-model-id="grok-late-stale"]')).toBeNull();
  });

  it('closes open menu and blocks model dispatch when disconnected or shared role becomes read-only viewer', async () => {
    const { container, ws, rerender, makeProps } = renderSessionControls();
    const trigger = container.querySelector('[data-testid="session-model-trigger"]') as HTMLButtonElement;
    fireEvent.click(trigger);
    expect(document.body.querySelector('[data-testid="quick-sdk-model-split"]')).not.toBeNull();

    // Transition to read-only viewer while menu is open: closes portal and disables trigger.
    rerender(
      <SessionControls
        {...makeProps({
          sharedState: { targetKind: 'main', effectiveRole: 'viewer', status: 'active' },
        })}
      />,
    );
    await waitFor(() => {
      expect(document.body.querySelector('[data-testid="quick-sdk-model-split"]')).toBeNull();
      expect(document.body.querySelectorAll('.menu-dropdown-models .menu-item')).toHaveLength(0);
      expect(trigger.disabled).toBe(true);
    });

    // Reopen as owner, then disconnect socket while open.
    rerender(<SessionControls {...makeProps()} />);
    fireEvent.click(trigger);
    expect(document.body.querySelector('[data-testid="quick-sdk-model-split"]')).not.toBeNull();

    ws.connected = false;
    rerender(<SessionControls {...makeProps({}, { connected: false })} />);
    await waitFor(() => {
      expect(document.body.querySelector('[data-testid="quick-sdk-model-split"]')).toBeNull();
      expect(document.body.querySelectorAll('.menu-dropdown-models .menu-item')).toHaveLength(0);
      expect(trigger.disabled).toBe(true);
    });
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
    expect(ws.sendSessionCommandUrgent).not.toHaveBeenCalled();
    expect(mockApi.patchSession).not.toHaveBeenCalled();
  });

  it('guards against duplicate clicks while switching and recovers cleanly on error', async () => {
    let rejectSwitch!: (err: Error) => void;
    mockApi.patchSession.mockImplementationOnce(
      () => new Promise((_, reject) => { rejectSwitch = reject; }),
    );

    const { container } = renderSessionControls();
    const trigger = container.querySelector('[data-testid="session-model-trigger"]') as HTMLButtonElement;
    fireEvent.click(trigger);

    fireEvent.click(document.body.querySelector('[data-sdk-id="codex-sdk"]') as HTMLButtonElement);
    const defaultBtn = document.body.querySelector('[data-testid="quick-sdk-default-switch"]') as HTMLButtonElement;
    expect(defaultBtn).not.toBeNull();
    fireEvent.click(defaultBtn);
    fireEvent.click(defaultBtn);

    await waitFor(() => {
      expect(mockApi.patchSession).toHaveBeenCalledTimes(1);
      expect(trigger.disabled).toBe(true);
      expect(trigger.textContent).toContain('session.quickSwitch.switching');
    });

    rejectSwitch(new Error('boom'));

    await waitFor(() => {
      expect(trigger.disabled).toBe(false);
      expect(container.textContent).toContain('session.quickSwitch.switchFailed');
    });
  });

  it('routes sub-sessions via patchSubSession and persists AGY model preference', async () => {
    const { container, onSessionSaved } = renderSessionControls(
      { name: 'deck_sub_worker1', role: 'w1', agentType: 'claude-code-sdk', ccPreset: 'minimax' },
      { subSessionId: 'sub_worker_1' },
    );

    fireEvent.click(container.querySelector('[data-testid="session-model-trigger"]') as HTMLButtonElement);
    fireEvent.click(document.body.querySelector(`[data-sdk-id="${AGY_SDK_PROVIDER_ID}"]`) as HTMLButtonElement);

    const agyModelBtn = document.body.querySelector(`[data-cross-model-id="${AGY_DEFAULT_MODEL_ID}"]`) as HTMLButtonElement
      ?? document.body.querySelector('[data-testid="quick-sdk-default-switch"]') as HTMLButtonElement;
    fireEvent.click(agyModelBtn);

    await waitFor(() => {
      expect(mockApi.patchSubSession).toHaveBeenCalledWith('srv1', 'sub_worker_1', {
        type: AGY_SDK_PROVIDER_ID,
        requestedModel: AGY_DEFAULT_MODEL_ID,
        activeModel: null,
      });
    });
    expect(mockApi.saveAgyModelPreference).toHaveBeenCalledWith(AGY_DEFAULT_MODEL_ID, 'deck_sub_worker1');
    expect(onSessionSaved).toHaveBeenCalledWith(expect.objectContaining({
      type: AGY_SDK_PROVIDER_ID,
      requestedModel: AGY_DEFAULT_MODEL_ID,
      ccPreset: null,
    }));
  });

  it('keeps single-column fallback for incognito and missing serverId, supports opencode switch-out, and hides blocked runtimes', async () => {
    // 1. opencode renders trigger & default cross-switch works
    const opencodeView = renderSessionControls({ agentType: 'opencode', modelDisplay: null });
    const ocTrigger = opencodeView.container.querySelector('[data-testid="session-model-trigger"]') as HTMLButtonElement;
    expect(ocTrigger).not.toBeNull();
    fireEvent.click(ocTrigger);
    fireEvent.click(document.body.querySelector('[data-sdk-id="qoder-sdk"]') as HTMLButtonElement);
    const defaultBtn = document.body.querySelector('[data-testid="quick-sdk-default-switch"]') as HTMLButtonElement;
    expect(defaultBtn).not.toBeNull();
    fireEvent.click(defaultBtn);
    await waitFor(() => {
      expect(mockApi.patchSession).toHaveBeenCalledWith('srv1', 'deck_app_brain', {
        agentType: 'qoder-sdk',
        requestedModel: null,
        activeModel: null,
      });
    });
    cleanup();
    vi.clearAllMocks();

    // 2. Incognito preserves single-column same-SDK switching (no cross-SDK split)
    const incogView = renderSessionControls({ incognito: true });
    fireEvent.click(incogView.container.querySelector('[data-testid="session-model-trigger"]') as HTMLButtonElement);
    expect(document.body.querySelector('[data-testid="quick-sdk-model-split"]')).toBeNull();
    const incogItems = Array.from(document.body.querySelectorAll('.menu-dropdown-models .menu-item')) as HTMLButtonElement[];
    expect(incogItems.length).toBeGreaterThan(0);
    fireEvent.click(incogItems.find((b) => b.textContent?.includes('Haiku'))!);
    expect(incogView.ws.sendSessionCommandUrgent).toHaveBeenCalled();
    expect(mockApi.patchSession).not.toHaveBeenCalled();
    cleanup();
    vi.clearAllMocks();

    // 3. Missing serverId preserves single-column same-SDK switching
    const noSrvView = renderSessionControls({}, { serverId: null });
    fireEvent.click(noSrvView.container.querySelector('[data-testid="session-model-trigger"]') as HTMLButtonElement);
    expect(document.body.querySelector('[data-testid="quick-sdk-model-split"]')).toBeNull();
    const noSrvItems = Array.from(document.body.querySelectorAll('.menu-dropdown-models .menu-item')) as HTMLButtonElement[];
    expect(noSrvItems.length).toBeGreaterThan(0);
    fireEvent.click(noSrvItems.find((b) => b.textContent?.includes('Haiku'))!);
    expect(noSrvView.ws.sendSessionCommandUrgent).toHaveBeenCalled();
    cleanup();

    // 4. shell / script / openclaw hide trigger completely
    for (const agentType of ['shell', 'script', 'openclaw']) {
      const view = renderSessionControls({ agentType });
      expect(view.container.querySelector('[data-testid="session-model-trigger"]')).toBeNull();
      cleanup();
    }
  });
});
