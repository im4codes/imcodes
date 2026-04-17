/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/preact';
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

    fireEvent.change(screen.getAllByRole('combobox')[1]!, { target: { value: 'supervised' } });
    expect(screen.getByText('backend')).toBeDefined();
    expect(screen.getByText('model')).toBeDefined();
    expect((screen.getByRole('button', { name: /save/i }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getAllByRole('combobox')[2]!, { target: { value: 'codex-sdk' } });
    fireEvent.change(screen.getAllByRole('combobox')[3]!, { target: { value: CODEX_MODEL_IDS[0] } });
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
    expect(saveSupervisorDefaultsMock).toHaveBeenCalledWith(expect.objectContaining({
      backend: 'codex-sdk',
      model: CODEX_MODEL_IDS[0],
    }));
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

    fireEvent.change(screen.getAllByRole('combobox')[1]!, { target: { value: 'supervised_audit' } });
    expect(screen.getByText('auditModeLabel')).toBeDefined();
    expect(screen.getByText('maxAuditLoops')).toBeDefined();

    fireEvent.change(screen.getAllByRole('combobox')[2]!, { target: { value: 'claude-code-sdk' } });
    fireEvent.change(screen.getAllByRole('combobox')[3]!, { target: { value: CLAUDE_CODE_MODEL_IDS[0] } });
    fireEvent.change(screen.getAllByRole('combobox')[4]!, { target: { value: 'audit>plan' } });
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

    fireEvent.change(screen.getAllByRole('combobox')[1]!, { target: { value: 'supervised' } });
    expect(screen.getByDisplayValue('18')).toBeDefined();
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
            maxParseRetries: 1,
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
    expect(screen.getByText('summaryAudit:review_plan:3')).toBeDefined();
    expect(screen.getByText('summaryMeta:supervision_decision_v1')).toBeDefined();
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

    fireEvent.change(screen.getAllByRole('combobox')[1]!, { target: { value: 'supervised' } });
    fireEvent.change(screen.getAllByRole('combobox')[2]!, { target: { value: 'codex-sdk' } });
    fireEvent.change(screen.getAllByRole('combobox')[3]!, { target: { value: CODEX_MODEL_IDS[0] } });
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
});
