import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  KEYBOARD_SHORTCUTS_PREF_KEY,
  SHORTCUT_ACTION_IDS,
  chordFromKeyboardEvent,
  findShortcutConflicts,
  formatShortcutKeycaps,
  getDefaultShortcuts,
  isMacPlatform,
  normalizeShortcutChordString,
  resolveKeyboardShortcuts,
  sanitizeShortcutOverrides,
  type KeyboardShortcutOverrides,
  type ShortcutActionId,
} from '../keyboard-shortcuts.js';
import { useSyncedPreference } from '../hooks/useSyncedPreference.js';

export interface KeyboardShortcutsSectionProps {
  overrides?: KeyboardShortcutOverrides;
  onChangeOverrides?: (
    value: KeyboardShortcutOverrides | ((prev: KeyboardShortcutOverrides) => KeyboardShortcutOverrides),
  ) => void;
  /** Optional override for tests verifying macOS vs Windows/Linux keycap defaults. */
  isMacOverride?: boolean;
}

const ACTION_LABELS: Record<ShortcutActionId, { titleKey: string; descKey: string }> = {
  serverPrev: {
    titleKey: 'settings.shortcuts.actions.server_prev.title',
    descKey: 'settings.shortcuts.actions.server_prev.desc',
  },
  serverNext: {
    titleKey: 'settings.shortcuts.actions.server_next.title',
    descKey: 'settings.shortcuts.actions.server_next.desc',
  },
  tabPrev: {
    titleKey: 'settings.shortcuts.actions.tab_prev.title',
    descKey: 'settings.shortcuts.actions.tab_prev.desc',
  },
  tabNext: {
    titleKey: 'settings.shortcuts.actions.tab_next.title',
    descKey: 'settings.shortcuts.actions.tab_next.desc',
  },
};

function KeyboardShortcutsSectionInner({
  overrides,
  onChangeOverrides,
  isMacOverride,
}: {
  overrides: KeyboardShortcutOverrides;
  onChangeOverrides: (
    value: KeyboardShortcutOverrides | ((prev: KeyboardShortcutOverrides) => KeyboardShortcutOverrides),
  ) => void;
  isMacOverride?: boolean;
}) {
  const { t } = useTranslation();
  const isMac = isMacOverride ?? isMacPlatform();
  const defaults = useMemo(() => getDefaultShortcuts(isMac), [isMac]);
  const cleanOverrides = useMemo(() => sanitizeShortcutOverrides(overrides), [overrides]);
  const resolved = useMemo(() => resolveKeyboardShortcuts(cleanOverrides, isMac), [cleanOverrides, isMac]);
  const conflicts = useMemo(() => findShortcutConflicts(resolved), [resolved]);

  const [recordingAction, setRecordingAction] = useState<ShortcutActionId | null>(null);
  const [statusNotice, setStatusNotice] = useState<{ type: 'info' | 'err'; text: string } | null>(null);
  const recorderContainerRef = useRef<HTMLDivElement | null>(null);

  const hasAnyOverride = useMemo(
    () => SHORTCUT_ACTION_IDS.some((id) => resolved[id] !== defaults[id]),
    [resolved, defaults],
  );

  useEffect(() => {
    if (!recordingAction) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      }

      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setRecordingAction(null);
        setStatusNotice(null);
        return;
      }

      // Ignore bare modifier presses so users can build combos smoothly.
      if (
        e.key === 'Control'
        || e.key === 'Meta'
        || e.key === 'Shift'
        || e.key === 'Alt'
        || e.key === 'AltGraph'
        || e.key === 'OS'
        || e.key === 'Super'
        || e.key === 'Hyper'
      ) {
        return;
      }

      const captured = chordFromKeyboardEvent(e, { requireModifier: true });
      const chord = captured ? normalizeShortcutChordString(captured) : null;
      if (!chord) {
        setStatusNotice({
          type: 'err',
          text: t('settings.shortcuts.modifier_required'),
        });
        return;
      }

      const displacedAction = SHORTCUT_ACTION_IDS.find(
        (other) => other !== recordingAction && resolved[other] === chord,
      ) ?? null;

      onChangeOverrides((prev) => {
        const currentClean = sanitizeShortcutOverrides(prev);
        const currentResolved = resolveKeyboardShortcuts(currentClean, isMac);
        const next: KeyboardShortcutOverrides = { ...currentClean };

        for (const other of SHORTCUT_ACTION_IDS) {
          if (other !== recordingAction && currentResolved[other] === chord) {
            next[other] = null;
          }
        }

        if (chord === defaults[recordingAction]) {
          delete next[recordingAction];
        } else {
          next[recordingAction] = chord;
        }
        return next;
      });

      setRecordingAction(null);
      if (displacedAction) {
        const displacedLabel = t(ACTION_LABELS[displacedAction].titleKey as 'settings.shortcuts.actions.server_prev.title');
        setStatusNotice({
          type: 'info',
          text: t('settings.shortcuts.reassigned_notice', { action: displacedLabel }),
        });
      } else {
        setStatusNotice(null);
      }
    };

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (recorderContainerRef.current && target && recorderContainerRef.current.contains(target)) {
        return;
      }
      setRecordingAction(null);
    };

    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [recordingAction, defaults, isMac, onChangeOverrides, resolved, t]);

  const handleClear = (action: ShortcutActionId) => {
    setRecordingAction(null);
    setStatusNotice(null);
    onChangeOverrides((prev) => ({
      ...sanitizeShortcutOverrides(prev),
      [action]: null,
    }));
  };

  const handleResetOne = (action: ShortcutActionId) => {
    setRecordingAction(null);
    setStatusNotice(null);
    onChangeOverrides((prev) => {
      const next = { ...sanitizeShortcutOverrides(prev) };
      delete next[action];
      return next;
    });
  };

  const handleResetAll = () => {
    setRecordingAction(null);
    setStatusNotice(null);
    onChangeOverrides({});
  };

  return (
    <div class="settings-card" data-testid="keyboard-shortcuts-card">
      <div class="settings-shortcuts-header">
        <div>
          <h2 class="settings-card-heading" style={{ marginBottom: '4px' }}>
            {t('settings.shortcuts.title')}
          </h2>
          <p class="settings-shortcuts-desc">
            {t('settings.shortcuts.desc')}
          </p>
        </div>
        <div class="settings-shortcuts-header-actions">
          <span class="settings-shortcuts-platform-badge">
            {isMac ? t('settings.shortcuts.platform_mac') : t('settings.shortcuts.platform_other')}
          </span>
          <button
            type="button"
            class="settings-btn-secondary"
            data-testid="shortcuts-reset-all"
            disabled={!hasAnyOverride}
            style={{ opacity: hasAnyOverride ? '1' : '0.45' }}
            onClick={handleResetAll}
          >
            {t('settings.shortcuts.reset_all')}
          </button>
        </div>
      </div>

      {statusNotice && (
        <div
          role="status"
          data-testid="shortcuts-status-notice"
          class={`settings-shortcuts-notice is-${statusNotice.type}`}
        >
          {statusNotice.text}
        </div>
      )}

      <div class="settings-shortcuts-list">
        {SHORTCUT_ACTION_IDS.map((action) => {
          const labels = ACTION_LABELS[action];
          const actionTitle = t(labels.titleKey as 'settings.shortcuts.actions.server_prev.title');
          const actionDesc = t(labels.descKey as 'settings.shortcuts.actions.server_prev.desc');
          const chord = resolved[action];
          const isRecording = recordingAction === action;
          const isCustom = chord !== defaults[action];
          const caps = formatShortcutKeycaps(chord, isMac);
          const actionConflicts = conflicts[action] ?? [];

          return (
            <div
              key={action}
              ref={isRecording ? recorderContainerRef : undefined}
              class={`settings-shortcut-row${isRecording ? ' is-recording' : ''}${actionConflicts.length > 0 ? ' has-conflict' : ''}`}
              data-testid={`shortcut-row-${action}`}
              data-shortcut-recording={isRecording ? 'true' : undefined}
            >
              <div class="settings-shortcut-info">
                <div class="settings-shortcut-title">
                  {actionTitle}
                </div>
                <div class="settings-shortcut-desc">
                  {actionDesc}
                </div>
                {actionConflicts.length > 0 && (
                  <div class="settings-shortcut-conflict" data-testid={`shortcut-conflict-${action}`}>
                    {t('settings.shortcuts.conflict_warning', {
                      actions: actionConflicts
                        .map((other) => t(ACTION_LABELS[other].titleKey as 'settings.shortcuts.actions.server_prev.title'))
                        .join(', '),
                    })}
                  </div>
                )}
              </div>

              <div class="settings-shortcut-controls">
                <button
                  type="button"
                  data-testid={`shortcut-record-${action}`}
                  data-shortcut-recording={isRecording ? 'true' : undefined}
                  aria-pressed={isRecording}
                  aria-label={t('settings.shortcuts.record_aria', {
                    action: actionTitle,
                  })}
                  class={`settings-shortcut-capture-btn${isRecording ? ' is-recording' : ''}${chord === null ? ' is-empty' : ''}`}
                  onClick={() => {
                    setStatusNotice(null);
                    setRecordingAction((prev) => (prev === action ? null : action));
                  }}
                >
                  {isRecording ? (
                    <span class="settings-shortcut-recording-label">
                      {t('settings.shortcuts.recording_prompt')}
                    </span>
                  ) : caps.length > 0 ? (
                    <span class="settings-shortcut-keycaps">
                      {caps.map((cap, idx) => (
                        <kbd key={`${cap}-${idx}`} class="settings-kbd">{cap}</kbd>
                      ))}
                    </span>
                  ) : (
                    <span class="settings-shortcut-unassigned">
                      {t('settings.shortcuts.unassigned')}
                    </span>
                  )}
                </button>

                {isRecording ? (
                  <button
                    type="button"
                    class="settings-btn-secondary settings-shortcut-mini-btn"
                    data-testid={`shortcut-cancel-${action}`}
                    onClick={() => {
                      setRecordingAction(null);
                      setStatusNotice(null);
                    }}
                  >
                    {t('common.cancel')}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      class="settings-btn-secondary settings-shortcut-mini-btn"
                      data-testid={`shortcut-clear-${action}`}
                      disabled={chord === null}
                      style={{ opacity: chord === null ? '0.45' : '1' }}
                      onClick={() => handleClear(action)}
                    >
                      {t('settings.shortcuts.clear')}
                    </button>
                    <button
                      type="button"
                      class="settings-btn-secondary settings-shortcut-mini-btn"
                      data-testid={`shortcut-reset-${action}`}
                      disabled={!isCustom}
                      style={{ opacity: isCustom ? '1' : '0.45' }}
                      onClick={() => handleResetOne(action)}
                    >
                      {t('settings.shortcuts.reset')}
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p class="settings-shortcuts-footnote">
        {t('settings.shortcuts.hint')}
      </p>
    </div>
  );
}

function KeyboardShortcutsSectionStandalone({ isMacOverride }: { isMacOverride?: boolean }) {
  const [overrides, setOverrides] = useSyncedPreference<KeyboardShortcutOverrides>(
    KEYBOARD_SHORTCUTS_PREF_KEY,
    {},
    0,
  );
  return (
    <KeyboardShortcutsSectionInner
      overrides={overrides}
      onChangeOverrides={setOverrides}
      isMacOverride={isMacOverride}
    />
  );
}

export function KeyboardShortcutsSection({
  overrides,
  onChangeOverrides,
  isMacOverride,
}: KeyboardShortcutsSectionProps) {
  if (overrides !== undefined && onChangeOverrides !== undefined) {
    return (
      <KeyboardShortcutsSectionInner
        overrides={overrides}
        onChangeOverrides={onChangeOverrides}
        isMacOverride={isMacOverride}
      />
    );
  }
  return <KeyboardShortcutsSectionStandalone isMacOverride={isMacOverride} />;
}
