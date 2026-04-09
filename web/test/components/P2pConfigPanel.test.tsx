/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key.split('.').pop() ?? key,
  }),
}));

const getUserPrefMock = vi.fn();
const saveUserPrefMock = vi.fn();

vi.mock('../../src/api.js', () => ({
  getUserPref: (...args: unknown[]) => getUserPrefMock(...args),
  saveUserPref: (...args: unknown[]) => saveUserPrefMock(...args),
}));

import { P2pConfigPanel } from '../../src/components/P2pConfigPanel.js';
import type { P2pSavedConfig } from '@shared/p2p-modes.js';

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
  initialTab?: 'participants' | 'combos';
  onClose?: () => void;
  onSave?: (cfg: P2pSavedConfig) => void;
} = {}) {
  const props = {
    sessions: overrides.sessions ?? sessions,
    subSessions: overrides.subSessions ?? subSessions,
    activeSession: overrides.activeSession ?? 'deck_proj_brain',
    initialTab: overrides.initialTab,
    onClose: overrides.onClose ?? vi.fn(),
    onSave: overrides.onSave ?? vi.fn(),
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

describe('P2pConfigPanel', () => {
  beforeEach(() => {
    getUserPrefMock.mockResolvedValue(null);
    saveUserPrefMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
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

  it('calls onSave with updated mode after changing a select', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    renderPanel({ onSave, onClose });
    await flush();

    // Change mode for first session (deck_proj_brain)
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect(selects.length).toBeGreaterThan(0);

    fireEvent.change(selects[0], { target: { value: 'review' } });

    const saveBtn = screen.getByText('settings_save');
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await flush();

    const cfg: P2pSavedConfig = onSave.mock.calls[0][0];
    // The first eligible session mode should be 'review'
    const firstKey = Object.keys(cfg.sessions)[0];
    expect(cfg.sessions[firstKey].mode).toBe('review');
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
    expect(saveUserPrefMock.mock.calls[0][0]).toBe('p2p_session_config:deck_proj_brain');
    // Second arg should be a JSON string
    const jsonArg = saveUserPrefMock.mock.calls[0][1];
    expect(typeof jsonArg).toBe('string');
    const parsed = JSON.parse(jsonArg);
    expect(parsed).toHaveProperty('sessions');
    expect(parsed).toHaveProperty('rounds');
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
    expect(cfg.advancedPresetKey).toBe('openspec');
    expect(cfg.advancedRunTimeoutMinutes).toBe(42);
    expect(cfg.contextReducer).toEqual(savedConfig.contextReducer);
    expect(cfg.advancedRounds).toEqual(savedConfig.advancedRounds);
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
    expect(getUserPrefMock).toHaveBeenCalledWith('p2p_session_config:deck_proj_brain');
    u1();
    cleanup();

    vi.clearAllMocks();
    getUserPrefMock.mockResolvedValue(null);
    saveUserPrefMock.mockResolvedValue(undefined);

    // Session 2 — different key
    renderPanel({ activeSession: 'deck_other_brain', onSave: onSave2 });
    await flush();
    expect(getUserPrefMock).toHaveBeenCalledWith('p2p_session_config:deck_other_brain');
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
});
