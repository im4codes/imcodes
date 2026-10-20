import {
  SUPERVISION_USER_DEFAULT_PREF_KEY,
  normalizeSupervisorDefaultConfig,
  parseSupervisorDefaultConfig,
  type SupervisorDefaultConfig,
} from '@shared/supervision-config.js';
import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  fetchSessionSupervisorDefaults,
  saveSessionSupervisorDefaults,
  type SessionSupervisorExecutionPoolCatalogSession,
} from '../api.js';
import * as supervisorApi from '../api.js';
import { usePref, type UsePrefResult } from './usePref.js';

export interface UseSupervisorDefaultsResult extends Omit<UsePrefResult<SupervisorDefaultConfig>, 'save' | 'set'> {
  executionPoolSessions: readonly SessionSupervisorExecutionPoolCatalogSession[];
  save: (config: Partial<SupervisorDefaultConfig> | null | undefined) => Promise<SupervisorDefaultConfig>;
  set: (config: Partial<SupervisorDefaultConfig> | null | undefined) => void;
}

function fetchExecutionPoolCatalog(
  serverId: string,
  sessionName: string,
): Promise<SessionSupervisorExecutionPoolCatalogSession[]> {
  // Several unrelated component suites intentionally use narrow partial API
  // mocks. Missing catalog support is a fail-closed empty projection, matching
  // a denied/old server rather than making the entire settings surface crash.
  if (!Object.prototype.hasOwnProperty.call(supervisorApi, 'fetchSessionSupervisorExecutionPoolCatalog')) {
    return Promise.resolve([]);
  }
  return supervisorApi.fetchSessionSupervisorExecutionPoolCatalog(serverId, sessionName);
}

export function useSupervisorDefaults(
  enabled = true,
  scope?: { serverId: string; sessionName: string } | null,
): UseSupervisorDefaultsResult {
  const hasScope = !!(scope?.serverId.trim() && scope.sessionName.trim());
  const pref = usePref<SupervisorDefaultConfig>(enabled && !hasScope ? SUPERVISION_USER_DEFAULT_PREF_KEY : null, {
    parse: parseSupervisorDefaultConfig,
    serialize: normalizeSupervisorDefaultConfig,
  });
  const [scopedState, setScopedState] = useState<{
    scopeKey: string;
    value: SupervisorDefaultConfig | null;
    loaded: boolean;
    loading: boolean;
    error: unknown | null;
    executionPoolSessions: SessionSupervisorExecutionPoolCatalogSession[];
  }>({ scopeKey: '', value: null, loaded: false, loading: false, error: null, executionPoolSessions: [] });
  const serverId = scope?.serverId.trim() ?? '';
  const sessionName = scope?.sessionName.trim() ?? '';
  const scopeKey = `${serverId}\0${sessionName}`;

  const reloadScoped = useCallback(async (): Promise<SupervisorDefaultConfig | null> => {
    if (!enabled || !serverId || !sessionName) return null;
    setScopedState({ scopeKey, value: null, loaded: false, loading: true, error: null, executionPoolSessions: [] });
    try {
      const [value, executionPoolSessions] = await Promise.all([
        fetchSessionSupervisorDefaults(serverId, sessionName),
        fetchExecutionPoolCatalog(serverId, sessionName),
      ]);
      setScopedState({ scopeKey, value, loaded: true, loading: false, error: null, executionPoolSessions });
      return value;
    } catch (error) {
      setScopedState({ scopeKey, value: null, loaded: true, loading: false, error, executionPoolSessions: [] });
      throw error;
    }
  }, [enabled, scopeKey, serverId, sessionName]);

  useEffect(() => {
    if (!enabled || !hasScope) {
      setScopedState({ scopeKey: '', value: null, loaded: false, loading: false, error: null, executionPoolSessions: [] });
      return;
    }
    let active = true;
    setScopedState({ scopeKey, value: null, loaded: false, loading: true, error: null, executionPoolSessions: [] });
    void Promise.all([
      fetchSessionSupervisorDefaults(serverId, sessionName),
      fetchExecutionPoolCatalog(serverId, sessionName),
    ]).then(
      ([value, executionPoolSessions]) => {
        if (active) setScopedState({ scopeKey, value, loaded: true, loading: false, error: null, executionPoolSessions });
      },
      (error) => {
        if (active) setScopedState({ scopeKey, value: null, loaded: true, loading: false, error, executionPoolSessions: [] });
      },
    );
    return () => { active = false; };
  }, [enabled, hasScope, scopeKey, serverId, sessionName]);

  if (hasScope) {
    // Scope changes render before effects run. Never expose the previous
    // machine owner's catalogue/defaults for even one paint while the new
    // covered-session request is pending.
    const current = scopedState.scopeKey === scopeKey
      ? scopedState
      : { scopeKey, value: null, loaded: false, loading: true, error: null, executionPoolSessions: [] };
    const set = (config: Partial<SupervisorDefaultConfig> | null | undefined): void => {
      setScopedState({
        scopeKey,
        value: normalizeSupervisorDefaultConfig(config),
        loaded: true,
        loading: false,
        error: null,
        executionPoolSessions: current.executionPoolSessions,
      });
    };
    const save = async (config: Partial<SupervisorDefaultConfig> | null | undefined): Promise<SupervisorDefaultConfig> => {
      const normalized = normalizeSupervisorDefaultConfig(config);
      const value = await saveSessionSupervisorDefaults(serverId, sessionName, normalized);
      setScopedState({ scopeKey, value, loaded: true, loading: false, error: null, executionPoolSessions: current.executionPoolSessions });
      return value;
    };
    return {
      value: current.value,
      rawValue: current.value,
      loaded: current.loaded,
      loading: current.loading,
      stale: false,
      error: current.error,
      executionPoolSessions: current.executionPoolSessions,
      set,
      save,
      reload: reloadScoped,
    };
  }

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
    executionPoolSessions: [],
    set,
    save,
  };
}
