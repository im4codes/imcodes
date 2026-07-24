/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup, within, waitFor, act } from '@testing-library/preact';
import { useRef, useState } from 'preact/hooks';
import { FILE_TRANSFER_LIMITS } from '../../../shared/transport/file-transfer.js';

const DEFAULT_INNER_WIDTH = 1280;

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'openspec.title') return 'OpenSpec';
      if (key === 'openspec.changes') return 'changes';
      if (key === 'openspec.empty') return 'empty';
      if (key === 'openspec.no_tasks') return 'No tasks';
      if (key === 'openspec.task_status_title') return `${opts?.checked ?? 0}/${opts?.total ?? 0} tasks complete`;
      if (key === 'openspec.load_timeout') return 'openspec_timeout';
      if (key === 'openspec.load_unavailable') return 'openspec_unavailable';
      if (key === 'openspec.load_error') return 'openspec_error';
      if (key === 'openspec.audit_action') return 'audit_action';
      if (key === 'openspec.audit_implementation_action') return 'audit_implementation_action';
      if (key === 'openspec.audit_spec_action') return 'audit_spec_action';
      if (key === 'openspec.implement_action') return 'implement_action';
      if (key === 'openspec.achieve_action') return 'achieve_action';
      if (key === 'openspec.propose_action') return 'propose_action';
      if (key === 'openspec.auto.action') return 'Auto';
      if (key === 'openspec.auto.launcher_title') return 'Auto Deliver';
      if (key === 'openspec.auto.details_title') return 'Auto Deliver details';
      if (key === 'openspec.auto.current_run') return 'Current Auto Deliver';
      if (key === 'openspec.auto.kicker') return 'Auto Deliver';
      if (key === 'openspec.auto.start') return 'Start Auto Deliver';
      if (key === 'openspec.auto.auto_commit_push') return 'Commit and push automatically after audit passes';
      if (key === 'openspec.auto.auto_commit_push_help') return 'Saved as your preference. After the audit passes, the agent receives commit&push.';
      if (key === 'openspec.auto.view') return 'View';
      if (key === 'openspec.auto.stop') return 'Stop Auto Deliver';
      if (key === 'openspec.auto.lock_manual_actions') return 'Auto Deliver owns Team lane';
      if (key === 'openspec.auto.conflict_summary') return 'Details are visible only in participating sessions.';
      if (key === 'openspec.auto.error.missing_change') return 'Select a change first';
      if (key === 'openspec.auto.error.active_run') return 'Auto Deliver already running';
      if (key === 'openspec.auto.error.manual_team_busy') return 'Manual Team is busy';
      if (key === 'openspec.auto.error.unsupported_runtime') return 'Unsupported runtime';
      if (key === 'openspec.auto.error.daemon_offline') return 'Daemon offline';
      if (key === 'openspec.auto.error.launch_timeout') return 'Launch timed out';
      if (key === 'openspec.auto.error.invalid_rounds') return 'Invalid rounds';
      if (key === 'openspec.auto.error.custom_combo_unsupported') return 'Custom Team combos are not supported for Auto Deliver yet';
      if (key === 'openspec.auto.error.launch_failed') return 'Launch failed';
      if (key === 'openspec.auto.custom') return 'Custom';
      if (key === 'openspec.auto.preset.fast') return 'Fast';
      if (key === 'openspec.auto.preset.standard') return 'Standard';
      if (key === 'openspec.auto.preset.strict') return 'Strict';
      if (key === 'openspec.auto.preset.deep') return 'Deep';
      if (key === 'openspec.auto.preset_limits') return `Spec ${opts?.spec ?? ''} · Impl ${opts?.impl ?? ''}`;
      if (key === 'openspec.auto.materialized_limits') return `Spec audit-repair ${opts?.spec ?? ''} · Implementation audit-repair ${opts?.impl ?? ''}`;
      if (key === 'openspec.auto.tasks_progress') return `${opts?.checked ?? 0}/${opts?.total ?? 0} tasks`;
      if (key === 'openspec.auto.prompt_count') return `${opts?.count ?? 0} prompts`;
      if (key === 'openspec.auto.conflict_active') return `${opts?.change ?? ''} already running`;
      if (key === 'openspec.auto.reason.missing_authoritative_json') return 'The audit did not produce a final authoritative JSON result.';
      if (key.startsWith('openspec.auto.status.')) return key.split('.').pop() ?? key;
      if (key.startsWith('openspec.auto.stage.')) return key.split('.').pop() ?? key;
      if (key === 'openspec.propose_from_discussion_action') return 'propose_from_discussion_action';
      if (key === 'openspec.propose_from_description_action') return 'propose_from_description_action';
      if (key === 'openspec.audit_implementation_prompt') {
        return `audit implementation ${(opts?.reference as string) ?? ''}, fix code gaps and update openspec files`;
      }
      if (key === 'openspec.audit_spec_prompt') {
        return `audit spec ${(opts?.reference as string) ?? ''}, update proposal design specs and tasks`;
      }
      if (key === 'openspec.implement_prompt') {
        return `implement ${(opts?.reference as string) ?? ''}, keep openspec artifacts aligned while coding`;
      }
      if (key === 'openspec.achieve_prompt') {
        return `complete ${(opts?.reference as string) ?? ''}, update proposal design specs tasks and archive if done`;
      }
      if (key === 'openspec.propose_from_discussion_prompt') {
        return 'generate openspec change from recent discussion and write proposal design specs tasks';
      }
      if (key === 'openspec.propose_from_description_prompt') {
        return 'generate openspec change from description below and write proposal design specs tasks';
      }
      if (key === 'session.transport_send_queued_collapsed') {
        return `${opts?.count ?? 0} queued · showing latest only`;
      }
      if (key === 'session.transport_send_queued_count') {
        return `${opts?.count ?? 0} queued`;
      }
      if (key === 'share.actorLabel') {
        return `${String(opts?.name ?? '')} · ${String(opts?.role ?? '')}`;
      }
      if (key === 'share.role.viewer') return 'Viewer';
      if (key === 'share.role.participant') return 'Participant';
      if (key === 'share.role.serverMember') return 'Server member';
      if (key === 'share.role.serverManager') return 'Server manager';
      if (key === 'share.role.system') return 'System';
      if (key === 'session.send_placeholder') {
        return `Send to ${String(opts?.name ?? 'session')}…`;
      }
      if (key === 'session.send_placeholder_desktop_upload') {
        return `${String(opts?.placeholder ?? '')} Supports fast multi-file paste or drag upload`;
      }
      if (key === 'upload.long_text_attached') {
        return `Large pasted text attached as ${String(opts?.name ?? '')}`;
      }
      if (key === 'upload.drop_overlay_title') return 'Drop files to upload';
      if (key === 'upload.drop_overlay_hint') return 'Release anywhere in this session window';
      if (key === 'upload.file_too_large') {
        return `File too large (max ${String(opts?.max ?? '')}MB)`;
      }
      if (key === 'upload.long_text_requires_attachment') {
        return 'Paste is too large for inline input here. Upload it as a file instead.';
      }
      if (key === 'session.stop_plain') return 'Stop';
      if (key === 'session.restart_plain') return 'Restart';
      if (key === 'session.start_fresh') return 'Start fresh';
      if (key === 'session.pin_plain') return 'Pin';
      if (key === 'session.unpin_plain') return 'Unpin';
      if (key === 'session.rename_plain') return 'Rename';
      if (key === 'session.unpin_to_stop') return 'Unpin tab first to stop';
      if (key === 'session.tab_pin') return 'Pin';
      if (key === 'session.tab_unpin') return 'Unpin';
      if (key === 'session.clone.menu') return 'Copy session group';
      if (key === 'session.supervision.quickLabel') return 'Auto';
      if (key === 'session.supervision.quickAuditLabel') return 'Audit';
      if (key === 'session.supervision.quickTitle') return 'Auto mode';
      if (key === 'session.approval.pending') return 'Approval required';
      if (key === 'session.approval.allow') return 'Allow';
      if (key === 'session.approval.deny') return 'Deny';
      if (key === 'session.approval.tool') return `${String(opts?.tool ?? 'tool')} wants approval`;
      if (key === 'session.approval.scope') return `${String(opts?.provider ?? 'provider')} generation ${String(opts?.generation ?? '?')} tool ${String(opts?.toolUseId ?? 'tool')}`;
      if (key === 'session.approval.input') return `Input: ${String(opts?.input ?? '')}`;
      if (key === 'common.hide') return 'hide';
      if (key === 'common.show') return 'show';
      const parts = key.split('.');
      return parts[parts.length - 1];
    },
  }),
}));

vi.mock('../../src/components/QuickInputPanel.js', () => ({
  QuickInputPanel: ({ open, onSend }: { open: boolean; onSend: (text: string) => void }) => open ? (
    <button onClick={() => onSend('quick combo message')}>quick-panel-send</button>
  ) : null,
  EMPTY_QUICK_DATA: { history: [], sessionHistory: {}, commands: [], phrases: [] },
  getNavigableHistory: (data: { history: string[]; sessionHistory: Record<string, string[]> }, sessionName?: string) => {
    if (!sessionName) return data.history;
    const sessionHist = data.sessionHistory[sessionName] ?? [];
    return sessionHist.length > 0 ? sessionHist : data.history;
  },
}));

vi.mock('../../src/components/VoiceOverlay.js', () => ({
  VoiceOverlay: ({ open, onSend }: { open: boolean; onSend: (text: string) => void }) => open ? (
    <button onClick={() => onSend('voice combo message')}>voice-overlay-send</button>
  ) : null,
}));

vi.mock('../../src/components/VoiceInput.js', () => ({
  isAvailable: () => true,
}));

vi.mock('../../src/components/AtPicker.js', () => ({
  AtPicker: ({ visible, onSelectAllConfig, onSelectAgent, onSelectDelegateAgent, p2pConfig, sessions, rootSession }: {
    visible: boolean;
    onSelectAllConfig?: (config: unknown, rounds: number, modeOverride: string) => void;
    onSelectAgent?: (session: string, mode: string) => void;
    onSelectDelegateAgent?: (session: string) => void;
    p2pConfig?: { rounds?: number } | null;
    sessions?: Array<{ name: string; label?: string | null; parentSession?: string | null; isSelf?: boolean }>;
    rootSession?: string | null;
  }) => {
    const [stage, setStage] = useState<'root' | 'agents'>('root');
    if (!visible) return null;
    const visibleAgents = (sessions ?? []).filter((entry) => {
      const sameRoot = (entry.parentSession ?? entry.name) === rootSession || entry.name === rootSession;
      return sameRoot;
    });
    if (stage === 'root') {
      return (
        <div>
          <button onClick={() => onSelectAllConfig?.(p2pConfig, p2pConfig?.rounds ?? 1, 'config')}>mock-select-all-config</button>
          <button>files</button>
          <button onClick={() => setStage('agents')}>agents</button>
        </div>
      );
    }
    if (stage === 'agents') {
      return (
        <div>
          {visibleAgents.map((entry) => (
            <button key={entry.name} onClick={() => onSelectDelegateAgent?.(entry.name)}>
              {entry.label ?? entry.name}
            </button>
          ))}
        </div>
      );
    }
    void onSelectAgent;
    return null;
  },
}));

vi.mock('../../src/components/file-browser-lazy.js', () => ({
  FileBrowser: ({ initialPath, mode, defaultTab, changesRootPath, onConfirm }: {
    initialPath?: string;
    mode: string;
    defaultTab?: string;
    changesRootPath?: string;
    onConfirm: (paths: string[]) => void;
  }) => (
    <div
      data-testid="mock-file-browser"
      data-initial-path={initialPath ?? ''}
      data-mode={mode}
      data-default-tab={defaultTab ?? ''}
      data-changes-root-path={changesRootPath ?? ''}
    >
      <button onClick={() => onConfirm([`${initialPath ?? ''}/proposal.md`])}>mock-file-confirm</button>
    </div>
  ),
}));

const uploadFileMock = vi.fn();
const execCommandMock = vi.fn(() => true);
const getUserPrefMock = vi.fn().mockResolvedValue(null);
const saveUserPrefMock = vi.fn().mockResolvedValue(undefined);
const fetchSupervisorDefaultsMock = vi.fn().mockResolvedValue(null);
const patchSessionMock = vi.fn().mockResolvedValue(undefined);
const patchSubSessionMock = vi.fn().mockResolvedValue(undefined);
const sendSessionViaHttpMock = vi.fn().mockResolvedValue(undefined);
const onUserPrefChangedMock = vi.fn((cb: (key: string, value: unknown) => void) => {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: string; value?: unknown }>).detail;
    if (!detail?.key) return;
    cb(detail.key, detail.value);
  };
  window.addEventListener('imcodes:user-pref-changed', handler as EventListener);
  return () => window.removeEventListener('imcodes:user-pref-changed', handler as EventListener);
});
vi.mock('../../src/api.js', () => ({
  uploadFile: (...args: unknown[]) => uploadFileMock(...args),
  getUserPref: async (key: string) => {
    if (key === 'supervision.user_default') {
      try {
        return await fetchSupervisorDefaultsMock();
      } catch {
        return null;
      }
    }
    return getUserPrefMock(key);
  },
  saveUserPref: (...args: unknown[]) => saveUserPrefMock(...args),
  fetchSupervisorDefaults: (...args: unknown[]) => fetchSupervisorDefaultsMock(...args),
  patchSession: (...args: unknown[]) => patchSessionMock(...args),
  patchSubSession: (...args: unknown[]) => patchSubSessionMock(...args),
  sendSessionViaHttp: (...args: unknown[]) => sendSessionViaHttpMock(...args),
  onUserPrefChanged: (...args: unknown[]) => onUserPrefChangedMock(...args as Parameters<typeof onUserPrefChangedMock>),
}));

import { OpenSpecAutoDeliverLauncher } from '../../src/components/OpenSpecAutoDeliver.js';
import { OPENSPEC_LIST_REQUEST_TIMEOUT_MS, SessionControls } from '../../src/components/SessionControls.js';
import { __resetPrefCacheForTests } from '../../src/hooks/usePref.js';
import type { SessionInfo } from '../../src/types.js';
import { DAEMON_MSG } from '@shared/daemon-events.js';
import { P2P_CONFIG_MSG } from '@shared/p2p-config-events.js';
import { TRANSPORT_MSG } from '@shared/transport-events.js';

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob text'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsText(blob);
  });
}

const TEST_OPENSPEC_ADVANCED_ROUNDS = [
  {
    id: 'initial_audit',
    title: 'Initial audit',
    preset: 'proposal_audit',
    executionMode: 'multi_dispatch',
    permissionScope: 'analysis_only',
    timeoutMinutes: 5,
  },
  {
    id: 'implementation_plan',
    title: 'Implementation plan',
    preset: 'implementation',
    executionMode: 'single_main',
    permissionScope: 'implementation',
    timeoutMinutes: 5,
  },
] as const;

const makeWs = (overrides: { capabilitySnapshot?: { daemonId: string; capabilities: string[]; helloEpoch: number; sentAt: number; observedAt: number } | null } = {}) => {
  const handlers = new Set<(msg: unknown) => void>();
  // Default to a fresh capability snapshot so the advanced launch gate doesn't
  // accidentally suppress envelopes in tests that don't care about it.
  const defaultSnapshot = {
    daemonId: 'daemon-test',
    capabilities: ['p2p.workflow.v1'],
    helloEpoch: 1,
    sentAt: Date.now(),
    observedAt: Date.now(),
  };
  const capabilitySnapshot = overrides.capabilitySnapshot === undefined ? defaultSnapshot : overrides.capabilitySnapshot;
  return {
    send: vi.fn(),
    sendSessionCommand: vi.fn(),
    sendSessionMessage: vi.fn(),
    // Urgent variant for stop / cancel — bypasses the probe-state gate.
    // Stop must reach the server even during a brief WS probe (`_connected
    // = false` for ~50-200ms after focus/visibility ticks).
    sendSessionCommandUrgent: vi.fn(),
    cloneSessionGroup: vi.fn(),
    cancelSessionGroupClone: vi.fn(),
    sendInput: vi.fn(),
    requestSessionList: vi.fn(),
    p2pStatus: vi.fn(),
    p2pListDiscussions: vi.fn(),
    subscribeTransportSession: vi.fn(),
    unsubscribeTransportSession: vi.fn(),
    respondTransportApproval: vi.fn(),
    connected: true,
    subSessionSetModel: vi.fn(),
    fsListDir: vi.fn(() => 'openspec-request'),
    onMessage: vi.fn((handler: (msg: unknown) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    }),
    getDaemonCapabilitySnapshot: vi.fn(() => capabilitySnapshot),
    onDaemonCapabilitySnapshot: vi.fn(() => () => {}),
    isDaemonCapabilityStale: vi.fn(() => false),
    emit: (msg: unknown) => {
      handlers.forEach((handler) => handler(msg));
    },
  };
};

/** Helpers accept either path (regular `sendSessionCommand` or the urgent
 *  variant `sendSessionCommandUrgent`) — caller's choice depends on whether
 *  `text` is `/stop` (urgent) or anything else (regular). Tests that need
 *  to pin the URGENT contract specifically assert on
 *  `sendSessionCommandUrgent` directly. */
function gatherSendCalls(ws: ReturnType<typeof makeWs>): Array<Record<string, unknown>> {
  return [
    ...ws.sendSessionCommand.mock.calls,
    ...ws.sendSessionCommandUrgent.mock.calls,
  ]
    .filter(([cmd]) => cmd === 'send')
    .map(([, p]) => p as Record<string, unknown>);
}

function gatherCancelCalls(ws: ReturnType<typeof makeWs>): Array<Record<string, unknown>> {
  return [
    ...ws.sendSessionCommand.mock.calls,
    ...ws.sendSessionCommandUrgent.mock.calls,
  ]
    .filter(([cmd]) => cmd === 'cancel')
    .map(([, p]) => p as Record<string, unknown>);
}

function expectSendPayload(ws: ReturnType<typeof makeWs>, payload: Record<string, unknown>): void {
  expect(gatherSendCalls(ws)).toContainEqual(expect.objectContaining({
    ...payload,
    commandId: expect.any(String),
  }));
}

function expectCancelPayload(ws: ReturnType<typeof makeWs>, payload: Record<string, unknown>): void {
  expect(gatherCancelCalls(ws)).toContainEqual(expect.objectContaining({
    ...payload,
    commandId: expect.any(String),
  }));
}

function expectUrgentCancelPayload(ws: ReturnType<typeof makeWs>, payload: Record<string, unknown>): void {
  expect(ws.sendSessionCommandUrgent).toHaveBeenCalledWith('cancel', expect.objectContaining({
    ...payload,
    commandId: expect.any(String),
  }));
  expect(ws.sendSessionCommand).not.toHaveBeenCalledWith('cancel', expect.objectContaining(payload));
}

function expectLastSendPayload(ws: ReturnType<typeof makeWs>, payload: Record<string, unknown>): void {
  const calls = gatherSendCalls(ws);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls[calls.length - 1]).toEqual(expect.objectContaining({
    ...payload,
    commandId: expect.any(String),
  }));
}

const makeQuickData = () => ({
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
});

const makeSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  name: 'my-session',
  project: 'my-project',
  role: 'w1',
  agentType: 'worker',
  state: 'idle',
  ...overrides,
});

const makeTransportSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => makeSession({
  agentType: 'codex-sdk',
  runtimeType: 'transport',
  queueEpoch: 'queue-epoch-1',
  queueAuthorityId: 'queue-authority-1',
  transportPendingMessageVersion: 0,
  ...overrides,
});

const mainSession = makeSession({
  name: 'deck_my-project_brain',
  project: 'my-project',
  role: 'brain',
  label: 'brain',
});

const subSession = (name: string, label: string): SessionInfo =>
  makeSession({
    name,
    project: 'my-project',
    role: label,
    label,
    agentType: 'codex',
  });

describe('SessionControls', () => {
afterEach(() => {
  cleanup();
  __resetPrefCacheForTests();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: DEFAULT_INNER_WIDTH });
});

  beforeEach(() => {
    vi.clearAllMocks();
    execCommandMock.mockImplementation((_command: string, _ui?: boolean, value?: string) => {
      const active = document.activeElement as HTMLDivElement | null;
      if (active && typeof active.textContent === 'string') {
        active.textContent = `${active.textContent}${String(value ?? '')}`;
      }
      return true;
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommandMock,
    });
    sessionStorage.clear();
    localStorage.clear();
    fetchSupervisorDefaultsMock.mockResolvedValue(null);
    patchSessionMock.mockResolvedValue(undefined);
    patchSubSessionMock.mockResolvedValue(undefined);
    sendSessionViaHttpMock.mockReset().mockResolvedValue(undefined);
    getUserPrefMock.mockImplementation(async (key: unknown) => {
      if (typeof key === 'string' && key.startsWith('p2p_session_config:')) {
        return JSON.stringify({
          sessions: {
            deck_sub_abc: { enabled: true, mode: 'audit' },
          },
          rounds: 3,
        });
      }
      return null;
    });
    saveUserPrefMock.mockResolvedValue(undefined);
  });

  it('renders input and send button', () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    expect(screen.getByRole('textbox')).toBeDefined();
    expect(screen.getByRole('button', { name: /send/i })).toBeDefined();
  });

  it('shows copy group action only for main-session controls and hides it from sub/compact surfaces', () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={mainSession}
        serverId="server-1"
        sessions={[mainSession]}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByTitle('actions'));
    expect(screen.getByText('Copy session group')).toBeDefined();
    fireEvent.click(screen.getByText('Copy session group'));
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByDisplayValue('deck_my-project_brain')).toBeDefined();
    expect(screen.getByText('deck_my_project_1_brain')).toBeDefined();
    expect(screen.queryByText('brain copy')).toBeNull();

    cleanup();
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={mainSession}
        subSessionId="abc"
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByTitle('actions'));
    expect(screen.queryByText('Copy session group')).toBeNull();

    cleanup();
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={subSession('deck_sub_worker', 'Worker')}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByTitle('actions'));
    expect(screen.queryByText('Copy session group')).toBeNull();

    cleanup();
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={mainSession}
        quickData={makeQuickData() as any}
        compact
      />,
    );

    expect(screen.queryByTitle('actions')).toBeNull();
    expect(screen.queryByText('Copy session group')).toBeNull();
  });

  it('pins and unpins the active session from the session actions menu', () => {
    const onToggleSessionPin = vi.fn();
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={mainSession}
        quickData={makeQuickData() as any}
        onToggleSessionPin={onToggleSessionPin}
      />,
    );

    fireEvent.click(screen.getByTitle('actions'));
    fireEvent.click(screen.getByText('Pin'));
    expect(onToggleSessionPin).toHaveBeenCalledWith('deck_my-project_brain');
    expect(screen.queryByText('Pin')).toBeNull();

    cleanup();
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={mainSession}
        quickData={makeQuickData() as any}
        sessionPinned
        onToggleSessionPin={onToggleSessionPin}
      />,
    );

    fireEvent.click(screen.getByTitle('actions'));
    fireEvent.click(screen.getByText('Unpin'));
    expect(onToggleSessionPin).toHaveBeenLastCalledWith('deck_my-project_brain');
  });

  it('shows typed colored icons for every session action menu option', () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={mainSession}
        serverId="server-1"
        sessions={[mainSession]}
        quickData={makeQuickData() as any}
        onSettings={vi.fn()}
        onToggleSessionPin={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTitle('actions'));
    const menu = document.querySelector('.session-actions-menu') as HTMLElement;
    expect(menu).toBeTruthy();

    const expected: Array<[string, string]> = [
      ['Pin', 'session-action-menu-icon-pin'],
      ['Restart', 'session-action-menu-icon-restart'],
      ['Start fresh', 'session-action-menu-icon-new'],
      ['Rename', 'session-action-menu-icon-rename'],
      ['settings', 'session-action-menu-icon-settings'],
      ['Copy session group', 'session-action-menu-icon-clone'],
      ['Stop', 'session-action-menu-icon-stop'],
    ];

    for (const [label, iconClass] of expected) {
      const button = within(menu).getByRole('button', { name: label });
      expect(button.querySelector(`.${iconClass}`)).toBeTruthy();
    }
  });

  it('uses the same unpin-first stop guard in the session action menu', () => {
    const onStopProject = vi.fn();
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={mainSession}
        quickData={makeQuickData() as any}
        onStopProject={onStopProject}
        stopBlockedByPinned
      />,
    );

    fireEvent.click(screen.getByTitle('actions'));
    const stopButton = screen.getByRole('button', { name: /unpin tab first to stop/i });
    expect((stopButton as HTMLButtonElement).disabled).toBe(true);
    expect(stopButton.querySelector('.session-action-menu-icon-unpin')).toBeTruthy();
    expect(onStopProject).not.toHaveBeenCalled();
  });

  it('hides the pin action from sub-session and compact action menus', () => {
    const onToggleSessionPin = vi.fn();
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={mainSession}
        subSessionId="abc"
        quickData={makeQuickData() as any}
        onToggleSessionPin={onToggleSessionPin}
      />,
    );

    fireEvent.click(screen.getByTitle('actions'));
    expect(screen.queryByText('Pin')).toBeNull();

    cleanup();
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={mainSession}
        quickData={makeQuickData() as any}
        compact
        onToggleSessionPin={onToggleSessionPin}
      />,
    );

    expect(screen.queryByTitle('actions')).toBeNull();
    expect(screen.queryByText('Pin')).toBeNull();
  });

  it('keeps openspec through p2p settings controls visible in compact card mode', () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={makeSession({ projectDir: '/tmp/project' })}
        quickData={makeQuickData() as any}
        compact
      />,
    );
    expect(screen.getByText('OpenSpec')).toBeDefined();
    expect(screen.getByText('Team')).toBeDefined();
    expect(screen.getByLabelText('settings_button')).toBeDefined();
    expect(document.querySelector('.shortcuts')).toBeNull();
  });

  it('reports card overlay state when compact dropdowns open', () => {
    const onOverlayOpenChange = vi.fn();
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={makeSession({ projectDir: '/tmp/project' })}
        quickData={makeQuickData() as any}
        compact
        onOverlayOpenChange={onOverlayOpenChange}
      />,
    );

    fireEvent.click(screen.getByText('OpenSpec'));
    expect(onOverlayOpenChange).toHaveBeenLastCalledWith(true);
    expect(document.querySelector('.menu-dropdown-openspec')).toBeTruthy();

    fireEvent.mouseDown(document.body);
    expect(onOverlayOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('shows the desktop upload hint in the placeholder on desktop', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: DEFAULT_INNER_WIDTH });
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    expect(document.querySelector('.controls-input')?.getAttribute('data-placeholder')).toBe('Send to my-project… Supports fast multi-file paste or drag upload');
  });

  it('keeps the placeholder short on mobile', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    expect(document.querySelector('.controls-input')?.getAttribute('data-placeholder')).toBe('Send to my-project…');
  });


  it('uses the parent connected prop instead of a stale ws.connected getter', () => {
    const ws = makeWs() as any;
    ws.connected = false;
    render(
      <SessionControls
        ws={ws}
        connected={true}
        activeSession={makeSession({ name: 'my-session' })}
        quickData={makeQuickData() as any}
      />,
    );
    expect(document.querySelector('.controls-input')?.getAttribute('data-placeholder')).toBe('Send to my-project… Supports fast multi-file paste or drag upload');
  });

  it('hides the send button on mobile and shows the embedded voice button when empty', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    expect(screen.queryByRole('button', { name: /send/i })).toBeNull();
    expect(document.querySelector('.btn-voice-embedded')).toBeTruthy();
    expect(screen.getByTitle('voice_input')).toBeDefined();
  });

  it('hides the embedded voice button after typing on mobile', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'hello';
    fireEvent.input(input);
    expect(document.querySelector('.btn-voice-embedded')).toBeNull();
  });

  it('sends on Enter on mobile without a send button', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'run tests';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expectSendPayload(ws, {
      sessionName: 'my-session',
      text: 'run tests',
    });
  });

  it('bottom-aligns side buttons on mobile once the composer grows past two lines', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    const { container } = render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;
    Object.defineProperty(input, 'clientHeight', { configurable: true, value: 32 });
    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 84 });
    input.textContent = 'hello world';
    fireEvent.input(input);
    expect(container.querySelector('.controls-mobile-multiline')).toBeTruthy();
  });

  it('does not show the mobile expand button until the composer exceeds two lines', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    expect(screen.queryByRole('button', { name: 'expand composer' })).toBeNull();
  });

  it('places the mobile expand button above the quick trigger and expands the composer', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    const { container } = render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;
    Object.defineProperty(input, 'clientHeight', { configurable: true, value: 32 });
    Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 84 });
    fireEvent.input(input);
    const expandButton = screen.getByRole('button', { name: 'expand composer' });
    expect(expandButton.className).toContain('btn-input-expand-floating');
    fireEvent.click(expandButton);
    expect(container.querySelector('.controls-composer-mobile-expanded')).toBeTruthy();
    expect(container.querySelector('.controls-composer-backdrop')).toBeTruthy();
  });

  it('renders menu button (⋯)', () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    // The ⋯ menu button has title from t('session.actions') → 'actions'
    const menuBtn = screen.getByTitle('actions');
    expect(menuBtn).toBeDefined();
  });

  it('only shows the scan sweep while the session is visually running', () => {
    const idleView = render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={makeSession({ state: 'idle' })}
        activeThinking={true}
        quickData={makeQuickData() as any}
      />,
    );
    expect(idleView.container.querySelector('.controls-wrapper-running')).toBeNull();
    idleView.unmount();

    const runningView = render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={makeSession({ state: 'running' })}
        activeThinking={false}
        quickData={makeQuickData() as any}
      />,
    );
    expect(runningView.container.querySelector('.controls-wrapper-running')).toBeTruthy();
  });

  it('send button is disabled when input is empty', () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    const sendBtn = screen.getByRole('button', { name: /send/i });
    expect((sendBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('send button is enabled when input has text', () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;
    // contenteditable: set textContent and fire input event
    input.textContent = 'hello';
    fireEvent.input(input);
    const sendBtn = screen.getByRole('button', { name: /send/i });
    expect((sendBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it('clicking send calls ws.sendSessionCommand with correct args', () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'run tests';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(ws.sendSessionCommand).toHaveBeenCalledOnce();
    expectSendPayload(ws, {
      sessionName: 'my-session',
      text: 'run tests',
    });
  });

  it('generates a distinct commandId for each send', () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;

    input.textContent = 'first';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    input.textContent = 'second';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledTimes(2);
    const firstPayload = ws.sendSessionCommand.mock.calls[0]?.[1] as { commandId?: string };
    const secondPayload = ws.sendSessionCommand.mock.calls[1]?.[1] as { commandId?: string };
    expect(firstPayload.commandId).toEqual(expect.any(String));
    expect(secondPayload.commandId).toEqual(expect.any(String));
    expect(firstPayload.commandId).not.toBe(secondPayload.commandId);
  });

  it('sends an advanced p2p workflow envelope when config mode is used', async () => {
    const ws = makeWs();
    getUserPrefMock.mockImplementation(async (key: unknown) => {
      if (typeof key === 'string' && key.startsWith('p2p_session_config:')) {
        return JSON.stringify({
          sessions: {
            'deck_sub_abc': { enabled: true, mode: 'review' },
          },
          rounds: 3,
          advancedPresetKey: 'openspec',
          advancedRounds: TEST_OPENSPEC_ADVANCED_ROUNDS,
          advancedRunTimeoutMinutes: 45,
          contextReducer: {
            mode: 'clone_sdk_session',
            templateSession: 'deck_sub_abc',
          },
        });
      }
      return null;
    });

    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session' })}
        quickData={makeQuickData() as any}
      />,
    );
    await flushAsync();

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = '@';
    fireEvent.input(input);
    fireEvent.click(screen.getByText('mock-select-all-config'));

    input.textContent = `${input.textContent} ship it`;
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    expectSendPayload(ws, {
      sessionName: 'my-session',
      text: 'ship it',
      p2pAtTargets: [
        { session: '__all__', mode: 'config' },
      ],
      p2pSessionConfig: {
        'deck_sub_abc': { enabled: true, mode: 'review' },
      },
      p2pRounds: 3,
      p2pLocale: 'en',
    });
    const sent = gatherSendCalls(ws).at(-1)!;
    expect(sent.p2pWorkflowLaunchEnvelope).toEqual(expect.objectContaining({
      workflowSchemaVersion: 1,
      workflowKind: 'advanced',
      launchContext: expect.objectContaining({
        sessionName: 'my-session',
        userText: 'ship it',
        locale: 'en',
      }),
    }));
    expect(JSON.stringify(sent.p2pWorkflowLaunchEnvelope)).not.toMatch(/compiledWorkflow|privateRuntimeState|rawPrompt|rawScriptOutput|artifactBaselines|token|env/i);
    expect(sent).not.toHaveProperty('p2pAdvancedPresetKey');
    expect(sent).not.toHaveProperty('p2pAdvancedRounds');
    expect(sent).not.toHaveProperty('p2pAdvancedRunTimeoutMinutes');
    expect(sent).not.toHaveProperty('p2pContextReducer');
  });

  it('keeps the p2p button in solo mode after triggering a combo from the dropdown', async () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    await flushAsync();

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'run combo';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /^team$/i }));
    fireEvent.click(screen.getByText(/mode_audit→mode_review→mode_plan/i));

    expect(screen.getByText('combo_send_confirm_title')).toBeDefined();
    expect(screen.getAllByRole('button', { name: /^send$/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: /^team$/i })).toBeDefined();
  });

  it('asks for confirmation before directly sending from a combo dropdown item', async () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    await flushAsync();

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'run combo';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /^team$/i }));
    fireEvent.click(screen.getByText(/mode_audit→mode_review→mode_plan/i));

    expect(screen.getByText('combo_send_confirm_title')).toBeDefined();
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /^team$/i })).toBeDefined();
  });

  it('blocks combo sends that only contain routing markup and shows a warning', () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = '@@all(audit>plan)';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
    expect(screen.queryByText('combo_send_confirm_title')).toBeNull();
    expect(screen.getByText('combo_empty_message_warning')).toBeDefined();
  });

  it('disables combo modes when no participants are configured', async () => {
    getUserPrefMock.mockImplementation(async (key: unknown) => {
      if (typeof key === 'string' && key.startsWith('p2p_session_config:')) {
        return JSON.stringify({
          sessions: {
            'deck_sub_abc': { enabled: false, mode: 'audit' },
          },
          rounds: 3,
        });
      }
      return null;
    });

    render(<SessionControls ws={makeWs() as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: /^team$/i }));

    expect(screen.getByText('combo_requires_participants_hint')).toBeDefined();
    const comboBtn = screen.getByRole('button', { name: /mode_audit→mode_review→mode_plan/i }) as HTMLButtonElement;
    expect(comboBtn.disabled).toBe(true);
    expect(comboBtn.title).toBe('combo_requires_participants_hint');
  });

  it('applies P2P config preference events without refetching', async () => {
    let prefValue = JSON.stringify({
      sessions: {
        'deck_sub_abc': { enabled: false, mode: 'audit' },
      },
      rounds: 3,
    });
    getUserPrefMock.mockImplementation(async (key: unknown) => {
      if (typeof key === 'string' && key.startsWith('p2p_session_config:')) {
        return prefValue;
      }
      return null;
    });

    render(<SessionControls ws={makeWs() as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    await flushAsync();
    const initialFetches = getUserPrefMock.mock.calls.filter(([key]) => key === 'p2p_session_config:my-session').length;

    prefValue = JSON.stringify({
      sessions: {
        'deck_sub_abc': { enabled: true, mode: 'review' },
      },
      rounds: 3,
    });
    window.dispatchEvent(new CustomEvent('imcodes:user-pref-changed', {
      detail: { key: 'p2p_session_config:my-session', value: prefValue },
    }));
    await flushAsync();
    const currentFetches = getUserPrefMock.mock.calls.filter(([key]) => key === 'p2p_session_config:my-session').length;
    expect(currentFetches).toBe(initialFetches);
  });

  it('loads P2P config from a server-scoped preference key when a server is selected', async () => {
    getUserPrefMock.mockResolvedValue(null);
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={makeSession({ name: 'my-session' })}
        serverId="srv-one"
        quickData={makeQuickData() as any}
      />,
    );

    await flushAsync();

    expect(getUserPrefMock).toHaveBeenCalledWith('p2p_session_config:srv-one:my-session');
  });

  it('syncs loaded P2P config into daemon authority on mount', async () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);

    await flushAsync();
    await waitFor(() => {
      expect(ws.send).toHaveBeenCalledWith({
        type: P2P_CONFIG_MSG.SAVE,
        requestId: expect.any(String),
        scopeSession: 'my-session',
        config: {
          sessions: {
            deck_sub_abc: { enabled: true, mode: 'audit' },
          },
          rounds: 3,
        },
      });
    });
  });

  it('re-sends the current P2P config when the daemon reconnects', async () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);

    await flushAsync();
    await waitFor(() => expect(ws.send).toHaveBeenCalledTimes(1));

    ws.emit({ type: DAEMON_MSG.RECONNECTED });

    await waitFor(() => expect(ws.send).toHaveBeenCalledTimes(2));
    expect(ws.send).toHaveBeenLastCalledWith({
      type: P2P_CONFIG_MSG.SAVE,
      requestId: expect.any(String),
      scopeSession: 'my-session',
      config: {
        sessions: {
          deck_sub_abc: { enabled: true, mode: 'audit' },
        },
        rounds: 3,
      },
    });
  });

  it('only shows solo plus combo items in the p2p dropdown', async () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: /^team$/i }));

    expect(screen.getByText('Team')).toBeDefined();
    expect(screen.queryByText(/^mode_audit$/i)).toBeNull();
    expect(screen.queryByText(/^mode_review$/i)).toBeNull();
    expect(screen.queryByText(/^mode_plan$/i)).toBeNull();
    expect(screen.queryByText(/^mode_brainstorm$/i)).toBeNull();
    expect(screen.queryByText(/^mode_discuss$/i)).toBeNull();
    expect(screen.queryByText(/^mode_config$/i)).toBeNull();
    expect(screen.queryByText(/^mode_audit→mode_plan$/i)).toBeNull();
    expect(screen.queryByText(/^mode_review→mode_plan$/i)).toBeNull();
    expect(screen.getByText(/mode_audit→mode_review→mode_plan/i)).toBeDefined();
    expect(within(screen.getByTestId('p2p-dropdown-tab-workflows')).getByText('alpha_badge')).toBeDefined();
  });

  it('puts the global rounds selector at the top of the P2P dropdown and saves changes', async () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: /^team$/i }));

    const menu = screen.getByTestId('p2p-dropdown');
    const rounds = within(menu).getByTestId('p2p-dropdown-rounds');
    const solo = within(menu).getByRole('button', { name: /solo_hint$/i });
    expect(rounds.compareDocumentPosition(solo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(within(rounds).getByTestId('p2p-dropdown-round-2'));
    await flushAsync();

    expect(saveUserPrefMock).toHaveBeenCalledWith(
      'p2p_session_config:my-session',
      expect.stringContaining('"rounds":2'),
    );
  });

  it('updates the p2p dropdown when custom combos are created without a page refresh', async () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    await flushAsync();

    const { P2pConfigPanel } = await import('../../src/components/P2pConfigPanel.js');
    render(
      <P2pConfigPanel
        sessions={[{ name: 'my-session', agentType: 'claude-code', state: 'idle' }]}
        subSessions={[]}
        activeSession="my-session"
        onClose={() => {}}
        onSave={() => {}}
      />,
    );
    await flushAsync();

    fireEvent.click(screen.getAllByRole('button', { name: 'combo_label' }).at(-1)!);
    fireEvent.click(screen.getByText('+mode_brainstorm'));
    fireEvent.click(screen.getByText('+mode_review'));
    fireEvent.click(screen.getByText('✓'));
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: /^team$/i }));
    expect(screen.getAllByText(/mode_brainstorm→mode_review/i).length).toBeGreaterThanOrEqual(1);
  });

  it('remembers skipping combo confirmation across later dropdown combo sends', async () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    await flushAsync();

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'first combo';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /^team$/i }));
    fireEvent.click(screen.getByText(/mode_audit→mode_review→mode_plan/i));

    const dialog = screen.getByText('combo_send_confirm_title').closest('.dialog') as HTMLElement;
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: /^send$/i }));

    expectSendPayload(ws, {
      sessionName: 'my-session',
      text: 'first combo',
      p2pAtTargets: [
        { session: '__all__', mode: 'config' },
      ],
      p2pMode: 'audit>review>plan',
      p2pSessionConfig: {
        deck_sub_abc: { enabled: true, mode: 'audit' },
      },
      p2pRounds: 3,
      p2pLocale: 'en',
    });
    expect(saveUserPrefMock).toHaveBeenCalledWith('p2p_combo_direct_send_skip_confirm', true);

    input.textContent = 'second combo';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /^team$/i }));
    fireEvent.click(screen.getByText(/mode_audit→mode_review→mode_plan/i));

    expect(screen.queryByText('combo_send_confirm_title')).toBeNull();
    expectLastSendPayload(ws, {
      sessionName: 'my-session',
      text: 'second combo',
      p2pAtTargets: [
        { session: '__all__', mode: 'config' },
      ],
      p2pMode: 'audit>review>plan',
      p2pSessionConfig: {
        deck_sub_abc: { enabled: true, mode: 'audit' },
      },
      p2pRounds: 3,
      p2pLocale: 'en',
    });
  });

  it('clicking a combo dropdown item sends immediately once confirmation is accepted', async () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    await flushAsync();

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'direct combo';
    fireEvent.input(input);

    fireEvent.click(screen.getByRole('button', { name: /^team$/i }));
    fireEvent.click(screen.getByText(/mode_audit→mode_review→mode_plan/i));

    const dialog = screen.getByText('combo_send_confirm_title').closest('.dialog') as HTMLElement;
    fireEvent.click(within(dialog).getByRole('button', { name: /^send$/i }));

    expectSendPayload(ws, {
      sessionName: 'my-session',
      text: 'direct combo',
      p2pAtTargets: [
        { session: '__all__', mode: 'config' },
      ],
      p2pMode: 'audit>review>plan',
      p2pSessionConfig: {
        deck_sub_abc: { enabled: true, mode: 'audit' },
      },
      p2pRounds: 3,
      p2pLocale: 'en',
    });
  });

  it('opens combo settings from the bottom of the solo combo dropdown', async () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: /^team$/i }));

    const menu = document.querySelector('.menu-dropdown-p2p') as HTMLElement;
    fireEvent.click(within(menu).getByRole('button', { name: 'settings_button' }));
    await flushAsync();

    expect(screen.getByText('+mode_brainstorm')).toBeDefined();
  });

  it('lists openspec changes and appends the selected reference to the input', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));

    expect(ws.fsListDir).toHaveBeenNthCalledWith(1, '/repo/openspec/changes', false, false);

    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'archive', path: '/repo/openspec/changes/archive', isDir: true, hidden: false },
        { name: 'change-b', path: '/repo/openspec/changes/change-b', isDir: true, hidden: false },
        { name: 'change-c', path: '/repo/openspec/changes/change-c', isDir: true, hidden: false },
        { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
        { name: 'README.md', path: '/repo/openspec/changes/README.md', isDir: false, hidden: false },
      ],
    });
    await flushAsync();

    const changeButton = screen.getByRole('button', { name: 'change-a' });
    expect(changeButton.textContent).toContain('@');
    expect(changeButton.textContent).not.toContain('1/2');
    expect(ws.fsListDir).toHaveBeenNthCalledWith(2, '/repo/openspec/changes', false, false, { includeOpenSpecTaskStats: true });

    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'change-b', path: '/repo/openspec/changes/change-b', isDir: true, hidden: false, openSpecTaskStats: { total: 3, checked: 3, unchecked: 0 } },
        { name: 'change-c', path: '/repo/openspec/changes/change-c', isDir: true, hidden: false, openSpecTaskStats: { total: 0, checked: 0, unchecked: 0 } },
        { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false, openSpecTaskStats: { total: 2, checked: 1, unchecked: 1 } },
      ],
    });
    await flushAsync();

    expect(changeButton.textContent).toContain('1/2');
    expect(screen.getByText('3/3')).toBeDefined();
    expect(screen.getByText('No tasks')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'archive' })).toBeNull();

    fireEvent.click(changeButton);

    expect(screen.getByRole('textbox').textContent).toBe('@openspec/changes/change-a');
  });

  it('renders cached OpenSpec task stats immediately while refreshing task stats in the background', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
      ],
    });
    await flushAsync();
    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false, openSpecTaskStats: { total: 2, checked: 1, unchecked: 1 } },
      ],
    });
    await flushAsync();

    expect(screen.getByRole('button', { name: 'change-a' }).textContent).toContain('1/2');

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    await flushAsync();

    expect(screen.getByRole('button', { name: 'change-a' }).textContent).toContain('1/2');
    expect(screen.getByText('loading')).toBeDefined();
    expect(ws.fsListDir).toHaveBeenLastCalledWith('/repo/openspec/changes', false, false);

    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
      ],
    });
    await flushAsync();

    expect(screen.getByRole('button', { name: 'change-a' }).textContent).toContain('1/2');
    expect(ws.fsListDir).toHaveBeenLastCalledWith('/repo/openspec/changes', false, false, { includeOpenSpecTaskStats: true });
  });

  it('opens Auto Deliver launcher from each openspec change row without inserting a prompt', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
      ],
    });
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));

    expect(screen.getByTestId('openspec-auto-launcher')).toBeDefined();
    expect(screen.getByText('Standard')).toBeDefined();
    expect(screen.getByRole('textbox').textContent).toBe('');

    fireEvent.click(screen.getByTestId('openspec-auto-preset-strict'));
    fireEvent.click(screen.getByRole('button', { name: 'Start Auto Deliver' }));

    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'openspec_auto_deliver.launch',
      serverId: 'srv-1',
      sessionName: 'my-session',
      changeName: 'change-a',
      presetId: 'strict',
      requestId: expect.any(String),
    }));
    expect(screen.getByRole('textbox').textContent).toBe('');
  });

  it('keeps Auto Deliver launch bound to OpenSpec changes while sending combo id and materialized limits', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    const input = screen.getByRole('textbox');
    input.textContent = 'raw requirement text should stay in chat and must not become an Auto Deliver launch source';
    fireEvent.input(input);

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
      ],
    });
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    const launcher = screen.getByTestId('openspec-auto-launcher');
    expect(within(launcher).getByTestId('openspec-auto-preset-fast')).toBeDefined();
    expect(within(launcher).getByTestId('openspec-auto-preset-standard')).toBeDefined();
    expect(within(launcher).getByTestId('openspec-auto-preset-strict')).toBeDefined();
    expect(within(launcher).getByTestId('openspec-auto-preset-deep')).toBeDefined();
    expect(within(launcher).queryByRole('textbox')).toBeNull();
    expect(within(launcher).getAllByRole('spinbutton')).toHaveLength(2);
    expect(within(launcher).getByRole('combobox')).toBeDefined();
    expect(within(launcher).queryByDisplayValue(/openspec_auto_deliver/i)).toBeNull();

    fireEvent.click(within(launcher).getByRole('button', { name: 'Start Auto Deliver' }));

    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'openspec_auto_deliver.launch',
      serverId: 'srv-1',
      sessionName: 'my-session',
      changeName: 'change-a',
      presetId: 'standard',
      selectedTeamComboId: 'audit>review>plan',
      materializedLimits: {
        specAuditRepairRounds: 1,
        implementationAuditRepairRounds: 2,
        maxImplementationPrompts: 12,
        maxElapsedMinutes: 480,
      },
      requestId: expect.any(String),
    }));
    expect(ws.send).not.toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('raw requirement text'),
    }));
    expect(input.textContent).toBe('raw requirement text should stay in chat and must not become an Auto Deliver launch source');
  });

  it('defaults the Auto Deliver Team combo to the audit-review-plan machine id', () => {
    const onLaunch = vi.fn();
    render(
      <OpenSpecAutoDeliverLauncher
        open
        changeName="change-a"
        onClose={vi.fn()}
        onLaunch={onLaunch}
      />,
    );

    const comboSelect = screen.getByRole('combobox') as HTMLSelectElement;
    expect(comboSelect.value).toBe('audit>review>plan');
    expect(within(comboSelect).getByRole('option', { name: 'mode_audit→mode_review→mode_plan' })).toBeDefined();
    expect(within(comboSelect).getByRole('option', { name: 'mode_brainstorm→mode_discuss→mode_plan' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Start Auto Deliver' }));
    expect(onLaunch).toHaveBeenCalledWith('change-a', 'standard', {
      selectedTeamComboId: 'audit>review>plan',
      autoCommitPush: false,
      materializedLimits: {
        specAuditRepairRounds: 1,
        implementationAuditRepairRounds: 2,
        maxImplementationPrompts: 12,
        maxElapsedMinutes: 480,
      },
    });
  });

  it('sends the persisted auto commit/push preference when the launcher checkbox is enabled', () => {
    const onLaunch = vi.fn();
    render(
      <OpenSpecAutoDeliverLauncher
        open
        changeName="change-a"
        onClose={vi.fn()}
        onLaunch={onLaunch}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Commit and push automatically after audit passes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start Auto Deliver' }));

    expect(onLaunch).toHaveBeenCalledWith('change-a', 'standard', expect.objectContaining({
      selectedTeamComboId: 'audit>review>plan',
      autoCommitPush: true,
    }));
  });

  it('keeps numeric controls editable after preset quick setters and launches custom exact limits', () => {
    const onLaunch = vi.fn();
    render(
      <OpenSpecAutoDeliverLauncher
        open
        changeName="change-a"
        onClose={vi.fn()}
        onLaunch={onLaunch}
      />,
    );

    fireEvent.click(screen.getByTestId('openspec-auto-preset-fast'));
    expect(screen.getByText('Spec audit-repair 0 · Implementation audit-repair 1')).toBeDefined();

    const [specRounds, implementationRounds] = screen.getAllByRole('spinbutton') as HTMLInputElement[];
    fireEvent.input(specRounds!, { target: { value: '3' } });
    fireEvent.input(implementationRounds!, { target: { value: '5' } });

    expect((specRounds as HTMLInputElement).value).toBe('3');
    expect((implementationRounds as HTMLInputElement).value).toBe('5');
    expect(screen.getByText('Spec audit-repair 3 · Implementation audit-repair 5')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Start Auto Deliver' }));
    expect(onLaunch).toHaveBeenCalledWith('change-a', 'custom', {
      selectedTeamComboId: 'audit>review>plan',
      autoCommitPush: false,
      materializedLimits: {
        specAuditRepairRounds: 3,
        implementationAuditRepairRounds: 5,
        maxImplementationPrompts: 12,
        maxElapsedMinutes: 480,
      },
    });
  });

  it('lists saved custom Team combos and launches Auto Deliver with the selected flow', async () => {
    const onLaunch = vi.fn();
    render(
      <OpenSpecAutoDeliverLauncher
        open
        changeName="change-a"
        onClose={vi.fn()}
        onLaunch={onLaunch}
      />,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent('imcodes:user-pref-changed', {
        detail: { key: 'p2p_custom_combos', value: JSON.stringify(['audit>plan']) },
      }));
    });

    const comboSelect = screen.getByRole('combobox') as HTMLSelectElement;
    await waitFor(() => expect(within(comboSelect).getByRole('option', { name: 'mode_audit→mode_plan (Custom)' })).toBeDefined());
    expect(within(comboSelect).queryByRole('option', { name: 'audit>plan (Custom)' })).toBeNull();
    fireEvent.change(comboSelect, { target: { value: 'audit>plan' } });

    expect(screen.queryByTestId('openspec-auto-combo-warning')).toBeNull();
    expect((screen.getByRole('button', { name: 'Start Auto Deliver' }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Start Auto Deliver' }));
    expect(onLaunch).toHaveBeenCalledWith('change-a', 'standard', {
      selectedTeamComboId: 'audit>plan',
      autoCommitPush: false,
      materializedLimits: {
        specAuditRepairRounds: 1,
        implementationAuditRepairRounds: 2,
        maxImplementationPrompts: 12,
        maxElapsedMinutes: 480,
      },
    });
  });

  it('shows local Auto Deliver launch validation when no change is selected', () => {
    render(
      <OpenSpecAutoDeliverLauncher
        open
        changeName={null}
        onClose={vi.fn()}
        onLaunch={vi.fn()}
      />,
    );

    expect(screen.getByTestId('openspec-auto-error').textContent).toBe('Select a change first');
    expect((screen.getByRole('button', { name: 'Start Auto Deliver' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the Auto Deliver launcher open and renders Team-busy launch errors', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
      ],
    });
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start Auto Deliver' }));
    ws.emit({
      type: 'openspec_auto_deliver.launch_error',
      error: 'team_lane_busy',
    });
    await flushAsync();

    expect(screen.getByTestId('openspec-auto-launcher')).toBeDefined();
    expect(screen.getByText('Manual Team is busy')).toBeDefined();
    expect(screen.queryByTestId('openspec-auto-details')).toBeNull();
  });

  it('keeps the Auto Deliver launcher open and renders unsupported-runtime launch errors', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'my-session',
          projectDir: '/repo',
          agentType: 'codex',
          runtimeType: 'process',
        })}
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
      ],
    });
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start Auto Deliver' }));
    ws.emit({
      type: 'openspec_auto_deliver.launch_error',
      error: 'transport_runtime_required',
    });
    await flushAsync();

    expect(screen.getByTestId('openspec-auto-launcher')).toBeDefined();
    expect(screen.getByText('Unsupported runtime')).toBeDefined();
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'openspec_auto_deliver.launch',
      changeName: 'change-a',
      presetId: 'standard',
    }));
  });

  it('opens Auto Deliver details after a matching launch ack projection', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
      ],
    });
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start Auto Deliver' }));
    ws.emit({
      type: 'openspec_auto_deliver.launch_ack',
      projection: {
        runId: 'auto-ack',
        projectionVersion: 1,
        visibility: 'full',
        changeName: 'change-a',
        status: 'spec_audit_repair',
        stage: 'spec_audit_repair',
        taskStats: { total: 2, checked: 1, unchecked: 1 },
      },
    });
    await flushAsync();

    await waitFor(() => {
      expect(screen.queryByTestId('openspec-auto-launcher')).toBeNull();
      expect(screen.getByTestId('openspec-auto-details')).toBeDefined();
    });
  });

  it('renders Auto Deliver projections, ignores stale updates, and locks manual Team/OpenSpec actions', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
      />,
    );

    ws.emit({
      type: 'openspec_auto_deliver.projection',
      projection: {
        runId: 'auto-1',
        projectionVersion: 2,
        visibility: 'full',
        changeName: 'change-a',
        launchedFromSessionName: 'my-session',
        targetImplementationSessionName: 'my-session',
        status: 'implementation_task_loop',
        stage: 'implementation_task_loop',
        selectedTeamComboId: 'audit>review>plan',
        startedAt: Date.now() - 1000,
        taskStats: { total: 4, checked: 2, unchecked: 2 },
        implementationPromptCount: 3,
        canStop: true,
        recentFinding: 'fresh finding',
      },
    });
    await flushAsync();

    ws.emit({
      type: 'openspec_auto_deliver.projection',
      projection: {
        runId: 'auto-1',
        projectionVersion: 1,
        visibility: 'full',
        changeName: 'old-change',
        status: 'spec_audit_repair',
        stage: 'spec_audit_repair',
        taskStats: { total: 1, checked: 0, unchecked: 1 },
        recentFinding: 'stale finding',
      },
    });
    await flushAsync();

    expect(screen.queryByTestId('openspec-auto-runbar')).toBeNull();
    expect(screen.queryByText('old-change')).toBeNull();

    const teamButton = screen.getByRole('button', { name: /^team$/i });
    expect((teamButton as HTMLButtonElement).disabled).toBe(true);
    expect(teamButton.getAttribute('title')).toBe('Auto Deliver owns Team lane');

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
      ],
    });
    await flushAsync();

    expect(screen.getByText('Current Auto Deliver')).toBeDefined();
    const auditButton = screen.getByRole('button', { name: 'audit_action' }) as HTMLButtonElement;
    const achieveButton = screen.getByRole('button', { name: 'achieve_action' }) as HTMLButtonElement;
    expect(auditButton.disabled).toBe(true);
    expect(auditButton.getAttribute('title')).toBe('Auto Deliver owns Team lane');
    expect((screen.getByRole('button', { name: 'implement_action' }) as HTMLButtonElement).disabled).toBe(true);
    expect(achieveButton.disabled).toBe(true);
    expect(achieveButton.getAttribute('title')).toBe('Auto Deliver owns Team lane');
    expect((screen.getByRole('button', { name: 'propose_action' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(auditButton);
    fireEvent.click(achieveButton);
    expect(screen.queryByRole('button', { name: 'audit_implementation_action' })).toBeNull();
    expect(gatherSendCalls(ws)).toEqual([]);
    expect(screen.getByRole('textbox').textContent).toBe('');

    fireEvent.click(screen.getAllByRole('button', { name: 'View' })[0]);
    const details = screen.getByTestId('openspec-auto-details');
    expect(details).toBeDefined();
    expect(within(details).getByText('change-a')).toBeDefined();
    expect(within(details).getByText('mode_audit→mode_review→mode_plan')).toBeDefined();
    expect(within(details).queryByText('audit>review>plan')).toBeNull();
    expect(within(details).getByText('fresh finding')).toBeDefined();
  });

  it('renders redacted Auto Deliver conflict entries without details actions', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'sibling-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
      />,
    );

    ws.emit({
      type: 'openspec_auto_deliver.projection',
      projection: {
        runId: 'auto-conflict',
        projectionVersion: 1,
        visibility: 'conflict',
        changeName: 'change-a',
        status: 'implementation_task_loop',
        stage: 'implementation_task_loop',
        owningMainSessionName: 'deck_main',
        conflictReason: 'Owned by another visible session',
      },
    });
    await flushAsync();

    expect(screen.queryByTestId('openspec-auto-runbar')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    await flushAsync();

    const entry = screen.getByTestId('openspec-auto-conflict-entry');
    expect(within(entry).getByText('Owned by another visible session')).toBeDefined();
    expect(within(entry).getByText('Details are visible only in participating sessions.')).toBeDefined();
    expect(within(entry).queryByRole('button', { name: 'View' })).toBeNull();
  });

  it('renders Auto Deliver run state in a participating sub-session', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'deck_sub_worker-alpha',
          projectDir: '/repo',
          agentType: 'codex',
        })}
        subSessions={[
          { sessionName: 'deck_sub_worker-alpha', type: 'codex', label: 'Worker Alpha', state: 'idle', parentSession: 'deck_main' },
        ]}
        quickData={makeQuickData() as any}
      />,
    );

    ws.emit({
      type: 'openspec_auto_deliver.projection',
      projection: {
        runId: 'auto-sub',
        projectionVersion: 1,
        visibility: 'full',
        changeName: 'change-sub',
        status: 'implementation_task_loop',
        stage: 'implementation_task_loop',
        owningMainSessionName: 'deck_main',
        targetImplementationSessionName: 'deck_sub_worker-alpha',
        taskStats: { total: 3, checked: 2, unchecked: 1 },
        canStop: true,
      },
    });
    await flushAsync();

    expect(screen.queryByTestId('openspec-auto-runbar')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    await flushAsync();

    const entry = screen.getByTestId('openspec-auto-current-entry');
    expect(within(entry).getByText('change-sub')).toBeDefined();
    expect(within(entry).getByText('deck_main → deck_sub_worker-alpha')).toBeDefined();
  });

  it('translates Auto Deliver terminal reasons and evidence codes in details', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
      />,
    );

    ws.emit({
      type: 'openspec_auto_deliver.projection',
      projection: {
        runId: 'auto-i18n',
        projectionVersion: 1,
        visibility: 'full',
        changeName: 'change-i18n',
        launchedFromSessionName: 'my-session',
        targetImplementationSessionName: 'my-session',
        status: 'needs_human',
        stage: 'needs_human',
        terminalReason: 'missing_authoritative_json',
        recentFinding: 'missing_authoritative_json',
        evidence: [{ label: 'strict result', summary: 'missing_authoritative_json' }],
        taskStats: { total: 84, checked: 84, unchecked: 0 },
      },
    });
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    await flushAsync();
    fireEvent.click(within(screen.getByTestId('openspec-auto-current-entry')).getByRole('button', { name: 'View' }));
    expect(screen.getByTestId('openspec-auto-details')).toBeDefined();
    const translated = screen.getAllByText('The audit did not produce a final authoritative JSON result.');
    expect(translated.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('missing_authoritative_json')).toBeNull();
  });

  it('opens an openspec change folder in the file browser and can insert files from it', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'archive', path: '/repo/openspec/changes/archive', isDir: true, hidden: false },
        { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
      ],
    });
    await flushAsync();

    expect(screen.queryByRole('button', { name: 'archive' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'pinned_repo' }));

    const browser = await screen.findByTestId('mock-file-browser');
    expect(browser.getAttribute('data-initial-path')).toBe('/repo/openspec/changes/change-a');
    expect(browser.getAttribute('data-mode')).toBe('file-multi');
    expect(browser.getAttribute('data-default-tab')).toBe('files');
    expect(browser.getAttribute('data-changes-root-path')).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'mock-file-confirm' }));

    expect(screen.getByRole('textbox').textContent).toBe('@openspec/changes/change-a/proposal.md');
    expect(screen.queryByTestId('mock-file-browser')).toBeNull();
  });

  it('does not leave openspec changes loading when the list request cannot be sent', async () => {
    const ws = makeWs();
    ws.fsListDir.mockImplementation(() => {
      throw new Error('WebSocket not connected');
    });
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));

    expect(screen.queryByText('loading')).toBeNull();
    expect(screen.getByText('openspec_unavailable')).toBeDefined();
    expect(screen.getByRole('button', { name: 'propose_action' })).toBeDefined();
  });

  it('times out openspec changes loading if the daemon never responds', async () => {
    vi.useFakeTimers();
    try {
      const ws = makeWs();
      render(
        <SessionControls
          ws={ws as any}
          activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
          quickData={makeQuickData() as any}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
      expect(screen.getByText('loading')).toBeDefined();

      await act(async () => {
        vi.advanceTimersByTime(OPENSPEC_LIST_REQUEST_TIMEOUT_MS);
      });

      expect(screen.queryByText('loading')).toBeNull();
      expect(screen.getByText('openspec_timeout')).toBeDefined();
      expect(screen.getByRole('button', { name: 'propose_action' })).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('inserts an openspec implementation-audit prompt without sending immediately', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
      ],
    });
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: 'audit_action' }));
    fireEvent.click(screen.getByRole('button', { name: 'audit_implementation_action' }));

    expect(screen.getByRole('textbox').textContent).toBe('audit implementation @openspec/changes/change-a, fix code gaps and update openspec files');
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
  });

  it('inserts an openspec spec-audit prompt without sending immediately', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
      ],
    });
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: 'audit_action' }));
    fireEvent.click(screen.getByRole('button', { name: 'audit_spec_action' }));

    expect(screen.getByRole('textbox').textContent).toBe('audit spec @openspec/changes/change-a, update proposal design specs and tasks');
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
  });

  it('inserts an openspec implement prompt without sending immediately', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
      ],
    });
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: 'implement_action' }));

    expect(screen.getByRole('textbox').textContent).toBe('implement @openspec/changes/change-a, keep openspec artifacts aligned while coding');
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
  });

  it('sends an openspec achieve prompt directly', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
      ],
    });
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: 'achieve_action' }));

    expectSendPayload(ws, {
      sessionName: 'my-session',
      text: 'complete @openspec/changes/change-a, update proposal design specs tasks and archive if done',
    });
  });

  it('inserts an openspec propose-from-discussion prompt without sending immediately', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    fireEvent.click(screen.getByRole('button', { name: 'propose_action' }));
    fireEvent.click(screen.getByRole('button', { name: 'propose_from_discussion_action' }));

    expect(screen.getByRole('textbox').textContent).toBe('generate openspec change from recent discussion and write proposal design specs tasks');
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
  });

  it('inserts an openspec propose-from-description prompt without sending immediately', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    fireEvent.click(screen.getByRole('button', { name: 'propose_action' }));
    fireEvent.click(screen.getByRole('button', { name: 'propose_from_description_action' }));

    expect(screen.getByRole('textbox').textContent).toBe('generate openspec change from description below and write proposal design specs tasks');
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
  });

  it('OpenSpec Execute dropdown pins the saved template, lists eligible sessions, sets/clears the preference, and dispatches the OpenSpec prompt to the chosen session', async () => {
    const ws = makeWs();
    // Saved per-project execution template for serverId "srv-exec" → the worker
    // sub-session "deck_sub_pinned". The dropdown must PIN it first.
    getUserPrefMock.mockImplementation(async (key: unknown) => {
      if (key === 'exec_routing.template:srv-exec') return 'deck_sub_pinned';
      return null;
    });

    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        serverId="srv-exec"
        sessions={[
          makeSession({ name: 'my-session', role: 'w1', agentType: 'codex' }),
          // Main/brain session is excluded from the Execute selector.
          mainSession,
        ]}
        subSessions={[
          { sessionName: 'deck_sub_pinned', type: 'codex', label: 'pinned', state: 'idle', parentSession: 'my-session', executionTemplateEligible: true },
          { sessionName: 'deck_sub_other', type: 'codex', label: 'other', state: 'idle', parentSession: 'my-session', executionTemplateEligible: true },
          // Ineligible sub-session — must NOT appear.
          { sessionName: 'deck_sub_blocked', type: 'codex', label: 'blocked', state: 'idle', parentSession: 'my-session', executionTemplateEligible: false },
        ]}
        quickData={makeQuickData() as any}
      />,
    );
    await flushAsync();

    // Open the OpenSpec panel with a single change. Execute is now a per-change
    // row action, so the trigger lives inside that change's row.
    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
      ],
    });
    await flushAsync();

    // Open the change row's Execute dropdown (per-change trigger + menu).
    const row = screen.getByTestId('openspec-change-row-change-a');
    fireEvent.click(within(row).getByTestId('openspec-execute-trigger-change-a'));
    const menu = screen.getByTestId('openspec-execute-menu-change-a');

    // Pinned saved template appears FIRST as a dispatch item.
    const pinned = within(menu).getByTestId('openspec-execute-pinned');
    expect(pinned).toBeDefined();
    const dispatchButtons = menu.querySelectorAll('[data-testid^="openspec-execute-session-"], [data-testid="openspec-execute-pinned"]');
    expect(dispatchButtons[0]).toBe(pinned);

    // Eligible non-current/non-main sessions are listed; the pinned one is not
    // duplicated below, and the ineligible/main sessions are excluded.
    expect(within(menu).getByTestId('openspec-execute-session-deck_sub_other')).toBeDefined();
    expect(within(menu).queryByTestId('openspec-execute-session-deck_sub_pinned')).toBeNull();
    expect(within(menu).queryByTestId('openspec-execute-session-deck_sub_blocked')).toBeNull();
    expect(within(menu).queryByTestId('openspec-execute-session-deck_my-project_brain')).toBeNull();

    // Choosing the pinned session dispatches THIS change's OpenSpec implement
    // prompt to it (and closes the panel). Cross-session routing must NOT inject
    // into the composer.
    fireEvent.click(pinned);
    expect(ws.sendSessionMessage).toHaveBeenCalledWith(
      'deck_sub_pinned',
      'implement @openspec/changes/change-a, keep openspec artifacts aligned while coding',
    );
    expect(screen.getByRole('textbox').textContent).toBe('');

    // Re-open the OpenSpec panel, then the row's Execute submenu, and set a
    // DIFFERENT session as the shared default → persists the SAME per-project
    // execution-template preference (no OpenSpec-only key).
    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
      ],
    });
    await flushAsync();
    fireEvent.click(within(screen.getByTestId('openspec-change-row-change-a')).getByTestId('openspec-execute-trigger-change-a'));
    fireEvent.click(screen.getByTestId('openspec-execute-set-deck_sub_other'));
    await flushAsync();
    expect(saveUserPrefMock).toHaveBeenCalledWith('exec_routing.template:srv-exec', 'deck_sub_other');

    // Re-open the Execute submenu and CLEAR the default (allowed HERE, unlike
    // the generic dropdown) → writes the empty sentinel to the SAME key.
    fireEvent.click(within(screen.getByTestId('openspec-change-row-change-a')).getByTestId('openspec-execute-trigger-change-a'));
    fireEvent.click(screen.getByTestId('openspec-execute-clear'));
    await flushAsync();
    expect(saveUserPrefMock).toHaveBeenCalledWith('exec_routing.template:srv-exec', '');
  });

  it('OpenSpec Execute dropdown dispatches to a non-default eligible session for the current change', async () => {
    const ws = makeWs();
    getUserPrefMock.mockResolvedValue(null); // no saved default

    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        serverId="srv-exec"
        sessions={[makeSession({ name: 'my-session', role: 'w1', agentType: 'codex' })]}
        subSessions={[
          { sessionName: 'deck_sub_worker', type: 'codex', label: 'worker', state: 'idle', parentSession: 'my-session', executionTemplateEligible: true },
        ]}
        quickData={makeQuickData() as any}
      />,
    );
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'change-z', path: '/repo/openspec/changes/change-z', isDir: true, hidden: false },
      ],
    });
    await flushAsync();

    const row = screen.getByTestId('openspec-change-row-change-z');
    fireEvent.click(within(row).getByTestId('openspec-execute-trigger-change-z'));
    const menu = screen.getByTestId('openspec-execute-menu-change-z');
    // No saved default → no pinned item.
    expect(within(menu).queryByTestId('openspec-execute-pinned')).toBeNull();

    fireEvent.click(within(menu).getByTestId('openspec-execute-session-deck_sub_worker'));
    expect(ws.sendSessionMessage).toHaveBeenCalledWith(
      'deck_sub_worker',
      'implement @openspec/changes/change-z, keep openspec artifacts aligned while coding',
    );
  });

  it('shows openspec propose even when there are no existing changes', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [],
    });
    await flushAsync();

    expect(screen.getByRole('button', { name: 'propose_action' })).toBeDefined();
  });

  it('limits openspec dropdown height to the visible space above the trigger', async () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function mockRect() {
      const el = this as HTMLElement;
      if (el.getAttribute('title') === 'OpenSpec changes') {
        return {
          x: 0, y: 0, top: 220, left: 0, right: 120, bottom: 252, width: 120, height: 32,
          toJSON() { return {}; },
        } as DOMRect;
      }
      return {
        x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
        toJSON() { return {}; },
      } as DOMRect;
    });

    const innerWidth = window.innerWidth;
    const innerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    try {
      const ws = makeWs();
      render(
        <SessionControls
          ws={ws as any}
          activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
          quickData={makeQuickData() as any}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /openspec/i }));

      const dropdown = document.querySelector('.menu-dropdown-openspec') as HTMLElement;
      expect(dropdown.style.position).toBe('fixed');
      expect(dropdown.style.bottom).toBe('584px');
      expect(dropdown.style.maxHeight).toBe('208px');
    } finally {
      rectSpy.mockRestore();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
    }
  });

  it('raises openspec dropdowns above surrounding cards on desktop', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
      ],
    });
    await flushAsync();

    const dropdown = document.querySelector('.menu-dropdown-openspec') as HTMLElement;
    expect(dropdown).toBeTruthy();
    expect(dropdown.style.position).toBe('fixed');
    expect(dropdown.style.zIndex).toBe('2147483646');

    fireEvent.click(screen.getByRole('button', { name: 'audit_action' }));

    const submenu = document.querySelector('.openspec-submenu') as HTMLElement;
    expect(submenu).toBeTruthy();
    expect(submenu.style.position).toBe('fixed');
    expect(submenu.style.zIndex).toBe('2147483647');
    expect(within(submenu).getByRole('button', { name: 'audit_implementation_action' })).toBeDefined();
    expect(within(submenu).getByRole('button', { name: 'audit_spec_action' })).toBeDefined();
  });

  it('keeps the desktop openspec audit submenu open when clicking inside the portal submenu', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
    ws.emit({
      type: 'fs.ls_response',
      requestId: 'openspec-request',
      status: 'ok',
      resolvedPath: '/repo/openspec/changes',
      entries: [
        { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
      ],
    });
    await flushAsync();

    fireEvent.click(screen.getByRole('button', { name: 'audit_action' }));

    const submenu = document.querySelector('.openspec-submenu') as HTMLElement;
    expect(submenu).toBeTruthy();

    fireEvent.mouseDown(within(submenu).getByRole('button', { name: 'audit_implementation_action' }));

    expect(document.querySelector('.openspec-submenu')).toBeTruthy();
    expect(screen.getByRole('button', { name: /openspec/i })).toBeDefined();
  });

  it('collapses openspec actions behind a disclosure toggle on mobile', async () => {
    const innerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });

    try {
      const ws = makeWs();
      render(
        <SessionControls
          ws={ws as any}
          activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
          quickData={makeQuickData() as any}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
      ws.emit({
        type: 'fs.ls_response',
        requestId: 'openspec-request',
        status: 'ok',
        resolvedPath: '/repo/openspec/changes',
        entries: [
          { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
        ],
      });
      await flushAsync();

      expect(screen.queryByRole('button', { name: 'implement_action' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'expand change-a' }));

      expect(screen.getByRole('button', { name: 'implement_action' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'collapse change-a' })).toBeDefined();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
    }
  });

  it('keeps the OpenSpec Auto Deliver launcher outside the mobile change-list scroller', async () => {
    const innerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });

    try {
      const ws = makeWs();
      render(
        <SessionControls
          ws={ws as any}
          activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
          quickData={makeQuickData() as any}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
      ws.emit({
        type: 'fs.ls_response',
        requestId: 'openspec-request',
        status: 'ok',
        resolvedPath: '/repo/openspec/changes',
        entries: [
          { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
          { name: 'change-b', path: '/repo/openspec/changes/change-b', isDir: true, hidden: false },
          { name: 'change-c', path: '/repo/openspec/changes/change-c', isDir: true, hidden: false },
        ],
      });
      await flushAsync();

      fireEvent.click(screen.getByRole('button', { name: 'expand change-a' }));
      fireEvent.click(screen.getByRole('button', { name: 'Auto' }));

      const launcher = screen.getByTestId('openspec-auto-launcher');
      const mobileSheet = document.querySelector('.menu-dropdown-openspec-inline') as HTMLElement;
      const scrollArea = document.querySelector('.openspec-dropdown-scroll') as HTMLElement;
      expect(launcher).toBeDefined();
      expect(mobileSheet).toBeTruthy();
      expect(scrollArea).toBeTruthy();
      expect(scrollArea.contains(launcher)).toBe(false);
      expect(launcher.parentElement).toBe(mobileSheet);
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
    }
  });

  it('anchors the openspec audit submenu to the audit button on mobile', async () => {
    const innerWidth = window.innerWidth;
    const innerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function mockRect() {
      const el = this as HTMLElement;
      if (el.classList?.contains('shortcuts-model')) {
        return {
          x: 250, y: 0, top: 720, left: 250, right: 360, bottom: 752, width: 110, height: 32,
          toJSON() { return {}; },
        } as DOMRect;
      }
      if (el.textContent?.trim() === 'audit_action') {
        return {
          x: 260, y: 0, top: 648, left: 260, right: 328, bottom: 676, width: 68, height: 28,
          toJSON() { return {}; },
        } as DOMRect;
      }
      return {
        x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
        toJSON() { return {}; },
      } as DOMRect;
    });

    try {
      const ws = makeWs();
      render(
        <SessionControls
          ws={ws as any}
          activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
          quickData={makeQuickData() as any}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
      ws.emit({
        type: 'fs.ls_response',
        requestId: 'openspec-request',
        status: 'ok',
        resolvedPath: '/repo/openspec/changes',
        entries: [
          { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
        ],
      });
      await flushAsync();

      fireEvent.click(screen.getByRole('button', { name: 'expand change-a' }));
      fireEvent.click(screen.getByRole('button', { name: 'audit_action' }));

      const submenu = document.querySelector('.openspec-submenu') as HTMLElement;
      expect(submenu).toBeTruthy();
      expect(submenu.className).toContain('openspec-submenu-inline');
      expect(within(submenu).getByRole('button', { name: 'audit_implementation_action' })).toBeDefined();
      expect(within(submenu).getByRole('button', { name: 'audit_spec_action' })).toBeDefined();
    } finally {
      rectSpy.mockRestore();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
    }
  });

  it('renders the openspec change list inline in compact mobile mode', async () => {
    const innerWidth = window.innerWidth;
    const innerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function mockRect() {
      const el = this as HTMLElement;
      if (el.classList?.contains('shortcuts-model')) {
        return {
          x: 300, y: 0, top: 708, left: 300, right: 372, bottom: 740, width: 72, height: 32,
          toJSON() { return {}; },
        } as DOMRect;
      }
      if (el.getAttribute('title') === 'OpenSpec changes') {
        return {
          x: 314, y: 0, top: 708, left: 314, right: 372, bottom: 740, width: 58, height: 32,
          toJSON() { return {}; },
        } as DOMRect;
      }
      return {
        x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
        toJSON() { return {}; },
      } as DOMRect;
    });

    try {
      const ws = makeWs();
      render(
        <SessionControls
          ws={ws as any}
          activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
          quickData={makeQuickData() as any}
          compact={true}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
      ws.emit({
        type: 'fs.ls_response',
        requestId: 'openspec-request',
        status: 'ok',
        resolvedPath: '/repo/openspec/changes',
        entries: [
          { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
        ],
      });
      await flushAsync();

      const dropdown = document.querySelector('.menu-dropdown-openspec') as HTMLElement;
      expect(dropdown).toBeTruthy();
      expect(dropdown.className).toContain('menu-dropdown-openspec-inline');
      expect(dropdown.style.position).toBe('');
      expect(within(dropdown).getByRole('button', { name: 'change-a' })).toBeDefined();
    } finally {
      rectSpy.mockRestore();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
    }
  });

  it('renders the openspec change list inline on mobile for the main session', async () => {
    const innerWidth = window.innerWidth;
    const innerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });

    try {
      const ws = makeWs();
      render(
        <SessionControls
          ws={ws as any}
          activeSession={makeSession({ name: 'main-session', projectDir: '/repo', agentType: 'codex' })}
          quickData={makeQuickData() as any}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
      ws.emit({
        type: 'fs.ls_response',
        requestId: 'openspec-request',
        status: 'ok',
        resolvedPath: '/repo/openspec/changes',
        entries: [
          { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
        ],
      });
      await flushAsync();

      const dropdown = document.querySelector('.menu-dropdown-openspec') as HTMLElement;
      expect(dropdown).toBeTruthy();
      expect(dropdown.className).toContain('menu-dropdown-openspec-inline');
      expect(within(dropdown).getByRole('button', { name: 'change-a' })).toBeDefined();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
    }
  });

  it('anchors the openspec propose submenu to the propose button on mobile', async () => {
    const innerWidth = window.innerWidth;
    const innerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function mockRect() {
      const el = this as HTMLElement;
      if (el.classList?.contains('shortcuts-model')) {
        return {
          x: 250, y: 0, top: 720, left: 250, right: 360, bottom: 752, width: 110, height: 32,
          toJSON() { return {}; },
        } as DOMRect;
      }
      if (el.textContent?.trim() === 'propose_action') {
        return {
          x: 265, y: 0, top: 662, left: 265, right: 375, bottom: 694, width: 110, height: 32,
          toJSON() { return {}; },
        } as DOMRect;
      }
      return {
        x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
        toJSON() { return {}; },
      } as DOMRect;
    });

    try {
      const ws = makeWs();
      render(
        <SessionControls
          ws={ws as any}
          activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
          quickData={makeQuickData() as any}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
      ws.emit({
        type: 'fs.ls_response',
        requestId: 'openspec-request',
        status: 'ok',
        resolvedPath: '/repo/openspec/changes',
        entries: [],
      });
      await flushAsync();

      fireEvent.click(screen.getByRole('button', { name: 'propose_action' }));

      const submenu = document.querySelector('.openspec-submenu') as HTMLElement;
      expect(submenu).toBeTruthy();
      expect(submenu.className).toContain('openspec-submenu-inline');
      expect(within(submenu).getByRole('button', { name: 'propose_from_discussion_action' })).toBeDefined();
      expect(within(submenu).getByRole('button', { name: 'propose_from_description_action' })).toBeDefined();
    } finally {
      rectSpy.mockRestore();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
    }
  });

  it('opens the openspec audit submenu below the trigger when the trigger is high in the viewport', async () => {
    const innerWidth = window.innerWidth;
    const innerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function mockRect() {
      const el = this as HTMLElement;
      if (el.classList?.contains('shortcuts-model')) {
        return {
          x: 250, y: 0, top: 720, left: 250, right: 360, bottom: 752, width: 110, height: 32,
          toJSON() { return {}; },
        } as DOMRect;
      }
      if (el.textContent?.trim() === 'audit_action') {
        return {
          x: 248, y: 0, top: 92, left: 248, right: 328, bottom: 120, width: 80, height: 28,
          toJSON() { return {}; },
        } as DOMRect;
      }
      return {
        x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
        toJSON() { return {}; },
      } as DOMRect;
    });

    try {
      const ws = makeWs();
      render(
        <SessionControls
          ws={ws as any}
          activeSession={makeSession({ name: 'my-session', projectDir: '/repo', agentType: 'codex' })}
          quickData={makeQuickData() as any}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /openspec/i }));
      ws.emit({
        type: 'fs.ls_response',
        requestId: 'openspec-request',
        status: 'ok',
        resolvedPath: '/repo/openspec/changes',
        entries: [
          { name: 'change-a', path: '/repo/openspec/changes/change-a', isDir: true, hidden: false },
        ],
      });
      await flushAsync();

      fireEvent.click(screen.getByRole('button', { name: 'expand change-a' }));
      fireEvent.click(screen.getByRole('button', { name: 'audit_action' }));

      const submenu = document.querySelector('.openspec-submenu') as HTMLElement;
      expect(submenu).toBeTruthy();
      expect(submenu.className).toContain('openspec-submenu-inline');
      expect(within(submenu).getByRole('button', { name: 'audit_implementation_action' })).toBeDefined();
    } finally {
      rectSpy.mockRestore();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
    }
  });

  it('clears input after send', () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'hello world';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(input.textContent).toBe('');
  });

  it('ignores legacy pendingMessages when pending entries are empty', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          runtimeType: 'transport',
          transportPendingMessages: ['queued first', 'queued second'],
          transportPendingMessageEntries: [],
        })}
        quickData={makeQuickData() as any}
      />,
    );

    expect(document.querySelector('.controls-queued-hint')).toBeFalsy();
    expect(screen.queryByText('queued first')).toBeNull();
    expect(screen.queryByText('queued second')).toBeNull();
  });

  it('does not resurrect stale pendingMessages when a versioned empty entries snapshot is present', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          runtimeType: 'transport',
          transportPendingMessages: ['stale queued'],
          transportPendingMessageEntries: [],
          transportPendingMessageVersion: 12,
        })}
        quickData={makeQuickData() as any}
      />,
    );

    expect(document.querySelector('.controls-queued-hint')).toBeFalsy();
    expect(screen.queryByText('stale queued')).toBeNull();
  });

  it('does not create or clear a queued card from legacy pendingMessages', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'qwen-session',
          runtimeType: 'transport',
          state: 'running',
          transportPendingMessages: ['legacy stale send'],
          transportPendingMessageEntries: [],
        })}
        quickData={makeQuickData() as any}
      />,
    );

    expect(screen.queryByText('legacy stale send')).toBeNull();

    act(() => {
      ws.emit({
        type: 'timeline.event',
        event: {
          eventId: 'transport-user:real-command-id',
          sessionId: 'qwen-session',
          type: 'user.message',
          ts: Date.now(),
          seq: 1,
          epoch: 1,
          source: 'daemon',
          confidence: 'high',
          payload: { text: 'legacy stale send', commandId: 'real-command-id' },
        },
      });
    });

    expect(screen.queryByText('legacy stale send')).toBeNull();
  });

  it('clears the queued card when a drained user.message carries commandId != clientMessageId (recovery drain)', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'qwen-session',
          runtimeType: 'transport',
          state: 'running',
          transportPendingMessages: ['commit&push'],
          transportPendingMessageEntries: [{ clientMessageId: 'cmid-1', text: 'commit&push' }],
          transportPendingMessageVersion: 1,
        })}
        quickData={makeQuickData() as any}
      />,
    );
    expect(screen.getByText('commit&push')).toBeDefined();

    act(() => {
      ws.emit({
        type: 'timeline.event',
        event: {
          eventId: 'transport-user:cmid-1',
          sessionId: 'qwen-session',
          type: 'user.message',
          ts: Date.now(),
          seq: 1,
          epoch: 1,
          source: 'daemon',
          confidence: 'high',
          // Recovery/resend drain shape: BOTH ids, commandId != clientMessageId.
          // Settling only commandId (the regression) left the card up.
          payload: { text: 'commit&push', commandId: 'daemon-cmd-xyz', clientMessageId: 'cmid-1', pendingMessageVersion: 2 },
        },
      });
    });

    expect(screen.queryByText('commit&push')).toBeNull();
  });

  it('suppresses a stale editable queue card from the materialized timeline after a live queue frame is missed', () => {
    const ws = makeWs();
    const activeSession = makeSession({
      name: 'qwen-session',
      runtimeType: 'transport',
      state: 'running',
      transportPendingMessageEntries: [{ clientMessageId: 'queued-before-drain', text: 'old queued text' }],
      transportPendingMessageVersion: 8,
    });
    const { rerender } = render(
      <SessionControls
        ws={ws as any}
        activeSession={activeSession}
        quickData={makeQuickData() as any}
      />,
    );
    expect(screen.getByText('old queued text')).toBeDefined();

    // The sub-session timeline has already materialized the daemon's delivery,
    // but the parent SessionInfo is intentionally stale and no live WS event is
    // emitted to SessionControls. This is the production failure that left an
    // editable card whose edit later failed with "Queued message not found".
    rerender(
      <SessionControls
        ws={ws as any}
        activeSession={activeSession}
        quickData={makeQuickData() as any}
        transportTimelineEvents={[{
          eventId: 'transport-user:queued-before-drain',
          sessionId: 'qwen-session',
          type: 'user.message',
          ts: Date.now(),
          seq: 2,
          epoch: 1,
          source: 'daemon',
          confidence: 'high',
          payload: {
            text: 'old queued text',
            clientMessageId: 'queued-before-drain',
            pendingMessageVersion: 9,
          },
        }]}
      />,
    );

    expect(screen.queryByText('old queued text')).toBeNull();
    expect(document.querySelector('.controls-queued-hint')).toBeFalsy();
  });

  it('treats partial queued transport entries as authoritative', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'qwen-session',
          runtimeType: 'transport',
          state: 'running',
          transportPendingMessages: ['queued first', 'queued second'],
          transportPendingMessageEntries: [
            { clientMessageId: 'msg-1', text: 'queued first' },
          ],
        })}
        quickData={makeQuickData() as any}
      />,
    );

    expect(screen.getByText('queued first')).toBeDefined();
    expect(screen.queryByText('queued second')).toBeNull();
  });

  it('renders shared actor labels on queued transport messages', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'qwen-session',
          runtimeType: 'transport',
          state: 'running',
          transportPendingMessages: ['shared queued'],
          transportPendingMessageEntries: [
            {
              clientMessageId: 'msg-shared',
              text: 'shared queued',
              sharedActor: {
                actorUserId: 'user-shared',
                actorDisplayName: 'Ada Shared',
                effectiveActorRole: 'participant',
                origin: 'shared-tab',
                actionId: 'action-shared',
                primaryShareId: 'share-1',
                authorizedAt: 1,
                snapshot: {
                  target: { kind: 'main', serverId: 'srv-1', sessionName: 'qwen-session' },
                  effectiveRole: 'participant',
                  historyCutoffAt: 1,
                  authorizedAt: 1,
                  primaryShareId: 'share-1',
                  coveringShareIds: ['share-1'],
                  expiresAt: null,
                  nextCoverageRecheckAt: null,
                },
              },
            },
          ],
        })}
        quickData={makeQuickData() as any}
      />,
    );

    expect(screen.getByText('shared queued')).toBeDefined();
    expect(screen.getByText('Ada Shared · Participant')).toBeDefined();
  });

  it('renders server-member actor labels on queued transport messages', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'qwen-session',
          runtimeType: 'transport',
          state: 'running',
          transportPendingMessages: ['member queued'],
          transportPendingMessageEntries: [
            {
              clientMessageId: 'msg-member',
              text: 'member queued',
              sharedActor: {
                actorUserId: 'user-member',
                actorDisplayName: 'Mira Member',
                effectiveActorRole: 'server-member',
                origin: 'server-member',
                actionId: 'action-member',
                primaryShareId: null,
                authorizedAt: 1,
                snapshot: {
                  target: { kind: 'main', serverId: 'srv-1', sessionName: 'qwen-session' },
                  effectiveRole: 'participant',
                  historyCutoffAt: 0,
                  authorizedAt: 1,
                  primaryShareId: null,
                  coveringShareIds: [],
                  nextCoverageRecheckAt: null,
                },
              },
            },
          ],
        })}
        quickData={makeQuickData() as any}
      />,
    );

    expect(screen.getByText('member queued')).toBeDefined();
    expect(screen.getByText('Mira Member · Server member')).toBeDefined();
  });

  it('does not offer edit or delete actions for legacy queued fallback entries', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'qwen-session',
          runtimeType: 'transport',
          state: 'running',
          transportPendingMessages: ['queued first'],
          transportPendingMessageEntries: [],
        })}
        quickData={makeQuickData() as any}
      />,
    );

    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });

  it('stop action requires 3-level confirmation for main session', () => {
    const ws = makeWs();
    // Mock window.confirm to auto-accept
    const origConfirm = window.confirm;
    window.confirm = () => true;
    try {
      render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session', project: 'my-project' })} quickData={makeQuickData() as any} />);
      // Open the ⋯ menu
      fireEvent.click(screen.getByTitle('actions'));
      // Click 1: triggers level 1 (warn)
      const stopBtn = screen.getByRole('button', { name: /stop/i });
      fireEvent.click(stopBtn);
      expect(ws.sendSessionCommand).not.toHaveBeenCalled();
      // Click 2: triggers level 2 (danger)
      const warnBtn = screen.getByRole('button', { name: /stop/i });
      fireEvent.click(warnBtn);
      expect(ws.sendSessionCommand).not.toHaveBeenCalled();
      // Click 3: triggers window.confirm dialog → executes stop
      const dangerBtn = screen.getByRole('button', { name: /stop/i });
      fireEvent.click(dangerBtn);
      expect(ws.sendSessionCommand).toHaveBeenCalledWith('stop', { project: 'my-project' });
    } finally {
      window.confirm = origConfirm;
    }
  });

  it('input changes on typing', () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'typed text';
    fireEvent.input(input);
    expect(input.textContent).toBe('typed text');
  });

  it('send button is disabled when ws is null', () => {
    render(<SessionControls ws={null} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    const sendBtn = screen.getByRole('button', { name: /send/i }) as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
  });

  it('input has contenteditable false when activeSession is null', () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={null} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;
    expect(input.getAttribute('contenteditable')).toBe('false');
  });

  it('pressing Enter submits the message', () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'enter message';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expectSendPayload(ws, {
      sessionName: 'my-session',
      text: 'enter message',
    });
  });

  it('typing /stop in a transport input sends direct urgent cancel instead of chat text', () => {
    const ws = makeWs();
    const onSend = vi.fn();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({ name: 'qwen-session', agentType: 'qwen', state: 'running' })}
        quickData={makeQuickData() as any}
        onSend={onSend}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = '/stop';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    // STOP must stay on the urgent lane. A regular session.cancel would be
    // gated by ws-client probe state and can be dropped during tab/focus
    // resume, which is the regression this test locks down.
    expectUrgentCancelPayload(ws, { sessionName: 'qwen-session' });
    expect(gatherSendCalls(ws)).not.toContainEqual(expect.objectContaining({ text: '/stop' }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('shows a running transport send in the queue instead of injecting a timeline bubble', () => {
    const ws = makeWs();
    const onSend = vi.fn();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'running',
        })}
        quickData={makeQuickData() as any}
        onSend={onSend}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'queue this while busy';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    expectSendPayload(ws, {
      sessionName: 'qwen-session',
      text: 'queue this while busy',
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText('queue this while busy')).toBeDefined();
  });

  it('uses active thinking as a busy signal for transport sends even before session.state catches up', () => {
    const ws = makeWs();
    const onSend = vi.fn();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'idle',
        })}
        activeThinking={true}
        quickData={makeQuickData() as any}
        onSend={onSend}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'queue from thinking';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    expectSendPayload(ws, {
      sessionName: 'qwen-session',
      text: 'queue from thinking',
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText('queue from thinking')).toBeDefined();
  });

  it('uses active timeline turn as a busy signal for transport sends after assistant text starts', () => {
    const ws = makeWs();
    const onSend = vi.fn();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'idle',
        })}
        activeTransportTurn={true}
        quickData={makeQuickData() as any}
        onSend={onSend}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'queue after assistant text';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    expectSendPayload(ws, {
      sessionName: 'qwen-session',
      text: 'queue after assistant text',
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText('queue after assistant text')).toBeDefined();
  });

  it('surfaces a normal send as locally failed when the socket write throws', () => {
    const ws = makeWs();
    ws.sendSessionCommand.mockImplementation(() => {
      throw new Error('WebSocket not connected');
    });
    const onSend = vi.fn();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'idle',
        })}
        quickData={makeQuickData() as any}
        onSend={onSend}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'must not vanish';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    expect(onSend).toHaveBeenCalledWith('qwen-session', 'must not vanish', expect.objectContaining({
      commandId: expect.any(String),
      localFailure: 'WebSocket not connected',
    }));
  });

  it('falls back to HTTP send when the socket write throws and serverId is available', () => {
    const ws = makeWs();
    ws.sendSessionCommand.mockImplementation(() => {
      throw new Error('WebSocket not connected');
    });
    const onSend = vi.fn();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'idle',
        })}
        quickData={makeQuickData() as any}
        onSend={onSend}
        serverId="server-1"
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'fallback send';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    expect(sendSessionViaHttpMock).toHaveBeenCalledWith('server-1', expect.objectContaining({
      sessionName: 'qwen-session',
      text: 'fallback send',
      commandId: expect.any(String),
    }));
    expect(onSend).toHaveBeenCalledWith('qwen-session', 'fallback send', expect.not.objectContaining({
      localFailure: expect.any(String),
    }));
  });

  it('falls back to HTTP send when ws is temporarily unavailable', () => {
    const onSend = vi.fn();
    render(
      <SessionControls
        ws={null}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'idle',
        })}
        quickData={makeQuickData() as any}
        onSend={onSend}
        serverId="server-1"
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'http only send';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    expect(sendSessionViaHttpMock).toHaveBeenCalledWith('server-1', expect.objectContaining({
      sessionName: 'qwen-session',
      text: 'http only send',
      commandId: expect.any(String),
    }));
    expect(onSend).toHaveBeenCalledWith('qwen-session', 'http only send', expect.objectContaining({
      commandId: expect.any(String),
    }));
  });

  it('keeps a running transport send visible as failed when the socket write throws', () => {
    const ws = makeWs();
    ws.sendSessionCommand.mockImplementation(() => {
      throw new Error('WebSocket not connected');
    });
    const onSend = vi.fn();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'running',
        })}
        quickData={makeQuickData() as any}
        onSend={onSend}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'failed queued send';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText('failed queued send')).toBeDefined();
    expect(screen.getByLabelText('sendFailedLabel')).toBeDefined();
    expect(screen.getByRole('button', { name: 'retrySend' })).toBeDefined();
  });

  it('keeps an optimistic queue entry across transient non-running session snapshots', () => {
    const ws = makeWs();
    const onSend = vi.fn();
    const view = render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'running',
        })}
        quickData={makeQuickData() as any}
        onSend={onSend}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'do not disappear';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(screen.getByText('do not disappear')).toBeDefined();

    view.rerender(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'idle',
          transportPendingMessages: [],
          transportPendingMessageEntries: [],
        })}
        quickData={makeQuickData() as any}
        onSend={onSend}
      />,
    );

    expect(screen.getByText('do not disappear')).toBeDefined();
  });

  it('does not clear a new local queue entry when an older daemon queue drains', () => {
    const ws = makeWs();
    const view = render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'running',
          transportPendingMessages: ['old daemon queued'],
          transportPendingMessageEntries: [{ clientMessageId: 'old-daemon-id', text: 'old daemon queued' }],
        })}
        quickData={makeQuickData() as any}
      />,
    );
    expect(screen.getByText('old daemon queued')).toBeDefined();

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'new local send must stay';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(screen.getByText('new local send must stay')).toBeDefined();

    view.rerender(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'running',
          transportPendingMessages: [],
          transportPendingMessageEntries: [],
        })}
        quickData={makeQuickData() as any}
      />,
    );

    expect(screen.queryByText('old daemon queued')).toBeNull();
    expect(screen.getByText('new local send must stay')).toBeDefined();
  });

  it('clears optimistic queue entries when daemon sends an authoritative empty pending snapshot', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'running',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'queued then drained';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(screen.getByText('queued then drained')).toBeDefined();

    act(() => {
      ws.emit({
        type: 'timeline.event',
        event: {
          eventId: 'state-empty-pending',
          sessionId: 'qwen-session',
          type: 'session.state',
          ts: Date.now(),
          seq: 1,
          epoch: 1,
          source: 'daemon',
          confidence: 'high',
          payload: {
            state: 'running',
            queueEpoch: 'queue-epoch-1',
            queueAuthorityId: 'queue-authority-1',
            pendingMessageVersion: 1,
            pendingMessageEntries: [],
          },
        },
      });
    });

    expect(screen.queryByText('queued then drained')).toBeNull();
  });

  it('drops an incoming queued entry once its message reaches the timeline even if the snapshot still lists it', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'running',
          // Daemon snapshot still lists the message as pending — the stale
          // snapshot the resend / auto-deliver "queued" emit leaves until idle.
          transportPendingMessages: ['stuck message'],
          transportPendingMessageEntries: [{ clientMessageId: 'stuck-1', text: 'stuck message' }],
        })}
        quickData={makeQuickData() as any}
      />,
    );
    expect(screen.getByText('stuck message')).toBeDefined();

    // The message reaches the timeline → delivered, no longer queued.
    act(() => {
      ws.emit({
        type: 'timeline.event',
        event: {
          eventId: 'um-stuck-1',
          sessionId: 'qwen-session',
          type: 'user.message',
          ts: Date.now(),
          seq: 1,
          epoch: 1,
          source: 'daemon',
          confidence: 'high',
          payload: { text: 'stuck message', commandId: 'stuck-1' },
        },
      });
    });

    // The daemon pending snapshot (prop) STILL lists it, but the timeline is
    // authoritative — the zombie queued entry is gone.
    expect(screen.queryByText('stuck message')).toBeNull();
  });

  it('applies a realtime empty queue snapshot even when activeSession props still carry stale queued entries', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'running',
          transportPendingMessages: ['stale prop queued'],
          transportPendingMessageEntries: [{ clientMessageId: 'stale-prop-1', text: 'stale prop queued' }],
          transportPendingMessageVersion: 3,
        })}
        quickData={makeQuickData() as any}
      />,
    );
    expect(screen.getByText('stale prop queued')).toBeDefined();

    act(() => {
      ws.emit({
        type: 'timeline.event',
        event: {
          eventId: 'state-empty-pending-live',
          sessionId: 'qwen-session',
          type: 'session.state',
          ts: Date.now(),
          seq: 2,
          epoch: 1,
          source: 'daemon',
          confidence: 'high',
          payload: {
            state: 'running',
            queueEpoch: 'queue-epoch-1',
            queueAuthorityId: 'queue-authority-1',
            pendingMessageVersion: 4,
            pendingMessageEntries: [],
          },
        },
      });
    });

    expect(screen.queryByText('stale prop queued')).toBeNull();
  });

  it('applies realtime empty queue snapshots for sub-session controls too', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'deck_sub_worker',
          project: 'my-project',
          role: 'w1',
          agentType: 'codex-sdk',
          state: 'running',
          transportPendingMessages: ['sub stale queued'],
          transportPendingMessageEntries: [{ clientMessageId: 'sub-stale-1', text: 'sub stale queued' }],
          transportPendingMessageVersion: 5,
        })}
        subSessionId="worker"
        quickData={makeQuickData() as any}
      />,
    );
    expect(screen.getByText('sub stale queued')).toBeDefined();

    act(() => {
      ws.emit({
        type: 'timeline.event',
        event: {
          eventId: 'sub-state-empty-pending-live',
          sessionId: 'deck_sub_worker',
          type: 'session.state',
          ts: Date.now(),
          seq: 3,
          epoch: 1,
          source: 'daemon',
          confidence: 'high',
          payload: {
            state: 'running',
            queueEpoch: 'queue-epoch-1',
            queueAuthorityId: 'queue-authority-1',
            pendingMessageVersion: 6,
            pendingMessageEntries: [],
          },
        },
      });
    });

    expect(screen.queryByText('sub stale queued')).toBeNull();
  });

  it('keeps the sub-session queue listener mounted across parent session-state rerenders', () => {
    const ws = makeWs();
    const queuedEntry = { clientMessageId: 'sub-burst-1', text: 'sub burst queued' };
    const view = render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'deck_sub_burst',
          project: 'my-project',
          role: 'w1',
          agentType: 'codex-sdk',
          state: 'stopping',
          transportPendingMessageEntries: [queuedEntry],
          transportPendingMessageVersion: 7,
        })}
        subSessionId="burst"
        quickData={makeQuickData() as any}
      />,
    );
    expect(screen.getByText('sub burst queued')).toBeDefined();
    const queueListenerRegistrationCount = () => ws.onMessage.mock.calls.filter(
      ([handler]) => (handler as { name?: string }).name === 'handleRealtimeQueueMessage',
    ).length;
    expect(queueListenerRegistrationCount()).toBe(1);

    // The parent queue/session projection handles the first state event before
    // SessionControls and supplies a new SessionInfo object. This used to
    // unsubscribe/re-subscribe the queue listener, creating a gap in which the
    // next frames in the same daemon burst could be missed.
    view.rerender(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'deck_sub_burst',
          project: 'my-project',
          role: 'w1',
          agentType: 'codex-sdk',
          state: 'idle',
          transportPendingMessageEntries: [queuedEntry],
          transportPendingMessageVersion: 7,
        })}
        subSessionId="burst"
        quickData={makeQuickData() as any}
      />,
    );
    expect(queueListenerRegistrationCount()).toBe(1);

    act(() => {
      ws.emit({
        type: 'timeline.event',
        event: {
          eventId: 'sub-burst-empty-v8',
          sessionId: 'deck_sub_burst',
          type: 'session.state',
          ts: Date.now(),
          seq: 822,
          epoch: 1,
          source: 'daemon',
          confidence: 'high',
          payload: {
            state: 'idle',
            queueEpoch: 'queue-epoch-1',
            queueAuthorityId: 'queue-authority-1',
            pendingMessageVersion: 8,
            pendingMessageEntries: [],
          },
        },
      });
      ws.emit({
        type: 'timeline.event',
        event: {
          eventId: 'sub-burst-user-message',
          sessionId: 'deck_sub_burst',
          type: 'user.message',
          ts: Date.now() + 1,
          seq: 827,
          epoch: 1,
          source: 'daemon',
          confidence: 'high',
          payload: {
            text: 'sub burst queued',
            commandId: 'sub-burst-1',
            clientMessageId: 'sub-burst-1',
          },
        },
      });
    });

    expect(screen.queryByText('sub burst queued')).toBeNull();
    expect(queueListenerRegistrationCount()).toBe(1);
  });

  it('applies session_list empty queue snapshots without waiting for parent props to refresh', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'running',
          transportPendingMessageEntries: [{ clientMessageId: 'stale-list-1', text: 'stale list queued' }],
          transportPendingMessageVersion: 7,
        })}
        quickData={makeQuickData() as any}
      />,
    );
    expect(screen.getByText('stale list queued')).toBeDefined();

    act(() => {
      ws.emit({
        type: 'session_list',
        sessions: [{
          name: 'qwen-session',
          project: 'my-project',
          role: 'brain',
          agentType: 'qwen',
          state: 'running',
          runtimeType: 'transport',
          queueEpoch: 'queue-epoch-1',
          queueAuthorityId: 'queue-authority-1',
          pendingMessageVersion: 8,
          transportPendingMessageVersion: 8,
          pendingMessageEntries: [],
          transportPendingMessageEntries: [],
        }],
      });
    });

    expect(screen.queryByText('stale list queued')).toBeNull();
  });

  it('applies subsession.sync empty queue snapshots without waiting for a window refresh', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'deck_sub_worker',
          project: 'my-project',
          role: 'w1',
          state: 'running',
          transportPendingMessageEntries: [{ clientMessageId: 'stale-sub-sync-1', text: 'stale sub sync queued' }],
          transportPendingMessageVersion: 9,
        })}
        subSessionId="worker"
        quickData={makeQuickData() as any}
      />,
    );
    expect(screen.getByText('stale sub sync queued')).toBeDefined();

    act(() => {
      ws.emit({
        type: 'subsession.sync',
        id: 'worker',
        sessionName: 'deck_sub_worker',
        state: 'running',
        queueEpoch: 'queue-epoch-1',
        queueAuthorityId: 'queue-authority-1',
        pendingMessageVersion: 10,
        transportPendingMessageVersion: 10,
        pendingMessageEntries: [],
        transportPendingMessageEntries: [],
      });
    });

    expect(screen.queryByText('stale sub sync queued')).toBeNull();
  });

  it('clears a local queued entry when reconnect snapshot advances to an empty queue', () => {
    const ws = makeWs();
    const view = render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'running',
          transportPendingMessages: [],
          transportPendingMessageEntries: [],
          transportPendingMessageVersion: 0,
        })}
        quickData={makeQuickData() as any}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'sent while browser was offline';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(screen.getByText('sent while browser was offline')).toBeDefined();

    view.rerender(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'running',
          transportPendingMessages: [],
          transportPendingMessageEntries: [],
          transportPendingMessageVersion: 2,
        })}
        quickData={makeQuickData() as any}
      />,
    );

    expect(screen.queryByText('sent while browser was offline')).toBeNull();
  });

  it('keeps a new local queue entry when the empty daemon baseline has not advanced', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'running',
          transportPendingMessages: [],
          transportPendingMessageEntries: [],
          transportPendingMessageVersion: 7,
        })}
        quickData={makeQuickData() as any}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'new send after empty baseline';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    expect(screen.getByText('new send after empty baseline')).toBeDefined();
  });

  it('clears a local queued entry when an empty daemon baseline advances after the send', async () => {
    const ws = makeWs();
    const view = render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'running',
          transportPendingMessages: [],
          transportPendingMessageEntries: [],
          transportPendingMessageVersion: 7,
        })}
        quickData={makeQuickData() as any}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'fast drained local send';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(screen.getByText('fast drained local send')).toBeDefined();

    view.rerender(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'running',
          transportPendingMessages: [],
          transportPendingMessageEntries: [],
          transportPendingMessageVersion: 8,
        })}
        quickData={makeQuickData() as any}
      />,
    );

    await waitFor(() => expect(screen.queryByText('fast drained local send')).toBeNull());
  });

  it('does not clear an optimistic queue entry by text when the authoritative user.message lacks ids', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'running',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'queued text fallback';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(screen.getByText('queued text fallback')).toBeDefined();

    act(() => {
      ws.emit({
        type: 'timeline.event',
        event: {
          eventId: 'user-message-no-id',
          sessionId: 'qwen-session',
          type: 'user.message',
          ts: Date.now(),
          seq: 1,
          epoch: 1,
          source: 'daemon',
          confidence: 'high',
          payload: { text: 'queued   text fallback' },
        },
      });
    });

    expect(screen.getByText('queued text fallback')).toBeDefined();
  });

  it('marks a local queued send failed instead of removing it when command.failed arrives', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'running',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'failed but visible';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    const sent = ws.sendSessionCommand.mock.calls[0]?.[1] as { commandId: string };

    act(() => {
      ws.emit({
        type: 'command.failed',
        session: 'qwen-session',
        commandId: sent.commandId,
        reason: 'daemon_offline',
        retryable: true,
      });
    });

    expect(screen.getByText('failed but visible')).toBeDefined();
    expect(screen.getByLabelText('sendFailedLabel')).toBeDefined();
    expect(screen.getByRole('button', { name: 'retrySend' })).toBeDefined();
  });

  it('lets an authoritative daemon queue snapshot replace optimistic queue entries', () => {
    const ws = makeWs();
    const view = render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'running',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'local only';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    const sent = ws.sendSessionCommand.mock.calls[0]?.[1] as { commandId: string };
    expect(screen.getByText('local only')).toBeDefined();

    view.rerender(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'running',
          transportPendingMessages: ['daemon queued'],
          transportPendingMessageEntries: [{ clientMessageId: sent.commandId, text: 'daemon queued' }],
        })}
        quickData={makeQuickData() as any}
      />,
    );

    expect(screen.getByText('daemon queued')).toBeDefined();
    expect(screen.queryByText('local only')).toBeNull();
  });

  it('does not queue transport slash commands while running', () => {
    const ws = makeWs();
    const onSend = vi.fn();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'running',
        })}
        quickData={makeQuickData() as any}
        onSend={onSend}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = '/clear';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    expectSendPayload(ws, {
      sessionName: 'qwen-session',
      text: '/clear',
    });
    expect(onSend).toHaveBeenCalledWith('qwen-session', '/clear', expect.objectContaining({
      commandId: expect.any(String),
    }));
    expect(screen.queryByRole('button', { name: '1 queued' })).toBeNull();
  });

  it('sends /compact without creating an optimistic user bubble', () => {
    const ws = makeWs();
    const onSend = vi.fn();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'idle',
        })}
        quickData={makeQuickData() as any}
        onSend={onSend}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = '/compact';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    expectSendPayload(ws, {
      sessionName: 'qwen-session',
      text: '/compact',
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('qwen oauth model dropdown only shows coder-model even if stale model list exists', () => {
    render(<SessionControls
      ws={makeWs() as any}
      activeSession={makeSession({
        agentType: 'qwen',
        qwenAuthType: 'qwen-oauth',
        qwenModel: 'coder-model',
        qwenAvailableModels: ['coder-model', 'qwen3-coder-plus', 'qwen3-max-2026-01-23'],
      })}
      quickData={makeQuickData() as any}
    />);
    fireEvent.click(screen.getByRole('button', { name: /qwen_tier_free/i }));
    expect(screen.getByText(/coder-model/)).toBeDefined();
    expect(screen.queryByText(/qwen3-coder-plus/)).toBeNull();
    expect(screen.queryByText(/qwen3-max-2026-01-23/)).toBeNull();
  });

  it('shows the preset model for claude-code-sdk sessions instead of stale local opus', () => {
    localStorage.setItem('imcodes-model', 'opus[1M]');

    render(<SessionControls
      ws={makeWs() as any}
      activeSession={makeSession({
        name: 'deck_sub_minimax',
        agentType: 'claude-code-sdk',
        runtimeType: 'transport',
        ccPreset: 'minimax',
        requestedModel: 'MiniMax-M3',
        activeModel: 'MiniMax-M3',
        modelDisplay: 'MiniMax-M3',
      })}
      quickData={makeQuickData() as any}
    />);

    fireEvent.click(screen.getByRole('button', { name: /^MiniMax-M3$/i }));
    expect(screen.getByRole('button', { name: /^● MiniMax-M3$/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /opus/i })).toBeNull();
  });

  it('uses the claude-code-sdk active model when sub-session preset metadata is absent', () => {
    localStorage.setItem('imcodes-model', 'opus[1M]');

    render(<SessionControls
      ws={makeWs() as any}
      activeSession={makeSession({
        name: 'deck_sub_minimax',
        agentType: 'claude-code-sdk',
        runtimeType: 'transport',
        requestedModel: 'MiniMax-M3',
        activeModel: 'MiniMax-M3',
        modelDisplay: 'MiniMax-M3',
      })}
      quickData={makeQuickData() as any}
    />);

    fireEvent.click(screen.getByRole('button', { name: /^MiniMax-M3$/i }));
    expect(screen.getByRole('button', { name: /^● MiniMax-M3$/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /opus/i })).toBeNull();
  });

  it('shows level control for qwen and sends /thinking', () => {
    const ws = makeWs();
    render(<SessionControls
      ws={ws as any}
      activeSession={makeSession({
        name: 'qwen-session',
        agentType: 'qwen',
        runtimeType: 'transport',
        effort: 'medium',
      })}
      quickData={makeQuickData() as any}
    />);

    fireEvent.click(screen.getByRole('button', { name: /^medium$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^○ high$/i }));
    expectSendPayload(ws, {
      sessionName: 'qwen-session',
      text: '/thinking high',
    });
  });

  it('forces qwen compatible API sessions to high thinking mode', () => {
    render(<SessionControls
      ws={makeWs() as any}
      activeSession={makeSession({
        name: 'qwen-compatible-session',
        agentType: 'qwen',
        runtimeType: 'transport',
        effort: 'high',
        ccPreset: 'MiniMax',
        qwenAuthType: 'api-key',
      })}
      quickData={makeQuickData() as any}
    />);

    expect(screen.getByRole('button', { name: /^high$/i })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /^high$/i }));
    expect(screen.queryByRole('button', { name: /^○ off$/i })).toBeNull();
  });


  it('shows queued transport messages at the bottom', () => {
    const runningSession = makeSession({
      name: 'qwen-session',
      agentType: 'qwen',
      runtimeType: 'transport',
      state: 'running',
      transportPendingMessages: ['queued send', 'second queued send'],
      transportPendingMessageEntries: [
        { clientMessageId: 'msg-1', text: 'queued send' },
        { clientMessageId: 'msg-2', text: 'second queued send' },
      ],
    });
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={runningSession}
        quickData={makeQuickData() as any}
      />,
    );
    expect(screen.getByText('transport_send_queued')).toBeDefined();
    expect(screen.getByText('queued send')).toBeDefined();
    expect(screen.getByText('second queued send')).toBeDefined();
  });

  it('can hide queued transport messages into a compact count pill', () => {
    const runningSession = makeSession({
      name: 'qwen-session',
      agentType: 'qwen',
      runtimeType: 'transport',
      state: 'running',
      transportPendingMessages: ['queued send', 'second queued send'],
      transportPendingMessageEntries: [
        { clientMessageId: 'msg-1', text: 'queued send' },
        { clientMessageId: 'msg-2', text: 'second queued send' },
      ],
    });
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={runningSession}
        quickData={makeQuickData() as any}
      />,
    );

    expect(screen.getByText('queued send')).toBeDefined();
    expect(screen.getByText('second queued send')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'hide' }));

    expect(screen.getByRole('button', { name: '2 queued' })).toBeDefined();
    expect(screen.queryByText('queued send')).toBeNull();
    expect(screen.queryByText('second queued send')).toBeNull();
    expect(screen.queryByText('2 queued · showing latest only')).toBeNull();
  });

  it('remembers queued transport message visibility per session and defaults to visible', () => {
    const runningSession = makeSession({
      name: 'qwen-session',
      agentType: 'qwen',
      runtimeType: 'transport',
      state: 'running',
      transportPendingMessages: ['queued send', 'second queued send'],
      transportPendingMessageEntries: [
        { clientMessageId: 'msg-1', text: 'queued send' },
        { clientMessageId: 'msg-2', text: 'second queued send' },
      ],
    });
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={runningSession}
        quickData={makeQuickData() as any}
      />,
    );

    expect(screen.getByText('queued send')).toBeDefined();
    expect(screen.getByText('second queued send')).toBeDefined();
    expect(screen.queryByText('2 queued · showing latest only')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'hide' }));
    expect(screen.getByRole('button', { name: '2 queued' })).toBeDefined();
    cleanup();

    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={runningSession}
        quickData={makeQuickData() as any}
      />,
    );

    expect(screen.getByRole('button', { name: '2 queued' })).toBeDefined();
    expect(screen.queryByText('queued send')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /2 queued/i }));
    expect(screen.getByText('queued send')).toBeDefined();
    expect(screen.getByText('second queued send')).toBeDefined();
  });

  it('edits a queued transport message through the queue controls', () => {
    const ws = makeWs();
    const runningSession = makeSession({
      name: 'qwen-session',
      agentType: 'qwen',
      runtimeType: 'transport',
      state: 'running',
      transportPendingMessages: ['queued send'],
      transportPendingMessageEntries: [
        { clientMessageId: 'msg-1', text: 'queued send' },
      ],
    });
    render(
      <SessionControls
        ws={ws as any}
        activeSession={runningSession}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    const input = screen.getByRole('textbox') as HTMLDivElement;
    expect(input.textContent).toBe('queued send');

    input.textContent = 'edited queued send';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session.edit_queued_message',
      sessionName: 'qwen-session',
      clientMessageId: 'msg-1',
      text: 'edited queued send',
      commandId: expect.any(String),
    }));
    expect(screen.getByText('edited queued send')).toBeDefined();
    expect(screen.queryByText('queued send')).toBeNull();
  });

  it('removes a queued transport message through the queue controls', () => {
    const ws = makeWs();
    const runningSession = makeSession({
      name: 'qwen-session',
      agentType: 'qwen',
      runtimeType: 'transport',
      state: 'running',
      transportPendingMessages: ['queued send'],
      transportPendingMessageEntries: [
        { clientMessageId: 'msg-1', text: 'queued send' },
      ],
    });
    render(
      <SessionControls
        ws={ws as any}
        activeSession={runningSession}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));

    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session.undo_queued_message',
      sessionName: 'qwen-session',
      clientMessageId: 'msg-1',
      commandId: expect.any(String),
    }));
    expect(screen.queryByText('queued send')).toBeNull();
  });

  it('sends the backend undo when deleting a still-local optimistic queue entry', () => {
    // Regression: an optimistic entry is queued locally the instant you send it,
    // but the daemon has ALSO already enqueued it (the WS enqueue is ordered
    // before any delete). Deleting it during the window before the authoritative
    // snapshot echoes back used to remove ONLY the local copy and skip the backend
    // undo — so the message stayed queued server-side and reappeared on the next
    // snapshot. The delete must always reach the backend.
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'qwen-session',
          agentType: 'qwen',
          state: 'running',
        })}
        quickData={makeQuickData() as any}
        onSend={vi.fn()}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'delete me from the backend too';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(screen.getByText('delete me from the backend too')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));

    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session.undo_queued_message',
      sessionName: 'qwen-session',
      clientMessageId: expect.any(String),
      commandId: expect.any(String),
    }));
    expect(screen.queryByText('delete me from the backend too')).toBeNull();
  });

  it('keeps a deleted item hidden while a stale multi-item queue snapshot remains', () => {
    const ws = makeWs();
    const runningSession = makeSession({
      name: 'qwen-session',
      agentType: 'qwen',
      runtimeType: 'transport',
      state: 'running',
      transportPendingMessages: ['same queued text', 'same queued text'],
      transportPendingMessageEntries: [
        { clientMessageId: 'msg-1', text: 'same queued text' },
        { clientMessageId: 'msg-2', text: 'same queued text' },
      ],
    });
    render(
      <SessionControls
        ws={ws as any}
        activeSession={runningSession}
        quickData={makeQuickData() as any}
      />,
    );

    expect(screen.getAllByText('same queued text')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: /delete/i })[0]);

    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session.undo_queued_message',
      sessionName: 'qwen-session',
      clientMessageId: 'msg-1',
      commandId: expect.any(String),
    }));
    // The parent session snapshot still contains both ids until the daemon's
    // deletion event arrives. The local tombstone must prevent msg-1 from being
    // merged straight back, which previously made Delete appear to do nothing.
    expect(screen.getAllByText('same queued text')).toHaveLength(1);
  });

  it('restores a tombstoned queue item when deletion is rejected', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'qwen-session',
          agentType: 'qwen',
          runtimeType: 'transport',
          state: 'running',
          transportPendingMessageEntries: [
            { clientMessageId: 'msg-1', text: 'first queued text' },
            { clientMessageId: 'msg-2', text: 'second queued text' },
          ],
        })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: /delete/i })[0]);
    expect(screen.queryByText('first queued text')).toBeNull();
    const mutation = ws.send.mock.calls.at(-1)?.[0] as { commandId: string };

    await act(async () => {
      ws.emit({
        type: 'command.ack',
        session: 'qwen-session',
        commandId: mutation.commandId,
        status: 'error',
        error: 'Queued message not found',
      });
    });

    expect(screen.getByText('first queued text')).toBeDefined();
    expect(screen.getByText('second queued text')).toBeDefined();
  });

  it('pressing Escape in a focused running transport input sends direct cancel', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'qwen-session',
          agentType: 'qwen',
          runtimeType: 'transport',
          state: 'running',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.focus();
    fireEvent.keyDown(input, { key: 'Escape' });

    // Transport sessions cancel the SDK turn directly instead of sending
    // `/stop` as chat text.
    expectUrgentCancelPayload(ws, { sessionName: 'qwen-session' });
    expect(screen.getByRole('button', { name: /^stop$/i }).classList.contains('shortcut-btn-stop-pending')).toBe(true);
    expect(gatherSendCalls(ws)).not.toContainEqual(expect.objectContaining({
      sessionName: 'qwen-session',
      text: '/stop',
    }));
    expect(ws.sendInput).not.toHaveBeenCalled();
  });

  it('pressing Escape with window focus sends direct cancel for the active transport surface', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'qwen-session',
          agentType: 'qwen',
          runtimeType: 'transport',
          state: 'running',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    (document.activeElement as HTMLElement | null)?.blur?.();
    fireEvent.keyDown(document, { key: 'Escape' });

    expectUrgentCancelPayload(ws, { sessionName: 'qwen-session' });
    expect(screen.getByRole('button', { name: /^stop$/i }).classList.contains('shortcut-btn-stop-pending')).toBe(true);
    expect(ws.sendInput).not.toHaveBeenCalled();
  });

  it('does not send window-level Escape cancel when the surface is not keyboard-active', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'deck_sub_inactive',
          agentType: 'qwen',
          runtimeType: 'transport',
          state: 'running',
        })}
        subSessionId="inactive"
        keyboardActive={false}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(gatherCancelCalls(ws)).toEqual([]);
    expect(ws.sendInput).not.toHaveBeenCalled();
  });

  it('does not send direct cancel on Escape while the @ picker is open', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'qwen-session',
          agentType: 'qwen',
          runtimeType: 'transport',
          state: 'running',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    const getSelectionSpy = vi.spyOn(window, 'getSelection').mockImplementation(() => ({
      anchorOffset: input.textContent?.length ?? 0,
    }) as any);

    try {
      input.textContent = '@';
      fireEvent.input(input);
      expect(screen.getByText('files')).toBeDefined();

      input.focus();
      fireEvent.keyDown(input, { key: 'Escape' });

      expect(gatherCancelCalls(ws)).toEqual([]);
      expect(ws.sendInput).not.toHaveBeenCalled();
    } finally {
      getSelectionSpy.mockRestore();
    }
  });

  it('does not send direct cancel on Escape while a modal preview owns the keyboard', () => {
    const ws = makeWs();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    try {
      render(
        <SessionControls
          ws={ws as any}
          activeSession={makeSession({
            name: 'qwen-session',
            agentType: 'qwen',
            runtimeType: 'transport',
            state: 'running',
          })}
          quickData={makeQuickData() as any}
        />,
      );

      const input = screen.getByRole('textbox') as HTMLDivElement;
      input.focus();
      fireEvent.keyDown(input, { key: 'Escape' });

      expect(gatherCancelCalls(ws)).toEqual([]);
      expect(ws.sendInput).not.toHaveBeenCalled();
    } finally {
      dialog.remove();
    }
  });

  it('does not send direct cancel on Escape while an image lightbox owns the keyboard', () => {
    const ws = makeWs();
    const lightbox = document.createElement('div');
    lightbox.className = 'fb-lightbox';
    document.body.appendChild(lightbox);
    try {
      render(
        <SessionControls
          ws={ws as any}
          activeSession={makeSession({
            name: 'qwen-session',
            agentType: 'qwen',
            runtimeType: 'transport',
            state: 'running',
          })}
          quickData={makeQuickData() as any}
        />,
      );

      const input = screen.getByRole('textbox') as HTMLDivElement;
      input.focus();
      fireEvent.keyDown(input, { key: 'Escape' });

      expect(gatherCancelCalls(ws)).toEqual([]);
      expect(ws.sendInput).not.toHaveBeenCalled();
    } finally {
      lightbox.remove();
    }
  });

  it('does not send direct cancel on Escape during IME composition', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'qwen-session',
          agentType: 'qwen',
          runtimeType: 'transport',
          state: 'running',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.focus();
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });

    expect(gatherCancelCalls(ws)).toEqual([]);
    expect(ws.sendInput).not.toHaveBeenCalled();
  });

  it('pressing Escape in a focused running transport sub-session uses the same Stop feedback', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'deck_sub_worker',
          agentType: 'qwen',
          runtimeType: 'transport',
          state: 'running',
        })}
        subSessionId="worker"
        quickData={makeQuickData() as any}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.focus();
    fireEvent.keyDown(input, { key: 'Escape' });

    expectUrgentCancelPayload(ws, { sessionName: 'deck_sub_worker' });
    expect(screen.getByRole('button', { name: /^stop$/i }).classList.contains('shortcut-btn-stop-pending')).toBe(true);
    expect(gatherSendCalls(ws)).not.toContainEqual(expect.objectContaining({
      sessionName: 'deck_sub_worker',
      text: '/stop',
    }));
  });

  it('keeps transport Stop enabled even when session state is idle', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'codex-sdk-session',
          agentType: 'codex-sdk',
          runtimeType: 'transport',
          state: 'idle',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    const stopBtn = screen.getByRole('button', { name: /^stop$/i }) as HTMLButtonElement;
    expect(stopBtn.textContent).toBe('■');
    expect(stopBtn.disabled).toBe(false);
    fireEvent.click(stopBtn);
    expectUrgentCancelPayload(ws, { sessionName: 'codex-sdk-session' });
    expect(gatherSendCalls(ws)).not.toContainEqual(expect.objectContaining({
      sessionName: 'codex-sdk-session',
      text: '/stop',
    }));
  });

  it('shows a compact Auto dropdown for supported transport sessions and enables supervised mode from saved defaults', async () => {
    const ws = makeWs();
    fetchSupervisorDefaultsMock.mockResolvedValue({
      backend: 'codex-sdk',
      model: 'gpt-5.4',
      timeoutMs: 12000,
      promptVersion: 'supervision_decision_v1',
    });
    const onTransportConfigSaved = vi.fn();
    render(
      <SessionControls
        ws={ws as any}
        serverId="srv1"
        activeSession={makeTransportSession({
          name: 'codex-sdk-session',
          state: 'idle',
        })}
        onSettings={vi.fn()}
        onTransportConfigSaved={onTransportConfigSaved}
        quickData={makeQuickData() as any}
      />,
    );

    const autoBtn = screen.getByRole('button', { name: /^Auto$/ });
    expect(autoBtn.textContent).toContain('Auto');
    expect(autoBtn.textContent).not.toContain('Supervised');
    expect(autoBtn.classList.contains('shortcut-btn-auto-off')).toBe(true);
    expect(autoBtn.classList.contains('shortcut-btn-auto-active')).toBe(false);
    fireEvent.click(autoBtn);
    expect(document.querySelector('.menu-dropdown-auto')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /supervised$/i }));

    await waitFor(() => {
      expect(patchSessionMock).toHaveBeenCalledWith('srv1', 'codex-sdk-session', expect.objectContaining({
        transportConfig: expect.objectContaining({
          supervision: expect.objectContaining({
            mode: 'supervised',
            backend: 'codex-sdk',
            model: 'gpt-5.4',
          }),
        }),
      }));
    });
    expect(onTransportConfigSaved).toHaveBeenCalledWith(expect.objectContaining({
      supervision: expect.objectContaining({
        mode: 'supervised',
      }),
    }));
    expect(autoBtn.classList.contains('shortcut-btn-auto-supervised')).toBe(true);
    expect(autoBtn.classList.contains('shortcut-btn-auto-active')).toBe(true);
    expect(autoBtn.textContent).toContain('supervised');
    expect(autoBtn.textContent).not.toContain('Auto');
  });

  it('uses a distinct active visual mode for supervised audit', () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        serverId="srv1"
        activeSession={makeTransportSession({
          name: 'deck_proj_brain',
          role: 'brain',
          state: 'idle',
          sessionInstanceId: 'brain-instance',
          runtimeEpoch: 'brain-runtime',
          activeModel: 'gpt-5.6',
          providerId: 'openai',
          transportConfig: {
            supervision: {
              mode: 'supervised_audit',
              backend: 'codex-sdk',
              model: 'gpt-5.6',
              timeoutMs: 12000,
              promptVersion: 'supervision_decision_v1',
              auditTargetSessionName: 'deck_sub_peer',
              auditTargetFingerprint: {
                sessionInstanceId: 'peer-instance',
                normalizedModelId: 'claude-opus',
                providerFamily: 'anthropic',
              },
              peerAuditPromptVersion: 'supervision_peer_audit_v1',
            },
          },
        })}
        quickData={makeQuickData() as any}
      />,
    );

    const autoBtn = screen.getByRole('button', { name: /^Auto$/ });
    expect(autoBtn.textContent).toContain('Audit');
    expect(autoBtn.textContent).not.toContain('supervised_audit');
    expect(autoBtn.classList.contains('shortcut-btn-auto-audit')).toBe(true);
    expect(autoBtn.classList.contains('shortcut-btn-auto-supervised')).toBe(false);
    expect(autoBtn.classList.contains('shortcut-btn-auto-active')).toBe(true);
    expect(autoBtn.getAttribute('aria-haspopup')).toBe('menu');
    expect(autoBtn.getAttribute('aria-expanded')).toBe('false');
  });

  it('mounts the accessible Peer Audit control immediately before Auto while mode is off', () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        serverId="srv1"
        activeSession={makeTransportSession({
          name: 'deck_proj_brain',
          role: 'brain',
          sessionInstanceId: 'brain-instance',
          runtimeEpoch: 'brain-runtime',
          state: 'idle',
          transportConfig: { supervision: { mode: 'off' } },
        })}
        quickData={makeQuickData() as any}
      />,
    );
    const peer = screen.getByTestId('peer-audit-icon');
    const auto = screen.getByRole('button', { name: /^Auto$/ });
    expect(peer.getAttribute('data-testid')).toBe('peer-audit-icon');
    expect(auto.previousElementSibling).toBe(peer);
    expect(peer.getAttribute('aria-label')).toBeTruthy();
    expect(peer.textContent).toBe('');
    expect(peer.querySelector('svg.shortcut-btn-peer-audit-icon')).not.toBeNull();
    expect(peer.parentElement?.classList.contains('shortcuts-model-supervision')).toBe(true);
  });

  it('quick audit reuses ordinary @agent orchestration without local state gating', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        serverId="srv1"
        activeSession={makeTransportSession({
          name: 'deck_proj_brain',
          role: 'brain',
          sessionInstanceId: undefined,
          runtimeEpoch: undefined,
          state: 'idle',
          transportConfig: { supervision: { mode: 'off' } },
        })}
        sessions={[]}
        subSessions={[{
          sessionName: 'deck_sub_reviewer',
          type: 'claude-code-sdk',
          label: 'Reviewer',
          state: 'unknown',
          parentSession: 'deck_proj_brain',
          activeModel: 'claude-opus-4-7',
        }]}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByTestId('peer-audit-icon'));
    expect(screen.getByTestId('quick-agent-delegation-dialog')).toBeDefined();
    expect(screen.getByText('Reviewer')).toBeDefined();
    expect(screen.getByText('claude-opus-4-7')).toBeDefined();
    expect(document.body.textContent).not.toContain('baseline_no_result');
    expect(document.body.textContent).not.toContain('consentTitle');

    fireEvent.click(screen.getByTestId('quick-agent-delegation-candidate'));

    const sent = gatherSendCalls(ws).at(-1)!;
    expect(sent.sessionName).toBe('deck_proj_brain');
    expect(sent.text).toContain('You are the current session orchestrator for an agent delegation.');
    expect(sent.text).toContain('Exact delegate target session: deck_sub_reviewer');
    expect(sent.text).toContain('independently audit this session\'s most recent work');
    expect(sent.text).toContain('imcodes send --reply "deck_sub_reviewer"');
    expect(ws.send.mock.calls.some(([message]) => message?.type === 'peer_audit.quick_start')).toBe(false);
    expect(ws.sendSessionCommand.mock.calls.some(([, payload]) => payload?.delegateTarget)).toBe(false);
  });

  it('quick delegation bypasses queued-message editing instead of rewriting the queued row', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        serverId="srv1"
        activeSession={makeTransportSession({
          name: 'deck_proj_brain',
          project: 'proj',
          role: 'brain',
          state: 'running',
          transportPendingMessages: ['queued original'],
          transportPendingMessageEntries: [{ clientMessageId: 'queued-1', text: 'queued original' }],
        })}
        sessions={[]}
        subSessions={[{
          sessionName: 'deck_sub_reviewer', type: 'claude-code-sdk', label: 'Reviewer', state: 'idle', parentSession: 'deck_proj_brain', activeModel: 'opus',
        }]}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    expect((screen.getByRole('textbox') as HTMLDivElement).textContent).toBe('queued original');
    fireEvent.click(screen.getByTestId('peer-audit-icon'));
    fireEvent.click(screen.getByTestId('quick-agent-delegation-candidate'));

    expect(ws.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session.edit_queued_message' }));
    const sent = gatherSendCalls(ws).at(-1)!;
    expect(sent.text).toContain('Exact delegate target session: deck_sub_reviewer');
    expect((screen.getByRole('textbox') as HTMLDivElement).textContent).toBe('queued original');
    expect(screen.getByText(/queued · edit/i)).toBeDefined();
  });

  it('keeps the Quick dialog open with an inline error when dispatch is rejected locally', () => {
    const ws = makeWs();
    ws.sendSessionCommand.mockImplementationOnce(() => { throw new Error('ws failed'); });
    sendSessionViaHttpMock.mockImplementationOnce(() => { throw new Error('http failed'); });
    render(
      <SessionControls
        ws={ws as any}
        serverId="srv1"
        activeSession={makeTransportSession({ name: 'deck_proj_brain', project: 'proj', role: 'brain' })}
        subSessions={[{ sessionName: 'deck_sub_reviewer', type: 'codex-sdk', label: 'Reviewer', state: 'idle', parentSession: 'deck_proj_brain' }]}
        quickData={makeQuickData() as any}
      />,
    );
    fireEvent.click(screen.getByTestId('peer-audit-icon'));
    fireEvent.click(screen.getByTestId('quick-agent-delegation-candidate'));
    expect(screen.getByTestId('quick-agent-delegation-dialog')).toBeDefined();
    expect(screen.getByTestId('quick-agent-delegation-error').textContent).toBe('sendFailed');
  });

  it('rejects custom session-control text inside Quick without closing or sending', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        serverId="srv1"
        activeSession={makeTransportSession({ name: 'deck_proj_brain', project: 'proj', role: 'brain' })}
        subSessions={[{ sessionName: 'deck_sub_reviewer', type: 'codex-sdk', label: 'Reviewer', state: 'idle', parentSession: 'deck_proj_brain' }]}
        quickData={makeQuickData() as any}
      />,
    );
    fireEvent.click(screen.getByTestId('peer-audit-icon'));
    fireEvent.click(screen.getByText('custom'));
    fireEvent.input(screen.getByTestId('quick-agent-delegation-custom'), { target: { value: '/stop check this' } });
    fireEvent.click(screen.getByTestId('quick-agent-delegation-candidate'));
    expect(screen.getByTestId('quick-agent-delegation-error').textContent).toBe('warning_control_command');
    expect(gatherSendCalls(ws)).toHaveLength(0);
  });

  it('limits Quick candidates to the current session group, excluding same-project worker records and other roots', () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        serverId="srv1"
        activeSession={makeTransportSession({ name: 'deck_proj_brain', project: 'proj', role: 'brain' })}
        sessions={[
          makeTransportSession({ name: 'deck_proj_brain', project: 'proj', role: 'brain', label: 'Self' }),
          makeTransportSession({ name: 'deck_proj_w1', project: 'proj', role: 'w1', label: 'Project peer' }),
          makeTransportSession({ name: 'deck_other_brain', project: 'other', role: 'brain', label: 'Other project' }),
          makeSession({ name: 'deck_proj_shell', project: 'proj', agentType: 'shell', label: 'Shell' }),
        ]}
        subSessions={[
          { sessionName: 'deck_sub_child', type: 'codex-sdk', label: 'Child', state: 'idle', parentSession: 'deck_proj_brain' },
          { sessionName: 'deck_sub_busy', type: 'claude-code-sdk', label: 'Busy child', state: 'running', parentSession: 'deck_proj_brain' },
          { sessionName: 'deck_sub_sibling', type: 'claude-code-sdk', label: 'Other root child', state: 'running', parentSession: 'deck_proj_w1' },
          { sessionName: 'deck_sub_other', type: 'codex-sdk', label: 'Other child', state: 'idle', parentSession: 'deck_other_brain' },
          { sessionName: 'deck_sub_child', type: 'codex-sdk', label: 'Duplicate child', state: 'idle', parentSession: 'deck_proj_brain' },
          { sessionName: 'deck_sub_shell', type: 'shell', label: 'Sub shell', state: 'idle', parentSession: 'deck_proj_brain' },
        ]}
        quickData={makeQuickData() as any}
      />,
    );
    fireEvent.click(screen.getByTestId('peer-audit-icon'));
    const dialog = screen.getByTestId('quick-agent-delegation-dialog');
    expect(within(dialog).getAllByTestId('quick-agent-delegation-candidate')).toHaveLength(2);
    expect(dialog.textContent).toContain('Child');
    expect(dialog.textContent).toContain('Busy child');
    expect(dialog.textContent).not.toContain('Self');
    expect(dialog.textContent).not.toContain('Shell');
    expect(dialog.textContent).not.toContain('Project peer');
    expect(dialog.textContent).not.toContain('Other root child');
    expect(dialog.textContent).not.toContain('Other project');
    expect(dialog.textContent).not.toContain('Other child');
    expect(dialog.textContent).not.toContain('Duplicate child');
  });

  it('keeps stopped, error, unknown, and busy lifecycle snapshots selectable for manual Quick delegation', () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        serverId="srv1"
        activeSession={makeTransportSession({ name: 'deck_proj_brain', project: 'proj', role: 'brain' })}
        subSessions={[
          { sessionName: 'deck_sub_stopped', type: 'codex-sdk', label: 'Stopped snapshot', state: 'stopped', parentSession: 'deck_proj_brain' },
          { sessionName: 'deck_sub_error', type: 'claude-code-sdk', label: 'Error snapshot', state: 'error', parentSession: 'deck_proj_brain' },
          { sessionName: 'deck_sub_unknown', type: 'codex-sdk', label: 'Unknown snapshot', state: 'unknown', parentSession: 'deck_proj_brain' },
          { sessionName: 'deck_sub_busy', type: 'claude-code-sdk', label: 'Busy snapshot', state: 'running', parentSession: 'deck_proj_brain' },
        ]}
        quickData={makeQuickData() as any}
      />,
    );
    fireEvent.click(screen.getByTestId('peer-audit-icon'));
    const dialog = screen.getByTestId('quick-agent-delegation-dialog');
    const rows = within(dialog).getAllByTestId('quick-agent-delegation-candidate') as HTMLButtonElement[];
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => !row.disabled)).toBe(true);
    expect(dialog.textContent).not.toContain('busy');
    expect(dialog.textContent).not.toContain('unavailable');
    expect(dialog.textContent).not.toContain('statePending');
  });

  it('offers the owning main session and direct siblings when Quick starts from a sub-session', () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        serverId="srv1"
        activeSession={makeTransportSession({ name: 'deck_sub_current', project: 'proj', role: 'w1' })}
        sessions={[
          makeTransportSession({ name: 'deck_proj_brain', project: 'proj', role: 'brain', label: 'Project main' }),
          makeTransportSession({ name: 'deck_proj_w1', project: 'proj', role: 'w1', label: 'Hidden worker' }),
        ]}
        subSessions={[
          { sessionName: 'deck_sub_current', type: 'codex-sdk', label: 'Current', state: 'idle', parentSession: 'deck_proj_brain' },
          { sessionName: 'deck_sub_sibling', type: 'claude-code-sdk', label: 'Sibling', state: 'idle', parentSession: 'deck_proj_brain' },
          { sessionName: 'deck_sub_other', type: 'codex-sdk', label: 'Other root', state: 'idle', parentSession: 'deck_other_brain' },
        ]}
        quickData={makeQuickData() as any}
      />,
    );
    fireEvent.click(screen.getByTestId('peer-audit-icon'));
    const dialog = screen.getByTestId('quick-agent-delegation-dialog');
    expect(within(dialog).getAllByTestId('quick-agent-delegation-candidate')).toHaveLength(2);
    expect(dialog.textContent).toContain('Project main');
    expect(dialog.textContent).toContain('Sibling');
    expect(dialog.textContent).not.toContain('Current');
    expect(dialog.textContent).not.toContain('Hidden worker');
    expect(dialog.textContent).not.toContain('Other root');
  });

  it('marks enabled Team members in the Quick delegation chooser', async () => {
    getUserPrefMock.mockImplementation(async (key: unknown) => {
      if (typeof key === 'string' && key.startsWith('p2p_session_config:')) {
        return JSON.stringify({
          sessions: {
            deck_sub_team: { enabled: true, mode: 'audit' },
            deck_sub_regular: { enabled: false, mode: 'review' },
          },
          rounds: 1,
        });
      }
      return null;
    });
    render(
      <SessionControls
        ws={makeWs() as any}
        serverId="srv1"
        activeSession={makeTransportSession({ name: 'deck_proj_brain', project: 'proj', role: 'brain' })}
        subSessions={[
          { sessionName: 'deck_sub_team', type: 'claude-code-sdk', label: 'Team reviewer', state: 'idle', parentSession: 'deck_proj_brain' },
          { sessionName: 'deck_sub_regular', type: 'codex-sdk', label: 'Regular reviewer', state: 'idle', parentSession: 'deck_proj_brain' },
        ]}
        quickData={makeQuickData() as any}
      />,
    );
    await flushAsync();
    fireEvent.click(screen.getByTestId('peer-audit-icon'));
    const rows = within(screen.getByTestId('quick-agent-delegation-dialog'))
      .getAllByTestId('quick-agent-delegation-candidate');
    expect(rows[0]!.textContent).toContain('Team reviewer');
    expect(rows[0]!.textContent).toContain('p2p_tag');
    expect(rows[1]!.textContent).toContain('Regular reviewer');
    expect(rows[1]!.textContent).not.toContain('p2p_tag');
  });

  it('fails closed with an empty Quick candidate list for an orphaned sub-session', () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        serverId="srv1"
        activeSession={makeTransportSession({ name: 'deck_sub_orphan', project: 'proj' })}
        sessions={[makeTransportSession({ name: 'deck_other_brain', project: 'other', label: 'Other' })]}
        subSessions={[{
          sessionName: 'deck_sub_orphan', type: 'codex-sdk', label: 'Orphan', state: 'idle', parentSession: null,
        }]}
        quickData={makeQuickData() as any}
      />,
    );
    fireEvent.click(screen.getByTestId('peer-audit-icon'));
    expect(screen.getByTestId('quick-agent-delegation-empty')).toBeDefined();
    expect(screen.queryByTestId('quick-agent-delegation-candidate')).toBeNull();
  });

  it('does not consume composer text, quotes, or attachments during Quick delegation', async () => {
    uploadFileMock.mockResolvedValue({ attachment: { daemonPath: '/tmp/quick-proof.png' } });
    const ws = makeWs();
    const onRemoveQuote = vi.fn();
    render(
      <SessionControls
        ws={ws as any}
        serverId="srv1"
        activeSession={makeTransportSession({ name: 'deck_proj_brain', project: 'proj', role: 'brain' })}
        subSessions={[{ sessionName: 'deck_sub_reviewer', type: 'codex-sdk', label: 'Reviewer', state: 'idle', parentSession: 'deck_proj_brain' }]}
        quotes={['quoted context']}
        onRemoveQuote={onRemoveQuote}
        quickData={makeQuickData() as any}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'draft stays here';
    fireEvent.input(input);
    const file = new File(['png'], 'quick-proof.png', { type: 'image/png' });
    fireEvent.drop(input, { dataTransfer: { files: [file], types: ['Files'], dropEffect: 'copy' } });
    await waitFor(() => expect(document.querySelector('.attachment-badge-name')?.textContent).toBe('quick-proof.png'));

    fireEvent.click(screen.getByTestId('peer-audit-icon'));
    fireEvent.click(screen.getByTestId('quick-agent-delegation-candidate'));

    expect(input.textContent).toBe('draft stays here');
    expect(document.querySelector('.attachment-badge-name')?.textContent).toBe('quick-proof.png');
    expect(onRemoveQuote).not.toHaveBeenCalled();
    const sent = gatherSendCalls(ws).at(-1)!;
    expect(sent.text).not.toContain('quoted context');
    expect(sent.text).not.toContain('/tmp/quick-proof.png');
  });

  it('allows Quick delegation while an unrelated composer upload is still in flight', async () => {
    let resolveUpload: ((value: { attachment: { daemonPath: string } }) => void) | null = null;
    uploadFileMock.mockImplementationOnce(() => new Promise((resolve) => { resolveUpload = resolve; }));
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        serverId="srv1"
        activeSession={makeTransportSession({ name: 'deck_proj_brain', project: 'proj', role: 'brain' })}
        subSessions={[{ sessionName: 'deck_sub_reviewer', type: 'codex-sdk', label: 'Reviewer', state: 'idle', parentSession: 'deck_proj_brain' }]}
        quickData={makeQuickData() as any}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLDivElement;
    const file = new File(['pending'], 'pending.txt', { type: 'text/plain' });
    fireEvent.drop(input, { dataTransfer: { files: [file], types: ['Files'], dropEffect: 'copy' } });
    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('peer-audit-icon'));
    fireEvent.click(screen.getByTestId('quick-agent-delegation-candidate'));
    expect(gatherSendCalls(ws)).toHaveLength(1);
    expect(screen.queryByTestId('quick-agent-delegation-error')).toBeNull();

    await act(async () => {
      resolveUpload?.({ attachment: { daemonPath: '/tmp/pending.txt' } });
      await flushAsync();
    });
  });

  it('opens Settings instead of inferring an auditor when enabling audit mode', async () => {
    const ws = makeWs();
    const onSettings = vi.fn();
    render(
      <SessionControls
        ws={ws as any}
        serverId="srv1"
        activeSession={makeTransportSession({
          name: 'codex-sdk-session',
          state: 'idle',
          transportConfig: {
            supervision: {
              mode: 'supervised',
              backend: 'codex-sdk',
              model: 'gpt-5.4',
              timeoutMs: 12000,
              promptVersion: 'supervision_decision_v1',
              maxParseRetries: 1,
            },
          },
        })}
        onSettings={onSettings}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Auto$/ }));
    fireEvent.click(screen.getByRole('button', { name: /supervised_audit$/i }));

    await waitFor(() => expect(onSettings).toHaveBeenCalledWith({
      supervisionMode: 'supervised_audit',
      focus: 'peer-audit-target',
    }));
    expect(patchSessionMock).not.toHaveBeenCalled();
  });

  it('falls back to Settings when heavy mode snapshot is present but audit config is invalid', async () => {
    const ws = makeWs();
    const onSettings = vi.fn();
    render(
      <SessionControls
        ws={ws as any}
        serverId="srv1"
        activeSession={makeTransportSession({
          name: 'codex-sdk-session',
          state: 'idle',
          transportConfig: {
            supervision: {
              mode: 'supervised',
              backend: 'codex-sdk',
              model: 'gpt-5.4',
              timeoutMs: 12000,
              promptVersion: 'supervision_decision_v1',
              maxParseRetries: 1,
              auditMode: 'audit',
              maxAuditLoops: 0,
            },
          },
        })}
        onSettings={onSettings}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Auto$/ }));
    fireEvent.click(screen.getByRole('button', { name: /supervised_audit$/i }));

    await waitFor(() => {
      expect(onSettings).toHaveBeenCalled();
    });
    expect(patchSessionMock).not.toHaveBeenCalled();
  });

  it('reuses a saved name-only auditor without local model or authority gating', async () => {
    const onSettings = vi.fn();
    render(
      <SessionControls
        ws={makeWs() as any}
        serverId="srv1"
        activeSession={makeTransportSession({
          name: 'deck_proj_brain',
          role: 'brain',
          state: 'idle',
          transportConfig: {
            supervision: {
              mode: 'supervised',
              backend: 'codex-sdk',
              model: 'gpt-5.6',
              timeoutMs: 12000,
              promptVersion: 'supervision_decision_v1',
              auditTargetSessionName: 'deck_sub_peer',
              peerAuditPromptVersion: 'supervision_peer_audit_v1',
            },
          },
        })}
        onSettings={onSettings}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Auto$/ }));
    fireEvent.click(screen.getByRole('button', { name: /supervised_audit$/i }));
    await waitFor(() => expect(patchSessionMock).toHaveBeenCalledWith(
      'srv1',
      'deck_proj_brain',
      expect.objectContaining({
        transportConfig: expect.objectContaining({
          supervision: expect.objectContaining({
            mode: 'supervised_audit',
            auditTargetSessionName: 'deck_sub_peer',
          }),
        }),
      }),
    ));
    expect(onSettings).not.toHaveBeenCalled();
  });

  it('keeps the current session auditor when quick mode is turned off and reuses it on audit', async () => {
    const onSettings = vi.fn();
    render(
      <SessionControls
        ws={makeWs() as any}
        serverId="srv1"
        activeSession={makeTransportSession({
          name: 'deck_proj_brain',
          role: 'brain',
          state: 'idle',
          transportConfig: {
            supervision: {
              mode: 'supervised_audit',
              backend: 'codex-sdk',
              model: 'gpt-5.6-sol',
              timeoutMs: 12000,
              promptVersion: 'supervision_decision_v1',
              auditTargetSessionName: 'deck_sub_peer',
              peerAuditPromptVersion: 'supervision_peer_audit_v1',
            },
          },
        })}
        onSettings={onSettings}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Auto$/ }));
    fireEvent.click(screen.getByRole('button', { name: /off$/i }));
    await waitFor(() => expect(patchSessionMock).toHaveBeenLastCalledWith(
      'srv1',
      'deck_proj_brain',
      expect.objectContaining({
        transportConfig: expect.objectContaining({
          supervision: expect.objectContaining({
            mode: 'off',
            auditTargetSessionName: 'deck_sub_peer',
          }),
        }),
      }),
    ));

    fireEvent.click(screen.getByRole('button', { name: /^Auto$/ }));
    fireEvent.click(screen.getByRole('button', { name: /supervised_audit$/i }));
    await waitFor(() => expect(patchSessionMock).toHaveBeenLastCalledWith(
      'srv1',
      'deck_proj_brain',
      expect.objectContaining({
        transportConfig: expect.objectContaining({
          supervision: expect.objectContaining({
            mode: 'supervised_audit',
            auditTargetSessionName: 'deck_sub_peer',
          }),
        }),
      }),
    ));
    expect(onSettings).not.toHaveBeenCalled();
  });

  it('keeps legacy fingerprint metadata optional when compact audit is enabled', async () => {
    const onSettings = vi.fn();
    render(
      <SessionControls
        ws={makeWs() as any}
        serverId="srv1"
        activeSession={makeTransportSession({
          name: 'deck_proj_brain',
          role: 'brain',
          state: 'idle',
          sessionInstanceId: 'brain-instance',
          runtimeEpoch: 'brain-runtime',
          activeModel: 'gpt-5.6',
          providerId: 'openai',
          transportConfig: {
            supervision: {
              mode: 'supervised',
              backend: 'codex-sdk',
              model: 'gpt-5.6',
              timeoutMs: 12000,
              promptVersion: 'supervision_decision_v1',
              auditTargetSessionName: 'deck_sub_peer',
              auditTargetFingerprint: {
                sessionInstanceId: 'peer-instance',
                normalizedModelId: 'claude-opus',
                providerFamily: 'anthropic',
              },
              peerAuditPromptVersion: 'supervision_peer_audit_v1',
            },
          },
        })}
        subSessions={[{
          sessionName: 'deck_sub_peer',
          type: 'claude-code-sdk',
          label: 'Peer',
          state: 'idle',
          parentSession: 'deck_proj_brain',
          sessionInstanceId: 'peer-instance',
          runtimeEpoch: 'peer-runtime',
          activeModel: 'claude-opus',
          providerId: 'anthropic',
        }]}
        onSettings={onSettings}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Auto$/ }));
    fireEvent.click(screen.getByRole('button', { name: /supervised_audit$/i }));
    await waitFor(() => expect(patchSessionMock).toHaveBeenCalledWith(
      'srv1',
      'deck_proj_brain',
      expect.objectContaining({
        transportConfig: expect.objectContaining({
          supervision: expect.objectContaining({ mode: 'supervised_audit' }),
        }),
      }),
    ));
    expect(onSettings).not.toHaveBeenCalled();
  });

  it('always shows Session Settings in the Auto dropdown when settings are available', () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        serverId="srv1"
        activeSession={makeTransportSession({
          name: 'codex-sdk-session',
          state: 'idle',
          transportConfig: {
            supervision: {
              mode: 'supervised',
              backend: 'codex-sdk',
              model: 'gpt-5.4',
              timeoutMs: 12000,
              promptVersion: 'supervision_decision_v1',
              maxParseRetries: 1,
            },
          },
        })}
        onSettings={vi.fn()}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Auto$/ }));
    const autoMenu = document.querySelector('.menu-dropdown-auto');
    expect(autoMenu).toBeTruthy();
    expect(within(autoMenu as HTMLElement).getByRole('button', { name: /settings/i })).toBeDefined();
  });

  it('renders approval controls for active transport chat events', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        serverId="srv1"
        activeSession={makeTransportSession({
          name: 'codex-sdk-session',
          state: 'running',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    await waitFor(() => {
      expect(ws.onMessage).toHaveBeenCalled();
    });
    await flushAsync();

    await act(async () => {
      for (const call of ws.onMessage.mock.calls) {
        const handler = call[0] as ((msg: unknown) => void) | undefined;
        handler?.({
          type: TRANSPORT_MSG.CHAT_APPROVAL,
          sessionId: 'codex-sdk-session',
          requestId: 'approval-1',
          description: 'Allow file write',
          tool: 'shell',
          provider: 'qoder-sdk',
          providerGeneration: 3,
          providerToolUseId: 'tool-approve',
          inputPreview: '{"command":"pwd"}',
        });
      }
    });

    await waitFor(() => {
      expect(screen.getByText('Approval required')).toBeDefined();
      expect(screen.getByText('shell wants approval')).toBeDefined();
      expect(screen.getByText('Allow file write')).toBeDefined();
      expect(screen.getByText('qoder-sdk generation 3 tool tool-approve')).toBeDefined();
      expect(screen.getByText('Input: {"command":"pwd"}')).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: /^Allow$/ }));
    expect(ws.respondTransportApproval).toHaveBeenCalledWith('codex-sdk-session', 'approval-1', true);
  });

  it('clears stale approval banners when switching between transport sessions', async () => {
    const ws = makeWs();
    const { rerender } = render(
      <SessionControls
        ws={ws as any}
        serverId="srv1"
        activeSession={makeTransportSession({
          name: 'transport-a',
          state: 'running',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    await waitFor(() => {
      expect(ws.onMessage).toHaveBeenCalled();
    });

    await act(async () => {
      for (const call of ws.onMessage.mock.calls) {
        const handler = call[0] as ((msg: unknown) => void) | undefined;
        handler?.({
          type: TRANSPORT_MSG.CHAT_APPROVAL,
          sessionId: 'transport-a',
          requestId: 'approval-stale',
          description: 'Allow file write',
          tool: 'shell',
        });
      }
    });

    await waitFor(() => {
      expect(screen.getByText('Approval required')).toBeDefined();
    });

    rerender(
      <SessionControls
        ws={ws as any}
        serverId="srv1"
        activeSession={makeTransportSession({
          name: 'transport-b',
          state: 'running',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText('Approval required')).toBeNull();
      expect(screen.queryByText('shell wants approval')).toBeNull();
    });
  });

  it('treats copilot-sdk sessions as transport even when runtimeType is omitted', async () => {
    const ws = makeWs();

    render(
      <SessionControls
        ws={ws as any}
        serverId="srv1"
        activeSession={makeSession({
          name: 'copilot-session',
          agentType: 'copilot-sdk',
          state: 'running',
          runtimeType: undefined,
        })}
        quickData={makeQuickData() as any}
      />,
    );

    expect(screen.getByRole('button', { name: /^Stop$/ })).toBeDefined();
  });

  it('pressing Shift+Enter does not submit', () => {
    const ws = makeWs();
    render(<SessionControls ws={ws as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'multiline';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
  });

  it('ArrowUp/ArrowDown navigates the same history source and restores the draft', () => {
    const ws = makeWs();
    const quickData = makeQuickData();
    quickData.data = {
      history: ['global newest'],
      sessionHistory: {
        'my-session': ['session newest', 'session older'],
      },
      commands: [],
      phrases: [],
    };
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={quickData as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;

    input.textContent = 'draft text';
    fireEvent.input(input);

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.textContent).toBe('session newest');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.textContent).toBe('session older');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.textContent).toBe('session newest');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.textContent).toBe('draft text');
  });

  it('ignores input keyboard shortcuts while IME composition is active', async () => {
    const ws = makeWs();
    const quickData = makeQuickData();
    quickData.data = {
      history: ['session newest'],
      sessionHistory: {
        'my-session': ['session newest'],
      },
      commands: [],
      phrases: [],
    };
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={quickData as any} />);
    await act(async () => {
      await Promise.resolve();
    });
    const input = screen.getByRole('textbox') as HTMLDivElement;

    input.textContent = '拼';
    fireEvent.input(input);
    input.dispatchEvent(new Event('compositionstart', { bubbles: true, cancelable: true }));

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.textContent).toBe('拼');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();

    input.dispatchEvent(new Event('compositionend', { bubbles: true, cancelable: true }));
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.textContent).toBe('session newest');
  });

  it('ignores history navigation when keydown itself is marked composing', () => {
    const ws = makeWs();
    const quickData = makeQuickData();
    quickData.data = {
      history: ['session newest'],
      sessionHistory: {
        'my-session': ['session newest'],
      },
      commands: [],
      phrases: [],
    };
    render(<SessionControls ws={ws as any} activeSession={makeSession({ name: 'my-session' })} quickData={quickData as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;

    input.textContent = 'pin';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'ArrowUp', isComposing: true, keyCode: 229 });
    expect(input.textContent).toBe('pin');
  });

  it('closes @ picker if user keeps typing without making a selection', () => {
    render(<SessionControls ws={makeWs() as any} activeSession={makeSession()} quickData={makeQuickData() as any} />);
    const input = screen.getByRole('textbox') as HTMLDivElement;
    const getSelectionSpy = vi.spyOn(window, 'getSelection').mockImplementation(() => ({
      anchorOffset: input.textContent?.length ?? 0,
    }) as any);

    input.textContent = '@';
    fireEvent.input(input);
    expect(screen.getByText('files')).toBeDefined();

    input.textContent = '@hello';
    fireEvent.input(input);
    expect(screen.queryByText('files')).toBeNull();
    expect(screen.queryByText('agents')).toBeNull();

    getSelectionSpy.mockRestore();
  });

  it('does not send immediately after selecting agent and mode; sends an orchestration prompt to the current session after further editing', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={mainSession}
        quickData={makeQuickData() as any}
        sessions={[mainSession]}
        subSessions={[
          { sessionName: 'deck_sub_w1', type: 'codex', label: 'w1', state: 'idle', parentSession: 'deck_my-project_brain' },
        ]}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLDivElement;
    const getSelectionSpy = vi.spyOn(window, 'getSelection').mockImplementation(() => ({
      anchorOffset: input.textContent?.length ?? 0,
    }) as any);

    input.textContent = '@';
    fireEvent.input(input);
    fireEvent.click(screen.getByText('agents'));
    fireEvent.click(screen.getByText('w1'));
    expect(screen.getByText('chip_label')).toBeDefined();
    expect(input.textContent).toBe('');

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    input.textContent = 'please review';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      sessionName: 'deck_my-project_brain',
      text: expect.stringContaining('You are the current session orchestrator for an agent delegation.'),
    }));
    const sent = gatherSendCalls(ws).at(-1)!;
    expect(sent.text).toContain('Exact delegate target session: deck_sub_w1');
    expect(sent.text).toContain('User task to delegate:\nplease review');
    expect(sent.text).toContain('organize the relevant current-session context yourself');
    expect(sent.text).toContain('Do not send the raw user task by itself.');
    expect(sent.text).toContain('imcodes send --reply "deck_sub_w1"');
    expect(sent).not.toHaveProperty('delegateTarget');

    getSelectionSpy.mockRestore();
  });

  it('inserts session-name-based token even when display label has spaces', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={mainSession}
        quickData={makeQuickData() as any}
        sessions={[mainSession]}
        subSessions={[
          { sessionName: 'deck_sub_worker-alpha', type: 'codex', label: 'Worker Alpha', state: 'idle', parentSession: 'deck_my-project_brain' },
        ]}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLDivElement;
    const getSelectionSpy = vi.spyOn(window, 'getSelection').mockImplementation(() => ({
      anchorOffset: input.textContent?.length ?? 0,
    }) as any);

    input.textContent = '@';
    fireEvent.input(input);
    fireEvent.click(screen.getByText('agents'));
    fireEvent.click(screen.getByText('Worker Alpha'));

    // Agent delegation is shown as a separate chip, not a P2P token in the input.
    expect(input.textContent).toBe('');
    expect(screen.getByText('chip_label')).toBeDefined();
    getSelectionSpy.mockRestore();
  });

  it('shows the selected mode in the inserted label for single-agent mentions', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={mainSession}
        quickData={makeQuickData() as any}
        sessions={[mainSession]}
        subSessions={[
          { sessionName: 'deck_sub_w1', type: 'codex', label: 'w1', state: 'idle', parentSession: 'deck_my-project_brain' },
        ]}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLDivElement;
    const getSelectionSpy = vi.spyOn(window, 'getSelection').mockImplementation(() => ({
      anchorOffset: input.textContent?.length ?? 0,
    }) as any);

    input.textContent = '@';
    fireEvent.input(input);
    fireEvent.click(screen.getByText('agents'));
    fireEvent.click(screen.getByText('w1'));

    expect(input.textContent).toBe('');
    expect(screen.queryByText('discuss')).toBeNull();
    expect(screen.getByText('chip_label')).toBeDefined();
    getSelectionSpy.mockRestore();
  });

  it('@@ opens the Team dropdown (combos/workflows) and strips the trigger, keeping the topic', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={mainSession}
        quickData={makeQuickData() as any}
        sessions={[mainSession]}
        subSessions={[
          { sessionName: 'deck_sub_w1', type: 'codex', label: 'w1', state: 'idle', parentSession: 'deck_my-project_brain' },
        ]}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'audit this module @@';
    fireEvent.input(input);
    // The @@ trigger is stripped; the preceding text is kept as the discussion topic.
    expect(input.textContent).toBe('audit this module ');
    // The Team dropdown (combos/workflows) opens — not the single-agent picker.
    expect(screen.getByTestId('p2p-dropdown-tab-combos')).toBeDefined();
  });

  it('selecting agents from the picker asks the current session to orchestrate delegation instead of direct target dispatch', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={mainSession}
        quickData={makeQuickData() as any}
        sessions={[mainSession]}
        subSessions={[
          { sessionName: 'deck_sub_w1', type: 'codex', label: 'w1', state: 'idle', parentSession: 'deck_my-project_brain' },
        ]}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLDivElement;
    const getSelectionSpy = vi.spyOn(window, 'getSelection').mockImplementation(() => ({
      anchorOffset: input.textContent?.length ?? 0,
    }) as any);

    input.textContent = '@';
    fireEvent.input(input);
    fireEvent.click(screen.getByText('agents'));
    fireEvent.click(screen.getByText('w1'));

    input.textContent = 'please review';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    const sent = gatherSendCalls(ws).at(-1)!;
    expect(sent).toMatchObject({
      sessionName: 'deck_my-project_brain',
    });
    expect(sent.text).toContain('You are the current session orchestrator for an agent delegation.');
    expect(sent.text).toContain('Selected delegate: w1 (deck_sub_w1)');
    expect(sent.text).toContain('User task to delegate:\nplease review');
    expect(sent).toHaveProperty('text');
    expect(sent).not.toHaveProperty('delegateTarget');
    expect(sent).not.toHaveProperty('p2pAtTargets');

    getSelectionSpy.mockRestore();
  });

  it('blocks empty delegated tasks with a delegation warning', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={mainSession}
        quickData={makeQuickData() as any}
        sessions={[mainSession]}
        subSessions={[
          { sessionName: 'deck_sub_w1', type: 'codex', label: 'w1', state: 'idle', parentSession: 'deck_my-project_brain' },
        ]}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = '@';
    fireEvent.input(input);
    fireEvent.click(screen.getByText('agents'));
    fireEvent.click(screen.getByText('w1'));
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(screen.getByText('warning_empty_task')).toBeDefined();
    expect(ws.sendSessionCommand).not.toHaveBeenCalledWith('send', expect.anything());
  });

  it('blocks legacy P2P control tokens while an agent delegation is pending', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={mainSession}
        quickData={makeQuickData() as any}
        sessions={[mainSession]}
        subSessions={[
          { sessionName: 'deck_sub_w1', type: 'codex', label: 'w1', state: 'idle', parentSession: 'deck_my-project_brain' },
        ]}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = '@';
    fireEvent.input(input);
    fireEvent.click(screen.getByText('agents'));
    fireEvent.click(screen.getByText('w1'));
    input.textContent = '@@all(audit) please review';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(screen.getByText('warning_p2p_tokens')).toBeDefined();
    expect(ws.sendSessionCommand).not.toHaveBeenCalledWith('send', expect.anything());
  });

  it('blocks delegated session control commands without local-canceling the origin', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeTransportSession({
          name: 'deck_my-project_brain',
          project: 'my-project',
          role: 'brain',
          label: 'brain',
          state: 'running',
        })}
        quickData={makeQuickData() as any}
        sessions={[mainSession]}
        subSessions={[
          { sessionName: 'deck_sub_w1', type: 'codex', label: 'w1', state: 'idle', parentSession: 'deck_my-project_brain' },
        ]}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = '@';
    fireEvent.input(input);
    fireEvent.click(screen.getByText('agents'));
    fireEvent.click(screen.getByText('w1'));

    input.textContent = '/stop';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(screen.getByText('warning_control_command')).toBeDefined();
    expect(gatherSendCalls(ws)).toHaveLength(0);
    expect(gatherCancelCalls(ws)).toHaveLength(0);
  });

  it('manual @@label(mode) text sends p2pAtTargets when exactly one target resolves', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={mainSession}
        quickData={makeQuickData() as any}
        sessions={[mainSession]}
        subSessions={[
          { sessionName: 'deck_sub_plan', type: 'codex', label: 'plan', state: 'idle', parentSession: 'deck_my-project_brain' },
        ]}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = '@@plan(Audit) check this';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      sessionName: 'deck_my-project_brain',
      text: 'check this',
      p2pAtTargets: [
        { session: 'deck_sub_plan', mode: 'audit' },
      ],
    }));
  });

  it('manual @@label(mode) text sends p2pAtTargets when multiple targets resolve', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={mainSession}
        quickData={makeQuickData() as any}
        sessions={[mainSession]}
        subSessions={[
          { sessionName: 'deck_sub_plan', type: 'codex', label: 'plan', state: 'idle', parentSession: 'deck_my-project_brain' },
          { sessionName: 'deck_sub_planx', type: 'codex', label: 'planx', state: 'idle', parentSession: 'deck_my-project_brain' },
        ]}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = '@@plan(Audit) @@planx(Audit) compare';
    fireEvent.input(input);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      sessionName: 'deck_my-project_brain',
      text: 'compare',
      p2pAtTargets: [
        { session: 'deck_sub_plan', mode: 'audit' },
        { session: 'deck_sub_planx', mode: 'audit' },
      ],
    }));
  });

  it('when active session is a sub-session, agent picker still shows same-root peers', () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={subSession('deck_sub_w2', 'w2')}
        quickData={makeQuickData() as any}
        sessions={[mainSession]}
        subSessions={[
          { sessionName: 'deck_sub_w1', type: 'codex', label: 'w1', state: 'idle', parentSession: 'deck_my-project_brain' },
          { sessionName: 'deck_sub_w2', type: 'codex', label: 'w2', state: 'idle', parentSession: 'deck_my-project_brain' },
          { sessionName: 'deck_sub_other', type: 'codex', label: 'other', state: 'idle', parentSession: 'deck_other_brain' },
        ]}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLDivElement;
    const getSelectionSpy = vi.spyOn(window, 'getSelection').mockImplementation(() => ({
      anchorOffset: input.textContent?.length ?? 0,
    }) as any);

    input.textContent = '@';
    fireEvent.input(input);
    fireEvent.click(screen.getByText('agents'));

    expect(screen.getByText('brain')).toBeDefined();
    expect(screen.getByText('w1')).toBeDefined();
    expect(screen.getByText('w2')).toBeDefined();
    expect(screen.queryByText('other')).toBeNull();

    getSelectionSpy.mockRestore();
  });

  // ── File upload tests ─────────────────────────────────────────────────────

  it('shows upload button in compact card composer when serverId is provided', () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={makeSession()}
        quickData={makeQuickData() as any}
        serverId="srv-1"
        compact
      />,
    );
    expect(screen.getByTitle('upload_file')).toBeDefined();
  });

  it('shows upload button in regular chat composer when serverId is provided', () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={makeSession()}
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );
    expect(screen.getByTitle('upload_file')).toBeDefined();
  });

  it('does not show desktop paste-upload hint in compact card composer', () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={makeSession()}
        quickData={makeQuickData() as any}
        compact
      />,
    );
    expect(document.querySelector('.controls-input')?.getAttribute('data-placeholder')).toBe('Send to my-project…');
  });

  it('keeps normal plain-text paste inline for short clipboard content', () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={makeSession()}
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.focus();
    fireEvent.paste(input, {
      clipboardData: {
        getData: (type: string) => type === 'text/plain' ? 'short inline paste' : '',
      },
    });

    expect(execCommandMock).toHaveBeenCalledWith('insertText', false, 'short inline paste');
    expect(input.textContent).toBe('short inline paste');
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it('uploads dropped files through the same composer attachment path as paste', async () => {
    uploadFileMock.mockResolvedValue({ attachment: { daemonPath: '/tmp/dropped-image.png' } });
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={makeSession()}
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    const droppedFile = new File(['png'], 'dropped-image.png', { type: 'image/png' });
    const dataTransfer = {
      files: [droppedFile],
      types: ['Files'],
      dropEffect: 'none',
    };

    fireEvent.dragEnter(input, { dataTransfer });
    expect(input.classList.contains('controls-input-file-drag-over')).toBe(true);
    expect(dataTransfer.dropEffect).toBe('copy');

    fireEvent.drop(input, { dataTransfer });

    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(1));
    expect(uploadFileMock.mock.calls[0]?.[0]).toBe('srv-1');
    expect(uploadFileMock.mock.calls[0]?.[1]).toBe(droppedFile);
    await waitFor(() => {
      expect(screen.getByTestId('attachment-tag-1').textContent).toBe('#1');
      expect(document.querySelector('.attachment-badge-name')?.textContent).toBe('dropped-image.png');
    });
    expect(input.classList.contains('controls-input-file-drag-over')).toBe(false);
  });

  it('uploads files dropped anywhere in the session drop target with a visible overlay', async () => {
    uploadFileMock.mockResolvedValue({ attachment: { daemonPath: '/tmp/session-drop.pdf' } });
    function Harness() {
      const dropTargetRef = useRef<HTMLDivElement>(null);
      return (
        <div ref={dropTargetRef} data-testid="session-drop-target">
          <div data-testid="session-body">chat body</div>
          <SessionControls
            ws={makeWs() as any}
            activeSession={makeSession()}
            quickData={makeQuickData() as any}
            serverId="srv-1"
            fileDropTargetRef={dropTargetRef}
          />
        </div>
      );
    }

    render(<Harness />);

    const target = screen.getByTestId('session-drop-target') as HTMLDivElement;
    const droppedFile = new File(['pdf'], 'session-drop.pdf', { type: 'application/pdf' });
    const dataTransfer = {
      files: [droppedFile],
      types: ['Files'],
      dropEffect: 'none',
    };

    fireEvent.dragEnter(target, { dataTransfer });

    expect(document.querySelector('.session-file-drop-overlay')).toBeTruthy();
    expect(document.querySelector('.session-file-drop-title')?.textContent).toBe('Drop files to upload');
    expect(dataTransfer.dropEffect).toBe('copy');

    fireEvent.drop(target, { dataTransfer });

    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(1));
    expect(uploadFileMock.mock.calls[0]?.[0]).toBe('srv-1');
    expect(uploadFileMock.mock.calls[0]?.[1]).toBe(droppedFile);
    await waitFor(() => expect(document.querySelector('.session-file-drop-overlay')).toBeFalsy());
  });

  it('converts oversized plain-text paste into an attachment upload', async () => {
    uploadFileMock.mockResolvedValue({ attachment: { daemonPath: '/tmp/pasted-text.txt' } });
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session' })}
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.focus();
    const longText = 'x'.repeat(13000);
    fireEvent.paste(input, {
      clipboardData: {
        getData: (type: string) => type === 'text/plain' ? longText : '',
      },
    });

    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(1));
    const uploadedFile = uploadFileMock.mock.calls[0]?.[1] as File;
    expect(uploadedFile).toBeInstanceOf(File);
    expect(uploadedFile.name).toMatch(/^pasted-text-.*\.txt$/);
    expect(await readBlobText(uploadedFile)).toBe(longText);
    expect(execCommandMock).not.toHaveBeenCalled();
    expect(input.textContent).toBe('');
    await waitFor(() => {
      expect(document.querySelector('.attachment-badge-name')?.textContent).toMatch(/^pasted-text-.*\.txt$/);
    });

    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    // R3 v2 PR-ρ/υ — attachment text-prefix keeps the short tag and
    // maps it to the full daemon path so the LLM can open the file.
    expectSendPayload(ws, {
      sessionName: 'my-session',
      text: '#1:(/tmp/pasted-text.txt)',
    });
  });

  /*
   * R3 v2 PR-ρ — User feedback: "上传或者文件的时候, 要增加个 id-[number]
   * 的功能, 方便发文字的时候引用那个文件" + "id 还是原来的 id 只是加一
   * 个下划线和数字, 每次上传递增. 发送后从1重新开始. #1图片 #2图片
   * 这样 llm 可以快速理解并引用图片". Each composer attachment now
   * carries a sequential `seq` (1, 2, 3, ...) surfaced as a `#N`
   * prefix in the badge AND folded into the send-payload text as
   * `#N:(full path)` so the LLM can resolve each short reference to
   * an actual readable file path. Counter resets on send (the
   * attachments array is wiped by `clearComposer`).
   */
  it('R3 v2 PR-ρ/υ — multi-attachment uploads get sequential #N tags + full-path text references', async () => {
    let nextDaemonPath = '/tmp/file-a.png';
    uploadFileMock.mockImplementation(async () => ({ attachment: { daemonPath: nextDaemonPath } }));
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session' })}
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    // Upload via paste — same code path as the file input but the
    // ClipboardEvent lets us deliver fresh File objects on each call
    // without re-defining a non-configurable `files` property on the
    // hidden file input.
    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.focus();

    const fileA = new File(['aaa'], 'screenshot.png', { type: 'image/png' });
    fireEvent.paste(input, {
      clipboardData: {
        files: [fileA],
        getData: () => '',
      },
    });
    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(screen.getByTestId('attachment-tag-1').textContent).toBe('#1');
    });

    nextDaemonPath = '/tmp/file-b.png';
    const fileB = new File(['bbb'], 'logs.txt', { type: 'text/plain' });
    fireEvent.paste(input, {
      clipboardData: {
        files: [fileB],
        getData: () => '',
      },
    });
    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(screen.getByTestId('attachment-tag-2').textContent).toBe('#2');
    });

    input.textContent = 'compare #1 and #2';
    fireEvent.input(input);

    // Send → text should carry both #N:(full path) references in upload order.
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expectSendPayload(ws, {
      sessionName: 'my-session',
      text: '#1:(/tmp/file-a.png) #2:(/tmp/file-b.png) compare #1 and #2',
    });

    // After send the attachments array is wiped → counter naturally resets.
    await waitFor(() => {
      expect(screen.queryByTestId('attachment-tag-1')).toBeNull();
    });
    nextDaemonPath = '/tmp/file-c.png';
    const fileC = new File(['ccc'], 'next.md', { type: 'text/markdown' });
    fireEvent.paste(input, {
      clipboardData: {
        files: [fileC],
        getData: () => '',
      },
    });
    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(3));
    await waitFor(() => {
      expect(screen.getByTestId('attachment-tag-1').textContent).toBe('#1');
    });
  });

  it('renders independent progress rows for a concurrent multi-file upload batch', async () => {
    type UploadResolver = (value: { attachment: { daemonPath: string } }) => void;
    const pendingUploads: Array<{
      file: File;
      onProgress?: (pct: number) => void;
      resolve: UploadResolver;
    }> = [];
    uploadFileMock.mockImplementation((_serverId: string, file: File, onProgress?: (pct: number) => void) => (
      new Promise<{ attachment: { daemonPath: string } }>((resolve) => {
        pendingUploads.push({ file, onProgress, resolve });
      })
    ));
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session' })}
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    const alpha = new File(['aaa'], 'alpha.txt', { type: 'text/plain' });
    const beta = new File(['bbb'], 'beta.txt', { type: 'text/plain' });
    fireEvent.paste(input, {
      clipboardData: {
        files: [alpha, beta],
        getData: () => '',
      },
    });

    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(2));
    expect(pendingUploads.map((entry) => entry.file.name)).toEqual(['alpha.txt', 'beta.txt']);

    await act(async () => {
      pendingUploads[0].onProgress?.(24);
      pendingUploads[1].onProgress?.(68);
    });

    const rows = screen.getAllByTestId('composer-upload-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('alpha.txt')).toBeDefined();
    expect(within(rows[1]).getByText('beta.txt')).toBeDefined();
    const progressBars = screen.getAllByRole('progressbar');
    expect(progressBars.map((bar) => bar.getAttribute('aria-valuenow'))).toEqual(['24', '68']);
    expect(progressBars.every((bar) => (bar as HTMLElement).style.gridColumn === '1 / -1')).toBe(true);

    await act(async () => {
      pendingUploads[1].resolve({ attachment: { daemonPath: '/tmp/beta.txt' } });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getAllByRole('progressbar').map((bar) => bar.getAttribute('aria-valuenow'))).toEqual(['24', '100']);
    });

    await act(async () => {
      pendingUploads[0].resolve({ attachment: { daemonPath: '/tmp/alpha.txt' } });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryAllByTestId('composer-upload-row')).toHaveLength(0);
      expect(screen.getByTestId('attachment-tag-1').textContent).toBe('#1');
      expect(screen.getByTestId('attachment-tag-2').textContent).toBe('#2');
    });
    const badges = document.querySelectorAll('.attachment-badge');
    expect(badges[0].querySelector('.attachment-badge-name')?.textContent).toBe('alpha.txt');
    expect(badges[1].querySelector('.attachment-badge-name')?.textContent).toBe('beta.txt');
  });

  it('disables sending while an attachment upload is still in flight', async () => {
    let resolveUpload: ((value: { attachment: { daemonPath: string } }) => void) | null = null;
    uploadFileMock.mockImplementation(() => new Promise((resolve) => {
      resolveUpload = resolve;
    }));
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session' })}
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.textContent = 'send after upload';
    fireEvent.input(input);
    fireEvent.paste(input, {
      clipboardData: {
        files: [new File(['aaa'], 'pending.txt', { type: 'text/plain' })],
        getData: () => '',
      },
    });

    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(1));
    const sendBtn = screen.getByRole('button', { name: /send/i }) as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
    fireEvent.click(sendBtn);
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();

    await act(async () => {
      resolveUpload?.({ attachment: { daemonPath: '/tmp/pending.txt' } });
      await Promise.resolve();
    });

    await waitFor(() => expect(sendBtn.disabled).toBe(false));
    fireEvent.click(sendBtn);
    expectSendPayload(ws, {
      sessionName: 'my-session',
      text: '#1:(/tmp/pending.txt) send after upload',
    });
  });

  it('R3 v2 PR-ρ — removing a middle attachment renumbers the remaining tags consecutively', async () => {
    let nextDaemonPath = '/tmp/x1.png';
    uploadFileMock.mockImplementation(async () => ({ attachment: { daemonPath: nextDaemonPath } }));
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'my-session' })}
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.focus();

    // Upload three files via paste → #1, #2, #3.
    for (const [i, name] of [[0, 'a.png'], [1, 'b.png'], [2, 'c.png']] as const) {
      nextDaemonPath = `/tmp/x${i + 1}.png`;
      fireEvent.paste(input, {
        clipboardData: {
          files: [new File([name], name)],
          getData: () => '',
        },
      });
      await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(i + 1));
    }
    await waitFor(() => expect(screen.getByTestId('attachment-tag-3').textContent).toBe('#3'));

    // Remove the middle one (#2 → b.png) by clicking its remove button.
    const badges = document.querySelectorAll('.attachment-badge');
    expect(badges).toHaveLength(3);
    const middleRemove = badges[1].querySelector('.attachment-badge-remove') as HTMLButtonElement;
    fireEvent.click(middleRemove);

    // Survivors renumber: a.png → #1, c.png → #2.
    await waitFor(() => {
      const remaining = document.querySelectorAll('.attachment-badge');
      expect(remaining).toHaveLength(2);
      expect(remaining[0].querySelector('[data-testid="attachment-tag-1"]')?.textContent).toBe('#1');
      expect(remaining[0].querySelector('.attachment-badge-name')?.textContent).toBe('a.png');
      expect(remaining[1].querySelector('[data-testid="attachment-tag-2"]')?.textContent).toBe('#2');
      expect(remaining[1].querySelector('.attachment-badge-name')?.textContent).toBe('c.png');
    });
  });

  it('restores uploaded attachment badges when switching back to the same main session', async () => {
    uploadFileMock.mockResolvedValue({ attachment: { daemonPath: '/tmp/persisted-attachment.txt' } });
    const ws = makeWs();
    const { rerender } = render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'session-a' })}
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    fireEvent.paste(input, {
      clipboardData: {
        getData: (type: string) => type === 'text/plain' ? 'x'.repeat(1300) : '',
      },
    });

    await waitFor(() => {
      expect(document.querySelector('.attachment-badge-name')?.textContent).toMatch(/^pasted-text-.*\.txt$/);
    });
    const badgeName = document.querySelector('.attachment-badge-name')?.textContent ?? '';

    rerender(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'session-b' })}
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    expect(document.querySelector('.attachment-badge-name')).toBeNull();

    rerender(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'session-a' })}
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('.attachment-badge-name')?.textContent).toBe(badgeName);
    });
  });

  it('restores uploaded attachment badges when switching back to the same sub-session', async () => {
    uploadFileMock.mockResolvedValue({ attachment: { daemonPath: '/tmp/persisted-sub-attachment.txt' } });
    const ws = makeWs();
    const { rerender } = render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'deck_sub_sub-1' })}
        subSessionId="sub-1"
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    fireEvent.paste(input, {
      clipboardData: {
        getData: (type: string) => type === 'text/plain' ? 'x'.repeat(1300) : '',
      },
    });

    await waitFor(() => {
      expect(document.querySelector('.attachment-badge-name')?.textContent).toMatch(/^pasted-text-.*\.txt$/);
    });
    const badgeName = document.querySelector('.attachment-badge-name')?.textContent ?? '';

    rerender(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'deck_sub_sub-2' })}
        subSessionId="sub-2"
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    expect(document.querySelector('.attachment-badge-name')).toBeNull();

    rerender(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'deck_sub_sub-1' })}
        subSessionId="sub-1"
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('.attachment-badge-name')?.textContent).toBe(badgeName);
    });
  });

  it('keeps an in-flight upload bound to its original composer when switching windows', async () => {
    let resolveUpload: ((value: { attachment: { daemonPath: string } }) => void) | null = null;
    uploadFileMock.mockImplementation(() => new Promise((resolve) => {
      resolveUpload = resolve;
    }));
    const ws = makeWs();
    const { rerender } = render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'deck_sub_upload-1' })}
        subSessionId="upload-1"
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    fireEvent.paste(input, {
      clipboardData: {
        files: [new File(['large'], 'large.bin')],
        getData: () => '',
      },
    });
    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(1));

    rerender(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'deck_sub_upload-2' })}
        subSessionId="upload-2"
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );
    expect(document.querySelector('.attachment-badge-name')).toBeNull();

    await act(async () => {
      resolveUpload?.({ attachment: { daemonPath: '/tmp/large.bin' } });
    });

    rerender(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'deck_sub_upload-1' })}
        subSessionId="upload-1"
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('.attachment-badge-name')?.textContent).toBe('large.bin');
    });
  });

  it('does not clear stored attachments when another control surface mounts for the same sub-session', async () => {
    uploadFileMock.mockResolvedValue({ attachment: { daemonPath: '/tmp/shared-sub-attachment.txt' } });
    const ws = makeWs();
    const first = render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'deck_sub_shared' })}
        subSessionId="sub-shared"
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    const input = within(first.container).getByRole('textbox') as HTMLDivElement;
    fireEvent.paste(input, {
      clipboardData: {
        getData: (type: string) => type === 'text/plain' ? 'x'.repeat(1300) : '',
      },
    });

    await waitFor(() => {
      expect(first.container.querySelector('.attachment-badge-name')?.textContent).toMatch(/^pasted-text-.*\.txt$/);
    });
    const badgeName = first.container.querySelector('.attachment-badge-name')?.textContent ?? '';

    const second = render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({ name: 'deck_sub_shared' })}
        subSessionId="sub-shared"
        quickData={makeQuickData() as any}
        serverId="srv-1"
      />,
    );

    await waitFor(() => {
      expect(second.container.querySelector('.attachment-badge-name')?.textContent).toBe(badgeName);
    });
    expect(first.container.querySelector('.attachment-badge-name')?.textContent).toBe(badgeName);
  });

  it('blocks oversized plain-text paste when upload context is unavailable', async () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={makeSession()}
        quickData={makeQuickData() as any}
      />,
    );

    const input = screen.getByRole('textbox') as HTMLDivElement;
    input.focus();
    fireEvent.paste(input, {
      clipboardData: {
        getData: (type: string) => type === 'text/plain' ? 'y'.repeat(13000) : '',
      },
    });

    expect(uploadFileMock).not.toHaveBeenCalled();
    expect(execCommandMock).not.toHaveBeenCalled();
    expect(input.textContent).toBe('');
    expect(await screen.findByText('Paste is too large for inline input here. Upload it as a file instead.')).toBeDefined();
  });

  it('uses the shared 2GB upload limit for user-facing size calculations', () => {
    expect(FILE_TRANSFER_LIMITS.MAX_FILE_SIZE).toBe(2 * 1024 * 1024 * 1024);
    expect(Math.round(FILE_TRANSFER_LIMITS.MAX_FILE_SIZE / (1024 * 1024))).toBe(2048);
  });

  // TODO: fix — file upload mock doesn't trigger state update in jsdom
  describe.skip('attachment badges', () => {
    it('shows badge after file upload', async () => {
      uploadFileMock.mockResolvedValue({ attachment: { daemonPath: '/tmp/test.txt' } });
      render(
        <SessionControls
          ws={makeWs() as any}
          activeSession={makeSession()}
          quickData={makeQuickData() as any}
          serverId="srv-1"
        />,
      );
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['hello'], 'test.txt', { type: 'text/plain' });
      Object.defineProperty(fileInput, 'files', { value: [file] });
      fireEvent.change(fileInput);
      // Wait for async upload
      await vi.waitFor(() => {
        expect(screen.getByText('test.txt')).toBeDefined();
      });
      // Badge should exist
      expect(document.querySelector('.attachment-badge')).toBeTruthy();
    });

    it('removes badge when × is clicked', async () => {
      uploadFileMock.mockResolvedValue({ attachment: { daemonPath: '/tmp/remove-me.txt' } });
      render(
        <SessionControls
          ws={makeWs() as any}
          activeSession={makeSession()}
          quickData={makeQuickData() as any}
          serverId="srv-1"
        />,
      );
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['data'], 'remove-me.txt', { type: 'text/plain' });
      Object.defineProperty(fileInput, 'files', { value: [file] });
      fireEvent.change(fileInput);
      await vi.waitFor(() => {
        expect(screen.getByText('remove-me.txt')).toBeDefined();
      });
      // Click × to remove
      const removeBtn = document.querySelector('.attachment-badge-remove') as HTMLButtonElement;
      fireEvent.click(removeBtn);
      expect(document.querySelector('.attachment-badge')).toBeNull();
    });

    it('prepends @path references on send', async () => {
      uploadFileMock.mockResolvedValue({ attachment: { daemonPath: '/tmp/data.csv' } });
      const ws = makeWs();
      render(
        <SessionControls
          ws={ws as any}
          activeSession={makeSession({ name: 'my-session' })}
          quickData={makeQuickData() as any}
          serverId="srv-1"
        />,
      );
      // Upload file
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['csv'], 'data.csv', { type: 'text/csv' });
      Object.defineProperty(fileInput, 'files', { value: [file] });
      fireEvent.change(fileInput);
      await vi.waitFor(() => {
        expect(screen.getByText('data.csv')).toBeDefined();
      });
      // Type message
      const input = screen.getByRole('textbox') as HTMLDivElement;
      input.textContent = 'analyze this';
      fireEvent.input(input);
      // Send
      fireEvent.click(screen.getByRole('button', { name: /send/i }));
      expectSendPayload(ws, {
        sessionName: 'my-session',
        text: '@/tmp/data.csv analyze this',
      });
    });

    it('send enabled with attachment but no text', async () => {
      uploadFileMock.mockResolvedValue({ attachment: { daemonPath: '/tmp/file.txt' } });
      render(
        <SessionControls
          ws={makeWs() as any}
          activeSession={makeSession()}
          quickData={makeQuickData() as any}
          serverId="srv-1"
        />,
      );
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['x'], 'file.txt', { type: 'text/plain' });
      Object.defineProperty(fileInput, 'files', { value: [file] });
      fireEvent.change(fileInput);
      await vi.waitFor(() => {
        expect(screen.getByText('file.txt')).toBeDefined();
      });
      const sendBtn = screen.getByRole('button', { name: /send/i }) as HTMLButtonElement;
      expect(sendBtn.disabled).toBe(false);
    });

    it('clears badges after send', async () => {
      uploadFileMock.mockResolvedValue({ attachment: { daemonPath: '/tmp/gone.txt' } });
      const ws = makeWs();
      render(
        <SessionControls
          ws={ws as any}
          activeSession={makeSession()}
          quickData={makeQuickData() as any}
          serverId="srv-1"
        />,
      );
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['x'], 'gone.txt', { type: 'text/plain' });
      Object.defineProperty(fileInput, 'files', { value: [file] });
      fireEvent.change(fileInput);
      await vi.waitFor(() => {
        expect(screen.getByText('gone.txt')).toBeDefined();
      });
      // Send (with attachment only, no text)
      fireEvent.click(screen.getByRole('button', { name: /send/i }));
      expect(document.querySelector('.attachment-badge')).toBeNull();
    });

    it('sends a full P2P command immediately for one @-picked target', () => {
      const ws = makeWs();
      render(
        <SessionControls
          ws={ws as any}
          activeSession={mainSession}
          quickData={makeQuickData() as any}
          sessions={[mainSession]}
          subSessions={[
            { sessionName: 'deck_sub_w1', type: 'codex', label: 'w1', state: 'idle', parentSession: 'deck_my-project_brain' },
          ]}
        />,
      );
      const input = screen.getByRole('textbox') as HTMLDivElement;
      const getSelectionSpy = vi.spyOn(window, 'getSelection').mockImplementation(() => ({
        anchorOffset: input.textContent?.length ?? 0,
      }) as any);

      input.textContent = '@';
      fireEvent.input(input);
      fireEvent.click(screen.getByText('agents'));
      fireEvent.click(screen.getByText('w1'));
      input.textContent = 'please review';
      fireEvent.input(input);
      fireEvent.click(screen.getByRole('button', { name: /send/i }));

      const sent = gatherSendCalls(ws).at(-1)!;
      expect(sent).toMatchObject({ sessionName: 'deck_my-project_brain' });
      expect(sent.text).toContain('Exact delegate target session: deck_sub_w1');
      expect(sent.text).toContain('User task to delegate:\nplease review');
      expect(sent).not.toHaveProperty('delegateTarget');
      expect(screen.queryByText('title')).toBeNull();

      getSelectionSpy.mockRestore();
    });

    it('sends a full P2P command immediately for handwritten single-agent @@ targets', () => {
      const ws = makeWs();
      render(
        <SessionControls
          ws={ws as any}
          activeSession={mainSession}
          quickData={makeQuickData() as any}
          sessions={[mainSession]}
          subSessions={[
            { sessionName: 'deck_sub_w1', type: 'codex', label: 'w1', state: 'idle', parentSession: 'deck_my-project_brain' },
          ]}
        />,
      );
      const input = screen.getByRole('textbox') as HTMLDivElement;
      input.textContent = '@@w1(audit) please review';
      fireEvent.input(input);
      fireEvent.click(screen.getByRole('button', { name: /send/i }));

      expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
        sessionName: 'deck_my-project_brain',
        text: 'please review',
        p2pAtTargets: [
          { session: 'deck_sub_w1', mode: 'audit' },
        ],
      }));
      expect(screen.queryByText('title')).toBeNull();
    });

    it('does not show any warning for @@all', () => {
      const ws = makeWs();
      render(
        <SessionControls
          ws={ws as any}
          activeSession={mainSession}
          quickData={makeQuickData() as any}
          sessions={[mainSession]}
          subSessions={[
            { sessionName: 'deck_sub_w1', type: 'codex', label: 'w1', state: 'idle', parentSession: 'deck_my-project_brain' },
            { sessionName: 'deck_sub_w2', type: 'gemini', label: 'w2', state: 'idle', parentSession: 'deck_my-project_brain' },
          ]}
        />,
      );
      const input = screen.getByRole('textbox') as HTMLDivElement;
      input.textContent = '@@all(audit) please review';
      fireEvent.input(input);
      fireEvent.click(screen.getByRole('button', { name: /send/i }));

      expect(screen.queryByText('title')).toBeNull();
      expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
        sessionName: 'deck_my-project_brain',
        text: 'please review',
      }));
    });
  });


  it('shows the same transport controls for sub-sessions as main sessions', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'codex-sdk-sub',
          agentType: 'codex-sdk',
          runtimeType: 'transport',
          effort: 'high',
          state: 'running',
          quotaLabel: '5h 11% 2h03m 4/6 14:40 · 7d 50% 1d04h 4/8 15:48',
        })}
        quickData={makeQuickData() as any}
        onSubStop={vi.fn()}
        onSubRestart={vi.fn()}
        onSubNew={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /^Stop$/ })).toBeDefined();
    expect(screen.getByTitle('actions')).toBeDefined();
    expect(screen.getByRole('button', { name: /^high$/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /^default$/i })).toBeDefined();
  });

  it('opens the quick input panel when the quick trigger is clicked', () => {
    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={makeSession({ name: 'my-session' })}
        quickData={makeQuickData() as any}
      />,
    );

    expect(screen.queryByText('quick-panel-send')).toBeNull();
    fireEvent.click(screen.getByTitle('title'));
    expect(screen.getByText('quick-panel-send')).toBeDefined();
  });

  it('shows thinking control for codex-sdk and sends /thinking command', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'codex-sdk-session',
          agentType: 'codex-sdk',
          runtimeType: 'transport',
          effort: 'medium',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^medium$/i }));
    // Menu items render as "○ <Label>" / "● <Label>" with a formatted label
    // (e.g. "○ High", "○ Extra High"). Use an exact string match so we hit
    // "High" and not "Extra High" (which `/high/i` would also match).
    fireEvent.click(screen.getByRole('button', { name: '○ High' }));

    expectSendPayload(ws, {
      sessionName: 'codex-sdk-session',
      text: '/thinking high',
    });
  });

  it('uses saved codex model preference as a legacy fallback for model-less codex-sdk sessions', () => {
    localStorage.setItem('imcodes-codex-model', 'gpt-5.5');

    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={makeSession({
          name: 'codex-sdk-session',
          agentType: 'codex-sdk',
          runtimeType: 'transport',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    expect(screen.getByRole('button', { name: /^gpt-5.5$/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /^default$/i })).toBeNull();
  });

  it('does not let saved codex model preference override confirmed codex-sdk session metadata', () => {
    localStorage.setItem('imcodes-codex-model', 'gpt-5.5');

    render(
      <SessionControls
        ws={makeWs() as any}
        activeSession={makeSession({
          name: 'codex-sdk-session',
          agentType: 'codex-sdk',
          runtimeType: 'transport',
          activeModel: 'gpt-5.4',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    expect(screen.getByRole('button', { name: /^gpt-5.4$/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /^gpt-5.5$/i })).toBeNull();
  });

  it('prefers dynamically discovered codex-sdk models over the static fallback list', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'codex-sdk-session',
          agentType: 'codex-sdk',
          runtimeType: 'transport',
          activeModel: 'gpt-5.4',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    const request = ws.send.mock.calls.find((call) => call[0]?.type === 'transport.list_models')?.[0];
    expect(request).toMatchObject({ type: 'transport.list_models', agentType: 'codex-sdk' });

    act(() => ws.emit({
      type: 'transport.models_response',
      agentType: 'codex-sdk',
      requestId: request?.requestId,
      models: [
        { id: 'gpt-5.5', name: 'GPT-5.5', supportsReasoningEffort: true },
        { id: 'gpt-5.5-mini', name: 'GPT-5.5 Mini' },
      ],
      defaultModel: 'gpt-5.5',
      isAuthenticated: true,
    }));

    fireEvent.click(screen.getByRole('button', { name: /^gpt-5.4$/i }));
    fireEvent.click(screen.getAllByRole('button', { name: /gpt-5.5/i })[0]!);

    expectSendPayload(ws, {
      sessionName: 'codex-sdk-session',
      text: '/model gpt-5.5',
    });
  });

  it('force-refreshes codex-sdk models when opening the picker', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'codex-sdk-session',
          agentType: 'codex-sdk',
          runtimeType: 'transport',
          activeModel: 'gpt-5.4',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    expect(ws.send.mock.calls.find((call) => (
      call[0]?.type === 'transport.list_models'
        && call[0]?.agentType === 'codex-sdk'
        && call[0]?.force === true
    ))).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: /^gpt-5.4$/i }));

    const forcedRequest = ws.send.mock.calls.find((call) => (
      call[0]?.type === 'transport.list_models'
        && call[0]?.agentType === 'codex-sdk'
        && call[0]?.force === true
    ))?.[0];
    expect(forcedRequest).toMatchObject({
      type: 'transport.list_models',
      agentType: 'codex-sdk',
      force: true,
    });

    act(() => ws.emit({
      type: 'transport.models_response',
      agentType: 'codex-sdk',
      requestId: forcedRequest?.requestId,
      models: [
        { id: 'runtime-new-model', name: 'Runtime New Model' },
      ],
      defaultModel: 'runtime-new-model',
      isAuthenticated: true,
    }));

    await waitFor(() => expect(screen.getByRole('button', { name: /runtime-new-model/i })).toBeDefined());
  });

  it('retries codex-sdk model discovery after websocket reconnect', async () => {
    const ws = makeWs();
    ws.connected = false;
    const view = render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'codex-sdk-session',
          agentType: 'codex-sdk',
          runtimeType: 'transport',
          activeModel: 'gpt-5.4',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    expect(ws.send.mock.calls.find((call) => call[0]?.type === 'transport.list_models')).toBeUndefined();

    ws.connected = true;
    view.rerender(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'codex-sdk-session',
          agentType: 'codex-sdk',
          runtimeType: 'transport',
          activeModel: 'gpt-5.4',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    const request = ws.send.mock.calls.find((call) => call[0]?.type === 'transport.list_models')?.[0];
    expect(request).toMatchObject({ type: 'transport.list_models', agentType: 'codex-sdk' });

    act(() => ws.emit({
      type: 'transport.models_response',
      agentType: 'codex-sdk',
      requestId: request?.requestId,
      models: [
        { id: 'gpt-5.5', name: 'GPT-5.5' },
      ],
      defaultModel: 'gpt-5.5',
      isAuthenticated: true,
    }));

    fireEvent.click(screen.getByRole('button', { name: /^gpt-5.4$/i }));
    expect(screen.getByRole('button', { name: /gpt-5.5/i })).toBeDefined();
  });

  it('closes the model selector on outside touchstart before mobile click synthesis', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'codex-sdk-session',
          agentType: 'codex-sdk',
          runtimeType: 'transport',
          activeModel: 'gpt-5.4',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^gpt-5.4$/i }));
    await waitFor(() => expect(document.querySelector('.menu-dropdown')).toBeTruthy());
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.touchStart(document.body);

    await waitFor(() => expect(document.querySelector('.menu-dropdown')).toBeFalsy());
  });

  it('shows a model selector for copilot-sdk and sends /model', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'copilot-sdk-session',
          agentType: 'copilot-sdk',
          runtimeType: 'transport',
          activeModel: 'gpt-5.4',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^gpt-5.4$/i }));
    fireEvent.click(screen.getByRole('button', { name: /gpt-5.4-mini/i }));

    expectSendPayload(ws, {
      sessionName: 'copilot-sdk-session',
      text: '/model gpt-5.4-mini',
    });
  });

  it('shows a model selector for gemini-sdk and sends /model', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'gemini-sdk-session',
          agentType: 'gemini-sdk',
          runtimeType: 'transport',
          activeModel: 'gemini-2.5-pro',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^gemini-2.5-pro$/i }));
    const menu = document.querySelector('.menu-dropdown') as HTMLElement;
    fireEvent.click(within(menu).getByRole('button', { name: /auto/i }));

    expectSendPayload(ws, {
      sessionName: 'gemini-sdk-session',
      text: '/model auto',
    });
  });

  it('shows a model selector for cursor-headless and sends /model', () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'cursor-headless-session',
          agentType: 'cursor-headless',
          runtimeType: 'transport',
          activeModel: 'gpt-5.2',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^gpt-5.2$/i }));
    fireEvent.click(screen.getAllByRole('button', { name: /gpt-5.2/i })[1]!);

    expectSendPayload(ws, {
      sessionName: 'cursor-headless-session',
      text: '/model gpt-5.2',
    });
  });

  it('shows dynamically discovered gemini-sdk models and sends /model', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'gemini-sdk-session',
          agentType: 'gemini-sdk',
          runtimeType: 'transport',
          activeModel: 'gemini-2.5-pro',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    const request = ws.send.mock.calls.find((call) => call[0]?.type === 'transport.list_models')?.[0];
    expect(request).toMatchObject({ type: 'transport.list_models', agentType: 'gemini-sdk' });

    act(() => ws.emit({
      type: 'transport.models_response',
      agentType: 'gemini-sdk',
      requestId: request?.requestId,
      models: [
        { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
        { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      ],
      defaultModel: 'gemini-2.5-pro',
      isAuthenticated: true,
    }));

    fireEvent.click(screen.getByRole('button', { name: /^gemini-2.5-pro$/i }));
    const menu = document.querySelector('.menu-dropdown') as HTMLElement;
    expect(within(menu).getByRole('button', { name: /auto/i })).toBeDefined();
    fireEvent.click(within(menu).getByRole('button', { name: /gemini-2.5-flash/i }));

    expectSendPayload(ws, {
      sessionName: 'gemini-sdk-session',
      text: '/model gemini-2.5-flash',
    });
  });

  it('force-loads OpenCode SDK models and sends /model from the active session picker', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'opencode-sdk-session',
          agentType: 'opencode-sdk',
          runtimeType: 'transport',
          activeModel: 'opencode/pickle',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    const request = ws.send.mock.calls.find((call) => (
      call[0]?.type === 'transport.list_models'
        && call[0]?.agentType === 'opencode-sdk'
        && call[0]?.force === true
    ))?.[0];
    expect(request).toMatchObject({
      type: 'transport.list_models',
      agentType: 'opencode-sdk',
      force: true,
    });

    act(() => ws.emit({
      type: 'transport.models_response',
      agentType: 'opencode-sdk',
      requestId: request?.requestId,
      models: [
        { id: 'opencode/pickle', name: 'OpenCode · Pickle' },
        { id: 'anthropic/claude-sonnet-4-5', name: 'Anthropic · Claude Sonnet 4.5' },
      ],
      defaultModel: 'opencode/pickle',
      isAuthenticated: true,
    }));

    fireEvent.click(screen.getByRole('button', { name: /^opencode\/pickle$/i }));
    const menu = document.querySelector('.menu-dropdown') as HTMLElement;
    fireEvent.click(within(menu).getByRole('button', { name: /anthropic\/claude-sonnet-4-5/i }));

    expectSendPayload(ws, {
      sessionName: 'opencode-sdk-session',
      text: '/model anthropic/claude-sonnet-4-5',
    });
  });

  it('shows dynamically discovered kimi-sdk models and sends /model', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'kimi-sdk-session',
          agentType: 'kimi-sdk',
          runtimeType: 'transport',
          activeModel: 'moonshot-v1-auto',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    const request = ws.send.mock.calls.find((call) => call[0]?.type === 'transport.list_models')?.[0];
    expect(request).toMatchObject({ type: 'transport.list_models', agentType: 'kimi-sdk' });

    act(() => ws.emit({
      type: 'transport.models_response',
      agentType: 'kimi-sdk',
      requestId: request?.requestId,
      models: [
        { id: 'moonshot-v1-auto', name: 'Moonshot Auto' },
        { id: 'moonshot-v1-auto,thinking', name: 'Moonshot Auto Thinking' },
      ],
      defaultModel: 'moonshot-v1-auto,thinking',
      isAuthenticated: true,
    }));

    fireEvent.click(screen.getByRole('button', { name: /^moonshot-v1-auto$/i }));
    const menu = document.querySelector('.menu-dropdown') as HTMLElement;
    fireEvent.click(within(menu).getByRole('button', { name: /moonshot-v1-auto,thinking/i }));

    expectSendPayload(ws, {
      sessionName: 'kimi-sdk-session',
      text: '/model moonshot-v1-auto,thinking',
    });
  });

  it('shows only dynamically discovered grok-sdk models and sends /model', async () => {
    const ws = makeWs();
    render(
      <SessionControls
        ws={ws as any}
        activeSession={makeSession({
          name: 'grok-sdk-session',
          agentType: 'grok-sdk',
          runtimeType: 'transport',
          activeModel: 'grok-build',
        })}
        quickData={makeQuickData() as any}
      />,
    );

    const request = ws.send.mock.calls.find((call) => call[0]?.type === 'transport.list_models')?.[0];
    expect(request).toMatchObject({ type: 'transport.list_models', agentType: 'grok-sdk' });

    act(() => ws.emit({
      type: 'transport.models_response',
      agentType: 'grok-sdk',
      requestId: request?.requestId,
      models: [
        { id: 'grok-build', name: 'Grok Build' },
        { id: 'grok-build-fast', name: 'Grok Build Fast' },
      ],
      defaultModel: 'grok-build',
      isAuthenticated: true,
    }));

    fireEvent.click(screen.getByRole('button', { name: /^grok-build$/i }));
    const menu = document.querySelector('.menu-dropdown') as HTMLElement;
    fireEvent.click(within(menu).getByRole('button', { name: /grok-build-fast/i }));

    expectSendPayload(ws, {
      sessionName: 'grok-sdk-session',
      text: '/model grok-build-fast',
    });
  });

  // ── dedicated-execution-clone-sessions: generic launcher moved to footer ─────
  describe('generic execution-clone launcher placement', () => {
    it('does not render the old input-side 🤖 execution dropdown', async () => {
      getUserPrefMock.mockResolvedValue(null);
      render(
        <SessionControls
          ws={makeWs() as any}
          activeSession={makeSession({ name: 'deck_proj_brain', role: 'brain' })}
          quickData={makeQuickData() as any}
          serverId="srv-exec"
          subSessions={[] as any}
        />,
      );
      await flushAsync();
      expect(screen.queryByLabelText('execution_session')).toBeNull();
      expect(screen.queryByTestId('exec-menu-use-configured')).toBeNull();
      expect(screen.queryByTestId('exec-menu-set-session')).toBeNull();
    });
  });
});
