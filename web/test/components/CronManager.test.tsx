/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import type { SessionInfo } from '../../src/types.js';

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../src/api.js', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('../../src/components/FloatingPanel.js', () => ({
  FloatingPanel: ({ title, children, onClose }: { title: string; children: unknown; onClose: () => void }) => (
    <div data-testid="floating-panel">
      <div>{title}</div>
      <button type="button" onClick={onClose}>close-panel</button>
      {children}
    </div>
  ),
}));

vi.mock('../../src/components/ChatMarkdown.js', () => ({
  ChatMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('../../src/hooks/useResourceEvent.js', () => ({
  useResourceEvent: vi.fn(),
}));

import { CronManager } from '../../src/pages/CronManager.js';

function makeJob(overrides: Partial<{
  id: string;
  server_id: string;
  project_name: string;
  name: string;
  cron_expr: string;
  target_role: string;
  target_session_name: string | null;
  action: string;
  status: string;
}> = {}) {
  return {
    id: overrides.id ?? 'job-1',
    server_id: overrides.server_id ?? 'srv-1',
    user_id: 'owner-1',
    name: overrides.name ?? 'Job 1',
    cron_expr: overrides.cron_expr ?? '*/15 * * * *',
    project_name: overrides.project_name ?? 'proj_a',
    target_role: overrides.target_role ?? 'brain',
    target_session_name: overrides.target_session_name ?? null,
    action: overrides.action ?? JSON.stringify({ type: 'command', command: 'echo hi' }),
    status: overrides.status ?? 'active',
    last_run_at: null,
    next_run_at: null,
    expires_at: null,
    completion_policy: 'recurring',
    created_at: 1_700_000_000_000,
  };
}

const sessions: SessionInfo[] = [
  { name: 'deck_proj_a_brain', project: 'proj_a', role: 'brain', agentType: 'claude-code-sdk', state: 'idle' },
  { name: 'deck_proj_b_brain', project: 'proj_b', role: 'brain', agentType: 'codex-sdk', state: 'idle' },
];

const subSessions = [
  { sessionName: 'deck_sub_a1', type: 'claude-code-sdk', state: 'idle', label: 'Sub A1', parentSession: 'deck_proj_a_brain' },
  { sessionName: 'deck_sub_b1', type: 'codex-sdk', state: 'idle', label: 'Sub B1', parentSession: 'deck_proj_b_brain' },
];

describe('CronManager shared scope permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('allows whole-server share participants to manage jobs across all projects under the shared server and scopes CronForm sessions to editingJob.project_name', async () => {
    const jobs = [
      makeJob({ id: 'job-a', server_id: 'srv-1', project_name: 'proj_a', name: 'Job Proj A', status: 'active' }),
      makeJob({ id: 'job-b', server_id: 'srv-1', project_name: 'proj_b', name: 'Job Proj B', status: 'paused', target_session_name: 'deck_sub_b1' }),
    ];

    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/cron?')) return { jobs };
      if (url.includes('/status') || url.includes('/trigger') || url.startsWith('/api/cron/')) return { ok: true };
      return {};
    });

    const { container } = render(
      <CronManager
        serverId="srv-1"
        projectName="proj_a"
        sessions={sessions}
        subSessions={subSessions}
        servers={[{ id: 'srv-1', name: 'Shared Box' }]}
        sharedScope={true}
        readOnly={false}
        onBack={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Job Proj A')).toBeDefined();
      expect(screen.getByText('Job Proj B')).toBeDefined();
    });

    expect(apiFetchMock).toHaveBeenCalledWith('/api/cron?serverId=srv-1');
    expect(screen.queryByText('cron.read_only')).toBeNull();
    expect(screen.queryByText('cron.read_only_scope')).toBeNull();

    // Project badges appear on cards in wholeServerSharedScope
    expect(screen.getByText('proj_a')).toBeDefined();
    expect(screen.getByText('proj_b')).toBeDefined();

    // All action buttons on Job Proj B (another project on the same shared server) are enabled
    const jobBCard = screen.getByText('Job Proj B').closest('article')!;
    const resumeBtn = within(jobBCard).getByRole('button', { name: 'cron.resume' }) as HTMLButtonElement;
    const triggerBtn = within(jobBCard).getByRole('button', { name: 'cron.run_now' }) as HTMLButtonElement;
    const editBtn = within(jobBCard).getByRole('button', { name: 'cron.edit' }) as HTMLButtonElement;
    const deleteBtn = within(jobBCard).getByRole('button', { name: 'cron.delete_task' }) as HTMLButtonElement;

    expect(resumeBtn.disabled).toBe(false);
    expect(triggerBtn.disabled).toBe(false);
    expect(editBtn.disabled).toBe(false);
    expect(deleteBtn.disabled).toBe(false);

    fireEvent.click(resumeBtn);
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/cron/job-b/status', expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ status: 'active' }),
      }));
    });

    fireEvent.click(triggerBtn);
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/cron/job-b/trigger', expect.objectContaining({
        method: 'POST',
      }));
    });

    // Editing Job Proj B opens CronForm with proj_b's sessions/sub-sessions (not proj_a's)
    fireEvent.click(editBtn);
    const panel = await screen.findByTestId('floating-panel');
    const subB1Option = panel.querySelector('option[value="sub:deck_sub_b1"]');
    expect(subB1Option).not.toBeNull();
    expect(subB1Option?.textContent).toContain('Sub B1');
    expect(panel.querySelector('option[value="sub:deck_sub_a1"]')).toBeNull();
    expect(panel.textContent).not.toContain('deck_proj_a_brain');

    fireEvent.click(within(panel).getByRole('button', { name: 'close-panel' }));

    fireEvent.click(deleteBtn);
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/cron/job-b', expect.objectContaining({
        method: 'DELETE',
      }));
    });
    expect(container.querySelector('button[title="cron.create"]')).not.toBeNull();
  });

  it('keeps viewer readOnly jobs and cross-server jobs read-only while letting owner edit same-server other-project jobs', async () => {
    const jobs = [
      makeJob({ id: 'job-same-other-proj', server_id: 'srv-1', project_name: 'proj_b', name: 'Same Server Other Proj', status: 'active' }),
      makeJob({ id: 'job-cross-server', server_id: 'srv-2', project_name: 'proj_remote', name: 'Cross Server Job', status: 'active' }),
    ];
    apiFetchMock.mockResolvedValue({ jobs });

    // 1) Viewer (readOnly=true) on wholeServerSharedScope -> everything disabled and no create button
    const viewerRender = render(
      <CronManager
        serverId="srv-1"
        projectName="proj_a"
        sessions={sessions}
        subSessions={subSessions}
        servers={[{ id: 'srv-1', name: 'Shared Box' }]}
        sharedScope={true}
        readOnly={true}
        onBack={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Same Server Other Proj')).toBeDefined();
    });
    expect(viewerRender.container.querySelector('button[title="cron.create"]')).toBeNull();
    const viewerCard = screen.getByText('Same Server Other Proj').closest('article')!;
    expect((within(viewerCard).getByRole('button', { name: 'cron.pause' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(viewerCard).getByRole('button', { name: 'cron.run_now' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(viewerCard).getByRole('button', { name: 'cron.edit' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(viewerCard).getByRole('button', { name: 'cron.delete_task' }) as HTMLButtonElement).disabled).toBe(true);

    viewerRender.unmount();

    // 2) Server owner with showAllServers -> same-server other project editable, cross-server read-only
    render(
      <CronManager
        serverId="srv-1"
        projectName="proj_a"
        sessions={sessions}
        subSessions={subSessions}
        servers={[{ id: 'srv-1', name: 'Main Box' }, { id: 'srv-2', name: 'Remote Box' }]}
        sharedScope={false}
        readOnly={false}
        onBack={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox'));

    await waitFor(() => {
      expect(screen.getByText('Same Server Other Proj')).toBeDefined();
      expect(screen.getByText('Cross Server Job')).toBeDefined();
    });

    const sameServerCard = screen.getByText('Same Server Other Proj').closest('article')!;
    expect((within(sameServerCard).getByRole('button', { name: 'cron.pause' }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(sameServerCard).getByRole('button', { name: 'cron.edit' }) as HTMLButtonElement).disabled).toBe(false);

    const crossServerCard = screen.getByText('Cross Server Job').closest('article')!;
    expect(within(crossServerCard).getByText('cron.read_only')).toBeDefined();
    expect((within(crossServerCard).getByRole('button', { name: 'cron.pause' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(crossServerCard).getByRole('button', { name: 'cron.run_now' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(crossServerCard).getByRole('button', { name: 'cron.edit' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(crossServerCard).getByRole('button', { name: 'cron.delete_task' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
