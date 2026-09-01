/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup, waitFor, act, within } from '@testing-library/preact';
import {
  CLAUDE_CODE_MODEL_IDS,
  CODEX_MODEL_IDS,
  DEFAULT_CODEX_AUTOMATION_MODEL,
} from '../../../src/shared/models/options.js';
import { DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS } from '../../../shared/supervision-execution-pool.js';

const patchSessionMock = vi.fn();
const patchSubSessionMock = vi.fn();
const fetchSupervisorDefaultsMock = vi.fn();
const fetchExecutionPoolCatalogMock = vi.fn();
const saveSupervisorDefaultsMock = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const parts = key.split('.');
      const leaf = parts[parts.length - 1];
      if (params?.value && typeof params.value === 'string') return `${leaf}:${params.value}`;
      if (params?.backend && params?.model) return `${leaf}:${params.backend}:${params.model}`;
      if (params?.auditor && params?.loops != null) return `${leaf}:${params.auditor}:${params.loops}`;
      if (params?.streak != null && params?.total != null) return `${leaf}:${params.streak}:${params.total}`;
      if (params?.promptVersion) return `${leaf}:${params.promptVersion}`;
      return leaf;
    },
  }),
}));

vi.mock('../../src/api.js', () => ({
  patchSession: (...args: unknown[]) => patchSessionMock(...args),
  patchSubSession: (...args: unknown[]) => patchSubSessionMock(...args),
  fetchSupervisorDefaults: (...args: unknown[]) => fetchSupervisorDefaultsMock(...args),
  fetchSessionSupervisorDefaults: (...args: unknown[]) => fetchSupervisorDefaultsMock(...args),
  fetchSessionSupervisorExecutionPoolCatalog: (...args: unknown[]) => fetchExecutionPoolCatalogMock(...args),
  saveSessionSupervisorDefaults: (_serverId: string, _sessionName: string, value: unknown) => saveSupervisorDefaultsMock(value),
  saveSupervisorDefaults: (...args: unknown[]) => saveSupervisorDefaultsMock(...args),
  getUserPref: () => fetchSupervisorDefaultsMock(),
  saveUserPref: (_key: string, value: unknown) => saveSupervisorDefaultsMock(value),
  onUserPrefChanged: () => () => undefined,
}));

import {
  SessionSettingsDialog,
  buildSupervisionExecutionPoolCandidates,
} from '../../src/components/SessionSettingsDialog.js';

function inputForLabel(label: string, index = 0): HTMLInputElement {
  const labels = screen.getAllByText(label);
  const container = labels[index]?.parentElement;
  const input = container?.querySelector('input');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Missing input for label ${label} at index ${index}`);
  }
  return input;
}

function changeSelect(select: HTMLElement, value: string): void {
  const element = select as HTMLSelectElement;
  element.value = value;
  fireEvent.input(element);
  fireEvent.change(element);
}

function changeSupervisionMode(value: string): void {
  changeSelect(screen.getByLabelText('supervision-session:mode'), value);
}

function changeRuntimeBackend(idPrefix: 'supervision-defaults' | 'supervision-defaults-backup', value: string): void {
  changeSelect(screen.getByLabelText(`${idPrefix}:backend`), value);
}

function selectRuntimeModel(
  idPrefix: 'supervision-defaults' | 'supervision-defaults-backup',
  model: string,
): void {
  changeSelect(screen.getByLabelText(`${idPrefix}:model`), model);
}

function makePeerAuditSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionName: 'deck_sub_peer',
    parentSession: 'deck_proj_brain',
    type: 'codex-sdk',
    runtimeType: 'transport' as const,
    label: 'Peer',
    state: 'idle',
    sessionInstanceId: 'peer-instance-1',
    runtimeEpoch: 'peer-runtime-1',
    activeModel: 'gpt-5.6',
    requestedModel: 'gpt-5.6',
    providerId: 'openai',
    ...overrides,
  };
}

describe('SessionSettingsDialog supervision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSupervisorDefaultsMock.mockRejectedValue(new Error('no defaults'));
    fetchExecutionPoolCatalogMock.mockResolvedValue([]);
    saveSupervisorDefaultsMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it('forces automatic supervision off for non-Brain settings', () => {
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision={false}
        serverId="srv-1"
        sessionName="deck_proj_worker"
        label="Worker"
        description=""
        cwd="/proj"
        type="codex-sdk"
        transportConfig={{
          supervision: {
            mode: 'supervised_audit',
            backend: 'codex-sdk',
            model: CODEX_MODEL_IDS[0],
            timeoutMs: 30_000,
            promptVersion: 'supervision_decision_v1',
            auditTargetSessionName: 'deck_sub_peer',
          },
        }}
        peerAuditSessions={[makePeerAuditSession()] as any}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const mode = screen.getByLabelText('supervision-session:mode') as HTMLSelectElement;
    expect(mode.disabled).toBe(true);
    expect(mode.value).toBe('off');
    expect(screen.getByText('brainOnly')).toBeDefined();
  });

  it('shows the working directory as read-only and omits cwd when saving a main session', async () => {
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        transportConfig={{
          supervision: {
            mode: 'supervised',
            backend: 'codex-sdk',
            model: CODEX_MODEL_IDS[0],
            timeoutMs: 30_000,
            promptVersion: 'supervision_decision_v1',
          },
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const cwdInput = inputForLabel('workingDir');
    expect(cwdInput.value).toBe('/proj');
    expect(cwdInput.disabled).toBe(true);

    fireEvent.input(inputForLabel('label'), { target: { value: 'Brain renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(patchSessionMock).toHaveBeenCalledWith('srv-1', 'deck_proj_brain', expect.objectContaining({
        label: 'Brain renamed',
      }));
    });
    expect(patchSessionMock.mock.calls[0]?.[2]).not.toHaveProperty('cwd');
  });

  it('shows the working directory as read-only and omits cwd when saving a sub-session', async () => {
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_sub_abcd1234"
        subSessionId="abcd1234"
        label="Worker"
        description=""
        cwd="/proj/sub"
        type="codex-sdk"
        parentSession="deck_proj_brain"
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const cwdInput = inputForLabel('workingDir');
    expect(cwdInput.value).toBe('/proj/sub');
    expect(cwdInput.disabled).toBe(true);

    fireEvent.input(inputForLabel('label'), { target: { value: 'Worker renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(patchSubSessionMock).toHaveBeenCalledWith('srv-1', 'abcd1234', expect.objectContaining({
        label: 'Worker renamed',
      }));
    });
    expect(patchSubSessionMock.mock.calls[0]?.[2]).not.toHaveProperty('cwd');
  });

  it('uses global runtime selection and exposes no session-level model controls', async () => {
    const onSaved = vi.fn();
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );

    changeSupervisionMode('supervised');
    expect(screen.getAllByText('backend')).toHaveLength(2);
    expect(screen.queryByTestId('supervision-session-runtime-model-preset-selector')).toBeNull();
    expect(screen.getByText('usesGlobalRuntime')).toBeDefined();
    expect((screen.getByLabelText('supervision-defaults:model') as HTMLSelectElement).value).toBe(DEFAULT_CODEX_AUTOMATION_MODEL);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(patchSessionMock).toHaveBeenCalledWith('srv-1', 'deck_proj_brain', expect.objectContaining({
        transportConfig: expect.objectContaining({
          supervision: expect.objectContaining({
            mode: 'supervised',
            backend: 'codex-sdk',
            model: DEFAULT_CODEX_AUTOMATION_MODEL,
          }),
        }),
      }));
    });
    expect(saveSupervisorDefaultsMock).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({
      transportConfig: expect.objectContaining({
        supervision: expect.objectContaining({
          mode: 'supervised',
        }),
      }),
    }));
  });

  it('defaults Auto and audit settings to Codex 5.3 Spark while keeping GPT-5.6 selectable', async () => {
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const backendSelect = screen.getByLabelText('supervision-defaults:backend') as HTMLSelectElement;
    await waitFor(() => {
      expect(backendSelect.value).toBe('codex-sdk');
      const modelSelect = screen.getByLabelText('supervision-defaults:model') as HTMLSelectElement;
      expect(modelSelect.value).toBe(DEFAULT_CODEX_AUTOMATION_MODEL);
      expect([...modelSelect.options].some((option) => option.value === 'gpt-5.6')).toBe(true);
    });
  });

  it('saves a selected session name immediately without identity refresh or a candidate RPC', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const ws = {
      connected: true,
      send(message: Record<string, unknown>) { sent.push(message); },
      onMessage: () => () => undefined,
    } as any;
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        activeModel={CODEX_MODEL_IDS[0]}
        sessionInstanceId="brain-instance-1"
        runtimeEpoch="brain-runtime-1"
        ws={ws}
        peerAuditSessions={[makePeerAuditSession({ sessionInstanceId: null, runtimeEpoch: null })]}
        transportConfig={{
          supervision: {
            mode: 'supervised_audit',
            backend: 'codex-sdk',
            model: CODEX_MODEL_IDS[0],
            timeoutMs: 12_000,
            promptVersion: 'supervision_decision_v1',
            maxAuditLoops: 2,
          },
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByTestId('peer-audit-chooser-row').textContent).toContain('Peer');
    expect(screen.queryByTestId('peer-audit-chooser-empty')).toBeNull();
    fireEvent.click(screen.getByTestId('peer-audit-chooser-row'));
    expect(screen.queryByTestId('peer-audit-candidate-waiting-authority')).toBeNull();
    expect(screen.queryByTestId('peer-audit-candidate-loading')).toBeNull();
    expect(sent.some((message) => message.type === 'peer_audit.list_candidates')).toBe(false);
    expect((screen.getByRole('button', { name: /save/i }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(patchSessionMock).toHaveBeenCalledWith('srv-1', 'deck_proj_brain', expect.objectContaining({
        transportConfig: expect.objectContaining({
          supervision: expect.objectContaining({
            auditTargetSessionName: 'deck_sub_peer',
          }),
        }),
      }));
    });
    const saved = patchSessionMock.mock.calls.at(-1)?.[2] as { transportConfig?: { supervision?: Record<string, unknown> } };
    expect(saved.transportConfig?.supervision).not.toHaveProperty('auditTargetFingerprint');
  });

  it('seeds a quick-open audit draft immediately instead of leaving Save disabled', async () => {
    fetchSupervisorDefaultsMock.mockResolvedValue({
      backend: 'codex-sdk',
      model: CODEX_MODEL_IDS[0],
      timeoutMs: 12_000,
      promptVersion: 'supervision_decision_v1',
      maxAutoContinueStreak: 3,
      maxAutoContinueTotal: 0,
    });
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        activeModel={CODEX_MODEL_IDS[0]}
        peerAuditSessions={[makePeerAuditSession({ sessionInstanceId: null, runtimeEpoch: null })]}
        transportConfig={null}
        openIntent={{ supervisionMode: 'supervised_audit', focus: 'peer-audit-target' }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('peer-audit-chooser-row'));

    await waitFor(() => {
      expect(screen.queryByText('backendRequired')).toBeNull();
      expect(screen.getByText(`summaryBackendModel:codex_sdk:${DEFAULT_CODEX_AUTOMATION_MODEL}`)).toBeDefined();
      expect((screen.getByRole('button', { name: /save/i }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('persists the default Brain model to account defaults without another pool interaction', async () => {
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        activeModel={CODEX_MODEL_IDS[0]}
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const primary = screen.getByTestId('supervision-execution-pool-primary');
    const economy = screen.getByTestId('supervision-execution-pool-economy');
    expect(within(primary).getByLabelText(`primary:configured:codex-sdk:${CODEX_MODEL_IDS[0]}`)).toHaveProperty('checked', true);
    expect(within(primary).getByTestId('supervision-execution-pool-primary-empty')).toBeDefined();
    expect(within(economy).getByTestId('supervision-execution-pool-economy-empty')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(saveSupervisorDefaultsMock).toHaveBeenCalledWith(expect.objectContaining({
        executionPools: expect.objectContaining({
          state: 'configured',
          primaryDevelopmentPool: expect.objectContaining({
            configs: [expect.objectContaining({ model: CODEX_MODEL_IDS[0] })],
          }),
          economyTaskPool: expect.objectContaining({ configs: [] }),
        }),
      }));
      expect(patchSessionMock).not.toHaveBeenCalled();
    });
  });

  it('allows adding a low-tier model to the economy pool', async () => {
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        activeModel={CODEX_MODEL_IDS[0]}
        peerAuditSessions={[makePeerAuditSession({
          sessionName: 'deck_sub_spark',
          label: 'Spark helper',
          activeModel: DEFAULT_CODEX_AUTOMATION_MODEL,
          requestedModel: DEFAULT_CODEX_AUTOMATION_MODEL,
        })]}
        transportConfig={{
          supervision: {
            mode: 'supervised',
            backend: 'codex-sdk',
            model: CODEX_MODEL_IDS[0],
            timeoutMs: 30_000,
            promptVersion: 'supervision_decision_v1',
          },
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const primary = screen.getByTestId('supervision-execution-pool-primary');
    const economy = screen.getByTestId('supervision-execution-pool-economy');
    expect(within(primary).queryByLabelText('primary:deck_sub_spark')).toBeNull();
    const economySpark = within(economy).getByLabelText('economy:deck_sub_spark');
    fireEvent.click(economySpark);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(saveSupervisorDefaultsMock).toHaveBeenCalledWith(expect.objectContaining({
        executionPools: expect.objectContaining({
          state: 'configured',
          primaryDevelopmentPool: expect.objectContaining({
            configs: [expect.objectContaining({ model: CODEX_MODEL_IDS[0] })],
          }),
          economyTaskPool: expect.objectContaining({
            configs: [expect.objectContaining({ model: 'gpt-5.3-codex-spark' })],
          }),
        }),
      }));
      expect(patchSessionMock).toHaveBeenCalledWith('srv-1', 'deck_proj_brain', expect.objectContaining({
        transportConfig: expect.objectContaining({
          supervision: expect.objectContaining({
            executionPools: expect.objectContaining({
              economyTaskPool: expect.objectContaining({
                configs: [expect.objectContaining({ model: DEFAULT_CODEX_AUTOMATION_MODEL })],
              }),
            }),
          }),
        }),
      }));
    });
  });

  it('derives pool candidates only from open reply-capable sub-sessions with known models', () => {
    const candidates = buildSupervisionExecutionPoolCandidates({
      sessionName: 'deck_proj_brain',
      sessions: [
        makePeerAuditSession({ sessionName: 'deck_sub_ready', label: 'Ready', state: 'idle', activeModel: 'gpt-5.6' }),
        makePeerAuditSession({ sessionName: 'deck_sub_starting', label: 'Starting', state: 'starting', activeModel: 'gpt-5.5' }),
        makePeerAuditSession({ sessionName: 'deck_sub_stopped', state: 'stopped' }),
        makePeerAuditSession({ sessionName: 'deck_sub_closed', closedAt: Date.now() }),
        makePeerAuditSession({ sessionName: 'deck_sub_shell', type: 'shell' }),
        makePeerAuditSession({ sessionName: 'deck_sub_unknown', activeModel: null, requestedModel: null, modelDisplay: null }),
        makePeerAuditSession({ sessionName: 'deck_sub_other', parentSession: 'deck_other_brain' }),
      ],
    });

    expect(candidates.map((candidate) => candidate.sessionNames)).toEqual([
      ['deck_sub_ready'],
      ['deck_sub_starting'],
    ]);
    expect(candidates[0]).toMatchObject({
      label: 'Ready',
      config: {
        agentType: 'codex-sdk',
        providerFamily: 'openai',
        runtimeType: 'transport',
        model: 'gpt-5.6',
      },
    });
  });

  it('deduplicates canonical constraints while retaining Cx, CC preset, Cursor, and Ds live evidence', () => {
    const candidates = buildSupervisionExecutionPoolCandidates({
      sessionName: 'deck_proj_brain',
      sessions: [
        makePeerAuditSession({ sessionName: 'deck_sub_cx1', label: 'Cx1', activeModel: 'gpt-5.6' }),
        makePeerAuditSession({ sessionName: 'deck_sub_cx2', label: 'Cx2', activeModel: 'gpt-5.6' }),
        makePeerAuditSession({ sessionName: 'deck_sub_cursor', label: 'Cursor', type: 'cursor-headless', providerId: 'cursor', activeModel: 'cursor-large' }),
        makePeerAuditSession({ sessionName: 'deck_sub_ds', label: 'Ds', type: 'deepseek-harness', providerId: 'deepseek', activeModel: 'deepseek-reasoner' }),
        makePeerAuditSession({ sessionName: 'deck_sub_cc_a1', label: 'CC A1', type: 'claude-code-sdk', providerId: 'anthropic', activeModel: 'MiniMax-M3', ccPresetId: 'preset-a' }),
        makePeerAuditSession({ sessionName: 'deck_sub_cc_a2', label: 'CC A2', type: 'claude-code-sdk', providerId: 'anthropic', activeModel: 'MiniMax-M3', ccPresetId: 'preset-a' }),
        makePeerAuditSession({ sessionName: 'deck_sub_cc_b', label: 'CC B', type: 'claude-code-sdk', providerId: 'anthropic', activeModel: 'MiniMax-M3', ccPresetId: 'preset-b' }),
        makePeerAuditSession({ sessionName: 'deck_sub_bad_preset', type: 'codex-sdk', ccPresetId: 'preset-a' }),
        makePeerAuditSession({ sessionName: 'deck_sub_clone', executionCloneKind: 'supervision-execution', parentRunId: 'run-1' }),
        makePeerAuditSession({ sessionName: 'deck_sub_parent_run', parentRunId: 'run-2' }),
        makePeerAuditSession({ sessionName: 'deck_sub_stopped', state: 'stopped' }),
        makePeerAuditSession({ sessionName: 'deck_sub_unknown', activeModel: null, requestedModel: null, modelDisplay: null }),
        makePeerAuditSession({ sessionName: 'deck_sub_shell', type: 'shell' }),
      ],
    });

    expect(candidates).toHaveLength(5);
    expect(candidates.find((candidate) => candidate.config.agentType === 'codex-sdk')).toMatchObject({
      sessionNames: ['deck_sub_cx1', 'deck_sub_cx2'],
      labels: ['Cx1', 'Cx2'],
      matchingSessionCount: 2,
      config: { providerFamily: 'openai', model: 'gpt-5.6' },
    });
    expect(candidates.map((candidate) => candidate.config.agentType)).toEqual(expect.arrayContaining([
      'cursor-headless', 'deepseek-harness', 'claude-code-sdk',
    ]));
    const presets = candidates
      .filter((candidate) => candidate.config.agentType === 'claude-code-sdk')
      .sort((left, right) => (left.config.ccPresetId ?? '').localeCompare(right.config.ccPresetId ?? ''));
    expect(presets.map((candidate) => [candidate.config.ccPresetId, candidate.sessionNames])).toEqual([
      ['preset-a', ['deck_sub_cc_a1', 'deck_sub_cc_a2']],
      ['preset-b', ['deck_sub_cc_b']],
    ]);
  });

  it('shows session, SDK, and model and keeps primary/economy selection mutually exclusive', () => {
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        activeModel={CODEX_MODEL_IDS[0]}
        peerAuditSessions={[makePeerAuditSession({
          sessionName: 'deck_sub_worker',
          label: 'Integration worker',
          activeModel: 'gpt-5.6',
          requestedModel: 'gpt-5.6',
        })]}
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const primary = screen.getByTestId('supervision-execution-pool-primary');
    const economy = screen.getByTestId('supervision-execution-pool-economy');
    const primaryWorker = within(primary).getByLabelText('primary:deck_sub_worker') as HTMLInputElement;
    const economyWorker = within(economy).getByLabelText('economy:deck_sub_worker') as HTMLInputElement;
    expect(primary.textContent).toContain('Integration worker');
    expect(primary.textContent).toContain('deck_sub_worker');
    expect(primary.textContent).toContain('codex_sdk · gpt-5.6');

    fireEvent.click(primaryWorker);
    expect(primaryWorker.checked).toBe(true);
    expect(economyWorker.checked).toBe(false);
    fireEvent.click(economyWorker);
    expect(primaryWorker.checked).toBe(false);
    expect(economyWorker.checked).toBe(true);
    fireEvent.click(primaryWorker);
    expect(primaryWorker.checked).toBe(true);
    expect(economyWorker.checked).toBe(false);
  });

  it('persists a CC preset constraint without binding it to a live session', async () => {
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        activeModel={CODEX_MODEL_IDS[0]}
        peerAuditSessions={[makePeerAuditSession({
          sessionName: 'deck_sub_cc_preset',
          label: 'CC preset worker',
          type: 'claude-code-sdk',
          providerId: 'anthropic',
          activeModel: 'MiniMax-M3',
          requestedModel: 'MiniMax-M3',
          ccPresetId: 'preset-a',
        })]}
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(within(screen.getByTestId('supervision-execution-pool-primary'))
      .getByLabelText('primary:deck_sub_cc_preset'));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saveSupervisorDefaultsMock).toHaveBeenCalled());
    const saved = saveSupervisorDefaultsMock.mock.calls.at(-1)?.[0] as {
      executionPools?: { primaryDevelopmentPool?: { configs?: Array<Record<string, unknown>> } };
    };
    const preset = saved.executionPools?.primaryDevelopmentPool?.configs
      ?.find((config) => config.ccPresetId === 'preset-a');
    expect(preset).toMatchObject({
      agentType: 'claude-code-sdk',
      providerFamily: 'anthropic',
      model: 'minimax-m3',
      ccPresetId: 'preset-a',
    });
    expect(preset).not.toHaveProperty('sessionName');
  });

  it('shows an owner-authoritative empty-pool catalog to a participant once per constraint and leaves it unchecked', async () => {
    fetchSupervisorDefaultsMock.mockResolvedValue({
      backend: 'codex-sdk',
      model: CODEX_MODEL_IDS[0],
      executionPools: {
        state: 'configured',
        primaryDevelopmentPool: { configs: [], controls: DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS.primary },
        economyTaskPool: { configs: [], controls: DEFAULT_SUPERVISION_EXECUTION_POOL_CONTROLS.economy },
      },
    });
    fetchExecutionPoolCatalogMock.mockResolvedValue([
      {
        sessionName: 'deck_sub_cx_one', parentSession: 'deck_proj_brain', type: 'codex-sdk', runtimeType: 'transport',
        label: 'Cx one', activeModel: 'gpt-5.6', providerId: 'openai', ccPresetId: null,
        capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-5.6', ownerCatalog: true,
      },
      {
        sessionName: 'deck_sub_cx_two', parentSession: 'deck_proj_brain', type: 'codex-sdk', runtimeType: 'transport',
        label: 'Cx two', activeModel: 'gpt-5.6', providerId: 'openai', ccPresetId: null,
        capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-5.6', ownerCatalog: true,
      },
      {
        sessionName: 'deck_sub_cc_preset', parentSession: 'deck_proj_brain', type: 'claude-code-sdk', runtimeType: 'transport',
        label: 'CC preset', activeModel: 'minimax-m3', providerId: 'anthropic', ccPresetId: 'preset-a',
        capabilityId: 'supervision-exec-v1-cc-preset:transport:claude-code-sdk:anthropic:preset-a:minimax-m3', ownerCatalog: true,
      },
    ]);
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        activeModel={CODEX_MODEL_IDS[0]}
        peerAuditSessions={[]}
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const primary = screen.getByTestId('supervision-execution-pool-primary');
    const economy = screen.getByTestId('supervision-execution-pool-economy');
    const primaryCx = await within(primary).findByLabelText('primary:deck_sub_cx_one,deck_sub_cx_two') as HTMLInputElement;
    const economyCx = within(economy).getByLabelText('economy:deck_sub_cx_one,deck_sub_cx_two') as HTMLInputElement;
    const economyPreset = within(economy).getByLabelText('economy:deck_sub_cc_preset') as HTMLInputElement;
    expect(primaryCx.checked).toBe(false);
    expect(economyCx.checked).toBe(false);
    expect(economyPreset.checked).toBe(false);
    expect(primary.textContent).toContain('×2');
    await waitFor(() => expect(primary.querySelectorAll('input[type="checkbox"]')).toHaveLength(2));

    fireEvent.click(economyPreset);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(saveSupervisorDefaultsMock).toHaveBeenCalled());
    const saved = saveSupervisorDefaultsMock.mock.calls.at(-1)?.[0] as {
      executionPools?: {
        primaryDevelopmentPool?: { configs?: Array<Record<string, unknown>> };
        economyTaskPool?: { configs?: Array<Record<string, unknown>> };
      };
    };
    expect(saved.executionPools?.primaryDevelopmentPool?.configs).toEqual([]);
    expect(saved.executionPools?.economyTaskPool?.configs).toEqual([
      expect.objectContaining({ ccPresetId: 'preset-a' }),
    ]);
  });

  it('clears an owner catalog immediately when the covered session scope changes and the replacement load fails', async () => {
    fetchSupervisorDefaultsMock.mockResolvedValue(null);
    fetchExecutionPoolCatalogMock
      .mockResolvedValueOnce([{
        sessionName: 'deck_sub_old', parentSession: 'deck_proj_brain', type: 'codex-sdk', runtimeType: 'transport',
        label: 'Old owner candidate', activeModel: 'gpt-5.6', providerId: 'openai', ccPresetId: null,
        capabilityId: 'supervision-exec-v1:transport:codex-sdk:openai:gpt-5.6', ownerCatalog: true,
      }])
      .mockRejectedValueOnce(new Error('new owner denied'));
    const view = render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        peerAuditSessions={[]}
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getAllByText('Old owner candidate')).toHaveLength(2));

    view.rerender(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-2"
        sessionName="deck_other_brain"
        label="Other"
        description="desc"
        cwd="/other"
        type="codex-sdk"
        peerAuditSessions={[]}
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.queryAllByText('Old owner candidate')).toHaveLength(0);
    await waitFor(() => expect(fetchExecutionPoolCatalogMock).toHaveBeenCalledWith('srv-2', 'deck_other_brain'));
    expect(screen.queryAllByText('Old owner candidate')).toHaveLength(0);
  });

  it('routes each pool add button to the existing sub-session launcher and accepts the new starting session immediately', () => {
    const onAddPoolSession = vi.fn();
    const view = render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        activeModel={CODEX_MODEL_IDS[0]}
        peerAuditSessions={[]}
        transportConfig={null}
        onAddPoolSession={onAddPoolSession}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(within(screen.getByTestId('supervision-execution-pool-primary'))
      .getByRole('button', { name: 'addPoolSession' }));
    expect(onAddPoolSession).toHaveBeenCalledWith('primary');

    view.rerender(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        activeModel={CODEX_MODEL_IDS[0]}
        peerAuditSessions={[makePeerAuditSession({
          sessionName: 'deck_sub_new',
          label: 'New provider',
          state: 'starting',
          activeModel: 'gpt-5.5',
          requestedModel: 'gpt-5.5',
        })]}
        transportConfig={null}
        onAddPoolSession={onAddPoolSession}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(within(screen.getByTestId('supervision-execution-pool-primary'))
      .getByLabelText('primary:deck_sub_new')).toBeDefined();
  });

  it('portals above control overlays and always keeps Close and Cancel actionable', () => {
    const onClose = vi.fn();
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        transportConfig={null}
        onClose={onClose}
        onSaved={vi.fn()}
      />,
    );

    const overlay = document.querySelector('.session-settings-overlay');
    expect(overlay?.parentElement).toBe(document.body);
    fireEvent.click(screen.getByRole('button', { name: /^close$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('uses the responsive themed settings shell instead of native dialog chrome', () => {
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const dialog = document.querySelector('.session-settings-dialog');
    expect(dialog).toBeTruthy();
    expect(dialog?.querySelector('.session-settings-header')).toBeTruthy();
    expect(dialog?.querySelector('.session-settings-body')).toBeTruthy();
    expect(dialog?.querySelector('.session-settings-footer')).toBeTruthy();
    expect(dialog?.querySelectorAll('.session-settings-card')).toHaveLength(2);
    expect(dialog?.querySelectorAll('.session-settings-field').length).toBeGreaterThanOrEqual(5);

    const close = screen.getByRole('button', { name: /^close$/i });
    expect(close.classList.contains('session-settings-close')).toBe(true);
    expect(close.textContent).toContain('×');
  });

  it('only offers reply-capable sessions from the audited session group', () => {
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        peerAuditSessions={[
          makePeerAuditSession(),
          makePeerAuditSession({ sessionName: 'deck_sub_other', parentSession: 'deck_other_brain', label: 'Other project' }),
          makePeerAuditSession({ sessionName: 'deck_sub_shell', type: 'shell', label: 'Shell' }),
          makePeerAuditSession({ sessionName: 'deck_proj_brain', label: 'Self' }),
        ]}
        transportConfig={{
          supervision: {
            mode: 'supervised_audit',
            backend: 'codex-sdk',
            model: CODEX_MODEL_IDS[0],
            timeoutMs: 12_000,
            promptVersion: 'supervision_decision_v1',
            maxAuditLoops: 2,
          },
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getAllByTestId('peer-audit-chooser-row')).toHaveLength(1);
    expect(screen.getByTestId('peer-audit-chooser-row').textContent).toContain('Peer');
    expect(document.body.textContent).not.toContain('Other project');
    expect(document.body.textContent).not.toContain('Shell');
  });

  it('shows the remembered auditor picker and persists only the selected session name', async () => {
    fetchSupervisorDefaultsMock.mockResolvedValue({
      backend: 'claude-code-sdk',
      model: CLAUDE_CODE_MODEL_IDS[0],
      timeoutMs: 12_000,
      promptVersion: 'supervision_decision_v1',
    });
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="claude-code-sdk"
        peerAuditSessions={[makePeerAuditSession()]}
        sessionInstanceId="brain-instance-1"
        runtimeEpoch="brain-runtime-1"
        transportConfig={{
          supervision: {
            mode: 'supervised',
            backend: 'claude-code-sdk',
            model: CLAUDE_CODE_MODEL_IDS[0],
            timeoutMs: 12_000,
            promptVersion: 'supervision_decision_v1',
            auditTargetSessionName: 'deck_sub_peer',
            auditTargetFingerprint: {
              sessionInstanceId: 'peer-instance-1',
              normalizedModelId: 'gpt-5.6',
              providerFamily: 'openai',
            },
            peerAuditPromptVersion: 'supervision_peer_audit_v1',
          },
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    changeSupervisionMode('supervised_audit');
    await waitFor(() => {
      expect(screen.getByTestId('peer-audit-settings-selected').textContent).toContain('Peer');
    });
    expect(screen.getByText('maxAuditLoops')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(patchSessionMock).toHaveBeenCalledWith('srv-1', 'deck_proj_brain', expect.objectContaining({
        transportConfig: expect.objectContaining({
          supervision: expect.objectContaining({
            mode: 'supervised_audit',
            auditTargetSessionName: 'deck_sub_peer',
            peerAuditPromptVersion: 'supervision_peer_audit_v1',
          }),
        }),
      }));
    });
    const saved = patchSessionMock.mock.calls.at(-1)?.[2] as { transportConfig?: { supervision?: Record<string, unknown> } };
    expect(saved.transportConfig?.supervision).not.toHaveProperty('auditTargetFingerprint');
  });

  it('remembers the current session auditor when saving supervised mode', async () => {
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        peerAuditSessions={[makePeerAuditSession()]}
        transportConfig={{
          supervision: {
            mode: 'supervised_audit',
            backend: 'codex-sdk',
            model: CODEX_MODEL_IDS[0],
            timeoutMs: 12_000,
            promptVersion: 'supervision_decision_v1',
            auditTargetSessionName: 'deck_sub_peer',
            peerAuditPromptVersion: 'supervision_peer_audit_v1',
            maxAuditLoops: 2,
          },
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    changeSupervisionMode('supervised');
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(patchSessionMock).toHaveBeenCalledWith('srv-1', 'deck_proj_brain', expect.objectContaining({
        transportConfig: expect.objectContaining({
          supervision: expect.objectContaining({
            mode: 'supervised',
            auditTargetSessionName: 'deck_sub_peer',
            peerAuditPromptVersion: 'supervision_peer_audit_v1',
          }),
        }),
      }));
    });
  });

  it('opens directly in audit mode and focuses the auditor picker when requested from Auto', async () => {
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="claude-code-sdk"
        peerAuditSessions={[makePeerAuditSession()]}
        sessionInstanceId="brain-instance-1"
        runtimeEpoch="brain-runtime-1"
        transportConfig={{
          supervision: {
            mode: 'supervised',
            backend: 'claude-code-sdk',
            model: CLAUDE_CODE_MODEL_IDS[0],
            timeoutMs: 12_000,
            promptVersion: 'supervision_decision_v1',
          },
        }}
        openIntent={{ supervisionMode: 'supervised_audit', focus: 'peer-audit-target' }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const modeSelect = screen.getByLabelText('supervision-session:mode') as HTMLSelectElement;
    expect(modeSelect.value).toBe('supervised_audit');
    const targetSection = screen.getByTestId('session-supervision-peer-target-section');
    await waitFor(() => expect(document.activeElement).toBe(targetSection));
    await waitFor(() => expect(screen.getByTestId('peer-audit-chooser-row')).toBeDefined());
  });

  it('shows current candidate metadata without requiring fingerprint confirmation', async () => {
    fetchSupervisorDefaultsMock.mockResolvedValue({
      backend: 'claude-code-sdk',
      model: CLAUDE_CODE_MODEL_IDS[0],
      timeoutMs: 12_000,
      promptVersion: 'supervision_decision_v1',
    });
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="claude-code-sdk"
        peerAuditSessions={[makePeerAuditSession({ activeModel: 'gpt-5.7' })]}
        sessionInstanceId="brain-instance-1"
        runtimeEpoch="brain-runtime-1"
        transportConfig={{
          supervision: {
            mode: 'supervised_audit',
            backend: 'claude-code-sdk',
            model: CLAUDE_CODE_MODEL_IDS[0],
            timeoutMs: 12_000,
            promptVersion: 'supervision_decision_v1',
            auditTargetSessionName: 'deck_sub_peer',
            auditTargetFingerprint: {
              sessionInstanceId: 'peer-instance-1',
              normalizedModelId: 'gpt-5.6',
              providerFamily: 'openai',
            },
            peerAuditPromptVersion: 'supervision_peer_audit_v1',
          },
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('peer-audit-settings-selected').textContent).toContain('gpt-5.7'));
    expect(screen.queryByTestId('peer-audit-settings-confirm')).toBeNull();
  });

  it('prefills from saved supervisor defaults when available', async () => {
    fetchSupervisorDefaultsMock.mockResolvedValue({
      backend: 'codex-sdk',
      model: CODEX_MODEL_IDS[0],
      timeoutMs: 18_000,
      promptVersion: 'supervision_decision_v1',
      maxAutoContinueStreak: 4,
      maxAutoContinueTotal: 9,
    });

    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(fetchSupervisorDefaultsMock).toHaveBeenCalledTimes(1);
    });

    changeSupervisionMode('supervised');
    expect(screen.getAllByDisplayValue('30')).toHaveLength(1);
    expect(screen.getAllByDisplayValue('4').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByDisplayValue('9').length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(patchSessionMock).toHaveBeenCalledWith('srv-1', 'deck_proj_brain', expect.objectContaining({
        transportConfig: expect.objectContaining({
          supervision: expect.objectContaining({
            mode: 'supervised',
            backend: 'codex-sdk',
            model: CODEX_MODEL_IDS[0],
            timeoutMs: 30_000,
          }),
        }),
      }));
    });
  });

  it('renders persisted supervision snapshot in the summary', () => {
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        transportConfig={{
          supervision: {
            mode: 'supervised_audit',
            backend: 'codex-sdk',
            model: CODEX_MODEL_IDS[0],
            timeoutMs: 9000,
            promptVersion: 'supervision_decision_v1',
            customInstructions: 'Always prefer adding tests before claiming completion.',
            maxParseRetries: 1,
            maxAutoContinueStreak: 2,
            maxAutoContinueTotal: 8,
            auditTargetSessionName: 'deck_sub_peer',
            auditTargetFingerprint: {
              sessionInstanceId: 'peer-instance-1',
              normalizedModelId: 'claude-opus-4-7',
              providerFamily: 'anthropic',
            },
            peerAuditPromptVersion: 'supervision_peer_audit_v1',
            maxAuditLoops: 3,
            taskRunPromptVersion: 'task_run_status_v1',
          },
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByText('summaryMode:supervised_audit')).toBeDefined();
    expect(screen.getByText(`summaryBackendModel:codex_sdk:${DEFAULT_CODEX_AUTOMATION_MODEL}`)).toBeDefined();
    expect(screen.getByText('summaryTimeout:30 s')).toBeDefined();
    expect(screen.getByText('summaryContinueLimits:2:8')).toBeDefined();
    expect(screen.getByText('summaryCustomInstructions:summaryCustomInstructionsSet')).toBeDefined();
    expect(screen.getByText('summaryAudit:summaryUnset:3')).toBeDefined();
    expect(document.body.textContent).not.toContain('deck_sub_peer');
    expect(screen.getByText('summaryMeta:supervision_decision_v1')).toBeDefined();
  });

  it('saves global auto-continue defaults together with the session override', async () => {
    fetchSupervisorDefaultsMock.mockResolvedValue({
      backend: 'codex-sdk',
      model: CODEX_MODEL_IDS[0],
      timeoutMs: 12_000,
      promptVersion: 'supervision_decision_v1',
      maxAutoContinueStreak: 2,
      maxAutoContinueTotal: 8,
    });

    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(fetchSupervisorDefaultsMock).toHaveBeenCalledWith('srv-1', 'deck_proj_brain');
    });

    fireEvent.input(inputForLabel('maxAutoContinueStreak', 0), { target: { value: '5' } });
    fireEvent.input(inputForLabel('maxAutoContinueTotal', 0), { target: { value: '11' } });
    changeSupervisionMode('supervised');
    fireEvent.input(inputForLabel('maxAutoContinueStreak', 1), { target: { value: '3' } });
    fireEvent.input(inputForLabel('maxAutoContinueTotal', 1), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(saveSupervisorDefaultsMock).toHaveBeenCalledWith(expect.objectContaining({
        maxAutoContinueStreak: 5,
        maxAutoContinueTotal: 11,
      }));
      expect(patchSessionMock).toHaveBeenCalledWith('srv-1', 'deck_proj_brain', expect.objectContaining({
        transportConfig: expect.objectContaining({
          supervision: expect.objectContaining({
            maxAutoContinueStreak: 3,
            maxAutoContinueTotal: 6,
          }),
        }),
      }));
    });
  });

  it('shows and persists a third-party preset in the unified supervision runtime selector', async () => {
    // Stub ws that records sent messages and lets the test dispatch a preset list.
    // Pattern (Set of handlers + `act`-wrapped dispatch) mirrors the existing
    // SharedContextManagementPanel test, which the supervision picker reuses.
    const sent: Array<Record<string, unknown>> = [];
    const handlers = new Set<(message: unknown) => void>();
    const wsStub = {
      connected: true,
      send(message: Record<string, unknown>) { sent.push(message); },
      onMessage(handler: (message: unknown) => void) {
        handlers.add(handler);
        return () => { handlers.delete(handler); };
      },
    };

    fetchSupervisorDefaultsMock.mockResolvedValue({
      backend: 'qwen',
      model: 'qwen3-coder-plus',
      timeoutMs: 12_000,
      promptVersion: 'supervision_decision_v1',
    });

    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="qwen"
        transportConfig={null}
        ws={wsStub as unknown as import('../../src/ws-client.js').WsClient}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(fetchSupervisorDefaultsMock).toHaveBeenCalled();
      expect(sent).toContainEqual(expect.objectContaining({
        type: 'cc.presets.list',
        requestId: expect.any(String),
        sessionName: 'deck_proj_brain',
      }));
      expect(sent).toContainEqual(expect.objectContaining({
        type: 'transport.list_models',
        agentType: 'qwen',
        sessionName: 'deck_proj_brain',
      }));
    });

    // Dispatch the preset list inside `act` so preact flushes the state update
    // before subsequent assertions. Without this wrapping `setCcPresets` is
    // batched past the next query, and the picker is never found.
    await act(async () => {
      for (const h of handlers) {
        h({
          type: 'cc.presets.list_response',
          presets: [
            { name: 'MiniMax', env: { ANTHROPIC_MODEL: 'MiniMax-M2.5' } },
            { name: 'Kimi', env: { ANTHROPIC_MODEL: 'kimi-k2.5' } },
          ],
        });
      }
    });

    // Defaults backend is already `qwen` via fetchSupervisorDefaults, so the
    // unified runtime selector must expose the third-party preset alongside
    // the built-in models.
    await waitFor(() => expect(screen.getByTestId('supervision-defaults-runtime-model-preset-selector')).toBeDefined());
    expect(screen.getByLabelText('supervision-defaults:preset')).toBeDefined();

    // Enable supervised mode and choose the global preset-pinned model.
    changeSupervisionMode('supervised');
    changeSelect(screen.getByLabelText('supervision-defaults:preset'), 'MiniMax');
    await waitFor(() => {
      expect((screen.getByLabelText('supervision-defaults:preset') as HTMLSelectElement).value).toBe('MiniMax');
      expect((screen.getByLabelText('supervision-defaults:model') as HTMLSelectElement).value).toBe('MiniMax-M2.5');
    });

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(saveSupervisorDefaultsMock).toHaveBeenCalledWith(expect.objectContaining({
        backend: 'qwen',
        model: 'MiniMax-M2.5',
        preset: 'MiniMax',
      }));
      expect(patchSessionMock).toHaveBeenCalledWith('srv-1', 'deck_proj_brain', expect.objectContaining({
        transportConfig: expect.objectContaining({
          supervision: expect.objectContaining({
            mode: 'supervised',
            backend: 'qwen',
            model: 'MiniMax-M2.5',
            preset: 'MiniMax',
          }),
        }),
      }));
    });
  });

  it('re-requests the owner preset catalogue when the initial shared socket send was dropped', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const handlers = new Set<(message: unknown) => void>();
    const wsStub = {
      connected: false,
      send(message: Record<string, unknown>) {
        if (this.connected) sent.push(message);
      },
      onMessage(handler: (message: unknown) => void) {
        handlers.add(handler);
        return () => { handlers.delete(handler); };
      },
    };
    fetchSupervisorDefaultsMock.mockResolvedValue({
      backend: 'claude-code-sdk',
      model: 'sonnet',
      timeoutMs: 50_000,
      promptVersion: 'supervision_decision_v1',
    });

    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="claude-code-sdk"
        transportConfig={null}
        ws={wsStub as unknown as import('../../src/ws-client.js').WsClient}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    await waitFor(() => expect(fetchSupervisorDefaultsMock).toHaveBeenCalled());
    expect(sent).toEqual([]);

    wsStub.connected = true;
    await act(async () => {
      for (const handler of handlers) handler({ type: 'daemon.reconnected' });
    });
    const request = sent.find((message) => message.type === 'cc.presets.list');
    expect(request).toEqual(expect.objectContaining({
      sessionName: 'deck_proj_brain',
      requestId: expect.any(String),
    }));

    await act(async () => {
      for (const handler of handlers) {
        handler({
          type: 'cc.presets.list_response',
          requestId: request?.requestId,
          sessionName: 'deck_proj_brain',
          presets: [{
            name: 'Owner MiniMax',
            env: {},
            defaultModel: 'MiniMax-M2.7',
            availableModels: [{ id: 'MiniMax-M2.7' }],
          }],
        });
      }
    });
    await waitFor(() => {
      const presetSelect = screen.getByLabelText('supervision-defaults:preset') as HTMLSelectElement;
      expect([...presetSelect.options].map((option) => option.value)).toContain('Owner MiniMax');
    });
  });

  it('syncs the global qwen preset model list and selects the preset default model', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const handlers = new Set<(message: unknown) => void>();
    const wsStub = {
      connected: true,
      send(message: Record<string, unknown>) { sent.push(message); },
      onMessage(handler: (message: unknown) => void) {
        handlers.add(handler);
        return () => { handlers.delete(handler); };
      },
    };

    fetchSupervisorDefaultsMock.mockResolvedValue({
      backend: 'qwen',
      model: 'qwen3-coder-plus',
      preset: 'MiniMax',
      timeoutMs: 12_000,
      promptVersion: 'supervision_decision_v1',
    });

    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="qwen"
        transportConfig={null}
        ws={wsStub as unknown as import('../../src/ws-client.js').WsClient}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(fetchSupervisorDefaultsMock).toHaveBeenCalled();
      expect(sent).toContainEqual(expect.objectContaining({
        type: 'cc.presets.list',
        requestId: expect.any(String),
        sessionName: 'deck_proj_brain',
      }));
    });

    await act(async () => {
      for (const h of handlers) {
        h({
          type: 'cc.presets.list_response',
          presets: [
            {
              name: 'MiniMax',
              env: {},
              defaultModel: 'MiniMax-M2.5',
              availableModels: [
                { id: 'MiniMax-M2.5' },
                { id: 'MiniMax-M2.7' },
              ],
            },
          ],
        });
      }
    });

    await waitFor(() => {
      expect((screen.getByLabelText('supervision-defaults:preset') as HTMLSelectElement).value).toBe('MiniMax');
    });
    const globalSelector = within(screen.getByTestId('supervision-defaults-runtime-model-preset-selector'));
    const modelSelect = globalSelector.getByLabelText('supervision-defaults:model') as HTMLSelectElement;
    expect(modelSelect.value).toBe('MiniMax-M2.5');
    expect(modelSelect.disabled).toBe(false);
    expect([...modelSelect.options].some((option) => option.value === 'MiniMax-M2.7')).toBe(true);
    expect([...modelSelect.options].some((option) => option.value === 'qwen3-coder-plus')).toBe(false);

    const modelRequest = await waitFor(() => {
      const request = sent.find((message) => (
        message.type === 'transport.list_models'
        && message.agentType === 'qwen'
        && message.ccPreset === 'MiniMax'
      ));
      expect(request).toBeDefined();
      return request!;
    });
    expect(modelRequest.sessionName).toBe('deck_proj_brain');
    await act(async () => {
      for (const handler of handlers) {
        handler({
          type: 'transport.models_response',
          requestId: modelRequest.requestId,
          agentType: 'qwen',
          ccPreset: 'MiniMax',
          models: [
            { id: 'MiniMax-M2.5' },
            { id: 'MiniMax-M2.7' },
            { id: 'MiniMax-M2.8' },
          ],
          defaultModel: 'MiniMax-M2.5',
        });
      }
    });
    await waitFor(() => {
      expect([...modelSelect.options].some((option) => option.value === 'MiniMax-M2.8')).toBe(true);
    });
    changeSelect(modelSelect, 'MiniMax-M2.8');
    expect((screen.getByLabelText('supervision-defaults:preset') as HTMLSelectElement).value).toBe('MiniMax');

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(saveSupervisorDefaultsMock).toHaveBeenCalledWith(expect.objectContaining({
        backend: 'qwen',
        model: 'MiniMax-M2.8',
        preset: 'MiniMax',
      }));
    });
  });

  it('persists customInstructionsOverride=true when user checks the override checkbox, and drops the global cache for that session', async () => {
    // Simulate a user who already has global custom instructions saved.
    fetchSupervisorDefaultsMock.mockResolvedValue({
      backend: 'codex-sdk',
      model: CODEX_MODEL_IDS[0],
      timeoutMs: 12_000,
      promptVersion: 'supervision_decision_v1',
      customInstructions: 'GLOBAL: always prefer tests',
    });

    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    // Wait for the async fetchSupervisorDefaults to resolve and the global
    // textarea to pre-populate. Both the "merged preview" gate and the
    // `globalCustomInstructions` cache-mirror field depend on this.
    await waitFor(() => {
      expect(fetchSupervisorDefaultsMock).toHaveBeenCalled();
    });

    // Turn on supervised mode and the session body must become editable.
    changeSupervisionMode('supervised');

    // Session-level custom instructions — different text so we can confirm
    // the session layer vs global layer are kept distinct in the payload.
    fireEvent.input(screen.getByPlaceholderText('customInstructionsPlaceholder'), {
      target: { value: 'SESSION: block commits on failing tests' },
    });

    // The override checkbox must be present and initially unchecked.
    const overrideCheckbox = screen.getByLabelText(/customInstructionsOverrideLabel/i) as HTMLInputElement;
    expect(overrideCheckbox.checked).toBe(false);

    // With override=false AND both layers non-empty, the merged preview is
    // shown — this proves the UI reads both layers.
    expect(screen.getByTestId('supervision-merged-preview')).toBeDefined();

    // Check override → session replaces global for this session.
    fireEvent.click(overrideCheckbox);
    expect(overrideCheckbox.checked).toBe(true);

    // Preview must hide when override is active (no ambiguity to preview).
    expect(screen.queryByTestId('supervision-merged-preview')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(patchSessionMock).toHaveBeenCalledWith('srv-1', 'deck_proj_brain', expect.objectContaining({
        transportConfig: expect.objectContaining({
          supervision: expect.objectContaining({
            mode: 'supervised',
            customInstructions: 'SESSION: block commits on failing tests',
            customInstructionsOverride: true,
            // Cache mirror of the current global value is still written to the
            // snapshot so the daemon can re-read it next time override flips
            // back to false without needing another defaults fetch.
            globalCustomInstructions: 'GLOBAL: always prefer tests',
          }),
        }),
      }));
    });

    // User did not edit the global region → defaults endpoint must not be
    // hit. This proves the save-split handles override-only changes cleanly.
    expect(saveSupervisorDefaultsMock).not.toHaveBeenCalled();
  });

  it('persists custom supervision instructions in the session snapshot', async () => {
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    changeSupervisionMode('supervised');
    fireEvent.input(screen.getByPlaceholderText('customInstructionsPlaceholder'), {
      target: { value: 'Always require tests and clean verification before complete.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(patchSessionMock).toHaveBeenCalledWith('srv-1', 'deck_proj_brain', expect.objectContaining({
        transportConfig: expect.objectContaining({
          supervision: expect.objectContaining({
            mode: 'supervised',
            customInstructions: 'Always require tests and clean verification before complete.',
          }),
        }),
      }));
    });
  });

  it('shows supervision intro copy for supported transport sessions when expanded', () => {
    // The intro card is collapsed by default to save dialog real estate.
    // Expanding it via the toggle reveals the three detail sections.
    // Previous render may have persisted a collapsed preference in localStorage —
    // clear it so this test starts in a deterministic (default collapsed) state.
    try { window.localStorage.removeItem('imcodes:supervision-intro-collapsed'); } catch { /* noop */ }

    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    // Collapsed by default: detail bodies are hidden until expanded.
    expect(screen.queryByText('howToUseTitle')).toBeNull();

    // The two region titles (global defaults / session config) stay visible.
    expect(screen.getByText('globalDefaultsTitle')).toBeDefined();
    expect(screen.getByText('sessionConfigTitle')).toBeDefined();

    // Clicking the toggle expands the intro card and exposes the three sections.
    fireEvent.click(screen.getByTestId('supervision-intro-toggle'));
    expect(screen.getByText('howToUseTitle')).toBeDefined();
    expect(screen.getByText('purposeTitle')).toBeDefined();
    expect(screen.getByText('howItWorksTitle')).toBeDefined();
  });

  it('persists intro collapse state in localStorage', () => {
    try { window.localStorage.removeItem('imcodes:supervision-intro-collapsed'); } catch { /* noop */ }

    const { unmount } = render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    // Expand the card; the pref should flip to "0" (not collapsed).
    fireEvent.click(screen.getByTestId('supervision-intro-toggle'));
    expect(window.localStorage.getItem('imcodes:supervision-intro-collapsed')).toBe('0');
    unmount();

    // Remount: state is read from localStorage so the detail body is visible immediately.
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByText('howToUseTitle')).toBeDefined();
  });

  it('shows unsupported copy for process sessions', () => {
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex"
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByText('unsupported')).toBeDefined();
  });

  it('shows an invalid stored config warning when the persisted supervision snapshot is corrupt', () => {
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        transportConfig={{
          supervision: {
            mode: 'supervised',
            backend: 'bad-backend',
            model: '',
            timeoutMs: 0,
            promptVersion: '',
            maxParseRetries: 0,
          },
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByText('invalidStoredConfig')).toBeDefined();
  });

  it('submits sub-session supervision updates through patchSubSession', async () => {
    const onSaved = vi.fn();
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_sub_abcd1234"
        subSessionId="abcd1234"
        label="Worker"
        description=""
        cwd="/proj"
        type="codex-sdk"
        parentSession="deck_proj_brain"
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );

    changeSupervisionMode('supervised');
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(patchSubSessionMock).toHaveBeenCalledWith('srv-1', 'abcd1234', expect.objectContaining({
        transportConfig: expect.objectContaining({
          supervision: expect.objectContaining({
            mode: 'supervised',
          }),
        }),
      }));
    });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({
      transportConfig: expect.objectContaining({
        supervision: expect.objectContaining({
          mode: 'supervised',
        }),
      }),
    }));
  });

  it('saves global supervisor defaults without patching the session when only defaults changed', async () => {
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    changeRuntimeBackend('supervision-defaults', 'claude-code-sdk');
    await waitFor(() => {
      expect((screen.getByLabelText('supervision-defaults:model') as HTMLSelectElement).value).toBe('sonnet');
    });
    selectRuntimeModel('supervision-defaults', CLAUDE_CODE_MODEL_IDS[0]);
    await waitFor(() => {
      expect((screen.getByLabelText('supervision-defaults:model') as HTMLSelectElement).value).toBe(CLAUDE_CODE_MODEL_IDS[0]);
    });
    const timeoutInput = screen.getByLabelText('supervision-defaults:timeout');
    expect(timeoutInput.getAttribute('min')).toBe('30');
    fireEvent.input(timeoutInput, { target: { value: '5' } });
    expect((screen.getByLabelText('supervision-defaults:timeout') as HTMLInputElement).value).toBe('30');
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(saveSupervisorDefaultsMock).toHaveBeenCalledWith(expect.objectContaining({
        backend: 'claude-code-sdk',
        model: CLAUDE_CODE_MODEL_IDS[0],
        timeoutMs: 30_000,
      }));
    });
    expect(patchSessionMock).not.toHaveBeenCalled();
    expect(patchSubSessionMock).not.toHaveBeenCalled();
  });

  it('persists an optional global backup runtime from the shared dropdown selector', async () => {
    render(
      <SessionSettingsDialog
        canControlAutomaticSupervision
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="codex-sdk"
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    changeRuntimeBackend('supervision-defaults-backup', 'qwen');
    await waitFor(() => {
      expect((screen.getByLabelText('supervision-defaults-backup:model') as HTMLSelectElement).value)
        .toBe('qwen3-coder-plus');
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(saveSupervisorDefaultsMock).toHaveBeenCalledWith(expect.objectContaining({
        backupBackend: 'qwen',
        backupModel: 'qwen3-coder-plus',
      }));
    });
    expect(patchSessionMock).not.toHaveBeenCalled();
  });
});
