export const PREF_KEY_DEFAULT_SHELL = 'default_shell';
export {
  P2P_SESSION_CONFIG_PREF_KEY as PREF_KEY_P2P_SESSION_CONFIG_LEGACY,
  p2pLegacySessionConfigPrefKey,
  p2pScopedSessionKey,
  p2pSessionConfigLegacyPrefKeys,
  p2pSessionConfigPrefKey,
} from '@shared/p2p-config-scope.js';
export const PREF_KEY_P2P_COMBO_CONFIRM_SKIP = 'p2p_combo_direct_send_skip_confirm';
export const PREF_KEY_P2P_CUSTOM_COMBOS = 'p2p_custom_combos';
export const PREF_KEY_OPENSPEC_AUTO_DELIVER_AUTO_COMMIT_PUSH = 'openspec_auto_deliver_auto_commit_push';
/**
 * Last-selected tab in the P2P quick-pick dropdown shown above the chat
 * input. Two tabs: `'combos'` (the original combo presets list) and
 * `'workflows'` (the saved advanced workflow library for the active
 * session). Persisted globally — not session-scoped — so the user's
 * preferred tab follows them across sessions.
 */
export const PREF_KEY_P2P_DROPDOWN_TAB = 'p2p_dropdown_tab';
/**
 * Whether the chat timeline shows tool calls / file changes / reasoning.
 *
 * Tri-state semantics for first-run UX:
 *   - `null`     → user has never decided. The chat shows a one-time chooser
 *                  banner (only if the current timeline contains tool events)
 *                  and the wrench pill renders in an "undecided" visual state.
 *                  Developer details are SHOWN by default until the user picks.
 *   - `true`     → user opted into developer view. Tool events visible.
 *   - `false`    → user opted into simple chat view. Tool events hidden.
 *
 * Controlled exclusively by the wrench pill in `UsageFooter`. No separate
 * settings entry — the pill is the entire UI surface for this preference.
 *
 * Backed by `usePref` → `SharedResource`, so multiple subscribers (the
 * pill in `UsageFooter` and the filter/banner in `ChatView`) share one
 * GET, one cache entry, and one cross-tab listener.
 */
export const PREF_KEY_SHOW_TOOL_CALLS = 'show_tool_calls';
