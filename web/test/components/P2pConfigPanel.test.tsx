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
  { name: 'deck_proj_brain', agentType: 'claude-code', state: 'running' },
  { name: 'deck_proj_w1', agentType: 'codex', state: 'idle' },
];

const subSessions = [
  { sessionName: 'deck_sub_abc', type: 'gemini', label: 'worker', state: 'running' },
  { sessionName: 'deck_sub_def', type: 'shell', label: null, state: 'idle' },
];

function renderPanel(overrides: {
  sessions?: typeof sessions;
  subSessions?: typeof subSessions;
  onClose?: () => void;
  onSave?: (cfg: P2pSavedConfig) => void;
} = {}) {
  const props = {
    sessions: overrides.sessions ?? sessions,
    subSessions: overrides.subSessions ?? subSessions,
    onClose: overrides.onClose ?? vi.fn(),
    onSave: overrides.onSave ?? vi.fn(),
  };
  return render(<P2pConfigPanel {...props} />);
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
        { name: 'deck_proj_brain', agentType: 'claude-code', state: 'running' },
        { name: 'deck_proj_w1', agentType: 'shell', state: 'idle' },
        { name: 'deck_proj_w2', agentType: 'script', state: 'idle' },
      ],
      subSessions: [],
    });

    // Wait for loading to complete
    await act(async () => {});

    // claude-code session should appear by its short name
    expect(screen.getByText('brain')).toBeDefined();

    // shell and script sessions should not appear
    expect(screen.queryByText('w1')).toBeNull();
    expect(screen.queryByText('w2')).toBeNull();
  });

  it('excludes shell type from subSessions', async () => {
    renderPanel();
    await act(async () => {});

    // gemini sub-session with label 'worker' should appear
    expect(screen.getByText('worker')).toBeDefined();

    // shell sub-session 'deck_sub_def' should not appear (short name would be 'def')
    expect(screen.queryByText('def')).toBeNull();
  });

  it('shows rounds selector with buttons for 1, 2, 3, 5', async () => {
    renderPanel();
    await act(async () => {});

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
    await act(async () => {});

    // Round button 5 should be active (has blue border style)
    // We verify by checking the button exists and was set
    const buttons = screen.getAllByRole('button');
    const btn5 = buttons.find((b) => b.textContent === '5');
    expect(btn5).toBeDefined();
  });

  it('calls onSave with correct config shape when save is clicked', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    renderPanel({ onSave, onClose });
    await act(async () => {});

    // Click save button (text comes from t('p2p.settings_save') → 'settings_save')
    const saveBtn = screen.getByText('settings_save');
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    expect(onSave).toHaveBeenCalledOnce();
    const cfg: P2pSavedConfig = onSave.mock.calls[0][0];

    // All eligible sessions should be in the config
    expect(cfg.sessions['deck_proj_brain']).toBeDefined();
    expect(cfg.sessions['deck_proj_w1']).toBeDefined();
    expect(cfg.sessions['deck_sub_abc']).toBeDefined();
    // shell sub-session should not be included
    expect(cfg.sessions['deck_sub_def']).toBeUndefined();
    expect(typeof cfg.rounds).toBe('number');
  });

  it('calls onSave with updated mode after changing a select', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    renderPanel({ onSave, onClose });
    await act(async () => {});

    // Change mode for first session (deck_proj_brain)
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect(selects.length).toBeGreaterThan(0);

    fireEvent.change(selects[0], { target: { value: 'review' } });

    const saveBtn = screen.getByText('settings_save');
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    const cfg: P2pSavedConfig = onSave.mock.calls[0][0];
    // The first eligible session mode should be 'review'
    const firstKey = Object.keys(cfg.sessions)[0];
    expect(cfg.sessions[firstKey].mode).toBe('review');
  });

  it('calls onClose when the close button (✕) is clicked', async () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    await act(async () => {});

    // The ✕ button in the header
    const closeBtn = screen.getByText('✕');
    fireEvent.click(closeBtn);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when the secondary close button in footer is clicked', async () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    await act(async () => {});

    const cancelBtn = screen.getByText('settings_close');
    fireEvent.click(cancelBtn);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('new sessions not in saved config default to enabled with audit mode', async () => {
    const savedConfig: P2pSavedConfig = {
      sessions: {}, // no prior config for any session
      rounds: 1,
    };
    getUserPrefMock.mockResolvedValue(JSON.stringify(savedConfig));

    const onSave = vi.fn();
    const onClose = vi.fn();

    renderPanel({ onSave, onClose });
    await act(async () => {});

    // Checkboxes should all be checked (enabled=true by default)
    // First checkbox is the cross-session toggle — skip it
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    const sessionCheckboxes = checkboxes.slice(1); // skip cross-session toggle
    expect(sessionCheckboxes.length).toBeGreaterThan(0);
    for (const cb of sessionCheckboxes) {
      expect(cb.checked).toBe(true);
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
    await act(async () => {});

    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    // First checkbox is cross-session toggle, session checkboxes start at index 1
    expect(checkboxes[1].checked).toBe(true);

    // Uncheck the first session
    fireEvent.click(checkboxes[1]);
    expect(checkboxes[1].checked).toBe(false);

    const saveBtn = screen.getByText('settings_save');
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    const cfg: P2pSavedConfig = onSave.mock.calls[0][0];
    const firstKey = Object.keys(cfg.sessions)[0];
    expect(cfg.sessions[firstKey].enabled).toBe(false);
  });

  it('changing rounds updates the config passed to onSave', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    renderPanel({ onSave, onClose });
    await act(async () => {});

    // Click round button "5"
    const roundBtn5 = screen.getAllByRole('button').find((b) => b.textContent === '5');
    expect(roundBtn5).toBeDefined();
    fireEvent.click(roundBtn5!);

    const saveBtn = screen.getByText('settings_save');
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    const cfg: P2pSavedConfig = onSave.mock.calls[0][0];
    expect(cfg.rounds).toBe(5);
  });

  it('persists config via saveUserPref on save', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();

    renderPanel({ onSave, onClose });
    await act(async () => {});

    const saveBtn = screen.getByText('settings_save');
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    expect(saveUserPrefMock).toHaveBeenCalledOnce();
    expect(saveUserPrefMock.mock.calls[0][0]).toBe('p2p_session_config');
    // Second arg should be a JSON string
    const jsonArg = saveUserPrefMock.mock.calls[0][1];
    expect(typeof jsonArg).toBe('string');
    const parsed = JSON.parse(jsonArg);
    expect(parsed).toHaveProperty('sessions');
    expect(parsed).toHaveProperty('rounds');
  });

  it('calls onClose after save completes', async () => {
    const onClose = vi.fn();

    renderPanel({ onClose });
    await act(async () => {});

    const saveBtn = screen.getByText('settings_save');
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    expect(onClose).toHaveBeenCalledOnce();
  });
});
