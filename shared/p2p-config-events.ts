export const P2P_CONFIG_MSG = {
  SAVE: 'p2p.config.save',
  SAVE_RESPONSE: 'p2p.config.save_response',
} as const;

export const P2P_CONFIG_ERROR = {
  NO_CONFIGURED_TARGETS: 'no_configured_targets',
  INVALID_CONFIG: 'invalid_config',
  PERSIST_FAILED: 'persist_failed',
  SAVE_TIMEOUT: 'save_timeout',
  /** No saved P2P config on disk for this scope — user must configure participants first. */
  NO_SAVED_CONFIG: 'no_saved_config',
  /** Saved config exists but no participants are enabled with a non-skip mode. */
  NO_ENABLED_PARTICIPANTS: 'no_enabled_participants',
  /** Selected participants exceed the hard cap. */
  TOO_MANY_PARTICIPANTS: 'too_many_participants',
} as const;

/** Hard cap on the number of P2P participants — applies at both save time (web) and start time (daemon). */
export const MAX_P2P_PARTICIPANTS = 5 as const;

export type P2pConfigMsgType = (typeof P2P_CONFIG_MSG)[keyof typeof P2P_CONFIG_MSG];
export type P2pConfigErrorType = (typeof P2P_CONFIG_ERROR)[keyof typeof P2P_CONFIG_ERROR];
