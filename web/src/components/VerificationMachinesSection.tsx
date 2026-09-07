import { useCallback, useEffect, useState } from 'preact/hooks';
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

export function VerificationMachinesSection({
  machines,
  projectKey,
}: {
  machines: MachineListItem[];
  projectKey?: string;
}) {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<VerificationMachineProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [alias, setAlias] = useState('');
  const [sshHost, setSshHost] = useState('');
  const [scope, setScope] = useState<VerificationMachineScope>(
    projectKey ? VERIFICATION_MACHINE_SCOPES.PROJECT : VERIFICATION_MACHINE_SCOPES.USER,
  );
  const [busyTarget, setBusyTarget] = useState<string | null>(null);
  const [aliasEdits, setAliasEdits] = useState<Record<string, string>>({});
  const [scopeEdits, setScopeEdits] = useState<Record<string, VerificationMachineScope>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      setProfiles(await listVerificationMachines(projectKey));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [projectKey]);

  useEffect(() => { void refresh(); }, [refresh]);

  const saveControlled = async (machine: MachineListItem) => {
    if (!machine.nodeId) return;
    const current = profiles.find((item) => item.kind === VERIFICATION_MACHINE_KINDS.CONTROLLED_NODE
      && item.target === machine.nodeId && item.scope === scope);
    setBusyTarget(machine.nodeId);
    setError(false);
    try {
      await setVerificationMachine({
        ...(current ? { id: current.id, expectedRevision: current.revision } : {}),
        scope,
        scopeKey: scope === VERIFICATION_MACHINE_SCOPES.PROJECT ? projectKey ?? '' : '',
        alias: machine.displayName,
        kind: VERIFICATION_MACHINE_KINDS.CONTROLLED_NODE,
        target: machine.nodeId,
        enabled: true,
      });
      await refresh();
    } catch {
      setError(true);
    } finally {
      setBusyTarget(null);
    }
  };

  const addSsh = async (event: Event) => {
    event.preventDefault();
    if (!alias.trim() || !sshHost.trim()) return;
    setBusyTarget(sshHost.trim());
    setError(false);
    try {
      await setVerificationMachine({
        scope,
        scopeKey: scope === VERIFICATION_MACHINE_SCOPES.PROJECT ? projectKey ?? '' : '',
        alias: alias.trim(),
        kind: VERIFICATION_MACHINE_KINDS.SSH,
        target: sshHost.trim(),
      });
      setAlias('');
      setSshHost('');
      await refresh();
    } catch {
      setError(true);
    } finally {
      setBusyTarget(null);
    }
  };

  const remove = async (profile: VerificationMachineProfile) => {
    setBusyTarget(profile.id);
    setError(false);
    try {
      await removeVerificationMachine(profile.id, profile.revision);
      await refresh();
    } catch {
      setError(true);
    } finally {
      setBusyTarget(null);
    }
  };

  const updateProfile = async (profile: VerificationMachineProfile) => {
    const nextScope = scopeEdits[profile.id] ?? profile.scope;
    const nextAlias = (aliasEdits[profile.id] ?? profile.alias).trim();
    if (!nextAlias || (nextScope === VERIFICATION_MACHINE_SCOPES.PROJECT && !projectKey)) return;
    setBusyTarget(profile.id);
    setError(false);
    try {
      await setVerificationMachine({
        id: profile.id,
        scope: nextScope,
        scopeKey: nextScope === VERIFICATION_MACHINE_SCOPES.PROJECT ? projectKey ?? '' : '',
        alias: nextAlias,
        kind: profile.kind,
        target: profile.target,
        enabled: profile.enabled,
        expectedRevision: profile.revision,
      });
      setAliasEdits((current) => { const next = { ...current }; delete next[profile.id]; return next; });
      setScopeEdits((current) => { const next = { ...current }; delete next[profile.id]; return next; });
      await refresh();
    } catch {
      setError(true);
    } finally {
      setBusyTarget(null);
    }
  };

  return (
    <section class="controlled-nodes-section verification-machines-section">
      <div class="controlled-nodes-machines-header">
        <div class="controlled-nodes-section-heading">
          <span class="controlled-nodes-section-index">02</span>
          <h3>{t('controlled_nodes.verification.title')}</h3>
        </div>
        <label>
          <span>{t('controlled_nodes.verification.scope')}</span>
          <select value={scope} onChange={(event) => setScope((event.target as HTMLSelectElement).value as VerificationMachineScope)}>
            {projectKey && <option value={VERIFICATION_MACHINE_SCOPES.PROJECT}>{t('controlled_nodes.verification.project_scope')}</option>}
            <option value={VERIFICATION_MACHINE_SCOPES.USER}>{t('controlled_nodes.verification.user_scope')}</option>
          </select>
        </label>
      </div>
      <p class="controlled-nodes-muted">{t('controlled_nodes.verification.help')}</p>
      {error && <p class="verification-machines-error" role="alert">{t('controlled_nodes.verification.error')}</p>}
      {loading ? <p class="controlled-nodes-muted">{t('common.loading')}</p> : (
        <ul class="controlled-nodes-machine-list">
          {profiles.map((profile) => (
            <li key={profile.id} class="controlled-nodes-machine-row">
              <div class="controlled-nodes-machine-info">
                <div class="controlled-nodes-machine-heading">
                  <input
                    aria-label={t('controlled_nodes.verification.alias')}
                    value={aliasEdits[profile.id] ?? profile.alias}
                    onInput={(event) => setAliasEdits((current) => ({
                      ...current, [profile.id]: (event.target as HTMLInputElement).value,
                    }))}
                  />
                  <span class="controlled-nodes-status">{t(`controlled_nodes.verification.status_${profile.lastVerificationStatus}`)}</span>
                </div>
                <div class="controlled-nodes-machine-meta">
                  <code>{profile.target}</code>
                  <span>{t(`controlled_nodes.verification.kind_${profile.kind}`)}</span>
                  <select value={scopeEdits[profile.id] ?? profile.scope} onChange={(event) => setScopeEdits((current) => ({
                    ...current, [profile.id]: (event.target as HTMLSelectElement).value as VerificationMachineScope,
                  }))}>
                    {projectKey && <option value={VERIFICATION_MACHINE_SCOPES.PROJECT}>{t('controlled_nodes.verification.project_scope')}</option>}
                    <option value={VERIFICATION_MACHINE_SCOPES.USER}>{t('controlled_nodes.verification.user_scope')}</option>
                  </select>
                  <code>{profile.id}</code>
                </div>
              </div>
              <button type="button" disabled={busyTarget === profile.id} onClick={() => { void updateProfile(profile); }}>
                {t('common.save')}
              </button>
              <button type="button" disabled={busyTarget === profile.id} onClick={() => { void remove(profile); }}>
                {t('common.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div class="verification-machine-node-actions">
        {machines.filter((machine) => machine.nodeId).map((machine) => {
          const current = profiles.find((item) => item.kind === VERIFICATION_MACHINE_KINDS.CONTROLLED_NODE
            && item.target === machine.nodeId && item.scope === scope);
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
      <form class="verification-machine-ssh-form" onSubmit={(event) => { void addSsh(event); }}>
        <input value={alias} onInput={(event) => setAlias((event.target as HTMLInputElement).value)} placeholder={t('controlled_nodes.verification.alias')} />
        <input value={sshHost} onInput={(event) => setSshHost((event.target as HTMLInputElement).value)} placeholder={t('controlled_nodes.verification.ssh_host')} />
        <button type="submit" disabled={!alias.trim() || !sshHost.trim() || busyTarget !== null || (scope === VERIFICATION_MACHINE_SCOPES.PROJECT && !projectKey)}>
          {t('controlled_nodes.verification.add_ssh')}
        </button>
      </form>
    </section>
  );
}
