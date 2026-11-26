import type { SupervisionMode } from '@shared/supervision-config.js';

export interface SessionSettingsOpenIntent {
  surface?: 'session' | 'supervision';
  supervisionMode?: SupervisionMode;
}
