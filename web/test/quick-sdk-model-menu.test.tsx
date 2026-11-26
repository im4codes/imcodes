/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGY_DEFAULT_MODEL_ID, AGY_SDK_PROVIDER_ID } from '@shared/agy-agent.js';
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
  supportsQuickModelTrigger,
} from '../src/components/quick-sdk-model.js';
import { __clearTransportModelCacheForTests } from '../src/hooks/useTransportModels.js';

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
  return {
    connected: true,
    sendSessionCommand: vi.fn(),
    sendSessionCommandUrgent: vi.fn(),
    subSessionSetModel: vi.fn(),
    send: vi.fn(),
    sendInput: vi.fn(),
    onMessage: vi.fn(() => () => {}),
  } as any;
}

function renderSessionControls(
  sessionOverrides: Record<string, unknown> = {},
  propOverrides: Record<string, unknown> = {},
) {
  const ws = makeWs();
  const onSessionSaved = vi.fn();
  const onAfterAction = vi.fn();
  const view = render(
    <SessionControls
      ws={ws}
      activeSession={{
        name: 'deck_app_brain',
        project: 'app',
        role: 'brain',
        state: 'idle',
        projectDir: '/work/app',
        agentType: 'claude-code',
        modelDisplay: 'sonnet',
        ...sessionOverrides,
      } as never}
      quickData={quickData}
      serverId="srv1"
      sessions={[]}
      subSessions={[]}
      onSend={vi.fn()}
      onAfterAction={onAfterAction}
      onSessionSaved={onSessionSaved}
      {...propOverrides}
    />,
  );
  return { ...view, ws, onSessionSaved, onAfterAction };
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

  it('builds SDK groups from session-agent-options and resolves fallback/empty catalogs', () => {
    const groups = getQuickSwitchableSdkGroups('claude-code');
    const allIds = groups.flatMap((g) => g.items.map((item) => item.id));
    expect(allIds).toContain('claude-code');
    expect(allIds).toContain('codex-sdk');
    expect(allIds).not.toContain('shell');
    expect(allIds).not.toContain('openclaw');

    const codexCatalog = resolveCrossSdkModels({ sdk: 'codex-sdk', sessionName: 'deck_app_brain', cachedCatalog: null });
    expect(codexCatalog.models.length).toBeGreaterThan(0);
    expect(codexCatalog.defaultModel).toBeTruthy();

    const opencodeCatalog = resolveCrossSdkModels({ sdk: 'opencode', sessionName: 'deck_app_brain', cachedCatalog: null });
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

    const currentSdkBtn = document.body.querySelector('[data-sdk-id="claude-code"]');
    expect(currentSdkBtn?.classList.contains('is-current')).toBe(true);
    expect(currentSdkBtn?.classList.contains('is-preview')).toBe(true);
    expect(currentSdkBtn?.getAttribute('aria-selected')).toBe('true');

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

  it('lazily queries selected cross-SDK models and triggers patchSession handoff + optimistic callback', async () => {
    const { container, ws, onSessionSaved, onAfterAction } = renderSessionControls();
    fireEvent.click(container.querySelector('[data-testid="session-model-trigger"]') as HTMLButtonElement);

    const codexBtn = document.body.querySelector('[data-sdk-id="codex-sdk"]') as HTMLButtonElement;
    expect(codexBtn).not.toBeNull();
    fireEvent.click(codexBtn);

    await waitFor(() => {
      const listCalls = ws.send.mock.calls
        .map((c: unknown[]) => c[0] as Record<string, unknown>)
        .filter((m) => m && typeof m === 'object' && m.agentType === 'codex-sdk');
      expect(listCalls.length).toBeGreaterThan(0);
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
    });
    expect(onAfterAction).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[data-testid="quick-sdk-model-split"]')).toBeNull();
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
      { name: 'deck_sub_worker1', role: 'w1', agentType: 'claude-code-sdk' },
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
    }));
  });

  it('renders trigger and default-model switch for opencode and hides split column in incognito or blocked sessions', async () => {
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

    // 2. Incognito hides left SDK column (single-column fallback only)
    const incogView = renderSessionControls({ incognito: true });
    fireEvent.click(incogView.container.querySelector('[data-testid="session-model-trigger"]') as HTMLButtonElement);
    expect(document.body.querySelector('[data-testid="quick-sdk-model-split"]')).toBeNull();
    expect(document.body.querySelectorAll('.menu-dropdown-models .menu-item').length).toBeGreaterThan(0);
    cleanup();

    // 3. shell / script / openclaw hide trigger completely
    for (const agentType of ['shell', 'script', 'openclaw']) {
      const view = renderSessionControls({ agentType });
      expect(view.container.querySelector('[data-testid="session-model-trigger"]')).toBeNull();
      cleanup();
    }
  });
});
