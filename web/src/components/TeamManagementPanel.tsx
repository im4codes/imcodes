import { useCallback, useEffect, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  addTeamMember,
  bindMachineToTeam,
  createTeam,
  getTeam,
  listTeams,
  removeTeamMember,
  updateTeamMemberRole,
  type TeamDetail,
  type TeamSummary,
} from '../api.js';
import type { MachineListItem } from '../api/machines.js';

/**
 * Teams: make one, put people in it, put machines in it.
 *
 * Three roles, and they are not decoration. An ordinary member manages the
 * machines they added themselves; the owner and admins manage every machine in
 * the team; only the owner appoints admins. So the list below shows a member
 * what they are, and shows a manager what they can change.
 */
export function TeamManagementPanel({
  machines,
  onMachinesChanged,
}: {
  machines: MachineListItem[];
  onMachinesChanged: () => void | Promise<void>;
}): preact.JSX.Element {
  const { t } = useTranslation();
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [name, setName] = useState('');
  const [memberInput, setMemberInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const report = (cause: unknown): void => {
    setError(cause instanceof Error && cause.message ? cause.message : String(cause));
  };

  const loadTeams = useCallback(async () => {
    try {
      const rows = await listTeams();
      setTeams(rows);
      setSelectedId((current) => (rows.some((team) => team.id === current) ? current : rows[0]?.id ?? ''));
    } catch (cause) {
      report(cause);
    }
  }, []);

  const loadDetail = useCallback(async (teamId: string) => {
    if (!teamId) {
      setDetail(null);
      return;
    }
    try {
      setDetail(await getTeam(teamId));
    } catch (cause) {
      setDetail(null);
      report(cause);
    }
  }, []);

  useEffect(() => { void loadTeams(); }, [loadTeams]);
  useEffect(() => { void loadDetail(selectedId); }, [selectedId, loadDetail]);

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };

  const onCreate = () => run(async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const created = await createTeam(trimmed);
    setName('');
    await loadTeams();
    setSelectedId(created.id);
  });

  const onAddMember = () => run(async () => {
    const trimmed = memberInput.trim();
    if (!trimmed || !selectedId) return;
    await addTeamMember(selectedId, trimmed);
    setMemberInput('');
    await loadDetail(selectedId);
  });

  const canManage = detail?.myRole === 'owner' || detail?.myRole === 'admin';
  const isOwner = detail?.myRole === 'owner';
  // Only machines this person owns can be filed into a team: putting someone
  // else's machine in a group is not a filing decision, it is taking it.
  const ownedMachines = machines.filter((machine) => machine.accessRole === 'owner');
  const memberLabel = (member: TeamDetail['members'][number]): string =>
    member.username || member.display_name || member.user_id;

  return (
    <div class="controlled-nodes-teams">
      <p class="controlled-nodes-muted">{t('controlled_nodes.team_section_hint')}</p>

      <div class="controlled-nodes-team-create">
        <input
          class="controlled-nodes-input"
          type="text"
          data-testid="controlled-nodes-team-name"
          value={name}
          placeholder={t('controlled_nodes.team_create_placeholder')}
          onInput={(event) => setName(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') onCreate(); }}
        />
        <button
          type="button"
          class="controlled-nodes-action-btn"
          data-testid="controlled-nodes-team-create"
          disabled={busy || !name.trim()}
          onClick={onCreate}
        >{t('controlled_nodes.team_create')}</button>
      </div>

      {error && <p class="controlled-nodes-error" role="alert">{error}</p>}

      {teams.length === 0
        ? <p class="controlled-nodes-muted">{t('controlled_nodes.team_empty')}</p>
        : (
          <>
            <div class="controlled-nodes-team-switch" role="tablist" aria-label={t('controlled_nodes.team_section_title')}>
              {teams.map((team) => (
                <button
                  key={team.id}
                  type="button"
                  role="tab"
                  aria-selected={team.id === selectedId}
                  class={`controlled-nodes-team-chip${team.id === selectedId ? ' is-active' : ''}`}
                  data-testid={`controlled-nodes-team-chip-${team.id}`}
                  onClick={() => setSelectedId(team.id)}
                >{team.name}</button>
              ))}
            </div>

            {detail && (
              <div class="controlled-nodes-team-detail">
                <div class="controlled-nodes-team-block">
                  <h4>{t('controlled_nodes.team_members')}</h4>
                  {canManage && (
                    <div class="controlled-nodes-team-create">
                      <input
                        class="controlled-nodes-input"
                        type="text"
                        data-testid="controlled-nodes-member-name"
                        value={memberInput}
                        placeholder={t('controlled_nodes.team_member_placeholder')}
                        onInput={(event) => setMemberInput(event.currentTarget.value)}
                        onKeyDown={(event) => { if (event.key === 'Enter') onAddMember(); }}
                      />
                      <button
                        type="button"
                        class="controlled-nodes-action-btn"
                        data-testid="controlled-nodes-member-add"
                        disabled={busy || !memberInput.trim()}
                        onClick={onAddMember}
                      >{t('controlled_nodes.team_member_add')}</button>
                    </div>
                  )}
                  <ul class="controlled-nodes-team-list">
                    {detail.members.map((member) => (
                      <li key={member.user_id}>
                        <span class="controlled-nodes-team-name">{memberLabel(member)}</span>
                        {/* Only the owner appoints admins, and the owner's own
                            role is not a dropdown: a team with nobody able to
                            appoint anyone is a team nobody can run. */}
                        {isOwner && member.role !== 'owner' ? (
                          <select
                            class="controlled-nodes-role-select"
                            data-testid={`controlled-nodes-member-role-${member.user_id}`}
                            value={member.role}
                            onInput={(event) => void run(async () => {
                              await updateTeamMemberRole(
                                selectedId,
                                member.user_id,
                                event.currentTarget.value as 'admin' | 'member',
                              );
                              await loadDetail(selectedId);
                            })}
                          >
                            <option value="member">{t('controlled_nodes.team_role_member')}</option>
                            <option value="admin">{t('controlled_nodes.team_role_admin')}</option>
                          </select>
                        ) : (
                          <span class="controlled-nodes-role-tag">{t(`controlled_nodes.team_role_${member.role}`)}</span>
                        )}
                        {canManage && member.role !== 'owner' && (
                          <button
                            type="button"
                            class="controlled-nodes-danger-btn"
                            data-testid={`controlled-nodes-member-remove-${member.user_id}`}
                            onClick={() => void run(async () => {
                              await removeTeamMember(selectedId, member.user_id);
                              await loadDetail(selectedId);
                            })}
                          >{t('controlled_nodes.team_member_remove')}</button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>

                <div class="controlled-nodes-team-block">
                  <h4>{t('controlled_nodes.team_machines')}</h4>
                  <p class="controlled-nodes-muted">{t('controlled_nodes.team_machines_hint')}</p>
                  {ownedMachines.length === 0
                    ? <p class="controlled-nodes-muted">{t('controlled_nodes.team_machines_none')}</p>
                    : (
                      <ul class="controlled-nodes-team-list">
                        {ownedMachines.map((machine) => {
                          const inThisTeam = machine.teamId === selectedId;
                          return (
                            <li key={machine.serverId}>
                              <span class="controlled-nodes-team-name">{machine.displayName}</span>
                              {machine.teamId && !inThisTeam && (
                                <span class="controlled-nodes-role-tag">{machine.teamName}</span>
                              )}
                              <button
                                type="button"
                                class={inThisTeam ? 'controlled-nodes-danger-btn' : 'controlled-nodes-action-btn'}
                                data-testid={`controlled-nodes-team-machine-${machine.serverId}`}
                                onClick={() => void run(async () => {
                                  await bindMachineToTeam(machine.serverId, inThisTeam ? null : selectedId);
                                  await onMachinesChanged();
                                })}
                              >
                                {t(inThisTeam
                                  ? 'controlled_nodes.team_machine_remove'
                                  : 'controlled_nodes.team_machine_add')}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                </div>
              </div>
            )}
          </>
        )}
    </div>
  );
}
