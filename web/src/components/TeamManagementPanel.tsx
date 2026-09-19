import { useCallback, useEffect, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  addTeamMember,
  deleteTeam,
  renameTeam,
  setMachineGroupMembership,
  createTeam,
  getTeam,
  listTeams,
  removeTeamMember,
  updateTeamMemberRole,
  type TeamDetail,
  type TeamSummary,
} from '../api.js';
import type { MachineListItem } from '../api/machines.js';
import { ConfirmButton } from './ConfirmButton.js';
import { machineIsInGroup } from '../machine-grouping.js';

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

  /**
   * Say what went wrong, in words.
   *
   * The server names the cause in `error`; an unmapped one still shows rather
   * than being swallowed, because a silent failure is the thing being fixed
   * here -- a button that does nothing is indistinguishable from a broken app.
   */
  const report = (cause: unknown): void => {
    const code = cause instanceof ApiError ? cause.code : null;
    const known = code && [
      'user_not_found',
      'user_required',
      'self_add_denied',
      'group_manage_denied',
      'desk_membership_required',
      'group_has_machines',
      'group_owner_required',
      'group_name_required',
      'group_name_too_long',
    ].includes(code);
    setError(known
      ? t(`controlled_nodes.team_error_${code}`)
      : cause instanceof Error && cause.message ? cause.message : String(cause));
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
  const groupMachines = machines.filter((machine) => machineIsInGroup(machine, selectedId));
  // Only your own machines can be filed, and only the ones not already here. A
  // machine can be in several groups at once, so being in another one does not
  // exclude it from this list.
  const addableMachines = machines.filter(
    (machine) => machine.accessRole === 'owner' && !machineIsInGroup(machine, selectedId),
  );
  const [machineToAdd, setMachineToAdd] = useState('');
  const [renameTo, setRenameTo] = useState('');

  const onRename = () => run(async () => {
    const trimmed = renameTo.trim();
    if (!trimmed || !selectedId) return;
    await renameTeam(selectedId, trimmed);
    setRenameTo('');
    await loadTeams();
  });

  const onDelete = () => run(async () => {
    if (!selectedId) return;
    await deleteTeam(selectedId);
    setSelectedId('');
    await loadTeams();
  });
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
                >
                  {team.name}
                  {/* The count is what makes one chip different from another
                      before you click it. */}
                  <span class="controlled-nodes-team-chip-count">
                    {machines.filter((machine) => machineIsInGroup(machine, team.id)).length}
                  </span>
                </button>
              ))}
            </div>

            {detail && (
              <>
              <div class="controlled-nodes-team-header">
                {canManage && (
                  <div class="controlled-nodes-team-create">
                    <input
                      class="controlled-nodes-input"
                      type="text"
                      data-testid="controlled-nodes-group-rename"
                      value={renameTo}
                      placeholder={t('controlled_nodes.group_rename_placeholder', { name: detail.name })}
                      onInput={(event) => setRenameTo(event.currentTarget.value)}
                      onKeyDown={(event) => { if (event.key === 'Enter') onRename(); }}
                    />
                    <button
                      type="button"
                      class="controlled-nodes-action-btn"
                      data-testid="controlled-nodes-group-rename-save"
                      disabled={busy || !renameTo.trim()}
                      onClick={onRename}
                    >{t('controlled_nodes.group_rename')}</button>
                  </div>
                )}
                {/* Only the owner deletes, and only an empty group. Disabled
                    with the reason on it rather than clickable and then
                    refused: the machines have to come out first, and that is
                    something to be told before trying, not after. */}
                {isOwner && (
                  groupMachines.length > 0
                    ? (
                      <p class="controlled-nodes-muted" data-testid="controlled-nodes-group-delete-blocked">
                        {t('controlled_nodes.group_delete_blocked', { count: groupMachines.length })}
                      </p>
                    )
                    : (
                      <ConfirmButton
                        className="controlled-nodes-danger-btn"
                        testId="controlled-nodes-group-delete"
                        disabled={busy}
                        label={t('controlled_nodes.group_delete')}
                        confirmLabel={t('controlled_nodes.confirm_again')}
                        onConfirm={onDelete}
                      />
                    )
                )}
              </div>
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
                      {/* Adding someone hands them every machine in the group,
                          so it asks once before it does that. */}
                      <ConfirmButton
                        className="controlled-nodes-action-btn"
                        confirmClassName="controlled-nodes-action-btn"
                        testId="controlled-nodes-member-add"
                        disabled={busy || !memberInput.trim()}
                        label={t('controlled_nodes.team_member_add')}
                        confirmLabel={t('controlled_nodes.confirm_again')}
                        onConfirm={onAddMember}
                      />
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
                          <ConfirmButton
                            className="controlled-nodes-danger-btn"
                            testId={`controlled-nodes-member-remove-${member.user_id}`}
                            disabled={busy}
                            label={t('controlled_nodes.team_member_remove')}
                            confirmLabel={t('controlled_nodes.confirm_again')}
                            onConfirm={() => void run(async () => {
                              await removeTeamMember(selectedId, member.user_id);
                              await loadDetail(selectedId);
                            })}
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                </div>

                <div class="controlled-nodes-team-block">
                  <h4>{t('controlled_nodes.team_machines')}</h4>
                  <p class="controlled-nodes-muted">{t('controlled_nodes.team_machines_hint')}</p>

                  {/* What is IN this group. Listing every machine you own here
                      with an Add button meant the panel looked identical for
                      every group -- it was answering "what could go in" while
                      claiming to answer "what is in". */}
                  {groupMachines.length === 0
                    ? <p class="controlled-nodes-muted">{t('controlled_nodes.team_machines_empty')}</p>
                    : (
                      <ul class="controlled-nodes-team-list">
                        {groupMachines.map((machine) => (
                          <li key={machine.serverId}>
                            <span class="controlled-nodes-team-name">{machine.displayName}</span>
                            {machine.accessRole === 'owner' ? (
                              <ConfirmButton
                                className="controlled-nodes-danger-btn"
                                testId={`controlled-nodes-team-machine-remove-${machine.serverId}`}
                                disabled={busy}
                                label={t('controlled_nodes.team_machine_remove')}
                                confirmLabel={t('controlled_nodes.confirm_again')}
                                onConfirm={() => void run(async () => {
                                  await setMachineGroupMembership(machine.serverId, selectedId, false);
                                  await onMachinesChanged();
                                })}
                              />
                            ) : (
                              <span class="controlled-nodes-role-tag">{t('controlled_nodes.team_machine_not_yours')}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}

                  {/* Adding is a choice from a list, not a list of choices. */}
                  {addableMachines.length > 0 && (
                    <div class="controlled-nodes-team-create">
                      <select
                        class="controlled-nodes-input"
                        data-testid="controlled-nodes-machine-pick"
                        value={machineToAdd}
                        onInput={(event) => setMachineToAdd(event.currentTarget.value)}
                      >
                        <option value="">{t('controlled_nodes.team_machine_pick')}</option>
                        {addableMachines.map((machine) => (
                          <option key={machine.serverId} value={machine.serverId}>
                            {(machine.teamNames ?? []).length > 0
                              ? `${machine.displayName} · ${(machine.teamNames ?? []).join(', ')}`
                              : machine.displayName}
                          </option>
                        ))}
                      </select>
                      {/* Filing a machine hands it to everyone running the
                          group, so it asks once too. */}
                      <ConfirmButton
                        className="controlled-nodes-action-btn"
                        confirmClassName="controlled-nodes-action-btn"
                        testId="controlled-nodes-machine-add"
                        disabled={busy || !machineToAdd}
                        label={t('controlled_nodes.team_machine_add')}
                        confirmLabel={t('controlled_nodes.confirm_again')}
                        onConfirm={() => void run(async () => {
                          await setMachineGroupMembership(machineToAdd, selectedId, true);
                          setMachineToAdd('');
                          await onMachinesChanged();
                        })}
                      />
                    </div>
                  )}
                </div>
              </div>
              </>
            )}
          </>
        )}
    </div>
  );
}
