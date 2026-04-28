export const PREF_KEY_DEFAULT_SHELL = 'default_shell';
export const PREF_KEY_P2P_SESSION_CONFIG_LEGACY = 'p2p_session_config';
export const PREF_KEY_P2P_COMBO_CONFIRM_SKIP = 'p2p_combo_direct_send_skip_confirm';
export const PREF_KEY_P2P_CUSTOM_COMBOS = 'p2p_custom_combos';

export function p2pSessionConfigPrefKey(root: string): string {
  return `${PREF_KEY_P2P_SESSION_CONFIG_LEGACY}:${root}`;
}
