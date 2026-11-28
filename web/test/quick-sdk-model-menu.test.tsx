/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_AVAILABILITY_MSG } from '@shared/agent-availability.js';
import { AGY_DEFAULT_MODEL_ID, AGY_SDK_PROVIDER_ID } from '@shared/agy-agent.js';
import { CC_PRESET_MSG, CUSTOM_PROVIDER_SDK_AGENT_TYPES } from '@shared/cc-presets.js';
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
  filterQuickSdkGroupsByok,
  getQuickSwitchableSdkGroups,
  isQuickSdkSwitchAllowed,
  pickFirstSelectableQuickSdk,
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
    detectAgents: vi.fn(),
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

  it('filters SDK groups strictly to BYOK-capable SDKs and picks first selectable SDK', () => {
    const allGroups = getQuickSwitchableSdkGroups('agy-sdk');
    const byokGroups = filterQuickSdkGroupsByok(allGroups);
    const byokIds = byokGroups.flatMap((g) => g.items.map((i) => i.id));

    // Every item in byokGroups must belong to CUSTOM_PROVIDER_SDK_AGENT_TYPES
    for (const id of byokIds) {
      expect(CUSTOM_PROVIDER_SDK_AGENT_TYPES.has(id)).toBe(true);
    }
    expect(byokIds).toContain('claude-code-sdk');
    expect(byokIds).toContain('codex-sdk');
    expect(byokIds).not.toContain('agy-sdk');
    expect(byokIds).not.toContain('copilot-sdk');
    expect(byokIds).not.toContain('cursor-headless');

    // pickFirstSelectableQuickSdk skips unavailable SDKs
    const firstInstalled = pickFirstSelectableQuickSdk(byokGroups, 'agy-sdk', {
      [byokIds[0]]: { installed: false },
    } as any);
    expect(firstInstalled).toBe(byokIds[1]);

    // Falls back to first item when all marked uninstalled
    const allUninstalledMap = Object.fromEntries(byokIds.map((id) => [id, { installed: false }]));
    const fallbackAllUninstalled = pickFirstSelectableQuickSdk(byokGroups, 'agy-sdk', allUninstalledMap as any);
    expect(fallbackAllUninstalled).toBe(byokIds[0]);
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
        ccPreset: null,
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
        ccPresetId: null,
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
        ccPreset: null,
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

  it('sends requestedModel: null on cold preserved-preset default switch until live preset models arrive', async () => {
    expect(resolveCrossSdkModels({
      sdk: 'claude-code-sdk',
      sessionName: 'deck_app_brain',
      ccPreset: 'glm',
      targetScope: 'srv-a',
    })).toEqual({ models: [], defaultModel: null, loading: false });

    expect(resolveCrossSdkModels({
      sdk: 'codex-sdk',
      sessionName: 'deck_app_brain',
      ccPreset: 'custom',
      targetScope: 'srv-a',
    })).toEqual({ models: [], defaultModel: null, loading: false });

    const { container, ws, onSessionSaved } = renderSessionControls({
      agentType: 'claude-code',
      ccPreset: 'glm',
    });
    const trigger = container.querySelector('[data-testid="session-model-trigger"]') as HTMLButtonElement;
    fireEvent.click(trigger);

    // Preview compatible claude-code-sdk on cold cache: no first-party models (fable/sonnet/etc.), only default switch.
    fireEvent.click(document.body.querySelector('[data-sdk-id="claude-code-sdk"]') as HTMLButtonElement);
    expect(document.body.querySelectorAll('[data-cross-model-id]')).toHaveLength(0);
    const defaultBtn = document.body.querySelector('[data-testid="quick-sdk-default-switch"]') as HTMLButtonElement;
    expect(defaultBtn).not.toBeNull();
    expect(defaultBtn.querySelector('.quick-sdk-default-tag')).toBeNull();

    // First click on default before live preset models arrive sends requestedModel: null so daemon uses preset default.
    fireEvent.click(defaultBtn);
    await waitFor(() => {
      expect(mockApi.patchSession).toHaveBeenCalledWith('srv1', 'deck_app_brain', {
        agentType: 'claude-code-sdk',
        requestedModel: null,
        activeModel: null,
        ccPreset: 'glm',
      });
    });
    expect(onSessionSaved).toHaveBeenCalledWith(expect.objectContaining({
      type: 'claude-code-sdk',
      requestedModel: null,
      ccPreset: 'glm',
    }));

    vi.clearAllMocks();
    mockApi.patchSession.mockResolvedValue({ ok: true });

    // Reopen, preview claude-code-sdk, deliver live preset-exclusive models, then select one.
    fireEvent.click(trigger);
    fireEvent.click(document.body.querySelector('[data-sdk-id="claude-code-sdk"]') as HTMLButtonElement);
    await waitFor(() => {
      const req = ws.send.mock.calls
        .map((c: unknown[]) => c[0] as Record<string, unknown>)
        .find((m) => m?.type === TRANSPORT_MSG.LIST_MODELS && m?.agentType === 'claude-code-sdk' && m?.ccPreset === 'glm');
      expect(req).toBeDefined();
    });
    const req = ws.send.mock.calls
      .map((c: unknown[]) => c[0] as Record<string, unknown>)
      .find((m) => m?.type === TRANSPORT_MSG.LIST_MODELS && m?.agentType === 'claude-code-sdk' && m?.ccPreset === 'glm')!;
    ws.emitMessage({
      type: TRANSPORT_MSG.MODELS_RESPONSE,
      agentType: 'claude-code-sdk',
      ccPreset: 'glm',
      requestId: req.requestId,
      models: [{ id: 'glm-4.5' }, { id: 'glm-4.5-air' }],
      defaultModel: 'glm-4.5',
    });

    await waitFor(() => {
      expect(document.body.querySelector('[data-cross-model-id="glm-4.5-air"]')).not.toBeNull();
    });
    expect(document.body.querySelector('[data-testid="quick-sdk-default-switch"]')?.textContent).toContain('glm-4.5');

    fireEvent.click(document.body.querySelector('[data-cross-model-id="glm-4.5-air"]') as HTMLButtonElement);
    await waitFor(() => {
      expect(mockApi.patchSession).toHaveBeenCalledWith('srv1', 'deck_app_brain', {
        agentType: 'claude-code-sdk',
        requestedModel: 'glm-4.5-air',
        activeModel: null,
        ccPreset: 'glm',
      });
    });
  });

  it('grays out and disables uninstalled non-current SDKs while keeping currentSdk and installed SDKs active', async () => {
    const { container, ws } = renderSessionControls({ agentType: 'claude-code' });
    fireEvent.click(container.querySelector('[data-testid="session-model-trigger"]') as HTMLButtonElement);

    // Before availability arrives, SDKs optimistically remain interactive (no false graying).
    const codexBefore = document.body.querySelector('[data-sdk-id="codex-sdk"]') as HTMLButtonElement;
    expect(codexBefore.disabled).toBe(false);
    expect(codexBefore.classList.contains('is-unavailable')).toBe(false);
    expect(ws.detectAgents).toHaveBeenCalledWith(false);

    ws.emitMessage({
      type: AGENT_AVAILABILITY_MSG.RESULT,
      checkedAt: Date.now(),
      agents: {
        'claude-code': { installed: false, reason: 'binary missing' },
        'codex-sdk': { installed: false, reason: 'codex CLI not found' },
        'opencode-sdk': { installed: true },
      },
    });

    await waitFor(() => {
      const codexBtn = document.body.querySelector('[data-sdk-id="codex-sdk"]') as HTMLButtonElement;
      expect(codexBtn.disabled).toBe(true);
      expect(codexBtn.getAttribute('aria-disabled')).toBe('true');
      expect(codexBtn.classList.contains('is-unavailable')).toBe(true);
      expect(codexBtn.title).toContain('new_session.agent_not_installed_hint');
      expect(codexBtn.title).toContain('codex CLI not found');
    });

    // Clicking disabled uninstalled SDK must not change preview.
    const codexBtn = document.body.querySelector('[data-sdk-id="codex-sdk"]') as HTMLButtonElement;
    fireEvent.click(codexBtn);
    expect(document.body.querySelector('[data-testid="quick-sdk-model-split"]')?.getAttribute('data-preview-sdk')).toBe('claude-code');

    // currentSdk remains enabled even if availability reported false.
    const currentBtn = document.body.querySelector('[data-sdk-id="claude-code"]') as HTMLButtonElement;
    expect(currentBtn.disabled).toBe(false);
    expect(currentBtn.classList.contains('is-unavailable')).toBe(false);

    // Installed SDK switches preview normally.
    const opencodeBtn = document.body.querySelector('[data-sdk-id="opencode-sdk"]') as HTMLButtonElement;
    expect(opencodeBtn.disabled).toBe(false);
    expect(opencodeBtn.classList.contains('is-unavailable')).toBe(false);
    fireEvent.click(opencodeBtn);
    expect(document.body.querySelector('[data-testid="quick-sdk-model-split"]')?.getAttribute('data-preview-sdk')).toBe('opencode-sdk');
  });

  it('supports CC Preset selection, clearing back to Default, preset-defined models, and manage trigger inside QuickSdkModelMenu', async () => {
    const onOpenCcPresetManager = vi.fn();
    const { container, ws, onSessionSaved } = renderSessionControls(
      { agentType: 'claude-code-sdk', ccPreset: 'MiniMax', requestedModel: 'MiniMax-M2.7' },
      { onOpenCcPresetManager },
    );

    const trigger = container.querySelector('[data-testid="session-model-trigger"]') as HTMLButtonElement;
    fireEvent.click(trigger);

    const listReq = ws.send.mock.calls.filter((call: any[]) => call[0]?.type === CC_PRESET_MSG.LIST).at(-1)![0];
    // Untagged stale list response must be ignored while listReq is active
    ws.emitMessage({
      type: CC_PRESET_MSG.LIST_RESPONSE,
      presets: [{ name: 'StaleWrong', env: {} }],
    });
    expect(document.body.querySelector('[data-testid="quick-sdk-preset-select"] option[value="StaleWrong"]')).toBeNull();

    ws.emitMessage({
      type: CC_PRESET_MSG.LIST_RESPONSE,
      requestId: listReq.requestId,
      presets: [
        {
          name: 'MiniMax',
          authType: 'anthropic',
          env: { ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic', ANTHROPIC_MODEL: 'MiniMax-M2.7' },
          availableModels: [{ id: 'MiniMax-M2.7' }, { id: 'MiniMax-Text-01' }],
          defaultModel: 'MiniMax-M2.7',
        },
        {
          name: 'OpenAI-Custom',
          authType: 'openai',
          env: { OPENAI_BASE_URL: 'https://api.example.com/v1', OPENAI_MODEL: 'gpt-custom-1' },
          availableModels: [{ id: 'gpt-custom-1' }, { id: 'gpt-custom-2' }],
          defaultModel: 'gpt-custom-1',
        },
      ],
    });

    await waitFor(() => {
      const select = document.body.querySelector('[data-testid="quick-sdk-preset-select"]') as HTMLSelectElement;
      expect(select).not.toBeNull();
      expect(select.value).toBe('MiniMax');
    });

    // Non-preset SDK hides preset selector bar.
    fireEvent.click(document.body.querySelector('[data-sdk-id="opencode-sdk"]') as HTMLButtonElement);
    expect(document.body.querySelector('[data-testid="quick-sdk-preset-bar"]')).toBeNull();

    // Switching back to preset-capable codex-sdk shows preset selector and picking OpenAI-Custom exposes preset models immediately.
    fireEvent.click(document.body.querySelector('[data-sdk-id="codex-sdk"]') as HTMLButtonElement);
    const presetSelect = document.body.querySelector('[data-testid="quick-sdk-preset-select"]') as HTMLSelectElement;
    expect(presetSelect).not.toBeNull();
    fireEvent.change(presetSelect, { target: { value: 'OpenAI-Custom' } });

    await waitFor(() => {
      expect(document.body.querySelector('[data-cross-model-id="gpt-custom-2"]')).not.toBeNull();
    });

    // Switch back to current SDK (claude-code-sdk) and clear preset back to Default (""), then click default model switch.
    fireEvent.click(document.body.querySelector('[data-sdk-id="claude-code-sdk"]') as HTMLButtonElement);
    const sameSdkPresetSelect = document.body.querySelector('[data-testid="quick-sdk-preset-select"]') as HTMLSelectElement;
    expect(sameSdkPresetSelect.value).toBe('MiniMax');
    fireEvent.change(sameSdkPresetSelect, { target: { value: '' } });

    const defaultBtn = document.body.querySelector('[data-testid="quick-sdk-default-switch"]') as HTMLButtonElement;
    expect(defaultBtn).not.toBeNull();
    fireEvent.click(defaultBtn);

    await waitFor(() => {
      expect(mockApi.patchSession).toHaveBeenCalledWith('srv1', 'deck_app_brain', expect.objectContaining({
        agentType: 'claude-code-sdk',
        activeModel: null,
        ccPreset: null,
      }));
    });
    expect(onSessionSaved).toHaveBeenCalledWith(expect.objectContaining({
      type: 'claude-code-sdk',
      ccPreset: null,
    }));

    // Reopen and verify manage button closes menu & triggers onOpenCcPresetManager.
    fireEvent.click(trigger);
    const manageBtn = document.body.querySelector('[data-testid="quick-sdk-manage-presets"]') as HTMLButtonElement;
    expect(manageBtn).not.toBeNull();
    fireEvent.click(manageBtn);
    expect(onOpenCcPresetManager).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[data-testid="quick-sdk-model-split"]')).toBeNull();
  });

  it('hides CC Preset manage button for shared actors or when onOpenCcPresetManager is omitted', () => {
    const view1 = renderSessionControls({ agentType: 'claude-code-sdk' });
    fireEvent.click(view1.container.querySelector('[data-testid="session-model-trigger"]') as HTMLButtonElement);
    expect(document.body.querySelector('[data-testid="quick-sdk-preset-bar"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="quick-sdk-manage-presets"]')).toBeNull();
    cleanup();

    const view2 = renderSessionControls(
      {
        agentType: 'claude-code-sdk',
        sharedState: { targetKind: 'main', effectiveRole: 'participant', status: 'active' },
      },
      { onOpenCcPresetManager: vi.fn() },
    );
    fireEvent.click(view2.container.querySelector('[data-testid="session-model-trigger"]') as HTMLButtonElement);
    expect(document.body.querySelector('[data-testid="quick-sdk-preset-bar"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="quick-sdk-manage-presets"]')).toBeNull();
    cleanup();

    // Owner sharing out their own session (outgoing: true) MUST retain preset management access.
    const viewOwnerSharedOut = renderSessionControls(
      {
        agentType: 'claude-code-sdk',
        sharedState: { effectiveRole: 'participant', outgoing: true, status: 'active', users: [] },
      },
      { onOpenCcPresetManager: vi.fn() },
    );
    fireEvent.click(viewOwnerSharedOut.container.querySelector('[data-testid="session-model-trigger"]') as HTMLButtonElement);
    expect(document.body.querySelector('[data-testid="quick-sdk-manage-presets"]')).not.toBeNull();
  });

  it('snaps preview back to currentSdk and blocks PATCH when delayed availability reports previewed SDK unavailable', async () => {
    const { container, ws } = renderSessionControls({ agentType: 'claude-code' });
    fireEvent.click(container.querySelector('[data-testid="session-model-trigger"]') as HTMLButtonElement);

    // Before availability RESULT arrives, codex-sdk is optimistically selectable for preview.
    const codexBtn = document.body.querySelector('[data-sdk-id="codex-sdk"]') as HTMLButtonElement;
    expect(codexBtn.disabled).toBe(false);
    fireEvent.click(codexBtn);
    expect(document.body.querySelector('[data-testid="quick-sdk-model-split"]')?.getAttribute('data-preview-sdk')).toBe('codex-sdk');

    // Probe arrives reporting codex-sdk is NOT installed.
    ws.emitMessage({
      type: AGENT_AVAILABILITY_MSG.RESULT,
      checkedAt: Date.now(),
      agents: {
        'claude-code': { installed: true },
        'codex-sdk': { installed: false, reason: 'codex CLI not found' },
      },
    });

    await waitFor(() => {
      expect(document.body.querySelector('[data-testid="quick-sdk-model-split"]')?.getAttribute('data-preview-sdk')).toBe('claude-code');
    });
    expect(codexBtn.disabled).toBe(true);
    expect(codexBtn.classList.contains('is-unavailable')).toBe(true);

    // Clicking the right column now executes same-SDK model selection on claude-code, NEVER cross-SDK PATCH to codex-sdk.
    const rightItems = Array.from(document.body.querySelectorAll('.quick-sdk-model-item')) as HTMLButtonElement[];
    expect(rightItems.length).toBeGreaterThan(0);
    fireEvent.click(rightItems[0]);
    expect(mockApi.patchSession).not.toHaveBeenCalled();
    expect(mockApi.patchSubSession).not.toHaveBeenCalled();
  });

  it('keeps previous session state and surfaces warning without calling onSessionSaved when PATCH returns 422', async () => {
    mockApi.patchSubSession.mockRejectedValueOnce(new Error('API 422: Cannot safely forward model "m %TEMP%"'));

    const { container, onSessionSaved, onAfterAction } = renderSessionControls(
      {
        name: 'deck_sub_sub-win-1',
        project: 'proj',
        role: 'w1',
        agentType: 'claude-code',
        state: 'idle',
      },
      { subSessionId: 'sub-win-1' },
    );

    fireEvent.click(container.querySelector('[data-testid="session-model-trigger"]') as HTMLButtonElement);
    const codexBtn = document.body.querySelector('[data-sdk-id="codex-sdk"]') as HTMLButtonElement;
    expect(codexBtn).not.toBeNull();
    fireEvent.click(codexBtn);

    const crossModelBtn = await waitFor(() => {
      const btn = document.body.querySelector('[data-cross-model-id]') as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      return btn!;
    });
    fireEvent.click(crossModelBtn);

    await waitFor(() => {
      expect(mockApi.patchSubSession).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain('Cannot safely forward model');
    });
    expect(onSessionSaved).not.toHaveBeenCalled();
    expect(onAfterAction).not.toHaveBeenCalled();
  });

  it('commits daemon-applied fallback model (m1) over clicked request (m2) and treats 202 pending as non-optimistic', async () => {
    // 1) Daemon applied m1 despite clicking m2 -> UI must save applied m1 + activeModel m1 (never m2 / null)
    mockApi.patchSubSession.mockResolvedValueOnce({
      ok: true,
      applied: {
        agentType: 'codex-sdk',
        ccPreset: null,
        requestedModel: 'm1-fallback',
        activeModel: 'm1-fallback',
        modelDisplay: 'm1-fallback',
        runtimeType: 'transport',
        providerId: 'codex',
        cwd: '/work/proj',
        label: null,
        description: null,
        effort: null,
        transportConfig: null,
        runtimeEpoch: 'epoch-ui-1',
      },
    });
    const view1 = renderSessionControls(
      {
        name: 'deck_sub_sub-ui-1',
        project: 'proj',
        role: 'w1',
        agentType: 'claude-code',
        state: 'idle',
      },
      { subSessionId: 'sub-ui-1' },
    );
    fireEvent.click(view1.container.querySelector('[data-testid="session-model-trigger"]') as HTMLButtonElement);
    fireEvent.click(document.body.querySelector('[data-sdk-id="codex-sdk"]') as HTMLButtonElement);
    const crossModelBtn1 = await waitFor(() => {
      const btn = document.body.querySelector('[data-cross-model-id]') as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      return btn!;
    });
    expect(crossModelBtn1.getAttribute('data-cross-model-id')).not.toBe('m1-fallback');
    fireEvent.click(crossModelBtn1);

    await waitFor(() => {
      expect(view1.onSessionSaved).toHaveBeenCalledWith({
        type: 'codex-sdk',
        requestedModel: 'm1-fallback',
        activeModel: 'm1-fallback',
        modelDisplay: 'm1-fallback',
        ccPreset: null,
      });
    });
    cleanup();

    // 2) HTTP 202 pending response -> must NOT call onSessionSaved optimistically and surfaces pending warning
    mockApi.patchSubSession.mockResolvedValueOnce({
      ok: false,
      pending: true,
      requestId: 'req-ui-pending',
    });
    const view2 = renderSessionControls(
      {
        name: 'deck_sub_sub-ui-2',
        project: 'proj',
        role: 'w1',
        agentType: 'claude-code',
        state: 'idle',
      },
      { subSessionId: 'sub-ui-2' },
    );
    fireEvent.click(view2.container.querySelector('[data-testid="session-model-trigger"]') as HTMLButtonElement);
    fireEvent.click(document.body.querySelector('[data-sdk-id="codex-sdk"]') as HTMLButtonElement);
    const crossModelBtn2 = await waitFor(() => {
      const btn = document.body.querySelector('[data-cross-model-id]') as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      return btn!;
    });
    fireEvent.click(crossModelBtn2);

    await waitFor(() => {
      expect(mockApi.patchSubSession).toHaveBeenCalledTimes(2);
      expect(view2.container.textContent).toContain('session.quickSwitch.switchPending');
    });
    expect(view2.onSessionSaved).not.toHaveBeenCalled();
    expect(view2.onAfterAction).not.toHaveBeenCalled();
    cleanup();

    // 3) Superseded HTTP response ({ ok: false, superseded: true }) -> ignored cleanly without calling onSessionSaved or warning
    mockApi.patchSession.mockResolvedValueOnce({
      ok: false,
      superseded: true,
    });
    const view3 = renderSessionControls({
      name: 'deck_ui3_brain',
      project: 'ui3',
      role: 'brain',
      agentType: 'claude-code',
      state: 'idle',
    });
    fireEvent.click(view3.container.querySelector('[data-testid="session-model-trigger"]') as HTMLButtonElement);
    fireEvent.click(document.body.querySelector('[data-sdk-id="codex-sdk"]') as HTMLButtonElement);
    const crossModelBtn3 = await waitFor(() => {
      const btn = document.body.querySelector('[data-cross-model-id]') as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      return btn!;
    });
    fireEvent.click(crossModelBtn3);

    await waitFor(() => {
      expect(mockApi.patchSession).toHaveBeenCalledTimes(1);
    });
    expect(view3.onSessionSaved).not.toHaveBeenCalled();
    expect(view3.onAfterAction).not.toHaveBeenCalled();
    expect(view3.container.textContent).not.toContain('session.quickSwitch.switchFailed');
    expect(view3.container.textContent).not.toContain('session.quickSwitch.switchPending');
    cleanup();

    // 4) HTTP Promise A remains in-flight while WS sync delivers newer state B (runtimeEpoch: 'ep-B') ->
    // resolving HTTP A with ok=true & applied A (runtimeEpoch: 'ep-A') MUST NOT revert B.
    let resolveDeferredA!: (val: unknown) => void;
    mockApi.patchSubSession.mockImplementationOnce(
      () => new Promise((resolve) => { resolveDeferredA = resolve; }),
    );
    const view4 = renderSessionControls(
      {
        name: 'deck_sub_sub-ui-race',
        project: 'proj',
        role: 'w1',
        agentType: 'claude-code',
        runtimeEpoch: 'ep-0',
        state: 'idle',
      },
      { subSessionId: 'sub-ui-race' },
    );
    fireEvent.click(view4.container.querySelector('[data-testid="session-model-trigger"]') as HTMLButtonElement);
    fireEvent.click(document.body.querySelector('[data-sdk-id="codex-sdk"]') as HTMLButtonElement);
    const crossModelBtn4 = await waitFor(() => {
      const btn = document.body.querySelector('[data-cross-model-id]') as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      return btn!;
    });
    fireEvent.click(crossModelBtn4);

    // Simulate WS sync arriving with newer runtimeEpoch B from another device while A is still in-flight
    view4.rerender(
      <SessionControls
        {...view4.makeProps({
          name: 'deck_sub_sub-ui-race',
          project: 'proj',
          role: 'w1',
          agentType: 'qwen',
          ccPreset: 'PresetB',
          requestedModel: 'qwen-b',
          activeModel: 'qwen-b',
          modelDisplay: 'qwen-b',
          runtimeEpoch: 'ep-B',
          state: 'idle',
        })}
      />,
    );

    resolveDeferredA({
      ok: true,
      applied: {
        agentType: 'codex-sdk',
        ccPreset: null,
        requestedModel: 'gpt-a',
        activeModel: 'gpt-a',
        modelDisplay: 'gpt-a',
        runtimeType: 'transport',
        providerId: 'codex-sdk',
        cwd: '/work/proj',
        label: null,
        description: null,
        effort: null,
        transportConfig: null,
        runtimeEpoch: 'ep-A',
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(view4.onSessionSaved).not.toHaveBeenCalled();
    expect(view4.onAfterAction).not.toHaveBeenCalled();
    cleanup();

    // 5) Same-runtimeEpoch hot-switch counterexample: A commits (ep-E, agy-sdk, m1), user hot-switches inside SAME ep-E to m2,
    // then delayed HTTP A arrives with ep-E / m1 -> helper & component BOTH reject A and NEVER revert local AGY preference to m1.
    const { captureSessionSwitchBaseline, isSessionSwitchSupersededBySync } = await import('../src/session-state-updates.js');
    const baseSameEpoch = captureSessionSwitchBaseline({
      name: 'deck_same_epoch',
      agentType: 'claude-code',
      runtimeEpoch: 'ep-0',
      requestedModel: null,
      activeModel: null,
      modelDisplay: null,
    });
    const syncedHotM2 = {
      name: 'deck_same_epoch',
      agentType: AGY_SDK_PROVIDER_ID,
      runtimeEpoch: 'ep-E',
      requestedModel: 'm2',
      activeModel: 'm2',
      modelDisplay: 'm2',
    };
    const delayedHttpM1 = {
      agentType: AGY_SDK_PROVIDER_ID,
      ccPreset: null,
      requestedModel: 'm1',
      activeModel: 'm1',
      modelDisplay: 'm1',
      runtimeEpoch: 'ep-E',
    };
    expect(isSessionSwitchSupersededBySync(syncedHotM2, baseSameEpoch, delayedHttpM1)).toBe(true);

    mockApi.saveAgyModelPreference.mockClear();
    let resolveDeferredSameEpoch!: (val: unknown) => void;
    mockApi.patchSession.mockImplementationOnce(
      () => new Promise((resolve) => { resolveDeferredSameEpoch = resolve; }),
    );
    const view5 = renderSessionControls({
      name: 'deck_main_same_epoch',
      project: 'main',
      role: 'brain',
      agentType: 'claude-code',
      runtimeEpoch: 'ep-0',
      state: 'idle',
    });
    fireEvent.click(view5.container.querySelector('[data-testid="session-model-trigger"]') as HTMLButtonElement);
    fireEvent.click(document.body.querySelector('[data-sdk-id="agy-sdk"]') as HTMLButtonElement);
    const agyCrossBtn = await waitFor(() => {
      const btn = document.body.querySelector('[data-cross-model-id]') as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      return btn!;
    });
    fireEvent.click(agyCrossBtn);

    // Hot-switch inside SAME ep-E to m2 arrives before HTTP A resolves
    view5.rerender(
      <SessionControls
        {...view5.makeProps({
          name: 'deck_main_same_epoch',
          project: 'main',
          role: 'brain',
          agentType: AGY_SDK_PROVIDER_ID,
          requestedModel: 'm2',
          activeModel: 'm2',
          modelDisplay: 'm2',
          runtimeEpoch: 'ep-E',
          state: 'idle',
        })}
      />,
    );

    resolveDeferredSameEpoch({
      ok: true,
      applied: {
        ...delayedHttpM1,
        runtimeType: 'transport',
        providerId: AGY_SDK_PROVIDER_ID,
        cwd: '/work/main',
        label: null,
        description: null,
        effort: null,
        transportConfig: null,
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(view5.onSessionSaved).not.toHaveBeenCalled();
    expect(mockApi.saveAgyModelPreference).not.toHaveBeenCalled();
  });

  it('supports BYOK filter checkbox in SDK header, filters selectable SDKs, moves preview from non-BYOK, and resets on close', async () => {
    const { container, ws } = renderSessionControls({
      name: 'deck_agy_brain',
      agentType: AGY_SDK_PROVIDER_ID,
      modelDisplay: 'gemini-2.5-pro',
    });

    const trigger = container.querySelector('[data-testid="session-model-trigger"]') as HTMLButtonElement;
    fireEvent.click(trigger);

    const split = document.body.querySelector('[data-testid="quick-sdk-model-split"]') as HTMLElement;
    expect(split).not.toBeNull();
    // Initially previews current non-BYOK SDK (agy-sdk)
    expect(split.getAttribute('data-preview-sdk')).toBe(AGY_SDK_PROVIDER_ID);

    // BYOK toggle is rendered and unchecked by default
    const byokCheckbox = document.body.querySelector('[data-testid="quick-sdk-byok-toggle"]') as HTMLInputElement;
    expect(byokCheckbox).not.toBeNull();
    expect(byokCheckbox.checked).toBe(false);

    // Non-BYOK SDKs (e.g. agy-sdk, copilot-sdk) are currently visible
    expect(document.body.querySelector('[data-sdk-id="agy-sdk"]')).not.toBeNull();
    expect(document.body.querySelector('[data-sdk-id="copilot-sdk"]')).not.toBeNull();

    // Check BYOK
    fireEvent.click(byokCheckbox);
    expect(byokCheckbox.checked).toBe(true);

    // Non-BYOK SDKs are hidden
    expect(document.body.querySelector('[data-sdk-id="agy-sdk"]')).toBeNull();
    expect(document.body.querySelector('[data-sdk-id="copilot-sdk"]')).toBeNull();

    // BYOK SDKs remain visible
    expect(document.body.querySelector('[data-sdk-id="claude-code-sdk"]')).not.toBeNull();
    expect(document.body.querySelector('[data-sdk-id="codex-sdk"]')).not.toBeNull();

    // Preview immediately snaps from non-BYOK agy-sdk to the first available BYOK SDK
    const newPreviewSdk = split.getAttribute('data-preview-sdk');
    expect(CUSTOM_PROVIDER_SDK_AGENT_TYPES.has(newPreviewSdk!)).toBe(true);
    // Preset bar is now visible for the previewed BYOK SDK
    expect(document.body.querySelector('[data-testid="quick-sdk-preset-bar"]')).not.toBeNull();

    // When async availability marks the auto-selected previewSdk uninstalled, snap to another available BYOK SDK
    ws.emitMessage({
      type: AGENT_AVAILABILITY_MSG.RESULT,
      checkedAt: Date.now(),
      agents: {
        [newPreviewSdk!]: { installed: false, reason: 'cli missing' },
        'claude-code-sdk': { installed: true },
      },
    });

    await waitFor(() => {
      const updatedPreview = split.getAttribute('data-preview-sdk');
      expect(updatedPreview).not.toBe(newPreviewSdk);
      expect(updatedPreview).not.toBe(AGY_SDK_PROVIDER_ID);
      expect(CUSTOM_PROVIDER_SDK_AGENT_TYPES.has(updatedPreview!)).toBe(true);
    });

    // Uncheck BYOK restores non-BYOK SDKs
    fireEvent.click(byokCheckbox);
    expect(byokCheckbox.checked).toBe(false);
    expect(document.body.querySelector('[data-sdk-id="agy-sdk"]')).not.toBeNull();
    expect(document.body.querySelector('[data-sdk-id="copilot-sdk"]')).not.toBeNull();

    // Check BYOK again, close menu, and reopen: resets to unchecked
    fireEvent.click(byokCheckbox);
    expect(byokCheckbox.checked).toBe(true);
    fireEvent.click(trigger); // close
    await waitFor(() => expect(document.body.querySelector('[data-testid="quick-sdk-model-split"]')).toBeNull());
    fireEvent.click(trigger); // reopen
    const reopenedCheckbox = await waitFor(() => {
      const cb = document.body.querySelector('[data-testid="quick-sdk-byok-toggle"]') as HTMLInputElement | null;
      expect(cb).not.toBeNull();
      return cb!;
    });
    expect(reopenedCheckbox.checked).toBe(false);
  });
});
