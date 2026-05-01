export const PREF_KEY_DEFAULT_SHELL = 'default_shell';
export const PREF_KEY_P2P_SESSION_CONFIG_LEGACY = 'p2p_session_config';
export const PREF_KEY_P2P_COMBO_CONFIRM_SKIP = 'p2p_combo_direct_send_skip_confirm';
export const PREF_KEY_P2P_CUSTOM_COMBOS = 'p2p_custom_combos';
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

export function p2pSessionConfigPrefKey(root: string): string {
  return `${PREF_KEY_P2P_SESSION_CONFIG_LEGACY}:${root}`;
}
