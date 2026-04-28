import {
  SUPERVISION_USER_DEFAULT_PREF_KEY,
  normalizeSupervisorDefaultConfig,
  parseSupervisorDefaultConfig,
  type SupervisorDefaultConfig,
} from '@shared/supervision-config.js';
import { usePref, type UsePrefResult } from './usePref.js';

export interface UseSupervisorDefaultsResult extends Omit<UsePrefResult<SupervisorDefaultConfig>, 'save' | 'set'> {
  save: (config: Partial<SupervisorDefaultConfig> | null | undefined) => Promise<SupervisorDefaultConfig>;
  set: (config: Partial<SupervisorDefaultConfig> | null | undefined) => void;
}

export function useSupervisorDefaults(enabled = true): UseSupervisorDefaultsResult {
  const pref = usePref<SupervisorDefaultConfig>(enabled ? SUPERVISION_USER_DEFAULT_PREF_KEY : null, {
    parse: parseSupervisorDefaultConfig,
    serialize: normalizeSupervisorDefaultConfig,
  });

  const set = (config: Partial<SupervisorDefaultConfig> | null | undefined): void => {
    pref.set(normalizeSupervisorDefaultConfig(config));
  };

  const save = async (config: Partial<SupervisorDefaultConfig> | null | undefined): Promise<SupervisorDefaultConfig> => {
    const normalized = normalizeSupervisorDefaultConfig(config);
    await pref.save(normalized);
    return normalized;
  };

  return {
    ...pref,
    set,
    save,
  };
}
