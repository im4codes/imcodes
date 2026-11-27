import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_MAC_VOICE_INLINE_MODIFIER,
  KEYBOARD_SHORTCUTS_PREF_KEY,
  SHORTCUT_ACTION_IDS,
  SHORTCUT_MODIFIER_KEYS,
  SHORTCUT_SLOTS,
  applyMacVoiceInlineModifier,
  applyShortcutSlotOverride,
  applySubSessionQuickModifiers,
  applyTaskPairSplitModifiers,
  areShortcutModifiersEqual,
  areSubSessionQuickModifiersEqual,
  chordFromKeyboardEvent,
  extractDigitFromKeyboardEvent,
  findShortcutSlotConflicts,
  formatShortcutKeycaps,
  formatShortcutModifierKeycaps,
  formatSubSessionQuickModifierKeycaps,
  getDefaultSecondaryShortcuts,
  getDefaultShortcutForSlot,
  getDefaultShortcuts,
  getDefaultSubSessionQuickModifiers,
  getDefaultTaskPairSplitModifiers,
  isMacPlatform,
  normalizeModifierToken,
  normalizeShortcutChordString,
  resolveKeyboardShortcutSlots,
  resolveMacVoiceInlineModifier,
  resolveSubSessionQuickModifiers,
  resolveTaskPairSplitModifiers,
  sanitizeShortcutOverrides,
  type KeyboardShortcutOverrides,
  type MacVoiceInlineModifier,
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
  subSessionCloseAll: {
    titleKey: 'settings.shortcuts.actions.subsession_close_all.title',
    descKey: 'settings.shortcuts.actions.subsession_close_all.desc',
  },
  toggleTaskMode: {
    titleKey: 'settings.shortcuts.actions.toggle_task_mode.title',
    descKey: 'settings.shortcuts.actions.toggle_task_mode.desc',
  },
  toggleRemoteDesktop: {
    titleKey: 'settings.shortcuts.actions.toggle_remote_desktop.title',
    descKey: 'settings.shortcuts.actions.toggle_remote_desktop.desc',
  },
};

type ModifierGroupId = 'subsession' | 'taskPairSplit';

const collectModifiersFromEvent = (e: KeyboardEvent): ShortcutModifierKey[] => {
  const active = new Set<ShortcutModifierKey>();
  if (e.ctrlKey) active.add('ctrl');
  if (e.altKey) active.add('alt');
  if (e.shiftKey) active.add('shift');
  if (e.metaKey) active.add('meta');
  const keyMod = normalizeModifierToken(e.key);
  if (keyMod) active.add(keyMod);
  return SHORTCUT_MODIFIER_KEYS.filter((m) => active.has(m));
};

const remainingModifiersAfterKeyUp = (e: KeyboardEvent): ShortcutModifierKey[] => {
  const active = new Set<ShortcutModifierKey>();
  if (e.ctrlKey) active.add('ctrl');
  if (e.altKey) active.add('alt');
  if (e.shiftKey) active.add('shift');
  if (e.metaKey) active.add('meta');
  const releasedMod = normalizeModifierToken(e.key);
  if (releasedMod) active.delete(releasedMod);
  return SHORTCUT_MODIFIER_KEYS.filter((m) => active.has(m));
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
  const [recordingModifierGroup, setRecordingModifierGroup] = useState<ModifierGroupId | null>(null);
  const [recordingHeldModifiers, setRecordingHeldModifiers] = useState<ShortcutModifierKey[]>([]);
  const [statusNotice, setStatusNotice] = useState<{ type: 'info' | 'err'; text: string } | null>(null);
  const recorderContainerRef = useRef<HTMLDivElement | null>(null);
  const modifierRecorderContainerRef = useRef<HTMLDivElement | null>(null);
  const peakModifiersRef = useRef<Set<ShortcutModifierKey>>(new Set());

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

  const taskPairSplitModifiers = useMemo(
    () => resolveTaskPairSplitModifiers(cleanOverrides),
    [cleanOverrides],
  );
  const defaultTaskPairSplitModifiers = useMemo(() => getDefaultTaskPairSplitModifiers(), []);
  const isCustomTaskPairSplitModifiers = !areShortcutModifiersEqual(
    taskPairSplitModifiers,
    defaultTaskPairSplitModifiers,
    defaultTaskPairSplitModifiers,
  );
  const taskPairSplitModifierCaps = useMemo(
    () => formatShortcutModifierKeycaps(taskPairSplitModifiers, isMac, defaultTaskPairSplitModifiers),
    [taskPairSplitModifiers, isMac, defaultTaskPairSplitModifiers],
  );

  const hasModifierGroupConflict = areShortcutModifiersEqual(
    subSessionModifiers,
    taskPairSplitModifiers,
    defaultSubSessionModifiers,
  );

  const macVoiceModifier = useMemo(
    () => resolveMacVoiceInlineModifier(cleanOverrides),
    [cleanOverrides],
  );
  const isCustomMacVoiceModifier = macVoiceModifier !== DEFAULT_MAC_VOICE_INLINE_MODIFIER;
  const macVoiceModifierCaps = useMemo(
    () => (macVoiceModifier ? formatSubSessionQuickModifierKeycaps([macVoiceModifier], isMac) : []),
    [macVoiceModifier, isMac],
  );

  const hasAnyOverride = useMemo(
    () => isCustomSubSessionModifiers
      || isCustomTaskPairSplitModifiers
      || isCustomMacVoiceModifier
      || SHORTCUT_ACTION_IDS.some(
        (id) => resolvedSlots[id].primary !== primaryDefaults[id]
          || resolvedSlots[id].secondary !== secondaryDefaults[id],
      ),
    [
      isCustomSubSessionModifiers,
      isCustomTaskPairSplitModifiers,
      isCustomMacVoiceModifier,
      resolvedSlots,
      primaryDefaults,
      secondaryDefaults,
    ],
  );

  const formatModifierName = (mod: ShortcutModifierKey) => (
    mod === 'meta'
      ? (isMac ? 'Cmd' : 'Win')
      : mod === 'alt'
        ? (isMac ? 'Option' : 'Alt')
        : mod === 'shift'
          ? 'Shift'
          : 'Ctrl'
  );

  const cancelModifierRecording = () => {
    peakModifiersRef.current.clear();
    setRecordingHeldModifiers([]);
    setRecordingModifierGroup(null);
  };

  const applyModifierGroupChange = (
    group: ModifierGroupId,
    nextModifiers: readonly ShortcutModifierKey[],
  ) => {
    onChangeOverrides((prev) => (
      group === 'subsession'
        ? applySubSessionQuickModifiers(prev, nextModifiers)
        : applyTaskPairSplitModifiers(prev, nextModifiers)
    ));
  };

  const handleToggleModifierInGroup = (group: ModifierGroupId, mod: ShortcutModifierKey) => {
    setStatusNotice(null);
    cancelModifierRecording();
    setRecordingTarget(null);
    onChangeOverrides((prev) => {
      const current = group === 'subsession'
        ? resolveSubSessionQuickModifiers(prev)
        : resolveTaskPairSplitModifiers(prev);
      const exists = current.includes(mod);
      if (exists && current.length <= 1) {
        return prev;
      }
      const next = exists
        ? current.filter((item) => item !== mod)
        : [...current, mod];
      return group === 'subsession'
        ? applySubSessionQuickModifiers(prev, next)
        : applyTaskPairSplitModifiers(prev, next);
    });
  };

  const handleResetModifierGroup = (group: ModifierGroupId) => {
    setStatusNotice(null);
    cancelModifierRecording();
    setRecordingTarget(null);
    applyModifierGroupChange(
      group,
      group === 'subsession' ? defaultSubSessionModifiers : defaultTaskPairSplitModifiers,
    );
  };

  const handleSelectMacVoiceModifier = (mod: MacVoiceInlineModifier) => {
    setStatusNotice(null);
    onChangeOverrides((prev) => applyMacVoiceInlineModifier(prev, mod));
  };

  const handleResetMacVoiceModifier = () => {
    setStatusNotice(null);
    onChangeOverrides((prev) => applyMacVoiceInlineModifier(prev, DEFAULT_MAC_VOICE_INLINE_MODIFIER));
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
    cancelModifierRecording();
    setStatusNotice(null);
    onChangeOverrides({});
  };

  useEffect(() => {
    if (!recordingModifierGroup) return;

    const commitPeak = (mods: readonly ShortcutModifierKey[]) => {
      const canonical = SHORTCUT_MODIFIER_KEYS.filter((m) => mods.includes(m));
      if (canonical.length === 0) return;
      const targetGroup = recordingModifierGroup;
      cancelModifierRecording();
      setStatusNotice(null);
      applyModifierGroupChange(targetGroup, canonical);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') {
        e.stopImmediatePropagation();
      }

      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        cancelModifierRecording();
        setStatusNotice(null);
        return;
      }

      const activeMods = collectModifiersFromEvent(e);
      for (const m of activeMods) {
        peakModifiersRef.current.add(m);
      }
      const peakList = SHORTCUT_MODIFIER_KEYS.filter((m) => peakModifiersRef.current.has(m));
      setRecordingHeldModifiers(peakList);

      const isModKey = normalizeModifierToken(e.key) !== null;
      if (!isModKey) {
        const digit = extractDigitFromKeyboardEvent(e);
        if (digit !== null && digit >= 1 && digit <= 9 && peakList.length > 0) {
          commitPeak(peakList);
          return;
        }
        if (peakList.length === 0) {
          setStatusNotice({
            type: 'err',
            text: t('settings.shortcuts.modifier_required'),
          });
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (peakModifiersRef.current.size === 0) return;
      const remaining = remainingModifiersAfterKeyUp(e);
      if (remaining.length === 0) {
        e.preventDefault();
        e.stopPropagation();
        const peakList = SHORTCUT_MODIFIER_KEYS.filter((m) => peakModifiersRef.current.has(m));
        commitPeak(peakList);
      }
    };

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (modifierRecorderContainerRef.current && target && modifierRecorderContainerRef.current.contains(target)) {
        return;
      }
      cancelModifierRecording();
    };

    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('keyup', handleKeyUp, true);
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('keyup', handleKeyUp, true);
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [recordingModifierGroup, onChangeOverrides, t]);

  const renderModifierDigitSection = ({
    group,
    sectionTestId,
    previewTestId,
    modTestIdPrefix,
    recordTestId,
    cancelTestId,
    resetTestId,
    conflictTestId,
    titleKey,
    descKey,
    openLabelKey,
    modifiersAriaKey,
    resetAriaKey,
    recordAriaKey,
    conflictText,
    modifiers,
    caps,
    isCustom,
  }: {
    group: ModifierGroupId;
    sectionTestId: string;
    previewTestId: string;
    modTestIdPrefix: string;
    recordTestId: string;
    cancelTestId: string;
    resetTestId: string;
    conflictTestId: string;
    titleKey: string;
    descKey: string;
    openLabelKey: string;
    modifiersAriaKey: string;
    resetAriaKey: string;
    recordAriaKey: string;
    conflictText: string | null;
    modifiers: readonly ShortcutModifierKey[];
    caps: readonly string[];
    isCustom: boolean;
  }) => {
    const isRecording = recordingModifierGroup === group;
    const heldCaps = recordingHeldModifiers.length > 0
      ? formatShortcutModifierKeycaps(recordingHeldModifiers, isMac)
      : [];
    return (
      <div
        class="settings-shortcuts-subsession"
        data-testid={sectionTestId}
        ref={isRecording ? modifierRecorderContainerRef : undefined}
        data-shortcut-recording={isRecording ? 'true' : undefined}
      >
        <div
          class={`settings-shortcut-row settings-shortcut-row-subsession${isRecording ? ' is-recording' : ''}${conflictText ? ' has-conflict' : ''}`}
        >
          <div class="settings-shortcut-info">
            <div class="settings-shortcut-title">
              {t(titleKey)}
            </div>
            <div class="settings-shortcut-desc">
              {t(descKey)}
            </div>
            {conflictText && (
              <div class="settings-shortcut-conflict" data-testid={conflictTestId}>
                {conflictText}
              </div>
            )}
            <div class="settings-shortcut-subsession-previews">
              <div class="settings-shortcut-preview-item" data-testid={previewTestId}>
                <span class="settings-shortcut-preview-label">
                  {t(openLabelKey)}
                </span>
                <span class="settings-shortcut-keycaps">
                  {caps.map((cap) => (
                    <kbd key={`open-${cap}`} class="settings-kbd">{cap}</kbd>
                  ))}
                  <kbd class="settings-kbd">1–9</kbd>
                </span>
              </div>
            </div>
          </div>

          <div class="settings-shortcut-subsession-controls">
            <div
              class="settings-shortcut-modifier-group"
              role="group"
              aria-label={t(modifiersAriaKey)}
            >
              {SHORTCUT_MODIFIER_KEYS.map((mod) => {
                const active = modifiers.includes(mod);
                const lockedLast = active && modifiers.length <= 1;
                const keycap = formatSubSessionQuickModifierKeycaps([mod], isMac)[0];
                const name = formatModifierName(mod);
                return (
                  <button
                    key={mod}
                    type="button"
                    data-testid={`${modTestIdPrefix}-${mod}`}
                    aria-pressed={active}
                    disabled={lockedLast}
                    title={lockedLast ? t('settings.shortcuts.subsession_quick.min_one_hint') : undefined}
                    class={`settings-shortcut-mod-btn${active ? ' is-active' : ''}`}
                    onClick={() => handleToggleModifierInGroup(group, mod)}
                  >
                    <kbd class="settings-kbd">{keycap}</kbd>
                    <span>{name}</span>
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              data-testid={recordTestId}
              data-shortcut-recording={isRecording ? 'true' : undefined}
              aria-pressed={isRecording}
              aria-label={t(recordAriaKey)}
              class={`settings-shortcut-capture-btn${isRecording ? ' is-recording' : ''}`}
              onClick={() => {
                setStatusNotice(null);
                setRecordingTarget(null);
                if (isRecording) {
                  cancelModifierRecording();
                } else {
                  peakModifiersRef.current.clear();
                  setRecordingHeldModifiers([]);
                  setRecordingModifierGroup(group);
                }
              }}
            >
              {isRecording ? (
                heldCaps.length > 0 ? (
                  <span class="settings-shortcut-keycaps">
                    {heldCaps.map((cap, idx) => (
                      <kbd key={`held-${cap}-${idx}`} class="settings-kbd">{cap}</kbd>
                    ))}
                  </span>
                ) : (
                  <span class="settings-shortcut-recording-label">
                    {t('settings.shortcuts.recording_modifiers_prompt')}
                  </span>
                )
              ) : (
                <span>{t('settings.shortcuts.record_modifiers')}</span>
              )}
            </button>
            {isRecording && (
              <button
                type="button"
                class="settings-btn-secondary settings-shortcut-mini-btn"
                data-testid={cancelTestId}
                onClick={() => {
                  cancelModifierRecording();
                  setStatusNotice(null);
                }}
              >
                {t('common.cancel')}
              </button>
            )}
            {isCustom && !isRecording && (
              <button
                type="button"
                data-testid={resetTestId}
                class="settings-btn-secondary settings-shortcut-mini-btn"
                aria-label={t(resetAriaKey)}
                onClick={() => handleResetModifierGroup(group)}
              >
                {t('settings.shortcuts.reset')}
              </button>
            )}
          </div>
        </div>
      </div>
    );
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
                            cancelModifierRecording();
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

      {renderModifierDigitSection({
        group: 'subsession',
        sectionTestId: 'subsession-quick-shortcuts-section',
        previewTestId: 'subsession-quick-preview-open',
        modTestIdPrefix: 'subsession-mod',
        recordTestId: 'subsession-mod-record',
        cancelTestId: 'subsession-mod-cancel',
        resetTestId: 'subsession-mod-reset',
        conflictTestId: 'subsession-quick-conflict',
        titleKey: 'settings.shortcuts.subsession_quick.title',
        descKey: 'settings.shortcuts.subsession_quick.desc',
        openLabelKey: 'settings.shortcuts.subsession_quick.open_label',
        modifiersAriaKey: 'settings.shortcuts.subsession_quick.modifiers_aria',
        resetAriaKey: 'settings.shortcuts.subsession_quick.reset_aria',
        recordAriaKey: 'settings.shortcuts.subsession_quick.record_aria',
        conflictText: hasModifierGroupConflict
          ? t('settings.shortcuts.conflict_warning', { actions: t('settings.shortcuts.task_pair_split.title') })
          : null,
        modifiers: subSessionModifiers,
        caps: subSessionModifierCaps,
        isCustom: isCustomSubSessionModifiers,
      })}

      {renderModifierDigitSection({
        group: 'taskPairSplit',
        sectionTestId: 'taskpair-split-shortcuts-section',
        previewTestId: 'taskpair-split-preview',
        modTestIdPrefix: 'taskpair-split-mod',
        recordTestId: 'taskpair-split-mod-record',
        cancelTestId: 'taskpair-split-mod-cancel',
        resetTestId: 'taskpair-split-mod-reset',
        conflictTestId: 'taskpair-split-conflict',
        titleKey: 'settings.shortcuts.task_pair_split.title',
        descKey: 'settings.shortcuts.task_pair_split.desc',
        openLabelKey: 'settings.shortcuts.task_pair_split.open_label',
        modifiersAriaKey: 'settings.shortcuts.task_pair_split.modifiers_aria',
        resetAriaKey: 'settings.shortcuts.task_pair_split.reset_aria',
        recordAriaKey: 'settings.shortcuts.task_pair_split.record_aria',
        conflictText: hasModifierGroupConflict
          ? t('settings.shortcuts.conflict_warning', { actions: t('settings.shortcuts.subsession_quick.title') })
          : null,
        modifiers: taskPairSplitModifiers,
        caps: taskPairSplitModifierCaps,
        isCustom: isCustomTaskPairSplitModifiers,
      })}

      <div class="settings-shortcuts-subsession" data-testid="mac-voice-inline-shortcut-section">
        <div class="settings-shortcut-row settings-shortcut-row-subsession">
          <div class="settings-shortcut-info">
            <div class="settings-shortcut-title">
              {t('settings.shortcuts.mac_voice.title')}
            </div>
            <div class="settings-shortcut-desc">
              {t('settings.shortcuts.mac_voice.desc')}
            </div>
            <div class="settings-shortcut-subsession-previews">
              <div class="settings-shortcut-preview-item" data-testid="mac-voice-inline-preview">
                <span class="settings-shortcut-preview-label">
                  {t('settings.shortcuts.mac_voice.trigger_label')}
                </span>
                {macVoiceModifier ? (
                  <span class="settings-shortcut-keycaps">
                    {macVoiceModifierCaps.map((cap) => (
                      <kbd key={`voice-1-${cap}`} class="settings-kbd">{cap}</kbd>
                    ))}
                    <span aria-hidden="true">+</span>
                    {macVoiceModifierCaps.map((cap) => (
                      <kbd key={`voice-2-${cap}`} class="settings-kbd">{cap}</kbd>
                    ))}
                  </span>
                ) : (
                  <span class="settings-shortcut-unassigned">{t('settings.shortcuts.mac_voice.disabled')}</span>
                )}
              </div>
            </div>
          </div>

          <div class="settings-shortcut-subsession-controls">
            <div
              class="settings-shortcut-modifier-group"
              role="group"
              aria-label={t('settings.shortcuts.mac_voice.modifiers_aria')}
            >
              {SHORTCUT_MODIFIER_KEYS.map((mod) => {
                const active = macVoiceModifier === mod;
                const keycap = formatSubSessionQuickModifierKeycaps([mod], isMac)[0];
                const name = formatModifierName(mod);
                return (
                  <button
                    key={mod}
                    type="button"
                    data-testid={`mac-voice-mod-${mod}`}
                    aria-pressed={active}
                    class={`settings-shortcut-mod-btn${active ? ' is-active' : ''}`}
                    onClick={() => handleSelectMacVoiceModifier(mod)}
                  >
                    <kbd class="settings-kbd">{keycap}</kbd>
                    <span>{name}</span>
                  </button>
                );
              })}
              <button
                type="button"
                data-testid="mac-voice-mod-off"
                aria-pressed={macVoiceModifier === null}
                class={`settings-shortcut-mod-btn${macVoiceModifier === null ? ' is-active' : ''}`}
                onClick={() => handleSelectMacVoiceModifier(null)}
              >
                <span>{t('settings.shortcuts.mac_voice.disabled')}</span>
              </button>
            </div>
            {isCustomMacVoiceModifier && (
              <button
                type="button"
                data-testid="mac-voice-mod-reset"
                class="settings-btn-secondary settings-shortcut-mini-btn"
                aria-label={t('settings.shortcuts.mac_voice.reset_aria')}
                onClick={handleResetMacVoiceModifier}
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
