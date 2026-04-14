export const P2P_CONFIG_MSG = {
  SAVE: 'p2p.config.save',
  SAVE_RESPONSE: 'p2p.config.save_response',
} as const;

export const P2P_CONFIG_ERROR = {
  NO_CONFIGURED_TARGETS: 'no_configured_targets',
  INVALID_CONFIG: 'invalid_config',
  PERSIST_FAILED: 'persist_failed',
  SAVE_TIMEOUT: 'save_timeout',
} as const;

export type P2pConfigMsgType = (typeof P2P_CONFIG_MSG)[keyof typeof P2P_CONFIG_MSG];
export type P2pConfigErrorType = (typeof P2P_CONFIG_ERROR)[keyof typeof P2P_CONFIG_ERROR];
