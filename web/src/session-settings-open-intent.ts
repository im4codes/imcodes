import type { SupervisionMode } from '@shared/supervision-config.js';

export const SESSION_SETTINGS_FOCUS = {
  PEER_AUDIT_TARGET: 'peer-audit-target',
} as const;

export type SessionSettingsFocus = typeof SESSION_SETTINGS_FOCUS[keyof typeof SESSION_SETTINGS_FOCUS];

export interface SessionSettingsOpenIntent {
  supervisionMode?: SupervisionMode;
  focus?: SessionSettingsFocus;
}
