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
];

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
});
