import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  VERIFICATION_MACHINE_KINDS,
  VERIFICATION_MACHINE_SCOPES,
  type VerificationMachineProfile,
  type VerificationMachineScope,
} from '@shared/verification-machine.js';
import type { MachineListItem } from '../api/machines.js';
import {
  listVerificationMachines,
  removeVerificationMachine,
  setVerificationMachine,
} from '../api/verification-machines.js';
import { useAliases } from '../hooks/useAliases.js';
import { isAliasId } from '@shared/alias-types.js';

const KNOWN_ERROR_CODES = [
  'revision_conflict',
  'alias_conflict',
  'verification_machine_target_unauthorized',
  'target_unauthorized',
  'verification_machine_not_found',
  'verification_machine_alias_required',
  'verification_machine_alias_invalid',
  'verification_machine_scope_key_required',
] as const;

function extractErrorCode(err: unknown): string | null {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!message) return null;
  const jsonStart = message.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(message.slice(jsonStart)) as { error?: unknown };
      if (typeof parsed.error === 'string') return parsed.error;
    } catch { /* ignore invalid JSON */ }
  }
  for (const code of KNOWN_ERROR_CODES) {
    if (message.includes(code)) return code;
  }
  return null;
}

function verificationErrorKey(code: string | null): string {
  switch (code) {
    case 'revision_conflict':
      return 'controlled_nodes.verification.error_revision_conflict';
    case 'alias_conflict':
      return 'controlled_nodes.verification.error_alias_conflict';
    case 'verification_machine_target_unauthorized':
    case 'target_unauthorized':
      return 'controlled_nodes.verification.error_target_unauthorized';
    case 'verification_machine_not_found':
      return 'controlled_nodes.verification.error_not_found';
    case 'verification_machine_alias_required':
    case 'verification_machine_alias_invalid':
      return 'controlled_nodes.verification.error_alias_invalid';
    case 'verification_machine_scope_key_required':
      return 'controlled_nodes.verification.error_scope_key_required';
    default:
      return 'controlled_nodes.verification.error';
  }
}

export function VerificationMachinesSection({
  machines,
  projectKey,
}: {
  machines: MachineListItem[];
  projectKey?: string;
}) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const [profiles, setProfiles] = useState<VerificationMachineProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sourceTab, setSourceTab] = useState<'alias' | 'controlled_node'>('alias');
  const [scope, setScope] = useState<VerificationMachineScope>(
    projectKey ? VERIFICATION_MACHINE_SCOPES.PROJECT : VERIFICATION_MACHINE_SCOPES.USER,
  );
  const scopeTouchedRef = useRef(false);
  const [busyTarget, setBusyTarget] = useState<string | null>(null);
  const [aliasEdits, setAliasEdits] = useState<Record<string, string>>({});
  const [scopeEdits, setScopeEdits] = useState<Record<string, VerificationMachineScope>>({});
  const { aliases, refetch: refetchAliases } = useAliases();
  const refetchAliasesRef = useRef(refetchAliases);
  refetchAliasesRef.current = refetchAliases;

  useEffect(() => {
    if (!projectKey) {
      setScope((current) => (current === VERIFICATION_MACHINE_SCOPES.PROJECT ? VERIFICATION_MACHINE_SCOPES.USER : current));
      return;
    }
    if (!scopeTouchedRef.current) {
      setScope(VERIFICATION_MACHINE_SCOPES.PROJECT);
    }
  }, [projectKey]);

  const pruneEdits = useCallback((nextProfiles: VerificationMachineProfile[], clearIds: string[] = []) => {
    const validIds = new Set(nextProfiles.map((item) => item.id));
    const dropIds = new Set(clearIds);
    const filterRecord = <T,>(current: Record<string, T>) => {
      let changed = false;
      const next: Record<string, T> = {};
      for (const [id, value] of Object.entries(current)) {
        if (validIds.has(id) && !dropIds.has(id)) next[id] = value;
        else changed = true;
      }
      return changed ? next : current;
    };
    setAliasEdits(filterRecord);
    setScopeEdits(filterRecord);
  }, []);

  const refresh = useCallback(async (opts?: { silent?: boolean; preserveError?: boolean; clearIds?: string[]; refetchAliasesAlso?: boolean }) => {
    const showLoading = !opts?.silent && !opts?.preserveError;
    if (showLoading) {
      setLoading(true);
      setError(null);
    }
    try {
      const next = await listVerificationMachines(projectKey, { includeAllProjects: true });
      setProfiles(next);
      pruneEdits(next, opts?.clearIds);
      if (opts?.refetchAliasesAlso) refetchAliasesRef.current();
    } catch (err) {
      if (!opts?.preserveError) {
        setError(tRef.current(verificationErrorKey(extractErrorCode(err))));
      }
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [projectKey, pruneEdits]);

  useEffect(() => {
    void refresh();
    refetchAliasesRef.current();
  }, [refresh]);

  const handleMutationError = async (err: unknown, profileId?: string) => {
    const code = extractErrorCode(err);
    setError(tRef.current(verificationErrorKey(code)));
    if (
      code === 'revision_conflict'
      || code === 'alias_conflict'
      || code === 'verification_machine_target_unauthorized'
      || code === 'target_unauthorized'
      || code === 'verification_machine_not_found'
    ) {
      const clearIds = profileId && code !== 'alias_conflict' ? [profileId] : [];
      await refresh({ preserveError: true, clearIds, refetchAliasesAlso: true });
    }
  };

  const activeScopeKey = scope === VERIFICATION_MACHINE_SCOPES.PROJECT ? (projectKey ?? '') : '';

  const saveControlled = async (machine: MachineListItem) => {
    if (!machine.nodeId) return;
    if (scope === VERIFICATION_MACHINE_SCOPES.PROJECT && !activeScopeKey) {
      setError(tRef.current('controlled_nodes.verification.error_scope_key_required'));
      return;
    }
    const current = profiles.find((item) => item.kind === VERIFICATION_MACHINE_KINDS.CONTROLLED_NODE
      && item.target === machine.nodeId
      && item.scope === scope
      && item.scopeKey === activeScopeKey);
    setBusyTarget(machine.nodeId);
    setError(null);
    try {
      await setVerificationMachine({
        ...(current ? { id: current.id, expectedRevision: current.revision } : {}),
        scope,
        scopeKey: activeScopeKey,
        alias: machine.displayName,
        kind: VERIFICATION_MACHINE_KINDS.CONTROLLED_NODE,
        target: machine.nodeId,
        enabled: true,
      });
      await refresh({ silent: true, clearIds: current ? [current.id] : [] });
    } catch (err) {
      await handleMutationError(err, current?.id);
    } finally {
      setBusyTarget(null);
    }
  };

  const saveAlias = async (entry: (typeof aliases)[number]) => {
    if (!isAliasId(entry.id)) return;
    if (scope === VERIFICATION_MACHINE_SCOPES.PROJECT && !activeScopeKey) {
      setError(tRef.current('controlled_nodes.verification.error_scope_key_required'));
      return;
    }
    const aliasId = entry.id;
    const current = profiles.find((item) => item.kind === VERIFICATION_MACHINE_KINDS.SSH
      && item.target === aliasId
      && item.scope === scope
      && item.scopeKey === activeScopeKey);
    setBusyTarget(aliasId);
    setError(null);
    try {
      await setVerificationMachine({
        ...(current ? { id: current.id, expectedRevision: current.revision } : {}),
        scope,
        scopeKey: activeScopeKey,
        alias: entry.name,
        kind: VERIFICATION_MACHINE_KINDS.SSH,
        target: aliasId,
        enabled: true,
      });
      await refresh({ silent: true, clearIds: current ? [current.id] : [] });
    } catch (err) {
      await handleMutationError(err, current?.id);
    } finally {
      setBusyTarget(null);
    }
  };

  const remove = async (profile: VerificationMachineProfile) => {
    setBusyTarget(profile.id);
    setError(null);
    try {
      await removeVerificationMachine(profile.id, profile.revision);
      await refresh({ silent: true, clearIds: [profile.id] });
    } catch (err) {
      await handleMutationError(err, profile.id);
    } finally {
      setBusyTarget(null);
    }
  };

  const updateProfile = async (profile: VerificationMachineProfile) => {
    const nextScope = scopeEdits[profile.id] ?? profile.scope;
    const nextAlias = (aliasEdits[profile.id] ?? profile.alias).trim();
    const targetScopeKey = nextScope === VERIFICATION_MACHINE_SCOPES.PROJECT
      ? (profile.scope === VERIFICATION_MACHINE_SCOPES.PROJECT && profile.scopeKey
        ? profile.scopeKey
        : (projectKey ?? ''))
      : '';
    if (!nextAlias) {
      setError(tRef.current('controlled_nodes.verification.error_alias_invalid'));
      return;
    }
    if (nextScope === VERIFICATION_MACHINE_SCOPES.PROJECT && !targetScopeKey) {
      setError(tRef.current('controlled_nodes.verification.error_scope_key_required'));
      return;
    }
    setBusyTarget(profile.id);
    setError(null);
    try {
      await setVerificationMachine({
        id: profile.id,
        scope: nextScope,
        scopeKey: targetScopeKey,
        alias: nextAlias,
        kind: profile.kind,
        target: profile.target,
        enabled: profile.enabled,
        expectedRevision: profile.revision,
      });
      await refresh({ silent: true, clearIds: [profile.id] });
    } catch (err) {
      await handleMutationError(err, profile.id);
    } finally {
      setBusyTarget(null);
    }
  };

  const handleHeaderScopeChange = (nextScope: VerificationMachineScope) => {
    scopeTouchedRef.current = true;
    setError(null);
    setScope(nextScope);
  };

  const handleRowScopeChange = (profile: VerificationMachineProfile, nextScope: VerificationMachineScope) => {
    setError(null);
    setScopeEdits((current) => {
      if (nextScope === profile.scope) {
        if (!(profile.id in current)) return current;
        const next = { ...current };
        delete next[profile.id];
        return next;
      }
      return { ...current, [profile.id]: nextScope };
    });
  };

  return (
    <section class="controlled-nodes-section verification-machines-section">
      <div class="controlled-nodes-machines-header">
        <div class="controlled-nodes-section-heading">
          <h3>{t('controlled_nodes.verification.title')}</h3>
        </div>
        <label class="verification-machines-scope">
          <span>{t('controlled_nodes.verification.scope')}</span>
          <select
            value={scope}
            onInput={(event) => handleHeaderScopeChange((event.currentTarget as HTMLSelectElement).value as VerificationMachineScope)}
            onChange={(event) => handleHeaderScopeChange((event.currentTarget as HTMLSelectElement).value as VerificationMachineScope)}
          >
            {projectKey && <option value={VERIFICATION_MACHINE_SCOPES.PROJECT}>{t('controlled_nodes.verification.project_scope')}</option>}
            <option value={VERIFICATION_MACHINE_SCOPES.USER}>{t('controlled_nodes.verification.user_scope')}</option>
          </select>
        </label>
      </div>
      {/* What this is FOR, before how it works. Without it the page reads as
          another machine list, and the reason to authorize anything here --
          letting the agent prove a change on a real Windows/macOS/Linux box
          instead of asserting it should work -- is never stated. */}
      <p class="verification-machines-purpose">{t('controlled_nodes.verification.purpose')}</p>
      <p class="controlled-nodes-muted">{t('controlled_nodes.verification.help')}</p>
      {error && <p class="verification-machines-error" role="alert">{error}</p>}
      {loading ? <p class="controlled-nodes-muted">{t('common.loading')}</p> : (
        <ul class="controlled-nodes-machine-list">
          {profiles.map((profile) => {
            const rowScope = scopeEdits[profile.id] ?? profile.scope;
            const rowProjectKey = profile.scope === VERIFICATION_MACHINE_SCOPES.PROJECT && profile.scopeKey
              ? profile.scopeKey
              : projectKey;
            const showProjectOption = profile.scope === VERIFICATION_MACHINE_SCOPES.PROJECT || Boolean(projectKey);
            return (
              <li key={profile.id} class="controlled-nodes-machine-row">
                <div class="controlled-nodes-machine-info">
                  <div class="controlled-nodes-machine-heading">
                    <input
                      class="verification-machine-alias"
                      aria-label={t('controlled_nodes.verification.alias')}
                      value={aliasEdits[profile.id] ?? profile.alias}
                      onInput={(event) => {
                        const value = (event.target as HTMLInputElement).value;
                        setError(null);
                        setAliasEdits((current) => {
                          if (value === profile.alias) {
                            if (!(profile.id in current)) return current;
                            const next = { ...current };
                            delete next[profile.id];
                            return next;
                          }
                          return { ...current, [profile.id]: value };
                        });
                      }}
                    />
                    <span
                      class={`controlled-nodes-status verification-machine-status is-${profile.lastVerificationStatus}`}
                    >{t(`controlled_nodes.verification.status_${profile.lastVerificationStatus}`)}</span>
                  </div>
                  <div class="controlled-nodes-machine-meta verification-machine-meta">
                    <code class="verification-machine-id">{profile.target}</code>
                    <span class="verification-machine-kind">{t(`controlled_nodes.verification.kind_${profile.kind}`)}</span>
                    <select
                      aria-label={`${t('controlled_nodes.verification.scope')} ${profile.alias}`}
                      value={rowScope}
                      onInput={(event) => handleRowScopeChange(profile, (event.currentTarget as HTMLSelectElement).value as VerificationMachineScope)}
                      onChange={(event) => handleRowScopeChange(profile, (event.currentTarget as HTMLSelectElement).value as VerificationMachineScope)}
                    >
                      {showProjectOption && (
                        <option value={VERIFICATION_MACHINE_SCOPES.PROJECT}>
                          {rowProjectKey
                            ? t('controlled_nodes.verification.project_scope_named', { project: rowProjectKey })
                            : t('controlled_nodes.verification.project_scope')}
                        </option>
                      )}
                      <option value={VERIFICATION_MACHINE_SCOPES.USER}>{t('controlled_nodes.verification.user_scope')}</option>
                    </select>
                    {profile.scope === VERIFICATION_MACHINE_SCOPES.PROJECT && profile.scopeKey && (
                      <code class="verification-machine-id verification-machine-scope-key">{profile.scopeKey}</code>
                    )}
                    <code class="verification-machine-id">{profile.id}</code>
                  </div>
                </div>
                {/* Side by side, and styled by what they do. As bare browser
                    buttons they rendered as two full-width grey pills of equal
                    weight, so Delete looked no different from Save. */}
                <div class="verification-machine-actions">
                  <button
                    type="button"
                    class="verification-machine-save"
                    disabled={busyTarget === profile.id}
                    onClick={() => { void updateProfile(profile); }}
                  >
                    {t('common.save')}
                  </button>
                  <button
                    type="button"
                    class="verification-machine-delete"
                    disabled={busyTarget === profile.id}
                    onClick={() => { void remove(profile); }}
                  >
                    {t('common.delete')}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <button
        type="button"
        class="verification-machine-add"
        onClick={() => setPickerOpen((current) => !current)}
        aria-expanded={pickerOpen}
      >
        <span aria-hidden="true">＋</span>
        {t('quick_input.verification_add')}
      </button>
      {pickerOpen && <div class="verification-machine-node-actions">
        <div class="qp-verification-source-tabs" role="tablist" aria-label={t('quick_input.verification_source')}>
          <button
            type="button"
            role="tab"
            aria-selected={sourceTab === 'alias'}
            class={sourceTab === 'alias' ? 'active' : ''}
            onClick={() => setSourceTab('alias')}
          >
            🔖 {t('alias.tab')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sourceTab === 'controlled_node'}
            class={sourceTab === 'controlled_node' ? 'active' : ''}
            onClick={() => setSourceTab('controlled_node')}
          >
            🖥 {t('quick_input.tab_machines')}
          </button>
        </div>
        <div class="qp-verification-source-list">
        {sourceTab === 'alias' && aliases.filter((entry) => isAliasId(entry.id)).map((entry) => {
          const current = profiles.find((item) => item.kind === VERIFICATION_MACHINE_KINDS.SSH
            && item.target === entry.id
            && item.scope === scope
            && item.scopeKey === activeScopeKey);
          return (
            <button
              type="button"
              key={entry.id}
              disabled={busyTarget === entry.id || (scope === VERIFICATION_MACHINE_SCOPES.PROJECT && !projectKey)}
              onClick={() => { void saveAlias(entry); }}
            >
              {current
                ? t('controlled_nodes.verification.update_alias', { name: entry.name })
                : t('controlled_nodes.verification.authorize_alias', { name: entry.name })}
            </button>
          );
        })}
        {sourceTab === 'controlled_node' && machines.filter((machine) => machine.nodeId).map((machine) => {
          const current = profiles.find((item) => item.kind === VERIFICATION_MACHINE_KINDS.CONTROLLED_NODE
            && item.target === machine.nodeId
            && item.scope === scope
            && item.scopeKey === activeScopeKey);
          return (
            <button
              type="button"
              key={machine.nodeId}
              disabled={busyTarget === machine.nodeId || (scope === VERIFICATION_MACHINE_SCOPES.PROJECT && !projectKey)}
              onClick={() => { void saveControlled(machine); }}
            >
              {current
                ? t('controlled_nodes.verification.update_node', { name: machine.displayName })
                : t('controlled_nodes.verification.authorize_node', { name: machine.displayName })}
            </button>
          );
        })}
        </div>
      </div>}
    </section>
  );
}
