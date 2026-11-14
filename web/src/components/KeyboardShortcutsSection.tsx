import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  KEYBOARD_SHORTCUTS_PREF_KEY,
  SHORTCUT_ACTION_IDS,
  SHORTCUT_MODIFIER_KEYS,
  SHORTCUT_SLOTS,
  applyShortcutSlotOverride,
  applySubSessionQuickModifiers,
  areSubSessionQuickModifiersEqual,
  chordFromKeyboardEvent,
  findShortcutSlotConflicts,
  formatShortcutKeycaps,
  formatSubSessionQuickModifierKeycaps,
  getDefaultSecondaryShortcuts,
  getDefaultShortcutForSlot,
  getDefaultShortcuts,
  getDefaultSubSessionQuickModifiers,
  isMacPlatform,
  normalizeShortcutChordString,
  resolveKeyboardShortcutSlots,
  resolveSubSessionQuickModifiers,
  sanitizeShortcutOverrides,
  type KeyboardShortcutOverrides,
  type ShortcutActionId,
  type ShortcutModifierKey,
  type ShortcutSlot,
  type ShortcutSlotTarget,
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
  const primaryDefaults = useMemo(() => getDefaultShortcuts(isMac), [isMac]);
  const secondaryDefaults = useMemo(() => getDefaultSecondaryShortcuts(isMac), [isMac]);
  const cleanOverrides = useMemo(() => sanitizeShortcutOverrides(overrides), [overrides]);
  const resolvedSlots = useMemo(
    () => resolveKeyboardShortcutSlots(cleanOverrides, isMac),
    [cleanOverrides, isMac],
  );
  const conflicts = useMemo(() => findShortcutSlotConflicts(resolvedSlots), [resolvedSlots]);

  const [recordingTarget, setRecordingTarget] = useState<ShortcutSlotTarget | null>(null);
  const [statusNotice, setStatusNotice] = useState<{ type: 'info' | 'err'; text: string } | null>(null);
  const recorderContainerRef = useRef<HTMLDivElement | null>(null);

  const subSessionModifiers = useMemo(
    () => resolveSubSessionQuickModifiers(cleanOverrides),
    [cleanOverrides],
  );
  const defaultSubSessionModifiers = useMemo(() => getDefaultSubSessionQuickModifiers(), []);
  const isCustomSubSessionModifiers = !areSubSessionQuickModifiersEqual(
    subSessionModifiers,
    defaultSubSessionModifiers,
  );
  const subSessionModifierCaps = useMemo(
    () => formatSubSessionQuickModifierKeycaps(subSessionModifiers, isMac),
    [subSessionModifiers, isMac],
  );

  const hasAnyOverride = useMemo(
    () => isCustomSubSessionModifiers || SHORTCUT_ACTION_IDS.some(
      (id) => resolvedSlots[id].primary !== primaryDefaults[id]
        || resolvedSlots[id].secondary !== secondaryDefaults[id],
    ),
    [isCustomSubSessionModifiers, resolvedSlots, primaryDefaults, secondaryDefaults],
  );

  const handleToggleSubSessionModifier = (mod: ShortcutModifierKey) => {
    setStatusNotice(null);
    onChangeOverrides((prev) => {
      const current = resolveSubSessionQuickModifiers(prev);
      const exists = current.includes(mod);
      if (exists && current.length <= 1) {
        return prev;
      }
      const next = exists
        ? current.filter((item) => item !== mod)
        : [...current, mod];
      return applySubSessionQuickModifiers(prev, next);
    });
  };

  const handleResetSubSessionModifiers = () => {
    setStatusNotice(null);
    onChangeOverrides((prev) => applySubSessionQuickModifiers(prev, defaultSubSessionModifiers));
  };

  const formatTargetLabel = (target: ShortcutSlotTarget) => {
    const actionLabel = t(ACTION_LABELS[target.action].titleKey as 'settings.shortcuts.actions.server_prev.title');
    const slotLabel = t(
      target.slot === 'primary' ? 'settings.shortcuts.slot_primary' : 'settings.shortcuts.slot_secondary',
    );
    return `${actionLabel} (${slotLabel})`;
  };

  useEffect(() => {
    if (!recordingTarget) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      }

      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setRecordingTarget(null);
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

      const displacedTargets: ShortcutSlotTarget[] = [];
      for (const otherAction of SHORTCUT_ACTION_IDS) {
        for (const otherSlot of SHORTCUT_SLOTS) {
          if (otherAction === recordingTarget.action && otherSlot === recordingTarget.slot) continue;
          if (resolvedSlots[otherAction][otherSlot] === chord) {
            displacedTargets.push({ action: otherAction, slot: otherSlot });
          }
        }
      }

      onChangeOverrides((prev) => {
        const currentResolved = resolveKeyboardShortcutSlots(prev, isMac);
        let next = sanitizeShortcutOverrides(prev);

        for (const otherAction of SHORTCUT_ACTION_IDS) {
          for (const otherSlot of SHORTCUT_SLOTS) {
            if (otherAction === recordingTarget.action && otherSlot === recordingTarget.slot) continue;
            if (currentResolved[otherAction][otherSlot] === chord) {
              next = applyShortcutSlotOverride(next, otherAction, otherSlot, null, isMac);
            }
          }
        }

        return applyShortcutSlotOverride(next, recordingTarget.action, recordingTarget.slot, chord, isMac);
      });

      setRecordingTarget(null);
      if (displacedTargets.length > 0) {
        setStatusNotice({
          type: 'info',
          text: t('settings.shortcuts.reassigned_notice', {
            action: displacedTargets.map((target) => formatTargetLabel(target)).join(', '),
          }),
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
      setRecordingTarget(null);
    };

    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [recordingTarget, isMac, onChangeOverrides, resolvedSlots, t]);

  const handleClear = (action: ShortcutActionId, slot: ShortcutSlot) => {
    setRecordingTarget(null);
    setStatusNotice(null);
    onChangeOverrides((prev) => applyShortcutSlotOverride(prev, action, slot, null, isMac));
  };

  const handleResetSlot = (action: ShortcutActionId, slot: ShortcutSlot) => {
    setRecordingTarget(null);
    setStatusNotice(null);
    const defaultChord = getDefaultShortcutForSlot(action, slot, isMac);
    onChangeOverrides((prev) => applyShortcutSlotOverride(prev, action, slot, defaultChord, isMac));
  };

  const handleResetAll = () => {
    setRecordingTarget(null);
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
          <p class="settings-shortcuts-desc settings-shortcuts-secondary-desc">
            {t('settings.shortcuts.secondary_desc')}
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
          const isRowRecording = recordingTarget?.action === action;
          const actionConflicts = [
            ...(conflicts[action]?.primary ?? []),
            ...(conflicts[action]?.secondary ?? []),
          ];

          return (
            <div
              key={action}
              ref={isRowRecording ? recorderContainerRef : undefined}
              class={`settings-shortcut-row${isRowRecording ? ' is-recording' : ''}${actionConflicts.length > 0 ? ' has-conflict' : ''}`}
              data-testid={`shortcut-row-${action}`}
              data-shortcut-recording={isRowRecording ? 'true' : undefined}
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
                        .map((other) => formatTargetLabel(other))
                        .join(', '),
                    })}
                  </div>
                )}
              </div>

              <div class="settings-shortcut-slots">
                {SHORTCUT_SLOTS.map((slot) => {
                  const slotSuffix = slot === 'primary' ? '' : '-secondary';
                  const slotLabel = t(
                    slot === 'primary' ? 'settings.shortcuts.slot_primary' : 'settings.shortcuts.slot_secondary',
                  );
                  const chord = resolvedSlots[action][slot];
                  const slotDefault = slot === 'primary' ? primaryDefaults[action] : secondaryDefaults[action];
                  const isSlotRecording = recordingTarget?.action === action && recordingTarget?.slot === slot;
                  const isCustom = chord !== slotDefault;
                  const caps = formatShortcutKeycaps(chord, isMac);

                  return (
                    <div
                      key={slot}
                      class="settings-shortcut-slot"
                      data-testid={`shortcut-slot-${action}-${slot}`}
                    >
                      <span class="settings-shortcut-slot-label">
                        {slotLabel}
                      </span>
                      <div class="settings-shortcut-controls">
                        <button
                          type="button"
                          data-testid={`shortcut-record-${action}${slotSuffix}`}
                          data-shortcut-recording={isSlotRecording ? 'true' : undefined}
                          aria-pressed={isSlotRecording}
                          aria-label={t('settings.shortcuts.record_slot_aria', {
                            action: actionTitle,
                            slot: slotLabel,
                          })}
                          class={`settings-shortcut-capture-btn${isSlotRecording ? ' is-recording' : ''}${chord === null ? ' is-empty' : ''}`}
                          onClick={() => {
                            setStatusNotice(null);
                            setRecordingTarget((prev) => (
                              prev?.action === action && prev?.slot === slot
                                ? null
                                : { action, slot }
                            ));
                          }}
                        >
                          {isSlotRecording ? (
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

                        {isSlotRecording ? (
                          <button
                            type="button"
                            class="settings-btn-secondary settings-shortcut-mini-btn"
                            data-testid={`shortcut-cancel-${action}${slotSuffix}`}
                            onClick={() => {
                              setRecordingTarget(null);
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
                              data-testid={`shortcut-clear-${action}${slotSuffix}`}
                              aria-label={t('settings.shortcuts.clear_slot_aria', {
                                action: actionTitle,
                                slot: slotLabel,
                              })}
                              disabled={chord === null}
                              style={{ opacity: chord === null ? '0.45' : '1' }}
                              onClick={() => handleClear(action, slot)}
                            >
                              {t('settings.shortcuts.clear')}
                            </button>
                            <button
                              type="button"
                              class="settings-btn-secondary settings-shortcut-mini-btn"
                              data-testid={`shortcut-reset-${action}${slotSuffix}`}
                              aria-label={t('settings.shortcuts.reset_slot_aria', {
                                action: actionTitle,
                                slot: slotLabel,
                              })}
                              disabled={!isCustom}
                              style={{ opacity: isCustom ? '1' : '0.45' }}
                              onClick={() => handleResetSlot(action, slot)}
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
            </div>
          );
        })}
      </div>

      <div class="settings-shortcuts-subsession" data-testid="subsession-quick-shortcuts-section">
        <div class="settings-shortcut-row settings-shortcut-row-subsession">
          <div class="settings-shortcut-info">
            <div class="settings-shortcut-title">
              {t('settings.shortcuts.subsession_quick.title')}
            </div>
            <div class="settings-shortcut-desc">
              {t('settings.shortcuts.subsession_quick.desc')}
            </div>
            <div class="settings-shortcut-subsession-previews">
              <div class="settings-shortcut-preview-item" data-testid="subsession-quick-preview-open">
                <span class="settings-shortcut-preview-label">
                  {t('settings.shortcuts.subsession_quick.open_label')}
                </span>
                <span class="settings-shortcut-keycaps">
                  {subSessionModifierCaps.map((cap) => (
                    <kbd key={`open-${cap}`} class="settings-kbd">{cap}</kbd>
                  ))}
                  <kbd class="settings-kbd">1–9</kbd>
                </span>
              </div>
              <div class="settings-shortcut-preview-item" data-testid="subsession-quick-preview-close">
                <span class="settings-shortcut-preview-label">
                  {t('settings.shortcuts.subsession_quick.close_all_label')}
                </span>
                <span class="settings-shortcut-keycaps">
                  {subSessionModifierCaps.map((cap) => (
                    <kbd key={`close-${cap}`} class="settings-kbd">{cap}</kbd>
                  ))}
                  <kbd class="settings-kbd">0</kbd>
                </span>
              </div>
            </div>
          </div>

          <div class="settings-shortcut-subsession-controls">
            <div
              class="settings-shortcut-modifier-group"
              role="group"
              aria-label={t('settings.shortcuts.subsession_quick.modifiers_aria')}
            >
              {SHORTCUT_MODIFIER_KEYS.map((mod) => {
                const active = subSessionModifiers.includes(mod);
                const lockedLast = active && subSessionModifiers.length <= 1;
                const keycap = formatSubSessionQuickModifierKeycaps([mod], isMac)[0];
                const name = mod === 'meta'
                  ? (isMac ? 'Cmd' : 'Win')
                  : mod === 'alt'
                    ? (isMac ? 'Option' : 'Alt')
                    : mod === 'shift'
                      ? 'Shift'
                      : 'Ctrl';
                return (
                  <button
                    key={mod}
                    type="button"
                    data-testid={`subsession-mod-${mod}`}
                    aria-pressed={active}
                    disabled={lockedLast}
                    title={lockedLast ? t('settings.shortcuts.subsession_quick.min_one_hint') : undefined}
                    class={`settings-shortcut-mod-btn${active ? ' is-active' : ''}`}
                    onClick={() => handleToggleSubSessionModifier(mod)}
                  >
                    <kbd class="settings-kbd">{keycap}</kbd>
                    <span>{name}</span>
                  </button>
                );
              })}
            </div>
            {isCustomSubSessionModifiers && (
              <button
                type="button"
                data-testid="subsession-mod-reset"
                class="settings-btn-secondary settings-shortcut-mini-btn"
                aria-label={t('settings.shortcuts.subsession_quick.reset_aria')}
                onClick={handleResetSubSessionModifiers}
              >
                {t('settings.shortcuts.reset')}
              </button>
            )}
          </div>
        </div>
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
