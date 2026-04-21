/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/preact';
import { CLAUDE_CODE_MODEL_IDS, CODEX_MODEL_IDS } from '../../../src/shared/models/options.js';

const patchSessionMock = vi.fn();
const patchSubSessionMock = vi.fn();
const fetchSupervisorDefaultsMock = vi.fn();
const saveSupervisorDefaultsMock = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const parts = key.split('.');
      const leaf = parts[parts.length - 1];
      if (params?.value && typeof params.value === 'string') return `${leaf}:${params.value}`;
      if (params?.backend && params?.model) return `${leaf}:${params.backend}:${params.model}`;
      if (params?.auditMode && params?.loops != null) return `${leaf}:${params.auditMode}:${params.loops}`;
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
  saveSupervisorDefaults: (...args: unknown[]) => saveSupervisorDefaultsMock(...args),
}));

import { SessionSettingsDialog } from '../../src/components/SessionSettingsDialog.js';

function inputForLabel(label: string, index = 0): HTMLInputElement {
  const labels = screen.getAllByText(label);
  const container = labels[index]?.parentElement;
  const input = container?.querySelector('input');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Missing input for label ${label} at index ${index}`);
  }
  return input;
}

describe('SessionSettingsDialog supervision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSupervisorDefaultsMock.mockRejectedValue(new Error('no defaults'));
    saveSupervisorDefaultsMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it('requires backend and model selection before enabling supervised mode', async () => {
    const onSaved = vi.fn();
    render(
      <SessionSettingsDialog
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

    fireEvent.change(screen.getAllByRole('combobox')[3]!, { target: { value: 'supervised' } });
    expect(screen.getAllByText('backend').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('model').length).toBeGreaterThanOrEqual(2);
    expect((screen.getByRole('button', { name: /save/i }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getAllByRole('combobox')[4]!, { target: { value: 'codex-sdk' } });
    fireEvent.change(screen.getAllByRole('combobox')[5]!, { target: { value: CODEX_MODEL_IDS[0] } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(patchSessionMock).toHaveBeenCalledWith('srv-1', 'deck_proj_brain', expect.objectContaining({
        transportConfig: expect.objectContaining({
          supervision: expect.objectContaining({
            mode: 'supervised',
            backend: 'codex-sdk',
            model: CODEX_MODEL_IDS[0],
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

  it('shows audit mode selection and persists the audit config', async () => {
    fetchSupervisorDefaultsMock.mockResolvedValue({
      backend: 'claude-code-sdk',
      model: CLAUDE_CODE_MODEL_IDS[0],
      timeoutMs: 12_000,
      promptVersion: 'supervision_decision_v1',
    });
    render(
      <SessionSettingsDialog
        serverId="srv-1"
        sessionName="deck_proj_brain"
        label="Brain"
        description="desc"
        cwd="/proj"
        type="claude-code-sdk"
        transportConfig={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.change(screen.getAllByRole('combobox')[3]!, { target: { value: 'supervised_audit' } });
    expect(screen.getByText('auditModeLabel')).toBeDefined();
    expect(screen.getByText('maxAuditLoops')).toBeDefined();

    fireEvent.change(screen.getAllByRole('combobox')[4]!, { target: { value: 'claude-code-sdk' } });
    fireEvent.change(screen.getAllByRole('combobox')[5]!, { target: { value: CLAUDE_CODE_MODEL_IDS[0] } });
    fireEvent.change(screen.getAllByRole('combobox')[6]!, { target: { value: 'audit>plan' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(patchSessionMock).toHaveBeenCalledWith('srv-1', 'deck_proj_brain', expect.objectContaining({
        transportConfig: expect.objectContaining({
          supervision: expect.objectContaining({
            mode: 'supervised_audit',
            auditMode: 'audit>plan',
          }),
        }),
      }));
    });
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

    fireEvent.change(screen.getAllByRole('combobox')[3]!, { target: { value: 'supervised' } });
    expect(screen.getAllByDisplayValue('18').length).toBeGreaterThanOrEqual(2);
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
            timeoutMs: 18_000,
          }),
        }),
      }));
    });
  });

  it('renders persisted supervision snapshot in the summary', () => {
    render(
      <SessionSettingsDialog
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
            auditMode: 'review>plan',
            maxAuditLoops: 3,
            taskRunPromptVersion: 'task_run_status_v1',
          },
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByText('summaryMode:supervised_audit')).toBeDefined();
    expect(screen.getByText(`summaryBackendModel:codex_sdk:${CODEX_MODEL_IDS[0]}`)).toBeDefined();
    expect(screen.getByText('summaryTimeout:9 s')).toBeDefined();
    expect(screen.getByText('summaryContinueLimits:2:8')).toBeDefined();
    expect(screen.getByText('summaryCustomInstructions:summaryCustomInstructionsSet')).toBeDefined();
    expect(screen.getByText('summaryAudit:review_plan:3')).toBeDefined();
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
      expect(fetchSupervisorDefaultsMock).toHaveBeenCalled();
    });

    fireEvent.input(inputForLabel('maxAutoContinueStreak', 0), { target: { value: '5' } });
    fireEvent.input(inputForLabel('maxAutoContinueTotal', 0), { target: { value: '11' } });
    fireEvent.change(screen.getAllByRole('combobox')[3]!, { target: { value: 'supervised' } });
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

  it('persists qwen preset selection via the preset picker when ws fetches presets', async () => {
    // Stub ws that records sent messages and lets the test dispatch a preset list.
    // Pattern (Set of handlers + `act`-wrapped dispatch) mirrors the existing
    // SharedContextManagementPanel test, which the supervision picker reuses.
    const sent: Array<Record<string, unknown>> = [];
    const handlers = new Set<(message: unknown) => void>();
    const wsStub = {
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
      expect(sent.some((m) => m.type === 'cc.presets.list')).toBe(true);
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

    // Defaults backend is already `qwen` via fetchSupervisorDefaults → the
    // Global-defaults preset picker should render now that ccPresets is non-empty.
    await waitFor(() => expect(screen.getAllByTestId('supervision-preset-picker').length).toBeGreaterThan(0));

    // Enable supervised mode on this qwen session and pick a preset-pinned model.
    fireEvent.change(screen.getAllByRole('combobox')[3]!, { target: { value: 'supervised' } });
    fireEvent.change(screen.getAllByRole('combobox')[4]!, { target: { value: 'qwen' } });
    fireEvent.change(screen.getAllByRole('combobox')[5]!, { target: { value: 'MiniMax-M2.5' } });

    // Both regions now render a preset picker (Global defaults + This session).
    await waitFor(() => expect(screen.getAllByTestId('supervision-preset-picker').length).toBe(2));

    // Click the session-region MiniMax chip. Buttons render in the same order
    // the pickers render (defaults first, session second) so [1] is session.
    const minimaxButtons = screen.getAllByRole('button', { name: 'MiniMax' });
    expect(minimaxButtons.length).toBe(2);
    fireEvent.click(minimaxButtons[1]!);

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
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
    fireEvent.change(screen.getAllByRole('combobox')[3]!, { target: { value: 'supervised' } });
    fireEvent.change(screen.getAllByRole('combobox')[4]!, { target: { value: 'codex-sdk' } });
    fireEvent.change(screen.getAllByRole('combobox')[5]!, { target: { value: CODEX_MODEL_IDS[0] } });

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

    fireEvent.change(screen.getAllByRole('combobox')[3]!, { target: { value: 'supervised' } });
    fireEvent.change(screen.getAllByRole('combobox')[4]!, { target: { value: 'codex-sdk' } });
    fireEvent.change(screen.getAllByRole('combobox')[5]!, { target: { value: CODEX_MODEL_IDS[0] } });
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

    fireEvent.change(screen.getAllByRole('combobox')[3]!, { target: { value: 'supervised' } });
    fireEvent.change(screen.getAllByRole('combobox')[4]!, { target: { value: 'codex-sdk' } });
    fireEvent.change(screen.getAllByRole('combobox')[5]!, { target: { value: CODEX_MODEL_IDS[0] } });
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

    fireEvent.change(screen.getAllByRole('combobox')[1]!, { target: { value: 'claude-code-sdk' } });
    fireEvent.change(screen.getAllByRole('combobox')[2]!, { target: { value: CLAUDE_CODE_MODEL_IDS[0] } });
    fireEvent.input(screen.getByDisplayValue('12'), { target: { value: '30' } });
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
});
