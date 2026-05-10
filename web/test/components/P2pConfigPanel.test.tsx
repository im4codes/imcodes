/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/preact';

// Swappable translator so individual tests can verify translated rendering
// against a real locale dictionary (e.g. zh-CN). Default behaviour matches
// the previous mock — fallback string, then last segment of the key.
type TranslatorFn = (key: string, fallback?: string) => string;
const DEFAULT_TRANSLATOR: TranslatorFn = (key, fallback) => fallback ?? key.split('.').pop() ?? key;
let currentTranslator: TranslatorFn = DEFAULT_TRANSLATOR;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => currentTranslator(key, fallback),
  }),
}));

const getUserPrefMock = vi.fn();
const saveUserPrefMock = vi.fn();
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
  getUserPref: (...args: unknown[]) => getUserPrefMock(...args),
  saveUserPref: (...args: unknown[]) => saveUserPrefMock(...args),
  onUserPrefChanged: (...args: unknown[]) => onUserPrefChangedMock(...args as Parameters<typeof onUserPrefChangedMock>),
}));

import { P2pConfigPanel, type P2pConfigPanelCapabilitySource } from '../../src/components/P2pConfigPanel.js';
import type { P2pSavedConfig } from '@shared/p2p-modes.js';
import { MAX_P2P_PARTICIPANTS } from '@shared/p2p-config-events.js';
import {
  P2P_WORKFLOW_CAPABILITY_V1,
  P2P_WORKFLOW_KNOWN_SCHEMA_MAX,
  P2P_WORKFLOW_SCHEMA_VERSION,
} from '@shared/p2p-workflow-constants.js';
import type { P2pWorkflowDraft, P2pWorkflowLaunchEnvelope } from '@shared/p2p-workflow-types.js';
import { readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';

/** Build a capability source returning a fresh-now snapshot. Used to satisfy
 *  the advanced launch capability gate when the test's intent is unrelated to
 *  the gate itself (e.g. legacy save/migration regressions). */
function freshCapabilitySource(capabilities: string[] = [P2P_WORKFLOW_CAPABILITY_V1]): P2pConfigPanelCapabilitySource {
  const snapshot = {
    daemonId: 'daemon-test',
    capabilities,
    helloEpoch: 1,
    sentAt: Date.now(),
    observedAt: Date.now(),
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
  };
}

const sessions = [
  { name: 'deck_proj_brain', agentType: 'claude-code-sdk', state: 'running' },
  { name: 'deck_proj_w1', agentType: 'codex', state: 'idle' },
];

const subSessions = [
  { sessionName: 'deck_sub_abc', type: 'qwen', label: 'worker', state: 'running', parentSession: 'deck_proj_brain' },
  { sessionName: 'deck_sub_cli', type: 'codex', label: 'reviewer', state: 'running', parentSession: 'deck_proj_brain' },
  { sessionName: 'deck_sub_def', type: 'shell', label: null, state: 'idle' },
];

function renderPanel(overrides: {
  sessions?: typeof sessions;
  subSessions?: typeof subSessions;
  activeSession?: string;
  serverId?: string | null;
  initialTab?: 'participants' | 'combos' | 'advanced';
  onClose?: () => void;
  onSave?: (cfg: P2pSavedConfig) => void;
  onPersistDaemonConfig?: (scopeSession: string, cfg: P2pSavedConfig) => Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string };
  daemonCapabilitySource?: P2pConfigPanelCapabilitySource | null;
} = {}) {
  // Default to a fresh capability source so the advanced launch gate doesn't
  // accidentally block tests that don't care about it. Pass `null` explicitly
  // to opt out (e.g. tests that exercise the stale-capability path).
  const daemonCapabilitySource = overrides.daemonCapabilitySource === undefined
    ? freshCapabilitySource()
    : overrides.daemonCapabilitySource;
  const props = {
    sessions: overrides.sessions ?? sessions,
    subSessions: overrides.subSessions ?? subSessions,
    activeSession: overrides.activeSession ?? 'deck_proj_brain',
    serverId: overrides.serverId ?? 'srv-main',
    initialTab: overrides.initialTab,
    onClose: overrides.onClose ?? vi.fn(),
    onSave: overrides.onSave ?? vi.fn(),
    onPersistDaemonConfig: overrides.onPersistDaemonConfig,
    daemonCapabilitySource,
  };
  return render(<P2pConfigPanel {...props} />);
}

/** Flush all pending microtasks/promises (async useEffect + nested awaits).
 *  Increased iterations for nested getUserPref fallback chain. */
async function flush() {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const callsForPrefKey = (key: string) => getUserPrefMock.mock.calls.filter((call) => call[0] === key);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('P2pConfigPanel', () => {
  beforeEach(() => {
    getUserPrefMock.mockResolvedValue(null);
    saveUserPrefMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    currentTranslator = DEFAULT_TRANSLATOR;
  });

  it('renders session list excluding shell and script types', async () => {
    renderPanel({
      sessions: [
        { name: 'deck_proj_brain', agentType: 'claude-code-sdk', state: 'running' },
        { name: 'deck_proj_w1', agentType: 'shell', state: 'idle' },
        { name: 'deck_proj_w2', agentType: 'script', state: 'idle' },
      ],
      subSessions: [],
    });

    // Wait for loading to complete
    await flush();

    // claude-code session should appear by its short name
    expect(screen.getByText('brain')).toBeDefined();

    // shell and script sessions should not appear
    expect(screen.queryByText('w1')).toBeNull();
    expect(screen.queryByText('w2')).toBeNull();
  });

  it('shows loading UI until a cold P2P preference load resolves', async () => {
    const primary = deferred<unknown | null>();
    getUserPrefMock.mockImplementation((key: string) => {
      if (key === 'p2p_session_config:srv-main:deck_proj_brain') return primary.promise;
      return Promise.resolve(null);
    });

    renderPanel();
    expect(screen.getByText('…')).toBeDefined();
    expect(screen.queryByText('brain')).toBeNull();

    await act(async () => {
      primary.resolve(null);
      await primary.promise;
    });
    await flush();
    expect(screen.getByText('brain')).toBeDefined();
  });

  it('excludes shell type from subSessions', async () => {
    renderPanel();
    await flush();

    // gemini sub-session with label 'worker' should appear
    expect(screen.getByText('worker')).toBeDefined();

    // shell sub-session 'deck_sub_def' should not appear (short name would be 'def')
    expect(screen.queryByText('def')).toBeNull();
  });

  it('shows rounds selector with buttons for 1, 2, 3, 5', async () => {
    renderPanel();
    await flush();

    // ROUND_OPTIONS = [1, 2, 3, 5]
    const buttons = screen.getAllByRole('button');
    const roundButtons = buttons.filter((b) => ['1', '2', '3', '5'].includes(b.textContent ?? ''));
    expect(roundButtons.length).toBe(4);
  });

  it('loads saved rounds from getUserPref on mount', async () => {
    const savedConfig: P2pSavedConfig = {
      sessions: {},
      rounds: 5,
    };
    getUserPrefMock.mockResolvedValue(JSON.stringify(savedConfig));

    renderPanel();
    await flush();

    // Round button 5 should be active (has blue border style)
    // We verify by checking the button exists and was set
    const buttons = screen.getAllByRole('button');
    const btn5 = buttons.find((b) => b.textContent === '5');
    expect(btn5).toBeDefined();
  });

  it('defaults hop timeout to 8 minutes for new configs', async () => {
    const onSave = vi.fn();
    renderPanel({ onSave });
    await flush();

    const timeoutInput = screen.getByRole('spinbutton') as HTMLInputElement;
    expect(timeoutInput.value).toBe('8');

    const saveBtn = screen.getByText('settings_save');
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await flush();

    const cfg: P2pSavedConfig = onSave.mock.calls[0][0];
    expect(cfg.hopTimeoutMinutes).toBe(8);
  });

  it('calls onSave with correct config shape when save is clicked', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    // Use sub-sessions with parentSession matching activeSession
    renderPanel({
      onSave, onClose,
      subSessions: [
        { sessionName: 'deck_sub_abc', type: 'gemini', label: 'worker', state: 'running', parentSession: 'deck_proj_brain' },
        { sessionName: 'deck_sub_def', type: 'shell', label: null, state: 'idle', parentSession: 'deck_proj_brain' },
      ],
    });
    await flush();

    const saveBtn = screen.getByText('settings_save');
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await flush();

    expect(onSave).toHaveBeenCalledOnce();
    const cfg: P2pSavedConfig = onSave.mock.calls[0][0];

    // Active session + eligible sub-sessions should be in config
    expect(cfg.sessions['deck_proj_brain']).toBeDefined();
    expect(cfg.sessions['deck_sub_abc']).toBeDefined();
    // shell sub-session should not be included
    expect(cfg.sessions['deck_sub_def']).toBeUndefined();
    expect(typeof cfg.rounds).toBe('number');
  });

  it('preserves loaded session modes when saving', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    getUserPrefMock.mockImplementation(async (key: string) => {
      if (key === 'p2p_session_config:srv-main:deck_proj_brain') {
        return JSON.stringify({ sessions: { deck_proj_brain: { enabled: true, mode: 'audit' } }, rounds: 3 });
      }
      return null;
    });
    renderPanel({ onSave, onClose });
    await flush();

    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect(selects.length).toBeGreaterThan(0);

    const saveBtn = screen.getByText('settings_save');
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await flush();

    const cfg: P2pSavedConfig = onSave.mock.calls[0][0];
    expect(cfg.sessions.deck_proj_brain).toMatchObject({ enabled: true, mode: 'audit' });
  }, 15_000);

  it('calls onClose when the close button (✕) is clicked', async () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    await flush();

    // The ✕ button in the header
    const closeBtn = screen.getByText('✕');
    fireEvent.click(closeBtn);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when the secondary close button in footer is clicked', async () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    await flush();

    const cancelBtn = screen.getByText('settings_close');
    fireEvent.click(cancelBtn);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('can open directly on the combos tab', async () => {
    renderPanel({ initialTab: 'combos' });
    await flush();

    expect(screen.getByText('+mode_brainstorm')).toBeDefined();
    expect(screen.queryByText('brain')).toBeNull();
  });

  // ── R3 v2 PR-θ — dedicated advanced workflow tab ─────────────────────────
  describe('advanced workflow tab', () => {
    it('exposes the advanced workflow tab button on every panel mount', async () => {
      renderPanel();
      await flush();

      const tabButton = screen.getByTestId('p2p-tab-advanced');
      expect(tabButton).toBeDefined();
      expect(tabButton.tagName).toBe('BUTTON');
    });

    it('clicking the advanced tab on a fresh panel auto-bootstraps a starter draft and renders the canvas', async () => {
      // Cold panel — no saved config, no draft, no preset.
      getUserPrefMock.mockResolvedValue(null);
      renderPanel();
      await flush();

      // Initially, the canvas is NOT in the DOM (we are on participants tab
      // and there is no draft yet).
      expect(screen.queryByTestId('p2p-editor-canvas')).toBeNull();

      // Click into the advanced tab.
      await act(async () => {
        fireEvent.click(screen.getByTestId('p2p-tab-advanced'));
      });
      await flush();

      // After tab switch the bootstrap effect runs and a starter draft is
      // injected. The canvas root + a single seed node MUST be rendered.
      expect(screen.getByTestId('p2p-editor-canvas')).toBeDefined();
      expect(screen.getByTestId('p2p-editor-node-shape-node_1')).toBeDefined();

      // The participants tab content (agent grid header, rounds, hop-timeout)
      // must NOT be in the DOM — we have switched away.
      expect(screen.queryByText('settings_rounds')).toBeNull();
      expect(screen.queryByText('settings_hop_timeout')).toBeNull();
    });

    it('opening the panel directly with initialTab=advanced renders the canvas immediately', async () => {
      getUserPrefMock.mockResolvedValue(null);
      renderPanel({ initialTab: 'advanced' });
      await flush();

      // Bootstrap fires synchronously on mount when activeTab is 'advanced'.
      expect(screen.getByTestId('p2p-editor-canvas')).toBeDefined();
      expect(screen.getByTestId('p2p-editor-node-shape-node_1')).toBeDefined();
    });

    it('participants tab no longer hosts the canvas, allowed-executables section, or workflow banners', async () => {
      // A draft is loaded — under the old layout this would surface the
      // canvas + banners on the participants tab. Under the new layout it
      // must NOT, because all advanced UI lives under the advanced tab.
      const draft: P2pWorkflowDraft = {
        schemaVersion: P2P_WORKFLOW_SCHEMA_VERSION,
        id: 'draft-x',
        title: 'X',
        nodes: [{ id: 'a', title: 'A', nodeKind: 'llm', preset: 'discuss', permissionScope: 'analysis_only' }],
        edges: [],
      };
      getUserPrefMock.mockResolvedValue(JSON.stringify({ sessions: {}, rounds: 1, workflowDraft: draft }));

      renderPanel({ initialTab: 'participants' });
      await flush();

      expect(screen.queryByTestId('p2p-editor-canvas')).toBeNull();
      expect(screen.queryByTestId('p2p-allowed-executables-section')).toBeNull();
      expect(screen.queryByTestId('p2p-future-schema-banner')).toBeNull();
      expect(screen.queryByTestId('p2p-capability-stale-banner')).toBeNull();
      expect(screen.queryByTestId('p2p-missing-capability-banner')).toBeNull();
    });
  });

  // ── R3 v2 PR-ι — workflow library (multi-workflow CRUD) ─────────────────
  describe('workflow library', () => {
    it('renders the library section + active badge after the canvas auto-bootstraps', async () => {
      getUserPrefMock.mockResolvedValue(null);
      renderPanel({ initialTab: 'advanced' });
      await flush();

      // Bootstrap effect synthesises one starter workflow → library has one entry.
      const section = screen.getByTestId('p2p-workflow-library-section');
      expect(section).toBeDefined();
      const list = screen.getByTestId('p2p-workflow-library-list');
      expect(list.querySelectorAll('li').length).toBe(1);
      // The single entry is active.
      const entries = list.querySelectorAll('li');
      expect(entries[0].getAttribute('data-active')).toBe('true');
      // Delete is disabled for a single-entry library (cannot delete the last).
      const deleteBtn = screen.getByTestId('p2p-workflow-library-delete') as HTMLButtonElement;
      expect(deleteBtn.disabled).toBe(true);
    });

    it('clicking + New adds a second workflow, activates it, and persists both through Save', async () => {
      const onSave = vi.fn();
      getUserPrefMock.mockResolvedValue(null);
      renderPanel({ initialTab: 'advanced', onSave });
      await flush();

      await act(async () => {
        fireEvent.click(screen.getByTestId('p2p-workflow-library-new'));
      });
      await flush();

      const list = screen.getByTestId('p2p-workflow-library-list');
      const entries = Array.from(list.querySelectorAll('li'));
      expect(entries).toHaveLength(2);
      // The second one auto-activates.
      expect(entries[1].getAttribute('data-active')).toBe('true');
      expect(entries[0].getAttribute('data-active')).toBe('false');

      // Save and inspect the persisted shape.
      await act(async () => {
        fireEvent.click(screen.getByText('settings_save'));
      });
      await flush();
      const cfg: P2pSavedConfig = onSave.mock.calls[0][0];
      expect(cfg.workflowLibrary?.length).toBe(2);
      expect(cfg.activeWorkflowId).toBeDefined();
      // The persisted active id should match the second library entry.
      expect(cfg.activeWorkflowId).toBe(cfg.workflowLibrary?.[1]?.id);
      // Legacy mirror is set so older clients can still launch.
      expect(cfg.workflowDraft?.id).toBe(cfg.activeWorkflowId);
    });

    it('clicking a non-active library entry switches the canvas + active id', async () => {
      const onSave = vi.fn();
      getUserPrefMock.mockResolvedValue(null);
      renderPanel({ initialTab: 'advanced', onSave });
      await flush();
      await act(async () => {
        fireEvent.click(screen.getByTestId('p2p-workflow-library-new'));
      });
      await flush();

      // Now click the FIRST entry to switch back.
      const list = screen.getByTestId('p2p-workflow-library-list');
      const entries = Array.from(list.querySelectorAll('li'));
      await act(async () => {
        fireEvent.click(entries[0]);
      });
      await flush();
      const updated = Array.from(screen.getByTestId('p2p-workflow-library-list').querySelectorAll('li'));
      expect(updated[0].getAttribute('data-active')).toBe('true');
      expect(updated[1].getAttribute('data-active')).toBe('false');
    });

    it('Duplicate clones the active workflow with a copy suffix', async () => {
      const onSave = vi.fn();
      getUserPrefMock.mockResolvedValue(null);
      renderPanel({ initialTab: 'advanced', onSave });
      await flush();
      // Rename so we can assert the suffix attaches to the right title.
      const nameInput = screen.getByTestId('p2p-workflow-name-input') as HTMLInputElement;
      await act(async () => {
        fireEvent.input(nameInput, { target: { value: 'Audit pipeline' } });
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('p2p-workflow-library-duplicate'));
      });
      await flush();
      const list = screen.getByTestId('p2p-workflow-library-list');
      const titles = Array.from(list.querySelectorAll('li > span')).map((s) => s.textContent);
      expect(titles).toContain('Audit pipeline');
      // Find the copy: the test translator returns the LAST segment of the
      // i18n key as the rendered text, so the suffix here resolves to the
      // raw English fallback because the translator just echoes the key.
      expect(titles.some((t) => t?.includes('Audit pipeline'))).toBe(true);
      // After Duplicate, the second list entry is active.
      const entries = Array.from(list.querySelectorAll('li'));
      expect(entries[1].getAttribute('data-active')).toBe('true');
    });

    it('Delete removes the active workflow and promotes the first remaining entry', async () => {
      const onSave = vi.fn();
      getUserPrefMock.mockResolvedValue(null);
      // Stub confirm so the test does not get a JSDOM "not implemented" warning.
      const originalConfirm = window.confirm;
      window.confirm = () => true;
      try {
        renderPanel({ initialTab: 'advanced', onSave });
        await flush();
        await act(async () => {
          fireEvent.click(screen.getByTestId('p2p-workflow-library-new'));
        });
        await flush();
        // Now library has 2; delete should not be disabled.
        const deleteBtn = screen.getByTestId('p2p-workflow-library-delete') as HTMLButtonElement;
        expect(deleteBtn.disabled).toBe(false);
        await act(async () => {
          fireEvent.click(deleteBtn);
        });
        await flush();
        const list = screen.getByTestId('p2p-workflow-library-list');
        expect(list.querySelectorAll('li')).toHaveLength(1);
      } finally {
        window.confirm = originalConfirm;
      }
    });

    it('renaming an active workflow updates the title input AND the library list label', async () => {
      const onSave = vi.fn();
      getUserPrefMock.mockResolvedValue(null);
      renderPanel({ initialTab: 'advanced', onSave });
      await flush();
      const nameInput = screen.getByTestId('p2p-workflow-name-input') as HTMLInputElement;
      await act(async () => {
        fireEvent.input(nameInput, { target: { value: 'My audit flow' } });
      });
      await flush();
      // List entry text should now reflect the rename.
      const list = screen.getByTestId('p2p-workflow-library-list');
      const titles = Array.from(list.querySelectorAll('li > span')).map((s) => s.textContent);
      expect(titles).toContain('My audit flow');
      // The input value should also be the rename (not the bootstrap default).
      expect((screen.getByTestId('p2p-workflow-name-input') as HTMLInputElement).value).toBe('My audit flow');
      // Save and confirm the persisted active workflow carries the new title.
      await act(async () => {
        fireEvent.click(screen.getByText('settings_save'));
      });
      await flush();
      const cfg: P2pSavedConfig = onSave.mock.calls[0][0];
      const active = cfg.workflowLibrary?.find((e) => e.id === cfg.activeWorkflowId);
      expect(active?.title).toBe('My audit flow');
    });

    it('hydrates a previously-saved library + activeWorkflowId from saved config', async () => {
      const a: P2pWorkflowDraft = {
        schemaVersion: P2P_WORKFLOW_SCHEMA_VERSION,
        id: 'wf_a',
        title: 'Alpha',
        nodes: [{ id: 'n1', title: 'N', nodeKind: 'llm', preset: 'discuss', permissionScope: 'analysis_only' }],
        edges: [],
        rootNodeId: 'n1',
      };
      const b: P2pWorkflowDraft = { ...a, id: 'wf_b', title: 'Beta' };
      const savedConfig: P2pSavedConfig = {
        sessions: {},
        rounds: 1,
        workflowLibrary: [a, b],
        activeWorkflowId: 'wf_b',
      };
      getUserPrefMock.mockResolvedValue(JSON.stringify(savedConfig));
      renderPanel({ initialTab: 'advanced' });
      await flush();
      const list = screen.getByTestId('p2p-workflow-library-list');
      const entries = Array.from(list.querySelectorAll('li'));
      expect(entries.map((e) => e.getAttribute('data-testid'))).toEqual([
        'p2p-workflow-library-entry-wf_a',
        'p2p-workflow-library-entry-wf_b',
      ]);
      // wf_b is active per saved activeWorkflowId.
      expect(entries[1].getAttribute('data-active')).toBe('true');
      // Title input mirrors the active workflow title.
      const nameInput = screen.getByTestId('p2p-workflow-name-input') as HTMLInputElement;
      expect(nameInput.value).toBe('Beta');
    });
  });

  it('new sessions not in saved config default to disabled with audit mode', async () => {
    const savedConfig: P2pSavedConfig = {
      sessions: {}, // no prior config for any session
      rounds: 1,
    };
    getUserPrefMock.mockResolvedValue(JSON.stringify(savedConfig));

    const onSave = vi.fn();
    const onClose = vi.fn();

    renderPanel({ onSave, onClose });
    await flush();

    // Checkboxes should all be unchecked (enabled=false by default for new sessions)
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes.length).toBeGreaterThan(0);
    for (const cb of checkboxes) {
      expect(cb.checked).toBe(false);
    }

    // All selects should default to 'audit'
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    for (const sel of selects) {
      expect(sel.value).toBe('audit');
    }
  });

  it('toggling a checkbox flips enabled state in saved config', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    renderPanel({ onSave, onClose });
    await flush();

    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    // New sessions default to unchecked (enabled=false)
    expect(checkboxes[0].checked).toBe(false);

    // Check the first session (toggle from disabled to enabled)
    fireEvent.click(checkboxes[0]);
    expect(checkboxes[0].checked).toBe(true);

    const saveBtn = screen.getByText('settings_save');
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await flush();

    const cfg: P2pSavedConfig = onSave.mock.calls[0][0];
    const firstKey = Object.keys(cfg.sessions)[0];
    expect(cfg.sessions[firstKey].enabled).toBe(true);
  }, 15_000);

  it('ignores stale saved participants when enforcing the checkbox participant cap', async () => {
    const onSave = vi.fn();
    const staleSessions = Object.fromEntries(
      Array.from({ length: MAX_P2P_PARTICIPANTS - 1 }, (_, index) => [
        `deck_old_stale_${index}`,
        { enabled: true, mode: 'audit' },
      ]),
    );
    getUserPrefMock.mockImplementation(async (key: string) => {
      if (key === 'p2p_session_config:srv-main:deck_proj_brain') {
        return JSON.stringify({ sessions: staleSessions, rounds: 3 });
      }
      return null;
    });

    renderPanel({ onSave });
    await flush();

    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes).toHaveLength(2);

    fireEvent.click(checkboxes[0]);
    expect(checkboxes[0].checked).toBe(true);

    // Regression: before the cap counted stale saved entries, this second
    // click was rejected as if five participants were already selected.
    fireEvent.click(checkboxes[1]);
    expect(checkboxes[1].checked).toBe(true);
    expect(screen.queryByText(/P2P is limited/i)).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByText('settings_save'));
    });
    await flush();

    const cfg: P2pSavedConfig = onSave.mock.calls[0][0];
    expect(Object.keys(cfg.sessions).some((key) => key.startsWith('deck_old_stale_'))).toBe(false);
    expect(cfg.sessions.deck_proj_brain.enabled).toBe(true);
    expect(cfg.sessions.deck_sub_abc.enabled).toBe(true);
  }, 15_000);

  it('changing rounds updates the config passed to onSave', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    renderPanel({ onSave, onClose });
    await flush();

    // Click round button "5"
    const roundBtn5 = screen.getAllByRole('button').find((b) => b.textContent === '5');
    expect(roundBtn5).toBeDefined();
    fireEvent.click(roundBtn5!);

    const saveBtn = screen.getByText('settings_save');
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await flush();

    const cfg: P2pSavedConfig = onSave.mock.calls[0][0];
    expect(cfg.rounds).toBe(5);
  }, 15_000);

  it('persists config via saveUserPref on save', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    renderPanel({ onSave, onClose });
    await flush();

    const saveBtn = screen.getByText('settings_save');
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await flush();

    expect(saveUserPrefMock).toHaveBeenCalledOnce();
    expect(saveUserPrefMock.mock.calls[0][0]).toBe('p2p_session_config:srv-main:deck_proj_brain');
    // Second arg should be a JSON string
    const jsonArg = saveUserPrefMock.mock.calls[0][1];
    expect(typeof jsonArg).toBe('string');
    const parsed = JSON.parse(jsonArg);
    expect(parsed).toHaveProperty('sessions');
    expect(parsed).toHaveProperty('rounds');
  });

  it('persists the saved config to the daemon authority path', async () => {
    const onPersistDaemonConfig = vi.fn().mockResolvedValue({ ok: true });
    renderPanel({ onPersistDaemonConfig });
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByText('settings_save'));
    });
    await flush();

    expect(onPersistDaemonConfig).toHaveBeenCalledOnce();
    expect(onPersistDaemonConfig.mock.calls[0][0]).toBe('deck_proj_brain');
    expect(onPersistDaemonConfig.mock.calls[0][1]).toHaveProperty('sessions');
    expect(onPersistDaemonConfig.mock.calls[0][1]).toHaveProperty('updatedAt');
  });

  it('keeps the panel open and shows a warning when server save succeeds but daemon save fails', async () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    const onPersistDaemonConfig = vi.fn().mockResolvedValue({ ok: false, error: 'persist_failed' });
    renderPanel({ onClose, onSave, onPersistDaemonConfig });
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByText('settings_save'));
    });
    await flush();

    expect(saveUserPrefMock).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/local daemon copy failed to update/i)).toBeDefined();
  });

  it('keeps the panel open and shows an error when server save fails', async () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    const onPersistDaemonConfig = vi.fn().mockResolvedValue({ ok: true });
    saveUserPrefMock.mockRejectedValueOnce(new Error('server down'));
    renderPanel({ onClose, onSave, onPersistDaemonConfig });
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByText('settings_save'));
    });
    await flush();

    expect(onPersistDaemonConfig).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/failed to save p2p settings/i)).toBeDefined();
  });

  it('reloads panel state when the session P2P preference changes externally', async () => {
    let prefValue = JSON.stringify({
      sessions: {
        'deck_proj_brain': { enabled: false, mode: 'audit' },
      },
      rounds: 1,
    });
    getUserPrefMock.mockImplementation(async (key: string) => {
      if (key === 'p2p_session_config:srv-main:deck_proj_brain') return prefValue;
      return null;
    });

    renderPanel();
    await flush();

    let checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes[0].checked).toBe(false);

    prefValue = JSON.stringify({
      sessions: {
        'deck_proj_brain': { enabled: true, mode: 'audit' },
      },
      rounds: 1,
    });
    window.dispatchEvent(new CustomEvent('imcodes:user-pref-changed', {
      detail: { key: 'p2p_session_config:srv-main:deck_proj_brain', value: prefValue },
    }));
    await flush();

    checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes[0].checked).toBe(true);
  });

  it('hides the advanced workflow section while the openspec flow is being reworked', async () => {
    renderPanel();
    await flush();

    expect(screen.queryByRole('button', { name: /Advanced workflow/i })).toBeNull();
    expect(screen.queryByLabelText('Advanced preset')).toBeNull();
  });

  it('preserves hidden advanced workflow config when saving', async () => {
    const savedConfig: P2pSavedConfig = {
      sessions: { 'deck_sub_abc': { enabled: true, mode: 'review' } },
      rounds: 2,
      advancedPresetKey: 'openspec',
      advancedRunTimeoutMinutes: 42,
      contextReducer: {
        mode: 'reuse_existing_session',
        sessionName: 'deck_sub_abc',
      },
      advancedRounds: [
        {
          id: 'discussion',
          title: 'Discussion',
          preset: 'discussion',
          executionMode: 'single_main',
          permissionScope: 'analysis_only',
          timeoutMinutes: 5,
        },
      ],
    };
    getUserPrefMock.mockResolvedValue(JSON.stringify(savedConfig));
    const onSave = vi.fn();

    renderPanel({ onSave });
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByText('settings_save'));
    });
    await flush();

    const cfg: P2pSavedConfig = onSave.mock.calls[0][0];
    expect(cfg.workflowDraft).toEqual(expect.objectContaining({ schemaVersion: 1, id: 'old_openspec' }));
    expect(cfg.workflowLaunchEnvelope).toEqual(expect.objectContaining({
      workflowSchemaVersion: 1,
      workflowKind: 'advanced',
      advancedDraft: expect.objectContaining({ id: 'old_openspec' }),
    }));
    expect(cfg.advancedPresetKey).toBeUndefined();
    expect(cfg.advancedRunTimeoutMinutes).toBeUndefined();
    expect(cfg.contextReducer).toBeUndefined();
    expect(cfg.advancedRounds).toBeUndefined();
  });

  it('calls onClose after save completes', async () => {
    const onClose = vi.fn();

    renderPanel({ onClose });
    await flush();

    const saveBtn = screen.getByText('settings_save');
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await flush();

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('uses per-session config key for different sessions', async () => {
    const onSave1 = vi.fn();
    const onSave2 = vi.fn();

    // Session 1
    const { unmount: u1 } = renderPanel({ activeSession: 'deck_proj_brain', onSave: onSave1 });
    await flush();
    expect(getUserPrefMock).toHaveBeenCalledWith('p2p_session_config:srv-main:deck_proj_brain');
    u1();
    cleanup();

    vi.clearAllMocks();
    getUserPrefMock.mockResolvedValue(null);
    saveUserPrefMock.mockResolvedValue(undefined);

    // Session 2 — different key
    renderPanel({ activeSession: 'deck_other_brain', onSave: onSave2 });
    await flush();
    expect(getUserPrefMock).toHaveBeenCalledWith('p2p_session_config:srv-main:deck_other_brain');
  });

  it('uses separate P2P config keys for the same session name on different servers', async () => {
    const { unmount } = renderPanel({ activeSession: 'deck_proj_brain', serverId: 'srv-one' });
    await flush();
    expect(getUserPrefMock).toHaveBeenCalledWith('p2p_session_config:srv-one:deck_proj_brain');
    unmount();
    cleanup();

    vi.clearAllMocks();
    getUserPrefMock.mockResolvedValue(null);
    saveUserPrefMock.mockResolvedValue(undefined);

    renderPanel({ activeSession: 'deck_proj_brain', serverId: 'srv-two' });
    await flush();
    expect(getUserPrefMock).toHaveBeenCalledWith('p2p_session_config:srv-two:deck_proj_brain');
    expect(getUserPrefMock).not.toHaveBeenCalledWith('p2p_session_config:srv-one:deck_proj_brain');
  });

  it('loads saved config from server for the active session', async () => {
    const savedConfig: P2pSavedConfig = {
      sessions: { 'deck_sub_abc': { enabled: true, mode: 'review' } },
      rounds: 2,
      extraPrompt: 'be concise',
    };
    getUserPrefMock.mockResolvedValue(JSON.stringify(savedConfig));

    renderPanel({ activeSession: 'deck_proj_brain' });
    await flush();

    // Rounds button "2" should be active (loaded from server config)
    const roundBtns = screen.getAllByRole('button').filter(b => b.textContent === '2');
    expect(roundBtns.length).toBeGreaterThan(0);
  });

  it('shows sdk sessions by default and switches to cli sessions on demand', async () => {
    renderPanel();
    await flush();

    expect(screen.getByText('brain')).toBeDefined();
    expect(screen.getByText('worker')).toBeDefined();
    expect(screen.queryByText('reviewer')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'CLI' }));

    expect(screen.getByText('reviewer')).toBeDefined();
    expect(screen.queryByText('brain')).toBeNull();
    expect(screen.queryByText('worker')).toBeNull();
  });

  it('preserves hidden sdk entries when saving from the cli filter', async () => {
    const onSave = vi.fn();
    renderPanel({ onSave });
    await flush();

    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getByRole('button', { name: 'CLI' }));
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    await act(async () => {
      fireEvent.click(screen.getByText('settings_save'));
    });
    await flush();

    const cfg: P2pSavedConfig = onSave.mock.calls[0][0];
    expect(cfg.sessions['deck_proj_brain']).toBeDefined();
    expect(cfg.sessions['deck_proj_brain'].enabled).toBe(true);
    expect(cfg.sessions['deck_sub_cli']).toBeDefined();
    expect(cfg.sessions['deck_sub_cli'].enabled).toBe(true);
    expect(cfg.sessions['deck_sub_abc']).toBeDefined();
  }, 15_000);

  it('manages shared custom combos from the combo tab', async () => {
    getUserPrefMock.mockImplementation(async (key: string) => {
      if (key === 'p2p_custom_combos') return JSON.stringify(['audit>discuss']);
      return null;
    });

    renderPanel();
    await flush();

    fireEvent.click(screen.getByRole('button', { name: 'combo_label' }));
    expect(screen.getByText('mode_audit→mode_discuss')).toBeDefined();

    fireEvent.click(screen.getByText('+mode_brainstorm'));
    fireEvent.click(screen.getByText('+mode_review'));
    fireEvent.click(screen.getByText('✓'));

    expect(saveUserPrefMock).toHaveBeenCalledWith('p2p_custom_combos', JSON.stringify(['audit>discuss', 'brainstorm>review']));
  });

  it('deletes custom combos from the combo tab', async () => {
    getUserPrefMock.mockImplementation(async (key: string) => {
      if (key === 'p2p_custom_combos') return JSON.stringify(['audit>discuss']);
      return null;
    });

    renderPanel();
    await flush();

    fireEvent.click(screen.getByRole('button', { name: 'combo_label' }));
    fireEvent.click(screen.getAllByText('×')[0]);

    expect(saveUserPrefMock).toHaveBeenCalledWith('p2p_custom_combos', JSON.stringify([]));
  });

  it('shares one P2P config GET across concurrent panel consumers', async () => {
    const savedConfig: P2pSavedConfig = { sessions: {}, rounds: 2 };
    getUserPrefMock.mockImplementation(async (key: string) => {
      if (key === 'p2p_session_config:srv-main:deck_proj_brain') return JSON.stringify(savedConfig);
      return null;
    });

    renderPanel();
    renderPanel();
    await flush();

    expect(callsForPrefKey('p2p_session_config:srv-main:deck_proj_brain')).toHaveLength(1);
  });

  it('uses the warm P2P config cache when reopening the panel for the same root', async () => {
    const savedConfig: P2pSavedConfig = { sessions: {}, rounds: 2 };
    getUserPrefMock.mockImplementation(async (key: string) => {
      if (key === 'p2p_session_config:srv-main:deck_proj_brain') return JSON.stringify(savedConfig);
      return null;
    });

    const first = renderPanel();
    await flush();
    first.unmount();
    renderPanel();
    await flush();

    expect(callsForPrefKey('p2p_session_config:srv-main:deck_proj_brain')).toHaveLength(1);
  });

  it('applies primary P2P preference events without refetching', async () => {
    getUserPrefMock.mockImplementation(async (key: string) => {
      if (key === 'p2p_session_config:srv-main:deck_proj_brain') {
        return JSON.stringify({ sessions: { deck_proj_brain: { enabled: false, mode: 'audit' } }, rounds: 1 });
      }
      return null;
    });

    renderPanel();
    await flush();
    getUserPrefMock.mockClear();

    window.dispatchEvent(new CustomEvent('imcodes:user-pref-changed', {
      detail: {
        key: 'p2p_session_config:srv-main:deck_proj_brain',
        value: JSON.stringify({ sessions: { deck_proj_brain: { enabled: true, mode: 'audit' } }, rounds: 1 }),
      },
    }));
    await flush();

    expect(callsForPrefKey('p2p_session_config:srv-main:deck_proj_brain')).toHaveLength(0);
    expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(true);
  });

  it('migrates legacy P2P config into the scoped primary key once', async () => {
    const legacyConfig: P2pSavedConfig = { sessions: {}, rounds: 5 };
    getUserPrefMock.mockImplementation(async (key: string) => {
      if (key === 'p2p_session_config') return JSON.stringify(legacyConfig);
      return null;
    });

    renderPanel();
    await flush();

    expect(callsForPrefKey('p2p_session_config:srv-main:deck_proj_brain')).toHaveLength(1);
    expect(callsForPrefKey('p2p_session_config:deck_proj_brain')).toHaveLength(1);
    expect(callsForPrefKey('p2p_session_config')).toHaveLength(1);
    expect(saveUserPrefMock).toHaveBeenCalledWith('p2p_session_config:srv-main:deck_proj_brain', JSON.stringify(legacyConfig));
  });

  it('does not let late P2P cache updates overwrite in-progress local edits', async () => {
    getUserPrefMock.mockImplementation(async (key: string) => {
      if (key === 'p2p_session_config:srv-main:deck_proj_brain') {
        return JSON.stringify({ sessions: {}, rounds: 1 });
      }
      return null;
    });
    const onSave = vi.fn();

    renderPanel({ onSave });
    await flush();

    fireEvent.click(screen.getAllByRole('button').find((button) => button.textContent === '5')!);
    window.dispatchEvent(new CustomEvent('imcodes:user-pref-changed', {
      detail: {
        key: 'p2p_session_config:srv-main:deck_proj_brain',
        value: JSON.stringify({ sessions: {}, rounds: 2 }),
      },
    }));
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByText('settings_save'));
    });
    await flush();

    expect(onSave.mock.calls[0][0].rounds).toBe(5);
  });

  // ── smart-p2p-upgrade tasks 9.5–9.7: capability gate + future schema ─────
  describe('advanced launch capability gate', () => {
    it('shows the capability_stale banner and surfaces the launch-disabled flag when no daemon.hello has been received', async () => {
      const savedConfig: P2pSavedConfig = {
        sessions: {},
        rounds: 2,
        // Old advanced preset is enough to set hasAdvancedConfig=true.
        advancedPresetKey: 'openspec',
        advancedRunTimeoutMinutes: 30,
      };
      getUserPrefMock.mockResolvedValue(JSON.stringify(savedConfig));

      // Pass a source that always returns null → simulates daemon.hello never
      // observed (e.g. daemon disconnected, or on first connect).
      const stubSource: P2pConfigPanelCapabilitySource = {
        getSnapshot: () => null,
        subscribe: () => () => {},
      };
      // R3 v2 PR-θ — capability/migration/future-schema banners now live
      // under the dedicated `advanced` tab (canvas + advanced controls).
      // Open the panel directly on that tab so the banner is in the DOM.
      renderPanel({ daemonCapabilitySource: stubSource, initialTab: 'advanced' });
      await flush();

      // Banner must use the translated diagnostic key (the test mock returns
      // the last segment of the i18n key as the rendered string).
      expect(screen.getByTestId('p2p-capability-stale-banner')).toBeDefined();

      // Save button should signal the launch-disabled state to consumers via
      // the data attribute, even if the button itself remains clickable
      // (Save is the migration acceptance action, not the actual launch).
      const saveBtn = screen.getByText('settings_save').closest('button')!;
      expect(saveBtn.getAttribute('data-advanced-launch-disabled')).toBe('true');
    });

    it('shows the missing_required_capability banner when daemon.hello is fresh but lacks p2p.workflow.v1', async () => {
      const savedConfig: P2pSavedConfig = {
        sessions: {},
        rounds: 1,
        advancedPresetKey: 'openspec',
      };
      getUserPrefMock.mockResolvedValue(JSON.stringify(savedConfig));

      // Fresh snapshot but no p2p.workflow.v1 capability — required cap missing.
      const source = freshCapabilitySource(['some.other.cap']);
      renderPanel({ daemonCapabilitySource: source, initialTab: 'advanced' });
      await flush();

      expect(screen.getByTestId('p2p-missing-capability-banner')).toBeDefined();
      const saveBtn = screen.getByText('settings_save').closest('button')!;
      expect(saveBtn.getAttribute('data-advanced-launch-disabled')).toBe('true');
    });

    it('does not show capability banners when no advanced workflow is configured', async () => {
      const savedConfig: P2pSavedConfig = {
        sessions: {},
        rounds: 3,
        // Note: no advanced fields → hasAdvancedConfig=false
      };
      getUserPrefMock.mockResolvedValue(JSON.stringify(savedConfig));

      // Even with a stale source (null snapshot), the gate is dormant when
      // the user has no advanced workflow configured.
      const stubSource: P2pConfigPanelCapabilitySource = {
        getSnapshot: () => null,
        subscribe: () => () => {},
      };
      renderPanel({ daemonCapabilitySource: stubSource });
      await flush();

      expect(screen.queryByTestId('p2p-capability-stale-banner')).toBeNull();
      expect(screen.queryByTestId('p2p-missing-capability-banner')).toBeNull();
      const saveBtn = screen.getByText('settings_save').closest('button')!;
      expect(saveBtn.getAttribute('data-advanced-launch-disabled')).toBe('false');
    });
  });

  describe('future workflow schema read-only mode', () => {
    it('blocks save and shows the unsupported_schema_version banner when the saved envelope declares a future schema version', async () => {
      const futureVersion = (P2P_WORKFLOW_KNOWN_SCHEMA_MAX as number) + 1;
      const savedConfig: P2pSavedConfig = {
        sessions: {},
        rounds: 2,
        // Forge a launch envelope from a hypothetical future client.
        workflowLaunchEnvelope: {
          workflowSchemaVersion: futureVersion,
          workflowKind: 'advanced',
        } as unknown as NonNullable<P2pSavedConfig['workflowLaunchEnvelope']>,
      };
      getUserPrefMock.mockResolvedValue(JSON.stringify(savedConfig));

      const onSave = vi.fn();
      // Future-schema banner lives on the advanced tab.
      renderPanel({ onSave, initialTab: 'advanced' });
      await flush();

      expect(screen.getByTestId('p2p-future-schema-banner')).toBeDefined();

      const saveBtn = screen.getByText('settings_save').closest('button')!;
      expect(saveBtn.disabled).toBe(true);
      expect(saveBtn.getAttribute('data-save-blocked')).toBe('true');

      const panel = saveBtn.closest('[data-readonly-mode]');
      expect(panel?.getAttribute('data-readonly-mode')).toBe('true');

      // Defense-in-depth: even forcing a click should not invoke onSave.
      await act(async () => {
        fireEvent.click(saveBtn);
      });
      await flush();
      expect(onSave).not.toHaveBeenCalled();
    });
  });

  // ── smart-p2p-upgrade tasks 9.2 / 9.10 / §12.6 — list-based draft editor ─
  describe('advanced workflow draft editor', () => {
    function makeDraft(): P2pWorkflowDraft {
      return {
        schemaVersion: P2P_WORKFLOW_SCHEMA_VERSION,
        id: 'draft-test',
        title: 'Draft test',
        nodes: [
          { id: 'discuss', title: 'Discuss', nodeKind: 'llm', preset: 'discuss', permissionScope: 'analysis_only' },
          { id: 'audit', title: 'Audit', nodeKind: 'llm', preset: 'audit', permissionScope: 'analysis_only' },
        ],
        edges: [
          { id: 'e1', fromNodeId: 'discuss', toNodeId: 'audit', edgeKind: 'default' },
        ],
      };
    }

    function makeSavedConfigWithDraft(extras: Partial<P2pSavedConfig> = {}): P2pSavedConfig {
      const draft = makeDraft();
      const envelope: P2pWorkflowLaunchEnvelope = {
        workflowSchemaVersion: P2P_WORKFLOW_SCHEMA_VERSION,
        workflowKind: 'advanced',
        advancedDraft: draft,
        requiredDaemonCapabilities: [P2P_WORKFLOW_CAPABILITY_V1],
      };
      return {
        sessions: {},
        rounds: 2,
        workflowDraft: draft,
        workflowLaunchEnvelope: envelope,
        ...extras,
      };
    }

    it('renders the editor when a draft is present and not in future-schema mode', async () => {
      getUserPrefMock.mockResolvedValue(JSON.stringify(makeSavedConfigWithDraft()));
      // R3 v2 PR-θ — canvas + advanced controls live under the `advanced` tab.
      renderPanel({ initialTab: 'advanced' });
      await flush();

      const editor = screen.getByTestId('p2p-advanced-workflow-editor');
      expect(editor).toBeDefined();
      expect(editor.getAttribute('data-readonly')).toBe('false');
      // Canvas variant must be active — there is only one editor surface
      // (no list/canvas toggle, no list fallback).
      expect(editor.getAttribute('data-editor-variant')).toBe('canvas');
      // Canvas root is present.
      expect(screen.getByTestId('p2p-editor-canvas')).toBeDefined();
      // Both seeded nodes render as SVG shapes.
      expect(screen.getByTestId('p2p-editor-node-shape-discuss')).toBeDefined();
      expect(screen.getByTestId('p2p-editor-node-shape-audit')).toBeDefined();
      // Seeded edge renders as SVG path group.
      expect(screen.getByTestId('p2p-editor-edge-shape-e1')).toBeDefined();
      // No diagnostic block for a valid seed draft.
      expect(screen.queryByTestId('p2p-editor-diagnostics')).toBeNull();
      // Read-only notice should not render.
      expect(screen.queryByTestId('p2p-editor-readonly-notice')).toBeNull();
      // Inspector starts empty (no selection on mount).
      expect(screen.getByTestId('p2p-editor-inspector-empty')).toBeDefined();
    });

    it('add node and remove node update draft state and surface validator diagnostics inline', async () => {
      const onSave = vi.fn();
      getUserPrefMock.mockResolvedValue(JSON.stringify(makeSavedConfigWithDraft()));
      renderPanel({ onSave, initialTab: 'advanced' });
      await flush();

      // Initial: 2 nodes (rendered as SVG shapes on the canvas).
      expect(screen.getByTestId('p2p-editor-node-shape-discuss')).toBeDefined();
      expect(screen.getByTestId('p2p-editor-node-shape-audit')).toBeDefined();

      // Add a node — should default to llm/discuss/analysis_only with id
      // node_1 AND auto-select so the inspector surfaces immediately.
      await act(async () => {
        fireEvent.click(screen.getByTestId('p2p-editor-add-node'));
      });
      await flush();
      // SVG shape for the new node exists on the canvas.
      expect(screen.getByTestId('p2p-editor-node-shape-node_1')).toBeDefined();
      // Inspector picked up the new node (testid lives on the inspector card,
      // which is keyed by the selected node id).
      expect(screen.getByTestId('p2p-editor-node-node_1')).toBeDefined();
      // Default preset should be 'discuss' (a valid llm/analysis_only combo →
      // no diagnostic from validateNodeCombination).
      const presetSelect = screen.getByLabelText('node-node_1-preset') as HTMLSelectElement;
      expect(presetSelect.value).toBe('discuss');

      // Switch the new node's preset to 'implementation' WITHOUT changing
      // permissionScope. validateNodeCombination requires
      // implementation→implementation scope, so this MUST surface an inline
      // diagnostic about the invalid combination.
      await act(async () => {
        presetSelect.value = 'implementation';
        // Preact attaches handlers via the input event for native form
        // controls, so fireEvent.input is the reliable trigger here.
        fireEvent.input(presetSelect, { target: { value: 'implementation' } });
      });
      await flush();
      const diagnostics = screen.getByTestId('p2p-editor-diagnostics');
      expect(diagnostics.textContent).toMatch(/invalid_workflow_graph|combination/i);

      // Remove the offending node from the inspector and confirm diagnostic
      // disappears AND the SVG shape is gone.
      await act(async () => {
        fireEvent.click(screen.getByTestId('p2p-editor-remove-node-node_1'));
      });
      await flush();
      expect(screen.queryByTestId('p2p-editor-node-shape-node_1')).toBeNull();
      expect(screen.queryByTestId('p2p-editor-node-node_1')).toBeNull();
      expect(screen.queryByTestId('p2p-editor-diagnostics')).toBeNull();
    });

    it('select existing edge and switch to conditional routing_key_equals updates draft', async () => {
      const onSave = vi.fn();
      getUserPrefMock.mockResolvedValue(JSON.stringify(makeSavedConfigWithDraft()));
      renderPanel({ onSave, initialTab: 'advanced' });
      await flush();

      // The seed already has edge `e1` rendered as an SVG shape. Select it
      // by clicking the shape; the inspector card with testid
      // `p2p-editor-edge-e1` should appear.
      await act(async () => {
        fireEvent.click(screen.getByTestId('p2p-editor-edge-shape-e1'));
      });
      await flush();
      expect(screen.getByTestId('p2p-editor-edge-e1')).toBeDefined();

      // Switch edgeKind to conditional → condition controls should appear.
      const kindSelect = screen.getByLabelText('edge-e1-kind') as HTMLSelectElement;
      await act(async () => {
        kindSelect.value = 'conditional';
        fireEvent.input(kindSelect, { target: { value: 'conditional' } });
      });
      await flush();
      const conditionKind = screen.getByLabelText('edge-e1-condition-kind') as HTMLSelectElement;
      expect(conditionKind.value).toBe('routing_key_equals');
      const conditionEquals = screen.getByLabelText('edge-e1-condition-equals') as HTMLInputElement;
      // Empty equals → validator emits invalid_edge_condition diagnostic.
      expect(screen.getByTestId('p2p-editor-diagnostics').textContent).toMatch(/invalid_edge_condition|e1\.condition/);

      // Type a value into equals — diagnostic should clear.
      await act(async () => {
        fireEvent.input(conditionEquals, { target: { value: 'go-audit' } });
      });
      await flush();
      // Save and inspect outgoing config — the workflowDraft must contain
      // the conditional edge with the routing_key_equals condition.
      await act(async () => {
        fireEvent.click(screen.getByText('settings_save'));
      });
      await flush();
      const cfg: P2pSavedConfig = onSave.mock.calls[0][0];
      const draft = cfg.workflowDraft;
      expect(draft).toBeDefined();
      const conditionalEdge = draft!.edges.find((edge) => edge.id === 'e1');
      expect(conditionalEdge).toMatchObject({
        edgeKind: 'conditional',
        condition: { kind: 'routing_key_equals', equals: 'go-audit' },
      });
    });

    it('editor inputs are disabled when readOnly is true (future schema)', async () => {
      const futureVersion = (P2P_WORKFLOW_KNOWN_SCHEMA_MAX as number) + 1;
      // Force read-only via a future-version draft saved on the panel.
      const future: P2pWorkflowDraft = {
        ...makeDraft(),
        schemaVersion: futureVersion as unknown as 1,
      };
      const savedConfig: P2pSavedConfig = {
        sessions: {},
        rounds: 2,
        workflowDraft: future,
        workflowLaunchEnvelope: {
          workflowSchemaVersion: P2P_WORKFLOW_SCHEMA_VERSION,
          workflowKind: 'advanced',
          advancedDraft: future,
        },
      };
      getUserPrefMock.mockResolvedValue(JSON.stringify(savedConfig));

      renderPanel({ initialTab: 'advanced' });
      await flush();

      const editor = screen.getByTestId('p2p-advanced-workflow-editor');
      expect(editor.getAttribute('data-readonly')).toBe('true');
      expect(editor.getAttribute('data-editor-variant')).toBe('canvas');
      expect(screen.getByTestId('p2p-editor-readonly-notice')).toBeDefined();

      // Add-node button must NOT render in readonly mode.
      expect(screen.queryByTestId('p2p-editor-add-node')).toBeNull();
      // Drag anchor must NOT render in readonly mode (no edge creation).
      expect(screen.queryByTestId('p2p-editor-node-anchor-discuss')).toBeNull();

      // Click the node shape to surface the inspector, then assert all
      // inputs are disabled. The canvas itself doesn't disable selection
      // so the user can still inspect the workflow read-only.
      await act(async () => {
        fireEvent.click(screen.getByTestId('p2p-editor-node-shape-discuss'));
      });
      await flush();
      const titleInput = screen.getByLabelText('node-discuss-title') as HTMLInputElement;
      expect(titleInput.disabled).toBe(true);
      const presetSelect = screen.getByLabelText('node-discuss-preset') as HTMLSelectElement;
      expect(presetSelect.disabled).toBe(true);

      // Now select the edge via shape click and confirm its inputs are also
      // disabled.
      await act(async () => {
        fireEvent.click(screen.getByTestId('p2p-editor-edge-shape-e1'));
      });
      await flush();
      const fromSelect = screen.getByLabelText('edge-e1-from') as HTMLSelectElement;
      expect(fromSelect.disabled).toBe(true);
    });

    it('editor edits never include forbidden envelope fields in onChange output', async () => {
      const onSave = vi.fn();
      getUserPrefMock.mockResolvedValue(JSON.stringify(makeSavedConfigWithDraft()));
      renderPanel({ onSave, initialTab: 'advanced' });
      await flush();

      // Make a few edits — select discuss node, change preset, add a node,
      // save. The canvas auto-selects the new node so the inspector is
      // already populated for the post-add assertion path.
      await act(async () => {
        fireEvent.click(screen.getByTestId('p2p-editor-node-shape-discuss'));
      });
      await flush();
      const presetSelect = screen.getByLabelText('node-discuss-preset') as HTMLSelectElement;
      await act(async () => {
        presetSelect.value = 'brainstorm';
        fireEvent.input(presetSelect, { target: { value: 'brainstorm' } });
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('p2p-editor-add-node'));
      });
      await flush();
      await act(async () => {
        fireEvent.click(screen.getByText('settings_save'));
      });
      await flush();

      // Inspect the entire saved P2pSavedConfig recursively for forbidden
      // private fields. The buildP2pWorkflowLaunchEnvelopeFromConfig path
      // must not bake any compiled/private/raw/baseline fields into the
      // saved envelope or draft as a side-effect of editing.
      const cfg: P2pSavedConfig = onSave.mock.calls[0][0];
      const FORBIDDEN = [
        'compiledWorkflow',
        'boundWorkflow',
        'privateRuntimeState',
        'runtimePrivateState',
        'rawPrompt',
        'rawPromptText',
        'scriptRawOutputs',
        'rawScriptOutput',
        'artifactBaselines',
        'privateArtifactBaselines',
        'editorCache',
        'hiddenEditorCache',
        'env',
        'environment',
      ];
      const stack: unknown[] = [cfg];
      while (stack.length > 0) {
        const value = stack.pop();
        if (value && typeof value === 'object') {
          for (const [key, child] of Object.entries(value)) {
            const lower = key.toLowerCase();
            expect(
              FORBIDDEN.includes(key) || lower.endsWith('token') || lower.endsWith('secret') || lower.endsWith('apikey'),
              `forbidden field "${key}" appeared in onChange/onSave output`,
            ).toBe(false);
            if (child && typeof child === 'object') stack.push(child);
          }
        }
      }
    });

    it('renders editor strings via t() for a non-en locale (zh-CN)', async () => {
      // Load the zh-CN locale dictionary directly so we can verify that the
      // editor strings ARE wired through t() (vs hardcoded English).
      const webRoot = process.cwd().endsWith('/web') ? process.cwd() : joinPath(process.cwd(), 'web');
      const zh = JSON.parse(readFileSync(joinPath(webRoot, 'src/i18n/locales/zh-CN.json'), 'utf8')) as Record<string, unknown>;
      function lookup(key: string): string | undefined {
        const segments = key.split('.');
        let current: unknown = zh;
        for (const segment of segments) {
          if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
          current = (current as Record<string, unknown>)[segment];
        }
        return typeof current === 'string' ? current : undefined;
      }

      // Override the swappable translator BEFORE rendering so the panel
      // reads zh-CN strings as it mounts.
      currentTranslator = (key: string, fallback?: string) => lookup(key) ?? fallback ?? key;
      try {
        getUserPrefMock.mockResolvedValue(JSON.stringify(makeSavedConfigWithDraft()));
        renderPanel({ initialTab: 'advanced' });
        await flush();

        const expectedTitle = lookup('p2p.workflow.editor.title');
        const expectedAddNode = lookup('p2p.workflow.editor.add_node');
        expect(expectedTitle).toBeDefined();
        expect(expectedAddNode).toBeDefined();
        expect(screen.getByText(expectedTitle!)).toBeDefined();
        expect(screen.getByText(expectedAddNode!)).toBeDefined();
        // Sanity: the zh-CN strings are not the English literal fallbacks.
        expect(expectedTitle).not.toBe('Advanced workflow draft');
      } finally {
        currentTranslator = DEFAULT_TRANSLATOR;
      }
    });

    it('every editor i18n key exists in every supported locale', () => {
      // Updated for the canvas editor: dropped `add_edge` (edges are created
      // by drag from the right anchor — no button); added `canvas_hint`,
      // `inspector_empty`, and section labels for both node + edge cards.
      const editorKeys = [
        'p2p.workflow.editor.title',
        'p2p.workflow.editor.add_node',
        'p2p.workflow.editor.remove_node',
        'p2p.workflow.editor.remove_edge',
        'p2p.workflow.editor.diagnostics_header',
        'p2p.workflow.editor.read_only_notice',
        'p2p.workflow.editor.canvas_hint',
        'p2p.workflow.editor.inspector_empty',
        'p2p.workflow.editor.node.section_label',
        'p2p.workflow.editor.node.preset_label',
        'p2p.workflow.editor.node.permission_scope_label',
        'p2p.workflow.editor.edge.section_label',
        'p2p.workflow.editor.edge.from_label',
        'p2p.workflow.editor.edge.to_label',
        'p2p.workflow.editor.edge.condition_label',
        // R3 PR-α follow-up — UI-managed allowedExecutables i18n keys.
        'p2p.workflow.allowed_executables.title',
        'p2p.workflow.allowed_executables.hint',
        'p2p.workflow.allowed_executables.placeholder',
        'p2p.workflow.allowed_executables.input_label',
        'p2p.workflow.allowed_executables.add',
        'p2p.workflow.allowed_executables.remove',
        'p2p.workflow.allowed_executables.empty',
      ];
      const supported = ['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko'];
      const webRoot = process.cwd().endsWith('/web') ? process.cwd() : joinPath(process.cwd(), 'web');
      for (const locale of supported) {
        const messages = JSON.parse(
          readFileSync(joinPath(webRoot, 'src/i18n/locales', `${locale}.json`), 'utf8'),
        ) as Record<string, unknown>;
        for (const key of editorKeys) {
          let current: unknown = messages;
          for (const segment of key.split('.')) {
            if (!current || typeof current !== 'object' || Array.isArray(current)) {
              current = undefined;
              break;
            }
            current = (current as Record<string, unknown>)[segment];
          }
          expect(typeof current, `${locale}:${key}`).toBe('string');
          expect((current as string).trim().length, `${locale}:${key}`).toBeGreaterThan(0);
        }
      }
    });

    // ─────────────────────────────────────────────────────────────────
    // R3 PR-α follow-up — UI-managed allowedExecutables editor.
    // The previous `~/.imcodes/p2p-policy.json` host-file workflow has
    // been removed; the allowlist now lives in `P2pConfigPanel` and
    // round-trips through `P2pSavedConfig.allowedExecutables` →
    // `P2pWorkflowLaunchEnvelope.allowedExecutables` → daemon
    // `P2pStaticPolicy.allowedExecutables`.
    // ─────────────────────────────────────────────────────────────────

    it('Allowed executables section renders alongside the canvas editor', async () => {
      getUserPrefMock.mockResolvedValue(JSON.stringify(makeSavedConfigWithDraft()));
      renderPanel({ initialTab: 'advanced' });
      await flush();
      const section = screen.getByTestId('p2p-allowed-executables-section');
      expect(section).toBeDefined();
      expect(section.getAttribute('data-readonly')).toBe('false');
      // Empty state visible when no entries are configured.
      expect(screen.getByTestId('p2p-allowed-executables-empty')).toBeDefined();
      // Add row exposed.
      expect(screen.getByTestId('p2p-allowed-executables-input')).toBeDefined();
      expect(screen.getByTestId('p2p-allowed-executables-add')).toBeDefined();
    });

    it('adds an executable to the allowlist and persists it through Save', async () => {
      const onSave = vi.fn();
      getUserPrefMock.mockResolvedValue(JSON.stringify(makeSavedConfigWithDraft()));
      renderPanel({ onSave, initialTab: 'advanced' });
      await flush();
      const input = screen.getByTestId('p2p-allowed-executables-input') as HTMLInputElement;
      await act(async () => {
        fireEvent.input(input, { target: { value: '/usr/bin/jq' } });
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('p2p-allowed-executables-add'));
      });
      await flush();
      // List entry appears.
      expect(screen.getByTestId('p2p-allowed-executables-entry-/usr/bin/jq')).toBeDefined();
      // Saving propagates the entry both into `cfg.allowedExecutables` and
      // into the materialized envelope.
      await act(async () => {
        fireEvent.click(screen.getByText('settings_save'));
      });
      await flush();
      const cfg: P2pSavedConfig = onSave.mock.calls[0][0];
      expect(cfg.allowedExecutables).toEqual(['/usr/bin/jq']);
      expect(cfg.workflowLaunchEnvelope?.allowedExecutables).toEqual(['/usr/bin/jq']);
    });

    it('removes an entry from the allowlist', async () => {
      const onSave = vi.fn();
      getUserPrefMock.mockResolvedValue(JSON.stringify({
        ...makeSavedConfigWithDraft(),
        allowedExecutables: ['/usr/bin/jq', '/bin/echo'],
      }));
      renderPanel({ onSave, initialTab: 'advanced' });
      await flush();
      expect(screen.getByTestId('p2p-allowed-executables-entry-/usr/bin/jq')).toBeDefined();
      expect(screen.getByTestId('p2p-allowed-executables-entry-/bin/echo')).toBeDefined();
      await act(async () => {
        fireEvent.click(screen.getByTestId('p2p-allowed-executables-remove-/bin/echo'));
      });
      await flush();
      expect(screen.queryByTestId('p2p-allowed-executables-entry-/bin/echo')).toBeNull();
      await act(async () => {
        fireEvent.click(screen.getByText('settings_save'));
      });
      await flush();
      const cfg: P2pSavedConfig = onSave.mock.calls[0][0];
      expect(cfg.allowedExecutables).toEqual(['/usr/bin/jq']);
    });

    it('Allowed executables section is read-only when the workflow is in future-schema mode', async () => {
      const futureVersion = (P2P_WORKFLOW_KNOWN_SCHEMA_MAX as number) + 1;
      const future: P2pWorkflowDraft = {
        ...makeSavedConfigWithDraft().workflowDraft!,
        schemaVersion: futureVersion as unknown as 1,
      };
      const savedConfig: P2pSavedConfig = {
        sessions: {},
        rounds: 2,
        workflowDraft: future,
        workflowLaunchEnvelope: {
          workflowSchemaVersion: P2P_WORKFLOW_SCHEMA_VERSION,
          workflowKind: 'advanced',
          advancedDraft: future,
        },
        allowedExecutables: ['/usr/bin/jq'],
      };
      getUserPrefMock.mockResolvedValue(JSON.stringify(savedConfig));
      renderPanel({ initialTab: 'advanced' });
      await flush();
      const section = screen.getByTestId('p2p-allowed-executables-section');
      expect(section.getAttribute('data-readonly')).toBe('true');
      // Add row should be hidden, remove buttons hidden too.
      expect(screen.queryByTestId('p2p-allowed-executables-input')).toBeNull();
      expect(screen.queryByTestId('p2p-allowed-executables-remove-/usr/bin/jq')).toBeNull();
    });
  });
});
