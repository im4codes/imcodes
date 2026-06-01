/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CronManager } from '../src/pages/CronManager.js';
import type { SessionInfo } from '../src/types.js';

const apiFetch = vi.fn();

vi.mock('../src/api.js', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../src/components/FloatingPanel.js', () => ({
  FloatingPanel: ({ children }: { children: any }) => <div>{children}</div>,
}));

const sessions: SessionInfo[] = [
  { name: 'deck_cd_brain', project: 'cd', role: 'brain', agentType: 'claude-code', state: 'idle' },
  { name: 'deck_other_brain', project: 'other', role: 'brain', agentType: 'claude-code', state: 'idle' },
];

const subSessions = [
  { sessionName: 'deck_sub_52123h2r', type: 'codex', label: 'dance', state: 'idle', parentSession: 'deck_cd_brain' },
  { sessionName: 'deck_sub_audit', type: 'claude-code-sdk', label: 'audit', state: 'idle', parentSession: 'deck_cd_brain' },
];

function cronJob(overrides: Partial<any> = {}) {
  return {
    id: 'job-1',
    server_id: 'srv-current',
    name: 'Current job',
    cron_expr: '0 9 * * *',
    project_name: 'cd',
    target_role: 'brain',
    target_session_name: null,
    action: JSON.stringify({ type: 'command', command: 'hello' }),
    status: 'active',
    last_run_at: null,
    next_run_at: Date.now() + 60_000,
    expires_at: null,
    created_at: Date.now(),
    ...overrides,
  };
}

describe('CronManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const store: Record<string, string> = {};
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
        clear: () => { for (const k of Object.keys(store)) delete store[k]; },
        key: (i: number) => Object.keys(store)[i] ?? null,
        get length() { return Object.keys(store).length; },
      },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders other-server jobs as read-only', async () => {
    apiFetch.mockResolvedValueOnce({
      jobs: [{
        id: 'job-1',
        server_id: 'srv-other',
        name: 'Other server job',
        cron_expr: '0 9 * * *',
        project_name: 'cd',
        target_role: 'brain',
        target_session_name: null,
        action: JSON.stringify({ type: 'command', command: 'hello' }),
        status: 'active',
        last_run_at: null,
        next_run_at: null,
        expires_at: null,
        created_at: Date.now(),
      }],
    });

    render(
      <CronManager
        serverId="srv-current"
        projectName="cd"
        sessions={sessions}
        subSessions={subSessions}
        onBack={vi.fn()}
        servers={[{ id: 'srv-current', name: 'Current' }, { id: 'srv-other', name: 'Other' }]}
      />,
    );

    expect(await screen.findByText('Other server job')).toBeDefined();
    expect(screen.getByText('cron.read_only')).toBeDefined();
    expect(screen.getByText('cron.read_only_scope')).toBeDefined();

    const triggerBtn = screen.getByText('▶') as HTMLButtonElement;
    const editBtn = screen.getByText('✎') as HTMLButtonElement;
    const deleteBtn = screen.getByText('✕') as HTMLButtonElement;
    expect(triggerBtn.disabled).toBe(true);
    expect(editBtn.disabled).toBe(true);
    expect(deleteBtn.disabled).toBe(true);
  });

  it('renders other-tab jobs as read-only', async () => {
    apiFetch.mockResolvedValueOnce({
      jobs: [{
        id: 'job-2',
        server_id: 'srv-current',
        name: 'Other tab job',
        cron_expr: '0 9 * * *',
        project_name: 'other',
        target_role: 'brain',
        target_session_name: null,
        action: JSON.stringify({ type: 'command', command: 'hello' }),
        status: 'active',
        last_run_at: null,
        next_run_at: null,
        expires_at: null,
        created_at: Date.now(),
      }],
    });

    render(
      <CronManager
        serverId="srv-current"
        projectName="cd"
        sessions={sessions}
        subSessions={subSessions}
        onBack={vi.fn()}
        servers={[{ id: 'srv-current', name: 'Current' }]}
      />,
    );

    expect(await screen.findByText('Other tab job')).toBeDefined();
    expect(screen.getByText('cron.read_only')).toBeDefined();
    expect((screen.getByText('✎') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps same-context jobs editable', async () => {
    apiFetch.mockResolvedValueOnce({
      jobs: [{
        id: 'job-3',
        server_id: 'srv-current',
        name: 'Current job',
        cron_expr: '0 9 * * *',
        project_name: 'cd',
        target_role: 'brain',
        target_session_name: null,
        action: JSON.stringify({ type: 'command', command: 'hello' }),
        status: 'active',
        last_run_at: null,
        next_run_at: null,
        expires_at: null,
        created_at: Date.now(),
      }],
    });

    render(
      <CronManager
        serverId="srv-current"
        projectName="cd"
        sessions={sessions}
        subSessions={subSessions}
        onBack={vi.fn()}
        servers={[{ id: 'srv-current', name: 'Current' }]}
      />,
    );

    expect(await screen.findByText('Current job')).toBeDefined();
    expect(screen.queryByText('cron.read_only')).toBeNull();
    expect((screen.getByText('✎') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows persisted expiration timestamps in the browser local timezone when editing', async () => {
    const previousTz = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    try {
      apiFetch.mockResolvedValueOnce({
        jobs: [cronJob({
          id: 'expiring-job',
          name: 'Expiring job',
          expires_at: Date.UTC(2026, 5, 1, 2, 47, 30),
        })],
      });

      const { container } = render(
        <CronManager
          serverId="srv-current"
          projectName="cd"
          sessions={sessions}
          subSessions={subSessions}
          onBack={vi.fn()}
          servers={[{ id: 'srv-current', name: 'Current' }]}
        />,
      );

      expect(await screen.findByText('Expiring job')).toBeDefined();
      fireEvent.click(screen.getByText('✎'));

      const expiresInput = container.querySelector('input[type="datetime-local"]') as HTMLInputElement;
      expect(expiresInput.value).toBe('2026-06-01T10:47');
    } finally {
      if (previousTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previousTz;
      }
    }
  });

  it('blocks saving inline cron commands longer than 1500 chars and shows a file-reference hint', async () => {
    apiFetch.mockResolvedValueOnce({ jobs: [] });

    render(
      <CronManager
        serverId="srv-current"
        projectName="cd"
        sessions={sessions}
        subSessions={subSessions}
        onBack={vi.fn()}
        servers={[{ id: 'srv-current', name: 'Current' }]}
      />,
    );

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/api/cron?serverId=srv-current&projectName=cd');
    });

    fireEvent.click(screen.getByTitle('cron.create'));

    const nameInput = screen.getByPlaceholderText('cron.name_placeholder') as HTMLInputElement;
    fireEvent.input(nameInput, { target: { value: 'Long prompt job' } });

    const cronExprInput = screen.getByPlaceholderText('0 9 * * 1-5') as HTMLInputElement;
    fireEvent.input(cronExprInput, { target: { value: '0 9 * * *' } });

    const textarea = screen.getByPlaceholderText('cron.command_placeholder') as HTMLTextAreaElement;
    const longCommand = '早上好主人！'.repeat(260);
    fireEvent.input(textarea, { target: { value: longCommand } });

    expect(screen.getByText('1560/1500 · Too long for inline entry. Write it to a file and reference it with @/path/to/file.')).toBeDefined();

    fireEvent.click(screen.getByText('cron.save'));

    expect(screen.getByText('Command is too long (1560/1500). Write the prompt to a file and reference it directly with @/path/to/file.')).toBeDefined();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('pauses, resumes, triggers, deletes, and reloads current-context jobs', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const activeJob = cronJob({ id: 'active-job', name: 'Active job', status: 'active' });
    const pausedJob = cronJob({ id: 'paused-job', name: 'Paused job', status: 'paused' });
    apiFetch
      .mockResolvedValueOnce({ jobs: [activeJob, pausedJob] })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ jobs: [activeJob, pausedJob] })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ jobs: [activeJob, pausedJob] })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ jobs: [activeJob, pausedJob] })
      .mockResolvedValueOnce({ ok: true });

    render(
      <CronManager
        serverId="srv-current"
        projectName="cd"
        sessions={sessions}
        subSessions={subSessions}
        onBack={vi.fn()}
        servers={[{ id: 'srv-current', name: 'Current' }]}
      />,
    );

    expect(await screen.findByText('Active job')).toBeDefined();

    fireEvent.click(screen.getByText('cron.pause'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/cron/active-job/status', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ status: 'paused' }),
    })));

    fireEvent.click(screen.getByText('cron.resume'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/cron/paused-job/status', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ status: 'active' }),
    })));

    fireEvent.click(screen.getAllByText('▶')[0]);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/cron/active-job/trigger', expect.objectContaining({ method: 'POST' })));

    fireEvent.click(screen.getAllByText('✕')[0]);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/cron/active-job', expect.objectContaining({ method: 'DELETE' })));
  });

  it('creates p2p jobs with sub-session targets and session participant entries', async () => {
    apiFetch
      .mockResolvedValueOnce({ jobs: [] })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ jobs: [] });
    const { container } = render(
      <CronManager
        serverId="srv-current"
        projectName="cd"
        sessions={sessions}
        subSessions={subSessions}
        onBack={vi.fn()}
        servers={[{ id: 'srv-current', name: 'Current' }]}
      />,
    );

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/cron?serverId=srv-current&projectName=cd'));
    fireEvent.click(screen.getByTitle('cron.create'));

    fireEvent.input(screen.getByPlaceholderText('cron.name_placeholder'), { target: { value: 'Daily audit' } });
    fireEvent.input(screen.getByPlaceholderText('0 9 * * 1-5'), { target: { value: '0 10 * * 1-5' } });

    const targetSelect = Array.from(container.querySelectorAll('select')).find((select) =>
      Array.from(select.options).some((option) => option.value === 'sub:deck_sub_52123h2r'),
    ) as HTMLSelectElement;
    targetSelect.value = 'sub:deck_sub_52123h2r';
    fireEvent.input(targetSelect);
    fireEvent.change(targetSelect);
    expect(targetSelect.value).toBe('sub:deck_sub_52123h2r');
    fireEvent.click(screen.getByLabelText('cron.action_p2p'));
    fireEvent.input(screen.getByPlaceholderText('cron.p2p_topic_placeholder'), { target: { value: 'Review risky changes' } });

    const participantBoxes = container.querySelectorAll('form input[type="checkbox"]');
    fireEvent.click(participantBoxes[1]);

    const numberInput = container.querySelector('input[type="number"]') as HTMLInputElement;
    fireEvent.input(numberInput, { target: { value: '3' } });

    fireEvent.click(screen.getByText('cron.save'));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/cron', expect.objectContaining({ method: 'POST' })));
    const createCall = apiFetch.mock.calls.find(([url]) => url === '/api/cron');
    const payload = JSON.parse(String(createCall?.[1]?.body));
    expect(payload).toMatchObject({
      name: 'Daily audit',
      cronExpr: '0 10 * * 1-5',
      serverId: 'srv-current',
      projectName: 'cd',
      targetRole: 'brain',
      action: {
        type: 'p2p',
        topic: 'Review risky changes',
        rounds: 3,
        participantEntries: [{ type: 'session', value: 'deck_sub_audit' }],
      },
    });
    expect(typeof payload.timezone).toBe('string');
  });

  it('edits jobs, toggles schedule modes, and maps cron validation errors', async () => {
    apiFetch
      .mockResolvedValueOnce({ jobs: [cronJob({
        id: 'edit-job',
        name: 'Editable p2p',
        cron_expr: '0 9 * * 1-5',
        action: JSON.stringify({ type: 'p2p', topic: 'Old topic', mode: 'review', rounds: 2, participants: ['brain'] }),
      })] })
      .mockRejectedValueOnce(new Error('invalid_cron_expression'));

    render(
      <CronManager
        serverId="srv-current"
        projectName="cd"
        sessions={sessions}
        subSessions={subSessions}
        onBack={vi.fn()}
        servers={[{ id: 'srv-current', name: 'Current' }]}
      />,
    );

    expect(await screen.findByText('Editable p2p')).toBeDefined();
    fireEvent.click(screen.getByText('✎'));

    fireEvent.click(screen.getByText('cron.mode_advanced'));
    fireEvent.input(screen.getByPlaceholderText('0 9 * * 1-5'), { target: { value: 'bad cron' } });
    fireEvent.click(screen.getByLabelText('cron.action_command'));
    fireEvent.input(screen.getByPlaceholderText('cron.command_placeholder'), { target: { value: 'new command' } });
    fireEvent.click(screen.getByText('cron.save'));

    await waitFor(() => expect(screen.getByText('cron.invalid_cron')).toBeDefined());
    expect(apiFetch).toHaveBeenCalledWith('/api/cron/edit-job', expect.objectContaining({
      method: 'PUT',
      body: expect.stringContaining('"command":"new command"'),
    }));
  });

  it('opens job history, execution details, p2p discussions, and session navigation links', async () => {
    const onViewDiscussion = vi.fn();
    const onNavigateSession = vi.fn();
    apiFetch
      .mockResolvedValueOnce({ jobs: [cronJob({ id: 'history-job', name: 'History job' })] })
      .mockResolvedValueOnce({
        executions: [
          { id: 'exec-1', status: 'dispatched', detail: '## Result\nLine one', created_at: Date.now() },
          { id: 'exec-2', status: 'manual_trigger', detail: 'p2p:file-123', created_at: Date.now() },
        ],
      });

    render(
      <CronManager
        serverId="srv-current"
        projectName="cd"
        sessions={sessions}
        subSessions={subSessions}
        onBack={vi.fn()}
        onViewDiscussion={onViewDiscussion}
        onNavigateSession={onNavigateSession}
        servers={[{ id: 'srv-current', name: 'Current' }]}
      />,
    );

    expect(await screen.findByText('History job')).toBeDefined();
    fireEvent.click(screen.getAllByText('cron.history').at(-1)!);

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/cron/history-job/executions?limit=20'));
    fireEvent.click(screen.getByText('cron.view_discussion'));
    expect(onViewDiscussion).toHaveBeenCalledWith('file-123');

    fireEvent.click(screen.getAllByText('cron.go_to_session →')[0]);
    expect(onNavigateSession).toHaveBeenCalledWith('deck_cd_brain', undefined);

    fireEvent.click(screen.getAllByText('cron.history').at(-1)!);
    const detailPreview = await screen.findByText((_text, node) => node?.textContent === '## Result\nLine one');
    fireEvent.click(detailPreview);
    fireEvent.click(screen.getAllByText('cron.go_and_quote →').at(-1)!);
    expect(onNavigateSession).toHaveBeenCalledWith('deck_cd_brain', '## Result\nLine one');
  });

  it('loads cross-job executions and switches latest/all modes across servers', async () => {
    const onViewDiscussion = vi.fn();
    const onNavigateSession = vi.fn();
    apiFetch
      .mockResolvedValueOnce({ jobs: [cronJob({ id: 'job-cross', name: 'Cross job' })] })
      .mockResolvedValueOnce({
        executions: [{
          id: 'cross-1',
          job_id: 'job-cross',
          job_name: 'Cross job',
          server_id: 'srv-current',
          project_name: 'cd',
          cron_expr: '0 9 * * *',
          target_role: 'brain',
          target_session_name: null,
          action: JSON.stringify({ type: 'command', command: 'hello' }),
          status: 'dispatched',
          detail: 'Cross detail',
          created_at: Date.now(),
        }],
      })
      .mockResolvedValueOnce({
        executions: [{
          id: 'cross-2',
          job_id: 'job-cross',
          job_name: 'Cross p2p',
          server_id: 'srv-other',
          project_name: 'cd',
          cron_expr: '*/5 * * * *',
          target_role: 'brain',
          action: JSON.stringify({ type: 'p2p', mode: 'review' }),
          status: 'manual_trigger',
          detail: 'p2p:file-456',
          created_at: Date.now(),
        }],
      })
      .mockResolvedValueOnce({ jobs: [cronJob({ id: 'job-cross', name: 'Cross job' })] });

    render(
      <CronManager
        serverId="srv-current"
        projectName="cd"
        sessions={sessions}
        subSessions={subSessions}
        onBack={vi.fn()}
        onViewDiscussion={onViewDiscussion}
        onNavigateSession={onNavigateSession}
        servers={[{ id: 'srv-current', name: 'Current' }, { id: 'srv-other', name: 'Other' }]}
      />,
    );

    expect(await screen.findByText('Cross job')).toBeDefined();
    fireEvent.click(screen.getAllByText('cron.history')[0]);

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/cron/executions?mode=latest&serverId=srv-current'));
    fireEvent.click(screen.getByText('Cross detail'));
    fireEvent.click(screen.getAllByText('cron.go_and_quote →').at(-1)!);
    expect(onNavigateSession).toHaveBeenCalledWith('deck_cd_brain', 'Cross detail');

    fireEvent.click(screen.getByText('cron.exec_all'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/cron/executions?mode=all&serverId=srv-current'));

    fireEvent.click(screen.getByLabelText('cron.show_all_servers'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/cron?'));
    expect(localStorage.getItem('rcc_cron_show_all')).toBe('1');
  });
});
